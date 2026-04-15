import asyncio
import io
import json
import mimetypes
import os
import re
import shutil
import zipfile
from pathlib import Path

import yaml
from fastapi import Body, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse
from google.adk.cli.fast_api import get_fast_api_app


def _allowed_origins() -> list[str]:
    raw = os.environ.get("BACKEND_CORS_ALLOWED_ORIGINS", "").strip()
    if not raw:
        return ["http://localhost:3000"]

    origins: list[str] = []
    for value in raw.split(","):
        origin = value.strip().rstrip("/")
        if origin and origin not in origins:
            origins.append(origin)

    return origins or ["http://localhost:3000"]


from kady_agent.gemini_settings import (
    load_custom_mcps,
    save_custom_mcps,
    write_merged_settings,
)
from kady_agent.runtime_paths import sandbox_root

app = get_fast_api_app(
    agents_dir=".",
    web=False,
    allow_origins=_allowed_origins(),
    auto_create_session=True,
)

SANDBOX_ROOT = sandbox_root().resolve()

_ZIP_EXCLUDED_NAMES = {"GEMINI.md", "uv.lock"}


def _safe_path(rel: str) -> Path:
    target = (SANDBOX_ROOT / rel).resolve()
    if not target.is_relative_to(SANDBOX_ROOT):
        raise HTTPException(status_code=403, detail="Path traversal denied")
    return target


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/config")
async def config():
    """Expose non-secret feature flags to the frontend."""
    modal_id = os.environ.get("MODAL_TOKEN_ID", "").strip()
    modal_secret = os.environ.get("MODAL_TOKEN_SECRET", "").strip()
    return {
        "modal_configured": bool(modal_id and modal_secret),
    }


@app.get("/settings/mcps")
def get_custom_mcps():
    """Return the user's custom MCP server definitions."""
    return load_custom_mcps()


@app.put("/settings/mcps")
async def put_custom_mcps(request: Request):
    """Save custom MCP servers and rebuild the merged Gemini CLI settings."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    save_custom_mcps(data)
    settings_dir = SANDBOX_ROOT / ".gemini"
    write_merged_settings(settings_dir)
    return {"ok": True}


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


@app.get("/skills")
def list_skills():
    """Return metadata for all installed Gemini skills."""
    skills_dir = SANDBOX_ROOT / ".gemini" / "skills"
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
            meta = yaml.safe_load(match.group(1)) or {}
            skills.append(
                {
                    "id": child.name,
                    "name": meta.get("name", child.name),
                    "description": meta.get("description", ""),
                    "author": (meta.get("metadata") or {}).get("skill-author", ""),
                    "license": meta.get("license", ""),
                    "compatibility": meta.get("compatibility", ""),
                }
            )
        except Exception:
            continue

    return skills


@app.get("/sandbox/tree")
def sandbox_tree():
    """Return the sandbox directory as a nested tree structure."""
    if not SANDBOX_ROOT.exists():
        return {"name": "sandbox", "type": "directory", "children": []}

    def build_tree(directory: Path, depth: int = 0) -> dict:
        node: dict = {"name": directory.name, "type": "directory", "children": []}
        if depth > 8:
            return node
        try:
            entries = sorted(
                directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower())
            )
        except PermissionError:
            return node

        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.name in _ZIP_EXCLUDED_NAMES:
                continue
            rel = str(entry.relative_to(SANDBOX_ROOT))
            if entry.is_dir():
                child = build_tree(entry, depth + 1)
                child["path"] = rel
                node["children"].append(child)
            elif entry.is_file():
                node["children"].append(
                    {
                        "name": entry.name,
                        "type": "file",
                        "path": rel,
                        "size": entry.stat().st_size,
                    }
                )
        return node

    tree = build_tree(SANDBOX_ROOT)
    tree["path"] = ""
    return tree


UPLOAD_DIR = SANDBOX_ROOT / "user_data"


@app.post("/sandbox/upload")
async def sandbox_upload(
    files: list[UploadFile],
    paths: list[str] = Form(default=[]),
):
    """Upload files into sandbox/user_data, preserving directory structure."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, f in enumerate(files):
        if not f.filename:
            continue
        rel = paths[i].strip() if i < len(paths) else ""
        if rel:
            parts = Path(rel).parts
            safe_parts = [
                p for p in parts if p not in ("..", ".") and not p.startswith(".")
            ]
            if not safe_parts:
                continue
            dest = UPLOAD_DIR / Path(*safe_parts)
        else:
            safe_name = Path(f.filename).name
            if not safe_name or safe_name.startswith("."):
                continue
            dest = UPLOAD_DIR / safe_name
        dest.parent.mkdir(parents=True, exist_ok=True)
        content = await f.read()
        dest.write_bytes(content)
        saved.append(str(dest.relative_to(SANDBOX_ROOT)))
    return {"uploaded": saved}


