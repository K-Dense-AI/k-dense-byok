"""Tests for kady_agent.utils — instruction loading, model helpers."""

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from kady_agent.utils import (
    _model_label,
    _pricing_tier,
    _provider_label,
    load_instructions,
    search_openrouter_models,
)


# ---------------------------------------------------------------------------
# load_instructions
# ---------------------------------------------------------------------------


class TestLoadInstructions:
    def test_loads_existing_file(self, tmp_path, monkeypatch):
        instructions_dir = tmp_path / "kady_agent" / "instructions"
        instructions_dir.mkdir(parents=True)
        (instructions_dir / "test_agent.md").write_text("You are a test agent.")
        monkeypatch.chdir(tmp_path)
        result = load_instructions("test_agent")
        assert result == "You are a test agent."

    def test_missing_file_raises(self, tmp_path, monkeypatch):
        instructions_dir = tmp_path / "kady_agent" / "instructions"
        instructions_dir.mkdir(parents=True)
        monkeypatch.chdir(tmp_path)
        with pytest.raises(FileNotFoundError):
            load_instructions("nonexistent")


# ---------------------------------------------------------------------------
# _provider_label
# ---------------------------------------------------------------------------


class TestProviderLabel:
    @pytest.mark.parametrize(
        "slug, expected",
        [
            ("openai", "OpenAI"),
            ("anthropic", "Anthropic"),
            ("google", "Google"),
            ("meta-llama", "Meta"),
            ("deepseek", "DeepSeek"),
            ("x-ai", "xAI"),
            ("mistralai", "Mistral"),
            ("unknown-provider", "Unknown Provider"),
        ],
    )
    def test_known_and_unknown(self, slug, expected):
        assert _provider_label(slug) == expected


# ---------------------------------------------------------------------------
# _model_label
# ---------------------------------------------------------------------------


class TestModelLabel:
    def test_strips_known_prefix(self):
        result = _model_label("OpenAI: GPT-4o", "openai")
        assert result == "GPT-4o"

    def test_strips_provider_slug_prefix(self):
        result = _model_label("openai/gpt-4o", "openai")
        assert result == "gpt-4o"

    def test_no_prefix_returns_as_is(self):
        result = _model_label("My Model Name", "openai")
        assert result == "My Model Name"


# ---------------------------------------------------------------------------
# _pricing_tier
# ---------------------------------------------------------------------------


class TestPricingTier:
    @pytest.mark.parametrize(
        "price, expected",
        [
            (0.0, "budget"),
            (0.49, "budget"),
            (0.50, "mid"),
            (1.99, "mid"),
            (2.00, "high"),
            (4.99, "high"),
            (5.00, "flagship"),
            (100.0, "flagship"),
        ],
    )
    def test_boundary_values(self, price, expected):
        assert _pricing_tier(price) == expected


# ---------------------------------------------------------------------------
# search_openrouter_models (with mocked fetch)
# ---------------------------------------------------------------------------


