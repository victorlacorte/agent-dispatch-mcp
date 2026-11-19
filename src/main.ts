#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { JobService } from "./jobs.ts";
import { createServer } from "./server.ts";
import { readMeta, writeMeta } from "./store.ts";
import { runJob } from "./supervisor.ts";
import { isTerminal } from "./types.ts";

async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

async function serve(): Promise<void> {
  // stdout carries MCP protocol messages only; diagnostics go to stderr.
  const jobs = new JobService();
  const server = createServer(jobs, await packageVersion());
  await server.connect(new StdioServerTransport());
  // Prune after connecting so a large state directory does not delay the handshake.
  try {
    const { pruned, errors } = await jobs.prune();
    if (pruned.length > 0) console.error(`agent-dispatch: pruned ${pruned.length} old jobs`);
    for (const { jobId, error } of errors) {
      console.error(`agent-dispatch: could not prune ${jobId}: ${error}`);
    }
  } catch (error) {
    console.error("agent-dispatch: pruning failed:", error);
  }
}

async function supervise(dir: string): Promise<void> {
  try {
    await runJob(dir, loadConfig());
  } catch (error) {
    // runJob stops its worker on errors after spawning; this covers failures before that.
    console.error("agent-dispatch supervisor failed:", error);
    const meta = await readMeta(dir).catch(() => undefined);
    if (meta && !isTerminal(meta.state) && meta.supervisor?.pid === process.pid) {
      await writeMeta(dir, {
        ...meta,
        state: "failed",
        finishedAt: new Date().toISOString(),
        failureReason: `supervisor error: ${error instanceof Error ? error.message : String(error)}`,
        usage: meta.usage ?? { source: "unknown" },
      }).catch(() => undefined);
    }
    process.exitCode = 1;
  }
}

const [command = "serve", ...rest] = process.argv.slice(2);
if (command === "serve") {
  await serve();
} else if (command === "run-job" && rest[0]) {
  await supervise(rest[0]);
  // The job is recorded; exit even if a stray handle (e.g. a leaked pipe) is still open.
  process.exit();
} else {
  console.error("usage: agent-dispatch [serve | run-job <job-dir>]");
  process.exitCode = 2;
}
