// Pure IR metrics for the recall-quality harness (qmemd-3u8). No I/O, no model — pure
// functions of a ranked slug list + the relevant set, so they unit-test cheaply and are
// shared by the vitest guard (test/golden-recall.test.ts) and the bench script
// (scripts/recall-bench.ts).

export interface QueryScore {
  pAt1: number; // 1 if the top hit is relevant, else 0
  pAtK: number; // relevant hits in top-k / k
  rAtK: number; // relevant hits in top-k / |relevant|
  rr: number;   // reciprocal rank of the first relevant hit (0 if none ranked)
}

export interface AggregateScore {
  pAt1: number; // macro-average over queries
  pAtK: number;
  rAtK: number;
  mrr: number;  // mean reciprocal rank
  k: number;
  n: number;    // query count
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
