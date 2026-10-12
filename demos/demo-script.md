# Two-minute demo

The recording at `demos/plumbline-demo-v0.1.0.mp4` follows this walkthrough.

| Time | Scene |
| --- | --- |
| 0:00 | Introduce the Plumbline workbench. |
| 0:05 | Import the seeded OpenAPI contract and show its operations. |
| 0:15 | Set the local demo base URL and call `GET /items`. |
| 0:26 | Call `GET /items/{id}` and compare the response with the contract. |
| 0:38 | Show the generated MCP configuration and the stdio client result for `list_items`. |
| 0:50 | Configure test credentials and a viewer role. Enable state-changing probes for the local demo API. |
| 1:02 | Run checks and inspect pass, failure, and inconclusive results with HTTP evidence. |
| 1:55 | Open the HTML report and show its summary and severity groups. |

The demo uses a local target with seeded defects. Its run reports 22 passes, 12 failures, and 4 inconclusive findings.