class TestSearchOpenrouterModels:
    SAMPLE_MODELS = [
        {
            "id": "google/gemini-pro",
            "name": "Gemini Pro",
            "provider": "google",
            "created": "2025-01-01",
            "context_length": 32768,
            "modality": "text->text",
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "pricing": {"prompt_per_1m": 1.25, "completion_per_1m": 5.0},
            "max_completion_tokens": 8192,
            "supported_parameters": [],
            "description": "Google Gemini Pro",
        },
        {
            "id": "anthropic/claude-3",
            "name": "Claude 3",
            "provider": "anthropic",
            "created": "2025-06-01",
            "context_length": 200000,
            "modality": "text->text",
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "pricing": {"prompt_per_1m": 3.0, "completion_per_1m": 15.0},
            "max_completion_tokens": 4096,
            "supported_parameters": [],
            "description": "Anthropic Claude 3",
        },
        {
            "id": "openai/gpt-4o-mini",
            "name": "GPT-4o Mini",
            "provider": "openai",
            "created": "2025-03-15",
            "context_length": 128000,
            "modality": "text->text",
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "pricing": {"prompt_per_1m": 0.15, "completion_per_1m": 0.60},
            "max_completion_tokens": 16384,
            "supported_parameters": [],
            "description": "OpenAI GPT-4o Mini",
        },
    ]

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_filter_by_provider(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(providers=["google"])
        assert len(results) == 1
        assert results[0]["provider"] == "google"

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_filter_by_query(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(query="claude")
        assert len(results) == 1
        assert "Claude" in results[0]["name"]

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_filter_by_min_context(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(min_context=100000)
        assert all(m["context_length"] >= 100000 for m in results)

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_filter_by_max_prompt_price(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(max_prompt_price=1.0)
        assert all(m["pricing"]["prompt_per_1m"] <= 1.0 for m in results)

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_filter_by_modality(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(modality="text->text")
        assert len(results) == 3

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_combined_filters(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(
            providers=["openai", "google"], min_context=30000
        )
        assert len(results) == 2

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_no_results(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_MODELS
        results = search_openrouter_models(query="nonexistent-model-xyz")
        assert results == []


# ---------------------------------------------------------------------------
# download_scientific_skills
# ---------------------------------------------------------------------------


class TestDownloadScientificSkills:
    """Tests for download_scientific_skills — git clone + copy skill dirs."""

    @patch("kady_agent.utils.subprocess.run")
    def test_successful_download(self, mock_run, tmp_path):
        """Happy path: clone succeeds, skill dirs copied to target."""
        # Set up fake cloned repo with skill subdirectories
        source_dir = tmp_path / "fake_repo" / "scientific-skills"
        source_dir.mkdir(parents=True)
        (source_dir / "skill-a").mkdir()
        (source_dir / "skill-a" / "manifest.json").write_text("{}")
        (source_dir / "skill-b").mkdir()
        (source_dir / "skill-b" / "manifest.json").write_text("{}")
        # Also a file (not a dir) — should be skipped
        (source_dir / "readme.txt").write_text("not a skill dir")

        # Make subprocess.run a no-op (we patched it)
        mock_run.return_value = None

        # Patch tempfile.TemporaryDirectory to use our fake repo dir
        fake_temp = str(tmp_path / "fake_repo")
        target = str(tmp_path / "output_skills")

        with patch("kady_agent.utils.tempfile.TemporaryDirectory") as mock_tmpdir:
            mock_tmpdir.return_value.__enter__ = lambda s: fake_temp
            mock_tmpdir.return_value.__exit__ = lambda s, *args: None
            from kady_agent.utils import download_scientific_skills

            download_scientific_skills(
                target_dir=target, source_path="scientific-skills"
            )

        # Should have copied the two skill dirs
        assert (Path(target) / "skill-a").is_dir()
        assert (Path(target) / "skill-b").is_dir()
        assert (Path(target) / "skill-a" / "manifest.json").read_text() == "{}"
        # File (non-dir) should NOT have been copied
        assert not (Path(target) / "readme.txt").exists()

    @patch("kady_agent.utils.subprocess.run")
    def test_source_path_not_found_raises(self, mock_run, tmp_path):
        """FileNotFoundError when source_path doesn't exist in cloned repo."""
        fake_temp = tmp_path / "fake_repo"
        fake_temp.mkdir()
        # No scientific-skills dir created

        mock_run.return_value = None
        target = str(tmp_path / "output_skills")

        with patch("kady_agent.utils.tempfile.TemporaryDirectory") as mock_tmpdir:
            mock_tmpdir.return_value.__enter__ = lambda s: str(fake_temp)
            mock_tmpdir.return_value.__exit__ = lambda s, *args: None
            from kady_agent.utils import download_scientific_skills

            with pytest.raises(FileNotFoundError, match="Source path"):
                download_scientific_skills(
                    target_dir=target, source_path="nonexistent-path"
                )

    def test_subprocess_error_raises(self, tmp_path):
        """CalledProcessError from git clone propagates."""
        import subprocess

        def _raise_called_process_error(*args, **kwargs):
            raise subprocess.CalledProcessError(
                128, "git", stderr="fatal: repo not found"
            )

        target = str(tmp_path / "output_skills")
        with patch(
            "kady_agent.utils.subprocess.run", side_effect=_raise_called_process_error
        ):
            from kady_agent.utils import download_scientific_skills

            with pytest.raises(subprocess.CalledProcessError):
                download_scientific_skills(target_dir=target)

    @patch("kady_agent.utils.subprocess.run")
    def test_overwrites_existing_skill_dir(self, mock_run, tmp_path):
        """Existing skill dirs in target are replaced."""
        source_dir = tmp_path / "fake_repo" / "scientific-skills"
        source_dir.mkdir(parents=True)
        (source_dir / "my-skill").mkdir()
        (source_dir / "my-skill" / "new.txt").write_text("new content")

        target = tmp_path / "output_skills"
        target.mkdir()
        existing = target / "my-skill"
        existing.mkdir()
        (existing / "old.txt").write_text("old content")

        mock_run.return_value = None
        with patch("kady_agent.utils.tempfile.TemporaryDirectory") as mock_tmpdir:
            mock_tmpdir.return_value.__enter__ = lambda s: str(tmp_path / "fake_repo")
            mock_tmpdir.return_value.__exit__ = lambda s, *args: None
            from kady_agent.utils import download_scientific_skills

            download_scientific_skills(
                target_dir=str(target), source_path="scientific-skills"
            )

        # Old file gone, new file present
        assert not (target / "my-skill" / "old.txt").exists()
        assert (target / "my-skill" / "new.txt").read_text() == "new content"


# ---------------------------------------------------------------------------
# fetch_openrouter_models
# ---------------------------------------------------------------------------


class TestFetchOpenrouterModels:
    """Tests for fetch_openrouter_models — SDK call + parsing."""

    def _make_mock_model(self, **overrides):
        """Build a lightweight mock model object matching SDK shape."""
        defaults = {
            "id": "google/gemini-pro",
            "name": "Gemini Pro",
            "created": 1735689600.0,  # 2025-01-01
            "context_length": 32768,
            "pricing.prompt": "0.00000125",  # $1.25/1M
            "pricing.completion": "0.000005",  # $5.00/1M
            "architecture.modality": "text->text",
            "architecture.input_modalities": ["text"],
            "architecture.output_modalities": ["text"],
            "top_provider.max_completion_tokens": 8192,
            "supported_parameters": ["temperature"],
            "description": "A model",
        }
        defaults.update(overrides)

        class _Arch:
            modality = defaults["architecture.modality"]
            input_modalities = defaults["architecture.input_modalities"]
            output_modalities = defaults["architecture.output_modalities"]

        class _Pricing:
            prompt = defaults["pricing.prompt"]
            completion = defaults["pricing.completion"]

        class _TopProvider:
            max_completion_tokens = defaults["top_provider.max_completion_tokens"]

        class _Model:
            id = defaults["id"]
            name = defaults["name"]
            created = defaults["created"]
            context_length = defaults["context_length"]
            pricing = _Pricing()
            architecture = _Arch()
            top_provider = _TopProvider()
            supported_parameters = defaults["supported_parameters"]
            description = defaults["description"]

        return _Model()

    def test_no_api_key_raises_value_error(self, monkeypatch):
        """ValueError when no API key provided and env var not set."""
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        from kady_agent.utils import fetch_openrouter_models

        with pytest.raises(ValueError, match="No API key"):
            fetch_openrouter_models()

    @patch("openrouter.OpenRouter")
    def test_empty_response_returns_empty_list(self, mock_or_cls):
        """Empty or None response from SDK returns []."""
        mock_client = mock_or_cls.return_value.__enter__.return_value
        mock_client.models.list.return_value = None

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="test-key")
        assert result == []

    @patch("openrouter.OpenRouter")
    def test_empty_data_returns_empty_list(self, mock_or_cls):
        """Response with empty .data returns []."""
        mock_client = mock_or_cls.return_value.__enter__.return_value

        class _Res:
            data = []

        mock_client.models.list.return_value = _Res()

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k")
        assert result == []

    @patch("openrouter.OpenRouter")
    def test_parses_model_fields(self, mock_or_cls):
        """Verify dict field extraction from SDK model objects."""
        mock_client = mock_or_cls.return_value.__enter__.return_value
        m = self._make_mock_model()
        res = type("Res", (), {"data": [m]})()
        mock_client.models.list.return_value = res

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k")

        assert len(result) == 1
        entry = result[0]
        assert entry["id"] == "google/gemini-pro"
        assert entry["provider"] == "google"
        assert entry["context_length"] == 32768
        assert entry["modality"] == "text->text"
        assert entry["pricing"]["prompt_per_1m"] == 1.25
        assert entry["pricing"]["completion_per_1m"] == 5.0
        assert entry["input_modalities"] == ["text"]
        assert entry["output_modalities"] == ["text"]
        assert entry["supported_parameters"] == ["temperature"]
        assert entry["description"] == "A model"

    @patch("openrouter.OpenRouter")
    def test_max_age_days_filters_old_models(self, mock_or_cls):
        """Models older than max_age_days are excluded."""
        mock_client = mock_or_cls.return_value.__enter__.return_value
        # One recent, one very old
        recent = self._make_mock_model(
            id="recent/model", created=datetime.now(timezone.utc).timestamp() - 100
        )
        old = self._make_mock_model(id="old/model", created=1_000_000.0)  # 1970
        res = type("Res", (), {"data": [recent, old]})()
        mock_client.models.list.return_value = res

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k", max_age_days=30)
        assert len(result) == 1
        assert result[0]["id"] == "recent/model"

    @patch("openrouter.OpenRouter")
    def test_model_without_architecture(self, mock_or_cls):
        """Model with no architecture field defaults gracefully."""
        mock_client = mock_or_cls.return_value.__enter__.return_value

        class _Model:
            id = "unknown/model"
            name = "M"
            created = 1735689600.0
            context_length = 4096

            class _Pricing:
                prompt = "0"
                completion = "0"

            pricing = _Pricing()
            architecture = None
            top_provider = None
            supported_parameters = []
            description = None

        res = type("Res", (), {"data": [_Model()]})()
        mock_client.models.list.return_value = res

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k")
        assert len(result) == 1
        assert result[0]["modality"] is None
        assert result[0]["input_modalities"] == []
        assert result[0]["output_modalities"] == []
        assert result[0]["max_completion_tokens"] is None

    @patch("openrouter.OpenRouter")
    def test_provider_extracted_from_id(self, mock_or_cls):
        """Provider is extracted from id's prefix before '/'."""
        mock_client = mock_or_cls.return_value.__enter__.return_value
        m = self._make_mock_model(id="nvidia/llama-3")
        res = type("Res", (), {"data": [m]})()
        mock_client.models.list.return_value = res

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k")
        assert result[0]["provider"] == "nvidia"

    @patch("openrouter.OpenRouter")
    def test_no_slash_in_id_gives_unknown_provider(self, mock_or_cls):
        """Model id without '/' gets provider='unknown'."""
        mock_client = mock_or_cls.return_value.__enter__.return_value
        m = self._make_mock_model(id="bare-model")
        res = type("Res", (), {"data": [m]})()
        mock_client.models.list.return_value = res

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k")
        assert result[0]["provider"] == "unknown"

    @patch("openrouter.OpenRouter")
    def test_results_sorted_by_name(self, mock_or_cls):
        """Output is sorted by name."""
        mock_client = mock_or_cls.return_value.__enter__.return_value
        m1 = self._make_mock_model(id="z/last", name="Zeta")
        m2 = self._make_mock_model(id="a/first", name="Alpha")
        res = type("Res", (), {"data": [m1, m2]})()
        mock_client.models.list.return_value = res

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models(api_key="k")
        assert result[0]["name"] == "Alpha"
        assert result[1]["name"] == "Zeta"

    @patch("openrouter.OpenRouter")
    def test_env_var_fallback(self, mock_or_cls, monkeypatch):
        """API key falls back to OPENROUTER_API_KEY env var."""
        monkeypatch.setenv("OPENROUTER_API_KEY", "env-key")
        mock_client = mock_or_cls.return_value.__enter__.return_value

        class _Res:
            data = []

        mock_client.models.list.return_value = _Res()

        from kady_agent.utils import fetch_openrouter_models

        result = fetch_openrouter_models()
        assert result == []
        # Verify the client was created with the env key
        mock_or_cls.assert_called_once_with(api_key="env-key")


# ---------------------------------------------------------------------------
# print_openrouter_models
# ---------------------------------------------------------------------------


class TestPrintOpenrouterModels:
    """Tests for print_openrouter_models — stdout table output."""

    SAMPLE_MODELS = [
        {
            "id": "openai/gpt-4o",
            "name": "GPT-4o",
            "context_length": 128000,
            "pricing": {"prompt_per_1m": 2.50, "completion_per_1m": 10.00},
        },
        {
            "id": "google/gemini-flash",
            "name": "Gemini Flash",
            "context_length": 1000000,
            "pricing": {"prompt_per_1m": 0.075, "completion_per_1m": 0.30},
        },
    ]

    def test_prints_table_header_and_rows(self, capsys):
        """Output includes header separator and model rows."""
        from kady_agent.utils import print_openrouter_models

        print_openrouter_models(models=self.SAMPLE_MODELS)
        captured = capsys.readouterr()

        assert "ID" in captured.out
        assert "---" in captured.out
        assert "openai/gpt-4o" in captured.out
        assert "GPT-4o" in captured.out
        assert "128,000" in captured.out
        assert "2.50" in captured.out
        assert "10.00" in captured.out
        assert "google/gemini-flash" in captured.out

    @patch("kady_agent.utils.search_openrouter_models")
    def test_calls_search_when_models_none(self, mock_search, capsys):
        """When models=None, delegates to search_openrouter_models with kwargs."""
        mock_search.return_value = []
        from kady_agent.utils import print_openrouter_models

        print_openrouter_models(query="test", providers=["google"])
        mock_search.assert_called_once_with(query="test", providers=["google"])

    def test_handles_none_name(self, capsys):
        """Model with name=None still prints (empty string in name column)."""
        from kady_agent.utils import print_openrouter_models

        models = [
            {
                "id": "some/model",
                "name": None,
                "context_length": 4096,
                "pricing": {"prompt_per_1m": 0.0, "completion_per_1m": 0.0},
            }
        ]
        print_openrouter_models(models=models)
        captured = capsys.readouterr()
        assert "some/model" in captured.out

    def test_empty_list_prints_only_header(self, capsys):
        """Empty model list prints header but no data rows."""
        from kady_agent.utils import print_openrouter_models

        print_openrouter_models(models=[])
        captured = capsys.readouterr()
        lines = [ln for ln in captured.out.strip().split("\n") if ln.strip()]
        # Header line + separator line = 2 lines
        assert len(lines) == 2


# ---------------------------------------------------------------------------
# update_models_json
# ---------------------------------------------------------------------------


class TestUpdateModelsJson:
    """Tests for update_models_json — file write, filtering, sorting."""

    RAW_MODELS = [
        {
            "id": "google/gemini-3.1-pro-preview",
            "name": "Gemini 3.1 Pro",
            "provider": "google",
            "context_length": 1000000,
            "modality": "text->text",
            "description": "Google's best",
            "pricing": {"prompt_per_1m": 1.25, "completion_per_1m": 5.0},
        },
        {
            "id": "openai/gpt-4o-mini",
            "name": "GPT-4o Mini",
            "provider": "openai",
            "context_length": 128000,
            "modality": "text->text",
            "description": "Small and fast",
            "pricing": {"prompt_per_1m": 0.15, "completion_per_1m": 0.60},
        },
        {
            "id": "anthropic/claude-opus",
            "name": "Claude Opus",
            "provider": "anthropic",
            "context_length": 200000,
            "modality": "text->text",
            "description": "Powerful",
            "pricing": {"prompt_per_1m": 15.0, "completion_per_1m": 75.0},
        },
        {
            "id": "fake/negative-price",
            "name": "Bad Model",
            "provider": "fake",
            "context_length": 4096,
            "modality": "text->text",
            "description": "Should be excluded",
            "pricing": {"prompt_per_1m": -1.0, "completion_per_1m": 5.0},
        },
        {
            "id": "fake/negative-completion",
            "name": "Also Bad",
            "provider": "fake",
            "context_length": 4096,
            "modality": "text->text",
            "description": "Negative completion",
            "pricing": {"prompt_per_1m": 1.0, "completion_per_1m": -0.5},
        },
    ]

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_writes_json_file(self, mock_fetch, tmp_path):
        """Writes a valid JSON file with model entries."""
        mock_fetch.return_value = self.RAW_MODELS[:2]  # gemini + gpt-mini
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(
            output_path=str(out_file),
            api_key="k",
            default_model_id="google/gemini-3.1-pro-preview",
        )

        assert out_file.exists()
        data = json.loads(out_file.read_text())
        assert len(data) == 2
        assert all("id" in e for e in data)

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_negative_prices_excluded(self, mock_fetch, tmp_path):
        """Models with negative prompt or completion prices are excluded."""
        mock_fetch.return_value = self.RAW_MODELS  # includes negative entries
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), api_key="k")

        data = json.loads(out_file.read_text())
        ids = [e["id"] for e in data]
        assert "openrouter/fake/negative-price" not in ids
        assert "openrouter/fake/negative-completion" not in ids

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_default_model_marked(self, mock_fetch, tmp_path):
        """The default_model_id gets a 'default': True field."""
        mock_fetch.return_value = self.RAW_MODELS[:3]
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(
            output_path=str(out_file),
            default_model_id="google/gemini-3.1-pro-preview",
            api_key="k",
        )

        data = json.loads(out_file.read_text())
        defaults = [e for e in data if e.get("default")]
        assert len(defaults) == 1
        assert "gemini-3.1-pro-preview" in defaults[0]["id"]

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_tier_ordering(self, mock_fetch, tmp_path):
        """Entries sorted by tier (flagship > high > mid > budget) then by context desc."""
        mock_fetch.return_value = self.RAW_MODELS[:3]
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), api_key="k")

        data = json.loads(out_file.read_text())
        tiers = [e["tier"] for e in data]
        # flagship (anthropic $15) should come before mid (google $1.25) before budget (openai $0.15)
        tier_order = {"flagship": 0, "high": 1, "mid": 2, "budget": 3}
        tier_ranks = [tier_order[t] for t in tiers]
        assert tier_ranks == sorted(tier_ranks)

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_id_prefixed_with_openrouter(self, mock_fetch, tmp_path):
        """All model IDs are prefixed with 'openrouter/'."""
        mock_fetch.return_value = [self.RAW_MODELS[0]]
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), api_key="k")

        data = json.loads(out_file.read_text())
        assert data[0]["id"] == "openrouter/google/gemini-3.1-pro-preview"

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_creates_parent_directories(self, mock_fetch, tmp_path):
        """Output path's parent dirs are created if missing."""
        mock_fetch.return_value = []
        out_file = tmp_path / "deep" / "nested" / "dir" / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), api_key="k")

        assert out_file.exists()

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_description_none_becomes_empty_string(self, mock_fetch, tmp_path):
        """Model with description=None gets empty string in output."""
        model = dict(self.RAW_MODELS[0])
        model["description"] = None
        mock_fetch.return_value = [model]
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), api_key="k")

        data = json.loads(out_file.read_text())
        assert data[0]["description"] == ""

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_max_age_days_zero_means_all(self, mock_fetch, tmp_path):
        """max_age_days=0 is treated as None (include all models)."""
        mock_fetch.return_value = [self.RAW_MODELS[0]]
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), max_age_days=0, api_key="k")

        # Should pass max_age_days=None to fetch_openrouter_models
        mock_fetch.assert_called_once_with(api_key="k", max_age_days=None)

    @patch("kady_agent.utils.fetch_openrouter_models")
    def test_prints_count(self, mock_fetch, tmp_path, capsys):
        """Prints the count of written models."""
        mock_fetch.return_value = self.RAW_MODELS[:2]
        out_file = tmp_path / "models.json"

        from kady_agent.utils import update_models_json

        update_models_json(output_path=str(out_file), api_key="k")

        captured = capsys.readouterr()
        assert "wrote 2 models" in captured.out


