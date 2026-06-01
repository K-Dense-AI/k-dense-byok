import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import yaml

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


def load_instructions(agent_name: str) -> str:
    """Load instructions from a markdown file in the instructions directory."""
    instructions_path = Path("kady_agent/instructions") / f"{agent_name}.md"
    return instructions_path.read_text(encoding="utf-8")


def list_skill_summaries(skills_dir: str | None = None) -> list[dict]:
    """Read skill name and description from each SKILL.md frontmatter.

    Returns a list of ``{"name": ..., "description": ...}`` dicts sorted by
    name, suitable for injecting into the orchestrator's instruction as a
    reference catalogue. When ``skills_dir`` is omitted, resolves to the
    active project's ``sandbox/.gemini/skills``.
    """
    if skills_dir is None:
        from .projects import active_paths
        skills_path = active_paths().gemini_settings_dir / "skills"
    else:
        skills_path = Path(skills_dir)
    if not skills_path.is_dir():
        return []

    summaries: list[dict] = []
    for child in sorted(skills_path.iterdir(), key=lambda p: p.name.lower()):
        skill_file = child / "SKILL.md"
        if not child.is_dir() or not skill_file.is_file():
            continue
        try:
            text = skill_file.read_text(encoding="utf-8", errors="replace")
            match = _FRONTMATTER_RE.match(text)
            if not match:
                continue
            try:
                meta = yaml.safe_load(match.group(1)) or {}
            except yaml.YAMLError:
                meta = {}
            summaries.append({
                "name": meta.get("name", child.name),
                "description": meta.get("description", ""),
            })
        except Exception:
            continue
    return summaries


def format_skills_reference(skills: list[dict]) -> str:
    """Format a skill list into a compact markdown reference block."""
    if not skills:
        return ""

    lines = [
        "",
        "## Available expert skills — reference only",
        "",
        "The following skills are installed on the expert (Gemini CLI) that runs "
        "inside `delegate_task`. **You (Kady) MUST NOT attempt to activate, call, "
        "or use these skills yourself.** They exist here ONLY so you can:",
        "",
        "1. Recognize when a user mentions a skill by name.",
        "2. Pass the skill name verbatim in the `delegate_task` prompt.",
        "3. Match user requests to the most relevant skill(s) even when the user "
        "does not name one explicitly, and instruct the expert to use the "
        "skill in your `delegate_task` prompt.",
        "",
        "| Skill name | Description |",
        "|---|---|",
    ]
    for s in skills:
        desc = (s["description"] or "").replace("\n", " ").strip()
        if len(desc) > 200:
            desc = desc[:197] + "..."
        lines.append(f"| `{s['name']}` | {desc} |")

    lines.append("")
    return "\n".join(lines)


def _resolve_skills_target(target_dir: str | None) -> Path:
    if target_dir is None:
        from .projects import active_paths
        return active_paths().gemini_settings_dir / "skills"
    return Path(target_dir)


def _clone_scientific_skills_repo(
    *,
    github_repo: str = "K-Dense-AI/scientific-agent-skills",
    source_path: str = "skills",
    branch: str = "main",
) -> Path:
    """Shallow-clone the skills repo and return the path to its ``skills/`` folder."""
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        repo_url = f"https://github.com/{github_repo}.git"
        print("Cloning Scientific Agent Skills repository (this may take a moment)...")
        subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", branch, repo_url, str(temp_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        source_dir = temp_path / source_path
        if not source_dir.is_dir():
            raise FileNotFoundError(
                f"Source path '{source_path}' not found in repository"
            )
        # Copy into a second temp dir so the clone root survives after this
        # context manager exits.
        staging = Path(tempfile.mkdtemp(prefix="kady-skills-"))
        shutil.copytree(source_dir, staging / source_path)
        return staging / source_path


def _copy_skill_catalogue(
    source_dir: Path,
    target_path: Path,
    *,
    replace_existing: bool,
) -> int:
    """Copy skill subdirectories from ``source_dir`` into ``target_path``."""
    target_path.mkdir(parents=True, exist_ok=True)
    skill_count = 0
    for skill_dir in sorted(source_dir.iterdir(), key=lambda p: p.name.lower()):
        if not skill_dir.is_dir():
            continue
        dest_dir = target_path / skill_dir.name
        if dest_dir.exists():
            if not replace_existing:
                continue
            shutil.rmtree(dest_dir)
        shutil.copytree(skill_dir, dest_dir)
        print(f"  ✓ {skill_dir.name}")
        skill_count += 1
    return skill_count


