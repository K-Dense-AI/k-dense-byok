# K-Dense BYOK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-0.7.0-blue.svg)](server/package.json)
[![Skills](https://img.shields.io/badge/Skills-140%2B-brightgreen.svg)](#what-can-it-do)
[![Workflows](https://img.shields.io/badge/Workflows-326-blueviolet.svg)](#what-can-it-do)
[![Databases](https://img.shields.io/badge/Databases-229-orange.svg)](#what-can-it-do)
[![Tests](https://github.com/K-Dense-AI/k-dense-byok/actions/workflows/tests.yml/badge.svg)](https://github.com/K-Dense-AI/k-dense-byok/actions/workflows/tests.yml)
[![X](https://img.shields.io/badge/Follow_on_X-%40k__dense__ai-000000?logo=x)](https://x.com/k_dense_ai)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-K--Dense_Inc.-0A66C2?logo=linkedin)](https://www.linkedin.com/company/k-dense-inc)
[![YouTube](https://img.shields.io/badge/YouTube-K--Dense_Inc.-FF0000?logo=youtube)](https://www.youtube.com/@K-Dense-Inc)

**Your own AI research assistant, running on your computer, powered by your API keys.**

![K-Dense BYOK — Kady running an end-to-end single-cell RNA-seq analysis, with the project file browser, a rendered analysis report, and the live chat panel](docs/app-screenshot.png)

K-Dense BYOK (Bring Your Own Keys) is a free, open-source app that gives you **Kady** — an AI research assistant for scientists in any field. Describe a task in plain language — analyze a dataset, review a manuscript, search the literature, build a figure — and Kady does the work: it reads and writes files, runs real code, searches the web, and hands you the results.

No coding experience is required. The app runs locally on your machine, your data stays with you, and you pay only for the AI model usage on your own account.

> **Beta:** K-Dense BYOK is currently in beta. Many features and improvements are on the way. [Star us on GitHub](https://github.com/K-Dense-AI/k-dense-byok) to stay in the loop, and follow K-Dense on [X](https://x.com/k_dense_ai), [LinkedIn](https://www.linkedin.com/company/k-dense-inc), and [YouTube](https://www.youtube.com/@K-Dense-Inc) for release notes and tutorials.

## What can it do?

- **Take on real research tasks** — data analysis, literature review, manuscript checking, figure generation — in a full working environment, with progress shown live in the chat.
- **Delegate to a built-in team of 21 scientific specialists**, like a `citation-checker`, a `statistical-reviewer`, and a `peer-reviewer` — running one at a time, in parallel, or chained. [Learn more](./docs/sub-agents.md).
- **Search the web and read sources natively** — pages, PDFs, GitHub repositories, even YouTube videos — with no extra API key required.
- **Ask before it assumes.** When a task is ambiguous, Kady shows a quick question form in the chat instead of guessing.
- **Use 140+ pre-installed scientific skills** covering genomics, proteomics, drug discovery, materials science, and more — activated automatically per task.
- **Launch 326 ready-made workflow templates** across 22 disciplines: pick one, fill in the blanks, go.
- **Query 229 scientific and financial databases** in 18 categories, from PubMed-scale biomedical resources to market and climate data.
- **Use any tool-capable AI model** — OpenAI, Anthropic, Google, xAI, Qwen, and more via one [OpenRouter](https://openrouter.ai/) account, or free local models via [Ollama](./docs/local-models-ollama.md). Switch per chat.
- **Fuse multiple frontier models with [OpenRouter Fusion](./docs/openrouter-fusion.md)** — pick a Fusion preset (e.g. *Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro*) and a panel of models deliberates while a judge synthesizes one answer, with combined pricing and DRACO benchmark scores shown right in the model picker.
- **Preview 60+ scientific file formats** right in the app — [interactive 3D protein structures, 2D chemical structures from SMILES, mass spectra, single-cell/HDF5/Parquet arrays, phylogenetic trees, sequence alignments, DICOM/NIfTI/microscopy imaging, and more](./docs/file-previews.md), alongside the everyday CSVs, PDFs, notebooks, and genomics tables.
- **Stay organized with projects** — each with its own files, chat history, up to 10 parallel chat tabs, a LaTeX editor with inline compile diagnostics, and cost tracking with optional spend caps.
- **Pick up where you left off** — reopen any past chat from the session history menu, full transcript included, right alongside your open tabs.
- **Offload heavy or GPU work to the cloud with [Modal](https://modal.com)** — add your Modal keys and Kady can run a command or script on an on-demand sandbox, from a cheap CPU box up to H100 GPUs. Files sync back to your project and the compute cost is tracked right alongside model spend. Pick the instance per chat from the compute selector.
- **Extend it with [MCP servers](./docs/mcp-servers.md)** — connect GitHub, reference managers, databases, and hundreds of other external tools.
- **Manage everything from Settings** — a built-in capability hub with panels to browse and toggle skills, create or disable specialists, and add or disconnect MCP connectors per project, plus live API key management (OpenRouter, Modal, and more) — no config files to edit, and disabling anything is non-destructive.

## Get started in 5 minutes

You need a computer running **macOS or Linux** (Windows works via [WSL](https://learn.microsoft.com/en-us/windows/wsl/install)) and an **[OpenRouter](https://openrouter.ai/) API key** (one account, all major AI models — or use [free local models](./docs/local-models-ollama.md) instead).

Open a terminal and run:

```bash
git clone https://github.com/K-Dense-AI/k-dense-byok.git
cd k-dense-byok
cp .env.example .env    # then paste your OpenRouter key into .env
./start.sh
```

The first start installs everything automatically (it takes a few minutes); then your browser opens to **http://localhost:3000**. Press **Ctrl+C** in the terminal to stop. You can also add or change API keys anytime from the in-app Settings — no restart needed.

That's it. Create a project, drop in your data, and ask Kady for what you want — for example: *"Run a differential expression analysis on counts.csv comparing treated vs control, and plot a volcano plot."*

➡️ **Step-by-step details, optional API keys, and troubleshooting:** [Installation guide](./docs/installation.md)
➡️ **Your first session and everyday features:** [Basic usage](./docs/basic-usage.md)

## Documentation

All guides live in the [`docs/`](./docs) folder:

| Guide | What it covers |
|-------|----------------|
| [Installation](./docs/installation.md) | Full setup walkthrough, optional API keys, updating, troubleshooting |
| [Basic usage](./docs/basic-usage.md) | First session, chat tabs, files, workflows, databases, costs, tips |
| [File previews](./docs/file-previews.md) | Every scientific format Kady can render — structures, spectra, imaging, arrays, and more |
| [Sub-agents](./docs/sub-agents.md) | Kady's team of 21 scientific specialists and how to customize them |
| [Connecting external tools (MCP)](./docs/mcp-servers.md) | Give Kady extra abilities like GitHub, reference managers, and databases |
| [Local models with Ollama](./docs/local-models-ollama.md) | Run everything on free local models, no API keys required |
| [Model selection](./docs/model-selection.md) | How Kady builds the OpenRouter model list |
| [OpenRouter Fusion](./docs/openrouter-fusion.md) | Multi-model deliberation presets (this fork) — what they are and how the integration works |
| [Architecture](./docs/architecture.md) | How the two local services fit together |
| [Contributing workflows](./docs/contributing-workflows.md) | Add new workflow templates to the library |
| [Known limitations](./docs/limitations.md) | Rough edges to be aware of in the current beta |

## What's coming

Literature search (Paperclip), document conversion, browser automation, and the provenance/"Copy as Methods" export are being re-added in upcoming releases, along with MCP tools for sub-agents and a UI experience further tailored to scientific workflows. In the meantime, many of these are available today by connecting an [MCP server](./docs/mcp-servers.md).

## Want more?

K-Dense BYOK is great for getting started, but if you want end-to-end research workflows with managed infrastructure, team collaboration, and no setup required, check out **[K-Dense Web](https://www.k-dense.ai)** — our full platform built for professional and academic research teams.

## Issues, bugs, or feature requests

If you run into a problem or have an idea for something new, please [open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues). We read every one.

## About K-Dense

K-Dense BYOK is open source because [K-Dense](https://github.com/K-Dense-AI) believes in giving back to the community that makes this kind of work possible.

## Star history

[![Star History Chart](https://api.star-history.com/image?repos=K-Dense-AI/k-dense-byok&type=date&legend=top-left)](https://www.star-history.com/?repos=K-Dense-AI%2Fk-dense-byok&type=date&legend=top-left)
