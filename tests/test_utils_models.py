from __future__ import annotations

import json


def test_skill_summaries_and_reference_format(tmp_path) -> None:
    from kady_agent import utils

    skill = tmp_path / "alpha"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: Alpha\ndescription: Does alpha work\n---\n\nBody",
        encoding="utf-8",
    )
    (tmp_path / "ignored").mkdir()

    summaries = utils.list_skill_summaries(str(tmp_path))
    assert summaries == [{"name": "Alpha", "description": "Does alpha work"}]
    rendered = utils.format_skills_reference(summaries)
    assert "| `Alpha` | Does alpha work |" in rendered
    assert utils.format_skills_reference([]) == ""


def test_skill_summaries_fall_back_when_frontmatter_yaml_invalid(tmp_path) -> None:
    from kady_agent import utils

    skill = tmp_path / "research-lookup"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: research-lookup\ndescription: Note: has a colon\n---\n",
        encoding="utf-8",
    )

    summaries = utils.list_skill_summaries(str(tmp_path))
    assert summaries == [{"name": "research-lookup", "description": ""}]


def test_copy_skill_catalogue_respects_replace_existing(tmp_path) -> None:
    from kady_agent import utils

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    for name in ("alpha", "beta"):
        (source / name).mkdir()
        (source / name / "SKILL.md").write_text("---\nname: x\n---\n", encoding="utf-8")
    (target / "alpha").mkdir()
    (target / "alpha" / "SKILL.md").write_text("stale", encoding="utf-8")

    added = utils._copy_skill_catalogue(source, target, replace_existing=False)
    assert added == 1
    assert (target / "beta" / "SKILL.md").is_file()
    assert (target / "alpha" / "SKILL.md").read_text(encoding="utf-8") == "stale"

    replaced = utils._copy_skill_catalogue(source, target, replace_existing=True)
    assert replaced == 2
    assert "name: x" in (target / "alpha" / "SKILL.md").read_text(encoding="utf-8")


def test_search_and_update_models_json(tmp_path, monkeypatch) -> None:
    from kady_agent import utils

    models = [
        {
            "id": "anthropic/claude-opus-4.8",
            "name": "Anthropic: Claude Opus 4.8",
            "provider": "anthropic",
            "created": "2026-01-01",
            "context_length": 1_000_000,
            "modality": "text->text",
            "pricing": {"prompt_per_1m": 5.0, "completion_per_1m": 25.0},
            "description": "Flagship reasoning",
        },
        {
            "id": "google/gemini-3.5-flash",
            "name": "Google: Gemini 3.5 Flash",
            "provider": "google",
            "created": "2026-01-01",
            "context_length": 1_000_000,
            "modality": "text->text",
            "pricing": {"prompt_per_1m": 1.5, "completion_per_1m": 9.0},
            "description": "Fast budget model",
        },
        {
            "id": "google/gemini-3.1-pro-preview",
            "name": "Google: Gemini 3.1 Pro Preview",
            "provider": "google",
            "created": "2026-01-01",
            "context_length": 1_000_000,
            "modality": "text->text",
            "pricing": {"prompt_per_1m": 2.0, "completion_per_1m": 12.0},
            "description": "Expert default model",
        },
        {
            "id": "openai/gpt-5.4",
            "name": "OpenAI: GPT-5.4",
            "provider": "openai",
            "created": "2026-01-01",
            "context_length": 1_000_000,
            "modality": "text->text",
            "pricing": {"prompt_per_1m": 2.5, "completion_per_1m": 15.0},
            "description": "Retired model",
        },
    ]
    fetch_kwargs = {}

    def fake_fetch_openrouter_models(**kwargs):
        fetch_kwargs.update(kwargs)
        return models

    monkeypatch.setattr(utils, "fetch_openrouter_models", fake_fetch_openrouter_models)

    assert [m["id"] for m in utils.search_openrouter_models(query="flash")] == [
        "google/gemini-3.5-flash"
    ]
    assert [m["provider"] for m in utils.search_openrouter_models(providers=["google"])] == [
        "google",
        "google",
    ]
    assert utils.search_openrouter_models(min_context=500_000)[0]["id"] == "anthropic/claude-opus-4.8"
    assert utils.search_openrouter_models(max_prompt_price=2.0)[0]["id"] == "google/gemini-3.5-flash"

    output = tmp_path / "models.json"
    utils.update_models_json(output_path=str(output), max_age_days=0)
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data[0]["id"] == "openrouter/anthropic/claude-opus-4.8"
    assert data[0]["default"] is True
    assert "openrouter/openai/gpt-5.4" not in {m["id"] for m in data}
    assert fetch_kwargs["supported_parameters"] == "tools"
    assert any(
        m["id"] == "openrouter/google/gemini-3.5-flash" and m["expertDefault"]
        for m in data
    )


def test_fetch_openrouter_models_requires_key(monkeypatch) -> None:
    from kady_agent import utils

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    try:
        utils.fetch_openrouter_models()
    except ValueError as exc:
        assert "No API key" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected ValueError")
