# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --no-audit --no-fund

COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web --no-audit --no-fund

COPY . .

ARG NEXT_PUBLIC_ADK_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_ADK_API_URL=${NEXT_PUBLIC_ADK_API_URL}
RUN npm --prefix web run build

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/K-Dense-AI/k-dense-byok" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

ENV NODE_ENV=production \
    HOME=/home/node \
    KADY_HOST=0.0.0.0 \
    KADY_PORT=8000 \
    KADY_FRONTEND_PORT=3000 \
    KADY_PROJECTS_ROOT=/data/projects \
    KADY_PI_AGENT_DIR=/home/node/.kady/pi-agent

WORKDIR /app
COPY --from=build --chown=node:node /app /app

RUN mkdir -p /data/projects /home/node/.kady \
    && chown -R node:node /data/projects /home/node/.kady \
    && chmod +x /app/scripts/docker-entrypoint.sh

USER node

VOLUME ["/data/projects", "/home/node/.kady"]
EXPOSE 3000 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=3m --retries=5 \
  CMD curl -fsS http://127.0.0.1:8000/health >/dev/null \
   && curl -fsS http://127.0.0.1:3000/ >/dev/null \
   || exit 1

ENTRYPOINT ["tini", "--", "/app/scripts/docker-entrypoint.sh"]
