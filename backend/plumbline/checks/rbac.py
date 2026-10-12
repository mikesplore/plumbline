"""Check configured role tokens against their operation allow lists."""

import httpx

from plumbline.checks.common import make_finding, request_operation
from plumbline.models import ApiModel, Finding, RunConfig


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    if not config.roles:
        return [make_finding("rbac", None, "inconclusive", "roles configured", "no role tokens were provided", severity="info")]
    findings = []
    for role in config.roles:
        for operation in api_model.operations:
            if operation.method not in {"GET", "HEAD", "OPTIONS"} and not config.allow_mutations:
                findings.append(make_finding("rbac", operation, "inconclusive", "allow_mutations enabled", f"{role.name}: state-changing probe is disabled", severity="info", suffix=role.name))
                continue
            observed = await request_operation(client, api_model, config, operation, token=role.token)
            allowed = operation.id in role.allowed_operation_ids
            if observed.status is None:
                status, result = "inconclusive", observed.text
            elif 200 <= observed.status < 300 and not allowed:
                status, result = "fail", f"{role.name} received HTTP {observed.status} for a disallowed operation"
            elif 200 <= observed.status < 300 and allowed:
                status, result = "pass", f"{role.name} received HTTP {observed.status} for an allowed operation"
            elif observed.status in {401, 403} and not allowed:
                status, result = "pass", f"{role.name} was denied with HTTP {observed.status}"
            else:
                status, result = "inconclusive", f"HTTP {observed.status} did not confirm the role policy"
            findings.append(make_finding("rbac", operation, status, "role access matches its allow list", result, observed, severity="high", suffix=role.name))
    return findings
