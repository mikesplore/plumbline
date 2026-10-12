import json

import httpx
import pytest

from demo_api.main import app as demo_app, reset_demo_state
from plumbline.checks import auth, concurrency, conformance, errors, ratelimit, rbac, validation
from plumbline.checks.common import request_operation
from plumbline.models import AuthConfig, RateLimitConfig, RoleConfig, RunConfig
from plumbline.parser import parse_openapi
from plumbline.runner import run_checks


def demo_model():
    return parse_openapi(json.dumps(demo_app.openapi()))


def config(**values):
    defaults = {
        "base_url": "http://demo",
        "auth": AuthConfig(type="bearer", token="user-demo-token"),
        "allow_mutations": False,
    }
    defaults.update(values)
    return RunConfig(**defaults)


async def check_with_demo(check, run_config):
    reset_demo_state()
    transport = httpx.ASGITransport(app=demo_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://demo") as client:
        return await check(demo_model(), run_config, client)


@pytest.mark.asyncio
async def test_conformance_checks_status_and_response_schema():
    findings = await check_with_demo(conformance.run, config(allow_mutations=True))
    by_operation = {item.operation_id: item for item in findings}

    assert by_operation["list_items"].status == "pass"
    assert by_operation["get_item"].status == "fail"
    assert "number" in by_operation["get_item"].observed or "string" in by_operation["get_item"].observed


@pytest.mark.asyncio
async def test_auth_check_finds_open_secured_endpoint_and_redacts_token():
    findings = await check_with_demo(auth.run, config())
    admin_probe = next(item for item in findings if item.operation_id == "list_admin_users" and item.id.endswith("no_credentials"))
    garbage_probe = next(item for item in findings if item.operation_id == "list_admin_users" and item.id.endswith("invalid_credentials"))

    assert admin_probe.status == "fail"
    assert admin_probe.response.status == 200
    assert garbage_probe.request.headers["Authorization"] == "[REDACTED]"
    blocked_mutations = [item for item in findings if item.operation_id in {"create_item", "delete_item"}]
    assert all(item.status == "inconclusive" and item.request is None for item in blocked_mutations)


@pytest.mark.asyncio
async def test_custom_api_key_header_is_redacted_in_request_evidence():
    reset_demo_state()
    model = demo_model()
    api_key_config = config(auth=AuthConfig(type="apikey", token="secret", header_name="X-Service-Credential"))
    operation = next(item for item in model.operations if item.id == "list_items")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=demo_app), base_url="http://demo") as client:
        observation = await request_operation(client, model, api_key_config, operation)

    assert observation.status == 200
    assert observation.request.headers["X-Service-Credential"] == "[REDACTED]"


@pytest.mark.asyncio
async def test_validation_check_finds_missing_and_wrong_body_inputs():
    findings = await check_with_demo(validation.run, config(allow_mutations=True))
    create_item = [item for item in findings if item.operation_id == "create_item"]

    assert len(create_item) == 3
    assert all(item.status == "fail" for item in create_item)
    assert any("HTTP 500" in item.observed for item in create_item)


@pytest.mark.asyncio
async def test_errors_check_finds_debug_trace_in_real_response():
    findings = await check_with_demo(errors.run, config())
    debug = next(item for item in findings if item.operation_id == "debug_crash")

    assert debug.status == "fail"
    assert debug.response.status == 500


@pytest.mark.asyncio
async def test_rbac_check_finds_viewer_access_to_disallowed_delete():
    viewer = RoleConfig(name="viewer", token="viewer-demo-token", allowed_operation_ids=["list_items", "get_item", "search_items"])
    findings = await check_with_demo(rbac.run, config(roles=[viewer], allow_mutations=True))
    delete = next(item for item in findings if item.operation_id == "delete_item")

    assert delete.status == "fail"
    assert delete.response.status == 204


@pytest.mark.asyncio
async def test_ratelimit_check_caps_probe_and_finds_missing_limiter():
    rate = RateLimitConfig(operation_id="search_items", expected_limit=2, window_s=0)
    findings = await check_with_demo(ratelimit.run, config(rate_limit=rate))

    assert findings[0].status == "fail"
    assert "after 7 requests" in findings[0].observed


@pytest.mark.asyncio
async def test_ratelimit_probe_has_hard_cap_of_fifty_requests():
    rate = RateLimitConfig(operation_id="search_items", expected_limit=100, window_s=0)
    findings = await check_with_demo(ratelimit.run, config(rate_limit=rate))

    assert findings[0].status == "fail"
    assert "after 50 requests" in findings[0].observed


@pytest.mark.asyncio
async def test_concurrency_check_finds_duplicate_redemptions():
    findings = await check_with_demo(concurrency.run, config(allow_mutations=True))

    assert findings[0].operation_id == "redeem_order"
    assert findings[0].status == "fail"
    assert "duplicate_redemptions=True" in findings[0].observed
    assert "200: 20" in findings[0].observed


@pytest.mark.asyncio
async def test_full_run_finds_each_seeded_defect_and_passes_control_operation():
    reset_demo_state()
    model = demo_model()
    role = RoleConfig(name="viewer", token="viewer-demo-token", allowed_operation_ids=["list_items", "get_item", "search_items"])
    run_config = config(
        roles=[role],
        allow_mutations=True,
        rate_limit=RateLimitConfig(operation_id="search_items", expected_limit=2, window_s=0),
    )
    transport = httpx.ASGITransport(app=demo_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://demo") as client:
        report = await run_checks("seeded-defects", model, run_config, client)

    failed = {(finding.check, finding.operation_id) for finding in report.findings if finding.status == "fail"}
    assert {
        ("conformance", "get_item"),
        ("auth", "list_admin_users"),
        ("validation", "create_item"),
        ("errors", "debug_crash"),
        ("rbac", "delete_item"),
        ("ratelimit", "search_items"),
        ("concurrency", "redeem_order"),
    } <= failed
    control = next(item for item in report.findings if item.check == "conformance" and item.operation_id == "list_items")
    assert control.status == "pass"
    assert report.config["auth"]["token"] == "[REDACTED]"
    assert report.config["roles"][0]["token"] == "[REDACTED]"


@pytest.mark.asyncio
async def test_unreachable_base_url_produces_only_inconclusive_findings():
    report_config = config(base_url="http://127.0.0.1:1", auth=None)
    model = demo_model()
    async with httpx.AsyncClient(timeout=0.1) as client:
        from plumbline.runner import run_checks

        report = await run_checks("unreachable", model, report_config, client)

    assert report.findings
    assert {finding.status for finding in report.findings} == {"inconclusive"}
    assert report.config["auth"] is None
