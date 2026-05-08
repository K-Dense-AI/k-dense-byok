"""Correlation tags attached to every LLM request for cost attribution.

Single source of truth for the wire format. Adding a new tag means adding one
member to :class:`TrackingTag` (and one field to :class:`TrackingTags`); no
other module hard-codes header or metadata key strings.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Optional


class TrackingTag(Enum):
    """A correlation tag with its header name, metadata key, and dataclass field."""

    SESSION = ("X-Kady-Session-Id", "kady_session_id", "session_id")
    TURN = ("X-Kady-Turn-Id", "kady_turn_id", "turn_id")
    ROLE = ("X-Kady-Role", "kady_role", "role")
    DELEGATION = ("X-Kady-Delegation-Id", "kady_delegation_id", "delegation_id")
    PROJECT = ("X-Kady-Project", "kady_project", "project_id")

    def __init__(self, header_name: str, metadata_key: str, field_name: str) -> None:
        self.header_name = header_name
        self.metadata_key = metadata_key
        self.field_name = field_name


_REQUIRED_FIELDS = ("session_id", "turn_id", "role")


@dataclass
class TrackingTags:
    """Typed bag of correlation tags. Replaces the legacy ``KadyCostTags`` TypedDict.

    All fields are optional at construction so partial tag sets (e.g. role-only
    before a session id is minted) can be serialized; ``from_headers`` /
    ``from_metadata`` enforce the required triplet on the parse side.
    """

    role: Optional[str] = None
    session_id: Optional[str] = None
    turn_id: Optional[str] = None
    delegation_id: Optional[str] = None
    project_id: Optional[str] = None


def _normalize_headers(headers: Any) -> dict[str, str]:
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


def to_headers(tags: TrackingTags) -> dict[str, str]:
    """Serialize tags as ``X-Kady-*`` HTTP headers. Skips fields whose value is None."""
    out: dict[str, str] = {}
    values = asdict(tags)
    for tag in TrackingTag:
        value = values.get(tag.field_name)
        if value is not None:
            out[tag.header_name] = str(value)
    return out


def to_metadata(tags: TrackingTags) -> dict[str, str]:
    """Serialize tags as LiteLLM metadata. Skips fields whose value is None."""
    out: dict[str, str] = {}
    values = asdict(tags)
    for tag in TrackingTag:
        value = values.get(tag.field_name)
        if value is not None:
            out[tag.metadata_key] = str(value)
    return out


def from_headers(headers: Any) -> Optional[TrackingTags]:
    """Reconstruct tags from an HTTP-style header mapping. Returns None if required fields missing."""
    hmap = _normalize_headers(headers)
    values: dict[str, Optional[str]] = {}
    for tag in TrackingTag:
        values[tag.field_name] = hmap.get(tag.header_name.lower())
    if not all(values.get(name) for name in _REQUIRED_FIELDS):
        return None
    return TrackingTags(**values)  # type: ignore[arg-type]


def from_metadata(metadata: Any) -> Optional[TrackingTags]:
    """Reconstruct tags from a LiteLLM metadata mapping. Returns None if required fields missing."""
    if not isinstance(metadata, dict):
        return None
    values: dict[str, Optional[str]] = {}
    for tag in TrackingTag:
        raw = metadata.get(tag.metadata_key)
        values[tag.field_name] = str(raw) if raw is not None else None
    if not all(values.get(name) for name in _REQUIRED_FIELDS):
        return None
    return TrackingTags(**values)  # type: ignore[arg-type]


def from_litellm_kwargs(kwargs: dict[str, Any]) -> Optional[TrackingTags]:
    """Extract tags from LiteLLM callback kwargs.

    Prefers metadata because provider paths can drop custom headers from
    callback kwargs. Falls back to ``extra_headers`` buckets for older paths.
    """
    lparams = kwargs.get("litellm_params") or {}
    metadata = lparams.get("metadata") if isinstance(lparams, dict) else None
    tags = from_metadata(metadata)
    if tags is not None:
        return tags

    optional = kwargs.get("optional_params") or {}
    headers = optional.get("extra_headers") if isinstance(optional, dict) else None
    if not headers and isinstance(lparams, dict):
        headers = lparams.get("extra_headers")
    return from_headers(headers)


__all__ = [
    "TrackingTag",
    "TrackingTags",
    "to_headers",
    "to_metadata",
    "from_headers",
    "from_metadata",
    "from_litellm_kwargs",
]
