import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { listFacts, tagHistogram, formatTagHistogram, type ListEntry, type MemoryType } from "./engine.js";
import {
  loadOrBuildTokenMap, mapCachePath, commandTokens, isOwnSubjectCommand, matchCommand,
  formatOverlap, formatFactLine, MAP_REBUILD_EVERY_N_CALLS, type FactLine,
} from "./overlap.js";
import { appendEvent, eventLogPath, pruneEvents, EVENT_MAX_AGE_MS, type HookEvent } from "./hookstats.js";

export interface RepoActivity {
  calls: number;       // Bash calls in this repo this session
  captures: number;    // Bash-observed captures in this repo (both lanes)
  writeFired: boolean; // once-per-repo latch for the write nudge
}

export interface BeaconState {
  repo: string;
  callCount: number;
  lastBeaconAtCall: number;
  beaconedRepos: string[];
  perRepo: Record<string, RepoActivity>; // write beacon, keyed by basename(cwd)
  /** Slugs already shown this session by the beacon or the probe — never shown twice. */
  surfacedSlugs: string[];
  probedKeys: string[];
  /** Call count of the last forced token-map build, per repo — the map cache is per repo,
   *  so one scalar would let a pivot in repo B postpone repo A's insurance rebuild. */
  mapBuiltAtCall: Record<string, number>;
}

/** Cap on surfacedSlugs and probedKeys: oldest entries drop out first. */
export const SURFACED_CAP = 200;

export interface BeaconDecision {
  fire: boolean;
  next: BeaconState;
}

/** Pure pivot decision: the first Bash call in a repo fires, and nothing else does.
 *  There is no call-count re-fire — a repo already in `beaconedRepos` stays silent for
 *  the rest of the session, including after a pivot away and back. */
export function decideBeacon(prev: BeaconState | null, repo: string): BeaconDecision {
  const callCount = (prev?.callCount ?? 0) + 1;
  const beaconedRepos = prev?.beaconedRepos ?? [];
  const fire = !beaconedRepos.includes(repo);
  const next: BeaconState = {
    repo,
    callCount,
    lastBeaconAtCall: fire ? callCount : (prev?.lastBeaconAtCall ?? 0),
    beaconedRepos: fire ? [...beaconedRepos, repo] : beaconedRepos,
    perRepo: prev?.perRepo ?? {},
    surfacedSlugs: prev?.surfacedSlugs ?? [],
    probedKeys: prev?.probedKeys ?? [],
    mapBuiltAtCall: prev?.mapBuiltAtCall ?? {},
  };
  return { fire, next };
}

export interface WriteBeaconDecision {
  fire: boolean;
  next: BeaconState | null;
}

/** Pure write-beacon decision (qmemd-yl3), operating on `state.perRepo[repo]`. Fires once
 *  per repo per session when the repo did real work (calls ≥ threshold) and captured nothing
 *  in either lane. Latches `writeFired` on fire; returns `state` unchanged otherwise. */
export function decideWriteBeacon(state: BeaconState | null, repo: string, threshold: number): WriteBeaconDecision {
  const act = state?.perRepo?.[repo] ?? { calls: 0, captures: 0, writeFired: false };
  const fire = act.calls >= threshold && act.captures === 0 && !act.writeFired;
  if (!fire || !state) return { fire: false, next: state };
  return {
    fire: true,
    next: { ...state, perRepo: { ...state.perRepo, [repo]: { ...act, writeFired: true } } },
  };
}

/** Append `slugs` to the session's surfaced set (INV-7): duplicates are never re-added and
 *  the set is capped at SURFACED_CAP, oldest out. Shared with the probe. */
export function rememberSurfaced(state: BeaconState, slugs: string[]): BeaconState {
  const merged = [...state.surfacedSlugs];
  for (const slug of slugs) if (!merged.includes(slug)) merged.push(slug);
  return { ...state, surfacedSlugs: merged.slice(-SURFACED_CAP) };
}

/** Pivot histogram cap: top-N tags on the repo line; the full shape stays on demand via
 *  `qmemd tags`. Keeps a repo pivot bounded (a mixed dump measured ~200 tags ≈ 1.4k tokens). */
const BEACON_TAG_CAP = 12;

/** Repo facts listed one line each up to this count; above it, the tag histogram. */
export const PIVOT_LIST_MAX = 10;

export interface PivotOverview {
  project: string;
  repo: { total: number; tags: { tag: string; count: number }[]; facts: FactLine[] };
  global: { total: number };
}

const PIVOT_TYPES: readonly MemoryType[] = ["project", "reference"]; // user/feedback are always injected

