from __future__ import annotations

import asyncio
import json
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse

from kady_agent import mcp_oauth
from kady_agent.gemini_settings import (
    build_default_settings,
    load_browser_use_config,
    load_custom_mcps,
    save_browser_use_config,
    save_custom_mcps,
    write_merged_settings,
)
from kady_agent.projects import ACTIVE_PROJECT, active_paths, touch_project

router = APIRouter()


@router.get("/settings/mcps")
def get_custom_mcps():
    """Return the active project's custom MCP server definitions."""
    return load_custom_mcps()


@router.put("/settings/mcps")
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
    """Return True iff the MCP endpoint replies 401 to an unauthenticated init."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(
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
    return response.status_code in (401, 403)


@router.get("/settings/mcps/status")
async def get_mcp_status():
    """Return auth status for every configured MCP server."""
    servers = _merged_mcp_servers()
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
            *(_probe_needs_auth(url) for _, url in probes), return_exceptions=True
        )
        needs = {name: (res is True) for (name, _), res in zip(probes, results)}
        for entry in base:
            if entry["name"] in needs:
                entry["needsAuth"] = needs[entry["name"]]
    return {"servers": base}


def _resolve_mcp_server(name: str) -> dict:
    """Return the merged spec for ``name`` or raise 404."""
    spec = _merged_mcp_servers().get(name)
    if not isinstance(spec, dict):
        raise HTTPException(status_code=404, detail=f"MCP server {name!r} not found")
    return spec


@router.post("/settings/mcps/{name}/sign-in")
async def post_mcp_sign_in(name: str, request: Request):
    """Begin an OAuth flow for an HTTP/streamable MCP server."""
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


@router.post("/settings/mcps/{name}/sign-out")
async def post_mcp_sign_out(name: str):
    """Drop the stored OAuth token for ``name``."""
    removed = mcp_oauth.delete_token(name)
    return {"ok": True, "removed": removed}


@router.get("/oauth/mcp/callback")
async def oauth_mcp_callback(
    state: str = Query(...),
    code: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    """OAuth redirect target. Exchange the code for tokens and close the tab."""
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


@router.get("/settings/browser-use")
def get_browser_use_settings():
    """Return the active project's browser-use config."""
    return {"config": load_browser_use_config()}


@router.get("/system/chrome-profiles")
def get_chrome_profiles():
    """Return Chrome profiles detected on this machine."""
    from kady_agent.chrome_profiles import detect_chrome_profiles

    return {"profiles": [p.to_dict() for p in detect_chrome_profiles()]}


@router.put("/settings/browser-use")
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
        profile = data["profile"]
        cfg["profile"] = (str(profile).strip() or None) if profile is not None else None
    if "session" in data:
        session = data["session"]
        cfg["session"] = (str(session).strip() or None) if session is not None else None

    save_browser_use_config(cfg)
    write_merged_settings(active_paths().gemini_settings_dir)
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True, "config": load_browser_use_config()}
