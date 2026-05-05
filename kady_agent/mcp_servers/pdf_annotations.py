"""MCP server exposing PDF annotation tools to the expert (Gemini CLI).

The frontend owns the sidecar file <pdf>.annotations.json via the
``/sandbox/annotations`` HTTP endpoints. This MCP server provides the
same surface area to the expert subprocess so it can drop highlights
or sticky notes that the user sees rendered in a distinct color with
the expert's label.

Wire-up:
  - Registered as a built-in MCP server in
    :func:`kady_agent.mcp.build_default_settings`.
  - Launched via stdio by the Gemini CLI; the host passes
    ``KADY_PROJECT_ID`` (and, optionally, ``KADY_EXPERT_ID`` /
    ``KADY_EXPERT_LABEL``) in the environment so the server knows
    which project sandbox to read/write and how to stamp ``author``.

Writes are serialised by a per-file lock (fcntl) and the sidecar is
replaced atomically via ``os.replace`` so concurrent writes from the
user-facing PUT endpoint and this MCP cannot corrupt the JSON.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from kady_agent.projects import resolve_paths


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Environment-driven context
# ---------------------------------------------------------------------------


def _project_id() -> str:
    raw = (os.environ.get("KADY_PROJECT_ID") or "").strip()
    return raw or "default"


def _author() -> dict:
    """Build the ``author`` block for annotations created by the expert.

    ``label`` falls back to the delegation id, then to a generic
    "Expert" string, so every annotation always has a human-visible
    tag the user can spot in the sidebar.
    """
    label = (
        os.environ.get("KADY_EXPERT_LABEL")
        or os.environ.get("KADY_DELEGATION_ID")
        or "Expert"
    ).strip() or "Expert"
    author_id = (
        os.environ.get("KADY_EXPERT_ID")
        or os.environ.get("KADY_DELEGATION_ID")
        or "expert"
    ).strip() or "expert"
    return {"kind": "expert", "id": author_id, "label": label}


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------


def _sandbox_root() -> Path:
    return resolve_paths(_project_id()).sandbox


def _resolve_pdf(pdf_path: str) -> Path:
    sandbox_root = _sandbox_root()
    target = (sandbox_root / pdf_path).resolve()
    if not target.is_relative_to(sandbox_root):
        raise ValueError(f"Path traversal denied: {pdf_path!r}")
    if target.name.endswith(".annotations.json"):
        raise ValueError("Refusing to annotate a sidecar file")
    return target


def _sidecar_for(pdf_path: str) -> Path:
    pdf = _resolve_pdf(pdf_path)
    return pdf.with_name(pdf.name + ".annotations.json")


def _load_doc(sidecar: Path) -> dict:
    if not sidecar.is_file():
        return {"version": 1, "annotations": []}
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8") or "{}")
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "annotations": []}
    if not isinstance(data, dict):
        return {"version": 1, "annotations": []}
    anns = data.get("annotations")
    if not isinstance(anns, list):
        anns = []
    return {"version": 1, "annotations": anns}


def _save_doc(sidecar: Path, doc: dict) -> None:
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    tmp = sidecar.with_suffix(sidecar.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, sidecar)


def _with_lock(sidecar: Path, fn):
    """Run ``fn(doc) -> new_doc`` under an exclusive file lock on a
    sidecar-adjacent lock file. Serialises writes with the user-facing
    HTTP endpoint too (they both operate on the same file path).
    """
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    lock_path = sidecar.with_suffix(sidecar.suffix + ".lock")
    with open(lock_path, "w") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            doc = _load_doc(sidecar)
            new_doc = fn(doc)
            _save_doc(sidecar, new_doc)
            return new_doc
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Validation models (light — mirror the frontend/backend schema)
# ---------------------------------------------------------------------------


class _Rect(BaseModel):
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)


class _Anchor(BaseModel):
    x: float
    y: float


# ---------------------------------------------------------------------------
# FastMCP tool surface
# ---------------------------------------------------------------------------


mcp = FastMCP("kady-pdf-annotations")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@mcp.tool()
def add_pdf_annotation(
    pdf_path: str,
    type: Literal["highlight", "note"],
    page: int,
    text: Optional[str] = None,
    body: Optional[str] = None,
    rects: Optional[list[dict]] = None,
    anchor: Optional[dict] = None,
    color: Optional[str] = None,
    note: Optional[str] = None,
) -> dict:
    """Add a new annotation to ``<pdf_path>.annotations.json``.

    Coordinates are in PDF user-space *points* (origin bottom-left,
    y grows upward), page-local. Pages are 1-indexed.

    For ``type="highlight"`` you MUST pass:
        - ``page`` (int, 1-indexed)
        - ``rects`` (list of ``{x,y,w,h}`` in PDF points)
        - ``text`` (the selected string; shown in the sidebar)
      Optionally ``note`` (a free-text comment on the highlight) and
      ``color`` (a CSS hex; leave unset to inherit the expert palette).

    For ``type="note"`` you MUST pass:
        - ``page`` (int)
        - ``anchor`` (``{x, y}`` in PDF points)
        - ``body`` (the note contents; markdown-ish)

    The created annotation's ``author`` is stamped from the expert's
    environment (``KADY_EXPERT_LABEL`` / ``KADY_EXPERT_ID``). The tool
    returns the full annotation record.
    """
    if page < 1:
        raise ValueError("page must be >= 1")

    ann: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "type": type,
        "page": page,
        "author": _author(),
        "createdAt": _now_iso(),
    }
    if color:
        ann["color"] = color

    if type == "highlight":
        if not rects:
            raise ValueError("highlight requires 'rects'")
        validated = [_Rect(**r).model_dump() for r in rects]
        ann["rects"] = validated
        ann["text"] = (text or "").strip()
        if note:
            ann["note"] = note
    else:
        if not anchor:
            raise ValueError("note requires 'anchor'")
        ann["anchor"] = _Anchor(**anchor).model_dump()
        ann["body"] = (body or "").strip()

    sidecar = _sidecar_for(pdf_path)

    def _mutate(doc: dict) -> dict:
        doc["annotations"].append(ann)
        return doc

    _with_lock(sidecar, _mutate)
    return ann


@mcp.tool()
def list_pdf_annotations(
    pdf_path: str,
    author_kind: Optional[Literal["user", "expert"]] = None,
    page: Optional[int] = None,
) -> dict:
    """Read the annotations currently stored for a PDF.

    Optionally filter by ``author_kind`` (``"user"`` / ``"expert"``)
    or ``page`` (1-indexed). Returns ``{"annotations": [...]}``.
    """
    sidecar = _sidecar_for(pdf_path)
    doc = _load_doc(sidecar)
    anns = doc["annotations"]
    if author_kind:
        anns = [a for a in anns if (a.get("author") or {}).get("kind") == author_kind]
    if page is not None:
        anns = [a for a in anns if a.get("page") == page]
    return {"annotations": anns}


@mcp.tool()
def remove_pdf_annotation(
    pdf_path: str,
    annotation_id: str,
    force: bool = False,
) -> dict:
    """Remove one annotation by id.

    By default the expert can only remove annotations it authored
    (``author.kind == "expert"``). Pass ``force=True`` to remove a
    user-authored annotation — reserved for clean-up flows where the
    expert is explicitly curating the set.

    Returns ``{"removed": bool, "remaining": int}``.
    """
    sidecar = _sidecar_for(pdf_path)
    removed = False

    def _mutate(doc: dict) -> dict:
        nonlocal removed
        keep: list[dict] = []
        for a in doc["annotations"]:
            if a.get("id") == annotation_id:
                if (a.get("author") or {}).get("kind") == "expert" or force:
                    removed = True
                    continue
            keep.append(a)
        doc["annotations"] = keep
        return doc

    result = _with_lock(sidecar, _mutate)
    return {"removed": removed, "remaining": len(result["annotations"])}


def main() -> None:
    """Console-script entry point (see pyproject.toml)."""
    mcp.run()


if __name__ == "__main__":
    main()