@app.get("/sandbox/file", response_class=PlainTextResponse)
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


@app.put("/sandbox/file")
async def sandbox_save_file(request: Request, path: str = Query(...)):
    """Overwrite a sandbox file with new content (text or binary)."""
    target = _safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    body = await request.body()
    target.write_bytes(body)
    return {"saved": path, "size": len(body)}


@app.delete("/sandbox/file")
def sandbox_delete(path: str = Query(...)):
    """Delete a file from the sandbox directory."""
    target = _safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    target.unlink()
    return {"deleted": path}


@app.delete("/sandbox/directory")
def sandbox_delete_directory(path: str = Query(...)):
    """Recursively delete a directory from the sandbox."""
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")
    if target == SANDBOX_ROOT:
        raise HTTPException(status_code=403, detail="Cannot delete sandbox root")
    shutil.rmtree(target)
    return {"deleted": path}


@app.post("/sandbox/move")
def sandbox_move(src: str = Body(...), dest: str = Body(...)):
    """Move or rename a file/directory within the sandbox."""
    src_path = _safe_path(src)
    dest_path = _safe_path(dest)
    if not src_path.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    if dest_path.exists():
        raise HTTPException(status_code=409, detail="Destination already exists")
    if not dest_path.parent.exists():
        raise HTTPException(
            status_code=404, detail="Destination parent directory not found"
        )
    if src_path.is_dir() and dest_path.is_relative_to(src_path):
        raise HTTPException(
            status_code=400, detail="Cannot move a directory into itself"
        )
    shutil.move(str(src_path), str(dest_path))
    return {"ok": True}


@app.post("/sandbox/mkdir")
def sandbox_mkdir(path: str = Body(..., embed=True)):
    """Create a new directory inside the sandbox."""
    target = _safe_path(path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Path already exists")
    if not target.parent.exists():
        raise HTTPException(status_code=404, detail="Parent directory not found")
    target.mkdir()
    return {"ok": True}


@app.get("/sandbox/download-dir")
def sandbox_download_dir(path: str = Query(...)):
    """Download a directory as a zip archive."""
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(target.rglob("*")):
            rel_parts = file_path.relative_to(target).parts
            if (
                file_path.is_file()
                and not any(p.startswith(".") for p in rel_parts)
                and file_path.name not in _ZIP_EXCLUDED_NAMES
            ):
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


@app.get("/sandbox/raw")
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


@app.get("/sandbox/download")
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


@app.get("/sandbox/download-all")
def sandbox_download_all():
    """Download the entire sandbox as a zip archive."""
    if not SANDBOX_ROOT.exists():
        raise HTTPException(status_code=404, detail="Sandbox is empty")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(SANDBOX_ROOT.rglob("*")):
            rel_parts = file_path.relative_to(SANDBOX_ROOT).parts
            if (
                file_path.is_file()
                and not any(p.startswith(".") for p in rel_parts)
                and file_path.name not in _ZIP_EXCLUDED_NAMES
            ):
                zf.write(file_path, file_path.relative_to(SANDBOX_ROOT))
    buf.seek(0)

    if buf.getbuffer().nbytes <= 22:
        raise HTTPException(status_code=404, detail="No files to download")

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sandbox.zip"'},
    )


_LATEX_ERROR_RE = re.compile(r"^! (.+)", re.MULTILINE)
_VALID_ENGINES = {"pdflatex", "xelatex", "lualatex"}


@app.post("/sandbox/compile-latex")
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

    return {
        "success": success,
        "pdf_path": str(pdf_path.relative_to(SANDBOX_ROOT))
        if pdf_path.is_file()
        else None,
        "log": log_text[-8000:] if len(log_text) > 8000 else log_text,
        "errors": errors,
    }
