# Architecture

## Scope

The server is a **cross-harness spawn tool**. It starts a worker with a given prompt, model, effort, sandbox and working directory, tracks it, and returns a compact result. Each harness keeps its own model and tool loop. The server does not decompose tasks, route models, create worktrees or judge results. Those belong to the orchestrator, guided by the [dispatch skill](#dispatch-skill).

```
orchestrator (e.g. Claude Code)
   | MCP over stdio: dispatch / wait / cancel / list
   v
MCP server (one per orchestrator session) ---- spawns, detached ----> supervisor (one per job)
   | reads job records                                                  | spawns, owns
   v                                                                    v
<state>/jobs/<job_id>/  <-- writes meta.json, logs ------------------ worker harness (e.g. codex exec)
```

## Tools

| Tool | Behavior |
| --- | --- |
| `dispatch` | Validates the request, creates the job directory and starts a detached supervisor. Returns `job_id` immediately. |
| `wait` | Blocks until `any` or `all` of the given jobs finish, or until `timeout_s` passes (at most 600s; verified that Claude Code allows MCP calls over 11 minutes). Returns finished results and pending states. |
| `cancel` | Stops the job and its whole process tree. Returns once termination is confirmed. |
| `list` | Recent jobs, newest first, e.g. to recover job IDs in a new session. |

`wait` blocks instead of being polled because every poll is an orchestrator turn, which costs frontier tokens.

### Result shape

Every field costs orchestrator tokens, so a finished job returns only:

```json
{
  "job_id": "...",
  "state": "completed",
  "final_message": "...",
  "usage": { "source": "reported", "input": 43282, "cached": 28288, "output": 320 },
  "elapsed_s": 19.5,
  "dir": "..."
}
```

- `failure_reason` and `exit_code` are added when relevant.
- `observed` is added only when the harness reports a model, effort or sandbox that differs from the request.
- `final_message` is capped (4000 characters by default) and flagged when truncated.
- Usage `source` is one of:
  - `reported`: a normally finished run.
  - `partial`: the run was cancelled, timed out, or ended without a final usage event.
  - `unknown`: no usage could be read.
- Usage values are never estimated.

Full details stay in the job directory: `meta.json`, `claim`, `prompt.md`, `final-message.md`, `stderr.log` and `supervisor.log`. The worker's structured stdout is parsed while it runs and not stored: the harness keeps its own, richer session log, and `meta.json` records its path as `sessionLog` (for Codex, the rollout file). Keeping a second copy would duplicate repository content and secrets without a consumer.

## Job lifecycle and ownership

States: `queued`, `running`, then one terminal state: `completed`, `failed`, `timed_out`, `cancelled` or `interrupted`.

- **Persistence is plain files**, one directory per job under `${XDG_STATE_HOME:-~/.local/state}/agent-dispatch/jobs/`. Event streams must be files anyway, and each job has only a few state writes. Several server instances (one per orchestrator session) share the directory. SQLite would only pay off for queries across many jobs.
- **Job IDs** look like `20261119T012024Z-label-9235`. The UTC timestamp keeps ordering stable across daylight saving changes. The 4 hex characters keep IDs readable, and creating the directory with an exclusive `mkdir` reserves the name atomically.
- **One supervisor per job** runs detached from the MCP server, so jobs survive the orchestrator session that started them. A stdio MCP server dies with its client.
- **The claim file decides ownership.** Exactly one process can create `claim` (exclusive create):
  - The supervisor claims before running.
  - The server claims only to settle a job that never started: cancelled before start, or no supervisor after the startup timeout.
  - A late supervisor that loses the claim stands down.
  - After the claim, only the owner writes `meta.json`, always atomically (temp file plus rename).
- **Reconcile settles orphaned jobs.** A reader that finds a non-terminal job whose supervisor is gone first stops the orphaned worker tree, identified by pid plus start time, then marks the job `interrupted`. If liveness cannot be determined (e.g. `ps` failed), the job is left alone.
- **Retention:** finished jobs older than 14 days are pruned when the server starts. `0` disables pruning.
- **Permissions:** job directories are `0700` and the files the server writes are `0600`, because prompts and outputs can contain repository content or secrets.
  - `final-message.md` is the exception: the harness creates it (Codex through `-o`) with the default umask, usually `0644`. That is accepted because the `0700` directory already keeps other users out, and the same text is in the harness's own session log, which Codex stores as `0644` in world-readable directories (verified, codex-cli 0.171.0). Tightening our copy would not reduce exposure.

## Supervisor rules

These rules come from the initial Codex and Claude Code smoke tests and the review of the first server implementation:

- **Signal handlers come first,** before any await, so an early cancel is honored instead of killing the supervisor.
- **Cancellation is cooperative, then forced.**
  - The adapter's signal goes to the worker first; for Codex that is SIGINT, because SIGTERM orphans its tool subprocesses.
  - The process tree is re-captured during the grace period, because tool subprocesses live in other process groups and cannot be traced once the worker exits.
  - Then SIGKILL is sent to the worker and every remaining tree member, checked by pid plus start time.
  - The job is recorded as `cancelled` only after termination is confirmed.
- **The real outcome stands** when a cancel arrives after the worker exited.
- **Completion is detected on process exit,** followed by a bounded 3-second wait for stdout and stderr to close. A leftover process holding the worker's stdout cannot hang the job.
- **Errors after the worker started still stop its process tree.** Meta writes are serialized, and one failed write does not block later ones.

## Recursion guard

A worker must not be able to dispatch more workers.

1. **Environment marker.** Workers get `AGENT_DISPATCH_DEPTH=1`. A server that sees it refuses `dispatch` and does not even advertise `dispatch` or `cancel`.
2. **Disable this server in the worker's harness.** Before each run, the server asks Codex for its effective MCP servers (`codex mcp list --json`, run in the worker's cwd so project config counts). It disables any server whose name is in `AGENT_DISPATCH_SERVER_NAMES`, or whose command or arguments point into this package. The override uses an inline table, `-c mcp_servers={"name"={enabled=false}}`, because Codex splits `-c` keys on every dot, even inside quotes.
3. **Fail closed.** If the server list is unavailable, the job fails instead of running unguarded.

