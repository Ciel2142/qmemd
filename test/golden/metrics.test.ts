import { describe, test, expect } from "vitest";
import { scoreQuery, aggregate, type QueryScore } from "./metrics.js";

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
    expect(s).toEqual({ pAt1: 0, pAtK: 0, rAtK: 0, rr: 0 });
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
    expect(agg).toEqual({ pAt1: 0, pAtK: 0, rAtK: 0, mrr: 0, k: 5, n: 0 });
  });
});
