import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import {
  walkFactFiles,
  parseMemory,
  locateFences,
  yamlScalar,
  memoryFilePath,
  assertSafeSlug,
  syncOutcome,
  reindexMemory,
  ClientError,
  type MemoryType,
} from "./engine.js";
import { gitCommit, gitPush, type GitDeps } from "./git.js";
import type { QMDStore } from "@tobilu/qmd";

export type RescopeReason = "slug-prefix" | "tag" | "alias";

export interface RescopeRow {
  slug: string;
  type: MemoryType;
  from: string;
  to: string;
  reason: RescopeReason;
}

export interface RescopePlan {
  known: string[];
  rows: RescopeRow[];
  unmatched: number;
  version: 1;
}

export interface RescopeOptions {
  known?: string[];
  aliases?: Record<string, string>;
}

const ROW_TYPES: readonly MemoryType[] = ["project", "reference"];

function isGlobalOrBlank(v: string): boolean {
  const t = v.trim();
  return t === "" || t.toLowerCase() === "global";
}

function sortKnown(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function matchesSlugPrefix(slug: string, known: string): boolean {
  const s = slug.toLowerCase();
  const k = known.toLowerCase();
  return s === k || s.startsWith(`${k}-`);
}

export function planRescope(root: string, opts: RescopeOptions = {}): RescopePlan {
  const aliases = opts.aliases ?? {};
  const aliasBySourceLower = new Map<string, string>();
  for (const [source, target] of Object.entries(aliases)) {
    aliasBySourceLower.set(source.toLowerCase(), target);
  }

  const knownBySpellingLower = new Map<string, string>();
  const addKnown = (name: string): void => {
    if (isGlobalOrBlank(name)) return;
    const key = name.toLowerCase();
    if (!knownBySpellingLower.has(key)) knownBySpellingLower.set(key, name);
  };

  for (const ff of walkFactFiles(root)) {
    let parsed;
    try { parsed = parseMemory(ff.raw); } catch { continue; }
    addKnown(parsed.frontmatter.project);
  }
  for (const name of opts.known ?? []) addKnown(name);
  for (const target of Object.values(aliases)) addKnown(target);

  const known = sortKnown(knownBySpellingLower.values());
  const resolveAlias = (name: string): string => aliasBySourceLower.get(name.toLowerCase()) ?? name;

  const rows: RescopeRow[] = [];
  let unmatched = 0;

  for (const ff of walkFactFiles(root, { types: ROW_TYPES })) {
    let parsed;
    try { parsed = parseMemory(ff.raw); } catch { continue; }
    const fm = parsed.frontmatter;
    const isGlobal = isGlobalOrBlank(fm.project);

    let to: string | undefined;
    let reason: RescopeReason | undefined;

    const aliasTarget = aliasBySourceLower.get(fm.project.toLowerCase());
    if (aliasTarget !== undefined) {
      to = aliasTarget;
      reason = "alias";
    } else if (isGlobal) {
      const slugMatch = known.find((k) => matchesSlugPrefix(ff.slug, k));
      if (slugMatch !== undefined) {
        to = resolveAlias(slugMatch);
        reason = "slug-prefix";
      } else {
        const tagMatch = known.find((k) => fm.tags.some((tag) => tag.toLowerCase() === k.toLowerCase()));
        if (tagMatch !== undefined) {
          to = resolveAlias(tagMatch);
          reason = "tag";
        }
      }
    }

    if (to !== undefined && reason !== undefined && !isGlobalOrBlank(to)) {
      rows.push({ slug: ff.slug, type: ff.type, from: fm.project, to, reason });
    } else if (isGlobal) {
      unmatched++;
    }
  }

  return { known, rows, unmatched, version: 1 };
}

const PROJECT_LINE_RE = /^(project[ \t]*:[ \t]*)(.*?)(\r?)$/i;
const TYPE_LINE_RE = /^type\s*:/i;

export function setProjectLine(content: string, value: string): string {
  const fences = locateFences(content);
  if (!fences) return content;
  const { open, close } = fences;
  const lines = content.split("\n");
  for (let i = open + 1; i < close; i++) {
    const m = PROJECT_LINE_RE.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[3]}`;
      return lines.join("\n");
    }
  }
  let insertAt = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (TYPE_LINE_RE.test(lines[i]!)) { insertAt = i + 1; break; }
  }
  // Inherit the neighbour's terminator: an LF-only insert into a CRLF file leaves mixed
  // line endings that no reader round-trips cleanly.
  const eol = lines[insertAt - 1]!.endsWith("\r") ? "\r" : "";
  lines.splice(insertAt, 0, `project: ${value}${eol}`);
  return lines.join("\n");
}

const RESCOPE_REASONS: readonly RescopeReason[] = ["slug-prefix", "tag", "alias"];

function isRescopeRow(v: unknown): v is RescopeRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.slug === "string" &&
    typeof r.type === "string" &&
    typeof r.from === "string" &&
    typeof r.to === "string" &&
    typeof r.reason === "string" && (RESCOPE_REASONS as string[]).includes(r.reason)
  );
}

export function isRescopePlan(v: unknown): v is RescopePlan {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    Array.isArray(p.known) && p.known.every((k) => typeof k === "string") &&
    Array.isArray(p.rows) && p.rows.every(isRescopeRow) &&
    typeof p.unmatched === "number"
  );
}

export interface RescopeApplyResult {
  applied: number;
  rejected: RescopeRow[];
  synced: boolean;
  syncWarning?: string;
  indexed: boolean;
}

interface StagedWrite {
  row: RescopeRow;
  path: string;
  raw: string;
  tmp: string;
}

function errorCode(e: unknown, fallback = "error"): string {
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return fallback;
}

function removeTemps(entries: readonly StagedWrite[]): void {
  for (const e of entries) {
    try { unlinkSync(e.tmp); } catch { /* best-effort: a temp that was never created is fine */ }
  }
}

/**
 * Put every already-renamed file back, temp-then-rename so a failing restore can never
 * truncate a fact in place. Every file is attempted even after one fails. Returns the error
 * to throw: the original phase-2 failure when the corpus is whole again, otherwise one that
 * names the facts left rescoped on disk (never absolute paths) and carries the original as
 * `cause` — silently reporting only the original would hide a broken all-or-nothing apply.
 */
function restorePreImages(renamed: readonly StagedWrite[], cause: unknown): unknown {
  const unrestored: string[] = [];
  for (const w of renamed) {
    const restoreTmp = `${w.path}.rescope-restore-${process.pid}.tmp`;
    try {
      writeFileSync(restoreTmp, w.raw);
      renameSync(restoreTmp, w.path);
    } catch {
      unrestored.push(`${w.row.type}/${w.row.slug}`);
    }
    try { unlinkSync(restoreTmp); } catch { /* consumed by the rename, or never written */ }
  }
  if (unrestored.length === 0) return cause;
  return new Error(
    `rescope rollback incomplete; still rescoped on disk: ${unrestored.join(", ")}`,
    { cause },
  );
}

export async function applyRescope(
  store: QMDStore,
  root: string,
  plan: RescopePlan,
  git: GitDeps = {},
): Promise<RescopeApplyResult> {
  if (plan.rows.length === 0) {
    return { applied: 0, rejected: [], synced: true, indexed: true };
  }

  const rejected: RescopeRow[] = [];
  const seen = new Set<string>();
  const valid: { row: RescopeRow; path: string; raw: string }[] = [];

  for (const row of plan.rows) {
    if (!ROW_TYPES.includes(row.type)) { rejected.push(row); continue; }
    if (isGlobalOrBlank(row.to)) { rejected.push(row); continue; }
    try {
      assertSafeSlug(row.slug);
    } catch {
      rejected.push(row);
      continue;
    }
    const key = `${row.type}/${row.slug}`;
    if (seen.has(key)) { rejected.push(row); continue; }
    const path = memoryFilePath(root, row.type, row.slug);
    if (!existsSync(path)) { rejected.push(row); continue; }
    const raw = readFileSync(path, "utf-8");
    if (parseMemory(raw).frontmatter.project !== row.from) { rejected.push(row); continue; }
    if (!locateFences(raw)) { rejected.push(row); continue; }
    seen.add(key);
    valid.push({ row, path, raw });
  }

  if (rejected.length > 0) {
    return { applied: 0, rejected, synced: true, indexed: true };
  }

  const staged: StagedWrite[] = valid.map((v) => ({
    row: v.row,
    path: v.path,
    raw: v.raw,
    tmp: `${v.path}.rescope-${process.pid}.tmp`,
  }));

  for (let i = 0; i < staged.length; i++) {
    const s = staged[i]!;
    try {
      writeFileSync(s.tmp, setProjectLine(s.raw, yamlScalar(s.row.to)));
    } catch (e) {
      removeTemps(staged.slice(0, i + 1));
      throw e;
    }
  }

  // Nothing is renamed yet, so a target that drifted since phase 1 can still be abandoned
  // for free. Without this a concurrent remember/daemon write would be silently overwritten
  // from the stale pre-image and swept into the rescope commit.
  for (const s of staged) {
    let current: string | undefined;
    try { current = readFileSync(s.path, "utf-8"); } catch { current = undefined; }
    if (current !== s.raw) {
      removeTemps(staged);
      throw new ClientError(`fact ${s.row.type}/${s.row.slug} changed during apply; re-run rescope`);
    }
  }

  const renamed: StagedWrite[] = [];
  for (let i = 0; i < staged.length; i++) {
    const s = staged[i]!;
    try {
      renameSync(s.tmp, s.path);
    } catch (e) {
      removeTemps(staged.slice(i));
      throw restorePreImages(renamed, e);
    }
    renamed.push(s);
  }

  const commitPaths = valid.map((v) => `${v.row.type}/${v.row.slug}.md`);
  const commit = gitCommit(root, `rescope: ${valid.length} fact${valid.length === 1 ? "" : "s"}`, commitPaths, git, { allPaths: true });
  const push = gitPush(root, git);
  const { synced, syncWarning } = syncOutcome(commit, push);
  if (syncWarning) console.error(`[qmemd] rescope: ${syncWarning}`);

  let indexed = true;
  try {
    await reindexMemory(store);
  } catch (e) {
    indexed = false;
    console.error(`[qmemd] rescope: reindex failed (${errorCode(e)}); run qmemd reindex`);
  }

  return { applied: valid.length, rejected: [], synced, syncWarning, indexed };
}
