"""Probe operations that declare an OpenAPI security requirement."""

import httpx

from plumbline.checks.common import make_finding, request_operation
from plumbline.checks.conformance import SAFE_METHODS
from plumbline.models import ApiModel, Finding, RunConfig


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    findings = []
    for operation in api_model.operations:
        if not operation.security:
            continue
        if operation.method not in SAFE_METHODS and not config.allow_mutations:
            findings.append(make_finding("auth", operation, "inconclusive", "allow_mutations enabled", "state-changing authorization probes are disabled", severity="info"))
            continue
        for mode, token, label, variant in (
            ("none", None, "no credentials", "No credentials"),
            ("configured", "invalid-plumbline-token", "invalid credentials", "Invalid token"),
        ):
            observed = await request_operation(client, api_model, config, operation, token=token, auth_mode=mode)
            if observed.status is None:
                status, result = "inconclusive", observed.text
            elif observed.status in {401, 403}:
                status, result = "pass", f"HTTP {observed.status} rejected {label}"
            elif 200 <= observed.status < 300:
                status, result = "fail", f"HTTP {observed.status} accepted {label}"
            else:
                status, result = "inconclusive", f"HTTP {observed.status} did not confirm authorization behavior"
            findings.append(make_finding(
                "auth", operation, status, "401 or 403 for unauthenticated request", result,
                observed, severity="high", suffix=label.replace(" ", "_"), variant=variant,
            ))
    return findings
