# Recall calibration — hybrid-default basis + DEFAULT_MIN_SCORE curve

> Closes two calibration follow-ons unblocked by `qp-calibration-set-floor-guard-38c` (e16):
> `qp-hybrid-vs-lex-default-policy-w0i` (Part A) and `qp-recalibrate-default-min-score-7d8` (Part B).

## Goal

Replace two **anecdote-based** recall calibration decisions with **measured** ones, without a
behavior change unless a measurement demands it:

- **w0i** — confirm hybrid-by-default is the right recall default, backed by a fresh latency
  measurement, and document the basis at the `recallQuery` seam (the stale premise was "+580ms
  warm"; on the warm-daemon + GPU path it is ~26ms).
- **7d8** — back `DEFAULT_MIN_SCORE = 0.575` with a reproducible reranker-score **calibration
  curve** instead of the single observed fact (`0.581`), via a new `recall-bench --calibrate`
  emitter; rewrite the code comment with the measured basis.

## Decisions (settled in brainstorming, 2026-06-28)

1. **Ground truth = real latency + synthetic quality.** Latency/cost is measured on the live
   250-fact corpus (no relevance labels needed). The quality delta (w0i) and the floor curve
   (7d8) use the labeled synthetic golden set. True real-corpus relevance ground truth is e17
   (field telemetry, NEXT tranche, unbuilt) — explicitly out of scope here.
2. **w0i = measure + document, keep hybrid default.** No `recallQuery` logic change. The
   lex-first cascade is recorded as a documented future option, not built.
3. **7d8 = repeatable `--calibrate` emitter + value decision.** Expected outcome: keep `0.575`
   (raising toward ~0.63 drops real `0.581`-class facts; `0.575` admits ~0.7% noise). If the
   curve disagrees, surface it rather than silently moving the constant.
4. **Latency measured read-only against the live `$QMD_MEMORY_DIR`.** Recall never writes facts;
   vectors are already built on this box, so the measurement is warm. No throwaway corpus.
5. **`--calibrate` is print-only diagnostic.** No committed `calibration-curve.json`. The
   existing `--check` baseline (38c) already guards `distractorFloorPrecision`, i.e. the floor's
   downstream effect; the curve itself is for human decision, not a regression artifact.

## Non-goals

- No lex-first cascade implementation (w0i option B/C — deferred, documented).
- No real-corpus relevance labeling / e17 telemetry.
- No change to `recallQuery` search logic. Part A is doc-only; Part B touches only the
  `DEFAULT_MIN_SCORE` comment (and the constant **only if** the curve demands it).

## Global constraints

- **MF (model-free `npm test`):** `--calibrate` loads the embed/rerank model — it lives in
  `scripts/recall-bench.ts` and runs only under `npm run bench:recall`, never `npm test`.
  Mirrors `--check`/`--update-baseline`.
- **Workstation-only execution:** the calibrate run + the latency measurement need the cached
  embeddinggemma-300M + Qwen3-Reranker-0.6B (this RTX 5090 box). CI stays model-free.
- **Commit trailer:** end every commit body with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Part A — w0i: hybrid-default basis

### Measurement (one-shot, reproducible, read-only)

Time **lex vs hybrid** warm latency by replaying the ~18 golden query strings against the live
corpus (`$QMD_MEMORY_DIR`, ~250 facts) — timing is independent of whether those strings hit real
facts, so they serve as a fixed, reproducible query stream. Run in a single pre-warmed process so
the embed-model load is excluded from the per-query number; report the **median** per-query
latency for each mode. Record:

- lex warm (model-free) — expected ~0–1 ms
- hybrid warm (lex+vec+rerank) — expected ~tens of ms on this box
- cold hybrid (fresh process, first query) — the one-time embed-model load (~3.1 s), for context

The cold figure is a model-load artifact already hidden in normal use by the warm daemon
(qmemd-vuk). The decision rests on the **warm steady-state** number.

### Quality basis

Cite the committed `recall-baseline.json` hybrid−lex delta (+0.056 P@1 / +0.056 MRR on the
synthetic set), with the explicit caveat that the hand-authored set is lex-trivial and
understates hybrid's semantic value (judge dissent: a 34-fact delta < ~0.05 is noise; this sits
just above).

### Decision + deliverable

Keep **hybrid as the recall default** (`lexOnly` defaults `false`, `engine.ts:1649`). Rationale:
warm cost is negligible; the cold cost is a one-time load hidden by the daemon; the synthetic
quality delta is positive and the real semantic gap is understated. Extend the `recallQuery`
doc-comment block (`engine.ts:~1604–1626`) with: the measured warm/cold latency basis, the
quality-delta basis, and an explicit "lex-first cascade is a documented future option, deferred
because warm hybrid is cheap on the daemon path" note. **No code/logic change.** Numbers recorded
in this spec's results appendix on completion.

