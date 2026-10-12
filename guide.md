# Name: **Plumbline**

A plumb line checks whether a wall is true to the vertical. Plumbline checks whether an API is true to its contract. Alternates: Covenant, Proofline, Tally.

## Honest scope notes

- **24 hours is tight.** Build one vertical slice (import, MCP, tests, report), not four half-features.
- **Don't generate MCP server code.** Run a generic MCP server that reads the spec at startup and registers tools dynamically. Far less work, same demo.
- **Use the low-level `mcp.server.Server`**, not FastMCP decorators. You need to register tools with schemas computed at runtime.
- **Frontend is 3 screens max.** The backend and report carry the product.
- **AI investigator is cut.** Not in the plan.
- **RBAC and rate limit tests need explicit config** (roles, tokens, expected limit). The spec alone can't define them. Without config, report "inconclusive", never "vulnerable".

## Agent rules (put in `AGENTS.md`)

```
1. Build in the phase order below. Do not start a phase until the previous one's acceptance checks pass.
2. After each phase: run pytest, fix failures, commit.
3. No features outside this plan. No database, no Docker, no auth system for Plumbline itself.
4. One shared Pydantic model (ApiModel) is used by explorer, MCP server and test runner. No duplicate endpoint definitions.
5. Findings come only from real HTTP responses. If a request fails to connect or lacks credentials, status = "inconclusive".
6. Safety: state-changing tests (POST/PUT/PATCH/DELETE) are off by default and enabled by a flag. Concurrency capped at 20 requests. Rate-limit probe capped at 50 requests. Base URL must be explicitly provided by the user.
7. Keep code simple. No abstract factories, no plugin systems.
8. Never use em dashes in docs or README text.
```

## Repo layout

```
plumbline/
  pyproject.toml          # uv
  AGENTS.md
  README.md
  backend/plumbline/
    main.py               # FastAPI app
    models.py             # ApiModel, Operation, Finding, RunReport
    parser.py             # load + validate + normalize
    runner.py             # test execution
    checks/               # one file per check
      conformance.py
      auth.py
      validation.py
      errors.py
      ratelimit.py
      concurrency.py
    report.py             # JSON + Jinja2 HTML
    templates/report.html
    mcp_server.py         # dynamic MCP server (separate process)
  demo_api/main.py        # FastAPI with seeded defects + openapi.json
  tests/
  frontend/               # Vite React TS Tailwind
  .github/workflows/ci.yml
```

## Core models (`models.py`)

```
Operation: id, method, path, summary, parameters[], request_schema|None,
           responses{status: schema|None}, security[] (scheme names)
ApiModel:  title, version, servers[], security_schemes{}, operations[]
Finding:   id, check, severity (info|low|medium|high), status (pass|fail|inconclusive),
           operation_id, expected, observed, request{method,url,headers(redacted),body},
           response{status,headers,body_snippet,elapsed_ms}
RunReport: run_id, started_at, base_url, config, findings[], summary{counts}
```

Redact `Authorization` and API key headers in stored evidence.

## Phase 1: Contract compiler (hours 0 to 4)

**Tasks**
1. Scaffold with `uv init`, add deps: fastapi, uvicorn, prance, openapi-spec-validator, httpx, jsonschema, jinja2, pydantic, mcp, pytest, pytest-asyncio.
2. `parser.py`: accept JSON/YAML text. Resolve `$ref` with prance (`ResolvingParser`). Validate with openapi-spec-validator. Normalize into `ApiModel`. Return readable validation errors (path + message).
3. Endpoints: `POST /api/import` (body: spec text or URL), `GET /api/model`.
4. Build `demo_api/` now (see demo section) and save its `openapi.json`.

**Acceptance**
- Importing the demo spec returns all operations with parameters, schemas and security.
- Invalid spec returns a 422 with human-readable errors.
- Unit tests cover both.

## Phase 2: Test runner and checks (hours 4 to 12)

**Run config** (request body of `POST /api/runs`):
```
base_url, auth: {type: bearer|apikey, token, header_name},
roles: [{name, token, allowed_operation_ids[]}]   # optional
allow_mutations: false, rate_limit: {operation_id, expected_limit, window_s} # optional
```

**Checks (each takes ApiModel + config + httpx.AsyncClient, returns Finding[])**

