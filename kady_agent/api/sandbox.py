from __future__ import annotations

import asyncio
import io
import json
import mimetypes
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse

from kady_agent.anndata_preview import AnnDataDepsMissing, render_embedding_png, summarize_h5ad
from kady_agent.projects import ACTIVE_PROJECT, active_paths, touch_project
from kady_agent.sandbox_visibility import USER_HIDDEN_NAMES, is_user_visible_path

router = APIRouter()

_ZIP_EXCLUDED_NAMES = USER_HIDDEN_NAMES


def _safe_path(rel: str) -> Path:
    sandbox_root = active_paths().sandbox
    target = (sandbox_root / rel).resolve()
    if not target.is_relative_to(sandbox_root):
        raise HTTPException(status_code=403, detail="Path traversal denied")
    return target


@router.get("/sandbox/tree")
def sandbox_tree():
    """Return the active project's sandbox as a nested tree structure."""
    sandbox_root = active_paths().sandbox
    if not sandbox_root.exists():
        return {"name": "sandbox", "type": "directory", "children": []}

    def build_tree(directory: Path, depth: int = 0) -> dict:
        node: dict = {"name": directory.name, "type": "directory", "children": []}
        if depth > 8:
            return node
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return node

        for entry in entries:
            if not is_user_visible_path(entry, sandbox_root):
                continue
            rel = str(entry.relative_to(sandbox_root))
            if entry.is_dir():
                child = build_tree(entry, depth + 1)
                child["path"] = rel
                node["children"].append(child)
            elif entry.is_file():
                node["children"].append({
                    "name": entry.name,
                    "type": "file",
                    "path": rel,
                    "size": entry.stat().st_size,
                })
        return node

    tree = build_tree(sandbox_root)
    tree["path"] = ""
    return tree


@router.post("/sandbox/upload")
async def sandbox_upload(
    files: list[UploadFile],
    paths: list[str] = Form(default=[]),
):
    """Upload files into the active project's ``sandbox/user_data``."""
    paths_obj = active_paths()
    upload_dir = paths_obj.upload_dir
    sandbox_root = paths_obj.sandbox
    upload_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, f in enumerate(files):
        if not f.filename:
            continue
        rel = paths[i].strip() if i < len(paths) else ""
        if rel:
            parts = Path(rel).parts
            safe_parts = [p for p in parts if p not in ("..", ".") and not p.startswith(".")]
            if not safe_parts:
                continue
            dest = upload_dir / Path(*safe_parts)
        else:
            safe_name = Path(f.filename).name
            if not safe_name or safe_name.startswith("."):
                continue
            dest = upload_dir / safe_name
        dest.parent.mkdir(parents=True, exist_ok=True)
        content = await f.read()
        dest.write_bytes(content)
        saved.append(str(dest.relative_to(sandbox_root)))
    touch_project(ACTIVE_PROJECT.get())
    return {"uploaded": saved}


@router.get("/sandbox/file", response_class=PlainTextResponse)
def sandbox_file(path: str = Query(...)):
    """Read a file from the sandbox directory."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if target.stat().st_size > 512_000:
        raise HTTPException(status_code=413, detail="File too large to preview")
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/sandbox/file")
async def sandbox_save_file(request: Request, path: str = Query(...)):
    """Overwrite a sandbox file with new content (text or binary)."""
    target = _safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    body = await request.body()
    target.write_bytes(body)
    touch_project(ACTIVE_PROJECT.get())
    return {"saved": path, "size": len(body)}


@router.delete("/sandbox/file")
def sandbox_delete(path: str = Query(...)):
    """Delete a file from the sandbox directory."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    target.unlink()
    # Cascade: remove an annotation sidecar if this was an annotatable file.
    sidecar = target.with_name(target.name + ".annotations.json")
    if sidecar.is_file():
        try:
            sidecar.unlink()
        except OSError:
            pass
    touch_project(ACTIVE_PROJECT.get())
    return {"deleted": path}


