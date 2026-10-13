"""Plumbline contract import and test-run APIs."""

import asyncio
import base64
from hashlib import sha256
import os
import shutil
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import AnyHttpUrl, BaseModel, Field, model_validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from plumbline.analysis import build_run_summary
from plumbline.models import ApiModel, AuthConfig, Finding, RunConfig, RunReport
from plumbline.parser import SpecValidationError, parse_openapi
from plumbline.report import render_html
from plumbline.runner import run_checks

PROJECT_DIR = Path(__file__).resolve().parents[2]
SPEC_PATH = PROJECT_DIR / ".plumbline" / "current-openapi.txt"
RUNS_DIR = Path("runs")


@asynccontextmanager
async def lifespan(application: FastAPI):
    if getattr(application.state, "api_model", None) is None and SPEC_PATH.is_file():
        try:
            application.state.api_model = parse_openapi(SPEC_PATH.read_text(encoding="utf-8"))
        except (OSError, SpecValidationError):
            # A missing or damaged saved contract should not prevent the API from starting.
            pass
    yield


app = FastAPI(title="Plumbline", version="0.1.0", lifespan=lifespan)


class ImportRequest(BaseModel):
    spec: str | None = None
    url: AnyHttpUrl | None = None

    @model_validator(mode="after")
    def require_one_source(self):
        if (self.spec is None) == (self.url is None):
            raise ValueError("provide exactly one of 'spec' or 'url'")
        return self


class ExplorerRequest(BaseModel):
    operation_id: str
    base_url: AnyHttpUrl
    parameters: dict[str, Any] = Field(default_factory=dict)
    body: Any = None
    auth: AuthConfig | None = None


class TargetCheckRequest(BaseModel):
    base_url: AnyHttpUrl
    auth: AuthConfig | None = None


class McpConnectionRequest(TargetCheckRequest):
    allow_mutations: bool = False


def _report_path(run_id: str) -> Path:
    if not run_id or any(character not in "0123456789abcdef" for character in run_id.lower()):
        raise HTTPException(status_code=404, detail="Run not found")
    path = (RUNS_DIR / f"{run_id}.json").resolve()
    if not path.is_relative_to(RUNS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="Run not found")
    return path


def _saved_report(run_id: str) -> RunReport | None:
    path = _report_path(run_id)
    if not path.is_file():
        return None
    try:
        return RunReport.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _saved_model(run_id: str) -> ApiModel | None:
    path = _report_path(run_id).with_name(f"{run_id}.model.json")
    try:
        return ApiModel.model_validate_json(path.read_text(encoding="utf-8")) if path.is_file() else None
    except (OSError, ValueError):
        return None


@app.post("/api/import", response_model=ApiModel)
async def import_spec(request: ImportRequest) -> ApiModel:
    spec_text = request.spec
    if request.url is not None:
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                response = await client.get(str(request.url))
                response.raise_for_status()
                spec_text = response.text
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=422, detail=f"Unable to fetch OpenAPI URL: {exc}") from exc
    try:
        model = parse_openapi(spec_text or "")
    except SpecValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    saved_spec = SPEC_PATH.with_suffix(f"{SPEC_PATH.suffix}.tmp")
    try:
        SPEC_PATH.parent.mkdir(parents=True, exist_ok=True)
        saved_spec.write_text(spec_text or "", encoding="utf-8")
        saved_spec.replace(SPEC_PATH)
    except OSError as exc:
        saved_spec.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Unable to save the imported OpenAPI document: {exc}") from exc
    app.state.api_model = model
    return model


@app.get("/api/model", response_model=ApiModel)
async def get_model() -> ApiModel:
    model = getattr(app.state, "api_model", None)
    if model is None:
        raise HTTPException(status_code=404, detail="No API model has been imported")
    return model


@app.get("/api/model/source")
async def get_model_source() -> dict[str, str]:
    if getattr(app.state, "api_model", None) is None or not SPEC_PATH.is_file():
        raise HTTPException(status_code=404, detail="Saved OpenAPI document is not available")
    try:
        return {"spec": SPEC_PATH.read_text(encoding="utf-8")}
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Unable to read the saved OpenAPI document") from exc


@app.delete("/api/model")
async def clear_model() -> dict[str, bool]:
    app.state.api_model = None
    SPEC_PATH.unlink(missing_ok=True)
    return {"cleared": True}


@app.post("/api/target/check")
async def check_target(request: TargetCheckRequest) -> dict:
    headers: dict[str, str] = {}
    if request.auth:
        if request.auth.type == "bearer":
            headers["Authorization"] = f"Bearer {request.auth.token}"
        else:
            headers[request.auth.header_name] = request.auth.token
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            response = await client.get(str(request.base_url), headers=headers)
        return {
            "reachable": True,
            "status_code": response.status_code,
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "message": "Target responded. A 4xx or 5xx response can still confirm network connectivity.",
        }
    except httpx.HTTPError as exc:
        return {
            "reachable": False,
            "status_code": None,
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "message": str(exc),
        }


