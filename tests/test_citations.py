from __future__ import annotations

import time

import httpx


def test_extract_citations_deduplicates_and_classifies() -> None:
    from kady_agent import citations

    entries = citations.extract_citations(
        "DOI 10.1000/XYZ. See https://doi.org/10.1000/xyz, "
        "arXiv:2401.12345v2, PMID: 123456, and https://example.org/paper."
    )

    assert [(entry.kind, entry.identifier) for entry in entries] == [
        ("doi", "10.1000/xyz"),
        ("arxiv", "2401.12345"),
        ("pubmed", "123456"),
        ("url", "https://example.org/paper"),
    ]


async def test_verify_entries_uses_cache(active_project: str) -> None:
    from kady_agent import citations

    entry = citations.CitationEntry(
        raw="10.1000/xyz",
        kind="doi",
        identifier="10.1000/xyz",
        status="unresolved",
    )
    cache = {
        "doi:10.1000/xyz": {
            "status": "verified",
            "title": "Cached",
            "url": "https://doi.org/10.1000/xyz",
            "resolvedAt": time.time(),
        }
    }
    citations._save_cache(cache)

    verified = await citations.verify_entries([entry])
    assert verified[0].status == "verified"
    assert verified[0].title == "Cached"


async def test_resolvers_handle_success_and_errors() -> None:
    from kady_agent import citations

    class FakeClient:
        async def get(self, url, **kwargs):
            if "doi.org" in str(url):
                return httpx.Response(
                    200,
                    json={"values": [{"type": "URL", "data": {"value": "https://publisher.test"}}]},
                )
            if "arxiv" in str(url):
                return httpx.Response(
                    200,
                    text=(
                        '<feed xmlns="http://www.w3.org/2005/Atom">'
                        "<entry><title> A  Paper </title><id>http://arxiv.org/abs/2401.1</id></entry>"
                        "</feed>"
                    ),
                )
            if "eutils" in str(url):
                return httpx.Response(
                    200,
                    json={"result": {"123456": {"title": "PubMed title"}}},
                )
            return httpx.Response(500)

        async def head(self, url, **kwargs):
            return httpx.Response(405, request=httpx.Request("HEAD", url))

    doi = citations.CitationEntry("10.1000/xyz", "doi", "10.1000/xyz", "unresolved")
    arxiv = citations.CitationEntry("arXiv:2401.1", "arxiv", "2401.1", "unresolved")
    pubmed = citations.CitationEntry("PMID:123456", "pubmed", "123456", "unresolved")
    url = citations.CitationEntry("https://bad.test", "url", "https://bad.test", "unresolved")

    client = FakeClient()
    await citations._resolve_doi(client, doi)
    await citations._resolve_arxiv(client, arxiv)
    await citations._resolve_pubmed(client, pubmed)
    await citations._resolve_url(client, url)

    assert doi.status == "verified"
    assert doi.url == "https://publisher.test"
    assert arxiv.title == "A Paper"
    assert pubmed.url == "https://pubmed.ncbi.nlm.nih.gov/123456/"
    assert url.status == "unresolved"
    assert url.error == "HTTP 500"


async def test_verify_text_and_files_scans_safe_text_files(
    active_project: str, monkeypatch
) -> None:
    from kady_agent import citations, projects

    paths = projects.resolve_paths(active_project)
    (paths.sandbox / "refs.md").write_text("PMID: 123456", encoding="utf-8")
    (paths.sandbox / "binary.pdf").write_bytes(b"PMID: 999999")

    async def fake_verify(entries):
        for entry in entries:
            entry.status = "verified"
        return entries

    monkeypatch.setattr(citations, "verify_entries", fake_verify)
    report = await citations.verify_text_and_files(
        "arXiv:2401.12345", ["refs.md", "../escape.md", "binary.pdf"]
    )

    assert report.total == 2
    assert report.verified == 2
    assert citations.report_to_dict(report)["entries"][0]["kind"] == "arxiv"
