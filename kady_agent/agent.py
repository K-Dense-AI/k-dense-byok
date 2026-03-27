import os

from dotenv import load_dotenv
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from .mcps import all_mcps

from .tools.gemini_cli import delegate_task
from .tools.venice import (
    venice_generate_image,
    venice_upscale_image,
    venice_text_to_speech,
    venice_embed,
    venice_list_models,
)
from .utils import load_instructions

load_dotenv()

DEFAULT_MODEL = os.getenv("DEFAULT_AGENT_MODEL")
EXTRA_HEADERS = {"X-Title": "Kady", "HTTP-Referer": "https://www.k-dense.ai"}
PARALLEL_API_KEY = os.getenv("PARALLEL_API_KEY")
VENICE_API_KEY = os.getenv("VENICE_API_KEY")

# Route all model calls through the local LiteLLM proxy so both OpenRouter
# and Venice models are handled by a single routing layer.
LITELLM_PROXY_BASE = os.getenv("LITELLM_PROXY_BASE", "http://localhost:4000")
LITELLM_PROXY_KEY = os.getenv("LITELLM_PROXY_KEY", "sk-litellm-local")


def _override_model(callback_context, llm_request):
    override = callback_context.state.get("_model")
    if override:
        llm_request.model = override
    return None


# Venice tools are always registered; they fail gracefully when VENICE_API_KEY
# is absent so the agent can report the missing key to the user.
_venice_tools = [
    venice_generate_image,
    venice_upscale_image,
    venice_text_to_speech,
    venice_embed,
    venice_list_models,
]

root_agent = LlmAgent(
    name="MainAgent",
    model=LiteLlm(
        model=DEFAULT_MODEL,
        # Route through the local LiteLLM proxy so Venice models and
        # OpenRouter models both resolve without per-model configuration here.
        api_base=LITELLM_PROXY_BASE,
        api_key=LITELLM_PROXY_KEY,
        extra_headers=EXTRA_HEADERS,
    ),
    description="The main agent that makes sure the user's request is successfully fulfilled",
    instruction=load_instructions("main_agent"),
    tools=[delegate_task] + _venice_tools + all_mcps,
    output_key="final_output",
    before_model_callback=_override_model,
)
