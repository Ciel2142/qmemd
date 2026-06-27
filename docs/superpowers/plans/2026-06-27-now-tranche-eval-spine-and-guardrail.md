# NOW-tranche eval spine + identity guardrail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add model-free behavioral eval coverage for qmemd's two knowledge-update mechanics (supersession-retirement + staleness), plant the `infer=True` non-port guardrail at the dedup seam, and give the recall bench a committed-baseline `--check` regression gate.

**Architecture:** Three independent parts. **e10** (qp-azc) is two doc/comment edits, zero runtime. **e15** (qp-gep) adds two vitest files under `test/golden/` that seed a real lex-only store via existing helpers and assert deterministic boolean mechanics — stays in `npm test`, loads no model. **e16** (folds into qp-calibration-set-floor-guard-38c) extends `scripts/recall-bench.ts` with N-run-median + committed baseline + `--check` exit-code gate; model-loading, runs only under `npm run bench:recall`, never `npm test`.

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 22), vitest, `@tobilu/qmd` store, `tsx` for the bench script.

**Spec:** `docs/superpowers/specs/2026-06-27-now-tranche-eval-spine-and-guardrail.md`.

## Global Constraints

- **MF (model-free `npm test`):** vitest must never load the embed/rerank model. New eval files pass `lexOnly: true` and open the store with **no** `embedModel`. Anything model-loading lives in `scripts/recall-bench.ts` only.
- **No runtime change from e10/e15:** e10 is comment + doc only; e15 is additive test code only. `src/` behavior is untouched by both. Only e16 edits non-test runtime (`scripts/recall-bench.ts`, `test/golden/metrics.ts`, `test/golden/seed.ts`, `test/golden/golden-set.json`).
- **Two distinct floors — never conflate:** `golden-set.json` `min_score = 0.5` is the **lex BM25** tripwire floor. `DEFAULT_MIN_SCORE = 0.575` (`src/engine.ts:1633`) is the **hybrid rerank** floor that e16 guards.
- **e16 tolerance band `> 0.05`:** on the 34-fact hand-authored set any relevance delta `< ~0.05` is noise (judge dissent). Use `0.07`.
- **Fold-not-refile:** e16 closes the gap tracked by `qp-calibration-set-floor-guard-38c`; do not create a new top-level issue.
- **Commit message trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Build/test commands:** `npm run build` (tsc → dist/), `npm test` (vitest run), `npm run bench:recall` (model-loading bench).

---

## File Structure

- `src/engine.ts` — **modify** (e10): one comment block at the dedup seam (`:1397`). No code change.
- `CLAUDE.md` — **modify** (e10): one bullet under "Conventions & Patterns".
- `test/golden/seed.ts` — **modify** (e15): extract `createTmpMemoryStore()` helper; (e16) add `paraphrase_queries` + `distractors` to `GoldenSet` and validate paraphrases.
- `test/golden/retirement.test.ts` — **create** (e15): supersession-retirement partition.
- `test/golden/staleness.test.ts` — **create** (e15): staleness partition.
- `test/golden/metrics.ts` — **modify** (e16): add `medianAggregate()`.
- `test/golden/metrics.test.ts` — **modify** (e16): unit-test `medianAggregate()`.
- `test/golden/golden-set.json` — **modify** (e16): add paraphrase queries + distractor queries.
- `test/golden/recall-baseline.json` — **create** (e16): committed baseline (authored via `--update-baseline`).
- `scripts/recall-bench.ts` — **modify** (e16): argv (`--check`/`--update-baseline`/`--runs=N`), N-run median, baseline read/write, tolerance diff, distractor floor check, exit codes.

---

# PART A — e10: codify the `infer=True` non-port (qp-azc)

### Task 1: Plant the non-port guardrail (comment + CLAUDE.md bullet)

**Files:**
- Modify: `src/engine.ts:1397` (insert a comment above the existing `// Dedup check` line)
- Modify: `CLAUDE.md` (insert one bullet after the "Dedup is three-tier" bullet)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (zero runtime). Pure documentation at the seam a future `classifyCandidate()` extraction (e11) will inherit.

- [ ] **Step 1: Read the current dedup seam to anchor the edit**

Run: `sed -n '1396,1399p' src/engine.ts`
Expected output (the anchor — do NOT change these lines):
```
  // Dedup check — skipped when --replace, --force, or --supersedes is set (a successor
  // legitimately near-dups the fact it retires).
  if (!input.replace && !input.force && !input.supersedes) {
```

- [ ] **Step 2: Insert the non-port comment immediately above the `// Dedup check` comment**

In `src/engine.ts`, change:
```typescript
  // Dedup check — skipped when --replace, --force, or --supersedes is set (a successor
  // legitimately near-dups the fact it retires).
  if (!input.replace && !input.force && !input.supersedes) {
```
to:
```typescript
  // NON-PORT (mem0 add(infer=True)): qmemd never LLM-distills a fact from a transcript on
  // the write path. The write loads NO model (I1) and needs NO API key (I5) — the fact text
  // is stored verbatim (writeFileSync below); only this model-free dedup/classify walk runs.
  // Distillation is the agent's job, never the engine's. A future shared classifyCandidate()
  // (e11) extracted from this walk inherits the same rule: keep it model-free.
  // Dedup check — skipped when --replace, --force, or --supersedes is set (a successor
  // legitimately near-dups the fact it retires).
  if (!input.replace && !input.force && !input.supersedes) {
```

