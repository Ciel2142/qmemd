// Recall-quality bench (qmemd-3u8 + e16): runs every golden query through lex and hybrid and
// prints a scorecard. With --check it diffs an N-run MEDIAN against a committed baseline within
// a tolerance band and exits non-zero on regression (the floor-guard gate, 38c). Loads the embed
// model (hybrid path), so this is a `npm run` script, NEVER part of `npm test`.
//   npm run bench:recall                      # print-only (back-compat)
//   npm run bench:recall -- --update-baseline # author/refresh test/golden/recall-baseline.json
//   npm run bench:recall -- --check           # gate: median-vs-baseline, exit 1 on regression

// PROHIBITED CLAIMS (methodology §3.7) — any output contradicting these is a bug in the reporting:
// 1. No bare proportion without a Wilson 95% CI.
// 2. No "hybrid improves recall ~5.6%" or similar unqualified improvement claim.
// 3. No LoCoMo-comparable accuracy claims — this corpus is ~20 hand-authored facts, not a benchmark.
// 4. No "0.575 is optimal" — the min-score floor is a noise guard, not a calibrated optimum.
// 5. No cross-machine comparison without matching provenance (model version, corpus hash).
// 6. No "relevance improved" below the ~0.30 MDE — deltas below this are not detectable on n≈20.
// 7. No P@K without its success@k twin — P@K is structurally capped on single-relevant queries.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { recallQueryWithStatus, DEFAULT_MIN_SCORE } from "../src/engine.js";
import { memoryEmbedModel } from "../src/store.js";
import { seedGoldenStore, type SeededStore, type GoldenQuery } from "../test/golden/seed.js";
import {
  scoreQuery, aggregate, medianAggregate, wilson, mcnemar,
  successCount, checkProvenance, unknownProvenanceFields, payloadStats, mdeBannerDrift,
  type QueryScore, type AggregateScore,
} from "../test/golden/metrics.js";

const GOLDEN = fileURLToPath(new URL("../test/golden/golden-set.json", import.meta.url));
const BASELINE = fileURLToPath(new URL("../test/golden/recall-baseline.json", import.meta.url));
const K = 5;
const TOLERANCE = 0.07; // > the ~0.05 hand-authored-set noise floor (judge dissent) so CI doesn't flap

interface ModeResult {
  agg: AggregateScore;
  avgMs: number;
  degradedCount: number;
  perQueryHit1: boolean[]; // true if pAt1===1 for each query (index-aligned with queries)
  queryLabels: string[];   // truncated query text for per-query table
  perQueryRr: number[];    // per-query reciprocal rank (0 if no relevant hit found)
  perQueryBytes: number[]; // total payload bytes per query (description + body of all hits)
}
interface Baseline {
  k: number;
  lex: AggregateScore;
  hybrid: AggregateScore;
  distractorFloorPrecision: number;
  provenance?: {
    embedModel: string;
    qmdVersion: string;
    runs: number;
    k: number;
    tolerance: number;
    node: string;
    platform: string;
    arch: string;
    gitSha: string;
    date: string;
  };
}

/** The hybrid query set = relevance queries + lex-hard paraphrases (e16). */
function hybridQueries(seeded: SeededStore): GoldenQuery[] {
  return [...seeded.golden.queries, ...(seeded.golden.paraphrase_queries ?? [])];
}

async function runMode(seeded: SeededStore, queries: GoldenQuery[], lexOnly: boolean): Promise<ModeResult> {
  const scores: QueryScore[] = [];
  const queryLabels: string[] = [];
  const perQueryBytes: number[] = [];
  let totalMs = 0;
  let degradedCount = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const res = await recallQueryWithStatus(seeded.store, seeded.root, q.query, { lexOnly, limit: K });
    totalMs += performance.now() - t0;
    if (res.degraded) degradedCount++;
    scores.push(scoreQuery(res.hits.map((h) => h.slug), new Set(q.relevant), K));
    queryLabels.push(q.query.length > 40 ? q.query.slice(0, 37) + "…" : q.query);
    const bytes = res.hits.reduce(
      (sum, h) => sum + Buffer.byteLength(h.body ?? "", "utf-8") + Buffer.byteLength(h.description ?? "", "utf-8"),
      0,
    );
    perQueryBytes.push(bytes);
  }
  return {
    agg: aggregate(scores, K),
    avgMs: totalMs / Math.max(queries.length, 1),
    degradedCount,
    perQueryHit1: scores.map((s) => s.pAt1 === 1),
    queryLabels,
    perQueryRr: scores.map((s) => s.rr),
    perQueryBytes,
  };
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

