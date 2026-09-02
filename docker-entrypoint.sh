#!/usr/bin/env sh
# Kady container entrypoint.
#
# Default (`docker compose up`): runs `node start.mjs --no-browser`, which
# installs the pinned harness, preps projects + skills, frees the ports, and
# starts BOTH services (backend + frontend), forwarding SIGTERM/SIGINT so the
# container stops cleanly.
#
# If run as root (the default), it fixes ownership of the mounted data dirs —
# this is what lets you bind-mount `./projects` without manual chown'ing on
# Linux — then DROPS privileges to the `node` user so the agent's bash/python
# sandbox never runs as root, before exec'ing the command.
#
# Override the command to run a one-off, e.g.:
#   docker compose run --rm kady sh -c "npm --prefix server run prep"
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
