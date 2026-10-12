import json

from fastapi.testclient import TestClient

from demo_api.main import app as demo_app
from plumbline.main import app


client = TestClient(app)


def test_import_demo_openapi_and_get_normalized_model():
    response = client.post("/api/import", json={"spec": json.dumps(demo_app.openapi())})

    assert response.status_code == 200
    model = response.json()
    assert model["title"] == "Plumbline Demo API"
    assert len(model["operations"]) == 8
    by_id = {operation["id"]: operation for operation in model["operations"]}
    assert by_id["get_item"]["parameters"][0]["name"] == "id"
    assert by_id["get_item"]["responses"]["200"]["properties"]["price"]["type"] == "number"
    assert by_id["create_item"]["request_schema"]["required"] == ["name"]
    assert by_id["delete_item"]["security"] == ["BearerAuth"]

    loaded = client.get("/api/model")
    assert loaded.status_code == 200
    assert loaded.json() == model


def test_import_invalid_spec_returns_readable_422():
    response = client.post("/api/import", json={"spec": '{"openapi":"3.0.3","info":{},"paths":{}}'})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, str)
    assert "title" in detail.lower()
