#!/usr/bin/env bash
set -euo pipefail

cd /app
mkdir -p sandbox

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  >&2 printf '%s\n' "WARNING: OPENROUTER_API_KEY is not set. The backend can start and /health may still return OK, but model-backed requests will fail until a provider key is injected."
fi

if [[ -z "${DEFAULT_AGENT_MODEL:-}" ]]; then
  >&2 printf '%s\n' "WARNING: DEFAULT_AGENT_MODEL is not set. Agent model selection may fail until this variable is provided."
fi

if [[ -z "${GOOGLE_GEMINI_BASE_URL:-}" || -z "${GEMINI_API_KEY:-}" ]]; then
  >&2 printf '%s\n' "WARNING: GOOGLE_GEMINI_BASE_URL and/or GEMINI_API_KEY is not set. Gemini CLI and LiteLLM-backed expert flows will not work correctly until both variables are provided."
fi

uv run python prep_sandbox.py

exec "$@"
