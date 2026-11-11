# Installation

## Requirements

- macOS, Linux or Windows 10/11; WSL also works.
- Node.js 22 or newer; **22.19+ recommended**. The macOS/Linux wrapper can install a missing Node through an existing Homebrew installation.
- Git. On Windows, install Git for Windows with Git Bash, which the agent uses for shell commands.
- Optional: a TeX distribution with `latexmk` for LaTeX compilation.

## Download and start

```bash
git clone https://github.com/K-Dense-AI/k-dense-byok.git
cd k-dense-byok
```

On macOS/Linux:

```bash
./start.sh
```

On Windows:

```powershell
.\start.cmd
```

Both launch `start.mjs`, which installs app dependencies and Python tooling,
prepares project skills and starts the frontend and backend. It creates `.env`
from `.env.example` when needed. Open **http://localhost:3000** if the browser
does not open automatically. Keep the terminal running; **Ctrl+C** stops the app.

## Connect a model

Open **Settings → Providers**. Add a provider API key, use a supported **Sign in**
flow, or configure a [local model server](local-models-ollama.md). For ChatGPT,
use **OpenAI → Sign in with ChatGPT**. The provider list shows the available
methods and cloud configuration fields.

OpenRouter is optional unless you use Fusion or server-side speech
transcription; either an OpenRouter sign-in or an API key works. Keys can also be set in the repo-root `.env`; see `.env.example`
for names. See [Model selection](model-selection.md) for billing and defaults.

OAuth tokens live in `~/.kady/pi-agent/auth.json`, shared by lead and specialist
agents. `KADY_PI_AGENT_DIR` relocates that directory. An explicit
`PI_CODING_AGENT_DIR` takes precedence; use it only when you intend to share
Pi authentication and settings with another installation.

For providers with both methods, a successful sign-in takes precedence over an
existing environment API key. Saving a new API key in Settings switches that
provider back to API-key authentication. Disconnecting a sign-in removes its
stored Pi credential; an API key still set in the environment remains usable.

Keep the sign-in dialog open while completing the provider's browser flow. If
the browser runs on another machine, or the callback port is occupied, paste
the final redirect URL into the dialog. ChatGPT requires the complete URL,
including its state and issued client ID. Kady supplies Pi with a persistent
installation ID in the global Pi settings; existing legacy Codex logins remain
separate from the newer OpenAI sign-in.

## Optional services

**Settings → Services** accepts Exa, Perplexity and Gemini search keys, a
Paperclip API key and a Modal token ID/secret pair. Web search has a shared
fallback without a key; video understanding requires Gemini. The Paperclip key
adds a [literature-search connector](mcp-servers.md#authentication).
[Modal compute](modal-compute.md) needs the token pair. Configure database credentials only when a task needs them.

## Updates

Stop the app, run `git pull` from the repository, and start it again with the
command above. Resolve any local Git changes before updating. The launcher
installs the dependencies required by the checkout.

## Troubleshooting

| Symptom | Check |
|---|---|
| `start.sh: Permission denied` | Run `chmod +x start.sh`, then retry. |
| No model access | Open Providers, check the credential or local server, then choose an available model. |
| Port in use | Read the launcher's message. Stop the named conflicting process or change `KADY_PORT` / `KADY_FRONTEND_PORT`; a changed backend address also needs `NEXT_PUBLIC_ADK_API_URL`. |
| `origin_not_allowed` | Use the normal UI URL or configure `KADY_ALLOWED_ORIGINS`; see [Security](security.md). |
| Access token required | Open the launcher's full token link or paste the token into the prompt. |
| Scientific preview unavailable | Let helper setup finish; reopen the file and inspect the backend error if it persists. |

On a network requiring an outbound proxy, set `HTTPS_PROXY` and `HTTP_PROXY`
in `.env` and restart. The launcher adds loopback to `NO_PROXY` so local services
stay direct. A 403 or connection failure can come from either the provider or
an intervening proxy; inspect the response before changing credentials.

For another host, prefer an SSH tunnel forwarding both ports:

```bash
ssh -L 3000:localhost:3000 -L 8000:localhost:8000 workstation
```

Direct exposure requires the [security configuration](security.md), including
a browser-reachable `NEXT_PUBLIC_ADK_API_URL` set before starting/building the
frontend. Files and tools run on the backend host.
