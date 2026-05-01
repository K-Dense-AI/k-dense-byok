"""Shared helpers for building and persisting Gemini CLI settings.

The default MCP servers (docling, parallel-search) are defined here.
User-added MCP servers live in each project's ``custom_mcps.json``
(outside ``sandbox/`` so they survive sandbox deletion). The active
project is resolved via the request-scoped ``ACTIVE_PROJECT`` ContextVar
through :func:`kady_agent.projects.active_paths`.
"""

from __future__ import annotations

import json
from pathlib import Path

from .projects import active_paths


def custom_mcps_path() -> Path:
    """Return the custom-MCP JSON path for the active project."""
    return active_paths().custom_mcps_path


def browser_use_config_path() -> Path:
    """Return the browser-use config JSON path for the active project."""
    return active_paths().browser_use_config_path


DEFAULT_BROWSER_USE_CONFIG: dict = {
    "enabled": True,
    "headed": False,
    "profile": None,
    "session": None,
}


def load_browser_use_config() -> dict:
    """Read the browser-use config for the active project.

    Returns a dict with defaults filled in; missing/unparseable files
    fall back to ``DEFAULT_BROWSER_USE_CONFIG``.
    """
    path = browser_use_config_path()
    data: dict | None = None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            data = parsed
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        data = None

    cfg = dict(DEFAULT_BROWSER_USE_CONFIG)
    if data:
        cfg.update({k: data[k] for k in DEFAULT_BROWSER_USE_CONFIG if k in data})
    return cfg


def save_browser_use_config(data: dict) -> None:
    """Persist the browser-use config for the active project."""
    cfg = dict(DEFAULT_BROWSER_USE_CONFIG)
    cfg.update({k: data[k] for k in DEFAULT_BROWSER_USE_CONFIG if k in data})
    path = browser_use_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")


def build_browser_use_mcp_spec() -> dict | None:
    """Return a Gemini-CLI-style MCP server spec for browser-use.

    Returns ``None`` when the feature is disabled in the project's
    ``browser_use.json`` so callers can skip registration.
    """
    cfg = load_browser_use_config()
    if not cfg.get("enabled", True):
        return None

    args: list[str] = ["browser-use"]
    if cfg.get("headed"):
        args.append("--headed")
    profile = cfg.get("profile")
    if profile:
        args += ["--profile", str(profile)]
    session = cfg.get("session")
    if session:
        args += ["--session", str(session)]
    args.append("--mcp")
    return {"command": "uvx", "args": args}


def build_default_settings() -> dict:
    """Return the base Gemini CLI settings dict with built-in MCP servers."""
    settings: dict = {
        "security": {"auth": {"selectedType": "gemini-api-key"}},
        "mcpServers": {
            "docling": {
                "command": "uvx",
                "args": ["--from=docling-mcp", "docling-mcp-server"],
            },
            # Lets the expert drop highlights / sticky notes into the
            # <pdf>.annotations.json sidecar so the user-facing PDF
            # viewer renders them with the expert's label + color.
            # Invoked in-process via `python -m` so it always matches
            # the bundled server code without needing console_scripts
            # to be installed for the expert's environment.
            "pdf-annotations": {
                "command": "uv",
                "args": [
                    "run",
                    "--directory",
                    _repo_root_str(),
                    "python",
                    "-m",
                    "kady_agent.mcp_servers.pdf_annotations",
                ],
            },
            # Hosted streamable-HTTP MCP. No local install required; the
            # CLI opens an HTTP connection per session and tears it down
            # at exit, so adding it here is essentially free for projects
            # that don't actually use it.
            #
            # Schema note: Gemini CLI accepts both ``httpUrl`` (original
            # form, always works) and ``{url, type: "http"}`` (newer
            # unified form). 0.40.1 silently drops the newer form on
            # untyped servers, so we stick with ``httpUrl``. See
            # https://github.com/google-gemini/gemini-cli/pull/13762.
            "paperclip": {
                "httpUrl": "https://paperclip.gxl.ai/mcp",
            },
        },
    }

    bu = build_browser_use_mcp_spec()
    if bu is not None:
        settings["mcpServers"]["browser-use"] = bu

    return settings


