import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "..", "src", "cli", "qmemd.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(args: string[], cfg: string, mem: string) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: "utf-8",
    // HOME must be sandboxed too: on darwin the CLI derives launchAgentsDir()/macLogsDir()
    // from homedir() (real $HOME), ignoring XDG_CONFIG_HOME — without this, install/uninstall
    // would clobber and delete the real ~/Library/LaunchAgents/io.qmemd.mcp.plist (qmemd-djw).
    env: { ...process.env, HOME: cfg, XDG_CONFIG_HOME: cfg, QMD_MEMORY_DIR: mem, QMEMD_DB: join(mem, ".idx", "i.sqlite") },
  });
}

describe("qmemd mcp install-service / uninstall-service", () => {
  let cfg: string, mem: string;
  const unitPath = () => join(cfg, "systemd", "user", "qmemd-mcp.service");
  const envPath = () => join(cfg, "qmemd", "daemon.env");
  beforeEach(async () => {
    cfg = await mkdtemp(join(tmpdir(), "qmemd-cfg-"));
    mem = await mkdtemp(join(tmpdir(), "qmemd-mem-"));
  });
  afterEach(async () => {
    await rm(cfg, { recursive: true, force: true });
    await rm(mem, { recursive: true, force: true });
  });

  test("--print emits the unit + activation and writes nothing", () => {
    const res = runCli(["mcp", "install-service", "--print", "--port", "8231"], cfg, mem);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Restart=always");
    expect(res.stdout).toContain("mcp --http --port 8231");
    expect(res.stdout).toContain("systemctl --user enable --now qmemd-mcp.service");
    expect(existsSync(unitPath())).toBe(false);
  });

  test("install-service writes the unit + daemon.env and prints activation", () => {
    const res = runCli(["mcp", "install-service", "--port", "8231"], cfg, mem);
    expect(res.status).toBe(0);
    expect(existsSync(unitPath())).toBe(true);
    expect(existsSync(envPath())).toBe(true);
    expect(res.stdout).toMatch(/wrote/i);
    expect(res.stdout).toContain("systemctl --user enable --now qmemd-mcp.service");
  });

  test("daemon.env pins QMD_MEMORY_DIR and never QMD_EMBED_MODEL", async () => {
    runCli(["mcp", "install-service"], cfg, mem);
    const { readFile } = await import("node:fs/promises");
    const env = await readFile(envPath(), "utf-8");
    expect(env).toContain(`QMD_MEMORY_DIR=${mem}`);
    expect(env).not.toContain("QMD_EMBED_MODEL");
  });

  test("uninstall-service removes the files and prints the disable command", () => {
    runCli(["mcp", "install-service"], cfg, mem);
    const res = runCli(["mcp", "uninstall-service"], cfg, mem);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("systemctl --user disable --now qmemd-mcp.service");
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });
});
