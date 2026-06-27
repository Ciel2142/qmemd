# mem0 vs qmemd — grounded comparison + borrow roadmap + judge verdict

- **Date:** 2026-06-27
- **Method:** three sequential multi-agent workflows, all claims grounded (qmemd = source file:line; mem0 = fetched URLs; "don't let researchers assume" directive enforced — unverifiable items flagged, not asserted).
  1. `mem0-vs-qmemd` (29 agents, ~1.2M tok): 4 read qmemd source + 4 web-researched mem0 → synth → **20/20 atomic claims adversarially re-verified (0 refuted)**.
  2. `mem0-into-qmemd` (25 agents, ~985k tok): 5 lenses ideate borrowable features → consolidate (18 canonical) → adversarial invariant-gate each → roadmap.
  3. `qmemd-roadmap-judges` (6 agents, ~267k tok): 5 divergent reviewer-judges score independently (spot-checked source) → presiding synthesis.
- **Sibling doc:** `2026-06-27-llm-memory-prior-art.md` (the W1–W5 weak-spot prior-art study).

---

## Part 1 — What each system IS (verified)

| Axis | **qmemd** | **mem0** |
|---|---|---|
| Source of truth | one markdown file per fact `<root>/<type>/<slug>.md` + YAML frontmatter; SQLite index = disposable derived cache | `MemoryItem` records in pluggable **vector store** (default local Qdrant) + SQLite history DB |
| A "memory" | explicit agent/human fact, **written verbatim** (name=slug, description=first line); no model on write | **LLM-distilled** fact mined from dialogue (`add(infer=True)` → default gpt-5-mini) |
| Write cost | zero API; local CPU/GPU | ≥1 LLM call per write (default OpenAI) |
| Dedup/conflict | **mechanical 3-tier** (exact-slug; BM25>1e-6; token-set Dice≥0.82/overlap≥0.90 + digit-identifier guard); conflict BLOCKS+surfaces, **never auto-merge** | paper: LLM ADD/UPDATE/DELETE/NOOP. **shipped code: additive, hash-dedup, nothing overwritten** |
| Retrieval | local hybrid lex+vec+rerank (embeddinggemma-300M + Qwen3-Reranker-0.6B GGUF), **no API**; auto→lex on CPU box; floor on rerankScore (0.575) | semantic+BM25+entity fused 0..1; default embed = OpenAI API; optional managed reranker |
| Scoping | `{project, global}`, single-user | multi-tenant `user_id`/`run_id`(auto-expire)/`agent_id` |
| Graph | none (only supersedes/conflicts_with links) | built-in entity graph (v3, no external dep) |
| Deps | **3 npm pkgs**, no DB service, no API key, Node≥22 ESM | LLM key + embedder + vector store; 20 vector backends |
| Ops | local-first, **git** = sync/backup | OSS lib → self-host server → managed cloud ($0→$249/mo→ent) |
| Maturity | v0.5.1, single maintainer, narrow by design | **~59.6k★, 347 releases, YC S24, ~3M dl/mo**, Apache-2.0 |

