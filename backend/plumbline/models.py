"""Shared API contract and test report models."""

from datetime import datetime
from typing import Any, Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field


class Operation(BaseModel):
    id: str
    method: str
    path: str
    summary: str = ""
    parameters: list[dict] = Field(default_factory=list)
    request_schema: dict | None = None
    responses: dict[str, dict | None] = Field(default_factory=dict)
    security: list[str] = Field(default_factory=list)


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    version: str
    servers: list[str] = Field(default_factory=list)
    security_schemes: dict[str, dict] = Field(default_factory=dict)
    operations: list[Operation] = Field(default_factory=list)


class RequestEvidence(BaseModel):
    method: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    body: Any = None


class ResponseEvidence(BaseModel):
    status: int | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    body_snippet: str = ""
    elapsed_ms: float | None = None


class Finding(BaseModel):
    id: str
    check: str
    severity: Literal["info", "low", "medium", "high"]
    status: Literal["pass", "fail", "inconclusive"]
    operation_id: str | None = None
    expected: str = ""
    observed: str = ""
    request: RequestEvidence | None = None
    response: ResponseEvidence | None = None


class RunReport(BaseModel):
    run_id: str
    started_at: datetime
    base_url: str
    config: dict = Field(default_factory=dict)
    findings: list[Finding] = Field(default_factory=list)
    summary: dict[str, int] = Field(default_factory=dict)


class AuthConfig(BaseModel):
    type: Literal["bearer", "apikey"]
    token: str
    header_name: str = "X-API-Key"


class RoleConfig(BaseModel):
    name: str
    token: str
    allowed_operation_ids: list[str] = Field(default_factory=list)


class RateLimitConfig(BaseModel):
    operation_id: str
    expected_limit: int = Field(ge=1)
    window_s: float = Field(ge=0)


class RunConfig(BaseModel):
    base_url: AnyHttpUrl
    auth: AuthConfig | None = None
    roles: list[RoleConfig] = Field(default_factory=list)
    allow_mutations: bool = False
    rate_limit: RateLimitConfig | None = None
