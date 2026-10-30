"""Server-side MCP tool loading (open-mcp-client lane).

Covers the config seam: file parsing, validation, the tokenEnv
read-at-startup law (values never in the config), and per-server
tolerance. A live integration test exercises the real Studio-local
buzz-mcp service when it is reachable, and skips cleanly elsewhere.
"""

import json
from pathlib import Path

import pytest

from src.mcp_tools import (
    McpConfigError,
    build_connections,
    load_mcp_server_entries,
    load_mcp_tools_from_connections,
)


def write_config(tmp_path: Path, servers: list) -> Path:
    path = tmp_path / "mcp-servers.json"
    path.write_text(json.dumps({"servers": servers}))
    return path


def test_missing_config_file_means_no_servers(tmp_path):
    assert load_mcp_server_entries(tmp_path / "absent.json") == []


def test_valid_config_parses(tmp_path):
    path = write_config(tmp_path, [
        {"name": "buzz", "transport": "streamable_http", "url": "http://127.0.0.1:8128/mcp"},
    ])
    entries = load_mcp_server_entries(path)
    assert entries == [
        {"name": "buzz", "transport": "streamable_http", "url": "http://127.0.0.1:8128/mcp"}
    ]


def test_config_requires_servers_list(tmp_path):
    path = tmp_path / "mcp-servers.json"
    path.write_text(json.dumps({"nope": []}))
    with pytest.raises(McpConfigError, match=r"'servers' list"):
        load_mcp_server_entries(path)


def test_config_rejects_unknown_transport(tmp_path):
    path = write_config(tmp_path, [
        {"name": "x", "transport": "stdio", "url": "http://127.0.0.1:1/mcp"},
    ])
    with pytest.raises(McpConfigError, match="unsupported transport"):
        load_mcp_server_entries(path)


def test_config_rejects_non_http_url(tmp_path):
    path = write_config(tmp_path, [
        {"name": "x", "transport": "streamable_http", "url": "ftp://example.invalid"},
    ])
    with pytest.raises(McpConfigError, match="http"):
        load_mcp_server_entries(path)


def test_config_rejects_duplicate_names(tmp_path):
    path = write_config(tmp_path, [
        {"name": "buzz", "transport": "streamable_http", "url": "http://127.0.0.1:1/mcp"},
        {"name": "buzz", "transport": "streamable_http", "url": "http://127.0.0.1:2/mcp"},
    ])
    with pytest.raises(McpConfigError, match="duplicate"):
        load_mcp_server_entries(path)


def test_connections_without_token_env_carry_no_auth_header():
    entries = [
        {"name": "open", "transport": "streamable_http", "url": "http://127.0.0.1:9/mcp"}
    ]
    assert build_connections(entries, env={}) == {
        "open": {"transport": "streamable_http", "url": "http://127.0.0.1:9/mcp"}
    }


def test_connections_read_bearer_from_named_env_at_startup():
    entries = [
        {
            "name": "buzz",
            "transport": "streamable_http",
            "url": "http://127.0.0.1:8128/mcp",
            "tokenEnv": "BUZZ_MCP_TOKEN",
        }
    ]
    connections = build_connections(entries, env={"BUZZ_MCP_TOKEN": "secret-value"})
    assert connections["buzz"]["headers"] == {"Authorization": "Bearer secret-value"}


def test_missing_token_env_fails_loud(tmp_path):
    entries = [
        {
            "name": "buzz",
            "transport": "streamable_http",
            "url": "http://127.0.0.1:8128/mcp",
            "tokenEnv": "BUZZ_MCP_TOKEN",
        }
    ]
    with pytest.raises(McpConfigError, match="BUZZ_MCP_TOKEN is not set"):
        build_connections(entries, env={})


def test_unreachable_server_is_skipped_not_fatal():
    import asyncio

    connections = {
        "dead": {
            "transport": "streamable_http",
            "url": "http://127.0.0.1:1/mcp",  # nothing listens here
            "headers": {"Authorization": "Bearer x"},
        }
    }
    tools = asyncio.run(load_mcp_tools_from_connections(connections))
    assert tools == []


def _buzz_reachable() -> bool:
    import socket

    try:
        with socket.create_connection(("127.0.0.1", 8128), timeout=1):
            return True
    except OSError:
        return False


@pytest.mark.skipif(not _buzz_reachable(), reason="buzz-mcp not running on this host")
def test_live_buzz_mcp_lists_and_calls_a_real_tool():
    """The acceptance proof: the agent's MCP lane lists the studio-local
    buzz-mcp tools and CALLS one (read-only channels list)."""
    import asyncio
    import os

    token = os.environ.get("BUZZ_MCP_TOKEN", "").strip()
    if not token:
        pytest.skip("BUZZ_MCP_TOKEN not in this environment")
    connections = build_connections([
        {
            "name": "buzz",
            "transport": "streamable_http",
            "url": "http://127.0.0.1:8128/mcp",
            "tokenEnv": "BUZZ_MCP_TOKEN",
        }
    ])
    tools = asyncio.run(load_mcp_tools_from_connections(connections))
    names = [tool.name for tool in tools]
    assert "buzz_channels_list" in names
    list_tool = next(tool for tool in tools if tool.name == "buzz_channels_list")
    channels = asyncio.run(list_tool.ainvoke({}))
    # channels list answers with a JSON structure (possibly empty), not an error
    assert channels is not None
