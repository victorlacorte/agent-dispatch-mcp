import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isJobState, isTerminal, type JobMeta } from "./types.ts";

/** File names inside a job directory. */
export const FILES = {
  meta: "meta.json",
  /** Created exclusively by whichever process takes ownership of starting or settling the job. */
  claim: "claim",
  prompt: "prompt.md",
  stderr: "stderr.log",
  finalMessage: "final-message.md",
  supervisorLog: "supervisor.log",
} as const;

/** Job files may contain prompts, repository content and worker output: owner access only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class CorruptMetaError extends Error {}

export function jobDir(jobsDir: string, jobId: string): string {
  return join(jobsDir, jobId);
}

const MAX_SLUG = 40;

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || "job";
}

/** UTC timestamp, so IDs sort chronologically regardless of time zone or DST changes. */
function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

const JOB_ID_PATTERN = new RegExp(
  `^(\\d{8}T\\d{6}Z)-[a-z0-9](?:[a-z0-9-]{0,${MAX_SLUG - 2}}[a-z0-9])?-[0-9a-f]{4}$`,
);

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

/** Creation time encoded in a job ID, in milliseconds since the epoch. */
export function jobIdTime(jobId: string): number | undefined {
  const stamp = JOB_ID_PATTERN.exec(jobId)?.[1];
  if (!stamp) return undefined;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13)}`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Creates a uniquely named job directory. `mkdir` without `recursive` fails if the
 * directory exists, which makes the name reservation atomic across concurrent servers.
 * Four random hex characters keep IDs readable; collisions within one second and label retry.
 */
export async function createJobDir(
  jobsDir: string,
  label: string,
  now = new Date(),
): Promise<{ jobId: string; dir: string }> {
  await mkdir(jobsDir, { recursive: true, mode: DIR_MODE });
  for (let attempt = 0; attempt < 16; attempt++) {
    const jobId = `${timestamp(now)}-${slugify(label)}-${randomBytes(2).toString("hex")}`;
    const dir = jobDir(jobsDir, jobId);
    try {
      await mkdir(dir, { mode: DIR_MODE });
      return { jobId, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a unique job directory");
}

/** Writes a file atomically: readers see either the old or the new content, never a partial write. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, content, { mode: FILE_MODE });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: FILE_MODE });
}

/**
 * Atomically takes ownership of a job's start. The supervisor claims before running; the
 * server claims only to settle a job whose supervisor never started. Exactly one succeeds.
 */
export async function claimJob(dir: string, owner: string): Promise<boolean> {
  try {
    const handle = await open(join(dir, FILES.claim), "wx", FILE_MODE);
    await handle.writeFile(`${owner}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function writeMeta(dir: string, meta: JobMeta): Promise<void> {
  await writeFileAtomic(join(dir, FILES.meta), `${JSON.stringify(meta, null, 2)}\n`);
}

function validateMeta(value: unknown, dir: string): JobMeta {
  const meta = value as Partial<JobMeta> | null;
  if (
    typeof meta !== "object" ||
    meta === null ||
    Array.isArray(meta) ||
    meta.version !== 1 ||
    typeof meta.jobId !== "string" ||
    basename(dir) !== meta.jobId ||
    !isJobState(meta.state) ||
    typeof meta.request !== "object" ||
    typeof meta.createdAt !== "string"
  ) {
    throw new CorruptMetaError(`invalid job record in ${dir}`);
  }
  return meta as JobMeta;
}

export async function readMeta(dir: string): Promise<JobMeta> {
  const raw = await readFile(join(dir, FILES.meta), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptMetaError(`unparseable job record in ${dir}`);
  }
  return validateMeta(parsed, dir);
}

/** Returns undefined when the job has no meta.json yet; throws CorruptMetaError when it is invalid. */
export async function tryReadMeta(dir: string): Promise<JobMeta | undefined> {
  try {
    return await readMeta(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Lists job IDs, newest first. Job IDs sort chronologically by construction (UTC timestamps). */
export async function listJobIds(jobsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(jobsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter(isValidJobId).toSorted().toReversed();
}

export interface PruneResult {
  pruned: string[];
  errors: { jobId: string; error: string }[];
}

/**
 * Deletes jobs older than the retention period: finished jobs by `finishedAt`, and jobs
 * without a readable record by the creation time in their ID. Unfinished jobs are kept; the
 * caller reconciles them first. A failure on one job does not stop the others.
 */
export async function pruneJobs(
  jobsDir: string,
  retentionDays: number,
  now = Date.now(),
): Promise<PruneResult> {
  const result: PruneResult = { pruned: [], errors: [] };
  if (retentionDays === 0) return result;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const jobId of await listJobIds(jobsDir)) {
    const dir = jobDir(jobsDir, jobId);
    try {
      let reference: number | undefined;
      try {
        const meta = await tryReadMeta(dir);
        if (!meta) {
          reference = jobIdTime(jobId);
        } else if (isTerminal(meta.state)) {
          // Fall back to older timestamps when a terminal record lacks a valid finish time.
          reference =
            [meta.finishedAt, meta.createdAt]
              .map((value) => (value ? Date.parse(value) : Number.NaN))
              .find((value) => !Number.isNaN(value)) ?? jobIdTime(jobId);
        }
      } catch (error) {
        if (!(error instanceof CorruptMetaError)) throw error;
        reference = jobIdTime(jobId);
      }
      if (reference !== undefined && !Number.isNaN(reference) && reference < cutoff) {
        await rm(dir, { recursive: true, force: true });
        result.pruned.push(jobId);
      }
    } catch (error) {
      result.errors.push({ jobId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
