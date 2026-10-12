"""Plumbline contract import and test-run APIs."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import AnyHttpUrl, BaseModel, model_validator

from plumbline.models import ApiModel, Finding, RunConfig, RunReport
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


@app.get("/api/runs/{run_id}/report.html", response_class=HTMLResponse)
async def get_html_report(run_id: str) -> HTMLResponse:
    record = getattr(app.state, "runs", {}).get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if record["report"] is None:
        raise HTTPException(status_code=409, detail="Run is not complete")
    return HTMLResponse(render_html(record["report"]))
