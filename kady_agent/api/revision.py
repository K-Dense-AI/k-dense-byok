from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

_MD_FENCE_RE = re.compile(
    r"\A\s*```(?:markdown|md)?\s*\n(.*?)\n```\s*\Z",
    re.DOTALL | re.IGNORECASE,
)


def strip_md_fence(text: str) -> str:
    """Remove an outer ```markdown fence if the model wrapped its reply."""
    match = _MD_FENCE_RE.match(text)
    return match.group(1) if match else text


_REVISE_SYSTEM_PROMPT = (
    "You are a precise markdown editor. You will be given a SELECTION from a "
    "markdown document together with optional BEFORE/AFTER context and a user "
    "INSTRUCTION.\n\n"
    "Your job: rewrite ONLY the SELECTION to satisfy the instruction. Preserve "
    "the surrounding markdown syntax conventions (headings, list markers, "
    "emphasis, code fences, tables) that are visible in the selection. Keep the "
    "revised text stylistically consistent with the BEFORE/AFTER context but do "
    "NOT repeat or rewrite that context.\n\n"
    "Return ONLY the revised markdown for the selection. No preamble, no "
    "explanation, no surrounding ```markdown fences, no quotes. Output must be "
    "drop-in replaceable text."
)


@router.post("/revise-markdown")
async def revise_markdown(request: Request):
    """Revise a markdown selection using the configured default model."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    selection = str(data.get("selection") or "")
    instruction = str(data.get("instruction") or "").strip()
    before = str(data.get("before") or "")[-800:]
    after = str(data.get("after") or "")[:800]
    model_override = data.get("model")

    if not selection.strip():
        raise HTTPException(status_code=400, detail="selection is required")
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction is required")

    # Import lazily so server startup still works when optional model deps are
    # absent in a lightweight check environment.
    import litellm
    from kady_agent.agent import DEFAULT_MODEL, EXTRA_HEADERS

    model = (
        str(model_override).strip()
        if isinstance(model_override, str) and model_override.strip()
        else DEFAULT_MODEL
    )
    if not model:
        raise HTTPException(
            status_code=500,
            detail="No model configured (set DEFAULT_AGENT_MODEL or pass 'model').",
        )

    user_message_parts = [f"INSTRUCTION:\n{instruction}"]
    if before:
        user_message_parts.append(
            "BEFORE (context only — do NOT rewrite):\n" + before
        )
    if after:
        user_message_parts.append(
            "AFTER (context only — do NOT rewrite):\n" + after
        )
    user_message_parts.append("SELECTION (rewrite this):\n" + selection)
    user_message = "\n\n".join(user_message_parts)

    try:
        response = await litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _REVISE_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            extra_headers=EXTRA_HEADERS,
            temperature=0.2,
            timeout=120,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Model call failed: {exc}")

    try:
        revised = response.choices[0].message.content or ""
    except (AttributeError, IndexError, KeyError) as exc:
        raise HTTPException(
            status_code=502, detail=f"Unexpected model response shape: {exc}"
        )

    revised = strip_md_fence(revised.strip())
    if not revised:
        raise HTTPException(status_code=502, detail="Model returned empty revision")

    return {"revised": revised, "model": model}
