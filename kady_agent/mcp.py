"""MCP, Gemini CLI settings, OAuth, and browser-use configuration."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import platform
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional
from urllib.parse import urlencode, urlparse

import httpx
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import (
    StdioConnectionParams,
    StdioServerParameters,
    StreamableHTTPConnectionParams,
)

from . import projects as _projects
from .projects import active_paths

logger = logging.getLogger(__name__)

TOKENS_FILENAME = ".mcp-oauth-tokens.json"

# How long an in-flight OAuth flow stays valid (state nonce + PKCE verifier).
# Long enough for a human to read the consent screen and click "approve",
# short enough to bound memory and prevent replays.
_FLOW_TTL_SECONDS = 600

# Refresh tokens that are within this many seconds of expiry.
_REFRESH_LEEWAY_SECONDS = 60

# In-memory storage for in-flight OAuth flows, keyed by ``state``.
# Cleared on process restart -- a partially completed flow is harmless,
# the user just clicks Sign in again.
_in_flight: dict[str, dict[str, Any]] = {}

# Serializes refresh attempts per server so two concurrent ``delegate_task``
# spawns don't race on the same refresh_token (most servers rotate it
# server-side and a stale one returns 400).
_refresh_locks: dict[str, asyncio.Lock] = {}


def tokens_path() -> Path:
    """Return the absolute path to Kady's MCP OAuth tokens file.

    Resolved at call time (not import time) so test fixtures that
    monkeypatch ``kady_agent.projects.PROJECTS_ROOT`` are honored.
    """
    return _projects.PROJECTS_ROOT / TOKENS_FILENAME


def env_var_name(server_name: str) -> str:
    """Return the env var Kady stamps the bearer into for this server.

    Used by the frontend's status panel and by the spawn-time settings
    materializer. ``[^A-Z0-9]`` chars (hyphen, dot, …) collapse to ``_``.
    """
    return "KADY_MCP_TOKEN_" + re.sub(r"[^A-Z0-9_]+", "_", server_name.upper())


# ---------------------------------------------------------------------------
# Token persistence
# ---------------------------------------------------------------------------


def load_tokens() -> dict[str, dict[str, Any]]:
    """Return all stored tokens, keyed by server name."""
    path = tokens_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _save_tokens(all_tokens: dict[str, dict[str, Any]]) -> None:
    path = tokens_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(all_tokens, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def save_token(server_name: str, entry: dict[str, Any]) -> None:
    """Persist (or overwrite) the stored token for ``server_name``."""
    all_tokens = load_tokens()
    all_tokens[server_name] = entry
    _save_tokens(all_tokens)


def delete_token(server_name: str) -> bool:
    """Remove the stored token for ``server_name``.

    Returns ``True`` if a token was actually removed.
    """
    all_tokens = load_tokens()
    if server_name not in all_tokens:
        return False
    all_tokens.pop(server_name, None)
    _save_tokens(all_tokens)
    return True


def has_token(server_name: str) -> bool:
    return server_name in load_tokens()


def token_summary(server_name: str) -> Optional[dict[str, Any]]:
    """Return safe metadata about a stored token (no access/refresh values)."""
    entry = load_tokens().get(server_name)
    if not entry:
        return None
    obtained_at = int(entry.get("obtained_at") or 0)
    expires_in = entry.get("expires_in")
    expires_at: Optional[int] = None
    if isinstance(expires_in, (int, float)) and expires_in > 0 and obtained_at > 0:
        expires_at = obtained_at + int(expires_in)
    return {
        "issuer": entry.get("issuer"),
        "obtainedAt": obtained_at or None,
        "expiresAt": expires_at,
        "tokenType": entry.get("token_type") or "Bearer",
        "hasRefreshToken": bool(entry.get("refresh_token")),
    }


# ---------------------------------------------------------------------------
# PKCE + helpers
# ---------------------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) per RFC 7636 S256."""
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _prune_in_flight() -> None:
    now = time.time()
    expired = [
        state for state, flow in _in_flight.items() if flow["expires_at"] < now
    ]
    for state in expired:
        _in_flight.pop(state, None)


