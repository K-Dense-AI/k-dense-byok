"""Unit tests for ``kady_agent/citations.py``.

Focus on pure extraction (no I/O) and the ``verify_entries`` pipeline with
respx-mocked external services. We stay off the real DOI/arXiv/PubMed APIs.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
import respx

from kady_agent import citations


# ---------------------------------------------------------------------------
# extract_citations
# ---------------------------------------------------------------------------


def test_extract_citations_picks_up_doi_arxiv_pubmed_url():
    text = """
    See Smith et al. 2020 doi: 10.1038/nature12373.
    The preprint is arXiv:2101.00001 and the old-style one is arXiv:math.CO/0601001v2.
    PubMed PMID: 123456789.
    More at https://example.com/path?q=1 .
    And the direct https://doi.org/10.1000/xyz link.
    """
    entries = citations.extract_citations(text)
    by_kind = {}
    for e in entries:
        by_kind.setdefault(e.kind, []).append(e.identifier)

    # DOIs are deduped and the one embedded in the URL gets promoted
    assert "10.1038/nature12373" in by_kind["doi"]
    assert "10.1000/xyz" in by_kind["doi"]
    # Old and new arxiv shapes
    assert "2101.00001" in by_kind["arxiv"]
    assert "math.CO/0601001" in by_kind["arxiv"]
    # PubMed
    assert "123456789" in by_kind["pubmed"]
    # Raw URL (non-DOI) is kept as url kind
    assert any(u.startswith("https://example.com") for u in by_kind.get("url", []))


def test_extract_citations_dedupes_repeats():
    text = "doi:10.1000/xyz and again 10.1000/xyz"
    entries = citations.extract_citations(text)
    dois = [e for e in entries if e.kind == "doi"]
    assert len(dois) == 1


def test_extract_citations_empty_string():
    assert citations.extract_citations("") == []


def test_normalize_doi_strips_punctuation():
    assert citations._normalize_doi("10.1000/Xyz;") == "10.1000/xyz"


def test_extract_doi_from_url_handles_dx_prefix():
    assert citations._extract_doi_from_url(
        "http://dx.doi.org/10.1000/abc"
    ) == "10.1000/abc"
    assert citations._extract_doi_from_url("https://example.com/no-doi") is None


# ---------------------------------------------------------------------------
# verify_entries (with respx mocks + cache)
# ---------------------------------------------------------------------------


@pytest.mark.anyio
@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_verify_entries_doi_verified(active_project):
    entry = citations.CitationEntry(
        raw="doi",
        kind="doi",
        identifier="10.1000/testing",
        status="unresolved",
    )
    with respx.mock(assert_all_called=True) as mock:
        mock.get("https://doi.org/api/handles/10.1000/testing").mock(
            return_value=httpx.Response(
                200,
                json={
                    "values": [
                        {"type": "URL", "data": {"value": "https://example.org/paper"}},
                    ]
                },
            )
        )
        await citations.verify_entries([entry])

    assert entry.status == "verified"
    assert entry.url == "https://example.org/paper"
    assert entry.resolvedAt is not None


async def test_verify_entries_doi_404(active_project):
    entry = citations.CitationEntry(
        raw="doi", kind="doi", identifier="10.1000/missing", status="unresolved"
    )
    with respx.mock() as mock:
        mock.get("https://doi.org/api/handles/10.1000/missing").mock(
            return_value=httpx.Response(404, text="not found")
        )
        await citations.verify_entries([entry])

    assert entry.status == "unresolved"
    assert "404" in (entry.error or "")


async def test_verify_entries_arxiv(active_project):
    entry = citations.CitationEntry(
        raw="arXiv:2101.00001",
        kind="arxiv",
        identifier="2101.00001",
        status="unresolved",
    )
    atom = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>On Tests</title>
    <id>http://arxiv.org/abs/2101.00001v1</id>
  </entry>
</feed>"""
    with respx.mock() as mock:
        mock.get("http://export.arxiv.org/api/query").mock(
            return_value=httpx.Response(200, text=atom)
        )
        await citations.verify_entries([entry])

    assert entry.status == "verified"
    assert entry.title == "On Tests"
    assert entry.url == "http://arxiv.org/abs/2101.00001v1"


