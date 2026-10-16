"""Dynamic MCP tools backed by an imported OpenAPI document."""

import argparse
import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlparse

import httpx
import jsonschema
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.server.streamable_http_manager import StreamableHTTPASGIApp, StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolRequestParams, CallToolResult, ListToolsResult, TextContent, Tool

from plumbline.models import ApiModel, Operation
from plumbline.parser import SpecValidationError, parse_openapi

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class _TokenState:
    """Mutable token storage shared across all tool calls in one server session."""

    def __init__(self, initial: str | None = None) -> None:
        self.token = initial


def _session_token_state(context: Any, fallback: _TokenState) -> _TokenState:
    """Resolve the token store for a call: per-connection state on HTTP, shared on stdio."""
    connection = getattr(getattr(context, "session", None), "_connection", None)
    if connection is None:
        return fallback
    state = connection.state.get("plumbline_token_state")
    if not isinstance(state, _TokenState):
        state = _TokenState(fallback.token)
        connection.state["plumbline_token_state"] = state
    return state


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


def _empty_api_model() -> ApiModel:
    return ApiModel(title="Plumbline MCP", version="0.1.0")


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
    spec_path: Path | None = None,
) -> Server:
    """Create an MCP server whose tools map directly to contract operations."""
    fallback_token_state = _TokenState(token)
    current_model = api_model
    current_mtime: int | None = None

    def refresh_model() -> ApiModel:
        nonlocal current_model, current_mtime
        if spec_path is None:
            return current_model
        try:
            mtime = spec_path.stat().st_mtime_ns
            if mtime == current_mtime:
                return current_model
            loaded_model = parse_openapi(spec_path.read_text(encoding="utf-8"))
        except (OSError, SpecValidationError):
            return current_model
        current_model = loaded_model
        current_mtime = mtime
        return current_model

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
        loaded_model = refresh_model()
        tools_by_name = _unique_names(loaded_model)
        return ListToolsResult(tools=[auth_tool] + [
            Tool(
                name=name,
                description=f"{operation.method} {operation.path}: {operation.summary}".strip(),
                inputSchema=_input_schema(operation),
            )
            for name, operation in tools_by_name.items()
        ])

    async def call_tool(_context, params: CallToolRequestParams) -> CallToolResult:
        loaded_model = refresh_model()
        tools_by_name = _unique_names(loaded_model)
        name = params.name
        arguments = params.arguments or {}
        token_state = _session_token_state(_context, fallback_token_state)
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
            headers = _auth_headers(operation, loaded_model, token_state.token)
            for parameter in operation.parameters:
                if parameter.get("in") == "header" and parameter.get("name") in arguments:
                    headers[parameter["name"]] = str(arguments[parameter["name"]])
            if operation.request_schema is not None and "body" in arguments:
                headers["Content-Type"] = "application/json"
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
        except (ValueError, UnicodeError, binascii.Error) as exc:
            raise SystemExit(f"Invalid encoded API model: {exc}") from exc
    else:
        spec_path = Path(args.spec)
        if spec_path.is_file():
            api_model = parse_openapi(spec_path.read_text(encoding="utf-8"))
        elif args.transport == "http":
            api_model = _empty_api_model()
        else:
            raise SystemExit(f"OpenAPI spec does not exist: {spec_path}")
    token = args.token
    if args.token_env:
        token = os.environ.get(args.token_env)
        if token is None:
            raise SystemExit(f"Environment variable {args.token_env} is not set")
    server = create_server(
        api_model,
        args.base_url,
        token,
        args.allow_mutations,
        spec_path=Path(args.spec) if args.transport == "http" and args.spec else None,
    )
    if args.transport == "http":
        await _run_http(server, args)
    else:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )


