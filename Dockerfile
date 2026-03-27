# ── Stage 1: Python dependency layer ─────────────────────────────────────────
FROM python:3.13-slim AS python-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev


# ── Stage 2: Node / frontend build ───────────────────────────────────────────
FROM node:20-slim AS frontend-build

WORKDIR /app/web

COPY web/package*.json ./
RUN npm ci --silent

COPY web/ ./
COPY pyproject.toml ../pyproject.toml

RUN npm run build


# ── Stage 3: Final runtime image ──────────────────────────────────────────────
FROM python:3.13-slim

WORKDIR /app

# Runtime system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install a specific LTS Node version for Gemini CLI compatibility
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Install Gemini CLI globally
RUN npm install -g @google/gemini-cli --silent

# Copy Python virtual env from build stage
COPY --from=python-deps /app/.venv /app/.venv
ENV VIRTUAL_ENV=/app/.venv
ENV PATH="/app/.venv/bin:$PATH"

# Copy application source
COPY . .

# Copy built Next.js app
COPY --from=frontend-build /app/web/.next /app/web/.next
COPY --from=frontend-build /app/web/node_modules /app/web/node_modules

# Pre-create sandbox directories (skills downloaded at container start)
RUN mkdir -p sandbox/user_data sandbox/.gemini/skills user_config

# Expose the frontend port (Railway routes external traffic here)
EXPOSE 3000

ENV RAILWAY=1

CMD ["bash", "start_railway.sh"]
