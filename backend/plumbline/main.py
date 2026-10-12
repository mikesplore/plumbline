"""Plumbline contract import API."""

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import AnyHttpUrl, BaseModel, model_validator

from plumbline.models import ApiModel
from plumbline.parser import SpecValidationError, parse_openapi

app = FastAPI(title="Plumbline", version="0.1.0")


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