## Safety defaults

- **Sandbox:** only `read-only` or `workspace-write` are accepted. There are no bypass flags. Almost every reference project defaults to them; this one does not.
- **Input validation:**
  - `cwd` must be an existing absolute directory.
  - `model` and `effort` must be identifiers with no leading `-`, so they cannot be read as command-line flags.
  - Job IDs are validated against a strict pattern before any path is built.
- **Usage and observed settings come from the harness's own records,** never from the request.

## Adapter interface

`src/adapters/types.ts` defines what each harness provides:

- how to launch it (command, arguments, environment, stdin);
- a parser for its structured output that never throws;
- the cooperative cancel signal;
- its version, with a timeout;
- an `enrich` step that reads harness-side session records after the run.

Each adapter also owns the recursion guard for its harness and must write the final message to the job's `final-message.md`.

## Dispatch skill

[`skills/dispatch/`](../skills/dispatch/SKILL.md) teaches the orchestrator when to delegate, how to brief workers, and how to review and integrate their results. It is kept separate from the user's single-harness orchestrate skill so each can evolve on its own; shared parts can be extracted later.

- **Verification output stays out of the orchestrator.** Keeping check output out of the frontier model's context is a primary goal, not a side effect. Checks are mapped to acceptance criteria in advance, scoped to what the criteria need (not repo-wide by default), and run by fresh explorers for both baseline and final verification. Explorer reports give each criterion as met, not met or not run, with a one-line cause and an evidence path. Raw output stays in evidence files. The orchestrator does not run checks itself. The current skill text still lets the orchestrator rerun one cheap command during review; that changes with the planned unification below.

- **Role sandboxes** follow from Codex's write rules ([harnesses/codex.md](harnesses/codex.md#sandbox)). Explorers and researchers run `workspace-write` with their attempt directory as `cwd`, so they can write a report but cannot change the repository. Implementers run `workspace-write` in a dedicated worktree and report in their final message.
- **Worktrees** are created by the orchestrator, not by the server: the brief must name the worktree's path, branch and base commit before dispatch.
- **Edit integration:** Codex workers cannot commit, because `.git` is read-only in their sandbox. The implementer leaves its changes uncommitted; the orchestrator reviews the diffstat and report (the full diff only when needed), commits on the worktree branch, and integrates.
- **Records:** a task directory with briefs, reports and one review line per report. There is no journal, because each job's `meta.json` already holds the attempt telemetry.
- **Compatibility:** benchmark every relevant harness, model and effort level, instead of fixing one worker pair up front.

## Stack

TypeScript run directly by Node (type stripping, no build step), pnpm, Vitest, TypeScript 7 for typechecking, oxlint and oxfmt. Node and pnpm are pinned in `mise.toml` and the `packageManager` field.
