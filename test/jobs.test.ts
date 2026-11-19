import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobService } from "../src/jobs.ts";
import { pidExists, signal, sleep } from "../src/process.ts";
import { claimJob, createJobDir, readMeta, writeMeta } from "../src/store.ts";
import type { DispatchRequest, JobMeta } from "../src/types.ts";
import { fakeEnv, makeSandbox, readRecord, type Sandbox } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

interface Setup extends Sandbox {
  service: JobService;
}

/** Synchronous cleanups (process kills) run after each test, even when it fails. */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function killLater(pid: number | undefined) {
  if (pid) cleanups.push(() => signal(pid, "SIGKILL"));
}

async function setup(extra: Record<string, string> = {}): Promise<Setup> {
  const sandbox = await makeSandbox("jobs");
  return { ...sandbox, service: new JobService(fakeEnv(sandbox, extra)) };
}

function request(cwd: string, patch: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    harness: "codex",
    model: "gpt-6-luna",
    effort: "max",
    sandbox: "read-only",
    cwd,
    timeoutSeconds: 60,
    label: "test job",
    ...patch,
  };
}

async function waitForState(service: JobService, jobId: string, state: JobMeta["state"]) {
  for (let i = 0; i < 100; i++) {
    const meta = await service.readJob(jobId, false);
    if (meta.state === state && (state !== "running" || meta.worker)) return meta;
    await sleep(100);
  }
  throw new Error(`job ${jobId} never reached ${state}`);
}

/** Starts a worker that hangs with a grandchild in its own process group. */
async function startHanging(
  extra: Record<string, string> = {},
  patch: Partial<DispatchRequest> = {},
) {
  const h = await setup({ FAKE_CODEX_SCENARIO: "hang", ...extra });
  const meta = await h.service.dispatch(request(h.cwd, patch), "p");
  const grandchild = (await readRecord(h.recordPath)).grandchildPid!;
  killLater(grandchild);
  const running = await waitForState(h.service, meta.jobId, "running");
  killLater(running.worker?.pid);
  return { h, meta, grandchild, running };
}

