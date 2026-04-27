"""Unit tests for ``prep_sandbox.py``.

All side-effect-producing calls (subprocess.run, init_project_sandbox)
are mocked so the test is hermetic.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import prep_sandbox


def test_install_browser_use_chromium_short_circuits_when_marker_exists(
    tmp_path, monkeypatch
):
    marker = tmp_path / ".browser-use-installed"
    marker.touch()
    monkeypatch.setattr(prep_sandbox, "BROWSER_USE_MARKER", marker)

    def should_not_run(*a, **kw):
        raise AssertionError("subprocess.run should not have been called")

    monkeypatch.setattr(subprocess, "run", should_not_run)
    prep_sandbox.install_browser_use_chromium()


def test_install_browser_use_chromium_invokes_uvx(tmp_path, monkeypatch):
    marker = tmp_path / ".browser-use-installed"
    monkeypatch.setattr(prep_sandbox, "BROWSER_USE_MARKER", marker)
    calls = []

    def fake_run(args, check=False, **kw):
        calls.append(args)
        return None

    monkeypatch.setattr(subprocess, "run", fake_run)
    prep_sandbox.install_browser_use_chromium()
    assert calls == [["uvx", "browser-use", "install"]]
    assert marker.is_file()


def test_install_browser_use_chromium_handles_failure(tmp_path, monkeypatch, capsys):
    marker = tmp_path / ".browser-use-installed"
    monkeypatch.setattr(prep_sandbox, "BROWSER_USE_MARKER", marker)

    def fake_run(args, check=False, **kw):
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(subprocess, "run", fake_run)
    prep_sandbox.install_browser_use_chromium()
    out = capsys.readouterr().out
    assert "warning" in out
    # Failure path should NOT create the marker — we want to retry next time.
    assert not marker.is_file()


def test_main_initializes_every_non_archived_project(tmp_projects_root, monkeypatch):
    # No network, no subprocess.
    monkeypatch.setattr(prep_sandbox, "install_browser_use_chromium", lambda: None)
    # Seed one live and one archived project.
    from kady_agent import projects as projects_module

    projects_module.create_project(name="live", project_id="live-p")
    archived = projects_module.create_project(name="old", project_id="arch-p")
    projects_module.update_project(archived.id, archived=True)

    seen = []

    def fake_init(pid, **kw):
        seen.append(pid)

    monkeypatch.setattr(prep_sandbox, "init_project_sandbox", fake_init)

    prep_sandbox.main()
    # Default project gets seeded + live-p, but arch-p is skipped.
    assert "arch-p" not in seen
    assert "live-p" in seen
    assert projects_module.DEFAULT_PROJECT_ID in seen
