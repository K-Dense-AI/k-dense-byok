"""Unit tests for ``kady_agent/mcp_oauth.py``.

The OAuth dance involves three external HTTP hops (resource metadata,
authorization-server metadata, dynamic registration) plus the
authorization-code and refresh-token exchanges. We stub all of them with
a request-handler dispatch table on top of ``httpx.MockTransport`` so
the tests don't touch the network.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

from kady_agent import mcp_oauth


SERVER = "paperclip"
SERVER_URL = "https://paperclip.example/mcp"
RESOURCE_BASE = "https://paperclip.example"
REDIRECT_URI = "http://localhost:8000/oauth/mcp/callback"


def _ok_metadata() -> dict[str, Any]:
    return {
        "issuer": RESOURCE_BASE,
        "authorization_endpoint": f"{RESOURCE_BASE}/api/oauth/authorize",
        "token_endpoint": f"{RESOURCE_BASE}/api/oauth/token",
        "registration_endpoint": f"{RESOURCE_BASE}/api/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }


def _install_mock(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> dict[str, list[httpx.Request]]:
    """Replace httpx.AsyncClient with a transport that calls ``handler``.

    Returns a dict ``{"calls": [...]}`` capturing every request made for
    assertions.
    """
    state: dict[str, list[httpx.Request]] = {"calls": []}

    def wrapped(req: httpx.Request) -> httpx.Response:
        state["calls"].append(req)
        return handler(req)

    transport = httpx.MockTransport(wrapped)
    real_init = httpx.AsyncClient.__init__

    def patched(self: httpx.AsyncClient, *args: Any, **kwargs: Any) -> None:
        kwargs["transport"] = transport
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
    return state


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def test_load_tokens_returns_empty_when_missing(tmp_projects_root: Path):
    assert mcp_oauth.load_tokens() == {}


def test_save_and_load_token_roundtrip(tmp_projects_root: Path):
    mcp_oauth.save_token(
        SERVER,
        {"access_token": "atk", "refresh_token": "rtk", "obtained_at": 1, "expires_in": 100},
    )
    assert mcp_oauth.has_token(SERVER) is True
    assert mcp_oauth.load_tokens()[SERVER]["access_token"] == "atk"


def test_delete_token_returns_true_only_when_present(tmp_projects_root: Path):
    assert mcp_oauth.delete_token(SERVER) is False
    mcp_oauth.save_token(SERVER, {"access_token": "x"})
    assert mcp_oauth.delete_token(SERVER) is True
    assert mcp_oauth.has_token(SERVER) is False


def test_load_tokens_tolerates_corrupt_json(tmp_projects_root: Path):
    (tmp_projects_root / mcp_oauth.TOKENS_FILENAME).write_text("not json", encoding="utf-8")
    assert mcp_oauth.load_tokens() == {}


def test_token_summary_redacts_secrets_and_computes_expiry(tmp_projects_root: Path):
    obtained = int(time.time())
    mcp_oauth.save_token(
        SERVER,
        {
            "access_token": "atk",
            "refresh_token": "rtk",
            "obtained_at": obtained,
            "expires_in": 1800,
            "issuer": RESOURCE_BASE,
            "token_type": "Bearer",
        },
    )
    summary = mcp_oauth.token_summary(SERVER)
    assert summary == {
        "issuer": RESOURCE_BASE,
        "obtainedAt": obtained,
        "expiresAt": obtained + 1800,
        "tokenType": "Bearer",
        "hasRefreshToken": True,
    }


def test_env_var_name_normalizes():
    assert mcp_oauth.env_var_name("paperclip") == "KADY_MCP_TOKEN_PAPERCLIP"
    assert mcp_oauth.env_var_name("foo-bar.baz") == "KADY_MCP_TOKEN_FOO_BAR_BAZ"


# ---------------------------------------------------------------------------
# Discovery + registration + start_flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_flow_runs_full_discovery_and_returns_authorize_url(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/.well-known/oauth-protected-resource"):
            return httpx.Response(
                200,
                json={
                    "resource": RESOURCE_BASE,
                    "authorization_servers": [RESOURCE_BASE],
                },
            )
        if url.endswith("/.well-known/oauth-authorization-server"):
            return httpx.Response(200, json=_ok_metadata())
        if url.endswith("/api/oauth/register"):
            body = json.loads(req.content)
            assert body["redirect_uris"] == [REDIRECT_URI]
            return httpx.Response(
                200,
                json={"client_id": "abc123", "client_secret": None},
            )
        return httpx.Response(404, text="unexpected")

    calls = _install_mock(monkeypatch, handler)
    auth_url = await mcp_oauth.start_flow(SERVER, SERVER_URL, REDIRECT_URI)

    assert auth_url.startswith(f"{RESOURCE_BASE}/api/oauth/authorize?")
    assert "response_type=code" in auth_url
    assert "client_id=abc123" in auth_url
    assert "code_challenge_method=S256" in auth_url
    assert "redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Foauth%2Fmcp%2Fcallback" in auth_url
    # All three discovery + registration calls happened.
    assert len(calls["calls"]) == 3


@pytest.mark.asyncio
async def test_start_flow_falls_back_when_resource_metadata_missing(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/.well-known/oauth-protected-resource"):
            return httpx.Response(404)
        if url.endswith("/.well-known/oauth-authorization-server"):
            return httpx.Response(200, json=_ok_metadata())
        if url.endswith("/api/oauth/register"):
            return httpx.Response(200, json={"client_id": "abc"})
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    auth_url = await mcp_oauth.start_flow(SERVER, SERVER_URL, REDIRECT_URI)
    assert auth_url.startswith(f"{RESOURCE_BASE}/api/oauth/authorize?")


@pytest.mark.asyncio
async def test_start_flow_raises_when_registration_endpoint_absent(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/.well-known/oauth-protected-resource"):
            return httpx.Response(404)
        if url.endswith("/.well-known/oauth-authorization-server"):
            meta = _ok_metadata()
            meta.pop("registration_endpoint")
            return httpx.Response(200, json=meta)
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="registration_endpoint"):
        await mcp_oauth.start_flow(SERVER, SERVER_URL, REDIRECT_URI)


# ---------------------------------------------------------------------------
# complete_flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_complete_flow_persists_tokens(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/.well-known/oauth-protected-resource"):
            return httpx.Response(404)
        if url.endswith("/.well-known/oauth-authorization-server"):
            return httpx.Response(200, json=_ok_metadata())
        if url.endswith("/api/oauth/register"):
            return httpx.Response(200, json={"client_id": "abc"})
        if url.endswith("/api/oauth/token"):
            assert b"grant_type=authorization_code" in req.content
            assert b"code_verifier=" in req.content
            return httpx.Response(
                200,
                json={
                    "access_token": "atk-1",
                    "refresh_token": "rtk-1",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                },
            )
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    auth_url = await mcp_oauth.start_flow(SERVER, SERVER_URL, REDIRECT_URI)
    state = auth_url.split("state=", 1)[1].split("&")[0]

    server_name = await mcp_oauth.complete_flow(state, "the-auth-code")
    assert server_name == SERVER
    stored = mcp_oauth.load_tokens()[SERVER]
    assert stored["access_token"] == "atk-1"
    assert stored["refresh_token"] == "rtk-1"
    assert stored["client_id"] == "abc"
    assert stored["server_url"] == SERVER_URL


@pytest.mark.asyncio
async def test_complete_flow_rejects_unknown_state(tmp_projects_root: Path):
    with pytest.raises(RuntimeError, match="Unknown or expired"):
        await mcp_oauth.complete_flow("not-a-real-state", "code")


@pytest.mark.asyncio
async def test_complete_flow_rejects_expired_state(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/.well-known/oauth-protected-resource"):
            return httpx.Response(404)
        if url.endswith("/.well-known/oauth-authorization-server"):
            return httpx.Response(200, json=_ok_metadata())
        if url.endswith("/api/oauth/register"):
            return httpx.Response(200, json={"client_id": "abc"})
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    auth_url = await mcp_oauth.start_flow(SERVER, SERVER_URL, REDIRECT_URI)
    state = auth_url.split("state=", 1)[1].split("&")[0]
    # Force-expire the in-flight flow.
    mcp_oauth._in_flight[state]["expires_at"] = 0
    with pytest.raises(RuntimeError, match="Unknown or expired"):
        await mcp_oauth.complete_flow(state, "code")


# ---------------------------------------------------------------------------
# get_access_token (refresh path)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_access_token_returns_none_when_unsigned(tmp_projects_root: Path):
    assert await mcp_oauth.get_access_token(SERVER) is None


@pytest.mark.asyncio
async def test_get_access_token_returns_cached_when_fresh(tmp_projects_root: Path):
    mcp_oauth.save_token(
        SERVER,
        {
            "access_token": "still-good",
            "refresh_token": "rtk",
            "obtained_at": int(time.time()),
            "expires_in": 3600,
            "client_id": "abc",
            "token_endpoint": f"{RESOURCE_BASE}/api/oauth/token",
        },
    )
    assert await mcp_oauth.get_access_token(SERVER) == "still-good"


@pytest.mark.asyncio
async def test_get_access_token_refreshes_when_near_expiry(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        if str(req.url).endswith("/api/oauth/token"):
            assert b"grant_type=refresh_token" in req.content
            return httpx.Response(
                200,
                json={
                    "access_token": "fresh",
                    "refresh_token": "rtk-2",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                },
            )
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    mcp_oauth.save_token(
        SERVER,
        {
            "access_token": "stale",
            "refresh_token": "rtk-1",
            "obtained_at": int(time.time()) - 4000,
            "expires_in": 3600,
            "client_id": "abc",
            "token_endpoint": f"{RESOURCE_BASE}/api/oauth/token",
        },
    )
    token = await mcp_oauth.get_access_token(SERVER)
    assert token == "fresh"
    persisted = mcp_oauth.load_tokens()[SERVER]
    assert persisted["access_token"] == "fresh"
    assert persisted["refresh_token"] == "rtk-2"


@pytest.mark.asyncio
async def test_get_access_token_preserves_refresh_token_when_omitted(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        if str(req.url).endswith("/api/oauth/token"):
            return httpx.Response(
                200,
                json={"access_token": "fresh", "expires_in": 3600},
            )
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    mcp_oauth.save_token(
        SERVER,
        {
            "access_token": "stale",
            "refresh_token": "rtk-keep",
            "obtained_at": 0,
            "expires_in": 3600,
            "client_id": "abc",
            "token_endpoint": f"{RESOURCE_BASE}/api/oauth/token",
        },
    )
    await mcp_oauth.get_access_token(SERVER)
    assert mcp_oauth.load_tokens()[SERVER]["refresh_token"] == "rtk-keep"


@pytest.mark.asyncio
async def test_get_access_token_falls_back_to_stale_on_refresh_failure(
    tmp_projects_root: Path, monkeypatch: pytest.MonkeyPatch
):
    def handler(req: httpx.Request) -> httpx.Response:
        if str(req.url).endswith("/api/oauth/token"):
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(404)

    _install_mock(monkeypatch, handler)
    mcp_oauth.save_token(
        SERVER,
        {
            "access_token": "stale-but-returned",
            "refresh_token": "rtk",
            "obtained_at": 0,
            "expires_in": 3600,
            "client_id": "abc",
            "token_endpoint": f"{RESOURCE_BASE}/api/oauth/token",
        },
    )
    token = await mcp_oauth.get_access_token(SERVER)
    assert token == "stale-but-returned"
