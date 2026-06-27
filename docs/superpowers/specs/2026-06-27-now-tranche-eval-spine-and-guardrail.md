# Spec — NOW tranche: eval spine + identity guardrail (e15 + e16 + e10)

- **Date:** 2026-06-27
- **Scope:** the three NOW items from the mem0-borrow judge slate — `e15` temporal/knowledge-update eval track, `e16` `bench:recall --check` regression gate (folds into existing br issue), `e10` codify the `infer=True` non-port.
- **Source roadmap:** `docs/superpowers/research/2026-06-27-mem0-vs-qmemd-borrow-roadmap.md` (Part 4 build slate, lines 86–110).
- **Grounding:** 5-reader parallel seam map over the live tree (2026-06-27). Every file:line below was read, not assumed.
- **Status:** DRAFT — awaiting approval. No br issues filed yet (per workflow order: spec → approval → br issues).

> **Theme (judge presiding synthesis):** *build the instruments before the features.* e15/e16 are the eval spine; e10 is a free identity guardrail planted at the seam a later refactor (e11) will touch. None of the three changes recall ranking or the write path's behavior.

---

## 0. Invariants that constrain all three items

These are non-negotiable; a deliverable that erodes one is rejected.

- **MF (model-free `npm test`):** `vitest run` must never load the embed/rerank model. The existing relevance guard (`test/golden-recall.test.ts`) runs `lexOnly:true` with no `embedModel`. Anything that loads a model lives in a `bench:recall`-style script gated by `QMEMD_EMBED_TIMEOUT_MS=120000` (`package.json:48`), never in `npm test`.
- **I1 (no model on write):** `remember()` writes the fact verbatim (`engine.ts:1546 writeFileSync(path, serializeMemory(fm, input.fact))`) and only lex-reindexes (`engine.ts:1587`, comment: *"lex-index now; vec built lazily on first hybrid recall"*). The write path loads no model. e10 codifies this; e15/e16 must not break it.
- **I3 (engine never auto-resolves):** retirement hides, never deletes/merges; staleness surfaces, never mutates. The evals assert these as deterministic mechanics, not as relevance scores.
- **Two distinct floors — do not conflate:** `golden-set.json min_score = 0.5` is the **lex BM25** tripwire floor in the fixture. `DEFAULT_MIN_SCORE = 0.575` (`engine.ts:1633`) is the **hybrid rerank** floor. e16 guards the latter.
- **Fold-not-refile (e16):** e16 is the concrete mechanism for the already-open br issue `qp-calibration-set-floor-guard-38c`. It updates that issue; it does **not** create a parallel one (roadmap line 88).

---

## 1. e15 — temporal + knowledge-update eval track

### 1.1 Problem
The recall harness (`test/golden/`, added under `qmemd-3u8`) covers only **relevance** over a flat 34-fact / 15-query golden set. It has **zero** coverage of two deterministic knowledge-update mechanics that already ship in the engine:

- **Supersession-retirement** (`bri`): a `superseded_by`-bearing fact is filtered from every recall lane (`active = m => !m.frontmatter.supersededBy`, `engine.ts:521`; gate `engine.ts:1946`) yet stays on disk byte-preserved.
- **Staleness** (`qmemd-9su`): `staleFacts()` (`engine.ts:2162-2212`) partitions decay-prone facts into `due` / `unreviewed`, while recall ignores `review_by` entirely — nothing auto-expires.

Both are unit-tested in `test/engine.test.ts`, but there is **no end-to-end behavioral eval** that holds one real store and asserts the cross-cutting invariants over the actual recall surface. That gap is what e15 closes.

### 1.2 What e15 IS (and is not)
- **IS:** a model-free behavioral eval that seeds a real store via the existing `seed.ts` helpers, then asserts **boolean deterministic mechanics** (vanished / surfaced / unchanged) — not P@1/MRR relevance.
- **IS NOT:** a relevance-tuning exercise. The judge panel was explicit (roadmap line 105): on a 34-fact hand-authored set any relevance delta `< ~0.05` is noise; e15 survives review *only* because it asserts mechanics, not subjective relevance. Run it expecting it to be the obituary for speculative ranking features, not a relevance benchmark.
- **IS NOT:** a re-proof of the existing units in `engine.test.ts`. Its value is the end-to-end assertion over a seeded store in one fixture state.

