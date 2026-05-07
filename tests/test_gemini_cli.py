from __future__ import annotations

import os
from types import SimpleNamespace

import pytest


def test_cli_model_routing_and_workdir_safety(active_project: str) -> None:
    from kady_agent import projects
    from kady_agent.tools import gemini_cli

    sandbox = projects.active_paths().sandbox
    nested = sandbox / "nested"
    nested.mkdir(parents=True)

    assert gemini_cli._cli_can_route("gemini-3-pro")
    assert gemini_cli._cli_can_route("ollama/llama3")
    assert gemini_cli._cli_can_route("openrouter/vendor/model")
    assert not gemini_cli._cli_can_route("anthropic/claude")

    assert gemini_cli._resolve_working_directory("nested", sandbox) == nested.resolve()
    assert gemini_cli._resolve_working_directory("/tmp", sandbox) == sandbox
    assert gemini_cli._build_cli_args("hi", "anthropic/claude") == [
        "gemini",
        "-p",
        "hi",
        "--yolo",
        "--output-format",
        "stream-json",
    ]


def test_parse_stream_json_extracts_text_skills_and_tools() -> None:
    from kady_agent.tools import gemini_cli

    raw = "\n".join(
        [
            '{"type":"tool_use","tool_name":"activate_skill","parameters":{"skill_name":"analysis"}}',
            '{"type":"tool_use","tool_name":"write_file","parameters":{}}',
            '{"type":"message","role":"assistant","content":"hello "}',
            "not json",
            '{"type":"message","role":"assistant","content":"world"}',
        ]
    )
    assert gemini_cli._parse_stream_json(raw) == {
        "result": "hello world",
        "skills_used": ["analysis"],
        "tools_used": {"activate_skill": 1, "write_file": 1},
    }


def test_expert_prompt_lists_only_user_visible_sandbox_paths(active_project: str) -> None:
    from kady_agent import projects
    from kady_agent.tools import gemini_cli

    sandbox = projects.active_paths().sandbox
    (sandbox / "visible.txt").write_text("visible", encoding="utf-8")
    (sandbox / "notes").mkdir()
    (sandbox / "notes" / "paper.md").write_text("paper", encoding="utf-8")
    (sandbox / ".kady").mkdir(exist_ok=True)
    (sandbox / ".kady" / "internal.json").write_text("{}", encoding="utf-8")
    (sandbox / "GEMINI.md").write_text("hidden", encoding="utf-8")
    (sandbox / "visible.txt.annotations.json").write_text("{}", encoding="utf-8")

    prompt = gemini_cli._build_expert_prompt("Summarize files", sandbox)

    assert "visible.txt" in prompt
    assert "notes/" in prompt
    assert "notes/paper.md" in prompt
    assert ".kady/internal.json" not in prompt
    assert "- GEMINI.md" not in prompt
    assert "visible.txt.annotations.json" not in prompt
    assert "Summarize files" in prompt


