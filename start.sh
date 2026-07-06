#!/usr/bin/env bash
# Thin wrapper: make sure Node exists, then hand off to the cross-platform
# launcher (start.mjs). Windows users run start.cmd instead.
set -e
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
    if command -v brew &>/dev/null; then
        echo "Node.js not found — installing via Homebrew..."
        brew install node
    else
        echo "Node.js not found. Install Node.js >= 22 from https://nodejs.org/" >&2
        echo "(or via your version manager, e.g. 'nvm install 22'), then run ./start.sh again." >&2
        exit 1
    fi
fi

exec node start.mjs "$@"
