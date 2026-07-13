import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { MEMORY_COLLECTION } from "./store.js";
import { gitCommit, gitPush, type GitDeps, type GitCommitResult, type GitPushResult } from "./git.js";
import { type QMDStore, Maintenance } from "@tobilu/qmd";
import type { MergeProposalCluster } from "./dedup.js"; // type-only — no runtime cycle

/**
 * A client-facing rejection: the caller can fix it by changing their input, and the
 * `.message` is path-free and safe to surface verbatim (no fs leak, no server fault).
 * Both surfaces classify by `instanceof ClientError` — MCP `sanitizeToolError` surfaces
 * the message and HTTP maps it to 400; every other throw is an internal fault (500 /
 * "internal error"). Replaces the two hand-synced message-prefix allowlists that had
 * already drifted and dropped a message (qp-ey3-rejection-missing-allowlist-f6j). Extends
 * Error, so `instanceof Error` and `.message` assertions in existing tests still hold.
 */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export type Platform = "linux" | "macos" | "windows";
export const PLATFORMS: Platform[] = ["linux", "macos", "windows"];

/** Map a Node platform id to an OS family. An unrecognized host → "all", which
 *  DISABLES platform filtering (an exotic host never has facts silently hidden). */
export function platformFromNode(p: NodeJS.Platform): Platform | "all" {
  if (p === "linux") return "linux";
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "all";
}

/** The OS family of the current process (the workstation serving this CLI/MCP/REST). */
export function currentPlatform(): Platform | "all" {
  return platformFromNode(process.platform);
}

/** Whether a fact tagged for `platforms` is visible to a host on `current`.
 *  current "all" (exotic host) shows everything; empty platforms = cross-platform
 *  = shows everywhere; otherwise membership. Single source for every filter surface. */
export function platformVisible(platforms: Platform[], current: Platform | "all"): boolean {
  return current === "all" || platforms.length === 0 || platforms.includes(current);
}

/** Reject an unknown platform token before it reaches frontmatter (qmemd-jzz sibling).
 *  Path-free message (starts "invalid platform") so the MCP/HTTP layers can surface it
 *  verbatim as a client error, mirroring assertSafeSlug / requireValidType. */
export function assertValidPlatforms(platforms: string[]): void {
  for (const p of platforms) {
    if (!(PLATFORMS as string[]).includes(p)) {
      throw new ClientError(`invalid platform ${JSON.stringify(p)}: use one of ${PLATFORMS.join(" | ")}`);
    }
  }
}

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  tags: string[];
  project: string;
  /** OS families this fact applies to. Optional + additive: absent/[] = cross-platform
   *  (the default). parseMemory always materializes it to []; only hand-built literals
   *  may omit it, so read sites guard with `?? []`. */
  platforms?: Platform[];
  created: string; // YYYY-MM-DD
  pinned: boolean;
  /** Full ISO instant of the LAST write (create/replace/force) — qmemd-bri. Absent on
   *  legacy facts; readers fall back to `created` (day-granular) for recency. */
  updated?: string;
  /** Forward supersession link: this fact replaces <slug> (qmemd-bri). The reverse
   *  stamp lives on the old fact (`supersededBy`) — written in the same remember() op. */
  supersedes?: string;
  /** Reverse supersession link: this fact was replaced by <slug> and is hidden from
   *  recall (session + query). Stays on disk + git — retirement, not deletion. */
  supersededBy?: string;
  /** Unresolved-contradiction marker (qmemd-cr4): --force wrote this fact past a
   *  detected conflict with <slug>. Marker only — never affects recall. */
  conflictsWith?: string;
  /** Review-by date YYYY-MM-DD (qmemd-9su): when this fact should be re-verified.
   *  Absent = no schedule (the fact surfaces in the stale pass's oldest-unreviewed
   *  lane instead). NEVER read by recall — staleness only SURFACES via `qmemd stale`,
   *  it never hides or deletes (markdown stays the source of truth). */
  reviewBy?: string;
  source?: string;
}

export interface ParsedMemory {
  frontmatter: MemoryFrontmatter;
  body: string;
}

/** A real YYYY-MM-DD calendar date (qmemd-9su). The regex pins the shape; the parse →
 *  re-format round-trip rejects impossible components (2026-02-30, 2026-13-01) — a bare
 *  Date.parse is NOT enough, because when strict ISO parsing fails V8 falls back to a
 *  legacy parser that silently overflows 02-30 into March. A typo'd date must never
 *  silently exempt a fact from staleness review. */
export function isValidReviewBy(s: string): boolean {
  if (s === DURABLE_SENTINEL) return true; // explicit durable mark (s4w)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s); // a valid shape parses via the strict ISO path: UTC midnight
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Reject a malformed review-by date before it reaches frontmatter (qmemd-9su).
 *  Path-free message (starts "invalid review_by") so the MCP/HTTP layers surface it
 *  verbatim as a client error — the assertSafeSlug / assertValidPlatforms pattern. */
export function assertValidReviewBy(s: string): void {
  if (!isValidReviewBy(s)) {
    throw new ClientError(`invalid review_by ${JSON.stringify(s)}: use a real YYYY-MM-DD date`);
  }
}

/** Durable sentinel for review_by (s4w): a fact explicitly marked "never re-review". */
export const DURABLE_SENTINEL = "never";

/**
 * Parse a "<N>d|w|m|y" ttl into a total day count (w=7, m=30, y=365), or null when the
 * shape is malformed or N < 1. Pure; shared by reviewByFromTtl and ttlDefaultDays (s4w).
 */
export function parseTtlDays(ttl: string): number | null {
  const m = /^(\d+)\s*([dwmy])$/i.exec(ttl.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (n < 1) return null;
  const DAYS: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };
  const total = n * DAYS[m[2]!.toLowerCase()]!;
  // Upper bound (qp-ttl-overflow-crash-bql): a Date is valid only to ±8.64e15 ms (≈ year 275760).
  // A shape-valid but astronomically large ttl (999999999d, an env override 3000000y) would push
  // reviewByFromTtl's `from + total*86.4e6` past that so new Date(...).toISOString() throws an
  // uncaught RangeError, and would flow a huge day count into staleFacts/doctor. Treat it as
  // malformed (null): reviewByFromTtl then raises the intended "invalid ttl" ClientError and
  // ttlDefaultDays falls back to its default — MAX_TTL_DAYS (~100,000y) clears every real window.
  return total > 36_500_000 ? null : total;
}

/**
 * ttl sugar → review-by date (qmemd-9su): "<N>d|w|m|y" counted from `from` (default now).
 * Deterministic day-math — the same ttl always lands the same distance out. Throws a
 * path-free "invalid ttl" error (the MCP/HTTP client-error allowlist pattern) on a
 * malformed or zero ttl.
 */
export function reviewByFromTtl(ttl: string, from: Date = new Date()): string {
  const days = parseTtlDays(ttl);
  if (days === null) {
    throw new ClientError(`invalid ttl ${JSON.stringify(ttl)}: use <N>d|w|m|y with N >= 1 (e.g. 90d)`);
  }
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Per-type default review window in days (s4w); null = durable (never auto-surfaces).
 *  Applied only when a fact has no explicit review_by — never persisted to a file. */
const TTL_DEFAULTS: Record<MemoryType, number | null> = {
  project: 90, reference: 180, feedback: null, user: null,
};

/** Resolve the default review window for `type`, honoring a QMEMD_TTL_<TYPE> env override
 *  ("<N>d|w|m|y" or "never"). An unparseable override falls back to the hardcoded default
 *  — fail-safe, never throws (the QMEMD_BEACON_EVERY / QMEMD_EMBED_TIMEOUT_MS precedent). */
export function ttlDefaultDays(type: MemoryType): number | null {
  const env = process.env[`QMEMD_TTL_${type.toUpperCase()}`]?.trim();
  if (env) {
    if (env.toLowerCase() === DURABLE_SENTINEL) return null;
    const d = parseTtlDays(env);
    if (d !== null) return d;
  }
  return TTL_DEFAULTS[type];
}

export function memoryFilePath(root: string, type: MemoryType, slug: string): string {
  return join(root, type, `${slug}.md`);
}

/**
 * Reject a caller-supplied slug that is not a single safe filename segment (qmemd-fd8).
 * `remember`'s `replace` and `forget`'s slug arrive verbatim from CLI args and
 * MCP tool args (LLM-controlled), bypassing slugify(). Unchecked they flow into
 * memoryFilePath -> join(root, type, slug + ".md"), where path.join normalizes a
 * `..`/separator slug to escape the memory root entirely — arbitrary .md overwrite
 * (e.g. ~/.claude/CLAUDE.md instruction-poisoning) and arbitrary .md deletion — and
 * a newline forges git commit trailers via the "remember: <slug>" message. slugify()
 * only ever emits [a-z0-9-] and fallbackSlug() emits "mem-<hex>", so guarding the
 * finalized slug never rejects a legitimately computed one.
 */
export function assertSafeSlug(slug: string): void {
  if (slug === "" || /[\\/]|\.\.|[\n\r]/.test(slug)) {
    throw new ClientError(`unsafe slug ${JSON.stringify(slug)}: must be a single path segment with no '/', '\\', '..', or newline`);
  }
}

/**
 * Kebab-case slug, truncated to 60 chars on a word boundary.
 * Returns "" when the input has no alphanumeric characters — callers that
 * build file paths from the result must validate for empty.
 */
export function slugify(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 60) {
    s = s.slice(0, 60).replace(/-+[^-]*$/, "").replace(/-+$/, "");
  }
  return s;
}

/**
 * Normalize text for dedup IDENTITY only (the fallbackSlug hash and the Tier-2 query),
 * never for storage: strip a leading BOM, fold CRLF/CR to LF, trim, then NFKC-fold
 * (collapses NFC/NFD canonical and compatibility variants to a single form). Two
 * byte-different encodings of the same fact thus dedupe, while the file on disk keeps
 * its original bytes (qmemd-n63). Mirrors gbrain capture.ts normalizeForHash.
 */
export function normalizeForHash(text: string): string {
  // Strip a leading BOM (U+FEFF) via a code-point check — no in-regex escape — then
  // fold line endings, trim, and NFKC-fold so canonical/compatibility variants of one
  // fact share a single identity.
  const noBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return noBom
    .replace(/\r\n?/g, "\n")  // CRLF / lone CR -> LF
    .trim()
    .normalize("NFKC");       // fold NFC/NFD + compatibility variants to one form
}

/**
 * Deterministic fallback slug for text that slugify() reduces to "" (a fact with
 * no ASCII alphanumerics, e.g. all-CJK or all-Cyrillic). Without this, the path
 * collapses to "<root>/<type>/.md" — a hidden dotfile that the indexer skips
 * (never recallable) and that any second empty-slug fact silently overwrites.
 * The hash is taken over normalizeForHash(text) so encoding variants of one fact
 * dedupe (qmemd-n63); it keeps distinct facts apart.
 */
export function fallbackSlug(text: string): string {
  return `mem-${createHash("sha1").update(normalizeForHash(text)).digest("hex").slice(0, 12)}`;
}

/**
 * A bare plain scalar that a strict YAML parser would type-coerce to a non-string
 * (bool / null / number) rather than read as the literal text. Matched generously
 * — over-quoting a value that didn't strictly need it is harmless (still valid,
 * still round-trips); under-quoting silently changes the value's type.
 */
function isReservedYamlScalar(v: string): boolean {
  return /^(true|false|yes|no|on|off|null|~)$/i.test(v)         // bool / null
    || /^[-+]?(\.inf|\.nan)$/i.test(v)                          // infinity / nan
    || /^[-+]?0(x[0-9a-f_]+|o[0-7_]+|b[01_]+)$/i.test(v)        // hex / octal / binary int
    || /^[-+]?(\d[\d_]*\.?[\d_]*|\.[\d_]+)([eE][-+]?\d+)?$/.test(v); // int / float / exponent
}

/**
 * A frontmatter scalar needs quoting when, written bare, it could be misread by a
 * strict YAML parser: empty, a leading indicator char or whitespace, an embedded
 * ": " or " #", a trailing ":", a newline/tab, or a reserved bool/null/number token.
 */
function needsYamlQuoting(v: string): boolean {
  return v === ""
    || /^[\s"'#&*!|>%@`,?:[\]{}-]/.test(v)
    || /\s$/.test(v)
    || /:(\s|$)/.test(v)
    || /\s#/.test(v)
    || /[\n\r\t]/.test(v)
    || isReservedYamlScalar(v);
}

/** Bare value when safe; otherwise a JSON double-quoted (valid YAML) scalar.
 *  Exported so `qmemd doctor --fix` writes a repaired name/type with the exact same
 *  quote-only-when-needed rule the serializer uses (single source of truth). */
export function yamlScalar(v: string): string {
  return needsYamlQuoting(v) ? JSON.stringify(v) : v;
}

/** A flow-sequence entry needs quoting for the YAML scalar reasons, plus the
 * flow indicators `,` `[` `]` `{` `}` which are unsafe anywhere in a plain scalar
 * inside flow context (a strict parser rejects a bare `[x{y]`). */
function needsTagQuoting(v: string): boolean {
  return needsYamlQuoting(v) || /[,[\]{}]/.test(v);
}

/** Bare tag when safe; otherwise a JSON double-quoted scalar. */
function tagScalar(v: string): string {
  return needsTagQuoting(v) ? JSON.stringify(v) : v;
}

export function serializeMemory(fm: MemoryFrontmatter, body: string): string {
  // Values are written bare, but any value that could break a strict YAML parser
  // (colon-space, leading quote/hash/bracket, etc.) is JSON double-quoted. The
  // quote-only-when-needed invariant lets parseMemory tell a new encoded value
  // apart from a legacy bare value that merely happens to be wrapped in quotes.
  const lines = ["---"];
  lines.push(`name: ${yamlScalar(fm.name)}`);
  lines.push(`description: ${yamlScalar(fm.description)}`);
  lines.push(`type: ${fm.type}`);
  lines.push(`tags: [${fm.tags.map(tagScalar).join(", ")}]`);
  lines.push(`project: ${yamlScalar(fm.project)}`);
  const plats = fm.platforms ?? [];
  if (plats.length > 0) lines.push(`platforms: [${plats.map(tagScalar).join(", ")}]`);
  lines.push(`created: ${fm.created}`);
  lines.push(`pinned: ${fm.pinned}`);
  // review_by is a bare YYYY-MM-DD like created — never needs quoting (qmemd-9su).
  if (fm.reviewBy) lines.push(`review_by: ${fm.reviewBy}`);
  // bri fields: omitted when absent (the source/platforms pattern). updated is a bare ISO
  // instant (no space ⇒ never needs quoting); the slug-valued links go through yamlScalar
  // because an assertSafeSlug-passing slug may still contain a YAML-hostile char.
  if (fm.updated) lines.push(`updated: ${fm.updated}`);
  if (fm.supersedes) lines.push(`supersedes: ${yamlScalar(fm.supersedes)}`);
  if (fm.supersededBy) lines.push(`superseded_by: ${yamlScalar(fm.supersededBy)}`);
  if (fm.conflictsWith) lines.push(`conflicts_with: ${yamlScalar(fm.conflictsWith)}`);
  if (fm.source) lines.push(`source: ${yamlScalar(fm.source)}`);
  lines.push("---", "", body.trimEnd(), "");
  return lines.join("\n");
}

/**
 * Locate the frontmatter fence pair, anchored to byte 0 exactly like parseMemory
 * (qp-yf2): the open fence is recognized ONLY when the first line — after a leading
 * BOM — starts with "---"; the close fence is the first subsequent "---" line.
 * Returns null when there is no byte-0 fence or no closing fence, so a fenceless
 * note whose body contains "---" horizontal rules is never mistaken for frontmatter.
 * Single source of fence-locating truth for setFrontmatterKey and doctor --fix.
 */
export function locateFences(content: string): { open: number; close: number } | null {
  const lines = content.split("\n");
  const first = lines[0];
  if (first === undefined) return null;
  const noBom = first.charCodeAt(0) === 0xFEFF ? first.slice(1) : first;
  if (!noBom.startsWith("---")) return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("---")) return { open: 0, close: i };
  }
  return null;
}

/**
 * Replace the value of `key` within the frontmatter block, or insert `key: value`
 * just after the opening fence if the key is absent. Touches ONLY that one line —
 * every other frontmatter line, comment, and the body are preserved byte-for-byte.
 * Returns content unchanged when the fences can't be located (caller guards this).
 * Shared by doctor --fix and the remember() supersede stamp (bri).
 */
export function setFrontmatterKey(content: string, key: string, value: string): string {
  const fences = locateFences(content);
  if (!fences) return content;
  const { open, close } = fences;
  const lines = content.split("\n");
  const re = new RegExp(`^${key}\\s*:`, "i");
  for (let i = open + 1; i < close; i++) {
    if (re.test(lines[i]!)) { lines[i] = `${key}: ${value}`; return lines.join("\n"); }
  }
  lines.splice(open + 1, 0, `${key}: ${value}`);
  return lines.join("\n");
}

/**
 * Decode a frontmatter scalar. The serializer only quotes values that
 * needYamlQuoting, so a quoted-looking value is the NEW encoded form only when its
 * decoded content actually needed quoting; otherwise the quotes are part of a
 * legacy bare value (written by the older always-bare serializer) and are kept.
 *
 * Quote-only-when-needed invariant (qmemd-0n6): serializeMemory/yamlScalar only
 * add surrounding quotes when needsYamlQuoting is true, and this decoder only
 * strips surrounding quotes when the decoded content would itself have needed
 * quoting. Consequence: a code-written value that genuinely needed quoting (e.g.
 * `name: "key: val"`) round-trips exactly (decodes back to `key: val`), while a
 * legacy hand-edited value that was quoted but did NOT need it (e.g.
 * `name: "simple text"`) is preserved verbatim — the quotes are kept as part of
 * the value, NOT normalized away. Preserving is the safe choice: the decoder
 * cannot tell an over-quoted value from a fact whose text is itself a quoted
 * sentence, so it never silently drops quotes and never loses data.
 */
function unquoteScalar(v: string): string {
  if (v.length >= 2 && v.charCodeAt(0) === 34 /* " */ && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === "string" && needsYamlQuoting(parsed)) return parsed;
    } catch { /* not valid JSON — legacy bare value, keep as-is */ }
  }
  return v;
}

/** Split a flow-sequence body on top-level commas, honouring double-quoted
 * entries (whose JSON-escaped content may contain a comma or a `]`). */
export function splitFlowSeq(s: string): string[] {
  const out: string[] = [];
  let buf = "", inQuote = false, esc = false;
  for (const c of s) {
    if (esc) { buf += c; esc = false; continue; }
    if (inQuote && c === "\\") { buf += c; esc = true; continue; }
    if (c === '"') { inQuote = !inQuote; buf += c; continue; }
    if (c === "," && !inQuote) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim() !== "" || out.length > 0) out.push(buf);
  return out;
}

/** Decode a tag, mirroring unquoteScalar's quote-only-when-needed invariant. */
function unquoteTag(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.charCodeAt(0) === 34 /* " */ && t.endsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === "string" && needsTagQuoting(parsed)) return parsed;
    } catch { /* not valid JSON — legacy bare tag, keep as-is */ }
  }
  return t;
}

