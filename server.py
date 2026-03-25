import io
import mimetypes
import os
import re
import shutil
import zipfile
from pathlib import Path

import yaml
from fastapi import HTTPException, Query, Request, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse
from google.adk.cli.fast_api import get_fast_api_app

app = get_fast_api_app(
    agents_dir=".",
    web=False,
    allow_origins=["http://localhost:3000"],
    auto_create_session=True,
)

SANDBOX_ROOT = Path("sandbox").resolve()


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
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return node

        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.name in ("GEMINI.md", "uv.lock"):
                continue
            rel = str(entry.relative_to(SANDBOX_ROOT))
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

    tree = build_tree(SANDBOX_ROOT)
    tree["path"] = ""
    return tree


UPLOAD_DIR = SANDBOX_ROOT / "user_data"


@app.post("/sandbox/upload")
async def sandbox_upload(files: list[UploadFile]):
    """Upload files into sandbox/user_data."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        if not f.filename:
            continue
        safe_name = Path(f.filename).name
        if not safe_name or safe_name.startswith("."):
            continue
        dest = UPLOAD_DIR / safe_name
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


@app.get("/sandbox/download-dir")
def sandbox_download_dir(path: str = Query(...)):
    """Download a directory as a zip archive."""
    target = _safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(target.rglob("*")):
            if file_path.is_file() and not any(
                p.startswith(".") for p in file_path.relative_to(target).parts
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
            if file_path.is_file() and not any(
                p.startswith(".") for p in file_path.relative_to(SANDBOX_ROOT).parts
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
