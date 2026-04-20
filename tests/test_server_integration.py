"""In-process integration tests for ``server.py`` and ``projects_api.py``.

We use ``httpx.ASGITransport`` so the FastAPI app handles requests without
binding a real port. Every test runs against an isolated projects root via
the ``asgi_client`` / ``active_project`` fixtures in ``conftest.py``.
"""

from __future__ import annotations

import io
import json
import types

import pytest

from kady_agent import manifest as manifest_module


pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# health / config / ollama
# ---------------------------------------------------------------------------


async def test_health_endpoint(asgi_client):
    resp = await asgi_client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_config_endpoint_reports_modal_status(asgi_client, monkeypatch):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.delenv("MODAL_TOKEN_SECRET", raising=False)
    resp = await asgi_client.get("/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["modal_configured"] is False


async def test_ollama_unavailable_returns_empty_list(asgi_client, monkeypatch):
    # Force server-side ollama probe to fail (without disturbing the ASGI
    # transport used by asgi_client). We replace the AsyncClient class that
    # ``server`` looked up, so only outbound probes are affected.
    import server as server_module

    class _FailingClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, *a, **kw):
            raise RuntimeError("no ollama")

    monkeypatch.setattr(server_module.httpx, "AsyncClient", _FailingClient)
    resp = await asgi_client.get("/ollama/models")
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "models": []}


# ---------------------------------------------------------------------------
# Custom MCPs settings round-trip
# ---------------------------------------------------------------------------


