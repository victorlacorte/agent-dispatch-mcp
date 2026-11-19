import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIdentity } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Raised when process state could not be determined (e.g. `ps` failed); callers must not assume death. */
export class ProcessCheckError extends Error {}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface ProcessEntry {
  ppid: number;
  startedAt: string;
}

/** Snapshot of all processes: pid to parent pid and start time. */
async function processTable(): Promise<Map<number, ProcessEntry>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,lstart="]));
  } catch (error) {
    throw new ProcessCheckError(
      `ps failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const table = new Map<number, ProcessEntry>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), startedAt: match[3]! });
  }
  return table;
}

/**
 * Returns the process start time, or undefined when the process does not exist.
 * Throws ProcessCheckError when existence could not be determined.
 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (!pidExists(pid)) return undefined;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]));
  } catch (error) {
    // `ps -p` exits 1 when the process vanished between the two checks.
    if (!pidExists(pid)) return undefined;
    throw new ProcessCheckError(
      `ps failed for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return stdout.trim() || undefined;
}

export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const startedAt = await processStartTime(pid);
  if (!startedAt) throw new Error(`process ${pid} not found`);
  return { pid, startedAt };
}

/**
 * True when the identified process is still running (same pid and same start time).
 * Throws ProcessCheckError when this could not be determined.
 */
export async function isAlive(identity: ProcessIdentity): Promise<boolean> {
  return (await processStartTime(identity.pid)) === identity.startedAt;
}

/**
 * Returns all descendants of `pid` with their start times, regardless of process group or session.
 * Must be called while the parent is alive: orphans are reparented and become untraceable.
 */
export async function descendants(pid: number): Promise<ProcessIdentity[]> {
  const table = await processTable();
  const children = new Map<number, ProcessIdentity[]>();
  for (const [child, entry] of table) {
    const list = children.get(entry.ppid) ?? [];
    list.push({ pid: child, startedAt: entry.startedAt });
    children.set(entry.ppid, list);
  }
  const result: ProcessIdentity[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

/** Returns the identified processes that are still the same running process. */
export async function stillRunning(processes: ProcessIdentity[]): Promise<ProcessIdentity[]> {
  if (processes.length === 0) return [];
  const table = await processTable();
  return processes.filter((p) => table.get(p.pid)?.startedAt === p.startedAt);
}

/** Sends SIGKILL to each identified process that is still the same process. Returns those signalled. */
export async function killIdentified(processes: ProcessIdentity[]): Promise<ProcessIdentity[]> {
  const alive = await stillRunning(processes);
  for (const identity of alive) signal(identity.pid, "SIGKILL");
  return alive;
}

export function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until none of `pids` exist or the deadline passes. Returns the pids still alive. */
export async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(pidExists);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter(pidExists);
  }
  return alive;
}
