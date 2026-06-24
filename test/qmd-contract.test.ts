import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import { remember } from "../src/engine.js";

// qmemd-k9q: RUNTIME contract pin on the qmd SDK surface qmemd's lex recall consumes —
// searchLex() result rows must keep `.filepath` (virtual qmd://<collection>/<type>/<slug>.md,
// parsed by parseVirtualMemoryPath), `.title`, `.score`. An SDK upgrade that renames or
// retypes these fails HERE with a field-level message instead of as a silent recall
// regression. The hybrid-path twin (HybridQueryResult.file + explain.rerankScore) cannot
// run without the embedding model, so it is pinned at the TYPE level in
// test/qmd-contract.test-d.ts (vitest typecheck).

describe("qmd SDK searchLex field-shape contract (k9q)", () => {
  let parent: string, root: string, store: QMDStore;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-contract-"));
    root = join(parent, "mem");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "idx"), { recursive: true });
    store = await openQmd({ dbPath: join(parent, "idx", "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
    await remember(store, root, { fact: "Contract pin fact about redpanda broker", type: "project" });
  });
  afterAll(async () => {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("searchLex rows carry filepath/title/score with the consumed types", async () => {
    const results = await store.searchLex("redpanda broker", { limit: 5, collection: "memory" });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(typeof r.filepath).toBe("string");
    expect(typeof r.title).toBe("string");
    expect(typeof r.score).toBe("number");
    // The virtual-path layout parseVirtualMemoryPath() depends on: ...<type>/<slug>.md
    expect(r.filepath).toMatch(/(^|\/)project\/contract-pin-fact-about-redpanda-broker\.md$/);
  });
});
