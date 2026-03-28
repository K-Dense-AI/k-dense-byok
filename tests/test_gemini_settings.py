"""Tests for kady_agent.gemini_settings — settings building & persistence."""

import json
from unittest.mock import patch


from kady_agent.gemini_settings import (
    build_default_settings,
    load_custom_mcps,
    save_custom_mcps,
    write_merged_settings,
)


# ---------------------------------------------------------------------------
# build_default_settings
# ---------------------------------------------------------------------------


class TestBuildDefaultSettings:
    def test_base_structure(self):
        settings = build_default_settings()
        assert "security" in settings
        assert settings["security"]["auth"]["selectedType"] == "gemini-api-key"
        assert "mcpServers" in settings
        assert "docling" in settings["mcpServers"]

    def test_docling_mcp_config(self):
        settings = build_default_settings()
        docling = settings["mcpServers"]["docling"]
        assert docling["command"] == "uvx"
        assert "--from=docling-mcp" in docling["args"]

    def test_no_parallel_without_env(self):
        with patch.dict("os.environ", {}, clear=True):
            settings = build_default_settings()
            assert "parallel-search" not in settings["mcpServers"]

    def test_parallel_included_with_env(self):
        with patch.dict(
            "os.environ", {"PARALLEL_API_KEY": "test-key-123"}, clear=False
        ):
            settings = build_default_settings()
            assert "parallel-search" in settings["mcpServers"]
            ps = settings["mcpServers"]["parallel-search"]
            assert ps["httpUrl"] == "https://search-mcp.parallel.ai/mcp"
            assert "Bearer test-key-123" in ps["headers"]["Authorization"]


# ---------------------------------------------------------------------------
# load_custom_mcps
# ---------------------------------------------------------------------------


class TestLoadCustomMcps:
    def test_missing_file_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "kady_agent.gemini_settings.CUSTOM_MCPS_PATH",
            tmp_path / "nonexistent.json",
        )
        assert load_custom_mcps() == {}

    def test_valid_file(self, tmp_path, monkeypatch):
        path = tmp_path / "custom_mcps.json"
        path.write_text(json.dumps({"my-mcp": {"command": "echo"}}))
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", path)
        result = load_custom_mcps()
        assert result == {"my-mcp": {"command": "echo"}}

    def test_invalid_json_returns_empty(self, tmp_path, monkeypatch):
        path = tmp_path / "custom_mcps.json"
        path.write_text("NOT JSON {{{")
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", path)
        assert load_custom_mcps() == {}

    def test_non_dict_returns_empty(self, tmp_path, monkeypatch):
        path = tmp_path / "custom_mcps.json"
        path.write_text(json.dumps(["not", "a", "dict"]))
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", path)
        assert load_custom_mcps() == {}


# ---------------------------------------------------------------------------
# save_custom_mcps
# ---------------------------------------------------------------------------


class TestSaveCustomMcps:
    def test_creates_file(self, tmp_path, monkeypatch):
        path = tmp_path / "user_config" / "custom_mcps.json"
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", path)
        save_custom_mcps({"test": {"command": "hello"}})
        assert path.exists()
        data = json.loads(path.read_text())
        assert data == {"test": {"command": "hello"}}

    def test_overwrites_existing(self, tmp_path, monkeypatch):
        path = tmp_path / "user_config" / "custom_mcps.json"
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", path)
        save_custom_mcps({"v1": True})
        save_custom_mcps({"v2": True})
        data = json.loads(path.read_text())
        assert "v1" not in data
        assert data["v2"] is True

    def test_creates_parent_directory(self, tmp_path, monkeypatch):
        path = tmp_path / "deep" / "nested" / "custom_mcps.json"
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", path)
        save_custom_mcps({})
        assert path.exists()


# ---------------------------------------------------------------------------
# write_merged_settings
# ---------------------------------------------------------------------------


class TestWriteMergedSettings:
    def test_writes_settings_json(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "kady_agent.gemini_settings.CUSTOM_MCPS_PATH",
            tmp_path / "nonexistent.json",
        )
        target = tmp_path / "gemini"
        write_merged_settings(target)
        out = target / "settings.json"
        assert out.exists()
        data = json.loads(out.read_text())
        assert "mcpServers" in data
        assert "docling" in data["mcpServers"]

    def test_merges_custom_mcps(self, tmp_path, monkeypatch):
        custom_path = tmp_path / "custom_mcps.json"
        custom_path.write_text(json.dumps({"custom-tool": {"command": "run"}}))
        monkeypatch.setattr("kady_agent.gemini_settings.CUSTOM_MCPS_PATH", custom_path)

        target = tmp_path / "gemini"
        write_merged_settings(target)
        data = json.loads((target / "settings.json").read_text())
        assert "custom-tool" in data["mcpServers"]
        assert "docling" in data["mcpServers"]  # default still present
