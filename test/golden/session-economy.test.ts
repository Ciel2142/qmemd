import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recallSession, serializeMemory,
  type MemoryFrontmatter, type MemoryType,
} from "../../src/engine.js";

// MF-4 (session-economy): prove the session snapshot respects its hard byte
// budget and emits the e3i lane footer rather than blowing the cap when the
// corpus overflows. BYTES only — deterministic mechanics, NOT injection
// relevance (that is qp-snapshot-injection-precision-qc4; keep this MF).
//
// One-liner size for each fact below:
//   "[project:global] longfact-<70×x>-N desc (longfact-<70×x>-N)"
//   = 17 (label prefix) + 86 (description) + 2 (space+open-paren) + 81 (name) + 1 (close-paren)
//   = 187 bytes per fact.
// 10 such facts → 10 × 187 = 1870 bytes of raw one-liners (>> 800 budget).
// projectLimit=5 slices to 5 candidates → 5 × 187 = 935 bytes still >> 800.
// The budget genuinely bites; the footer fires on the gap.

const BUDGET = 800;

/**
 * Write a project fact file directly into the lane dir under root.
 * Mirrors staleness.test.ts:writeFact — no store, no model, no index.
 */
function writeProjectFact(
  root: string,
  name: string,
  body = "project fact body",
  project = "global",
): void {
  const fm: MemoryFrontmatter = {
    name,
    description: `${name} desc`,
    type: "project" as MemoryType,
    tags: [],
    project,
    created: "2026-01-01",
    pinned: false,
  };
  mkdirSync(join(root, "project"), { recursive: true });
  writeFileSync(join(root, "project", `${name}.md`), serializeMemory(fm, body));
}

describe("session-economy (MF-4): byte budget + truncation", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("session snapshot never exceeds its byte budget", async () => {
    root = mkdtempSync(join(tmpdir(), "qmemd-economy-"));
    // 10 project facts with long names; each one-liner ≈ 187 bytes.
    // Unbudgeted total >> 800 → budget genuinely bites.
    const PAD = "x".repeat(70);
    for (let i = 0; i < 10; i++) {
      writeProjectFact(root, `longfact-${PAD}-${i}`);
    }

    const out = await recallSession(root, {
      budgetBytes: BUDGET,
      projectLimit: 5,
      platform: "all", // disable host-OS gate for determinism
    });
    const byteLen = Buffer.byteLength(out, "utf-8");

    expect(byteLen).toBeLessThanOrEqual(BUDGET);
    const fillRatio = byteLen / BUDGET;
    expect(fillRatio).toBeLessThanOrEqual(1);
  });

  test("an over-budget corpus truncates and emits a footer (not a blown budget)", async () => {
    root = mkdtempSync(join(tmpdir(), "qmemd-economy-"));
    const PAD = "y".repeat(70);
    for (let i = 0; i < 10; i++) {
      writeProjectFact(root, `bigfact-${PAD}-${i}`);
    }

    const out = await recallSession(root, {
      budgetBytes: BUDGET,
      projectLimit: 5,
      platform: "all",
    });
    const byteLen = Buffer.byteLength(out, "utf-8");

    // (a) Budget must still be respected even when the corpus vastly overflows it.
    expect(byteLen).toBeLessThanOrEqual(BUDGET);

    // (b) The e3i countFooter fires when facts are hidden — either by the
    //     projectLimit slice (10 > 5) or by budget-drop within the slice.
    //     Format (engine.ts:600): "<N> project facts for <project> (<M> shown, <K> more)"
    //     With curProject="global" (default when no project opt is passed).
    expect(out).toMatch(/\d+ project facts for global \(\d+ shown, \d+ more\)/);
  });
});
