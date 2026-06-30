import { describe, test, expect } from "vitest";
import type { QMDStore } from "@tobilu/qmd";
import { distinctiveOverlap, isRescueEligible, recallQueryWithStatus, type RecallHit } from "../src/engine.js";
import { toHitDTO } from "../src/mcp/server.js";

// A fake hybrid store: each entry becomes a search hit carrying explain.rerankScore. Files do
// NOT exist on disk, so the recall gate's parseOnce fails open (fm=null) — slug (path-derived)
// is the overlap signal here; tags/project overlap is covered by the pure distinctiveOverlap
// units above. Model-free, mirrors the rde floor test's captureStore (engine.test.ts).
function hybridStore(entries: Array<{ slug: string; type?: string; rerank?: number; score?: number }>): QMDStore {
  return {
    async getStatus() { return { totalDocuments: entries.length, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
    async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
    async search(o: { limit?: number }) {
      return entries.slice(0, o?.limit ?? 10).map(e => ({
        file: `qmd://memory/${e.type ?? "project"}/${e.slug}.md`,
        title: e.slug,
        score: e.score ?? 0.9,
        ...(e.rerank !== undefined ? { explain: { rerankScore: e.rerank } } : {}),
      }));
    },
    async searchLex() { return []; },
  } as unknown as QMDStore;
}

// qp-dnx: tag-overlap rescue + lexicographic tie-break boost for recall.
// Model-free pure units first (the overlap signal + rescue eligibility), then the
// fake-store wiring. Consilium ruling A+floorfix: floor stays on RAW rerankScore;
// overlap only reorders near-equals + backfills below-floor on-target facts.

describe("distinctiveOverlap (qp-dnx)", () => {
  test("counts a distinctive token shared between the query and the fact slug", () => {
    const n = distinctiveOverlap("kafka dlq topology", { slug: "kafka-dlq-per-pair-naming", project: "esb", tags: [] });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  test("ignores a shared token that is only on the static stoplist", () => {
    // 'build' overlaps but is generic (stoplisted) → no distinctive signal.
    expect(distinctiveOverlap("build pipeline", { slug: "edmbpmn-k3s-image-build", project: "esb" })).toBe(0);
  });

  test("counts a token shared via tags even when the slug does not overlap", () => {
    expect(distinctiveOverlap("latency", { slug: "qmd-internals", project: "global", tags: ["latency", "perf-opt"] })).toBe(1);
  });

  test("returns 0 when nothing distinctive overlaps", () => {
    expect(distinctiveOverlap("kafka", { slug: "postgres-pgvector-core-db", project: "esb" })).toBe(0);
  });

  test("returns 0 for an empty query", () => {
    expect(distinctiveOverlap("", { slug: "kafka-dlq-per-pair-naming" })).toBe(0);
  });
});

describe("isRescueEligible (qp-dnx)", () => {
  test("eligible when raw score is within delta below the floor and overlap >= 1", () => {
    expect(isRescueEligible(0.55, 1, 0.575, 0.05)).toBe(true);
  });

  test("not eligible without any distinctive overlap", () => {
    expect(isRescueEligible(0.55, 0, 0.575, 0.05)).toBe(false);
  });

  test("not eligible when the raw score is at or above the floor (it was not dropped)", () => {
    expect(isRescueEligible(0.575, 1, 0.575, 0.05)).toBe(false);
    expect(isRescueEligible(0.60, 2, 0.575, 0.05)).toBe(false);
  });

  test("not eligible when the raw score falls more than delta below the floor (noise band)", () => {
    expect(isRescueEligible(0.50, 2, 0.575, 0.05)).toBe(false); // 0.50 < 0.525
  });

  test("the lower band edge (floor - delta) is inclusive", () => {
    expect(isRescueEligible(0.525, 1, 0.575, 0.05)).toBe(true);
  });

  test("delta 0 disables rescue at the predicate level (kill switch)", () => {
    expect(isRescueEligible(0.5749, 5, 0.575, 0)).toBe(false);
  });
});

describe("recall below-floor rescue wiring (fake store) (qp-dnx)", () => {
  const root = "/tmp/qmemd-fake-rescue";

  test("rescues a below-floor fact whose slug overlaps the query, appended to the tail and marked", async () => {
    const store = hybridStore([
      { slug: "redis-acl-disables-default-user", rerank: 0.73 }, // above floor → normal hit
      { slug: "kafka-dlq-per-pair-naming", rerank: 0.55 },       // below 0.575, overlaps "kafka dlq" → rescue
      { slug: "postgres-pgvector-core-db", rerank: 0.50 },       // below floor, no overlap → noise (stays dropped)
    ]);
    const res = await recallQueryWithStatus(store, root, "kafka dlq");
    const slugs = res.hits.map(h => h.slug);
    expect(slugs).toContain("kafka-dlq-per-pair-naming");
    expect(res.hits.find(h => h.slug === "kafka-dlq-per-pair-naming")?.rescued).toBe(true);
    expect(slugs[slugs.length - 1], "rescued fact goes to the tail").toBe("kafka-dlq-per-pair-naming");
    expect(res.hits.find(h => h.slug === "redis-acl-disables-default-user")?.rescued, "normal hit unmarked").toBeFalsy();
  });

  test("belowFloor is decremented by the rescued count", async () => {
    const store = hybridStore([
      { slug: "redis-acl-disables-default-user", rerank: 0.73 },
      { slug: "kafka-dlq-per-pair-naming", rerank: 0.55 },
      { slug: "postgres-pgvector-core-db", rerank: 0.50 },
    ]);
    const res = await recallQueryWithStatus(store, root, "kafka dlq");
    expect(res.belowFloor).toBe(1); // 2 below floor, 1 rescued
  });

  test("does not rescue a below-floor fact more than delta under the floor even with overlap (noise)", async () => {
    const store = hybridStore([{ slug: "kafka-dlq-per-pair-naming", rerank: 0.50 }]); // 0.50 < 0.525
    const res = await recallQueryWithStatus(store, root, "kafka dlq");
    expect(res.hits.length).toBe(0);
    expect(res.belowFloor).toBe(1);
  });

  test("the QMEMD_RESCUE_DELTA=0 kill switch reproduces pre-feature recall (no rescue)", async () => {
    const store = hybridStore([
      { slug: "redis-acl-disables-default-user", rerank: 0.73 },
      { slug: "kafka-dlq-per-pair-naming", rerank: 0.55 },
      { slug: "postgres-pgvector-core-db", rerank: 0.50 },
    ]);
    const prev = process.env.QMEMD_RESCUE_DELTA;
    process.env.QMEMD_RESCUE_DELTA = "0";
    try {
      const res = await recallQueryWithStatus(store, root, "kafka dlq");
      expect(res.hits.map(h => h.slug)).toEqual(["redis-acl-disables-default-user"]);
      expect(res.hits.some(h => h.rescued)).toBe(false);
      expect(res.belowFloor).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.QMEMD_RESCUE_DELTA;
      else process.env.QMEMD_RESCUE_DELTA = prev;
    }
  });

  test("caps the rescue tail at RECALL_RESCUE_CAP (2)", async () => {
    const store = hybridStore([
      { slug: "kafka-one-topic-naming", rerank: 0.56 },
      { slug: "kafka-two-dlq-naming", rerank: 0.55 },
      { slug: "kafka-three-retry-naming", rerank: 0.54 },
    ]);
    const res = await recallQueryWithStatus(store, root, "kafka naming");
    expect(res.hits.filter(h => h.rescued).length).toBe(2); // 3 eligible, capped at 2
    expect(res.belowFloor).toBe(1);
  });

  test("orders an overlapping fact above an equally-bucketed non-overlapping one (tie-break boost)", async () => {
    // Both above the floor and in the SAME 0.02 score bucket; the kafka-overlapping fact must
    // rank first even though the other has a hair-higher raw score within the bucket.
    const store = hybridStore([
      { slug: "redis-acl-generic-note", rerank: 0.705 },    // higher raw, no overlap
      { slug: "kafka-dlq-per-pair-naming", rerank: 0.70 },  // lower raw, overlaps "kafka"
    ]);
    const res = await recallQueryWithStatus(store, root, "kafka");
    expect(res.hits.map(h => h.slug)[0]).toBe("kafka-dlq-per-pair-naming");
  });
});

describe("rescued provenance surfacing (qp-dnx)", () => {
  const base: RecallHit = { slug: "x", path: "/tmp/x.md", type: "project", description: "d", platforms: [], project: "global" };

  test("toHitDTO surfaces rescued:true so the MCP model sees a below-floor fact's provenance", () => {
    expect(toHitDTO({ ...base, rescued: true }).rescued).toBe(true);
  });

  test("toHitDTO omits rescued on a normal above-floor hit", () => {
    expect(toHitDTO(base).rescued).toBeUndefined();
  });
});
