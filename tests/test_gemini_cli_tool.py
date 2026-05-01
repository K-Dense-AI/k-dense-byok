"""Unit tests for ``kady_agent/tools/gemini_cli.py``.

The heavy lifting (``delegate_task``) forks a subprocess; we replace
``asyncio.create_subprocess_exec`` with a fake that returns canned
stream-json output, then verify the manifest is updated with the right
delegation metadata.
"""

from __future__ import annotations

import asyncio
import json
import types
from pathlib import Path

import pytest

from kady_agent.tools import gemini_cli


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_cli_can_route_whitelist():
    assert gemini_cli._cli_can_route("gemini-pro") is True
    assert gemini_cli._cli_can_route("ollama/llama3") is True
    assert gemini_cli._cli_can_route("openrouter/anthropic/claude-opus-4.7") is True
    assert gemini_cli._cli_can_route("anthropic/claude-opus-4.7") is False


def test_parse_stream_json_handles_messages_and_tools():
    raw = "\n".join([
        json.dumps({"type": "message", "role": "assistant", "content": "hello "}),
        json.dumps({"type": "tool_use", "tool_name": "shell", "parameters": {}}),
        json.dumps({"type": "tool_use", "tool_name": "activate_skill",
                    "parameters": {"skill_name": "scanpy"}}),
        json.dumps({"type": "tool_use", "tool_name": "activate_skill",
                    "parameters": {"name": "scanpy"}}),  # duplicate, dedupes
        json.dumps({"type": "message", "role": "assistant", "content": "world"}),
        "",
        "not-json",
    ])
    parsed = gemini_cli._parse_stream_json(raw)
    assert parsed["result"] == "hello world"
    assert parsed["skills_used"] == ["scanpy"]
    assert parsed["tools_used"] == {"shell": 1, "activate_skill": 2}


def test_parse_stream_json_empty_input():
    assert gemini_cli._parse_stream_json("") == {
        "result": "",
        "skills_used": [],
        "tools_used": {},
    }


def test_collect_expert_artifacts(tmp_path):
    deleg_dir = tmp_path / "expert" / "d1"
    deleg_dir.mkdir(parents=True)
    (deleg_dir / "env.lock").write_text("numpy==2.0\n", encoding="utf-8")
    (deleg_dir / "deliverables.json").write_text(
        json.dumps(["out.csv", 42, {"ignored": True}]),
        encoding="utf-8",
    )
    env_lock, deliverables = gemini_cli._collect_expert_artifacts(tmp_path, "d1")
    assert env_lock == "numpy==2.0\n"
    # Integers are coerced via str(); dicts are filtered out.
    assert deliverables == ["out.csv", "42"]


def test_collect_expert_artifacts_missing_files_return_none(tmp_path):
    env_lock, deliverables = gemini_cli._collect_expert_artifacts(tmp_path, "d1")
    assert env_lock is None
    assert deliverables is None


def test_collect_expert_artifacts_ignores_non_list_json(tmp_path):
    deleg_dir = tmp_path / "expert" / "d1"
    deleg_dir.mkdir(parents=True)
    (deleg_dir / "deliverables.json").write_text('{"not": "list"}', encoding="utf-8")
    env_lock, deliverables = gemini_cli._collect_expert_artifacts(tmp_path, "d1")
    assert env_lock is None
    assert deliverables is None


# ---------------------------------------------------------------------------
# delegate_task (subprocess-mocked)
# ---------------------------------------------------------------------------


