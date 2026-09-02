# Running Kady with Docker

Kady ships an optional single-container setup. It runs **both** services — the
TS backend (Pi agent, port `8000`) and the Next.js frontend (port `3000`) —
exactly as `./start.sh` starts them on a host, but inside one isolated
container. That isolation is the point: the agent's `bash`/Python/LaTeX
sandbox becomes an **OS-level boundary**, so agent tools never run as your OS
user and can't reach your host's files, keys, or (crucially) the Docker socket.

- `Dockerfile` — builds the image (LaTeX optional, see below).
- `docker-compose.yml` — the recommended way to run it.
- `docker-entrypoint.sh` — fixes data-volume ownership, drops privileges to a
  non-root `node` user, then starts both services.

> **Local models are NOT bundled.** This follows the usual pattern: you run
> Ollama / llama.cpp / LM Studio / vLLM yourself, and Kady just points at their
> base URL via environment variables. See [Local models](#local-models).

---

## Quick start

```bash
cp .env.example .env          # optional, but where you put API keys
docker compose up -d          # build (first time) + start
```

Then open **http://localhost:3000** in your browser.

- Add hosted-model keys (`OPENROUTER_API_KEY`, etc.) in `.env` or later in
  **Settings → API keys**.
- Your data (projects, chat sessions, sandbox, provenance) persists in
  `./projects/` on the host (bind-mounted).
- OAuth tokens (Pi subscription auth), Pi settings, and the skills cache
  persist in the `kady-config` named volume — safe across rebuilds.

### Useful commands

```bash
docker compose logs -f kady     # watch startup / runtime logs
docker compose down             # stop (data persists)
docker compose build --build-arg WITH_LATEX=0 -t kady:lite .   # smaller image
docker compose run --rm kady sh -c "npm --prefix server run prep"   # re-seed
docker compose run --rm kady sh -c "npm --prefix server run test"   # tests
```

---

## Local models

Two conventions cover essentially any local model server; both run on the
**host** and are reached through `host.docker.internal` (the alias Docker gives
the host from inside a container — wired automatically in `docker-compose.yml`
via `extra_hosts`, and already present on Docker Desktop).

### Ollama

```bash
ollama serve                    # on your host
ollama pull llama3
```

The compose file defaults `OLLAMA_BASE_URL=http://host.docker.internal:11434`,
so Ollama models already appear in the picker as `ollama/<model>`. Override in
`.env` to point anywhere else (a LAN server, another host, …):

```dotenv
OLLAMA_BASE_URL=http://my-server:11434
```

### llama.cpp (and any OpenAI-compatible server)

`llama-server`, LM Studio, vLLM, text-generation-webui, etc. all expose the
standard `/v1/chat/completions` + `/v1/models` API. Point Kady at it:

```dotenv
# llama.cpp on the host:
OPENAI_COMPATIBLE_BASE_URL=http://host.docker.internal:8080
# (adjust the port to whatever you passed `llama-server --port`, e.g. 8080)

# Any other host/LAN server:
OPENAI_COMPATIBLE_BASE_URL=http://192.168.1.20:8085
```

> **Use the ROOT, not the `/v1` path.** Kady appends `/v1/models` itself, so if
you set `OPENAI_COMPATIBLE_BASE_URL=http://host:8085/v1` it will call
`http://host:8085/v1/v1/models` and the model list comes back **not running**.
Leave off the `/v1`.

`OPENAI_COMPATIBLE_CONFIGURED=1` (set by default in the compose file) keeps the
picker's "Local (OpenAI-compatible)" section visible even before a server is
running, so you can point it at a to-be-started endpoint.

### Why not bundle Ollama/llama.cpp in the image?

- **Separation of concerns** — the model server and the app have different
  update cycles, GPU needs, and storage profiles.
- **GPU availability** — local-model servers are the thing that actually wants
  the GPU. Keeping them on the host avoids Docker GPU/Apple-Silicon issues and
  lets you use them with `start.sh` too.
- **It's the standard pattern** — pass a base URL, don't embed a second app.

---

## LaTeX: optional by design

The app already treats a missing LaTeX install as a graceful degradation — a
compile returns a clean *"LaTeX compiler not found"* result and SyncTeX reports
*unavailable*; nothing crashes. So whether TeX is in the image is purely a
**build-time** choice:

```bash
docker compose build --build-arg WITH_LATEX=1 -t kady:latest   # LaTeX ON (default)
docker compose build --build-arg WITH_LATEX=0 -t kady:lite     # LaTeX OFF (~0.5GB smaller)
```

Honest trade-off: the image is ~5.2GB even without TeX, because the scientific
file-preview helper venv (anndata/rdkit/scipy/matplotlib/…) and `node_modules`
dominate. LaTeX adds ~500MB. So `lite` is smaller, but not dramatically — its
main value is dropping a dependency you'll never use.

- `latest` (LaTeX): full LaTeX editing, compile, and source↔PDF SyncTeX sync.
- `lite` (no LaTeX): everything else identical; LaTeX compile + SyncTeX are the
  only disabled features.

---

## Authentication (subscription OAuth) — no tunnel needed

Kady's subscription login (OpenAI Codex / Claude / Copilot / xAI in
**Settings → Model providers**) is **headless-friendly by design**. It never
needs a browser on the same machine as the server or a `localhost` redirect
callback; it presents you with one of:

