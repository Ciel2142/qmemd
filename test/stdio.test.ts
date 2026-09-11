import { describe, test, expect } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), "qmemd-stdio-"));
  const db = join(dir, "index.sqlite");
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli/qmemd.ts"), "mcp"], {
    env: { ...process.env, QMD_MEMORY_DIR: join(dir, "memory"), QMEMD_DB: db, XDG_CACHE_HOME: join(dir, "cache"), QMD_FORCE_CPU: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", c => { stderr += c; });
  const pending = new Map<number, (message: any) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let id = 0;
  return {
    db, child, exited,
    async call(method: string, params: object = {}, modern = false): Promise<any> {
      const requestId = ++id;
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`No ${method} response: ${stderr}`)); }, 10000);
        pending.set(requestId, message => { clearTimeout(timer); pending.delete(requestId); resolve(message); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: { ...params, ...(modern ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "stdio-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}) } }) + "\n");
      return response;
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      lines.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe.each([false, true])("spawned stdio (modern=%s)", modern => {
  test("discovery, schema listing and filesystem tools stay lazy; EOF closes without creating a database", async () => {
    const app = await launch();
    try {
      const opening = await app.call(modern ? "server/discover" : "initialize", modern ? {} : {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" },
      }, modern);
      expect(opening.error).toBeUndefined();
      if (modern) expect(opening.result.resultType).toBe("complete");
      else expect(opening.result.protocolVersion).toBe("2025-03-26");
      const tools = await app.call("tools/list", {}, modern);
      expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual(["forget", "get", "list", "recall", "remember", "reviewed"]);
      const listed = await app.call("tools/call", { name: "list", arguments: {} }, modern);
      expect(listed.result.structuredContent.entries).toEqual([]);
      expect(existsSync(app.db)).toBe(false);
      app.child.stdin.end();
      expect(await app.exited).toEqual({ code: 0, signal: null });
      expect(existsSync(app.db)).toBe(false);
    } finally { await app.cleanup(); }
  });

  test.each(["EOF", "SIGTERM"])("writes through the lazy store, returns path-free DTOs, and closes SQLite on %s", async stop => {
    const app = await launch();
    try {
      await app.call(modern ? "server/discover" : "initialize", modern ? {} : {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" },
      }, modern);
      const remembered = await app.call("tools/call", { name: "remember", arguments: { fact: "Stdio migration canary", type: "user" } }, modern);
      expect(remembered.result.structuredContent.wrote).toBe(true);
      expect(existsSync(app.db)).toBe(true);
      const slug = remembered.result.structuredContent.slug;
      const recalled = await app.call("tools/call", { name: "recall", arguments: { query: "migration canary", lexOnly: true } }, modern);
      expect(recalled.result.structuredContent.hits.map((h: any) => h.slug)).toContain(slug);
      expect(JSON.stringify(recalled)).not.toContain(app.db);
      const invalid = await app.call("tools/call", { name: "get", arguments: { slug: "../private" } }, modern);
      expect(invalid.result.isError).toBe(true);
      if (stop === "EOF") app.child.stdin.end(); else app.child.kill("SIGTERM");
      expect(await app.exited).toEqual({ code: 0, signal: null });
      // A clean store close checkpoints and removes SQLite's WAL, unlike process exit alone.
      expect(existsSync(`${app.db}-wal`)).toBe(false);
    } finally { await app.cleanup(); }
  });
});
