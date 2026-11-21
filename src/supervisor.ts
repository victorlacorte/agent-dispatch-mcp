import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { adapterFor } from "./adapters/index.ts";
import type { Enrichment, Launch, ParsedRun } from "./adapters/types.ts";
import type { Config } from "./config.ts";
import {
  descendants,
  killIdentified,
  pidExists,
  processIdentity,
  signal,
  sleep,
  stillRunning,
} from "./process.ts";
import { FILES, claimJob, readMeta, writeMeta } from "./store.ts";
import type { JobMeta, ProcessIdentity, TerminalState, Usage } from "./types.ts";

type CancelReason = Extract<TerminalState, "cancelled" | "timed_out">;
type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** How long to wait for the worker's stdout/stderr to close after it exits. */
const STDIO_DRAIN_MS = 3000;
/** How often the process tree is re-captured while waiting for a cooperative stop. */
const TREE_POLL_MS = 250;
/** How long to wait for SIGKILLed tree members to disappear. */
const KILL_CONFIRM_MS = 5000;

/** Serializes meta writes. A failed write does not block later ones; `flush` reports the first failure. */
class MetaWriter {
  meta: JobMeta;
  private readonly dir: string;
  private chain: Promise<void> = Promise.resolve();
  private firstError: unknown;

  constructor(dir: string, meta: JobMeta) {
    this.dir = dir;
    this.meta = meta;
  }

