import asyncio
import io
import json
import mimetypes
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from typing import Optional

import httpx
import yaml
from fastapi import Body, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse

from google.adk.auth.credential_service.in_memory_credential_service import (
    InMemoryCredentialService,
)
from google.adk.cli.adk_web_server import AdkWebServer
from google.adk.cli.utils.agent_loader import AgentLoader
from google.adk.cli.utils.service_factory import (
    create_artifact_service_from_options,
    create_memory_service_from_options,
)
from google.adk.evaluation.local_eval_set_results_manager import (
    LocalEvalSetResultsManager,
)
from google.adk.evaluation.local_eval_sets_manager import LocalEvalSetsManager

from kady_agent.anndata_preview import (
    AnnDataDepsMissing,
    render_embedding_png,
    summarize_h5ad,
)
from kady_agent.citations import report_to_dict, verify_text_and_files
from kady_agent.gemini_settings import (
    build_default_settings,
    load_browser_use_config,
    load_custom_mcps,
    save_browser_use_config,
    save_custom_mcps,
    write_merged_settings,
)
from kady_agent import mcp_oauth
from kady_agent.cost_ledger import read_costs
from kady_agent.manifest import (
    list_turns,
    read_manifest,
    update_manifest,
)
from kady_agent.project_session_service import ProjectSessionService
from kady_agent.projects import (
    ACTIVE_PROJECT,
    DEFAULT_PROJECT_ID,
    active_paths,
    ensure_project_exists,
    touch_project,
)
from kady_agent.projects_api import projects_router
from kady_agent.replay import replay_session


# ---------------------------------------------------------------------------
# ADK app: construct AdkWebServer ourselves so we can install our
# project-scoped session service. Functionally equivalent to
# `get_fast_api_app(agents_dir=".", web=False, ...)` but with the session
# service swapped in from the start.
# ---------------------------------------------------------------------------

_AGENTS_DIR = "."
_agent_loader = AgentLoader(_AGENTS_DIR)
_eval_sets_manager = LocalEvalSetsManager(agents_dir=_AGENTS_DIR)
_eval_set_results_manager = LocalEvalSetResultsManager(agents_dir=_AGENTS_DIR)

_memory_service = create_memory_service_from_options(
    base_dir=_AGENTS_DIR,
    memory_service_uri=None,
)
_session_service = ProjectSessionService()
_artifact_service = create_artifact_service_from_options(
    base_dir=_AGENTS_DIR,
    artifact_service_uri=None,
    strict_uri=True,
    use_local_storage=True,
)
_credential_service = InMemoryCredentialService()

_adk_web_server = AdkWebServer(
    agent_loader=_agent_loader,
    session_service=_session_service,
    memory_service=_memory_service,
    artifact_service=_artifact_service,
    credential_service=_credential_service,
    eval_sets_manager=_eval_sets_manager,
    eval_set_results_manager=_eval_set_results_manager,
    agents_dir=_AGENTS_DIR,
    extra_plugins=None,
    auto_create_session=True,
)

app = _adk_web_server.get_fast_api_app(
    allow_origins=["http://localhost:3000"],
)


# ---------------------------------------------------------------------------
# Project scope: read `X-Project-Id` on every request and set the
# ACTIVE_PROJECT ContextVar. All downstream path resolution routes through
# active_paths() so the same request handler serves the right project.
# ---------------------------------------------------------------------------


@app.middleware("http")
async def project_scope(request: Request, call_next):
    # Prefer the explicit header (set by apiFetch); fall back to the
    # "kady-project" cookie so plain <img>/<a> URLs (where custom headers
    # can't be set) still land in the right project.
    raw = request.headers.get("x-project-id")
    if not (raw and raw.strip()):
        raw = request.query_params.get("project")
    if not (raw and raw.strip()):
        raw = request.cookies.get("kady-project")
    project_id = raw.strip() if raw and raw.strip() else DEFAULT_PROJECT_ID
    try:
        ensure_project_exists(project_id)
    except ValueError:
        project_id = DEFAULT_PROJECT_ID
        ensure_project_exists(project_id)
    token = ACTIVE_PROJECT.set(project_id)
    try:
        return await call_next(request)
    finally:
        ACTIVE_PROJECT.reset(token)


app.include_router(projects_router)


_ZIP_EXCLUDED_NAMES = {"GEMINI.md", "uv.lock"}


def _safe_path(rel: str) -> Path:
    sandbox_root = active_paths().sandbox
    target = (sandbox_root / rel).resolve()
    if not target.is_relative_to(sandbox_root):
        raise HTTPException(status_code=403, detail="Path traversal denied")
    return target


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/config")
async def config():
    """Expose non-secret feature flags to the frontend."""
    modal_id = os.environ.get("MODAL_TOKEN_ID", "").strip()
    modal_secret = os.environ.get("MODAL_TOKEN_SECRET", "").strip()
    return {
        "modal_configured": bool(modal_id and modal_secret),
    }