| Check | Logic |
|---|---|
| conformance | Call each safe operation with generated valid inputs. Validate status is documented and body matches response schema (jsonschema). |
| auth | For each operation with `security`, call with no credential and with a garbage token. Expect 401/403. Fail if 2xx. |
| validation | For operations with request bodies: omit a required field, send wrong type, send oversized string. Expect 4xx. Fail on 2xx or 5xx. Only if `allow_mutations`, except safe query params. |
| errors | Scan error bodies for stack traces, file paths, SQL fragments. Fail if present. |
| rbac | Only if `roles` configured. Each role calls each operation. Fail if a role gets 2xx outside its allowed list. Otherwise one `inconclusive` finding. |
| ratelimit | Only if configured. Send up to `expected_limit + 5` requests, capped at 50. Fail if no 429. Otherwise inconclusive. |
| concurrency | Fire 20 parallel identical requests at a chosen safe operation. Record status distribution and latency. Flag 5xx or inconsistent bodies. |

**Input generator:** small function that builds a valid sample from a JSON schema (use `example`, `default`, `enum`, then type defaults). Keep it under 80 lines.

**Endpoints:** `POST /api/runs` (runs async, returns run_id), `GET /api/runs/{id}`, `GET /api/runs/{id}/report.json`, `GET /api/runs/{id}/report.html`. Store runs in memory plus write JSON to `./runs/`.

**Acceptance**
- Against the demo API, every seeded defect produces a `fail` finding, and the clean endpoints produce `pass`.
- Unreachable base URL gives `inconclusive`, never `fail`.
- pytest covers each check with `httpx.ASGITransport` against the demo app.

## Phase 3: MCP server (hours 12 to 16)

`mcp_server.py`, run as `uv run python -m plumbline.mcp_server --spec path --base-url URL [--token T] [--allow-mutations]`

1. Parse spec with the same `parser.py`.
2. `list_tools`: one Tool per operation. Name = operationId (sanitized). `inputSchema` = merged object of path/query/header params plus `body`.
3. `call_tool`: validate args with jsonschema, build the URL, call via HTTPX, return status, headers and body as text.
4. Block non-GET tools unless `--allow-mutations`.
5. Add `GET /api/mcp-config` that returns a ready-to-paste config JSON snippet for Claude Desktop / Cursor.

**Acceptance**
- Test using the MCP SDK client over stdio: lists tools, calls `list_items` on the demo API, gets real data.
- Invalid args return a validation error, not a crash.

## Phase 4: Frontend (hours 16 to 20)

Three screens, compact "engineering workbench" look, dark theme, monospace for paths.

1. **Import:** paste or upload spec, show validation result.
2. **Explorer:** operation list grouped by tag, method badges, a panel to fill params, set auth, send, and view the response. Plus the MCP config snippet with a copy button.
3. **Runs:** config form (base URL, token, roles optional, mutation toggle), Run button, findings table (severity, status, endpoint, check), click a row for expected vs observed and the request/response evidence. Links to download JSON and HTML reports.

Use plain `fetch`, no state library, Vite proxy to the backend.

**Acceptance:** full demo flow works in a browser with no console errors.

## Phase 5: Report, CI, docs (hours 20 to 24)

1. Jinja2 HTML report: summary counts, findings grouped by severity, collapsible evidence, a "how to reproduce" curl per finding.
2. GitHub Actions: `uv sync`, `pytest`, frontend `npm ci && npm run build`.
3. README: what it does, quickstart, MCP config, safety rules, and a limitations section (RBAC and rate limits need config, no deep fuzzing, not a penetration testing tool).
4. Record a 2 minute demo following the script below. Tag `v0.1.0`.

## Demo API seeded defects (`demo_api/`)

Roles: `admin`, `user`, `viewer` with static tokens.

| Endpoint | Seeded defect |
|---|---|
| `GET /items` | Clean. Control case (should pass everything). |
| `GET /items/{id}` | Returns `price` as a string where spec says number (conformance fail). |
| `GET /admin/users` | Accepts missing token (auth fail). |
| `POST /items` | Accepts missing required field and returns 500 on wrong type (validation fail). |
| `DELETE /items/{id}` | `viewer` role allowed (rbac fail). |
| `GET /debug/crash` | Returns a stack trace in the error body (errors fail). |
| `GET /search` | Documented 429 but no limiter implemented (ratelimit fail). |
| `POST /orders/redeem` | Race condition: duplicate redemption under concurrency (concurrency fail). |

Keep the app under 200 lines.

## Demo script

1. Import demo spec, show the operations.
2. Call `list_items` through an MCP client.
3. Run the suite with roles configured.
4. Open the report: one clean pass, then the missing-auth, validation 500 and RBAC findings with evidence.
5. Show one `inconclusive` result to prove it does not overclaim.

## Cut order if time runs short

1. Concurrency check
2. Rate-limit check
3. RBAC check
4. Explorer panel (keep import and runs screens)

Never cut: import, MCP server, conformance and auth checks, report.
