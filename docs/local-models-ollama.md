# Local Models with Ollama

You can run Kady and the expert agent entirely against local models served by [Ollama](https://ollama.com) - no OpenRouter key required for those models. This is useful if you want to keep everything on your machine or experiment without spending on API calls.

## Setup

1. **Install Ollama and start the daemon:**

   ```bash
   # macOS / Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve
   ```

2. **Pull one or more models:**

   ```bash
   ollama pull qwen3.6
   ollama pull qwen2.5-coder:7b
   ```

3. **(Optional) Custom Ollama host.** If your Ollama server lives somewhere other than `http://localhost:11434`, set `OLLAMA_BASE_URL` in `kady_agent/.env`.

4. **Pick the model in the app.** Open the model dropdown in the chat input. Pulled models appear under the **Local (Ollama)** section at the bottom. Picking one routes Kady, and optionally the Gemini-CLI-backed expert, through your local daemon.

The list is populated live from Ollama's `GET /api/tags` endpoint, so pulling a new model and re-opening the dropdown is enough - no app restart needed.

## Caveats

Local models amplify the limitations of the Gemini CLI tooling and model tool-calling quality (see [Known limitations](./limitations.md)):

- **Tool-calling fidelity is noticeably weaker** on sub-frontier models.
- **Skills that rely on multi-tool choreography** (browsing, running scripts, producing structured output) are the most fragile.

If a delegation loops or ignores its skill, try a larger local model (or temporarily switch back to an OpenRouter-hosted model) before assuming the workflow is broken.
