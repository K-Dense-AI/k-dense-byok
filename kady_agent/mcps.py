import os

from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import (
    StdioConnectionParams,
    StdioServerParameters,
    StreamableHTTPConnectionParams,
)

from .win_compat import enabled as windows_compat_enabled

all_mcps = []

if os.getenv("PARALLEL_API_KEY"):
    parallel_search_mcp = McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url="https://search-mcp.parallel.ai/mcp",
            headers={"Authorization": f"Bearer {os.getenv('PARALLEL_API_KEY')}"},
            timeout=600,
        ),
    )
    all_mcps.append(parallel_search_mcp)


def _skip_docling_mcp() -> bool:
    if os.getenv("SKIP_DOCLING_MCP", "").strip().lower() in ("1", "true", "yes"):
        return True
    # Docling stdio via uvx is flaky on Windows; opt-in compat mode skips it there.
    return windows_compat_enabled()


if not _skip_docling_mcp():
    docling_mcp = McpToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(
                command="uvx",
                args=["--from=docling-mcp", "docling-mcp-server"],
            ),
            timeout=120.0,
        ),
    )
    all_mcps.append(docling_mcp)
