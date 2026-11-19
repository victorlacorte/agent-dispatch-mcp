import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("uses defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual({
      jobsDir: join(homedir(), ".local", "state", "agent-dispatch", "jobs"),
      finalMessageCap: 4000,
      maxWaitSeconds: 600,
      retentionDays: 14,
      cancelGraceSeconds: 10,
      supervisorStartupSeconds: 30,
      codex: { bin: "codex", home: join(homedir(), ".codex") },
      serverNames: ["agent-dispatch"],
    });
  });

  it("applies overrides", () => {
    const config = loadConfig({
      AGENT_DISPATCH_STATE_DIR: "/state",
      AGENT_DISPATCH_FINAL_MESSAGE_CAP: "500",
      AGENT_DISPATCH_MAX_WAIT_SECONDS: "60",
      AGENT_DISPATCH_RETENTION_DAYS: "0",
      AGENT_DISPATCH_CANCEL_GRACE_SECONDS: "3",
      AGENT_DISPATCH_SUPERVISOR_STARTUP_SECONDS: "45",
      AGENT_DISPATCH_CODEX_BIN: "/bin/codex",
      CODEX_HOME: "/codex",
      AGENT_DISPATCH_SERVER_NAMES: " a , ,b.c ",
    });
    expect(config).toMatchObject({
      jobsDir: "/state/jobs",
      finalMessageCap: 500,
      maxWaitSeconds: 60,
      retentionDays: 0,
      cancelGraceSeconds: 3,
      supervisorStartupSeconds: 45,
      codex: { bin: "/bin/codex", home: "/codex" },
      serverNames: ["a", "b.c"],
    });
  });

  it("uses an absolute XDG_STATE_HOME and ignores a relative one", () => {
    expect(loadConfig({ XDG_STATE_HOME: "/xdg" }).jobsDir).toBe("/xdg/agent-dispatch/jobs");
    expect(loadConfig({ XDG_STATE_HOME: "rel" }).jobsDir).toBe(
      join(homedir(), ".local", "state", "agent-dispatch", "jobs"),
    );
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ AGENT_DISPATCH_RETENTION_DAYS: "", CODEX_HOME: "" })).toMatchObject({
      retentionDays: 14,
      codex: { home: join(homedir(), ".codex") },
    });
  });

  it.each(["  ", "0x10", "1e3", "-1", "1.5", "ten"])("rejects the integer %j", (raw) => {
    expect(() => loadConfig({ AGENT_DISPATCH_RETENTION_DAYS: raw })).toThrow(ConfigError);
  });

  it.each([
    ["AGENT_DISPATCH_SUPERVISOR_STARTUP_SECONDS", "0"],
    ["AGENT_DISPATCH_MAX_WAIT_SECONDS", "0"],
    ["AGENT_DISPATCH_CANCEL_GRACE_SECONDS", "0"],
    ["AGENT_DISPATCH_FINAL_MESSAGE_CAP", "10"],
    ["AGENT_DISPATCH_MAX_WAIT_SECONDS", "999999"],
  ])("rejects out-of-range %s=%s", (name, raw) => {
    expect(() => loadConfig({ [name]: raw })).toThrow(/must be between/);
  });

  it.each(["AGENT_DISPATCH_STATE_DIR", "CODEX_HOME"])("rejects a relative %s", (name) => {
    expect(() => loadConfig({ [name]: "relative/dir" })).toThrow(/absolute path/);
  });
});
