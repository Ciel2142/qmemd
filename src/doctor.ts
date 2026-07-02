// =============================================================================
// doctor.ts — frontmatter integrity audit + mechanical --fix (qmemd-61h)
//
// parseMemory (engine.ts) is deliberately LENIENT: it never throws, and on a
// malformed hand-edited fact it silently defaults type→reference, project→global,
// name→"", silently dropping a frontmatter line it can't parse. readType/listFacts
// swallow unreadable files in try/catch. So a hand-edit + `qmemd reindex` can
// silently misscope or hide a fact with no surfaced error — and the qmemd-memory
// skill explicitly supports that hand-edit + reindex workflow.
//
// doctor is the SEPARATE validation pass parseMemory is not: it walks the memory
// dir and reports, per fact, where the file diverges from physical truth (the type
// FOLDER, the FILENAME stem) or would lose data. `--fix` repairs only the mechanical
// subset, surgically (line-level edits — never a parse→reserialize, which would drop
// hand-added keys/comments the curated repo may hold), writing a .bak first.
//
// Filesystem-only — no Store, no embedding model — mirroring recallSession/listFacts.
// =============================================================================

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { MEMORY_TYPES, parseMemory, yamlScalar, PLATFORMS, splitFlowSeq, setFrontmatterKey, isValidReviewBy, leakedMarkupTokens, stripLeakedMarkup } from "./engine.js";

const NUL = String.fromCharCode(0); // the NUL byte, built via charcode (a literal NUL can't be embedded in source)

export type IssueCode =
  | "MISSING_OPEN"       // no leading `---` fence — parseMemory reads the whole file as body
  | "MISSING_CLOSE"      // opening fence never closed — parseMemory drops ALL frontmatter
  | "EMPTY_FRONTMATTER"  // fences enclose zero recognized keys
  | "YAML_PARSE"         // a fence line parseMemory silently skips (`key: value` mismatch → data loss)
  | "TYPE_MISMATCH"      // frontmatter type missing / unknown / != the folder it lives in (misscoping)
  | "NAME_MISMATCH"      // frontmatter name != the filename stem (the stem is the source of truth)
  | "NULL_BYTES"         // embedded NUL — corrupts search text and tooling
  | "PLATFORM_UNKNOWN"   // a platforms token not in PLATFORMS — parseMemory silently drops it
  | "LINK_MALFORMED"              // supersedes/superseded_by/conflicts_with value is empty, path-unsafe, or self-referential
  | "LINK_DANGLING_SUPERSEDES"    // forward link targets a slug that no longer exists — lineage note lost, manual
  | "LINK_DANGLING_SUPERSEDED_BY" // hidden by a fact that no longer exists — --fix clears it (un-supersede)
  | "LINK_ONE_SIDED"              // A.supersedes=B but B lacks superseded_by — partial double-write; --fix completes the stamp (reported on B)
  | "LINK_CYCLE"                  // A and B superseded_by each other — both hidden, needs a human
  | "REVIEW_BY_MALFORMED"         // review_by is not a real YYYY-MM-DD — staleFacts fails it open into the unreviewed lane (9su); the intended schedule is lost, manual
  | "BODY_TEMPLATE_LEAK";         // leaked tool-call/template markup in the BODY (qp-ey3) — --fix strips it (body-only; frontmatter untouched)

/** The mechanically-repairable subset. The rest (broken fences, empty/garbage
 *  frontmatter) need a human — doctor cannot guess the intended structure. */
const FIXABLE: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "NULL_BYTES", "TYPE_MISMATCH", "NAME_MISMATCH",
  "LINK_DANGLING_SUPERSEDED_BY", "LINK_ONE_SIDED",
  "BODY_TEMPLATE_LEAK",
]);

export interface FactIssue {
  code: IssueCode;
  /** True when `--fix` can repair it; false when it needs human review. */
  fixable: boolean;
  /** Human-readable specifics (the offending value, the expected value). */
  detail?: string;
}

export interface FactReport {
  /** The type FOLDER the file lives in (the physical, authoritative type). */
  type: string;
  /** The filename stem (the authoritative slug). */
  slug: string;
  /** "<type>/<file>.md" — relative to the memory root. NEVER an absolute path. */
  relpath: string;
  issues: FactIssue[];
}

