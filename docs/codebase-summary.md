# K-Dense BYOK: Codebase Summary

## What it is

K-Dense BYOK is a free, open-source, local-first AI research workspace for scientists. It provides **Kady**, an agent that can move beyond answering questions to carrying out research tasks: inspecting files, writing and running analysis code, searching and reading sources, creating figures and reports, and recording its work in a living lab notebook.

Users choose how Kady reaches AI models. It supports prepaid OpenRouter API access, NVIDIA NIM models via build.nvidia.com API credits, free local Ollama models, and subscription authentication for ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, and xAI accounts. Projects, conversations, notebooks, and outputs remain in ordinary folders on the user’s computer; only material needed for a hosted request is sent to the selected provider.

## Core capabilities

- **End-to-end scientific work:** Clean and analyze datasets, run statistical methods, compare evidence, review manuscripts, generate publication-ready figures, and produce reusable scripts and reports.
- **Broad scientific knowledge:** 149 scientific skills, 326 guided workflows across 22 disciplines, and guidance for 229 scientific and financial data resources support fields including genomics, chemistry, drug discovery, materials science, clinical research, earth science, and finance.
- **Specialist collaboration:** Kady can delegate focused or parallel tasks to 21 scientific specialists for statistical review, citation checking, peer review, analysis, and literature synthesis.
- **Research traceability:** The Living Lab Notebook captures hypotheses, methods, observations, decisions, confidence, code, and linked artifacts. Users can annotate, search, export, and turn the record into a draft Methods section.
- **Scientific file workspace:** The app previews more than 60 scientific formats, including molecular and protein structures, spectra, sequence data, arrays, medical images, PDFs, notebooks, tables, and LaTeX.
- **Parallel, durable work:** Each project supports up to 10 independent chat sessions sharing the same files. Long-running cloud CPU or GPU jobs can run through Modal, survive backend restarts, and return outputs safely to the local workspace.
- **Choice and control:** Users can switch models per chat, use multi-model Fusion, connect external tools through MCP, inspect generated code, steer active runs, and stop work at any time.
- **Cost safeguards:** Metered model and remote-compute costs are tracked by run and project. Optional hard spending caps remain separate from provider-managed subscription quotas.

## How the codebase works

The repository contains two services launched together:

1. A **Next.js 16 / React 19 frontend** on port 3000 provides chat, project and file management, scientific previews, editors, provider settings, cost visibility, and the lab notebook.
2. A **TypeScript backend built around the Pi coding-agent SDK** on port 8000 manages agent sessions, tools, OAuth and API-key model access, project sandboxes, streaming events, specialists, budgets, and durable compute.

Each project is a self-contained local sandbox. Chat history, skills, specialist definitions, notebook entries, generated artifacts, compute state, and cost ledgers persist on disk. Model calls go directly to OpenRouter, NVIDIA NIM, Ollama, or the authenticated subscription provider without a separate model proxy. OAuth tokens live in a Kady-scoped, file-locked Pi credential store and are shared with child specialists without being copied into projects or process arguments.

## Why it matters

Most AI assistants stop at recommendations or generated text. K-Dense BYOK connects reasoning to execution in a workspace where the evidence, code, intermediate steps, costs, and final outputs can all be inspected. This makes AI-assisted research more reproducible and useful than a disconnected chat transcript.

Its local-first, provider-independent design also gives researchers meaningful control over privacy, model choice, cost, and data ownership. Local models can keep sensitive work on-device, while hosted subscriptions, API models, and optional cloud compute remain available for demanding tasks. Open-source code and ordinary project files reduce lock-in and make the system extensible through skills, specialists, workflows, and MCP connectors.

In short, K-Dense BYOK aims to make capable scientific agents accessible without requiring a managed platform or advanced coding experience—while keeping the researcher in charge of the methods, evidence, and conclusions.

> **Current status:** The project is in beta. AI-generated analyses and citations still require expert review, especially for consequential scientific or clinical decisions.
