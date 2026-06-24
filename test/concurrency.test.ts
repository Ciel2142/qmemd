import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import { remember, forget, recallQueryWithStatus, memoryFilePath } from "../src/engine.js";

// qmemd-k9q: real-store concurrency. The indexed:false self-heal was only ever proven
// against a hand-thrown SQLITE_BUSY fake; these tests race real remember/forget/recall
// calls on one shared store and assert the INVARIANTS (every write lands on disk, the
// index converges to the markdown corpus after one reindex, nothing crashes) rather than
// any particular interleaving. Lex-only — no model load.

describe("real-store concurrency (k9q)", () => {
  let parent: string, root: string, store: QMDStore;

  const lexSlugs = async (query: string): Promise<string[]> => {
    const res = await recallQueryWithStatus(store, root, query, { lexOnly: true });
    return res.hits.map(h => h.slug);
  };

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "qmemd-conc-"));
    root = join(parent, "mem");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "idx"), { recursive: true });
    store = await openQmd({ dbPath: join(parent, "idx", "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  });

  test("8 parallel remembers all write; the index converges after one reindex", async () => {
    const topics = [
      "Redpanda broker listens on port 9092", "Postgres pgvector hosts core",
      "Grafana lives on k3s sandbox", "Prefer Bun over Node",
      "Inbucket is the mail sink", "Qdrant serves vectors on 6333",
      "LLDAP is the directory service", "MinIO stores cold backups",
    ];
    const results = await Promise.all(
      topics.map(fact => remember(store, root, { fact, type: "project" })),
    );
    for (const [i, res] of results.entries()) {
      expect(res.wrote, `'${topics[i]}' did not write`).toBe(true);
      expect(existsSync(memoryFilePath(root, "project", res.slug))).toBe(true);
    }
    // Racing reindexes may leave some writes indexed:false (self-heal contract);
    // one reindex must converge the index to the full markdown corpus.
    await store.update({ collections: ["memory"] });
    expect(await lexSlugs("redpanda 9092")).toContain("redpanda-broker-listens-on-port-9092");
    expect(await lexSlugs("qdrant 6333")).toContain("qdrant-serves-vectors-on-6333");
    expect(await lexSlugs("minio backups")).toContain("minio-stores-cold-backups");
  });

  test("parallel forgets + remembers settle to the markdown end state", async () => {
    await remember(store, root, { fact: "Old fact alpha about rabbitmq", type: "project" });
    await remember(store, root, { fact: "Old fact beta about clickhouse", type: "project" });

    const [f1, f2, r1, r2] = await Promise.all([
      forget(store, root, "old-fact-alpha-about-rabbitmq"),
      forget(store, root, "old-fact-beta-about-clickhouse"),
      remember(store, root, { fact: "New fact gamma about gitea", type: "project" }),
      remember(store, root, { fact: "New fact delta about dolt", type: "project" }),
    ]);
    expect(f1.removed).toBe(true);
    expect(f2.removed).toBe(true);
    expect(r1.wrote).toBe(true);
    expect(r2.wrote).toBe(true);

    expect(existsSync(memoryFilePath(root, "project", "old-fact-alpha-about-rabbitmq"))).toBe(false);
    expect(existsSync(memoryFilePath(root, "project", "old-fact-beta-about-clickhouse"))).toBe(false);
    expect(existsSync(memoryFilePath(root, "project", "new-fact-gamma-about-gitea"))).toBe(true);
    expect(existsSync(memoryFilePath(root, "project", "new-fact-delta-about-dolt"))).toBe(true);

    await store.update({ collections: ["memory"] });
    expect(await lexSlugs("rabbitmq")).toEqual([]);
    expect(await lexSlugs("clickhouse")).toEqual([]);
    expect(await lexSlugs("gitea")).toContain("new-fact-gamma-about-gitea");
    expect(await lexSlugs("dolt")).toContain("new-fact-delta-about-dolt");
  });

  test("a lex recall racing a remember never crashes and returns a well-formed result", async () => {
    await remember(store, root, { fact: "Steady fact about kafka topics", type: "project" });
    const [recallRes, rememberRes] = await Promise.all([
      recallQueryWithStatus(store, root, "kafka topics", { lexOnly: true }),
      remember(store, root, { fact: "Racing fact about schema registry", type: "project" }),
    ]);
    expect(Array.isArray(recallRes.hits)).toBe(true);
    expect(recallRes.degraded).toBe(false); // lexOnly never degrades
    expect(rememberRes.wrote).toBe(true);
  });
});

describe("concurrent hybrid recalls share one embed-barrier outcome safely (k9q)", () => {
  // The lazy embed barrier runs per call (no cross-call lock): two concurrent hybrid
  // recalls may both see pending>0 and both call embed(). The invariant is that this is
  // SAFE — both calls complete un-degraded and the store is asked to embed at least once —
  // not that exactly one embed runs. Fake store: hybrid search must never load a model in
  // tests.
  function fakeStore(opts: { pending: number; embedDelayMs: number }) {
    let pending = opts.pending;
    let embedCalls = 0;
    const store = {
      async getStatus() {
        return { totalDocuments: 1, needsEmbedding: pending, hasVectorIndex: true, collections: [] };
      },
      async embed() {
        embedCalls++;
        await new Promise(r => setTimeout(r, opts.embedDelayMs));
        pending = 0;
        return { docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: opts.embedDelayMs };
      },
      async search() { return [{ file: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.9 }]; },
      async searchLex() { return [{ filepath: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.5 }]; },
    } as unknown as QMDStore;
    return { store, embedCalls: () => embedCalls };
  }

  test("two racing hybrid recalls both resolve un-degraded", async () => {
    const { store, embedCalls } = fakeStore({ pending: 2, embedDelayMs: 20 });
    const root = "/nonexistent-root-unused-by-fake"; // fake search never touches the fs
    const [a, b] = await Promise.all([
      recallQueryWithStatus(store, root, "foo"),
      recallQueryWithStatus(store, root, "foo"),
    ]);
    for (const res of [a, b]) {
      expect(res.degraded).toBe(false);
      expect(res.hits.map(h => h.slug)).toContain("foo");
    }
    expect(embedCalls()).toBeGreaterThanOrEqual(1);
  });
});