export interface FixOutcome {
  /** The repaired file content. */
  content: string;
  /** Which codes were repaired. */
  fixed: IssueCode[];
}

export interface FixResult {
  type: string;
  slug: string;
  relpath: string;
  fixed: IssueCode[];
  /** "<type>/<file>.md.bak" — the pre-fix backup written beside the fact. */
  backupRelpath: string;
}

// -----------------------------------------------------------------------------
// Frontmatter inspection — mirrors parseMemory's fence + key-line logic exactly,
// so the audit reflects what parseMemory ACTUALLY sees (not a stricter YAML model).
// -----------------------------------------------------------------------------

const FM_KEY_RE = /^([a-z_]+):\s*(.*)$/i;

interface Inspection {
  hasOpen: boolean;
  hasClose: boolean;
  /** Recognized `key: value` lines, in order (last-wins, like parseMemory's switch). */
  keyLines: { key: string; val: string }[];
  /** Non-blank, non-comment block lines that don't parse as `key: value` —
   *  parseMemory silently skips these, so their content is lost. */
  badLines: string[];
}

/** Strip a single leading BOM (U+FEFF), matching parseMemory's `content.replace(/^﻿/, "")`. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function inspect(content: string): Inspection {
  const trimmed = stripBom(content);
  if (!trimmed.startsWith("---")) return { hasOpen: false, hasClose: false, keyLines: [], badLines: [] };
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) return { hasOpen: true, hasClose: false, keyLines: [], badLines: [] };
  const block = trimmed.slice(3, end).trim();
  const keyLines: { key: string; val: string }[] = [];
  const badLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("#")) continue; // tolerate hand-added YAML comments
    const m = line.match(FM_KEY_RE);
    if (m) keyLines.push({ key: m[1]!.toLowerCase(), val: (m[2] ?? "").trim() });
    else badLines.push(line);
  }
  return { hasOpen: true, hasClose: true, keyLines, badLines };
}

/** Last value for a key (parseMemory's per-line switch is last-wins). */
function lastVal(keyLines: { key: string; val: string }[], key: string): string | undefined {
  let v: string | undefined;
  for (const kl of keyLines) if (kl.key === key) v = kl.val;
  return v;
}

function mk(code: IssueCode, detail?: string): FactIssue {
  return { code, fixable: FIXABLE.has(code), detail };
}

function clip(s: string, n = 60): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Audit one file's raw content against the FOLDER it lives in and its FILENAME stem.
 * Pure (no fs). Returns one FactIssue per problem; [] for a clean fact. NULL_BYTES is
 * orthogonal (checked on the whole file); a broken/empty fence short-circuits the
 * field checks because without a parseable block there is no reliable type/name to
 * compare (and reporting "name missing" on a fenceless file would just be noise).
 */
