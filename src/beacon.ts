import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { projectOverview, formatTagHistogram, type ProjectOverview, type MemoryType } from "./engine.js";

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
}

export interface BeaconDecision {
  fire: boolean;
  terse: boolean;
  next: BeaconState;
}

/** Pure throttle decision. Pivot to a new repo always fires; within a repo, re-fire
 *  once `everyN` Bash calls have elapsed since the last beacon. `terse` = this repo's
 *  full table was already shown this session (→ render the one-line re-fire). */
export function decideBeacon(prev: BeaconState | null, repo: string, everyN: number): BeaconDecision {
  const callCount = (prev?.callCount ?? 0) + 1;
  const beaconedRepos = prev?.beaconedRepos ?? [];
  const pivot = !prev || prev.repo !== repo;
  const sinceLast = prev ? callCount - prev.lastBeaconAtCall : Infinity;
  const fire = pivot || sinceLast >= everyN;
  const alreadyBeaconed = beaconedRepos.includes(repo);
  const next: BeaconState = {
    repo,
    callCount,
    lastBeaconAtCall: fire ? callCount : (prev?.lastBeaconAtCall ?? 0),
    beaconedRepos: fire && !alreadyBeaconed ? [...beaconedRepos, repo] : beaconedRepos,
    perRepo: prev?.perRepo ?? {},
  };
  return { fire, terse: alreadyBeaconed, next };
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

/** Render the beacon text. No filesystem path (qmemd-81n) — repo name + tag shape only. */
export function formatBeacon(ov: ProjectOverview, terse: boolean): string {
  if (terse) return `💡 qmemd · ${ov.project}: ${ov.total} memories — recall before diagnosing`;
  const shape = formatTagHistogram(ov.tags) || "(untagged)";
  return [
    `💡 qmemd · ${ov.project} — ${ov.total} memories for this repo:`,
    `   ${shape}`,
    `   → recall before diagnosing, e.g.  qmemd recall "${ov.project} <topic>"`,
  ].join("\n");
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

export function writeState(path: string, state: BeaconState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path); // atomic replace
  // Opportunistic cleanup of old sessions' markers (qmemd-4y2) — best-effort, never throws.
  // Gated to every Nth call of the session (plus the first) so the hot hook path is not
  // paying a directory sweep per Bash command.
  if (state.callCount % PRUNE_EVERY_N_WRITES === 0 || state.callCount === 1) {
    pruneOldStates(dirname(path), STATE_MAX_AGE_MS, Date.now());
  }
}

export interface BeaconDeps {
  memoryRoot: string;
  cacheDir: string;
  everyN: number;
  /** test seam — defaults to projectOverview */
  overview?: (root: string, project: string, types: MemoryType[]) => ProjectOverview;
}

export interface WriteBeaconDeps {
  cacheDir: string;
  threshold: number;
}

/** Orchestrate one PreToolUse event → beacon text or null (silent). Pure of process
 *  IO except the marker file. Never throws on bad input — returns null (fail-open).
 *  Throttle decides FIRST; the corpus scan runs only on a firing call (qmemd-abi) —
 *  this path runs on every Bash PreToolUse, so throttled calls must stay scan-free. */
export function runBeacon(stdinText: string, deps: BeaconDeps): string | null {
  let evt: { tool_name?: unknown; cwd?: unknown; session_id?: unknown; tool_input?: { command?: unknown } };
  try { evt = JSON.parse(stdinText); } catch { return null; }
  if (evt?.tool_name !== "Bash") return null;
  const cwd = typeof evt.cwd === "string" ? evt.cwd : "";
  const repo = basename(cwd) || "global";
  const sessionId = typeof evt.session_id === "string" ? evt.session_id : "session";
  const path = stateFilePath(deps.cacheDir, sessionId);
  const prev = readState(path);
  const { fire, terse, next } = decideBeacon(prev, repo, deps.everyN);
  // Write-beacon accounting (qmemd-yl3): record per-repo work + captures on EVERY call,
  // independent of the read-beacon throttle, so every persist path below carries it.
  const cmd = typeof evt?.tool_input?.command === "string" ? evt.tool_input.command : "";
  const act = next.perRepo[repo] ?? { calls: 0, captures: 0, writeFired: false };
  next.perRepo = {
    ...next.perRepo,
    [repo]: { ...act, calls: act.calls + 1, captures: act.captures + (isCaptureCommand(cmd) ? 1 : 0) },
  };
  const persist = (s: BeaconState) => {
    try { writeState(path, s); } catch { /* marker-IO failure: state loss is acceptable, never block Bash */ }
  };
  if (!fire) { persist(next); return null; }
  const TYPES: MemoryType[] = ["project", "reference"]; // exclude always-on user/feedback
  const ov = (deps.overview ?? projectOverview)(deps.memoryRoot, repo, TYPES);
  if (ov.total === 0) {
    // Empty corpus: advance the throttle window (a fact-less repo scans 1/everyN, not
    // every call) but do NOT mark the repo beaconed — the first beacon after facts
    // appear must still render the full table.
    persist({ ...next, beaconedRepos: prev?.beaconedRepos ?? [] });
    return null;
  }
  persist(next);
  return formatBeacon(ov, terse);
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
