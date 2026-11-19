import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { JobService } from "../src/jobs.ts";
import { createServer } from "../src/server.ts";
import { fakeEnv, makeSandbox } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

async function connect(extra: Record<string, string> = {}) {
  const sandbox = await makeSandbox("server");
  const server = createServer(new JobService(fakeEnv(sandbox, extra)), "0.0.0-test");
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, cwd: sandbox.cwd };
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function text(result: CallResult): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

function json(result: CallResult): unknown {
  expect(result.isError).toBeFalsy();
  return JSON.parse(text(result));
}

const dispatchArgs = (cwd: string, patch: Record<string, unknown> = {}) => ({
  harness: "codex",
  model: "gpt-6-luna",
  effort: "low",
  sandbox: "read-only",
  cwd,
  prompt: "hello",
  label: "mcp-test",
  ...patch,
});

describe("MCP server", () => {
  it("exposes four tools within a fixed context budget", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "cancel",
      "dispatch",
      "list",
      "wait",
    ]);
    // Tool definitions are sent to the orchestrator on every turn; keep them small.
    expect(JSON.stringify(tools).length).toBeLessThan(3500);
  });

  it("advertises neither dispatch nor cancel inside a worker", async () => {
    const { client } = await connect({ AGENT_DISPATCH_DEPTH: "1" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(["list", "wait"]);
  });

  it("dispatches, waits, lists and cancels through the protocol", async () => {
    const { client, cwd } = await connect();
    const dispatched = json(
      await client.callTool({ name: "dispatch", arguments: dispatchArgs(cwd) }),
    ) as { job_id: string; state: string };
    expect(dispatched.state).toBe("queued");

    const waitResult = await client.callTool({
      name: "wait",
      arguments: { job_ids: [dispatched.job_id], timeout_s: 30 },
    });
    const waited = json(waitResult) as {
      done: { state: string; final_message: string }[];
      pending: unknown[];
    };
    expect(waited.pending).toEqual([]);
    expect(waited.done[0]).toMatchObject({ state: "completed", final_message: "answer to: hello" });
    // A typical result stays small: the message, usage, and one directory path.
    expect(text(waitResult).length).toBeLessThan(450);

    const listed = json(await client.callTool({ name: "list", arguments: {} })) as {
      job_id: string;
    }[];
    expect(listed.map((job) => job.job_id)).toEqual([dispatched.job_id]);

    expect(
      json(await client.callTool({ name: "cancel", arguments: { job_id: dispatched.job_id } })),
    ).toMatchObject({ state: "completed", detail: "job had already finished" });
  });

  it("returns tool errors for invalid requests", async () => {
    const { client, cwd } = await connect();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["dispatch", dispatchArgs("relative/path"), /absolute/],
      ["dispatch", dispatchArgs(cwd, { model: "--danger" }), /model/],
      ["dispatch", dispatchArgs(cwd, { sandbox: "danger-full-access" }), /sandbox/],
      ["wait", { job_ids: [] }, /job_ids/],
      ["wait", { job_ids: ["x"], timeout_s: 100_000 }, /timeout_s/],
      ["wait", { job_ids: ["20260101T000000Z-x-abcd"] }, /unknown job/],
      ["cancel", { job_id: "../x" }, /invalid job id/],
    ];
    for (const [name, args, pattern] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result)).toMatch(pattern);
    }
  });

  it("writes only JSON-RPC messages to stdout over stdio", async () => {
    const sandbox = await makeSandbox("stdio");
    const child = spawn(process.execPath, [MAIN, "serve"], {
      env: fakeEnv(sandbox, { AGENT_DISPATCH_RETENTION_DAYS: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const responses = new Map<number, unknown>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push(line);
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) responses.set(message.id, message);
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    for (let i = 0; i < 100 && !responses.has(2); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill();
    expect(responses.has(1)).toBe(true);
    expect(responses.has(2)).toBe(true);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  });
});
