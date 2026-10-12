"""Check documented statuses and response schemas."""

import httpx

from plumbline.checks.common import allowed_status, body_matches, make_finding, request_operation
from plumbline.models import ApiModel, Finding, RunConfig

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    findings = []
    for operation in api_model.operations:
        if operation.method not in SAFE_METHODS and not config.allow_mutations:
            continue
        if operation.security and config.auth is None:
            findings.append(make_finding("conformance", operation, "inconclusive", "configured credentials", "credentials are not configured"))
            continue
        observed = await request_operation(client, api_model, config, operation)
        if observed.status is None:
            status, expected, result = "inconclusive", "real HTTP response", observed.text
        elif not allowed_status(observed.status, operation.responses):
            status, expected, result = "fail", "documented response status", f"HTTP {observed.status} is undocumented"
        elif observed.status < 300 and (mismatch := body_matches(observed.status, observed.body, operation)):
            status, expected, result = "fail", "response matches its schema", mismatch
        else:
            status, expected, result = "pass", "documented status and response schema", f"HTTP {observed.status}"
        findings.append(make_finding("conformance", operation, status, expected, result, observed))
    return findings
