from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
load_dotenv(REPO_ROOT / "kady_agent" / ".env")
LIVE_BACKEND_URL = os.environ.get("KADY_TEST_BACKEND_URL", "http://127.0.0.1:8000")
LIVE_FRONTEND_URL = os.environ.get("KADY_TEST_FRONTEND_URL", "http://localhost:3000")
LIVE_LITELLM_URL = os.environ.get("KADY_TEST_LITELLM_URL", "http://127.0.0.1:4000")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "live_e2e: requires live LLM/API services")
    config.addinivalue_line("markers", "browser: requires Playwright and Chromium")


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    # Keep long-lived browser/real-service fixtures from running before the
    # async unit/API tests. The verification flow is fast tests first, live E2E
    # last, and this also prevents Playwright's loop from confusing pytest-asyncio.
    items.sort(key=lambda item: (1 if item.get_closest_marker("live_e2e") else 0, item.nodeid))


@pytest.fixture()
def isolated_projects_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setenv("KADY_PROJECTS_ROOT", str(root))

    from kady_agent import projects

    monkeypatch.setattr(projects, "PROJECTS_ROOT", root)
    monkeypatch.setattr(projects, "INDEX_PATH", root / "index.json")
    token = projects.set_active_project(projects.DEFAULT_PROJECT_ID)
    try:
        yield root
    finally:
        projects.ACTIVE_PROJECT.reset(token)


@pytest.fixture()
def isolated_project(isolated_projects_root: Path) -> str:
    from kady_agent import projects

    project_id = f"pytest-{uuid.uuid4().hex[:10]}"
    projects.create_project("Pytest Project", project_id=project_id)
    projects.ensure_project_exists(project_id)
    return project_id


@pytest.fixture()
def active_project(isolated_project: str) -> Iterator[str]:
    from kady_agent import projects

    token = projects.set_active_project(isolated_project)
    try:
        yield isolated_project
    finally:
        projects.ACTIVE_PROJECT.reset(token)


@pytest.fixture()
def client(isolated_projects_root: Path) -> Iterator[TestClient]:
    import server

    # The singleton session service can retain sqlite handles across tests.
    server._session_service._services.clear()
    with TestClient(server.app) as test_client:
        yield test_client


def make_project_headers(project_id: str) -> dict[str, str]:
    return {"X-Project-Id": project_id}


@pytest.fixture()
def project_headers(isolated_project: str) -> dict[str, str]:
    return make_project_headers(isolated_project)


def _port_open(url: str) -> bool:
    parsed = httpx.URL(url)
    host = parsed.host or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((host, port)) == 0


def _wait_http(url: str, *, timeout: float = 90.0) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            response = httpx.get(url, timeout=2.0)
            if response.status_code < 500:
                return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(1.0)
    raise AssertionError(f"Timed out waiting for {url}: {last_error}")


def _require_command(name: str) -> None:
    if shutil.which(name) is None:
        raise AssertionError(f"Required command not found on PATH: {name}")


def require_live_environment() -> None:
    for command in ("uv", "node", "npm", "gemini"):
        _require_command(command)
    if not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OR_API_KEY")):
        raise AssertionError("OPENROUTER_API_KEY or OR_API_KEY is required for live E2E tests")


@pytest.fixture(scope="session")
def live_projects_root(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = Path(os.environ.get("KADY_TEST_PROJECTS_ROOT", ""))
    if not root:
        root = tmp_path_factory.mktemp("kady-live-projects")
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture(scope="session")
def live_stack(live_projects_root: Path) -> Iterator[dict[str, str]]:
    require_live_environment()
    env = os.environ.copy()
    env["KADY_PROJECTS_ROOT"] = str(live_projects_root)
    env.setdefault("NEXT_PUBLIC_ADK_API_URL", LIVE_BACKEND_URL)

    processes: list[subprocess.Popen[str]] = []

    try:
        if not _port_open(LIVE_LITELLM_URL):
            processes.append(
                subprocess.Popen(
                    ["uv", "run", "litellm", "--config", "litellm_config.yaml", "--port", "4000"],
                    cwd=REPO_ROOT,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
            )

        backend_started = False
        if not _port_open(LIVE_BACKEND_URL):
            backend_started = True
            processes.append(
                subprocess.Popen(
                    ["uv", "run", "uvicorn", "server:app", "--port", "8000"],
                    cwd=REPO_ROOT,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
            )

        if not _port_open(LIVE_FRONTEND_URL):
            processes.append(
                subprocess.Popen(
                    ["npm", "run", "dev", "--", "--hostname", "127.0.0.1"],
                    cwd=REPO_ROOT / "web",
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
            )

        _wait_http(f"{LIVE_BACKEND_URL}/health")
        _wait_http(LIVE_FRONTEND_URL)
        yield {
            "backend": LIVE_BACKEND_URL,
            "frontend": LIVE_FRONTEND_URL,
            "litellm": LIVE_LITELLM_URL,
            "projects_root": str(live_projects_root if backend_started else REPO_ROOT / "projects"),
        }
    finally:
        for proc in reversed(processes):
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()


@pytest.fixture()
def live_project(live_stack: dict[str, str]) -> Iterator[dict[str, Any]]:
    project_id = f"live-pytest-{uuid.uuid4().hex[:8]}"
    payload = {"id": project_id, "name": "Live Pytest Project", "spendLimitUsd": None}
    response = httpx.post(
        f"{live_stack['backend']}/projects",
        json=payload,
        timeout=120.0,
    )
    response.raise_for_status()
    try:
        yield {"id": project_id, "headers": make_project_headers(project_id), **live_stack}
    finally:
        httpx.delete(
            f"{live_stack['backend']}/projects/{project_id}",
            headers=make_project_headers(project_id),
            timeout=30.0,
        )


@pytest.fixture(scope="session")
def browser_page(live_stack: dict[str, str]) -> Iterator[Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - dependency validation
        raise AssertionError("Playwright is required for browser tests") from exc

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(base_url=live_stack["frontend"])
        try:
            yield page
        finally:
            browser.close()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