/** Proportion with Wilson 95% CI: "p.ppp [lo.lo,hi.hi]". The CI needs the EXACT integer success
 *  count — `successCount` returns null when `p·n` is non-integer (an even-run median that fell
 *  between two counts), and we suppress the CI rather than fabricate one from a rounded count
 *  (false precision, methodology §3.7). The odd-run default (5) always yields an integer. */
function pc(p: number, n: number): string {
  const k = successCount(p, n);
  if (k === null) return `${p.toFixed(3)} [no CI: even-run median between integer counts — re-run with odd --runs]`;
  const { lo, hi } = wilson(k, n);
  return `${p.toFixed(3)} [${lo.toFixed(2)},${hi.toFixed(2)}]`;
}

function rowOf(label: string, m: ModeResult): string {
  const { agg } = m;
  return `${label.padEnd(8)} P@1=${pc(agg.pAt1, agg.n)}  P@${K}=${agg.pAtK.toFixed(3)}  S@${K}=${pc(agg.successAtK, agg.n)}  R@${K}=${agg.rAtK.toFixed(3)}  MRR=${agg.mrr.toFixed(3)}  avg=${m.avgMs.toFixed(0)}ms`;
}

function payloadRow(label: string, bytes: number[]): string {
  const { mean, median, p95 } = payloadStats(bytes);
  const tokEst = (b: number) => `~${Math.round(b / 4)} tok (est, ±20%)`;
  return `  ${label.padEnd(8)} mean=${Math.round(mean)}B  median=${median}B  p95=${p95}B  → ${tokEst(p95)} @p95`;
}

