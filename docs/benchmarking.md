# Benchmarking

Nothing has been benchmarked yet. This page records the objective and the measurement approach agreed so far.

The only data so far is the 2026-11-20 dispatch skill trial (Claude Code with Opus 5.5 orchestrating Codex `gpt-6-luna`, not a paired benchmark): on a 4-file repository, a forced delegation of a lookup cost the orchestrator more output tokens than answering directly (3032 vs 1080), and an unforced run correctly declined to delegate.

Current approach (user decision, 2026-11-21): no staged benchmark yet. The user delegates real tasks with acceptance criteria written up front, one orchestrator session per task, and the results are reviewed in a retrospective within the 14-day job retention. Evidence: task directories (`task.md`, briefs, attempt reports), job `meta.json`, and the orchestrator's session transcript. Paired runs follow only if the numbers are borderline.

## Objective

**Minimize frontier-model (orchestrator) token spend while keeping delivery quality.** More worker tokens are acceptable and expected. Frontier spend may be a subscription allowance rather than cash, so compare frontier usage and quota consumption, not estimated dollars.

The unit is an **accepted task**: one frozen input through to final acceptance. A cheap attempt that the orchestrator then has to redo is not a cheap success.

## Candidate tasks

Tedious, objectively checkable work suits delegation:

| Task class | Independent acceptance check |
| --- | --- |
| Querying text or a repository | Cited quotes and line references match the source exactly |
| Reading URLs | Cited quotes match the fetched page |
| Running lint, build, typecheck or format and interpreting the output | Rerun the command; the reported pass/fail and error list must match |
| Small edits in a dedicated worktree | Diff review against criteria written in advance, plus the relevant checks |

For pure verification commands, a plain command runner that uses no model may beat an LLM worker. An LLM worker earns its place when the output needs interpreting (e.g. grouping hundreds of type errors by root cause) or fixing.

## Economics

Let `F` be the frontier cost of doing the task without delegation. With delegation:

```
D = H + W + p * R
```

- `H`: orchestrator-side handoff (writing the brief), waiting, review and integration.
- `W`: all worker attempts.
- `p`: the fraction of tasks that need a frontier fallback.
- `R`: the average cost of that fallback.

For our objective, only the frontier parts of `H` and `R` count against delegation. `W` counts only if a worker quota becomes a limit.

Two consequences:

- **The brief is written in frontier output tokens,** the most expensive kind, so delegation only pays when brief plus review costs less than doing the work.
- **Each Codex run has about 40k input tokens of overhead.** That cost falls on the worker, but it adds latency to every task.

## What to record per attempt

Record one row per attempt, linked into a tree: coordinator request, then worker attempts, then review, then repair or fallback, then acceptance. Each usage event is assigned to exactly one attempt.

| Group | Fields |
| --- | --- |
| Identity | task, run, attempt and parent attempt IDs; condition (`frontier_only`, `same_harness_delegate`, `cross_harness_delegate`) |
| Runtime | role, harness and version, requested and observed model and effort |
| Usage | input, cached, cache-write, output and reasoning tokens; source (`reported`, `partial`, `unknown`) |
| Work | elapsed time, retries and fallbacks, checks run, artifact or diff reference |
| Result | execution state (separate from acceptance), acceptance (`accepted`, `rejected`, `partial`, `unassessed`), reason |

agent-dispatch already stores the worker side in each job's `meta.json`. The orchestrator side comes from the orchestrator's own records, e.g. Claude Code's headless JSON output or session logs.

## Rules

- **Never add token counts across model families** into one number. Report a usage vector per model.
- **Never fill missing usage with zero or estimates.** Keep `unknown`.
- **Keep execution status separate from acceptance.** A completed run is not an accepted result.
- **Write acceptance criteria before running,** and use checks that do not depend on the worker's own claims.
- **Compare paired runs on the same tasks:**
  1. frontier only;
  2. same-harness cheap subagent;
  3. cross-harness worker via agent-dispatch.
- **Keep failures, timeouts and unsuitable tasks** in the data.
- **Label forced-delegation runs separately** from natural-choice runs. They answer different questions.
- **Keep raw logs private.** They can contain prompts, repository content and secrets.

## Instrumentation by harness (reported)

- **Codex:** see [harnesses/codex.md](harnesses/codex.md). The `--json` stream and the session log are the usage sources.
- **Claude Code:** see [harnesses/claude-code.md](harnesses/claude-code.md). Headless JSON output reports cost; OpenTelemetry is available for aggregate monitoring.
- **Cursor Agent CLI:** `cursor-agent -p --output-format stream-json` reports usage with camelCase keys (`inputTokens`, `cacheReadTokens`, ...). Hooks fire inconsistently in headless mode.
- **Gemini CLI:** headless JSON includes per-model token statistics.
