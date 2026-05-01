"""Named-project registry and path resolution for K-Dense BYOK.

Replaces the single global `sandbox/` with a project-scoped layout. Every
user-visible artefact (sandbox files, per-turn manifests, citation cache,
custom MCP JSON, and ADK session DB) lives under
``projects/<project_id>/`` so projects stay self-contained and future
features (export/import, branching) have a natural unit of transfer.

The active project for the current request is tracked via a ``ContextVar``
that a FastAPI middleware sets from the ``X-Project-Id`` header. All code
that previously referenced the hardcoded sandbox path now calls
``active_paths()`` and reads the project-specific target.

The module is side-effect free on import. Callers that need a project's
on-disk skeleton to exist should call ``ensure_project_exists()``.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
from contextvars import ContextVar
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
PROJECTS_ROOT = (REPO_ROOT / "projects").resolve()
INDEX_PATH = PROJECTS_ROOT / "index.json"
DEFAULT_PROJECT_ID = "default"

# Kady-owned Gemini CLI trust file. Pointed at via the
# ``GEMINI_CLI_TRUSTED_FOLDERS_PATH`` env var when spawning the expert (see
# ``kady_agent/tools/gemini_cli.py``). Without this, recent Gemini CLI versions
# treat the project sandbox as untrusted and silently *ignore* the workspace
# ``<sandbox>/.gemini/settings.json`` we wrote -- so the user's
# ``~/.gemini/settings.json`` (often left on ``vertex-ai`` from a prior gcloud
# login) wins and the CLI exits demanding GOOGLE_CLOUD_PROJECT/_LOCATION. The
# trust file lives under ``projects/`` (which is gitignored) so we don't touch
# the user's global ``~/.gemini/trustedFolders.json``.
GEMINI_TRUSTED_FOLDERS_FILENAME = ".gemini-trustedFolders.json"

# Reserved project ids that can never be minted via create_project()
_RESERVED_IDS = {"new", "index", "archive", "..", "."}
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class ProjectMeta:
    id: str
    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    createdAt: str = ""
    updatedAt: str = ""
    archived: bool = False
    # Hard USD cap on cumulative cost across every session in this project.
    # ``None`` means "unlimited" and is the default for existing projects
    # that predate the feature.
    spendLimitUsd: Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "ProjectMeta":
        raw_limit = data.get("spendLimitUsd")
        spend_limit: Optional[float]
        if raw_limit is None or raw_limit == "":
            spend_limit = None
        else:
            try:
                spend_limit = float(raw_limit)
            except (TypeError, ValueError):
                spend_limit = None
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            description=str(data.get("description", "")),
            tags=[str(t) for t in (data.get("tags") or [])],
            createdAt=str(data.get("createdAt", "")),
            updatedAt=str(data.get("updatedAt", "")),
            archived=bool(data.get("archived", False)),
            spendLimitUsd=spend_limit,
        )


@dataclass
class ProjectPaths:
    """All on-disk locations owned by one project."""

    id: str
    root: Path
    project_json: Path
    sandbox: Path
    upload_dir: Path
    kady_dir: Path
    runs_dir: Path
    sessions_dir: Path
    citation_cache: Path
    gemini_settings_dir: Path
    custom_mcps_path: Path
    browser_use_config_path: Path
    sessions_db_path: Path


# ---------------------------------------------------------------------------
# Request-scoped active project
# ---------------------------------------------------------------------------

ACTIVE_PROJECT: ContextVar[str] = ContextVar(
    "kady_active_project", default=DEFAULT_PROJECT_ID
)


def set_active_project(project_id: str):
    """Set the active project for the current request/task.

    Returns a token the caller must pass to ``ACTIVE_PROJECT.reset(token)``
    in a ``finally`` block. The FastAPI middleware wraps this for HTTP
    requests; tests and one-off CLI code can use it directly.
    """
    return ACTIVE_PROJECT.set(project_id)


def current_project_id() -> str:
    return ACTIVE_PROJECT.get()


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------


def resolve_paths(project_id: str) -> ProjectPaths:
    if not project_id:
        project_id = DEFAULT_PROJECT_ID
    root = (PROJECTS_ROOT / project_id).resolve()
    # Lightweight path-traversal guard: resolved root must stay under PROJECTS_ROOT
    # even if the caller passed a malformed id.
    try:
        root.relative_to(PROJECTS_ROOT)
    except ValueError as exc:
        raise ValueError(f"Invalid project id {project_id!r}") from exc

    sandbox = root / "sandbox"
    kady_dir = sandbox / ".kady"
    return ProjectPaths(
        id=project_id,
        root=root,
        project_json=root / "project.json",
        sandbox=sandbox,
        upload_dir=sandbox / "user_data",
        kady_dir=kady_dir,
        runs_dir=kady_dir / "runs",
        sessions_dir=kady_dir / "sessions",
        citation_cache=kady_dir / "citation-cache.json",
        gemini_settings_dir=sandbox / ".gemini",
        custom_mcps_path=root / "custom_mcps.json",
        browser_use_config_path=root / "browser_use.json",
        sessions_db_path=root / "sessions.db",
    )


def active_paths() -> ProjectPaths:
    return resolve_paths(current_project_id())


# ---------------------------------------------------------------------------
# Registry I/O
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_projects_root() -> None:
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)


def gemini_trusted_folders_path() -> Path:
    """Return the absolute path to Kady's Gemini CLI trust file.

    Computed lazily so tests that monkeypatch ``PROJECTS_ROOT`` are honored.
    """
    return PROJECTS_ROOT / GEMINI_TRUSTED_FOLDERS_FILENAME


def ensure_gemini_trust_file() -> Path:
    """Write/refresh the Kady-owned Gemini CLI trust file (idempotent).

    Maps ``PROJECTS_ROOT`` to ``TRUST_PARENT`` so every project sandbox under
    ``projects/<id>/sandbox`` inherits trust automatically. The expert spawn
    points the CLI at this file via ``GEMINI_CLI_TRUSTED_FOLDERS_PATH``;
    without that, the workspace ``settings.json`` is ignored and the CLI
    falls back to the user's ``~/.gemini/settings.json`` -- which often
    selects ``vertex-ai`` and refuses to run.

    Returns the file's absolute path.
    """
    _ensure_projects_root()
    target = gemini_trusted_folders_path()
    desired = {str(PROJECTS_ROOT): "TRUST_PARENT"}
    try:
        existing = json.loads(target.read_text(encoding="utf-8"))
        if isinstance(existing, dict) and existing == desired:
            return target
    except (OSError, json.JSONDecodeError):
        pass
    target.write_text(json.dumps(desired, indent=2) + "\n", encoding="utf-8")
    return target


def _load_index() -> dict:
    if not INDEX_PATH.is_file():
        return {"projects": {}}
    try:
        data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"projects": {}}
    if not isinstance(data, dict) or "projects" not in data:
        return {"projects": {}}
    return data


def _save_index(index: dict) -> None:
    _ensure_projects_root()
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    tmp.replace(INDEX_PATH)


def _read_project_json(paths: ProjectPaths) -> Optional[ProjectMeta]:
    if not paths.project_json.is_file():
        return None
    try:
        data = json.loads(paths.project_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return ProjectMeta.from_dict(data)


def _write_project_json(paths: ProjectPaths, meta: ProjectMeta) -> None:
    paths.root.mkdir(parents=True, exist_ok=True)
    tmp = paths.project_json.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta.to_dict(), indent=2) + "\n", encoding="utf-8")
    tmp.replace(paths.project_json)


def _mint_project_id(name: str) -> str:
    """Generate a short, filesystem-safe id derived from the display name."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32]
    if not base:
        base = "proj"
    suffix = secrets.token_hex(3)
    return f"{base}-{suffix}" if base != "proj" else f"proj-{suffix}"


