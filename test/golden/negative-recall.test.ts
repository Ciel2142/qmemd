import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import { recallQueryWithStatus } from "../../src/engine.js";
import { negativeQueryRejected } from "./metrics.js";
import { seedGoldenStore, type SeededStore } from "./seed.js";

let seeded: SeededStore;
beforeAll(async () => { seeded = await seedGoldenStore(join(__dirname, "golden-set.json")); });
afterAll(async () => { await seeded?.cleanup(); });
afterEach(() => { vi.unstubAllEnvs(); });

test("a hard negative's actual below-floor rescue counts as a false positive", async () => {
  // The corpus knows Redpanda's broker port, but has no license-pricing fact. Its
  // unique product token can still rescue that irrelevant fact near the floor.
  const query = "redpanda enterprise license renewal price";
  expect(seeded.golden.distractors).toContain(query);
  const fact = seeded.golden.corpus.find((f) => f.slug.startsWith("redpanda-"))!;
  const store = {
    async getStatus() { return { totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
    async search() {
      return [{ file: `qmd://memory/${fact.type}/${fact.slug}.md`, title: fact.fact, score: 0.9, explain: { rerankScore: 0.55 } }];
    },
    async searchLex() { throw new Error("this fixture must use hybrid recall"); },
  } as unknown as QMDStore;

  vi.stubEnv("QMEMD_RESCUE_DELTA", "0.05");
  const rescued = await recallQueryWithStatus(store, seeded.root, query);
  expect(rescued.degraded).toBe(false);
  expect(rescued.hits).toHaveLength(1);
  expect(rescued.hits[0]).toMatchObject({ slug: fact.slug, score: 0.55, rescued: true });
  expect(negativeQueryRejected(rescued.hits)).toBe(false);

  vi.stubEnv("QMEMD_RESCUE_DELTA", "0");
  const rejected = await recallQueryWithStatus(store, seeded.root, query);
  expect(rejected.hits).toEqual([]);
  expect(negativeQueryRejected(rejected.hits)).toBe(true);
});
