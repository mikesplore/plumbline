"""Plumbline contract import and test-run APIs."""

import asyncio
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import AnyHttpUrl, BaseModel, Field, model_validator

from plumbline.analysis import build_run_summary
from plumbline.models import ApiModel, AuthConfig, Finding, RunConfig, RunReport
from plumbline.parser import SpecValidationError, parse_openapi
from plumbline.report import render_html
from plumbline.runner import run_checks

app = FastAPI(title="Plumbline", version="0.1.0")
RUNS_DIR = Path("runs")


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
    app.state.api_model = model
    return model


@app.get("/api/model", response_model=ApiModel)
async def get_model() -> ApiModel:
    model = getattr(app.state, "api_model", None)
    if model is None:
        raise HTTPException(status_code=404, detail="No API model has been imported")
    return model


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
    record["status"] = "completed"
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    (RUNS_DIR / f"{run_id}.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")


@app.post("/api/runs", status_code=202)
async def start_run(config: RunConfig) -> dict[str, str]:
    api_model = getattr(app.state, "api_model", None)
    if api_model is None:
        raise HTTPException(status_code=409, detail="Import an API contract before starting a run")
    run_id = uuid4().hex
    if not hasattr(app.state, "runs"):
        app.state.runs = {}
    if not hasattr(app.state, "run_tasks"):
        app.state.run_tasks = {}
    app.state.runs[run_id] = {
        "status": "running",
        "started_at": datetime.now(timezone.utc),
        "api_model": api_model,
        "report": None,
    }
    task = asyncio.create_task(_execute_run(run_id, config))
    app.state.run_tasks[run_id] = task
    task.add_done_callback(lambda _: app.state.run_tasks.pop(run_id, None))
    return {"run_id": run_id, "status": "running"}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    record = getattr(app.state, "runs", {}).get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "run_id": run_id,
        "status": record["status"],
        "summary": record["report"].summary if record["report"] else None,
    }


@app.get("/api/runs/{run_id}/report.json", response_model=RunReport)
async def get_json_report(run_id: str) -> RunReport:
    record = getattr(app.state, "runs", {}).get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if record["report"] is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return record["report"]


@app.get("/api/runs/{run_id}/summary")
async def get_run_summary(run_id: str) -> dict:
    record = getattr(app.state, "runs", {}).get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if record["report"] is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return build_run_summary(record["report"], record["api_model"])


@app.get("/api/runs/{run_id}/report.html", response_class=HTMLResponse)
async def get_html_report(run_id: str) -> HTMLResponse:
    record = getattr(app.state, "runs", {}).get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if record["report"] is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return HTMLResponse(render_html(record["report"], record["api_model"]))
