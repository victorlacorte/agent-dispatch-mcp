# Prior art

The research was done between 2026-10-31 and 2026-11-17. Star counts and activity reflect that snapshot. This is a summary; claims marked "README" come from project documentation without a source check.

## Main conclusions

1. **No major product offers this.** None lets an agent hand a task to a _different vendor's local CLI_ and get a compact result back. Vendors delegate to subagents inside their own harness or to their own cloud, so the local cross-vendor layer is a real gap.
2. **What to copy is the lifecycle, isolation and result contract,** not a cross-vendor API. Common patterns:
   - The subagent's final message is the only thing returned to the parent.
   - Long jobs get IDs, and callers check their status and cancel them by ID.
   - Workers run in isolated worktrees.
3. **Permission defaults are the main weakness of existing projects.** Most launch workers with `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox` or `--yolo`.
4. **Nobody normalizes cost across harnesses,** and published savings claims are mostly qualitative or unverified.

## Commercial products

| Product | Delegation model | Notes for us |
| --- | --- | --- |
| OpenAI Codex | `codex exec` headless (JSONL, `--output-schema`, `-o`, `resume`), in-harness subagents, cloud tasks, Agents SDK handoffs | `codex mcp-server` was removed. Build on `exec` or the experimental `app-server`. |
| Anthropic Claude Code | Subagents, `claude -p`, background sessions (`--bg`, `claude agents`), worktree isolation that never pushes to main | Headless output reports cost. The background lifecycle is a model for ours. |
| Google | Gemini CLI subagents; Jules (async cloud agent) | Gemini CLI has structured headless output with per-model token stats. |
| GitHub | Copilot coding agent; Agent HQ assigns Claude Code and Codex from GitHub (public preview, Feb 2026) | The closest cross-vendor feature, but a cloud control plane, not local dispatch. |
| Cursor | Cloud agents; subagents with per-subagent model pins; reads `.claude/` and `.codex/` agent folders | Quote: "5 parallel subagents is roughly 5x the tokens". |
| xAI Grok | Grok 4 Heavy and multi-agent API (parallel agents inside xAI) | In-vendor parallelism only. |
| Factory | `task_id` + `TaskOutput` + `TaskStop` | The simplest async contract to imitate. |

## Open-source MCP bridges

| Project | What it does | Takeaway |
| --- | --- | --- |
| BeehiveInnovations/pal-mcp-server (`clink`, about 11.8k stars) | Blocking calls to the Claude, Codex and Gemini CLIs | The only bridge verified to cap output: it asks for a `<SUMMARY>` block, with a 4k-character excerpt as fallback. Its Codex and Gemini presets bypass the sandbox. |
| steipete/claude-code-mcp | Claude Code as an MCP tool | Defaults to `--dangerously-skip-permissions`. If the working folder is wrong, it silently falls back to the home directory. |
| tuannvm/codex-mcp-server | Codex as an MCP tool | Silently drops sandbox and cwd on resume, keeps sessions only in memory (max 100), returns raw stdout. |
| x51xxx/codex-mcp-tool | Codex as an MCP tool | Long output can be fetched in chunks, and a `verify` command runs after the job. |
| dvcrn/mcp-server-subagent | Async run IDs, polling, logs on disk | The only async design. Workers run with broad Bash/Edit/Write and can reach the parent server, so they can recurse. |
| szeider/consult7 | Writes the result to a file and returns the path (README) | Keeps output out of the orchestrator's context. |
| muaaz9329/cheap-ag (MIT) | OpenCode workers via SDK, worktrees, verification before landing, budgets, model tiers | A broad workflow product. Its claim of 63% fewer Opus tokens was not reproduced by its own fixture benchmark. |
| Kadenai/Antigravity-Bridge (`UNLICENSED`) | Detached `agy` workers, shared state, explicit integration step | Windows-focused, one hard-coded model, logs kept forever. A design reference only; its code may not be reused. |

## Multi-harness orchestrators (non-MCP)

| Project | How it runs harnesses | Takeaway |
| --- | --- | --- |
| vibe-kanban (about 28.7k stars, Apache-2.0) | Per-harness command builders with pinned versions: Claude stream-json, Codex `app-server`, Gemini `--experimental-acp`, Cursor `-p --output-format=stream-json`, OpenCode `serve` | The best adapter code to study. It converts each harness's output into one event format and stores state in SQLite. |
| Crystal | `claude --output-format stream-json`, `codex exec --json`, resume by a stored session ID | Refuses to resume without a stored ID rather than silently starting fresh. |
| claude-squad, ccmanager, ntm | tmux or PTY screen-scraping | Fragile: ccmanager detects that Claude is idle with a spinner regex and a 1.5s wait. Avoid. |
| Roo Code boomerang | `new_task` / `attempt_completion(result)` | The only tool that returns just a summary to the parent. |

## What we adopted

- Structured headless modes, never screen-scraping.
- A durable job ID with files on disk.
- A blocking `wait` instead of status polling.
- A capped final message, with full logs referenced by path.
- Usage read from the harness's own events and session logs.
- Safe sandbox defaults with no bypass flags.
- A recursion guard on every worker.
- A pinned harness version recorded per job.

## What we avoided

- Bypass-by-default presets.
- Raw stdout returns and in-memory session maps.
- Silent cwd fallback.
- Unbounded log retention.
- Model routing and automatic fallback in the first version.
