import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { validateGoldenSet, loadGoldenSet, seedGoldenStore, topSlug, type SeededStore } from "./seed.js";

const GOLDEN = join(__dirname, "golden-set.json");

describe("validateGoldenSet", () => {
  test("rejects a query referencing an unknown slug", () => {
    const bad = {
      corpus: [{ type: "project" as const, fact: "x", slug: "x" }],
      queries: [{ query: "q", relevant: ["nope"] }],
      min_score: 0.5,
    };
    expect(() => validateGoldenSet(bad)).toThrow(/unknown slug 'nope'/);
  });

  test("rejects a duplicate corpus slug", () => {
    const bad = {
      corpus: [
        { type: "project" as const, fact: "a", slug: "dup" },
        { type: "project" as const, fact: "b", slug: "dup" },
      ],
      queries: [],
      min_score: 0.5,
    };
    expect(() => validateGoldenSet(bad)).toThrow(/duplicate corpus slug 'dup'/);
  });

  test("rejects a query with no relevant slugs", () => {
    const bad = {
      corpus: [{ type: "project" as const, fact: "x", slug: "x" }],
      queries: [{ query: "q", relevant: [] }],
      min_score: 0.5,
    };
    expect(() => validateGoldenSet(bad)).toThrow(/no relevant slugs/);
  });
});

describe("topSlug", () => {
  test("defaults to relevant[0] when top is absent", () => {
    expect(topSlug({ query: "q", relevant: ["a", "b"] })).toBe("a");
    expect(topSlug({ query: "q", relevant: ["a", "b"], top: "b" })).toBe("b");
  });
});

describe("committed golden set", () => {
  test("loads, passes integrity, and is grown (>=30 facts, >=12 queries)", async () => {
    const golden = await loadGoldenSet(GOLDEN); // throws if invalid
    expect(golden.corpus.length).toBeGreaterThanOrEqual(30);
    expect(golden.queries.length).toBeGreaterThanOrEqual(12);
    expect(golden.queries.some((q) => q.relevant.length === 1)).toBe(true); // has lex anchors
  });
});

describe("seedGoldenStore (model-free)", () => {
  let seeded: SeededStore | undefined;
  afterEach(async () => { await seeded?.cleanup(); seeded = undefined; });

  test("seeds every corpus fact under its expected slug", async () => {
    seeded = await seedGoldenStore(GOLDEN); // no embedModel → lex-only, no model load
    const status = await seeded.store.getStatus();
    expect(status.totalDocuments).toBe(seeded.golden.corpus.length);
  });
});
