#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "============================================"
echo "  Kady — Starting up"
echo "============================================"
echo

# ---- Step 1: Check & install missing tools ----

echo "Checking dependencies..."

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

echo

# ---- Step 2: Install packages ----

echo "Installing backend packages..."
(cd server && npm install --silent)

echo "Installing frontend packages..."
(cd web && npm install --silent)

echo

# ---- Step 3: Load environment variables ----
# Keys live in kady_agent/.env (legacy location, still honored) or a root .env.
# The backend also auto-loads these via src/env.ts; exporting here covers the
# frontend and any child processes too.
if [ -f kady_agent/.env ]; then
    echo "Loading environment from kady_agent/.env..."
    set -a; source kady_agent/.env; set +a
elif [ -f .env ]; then
    echo "Loading environment from .env..."
    set -a; source .env; set +a
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
