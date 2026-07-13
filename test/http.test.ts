import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { request as httpRequest } from "node:http";
import {
  startMcpHttpServer, type HttpServerHandle,
  isLoopbackHost, isAllowedOrigin, isJsonContentType,
} from "../src/mcp/server.js";
import { rootHash } from "../src/client.js";
import { memoryRoot } from "../src/paths.js";

/**
 * Raw HTTP request with full header control — node:http lets us set a spoofed `Host`
 * (and connect to 127.0.0.1 regardless), which fetch() forbids. Models the DNS-rebinding
 * scenario: the browser connects to loopback but sends the attacker's Host (qmemd-1z9).
 */
function rawRequest(port: number, opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: opts.path, method: opts.method, headers: opts.headers },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let handle: HttpServerHandle;
let baseUrl: string;
let memRoot: string;
const origMem = process.env.QMD_MEMORY_DIR;
const origDb = process.env.QMEMD_DB;

beforeAll(async () => {
  memRoot = await mkdtemp(join(tmpdir(), "qmemd-http-"));
  process.env.QMD_MEMORY_DIR = memRoot;
  process.env.QMEMD_DB = join(memRoot, ".idx", "i.sqlite");
  handle = await startMcpHttpServer(0, { quiet: true }); // OS-assigned ephemeral port
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  if (origMem === undefined) delete process.env.QMD_MEMORY_DIR; else process.env.QMD_MEMORY_DIR = origMem;
  if (origDb === undefined) delete process.env.QMEMD_DB; else process.env.QMEMD_DB = origDb;
  await rm(memRoot, { recursive: true, force: true });
});

