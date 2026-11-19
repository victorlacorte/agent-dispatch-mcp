# agent-dispatch documentation

agent-dispatch lets an orchestrating agent in one harness (e.g. Claude Code on Opus) delegate bounded tasks to workers in another harness (e.g. Codex on a cheaper model). The goal is to **spend fewer frontier-model tokens while keeping delivery quality**. Worker tokens are expected to increase, and that is acceptable.

For setup and configuration, see the [project README](../README.md).

| Document | Contents |
| --- | --- |
| [Architecture](architecture.md) | Components, job lifecycle, ownership rules, recursion guard, and the decisions behind them |
| [Roadmap](roadmap.md) | Phases, current status, and open questions |
| [Benchmarking](benchmarking.md) | How to tell whether delegation actually saves frontier tokens at equal quality |
| [Codex harness](harnesses/codex.md) | Verified behavior of `codex exec` and related commands |
| [Claude Code harness](harnesses/claude-code.md) | Verified facts about Claude Code as orchestrator and as a future worker |
| [Prior art](research/prior-art.md) | How products and open-source projects solve delegation; what we borrowed and avoided |
| [Protocols](research/protocols.md) | MCP Tasks, ACP, A2A and others: what fits, and when to revisit |

## Conventions

- **Verified** means observed on this machine with the stated version (e.g. codex-cli 0.169.1/0.170.0, Claude Code 2.1.326). **Reported** means taken from documentation or third-party research and not checked locally.
- Harness behavior drifts between releases (Codex updated itself mid-project). Re-verify before relying on a detail, and record the version.
