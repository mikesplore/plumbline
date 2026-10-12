"""Render completed run reports as HTML."""

import json
import shlex
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATE_DIR = Path(__file__).parent / "templates"
SEVERITY_ORDER = ("high", "medium", "low", "info")
_environment = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    autoescape=select_autoescape(["html", "xml"]),
)


def _curl_command(finding) -> str | None:
    request = finding.request
    if request is None:
        return None
    parts = [
        "curl --include",
        f"--request {shlex.quote(request.method)}",
        f"--url {shlex.quote(request.url)}",
    ]
    headers = dict(request.headers)
    has_content_type = any(name.lower() == "content-type" for name in headers)
    if request.body is not None and not has_content_type:
        headers["Content-Type"] = "application/json"
    for name, value in headers.items():
        normalized = name.lower()
        if normalized == "authorization" or "api-key" in normalized or "apikey" in normalized:
            value = "[REDACTED]"
        parts.append(f"--header {shlex.quote(f'{name}: {value}')}")
    if request.body is not None:
        body = json.dumps(request.body, separators=(",", ":"), ensure_ascii=False)
        parts.append(f"--data {shlex.quote(body)}")
    return " \\" + "\n  ".join(parts)


def _findings_by_severity(report) -> list[dict]:
    groups = []
    for severity in SEVERITY_ORDER:
        findings = [finding for finding in report.findings if finding.severity == severity]
        if findings:
            groups.append({"severity": severity, "findings": findings})
    return groups


def render_html(report) -> str:
    template = _environment.get_template("report.html")
    return template.render(
        report=report,
        finding_groups=_findings_by_severity(report),
        curl_commands={finding.id: _curl_command(finding) for finding in report.findings},
    )
