from datetime import datetime, timezone

from plumbline.models import Finding, RequestEvidence, ResponseEvidence, RunReport
from plumbline.report import render_html


def test_html_report_groups_findings_and_shows_reproduction_and_evidence():
    report = RunReport(
        run_id="demo-run",
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        base_url="https://api.example.test",
        summary={"pass": 1, "fail": 1, "inconclusive": 0},
        findings=[
            Finding(
                id="validation:create_item:wrong_type",
                check="validation",
                severity="high",
                status="fail",
                operation_id="create_item",
                expected="4xx response for invalid input",
                observed="HTTP 500 did not reject invalid input safely",
                request=RequestEvidence(
                    method="POST",
                    url="https://api.example.test/items",
                    headers={"Authorization": "[REDACTED]"},
                    body={"name": 42},
                ),
                response=ResponseEvidence(status=500, body_snippet='{"detail":"failure"}'),
            ),
            Finding(
                id="conformance:list_items:result",
                check="conformance",
                severity="low",
                status="pass",
                operation_id="list_items",
                expected="documented response",
                observed="HTTP 200 matched the contract",
            ),
        ],
    )

    html = render_html(report)

    assert "1 failed, 0 inconclusive, 1 passed across 2 operations" in html
    assert html.index("Needs attention") < html.index("Failed findings")
    assert html.index("Failed findings") < html.index("Inconclusive findings")
    assert html.index("Inconclusive findings") < html.index("Passed findings")
    assert "Reproduce with curl" in html
    assert "curl --include" in html
    assert "Authorization: [REDACTED]" in html
    assert "application/json" in html
    assert "HTTP request and response evidence" in html
    assert "HTTP 500 did not reject invalid input safely" in html
