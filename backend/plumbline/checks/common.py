"""Shared helpers for making real requests and recording evidence."""

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from plumbline.models import (
    ApiModel,
    AuthConfig,
    Finding,
    Operation,
    RequestEvidence,
    ResponseEvidence,
    RunConfig,
)

NO_BODY = object()


def sample_value(schema: dict[str, Any] | None) -> Any:
    """Create a small valid example from a JSON schema."""
    if not schema:
        return None
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    if schema.get("enum"):
        return schema["enum"][0]
    value_type = schema.get("type")
    if value_type == "object":
        properties = schema.get("properties", {})
        required = schema.get("required", list(properties))
        return {key: sample_value(properties[key]) for key in required if key in properties}
    if value_type == "array":
        return [sample_value(schema.get("items", {}))]
    return {"string": "example", "integer": 1, "number": 1.0, "boolean": True}.get(value_type)


def path_and_params(
    operation: Operation,
    fixtures: dict[str, str] | None = None,
) -> tuple[str, dict[str, Any], dict[str, str]]:
    path = operation.path
    query: dict[str, Any] = {}
    headers: dict[str, str] = {}
    fixtures = fixtures or {}
    for parameter in operation.parameters:
        name = parameter.get("name")
        location = parameter.get("in")
        generated = sample_value(parameter.get("schema", {}))
        value = fixtures.get(name, generated) if location == "path" else generated
        if location == "path" and name:
            path = path.replace("{" + name + "}", quote(str(value), safe=""))
        elif location == "query" and name:
            query[name] = value
        elif location == "header" and name:
            headers[name] = str(value)
    return path, query, headers


@dataclass
class Observation:
    status: int | None
    body: Any
    text: str
    request: RequestEvidence
    response: ResponseEvidence
    generated_path_parameters: list[str]


async def request_operation(
    client: httpx.AsyncClient,
    api_model: ApiModel,
    config: RunConfig,
    operation: Operation,
    *,
    token: str | None = None,
    auth_mode: str = "configured",
    body: Any = NO_BODY,
    query_params: dict[str, Any] | None = None,
    fixtures: dict[str, str] | None = None,
) -> Observation:
    fixtures = fixtures if fixtures is not None else config.fixtures
    path, params, headers = path_and_params(operation, fixtures)
    generated_path_parameters = [
        str(parameter["name"])
        for parameter in operation.parameters
        if parameter.get("in") == "path"
        and parameter.get("name")
        and parameter["name"] not in fixtures
    ]
    base = str(config.base_url).rstrip("/")
    url = f"{base}/{path.lstrip('/')}"
    auth = config.auth
    if auth_mode == "none":
        token = None
    elif token is None and auth is not None:
        token = auth.token
    if token is not None:
        schemes = [api_model.security_schemes.get(name, {}) for name in operation.security]
        api_key = next((scheme for scheme in schemes if scheme.get("type") == "apiKey"), None)
        if (auth and auth.type == "apikey") or api_key:
            name = auth.header_name if auth and auth.type == "apikey" else api_key.get("name", "X-API-Key")
            headers[str(name)] = token
        else:
            headers["Authorization"] = f"Bearer {token}"
    if body is NO_BODY:
        body = sample_value(operation.request_schema)
    if query_params is not None:
        params = query_params
    safe_headers = {
        name: ("[REDACTED]" if _sensitive_header(name, api_model, operation, auth) else value)
        for name, value in headers.items()
    }
    request_evidence = RequestEvidence(method=operation.method, url=url, headers=safe_headers, body=body)
    try:
        response = await client.request(
            operation.method,
            url,
            params=params,
            headers=headers,
            json=body if body is not None else None,
        )
        try:
            response_body = response.json()
        except ValueError:
            response_body = response.text or None
        text = response.text
        return Observation(
            status=response.status_code,
            body=response_body,
            text=text,
            request=request_evidence,
            response=ResponseEvidence(
                status=response.status_code,
                headers=dict(response.headers),
                body_snippet=text[:1000],
                elapsed_ms=response.elapsed.total_seconds() * 1000,
            ),
            generated_path_parameters=generated_path_parameters,
        )
    except httpx.RequestError as exc:
        return Observation(
            status=None,
            body=None,
            text=str(exc),
            request=request_evidence,
            response=ResponseEvidence(body_snippet=str(exc)[:1000]),
            generated_path_parameters=generated_path_parameters,
        )


def _sensitive_header(name: str, api_model: ApiModel, operation: Operation, auth: AuthConfig | None) -> bool:
    normalized = name.lower()
    if normalized == "authorization" or "api-key" in normalized or "apikey" in normalized:
        return True
    if auth and auth.type == "apikey" and normalized == auth.header_name.lower():
        return True
    return any(
        scheme.get("type") == "apiKey"
        and scheme.get("in") == "header"
        and str(scheme.get("name", "")).lower() == normalized
        for scheme in (api_model.security_schemes.get(name, {}) for name in operation.security)
    )


def make_finding(
    check: str,
    operation: Operation | None,
    status: str,
    expected: str,
    observed: str,
    observation: Observation | None = None,
    severity: str = "medium",
    suffix: str = "result",
    variant: str | None = None,
) -> Finding:
    operation_id = operation.id if operation else None
    return Finding(
        id=f"{check}:{operation_id or 'run'}:{suffix}",
        check=check,
        severity=severity,
        status=status,
        operation_id=operation_id,
        expected=expected,
        observed=observed,
        variant=variant,
        request=observation.request if observation else None,
        response=observation.response if observation else None,
    )


def allowed_status(status: int, documented: dict[str, Any]) -> bool:
    return str(status) in documented or "default" in documented or f"{status // 100}XX" in documented


def body_matches(status: int, body: Any, operation: Operation) -> str | None:
    schema = operation.responses.get(str(status))
    if schema is None:
        schema = operation.responses.get("default")
    if not schema or body is None:
        return None
    from jsonschema import ValidationError, validate

    try:
        validate(body, schema)
    except ValidationError as exc:
        return exc.message
    return None


def nested_properties(schema: dict[str, Any] | None) -> list[tuple[str, dict[str, Any]]]:
    if not schema:
        return []
    properties = schema.get("properties", {})
    return [(name, value) for name, value in properties.items() if isinstance(value, dict)]


def wrong_type(schema: dict[str, Any]) -> Any:
    return {"string": 1, "integer": "wrong", "number": "wrong", "boolean": "wrong", "array": {}, "object": "wrong"}.get(schema.get("type"), "wrong")


def oversized_value(schema: dict[str, Any]) -> str:
    size = max(int(schema.get("maxLength", 10000)) + 1, 10001)
    return "x" * min(size, 100001)
