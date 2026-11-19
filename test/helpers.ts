import { chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../src/process.ts";

export const FAKE_CODEX = join(import.meta.dirname, "fake-codex.ts");

export interface Sandbox {
  root: string;
  /** Worker working directory. */
  cwd: string;
  codexHome: string;
  /** Where the fake codex records its argv/env for assertions. */
  recordPath: string;
}

export async function makeSandbox(prefix: string): Promise<Sandbox> {
  await chmod(FAKE_CODEX, 0o755);
  const root = await mkdtemp(join(tmpdir(), `agent-dispatch-${prefix}-`));
  const sandbox = {
    root,
    cwd: join(root, "repo"),
    codexHome: join(root, "codex-home"),
    recordPath: join(root, "record.json"),
  };
  await mkdir(sandbox.cwd);
  await mkdir(sandbox.codexHome);
  return sandbox;
}

/**
 * Environment for tests that use the fake codex. Built from scratch (only PATH and HOME are
 * inherited, so the fake's `#!/usr/bin/env node` resolves) and never includes the developer's
 * AGENT_DISPATCH_* settings, so results do not depend on the shell.
 */
export function fakeEnv(sandbox: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENT_DISPATCH_STATE_DIR: join(sandbox.root, "state"),
    AGENT_DISPATCH_CODEX_BIN: FAKE_CODEX,
    AGENT_DISPATCH_CANCEL_GRACE_SECONDS: "2",
    CODEX_HOME: sandbox.codexHome,
    FAKE_CODEX_RECORD: sandbox.recordPath,
    ...extra,
  };
}

/** Variables the real codex needs for its binary, auth, network and temp files. */
const LIVE_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

/**
 * Environment for live tests. The real codex needs the developer's PATH, HOME/CODEX_HOME
 * (auth, config, session logs) and network settings, so those are passed through; every
 * dispatch setting is set explicitly by the test, never inherited.
 */
export function liveEnv(stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of LIVE_PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.AGENT_DISPATCH_STATE_DIR = stateDir;
  return env;
}

export interface FakeRecord {
  args: string[];
  cwd: string;
  depth: string | null;
  codexHome: string | null;
  grandchildPid?: number;
}

export async function readRecord(path: string): Promise<FakeRecord> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as FakeRecord;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("fake codex did not write its record");
}
