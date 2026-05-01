"""Unit tests for ``kady_agent/gemini_settings.py``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kady_agent import gemini_settings as gs


def test_default_browser_use_config_keys_are_stable():
    # If we ever rename/remove a config key the UI is expected to send,
    # this test should blow up.
    assert set(gs.DEFAULT_BROWSER_USE_CONFIG) == {
        "enabled",
        "headed",
        "profile",
        "session",
    }


def test_load_browser_use_config_returns_defaults_when_missing(active_project):
    cfg = gs.load_browser_use_config()
    assert cfg == gs.DEFAULT_BROWSER_USE_CONFIG


def test_save_and_load_browser_use_config_roundtrip(active_project):
    gs.save_browser_use_config({"enabled": False, "headed": True, "profile": "Default"})
    cfg = gs.load_browser_use_config()
    assert cfg["enabled"] is False
    assert cfg["headed"] is True
    assert cfg["profile"] == "Default"
    # Unknown keys are ignored on save
    gs.save_browser_use_config({"enabled": True, "nope": 1})
    cfg = gs.load_browser_use_config()
    assert "nope" not in cfg


def test_load_browser_use_config_tolerates_corrupt_json(active_project):
    # Write invalid JSON where the config file should live.
    active_project.browser_use_config_path.write_text("not json", encoding="utf-8")
    cfg = gs.load_browser_use_config()
    assert cfg == gs.DEFAULT_BROWSER_USE_CONFIG


def test_build_browser_use_mcp_spec_respects_enabled(active_project):
    gs.save_browser_use_config({"enabled": False})
    assert gs.build_browser_use_mcp_spec() is None

    gs.save_browser_use_config({"enabled": True, "headed": True, "profile": "P1"})
    spec = gs.build_browser_use_mcp_spec()
    assert spec == {
        "command": "uvx",
        "args": ["browser-use", "--headed", "--profile", "P1", "--mcp"],
    }


def test_build_browser_use_mcp_spec_with_session(active_project):
    gs.save_browser_use_config({"enabled": True, "session": "sess-1"})
    spec = gs.build_browser_use_mcp_spec()
    assert spec is not None
    assert "--session" in spec["args"]
    assert "sess-1" in spec["args"]


def test_build_default_settings_contains_core_mcps(active_project):
    settings = gs.build_default_settings()
    mcp = settings["mcpServers"]
    assert "docling" in mcp
    assert "pdf-annotations" in mcp
    # Hosted streamable-HTTP MCP shipped as a default for everyone.
    # Use the ``httpUrl`` form (universally accepted by Gemini CLI; the
    # newer ``{url, type: "http"}`` form is buggy in some 0.4x versions).
    assert mcp["paperclip"] == {
        "httpUrl": "https://paperclip.gxl.ai/mcp",
    }
    assert settings["security"]["auth"]["selectedType"] == "gemini-api-key"


def test_build_default_settings_omits_browser_use_when_disabled(active_project):
    gs.save_browser_use_config({"enabled": False})
    settings = gs.build_default_settings()
    assert "browser-use" not in settings["mcpServers"]


def test_build_default_settings_includes_browser_use_when_enabled(active_project):
    gs.save_browser_use_config({"enabled": True})
    settings = gs.build_default_settings()
    assert "browser-use" in settings["mcpServers"]


def test_load_save_custom_mcps_roundtrip(active_project):
    assert gs.load_custom_mcps() == {}
    gs.save_custom_mcps({"my-mcp": {"command": "uvx", "args": ["something"]}})
    assert gs.load_custom_mcps() == {"my-mcp": {"command": "uvx", "args": ["something"]}}


def test_load_custom_mcps_returns_empty_on_bad_file(active_project):
    active_project.custom_mcps_path.write_text("]", encoding="utf-8")
    assert gs.load_custom_mcps() == {}


def test_write_merged_settings_overlays_custom(active_project, tmp_path):
    gs.save_custom_mcps({"mycustom": {"command": "./run", "args": []}})
    target = tmp_path / "settings"
    gs.write_merged_settings(target)
    settings = json.loads((target / "settings.json").read_text())
    assert "docling" in settings["mcpServers"]
    assert "mycustom" in settings["mcpServers"]


def test_write_merged_settings_injects_oauth_bearer(active_project, tmp_path):
    """Stored MCP OAuth tokens land in the workspace settings.json as
    ``Authorization: Bearer ...`` headers so the spawned Gemini CLI
    authenticates on its first MCP call."""
    from kady_agent import mcp_oauth

    mcp_oauth.save_token(
        "paperclip",
        {"access_token": "pcp-tok", "token_type": "Bearer", "obtained_at": 0},
    )
    target = tmp_path / "settings"
    gs.write_merged_settings(target)
    settings = json.loads((target / "settings.json").read_text())
    paperclip = settings["mcpServers"]["paperclip"]
    assert paperclip["headers"]["Authorization"] == "Bearer pcp-tok"


def test_write_merged_settings_respects_user_authorization_header(
    active_project, tmp_path
):
    """If the user already set Authorization in custom_mcps.json we don't
    clobber it, even if there's a Kady-stored token for that server."""
    from kady_agent import mcp_oauth

    mcp_oauth.save_token(
        "paperclip",
        {"access_token": "auto", "token_type": "Bearer", "obtained_at": 0},
    )
    gs.save_custom_mcps(
        {
            "paperclip": {
                "httpUrl": "https://paperclip.gxl.ai/mcp",
                "headers": {"Authorization": "Bearer manual"},
            }
        }
    )
    target = tmp_path / "settings"
    gs.write_merged_settings(target)
    settings = json.loads((target / "settings.json").read_text())
    assert settings["mcpServers"]["paperclip"]["headers"]["Authorization"] == "Bearer manual"


def test_write_merged_settings_skips_stdio_servers_for_bearer(active_project, tmp_path):
    from kady_agent import mcp_oauth

    mcp_oauth.save_token(
        "docling",
        {"access_token": "shouldnt-go-here", "token_type": "Bearer", "obtained_at": 0},
    )
    target = tmp_path / "settings"
    gs.write_merged_settings(target)
    settings = json.loads((target / "settings.json").read_text())
    # docling is stdio; a bearer in headers would never reach it.
    assert "headers" not in settings["mcpServers"]["docling"]


@pytest.mark.asyncio
async def test_refresh_oauth_tokens_invokes_get_access_token_for_each_stored(
    active_project, monkeypatch
):
    """The pre-spawn hook walks every stored token so near-expiry ones get
    rotated before we materialize settings.json."""
    from kady_agent import mcp_oauth

    mcp_oauth.save_token("a", {"access_token": "1", "obtained_at": 0})
    mcp_oauth.save_token("b", {"access_token": "2", "obtained_at": 0})

    seen: list[str] = []

    async def fake_get(name: str):
        seen.append(name)
        return "ok"

    monkeypatch.setattr(mcp_oauth, "get_access_token", fake_get)
    await gs.refresh_oauth_tokens()
    assert sorted(seen) == ["a", "b"]


@pytest.mark.asyncio
async def test_refresh_oauth_tokens_swallows_per_server_failures(
    active_project, monkeypatch
):
    from kady_agent import mcp_oauth

    mcp_oauth.save_token("a", {"access_token": "1"})

    async def boom(name: str):
        raise RuntimeError("network down")

    monkeypatch.setattr(mcp_oauth, "get_access_token", boom)
    # Should not raise.
    await gs.refresh_oauth_tokens()
