# Claude Code

Claude Code is the first orchestrator. It is also a planned worker harness: phase 3 adds a Claude Code adapter, which also checks that the adapter interface isn't Codex-specific. Facts below were verified with Claude Code 2.1.326 unless marked otherwise.

## As orchestrator

- **MCP tool calls can block for a long time.** With default settings, a tool call that slept 330s and one that slept 660s both succeeded. The limit can be set per server or through `MCP_TOOL_TIMEOUT`. The binary's help text says it is a hard wall-clock limit and that progress notifications do not extend it. The server caps `wait` at 600s.
- **End-to-end run (verified):** `claude -p --model haiku --mcp-config <file> --strict-mcp-config` dispatched a Codex job through the stdio server and waited for it in 4 turns, costing $0.0036 to $0.0053.
- **Skills in headless mode (verified, 2026-11-20):** `claude -p "/dispatch <task>"` invokes a project skill from `.claude/skills/` (a symlink works) even with `disable-model-invocation: true`. With `--output-format json`, `modelUsage` gives per-model output, cache-read and cache-write tokens and `costUSD`.
- **Registering the server:**

  ```sh
  claude mcp add agent-dispatch -- "$(mise which node)" "$PWD/src/main.ts" serve
  ```

## As a future worker

| Need | Flag (present in 2.1.326 `--help`) |
| --- | --- |
| Headless run | `-p` |
| Structured events | `--output-format stream-json --verbose` (`json` for a single result) |
| Model and effort | `--model <model>`, `--effort <level>` |
| Unattended permissions | `--permission-mode <mode>`, `--permission-prompts none` (prompts are denied automatically) |
| Typed final output | `--json-schema <schema>` |
| Resume | `--resume <session-id>` |
| Background lifecycle | `--bg` / `--background`; `claude agents` lists background sessions |
| MCP isolation | `--mcp-config`, `--strict-mcp-config` (one way to keep this server out of a worker) |

**Reported, not checked locally:**

- The JSON result carries `session_id`, `duration_ms`, `num_turns`, `is_error` and `total_cost_usd`.
- `--max-budget-usd` caps spend.
- `--bare` skips automatic context and config discovery, and does not use subscription login.

### Adapter notes

- **Final message:** Claude reports it in the final `result` event, not in a file. The adapter must write it to `last-message.md` itself.
- **Usage:** prefer the result event's totals and `total_cost_usd`. Mark usage `partial` for cancelled runs.
- **Recursion guard:** `--strict-mcp-config` with an explicit config that omits this server is the equivalent of Codex's per-server disable. It also drops the user's other MCP servers, which needs a decision.
- **Sandbox:** Claude uses permission modes and allowed tools, not Codex's sandbox names. The shared `sandbox` field needs a mapping.

## Instrumentation surfaces (reported)

| Surface | Use |
| --- | --- |
| Headless CLI / Agent SDK output | Authoritative per-run record: lifecycle, events, session ID, cost when present |
| Hooks | Policy enforcement and tool-level evidence; run in the worker environment |
| OpenTelemetry export | Aggregate monitoring across sessions; may include prompt data |
| LLM gateway / billing | Independent accounting; not the same as Claude Code's reported cost |

References: [headless mode](https://code.claude.com/docs/en/headless), [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks), [monitoring](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage).