describe("HTTP server: health & routing", () => {
  test("GET /health returns 200 + status/uptime", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  test("GET /nope returns 404", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("HTTP server: MCP over HTTP", () => {
  let sessionId: string | null = null;
  async function mcp(body: object) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    return { status: res.status, json: await res.json() as any };
  }

  test("initialize then tools/list advertises the five memory tools", async () => {
    const init = await mcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("qmemd");

    const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    const names = list.json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["forget", "get", "list", "recall", "remember", "reviewed"]);
  });
});

describe("HTTP server: stateless MCP transport (qmemd-pf9)", () => {
  // qmemd's tools are independent calls on the shared store — no session continuity is needed,
  // so the transport runs stateless (sessionIdGenerator: undefined): it issues no mcp-session-id
  // and a tool call carries none. This removes the per-client transport map that previously grew
  // unboundedly on the long-lived daemon (the leak was a symptom of accidental statefulness).
  const J = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  const rpc = (id: number, method: string, params: object = {}) =>
    fetch(`${baseUrl}/mcp`, { method: "POST", headers: J, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });

  test("initialize issues no session id (stateless signature)", async () => {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1.0" } });
    expect(init.status).toBe(200);
    expect((await init.json() as any).result.serverInfo.name).toBe("qmemd");
    expect(init.headers.get("mcp-session-id")).toBeNull();
  });

  test("a tool call carries no session id and still works (stateful would 400)", async () => {
    const list = await rpc(2, "tools/list");
    expect(list.status).toBe(200);
    const names = (await list.json() as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["forget", "get", "list", "recall", "remember", "reviewed"]);
  });

  // qmemd-k9q wanted the stateful session-error envelopes (404 session-not-found,
  // 400 missing-session-id, DELETE teardown) — obsolete since pf9 made the transport
  // stateless. Pin the stateless replacements instead: stale ids are ignored, and
  // DELETE (the stateful teardown verb) is rejected as a client error, never a 500.
  test("a BOGUS mcp-session-id header is ignored, not a 404 (stateless replacement)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...J, "mcp-session-id": "stale-session-from-a-previous-daemon" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const names = (await res.json() as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["forget", "get", "list", "recall", "remember", "reviewed"]);
  });

  test("DELETE /mcp (stateful teardown verb) is an empty 200 no-op ack, never a 500", async () => {
    // The SDK's stateless StreamableHTTP transport acks teardown without a session
    // (probed 2026-06-10: 200, empty body). Pinned so an SDK upgrade that starts
    // erroring — or worse, 500ing — on the verb shows up here.
    const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { "Accept": "application/json, text/event-stream" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("HTTP server: REST verbs", () => {
  test("full cycle: remember -> recall(lex) -> list -> get -> forget; no abs path leaks", async () => {
    // remember
    const rem = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fact: "qmemd rest cycle marker alpha", type: "project" }),
    });
    expect(rem.status).toBe(200);
    const remJson = await rem.json() as any;
    expect(remJson.wrote).toBe(true);
    expect(remJson.synced).toBe(true); // qmemd-ddr: sync signal reaches the REST surface (tmp memRoot is not a repo → benign)
    expect(remJson.dedupSkipped).toBe(0); // qmemd-e5h: corruption-gap count reaches REST; clean corpus → 0
    expect(JSON.stringify(remJson)).not.toContain(memRoot); // qmemd-81n
    const slug = remJson.slug;

    // recall (lexOnly — never loads the model)
    const rec = await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "cycle marker alpha", lexOnly: true }),
    });
    expect(rec.status).toBe(200);
    const recJson = await rec.json() as any;
    expect(recJson.hits.some((h: any) => h.slug === slug)).toBe(true);
    expect(recJson.hits[0]).not.toHaveProperty("path");
    expect(JSON.stringify(recJson)).not.toContain(memRoot);
    // qmemd-9t1: the embed-barrier health signal reaches the REST surface; a lexOnly recall
    // attempts no embed, so it is never degraded (the fields are present, not omitted).
    expect(recJson.degraded).toBe(false);
    expect(recJson.vectorsPending).toBe(0);

    // list
    const lst = await fetch(`${baseUrl}/list?type=project`);
    expect(lst.status).toBe(200);
    const lstJson = await lst.json() as any;
    expect(lstJson.entries.some((e: any) => e.slug === slug)).toBe(true);
    expect(JSON.stringify(lstJson)).not.toContain(memRoot);

    // get
    const got = await fetch(`${baseUrl}/get?slug=${encodeURIComponent(slug)}`);
    expect(got.status).toBe(200);
    const gotJson = await got.json() as any;
    expect(gotJson.slug).toBe(slug);
    expect(gotJson).not.toHaveProperty("path");
    expect(JSON.stringify(gotJson)).not.toContain(memRoot);

    // forget
    const del = await fetch(`${baseUrl}/forget`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    expect(del.status).toBe(200);
    expect((await del.json() as any).removed).toBe(true);
  });

  test("recall session snapshot via session:true", async () => {
    const res = await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: true }),
    });
    expect(res.status).toBe(200);
    expect(typeof (await res.json() as any).snapshot).toBe("string");
  });

  test("remember without fact -> 400", async () => {
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("remember with invalid type -> 400", async () => {
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fact: "x", type: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  test("remember replace with a nonexistent slug -> 400, not a silent create (acm)", async () => {
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fact: "Updated body", replace: "no-such-slug-http" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/no fact named/);
  });

  test("remember with an entirely-leaked body -> 400 with the client message, not 500 (qp-f6j)", async () => {
    // The engine's ClientError rejection must reach the caller as a fixable 400, not the
    // catch-all 500 the old message-prefix allowlist produced by omission.
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fact: "</fact>\n<parameter name=\"type\">project", type: "reference" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/entirely leaked tool-call markup/);
  });

  test("forget missing slug -> 404", async () => {
    const res = await fetch(`${baseUrl}/forget`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "does-not-exist-xyz" }),
    });
    expect(res.status).toBe(404);
  });

  test("get missing slug -> 404", async () => {
    const res = await fetch(`${baseUrl}/get?slug=does-not-exist-xyz`);
    expect(res.status).toBe(404);
  });

  test("get unsafe slug -> 400", async () => {
    const res = await fetch(`${baseUrl}/get?slug=${encodeURIComponent("../escape")}`);
    expect(res.status).toBe(400);
  });

  test("recall with invalid type -> 400", async () => {
    const res = await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", type: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  test("forget unsafe slug -> 400", async () => {
    const res = await fetch(`${baseUrl}/forget`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "../escape" }),
    });
    expect(res.status).toBe(400);
  });

  test("/recall scopes to project + global by default and reports crossProjectHidden (qmemd-due)", async () => {
    for (const [fact, proj] of [["due rest alpha marker", "alpha"], ["due rest beta marker", "beta"], ["due rest shared marker", "global"]] as const) {
      await fetch(`${baseUrl}/remember`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fact, type: "project", project: proj }),
      });
    }
    // default (project: alpha) — beta hidden, alpha + global shown, count surfaced
    const scoped = await (await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "due rest marker", lexOnly: true, project: "alpha" }),
    })).json() as any;
    const slugs = scoped.hits.map((h: any) => h.slug);
    expect(slugs).toContain("due-rest-alpha-marker");
    expect(slugs).toContain("due-rest-shared-marker");
    expect(slugs).not.toContain("due-rest-beta-marker");
    expect(scoped.crossProjectHidden).toBe(1);

    // crossProject — beta returns, nothing hidden
    const wide = await (await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "due rest marker", lexOnly: true, project: "alpha", crossProject: true }),
    })).json() as any;
    expect(wide.hits.map((h: any) => h.slug)).toContain("due-rest-beta-marker");
    expect(wide.crossProjectHidden).toBe(0);
  });
});