def _format_ollama_bytes(n: int) -> str:
    """Compact GB/MB rendering for Ollama blob sizes."""
    if not isinstance(n, (int, float)) or n <= 0:
        return ""
    gb = n / 1_073_741_824
    if gb >= 1:
        return f"{gb:.1f} GB"
    mb = n / 1_048_576
    return f"{mb:.0f} MB"


def _ollama_entry(tag: dict) -> dict:
    """Map an `/api/tags` entry to the Model shape consumed by the UI.

    Ollama's tag payload looks like::

        {"name": "qwen3.6:8b", "size": 5200000000,
         "details": {"family": "qwen", "parameter_size": "8B",
                     "quantization_level": "Q4_K_M"}}

    We mirror the OpenRouter-derived entries in web/src/data/models.json so
    the frontend can merge them into the same dropdown without special
    casing individual fields.
    """
    name = tag.get("name") or tag.get("model") or ""
    details = tag.get("details") or {}
    family = details.get("family") or ""
    param_size = details.get("parameter_size") or ""
    quant = details.get("quantization_level") or ""
    size_str = _format_ollama_bytes(int(tag.get("size") or 0))

    bits = [b for b in (family, param_size, quant, size_str) if b]
    description = (
        "Local model served by Ollama at OLLAMA_BASE_URL. "
        + (" · ".join(bits) if bits else "")
    ).strip()

    return {
        "id": f"ollama/{name}" if name else "ollama/unknown",
        "label": name or "unknown",
        "provider": "Ollama",
        "tier": "budget",
        "context_length": 0,
        "pricing": {"prompt": 0.0, "completion": 0.0},
        "modality": "text->text",
        "description": description,
    }


@app.get("/ollama/models")
async def list_ollama_models():
    """Proxy to ``GET {OLLAMA_BASE_URL}/api/tags`` and map into the UI's
    Model shape.

    Returns ``{available, models}`` so the frontend can distinguish
    "Ollama not installed / not running" (available=false, empty list)
    from "Ollama is running but no models pulled" (available=true, empty
    list). Failures are swallowed so the dropdown just omits the local
    section instead of erroring.
    """
    base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{base}/api/tags")
        resp.raise_for_status()
    except Exception:
        return {"available": False, "models": []}
    try:
        data = resp.json() or {}
    except ValueError:
        return {"available": False, "models": []}
    tags = data.get("models") or []
    entries = [_ollama_entry(t) for t in tags if isinstance(t, dict)]
    return {"available": True, "models": entries}


@app.get("/settings/mcps")
def get_custom_mcps():
    """Return the active project's custom MCP server definitions."""
    return load_custom_mcps()


