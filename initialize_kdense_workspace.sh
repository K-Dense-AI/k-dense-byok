#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${KDENSE_WORKSPACE_ROOT:-}" ]; then
    export KDENSE_WORKSPACE_ROOT="$(pwd)"
fi

echo "============================================"
echo "  K-Dense — Initializing workspace"
echo "============================================"
echo

echo "Checking initialization dependencies..."

if ! command -v uv &>/dev/null; then
    echo "  uv not found — installing (Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
else
    echo "  uv ✓"
fi

if ! command -v gemini &>/dev/null; then
    if ! command -v npm &>/dev/null; then
        echo "  Gemini CLI is missing and npm is unavailable to install it."
        exit 1
    fi
    echo "  Gemini CLI not found — installing (used to run expert tasks)..."
    npm install -g @google/gemini-cli
else
    echo "  Gemini CLI ✓"
fi

echo
echo "Installing root Python packages..."
uv sync --quiet

if [ -f "kady_agent/.env" ]; then
    echo "Loading environment from kady_agent/.env..."
    set -a
    # shellcheck disable=SC1091
    source kady_agent/.env
    set +a
else
    echo "kady_agent/.env not found — continuing with the current shell environment and initialization defaults."
fi

echo "Preparing sandbox runtime (sandbox/.venv, .gemini/settings.json, scientific skills)..."
uv run python prep_sandbox.py

echo
echo "============================================"
echo "  K-Dense workspace initialization complete"
echo "============================================"
