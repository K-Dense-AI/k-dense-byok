# Local models and OpenAI-compatible endpoints

You can run Kady entirely against local models - no OpenRouter key required for those models. This is useful if you want to keep everything on your machine or experiment without spending on API calls.

Two kinds of local server are supported, and they appear as separate sections in the model picker:

| Server | Section | Model refs |
|---|---|---|
| [Ollama](https://ollama.com) | **Local (Ollama)** | `ollama/<name>` |
| Anything speaking the OpenAI API — LM Studio, vLLM, text-generation-webui, `llama.cpp` server | **Local (OpenAI-compatible)** | `openai-compatible/<model-id>` |

## Ollama setup

1. **Install Ollama and start the daemon:**

   ```bash
   # macOS / Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve
   ```

   On Windows, download and run the installer from [ollama.com/download](https://ollama.com/download) — it starts the daemon for you.

2. **Pull one or more models:**

   ```bash
   ollama pull qwen3.6
   ollama pull qwen2.5-coder:7b
   ```

3. **(Optional) Custom Ollama host.** If your Ollama server lives somewhere other than `http://localhost:11434`, set `OLLAMA_BASE_URL` in the repo-root `.env`.

4. **Pick the model in the app.** Open the model dropdown in the chat input. Pulled models appear under the **Local (Ollama)** section at the bottom. Picking one routes Kady - and any subagents it spawns - through your local daemon.

The list is populated live from Ollama's `GET /api/tags` endpoint (via the backend's `/ollama/models` route), so pulling a new model and re-opening the dropdown is enough - no app restart needed.

To make a local model the default for every new chat, set in `.env`:

```bash
DEFAULT_MODEL_PROVIDER="ollama"
DEFAULT_MODEL_ID="llama3"   # any model you've pulled
```

## OpenAI-compatible endpoint setup

Any endpoint exposing the standard `GET /v1/models` and `POST /v1/chat/completions` endpoints works, including local servers such as LM Studio/vLLM and authenticated proxy projects such as New API or Sub2API. Unlike Ollama, this section is hidden until you configure it.

1. **Start the server or proxy endpoint.** In LM Studio use the *Developer* tab → *Start Server*; with vLLM use `vllm serve <model>`.

2. **Point Kady at it** in the repo-root `.env`. Both an endpoint root and a copied `/v1` URL are accepted:

   ```bash
   OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234
   ```

   For an authenticated endpoint, also set its Bearer token:

   ```bash
   OPENAI_COMPATIBLE_BASE_URL=https://proxy.example.com/v1
   OPENAI_COMPATIBLE_API_KEY=your-proxy-key
   ```

   The API key can also be saved or cleared live in **Settings → API keys**. **vLLM defaults to port 8000, which is Kady's backend port**, so move one of the two, e.g. `vllm serve <model> --port 1234`.

3. **Pick the model in the app.** Local models appear under **Local (OpenAI-compatible)**. Authenticated proxy models appear under **OpenAI-compatible endpoint** and are labelled externally billed. The list comes from `/v1/models`, so changing the served catalogue and re-opening the dropdown is enough.

To make one the default for every new chat:

```bash
DEFAULT_MODEL_PROVIDER="openai-compatible"
DEFAULT_MODEL_ID="qwen/qwen3-8b"   # exactly as your endpoint reports it
```

Notes:

- **One endpoint at a time.** There is a single OpenAI-compatible base URL. Ollama can still be used alongside it.
- **Billing is explicit.** No-key endpoints default to `local`/$0. Setting `OPENAI_COMPATIBLE_API_KEY` defaults the endpoint to `external`, because generic proxies do not provide trustworthy per-model pricing. If your local server itself requires authentication, set `OPENAI_COMPATIBLE_BILLING_MODE=local`. Generic proxy spend cannot be enforced by Kady's project cap.
- **Only the model id is read** from `/v1/models`. Servers disagree on other metadata, so Kady uses conservative defaults and disables thinking levels for this generic path.

## Caveats

Local models are fully supported, but skill-heavy work leans on model quality (see [Known limitations](./limitations.md)):

- **Tool-calling fidelity is noticeably weaker** on sub-frontier models.
- **Skills that rely on multi-tool choreography** (running scripts, chaining file edits, producing structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or temporarily switch back to an OpenRouter-hosted model) before assuming the workflow is broken.