def _validate_id(project_id: str) -> None:
    if not _ID_RE.match(project_id) or project_id in _RESERVED_IDS:
        raise ValueError(f"Invalid project id: {project_id!r}")


# ---------------------------------------------------------------------------
# Public registry API
# ---------------------------------------------------------------------------


def list_projects() -> list[ProjectMeta]:
    """Return every known project, falling back to per-project.json on disk.

    The index file is the fast path; if a project directory exists on disk
    but the index is missing an entry, we rehydrate it from
    ``project.json``. This keeps the registry self-healing when users copy
    project folders in by hand (or unzip a future .kdense archive).
    """
    _ensure_projects_root()
    index = _load_index()
    known_ids = set(index["projects"].keys())

    if PROJECTS_ROOT.is_dir():
        for child in PROJECTS_ROOT.iterdir():
            if not child.is_dir():
                continue
            if child.name in known_ids:
                continue
            paths = resolve_paths(child.name)
            meta = _read_project_json(paths)
            if meta is None:
                continue
            index["projects"][meta.id] = meta.to_dict()
            known_ids.add(meta.id)

    if index.get("_dirty"):
        index.pop("_dirty", None)
    _save_index(index)

    out: list[ProjectMeta] = []
    for raw in index["projects"].values():
        out.append(ProjectMeta.from_dict(raw))

    out.sort(
        key=lambda m: (m.archived, m.updatedAt or m.createdAt or m.id),
        reverse=False,
    )
    # non-archived first, then by updatedAt desc within each group
    out.sort(
        key=lambda m: (
            1 if m.archived else 0,
            -_ts(m.updatedAt or m.createdAt),
        )
    )
    return out


