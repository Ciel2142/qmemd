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
  lines.splice(insertAt, 0, `project: ${value}`);
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

  const written: { path: string; content: string }[] = [];
  let currentTmp: string | undefined;
  try {
    for (const v of valid) {
      const rewritten = setProjectLine(v.raw, yamlScalar(v.row.to));
      const tmpPath = `${v.path}.rescope-${process.pid}.tmp`;
      currentTmp = tmpPath;
      writeFileSync(tmpPath, rewritten);
      renameSync(tmpPath, v.path);
      currentTmp = undefined;
      written.push({ path: v.path, content: v.raw });
    }
  } catch (e) {
    for (const w of written) {
      try { writeFileSync(w.path, w.content); } catch { /* best-effort restore; original error still rethrown below */ }
    }
    if (currentTmp) {
      try { unlinkSync(currentTmp); } catch { /* best-effort cleanup; original error still rethrown below */ }
    }
    throw e;
  }

  const commitPaths = valid.map((v) => `${v.row.type}/${v.row.slug}.md`);
  const commit = gitCommit(root, `rescope: ${valid.length} fact${valid.length === 1 ? "" : "s"}`, commitPaths, git);
  const push = gitPush(root, git);
  const { synced, syncWarning } = syncOutcome(commit, push);
  if (syncWarning) console.error(`[qmemd] rescope: ${syncWarning}`);

  let indexed = true;
  try {
    await reindexMemory(store);
  } catch (e) {
    indexed = false;
    console.error(`[qmemd] rescope: reindex failed (rescope committed): ${e instanceof Error ? e.message : String(e)}`);
  }

  return { applied: valid.length, rejected: [], synced, syncWarning, indexed };
}