---

## Part B — 7d8: DEFAULT_MIN_SCORE calibration curve

### `recall-bench --calibrate` (new mode)

Model-loading; print-only. For the synthetic golden set:

- Run every **relevant** query (relevance + paraphrase) on the hybrid path with the floor
  **disabled** (`minScore: 0`) so every candidate's `rerankScore` is visible.
- Run every **distractor** query likewise.
- Bucket each returned hit's `rerankScore` into:
  - **RELEVANT** — hit slug ∈ that query's `relevant` set.
  - **NOISE** — distractor hits, plus non-relevant hits returned on relevant queries.
- Emit a compact ASCII histogram (score buckets, e.g. width 0.025) for each cluster, plus a
  summary line per cluster: `n`, min, median, max. Then a decision block:
  - the clean gap window between the noise ceiling and the relevant floor,
  - where the current `0.575` sits relative to that gap,
  - for candidate floors (e.g. `0.575`, `0.60`, `0.63`, `0.675`): `% noise admitted` and
    `relevant retained`.

This makes the curve regenerable after any reranker swap — the same motivation as 38c's
`--check`. It reads `DEFAULT_MIN_SCORE` only to annotate "current floor" on the output.

### Value decision + comment rewrite

From the emitted curve, confirm or revise the floor. Expected: **keep `0.575`**. Rewrite
`engine.ts:1629–1631` to replace the single-fact (`0.581`) anecdote with the measured basis:
the relevant-cluster floor, the noise-cluster ceiling, the gap, and the noise-admitted % at
`0.575`. If the curve indicates a different value, change `DEFAULT_MIN_SCORE` (`engine.ts:1638`)
**and** regenerate the committed `recall-baseline.json` via `bench:recall --update-baseline`
(the floor feeds `distractorFloorPrecision` and the hybrid scores). If unchanged, the baseline is
untouched.

### Model-free unit test

The bucketing + cluster-summary logic is pure given a list of `(slug, score, isRelevant)` rows.
Extract it as a small exported helper (in `test/golden/metrics.ts`, beside `medianAggregate`) and
unit-test it (model-free, in `npm test`): correct bucketing, median, and gap computation on a
hand-built fixture. The model-loading orchestration in `recall-bench.ts` stays out of `npm test`.

---

## Architecture / units

- `test/golden/metrics.ts` — **add** `calibrationCurve(rows: ScoreRow[]): CurveSummary` (pure):
  buckets + per-cluster (n/min/median/max) + clean-gap window + per-candidate-floor
  noise-admitted/relevant-retained. `ScoreRow = { score: number; relevant: boolean }`.
- `test/golden/metrics.test.ts` — **add** unit tests for `calibrationCurve` (model-free).
- `scripts/recall-bench.ts` — **add** `--calibrate` mode: collect `ScoreRow[]` from a
  floor-disabled hybrid run over relevant + distractor queries, call `calibrationCurve`, render.
- `src/engine.ts` — **modify** doc comments only (Part A: `~:1604–1626`; Part B: `:1629–1631`);
  `DEFAULT_MIN_SCORE` constant (`:1638`) changes **only if** the curve demands it.
- `docs/.../specs/.../recall-calibration...md` — this spec; append a results appendix on
  completion (the measured latency + curve summary), so the decision basis is durable.

## Acceptance

- **w0i:** fresh warm lex-vs-hybrid latency measured on the live corpus + recorded; `recallQuery`
  comment documents the measured basis + the kept hybrid default + the deferred-cascade note;
  no logic change. Issue closed with the numbers.
- **7d8:** `recall-bench --calibrate` emits the reranker curve (relevant vs noise clusters +
  candidate-floor table); the `DEFAULT_MIN_SCORE` comment cites the measured curve, not the
  n=1 anecdote; value kept (or changed with the baseline regenerated). `calibrationCurve` unit
  test green in `npm test`. Issue closed with the curve summary.
- **Global:** `npm test` stays model-free and green; `--calibrate` runs only under
  `npm run bench:recall`.

## Risks

- **Small sample:** 15 relevance + 3 paraphrase + 3 distractor queries over 34 facts → a coarse
  histogram. Accepted + documented; the curve informs, it does not over-claim. The honest output
  may be "the synthetic set cannot justify moving `0.575`," which is itself the measured answer.
- **rerankScore non-determinism:** the curve is one run; note that candidate-floor margins should
  exceed run-to-run jitter (the 0.07 band 38c established) before any value change.
- **Latency variance:** a single warm measurement; report the median over the ~18-query replay
  rather than one timing.