- [ ] **Step 3: Read the CLAUDE.md dedup bullet to anchor the doc edit**

Run: `grep -n "Dedup is three-tier" CLAUDE.md`
Expected: one match (the bullet under "## Conventions & Patterns").

- [ ] **Step 4: Insert the non-port bullet after the "Dedup is three-tier" bullet**

In `CLAUDE.md`, immediately after the bullet that begins `- **Dedup is three-tier**` (the whole bullet ends at "Tier detail: README + dedup.ts."), insert a new bullet:
```markdown
- **Non-port — no engine-side `infer`:** the write path is deterministic and model-free (I1) and needs no API key (I5). Unlike mem0's `add(infer=True)`, qmemd never LLM-distills facts on write — text is stored **verbatim**; the agent distills, the engine only classifies (model-free dedup). Guardrail planted at the dedup seam (`engine.ts` `// NON-PORT`), inherited by any future `classifyCandidate()` (e11).
```

- [ ] **Step 5: Verify build is green and nothing else changed**

Run: `npm run build`
Expected: exits 0, no errors.
Run: `git diff --stat`
Expected: only `src/engine.ts` and `CLAUDE.md` changed; insertions only.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(engine): codify infer=True non-port at dedup seam (e10, qp-azc)

Comment at the dedup seam + a CLAUDE.md bullet stating the write path
loads no model (I1) and needs no API key (I5); facts are stored verbatim.
Zero runtime change. Inherited by a future classifyCandidate() (e11).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# PART B — e15: temporal + knowledge-update eval track (qp-gep)

### Task 2: Extract `createTmpMemoryStore()` helper in seed.ts

**Files:**
- Modify: `test/golden/seed.ts`
- Test (regression): `test/golden-recall.test.ts` (must still pass — proves the refactor is behavior-preserving)

**Interfaces:**
- Produces: `createTmpMemoryStore(opts?: { embedModel?: string }): Promise<{ store: QMDStore; root: string; cleanup: () => Promise<void> }>` — a fresh tmp lex-only (or hybrid, if `embedModel`) store with no corpus seeded. Reused by `retirement.test.ts` and `staleness.test.ts`.

- [ ] **Step 1: Add the `createTmpMemoryStore` helper and refactor `seedGoldenStore` to use it**

In `test/golden/seed.ts`, add this exported helper just above `seedGoldenStore` (after `loadGoldenSet`):
```typescript
export interface TmpMemoryStore {
  store: QMDStore;
  root: string;
  cleanup: () => Promise<void>;
}

/** A fresh empty tmp store (no corpus seeded). Lex-only unless `embedModel` is set. The tmp
 *  dir is not a git repo, so remember()'s git sync is a no-op. Shared by the behavioral eval
 *  partitions (retirement/staleness) and by seedGoldenStore. */
