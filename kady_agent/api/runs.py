from __future__ import annotations

import json
import re

import yaml
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from kady_agent.citations import report_to_dict, verify_text_and_files
from kady_agent.projects import ACTIVE_PROJECT, active_paths
from kady_agent.runtime import (
    list_turns,
    read_costs,
    read_manifest,
    replay_session,
    update_manifest,
)

router = APIRouter()

@router.get("/turns/{session_id}/{turn_id}/manifest")
async def get_turn_manifest(session_id: str, turn_id: str):
    """Return the per-turn run manifest written by kady_agent/manifest.py.

    Frontends use this to render the provenance panel and to construct
    "Copy as Methods" paragraphs with real package versions, seeds, and
    database access dates.
    """
    manifest = read_manifest(session_id, turn_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Manifest not found")
    return manifest


@router.get("/sessions/{session_id}/turns")
async def list_session_turns(session_id: str):
    """List turnIds for a session, in lexicographic (creation) order."""
    turns = list_turns(session_id)
    return {"sessionId": session_id, "turns": turns}


@router.get("/sessions/{session_id}/costs")
async def get_session_costs(session_id: str):
    """Return the OpenRouter cost ledger for a session.

    Aggregates entries written by the orchestrator (ADK + LiteLLM) and the
    expert (Gemini CLI -> LiteLLM proxy) callbacks. Returns zeroed totals
    when no ledger exists yet (fresh session, all-Ollama session, etc.).
    """
    return read_costs(session_id, project_id=ACTIVE_PROJECT.get())


@router.post("/replay")
async def replay_turns_endpoint(request: Request):
    """Re-run every saved delegation for a session (pipeline replay).

    Body: ``{ "sessionId": "...", "turnIds": ["..."] }``. Streams newline-
    delimited JSON so the frontend can show progress in real time. LLM
    outputs may differ from the original run because upstream providers
    are nondeterministic; attachments, prompts, seed, and requested model
    slug are pinned exactly.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    session_id = body.get("sessionId")
    turn_ids = body.get("turnIds")
    if not isinstance(session_id, str) or not session_id:
        raise HTTPException(status_code=400, detail="Missing sessionId")
    if turn_ids is not None and (
        not isinstance(turn_ids, list)
        or not all(isinstance(t, str) for t in turn_ids)
    ):
        raise HTTPException(status_code=400, detail="turnIds must be a list of strings")

    # Capture the active project so the replay runs in the same project
    # context even though the generator executes outside the request scope.
    project_id = ACTIVE_PROJECT.get()

    async def stream():
        token = ACTIVE_PROJECT.set(project_id)
        try:
            async for event in replay_session(
                session_id=session_id, turn_ids=turn_ids
            ):
                yield json.dumps(event) + "\n"
        finally:
            ACTIVE_PROJECT.reset(token)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.patch("/turns/{session_id}/{turn_id}/citations")
async def set_turn_citations(session_id: str, turn_id: str, request: Request):
    """Persist a citation report into the turn manifest.

    Called by the frontend after it receives the resolver output so the
    manifest remains the single source of truth for a turn's provenance.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    def mutator(manifest: dict) -> None:
        manifest["citations"] = {
            "total": body.get("total", 0),
            "verified": body.get("verified", 0),
            "unresolved": body.get("unresolved", 0),
        }

    updated = update_manifest(session_id, turn_id, mutator)
    if updated is None:
        raise HTTPException(status_code=404, detail="Manifest not found")
    return {"ok": True}


@router.post("/verify-citations")
async def verify_citations(request: Request):
    """Deterministic post-pass citation verifier.

    Body: ``{ "text": "...", "files": ["report.md", ...] }``. Returns a
    summary plus per-entry resolver status so the UI can draw a badge and
    popover. See kady_agent/citations.py for the resolver protocol.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    text = body.get("text", "")
    files = body.get("files", []) or []
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="'text' must be a string")
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        raise HTTPException(status_code=400, detail="'files' must be a list of strings")
    report = await verify_text_and_files(text, files)
    return report_to_dict(report)


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


@router.get("/skills")
def list_skills():
    """Return metadata for all installed Gemini skills in the active project."""
    skills_dir = active_paths().gemini_settings_dir / "skills"
    if not skills_dir.is_dir():
        return []

    skills = []
    for child in sorted(skills_dir.iterdir(), key=lambda p: p.name.lower()):
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
            skills.append({
                "id": child.name,
                "name": meta.get("name", child.name),
                "description": meta.get("description", ""),
                "author": (meta.get("metadata") or {}).get("skill-author", ""),
                "license": meta.get("license", ""),
                "compatibility": meta.get("compatibility", ""),
            })
        except Exception:
            continue

    return skills