@app.post("/api/mcp-test")
async def test_mcp_connection(request: McpConnectionRequest) -> dict:
    api_model = getattr(app.state, "api_model", None)
    if api_model is None:
        raise HTTPException(status_code=409, detail="Import an API contract before testing MCP")
    model_bytes = api_model.model_dump_json().encode("utf-8")
    encoded = base64.urlsafe_b64encode(model_bytes).decode("ascii")
    args = ["-m", "plumbline.mcp_server", "--base-url", str(request.base_url)]
    for index in range(0, len(encoded), 60_000):
        args.extend(["--model-base64", encoded[index:index + 60_000]])
    env = {"PATH": os.environ.get("PATH", "")}
    backend_path = str(PROJECT_DIR / "backend")
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [backend_path, env.get("PYTHONPATH", "")]))
    if request.auth:
        env["PLUMBLINE_TOKEN"] = request.auth.token
        args.extend(["--token-env", "PLUMBLINE_TOKEN"])
    if request.allow_mutations:
        args.append("--allow-mutations")
    params = StdioServerParameters(command=sys.executable, args=args, cwd=str(PROJECT_DIR), env=env)
    try:
        async with stdio_client(params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await asyncio.wait_for(session.initialize(), timeout=12)
                result = await asyncio.wait_for(session.list_tools(), timeout=12)
                tools = [{"name": tool.name, "description": tool.description or ""} for tool in result.tools]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"MCP server did not start cleanly: {exc}") from exc
    mutation_methods = {"POST", "PUT", "PATCH", "DELETE"}
    mutation_count = sum(
        item["description"].split(" ", 1)[0].upper() in mutation_methods
        for item in tools
    )
    return {
        "connected": True,
        "tool_count": len(tools),
        "read_only_count": len(tools) - mutation_count,
        "mutation_count": mutation_count,
        "tools": tools,
    }


@app.get("/api/mcp-config")
async def get_mcp_config(spec_path: str, base_url: AnyHttpUrl) -> dict:
    """Return a stdio MCP server configuration for an explicit target."""
    project_path = Path(__file__).resolve().parents[2]
    local_uv = project_path / ".venv" / "bin" / "uv"
    uv_command = shutil.which("uv") or (str(local_uv) if local_uv.is_file() else "uv")
    config = {
        "mcpServers": {
            "plumbline": {
                "command": uv_command,
                "args": [
                    "run",
                    "--project",
                    str(project_path),
                    "python",
                    "-m",
                    "plumbline.mcp_server",
                    "--spec",
                    str(Path(spec_path).expanduser().resolve()),
                    "--base-url",
                    str(base_url),
                ],
            }
        }
    }
    return config


@app.post("/api/explorer/request")
async def send_explorer_request(request: ExplorerRequest) -> dict:
    api_model = getattr(app.state, "api_model", None)
    if api_model is None:
        raise HTTPException(status_code=409, detail="Import an API contract before exploring operations")
    operation = next((item for item in api_model.operations if item.id == request.operation_id), None)
    if operation is None:
        raise HTTPException(status_code=404, detail="Operation not found in the imported contract")

    path = operation.path
    query: list[tuple[str, Any]] = []
    headers: dict[str, str] = {}
    for parameter in operation.parameters:
        name = parameter.get("name")
        location = parameter.get("in")
        if name not in request.parameters:
            continue
        value = request.parameters[name]
        if location == "path":
            path = path.replace("{" + name + "}", quote(str(value), safe=""))
        elif location == "query":
            if isinstance(value, list):
                query.extend((name, item) for item in value)
            else:
                query.append((name, value))
        elif location == "header":
            headers[name] = str(value)
    if "{" in path or "}" in path:
        raise HTTPException(status_code=422, detail="A required path parameter is missing")

    if request.auth is not None:
        for scheme_name in operation.security:
            scheme = api_model.security_schemes.get(scheme_name, {})
            if scheme.get("type") == "http" and scheme.get("scheme", "").lower() == "bearer":
                headers["Authorization"] = f"Bearer {request.auth.token}"
            elif scheme.get("type") == "apiKey" and scheme.get("in") == "header":
                headers[scheme.get("name") or request.auth.header_name] = request.auth.token
            elif scheme.get("type") == "apiKey" and scheme.get("in") == "query":
                query.append((scheme.get("name", "api_key"), request.auth.token))

    request_kwargs: dict[str, Any] = {"params": query, "headers": headers}
    if operation.request_schema is not None and request.body is not None:
        request_kwargs["json"] = request.body
    target_url = f"{str(request.base_url).rstrip('/')}/{path.lstrip('/')}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(operation.method, target_url, **request_kwargs)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Request failed: {exc}") from exc
    return {
        "status": response.status_code,
        "url": str(response.url),
        "headers": dict(response.headers),
        "body": response.text,
    }


