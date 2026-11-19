import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "./adapters/index.ts";
import { DEPTH_ENV, loadConfig, type Config } from "./config.ts";
import { isAlive, ProcessCheckError, signal, sleep } from "./process.ts";
import {
  CorruptMetaError,
  FILES,
  claimJob,
  createJobDir,
  isValidJobId,
  jobDir,
  listJobIds,
  pruneJobs,
  readMeta,
  tryReadMeta,
  writeMeta,
  writePrivateFile,
  type PruneResult,
} from "./store.ts";
import { stopWorkerTree } from "./supervisor.ts";
import {
  isTerminal,
  type DispatchRequest,
  type JobMeta,
  type JobState,
  type TerminalState,
  type Usage,
} from "./types.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const POLL_MS = 500;
/** Minimum interval between process liveness checks for one job while polling. */
const LIVENESS_INTERVAL_MS = 5000;

export class DispatchError extends Error {}

/** Compact token counts for the orchestrator; zero and unreported fields are omitted. */
export interface CompactUsage {
  source: Usage["source"];
  input?: number;
  cached?: number;
  cache_write?: number;
  output?: number;
  reasoning?: number;
  cost_usd?: number;
}

/**
 * What the orchestrator receives for a finished job. Kept small on purpose: every field costs
 * orchestrator tokens. Full details stay in `dir` (meta.json, events.jsonl, stderr.log,
 * last-message.md, prompt.md).
 */
export interface JobResult {
  job_id: string;
  state: JobState;
  final_message?: string;
  final_message_truncated?: true;
  failure_reason?: string;
  exit_code?: number | null;
  /** Only when the harness reports settings that differ from the request. */
  observed?: { model?: string; effort?: string; sandbox?: string };
  usage?: CompactUsage;
  elapsed_s?: number;
  dir: string;
}

export interface JobSummary {
  job_id: string;
  state: JobState;
  elapsed_s?: number;
}

export interface ListedJob extends JobSummary {
  label: string;
  created_at: string;
}

function elapsedSeconds(meta: JobMeta): number | undefined {
  if (!meta.startedAt) return undefined;
  const end = meta.finishedAt ? Date.parse(meta.finishedAt) : Date.now();
  return Math.round((end - Date.parse(meta.startedAt)) / 100) / 10;
}

function compactUsage(usage: Usage): CompactUsage {
  const result: CompactUsage = { source: usage.source };
  const fields = [
    ["inputTokens", "input"],
    ["cachedInputTokens", "cached"],
    ["cacheWriteInputTokens", "cache_write"],
    ["outputTokens", "output"],
    ["reasoningOutputTokens", "reasoning"],
    ["costUsd", "cost_usd"],
  ] as const;
  for (const [from, to] of fields) {
    const value = usage[from];
    if (value) result[to] = value;
  }
  return result;
}

function summary(meta: JobMeta): JobSummary {
  const entry: JobSummary = { job_id: meta.jobId, state: meta.state };
  const elapsed = elapsedSeconds(meta);
  if (elapsed !== undefined) entry.elapsed_s = elapsed;
  return entry;
}

