import os
import subprocess

from kady_agent.utils import download_scientific_skills

SANDBOX_DIR = "sandbox"
SANDBOX_VENV = os.path.join(SANDBOX_DIR, ".venv")
SANDBOX_PYPROJECT = os.path.join(SANDBOX_DIR, "pyproject.toml")

_PYPROJECT_TEMPLATE = """\
[project]
name = "kady-sandbox"
version = "0.1.0"
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

if not os.path.isfile(SANDBOX_PYPROJECT):
    print("Seeding sandbox pyproject.toml...")
    with open(SANDBOX_PYPROJECT, "w") as f:
        f.write(_PYPROJECT_TEMPLATE)

if not os.path.isdir(SANDBOX_VENV):
    print("Creating sandbox Python environment...")
    subprocess.run(["uv", "venv", SANDBOX_VENV], check=True)
else:
    print("Sandbox Python environment already exists, skipping creation.")

download_scientific_skills(target_dir="sandbox/.gemini/skills")