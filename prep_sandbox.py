"""One-shot sandbox bootstrap for every known project.

Each project has its own isolated sandbox under ``projects/<id>/sandbox/``.
This script runs the heavy sandbox init (copy GEMINI.md, merge Gemini
settings, seed pyproject.toml, ``uv sync``, download scientific skills) for
every non-archived project in the registry.

Running this is safe and idempotent; it can be re-invoked any time a new
dependency is added to the sandbox pyproject template.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from kady_agent.projects import (
    DEFAULT_PROJECT_ID,
    ensure_project_exists,
    init_project_sandbox,
    list_projects,
)

REPO_ROOT = Path(__file__).resolve().parent
BROWSER_USE_MARKER = REPO_ROOT / ".venv" / ".browser-use-installed"


def install_browser_use_chromium() -> None:
    """Ensure browser-use's bundled Chromium is present (idempotent).

    The browser-use CLI spawns its own Chromium under ``~/.browser-use/``.
    Downloading it lazily on first MCP call causes a noticeable stall the
    first time the agent reaches for a browser tool, so we pre-fetch it as
    part of the normal sandbox prep. Guarded by a marker file so the check
    is a single ``exists()`` call on subsequent runs.
    """
    if BROWSER_USE_MARKER.is_file():
        return
    print("Installing browser-use Chromium (first-run only)...")
    try:
        subprocess.run(
            ["uvx", "browser-use", "install"],
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"  warning: `uvx browser-use install` failed: {exc}")
        print("  browser automation will try to install Chromium on first use.")
        return
    try:
        BROWSER_USE_MARKER.parent.mkdir(parents=True, exist_ok=True)
        BROWSER_USE_MARKER.touch()
    except OSError:
        pass


def main() -> None:
    install_browser_use_chromium()

    ensure_project_exists(DEFAULT_PROJECT_ID)

    projects = list_projects()
    if not projects:
        # Defensive: list_projects() self-heals from on-disk state, so this
        # branch means the registry truly is empty. Seed the default.
        ensure_project_exists(DEFAULT_PROJECT_ID)
        projects = list_projects()

    for meta in projects:
        if meta.archived:
            print(f"Skipping archived project: {meta.id}")
            continue
        print(f"== Initializing project: {meta.id} ({meta.name}) ==")
        init_project_sandbox(meta.id)


if __name__ == "__main__":
    main()
