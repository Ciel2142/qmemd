import { walkFactFiles, parseMemory, type MemoryType } from "./engine.js";

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
