import json
import os
import shutil
import subprocess

from kady_agent.utils import download_scientific_skills

SANDBOX_DIR = "sandbox"
GEMINI_CLI_MD = os.path.join("kady_agent", "instructions", "gemini_cli.md")
SANDBOX_VENV = os.path.join(SANDBOX_DIR, ".venv")
SANDBOX_PYPROJECT = os.path.join(SANDBOX_DIR, "pyproject.toml")

_PYPROJECT_TEMPLATE = """\
[project]
name = "kady-sandbox"
version = "0.1.1"
description = "Packages installed by Kady expert agents"
requires-python = ">=3.13"
dependencies = [
    "dask>=2026.3.0",
    "docling>=2.81.0",
    "markitdown[all]>=0.1.5",
    "matplotlib>=3.10.8",
    "modal>=1.3.5",
    "numpy>=2.4.3",
    "openrouter>=0.7.11",
    "polars>=1.39.3",
    "pyopenms>=3.5.0",
    "scipy>=1.17.1",
    "transformers>=4.57.6",
]
"""

os.makedirs(SANDBOX_DIR, exist_ok=True)

shutil.copy2(GEMINI_CLI_MD, os.path.join(SANDBOX_DIR, "GEMINI.md"))

settings_dir = os.path.join(SANDBOX_DIR, ".gemini")
os.makedirs(settings_dir, exist_ok=True)
gemini_settings = {
    "security": {"auth": {"selectedType": "gemini-api-key"}},
    "mcpServers": {
        "docling": {
            "command": "uvx",
            "args": ["--from=docling-mcp", "docling-mcp-server"],
        },
    },
}
parallel_key = os.getenv("PARALLEL_API_KEY")
if parallel_key:
    gemini_settings["mcpServers"]["parallel-search"] = {
        "httpUrl": "https://search-mcp.parallel.ai/mcp",
        "headers": {"Authorization": f"Bearer {parallel_key}"},
    }
with open(os.path.join(settings_dir, "settings.json"), "w") as f:
    json.dump(gemini_settings, f, indent=2)

if not os.path.isfile(SANDBOX_PYPROJECT):
    print("Seeding sandbox pyproject.toml...")
    with open(SANDBOX_PYPROJECT, "w") as f:
        f.write(_PYPROJECT_TEMPLATE)

print("Syncing sandbox Python environment...")
subprocess.run(["uv", "sync"], check=True, cwd=SANDBOX_DIR)

download_scientific_skills(target_dir="sandbox/.gemini/skills")