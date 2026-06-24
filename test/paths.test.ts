import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { cacheDir, daemonPaths, indexDbPath, systemdUserDir, qmemdConfigDir, launchAgentsDir, macLogsDir } from "../src/paths.js";

const origXdg = process.env.XDG_CACHE_HOME;
afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origXdg;
});

describe("service config dirs", () => {
  const origCfg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (origCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origCfg;
  });

  test("systemdUserDir honours XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/cfg-test";
    expect(systemdUserDir()).toBe(join("/tmp/cfg-test", "systemd", "user"));
  });

  test("qmemdConfigDir honours XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/cfg-test";
    expect(qmemdConfigDir()).toBe(join("/tmp/cfg-test", "qmemd"));
  });

  test("systemdUserDir falls back to ~/.config/systemd/user when XDG unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(systemdUserDir().endsWith(join(".config", "systemd", "user"))).toBe(true);
  });

  test("launchAgentsDir / macLogsDir resolve under HOME", () => {
    expect(launchAgentsDir().endsWith(join("Library", "LaunchAgents"))).toBe(true);
    expect(macLogsDir().endsWith(join("Library", "Logs"))).toBe(true);
  });
});

describe("cacheDir / daemonPaths", () => {
  test("cacheDir honours XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg-test";
    expect(cacheDir()).toBe(join("/tmp/xdg-test", "qmemd"));
  });

  test("cacheDir falls back to ~/.cache/qmemd when XDG unset", () => {
    delete process.env.XDG_CACHE_HOME;
    expect(cacheDir().endsWith(join(".cache", "qmemd"))).toBe(true);
  });

  test("daemonPaths returns mcp.pid and mcp.log under cacheDir", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg-test";
    const { pidPath, logPath } = daemonPaths();
    expect(pidPath).toBe(join("/tmp/xdg-test", "qmemd", "mcp.pid"));
    expect(logPath).toBe(join("/tmp/xdg-test", "qmemd", "mcp.log"));
  });
});

describe("indexDbPath XDG handling", () => {
  const origDb = process.env.QMEMD_DB;
  afterEach(() => {
    if (origDb === undefined) delete process.env.QMEMD_DB;
    else process.env.QMEMD_DB = origDb;
  });

  test("indexDbPath honours XDG_CACHE_HOME, co-located with cacheDir", () => {
    delete process.env.QMEMD_DB;
    process.env.XDG_CACHE_HOME = "/tmp/xdg-test";
    expect(indexDbPath()).toBe(join("/tmp/xdg-test", "qmemd", "index.sqlite"));
  });

  test("QMEMD_DB overrides XDG_CACHE_HOME", () => {
    process.env.QMEMD_DB = "/pinned/i.sqlite";
    process.env.XDG_CACHE_HOME = "/tmp/xdg-test";
    expect(indexDbPath()).toBe("/pinned/i.sqlite");
  });
});
