#!/usr/bin/env bash
set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-8000}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
REQUESTED_OWNER="${KDENSE_RUNTIME_OWNER:-}"
KDENSE_RUNTIME_FORCE="${KDENSE_RUNTIME_FORCE:-0}"
KDENSE_RUNTIME_STATE_FILE="${KDENSE_RUNTIME_STATE_FILE:-/tmp/kdense-backend-${BACKEND_PORT}-${LITELLM_PORT}.env}"

kill_if_running() {
  local pid="$1"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

STATE_OWNER=""
BACKEND_PID=""
LITELLM_PID=""

if [ -f "$KDENSE_RUNTIME_STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$KDENSE_RUNTIME_STATE_FILE"
  STATE_OWNER="${KDENSE_RUNTIME_OWNER:-}"
fi

ALLOW_STOP=0
if [ "$KDENSE_RUNTIME_FORCE" = "1" ]; then
  ALLOW_STOP=1
elif [ -n "$REQUESTED_OWNER" ] && [ -n "$STATE_OWNER" ] && [ "$REQUESTED_OWNER" = "$STATE_OWNER" ]; then
  ALLOW_STOP=1
fi

if [ "$ALLOW_STOP" = "1" ]; then
  kill_if_running "${LITELLM_PID:-}"
  kill_if_running "${BACKEND_PID:-}"

  if [ "$KDENSE_RUNTIME_FORCE" = "1" ]; then
    pkill -f "litellm --config litellm_config.yaml --port ${LITELLM_PORT}" 2>/dev/null || true
    pkill -f "uvicorn server:app --port ${BACKEND_PORT}" 2>/dev/null || true
  fi

  rm -f "$KDENSE_RUNTIME_STATE_FILE"
fi
