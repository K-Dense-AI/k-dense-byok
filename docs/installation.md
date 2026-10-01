# Installation

## Native installers

The distribution workflow builds macOS DMGs (Apple Silicon and Intel), a
Windows x64 installer, and Linux x64 DEB, RPM and portable archives. Signed
installers will be attached to [GitHub releases](https://github.com/K-Dense-AI/k-dense-byok/releases).
Before the first signed release, development builds are available as artifacts
of the **Distributions** workflow; they are unsigned previews.

- **macOS 13+:** open the DMG, drag Kady to Applications, then open Kady.
- **Windows 10/11 x64:** run the installer, then use the Kady Start menu shortcut.
- **Linux:** install the DEB/RPM and open Kady from the application menu, or
  extract the portable archive and run `./kady`. The build baseline is Ubuntu
  22.04; Alpine/musl is unsupported.

Kady starts its local services and opens your default browser. Node.js, npm,
Git and the Python installer are bundled. Scientific preview dependencies
download when you select **Settings → Services → Install scientific previews**.
Optional TeX distributions and external MCP/CLI programs are installed separately.

Closing the browser leaves Kady running. **Settings → Services → Stop Kady**
stops local work and schedules. Open the application again to return to it.
Use **View logs** in the same panel for startup and runtime diagnostics.

Projects live outside the application: under `~/Library/Application Support/Kady`
on macOS, `%LOCALAPPDATA%\Kady` on Windows, and `$XDG_DATA_HOME/kady` (default
`~/.local/share/kady`) on Linux. Upgrading or uninstalling the application keeps
these files. Existing source-install users can stop their source instance and
select its folder with **Use existing projects** in Services; this uses the
original projects in place and preserves their sessions and budgets.

Build instructions and release-signing configuration are in the
[distribution guide](../packaging/README.md).

## Install from source: requirements

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

An OpenRouter key is optional unless you use Fusion or server-side speech
transcription. Keys can also be set in the repo-root `.env`; see `.env.example`
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

**Settings → Services** accepts Exa, Perplexity and Gemini search keys and a
Modal token ID/secret pair. Web search has a shared fallback without a key;
video understanding requires Gemini. [Modal compute](modal-compute.md) needs
the token pair. Configure database credentials only when a task needs them.

## Updates

For an installed application, choose **Download updates** in Services, stop
Kady, and run the new installer (or replace the macOS app / portable directory).
Keep the data directories. Updates do not replace files while Kady is running.

For a source installation:

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
