// =============================================================================
// dedup.ts — offline within-project loose near-dup REPORT (qmemd-dao)
//
// A maintenance surface, sibling of doctor.ts / staleFacts: filesystem-only — no
// Store, no embedding model, strictly READ-ONLY. It never mutates and never merges.
//
// Why it exists: the model-free WRITE path (engine nearDuplicate, Dice ≥ 0.82) catches
// TIGHT near-dups but provably cannot catch LOOSE, phrasing-drifted ones — the ~4-fact
// alpha JDK cluster (measured 2026-06-05, docs/reports/2026-06-05-rso-loose-near-dup-
// findings.md). Those loose pairs are GLOBALLY inseparable from cross-repo same-topic
// facts (alpha-JDK ~ beta-JDK scores HIGHER than the true in-cluster pair), so
// no single global threshold can reach them without false-merging different repos.
//
// The lever (gbrain's entity-prefilter, ported): scope candidates by `project:` BEFORE
// similarity. Within a project bucket the loose cluster becomes separable by a plain
// token-set Dice (rso: min true-dup 0.196 vs max within-project negative 0.128, margin
// +0.068). Different project → never compared. The margin is THIN, so this only ever
// SURFACES clusters for an agent/LLM judge to merge (remember --replace / --supersedes);
// it never auto-merges. Merge UX is a follow-up — this is report-only.
// =============================================================================

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { MEMORY_TYPES, parseMemory, firstLine, tokenizeForDedup, getFact, type MemoryType } from "./engine.js";

/**
 * Default report threshold. Sits inside the rso-measured within-project gap
 * (max negative 0.128 < 0.18 < min true-dup 0.196): low enough to surface the loose
 * alpha JDK cluster, high enough to keep unrelated within-project facts out. A
 * heuristic, not a proof — the report is a SHORTLIST for a judge, so `--min-dice`
 * tunes recall vs noise. Far below the write-path floor (0.82): this pass exists
 * precisely to catch what that floor cannot.
 */
export const DEDUP_REPORT_DICE = 0.18;

/** One fact in a surfaced cluster. NEVER carries an absolute fs path. */
export interface DedupMember {
  slug: string;
  type: MemoryType;
  /** The fact's description, for rendering the candidate to the reviewer. */
  description: string;
}

/** A high-similarity edge between two facts in the same project bucket. */
export interface DedupEdge {
  /** Slug, lexicographically first of the pair. */
  a: string;
  /** Slug, lexicographically second of the pair. */
  b: string;
  dice: number;
}

/** A connected component of near-dup facts within one project bucket. */
export interface DedupCluster {
  /** The literal `project:` value shared by every member (the bucket key). */
  project: string;
  /** Members, sorted by slug. */
  members: DedupMember[];
  /** The above-threshold pairs that link the component (not every member pair). */
  edges: DedupEdge[];
  /** Strongest edge — ranks clusters and signals confidence. */
  maxDice: number;
  /** Loosest edge — the margin a reviewer weighs before merging. */
  minDice: number;
}

export interface DedupReport {
  /** The Dice floor in effect for this run. */
  threshold: number;
  /** Clusters, sorted by maxDice descending (strongest candidates first). */
  clusters: DedupCluster[];
  /** Within-bucket pairs actually compared — transparency on the work done. */
  comparisons: number;
  /** Candidate files the scan could not read (a silent dedup gap, surfaced — e5h). */
  unreadable: number;
}

export interface DedupOptions {
  /** Override the Dice floor (default DEDUP_REPORT_DICE). */
  threshold?: number;
  /**
   * Restrict the scan to a single project bucket. Compared by LITERAL `project:` —
   * NOT the `list --project` semantics that fold `global` facts into every project view.
   * Here `global` is its own bucket and is never compared against a named project (a
   * `global`-tagged fact that is a loose near-dup of a project fact will not co-surface).
   * That is intentional: cross-bucket comparison is exactly the unsafe operation this pass
   * exists to avoid (rso: the loose cluster is globally inseparable from cross-repo same-topic
   * facts). The proper remedy for a mis-tagged `global` fact is to fix the tag (a doctor /
   * canonicalization concern), not to fold buckets together here.
   */
  project?: string;
}

interface WalkedFact {
  slug: string;
  type: MemoryType;
  project: string;
  description: string;
  /** Token set of `name + firstLine(body)` — the exact text the write-path dedup uses. */
  tokens: Set<string>;
}

/**
 * Walk the corpus once, capturing each LIVE fact's project bucket and precomputed
 * compare-token set. Superseded facts are excluded (already retired). Mirrors
 * scanFacts/staleFacts but also reads `project` + `superseded_by`, which the write-path
 * scanFacts deliberately does not. Unreadable files are counted, not hidden (e5h).
 */
