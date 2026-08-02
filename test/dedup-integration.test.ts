import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import { remember } from "../src/engine.js";

// Real-store companions to the fake-store unit tests in engine.test.ts. A fake searchLex
// cannot express any of this: that a real index KEEPS a row for a deleted file, that the row
// still clears DEDUP_SCORE_FTS, that the reindex after a landed write sweeps it, or what qmd's
// FTS5 query builder does to a punctuated fact. Lex + filesystem only — no embedding model.

describe("dedup against a real qmd index", () => {
  let parent: string, root: string, store: QMDStore;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-dedup-int-"));
    root = join(parent, "mem");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "idx"), { recursive: true });
    store = await openQmd({
      dbPath: join(parent, "idx", "i.sqlite"),
      config: { collections: { memory: { path: root, pattern: "**/*.md" } } },
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("a ghost row in a real index does not block the write, and the write sweeps it", async () => {
    const first = await remember(store, root, {
      fact: "Redpanda broker runs on the lab pi server", type: "project",
    });
    expect(first.wrote).toBe(true);

    // Delete the file WITHOUT reindexing — what a git pull of another machine's forget does to
    // the working tree (recall --session pulls; nothing reindexes on pull).
    await unlink(join(root, "project", `${first.slug}.md`));
    const ghostRows = await store.searchLex("Redpanda broker runs on lab pi", { limit: 10, collection: "memory" });
    expect(ghostRows.some(r => r.filepath.endsWith(`project/${first.slug}.md`))).toBe(true); // the row really does survive

    // A term-subset of the ghost's text, so the BM25 AND-query matches it.
    const second = await remember(store, root, { fact: "Redpanda broker runs on lab pi", type: "project" });
    expect(second.wrote).toBe(true);
    expect(existsSync(join(root, "project", `${second.slug}.md`))).toBe(true);

    // Self-healing: the reindex that followed the write dropped the ghost row.
    const after = await store.searchLex("Redpanda broker runs on lab pi", { limit: 10, collection: "memory" });
    expect(after.map(r => r.filepath)).toEqual([expect.stringContaining(`project/${second.slug}.md`)]);
  });

  test("a byte-identical URL fact is blocked even under a different --as slug", async () => {
    const fact = "Metrics live at https://grafana.pi.local:3000/d/abc";
    const first = await remember(store, root, { fact, type: "project" });
    expect(first.wrote).toBe(true);
    // Tier-1 misses (different slug). Tier-2 used to miss too, because the URL was searched as
    // one concatenated token. Tier-2.5 also misses: its slug+firstLine token sets diverge once
    // --as swaps the slug in (measured dice 0.7778 vs the 0.82 floor), so the identical fact was
    // written twice.
    const second = await remember(store, root, { fact, type: "project", as: "ops-note" });
    expect(second.wrote).toBe(false);
    expect(second.disposition).toBe("duplicate");
    expect(second.duplicateOf).toBe(first.slug);
  });

  test("a fact quoting a CLI flag matches itself through the index (negation leg)", async () => {
    const { lexDedupQuery } = await import("../src/engine.js");
    const fact = "Use --force to bypass the dedup guard on remember";
    await remember(store, root, { fact, type: "project" });
    // Raw: the leading dash became FTS5 negation (NOT "force"*), so the fact excluded itself.
    expect(await store.searchLex(fact, { limit: 5, collection: "memory" })).toHaveLength(0);
    expect(await store.searchLex(lexDedupQuery(fact), { limit: 5, collection: "memory" })).toHaveLength(1);
  });
});
