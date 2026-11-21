# Open questions

Unresolved design questions. When one is decided, record the decision and its reason in [architecture.md](architecture.md) and remove it here.

- **Recursion guard:** does Codex pass `AGENT_DISPATCH_DEPTH` to the MCP servers it starts? It matters less now that servers pointing at this package are disabled by command.
- **Worker report paths and commits:** should the server let a job write to a report directory outside its `cwd` (e.g. through `sandbox_workspace_write.writable_roots`)? Implementers could then write report files like the other roles. Commits would need something else, since `.git` stayed read-only even as a writable root. The current skill works without either.
- **Claude Code recursion guard:** `--strict-mcp-config` drops the user's other MCP servers. Is that acceptable for workers?
- **Shared sandbox field:** how should `read-only` and `workspace-write` map to Claude Code permission modes?
- **Command runner:** should the server offer a plain "run a command" tool that uses no model, as a baseline for verification tasks?
- **`JobMeta` type:** should it become a union type with one variant per state, so the compiler enforces the per-state invariants, when the second adapter lands?