function walkFacts(root: string): { facts: WalkedFact[]; unreadable: number } {
  const facts: WalkedFact[] = [];
  let unreadable = 0;
  for (const type of MEMORY_TYPES) {
    const dir = join(root, type);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      let parsed;
      try { parsed = parseMemory(readFileSync(join(dir, f), "utf-8")); }
      catch { unreadable++; continue; }
      const fm = parsed.frontmatter;
      if (fm.supersededBy) continue; // retired — never a merge candidate
      const compareText = `${fm.name} ${firstLine(parsed.body)}`;
      facts.push({
        slug: f.replace(/\.md$/, ""),
        type,
        project: fm.project,
        description: fm.description,
        tokens: new Set(tokenizeForDedup(compareText)),
      });
    }
  }
  return { facts, unreadable };
}

/** Token-set Dice 2|A∩B| / (|A|+|B|). 0 when either side is empty (nothing to compare). */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Group facts linked by above-threshold edges into connected components (union-find).
 * `idx` indexes into `facts`; returns the components with ≥2 members as slug-index sets.
 */
function connectedComponents(n: number, edges: { i: number; j: number }[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const nx = parent[x]!; parent[x] = r; x = nx; }
    return r;
  };
  for (const { i, j } of edges) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  }
  return [...groups.values()].filter(g => g.length >= 2);
}

/**
 * Offline within-project near-dup report (qmemd-dao). Buckets live facts by literal
 * `project:`, compares token-set Dice ONLY within a bucket, and surfaces connected
 * components of above-threshold pairs as clusters for a human/agent to review and merge.
 * Filesystem-only, read-only, no model. Strictly a surface — it never mutates.
 */
export function dedupReport(root: string, opts: DedupOptions = {}): DedupReport {
  const threshold = opts.threshold ?? DEDUP_REPORT_DICE;
  const { facts, unreadable } = walkFacts(root);

  // Bucket by literal project (gbrain's entity-prefilter). `global` is its own bucket —
  // never folded into named projects (see DedupOptions.project). Optionally restrict to one.
  const buckets = new Map<string, WalkedFact[]>();
  for (const fact of facts) {
    if (opts.project !== undefined && fact.project !== opts.project) continue;
    (buckets.get(fact.project) ?? buckets.set(fact.project, []).get(fact.project)!).push(fact);
  }

  const clusters: DedupCluster[] = [];
  let comparisons = 0;

  for (const [project, bucket] of buckets) {
    if (bucket.length < 2) continue;
    // All within-bucket pairs; keep those above the floor as cluster edges.
    const componentEdges: { i: number; j: number }[] = [];
    const dicePairs = new Map<string, number>(); // "i,j" → dice, for edge rendering
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        comparisons++;
        const d = dice(bucket[i]!.tokens, bucket[j]!.tokens);
        if (d >= threshold) {
          componentEdges.push({ i, j });
          dicePairs.set(`${i},${j}`, d);
        }
      }
    }
    for (const comp of connectedComponents(bucket.length, componentEdges)) {
      const compSet = new Set(comp);
      const members = comp
        .map(i => ({ slug: bucket[i]!.slug, type: bucket[i]!.type, description: bucket[i]!.description }))
        .sort((x, y) => x.slug.localeCompare(y.slug));
      const edges: DedupEdge[] = [];
      for (const [key, d] of dicePairs) {
        const [i, j] = key.split(",").map(Number) as [number, number];
        if (!compSet.has(i) || !compSet.has(j)) continue;
        const [s1, s2] = [bucket[i]!.slug, bucket[j]!.slug].sort() as [string, string];
        edges.push({ a: s1, b: s2, dice: d });
      }
      edges.sort((x, y) => y.dice - x.dice || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
      const dices = edges.map(e => e.dice);
      clusters.push({ project, members, edges, maxDice: Math.max(...dices), minDice: Math.min(...dices) });
    }
  }

  clusters.sort((a, b) => b.maxDice - a.maxDice || a.project.localeCompare(b.project));
  return { threshold, clusters, comparisons, unreadable };
}

// =============================================================================
// merge proposal (qmemd-a6e) — agent-judge consolidation. Reuses the read-only
// dedupReport for clustering, then re-reads ONLY the clustered files (small) via
// getFact to enrich each member with full body + frontmatter, compute the unioned
// scope a lossless fold must carry, and emit a verb skeleton. Still model-free,
// still mutates NOTHING — the agent folds + applies with remember --replace / forget.
// =============================================================================

/** One cluster member, enriched with the full body + frontmatter a fold needs. No fs path. */
export interface MergeProposalMember {
  slug: string;
  type: MemoryType;
  description: string;
  /** Full markdown body — the agent reads every datum from here. */
  body: string;
  tags: string[];
  /** Empty = all platforms (widest scope). */
  platforms: string[];
  pinned: boolean;
  created: string;
  reviewBy?: string;
}

/** A surfaced cluster plus the mechanical scaffolding for a lossless fold. */
export interface MergeProposalCluster {
  project: string;
  members: MergeProposalMember[];
  edges: DedupEdge[];
  maxDice: number;
  minDice: number;
  /** Deterministic keeper HINT (agent overrides freely). */
  suggestedKeeper: string;
  /** Set-union of every member's tags, sorted. */
  unionTags: string[];
  /** Widest-scope union: [] (all) if ANY member is unscoped, else sorted set-union. */
  unionPlatforms: string[];
  /** OR of members' pinned — keeper must stay pinned if any source was. */
  anyPinned: boolean;
  /** Keeper-first superset of every member's unique body lines (qmemd-5so). The agent
   *  edits this DOWN into the canonical fold — losing nothing by construction. */
  draftBody: string;
}