@app.put("/settings/mcps")
async def put_custom_mcps(request: Request):
    """Save custom MCP servers and rebuild the merged Gemini CLI settings."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    save_custom_mcps(data)
    write_merged_settings(active_paths().gemini_settings_dir)
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True}


def _merged_mcp_servers() -> dict:
    """Default + per-project custom MCP servers, merged like the on-disk file."""
    settings = build_default_settings()
    servers = dict(settings.get("mcpServers") or {})
    servers.update(load_custom_mcps())
    return servers


def _server_url(spec: dict) -> Optional[str]:
    """Return the HTTP/SSE URL for an MCP spec, if any."""
    url = spec.get("httpUrl") or spec.get("url")
    return url if isinstance(url, str) and url else None


def _is_builtin_server(name: str) -> bool:
    return name in (build_default_settings().get("mcpServers") or {})


async def _probe_needs_auth(url: str) -> bool:
    """Return True iff the MCP endpoint replies 401 to an unauthenticated init.

    Fast check used to decide whether to surface a Sign-in button. Any
    network/parse failure returns False so we don't claim "needs auth"
    when the server is just unreachable.
    """
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "kady", "version": "0"},
                    },
                },
            )
    except httpx.HTTPError:
        return False
    return r.status_code in (401, 403)


@app.get("/settings/mcps/status")
async def get_mcp_status():
    """Return auth status for every configured MCP server.

    Used by the Settings dialog to render Sign in / Signed in / Stdio
    badges next to each server. Stdio servers always report
    ``transport=stdio`` and ``signedIn=null`` (auth doesn't apply).
    """
    servers = _merged_mcp_servers()
    out: list[dict] = []
    probes: list[tuple[str, str]] = []
    base: list[dict] = []
    for name, spec in servers.items():
        if not isinstance(spec, dict):
            continue
        url = _server_url(spec)
        signed_in = mcp_oauth.has_token(name)
        entry: dict = {
            "name": name,
            "transport": "http" if url else "stdio",
            "url": url,
            "builtin": _is_builtin_server(name),
            "signedIn": signed_in if url else None,
            "needsAuth": False,
            "tokenInfo": mcp_oauth.token_summary(name) if signed_in else None,
        }
        base.append(entry)
        if url and not signed_in:
            probes.append((name, url))

    if probes:
        results = await asyncio.gather(
            *(_probe_needs_auth(u) for _, u in probes), return_exceptions=True
        )
        needs = {
            name: (res is True) for (name, _), res in zip(probes, results)
        }
        for entry in base:
            if entry["name"] in needs:
                entry["needsAuth"] = needs[entry["name"]]
    out = base
    return {"servers": out}


def _resolve_mcp_server(name: str) -> dict:
    """Return the merged spec for ``name`` or raise 404."""
    spec = _merged_mcp_servers().get(name)
    if not isinstance(spec, dict):
        raise HTTPException(status_code=404, detail=f"MCP server {name!r} not found")
    return spec


@app.post("/settings/mcps/{name}/sign-in")
async def post_mcp_sign_in(name: str, request: Request):
    """Begin an OAuth flow for an HTTP/streamable MCP server.

    Returns ``{"authUrl": "..."}``. The frontend opens that URL in a new
    tab; on completion, the auth server redirects back to
    ``/oauth/mcp/callback`` where we finish the dance and persist the
    tokens.
    """
    spec = _resolve_mcp_server(name)
    url = _server_url(spec)
    if not url:
        raise HTTPException(
            status_code=400,
            detail="OAuth sign-in only applies to HTTP/streamable MCP servers",
        )
    redirect_uri = str(request.base_url).rstrip("/") + "/oauth/mcp/callback"
    try:
        auth_url = await mcp_oauth.start_flow(name, url, redirect_uri)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"OAuth discovery failed: {exc}"
        )
    return {"authUrl": auth_url, "redirectUri": redirect_uri}


@app.post("/settings/mcps/{name}/sign-out")
async def post_mcp_sign_out(name: str):
    """Drop the stored OAuth token for ``name``.

    Doesn't error when no token is present so the UI can call this
    optimistically as a "reset" action.
    """
    removed = mcp_oauth.delete_token(name)
    return {"ok": True, "removed": removed}


@app.get("/oauth/mcp/callback")
async def oauth_mcp_callback(
    state: str = Query(...),
    code: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    """OAuth redirect target. Exchange the code for tokens and close the tab.

    The browser tab is the user's "feedback channel" for the sign-in
    flow, so render a small HTML page that explains what happened and
    self-closes after a moment.
    """
    if error or not code:
        return HTMLResponse(
            _oauth_callback_html(
                ok=False,
                title="Sign-in failed",
                detail=error_description or error or "no authorization code returned",
            ),
            status_code=400,
        )
    try:
        server_name = await mcp_oauth.complete_flow(state, code)
    except RuntimeError as exc:
        return HTMLResponse(
            _oauth_callback_html(ok=False, title="Sign-in failed", detail=str(exc)),
            status_code=400,
        )
    except httpx.HTTPError as exc:
        return HTMLResponse(
            _oauth_callback_html(
                ok=False, title="Sign-in failed", detail=f"Token exchange error: {exc}"
            ),
            status_code=502,
        )
    return HTMLResponse(
        _oauth_callback_html(
            ok=True,
            title=f"Signed in to {server_name}",
            detail="You can close this tab and return to Kady.",
        )
    )


def _oauth_callback_html(*, ok: bool, title: str, detail: str) -> str:
    color = "#16a34a" if ok else "#dc2626"
    safe_title = title.replace("<", "&lt;").replace(">", "&gt;")
    safe_detail = detail.replace("<", "&lt;").replace(">", "&gt;")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>{safe_title}</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
     display:flex;align-items:center;justify-content:center;height:100vh;
     background:#0b0b0c;color:#f5f5f5;margin:0}}
.box{{max-width:480px;text-align:center;padding:32px;border:1px solid #2a2a2a;
      border-radius:12px;background:#141416}}
h1{{font-size:1.1rem;color:{color};margin:0 0 8px}}
p{{color:#aaa;font-size:0.9rem;line-height:1.4;margin:0 0 16px}}
button{{padding:8px 16px;border-radius:8px;border:1px solid #333;
        background:#1f1f22;color:#f5f5f5;cursor:pointer;font-size:0.85rem}}
</style></head>
<body><div class="box">
<h1>{safe_title}</h1>
<p>{safe_detail}</p>
<button onclick="window.close()">Close tab</button>
</div>
<script>setTimeout(()=>{{try{{window.close()}}catch(_){{}}}},2500)</script>
</body></html>"""


@app.get("/settings/browser-use")
def get_browser_use_settings():
    """Return the active project's browser-use config."""
    return {"config": load_browser_use_config()}


@app.get("/system/chrome-profiles")
def get_chrome_profiles():
    """Return Chrome profiles detected on this machine.

    The UI uses these to let the user pick which real Chrome profile the
    browser-use agent should attach to (so it inherits logins/cookies).
    """
    from kady_agent.chrome_profiles import detect_chrome_profiles

    return {"profiles": [p.to_dict() for p in detect_chrome_profiles()]}


@app.put("/settings/browser-use")
async def put_browser_use_settings(request: Request):
    """Save the browser-use config and rebuild merged Gemini CLI settings."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    cfg = load_browser_use_config()
    if "enabled" in data:
        cfg["enabled"] = bool(data["enabled"])
    if "headed" in data:
        cfg["headed"] = bool(data["headed"])
    if "profile" in data:
        p = data["profile"]
        cfg["profile"] = (str(p).strip() or None) if p is not None else None
    if "session" in data:
        s = data["session"]
        cfg["session"] = (str(s).strip() or None) if s is not None else None

    save_browser_use_config(cfg)
    write_merged_settings(active_paths().gemini_settings_dir)
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True, "config": load_browser_use_config()}


@app.get("/turns/{session_id}/{turn_id}/manifest")
async def get_turn_manifest(session_id: str, turn_id: str):
    """Return the per-turn run manifest written by kady_agent/manifest.py.

    Frontends use this to render the provenance panel and to construct
    "Copy as Methods" paragraphs with real package versions, seeds, and
    database access dates.
    """
    manifest = read_manifest(session_id, turn_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Manifest not found")
    return manifest


@app.get("/sessions/{session_id}/turns")
async def list_session_turns(session_id: str):
    """List turnIds for a session, in lexicographic (creation) order."""
    turns = list_turns(session_id)
    return {"sessionId": session_id, "turns": turns}


@app.get("/sessions/{session_id}/costs")
async def get_session_costs(session_id: str):
    """Return the OpenRouter cost ledger for a session.

    Aggregates entries written by the orchestrator (ADK + LiteLLM) and the
    expert (Gemini CLI -> LiteLLM proxy) callbacks. Returns zeroed totals
    when no ledger exists yet (fresh session, all-Ollama session, etc.).
    """
    return read_costs(session_id, project_id=ACTIVE_PROJECT.get())


@app.post("/replay")
async def replay_turns_endpoint(request: Request):
    """Re-run every saved delegation for a session (pipeline replay).

    Body: ``{ "sessionId": "...", "turnIds": ["..."] }``. Streams newline-
    delimited JSON so the frontend can show progress in real time. LLM
    outputs may differ from the original run because upstream providers
    are nondeterministic; attachments, prompts, seed, and requested model
    slug are pinned exactly.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    session_id = body.get("sessionId")
    turn_ids = body.get("turnIds")
    if not isinstance(session_id, str) or not session_id:
        raise HTTPException(status_code=400, detail="Missing sessionId")
    if turn_ids is not None and (
        not isinstance(turn_ids, list)
        or not all(isinstance(t, str) for t in turn_ids)
    ):
        raise HTTPException(status_code=400, detail="turnIds must be a list of strings")

    # Capture the active project so the replay runs in the same project
    # context even though the generator executes outside the request scope.
    project_id = ACTIVE_PROJECT.get()

    async def stream():
        token = ACTIVE_PROJECT.set(project_id)
        try:
            async for event in replay_session(
                session_id=session_id, turn_ids=turn_ids
            ):
                yield json.dumps(event) + "\n"
        finally:
            ACTIVE_PROJECT.reset(token)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.patch("/turns/{session_id}/{turn_id}/citations")
async def set_turn_citations(session_id: str, turn_id: str, request: Request):
    """Persist a citation report into the turn manifest.

    Called by the frontend after it receives the resolver output so the
    manifest remains the single source of truth for a turn's provenance.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    def mutator(manifest: dict) -> None:
        manifest["citations"] = {
            "total": body.get("total", 0),
            "verified": body.get("verified", 0),
            "unresolved": body.get("unresolved", 0),
        }

    updated = update_manifest(session_id, turn_id, mutator)
    if updated is None:
        raise HTTPException(status_code=404, detail="Manifest not found")
    return {"ok": True}


@app.post("/verify-citations")
async def verify_citations(request: Request):
    """Deterministic post-pass citation verifier.

    Body: ``{ "text": "...", "files": ["report.md", ...] }``. Returns a
    summary plus per-entry resolver status so the UI can draw a badge and
    popover. See kady_agent/citations.py for the resolver protocol.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    text = body.get("text", "")
    files = body.get("files", []) or []
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="'text' must be a string")
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        raise HTTPException(status_code=400, detail="'files' must be a list of strings")
    report = await verify_text_and_files(text, files)
    return report_to_dict(report)


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


