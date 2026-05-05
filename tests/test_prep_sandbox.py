from __future__ import annotations


def test_install_browser_use_chromium_marker(tmp_path, monkeypatch) -> None:
    import prep_sandbox

    marker = tmp_path / ".browser-use-installed"
    calls: list[list[str]] = []

    def fake_run(cmd, check):
        calls.append(cmd)

    monkeypatch.setattr(prep_sandbox, "BROWSER_USE_MARKER", marker)
    monkeypatch.setattr(prep_sandbox.subprocess, "run", fake_run)

    prep_sandbox.install_browser_use_chromium()
    prep_sandbox.install_browser_use_chromium()

    assert calls == [["uvx", "browser-use", "install"]]
    assert marker.is_file()


def test_main_initializes_non_archived_projects(monkeypatch) -> None:
    import prep_sandbox

    calls: list[tuple] = []

    monkeypatch.setattr(
        prep_sandbox,
        "install_browser_use_chromium",
        lambda: calls.append(("install",)),
    )
    monkeypatch.setattr(
        prep_sandbox,
        "ensure_project_exists",
        lambda project_id: calls.append(("ensure", project_id)),
    )
    monkeypatch.setattr(
        prep_sandbox,
        "list_projects",
        lambda: [
            type("Meta", (), {"id": "active", "name": "Active", "archived": False})(),
            type("Meta", (), {"id": "archived", "name": "Archived", "archived": True})(),
        ],
    )
    monkeypatch.setattr(
        prep_sandbox,
        "init_project_sandbox",
        lambda project_id: calls.append(("init", project_id)),
    )

    prep_sandbox.main()

    assert ("ensure", prep_sandbox.DEFAULT_PROJECT_ID) in calls
    assert ("init", "active") in calls
    assert ("init", "archived") not in calls