export function parseMemory(content: string): ParsedMemory {
  const trimmed = content.replace(/^﻿/, "");
  const fm: MemoryFrontmatter = {
    name: "", description: "", type: "reference",
    tags: [], project: "global", created: "", pinned: false,
    platforms: [],
  };
  let body = trimmed;
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end >= 0) {
      const block = trimmed.slice(3, end).trim();
      body = trimmed.slice(end + 4).replace(/^(\r?\n){1,2}/, "");
      for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (!m) continue;
        const key = m[1]!;
        const val = (m[2] ?? "").trim();
        switch (key) {
          case "name": fm.name = unquoteScalar(val); break;
          case "description": fm.description = unquoteScalar(val); break;
          case "type": if ((MEMORY_TYPES as string[]).includes(val)) fm.type = val as MemoryType; break;
          case "project": fm.project = unquoteScalar(val) || "global"; break;
          case "created": fm.created = val; break;
          // Empty-string policy (qmemd-9go): a present-but-empty `source:` line decodes to ""
          // (a value), distinct from an absent line (undefined). `|| undefined` conflated the two
          // — the same ||-for-missing class as the created-date bug. `??`-style: keep "" as-is.
          case "source": fm.source = unquoteScalar(val); break;
          case "updated": fm.updated = val || undefined; break;
          case "supersedes": fm.supersedes = unquoteScalar(val) || undefined; break;
          case "superseded_by": fm.supersededBy = unquoteScalar(val) || undefined; break;
          case "conflicts_with": fm.conflictsWith = unquoteScalar(val) || undefined; break;
          case "review_by": fm.reviewBy = val || undefined; break;
          case "pinned": fm.pinned = val === "true"; break;
          case "tags":
            fm.tags = splitFlowSeq(val.replace(/^\[|\]$/g, "")).map(unquoteTag).filter(Boolean);
            break;
          case "platforms":
            // Reuse the tag flow-seq splitter; keep only known tokens (drop unknown —
            // fact falls back to cross-platform rather than vanishing; doctor surfaces it),
            // lowercase, dedupe.
            fm.platforms = splitFlowSeq(val.replace(/^\[|\]$/g, ""))
              .map(t => t.trim().toLowerCase())
              .filter((t): t is Platform => (PLATFORMS as string[]).includes(t))
              .filter((t, i, a) => a.indexOf(t) === i);
            break;
        }
      }
    }
  }
  return { frontmatter: fm, body };
}

// =============================================================================
// recallSession() — filesystem-only budgeted session snapshot (no Store, no model)
// =============================================================================

export interface SessionOptions {
  project?: string;      // current project name (cwd basename); "global" facts always included
  projectLimit?: number; // max project facts (default $QMEMD_SESSION_PROJECT_LIMIT, then 5)
  budgetBytes?: number;  // hard cap on output size (default $QMEMD_SESSION_BUDGET, then 2000)
  platform?: Platform | "all"; // host OS gate (default currentPlatform()); "all" disables it
}

// y6s: the session-start hook invokes `qmemd recall --session` with no way to pass
// options, so the budget/projectLimit knobs are env-tunable. Read here (not per caller)
// so the CLI, MCP and REST session paths all honor the same envs; an explicit opt wins.
// Invalid values fall back to the built-in default — the hook path must never break.
function sessionEnvInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : undefined;
}

/** Truncate a string so its UTF-8 byte length is <= maxBytes, never splitting a
 * multibyte character. */
export function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
  // Iterate by Unicode code point (the for…of iterator yields whole code points,
  // never half of a surrogate pair) so a 4-byte/astral char is kept or dropped
  // whole — never split into a lone surrogate that becomes U+FFFD on the wire.
  let used = 0, out = "";
  for (const ch of s) {
    const cb = Buffer.byteLength(ch, "utf-8");
    if (used + cb > maxBytes) break;
    used += cb;
    out += ch;
  }
  return out;
}

/** One file yielded by walkFactFiles: physical identity + raw bytes, no parsing. */
export interface FactFile {
  /** The FOLDER the file lives in (the physical, authoritative type). */
  type: MemoryType;
  /** Filename stem (the authoritative slug). */
  slug: string;
  /** "<type>/<file>.md" — relative to the memory root, never absolute. */
  relpath: string;
  /** Absolute path — for callers that go on to write; never leaves the process. */
  path: string;
  raw: string;
}

/**
 * The single corpus-walk skeleton (qp-nq2): every type folder → every `.md` entry →
 * raw bytes. Skips non-`.md` names — which excludes `.md.bak` backups, since
 * ".md.bak".endsWith(".md") is false. A read failure invokes `onUnreadable(relpath)`
 * and skips the entry; PARSE failures are the caller's lane (some callers audit raw
 * bytes and must see unparseable files, others parseMemory-and-count). Replaces nine
 * hand-rolled copies whose policies (unreadable counting, extension rule) had drifted.
 */
export function* walkFactFiles(
  root: string,
  opts: { types?: readonly MemoryType[]; onUnreadable?: (relpath: string) => void } = {},
): Generator<FactFile> {
  for (const type of opts.types ?? MEMORY_TYPES) {
    const dir = join(root, type);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      let raw: string;
      try { raw = readFileSync(path, "utf-8"); }
      catch { opts.onUnreadable?.(`${type}/${f}`); continue; }
      yield { type, slug: f.replace(/\.md$/, ""), relpath: `${type}/${f}`, path, raw };
    }
  }
}

function readType(root: string, type: MemoryType, onUnreadable?: () => void): ParsedMemory[] {
  const out: ParsedMemory[] = [];
  // A read/parse failure bumps the caller's unreadable counter (qmemd-8jt) so the every-
  // session snapshot folds the count into THIS pass instead of re-walking the whole corpus
  // through countUnreadableFacts afterwards (qmemd-e5h/j5i — single read on the hot path).
  for (const ff of walkFactFiles(root, { types: [type], onUnreadable: () => onUnreadable?.() })) {
    try { out.push(parseMemory(ff.raw)); } catch { onUnreadable?.(); }
  }
  return out;
}

/**
 * Count fact files that fail to read across all type folders (qmemd-e5h). readType /
 * listFacts / scanFacts each silently `catch {}` an unreadable file, so a corrupt fact
 * vanishes from recall AND from the dedup scan with no error — near-dups then accumulate
 * silently. This single-pass audit counts each physical file once, letting the snapshot +
 * CLI list surface "N unreadable — run qmemd doctor" rather than hiding it.
 * Filesystem-only, no model.
 */
export function countUnreadableFacts(root: string): number {
  let n = 0;
  for (const ff of walkFactFiles(root, { onUnreadable: () => n++ })) {
    try { parseMemory(ff.raw); } catch { n++; }
  }
  return n;
}

/** Filesystem-only session snapshot. No Store, no model — instant and deterministic. */
export async function recallSession(root: string, opts: SessionOptions = {}): Promise<string> {
  const projectLimit = opts.projectLimit ?? sessionEnvInt("QMEMD_SESSION_PROJECT_LIMIT") ?? 5;
  const budget = opts.budgetBytes ?? sessionEnvInt("QMEMD_SESSION_BUDGET") ?? 2000;
  const curProject = opts.project ?? "global";
  const plat = opts.platform ?? currentPlatform();
  const onPlat = (m: ParsedMemory): boolean => platformVisible(m.frontmatter.platforms ?? [], plat);

  // A superseded fact is retired (bri): hidden from EVERY snapshot lane, pinned included —
  // supersession is explicit retirement, stronger than a pin. Filtered before the
  // platform-hidden count below so a retired fact is never reported as platform-hidden.
  const active = (m: ParsedMemory): boolean => !m.frontmatter.supersededBy;

  // Fold the unreadable-file count into this single read of all four type folders (qmemd-8jt):
  // every readType below shares this counter, so the snapshot no longer re-parses the entire
  // corpus through countUnreadableFacts afterwards (qmemd-j5i hot-path single-read intent).
  let unreadable = 0;
  const bumpUnreadable = (): void => { unreadable++; };
  const usersAll = readType(root, "user", bumpUnreadable);
  const feedbackAll = readType(root, "feedback", bumpUnreadable);
  // Retirement filter FIRST (bri spec): a retired fact is never reported as platform-hidden.
  // Base the platform-hidden counter on active facts only, then apply the platform gate.
  const usersActive = usersAll.filter(active);
  const feedbackActive = feedbackAll.filter(active);
  const users = usersActive.filter(onPlat);
  const feedback = feedbackActive.filter(onPlat);
  // user/feedback are the lanes the recall instructions call EXHAUSTIVE (claude/qmemd.md:
  // "the snapshot injects every user + feedback fact"). The spec filters every lane by host
  // platform, so a platform-bound user/feedback fact is correctly hidden here — but hiding it
  // SILENTLY withholds guidance the agent is told it has in full. Count what the host gate
  // removed from these two lanes and surface it as a footer below (qmemd-b1a).
  // platformHiddenUF is baselined on active facts so retired facts are never reported as
  // platform-hidden (bri): an active fact that is off-platform is hidden; a retired fact is not.
  const platformHiddenUF = (usersActive.length - users.length) + (feedbackActive.length - feedback.length);
  // Read the two largest type folders ONCE each; pinned and in-scope are derived by
  // filtering the same parsed lists (qmemd-j5i — this path runs at every session start).
  const projectAll = readType(root, "project", bumpUnreadable);
  const referenceAll = readType(root, "reference", bumpUnreadable);
  // Project = SCOPE (where a fact surfaces), pin = PRIORITY (never falls out of the recency
  // slice WITHIN that scope) — two axes (57d). The pinned block therefore takes the same
  // project gate as the sliced lanes; without it a repo-specific pinned fact injects into
  // every session of every repo (the 3gv incident). Surfacing everywhere needs project:global.
  const inProject = (m: ParsedMemory): boolean => m.frontmatter.project === curProject || m.frontmatter.project === "global";
  const pinned = [...projectAll, ...referenceAll].filter(m => m.frontmatter.pinned && onPlat(m) && active(m) && inProject(m));
  // In-scope = non-pinned, non-retired facts for the current project or global, newest first.
  // Kept un-sliced so the slice drop below is countable (e3i); `.slice` is what the
  // snapshot actually shows.
  // Recency = updated (full instant, bri) falling back to created (day-granular legacy).
  // ISO strings compare lexicographically; a bare day sorts before any same-day instant.
  const recency = (m: ParsedMemory): string => m.frontmatter.updated ?? m.frontmatter.created;
  const inScope = (facts: ParsedMemory[]): ParsedMemory[] => facts
    .filter(m => !m.frontmatter.pinned && onPlat(m) && active(m) && inProject(m))
    .sort((a, b) => recency(b).localeCompare(recency(a)));
  const projectsInScope = inScope(projectAll);
  const projects = projectsInScope.slice(0, projectLimit);
  // Recent non-pinned references (mirrors the projects block) so a reference stored
  // mid-session resurfaces at the next session start even when not pinned (bgf).
  // Pinned references continue to appear via the `pinned` block; !pinned here avoids
  // a double-count.
  const referencesInScope = inScope(referenceAll);
  const references = referencesInScope.slice(0, projectLimit);

  // `unreadable` (accumulated above during the single readType pass, qmemd-8jt) is surfaced
  // as a footer below so a corrupt fact does not silently vanish from the snapshot (qmemd-e5h).
  // Empty ONLY when there is nothing readable AND nothing unreadable to warn about — an
  // all-unreadable corpus must still speak up (returning "" here is the silence e5h fixes).
  if (users.length + feedback.length + pinned.length + projects.length + references.length === 0 && unreadable === 0 && platformHiddenUF === 0) return "";

  const HEADER = "## Memory (qmd)";
  // The header is the floor of any non-empty snapshot; if it alone can't fit the
  // hard cap, emit nothing rather than blow the budget on a header-only output.
  if (Buffer.byteLength(HEADER, "utf-8") > budget) return "";
  const lines: string[] = [HEADER];
  let truncated = 0;

  // qmemd-mqt: reserve room for the e3i coverage footer(s) BEFORE emitting the greedy
  // always-on bodies. Without this, numerous feedback bodies fill the budget and the gap
  // signal (emitted last) is dropped silently — defeating the postmortem-R1 purpose of
  // surfacing that the snapshot is partial. The dominant gap is the slice-drop (in-scope >
  // projectLimit), knowable up front; build the real footer line per gapped lane and reserve
  // its bytes. Footer width depends on curProject (it appears twice), so measure the actual
  // string with worst-case digit widths rather than hardcode. Reservation shrinks the budget
  // for ALL earlier blocks (bodies + pinned + project/reference one-liners) — shrinking only
  // the body loop would let the one-liners, which emit before the footer, steal the slack.
  // The footer's `total` is the platform-FILTERED in-scope count (spec), so the suggested
  // `list` must carry --platform to reproduce it — otherwise the un-scoped list shows MORE
  // facts than the count promised (qmemd-b1a). Omit on an exotic host (plat === "all"): no
  // filtering happened and "all" is not a real platform token.
  const platSuffix = plat === "all" ? "" : ` --platform ${plat}`;
  const footerLine = (label: "project" | "reference", total: number, shown: number, hidden: number): string =>
    `${total} ${label} facts for ${curProject} (${shown} shown, ${hidden} more) — qmemd list --type ${label} --project ${curProject}${platSuffix}`;
  // The platform-hidden user/feedback signal (qmemd-b1a). plat is concrete here whenever
  // platformHiddenUF > 0 (a fact can only be hidden when the host gate is active, i.e. not "all").
  const platformHiddenLine = platformHiddenUF > 0
    ? `${platformHiddenUF} platform-scoped user/feedback fact${platformHiddenUF === 1 ? "" : "s"} hidden on ${plat} — qmemd recall <topic> --all-platforms`
    : "";
  let reserve = 0;
  const reserveFooter = (label: "project" | "reference", inScopeList: ParsedMemory[]) => {
    if (inScopeList.length <= projectLimit) return; // gap only via budget-drop → best-effort, not reserved
    reserve += Buffer.byteLength(footerLine(label, inScopeList.length, projectLimit, inScopeList.length), "utf-8") + 1 /* the "\n" join() inserts before the footer */;
  };
  reserveFooter("project", projectsInScope);
  reserveFooter("reference", referencesInScope);
  // qmemd-trp: a footer ALSO fires when a lane is budget-DROPPED (its slice fit count-wise but
  // bytes pushed its one-liners out), not only on slice-overflow. Such a footer emits in the same
  // tail as the histogram, yet reserveFooter above never reserved it — so a second lane's
  // budget-drop footer stole the histogram's reserved bytes and starved the topic hint (the a1d
  // failure, one lane over). This only matters once a histogram is in play (reserve > 0 ⇒ a lane
  // overflowed); then reserve a footer slot for any OTHER in-scope lane small enough to escape the
  // slice-overflow reservation but still able to budget-drop, so the histogram reserve below
  // survives it. Gated on reserve > 0 so a footer-free small corpus pays nothing.
  if (reserve > 0) {
    const reserveDropFooter = (label: "project" | "reference", inScopeList: ParsedMemory[]) => {
      if (inScopeList.length === 0 || inScopeList.length > projectLimit) return; // empty ⇒ no footer; overflow ⇒ already reserved
      reserve += Buffer.byteLength(footerLine(label, inScopeList.length, projectLimit, inScopeList.length), "utf-8") + 1 /* the "\n" join() inserts before the footer */;
    };
    reserveDropFooter("project", projectsInScope);
    reserveDropFooter("reference", referencesInScope);
  }
  // qmemd-a1d: when a slice-gap is being reserved (reserve > 0 ⇒ a footer will fire), also
  // reserve bytes for the single "Unshown tags:" histogram line so the topic hint survives a
  // feedback flood instead of being best-effort-dropped after the footer (qmemd-mqt only saved
  // the count). Cap the reserve so a large tag vocabulary can't starve the always-on bodies; the
  // emit-time cap-to-fit below trims the histogram to whatever room actually remains.
  const HIST_RESERVE_MAX = 120; // "Unshown tags: " (14) + ~a dozen short tag(count) entries
  if (reserve > 0) {
    // Worst-case unshown set = EVERY in-scope fact (budget pressure can drop the sliced ones too,
    // not just the slice-tail) — size the reserve from that so a later budget-drop can't widen the
    // emitted histogram past what was reserved (e.g. "win(9)" reserved, "win(14)" emitted). Capped
    // so a large tag vocabulary can't starve the always-on bodies; the emit-time cap-to-fit trims
    // to whatever room actually remains.
    const worstCaseTags = [...projectsInScope, ...referencesInScope].map(m => m.frontmatter.tags);
    const histLine = formatTagHistogram(tagHistogram(worstCaseTags));
    if (histLine) {
      reserve += Math.min(HIST_RESERVE_MAX, Buffer.byteLength(`Unshown tags: ${histLine}`, "utf-8") + 1 /* join "\n" */);
    }
  }
  // qmemd-b1a: reserve the platform-hidden user/feedback signal alongside the e3i footers — it
  // is the same over-trust failure class (the agent treats user/feedback as exhaustive), so it
  // must not be a body-flood casualty. Added after the histogram reserve so a hidden signal on
  // its own never spuriously triggers the slice-gap histogram reservation above.
  if (platformHiddenLine) reserve += Buffer.byteLength(platformHiddenLine, "utf-8") + 1 /* join "\n" */;
  // Only reserve if it still leaves room for the header plus some bodies; otherwise fall back
  // to the best-effort path (preserves the tiny-budget behaviour where the footer is dropped,
  // not overflowed).
  if (reserve >= budget - Buffer.byteLength(HEADER, "utf-8")) reserve = 0;
  const workBudget = budget - reserve;

  const withBody = (m: ParsedMemory, label: string) => {
    const indentedBody = m.body.trim().replace(/\n/g, "\n  ");
    // description defaults to firstLine(body) (engine.ts remember). When it still IS
    // that first line, printing it above the body just repeats the body's opening
    // line (8hk), so fold the label straight into the body and drop the description
    // line. A curated description that differs from the first line is kept above.
    const desc = m.frontmatter.description;
    const block = desc === firstLine(m.body)
      ? `[${label}] ${indentedBody}`
      : `[${label}] ${desc}\n  ${indentedBody}`;
    if (Buffer.byteLength(lines.concat(block).join("\n"), "utf-8") <= workBudget) { lines.push(block); return; }
    // Over budget: truncate this block to fit (with an ellipsis) rather than drop
    // it wholesale — user/feedback are the highest-priority always-on facts, so a
    // single one larger than the budget must still appear, just truncated.
    const used = Buffer.byteLength(lines.join("\n"), "utf-8");
    const ELLIPSIS = "…";
    const avail = workBudget - used - 1 /* the "\n" join() inserts before this block */ - Buffer.byteLength(ELLIPSIS, "utf-8");
    if (avail <= 0) { truncated++; return; }
    lines.push(truncateToBytes(block, avail) + ELLIPSIS);
  };
  // dropped: facts the budget pushed out of a one-line block, so the e3i footer can
  // count what was *actually* emitted (not merely attempted) and tag-histogram them.
  const oneLine = (m: ParsedMemory, label: string, dropped?: ParsedMemory[]) => {
    const block = `[${label}] ${m.frontmatter.description} (${m.frontmatter.name})`;
    if (Buffer.byteLength(lines.concat(block).join("\n"), "utf-8") > workBudget) { truncated++; dropped?.push(m); return; }
    lines.push(block);
  };

  users.forEach(m => withBody(m, "user"));
  feedback.forEach(m => withBody(m, "feedback"));
  pinned.forEach(m => oneLine(m, `pinned:${m.frontmatter.type}`));
  const projDropped: ParsedMemory[] = [];
  projects.forEach(m => oneLine(m, `project:${curProject}`, projDropped));
  const refDropped: ParsedMemory[] = [];
  references.forEach(m => oneLine(m, `reference:${curProject}`, refDropped));

  // qmemd-e3i: announce facts not shown — dropped either by the projectLimit slice
  // (happens BEFORE output) or by the byte budget above. Without this the omission is
  // silent — an agent that believes memory was pushed to it won't pull more
  // (postmortem 2026-06-04, R1). Lower priority than user/feedback bodies: appended
  // last, dropped wholesale if no room.
  const fits = (line: string): boolean =>
    Buffer.byteLength(lines.concat(line).join("\n"), "utf-8") <= budget;
  const unshown: ParsedMemory[] = [];
  const countFooter = (label: "project" | "reference", inScopeList: ParsedMemory[], sliced: ParsedMemory[], dropped: ParsedMemory[]) => {
    const shown = sliced.length - dropped.length; // emitted, not merely attempted
    const hidden = inScopeList.length - shown;
    if (hidden <= 0) return;
    const line = footerLine(label, inScopeList.length, shown, hidden);
    if (!fits(line)) return; // no room: drop the footer AND its histogram contribution (no orphan "Unshown tags:")
    lines.push(line);
    // The hidden set = facts beyond the slice + sliced facts the budget dropped.
    unshown.push(...inScopeList.slice(sliced.length), ...dropped);
  };
  countFooter("project", projectsInScope, projects, projDropped);
  countFooter("reference", referencesInScope, references, refDropped);
  if (unshown.length > 0) {
    // Histogram of the unshown facts' tags — a topic hint for what's hidden. The raw
    // count above is the primary signal; facts with tags:[] contribute nothing here.
    // The reservation above guarantees room for a bounded line, but budget-dropped facts
    // can push the full histogram past the reserve, so emit the longest highest-count tag
    // prefix that fits rather than dropping the whole hint (qmemd-a1d).
    const hist = tagHistogram(unshown.map(m => m.frontmatter.tags));
    for (let n = hist.length; n > 0; n--) {
      const line = `Unshown tags: ${formatTagHistogram(hist.slice(0, n))}`;
      if (fits(line)) { lines.push(line); break; }
    }
  }

  // qmemd-b1a: surface user/feedback facts the host platform gate hid, so an "exhaustive" lane
  // is never silently trimmed. Bytes reserved above, so this fits even after a body flood.
  if (platformHiddenLine && fits(platformHiddenLine)) lines.push(platformHiddenLine);

  // qmemd-e5h: surface unreadable/corrupt facts so the silent skip in readType does not hide
  // them from recall. Best-effort like the other footers — dropped only if the budget is full.
  if (unreadable > 0) {
    const line = `${unreadable} fact${unreadable === 1 ? "" : "s"} unreadable — run \`qmemd doctor\``;
    if (fits(line)) lines.push(line);
  }

  if (truncated > 0) {
    const trail = `(${truncated} more — \`qmd recall\` to see)`;
    if (Buffer.byteLength(lines.concat(trail).join("\n"), "utf-8") <= budget) lines.push(trail);
  }
  return lines.join("\n");
}

