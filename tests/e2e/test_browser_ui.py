from __future__ import annotations

import re
import json

import httpx
import pytest


pytestmark = [pytest.mark.integration, pytest.mark.live_e2e, pytest.mark.browser]


def test_browser_ui_project_sandbox_settings_and_chat(browser_page, live_project) -> None:
    page = browser_page
    backend = live_project["backend"]
    project_id = live_project["id"]
    headers = live_project["headers"]

    httpx.put(
        f"{backend}/sandbox/file?path=browser-e2e.txt",
        headers=headers,
        content=b"browser fixture",
        timeout=30.0,
    ).raise_for_status()

    page.goto("/", wait_until="networkidle", timeout=120_000)
    encoded_project_id = json.dumps(project_id)
    page.evaluate(
        f"""
        const projectId = {encoded_project_id};
        window.localStorage.setItem('kady:activeProjectId', projectId);
        document.cookie = `kady-project=${{encodeURIComponent(projectId)}}; path=/`;
        window.dispatchEvent(new CustomEvent('kady:project-changed', {{ detail: {{ id: projectId }} }}));
        """
    )
    page.reload(wait_until="networkidle", timeout=120_000)

    page.get_by_label("Switch project").wait_for(timeout=30_000)
    page.get_by_placeholder(re.compile("Ask Kady anything")).wait_for(timeout=30_000)
    page.get_by_text("browser-e2e.txt").wait_for(timeout=30_000)

    page.get_by_text("browser-e2e.txt").click()
    page.get_by_text("browser fixture").wait_for(timeout=30_000)

    page.get_by_label("Open settings").click()
    page.get_by_text("Settings").wait_for(timeout=10_000)
    page.get_by_role("tab", name="MCP Servers").wait_for(timeout=10_000)
    page.get_by_role("tab", name="Browser").click()
    page.get_by_role("heading", name="Browser automation").wait_for(timeout=10_000)
    page.keyboard.press("Escape")

    prompt = (
        "Browser E2E smoke test: reply with the exact lowercase phrase formed "
        "by joining browser, e2e, and ok with hyphens. Do not call tools."
    )
    input_box = page.get_by_placeholder(re.compile("Ask Kady anything"))
    input_box.fill(prompt)
    input_box.press("Enter")
    page.get_by_text("browser-e2e-ok", exact=False).wait_for(timeout=240_000)

    cost_response = httpx.get(
        f"{backend}/projects/{project_id}/costs", headers=headers, timeout=30.0
    )
    cost_response.raise_for_status()
    assert "budget" in cost_response.json()
