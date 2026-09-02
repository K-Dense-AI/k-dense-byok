#!/usr/bin/env bash
set -Eeuo pipefail

backend_pid=""
frontend_pid=""

shutdown() {
  trap - INT TERM EXIT
  [[ -n "$backend_pid" ]] && kill -TERM "$backend_pid" 2>/dev/null || true
  [[ -n "$frontend_pid" ]] && kill -TERM "$frontend_pid" 2>/dev/null || true
  [[ -n "$backend_pid" ]] && wait "$backend_pid" 2>/dev/null || true
  [[ -n "$frontend_pid" ]] && wait "$frontend_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

mkdir -p "${KADY_PROJECTS_ROOT:-/data/projects}" "${KADY_PI_AGENT_DIR:-$HOME/.kady/pi-agent}"

# Keep first-run setup identical to the native launcher: create the default
# project, seed skills, and prepare the uv-managed Python environments.
npm --prefix /app/server run prep --silent

npm --prefix /app/server run start &
backend_pid=$!

npm --prefix /app/web run start -- --hostname 0.0.0.0 --port "${KADY_FRONTEND_PORT:-3000}" &
frontend_pid=$!

# Exit the container if either long-running service exits. The trap then stops
# the sibling cleanly so Docker can restart the whole application as one unit.
wait -n "$backend_pid" "$frontend_pid"
status=$?
exit "$status"
