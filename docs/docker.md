# Docker

K-Dense BYOK can run as a single Docker container containing both the Next.js UI and TypeScript backend. The image includes Node.js, git, Python, and `uv`; scientific Python environments and the skills catalogue are prepared on first start just like the native launcher.

## Docker Compose

From the repository root:

```bash
cp .env.example .env   # optional; add provider keys if you use them
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). The backend is published on port 8000 for the browser UI.

Compose uses the pre-built `ghcr.io/k-dense-ai/k-dense-byok:latest` image when available. To build the current checkout instead:

```bash
docker compose build
docker compose up -d
```

Project data is bind-mounted to `./projects`, so deleting or replacing the container does not delete your work. Provider OAuth state, settings, and the shared skills cache live in the named `kady-state` volume.

Useful commands:

```bash
docker compose logs -f
docker compose restart
docker compose pull && docker compose up -d
docker compose down
```

`docker compose down` keeps both `./projects` and the `kady-state` volume. Add `-v` only when you intentionally want to delete the Docker-managed Kady state, including stored provider logins.

## Docker run

The published image can also be run without Compose:

```bash
docker run --rm -it \
  --name kady \
  -p 3000:3000 \
  -p 8000:8000 \
  --env-file .env \
  -e KADY_HOST=0.0.0.0 \
  -e KADY_PORT=8000 \
  -e KADY_FRONTEND_PORT=3000 \
  -e KADY_PROJECTS_ROOT=/data/projects \
  -e KADY_PI_AGENT_DIR=/home/node/.kady/pi-agent \
  -v "$PWD/projects:/data/projects" \
  -v kady-state:/home/node/.kady \
  ghcr.io/k-dense-ai/k-dense-byok:latest
```

Omit `--env-file .env` when the file does not exist and configure model access later in Settings.

## Local model servers

A container has its own loopback interface. If Ollama, LM Studio, or another local model server runs on the host, use `host.docker.internal` instead of `localhost` in `.env. Docker Compose already adds the Linux host-gateway mapping as well as using Docker Desktop's built-in mapping:

```bash
OLLAMA_BASE_URL=http://host.docker.internal:11434
OPENAI_COMPATIBLE_BASE_URL=http://host.docker.internal:1234
```

For a direct `docker run` on Linux, add:

```bash
--add-host=host.docker.internal:host-gateway
```

## Ports and remote access

The container listens internally on ports 3000 and 8000. With Compose you can move the UI to another host port without rebuilding:

```bash
KADY_FRONTEND_PORT=3100 docker compose up -d
```

The pre-built frontend targets `http://localhost:8000`, so Compose keeps the backend published on host port 8000. If you need a different public backend URL, including access from another machine, build the image with that URL and publish the matching backend port. For example:

```bash
docker build \
  --build-arg NEXT_PUBLIC_ADK_API_URL=http://localhost:8100 \
  -t kady-custom .
docker run --rm -p 3000:3000 -p 8100:8000 kady-custom
```

## Image publishing

The repository Docker workflow builds both `linux/amd64` and `linux/arm64`. Pull requests validate the image build. Commits merged to `main` publish two GHCR tags: `latest` and the version from `server/package.json`, for example `v0.9.14`.
