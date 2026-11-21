# agent-dispatch-mcp

A local MCP server that lets an orchestrating agent (e.g. Claude Code) dispatch bounded tasks to worker agents in another harness (currently Codex CLI) and get back a compact result: the worker's final message, token usage, and paths to the full logs.

Each worker runs under a small detached supervisor, so jobs survive the orchestrator session that started them.

Design, verified harness behavior, research and open questions are in [docs/](docs/README.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `dispatch` | Start a worker (`harness`, `model`, `effort`, `sandbox`, `cwd`, `prompt`, `label`, `timeout_s`). Returns a `job_id` immediately. |
| `wait` | Block until `any` or `all` of the given jobs finish, or `timeout_s` passes (capped at 600s). Returns results of finished jobs and the state of pending ones. |
| `cancel` | Stop a job and its whole process tree; returns once termination is confirmed. |
| `list` | Recent jobs, newest first, to recover `job_id`s in a new session. |

A finished job's result is `{job_id, state, final_message, usage, elapsed_s, dir}`, plus `failure_reason` and `exit_code` when relevant. It never includes the worker's raw transcript. The final message is capped (4000 characters by default). Usage reports its source: `reported` by the harness, `partial` (e.g. a cancelled run), or `unknown`; values are never estimated.

A worker cannot dispatch further jobs. Before each run, the server asks Codex for its effective MCP servers (`codex mcp list --json`, including project config) and disables any that point at this server. If that list is unavailable, the job fails instead of running unguarded.

## Requirements

- Node 26.13.1 or later (pinned in `mise.toml`) and pnpm (pinned in `package.json`).
- An installed and authenticated `codex` CLI.

## Setup

```sh
pnpm install
claude mcp add agent-dispatch -- "$(mise which node)" "$PWD/src/main.ts" serve
```

TypeScript runs directly through Node's type stripping, so there is no build step.

### Dispatch skill

[`skills/dispatch/`](skills/dispatch/SKILL.md) teaches an orchestrator when and how to delegate through this server: briefs, the worker contract, role sandboxes, worktrees for edits, review and recovery. To install it for Claude Code, symlink it into your skills directory, then invoke it with `/dispatch`:

```sh
ln -s "$PWD/skills/dispatch" ~/.claude/skills/dispatch
```

Workers read `skills/dispatch/references/worker-contract.md` by absolute path, so keep the symlink pointing at this checkout. The skill is not needed in the worker's harness.

## Configuration

Environment variables, all optional:

| Variable | Default |
| --- | --- |
| `AGENT_DISPATCH_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/agent-dispatch` |
| `AGENT_DISPATCH_FINAL_MESSAGE_CAP` | `4000` characters |
| `AGENT_DISPATCH_MAX_WAIT_SECONDS` | `600` |
| `AGENT_DISPATCH_RETENTION_DAYS` | `14` (finished jobs are pruned on server start; `0` disables pruning) |
| `AGENT_DISPATCH_CANCEL_GRACE_SECONDS` | `10` |
| `AGENT_DISPATCH_CODEX_BIN` | `codex` |
| `AGENT_DISPATCH_SERVER_NAMES` | `agent-dispatch` (server names disabled for workers, in addition to any server launched from this package) |

Each job lives in `<state dir>/jobs/<YYYYMMDDTHHMMSSZ>-<label>-<hex>/` (UTC, owner-only permissions) with `meta.json`, `prompt.md`, `final-message.md`, `stderr.log` and `supervisor.log`. The full worker transcript is the harness's own session log, whose path `meta.json` records as `sessionLog`.

## Development

```sh
pnpm test         # unit and integration tests with a fake codex
pnpm test:live    # real codex runs; consumes quota
pnpm typecheck && pnpm lint && pnpm format:check
```
