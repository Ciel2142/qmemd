import { describe, test, expectTypeOf } from "vitest";
import type { SearchResult, HybridQueryResult } from "@tobilu/qmd";

// qmemd-k9q: TYPE-level contract pin on the qmd SDK result shapes qmemd's recall consumes
// (runs under vitest typecheck — see vitest.config.ts). The runtime twin for the lex path
// lives in test/qmd-contract.test.ts; the hybrid path needs the embedding model, so its
// field shape is pinned here instead: engine.ts reads r.file (NOT .filepath), r.title,
// r.score and floors on r.explain?.rerankScore (rde). An SDK upgrade that renames or
// retypes any of these fails this typecheck cheaply.

describe("qmd SDK field-shape contract, type level (k9q)", () => {
  test("lex SearchResult keeps filepath/title/score", () => {
    expectTypeOf<SearchResult["filepath"]>().toEqualTypeOf<string>();
    expectTypeOf<SearchResult["title"]>().toEqualTypeOf<string>();
    expectTypeOf<SearchResult["score"]>().toEqualTypeOf<number>();
  });

  test("hybrid HybridQueryResult keeps file/title/score and explain.rerankScore", () => {
    expectTypeOf<HybridQueryResult["file"]>().toEqualTypeOf<string>();
    expectTypeOf<HybridQueryResult["title"]>().toEqualTypeOf<string>();
    expectTypeOf<HybridQueryResult["score"]>().toEqualTypeOf<number>();
    expectTypeOf<NonNullable<HybridQueryResult["explain"]>["rerankScore"]>().toEqualTypeOf<number>();
  });
});
