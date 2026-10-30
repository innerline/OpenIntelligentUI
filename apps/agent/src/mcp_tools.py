"""Server-side MCP tool loading for the cockpit agent (open-mcp-client lane).

MCP servers are configured in a JSON file beside the agent (never in the
browser — this cockpit is owner-only; server-side config keeps every
token off client machines). Each entry names a transport and, for HTTP
transports, an ENV VARIABLE that holds the bearer token at call time
(the same seam the service itself uses: buzz-mcp reads BUZZ_MCP_TOKEN
from its launchd plist). Token VALUES never live in this file or repo.

Config file path: MCP_SERVERS_CONFIG (default: mcp-servers.json next to
main.py). Missing file = no MCP tools (the agent still boots). A server
that is unreachable at startup is skipped with a warning — the cockpit's
built-in tools must never be hostage to an MCP server being down; the
tools are simply absent until the next process start.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "mcp-servers.json"
SUPPORTED_TRANSPORTS = {"streamable_http"}


class McpConfigError(ValueError):
    """The MCP servers config file is malformed or names an unusable env."""


def load_mcp_server_entries(path: Path | str | None = None) -> list[dict[str, Any]]:
    """Read and validate the MCP servers config. Missing file -> []."""
    resolved = Path(path or os.environ.get("MCP_SERVERS_CONFIG", "") or DEFAULT_CONFIG_PATH)
    if not resolved.exists():
        return []
    try:
        data = json.loads(resolved.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise McpConfigError(f"MCP servers config unreadable at {resolved}: {exc}") from exc
    servers = data.get("servers")
    if not isinstance(servers, list):
        raise McpConfigError(f"MCP servers config at {resolved} must hold a 'servers' list")
    seen: set[str] = set()
    for entry in servers:
        if not isinstance(entry, dict):
            raise McpConfigError(f"MCP server entry must be an object: {entry!r}")
        name = entry.get("name")
        transport = entry.get("transport")
        url = entry.get("url")
        if not isinstance(name, str) or not name.strip():
            raise McpConfigError(f"MCP server entry needs a non-empty 'name': {entry!r}")
        if name in seen:
            raise McpConfigError(f"duplicate MCP server name: {name}")
        seen.add(name)
        if transport not in SUPPORTED_TRANSPORTS:
            raise McpConfigError(
                f"MCP server '{name}': unsupported transport {transport!r} "
                f"(supported: {sorted(SUPPORTED_TRANSPORTS)})"
            )
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise McpConfigError(f"MCP server '{name}': 'url' must be an http(s) URL")
    return servers


def build_connections(
    entries: list[dict[str, Any]], env: dict[str, str] | None = None
) -> dict[str, dict[str, Any]]:
    """Translate config entries into langchain-mcp-adapters connections.

    Bearer tokens are read from the env at STARTUP (call time for the
    process lifetime) — the config names the env var, never the value.
    """
    source = os.environ if env is None else env
    connections: dict[str, dict[str, Any]] = {}
    for entry in entries:
        connection: dict[str, Any] = {
            "transport": "streamable_http",
            "url": entry["url"],
        }
        token_env = entry.get("tokenEnv")
        if token_env is not None:
            if not isinstance(token_env, str) or not token_env.strip():
                raise McpConfigError(
                    f"MCP server '{entry['name']}': 'tokenEnv' must name an env variable"
                )
            token = source.get(token_env, "").strip()
            if not token:
                raise McpConfigError(
                    f"MCP server '{entry['name']}': env {token_env} is not set — "
                    "provide it in the agent's environment (launchd plist) or drop "
                    "the server from the config"
                )
            connection["headers"] = {"Authorization": f"Bearer {token}"}
        connections[entry["name"]] = connection
    return connections


async def load_mcp_tools_from_connections(
    connections: dict[str, dict[str, Any]],
) -> list:
    """Load LangChain tools from every configured MCP server.

    Per-server tolerance: a server that cannot be reached or negotiated
    is skipped with a warning so the agent still boots with its own
    tools. Returns [] when there is nothing to load.
    """
    if not connections:
        return []
    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient(connections)
    tools: list = []
    for name in connections:
        try:
            tools.extend(await client.get_tools(server_name=name))
        except Exception as exc:  # noqa: BLE001 - startup must survive one dead server
            print(
                f"mcp_tools: server '{name}' unavailable at startup, "
                f"its tools are skipped this boot: {exc}",
                file=sys.stderr,
            )
    return tools


def load_mcp_tools_sync(path: Path | str | None = None) -> list:
    """Import-time wrapper: config file -> validated connections -> tools.

    uvicorn imports main:app inside its serving event loop, where
    asyncio.run() is illegal — fall back to a private loop on a worker
    thread when a loop is already running.
    """
    entries = load_mcp_server_entries(path)
    if not entries:
        return []
    connections = build_connections(entries)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(load_mcp_tools_from_connections(connections))
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(
            asyncio.run, load_mcp_tools_from_connections(connections)
        ).result()
