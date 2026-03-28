import os

from dotenv import load_dotenv
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from .mcps import all_mcps

from .tools.gemini_cli import delegate_task
from .utils import load_instructions

load_dotenv()

DEFAULT_MODEL = os.getenv(
    "DEFAULT_AGENT_MODEL", "openrouter/google/gemini-3.1-pro-preview"
)
EXTRA_HEADERS = {"X-Title": "Kady", "HTTP-Referer": "https://www.k-dense.ai"}
PARALLEL_API_KEY = os.getenv("PARALLEL_API_KEY")


def _override_model(callback_context, llm_request):
    override = callback_context.state.get("_model")
    if override:
        llm_request.model = override
    return None


root_agent = LlmAgent(
    name="MainAgent",
    model=LiteLlm(
        model=DEFAULT_MODEL,
        extra_headers=EXTRA_HEADERS,
    ),
    description="The main agent that makes sure the user's request is successfully fulfilled",
    instruction=load_instructions("main_agent"),
    tools=[delegate_task] + all_mcps,
    output_key="final_output",
    before_model_callback=_override_model,
)
