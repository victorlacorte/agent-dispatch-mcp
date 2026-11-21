# Roadmap

## Phases

| Phase | Status | Contents |
| --- | --- | --- |
| 0. Smoke test | Done 2026-11-17 | Manual `codex exec` runs and a Claude Code MCP timeout test. Findings are in [harnesses/codex.md](harnesses/codex.md) and [harnesses/claude-code.md](harnesses/claude-code.md). |
| 1. MCP server with a Codex worker | Done 2026-11-18 | `dispatch`, `wait`, `cancel`, `list`; detached supervisors; file-based job store; recursion guard. Reviewed by four independent reviewers and fixed. Covered by 96 tests with a fake Codex, 2 opt-in live tests, and an end-to-end run with Claude Code as orchestrator. |
| 2. Dispatch skill | Done 2026-11-20 | [`skills/dispatch/`](../skills/dispatch/SKILL.md), kept separate from the user's single-harness orchestrate skill so each can evolve on its own; shared parts can be extracted later. It covers when to dispatch, the brief and worker contract, role-to-sandbox mapping, default harness, model and effort per role, worktree setup for implementers, reviewing results, integration and recovery. Trialed end to end with headless Claude Code (Opus 5.5) orchestrating Codex workers on a lookup, a typecheck and a worktree edit; on a tiny repo the orchestrator correctly declined to delegate the lookup. |
| 3. Claude Code worker adapter | Planned | Proves the adapter interface is not Codex-specific, and lets other orchestrators use Claude workers. |
| 4. Benchmark and evolve | Planned | Paired runs per [benchmarking.md](benchmarking.md). Then consider resume (`codex exec resume`), `--output-schema`, Codex `app-server`, MCP Tasks and ACP (see [research/protocols.md](research/protocols.md)). |

## Decisions so far

- **Stack:** TypeScript run directly by Node (type stripping, no build step), pnpm, Vitest, TypeScript 7 for typechecking, oxlint and oxfmt. Node and pnpm are pinned in `mise.toml` and the `packageManager` field.
- **Workers outlive the orchestrator session.**
- **Worktrees** are created by the orchestrator following the skill, not by the server.
- **Role sandboxes** follow from Codex's write rules ([harnesses/codex.md](harnesses/codex.md#sandbox)): explorers and researchers run `workspace-write` with their attempt directory as `cwd`, so they can write a report but not change the repository; implementers run `workspace-write` in a dedicated worktree and report in their final message.
- **Edit integration:** Codex workers cannot commit, because `.git` is read-only in their sandbox. The implementer leaves its changes uncommitted; the orchestrator reviews the diffstat and report (full diff only when needed), commits on the worktree branch, and integrates.
- **Dispatch skill records:** a task directory with briefs, reports and one review line per report. No journal, because each job's `meta.json` already holds the attempt telemetry.
- **Job state** lives in plain files under `~/.local/state/agent-dispatch/`.
- **Compatibility:** benchmark every relevant harness, model and effort level, instead of fixing one worker pair up front.

## Open questions

- **Recursion guard:** does Codex pass `AGENT_DISPATCH_DEPTH` to the MCP servers it starts? It matters less now that servers pointing at this package are disabled by command.
- **Worker report paths and commits:** should the server let a job write to a report directory outside its `cwd` (e.g. through `sandbox_workspace_write.writable_roots`)? Implementers could then write report files like the other roles. Commits would need something else, since `.git` stayed read-only even as a writable root. The current skill works without either.
- **Claude Code recursion guard:** `--strict-mcp-config` drops the user's other MCP servers. Is that acceptable for workers?
- **Shared sandbox field:** how should `read-only` and `workspace-write` map to Claude Code permission modes?
- **Command runner:** should the server offer a plain "run a command" tool that uses no model, as a baseline for verification tasks?
- **`JobMeta` type:** should it become a union type with one variant per state, so the compiler enforces the per-state invariants, when the second adapter lands?
