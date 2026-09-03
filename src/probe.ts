import { basename } from "node:path";
import { createHash } from "node:crypto";
import type { QMDStore } from "@tobilu/qmd";
import { tokenizeForDedup, recallQueryWithStatus, type MemoryType, type RecallHit } from "./engine.js";
import { stripWrappers, isOwnSubjectCommand, formatFactLine, type FactLine } from "./overlap.js";
import { appendEvent, eventLogPath } from "./hookstats.js";
import {
  readState, writeState, stateFilePath, rememberSurfaced, SURFACED_CAP, type BeaconState,
} from "./beacon.js";

/** A failed Bash call is on the agent's critical path: the store open + lex search is
 *  raced against this and abandoned rather than delaying the failure report. */
export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_MAX_TOKENS = 8;
export const PROBE_ERROR_LINE_CAP = 200;

/** Hits kept after the surfaced filter — the same ceiling as the overlap block. */
const PROBE_MAX_HITS = 3;

const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const EXIT_CODE_HEADER_RE = /^Exit code \d+\s*$/;
const HEX_BLOB_RE = /^[0-9a-f]{7,}$/;
const BARE_NUMBER_RE = /^\d+$/;

/** The two words that identify what failed: the tool and its subcommand. `run` is a
 *  connective, not a subject, so `npm run build` heads on `npm`, `build`. */
export function headTokens(command: string): string[] {
  const words = stripWrappers(command);
  const subject = SCRIPT_RUNNERS.has(words[0]) && words[1] === "run"
    ? [words[0], ...words.slice(2)]
    : words;
  return subject.slice(0, 2);
}

/** The one line of a failure payload worth searching on: Claude Code prefixes Bash
 *  failures with `Exit code N`, and a payload from a shell that never started carries
 *  none. Empty when the header is all there is. */
export function errorLine(error: string): string {
  const lines = error.split("\n");
  if (EXIT_CODE_HEADER_RE.test(lines[0] ?? "")) lines.shift();
  const first = lines.find(l => l.trim() !== "")?.trim() ?? "";
  return first.slice(0, PROBE_ERROR_LINE_CAP);
}

export function buildProbeQuery(command: string, error: string): string[] {
  // Path-bearing words go BEFORE tokenization (R-14): the tokenizer splits on `/`, so a
  // later per-token test can never recognize `src/api/user.ts` as one path.
  const words = [...headTokens(command), ...errorLine(error).split(/\s+/)]
    .filter(w => w !== "" && !w.includes("/"));
  const tokens: string[] = [];
  for (const t of tokenizeForDedup(words.join(" "))) {
    // A hash or a line number is unique to this one failure: it can only dilute a BM25
    // query over a corpus of durable facts.
    if (HEX_BLOB_RE.test(t) || BARE_NUMBER_RE.test(t)) continue;
    if (tokens.includes(t)) continue;
    tokens.push(t);
    if (tokens.length === PROBE_MAX_TOKENS) break;
  }
  return tokens;
}

/** Session-scoped identity of a failure: the same command failing the same way twice
 *  probes once (INV-7's probe half). */
export function probeKey(head: string[], line: string): string {
  return createHash("sha1").update(`${head.join(" ")}\n${line}`).digest("hex").slice(0, 12);
}

export function formatProbe(repo: string, hits: FactLine[]): string {
  const lines = [`💡 qmemd · ${repo} — this failure may be documented:`];
  for (const f of hits) lines.push(formatFactLine(f));
  lines.push(`   → qmemd show ${hits[0].slug} for the full fact`);
  return lines.join("\n");
}

export interface ProbeDeps {
  memoryRoot: string;
  cacheDir: string;
  openStore: () => Promise<QMDStore>;
  /** test seam — defaults to recallQueryWithStatus */
  recall?: typeof recallQueryWithStatus;
  timeoutMs?: number;
  /** test seam for the event timestamp */
  now?: () => Date;
}

const freshState = (repo: string): BeaconState => ({
  repo, callCount: 0, lastBeaconAtCall: 0, beaconedRepos: [], perRepo: {},
  surfacedSlugs: [], probedKeys: [], mapBuiltAtCall: 0,
});

