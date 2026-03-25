"""Windows-only compatibility toggle (opt-in).

Set ``KADY_WINDOWS_COMPAT=1`` (or ``true`` / ``yes``) in ``kady_agent/.env`` on
Windows to enable workarounds for Gemini CLI subprocesses and to skip the
Docling stdio MCP (often unreliable on Windows). Default is off so Linux/macOS
behavior stays unchanged.
"""

from __future__ import annotations

import os
import sys


def enabled() -> bool:
    if sys.platform != "win32":
        return False
    v = os.getenv("KADY_WINDOWS_COMPAT", "").strip().lower()
    return v in ("1", "true", "yes")
