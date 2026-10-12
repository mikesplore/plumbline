import asyncio
import json
import os
import socket
import sys
from pathlib import Path

import pytest
import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from fastapi.testclient import TestClient

from demo_api.main import app as demo_app, reset_demo_state
from plumbline.main import app


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.asyncio
async def test_stdio_mcp_lists_tools_calls_demo_and_validates_args(tmp_path):
    reset_demo_state()
    spec_path = tmp_path / "openapi.json"
    spec_path.write_text(json.dumps(demo_app.openapi()), encoding="utf-8")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]

    api_server = uvicorn.Server(
        uvicorn.Config(demo_app, host="127.0.0.1", port=port, log_level="critical")
    )
    api_task = asyncio.create_task(api_server.serve())
    try:
        for _ in range(200):
            if api_server.started:
                break
            await asyncio.sleep(0.01)
        assert api_server.started

        env = dict(os.environ)
        env["PYTHONPATH"] = str(PROJECT_ROOT / "backend")
        params = StdioServerParameters(
            command=sys.executable,
            args=[
                "-m",
                "plumbline.mcp_server",
                "--spec",
                str(spec_path),
                "--base-url",
                f"http://127.0.0.1:{port}",
            ],
            cwd=str(PROJECT_ROOT),
            env=env,
        )
        async with stdio_client(params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()
                tools_by_name = {tool.name: tool for tool in tools.tools}
                tool_names = set(tools_by_name)
                assert "list_items" in tool_names
                assert "create_item" in tool_names
                assert tools_by_name["get_item"].inputSchema["required"] == ["id"]

                result = await session.call_tool("list_items", {})
                payload = json.loads(result.content[0].text)
                assert payload["status"] == 200
                assert "Notebook" in payload["body"]

                item_result = await session.call_tool("get_item", {"id": 1})
                item_payload = json.loads(item_result.content[0].text)
                assert item_payload["status"] == 200
                assert "Notebook" in item_payload["body"]

                invalid = await session.call_tool("list_items", {"unexpected": True})
                assert invalid.isError
                assert "validation" in invalid.content[0].text.lower()

                missing_body = await session.call_tool("create_item", {})
                assert missing_body.isError
                assert "validation" in missing_body.content[0].text.lower()

                mutation = await session.call_tool("create_item", {"body": {"name": "New"}})
                assert mutation.isError
                assert "disabled" in mutation.content[0].text.lower()
    finally:
        api_server.should_exit = True
        await api_task


def test_mcp_config_requires_explicit_base_url_and_returns_pasteable_config(tmp_path):
    spec_path = tmp_path / "openapi.json"
    response = TestClient(app).get(
        "/api/mcp-config",
        params={"spec_path": str(spec_path), "base_url": "https://api.example.test/v1"},
    )

    assert response.status_code == 200
    config = response.json()
    server = config["mcpServers"]["plumbline"]
    assert server["command"] == "uv"
    assert "plumbline.mcp_server" in server["args"]
    assert str(spec_path) in server["args"]
    assert "https://api.example.test/v1" in server["args"]

    missing_base_url = TestClient(app).get("/api/mcp-config", params={"spec_path": str(spec_path)})
    assert missing_base_url.status_code == 422
