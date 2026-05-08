"""Round-trip and parsing tests for the kady_agent.tracking module."""

from __future__ import annotations

import pytest

from kady_agent.tracking import (
    TrackingTag,
    TrackingTags,
    from_headers,
    from_litellm_kwargs,
    from_metadata,
    to_headers,
    to_metadata,
)


def _full_tags() -> TrackingTags:
    return TrackingTags(
        role="orchestrator",
        session_id="sess-1",
        turn_id="turn-1",
        delegation_id="deleg-1",
        project_id="proj-1",
    )


@pytest.mark.parametrize("tag", list(TrackingTag))
def test_each_tag_round_trips_through_headers(tag: TrackingTag) -> None:
    """For every TrackingTag, setting that field round-trips header → extract → header."""

    base = _full_tags()
    headers = to_headers(base)
    assert tag.header_name in headers
    parsed = from_headers(headers)
    assert parsed == base
    assert getattr(parsed, tag.field_name) == getattr(base, tag.field_name)


@pytest.mark.parametrize("tag", list(TrackingTag))
def test_each_tag_round_trips_through_metadata(tag: TrackingTag) -> None:
    """For every TrackingTag, setting that field round-trips metadata → extract → metadata."""

    base = _full_tags()
    metadata = to_metadata(base)
    assert tag.metadata_key in metadata
    parsed = from_metadata(metadata)
    assert parsed == base
    assert getattr(parsed, tag.field_name) == getattr(base, tag.field_name)


def test_to_headers_skips_none_fields() -> None:
    tags = TrackingTags(role="expert", session_id="s", turn_id="t")
    headers = to_headers(tags)
    assert headers == {
        TrackingTag.ROLE.header_name: "expert",
        TrackingTag.SESSION.header_name: "s",
        TrackingTag.TURN.header_name: "t",
    }


def test_to_metadata_skips_none_fields() -> None:
    tags = TrackingTags(role="expert", session_id="s", turn_id="t")
    metadata = to_metadata(tags)
    assert metadata == {
        TrackingTag.ROLE.metadata_key: "expert",
        TrackingTag.SESSION.metadata_key: "s",
        TrackingTag.TURN.metadata_key: "t",
    }


def test_from_headers_returns_none_when_required_missing() -> None:
    # Missing role
    assert from_headers({TrackingTag.SESSION.header_name: "s", TrackingTag.TURN.header_name: "t"}) is None
    # Missing session_id
    assert from_headers({TrackingTag.ROLE.header_name: "r", TrackingTag.TURN.header_name: "t"}) is None
    # Missing turn_id
    assert from_headers({TrackingTag.ROLE.header_name: "r", TrackingTag.SESSION.header_name: "s"}) is None
    # All None / empty
    assert from_headers({}) is None
    assert from_headers(None) is None


def test_from_metadata_returns_none_when_required_missing() -> None:
    assert from_metadata({TrackingTag.SESSION.metadata_key: "s", TrackingTag.TURN.metadata_key: "t"}) is None
    assert from_metadata({}) is None
    assert from_metadata(None) is None
    assert from_metadata("not a dict") is None  # type: ignore[arg-type]


def test_from_headers_lowercases_header_names() -> None:
    """Headers may arrive lower-cased (e.g. from ASGI). Extraction must be case-insensitive."""

    headers = {
        TrackingTag.ROLE.header_name.lower(): "expert",
        TrackingTag.SESSION.header_name.lower(): "s",
        TrackingTag.TURN.header_name.lower(): "t",
    }
    parsed = from_headers(headers)
    assert parsed is not None
    assert parsed.role == "expert"
    assert parsed.session_id == "s"


def test_from_litellm_kwargs_prefers_metadata() -> None:
    metadata_tags = TrackingTags(role="orchestrator", session_id="meta-s", turn_id="meta-t", project_id="meta-p")
    header_tags = TrackingTags(role="expert", session_id="hdr-s", turn_id="hdr-t", project_id="hdr-p")
    kwargs = {
        "litellm_params": {
            "metadata": to_metadata(metadata_tags),
            "extra_headers": to_headers(header_tags),
        }
    }
    parsed = from_litellm_kwargs(kwargs)
    assert parsed is not None
    assert parsed.project_id == "meta-p"
    assert parsed.role == "orchestrator"


def test_from_litellm_kwargs_falls_back_to_optional_extra_headers() -> None:
    tags = TrackingTags(role="expert", session_id="s", turn_id="t")
    kwargs = {"optional_params": {"extra_headers": to_headers(tags)}}
    parsed = from_litellm_kwargs(kwargs)
    assert parsed is not None
    assert parsed.role == "expert"


def test_from_litellm_kwargs_falls_back_to_litellm_params_extra_headers() -> None:
    tags = TrackingTags(role="expert", session_id="s", turn_id="t")
    kwargs = {"litellm_params": {"extra_headers": to_headers(tags)}}
    parsed = from_litellm_kwargs(kwargs)
    assert parsed is not None
    assert parsed.role == "expert"


def test_from_litellm_kwargs_returns_none_when_nothing_present() -> None:
    assert from_litellm_kwargs({}) is None
    assert from_litellm_kwargs({"litellm_params": {}, "optional_params": {}}) is None


def test_tag_enum_field_name_matches_dataclass_fields() -> None:
    """Adding a TrackingTag without a matching TrackingTags field would silently lose data."""

    from dataclasses import fields

    dataclass_fields = {f.name for f in fields(TrackingTags)}
    enum_fields = {tag.field_name for tag in TrackingTag}
    assert enum_fields.issubset(dataclass_fields), (
        f"TrackingTag field_names {enum_fields - dataclass_fields} are not on TrackingTags"
    )