/** Model-free in-scope overview for the pivot block: project+reference facts for this repo
 *  plus global, split repo vs global. Filesystem only — safe on the Bash hot path. */
export function pivotOverview(root: string, repo: string): PivotOverview {
  const entries: ListEntry[] = [];
  for (const type of PIVOT_TYPES) entries.push(...listFacts(root, { type, project: repo }));
  const repoEntries = entries.filter(e => e.project !== "global");
  return {
    project: repo,
    repo: {
      total: repoEntries.length,
      tags: tagHistogram(repoEntries.map(e => e.tags)),
      facts: repoEntries
        .map(e => ({ type: e.type, description: e.description, slug: e.slug }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    },
    global: { total: entries.length - repoEntries.length },
  };
}

function repoTagLine(tags: { tag: string; count: number }[]): string {
  const shown = formatTagHistogram(tags.slice(0, BEACON_TAG_CAP)) || "(untagged)";
  const hidden = tags.length - BEACON_TAG_CAP;
  return `   repo: ${shown}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
}

/** Render the once-per-repo pivot block. No filesystem path (qmemd-81n) — repo name, the
 *  in-scope counts, and either the fact list or the repo tag shape. No global tag line: the
 *  global corpus is the same in every repo and reads as noise on a pivot. */
export function formatPivot(ov: PivotOverview): string {
  const lines = [`💡 qmemd · ${ov.project} — ${ov.repo.total} repo + ${ov.global.total} global memories`];
  if (ov.repo.total > PIVOT_LIST_MAX) lines.push(repoTagLine(ov.repo.tags));
  else for (const f of ov.repo.facts.slice(0, PIVOT_LIST_MAX)) lines.push(formatFactLine(f));
  lines.push(`   → qmemd recall "${ov.project} <topic>" before diagnosing`);
  return lines.join("\n");
}

/** Render the write-beacon line (qmemd-yl3). No filesystem path (qmemd-81n) — repo + count
 *  only, with a lane-routing tail so the nudge does not push beads content into qmemd. */
export function formatWriteBeacon(repo: string, calls: number): string {
  return [
    `💡 qmemd · ${repo}: ${calls} Bash calls, 0 durable captures in this repo this session —`,
    `   remember any gotcha/decision/preference before you wrap?  (durable → qmemd, work-state → br)`,
  ].join("\n");
}

// Capture verbs across both lanes (qmemd-yl3). Word-boundary anchored so an rtk/env
// prefix ("rtk br close …") still matches and prose ("remember to …") does not.
const CAPTURE_RE = /\bqmemd\s+(remember|reviewed)\b|\bbr\s+(create|close|update|q)\b/;

/** True iff `cmd` invokes a durable-capture verb (qmemd remember/reviewed or
 *  br create/close/update/q). Pure; used by the write beacon's per-repo counter. */
export function isCaptureCommand(cmd: string): boolean {
  return CAPTURE_RE.test(cmd);
}

export type Followup = { kind: "recall"; query: string } | { kind: "show"; slugs: string[] };

// `qmemd` must be the command word — at the start or right after a shell connective, past any
// env assignments and the wrapper words stripWrappers knows. Unanchored, `echo qmemd show s`
// and `grep "qmemd recall" notes.md` counted as followups and inflated acted/used.
const FOLLOWUP_RE = /(?:^|[;&|])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|rtk|npx|env|time|nice)\s+)*qmemd\s+(recall|show|get)\s+/;
// The recall flags that take a value: their argument is not the query.
const VALUE_FLAGS = new Set(["--type", "--platform", "--limit", "--min-score"]);

function firstBareArg(rest: string): string | null {
  const args = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = args.exec(rest)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    const value = m[1] ?? m[2] ?? m[3];
    if (quoted || !value.startsWith("-")) return value;
    if (value === "--session") return null; // the session snapshot carries no query
    if (VALUE_FLAGS.has(value)) args.exec(rest);
  }
  return null;
}

/** Classify a Bash command as a read of qmemd memory — the "did the nudge land" signal
 *  (§3.5). Write verbs (remember/forget/…) are not followups. */
export function followupOf(command: string): Followup | null {
  const m = FOLLOWUP_RE.exec(command);
  if (!m) return null;
  const arg = firstBareArg(command.slice(m.index + m[0].length));
  if (arg === null) return null;
  return m[1] === "recall" ? { kind: "recall", query: arg } : { kind: "show", slugs: [arg] };
}

/** Stable short id for a command, so an event line carries no command text (INV-5). */
export function commandHash(command: string): string {
  return createHash("sha1").update(command).digest("hex").slice(0, 12);
}

export function stateFilePath(cacheDir: string, sessionId: string): string {
  // sessionId is hook-controlled and flows into a filename — collapse to one safe
  // segment so it cannot traverse out of the hook dir (qmemd-fd8 spirit).
  const safe = (sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session").slice(0, 80);
  return join(cacheDir, "hook", `${safe}.json`);
}

export function readState(path: string): BeaconState | null {
  try {
    if (!existsSync(path)) return null;
    const s = JSON.parse(readFileSync(path, "utf-8"));
    if (s && typeof s.repo === "string" && typeof s.callCount === "number"
        && typeof s.lastBeaconAtCall === "number" && Array.isArray(s.beaconedRepos)) {
      if (s.perRepo == null) s.perRepo = {};
      else if (typeof s.perRepo !== "object" || Array.isArray(s.perRepo)) return null;
      // A marker written before this feature carries none of the three below; defaulting
      // them (rather than rejecting) keeps an in-flight session's pivot state (SC-58).
      if (!Array.isArray(s.surfacedSlugs)) s.surfacedSlugs = [];
      if (!Array.isArray(s.probedKeys)) s.probedKeys = [];
      // Pre-feature markers carry no field; markers from the scalar shape carry a number.
      if (typeof s.mapBuiltAtCall !== "object" || s.mapBuiltAtCall === null || Array.isArray(s.mapBuiltAtCall)) s.mapBuiltAtCall = {};
      return s;
    }
    return null;
  } catch { return null; }
}

const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Best-effort prune of stale per-session marker files (qmemd-4y2): one ~/.cache/qmemd/hook/
 *  <session>.json is written per session and nothing else deletes them. Removes hook-dir *.json
 *  whose mtime is older than maxAgeMs. Fail-open per entry AND overall — this runs on the Bash
 *  PreToolUse path, so it must never throw. `now` is injected for tests (no wall-clock coupling). */
export function pruneOldStates(hookDir: string, maxAgeMs: number, now: number): void {
  let names: string[];
  try { names = readdirSync(hookDir); } catch { return; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const p = join(hookDir, f);
    try { if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p); } catch { /* skip this entry */ }
  }
}

/** Prune cadence: writeState runs on EVERY Bash PreToolUse, but the readdir+stat sweep
 *  only needs to run occasionally — stale markers age in days, not calls (qp-nq2). */
const PRUNE_EVERY_N_WRITES = 20;

export function writeState(path: string, state: BeaconState, eventsPath?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path); // atomic replace
  // Opportunistic cleanup of old sessions' markers (qmemd-4y2) and event lines — best-effort,
  // never throws. Gated to every Nth call of the session (plus the first) so the hot hook path
  // is not paying a directory sweep or a log rewrite per Bash command.
  if (state.callCount % PRUNE_EVERY_N_WRITES === 0 || state.callCount === 1) {
    const now = Date.now();
    pruneOldStates(dirname(path), STATE_MAX_AGE_MS, now);
    if (eventsPath) pruneEvents(eventsPath, EVENT_MAX_AGE_MS, now);
  }
}

export interface BeaconDeps {
  memoryRoot: string;
  cacheDir: string;
  /** test seam — defaults to pivotOverview */
  overview?: (root: string, repo: string) => PivotOverview;
  /** test seam for the event timestamp */
  now?: () => Date;
}

export interface WriteBeaconDeps {
  cacheDir: string;
  threshold: number;
}

/** Orchestrate one PreToolUse event → beacon text or null (silent). Pure of process IO except
 *  the marker, the map cache, and the event log. Never throws on bad input — returns null
 *  (fail-open, INV-4). Two blocks can print on one call: the once-per-repo pivot and the
 *  content overlap, joined by a blank line. */
export function runBeacon(stdinText: string, deps: BeaconDeps): string | null {
  let evt: { tool_name?: unknown; cwd?: unknown; session_id?: unknown; tool_input?: { command?: unknown } };
  try { evt = JSON.parse(stdinText); } catch { return null; }
  if (evt?.tool_name !== "Bash") return null;
  const cwd = typeof evt.cwd === "string" ? evt.cwd : "";
  const repo = basename(cwd) || "global";
  const sessionId = typeof evt.session_id === "string" ? evt.session_id : "session";
  const path = stateFilePath(deps.cacheDir, sessionId);
  const prev = readState(path);
  const { fire, next } = decideBeacon(prev, repo);
  // Write-beacon accounting (qmemd-yl3): record per-repo work + captures on EVERY call,
  // independent of the pivot latch, so the Stop hook can read it.
  const cmd = typeof evt?.tool_input?.command === "string" ? evt.tool_input.command : "";
  const act = next.perRepo[repo] ?? { calls: 0, captures: 0, writeFired: false };
  let state: BeaconState = {
    ...next,
    perRepo: {
      ...next.perRepo,
      [repo]: { ...act, calls: act.calls + 1, captures: act.captures + (isCaptureCommand(cmd) ? 1 : 0) },
    },
  };

  const eventsPath = eventLogPath(deps.cacheDir);
  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const log = (ev: Omit<HookEvent, "v" | "ts" | "session" | "repo">) =>
    appendEvent(eventsPath, { v: 1, ts, session: sessionId, repo, ...ev });

  const blocks: string[] = [];
  let pivoted = false;
  if (fire) {
    let ov: PivotOverview | null;
    try { ov = (deps.overview ?? pivotOverview)(deps.memoryRoot, repo); } catch { ov = null; }
    if (!ov || ov.repo.total + ov.global.total === 0) {
      // Fact-less repo (or an unreadable corpus): stay silent and do NOT mark the repo, so the
      // first pivot after facts appear still renders.
      state = { ...state, beaconedRepos: prev?.beaconedRepos ?? [] };
    } else {
      pivoted = true;
      blocks.push(formatPivot(ov));
      // A fact the agent has just seen listed counts as surfaced (D-w3-6): the overlap block
      // on this and later calls excludes it.
      const listed = ov.repo.total <= PIVOT_LIST_MAX ? ov.repo.facts.slice(0, PIVOT_LIST_MAX).map(f => f.slug) : [];
      if (listed.length > 0) state = rememberSurfaced(state, listed);
      log({ kind: "pivot", ...(listed.length > 0 ? { slugs: listed } : {}) });
    }
  }

  const followup = followupOf(cmd);
  if (followup) {
    log(followup.kind === "recall" ? { kind: "followup", query: followup.query } : { kind: "followup", slugs: followup.slugs });
  } else if (!isOwnSubjectCommand(cmd)) {
    try {
      const tokens = commandTokens(cmd);
      if (tokens.length > 0) {
        const mapPath = mapCachePath(deps.cacheDir, deps.memoryRoot, repo);
        const builtAt = state.mapBuiltAtCall[repo];
        const force = pivoted || builtAt === undefined || state.callCount - builtAt >= MAP_REBUILD_EVERY_N_CALLS;
        const map = loadOrBuildTokenMap(mapPath, deps.memoryRoot, repo, force);
        // Only a forced build resets the cadence (R-3): loadOrBuildTokenMap reports no rebuild
        // flag, so a fingerprint-driven one costs at most one redundant force within 40 calls.
        if (force) state = { ...state, mapBuiltAtCall: { ...state.mapBuiltAtCall, [repo]: state.callCount } };
        const hits = matchCommand(tokens, map, new Set(state.surfacedSlugs));
        if (hits.length > 0) {
          const slugs = hits.map(h => h.slug);
          blocks.push(formatOverlap(repo, hits, map));
          state = rememberSurfaced(state, slugs);
          log({ kind: "overlap", slugs, cmdHash: commandHash(cmd) });
        }
      }
    } catch { /* a corpus-walk failure costs the overlap block only — the pivot still prints (SC-50) */ }
  }

  try { writeState(path, state, eventsPath); } catch { /* marker-IO failure: state loss is acceptable, never block Bash */ }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** Orchestrate one Stop event → write-beacon text or null (silent). Reads the shared
 *  per-session marker, decides per-repo, persists the latch, renders on fire. Never throws
 *  on bad input (fail-open → null). No model, no corpus scan. The Stop event carries no
 *  tool_name, so there is no Bash filter here (unlike runBeacon). */
export function runWriteBeacon(stdinText: string, deps: WriteBeaconDeps): string | null {
  let evt: { cwd?: unknown; session_id?: unknown };
  try { evt = JSON.parse(stdinText); } catch { return null; }
  const cwd = typeof evt?.cwd === "string" ? evt.cwd : "";
  const repo = basename(cwd) || "global";
  const sessionId = typeof evt?.session_id === "string" ? evt.session_id : "session";
  const path = stateFilePath(deps.cacheDir, sessionId);
  const state = readState(path);
  const { fire, next } = decideWriteBeacon(state, repo, deps.threshold);
  if (next) {
    try { writeState(path, next); } catch { /* marker-IO failure: never block the turn */ }
  }
  if (!fire) return null;
  return formatWriteBeacon(repo, next!.perRepo[repo].calls);
}