@app.get("/skills")
def list_skills():
    """Return metadata for all installed Gemini skills in the active project."""
    skills_dir = active_paths().gemini_settings_dir / "skills"
    if not skills_dir.is_dir():
        return []

    skills = []
    for child in sorted(skills_dir.iterdir(), key=lambda p: p.name.lower()):
        skill_file = child / "SKILL.md"
        if not child.is_dir() or not skill_file.is_file():
            continue
        try:
            text = skill_file.read_text(encoding="utf-8", errors="replace")
            match = _FRONTMATTER_RE.match(text)
            if not match:
                continue
            meta = yaml.safe_load(match.group(1)) or {}
            skills.append({
                "id": child.name,
                "name": meta.get("name", child.name),
                "description": meta.get("description", ""),
                "author": (meta.get("metadata") or {}).get("skill-author", ""),
                "license": meta.get("license", ""),
                "compatibility": meta.get("compatibility", ""),
            })
        except Exception:
            continue

    return skills


@app.get("/sandbox/tree")
def sandbox_tree():
    """Return the active project's sandbox as a nested tree structure."""
    sandbox_root = active_paths().sandbox
    if not sandbox_root.exists():
        return {"name": "sandbox", "type": "directory", "children": []}

    def build_tree(directory: Path, depth: int = 0) -> dict:
        node: dict = {"name": directory.name, "type": "directory", "children": []}
        if depth > 8:
            return node
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return node

        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.name in _ZIP_EXCLUDED_NAMES:
                continue
            # Hide annotation sidecars; they are managed metadata, not
            # user-visible files. See /sandbox/annotations.
            if entry.is_file() and entry.name.endswith(".annotations.json"):
                continue
            rel = str(entry.relative_to(sandbox_root))
            if entry.is_dir():
                child = build_tree(entry, depth + 1)
                child["path"] = rel
                node["children"].append(child)
            elif entry.is_file():
                node["children"].append({
                    "name": entry.name,
                    "type": "file",
                    "path": rel,
                    "size": entry.stat().st_size,
                })
        return node

    tree = build_tree(sandbox_root)
    tree["path"] = ""
    return tree


