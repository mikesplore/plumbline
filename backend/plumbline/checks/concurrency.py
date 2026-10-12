"""Exercise one operation with at most twenty concurrent HTTP requests."""

import asyncio
import time

import httpx

from plumbline.checks.common import make_finding, request_operation
from plumbline.checks.conformance import SAFE_METHODS
from plumbline.models import ApiModel, Finding, RunConfig

CONCURRENCY_LIMIT = 20


async def run(api_model: ApiModel, config: RunConfig, client: httpx.AsyncClient) -> list[Finding]:
    operation = None
    if config.allow_mutations:
        operation = next((item for item in api_model.operations if item.id == "redeem_order" and item.method == "POST"), None)
    if operation is None:
        operation = next((item for item in api_model.operations if item.method in SAFE_METHODS), None)
    if operation is None:
        return [make_finding("concurrency", None, "inconclusive", "safe operation available", "no eligible operation was found", severity="info")]
    if operation.security and config.auth is None:
        return [make_finding("concurrency", operation, "inconclusive", "configured credentials", "credentials are not configured", severity="info")]
    body = None
    if operation.id == "redeem_order":
        body = {"order_id": time.time_ns() % 2_000_000_000}
    semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)

    async def make_request():
        async with semaphore:
            return await request_operation(client, api_model, config, operation, body=body) if body is not None else await request_operation(client, api_model, config, operation)

    observations = await asyncio.gather(*(make_request() for _ in range(CONCURRENCY_LIMIT)))
    failed_requests = [item for item in observations if item.status is None]
    if failed_requests:
        return [make_finding("concurrency", operation, "inconclusive", "real HTTP responses", failed_requests[0].text, failed_requests[0])]
    statuses = [item.status for item in observations]
    bodies = [item.body for item in observations]
    inconsistent = any(body != bodies[0] for body in bodies[1:])
    has_server_error = any(status is not None and status >= 500 for status in statuses)
    duplicate_redemptions = operation.id == "redeem_order" and sum(200 <= status < 300 for status in statuses if status is not None) > 1
    if has_server_error or inconsistent or duplicate_redemptions:
        status = "fail"
        result = f"status distribution {dict((code, statuses.count(code)) for code in set(statuses))}; inconsistent={inconsistent}; duplicate_redemptions={duplicate_redemptions}"
    else:
        status = "pass"
        result = f"20 responses; status distribution {dict((code, statuses.count(code)) for code in set(statuses))}"
    return [make_finding("concurrency", operation, status, "no 5xx, duplicate redemption, or inconsistent bodies", result, observations[0], severity="high")]
