"""Unit tests for ``kady_agent/projects.py``.

These tests intentionally skip the ``active_project`` fixture because they
want to drive the registry directly from the temp PROJECTS_ROOT.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kady_agent import projects as projects_module


# ---------------------------------------------------------------------------
# resolve_paths and traversal guard
# ---------------------------------------------------------------------------


def test_resolve_paths_assembles_project_layout(tmp_projects_root: Path):
    paths = projects_module.resolve_paths("my-proj")
    assert paths.root == tmp_projects_root / "my-proj"
    assert paths.sandbox == paths.root / "sandbox"
    assert paths.kady_dir == paths.sandbox / ".kady"
    assert paths.runs_dir == paths.kady_dir / "runs"
    assert paths.sessions_dir == paths.kady_dir / "sessions"
    assert paths.project_json == paths.root / "project.json"
    assert paths.custom_mcps_path == paths.root / "custom_mcps.json"


def test_resolve_paths_rejects_path_traversal(tmp_projects_root: Path):
    with pytest.raises(ValueError):
        projects_module.resolve_paths("../escape")


def test_resolve_paths_defaults_when_empty(tmp_projects_root: Path):
    paths = projects_module.resolve_paths("")
    assert paths.id == projects_module.DEFAULT_PROJECT_ID


# ---------------------------------------------------------------------------
# ACTIVE_PROJECT + active_paths
# ---------------------------------------------------------------------------


def test_set_active_project_scopes_active_paths(tmp_projects_root: Path):
    token = projects_module.set_active_project("alpha")
    try:
        assert projects_module.current_project_id() == "alpha"
        assert projects_module.active_paths().id == "alpha"
    finally:
        projects_module.ACTIVE_PROJECT.reset(token)


# ---------------------------------------------------------------------------
# create_project / update_project / delete_project
# ---------------------------------------------------------------------------


def test_create_project_writes_skeleton_and_index(tmp_projects_root: Path):
    meta = projects_module.create_project(
        name="My Study", description="notes", tags=["single-cell"]
    )
    assert meta.name == "My Study"
    paths = projects_module.resolve_paths(meta.id)
    assert paths.project_json.is_file()
    assert paths.sandbox.is_dir()
    assert paths.custom_mcps_path.is_file()
    on_disk = json.loads(paths.project_json.read_text())
    assert on_disk["name"] == "My Study"
    assert on_disk["tags"] == ["single-cell"]

    index = json.loads((tmp_projects_root / "index.json").read_text())
    assert meta.id in index["projects"]


def test_create_project_rejects_reserved_id(tmp_projects_root: Path):
    with pytest.raises(ValueError):
        projects_module.create_project(name="x", project_id="new")


def test_create_project_rejects_duplicate(tmp_projects_root: Path):
    projects_module.create_project(name="Dup", project_id="dup-test")
    with pytest.raises(ValueError):
        projects_module.create_project(name="Dup", project_id="dup-test")


def test_create_project_empty_name_becomes_untitled(tmp_projects_root: Path):
    meta = projects_module.create_project(name="   ", project_id="ut-test")
    assert meta.name == "Untitled project"


def test_mint_project_id_slugifies_name(tmp_projects_root: Path):
    meta = projects_module.create_project(name="My Awesome  Study!")
    assert meta.id.startswith("my-awesome-study-")


def test_update_project_patches_only_given_fields(tmp_projects_root: Path):
    meta = projects_module.create_project(name="orig", project_id="upd")
    created_at = meta.createdAt
    updated = projects_module.update_project(
        "upd", description="new description", tags=["a", "b"]
    )
    assert updated.description == "new description"
    assert updated.tags == ["a", "b"]
    assert updated.createdAt == created_at
    assert updated.updatedAt >= created_at


def test_update_project_missing_id_raises(tmp_projects_root: Path):
    with pytest.raises(KeyError):
        projects_module.update_project("nope")


def test_delete_project_removes_tree_and_index(tmp_projects_root: Path):
    meta = projects_module.create_project(name="x", project_id="to-delete")
    paths = projects_module.resolve_paths(meta.id)
    assert paths.root.exists()
    projects_module.delete_project(meta.id)
    assert not paths.root.exists()
    assert projects_module.get_project(meta.id) is None


def test_delete_project_default_forbidden(tmp_projects_root: Path):
    with pytest.raises(ValueError):
        projects_module.delete_project(projects_module.DEFAULT_PROJECT_ID)


# ---------------------------------------------------------------------------
# list_projects & self-healing
# ---------------------------------------------------------------------------


def test_list_projects_rehydrates_orphan_directory(tmp_projects_root: Path):
    # Create a project on disk WITHOUT touching the index (simulate manual copy).
    paths = projects_module.resolve_paths("manual-copy")
    paths.root.mkdir(parents=True)
    paths.sandbox.mkdir(parents=True)
    projects_module._write_project_json(
        paths,
        projects_module.ProjectMeta(
            id="manual-copy",
            name="Manual",
            createdAt="2024-01-01T00:00:00+00:00",
            updatedAt="2024-01-01T00:00:00+00:00",
        ),
    )
    # No index update.
    listed = projects_module.list_projects()
    ids = [m.id for m in listed]
    assert "manual-copy" in ids

    # Now the index should be updated on disk too.
    index = json.loads((tmp_projects_root / "index.json").read_text())
    assert "manual-copy" in index["projects"]


def test_list_projects_sorts_active_before_archived(tmp_projects_root: Path):
    projects_module.create_project(name="live", project_id="live-one")
    arch = projects_module.create_project(name="arch", project_id="arch-one")
    projects_module.update_project(arch.id, archived=True)
    listed = projects_module.list_projects()
    archived_idx = next(i for i, m in enumerate(listed) if m.id == "arch-one")
    live_idx = next(i for i, m in enumerate(listed) if m.id == "live-one")
    assert live_idx < archived_idx


# ---------------------------------------------------------------------------
# ensure_project_exists
# ---------------------------------------------------------------------------


def test_ensure_project_exists_creates_and_seeds(tmp_projects_root: Path, monkeypatch):
    # Avoid write_merged_settings touching the fs more than it must.
    from kady_agent import gemini_settings as gs
    calls = {}

    def fake_write(dir_: Path):
        calls["dir"] = dir_
        dir_.mkdir(parents=True, exist_ok=True)
        (dir_ / "settings.json").write_text("{}\n", encoding="utf-8")

    monkeypatch.setattr(gs, "write_merged_settings", fake_write)

    paths = projects_module.ensure_project_exists("brand-new")
    assert paths.root.is_dir()
    assert paths.sandbox.is_dir()
    assert paths.project_json.is_file()
    assert paths.custom_mcps_path.is_file()
    # Settings generator was invoked against the right dir
    assert calls["dir"] == paths.gemini_settings_dir


def test_ensure_project_exists_invalid_id(tmp_projects_root: Path):
    with pytest.raises(ValueError):
        projects_module.ensure_project_exists("Not Valid!")


# ---------------------------------------------------------------------------
# migrate_legacy_layout
# ---------------------------------------------------------------------------


def test_migrate_legacy_layout_returns_false_when_default_exists(
    tmp_projects_root: Path, monkeypatch
):
    # If default project already seeded, migrate returns False.
    projects_module.create_project(
        name="Default", project_id=projects_module.DEFAULT_PROJECT_ID
    )
    monkeypatch.setattr(projects_module, "REPO_ROOT", tmp_projects_root.parent)
    assert projects_module.migrate_legacy_layout() is False