# ---------------------------------------------------------------------------
# Discovery + dynamic client registration
# ---------------------------------------------------------------------------


async def _discover_metadata(server_url: str) -> dict[str, Any]:
    """Find the OAuth authorization-server metadata for an MCP endpoint.

    Tries ``/.well-known/oauth-protected-resource`` first (RFC 9728) so we
    follow the server's declared authorization server even if it lives on
    a different origin. Falls back to the resource origin itself.
    """
    parsed = urlparse(server_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError(f"Invalid MCP server URL: {server_url!r}")
    base = f"{parsed.scheme}://{parsed.netloc}"

    auth_server_base = base
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.get(f"{base}/.well-known/oauth-protected-resource")
            if r.status_code == 200:
                resource = r.json()
                servers = resource.get("authorization_servers") or []
                if servers and isinstance(servers[0], str):
                    auth_server_base = servers[0].rstrip("/")
        except (httpx.HTTPError, ValueError):
            # Resource metadata is optional; assume same origin.
            pass

        meta_url = f"{auth_server_base}/.well-known/oauth-authorization-server"
        r = await client.get(meta_url)
        r.raise_for_status()
        meta = r.json()
        if "authorization_endpoint" not in meta or "token_endpoint" not in meta:
            raise RuntimeError(
                f"Auth server metadata at {meta_url} is missing required fields"
            )
        return meta


async def _register_client(
    metadata: dict[str, Any],
    redirect_uri: str,
    client_name: str = "Kady BYOK",
) -> dict[str, Any]:
    """Run RFC 7591 dynamic client registration."""
    reg = metadata.get("registration_endpoint")
    if not isinstance(reg, str) or not reg:
        raise RuntimeError(
            "Server does not advertise a registration_endpoint -- dynamic "
            "registration is required for our flow."
        )
    auth_methods = metadata.get("token_endpoint_auth_methods_supported") or [
        "client_secret_basic"
    ]
    auth_method = "none" if "none" in auth_methods else auth_methods[0]
    payload: dict[str, Any] = {
        "client_name": client_name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": auth_method,
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(reg, json=payload)
        r.raise_for_status()
        info = r.json()
    if "client_id" not in info:
        raise RuntimeError("Registration response missing client_id")
    return info


# ---------------------------------------------------------------------------
# Public flow API
# ---------------------------------------------------------------------------


async def start_flow(
    server_name: str,
    server_url: str,
    redirect_uri: str,
) -> str:
    """Begin an OAuth flow and return the authorize URL the user must visit.

    Caches the per-flow PKCE + client info under a random ``state`` nonce
    so the callback handler can reconstruct it without trusting any
    user-controlled query params.
    """
    _prune_in_flight()
    metadata = await _discover_metadata(server_url)
    client_info = await _register_client(metadata, redirect_uri)

    state = secrets.token_urlsafe(24)
    verifier, challenge = _generate_pkce()
    scopes = metadata.get("scopes_supported") or []

    _in_flight[state] = {
        "server_name": server_name,
        "server_url": server_url,
        "code_verifier": verifier,
        "client_id": client_info["client_id"],
        "client_secret": client_info.get("client_secret"),
        "token_endpoint": metadata["token_endpoint"],
        "redirect_uri": redirect_uri,
        "issuer": metadata.get("issuer"),
        "expires_at": time.time() + _FLOW_TTL_SECONDS,
    }

    params = {
        "response_type": "code",
        "client_id": client_info["client_id"],
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    if scopes:
        params["scope"] = " ".join(scopes)
    return f"{metadata['authorization_endpoint']}?{urlencode(params)}"


async def complete_flow(state: str, code: str) -> str:
    """Exchange an auth code for tokens and persist them.

    Returns the ``server_name`` the flow was for so the callback handler
    can include it in the user-facing "signed in successfully" page.
    """
    flow = _in_flight.pop(state, None)
    if flow is None or flow["expires_at"] < time.time():
        raise RuntimeError("Unknown or expired auth flow state")

    payload: dict[str, Any] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": flow["redirect_uri"],
        "client_id": flow["client_id"],
        "code_verifier": flow["code_verifier"],
    }
    if flow.get("client_secret"):
        payload["client_secret"] = flow["client_secret"]

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(flow["token_endpoint"], data=payload)
        r.raise_for_status()
        tokens = r.json()

    if "access_token" not in tokens:
        raise RuntimeError("Token response missing access_token")

    entry = {
        **tokens,
        "obtained_at": int(time.time()),
        "issuer": flow["issuer"],
        "token_endpoint": flow["token_endpoint"],
        "client_id": flow["client_id"],
        "client_secret": flow.get("client_secret"),
        "redirect_uri": flow["redirect_uri"],
        "server_url": flow["server_url"],
    }
    save_token(flow["server_name"], entry)
    return flow["server_name"]


async def get_access_token(server_name: str) -> Optional[str]:
    """Return a valid access token, refreshing transparently if near expiry.

    Returns ``None`` when no token is stored (caller should treat as
    "user hasn't signed in yet").
    """
    entry = load_tokens().get(server_name)
    if not entry:
        return None

    obtained_at = entry.get("obtained_at") or 0
    expires_in = entry.get("expires_in")
    if (
        isinstance(expires_in, (int, float))
        and expires_in > 0
        and obtained_at + expires_in - _REFRESH_LEEWAY_SECONDS > time.time()
    ):
        return entry["access_token"]

    refresh_token = entry.get("refresh_token")
    if not refresh_token:
        # No refresh path available -- return the (possibly expired) access
        # token and let the MCP server return 401 if it's stale.
        return entry["access_token"]

    lock = _refresh_locks.setdefault(server_name, asyncio.Lock())
    async with lock:
        # Re-read after acquiring the lock so a concurrent refresh wins.
        entry = load_tokens().get(server_name) or entry
        obtained_at = entry.get("obtained_at") or 0
        expires_in = entry.get("expires_in")
        if (
            isinstance(expires_in, (int, float))
            and expires_in > 0
            and obtained_at + expires_in - _REFRESH_LEEWAY_SECONDS > time.time()
        ):
            return entry["access_token"]

        payload: dict[str, Any] = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": entry["client_id"],
        }
        if entry.get("client_secret"):
            payload["client_secret"] = entry["client_secret"]

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(entry["token_endpoint"], data=payload)
                r.raise_for_status()
                tokens = r.json()
        except httpx.HTTPError as exc:
            logger.warning(
                "Refresh failed for MCP %s, returning stale token: %s",
                server_name,
                exc,
            )
            return entry["access_token"]

        new_entry = dict(entry)
        new_entry.update(tokens)
        new_entry["obtained_at"] = int(time.time())
        # Some auth servers (e.g. paperclip) rotate the refresh_token; others
        # don't return one on refresh. Preserve the previous one if missing.
        new_entry.setdefault("refresh_token", refresh_token)
        save_token(server_name, new_entry)
        return new_entry["access_token"]


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

    Reads tokens straight off disk from this module's OAuth store -- no
    refresh here so this stays sync. ``delegate_task`` calls
    :func:`refresh_oauth_tokens` first so spawn-time writes pick up
    freshly rotated tokens.

    User-supplied ``headers.Authorization`` (set in ``custom_mcps.json``)
    always wins so power users can override our injection with a
    different scheme (e.g. a static API key).
    """
    tokens = load_tokens()
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
    names = list(load_tokens().keys())
    for name in names:
        try:
            await get_access_token(name)
        except Exception:  # noqa: BLE001
            # Best-effort: log via the module logger but don't raise.
            import logging

            logging.getLogger(__name__).warning(
                "Pre-spawn OAuth refresh failed for %s; using cached token", name
            )


@dataclass
class ChromeProfile:
    """A single Chrome profile on disk."""

    id: str
    """Directory name under the Chrome user-data dir (e.g. ``Default``,
    ``Profile 1``). This is what browser-use's ``--profile`` expects."""

    name: str
    """Display name (falls back to ``id`` when the Local-State entry has
    no ``name``/``gaia_given_name``/``user_name``)."""

    email: str | None
    """The associated Google account email when present."""

    path: str
    """Absolute path to the profile directory."""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "path": self.path,
        }


