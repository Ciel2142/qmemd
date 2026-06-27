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