async def _run_http(server: Server, args: argparse.Namespace) -> None:
    """Serve Streamable HTTP with Basic auth and OAuth authorization-code login."""

    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, RedirectResponse
    from starlette.routing import Route

    client_id = (
        args.client_id
        or os.environ.get("PLUMBLINE_MCP_CLIENT_ID")
        or os.environ.get("MCP_CLIENT_ID")
    )
    client_secret = (
        args.client_secret
        or os.environ.get("PLUMBLINE_MCP_CLIENT_SECRET")
        or os.environ.get("MCP_CLIENT_SECRET")
    )
    if not client_id or not client_secret:
        raise SystemExit("--transport http requires --client-id and --client-secret (or PLUMBLINE_MCP_CLIENT_ID / PLUMBLINE_MCP_CLIENT_SECRET)")

    redirect_uris = {
        item.strip()
        for item in os.environ.get(
            "PLUMBLINE_OAUTH_REDIRECT_URIS",
            "https://claude.ai/api/mcp/auth_callback",
        ).split(",")
        if item.strip()
    }
    authorization_codes: dict[str, dict[str, str | float]] = {}
    access_tokens: dict[str, float] = {}

    def redirect_uri_allowed(redirect_uri: str) -> bool:
        if redirect_uri in redirect_uris:
            return True
        parsed = urlparse(redirect_uri)
        return (
            parsed.scheme == "https"
            and parsed.netloc == "oauth-redirect.googleusercontent.com"
            and parsed.path.startswith("/r/")
            and len(parsed.path) > 3
            and not parsed.query
            and not parsed.fragment
        )

    def public_origin(request: Request) -> str:
        configured = args.public_url or os.environ.get("PLUMBLINE_PUBLIC_URL")
        if configured:
            return configured.rstrip("/")
        forwarded_proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        forwarded_host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
        return f"{forwarded_proto}://{forwarded_host}".rstrip("/")

    def oauth_error(request: Request, error: str, description: str) -> RedirectResponse | JSONResponse:
        redirect_uri = request.query_params.get("redirect_uri")
        if redirect_uri and redirect_uri_allowed(redirect_uri):
            params = {"error": error, "error_description": description}
            if request.query_params.get("state"):
                params["state"] = request.query_params["state"]
            return RedirectResponse(f"{redirect_uri}?{urlencode(params)}", status_code=302)
        return JSONResponse({"error": error, "error_description": description}, status_code=400)

    async def authorize(request: Request):
        query = request.query_params
        if query.get("response_type") != "code":
            return oauth_error(request, "unsupported_response_type", "Only response_type=code is supported")
        if query.get("client_id") != client_id:
            return oauth_error(request, "unauthorized_client", "Unknown client_id")
        redirect_uri = query.get("redirect_uri", "")
        if not redirect_uri_allowed(redirect_uri):
            return oauth_error(request, "invalid_request", "The redirect_uri is not registered")
        if query.get("code_challenge_method") != "S256" or not query.get("code_challenge"):
            return oauth_error(request, "invalid_request", "PKCE with S256 is required")
        code = secrets.token_urlsafe(32)
        authorization_codes[code] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "code_challenge": query["code_challenge"],
            "expires_at": time.time() + 300,
        }
        params = {"code": code}
        if query.get("state"):
            params["state"] = query["state"]
        return RedirectResponse(f"{redirect_uri}?{urlencode(params)}", status_code=302)

    async def token(request: Request):
        body = parse_qs((await request.body()).decode("utf-8"))
        form = {key: values[-1] for key, values in body.items() if values}
        if form.get("grant_type") != "authorization_code":
            return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Basic "):
            try:
                credentials = base64.b64decode(auth_header[6:]).decode("utf-8")
                basic_client_id, basic_client_secret = credentials.split(":", 1)
            except (ValueError, UnicodeError, binascii.Error):
                return JSONResponse({"error": "invalid_client"}, status_code=401)
            if not secrets.compare_digest(basic_client_id, client_id) or not secrets.compare_digest(basic_client_secret, client_secret):
                return JSONResponse({"error": "invalid_client"}, status_code=401)
            form["client_id"] = basic_client_id
        elif form.get("client_secret") is not None and not secrets.compare_digest(str(form["client_secret"]), client_secret):
            return JSONResponse({"error": "invalid_client"}, status_code=401)
        code = str(form.get("code", ""))
        record = authorization_codes.pop(code, None)
        if not record or float(record["expires_at"]) < time.time():
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        if str(form.get("client_id", "")) != record["client_id"]:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        if str(form.get("redirect_uri", "")) != record["redirect_uri"]:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        verifier = str(form.get("code_verifier", ""))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        if not verifier or not secrets.compare_digest(challenge, str(record["code_challenge"])):
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        access_token = secrets.token_urlsafe(32)
        access_tokens[access_token] = time.time() + 3600
        return JSONResponse({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": str(form.get("scope", "mcp")),
        })

    async def authorization_metadata(request: Request):
        origin = public_origin(request)
        return JSONResponse({
            "issuer": origin,
            "authorization_endpoint": f"{origin}/authorize",
            "token_endpoint": f"{origin}/token",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
            "scopes_supported": ["mcp"],
        })

    async def protected_resource_metadata(request: Request):
        origin = public_origin(request)
        return JSONResponse({
            "resource": f"{origin}/mcp",
            "authorization_servers": [origin],
            "scopes_supported": ["mcp"],
        })

    session_manager = StreamableHTTPSessionManager(
        app=server,
        json_response=True,
        security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    streamable_http_app = StreamableHTTPASGIApp(session_manager)

    class ClientAuthMiddleware:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            headers_dict = dict(scope.get("headers", []))
            auth_header = headers_dict.get(b"authorization", b"").decode("utf-8", errors="ignore")

            if scope.get("path") != "/mcp":
                await self.app(scope, receive, send)
                return

            if auth_header.startswith("Bearer "):
                bearer = auth_header[7:].strip()
                if bearer in access_tokens and access_tokens[bearer] >= time.time():
                    await self.app(scope, receive, send)
                    return

            if not auth_header.startswith("Basic "):
                response = JSONResponse(
                    {"detail": "Invalid client credentials"},
                    status_code=401,
                    headers={"WWW-Authenticate": 'Bearer, Basic realm="mcp"'},
                )
                await response(scope, receive, send)
                return

            try:
                decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
                presented_id, presented_secret = decoded.split(":", 1)
            except (ValueError, UnicodeError, binascii.Error):
                response = JSONResponse(
                    {"detail": "Invalid client credentials"},
                    status_code=401,
                    headers={"WWW-Authenticate": 'Bearer, Basic realm="mcp"'},
                )
                await response(scope, receive, send)
                return

            if not secrets.compare_digest(presented_id, client_id) or not secrets.compare_digest(presented_secret, client_secret):
                response = JSONResponse(
                    {"detail": "Invalid client credentials"},
                    status_code=401,
                    headers={"WWW-Authenticate": 'Bearer, Basic realm="mcp"'},
                )
                await response(scope, receive, send)
                return

            await self.app(scope, receive, send)

    @asynccontextmanager
    async def lifespan(app):
        async with session_manager.run():
            yield

    authenticated_app = ClientAuthMiddleware(streamable_http_app)

    starlette_app = Starlette(
        routes=[
            Route("/.well-known/oauth-authorization-server", endpoint=authorization_metadata, methods=["GET"]),
            Route("/.well-known/oauth-protected-resource", endpoint=protected_resource_metadata, methods=["GET"]),
            Route("/.well-known/oauth-protected-resource/mcp", endpoint=protected_resource_metadata, methods=["GET"]),
            Route("/authorize", endpoint=authorize, methods=["GET"]),
            Route("/token", endpoint=token, methods=["POST"]),
            Route("/mcp", endpoint=authenticated_app, methods=["GET", "POST", "DELETE"]),
        ],
        lifespan=lifespan,
    )

    import uvicorn

    host = args.host
    port = args.port
    config = uvicorn.Config(starlette_app, host=host, port=port, log_level="info")
    print(f"Plumbline MCP HTTP server on http://{host}:{port}/mcp (Basic auth and OAuth supported)")
    await uvicorn.Server(config).serve()


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
    parser.add_argument("--transport", choices=["stdio", "http"], default="stdio", help="Transport to serve on (default: stdio)")
    parser.add_argument("--client-id", help="Client ID for HTTP transport basic auth (or PLUMBLINE_MCP_CLIENT_ID)")
    parser.add_argument("--client-secret", help="Client secret for HTTP transport basic auth (or PLUMBLINE_MCP_CLIENT_SECRET)")
    parser.add_argument("--public-url", help="Public HTTPS origin used in OAuth metadata (or PLUMBLINE_PUBLIC_URL)")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="HTTP bind port (default: 8765)")
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()