from __future__ import annotations

import json

import pytest


def test_pdf_annotation_path_safety(active_project: str) -> None:
    from kady_agent.mcp_servers import pdf_annotations

    with pytest.raises(ValueError, match="Path traversal"):
        pdf_annotations._resolve_pdf("../outside.pdf")
    with pytest.raises(ValueError, match="sidecar"):
        pdf_annotations._resolve_pdf("paper.pdf.annotations.json")


def test_add_list_and_remove_pdf_annotations(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import projects
    from kady_agent.mcp_servers import pdf_annotations

    monkeypatch.setenv("KADY_PROJECT_ID", active_project)
    monkeypatch.setenv("KADY_EXPERT_ID", "expert-1")
    monkeypatch.setenv("KADY_EXPERT_LABEL", "Expert One")
    pdf_path = projects.resolve_paths(active_project).sandbox / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\n")

    highlight = pdf_annotations.add_pdf_annotation(
        pdf_path="paper.pdf",
        type="highlight",
        page=1,
        text="important",
        rects=[{"x": 1, "y": 2, "w": 3, "h": 4}],
        note="check this",
    )
    note = pdf_annotations.add_pdf_annotation(
        pdf_path="paper.pdf",
        type="note",
        page=2,
        body="A note",
        anchor={"x": 10, "y": 20},
    )

    assert highlight["author"] == {
        "kind": "expert",
        "id": "expert-1",
        "label": "Expert One",
    }
    assert note["page"] == 2

    listed = pdf_annotations.list_pdf_annotations("paper.pdf")
    assert [ann["id"] for ann in listed["annotations"]] == [highlight["id"], note["id"]]
    assert len(pdf_annotations.list_pdf_annotations("paper.pdf", page=1)["annotations"]) == 1

    assert pdf_annotations.remove_pdf_annotation("paper.pdf", highlight["id"]) == {
        "removed": True,
        "remaining": 1,
    }
    sidecar = pdf_path.with_name("paper.pdf.annotations.json")
    assert json.loads(sidecar.read_text(encoding="utf-8"))["annotations"][0]["id"] == note["id"]


def test_remove_user_annotation_requires_force(
    active_project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kady_agent import projects
    from kady_agent.mcp_servers import pdf_annotations

    monkeypatch.setenv("KADY_PROJECT_ID", active_project)
    pdf_path = projects.resolve_paths(active_project).sandbox / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\n")
    sidecar = pdf_path.with_name("paper.pdf.annotations.json")
    sidecar.write_text(
        json.dumps(
            {
                "version": 1,
                "annotations": [
                    {
                        "id": "user-ann",
                        "type": "note",
                        "page": 1,
                        "author": {"kind": "user", "id": "user", "label": "User"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    assert pdf_annotations.remove_pdf_annotation("paper.pdf", "user-ann") == {
        "removed": False,
        "remaining": 1,
    }
    assert pdf_annotations.remove_pdf_annotation("paper.pdf", "user-ann", force=True) == {
        "removed": True,
        "remaining": 0,
    }


def test_invalid_annotation_inputs(active_project: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from kady_agent import projects
    from kady_agent.mcp_servers import pdf_annotations

    monkeypatch.setenv("KADY_PROJECT_ID", active_project)
    (projects.resolve_paths(active_project).sandbox / "paper.pdf").write_bytes(b"%PDF")
    with pytest.raises(ValueError, match="page"):
        pdf_annotations.add_pdf_annotation("paper.pdf", "note", 0, anchor={"x": 1, "y": 2})
    with pytest.raises(ValueError, match="rects"):
        pdf_annotations.add_pdf_annotation("paper.pdf", "highlight", 1)
    with pytest.raises(ValueError, match="anchor"):
        pdf_annotations.add_pdf_annotation("paper.pdf", "note", 1)
