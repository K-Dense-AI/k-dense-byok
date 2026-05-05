from __future__ import annotations

from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.integration


def test_settings_mcps_crud_status_and_oauth(
    client, project_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent.api import settings
    from kady_agent import mcp

    payload = {
        "custom-http": {"httpUrl": "https://mcp.example/mcp"},
        "custom-stdio": {"command": "tool", "args": ["--mcp"]},
    }
    saved = client.put("/settings/mcps", headers=project_headers, json=payload)
    assert saved.status_code == 200
    assert client.get("/settings/mcps", headers=project_headers).json() == payload

    async def fake_probe(url: str) -> bool:
        assert url == "https://mcp.example/mcp"
        return True

    async def fake_start(name: str, url: str, redirect_uri: str) -> str:
        assert name == "custom-http"
        assert url == "https://mcp.example/mcp"
        assert redirect_uri.endswith("/oauth/mcp/callback")
        return "https://auth.example/authorize"

    async def fake_complete(state: str, code: str) -> str:
        assert (state, code) == ("state", "code")
        return "custom-http"

    monkeypatch.setattr(settings, "_probe_needs_auth", fake_probe)
    monkeypatch.setattr(mcp, "start_flow", fake_start)
    monkeypatch.setattr(mcp, "complete_flow", fake_complete)

    status = client.get("/settings/mcps/status", headers=project_headers)
    assert status.status_code == 200
    custom = next(s for s in status.json()["servers"] if s["name"] == "custom-http")
    assert custom["needsAuth"] is True

    sign_in = client.post("/settings/mcps/custom-http/sign-in", headers=project_headers)
    assert sign_in.status_code == 200
    assert sign_in.json()["authUrl"] == "https://auth.example/authorize"

    callback = client.get(
        "/oauth/mcp/callback?state=state&code=code", headers=project_headers
    )
    assert callback.status_code == 200
    assert "Signed in to custom-http" in callback.text

    sign_out = client.post("/settings/mcps/custom-http/sign-out", headers=project_headers)
    assert sign_out.status_code == 200
    assert sign_out.json()["ok"] is True


def test_browser_use_settings_and_chrome_profiles(
    client, project_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    import kady_agent.mcp as mcp_module

    response = client.put(
        "/settings/browser-use",
        headers=project_headers,
        json={"enabled": False, "headed": True, "profile": "Default", "session": "s1"},
    )
    assert response.status_code == 200
    assert response.json()["config"]["enabled"] is False
    assert client.get("/settings/browser-use", headers=project_headers).json()["config"]["profile"] == "Default"

    monkeypatch.setattr(
        mcp_module,
        "detect_chrome_profiles",
        lambda: [SimpleNamespace(to_dict=lambda: {"id": "Default", "name": "Default"})],
    )
    profiles = client.get("/system/chrome-profiles", headers=project_headers)
    assert profiles.status_code == 200
    assert profiles.json()["profiles"] == [{"id": "Default", "name": "Default"}]


def test_system_health_config_and_ollama(client, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.get("/health").json() == {"status": "ok"}

    monkeypatch.setenv("MODAL_TOKEN_ID", "id")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "secret")
    assert client.get("/config").json() == {"modal_configured": True}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return {
                "models": [
                    {
                        "name": "llama3",
                        "size": 1_073_741_824,
                        "details": {
                            "family": "llama",
                            "parameter_size": "8B",
                            "quantization_level": "Q4",
                        },
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url: str):
            return FakeResponse()

    import kady_agent.api.system as system

    monkeypatch.setattr(system.httpx, "AsyncClient", FakeClient)
    response = client.get("/ollama/models")
    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == "ollama/llama3"


def test_revision_validation_and_success(
    client, project_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    import kady_agent.api.revision as revision

    assert client.post("/revise-markdown", headers=project_headers, json={}).status_code == 400
    assert revision.strip_md_fence("```markdown\nhello\n```") == "hello"

    class FakeChoice:
        message = SimpleNamespace(content="```markdown\nBetter text\n```")

    class FakeResponse:
        choices = [FakeChoice()]

    async def fake_acompletion(**kwargs):
        assert kwargs["temperature"] == 0.2
        return FakeResponse()

    import litellm

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    response = client.post(
        "/revise-markdown",
        headers=project_headers,
        json={"selection": "bad text", "instruction": "Improve"},
    )
    assert response.status_code == 200
    assert response.json()["revised"] == "Better text"
