/**
 * Live tests against the real Codex CLI. They consume Codex quota, so they only run with
 * AGENT_DISPATCH_LIVE=1 (`pnpm test:live`). AGENT_DISPATCH_LIVE_MODEL and
 * AGENT_DISPATCH_LIVE_EFFORT select the worker model (defaults: gpt-6-luna, low).
 *
 * The worker environment is built by `liveEnv`: the real codex needs the developer's PATH,
 * HOME/CODEX_HOME and network settings, while every dispatch setting is set by the test.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobService } from "../src/jobs.ts";
import { sleep } from "../src/process.ts";
import type { DispatchRequest } from "../src/types.ts";
import { liveEnv } from "./helpers.ts";

const live = process.env.AGENT_DISPATCH_LIVE === "1";
const model = process.env.AGENT_DISPATCH_LIVE_MODEL ?? "gpt-6-luna";
const effort = process.env.AGENT_DISPATCH_LIVE_EFFORT ?? "low";

/** Jobs to cancel if a test fails midway, so no paid worker outlives the test. */
const running: { service: JobService; jobId: string }[] = [];
afterEach(async () => {
  for (const { service, jobId } of running.splice(0)) await service.cancel(jobId);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-dispatch-live-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  ]);
  return { service: new JobService(liveEnv(join(root, "state"))), repo };
}

function request(cwd: string, label: string): DispatchRequest {
  return { harness: "codex", model, effort, sandbox: "read-only", cwd, timeoutSeconds: 300, label };
}

function processesMatching(pattern: string): string {
  try {
    return execFileSync("pgrep", ["-fl", pattern], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

describe.runIf(live)("live codex", () => {
  it("completes a read-only lookup with reported usage and observed settings", async () => {
    const { service, repo } = await setup();
    const meta = await service.dispatch(
      request(repo, "live-lookup"),
      "What does math.ts export? Answer in one sentence.",
    );
    running.push({ service, jobId: meta.jobId });
    const { done } = await service.wait([meta.jobId], 300, "all");
    const result = done[0]!;
    expect(result.state).toBe("completed");
    expect(result.final_message).toMatch(/add/);
    expect(result.usage?.source).toBe("reported");
    // Observed settings are only returned when they differ from the request.
    expect(result.observed).toBeUndefined();
  }, 320_000);

  it("cancels a running command and leaves no processes behind", async () => {
    const { service, repo } = await setup();
    // A unique duration makes the process pattern specific to this run.
    const marker = `sleep ${170 + Math.floor(Math.random() * 1000)}`;
    const meta = await service.dispatch(
      request(repo, "live-cancel"),
      `Run the shell command \`${marker} && echo done\` and report its output.`,
    );
    running.push({ service, jobId: meta.jobId });
    const deadline = Date.now() + 120_000;
    while (!processesMatching(marker) && Date.now() < deadline) await sleep(500);
    expect(processesMatching(marker)).not.toBe("");

    expect((await service.cancel(meta.jobId)).state).toBe("cancelled");
    expect(processesMatching(marker)).toBe("");
    const { done } = await service.wait([meta.jobId], 5, "all");
    expect(done[0]!.usage?.source).toBe("partial");
  }, 200_000);
});
