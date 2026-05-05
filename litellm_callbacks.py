"""LiteLLM proxy callbacks / startup patches.

We pin `google-adk>=1.31.0`, which pins `litellm<=1.82.6`. That version has a
regression (#24234, fixed upstream in #24282) where routing a request with
model=`openrouter/<vendor>/<name>` and `custom_llm_provider="openrouter"` sends
the full `openrouter/<vendor>/<name>` string to OpenRouter, which rejects it
as "not a valid model ID". The proxy's wildcard routing path always resolves
`custom_llm_provider="openrouter"` for `openrouter/*` matches, so neither the
config alone nor `model: "*"` substitution alone can work around it.

Rather than enumerate every OpenRouter model in the config, we patch
`litellm.get_llm_provider` here to strip a stray `openrouter/` prefix whenever
the provider is already `openrouter`. This is exactly the behavior PR #24282
introduces upstream and runs only at proxy startup.

LiteLLM imports this module because it is declared in
`litellm_settings.callbacks` in `litellm_config.yaml`.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

import litellm
from litellm.integrations.custom_logger import CustomLogger
from litellm.litellm_core_utils import get_llm_provider_logic
from litellm.llms.openrouter.chat.transformation import OpenrouterConfig

# Ensure ``kady_agent`` is importable when the LiteLLM proxy is launched from
# a working directory that isn't the repo root (e.g. via ``uv run`` in CI).
_REPO_ROOT = Path(__file__).resolve().parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from kady_agent.runtime import record_cost  # noqa: E402
from kady_agent.runtime import extract_tags_from_headers  # noqa: E402

logger = logging.getLogger(__name__)


_ORIG_GET_LLM_PROVIDER = get_llm_provider_logic.get_llm_provider
_ORIG_OR_TRANSFORM_REQUEST = OpenrouterConfig.transform_request


def _strip_openrouter_prefix(model: str) -> str:
    """Drop a stray ``openrouter/`` prefix on ``<vendor>/<name>`` ids."""
    if (
        isinstance(model, str)
        and model.startswith("openrouter/")
        and model.count("/") >= 2
    ):
        return model[len("openrouter/") :]
    return model


def _patched_transform_request(  # type: ignore[no-untyped-def]
    self,
    model,
    messages,
    optional_params,
    litellm_params,
    headers,
):
    model = _strip_openrouter_prefix(model)
    return _ORIG_OR_TRANSFORM_REQUEST(
        self, model, messages, optional_params, litellm_params, headers
    )


OpenrouterConfig.transform_request = _patched_transform_request


def _patched_get_llm_provider(  # type: ignore[no-untyped-def]
    model,
    custom_llm_provider=None,
    api_base=None,
    api_key=None,
    litellm_params=None,
):
    """Strip a double `openrouter/` prefix before delegating.

    When the proxy router has already set ``custom_llm_provider='openrouter'``
    and the substituted ``model`` still carries the ``openrouter/`` prefix
    (e.g. ``openrouter/anthropic/claude-opus-4.7``), the upstream function
    short-circuits and forwards the prefixed id, which OpenRouter rejects.
    Drop the prefix in that narrow window so the dispatch sees the clean
    ``<vendor>/<model>`` string.
    """
    if (
        isinstance(model, str)
        and model.startswith("openrouter/")
        and custom_llm_provider == "openrouter"
        and model.count("/") >= 2
    ):
        # Letting the upstream auto-detect from the `openrouter/` prefix
        # strips it correctly. Passing custom_llm_provider="openrouter"
        # explicitly hits a bugged branch that keeps (or re-adds) the
        # prefix before the HTTP call.
        custom_llm_provider = None
    return _ORIG_GET_LLM_PROVIDER(
        model=model,
        custom_llm_provider=custom_llm_provider,
        api_base=api_base,
        api_key=api_key,
        litellm_params=litellm_params,
    )


get_llm_provider_logic.get_llm_provider = _patched_get_llm_provider
litellm.get_llm_provider = _patched_get_llm_provider


def _merge_header_sources(kwargs: dict[str, Any]) -> dict[str, str]:
    """Collect the full set of headers accompanying a proxy completion.

    We check three places in priority order:

    1. ``proxy_server_request.headers`` — the raw HTTP request the proxy
       received. This is where the Gemini CLI subprocess' custom headers
       land.
    2. ``optional_params.extra_headers`` — set when the proxy forwards
       extra_headers from the inbound request onto the outbound call.
    3. ``litellm_params.extra_headers`` — fallback for older LiteLLM
       versions that route headers through litellm_params.
    """
    merged: dict[str, str] = {}
    psr = kwargs.get("proxy_server_request")
    if isinstance(psr, dict):
        headers = psr.get("headers") or {}
        if isinstance(headers, dict):
            for k, v in headers.items():
                if v is not None:
                    merged[str(k)] = str(v)
    for key in ("optional_params", "litellm_params"):
        bucket = kwargs.get(key)
        if isinstance(bucket, dict):
            extra = bucket.get("extra_headers") or {}
            if isinstance(extra, dict):
                for k, v in extra.items():
                    if v is not None:
                        merged[str(k)] = str(v)
    return merged


class OpenRouterPrefixFix(CustomLogger):
    """LiteLLM proxy callback — patches + expert cost tracking.

    Importing this module installs the OpenRouter prefix patches above. The
    instance registered as a proxy callback also records one ledger entry
    per expert completion by pulling the ``X-Kady-*`` correlation headers
    off the inbound HTTP request.
    """

    def _record(self, kwargs: dict[str, Any], response_obj: Any) -> None:
        try:
            headers = _merge_header_sources(kwargs)
            tags = extract_tags_from_headers(headers)
            if not tags or tags.get("role") != "expert":
                return

            model = kwargs.get("model")
            if not isinstance(model, str):
                return
            # OpenRouter is the only provider the proxy routes to that
            # reports a real cost. The Gemini CLI can reach it through either
            # an openrouter/* wildcard or the proxy's gemini-* aliases.
            # Skip local ollama/* silently.
            if model.startswith("ollama/"):
                return
            if model.startswith("gemini-"):
                pass
            elif not model.startswith("openrouter/") and not model.startswith(
                "google/"
            ):
                # The proxy resolves ``openrouter/*`` wildcards to the bare
                # ``<vendor>/<model>`` id after our prefix patch runs, so
                # accept both shapes.
                if "/" not in model:
                    return

            cost = kwargs.get("response_cost")
            usage = None
            if response_obj is not None:
                usage = getattr(response_obj, "usage", None)
                if usage is None and isinstance(response_obj, dict):
                    usage = response_obj.get("usage")

            record_cost(
                session_id=tags["session_id"],
                turn_id=tags["turn_id"],
                role="expert",
                model=model,
                usage_dict=usage,
                cost_usd=cost,
                delegation_id=tags.get("delegation_id"),
                project_id=tags.get("project_id"),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Expert cost callback failed: %s", exc)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._record(kwargs, response_obj)

    async def async_log_success_event(
        self, kwargs, response_obj, start_time, end_time
    ):
        self._record(kwargs, response_obj)


proxy_handler_instance = OpenRouterPrefixFix()
