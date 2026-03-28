"""Tests for server.py — FastAPI endpoints using TestClient."""

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# Patch get_fast_api_app to avoid pulling in the real agent
with patch("server.get_fast_api_app") as _mock_get_app:
    from fastapi import FastAPI

    _fake_app = FastAPI()
    _mock_get_app.return_value = _fake_app

# Now import the module under test (it registers routes on _fake_app)
import server  # noqa: E402

client = TestClient(server.app)


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    def test_returns_ok(self):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# /config
# ---------------------------------------------------------------------------


class TestConfigEndpoint:
    def test_modal_configured_false(self):
        with patch.dict(os.environ, {}, clear=True):
            resp = client.get("/config")
        assert resp.status_code == 200
        assert resp.json()["modal_configured"] is False

    def test_modal_configured_true(self):
        env = {"MODAL_TOKEN_ID": "id", "MODAL_TOKEN_SECRET": "secret"}
        with patch.dict(os.environ, env, clear=True):
            resp = client.get("/config")
        assert resp.status_code == 200
        assert resp.json()["modal_configured"] is True


# ---------------------------------------------------------------------------
# /settings/mcps
# ---------------------------------------------------------------------------


class TestMcpsEndpoints:
    def test_get_returns_dict(self):
        with patch("server.load_custom_mcps", return_value={"mcp1": {}}):
            resp = client.get("/settings/mcps")
        assert resp.status_code == 200
        assert resp.json() == {"mcp1": {}}

    def test_put_saves_and_rebuilds(self, tmp_path, monkeypatch):
        monkeypatch.setattr("server.SANDBOX_ROOT", tmp_path / "sandbox")
        with (
            patch("server.save_custom_mcps") as mock_save,
            patch("server.write_merged_settings") as mock_write,
        ):
            resp = client.put("/settings/mcps", json={"new-mcp": {"command": "x"}})
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_save.assert_called_once_with({"new-mcp": {"command": "x"}})
        mock_write.assert_called_once()

    def test_put_rejects_invalid_json(self):
        resp = client.put(
            "/settings/mcps",
            content=b"NOT JSON",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_put_rejects_non_dict(self):
        resp = client.put("/settings/mcps", json=[1, 2, 3])
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /skills
# ---------------------------------------------------------------------------


class TestSkillsEndpoint:
    def test_empty_when_no_skills_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr("server.SANDBOX_ROOT", tmp_path / "sandbox")
        (tmp_path / "sandbox").mkdir()
        resp = client.get("/skills")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_lists_skills_from_skill_md(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        skills_dir = sb / ".gemini" / "skills" / "my-skill"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text(
            "---\nname: My Skill\ndescription: A test skill\n---\nContent"
        )
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/skills")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["id"] == "my-skill"
        assert data[0]["name"] == "My Skill"
        assert data[0]["description"] == "A test skill"


# ---------------------------------------------------------------------------
# /sandbox/tree
# ---------------------------------------------------------------------------


class TestSandboxTree:
    def test_empty_sandbox(self, tmp_path, monkeypatch):
        monkeypatch.setattr("server.SANDBOX_ROOT", tmp_path / "sandbox")
        (tmp_path / "sandbox").mkdir()
        resp = client.get("/sandbox/tree")
        assert resp.status_code == 200
        tree = resp.json()
        assert tree["name"] == "sandbox"
        assert tree["children"] == []

    def test_nonexistent_sandbox(self, tmp_path, monkeypatch):
        monkeypatch.setattr("server.SANDBOX_ROOT", tmp_path / "nope")
        resp = client.get("/sandbox/tree")
        assert resp.status_code == 200
        assert resp.json()["children"] == []

    def test_lists_files_and_dirs(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "file.txt").write_text("hello")
        (sb / "subdir").mkdir()
        (sb / "subdir" / "inner.txt").write_text("world")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/tree")
        tree = resp.json()
        names = [c["name"] for c in tree["children"]]
        assert "file.txt" in names
        assert "subdir" in names


# ---------------------------------------------------------------------------
# /sandbox/file (GET, PUT, DELETE)
# ---------------------------------------------------------------------------


class TestSandboxFileCRUD:
    def test_get_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "test.txt").write_text("content")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/file", params={"path": "test.txt"})
        assert resp.status_code == 200
        assert resp.text == "content"

    def test_get_missing_file_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/file", params={"path": "missing.txt"})
        assert resp.status_code == 404

    def test_path_traversal_denied(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/file", params={"path": "../etc/passwd"})
        assert resp.status_code == 403

    def test_put_saves_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.put(
            "/sandbox/file", params={"path": "new.txt"}, content="hello world"
        )
        assert resp.status_code == 200
        assert (sb / "new.txt").read_text() == "hello world"

    def test_delete_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "del.txt").write_text("bye")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/file", params={"path": "del.txt"})
        assert resp.status_code == 200
        assert not (sb / "del.txt").exists()

    def test_delete_missing_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/file", params={"path": "nope.txt"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# /sandbox/mkdir
# ---------------------------------------------------------------------------


class TestSandboxMkdir:
    def test_creates_directory(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/mkdir", json={"path": "new_dir"})
        assert resp.status_code == 200
        assert (sb / "new_dir").is_dir()

    def test_existing_path_409(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "exists").mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/mkdir", json={"path": "exists"})
        assert resp.status_code == 409


# ---------------------------------------------------------------------------
# /sandbox/move
# ---------------------------------------------------------------------------


class TestSandboxMove:
    def test_moves_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "a.txt").write_text("data")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/move", json={"src": "a.txt", "dest": "b.txt"})
        assert resp.status_code == 200
        assert not (sb / "a.txt").exists()
        assert (sb / "b.txt").read_text() == "data"

    def test_source_not_found_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/move", json={"src": "nope", "dest": "there"})
        assert resp.status_code == 404

    def test_dest_exists_409(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "src.txt").write_text("s")
        (sb / "dst.txt").write_text("d")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/move", json={"src": "src.txt", "dest": "dst.txt"})
        assert resp.status_code == 409


# ---------------------------------------------------------------------------
# /sandbox/delete-directory
# ---------------------------------------------------------------------------


class TestSandboxDeleteDirectory:
    def test_deletes_directory(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "removeme"
        d.mkdir(parents=True)
        (d / "file.txt").write_text("x")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/directory", params={"path": "removeme"})
        assert resp.status_code == 200
        assert not d.exists()

    def test_not_found_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/directory", params={"path": "nope"})
        assert resp.status_code == 404

    def test_cannot_delete_root(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/directory", params={"path": ""})
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# /sandbox/upload
# ---------------------------------------------------------------------------


class TestSandboxUpload:
    def test_uploads_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("hello.txt", b"content", "text/plain")},
            data={"paths": ["hello.txt"]},
        )
        assert resp.status_code == 200
        assert any("hello.txt" in p for p in resp.json()["uploaded"])


# ---------------------------------------------------------------------------
# _safe_path helper
# ---------------------------------------------------------------------------


class TestSafePath:
    def test_normal_path(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        result = server._safe_path("subdir/file.txt")
        assert result == sb / "subdir" / "file.txt"

    def test_traversal_raises(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        with pytest.raises(Exception):  # HTTPException
            server._safe_path("../../etc/passwd")


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_tree edge cases
# ---------------------------------------------------------------------------


class TestSandboxTreeEdgeCases:
    def test_hidden_files_excluded(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / ".hidden").write_text("secret")
        (sb / "visible.txt").write_text("hello")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/tree")
        tree = resp.json()
        names = [c["name"] for c in tree["children"]]
        assert "visible.txt" in names
        assert ".hidden" not in names

    def test_nested_directories(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        inner = sb / "a" / "b" / "c"
        inner.mkdir(parents=True)
        (inner / "deep.txt").write_text("deep")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/tree")
        tree = resp.json()
        a_node = next(c for c in tree["children"] if c["name"] == "a")
        b_node = next(c for c in a_node["children"] if c["name"] == "b")
        c_node = next(c for c in b_node["children"] if c["name"] == "c")
        assert any(ch["name"] == "deep.txt" for ch in c_node["children"])

    def test_depth_limit_stops_at_8(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        current = sb
        for i in range(12):
            current = current / f"level{i}"
        current.mkdir(parents=True)
        (current / "toodeep.txt").write_text("x")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/tree")
        tree = resp.json()
        # Walk 9 levels deep (depth 0-8), the 10th should be empty children
        node = tree
        for i in range(9):
            dirs = [c for c in node["children"] if c["type"] == "directory"]
            if not dirs:
                break
            node = dirs[0]
        # After 8 levels of recursion, the node should have empty children
        # because depth > 8 short-circuits

    def test_excluded_names_filtered(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "GEMINI.md").write_text("gemini")
        (sb / "uv.lock").write_text("lock")
        (sb / "normal.txt").write_text("ok")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/tree")
        tree = resp.json()
        names = [c["name"] for c in tree["children"]]
        assert "GEMINI.md" not in names
        assert "uv.lock" not in names
        assert "normal.txt" in names

    def test_file_has_size_field(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "sized.txt").write_text("hello world")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/tree")
        tree = resp.json()
        file_node = next(c for c in tree["children"] if c["name"] == "sized.txt")
        assert file_node["size"] == 11


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_upload edge cases
# ---------------------------------------------------------------------------


class TestSandboxUploadEdgeCases:
    def test_upload_without_paths(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("data.csv", b"1,2,3", "text/csv")},
        )
        assert resp.status_code == 200
        uploaded = resp.json()["uploaded"]
        assert any("data.csv" in p for p in uploaded)
        assert (sb / "user_data" / "data.csv").read_text() == "1,2,3"

    def test_upload_dotfile_rejected(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        resp = client.post(
            "/sandbox/upload",
            files={"files": (".env", b"SECRET=1", "text/plain")},
        )
        assert resp.status_code == 200
        assert resp.json()["uploaded"] == []

    def test_upload_traversal_parts_stripped(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("file.txt", b"content", "text/plain")},
            data={"paths": ["../etc/passwd"]},
        )
        assert resp.status_code == 403
        assert "traversal" in resp.json()["detail"].lower()

    def test_upload_all_dots_path_rejected(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("file.txt", b"x", "text/plain")},
            data={"paths": ["..."]},
        )
        assert resp.status_code == 200
        # "..." is not ".." or "." so it passes safe_parts filter

    def test_upload_preserves_subdirectory(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("f.txt", b"abc", "text/plain")},
            data={"paths": ["sub/dir/f.txt"]},
        )
        assert resp.status_code == 200
        assert (sb / "user_data" / "sub" / "dir" / "f.txt").read_text() == "abc"


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_save_file edge cases
# ---------------------------------------------------------------------------


class TestSandboxSaveFileEdgeCases:
    def test_save_new_file_creates_parent(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.put(
            "/sandbox/file",
            params={"path": "new_dir/new_file.txt"},
            content="brand new",
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["saved"] == "new_dir/new_file.txt"
        assert data["size"] == len(b"brand new")
        assert (sb / "new_dir" / "new_file.txt").read_text() == "brand new"

    def test_save_overwrites_existing(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "exists.txt").write_text("old content")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.put(
            "/sandbox/file",
            params={"path": "exists.txt"},
            content="new content",
        )
        assert resp.status_code == 200
        assert (sb / "exists.txt").read_text() == "new content"

    def test_save_binary_content(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        binary_data = bytes(range(256))
        resp = client.put(
            "/sandbox/file",
            params={"path": "binary.bin"},
            content=binary_data,
        )
        assert resp.status_code == 200
        assert (sb / "binary.bin").read_bytes() == binary_data


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_get_file edge cases
# ---------------------------------------------------------------------------


class TestSandboxGetFileEdgeCases:
    def test_large_file_rejected(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        big = sb / "big.txt"
        big.write_bytes(b"x" * 513_000)
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/file", params={"path": "big.txt"})
        assert resp.status_code == 413

    def test_directory_returns_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        (sb / "dir").mkdir(parents=True)
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/file", params={"path": "dir"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_delete edge cases
# ---------------------------------------------------------------------------


class TestSandboxDeleteEdgeCases:
    def test_delete_traversal_denied(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/file", params={"path": "../../etc/passwd"})
        assert resp.status_code == 403

    def test_delete_returns_deleted_name(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "x.txt").write_text("x")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/file", params={"path": "x.txt"})
        assert resp.status_code == 200
        assert resp.json()["deleted"] == "x.txt"


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_delete_directory edge cases
# ---------------------------------------------------------------------------


class TestSandboxDeleteDirectoryEdgeCases:
    def test_delete_recursive_with_contents(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "deep"
        (d / "sub").mkdir(parents=True)
        (d / "sub" / "file.txt").write_text("inner")
        (d / "top.txt").write_text("outer")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/directory", params={"path": "deep"})
        assert resp.status_code == 200
        assert not d.exists()

    def test_delete_file_instead_of_dir_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "file.txt").write_text("not a dir")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.delete("/sandbox/directory", params={"path": "file.txt"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_move edge cases
# ---------------------------------------------------------------------------


class TestSandboxMoveEdgeCases:
    def test_move_into_itself_blocked(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "mydir"
        d.mkdir(parents=True)
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/move", json={"src": "mydir", "dest": "mydir/sub"})
        assert resp.status_code == 400

    def test_move_dest_parent_missing_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "src.txt").write_text("data")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post(
            "/sandbox/move", json={"src": "src.txt", "dest": "nonexist/dest.txt"}
        )
        assert resp.status_code == 404

    def test_move_directory(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "olddir").mkdir()
        (sb / "olddir" / "file.txt").write_text("inside")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/move", json={"src": "olddir", "dest": "newdir"})
        assert resp.status_code == 200
        assert not (sb / "olddir").exists()
        assert (sb / "newdir" / "file.txt").read_text() == "inside"

    def test_move_traversal_denied(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "src.txt").write_text("data")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post(
            "/sandbox/move", json={"src": "src.txt", "dest": "../escape.txt"}
        )
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_mkdir edge cases
# ---------------------------------------------------------------------------


class TestSandboxMkdirEdgeCases:
    def test_parent_missing_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/mkdir", json={"path": "no_parent/child"})
        assert resp.status_code == 404

    def test_nested_mkdir_success(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "parent").mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post("/sandbox/mkdir", json={"path": "parent/child"})
        assert resp.status_code == 200
        assert (sb / "parent" / "child").is_dir()


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_download_dir
# ---------------------------------------------------------------------------


class TestSandboxDownloadDir:
    def test_downloads_zip(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "mydir"
        d.mkdir(parents=True)
        (d / "a.txt").write_text("aaa")
        (d / "b.txt").write_text("bbb")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-dir", params={"path": "mydir"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/zip"
        assert "mydir.zip" in resp.headers["content-disposition"]

    def test_empty_dir_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "empty"
        d.mkdir(parents=True)
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-dir", params={"path": "empty"})
        assert resp.status_code == 404

    def test_not_a_dir_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "file.txt").write_text("data")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-dir", params={"path": "file.txt"})
        assert resp.status_code == 404

    def test_excludes_hidden_files_from_zip(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "pkg"
        d.mkdir(parents=True)
        (d / "visible.txt").write_text("v")
        (d / ".hidden").write_text("h")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-dir", params={"path": "pkg"})
        assert resp.status_code == 200

    def test_excludes_special_names_from_zip(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        d = sb / "pkg2"
        d.mkdir(parents=True)
        (d / "GEMINI.md").write_text("g")
        (d / "good.txt").write_text("ok")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-dir", params={"path": "pkg2"})
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_raw (inline file serve with MIME)
# ---------------------------------------------------------------------------


class TestSandboxRaw:
    def test_serves_image_png(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "photo.png"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert "inline" in resp.headers["content-disposition"]

    def test_serves_jpeg(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "pic.jpg").write_bytes(b"\xff\xd8\xff\xe0")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "pic.jpg"})
        assert resp.status_code == 200
        assert "image/jpeg" in resp.headers["content-type"]

    def test_serves_pdf(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "doc.pdf").write_bytes(b"%PDF-1.4")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "doc.pdf"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"

    def test_unknown_extension_octet_stream(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "data.xyz123").write_bytes(b"binary")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "data.xyz123"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/octet-stream"

    def test_missing_file_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "nope.png"})
        assert resp.status_code == 404

    def test_traversal_denied(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "../etc/passwd"})
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_download (single file)
# ---------------------------------------------------------------------------


class TestSandboxDownload:
    def test_downloads_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "report.csv").write_text("a,b,c\n1,2,3")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download", params={"path": "report.csv"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/octet-stream"
        assert "report.csv" in resp.headers["content-disposition"]
        assert "attachment" in resp.headers["content-disposition"]

    def test_missing_file_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download", params={"path": "none.txt"})
        assert resp.status_code == 404

    def test_traversal_denied(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download", params={"path": "../etc/shadow"})
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_download_all
# ---------------------------------------------------------------------------


class TestSandboxDownloadAll:
    def test_downloads_full_sandbox(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "a.txt").write_text("aaa")
        (sb / "sub").mkdir()
        (sb / "sub" / "b.txt").write_text("bbb")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-all")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/zip"
        assert "sandbox.zip" in resp.headers["content-disposition"]

    def test_empty_sandbox_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-all")
        assert resp.status_code == 404

    def test_nonexistent_sandbox_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "no_sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-all")
        assert resp.status_code == 404

    def test_only_hidden_files_404(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / ".secret").write_text("hidden")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/download-all")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Additional coverage: sandbox_compile_latex
# ---------------------------------------------------------------------------


class TestSandboxCompileLatex:
    def test_invalid_engine_rejected(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post(
            "/sandbox/compile-latex",
            json={"path": "doc.tex", "engine": "invalidengine"},
        )
        assert resp.status_code == 400
        assert "Unsupported engine" in resp.json()["detail"]

    def test_missing_tex_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post(
            "/sandbox/compile-latex",
            json={"path": "missing.tex", "engine": "pdflatex"},
        )
        assert resp.status_code == 400
        assert "Not a .tex file" in resp.json()["detail"]

    def test_non_tex_extension_rejected(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "doc.txt").write_text("not latex")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post(
            "/sandbox/compile-latex",
            json={"path": "doc.txt", "engine": "pdflatex"},
        )
        assert resp.status_code == 400

    def test_valid_tex_compilation(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        tex_content = r"\documentclass{article}\begin{document}Hello\end{document}"
        (sb / "doc.tex").write_text(tex_content)
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.post(
            "/sandbox/compile-latex",
            json={"path": "doc.tex", "engine": "pdflatex"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "success" in data
        assert "log" in data
        assert "errors" in data


# ---------------------------------------------------------------------------
# Additional coverage: list_skills edge cases
# ---------------------------------------------------------------------------


class TestSkillsEdgeCases:
    def test_skill_with_no_frontmatter(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        skills_dir = sb / ".gemini" / "skills" / "raw-skill"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text("Just plain text, no frontmatter")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/skills")
        assert resp.status_code == 200
        data = resp.json()
        # Should be empty since no frontmatter parsed
        ids = [s["id"] for s in data]
        assert "raw-skill" not in ids

    def test_skill_file_not_dir(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        skills_dir = sb / ".gemini" / "skills"
        skills_dir.mkdir(parents=True)
        # A file (not dir) named "not-a-skill"
        (skills_dir / "not-a-skill").write_text("file not directory")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/skills")
        assert resp.status_code == 200
        data = resp.json()
        ids = [s["id"] for s in data]
        assert "not-a-skill" not in ids

    def test_skill_missing_skill_md(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        skills_dir = sb / ".gemini" / "skills" / "empty-skill"
        skills_dir.mkdir(parents=True)
        # No SKILL.md file
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/skills")
        assert resp.status_code == 200
        data = resp.json()
        ids = [s["id"] for s in data]
        assert "empty-skill" not in ids

    def test_malformed_yaml_frontmatter(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        skills_dir = sb / ".gemini" / "skills" / "bad-yaml"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text("---\nname: [\ninvalid yaml\n---\nContent")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/skills")
        assert resp.status_code == 200
        # Should not crash; may or may not include the skill depending on yaml parsing

    def test_multiple_skills(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        for name in ("alpha", "beta", "gamma"):
            d = sb / ".gemini" / "skills" / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(
                f"---\nname: {name.title()}\ndescription: Skill {name}\n---\nContent"
            )
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/skills")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3
        names = {s["name"] for s in data}
        assert names == {"Alpha", "Beta", "Gamma"}


# ---------------------------------------------------------------------------
# Additional coverage: put_custom_mcps edge cases
# ---------------------------------------------------------------------------


class TestPutCustomMcpsEdgeCases:
    def test_put_empty_dict(self, tmp_path, monkeypatch):
        monkeypatch.setattr("server.SANDBOX_ROOT", tmp_path / "sandbox")
        with (
            patch("server.save_custom_mcps") as mock_save,
            patch("server.write_merged_settings"),
        ):
            resp = client.put("/settings/mcps", json={})
        assert resp.status_code == 200
        mock_save.assert_called_once_with({})

    def test_put_complex_config(self, tmp_path, monkeypatch):
        monkeypatch.setattr("server.SANDBOX_ROOT", tmp_path / "sandbox")
        config = {
            "my-mcp": {
                "command": "node",
                "args": ["server.js"],
                "env": {"API_KEY": "xxx"},
            }
        }
        with (
            patch("server.save_custom_mcps") as mock_save,
            patch("server.write_merged_settings"),
        ):
            resp = client.put("/settings/mcps", json=config)
        assert resp.status_code == 200
        mock_save.assert_called_once_with(config)


# ---------------------------------------------------------------------------
# File size limits
# ---------------------------------------------------------------------------


class TestFileSizeLimits:
    def test_upload_rejects_too_many_files(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        files = [
            ("files", (f"f{i}.txt", b"x", "text/plain"))
            for i in range(server.MAX_UPLOAD_COUNT + 1)
        ]
        resp = client.post("/sandbox/upload", files=files)
        assert resp.status_code == 413
        assert "Too many files" in resp.json()["detail"]

    def test_upload_accepts_max_count(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        files = [
            ("files", (f"f{i}.txt", b"x", "text/plain"))
            for i in range(server.MAX_UPLOAD_COUNT)
        ]
        resp = client.post("/sandbox/upload", files=files)
        assert resp.status_code == 200

    def test_upload_rejects_oversized_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        big_content = b"x" * (server.MAX_UPLOAD_SIZE + 1)
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("big.bin", big_content, "application/octet-stream")},
            data={"paths": ["big.bin"]},
        )
        assert resp.status_code == 413
        assert "too large" in resp.json()["detail"]

    def test_upload_accepts_max_size_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        monkeypatch.setattr("server.UPLOAD_DIR", sb / "user_data")
        ok_content = b"x" * server.MAX_UPLOAD_SIZE
        resp = client.post(
            "/sandbox/upload",
            files={"files": ("ok.bin", ok_content, "application/octet-stream")},
            data={"paths": ["ok.bin"]},
        )
        assert resp.status_code == 200

    def test_put_rejects_oversized_body(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        big = b"x" * (server.MAX_UPLOAD_SIZE + 1)
        resp = client.put(
            "/sandbox/file",
            params={"path": "big.bin"},
            content=big,
        )
        assert resp.status_code == 413
        assert "too large" in resp.json()["detail"]

    def test_put_accepts_max_size_body(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        ok = b"x" * min(server.MAX_UPLOAD_SIZE, 1024)  # use smaller for test speed
        resp = client.put(
            "/sandbox/file",
            params={"path": "ok.bin"},
            content=ok,
        )
        assert resp.status_code == 200

    def test_raw_rejects_large_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        big = sb / "big.png"
        big.write_bytes(b"x" * 513_000)
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "big.png"})
        assert resp.status_code == 413

    def test_raw_serves_small_file(self, tmp_path, monkeypatch):
        sb = tmp_path / "sandbox"
        sb.mkdir()
        (sb / "small.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        monkeypatch.setattr("server.SANDBOX_ROOT", sb)
        resp = client.get("/sandbox/raw", params={"path": "small.png"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
