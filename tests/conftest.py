"""Shared fixtures for k-dense-byok tests."""

import sys
from pathlib import Path

# Ensure project root is on sys.path so kady_agent and server can be imported
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


@pytest.fixture(autouse=True)
def isolate_cwd(tmp_path, monkeypatch):
    """Run every test in an isolated temp directory so sandbox ops are safe."""
    monkeypatch.chdir(tmp_path)
    yield tmp_path


@pytest.fixture
def sandbox_root(tmp_path):
    """Create a sandbox/ directory inside the isolated cwd."""
    sb = tmp_path / "sandbox"
    sb.mkdir()
    return sb


@pytest.fixture
def user_config_dir(tmp_path):
    """Create a user_config/ directory inside the isolated cwd."""
    uc = tmp_path / "user_config"
    uc.mkdir()
    return uc