// =============================================================================
// remember() — write a typed fact to disk, index it for lex search, dedup.
// =============================================================================

/**
 * Dedup strategy: two-tier.
 *
 * Tier 1 (file-existence): if the computed slug already exists on disk, it is
 *   a duplicate — same or nearly-identical fact text produces the same slug.
 *   This is the primary check and works correctly for tiny collections where
 *   FTS5 BM25 IDF is near-zero (every term appears in 100% of the documents).
 *
 * Tier 2 (FTS score): for near-duplicates with slightly different phrasing,
 *   we additionally check the BM25-normalised score. In FTS5, raw scores are
 *   negative (lower = stronger). The normalised score |x|/(1+|x|) maps to
 *   [0,1): strong(-10)→0.91, medium(-2)→0.67, weak(-0.5)→0.33. For a tiny
 *   collection (1–2 docs) BM25 IDF collapses and scores land near 1e-5, so we
 *   use a very small DEDUP_SCORE_FTS just above floating-point noise. For
 *   larger corpora this still catches genuinely matching documents.
 *   Empirically observed: exact duplicate in 1-doc collection → score ≈ 1e-5.
 */
const DEDUP_SCORE_FTS = 1e-6; // any BM25 hit above floating-point noise is a match

/**
 * Max UTF-8 bytes of body attached to each recall hit (bgf). ~80 words — enough to
 * judge relevance and often the whole short fact; ≤limit hits ⇒ ≤RECALL_BODY_CAP×limit
 * extra bytes per recall. The full body is one `getFact`/`show`/`get` away; CLI
 * `recall --full` (RecallOptions.fullBody) bypasses the cap.
 */
const RECALL_BODY_CAP = 500;

export interface RememberInput {
  fact: string;
  type?: MemoryType;
  tags?: string[];
  project?: string;
  pinned?: boolean;
  source?: string;
  platforms?: Platform[]; // OS families; [] / omitted = cross-platform
  as?: string;        // explicit slug
  description?: string;
  replace?: string;   // slug to overwrite in place (skips dedup)
  force?: boolean;    // write even if a duplicate is found
  /** Slug this fact RETIRES (qmemd-bri): the target gets superseded_by stamped in the same
   *  op (one git commit) and disappears from recall. Mutually exclusive with replace
   *  (replace = same-slug in-place update; supersedes = new slug retiring an old one).
   *  Skips dedup like force — the successor legitimately near-dups its predecessor. */
  supersedes?: string;
  /** Review-by date YYYY-MM-DD (qmemd-9su): when this fact should be re-verified — the
   *  `qmemd stale` pass surfaces it once due. Absent on replace = inherit; "" = clear
   *  (the tags/platforms present-empty semantics). Mutually exclusive with ttl. */
  reviewBy?: string;
  /** Shelf-life sugar (qmemd-9su): "<N>d|w|m|y" → reviewBy = today + N (w=7, m=30,
   *  y=365 days). Converted at this single write choke point so CLI/MCP/REST all
   *  accept both spellings. Mutually exclusive with reviewBy. */
  ttl?: string;
}

/**
 * Decision-support comparison attached to a conflict surface (qmemd-vkn). Authority `tier`
 * derives from `type` via authorityTier (ground truth); raw `source` strings are surfaced
 * verbatim for the agent to read (no free-text classification). `verdict` compares tiers only.
 * The engine never auto-resolves — this only informs the agent/human choice.
 */
export interface AuthorityComparison {
  /** The incoming (not-yet-written) fact. Its effective date is "now", so no `created`. */
  incoming: { type: MemoryType; tier: number; source?: string };
  /** The colliding fact that would be overwritten. `created` is its birth date (preserved on --replace). */
  existing: { type: MemoryType; tier: number; source?: string; created: string };
  verdict: "incoming-higher" | "existing-higher" | "equal";
}

export interface RememberResult {
  wrote: boolean;
  slug: string;
  path: string;
  type: MemoryType;
  duplicateOf?: string; // slug of the existing near-duplicate when wrote === false
  /**
   * On the no-write (dedup) path: the colliding fact's description and a body preview
   * (capped to RECALL_BODY_CAP, ellipsised when cut), so the decider can see what it
   * collided with and tell a true duplicate from a contradicting/updating fact rather
   * than being blocked blind (qmemd-cs0). Both omitted on the write path, and
   * best-effort — absent if the matched file is unreadable. Never a filesystem path.
   */
  duplicateDescription?: string;
  duplicateBody?: string;
  /**
   * On the no-write (dedup) path: why the write was withheld (qmemd-5td).
   *   "duplicate" — a true paraphrase of an existing fact; nothing to do.
   *   "conflict"  — a high-similarity near-match with an opposite/changed value (a likely
   *                 contradiction/update): same topic, differing identifier/polarity/antonym.
   *                 The caller should resolve it (replace to update, force to keep both, or
   *                 reword) rather than treat it as a settled duplicate.
   * Omitted on the write path.
   */
  disposition?: RememberDisposition;
  /**
   * On the conflict path only (disposition:"conflict"): a type-derived authority comparison plus
   * both facts' raw source/created, so the decider can weigh which fact wins (qmemd-vkn). Omitted
   * on the write path and the pure-duplicate path, and best-effort — absent if the colliding file
   * is unreadable. Contains no filesystem path (type/tier/created/verdict are structured; source is
   * user prose).
   */
  authorityComparison?: AuthorityComparison;
  /**
   * Whether the post-write reindex succeeded (qmemd-32x). Reindex is best-effort
   * (qmemd-1ro): a written fact may not yet be in the lex index if reindex throws
   * (e.g. SQLITE_BUSY) — false signals that recall may lag until the next pass.
   * On the dedup/no-write path nothing new was written, so there is nothing newly
   * unindexed and this is true.
   */
  indexed: boolean;
  /**
   * Whether git sync succeeded for this write (qmemd-ddr). Mirrors `indexed`: a fact is
   * always written + (best-effort) committed before this is computed, so a false here
   * means the fact is saved LOCALLY but did not reach git history (commit failed, e.g.
   * an unconfigured identity exiting 128) or the remote (push failed) — the cross-machine
   * source of truth silently never updated. True for the expected no-ops (no repo, no
   * upstream, nothing to commit) and on every dedup/no-write path (no git op attempted).
   */
  synced: boolean;
  /** Human-readable reason when `synced` is false (qmemd-ddr); omitted when synced. */
  syncWarning?: string;
  /**
   * Count of candidate facts the Tier-2.5 near-dup scan could not read (qmemd-e5h). >0 means
   * the corpus holds unreadable/corrupt files, so this write may be a near-duplicate the scan
   * silently skipped — surfaced so the dedup gap is visible, not hidden. 0 whenever the scan did
   * not run: a clean corpus, the --replace/--force path (dedup skipped), or an earlier tier
   * (exact-slug / FTS) that blocked before Tier-2.5 was reached. Only meaningful on the write
   * path, where the scan always ran. A count, never a path.
   */
  dedupSkipped: number;
  /**
   * Non-blocking guardrail (qmemd-a3k): present (and the fact still written) when the body looks
   * like a multi-paragraph report/retro rather than an atomic fact — a nudge that a write-up
   * belongs in docs/reports/, not the memory store. Omitted for fact-shaped input and on every
   * no-write path (nothing was stored there to mis-route). A generic guidance string, no fs path.
   */
  reportWarning?: string;
  /**
   * Non-blocking (qp-ey3): set when leaked tool-call/template markup was stripped from the fact
   * body before storing (the cleaned fact IS written). A generic guidance string built from the
   * fixed token labels — no fs path, no captured content. Omitted for clean input and on every
   * no-write path. The pre-strip raw fact is additionally logged to stderr for recovery.
   */
  sanitizedWarning?: string;
  /** Echo of input.supersedes on a successful supersede write (qmemd-bri). */
  supersededSlug?: string;
  /** Set when --force wrote past a detected contradiction (qmemd-cr4): the slug of the
   *  conflicting fact, recorded as conflicts_with on the written file. A marker for
   *  doctor/consolidation — recall is unaffected. */
  conflictsWith?: string;
  /** Set when the supersede double-write could not stamp the OLD fact (it was written +
   *  committed without the reverse link): run doctor --fix to complete it. Mirrors
   *  syncWarning's best-effort style. */
  supersedeWarning?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  // Slice by code point (Array.from yields whole code points, never half a surrogate pair)
  // so the 200-cap never lands mid-astral-char and emits a lone surrogate that serialises to
  // U+FFFD — same approach as truncateToBytes (qmemd-yul).
  return Array.from(line).slice(0, 200).join("");
}

/**
 * Non-blocking guardrail (qmemd-a3k): does this `fact` look like a multi-paragraph report/retro
 * rather than an atomic fact? An agent mis-routed a postmortem write-up into the memory store via
 * remember and had to forget it (field report F4); the two-lane rule (facts → qmemd, write-ups →
 * docs/reports/) is documented but unenforced. Returns a one-line nudge, or null when the input is
 * fact-shaped. Pure structural heuristic — no topic-word matching (a fact legitimately ABOUT a
 * postmortem must not trip it): only markdown section structure flags a doc. Conservative by design
 * (the warning never blocks, but a false positive on a real fact is still noise). ≥2 markdown
 * headings is the reliable structural report signal. The heading-less paragraph branch is fuzzier —
 * a thorough atomic gotcha legitimately runs to ~4 blank-line blocks / ~1KB (observed/repro/
 * workaround/status), e.g. the real rtk-040 fact in the live store — so it requires BOTH ≥5
 * paragraphs AND a long (>1200-char) body to stay clear of those (review finding, qmemd-a3k).
 */
export function reportShapeWarning(fact: string): string | null {
  const body = fact.trim();
  const headings = (body.match(/^#{1,6}\s/gm) ?? []).length;
  const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
  const looksLikeReport = headings >= 2 || (paragraphs >= 5 && body.length > 1200);
  if (!looksLikeReport) return null;
  return "this looks like a multi-paragraph report, not an atomic fact — qmemd stores durable facts; a write-up/retro belongs in docs/reports/ (committed as a doc), not the memory store. Keep the one durable takeaway as the fact instead.";
}

// -----------------------------------------------------------------------------
// Leaked tool-call / template markup (qp-leaked-template-body-corruption-ey3).
// Harness tool-serialization framing that must never live in a stored fact body.
// Shared by doctor (detect + --fix) and remember (prevent). Model-free (I1/I5).
// Bounded literal patterns only — no `.*` / nested quantifiers (ReDoS: runs on every
// write and every fixMemory file). Case-sensitive, un-prefixed forms only (bead
// anti-over-reach: do NOT expand into general HTML or antml:-prefixed variants).
// -----------------------------------------------------------------------------
const LEAK_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: "<fact>",            re: /<fact>/ },
  { label: "</fact>",           re: /<\/fact>/ },
  { label: "<parameter name=",  re: /^\s*<parameter name=/m },
  { label: "<invoke>",          re: /<invoke\b[^>]*>/ },
  { label: "</invoke>",         re: /<\/invoke>/ },
  { label: "<function_calls>",  re: /<function_calls>/ },
  { label: "</function_calls>", re: /<\/function_calls>/ },
];

/**
 * The distinct CANONICAL labels of leaked tool-call/template tokens present in `text`
 * ([] when clean). Returns the fixed labels above, NEVER a raw matched slice — so a
 * caller (CLI warning, doctor detail) can build a message without echoing
 * caller-controlled bytes into a log / MCP structuredContent.
 */
export function leakedMarkupTokens(text: string): string[] {
  return LEAK_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);
}

/**
 * Remove every leaked token from `text`. Identity (byte-for-byte) on clean input,
 * idempotent, and a FIXED POINT — one removal can splice two fragments into a NEW
 * token (`<fa<fact>ct>` -> `<fact>`), so it loops until no token remains (bounded:
 * each pass strictly shrinks the string). Removes a bare `<parameter …>` line whole;
 * strips inline tags in place and drops a line left empty SOLELY by a tag strip;
 * never collapses a pre-existing blank/paragraph break.
 */
export function stripLeakedMarkup(text: string): string {
  if (leakedMarkupTokens(text).length === 0) return text; // byte-identity on clean input
  let out = text;
  for (let guard = 0; leakedMarkupTokens(out).length > 0 && guard < 100; guard++) {
    // A multiline <invoke …> tag (attributes wrapped onto later lines) is DETECTED by the
    // whole-text [^>]* pattern (which crosses newlines) but the per-line pass below can never
    // see it whole, so it would survive every pass to the post-condition and make the fact
    // permanently unstorable (qp-multiline-invoke-unstorable-xwz). Remove the newline-spanning
    // form here on the whole text; the single-line form is left for the per-line logic so an
    // emptied line is still dropped rather than left blank.
    out = out.replace(/<invoke\b[^>]*>/g, m => (m.includes("\n") ? "" : m));
    const kept: string[] = [];
    for (const line of out.split("\n")) {
      if (/^\s*<parameter name=/.test(line)) continue; // drop the bare parameter line whole
      const stripped = line
        .replace(/<fact>/g, "")
        .replace(/<\/fact>/g, "")
        .replace(/<invoke\b[^>]*>/g, "")
        .replace(/<\/invoke>/g, "")
        .replace(/<function_calls>/g, "")
        .replace(/<\/function_calls>/g, "");
      // Drop a line emptied SOLELY by a tag strip; keep an already-blank line.
      if (stripped.trim() === "" && line.trim() !== "") continue;
      kept.push(stripped);
    }
    out = kept.join("\n");
  }
  return out;
}

async function reindexMemory(store: QMDStore): Promise<void> {
  await store.update({ collections: [MEMORY_COLLECTION] });
}

/**
 * Extract the slug from a SearchResult.filepath virtual path.
 * filepath format: "qmd://memory/type/slug.md"
 * Falls back to displayPath ("memory/type/slug.md") or the raw string.
 */
function slugFromFilepath(filepath: string): string {
  // Strip "qmd://" prefix if present, then take the last segment minus ".md"
  const stripped = filepath.startsWith("qmd://") ? filepath.slice(6) : filepath;
  const last = stripped.split("/").pop() ?? "";
  return last.replace(/\.md$/, "") || stripped;
}

/** Build the near-duplicate preview (the matched fact's description + a capped, ellipsised
 *  body) for a blocked remember, so the decider can see what it collided with (qmemd-cs0).
 *  Best-effort: returns {} when the file is missing/unreadable — the block still reports
 *  duplicateOf. Filesystem only, mirrors the recall body cap; never returns a path. */
function duplicatePreview(root: string, slug: string): Pick<RememberResult, "duplicateDescription" | "duplicateBody"> {
  try {
    const f = getFact(root, slug);
    if (!f) return {};
    const full = f.body.trim();
    const capped = truncateToBytes(full, RECALL_BODY_CAP);
    // truncateToBytes returns a strict prefix when it cut — a shorter result means bytes
    // were dropped, so append the ellipsis exactly once (mirrors recallQuery).
    const body = capped.length < full.length ? capped + "…" : capped;
    return { duplicateDescription: f.frontmatter.description, duplicateBody: body || undefined };
  } catch { return {}; }
}

/** Build the conflict authority comparison (qmemd-vkn): tier both facts by type, surface the
 *  colliding fact's raw source + created. Best-effort — returns undefined when the colliding file
 *  is unreadable (mirrors duplicatePreview), so a conflict is never blocked on this lookup. */
function buildAuthorityComparison(
  root: string,
  incomingType: MemoryType,
  incomingSource: string | undefined,
  existingSlug: string,
): AuthorityComparison | undefined {
  try {
    const existing = getFact(root, existingSlug);
    if (!existing) return undefined;
    const incomingTier = authorityTier(incomingType);
    const existingType = existing.frontmatter.type;
    const existingTier = authorityTier(existingType);
    const verdict =
      incomingTier > existingTier ? "incoming-higher" :
      incomingTier < existingTier ? "existing-higher" :
      "equal";
    return {
      incoming: { type: incomingType, tier: incomingTier, source: incomingSource },
      existing: { type: existingType, tier: existingTier, source: existing.frontmatter.source, created: existing.frontmatter.created },
      verdict,
    };
  } catch { return undefined; }
}

// =============================================================================
// Model-free near-duplicate pre-pass (qmemd-i5y, rso ladder steps 2-3)
// =============================================================================

