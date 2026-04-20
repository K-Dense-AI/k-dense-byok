"""Unit tests for ``kady_agent/chrome_profiles.py``.

We redirect the module to a tmp ``Local State`` file via monkeypatch so
the test never depends on whether Chrome is actually installed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kady_agent import chrome_profiles as cp


def _seed_local_state(root: Path, info_cache: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "Local State").write_text(
        json.dumps({"profile": {"info_cache": info_cache}}),
        encoding="utf-8",
    )


def test_detect_returns_empty_when_no_chrome(monkeypatch):
    monkeypatch.setattr(cp, "_chrome_user_data_dir", lambda: None)
    assert cp.detect_chrome_profiles() == []


def test_detect_skips_missing_profile_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "_chrome_user_data_dir", lambda: tmp_path)
    _seed_local_state(
        tmp_path,
        {
            "Default": {"name": "My Default", "user_name": "me@example.com"},
            "Profile 99": {"name": "Ghost"},
        },
    )
    (tmp_path / "Default").mkdir()
    # Profile 99 directory is missing: should be skipped.
    profiles = cp.detect_chrome_profiles()
    assert [p.id for p in profiles] == ["Default"]
    assert profiles[0].email == "me@example.com"


def test_detect_pins_default_on_top(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "_chrome_user_data_dir", lambda: tmp_path)
    _seed_local_state(
        tmp_path,
        {
            "Profile 2": {"name": "Bravo"},
            "Default": {"name": "Alpha"},
            "Profile 1": {"name": "Charlie"},
        },
    )
    for d in ("Default", "Profile 1", "Profile 2"):
        (tmp_path / d).mkdir()
    profiles = cp.detect_chrome_profiles()
    assert profiles[0].id == "Default"
    # Rest are sorted by display name
    rest_names = [p.name for p in profiles[1:]]
    assert rest_names == sorted(rest_names, key=str.lower)


def test_detect_handles_corrupt_local_state(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "_chrome_user_data_dir", lambda: tmp_path)
    (tmp_path / "Local State").write_text("}}}", encoding="utf-8")
    assert cp.detect_chrome_profiles() == []


def test_chrome_profile_to_dict_shape(tmp_path):
    p = cp.ChromeProfile(id="Default", name="Alpha", email="a@b", path=str(tmp_path))
    assert p.to_dict() == {
        "id": "Default",
        "name": "Alpha",
        "email": "a@b",
        "path": str(tmp_path),
    }
