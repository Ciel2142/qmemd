import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { recallQueryWithStatus, serializeMemory } from "../src/engine.js";

describe("scoped recall beyond qmd source limits (qp-94v2)", () => {
  let parent: string, root: string, store: QMDStore, target: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-scoped-recall-"));
    root = join(parent, "memory");
    await mkdir(join(root, "project"), { recursive: true });
    for (let i = 0; i < 61; i++) {
      const slug = `fact-${String(i).padStart(3, "0")}`;
      await writeFile(join(root, "project", `${slug}.md`), serializeMemory({
        name: slug, description: "Orchard guidance", type: "project", project: "other",
        created: "2026-01-01", tags: [], platforms: [], pinned: false,
      }, `Orchard guidance for tree ${i}.`));
    }
    store = await createStore({
      dbPath: join(parent, "index.sqlite"),
      config: { collections: { memory: { path: root, pattern: "**/*.md" } } },
    });
    await store.update();
    // SQLite retrieval/fusion/cache remain real; only inference is stubbed.
    vi.spyOn(store.internal.llm!, "expandQuery").mockResolvedValue([]);
    vi.spyOn(store.internal.llm!, "rerank").mockImplementation(async (_query, docs) => ({
      model: "test-reranker", results: docs.map((doc, index) => ({ file: doc.file, index, score: 0.8 })),
    }));
    const status = await store.getStatus();
    vi.spyOn(store, "getStatus").mockResolvedValue({ ...status, needsEmbedding: 0 });
    const all = await store.searchLex("orchard", { limit: 100, collection: "memory" });
    expect(all).toHaveLength(61);
    target = all.at(-1)!.filepath.split("/").at(-1)!.replace(/\.md$/, "");
    // Scope is read from live frontmatter, independently of the search index.
    const path = join(root, "project", `${target}.md`);
    await writeFile(path, (await readFile(path, "utf8")).replace("project: other", "project: alpha"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store?.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("finds the in-project fact beyond the first 20 hybrid candidates", async () => {
    const result = await recallQueryWithStatus(store, root, "orchard", { project: "alpha", limit: 10 });
    expect(result.hits.map(h => h.slug)).toEqual([target]);
    expect(result.hits[0]!.score).toBe(0.8);
    expect(result.degraded).toBe(false);
    // Lexical backfill cannot prove the vector/expanded sources were exhaustive.
    expect(result.saturated).toBe(true);
  });

  test("does not claim completeness when a non-scoped hybrid page stops at its source cap", async () => {
    const result = await recallQueryWithStatus(store, root, "orchard", { platform: "all", limit: 100 });
    expect(result.saturated).toBe(true);
  });

  test("backfilled candidates still obey the reranker relevance floor", async () => {
    const result = await recallQueryWithStatus(store, root, "orchard", { project: "alpha", minScore: 0.95 });
    expect(result.hits).toEqual([]);
    expect(result.belowFloor).toBe(1);
    expect(result.saturated).toBe(true);
  });

  test.each(["platforms: [windows]", "superseded_by: successor"])("backfill respects %s", async field => {
    const path = join(root, "project", `${target}.md`);
    await writeFile(path, (await readFile(path, "utf8")).replace("project: alpha", `project: alpha\n${field}`));
    const result = await recallQueryWithStatus(store, root, "orchard", { project: "alpha", platform: "linux" });
    expect(result.hits).toEqual([]);
    expect(result.belowFloor).toBe(0);
  });

  test("a backfill rerank failure returns an explicitly degraded lexical result", async () => {
    const rerank = store.internal.rerank.bind(store.internal);
    vi.spyOn(store.internal, "rerank").mockImplementation((query, docs, ...rest) => {
      if (docs.some(d => !d.file.startsWith("qmd://"))) return Promise.reject(new Error("reranker unavailable"));
      return rerank(query, docs, ...rest);
    });
    const result = await recallQueryWithStatus(store, root, "orchard", { project: "alpha" });
    expect(result.hits.map(h => h.slug)).toEqual([target]);
    expect(result.degraded).toBe(true);
    expect(result.vectorsPending).toBe(-1);
    expect(result.belowFloor).toBe(0);
  });
});