def download_scientific_skills(
    target_dir: str | None = None,
    github_repo: str = "K-Dense-AI/scientific-agent-skills",
    source_path: str = "skills",
    branch: str = "main",
) -> None:
    """
    Download all directories from the skills folder in the GitHub repository
    and place them in the target directory using git clone.

    Existing skill directories are replaced so the local catalogue matches
    the remote repo.
    """
    target_path = _resolve_skills_target(target_dir)
    staging_root: Path | None = None
    try:
        source_dir = _clone_scientific_skills_repo(
            github_repo=github_repo, source_path=source_path, branch=branch
        )
        staging_root = source_dir.parent
        print(f"\n📂 Copying skills to {target_path}...")
        skill_count = _copy_skill_catalogue(
            source_dir, target_path, replace_existing=True
        )
        print(
            f"\n✅ Successfully downloaded {skill_count} scientific skills "
            f"to {target_path.absolute()}"
        )
    except subprocess.CalledProcessError as e:
        print(f"❌ Error cloning repository: {e.stderr}")
        raise
    finally:
        if staging_root is not None:
            shutil.rmtree(staging_root, ignore_errors=True)


def sync_missing_scientific_skills(
    target_dir: str | None = None,
    github_repo: str = "K-Dense-AI/scientific-agent-skills",
    source_path: str = "skills",
    branch: str = "main",
) -> int:
    """Clone the skills repo and copy only skill dirs not already present locally."""
    target_path = _resolve_skills_target(target_dir)
    staging_root: Path | None = None
    try:
        source_dir = _clone_scientific_skills_repo(
            github_repo=github_repo, source_path=source_path, branch=branch
        )
        staging_root = source_dir.parent
        added = _copy_skill_catalogue(
            source_dir, target_path, replace_existing=False
        )
        if added:
            print(
                f"Synced {added} missing scientific skills to {target_path.absolute()}"
            )
        return added
    except subprocess.CalledProcessError as e:
        print(f"❌ Error cloning repository: {e.stderr}")
        raise
    finally:
        if staging_root is not None:
            shutil.rmtree(staging_root, ignore_errors=True)


def fetch_openrouter_models(
    api_key: str | None = None,
    max_age_days: int | None = None,
    supported_parameters: str | None = None,
) -> list[dict]:
    """
    Fetch all available models from OpenRouter using the official SDK.

    Args:
        api_key: OpenRouter API key (falls back to OPENROUTER_API_KEY env var).
        max_age_days: If set, only return models created within this many days.
        supported_parameters: Comma-separated OpenRouter parameters to require
            (for example, "tools" to return only tool-calling models).

    Returns a list of dicts, each with:
        id, name, provider, context_length, modality, created,
        pricing (prompt/completion per 1M tokens),
        description, supported_parameters, max_completion_tokens
    """
    from openrouter import OpenRouter

    key = api_key or os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise ValueError(
            "No API key provided. Set OPENROUTER_API_KEY or pass api_key."
        )

    with OpenRouter(api_key=key) as client:
        res = client.models.list(supported_parameters=supported_parameters)

    if not res or not res.data:
        return []

    cutoff_ts: float | None = None
    if max_age_days is not None:
        now = datetime.now(timezone.utc).timestamp()
        cutoff_ts = now - (max_age_days * 86_400)

    models = []
    for m in res.data:
        created_ts = float(m.created or 0)
        if cutoff_ts is not None and created_ts < cutoff_ts:
            continue

        prompt_price = float(m.pricing.prompt or 0) * 1_000_000
        completion_price = float(m.pricing.completion or 0) * 1_000_000

        provider = m.id.split("/")[0] if "/" in m.id else "unknown"

        created_dt = datetime.fromtimestamp(created_ts, tz=timezone.utc)

        models.append({
            "id": m.id,
            "name": m.name,
            "provider": provider,
            "created": created_dt.strftime("%Y-%m-%d"),
            "context_length": int(m.context_length or 0),
            "modality": m.architecture.modality if m.architecture else None,
            "input_modalities": list(m.architecture.input_modalities) if m.architecture and m.architecture.input_modalities else [],
            "output_modalities": list(m.architecture.output_modalities) if m.architecture and m.architecture.output_modalities else [],
            "pricing": {
                "prompt_per_1m": round(prompt_price, 4),
                "completion_per_1m": round(completion_price, 4),
            },
            "max_completion_tokens": int(m.top_provider.max_completion_tokens or 0) if m.top_provider else None,
            "supported_parameters": list(m.supported_parameters) if m.supported_parameters else [],
            "description": m.description,
        })

    models.sort(key=lambda x: x["name"] or x["id"])
    return models


def search_openrouter_models(
    query: str | None = None,
    providers: list[str] | None = None,
    min_context: int | None = None,
    max_prompt_price: float | None = None,
    modality: str | None = None,
    max_age_days: int | None = None,
    supported_parameters: str | None = None,
    api_key: str | None = None,
) -> list[dict]:
    """
    Search/filter OpenRouter models.

    Args:
        query: Case-insensitive substring match on model id, name, or description.
        providers: Filter to models from these providers (e.g. ["google", "anthropic"]).
        min_context: Minimum context length.
        max_prompt_price: Maximum prompt price per 1M tokens.
        modality: Filter by modality string (e.g. "text->text").
        max_age_days: Only include models added within this many days (e.g. 90).
        supported_parameters: Comma-separated OpenRouter parameters to require
            (for example, "tools" to return only tool-calling models).
        api_key: OpenRouter API key (falls back to OPENROUTER_API_KEY env var).
    """
    all_models = fetch_openrouter_models(
        api_key=api_key,
        max_age_days=max_age_days,
        supported_parameters=supported_parameters,
    )
    results = all_models

    if query:
        q = query.lower()
        results = [
            m for m in results
            if q in (m["id"] or "").lower()
            or q in (m["name"] or "").lower()
            or q in (m["description"] or "").lower()
        ]

    if providers:
        provider_set = {p.lower() for p in providers}
        results = [m for m in results if m["provider"].lower() in provider_set]

    if min_context is not None:
        results = [m for m in results if m["context_length"] >= min_context]

    if max_prompt_price is not None:
        results = [
            m for m in results
            if m["pricing"]["prompt_per_1m"] <= max_prompt_price
        ]

    if modality:
        results = [m for m in results if m.get("modality") == modality]

    return results