/**
 * Tier-2.5 dedup thresholds (decided qmemd-i5y, 2026-06-05). Deterministic, model-free
 * token-set similarity, run AFTER the Tier-2 BM25 AND-query misses a near-dup on phrasing
 * drift (qmemd-rso): BM25 AND is high-precision/low-recall — it fires only when an existing
 * fact contains ALL new-fact tokens, so one synonym or extra token leaks a duplicate. Two
 * block conditions (OR'd):
 *   - Dice >= DEDUP_DICE: symmetric, length-penalized overlap.
 *   - overlap-coefficient >= DEDUP_OVERLAP AND min(|A|,|B|) >= DEDUP_OVERLAP_MIN_TOKENS:
 *     catches the "+1 extra token / subset" drift Dice's length penalty hides (the exact
 *     alpha failure), floored by a min-token count so a 2-token fact does not subset-
 *     match everything.
 * Tuned LOWER than gbrain's 0.85 retrieval-chunk Jaccard because we compare short
 * name + first-line headlines, not full chunks.
 */
const DEDUP_DICE = 0.82;
const DEDUP_OVERLAP = 0.90;
const DEDUP_OVERLAP_MIN_TOKENS = 5;

/**
 * A small stopword set — common English function words dropped before similarity so they
 * neither inflate the score between unrelated facts ("X is on the Y" vs "A is on the B")
 * nor dilute it between true dups. Kept deliberately small (the research's "drop only a
 * SMALL stopword set") so content words — including short ones — survive.
 */
const DEDUP_STOPWORDS = new Set([
  "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
  "these", "those", "the", "not", "no", "if", "then", "than", "so", "such", "into",
  "onto", "over", "per", "via",
]);

/**
 * Tokenize text for near-dup comparison: NFKC + lowercase (reusing normalizeForHash),
 * then split into alphanumeric runs while keeping identifier tokens ATOMIC — a dotted
 * run like a semver (3.4.1) stays whole rather than splitting on its dots, and an alnum
 * run (jdk21, 9092) stays whole. A small stopword set is dropped. Returns tokens in order
 * (callers Set them). A token is an "identifier" when it contains a digit (jdk21 / 9092 /
 * 21 / 3.4.1) — the precision lever the identifier guard diffs to keep jdk21 apart from
 * jdk25 (qmemd-i5y).
 */
export function tokenizeForDedup(text: string): string[] {
  const lower = normalizeForHash(text).toLowerCase();
  // Dotted alnum run (semver) first so it matches atomically; otherwise a plain alnum run.
  // A sentence period is followed by whitespace, so it never glues two words together.
  const raw = lower.match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [];
  return raw.filter(t => !DEDUP_STOPWORDS.has(t));
}

/** A token is an identifier when it carries a digit (jdk21, 9092, 21, 3.4.1). */
function isIdentifierToken(t: string): boolean {
  return /\d/.test(t);
}

/** A token-set difference between a merge's source facts and its folded body (qmemd-4aa). */
export interface MergeLoss {
  /** Digit-carrying tokens (ports/versions/IDs: the JDK-8321319 correction case) present
   *  in a source but absent from the fold — the BLOCKING data-loss signal. */
  lostIdentifiers: { slug: string; token: string }[];
  /** Non-identifier tokens lost — mostly rephrasing; reported, never blocks. */
  lostProse: { slug: string; token: string }[];
}

/**
 * Token-diff data-loss guard for a merge fold (qmemd-4aa). Every token present in a source
 * fact but absent from `foldedBody` is "lost"; identifier tokens (isIdentifierToken) are the
 * blocking signal, prose tokens informational. Pure, model-free — reuses tokenizeForDedup +
 * the i5y identifier lever. `sources` = the retired members PLUS the keeper's pre-merge body
 * (the keeper is rewritten, so a datum dropped from it is loss too). Dedupes within a source.
 */
export function mergeLossCheck(sources: { slug: string; text: string }[], foldedBody: string): MergeLoss {
  const fold = new Set(tokenizeForDedup(foldedBody));
  const lostIdentifiers: { slug: string; token: string }[] = [];
  const lostProse: { slug: string; token: string }[] = [];
  for (const src of sources) {
    const seen = new Set<string>();
    for (const t of tokenizeForDedup(src.text)) {
      if (fold.has(t) || seen.has(t)) continue;
      seen.add(t);
      (isIdentifierToken(t) ? lostIdentifiers : lostProse).push({ slug: src.slug, token: t });
    }
  }
  return { lostIdentifiers, lostProse };
}

/**
 * True when neither side's identifier tokens are a subset of the other's — each fact
 * carries a version/number the other lacks (jdk21 vs jdk25), so they are distinct facts
 * (most likely a contradiction) and must NOT be merged. This is precisely what a
 * char-trigram or edit-distance metric structurally cannot do (both are number-blind:
 * '21'~'25' share trigrams / are 1 edit apart). Protects the contradictions qmemd-cs0
 * exists to SURFACE and qmemd-5td to classify (qmemd-i5y precision lever).
 */
function identifiersConflict(a: Set<string>, b: Set<string>): boolean {
  const idsA = [...a].filter(isIdentifierToken);
  const idsB = [...b].filter(isIdentifierToken);
  const aSubsetB = idsA.every(t => b.has(t));
  const bSubsetA = idsB.every(t => a.has(t));
  return !aSubsetB && !bSubsetA;
}

export interface NearDupResult {
  /** Final decision: block this as a near-duplicate. */
  duplicate: boolean;
  /** Dice coefficient 2|A∩B| / (|A|+|B|). */
  dice: number;
  /** Overlap (Szymkiewicz–Simpson) coefficient |A∩B| / min(|A|,|B|). */
  overlap: number;
  /** |A∩B|. */
  sharedTokens: number;
  /** A differing version/number vetoed an otherwise-blocking match. */
  identifierConflict: boolean;
}

/**
 * Model-free near-duplicate decision between two short headline strings (qmemd-i5y).
 * Tokenizes both, computes symmetric token-set similarity, and blocks when either the
 * Dice or the floored overlap-coefficient threshold is met — UNLESS the identifier guard
 * vetoes (a differing version/number ⇒ distinct facts). Returns the metrics too, so the
 * normalized similarity is available to the contradiction classifier (qmemd-5td enabler).
 * Token-free input (e.g. an all-CJK fact, deduped upstream by the fallback-hash slug)
 * never blocks — there is nothing to compare.
 */
export function nearDuplicate(a: string, b: string): NearDupResult {
  const setA = new Set(tokenizeForDedup(a));
  const setB = new Set(tokenizeForDedup(b));
  if (setA.size === 0 || setB.size === 0) {
    return { duplicate: false, dice: 0, overlap: 0, sharedTokens: 0, identifierConflict: false };
  }
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const dice = (2 * shared) / (setA.size + setB.size);
  const minSize = Math.min(setA.size, setB.size);
  const overlap = shared / minSize;
  const meets = dice >= DEDUP_DICE
    || (overlap >= DEDUP_OVERLAP && minSize >= DEDUP_OVERLAP_MIN_TOKENS);
  const identifierConflict = meets && identifiersConflict(setA, setB);
  return { duplicate: meets && !identifierConflict, dice, overlap, sharedTokens: shared, identifierConflict };
}

// =============================================================================
// Contradiction classifier (qmemd-5td)
// =============================================================================

/**
 * The disposition of a high-similarity near-match. A `duplicate` is a true paraphrase to
 * BLOCK (the dedup to keep); a `conflict` is a likely contradiction/update — same topic,
 * an opposite/changed value — that must SURFACE for the agent to resolve (replace / force /
 * write-distinct) rather than be silently swallowed as a dup or silently written (qmemd-5td).
 */
export type RememberDisposition = "duplicate" | "conflict";

/**
 * Negation/polarity cues (closed lexicon, qmemd-5td T1b). When one side of a near-match
 * carries a cue the other lacks, the shared predicate is being negated on one side only —
 * a likely update ('X is supported' vs 'X is NOT supported'). Matched against the NORMALIZED
 * text rather than the dedup token set, because tokenizeForDedup drops 'not'/'no'/'never' as
 * stopwords (they would be invisible there). A meaning-bearing 'not' survives a faithful
 * paraphrase on BOTH sides (symmetric ⇒ no flip), so a true paraphrase does not false-fire
 * as a contradiction (the qmemd-5td regression guard).
 */
const POLARITY_CUES = [
  "not", "no", "never", "without", "cannot", "none", "neither", "nor",
  "disabled", "off", "fails", "failed", "removed", "broken", "missing",
  "absent", "unavailable", "lacks", "lacking",
];
// Whole-word cues, plus the contraction suffix n't (doesn't / can't / isn't / won't). The
// apostrophe is REQUIRED (not optional): a bare "nt" would match any word ending in those
// letters (agent, component, deployment, client…) and false-fire an asymmetric negation on a
// plain paraphrase. Only a real contraction carries the mid-word apostrophe, so "n't" alone is
// an unambiguous, anchor-free negation marker (no normal word contains it).
const POLARITY_RE = new RegExp(`\\b(?:${POLARITY_CUES.join("|")})\\b|n['’]t\\b`, "i");

/**
 * Curated antonym pairs (qmemd-5td T1c). A near-match that carries one member of a pair on
 * one side and the OTHER member on the other side is a value flip (a contradiction/update),
 * not a paraphrase — e.g. 'verification enabled' vs 'verification disabled'. Symmetric: the
 * order within a pair does not matter. Deliberately a small, high-precision set of states
 * that flip cleanly in infra facts (extend as real flips surface; it never auto-merges, only
 * routes to the surface, so a missing pair is a recoverable false-negative, not a data loss).
 */
export const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["enabled", "disabled"], ["enable", "disable"], ["true", "false"],
  ["allow", "deny"], ["allowed", "denied"], ["up", "down"], ["pass", "fail"],
  ["passed", "failed"], ["add", "remove"], ["added", "removed"], ["start", "stop"],
  ["started", "stopped"], ["before", "after"], ["required", "optional"],
  ["present", "absent"], ["available", "unavailable"], ["supported", "unsupported"],
  ["valid", "invalid"], ["success", "failure"], ["online", "offline"],
  ["active", "inactive"], ["connected", "disconnected"], ["open", "closed"],
  ["grant", "revoke"], ["include", "exclude"], ["accept", "reject"], ["works", "broken"],
];

/** True when some antonym pair is split across the two token sets (one member each side). */
function antonymConflict(a: Set<string>, b: Set<string>): boolean {
  return ANTONYM_PAIRS.some(([x, y]) => (a.has(x) && b.has(y)) || (a.has(y) && b.has(x)));
}

/**
 * Classify a high-similarity near-match as a `duplicate` to block or a `conflict` to surface
 * (qmemd-5td). Call ONLY when the pair already met the near-dup similarity floor (the
 * remember() loop gates on `meets`); the classifier assumes high text overlap and only asks
 * "same fact, or contradicting value?". Deterministic, cost-ranked, short-circuit on the
 * first conflict signal — ROI order for number-dense infra facts:
 *   T1a a differing identifier (version/port/date/number) — reuses the i5y identifier guard,
 *       which IS this check viewed from the dedup side.
 *   T1b an asymmetric polarity/negation cue (scanned on normalized text — see POLARITY_RE).
 *   T1c a split antonym pair (enabled/disabled, up/down, …).
 * No conflict signal ⇒ `duplicate` (a genuine paraphrase). All conflict routes SURFACE and
 * never auto-merge — numeric/polarity signals are high-recall/low-precision, and precision is
 * recovered by the agent at the surface (ACL-2008 framing). The ambiguous clerical band (T3)
 * and an NLI tier (T4) are deferred — not needed for the deterministic cases above.
 */
export function classifyNearMatch(a: string, b: string): RememberDisposition {
  const setA = new Set(tokenizeForDedup(a));
  const setB = new Set(tokenizeForDedup(b));
  if (identifiersConflict(setA, setB)) return "conflict";
  if (POLARITY_RE.test(normalizeForHash(a)) !== POLARITY_RE.test(normalizeForHash(b))) return "conflict";
  if (antonymConflict(setA, setB)) return "conflict";
  return "duplicate";
}

/**
 * Authority ordinal derived from a fact's type (qmemd-vkn). 2 = highest. Used only to inform
 * the conflict surface — never to auto-resolve. user/feedback are user-authored (highest);
 * project is agent-observed (lived experience outranks an external claim); reference is external.
 * Total + deterministic over the closed MemoryType union — no free-text source parsing.
 */
export function authorityTier(type: MemoryType): 0 | 1 | 2 {
  switch (type) {
    case "user":
    case "feedback":
      return 2;
    case "project":
      return 1;
    case "reference":
      return 0;
  }
}

/** Every token that appears as a member of some antonym pair — the value tokens a flip turns
 *  over (enabled/disabled, up/down, …). Precomputed once for the residual-topic strip below. */
const ANTONYM_MEMBERS = new Set<string>(ANTONYM_PAIRS.flat());

/**
 * A low-similarity contradiction (qmemd-733). The Tier-2.5 near-dup floor (Dice ≥ 0.82 OR a
 * floored overlap) gates classifyNearMatch — but on a SHORT headline a single differing value
 * token deflates Dice/overlap BELOW that floor, so the pair never reaches the classifier and
 * the contradicting fact (redis 6379 vs 6380, JDK 25 vs 21, enabled vs disabled) is silently
 * written as a second independent fact — exactly the flips i5y/5td exist to surface. Detect it
 * independently of the floor: there is a conflict signal (a differing identifier or a split
 * antonym pair) AND, once those conflicting value tokens are stripped, the residual "topic" of
 * the two headlines is IDENTICAL — so it is genuinely the same subject with a changed value,
 * not two unrelated facts that merely carry different numbers or share an antonym member. The
 * residual-equality requirement keeps this high-precision; phrasing-drift contradictions (a
 * different limitation of the firstLine compare) stay out of scope and are not regressed.
 *
 * Scope: identifier and antonym flips only — the symmetric value-flips classifyNearMatch's
 * residual-topic model fits. An ASYMMETRIC polarity-cue flip that also falls below the floor
 * (e.g. "deploy succeeds" vs "deploy fails", where one side carries a content-word cue the
 * other lacks) is NOT caught here: the residual topics differ by construction, so there is no
 * clean same-subject test. Stopword cues (not/no/never) keep the token sets near-identical, so
 * those flips meet the floor and are already caught by classifyNearMatch (qmemd-5td). This is a
 * pre-existing narrow gap, not a regression — the fix only adds coverage.
 */
export function lowSimilarityConflict(a: string, b: string): boolean {
  const setA = new Set(tokenizeForDedup(a));
  const setB = new Set(tokenizeForDedup(b));
  if (setA.size === 0 || setB.size === 0) return false;
  // A conflict signal must be present — else this is not a contradiction, just two facts.
  if (!identifiersConflict(setA, setB) && !antonymConflict(setA, setB)) return false;
  // Residual topic = tokens minus the conflicting value tokens (any identifier, any antonym
  // member). The remaining words are the shared subject the two facts are *about*.
  const isValueToken = (t: string): boolean => isIdentifierToken(t) || ANTONYM_MEMBERS.has(t);
  const topicA = [...setA].filter(t => !isValueToken(t));
  const topicB = [...setB].filter(t => !isValueToken(t));
  // Same subject = identical, non-empty residual sets. Non-empty rejects two bare values
  // ("6379" vs "6380") with no subject; equality rejects unrelated topics (jdk vs postgres).
  if (topicA.length === 0 || topicA.length !== topicB.length) return false;
  const topicSetB = new Set(topicB);
  return topicA.every(t => topicSetB.has(t));
}

/**
 * Every stored fact across all type folders (filesystem-only) — the candidate set for the
 * Tier-2.5 scan. The corpus is tiny (sub-1KB facts, dozens of them), so an exact O(n)
 * pairwise compare is microseconds and needs no retrieval/candidate-gen layer (a BM25
 * candidate step is what Tier-2 already does, and what misses near-dups). Mirrors readType
 * but yields the slug (filename stem) + type needed to report a match. Skips unreadable files.
 */
interface ScanResult {
  facts: Array<{ slug: string; type: MemoryType; name: string; body: string }>;
  /** Candidate files the scan could not read — a silent dedup gap, surfaced (qmemd-e5h). */
  unreadable: number;
}

function scanFacts(root: string): ScanResult {
  const facts: ScanResult["facts"] = [];
  let unreadable = 0;
  for (const ff of walkFactFiles(root, { onUnreadable: () => unreadable++ })) {
    try {
      const parsed = parseMemory(ff.raw);
      facts.push({ slug: ff.slug, type: ff.type, name: parsed.frontmatter.name, body: parsed.body });
    } catch { unreadable++; /* count the dedup gap rather than hide it (qmemd-e5h) */ }
  }
  return { facts, unreadable };
}

/**
 * Fold a commit + push outcome into the {synced, syncWarning} signal (qmemd-ddr).
 * synced is false only when an op that should have worked failed; the benign no-ops
 * (no repo / no upstream / nothing to commit) leave it true so callers stay silent.
 */
function syncOutcome(commit: GitCommitResult, push: GitPushResult): { synced: boolean; syncWarning?: string } {
  if (!commit.ok) {
    return { synced: false, syncWarning: `git commit failed (${commit.reason}) — fact saved locally but NOT committed; the cross-machine source of truth will not see it` };
  }
  if (!push.ok) {
    return { synced: false, syncWarning: `git push failed (${push.reason}) — fact committed locally but NOT pushed to the remote` };
  }
  return { synced: true };
}

