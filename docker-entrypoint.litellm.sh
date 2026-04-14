#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  >&2 printf '%s\n' "ERROR: OPENROUTER_API_KEY is required for the LiteLLM runtime. Inject the upstream provider secret through the environment before starting this internal-only service."
  exit 1
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  >&2 printf '%s\n' "ERROR: GEMINI_API_KEY is required as the internal backend-to-LiteLLM credential. This is internal wiring, not the upstream provider secret."
  exit 1
fi

>&2 printf '%s\n' "LiteLLM runtime contract: internal base URL should be http://litellm:${LITELLM_PORT:-4000} in containers, and the backend must authenticate with GEMINI_API_KEY as the internal master key."

exec "$@"
