"""Command line entry point for running Plumbline checks in CI."""

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Sequence
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx
import yaml
from pydantic import ValidationError

from plumbline.models import AuthConfig, RoleConfig, RunConfig, RunReport
from plumbline.parser import SpecValidationError, parse_openapi
from plumbline.report import render_html
from plumbline.runner import run_checks

SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}


def _load_data_file(path: str):
    try:
        return yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ValueError(f"Unable to parse {path}: {exc}") from exc
    except OSError as exc:
        raise ValueError(f"Unable to read {path}: {exc}") from exc


async def _load_spec(spec_source: str) -> str:
    if urlparse(spec_source).scheme in {"http", "https"}:
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                response = await client.get(spec_source)
                response.raise_for_status()
                return response.text
        except httpx.HTTPError as exc:
            raise ValueError(f"Unable to fetch OpenAPI document: {exc}") from exc
    try:
        return Path(spec_source).read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Unable to read OpenAPI document {spec_source}: {exc}") from exc


def _load_roles(path: str | None) -> list[RoleConfig]:
    if path is None:
        return []
    data = _load_data_file(path)
    if not isinstance(data, list):
        raise ValueError("Roles file must contain a YAML or JSON array")
    try:
        return [RoleConfig.model_validate(item) for item in data]
    except ValidationError as exc:
        raise ValueError(f"Invalid roles file: {exc}") from exc


def _load_fixtures(path: str | None) -> dict[str, str]:
    if path is None:
        return {}
    data = _load_data_file(path)
    if not isinstance(data, dict) or any(value is None or isinstance(value, (dict, list)) for value in data.values()):
        raise ValueError("Fixtures file must contain a YAML or JSON object of scalar values")
    return {str(name): str(value) for name, value in data.items()}


def _junit_xml(report: RunReport) -> bytes:
    failures = [finding for finding in report.findings if finding.status == "fail"]
    skipped = [finding for finding in report.findings if finding.status == "inconclusive"]
    suite = ElementTree.Element("testsuite", {
        "name": "Plumbline",
        "tests": str(len(report.findings)),
        "failures": str(len(failures)),
        "errors": "0",
        "skipped": str(len(skipped)),
        "timestamp": report.started_at.isoformat(),
    })
    for finding in report.findings:
        case = ElementTree.SubElement(suite, "testcase", {
            "classname": finding.check,
            "name": finding.operation_id or finding.id,
        })
        if finding.status == "fail":
            ElementTree.SubElement(case, "failure", {
                "type": finding.severity,
                "message": finding.observed or finding.expected,
            }).text = f"Expected: {finding.expected}\nObserved: {finding.observed}"
        elif finding.status == "inconclusive":
            ElementTree.SubElement(case, "skipped", {"message": finding.observed or "Inconclusive"})
    return ElementTree.tostring(suite, encoding="utf-8", xml_declaration=True)


def _write_reports(output_dir: Path, report: RunReport, api_model) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    (output_dir / "report.html").write_text(render_html(report, api_model), encoding="utf-8")
    (output_dir / "junit.xml").write_bytes(_junit_xml(report))


def _connection_failed(report: RunReport) -> bool:
    attempted = [finding for finding in report.findings if finding.request is not None and finding.response is not None]
    return bool(attempted) and all(finding.response.status is None for finding in attempted)


async def _target_connection_failed(client: httpx.AsyncClient, base_url: str) -> bool:
    try:
        await client.get(base_url)
        return False
    except httpx.RequestError:
        return True


async def _run(args: argparse.Namespace) -> int:
    spec_text = await _load_spec(args.spec)
    api_model = parse_openapi(spec_text)
    roles = _load_roles(args.roles)
    fixtures = _load_fixtures(args.fixtures)
    token = os.environ.get(args.token_env) if args.token_env else None
    if args.token_env and token is None:
        raise ValueError(f"Environment variable {args.token_env!r} is not set")
    config = RunConfig(
        base_url=args.base_url,
        auth=AuthConfig(type="bearer", token=token) if token is not None else None,
        roles=roles,
        fixtures=fixtures,
        allow_mutations=args.allow_mutations,
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        report = await run_checks(uuid.uuid4().hex, api_model, config, client)
        target_connection_failed = await _target_connection_failed(client, str(config.base_url))
    _write_reports(Path(args.out), report, api_model)
    print(report.summary and _verdict(report) or "Run completed with no findings")
    print(f"Reports written to {Path(args.out).resolve()}")
    if target_connection_failed or _connection_failed(report):
        print("Unable to connect to the target API", file=sys.stderr)
        return 2
    threshold = SEVERITY_RANK[args.fail_on]
    failed = any(
        finding.status == "fail"
        and finding.severity in SEVERITY_RANK
        and SEVERITY_RANK[finding.severity] <= threshold
        for finding in report.findings
    )
    return 1 if failed else 0


def _verdict(report: RunReport) -> str:
    return (
        f"{report.summary.get('fail', 0)} failed, "
        f"{report.summary.get('inconclusive', 0)} inconclusive, "
        f"{report.summary.get('pass', 0)} passed"
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="plumbline", description="Check an API against its OpenAPI contract")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run checks against an API")
    run.add_argument("--spec", required=True, metavar="FILE|URL", help="OpenAPI document path or URL")
    run.add_argument("--base-url", required=True, help="explicit API target URL")
    run.add_argument("--token-env", metavar="VAR", help="environment variable containing a bearer token")
    run.add_argument("--roles", metavar="FILE", help="JSON or YAML roles configuration")
    run.add_argument("--fixtures", metavar="FILE", help="JSON or YAML path fixture object")
    run.add_argument("--allow-mutations", action="store_true", help="allow POST, PUT, PATCH and DELETE checks")
    run.add_argument("--fail-on", choices=tuple(SEVERITY_RANK), default="low", help="minimum failure severity for exit code 1 (default: low)")
    run.add_argument("--out", default="plumbline-report", metavar="DIR", help="report output directory (default: plumbline-report)")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except (OSError, ValueError, ValidationError, SpecValidationError, httpx.HTTPError) as exc:
        print(f"plumbline: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
