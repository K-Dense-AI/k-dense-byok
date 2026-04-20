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
