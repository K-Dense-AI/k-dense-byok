# K-Dense BYOK

**Your own AI research assistant, running on your computer, powered by your API keys.**

K-Dense BYOK (Bring Your Own Keys) is an open-source app that lets you chat with an AI assistant called **Kady**. You ask Kady a question or give it a task, and it figures out the best way to handle it — sometimes answering directly, sometimes spinning up specialized AI "experts" that work behind the scenes to get you a thorough result.

It's built for scientists, analysts, and curious people who want a powerful AI workspace without being locked into a single provider. K-Dense BYOK is powered by our very popular Claude Scientific Skills.

[![Watch the video](https://img.youtube.com/vi/BVG50mgw6-4/maxresdefault.jpg)](https://youtu.be/BVG50mgw6-4?si=pbEUdpuQJJfGiKjw)

> **Beta:** K-Dense BYOK is currently in beta. Many features and performance improvements are on the way in the coming weeks. [Star us on GitHub](https://github.com/K-Dense-AI/k-dense-byok) to stay in the loop, and follow us on [X](https://x.com/k_dense_ai), [LinkedIn](https://www.linkedin.com/company/k-dense-inc), and [YouTube](https://www.youtube.com/@K-Dense-Inc) for release notes and tutorial videos.

## What can it do?

- **Answer questions and complete tasks** — Ask Kady anything. For complex work, it delegates to AI experts that each have their own specialties (bioinformatics, finance, data analysis, etc.) with full access to our 170+ scientific skills.
- **Search the web** — Kady can look things up online and pull in live information while working on your request.
- **Work with your files** — Upload files, create new ones, and preview them right in the app. Everything stays in a local sandbox folder on your machine. Can handle almost any file type.
- **Access 250+ scientific databases and 500k+ Python packages** — Kady's experts come pre-loaded with specialized scientific skills from [K-Dense](https://github.com/K-Dense-AI), covering everything from genomics to materials science.
- **Choose your AI model** — Pick from 40+ models (OpenAI, Anthropic, Google, xAI, Qwen, and more) through a simple dropdown in the app. You're not stuck with one.

> **Note:** The model you select in the dropdown only applies to Kady (the main agent). Expert execution and coding tasks use the Gemini CLI, which always runs through a Gemini model on [OpenRouter](https://openrouter.ai/) regardless of your dropdown selection.
- **Run heavy computations remotely** — Optionally connect [Modal](https://modal.com/) to run demanding workloads on powerful cloud hardware instead of your laptop.

## What you'll need before starting

| What | Why | Where to get it |
|------|-----|-----------------|
| A computer running **macOS, Linux, or Windows** | The app runs locally on your machine | On **native Windows**, enable compatibility mode (see [Running on Windows](#running-on-windows-native)) or use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) and follow the Linux steps |
| An **OpenRouter API key** | This is how the AI models are accessed | [openrouter.ai](https://openrouter.ai/) — sign up and create a key |
| A **Parallel API key** *(optional)* | Lets Kady search the web | [parallel.ai](https://parallel.ai/) |
| **Modal** credentials *(optional)* | Only needed if you want remote compute for heavy jobs | [modal.com](https://modal.com/) |

That's it. The startup script handles installing everything else automatically.

## Getting started

### Step 1 — Download the project

Open a terminal and run:

```bash
git clone https://github.com/K-Dense-AI/k-dense-byok.git
cd k-dense-byok
```

### Step 2 — Add your API key

Create a file called `.env` inside the `kady_agent` folder with this content:

```env
# Your OpenRouter API key (required)
OPENROUTER_API_KEY=paste-your-key-here

# Enables web search (optional)
PARALLEL_API_KEY=paste-your-key-here

# Leave these as-is — they connect internal services
GOOGLE_GEMINI_BASE_URL=http://localhost:4000
GEMINI_API_KEY=sk-litellm-local

# The default AI model Kady uses (you can change this in the app later)
DEFAULT_AGENT_MODEL=openrouter/google/gemini-3.1-pro-preview

# Native Windows only — set to 1 before first start (see "Running on Windows" in the README)
# KADY_WINDOWS_COMPAT=1

# Remote compute — only fill in if you have a Modal account (optional)
MODAL_TOKEN_ID=
MODAL_TOKEN_SECRET=
```

At minimum, you need to fill in `OPENROUTER_API_KEY`. Everything else is optional or should be left as-is.

### Step 3 — Start the app

```bash
chmod +x start.sh
./start.sh
```

The first time you run this, it will automatically install any missing tools (Python packages, Node.js, Gemini CLI) and download scientific skills. This may take a few minutes. After that, future starts will be much faster.

Once everything is running, your browser will open to **[http://localhost:3000](http://localhost:3000)** — that's the app.

To stop everything, press **Ctrl+C** in the terminal.

### Running on Windows (native)

If you are on **Windows without WSL**, opt in to the Windows compatibility layer so the Gemini CLI delegate tool and the local event loop behave reliably:

1. **Configure `kady_agent/.env` first.** Add a line `KADY_WINDOWS_COMPAT=1` (or `true`). This enables the supported code paths for subprocess execution on Windows and disables the Docling MCP server, which is often unstable under Windows stdio. Leave this unset on macOS and Linux.

2. **Start the stack using the Windows launcher.** From the project root, either double-click **`start.bat`** or open PowerShell and run:

   ```powershell
   cd path\to\k-dense-byok
   .\start.ps1
   ```

   The batch file invokes the same PowerShell script with an appropriate execution policy. The launcher loads your `kady_agent/.env`, installs dependencies if needed, then starts LiteLLM, the backend, and the frontend.

3. **Use the app as usual** at [http://localhost:3000](http://localhost:3000). If you change `KADY_WINDOWS_COMPAT` after a prior run, restart all services so the new value is picked up.

If you prefer a Linux-like environment on the same machine, you can instead use **WSL** and follow **Step 3** with `./start.sh`; in that case you do **not** need `KADY_WINDOWS_COMPAT`.

## How it works (the short version)

The app runs three services on your computer:

| Service | What it does |
|---------|-------------|
| **Frontend** (port 3000) | The web interface you interact with — chat, file browser, and file preview side by side |
| **Backend** (port 8000) | The brain — runs Kady and coordinates expert tasks |
| **LiteLLM proxy** (port 4000) | A translator that routes your AI requests to whichever model you've chosen via [OpenRouter](https://openrouter.ai/) |

When you send a message, Kady reads it, decides whether to answer directly or delegate to an expert, uses any needed tools (web search, file operations, scientific databases), and streams the response back to you.

## Project layout

```
k-dense-byok/
├── start.sh              ← Starts everything (macOS / Linux / WSL)
├── start.bat / start.ps1 ← Windows launcher (use with KADY_WINDOWS_COMPAT=1 on native Windows)
├── server.py             ← Backend server
├── kady_agent/           ← Kady's brain: instructions, tools, and config
│   ├── .env              ← Your API keys go here
│   ├── agent.py          ← Main agent definition
│   └── tools/            ← Tools Kady can use (web search, delegation, etc.)
├── web/                  ← Frontend (the UI you see in your browser)
└── sandbox/              ← Workspace for files and expert tasks (created on first run)
```

## Why "BYOK"?

BYOK stands for **Bring Your Own Keys**. Instead of paying a subscription to a single AI company, you plug in API keys from whatever providers you prefer. You stay in control of which models you use, how much you spend, and where your data goes.

## Features in the works

- Ollama local model support
- Better utilization of Skills
- Choose what model to use with Gemini CLI
- Choice between Claude Code or Gemini CLI as the delegation expert
- Support of MCP config in the UI (can be done in the code right now but we want to make it easier)
- Better UI experience tailored to scientific workflows
- Faster PDF parsing
- AutoResearch integration
- And much more

## Want more?

K-Dense BYOK is great for getting started, but if you want end-to-end research workflows with managed infrastructure, team collaboration, and no setup required, check out **[K-Dense Web](https://www.k-dense.ai)** — our full platform built for professional and academic research teams.

## Issues, bugs, or feature requests

If you run into a problem or have an idea for something new, please [open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues). We read every one.

## About K-Dense

K-Dense BYOK is open source because [K-Dense](https://github.com/K-Dense-AI) believes in giving back to the community that makes this kind of work possible.

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=K-Dense-AI/k-dense-byok&type=date&legend=top-left)](https://www.star-history.com/?repos=K-Dense-AI%2Fk-dense-byok&type=date&legend=top-left)