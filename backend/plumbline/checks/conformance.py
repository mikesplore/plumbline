"""Check documented statuses and response schemas."""

import re

import httpx

from plumbline.checks.common import allowed_status, body_matches, make_finding, request_operation
from plumbline.models import ApiModel, Finding, RunConfig

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
MISSING_FIXTURE_REASON = "Generated ID not found on target. Provide a fixture."


def _list_operation_matches(list_operation, detail_operation) -> str | None:
    if list_operation.method != "GET" or detail_operation.method != "GET":
        return None
    match = re.search(r"/\{([^{}]+)\}$", detail_operation.path)
    if not match:
        return None
    list_path = detail_operation.path[:match.start()].rstrip("/") or "/"
    if list_path.rstrip("/") != list_operation.path.rstrip("/"):
        return None
    return match.group(1)


def _first_item_fixture(body, parameter_name: str) -> str | None:
    if not isinstance(body, list) or not body or not isinstance(body[0], dict):
        return None
    item = body[0]
    value = item.get(parameter_name, item.get("id"))
    return str(value) if value is not None and not isinstance(value, (dict, list)) else None


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    findings = []
    operations = [operation for operation in api_model.operations if operation.method in SAFE_METHODS or config.allow_mutations]
    discovered: dict[str, dict[str, str]] = {}
    cached_observations = {}
    if config.discover_fixtures:
        for detail_operation in operations:
            for list_operation in operations:
                parameter_name = _list_operation_matches(list_operation, detail_operation)
                if parameter_name is None:
                    continue
                if list_operation.id not in cached_observations:
                    cached_observations[list_operation.id] = await request_operation(
                        client, api_model, config, list_operation,
                    )
                observation = cached_observations[list_operation.id]
                fixture_value = _first_item_fixture(observation.body, parameter_name) if observation.status == 200 else None
                if fixture_value is not None:
                    discovered.setdefault(detail_operation.id, {})[parameter_name] = fixture_value
    for operation in operations:
        if operation.security and config.auth is None:
            findings.append(make_finding("conformance", operation, "inconclusive", "configured credentials", "credentials are not configured"))
            continue
        operation_fixtures = {**config.fixtures, **discovered.get(operation.id, {})}
        observed = cached_observations.get(operation.id) or await request_operation(
            client, api_model, config, operation, fixtures=operation_fixtures,
        )
        if observed.status is None:
            status, expected, result = "inconclusive", "real HTTP response", observed.text
        elif (
            observed.status == 404
            and observed.generated_path_parameters
            and not allowed_status(404, operation.responses)
        ):
            status, expected, result = "inconclusive", "a real resource identified by a fixture", MISSING_FIXTURE_REASON
        elif not allowed_status(observed.status, operation.responses):
            status, expected, result = "fail", "documented response status", f"HTTP {observed.status} is undocumented"
        elif observed.status < 300 and (mismatch := body_matches(observed.status, observed.body, operation)):
            status, expected, result = "fail", "response matches its schema", mismatch
        else:
            status, expected, result = "pass", "documented status and response schema", f"HTTP {observed.status}"
        findings.append(make_finding("conformance", operation, status, expected, result, observed))
    return findings
