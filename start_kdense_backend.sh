#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${KDENSE_WORKSPACE_ROOT:-}" ]; then
    export KDENSE_WORKSPACE_ROOT="$(pwd)"
fi

echo "============================================"
echo "  K-Dense — Starting backend services"
echo "============================================"
echo

if [ -f "kady_agent/.env" ]; then
    echo "Loading environment from kady_agent/.env..."
    set -a
    # shellcheck disable=SC1091
    source kady_agent/.env
    set +a
else
    echo "kady_agent/.env not found — continuing with the current shell environment and backend defaults."
fi

BACKEND_PORT="${BACKEND_PORT:-8000}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
BACKEND_URL="http://localhost:${BACKEND_PORT}"
LITELLM_URL="http://localhost:${LITELLM_PORT}"

if [ -z "${GOOGLE_GEMINI_BASE_URL:-}" ] || [ "${GOOGLE_GEMINI_BASE_URL%/}" = "http://localhost:4000" ]; then
    export GOOGLE_GEMINI_BASE_URL="$LITELLM_URL"
fi

if [ -z "${BACKEND_CORS_ALLOWED_ORIGINS:-}" ]; then
    export BACKEND_CORS_ALLOWED_ORIGINS="vscode-webview://*"
fi

echo "Starting LiteLLM on port ${LITELLM_PORT}..."
uv run litellm --config litellm_config.yaml --port "$LITELLM_PORT" &
LITELLM_PID=$!
sleep 2

echo "Starting backend on port ${BACKEND_PORT}..."
uv run uvicorn server:app --port "$BACKEND_PORT" &
BACKEND_PID=$!

echo
echo "============================================"
echo "  Backend stack running"
echo "  Backend: ${BACKEND_URL}"
echo "  LiteLLM: ${LITELLM_URL}"
echo "  Press Ctrl+C to stop everything"
echo "============================================"

cleanup() {
  kill "$LITELLM_PID" "$BACKEND_PID" 2>/dev/null || true
  exit 0
}

trap 'cleanup' INT TERM
wait