@app.post("/sandbox/upload")
async def sandbox_upload(
    files: list[UploadFile],
    paths: list[str] = Form(default=[]),
):
    """Upload files into the active project's ``sandbox/user_data``."""
    paths_obj = active_paths()
    upload_dir = paths_obj.upload_dir
    sandbox_root = paths_obj.sandbox
    upload_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, f in enumerate(files):
        if not f.filename:
            continue
        rel = paths[i].strip() if i < len(paths) else ""
        if rel:
            parts = Path(rel).parts
            safe_parts = [p for p in parts if p not in ("..", ".") and not p.startswith(".")]
            if not safe_parts:
                continue
            dest = upload_dir / Path(*safe_parts)
        else:
            safe_name = Path(f.filename).name
            if not safe_name or safe_name.startswith("."):
                continue
            dest = upload_dir / safe_name
        dest.parent.mkdir(parents=True, exist_ok=True)
        content = await f.read()
        dest.write_bytes(content)
        saved.append(str(dest.relative_to(sandbox_root)))
    touch_project(ACTIVE_PROJECT.get())
    return {"uploaded": saved}


@app.get("/sandbox/file", response_class=PlainTextResponse)
def sandbox_file(path: str = Query(...)):
    """Read a file from the sandbox directory."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if target.stat().st_size > 512_000:
        raise HTTPException(status_code=413, detail="File too large to preview")
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/sandbox/file")
async def sandbox_save_file(request: Request, path: str = Query(...)):
    """Overwrite a sandbox file with new content (text or binary)."""
    target = _safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    body = await request.body()
    target.write_bytes(body)
    touch_project(ACTIVE_PROJECT.get())
    return {"saved": path, "size": len(body)}


@app.delete("/sandbox/file")
def sandbox_delete(path: str = Query(...)):
    """Delete a file from the sandbox directory."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    target.unlink()
    # Cascade: remove an annotation sidecar if this was an annotatable file.
    sidecar = target.with_name(target.name + ".annotations.json")
    if sidecar.is_file():
        try:
            sidecar.unlink()
        except OSError:
            pass
    touch_project(ACTIVE_PROJECT.get())
    return {"deleted": path}


@app.delete("/sandbox/directory")
def sandbox_delete_directory(path: str = Query(...)):
    """Recursively delete a directory from the sandbox."""
    sandbox_root = active_paths().sandbox
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")
    if target == sandbox_root:
        raise HTTPException(status_code=403, detail="Cannot delete sandbox root")
    shutil.rmtree(target)
    touch_project(ACTIVE_PROJECT.get())
    return {"deleted": path}


@app.post("/sandbox/move")
def sandbox_move(src: str = Body(...), dest: str = Body(...)):
    """Move or rename a file/directory within the sandbox."""
    src_path = _safe_path(src)
    dest_path = _safe_path(dest)
    if not src_path.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    if dest_path.exists():
        raise HTTPException(status_code=409, detail="Destination already exists")
    if not dest_path.parent.exists():
        raise HTTPException(status_code=404, detail="Destination parent directory not found")
    if src_path.is_dir() and dest_path.is_relative_to(src_path):
        raise HTTPException(status_code=400, detail="Cannot move a directory into itself")
    shutil.move(str(src_path), str(dest_path))
    # Cascade: move the annotation sidecar alongside a file move/rename.
    if src_path.is_file() or dest_path.is_file():
        src_sidecar = src_path.with_name(src_path.name + ".annotations.json")
        if src_sidecar.exists():
            dest_sidecar = dest_path.with_name(dest_path.name + ".annotations.json")
            try:
                dest_sidecar.parent.mkdir(parents=True, exist_ok=True)
                if not dest_sidecar.exists():
                    shutil.move(str(src_sidecar), str(dest_sidecar))
            except OSError:
                pass
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True}


