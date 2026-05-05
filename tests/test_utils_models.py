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


def test_search_and_update_models_json(tmp_path, monkeypatch) -> None:
    from kady_agent import utils

    models = [
        {
            "id": "anthropic/claude-opus-4.7",
            "name": "Anthropic: Claude Opus 4.7",
            "provider": "anthropic",
            "created": "2026-01-01",
            "context_length": 200_000,
            "modality": "text->text",
            "pricing": {"prompt_per_1m": 15.0, "completion_per_1m": 75.0},
            "description": "Flagship reasoning",
        },
        {
            "id": "google/gemini-flash",
            "name": "Google: Gemini Flash",
            "provider": "google",
            "created": "2026-01-01",
            "context_length": 1_000_000,
            "modality": "text->text",
            "pricing": {"prompt_per_1m": 0.25, "completion_per_1m": 1.0},
            "description": "Fast budget model",
        },
    ]
    monkeypatch.setattr(utils, "fetch_openrouter_models", lambda **kwargs: models)

    assert [m["id"] for m in utils.search_openrouter_models(query="flash")] == [
        "google/gemini-flash"
    ]
    assert [m["provider"] for m in utils.search_openrouter_models(providers=["google"])] == [
        "google"
    ]
    assert utils.search_openrouter_models(min_context=500_000)[0]["id"] == "google/gemini-flash"
    assert utils.search_openrouter_models(max_prompt_price=1.0)[0]["id"] == "google/gemini-flash"

    output = tmp_path / "models.json"
    utils.update_models_json(output_path=str(output), max_age_days=0)
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data[0]["id"] == "openrouter/anthropic/claude-opus-4.7"
    assert data[0]["default"] is True
    assert data[1]["tier"] == "budget"


def test_fetch_openrouter_models_requires_key(monkeypatch) -> None:
    from kady_agent import utils

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    try:
        utils.fetch_openrouter_models()
    except ValueError as exc:
        assert "No API key" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected ValueError")
