"""Run the planned checks against one imported API model."""

from datetime import datetime, timezone

import httpx

from plumbline.checks import auth, concurrency, conformance, errors, ratelimit, rbac, validation
from plumbline.models import ApiModel, Finding, RunConfig, RunReport

CHECKS = (conformance.run, auth.run, validation.run, errors.run, rbac.run, ratelimit.run, concurrency.run)


def _safe_config(config: RunConfig) -> dict:
    result = config.model_dump(mode="json")
    if result.get("auth"):
        result["auth"]["token"] = "[REDACTED]"
    for role in result.get("roles", []):
        role["token"] = "[REDACTED]"
    return result


async def run_checks(
    run_id: str,
    api_model: ApiModel,
    config: RunConfig,
    client: httpx.AsyncClient,
) -> RunReport:
    findings: list[Finding] = []
    for check in CHECKS:
        findings.extend(await check(api_model, config, client))
    summary = {status: sum(finding.status == status for finding in findings) for status in ("pass", "fail", "inconclusive")}
    return RunReport(
        run_id=run_id,
        started_at=datetime.now(timezone.utc),
        base_url=str(config.base_url),
        config=_safe_config(config),
        findings=findings,
        summary=summary,
    )