# ---------------------------------------------------------------------------
# _PROVIDER_ALIASES coverage (additional edge cases)
# ---------------------------------------------------------------------------


class TestProviderAliasesExtended:
    """Cover aliases not tested in the parametrized block."""

    @pytest.mark.parametrize(
        "slug, expected",
        [
            ("cohere", "Cohere"),
            ("nvidia", "NVIDIA"),
            ("qwen", "Qwen"),
            ("amazon", "Amazon"),
            ("microsoft", "Microsoft"),
            ("minimax", "MiniMax"),
        ],
    )
    def test_additional_known_providers(self, slug, expected):
        from kady_agent.utils import _provider_label

        assert _provider_label(slug) == expected

    def test_unknown_slug_with_multiple_hyphens(self):
        from kady_agent.utils import _provider_label

        assert _provider_label("some-brand-new-ai") == "Some Brand New Ai"


# ---------------------------------------------------------------------------
# _model_label extended
# ---------------------------------------------------------------------------


class TestModelLabelExtended:
    def test_strips_display_label_prefix(self):
        """Strips 'DisplayLabel: ' prefix for providers with custom labels."""
        from kady_agent.utils import _model_label

        # meta-llama maps to "Meta" display label
        result = _model_label("Meta: Llama 3", "meta-llama")
        assert result == "Llama 3"

    def test_strips_slug_colon_prefix(self):
        """Strips 'slug: ' prefix."""
        from kady_agent.utils import _model_label

        result = _model_label("anthropic: Claude 3", "anthropic")
        assert result == "Claude 3"

    def test_no_matching_prefix_returns_original(self):
        """When no prefix matches, original name is returned."""
        from kady_agent.utils import _model_label

        result = _model_label("Custom Model X", "google")
        assert result == "Custom Model X"
