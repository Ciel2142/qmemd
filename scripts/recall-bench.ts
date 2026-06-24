// Recall-quality bench (qmemd-3u8): runs every golden query through BOTH lex and hybrid,
// then prints a comparison scorecard (P@1 / P@k / R@k / MRR) + per-query average latency
// + the lex-vs-hybrid delta. Loads the embedding model (hybrid path), so this is a
// `npm run` script and is NEVER part of `npm test` (vitest stays model-free).
// Run: npm run bench:recall   (first run downloads embeddinggemma-300M, ~0.5 GB, if uncached)
// The bench:recall npm script sets QMEMD_EMBED_TIMEOUT_MS=120000 so the cold 34-doc embed on the first hybrid recall clears the engine's 6s default barrier (DEFAULT_EMBED_TIMEOUT_MS) — otherwise hybrid would time out, fall back to lex, and print "hybrid DEGRADED".

import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { recallQueryWithStatus } from "../src/engine.js";
import { memoryEmbedModel } from "../src/store.js";
import { seedGoldenStore, type SeededStore } from "../test/golden/seed.js";
import { scoreQuery, aggregate, type QueryScore, type AggregateScore } from "../test/golden/metrics.js";

const GOLDEN = fileURLToPath(new URL("../test/golden/golden-set.json", import.meta.url));
const K = 5;

interface ModeResult { agg: AggregateScore; avgMs: number; degradedCount: number }

async function runMode(seeded: SeededStore, lexOnly: boolean): Promise<ModeResult> {
  const scores: QueryScore[] = [];
  let totalMs = 0;
  let degradedCount = 0;
  for (const q of seeded.golden.queries) {
    const t0 = performance.now();
    const res = await recallQueryWithStatus(seeded.store, seeded.root, q.query, { lexOnly, limit: K });
    totalMs += performance.now() - t0;
    if (res.degraded) degradedCount++;
    scores.push(scoreQuery(res.hits.map((h) => h.slug), new Set(q.relevant), K));
  }
  return { agg: aggregate(scores, K), avgMs: totalMs / Math.max(seeded.golden.queries.length, 1), degradedCount };
}

function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(3);
}

async function main(): Promise<void> {
  const seeded = await seedGoldenStore(GOLDEN, { embedModel: memoryEmbedModel() });
  try {
    const lex = await runMode(seeded, true);
    const hybrid = await runMode(seeded, false); // first hybrid call triggers the lazy embed barrier
    const row = (label: string, m: ModeResult): string =>
      `${label.padEnd(8)} P@1=${m.agg.pAt1.toFixed(3)}  P@${K}=${m.agg.pAtK.toFixed(3)}  R@${K}=${m.agg.rAtK.toFixed(3)}  MRR=${m.agg.mrr.toFixed(3)}  avg=${m.avgMs.toFixed(0)}ms`;
    console.log(`\nRecall-quality bench — ${seeded.golden.queries.length} queries, ${seeded.golden.corpus.length} facts, k=${K}\n`);
    console.log(row("lex", lex));
    console.log(row("hybrid", hybrid));
    if (hybrid.degradedCount > 0) {
      console.log(`\n⚠ hybrid DEGRADED on ${hybrid.degradedCount}/${seeded.golden.queries.length} queries (embed model unavailable or vectors pending) — hybrid numbers are NOT trustworthy.`);
    }
    console.log(
      `\nΔ hybrid−lex:  P@1 ${signed(hybrid.agg.pAt1 - lex.agg.pAt1)}  ` +
      `MRR ${signed(hybrid.agg.mrr - lex.agg.mrr)}  ` +
      `latency +${(hybrid.avgMs - lex.avgMs).toFixed(0)}ms/query\n`,
    );
  } finally {
    await seeded.cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
