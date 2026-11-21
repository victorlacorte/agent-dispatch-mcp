---
name: dispatch
description: Delegate bounded exploration, research, checks and edits to cheaper worker agents in another harness through the agent-dispatch MCP server, then review their reports and integrate their changes.
disable-model-invocation: true
---

# Dispatch

You are the orchestrator. Delegate bounded, independently checkable work to workers in another harness through the agent-dispatch MCP tools (`dispatch`, `wait`, `cancel`, `list`). The goal is to spend fewer of your own tokens at equal delivery quality. You own scope, acceptance criteria, review and integration. Workers do the searching, reading, running and editing.

Your output tokens are the most expensive part of this workflow. Keep briefs short and exact, and do not repeat a worker's work during review.

## When to dispatch

Every worker run has a fixed overhead of 10 to 20 seconds and about 40k worker input tokens, plus your brief and review. Dispatch when doing the work yourself would cost you more than that:

- searching or mapping a codebase across many files;
- reading URLs and comparing sources;
- running lint, build, typecheck, tests or format checks and interpreting the output;
- bounded edits with acceptance criteria you can state in advance.

Do it yourself when it is a lookup in a known file, a single short command, ambiguous design work, or work that depends on this conversation in ways a short brief cannot convey. Batch closely related questions into one job instead of one job per search or URL. Give parallel jobs non-overlapping questions.

## Roles and defaults

| Role | Harness | Model | Effort | Sandbox | `cwd` | Report |
| --- | --- | --- | --- | --- | --- | --- |
| Explorer | `codex` | `gpt-6-luna` | `medium` | `workspace-write` | its attempt directory | `report.md` in its attempt directory |
| Researcher | `codex` | `gpt-6-luna` | `medium` | `workspace-write` | its attempt directory | `report.md` in its attempt directory |
| Implementer | `codex` | `gpt-6-luna` | `medium` | `workspace-write` | its dedicated worktree | its final message |

Invoking this skill selects these defaults, so they count as the user's choice of worker type, model and effort wherever instructions require confirming those before spawning agents. The user may override any default for a session; explicit user choices and higher-priority instructions come first.

- **Explorer:** maps the codebase or runs the assigned checks and reports each result. Does not edit source or fix failures.
- **Researcher:** answers an external question with sources (Codex has its own web search). Does not implement.
- **Implementer:** makes the assigned changes in its worktree, runs only the fast checks the brief lists, and leaves its changes uncommitted.

Why the table looks like this (verified with codex-cli 0.171.0): `workspace-write` allows writes only under `cwd` and temporary directories, and `.git` is always read-only. `read-only` allows no writes at all. An explorer whose `cwd` is its attempt directory can therefore read the repository and run commands in it, but cannot change it, and can still write its report. An implementer cannot commit or write outside its worktree, so its final message is its report. Never use `workspace-write` with `cwd` in the integration checkout.

## Task directory

Use one directory per user task: `<project-root>/.scratch/<YYYYMMDD>-<task-slug>/`. If `git check-ignore -q .scratch/` fails, append `.scratch/` to `$(git rev-parse --git-common-dir)/info/exclude`.

```text
briefs/<attempt_id>.md     the brief you write
attempts/<attempt_id>/     report.md and evidence; cwd of explorers and researchers
```

`attempt_id` is `<work-item>-<n>`, such as `typecheck-1` or `fix-types-2`. `n` counts fresh attempts at the same work item. Use the attempt ID as the dispatch `label`. Create the attempt directory before dispatch, for every role: `dispatch` requires an existing `cwd`, and implementer reports are copied there during review.

## Worktrees for implementers

Create the worktree yourself before dispatch, outside the project directory, because project tooling scans nested directories:

```sh
git -C <repo> worktree add -b dispatch/<attempt_id> <repo>/../<repo-name>-<attempt_id> <base-commit>
```

- A new worktree has no uncommitted changes and no untracked dependencies such as `node_modules`. Set up the starting state and install dependencies before dispatch: workers usually have no network access and cannot write to shared caches or stores outside their worktree.
- One writer per worktree. A correction attempt may reuse a worktree once the previous job has finished; its brief describes the worktree's current state.
- Put the worktree path, branch and base commit in the brief.

## Brief

Write the brief to `briefs/<attempt_id>.md`. The worker sees nothing of this conversation, but it does read the repository's `AGENTS.md` files, so do not repeat them. Omit empty sections.

