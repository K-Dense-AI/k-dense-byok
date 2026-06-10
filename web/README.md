# K-Dense BYOK — Frontend

This is the web interface for [K-Dense BYOK](../README.md) (Next.js 16 / React 19): the chat tabs, file browser, previews, workflows library, and the Settings dialog (API keys, MCP servers, sub-agents, appearance).

It is started together with the backend by the repo-root `./start.sh` — you normally don't run it on its own. For development:

```bash
npm install
npm run dev        # http://localhost:3000 (expects the backend on :8000)
npx tsc --noEmit   # typecheck
npx vitest run     # tests
```

The backend URL can be overridden with `NEXT_PUBLIC_ADK_API_URL` (default `http://localhost:8000`).

See the main [README](../README.md) and [`docs/`](../docs) for user-facing documentation, and [`AGENTS.md`](../AGENTS.md) for contributor notes.