/** Truncates without splitting a surrogate pair. */
function truncate(text: string, cap: number): string {
  const cut = text.slice(0, cap);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export class JobService {
  readonly config: Config;
  /** Environment for supervisors; they derive the same config from it. */
  readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.config = loadConfig(env);
  }

  /** True when this server runs inside a dispatched worker and must not start jobs. */
  get insideWorker(): boolean {
    return Boolean(this.env[DEPTH_ENV]);
  }

  async dispatch(request: DispatchRequest, prompt: string): Promise<JobMeta> {
    if (this.insideWorker) {
      throw new DispatchError(
        `refusing to dispatch from inside a dispatched worker (${DEPTH_ENV} is set)`,
      );
    }
    if (!isAbsolute(request.cwd)) throw new DispatchError(`cwd must be absolute: ${request.cwd}`);
    const cwdStat = await stat(request.cwd).catch(() => undefined);
    if (!cwdStat?.isDirectory()) {
      throw new DispatchError(`cwd does not exist or is not a directory: ${request.cwd}`);
    }
    if (prompt.trim() === "") throw new DispatchError("prompt must not be empty");

    const { jobId, dir } = await createJobDir(this.config.jobsDir, request.label);
    const meta: JobMeta = {
      version: 1,
      jobId,
      createdAt: new Date().toISOString(),
      request,
      state: "queued",
    };
    try {
      await writePrivateFile(join(dir, FILES.prompt), prompt);
      await writeMeta(dir, meta);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }

    // From here on, the supervisor owns meta.json once it claims the job.
    const log = openSync(join(dir, FILES.supervisorLog), "a", 0o600);
    try {
      const supervisor = spawn(process.execPath, [MAIN, "run-job", dir], {
        detached: true,
        stdio: ["ignore", log, log],
        env: this.env,
      });
      supervisor.on("error", (error) => {
        void this.settleUnstarted(dir, "failed", `could not start supervisor: ${error.message}`);
      });
      supervisor.unref();
    } finally {
      closeSync(log);
    }
    return meta;
  }

  private dirFor(jobId: string): string {
    if (!isValidJobId(jobId)) throw new DispatchError(`invalid job id: ${jobId}`);
    return jobDir(this.config.jobsDir, jobId);
  }

  private async load(jobId: string): Promise<JobMeta> {
    let meta: JobMeta | undefined;
    try {
      meta = await tryReadMeta(this.dirFor(jobId));
    } catch (error) {
      if (error instanceof CorruptMetaError) throw new DispatchError(error.message);
      throw error;
    }
    if (!meta) throw new DispatchError(`unknown job: ${jobId}`);
    return meta;
  }

  /**
   * Settles a job whose supervisor never claimed it. Wins only if the server takes the claim;
   * otherwise a supervisor owns the job and the current record is returned.
   */
  private async settleUnstarted(
    dir: string,
    state: TerminalState,
    reason: string,
  ): Promise<JobMeta> {
    if (!(await claimJob(dir, `server ${process.pid}`))) return readMeta(dir);
    const meta = await readMeta(dir);
    const settled: JobMeta = {
      ...meta,
      state,
      finishedAt: new Date().toISOString(),
      failureReason: reason,
      usage: { source: "unknown" },
    };
    await writeMeta(dir, settled);
    return settled;
  }

  async readJob(jobId: string, checkLiveness = true): Promise<JobMeta> {
    const meta = await this.load(jobId);
    return checkLiveness ? this.reconcile(meta) : meta;
  }

  /**
   * Settles a non-terminal job whose supervisor is gone. A supervisor that died mid-run leaves
   * its worker running, so the worker's tree is stopped before the job is marked interrupted.
   * When liveness cannot be determined (e.g. `ps` failed), the job is left untouched.
   */
  async reconcile(meta: JobMeta): Promise<JobMeta> {
    if (isTerminal(meta.state)) return meta;
    const dir = this.dirFor(meta.jobId);

    if (!meta.supervisor) {
      const ageMs = Date.now() - Date.parse(meta.createdAt);
      if (ageMs <= this.config.supervisorStartupSeconds * 1000) return meta;
      return this.settleUnstarted(
        dir,
        "interrupted",
        "supervisor never started; see supervisor.log",
      );
    }

    try {
      if (await isAlive(meta.supervisor)) return meta;
    } catch (error) {
      if (error instanceof ProcessCheckError) return meta;
      throw error;
    }

    // The supervisor wrote a terminal state just before exiting: nothing to settle.
    const fresh = await readMeta(dir);
    if (isTerminal(fresh.state)) return fresh;

    let reason = "supervisor exited without recording a result";
    if (fresh.worker?.startedAt) {
      try {
        if (await isAlive(fresh.worker)) {
          const { cancelSignal } = adapterFor(fresh.request.harness);
          const stopped = await stopWorkerTree(
            fresh.worker,
            cancelSignal,
            this.config.cancelGraceSeconds,
          );
          reason += stopped.leftovers.length
            ? `; orphaned worker stopped, processes not confirmed stopped: ${stopped.leftovers.map((p) => p.pid).join(", ")}`
            : "; orphaned worker stopped";
        }
      } catch (error) {
        if (!(error instanceof ProcessCheckError)) throw error;
        reason += "; worker state unknown";
      }
    }
    const latest = await readMeta(dir);
    if (isTerminal(latest.state)) return latest;
    const interrupted: JobMeta = {
      ...latest,
      state: "interrupted",
      finishedAt: new Date().toISOString(),
      failureReason: reason,
      usage: latest.usage ?? { source: "unknown" },
    };
    await writeMeta(dir, interrupted);
    return interrupted;
  }

  async result(meta: JobMeta): Promise<JobResult> {
    const dir = this.dirFor(meta.jobId);
    const result: JobResult = { job_id: meta.jobId, state: meta.state, dir };
    if (meta.failureReason) result.failure_reason = meta.failureReason;
    if (meta.state !== "completed" && meta.exitCode !== undefined) {
      result.exit_code = meta.exitCode;
    }
    const { request, observed } = meta;
    if (
      observed &&
      ((observed.model !== undefined && observed.model !== request.model) ||
        (observed.effort !== undefined && observed.effort !== request.effort) ||
        (observed.sandbox !== undefined && observed.sandbox !== request.sandbox))
    ) {
      result.observed = observed;
    }
    if (meta.usage) result.usage = compactUsage(meta.usage);
    const elapsed = elapsedSeconds(meta);
    if (elapsed !== undefined) result.elapsed_s = elapsed;

    if (isTerminal(meta.state) && meta.hasFinalMessage !== false) {
      const text = (await readFile(join(dir, FILES.finalMessage), "utf8").catch(() => "")).trim();
      if (text) {
        const cap = this.config.finalMessageCap;
        if (text.length > cap) {
          result.final_message = truncate(text, cap);
          result.final_message_truncated = true;
        } else {
          result.final_message = text;
        }
      }
    }
    return result;
  }

  async wait(
    jobIds: string[],
    timeoutSeconds: number,
    mode: "any" | "all",
  ): Promise<{ done: JobResult[]; pending: JobSummary[] }> {
    if (jobIds.length === 0) throw new DispatchError("job_ids must not be empty");
    const unique = [...new Set(jobIds)];
    for (const id of unique) this.dirFor(id);
    const seconds = Math.min(Math.max(timeoutSeconds, 0), this.config.maxWaitSeconds);
    const deadline = Date.now() + seconds * 1000;
    let lastLivenessCheck = 0;

    for (;;) {
      // Reading meta.json is cheap; liveness checks spawn `ps`, so they are throttled.
      const checkLiveness = Date.now() - lastLivenessCheck >= LIVENESS_INTERVAL_MS;
      if (checkLiveness) lastLivenessCheck = Date.now();
      const metas = await Promise.all(unique.map((id) => this.readJob(id, checkLiveness)));
      const finished = metas.filter((meta) => isTerminal(meta.state));
      const satisfied = mode === "any" ? finished.length > 0 : finished.length === metas.length;
      if (satisfied || Date.now() >= deadline) {
        return {
          done: await Promise.all(finished.map((meta) => this.result(meta))),
          pending: metas.filter((meta) => !isTerminal(meta.state)).map(summary),
        };
      }
      await sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)));
    }
  }

  async cancel(jobId: string): Promise<{ job_id: string; state: JobState; detail?: string }> {
    const respond = (meta: JobMeta, detail?: string) => {
      const response: { job_id: string; state: JobState; detail?: string } = {
        job_id: jobId,
        state: meta.state,
      };
      const text = detail ?? meta.failureReason;
      if (text) response.detail = text;
      return response;
    };

    let meta = await this.readJob(jobId);
    if (isTerminal(meta.state)) return respond(meta, "job had already finished");

    if (!meta.supervisor) {
      // Settle it before any supervisor starts; if one already claimed it, signal it below.
      meta = await this.settleUnstarted(this.dirFor(jobId), "cancelled", "cancelled before start");
      if (isTerminal(meta.state)) return respond(meta);
      const registerDeadline = Date.now() + this.config.supervisorStartupSeconds * 1000;
      while (!meta.supervisor && !isTerminal(meta.state) && Date.now() < registerDeadline) {
        await sleep(100);
        meta = await this.readJob(jobId, false);
      }
      if (isTerminal(meta.state)) return respond(meta);
      if (!meta.supervisor) return respond(meta, "supervisor has not registered yet");
    }

    // The supervisor installs its signal handlers before it registers, so SIGTERM is safe.
    signal(meta.supervisor.pid, "SIGTERM");
    // The supervisor confirms the process tree is gone before recording the final state.
    const deadline = Date.now() + (this.config.cancelGraceSeconds + 15) * 1000;
    while (Date.now() < deadline) {
      meta = await this.readJob(jobId);
      if (isTerminal(meta.state)) return respond(meta);
      await sleep(POLL_MS);
    }
    return respond(meta, "cancel requested; termination not yet confirmed");
  }

  async list(state: JobState | undefined, limit: number): Promise<ListedJob[]> {
    const entries: ListedJob[] = [];
    for (const jobId of await listJobIds(this.config.jobsDir)) {
      if (entries.length >= limit) break;
      let raw: JobMeta | undefined;
      try {
        raw = await tryReadMeta(jobDir(this.config.jobsDir, jobId));
      } catch (error) {
        if (error instanceof CorruptMetaError) continue;
        throw error;
      }
      if (!raw) continue;
      const meta = await this.reconcile(raw);
      if (state && meta.state !== state) continue;
      entries.push({ ...summary(meta), label: meta.request.label, created_at: meta.createdAt });
    }
    return entries;
  }

  /** Settles abandoned jobs, then deletes jobs past the retention period. */
  async prune(): Promise<PruneResult> {
    for (const jobId of await listJobIds(this.config.jobsDir)) {
      try {
        const meta = await tryReadMeta(jobDir(this.config.jobsDir, jobId));
        if (meta) await this.reconcile(meta);
      } catch {
        // Unreadable jobs are handled by pruneJobs by their ID timestamp.
      }
    }
    return pruneJobs(this.config.jobsDir, this.config.retentionDays);
  }
}
