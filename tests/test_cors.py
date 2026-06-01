"""CORS must allow the Next.js dev server on ports other than 3000."""

from __future__ import annotations


def test_skills_preflight_allows_alternate_localhost_port(client) -> None:
    response = client.options(
        "/skills",
        headers={
            "Origin": "http://localhost:3001",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-project-id",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3001"


def test_skills_get_includes_cors_header_for_alternate_port(client) -> None:
    response = client.get(
        "/skills",
        headers={"Origin": "http://localhost:3001", "X-Project-Id": "default"},
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3001"