async def test_mcp_settings_roundtrip(asgi_client):
    # GET initially empty
    resp = await asgi_client.get("/settings/mcps")
    assert resp.status_code == 200
    assert resp.json() == {}

    # PUT new value
    resp = await asgi_client.put(
        "/settings/mcps", json={"myserver": {"command": "x"}}
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    # GET reflects the new value
    resp = await asgi_client.get("/settings/mcps")
    assert resp.json() == {"myserver": {"command": "x"}}


async def test_mcp_settings_rejects_non_object(asgi_client):
    resp = await asgi_client.put("/settings/mcps", json=["bad"])
    assert resp.status_code == 400


async def test_browser_use_settings(asgi_client):
    # Defaults
    resp = await asgi_client.get("/settings/browser-use")
    assert resp.status_code == 200
    cfg = resp.json()["config"]
    assert cfg["enabled"] is True

    # PUT patches partial fields
    resp = await asgi_client.put(
        "/settings/browser-use", json={"enabled": False, "headed": True}
    )
    assert resp.status_code == 200
    cfg = resp.json()["config"]
    assert cfg["enabled"] is False
    assert cfg["headed"] is True


# ---------------------------------------------------------------------------
# Sandbox file operations
# ---------------------------------------------------------------------------


async def test_sandbox_tree_empty(asgi_client, active_project):
    resp = await asgi_client.get("/sandbox/tree")
    assert resp.status_code == 200
    tree = resp.json()
    assert tree["name"] == active_project.sandbox.name
    assert tree["type"] == "directory"


async def test_sandbox_file_roundtrip(asgi_client, active_project):
    # PUT a file
    resp = await asgi_client.put(
        "/sandbox/file",
        params={"path": "notes.md"},
        content=b"hello world",
    )
    assert resp.status_code == 200
    assert resp.json()["saved"] == "notes.md"

    # GET it back
    resp = await asgi_client.get("/sandbox/file", params={"path": "notes.md"})
    assert resp.status_code == 200
    assert resp.text == "hello world"

    # Tree includes it
    tree = (await asgi_client.get("/sandbox/tree")).json()
    names = [c["name"] for c in tree["children"]]
    assert "notes.md" in names

    # Delete
    resp = await asgi_client.delete("/sandbox/file", params={"path": "notes.md"})
    assert resp.status_code == 200
    assert not (active_project.sandbox / "notes.md").exists()


async def test_sandbox_file_rejects_path_traversal(asgi_client):
    resp = await asgi_client.get("/sandbox/file", params={"path": "../../etc/passwd"})
    assert resp.status_code == 403


async def test_sandbox_file_not_found(asgi_client):
    resp = await asgi_client.get("/sandbox/file", params={"path": "missing.txt"})
    assert resp.status_code == 404


async def test_sandbox_mkdir_move_and_delete_directory(asgi_client, active_project):
    # mkdir
    resp = await asgi_client.post("/sandbox/mkdir", json={"path": "data"})
    assert resp.status_code == 200

    # duplicate mkdir -> 409
    resp = await asgi_client.post("/sandbox/mkdir", json={"path": "data"})
    assert resp.status_code == 409

    # Put a file inside
    await asgi_client.put(
        "/sandbox/file", params={"path": "data/a.txt"}, content=b"x"
    )

    # Move the dir
    resp = await asgi_client.post(
        "/sandbox/move", json={"src": "data", "dest": "renamed"}
    )
    assert resp.status_code == 200
    assert (active_project.sandbox / "renamed" / "a.txt").is_file()

    # Delete dir
    resp = await asgi_client.delete(
        "/sandbox/directory", params={"path": "renamed"}
    )
    assert resp.status_code == 200
    assert not (active_project.sandbox / "renamed").exists()


async def test_sandbox_upload_writes_files(asgi_client, active_project):
    files = {"files": ("a.txt", io.BytesIO(b"content"), "text/plain")}
    resp = await asgi_client.post("/sandbox/upload", files=files)
    assert resp.status_code == 200
    uploaded = resp.json()["uploaded"]
    assert uploaded == ["user_data/a.txt"]
    assert (active_project.upload_dir / "a.txt").read_bytes() == b"content"


# ---------------------------------------------------------------------------
# Manifest + costs
# ---------------------------------------------------------------------------


async def test_get_manifest_404_when_missing(asgi_client):
    resp = await asgi_client.get("/turns/sess-x/turn-x/manifest")
    assert resp.status_code == 404


async def test_session_costs_empty_by_default(asgi_client):
    resp = await asgi_client.get("/sessions/fresh/costs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sessionId"] == "fresh"
    assert body["totalUsd"] == 0.0


async def test_session_turns_lists_created_turns(asgi_client, active_project):
    turn_id, _ = await manifest_module.open_turn(
        session_id="s-int", user_text="hi", model="m"
    )
    resp = await asgi_client.get("/sessions/s-int/turns")
    assert resp.status_code == 200
    assert turn_id in resp.json()["turns"]


async def test_set_turn_citations_updates_manifest(asgi_client, active_project):
    turn_id, _ = await manifest_module.open_turn(
        session_id="s-cit", user_text="hi", model="m"
    )
    await manifest_module.close_turn(
        session_id="s-cit", turn_id=turn_id, assistant_text="hi back"
    )

    resp = await asgi_client.patch(
        f"/turns/s-cit/{turn_id}/citations",
        json={"total": 3, "verified": 2, "unresolved": 1},
    )
    assert resp.status_code == 200

    resp = await asgi_client.get(f"/turns/s-cit/{turn_id}/manifest")
    manifest = resp.json()
    assert manifest["citations"] == {"total": 3, "verified": 2, "unresolved": 1}


async def test_set_turn_citations_404_on_missing_manifest(asgi_client):
    resp = await asgi_client.patch(
        "/turns/nope/nope/citations", json={"total": 0}
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Revise markdown (stubbed litellm)
# ---------------------------------------------------------------------------


async def test_revise_markdown_calls_litellm(asgi_client, no_litellm, monkeypatch):
    from kady_agent import agent as agent_module

    monkeypatch.setattr(agent_module, "DEFAULT_MODEL", "openrouter/x/y")

    resp = await asgi_client.post(
        "/revise-markdown",
        json={"selection": "hello", "instruction": "make it shout"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["revised"] == "stub revised text"
    assert body["model"] == "openrouter/x/y"


async def test_revise_markdown_requires_selection(asgi_client):
    resp = await asgi_client.post(
        "/revise-markdown",
        json={"selection": "", "instruction": "do something"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Projects CRUD
# ---------------------------------------------------------------------------


async def test_projects_crud_roundtrip(asgi_client, monkeypatch):
    # Stub the background bootstrap so the test doesn't actually uv-sync.
    from kady_agent import projects_api as papi

    monkeypatch.setattr(papi, "_bootstrap_sandbox_bg", lambda *a, **kw: None)

    # List initial state
    resp = await asgi_client.get("/projects")
    assert resp.status_code == 200
    initial_ids = [p["id"] for p in resp.json()]

    # Create
    resp = await asgi_client.post(
        "/projects", json={"name": "Brand New", "id": "brand-new"}
    )
    assert resp.status_code == 201
    created = resp.json()
    assert created["id"] == "brand-new"
    assert created["name"] == "Brand New"

    # GET by id
    resp = await asgi_client.get(f"/projects/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["id"] == "brand-new"

    # PATCH
    resp = await asgi_client.patch(
        f"/projects/{created['id']}",
        json={"description": "updated"},
    )
    assert resp.status_code == 200
    assert resp.json()["description"] == "updated"

    # DELETE
    resp = await asgi_client.delete(f"/projects/{created['id']}")
    assert resp.status_code == 204

    # 404 after delete
    resp = await asgi_client.get(f"/projects/{created['id']}")
    assert resp.status_code == 404


async def test_project_cannot_delete_default(asgi_client, monkeypatch):
    from kady_agent import projects_api as papi

    monkeypatch.setattr(papi, "_bootstrap_sandbox_bg", lambda *a, **kw: None)

    # Create default.
    await asgi_client.post("/projects", json={"name": "Default", "id": "default"})
    resp = await asgi_client.delete("/projects/default")
    assert resp.status_code == 400


async def test_project_create_rejects_duplicate(asgi_client, monkeypatch):
    from kady_agent import projects_api as papi

    monkeypatch.setattr(papi, "_bootstrap_sandbox_bg", lambda *a, **kw: None)

    await asgi_client.post("/projects", json={"name": "x", "id": "dup-proj"})
    resp = await asgi_client.post("/projects", json={"name": "x", "id": "dup-proj"})
    assert resp.status_code == 400


async def test_verify_citations_endpoint_rejects_bad_body(asgi_client):
    resp = await asgi_client.post("/verify-citations", json=["bad"])
    assert resp.status_code == 400
    resp = await asgi_client.post(
        "/verify-citations", json={"text": "ok", "files": [1, 2]}
    )
    assert resp.status_code == 400


async def test_verify_citations_handles_empty_text(asgi_client):
    resp = await asgi_client.post("/verify-citations", json={"text": ""})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 0
