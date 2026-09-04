import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wilson } from "./stats.js";

export type HookEventKind = "pivot" | "overlap" | "probe" | "followup";

export interface HookEvent {
  v: 1;
  ts: string;
  session: string;
  repo: string;
  kind: HookEventKind;
  cmdHash?: string;
  slugs?: string[];
  query?: string;
  score?: number;
}

export function eventLogPath(cacheDir: string): string {
  return join(cacheDir, "hook", "events.jsonl");
}

export function appendEvent(path: string, ev: HookEvent): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(ev) + "\n");
  } catch {
    /* event log is best-effort; never blocks the hook path (INV-4) */
  }
}

const EVENT_KINDS: readonly string[] = ["pivot", "overlap", "probe", "followup"];

const isString = (v: unknown): boolean => typeof v === "string";
const isOptional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);

/** Full shape check: computeStats reads `kind` and `slugs` without re-checking them, so a
 *  record that parses as JSON but carries the wrong types must be dropped here, not there. */
function isValidEvent(e: Record<string, unknown>): boolean {
  return e.v === 1
    && isString(e.session)
    && isString(e.kind) && EVENT_KINDS.includes(e.kind as string)
    && isString(e.ts) && Number.isFinite(Date.parse(e.ts as string))
    && isOptional(e.repo, isString)
    && isOptional(e.slugs, (v) => Array.isArray(v) && v.every(isString))
    && isOptional(e.query, isString)
    && isOptional(e.cmdHash, isString);
}

function parseEventLine(line: string): HookEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const e = obj as Record<string, unknown>;
  return isValidEvent(e) ? (e as unknown as HookEvent) : null;
}

export function readEvents(path: string, sinceMs: number): { events: HookEvent[]; skipped: number } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { events: [], skipped: 0 };
  }
  const events: HookEvent[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const ev = parseEventLine(line);
    if (!ev) {
      skipped++;
      continue;
    }
    if (Date.parse(ev.ts) >= sinceMs) events.push(ev);
  }
  return { events, skipped };
}

export function pruneEvents(path: string, maxAgeMs: number, now: number): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const ev = parseEventLine(line);
      if (!ev) continue;
      const ms = Date.parse(ev.ts);
      if (!Number.isNaN(ms) && now - ms <= maxAgeMs) kept.push(line);
    }
    writeFileSync(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "");
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

export interface KindStats {
  fired: number;
  matched: number;
  used: number;
  acted: number;
}

export type StatKind = "pivot" | "overlap" | "probe";

export interface HookStats {
  since: string;
  byKind: Record<StatKind, KindStats>;
  skipped: number;
}

export const FOLLOWUP_WINDOW_MS = 300_000;
export const EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const STAT_KINDS: StatKind[] = ["pivot", "overlap", "probe"];

export function computeStats(events: HookEvent[], windowMs: number, since: Date): HookStats {
  const followups = events.filter((e) => e.kind === "followup");
  const byKind: Record<StatKind, KindStats> = {
    pivot: { fired: 0, matched: 0, used: 0, acted: 0 },
    overlap: { fired: 0, matched: 0, used: 0, acted: 0 },
    probe: { fired: 0, matched: 0, used: 0, acted: 0 },
  };
  for (const ev of events) {
    if (ev.kind !== "pivot" && ev.kind !== "overlap" && ev.kind !== "probe") continue;
    const stat = byKind[ev.kind];
    stat.fired++;
    const slugs = ev.slugs ?? [];
    const matched = slugs.length >= 1;
    if (matched) stat.matched++;
    const evTs = Date.parse(ev.ts);
    const inWindow = followups.filter((f) => {
      if (f.session !== ev.session) return false;
      const delta = Date.parse(f.ts) - evTs;
      return delta >= 0 && delta <= windowMs;
    });
    if (inWindow.length > 0) stat.acted++;
    if (matched && inWindow.some((f) => (f.slugs ?? []).some((s) => slugs.includes(s)))) stat.used++;
  }
  return { since: since.toISOString(), byKind, skipped: 0 };
}

function fmtRatio(successes: number, n: number): string {
  const { lo, hi } = wilson(successes, n);
  const p = n === 0 ? "0/0" : (successes / n).toFixed(2);
  return `${p} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
}

export function formatStats(stats: HookStats): string {
  const lines = STAT_KINDS.map((kind) => {
    const s = stats.byKind[kind];
    return `${kind} fired ${s.fired} matched ${s.matched} used ${s.used} acted ${s.acted}` +
      `  used/matched ${fmtRatio(s.used, s.matched)}  acted/fired ${fmtRatio(s.acted, s.fired)}`;
  });
  if (stats.skipped > 0) lines.push(`${stats.skipped} unparsable lines skipped`);
  return lines.join("\n");
}
