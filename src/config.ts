import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Environment variable set in every worker; a server that sees it refuses to dispatch. */
export const DEPTH_ENV = "AGENT_DISPATCH_DEPTH";

export class ConfigError extends Error {}

export interface Config {
  /** Root holding one directory per job. */
  jobsDir: string;
  /** Maximum characters of the worker's final message returned to the orchestrator. */
  finalMessageCap: number;
  /** Upper bound for a single `wait` call, in seconds. */
  maxWaitSeconds: number;
  /** Finished jobs older than this many days are pruned on server start; 0 disables pruning. */
  retentionDays: number;
  /** Seconds between the cooperative cancel signal and SIGKILL of the remaining process tree. */
  cancelGraceSeconds: number;
  /** Seconds a queued job may wait for its supervisor before it is considered interrupted. */
  supervisorStartupSeconds: number;
  codex: {
    /** Executable used for the Codex adapter. */
    bin: string;
    /** Codex home, used to locate session rollout files. */
    home: string;
  };
  /**
   * Names under which this server may be registered in a worker's harness config. Matching
   * servers are disabled for workers (in addition to servers whose command points at this package).
   */
  serverNames: string[];
}

interface IntRange {
  min: number;
  max: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, range: IntRange): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (value < range.min || value > range.max) {
    throw new ConfigError(`${name} must be between ${range.min} and ${range.max}, got ${value}`);
  }
  return value;
}

function absolutePathEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!isAbsolute(raw)) throw new ConfigError(`${name} must be an absolute path, got ${raw}`);
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Per the XDG base directory spec, a relative XDG_STATE_HOME is ignored.
  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(homedir(), ".local", "state");
  const stateDir =
    absolutePathEnv(env, "AGENT_DISPATCH_STATE_DIR") ?? join(stateHome, "agent-dispatch");
  return {
    jobsDir: join(stateDir, "jobs"),
    finalMessageCap: intEnv(env, "AGENT_DISPATCH_FINAL_MESSAGE_CAP", 4000, {
      min: 100,
      max: 1_000_000,
    }),
    maxWaitSeconds: intEnv(env, "AGENT_DISPATCH_MAX_WAIT_SECONDS", 600, { min: 1, max: 3600 }),
    retentionDays: intEnv(env, "AGENT_DISPATCH_RETENTION_DAYS", 14, { min: 0, max: 3650 }),
    cancelGraceSeconds: intEnv(env, "AGENT_DISPATCH_CANCEL_GRACE_SECONDS", 10, {
      min: 1,
      max: 300,
    }),
    supervisorStartupSeconds: intEnv(env, "AGENT_DISPATCH_SUPERVISOR_STARTUP_SECONDS", 30, {
      min: 5,
      max: 600,
    }),
    codex: {
      bin: env.AGENT_DISPATCH_CODEX_BIN || "codex",
      home: absolutePathEnv(env, "CODEX_HOME") ?? join(homedir(), ".codex"),
    },
    serverNames: (env.AGENT_DISPATCH_SERVER_NAMES ?? "agent-dispatch")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  };
}
