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
export const OVERLAP_SLUG_HEAD_TOKENS = 4;
export const OVERLAP_COMMAND_TOKEN_CAP = 24;
export const MAP_REBUILD_EVERY_N_CALLS = 40;
/** Live descriptions run past 150 chars; unbounded lines cost tokens on a hot hook
 *  path (D-w3-3). Slug stays intact for `qmemd show`. */
export const FACT_LINE_DESC_CAP = 120;

/** Generic shell/tool/SCM/file-type words (R-9c) — never a project name, so this list
 *  ships fixed and isn't calibrated per repo. */
export const OVERLAP_COMMAND_STOPLIST: ReadonlySet<string> = new Set([
  "grep", "head", "echo", "rtk", "sed", "git", "tail", "read", "status", "run", "null", "cat",
  "python3", "python", "node", "npm", "npx", "mvn", "mvnw", "gradle", "go", "cargo", "make",
  "task", "tasks", "diff", "tests", "log", "logs", "review", "done", "short", "commit",
  "commits", "find", "oneline", "add", "name", "error", "errors", "import", "sort", "print",
  "stat", "include", "exit", "type", "timeout", "only", "package", "src", "main", "json",
  "result", "results", "failed", "fail", "open", "report", "integration", "false", "true",
  "project", "file", "files", "sleep", "show", "design", "model", "base", "new", "full",
  "format", "lines", "line", "any", "verify", "porcelain", "class", "code", "brief", "export",
  "final", "docs", "doc", "edit", "failure", "wave", "spec", "specs", "coverage", "plan",
  "plans", "global", "version", "cd", "ls", "rm", "cp", "mv", "mkdir", "wc", "awk", "cut", "tr",
  "xargs", "curl", "jq", "kubectl", "docker", "printf", "tee", "touch", "chmod", "pwd", "env",
  "set", "unset", "which", "time", "date", "wait", "kill", "ps", "top", "less", "more", "nl",
  "paste", "comm", "uniq", "rev", "seq", "yes", "eof", "dev", "tmp", "path", "dir", "out",
  "output", "input", "list", "get", "put", "post", "delete", "update", "create", "remove",
  "check", "checks", "count", "total", "first", "last", "next", "prev", "old", "current",
  "latest", "local", "remote", "origin", "master", "push", "pull", "fetch", "clone", "branch",
  "merge", "rebase", "stash", "tag", "tags", "checkout", "reset", "revert", "init", "config",
  "blame", "bisect", "help", "usage", "debug", "info", "warn", "warning", "trace", "verbose",
  "quiet", "dry", "all", "none", "default", "the", "this", "that", "with", "from", "into", "for",
  "and", "or", "not", "via", "per", "use", "uses", "used", "using", "runs", "running", "start",
  "stop", "restart", "end", "ok", "no", "on", "off", "enable", "disable", "install", "uninstall",
  "upgrade", "cache", "data", "text", "txt", "md", "html", "xml", "yaml", "yml", "toml", "ini",
  "csv", "sh", "bash", "zsh", "js", "ts", "mjs", "cjs", "py", "rb", "rs", "java", "kt", "scala",
  "cs", "cpp", "hpp",
]);

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
      const factTokens = new Set<string>();
      for (const tag of e.tags) for (const t of tokenizeForDedup(tag)) factTokens.add(t);
      for (const t of tokenizeForDedup(e.slug).slice(0, OVERLAP_SLUG_HEAD_TOKENS)) factTokens.add(t);
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

const HEREDOC_MARKER_RE = /<<-?\s*['"]?[A-Za-z_]+/;
const SHORT_OR_DIGIT_RE = /^\d+$/;

export function commandTokens(command: string): string[] {
  const words = stripWrappers(command);
  if (words.length === 0 || isOwnSubjectCommand(command)) return [];
  const normalized = words.map(w => (w.includes("/") ? basename(w) : w).replace(/^-+/, ""));
  const joined = normalized.join(" ");
  const heredocIdx = joined.search(HEREDOC_MARKER_RE);
  const text = heredocIdx >= 0 ? joined.slice(0, heredocIdx) : joined;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const t of tokenizeForDedup(text)) {
    if (t.length < 3 || SHORT_OR_DIGIT_RE.test(t) || seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
    if (kept.length === OVERLAP_COMMAND_TOKEN_CAP) break;
  }
  return kept;
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
    if (RECALL_BOOST_STOPLIST.has(t) || OVERLAP_COMMAND_STOPLIST.has(t)) continue;
    if (!Object.hasOwn(map.tokens, t)) continue;
    const slugs = map.tokens[t];
    if (slugs.length > dfCap) continue;
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
    if (score >= minScore) hits.push({ slug, score, tokens: [...tokSet] });
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