### 1.3 Design
Two new **model-free** partitions, reusing `test/golden/seed.ts` (`seedGoldenStore` loop, `engine.ts` `remember`/`staleFacts`) and `test/golden/metrics.ts` where useful. Keep them out of `golden-set.json`'s relevance corpus so `seed.test.ts`'s count assertions (`>=30 facts, >=12 queries, lex anchors`) stay green; carry them as their own fixtures + test files (exact file layout is a plan-level call — the spec fixes the assertions, not the filenames).

**Partition A — supersession-retirement.** Seed fact `A`; `remember(B, {supersedes: A.slug})`; then assert, in one fixture state:
1. `A` is **absent** from `recallQuery` hits **and** from `moreMatches` / `belowFloor` counters (gate `engine.ts:1946`, counter `engine.ts:2001`).
2. `A` is **absent** from `recallSession` — even when `A` is `pinned` (retirement beats pin, `engine.ts:553`).
3. `A` is **absent** from `staleFacts` `due` and `unreviewed` (`engine.ts:2175`, *"retired, not stale"*).
4. `A`'s file body is **byte-identical** to pre-retirement and its `updated` is **unchanged** (surgical reverse-stamp, `engine.ts:1548-1573`).
5. The retire op produced **one** commit carrying **both** pathspecs.
6. **Negative invariant:** a `conflicts_with`-stamped fact (force-past-a-contradiction path, `engine.ts:1493-1514`) stays **fully recallable** — only `supersededBy` hides a fact. (Guards the most likely silent regression: a future edit accidentally filtering `conflictsWith` in `gate()`.)
7. **Fail-open boundary:** an unreadable retired file is treated as `supersededBy`-absent ⇒ **shown** (`engine.ts:1926-1928`). Match this; do not assert hiding for corrupt inputs.

**Partition B — staleness.** Seed facts with fixed `created`/`updated`/`review_by` via `serializeMemory`; drive `staleFacts(root, {today, limit})` with an injected `today` (`engine.ts:2163`). Assert:
1. A fact past its window appears in `due`; recall in the **same** fixture state **still returns it** (recall ignores `review_by` — gate has no `review_by` branch, `engine.ts:1940-1952`).
2. `review_by: never` (`DURABLE_SENTINEL`, `engine.ts:106`) is exempt before any date logic (`engine.ts:2176`).
3. Per-type windows hold: `project` 90d, `reference` 180d, `user`/`feedback` durable/null (`TTL_DEFAULTS`, `engine.ts:137-139`); `QMEMD_TTL_<TYPE>` override shifts the boundary (delete the env var in `afterEach`).
4. Boundary cases: `review_by == today` is **due** (`engine.ts:2185`); a future date is in **neither** lane; an undatable anchor is **due** with `dueDate = today` (`engine.ts:2199`); a malformed `review_by` **fails open** to the type window (`engine.ts:2188-2190`).
5. `qmemd reviewed <slug>` forward-sets `review_by` and leaves `updated` **unchanged** (`engine.ts:2245-2246`).
6. **No-mutation invariant:** `staleFacts()` does not alter the corpus (read-only walk; assert corpus bytes unchanged before/after — currently unguarded).

### 1.4 Acceptance criteria (e15)
- New eval files run under `npm test`, **load no model**, and pass.
- All Partition-A and Partition-B assertions above are present and green.
- `seed.test.ts` count assertions still pass (relevance golden set untouched).
- The negative `conflicts_with`-stays-recallable assertion and the `staleFacts` no-mutation assertion both exist (these are the new-coverage deltas, not duplicated units).
- No change to `src/` runtime behavior (eval is additive test code only).

### 1.5 Gate
**None.** Roadmap line 110: *"e15 is test infra → no plan-approval gate needed and is the unanimous pick."* This spec documents it; implementation can proceed on approval of the tranche.

---

## 2. e16 — `bench:recall --check` regression gate + committed baseline

### 2.1 Problem
`scripts/recall-bench.ts` is **print-only**: it parses no argv, makes no assertion, and always exits 0. There is **no committed baseline** and **no regression gate**. The hybrid rerank floor `DEFAULT_MIN_SCORE = 0.575` (`engine.ts:1633`) is exercised by no committed eval over the real reranker — a Qwen3-Reranker swap would silently recalibrate it with nothing failing. The open br issue `qp-calibration-set-floor-guard-38c` names this gap; e16 supplies the concrete mechanism.

### 2.2 Relationship to br issue 38c (fold, don't re-file)
`qp-calibration-set-floor-guard-38c` (P1, OPEN, blocks `qp-recalibrate-default-min-score-7d8` + `qp-hybrid-vs-lex-default-policy-w0i`) lists three tasks:
- **(a)** paraphrase/synonym queries that force the vector/rerank path;
- **(b)** distractor/negative queries that must return nothing above the floor;
- **(c)** a hybrid floor regression test on an N-run median/tolerance band reusing the `belowFloor` counter, kept out of `npm test`.

