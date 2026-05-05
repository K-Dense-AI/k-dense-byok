from __future__ import annotations

from fastapi import Request

from google.adk.auth.credential_service.in_memory_credential_service import (
    InMemoryCredentialService,
)
from google.adk.cli.adk_web_server import AdkWebServer
from google.adk.cli.utils.agent_loader import AgentLoader
from google.adk.cli.utils.service_factory import (
    create_artifact_service_from_options,
    create_memory_service_from_options,
)
from google.adk.evaluation.local_eval_set_results_manager import (
    LocalEvalSetResultsManager,
)
from google.adk.evaluation.local_eval_sets_manager import LocalEvalSetsManager

from kady_agent.api.revision import router as revision_router
from kady_agent.api.runs import router as runs_router
from kady_agent.api.sandbox import router as sandbox_router
from kady_agent.api.settings import router as settings_router
from kady_agent.api.system import router as system_router
from kady_agent.projects import (
    ACTIVE_PROJECT,
    DEFAULT_PROJECT_ID,
    ProjectSessionService,
    ensure_project_exists,
    projects_router,
)


# ---------------------------------------------------------------------------
# ADK app: construct AdkWebServer ourselves so we can install our
# project-scoped session service. Functionally equivalent to
# `get_fast_api_app(agents_dir=".", web=False, ...)` but with the session
# service swapped in from the start.
# ---------------------------------------------------------------------------

_AGENTS_DIR = "."
_agent_loader = AgentLoader(_AGENTS_DIR)
_eval_sets_manager = LocalEvalSetsManager(agents_dir=_AGENTS_DIR)
_eval_set_results_manager = LocalEvalSetResultsManager(agents_dir=_AGENTS_DIR)

_memory_service = create_memory_service_from_options(
    base_dir=_AGENTS_DIR,
    memory_service_uri=None,
)
_session_service = ProjectSessionService()
_artifact_service = create_artifact_service_from_options(
    base_dir=_AGENTS_DIR,
    artifact_service_uri=None,
    strict_uri=True,
    use_local_storage=True,
)
_credential_service = InMemoryCredentialService()

_adk_web_server = AdkWebServer(
    agent_loader=_agent_loader,
    session_service=_session_service,
    memory_service=_memory_service,
    artifact_service=_artifact_service,
    credential_service=_credential_service,
    eval_sets_manager=_eval_sets_manager,
    eval_set_results_manager=_eval_set_results_manager,
    agents_dir=_AGENTS_DIR,
    extra_plugins=None,
    auto_create_session=True,
)

app = _adk_web_server.get_fast_api_app(
    allow_origins=["http://localhost:3000"],
)


# ---------------------------------------------------------------------------
# Project scope: read `X-Project-Id` on every request and set the
# ACTIVE_PROJECT ContextVar. All downstream path resolution routes through
# active_paths() so the same request handler serves the right project.
# ---------------------------------------------------------------------------


@app.middleware("http")
async def project_scope(request: Request, call_next):
    # Prefer the explicit header (set by apiFetch); fall back to the
    # "kady-project" cookie so plain <img>/<a> URLs (where custom headers
    # can't be set) still land in the right project.
    raw = request.headers.get("x-project-id")
    if not (raw and raw.strip()):
        raw = request.query_params.get("project")
    if not (raw and raw.strip()):
        raw = request.cookies.get("kady-project")
    project_id = raw.strip() if raw and raw.strip() else DEFAULT_PROJECT_ID
    try:
        ensure_project_exists(project_id)
    except ValueError:
        project_id = DEFAULT_PROJECT_ID
        ensure_project_exists(project_id)
    token = ACTIVE_PROJECT.set(project_id)
    try:
        return await call_next(request)
    finally:
        ACTIVE_PROJECT.reset(token)


app.include_router(projects_router)
app.include_router(system_router)
app.include_router(settings_router)
app.include_router(revision_router)
app.include_router(runs_router)
app.include_router(sandbox_router)
