from __future__ import annotations

import os

import httpx
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/config")
async def config():
    """Expose non-secret feature flags to the frontend."""
    modal_id = os.environ.get("MODAL_TOKEN_ID", "").strip()
    modal_secret = os.environ.get("MODAL_TOKEN_SECRET", "").strip()
    return {
        "modal_configured": bool(modal_id and modal_secret),
    }


def _format_ollama_bytes(n: int) -> str:
    """Compact GB/MB rendering for Ollama blob sizes."""
    if not isinstance(n, (int, float)) or n <= 0:
        return ""
    gb = n / 1_073_741_824
    if gb >= 1:
        return f"{gb:.1f} GB"
    mb = n / 1_048_576
    return f"{mb:.0f} MB"


def _ollama_entry(tag: dict) -> dict:
    """Map an `/api/tags` entry to the Model shape consumed by the UI."""
    name = tag.get("name") or tag.get("model") or ""
    details = tag.get("details") or {}
    family = details.get("family") or ""
    param_size = details.get("parameter_size") or ""
    quant = details.get("quantization_level") or ""
    size_str = _format_ollama_bytes(int(tag.get("size") or 0))

    bits = [b for b in (family, param_size, quant, size_str) if b]
    description = (
        "Local model served by Ollama at OLLAMA_BASE_URL. "
        + (" · ".join(bits) if bits else "")
    ).strip()

    return {
        "id": f"ollama/{name}" if name else "ollama/unknown",
        "label": name or "unknown",
        "provider": "Ollama",
        "tier": "budget",
        "context_length": 0,
        "pricing": {"prompt": 0.0, "completion": 0.0},
        "modality": "text->text",
        "description": description,
    }


@router.get("/ollama/models")
async def list_ollama_models():
    """Proxy to Ollama and map tags into the UI's Model shape."""
    base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{base}/api/tags")
        resp.raise_for_status()
    except Exception:
        return {"available": False, "models": []}
    try:
        data = resp.json() or {}
    except ValueError:
        return {"available": False, "models": []}
    tags = data.get("models") or []
    entries = [_ollama_entry(t) for t in tags if isinstance(t, dict)]
    return {"available": True, "models": entries}