e16 reconciles 38c's "in-test guard" framing into the **`--check` + committed-baseline-file + exit-code** mechanism. The acceptance ("harness emits a floor precision/recall curve; a CI guard trips on a reranker-distribution regression without flapping on jitter") is satisfied by e16's deliverables below.

### 2.3 Design
Extend `scripts/recall-bench.ts` (model-loading, runs under `bench:recall`, **never** `npm test`):

1. **Argv parsing** — add `--check`, `--update-baseline`, and an optional `--runs N` (default the anti-flap count).
2. **Committed baseline artifact** — a JSON under `test/golden/` (e.g. `recall-baseline.json`) holding the `AggregateScore` shape (`metrics.ts`: `n/pAt1/pAtK/rAtK/mrr`) for lex and hybrid, plus the floor-precision summary. Created via `--update-baseline`; this is the legitimate regen path after an intentional reranker change.
3. **N-run median for jitter** — each query run `N` times; aggregate on the **median** to absorb `rerankScore` non-determinism. Default mode (no flag) stays print-only and back-compatible.
4. **`--check` diff + exit code** — compare current median aggregate to the committed baseline within a **tolerance band**; exit non-zero on regression beyond the band. Tolerance must exceed the `~0.05` hand-authored-set noise floor (roadmap line 105) so CI does not flap.
5. **Distractor / below-floor metric (task b)** — add distractor/negative queries to the fixture and consume the `belowFloor` counter (`engine.ts:2001`) so the bench asserts "distractors return nothing above `DEFAULT_MIN_SCORE`." (The bench ignores `belowFloor` today.)
6. **Paraphrase queries (task a)** — add synonym/paraphrase queries that share no exact tokens with their target, forcing the vector+rerank path (today every golden query lexically overlaps its target).
7. **Floor precision/recall summary (acceptance)** — emit the floor precision/recall figures `--check` compares; a full threshold-sweep curve is optional, the committed point-summary is the gate.

`package.json:48` `bench:recall` must pass argv through so CI can call `bench:recall --check`.

### 2.4 Acceptance criteria (e16)
- `bench:recall` with no flag is unchanged (print-only, exit 0).
- `bench:recall --update-baseline` writes the committed baseline JSON.
- `bench:recall --check` reads the baseline, runs N-run median, and exits non-zero on a regression beyond tolerance; tolerance band `> 0.05`.
- Fixture gains paraphrase queries (force vector path) and distractor/negative queries (must stay below `DEFAULT_MIN_SCORE`); the bench reports `belowFloor`-derived floor precision.
- Nothing model-loading enters `npm test` (MF invariant).
- br issue `qp-calibration-set-floor-guard-38c` is updated with these as its acceptance; tasks (a)/(b)/(c) map onto deliverables 6/5/1-4. **No new top-level issue.**

### 2.5 Open reconciliation (flag for approval)
38c task (c) literally says "reusing belowFloor counter, kept out of npm test" and implies a hardcoded in-test constant à la `LEX_*_FLOOR`. e16 replaces that with a committed-baseline diff. **Decision needed:** baseline-file `--check` is the canonical deliverable (recommended — survives reranker recalibration via `--update-baseline`); the hardcoded constant is dropped, not added alongside. Confirm at approval.

---

## 3. e10 — codify the `infer=True` non-port

### 3.1 Problem
mem0's `add(infer=True)` mines facts from chat with an LLM on write. Porting that into qmemd's engine would break **I1** (no model on write) and **I5** (no API key). The roadmap codifies the deliberate *non*-port as a guardrail — **zero runtime change** — and plants it at the dedup/classify seam so a later `classifyCandidate` extraction (e11) inherits it rather than a lone doc bullet drifting out of sight.

### 3.2 Findings that shape the placement
- **No `classifyCandidate` entry point exists today.** The three-tier walk is **inlined** in `remember()` across `engine.ts:1321-1596`: Tier-1 slug (`1400-1423`), Tier-2 FTS BM25 (`1425-1453`), Tier-2.5 model-free near-dup + contradiction (`1455-1491`), backed by `nearDuplicate` (`1117`), `classifyNearMatch` (`1206`), `lowSimilarityConflict` (`1258`). e11 will extract these into a shared `classifyCandidate()`.
- **The seam** where the walk begins is the `// Dedup check …` block guard at **`engine.ts:1396-1399`** (`if (!input.replace && !input.force && !input.supersedes) {`). A comment anchored here is exactly what an e11 refactor would carry along.
- **Voice to match** (existing terse, em-dash, invariant-citing comments): `engine.ts:510` *"Filesystem-only session snapshot. No Store, no model — instant and deterministic."*; `engine.ts:1805-1806` *"writes are lex-only …"*.
- **CLAUDE.md home:** `## Conventions & Patterns` (line 80). Insert one bullet **after the "Dedup is three-tier" bullet (line 84)**, before "Staleness is surface-only". No existing mention of "infer", "mem0", "non-port", or "verbatim".