@app.post("/sandbox/mkdir")
def sandbox_mkdir(path: str = Body(..., embed=True)):
    """Create a new directory inside the sandbox."""
    target = _safe_path(path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Path already exists")
    if not target.parent.exists():
        raise HTTPException(status_code=404, detail="Parent directory not found")
    target.mkdir()
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True}


@app.get("/sandbox/download-dir")
def sandbox_download_dir(path: str = Query(...)):
    """Download a directory as a zip archive."""
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(target.rglob("*")):
            rel_parts = file_path.relative_to(target).parts
            if file_path.is_file() and not any(
                p.startswith(".") for p in rel_parts
            ) and file_path.name not in _ZIP_EXCLUDED_NAMES:
                zf.write(file_path, file_path.relative_to(target))
    buf.seek(0)

    if buf.getbuffer().nbytes <= 22:
        raise HTTPException(status_code=404, detail="Directory is empty")

    archive_name = f"{target.name}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{archive_name}"'},
    )


# ---------------------------------------------------------------------------
# Annotation sidecars: <pdf-rel>.annotations.json next to the file.
# Hidden from /sandbox/tree; cascaded on delete/move; edited through these
# dedicated endpoints so the frontend and the expert-side MCP both go
# through validation and atomic writes.
# ---------------------------------------------------------------------------


_EMPTY_ANNOTATIONS = {"version": 1, "annotations": []}


def _sidecar_for(pdf_rel: str) -> Path:
    target = _safe_path(pdf_rel)
    if target.name.endswith(".annotations.json"):
        raise HTTPException(status_code=400, detail="Refusing to annotate a sidecar")
    sidecar = target.with_name(target.name + ".annotations.json")
    sandbox_root = active_paths().sandbox
    if not sidecar.resolve().is_relative_to(sandbox_root):
        raise HTTPException(status_code=403, detail="Path traversal denied")
    return sidecar


def _normalize_annotations_doc(data) -> dict:
    """Enforce the minimal on-disk schema: {version, annotations: [...]}.
    Unknown fields on individual annotations pass through (forward-compat).
    """
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Annotations body must be a JSON object")
    anns = data.get("annotations")
    if anns is None:
        anns = []
    if not isinstance(anns, list):
        raise HTTPException(status_code=400, detail="'annotations' must be a list")
    for i, ann in enumerate(anns):
        if not isinstance(ann, dict):
            raise HTTPException(status_code=400, detail=f"annotations[{i}] must be an object")
        if not ann.get("id") or not isinstance(ann["id"], str):
            raise HTTPException(status_code=400, detail=f"annotations[{i}].id is required")
        if ann.get("type") not in ("highlight", "note"):
            raise HTTPException(status_code=400, detail=f"annotations[{i}].type must be 'highlight' or 'note'")
        if not isinstance(ann.get("page"), int) or ann["page"] < 1:
            raise HTTPException(status_code=400, detail=f"annotations[{i}].page must be a positive int")
        author = ann.get("author")
        if not isinstance(author, dict) or author.get("kind") not in ("user", "expert"):
            raise HTTPException(status_code=400, detail=f"annotations[{i}].author.kind invalid")
    return {"version": 1, "annotations": anns}