@router.delete("/sandbox/directory")
def sandbox_delete_directory(path: str = Query(...)):
    """Recursively delete a directory from the sandbox."""
    sandbox_root = active_paths().sandbox
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")
    if target == sandbox_root:
        raise HTTPException(status_code=403, detail="Cannot delete sandbox root")
    shutil.rmtree(target)
    touch_project(ACTIVE_PROJECT.get())
    return {"deleted": path}


@router.post("/sandbox/move")
def sandbox_move(src: str = Body(...), dest: str = Body(...)):
    """Move or rename a file/directory within the sandbox."""
    src_path = _safe_path(src)
    dest_path = _safe_path(dest)
    if not src_path.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    if dest_path.exists():
        raise HTTPException(status_code=409, detail="Destination already exists")
    if not dest_path.parent.exists():
        raise HTTPException(status_code=404, detail="Destination parent directory not found")
    if src_path.is_dir() and dest_path.is_relative_to(src_path):
        raise HTTPException(status_code=400, detail="Cannot move a directory into itself")
    shutil.move(str(src_path), str(dest_path))
    # Cascade: move the annotation sidecar alongside a file move/rename.
    if src_path.is_file() or dest_path.is_file():
        src_sidecar = src_path.with_name(src_path.name + ".annotations.json")
        if src_sidecar.exists():
            dest_sidecar = dest_path.with_name(dest_path.name + ".annotations.json")
            try:
                dest_sidecar.parent.mkdir(parents=True, exist_ok=True)
                if not dest_sidecar.exists():
                    shutil.move(str(src_sidecar), str(dest_sidecar))
            except OSError:
                pass
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True}


@router.post("/sandbox/mkdir")
def sandbox_mkdir(path: str = Body(..., embed=True)):
    """Create a new directory inside the sandbox."""
    target = _safe_path(path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Path already exists")
    if not target.parent.exists():
        raise HTTPException(status_code=404, detail="Parent directory not found")
    target.mkdir()
    touch_project(ACTIVE_PROJECT.get())
    return {"ok": True}


@router.get("/sandbox/download-dir")
def sandbox_download_dir(path: str = Query(...)):
    """Download a directory as a zip archive."""
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(target.rglob("*")):
            rel_parts = file_path.relative_to(target).parts
            if file_path.is_file() and not any(
                p.startswith(".") for p in rel_parts
            ) and file_path.name not in _ZIP_EXCLUDED_NAMES:
                zf.write(file_path, file_path.relative_to(target))
    buf.seek(0)

    if buf.getbuffer().nbytes <= 22:
        raise HTTPException(status_code=404, detail="Directory is empty")

    archive_name = f"{target.name}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{archive_name}"'},
    )


# ---------------------------------------------------------------------------
# Annotation sidecars: <pdf-rel>.annotations.json next to the file.
# Hidden from /sandbox/tree; cascaded on delete/move; edited through these
# dedicated endpoints so the frontend and the expert-side MCP both go
# through validation and atomic writes.
# ---------------------------------------------------------------------------


_EMPTY_ANNOTATIONS = {"version": 1, "annotations": []}


def _sidecar_for(pdf_rel: str) -> Path:
    target = _safe_path(pdf_rel)
    if target.name.endswith(".annotations.json"):
        raise HTTPException(status_code=400, detail="Refusing to annotate a sidecar")
    sidecar = target.with_name(target.name + ".annotations.json")
    sandbox_root = active_paths().sandbox
    if not sidecar.resolve().is_relative_to(sandbox_root):
        raise HTTPException(status_code=403, detail="Path traversal denied")
    return sidecar


