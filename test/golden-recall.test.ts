import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { recallQueryWithStatus } from "../src/engine.js";
import { seedGoldenStore, topSlug, type SeededStore } from "./golden/seed.js";
import { scoreQuery, aggregate, type QueryScore } from "./golden/metrics.js";

// qmemd-3u8: graded lex recall guard. Seeds the committed golden set into a real store
// (lex-only — no model, per the repo's model-free test rule) and enforces TWO guards:
//   (1) tripwire — every single-relevant "lex anchor" query ranks its slug first;
//   (2) aggregate — P@1 and MRR over ALL queries clear committed floors.
// Fails cheaply if BM25/ranking tuning, the dedup tiers, or a qmd SDK upgrade regress recall.

const GOLDEN = join(__dirname, "golden", "golden-set.json");
const K = 5;
// Committed lex floors. Tune to just below the first green run so noise doesn't flap CI,
// but a real ranking regression trips them. Lex-only — the hybrid path is measured by
// `npm run bench:recall`, never here.
const LEX_P_AT_1_FLOOR = 0.8;
const LEX_MRR_FLOOR = 0.85;

describe("lex recall golden set (3u8)", () => {
  let seeded: SeededStore;
  beforeAll(async () => { seeded = await seedGoldenStore(GOLDEN); }); // no embedModel → model-free
  afterAll(async () => { await seeded?.cleanup(); });

  test("every lex-anchor query ranks its top slug first, above the score floor", async () => {
    const anchors = seeded.golden.queries.filter((q) => q.relevant.length === 1);
    expect(anchors.length, "golden set has no single-relevant lex anchors").toBeGreaterThan(0);
    for (const q of anchors) {
      const res = await recallQueryWithStatus(seeded.store, seeded.root, q.query, { lexOnly: true });
      expect(res.hits.length, `query '${q.query}' returned no hits`).toBeGreaterThan(0);
      expect(res.hits[0].slug, `query '${q.query}' top hit`).toBe(topSlug(q));
      expect(res.hits[0].score ?? 0, `query '${q.query}' score floor`).toBeGreaterThanOrEqual(seeded.golden.min_score);
    }
  });

  test("aggregate lex metrics clear the committed floors", async () => {
    const scores: QueryScore[] = [];
    for (const q of seeded.golden.queries) {
      const res = await recallQueryWithStatus(seeded.store, seeded.root, q.query, { lexOnly: true, limit: K });
      scores.push(scoreQuery(res.hits.map((h) => h.slug), new Set(q.relevant), K));
    }
    const agg = aggregate(scores, K);
    // eslint-disable-next-line no-console
    console.log(`\n[golden lex] n=${agg.n} P@1=${agg.pAt1.toFixed(3)} P@${K}=${agg.pAtK.toFixed(3)} R@${K}=${agg.rAtK.toFixed(3)} MRR=${agg.mrr.toFixed(3)}`);
    expect(agg.pAt1).toBeGreaterThanOrEqual(LEX_P_AT_1_FLOOR);
    expect(agg.mrr).toBeGreaterThanOrEqual(LEX_MRR_FLOOR);
  });
});