export interface MergeProposal {
  threshold: number;
  clusters: MergeProposalCluster[];
  comparisons: number;
  unreadable: number;
}

/** Re-read one clustered fact in full. Degrades (never drops, never throws) on the
 *  near-impossible race where the file vanished between the report walk and here. */
function enrichMember(root: string, m: DedupMember): MergeProposalMember {
  const f = getFact(root, m.slug);
  if (!f) return { slug: m.slug, type: m.type, description: m.description, body: m.description, tags: [], platforms: [], pinned: false, created: "" };
  const fm = f.frontmatter;
  return {
    slug: m.slug, type: f.type, description: fm.description, body: f.body.trimEnd(),
    tags: fm.tags, platforms: fm.platforms ?? [], pinned: fm.pinned, created: fm.created,
    ...(fm.reviewBy ? { reviewBy: fm.reviewBy } : {}),
  };
}

/**
 * Superset draft body for a merge fold (qmemd-5so): the keeper's body lines first (the
 * canonical spine), then every other member's lines not already present (trimmed-exact
 * match, first occurrence wins). Consecutive blank lines collapse; leading/trailing blanks
 * trimmed. Every datum is present, so a fold OMISSION requires a visible delete, not a
 * silent gap — the agent edits this DOWN instead of synthesizing UP. Deterministic:
 * members are taken in the order given (mergeProposal sorts by slug), keeper hoisted first.
 */
export function buildBodyUnion(members: MergeProposalMember[], keeper: string): string {
  const ordered = [...members.filter(m => m.slug === keeper), ...members.filter(m => m.slug !== keeper)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of ordered) {
    for (const line of m.body.split("\n")) {
      const key = line.trim();
      if (key !== "") {
        if (seen.has(key)) continue; // drop a repeated non-blank line
        seen.add(key);
        out.push(line);
      } else if (out.length > 0 && out[out.length - 1]!.trim() !== "") {
        out.push(""); // one blank between blocks; never two in a row
      }
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** Keeper HINT: most scope (tags+platforms), then longest body, then newest created, then slug. */
function pickKeeper(members: MergeProposalMember[]): string {
  return [...members].sort((a, b) => {
    const scoreA = a.tags.length + a.platforms.length;
    const scoreB = b.tags.length + b.platforms.length;
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.body.length !== b.body.length) return b.body.length - a.body.length;
    if (a.created !== b.created) return a.created < b.created ? 1 : -1; // newest first
    return a.slug.localeCompare(b.slug);
  })[0]!.slug;
}

/**
 * Build an agent-ready merge proposal from the offline dedup report (qmemd-a6e). Same scan
 * + bucketing as dedupReport; for each surfaced cluster, re-reads members in full and adds
 * union/keeper scaffolding. Filesystem-only, read-only, no model. Mutates nothing.
 */
export function mergeProposal(root: string, opts: DedupOptions = {}): MergeProposal {
  const report = dedupReport(root, opts);
  const clusters = report.clusters.map(c => {
    const members = c.members.map(m => enrichMember(root, m));
    const suggestedKeeper = pickKeeper(members);
    return {
      project: c.project, members, edges: c.edges, maxDice: c.maxDice, minDice: c.minDice,
      suggestedKeeper,
      unionTags: [...new Set(members.flatMap(m => m.tags))].sort(),
      unionPlatforms: members.some(m => m.platforms.length === 0)
        ? []
        : [...new Set(members.flatMap(m => m.platforms))].sort(),
      anyPinned: members.some(m => m.pinned),
      draftBody: buildBodyUnion(members, suggestedKeeper),
    } satisfies MergeProposalCluster;
  });
  return { threshold: report.threshold, clusters, comparisons: report.comparisons, unreadable: report.unreadable };
}

/**
 * Agent-ready verb skeleton (qmemd-a6e): a `remember --replace` that applies the unioned
 * scope (widest platforms, all tags, pin if any source was pinned) + a `forget` retiring
 * the rest. Always passes --platforms/--tags explicitly so the merge applies the union,
 * not the keeper's possibly-narrower inherited scope. The agent edits the folded text.
 */
export function buildMergeCommands(cluster: MergeProposalCluster): string[] {
  const keeper = cluster.suggestedKeeper;
  const others = cluster.members.map(m => m.slug).filter(s => s !== keeper);
  const parts = [`qmemd remember --replace ${keeper} "<EDIT: fold every unique datum from all ${cluster.members.length} facts>"`];
  if (cluster.unionTags.length > 0) parts.push(`--tags ${cluster.unionTags.join(",")}`);
  parts.push(cluster.unionPlatforms.length > 0 ? `--platforms ${cluster.unionPlatforms.join(",")}` : `--platforms ""`);
  if (cluster.anyPinned) parts.push("--pin");
  const lines = [parts.join(" ")];
  if (others.length > 0) lines.push(`qmemd forget ${others.join(" ")}`);
  return lines;
}