def _http_date(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return format_datetime(dt, usegmt=True)


@app.get("/sandbox/annotations")
def sandbox_get_annotations(response: Response, path: str = Query(...)):
    """Read the annotation sidecar for a given sandbox file.

    Returns an empty doc (``{"version":1,"annotations":[]}``) when the
    sidecar does not exist yet. Sets ``Last-Modified`` so the client can
    pass ``If-Unmodified-Since`` on subsequent writes and cheaply poll.
    """
    sidecar = _sidecar_for(path)
    if not sidecar.is_file():
        response.headers["Cache-Control"] = "no-store"
        return _EMPTY_ANNOTATIONS

    try:
        raw = sidecar.read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else _EMPTY_ANNOTATIONS
    except (OSError, json.JSONDecodeError):
        return _EMPTY_ANNOTATIONS

    mtime = datetime.fromtimestamp(sidecar.stat().st_mtime, tz=timezone.utc)
    response.headers["Last-Modified"] = _http_date(mtime)
    response.headers["Cache-Control"] = "no-store"
    return data


@app.put("/sandbox/annotations")
async def sandbox_put_annotations(
    request: Request,
    response: Response,
    path: str = Query(...),
):
    """Overwrite the annotation sidecar with a new JSON document.

    If the client sends ``If-Unmodified-Since`` and the sidecar has been
    written since that timestamp (e.g. by the expert-side MCP), respond
    with 412 so the client can re-read, merge, and retry.
    """
    sidecar = _sidecar_for(path)

    if sidecar.exists():
        precond = request.headers.get("if-unmodified-since")
        if precond:
            try:
                expected = parsedate_to_datetime(precond)
                if expected.tzinfo is None:
                    expected = expected.replace(tzinfo=timezone.utc)
                actual = datetime.fromtimestamp(
                    sidecar.stat().st_mtime, tz=timezone.utc
                )
                # HTTP-date has 1s precision; allow that much slack.
                if (actual - expected).total_seconds() > 1:
                    raise HTTPException(status_code=412, detail="Sidecar modified; re-read and retry")
            except HTTPException:
                raise
            except (TypeError, ValueError):
                pass

    body_bytes = await request.body()
    try:
        incoming = json.loads(body_bytes.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")
    doc = _normalize_annotations_doc(incoming)

    sidecar.parent.mkdir(parents=True, exist_ok=True)
    tmp = sidecar.with_suffix(sidecar.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, sidecar)
    touch_project(ACTIVE_PROJECT.get())

    mtime = datetime.fromtimestamp(sidecar.stat().st_mtime, tz=timezone.utc)
    response.headers["Last-Modified"] = _http_date(mtime)
    return {"saved": path, "count": len(doc["annotations"])}


@app.get("/sandbox/raw")
def sandbox_raw(path: str = Query(...)):
    """Serve a file inline with the correct MIME type (for images, PDFs, etc.)."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    mime, _ = mimetypes.guess_type(target.name)
    if not mime:
        mime = "application/octet-stream"
    content = target.read_bytes()
    return StreamingResponse(
        io.BytesIO(content),
        media_type=mime,
        headers={"Content-Disposition": f'inline; filename="{target.name}"'},
    )


@app.get("/sandbox/download")
def sandbox_download(path: str = Query(...)):
    """Download a single file from the sandbox."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    content = target.read_bytes()
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{target.name}"'},
    )


@app.get("/sandbox/download-all")
def sandbox_download_all():
    """Download the entire sandbox as a zip archive."""
    sandbox_root = active_paths().sandbox
    if not sandbox_root.exists():
        raise HTTPException(status_code=404, detail="Sandbox is empty")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(sandbox_root.rglob("*")):
            rel_parts = file_path.relative_to(sandbox_root).parts
            if file_path.is_file() and not any(
                p.startswith(".") for p in rel_parts
            ) and file_path.name not in _ZIP_EXCLUDED_NAMES:
                zf.write(file_path, file_path.relative_to(sandbox_root))
    buf.seek(0)

    if buf.getbuffer().nbytes <= 22:
        raise HTTPException(status_code=404, detail="No files to download")

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sandbox.zip"'},
    )


_H5AD_SUFFIXES = (".h5ad",)


def _require_h5ad(target: Path) -> None:
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.name.lower().endswith(_H5AD_SUFFIXES):
        raise HTTPException(status_code=400, detail="Not a .h5ad file")


@app.get("/sandbox/anndata-summary")
def sandbox_anndata_summary(path: str = Query(...)):
    """Return a JSON summary of an .h5ad file.

    Opens the file in ``backed="r"`` mode so shape/dtype/obs/var/obsm can
    be introspected without loading the full matrix into memory.
    """
    target = _safe_path(path)
    _require_h5ad(target)
    try:
        return summarize_h5ad(target)
    except AnnDataDepsMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to read h5ad: {exc}")


