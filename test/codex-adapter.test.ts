import { readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexAdapter,
  createCodexParser,
  disableServersOverride,
  readRollout,
  selectDispatchServers,
} from "../src/adapters/codex.ts";
import { loadConfig } from "../src/config.ts";
import type { DispatchRequest } from "../src/types.ts";
import { fakeEnv, makeSandbox } from "./helpers.ts";

const fixtures = join(import.meta.dirname, "fixtures", "codex");

function parseLines(lines: string[]) {
  const parser = createCodexParser();
  for (const line of lines) parser.push(line);
  return parser.result();
}

function parse(name: string) {
  return parseLines(readFileSync(join(fixtures, name), "utf8").split("\n"));
}

const event = (value: unknown) => JSON.stringify(value);

describe("codex event parser", () => {
  it("extracts session id and reported usage from a completed run", () => {
    expect(parse("success.jsonl")).toEqual({
      sessionId: "01a1ec39-7a33-7ca3-b37f-c52fb7f79bd1",
      completed: true,
      warnings: [],
      usage: {
        source: "reported",
        inputTokens: 46005,
        cachedInputTokens: 37760,
        cacheWriteInputTokens: 0,
        outputTokens: 180,
        reasoningOutputTokens: 0,
      },
    });
  });

  it("reports turn.failed as an error and keeps non-fatal error items as warnings", () => {
    const run = parse("invalid-model.jsonl");
    expect(run.completed).toBe(false);
    expect(run.error).toBe(
      "The 'gpt-nonexistent-9' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(run.warnings).toHaveLength(1);
    expect(run.usage).toBeUndefined();
  });

  it("has no usage or error for an interrupted run", () => {
    expect(parse("cancelled.jsonl")).toEqual({
      sessionId: "01a1ec3a-0000-7000-8000-000000000004",
      completed: false,
      warnings: [],
    });
  });

  it.each(["not json", "", "null", "5", "true", '"x"', "[]", "[1]"])(
    "ignores the non-object line %j",
    (line) => {
      expect(parseLines([line])).toEqual({ completed: false, warnings: [] });
    },
  );

  it("uses the last error event when the run fails without a turn.failed message", () => {
    expect(parseLines([event({ type: "error", message: "boom" })]).error).toBe("boom");
    expect(
      parseLines([event({ type: "error", message: "boom" }), event({ type: "turn.failed" })]).error,
    ).toBe("boom");
    expect(parseLines([event({ type: "turn.failed", error: {} })]).error).toBe("turn failed");
  });

  it("does not treat a transient error event as fatal when the turn completes", () => {
    const run = parseLines([
      event({ type: "error", message: "reconnecting" }),
      event({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ]);
    expect(run.error).toBeUndefined();
    expect(run.completed).toBe(true);
  });

  it("keeps the last turn's usage and ignores non-numeric fields", () => {
    const run = parseLines([
      event({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }),
      event({ type: "turn.completed", usage: { input_tokens: 15, output_tokens: null, x: "y" } }),
    ]);
    expect(run.usage).toEqual({ source: "reported", inputTokens: 15 });
  });

  it("handles turn.completed without usage", () => {
    expect(parseLines([event({ type: "turn.completed" })])).toEqual({
      completed: true,
      warnings: [],
    });
  });

  it("returns independent snapshots", () => {
    const parser = createCodexParser();
    parser.push(event({ type: "item.completed", item: { type: "error", message: "w1" } }));
    const first = parser.result();
    first.warnings.push("mutated");
    parser.push(event({ type: "item.completed", item: { type: "error", message: "w2" } }));
    expect(parser.result().warnings).toEqual(["w1", "w2"]);
  });
});

describe("codex rollout reader", () => {
  it("returns observed settings and the latest cumulative usage", async () => {
    expect(await readRollout(join(fixtures, "rollout.jsonl"))).toEqual({
      observed: { model: "gpt-6-luna", effort: "medium", sandbox: "read-only" },
      sessionUsage: {
        inputTokens: 30529,
        cachedInputTokens: 22784,
        cacheWriteInputTokens: 0,
        outputTokens: 95,
        reasoningOutputTokens: 0,
      },
    });
  });
});

describe("enrich", () => {
  const sessionId = "01a1ec39-7a33-7ca3-b37f-c52fb7f79bd1";

  async function homeWithRollout() {
    const sandbox = await makeSandbox("enrich");
    const day = join(sandbox.codexHome, "sessions", "2026", "11", "17");
    await mkdir(day, { recursive: true });
    await cp(
      join(fixtures, "rollout.jsonl"),
      join(day, `rollout-2026-11-17T00-00-00-${sessionId}.jsonl`),
    );
    return loadConfig(fakeEnv(sandbox));
  }

  it("finds the rollout for the session", async () => {
    const config = await homeWithRollout();
    const enrichment = await codexAdapter.enrich(
      { sessionId, completed: true, warnings: [] },
      config,
    );
    expect(enrichment.observed?.model).toBe("gpt-6-luna");
  });

  it.each(["../x", "*", "01a1ec39-7a33-7ca3-b37f-c52fb7f79bd2", ""])(
    "returns nothing for session id %j",
    async (id) => {
      const config = await homeWithRollout();
      expect(
        await codexAdapter.enrich({ sessionId: id, completed: true, warnings: [] }, config),
      ).toEqual({});
    },
  );
});

describe("recursion guard", () => {
  const root = "/opt/agent-dispatch-mcp/";
  const servers = [
    { name: "agent-dispatch", enabled: true, transport: { command: "npx", args: ["x"] } },
    {
      name: "renamed",
      enabled: true,
      transport: { command: "node", args: [`${root}src/main.ts`, "serve"] },
    },
    { name: "direct", enabled: true, transport: { command: `${root}src/main.ts`, args: [] } },
    { name: "other", enabled: true, transport: { command: "node", args: ["/opt/other/main.ts"] } },
    {
      name: "already-off",
      enabled: false,
      transport: { command: "node", args: [`${root}src/main.ts`] },
    },
    {
      name: "sibling",
      enabled: true,
      transport: { command: "node", args: ["/opt/agent-dispatch-mcp-fork/x"] },
    },
  ];

  it("selects servers by configured name or by pointing into this package", () => {
    expect(selectDispatchServers(servers, ["agent-dispatch"], root)).toEqual([
      "agent-dispatch",
      "renamed",
      "direct",
    ]);
  });

  it("builds an inline-table override, which is safe for dotted names", () => {
    expect(disableServersOverride([])).toBeUndefined();
    expect(disableServersOverride(["a.b", 'q"x'])).toBe(
      'mcp_servers={"a.b"={enabled=false},"q\\"x"={enabled=false}}',
    );
  });
});

const request = (cwd: string): DispatchRequest => ({
  harness: "codex",
  model: "gpt-6-luna",
  effort: "max",
  sandbox: "read-only",
  cwd,
  timeoutSeconds: 60,
  label: "x",
});

describe("launch", () => {
  it("builds the exec command and disables this server for the worker", async () => {
    const sandbox = await makeSandbox("launch");
    const list = JSON.stringify([
      { name: "agent.dispatch", enabled: true, transport: { command: "node", args: [] } },
      { name: "other", enabled: true, transport: { command: "node", args: [] } },
    ]);
    await writeFile(join(sandbox.codexHome, "fake-mcp-list.json"), list);
    const config = loadConfig(fakeEnv(sandbox, { AGENT_DISPATCH_SERVER_NAMES: "agent.dispatch" }));
    const launch = await codexAdapter.launch(
      request(sandbox.cwd),
      "prompt",
      { finalMessage: "/out.md" },
      config,
    );
    expect(launch).toEqual({
      command: config.codex.bin,
      args: [
        "exec",
        "--json",
        "-m",
        "gpt-6-luna",
        "-c",
        'model_reasoning_effort="max"',
        "-c",
        'mcp_servers={"agent.dispatch"={enabled=false}}',
        "-s",
        "read-only",
        "-C",
        sandbox.cwd,
        "-o",
        "/out.md",
        "-",
      ],
      env: { AGENT_DISPATCH_DEPTH: "1", CODEX_HOME: sandbox.codexHome },
      stdin: "prompt",
    });
  });

  it("omits the override when no dispatch server is configured", async () => {
    const sandbox = await makeSandbox("launch-none");
    const config = loadConfig(fakeEnv(sandbox));
    const launch = await codexAdapter.launch(
      request(sandbox.cwd),
      "p",
      { finalMessage: "/out.md" },
      config,
    );
    expect(launch.args.filter((arg) => arg.startsWith("mcp_servers"))).toEqual([]);
  });

  it("fails closed when the MCP server list is unavailable", async () => {
    const sandbox = await makeSandbox("launch-fail");
    await writeFile(join(sandbox.codexHome, "fake-mcp-list.json"), "fail");
    const config = loadConfig(fakeEnv(sandbox));
    await expect(
      codexAdapter.launch(request(sandbox.cwd), "p", { finalMessage: "/out.md" }, config),
    ).rejects.toThrow(/could not list Codex MCP servers/);
  });
});
