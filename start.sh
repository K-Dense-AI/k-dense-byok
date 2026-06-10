#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "============================================"
echo "  Kady — Starting up"
echo "============================================"
echo

# ---- Step 1: Check & install missing tools ----

echo "Checking dependencies..."

# Node.js — runs the backend, the frontend, and the embedded Pi agent.
if ! command -v node &>/dev/null; then
    if ! command -v brew &>/dev/null; then
        echo "  Node.js not found and Homebrew is not available to install it."
        echo "  Please install Node.js (>= 22.19) manually: https://nodejs.org/"
        exit 1
    fi
    echo "  Node.js not found — installing via Homebrew..."
    brew install node
else
    NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
    NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
    echo "  Node.js ✓ ($(node -v))"
    if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
        echo "  ⚠ Pi recommends Node >= 22.19; you have $(node -v). It usually still works."
    fi
fi

# uv — the agent runs all sandbox Python through uv (`uv run`, `uv add`).
# Without it, every Python task the agent attempts will fail.
if command -v uv &>/dev/null || [ -x "$HOME/.local/bin/uv" ]; then
    echo "  uv ✓"
else
    echo "  uv not found — installing..."
    if command -v brew &>/dev/null; then
        brew install uv
    else
        curl -LsSf https://astral.sh/uv/install.sh | sh
    fi
fi
# The official installer puts uv in ~/.local/bin; make it visible to the
# backend and the sandbox sessions we spawn below.
export PATH="$HOME/.local/bin:$PATH"

# git — used to download the scientific skills catalogue during prep.
if command -v git &>/dev/null; then
    echo "  git ✓"
else
    echo "  ⚠ git not found — the skills catalogue download will be skipped."
    echo "    Install git (e.g. 'xcode-select --install' on macOS) to get skills."
fi

# python3 — only used for the .h5ad file-preview helper; everything else
# goes through uv. Warn, don't block.
if command -v python3 &>/dev/null; then
    echo "  python3 ✓"
else
    echo "  ⚠ python3 not found — .h5ad previews in the file panel won't work."
fi

# Pi itself needs no separate install: it's an npm dependency of server/
# (@earendil-works/pi-coding-agent), installed/updated by npm install below.
echo "  Pi agent ✓ (bundled with backend packages — no global install needed)"

echo

# ---- Step 2: Install / update packages ----
# npm install is idempotent: first run installs everything (including the Pi
# SDK), later runs pick up dependency changes after a git pull.

echo "Installing backend packages..."
(cd server && npm install --silent)

echo "Installing frontend packages..."
(cd web && npm install --silent)

echo

# ---- Step 3: Environment variables ----
# Keys live in a root .env (or kady_agent/.env, the legacy location). The
# backend auto-loads these via src/env.ts; exporting here covers the frontend
# and any child processes too.

if [ ! -f .env ] && [ ! -f kady_agent/.env ] && [ -f .env.example ]; then
    echo "No .env found — creating one from .env.example."
    cp .env.example .env
    echo "  → Edit .env and set OPENROUTER_API_KEY (or run a local Ollama)."
fi

if [ -f .env ]; then
    echo "Loading environment from .env..."
    set -a; source .env; set +a
elif [ -f kady_agent/.env ]; then
    echo "Loading environment from kady_agent/.env..."
    set -a; source kady_agent/.env; set +a
fi

# Sanity check: the agent needs OpenRouter or a reachable Ollama to do anything.
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
if [ -z "$OPENROUTER_API_KEY" ]; then
    if curl -s --max-time 2 "$OLLAMA_URL/api/tags" &>/dev/null; then
        echo "  No OPENROUTER_API_KEY set — using local Ollama at $OLLAMA_URL."
    else
        echo
        echo "  ⚠ No OPENROUTER_API_KEY in .env and no Ollama at $OLLAMA_URL."
        echo "    The UI will start, but the agent cannot run until you either:"
        echo "      - add OPENROUTER_API_KEY to .env (https://openrouter.ai/keys), or"
        echo "      - start a local Ollama (https://ollama.com) with a pulled model."
        echo
    fi
fi

# ---- Step 4: Prepare projects + skills ----

echo "Preparing projects (ensures default project, downloads scientific skills from K-Dense)..."
(cd server && npm run prep --silent) || echo "  (skills download skipped/failed — continuing)"

echo

# ---- Step 5: Start services ----

echo "Starting services..."
echo

echo "  → Backend on port 8000 (Pi agent, TypeScript)"
(cd server && npm run start) &
BACKEND_PID=$!

echo "  → Frontend on port 3000 (Next.js UI)"
(cd web && npm run dev) &
FRONTEND_PID=$!

echo
echo "============================================"
echo "  All services running!"
echo "  UI: http://localhost:3000"
echo "  Press Ctrl+C to stop everything"
echo "============================================"

(
  sleep 3
  if command -v open &>/dev/null; then
    open "http://localhost:3000"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:3000" &>/dev/null
  fi
) &

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
