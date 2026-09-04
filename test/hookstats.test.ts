import { describe, test, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent, readEvents, pruneEvents, eventLogPath, computeStats,
  FOLLOWUP_WINDOW_MS, EVENT_MAX_AGE_MS,
  type HookEvent,
} from "../src/hookstats.js";
import { wilson as statsWilson } from "../src/stats.js";
import { wilson as metricsWilson } from "./golden/metrics.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "qmemd-hookstats-")); });

function mkEvent(over: Partial<HookEvent> & { kind: HookEvent["kind"]; ts: string; session: string }): HookEvent {
  return { v: 1, repo: "r", ...over };
}

describe("appendEvent / readEvents round-trip", () => {
  // covers: SC-67
  test("since is inclusive of the boundary; a missing file reads as empty", () => {
    const path = eventLogPath(dir);
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    appendEvent(path, mkEvent({ kind: "pivot", ts: new Date(t0).toISOString(), session: "s1" }));
    appendEvent(path, mkEvent({ kind: "pivot", ts: new Date(t0 + 1000).toISOString(), session: "s1" }));
    appendEvent(path, mkEvent({ kind: "pivot", ts: new Date(t0 + 2000).toISOString(), session: "s1" }));

    const { events, skipped } = readEvents(path, t0 + 1000);
    expect(events.map((e) => e.ts)).toEqual([
      new Date(t0 + 1000).toISOString(),
      new Date(t0 + 2000).toISOString(),
    ]);
    expect(skipped).toBe(0);

    expect(readEvents(join(dir, "hook", "missing.jsonl"), 0)).toEqual({ events: [], skipped: 0 });
  });
});

