#!/usr/bin/env node
/**
 * Stand-in for the codex CLI used by integration tests. It replays the event shapes recorded in
 * phase 0 (codex-cli 0.169.1). Supported commands: `--version`, `mcp list --json`, `exec`.
 *
 * `mcp list --json` prints $CODEX_HOME/fake-mcp-list.json (default `[]`), or fails when that
 * file contains `fail`.
 *
 * `exec` behavior is selected with FAKE_CODEX_SCENARIO:
 *   success   emit a completed turn, write the -o file and a rollout file, exit 0
 *   fail      emit an error and turn.failed, exit 1
 *   hang      start a grandchild in its own process group (like codex tool calls), then wait
 *   leak      like success, but leave a detached process holding stdout open for 8s
 * FAKE_CODEX_IGNORE_SIGINT=1 makes `hang` ignore SIGINT so the supervisor must escalate.
 * FAKE_CODEX_RECORD=<path> receives a JSON record of argv, env and grandchild pid.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") {
  const listPath = join(process.env.CODEX_HOME ?? "/nonexistent", "fake-mcp-list.json");
  if (!existsSync(listPath)) {
    console.log("[]");
    process.exit(0);
  }
  const list = readFileSync(listPath, "utf8");
  if (list.trim() === "fail") {
    console.error("Error: failed to load configuration");
    process.exit(1);
  }
  console.log(list);
  process.exit(0);
}

const optionValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const configValues = args.flatMap((arg, i) => (args[i - 1] === "-c" ? [arg] : []));
const effort =
  configValues
    .find((value) => value.startsWith("model_reasoning_effort="))
    ?.split("=")[1]
    ?.replaceAll('"', "") ?? "default";
const model = optionValue("-m") ?? "default";
const sandbox = optionValue("-s") ?? "default";
const lastMessagePath = optionValue("-o");
const threadId = `01a1ec3a-0000-7000-8000-${String(process.pid).padStart(12, "0")}`;
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";

const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = (extra: Record<string, unknown> = {}) => {
  if (!process.env.FAKE_CODEX_RECORD) return;
  writeFileSync(
    process.env.FAKE_CODEX_RECORD,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      depth: process.env.AGENT_DISPATCH_DEPTH ?? null,
      codexHome: process.env.CODEX_HOME ?? null,
      ...extra,
    }),
  );
};

function writeRollout(usage: Record<string, number>) {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) return;
  const dir = join(codexHome, "sessions", "2026", "11", "17");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id: threadId } },
    { type: "turn_context", payload: { model, effort, sandbox_policy: { type: sandbox } } },
    { type: "token_usage_record", payload: { usage, thread_token_usage: usage } },
  ];
  writeFileSync(
    join(dir, `rollout-2026-11-17T00-00-00-${threadId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const prompt = Buffer.concat(chunks).toString("utf8");

// Like codex, create the -o file empty at start.
if (lastMessagePath) writeFileSync(lastMessagePath, "");
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

function complete() {
  const answer = process.env.FAKE_CODEX_ANSWER ?? `answer to: ${prompt.trim()}`;
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: answer } });
  const usage = {
    input_tokens: 1000,
    cached_input_tokens: 800,
    cache_write_input_tokens: 0,
    output_tokens: 50,
    reasoning_output_tokens: 10,
  };
  writeRollout(usage);
  if (lastMessagePath) writeFileSync(lastMessagePath, answer);
  emit({ type: "turn.completed", usage });
}

if (scenario === "success") {
  complete();
  record();
  process.exit(0);
} else if (scenario === "leak") {
  complete();
  const holder = spawn("sleep", ["8"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  holder.unref();
  record({ grandchildPid: holder.pid });
  process.exit(0);
} else if (scenario === "fail") {
  emit({ type: "error", message: `The '${model}' model is not supported.` });
  emit({ type: "turn.failed", error: { message: `The '${model}' model is not supported.` } });
  record();
  process.exit(1);
} else if (scenario === "hang") {
  writeRollout({ input_tokens: 500, cached_input_tokens: 100, output_tokens: 5 });
  // Codex runs tool commands in their own process group; killpg on codex misses them.
  const grandchild = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  record({ grandchildPid: grandchild.pid });
  emit({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "sleep 300", status: "in_progress" },
  });
  process.on("SIGINT", () => {
    if (process.env.FAKE_CODEX_IGNORE_SIGINT === "1") return;
    grandchild.kill("SIGKILL");
    process.exit(1);
  });
  setInterval(() => {}, 1000);
}