def _ts(iso: str) -> float:
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def get_project(project_id: str) -> Optional[ProjectMeta]:
    index = _load_index()
    raw = index["projects"].get(project_id)
    if raw:
        return ProjectMeta.from_dict(raw)
    paths = resolve_paths(project_id)
    return _read_project_json(paths)


def project_exists(project_id: str) -> bool:
    return get_project(project_id) is not None


def create_project(
    name: str,
    description: str = "",
    tags: Optional[Iterable[str]] = None,
    project_id: Optional[str] = None,
    spend_limit_usd: Optional[float] = None,
) -> ProjectMeta:
    """Create the on-disk skeleton and registry entry for a new project.

    This is the fast path: it only writes ``project.json``, an empty
    ``custom_mcps.json``, and the sandbox directory. The heavy bootstrap
    (GEMINI.md, merged settings, ``pyproject.toml``, ``uv sync``, scientific
    skills) is handled by ``init_project_sandbox`` and is scheduled as a
    background task from the HTTP layer so the create request returns
    immediately.
    """
    name = (name or "").strip() or "Untitled project"
    if project_id is None:
        project_id = _mint_project_id(name)
    _validate_id(project_id)

    paths = resolve_paths(project_id)
    if paths.root.exists():
        raise ValueError(f"Project already exists: {project_id}")

    now = _now_iso()
    validated_limit: Optional[float] = None
    if spend_limit_usd is not None:
        try:
            value = float(spend_limit_usd)
        except (TypeError, ValueError) as exc:
            raise ValueError("spendLimitUsd must be a number or null") from exc
        if value < 0:
            raise ValueError("spendLimitUsd must be >= 0")
        validated_limit = value
    meta = ProjectMeta(
        id=project_id,
        name=name,
        description=(description or "").strip(),
        tags=[t.strip() for t in (tags or []) if t and t.strip()],
        createdAt=now,
        updatedAt=now,
        archived=False,
        spendLimitUsd=validated_limit,
    )
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.sandbox.mkdir(parents=True, exist_ok=True)
    # Seed an empty custom MCP file so the UI editor opens on a valid object.
    if not paths.custom_mcps_path.is_file():
        paths.custom_mcps_path.write_text("{}\n", encoding="utf-8")
    _write_project_json(paths, meta)

    index = _load_index()
    index["projects"][meta.id] = meta.to_dict()
    _save_index(index)

    return meta


# Sentinel used to distinguish "field not provided" from "explicitly set to None"
# in update_project. We need this because ``spendLimitUsd=None`` is a meaningful
# value (clear the cap) that is not the same as "leave the existing cap alone".
_UNSET: Any = object()


def update_project(
    project_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    tags: Optional[Iterable[str]] = None,
    archived: Optional[bool] = None,
    spend_limit_usd: Any = _UNSET,
) -> ProjectMeta:
    meta = get_project(project_id)
    if meta is None:
        raise KeyError(project_id)
    if name is not None:
        meta.name = name.strip() or meta.name
    if description is not None:
        meta.description = description.strip()
    if tags is not None:
        meta.tags = [t.strip() for t in tags if t and t.strip()]
    if archived is not None:
        meta.archived = bool(archived)
    if spend_limit_usd is not _UNSET:
        if spend_limit_usd is None:
            meta.spendLimitUsd = None
        else:
            try:
                value = float(spend_limit_usd)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"spendLimitUsd must be a number or null, got {spend_limit_usd!r}"
                ) from exc
            if value < 0:
                raise ValueError("spendLimitUsd must be >= 0")
            meta.spendLimitUsd = value
    meta.updatedAt = _now_iso()

    paths = resolve_paths(project_id)
    _write_project_json(paths, meta)
    index = _load_index()
    index["projects"][meta.id] = meta.to_dict()
    _save_index(index)
    return meta