describe("dispatch and wait", () => {
  it("runs a worker to completion and returns a compact result", async () => {
    const h = await setup();
    const meta = await h.service.dispatch(request(h.cwd), "What does math.ts export?");
    expect(meta.state).toBe("queued");

    const { done, pending } = await h.service.wait([meta.jobId], 30, "all");
    expect(pending).toEqual([]);
    expect(done).toEqual([
      {
        job_id: meta.jobId,
        state: "completed",
        final_message: "answer to: What does math.ts export?",
        usage: { source: "reported", input: 1000, cached: 800, output: 50, reasoning: 10 },
        elapsed_s: expect.any(Number),
        dir: join(h.root, "state", "jobs", meta.jobId),
      },
    ]);

    const stored = await readMeta(done[0]!.dir);
    expect(stored).toMatchObject({
      state: "completed",
      harnessVersion: "codex-cli 0.0.0-fake",
      observed: { model: "gpt-6-luna", effort: "max", sandbox: "read-only" },
      exitCode: 0,
      hasFinalMessage: true,
      sessionId: expect.stringMatching(/^01a1ec3a-/),
    });
    expect(stored.failureReason).toBeUndefined();

    const record = await readRecord(h.recordPath);
    expect(record.depth).toBe("1");
    expect(record.codexHome).toBe(h.codexHome);
    expect(record.cwd.endsWith("/repo")).toBe(true);
  });

  it("reports observed settings only when they differ from the request", async () => {
    const h = await setup();
    const meta = await h.service.dispatch(request(h.cwd), "p");
    await h.service.wait([meta.jobId], 30, "all");
    const dir = join(h.service.config.jobsDir, meta.jobId);
    const stored = await readMeta(dir);
    await writeMeta(dir, { ...stored, observed: { ...stored.observed, model: "gpt-other" } });
    const result = await h.service.result(await readMeta(dir));
    expect(result.observed).toEqual({ model: "gpt-other", effort: "max", sandbox: "read-only" });
  });

  it("truncates long final messages without splitting characters", async () => {
    const h = await setup({
      AGENT_DISPATCH_FINAL_MESSAGE_CAP: "100",
      FAKE_CODEX_ANSWER: `${"x".repeat(99)}\u{1F600}tail`,
    });
    const meta = await h.service.dispatch(request(h.cwd), "p");
    const { done } = await h.service.wait([meta.jobId], 30, "all");
    expect(done[0]).toMatchObject({ final_message: "x".repeat(99), final_message_truncated: true });
  });

  it("reports harness failures with the harness's reason", async () => {
    const h = await setup({ FAKE_CODEX_SCENARIO: "fail" });
    const meta = await h.service.dispatch(request(h.cwd, { model: "nope" }), "p");
    const { done } = await h.service.wait([meta.jobId], 30, "all");
    expect(done[0]).toMatchObject({
      state: "failed",
      exit_code: 1,
      failure_reason: "The 'nope' model is not supported.",
      usage: { source: "unknown" },
    });
    expect(done[0]!.final_message).toBeUndefined();
  });

  it("fails cleanly when the harness binary is missing", async () => {
    const h = await setup({ AGENT_DISPATCH_CODEX_BIN: "/nonexistent/codex" });
    const meta = await h.service.dispatch(request(h.cwd), "p");
    const { done } = await h.service.wait([meta.jobId], 30, "all");
    expect(done[0]!.state).toBe("failed");
    expect(done[0]!.failure_reason).toMatch(/could not list Codex MCP servers/);
  });

  it("fails without starting a worker when the recursion guard cannot be applied", async () => {
    const h = await setup();
    await writeFile(join(h.codexHome, "fake-mcp-list.json"), "fail");
    const meta = await h.service.dispatch(request(h.cwd), "p");
    const { done } = await h.service.wait([meta.jobId], 30, "all");
    expect(done[0]!.state).toBe("failed");
    expect(done[0]!.failure_reason).toMatch(/could not list Codex MCP servers/);
    await expect(readFile(h.recordPath)).rejects.toThrow();
  });

  it("returns finished and pending jobs at the timeout (mode all) and honors mode any", async () => {
    const { h, meta: slow } = await startHanging();
    const fast = await new JobService(fakeEnv(h, { FAKE_CODEX_SCENARIO: "success" })).dispatch(
      request(h.cwd, { label: "fast" }),
      "p",
    );

    const any = await h.service.wait([slow.jobId, fast.jobId, fast.jobId], 30, "any");
    expect(any.done.map((r) => r.job_id)).toEqual([fast.jobId]);
    expect(any.pending).toEqual([
      { job_id: slow.jobId, state: "running", elapsed_s: expect.any(Number) },
    ]);

    const all = await h.service.wait([slow.jobId, fast.jobId], 1, "all");
    expect(all.done.map((r) => r.job_id)).toEqual([fast.jobId]);
    expect(all.pending.map((p) => p.job_id)).toEqual([slow.jobId]);

    const started = Date.now();
    const immediate = await h.service.wait([slow.jobId], 0, "all");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(immediate.done).toEqual([]);

    expect((await h.service.cancel(slow.jobId)).state).toBe("cancelled");
  });
});

describe("validation", () => {
  it("refuses to dispatch from inside a worker", async () => {
    const h = await setup({ AGENT_DISPATCH_DEPTH: "1" });
    expect(h.service.insideWorker).toBe(true);
    await expect(h.service.dispatch(request(h.cwd), "p")).rejects.toThrow(
      /inside a dispatched worker/,
    );
    expect(await h.service.list(undefined, 10)).toEqual([]);
  });

  it("rejects relative, missing and non-directory cwd, and empty prompts", async () => {
    const h = await setup();
    await expect(h.service.dispatch(request("repo"), "p")).rejects.toThrow(/absolute/);
    await expect(h.service.dispatch(request(join(h.root, "nope")), "p")).rejects.toThrow(
      /does not exist/,
    );
    await writeFile(join(h.root, "file"), "");
    await expect(h.service.dispatch(request(join(h.root, "file")), "p")).rejects.toThrow(
      /not a directory/,
    );
    await expect(h.service.dispatch(request(h.cwd), "  ")).rejects.toThrow(/empty/);
  });

  it("rejects unknown, malformed and corrupt job ids", async () => {
    const h = await setup();
    await expect(h.service.wait(["../../etc"], 1, "all")).rejects.toThrow(/invalid job id/);
    await expect(h.service.wait(["20260101T000000Z-x-abcd"], 1, "all")).rejects.toThrow(
      /unknown job/,
    );
    const { jobId, dir } = await createJobDir(h.service.config.jobsDir, "x");
    await writeFile(join(dir, "meta.json"), "{");
    await expect(h.service.wait([jobId], 1, "all")).rejects.toThrow(/unparseable job record/);
  });
});