def _normalize_annotations_doc(data) -> dict:
    """Enforce the minimal on-disk schema: {version, annotations: [...]}.
    Unknown fields on individual annotations pass through (forward-compat).
    """
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Annotations body must be a JSON object")
    anns = data.get("annotations")
    if anns is None:
        anns = []
    if not isinstance(anns, list):
        raise HTTPException(status_code=400, detail="'annotations' must be a list")
    for i, ann in enumerate(anns):
        if not isinstance(ann, dict):
            raise HTTPException(status_code=400, detail=f"annotations[{i}] must be an object")
        if not ann.get("id") or not isinstance(ann["id"], str):
            raise HTTPException(status_code=400, detail=f"annotations[{i}].id is required")
        if ann.get("type") not in ("highlight", "note"):
            raise HTTPException(status_code=400, detail=f"annotations[{i}].type must be 'highlight' or 'note'")
        if not isinstance(ann.get("page"), int) or ann["page"] < 1:
            raise HTTPException(status_code=400, detail=f"annotations[{i}].page must be a positive int")
        author = ann.get("author")
        if not isinstance(author, dict) or author.get("kind") not in ("user", "expert"):
            raise HTTPException(status_code=400, detail=f"annotations[{i}].author.kind invalid")
    return {"version": 1, "annotations": anns}


def _http_date(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return format_datetime(dt, usegmt=True)


@router.get("/sandbox/annotations")
def sandbox_get_annotations(response: Response, path: str = Query(...)):
    """Read the annotation sidecar for a given sandbox file.

    Returns an empty doc (``{"version":1,"annotations":[]}``) when the
    sidecar does not exist yet. Sets ``Last-Modified`` so the client can
    pass ``If-Unmodified-Since`` on subsequent writes and cheaply poll.
    """
    sidecar = _sidecar_for(path)
    if not sidecar.is_file():
        response.headers["Cache-Control"] = "no-store"
        return _EMPTY_ANNOTATIONS

    try:
        raw = sidecar.read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else _EMPTY_ANNOTATIONS
    except (OSError, json.JSONDecodeError):
        return _EMPTY_ANNOTATIONS

    mtime = datetime.fromtimestamp(sidecar.stat().st_mtime, tz=timezone.utc)
    response.headers["Last-Modified"] = _http_date(mtime)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.put("/sandbox/annotations")
async def sandbox_put_annotations(
    request: Request,
    response: Response,
    path: str = Query(...),
):
    """Overwrite the annotation sidecar with a new JSON document.

    If the client sends ``If-Unmodified-Since`` and the sidecar has been
    written since that timestamp (e.g. by the expert-side MCP), respond
    with 412 so the client can re-read, merge, and retry.
    """
    sidecar = _sidecar_for(path)

    if sidecar.exists():
        precond = request.headers.get("if-unmodified-since")
        if precond:
            try:
                expected = parsedate_to_datetime(precond)
                if expected.tzinfo is None:
                    expected = expected.replace(tzinfo=timezone.utc)
                actual = datetime.fromtimestamp(
                    sidecar.stat().st_mtime, tz=timezone.utc
                )
                # HTTP-date has 1s precision; allow that much slack.
                if (actual - expected).total_seconds() > 1:
                    raise HTTPException(status_code=412, detail="Sidecar modified; re-read and retry")
            except HTTPException:
                raise
            except (TypeError, ValueError):
                pass

    body_bytes = await request.body()
    try:
        incoming = json.loads(body_bytes.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")
    doc = _normalize_annotations_doc(incoming)

    sidecar.parent.mkdir(parents=True, exist_ok=True)
    tmp = sidecar.with_suffix(sidecar.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, sidecar)
    touch_project(ACTIVE_PROJECT.get())

    mtime = datetime.fromtimestamp(sidecar.stat().st_mtime, tz=timezone.utc)
    response.headers["Last-Modified"] = _http_date(mtime)
    return {"saved": path, "count": len(doc["annotations"])}


@router.get("/sandbox/raw")
def sandbox_raw(path: str = Query(...)):
    """Serve a file inline with the correct MIME type (for images, PDFs, etc.)."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    mime, _ = mimetypes.guess_type(target.name)
    if not mime:
        mime = "application/octet-stream"
    content = target.read_bytes()
    return StreamingResponse(
        io.BytesIO(content),
        media_type=mime,
        headers={"Content-Disposition": f'inline; filename="{target.name}"'},
    )


@router.get("/sandbox/download")
def sandbox_download(path: str = Query(...)):
    """Download a single file from the sandbox."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    content = target.read_bytes()
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{target.name}"'},
    )


@router.get("/sandbox/download-all")
def sandbox_download_all():
    """Download the entire sandbox as a zip archive."""
    sandbox_root = active_paths().sandbox
    if not sandbox_root.exists():
        raise HTTPException(status_code=404, detail="Sandbox is empty")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(sandbox_root.rglob("*")):
            rel_parts = file_path.relative_to(sandbox_root).parts
            if file_path.is_file() and not any(
                p.startswith(".") for p in rel_parts
            ) and file_path.name not in _ZIP_EXCLUDED_NAMES:
                zf.write(file_path, file_path.relative_to(sandbox_root))
    buf.seek(0)

    if buf.getbuffer().nbytes <= 22:
        raise HTTPException(status_code=404, detail="No files to download")

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sandbox.zip"'},
    )