def touch_project(project_id: str) -> None:
    """Bump updatedAt on every mutation that isn't routed through update_project."""
    meta = get_project(project_id)
    if meta is None:
        return
    meta.updatedAt = _now_iso()
    paths = resolve_paths(project_id)
    try:
        _write_project_json(paths, meta)
    except OSError:
        pass
    index = _load_index()
    index["projects"][meta.id] = meta.to_dict()
    try:
        _save_index(index)
    except OSError:
        pass


def delete_project(project_id: str) -> None:
    if project_id == DEFAULT_PROJECT_ID:
        raise ValueError("The default project cannot be deleted")
    _validate_id(project_id)
    paths = resolve_paths(project_id)
    if paths.root.exists():
        shutil.rmtree(paths.root)
    index = _load_index()
    index["projects"].pop(project_id, None)
    _save_index(index)


# ---------------------------------------------------------------------------
# Project bootstrap (sandbox init)
# ---------------------------------------------------------------------------


def _find_sibling_skills_dir(exclude_id: str | None = None) -> Optional[Path]:
    """Return any other project's ``.gemini/skills`` directory that already has skills.

    Used by ``seed_project_skills`` so a freshly-created project can copy an
    existing catalogue locally instead of re-cloning from GitHub every time.
    """
    if not PROJECTS_ROOT.is_dir():
        return None
    for child in PROJECTS_ROOT.iterdir():
        if not child.is_dir():
            continue
        if exclude_id is not None and child.name == exclude_id:
            continue
        candidate = child / "sandbox" / ".gemini" / "skills"
        if not candidate.is_dir():
            continue
        try:
            has_skill = any(
                (d / "SKILL.md").is_file() for d in candidate.iterdir() if d.is_dir()
            )
        except OSError:
            has_skill = False
        if has_skill:
            return candidate
    return None


def seed_project_skills(paths: ProjectPaths, *, allow_remote: bool = True) -> None:
    """Populate ``<project>/sandbox/.gemini/skills`` so the expert can use them.

    Fast path: copy every skill from a sibling project that already has the
    catalogue. Slow path (no siblings): git-clone the scientific-skills repo.
    Network failures are logged but never raised - a project without skills
    is still usable, just with a reduced expert catalogue.

    Pass ``allow_remote=False`` to skip the GitHub fallback. The synchronous
    POST /projects bootstrap uses that flag so the response time stays
    bounded (a sibling copy is local I/O; a clone is a multi-second network
    round trip).
    """
    skills_dir = paths.gemini_settings_dir / "skills"
    if skills_dir.is_dir():
        try:
            already_populated = any(
                (d / "SKILL.md").is_file()
                for d in skills_dir.iterdir()
                if d.is_dir()
            )
        except OSError:
            already_populated = False
        if already_populated:
            return

    skills_dir.mkdir(parents=True, exist_ok=True)

    source = _find_sibling_skills_dir(exclude_id=paths.id)
    if source is not None:
        copied = 0
        for child in source.iterdir():
            if not child.is_dir():
                continue
            dest = skills_dir / child.name
            if dest.exists():
                continue
            try:
                shutil.copytree(child, dest)
                copied += 1
            except OSError as exc:
                print(f"  warning: failed to copy skill {child.name}: {exc}")
        if copied:
            print(f"Seeded {copied} skills for {paths.id} from {source}")
            return

    if not allow_remote:
        # Caller is on a latency-sensitive path (e.g. POST /projects). Leave
        # the empty skills/ directory in place; the background bootstrap or
        # a later /sandbox/init will fill it in.
        return

    # No sibling catalogue to copy from: fall back to GitHub.
    from .utils import download_scientific_skills

    try:
        download_scientific_skills(target_dir=str(skills_dir))
    except Exception as exc:
        print(f"  warning: skill download failed for {paths.id}: {exc}")


