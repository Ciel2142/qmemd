import { test, expect, vi } from "vitest";
import { PassThrough } from "node:stream";

test("stdio shutdown keeps a slow tool's store open until its handler settles", async () => {
  // Only the storage boundary is delayed: run the real stdio entry and tool handler.
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let searches = 0;
  let storeClosed = false;
  let finishSearch!: () => void;
  const search = new Promise<[]>(resolve => { finishSearch = () => resolve([]); });
  vi.doMock("../src/store.js", async () => ({ ...await vi.importActual<typeof import("../src/store.js")>("../src/store.js"), openMemoryStore: async () => ({
    searchLex: () => { searches++; return search; },
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0 }),
    close: async () => { storeClosed = true; },
  }) }));
  const beforeTerm = process.listeners("SIGTERM");
  const beforeInt = process.listeners("SIGINT");
  const exitCode = process.exitCode;
  vi.useFakeTimers();
  try {
    const { startMcpServer } = await import("../src/mcp/server.js");
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as typeof process.stdin);
    const output = vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as typeof process.stdout);
    await startMcpServer();
    output.mockRestore();
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "recall", arguments: { query: "shutdown canary", lexOnly: true },
    } }) + "\n");
    await vi.waitFor(() => expect(searches).toBe(1));
    const shutdown = process.listeners("SIGTERM").find(fn => !beforeTerm.includes(fn))!;
    shutdown();
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "recall", arguments: { query: "late request", lexOnly: true },
    } }) + "\n");
    await vi.advanceTimersByTimeAsync(6000);
    expect(searches).toBe(1); // admission closed even while the first tool is draining
    expect(storeClosed).toBe(false);
    finishSearch();
    await vi.waitFor(() => expect(storeClosed).toBe(true));
    input.mockRestore();
  } finally {
    finishSearch();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("../src/store.js");
    for (const fn of process.listeners("SIGTERM")) if (!beforeTerm.includes(fn)) process.off("SIGTERM", fn);
    for (const fn of process.listeners("SIGINT")) if (!beforeInt.includes(fn)) process.off("SIGINT", fn);
    process.exitCode = exitCode;
    stdin.destroy();
    stdout.destroy();
  }
});
