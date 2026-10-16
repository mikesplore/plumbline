"""Dynamic MCP tools backed by an imported OpenAPI document."""

import argparse
import asyncio
import base64
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import jsonschema
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolRequestParams, CallToolResult, ListToolsResult, TextContent, Tool

from plumbline.models import ApiModel, Operation
from plumbline.parser import parse_openapi

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class _TokenState:
    """Mutable token storage shared across all tool calls in one server session."""

    def __init__(self, initial: str | None = None) -> None:
        self.token = initial


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
    token_state = _TokenState(token)
    tools_by_name = _unique_names(api_model)

    auth_tool = Tool(
        name="set_auth_token",
        description=(
            "Set the bearer or header API key token used by subsequent tool calls. "
            "The token persists for the rest of the server session."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "token": {"type": "string", "description": "Bearer token or API key value"}
            },
            "required": ["token"],
            "additionalProperties": False,
        },
    )

    async def list_tools(_context, _params) -> ListToolsResult:
        return ListToolsResult(tools=[auth_tool] + [
            Tool(
                name=name,
                description=f"{operation.method} {operation.path}: {operation.summary}".strip(),
                inputSchema=_input_schema(operation),
            )
            for name, operation in tools_by_name.items()
        ])

    async def call_tool(_context, params: CallToolRequestParams) -> CallToolResult:
        name = params.name
        arguments = params.arguments or {}
        if name == "set_auth_token":
            token_value = arguments.get("token")
            if not isinstance(token_value, str) or not token_value:
                return CallToolResult(
                    content=[TextContent(type="text", text="token must be a non-empty string")],
                    isError=True,
                )
            token_state.token = token_value
            return CallToolResult(
                content=[TextContent(type="text", text="Token saved. It will be used for subsequent tool calls.")]
            )
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
        if operation.method.upper() not in SAFE_METHODS and not allow_mutations:
            return CallToolResult(
                content=[TextContent(type="text", text="State-changing tools are disabled. Start the server with --allow-mutations to enable them.")],
                isError=True,
            )

        try:
            url, query = _request_url(base_url, operation, arguments)
            headers = _auth_headers(operation, api_model, token_state.token)
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

    return Server(
        api_model.title,
        version=api_model.version or "0.1.0",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


async def _run(args: argparse.Namespace) -> None:
    if args.model_base64:
        try:
            encoded_model = "".join(args.model_base64)
            model_json = base64.urlsafe_b64decode(encoded_model.encode("ascii"))
            api_model = ApiModel.model_validate_json(model_json)
        except (ValueError, UnicodeError) as exc:
            raise SystemExit(f"Invalid encoded API model: {exc}") from exc
    else:
        spec_text = Path(args.spec).read_text(encoding="utf-8")
        api_model = parse_openapi(spec_text)
    token = args.token
    if args.token_env:
        token = os.environ.get(args.token_env)
        if token is None:
            raise SystemExit(f"Environment variable {args.token_env} is not set")
    server = create_server(api_model, args.base_url, token, args.allow_mutations)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve an OpenAPI contract as MCP tools")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--spec", help="Path to an OpenAPI JSON or YAML document")
    source.add_argument(
        "--model-base64",
        action="append",
        help="URL-safe base64 chunk of the imported ApiModel JSON; repeat for large models",
    )
    parser.add_argument("--base-url", required=True, help="Explicit target API base URL")
    parser.add_argument("--token", help="Bearer or header API key token for secured operations")
    parser.add_argument("--token-env", help="Read the token from this environment variable")
    parser.add_argument("--allow-mutations", action="store_true", help="Enable non-GET operations")
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
