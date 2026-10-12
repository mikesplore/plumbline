"""Send invalid request bodies and check that the API rejects them safely."""

import copy

import httpx

from plumbline.checks.common import (
    make_finding,
    nested_properties,
    oversized_value,
    path_and_params,
    request_operation,
    sample_value,
    wrong_type,
)
from plumbline.checks.conformance import SAFE_METHODS
from plumbline.models import ApiModel, Finding, RunConfig


def _invalid_cases(schema: dict):
    body = sample_value(schema)
    if not isinstance(body, dict):
        body = None
    if schema.get("type") == "string":
        yield "missing_body", None
        yield "wrong_type", 1
        yield "oversized_string", oversized_value(schema)
        return
    if schema.get("type") in {"array", "integer", "number", "boolean"}:
        yield "missing_body", None
        yield "wrong_type", wrong_type(schema)
        return
    if body is None:
        yield "missing_body", None
        return
    required = schema.get("required", [])
    missing = copy.deepcopy(body)
    if required:
        missing.pop(required[0], None)
    else:
        missing = {}
    yield "missing_required_field", missing
    properties = nested_properties(schema)
    if properties:
        name, prop_schema = properties[0]
        wrong = copy.deepcopy(body)
        wrong[name] = wrong_type(prop_schema)
        yield "wrong_type", wrong
    string_property = next(((name, value) for name, value in properties if value.get("type") == "string"), None)
    if string_property:
        name, prop_schema = string_property
        too_long = copy.deepcopy(body)
        too_long[name] = oversized_value(prop_schema)
        yield "oversized_string", too_long


def _invalid_query_cases(parameter: dict):
    schema = parameter.get("schema", {})
    if parameter.get("required"):
        yield "missing_required_query", None
    if schema.get("enum"):
        yield "invalid_enum_query", "__invalid__"
    elif schema.get("type") == "string":
        yield "oversized_query", oversized_value(schema)
    elif schema.get("type") in {"integer", "number", "boolean"}:
        yield "wrong_query_type", "not-a-value"


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    findings = []
    for operation in api_model.operations:
        safe = operation.method in SAFE_METHODS
        if operation.request_schema is not None:
            if not safe and not config.allow_mutations:
                findings.append(make_finding("validation", operation, "inconclusive", "allow_mutations enabled", "state-changing validation probes are disabled"))
            elif operation.security and config.auth is None:
                findings.append(make_finding("validation", operation, "inconclusive", "configured credentials", "credentials are not configured"))
            else:
                for case, body in _invalid_cases(operation.request_schema):
                    observed = await request_operation(client, api_model, config, operation, body=body)
                    findings.append(_validation_finding(operation, case, observed))
        if not safe:
            continue
        query_parameters = [parameter for parameter in operation.parameters if parameter.get("in") == "query"]
        if not query_parameters:
            continue
        if operation.security and config.auth is None:
            findings.append(make_finding("validation", operation, "inconclusive", "configured credentials", "credentials are not configured"))
            continue
        for parameter in query_parameters:
            name = parameter.get("name")
            for case, invalid_value in _invalid_query_cases(parameter):
                _, query, _ = path_and_params(operation)
                if invalid_value is None:
                    query.pop(name, None)
                else:
                    query[name] = invalid_value
                observed = await request_operation(client, api_model, config, operation, query_params=query)
                findings.append(_validation_finding(operation, case, observed))
    return findings


def _validation_finding(operation, case, observed):
    if observed.status is None:
        status, result = "inconclusive", observed.text
    elif 400 <= observed.status < 500:
        status, result = "pass", f"HTTP {observed.status} rejected invalid input"
    elif 200 <= observed.status < 300 or observed.status >= 500:
        status, result = "fail", f"HTTP {observed.status} did not reject invalid input safely"
    else:
        status, result = "inconclusive", f"HTTP {observed.status} did not confirm validation behavior"
    return make_finding("validation", operation, status, "4xx response for invalid input", result, observed, severity="high", suffix=case)
