"""Tests for the ProjectPaths deepening — methods + structural invariant.

The structural test pins the rule "ProjectPaths owns path-bound I/O only;
no domain logic over loaded content" by asserting that every method's
parameter annotations stay inside a plain-data allowlist. Adding a method
that takes a callable, a request/response, or any domain object will fail
the test at CI time.
"""

from __future__ import annotations

import inspect
import typing
from pathlib import Path


def test_gemini_skills_dir_resolves_under_settings_dir(active_project: str) -> None:
    from kady_agent import projects

    paths = projects.resolve_paths(active_project)
    assert paths.gemini_skills_dir() == paths.gemini_settings_dir / "skills"


def test_load_citation_cache_returns_empty_when_missing(active_project: str) -> None:
    from kady_agent import projects

    paths = projects.resolve_paths(active_project)
    if paths.citation_cache.exists():
        paths.citation_cache.unlink()
    assert paths.load_citation_cache() == {}


def test_save_then_load_citation_cache_round_trips(active_project: str) -> None:
    from kady_agent import projects

    paths = projects.resolve_paths(active_project)
    payload = {"doi:10.1/x": {"status": "verified", "title": "Hello"}}
    paths.save_citation_cache(payload)
    assert paths.load_citation_cache() == payload


def test_load_citation_cache_returns_empty_when_malformed(active_project: str) -> None:
    from kady_agent import projects

    paths = projects.resolve_paths(active_project)
    paths.citation_cache.parent.mkdir(parents=True, exist_ok=True)
    paths.citation_cache.write_text("{not json", encoding="utf-8")
    assert paths.load_citation_cache() == {}


def test_iter_user_visible_paths_filters_dotfiles(active_project: str) -> None:
    from kady_agent import projects

    paths = projects.resolve_paths(active_project)
    paths.sandbox.mkdir(parents=True, exist_ok=True)
    (paths.sandbox / ".hidden").write_text("nope", encoding="utf-8")
    (paths.sandbox / "visible.txt").write_text("hi", encoding="utf-8")

    names = {p.name for p in paths.iter_user_visible_paths()}
    assert "visible.txt" in names
    assert ".hidden" not in names


async def test_materialize_gemini_settings_writes_atomic_settings_json(
    active_project: str,
) -> None:
    from kady_agent import projects

    paths = projects.resolve_paths(active_project)
    settings_file = paths.gemini_settings_dir / "settings.json"
    if settings_file.exists():
        settings_file.unlink()

    await paths.materialize_gemini_settings()

    assert settings_file.is_file()
    import json
    parsed = json.loads(settings_file.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    assert "mcpServers" in parsed


# ---------------------------------------------------------------------------
# Structural invariant
# ---------------------------------------------------------------------------

# Allowed annotations for caller-supplied parameters on ProjectPaths methods.
# Anything outside this set indicates the method is leaking domain types into
# what should be path-bound I/O.
_ALLOWED_ANNOTATIONS = {
    Path,
    str,
    int,
    bool,
    bytes,
    float,
    dict,
    list,
    type(None),
}


def _is_allowed_annotation(annotation: object) -> bool:
    if annotation is inspect.Parameter.empty:
        # Untyped is permitted (legacy); we only flag explicit non-allowed types.
        return True
    origin = typing.get_origin(annotation)
    if origin is not None:
        # Generics: dict[str, Any], list[str], Optional[int], Iterator[Path] ...
        # Allow common containers. Walk args recursively.
        if origin in (dict, list, tuple, set, frozenset):
            return all(_is_allowed_annotation(a) for a in typing.get_args(annotation))
        if origin is typing.Union:
            return all(_is_allowed_annotation(a) for a in typing.get_args(annotation))
        # Iterator[Path] is fine on a return type but we apply this rule to
        # parameters only — the caller never passes one.
        return False
    if annotation in _ALLOWED_ANNOTATIONS:
        return True
    # `Any` is permitted only if explicitly used
    if annotation is typing.Any:
        return True
    return False


def test_project_paths_methods_only_take_plain_data() -> None:
    """No method on ProjectPaths may accept a callable, request/response, or domain object."""

    from kady_agent import projects

    offenders: list[str] = []
    for name, member in inspect.getmembers(projects.ProjectPaths, predicate=inspect.isfunction):
        if name.startswith("_"):
            continue
        try:
            hints = typing.get_type_hints(member)
        except (NameError, TypeError):
            # Unresolvable hints — treat as offender, surface the symbol
            offenders.append(f"{projects.ProjectPaths.__name__}.{name} (unresolvable hints)")
            continue
        sig = inspect.signature(member)
        for pname in sig.parameters:
            if pname in ("self", "return"):
                continue
            annotation = hints.get(pname, inspect.Parameter.empty)
            if not _is_allowed_annotation(annotation):
                offenders.append(
                    f"{projects.ProjectPaths.__name__}.{name}({pname}: {annotation!r})"
                )
    assert not offenders, (
        "ProjectPaths methods must accept only plain data (Path, str, int, bool, bytes, "
        f"dict, list, None). Offenders: {offenders}"
    )
