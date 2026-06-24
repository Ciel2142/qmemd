import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "..", "src", "cli", "qmemd.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(args: string[], cache: string, mem: string) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, XDG_CACHE_HOME: cache, QMD_MEMORY_DIR: mem, QMEMD_DB: join(mem, ".idx", "i.sqlite") },
  });
}

describe("qmemd mcp stop", () => {
  let cache: string, mem: string;
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), "qmemd-cache-"));
    mem = await mkdtemp(join(tmpdir(), "qmemd-mem-"));
  });
  afterEach(async () => {
    await rm(cache, { recursive: true, force: true });
    await rm(mem, { recursive: true, force: true });
  });

  test("stop with no pidfile reports not running and exits 0", () => {
    const res = runCli(["mcp", "stop"], cache, mem);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not running/i);
  });

  test("stop with a stale pidfile cleans it up", async () => {
    const pidPath = join(cache, "qmemd", "mcp.pid");
    await mkdir(join(cache, "qmemd"), { recursive: true }); // cacheDir() — created lazily by the daemon path, so seed it for this fixture
    await writeFile(pidPath, "999999"); // a pid that is not alive
    const res = runCli(["mcp", "stop"], cache, mem);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/stale/i);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("unknown subcommand exits non-zero", () => {
    const res = runCli(["mcp", "bogus"], cache, mem);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unknown subcommand/i);
  });
});

// End-to-end daemon lifecycle. Binds a real port → skip in CI to avoid flakiness.
describe.skipIf(!!process.env.CI)("qmemd mcp --http --daemon lifecycle", () => {
  let cache: string, mem: string;
  const PORT = 8231; // uncommon; --daemon binds it, the test curls it, then stops it
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), "qmemd-cache-"));
    mem = await mkdtemp(join(tmpdir(), "qmemd-mem-"));
  });
  afterEach(async () => {
    runCli(["mcp", "stop"], cache, mem); // ensure stopped even if an assertion failed
    await rm(cache, { recursive: true, force: true });
    await rm(mem, { recursive: true, force: true });
  });

  test("daemon starts, answers /health, and stop kills it", async () => {
    const start = runCli(["mcp", "--http", "--daemon", "--port", String(PORT)], cache, mem);
    expect(start.status).toBe(0);
    expect(start.stdout).toMatch(new RegExp(`localhost:${PORT}/mcp`));
    expect(existsSync(join(cache, "qmemd", "mcp.pid"))).toBe(true);

    // Poll /health until the detached server has bound the port (≤5s).
    let ok = false;
    for (let i = 0; i < 25; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/health`);
        if (res.status === 200) { ok = true; break; }
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(ok).toBe(true);

    const stop = runCli(["mcp", "stop"], cache, mem);
    expect(stop.status).toBe(0);
    expect(stop.stdout).toMatch(/stopped/i);
  });
});
