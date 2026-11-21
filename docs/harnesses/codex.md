# Codex CLI as a worker

Verified on macOS with codex-cli 0.169.1 and 0.170.0 under ChatGPT account auth, 2026-11-17/18, unless marked otherwise. Codex updated itself between those dates and parsing kept working. Still, record `codex --version` per job and re-verify after upgrades.

## Invocation

```sh
codex exec --json -m <model> -c 'model_reasoning_effort="<effort>"' \
  [-c 'mcp_servers={"<name>"={enabled=false}}'] \
  -s <read-only|workspace-write> -C <cwd> -o <final-message-file> -   # prompt on stdin
```

- **`-m gpt-6-luna`** is accepted, and effort `medium` and `max` were both applied. Codex records the values it actually used in the session log (see below).
- **`-o` holds only the last agent message.** Codex creates the file empty at start, so an empty file means there was no final message, not success.
- **`codex mcp-server` no longer exists** (still absent in 0.169.1). The alternatives are `exec`, `app-server` (JSON-RPC, experimental) and `exec-server`.
- **Reported, not used yet:** `--output-schema <file>` for typed final output, and `codex exec resume <id>` for follow-up turns.

## Event stream (`--json`)

| Event | Meaning |
| --- | --- |
| `{"type":"thread.started","thread_id":...}` | Always first; the thread ID is the session ID used for resume and for the session log. |
| `turn.started`, `item.started`, `item.completed` | Progress. Items include `command_execution` (with `aggregated_output`, `exit_code`) and `agent_message`. |
| `item.completed` with `item.type: "error"` | Non-fatal warning (e.g. "Model metadata ... not found"). |
| `{"type":"error","message":...}` | An error message. It is fatal only if the turn then fails. |
| `turn.failed` with `error.message` | Fatal failure (e.g. unsupported model). The exit code is 1. |
| `turn.completed` with `usage` | Normal end. `usage` has `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, cumulative for the turn. |

The stream does **not** include the model or effort actually used.

## Session log ("rollout")

`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`:

- `turn_context.payload` holds `model`, `effort` and `sandbox_policy.type`: the settings actually observed.
- `token_usage_record.payload` holds `usage` (per request), `turn_token_usage` and `thread_token_usage` (cumulative). The last `thread_token_usage` is the run total. It is the only usage source for a run cancelled before `turn.completed`.

## Cancellation

| Signal | Observed behavior |
| --- | --- |
| SIGTERM to the codex process group | Codex exits at once (exit -15), but its tool subprocess (`zsh -c ...`, `sleep`) **keeps running as an orphan**. Codex starts each tool command in its own process group. |
| SIGINT to codex | Codex exits in about 0.24s with code 1 and stops its tool subprocesses and `codex-code-mode-host`. Nothing is left behind. |

Neither signal produces a terminal event, and the `-o` file stays empty. The supervisor records the cancellation itself and takes partial usage from the session log.

## Sandbox

In `read-only`, the worker knew it was read-only from its context, did not attempt the write, explained why in its final message, and exited with code 0. A blocked action therefore shows up in the answer, not as an error status.

Write permissions, verified with codex-cli 0.171.0 through `codex sandbox -c sandbox_mode="<mode>" -- <command>`, which applies the sandbox policy without running a model:

| Write target | `read-only` | `workspace-write` |
| --- | --- | --- |
| Under the working directory (`-C`) | Denied | Allowed |
| Temporary directories (`$TMPDIR`, `/tmp`) | Denied | Allowed |
| Elsewhere, including the repository root above the working directory | Denied | Denied |
| `.git` (`index.lock`) | Denied | Denied |

- **Workers cannot commit.** `git add` fails with `Operation not permitted` on `index.lock` in a linked worktree, in the main repository root, and in a `git clone --local`. Adding the git directory to `sandbox_workspace_write.writable_roots` did not help.
- **Reads are allowed everywhere** in both modes, so a `workspace-write` worker whose working directory is an output directory can inspect a repository and run commands in it without being able to change it.

## Configuration overrides

- **`-c` keys are split on every dot, even inside quotes.** `mcp_servers."a.b".enabled=false` fails with `invalid transport in mcp_servers."a`.
- **Inline tables work and merge** into the existing config: `-c 'mcp_servers={"a.b"={enabled=false}}'` disables `a.b` and keeps its other settings.
- **Disabling a server that isn't configured breaks the config.** `-c mcp_servers.x.enabled=false` for an unconfigured `x` fails with `invalid transport`, so only configured servers can be disabled.
- **`codex mcp list --json` reports the effective server list,** including project-level `.codex/config.toml` in a trusted directory and entries from other layers. Each entry has `name`, `enabled` and `transport.{command,args}`.

## Cost observations

A trivial read-only lookup took about 10 to 20 seconds and about 41 to 46k input tokens, mostly cached (38k), with about 100 to 300 output tokens. Codex reads `~/AGENTS.md` on its own. So startup overhead dominates small tasks: delegation pays off when a task would cost the orchestrator more than that.

## Not yet verified

- Whether Codex passes `AGENT_DISPATCH_DEPTH` to the MCP servers it starts.
- Behavior of `codex exec resume` and `--output-schema`.
- A `codex exec` worker editing files in a worktree. The write rules above were checked with `codex sandbox`, not with a model run.
- Multi-turn usage semantics: `codex exec` was single-turn in every run.