export async function remember(
  store: QMDStore,
  root: string,
  input: RememberInput,
  git: GitDeps = {},
): Promise<RememberResult> {
  let type: MemoryType = input.type ?? "reference";
  // Candidate files the Tier-2.5 near-dup scan could not read (qmemd-e5h); 0 until the scan
  // runs (and stays 0 on the --replace/--force path, which skips dedup entirely).
  let dedupSkipped = 0;

  // Prevention (qp-ey3): strip leaked tool-call/template markup BEFORE it derives the slug /
  // dedup keys / description / stored body. Rebind input.fact ONCE (not thread a separate var
  // through the ~9 read sites) so a missed site can't silently re-open the leak. Model-free
  // (no model, no key — I1/I5).
  const originalFact = input.fact;
  const leakedTokens = leakedMarkupTokens(originalFact);
  if (leakedTokens.length > 0) {
    const cleaned = stripLeakedMarkup(originalFact);
    if (cleaned.trim() === "") {
      // Body was ENTIRELY leaked framing — no salvageable content. Reject path-free like
      // assertSafeSlug (MCP verbatim / HTTP 400); a hollow fact is worse than a retry. A
      // ClientError so both surfaces answer 400, not 500 (qp-ey3-rejection-missing-allowlist-f6j).
      throw new ClientError("fact text was entirely leaked tool-call markup — nothing durable to store");
    }
    input = { ...input, fact: cleaned };
  }

  const slugSource = input.as ?? input.fact;
  const slug = input.replace ?? (slugify(slugSource) || fallbackSlug(slugSource));
  // Guard the finalized slug before it becomes a path segment / commit message.
  // slugify()/fallbackSlug() output always passes; a verbatim `replace` may not (qmemd-fd8).
  assertSafeSlug(slug);
  // Recoverability (qp-ey3): only the CLEANED fact is committed below — the raw input reaches
  // neither disk nor git, and unlike doctor there is no .bak. Log the pre-strip raw to stderr
  // (best-effort, mirroring the sync/supersede/dedup warnings) so a false-positive strip is
  // always recoverable; ride a short path-free warning back on the result.
  let sanitizedWarning: string | undefined;
  if (leakedTokens.length > 0) {
    console.error(`[qmemd] remember '${slug}': stripped leaked tool-call markup (${leakedTokens.join(", ")}) from the fact body before storing — pre-strip raw fact follows for recovery:\n${originalFact}`);
    sanitizedWarning = `stripped leaked tool-call/template markup (${leakedTokens.join(", ")}) from the fact body before storing`;
  }
  if (input.supersedes !== undefined) {
    assertSafeSlug(input.supersedes); // LLM/CLI-controlled, becomes a path segment (qmemd-fd8)
    if (input.replace !== undefined) {
      throw new ClientError("supersedes cannot be combined with replace: replace updates a fact in place; supersedes retires the old slug under a new one");
    }
    if (input.supersedes === slug) {
      throw new ClientError(`a fact cannot supersede itself ('${slug}')`);
    }
  }
  // Normalize platform case once at the single write choke point: the CLI lowercases already,
  // but REST/MCP may pass mixed case — store canonical lowercase so every surface agrees and
  // parseMemory's lowercase read never diverges from disk (qmemd-fvv). Reject unknowns after.
  const platforms = input.platforms?.map(p => p.toLowerCase()) as Platform[] | undefined;
  if (platforms) assertValidPlatforms(platforms);

  // Staleness schedule (qmemd-9su): ttl is sugar for review_by, converted at this single
  // write choke point so every surface (CLI/MCP/REST) accepts both. "" is the explicit
  // clear sentinel on --replace (the tags/platforms present-empty semantics); a non-empty
  // value must be a real date — a typo would silently exempt the fact from review.
  if (input.ttl !== undefined && input.reviewBy !== undefined) {
    throw new ClientError("invalid ttl: cannot combine ttl with review_by — pass one or the other");
  }
  const reviewBy = input.ttl !== undefined ? reviewByFromTtl(input.ttl) : input.reviewBy;
  if (reviewBy !== undefined && reviewBy !== "") assertValidReviewBy(reviewBy);

  // --replace and --force update/overwrite an existing slug. Load the existing fact
  // (the same cross-type search forget() does) so we both write back into its folder
  // — rather than under the possibly-defaulted/mismatched --type, which would leave a
  // second file with the same slug orphaned in another folder — and inherit its
  // frontmatter as the fallback for any field the caller did not pass. Without the
  // inherit, an in-place update silently wipes tags/project/pin/source and re-stamps
  // created (qmemd-q65). Null when the slug does not exist yet (e.g. --force on a new
  // slug), in which case the fm build below falls through to plain defaults.
  // NOT the --supersedes path (qp-supersedes-slug-collision-overwrite-kyd): supersede mints a
  // brand-new fact under a NEW slug, so it must never adopt (and then overwrite) whatever fact
  // happens to already carry that slug — a coincidental collision would silently replace an
  // unrelated victim and, if the victim was retired, birth the successor with its superseded_by.
  // The supersede block below rejects such a collision outright.
  let existing: FullFact | null = null;
  if (input.replace || input.force) {
    existing = getFact(root, slug);
    if (existing) type = existing.type;
  }

  // A --replace naming a slug that does not exist is a user error (a mistyped target). Without
  // this guard remember() falls through to the create path and silently fabricates a NEW fact
  // reporting wrote:true, instead of updating the intended one (qmemd-acm). Reject it. The
  // message is path-free and an intentional client-facing signal — the MCP layer surfaces it
  // verbatim (sanitizeToolError) and the HTTP layer maps it to 400, mirroring assertSafeSlug
  // (qmemd-fd8). force is exempt: force means "write even if a near-duplicate exists", so force
  // on a fresh slug legitimately creates. slug already passed assertSafeSlug, so it is a clean
  // single path segment — safe to interpolate (no newline/commit injection).
  if (input.replace !== undefined && !existing) {
    throw new ClientError(`no fact named '${slug}' to replace`);
  }

  // Supersede target must exist — mirroring the replace no-fabricate guard (qmemd-acm):
  // a mistyped target would otherwise create the new fact with a dangling forward link.
  // Path-free message, surfaced verbatim by MCP (sanitizeToolError) / mapped to 400 by HTTP.
  let supersedeTarget: FullFact | null = null;
  if (input.supersedes !== undefined) {
    supersedeTarget = getFact(root, input.supersedes);
    if (!supersedeTarget) throw new ClientError(`no fact named '${input.supersedes}' to supersede`);
    // The successor's slug (derived from its text, or --as) must be free: supersede skips every
    // dedup tier, so without this the Tier-1 slug-existence check never runs and writeFileSync
    // would overwrite an unrelated fact sharing the slug (qp-supersedes-slug-collision-overwrite-kyd).
    // Self-supersede (slug === input.supersedes) is already rejected above, so any hit here is a
    // DIFFERENT fact. Client-facing (400) — the caller disambiguates with --as <unique-slug>.
    if (getFact(root, slug)) {
      throw new ClientError(`cannot supersede: the new fact's slug '${slug}' already names a different fact — pass --as <unique-slug> to disambiguate`);
    }
  }

  // NON-PORT (mem0 add(infer=True)): qmemd never LLM-distills a fact from a transcript on
  // the write path. The write loads NO model (I1) and needs NO API key (I5) — the fact text
  // is stored verbatim (writeFileSync below) EXCEPT a deterministic, model-free removal of a
  // closed set of known harness framing tokens (stripLeakedMarkup, qp-ey3) — a normalization
  // joining body.trimEnd(), NOT distillation/paraphrase; only this model-free dedup/classify walk runs.
  // Distillation is the agent's job, never the engine's. A future shared classifyCandidate()
  // (e11) extracted from this walk inherits the same rule: keep it model-free.
  // Dedup check — skipped when --replace, --force, or --supersedes is set (a successor
  // legitimately near-dups the fact it retires).
  if (!input.replace && !input.force && !input.supersedes) {
    // Tier 1: slug-existence check across ALL type folders (qmemd-bs0). Slugs must be globally
    // unique: getFact/forget/--replace each scan MEMORY_TYPES in order and resolve to the first
    // hit, so a same-slug fact written under a different type (an --as/--type collision) would be
    // permanently unreachable by every slug op. Resolve the slug the way getFact does — a hit in
    // any folder is the duplicate, reported with that fact's actual type/path (not the rejected
    // input's possibly-different --type). Same-type exact dups are unchanged: getFact resolves the
    // same file the old existsSync(memoryFilePath(root, type, slug)) did.
    const existingBySlug = getFact(root, slug);
    if (existingBySlug) {
      // No write happened, so nothing is newly unindexed (qmemd-32x). Surface the
      // colliding fact so the decider isn't blocked blind (qmemd-cs0).
      // A slug collision is NOT always a settled duplicate (qmemd-cbv): slugify truncates
      // at 60 chars on a word boundary, so two DISTINCT facts sharing a long prefix (or an
      // explicit --as reuse) land here with contradicting headlines. Run the same
      // classifier Tier-2/2.5 use — new headline vs the existing fact's name + firstLine —
      // so an identifier/polarity/antonym flip surfaces as a conflict with the authority
      // comparison instead of being mis-reported as disposition:'duplicate'.
      const disposition = classifyNearMatch(
        `${slug} ${firstLine(input.fact)}`,
        `${existingBySlug.frontmatter.name} ${firstLine(existingBySlug.body)}`,
      );
      return { wrote: false, slug, path: existingBySlug.path, type: existingBySlug.type, duplicateOf: slug, disposition, indexed: true, synced: true, dedupSkipped, ...duplicatePreview(root, slug),
        ...(disposition === "conflict" ? { authorityComparison: buildAuthorityComparison(root, type, input.source, slug) } : {}) };
    }

    // Tier 2: FTS near-duplicate check (different phrasing, same meaning).
    // BM25 IDF is near-zero for tiny collections so threshold is intentionally
    // very small — any positive hit counts.
    const hits = await store.searchLex(normalizeForHash(input.fact), { limit: 1, collection: MEMORY_COLLECTION });
    const top = hits[0];
    if (top !== undefined && top.score > DEDUP_SCORE_FTS) {
      const dupSlug = slugFromFilepath(top.filepath);
      // searchFTS returns a virtual "qmd://memory/<type>/<slug>.md" path; resolve
      // it back to a real filesystem path and the hit's actual type so the return
      // shape matches the Tier-1 (file-existence) branch.
      const stripped = top.filepath.startsWith("qmd://") ? top.filepath.slice(6) : top.filepath;
      const dupType = (stripped.split("/").slice(-2, -1)[0] ?? type) as MemoryType;
      const dupPath = memoryFilePath(root, dupType, dupSlug);
      // An FTS hit is usually a paraphrase to BLOCK, but BM25 also matches a CONTRADICTION
      // whose differing value still shares enough terms to clear the (tiny) floor — e.g.
      // "…JDK 21" vs "…JDK 25", where the i5y AND-query assumption does not hold and Tier-2
      // fires before Tier-2.5 can classify (qmemd-5td). Classify here too instead of assuming
      // "duplicate", mirroring Tier-2.5, so an FTS-caught conflict SURFACES with its authority
      // comparison rather than being silently swallowed as a dup. Fall back to "duplicate" if
      // the matched fact is unreadable (mirrors duplicatePreview — never block on the lookup).
      const existing = getFact(root, dupSlug);
      const disposition: RememberDisposition = existing
        ? classifyNearMatch(`${slug} ${firstLine(input.fact)}`, `${existing.frontmatter.name} ${firstLine(existing.body)}`)
        : "duplicate";
      // No write happened, so nothing is newly unindexed (qmemd-32x). Surface the
      // matched fact so the decider isn't blocked blind (qmemd-cs0).
      return { wrote: false, slug: dupSlug, path: dupPath, type: dupType, duplicateOf: dupSlug, disposition, indexed: true, synced: true, dedupSkipped, ...duplicatePreview(root, dupSlug),
        ...(disposition === "conflict" ? { authorityComparison: buildAuthorityComparison(root, type, input.source, dupSlug) } : {}) };
    }

    // Tier 2.5: model-free near-duplicate pre-pass (qmemd-i5y) + contradiction classifier
    // (qmemd-5td). The Tier-2 BM25 AND-query above is high-precision/low-recall — it misses a
    // near-dup the moment the new fact carries one token the existing fact lacks (a synonym or
    // an extra word). Scan the (tiny) corpus and compare token sets of name + first body line.
    // On a high-similarity match (the i5y Dice/overlap floor — `meets`, INCLUDING the
    // identifier-conflict case the i5y `duplicate` flag vetoes), classify the match: a true
    // paraphrase BLOCKS as a duplicate; a likely contradiction/update (differing version/
    // number, polarity flip, or antonym) SURFACES via the same cs0 shape so the agent resolves
    // it (replace/force/reword) instead of it being silently swallowed as a dup OR silently
    // written. Runs only when Tier-1/Tier-2 did not already fire.
    const newCompare = `${slug} ${firstLine(input.fact)}`;
    const scan = scanFacts(root);
    // Record skipped (unreadable) candidates so a dedup gap from corruption is visible on the
    // write path rather than silently widening the corpus (qmemd-e5h).
    dedupSkipped = scan.unreadable;
    for (const fact of scan.facts) {
      const existingCompare = `${fact.name} ${firstLine(fact.body)}`;
      const nd = nearDuplicate(newCompare, existingCompare);
      // `meets` = the raw similarity floor was hit. nearDuplicate folds the identifier veto
      // into `duplicate`, so reconstruct the pre-veto floor as duplicate || identifierConflict.
      if (nd.duplicate || nd.identifierConflict) {
        const dupPath = memoryFilePath(root, fact.type, fact.slug);
        const disposition = classifyNearMatch(newCompare, existingCompare);
        // Mirror the Tier-1/Tier-2 no-write shape (qmemd-32x/cs0), tagged with the disposition.
        // On a conflict, attach the authority comparison so the decider can weigh which wins (vkn).
        return { wrote: false, slug: fact.slug, path: dupPath, type: fact.type, duplicateOf: fact.slug, disposition, indexed: true, synced: true, dedupSkipped, ...duplicatePreview(root, fact.slug),
          ...(disposition === "conflict" ? { authorityComparison: buildAuthorityComparison(root, type, input.source, fact.slug) } : {}) };
      }
      // qmemd-733: a single differing value token (port/version/antonym) on a short headline
      // deflates Dice/overlap below the floor above, so the pair skipped classifyNearMatch and
      // the contradiction would be silently written. Surface that low-similarity conflict.
      if (lowSimilarityConflict(newCompare, existingCompare)) {
        const dupPath = memoryFilePath(root, fact.type, fact.slug);
        return { wrote: false, slug: fact.slug, path: dupPath, type: fact.type, duplicateOf: fact.slug, disposition: "conflict", indexed: true, synced: true, dedupSkipped, ...duplicatePreview(root, fact.slug),
          authorityComparison: buildAuthorityComparison(root, type, input.source, fact.slug) };
      }
    }
  }
  // Record-only conflict scan on --force (qmemd-cr4): --force skips dedup, so a forced
  // write past a contradiction used to leave two unmarked conflicting facts. Re-run the
  // model-free Tier-2.5 comparators purely to RECORD: first conflicting fact ⇒
  // conflicts_with stamped on the written file. Never blocks, never throws. Skipped when
  // the slug already exists (an in-place overwrite, not a second coexisting fact) and on
  // the explicit --supersedes path (the resolution is already recorded as a link).
  let conflictRecord: string | undefined;
  if (input.force && !input.replace && !input.supersedes && !existing) {
    try {
      const newCompare = `${slug} ${firstLine(input.fact)}`;
      for (const fact of scanFacts(root).facts) {
        const existingCompare = `${fact.name} ${firstLine(fact.body)}`;
        const nd = nearDuplicate(newCompare, existingCompare);
        const highSimConflict = (nd.duplicate || nd.identifierConflict)
          && classifyNearMatch(newCompare, existingCompare) === "conflict";
        if (highSimConflict || lowSimilarityConflict(newCompare, existingCompare)) {
          conflictRecord = fact.slug;
          break;
        }
      }
    } catch { /* record-only — a scan failure must never block a forced write */ }
  }
  // Per-field precedence: explicit input > existing fact's value > default. `existing`
  // is non-null only on the --replace/--force path over an existing slug (qmemd-q65).
  // description deliberately does NOT inherit — it always refreshes from the new body
  // (or --description), since the body is what changed. created is preserved from the
  // existing fact verbatim, even an empty legacy value (?? not || — fabricating today()
  // on replace would make an old fact look newest to authority/recency, qmemd-sr3).
  // updated is ALWAYS now — it stamps this write, never inherited (qmemd-bri).
  const fm: MemoryFrontmatter = {
    name: slug,
    description: input.description ?? firstLine(input.fact),
    type,
    tags: input.tags ?? existing?.frontmatter.tags ?? [],
    project: input.project ?? existing?.frontmatter.project ?? "global",
    platforms: platforms ?? existing?.frontmatter.platforms ?? [],
    created: existing?.frontmatter.created ?? today(),
    updated: new Date().toISOString(),
    pinned: input.pinned ?? existing?.frontmatter.pinned ?? false,
    // Link fields survive an in-place update (q65 pattern): replacing a superseding fact
    // keeps its forward link; replacing a superseded (hidden) fact keeps it retired.
    // input.supersedes takes priority: this write IS a supersession, so stamp it forward (bri).
    supersedes: input.supersedes ?? existing?.frontmatter.supersedes,
    supersededBy: existing?.frontmatter.supersededBy,
    conflictsWith: conflictRecord ?? existing?.frontmatter.conflictsWith,
    // "" = explicit clear (9su); absent = inherit on replace (q65 pattern).
    reviewBy: reviewBy === "" ? undefined : (reviewBy ?? existing?.frontmatter.reviewBy),
    source: input.source ?? existing?.frontmatter.source,
  };

  const dir = join(root, type);
  mkdirSync(dir, { recursive: true });
  const path = memoryFilePath(root, type, slug);
  // Post-condition (qp-ey3): stripLeakedMarkup is a fixed point, so the stored body MUST be
  // token-free. A survivor means detection and the stripper have drifted (two hand-synced
  // copies — qp-multiline-invoke-unstorable-xwz). Reject client-facing (ClientError → 400)
  // rather than persist corruption or throw an opaque internal 500 that makes the fact
  // permanently unstorable on every identical retry.
  if (leakedTokens.length > 0 && leakedMarkupTokens(input.fact).length > 0) {
    throw new ClientError("could not remove leaked tool-call markup from the fact — strip the framing tokens and retry");
  }
  writeFileSync(path, serializeMemory(fm, input.fact));

  // Supersede double-write (bri): stamp superseded_by onto the OLD fact via a surgical
  // single-line edit (setFrontmatterKey) — every other byte of a possibly hand-edited
  // legacy file is preserved; its `updated` is NOT bumped (content unchanged, only the
  // retirement marker moved). New fact is written FIRST, so a failure here leaves a
  // one-sided forward link that doctor --fix completes — never a lost fact.
  let supersedeWarning: string | undefined;
  const commitPaths: string[] = [`${type}/${slug}.md`];
  if (supersedeTarget) {
    try {
      const raw = readFileSync(supersedeTarget.path, "utf-8");
      // Fenceless target: setFrontmatterKey would no-op and the retired fact would stay
      // active in every recall lane while the commit claims otherwise (qp-yf2 C7). The
      // guard is locateFences, NOT written-bytes equality — an idempotent restamp of the
      // same slug writes identical bytes and is a success. doctor --fix completes the
      // link only after the fence is repaired by hand (MISSING_OPEN is not fixable).
      if (!locateFences(raw)) {
        supersedeWarning = `fact written, but '${input.supersedes}' has no frontmatter fence — superseding link not stamped; repair its frontmatter ('qmemd doctor' locates it), then run 'qmemd doctor --fix' to complete the link`;
        console.error(`[qmemd] remember '${slug}': ${supersedeWarning}`);
      } else {
        writeFileSync(supersedeTarget.path, setFrontmatterKey(raw, "superseded_by", yamlScalar(slug)));
        commitPaths.push(`${supersedeTarget.type}/${supersedeTarget.slug}.md`);
      }
    } catch (e) {
      // e.message (ENOENT/EACCES) embeds the absolute path — keep it on stderr only;
      // the surfaced warning must stay path-free (qmemd-81n).
      supersedeWarning = `fact written, but superseding link could not be stamped onto '${input.supersedes}' — run 'qmemd doctor --fix' to complete it`;
      console.error(`[qmemd] remember '${slug}': ${supersedeWarning} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Commit before indexing so a reindex failure can never strand an uncommitted
  // file. Indexing is best-effort: if it throws (e.g. SQLITE_BUSY under concurrent
  // writers), the fact is still saved + committed and recallSession (filesystem)
  // sees it immediately; the lex index self-heals on the next remember/forget.
  const commitMsg = supersedeTarget ? `remember: ${slug} (supersedes ${input.supersedes})` : `remember: ${slug}`;
  const commit = gitCommit(root, commitMsg, commitPaths, git);
  const push = gitPush(root, git);
  const { synced, syncWarning } = syncOutcome(commit, push);
  if (syncWarning) console.error(`[qmemd] remember '${slug}': ${syncWarning}`);
  // A corruption-driven dedup gap is best-effort-surfaced, mirroring the sync/index warnings:
  // this fact may duplicate one of the unreadable candidates the near-dup scan skipped (e5h).
  if (dedupSkipped > 0) console.error(`[qmemd] remember '${slug}': ${dedupSkipped} candidate fact(s) unreadable during the near-dup scan — a duplicate may have been missed; run 'qmemd doctor'`);
  // Non-blocking report-shape nudge (qmemd-a3k): the fact is already written; the message rides
  // back on the result for the CLI/MCP to surface (a content-shape hint belongs at the
  // presentation boundary, rendered once per surface — unlike the operational sync/dedup warnings
  // the engine also logs to stderr). undefined ⇒ fact-shaped input, nothing to flag.
  const reportWarning = reportShapeWarning(input.fact) ?? undefined;
  let indexed = true;
  try {
    await reindexMemory(store); // lex-index now; vec built lazily on first hybrid recall
  } catch (e) {
    // Surface the index lag via indexed:false (qmemd-32x) so callers can warn.
    indexed = false;
    console.error(`[qmemd] reindex after remember failed (fact saved + committed): ${e instanceof Error ? e.message : String(e)}`);
  }

  return { wrote: true, slug, path, type, indexed, synced, syncWarning, dedupSkipped, reportWarning, sanitizedWarning,
    supersededSlug: input.supersedes, conflictsWith: conflictRecord, supersedeWarning };
}

// =============================================================================
// recallQuery() — FTS/hybrid search returning typed RecallHit[]
// =============================================================================

export interface RecallHit {
  slug: string;
  path: string;        // real filesystem path
  type: MemoryType | string;
  description: string;
  /** Hybrid recall: the reranker's CALIBRATED relevance (~0.5 neutral, ~0.7+ relevant) —
   *  NOT qmd's position-dominated blended score (qmemd-373); hits are ordered by it.
   *  lexOnly recall: the BM25 score (no reranker runs). Falls back to the blended score
   *  on the hybrid path only when rerank was skipped (explain absent). */
  score?: number;
  body?: string;       // body preview, truncated to RECALL_BODY_CAP unless fullBody (bgf)
  /** OS families this fact applies to (from frontmatter); [] = cross-platform. */
  platforms: Platform[];
  /** The fact's project scope from frontmatter (qmemd-due): a project name or "global". Always
   *  populated by recall; surfaced so a caller can tell a current-project hit from a foreign one. */
  project: string;
  /** True when this hit was readmitted by the below-floor rescue (qp-dnx): its raw rerankScore is
   *  just under the relevance floor but it carries distinctive query overlap. The displayed `score`
   *  stays RAW (sub-floor) so a caller can mark it low-confidence. Absent on normal hits. */
  rescued?: boolean;
}

/**
 * Default hybrid-recall relevance floor (rde). The floor is applied to the RERANKER
 * score (explain.rerankScore), which is the reranker's calibrated relevance judgment:
 * measured ~0.50 for irrelevant/neutral hits and ~0.70+ for genuinely relevant ones.
 * 0.575 sits just below the relevant band — tuned down from 0.6 after a corpus sweep
 * found relevant-but-secondary facts at the ~0.58 margin (e.g. an embedding-config
 * fact at 0.581), while genuine noise stays at ~0.50–0.56. NOTE: we floor on the
 * rerankScore, NOT qmd's blended `HybridQueryResult.score` — that one is position-
 * dominated (rank-1 gets a large RRF top-rank bonus → ~0.9 even when irrelevant), so it
 * is a rank proxy, not a confidence signal. recallQuery surfaces this same rerankScore
 * as the hit's `score` and orders by it (qmemd-373). Override per call via
 * RecallOptions.minScore; pass 0 to disable.
 */
export const DEFAULT_MIN_SCORE = 0.575;

/** Width of the rerank-score band treated as "effectively equal relevance" for the
 *  recency tie-break (bri). Scores are BUCKETED (rounded to this width) then compared —
 *  a transitive comparator, unlike a raw |Δ|<ε check — and the raw score is never
 *  mutated, so the minScore floor and the exposed hit.score stay calibrated. */
export const RECENCY_TIE_BUCKET = 0.02;

/** Static stoplist for the recall overlap boost (qp-dnx): high-frequency tokens that carry no
 *  project signal, so a shared occurrence must NOT promote or rescue a fact. Kept STATIC (not
 *  corpus document-frequency) so the boost stays deterministic and test-stable as the corpus
 *  grows — slug∪project tokens are inherently high-IDF, this only guards the generic tail. */
export const RECALL_BOOST_STOPLIST: ReadonlySet<string> = new Set([
  "test", "build", "git", "repo", "spring", "boot", "gotcha", "qmemd", "service", "app", "fix",
]);

/** Max in-hand-pool document-frequency for a query-overlap token to still count as distinctive
 *  (qp-mgm): a token shared by MORE than this many of the retrieved candidates is pool-common
 *  topic noise (e.g. "port" across six port facts, "k3s" across two k3s facts) and is dropped, so
 *  it can no longer drive the tie-break or rescue a near-miss. 1 ⇒ the token must be UNIQUE to a
 *  single candidate in the pool. This is pool-DF over the ≤40 IN-HAND candidates, NOT corpus-DF —
 *  it adapts to the query's own pool yet stays deterministic + test-stable (the static stoplist
 *  remains the universal floor; pool-DF is the corpus-adaptive layer the chair adjudicated). */
export const RECALL_POOL_DF_MAX = 1;

/** Per-token document-frequency over the in-hand candidate pool (qp-mgm): the number of candidates
 *  whose {slug ∪ project ∪ tags} signal contains each token (counted once per fact — DF, not TF).
 *  Fed to distinctiveOverlap's pool-DF gate so a token common across the retrieved pool stops
 *  counting as distinctive. The pool is the gated above- + below-floor candidates already in hand,
 *  so this adds no search round-trip and no corpus scan. */
export function poolDocFreq(facts: Array<{ slug: string; project?: string; tags?: string[] }>): Map<string, number> {
  const df = new Map<string, number>();
  for (const f of facts) {
    const signal = [f.slug, f.project ?? "", ...(f.tags ?? [])].join(" ");
    for (const t of new Set(tokenizeForDedup(signal))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/** Distinctive-token overlap between a query and a fact's {slug ∪ project ∪ tags} (qp-dnx): the
 *  count of shared tokens after dropping the static stoplist. The recall ordering tie-break and
 *  the below-floor rescue both key on this — a model-free, deterministic relevance signal the
 *  position-dominated reranker under-weights for project-named facts. Reuses tokenizeForDedup so
 *  it shares the engine's tokenization (semver-aware, stopword-filtered). When `poolDf` is supplied
 *  (qp-mgm), a query-overlap token whose pool document-frequency exceeds RECALL_POOL_DF_MAX is
 *  dropped as pool-common — this is what stops a topically-adjacent below-floor fact (the measured
 *  k3s→grafana false promotion) from being rescued on a shared term. Omitting `poolDf` keeps the
 *  legacy stoplist-only behaviour (back-compat for callers without a pool in hand). */
export function distinctiveOverlap(query: string, fact: { slug: string; project?: string; tags?: string[] }, poolDf?: ReadonlyMap<string, number>): number {
  const q = new Set(tokenizeForDedup(query));
  if (q.size === 0) return 0;
  const signal = [fact.slug, fact.project ?? "", ...(fact.tags ?? [])].join(" ");
  let n = 0;
  for (const t of new Set(tokenizeForDedup(signal))) {
    if (!q.has(t) || RECALL_BOOST_STOPLIST.has(t)) continue;
    if (poolDf && (poolDf.get(t) ?? 0) > RECALL_POOL_DF_MAX) continue; // pool-common ⇒ non-distinctive
    n++;
  }
  return n;
}

/** Below-floor rescue eligibility (qp-dnx): a candidate the relevance floor dropped is eligible
 *  for tail backfill ONLY when its RAW rerankScore sits within `delta` just below the effective
 *  floor AND it carries ≥1 distinctive query-overlap token. The floor decision itself stays on the
 *  raw score (the calibration invariant, engine.ts:1643) — rescue is a narrow, evidence-gated
 *  readmission of near-miss on-target facts, never a floor move. `delta` 0 disables it. */
export function isRescueEligible(rawScore: number, overlap: number, effectiveMinScore: number, delta: number): boolean {
  return overlap >= 1 && rawScore < effectiveMinScore && rawScore >= effectiveMinScore - delta;
}

/** Below-floor rescue band width (qp-dnx): a dropped candidate within this much of the floor is
 *  rescue-eligible when it carries distinctive overlap. Default 0.05 covers measured near-misses
 *  (~0.52–0.57) while excluding the ~0.50 noise band. */
export const DEFAULT_RESCUE_DELTA = 0.05;

/** The rescue band, read at CALL time from QMEMD_RESCUE_DELTA (the embedTimeoutMs precedent) so
 *  tests/daemons can retune it. Unset / empty / whitespace / non-numeric / negative all fall back
 *  to DEFAULT_RESCUE_DELTA — only an EXPLICIT `0` disables BOTH the rescue and the overlap tie-break
 *  → bit-exact pre-feature recall (the master kill switch). The empty-string guard matters: an
 *  `export QMEMD_RESCUE_DELTA=` (a common "clear the var" idiom) is Number("") === 0, which would
 *  otherwise silently disable the feature instead of meaning "unset" (M1). */
export function rescueDelta(): number {
  const raw = process.env.QMEMD_RESCUE_DELTA;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESCUE_DELTA;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESCUE_DELTA;
}

/** Max below-floor facts rescued per recall (qp-dnx): caps the low-confidence tail so a rescue
 *  can never flood the result (risk-lens cap K). */
export const RECALL_RESCUE_CAP = 2;

export interface RecallOptions {
  type?: MemoryType;  // scope to one folder
  limit?: number;
  lexOnly?: boolean;  // skip vec/rerank (fast, model-free)
  fullBody?: boolean; // attach the full untruncated body (CLI --full); default capped (bgf)
  skim?: boolean;     // headline-only: omit the body entirely (CLI --skim); wins over fullBody (r0u)
  /** Hybrid-recall relevance floor: drop hits whose RERANKER score is below this.
   *  Defaults to DEFAULT_MIN_SCORE; pass 0 to disable. We floor on the reranker's
   *  relevance (~0.5 neutral / ~0.7+ relevant), NOT the exposed blended score, which
   *  is position-dominated and so anti-correlated with relevance at the margin (rde).
   *  IGNORED in lexOnly mode — the lex path runs no reranker (fast, model-free). */
  minScore?: number;
  /** Host-OS gate (default currentPlatform()): drop hits not valid on this platform.
   *  "all" disables the gate (deliberate cross-host lookup). Independent of minScore —
   *  a hit must be relevant-enough AND on-platform. */
  platform?: Platform | "all";
  /** Caller's current project (qmemd-due). When set AND crossProject is off, recall is gated to
   *  facts whose frontmatter.project is this value OR "global" — the same scope as recallSession's
   *  inProject gate (engine.ts:552). Undefined ⇒ NO project gate (whole corpus, the behaviour that
   *  predates this feature), so every existing caller is unaffected. */
  project?: string;
  /** Widen past the project gate to the whole corpus (qmemd-due). Foreign-project hits are then
   *  returned (and labelled by the caller). Ignored when project is undefined (no gate to widen). */
  crossProject?: boolean;
}

/** Parse a virtual "qmd://memory/<type>/<slug>.md" filepath into {type, slug}. */
function parseVirtualMemoryPath(filepath: string): { type: string; slug: string } {
  const stripped = filepath.startsWith("qmd://") ? filepath.slice(6) : filepath;
  const segs = stripped.split("/");
  const slug = (segs.pop() ?? "").replace(/\.md$/, "");
  const type = segs.pop() ?? "";
  return { type, slug };
}

export interface RecallResult {
  hits: RecallHit[];
  /**
   * True when a HYBRID recall ran while the vector index was NOT fully built — the embed
   * barrier threw (model unavailable, e.g. the Mac metal load failure) or only partially
   * embedded — so the result silently degraded toward lexical and may miss semantic matches
   * (qmemd-9t1). Without this, recall returns a normal-looking hit list and the agent cannot
   * tell no-relevant-facts from semantic-half-skipped (the false-completeness trap the
   * recall-skip postmortem R1 flags). Always false for a lexOnly recall (no embed is
   * attempted by design) and for a warm hybrid recall.
   */
  degraded: boolean;
  /** Vectors still pending after the embed barrier — the count behind a degraded result, 0
   *  when not degraded. Best-effort: the pre-embed count when embed threw, or -1 (unknown)
   *  when getStatus itself threw and no count could be read. Render via pendingVectorPhrase. */
  vectorsPending: number;
  /** In-scope matches past `limit` (40h): hits that passed every gate (floor, type, platform)
   *  but were cut by the hit cap. A LOWER BOUND when `saturated` — the pool may have hidden
   *  more. Raising `limit` surfaces them. */
  moreMatches: number;
  /** Hybrid only (40h): hits the rerank floor (opts.minScore ?? DEFAULT_MIN_SCORE) dropped
   *  that would otherwise be in scope — counted AFTER the type/platform gates, so the number
   *  never advertises facts a lower floor would still not show. Always 0 for lexOnly (the lex
   *  path runs no reranker). */
  belowFloor: number;
  /** True when the final search pool came back full AND the corpus is known (or assumed, on a
   *  failed status read) to extend past it (40h): matching rows may sit past the pool cap, so
   *  `moreMatches` is a lower bound and more may match even when it is 0. Cleared when the
   *  pool covered the whole corpus — by the qmemd-amm refetch or because totalDocuments <=
   *  pool size — since nothing can sit past such a pool. */
  saturated: boolean;
  /** Relevant matches the DEFAULT project gate hid (qmemd-due): hits that passed type+platform+floor
   *  but belong to another project. Drives the "N cross-project matches hidden" footer. Always 0 when
   *  crossProject is true (the gate is skipped) or no project was supplied (no gate ran). A lower
   *  bound when `saturated`, like moreMatches/belowFloor. */
  crossProjectHidden: number;
}

/** Human phrase for the pending-vector count in a degraded-recall warning (qmemd-9t1), shared
 *  by the CLI + MCP renderers so the wording can't drift. -1 is the unknown sentinel (getStatus
 *  threw) — rendered as words rather than a misleading "-1 vector(s)". */
export function pendingVectorPhrase(vectorsPending: number): string {
  return vectorsPending < 0 ? "an unknown number of vectors" : `${vectorsPending} vector(s)`;
}

/** One-line completeness footer for a recall result (qmemd-40h), shared by the CLI and MCP
 *  renderers so the wording can't drift (the pendingVectorPhrase precedent). Returns null
 *  when the result is complete — the common clean recall stays silent. `effectiveMinScore`
 *  is the floor that actually applied (opts.minScore ?? DEFAULT_MIN_SCORE); `style` picks
 *  the parameter spelling: CLI flags (--limit/--min-score) vs API params (limit/minScore). */
export function completenessFooter(
  res: Pick<RecallResult, "moreMatches" | "belowFloor" | "saturated"> & { crossProjectHidden?: number },
  effectiveMinScore: number,
  style: "cli" | "api",
): string | null {
  const limitArg = style === "cli" ? "--limit" : "limit";
  const floorArg = style === "cli" ? "--min-score" : "minScore";
  const crossArg = style === "cli" ? "--cross-project" : "cross_project";
  const hidden = res.crossProjectHidden ?? 0;
  const parts: string[] = [];
  if (res.moreMatches > 0) parts.push(`${res.moreMatches}${res.saturated ? "+" : ""} more match (raise ${limitArg})`);
  else if (res.saturated) parts.push(`more may match (raise ${limitArg})`);
  if (hidden > 0) parts.push(`${hidden} cross-project match${hidden === 1 ? "" : "es"} hidden (${crossArg} to include)`);
  if (res.belowFloor > 0) parts.push(`${res.belowFloor} below the ${effectiveMinScore} relevance floor (${floorArg} 0 shows all)`);
  return parts.length ? parts.join("; ") : null;
}

/**
 * Default bound on the lazy embed barrier (cw2). 6s gives the warm/normal model load ample
 * room while keeping a stalled cold start from hanging recall (gbrain uses the same figure
 * as headroom under a 10s force-exit).
 */
export const DEFAULT_EMBED_TIMEOUT_MS = 6000;

/**
 * Embed-barrier bound: QMEMD_EMBED_TIMEOUT_MS override when it parses to a positive number,
 * else the default (cw2). Read at call time, not module load, so tests/daemons can retune it.
 */
export function embedTimeoutMs(): number {
  const n = Number(process.env.QMEMD_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMBED_TIMEOUT_MS;
}

/**
 * Race a promise against a deadline; rejects with a descriptive Error on timeout. The raced
 * promise is NOT cancelled (qmd exposes no cancellation) — the caller must handle its late
 * settlement. The timer is always cleared, so a fast win never strands a pending timeout.
 */
async function raceTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * recallQuery + the embed-barrier health signal (qmemd-9t1). Identical search to recallQuery,
 * but returns degraded/vectorsPending so a caller (CLI/MCP/REST) can warn that a hybrid recall
 * silently fell back toward lexical, mirroring the remember-path indexed:false signal.
 * recallQuery is the hits-only convenience over this.
 */
export async function recallQueryWithStatus(store: QMDStore, root: string, query: string, opts: RecallOptions = {}): Promise<RecallResult> {
  const limit = opts.limit ?? 10;
  const effPlatform = opts.platform ?? currentPlatform();
  // Over-fetch BEFORE the metadata gate below: the store ranks across all types AND
  // ignores platforms (not an index field), so matching on-type / on-platform facts may
  // sit just past the top-`limit`. Widen whenever a type OR a platform filter is active
  // (qmemd-pwn extended). Only MEMORY_TYPES.length types exist, so limit*N is an ample
  // first-pass pool; a saturated underflow refetches the whole corpus below (qmemd-amm).
  // Project gate (qmemd-due) is active only with an explicit project and crossProject off.
  const projectGateActive = opts.project !== undefined && !opts.crossProject;
  const widen = opts.type !== undefined || effPlatform !== "all" || projectGateActive;
  const fetchLimit = widen ? limit * MEMORY_TYPES.length : limit;

  // Embed-barrier health (qmemd-9t1): set on the hybrid path, stays false/0 for lexOnly.
  let degraded = false;
  let vectorsPending = 0;
  // Barrier timed out or threw ⇒ the model is unavailable; the search below must take the
  // model-free lex path — a hybrid search would re-attempt the same model load and hang or
  // throw all over again (cw2). Distinct from a PARTIAL embed (no throw, some vectors still
  // pending), where the model works and hybrid remains the better search.
  let lexFallback = false;

  // Lazy embed barrier (replaces the old watch daemon), run ONCE before any (re)fetch:
  // writes are lex-only, so the first hybrid recall embeds whatever is still pending before
  // searching. getStatus() is a cheap DB query (no model load) and gates embed() so we never
  // embed when nothing is pending. A failed/partial embed must not crash recall — the search
  // below then behaves exactly as it would have without this barrier, but we record the
  // degradation (qmemd-9t1) so the caller can surface it instead of a normal-looking but
  // semantically incomplete list.
  if (!opts.lexOnly) {
    try {
      vectorsPending = (await store.getStatus()).needsEmbedding;
      if (vectorsPending > 0) {
        // Bounded await (cw2): a stalled cold model load otherwise hangs every
        // first-after-write hybrid recall. The losing embed keeps running unawaited (no
        // cancellation in qmd) — swallow its eventual rejection so it cannot surface as an
        // unhandled rejection after recall has already returned. If it eventually SUCCEEDS,
        // the next hybrid recall simply finds nothing pending.
        const embedRun = store.embed({ collection: MEMORY_COLLECTION });
        embedRun.catch(() => {});
        await raceTimeout(embedRun, embedTimeoutMs(), "embed on recall");
        // Re-read: a successful embed clears the queue; a partial one (some docs failed)
        // leaves vectors pending, and the hybrid search then ran without them.
        vectorsPending = (await store.getStatus()).needsEmbedding;
      }
    } catch (e) {
      // embed timed out/threw (or getStatus threw) — vectors are not built; fail open to
      // the lex path below. vectorsPending holds the last known (pre-embed) count.
      console.error(`[qmemd] embed on recall failed: ${e instanceof Error ? e.message : String(e)}`);
      degraded = true;
      lexFallback = true;
      // A 0 here can ONLY mean the FIRST getStatus() (line above) threw before any count was
      // read — every other catch path runs embed only when vectorsPending was already >0, and
      // a 0 from getStatus skips the embed block entirely (no throw). So 0-in-catch ⟺ count
      // unreadable: flag it -1 (unknown) so the warning doesn't read a misleading "0 pending".
      if (vectorsPending === 0) vectorsPending = -1;
    }
    // Degraded when the barrier could not finish embedding: it threw, or vectors remain
    // pending after it (a partial embed). lexOnly never reaches here, so it is never degraded.
    degraded = degraded || vectorsPending > 0;
  }

  const minRerank = opts.minScore ?? DEFAULT_MIN_SCORE;
  // Map one index row to a typed hit, or null (warning on stderr) when the path's type
  // segment is not a real MemoryType — qmd indexes only <type>/<slug>.md under the memory
  // root, so anything else is a malformed/stale index row. The old `(type || "reference")`
  // fallback silently relabeled such hits under a fabricated reference path, masking index
  // corruption instead of surfacing it (qmemd-4ri).
  const toHit = (filepath: string, title: string | undefined, score: number | undefined): RecallHit | null => {
    const { type, slug } = parseVirtualMemoryPath(filepath);
    if (!(MEMORY_TYPES as string[]).includes(type)) {
      console.error(`[qmemd] recall: skipping malformed index path '${filepath}' (type segment '${type}' is not a memory type) — run qmemd reindex`);
      return null;
    }
    // platforms is a placeholder ([]) here; the real value is read from frontmatter in the
    // gate below (it is not an index field, so search can't carry it).
    return { slug, type, path: memoryFilePath(root, type as MemoryType, slug), description: title ?? "", score, platforms: [] as Platform[], project: "global" };
  };

  // One (re)fetch at a given pool size → ranked hits PLUS the RAW result count (the store's
  // pre-relevance-floor row count), so the refetch logic can tell a SATURATED pool (more facts
  // existed past it) from an EXHAUSTED corpus. Re-runnable so a platform-gated underflow can
  // widen the pool without re-running the one-time embed barrier above.
  const runSearch = async (n: number): Promise<{ hits: RecallHit[]; rawCount: number; floorDropped: RecallHit[] }> => {
    if (opts.lexOnly || lexFallback) {
      // searchFTS returns SearchResult[] — uses .filepath and .title.
      const results = await store.searchLex(query, { limit: n, collection: MEMORY_COLLECTION });
      const rawCount = results.length; // RAW row count — no relevance floor on the lex path
      const hits = results.flatMap(r => toHit(r.filepath, r.title, r.score) ?? []);
      return { hits, rawCount, floorDropped: [] }; // no reranker on the lex path → nothing floored (40h)
    }
    // hybridQuery returns HybridQueryResult[] — uses .file (NOT .filepath) and .title.
    // Floor on the RERANKER score (explain.rerankScore), NOT the exposed .score: the latter
    // is qmd's position-blended score, dominated by an RRF top-rank bonus, so it reads ~0.9
    // for rank-1 even when irrelevant and cliffs for rank-2 even when relevant — a rank proxy,
    // not a confidence signal. rerankScore is the reranker's calibrated relevance (~0.5
    // neutral, ~0.7+ relevant) and DOES separate the two. So we request explain traces and
    // filter rerankScore ourselves; qmd's native minScore (which filters the blended .score)
    // is deliberately NOT used (rde). `?? DEFAULT_MIN_SCORE` defaults an absent floor; an
    // explicit 0 disables it.
    const results = await store.search({ query, collection: MEMORY_COLLECTION, limit: n, explain: true });
    // RAW row count, captured BEFORE the minRerank filter below — this is the saturation signal
    // (`rawCount === fetchLimit` ⇒ the store hit the pool cap and may have more), NOT the
    // post-floor survivor count. A future edit must not move this past the .filter().
    const rawCount = results.length;
    // Partition on the floor instead of filtering (40h): the dropped half feeds the belowFloor
    // completeness counter after the type/platform gate, so "N below floor" only counts facts
    // a lower --min-score would actually surface. A hit with no explain (rerank skipped) is
    // kept, never counted as dropped (best-effort, rde).
    const kept: typeof results = [];
    const dropped: typeof results = [];
    for (const r of results) {
      const s = r.explain?.rerankScore;
      (s === undefined || s >= minRerank ? kept : dropped).push(r);
    }
    const hits = kept
      // Expose the reranker's CALIBRATED relevance (explain.rerankScore) as the hit score —
      // NOT qmd's blended r.score, which is position-dominated (rank-1 ≈ 0.9 even for a weak
      // match) and so an over-confident rank proxy the agent mis-reads (qmemd-373). Fall back
      // to the blended score only when rerank was skipped (explain absent).
      .flatMap(r => toHit(r.file, r.title, r.explain?.rerankScore ?? r.score) ?? [])
      // Order by that calibrated score so the exposed scores are monotonic and the top-`limit`
      // slice (below) keeps the most RELEVANT hits, not the highest RRF position — a weak
      // rank-1 can no longer sit above a strong rank-2 (qmemd-373).
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const floorDropped = dropped.flatMap(r => toHit(r.file, r.title, r.explain?.rerankScore ?? r.score) ?? []);
    return { hits, rawCount, floorDropped };
  };

  // Parse each candidate file at most ONCE, even across a refetch — platforms live in the
  // file frontmatter (NOT the search index), so the gate needs a read; caching keeps an
  // escalating refetch from re-reading the same files (bounds the I/O multiplier in qmemd-amm).
  // A read failure yields fm=null and fails open in the gate, matching the prior unreadable-skip.
  const parseCache = new Map<string, ParsedMemory | null>();
  const parseOnce = (path: string): ParsedMemory | null => {
    if (!parseCache.has(path)) {
      try { parseCache.set(path, parseMemory(readFileSync(path, "utf-8"))); }
      catch { parseCache.set(path, null); }
    }
    return parseCache.get(path) ?? null;
  };
  // Metadata gates BEFORE the slice: type (same semantics as before — path-derived h.type)
  // AND platformVisible. Both are hard predicates ANDed with the relevance floor already
  // applied above; a fact must be relevant-enough AND on-type AND on-platform AND not retired.
  // Fail-open: an unreadable candidate (fm null) treats its platforms as [] (cross-platform)
  // and supersededBy as absent, so it passes both gates — preserving the prior shown-anyway
  // behaviour. Superseded = retired (bri): hidden from query recall like the session snapshot.
  // In-scope predicate (qmemd-due): the fact's project matches the caller's, or is global.
  // Fail-open — an unreadable fact (fm null) reads as "global" and so is shown, matching the
  // platform gate's shown-anyway default.
  const inProject = (fm: ParsedMemory | null): boolean => {
    const p = fm?.frontmatter.project ?? "global";
    return p === opts.project || p === "global";
  };
  // gate() partitions the hard-gated pool on the project scope so the foreign-but-relevant count
  // feeds the hidden footer (qmemd-due) — the same kept/dropped discipline as the relevance floor
  // (engine.ts:1858). `kept` = type+superseded+platform pass AND (gate inactive OR in-project);
  // `projectDropped` = those a *default* recall hid by project (always 0 when the gate is inactive).
  const gate = (hits: RecallHit[]): { kept: Array<{ h: RecallHit; fm: ParsedMemory | null }>; projectDropped: number } => {
    const kept: Array<{ h: RecallHit; fm: ParsedMemory | null }> = [];
    let projectDropped = 0;
    for (const h of hits) {
      const fm = parseOnce(h.path);
      if (opts.type && h.type !== opts.type) continue;
      if (fm?.frontmatter.supersededBy) continue;
      if (!platformVisible(fm ? (fm.frontmatter.platforms ?? []) : [], effPlatform)) continue;
      if (!projectGateActive || inProject(fm)) kept.push({ h, fm });
      else projectDropped++;
    }
    return { kept, projectDropped };
  };

  // Initial fetch + refetch-on-underflow (qmemd-amm): the platform gate runs AFTER ranking
  // over a bounded pool, so on-platform facts can sit past the pool when many higher-ranked
  // off-platform facts match. When the gate leaves fewer than `limit` hits BUT the pool was
  // saturated (rawCount === fetchLimit ⇒ the store had more to give), refetch the whole ranked
  // corpus once and re-gate — escalating straight to totalDocuments is exact and costs at most
  // one extra round-trip (no geometric-growth loop). A NON-saturated pool means the corpus is
  // already exhausted, so the underflow is real and we keep what we have. Same drop-class as
  // qmemd-pwn, extended to the platform dimension.
  let { hits, rawCount, floorDropped } = await runSearch(fetchLimit);
  let { kept: gated, projectDropped: crossProjectHidden } = gate(hits);
  // Saturation (40h): the store returned exactly the pool we asked for, so matching rows may
  // sit past the cap — the completeness counters below are then lower bounds. Resolved against
  // the corpus size (one cheap status query, no extra search): a pool that already covered the
  // whole corpus is exhaustion, not saturation. The corpus-wide refetch clears it the same way:
  // its pool IS the corpus, nothing can sit past it. A failed getStatus (total 0) keeps the
  // flag conservatively true.
  let saturated = rawCount === fetchLimit;
  if (saturated) {
    const total = await store.getStatus().then(s => s.totalDocuments).catch(() => 0);
    if (widen && gated.length < limit && total > fetchLimit) {
      ({ hits, floorDropped } = await runSearch(total));
      ({ kept: gated, projectDropped: crossProjectHidden } = gate(hits));
      saturated = false;
    } else if (total > 0 && total <= fetchLimit) {
      saturated = false;
    }
  }

  // Recency tie-break (bri): equal-bucket hits order by updated (falling back to created).
  // Hybrid scores are calibrated 0..1 → bucket by RECENCY_TIE_BUCKET; lex BM25 has no
  // calibrated scale → only EXACT ties break by recency. Runs on the gated pool so the
  // top-`limit` slice gives the last slot to the fresher of two equally-relevant facts.
  // Raw hit.score is never mutated — the sort key uses a derived bucket, not the score field.
  const recencyOf = (fm: ParsedMemory | null): string =>
    fm ? (fm.frontmatter.updated ?? fm.frontmatter.created) : "";
  const scoreKey = (s: number | undefined): number =>
    opts.lexOnly ? (s ?? -1) : Math.round((s ?? -1) / RECENCY_TIE_BUCKET);
  // Overlap tie-break (qp-dnx): WITHIN an equal score bucket, a fact whose {slug∪project∪tags}
  // shares distinctive tokens with the query orders ahead of an equally-relevant one that does
  // not — fixing the reranker's under-weighting of project-named facts. Pure tie-break: ranked
  // BELOW the score key, so it can never leapfrog a higher-scored hit (the calibration invariant
  // holds). Hybrid only, gated by the same QMEMD_RESCUE_DELTA>0 master switch as the rescue, so
  // delta=0 is bit-exact pre-feature. Raw hit.score is never mutated — overlap is a derived key.
  const delta = rescueDelta();
  const boostOn = !opts.lexOnly && delta > 0;
  // Gate the below-floor candidates NOW (not just for the rescue below) so the pool-DF map can
  // span the WHOLE in-hand pool — above- AND below-floor — that the tie-break + rescue draw from
  // (qp-mgm). gate() reuses parseOnce's cache, so this is bounded reads, no extra search.
  const belowFloorGated = gate(floorDropped).kept;
  // Pool-DF over the in-hand candidates (qp-mgm): a query-overlap token common across the pool is
  // non-distinctive topic noise (e.g. "port" across six port facts, "k3s" across two k3s facts) and
  // must not drive the tie-break or rescue a near-miss. Built once, only when the boost is on, and
  // shared by both keys below — pool-DF (NOT corpus-DF) keeps it deterministic + test-stable.
  const poolDf = boostOn
    ? poolDocFreq([...gated, ...belowFloorGated].map(({ h, fm }) => ({ slug: h.slug, project: fm?.frontmatter.project, tags: fm?.frontmatter.tags })))
    : undefined;
  const overlapCache = new Map<string, number>();
  const overlapOf = (e: { h: RecallHit; fm: ParsedMemory | null }): number => {
    if (!boostOn) return 0;
    let v = overlapCache.get(e.h.path); // memoize: the comparator below queries each entry O(log n) times
    if (v === undefined) {
      v = distinctiveOverlap(query, { slug: e.h.slug, project: e.fm?.frontmatter.project, tags: e.fm?.frontmatter.tags }, poolDf);
      overlapCache.set(e.h.path, v);
    }
    return v;
  };
  gated.sort((a, b) =>
    (scoreKey(b.h.score) - scoreKey(a.h.score))
    || (overlapOf(b) - overlapOf(a))
    || recencyOf(b.fm).localeCompare(recencyOf(a.fm)));

  // Enforce the user-visible limit after the gates (the over-fetch pulled a wider pool;
  // a non-widened recall already fetched exactly `limit`, so this slice is a no-op there).
  const limited = gated.slice(0, limit);
  // Completeness counter (40h): respects the type/platform gates so it only counts facts the
  // caller could surface by raising limit. (belowFloorGated — the below-floor counter input — is
  // gated once above, before the tie-break, so the pool-DF map can span the full in-hand pool.)
  const moreMatches = gated.length - limited.length;

  // Below-floor rescue (qp-dnx): BACKFILL the empty slots (never evict a real hit) with near-miss
  // on-target facts — a raw rerankScore just under the floor AND distinctive query overlap on
  // {slug∪project∪tags}. Hybrid only (the lex path floors nothing, so floorDropped is empty).
  // QMEMD_RESCUE_DELTA=0 disables it → bit-exact pre-feature recall. The floor decision above is
  // NOT touched — picks are readmitted to the tail, the calibrated 0.575 floor never moved (the
  // calibration invariant, engine.ts:1643). Capped at RECALL_RESCUE_CAP so a rescue can't flood.
  // `delta` (the master switch) was resolved once above for the overlap tie-break — reuse it.
  const rescueRoom = Math.max(0, limit - limited.length);
  const rescuePicks = delta > 0 && rescueRoom > 0 && !opts.lexOnly
    ? belowFloorGated
        .filter(({ h, fm }) => isRescueEligible(
          h.score ?? -1,
          distinctiveOverlap(query, { slug: h.slug, project: fm?.frontmatter.project, tags: fm?.frontmatter.tags }, poolDf),
          minRerank, delta))
        .sort((a, b) => (b.h.score ?? -1) - (a.h.score ?? -1)) // best near-miss first
        .slice(0, Math.min(RECALL_RESCUE_CAP, rescueRoom))
    : [];
  // A rescued fact is no longer a hidden below-floor match — it was surfaced. Decrement the
  // completeness counter explicitly; the floor partition above is intentionally left intact.
  const belowFloor = belowFloorGated.length - rescuePicks.length;

  // Build display hits from the already-parsed frontmatter — no second read. Backfills
  // description + canonical type + body so an agent with no filesystem access can read the
  // fact (bgf). Capped to RECALL_BODY_CAP unless opts.fullBody; opts.skim attaches no body
  // and wins over fullBody (r0u). Rescue picks are appended to the tail, flagged below.
  const backfilled: RecallHit[] = [...limited, ...rescuePicks].map(({ h, fm }) => {
    // Fail-open hit: keep the search-derived fields unchanged (matching the old
    // `catch { return h; }`), with platforms defaulted to [] (its placeholder value).
    if (!fm) return { ...h, platforms: [] };
    const headline: RecallHit = {
      ...h,
      description: fm.frontmatter.description || h.description,
      type: fm.frontmatter.type,
      platforms: fm.frontmatter.platforms ?? [],
      project: fm.frontmatter.project,
    };
    if (opts.skim) return headline;
    const full = fm.body.trim();
    const capped = opts.fullBody ? full : truncateToBytes(full, RECALL_BODY_CAP);
    // truncateToBytes returns the input unchanged when it fits and a strict prefix when it
    // cut, so a shorter result means bytes were dropped — append the ellipsis exactly once
    // (mirrors engine.ts:300; truncateToBytes never adds it).
    const body = capped.length < full.length ? capped + "…" : capped;
    return { ...headline, body };
  });
  // Flag the appended rescue picks (the final rescuePicks.length entries) without touching the
  // backfill body's multiple return points. Their displayed `score` stays RAW (sub-floor) so a
  // caller can render them low-confidence.
  for (let i = limited.length; i < backfilled.length; i++) backfilled[i] = { ...backfilled[i]!, rescued: true };

  return { hits: backfilled, degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden };
}

/** Hits-only convenience over recallQueryWithStatus (qmemd-9t1) — drops the
 *  degraded/vectorsPending health signal. The path for callers that don't render it
 *  (and the engine ranking/filter unit tests). */
export async function recallQuery(store: QMDStore, root: string, query: string, opts: RecallOptions = {}): Promise<RecallHit[]> {
  return (await recallQueryWithStatus(store, root, query, opts)).hits;
}

// =============================================================================
// getFact() — fetch one fact in full by slug (filesystem-only, no Store, no model)
// =============================================================================

export interface FullFact {
  slug: string;
  type: MemoryType;
  frontmatter: MemoryFrontmatter;
  body: string;
  /** Real filesystem path — engine-internal. The MCP layer must NOT return it
   *  (qmemd-81n); the CLI `show` verb does not print it. */
  path: string;
}

/** Fetch one fact in full by slug, scanning every type folder (the same cross-type
 *  search forget() does). Returns null when no folder holds the slug. Filesystem
 *  only — no Store, no model (bgf). */
export function getFact(root: string, slug: string): FullFact | null {
  assertSafeSlug(slug); // reject traversal/newline before any fs touch (qmemd-fd8)
  for (const type of MEMORY_TYPES) {
    const path = memoryFilePath(root, type, slug);
    if (existsSync(path)) {
      const parsed = parseMemory(readFileSync(path, "utf-8"));
      return { slug, type, frontmatter: parsed.frontmatter, body: parsed.body, path };
    }
  }
  return null;
}

// =============================================================================
// listFacts() — browse/enumerate the corpus by type/tag/project (model-free)
// =============================================================================

export interface ListFilter { type?: MemoryType; tag?: string; project?: string; platform?: Platform }

export interface ListEntry {
  slug: string;
  type: MemoryType;
  description: string;
  tags: string[];
  created: string;
  pinned: boolean;
  platforms: Platform[];
  /** Raw frontmatter project scope: "global" or a repo name. */
  project: string;
  /** Set when the fact is retired (bri): hidden from recall, shown here for audit. */
  supersededBy?: string;
}

/** Enumerate facts, newest-first. The slug is the filename stem (the source of
 *  truth — frontmatter.name is hand-editable and could drift). `tag` = membership
 *  in frontmatter.tags; `project` matches that project OR "global" (so "alpha"
 *  returns alpha+global, but "global" returns global-only); omitting a filter
 *  returns everything. Returns plain data — no fs path. Filesystem only (bgf). */
export function listFacts(root: string, filter: ListFilter = {}, onUnreadable?: () => void): ListEntry[] {
  const out: ListEntry[] = [];
  // onUnreadable sees only the WALKED folders: under a --type filter it is per-type, not
  // corpus-wide — a caller needing the corpus-wide count uses countUnreadableFacts (e5h).
  for (const ff of walkFactFiles(root, { types: filter.type ? [filter.type] : undefined, onUnreadable: () => onUnreadable?.() })) {
    let parsed: ParsedMemory;
    try { parsed = parseMemory(ff.raw); } catch { onUnreadable?.(); continue; }
    const fm = parsed.frontmatter;
    if (filter.tag !== undefined && !fm.tags.includes(filter.tag)) continue;
    if (filter.project !== undefined && fm.project !== filter.project && fm.project !== "global") continue;
    if (filter.platform !== undefined && !platformVisible(fm.platforms ?? [], filter.platform)) continue;
    out.push({ slug: ff.slug, type: ff.type, description: fm.description, tags: fm.tags, created: fm.created, pinned: fm.pinned, platforms: fm.platforms ?? [], project: fm.project, supersededBy: fm.supersededBy });
  }
  out.sort((a, b) => b.created.localeCompare(a.created) || a.slug.localeCompare(b.slug));
  return out;
}

// =============================================================================
// staleFacts() — offline staleness pass (qmemd-9su): SURFACE for review, never mutate
// =============================================================================

export interface StaleEntry {
  slug: string;
  type: MemoryType;
  description: string;
  project: string;
  /** The fact's valid review-by date; absent on the unreviewed lane. */
  reviewBy?: string;
  /** Effective review date for a `due` entry: the explicit review_by, or anchor + the
   *  per-type default window for an implicitly-due (never-reviewed, overdue) fact. */
  dueDate?: string;
  created: string;
  updated?: string;
  pinned: boolean;
}

export interface StaleOptions {
  /** Comparison date YYYY-MM-DD (default: today). Injectable for tests. */
  today?: string;
  /** Max unreviewed entries returned (default 10). The due lane is never sliced —
   *  every fact at/past its review date is actionable. */
  limit?: number;
}

export interface StaleReport {
  /** Facts at/past review_by, oldest review date first — re-verify, then extend
   *  (remember --replace --ttl), retire (--supersedes), or forget. */
  due: StaleEntry[];
  /** Never-reviewed decay-prone facts (project/reference) not yet past their
   *  per-type window, oldest-touched (updated ?? created) first, sliced to `limit`.
   *  Durable types (`user`/`feedback`) and `review_by: never` facts are excluded.
   *  A malformed `review_by` is never silently exempt — it routes here or to `due`
   *  depending on the computed window (doctor separately flags it
   *  REVIEW_BY_MALFORMED). */
  unreviewed: StaleEntry[];
  /** Pre-slice unreviewed count, so the partial view is visible (the e3i pattern). */
  unreviewedTotal: number;
}

/**
 * Offline staleness pass (qmemd-9su): walk the corpus and report facts due for review
 * plus never-reviewed decay-prone facts not yet due (the backlog). A monotonically
 * accreting brain drifts toward contradiction; this is the forgetting layer's surface —
 * and ONLY a surface: filesystem-only (no Store, no model, mirrors doctor) and strictly
 * read-only. It never auto-deletes and recall never reads review_by (offline-first ethos:
 * markdown stays the source of truth; a human/agent resolves each entry via the existing
 * verbs). Superseded facts are excluded from both lanes — already retired.
 */
export function staleFacts(root: string, opts: StaleOptions = {}): StaleReport {
  const todayStr = opts.today ?? today();
  const limit = opts.limit ?? 10;
  const due: StaleEntry[] = [];
  const backlog: StaleEntry[] = []; // never-reviewed decay-prone facts not yet due (the `unreviewed` lane)
  for (const ff of walkFactFiles(root)) {
      let fm: MemoryFrontmatter;
      try { fm = parseMemory(ff.raw).frontmatter; }
      catch { continue; /* unreadable — doctor's half (e5h) */ }
      if (fm.supersededBy) continue;                 // retired, not stale
      if (fm.reviewBy === DURABLE_SENTINEL) continue; // explicit durable: exempt (before any date logic)
      const base: StaleEntry = {
        slug: ff.slug, type: ff.type, description: fm.description, project: fm.project,
        created: fm.created, ...(fm.updated !== undefined ? { updated: fm.updated } : {}),
        pinned: fm.pinned,
      };
      const explicit = fm.reviewBy !== undefined && fm.reviewBy !== "" && isValidReviewBy(fm.reviewBy);
      if (explicit) {
        // Scheduled fact: due ON or after its explicit review date; future ⇒ quiet.
        if (fm.reviewBy! <= todayStr) due.push({ ...base, reviewBy: fm.reviewBy, dueDate: fm.reviewBy });
        continue;
      }
      // No (valid) explicit review_by ⇒ inherit the per-type default window. A malformed
      // review_by also lands here (fail-open to surfacing; doctor flags it separately).
      const W = ttlDefaultDays(ff.type);
      if (W === null) continue; // durable type (user/feedback): exempt
      const anchor = (base.updated ?? base.created).slice(0, 10);
      const anchorMs = Date.parse(`${anchor}T00:00:00.000Z`);
      if (Number.isNaN(anchorMs)) {
        // Undatable decay-prone fact (missing/garbage created+updated): never silently
        // exempt — surface as due (effective date = today, since none can be derived; keeps
        // dueDate a real date for sort/render) so a human notices; doctor flags the integrity
        // defect separately.
        due.push({ ...base, dueDate: todayStr });
        continue;
      }
      const dueDate = reviewByFromTtl(`${W}d`, new Date(anchorMs));
      if (dueDate <= todayStr) due.push({ ...base, dueDate }); // implicit, overdue: never reviewed
      else backlog.push(base);                                 // never reviewed, not yet due
  }
  // due: effective date asc then slug; backlog: oldest anchor first then slug.
  due.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.slug.localeCompare(b.slug));
  const touched = (e: StaleEntry): string => (e.updated ?? e.created).slice(0, 10);
  backlog.sort((a, b) => touched(a).localeCompare(touched(b)) || a.slug.localeCompare(b.slug));
  return { due, unreviewed: backlog.slice(0, limit), unreviewedTotal: backlog.length };
}

// =============================================================================
// resolveReviewedDate / markReviewed — `qmemd reviewed` verb (qmemd-s4w).
// =============================================================================

export interface ReviewedOptions {
  /** "<N>d|w|m|y" or "never". Mutually exclusive with reviewBy. */
  ttl?: string;
  /** A YYYY-MM-DD date or "never". Mutually exclusive with ttl. */
  reviewBy?: string;
}

/**
 * Compute the new review_by for `qmemd reviewed` (s4w). Pure. Precedence:
 *   --review-by date|never  >  --ttl Nd|never  >  today + per-type default window.
 * A durable type (user/feedback) with no flags resolves to the `never` sentinel.
 * Throws (path-free messages, MCP/HTTP-safe) on ttl+reviewBy together or a malformed value.
 */
export function resolveReviewedDate(type: MemoryType, opts: ReviewedOptions, from: Date = new Date()): string {
  if (opts.ttl !== undefined && opts.reviewBy !== undefined) {
    throw new ClientError("invalid ttl: cannot combine ttl with review_by — pass one or the other");
  }
  if (opts.reviewBy !== undefined) { assertValidReviewBy(opts.reviewBy); return opts.reviewBy; }
  if (opts.ttl !== undefined) {
    return opts.ttl.trim().toLowerCase() === DURABLE_SENTINEL ? DURABLE_SENTINEL : reviewByFromTtl(opts.ttl, from);
  }
  const W = ttlDefaultDays(type);
  return W === null ? DURABLE_SENTINEL : reviewByFromTtl(`${W}d`, from);
}

/**
 * `qmemd reviewed <slug>` (s4w): "I checked this fact, it is still correct — reset the
 * clock." Forward-sets review_by via setFrontmatterKey, touching ONLY that line —
 * `updated` is deliberately NOT bumped (content-age + snapshot recency stay honest;
 * the supersede-stamp precedent at remember()). Mirrors forget(): write + git commit
 * (+ push) BEFORE the best-effort reindex, so a reindex failure never strands the write.
 */
export async function markReviewed(
  store: QMDStore, root: string, slug: string, opts: ReviewedOptions, git: GitDeps = {},
): Promise<{ slug: string; reviewBy: string; path: string; synced?: boolean; syncWarning?: string }> {
  assertSafeSlug(slug); // reject traversal/newline before any fs touch (qmemd-fd8)
  const fact = getFact(root, slug);
  if (!fact) throw new ClientError(`no fact named '${slug}' to mark reviewed`);
  const reviewBy = resolveReviewedDate(fact.type, opts);
  const content = readFileSync(fact.path, "utf-8");
  // Fenceless fact: setFrontmatterKey would return the content unchanged, git would
  // no-op, and the fact would resurface in `qmemd stale` forever while this verb
  // reports success (qp-yf2 C6). The fence is not mechanically fixable (MISSING_OPEN
  // needs a human), so fail loudly with the repair path instead.
  if (!locateFences(content)) {
    throw new Error(`fact '${slug}' has no frontmatter fence — review_by cannot be stamped; repair the file's frontmatter ('qmemd doctor' locates it), then retry`);
  }
  writeFileSync(fact.path, setFrontmatterKey(content, "review_by", reviewBy));
  const commit = gitCommit(root, `reviewed: ${slug}`, `${fact.type}/${slug}.md`, git);
  const push = gitPush(root, git);
  const { synced, syncWarning } = syncOutcome(commit, push);
  if (syncWarning) console.error(`[qmemd] reviewed '${slug}': ${syncWarning}`);
  try { await reindexMemory(store); }
  catch (e) { console.error(`[qmemd] reindex after reviewed failed (write committed): ${e instanceof Error ? e.message : String(e)}`); }
  return { slug, reviewBy, path: fact.path, synced, syncWarning };
}

// =============================================================================
// tagHistogram / projectOverview — model-free corpus shape (tfu).
// Shared by the session snapshot's "Unshown tags:" line and the memory-presence
// beacon / `qmemd tags`. Single source for the tag-frequency rendering.
// =============================================================================

/** Tag frequency over a set of tag-lists, sorted by count desc then tag name asc.
 *  Pure — takes raw tag arrays so it is decoupled from the fact container type. */
export function tagHistogram(tagLists: string[][]): { tag: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const tags of tagLists) for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

/** Render a histogram as "tag(count) tag(count)…" (space-joined). "" when empty. */
export function formatTagHistogram(hist: { tag: string; count: number }[]): string {
  return hist.map(({ tag, count }) => `${tag}(${count})`).join(" ");
}

export interface ScopeOverview {
  total: number;
  tags: { tag: string; count: number }[];
}

export interface ProjectOverview {
  project: string;
  total: number;
  tags: { tag: string; count: number }[];
  byType: Record<MemoryType, number>;
  /** Facts scoped to exactly this project (excludes global). */
  repo: ScopeOverview;
  /** `project: global` facts visible everywhere. */
  global: ScopeOverview;
}

/** Model-free corpus overview for a project (project-scoped + global, mirroring
 *  listFacts). `types` defaults to all four; the beacon passes ["project","reference"]
 *  to exclude always-on user/feedback (already injected every session). `total`/`tags`
 *  stay mixed (pre-split JSON contract); `repo`/`global` carry the honest split. No fs
 *  path, no model — safe on a Bash hot path. */
export function projectOverview(root: string, project: string, types: MemoryType[] = MEMORY_TYPES): ProjectOverview {
  const entries: ListEntry[] = [];
  for (const t of types) entries.push(...listFacts(root, { type: t, project }));
  const byType: Record<MemoryType, number> = { user: 0, feedback: 0, project: 0, reference: 0 };
  for (const e of entries) byType[e.type]++;
  const scope = (pred: (e: ListEntry) => boolean): ScopeOverview => {
    const sub = entries.filter(pred);
    return { total: sub.length, tags: tagHistogram(sub.map(e => e.tags)) };
  };
  return {
    project, total: entries.length, tags: tagHistogram(entries.map(e => e.tags)), byType,
    repo: scope(e => e.project !== "global"),
    global: scope(e => e.project === "global"),
  };
}

// =============================================================================
// forget() — remove a memory file from disk and drop it from the index
// =============================================================================

export async function forget(store: QMDStore, root: string, slug: string, git: GitDeps = {}): Promise<{ removed: boolean; path?: string; synced?: boolean; syncWarning?: string }> {
  assertSafeSlug(slug); // reject traversal/newline before it reaches rmSync (qmemd-fd8)
  for (const type of MEMORY_TYPES) {
    const path = memoryFilePath(root, type, slug);
    if (existsSync(path)) {
      rmSync(path);
      // Commit the deletion before indexing (mirrors remember): a reindex failure
      // must not strand an uncommitted deletion. The index drop is best-effort and
      // self-heals on the next remember/forget.
      const commit = gitCommit(root, `forget: ${slug}`, `${type}/${slug}.md`, git);
      const push = gitPush(root, git);
      const { synced, syncWarning } = syncOutcome(commit, push);
      if (syncWarning) console.error(`[qmemd] forget '${slug}': ${syncWarning}`);
      try {
        await reindexMemory(store); // removed/orphaned files dropped from index
        // reindexCollection soft-deletes the vanished doc (active=0) and sweeps
        // orphaned content, but leaves the tombstone documents row AND its orphaned
        // embedding (content_vectors/vectors_vec) behind, so index.sqlite grows
        // unbounded with churn (qmemd-2dh). Reclaim them: drop the tombstone first so
        // its content/vectors become unreferenced, then sweep both. Trade-off: this
        // removes the content-hash vector, so a later identical re-remember re-embeds
        // from scratch instead of reviving the dormant vector — acceptable.
        const maint = new Maintenance(store.internal);
        maint.deleteInactiveDocs();
        maint.cleanupOrphanedContent();
        maint.cleanupOrphanedVectors();
      } catch (e) {
        console.error(`[qmemd] reindex/cleanup after forget failed (deletion committed): ${e instanceof Error ? e.message : String(e)}`);
      }
      return { removed: true, path, synced, syncWarning };
    }
  }
  return { removed: false };
}

/** The agent's resolved merge decision for ONE cluster — `dedup --apply` input (qmemd-3fb).
 *  `cluster` is a cluster object as emitted by `dedup --merge --json`; `foldedBody` is the
 *  agent's canonical text; `keeper` optionally overrides `cluster.suggestedKeeper`. */
export interface MergePlan {
  cluster: MergeProposalCluster;
  foldedBody: string;
  keeper?: string;
}

export interface ApplyMergeResult {
  keeper: string;
  retired: string[];
  loss: MergeLoss;
  committed: boolean;
  indexed: boolean;
}

/**
 * Apply a merge plan as ONE atomic transaction (qmemd-3fb): validate → guard → mutate fs →
 * single commit → single reindex. Delete-only (the established retire default; git history
 * is the lineage backstop — `--supersede` is a deferred follow-up). Rollback is git-
 * independent: pre-images are captured in memory and rewritten if the fs mutation throws
 * before the commit, so a half-state is never committed. Errors are path-free (the MCP/HTTP
 * client-error pattern). Reuses the remember/forget write order: mutate → commit → reindex.
 */
export async function applyMerge(
  store: QMDStore,
  root: string,
  plan: MergePlan,
  opts: { force?: boolean } = {},
  git: GitDeps = {},
): Promise<ApplyMergeResult> {
  const cluster = plan.cluster;
  const keeper = plan.keeper ?? cluster.suggestedKeeper;

  // 1. Validate against the LIVE corpus (re-read, don't trust a possibly-stale plan).
  if (!cluster.members.some(m => m.slug === keeper)) {
    throw new Error(`invalid merge plan: keeper '${keeper}' is not a cluster member`);
  }
  const live = new Map<string, FullFact>();
  for (const m of cluster.members) {
    const f = getFact(root, m.slug); // getFact runs assertSafeSlug
    if (!f) throw new Error(`invalid merge plan: member '${m.slug}' no longer exists`);
    if (f.frontmatter.project !== cluster.project) {
      throw new Error(`invalid merge plan: member '${m.slug}' is in project '${f.frontmatter.project}', not the cluster's '${cluster.project}'`);
    }
    live.set(m.slug, f);
  }
  const keeperFact = live.get(keeper)!;
  const others = cluster.members.map(m => m.slug).filter(s => s !== keeper);

  // 2. Guard (pure, pre-mutation): sources = retired members + keeper's pre-merge body.
  const sources = [{ slug: keeper, text: keeperFact.body }, ...others.map(s => ({ slug: s, text: live.get(s)!.body }))];
  const loss = mergeLossCheck(sources, plan.foldedBody);
  if (loss.lostIdentifiers.length > 0 && !opts.force) {
    const toks = loss.lostIdentifiers.map(l => `${l.token} (${l.slug})`).join(", ");
    throw new Error(`merge blocked: ${loss.lostIdentifiers.length} identifier token(s) would be lost: ${toks}. Re-fold to keep them, or pass --force.`);
  }

  // 3. Capture pre-images for git-independent rollback.
  const preimages = cluster.members.map(m => { const f = live.get(m.slug)!; return { path: f.path, content: readFileSync(f.path, "utf-8") }; });

  // 4. Mutate fs (rollback on any throw before the commit).
  const commitPaths: string[] = [`${keeperFact.type}/${keeper}.md`];
  try {
    const fm: MemoryFrontmatter = {
      ...keeperFact.frontmatter,
      tags: cluster.unionTags,
      platforms: cluster.unionPlatforms.length > 0 ? (cluster.unionPlatforms as Platform[]) : undefined,
      pinned: cluster.anyPinned,
      updated: new Date().toISOString(),
    };
    writeFileSync(keeperFact.path, serializeMemory(fm, plan.foldedBody));
    for (const s of others) {
      const f = live.get(s)!;
      rmSync(f.path);
      commitPaths.push(`${f.type}/${s}.md`);
    }
  } catch (e) {
    for (const p of preimages) writeFileSync(p.path, p.content); // recreate deletes + undo overwrite
    throw e;
  }

  // 5. ONE commit + ONE push (best-effort, never throws — `add -A` stages the deletions too).
  const commit = gitCommit(root, `merge: ${keeper} <- ${others.join(" ")}`, commitPaths, git);
  const push = gitPush(root, git);
  const { syncWarning } = syncOutcome(commit, push);
  if (syncWarning) console.error(`[qmemd] merge '${keeper}': ${syncWarning}`);

  // 6. ONE reindex + orphan reclaim (best-effort, self-heals — mirrors forget).
  let indexed = true;
  try {
    await reindexMemory(store);
    const maint = new Maintenance(store.internal);
    maint.deleteInactiveDocs();
    maint.cleanupOrphanedContent();
    maint.cleanupOrphanedVectors();
  } catch (e) {
    indexed = false;
    console.error(`[qmemd] reindex/cleanup after merge failed (merge committed): ${e instanceof Error ? e.message : String(e)}`);
  }

  return { keeper, retired: others, loss, committed: commit.committed, indexed };
}