describe("HTTP server: input validation parity (qmemd-4hh)", () => {
  // The CLI clamps limit to >=1 and rejects minScore<0; the REST surface must enforce the
  // same contract (clamp limit, 400 on a negative minScore, 400 on non-array/non-string tags)
  // so a bad value can't reach the engine and slice(0,negative)/corrupt frontmatter. All
  // recalls here are lexOnly so the checks run model-free.
  const J = { "Content-Type": "application/json" };

  test("recall clamps a non-positive limit instead of slicing to an empty result", async () => {
    await fetch(`${baseUrl}/remember`, { method: "POST", headers: J, body: JSON.stringify({ fact: "clamptest fact one alpha", type: "project", as: "clamp-a" }) });
    await fetch(`${baseUrl}/remember`, { method: "POST", headers: J, body: JSON.stringify({ fact: "clamptest fact two beta", type: "project", as: "clamp-b" }) });
    // limit:0 — unclamped this is store.searchLex(limit:0) + hits.slice(0,0) => 0 hits.
    // Clamped to >=1 it returns the top hit.
    const res = await fetch(`${baseUrl}/recall`, { method: "POST", headers: J, body: JSON.stringify({ query: "clamptest", lexOnly: true, limit: 0 }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).hits.length).toBeGreaterThanOrEqual(1);
  });

  test("recall with a negative minScore -> 400", async () => {
    const res = await fetch(`${baseUrl}/recall`, { method: "POST", headers: J, body: JSON.stringify({ query: "x", lexOnly: true, minScore: -0.5 }) });
    expect(res.status).toBe(400);
  });

  test("remember with non-array tags -> 400", async () => {
    const res = await fetch(`${baseUrl}/remember`, { method: "POST", headers: J, body: JSON.stringify({ fact: "tagcheck fact", type: "project", tags: "notanarray" }) });
    expect(res.status).toBe(400);
  });

  test("remember with non-string tag elements -> 400", async () => {
    const res = await fetch(`${baseUrl}/remember`, { method: "POST", headers: J, body: JSON.stringify({ fact: "tagcheck fact two", type: "project", tags: ["ok", 123] }) });
    expect(res.status).toBe(400);
  });
});

describe("HTTP server: malformed JSON body -> 400, not 500 (qmemd-bzq)", () => {
  // A client's bad body is a client error: it must answer 400 with a structured message,
  // not fall through to the catch-all 500 that stack-traces per request into the daemon log.
  const bad = (path: string) => fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{ not: valid json",
  });

  test("POST /remember with malformed JSON -> 400 with an invalid-JSON message", async () => {
    const res = await bad("/remember");
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/json/i);
  });

  test("POST /recall with malformed JSON -> 400", async () => {
    expect((await bad("/recall")).status).toBe(400);
  });

  test("POST /forget with malformed JSON -> 400", async () => {
    expect((await bad("/forget")).status).toBe(400);
  });

  test("POST /mcp with malformed JSON -> 400", async () => {
    expect((await bad("/mcp")).status).toBe(400);
  });
});

