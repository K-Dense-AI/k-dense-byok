# syntax=docker/dockerfile:1
#
# Kady (K-Dense BYOK) — single-container image: the TS backend (Pi agent,
# :8000) and Next.js frontend (:3000) as start.mjs starts them, inside one
# isolated container so the agent sandbox (bash/python/latex) never runs as
# the host user and never sees the docker socket.
#
#   docker build -t kady:latest .                                     # with LaTeX
#   docker build --build-arg WITH_LATEX=0 -t kady:lite .              # without

ARG NODE_VERSION=22
# TeX Live for LaTeX compile + SyncTeX; set 0 for a smaller image (the app
# degrades gracefully when TeX is missing).
ARG WITH_LATEX=1

FROM node:${NODE_VERSION}-bookworm-slim AS base

# Redeclare: global ARGs only reach the FROM line.
ARG WITH_LATEX=1

# ---- OS packages ------------------------------------------------------------
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        lsof \
        util-linux \
        python3 \
        python3-pip \
        python3-venv; \
    if [ "${WITH_LATEX}" = "1" ]; then \
        apt-get install -y --no-install-recommends \
            texlive-latex-base \
            texlive-latex-recommended \
            texlive-latex-extra \
            texlive-fonts-recommended \
            lmodern \
            cm-super; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# uv — all sandbox Python (and the helper venv) runs through it.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# ---- Environment -------------------------------------------------------------
# Set before the build steps, not just for runtime: npm and uv key their caches
# off HOME. Listening on 0.0.0.0 is container-internal; compose still publishes
# 127.0.0.1 only. HOSTNAME=0.0.0.0 does the same for `next dev`.
ENV \
    HOME=/home/node \
    KADY_PROJECTS_ROOT=/data/projects \
    KADY_PI_AGENT_DIR=/data/config \
    KADY_SKILLS_CACHE_DIR=/data/config/skills-cache \
    KADY_HOST=0.0.0.0 \
    HOSTNAME=0.0.0.0

# Built as `node` throughout, into dirs it already owns. Chowning /app after
# the fact instead costs a 2.2 GB layer: chown rewrites metadata on every file,
# so Docker copies node_modules and the uv venv into a fresh layer.
RUN mkdir -p /app /data/projects /data/config/skills-cache \
    && chown -R node:node /app /data
USER node

# ---- Dependencies (layer-cached ahead of source) -----------------------------
WORKDIR /app

# Cache mounts keep npm's and uv's caches out of the image (~1.2 GB of bytes
# nothing at runtime reads) while still making rebuilds fast.
COPY --chown=node:node web/package.json web/package-lock.json ./web/
RUN --mount=type=cache,uid=1000,gid=1000,target=/home/node/.npm \
    cd web && npm ci --no-audit --no-fund

COPY --chown=node:node server/package.json server/package-lock.json ./server/
RUN --mount=type=cache,uid=1000,gid=1000,target=/home/node/.npm \
    cd server && npm ci --no-audit --no-fund

# ---- Source ------------------------------------------------------------------
COPY --chown=node:node . .

# Bake the scientific helper venv (numpy/anndata/rdkit/…) at build time.
RUN --mount=type=cache,uid=1000,gid=1000,target=/home/node/.cache/uv \
    cd server/src/helpers && uv sync

# Empty root .env stops start.mjs from copying .env.example over compose keys.
RUN touch /app/.env

# ---- Runtime -----------------------------------------------------------------
EXPOSE 3000 8000

# Back to root only for the entrypoint, which must start privileged to chown
# bind-mounted volumes before setpriv drops back to node.
USER root
COPY docker-entrypoint.sh /usr/local/bin/kady-entrypoint
RUN chmod +x /usr/local/bin/kady-entrypoint

ENTRYPOINT ["/usr/local/bin/kady-entrypoint"]
# Matches ./start.sh without opening a host browser.
CMD ["node", "start.mjs", "--no-browser"]
