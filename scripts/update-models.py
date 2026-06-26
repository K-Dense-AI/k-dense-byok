#!/usr/bin/env python3
"""Regenerate web/src/data/models.json from the live OpenRouter catalogue.

Usage: python3 scripts/update-models.py

Inclusion rule: every OpenRouter model that supports tool calling
(`supported_parameters` contains "tools") and has non-negative pricing
(the Auto Router advertises -1 as a "variable pricing" sentinel, which
would corrupt the spend-cap accrual in server/src/agent/models.ts).

The `default` / `expertDefault` flags are carried forward from the
existing file by model id; the script warns if a flagged model has
disappeared from OpenRouter.
"""

import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "src" / "data" / "models.json"
API = "https://openrouter.ai/api/v1/models"

# Vendor slugs whose display name isn't just title-cased words.
PROVIDER_OVERRIDES = {
    "deepseek": "DeepSeek",
    "meta-llama": "Meta",
    "minimax": "MiniMax",
    "mistralai": "Mistral",
    "nvidia": "NVIDIA",
    "openai": "OpenAI",
    "sao10k": "Sao10K",
    "x-ai": "xAI",
}

TIER_ORDER = {"flagship": 0, "high": 1, "mid": 2, "budget": 3}

DESCRIPTION_WORDS = 30


def tier_for(prompt_per_m: float) -> str:
    if prompt_per_m < 0.5:
        return "budget"
    if prompt_per_m < 2:
        return "mid"
    if prompt_per_m < 5:
        return "high"
    return "flagship"


def provider_for(model_id: str) -> str:
    slug = model_id.split("/")[0].lstrip("~")
    return PROVIDER_OVERRIDES.get(slug) or " ".join(
        part.capitalize() for part in slug.split("-")
    )


def label_for(name: str, provider: str) -> str:
    prefix = f"{provider}: "
    return name[len(prefix):] if name.startswith(prefix) else name


def truncate(description: str) -> str:
    words = description.split()
    if len(words) <= DESCRIPTION_WORDS:
        return description
    return " ".join(words[:DESCRIPTION_WORDS]) + "..."


def main() -> None:
    with urllib.request.urlopen(API) as resp:
        live = json.load(resp)["data"]

    flags: dict[str, dict[str, bool]] = {}
    try:
        for entry in json.loads(OUT.read_text()):
            carried = {k: entry[k] for k in ("default", "expertDefault") if entry.get(k)}
            if carried:
                flags[entry["id"]] = carried
    except FileNotFoundError:
        pass

    out = []
    for m in live:
        model_id = m["id"]
        is_fusion = model_id == "openrouter/fusion"

        if not is_fusion:
            if "tools" not in (m.get("supported_parameters") or []):
                continue
            prompt = round(float(m["pricing"]["prompt"]) * 1_000_000, 6)
            completion = round(float(m["pricing"]["completion"]) * 1_000_000, 6)
            if prompt < 0 or completion < 0:
                continue
        else:
            # Fusion is a special meta-model with variable pricing and no tools param
            prompt = 0.0
            completion = 0.0

        provider = "Openrouter Fusion" if is_fusion else provider_for(model_id)
        or_id = model_id if is_fusion else f"openrouter/{model_id}"
        entry = {
            "id": or_id,
            "label": "Fusion" if is_fusion else label_for(m["name"], provider),
            "provider": provider,
            "tier": "flagship" if is_fusion else tier_for(prompt),
            "context_length": m["context_length"],
            "pricing": {"prompt": prompt, "completion": completion},
            "modality": m["architecture"]["modality"],
            "description": truncate(m["description"]),
            "isFusion": is_fusion,
        }
        entry.update(flags.pop(entry["id"], {}))
        out.append(entry)

    for model_id, carried in flags.items():
        print(
            f"warning: {model_id} had {'/'.join(carried)} set but is no longer "
            "on OpenRouter; the flag was dropped",
            file=sys.stderr,
        )

    out.sort(key=lambda e: (TIER_ORDER[e["tier"]], -e["context_length"], e["label"], e["id"]))
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=True) + "\n")
    print(f"wrote {len(out)} models to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