_SANDBOX_PYPROJECT_TEMPLATE = """\
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


def init_project_sandbox(
    project_id: str,
    *,
    sync_venv: bool = True,
    download_skills: bool = True,
    allow_remote_skills: bool = True,
) -> ProjectPaths:
    """Lay down the sandbox skeleton for a project.

    Idempotent: safe to call on every startup or after a user deletes part
    of the sandbox. Copies the baseline ``GEMINI.md``, writes merged MCP
    settings, seeds ``pyproject.toml``, and optionally runs ``uv sync`` +
    fetches the scientific skills catalogue.

    ``allow_remote_skills=False`` makes ``seed_project_skills`` skip its
    GitHub fallback so the synchronous POST /projects path can run this
    function without a multi-second network round trip when no sibling
    catalogue is available.
    """
    # Local imports avoid a circular import with gemini_settings / utils, both
    # of which import from this module to resolve paths.
    from .gemini_settings import write_merged_settings

    paths = resolve_paths(project_id)
    paths.sandbox.mkdir(parents=True, exist_ok=True)

    gemini_md_src = REPO_ROOT / "kady_agent" / "instructions" / "gemini_cli.md"
    gemini_md_dst = paths.sandbox / "GEMINI.md"
    if gemini_md_src.is_file():
        shutil.copy2(gemini_md_src, gemini_md_dst)

    token = set_active_project(project_id)
    try:
        write_merged_settings(paths.gemini_settings_dir)
    finally:
        ACTIVE_PROJECT.reset(token)

    ensure_gemini_trust_file()

    pyproject_path = paths.sandbox / "pyproject.toml"
    if not pyproject_path.is_file():
        pyproject_path.write_text(_SANDBOX_PYPROJECT_TEMPLATE, encoding="utf-8")

    if sync_venv:
        try:
            print(f"Syncing sandbox Python environment for {project_id}...")
            subprocess.run(
                ["uv", "sync"], check=True, cwd=str(paths.sandbox)
            )
        except (FileNotFoundError, subprocess.CalledProcessError) as exc:
            print(f"  warning: uv sync failed for {project_id}: {exc}")

    if download_skills:
        seed_project_skills(paths, allow_remote=allow_remote_skills)

    return paths


def ensure_project_exists(project_id: str) -> ProjectPaths:
    """Create the directory skeleton for a project if it doesn't exist yet.

    Cheap; runs on every request via middleware. Does NOT run the heavy
    sandbox bootstrap (venv + skill download); that happens only on
    explicit create or via prep_sandbox.
    """
    _validate_id(project_id)
    paths = resolve_paths(project_id)
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.sandbox.mkdir(parents=True, exist_ok=True)
    paths.kady_dir.mkdir(parents=True, exist_ok=True)

    if not paths.project_json.is_file():
        # Orphan directory or freshly-minted project that never made it into
        # the registry. Seed a bare ProjectMeta so every project on disk has
        # a self-describing project.json.
        now = _now_iso()
        meta = ProjectMeta(
            id=project_id,
            name=project_id.replace("-", " ").title(),
            createdAt=now,
            updatedAt=now,
        )
        _write_project_json(paths, meta)
        index = _load_index()
        if project_id not in index["projects"]:
            index["projects"][project_id] = meta.to_dict()
            _save_index(index)

    if not paths.custom_mcps_path.is_file():
        paths.custom_mcps_path.write_text("{}\n", encoding="utf-8")

    # Always ensure the Gemini CLI workspace settings exist so the expert
    # authenticates via our LiteLLM proxy (gemini-api-key) regardless of
    # what the user has in ~/.gemini/settings.json (which defaults to
    # `vertex-ai` on machines that were previously logged into gcloud).
    # Workspace settings only win over user settings when the folder is
    # *trusted*; recent Gemini CLI versions silently ignore the workspace
    # settings.json otherwise. ``ensure_gemini_trust_file`` writes the
    # Kady-owned trust file that ``delegate_task`` points the CLI at via
    # ``GEMINI_CLI_TRUSTED_FOLDERS_PATH`` so this protocol actually holds.
    workspace_settings = paths.gemini_settings_dir / "settings.json"
    if not workspace_settings.is_file():
        from .gemini_settings import write_merged_settings

        token = set_active_project(project_id)
        try:
            write_merged_settings(paths.gemini_settings_dir)
        finally:
            ACTIVE_PROJECT.reset(token)

    ensure_gemini_trust_file()

    return paths


__all__ = [
    "ACTIVE_PROJECT",
    "DEFAULT_PROJECT_ID",
    "GEMINI_TRUSTED_FOLDERS_FILENAME",
    "PROJECTS_ROOT",
    "ProjectMeta",
    "ProjectPaths",
    "active_paths",
    "create_project",
    "current_project_id",
    "delete_project",
    "ensure_gemini_trust_file",
    "ensure_project_exists",
    "gemini_trusted_folders_path",
    "get_project",
    "init_project_sandbox",
    "list_projects",
    "project_exists",
    "resolve_paths",
    "seed_project_skills",
    "set_active_project",
    "touch_project",
    "update_project",
]