/** Orchestrate one PostToolUseFailure event → probe text or null (silent). The only hook
 *  path that opens the store, and it opens it lex-only (no model) and only once every skip
 *  check has passed. Never throws on bad input or a store failure — returns null
 *  (fail-open, INV-4). The hit's filesystem path never leaves this function (INV-5). */
export async function runProbe(stdinText: string, deps: ProbeDeps): Promise<string | null> {
  // One fail-open boundary around the whole body (INV-4): every throw — a bad payload, a
  // store failure, a marker write, the clock seam, the render — resolves null.
  try {
    let evt: {
      tool_name?: unknown; cwd?: unknown; session_id?: unknown; error?: unknown;
      is_interrupt?: unknown; tool_input?: { command?: unknown };
    };
    try { evt = JSON.parse(stdinText); } catch { return null; }
    if (evt?.tool_name !== "Bash") return null;
    if (evt.is_interrupt === true) return null;
    const error = typeof evt.error === "string" ? evt.error : "";
    if (error.trim() === "") return null;
    const cmd = typeof evt?.tool_input?.command === "string" ? evt.tool_input.command : "";
    if (isOwnSubjectCommand(cmd)) return null;
    const tokens = buildProbeQuery(cmd, error);
    if (tokens.length === 0) return null;

    const key = probeKey(headTokens(cmd), errorLine(error));
    const repo = basename(typeof evt.cwd === "string" ? evt.cwd : "") || "global";
    const sessionId = typeof evt.session_id === "string" ? evt.session_id : "session";
    const statePath = stateFilePath(deps.cacheDir, sessionId);
    const prev = readState(statePath) ?? freshState(repo);
    if (prev.probedKeys.includes(key)) return null;

    const query = tokens.join(" ");
    const recall = deps.recall ?? recallQueryWithStatus;
    const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
    let store: QMDStore | null = null;
    let timedOut = false;
    let searched = false;
    let kept: RecallHit[] = [];
    try {
      store = await deps.openStore();
      searched = true; // an invoked search counts as run however it ends (R-13)
      let timer: ReturnType<typeof setTimeout> | undefined;
      const search = recall(store, deps.memoryRoot, query, {
        lexOnly: true, skim: true, limit: PROBE_MAX_HITS + prev.surfacedSlugs.length, project: repo,
      }).then(r => r.hits);
      const raced = await Promise.race([
        search,
        new Promise<null>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs); }),
      ]).finally(() => clearTimeout(timer));

      const surfaced = new Set(prev.surfacedSlugs);
      kept = (raced ?? []).filter(h => !surfaced.has(h.slug)).slice(0, PROBE_MAX_HITS);
    } catch {
      // A rejected search must still throttle: without the key below, the same failing
      // command re-opens the store on every repeat.
    } finally {
      if (store) {
        // On the timeout path the close waits on the abandoned query, so it is left to
        // outlive the returned null rather than re-delaying the failure report.
        try {
          const closing = Promise.resolve(store.close()).catch(() => { /* a close failure loses nothing */ });
          if (!timedOut) await closing;
        } catch { /* a synchronous close failure loses nothing either */ }
      }
    }

    if (!searched) return null;
    const slugs = kept.map(h => h.slug);
    let state: BeaconState = { ...prev, probedKeys: [...prev.probedKeys, key].slice(-SURFACED_CAP) };
    if (slugs.length > 0) state = rememberSurfaced(state, slugs);
    try { writeState(statePath, state); } catch { /* marker-IO failure: a repeat probe is cheaper than a throw */ }
    appendEvent(eventLogPath(deps.cacheDir), {
      v: 1, ts: (deps.now ?? (() => new Date()))().toISOString(), session: sessionId, repo,
      kind: "probe", query, ...(slugs.length > 0 ? { slugs } : {}),
    });

    if (kept.length === 0) return null;
    return formatProbe(repo, kept.map(h => ({ type: h.type as MemoryType, description: h.description, slug: h.slug })));
  } catch {
    return null;
  }
}
