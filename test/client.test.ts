import { describe, test, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tryDaemonRecall, daemonPort, rootHash } from "../src/client.js";
import { memoryFilePath } from "../src/engine.js";

// Warm-daemon recall delegation client (qmemd-vuk). The client is a thin HTTP mapper, so
// these tests run it against a stub node server with full response control — no qmd store,
// no embedding model. The rootHash gate is load-bearing: it is what stops a CLI pointed at
// a tmp QMD_MEMORY_DIR (every test in this repo) from being silently answered by a real
// daemon that happens to be alive on the same port serving a different store.

const ROOT = "/tmp/qmemd-client-test-root";

type StubBehavior = {
  health?: (res: import("node:http").ServerResponse) => void;
  recall?: (body: unknown, res: import("node:http").ServerResponse) => void;
};

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  servers = [];
});

/** Stub daemon: counts requests, captures the /recall body, behavior injectable per test. */
async function startStub(behavior: StubBehavior = {}) {
  const state = { healthCalls: 0, recallCalls: 0, lastRecallBody: undefined as unknown };
  const server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      state.healthCalls++;
      if (behavior.health) { behavior.health(res); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: 1, rootHash: rootHash(ROOT) }));
      return;
    }
    if (req.url === "/recall" && req.method === "POST") {
      state.recallCalls++;
      let data = "";
      for await (const c of req) data += c;
      state.lastRecallBody = JSON.parse(data);
      if (behavior.recall) { behavior.recall(state.lastRecallBody, res); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hits: [], degraded: false, vectorsPending: 0, moreMatches: 0, belowFloor: 0, saturated: false }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, state };
}

describe("daemonPort resolution", () => {
  test("uses QMEMD_HTTP_PORT when set to a number, else 8182", () => {
    expect(daemonPort({ QMEMD_HTTP_PORT: "9999" } as NodeJS.ProcessEnv)).toBe(9999);
    expect(daemonPort({} as NodeJS.ProcessEnv)).toBe(8182);
    // mirrors the CLI's `Number(...) || 8182`: empty/garbage falls back, never NaN
    expect(daemonPort({ QMEMD_HTTP_PORT: "" } as NodeJS.ProcessEnv)).toBe(8182);
    expect(daemonPort({ QMEMD_HTTP_PORT: "abc" } as NodeJS.ProcessEnv)).toBe(8182);
  });
});

describe("tryDaemonRecall: happy path", () => {
  test("delegates and maps DTO hits back to RecallHit shape with reconstructed path", async () => {
    const { port, state } = await startStub({
      recall: (_body, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          hits: [{ slug: "s1", type: "project", description: "warm hit", score: 0.71, body: "the body", platforms: ["linux"] }],
          degraded: false, vectorsPending: 0, moreMatches: 2, belowFloor: 1, saturated: true,
        }));
      },
    });
    const out = await tryDaemonRecall(ROOT, { query: "warm" }, { port });
    expect(out).not.toBeNull();
    expect(out!.hits).toHaveLength(1);
    const h = out!.hits[0];
    expect(h.slug).toBe("s1");
    expect(h.type).toBe("project");
    expect(h.description).toBe("warm hit");
    expect(h.score).toBe(0.71);
    expect(h.body).toBe("the body");
    expect(h.platforms).toEqual(["linux"]);
    // path is reconstructed exactly as the engine builds it — --json output parity
    expect(h.path).toBe(memoryFilePath(ROOT, "project", "s1"));
    expect(h.path).toBe(join(ROOT, "project", "s1.md"));
    // completeness + health counters pass through untouched (9t1 / 40h)
    expect(out!.degraded).toBe(false);
    expect(out!.vectorsPending).toBe(0);
    expect(out!.moreMatches).toBe(2);
    expect(out!.belowFloor).toBe(1);
    expect(out!.saturated).toBe(true);
    expect(state.healthCalls).toBe(1);
    expect(state.recallCalls).toBe(1);
  });

  test("maps params to the REST body: full/skim only when true, specific platform passes through", async () => {
    const { port, state } = await startStub();
    const out = await tryDaemonRecall(ROOT, {
      query: "q", type: "project", limit: 5, minScore: 0.3, fullBody: true, skim: false, platform: "macos",
    }, { port });
    expect(out).not.toBeNull();
    const body = state.lastRecallBody as Record<string, unknown>;
    expect(body.query).toBe("q");
    expect(body.type).toBe("project");
    expect(body.limit).toBe(5);
    expect(body.minScore).toBe(0.3);
    expect(body.full).toBe(true);
    expect(body.platform).toBe("macos");
    // never sent: falsy flags and the unrelated platform switch
    expect(body).not.toHaveProperty("skim");
    expect(body).not.toHaveProperty("allPlatforms");
    expect(body).not.toHaveProperty("lexOnly");
  });

  test('platform "all" maps to allPlatforms:true (REST pre-dates the specific param)', async () => {
    const { port, state } = await startStub();
    await tryDaemonRecall(ROOT, { query: "q", platform: "all" }, { port });
    const body = state.lastRecallBody as Record<string, unknown>;
    expect(body.allPlatforms).toBe(true);
    expect(body).not.toHaveProperty("platform");
  });

  test("omits undefined optionals from the body entirely", async () => {
    const { port, state } = await startStub();
    await tryDaemonRecall(ROOT, { query: "q" }, { port });
    const body = state.lastRecallBody as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["query"]);
  });

  test("sends project and crossProject:true in the body when set (qmemd-due)", async () => {
    const { port, state } = await startStub();
    await tryDaemonRecall(ROOT, { query: "q", project: "alpha", crossProject: true }, { port });
    const body = state.lastRecallBody as Record<string, unknown>;
    expect(body.project).toBe("alpha");
    expect(body.crossProject).toBe(true);
  });

  test("sends project but omits crossProject when it is falsy (qmemd-due)", async () => {
    const { port, state } = await startStub();
    await tryDaemonRecall(ROOT, { query: "q", project: "alpha" }, { port });
    const body = state.lastRecallBody as Record<string, unknown>;
    expect(body.project).toBe("alpha");
    expect(body).not.toHaveProperty("crossProject");
  });

  test("maps project per hit and crossProjectHidden from the response (qmemd-due)", async () => {
    const { port } = await startStub({
      recall: (_body, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          hits: [{ slug: "b1", type: "project", description: "beta hit", project: "beta" }],
          degraded: false, vectorsPending: 0, moreMatches: 0, belowFloor: 0, saturated: false, crossProjectHidden: 2,
        }));
      },
    });
    const out = await tryDaemonRecall(ROOT, { query: "q", project: "alpha", crossProject: true }, { port });
    expect(out!.hits[0].project).toBe("beta");
    expect(out!.crossProjectHidden).toBe(2);
  });

  test("defaults hit.project to 'global' and crossProjectHidden to 0 from an older daemon (qmemd-due)", async () => {
    const { port } = await startStub({
      recall: (_body, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          hits: [{ slug: "x1", type: "reference", description: "old daemon hit" }],
          degraded: false, vectorsPending: 0, moreMatches: 0, belowFloor: 0, saturated: false,
        }));
      },
    });
    const out = await tryDaemonRecall(ROOT, { query: "q", project: "alpha" }, { port });
    expect(out!.hits[0].project).toBe("global");
    expect(out!.crossProjectHidden).toBe(0);
  });
});

