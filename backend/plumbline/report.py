"""Render completed run reports as HTML."""

import json
import shlex
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from plumbline.analysis import build_run_summary

TEMPLATE_DIR = Path(__file__).parent / "templates"
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


def render_html(report, api_model=None) -> str:
    template = _environment.get_template("report.html")
    summary = build_run_summary(report, api_model)
    paths = {
        operation.id: operation.path
        for operation in api_model.operations
    } if api_model else {}
    return template.render(
        report=report,
        summary=summary,
        failures=[finding for finding in report.findings if finding.status == "fail"],
        inconclusive=[finding for finding in report.findings if finding.status == "inconclusive"],
        passed=[finding for finding in report.findings if finding.status == "pass"],
        operation_paths=paths,
        curl_commands={finding.id: _curl_command(finding) for finding in report.findings},
    )
