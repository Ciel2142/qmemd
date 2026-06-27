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
    const malformed  = writeFact(root, { type: "project", created: "2020-01-01", reviewBy: "soon", name: "malformed-failopen" }); // fails open → window

    const r = staleFacts(root, { today: TODAY });
    const dueSlugs = r.due.map((e) => e.slug);
    const unreviewedSlugs = r.unreviewed.map((e) => e.slug);

    expect(dueSlugs).toContain(dueOnToday);        // review_by == today is due
    expect(dueSlugs).toContain(implicitOverdue);   // implicit overdue (>90d project)
    expect(dueSlugs).toContain(malformed);         // malformed fails open to the window
    expect(unreviewedSlugs).toContain(backlog);    // reference within window, never reviewed
    expect(dueSlugs).not.toContain(backlog);       // backlog is unreviewed, NOT due (partition)
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
      .sort().join(" ");
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
      expect(updatedBefore).toBeDefined();                                // else the equality below is vacuous

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
