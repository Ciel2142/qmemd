import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { rootHash } from "../src/client.js";

// CLI wiring for warm-daemon recall delegation (qmemd-vuk): a HYBRID `qmemd recall`
// probes the daemon and serves its answer without opening the local store (no cold
// model load); --lex and --session never probe (already model-free and fast). The
// stub daemon stands in for qmemd-mcp.service — these tests never load the model:
// the delegated path is answered by the stub, and the never-probe cases use the
// lex/session local paths.

const CLI = resolve(__dirname, "..", "src", "cli", "qmemd.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

let root: string;
let server: Server | undefined;
const state = { healthCalls: 0, recallCalls: 0 };

// Async spawn, NOT spawnSync: the stub daemon runs on THIS process's event loop, and
// spawnSync would block it — the child's health probe could never be accepted, every
// delegation would time out, and the tests would "pass" through the local fallback.
function runCli(args: string[], port: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(TSX, [CLI, ...args], {
      env: {
        ...process.env,
        QMD_MEMORY_DIR: root,
        QMEMD_DB: join(root, ".idx", "i.sqlite"),
        QMEMD_HTTP_PORT: String(port),
      },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => { stdout += c; });
    p.stderr.on("data", (c) => { stderr += c; });
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Stub daemon answering /health with the hash of THIS test's root + one canned hit. */
async function startStub(): Promise<number> {
  state.healthCalls = 0;
  state.recallCalls = 0;
  server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      state.healthCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: 1, rootHash: rootHash(root) }));
      return;
    }
    if (req.url === "/recall" && req.method === "POST") {
      state.recallCalls++;
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        hits: [{ slug: "warm-stub-hit", type: "project", description: "answer from the warm daemon", score: 0.8, body: "stub body", platforms: [] }],
        degraded: false, vectorsPending: 0, moreMatches: 2, belowFloor: 0, saturated: false,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server!.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-delegate-")); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise((r) => server!.close(r)); server = undefined; }
  await rm(root, { recursive: true, force: true });
});

describe("CLI recall delegation (qmemd-vuk)", () => {
  test("hybrid recall is served by the daemon: stub hit rendered, footer attached, store untouched", async () => {
    const port = await startStub();
    const res = await runCli(["recall", "anything warm"], port);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("answer from the warm daemon");
    expect(res.stdout).toContain("warm-stub-hit");
    expect(res.stdout).toContain("stub body");
    // completeness footer (40h) renders from the delegated counters too
    expect(res.stdout).toContain("2 more match (raise --limit)");
    expect(state.healthCalls).toBe(1);
    expect(state.recallCalls).toBe(1);
  });

  test("hybrid recall --json: delegated hits carry the reconstructed real path (shape parity with local)", async () => {
    const port = await startStub();
    const res = await runCli(["recall", "anything warm", "--json"], port);
    expect(res.status).toBe(0);
    const hits = JSON.parse(res.stdout) as Array<{ slug: string; path: string; platforms: string[] }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe("warm-stub-hit");
    expect(hits[0].path).toBe(join(root, "project", "warm-stub-hit.md"));
    expect(hits[0].platforms).toEqual([]);
  });

  test("--lex never probes the daemon (model-free locally, no win in delegating)", async () => {
    const port = await startStub();
    const rem = await runCli(["remember", "lex local marker fact", "--type", "project"], port);
    expect(rem.status).toBe(0);
    const res = await runCli(["recall", "lex local marker", "--lex"], port);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("lex local marker");
    expect(res.stdout).not.toContain("warm daemon");
    expect(state.healthCalls).toBe(0);
    expect(state.recallCalls).toBe(0);
  });

  test("--session never probes the daemon (fs-only snapshot)", async () => {
    const port = await startStub();
    const res = await runCli(["recall", "--session"], port);
    expect(res.status).toBe(0);
    expect(state.healthCalls).toBe(0);
    expect(state.recallCalls).toBe(0);
  });
});
