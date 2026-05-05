from kady_agent.tracking import (
    build_tracking_headers,
    build_tracking_metadata,
    extract_tags_from_headers,
    extract_tags_from_litellm_kwargs,
)


def test_tracking_headers_round_trip_case_insensitive():
    headers = build_tracking_headers(
        role="expert",
        project_id="project-a",
        session_id="session-a",
        turn_id="turn-a",
        delegation_id="002",
    )

    tags = extract_tags_from_headers({key.lower(): value for key, value in headers.items()})

    assert tags == {
        "role": "expert",
        "project_id": "project-a",
        "session_id": "session-a",
        "turn_id": "turn-a",
        "delegation_id": "002",
    }


def test_litellm_kwargs_prefer_metadata_over_headers():
    kwargs = {
        "litellm_params": {
            "metadata": build_tracking_metadata(
                role="orchestrator",
                project_id="project-from-metadata",
                session_id="session-from-metadata",
                turn_id="turn-from-metadata",
            ),
            "extra_headers": build_tracking_headers(
                role="expert",
                project_id="project-from-headers",
                session_id="session-from-headers",
                turn_id="turn-from-headers",
            ),
        }
    }

    tags = extract_tags_from_litellm_kwargs(kwargs)

    assert tags == {
        "role": "orchestrator",
        "project_id": "project-from-metadata",
        "session_id": "session-from-metadata",
        "turn_id": "turn-from-metadata",
        "delegation_id": None,
    }


def test_litellm_kwargs_fall_back_to_optional_extra_headers():
    kwargs = {
        "optional_params": {
            "extra_headers": build_tracking_headers(
                role="expert",
                project_id="project-a",
                session_id="session-a",
                turn_id="turn-a",
                delegation_id="001",
            )
        }
    }

    assert extract_tags_from_litellm_kwargs(kwargs) == {
        "role": "expert",
        "project_id": "project-a",
        "session_id": "session-a",
        "turn_id": "turn-a",
        "delegation_id": "001",
    }


def test_tracking_requires_session_turn_and_role():
    assert extract_tags_from_headers({"X-Kady-Role": "expert"}) is None
