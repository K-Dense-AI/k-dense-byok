# syntax=docker/dockerfile:1
#
# Kady (K-Dense BYOK) — single-container image.
#
# Builds BOTH runtime services exactly as start.mjs starts them on a host —
# the TS backend (Pi agent, port 8000) and the Next.js frontend (port 3000) —
# inside one isolated container. The container is deliberately an OS-level
# boundary for the agent's bash/python/latex sandbox: agent tools never run
# as the host user and never see the docker socket.
#
# Build with LaTeX:        docker build -t kady:latest .
# Build WITHOUT LaTeX:     docker build --build-arg WITH_LATEX=0 -t kady:lite .

# ---- Build args -------------------------------------------------------------
ARG NODE_VERSION=22
# Include TeX Live (latexmk/pdflatex/synctex) for LaTeX compile + SyncTeX.
# Set to 0 for a smaller "lite" image; the app already degrades gracefully
# (compile returns a clean "compiler not found"; SyncTeX reports unavailable).
ARG WITH_LATEX=1

FROM node:${NODE_VERSION}-bookworm-slim AS base

# Redeclare so the stage RUN can use it (global ARGs only reach the FROM line).
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

# uv — the agent runs ALL sandbox Python through uv, and the backend shells
# into it for the scientific helper venv. Must be on PATH for every user.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# ---- Dependencies (layer-cached ahead of source) -----------------------------
WORKDIR /app

COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund

# ---- Source ------------------------------------------------------------------
COPY . .

# Bake the scientific file-preview helper venv (numpy/scipy/anndata/rdkit/
# gemmi/…) at build time so first boot doesn't need to download them.
RUN cd server/src/helpers && uv sync

# A present-but-empty root .env stops start.mjs from copying .env.example over
# the real API keys/env passed in from docker compose. All config stays
# external to the image.
RUN touch /app/.env

# ---- Runtime -----------------------------------------------------------------
# 0.0.0.0: the backend must listen on the container's network interface so the
# host-published port can reach it (binding 127.0.0.1 would be container-local
# only). Host ports are bound to 127.0.0.1 in compose, so this is still
# localhost-only from the host's perspective. HOSTNAME=0.0.0.0 tells `next dev`
# to do the same for the frontend.
ENV \
    HOME=/home/node \
    KADY_PROJECTS_ROOT=/data/projects \
    KADY_PI_AGENT_DIR=/data/config \
    KADY_SKILLS_CACHE_DIR=/data/config/skills-cache \
    KADY_HOST=0.0.0.0 \
    HOSTNAME=0.0.0.0

# Data dirs + writable app dir. Owned by `node` (uid 1000); the entrypoint
# re-fixes bind-mount ownership at runtime and drops privileges to node.
RUN mkdir -p /data/projects /data/config/skills-cache \
    && chown -R node:node /data /app

EXPOSE 3000 8000

COPY docker-entrypoint.sh /usr/local/bin/kady-entrypoint
RUN chmod +x /usr/local/bin/kady-entrypoint

ENTRYPOINT ["/usr/local/bin/kady-entrypoint"]
# Matches `./start.sh` but without trying to open a host browser. Installs the
# pinned harness, preps projects/skills, frees ports, starts both services.
CMD ["node", "start.mjs", "--no-browser"]
