# AGENTS.md

agent-dispatch is a local MCP server that lets an orchestrating agent delegate bounded tasks to worker agents in another harness (currently Codex CLI). The goal is fewer frontier-model tokens at equal delivery quality. Start with [docs/README.md](docs/README.md); design decisions and their reasons are in [docs/architecture.md](docs/architecture.md), and the current phase and open questions are in [docs/roadmap.md](docs/roadmap.md).

## Commands

Node and pnpm are pinned (`mise.toml`, the `packageManager` field). In a non-interactive shell, run `eval "$(mise env -s bash)"` first.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # run all before finishing a change
pnpm format                                                      # oxfmt, also formats Markdown
pnpm test:live   # real Codex runs: consumes quota, ask the user first
```

TypeScript runs directly through Node's type stripping. There is no build step, so use only erasable syntax (no enums, namespaces or parameter properties) and import with `.ts` extensions.

## Where things go

- **`docs/`** holds durable knowledge: design, verified harness behavior, research conclusions, roadmap. Update it when a decision is made or a fact is verified. It must not link into `.scratch/`.
- **`.scratch/`** holds throwaway material: plans for a single piece of work, handoffs, research reports, review reports, experiments, proofs of concept, test evidence. It is excluded from git and never committed. Use one directory per piece of work, named `<YYYYMMDD>-<kebab-case-subject>/`, and reuse it when continuing that work.
- **`test/fixtures/`** holds sanitized recordings only: no local paths, user instructions or secrets.

When a `.scratch/` document produces a lasting conclusion, distill it into `docs/` rather than committing the scratch file.

## Working rules

- **Label harness facts** as verified (observed locally, with the harness version) or reported (from documentation). Harness behavior changes between releases, so re-verify before relying on a detail.
- **Behavior changes need tests.** Integration tests use `test/fake-codex.ts`, which mimics real Codex event formats; keep it in sync with recorded behavior.
- **Never leave processes behind.** Tests that start workers must clean up their process trees.
- **Keep the orchestrator's token cost in mind:** tool descriptions and results are paid for on every call. `test/server.test.ts` enforces size budgets.
- Before spawning subagents, confirm the agent type and reasoning level with the user.
- Commit only when the user asks.
