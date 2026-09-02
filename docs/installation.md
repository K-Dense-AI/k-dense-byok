# Installation guide

This guide walks you through installing K-Dense BYOK from scratch. No coding experience is needed — if you can copy and paste commands into a terminal, you can do this.

## 1. Check your computer

| Requirement | Details |
|-------------|---------|
| **Operating system** | macOS, Linux, or Windows 10/11. (On Windows, [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) also works if you prefer a Linux environment — but it's no longer required.) |
| **Node.js ≥ 22.19** | The startup script installs it for you via Homebrew on a Mac if it's missing. On Linux, install it from [nodejs.org](https://nodejs.org/). On Windows, install it from [nodejs.org](https://nodejs.org/) or run `winget install OpenJS.NodeJS.LTS`. |
| **git** | Pre-installed on most macOS/Linux systems (on a Mac, run `xcode-select --install` if it's missing). **Windows: required** — install [Git for Windows](https://git-scm.com/download/win) with its default components; it provides the Git Bash shell Kady's agent uses to run commands. |

Everything else (Python tooling, packages, scientific skills) is installed automatically the first time you start the app.

> **Optional — LaTeX PDF reports:** if you want Kady's LaTeX editor to compile PDFs, install a TeX distribution: [MacTeX](https://www.tug.org/mactex/) (macOS), TeX Live (Linux), or [MiKTeX](https://miktex.org/) / [TeX Live](https://www.tug.org/texlive/) (Windows). Not needed for normal use.

## 2. Choose model access

Kady can use any combination of these model sources:

### OpenRouter

An [OpenRouter](https://openrouter.ai/) API key gives one pay-as-you-go account access to models from OpenAI, Anthropic, Google, xAI, Qwen, and more. Sign up, add credit, and create a key (it looks like `sk-or-...`).

### Pi OAuth subscriptions

Kady can connect these existing subscriptions directly through Pi:

- ChatGPT Plus/Pro (`openai-codex`)
- Claude Pro/Max (`anthropic`)
- GitHub Copilot (`github-copilot`)
- xAI (`xai`, shown for supported SuperGrok or X Premium access)

After Kady starts, open **Settings → Model providers** and click **Connect**. Pi and the provider choose the appropriate browser redirect, device-code, or manual-code flow; Kady displays each step in the dialog.

A subscription login does not make provider usage free or unlimited. Quotas, premium requests, overages, and plan eligibility are managed by the provider. Kady tracks OpenAI Codex, Copilot, and xAI subscription tokens plus a list-price reference, but excludes that reference from project spend caps. Pi documents third-party Anthropic OAuth as metered extra per-token usage, so Kady counts it toward the cap.

### NVIDIA NIM

An API key from [build.nvidia.com](https://build.nvidia.com/) gives direct access to NIM-served models — Nemotron, Llama, GPT-OSS, Kimi, GLM, and more. Usage draws on NVIDIA-managed API credits rather than per-token dollar pricing, so Kady records tokens but no USD spend. Add the key as `NVIDIA_API_KEY` in `.env` or under **Settings → API keys**; see [Model selection](./model-selection.md#nvidia-nim-models).

### Local Ollama

You can run entirely on free local models instead — see [Local models with Ollama](./local-models-ollama.md). No hosted-provider credential is needed.

> **OpenRouter-only features:** OpenRouter Fusion and server-side speech transcription for browsers without Web Speech still require an OpenRouter API key. Subscription logins do not authenticate those endpoints.

## 3. Download the project

Open a terminal (on a Mac: press `Cmd+Space`, type "Terminal", press Enter; on Windows: press `Win`, type "PowerShell" or "Terminal", press Enter) and run:

```bash
git clone https://github.com/K-Dense-AI/k-dense-byok.git
cd k-dense-byok
```

This downloads the project into a folder called `k-dense-byok` and moves you into it.

## 4. Configure model access

In the project folder there is a template file called `.env.example`. Copy it to a file called `.env` (note the dot at the start):

```bash
cp .env.example .env      # macOS / Linux
copy .env.example .env    # Windows
```

If you use OpenRouter, open `.env` in any text editor and paste your key:

```
OPENROUTER_API_KEY=sk-or-your-key-here
```

If you use only a Pi subscription or Ollama, you can leave `OPENROUTER_API_KEY` blank. The startup script creates `.env` if needed, and OpenRouter keys can also be added later under **Settings → API keys**.

OAuth tokens are kept outside the repository and all projects. By default Pi stores them in Kady's private `~/.kady/pi-agent/auth.json`; the lead agent and its specialist subagents use that same store. Set `KADY_PI_AGENT_DIR` to relocate Kady's Pi directory. If you explicitly set `PI_CODING_AGENT_DIR`, it takes precedence; point it at your standalone Pi agent directory only when you intentionally want Kady and Pi to share authentication and settings.

## 5. Start the app

```bash
./kady         # macOS / Linux
.\kady.cmd     # Windows
```

(`start.sh` / `start.cmd` remain supported for compatibility; all wrappers use the same cross-platform `start.mjs` launcher.)

The first run takes a few minutes. The script automatically:

- checks for and installs anything missing (Node.js on a Mac, the [uv](https://docs.astral.sh/uv/) Python manager that Kady uses to run analyses — on every platform),
- installs the backend and frontend packages,
- downloads the catalogue of 140+ scientific skills,
- creates your `.env` file if you haven't, and warns when it cannot immediately detect an OpenRouter key, NVIDIA key, stored subscription login, or local Ollama (the UI still opens for provider setup).

When it finishes, your browser opens to **[http://localhost:3000](http://localhost:3000)** — that's the app. Future starts take only a few seconds.

To stop the app, go back to the terminal and press **Ctrl+C**.

## 6. Optional API keys

These unlock extra capabilities. All of them can be added later in **Settings → API keys** — none are required to get started.

| Key | What it adds | Where to get it |
|-----|--------------|-----------------|
| **Exa** | Direct web + code search with neural retrieval tuned for scientific content. Web search works without it via a free fallback. | [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) |
| **Perplexity** | Alternative web search with synthesized, cited answers. | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| **Gemini** | Search fallback plus YouTube / video understanding. | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

The `.env` file also lists keys for specific scientific databases (NCBI, Materials Project, openFDA, FRED, NASA, and many more). You only need those if a task touches the corresponding database and it asks for one.

## Updating to a new version

From the project folder, use the built-in updater:

```bash
./kady update         # macOS / Linux
.\kady.cmd update    # Windows
```

It fast-forwards the current branch from its configured upstream and exits. It refuses to run over tracked local changes, a detached HEAD, or a branch without an upstream, so it never stashes, resets, or merges local work automatically. Start Kady normally afterwards; the launcher picks up any new packages and skills automatically.

## Troubleshooting

- **`./kady: Permission denied`** (macOS/Linux) — run `chmod +x kady start.sh` once, then try again.
- **Windows says "Windows protected your PC"** when double-clicking `kady.cmd` — click *More info → Run anyway*, or run it from a terminal instead (`.\kady.cmd`).
- **Browser doesn't open** — go to [http://localhost:3000](http://localhost:3000) manually.
- **"No API key" warning** — make sure your key is in `.env` (the file is `.env`, not `.env.example`), paste it in **Settings → API keys** (OpenRouter or NVIDIA), start Ollama, or connect a supported subscription in **Settings → Model providers**.
- **Port already in use** — the startup script clears leftover Kady processes automatically and names any other program holding port 3000 or 8000. Quit the program it names (or set `KADY_PORT` in `.env` to move the backend) and start the app again.
- **Model calls fail with a 403 or a connection error, but the same key works in other apps** — you are probably on a network that only allows outbound traffic through a proxy. Node does not read `HTTP_PROXY` / `HTTPS_PROXY` by itself, so Kady dials providers directly and whatever filters your network answers instead. Set them in `.env`:

  ```bash
  HTTPS_PROXY=http://proxy.example.com:3128
  HTTP_PROXY=http://proxy.example.com:3128
  NO_PROXY=localhost,127.0.0.1
  ```

  Keep `localhost` in `NO_PROXY` so Ollama and the app's own services stay direct. On restart the backend log confirms it with `routing outbound HTTP through the configured proxy`. To check whether a 403 is really coming from the provider, call it directly from the same machine — `curl -sS https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY"`. An error that isn't shaped like the provider's own JSON is coming from something in between.
- **Something else?** — [Open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues); we read every one.