async def test_delegate_task_sets_env_and_attaches_manifest(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import runtime
    from kady_agent.tools import gemini_cli

    turn_id, _ = await runtime.open_turn(session_id="session-gemini", user_text="prompt")
    state = {
        "_sessionId": "session-gemini",
        "_turnId": turn_id,
        "_expertModel": "openrouter/vendor/expert",
    }
    captured: dict = {}

    async def fake_refresh() -> None:
        captured["refreshed"] = True

    def fake_write(target_dir):
        captured["settings_dir"] = str(target_dir)

    async def fake_run(cli_args, cwd, env):
        captured["cli_args"] = cli_args
        captured["cwd"] = cwd
        captured["env"] = env
        expert_dir = cwd / ".kady" / "expert" / "001"
        expert_dir.mkdir(parents=True, exist_ok=True)
        (expert_dir / "env.lock").write_text("python=3.13", encoding="utf-8")
        (expert_dir / "deliverables.json").write_text('["answer.txt"]', encoding="utf-8")
        return (
            '{"type":"tool_use","tool_name":"activate_skill","parameters":{"skill_name":"analysis"}}\n'
            '{"type":"message","role":"assistant","content":"done"}\n',
            123,
        )

    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.setenv("GEMINI_CLI_CUSTOM_HEADERS", "Existing: header")
    monkeypatch.setattr(gemini_cli, "refresh_oauth_tokens", fake_refresh)
    monkeypatch.setattr(gemini_cli, "write_merged_settings", fake_write)
    monkeypatch.setattr(gemini_cli, "_run_gemini_cli", fake_run)

    result = await gemini_cli.delegate_task(
        "Do expert work", tool_context=SimpleNamespace(state=state)
    )

    assert result["result"] == "done"
    assert result["skills_used"] == ["analysis"]
    assert captured["refreshed"] is True
    assert "Current user-visible sandbox contents" in captured["cli_args"][2]
    assert "Do expert work" in captured["cli_args"][2]
    assert captured["cli_args"][-2:] == ["-m", "openrouter/vendor/expert"]
    assert captured["env"]["KADY_SESSION_ID"] == "session-gemini"
    assert captured["env"]["KADY_TURN_ID"] == turn_id
    assert captured["env"]["KADY_DELEGATION_ID"] == "001"
    assert "GOOGLE_GENAI_USE_VERTEXAI" not in captured["env"]
    assert "X-Kady-Role: expert" in captured["env"]["GEMINI_CLI_CUSTOM_HEADERS"]
    assert "Existing: header" in captured["env"]["GEMINI_CLI_CUSTOM_HEADERS"]
    assert state[f"_delegation_counter_{turn_id}"] == 1

    manifest = runtime.read_manifest("session-gemini", turn_id)
    assert manifest["delegations"][0]["id"] == "001"
    assert manifest["delegations"][0]["deliverables"] == ["answer.txt"]


def test_budget_block_response(active_project: str) -> None:
    from kady_agent import projects, runtime
    from kady_agent.tools import gemini_cli

    projects.update_project(active_project, spend_limit_usd=0.01)
    runtime.record_cost(
        session_id="budget",
        turn_id="turn",
        role="expert",
        model="openrouter/vendor/model",
        usage_dict={},
        cost_usd=0.02,
        project_id=active_project,
    )

    response = gemini_cli._budget_block_response(active_project)
    assert response["budgetBlocked"] is True
    assert response["projectId"] == active_project
    assert "Delegation blocked" in response["result"]


async def test_delegate_task_defaults_to_expert_model(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import runtime
    from kady_agent.tools import gemini_cli

    turn_id, _ = await runtime.open_turn(session_id="session-default", user_text="prompt")
    state = {
        "_sessionId": "session-default",
        "_turnId": turn_id,
        "_model": "openrouter/anthropic/claude-opus-4.7",
    }
    captured: dict = {}

    async def fake_run(cli_args, cwd, env):
        captured["cli_args"] = cli_args
        return ('{"type":"message","role":"assistant","content":"done"}\n', 123)

    monkeypatch.setattr(gemini_cli, "write_merged_settings", lambda target_dir: None)

    async def fake_refresh() -> None:
        return None

    monkeypatch.setattr(gemini_cli, "refresh_oauth_tokens", fake_refresh)
    monkeypatch.setattr(gemini_cli, "_run_gemini_cli", fake_run)

    result = await gemini_cli.delegate_task(
        "Do expert work", tool_context=SimpleNamespace(state=state)
    )

    assert result["result"] == "done"
    assert captured["cli_args"][-2:] == ["-m", gemini_cli.DEFAULT_EXPERT_MODEL]


async def test_delegate_task_returns_cli_failures(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import runtime
    from kady_agent.tools import gemini_cli

    turn_id, _ = await runtime.open_turn(session_id="session-failure", user_text="prompt")
    state = {
        "_sessionId": "session-failure",
        "_turnId": turn_id,
        "_expertModel": "openrouter/anthropic/claude-opus-4.7",
    }

    async def fake_refresh() -> None:
        return None

    async def fake_run(cli_args, cwd, env):
        raise RuntimeError("TypeError: terminated")

    monkeypatch.setattr(gemini_cli, "refresh_oauth_tokens", fake_refresh)
    monkeypatch.setattr(gemini_cli, "write_merged_settings", lambda target_dir: None)
    monkeypatch.setattr(gemini_cli, "_run_gemini_cli", fake_run)

    result = await gemini_cli.delegate_task(
        "Do expert work", tool_context=SimpleNamespace(state=state)
    )

    assert result["error"] is True
    assert result["model"] == "openrouter/anthropic/claude-opus-4.7"
    assert "TypeError: terminated" in result["result"]


def test_apply_sandbox_venv_prefers_local_venv(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    from kady_agent.tools import gemini_cli

    cwd = tmp_path
    (cwd / ".venv" / "bin").mkdir(parents=True)
    monkeypatch.setenv("VIRTUAL_ENV", "/outer")
    env = {"PATH": os.pathsep.join(["/outer/bin", "/usr/bin"])}

    gemini_cli._apply_sandbox_venv(env, cwd)

    assert env["VIRTUAL_ENV"] == str(cwd / ".venv")
    assert env["PATH"].split(os.pathsep)[0] == str(cwd / ".venv" / "bin")
    assert "/outer/bin" not in env["PATH"].split(os.pathsep)