### Two findings that matter most (non-obvious, verified)
1. **mem0's shipped code ≠ its own paper.** arXiv 2504.19413 sells per-fact LLM consolidation (ADD/UPDATE/DELETE/NOOP). Current `main` `add()` is a **"V3 additive" path: one LLM call, ADD-only, MD5-hash dedup, "memories accumulate; nothing overwritten."** So the current default has *less* contradiction-resolution than marketed. (sources: `mem0/memory/main.py`, README, `prompts.py`.)
2. **mem0's headline numbers are vendor-stated and disputed.** "26% over OpenAI / 91% lower p95 latency / >90% token savings" all originate from the mem0 team's paper. **Zep reproduced LOCOMO and disputes the methodology** (Zep's corrected run 75.14% vs the 65.99% mem0 attributed to it; mem0's own paper Table shows a full-context baseline ~73% J beating mem0's ~68%). No neutral third party confirmed mem0's numbers.

**One-line:** different species. qmemd = deterministic single-user file-first memory, zero external deps. mem0 = mature multi-tenant vector-store-first layer that mines facts from chat via an LLM.

---

## Part 2 — qmemd's 7 identity invariants (the gate criteria)

A borrow that erodes one is a non-starter unless made strictly opt-in / off the default path.

- **I1** write path loads NO model (deterministic, identical-in → identical-bytes). `engine.ts:1522-1592`
- **I2** dedup/conflict mechanical & deterministic (no NLI/embedding). `engine.ts:1399-1490,1206-1213`
- **I3** engine NEVER auto-resolves/merges/deletes — conflicts BLOCK + surface; staleness surface-only. `engine.ts:2153-2212`
- **I4** file-first: markdown per fact is source of truth; SQLite index = disposable rebuildable cache. `paths.ts`, `store.ts:90-96`
- **I5** zero mandatory external service / API key (local GGUF only). `package.json`, `store.ts:15-18`
- **I6** single-user, project/global scope (no tenant identity); git = sync. `engine.ts:1791,1932-1952`
- **I7** recall read-only, degrades hybrid→lex gracefully. `engine.ts:1804-1842`

### Deliberate NON-PORTS (what NOT to take)
| mem0 feature | breaks |
|---|---|
| LLM extraction on `add()` (infer=True) | I1 + I5 → **codified as e10** |
| LLM auto ADD/UPDATE/DELETE consolidation | I3 |
| `user_id`/`agent_id` multi-tenancy | I6 |
| vector-store-first / hosted platform / posthog | I4 / I5 |

---

## Part 3 — 18 borrowable ideas, gated (value/effort + verdict)

| id | feature | gate verdict | v/e |
|---|---|---|---|
| e1 | derived entity index (frontmatter tags + digit-identifier tokens, MODEL-FREE; read-time overlap as ordering-only signal) | foundation, scoring gated on eval win | med/large |
| e2 | structured recall filters `--tags-any/--tags-all/--since/--until` via existing gate()+footer (entity filter deferred to e1) | adapt-with-changes | med/med |
| e3 | entity nav surfaces: `qmemd entities` histogram / `related` / `entity` (read-only over e1 table) | adapt-with-changes | med/small |
| e4 | opt-in LLM entity enrichment writing entities into frontmatter (separate verb, off write path) | adopt-as-opt-in | med/med |
| e5 | `--include-superseded` fenced recall (show_expired analog), display-only | adopt-as-opt-in | med/small |
| e6 | `--lex-floor` relative-confidence floor on lex path (opt-in, default 0) | adopt-as-opt-in | low/small |
| e7 | ephemeral 'scratch' lane (run_id analog) + surfaced sweep, NOT auto-delete | adopt-as-opt-in | med/med |
| e8 | pending.md conflict-decision ledger | **REJECTED** (non-recomputable primary state; breaks I4/I6/I7; `--force` already better) | low/small |
| e9 | `qmemd consolidate` digest: fuse dedup+stale+conflict, label edges MERGE/SUPERSEDE/REVIEW/NOOP via existing lexicons | adopt | med/med |
| e10 | codify deliberate NON-PORT of engine-side infer=True (comment + CLAUDE.md bullet, zero runtime) | adopt | med/small |
| e11 | `previewRemember()` + extract inlined Tier-1/2/2.5 walk into one shared `classifyCandidate()` (I2 single source of truth; keystone for capture cluster) | adapt-with-changes | med/med |
| e12 | MCP `preview_remember` (drop 'transcript' framing); agent distills, engine previews dispositions | adapt-with-changes | med/small |
| e13 | `qmemd extract --from <file>` local-GGUF distiller (needs NEW generation loop, not embed loader) | adopt-as-opt-in | med/large |
| e14 | capture inbox: staged candidates as markdown, promote-only into recall (needs `store.ts` glob fix + I7 regression test) | adapt-with-changes | med/med |
| e15 | **temporal + knowledge-update eval track** on golden harness (supersession retirement + staleness partition — both ZERO coverage today; seams exist, model-free) | adopt | **high/small** |
| e16 | `bench:recall --check` regression gate w/ committed baseline | adapt (**FOLD into open `qp-calibration-set-floor-guard-38c`**) | med/small |
| e17 | opt-in local recall analytics JSONL + `qmemd stats` (off-by-default; feeds eval loop, never ranking) | adopt-as-opt-in | med/med |
| e18 | offline self-contained HTML status dashboard | adopt-as-opt-in | low/medium |

---

## Part 4 — Judge panel verdict (the decision)

**5 reviewer-judges** (architect / shipper / skeptic / agent-consumer / eval-first), each spot-checked source.

### Final build slate (presiding synthesis)
1. **e15** — unanimous #1 (5/5 doFirst; 4 "if only one"). Build the eval gate before touching what it guards.
2. **e16** — fold into open `qp-calibration-set-floor-guard-38c`, don't re-file. Completes the eval spine.
3. **e10** — free identity guardrail; plant at the `classifyCandidate` seam (per architect) not a lone doc bullet.
4. **e2** — NOW ph1: structured filters; the agent-facing precision win felt every turn.
5. **e5** — NOW: display-only `--include-superseded`, pairs with e15's retirement track.
6. **e17** — NEXT: field telemetry → the ground truth that makes the golden set honest.
7. **e11** — NEXT, coupled to capture-cluster schedule (before e12/e13/e14).
8. **e9** — NEXT, thin post-e11 read-only digest.
9. **e1** — LATER, **hard-gated on a measured, reproducible recall miss** entity-overlap closes.
10. **e3** — LATER, strictly downstream of e1.
11. **e4** — LATER, hardest gate (model writing into file-first frontmatter).
12. **e13** — LATER, lowest value-per-effort.

### Explicit DO NOT BUILD
**e8** (rejected) · **e18** (agent reads text, not browsers) · **e6** (knob nobody turns) · **e13** (new GGUF generation loop breaks write-path determinism, duplicates the agent).

### Preserved dissent (sharp, not flattened)
- **KILL the entity spine, don't defer it** (skeptic + architect): single-user, ~34-fact corpus where BM25 already AND-matches digit/identifier tokens → a derived entity index most likely adds *rank noise*. **"Run e15 expecting it to be the entity cluster's obituary, not to bless it."**
- **Hand-authored golden sets are themselves unmeasured assumptions** (eval-first): the 34-fact/15-query set bakes in the author's guess; any floor delta < ~0.05 is noise. Real ground truth = **e17 field telemetry over the agent's actual query stream**. e15 survives only because it asserts *deterministic mechanics* (superseded-vanishes, stale-surfaces-never-mutates), not subjective relevance.
- **e2/e5 are speculative ergonomics** (skeptic + eval-first): cheap ≠ warranted; defer behind e17 telemetry showing agents actually issue tag/time/retired queries.
- **e11 ships nothing now** (3 judges): refactoring the identity-critical dedup path ahead of its only (LATER) consumer is foundation-ahead-of-demand.

### Bottom line
**Build the instruments before the features.** NOW = **e15 + e16(into 38c) + e10**, then cheap agent surfaces **e2/e5** (over a real telemetry-first objection). NEXT = **e17 → e11 → e9**. Entity spine (e1/e3/e4) stays on faith-probation — measure first; let the eval be the obituary for everything it can't justify. **e15 is test infra → no plan-approval gate needed and is the unanimous pick.**