describe("cancellation and timeouts", () => {
  it("cancels via the harness's cooperative signal and confirms the tree is gone", async () => {
    const { h, meta, grandchild } = await startHanging();
    expect(pidExists(grandchild)).toBe(true);
    expect(await h.service.cancel(meta.jobId)).toEqual({
      job_id: meta.jobId,
      state: "cancelled",
      detail: "cancelled on request",
    });
    expect(pidExists(grandchild)).toBe(false);

    const { done } = await h.service.wait([meta.jobId], 1, "all");
    // No terminal usage event: usage comes from the session log and is marked partial.
    expect(done[0]!.usage).toMatchObject({ source: "partial", input: 500 });
    expect((await readMeta(done[0]!.dir)).cancelRequestedAt).toBeDefined();
  });

  it("escalates to SIGKILL for the whole tree when the harness ignores the signal", async () => {
    const { h, meta, grandchild, running } = await startHanging({
      FAKE_CODEX_IGNORE_SIGINT: "1",
    });
    const started = Date.now();
    expect((await h.service.cancel(meta.jobId)).state).toBe("cancelled");
    // The worker ignored SIGINT for the whole 2s grace period and was then killed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(pidExists(grandchild)).toBe(false);
    expect(pidExists(running.worker!.pid)).toBe(false);
    expect((await readMeta(join(h.service.config.jobsDir, meta.jobId))).exitSignal).toBe("SIGKILL");
  });

  it("times out and cleans up", async () => {
    const { h, meta, grandchild } = await startHanging({}, { timeoutSeconds: 1 });
    const { done } = await h.service.wait([meta.jobId], 30, "all");
    expect(done[0]).toMatchObject({ state: "timed_out", failure_reason: "timed out after 1s" });
    expect(pidExists(grandchild)).toBe(false);
  });

  it("reports an already finished job without signalling anything", async () => {
    const h = await setup();
    const meta = await h.service.dispatch(request(h.cwd), "p");
    await h.service.wait([meta.jobId], 30, "all");
    expect(await h.service.cancel(meta.jobId)).toMatchObject({
      state: "completed",
      detail: "job had already finished",
    });
  });

  it("honors a cancel issued immediately after dispatch", async () => {
    for (let i = 0; i < 5; i++) {
      const h = await setup({ FAKE_CODEX_SCENARIO: "hang" });
      const meta = await h.service.dispatch(request(h.cwd), "p");
      expect((await h.service.cancel(meta.jobId)).state).toBe("cancelled");
      // No record means the job was settled before the worker ever started.
      const raw = await readFile(h.recordPath, "utf8").catch(() => undefined);
      const record = raw ? (JSON.parse(raw) as { grandchildPid?: number }) : undefined;
      if (record?.grandchildPid) {
        killLater(record.grandchildPid);
        expect(pidExists(record.grandchildPid)).toBe(false);
      }
    }
  });

  it("keeps the real outcome when a cancel arrives after the worker exited", async () => {
    // The leak scenario completes and exits, but a leftover process holds stdout open, which
    // keeps the supervisor draining output for a few seconds after the worker exited.
    const h = await setup({ FAKE_CODEX_SCENARIO: "leak" });
    const meta = await h.service.dispatch(request(h.cwd, { timeoutSeconds: 2 }), "p");
    killLater((await readRecord(h.recordPath)).grandchildPid);
    const running = await waitForState(h.service, meta.jobId, "running");
    while (pidExists(running.worker!.pid)) await sleep(50);
    signal(running.supervisor!.pid, "SIGTERM");

    const started = Date.now();
    const { done } = await h.service.wait([meta.jobId], 30, "all");
    // Bounded by the stdio drain, not by the 8s leftover process or the 2s timeout.
    expect(Date.now() - started).toBeLessThan(6000);
    expect(done[0]).toMatchObject({
      state: "completed",
      failure_reason: "worker output was held open by a leftover process",
    });
  });
});