describe("tryDaemonRecall: fallback to null (caller takes the local path)", () => {
  test("daemon down (connection refused)", async () => {
    const { port } = await startStub();
    // close it again so the port is dead but was recently valid
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    const out = await tryDaemonRecall(ROOT, { query: "q" }, { port });
    expect(out).toBeNull();
  });

  test("rootHash mismatch: returns null WITHOUT issuing the recall POST", async () => {
    const { port, state } = await startStub({
      health: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: 1, rootHash: rootHash("/some/other/root") }));
      },
    });
    const out = await tryDaemonRecall(ROOT, { query: "q" }, { port });
    expect(out).toBeNull();
    expect(state.recallCalls).toBe(0);
  });

  test("health missing rootHash (older daemon): null — rootHash doubles as the capability marker", async () => {
    const { port, state } = await startStub({
      health: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: 1 }));
      },
    });
    const out = await tryDaemonRecall(ROOT, { query: "q" }, { port });
    expect(out).toBeNull();
    expect(state.recallCalls).toBe(0);
  });

  test("recall non-200 → null", async () => {
    const { port } = await startStub({
      recall: (_b, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "boom" })); },
    });
    expect(await tryDaemonRecall(ROOT, { query: "q" }, { port })).toBeNull();
  });

  test("recall invalid JSON → null", async () => {
    const { port } = await startStub({
      recall: (_b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not json{"); },
    });
    expect(await tryDaemonRecall(ROOT, { query: "q" }, { port })).toBeNull();
  });

  test("recall response without a hits array → null", async () => {
    const { port } = await startStub({
      recall: (_b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ snapshot: "wrong shape" })); },
    });
    expect(await tryDaemonRecall(ROOT, { query: "q" }, { port })).toBeNull();
  });

  test("health that never answers: null after healthTimeoutMs, request aborted", async () => {
    const { port } = await startStub({
      health: () => { /* hold the socket open, never respond */ },
    });
    const t0 = Date.now();
    const out = await tryDaemonRecall(ROOT, { query: "q" }, { port, healthTimeoutMs: 80 });
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("tryDaemonRecall: hostile-response hardening", () => {
  test("traversal slug in a hit → null (never path-joined into output)", async () => {
    const { port } = await startStub({
      recall: (_b, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          hits: [{ slug: "../../etc/passwd", type: "project", description: "evil", platforms: [] }],
          degraded: false, vectorsPending: 0, moreMatches: 0, belowFloor: 0, saturated: false,
        }));
      },
    });
    expect(await tryDaemonRecall(ROOT, { query: "q" }, { port })).toBeNull();
  });

  test("unknown type in a hit → null (closed MemoryType set)", async () => {
    const { port } = await startStub({
      recall: (_b, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          hits: [{ slug: "ok-slug", type: "../sneaky", description: "evil", platforms: [] }],
          degraded: false, vectorsPending: 0, moreMatches: 0, belowFloor: 0, saturated: false,
        }));
      },
    });
    expect(await tryDaemonRecall(ROOT, { query: "q" }, { port })).toBeNull();
  });
});
