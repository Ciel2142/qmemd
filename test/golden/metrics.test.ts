import { describe, test, expect } from "vitest";
import {
  scoreQuery, aggregate, medianAggregate, wilson, mcnemar,
  successCount, checkProvenance, unknownProvenanceFields, payloadStats, mdeBannerDrift,
  bootstrapMeanCI,
  type QueryScore,
} from "./metrics.js";

describe("scoreQuery", () => {
  const rel = new Set(["a", "b"]);

  test("top hit relevant → pAt1 = 1, rr = 1", () => {
    const s = scoreQuery(["a", "x", "y"], rel, 5);
    expect(s.pAt1).toBe(1);
    expect(s.rr).toBe(1);
  });

  test("first relevant at rank 3 → pAt1 = 0, rr = 1/3", () => {
    const s = scoreQuery(["x", "y", "a"], rel, 5);
    expect(s.pAt1).toBe(0);
    expect(s.rr).toBeCloseTo(1 / 3, 10);
  });

  test("no relevant hit → all zero", () => {
    const s = scoreQuery(["x", "y", "z"], rel, 5);
    expect(s).toEqual({ pAt1: 0, pAtK: 0, rAtK: 0, rr: 0, successAtK: 0 });
  });

  test("pAtK uses k in the denominator; rAtK uses |relevant|", () => {
    const s = scoreQuery(["a", "b", "x", "y", "z"], rel, 5);
    expect(s.pAtK).toBeCloseTo(2 / 5, 10);
    expect(s.rAtK).toBe(1);
  });

  test("k larger than the ranked list still divides by k", () => {
    const s = scoreQuery(["a"], rel, 5);
    expect(s.pAtK).toBeCloseTo(1 / 5, 10);
    expect(s.rAtK).toBeCloseTo(1 / 2, 10);
  });

  test("empty relevant set → rAtK = 0, no NaN", () => {
    const s = scoreQuery(["a", "b"], new Set<string>(), 5);
    expect(s.rAtK).toBe(0);
    expect(s.pAt1).toBe(0);
  });
});

describe("aggregate", () => {
  test("macro-averages each metric and means rr into mrr", () => {
    const a: QueryScore = scoreQuery(["a"], new Set(["a"]), 5);
    const b: QueryScore = scoreQuery(["x", "b"], new Set(["b"]), 5);
    const agg = aggregate([a, b], 5);
    expect(agg.n).toBe(2);
    expect(agg.pAt1).toBeCloseTo(0.5, 10);
    expect(agg.mrr).toBeCloseTo((1 + 0.5) / 2, 10);
  });

  test("no queries → zeros, no NaN", () => {
    const agg = aggregate([], 5);
    expect(agg).toEqual({ pAt1: 0, pAtK: 0, rAtK: 0, mrr: 0, successAtK: 0, k: 5, n: 0 });
  });
});

describe("medianAggregate", () => {
  test("takes the per-field median across runs", () => {
    const mk = (p: number, m: number) => ({ pAt1: p, pAtK: p, rAtK: p, mrr: m, successAtK: p, k: 5, n: 10 });
    const out = medianAggregate([mk(0.6, 0.7), mk(0.8, 0.9), mk(0.7, 0.8)]);
    expect(out.pAt1).toBe(0.7); // median of 0.6,0.8,0.7
    expect(out.mrr).toBe(0.8);  // median of 0.7,0.9,0.8
    expect(out.k).toBe(5);
    expect(out.n).toBe(10);
  });

  test("averages the two middle values for an even run count", () => {
    const mk = (p: number) => ({ pAt1: p, pAtK: p, rAtK: p, mrr: p, successAtK: p, k: 5, n: 10 });
    expect(medianAggregate([mk(0.4), mk(0.6)]).pAt1).toBeCloseTo(0.5, 10);
  });

  test("successAtK median is computed from successAtK, not pAt1", () => {
    // successAtK values (0.4, 0.8, 0.6) differ from pAt1 values (0.3, 0.7, 0.5) so a
    // wrong-field bug (e.g. median((a) => a.pAt1) instead of a.successAtK) causes the
    // assertion to fail: pAt1 median would be 0.5, not 0.6.
    const runs = [
      { pAt1: 0.3, pAtK: 0.3, rAtK: 0.3, mrr: 0.3, successAtK: 0.4, k: 5, n: 10 },
      { pAt1: 0.7, pAtK: 0.7, rAtK: 0.7, mrr: 0.7, successAtK: 0.8, k: 5, n: 10 },
      { pAt1: 0.5, pAtK: 0.5, rAtK: 0.5, mrr: 0.5, successAtK: 0.6, k: 5, n: 10 },
    ];
    const out = medianAggregate(runs);
    expect(out.successAtK).toBeCloseTo(0.6, 6); // sorted: 0.4,0.6,0.8 → median 0.6
    expect(out.pAt1).toBeCloseTo(0.5, 6);       // sorted: 0.3,0.5,0.7 → median 0.5; must differ
  });

  test("throws on zero runs", () => {
    expect(() => medianAggregate([])).toThrow();
  });
});