export function auditFact(content: string, folderType: string, slug: string): FactIssue[] {
  const issues: FactIssue[] = [];
  if (content.includes(NUL)) issues.push(mk("NULL_BYTES"));

  // Body template-leak (qp-ey3): scan the BODY parseMemory would serve (the whole file when the
  // fence is broken), so a leak fires even on a fence-broken file. Frontmatter is never scanned —
  // a token in description/source is out of scope (that lane is remember's, not body corruption).
  const leaked = leakedMarkupTokens(parseMemory(content).body);
  if (leaked.length > 0) issues.push(mk("BODY_TEMPLATE_LEAK", `leaked tool-call/template markup in body: ${leaked.join(", ")}`));

  const fm = inspect(content);
  if (!fm.hasOpen) { issues.push(mk("MISSING_OPEN")); return issues; }
  if (!fm.hasClose) { issues.push(mk("MISSING_CLOSE")); return issues; }
  if (fm.keyLines.length === 0) { issues.push(mk("EMPTY_FRONTMATTER")); return issues; }

  if (fm.badLines.length > 0) {
    issues.push(mk("YAML_PARSE", `unparseable frontmatter line: ${clip(fm.badLines[0]!)}`));
  }

  // type: the FOLDER is authoritative (readType/listFacts scope by folder). Flag a
  // type that is missing, not a closed MemoryType, or valid-but-foldering-elsewhere.
  const typeVal = lastVal(fm.keyLines, "type");
  if (typeVal === undefined) {
    issues.push(mk("TYPE_MISMATCH", `type field missing (folder '${folderType}')`));
  } else if (!(MEMORY_TYPES as string[]).includes(typeVal)) {
    issues.push(mk("TYPE_MISMATCH", `unknown type '${typeVal}' (folder '${folderType}')`));
  } else if (typeVal !== folderType) {
    issues.push(mk("TYPE_MISMATCH", `type '${typeVal}' != folder '${folderType}'`));
  }

  // name: the FILENAME stem is authoritative. Compare against parseMemory's EFFECTIVE
  // name (it unquotes), so a correctly-quoted name that decodes to the slug is clean.
  const decoded = parseMemory(content).frontmatter;
  if (decoded.name !== slug) issues.push(mk("NAME_MISMATCH", `name '${decoded.name}' != filename '${slug}'`));

  // platforms: flag any token not in PLATFORMS. parseMemory silently drops an unknown token
  // (fact falls back to cross-platform), so surface it for human review — never auto-fixed.
  const platformsVal = lastVal(fm.keyLines, "platforms");
  if (platformsVal !== undefined) {
    // Tokenize exactly as parseMemory does (splitFlowSeq, not a naive split on comma) so the
    // reported token set matches what parseMemory actually dropped — a comma inside a quoted
    // token stays one token instead of being mis-split into two phantom tokens (qmemd-alu).
    const toks = splitFlowSeq(platformsVal.replace(/^\[|\]$/g, "")).map(t => t.trim().toLowerCase()).filter(Boolean);
    const unknown = toks.filter(t => !(PLATFORMS as string[]).includes(t));
    if (unknown.length > 0) issues.push(mk("PLATFORM_UNKNOWN", `unknown platform token(s): ${unknown.join(", ")} (valid: ${PLATFORMS.join(", ")})`));
  }

  // review_by must be a real YYYY-MM-DD (9su). staleFacts fails an invalid one OPEN into
  // the unreviewed lane (the fact still surfaces), but the schedule the author intended is
  // silently gone — surface it for human repair; never auto-fixed (doctor can't guess the date).
  const reviewByVal = lastVal(fm.keyLines, "review_by");
  if (reviewByVal !== undefined && !isValidReviewBy(reviewByVal)) {
    issues.push(mk("REVIEW_BY_MALFORMED", `review_by '${clip(reviewByVal)}' is not a real YYYY-MM-DD date — the intended review schedule is lost (the fact lists as unreviewed)`));
  }

  // Link-field shape (bri): each is a single safe path segment (assertSafeSlug's rule) and
  // never the fact's own slug. Cross-fact existence checks live in auditLinks (corpus context).
  for (const key of ["supersedes", "superseded_by", "conflicts_with"] as const) {
    const linePresent = lastVal(fm.keyLines, key) !== undefined;
    if (!linePresent) continue;
    const eff = key === "supersedes" ? decoded.supersedes
      : key === "superseded_by" ? decoded.supersededBy
      : decoded.conflictsWith;
    if (eff === undefined) { issues.push(mk("LINK_MALFORMED", `${key} present but empty`)); continue; }
    if (/[\\/]|\.\.|[\n\r]/.test(eff)) issues.push(mk("LINK_MALFORMED", `${key} '${clip(eff)}' is not a single safe path segment`));
    else if (eff === slug) issues.push(mk("LINK_MALFORMED", `${key} points at the fact itself`));
  }

  return issues;
}

// -----------------------------------------------------------------------------
// Mechanical fix — surgical line edits only. Uses setFrontmatterKey from engine.ts.
// -----------------------------------------------------------------------------

/**
 * Strip leaked markup from the BODY only (lines after the closing `---` fence), preserving
 * frontmatter bytes exactly. Returns the repaired content, or null when a well-formed fence
 * pair can't be located (a fence-broken file is left for human repair, mirroring the type/name
 * surgery guard) or when nothing changed.
 */
