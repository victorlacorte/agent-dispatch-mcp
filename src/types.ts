export const HARNESSES = ["codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const SANDBOXES = ["read-only", "workspace-write"] as const;
export type Sandbox = (typeof SANDBOXES)[number];

export const TERMINAL_STATES = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
export const JOB_STATES = ["queued", "running", ...TERMINAL_STATES] as const;
export type JobState = (typeof JOB_STATES)[number];

export function isTerminal(state: JobState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && (JOB_STATES as readonly string[]).includes(value);
}

export interface DispatchRequest {
  harness: Harness;
  model: string;
  effort: string;
  sandbox: Sandbox;
  /** Absolute, existing directory the worker runs in. */
  cwd: string;
  /** Absolute, existing directories the worker may also write; `workspace-write` only. */
  writableDirs?: string[];
  /** Allow network access from the worker's shell; `workspace-write` only. */
  network?: boolean;
  timeoutSeconds: number;
  label: string;
}

export type UsageSource = "reported" | "partial" | "unknown";

/** Token usage as reported by the harness. Fields are absent when the harness did not report them. */
export interface Usage {
  /**
   * `reported`: the harness reported totals for a run that finished normally.
   * `partial`: totals recorded so far by a run that did not finish (e.g. cancelled).
   * `unknown`: no usage could be read. Values are never estimated.
   */
  source: UsageSource;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
}

/**
 * What the harness says it actually used; never inferred from the request. Values use the
 * harness's own vocabulary (e.g. Codex sandbox policy names), so they are plain strings.
 */
export interface Observed {
  model?: string;
  effort?: string;
  sandbox?: string;
}

export interface ProcessIdentity {
  pid: number;
  /** Process start time as reported by `ps -o lstart=`, used to detect pid reuse. */
  startedAt: string;
}

/**
 * Persistent job record. Invariants maintained by the writers:
 * - `running` implies `supervisor` and `startedAt` are set.
 * - Every terminal state has `finishedAt` and `usage`.
 */
export interface JobMeta {
  version: 1;
  jobId: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  request: DispatchRequest;
  state: JobState;
  supervisor?: ProcessIdentity;
  worker?: ProcessIdentity;
  harnessVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Worker exit code; absent when the worker never ran, null when it was killed by a signal. */
  exitCode?: number | null;
  exitSignal?: string | null;
  /** Human-readable reason for any non-completed terminal state. */
  failureReason?: string;
  cancelRequestedAt?: string;
  /** Harness session/thread ID, usable for a later resume. */
  sessionId?: string;
  /** Absolute path of the harness's own session log (the full transcript), when found. */
  sessionLog?: string;
  observed?: Observed;
  usage?: Usage;
  /** True when the worker produced a non-empty final message. */
  hasFinalMessage?: boolean;
}
