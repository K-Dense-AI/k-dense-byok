import json
import logging
import os
from typing import List, Optional

from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import (
    StdioConnectionParams,
    StdioServerParameters,
    StreamableHTTPConnectionParams,
)

from .gemini_settings import build_browser_use_mcp_spec, load_custom_mcps

logger = logging.getLogger(__name__)


class ResilientMcpToolset(BaseToolset):
    """Wraps an McpToolset so that connection failures log a warning
    instead of crashing the agent run."""

    def __init__(self, inner: McpToolset, label: str = "MCP"):
        super().__init__(
            tool_filter=inner.tool_filter,
            tool_name_prefix=inner.tool_name_prefix,
        )
        self._inner = inner
        self._label = label

    async def get_tools(
        self, readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        try:
            return await self._inner.get_tools(readonly_context)
        except Exception as exc:
            logger.warning("%s unavailable, skipping its tools: %s", self._label, exc)
            return []

    async def close(self) -> None:
        try:
            await self._inner.close()
        except Exception:
            pass


def _make_toolset(name: str, spec: dict) -> ResilientMcpToolset | None:
    """Create a ResilientMcpToolset from a custom MCP server spec.

    Supports two formats (matching the Gemini CLI settings schema):
      - HTTP:  ``{"httpUrl": "...", "headers": {...}}``
      - Stdio: ``{"command": "...", "args": [...], "env": {...}}``
    """
    if "httpUrl" in spec:
        params = StreamableHTTPConnectionParams(
            url=spec["httpUrl"],
            headers=spec.get("headers", {}),
            timeout=spec.get("timeout", 120),
        )
    elif "command" in spec:
        params = StdioConnectionParams(
            server_params=StdioServerParameters(
                command=spec["command"],
                args=spec.get("args", []),
                env=spec.get("env"),
            ),
            timeout=float(spec.get("timeout", 120)),
        )
    else:
        logger.warning("Skipping custom MCP %r: no 'command' or 'httpUrl' key", name)
        return None
    return ResilientMcpToolset(McpToolset(connection_params=params), label=name)


class DynamicCustomMcpToolset(BaseToolset):
    """Reads the active project's ``custom_mcps.json`` on every agent turn
    and lazily creates / caches MCP connections for each entry.

    When the config file changes between turns the stale connections are
    torn down and new ones are established automatically — no server
    restart required.
    """

    def __init__(self) -> None:
        super().__init__()
        self._toolsets: dict[str, ResilientMcpToolset] = {}
        self._config_hash: str | None = None

    async def get_tools(
        self, readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        config = load_custom_mcps()
        new_hash = json.dumps(config, sort_keys=True)

        if new_hash != self._config_hash:
            await self._rebuild(config)
            self._config_hash = new_hash

        all_tools: List[BaseTool] = []
        for ts in self._toolsets.values():
            all_tools.extend(await ts.get_tools(readonly_context))
        return all_tools

    async def _rebuild(self, config: dict) -> None:
        for ts in self._toolsets.values():
            await ts.close()
        self._toolsets.clear()

        for name, spec in config.items():
            ts = _make_toolset(name, spec)
            if ts is not None:
                self._toolsets[name] = ts

    async def close(self) -> None:
        for ts in self._toolsets.values():
            await ts.close()
        self._toolsets.clear()


class DynamicBuiltinBrowserUseToolset(BaseToolset):
    """Built-in browser-use MCP that reloads when its per-project config
    changes between turns.

    Mirrors ``DynamicCustomMcpToolset``: reads ``browser_use.json`` on each
    call, tears down and rebuilds the underlying MCP connection only when
    the spec hash changes, and returns an empty tool list when the feature
    is disabled.
    """

    def __init__(self) -> None:
        super().__init__()
        self._toolset: ResilientMcpToolset | None = None
        self._spec_hash: str | None = None

    async def get_tools(
        self, readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        spec = build_browser_use_mcp_spec()
        new_hash = json.dumps(spec, sort_keys=True) if spec is not None else ""

        if new_hash != self._spec_hash:
            await self._rebuild(spec)
            self._spec_hash = new_hash

        if self._toolset is None:
            return []
        return await self._toolset.get_tools(readonly_context)

    async def _rebuild(self, spec: dict | None) -> None:
        if self._toolset is not None:
            await self._toolset.close()
            self._toolset = None
        if spec is None:
            return
        self._toolset = _make_toolset("Browser Use MCP", spec)

    async def close(self) -> None:
        if self._toolset is not None:
            await self._toolset.close()
            self._toolset = None


# ---------------------------------------------------------------------------
# Built-in MCP servers
# ---------------------------------------------------------------------------

all_mcps: list[BaseToolset] = []

if os.getenv("EXA_API_KEY"):
    exa_search_mcp = ResilientMcpToolset(
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url="https://mcp.exa.ai/mcp",
                headers={
                    "x-api-key": os.getenv("EXA_API_KEY"),
                    "x-exa-integration": "k-dense-byok",
                },
                timeout=600,
            ),
        ),
        label="Exa Search MCP",
    )
    all_mcps.append(exa_search_mcp)

if os.getenv("PARALLEL_API_KEY"):
    parallel_search_mcp = ResilientMcpToolset(
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url="https://search-mcp.parallel.ai/mcp",
                headers={"Authorization": f"Bearer {os.getenv('PARALLEL_API_KEY')}"},
                timeout=600,
            ),
        ),
        label="Parallel Search MCP",
    )
    all_mcps.append(parallel_search_mcp)

docling_mcp = ResilientMcpToolset(
    McpToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(
                command="uvx",
                args=["--from=docling-mcp", "docling-mcp-server"],
            ),
            timeout=120.0,
        ),
    ),
    label="Docling MCP",
)
all_mcps.append(docling_mcp)

# Browser automation via the browser-use CLI (loaded dynamically per-request
# so the Settings tab / input-bar chip hot-reload without a server restart).
all_mcps.append(DynamicBuiltinBrowserUseToolset())

# User-configured custom MCP servers (loaded dynamically per-request)
all_mcps.append(DynamicCustomMcpToolset())