### 3.3 Design (two edits, zero runtime change)
1. **Engine comment** at the dedup seam (`engine.ts:~1396-1399`), matching house voice, codifying:
   > The write path loads **no model** (I1) and needs **no API key** (I5). qmemd never mines/distills facts from a transcript on write the way mem0's `add(infer=True)` does — the fact text is stored **verbatim**; distillation is the agent's job, never the engine's. A future shared `classifyCandidate()` (e11) inherits this seam: keep it model-free.
2. **CLAUDE.md bullet** under Conventions & Patterns (after line 84):
   > **Non-port — no engine-side `infer`:** the write path is deterministic and model-free (I1) and needs no API key (I5). Unlike mem0's `add(infer=True)`, qmemd never LLM-distills facts on write — text is stored verbatim; the agent distills, the engine classifies (model-free dedup only).

### 3.4 Acceptance criteria (e10)
- The engine comment exists at the dedup seam and the CLAUDE.md bullet exists under Conventions & Patterns.
- **Zero** runtime/behavior change; `npm test` and `npm run build` unaffected.
- Wording cites I1 + I5 and the verbatim-write contract, in the existing comment voice.

---

## 4. Sequencing & dependencies

```
e15 (eval track)          ── independent; build first (gate-free, unanimous #1)
e10 (non-port guardrail)  ── independent; trivial; plant at dedup seam now (before any e11 refactor)
e16 (--check + baseline)  ── extends the same harness; FOLD into qp-calibration-set-floor-guard-38c
```

- e15 and e10 touch disjoint code (test files vs. one comment + one doc bullet) — parallelizable.
- e16 shares `test/golden/` + `scripts/recall-bench.ts` with e15's infra; land e15 first so the partition/seed conventions are settled, then e16's baseline/`--check` builds on a stable harness.
- e10's comment should land **before** any e11 `classifyCandidate` extraction so the refactor carries it.

---

## 5. Risks & preserved dissent (carried, not flattened)

- **Floor-delta noise (eval-first judge):** on a 34-fact/15-query hand-authored set, any relevance delta `< ~0.05` is noise. → e15 asserts **mechanics only**; e16's tolerance band is set **above** 0.05.
- **e15 as obituary, not blessing (skeptic + architect):** e15 is expected to show the entity-spine (e1/e3/e4) earns nothing on this corpus. e15 deliberately measures deterministic mechanics so it cannot be mis-read as endorsing speculative ranking work.
- **Golden sets are themselves unmeasured assumptions (eval-first):** real ground truth is e17 field telemetry (NEXT tranche). e15/e16 are honest only insofar as they assert mechanics + regression-detection, not "good relevance."
- **e2/e5 deferred:** the cheap agent surfaces are **out of this tranche** by the user's scope decision; revisit behind e17 telemetry.

---

## 6. br issues to file *after approval* (not yet filed)

1. **e15** — new br issue: *"temporal + knowledge-update eval track (supersession-retirement + staleness partitions)"*, label `testing`/`recall`/`eval`. Gate-free per roadmap.
2. **e16** — **update** existing `qp-calibration-set-floor-guard-38c`: append the `--check` + committed-baseline + N-run-median + distractor/paraphrase acceptance (deliverables §2.3). Do **not** create a new issue.
3. **e10** — small br issue or a task under the capture/identity cluster: *"codify infer=True non-port at dedup seam + CLAUDE.md"*. Trivial; zero runtime.

---

## 7. Open questions for approval

1. **e16 reconciliation (§2.5):** confirm baseline-file `--check` replaces 38c's implied hardcoded in-test floor constant (recommended), rather than shipping both.
2. **e15 file layout:** standalone `test/golden/retirement.test.ts` + `test/golden/staleness.test.ts` reusing `seed.ts`, vs. a `partition` field added to `GoldenSet`. Spec fixes the assertions; pick the layout at plan time. Preference?
3. **Tranche order:** land e15 + e10 in parallel first, then e16 — agreed?