- an **`auth_url`** to open in your own browser,
- a **`device_code`** to enter at the provider's verification URL, or
- a **`manual_code`** to paste back into Settings.

All three complete in *your* browser, wherever it is; the container just holds
the resulting tokens in `KADY_PI_AGENT_DIR/auth.json` (persisted in the
`kady-config` volume). So on a same-machine Docker setup, subscription OAuth
works with **zero port-forwarding** — click Connect, follow the URL/code
prompt in your normal browser.

API-key providers (OpenRouter, NVIDIA NIM) and local models work with no OAuth
at all.

---

## Running on a remote/headless host (SSH)

If the container runs on a remote machine (a VM, a server, an old laptop), reach
the UI with a plain SSH tunnel and complete OAuth in your local browser:

```bash
# from your laptop — forward the remote UI (3000) and API (8000) ports
ssh -L 3000:localhost:3000 -L 8000:localhost:8000 user@kady-host
```

Then open `http://localhost:3000`. Because compose binds the host ports to
`127.0.0.1`, nothing is exposed to the LAN — the only way in is this tunnel.
(This same forward would even carry a hypothetical `localhost` OAuth callback,
since the API port is tunnelled too.)

> Want LAN clients instead of a tunnel? Change the compose `ports` prefix from
> `127.0.0.1:...` to `0.0.0.0:...` or a specific host IP. Prefer the tunnel for
> anything not fully trusted.

---

## Security notes

- **Non-root everywhere.** `docker-entrypoint.sh` runs as root only long enough
  to fix volume ownership, then `setpriv`s down to the `node` user (uid 1000).
  PID 1 and every agent/worker process run as uid 1000 — the agent shell never
  has root inside the container.
- **No Docker socket.** The image mounts **no** `/var/run/docker.sock`. That's
  what keeps the container an actual boundary: a compromised agent can't reach
  your host.
- **Host ports are localhost-bound** by default (see `docker-compose.yml`).
- **Config stays external.** `.env`, `auth.json`, and the projects volume never
  enter the image (see `.dockerignore` and the `docker-entrypoint.sh` env
  handling).

---

## Layout & persistence

| Path (host)            | In container        | What lives there |
|------------------------|---------------------|------------------|
| `./projects/` (bind)   | `/data/projects`    | projects, chat sessions, sandbox, provenance, Modal jobs |
| `kady-config` (volume) | `/data/config`      | Pi OAuth `auth.json`, Pi settings, skills cache |

The `docker-entrypoint.sh` ensures `/data/projects` and `/data/config` are
created and owned by `node`, so bind-mounts work on Linux without manual
`chown`. Skills for the default project are seeded on first boot (`npm run prep`
inside `start.mjs`).

---

## Known limitations

- **Image size ~5.2–5.7GB** — dominated by `node_modules` and the scientific
  helper venv, not LaTeX. A leaner "production" variant (Next.js production
  build + runtime-only deps) is a planned follow-up.
- **Dev servers by default.** The image starts `next dev` + `tsx` — same as
  `./start.sh`, so parity and hot-reload hold, at the cost of dev-server
  overhead. A production profile is planned.
- **No GPU inside the container** on Apple Silicon; run Ollama/llama.cpp on the
  host (the default setup) and Kady reaches them over `host.docker.internal`.
- **First boot** runs `npm run prep`, which syncs the K-Dense scientific skills
  catalogue and the per-project sandbox venv — allow a minute or two.

## Files

- `Dockerfile`
- `docker-compose.yml`
- `docker-entrypoint.sh`
- `.dockerignore`
