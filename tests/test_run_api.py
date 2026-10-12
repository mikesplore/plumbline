import json
import time
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from demo_api.main import app as demo_app
from plumbline import main
from plumbline.models import RunReport
from plumbline.parser import parse_openapi


def test_run_status_json_and_html_report_endpoints(monkeypatch, tmp_path):
    main.app.state.api_model = parse_openapi(json.dumps(demo_app.openapi()))
    main.app.state.runs = {}

    async def fake_run_checks(run_id, api_model, config, client):
        return RunReport(
            run_id=run_id,
            started_at=datetime.now(timezone.utc),
            base_url=str(config.base_url),
            config={"allow_mutations": False},
            summary={"pass": 1, "fail": 0, "inconclusive": 0},
        )

    monkeypatch.setattr(main, "run_checks", fake_run_checks)
    monkeypatch.setattr(main, "RUNS_DIR", tmp_path)
    with TestClient(main.app) as client:
        created = client.post("/api/runs", json={"base_url": "http://127.0.0.1:8001"})
        assert created.status_code == 202
        run_id = created.json()["run_id"]

        for _ in range(50):
            status = client.get(f"/api/runs/{run_id}")
            if status.json()["status"] == "completed":
                break
            time.sleep(0.01)

        assert status.json()["summary"] == {"pass": 1, "fail": 0, "inconclusive": 0}
        report = client.get(f"/api/runs/{run_id}/report.json")
        summary = client.get(f"/api/runs/{run_id}/summary")
        html = client.get(f"/api/runs/{run_id}/report.html")

    assert report.status_code == 200
    assert report.json()["run_id"] == run_id
    assert summary.status_code == 200
    assert summary.json()["counts"] == {"fail": 0, "inconclusive": 0, "pass": 1}
    assert summary.json()["verdict"].startswith("0 failed, 0 inconclusive, 1 passed across ")
    assert html.status_code == 200
    assert "Run analysis" in html.text
    assert (tmp_path / f"{run_id}.json").exists()
