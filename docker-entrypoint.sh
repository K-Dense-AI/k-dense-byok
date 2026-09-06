#!/usr/bin/env sh
# Runs `node start.mjs --no-browser` (both services) by default; override the
# command for one-offs, e.g. `docker compose run --rm kady npm --prefix server run prep`.
# When root, fixes bind-mount ownership then drops to the `node` user.
set -eu

data_dirs="${KADY_PROJECTS_ROOT} ${KADY_PI_AGENT_DIR} ${KADY_SKILLS_CACHE_DIR}"

if [ "$(id -u)" = "0" ]; then
  # shellcheck disable=SC2086
  mkdir -p ${data_dirs}
  # shellcheck disable=SC2086
  chown -R node:node ${data_dirs}
  exec setpriv --reuid=node --regid=node --clear-groups "$@"
fi

# shellcheck disable=SC2086
mkdir -p ${data_dirs}
exec "$@"
