import type { Config } from "../config.ts";
import type { DispatchRequest, Observed, Usage } from "../types.ts";

export interface Launch {
  command: string;
  args: string[];
  /** Extra environment variables merged over the supervisor's environment. */
  env: Record<string, string>;
  /** Written to the worker's stdin, which is then closed. */
  stdin: string;
}

/** What the adapter learned from the worker's structured output stream. */
export interface ParsedRun {
  sessionId?: string;
  /** Usage from the harness's terminal event; absent when the run ended without one. */
  usage?: Usage;
  /** True when the harness reported normal completion of its turn. */
  completed: boolean;
  /** Fatal error reported by the harness, if any. */
  error?: string;
  /** Non-fatal warnings reported by the harness. */
  warnings: string[];
}

export interface EventParser {
  /** Consumes one line of worker stdout. Lines that are not JSON objects are ignored; never throws. */
  push(line: string): void;
  /** Returns a snapshot; safe to call repeatedly. */
  result(): ParsedRun;
}

export interface Enrichment {
  /** Absolute path of the harness's own session log, which holds the full transcript. */
  sessionLog?: string;
  observed?: Observed;
  /**
   * Cumulative usage recorded by the harness's own session log, including runs that ended
   * without a terminal event. `source` is decided by the supervisor from the run outcome.
   */
  sessionUsage?: Omit<Usage, "source">;
}

/**
 * One implementation per worker harness. Responsibilities beyond launching:
 * - Recursion guard: the launched worker must not be able to reach this dispatch server.
 * - The final message must be written to `paths.finalMessage` (by the harness or the adapter).
 */
export interface WorkerAdapter {
  harness: DispatchRequest["harness"];
  /** Signal that asks the harness to stop and clean up its own subprocesses. */
  cancelSignal: NodeJS.Signals;
  /** Harness version string; must not hang (implementations use a timeout). */
  version(config: Config): Promise<string | undefined>;
  /** Prepares the worker command. Throws when the worker cannot be launched safely. */
  launch(
    request: DispatchRequest,
    prompt: string,
    paths: { finalMessage: string },
    config: Config,
  ): Promise<Launch>;
  createParser(): EventParser;
  /** Reads harness-side records (e.g. session logs) after the run. Never throws. */
  enrich(parsed: ParsedRun, config: Config): Promise<Enrichment>;
}