async def test_verify_entries_pubmed_not_found(active_project):
    entry = citations.CitationEntry(
        raw="PMID: 1", kind="pubmed", identifier="1", status="unresolved"
    )
    with respx.mock() as mock:
        mock.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
        ).mock(
            return_value=httpx.Response(
                200, json={"result": {"1": {"error": "not found"}}}
            )
        )
        await citations.verify_entries([entry])

    assert entry.status == "unresolved"


async def test_verify_entries_url_head_fallback_to_get(active_project):
    entry = citations.CitationEntry(
        raw="https://example.com",
        kind="url",
        identifier="https://example.com",
        status="unresolved",
    )
    with respx.mock() as mock:
        mock.head("https://example.com").mock(return_value=httpx.Response(405))
        mock.get("https://example.com").mock(
            return_value=httpx.Response(200, text="hi")
        )
        await citations.verify_entries([entry])

    assert entry.status == "verified"


async def test_verify_entries_uses_cache_on_second_call(active_project):
    entry = citations.CitationEntry(
        raw="doi", kind="doi", identifier="10.1000/cached", status="unresolved"
    )
    with respx.mock() as mock:
        route = mock.get("https://doi.org/api/handles/10.1000/cached").mock(
            return_value=httpx.Response(
                200,
                json={"values": [{"type": "URL", "data": {"value": "https://ok"}}]},
            )
        )
        await citations.verify_entries([entry])
        assert route.call_count == 1

    # Second resolve must hit the cache (no respx mock needed — absent route
    # would blow up if we tried to hit the network).
    entry2 = citations.CitationEntry(
        raw="doi", kind="doi", identifier="10.1000/cached", status="unresolved"
    )
    await citations.verify_entries([entry2])
    assert entry2.status == "verified"
    assert entry2.url == "https://ok"


async def test_verify_entries_http_error_marks_unresolved(active_project):
    entry = citations.CitationEntry(
        raw="doi", kind="doi", identifier="10.9999/boom", status="unresolved"
    )
    with respx.mock() as mock:
        mock.get("https://doi.org/api/handles/10.9999/boom").mock(
            side_effect=httpx.ConnectError("network down")
        )
        await citations.verify_entries([entry])
    assert entry.status == "unresolved"
    assert "network down" in (entry.error or "")


# ---------------------------------------------------------------------------
# verify_text_and_files
# ---------------------------------------------------------------------------


async def test_verify_text_and_files_skips_files_outside_sandbox(active_project, tmp_path):
    # Create a markdown file inside the sandbox with a DOI and another outside.
    inside = active_project.sandbox / "paper.md"
    inside.write_text("See 10.1000/inside.", encoding="utf-8")
    outside = tmp_path / "outside.md"
    outside.write_text("See 10.1000/outside.", encoding="utf-8")

    with respx.mock() as mock:
        mock.get("https://doi.org/api/handles/10.1000/inside").mock(
            return_value=httpx.Response(200, json={"values": []})
        )
        report = await citations.verify_text_and_files(
            "",
            files=["paper.md", str(outside), "../escape/..", "missing.md"],
        )

    ids = {e.identifier for e in report.entries}
    assert "10.1000/inside" in ids
    assert "10.1000/outside" not in ids


def test_report_to_dict_roundtrip():
    entry = citations.CitationEntry(
        raw="x", kind="doi", identifier="10.1000/x", status="verified", url="u"
    )
    report = citations.CitationReport(total=1, verified=1, unresolved=0, entries=[entry])
    d = citations.report_to_dict(report)
    assert d["total"] == 1
    assert d["entries"][0]["identifier"] == "10.1000/x"
