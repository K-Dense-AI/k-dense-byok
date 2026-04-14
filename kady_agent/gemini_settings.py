"""Shared helpers for building and persisting Gemini CLI settings.

The default MCP servers (docling, parallel-search) are defined here.
User-added MCP servers live in ``user_config/custom_mcps.json`` at the
project root — outside ``sandbox/`` so they survive sandbox deletion.
"""

import json
from pathlib import Path

CUSTOM_MCPS_PATH = Path("user_config/custom_mcps.json")


def build_default_settings() -> dict:
    """Return the base Gemini CLI settings dict with built-in MCP servers."""
    settings: dict = {
        "security": {"auth": {"selectedType": "gemini-api-key"}},
        "mcpServers": {
            "docling": {
                "command": "uvx",
                "args": ["--from=docling-mcp", "docling-mcp-server"],
            },
        },
    }
    return settings


def load_custom_mcps() -> dict:
    """Read user-defined MCP servers from ``user_config/custom_mcps.json``.

    Returns an empty dict when the file is missing or unparseable.
    """
    try:
        data = json.loads(CUSTOM_MCPS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {}


def save_custom_mcps(data: dict) -> None:
    """Persist user-defined MCP servers to ``user_config/custom_mcps.json``."""
    CUSTOM_MCPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CUSTOM_MCPS_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def write_merged_settings(target_dir: str | Path) -> None:
    """Build merged settings and write to ``<target_dir>/settings.json``.

    *target_dir* is typically ``sandbox/.gemini``.
    """
    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    settings = build_default_settings()
    custom = load_custom_mcps()
    settings["mcpServers"].update(custom)

    out = target_dir / "settings.json"
    out.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
