1. Build in the phase order below. Do not start a phase until the previous one's acceptance checks pass.
2. After each phase: run pytest, fix failures, commit.
3. No features outside this plan. No database, no Docker, no auth system for Plumbline itself.
4. One shared Pydantic model (ApiModel) is used by explorer, MCP server and test runner. No duplicate endpoint definitions.
5. Findings come only from real HTTP responses. If a request fails to connect or lacks credentials, status = "inconclusive".
6. Safety: state-changing tests (POST/PUT/PATCH/DELETE) are off by default and enabled by a flag. Concurrency capped at 20 requests. Rate-limit probe capped at 50 requests. Base URL must be explicitly provided by the user.
7. Keep code simple. No abstract factories, no plugin systems.
8. Never use em dashes in docs or README text.
