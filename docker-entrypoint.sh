#!/bin/sh
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

: "${MCP_BASE_URL:?MCP_BASE_URL must identify the API that MCP should call}"

uv run --no-sync uvicorn plumbline.main:app \
  --app-dir backend --host 0.0.0.0 --port 8000 &
backend_pid=$!

uv run --no-sync python -m plumbline.mcp_server \
  --spec "${MCP_SPEC_PATH:-/app/.plumbline/current-openapi.txt}" \
  --base-url "$MCP_BASE_URL" \
  --transport http --host 0.0.0.0 --port 8765 &
mcp_pid=$!

cleanup() {
  kill "$backend_pid" "$mcp_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$mcp_pid" 2>/dev/null; do
  sleep 1
done

exit 1