  update(patch: Partial<JobMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    const snapshot = this.meta;
    this.chain = this.chain
      .then(() => writeMeta(this.dir, snapshot))
      .catch((error: unknown) => {
        this.firstError ??= error;
      });
    return this.chain;
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.firstError !== undefined) throw this.firstError;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

interface StopResult {
  /** Processes from the worker's tree that could not be confirmed stopped. */
  leftovers: ProcessIdentity[];
  /** Set when the process tree could not be fully captured. */
  treeError?: string;
}

/**
 * Stops a worker and every process it started: the adapter's cooperative signal first, then
 * SIGKILL for the worker and any remaining tree member. The tree is captured repeatedly while the
 * worker is alive, because its subprocesses may live in other process groups and become
 * untraceable orphans once it exits.
 */
export async function stopWorkerTree(
  worker: ProcessIdentity,
  cancelSignal: NodeJS.Signals,
  graceSeconds: number,
): Promise<StopResult> {
  const tracked = new Map<string, ProcessIdentity>();
  let treeError: string | undefined;
  const capture = async () => {
    try {
      for (const p of await descendants(worker.pid)) tracked.set(`${p.pid}:${p.startedAt}`, p);
    } catch (error) {
      treeError ??= message(error);
    }
  };

  await capture();
  signal(worker.pid, cancelSignal);
  const deadline = Date.now() + graceSeconds * 1000;
  while (pidExists(worker.pid) && Date.now() < deadline) {
    await capture();
    await sleep(TREE_POLL_MS);
  }
  if (pidExists(worker.pid)) {
    await capture();
    signal(worker.pid, "SIGKILL");
  }

  const tree = [...tracked.values()];
  let leftovers: ProcessIdentity[];
  try {
    await killIdentified(tree);
    const killDeadline = Date.now() + KILL_CONFIRM_MS;
    leftovers = await stillRunning(tree);
    while (leftovers.length > 0 && Date.now() < killDeadline) {
      await sleep(100);
      leftovers = await stillRunning(leftovers);
    }
  } catch (error) {
    treeError ??= message(error);
    leftovers = tree;
  }
  const result: StopResult = { leftovers };
  if (treeError) result.treeError = treeError;
  return result;
}

function finalUsage(parsed: ParsedRun, enrichment: Enrichment, finishedNormally: boolean): Usage {
  if (enrichment.sessionUsage) {
    return { source: finishedNormally ? "reported" : "partial", ...enrichment.sessionUsage };
  }
  if (parsed.usage) return finishedNormally ? parsed.usage : { ...parsed.usage, source: "partial" };
  return { source: "unknown" };
}

/**
 * Runs one job to completion. After claiming the job, this process is the only writer of its
 * meta.json. Signal handlers are installed before anything else, so a cancel arriving at any
 * point is honored instead of killing the supervisor with the default action.
 */
export async function runJob(dir: string, config: Config): Promise<void> {
  let cancelReason: CancelReason | undefined;
  let workerExited = false;
  let onCancel: (() => void) | undefined;
  const requestCancel = (reason: CancelReason) => {
    // Once the worker has exited, its real outcome stands.
    if (workerExited || cancelReason) return;
    cancelReason = reason;
    onCancel?.();
  };
  process.on("SIGTERM", () => requestCancel("cancelled"));
  process.on("SIGINT", () => requestCancel("cancelled"));
  process.on("SIGHUP", () => {
    // Detached from any terminal; hangups are not cancel requests.
  });

  if (!(await claimJob(dir, `supervisor ${process.pid}`))) {
    // The server already settled this job (cancelled before start, or startup took too long).
    return;
  }

  const initial = await readMeta(dir);
  if (initial.state !== "queued") {
    throw new Error(`job ${initial.jobId} is ${initial.state}, expected queued`);
  }
  const writer = new MetaWriter(dir, initial);
  const adapter = adapterFor(initial.request.harness);
  const request = initial.request;

  const finish = async (patch: Partial<JobMeta> & { state: TerminalState }) => {
    await writer.update({
      finishedAt: new Date().toISOString(),
      usage: { source: "unknown" },
      ...patch,
    });
    await writer.flush();
  };
  const cancelledBeforeStart = (reason: CancelReason) =>
    finish({
      state: reason,
      failureReason:
        reason === "timed_out"
          ? "timed out before the worker started"
          : "cancelled before the worker started",
    });

  await writer.update({
    state: "running",
    supervisor: await processIdentity(process.pid),
    startedAt: new Date().toISOString(),
  });
  if (cancelReason) return cancelledBeforeStart(cancelReason);

  const finalMessagePath = join(dir, FILES.finalMessage);
  let launch: Launch;
  try {
    const prompt = await readFile(join(dir, FILES.prompt), "utf8");
    launch = await adapter.launch(request, prompt, { finalMessage: finalMessagePath }, config);
  } catch (error) {
    return finish({ state: "failed", failureReason: message(error) });
  }
  if (cancelReason) return cancelledBeforeStart(cancelReason);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: request.cwd,
      env: { ...process.env, ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return finish({
      state: "failed",
      failureReason: `could not start ${launch.command}: ${message(error)}`,
    });
  }
  const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
  const exited = new Promise<Exit>((resolve) =>
    child.once("exit", (code, sig) => resolve({ code, signal: sig })),
  );
  const stdioClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const workerPid = child.pid;
  if (workerPid === undefined) {
    const error = await spawnError;
    return finish({
      state: "failed",
      failureReason: `could not start ${launch.command}: ${error.message}`,
    });
  }

  // Everything below runs with a live worker: any failure must still stop its process tree.
  const worker: ProcessIdentity = await processIdentity(workerPid).catch(() => ({
    pid: workerPid,
    startedAt: "",
  }));
  let stopping: Promise<StopResult> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      await writer.update({ cancelRequestedAt: new Date().toISOString() });
      return stopWorkerTree(worker, adapter.cancelSignal, config.cancelGraceSeconds);
    })();
    return stopping;
  };
  onCancel = () => void stop();
  const timer = setTimeout(() => requestCancel("timed_out"), request.timeoutSeconds * 1000);

  const parser = adapter.createParser();
  const streamErrors: string[] = [];
  const stderr = createWriteStream(join(dir, FILES.stderr), { mode: 0o600 });

  let harnessVersion: Promise<string | undefined> = Promise.resolve(undefined);
  let internalError: string | undefined;
  let exit: Exit = { code: null, signal: null };
  let stdioLeaked = false;
  try {
    stderr.on("error", (error) => streamErrors.push(message(error)));
    child.stderr.pipe(stderr);
    child.stdin.on("error", () => {
      // The worker may exit before reading stdin; the exit path reports the outcome.
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      parser.push(line);
    });
    child.stdin.end(launch.stdin);
    await writer.update({ worker });
    // Collected while the worker runs; awaited before the final write (it has its own timeout).
    harnessVersion = adapter.version(config);
    if (cancelReason) void stop();

    exit = await exited;
    workerExited = true;
    clearTimeout(timer);
    // A leftover process can hold the worker's stdout open; do not let it hang the job.
    stdioLeaked = await Promise.race([
      stdioClosed.then(() => false),
      sleep(STDIO_DRAIN_MS).then(() => true),
    ]);
    if (stdioLeaked) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
  } catch (error) {
    internalError = message(error);
  }

  let stopResult: StopResult | undefined;
  try {
    if (internalError && !workerExited) await stop();
    if (stopping) stopResult = await stopping;
  } catch (error) {
    internalError ??= message(error);
  }
  clearTimeout(timer);
  await endStream(stderr);

  const parsed = parser.result();
  const enrichment = await adapter.enrich(parsed, config);
  let finalMessage = "";
  try {
    finalMessage = (await readFile(finalMessagePath, "utf8")).trim();
  } catch {
    // Missing file: no final message.
  }

  let state: TerminalState;
  let reason: string | undefined;
  if (internalError) {
    state = "failed";
    reason = `supervisor error: ${internalError}`;
  } else if (cancelReason) {
    state = cancelReason;
    reason =
      cancelReason === "timed_out"
        ? `timed out after ${request.timeoutSeconds}s`
        : "cancelled on request";
  } else if (exit.code === 0 && parsed.completed && !parsed.error) {
    state = "completed";
  } else {
    state = "failed";
    reason =
      parsed.error ??
      (exit.signal ? `worker killed by ${exit.signal}` : `worker exited with code ${exit.code}`);
  }

  const notes: string[] = [];
  if (stopResult?.leftovers.length) {
    notes.push(
      `processes not confirmed stopped: ${stopResult.leftovers.map((p) => p.pid).join(", ")}`,
    );
  }
  if (stopResult?.treeError) notes.push(`process tree not fully captured: ${stopResult.treeError}`);
  if (stdioLeaked) notes.push("worker output was held open by a leftover process");
  if (streamErrors.length > 0) notes.push(`log write errors: ${streamErrors.join("; ")}`);
  const failureReason = [reason, ...notes].filter(Boolean).join("; ");

  const patch: Partial<JobMeta> & { state: TerminalState } = {
    state,
    exitCode: exit.code,
    exitSignal: exit.signal,
    usage: finalUsage(parsed, enrichment, state === "completed"),
    hasFinalMessage: finalMessage.length > 0,
  };
  if (failureReason) patch.failureReason = failureReason;
  if (parsed.sessionId) patch.sessionId = parsed.sessionId;
  if (enrichment.sessionLog) patch.sessionLog = enrichment.sessionLog;
  if (enrichment.observed) patch.observed = enrichment.observed;
  const version = await harnessVersion;
  if (version) patch.harnessVersion = version;
  await finish(patch);
}
