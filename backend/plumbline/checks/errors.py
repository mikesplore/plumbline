"""Scan real error responses for leaked implementation details."""

import re

import httpx

from plumbline.checks.common import make_finding, request_operation
from plumbline.checks.conformance import SAFE_METHODS
from plumbline.models import ApiModel, Finding, RunConfig

ERROR_PATTERN = re.compile(r"traceback|stack trace|/srv/|/var/|\.py:\d+|select\s+.+\s+from|syntax error", re.I)


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    findings = []
    for operation in api_model.operations:
        if operation.method not in SAFE_METHODS and not config.allow_mutations:
            continue
        observed = await request_operation(client, api_model, config, operation)
        if observed.status is None:
            status, result = "inconclusive", observed.text
        elif observed.status >= 400 and ERROR_PATTERN.search(observed.text):
            status, result = "fail", "error response contains a stack trace, path, or SQL fragment"
        else:
            status, result = "pass", f"HTTP {observed.status} contained no scanned error details"
        findings.append(make_finding("errors", operation, status, "no internal implementation details in errors", result, observed, severity="high"))
    return findings
