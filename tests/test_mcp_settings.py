from __future__ import annotations

import time
from urllib.parse import parse_qs, urlparse

import pytest
import respx
from httpx import Response


def test_token_persistence_and_summary(active_project: str) -> None:
    from kady_agent import mcp

    mcp.save_token(
        "paperclip",
        {
            "access_token": "access",
            "refresh_token": "refresh",
            "token_type": "Bearer",
            "obtained_at": 100,
            "expires_in": 3600,
            "issuer": "issuer",
        },
    )

    assert mcp.has_token("paperclip")
    assert mcp.load_tokens()["paperclip"]["access_token"] == "access"
    assert mcp.token_summary("paperclip") == {
        "issuer": "issuer",
        "obtainedAt": 100,
        "expiresAt": 3700,
        "tokenType": "Bearer",
        "hasRefreshToken": True,
    }
    assert mcp.delete_token("paperclip") is True
    assert mcp.delete_token("paperclip") is False


def test_merged_settings_injects_oauth_bearer(active_project: str) -> None:
    from kady_agent import mcp

    mcp.save_custom_mcps(
        {
            "signed": {"httpUrl": "https://example.test/mcp"},
            "explicit": {
                "httpUrl": "https://example.test/explicit",
                "headers": {"authorization": "Basic abc"},
            },
            "stdio": {"command": "tool"},
        }
    )
    mcp.save_token("signed", {"access_token": "token", "token_type": "Bearer"})
    mcp.save_token("explicit", {"access_token": "ignored", "token_type": "Bearer"})

    settings = mcp.build_merged_settings()

    assert settings["mcpServers"]["signed"]["headers"]["Authorization"] == "Bearer token"
    assert settings["mcpServers"]["explicit"]["headers"]["authorization"] == "Basic abc"
    assert "headers" not in settings["mcpServers"]["stdio"]
    assert "pdf-annotations" in settings["mcpServers"]


def test_write_merged_settings_and_browser_use_config(active_project: str) -> None:
    from kady_agent import mcp, projects

    mcp.save_browser_use_config({"enabled": False, "headed": True, "profile": "Default"})
    assert mcp.build_browser_use_mcp_spec() is None

    mcp.save_browser_use_config(
        {"enabled": True, "headed": True, "profile": "Default", "session": "research"}
    )
    spec = mcp.build_browser_use_mcp_spec()
    assert spec["command"] == "uvx"
    assert "--headed" in spec["args"]
    assert "Default" in spec["args"]

    mcp.write_merged_settings(projects.active_paths().gemini_settings_dir)
    assert (projects.active_paths().gemini_settings_dir / "settings.json").is_file()


@respx.mock
async def test_start_and_complete_oauth_flow(active_project: str) -> None:
    from kady_agent import mcp

    mcp._in_flight.clear()
    respx.get("https://mcp.example/.well-known/oauth-protected-resource").mock(
        return_value=Response(
            200, json={"authorization_servers": ["https://auth.example"]}
        )
    )
    respx.get("https://auth.example/.well-known/oauth-authorization-server").mock(
        return_value=Response(
            200,
            json={
                "issuer": "https://auth.example",
                "authorization_endpoint": "https://auth.example/authorize",
                "token_endpoint": "https://auth.example/token",
                "registration_endpoint": "https://auth.example/register",
                "token_endpoint_auth_methods_supported": ["none"],
                "scopes_supported": ["mcp"],
            },
        )
    )
    respx.post("https://auth.example/register").mock(
        return_value=Response(201, json={"client_id": "client"})
    )
    respx.post("https://auth.example/token").mock(
        return_value=Response(
            200,
            json={
                "access_token": "access",
                "refresh_token": "refresh",
                "token_type": "Bearer",
                "expires_in": 3600,
            },
        )
    )

    auth_url = await mcp.start_flow(
        "paperclip", "https://mcp.example/mcp", "http://localhost/callback"
    )
    params = parse_qs(urlparse(auth_url).query)
    assert params["client_id"] == ["client"]
    assert params["code_challenge_method"] == ["S256"]

    server_name = await mcp.complete_flow(params["state"][0], "auth-code")
    assert server_name == "paperclip"
    assert mcp.load_tokens()["paperclip"]["access_token"] == "access"


@respx.mock
async def test_get_access_token_refreshes_near_expiry(active_project: str) -> None:
    from kady_agent import mcp

    mcp.save_token(
        "server",
        {
            "access_token": "old",
            "refresh_token": "refresh",
            "token_endpoint": "https://auth.example/token",
            "client_id": "client",
            "obtained_at": int(time.time()) - 3600,
            "expires_in": 10,
        },
    )
    respx.post("https://auth.example/token").mock(
        return_value=Response(200, json={"access_token": "new", "expires_in": 3600})
    )

    assert await mcp.get_access_token("server") == "new"
    assert mcp.load_tokens()["server"]["refresh_token"] == "refresh"


async def test_dynamic_custom_mcp_rebuilds_on_config_change(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import mcp

    closed: list[str] = []

    class FakeToolset:
        def __init__(self, name: str) -> None:
            self.name = name

        async def get_tools(self, readonly_context=None):
            return [self.name]

        async def close(self) -> None:
            closed.append(self.name)

    monkeypatch.setattr(
        mcp, "_make_toolset", lambda name, spec: FakeToolset(name) if "command" in spec else None
    )

    toolset = mcp.DynamicCustomMcpToolset()
    mcp.save_custom_mcps({"one": {"command": "tool"}})
    assert await toolset.get_tools() == ["one"]

    mcp.save_custom_mcps({"two": {"command": "tool"}})
    assert await toolset.get_tools() == ["two"]
    assert closed == ["one"]