_H5AD_SUFFIXES = (".h5ad",)


def _require_h5ad(target: Path) -> None:
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.name.lower().endswith(_H5AD_SUFFIXES):
        raise HTTPException(status_code=400, detail="Not a .h5ad file")


@router.get("/sandbox/anndata-summary")
def sandbox_anndata_summary(path: str = Query(...)):
    """Return a JSON summary of an .h5ad file.

    Opens the file in ``backed="r"`` mode so shape/dtype/obs/var/obsm can
    be introspected without loading the full matrix into memory.
    """
    target = _safe_path(path)
    _require_h5ad(target)
    try:
        return summarize_h5ad(target)
    except AnnDataDepsMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to read h5ad: {exc}")


@router.get("/sandbox/anndata-embedding.png")
def sandbox_anndata_embedding(
    path: str = Query(...),
    key: str = Query(...),
    color: Optional[str] = Query(default=None),
):
    """Render the first 2 dims of ``adata.obsm[key]`` as a cached PNG."""
    target = _safe_path(path)
    _require_h5ad(target)
    cache_dir = active_paths().sandbox.parent / ".anndata_cache"
    try:
        data = render_embedding_png(target, key=key, color=color, cache_dir=cache_dir)
    except AnnDataDepsMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to render embedding: {exc}")
    return StreamingResponse(
        io.BytesIO(data),
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


_LATEX_ERROR_RE = re.compile(r"^! (.+)", re.MULTILINE)
_VALID_ENGINES = {"pdflatex", "xelatex", "lualatex"}


@router.post("/sandbox/compile-latex")
async def sandbox_compile_latex(request: Request):
    """Compile a .tex file to PDF using latexmk or a raw engine."""
    body = await request.json()
    rel_path = body.get("path", "")
    engine = body.get("engine", "pdflatex")

    if engine not in _VALID_ENGINES:
        raise HTTPException(status_code=400, detail=f"Unsupported engine: {engine}")

    target = _safe_path(rel_path)
    if not target.is_file() or target.suffix not in (".tex", ".latex"):
        raise HTTPException(status_code=400, detail="Not a .tex file")

    work_dir = target.parent
    pdf_name = target.stem + ".pdf"
    pdf_path = work_dir / pdf_name

    has_latexmk = shutil.which("latexmk") is not None

    if has_latexmk:
        cmd = [
            "latexmk",
            f"-{engine}",
            "-interaction=nonstopmode",
            "-cd",
            "-file-line-error",
            str(target),
        ]
    else:
        cmd = [engine, "-interaction=nonstopmode", "-file-line-error", target.name]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        return {
            "success": False,
            "pdf_path": None,
            "log": "Compilation timed out after 60 seconds.",
            "errors": ["Timeout"],
        }
    except FileNotFoundError:
        return {
            "success": False,
            "pdf_path": None,
            "log": f"LaTeX compiler not found. Install TeX Live or set PATH to include {engine}.",
            "errors": [f"{engine} not found on system"],
        }

    log_text = stdout.decode("utf-8", errors="replace")
    errors = _LATEX_ERROR_RE.findall(log_text)
    success = proc.returncode == 0 and pdf_path.is_file()

    sandbox_root = active_paths().sandbox
    return {
        "success": success,
        "pdf_path": str(pdf_path.relative_to(sandbox_root)) if pdf_path.is_file() else None,
        "log": log_text[-8000:] if len(log_text) > 8000 else log_text,
        "errors": errors,
    }
