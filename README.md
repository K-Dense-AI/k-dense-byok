# K-Dense BYOK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-0.4.5-blue.svg)](pyproject.toml)
[![Skills](https://img.shields.io/badge/Skills-140%2B-brightgreen.svg)](#what-can-it-do)
[![Databases](https://img.shields.io/badge/Databases-229-orange.svg)](#what-can-it-do)
[![Tests](https://github.com/K-Dense-AI/k-dense-byok/actions/workflows/tests.yml/badge.svg)](https://github.com/K-Dense-AI/k-dense-byok/actions/workflows/tests.yml)
[![X](https://img.shields.io/badge/Follow_on_X-%40k__dense__ai-000000?logo=x)](https://x.com/k_dense_ai)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-K--Dense_Inc.-0A66C2?logo=linkedin)](https://www.linkedin.com/company/k-dense-inc)
[![YouTube](https://img.shields.io/badge/YouTube-K--Dense_Inc.-FF0000?logo=youtube)](https://www.youtube.com/@K-Dense-Inc)

**Your own AI research assistant, running on your computer, powered by your API keys.**

K-Dense BYOK (Bring Your Own Keys) is a free, open-source app that gives you an AI research assistant called **Kady**. Ask Kady a question or give it a task, and it works in a full coding/research environment - reading and writing files, running code, and spinning up subagents for heavy or parallel work - to get you a thorough result. Kady is powered by the [Pi coding-agent SDK](https://pi.dev).

It is built for scientists, analysts, and curious people who want a powerful AI workspace without being locked into a single provider.

> **Stay up to date:** Follow K-Dense on [X](https://x.com/k_dense_ai), [LinkedIn](https://www.linkedin.com/company/k-dense-inc), and [YouTube](https://www.youtube.com/@K-Dense-Inc) for release notes, tutorial videos, and workflow demos.

> **Beta:** K-Dense BYOK is currently in beta. Many features and improvements are on the way. [Star us on GitHub](https://github.com/K-Dense-AI/k-dense-byok) to stay in the loop.

## What can it do?

- **Answer questions and take on tasks.** Chat with Kady like any AI assistant. For bigger work, Kady uses its file and shell tools directly - and can spawn subagents for independent or parallel subtasks - in a full working environment.
- **Run up to 10 chats in parallel.** Open a new tab for each thread of work — every tab keeps its own message history, model, attached files, and cost meter, but all tabs share the project's sandbox so files written in one tab are immediately available in the others. Tabs keep streaming in the background while you switch between them.
- **Pick any tool-capable AI model, any time.** Choose from the full set of OpenRouter models that support tool calling (OpenAI, Anthropic, Google, xAI, Qwen, and more) with a simple dropdown, per chat tab. You can also use free local models through [Ollama](./docs/local-models-ollama.md).
- **140+ scientific skills, pre-installed.** Covers genomics, proteomics, drug discovery, materials science, and more. Kady activates the right skills automatically for each task.
- **326 ready-to-run workflow templates.** Browse a built-in library across 22 disciplines - genomics, drug discovery, finance, astrophysics, and more. Pick one, fill in the blanks, and launch.
- **229 scientific and financial databases.** Connect to databases in 18 categories - Biomedical & Health, Chemistry & Materials, Scholarly Publications, Stock Market, Earth & Climate, Astronomy & Space, and more.
- **Organise your work in projects.** Each project has its own files, chat history, and settings. Upload files, browse folders, preview documents, and download results - all from inside the app.
- **Rich file previews.** Built-in viewers for code, Markdown (with math and diagrams), CSVs, PDFs, images, Jupyter notebooks, and bioinformatics formats (FASTA, FASTQ, VCF, BED, GFF, SAM, BCF).
- **LaTeX editor.** Split-pane editor with live PDF compilation (pdfLaTeX, XeLaTeX, LuaLaTeX).
- **Voice input, drag-and-drop attachments, `@` file mentions,** and a **message queue** for batching up to 5 messages while the agent is working.
- **Cost & budget tracking.** Per-session and per-project cost meters, plus an optional hard spend cap per project.

> Web search (Exa/Parallel), literature search (Paperclip), document conversion, remote compute (Modal), custom MCP servers, browser automation, and the provenance/"Copy as Methods" export are being re-added as native Pi tools in upcoming releases.

## What you'll need before starting

| What | Why | Where to get it |
|------|-----|-----------------|
| A computer running **macOS or Linux** | The app runs locally on your machine | Windows works too - use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) |
| An **OpenRouter API key** | This is how the AI models are accessed | [openrouter.ai](https://openrouter.ai/) - sign up and create a key |
| An **Exa API key** *(optional)* | Lets Kady search the web with neural (embedding-based) retrieval tuned for scientific content | Get your Exa API key: [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) |
| A **Parallel API key** *(optional)* | Alternative web search provider | [parallel.ai](https://parallel.ai/) |
| A **Paperclip API key** *(optional)* | Biomedical literature, regulatory documents, and clinical-trial search | [paperclip.gxl.ai](https://paperclip.gxl.ai/) |
| **Modal** credentials *(optional)* | Only needed for remote GPU/CPU compute | [modal.com](https://modal.com/) |

You do not need any coding experience. The startup script installs everything else for you.

## Install and run

### Step 1 - Download the project

Open a terminal and run:

```bash
git clone https://github.com/K-Dense-AI/k-dense-byok.git
cd k-dense-byok
```

### Step 2 - Add your API keys

In the project's top folder you'll find a file called `.env.example`. Make a copy and rename it to `.env` (note the dot at the start). Open `.env` in any text editor and paste your **OpenRouter API key** - that's the only key you need to get started.

Optionally set `OLLAMA_BASE_URL` to use local models. (Other integrations such as web search and document conversion are being re-added as native tools in a later release.)

### Step 3 - Start the app

```bash
./start.sh
```

The first time you run this, it will automatically install the backend and frontend packages and the scientific skills. This may take a few minutes. Future starts are much faster. (You'll need Node.js ≥ 22.19 installed.)

Once everything is running, your browser will open to **[http://localhost:3000](http://localhost:3000)**. That's the app.

### Step 4 - Stop the app

Press **Ctrl+C** in the terminal.

## Using the app day to day

- **Send a message.** Type a question or task and hit enter. Kady answers directly, runs tools (read/write files, run code), and can spawn a subagent for heavy or parallel subtasks.
- **Open multiple chats.** Click `+` in the chat tab strip to start a new chat in the same project (up to 10). Double-click a tab title or use the pencil icon to rename it. Closing a tab cancels any turn it had running. The cost pill in the header shows both the active tab's session cost (`sess`) and the project total across every tab (`proj`).
- **Switch models.** Use the model dropdown in the input bar - any message can use any tool-capable OpenRouter model, or a local Ollama model.
- **Upload files.** Drag files into the file browser or directly onto the input bar. Use `@filename` in your message to reference files.
- **Launch a workflow.** Open the workflows panel, pick one, fill in the blanks, and click Launch. Workflows run in whichever chat tab is currently active.
- **Open Settings** (the gear icon in the top-right) for API keys and appearance.

## Learn more

These guides live in the [`docs/`](./docs) folder:

- **[Architecture](./docs/architecture.md)** - how the two local services fit together and what each folder in the project is for.
- **[Model selection](./docs/model-selection.md)** - how Kady builds the OpenRouter model list.
- **[Local models with Ollama](./docs/local-models-ollama.md)** - run everything with local models, no API keys required.
- **[Contributing workflows](./docs/contributing-workflows.md)** - add new workflow templates to the library.
- **[Known limitations](./docs/limitations.md)** - rough edges to be aware of, especially around the expert system.

## Features in the works

- Re-adding web search, document conversion, custom MCP servers, and remote compute as native Pi tools
- Provenance / "Copy as Methods" export on top of Pi sessions
- A full credentials & settings UI
- Better UI experience tailored to scientific workflows
- And much more

Recently completed: migrated the backend to the [Pi coding-agent SDK](https://pi.dev) (single flat agent + subagents, replacing the orchestrator/expert/Gemini-CLI/LiteLLM stack), native OpenRouter + Ollama, per-project Pi sessions, and cost/budget tracking from Pi usage.

## Want more?

K-Dense BYOK is great for getting started, but if you want end-to-end research workflows with managed infrastructure, team collaboration, and no setup required, check out **[K-Dense Web](https://www.k-dense.ai)** - our full platform built for professional and academic research teams.

## Issues, bugs, or feature requests

If you run into a problem or have an idea for something new, please [open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues). We read every one.

## About K-Dense

K-Dense BYOK is open source because [K-Dense](https://github.com/K-Dense-AI) believes in giving back to the community that makes this kind of work possible.

## Star history

[![Star History Chart](https://api.star-history.com/image?repos=K-Dense-AI/k-dense-byok&type=date&legend=top-left)](https://www.star-history.com/?repos=K-Dense-AI%2Fk-dense-byok&type=date&legend=top-left)