@app.get("/sandbox/anndata-embedding.png")
def sandbox_anndata_embedding(
    path: str = Query(...),
    key: str = Query(...),
    color: Optional[str] = Query(default=None),
):
    """Render the first 2 dims of ``adata.obsm[key]`` as a cached PNG."""
    target = _safe_path(path)
    _require_h5ad(target)
    cache_dir = active_paths().sandbox.parent / ".anndata_cache"
    try:
        data = render_embedding_png(target, key=key, color=color, cache_dir=cache_dir)
    except AnnDataDepsMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to render embedding: {exc}")
    return StreamingResponse(
        io.BytesIO(data),
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


_LATEX_ERROR_RE = re.compile(r"^! (.+)", re.MULTILINE)
_VALID_ENGINES = {"pdflatex", "xelatex", "lualatex"}


@app.post("/sandbox/compile-latex")
async def sandbox_compile_latex(request: Request):
    """Compile a .tex file to PDF using latexmk or a raw engine."""
    body = await request.json()
    rel_path = body.get("path", "")
    engine = body.get("engine", "pdflatex")

    if engine not in _VALID_ENGINES:
        raise HTTPException(status_code=400, detail=f"Unsupported engine: {engine}")

    target = _safe_path(rel_path)
    if not target.is_file() or target.suffix not in (".tex", ".latex"):
        raise HTTPException(status_code=400, detail="Not a .tex file")

    work_dir = target.parent
    pdf_name = target.stem + ".pdf"
    pdf_path = work_dir / pdf_name

    has_latexmk = shutil.which("latexmk") is not None

    if has_latexmk:
        cmd = [
            "latexmk",
            f"-{engine}",
            "-interaction=nonstopmode",
            "-cd",
            "-file-line-error",
            str(target),
        ]
    else:
        cmd = [engine, "-interaction=nonstopmode", "-file-line-error", target.name]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        return {
            "success": False,
            "pdf_path": None,
            "log": "Compilation timed out after 60 seconds.",
            "errors": ["Timeout"],
        }
    except FileNotFoundError:
        return {
            "success": False,
            "pdf_path": None,
            "log": f"LaTeX compiler not found. Install TeX Live or set PATH to include {engine}.",
            "errors": [f"{engine} not found on system"],
        }

    log_text = stdout.decode("utf-8", errors="replace")
    errors = _LATEX_ERROR_RE.findall(log_text)
    success = proc.returncode == 0 and pdf_path.is_file()

    sandbox_root = active_paths().sandbox
    return {
        "success": success,
        "pdf_path": str(pdf_path.relative_to(sandbox_root)) if pdf_path.is_file() else None,
        "log": log_text[-8000:] if len(log_text) > 8000 else log_text,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Lightweight markdown revision — bypasses the full ADK agent/delegation stack.
# Called from the in-tab "Ask Kady to revise" popover on markdown files.
# ---------------------------------------------------------------------------


_MD_FENCE_RE = re.compile(
    r"\A\s*```(?:markdown|md)?\s*\n(.*?)\n```\s*\Z",
    re.DOTALL | re.IGNORECASE,
)


def _strip_md_fence(text: str) -> str:
    """Remove an outer ```markdown fence if the model wrapped its reply."""
    m = _MD_FENCE_RE.match(text)
    return m.group(1) if m else text


_REVISE_SYSTEM_PROMPT = (
    "You are a precise markdown editor. You will be given a SELECTION from a "
    "markdown document together with optional BEFORE/AFTER context and a user "
    "INSTRUCTION.\n\n"
    "Your job: rewrite ONLY the SELECTION to satisfy the instruction. Preserve "
    "the surrounding markdown syntax conventions (headings, list markers, "
    "emphasis, code fences, tables) that are visible in the selection. Keep the "
    "revised text stylistically consistent with the BEFORE/AFTER context but do "
    "NOT repeat or rewrite that context.\n\n"
    "Return ONLY the revised markdown for the selection. No preamble, no "
    "explanation, no surrounding ```markdown fences, no quotes. Output must be "
    "drop-in replaceable text."
)


@app.post("/revise-markdown")
async def revise_markdown(request: Request):
    """Revise a markdown selection using the configured default model.

    Body: ``{"selection": str, "instruction": str, "before"?: str, "after"?: str,
    "model"?: str}``. Returns ``{"revised": str}``.
    """
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    selection = str(data.get("selection") or "")
    instruction = str(data.get("instruction") or "").strip()
    before = str(data.get("before") or "")[-800:]
    after = str(data.get("after") or "")[:800]
    model_override = data.get("model")

    if not selection.strip():
        raise HTTPException(status_code=400, detail="selection is required")
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction is required")

    # Import lazily so that `server.py` can still import even if optional
    # agent deps are missing at boot time.
    import litellm
    from kady_agent.agent import DEFAULT_MODEL, EXTRA_HEADERS

    model = (
        str(model_override).strip()
        if isinstance(model_override, str) and model_override.strip()
        else DEFAULT_MODEL
    )
    if not model:
        raise HTTPException(
            status_code=500,
            detail="No model configured (set DEFAULT_AGENT_MODEL or pass 'model').",
        )

    user_message_parts = [f"INSTRUCTION:\n{instruction}"]
    if before:
        user_message_parts.append(
            "BEFORE (context only — do NOT rewrite):\n" + before
        )
    if after:
        user_message_parts.append(
            "AFTER (context only — do NOT rewrite):\n" + after
        )
    user_message_parts.append("SELECTION (rewrite this):\n" + selection)
    user_message = "\n\n".join(user_message_parts)

    try:
        response = await litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _REVISE_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            extra_headers=EXTRA_HEADERS,
            temperature=0.2,
            timeout=120,
        )
    except Exception as exc:  # noqa: BLE001 — surface upstream errors verbatim
        raise HTTPException(status_code=502, detail=f"Model call failed: {exc}")

    try:
        revised = response.choices[0].message.content or ""
    except (AttributeError, IndexError, KeyError) as exc:
        raise HTTPException(
            status_code=502, detail=f"Unexpected model response shape: {exc}"
        )

    revised = _strip_md_fence(revised.strip())
    if not revised:
        raise HTTPException(status_code=502, detail="Model returned empty revision")

    return {"revised": revised, "model": model}