function stripBodyLeak(content: string): string | null {
  const lines = content.split("\n");
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const noBom = lines[i]!.charCodeAt(0) === 0xFEFF ? lines[i]!.slice(1) : lines[i]!;
    if (noBom.startsWith("---")) { open = i; break; }
  }
  if (open < 0) return null;
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("---")) { close = i; break; }
  }
  if (close < 0) return null;
  const head = lines.slice(0, close + 1).join("\n");
  const body = lines.slice(close + 1).join("\n");
  const cleaned = stripLeakedMarkup(body);
  return cleaned === body ? null : `${head}\n${cleaned}`;
}

/**
 * Repair the mechanical subset of `content`'s issues (NULL_BYTES, TYPE_MISMATCH,
 * NAME_MISMATCH, BODY_TEMPLATE_LEAK). Pure — returns the repaired content + the codes fixed,
 * or null when there is nothing mechanical to do. Null-byte stripping is always safe; type/name
 * surgery and body-leak strip run only when the block is well-formed (open+close fence) so a
 * fence-broken file is left untouched rather than corrupted further.
 */
export function fixContent(content: string, folderType: string, slug: string): FixOutcome | null {
  const fixable = auditFact(content, folderType, slug).filter(i => i.fixable);
  if (fixable.length === 0) return null;

  let out = content;
  const fixed: IssueCode[] = [];

  if (fixable.some(i => i.code === "NULL_BYTES")) {
    out = out.split(NUL).join("");
    fixed.push("NULL_BYTES");
  }

  const needType = fixable.some(i => i.code === "TYPE_MISMATCH");
  const needName = fixable.some(i => i.code === "NAME_MISMATCH");
  if (needType || needName) {
    const fm = inspect(out);
    if (fm.hasOpen && fm.hasClose && fm.keyLines.length > 0) {
      if (needType) { out = setFrontmatterKey(out, "type", folderType); fixed.push("TYPE_MISMATCH"); }
      // yamlScalar so a reserved/odd slug (e.g. "true", "123") is quoted exactly as the
      // serializer would write it — keeps a doctor-fixed file byte-identical to a remembered one.
      if (needName) { out = setFrontmatterKey(out, "name", yamlScalar(slug)); fixed.push("NAME_MISMATCH"); }
    }
  }

  if (fixable.some(i => i.code === "BODY_TEMPLATE_LEAK")) {
    const stripped = stripBodyLeak(out);
    if (stripped !== null) { out = stripped; fixed.push("BODY_TEMPLATE_LEAK"); }
  }

  return fixed.length > 0 ? { content: out, fixed } : null;
}

// -----------------------------------------------------------------------------
// Filesystem walkers — thin wrappers over the pure core.
// -----------------------------------------------------------------------------

/**
 * Walk every type folder under `root` and return one FactReport per file that has ≥1
 * issue (clean files are omitted). Skips non-`.md` files — which excludes `.md.bak`
 * backups, since ".md.bak".endsWith(".md") is false, exactly as readType/scanFacts do.
 * Filesystem-only; never returns an absolute path.
 */
export function auditMemory(root: string): FactReport[] {
  const reports: FactReport[] = [];
  for (const type of MEMORY_TYPES) {
    const dir = join(root, type);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      let content: string;
      try { content = readFileSync(join(dir, f), "utf-8"); } catch { continue; }
      const slug = f.replace(/\.md$/, "");
      const issues = auditFact(content, type, slug);
      if (issues.length > 0) reports.push({ type, slug, relpath: `${type}/${f}`, issues });
    }
  }
  // Cross-fact link pass (bri): needs corpus context, so it cannot live in pure auditFact.
  // Merge per relpath so one file gets one report.
  for (const lr of auditLinks(root)) {
    const existing = reports.find(r => r.relpath === lr.relpath);
    if (existing) existing.issues.push(...lr.issues);
    else reports.push(lr);
  }
  return reports;
}

// -----------------------------------------------------------------------------
// Cross-fact link audits (bri) — corpus context required.
// -----------------------------------------------------------------------------