def _repo_root_str() -> str:
    """Absolute path to the repo root (parent of ``kady_agent``)."""
    from pathlib import Path

    return str(Path(__file__).resolve().parent.parent)


def load_custom_mcps() -> dict:
    """Read user-defined MCP servers for the active project.

    Returns an empty dict when the file is missing or unparseable.
    """
    path = custom_mcps_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {}


def save_custom_mcps(data: dict) -> None:
    """Persist user-defined MCP servers for the active project."""
    path = custom_mcps_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _inject_oauth_bearers(servers: dict) -> dict:
    """Stamp ``Authorization: Bearer <token>`` on HTTP MCPs that we've signed in to.

    Reads tokens straight off disk via :mod:`kady_agent.mcp_oauth` -- no
    refresh here so this stays sync. ``delegate_task`` calls
    :func:`refresh_oauth_tokens` first so spawn-time writes pick up
    freshly rotated tokens.

    User-supplied ``headers.Authorization`` (set in ``custom_mcps.json``)
    always wins so power users can override our injection with a
    different scheme (e.g. a static API key).
    """
    # Local import: avoid a hard dependency at module import time so test
    # fixtures that monkeypatch projects.PROJECTS_ROOT don't accidentally
    # touch the real tokens file via ``mcp_oauth`` import side effects.
    from . import mcp_oauth

    tokens = mcp_oauth.load_tokens()
    if not tokens:
        return servers
    for name, spec in servers.items():
        if not isinstance(spec, dict):
            continue
        url = spec.get("httpUrl") or spec.get("url")
        if not url:
            continue
        entry = tokens.get(name)
        if not entry or not entry.get("access_token"):
            continue
        headers = dict(spec.get("headers") or {})
        # Case-insensitive check: Authorization vs authorization etc.
        if any(k.lower() == "authorization" for k in headers):
            continue
        token_type = entry.get("token_type") or "Bearer"
        headers["Authorization"] = f"{token_type} {entry['access_token']}"
        spec["headers"] = headers
    return servers


def build_merged_settings() -> dict:
    """Return defaults + custom + injected OAuth bearers, fully resolved."""
    settings = build_default_settings()
    custom = load_custom_mcps()
    settings["mcpServers"].update(custom)
    settings["mcpServers"] = _inject_oauth_bearers(settings["mcpServers"])
    return settings


def write_merged_settings(target_dir: str | Path) -> None:
    """Build merged settings and write to ``<target_dir>/settings.json``.

    *target_dir* is typically ``<project>/sandbox/.gemini``. The merged
    config includes any OAuth bearer tokens currently on disk (see
    :func:`_inject_oauth_bearers`) so the Gemini CLI subprocess
    authenticates against signed-in HTTP MCPs out of the box.
    """
    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    settings = build_merged_settings()
    out = target_dir / "settings.json"
    out.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


async def refresh_oauth_tokens() -> None:
    """Refresh every stored MCP OAuth token that's near expiry.

    Called by ``delegate_task`` right before it rewrites the workspace
    ``settings.json``, so the bearer the Gemini CLI sees is always
    current. Errors are swallowed -- a stale-but-still-active token
    still beats failing to spawn the expert.
    """
    from . import mcp_oauth

    names = list(mcp_oauth.load_tokens().keys())
    for name in names:
        try:
            await mcp_oauth.get_access_token(name)
        except Exception:  # noqa: BLE001
            # Best-effort: log via the module logger but don't raise.
            import logging

            logging.getLogger(__name__).warning(
                "Pre-spawn OAuth refresh failed for %s; using cached token", name
            )
