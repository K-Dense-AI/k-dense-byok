"""Venice AI tools — image generation, image upscaling, and text-to-speech.

These tools call the Venice API directly and save outputs to the sandbox so
they appear in the file browser and can be referenced in subsequent tasks.

Requires VENICE_API_KEY to be set in kady_agent/.env.
Venice API docs: https://docs.venice.ai/api-reference/
"""

import base64
import os
from datetime import datetime
from pathlib import Path

import httpx

VENICE_API_BASE = "https://api.venice.ai/api/v1"
_REPO_ROOT = Path(__file__).resolve().parents[2]
SANDBOX_USER_DATA = _REPO_ROOT / "sandbox" / "user_data"


def _headers() -> dict[str, str]:
    key = os.environ.get("VENICE_API_KEY", "")
    if not key:
        raise ValueError(
            "VENICE_API_KEY is not set. Add it to kady_agent/.env to use Venice tools."
        )
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _ensure_user_data() -> Path:
    SANDBOX_USER_DATA.mkdir(parents=True, exist_ok=True)
    return SANDBOX_USER_DATA


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


# ── Image generation ──────────────────────────────────────────────────────────

async def venice_generate_image(
    prompt: str,
    model: str = "fluently-xl",
    width: int = 1024,
    height: int = 1024,
    steps: int = 25,
    style_preset: str | None = None,
    negative_prompt: str | None = None,
    safe_mode: bool = False,
    enhance_prompt: bool = True,
    filename: str | None = None,
) -> dict:
    """Generate an image using Venice AI's image generation API and save it to the sandbox.

    Args:
        prompt: Text description of the image to generate.
        model: Venice image model. Options:
            'fluently-xl' (photorealism, default),
            'pony-realism' (anime/illustration),
            'venice-sd35' (Stable Diffusion 3.5),
            'hidream-i1-full' (high detail).
        width: Image width in pixels (default 1024). Common: 512, 768, 1024, 1280, 1536.
        height: Image height in pixels (default 1024). Common: 512, 768, 1024, 1280, 1536.
        steps: Diffusion steps, higher = more detail but slower (default 25, range 1–50).
        style_preset: Optional style preset. Options: 'ANIME', 'CINEMATIC', 'DIGITAL_ART',
            'ENHANCE', 'FANTASY_ART', 'ISOMETRIC', 'LINE_ART', 'LOW_POLY',
            'NEON_PUNK', 'ORIGAMI', 'PHOTOGRAPHIC', 'PIXEL_ART', 'TILE_TEXTURE'.
        negative_prompt: What to exclude from the image (e.g. 'blurry, low quality').
        safe_mode: Whether to apply content safety filtering (default False).
        enhance_prompt: Whether Venice should auto-enhance the prompt (default True).
        filename: Optional output filename without extension (saved to sandbox/user_data/).

    Returns:
        dict with 'file_path', 'filename', and 'message'.
    """
    venice_params: dict = {
        "safe_mode": safe_mode,
        "enhance_prompt": enhance_prompt,
    }
    if style_preset:
        venice_params["style_preset"] = style_preset
    if negative_prompt:
        venice_params["negative_prompt"] = negative_prompt

    payload: dict = {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": f"{width}x{height}",
        "response_format": "b64_json",
        "venice_parameters": {
            **venice_params,
            "steps": steps,
        },
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{VENICE_API_BASE}/images/generations",
            headers=_headers(),
            json=payload,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Venice image generation failed ({response.status_code}): {response.text}"
            )
        data = response.json()

    b64 = data["data"][0].get("b64_json")
    if not b64:
        raise RuntimeError("Venice API did not return base64 image data.")

    out_dir = _ensure_user_data()
    base = filename or f"venice_image_{_timestamp()}"
    out_path = out_dir / f"{base}.png"
    out_path.write_bytes(base64.b64decode(b64))

    rel = f"sandbox/user_data/{out_path.name}"
    return {
        "file_path": rel,
        "filename": out_path.name,
        "message": f"Image generated and saved to {rel}",
    }


# ── Image upscaling ───────────────────────────────────────────────────────────

async def venice_upscale_image(
    image_path: str,
    scale: int = 2,
    filename: str | None = None,
) -> dict:
    """Upscale an image using Venice AI's upscaling API.

    Args:
        image_path: Path to the image file, relative to the repo root
            (e.g. 'sandbox/user_data/image.png') or an absolute path.
        scale: Upscale factor (2 or 4, default 2).
        filename: Optional output filename without extension.

    Returns:
        dict with 'file_path', 'filename', and 'message'.
    """
    src = Path(image_path)
    if not src.is_absolute():
        src = _REPO_ROOT / src
    if not src.exists():
        raise FileNotFoundError(f"Image not found: {src}")

    image_bytes = src.read_bytes()
    mime = "image/png" if src.suffix.lower() == ".png" else "image/jpeg"

    headers = {
        "Authorization": f"Bearer {os.environ.get('VENICE_API_KEY', '')}",
    }
    if not os.environ.get("VENICE_API_KEY"):
        raise ValueError("VENICE_API_KEY is not set.")

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{VENICE_API_BASE}/images/upscale",
            headers=headers,
            files={"image": (src.name, image_bytes, mime)},
            data={"scale": str(scale)},
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Venice image upscaling failed ({response.status_code}): {response.text}"
            )
        result_bytes = response.content

    out_dir = _ensure_user_data()
    base = filename or f"{src.stem}_upscaled_{scale}x_{_timestamp()}"
    ext = src.suffix or ".png"
    out_path = out_dir / f"{base}{ext}"
    out_path.write_bytes(result_bytes)

    rel = f"sandbox/user_data/{out_path.name}"
    return {
        "file_path": rel,
        "filename": out_path.name,
        "message": f"Image upscaled {scale}x and saved to {rel}",
    }