/** Slug → {type, relpath, fm} over every parseable fact — corpus context for the link audits. */
function scanLinkFacts(root: string): Map<string, { type: string; relpath: string; fm: ReturnType<typeof parseMemory>["frontmatter"] }> {
  const bySlug = new Map<string, { type: string; relpath: string; fm: ReturnType<typeof parseMemory>["frontmatter"] }>();
  for (const type of MEMORY_TYPES) {
    const dir = join(root, type);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const fm = parseMemory(readFileSync(join(dir, f), "utf-8")).frontmatter;
        bySlug.set(f.replace(/\.md$/, ""), { type, relpath: `${type}/${f}`, fm });
      } catch { /* unreadable files are doctor's other half — not link-auditable */ }
    }
  }
  return bySlug;
}

/**
 * Cross-fact link audits (bri): dangling forward/reverse links, one-sided pairs (the
 * partial double-write), and mutual hide-cycles. Per-file SHAPE problems live in auditFact;
 * a malformed value is skipped here (shape first, then semantics). Reported per fact file.
 */
export function auditLinks(root: string): FactReport[] {
  const bySlug = scanLinkFacts(root);
  const reports = new Map<string, FactReport>();
  const report = (slug: string): FactReport => {
    const f = bySlug.get(slug)!;
    let r = reports.get(slug);
    if (!r) { r = { type: f.type, slug, relpath: f.relpath, issues: [] }; reports.set(slug, r); }
    return r;
  };
  // A value is semantically actionable only when it is well-formed (same rule as assertSafeSlug).
  const safe = (v: string | undefined, self: string): v is string =>
    v !== undefined && !/[\\/]|\.\.|[\n\r]/.test(v) && v !== self;

  for (const [slug, f] of bySlug) {
    if (safe(f.fm.supersedes, slug)) {
      const target = bySlug.get(f.fm.supersedes);
      if (!target) {
        report(slug).issues.push(mk("LINK_DANGLING_SUPERSEDES", `supersedes '${f.fm.supersedes}' — no such fact; the lineage note is stale`));
      } else if (target.fm.supersededBy === undefined) {
        // The fixable side is the TARGET (it needs the stamp) — report it there.
        report(f.fm.supersedes).issues.push(mk("LINK_ONE_SIDED", `'${slug}' supersedes this fact but the superseded_by stamp is missing (partial double-write) — --fix completes it`));
      }
      // target.supersededBy naming a DIFFERENT fact: the target is retired either way — no issue.
    }
    if (safe(f.fm.supersededBy, slug)) {
      const by = bySlug.get(f.fm.supersededBy);
      if (!by) {
        report(slug).issues.push(mk("LINK_DANGLING_SUPERSEDED_BY", `hidden by '${f.fm.supersededBy}', which no longer exists — --fix clears the stamp (restores visibility)`));
      } else if (by.fm.supersededBy === slug) {
        report(slug).issues.push(mk("LINK_CYCLE", `'${slug}' and '${f.fm.supersededBy}' supersede each other — BOTH are hidden from recall; pick the survivor and clear its superseded_by`));
      }
    }
  }
  return [...reports.values()];
}

/**
 * Make sure the memory root's .gitignore covers `*.bak` (qmemd-g6q). fixMemory is the
 * sole writer of .bak files; without this line a manual `git add -A` in the memory repo
 * (or any future unscoped staging) would commit the backups into the memories-only
 * history. Creates the file when absent, appends when the pattern is missing, leaves it
 * untouched when already covered. Best-effort: an unwritable root never blocks the fix.
 */
function ensureBakIgnored(root: string): void {
  const gi = join(root, ".gitignore");
  try {
    let current = "";
    try { current = readFileSync(gi, "utf-8"); } catch { /* absent — create below */ }
    if (current.split(/\r?\n/).includes("*.bak")) return;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(gi, `${current}${sep}*.bak\n`);
  } catch { /* best-effort */ }
}

/** Remove a `key: ...` line from the frontmatter block. Surgical inverse of
 *  setFrontmatterKey: touches only that line; content unchanged when fences/key absent. */
