import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tokenizeForDedup, RECALL_BOOST_STOPLIST, listFacts, type MemoryType } from "./engine.js";

export interface FactLine {
  type: MemoryType;
  description: string;
  slug: string;
}

export interface TokenMap {
  version: 1;
  fingerprint: string;
  project: string;
  facts: Record<string, { type: MemoryType; description: string; project: string }>;
  /** token → slugs (posting list); document frequency is `tokens[t].length`. */
  tokens: Record<string, string[]>;
}

export const OVERLAP_DF_FRACTION = 0.03;
export const OVERLAP_MIN_SCORE = 2;
export const OVERLAP_MAX_HITS = 3;
export const MAP_REBUILD_EVERY_N_CALLS = 40;
/** Live descriptions run past 150 chars; unbounded lines cost tokens on a hot hook
 *  path (D-w3-3). Slug stays intact for `qmemd show`. */
export const FACT_LINE_DESC_CAP = 120;

export function mapCachePath(cacheDir: string, root: string, repo: string): string {
  const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const safeRepo = repo.replace(/[^A-Za-z0-9_-]/g, "_") || "repo";
  return join(cacheDir, "hook", `map-${rootHash}-${safeRepo}.json`);
}

function dirFingerprint(dir: string): string {
  try {
    const mtimeMs = statSync(dir).mtimeMs;
    const count = readdirSync(dir).filter(f => f.endsWith(".md")).length;
    return `${mtimeMs}:${count}`;
  } catch {
    return "0:0";
  }
}

export function corpusFingerprint(root: string): string {
  return (["project", "reference"] as const).map(t => dirFingerprint(join(root, t))).join("|");
}

const MAP_TYPES: readonly MemoryType[] = ["project", "reference"];

export function buildTokenMap(root: string, project: string): TokenMap {
  const facts: TokenMap["facts"] = {};
  const tokens: Record<string, string[]> = {};
  for (const type of MAP_TYPES) {
    for (const e of listFacts(root, { type, project })) {
      if (e.supersededBy) continue;
      const factTokens = new Set<string>(tokenizeForDedup(e.slug));
      for (const tag of e.tags) for (const t of tokenizeForDedup(tag)) factTokens.add(t);
      facts[e.slug] = { type: e.type, description: e.description, project: e.project };
      for (const t of factTokens) (tokens[t] ??= []).push(e.slug);
    }
  }
  return { version: 1, fingerprint: corpusFingerprint(root), project, facts, tokens };
}

function readCachedMap(path: string, project: string, fingerprint: string): TokenMap | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && parsed.version === 1 && parsed.project === project && parsed.fingerprint === fingerprint
        && parsed.facts && typeof parsed.facts === "object" && parsed.tokens && typeof parsed.tokens === "object") {
      return parsed as TokenMap;
    }
  } catch { /* missing or unparsable: rebuild */ }
  return null;
}

/** Rebuild throws propagate (a corpus walk failure, e.g. a type dir replaced by a
 *  regular file) — the caller (the beacon's overlap step) decides how to fail open. */
export function loadOrBuildTokenMap(path: string, root: string, project: string, force: boolean): TokenMap {
  if (!force) {
    const cached = readCachedMap(path, project, corpusFingerprint(root));
    if (cached) return cached;
  }
  const map = buildTokenMap(root, project);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, path);
  } catch { /* cache write failure: the in-memory map still renders */ }
  return map;
}

const WRAPPER_WORDS = new Set(["sudo", "rtk", "npx", "env", "time", "nice"]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function stripWrappers(command: string): string[] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (WRAPPER_WORDS.has(words[i]) || ENV_ASSIGNMENT_RE.test(words[i]))) i++;
  return words.slice(i);
}

export function isOwnSubjectCommand(command: string): boolean {
  const [first] = stripWrappers(command);
  return first === "qmemd" || first === "br";
}

export function commandTokens(command: string): string[] {
  const words = stripWrappers(command);
  if (words.length === 0 || isOwnSubjectCommand(command)) return [];
  const normalized = words.map(w => (w.includes("/") ? basename(w) : w).replace(/^-+/, ""));
  return tokenizeForDedup(normalized.join(" "));
}

export interface OverlapHit {
  slug: string;
  score: number;
  tokens: string[];
}

export function matchCommand(
  tokens: string[],
  map: TokenMap,
  exclude: ReadonlySet<string>,
  opts?: { dfFraction?: number; minScore?: number },
): OverlapHit[] {
  const factCount = Object.keys(map.facts).length;
  if (tokens.length === 0 || factCount === 0) return [];
  const dfFraction = opts?.dfFraction ?? OVERLAP_DF_FRACTION;
  const minScore = opts?.minScore ?? OVERLAP_MIN_SCORE;
  const dfCap = Math.max(3, Math.ceil(dfFraction * factCount));
  const perSlugTokens = new Map<string, Set<string>>();
  for (const t of new Set(tokens)) {
    if (RECALL_BOOST_STOPLIST.has(t)) continue;
    const slugs = map.tokens[t];
    if (!slugs || slugs.length > dfCap) continue;
    for (const slug of slugs) {
      if (exclude.has(slug)) continue;
      let set = perSlugTokens.get(slug);
      if (!set) { set = new Set(); perSlugTokens.set(slug, set); }
      set.add(t);
    }
  }
  const hits: OverlapHit[] = [];
  for (const [slug, tokSet] of perSlugTokens) {
    const score = tokSet.size;
    const hasUniqueToken = [...tokSet].some(t => map.tokens[t].length === 1);
    if (score >= minScore || hasUniqueToken) hits.push({ slug, score, tokens: [...tokSet] });
  }
  hits.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return hits.slice(0, OVERLAP_MAX_HITS);
}

export function formatFactLine(f: FactLine): string {
  const desc = f.description.length > FACT_LINE_DESC_CAP
    ? `${f.description.slice(0, FACT_LINE_DESC_CAP)}…`
    : f.description;
  return `   [${f.type}] ${desc} (${f.slug})`;
}

export function formatOverlap(repo: string, hits: OverlapHit[], map: TokenMap): string {
  const lines = [`💡 qmemd · ${repo} — facts matching this command:`];
  for (const hit of hits) {
    const fact = map.facts[hit.slug];
    lines.push(formatFactLine({ type: fact.type, description: fact.description, slug: hit.slug }));
  }
  lines.push(`   → qmemd show ${hits[0].slug} for the full fact`);
  return lines.join("\n");
}
