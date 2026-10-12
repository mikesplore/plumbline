"""Load, validate, and normalize OpenAPI documents."""

import json
import re
from collections.abc import Mapping
from typing import Any

import yaml

from plumbline.models import ApiModel, Operation


HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}


class SpecValidationError(ValueError):
    """OpenAPI validation error with a readable document location."""


def _load_document(spec_text: str) -> dict[str, Any]:
    try:
        document = json.loads(spec_text)
    except json.JSONDecodeError:
        try:
            document = yaml.safe_load(spec_text)
        except yaml.YAMLError as exc:
            raise SpecValidationError(f"$: Invalid JSON or YAML: {exc}") from exc
    if not isinstance(document, dict):
        raise SpecValidationError("$: OpenAPI document must be an object")
    return document


def _validation_message(exc: Exception) -> str:
    path = getattr(exc, "path", None)
    if path:
        location = ".".join(str(part) for part in path)
    else:
        location = "$"
    message = getattr(exc, "message", None) or str(exc)
    return f"{location}: {message}"


def _schema_from_content(content: Any) -> dict[str, Any] | None:
    if not isinstance(content, Mapping):
        return None
    media = content.get("application/json")
    if not isinstance(media, Mapping):
        media = next((value for value in content.values() if isinstance(value, Mapping)), None)
    schema = media.get("schema") if isinstance(media, Mapping) else None
    return dict(schema) if isinstance(schema, Mapping) else None


def _operation_id(method: str, path: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", f"{method}_{path}").strip("_")
    return slug.lower()


def parse_openapi(spec_text: str) -> ApiModel:
    """Validate JSON/YAML OpenAPI text, resolve references, and normalize it."""
    source_document = _load_document(spec_text)
    try:
        from prance import ResolvingParser

        parser = ResolvingParser(
            spec_string=spec_text,
            backend="openapi-spec-validator",
            strict=False,
        )
        document = parser.specification
    except Exception as exc:
        raise SpecValidationError(_validation_message(exc)) from exc

    info = document.get("info") or {}
    paths = document.get("paths") or {}
    global_security = document.get("security") or []
    operations: list[Operation] = []

    for path, path_item in paths.items():
        if not isinstance(path_item, Mapping):
            continue
        path_parameters = path_item.get("parameters", [])
        for method, operation in path_item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, Mapping):
                continue
            parameters = [*path_parameters, *(operation.get("parameters") or [])]
            request_body = operation.get("requestBody") or {}
            responses: dict[str, dict | None] = {}
            for status, response in (operation.get("responses") or {}).items():
                schema = _schema_from_content(response.get("content")) if isinstance(response, Mapping) else None
                responses[str(status)] = schema
            security = operation.get("security", global_security) or []
            security_names = list(dict.fromkeys(
                name for requirement in security if isinstance(requirement, Mapping)
                for name in requirement
            ))
            operations.append(Operation(
                id=operation.get("operationId") or _operation_id(method, path),
                method=method.upper(),
                path=path,
                summary=operation.get("summary") or operation.get("description") or "",
                tags=list(operation.get("tags") or []),
                parameters=[dict(p) for p in parameters if isinstance(p, Mapping)],
                request_schema=_schema_from_content(request_body.get("content")),
                request_required=bool(request_body.get("required", False)),
                responses=responses,
                security=security_names,
            ))

    schemes = ((document.get("components") or {}).get("securitySchemes") or {})
    schemas = ((source_document.get("components") or {}).get("schemas") or {})
    servers = [server["url"] for server in document.get("servers", []) if isinstance(server, Mapping) and "url" in server]
    return ApiModel(
        title=info.get("title") or "Untitled API",
        version=info.get("version") or "",
        servers=servers,
        security_schemes=dict(schemes),
        schemas={name: dict(schema) for name, schema in schemas.items() if isinstance(schema, Mapping)},
        operations=operations,
    )
