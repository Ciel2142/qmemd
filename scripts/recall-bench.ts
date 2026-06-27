// Recall-quality bench (qmemd-3u8 + e16): runs every golden query through lex and hybrid and
// prints a scorecard. With --check it diffs an N-run MEDIAN against a committed baseline within
// a tolerance band and exits non-zero on regression (the floor-guard gate, 38c). Loads the embed
// model (hybrid path), so this is a `npm run` script, NEVER part of `npm test`.
//   npm run bench:recall                      # print-only (back-compat)
//   npm run bench:recall -- --update-baseline # author/refresh test/golden/recall-baseline.json
//   npm run bench:recall -- --check           # gate: median-vs-baseline, exit 1 on regression

import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { recallQueryWithStatus, DEFAULT_MIN_SCORE } from "../src/engine.js";
import { memoryEmbedModel } from "../src/store.js";
import { seedGoldenStore, type SeededStore, type GoldenQuery } from "../test/golden/seed.js";
import { scoreQuery, aggregate, medianAggregate, type QueryScore, type AggregateScore } from "../test/golden/metrics.js";

const GOLDEN = fileURLToPath(new URL("../test/golden/golden-set.json", import.meta.url));
const BASELINE = fileURLToPath(new URL("../test/golden/recall-baseline.json", import.meta.url));
const K = 5;
const TOLERANCE = 0.07; // > the ~0.05 hand-authored-set noise floor (judge dissent) so CI doesn't flap

interface ModeResult { agg: AggregateScore; avgMs: number; degradedCount: number }
interface Baseline { k: number; lex: AggregateScore; hybrid: AggregateScore; distractorFloorPrecision: number }

/** The hybrid query set = relevance queries + lex-hard paraphrases (e16). */
function hybridQueries(seeded: SeededStore): GoldenQuery[] {
  return [...seeded.golden.queries, ...(seeded.golden.paraphrase_queries ?? [])];
}

async function runMode(seeded: SeededStore, queries: GoldenQuery[], lexOnly: boolean): Promise<ModeResult> {
  const scores: QueryScore[] = [];
  let totalMs = 0;
  let degradedCount = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const res = await recallQueryWithStatus(seeded.store, seeded.root, q.query, { lexOnly, limit: K });
    totalMs += performance.now() - t0;
    if (res.degraded) degradedCount++;
    scores.push(scoreQuery(res.hits.map((h) => h.slug), new Set(q.relevant), K));
  }
  return { agg: aggregate(scores, K), avgMs: totalMs / Math.max(queries.length, 1), degradedCount };
}

/** Fraction of distractor queries that return NOTHING above the hybrid floor (e16 task b). */
async function distractorFloorPrecision(seeded: SeededStore): Promise<number> {
  const distractors = seeded.golden.distractors ?? [];
  if (distractors.length === 0) return 1;
  let clean = 0;
  for (const q of distractors) {
    const res = await recallQueryWithStatus(seeded.store, seeded.root, q, { limit: K }); // hybrid; floor applied
    if (res.hits.every((h) => (h.score ?? 0) < DEFAULT_MIN_SCORE)) clean++;
  }
  return clean / distractors.length;
}

function signed(n: number): string { return (n >= 0 ? "+" : "") + n.toFixed(3); }
function rowOf(label: string, m: ModeResult): string {
  return `${label.padEnd(8)} P@1=${m.agg.pAt1.toFixed(3)}  P@${K}=${m.agg.pAtK.toFixed(3)}  R@${K}=${m.agg.rAtK.toFixed(3)}  MRR=${m.agg.mrr.toFixed(3)}  avg=${m.avgMs.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const CHECK = argv.includes("--check");
  const UPDATE = argv.includes("--update-baseline");
  const runsArg = argv.find((a) => a.startsWith("--runs="));
  const RUNS = runsArg ? Math.max(1, parseInt(runsArg.split("=")[1] ?? "1", 10)) : (CHECK || UPDATE ? 5 : 1);

  const seeded = await seedGoldenStore(GOLDEN, { embedModel: memoryEmbedModel() });
  try {
    const hq = hybridQueries(seeded);
    // First hybrid call triggers the lazy embed barrier; run lex once for the comparison row.
    const lex = await runMode(seeded, hq, true);
    const hybridRuns: AggregateScore[] = [];
    for (let i = 0; i < RUNS; i++) hybridRuns.push((await runMode(seeded, hq, false)).agg);
    const hybridMedian = medianAggregate(hybridRuns);
    const floorPrec = await distractorFloorPrecision(seeded);

    console.log(`\nRecall-quality bench — ${hq.length} queries (${seeded.golden.queries.length} relevance + ${(seeded.golden.paraphrase_queries ?? []).length} paraphrase), ${seeded.golden.corpus.length} facts, k=${K}, runs=${RUNS}\n`);
    console.log(rowOf("lex", lex));
    console.log(`hybrid   P@1=${hybridMedian.pAt1.toFixed(3)}  P@${K}=${hybridMedian.pAtK.toFixed(3)}  R@${K}=${hybridMedian.rAtK.toFixed(3)}  MRR=${hybridMedian.mrr.toFixed(3)}  (median of ${RUNS})`);
    console.log(`distractor floor-precision: ${floorPrec.toFixed(3)} (${seeded.golden.distractors?.length ?? 0} distractors must stay below ${DEFAULT_MIN_SCORE})`);
    console.log(`\nΔ hybrid−lex:  P@1 ${signed(hybridMedian.pAt1 - lex.agg.pAt1)}  MRR ${signed(hybridMedian.mrr - lex.agg.mrr)}\n`);

    if (UPDATE) {
      const baseline: Baseline = { k: K, lex: lex.agg, hybrid: hybridMedian, distractorFloorPrecision: floorPrec };
      writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
      console.log(`✔ wrote baseline → ${BASELINE}`);
      return;
    }

    if (CHECK) {
      const base = JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline;
      const regressions: string[] = [];
      const guard = (name: string, cur: number, prev: number): void => {
        if (cur < prev - TOLERANCE) regressions.push(`${name}: ${cur.toFixed(3)} < baseline ${prev.toFixed(3)} − tol ${TOLERANCE}`);
      };
      guard("hybrid P@1", hybridMedian.pAt1, base.hybrid.pAt1);
      guard("hybrid MRR", hybridMedian.mrr, base.hybrid.mrr);
      guard("distractor floor-precision", floorPrec, base.distractorFloorPrecision);
      if (regressions.length > 0) {
        console.error(`\n✗ recall regression vs baseline (tolerance ${TOLERANCE}):`);
        for (const r of regressions) console.error(`   - ${r}`);
        process.exit(1);
      }
      console.log(`✔ --check passed: median within ${TOLERANCE} of baseline on all guarded metrics.`);
    }
  } finally {
    await seeded.cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