```markdown
# <attempt_id>: <one-line goal>

- Role: <explorer | researcher | implementer>
- Contract: <this skill's directory>/references/worker-contract.md (read it before starting)
- Working directory: <absolute cwd>
- Repository: <absolute path of the checkout to inspect or edit>; implementers add: branch <branch>, base <commit>
- Report: <absolute path to attempts/<attempt_id>/report.md>, or "final message" for implementers

## Goal

## Acceptance criteria

## Scope

Owned paths, and what is out of scope.

## Context

Established findings, constraints, prior attempts and what to preserve.

## Commands

Exact commands and the directory to run each in.
```

The dispatch `prompt` is only:

```text
Dispatch attempt <attempt_id>. Read your brief and follow it exactly: <absolute brief path>
End with the final message your contract specifies.
```

## Dispatch and wait

- Dispatch all independent jobs in one turn, then make one `wait` call with all their IDs and `mode: all`. Use `mode: any` only when an early result changes what you do next.
- When `wait` returns pending jobs, call it again with only those IDs. Do not poll with short timeouts or sleep.
- Use `cancel` for jobs that are no longer needed, for example when the user changes direction.

## Review

A `completed` job is not an accepted result.

1. Check the `wait` result: `state`, `failure_reason`, `usage.source`, and `observed`. `observed` is present only when the harness ran a different model, effort or sandbox than requested; report that deviation. If `final_message_truncated` is set, the full text is in `<dir>/final-message.md`.
2. For implementers, copy `<dir>/final-message.md` to `attempts/<attempt_id>/report.md`.
3. Read the report and check it against the acceptance criteria. Spot-check what your decision depends on: open the cited lines, or rerun one cheap command when a conclusion hinges on it. Do not redo the worker's exploration.
4. For implementers, run `git -C <worktree> status --short` and `git -C <worktree> diff --stat`. Open the full diff or files only where the report or diffstat calls for it: unexpected files, large changes, or criteria that depend on exact code. Confirm nothing outside the owned scope changed.
5. Append one review line to the report on its own line, for example `printf '\nReview: accepted (job <job_id>)\n' >> <report>`. The other decisions are `Review: correction - <reason>` and `Review: blocked - <reason>`. The leading newline matters: copied final messages do not end with one.

## Integrating edits

After accepting an implementer's changes, commit them on the worktree branch, then integrate:

```sh
git -C <worktree> add -A && git -C <worktree> commit -m "<message>"
git -C <integration-checkout> merge --squash dispatch/<attempt_id>   # stages the change without committing
```

Commit in the integration checkout only when the user's instructions allow it; otherwise leave the squashed change staged. Then verify the integrated result in the integration checkout: run the relevant check yourself when it is one cheap command, or dispatch an explorer. A pass inside the worktree does not verify the integrated result. Finally, remove the worktree and its branch (`git worktree remove`, `git branch -D`).

## Failures and corrections

| Outcome | Action |
| --- | --- |
| `failed` | Read `failure_reason`, and `<dir>/stderr.log` if it is unclear. Fix the brief or setup and dispatch a fresh attempt, or stop on a real blocker. Never retry unchanged. |
| `timed_out` | Read any partial report. Retry with a narrower scope or a longer `timeout_s`. |
| `cancelled` | Decide whether the work is still needed. |
| `interrupted` | The supervisor died. Never retry an implementer automatically: inspect the worktree first. |
| Report `partial` or `blocked` | Answer its questions or fix the cause in a new brief for the next attempt. |

Never resume or message an existing worker. Every correction goes to a fresh job with an updated brief, as attempt `n + 1`. Stop and report to the user when repeated attempts fail for the same reason.

## Recovery in a new session

`list` returns recent jobs, newest first, with their labels (the attempt IDs). `wait` with `timeout_s: 0` returns a finished job's result, including its `dir`, or the state of a pending one. Each job directory holds `meta.json`, `prompt.md`, `final-message.md`, `stderr.log` and `supervisor.log`; jobs are pruned after 14 days. The full worker transcript, including commands and their output, is the harness session log at `sessionLog` in `meta.json`. The task directory holds the briefs, reports and review lines.

## Final report to the user

Report what was done and what changed, each attempt's job ID and review decision, the verification and who ran it, and anything left unverified. Link the task directory.
