"""Citation extraction and deterministic post-pass verification.

Scans text (and optional text files) for DOIs, arXiv IDs, PubMed IDs and bare
URLs, then resolves each against its canonical authority:

- DOI:   https://doi.org/api/handles/{doi}
- arXiv: http://export.arxiv.org/api/query?id_list={id}
- PubMed: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi
- URL:   HTTP HEAD (then GET fallback) with a short timeout

Results are cached on disk under sandbox/.kady/citation-cache.json with a
30-day TTL, keyed by normalised identifier. The resolver is intentionally
dependency-light: it only uses httpx (already present via FastAPI).
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Optional
from urllib.parse import urlparse

import httpx

from .projects import active_paths

REPO_ROOT = Path(__file__).resolve().parents[1]
CACHE_TTL_SECONDS = 30 * 24 * 3600


_DOI_RE = re.compile(r"\b10\.\d{4,9}/[^\s\"<>)\]}]+", re.IGNORECASE)
_ARXIV_NEW_RE = re.compile(r"arXiv:(\d{4}\.\d{4,5})(v\d+)?", re.IGNORECASE)
_ARXIV_OLD_RE = re.compile(r"arXiv:([a-z-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", re.IGNORECASE)
_PMID_RE = re.compile(r"PMID[:\s]*\s*(\d{5,9})", re.IGNORECASE)
_URL_RE = re.compile(r"https?://[^\s\"<>)\]}]+")

Status = Literal["verified", "unresolved", "skipped"]
Kind = Literal["doi", "arxiv", "pubmed", "url"]

_DOMAIN_SEMAPHORES: dict[str, asyncio.Semaphore] = {}
_DOMAIN_CONCURRENCY = 2


@dataclass
class CitationEntry:
    raw: str
    kind: Kind
    identifier: str
    status: Status
    title: Optional[str] = None
    url: Optional[str] = None
    resolvedAt: Optional[float] = None
    error: Optional[str] = None


@dataclass
class CitationReport:
    total: int
    verified: int
    unresolved: int
    entries: list[CitationEntry] = field(default_factory=list)


def _normalize_doi(doi: str) -> str:
    return doi.rstrip(".,;").lower()


def _normalize_url(url: str) -> str:
    return url.rstrip(".,;")


def _extract_doi_from_url(url: str) -> Optional[str]:
    """Pull a DOI out of a doi.org / dx.doi.org URL, if present."""
    match = re.search(r"https?://(?:dx\.)?doi\.org/(10\.\d{4,9}/[^\s\"<>)\]}]+)", url, re.IGNORECASE)
    if match:
        return _normalize_doi(match.group(1))
    return None


def extract_citations(text: str) -> list[CitationEntry]:
    """Return de-duplicated citation entries found in text, preserving order.

    Each raw match is normalized and classified. DOIs discovered inside URLs
    (for example, https://doi.org/10.1000/xyz) are promoted to real DOI kinds
    so the resolver targets doi.org directly.
    """
    found: dict[tuple[Kind, str], CitationEntry] = {}

    def _add(kind: Kind, identifier: str, raw: str) -> None:
        key = (kind, identifier)
        if key not in found:
            found[key] = CitationEntry(
                raw=raw, kind=kind, identifier=identifier, status="unresolved"
            )

    for match in _DOI_RE.finditer(text):
        doi = _normalize_doi(match.group(0))
        _add("doi", doi, match.group(0))

    for match in _ARXIV_NEW_RE.finditer(text):
        _add("arxiv", match.group(1), match.group(0))
    for match in _ARXIV_OLD_RE.finditer(text):
        _add("arxiv", match.group(1), match.group(0))

    for match in _PMID_RE.finditer(text):
        _add("pubmed", match.group(1), match.group(0))

    for match in _URL_RE.finditer(text):
        url = _normalize_url(match.group(0))
        embedded = _extract_doi_from_url(url)
        if embedded:
            _add("doi", embedded, url)
        else:
            parsed = urlparse(url)
            if parsed.netloc:
                _add("url", url, url)

    return list(found.values())


def _cache_key(entry: CitationEntry) -> str:
    return f"{entry.kind}:{entry.identifier.lower()}"


def _from_cache(entry: CitationEntry, cache: dict[str, dict]) -> bool:
    cached = cache.get(_cache_key(entry))
    if not cached:
        return False
    if time.time() - cached.get("resolvedAt", 0) > CACHE_TTL_SECONDS:
        return False
    for k in ("status", "title", "url", "resolvedAt", "error"):
        if k in cached:
            setattr(entry, k, cached[k])
    return True


def _to_cache(entry: CitationEntry, cache: dict[str, dict]) -> None:
    cache[_cache_key(entry)] = {
        "status": entry.status,
        "title": entry.title,
        "url": entry.url,
        "resolvedAt": entry.resolvedAt,
        "error": entry.error,
    }


def _domain_semaphore(host: str) -> asyncio.Semaphore:
    sem = _DOMAIN_SEMAPHORES.get(host)
    if sem is None:
        sem = asyncio.Semaphore(_DOMAIN_CONCURRENCY)
        _DOMAIN_SEMAPHORES[host] = sem
    return sem


async def _resolve_doi(client: httpx.AsyncClient, entry: CitationEntry) -> None:
    async with _domain_semaphore("doi.org"):
        try:
            resp = await client.get(
                f"https://doi.org/api/handles/{entry.identifier}",
                timeout=8.0,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            entry.status = "unresolved"
            entry.error = str(exc)
            return
    if resp.status_code == 200:
        entry.status = "verified"
        entry.url = f"https://doi.org/{entry.identifier}"
        try:
            payload = resp.json()
            for val in payload.get("values", []):
                if val.get("type") == "URL" and isinstance(val.get("data"), dict):
                    entry.url = val["data"].get("value", entry.url)
                    break
        except ValueError:
            pass
    else:
        entry.status = "unresolved"
        entry.error = f"HTTP {resp.status_code}"


async def _resolve_arxiv(client: httpx.AsyncClient, entry: CitationEntry) -> None:
    async with _domain_semaphore("arxiv.org"):
        try:
            resp = await client.get(
                "http://export.arxiv.org/api/query",
                params={"id_list": entry.identifier, "max_results": 1},
                timeout=10.0,
                follow_redirects=True,
            )
        except httpx.HTTPError as exc:
            entry.status = "unresolved"
            entry.error = str(exc)
            return
    if resp.status_code != 200:
        entry.status = "unresolved"
        entry.error = f"HTTP {resp.status_code}"
        return
    try:
        root = ET.fromstring(resp.text)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        entries = root.findall("atom:entry", ns)
        if not entries:
            entry.status = "unresolved"
            entry.error = "no entries"
            return
        title_el = entries[0].find("atom:title", ns)
        id_el = entries[0].find("atom:id", ns)
        entry.status = "verified"
        if title_el is not None and title_el.text:
            entry.title = " ".join(title_el.text.split())
        if id_el is not None and id_el.text:
            entry.url = id_el.text.strip()
    except ET.ParseError as exc:
        entry.status = "unresolved"
        entry.error = f"parse error: {exc}"


async def _resolve_pubmed(client: httpx.AsyncClient, entry: CitationEntry) -> None:
    api_key = os.getenv("NCBI_API_KEY", "").strip()
    params = {"db": "pubmed", "id": entry.identifier, "retmode": "json"}
    if api_key:
        params["api_key"] = api_key
    async with _domain_semaphore("eutils.ncbi.nlm.nih.gov"):
        try:
            resp = await client.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
                params=params,
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            entry.status = "unresolved"
            entry.error = str(exc)
            return
    if resp.status_code != 200:
        entry.status = "unresolved"
        entry.error = f"HTTP {resp.status_code}"
        return
    try:
        data = resp.json()
        result = data.get("result", {})
        record = result.get(entry.identifier)
        if not isinstance(record, dict) or record.get("error"):
            entry.status = "unresolved"
            entry.error = "not found"
            return
        entry.status = "verified"
        entry.title = record.get("title")
        entry.url = f"https://pubmed.ncbi.nlm.nih.gov/{entry.identifier}/"
    except ValueError as exc:
        entry.status = "unresolved"
        entry.error = f"parse error: {exc}"


async def _resolve_url(client: httpx.AsyncClient, entry: CitationEntry) -> None:
    host = urlparse(entry.identifier).netloc or "unknown"
    async with _domain_semaphore(host):
        try:
            resp = await client.head(
                entry.identifier,
                timeout=6.0,
                follow_redirects=True,
            )
            if resp.status_code == 405 or resp.status_code >= 400:
                resp = await client.get(
                    entry.identifier,
                    timeout=8.0,
                    follow_redirects=True,
                )
        except httpx.HTTPError as exc:
            entry.status = "unresolved"
            entry.error = str(exc)
            return
    if 200 <= resp.status_code < 400:
        entry.status = "verified"
        entry.url = str(resp.url)
    else:
        entry.status = "unresolved"
        entry.error = f"HTTP {resp.status_code}"


_RESOLVERS = {
    "doi": _resolve_doi,
    "arxiv": _resolve_arxiv,
    "pubmed": _resolve_pubmed,
    "url": _resolve_url,
}


async def verify_entries(entries: list[CitationEntry]) -> list[CitationEntry]:
    """Resolve each entry against its authority, using the on-disk cache."""
    if not entries:
        return entries

    paths = active_paths()
    cache = paths.load_citation_cache()
    to_resolve: list[CitationEntry] = []
    for entry in entries:
        if _from_cache(entry, cache):
            continue
        to_resolve.append(entry)

    if to_resolve:
        headers = {
            "User-Agent": "Kady-CitationVerifier/0.1 (+https://www.k-dense.ai)",
            "Accept": "application/json, text/xml, */*",
        }
        async with httpx.AsyncClient(headers=headers) as client:
            async def _run(entry: CitationEntry) -> None:
                resolver = _RESOLVERS.get(entry.kind)
                if not resolver:
                    entry.status = "skipped"
                    return
                try:
                    await resolver(client, entry)
                finally:
                    entry.resolvedAt = time.time()
                    _to_cache(entry, cache)

            await asyncio.gather(*(_run(e) for e in to_resolve))
        paths.save_citation_cache(cache)

    return entries


def _read_text_file(path: Path, max_bytes: int = 1_500_000) -> str:
    try:
        if not path.is_file() or path.stat().st_size > max_bytes:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


SCANNABLE_EXTENSIONS = {".md", ".txt", ".tex", ".rst", ".html", ".bib", ".markdown"}


async def verify_text_and_files(
    text: str, files: Iterable[str] = ()
) -> CitationReport:
    """Extract citations from text + listed sandbox files, then resolve all.

    Files are resolved relative to the active project's sandbox and must
    stay inside it; any path traversal is silently skipped. Files outside
    SCANNABLE_EXTENSIONS are ignored so we don't try to parse binary
    deliverables for citations.
    """
    combined = text or ""
    sandbox_root = active_paths().sandbox

    for rel in files:
        if not rel:
            continue
        resolved = (sandbox_root / rel).resolve()
        try:
            resolved.relative_to(sandbox_root)
        except ValueError:
            continue
        if resolved.suffix.lower() not in SCANNABLE_EXTENSIONS:
            continue
        chunk = _read_text_file(resolved)
        if chunk:
            combined += f"\n\n{chunk}"

    entries = extract_citations(combined)
    entries = await verify_entries(entries)

    verified = sum(1 for e in entries if e.status == "verified")
    unresolved = sum(1 for e in entries if e.status == "unresolved")
    return CitationReport(
        total=len(entries),
        verified=verified,
        unresolved=unresolved,
        entries=entries,
    )


def report_to_dict(report: CitationReport) -> dict:
    return {
        "total": report.total,
        "verified": report.verified,
        "unresolved": report.unresolved,
        "entries": [asdict(e) for e in report.entries],
    }