describe("localhost guard predicates (qmemd-1z9)", () => {
  test("isLoopbackHost accepts only loopback hostnames, ignoring port", () => {
    expect(isLoopbackHost("localhost:8182")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:8182")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]:8182")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("evil.com")).toBe(false);
    expect(isLoopbackHost("evil.com:8182")).toBe(false);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false); // suffix trick
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  test("isAllowedOrigin allows absent/null/loopback, rejects cross-origin", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);   // non-browser client (Claude Code, curl)
    expect(isAllowedOrigin("null")).toBe(true);       // opaque origin
    expect(isAllowedOrigin("http://localhost:8182")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedOrigin("http://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://localhost.evil.com")).toBe(false); // suffix trick
    expect(isAllowedOrigin("garbage")).toBe(false);   // unparseable
  });

  test("isJsonContentType requires an exact application/json media type", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);          // CORS-simple → no preflight
    expect(isJsonContentType("application/json-patch+json")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("HTTP server: localhost guard, end-to-end (qmemd-1z9)", () => {
  test("non-loopback Host on a write POST -> 403 (DNS-rebinding defeated)", async () => {
    const res = await rawRequest(handle.port, {
      method: "POST", path: "/remember",
      headers: { Host: "evil.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ fact: "csrf injection marker", type: "project" }),
    });
    expect(res.status).toBe(403);
  });

  test("cross-origin Origin on a write POST -> 403 (CSRF defeated)", async () => {
    const res = await rawRequest(handle.port, {
      method: "POST", path: "/remember",
      headers: { Host: `127.0.0.1:${handle.port}`, Origin: "http://evil.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ fact: "csrf injection marker", type: "project" }),
    });
    expect(res.status).toBe(403);
  });

  test("non-JSON Content-Type on a write POST -> 415 (forces a CSRF-proof preflight)", async () => {
    const res = await rawRequest(handle.port, {
      method: "POST", path: "/remember",
      headers: { Host: `127.0.0.1:${handle.port}`, "Content-Type": "text/plain" },
      body: JSON.stringify({ fact: "csrf injection marker", type: "project" }),
    });
    expect(res.status).toBe(415);
  });

  test("non-loopback Host on a GET read -> 403 (corpus exfil via rebinding defeated)", async () => {
    const res = await rawRequest(handle.port, {
      method: "GET", path: "/list", headers: { Host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("loopback request with no Origin (non-browser client) is allowed", async () => {
    const res = await rawRequest(handle.port, {
      method: "GET", path: "/health", headers: { Host: `localhost:${handle.port}` },
    });
    expect(res.status).toBe(200);
  });

  test("loopback Origin is allowed", async () => {
    const res = await rawRequest(handle.port, {
      method: "GET", path: "/health",
      headers: { Host: `localhost:${handle.port}`, Origin: `http://localhost:${handle.port}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("HTTP server: daemon session scope (wdf)", () => {
  const J = { "Content-Type": "application/json" };

  test("REST session defaults the project to 'global', not the daemon cwd basename", async () => {
    // The daemon's cwd is HOME, so basename(cwd) is the username — scoping the snapshot to it
    // under-returns. The REST session must default to 'global'. Seed a fact scoped to the
    // test runner's cwd basename: the old basename(cwd) default would surface it; 'global' must not.
    const cwdProj = basename(process.cwd());
    await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "REST daemon scope cwd-only fact", type: "project", project: cwdProj, as: "rest-cwd-scoped" }),
    });

    const def = await fetch(`${baseUrl}/recall`, { method: "POST", headers: J, body: JSON.stringify({ session: true }) });
    const defJson = await def.json() as any;
    expect(defJson.snapshot ?? "").not.toContain("REST daemon scope cwd-only fact");

    const scoped = await fetch(`${baseUrl}/recall`, { method: "POST", headers: J, body: JSON.stringify({ session: true, project: cwdProj }) });
    const scopedJson = await scoped.json() as any;
    expect(scopedJson.snapshot).toContain("REST daemon scope cwd-only fact");
  });
});

describe("REST platform scoping", () => {
  test("/remember accepts a valid platforms array", async () => {
    const r = await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "systemd serves the daemon on linux", type: "project", platforms: ["linux"] }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect((j as any).wrote).toBe(true);
  });

  test("/remember rejects a non-enum platforms token with 400", async () => {
    const r = await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "bad", type: "project", platforms: ["freebsd"] }) });
    expect(r.status).toBe(400);
  });

  test("/remember rejects a non-array platforms with 400", async () => {
    const r = await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "bad", type: "project", platforms: "linux" }) });
    expect(r.status).toBe(400);
  });

  test("/list?platform=linux filters and labels", async () => {
    await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "a mac fact about gizmos", type: "project", platforms: ["macos"] }) });
    await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "a cross fact about gizmos", type: "project" }) });
    const r = await fetch(`${baseUrl}/list?platform=linux`);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    const slugs = j.entries.map((e: { slug: string }) => e.slug);
    expect(slugs).toContain("a-cross-fact-about-gizmos");
    expect(slugs).not.toContain("a-mac-fact-about-gizmos");
    expect(j.entries.every((e: { platforms: string[] }) => Array.isArray(e.platforms))).toBe(true);
  });

  test("/list rejects an invalid platform with 400", async () => {
    const r = await fetch(`${baseUrl}/list?platform=freebsd`);
    expect(r.status).toBe(400);
  });

  test("/recall allPlatforms:true returns the macos fact (host gate disabled)", async () => {
    await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "a mac fact about sprockets", type: "project", platforms: ["macos"] }) });
    const r = await fetch(`${baseUrl}/recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "sprockets", lexOnly: true, allPlatforms: true }) });
    const j = await r.json() as any;
    expect(j.hits.some((h: { slug: string }) => h.slug === "a-mac-fact-about-sprockets")).toBe(true);
  });

  test("/remember accepts mixed-case platforms and stores canonical lowercase (qmemd-fvv)", async () => {
    const r = await fetch(`${baseUrl}/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "rest mixed case windows fact", type: "project", platforms: ["Windows"] }) });
    expect(r.status).toBe(200); // not a 400 — case-insensitive, mirroring the lowercasing CLI/write path
    // stored lowercase: visible under ?platform=windows
    const win = await (await fetch(`${baseUrl}/list?platform=windows`)).json() as any;
    expect(win.entries.map((e: { slug: string }) => e.slug)).toContain("rest-mixed-case-windows-fact");
  });

  test("/list?platform mixed case is accepted (qmemd-fvv)", async () => {
    const r = await fetch(`${baseUrl}/list?platform=Linux`);
    expect(r.status).toBe(200);
  });
});

describe("REST remember: supersedes param (bri)", () => {
  const J = { "Content-Type": "application/json" };

  test("POST /remember accepts supersedes and echoes supersededSlug (bri)", async () => {
    // Seed the old fact.
    const seed = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "Old bri rest truth about auth tokens", type: "project", as: "bri-old-fact" }),
    });
    expect(seed.status).toBe(200);
    expect(((await seed.json()) as { wrote: boolean }).wrote).toBe(true);

    // Write successor, superseding the old one.
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "New bri rest truth about auth tokens (revised)", type: "project", as: "bri-new-fact", supersedes: "bri-old-fact" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { wrote: boolean; slug: string; supersededSlug?: string; conflictsWith?: string; supersedeWarning?: string };
    expect(body.wrote).toBe(true);
    expect(body.supersededSlug).toBe("bri-old-fact");
    expect(body.conflictsWith).toBeUndefined();
    expect(body.supersedeWarning).toBeUndefined();
    // qmemd-81n: no absolute path in the response.
    expect(JSON.stringify(body)).not.toContain(memRoot);
  });

  test("POST /remember supersedes a missing slug -> 400 with no-fact-named message (bri)", async () => {
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "Replacement fact bri", supersedes: "no-such-slug-bri-http" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no fact named/);
  });

  test("POST /remember supersedes cannot combine with replace -> 400 (bri)", async () => {
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "Combo test bri", replace: "some-slug", supersedes: "other-slug" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/supersedes.*combine|combine.*supersede/i);
  });

  test("POST /remember self-supersession maps to 400 (bri)", async () => {
    // Seed the fact.
    const seed = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "Self-slug HTTP original", type: "project", as: "self-slug-bri-http" }),
    });
    expect(seed.status).toBe(200);
    expect(((await seed.json()) as { wrote: boolean }).wrote).toBe(true);

    // A fact cannot supersede itself — the catch block maps "a fact cannot supersede itself" to 400.
    const res = await fetch(`${baseUrl}/remember`, {
      method: "POST", headers: J,
      body: JSON.stringify({ fact: "Self-slug HTTP updated", type: "project", as: "self-slug-bri-http", supersedes: "self-slug-bri-http" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot supersede itself/);
  });
});

describe("REST recall completeness counters (40h)", () => {
  test("moreMatches/belowFloor/saturated reach the REST surface", async () => {
    const slugs: string[] = [];
    // Facts share ONLY the query marker token — higher overlap can trip the i5y near-dup prepass.
    for (const fact of ["fortyh redpanda broker nine", "fortyh grafana dashboard alpha", "fortyh qdrant collection beta"]) {
      const rem = await fetch(`${baseUrl}/remember`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fact, type: "project" }),
      });
      expect(rem.status).toBe(200);
      slugs.push(((await rem.json()) as { slug: string }).slug);
    }
    try {
      const rec = await fetch(`${baseUrl}/recall`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "fortyh", lexOnly: true, limit: 1 }),
      });
      expect(rec.status).toBe(200);
      const recJson = await rec.json() as { hits: unknown[]; moreMatches: number; belowFloor: number; saturated: boolean };
      expect(recJson.hits.length).toBe(1);
      expect(recJson.moreMatches).toBe(2);  // 3 match, 1 shown; pool 4 > 3 → exact
      expect(recJson.belowFloor).toBe(0);
      expect(recJson.saturated).toBe(false);
    } finally {
      for (const slug of slugs) {
        await fetch(`${baseUrl}/forget`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
      }
    }
  });
});

describe("HTTP server: warm-daemon delegation surface (qmemd-vuk)", () => {
  test("GET /health includes rootHash of the served memory root", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rootHash?: string };
    // The CLI client compares this against sha256 of ITS root before delegating —
    // a daemon serving a different store (or an older daemon without the field)
    // must never answer a delegated recall.
    expect(body.rootHash).toBe(rootHash(memoryRoot()));
    expect(body.rootHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("recall with a specific platform scopes to that OS (5gx REST half)", async () => {
    const slugs: string[] = [];
    for (const [fact, platforms] of [
      ["platgate zulu linux side", ["linux"]],
      ["platgate zulu macos side", ["macos"]],
    ] as const) {
      const rem = await fetch(`${baseUrl}/remember`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fact, type: "project", platforms }),
      });
      expect(rem.status).toBe(200);
      slugs.push(((await rem.json()) as { slug: string }).slug);
    }
    try {
      const rec = await fetch(`${baseUrl}/recall`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "platgate zulu", lexOnly: true, platform: "macos" }),
      });
      expect(rec.status).toBe(200);
      const recJson = await rec.json() as { hits: Array<{ slug: string; platforms: string[] }> };
      expect(recJson.hits.length).toBe(1);
      expect(recJson.hits[0].slug).toBe(slugs[1]);
      expect(recJson.hits[0].platforms).toEqual(["macos"]);
    } finally {
      for (const slug of slugs) {
        await fetch(`${baseUrl}/forget`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
      }
    }
  });

  test("recall with an invalid platform -> 400", async () => {
    const res = await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", lexOnly: true, platform: "beos" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid platform/i);
  });

  test("recall with both platform and allPlatforms -> 400 (mutually exclusive, mirrors CLI dbr)", async () => {
    const res = await fetch(`${baseUrl}/recall`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", lexOnly: true, platform: "macos", allPlatforms: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/mutually exclusive/i);
  });
});
