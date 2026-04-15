import os
from pathlib import Path


def runtime_root() -> Path:
    return Path(__file__).resolve().parents[1]


def workspace_root() -> Path:
    configured = os.environ.get("KDENSE_WORKSPACE_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return runtime_root()


def sandbox_root() -> Path:
    return workspace_root() / "sandbox"


def user_config_root() -> Path:
    return workspace_root() / "user_config"


def instructions_root() -> Path:
    return runtime_root() / "kady_agent" / "instructions"
