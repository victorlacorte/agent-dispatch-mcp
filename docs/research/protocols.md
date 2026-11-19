# Protocols

Assessed 2026-11-17. There are two separate interface choices: how the orchestrator talks to this server, and how the server drives each worker harness.

## Current choice

- **Orchestrator side:** plain MCP tools (`dispatch`, `wait`, `cancel`, `list`) with our own durable job IDs. The state names follow MCP Tasks and A2A, so a later switch is mechanical.
- **Worker side:** one adapter per harness, each using that harness's own headless CLI (`codex exec --json` now, `claude -p --output-format stream-json` next), behind the internal adapter interface.

## Assessment

| Protocol | What it standardizes | Status | Fit |
| --- | --- | --- | --- |
| MCP Tasks (extension `io.modelcontextprotocol/tasks`) | `tools/call` returns a task handle; `tasks/get`, `tasks/update`, `tasks/cancel`; states `working`, `input_required`, `completed`, `failed`, `cancelled` | Opt-in extension; support in Claude Code, Codex, Cursor and Gemini CLI unverified | The natural orchestrator-side upgrade once clients support it |
| MCP progress / elicitation | Progress notifications; asking the user for input | Core spec | Progress does not extend Claude Code's tool timeout. Elicitation could later relay worker questions. |
| ACP (Agent Client Protocol, Zed) | Client-to-agent JSON-RPC over stdio: sessions, prompts, cancel, load, permission requests, config, `usage_update` | v1 stable, v2 draft; 51 agents listed | The best "one client, many workers" candidate, but Claude Code and Codex speak it through adapters (`claude-agent-acp`, `codex-acp`), so harness-specific logic does not go away |
| A2A (Linux Foundation, v1.0.0) | Agent cards, tasks, messages, artifacts; JSON-RPC, gRPC, HTTP | Stable | Built for network services, not local coding CLIs. A useful reference for task-state names. |
| IBM ACP (Agent Communication Protocol) | REST agent messaging | Merged into A2A (Aug 2025), archived | Do not adopt |
| Coder AgentAPI | HTTP wrapper that drives terminal agents | Deprecated and archived | Do not adopt (screen-scraping) |
| Codex `app-server` | Codex's JSON-RPC control protocol: threads, turns, approvals | Experimental in parts | The upgrade path if `codex exec` proves too limited, e.g. for answering permission requests mid-run |

## Revisit when

- **Adopt MCP Tasks** once the orchestrator client (Claude Code) confirms Tasks support.
- **Add an ACP worker adapter** once both `claude-agent-acp` and `codex-acp` expose model and effort configuration, `usage_update` and session load, and we need more harnesses than Codex and Claude Code.
- **Consider A2A** only for a remote worker that runs as a network service.

## Sources

- [MCP Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview), [spec repository](https://github.com/modelcontextprotocol/ext-tasks), [client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
- [ACP](https://agentclientprotocol.com/), [agents list](https://agentclientprotocol.com/get-started/agents.md), [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Coder AgentAPI](https://github.com/coder/agentapi)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