def _chrome_user_data_dir() -> Path | None:
    """Return the Chrome user-data directory for the current user, if any.

    Returns the first existing candidate; callers should check the
    ``Local State`` file existence before using the result.
    """
    home = Path(os.path.expanduser("~"))
    system = platform.system()
    candidates: list[Path]
    if system == "Darwin":
        candidates = [home / "Library" / "Application Support" / "Google" / "Chrome"]
    elif system == "Windows":
        local_appdata = os.environ.get("LOCALAPPDATA")
        candidates = [Path(local_appdata) / "Google" / "Chrome" / "User Data"] if local_appdata else []
    else:  # Linux / BSD
        candidates = [
            home / ".config" / "google-chrome",
            home / ".config" / "chromium",
        ]
    for c in candidates:
        if c.is_dir():
            return c
    return None


def detect_chrome_profiles() -> list[ChromeProfile]:
    """Return the list of Chrome profiles detected on this machine.

    Safe to call when Chrome isn't installed — returns ``[]`` instead of
    raising. Sorted so ``Default`` (when present) comes first, followed
    by profiles sorted alphabetically by display name.
    """
    root = _chrome_user_data_dir()
    if root is None:
        return []

    local_state_path = root / "Local State"
    info_cache: dict = {}
    try:
        state = json.loads(local_state_path.read_text(encoding="utf-8"))
        info_cache = (state.get("profile") or {}).get("info_cache") or {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        info_cache = {}

    profiles: list[ChromeProfile] = []
    for profile_id, meta in info_cache.items():
        if not isinstance(meta, dict):
            continue
        path = root / profile_id
        if not path.is_dir():
            # Skip stale entries that no longer exist on disk.
            continue
        name = (
            meta.get("name")
            or meta.get("gaia_given_name")
            or meta.get("user_name")
            or profile_id
        )
        email = meta.get("user_name") or None
        profiles.append(
            ChromeProfile(
                id=profile_id,
                name=str(name),
                email=str(email) if email else None,
                path=str(path),
            )
        )

    def sort_key(p: ChromeProfile) -> tuple[int, str]:
        # Pin "Default" to the top, then sort by display name.
        return (0 if p.id == "Default" else 1, p.name.lower())

    profiles.sort(key=sort_key)
    return profiles


class ResilientMcpToolset(BaseToolset):
    """Wraps an McpToolset so that connection failures log a warning
    instead of crashing the agent run."""

    def __init__(self, inner: McpToolset, label: str = "MCP"):
        super().__init__(
            tool_filter=inner.tool_filter,
            tool_name_prefix=inner.tool_name_prefix,
        )
        self._inner = inner
        self._label = label

    async def get_tools(
        self, readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        try:
            return await self._inner.get_tools(readonly_context)
        except Exception as exc:
            logger.warning("%s unavailable, skipping its tools: %s", self._label, exc)
            return []

    async def close(self) -> None:
        try:
            await self._inner.close()
        except Exception:
            pass


def _make_toolset(name: str, spec: dict) -> ResilientMcpToolset | None:
    """Create a ResilientMcpToolset from a custom MCP server spec.

    Supports two formats (matching the Gemini CLI settings schema):
      - HTTP:  ``{"httpUrl": "...", "headers": {...}}``
      - Stdio: ``{"command": "...", "args": [...], "env": {...}}``
    """
    if "httpUrl" in spec:
        params = StreamableHTTPConnectionParams(
            url=spec["httpUrl"],
            headers=spec.get("headers", {}),
            timeout=spec.get("timeout", 120),
        )
    elif "command" in spec:
        params = StdioConnectionParams(
            server_params=StdioServerParameters(
                command=spec["command"],
                args=spec.get("args", []),
                env=spec.get("env"),
            ),
            timeout=float(spec.get("timeout", 120)),
        )
    else:
        logger.warning("Skipping custom MCP %r: no 'command' or 'httpUrl' key", name)
        return None
    return ResilientMcpToolset(McpToolset(connection_params=params), label=name)


class DynamicCustomMcpToolset(BaseToolset):
    """Reads the active project's ``custom_mcps.json`` on every agent turn
    and lazily creates / caches MCP connections for each entry.

    When the config file changes between turns the stale connections are
    torn down and new ones are established automatically — no server
    restart required.
    """

    def __init__(self) -> None:
        super().__init__()
        self._toolsets: dict[str, ResilientMcpToolset] = {}
        self._config_hash: str | None = None

    async def get_tools(
        self, readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        config = load_custom_mcps()
        new_hash = json.dumps(config, sort_keys=True)

        if new_hash != self._config_hash:
            await self._rebuild(config)
            self._config_hash = new_hash

        all_tools: List[BaseTool] = []
        for ts in self._toolsets.values():
            all_tools.extend(await ts.get_tools(readonly_context))
        return all_tools

    async def _rebuild(self, config: dict) -> None:
        for ts in self._toolsets.values():
            await ts.close()
        self._toolsets.clear()

        for name, spec in config.items():
            ts = _make_toolset(name, spec)
            if ts is not None:
                self._toolsets[name] = ts

    async def close(self) -> None:
        for ts in self._toolsets.values():
            await ts.close()
        self._toolsets.clear()


class DynamicBuiltinBrowserUseToolset(BaseToolset):
    """Built-in browser-use MCP that reloads when its per-project config
    changes between turns.

    Mirrors ``DynamicCustomMcpToolset``: reads ``browser_use.json`` on each
    call, tears down and rebuilds the underlying MCP connection only when
    the spec hash changes, and returns an empty tool list when the feature
    is disabled.
    """

    def __init__(self) -> None:
        super().__init__()
        self._toolset: ResilientMcpToolset | None = None
        self._spec_hash: str | None = None

    async def get_tools(
        self, readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        spec = build_browser_use_mcp_spec()
        new_hash = json.dumps(spec, sort_keys=True) if spec is not None else ""

        if new_hash != self._spec_hash:
            await self._rebuild(spec)
            self._spec_hash = new_hash

        if self._toolset is None:
            return []
        return await self._toolset.get_tools(readonly_context)

    async def _rebuild(self, spec: dict | None) -> None:
        if self._toolset is not None:
            await self._toolset.close()
            self._toolset = None
        if spec is None:
            return
        self._toolset = _make_toolset("Browser Use MCP", spec)

    async def close(self) -> None:
        if self._toolset is not None:
            await self._toolset.close()
            self._toolset = None


# ---------------------------------------------------------------------------
# Built-in MCP servers
# ---------------------------------------------------------------------------

all_mcps: list[BaseToolset] = []

if os.getenv("EXA_API_KEY"):
    exa_search_mcp = ResilientMcpToolset(
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url="https://mcp.exa.ai/mcp",
                headers={
                    "x-api-key": os.getenv("EXA_API_KEY"),
                    "x-exa-integration": "k-dense-byok",
                },
                timeout=600,
            ),
        ),
        label="Exa Search MCP",
    )
    all_mcps.append(exa_search_mcp)

if os.getenv("PARALLEL_API_KEY"):
    parallel_search_mcp = ResilientMcpToolset(
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url="https://search-mcp.parallel.ai/mcp",
                headers={"Authorization": f"Bearer {os.getenv('PARALLEL_API_KEY')}"},
                timeout=600,
            ),
        ),
        label="Parallel Search MCP",
    )
    all_mcps.append(parallel_search_mcp)

docling_mcp = ResilientMcpToolset(
    McpToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(
                command="uvx",
                args=["--from=docling-mcp", "docling-mcp-server"],
            ),
            timeout=120.0,
        ),
    ),
    label="Docling MCP",
)
all_mcps.append(docling_mcp)

# Browser automation via the browser-use CLI (loaded dynamically per-request
# so the Settings tab / input-bar chip hot-reload without a server restart).
all_mcps.append(DynamicBuiltinBrowserUseToolset())

# User-configured custom MCP servers (loaded dynamically per-request)
all_mcps.append(DynamicCustomMcpToolset())
