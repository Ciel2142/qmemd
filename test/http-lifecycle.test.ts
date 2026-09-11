import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, request } from "node:http";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../src/token.js";
import type { HttpServerHandle } from "../src/mcp/server.js";

let searches = 0;
let closes = 0;
let finishSearch: () => void;
let started: Promise<void>;
let signalStarted: () => void;
let search: Promise<[]>;
vi.doMock("../src/store.js", async () => ({
  ...await vi.importActual<typeof import("../src/store.js")>("../src/store.js"),
  openMemoryStore: async () => ({
    searchLex: () => { searches++; signalStarted(); return search; },
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0 }),
    close: async () => { closes++; },
  }),
}));
const { startMcpHttpServer } = await import("../src/mcp/server.js");
let handle: HttpServerHandle;
let dir: string;
let originalEnv: NodeJS.ProcessEnv;
let termHandlers: NodeJS.SignalsListener[];
let intHandlers: NodeJS.SignalsListener[];

beforeEach(async () => {
  searches = 0;
  closes = 0;
  search = new Promise(resolve => { finishSearch = () => resolve([]); });
  started = new Promise(resolve => { signalStarted = resolve; });
  dir = await mkdtemp(join(tmpdir(), "qmemd-http-lifecycle-"));
  originalEnv = { ...process.env };
  process.env.QMD_MEMORY_DIR = join(dir, "memory");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  termHandlers = process.listeners("SIGTERM");
  intHandlers = process.listeners("SIGINT");
  handle = await startMcpHttpServer(0, { quiet: true });
});

afterEach(async () => {
  finishSearch();
  await handle?.stop();
  for (const fn of process.listeners("SIGTERM")) if (!termHandlers.includes(fn)) process.off("SIGTERM", fn);
  for (const fn of process.listeners("SIGINT")) if (!intHandlers.includes(fn)) process.off("SIGINT", fn);
  process.env = originalEnv;
  await rm(dir, { recursive: true, force: true });
});

test.each(["REST", "legacy MCP", "modern MCP"])("HTTP shutdown drains a pending %s call before closing the shared store", async era => {
  const modern = era === "modern MCP";
  const params = { name: "recall", arguments: { query: "shutdown canary", lexOnly: true }, ...(modern ? { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "lifecycle-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } } : {}) };
  const url = `http://127.0.0.1:${handle.port}`;
  // Closing the socket may abort this fetch; retain its outcome while the actual tool drains.
  const response = fetch(`${url}/${era === "REST" ? "recall" : "mcp"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", [DAEMON_TOKEN_HEADER]: readDaemonToken()!, ...(modern ? {
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "recall",
    } : {}) },
    body: JSON.stringify(era === "REST" ? params.arguments : { jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  }).then(async res => { await res.text(); }, () => {});
  await started;
  let stopped = false;
  let stoppedAgain = false;
  const stopping = handle.stop().then(() => { stopped = true; });
  const repeatedStop = handle.stop().then(() => { stoppedAgain = true; });
  await expect(fetch(`${url}/health`)).rejects.toThrow(); // new admissions are closed
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(closes).toBe(0);
  expect(stopped).toBe(false);
  expect(stoppedAgain).toBe(false); // concurrent stop callers share the drain
  expect(searches).toBe(1);
  finishSearch();
  await Promise.all([stopping, repeatedStop, response]);
  expect(closes).toBe(1);
});

test("HTTP shutdown promptly releases an idle keepalive connection", async () => {
  const agent = new Agent({ keepAlive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${handle.port}/health`, { agent }, res => {
        res.resume();
        res.once("end", resolve);
      });
      req.once("error", reject);
      req.end();
    });
    await handle.stop();
    expect(closes).toBe(1);
  } finally { agent.destroy(); }
}, 2000);
