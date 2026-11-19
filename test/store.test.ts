import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CorruptMetaError,
  claimJob,
  createJobDir,
  isValidJobId,
  jobDir,
  jobIdTime,
  listJobIds,
  pruneJobs,
  readMeta,
  tryReadMeta,
  writeMeta,
} from "../src/store.ts";
import type { JobMeta } from "../src/types.ts";

let jobsDir: string;
beforeEach(async () => {
  jobsDir = join(await mkdtemp(join(tmpdir(), "agent-dispatch-store-")), "jobs");
});

function meta(jobId: string, patch: Partial<JobMeta> = {}): JobMeta {
  return {
    version: 1,
    jobId,
    createdAt: new Date().toISOString(),
    state: "queued",
    request: {
      harness: "codex",
      model: "m",
      effort: "low",
      sandbox: "read-only",
      cwd: "/tmp",
      timeoutSeconds: 60,
      label: "x",
    },
    ...patch,
  };
}

describe("job ids", () => {
  it("encode UTC time, so ordering survives DST changes", async () => {
    // 05:30Z and 06:30Z are both 01:30 in New York on the DST fall-back day.
    const first = await createJobDir(jobsDir, "j", new Date("2026-11-01T05:30:00Z"));
    const second = await createJobDir(jobsDir, "j", new Date("2026-11-01T06:30:00Z"));
    expect(first.jobId).toMatch(/^20261101T053000Z-j-[0-9a-f]{4}$/);
    expect(second.jobId).toMatch(/^20261101T063000Z-j-[0-9a-f]{4}$/);
    expect(await listJobIds(jobsDir)).toEqual([second.jobId, first.jobId]);
    expect(jobIdTime(first.jobId)).toBe(Date.parse("2026-11-01T05:30:00Z"));
  });

  it("are unique within the same second and label", async () => {
    const now = new Date("2026-11-17T09:05:03Z");
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await createJobDir(jobsDir, "Lint Check!", now)).jobId);
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^20261117T090503Z-lint-check-[0-9a-f]{4}$/);
  });

  it("slugify labels: truncation, trailing hyphens, non-ASCII, empty", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const long = await createJobDir(jobsDir, `${"a".repeat(39)}-b`, now);
    expect(long.jobId).toMatch(new RegExp(`^20260101T000000Z-${"a".repeat(39)}-[0-9a-f]{4}$`));
    expect((await createJobDir(jobsDir, "Café über", now)).jobId).toMatch(/-caf-ber-[0-9a-f]{4}$/);
    expect((await createJobDir(jobsDir, "!!!", now)).jobId).toMatch(/-job-[0-9a-f]{4}$/);
  });

  it.each([
    "",
    "..",
    "../etc",
    "a/b",
    "20261117T090503Z-x-abcd\n",
    "20261117T090503Z-X-abcd",
    "20261117T09050Z-x-abcd",
    "20261117-090503-x-abcd",
    "20261117T090503Z--abcd",
    "20261117T090503Z-x-abcg",
  ])("rejects %j", (id) => {
    expect(isValidJobId(id)).toBe(false);
  });

  it("accepts generated shapes", () => {
    expect(isValidJobId("20261117T090503Z-x-abcd")).toBe(true);
    expect(isValidJobId("20261117T090503Z-lint-check-0f9e")).toBe(true);
  });

  it("creates private directories", async () => {
    const { dir } = await createJobDir(jobsDir, "x");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe("listJobIds", () => {
  it("lists newest first and ignores unrelated entries", async () => {
    const a = await createJobDir(jobsDir, "a", new Date("2026-01-01T00:00:00Z"));
    const c = await createJobDir(jobsDir, "c", new Date("2026-03-01T00:00:00Z"));
    const b = await createJobDir(jobsDir, "b", new Date("2026-06-01T00:00:00Z"));
    await writeFile(join(jobsDir, "notes.txt"), "");
    await mkdir(join(jobsDir, "keep"));
    await mkdir(join(jobsDir, "20261117T090503Z-UPPER-abcd"));
    expect(await listJobIds(jobsDir)).toEqual([b.jobId, c.jobId, a.jobId]);
  });

  it("returns an empty list when the jobs directory does not exist", async () => {
    expect(await listJobIds(join(jobsDir, "missing"))).toEqual([]);
  });
});

describe("meta files", () => {
  it("round-trips with private permissions and no leftover temp files", async () => {
    const { jobId, dir } = await createJobDir(jobsDir, "x");
    await writeMeta(dir, meta(jobId));
    await writeMeta(dir, meta(jobId, { state: "running" }));
    expect((await readMeta(dir)).state).toBe("running");
    expect(await readdir(dir)).toEqual(["meta.json"]);
    expect((await stat(join(dir, "meta.json"))).mode & 0o777).toBe(0o600);
  });

  it("is never observed half-written by concurrent readers", async () => {
    const { jobId, dir } = await createJobDir(jobsDir, "x");
    const big = meta(jobId, { failureReason: "x".repeat(200_000) });
    await writeMeta(dir, big);
    const progress = { writing: true };
    const writer = (async () => {
      for (let i = 0; i < 100; i++) await writeMeta(dir, { ...big, exitCode: i });
      progress.writing = false;
    })();
    let reads = 0;
    while (progress.writing) {
      // A non-atomic write would expose truncated JSON here.
      const raw = await readFile(join(dir, "meta.json"), "utf8");
      JSON.parse(raw);
      reads++;
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
  });

  it("distinguishes a missing record from a corrupt one", async () => {
    const { jobId, dir } = await createJobDir(jobsDir, "x");
    expect(await tryReadMeta(dir)).toBeUndefined();
    for (const content of [
      "{not json",
      "null",
      "[]",
      "5",
      JSON.stringify({ ...meta(jobId), version: 2 }),
    ]) {
      await writeFile(join(dir, "meta.json"), content);
      await expect(tryReadMeta(dir)).rejects.toThrow(CorruptMetaError);
    }
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta("20200101T000000Z-other-abcd")));
    await expect(readMeta(dir)).rejects.toThrow(CorruptMetaError);
  });
});

describe("claimJob", () => {
  it("lets exactly one claimant win", async () => {
    const { dir } = await createJobDir(jobsDir, "x");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claimJob(dir, `owner ${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

async function make(created: Date, patch: Partial<JobMeta> | "none" | "corrupt") {
  const { jobId, dir } = await createJobDir(jobsDir, "x", created);
  if (patch === "corrupt") await writeFile(join(dir, "meta.json"), "{");
  else if (patch !== "none")
    await writeMeta(dir, meta(jobId, { createdAt: created.toISOString(), ...patch }));
  return jobId;
}

describe("pruneJobs", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-18T12:00:00Z");
  const old = new Date(now - 20 * day);
  const recent = new Date(now - day);

  it("removes old finished jobs and old unreadable ones, keeping everything else", async () => {
    const terminal = await Promise.all(
      (["completed", "failed", "timed_out", "cancelled", "interrupted"] as const).map((state) =>
        make(old, { state, finishedAt: old.toISOString() }),
      ),
    );
    const oldMissing = await make(old, "none");
    const oldCorrupt = await make(old, "corrupt");
    const terminalNoFinish = await make(old, { state: "completed" });
    const invalidFinish = await make(old, { state: "completed", finishedAt: "not a date" });
    const keep = [
      await make(old, { state: "failed", finishedAt: recent.toISOString() }),
      await make(old, { state: "running" }),
      await make(old, { state: "queued" }),
      await make(recent, "none"),
      await make(recent, "corrupt"),
    ];

    const { pruned, errors } = await pruneJobs(jobsDir, 14, now);
    expect(errors).toEqual([]);
    expect(pruned.toSorted()).toEqual(
      [...terminal, oldMissing, oldCorrupt, terminalNoFinish, invalidFinish].toSorted(),
    );
    expect((await listJobIds(jobsDir)).toSorted()).toEqual(keep.toSorted());
    expect(await readdir(jobsDir)).toHaveLength(keep.length);
  });

  it("keeps jobs exactly at the cutoff", async () => {
    const cutoff = new Date(now - 14 * day);
    await make(cutoff, { state: "completed", finishedAt: cutoff.toISOString() });
    expect((await pruneJobs(jobsDir, 14, now)).pruned).toEqual([]);
  });

  it("is disabled by a retention of 0", async () => {
    await make(old, { state: "completed", finishedAt: old.toISOString() });
    expect(await pruneJobs(jobsDir, 0, now)).toEqual({ pruned: [], errors: [] });
  });

  it("returns nothing for a missing jobs directory", async () => {
    expect(await pruneJobs(join(jobsDir, "missing"), 14, now)).toEqual({ pruned: [], errors: [] });
  });

  it("continues past a job it cannot read", async () => {
    const unreadable = await make(old, { state: "completed", finishedAt: old.toISOString() });
    const prunable = await make(old, { state: "completed", finishedAt: old.toISOString() });
    // A directory in place of meta.json makes reading it fail with EISDIR.
    const dir = jobDir(jobsDir, unreadable);
    await rm(join(dir, "meta.json"));
    await mkdir(join(dir, "meta.json"));
    const { pruned, errors } = await pruneJobs(jobsDir, 14, now);
    expect(pruned).toEqual([prunable]);
    expect(errors.map((e) => e.jobId)).toEqual([unreadable]);
  });
});
