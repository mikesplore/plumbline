"""Probe configured rate limits with a hard cap of fifty requests."""

import asyncio

import httpx

from plumbline.checks.common import make_finding, request_operation
from plumbline.checks.conformance import SAFE_METHODS
from plumbline.models import ApiModel, Finding, RunConfig

MAX_RATE_PROBES = 50


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    rate = config.rate_limit
    if rate is None:
        return [make_finding("ratelimit", None, "inconclusive", "rate_limit configured", "expected limit and window were not configured", severity="info")]
    operation = next((item for item in api_model.operations if item.id == rate.operation_id), None)
    if operation is None:
        return [make_finding("ratelimit", None, "inconclusive", "configured operation exists", f"unknown operation {rate.operation_id}", severity="info")]
    if operation.method not in SAFE_METHODS and not config.allow_mutations:
        return [make_finding("ratelimit", operation, "inconclusive", "allow_mutations enabled", "state-changing rate-limit probes are disabled", severity="info")]
    count = min(rate.expected_limit + 5, MAX_RATE_PROBES)
    delay = rate.window_s / count if count and rate.window_s else 0
    observations = []
    for index in range(count):
        observed = await request_operation(client, api_model, config, operation)
        observations.append(observed)
        if observed.status is None:
            return [make_finding("ratelimit", operation, "inconclusive", "real HTTP responses", observed.text, observed)]
        if observed.status == 429:
            break
        if delay and index + 1 < count:
            await asyncio.sleep(delay)
    limited = any(item.status == 429 for item in observations)
    last = observations[-1]
    if limited:
        status, result = "inconclusive", f"HTTP 429 observed after {len(observations)} requests; configured behavior needs review"
    else:
        status, result = "fail", f"no HTTP 429 after {len(observations)} requests"
    return [make_finding("ratelimit", operation, status, f"HTTP 429 within {count} requests", result, last, severity="medium")]
