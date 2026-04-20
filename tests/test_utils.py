"""Unit tests for ``kady_agent/utils.py``.

Focus on pure-logic helpers (``list_skill_summaries``, ``format_skills_reference``,
``search_openrouter_models``, ``update_models_json``) with mocked data —
network-facing helpers (``fetch_openrouter_models``, ``download_scientific_skills``)
are mocked at the seams.
"""

from __future__ import annotations

import json
import subprocess
import types
from pathlib import Path

import pytest

from kady_agent import utils


def _seed_skill(dir: Path, name: str, description: str) -> None:
    dir.mkdir(parents=True, exist_ok=True)
    (dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nContent.\n",
        encoding="utf-8",
    )


def test_list_skill_summaries_reads_frontmatter(tmp_path: Path):
    _seed_skill(tmp_path / "skill-a", "skill-a", "First skill")
    _seed_skill(tmp_path / "skill-b", "skill-b", "Second skill")

    summaries = utils.list_skill_summaries(str(tmp_path))
    assert summaries == [
        {"name": "skill-a", "description": "First skill"},
        {"name": "skill-b", "description": "Second skill"},
    ]


def test_list_skill_summaries_handles_missing_dir(tmp_path: Path):
    assert utils.list_skill_summaries(str(tmp_path / "nope")) == []


def test_list_skill_summaries_skips_missing_frontmatter(tmp_path: Path):
    good = tmp_path / "good"
    good.mkdir()
    (good / "SKILL.md").write_text("---\nname: good\ndescription: ok\n---\n", encoding="utf-8")

    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "SKILL.md").write_text("no frontmatter here", encoding="utf-8")

    summaries = utils.list_skill_summaries(str(tmp_path))
    assert [s["name"] for s in summaries] == ["good"]


def test_list_skill_summaries_from_active_project(active_project):
    _seed_skill(active_project.gemini_settings_dir / "skills" / "alpha", "alpha", "x")
    summaries = utils.list_skill_summaries()
    assert summaries == [{"name": "alpha", "description": "x"}]


def test_format_skills_reference_empty():
    assert utils.format_skills_reference([]) == ""


def test_format_skills_reference_truncates_descriptions():
    long = "a" * 500
    out = utils.format_skills_reference([{"name": "long", "description": long}])
    assert "long" in out
    # truncation marker is three dots appended after 197 chars
    assert "..." in out
    assert len([ln for ln in out.splitlines() if ln.startswith("| `long`")]) == 1


def test_format_skills_reference_collapses_newlines():
    out = utils.format_skills_reference(
        [{"name": "n", "description": "line1\nline2"}]
    )
    assert "line1 line2" in out


