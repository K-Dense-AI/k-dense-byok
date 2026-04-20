"""Unit tests for ``kady_agent/project_session_service.py``.

We never instantiate a real ``DatabaseSessionService`` — it requires an async
SQLAlchemy engine. Instead we patch ``DatabaseSessionService`` inside the
module with a lightweight recorder so we can verify that each active project
maps to its own cached instance.
"""

from __future__ import annotations

from typing import Any

import pytest

from kady_agent import project_session_service as pss
from kady_agent import projects as projects_module


class _FakeDB:
    """Minimal DatabaseSessionService stand-in that records every call."""

    instances: list["_FakeDB"] = []

    def __init__(self, url: str) -> None:
        self.url = url
        self.calls: list[tuple[str, tuple, dict]] = []
        _FakeDB.instances.append(self)

    async def create_session(self, *args, **kw):
        self.calls.append(("create", args, kw))
        return {"id": kw.get("session_id") or "sess"}

    async def get_session(self, *args, **kw):
        self.calls.append(("get", args, kw))
        return {"id": kw.get("session_id")}

    async def list_sessions(self, *args, **kw):
        self.calls.append(("list", args, kw))
        return ["a", "b"]

    async def delete_session(self, *args, **kw):
        self.calls.append(("delete", args, kw))

    async def append_event(self, session, event):
        self.calls.append(("append", (session, event), {}))
        return event


@pytest.fixture(autouse=True)
def _stub_db(monkeypatch):
    _FakeDB.instances.clear()
    monkeypatch.setattr(pss, "DatabaseSessionService", _FakeDB)
    yield


async def test_service_caches_per_project(tmp_projects_root):
    svc = pss.ProjectSessionService()
    token_a = projects_module.set_active_project("a")
    try:
        await svc.create_session(app_name="k", user_id="u", session_id="s1")
    finally:
        projects_module.ACTIVE_PROJECT.reset(token_a)

    token_b = projects_module.set_active_project("b")
    try:
        await svc.create_session(app_name="k", user_id="u", session_id="s2")
    finally:
        projects_module.ACTIVE_PROJECT.reset(token_b)

    # Back to "a" — should reuse the first instance.
    token_a2 = projects_module.set_active_project("a")
    try:
        await svc.get_session(app_name="k", user_id="u", session_id="s1")
    finally:
        projects_module.ACTIVE_PROJECT.reset(token_a2)

    # Two distinct underlying DBs, one per project id.
    assert len(_FakeDB.instances) == 2
    urls = {db.url for db in _FakeDB.instances}
    assert any("/a/sessions.db" in u for u in urls)
    assert any("/b/sessions.db" in u for u in urls)


async def test_all_methods_delegate(tmp_projects_root):
    svc = pss.ProjectSessionService()
    token = projects_module.set_active_project("alpha")
    try:
        await svc.create_session(app_name="k", user_id="u", session_id="s1")
        await svc.get_session(app_name="k", user_id="u", session_id="s1")
        await svc.list_sessions(app_name="k", user_id="u")
        await svc.delete_session(app_name="k", user_id="u", session_id="s1")
        await svc.append_event({"id": "s1"}, {"ev": 1})
    finally:
        projects_module.ACTIVE_PROJECT.reset(token)

    assert len(_FakeDB.instances) == 1
    kinds = [c[0] for c in _FakeDB.instances[0].calls]
    assert kinds == ["create", "get", "list", "delete", "append"]
