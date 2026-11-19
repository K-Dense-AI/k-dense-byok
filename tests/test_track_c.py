"""Tests for Track C: PWA shell + AG-UI 1.0 endpoint."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

# Allow importing from scratchpad alongside installed packages
sys.path.insert(0, str(Path(__file__).parent))

from pwa_shell import (
    PwaConfig, make_config, generate_service_worker, generate_manifest,
    generate_register_snippet, generate_offline_page, build_pwa_shell,
    PLATFORM_PRESETS,
)
from agui_endpoint import (
    AGUIRunRequest, AGUIMessage, AGUIEventType,
    RunStartedEvent, RunFinishedEvent, TextMessageStartedEvent,
    TextMessageContentEvent, TextMessageEndEvent, RunErrorEvent,
    stream_agui_run,
)


# ---------------------------------------------------------------------------
# PWA shell tests
# ---------------------------------------------------------------------------

class TestPwaConfig:
    def test_make_config_atlas(self):
        cfg = make_config("auctum.atlas")
        assert cfg.platform == "auctum.atlas"
        assert cfg.app_name == "Auctum Atlas"
        assert cfg.theme_color == "#0a1628"
        assert len(cfg.shortcuts) == 2

    def test_make_config_luminaac(self):
        cfg = make_config("luminaac-ultimate")
        assert cfg.platform == "luminaac-ultimate"
        assert cfg.app_name == "LuminAAC Ultimate"
        assert len(cfg.shortcuts) == 1

    def test_all_presets_have_required_fields(self):
        for name in PLATFORM_PRESETS:
            cfg = make_config(name)
            assert cfg.app_name
            assert cfg.theme_color.startswith("#")


class TestServiceWorker:
    def test_sw_contains_cache_version(self):
        cfg = make_config("auctum.atlas")
        sw = generate_service_worker(cfg)
        assert cfg.cache_version in sw

    def test_sw_contains_install_handler(self):
        sw = generate_service_worker(make_config("auctum.atlas"))
        assert 'addEventListener("install"' in sw

    def test_sw_contains_fetch_handler(self):
        sw = generate_service_worker(make_config("auctum.atlas"))
        assert 'addEventListener("fetch"' in sw

    def test_sw_agui_prefix_passthrough(self):
        cfg = make_config("auctum.atlas")
        sw = generate_service_worker(cfg)
        # AG-UI SSE routes must be network-only (no event.respondWith)
        assert "AGUI_PREFIX" in sw

    def test_sw_model_integrity_check(self):
        sw = generate_service_worker(make_config("auctum.atlas"))
        assert "integrity mismatch" in sw

    def test_sw_push_handler(self):
        sw = generate_service_worker(make_config("luminaac-ultimate"))
        assert 'addEventListener("push"' in sw


class TestManifest:
    def test_manifest_is_valid_json(self):
        cfg = make_config("auctum.atlas")
        manifest = json.loads(generate_manifest(cfg))
        assert manifest["name"] == cfg.app_name
        assert manifest["display"] == "standalone"
        assert len(manifest["icons"]) > 0

    def test_manifest_shortcuts(self):
        cfg = make_config("auctum.atlas")
        manifest = json.loads(generate_manifest(cfg))
        assert len(manifest["shortcuts"]) == 2

    def test_manifest_no_shortcuts_for_platform_without(self):
        cfg = make_config("auctum-platform")
        manifest = json.loads(generate_manifest(cfg))
        assert "shortcuts" not in manifest or len(manifest["shortcuts"]) == 0


class TestRegisterSnippet:
    def test_snippet_contains_manifest_link(self):
        snippet = generate_register_snippet(make_config("auctum.atlas"))
        assert 'rel="manifest"' in snippet

    def test_snippet_contains_theme_color(self):
        cfg = make_config("auctum.atlas")
        snippet = generate_register_snippet(cfg)
        assert cfg.theme_color in snippet


class TestBuildPwaShell:
    def test_build_creates_all_files(self, tmp_path):
        paths = build_pwa_shell("auctum.atlas", output_dir=str(tmp_path / "atlas"))
        assert "service-worker.js" in paths
        assert "manifest.webmanifest" in paths
        assert "sw-register.html" in paths
        assert "offline.html" in paths
        assert "pwa-build-meta.json" in paths
        for p in paths.values():
            assert p.exists()

    def test_build_meta_has_sha256(self, tmp_path):
        paths = build_pwa_shell("luminaac-ultimate", output_dir=str(tmp_path / "lum"))
        meta = json.loads(paths["pwa-build-meta.json"].read_text())
        assert "sha256" in meta
        for fname in ["service-worker.js", "manifest.webmanifest"]:
            assert fname in meta["sha256"]
            assert len(meta["sha256"][fname]) == 64  # sha256 hex

    def test_offline_page_uses_theme_color(self, tmp_path):
        paths = build_pwa_shell("auctum.atlas", output_dir=str(tmp_path / "atlas2"))
        offline_html = paths["offline.html"].read_text()
        assert "#0a1628" in offline_html


# ---------------------------------------------------------------------------
# AG-UI endpoint tests
# ---------------------------------------------------------------------------

class TestAGUIEvents:
    def test_run_started_serializes(self):
        ev = RunStartedEvent(run_id="r1", thread_id="t1")
        sse = ev.to_sse()
        assert sse.startswith("data: ")
        data = json.loads(sse.removeprefix("data: ").strip())
        assert data["type"] == AGUIEventType.RUN_STARTED
        assert data["run_id"] == "r1"

    def test_text_content_serializes(self):
        ev = TextMessageContentEvent(message_id="m1", delta="Hello ")
        sse = ev.to_sse()
        data = json.loads(sse.removeprefix("data: ").strip())
        assert data["delta"] == "Hello "
        assert data["type"] == AGUIEventType.TEXT_MESSAGE_CONTENT

    def test_run_error_serializes(self):
        ev = RunErrorEvent(run_id="r2", message="Test error", code="TEST")
        sse = ev.to_sse()
        data = json.loads(sse.removeprefix("data: ").strip())
        assert data["code"] == "TEST"


class TestStreamAGUIRun:
    def _collect(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    async def _gather_events(self, req):
        events = []
        async for chunk in stream_agui_run(req, byok_gateway=None):
            data = json.loads(chunk.removeprefix("data: ").strip())
            events.append(data)
        return events

    def test_full_lifecycle_order(self):
        req = AGUIRunRequest(
            messages=[AGUIMessage(role="user", content="Hi")]
        )
        events = self._collect(self._gather_events(req))
        types = [e["type"] for e in events]
        assert types[0] == AGUIEventType.RUN_STARTED
        assert AGUIEventType.TEXT_MESSAGE_STARTED in types
        assert AGUIEventType.TEXT_MESSAGE_CONTENT in types
        assert AGUIEventType.TEXT_MESSAGE_END in types
        assert types[-1] == AGUIEventType.RUN_FINISHED

    def test_run_finished_has_usage(self):
        req = AGUIRunRequest(messages=[AGUIMessage(role="user", content="test")])
        events = self._collect(self._gather_events(req))
        finished = next(e for e in events if e["type"] == AGUIEventType.RUN_FINISHED)
        assert "usage" in finished
        assert "input_tokens" in finished["usage"]
        assert "cost_usd" in finished["usage"]

    def test_thread_id_propagated(self):
        req = AGUIRunRequest(
            messages=[AGUIMessage(role="user", content="test")],
            thread_id="my-thread-123",
        )
        events = self._collect(self._gather_events(req))
        started = next(e for e in events if e["type"] == AGUIEventType.RUN_STARTED)
        finished = next(e for e in events if e["type"] == AGUIEventType.RUN_FINISHED)
        assert started["thread_id"] == "my-thread-123"
        assert finished["thread_id"] == "my-thread-123"

    def test_text_deltas_concatenate_to_nonempty(self):
        req = AGUIRunRequest(messages=[AGUIMessage(role="user", content="Hello")])
        events = self._collect(self._gather_events(req))
        deltas = "".join(
            e["delta"] for e in events if e["type"] == AGUIEventType.TEXT_MESSAGE_CONTENT
        )
        assert len(deltas) > 0

    def test_model_reported_in_finished(self):
        req = AGUIRunRequest(
            messages=[AGUIMessage(role="user", content="x")],
            model="mastermind_local/nano",
        )
        events = self._collect(self._gather_events(req))
        finished = next(e for e in events if e["type"] == AGUIEventType.RUN_FINISHED)
        assert "mastermind_local" in finished.get("model", "")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
