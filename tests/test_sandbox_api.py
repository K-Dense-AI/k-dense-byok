from __future__ import annotations

import io
import zipfile

import pytest


pytestmark = pytest.mark.integration


def test_sandbox_file_tree_upload_move_and_download(
    client, project_headers: dict[str, str]
) -> None:
    upload = client.post(
        "/sandbox/upload",
        headers=project_headers,
        files=[("files", ("hello.txt", b"hello", "text/plain"))],
        data={"paths": "nested/hello.txt"},
    )
    assert upload.status_code == 200
    assert upload.json()["uploaded"] == ["user_data/nested/hello.txt"]

    tree = client.get("/sandbox/tree", headers=project_headers)
    assert tree.status_code == 200
    assert tree.json()["type"] == "directory"

    save = client.put(
        "/sandbox/file?path=notes/a.txt",
        headers=project_headers,
        content=b"alpha",
    )
    assert save.status_code == 200
    assert save.json()["size"] == 5

    read = client.get("/sandbox/file?path=notes/a.txt", headers=project_headers)
    assert read.status_code == 200
    assert read.text == "alpha"

    mkdir = client.post("/sandbox/mkdir", headers=project_headers, json={"path": "moved"})
    assert mkdir.status_code == 200

    moved = client.post(
        "/sandbox/move",
        headers=project_headers,
        json={"src": "notes/a.txt", "dest": "moved/b.txt"},
    )
    assert moved.status_code == 200

    raw = client.get("/sandbox/raw?path=moved/b.txt", headers=project_headers)
    assert raw.status_code == 200
    assert raw.content == b"alpha"

    download = client.get("/sandbox/download-all", headers=project_headers)
    assert download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
        assert "moved/b.txt" in archive.namelist()
        assert "user_data/nested/hello.txt" in archive.namelist()


def test_sandbox_rejects_traversal(client, project_headers: dict[str, str]) -> None:
    assert client.get("/sandbox/file?path=../secret", headers=project_headers).status_code == 403
    assert client.put("/sandbox/file?path=../secret", headers=project_headers, content=b"x").status_code == 403


def test_sandbox_annotations_api(client, project_headers: dict[str, str]) -> None:
    client.put("/sandbox/file?path=paper.pdf", headers=project_headers, content=b"%PDF")

    empty = client.get("/sandbox/annotations?path=paper.pdf", headers=project_headers)
    assert empty.status_code == 200
    assert empty.json() == {"version": 1, "annotations": []}

    doc = {
        "annotations": [
            {
                "id": "ann-1",
                "type": "note",
                "page": 1,
                "author": {"kind": "user", "id": "u", "label": "User"},
                "anchor": {"x": 1, "y": 2},
                "body": "note",
            }
        ]
    }
    saved = client.put("/sandbox/annotations?path=paper.pdf", headers=project_headers, json=doc)
    assert saved.status_code == 200
    assert saved.json() == {"saved": "paper.pdf", "count": 1}

    listed = client.get("/sandbox/annotations?path=paper.pdf", headers=project_headers)
    assert listed.json()["annotations"][0]["id"] == "ann-1"
    assert "last-modified" in listed.headers

    bad = client.put(
        "/sandbox/annotations?path=paper.pdf.annotations.json",
        headers=project_headers,
        json=doc,
    )
    assert bad.status_code == 400


def test_sandbox_latex_validation_and_missing_compiler(client, project_headers: dict[str, str]) -> None:
    client.put("/sandbox/file?path=doc.txt", headers=project_headers, content=b"text")
    assert (
        client.get("/sandbox/anndata-summary?path=doc.txt", headers=project_headers).status_code
        == 400
    )

    client.put("/sandbox/file?path=paper.tex", headers=project_headers, content=b"\\bad")
    response = client.post(
        "/sandbox/compile-latex",
        headers=project_headers,
        json={"path": "paper.tex", "engine": "not-tex"},
    )
    assert response.status_code == 400