/** A queued job whose supervisor was never spawned. */
async function queuedJob(h: Setup, ageSeconds: number) {
  const { jobId, dir } = await createJobDir(h.service.config.jobsDir, "queued");
  await writeFile(join(dir, "prompt.md"), "p");
  await writeMeta(dir, {
    version: 1,
    jobId,
    createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    request: request(h.cwd),
    state: "queued",
  });
  return { jobId, dir };
}

describe("startup races and recovery", () => {
  it("leaves a young queued job alone and settles one whose supervisor never started", async () => {
    const h = await setup();
    const young = await queuedJob(h, 1);
    expect((await h.service.readJob(young.jobId)).state).toBe("queued");
    const stale = await queuedJob(h, 120);
    expect(await h.service.readJob(stale.jobId)).toMatchObject({
      state: "interrupted",
      failureReason: "supervisor never started; see supervisor.log",
    });
  });

  it("cancels a queued job before its supervisor starts; a late supervisor stands down", async () => {
    const h = await setup();
    const { jobId, dir } = await queuedJob(h, 0);
    expect(await h.service.cancel(jobId)).toMatchObject({
      state: "cancelled",
      detail: "cancelled before start",
    });

    const late = spawn(process.execPath, [MAIN, "run-job", dir], {
      env: h.service.env,
      stdio: "ignore",
    });
    expect(await new Promise((resolve) => late.once("exit", resolve))).toBe(0);
    expect((await readMeta(dir)).state).toBe("cancelled");
    await expect(readFile(h.recordPath)).rejects.toThrow();
  });

  it("does not settle a job the supervisor has claimed", async () => {
    const h = await setup();
    const { jobId, dir } = await queuedJob(h, 120);
    expect(await claimJob(dir, "supervisor test")).toBe(true);
    expect((await h.service.readJob(jobId)).state).toBe("queued");
  });

  it("stops the orphaned worker when its supervisor dies", async () => {
    const { h, meta, grandchild, running } = await startHanging();
    signal(running.supervisor!.pid, "SIGKILL");
    while (pidExists(running.supervisor!.pid)) await sleep(50);

    const { done } = await h.service.wait([meta.jobId], 30, "all");
    expect(done[0]).toMatchObject({
      state: "interrupted",
      failure_reason: "supervisor exited without recording a result; orphaned worker stopped",
    });
    expect(pidExists(running.worker!.pid)).toBe(false);
    expect(pidExists(grandchild)).toBe(false);
    expect((await h.service.cancel(meta.jobId)).state).toBe("interrupted");
  });
});

describe("list", () => {
  it("filters by state before applying the limit, newest first", async () => {
    const h = await setup();
    const states = ["completed", "failed", "completed", "failed", "completed"] as const;
    const ids: string[] = [];
    for (const [i, state] of states.entries()) {
      const created = new Date(Date.UTC(2026, 0, 1 + i));
      const { jobId, dir } = await createJobDir(h.service.config.jobsDir, `job-${i}`, created);
      await writeMeta(dir, {
        version: 1,
        jobId,
        createdAt: created.toISOString(),
        request: request(h.cwd, { label: `job-${i}` }),
        state,
        finishedAt: new Date().toISOString(),
        usage: { source: "unknown" },
      });
      ids.push(jobId);
    }
    const completed = await h.service.list("completed", 2);
    expect(completed).toEqual([
      {
        job_id: ids[4],
        state: "completed",
        label: "job-4",
        created_at: "2026-01-05T00:00:00.000Z",
      },
      {
        job_id: ids[2],
        state: "completed",
        label: "job-2",
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect((await h.service.list(undefined, 3)).map((job) => job.job_id)).toEqual([
      ids[4],
      ids[3],
      ids[2],
    ]);
    expect(await h.service.list("running", 10)).toEqual([]);
  });
});