describe("event log is fail-open (INV-4)", () => {
  // covers: SC-68
  test("appendEvent under an uncreatable directory does not throw", () => {
    const blockerFile = join(dir, "not-a-dir");
    writeFileSync(blockerFile, "x");
    const path = join(blockerFile, "hook", "events.jsonl");
    expect(() => appendEvent(path, mkEvent({ kind: "pivot", ts: new Date().toISOString(), session: "s1" }))).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  // covers: SC-68
  test("one unparsable line is skipped and counted; the valid lines still come back", () => {
    const path = eventLogPath(dir);
    mkdirSync(join(dir, "hook"), { recursive: true });
    const good1 = mkEvent({ kind: "pivot", ts: "2026-01-01T00:00:00.000Z", session: "s1" });
    const good2 = mkEvent({ kind: "probe", ts: "2026-01-01T00:00:01.000Z", session: "s1" });
    writeFileSync(path, `${JSON.stringify(good1)}\n{not valid json\n${JSON.stringify(good2)}\n`);

    const { events, skipped } = readEvents(path, 0);
    expect(events).toEqual([good1, good2]);
    expect(skipped).toBe(1);
  });

  // covers: SC-68
  test("a bad kind, a non-array slugs and an unparsable ts are skipped and counted, never fed to computeStats", () => {
    const path = eventLogPath(dir);
    mkdirSync(join(dir, "hook"), { recursive: true });
    const good = mkEvent({ kind: "overlap", ts: "2026-01-01T00:00:00.000Z", session: "s1", slugs: ["a"] });
    const lines = [
      JSON.stringify(good),
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", session: "s1", repo: "r", kind: "probe", slugs: {} }),
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:01.000Z", session: "s1", repo: "r", kind: "banana" }),
      JSON.stringify({ v: 1, ts: "not-a-timestamp", session: "s1", repo: "r", kind: "followup", slugs: ["a"] }),
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:02.000Z", session: "s1", repo: "r", kind: "followup", slugs: {} }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");

    const { events, skipped } = readEvents(path, 0);
    expect(events).toEqual([good]);
    expect(skipped).toBe(4);
    expect(() => computeStats(events, FOLLOWUP_WINDOW_MS, new Date(0))).not.toThrow();
  });
});

describe("pruneEvents", () => {
  // covers: SC-69
  test("keeps only lines within maxAgeMs of now and leaves no temp file behind", () => {
    const path = eventLogPath(dir);
    const day = 24 * 60 * 60 * 1000;
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    appendEvent(path, mkEvent({ kind: "pivot", ts: new Date(now - 31 * day).toISOString(), session: "s1" }));
    appendEvent(path, mkEvent({ kind: "pivot", ts: new Date(now - 29 * day).toISOString(), session: "s1" }));
    appendEvent(path, mkEvent({ kind: "pivot", ts: new Date(now).toISOString(), session: "s1" }));

    pruneEvents(path, EVENT_MAX_AGE_MS, now);

    const { events } = readEvents(path, 0);
    expect(events.map((e) => e.ts)).toEqual([
      new Date(now - 29 * day).toISOString(),
      new Date(now).toISOString(),
    ]);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  // covers: SC-69
  test("a missing log is a no-op", () => {
    expect(() => pruneEvents(eventLogPath(dir), EVENT_MAX_AGE_MS, Date.now())).not.toThrow();
  });
});

describe("computeStats — used vs acted", () => {
  // covers: SC-72
  test("acted counts any in-window followup; used requires slug overlap; matched requires ≥1 slug", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const overlapEv = (slugs: string[]): HookEvent =>
      mkEvent({ kind: "overlap", ts: new Date(t0).toISOString(), session: "s1", slugs });
    const followupEv = (slugs: string[] | undefined, ts: number): HookEvent =>
      mkEvent({ kind: "followup", ts: new Date(ts).toISOString(), session: "s1", slugs });

    const usedAndActed = computeStats(
      [overlapEv(["a", "b"]), followupEv(["b"], t0 + 60_000)],
      FOLLOWUP_WINDOW_MS,
      new Date(t0),
    );
    expect(usedAndActed.byKind.overlap).toEqual({ fired: 1, matched: 1, used: 1, acted: 1 });

    const actedOnlyNoOverlap = computeStats(
      [overlapEv(["a", "b"]), followupEv(["z"], t0 + 60_000)],
      FOLLOWUP_WINDOW_MS,
      new Date(t0),
    );
    expect(actedOnlyNoOverlap.byKind.overlap).toEqual({ fired: 1, matched: 1, used: 0, acted: 1 });

    const neither = computeStats([overlapEv(["a", "b"])], FOLLOWUP_WINDOW_MS, new Date(t0));
    expect(neither.byKind.overlap).toEqual({ fired: 1, matched: 1, used: 0, acted: 0 });
  });
});

describe("computeStats — session isolation and window boundary", () => {
  // covers: SC-73
  test("window is inclusive at 300000ms and exclusive at 300001ms; cross-session and pre-event followups never count", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const overlapEv: HookEvent = mkEvent({ kind: "overlap", ts: new Date(t0).toISOString(), session: "s1", slugs: ["a"] });

    const atBoundary = computeStats(
      [overlapEv, mkEvent({ kind: "followup", ts: new Date(t0 + 300_000).toISOString(), session: "s1", slugs: ["a"] })],
      FOLLOWUP_WINDOW_MS, new Date(t0),
    );
    expect(atBoundary.byKind.overlap.acted).toBe(1);
    expect(atBoundary.byKind.overlap.used).toBe(1);

    const pastBoundary = computeStats(
      [overlapEv, mkEvent({ kind: "followup", ts: new Date(t0 + 300_001).toISOString(), session: "s1", slugs: ["a"] })],
      FOLLOWUP_WINDOW_MS, new Date(t0),
    );
    expect(pastBoundary.byKind.overlap.acted).toBe(0);

    const otherSession = computeStats(
      [overlapEv, mkEvent({ kind: "followup", ts: new Date(t0 + 1000).toISOString(), session: "s2", slugs: ["a"] })],
      FOLLOWUP_WINDOW_MS, new Date(t0),
    );
    expect(otherSession.byKind.overlap.acted).toBe(0);

    const beforeEvent = computeStats(
      [overlapEv, mkEvent({ kind: "followup", ts: new Date(t0 - 1000).toISOString(), session: "s1", slugs: ["a"] })],
      FOLLOWUP_WINDOW_MS, new Date(t0),
    );
    expect(beforeEvent.byKind.overlap.acted).toBe(0);
  });
});

describe("wilson moved to src/stats.ts", () => {
  // covers: SC-74
  test("matches the golden re-export identically and still guards n=0", () => {
    expect(statsWilson).toBe(metricsWilson);
    expect(statsWilson(9, 18)).toEqual(metricsWilson(9, 18));
    expect(statsWilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});
