"""Unit tests for the sandbox_visibility module."""

from __future__ import annotations

from pathlib import Path

import pytest

from kady_agent.sandbox_visibility import USER_HIDDEN_NAMES, user_visible_entries


@pytest.fixture
def sandbox(tmp_path: Path) -> Path:
    (tmp_path / "visible.txt").write_text("hi", encoding="utf-8")
    (tmp_path / ".hidden").write_text("nope", encoding="utf-8")
    (tmp_path / "GEMINI.md").write_text("nope", encoding="utf-8")
    (tmp_path / "uv.lock").write_text("nope", encoding="utf-8")
    (tmp_path / "data.annotations.json").write_text("{}", encoding="utf-8")

    sub = tmp_path / "subdir"
    sub.mkdir()
    (sub / "nested.txt").write_text("hi", encoding="utf-8")

    nested_hidden = tmp_path / ".kady"
    nested_hidden.mkdir()
    (nested_hidden / "should_not_appear.txt").write_text("nope", encoding="utf-8")

    deep = tmp_path / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "leaf.txt").write_text("leaf", encoding="utf-8")

    return tmp_path


def test_dotfile_excluded(sandbox: Path) -> None:
    names = {p.name for p in user_visible_entries(sandbox)}
    assert ".hidden" not in names
    assert ".kady" not in names


def test_gemini_md_excluded(sandbox: Path) -> None:
    names = {p.name for p in user_visible_entries(sandbox)}
    assert "GEMINI.md" not in names


def test_uv_lock_excluded(sandbox: Path) -> None:
    names = {p.name for p in user_visible_entries(sandbox)}
    assert "uv.lock" not in names


def test_annotations_json_excluded(sandbox: Path) -> None:
    names = {p.name for p in user_visible_entries(sandbox)}
    assert "data.annotations.json" not in names


def test_normal_file_included(sandbox: Path) -> None:
    names = {p.name for p in user_visible_entries(sandbox)}
    assert "visible.txt" in names
    assert "subdir" in names
    assert "nested.txt" in names


def test_nested_under_dotdir_excluded(sandbox: Path) -> None:
    """Files under a hidden directory must not be yielded."""

    yielded = list(user_visible_entries(sandbox))
    for path in yielded:
        rel = path.relative_to(sandbox)
        assert all(not part.startswith(".") for part in rel.parts), (
            f"{rel} has a hidden ancestor"
        )


def test_max_depth_zero_yields_only_direct_children(sandbox: Path) -> None:
    paths = list(user_visible_entries(sandbox, max_depth=0))
    parents = {p.parent for p in paths}
    assert parents == {sandbox}


def test_max_depth_unbounded_reaches_deepest_leaf(sandbox: Path) -> None:
    paths = list(user_visible_entries(sandbox))
    leaf_names = {p.name for p in paths}
    assert "leaf.txt" in leaf_names


def test_max_depth_one_includes_grandchildren_only(sandbox: Path) -> None:
    paths = list(user_visible_entries(sandbox, max_depth=1))
    rels = {p.relative_to(sandbox).as_posix() for p in paths}
    assert "subdir/nested.txt" in rels
    # leaf at sandbox/a/b/c/leaf.txt — depth 4 — not present
    assert not any(rel.endswith("leaf.txt") for rel in rels)


def test_pre_order_parent_before_children(sandbox: Path) -> None:
    """Parents must yield before their contents so callers can rebuild trees."""

    paths = list(user_visible_entries(sandbox))
    seen: set[Path] = set()
    for path in paths:
        # Every ancestor up to (but not including) sandbox must already be seen,
        # except for direct sandbox children.
        parent = path.parent
        if parent != sandbox:
            assert parent in seen, f"{path} yielded before its parent {parent}"
        seen.add(path)


def test_missing_root_yields_empty(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    assert list(user_visible_entries(missing)) == []


def test_user_hidden_names_constant_is_a_set() -> None:
    assert "GEMINI.md" in USER_HIDDEN_NAMES
    assert "uv.lock" in USER_HIDDEN_NAMES
