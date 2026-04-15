import os
import shutil
import subprocess

from kady_agent.gemini_settings import write_merged_settings
from kady_agent.runtime_paths import runtime_root, sandbox_root
from kady_agent.utils import download_scientific_skills

RUNTIME_ROOT = runtime_root()
SANDBOX_DIR = sandbox_root()
GEMINI_CLI_MD = RUNTIME_ROOT / "kady_agent" / "instructions" / "gemini_cli.md"
SANDBOX_VENV = SANDBOX_DIR / ".venv"
SANDBOX_PYPROJECT = SANDBOX_DIR / "pyproject.toml"

_PYPROJECT_TEMPLATE = """\
[project]
name = "kady-sandbox"
version = "0.1.2"
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
    "parallel-web-tools[cli]>=0.2.0",
]
"""

os.makedirs(SANDBOX_DIR, exist_ok=True)

shutil.copy2(GEMINI_CLI_MD, SANDBOX_DIR / "GEMINI.md")

write_merged_settings(SANDBOX_DIR / ".gemini")

if not os.path.isfile(SANDBOX_PYPROJECT):
    print("Seeding sandbox pyproject.toml...")
    with open(SANDBOX_PYPROJECT, "w", encoding="utf-8") as f:
        f.write(_PYPROJECT_TEMPLATE)

print("Syncing sandbox Python environment...")
subprocess.run(["uv", "sync"], check=True, cwd=SANDBOX_DIR)

download_scientific_skills(target_dir=SANDBOX_DIR / ".gemini" / "skills")