export async function createTmpMemoryStore(
  opts: { embedModel?: string } = {},
): Promise<TmpMemoryStore> {
  const parent = await mkdtemp(join(tmpdir(), "qmemd-golden-"));
  const root = join(parent, "mem");
  await mkdir(root, { recursive: true });
  await mkdir(join(parent, "idx"), { recursive: true });
  const store = await createStore({
    dbPath: join(parent, "idx", "i.sqlite"),
    config: {
      ...(opts.embedModel ? { models: { embed: opts.embedModel } } : {}),
      collections: { memory: { path: root, pattern: "**/*.md" } },
    },
  });
  return {
    store,
    root,
    cleanup: async () => {
      await store.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}
```
Then replace the body of `seedGoldenStore` (everything between `const golden = await loadGoldenSet(goldenSetPath);` and the `return {` block) so it delegates to the helper:
```typescript
export async function seedGoldenStore(
  goldenSetPath: string,
  opts: { embedModel?: string } = {},
): Promise<SeededStore> {
  const golden = await loadGoldenSet(goldenSetPath);
  const tmp = await createTmpMemoryStore(opts);
  for (const entry of golden.corpus) {
    const res = await remember(tmp.store, tmp.root, { fact: entry.fact, type: entry.type });
    if (!res.wrote) throw new Error(`corpus fact '${entry.slug}' deduped against '${res.duplicateOf}'`);
    if (res.slug !== entry.slug) throw new Error(`corpus fact wrote slug '${res.slug}', expected '${entry.slug}'`);
  }
  return { store: tmp.store, root: tmp.root, golden, cleanup: tmp.cleanup };
}
```

- [ ] **Step 2: Run the existing golden guard to prove the refactor preserved behavior**

Run: `npm test -- golden-recall`
Expected: PASS (both tests in `test/golden-recall.test.ts` green — the refactor changed no behavior).

- [ ] **Step 3: Commit**

```bash
git add test/golden/seed.ts
git commit -m "$(cat <<'EOF'
test(golden): extract createTmpMemoryStore helper (e15, qp-gep)

Factor the tmp-store setup out of seedGoldenStore so the new behavioral
eval partitions can open a fresh lex-only store without seeding the
relevance corpus. Behavior-preserving — golden-recall guard still green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: Supersession-retirement partition

**Files:**
- Create: `test/golden/retirement.test.ts`

**Interfaces:**
- Consumes: `createTmpMemoryStore` (Task 2); `remember`, `recallQueryWithStatus`, `recallSession` from `../../src/engine.js`.
- Produces: nothing (guard tests). These assert EXISTING engine behavior (`bri`), so they go green immediately; they exist to trip on a future regression of the retirement filter (`engine.ts:521`, `:1946`).

- [ ] **Step 1: Write the retirement guard tests**

Create `test/golden/retirement.test.ts`:
```typescript
import { describe, test, expect } from "vitest";
import { remember, recallQueryWithStatus, recallSession } from "../../src/engine.js";
import { createTmpMemoryStore } from "./seed.js";

// e15 (qp-gep) — supersession-retirement partition. Deterministic, model-free behavioral
// guards over the engine's retirement mechanic (bri): a superseded fact is hidden from every
// recall lane yet stays on disk byte-preserved, while a conflicts_with fact stays recallable.
// These assert existing behavior end-to-end (the value is regression detection, not red-green).

/** Body text below the closing frontmatter fence. */
function bodyOf(content: string): string {
  const parts = content.split(/^---$/m);
  return parts.slice(2).join("---").trim();
}
/** A single `key: value` frontmatter line's value, or undefined. */
function fmLine(content: string, key: string): string | undefined {
  const m = new RegExp(`^${key}: (.*)$`, "m").exec(content);
  return m?.[1];
}

describe("e15 supersession-retirement", () => {
  test("a superseded fact vanishes from recallQuery; its successor is returned", async () => {
    const { store, root, cleanup } = await createTmpMemoryStore();
    try {
      const a = await remember(store, root, { fact: "alpha broker queue port is 5672", type: "project", project: "p1" });
      const b = await remember(store, root, { fact: "alpha broker queue port is 5673 now", type: "project", project: "p1", supersedes: a.slug });
      expect(b.supersededSlug).toBe(a.slug);

      const res = await recallQueryWithStatus(store, root, "alpha broker queue port", { lexOnly: true, project: "p1" });
      const slugs = res.hits.map((h) => h.slug);
      expect(slugs).toContain(b.slug);
      expect(slugs).not.toContain(a.slug);
    } finally {
      await cleanup();
    }
  });

  test("a retired fact is hidden from the session snapshot even when pinned", async () => {
    const { store, root, cleanup } = await createTmpMemoryStore();
    try {
      const a = await remember(store, root, { fact: "gamma cache eviction is LRU", type: "project", project: "p1", pinned: true });
      const b = await remember(store, root, { fact: "gamma cache eviction is LFU now", type: "project", project: "p1", supersedes: a.slug });
      const snap = await recallSession(root, { project: "p1" });
      expect(snap).not.toContain("LRU");      // retired fact's content absent
      expect(snap).toContain("LFU");          // successor present (in-scope project slice)
    } finally {
      await cleanup();
    }
  });

  test("retirement preserves the old fact's body bytes and does not bump `updated`", async () => {
    const { store, root, cleanup } = await createTmpMemoryStore();
    const { readFileSync } = await import("node:fs");
    try {
      const a = await remember(store, root, { fact: "delta token TTL is 3600s", type: "project", project: "p1" });
      const before = readFileSync(a.path, "utf-8");
      await remember(store, root, { fact: "delta token TTL is 7200s now", type: "project", project: "p1", supersedes: a.slug });
      const after = readFileSync(a.path, "utf-8");

      expect(bodyOf(after)).toBe(bodyOf(before));                 // body byte-preserved
      expect(fmLine(after, "updated")).toBe(fmLine(before, "updated")); // updated unchanged
      expect(fmLine(after, "superseded_by")).toBeDefined();       // reverse link stamped
    } finally {
      await cleanup();
    }
  });

  test("a conflicts_with-stamped fact stays fully recallable (only supersededBy hides)", async () => {
    const { store, root, cleanup } = await createTmpMemoryStore();
    try {
      const x = await remember(store, root, { fact: "epsilon redis port is 6379", type: "project", project: "p1" });
      const y = await remember(store, root, { fact: "epsilon redis port is 6380", type: "project", project: "p1", force: true });
      expect(y.conflictsWith).toBe(x.slug);   // force recorded the contradiction

      const res = await recallQueryWithStatus(store, root, "epsilon redis port", { lexOnly: true, project: "p1" });
      expect(res.hits.map((h) => h.slug)).toContain(y.slug); // conflicts_with does NOT hide
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the retirement tests**

Run: `npm test -- retirement`
Expected: PASS (4 tests). If the conflict test fails on `y.conflictsWith` being undefined, confirm the digit-flip (6379 vs 6380) trips the mechanical conflict classifier; adjust to a clearer identifier flip if needed (e.g. `port is 6379` vs `port is 9379`) — keep both facts otherwise near-identical so Tier-2.5 fires.

- [ ] **Step 3: Commit**

```bash
git add test/golden/retirement.test.ts
git commit -m "$(cat <<'EOF'
test(golden): supersession-retirement eval partition (e15, qp-gep)

End-to-end guards: a superseded fact vanishes from recallQuery and from
the pinned session snapshot, its old body+updated are byte-preserved, and
a conflicts_with fact stays recallable. Model-free (lexOnly), in npm test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: Staleness partition

**Files:**
- Create: `test/golden/staleness.test.ts`

**Interfaces:**
- Consumes: `createTmpMemoryStore` (Task 2); `staleFacts`, `markReviewed`, `remember`, `recallQueryWithStatus`, `serializeMemory`, `type MemoryFrontmatter` from `../../src/engine.js`.
- Produces: nothing (guard tests). Asserts existing `staleFacts` (`9su`) behavior + the cross-cutting "due fact still recalled" invariant + "reviewed leaves `updated` honest" + "staleFacts never mutates".

- [ ] **Step 1: Write the staleness guard tests**

Create `test/golden/staleness.test.ts`:
```typescript
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  staleFacts, markReviewed, remember, recallQueryWithStatus, serializeMemory,
  type MemoryFrontmatter, type MemoryType,
} from "../../src/engine.js";
import { createTmpMemoryStore } from "./seed.js";

// e15 (qp-gep) — staleness partition. staleFacts (9su) is surface-only: it partitions
// decay-prone facts into due/unreviewed and NEVER mutates, while recall ignores review_by
// entirely (nothing auto-expires). Deterministic via an injected `today`. Filesystem-authored
// fixtures need no store; the cross-cutting "still recalled" case uses a lex-only store.

const TODAY = "2026-06-27";

/** Author a fact file directly (fixed dates) so staleFacts sees a deterministic corpus. */
function writeFact(root: string, over: Partial<MemoryFrontmatter> & { type: MemoryType; created: string }): string {
  const slug = over.name ?? `f-${over.type}-${over.created}-${over.reviewBy ?? "none"}`;
  const fm: MemoryFrontmatter = {
    name: slug, description: `${slug} desc`, type: over.type, tags: [],
    project: over.project ?? "global", created: over.created, pinned: over.pinned ?? false,
    ...(over.reviewBy !== undefined ? { reviewBy: over.reviewBy } : {}),
    ...(over.updated !== undefined ? { updated: over.updated } : {}),
  };
  mkdirSync(join(root, over.type), { recursive: true });
  writeFileSync(join(root, over.type, `${slug}.md`), serializeMemory(fm, `${slug} body`));
  return slug;
}

describe("e15 staleness — filesystem fixtures (no store)", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    delete process.env.QMEMD_TTL_PROJECT;
  });

  test("due/unreviewed partition over the boundary table", () => {
    root = mkdtempSync(join(tmpdir(), "qmemd-stale-"));
    const dueOnToday = writeFact(root, { type: "project", created: "2020-01-01", reviewBy: TODAY, name: "due-on-today" });
    const future     = writeFact(root, { type: "project", created: "2020-01-01", reviewBy: "2030-01-01", name: "future" });
    const durable    = writeFact(root, { type: "project", created: "2010-01-01", reviewBy: "never", name: "durable" });
    const implicitOverdue = writeFact(root, { type: "project", created: "2020-01-01", name: "implicit-overdue" }); // >90d, no review_by
    const backlog    = writeFact(root, { type: "reference", created: "2026-06-01", name: "ref-backlog" });         // <180d, never reviewed
    const userExempt = writeFact(root, { type: "user", created: "2010-01-01", name: "user-exempt" });             // durable type
    const malformed  = writeFact(root, { type: "project", created: "2020-01-01", reviewBy: "soon", name: "malformed-faulopen" }); // fails open → window

    const r = staleFacts(root, { today: TODAY });
    const dueSlugs = r.due.map((e) => e.slug);
    const unreviewedSlugs = r.unreviewed.map((e) => e.slug);

    expect(dueSlugs).toContain(dueOnToday);        // review_by == today is due
    expect(dueSlugs).toContain(implicitOverdue);   // implicit overdue (>90d project)
    expect(dueSlugs).toContain(malformed);         // malformed fails open to the window
    expect(unreviewedSlugs).toContain(backlog);    // reference within window, never reviewed
    for (const exempt of [future, durable, userExempt]) {
      expect(dueSlugs).not.toContain(exempt);
      expect(unreviewedSlugs).not.toContain(exempt);
    }
  });

  test("QMEMD_TTL_PROJECT override shifts a recent project fact into due", () => {
    root = mkdtempSync(join(tmpdir(), "qmemd-stale-"));
    const recent = writeFact(root, { type: "project", created: "2026-06-25", name: "recent-proj" }); // 2d old
    expect(staleFacts(root, { today: TODAY }).due.map((e) => e.slug)).not.toContain(recent); // default 90d → not due
    process.env.QMEMD_TTL_PROJECT = "1d";
    expect(staleFacts(root, { today: TODAY }).due.map((e) => e.slug)).toContain(recent);     // 1d window → due
  });

  test("staleFacts never mutates the corpus", () => {
    root = mkdtempSync(join(tmpdir(), "qmemd-stale-"));
    writeFact(root, { type: "project", created: "2020-01-01", name: "m1" });
    writeFact(root, { type: "reference", created: "2026-06-01", name: "m2" });
    const snapshot = (): string => ["project", "reference", "user", "feedback"]
      .flatMap((t) => { try { return readdirSync(join(root, t)).map((f) => `${t}/${f}:${readFileSync(join(root, t, f), "utf-8")}`); } catch { return []; } })
      .sort().join(" ");
    const before = snapshot();
    staleFacts(root, { today: TODAY });
    expect(snapshot()).toBe(before);
  });
});

describe("e15 staleness — recall ignores review_by (store-backed, lex-only)", () => {
  test("a due fact is still returned by recall; `reviewed` leaves `updated` honest", async () => {
    const { store, root, cleanup } = await createTmpMemoryStore();
    try {
      const f = await remember(store, root, { fact: "kafka topic retention policy is 7 days", type: "project", project: "p1" });
      const updatedBefore = (() => { const m = /^updated: (.*)$/m.exec(readFileSync(f.path, "utf-8")); return m?.[1]; })();

      await markReviewed(store, root, f.slug, { reviewBy: "2020-01-01" }); // force it past-due
      const content = readFileSync(f.path, "utf-8");
      expect(/^review_by: 2020-01-01$/m.test(content)).toBe(true);
      expect(/^updated: (.*)$/m.exec(content)?.[1]).toBe(updatedBefore);   // updated NOT bumped

      const r = staleFacts(root, { today: TODAY });
      expect(r.due.map((e) => e.slug)).toContain(f.slug);                  // surfaced as due

      const res = await recallQueryWithStatus(store, root, "kafka topic retention", { lexOnly: true, project: "p1" });
      expect(res.hits.map((h) => h.slug)).toContain(f.slug);              // recall ignores review_by
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the staleness tests**

Run: `npm test -- staleness`
Expected: PASS (4 tests). If `MemoryType` is not exported from `../../src/engine.js`, change the import to bring it from `./seed.js` (which re-exports it via `remember`'s `MemoryType`) or drop the annotation and use a string-literal-typed local — verify the export with `grep -n "export type MemoryType\|export.*MemoryType" src/engine.ts` first.

- [ ] **Step 3: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — all suites including the new partitions; no model loaded.

- [ ] **Step 4: Commit**

```bash
git add test/golden/staleness.test.ts
git commit -m "$(cat <<'EOF'
test(golden): staleness eval partition (e15, qp-gep)

Guards: due/unreviewed boundary table over fixed-date fixtures, the
QMEMD_TTL_PROJECT override, staleFacts non-mutation, and the cross-cutting
invariant that a due fact is still recalled (recall ignores review_by)
while `reviewed` leaves `updated` honest. Model-free, in npm test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# PART C — e16: `bench:recall --check` + committed baseline (folds into qp-calibration-set-floor-guard-38c)

> **Dependency:** Task 8 (author the baseline) runs `npm run bench:recall --update-baseline`, which **loads the embed/rerank model** (downloads embeddinggemma-300M on first run). It cannot run in model-free CI — execute it on a workstation. All other e16 tasks are code-only.

### Task 5: Add paraphrase + distractor queries to the golden set

**Files:**
- Modify: `test/golden/seed.ts` (extend `GoldenSet` + validate paraphrases)
- Modify: `test/golden/golden-set.json` (add `paraphrase_queries` + `distractors`)

**Interfaces:**
- Produces: `GoldenSet.paraphrase_queries?: GoldenQuery[]` (lex-hard, hybrid/bench only — **excluded** from the lex vitest guard so it can't drag the lex floors) and `GoldenSet.distractors?: string[]` (queries that must return nothing above the hybrid floor).

- [ ] **Step 1: Extend the `GoldenSet` interface and validation**

In `test/golden/seed.ts`, change the `GoldenSet` interface:
```typescript
export interface GoldenSet {
  corpus: { type: MemoryType; fact: string; slug: string }[];
  queries: GoldenQuery[];
  /** Lex-hard paraphrase/synonym queries that force the vector+rerank path (e16). Measured by
   *  the bench (hybrid) only — EXCLUDED from the lex vitest guard so a no-lex-overlap query
   *  cannot drop the committed lex floors. */
  paraphrase_queries?: GoldenQuery[];
  /** Negative queries that must return NOTHING above the hybrid rerank floor (e16). No relevant
   *  set — the bench asserts the floor drops every hit. */
  distractors?: string[];
  min_score: number;
}
```
Then extend `validateGoldenSet` to validate paraphrase slug references the same way as `queries` — replace the `for (const q of golden.queries)` loop with one over both lists:
```typescript
  for (const q of [...golden.queries, ...(golden.paraphrase_queries ?? [])]) {
    if (!q.relevant?.length) throw new Error(`golden set: query '${q.query}' has no relevant slugs`);
    for (const s of [...q.relevant, ...(q.top ? [q.top] : [])]) {
      if (!slugs.has(s)) throw new Error(`golden set: query '${q.query}' references unknown slug '${s}'`);
    }
  }
```

- [ ] **Step 2: Read existing corpus slugs to target paraphrases/distractors correctly**

Run: `node -e "const g=require('./test/golden/golden-set.json'); console.log(g.corpus.map(c=>c.slug).join('\n'))"`
Expected: the 34 corpus slugs. Pick 3 with clear semantic synonyms for paraphrases; note 2–3 topics ABSENT from the corpus for distractors.

- [ ] **Step 3: Add `paraphrase_queries` and `distractors` to `golden-set.json`**

In `test/golden/golden-set.json`, add two keys at the top level (sibling to `queries` / `min_score`). Use ACTUAL slugs surfaced in Step 2 — the examples below assume corpus facts about a message broker port, a vector DB port, and the recall session snapshot (adjust slugs to the real ones):
```json
  "paraphrase_queries": [
    { "query": "which TCP endpoint does the event streaming bus listen on", "relevant": ["<broker-port-slug>"] },
    { "query": "embedding similarity store network address", "relevant": ["<vector-db-port-slug>"] },
    { "query": "what gets injected at the start of a conversation", "relevant": ["<recall-session-slug>"] }
  ],
  "distractors": [
    "kubernetes pod autoscaling thresholds",
    "react component lifecycle hooks",
    "sourdough hydration ratio"
  ],
```

- [ ] **Step 4: Confirm the lex vitest guard still passes (paraphrases excluded from it)**

Run: `npm test -- golden-recall`
Expected: PASS — the lex guard iterates only `queries`, so the new lex-hard paraphrases do not affect its floors. If `seed.test.ts` count assertions exist, run `npm test -- seed` and confirm green (corpus/queries counts unchanged).

- [ ] **Step 5: Commit**

```bash
git add test/golden/seed.ts test/golden/golden-set.json
git commit -m "$(cat <<'EOF'
test(golden): add paraphrase + distractor queries (e16, 38c task a/b)

paraphrase_queries force the vector+rerank path (excluded from the lex
guard so they can't drop lex floors); distractors must return nothing
above the hybrid floor. Consumed by the bench --check gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6: Add `medianAggregate()` to metrics + unit test

**Files:**
- Modify: `test/golden/metrics.ts`
- Modify: `test/golden/metrics.test.ts`

**Interfaces:**
- Produces: `medianAggregate(runs: AggregateScore[]): AggregateScore` — per-field median across N runs (absorbs rerankScore jitter). `k`/`n` taken from the first run.

- [ ] **Step 1: Write the failing unit test**

In `test/golden/metrics.test.ts`, add:
```typescript
import { medianAggregate } from "./metrics.js";

describe("medianAggregate", () => {
  test("takes the per-field median across runs", () => {
    const mk = (p: number, m: number) => ({ pAt1: p, pAtK: p, rAtK: p, mrr: m, k: 5, n: 10 });
    const out = medianAggregate([mk(0.6, 0.7), mk(0.8, 0.9), mk(0.7, 0.8)]);
    expect(out.pAt1).toBe(0.7); // median of 0.6,0.8,0.7
    expect(out.mrr).toBe(0.8);  // median of 0.7,0.9,0.8
    expect(out.k).toBe(5);
    expect(out.n).toBe(10);
  });

  test("averages the two middle values for an even run count", () => {
    const mk = (p: number) => ({ pAt1: p, pAtK: p, rAtK: p, mrr: p, k: 5, n: 10 });
    expect(medianAggregate([mk(0.4), mk(0.6)]).pAt1).toBeCloseTo(0.5, 10);
  });

  test("throws on zero runs", () => {
    expect(() => medianAggregate([])).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- metrics`
Expected: FAIL with "medianAggregate is not a function" / import error.

- [ ] **Step 3: Implement `medianAggregate` in metrics.ts**

In `test/golden/metrics.ts`, append:
```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- metrics`
Expected: PASS (all `medianAggregate` cases green).

- [ ] **Step 5: Commit**

```bash
git add test/golden/metrics.ts test/golden/metrics.test.ts
git commit -m "$(cat <<'EOF'
test(golden): add medianAggregate for N-run jitter absorption (e16)

Per-field median across bench runs so the --check baseline diff does not
flap on rerankScore non-determinism. Unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 7: Extend `recall-bench.ts` with `--check` / `--update-baseline` / `--runs`

**Files:**
- Modify: `scripts/recall-bench.ts`

**Interfaces:**
- Consumes: `medianAggregate` (Task 6); `GoldenSet.paraphrase_queries` + `distractors` (Task 5); `DEFAULT_MIN_SCORE` from `../src/engine.js`.
- Produces: a CLI with three modes — default (print-only, exit 0, back-compat), `--update-baseline` (write `test/golden/recall-baseline.json`), `--check` (N-run median vs baseline within tolerance, exit non-zero on regression).

- [ ] **Step 1: Replace `scripts/recall-bench.ts` with the mode-aware version**

Overwrite `scripts/recall-bench.ts`:
```typescript
// Recall-quality bench (qmemd-3u8 + e16): runs every golden query through lex and hybrid and
// prints a scorecard. With --check it diffs an N-run MEDIAN against a committed baseline within
// a tolerance band and exits non-zero on regression (the floor-guard gate, 38c). Loads the embed
// model (hybrid path), so this is a `npm run` script, NEVER part of `npm test`.
//   npm run bench:recall                      # print-only (back-compat)
//   npm run bench:recall -- --update-baseline # author/refresh test/golden/recall-baseline.json
//   npm run bench:recall -- --check           # gate: median-vs-baseline, exit 1 on regression

import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { recallQueryWithStatus, DEFAULT_MIN_SCORE } from "../src/engine.js";
import { memoryEmbedModel } from "../src/store.js";
import { seedGoldenStore, type SeededStore, type GoldenQuery } from "../test/golden/seed.js";
import { scoreQuery, aggregate, medianAggregate, type QueryScore, type AggregateScore } from "../test/golden/metrics.js";

const GOLDEN = fileURLToPath(new URL("../test/golden/golden-set.json", import.meta.url));
const BASELINE = fileURLToPath(new URL("../test/golden/recall-baseline.json", import.meta.url));
const K = 5;
const TOLERANCE = 0.07; // > the ~0.05 hand-authored-set noise floor (judge dissent) so CI doesn't flap

interface ModeResult { agg: AggregateScore; avgMs: number; degradedCount: number }
interface Baseline { k: number; lex: AggregateScore; hybrid: AggregateScore; distractorFloorPrecision: number }

/** The hybrid query set = relevance queries + lex-hard paraphrases (e16). */
function hybridQueries(seeded: SeededStore): GoldenQuery[] {
  return [...seeded.golden.queries, ...(seeded.golden.paraphrase_queries ?? [])];
}

async function runMode(seeded: SeededStore, queries: GoldenQuery[], lexOnly: boolean): Promise<ModeResult> {
  const scores: QueryScore[] = [];
  let totalMs = 0;
  let degradedCount = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const res = await recallQueryWithStatus(seeded.store, seeded.root, q.query, { lexOnly, limit: K });
    totalMs += performance.now() - t0;
    if (res.degraded) degradedCount++;
    scores.push(scoreQuery(res.hits.map((h) => h.slug), new Set(q.relevant), K));
  }
  return { agg: aggregate(scores, K), avgMs: totalMs / Math.max(queries.length, 1), degradedCount };
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

function signed(n: number): string { return (n >= 0 ? "+" : "") + n.toFixed(3); }
function rowOf(label: string, m: ModeResult): string {
  return `${label.padEnd(8)} P@1=${m.agg.pAt1.toFixed(3)}  P@${K}=${m.agg.pAtK.toFixed(3)}  R@${K}=${m.agg.rAtK.toFixed(3)}  MRR=${m.agg.mrr.toFixed(3)}  avg=${m.avgMs.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const CHECK = argv.includes("--check");
  const UPDATE = argv.includes("--update-baseline");
  const runsArg = argv.find((a) => a.startsWith("--runs="));
  const RUNS = runsArg ? Math.max(1, parseInt(runsArg.split("=")[1] ?? "1", 10)) : (CHECK || UPDATE ? 5 : 1);

  const seeded = await seedGoldenStore(GOLDEN, { embedModel: memoryEmbedModel() });
  try {
    const hq = hybridQueries(seeded);
    // First hybrid call triggers the lazy embed barrier; run lex once for the comparison row.
    const lex = await runMode(seeded, hq, true);
    const hybridRuns: AggregateScore[] = [];
    for (let i = 0; i < RUNS; i++) hybridRuns.push((await runMode(seeded, hq, false)).agg);
    const hybridMedian = medianAggregate(hybridRuns);
    const floorPrec = await distractorFloorPrecision(seeded);

    console.log(`\nRecall-quality bench — ${hq.length} queries (${seeded.golden.queries.length} relevance + ${(seeded.golden.paraphrase_queries ?? []).length} paraphrase), ${seeded.golden.corpus.length} facts, k=${K}, runs=${RUNS}\n`);
    console.log(rowOf("lex", lex));
    console.log(`hybrid   P@1=${hybridMedian.pAt1.toFixed(3)}  P@${K}=${hybridMedian.pAtK.toFixed(3)}  R@${K}=${hybridMedian.rAtK.toFixed(3)}  MRR=${hybridMedian.mrr.toFixed(3)}  (median of ${RUNS})`);
    console.log(`distractor floor-precision: ${floorPrec.toFixed(3)} (${seeded.golden.distractors?.length ?? 0} distractors must stay below ${DEFAULT_MIN_SCORE})`);
    console.log(`\nΔ hybrid−lex:  P@1 ${signed(hybridMedian.pAt1 - lex.agg.pAt1)}  MRR ${signed(hybridMedian.mrr - lex.agg.mrr)}\n`);

    if (UPDATE) {
      const baseline: Baseline = { k: K, lex: lex.agg, hybrid: hybridMedian, distractorFloorPrecision: floorPrec };
      writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
      console.log(`✔ wrote baseline → ${BASELINE}`);
      return;
    }

    if (CHECK) {
      const base = JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline;
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
```

- [ ] **Step 2: Type-check the bench script compiles**

Run: `npm run build`
Expected: exits 0. (Catches any `GoldenQuery`/`AggregateScore` import or type mismatch before a model load.)

- [ ] **Step 3: Commit (code only; baseline authored in Task 8)**

```bash
git add scripts/recall-bench.ts
git commit -m "$(cat <<'EOF'
feat(bench): --check/--update-baseline/--runs regression gate (e16, 38c)

Adds N-run median, a committed-baseline diff within a 0.07 tolerance band,
distractor floor-precision, and non-zero exit on regression. Default mode
stays print-only. Model-loading — runs under bench:recall, never npm test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8: Author + commit the baseline (model-loading — run on a workstation)

**Files:**
- Create: `test/golden/recall-baseline.json`

- [ ] **Step 1: Generate the baseline (loads the embed model)**

Run: `npm run bench:recall -- --update-baseline`
Expected: prints the scorecard, then `✔ wrote baseline → .../test/golden/recall-baseline.json`. If hybrid prints "DEGRADED", the embed model did not load — fix the model setup before committing (a degraded baseline is meaningless).

- [ ] **Step 2: Sanity-check the baseline content**

Run: `cat test/golden/recall-baseline.json`
Expected: JSON with `k`, `lex`, `hybrid` (an `AggregateScore` each), and `distractorFloorPrecision` near `1.0` (distractors correctly excluded). If `distractorFloorPrecision` is low, the distractors are accidentally semantically close to corpus facts — pick more clearly off-topic distractors (Task 5) and regenerate.

- [ ] **Step 3: Verify the gate passes against its own baseline**

Run: `npm run bench:recall -- --check`
Expected: `✔ --check passed`. Exit 0.

- [ ] **Step 4: Commit the baseline**

```bash
git add test/golden/recall-baseline.json
git commit -m "$(cat <<'EOF'
test(golden): commit recall baseline for --check gate (e16, 38c)

Median hybrid scorecard + distractor floor-precision captured on a warm
embed model. Refresh after an intentional reranker change via
`npm run bench:recall -- --update-baseline`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 9: Close the loop on br issue 38c

- [ ] **Step 1: Record the fold completion on the issue**

```bash
ACTOR="${BR_ACTOR:-igi21}"
br comments add --actor "$ACTOR" qp-calibration-set-floor-guard-38c \
  --message "e16 landed: paraphrase_queries + distractors in golden-set.json; medianAggregate in metrics.ts; recall-bench.ts gained --check/--update-baseline/--runs with a committed test/golden/recall-baseline.json and a 0.07 tolerance band; distractor floor-precision consumes the hybrid floor. Tasks (a)/(b)/(c) satisfied via the baseline-file --check mechanism (hardcoded in-test constant NOT added, per spec decision)." --json | grep -o '"id":"[^"]*"' | head -1
```
Expected: a comment id prints. Leave 38c **open** until the two dependents (`qp-hybrid-vs-lex-default-policy-w0i`, `qp-recalibrate-default-min-score-7d8`) are addressed, unless the user closes it.

- [ ] **Step 2: Sync beads + commit**

```bash
br sync --flush-only
git add .beads/
git commit -m "chore(beads): record e16 fold-in on qp-calibration-set-floor-guard-38c

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- e15 Partition A (retirement) → Task 3 — assertions 1 (vanish from recallQuery), 2 (hidden from pinned session), 4 (body byte-preserved + updated unchanged), 6 (conflicts_with stays recallable). Spec assertion 3 (absent from staleFacts) is covered transitively (a retired fact never reaches staleFacts — `engine.ts:2175`) and by Task 4's fixtures; assertion 5 (one commit/both pathspecs) and 7 (fail-open on corrupt) are **deliberately NOT** re-asserted here — already unit-tested in `test/engine.test.ts:3431/3535` and the spec says do not re-prove units / do not assert hiding for corrupt inputs. **Gap accepted, documented.**
- e15 Partition B (staleness) → Task 4 — boundary table, TTL override, no-mutation, due-still-recalled, reviewed-honest.
- e16 → Tasks 5–9 — paraphrase (a), distractor/floor (b), median + baseline + `--check` exit gate (c), baseline authoring, 38c fold.
- e10 → Task 1 — engine comment + CLAUDE.md bullet.

**Placeholder scan:** Task 5 Step 3 uses `<broker-port-slug>` etc. — these are **resolved in Step 2** by reading the real corpus slugs first; the engineer fills them from that output (this is data discovery, not a code placeholder). All code blocks are complete.

**Type consistency:** `createTmpMemoryStore` (Task 2) is consumed by Tasks 3/4; `medianAggregate` (Task 6) by Task 7; `GoldenSet.paraphrase_queries`/`distractors` (Task 5) by Task 7. `AggregateScore`, `GoldenQuery`, `QueryScore`, `RecallHit.score`, `RememberResult.supersededSlug`/`conflictsWith`, `StaleReport.due[].slug`, `markReviewed` reviewBy option — all match the signatures in `src/engine.ts` and `test/golden/metrics.ts`/`seed.ts`.

---

## Execution order & risks

- **Sequence:** Task 1 (e10) and Tasks 2–4 (e15) are model-free and land first, in any order; Tasks 5–9 (e16) follow. Task 8 needs a workstation with the embed model.
- **Risk — conflict classifier (Task 3 Step 2):** if the 6379/6380 digit flip doesn't trip `classifyNearMatch`, widen the gap (6379/9379) — fallback is in the step.
- **Risk — `MemoryType` export (Task 4 Step 2):** verify the export before relying on the type import; fallback noted in the step.
- **Risk — distractor leakage (Task 8 Step 2):** a semantically-near distractor lowers floor-precision; pick clearly off-topic distractors.
```