# ── Text to speech ────────────────────────────────────────────────────────────

async def venice_text_to_speech(
    text: str,
    voice: str = "af_sky",
    model: str = "tts-kokoro",
    speed: float = 1.0,
    response_format: str = "mp3",
    filename: str | None = None,
) -> dict:
    """Convert text to speech using Venice AI's TTS API and save the audio to the sandbox.

    Args:
        text: The text to convert to speech (max ~4000 characters recommended).
        voice: Voice ID. Venice voices: 'af_sky' (warm female), 'af_bella' (expressive female),
            'af_nicole' (soft female), 'af_sarah', 'af_nova', 'am_adam' (male),
            'am_michael', 'am_echo'. OpenAI-compatible: 'alloy', 'echo', 'fable',
            'onyx', 'nova', 'shimmer'.
        model: TTS model. Use 'tts-kokoro' (default, Venice-native, high quality).
        speed: Speech speed multiplier (0.25–4.0, default 1.0).
        response_format: Audio format: 'mp3' (default), 'opus', 'aac', 'flac', 'wav', 'pcm'.
        filename: Optional output filename without extension.

    Returns:
        dict with 'file_path', 'filename', and 'message'.
    """
    payload = {
        "model": model,
        "input": text,
        "voice": voice,
        "speed": speed,
        "response_format": response_format,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{VENICE_API_BASE}/audio/speech",
            headers=_headers(),
            json=payload,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Venice TTS failed ({response.status_code}): {response.text}"
            )
        audio_bytes = response.content

    out_dir = _ensure_user_data()
    base = filename or f"venice_speech_{_timestamp()}"
    out_path = out_dir / f"{base}.{response_format}"
    out_path.write_bytes(audio_bytes)

    rel = f"sandbox/user_data/{out_path.name}"
    return {
        "file_path": rel,
        "filename": out_path.name,
        "message": f"Audio saved to {rel}",
    }


# ── Embeddings ────────────────────────────────────────────────────────────────

async def venice_embed(
    texts: list[str],
    model: str = "text-embedding-bge-m3",
) -> dict:
    """Generate vector embeddings using Venice AI's embeddings API.

    Args:
        texts: List of strings to embed (max 2048 tokens each).
        model: Embedding model. Use 'text-embedding-bge-m3' (default, multilingual,
            1024 dimensions) or 'text-embedding-nomic-embed-text-v1.5' (768 dims).

    Returns:
        dict with 'embeddings' (list of float vectors), 'model', and 'usage'.
    """
    payload = {
        "model": model,
        "input": texts,
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{VENICE_API_BASE}/embeddings",
            headers=_headers(),
            json=payload,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Venice embeddings failed ({response.status_code}): {response.text}"
            )
        data = response.json()

    embeddings = [item["embedding"] for item in data["data"]]
    return {
        "embeddings": embeddings,
        "model": data.get("model", model),
        "usage": data.get("usage", {}),
        "dimensions": len(embeddings[0]) if embeddings else 0,
    }


# ── List Venice models ────────────────────────────────────────────────────────

async def venice_list_models(
    model_type: str = "text",
) -> dict:
    """List available models on Venice AI.

    Args:
        model_type: Filter by type: 'text' (LLMs), 'image' (image generation),
            'embedding', 'tts', or 'all' (no filter).

    Returns:
        dict with 'models' list and 'count'.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{VENICE_API_BASE}/models",
            headers=_headers(),
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Venice models list failed ({response.status_code}): {response.text}"
            )
        data = response.json()

    all_models = data.get("data", [])

    if model_type != "all":
        type_map = {
            "text": ["text"],
            "image": ["image"],
            "embedding": ["embedding", "embeddings"],
            "tts": ["tts", "audio"],
        }
        allowed = type_map.get(model_type, [model_type])
        all_models = [
            m for m in all_models
            if any(t in (m.get("type", "") or m.get("object", "")).lower() for t in allowed)
            or any(t in m.get("id", "").lower() for t in allowed)
        ]

    model_summaries = [
        {
            "id": m.get("id"),
            "type": m.get("type") or m.get("object"),
            "context_length": m.get("context_length"),
            "max_tokens": m.get("max_tokens"),
        }
        for m in all_models
    ]

    return {"models": model_summaries, "count": len(model_summaries)}
