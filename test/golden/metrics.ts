// Pure IR metrics for the recall-quality harness (qmemd-3u8). No I/O, no model — pure
// functions of a ranked slug list + the relevant set, so they unit-test cheaply and are
// shared by the vitest guard (test/golden-recall.test.ts) and the bench script
// (scripts/recall-bench.ts).

export interface QueryScore {
  pAt1: number;      // 1 if the top hit is relevant, else 0
  pAtK: number;      // report-only — never gate (structurally capped by single-relevant authoring; see success@k)
  rAtK: number;      // relevant hits in top-k / |relevant|
  rr: number;        // reciprocal rank of the first relevant hit (0 if none ranked)
  successAtK: number; // 1 if any relevant hit lands in top-k, else 0 (the honest top-line metric)
}

export interface AggregateScore {
  pAt1: number;       // macro-average over queries
  pAtK: number;       // report-only — never gate (structurally capped by single-relevant authoring; see success@k)
  rAtK: number;
  mrr: number;        // mean reciprocal rank
  successAtK: number; // fraction of queries with at least one relevant hit in top-k
  k: number;
  n: number;          // query count
}

/** Score one query's ranked result against its relevant set. `k` is the cutoff (and the
 *  P@k denominator). A relevant set of size 0 yields rAtK = 0 (no division by zero). */
export function scoreQuery(rankedSlugs: string[], relevant: Set<string>, k: number): QueryScore {
  const topK = rankedSlugs.slice(0, k);
  const hitsInK = topK.filter((s) => relevant.has(s)).length;
  // Reciprocal rank (rr) scans the full ranked list, unbounded by k — callers cap the list size via recall limit.
  const firstRelevantIdx = rankedSlugs.findIndex((s) => relevant.has(s));
  return {
    pAt1: rankedSlugs.length > 0 && relevant.has(rankedSlugs[0]) ? 1 : 0,
    pAtK: k > 0 ? hitsInK / k : 0,
    rAtK: relevant.size > 0 ? hitsInK / relevant.size : 0,
    rr: firstRelevantIdx >= 0 ? 1 / (firstRelevantIdx + 1) : 0,
    successAtK: hitsInK > 0 ? 1 : 0,
  };
}

/** Macro-average per-query scores into one aggregate; `mrr` is the mean of the `rr` values. */
export function aggregate(scores: QueryScore[], k: number): AggregateScore {
  const n = scores.length;
  const mean = (sel: (s: QueryScore) => number): number =>
    n > 0 ? scores.reduce((acc, s) => acc + sel(s), 0) / n : 0;
  return {
    pAt1: mean((s) => s.pAt1),
    pAtK: mean((s) => s.pAtK),
    rAtK: mean((s) => s.rAtK),
    mrr: mean((s) => s.rr),
    successAtK: mean((s) => s.successAtK),
    k,
    n,
  };
}

/** Per-field median across N aggregate runs (e16): absorbs rerankScore non-determinism so a
 *  committed baseline diff does not flap on jitter. k/n are taken from the first run (constant
 *  across runs over the same set). Throws on an empty run list. */
export function medianAggregate(runs: AggregateScore[]): AggregateScore {
  if (runs.length === 0) throw new Error("medianAggregate: no runs to aggregate");
  const median = (sel: (a: AggregateScore) => number): number => {
    const xs = runs.map(sel).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  };
  return {
    pAt1: median((a) => a.pAt1),
    pAtK: median((a) => a.pAtK),
    rAtK: median((a) => a.rAtK),
    mrr: median((a) => a.mrr),
    successAtK: median((a) => a.successAtK),
    k: runs[0]!.k,
    n: runs[0]!.n,
  };
}

/** Wilson score 95% interval for a binomial proportion (z=1.96). Correct at small n and near
 *  0/1 where the normal approximation breaks. Methodology §3.1: a bare proportion is not a
 *  permitted output — every reported proportion ships with this CI. n=0 → full [0,1]. */
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** erfc via Abramowitz & Stegun 7.1.26 (pure; ~1e-7 abs error) — for the McNemar p-value. */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - y * Math.exp(-x * x);
  return 1 - (x >= 0 ? erf : -erf);
}

/** McNemar test for a PAIRED lex-vs-hybrid comparison (methodology §3.2 — two separate CIs are
 *  wrong here). `b` = lex-hit/hybrid-miss, `c` = lex-miss/hybrid-hit (the discordant pairs);
 *  concordant pairs carry no information. Continuity-corrected χ² (1 df); `pApprox` is the
 *  two-sided p-value via the χ²₁ survival function (= erfc(√(statistic/2))). b+c=0 → statistic 0,
 *  p=1 (no evidence of a difference). */
export function mcnemar(pairs: { lex: boolean; hybrid: boolean }[]): {
  b: number; c: number; statistic: number; pApprox: number;
} {
  let b = 0, c = 0;
  for (const { lex, hybrid } of pairs) {
    if (lex && !hybrid) b++;
    else if (!lex && hybrid) c++;
  }
  const statistic = b + c === 0 ? 0 : Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  const pApprox = statistic <= 0 ? 1 : erfc(Math.sqrt(statistic / 2));
  return { b, c, statistic, pApprox };
}

