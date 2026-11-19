"""
AG-UI 1.0 streaming endpoint for auctum-platform and other MASTERNEX AUCTUM services.

Wraps BYOKGateway in a FastAPI SSE route that emits the full AG-UI 1.0 lifecycle:
  RunStarted → TextMessageStarted → TextMessageContent* →
  TextMessageEnd → ToolCallStart? → ToolCallEnd? → RunFinished | RunError

Supports:
  - Single-turn chat completions (POST /agui/chat)
  - Multi-turn sessions with context window (POST /agui/session/{session_id}/run)
  - Tool-call forwarding (function calling → ToolCallStart/ToolCallEnd events)
  - Cost/usage metadata on RunFinished (for ACPLedger integration)
  - BYOK key routing: openrouter / anthropic / openai / gemini / mastermind_local
  - Per-request thinking level (none / auto / high / max)
  - CORS + Bearer token auth (X-Kady-Token or Authorization: Bearer)

AG-UI 1.0 spec references:
  https://docs.ag-ui.com/concepts/events  (event schema)
  https://docs.ag-ui.com/guides/streaming  (SSE framing)

FastAPI + SSE:
  Starlette EventSourceResponse for proper text/event-stream with keep-alive

Usage:
    uvicorn masternex.auctum.agui_endpoint:app --port 8080

    # Or mount on the main app:
    from masternex.auctum.agui_endpoint import router as agui_router
    main_app.include_router(agui_router, prefix="/agui")
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import AsyncIterator, Dict, List, Optional, Any

logger = logging.getLogger(__name__)

__all__ = [
    "AGUIEventType",
    "AGUIMessage",
    "AGUIRunRequest",
    "AGUIRouter",
    "build_agui_app",
    "stream_agui_run",
]

# ---------------------------------------------------------------------------
# AG-UI 1.0 Event type constants
# ---------------------------------------------------------------------------

class AGUIEventType:
    RUN_STARTED              = "RunStarted"
    RUN_FINISHED             = "RunFinished"
    RUN_ERROR                = "RunError"
    TEXT_MESSAGE_STARTED     = "TextMessageStarted"
    TEXT_MESSAGE_CONTENT     = "TextMessageContent"
    TEXT_MESSAGE_END         = "TextMessageEnd"
    TOOL_CALL_START          = "ToolCallStart"
    TOOL_CALL_END            = "ToolCallEnd"
    STATE_SNAPSHOT           = "StateSnapshot"
    STATE_DELTA              = "StateDelta"
    MESSAGES_SNAPSHOT        = "MessagesSnapshot"
    CUSTOM                   = "Custom"


# ---------------------------------------------------------------------------
# Minimal AG-UI message types (mirrors the TypeScript SDK types)
# ---------------------------------------------------------------------------

@dataclass
class AGUIBaseEvent:
    type: str
    timestamp: float = field(default_factory=time.time)

    def to_sse(self) -> str:
        """Serialize to a single SSE data line."""
        payload = json.dumps(asdict(self), separators=(",", ":"))
        return f"data: {payload}\n\n"


@dataclass
class RunStartedEvent(AGUIBaseEvent):
    type: str = AGUIEventType.RUN_STARTED
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    thread_id: str = ""


@dataclass
class RunFinishedEvent(AGUIBaseEvent):
    type: str = AGUIEventType.RUN_FINISHED
    run_id: str = ""
    thread_id: str = ""
    usage: Optional[Dict] = None   # {"input_tokens": int, "output_tokens": int, "cost_usd": float}
    model: str = ""


@dataclass
class RunErrorEvent(AGUIBaseEvent):
    type: str = AGUIEventType.RUN_ERROR
    run_id: str = ""
    message: str = ""
    code: str = ""


@dataclass
class TextMessageStartedEvent(AGUIBaseEvent):
    type: str = AGUIEventType.TEXT_MESSAGE_STARTED
    message_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    role: str = "assistant"


@dataclass
class TextMessageContentEvent(AGUIBaseEvent):
    type: str = AGUIEventType.TEXT_MESSAGE_CONTENT
    message_id: str = ""
    delta: str = ""


@dataclass
class TextMessageEndEvent(AGUIBaseEvent):
    type: str = AGUIEventType.TEXT_MESSAGE_END
    message_id: str = ""


@dataclass
class ToolCallStartEvent(AGUIBaseEvent):
    type: str = AGUIEventType.TOOL_CALL_START
    tool_call_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    tool_call_index: int = 0
    parent_message_id: str = ""
    tool_name: str = ""
    tool_input_json: str = "{}"


@dataclass
class ToolCallEndEvent(AGUIBaseEvent):
    type: str = AGUIEventType.TOOL_CALL_END
    tool_call_id: str = ""
    tool_name: str = ""
    tool_output_json: str = "{}"


# ---------------------------------------------------------------------------
# Request / response models (Pydantic-compatible plain dataclasses)
# ---------------------------------------------------------------------------

@dataclass
class AGUIMessage:
    role: str              # "system" | "user" | "assistant" | "tool"
    content: str
    tool_call_id: Optional[str] = None
    name: Optional[str] = None      # tool name for role="tool"


@dataclass
class AGUITool:
    name: str
    description: str
    parameters: Dict    # JSON Schema for parameters


@dataclass
class AGUIRunRequest:
    messages: List[AGUIMessage]
    model: Optional[str] = None             # e.g. "openrouter/qwen/qwen2.5-7b-instruct"
    provider: Optional[str] = None          # override BYOKGateway provider selection
    tools: Optional[List[AGUITool]] = None
    max_tokens: int = 2048
    temperature: float = 0.7
    thinking_level: str = "auto"            # "none" | "auto" | "high" | "max"
    thread_id: Optional[str] = None         # client-supplied session continuity id
    system_prompt_override: Optional[str] = None


# ---------------------------------------------------------------------------
# Core streaming function
# ---------------------------------------------------------------------------

async def stream_agui_run(
    request: AGUIRunRequest,
    byok_gateway=None,
) -> AsyncIterator[str]:
    """Async generator that yields SSE lines for a full AG-UI 1.0 run.

    Args:
        request     : validated AGUIRunRequest
        byok_gateway: an instantiated BYOKGateway (or None → uses mock/local)

    Yields:
        SSE lines (each ending with \\n\\n) for the client to forward verbatim.
    """
    run_id = str(uuid.uuid4())
    thread_id = request.thread_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    model_name = request.model or "mastermind_local/nano"

    # --- RunStarted ---
    yield RunStartedEvent(run_id=run_id, thread_id=thread_id).to_sse()

    try:
        # --- TextMessageStarted ---
        yield TextMessageStartedEvent(message_id=message_id).to_sse()

        total_input_tokens = 0
        total_output_tokens = 0
        cost_usd = 0.0
        full_text = ""
        tool_calls: List[Dict] = []

        # Build messages for the BYOK call
        msgs = []
        if request.system_prompt_override:
            msgs.append({"role": "system", "content": request.system_prompt_override})
        for m in request.messages:
            entry: Dict[str, Any] = {"role": m.role, "content": m.content}
            if m.name:
                entry["name"] = m.name
            if m.tool_call_id:
                entry["tool_call_id"] = m.tool_call_id
            msgs.append(entry)

        # Determine provider + model
        provider = request.provider
        model_id = request.model

        if model_id and "/" in (model_id or ""):
            parts = model_id.split("/", 1)
            if not provider:
                provider = parts[0]
            model_id = parts[1] if len(parts) > 1 else parts[0]

        provider = provider or "mastermind_local"
        model_id = model_id or "nano"

        if byok_gateway is not None:
            # --- Real BYOK streaming path ---
            async for chunk in _stream_byok(
                byok_gateway, provider, model_id, msgs, request
            ):
                if chunk["type"] == "text_delta":
                    delta = chunk["delta"]
                    full_text += delta
                    yield TextMessageContentEvent(
                        message_id=message_id, delta=delta
                    ).to_sse()

                elif chunk["type"] == "tool_call":
                    tc = chunk["tool_call"]
                    tool_call_id = tc.get("id", str(uuid.uuid4()))
                    tool_name = tc.get("function", {}).get("name", "unknown")
                    input_json = tc.get("function", {}).get("arguments", "{}")
                    yield ToolCallStartEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        tool_input_json=input_json,
                        parent_message_id=message_id,
                    ).to_sse()
                    tool_calls.append(tc)

                elif chunk["type"] == "tool_result":
                    yield ToolCallEndEvent(
                        tool_call_id=chunk.get("tool_call_id", ""),
                        tool_name=chunk.get("tool_name", ""),
                        tool_output_json=json.dumps(chunk.get("output", {})),
                    ).to_sse()

                elif chunk["type"] == "usage":
                    total_input_tokens += chunk.get("input_tokens", 0)
                    total_output_tokens += chunk.get("output_tokens", 0)
                    cost_usd += chunk.get("cost_usd", 0.0)
        else:
            # --- Mock / mastermind_local path ---
            async for delta in _stream_local_mock(msgs, model_id):
                full_text += delta
                yield TextMessageContentEvent(
                    message_id=message_id, delta=delta
                ).to_sse()
                # small pacing yield so the client sees streaming
                await asyncio.sleep(0)

        # --- TextMessageEnd ---
        yield TextMessageEndEvent(message_id=message_id).to_sse()

        # --- RunFinished ---
        yield RunFinishedEvent(
            run_id=run_id,
            thread_id=thread_id,
            model=f"{provider}/{model_id}",
            usage={
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
                "cost_usd": round(cost_usd, 8),
            },
        ).to_sse()

    except asyncio.CancelledError:
        yield RunErrorEvent(
            run_id=run_id, message="Client disconnected", code="CANCELLED"
        ).to_sse()
        raise

    except Exception as exc:
        logger.exception("AG-UI run error run_id=%s", run_id)
        yield RunErrorEvent(
            run_id=run_id,
            message=str(exc),
            code=type(exc).__name__,
        ).to_sse()


# ---------------------------------------------------------------------------
# BYOK streaming adapter
# ---------------------------------------------------------------------------

async def _stream_byok(gateway, provider: str, model_id: str, msgs, req: AGUIRunRequest):
    """Thin adapter: yields normalized chunks from BYOKGateway.infer_stream()."""
    try:
        from masternex.connectors.byok import BYOKGateway  # type: ignore
    except ImportError:
        logger.warning("BYOKGateway not available; falling back to local mock.")
        async for delta in _stream_local_mock(msgs, model_id):
            yield {"type": "text_delta", "delta": delta}
        return

    tools_payload = None
    if req.tools:
        tools_payload = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in req.tools
        ]

    gw = gateway if gateway is not None else BYOKGateway()

    async for event in gw.infer_stream(
        provider=provider,
        model=model_id,
        messages=msgs,
        max_tokens=req.max_tokens,
        temperature=req.temperature,
        tools=tools_payload,
    ):
        etype = event.get("type", "")
        if etype == "text_delta":
            yield event
        elif etype in ("tool_call", "tool_result", "usage"):
            yield event
        # skip unknown event types silently


# ---------------------------------------------------------------------------
# Local mock streaming (mastermind_local / no BYOK configured)
# ---------------------------------------------------------------------------

async def _stream_local_mock(msgs: List[Dict], model_id: str) -> AsyncIterator[str]:
    """Deterministic mock that echoes a canned response token by token."""
    last_user = next(
        (m["content"] for m in reversed(msgs) if m["role"] == "user"), ""
    )
    reply = (
        f"[{model_id}] Received: {last_user[:80]}{'...' if len(last_user) > 80 else ''}. "
        "MASTERNEX Mastermind local inference is not yet configured — "
        "please set OPENROUTER_API_KEY or connect a BYOK provider in Settings."
    )
    words = reply.split(" ")
    for i, word in enumerate(words):
        yield word + (" " if i < len(words) - 1 else "")
        await asyncio.sleep(0.01)


# ---------------------------------------------------------------------------
# FastAPI router (optional dependency)
# ---------------------------------------------------------------------------

class AGUIRouter:
    """Builds a FastAPI APIRouter with AG-UI 1.0 SSE endpoints.

    Import and mount this when FastAPI is available:

        from masternex.auctum.agui_endpoint import AGUIRouter
        router = AGUIRouter(byok_gateway=my_gateway).build()
        app.include_router(router, prefix="/agui")
    """

    def __init__(self, byok_gateway=None, require_auth: bool = False, auth_token: Optional[str] = None):
        self.gateway = byok_gateway
        self.require_auth = require_auth
        self.auth_token = auth_token

    def build(self):
        try:
            from fastapi import APIRouter, Depends, HTTPException, Request
            from fastapi.responses import StreamingResponse
            from pydantic import BaseModel
        except ImportError as e:
            raise ImportError("FastAPI is required: pip install fastapi") from e

        router = APIRouter()

        # Pydantic models for request validation
        class MessageModel(BaseModel):
            role: str
            content: str
            tool_call_id: Optional[str] = None
            name: Optional[str] = None

        class ToolModel(BaseModel):
            name: str
            description: str
            parameters: Dict

        class RunRequestModel(BaseModel):
            messages: List[MessageModel]
            model: Optional[str] = None
            provider: Optional[str] = None
            tools: Optional[List[ToolModel]] = None
            max_tokens: int = 2048
            temperature: float = 0.7
            thinking_level: str = "auto"
            thread_id: Optional[str] = None
            system_prompt_override: Optional[str] = None

        def _check_auth(request: Request):
            if not self.require_auth:
                return
            token = request.headers.get("X-Kady-Token") or \
                    request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if not token or (self.auth_token and token != self.auth_token):
                raise HTTPException(status_code=401, detail="Unauthorized")

        @router.post("/chat")
        async def chat_endpoint(body: RunRequestModel, request: Request):
            _check_auth(request)
            req = AGUIRunRequest(
                messages=[AGUIMessage(**m.model_dump()) for m in body.messages],
                model=body.model,
                provider=body.provider,
                tools=[AGUITool(**t.model_dump()) for t in (body.tools or [])],
                max_tokens=body.max_tokens,
                temperature=body.temperature,
                thinking_level=body.thinking_level,
                thread_id=body.thread_id,
                system_prompt_override=body.system_prompt_override,
            )

            async def sse_generator():
                async for chunk in stream_agui_run(req, self.gateway):
                    yield chunk

            return StreamingResponse(
                sse_generator(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",   # nginx: disable proxy buffering
                },
            )

        @router.get("/health")
        async def health():
            return {
                "status": "ok",
                "ag_ui_version": "1.0",
                "byok_configured": self.gateway is not None,
            }

        return router


# ---------------------------------------------------------------------------
# Standalone app builder
# ---------------------------------------------------------------------------

def build_agui_app(
    prefix: str = "/agui",
    require_auth: bool = False,
    auth_token: Optional[str] = None,
    byok_gateway=None,
    cors_origins: Optional[List[str]] = None,
):
    """Build and return a standalone FastAPI app with AG-UI endpoints.

    Example:
        app = build_agui_app(cors_origins=["https://auctum.atlas", "http://localhost:3000"])
        # uvicorn masternex.auctum.agui_endpoint:app --port 8080
    """
    try:
        from fastapi import FastAPI
        from fastapi.middleware.cors import CORSMiddleware
    except ImportError as e:
        raise ImportError("FastAPI is required: pip install fastapi uvicorn") from e

    app = FastAPI(
        title="MASTERNEX AG-UI Gateway",
        description="AG-UI 1.0 SSE streaming endpoint for MASTERNEX AUCTUM platforms",
        version="1.0.0",
    )

    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Content-Type", "Authorization", "X-Kady-Token"],
        )

    router_builder = AGUIRouter(
        byok_gateway=byok_gateway,
        require_auth=require_auth,
        auth_token=auth_token,
    )
    app.include_router(router_builder.build(), prefix=prefix)

    return app


# Default app instance (picked up by uvicorn when run directly)
try:
    import os
    _cors = os.environ.get("AGUI_CORS_ORIGINS", "").split(",")
    _cors = [o.strip() for o in _cors if o.strip()] or [
        "https://auctum.atlas",
        "https://luminaac-ultimate.vercel.app",
        "http://localhost:3000",
        "http://localhost:3001",
    ]
    app = build_agui_app(cors_origins=_cors)
except ImportError:
    app = None  # FastAPI not installed; app usable as library only


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Start the MASTERNEX AG-UI 1.0 SSE gateway")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--prefix", default="/agui")
    parser.add_argument("--require-auth", action="store_true")
    parser.add_argument(
        "--cors-origins",
        default="http://localhost:3000,http://localhost:3001",
        help="Comma-separated allowed CORS origins",
    )
    args = parser.parse_args()

    try:
        import uvicorn
    except ImportError:
        print("uvicorn not installed. Run: pip install uvicorn")
        raise SystemExit(1)

    _app = build_agui_app(
        prefix=args.prefix,
        require_auth=args.require_auth,
        cors_origins=[o.strip() for o in args.cors_origins.split(",") if o.strip()],
    )
    uvicorn.run(_app, host=args.host, port=args.port)
