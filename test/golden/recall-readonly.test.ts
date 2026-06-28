import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { remember, recallQueryWithStatus } from "../../src/engine.js";
import { createTmpMemoryStore } from "./seed.js";

// I4: the markdown corpus is the source of truth; the SQLite index is disposable. The lazy-embed
// barrier legitimately WRITES vectors to the index on first hybrid recall — so this snapshot is
// scoped to the markdown lane dirs ONLY. Do NOT "tighten" it to include the index: that would
// false-fail on a hybrid recall. recallQueryWithStatus must never touch the .md files (I7).
const corpusSnapshot = (root: string): string =>
  ["project", "reference", "user", "feedback"]
    .flatMap((t) => { try { return readdirSync(join(root, t)).map((f) => `${t}/${f}:${readFileSync(join(root, t, f), "utf-8")}`); } catch { return []; } })
    .sort().join("\n");

describe("recall is read-only over the markdown corpus (I7)", () => {
  test("recallQuery leaves every fact byte-identical", async () => {
    const { store, root, cleanup } = await createTmpMemoryStore();
    try {
      await remember(store, root, { fact: "redis admin user is admin/admin on port 6379", type: "project", project: "p1" });
      await remember(store, root, { fact: "the homelab pi host is 192.168.1.34", type: "reference", project: "p1" });
      const before = corpusSnapshot(root);
      await recallQueryWithStatus(store, root, "redis port", { lexOnly: true, project: "p1" });
      await recallQueryWithStatus(store, root, "nonexistent topic xyzzy", { lexOnly: true, project: "p1" });
      expect(corpusSnapshot(root)).toBe(before);
    } finally {
      await cleanup();
    }
  });
});
