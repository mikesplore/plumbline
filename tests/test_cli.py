import json
from datetime import datetime, timezone
from xml.etree import ElementTree

from demo_api.main import app as demo_app
from plumbline import cli
from plumbline.models import (
    AuthConfig,
    Finding,
    RequestEvidence,
    ResponseEvidence,
    RoleConfig,
    RunReport,
)


def _spec_file(tmp_path):
    path = tmp_path / "openapi.json"
    path.write_text(json.dumps(demo_app.openapi()), encoding="utf-8")
    return path


def test_cli_writes_json_html_junit_and_obeys_severity_threshold(monkeypatch, tmp_path):
    spec = _spec_file(tmp_path)
    roles_file = tmp_path / "roles.yaml"
    roles_file.write_text('- name: viewer\n  token: viewer-token\n  allowed_operation_ids: [list_items]\n', encoding="utf-8")
    fixtures_file = tmp_path / "fixtures.json"
    fixtures_file.write_text('{"id": "1"}', encoding="utf-8")
    observed = {}

    async def fake_run_checks(run_id, api_model, config, client):
        observed["config"] = config
        return RunReport(
            run_id=run_id,
            started_at=datetime.now(timezone.utc),
            base_url=str(config.base_url),
            config={},
            findings=[Finding(
                id="conformance:get_item:result", check="conformance", severity="medium", status="fail",
                operation_id="get_item", expected="valid response", observed="response mismatch",
            )],
            summary={"pass": 0, "fail": 1, "inconclusive": 0},
        )

    monkeypatch.setattr(cli, "run_checks", fake_run_checks)
    async def reachable(*_args):
        return False
    monkeypatch.setattr(cli, "_target_connection_failed", reachable)
    monkeypatch.setenv("PLUMBLINE_TEST_TOKEN", "test-token")
    output = tmp_path / "reports"
    status = cli.main([
        "run", "--spec", str(spec), "--base-url", "http://127.0.0.1:8001",
        "--token-env", "PLUMBLINE_TEST_TOKEN", "--roles", str(roles_file),
        "--fixtures", str(fixtures_file), "--fail-on", "high", "--out", str(output),
    ])

    assert status == 0
    assert observed["config"].auth == AuthConfig(type="bearer", token="test-token")
    assert observed["config"].roles == [RoleConfig(name="viewer", token="viewer-token", allowed_operation_ids=["list_items"])]
    assert observed["config"].fixtures == {"id": "1"}
    assert {path.name for path in output.iterdir()} == {"report.json", "report.html", "junit.xml"}
    assert json.loads((output / "report.json").read_text(encoding="utf-8"))["summary"]["fail"] == 1
    assert "Run analysis" in (output / "report.html").read_text(encoding="utf-8")
    suite = ElementTree.parse(output / "junit.xml").getroot()
    assert suite.attrib["failures"] == "1"


def test_cli_returns_one_for_failure_at_or_above_threshold(monkeypatch, tmp_path):
    spec = _spec_file(tmp_path)

    async def fake_run_checks(run_id, api_model, config, client):
        return RunReport(
            run_id=run_id,
            started_at=datetime.now(timezone.utc),
            base_url=str(config.base_url),
            config={},
            findings=[Finding(
                id="conformance:get_item:result", check="conformance", severity="medium", status="fail",
                operation_id="get_item", expected="valid response", observed="response mismatch",
            )],
            summary={"pass": 0, "fail": 1, "inconclusive": 0},
        )

    monkeypatch.setattr(cli, "run_checks", fake_run_checks)
    async def reachable(*_args):
        return False
    monkeypatch.setattr(cli, "_target_connection_failed", reachable)
    return_code = cli.main([
        "run", "--spec", str(spec), "--base-url", "http://127.0.0.1:8001",
        "--fail-on", "medium", "--out", str(tmp_path / "reports"),
    ])

    assert return_code == 1


def test_cli_returns_two_for_missing_token_environment_variable(monkeypatch, tmp_path):
    spec = _spec_file(tmp_path)
    monkeypatch.delenv("PLUMBLINE_TOKEN_NOT_SET", raising=False)

    return_code = cli.main([
        "run", "--spec", str(spec), "--base-url", "http://127.0.0.1:8001",
        "--token-env", "PLUMBLINE_TOKEN_NOT_SET", "--out", str(tmp_path / "reports"),
    ])

    assert return_code == 2


def test_cli_returns_two_when_all_attempts_cannot_connect(monkeypatch, tmp_path):
    spec = _spec_file(tmp_path)

    async def fake_run_checks(run_id, api_model, config, client):
        return RunReport(
            run_id=run_id,
            started_at=datetime.now(timezone.utc),
            base_url=str(config.base_url),
            config={},
            findings=[Finding(
                id="conformance:list_items:result", check="conformance", severity="medium", status="inconclusive",
                operation_id="list_items", expected="real HTTP response", observed="Connection refused",
                request=RequestEvidence(method="GET", url="http://127.0.0.1:1/items"),
                response=ResponseEvidence(status=None),
            )],
            summary={"pass": 0, "fail": 0, "inconclusive": 1},
        )

    monkeypatch.setattr(cli, "run_checks", fake_run_checks)
    async def unreachable(*_args):
        return True
    monkeypatch.setattr(cli, "_target_connection_failed", unreachable)
    return_code = cli.main([
        "run", "--spec", str(spec), "--base-url", "http://127.0.0.1:1",
        "--out", str(tmp_path / "reports"),
    ])

    assert return_code == 2