def test_load_instructions_reads_file(tmp_path: Path, monkeypatch):
    # load_instructions uses a literal Path("kady_agent/instructions/..."),
    # so cd into a structured tmp cwd for this test.
    instructions = tmp_path / "kady_agent" / "instructions"
    instructions.mkdir(parents=True)
    (instructions / "demo.md").write_text("hello", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert utils.load_instructions("demo") == "hello"


# ---------------------------------------------------------------------------
# OpenRouter model helpers (mocked)
# ---------------------------------------------------------------------------


def _fake_model(id="anthropic/claude-opus-4.7", name="Anthropic: Claude Opus", context=200_000, prompt=3e-6, completion=15e-6, modality="text->text", created=1_700_000_000.0):
    return types.SimpleNamespace(
        id=id,
        name=name,
        created=created,
        context_length=context,
        architecture=types.SimpleNamespace(
            modality=modality,
            input_modalities=["text"],
            output_modalities=["text"],
        ),
        pricing=types.SimpleNamespace(prompt=str(prompt), completion=str(completion)),
        top_provider=types.SimpleNamespace(max_completion_tokens=8192),
        supported_parameters=["temperature"],
        description="A model.",
    )


class _FakeOpenRouter:
    """Context-manager impersonator for the openrouter.OpenRouter client."""

    def __init__(self, data):
        self._data = data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    @property
    def models(self):
        return types.SimpleNamespace(
            list=lambda: types.SimpleNamespace(data=self._data)
        )


def test_fetch_openrouter_models_requires_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(ValueError):
        utils.fetch_openrouter_models()


def test_fetch_openrouter_models_shapes_output(monkeypatch):
    fake_data = [_fake_model()]

    import openrouter as openrouter_pkg

    def fake_ctor(**kwargs):
        return _FakeOpenRouter(fake_data)

    monkeypatch.setattr(openrouter_pkg, "OpenRouter", fake_ctor)
    models = utils.fetch_openrouter_models(api_key="x")
    assert len(models) == 1
    m = models[0]
    assert m["id"] == "anthropic/claude-opus-4.7"
    assert m["provider"] == "anthropic"
    assert m["pricing"]["prompt_per_1m"] == pytest.approx(3.0)
    assert m["pricing"]["completion_per_1m"] == pytest.approx(15.0)
    assert m["modality"] == "text->text"


def test_search_openrouter_models_filters(monkeypatch):
    models = [
        {"id": "anthropic/claude-opus-4.7", "name": "Opus", "provider": "anthropic",
         "context_length": 200000, "modality": "text->text", "pricing": {"prompt_per_1m": 3.0, "completion_per_1m": 15.0}, "description": ""},
        {"id": "google/gemini-pro", "name": "Gemini", "provider": "google",
         "context_length": 100000, "modality": "text->text", "pricing": {"prompt_per_1m": 0.5, "completion_per_1m": 1.5}, "description": "google gemini"},
    ]
    monkeypatch.setattr(utils, "fetch_openrouter_models", lambda **kw: list(models))

    res = utils.search_openrouter_models(providers=["google"])
    assert len(res) == 1 and res[0]["provider"] == "google"

    res = utils.search_openrouter_models(min_context=150000)
    assert [m["id"] for m in res] == ["anthropic/claude-opus-4.7"]

    res = utils.search_openrouter_models(max_prompt_price=1.0)
    assert [m["id"] for m in res] == ["google/gemini-pro"]

    res = utils.search_openrouter_models(query="opus")
    assert [m["id"] for m in res] == ["anthropic/claude-opus-4.7"]

    res = utils.search_openrouter_models(query="gemini")
    # hits description for google row
    assert [m["id"] for m in res] == ["google/gemini-pro"]


def test_update_models_json_writes_normalized_entries(monkeypatch, tmp_path: Path):
    models = [
        {"id": "anthropic/claude-opus-4.7", "name": "Anthropic: Claude Opus",
         "provider": "anthropic", "context_length": 200000, "modality": "text->text",
         "pricing": {"prompt_per_1m": 3.0, "completion_per_1m": 15.0}, "description": ""},
        {"id": "budget/model", "name": "Budget: Tiny",
         "provider": "budget", "context_length": 4000, "modality": "text->text",
         "pricing": {"prompt_per_1m": 0.1, "completion_per_1m": 0.2}, "description": ""},
        {"id": "negative-price", "name": "Bad: X",
         "provider": "bad", "context_length": 1, "modality": "text->text",
         "pricing": {"prompt_per_1m": -1.0, "completion_per_1m": -1.0}, "description": ""},
    ]
    monkeypatch.setattr(utils, "fetch_openrouter_models", lambda **kw: list(models))

    out = tmp_path / "models.json"
    utils.update_models_json(
        output_path=str(out),
        default_model_id="anthropic/claude-opus-4.7",
        max_age_days=90,
    )
    data = json.loads(out.read_text())
    ids = [e["id"] for e in data]
    # negative pricing entry dropped
    assert "openrouter/negative-price" not in ids
    assert "openrouter/anthropic/claude-opus-4.7" in ids
    assert any(e.get("default") for e in data)
    # flagship tier sorts before budget
    tiers = [e["tier"] for e in data]
    assert tiers.index("high") < tiers.index("budget")


# ---------------------------------------------------------------------------
# download_scientific_skills shells out; we patch subprocess.run
# ---------------------------------------------------------------------------


def test_download_scientific_skills_copies_from_mocked_clone(
    tmp_path, monkeypatch
):
    target = tmp_path / "skills"

    def fake_run(args, *a, **kw):
        # Simulate `git clone` by laying down a fake working tree where
        # git would have cloned the repo (the last positional argument).
        clone_dir = Path(args[-1])
        (clone_dir / "scientific-skills" / "stats").mkdir(parents=True)
        (clone_dir / "scientific-skills" / "stats" / "SKILL.md").write_text(
            "---\nname: stats\ndescription: d\n---\n", encoding="utf-8"
        )
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    utils.download_scientific_skills(target_dir=str(target))
    assert (target / "stats" / "SKILL.md").is_file()


def test_download_scientific_skills_raises_when_git_fails(
    tmp_path, monkeypatch
):
    def fake_run(args, *a, **kw):
        raise subprocess.CalledProcessError(1, args, stderr="boom")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(subprocess.CalledProcessError):
        utils.download_scientific_skills(target_dir=str(tmp_path))
