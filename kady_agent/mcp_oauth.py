"""OAuth 2.0 authorization-code-with-PKCE for HTTP/streamable MCP servers.

Gemini CLI ships its own MCP OAuth handler, but it is gated behind the
interactive ``/mcp auth <name>`` slash command -- which never gets reached
when Kady spawns the expert in headless mode (``gemini -p ...``). This
module reproduces the same RFC 8414 (auth-server metadata) + RFC 9728
(protected-resource metadata) + RFC 7591 (dynamic client registration) +
RFC 7636 (PKCE) dance so we can run it from the FastAPI backend, surface
the authorize URL in the UI, and persist the tokens in a Kady-owned file.

At expert-spawn time the workspace ``settings.json`` is rewritten with
``Authorization: Bearer <token>`` on the relevant ``mcpServers`` entries
(see ``kady_agent.tools.gemini_cli.delegate_task``). Tokens are refreshed
proactively before each spawn so a 1-hour access_token never expires
mid-delegation.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode, urlparse

import httpx

from . import projects as _projects

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