class _FakeProc:
    def __init__(self, stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> None:
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr


async def test_delegate_task_without_tool_context(active_project, monkeypatch):
    from kady_agent import projects as projects_module

    called = {}

    async def fake_exec(*args, **kwargs):
        called["args"] = args
        called["cwd"] = kwargs.get("cwd")
        called["env"] = kwargs.get("env")
        stream = "\n".join(
            [
                json.dumps({"type": "message", "role": "assistant", "content": "ok"}),
            ]
        ).encode()
        return _FakeProc(stream)

    monkeypatch.setattr(gemini_cli.asyncio, "create_subprocess_exec", fake_exec)

    result = await gemini_cli.delegate_task("please help")
    assert result["result"] == "ok"
    # Command assembled correctly
    assert called["args"][0] == "gemini"
    assert "--output-format" in called["args"]
    assert called["cwd"] == active_project.sandbox
    # Env was stamped with the active project id
    assert called["env"]["KADY_PROJECT_ID"] == active_project.id
    # Trust file is created and pointed at via env so the CLI honors the
    # workspace ``.gemini/settings.json`` (gemini-api-key auth).
    trust_path = projects_module.gemini_trusted_folders_path()
    assert called["env"]["GEMINI_CLI_TRUSTED_FOLDERS_PATH"] == str(trust_path)
    assert trust_path.is_file()
    assert json.loads(trust_path.read_text(encoding="utf-8")) == {
        str(projects_module.PROJECTS_ROOT): "TRUST_PARENT"
    }


async def test_delegate_task_routes_relative_working_dir_into_sandbox(active_project, monkeypatch):
    seen_cwd = {}

    async def fake_exec(*args, **kwargs):
        seen_cwd["cwd"] = kwargs.get("cwd")
        return _FakeProc(b"")

    monkeypatch.setattr(gemini_cli.asyncio, "create_subprocess_exec", fake_exec)

    await gemini_cli.delegate_task("hi", working_directory="sub/dir")
    assert seen_cwd["cwd"] == active_project.sandbox / "sub" / "dir"
    assert (active_project.sandbox / "sub" / "dir").is_dir()


async def test_delegate_task_falls_back_to_sandbox_for_escape(active_project, monkeypatch, tmp_path):
    seen_cwd = {}

    async def fake_exec(*args, **kwargs):
        seen_cwd["cwd"] = kwargs.get("cwd")
        return _FakeProc(b"")

    monkeypatch.setattr(gemini_cli.asyncio, "create_subprocess_exec", fake_exec)

    # Absolute path outside the sandbox must be rejected
    outside = tmp_path / "outside"
    outside.mkdir()
    await gemini_cli.delegate_task("hi", working_directory=str(outside))
    assert seen_cwd["cwd"] == active_project.sandbox


async def test_delegate_task_subprocess_failure_raises(active_project, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _FakeProc(b"", stderr=b"boom", returncode=1)

    monkeypatch.setattr(gemini_cli.asyncio, "create_subprocess_exec", fake_exec)

    with pytest.raises(RuntimeError, match="boom"):
        await gemini_cli.delegate_task("hi")


async def test_delegate_task_refreshes_oauth_and_writes_settings_before_spawn(
    active_project, monkeypatch
):
    """``delegate_task`` rotates near-expiry MCP tokens and re-emits the
    workspace ``settings.json`` before forking gemini, so the bearer the
    CLI reads is current and signed-in HTTP MCPs don't 401 the expert."""
    from kady_agent import gemini_settings, mcp_oauth

    mcp_oauth.save_token(
        "paperclip",
        {
            "access_token": "fresh-bearer",
            "obtained_at": 0,
            "expires_in": 3600,
            "token_type": "Bearer",
            "client_id": "abc",
            "token_endpoint": "https://paperclip.example/api/oauth/token",
        },
    )

    refresh_calls: list[bool] = []
    settings_writes: list[str] = []

    real_refresh = gemini_settings.refresh_oauth_tokens

    async def tracking_refresh():
        refresh_calls.append(True)
        await real_refresh()

    real_write = gemini_settings.write_merged_settings

    def tracking_write(path):
        settings_writes.append(str(path))
        real_write(path)

    monkeypatch.setattr(gemini_cli, "refresh_oauth_tokens", tracking_refresh)
    monkeypatch.setattr(gemini_cli, "write_merged_settings", tracking_write)

    async def fake_exec(*args, **kwargs):
        return _FakeProc(b"")

    monkeypatch.setattr(gemini_cli.asyncio, "create_subprocess_exec", fake_exec)
    await gemini_cli.delegate_task("hi")

    assert refresh_calls, "refresh_oauth_tokens was not called pre-spawn"
    assert settings_writes, "settings.json was not re-materialized pre-spawn"
    # The materialized file should carry the bearer Authorization header.
    settings_path = active_project.gemini_settings_dir / "settings.json"
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    assert (
        settings["mcpServers"]["paperclip"]["headers"]["Authorization"]
        == "Bearer fresh-bearer"
    )


async def test_delegate_task_records_delegation_when_state_present(
    active_project, monkeypatch
):
    # Pre-create a turn so attach_delegation has a manifest to mutate.
    from kady_agent import manifest as manifest_module

    turn_id, _ = await manifest_module.open_turn(
        session_id="s1", user_text="p", model="gemini-pro", expert_model="gemini-pro"
    )

    # Fake ToolContext carrying the state dict delegate_task reads.
    state = {
        "_sessionId": "s1",
        "_turnId": turn_id,
        "_expertModel": "gemini-pro",
    }
    ctx = types.SimpleNamespace(state=state)

    async def fake_exec(*args, **kwargs):
        # Emit some expert output
        out = json.dumps(
            {"type": "message", "role": "assistant", "content": "done"}
        ).encode() + b"\n"
        return _FakeProc(out)

    monkeypatch.setattr(gemini_cli.asyncio, "create_subprocess_exec", fake_exec)

    result = await gemini_cli.delegate_task("analyze", tool_context=ctx)
    assert result["result"] == "done"

    # Manifest now has one delegation recorded.
    manifest = manifest_module.read_manifest("s1", turn_id)
    assert manifest is not None
    assert len(manifest["delegations"]) == 1
    assert manifest["delegations"][0]["id"] == "001"
