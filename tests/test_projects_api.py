from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


def test_project_lifecycle_api(client, monkeypatch: pytest.MonkeyPatch) -> None:
    import kady_agent.projects as project_module

    monkeypatch.setattr(project_module, "_bootstrap_sandbox_sync", lambda project_id: None)
    monkeypatch.setattr(project_module, "_bootstrap_sandbox_bg", lambda project_id: None)

    response = client.post(
        "/projects",
        json={
            "id": "api-project",
            "name": "API Project",
            "description": "created by tests",
            "tags": ["pytest"],
            "spendLimitUsd": 12.5,
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["id"] == "api-project"

    listed = client.get("/projects").json()
    assert any(project["id"] == "api-project" for project in listed)

    patched = client.patch(
        "/projects/api-project",
        json={"description": "updated", "archived": True, "spendLimitUsd": None},
    )
    assert patched.status_code == 200
    assert patched.json()["description"] == "updated"
    assert patched.json()["archived"] is True
    assert patched.json()["spendLimitUsd"] is None

    costs = client.get("/projects/api-project/costs")
    assert costs.status_code == 200
    assert costs.json()["budget"]["state"] == "ok"

    delete = client.delete("/projects/api-project")
    assert delete.status_code == 204
    assert client.get("/projects/api-project").status_code == 404


def test_project_validation_and_default_delete(client) -> None:
    assert client.post("/projects", json={"id": "../bad", "name": "Bad"}).status_code == 400
    assert client.delete("/projects/default").status_code == 400


def test_project_scope_middleware_falls_back_on_invalid_project(client) -> None:
    response = client.get("/health", headers={"X-Project-Id": "../bad"})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
