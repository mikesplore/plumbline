import json

import pytest

from plumbline.parser import SpecValidationError, parse_openapi


def test_parse_json_resolves_refs_and_normalizes_operations():
    spec = {
        "openapi": "3.0.3",
        "info": {"title": "Example", "version": "2.0"},
        "servers": [{"url": "https://api.example.test"}],
        "paths": {
            "/items/{item_id}": {
                "parameters": [{"name": "item_id", "in": "path", "required": True, "schema": {"type": "integer"}}],
                "get": {
                    "operationId": "getItem",
                    "responses": {"200": {"description": "OK", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}}}},
                    "security": [{"BearerAuth": []}],
                },
            }
        },
        "components": {
            "securitySchemes": {"BearerAuth": {"type": "http", "scheme": "bearer"}},
            "schemas": {"Item": {"type": "object", "properties": {"price": {"type": "number"}}}},
        },
    }

    model = parse_openapi(json.dumps(spec))

    assert model.title == "Example"
    assert model.version == "2.0"
    assert model.servers == ["https://api.example.test"]
    assert model.security_schemes["BearerAuth"]["scheme"] == "bearer"
    assert model.operations[0].id == "getItem"
    assert model.operations[0].parameters[0]["name"] == "item_id"
    assert model.operations[0].responses["200"]["properties"]["price"]["type"] == "number"
    assert model.operations[0].security == ["BearerAuth"]


def test_parse_yaml():
    text = """
openapi: 3.0.3
info:
  title: YAML API
  version: '1'
paths:
  /health:
    get:
      operationId: health
      responses:
        '200':
          description: OK
"""

    model = parse_openapi(text)

    assert model.title == "YAML API"
    assert model.operations[0].id == "health"


def test_invalid_spec_has_human_readable_location():
    with pytest.raises(SpecValidationError) as exc_info:
        parse_openapi('{"openapi":"3.0.3","info":{},"paths":{}}')

    assert "$" in str(exc_info.value) or "info" in str(exc_info.value)
    assert "title" in str(exc_info.value).lower()
