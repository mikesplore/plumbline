"""Dynamic MCP tools backed by an imported OpenAPI document."""

import argparse
import asyncio
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import jsonschema
from mcp.server import InitializationOptions, Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool

from plumbline.models import ApiModel, Operation
from plumbline.parser import parse_openapi


def _tool_name(operation_id: str) -> str:
    name = re.sub(r"[^a-zA-Z0-9_-]", "_", operation_id)
    if not name or not name[0].isalpha():
        name = f"api_{name}"
    return name[:64]


def _input_schema(operation: Operation) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for parameter in operation.parameters:
        name = parameter.get("name")
        location = parameter.get("in")
        if not name or location not in {"path", "query", "header"}:
            continue
        properties[name] = dict(parameter.get("schema") or {})
        if location == "path" or parameter.get("required"):
            required.append(name)
    if operation.request_schema is not None:
        properties["body"] = operation.request_schema
        if operation.request_required:
            required.append("body")
    return {
        "type": "object",
        "properties": properties,
        "required": list(dict.fromkeys(required)),
        "additionalProperties": False,
    }


def _unique_names(api_model: ApiModel) -> dict[str, Operation]:
    result: dict[str, Operation] = {}
    for operation in api_model.operations:
        base_name = _tool_name(operation.id)
        name = base_name
        suffix = 2
        while name in result:
            name = f"{base_name[:59]}_{suffix}"
            suffix += 1
        result[name] = operation
    return result


def _auth_headers(operation: Operation, api_model: ApiModel, token: str | None) -> dict[str, str]:
    if not token:
        return {}
    headers: dict[str, str] = {}
    for name in operation.security:
        scheme = api_model.security_schemes.get(name, {})
        scheme_type = scheme.get("type")
        if scheme_type == "http" and scheme.get("scheme", "").lower() == "bearer":
            headers["Authorization"] = f"Bearer {token}"
        elif scheme_type == "apiKey" and scheme.get("in") == "header":
            headers[scheme.get("name", "X-API-Key")] = token
    return headers


def _request_url(base_url: str, operation: Operation, arguments: dict[str, Any]) -> tuple[str, list[tuple[str, Any]]]:
    path = operation.path
    query: list[tuple[str, Any]] = []
    for parameter in operation.parameters:
        name = parameter.get("name")
        location = parameter.get("in")
        if name not in arguments:
            continue
        value = arguments[name]
        if location == "path":
            path = path.replace("{" + name + "}", quote(str(value), safe=""))
        elif location == "query":
            if isinstance(value, list):
                query.extend((name, item) for item in value)
            else:
                query.append((name, value))
    if "{" in path or "}" in path:
        raise ValueError("A required path parameter is missing")
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}", query


def create_server(
    api_model: ApiModel,
    base_url: str,
    token: str | None = None,
    allow_mutations: bool = False,
) -> Server:
    """Create an MCP server whose tools map directly to contract operations."""
    tools_by_name = _unique_names(api_model)
    server = Server(api_model.title, version=api_model.version or "0.1.0")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name=name,
                description=f"{operation.method} {operation.path}: {operation.summary}".strip(),
                inputSchema=_input_schema(operation),
            )
            for name, operation in tools_by_name.items()
        ]

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
        operation = tools_by_name.get(name)
        if operation is None:
            return CallToolResult(
                content=[TextContent(type="text", text=f"Unknown tool: {name}")], isError=True
            )
        try:
            jsonschema.validate(arguments, _input_schema(operation))
        except jsonschema.ValidationError as exc:
            return CallToolResult(
                content=[TextContent(type="text", text=f"Input validation error: {exc.message}")],
                isError=True,
            )
        if operation.method.upper() != "GET" and not allow_mutations:
            return CallToolResult(
                content=[TextContent(type="text", text="State-changing tools are disabled. Start the server with --allow-mutations to enable them.")],
                isError=True,
            )

        try:
            url, query = _request_url(base_url, operation, arguments)
            headers = _auth_headers(operation, api_model, token)
            for parameter in operation.parameters:
                if parameter.get("in") == "header" and parameter.get("name") in arguments:
                    headers[parameter["name"]] = str(arguments[parameter["name"]])
            request_kwargs: dict[str, Any] = {"params": query, "headers": headers}
            if operation.request_schema is not None and "body" in arguments:
                request_kwargs["json"] = arguments["body"]
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.request(operation.method, url, **request_kwargs)
            result = {
                "status": response.status_code,
                "headers": dict(response.headers),
                "body": response.text,
            }
            return CallToolResult(content=[TextContent(type="text", text=json.dumps(result, indent=2))])
        except (httpx.HTTPError, ValueError) as exc:
            return CallToolResult(
                content=[TextContent(type="text", text=f"Request failed: {exc}")], isError=True
            )

    return server


async def _run(args: argparse.Namespace) -> None:
    spec_text = Path(args.spec).read_text(encoding="utf-8")
    api_model = parse_openapi(spec_text)
    server = create_server(api_model, args.base_url, args.token, args.allow_mutations)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name=api_model.title,
                server_version=api_model.version or "0.1.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(), experimental_capabilities={}
                ),
            ),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve an OpenAPI contract as MCP tools")
    parser.add_argument("--spec", required=True, help="Path to an OpenAPI JSON or YAML document")
    parser.add_argument("--base-url", required=True, help="Explicit target API base URL")
    parser.add_argument("--token", help="Bearer or header API key token for secured operations")
    parser.add_argument("--allow-mutations", action="store_true", help="Enable non-GET operations")
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