def print_openrouter_models(
    models: list[dict] | None = None, **filter_kwargs
) -> None:
    """Pretty-print a table of OpenRouter models. Accepts same filters as search_openrouter_models."""
    if models is None:
        models = search_openrouter_models(**filter_kwargs)

    print(f"{'ID':<45} {'Name':<40} {'Context':>10} {'$/1M In':>10} {'$/1M Out':>10}")
    print("-" * 120)
    for m in models:
        print(
            f"{m['id']:<45} "
            f"{(m['name'] or '')[:39]:<40} "
            f"{m['context_length']:>10,} "
            f"{m['pricing']['prompt_per_1m']:>10.2f} "
            f"{m['pricing']['completion_per_1m']:>10.2f}"
        )


_PROVIDER_ALIASES = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "meta-llama": "Meta",
    "deepseek": "DeepSeek",
    "x-ai": "xAI",
    "mistralai": "Mistral",
    "cohere": "Cohere",
    "nvidia": "NVIDIA",
    "qwen": "Qwen",
    "amazon": "Amazon",
    "microsoft": "Microsoft",
    "minimax": "MiniMax",
}


def _provider_label(slug: str) -> str:
    return _PROVIDER_ALIASES.get(slug, slug.replace("-", " ").title())


def _model_label(name: str, provider_slug: str) -> str:
    """Strip the 'Provider: ' prefix that OpenRouter puts on display names."""
    display = _provider_label(provider_slug)
    for prefix in [f"{display}: ", f"{provider_slug}: ", f"{provider_slug}/"]:
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def _pricing_tier(prompt_price: float) -> str:
    if prompt_price < 0.50:
        return "budget"
    if prompt_price < 2.00:
        return "mid"
    if prompt_price < 5.00:
        return "high"
    return "flagship"


def update_models_json(
    output_path: str = "web/src/data/models.json",
    default_model_id: str = "anthropic/claude-opus-4.8",
    expert_default_model_id: str = "google/gemini-3.5-flash",
    max_age_days: int | None = None,
    supported_parameters: str | None = "tools",
    excluded_model_ids: set[str] | None = None,
    api_key: str | None = None,
) -> None:
    """Fetch models from OpenRouter and overwrite the frontend models.json.

    Args:
        output_path: Path to the output JSON file.
        default_model_id: The OpenRouter model ID to mark as the default.
        expert_default_model_id: The OpenRouter model ID to mark as the expert
            default in the frontend picker.
        max_age_days: Only include models added within this many days.
            Pass None to include all models.
        supported_parameters: Comma-separated OpenRouter parameters to require.
            Defaults to "tools" because Kady sends tool definitions.
        excluded_model_ids: OpenRouter model IDs to omit even if the API
            returns them.
        api_key: OpenRouter API key (falls back to OPENROUTER_API_KEY env var).
    """
    excluded_model_ids = excluded_model_ids or {"openai/gpt-5.4", "openai/gpt-5.4-pro"}
    raw_models = fetch_openrouter_models(
        api_key=api_key,
        max_age_days=max_age_days,
        supported_parameters=supported_parameters,
    )
    out = Path(output_path)

    entries = []
    for m in raw_models:
        if m["id"] in excluded_model_ids:
            continue

        p_in = m["pricing"]["prompt_per_1m"]
        p_out = m["pricing"]["completion_per_1m"]
        if p_in < 0 or p_out < 0:
            continue

        slug = m["provider"]
        entry = {
            "id": f"openrouter/{m['id']}",
            "label": _model_label(m["name"] or m["id"], slug),
            "provider": _provider_label(slug),
            "tier": _pricing_tier(p_in),
            "context_length": m["context_length"],
            "pricing": {"prompt": p_in, "completion": p_out},
            "modality": m["modality"],
            "description": m["description"] or "",
        }
        if m["id"] == default_model_id:
            entry["default"] = True
        if m["id"] == expert_default_model_id:
            entry["expertDefault"] = True
        entries.append(entry)

    tier_order = {"flagship": 0, "high": 1, "mid": 2, "budget": 3}
    entries.sort(key=lambda e: (tier_order.get(e["tier"], 99), -e["context_length"]))

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(entries, indent=2) + "\n")
    print(f"Models: wrote {len(entries)} models to {out}")