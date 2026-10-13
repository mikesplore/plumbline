# Plumbline

Plumbline checks whether an API behaves as its OpenAPI contract describes. Import a contract, explore its operations, run focused checks, and inspect the HTTP evidence behind each result.

Plumbline is a development workbench. It is not a penetration testing tool.

## Requirements

- Python 3.11 or newer
- [uv](https://docs.astral.sh/uv/)
- Node.js 22 or newer and npm

## Quickstart

Install the Python dependencies from the lock file:

```sh
uv sync --locked
```

Start the backend in one terminal:

```sh
uv run uvicorn plumbline.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload
```

Start the seeded demo API in a second terminal:

```sh
uv run uvicorn demo_api.main:app --host 127.0.0.1 --port 8001 --reload
```

Install the frontend dependencies and start the workbench in a third terminal:

```sh
npm ci --prefix frontend
npm run dev --prefix frontend
```

Open <http://127.0.0.1:5173>, choose **Load demo contract**, then enter `http://127.0.0.1:8001` as the target before sending a request or starting a run. Plumbline does not infer the target from the contract's `servers` field.

The demo API includes one clean endpoint and seeded contract and behavior defects. Use the viewer token `viewer-demo-token` when configuring the RBAC check.

## MCP server

The MCP server reads an OpenAPI file at startup and creates one tool for each operation. The target base URL is required explicitly. State-changing tools are disabled unless `--allow-mutations` is passed.

```sh
uv run python -m plumbline.mcp_server \
  --spec demo_api/openapi.json \
  --base-url http://127.0.0.1:8001
```

Use `--token TOKEN` to pass a bearer or header API key credential. In the Explorer, provide the local spec file path and target URL to generate a Claude Desktop or Cursor configuration snippet.

## Checks and reports

Run checks from the Runs screen or submit a `POST /api/runs` request with a JSON body such as:

```json
{
  "base_url": "http://127.0.0.1:8001",
  "auth": {"type": "bearer", "token": "admin-demo-token"},
  "roles": [
    {
      "name": "viewer",
      "token": "viewer-demo-token",
      "allowed_operation_ids": ["list_items", "get_item", "search_items"]
    }
  ],
  "allow_mutations": false
}
```

Completed runs provide JSON and HTML reports. The HTML report groups findings by severity, keeps request and response evidence collapsible, and includes a curl command for findings with request evidence. Authorization and API key headers in runner evidence are redacted.

## CLI and CI

Install the project, then run checks from a terminal or CI job. The command uses the same runner as the Runs screen. Path fixtures can be supplied as JSON or YAML, for example `fixtures.json` containing `{"id":"1"}`. Reports include JSON, HTML, and JUnit XML.

```sh
uv run plumbline run \
  --spec openapi.yaml \
  --base-url https://api.example.test \
  --token-env API_TOKEN \
  --fixtures fixtures.json \
  --fail-on medium \
  --out reports
```

Set `API_TOKEN` in the environment before running the command. The default failure threshold is `low`. Only failed findings at or above the threshold return exit code 1. Usage errors and runs where every attempted request fails to connect return exit code 2. Passing runs return 0.

The composite GitHub Action runs the CLI and uploads the report directory as a workflow artifact. Add it after checking out the repository and make the token available through an environment variable:

```yaml
name: API conformance
on: [push, pull_request]
jobs:
  verify-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          spec: openapi.yaml
          base-url: ${{ vars.API_BASE_URL }}
          token-env: API_TOKEN
          fixtures: ci/fixtures.yaml
          fail-on: medium
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}
```

This repository exposes the action from its root `action.yml`, so use `./.` after checking out the repository. The action uploads `report.json`, `report.html`, and `junit.xml`, then returns the CLI exit code.

## Safety

- Provide a base URL explicitly for every run and Explorer request.
- State-changing test probes are disabled by default. Enable them only for an API where those requests are safe to send.
- Concurrency probes are capped at 20 requests. Rate-limit probes are capped at 50 requests.
- A failed connection or missing credentials produces an inconclusive result. Plumbline reports findings from actual HTTP responses.
- RBAC checks need configured role tokens and allowed operation IDs. Rate-limit checks need an operation, expected limit, and time window.

## Limitations

- RBAC and rate-limit behavior cannot be inferred from an OpenAPI document and needs explicit configuration.
- Checks use small generated examples. Plumbline does not perform deep fuzzing or broad security testing.
- The result is evidence about observed behavior for the selected target, not a guarantee that an API is secure or fully conforms to its contract.
- Plumbline has no authentication system for its own local workbench. Run it in a trusted development environment.

## Development

Run the Python tests and build the frontend:

```sh
uv run pytest
npm run build --prefix frontend
```

GitHub Actions runs the same checks on pushes and pull requests.