async def _execute_run(run_id: str, config: RunConfig) -> None:
    record = app.state.runs[run_id]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            report = await run_checks(run_id, record["api_model"], config, client)
    except Exception as exc:
        report = RunReport(
            run_id=run_id,
            started_at=record["started_at"],
            base_url=str(config.base_url),
            config={},
            findings=[Finding(
                id="runner:error", check="runner", severity="info", status="inconclusive",
                expected="checks complete", observed=f"Runner error: {exc}",
            )],
            summary={"pass": 0, "fail": 0, "inconclusive": 1},
        )
    record["report"] = report
    report.config["contract_fingerprint"] = sha256(
        record["api_model"].model_dump_json().encode("utf-8")
    ).hexdigest()
    record["status"] = "completed"
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    (RUNS_DIR / f"{run_id}.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    (RUNS_DIR / f"{run_id}.model.json").write_text(record["api_model"].model_dump_json(indent=2) + "\n", encoding="utf-8")


@app.post("/api/runs", status_code=202)
async def start_run(config: RunConfig) -> dict[str, str]:
    api_model = getattr(app.state, "api_model", None)
    if api_model is None:
        raise HTTPException(status_code=409, detail="Import an API contract before starting a run")
    scoped_model = api_model
    if config.operation_ids is not None:
        selected_ids = set(config.operation_ids)
        if not selected_ids:
            raise HTTPException(status_code=422, detail="Select at least one operation for a scoped run")
        known_ids = {operation.id for operation in api_model.operations}
        unknown_ids = selected_ids - known_ids
        if unknown_ids:
            raise HTTPException(status_code=422, detail=f"Unknown operation id(s): {', '.join(sorted(unknown_ids))}")
        scoped_model = api_model.model_copy(update={
            "operations": [operation for operation in api_model.operations if operation.id in selected_ids],
        })
    run_id = uuid4().hex
    if not hasattr(app.state, "runs"):
        app.state.runs = {}
    if not hasattr(app.state, "run_tasks"):
        app.state.run_tasks = {}
    app.state.runs[run_id] = {
        "status": "running",
        "started_at": datetime.now(timezone.utc),
        "api_model": scoped_model,
        "report": None,
    }
    task = asyncio.create_task(_execute_run(run_id, config))
    app.state.run_tasks[run_id] = task
    task.add_done_callback(lambda _: app.state.run_tasks.pop(run_id, None))
    return {"run_id": run_id, "status": "running"}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    record = getattr(app.state, "runs", {}).get(run_id)
    report = record["report"] if record else _saved_report(run_id)
    if record is None and report is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "run_id": run_id,
        "status": record["status"] if record else "completed",
        "summary": report.summary if report else None,
    }


@app.get("/api/runs")
async def list_runs() -> list[dict]:
    records: dict[str, dict] = {}
    for run_id, record in getattr(app.state, "runs", {}).items():
        report = record["report"]
        records[run_id] = {
            "run_id": run_id,
            "status": record["status"],
            "started_at": report.started_at.isoformat() if report else record["started_at"].isoformat(),
            "base_url": report.base_url if report else "",
            "summary": report.summary if report else {},
        }
    if RUNS_DIR.is_dir():
        for path in RUNS_DIR.glob("*.json"):
            if path.name.endswith(".model.json"):
                continue
            run_id = path.stem
            if run_id in records:
                continue
            report = _saved_report(run_id)
            if report is None:
                continue
            records[run_id] = {
                "run_id": run_id,
                "status": "completed",
                "started_at": report.started_at.isoformat(),
                "base_url": report.base_url,
                "summary": report.summary,
            }
    return sorted(records.values(), key=lambda item: item["started_at"], reverse=True)


@app.get("/api/runs/{run_id}/report.json", response_model=RunReport)
async def get_json_report(run_id: str) -> RunReport:
    record = getattr(app.state, "runs", {}).get(run_id)
    report = record["report"] if record else _saved_report(run_id)
    if report is None and record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if report is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return report


@app.get("/api/runs/{run_id}/summary")
async def get_run_summary(run_id: str) -> dict:
    record = getattr(app.state, "runs", {}).get(run_id)
    report = record["report"] if record else _saved_report(run_id)
    if record is None and report is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if report is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return build_run_summary(report, record["api_model"] if record else _saved_model(run_id))


@app.get("/api/runs/{run_id}/model", response_model=ApiModel)
async def get_run_model(run_id: str) -> ApiModel:
    record = getattr(app.state, "runs", {}).get(run_id)
    model = record["api_model"] if record else _saved_model(run_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Run API snapshot is not available")
    return model


@app.get("/api/runs/{run_id}/report.html", response_class=HTMLResponse)
async def get_html_report(run_id: str) -> HTMLResponse:
    record = getattr(app.state, "runs", {}).get(run_id)
    report = record["report"] if record else _saved_report(run_id)
    if record is None and report is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if report is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return HTMLResponse(render_html(report, record["api_model"] if record else _saved_model(run_id)))