function gitSha(): string {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "unknown"; }
}
function qmdVersion(): string {
  try { return JSON.parse(readFileSync(new URL("../node_modules/@tobilu/qmd/package.json", import.meta.url), "utf-8")).version as string; } catch { return "unknown"; }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const CHECK = argv.includes("--check");
  const UPDATE = argv.includes("--update-baseline");
  const runsArg = argv.find((a) => a.startsWith("--runs="));
  const defaultRuns = CHECK || UPDATE ? 5 : 1;
  const parsedRuns = runsArg ? parseInt(runsArg.split("=")[1] ?? "", 10) : NaN;
  const RUNS = Number.isFinite(parsedRuns) ? Math.max(1, parsedRuns) : defaultRuns; // NaN (--runs=abc) falls back to the default

  if (CHECK && UPDATE) {
    console.error("✗ pass only one of --check / --update-baseline — they conflict (--check gates against the baseline; --update-baseline rewrites it). Aborting.");
    process.exit(1);
  }

  // Early model-pin guard (before expensive recall runs — see methodology §3.6). checkProvenance()
  // and memoryEmbedModel()/qmdVersion() are pure config reads — no model load, so this is cheap.
  // The baseline read here is reused by the regression compare below (no second read under --check).
  let checkBaseline: Baseline | null = null;
  if (CHECK) {
    try {
      checkBaseline = JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        console.error(`✗ no baseline at ${BASELINE} to --check against. Run \`npm run bench:recall -- --update-baseline\` first.`);
        process.exit(1);
      }
      throw e;
    }
    const pin = checkProvenance(checkBaseline, memoryEmbedModel(), qmdVersion());
    if (pin.action === "warn") console.warn(`⚠ ${pin.message}`);
    else if (pin.action === "fail") { console.error(`✗ ${pin.message}`); process.exit(1); }
  }

  const provenance = {
    embedModel: memoryEmbedModel(),
    qmdVersion: qmdVersion(),
    runs: RUNS,
    k: K,
    tolerance: TOLERANCE,
    node: process.version,
    platform: process.platform as string,
    arch: process.arch,
    gitSha: gitSha(),
    date: new Date().toISOString(),
  };

  const seeded = await seedGoldenStore(GOLDEN, { embedModel: memoryEmbedModel() });
  try {
    const hq = hybridQueries(seeded);

    console.log(`\n⚠ n=${hq.length} → MDE ≈ 0.30 at 80% power. Deltas below ~0.30 are NOT detectable on this corpus; report them as "no measurable difference," never as a win (methodology §3.3).`);
    const mdeDrift = mdeBannerDrift(hq.length);
    if (mdeDrift) console.warn(`⚠ ${mdeDrift}`);

    // First hybrid call triggers the lazy embed barrier; run lex once for the comparison row.
    const lex = await runMode(seeded, hq, true);
    const hybridRuns: AggregateScore[] = [];
    let hybridDegraded = 0;
    let lastHybrid: ModeResult | null = null;
    for (let i = 0; i < RUNS; i++) {
      const r = await runMode(seeded, hq, false);
      hybridRuns.push(r.agg);
      hybridDegraded += r.degradedCount;
      lastHybrid = r;
    }
    const hybridMedian = medianAggregate(hybridRuns);
    const floorPrec = await distractorFloorPrecision(seeded);

    console.log(`\nRecall-quality bench — ${hq.length} queries (${seeded.golden.queries.length} relevance + ${(seeded.golden.paraphrase_queries ?? []).length} paraphrase), ${seeded.golden.corpus.length} facts, k=${K}, runs=${RUNS}\n`);
    console.log(rowOf("lex", lex));
    console.log(`hybrid   P@1=${pc(hybridMedian.pAt1, hybridMedian.n)}  P@${K}=${hybridMedian.pAtK.toFixed(3)}  S@${K}=${pc(hybridMedian.successAtK, hybridMedian.n)}  R@${K}=${hybridMedian.rAtK.toFixed(3)}  MRR=${hybridMedian.mrr.toFixed(3)}  (median of ${RUNS})`);
    console.log(`  * Wilson 95% CI shown for P@1 and S@K (binomial). P@K, R@k and MRR are means of per-query ratios — no CI (P@K is report-only / structurally capped — see S@K).`);
    console.log(`distractor floor-precision: ${floorPrec.toFixed(3)} (${seeded.golden.distractors?.length ?? 0} distractors must stay below ${DEFAULT_MIN_SCORE})`);

    // Paired McNemar test (lex vs hybrid @1) — replaces the bare Δ row.
    const lexHits1 = lex.perQueryHit1;
    const hybridHits1 = lastHybrid!.perQueryHit1;
    const mc = mcnemar(lexHits1.map((l, i) => ({ lex: l, hybrid: hybridHits1[i]! })));
    console.log(`\nPaired hybrid−lex: net ${mc.c - mc.b} queries (b=${mc.b} lex-only, c=${mc.c} hybrid-only), McNemar χ²=${mc.statistic.toFixed(2)}, p≈${mc.pApprox.toFixed(2)} ${mc.pApprox < 0.05 ? "(significant)" : "(NOT significant)"}\n`);

    // Per-query disaggregation table — lex@1, hybrid@1, hybrid rank (from last run).
    const hybridRrArr = lastHybrid!.perQueryRr;
    const labels = lex.queryLabels;
    console.log("Per-query breakdown:");
    console.log(`${"Query".padEnd(42)}  lex@1  hybrid@1  hybridRank`);
    console.log("-".repeat(68));
    for (let i = 0; i < hq.length; i++) {
      const label = (labels[i] ?? "").padEnd(42);
      const l1 = lexHits1[i] ? "✓" : "✗";
      const h1 = hybridHits1[i] ? "✓" : "✗";
      const rr = hybridRrArr[i] ?? 0;
      const rank = rr > 0 ? String(Math.round(1 / rr)) : "—";
      console.log(`${label}  ${l1.padEnd(5)}  ${h1.padEnd(9)} ${rank}`);
    }
    console.log();

    // Byte-economy block (RECALL_BODY_CAP=500 bounds each hit's body — payloads are bounded).
    console.log("Payload-byte economy (per-query, RECALL_BODY_CAP=500 bounds each hit body):");
    console.log(payloadRow("lex", lex.perQueryBytes));
    console.log(payloadRow("hybrid", lastHybrid!.perQueryBytes));
    console.log();

    if (hybridDegraded > 0) {
      console.warn(`\n⚠ hybrid DEGRADED on ${hybridDegraded} query-runs — the embed model did not load; scores are lex-equivalent and NOT trustworthy.`);
    }

    if (UPDATE) {
      if (hybridDegraded > 0) {
        console.error("✗ refusing to write a DEGRADED baseline (embed model did not load). Fix the model setup and re-run.");
        process.exit(1);
      }
      const unknowns = unknownProvenanceFields(provenance);
      if (unknowns.length > 0) {
        console.warn(`⚠ provenance fields resolved to "unknown" (non-reproducible): ${unknowns.join(", ")}. The baseline is written but cannot be pin-checked on these fields — fix git / the @tobilu/qmd install and re-run to restore reproducibility.`);
      }
      const baseline: Baseline = { k: K, lex: lex.agg, hybrid: hybridMedian, distractorFloorPrecision: floorPrec, provenance };
      writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
      console.log(`✔ wrote baseline → ${BASELINE}`);
      return;
    }

    if (CHECK) {
      if (hybridDegraded > 0) {
        console.error("✗ refusing to --check against a DEGRADED run (embed model did not load); scores are lex-equivalent and untrustworthy.");
        process.exit(1);
      }
      const base = checkBaseline!; // read once in the early model-pin guard above
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
