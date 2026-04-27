# Architecture

This page explains how K-Dense BYOK runs on your computer. You do not need to read this to use the app - it is here if you are curious or troubleshooting.

![K-Dense BYOK Architecture](k-dense-byok-architecture.png)

## The three services

The `start.sh` script launches three local services that work together:

| Service | Port | What it does |
|---------|------|--------------|
| **Frontend** | 3000 | The web interface in your browser - chat, file browser, and file previews |
| **Backend** | 8000 | The "brain" - runs Kady, coordinates expert agents, manages your sandbox and files |
| **LiteLLM proxy** | 4000 | A translator that routes AI requests to the model you picked (via OpenRouter, Ollama, etc.) |

When you send a message:

1. The frontend passes it to the backend, tagged with the project id and the chat tab's session id.
2. Kady (on the backend) decides whether to answer directly or delegate to an expert agent.
3. Any AI calls go through the LiteLLM proxy to the correct provider.
4. Responses stream back to your browser in real time.

## Chat tabs and sessions

Every chat tab in the UI is backed by its own backend **session**. A session
is a single conversation: an id, an ordered list of messages, and a cost
ledger. You can open up to 10 tabs in a project; the list of tabs lives only
in the browser, but each tab's session is persistent on disk under that
project.

What a tab owns (per-tab):

- Message history (one session row in `projects/<project>/sessions.db`).
- Selected orchestrator and expert models.
- Attached files for the next message and the queued-message buffer.
- Cost ledger (`projects/<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl`).
- The streaming connection — closing a tab aborts the in-flight turn for
  that session only.

What every tab in a project shares:

- The sandbox (`projects/<project>/sandbox/`) — files written by one tab are
  immediately visible to the others.
- Project settings: budget cap, custom MCP servers (`custom_mcps.json`),
  browser-automation toggle, and the project-level cost total shown in the
  header pill.
- API keys and global preferences from `kady_agent/.env`.

Switching tabs in the UI is purely client-side; the backend doesn't need to
know which tab is "active" because each request already carries its own
session id. Inactive tabs stay mounted in the DOM (hidden with CSS) so a
streaming turn keeps producing output even when you're looking at another
tab.

## First-run setup

The first time you run `./start.sh`, it will automatically:

- Create a Python virtual environment in `.venv/`
- Install all Python dependencies
- Install Node.js dependencies for the frontend
- Install the Gemini CLI
- Download the scientific skills catalogue
- Run `uvx browser-use install` once to download a headless Chromium (used for browser automation)

Subsequent starts skip these steps via marker files and are much faster.

## Project layout

```
k-dense-byok/
├── start.sh              ← The one script that starts everything
├── server.py             ← Backend server
├── kady_agent/           ← Kady's brain: instructions, tools, and config
│   ├── env.example       ← Template for your API keys (copy to .env)
│   ├── .env              ← Your API keys (created from env.example)
│   ├── agent.py          ← Main agent definition
│   └── tools/            ← Tools Kady can use (web search, delegation, etc.)
├── web/                  ← Frontend (the UI you see in your browser)
├── docs/                 ← Extended documentation (this folder)
└── projects/             ← All user work, one subdirectory per named project
    ├── index.json        ← Project registry (names, tags, archived flag)
    └── default/          ← The "Default" project
        ├── project.json      ← Project metadata
        ├── sandbox/          ← Workspace for files and expert tasks
        │   └── .kady/
        │       └── runs/<sessionId>/  ← Per-tab cost ledger and turn artifacts
        ├── custom_mcps.json  ← Per-project custom MCP servers
        └── sessions.db       ← Chat history (SQLite, one session per chat tab)
```

## A note on the expert model

The model you select in Kady's dropdown only applies to Kady (the main agent). When Kady delegates a task, the expert runs through the **Gemini CLI**, which always uses a Gemini model on [OpenRouter](https://openrouter.ai/) regardless of your dropdown choice.

The one exception is local Ollama models - if you pick an Ollama model, both Kady and the expert run through your local daemon. See [Local models with Ollama](./local-models-ollama.md).
