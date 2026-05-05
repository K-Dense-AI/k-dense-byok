"""Shared Kady request tracking tags.

The orchestrator process and the LiteLLM proxy process both need to agree on
the same correlation fields. Keeping the names and extraction rules here makes
that cross-process contract explicit.
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict

HEADER_SESSION = "X-Kady-Session-Id"
HEADER_TURN = "X-Kady-Turn-Id"
HEADER_ROLE = "X-Kady-Role"
HEADER_DELEGATION = "X-Kady-Delegation-Id"
HEADER_PROJECT = "X-Kady-Project"

METADATA_SESSION = "kady_session_id"
METADATA_TURN = "kady_turn_id"
METADATA_ROLE = "kady_role"
METADATA_DELEGATION = "kady_delegation_id"
METADATA_PROJECT = "kady_project"


class KadyCostTags(TypedDict):
    session_id: str
    turn_id: str
    role: str
    delegation_id: Optional[str]
    project_id: Optional[str]


def normalize_headers(headers: Any) -> dict[str, str]:
    """Return a lower-cased ``{name: value}`` view of arbitrary header shapes."""
    if not headers:
        return {}
    if isinstance(headers, dict):
        return {str(k).lower(): str(v) for k, v in headers.items() if v is not None}
    try:
        return {
            str(k).lower(): str(v)
            for k, v in headers.items()  # type: ignore[attr-defined]
            if v is not None
        }
    except AttributeError:
        return {}


def extract_tags_from_headers(headers: Any) -> KadyCostTags | None:
    """Pull Kady correlation tags from an HTTP-style header mapping."""
    hmap = normalize_headers(headers)
    session_id = hmap.get(HEADER_SESSION.lower())
    turn_id = hmap.get(HEADER_TURN.lower())
    role = hmap.get(HEADER_ROLE.lower())
    if not (session_id and turn_id and role):
        return None
    return {
        "session_id": session_id,
        "turn_id": turn_id,
        "role": role,
        "delegation_id": hmap.get(HEADER_DELEGATION.lower()),
        "project_id": hmap.get(HEADER_PROJECT.lower()),
    }


def extract_tags_from_metadata(metadata: Any) -> KadyCostTags | None:
    """Pull Kady correlation tags from LiteLLM metadata."""
    if not isinstance(metadata, dict):
        return None
    session_id = metadata.get(METADATA_SESSION)
    turn_id = metadata.get(METADATA_TURN)
    role = metadata.get(METADATA_ROLE)
    if not (session_id and turn_id and role):
        return None
    return {
        "session_id": str(session_id),
        "turn_id": str(turn_id),
        "role": str(role),
        "delegation_id": (
            str(metadata[METADATA_DELEGATION])
            if metadata.get(METADATA_DELEGATION) is not None
            else None
        ),
        "project_id": (
            str(metadata[METADATA_PROJECT])
            if metadata.get(METADATA_PROJECT) is not None
            else None
        ),
    }


def extract_tags_from_litellm_kwargs(kwargs: dict[str, Any]) -> KadyCostTags | None:
    """Extract tags from LiteLLM callback kwargs.

    Prefer metadata because provider paths can drop custom headers from callback
    kwargs. Fall back to the known extra_headers buckets for older paths.
    """
    lparams = kwargs.get("litellm_params") or {}
    metadata = lparams.get("metadata") if isinstance(lparams, dict) else None
    tags = extract_tags_from_metadata(metadata)
    if tags is not None:
        return tags

    optional = kwargs.get("optional_params") or {}
    headers = optional.get("extra_headers") if isinstance(optional, dict) else None
    if not headers and isinstance(lparams, dict):
        headers = lparams.get("extra_headers")
    return extract_tags_from_headers(headers)


def build_tracking_headers(
    *,
    role: str,
    project_id: str | None,
    session_id: str | None = None,
    turn_id: str | None = None,
    delegation_id: str | None = None,
) -> dict[str, str]:
    """Build canonical ``X-Kady-*`` headers for LLM requests."""
    headers = {HEADER_ROLE: role}
    if project_id:
        headers[HEADER_PROJECT] = project_id
    if session_id:
        headers[HEADER_SESSION] = session_id
    if turn_id:
        headers[HEADER_TURN] = turn_id
    if delegation_id:
        headers[HEADER_DELEGATION] = delegation_id
    return headers


def build_tracking_metadata(
    *,
    role: str,
    project_id: str | None,
    session_id: str | None = None,
    turn_id: str | None = None,
    delegation_id: str | None = None,
) -> dict[str, str]:
    """Build canonical LiteLLM metadata for Kady tracking tags."""
    metadata = {METADATA_ROLE: role}
    if project_id:
        metadata[METADATA_PROJECT] = project_id
    if session_id:
        metadata[METADATA_SESSION] = session_id
    if turn_id:
        metadata[METADATA_TURN] = turn_id
    if delegation_id:
        metadata[METADATA_DELEGATION] = delegation_id
    return metadata