// --- bench-wiring pure helpers (qp-bench-wiring-untested-helpers-4iu) -------
// scripts/recall-bench.ts loads the embed model, so its own logic can never run under
// `npm test`. These pure, model-free decision/stat functions ARE the bench's testable
// core — extracting them here is what brings the bench wiring under the suite (the
// adversarial-review root finding: the bench had zero automated coverage).

/** Exact binomial success count behind a proportion, or `null` when `p·n` is not (within
 *  1e-9 of) an integer — e.g. an even-run median that landed BETWEEN two integer counts
 *  (`(13/18 + 14/18)/2 = 13.5/18`). A Wilson CI is defined only for an integer k of n;
 *  pairing one with a between-counts median is the false precision methodology §3.7 forbids,
 *  so callers must SUPPRESS the CI (never fabricate a rounded one) when this returns null. */
export function successCount(p: number, n: number): number | null {
  const x = p * n;
  const k = Math.round(x);
  return Math.abs(x - k) < 1e-9 ? k : null;
}

/** The provenance fields a `--check` model-pin compares (the rest are reproducibility metadata). */
export interface BaselineProvenance {
  embedModel: string;
  qmdVersion: string;
}
export type ProvenanceAction = "ok" | "warn" | "fail";
export interface ProvenanceCheck {
  action: ProvenanceAction;
  message?: string;
}

/** Model-pin decision for `--check` (methodology §3.6). A committed baseline is comparable only
 *  when measured with the SAME embed model AND the same `@tobilu/qmd` version — qmd ships the
 *  reranker that keys hybrid scores, so a bump can swap the reranker. A swap of either
 *  recalibrates `DEFAULT_MIN_SCORE` and compares incompatible score distributions. No provenance
 *  → `warn` (a pre-MF-5 baseline; back-compat per spec §5.2); any mismatch → `fail` (caller exits
 *  1). Pure: the current model + qmd version arrive as args, so no I/O and no model load. */
export function checkProvenance(
  baseline: { provenance?: BaselineProvenance },
  currentEmbed: string,
  currentQmd: string,
): ProvenanceCheck {
  const p = baseline.provenance;
  if (!p) {
    return {
      action: "warn",
      message:
        "baseline predates provenance (written before MF-5). Skipping the embed/qmd model-pin check — re-run --update-baseline to capture provenance.",
    };
  }
  if (p.embedModel !== currentEmbed) {
    return {
      action: "fail",
      message:
        `embed-model mismatch: baseline recorded with "${p.embedModel}" but current model is "${currentEmbed}". ` +
        "A model swap recalibrates DEFAULT_MIN_SCORE and compares incompatible score distributions (methodology §3.6). " +
        "Re-run --update-baseline with the current model to refresh the baseline.",
    };
  }
  if (p.qmdVersion !== currentQmd) {
    return {
      action: "fail",
      message:
        `qmd-version mismatch: baseline recorded with @tobilu/qmd "${p.qmdVersion}" but current is "${currentQmd}". ` +
        "qmd ships the reranker that keys hybrid scores, so a version change can swap the reranker and recalibrate the floor (methodology §3.6). " +
        "Re-run --update-baseline on the current qmd to refresh the baseline.",
    };
  }
  return { action: "ok" };
}

/** Provenance fields that resolved to the non-reproducible `"unknown"` sentinel (gitSha and
 *  qmdVersion fall back to `"unknown"` when `git` or the package.json read fails). A baseline
 *  carrying any `"unknown"` cannot be reproduced or pin-checked later — `--update-baseline`
 *  warns on a non-empty result (G5). */
export function unknownProvenanceFields(provenance: Record<string, unknown>): string[] {
  return Object.entries(provenance).filter(([, v]) => v === "unknown").map(([k]) => k);
}

/** Mean / median / p95 of a numeric sample. Median averages the two middle values for even n.
 *  p95 is NEAREST-RANK (`ceil(0.95·n)−1`): for n≤19 that index is the last element, i.e. the
 *  MAX — a defensible small-sample upper estimate, NOT an interpolated percentile (the label
 *  reads "p95" but is effectively a max at this corpus size). Empty input → zeros (no NaN). */
export function payloadStats(vals: number[]): { mean: number; median: number; p95: number } {
  if (vals.length === 0) return { mean: 0, median: 0, p95: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
  return { mean, median, p95 };
}

/** The bench's MDE banner states ≈0.30 (absolute difference detectable at 80% power, α=.05),
 *  a figure HAND-DERIVED for n≈18 paired queries — it is not recomputed from n. This returns a
 *  drift warning when the live query count leaves a ±20% band around the calibrated n, so the
 *  banner cannot silently go stale as paraphrase queries are added (G6). A real recompute is
 *  tracked separately (qp-mrr-rk-bootstrap-ci-eqn). Returns null inside the band. */
export function mdeBannerDrift(n: number, calibratedN = 18): string | null {
  if (Math.abs(n - calibratedN) > 0.2 * calibratedN) {
    return `query count n=${n} has drifted from the n≈${calibratedN} the MDE≈0.30 figure was calibrated for — recompute the MDE before trusting it (qp-mrr-rk-bootstrap-ci-eqn).`;
  }
  return null;
}
