import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanEnv } from "./support/env.js";

const CLI = resolve(__dirname, "..", "src", "cli", "qmemd.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(args: string[], cache: string, mem: string) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: "utf-8",
    env: cleanEnv({ XDG_CACHE_HOME: cache, QMD_MEMORY_DIR: mem, QMEMD_DB: join(mem, ".idx", "i.sqlite") }),
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

/**
 * `qmemd mcp token` (qp-http-daemon-no-auth-mio). The daemon authenticates every route but
 * GET /health; the qmemd CLI reads the token file itself, so this verb exists for OTHER
 * clients — an MCP client registered against http://localhost:<port>/mcp must send it as a
 * header. It mints the token when the daemon has not started yet, so a user can configure
 * the client before the first start.
 */
describe("qmemd mcp token", () => {
  let cache: string, mem: string;
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), "qmemd-token-cache-"));
    mem = await mkdtemp(join(tmpdir(), "qmemd-token-mem-"));
  });
  afterEach(async () => {
    await rm(cache, { recursive: true, force: true });
    await rm(mem, { recursive: true, force: true });
  });

  test("prints a 64-hex token, mints it 0600 when absent, and is stable across calls", () => {
    const first = runCli(["mcp", "token"], cache, mem);
    expect(first.status).toBe(0);
    const token = first.stdout.trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((statSync(join(cache, "qmemd", "daemon-token")).mode & 0o777).toString(8)).toBe("600");

    const second = runCli(["mcp", "token"], cache, mem);
    expect(second.stdout.trim()).toBe(token); // a new value would lock out every configured client
  });
});
