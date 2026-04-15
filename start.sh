#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "============================================"
echo "  Kady — Starting up"
echo "============================================"
echo

# ---- Step 1: Check & install missing tools ----

echo "Checking dependencies..."

if ! command -v uv &>/dev/null; then
    echo "  uv not found — installing (Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
else
    echo "  uv ✓"
fi

if ! command -v node &>/dev/null; then
    if ! command -v brew &>/dev/null; then
        echo "  Node.js not found and Homebrew is not available to install it."
        echo "  Please install Node.js manually: https://nodejs.org/"
        exit 1
    fi
    echo "  Node.js not found — installing via Homebrew..."
    brew install node
else
    echo "  Node.js ✓"
fi

if ! command -v gemini &>/dev/null; then
    echo "  Gemini CLI not found — installing (used to run expert tasks)..."
    npm install -g @google/gemini-cli
else
    echo "  Gemini CLI found — updating to latest..."
    npm update -g @google/gemini-cli
    echo "  Gemini CLI ✓"
fi

echo

# ---- Step 2: Install project packages ----

echo "Installing Python packages..."
uv sync --quiet

echo "Installing frontend packages..."
(cd web && npm install --silent)

echo

# ---- Step 3: Load environment variables ----

if [ -f "kady_agent/.env" ]; then
    echo "Loading environment from kady_agent/.env..."
    set -a
    # shellcheck disable=SC1091
    source kady_agent/.env
    set +a
else
    echo "kady_agent/.env not found — continuing with the current shell environment and startup defaults."
fi

FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
LITELLM_PORT="${LITELLM_PORT:-4000}"

FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
BACKEND_URL="http://localhost:${BACKEND_PORT}"
LITELLM_URL="http://localhost:${LITELLM_PORT}"

if [ -z "${NEXT_PUBLIC_ADK_API_URL:-}" ] || [ "${NEXT_PUBLIC_ADK_API_URL%/}" = "http://localhost:8000" ]; then
    export NEXT_PUBLIC_ADK_API_URL="$BACKEND_URL"
fi

if [ -z "${BACKEND_CORS_ALLOWED_ORIGINS:-}" ] || [ "${BACKEND_CORS_ALLOWED_ORIGINS%/}" = "http://localhost:3000" ]; then
    export BACKEND_CORS_ALLOWED_ORIGINS="$FRONTEND_URL"
fi

if [ -z "${GOOGLE_GEMINI_BASE_URL:-}" ] || [ "${GOOGLE_GEMINI_BASE_URL%/}" = "http://localhost:4000" ]; then
    export GOOGLE_GEMINI_BASE_URL="$LITELLM_URL"
fi

# ---- Step 4: Prepare the sandbox ----

echo "Preparing sandbox (creates sandbox/ dir, downloads scientific skills from K-Dense)..."
uv run python prep_sandbox.py

echo

# ---- Step 5: Start all services ----

echo "Starting services..."
echo

echo "  → LiteLLM proxy on port ${LITELLM_PORT} (routes LLM calls to OpenRouter)"
uv run litellm --config litellm_config.yaml --port "$LITELLM_PORT" &
LITELLM_PID=$!
sleep 2

echo "  → Backend on port ${BACKEND_PORT} (FastAPI + ADK agent)"
uv run uvicorn server:app --reload --port "$BACKEND_PORT" &
BACKEND_PID=$!

echo "  → Frontend on port ${FRONTEND_PORT} (Next.js UI)"
(cd web && npm run dev -- --port "$FRONTEND_PORT") &
FRONTEND_PID=$!

echo
echo "============================================"
echo "  All services running!"
echo "  UI: ${FRONTEND_URL}"
if command -v open &>/dev/null || command -v xdg-open &>/dev/null; then
  echo "  Opening that URL in your default browser in a few seconds…"
fi
echo "  Press Ctrl+C to stop everything"
echo "============================================"

# Give Next.js a moment to bind, then open the app (non-blocking)
(
  sleep 3
  if command -v open &>/dev/null; then
    open "$FRONTEND_URL"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$FRONTEND_URL" &>/dev/null
  fi
) &

cleanup() {
  kill "$LITELLM_PID" "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}

trap 'cleanup' INT TERM
wait