function removeFrontmatterKey(content: string, key: string): string {
  const lines = content.split("\n");
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const noBom = l.charCodeAt(0) === 0xFEFF ? l.slice(1) : l;
    if (noBom.startsWith("---")) { open = i; break; }
  }
  if (open < 0) return content;
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("---")) { close = i; break; }
  }
  if (close < 0) return content;
  const re = new RegExp(`^${key}\\s*:`, "i");
  for (let i = open + 1; i < close; i++) {
    if (re.test(lines[i]!)) { lines.splice(i, 1); return lines.join("\n"); }
  }
  return content;
}

/**
 * Repair the two mechanical link issues (bri): clear a dangling superseded_by (the
 * un-supersede path) and complete a one-sided pair's missing superseded_by stamp.
 * `alreadyBacked` = relpaths fixMemory's per-file pass backed up this run — their .bak
 * already holds the true original, so it is not overwritten here.
 */
function fixLinks(root: string, alreadyBacked: ReadonlySet<string>): FixResult[] {
  const bySlug = scanLinkFacts(root); // fresh read — runs after the per-file pass rewrote files
  const results: FixResult[] = [];
  const backed = new Set(alreadyBacked);
  const repair = (relpath: string, mutate: (content: string) => string, code: IssueCode): void => {
    const path = join(root, relpath);
    let content: string;
    try { content = readFileSync(path, "utf-8"); } catch { return; }
    const out = mutate(content);
    if (out === content) return;
    if (results.length === 0 && backed.size === 0) ensureBakIgnored(root);
    if (!backed.has(relpath)) { writeFileSync(path + ".bak", content); backed.add(relpath); }
    writeFileSync(path, out);
    const slug = relpath.split("/").pop()!.replace(/\.md$/, "");
    results.push({ type: relpath.split("/")[0]!, slug, relpath, fixed: [code], backupRelpath: `${relpath}.bak` });
  };
  for (const r of auditLinks(root)) {
    for (const iss of r.issues) {
      if (iss.code === "LINK_DANGLING_SUPERSEDED_BY") {
        repair(r.relpath, c => removeFrontmatterKey(c, "superseded_by"), iss.code);
      } else if (iss.code === "LINK_ONE_SIDED") {
        // The report sits on the TARGET (the fact missing its stamp); recover the
        // superseder's slug from the corpus — find the fact whose supersedes names this slug.
        const superseder = [...bySlug.entries()].find(([, f]) => f.fm.supersedes === r.slug)?.[0];
        if (superseder) repair(r.relpath, c => setFrontmatterKey(c, "superseded_by", yamlScalar(superseder)), iss.code);
      }
    }
  }
  return results;
}

/**
 * Repair the mechanical issues of every fact under `root`, in place. For each fact
 * that has a fixable issue, write a `<file>.md.bak` of the ORIGINAL bytes first, then
 * overwrite the `.md` with the repaired content. Returns one FixResult per fact
 * touched. Idempotent: a re-run finds nothing to fix (the previous pass made each
 * fact clean) and writes no further backups. Does NOT git-commit — bulk repairs stay
 * reviewable via `git diff` (the caller reviews, then commits). The first backup of a
 * run also ensures the root .gitignore covers `*.bak` (qmemd-g6q); a clean run writes
 * nothing at all.
 */
export function fixMemory(root: string): FixResult[] {
  const results: FixResult[] = [];
  for (const type of MEMORY_TYPES) {
    const dir = join(root, type);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      let content: string;
      try { content = readFileSync(path, "utf-8"); } catch { continue; }
      const slug = f.replace(/\.md$/, "");
      const outcome = fixContent(content, type, slug);
      if (!outcome) continue;
      if (results.length === 0) ensureBakIgnored(root); // first .bak of this run
      writeFileSync(path + ".bak", content);      // pre-fix backup
      writeFileSync(path, outcome.content);        // repaired
      results.push({ type, slug, relpath: `${type}/${f}`, fixed: outcome.fixed, backupRelpath: `${type}/${f}.bak` });
    }
  }
  // Cross-fact link fixes (bri): runs after the per-file pass, passing the relpaths
  // already backed up so this pass never overwrites an original .bak with a patched one.
  results.push(...fixLinks(root, new Set(results.map(r => r.relpath))));
  return results;
}
