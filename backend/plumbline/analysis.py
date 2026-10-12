"""Build compact, evidence-derived summaries for completed API runs."""

from collections import Counter, defaultdict

from plumbline.models import ApiModel, Finding, RunReport

SEVERITIES = ("high", "medium", "low", "info")
STATUSES = ("fail", "inconclusive", "pass")


def build_run_summary(report: RunReport, api_model: ApiModel | None = None) -> dict:
    counts = {status: report.summary.get(status, 0) for status in STATUSES}
    operations = {operation.id: operation for operation in api_model.operations} if api_model else {}
    operation_count = len(operations) if api_model else len(
        {finding.operation_id for finding in report.findings if finding.operation_id}
    )

    matrix = {
        severity: {
            status: sum(
                finding.severity == severity and finding.status == status
                for finding in report.findings
            )
            for status in STATUSES
        }
        for severity in SEVERITIES
    }
    failures_by_check = Counter(
        finding.check for finding in report.findings if finding.status == "fail"
    )
    missing_fixture_inconclusive = sum(
        finding.status == "inconclusive"
        and finding.observed == "Generated ID not found on target. Provide a fixture."
        for finding in report.findings
    )

    grouped: dict[str, list[Finding]] = defaultdict(list)
    for finding in report.findings:
        if finding.status == "fail":
            grouped[finding.cluster_key].append(finding)

    severity_rank = {severity: rank for rank, severity in enumerate(SEVERITIES)}
    clusters = []
    for key, findings in grouped.items():
        first = findings[0]
        severity = min(
            (finding.severity for finding in findings),
            key=lambda value: severity_rank[value],
        )
        endpoints = []
        seen = set()
        for finding in findings:
            operation = operations.get(finding.operation_id or "")
            identity = finding.operation_id or "API"
            if identity in seen:
                continue
            seen.add(identity)
            endpoints.append({
                "operation_id": finding.operation_id,
                "method": operation.method if operation else None,
                "path": operation.path if operation else finding.operation_id or "API",
            })
            if len(endpoints) == 3:
                break
        clusters.append({
            "cluster_key": key,
            "title": f"{first.check}: {first.observed or first.expected}",
            "check": first.check,
            "expected": first.expected,
            "observed": first.observed,
            "count": len(findings),
            "severity": severity,
            "sample_endpoints": endpoints,
            "finding_ids": [finding.id for finding in findings],
        })
    clusters.sort(key=lambda item: (severity_rank[item["severity"]], -item["count"], item["check"]))

    verdict = (
        f"{counts['fail']} failed, {counts['inconclusive']} inconclusive, "
        f"{counts['pass']} passed across {operation_count} operations"
    )
    return {
        "run_id": report.run_id,
        "verdict": verdict,
        "operation_count": operation_count,
        "counts": counts,
        "severity_status": matrix,
        "missing_fixture_inconclusive": missing_fixture_inconclusive,
        "failures_by_check": [
            {"check": check, "count": count}
            for check, count in sorted(failures_by_check.items(), key=lambda item: (-item[1], item[0]))
        ],
        "clusters": clusters,
    }
