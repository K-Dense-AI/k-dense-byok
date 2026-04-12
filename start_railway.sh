#!/usr/bin/env bash
# Railway deployment startup script.
# All three services (LiteLLM proxy, FastAPI backend, Next.js frontend) run
# in the same container. Railway routes external traffic to $PORT (Next.js).
# The backend (8000) and proxy (4000) are internal only.
set -e

cd "$(dirname "$0")"

export PATH="/root/.local/bin:/app/.venv/bin:$PATH"

echo "============================================"
echo "  Kady — Railway startup"
echo "============================================"

# ── Sandbox preparation ───────────────────────────────────────────────────────
# Skip the slow scientific-skills download on Railway to keep startup fast.
# Set DOWNLOAD_SKILLS=1 in Railway env vars to enable it on first boot.
echo "Preparing sandbox..."
if [ "${DOWNLOAD_SKILLS:-0}" = "1" ]; then
    python prep_sandbox.py
else
    SKIP_SKILL_DOWNLOAD=1 python prep_sandbox.py
fi

echo

# ── LiteLLM proxy ─────────────────────────────────────────────────────────────
echo "  → LiteLLM proxy on port 4000"
litellm --config litellm_config.yaml --port 4000 &
LITELLM_PID=$!
sleep 3

# ── FastAPI backend ───────────────────────────────────────────────────────────
echo "  → Backend on port 8000"
uvicorn server:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# ── Next.js frontend ──────────────────────────────────────────────────────────
# Railway assigns $PORT; default to 3000 for local Docker runs.
FRONTEND_PORT="${PORT:-3000}"
echo "  → Frontend on port ${FRONTEND_PORT}"
cd web && PORT="${FRONTEND_PORT}" npm start &
FRONTEND_PID=$!

echo
echo "============================================"
echo "  All services running (Railway mode)"
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo "  Backend:  http://localhost:8000"
echo "  Proxy:    http://localhost:4000"
echo "============================================"

trap "kill $LITELLM_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
