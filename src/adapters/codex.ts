import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEPTH_ENV, type Config } from "../config.ts";
import type { Usage } from "../types.ts";
import type { Enrichment, EventParser, ParsedRun, WorkerAdapter } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Directory of this package; MCP servers whose command or args point inside it are this server. */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type TokenCounts = Omit<Usage, "source">;

function toTokenCounts(raw: Record<string, unknown>): TokenCounts {
  const counts: TokenCounts = {};
  const fields = [
    ["input_tokens", "inputTokens"],
    ["cached_input_tokens", "cachedInputTokens"],
    ["cache_write_input_tokens", "cacheWriteInputTokens"],
    ["output_tokens", "outputTokens"],
    ["reasoning_output_tokens", "reasoningOutputTokens"],
  ] as const;
  for (const [from, to] of fields) {
    const value = raw[from];
    if (typeof value === "number" && Number.isFinite(value)) counts[to] = value;
  }
  return counts;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/**
 * Parses `codex exec --json` output (verified against codex-cli 0.169.1 and 0.170.0).
 * `codex exec` runs a single turn; `turn.completed.usage` is that turn's cumulative total, so
 * the last one wins. The session log's thread total is preferred when available (see enrich).
 */
export function createCodexParser(): EventParser {
  let sessionId: string | undefined;
  let usage: Usage | undefined;
  let completed = false;
  let failure: string | undefined;
  let lastError: string | undefined;
  const warnings: string[] = [];
  return {
    push(line) {
      const event = parseObject(line);
      if (!event) return;
      switch (event.type) {
        case "thread.started":
          if (typeof event.thread_id === "string") sessionId = event.thread_id;
          break;
        case "turn.completed": {
          completed = true;
          const raw = asObject(event.usage);
          if (raw) usage = { source: "reported", ...toTokenCounts(raw) };
          break;
        }
        case "turn.failed": {
          const message = asObject(event.error)?.message;
          failure = typeof message === "string" ? message : (lastError ?? "turn failed");
          break;
        }
        case "error":
          // Fatal only if the run then fails; see result().
          if (typeof event.message === "string") lastError = event.message;
          break;
        case "item.completed": {
          const item = asObject(event.item);
          if (item?.type === "error" && typeof item.message === "string") {
            warnings.push(item.message);
          }
          break;
        }
      }
    },
    result() {
      const run: ParsedRun = { completed, warnings: [...warnings] };
      if (sessionId) run.sessionId = sessionId;
      if (usage) run.usage = { ...usage };
      // A turn.failed is authoritative; a bare error event only explains a run that did not complete.
      const error = failure ?? (completed ? undefined : lastError);
      if (error) run.error = error;
      return run;
    },
  };
}

interface CodexMcpServer {
  name?: unknown;
  enabled?: unknown;
  transport?: { command?: unknown; args?: unknown };
}

/**
 * Selects MCP servers (from `codex mcp list --json`) that are this dispatch server: listed under
 * one of `names`, or launched from this package's directory.
 */
export function selectDispatchServers(
  servers: CodexMcpServer[],
  names: string[],
  packageRoot = PACKAGE_ROOT,
): string[] {
  return servers.flatMap((server) => {
    if (typeof server.name !== "string" || server.enabled === false) return [];
    const command = server.transport?.command;
    const args = Array.isArray(server.transport?.args) ? server.transport.args : [];
    const pointsHere = [command, ...args].some(
      (part) => typeof part === "string" && part.startsWith(packageRoot),
    );
    return names.includes(server.name) || pointsHere ? [server.name] : [];
  });
}

/**
 * `-c` override that disables the given servers. Codex splits `-c` keys on every dot, even
 * inside quotes, so names are set through an inline table, which Codex merges into the config.
 */
export function disableServersOverride(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  const entries = names.map((name) => `${JSON.stringify(name)}={enabled=false}`);
  return `mcp_servers={${entries.join(",")}}`;
}

async function effectiveMcpServers(config: Config, cwd: string): Promise<CodexMcpServer[]> {
  // Run in the worker's directory so project-level config layers are included.
  const { stdout } = await execFileAsync(config.codex.bin, ["mcp", "list", "--json"], {
    cwd,
    timeout: 20_000,
    env: { ...process.env, CODEX_HOME: config.codex.home },
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("unexpected `codex mcp list --json` output");
  return parsed as CodexMcpServer[];
}

async function findRollout(codexHome: string, sessionId: string): Promise<string | undefined> {
  // The session ID comes from the worker's output; never let it shape the glob.
  if (!/^[0-9a-f-]+$/i.test(sessionId)) return undefined;
  for await (const match of glob(`sessions/*/*/*/rollout-*-${sessionId}.jsonl`, {
    cwd: codexHome,
  })) {
    return join(codexHome, match);
  }
  return undefined;
}

/** Extracts the observed model/effort/sandbox and the latest cumulative usage from a rollout file. */
export async function readRollout(path: string): Promise<Enrichment> {
  const enrichment: Enrichment = {};
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const record = parseObject(line);
    const payload = asObject(record?.payload);
    if (!record || !payload) continue;
    if (record.type === "turn_context") {
      const observed = enrichment.observed ?? {};
      if (typeof payload.model === "string") observed.model = payload.model;
      if (typeof payload.effort === "string") observed.effort = payload.effort;
      const sandbox = asObject(payload.sandbox_policy)?.type;
      if (typeof sandbox === "string") observed.sandbox = sandbox;
      enrichment.observed = observed;
    } else if (record.type === "token_usage_record") {
      const thread = asObject(payload.thread_token_usage);
      if (thread) enrichment.sessionUsage = toTokenCounts(thread);
    }
  }
  return enrichment;
}

export const codexAdapter: WorkerAdapter = {
  harness: "codex",
  // Phase 0: SIGINT makes codex terminate its tool subprocesses; SIGTERM orphans them.
  cancelSignal: "SIGINT",

  async version(config) {
    try {
      const { stdout } = await execFileAsync(config.codex.bin, ["--version"], { timeout: 10_000 });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },

  async launch(request, prompt, paths, config) {
    let servers: CodexMcpServer[];
    try {
      servers = await effectiveMcpServers(config, request.cwd);
    } catch (error) {
      // Fail closed: without the server list the recursion guard cannot be applied.
      throw new Error(
        `could not list Codex MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const override = disableServersOverride(selectDispatchServers(servers, config.serverNames));
    return {
      command: config.codex.bin,
      args: [
        "exec",
        "--json",
        "-m",
        request.model,
        "-c",
        `model_reasoning_effort=${JSON.stringify(request.effort)}`,
        ...(override ? ["-c", override] : []),
        "-s",
        request.sandbox,
        "-C",
        request.cwd,
        "-o",
        paths.finalMessage,
        "-",
      ],
      env: { [DEPTH_ENV]: "1", CODEX_HOME: config.codex.home },
      stdin: prompt,
    };
  },

  createParser: createCodexParser,

  async enrich(parsed, config) {
    if (!parsed.sessionId) return {};
    try {
      const path = await findRollout(config.codex.home, parsed.sessionId);
      return path ? { sessionLog: path, ...(await readRollout(path)) } : {};
    } catch {
      return {};
    }
  },
};