describe("wilson 95% score interval", () => {
  test("symmetric about 0.5 at p=0.5", () => {
    const { lo, hi } = wilson(9, 18);
    expect((lo + hi) / 2).toBeCloseTo(0.5, 6);
    expect(lo).toBeGreaterThan(0); expect(hi).toBeLessThan(1);
  });
  test("clamps at the boundaries", () => {
    expect(wilson(18, 18).hi).toBe(1);          // all-success upper bound clamps to 1
    expect(wilson(18, 18).lo).toBeLessThan(1);  // but lower bound is < 1 (Wilson, not 1.0)
    expect(wilson(0, 18).lo).toBe(0);
  });
  test("n=0 yields the full [0,1] interval (no NaN)", () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
  test("known value: 14/18 ≈ 0.778, CI width ~±0.19", () => {
    const { lo, hi } = wilson(14, 18);
    expect(lo).toBeCloseTo(0.549, 2); expect(hi).toBeCloseTo(0.906, 2);
  });
});

describe("successAtK", () => {
  test("successAtK is 1 when any relevant hit lands in top-k (vs the structurally-capped pAtK)", () => {
    const s = scoreQuery(["x", "target", "y"], new Set(["target"]), 5);
    expect(s.successAtK).toBe(1);
    expect(s.pAtK).toBeCloseTo(1 / 5, 6); // pAtK is capped by single-relevant authoring — report-only
  });
  test("successAtK aggregates and medians", () => {
    const a = aggregate([scoreQuery(["target"], new Set(["target"]), 5), scoreQuery(["z"], new Set(["target"]), 5)], 5);
    expect(a.successAtK).toBeCloseTo(0.5, 6);
  });
});

describe("mcnemar paired test", () => {
  test("all concordant → b=c=0, statistic 0, p≈1", () => {
    const r = mcnemar([{ lex: true, hybrid: true }, { lex: false, hybrid: false }]);
    expect(r.b).toBe(0); expect(r.c).toBe(0); expect(r.statistic).toBe(0);
    expect(r.pApprox).toBeCloseTo(1, 6);
  });
  test("net one discordant query is not significant", () => {
    // 17 concordant + 1 (lex miss, hybrid hit) — the real lex-vs-hybrid shape
    const pairs = [{ lex: false, hybrid: true }, ...Array(17).fill({ lex: true, hybrid: true })];
    const r = mcnemar(pairs);
    expect(r.b).toBe(0); expect(r.c).toBe(1);   // c = lex-miss/hybrid-hit
    expect(r.pApprox).toBeGreaterThan(0.3);      // non-significant (continuity-corrected ≈ 1.0)
  });
});

// --- bench-wiring pure helpers (qp-bench-wiring-untested-helpers-4iu) -------

describe("successCount — CI guard (G2)", () => {
  test("integer proportion → its exact success count", () => {
    expect(successCount(14 / 18, 18)).toBe(14);
    expect(successCount(0, 18)).toBe(0);
    expect(successCount(1, 18)).toBe(18);
  });
  test("an integer count carrying genuine sub-1e-9 fp residue still resolves (the tolerance branch)", () => {
    // (13/23)*23 === 12.999999999999998 (residue −1.78e-15) — round → 13 only BECAUSE of the
    // Math.abs(x−k) < 1e-9 tolerance; strict `=== 0` / Number.isInteger would return null and
    // wrongly SUPPRESS a Wilson CI that spec §3.1 mandates. This pins that branch distinct from
    // the exact-integer case above and the even-run null case below.
    expect(successCount(13 / 23, 23)).toBe(13);
  });
  test("even-run median BETWEEN two counts → null (no fabricated CI)", () => {
    // (13/18 + 14/18)/2 = 13.5/18 — 13.5 is not an integer count, so no Wilson CI is defined
    expect(successCount((13 / 18 + 14 / 18) / 2, 18)).toBeNull();
  });
});

describe("checkProvenance — model-pin decision (G1/G4)", () => {
  const E = "embed-A", Q = "2.5.3";
  test("no provenance → warn (pre-MF-5 baseline, back-compat per spec §5.2)", () => {
    expect(checkProvenance({}, E, Q).action).toBe("warn");
  });
  test("matching embed + qmd → ok", () => {
    expect(checkProvenance({ provenance: { embedModel: E, qmdVersion: Q } }, E, Q).action).toBe("ok");
  });
  test("embed-model mismatch → fail (exit 1)", () => {
    const r = checkProvenance({ provenance: { embedModel: "embed-B", qmdVersion: Q } }, E, Q);
    expect(r.action).toBe("fail");
    expect(r.message).toMatch(/embed-model mismatch/);
  });
  test("qmd-version mismatch → fail — the reranker-swap branch G4 added", () => {
    const r = checkProvenance({ provenance: { embedModel: E, qmdVersion: "2.5.2" } }, E, Q);
    expect(r.action).toBe("fail");
    expect(r.message).toMatch(/qmd-version mismatch/);
  });
  test("embed mismatch takes precedence over a simultaneous qmd mismatch", () => {
    const r = checkProvenance({ provenance: { embedModel: "x", qmdVersion: "y" } }, E, Q);
    expect(r.message).toMatch(/embed-model/);
  });
});

describe("unknownProvenanceFields (G5)", () => {
  test("flags every field equal to the 'unknown' sentinel", () => {
    expect(unknownProvenanceFields({ gitSha: "unknown", qmdVersion: "unknown", runs: 5 }))
      .toEqual(["gitSha", "qmdVersion"]);
  });
  test("clean provenance → empty list", () => {
    expect(unknownProvenanceFields({ gitSha: "abc1234", qmdVersion: "2.5.3", runs: 5 })).toEqual([]);
  });
});

describe("payloadStats — extracted from the bench", () => {
  test("odd n → middle median, mean", () => {
    const s = payloadStats([30, 10, 20]);
    expect(s.median).toBe(20);
    expect(s.mean).toBeCloseTo(20, 10);
  });
  test("even n → average of the two middle values", () => {
    expect(payloadStats([10, 20, 30, 40]).median).toBe(25);
  });
  test("p95 is nearest-rank (== MAX for small n≤20)", () => {
    expect(payloadStats([1, 2, 3, 4, 5]).p95).toBe(5);
  });
  test("empty → zeros, no NaN", () => {
    expect(payloadStats([])).toEqual({ mean: 0, median: 0, p95: 0 });
  });
});

describe("mdeBannerDrift (G6)", () => {
  test("n at the calibrated point → no drift", () => {
    expect(mdeBannerDrift(18)).toBeNull();
  });
  test("n inside the ±20% band → no drift", () => {
    expect(mdeBannerDrift(20)).toBeNull();
    expect(mdeBannerDrift(15)).toBeNull();
  });
  test("n well outside the band → drift warning", () => {
    expect(mdeBannerDrift(30)).toMatch(/drifted/);
  });
});

describe("bootstrapMeanCI — dispersion CI for non-binomial means (qp-mrr-rk-bootstrap-ci-eqn)", () => {
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

  test("deterministic given a seed (reproducible run-to-run)", () => {
    const xs = [1, 0.5, 0.333, 1, 0, 1, 0.25, 1];
    expect(bootstrapMeanCI(xs, { seed: 7 })).toEqual(bootstrapMeanCI(xs, { seed: 7 }));
  });

  test("zero-variance sample → degenerate point interval (no spurious width)", () => {
    expect(bootstrapMeanCI([0.5, 0.5, 0.5, 0.5], { seed: 1 })).toEqual({ lo: 0.5, hi: 0.5 });
  });

  test("interval brackets the mean and sits STRICTLY inside the raw [min,max] (real resampling, not a range stub)", () => {
    const xs = [1, 1, 1, 0.5, 0.333, 0, 1, 0.2, 1, 1];
    const { lo, hi } = bootstrapMeanCI(xs, { seed: 42 });
    expect(lo).toBeLessThanOrEqual(mean(xs));
    expect(hi).toBeGreaterThanOrEqual(mean(xs));
    // STRICT interior: averaging shrinks variance, so a mean-bootstrap CI is narrower than the raw
    // value range — this is what distinguishes it from a degenerate {min,max} stub (real impl at
    // seed 42 → lo≈0.453, hi≈0.920). Not asserted on the skewed sample below, where hi==max is legit.
    expect(lo).toBeGreaterThan(Math.min(...xs));
    expect(hi).toBeLessThan(Math.max(...xs));
  });

  test("skewed mostly-1 sample → hi pinned near the max (1), lo strictly below it", () => {
    const xs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0]; // one miss among nine perfect ranks
    const { lo, hi } = bootstrapMeanCI(xs, { seed: 3 });
    expect(hi).toBe(1);
    expect(lo).toBeLessThan(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  test("higher-variance sample → wider interval than a tight one (non-vacuous dispersion)", () => {
    const wide = bootstrapMeanCI([0, 0, 1, 1, 0, 1, 0, 1], { seed: 9 });
    const tight = bootstrapMeanCI([0.45, 0.5, 0.5, 0.55, 0.5, 0.5, 0.45, 0.55], { seed: 9 });
    expect(wide.hi - wide.lo).toBeGreaterThan(tight.hi - tight.lo);
  });

  test("edge: empty → {0,0}; single value → {v,v}", () => {
    expect(bootstrapMeanCI([], { seed: 1 })).toEqual({ lo: 0, hi: 0 });
    expect(bootstrapMeanCI([0.7], { seed: 1 })).toEqual({ lo: 0.7, hi: 0.7 });
  });
});
