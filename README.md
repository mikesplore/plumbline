# Plumbline

Plumbline checks whether an API matches its OpenAPI contract. Phase 1 provides
an OpenAPI importer, a normalized API model, and a demo API with seeded defects.

## Development

```sh
uv sync
uv run uvicorn plumbline.main:app --app-dir backend --reload
uv run pytest
```

The demo API runs separately with:

```sh
uv run uvicorn demo_api.main:app --port 8001 --reload
```

Import OpenAPI JSON or YAML with `POST /api/import`, passing either
`{"spec":"..."}` or `{"url":"https://..."}`. Read the normalized model at
`GET /api/model`.
