import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openMemoryStore } from "../store.js";
import { type QMDStore } from "@tobilu/qmd";
import { remember, recallQueryWithStatus, recallSession, forget as forgetFact, markReviewed, getFact, listFacts, pendingVectorPhrase, completenessFooter, MEMORY_TYPES, PLATFORMS, DEFAULT_MIN_SCORE, type RecallHit, type FullFact, type ListEntry, type MemoryType, type Platform } from "../engine.js";
import { memoryRoot } from "../paths.js";
import { gitPullFfOnly, sessionSyncWarning, type GitDeps } from "../git.js";
import { rootHash } from "../client.js";
import { shouldAutoResolve, autoRecallMode, resolveExplicitMode, type RecallMode } from "../capability.js";
import { basename } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

// Real shipped version so MCP clients see it, not a literal that drifts on every bump
// (qmemd-8ez). createRequire is an ESM-safe JSON read that resolves package.json (two dirs up
// from this module) in both src-via-tsx and dist-via-node layouts.
const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

// --- Response DTO mappers ----------------------------------------------------
// The single source of truth for which fields leave the process. Both the MCP
// tools (structuredContent) and the REST handlers build their JSON through these,
// so the fs-path allowlist (qmemd-81n) can never drift between the two surfaces.
// None of them carry an absolute filesystem path.
export type HitDTO = { slug: string; type: string; description: string; score?: number; body?: string; platforms: string[]; project: string };
// All four supersession fields are slugs/ISO instants — path-free, qmemd-81n safe (bri integration review).
export type FactDTO = { slug: string; type: string; description: string; tags: string[]; pinned: boolean; created: string; body: string; platforms: string[]; updated?: string; supersedes?: string; supersededBy?: string; conflictsWith?: string; reviewBy?: string };
export type ListEntryDTO = { slug: string; type: string; description: string; tags: string[]; created: string; pinned: boolean; platforms: string[]; supersededBy?: string };
export function toHitDTO(h: RecallHit): HitDTO {
  return { slug: h.slug, type: h.type, description: h.description, score: h.score, body: h.body, platforms: h.platforms ?? [], project: h.project };
}
export function toFactDTO(fact: FullFact): FactDTO {
  const fm = fact.frontmatter;
  return {
    slug: fact.slug, type: fact.type, description: fm.description, tags: fm.tags,
    pinned: fm.pinned, created: fm.created, body: fact.body.trim(), platforms: fm.platforms ?? [],
    ...(fm.updated !== undefined && { updated: fm.updated }),
    ...(fm.supersedes !== undefined && { supersedes: fm.supersedes }),
    ...(fm.supersededBy !== undefined && { supersededBy: fm.supersededBy }),
    ...(fm.conflictsWith !== undefined && { conflictsWith: fm.conflictsWith }),
    // A YYYY-MM-DD date — path-free, qmemd-81n safe (9su).
    ...(fm.reviewBy !== undefined && { reviewBy: fm.reviewBy }),
  };
}
export function toListEntryDTO(e: ListEntry): ListEntryDTO {
  return { slug: e.slug, type: e.type, description: e.description, tags: e.tags, created: e.created, pinned: e.pinned, platforms: e.platforms ?? [], supersededBy: e.supersededBy };
}

const MEMORY_TYPES_Z = z.enum(["user", "feedback", "project", "reference"]);
const PLATFORMS_Z = z.enum(["linux", "macos", "windows"]);

// Output contract for the recall tool (qmemd-os1): declared so the SDK validates
// structuredContent on every call (it skips validation entirely when outputSchema is
// absent) and clients see the health/completeness fields as API, not accidents.
// `satisfies` locks the hit schema to HitDTO so the two can't drift.
const HIT_DTO_Z = z.object({
  slug: z.string(), type: z.string(), description: z.string(),
  score: z.number().optional(), body: z.string().optional(),
  platforms: z.array(z.string()), project: z.string(),
}) satisfies z.ZodType<HitDTO>;
// One schema serves both result shapes — the SDK requires structuredContent on every
// non-error result once a schema is declared, so the session path is covered by the
// `snapshot` field (mirroring REST /recall's session response) and every field is optional.
const RECALL_OUTPUT_SCHEMA = {
  hits: z.array(HIT_DTO_Z).optional().describe("Ranked matches (query path)."),
  degraded: z.boolean().optional().describe("Hybrid recall fell back toward lexical — semantic matches may be missing."),
  vectorsPending: z.number().int().optional().describe("Vectors still pending behind a degraded result; -1 = unknown."),
  moreMatches: z.number().int().optional().describe("In-scope matches past `limit`; a lower bound when saturated."),
  belowFloor: z.number().int().optional().describe("Hits the minScore relevance floor hid."),
  saturated: z.boolean().optional().describe("Search pool came back full — moreMatches is a lower bound."),
  crossProjectHidden: z.number().int().optional().describe("Relevant matches from OTHER projects the default scope hid; pass cross_project:true to include them."),
  snapshot: z.string().optional().describe("The session snapshot text (session:true path)."),
};

/**
 * Turn a thrown MCP-tool error into a model-safe isError result (qmemd-3lt). A downstream
 * fs (ENOENT/EACCES) or SQLite error message can embed the absolute QMEMD_DB / memory-root
 * path — leaking the home-dir layout and aiding a traversal feedback loop — and the tool
 * handlers have no try/catch, so the SDK would surface it verbatim. The full error goes to
 * stderr only; the model gets a generic message. assertSafeSlug's "unsafe slug …" (qmemd-fd8)
 * and remember's "no fact named … to replace" (qmemd-acm) messages are both path-free,
 * intentional client-facing signals, so they are preserved verbatim — mirrors the HTTP
 * handler's catch in startMcpHttpServer.
 */
function sanitizeToolError(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[qmemd] MCP tool error:", err);
  const text = msg.startsWith("unsafe slug") || msg.startsWith("no fact named") || msg.startsWith("invalid platform") || msg.startsWith("supersedes cannot") || msg.startsWith("a fact cannot supersede itself") || msg.startsWith("invalid review_by") || msg.startsWith("invalid ttl") ? msg : "internal error";
  return { content: [{ type: "text", text }], isError: true };
}

export interface MemoryServerOptions {
  /**
   * Default project for the session snapshot when the caller passes none (qmemd-wdf). The
   * stdio server leaves this undefined so it keeps basename(cwd) — for a per-project stdio
   * server that IS the project (qmemd-3nq). The HTTP daemon passes 'global' because its cwd
   * is HOME (systemd WorkingDirectory=%h), not a project, so basename(cwd) would scope the
   * snapshot to a non-existent project and under-return.
   */
  sessionDefaultProject?: string;
  /** Injectable git runner for the session-start pull (tests); production uses real git. */
  gitDeps?: GitDeps;
  /** True only for the warm HTTP daemon: it amortizes the model load by design and never
   *  auto-downgrades. The per-session stdio server leaves this false, so on a CPU-only host
   *  its default recall resolves to lex (the capability gate). */
  warmServer?: boolean;
  /** Injectable auto-mode resolver (tests). Production uses capability.autoRecallMode. */
  resolveAutoMode?: () => Promise<RecallMode>;
}

/**
 * Build the MCP server over a LAZY store: the SQLite store opens on the first tool call that needs
 * it, not at construction. This lets the stdio launch connect the transport and answer `initialize`
 * before native better-sqlite3 is touched — cold-start / clean-room safe (qmemd-faif.10). Tools that
 * read the filesystem directly (get, list, recall session:true) never trigger a store open.
 */
export function buildMemoryServerLazy(getStore: () => Promise<QMDStore>, root: string, opts: MemoryServerOptions = {}): McpServer {
  const server = new McpServer({ name: "qmemd", version: VERSION });

  server.registerTool("remember", {
    title: "Remember",
    description: "Store a durable, non-obvious fact in qmemd memory — when in doubt, don't (a noisy corpus degrades recall). Returns the slug; reports a near-duplicate instead of writing unless replace/force is set.",
    annotations: { readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      fact: z.string().describe("The fact to remember, as a self-contained sentence."),
      type: MEMORY_TYPES_Z.optional().describe("Default: reference."),
      tags: z.array(z.string()).optional(),
      project: z.string().optional().describe("Project name, or 'global' (default)."),
      pin: z.boolean().optional().describe("Pin to always surface at session start."),
      source: z.string().optional().describe("Where this fact came from (URL, 'user, <date>', or the producing tool). Fill it for provenance — it's shown when a write conflicts with an existing fact so you can judge which wins."),
      as: z.string().optional().describe("Explicit slug."),
      replace: z.string().optional().describe("Slug to overwrite in place."),
      supersedes: z.string().optional().describe("Slug of a fact this one RETIRES: the old fact disappears from recall (kept on disk + git). Use to resolve a surfaced conflict by replacing the old truth under a new slug. Mutually exclusive with replace (replace rewrites the same slug in place; supersedes retires the old slug and writes this under a new one)."),
      force: z.boolean().optional().describe("Write even if a near-duplicate exists."),
      platforms: z.array(PLATFORMS_Z).optional().describe("OS families this fact applies to. Omit for cross-platform."),
      ttl: z.string().optional().describe("Shelf life for a fact that ages (versions, ports, temp states, rotating creds): <N>d|w|m|y (e.g. 90d) sets review_by = today + N; surfaces for re-verification once due — never hides or deletes. Omit for timeless facts. Mutually exclusive with reviewBy."),
      reviewBy: z.string().optional().describe("Explicit re-verify date YYYY-MM-DD (alternative to ttl). On replace: omit to keep the existing date, pass \"\" to clear it."),
    },
  }, async ({ fact, type, tags, project, pin, source, as: asSlug, replace, supersedes, force, platforms, ttl, reviewBy }) => {
    try {
      const store = await getStore();
      const res = await remember(store, root, { fact, type, tags, project, pinned: pin, source, as: asSlug, replace, supersedes, force, platforms, ttl, reviewBy });
      let text: string;
      if (res.wrote) {
        text = `Remembered '${res.slug}' (${res.type}).`;
        if (!res.indexed) {
          text += "\nwarning: fact saved but not yet indexed (recall may lag until next reindex).";
        }
        if (res.syncWarning) {
          text += `\nwarning: ${res.syncWarning}`;
        }
        // A corruption-driven dedup gap (qmemd-e5h): this fact may duplicate one of the
        // unreadable candidate files the near-dup scan had to skip.
        if (res.dedupSkipped > 0) {
          text += `\nwarning: ${res.dedupSkipped} candidate fact(s) unreadable during the near-dup scan — a duplicate may have been missed (run 'qmemd doctor').`;
        }
        // Non-blocking report-shape nudge (qmemd-a3k): the fact was written, but the body looks
        // like a report/retro that belongs in docs/reports/, not the fact store.
        if (res.reportWarning) {
          text += `\nwarning: ${res.reportWarning}`;
        }
        if (res.supersededSlug) {
          text += `\nSuperseded '${res.supersededSlug}' — it is now hidden from recall.`;
        }
        if (res.conflictsWith) {
          text += `\nRecorded conflicts_with '${res.conflictsWith}': two contradictory facts now coexist — review and resolve (replace/supersede one).`;
        }
        if (res.supersedeWarning) {
          text += `\nwarning: ${res.supersedeWarning}`;
        }
      } else {
        // Show the colliding fact so the model can tell a true duplicate from a
        // contradicting/updating one, instead of being blocked blind (qmemd-cs0). The lead-in
        // and resolution hint depend on the disposition (qmemd-5td): a `conflict` is a likely
        // update to RESOLVE (same topic, a changed value), not a settled near-duplicate.
        text = res.disposition === "conflict"
          ? `Not written — possible contradiction/update vs '${res.duplicateOf}' (same topic, a changed value)`
          : `Not written — near-duplicate of '${res.duplicateOf}'`;
        if (res.duplicateDescription) text += `:\n  ${res.duplicateDescription}`;
        if (res.duplicateBody) text += `\n  ${res.duplicateBody.replace(/\n/g, "\n  ")}`;
        text += res.disposition === "conflict"
          ? `\nReview: pass replace:'${res.duplicateOf}' to update it, supersedes:'${res.duplicateOf}' to retire it under this new fact, force:true to keep both (records conflicts_with), or reword to write a distinct fact.`
          : `\nPass replace:'${res.duplicateOf}' to update it, or force:true to add anyway.`;
        // qmemd-vkn: on a conflict, show the type-derived authority of both facts plus the
        // colliding fact's raw source/date so the agent can judge which wins (engine never
        // auto-resolves). source strings are user prose; no fs path is exposed.
        if (res.authorityComparison) {
          const c = res.authorityComparison;
          const lean = c.verdict === "existing-higher"
            ? ` — the existing fact is MORE authoritative; don't overwrite it without cause.`
            : c.verdict === "incoming-higher"
              ? ` — your fact is more authoritative.`
              : ` — equal authority; use recency/context to decide.`;
          text += `\nAuthority: yours is type:${c.incoming.type} (tier ${c.incoming.tier}); existing '${res.duplicateOf}' is type:${c.existing.type} (tier ${c.existing.tier}, created ${c.existing.created})${lean}`;
          if (c.existing.source) text += `\n  existing source: ${c.existing.source}`;
          if (c.incoming.source) text += `\n  your source: ${c.incoming.source}`;
        }
      }
      // Allowlist the fields exposed to the model — never the absolute fs path, which
      // would leak the home-dir layout and aid a traversal feedback loop (qmemd-81n).
      // duplicateDescription/duplicateBody are the colliding fact's content (cs0), no path.
      // disposition is a safe enum (duplicate|conflict), no path (qmemd-5td).
      // authorityComparison is the conflict authority/provenance comparison (qmemd-vkn): type
      // ordinals, a verdict enum, and raw source/created prose — no fs path, safe to expose.
      // synced/syncWarning are the git-sync signal (qmemd-ddr): a boolean + a generic git
      // reason string (no fs path), safe to expose under the qmemd-81n allowlist.
      // dedupSkipped is the corruption-gap count (qmemd-e5h): a number, no fs path.
      // reportWarning is the report-shape nudge (qmemd-a3k): a generic guidance string, no fs path.
      // supersededSlug/conflictsWith are slugs, supersedeWarning a generic guidance string —
      // no fs path, safe under the qmemd-81n allowlist (bri/cr4).
      return { content: [{ type: "text", text }], structuredContent: { wrote: res.wrote, slug: res.slug, type: res.type, duplicateOf: res.duplicateOf, duplicateDescription: res.duplicateDescription, duplicateBody: res.duplicateBody, disposition: res.disposition, authorityComparison: res.authorityComparison, indexed: res.indexed, synced: res.synced, syncWarning: res.syncWarning, dedupSkipped: res.dedupSkipped, reportWarning: res.reportWarning, supersededSlug: res.supersededSlug, conflictsWith: res.conflictsWith, supersedeWarning: res.supersedeWarning } };
    } catch (err) {
      return sanitizeToolError(err);
    }
  });

  server.registerTool("recall", {
    title: "Recall",
    description: "Search qmemd memory for relevant facts, or get the session snapshot (session:true). Defaults to hybrid search; set lexOnly:true for a fast, model-free lexical search.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      query: z.string().optional().describe("Search query. Omit with session:true."),
      session: z.boolean().optional().describe("Return the start-of-session snapshot instead of searching."),
      type: MEMORY_TYPES_Z.optional(),
      limit: z.number().int().positive().optional().default(10).describe("Max results (default: 10)."),
      lexOnly: z.boolean().optional().describe("Skip vector/rerank — fast, model-free lexical (BM25) search. Default false (hybrid)."),
      minScore: z.number().min(0).optional().describe(`Hybrid-recall relevance floor: drop hits the reranker scores below this (reranker score is ~0.5 for neutral/irrelevant, ~0.7+ for relevant; default ${DEFAULT_MIN_SCORE}). Pass 0 to disable. Ignored when lexOnly:true.`),
      skim: z.boolean().optional().describe("Headline-only: return ranked hits without bodies, to cheaply scan what's relevant before fetching full facts with `get`."),
      project: z.string().optional().describe("Current project scope (default: server cwd basename). Scopes the snapshot and recall to this project + 'global'."),
      allPlatforms: z.boolean().optional().describe("Search across all platforms (disable the host-OS filter). Default false (scoped to the host OS)."),
      platform: PLATFORMS_Z.optional().describe("Scope to one OS family's facts instead of the host's — e.g. only macos facts from a linux host. Mutually exclusive with allPlatforms."),
      cross_project: z.boolean().optional().describe("Search ALL projects, not just current + global. Foreign hits are labelled with their project so they can't be mistaken for this project's facts. Default false."),
    },
    outputSchema: RECALL_OUTPUT_SCHEMA,
  }, async ({ query, session, type, limit, lexOnly, minScore, skim, project, allPlatforms, platform, cross_project }) => {
    try {
      if (session) {
        // Sync first (mirrors the CLI's recall --session) so the daemon never serves a stale
        // snapshot; best-effort, never throws (qmemd-wdf). Then scope: an explicit project wins;
        // else the server's configured default — the HTTP daemon passes 'global' because its cwd
        // is HOME (systemd WorkingDirectory=%h), not a project; else basename(cwd) for the
        // per-project stdio server, which previously surfaced only project:global (qmemd-3nq/wdf).
        const w = sessionSyncWarning(gitPullFfOnly(root, opts.gitDeps));
        // git unavailable ⇒ the daemon is serving a possibly-stale snapshot with sync off; log it
        // to the daemon log (stderr) rather than polluting the snapshot the model reads (qmemd-bwr).
        if (w) console.error(`[qmemd] ${w}`);
        const snap = await recallSession(root, { project: project ?? opts.sessionDefaultProject ?? basename(process.cwd()) });
        const snapshot = snap || "(no memories)";
        // outputSchema (os1) obliges structuredContent on every non-error result;
        // mirror REST /recall's session shape — a text snapshot, no fs path.
        return { content: [{ type: "text", text: snapshot }], structuredContent: { snapshot } };
      }
      // Reject the ambiguous combo exactly like REST /recall and the CLI (qmemd-dbr) —
      // otherwise one of the two silently wins and the caller can't tell which.
      if (platform !== undefined && allPlatforms) {
        return { content: [{ type: "text", text: "platform and allPlatforms are mutually exclusive — pass only one" }], isError: true };
      }
      if (!query) return { content: [{ type: "text", text: "Provide a query or session:true." }], isError: true };
      // Query-scope project (qmemd-due): an explicit project wins; else the server's configured
      // default (the HTTP daemon's 'global'); else basename(cwd) for a per-project stdio server.
      // Same resolution the session snapshot uses, so the `project` param means one thing.
      const currentProject = project ?? opts.sessionDefaultProject ?? basename(process.cwd());
      const store = await getStore();
      // Capability gate: when the caller gave no explicit lexOnly AND this is not the warm
      // daemon, default the mode from the host's GPU capability (lex on a CPU-only box).
      let effectiveLexOnly = lexOnly;
      if (shouldAutoResolve(lexOnly, opts.warmServer)) {
        // No explicit lexOnly and not the warm daemon. Honor the same env-level overrides as the
        // CLI (QMEMD_RECALL_MODE / QMD_FORCE_CPU / QMD_LLAMA_GPU) so both surfaces resolve
        // uniformly (spec §4), then fall through to the cached GPU probe only when nothing
        // explicit decided (mode "auto").
        const { mode } = resolveExplicitMode({});
        const resolved = mode === "auto" ? await (opts.resolveAutoMode ?? autoRecallMode)() : mode;
        effectiveLexOnly = resolved === "lex";
      }
      const { hits, degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden } = await recallQueryWithStatus(store, root, query, { type, limit, lexOnly: effectiveLexOnly, minScore, skim, platform: allPlatforms ? "all" : platform, project: currentProject, crossProject: cross_project });
      let text = hits.length
        ? hits.map(h => {
            const foreign = !!cross_project && h.project !== currentProject && h.project !== "global";
            const label = foreign ? `${h.type} ⊥ ${h.project}` : h.type;
            return `[${label}] ${h.description} (${h.slug})${h.platforms?.length ? " {" + h.platforms.join(",") + "}" : ""}${h.body ? "\n  " + h.body.replace(/\n/g, "\n  ") : ""}`;
          }).join("\n")
        : "No memories found.";
      // Completeness footer (qmemd-40h): tell the agent when the list is a partial view —
      // matches past `limit`, or hits the rerank floor hid — so a truncated result is not
      // read as "no such fact" (the R1 over-trust failure the snapshot's e3i footer covers).
      const footer = completenessFooter({ moreMatches, belowFloor, saturated, crossProjectHidden }, minScore ?? DEFAULT_MIN_SCORE, "api");
      if (footer) text += `\nnote: ${footer}`;
      // A degraded hybrid recall fell back toward lexical (the embed barrier threw or only
      // partially embedded) — warn so the agent doesn't read a semantically half-skipped
      // result as a confident answer (qmemd-9t1), mirroring the remember-path indexed:false.
      if (degraded) text += `\nwarning: hybrid recall degraded to lexical — ${pendingVectorPhrase(vectorsPending)} still pending; semantic matches may be missing (run 'qmemd embed').`;
      // Explicit field pick (never a spread of RecallHit) so the absolute fs path can
      // never leak to the model (qmemd-81n); `body` is the truncated preview (bgf).
      // degraded/vectorsPending are the embed-barrier health signal (qmemd-9t1), and
      // moreMatches/belowFloor/saturated the completeness counters (qmemd-40h) — numbers +
      // booleans, no fs path — safe under the allowlist. MCP recall is always capped — an
      // agent needing the full body calls `get`.
      return { content: [{ type: "text", text }], structuredContent: { hits: hits.map(toHitDTO), degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden } };
    } catch (err) {
      return sanitizeToolError(err);
    }
  });

  server.registerTool("forget", {
    title: "Forget",
    description: "Delete a remembered fact by slug.",
    annotations: { readOnlyHint: false, openWorldHint: false },
    inputSchema: { slug: z.string() },
  }, async ({ slug }) => {
    try {
      const store = await getStore();
      const res = await forgetFact(store, root, slug);
      if (!res.removed) return { content: [{ type: "text", text: `No memory named '${slug}'.` }], structuredContent: { removed: res.removed }, isError: true };
      const text = res.syncWarning ? `Forgot '${slug}'.\nwarning: ${res.syncWarning}` : `Forgot '${slug}'.`;
      return { content: [{ type: "text", text }], structuredContent: { removed: res.removed, synced: res.synced, syncWarning: res.syncWarning } };
    } catch (err) {
      return sanitizeToolError(err);
    }
  });

  server.registerTool("reviewed", {
    title: "Reviewed",
    description: "Mark a fact re-verified — reset its staleness clock. Forward-sets review_by (default: today + the type's review window; or pass ttl/reviewBy). Bare on a durable type (user/feedback) marks review_by:never. Never edits the body — use remember(replace:) if the fact itself changed.",
    annotations: { readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      slug: z.string().describe("Slug of the fact you re-verified (as returned by recall/list)."),
      ttl: z.string().optional().describe("Shelf life: <N>d|w|m|y sets review_by = today + N; \"never\" marks the fact durable. Mutually exclusive with reviewBy."),
      reviewBy: z.string().optional().describe("Explicit next-review date YYYY-MM-DD (or \"never\"). Mutually exclusive with ttl."),
    },
  }, async ({ slug, ttl, reviewBy }) => {
    try {
      const store = await getStore();
      const res = await markReviewed(store, root, slug, { ttl, reviewBy });
      const tail = res.syncWarning ? `\nwarning: ${res.syncWarning}` : "";
      const text = res.reviewBy === "never"
        ? `Marked '${slug}' durable (review_by: never).${tail}`
        : `Reviewed '${slug}' (next review ${res.reviewBy}).${tail}`;
      // Allowlist (qmemd-81n): expose the slug, the new review date, and the git-sync signal —
      // NEVER markReviewed's absolute `path`. The engine's reindex-failure log writes e.message
      // to stderr only (the same model-safe sink every engine log uses — mirrors forget), so no
      // fs path reaches the model; the path-free throws (invalid ttl / no fact named / unsafe
      // slug / invalid review_by) surface verbatim via sanitizeToolError.
      return { content: [{ type: "text", text }], structuredContent: { slug: res.slug, reviewBy: res.reviewBy, synced: res.synced, syncWarning: res.syncWarning } };
    } catch (err) {
      return sanitizeToolError(err);
    }
  });

  server.registerTool("get", {
    title: "Get",
    description: "Fetch one remembered fact in full by slug — the complete body, not the truncated preview recall returns. Errors if no fact has that slug.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { slug: z.string().describe("Slug of the memory to fetch (as returned by recall/list).") },
  }, async ({ slug }) => {
    try {
      // An unsafe (traversal/newline) slug makes getFact throw via assertSafeSlug. Its
      // message is path-free and an intentional client-facing signal, so sanitizeToolError
      // re-surfaces it verbatim (qmemd-fd8) while still scrubbing a downstream fs/SQLite
      // error's absolute path before it reaches the model (qmemd-3lt).
      const fact = getFact(root, slug);
      if (!fact) return { content: [{ type: "text", text: `No memory named '${slug}'.` }], isError: true };
      const fm = fact.frontmatter;
      const body = fact.body.trim();
      // Explicit field pick — never the absolute fs path (qmemd-81n).
      return {
        content: [{ type: "text", text: `[${fact.type}] ${fm.description}\n\n${body}` }],
        structuredContent: toFactDTO(fact),
      };
    } catch (err) {
      return sanitizeToolError(err);
    }
  });

  server.registerTool("list", {
    title: "List",
    description: "Browse remembered facts by type/tag/project without searching — model-free. An empty corpus is a successful empty result, not an error.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: MEMORY_TYPES_Z.optional().describe("Scope to one type."),
      tag: z.string().optional(),
      project: z.string().optional().describe("Only facts for this project (plus 'global'); pass 'global' for global-only."),
      platform: PLATFORMS_Z.optional().describe("Only facts valid on this OS family."),
    },
  }, async ({ type, tag, project, platform }) => {
    try {
      const entries = listFacts(root, { type, tag, project, platform });
      const text = entries.length ? entries.map(e => `[${e.type}] ${e.slug} — ${e.description}${e.supersededBy ? ` [superseded by ${e.supersededBy}]` : ""}`).join("\n") : "No memories.";
      // ListEntry carries no fs path — safe to expose wholesale (qmemd-81n).
      return { content: [{ type: "text", text }], structuredContent: { entries: entries.map(toListEntryDTO) } };
    } catch (err) {
      return sanitizeToolError(err);
    }
  });

  return server;
}

/**
 * Build the MCP server over an already-open, eager store — the warm-shared-store path used by the
 * HTTP daemon and the in-process tests. Thin wrapper over buildMemoryServerLazy (qmemd-faif.10).
 */
export function buildMemoryServer(store: QMDStore, root: string, opts: MemoryServerOptions = {}): McpServer {
  return buildMemoryServerLazy(() => Promise.resolve(store), root, opts);
}

export async function startMcpServer(): Promise<void> {
  const root = memoryRoot();
  // Connect-first (qmemd-faif.10): open the SQLite store lazily and memoized, on the first tool
  // call that needs it — so `initialize` is answered before native better-sqlite3 is touched. A
  // cold start (or an npx/clean-room launch whose binding is unbuilt) still completes the handshake.
  let storeP: Promise<QMDStore> | undefined;
  const getStore = (): Promise<QMDStore> => (storeP ??= openMemoryStore());
  const server = buildMemoryServerLazy(getStore, root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// =============================================================================
// Transport: Streamable HTTP + REST (localhost only) — one warm shared store
// =============================================================================

export type HttpServerHandle = {
  httpServer: Server;
  port: number;
  stop: () => Promise<void>;
};

/** JSON response helper. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Collect a request body to a string. */
async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/**
 * Read + JSON-parse a POST body. Returns {ok:false} on malformed JSON so the handler can
 * answer 400 — a client error — instead of letting the SyntaxError fall through to the
 * catch-all 500 + a per-request stack trace in the long-lived daemon log (qmemd-bzq). The
 * discriminated result (not a null sentinel) keeps a body of literal `null` distinct from a
 * parse failure. /mcp does not use this — it needs the exact raw string to forward to the
 * transport, so it guards JSON.parse inline.
 */
async function parseJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try { return { ok: true, value: JSON.parse(await collectBody(req)) }; }
  catch { return { ok: false }; }
}

// --- localhost guard (qmemd-1z9) --------------------------------------------
// The daemon binds loopback, but that does NOT stop attacks: a malicious page in the
// user's own browser can fetch() loopback (CSRF writes via a CORS-simple POST), and DNS
// rebinding can make loopback responses cross-origin-readable (corpus exfil — the corpus
// holds live SSH/DB/Redis/Gitea creds + PATs). The SDK's transport-level DNS-rebinding
// options are @deprecated in favour of external middleware, so we guard ALL routes
// (/mcp + REST) here uniformly instead of relying on them.

/**
 * A Host header whose hostname is loopback. Port is intentionally ignored: an attacker
 * cannot make a victim browser send a loopback Host for a request aimed at evil.com, so
 * matching the hostname alone defeats DNS rebinding. Absent Host (anomalous in HTTP/1.1)
 * is rejected.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Origin is allowed when absent or "null" (non-browser clients like Claude Code / curl,
 * or an opaque origin) or when it is itself a loopback origin. A cross-origin browser
 * request — the CSRF/exfil vector — carries an Origin that fails this, so it is rejected.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Require an exact application/json media type on write/data POSTs. text/plain (and the
 * other CORS-simple types) would let a cross-origin page POST without a preflight;
 * demanding application/json forces a preflight that the un-CORS-headed server cannot
 * satisfy, so cross-origin writes never leave the browser.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Start the MCP server over Streamable HTTP (JSON responses, no SSE) plus a REST
 * surface, binding the 127.0.0.1 loopback only. One store is opened and shared by every
 * request, so the embedding model stays warm across recalls. Returns a handle for
 * shutdown and port discovery (pass port 0 for an OS-assigned ephemeral port).
 */
export async function startMcpHttpServer(
  port: number,
  options: { quiet?: boolean } = {},
): Promise<HttpServerHandle> {
  const store = await openMemoryStore();
  const root = memoryRoot();
  const quiet = options.quiet ?? false;
  const startTime = Date.now();

  // qmemd's tools are independent calls on the shared store — no session continuity is needed,
  // so the MCP transport runs STATELESS. The WebStandard stateless transport cannot be reused
  // across requests ("Stateless transport cannot be reused across requests. Create a new
  // transport per request."), so every /mcp request gets a fresh McpServer + transport that is
  // handled and closed immediately: no session id is issued, no session map is kept, and nothing
  // accumulates on the long-lived daemon. This replaces the old stateful map keyed by
  // mcp-session-id that only evicted on transport.onclose and so grew unboundedly when a client
  // never closed (qmemd-pf9 — the leak was a symptom of statefulness qmemd never needed). The
  // SDK does not gate tool calls on a per-request initialize, so a client that initializes once
  // then sends independent tool-call POSTs works. Building a server is cheap (registers the 5
  // tools, no IO/model); the store stays shared + warm. Daemon snapshot default 'global'
  // (qmemd-wdf): the daemon cwd is HOME, not a project.
  async function dispatchMcp(request: Request, parsedBody: unknown): Promise<Response> {
    const server = buildMemoryServer(store, root, { sessionDefaultProject: "global", warmServer: true });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, parsedBody !== undefined ? { parsedBody } : undefined);
    } finally {
      try { await transport.close(); } catch (e) { console.error("transport close error:", e); }
      try { await server.close(); } catch (e) { console.error("server close error:", e); }
    }
  }

  function log(msg: string): void { if (!quiet) console.error(msg); }

  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const url = new URL(nodeReq.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;
    const method = nodeReq.method || "GET";

    try {
      // localhost guard (qmemd-1z9): reject DNS-rebinding (non-loopback Host) and
      // cross-origin browser requests (CSRF/exfil), and require application/json on POSTs
      // so a CORS-simple cross-origin write cannot skip its preflight. Runs before routing.
      if (!isLoopbackHost(nodeReq.headers.host)) {
        sendJson(nodeRes, 403, { error: "forbidden: non-loopback Host header" });
        return;
      }
      if (!isAllowedOrigin(nodeReq.headers.origin)) {
        sendJson(nodeRes, 403, { error: "forbidden: cross-origin request rejected" });
        return;
      }
      if (method === "POST" && !isJsonContentType(nodeReq.headers["content-type"])) {
        sendJson(nodeRes, 415, { error: "unsupported media type: POST requires Content-Type: application/json" });
        return;
      }

      if (pathname === "/health" && method === "GET") {
        // rootHash (qmemd-vuk): identity of the served memory root, as a sha256 so no
        // absolute fs path leaves the process (qmemd-81n discipline). The CLI compares it
        // against its own root before delegating a recall here — and its presence doubles
        // as the capability marker for the /recall `platform` param (same commit).
        sendJson(nodeRes, 200, { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000), rootHash: rootHash(root) });
        return;
      }

      // ---- MCP (stateless): forward every /mcp request to the one shared transport ----
      // No session lookup or creation — the stateless transport issues no session id and
      // validates none. POST bodies are JSON-parsed here so a malformed body answers 400 (not a
      // 500 + per-request stack trace in the daemon log, qmemd-bzq) and the parsed body is
      // forwarded; GET/DELETE carry no body.
      if (pathname === "/mcp") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) if (typeof v === "string") headers[k] = v;
        let rawBody: string | undefined;
        let parsedBody: unknown;
        if (method === "POST") {
          rawBody = await collectBody(nodeReq);
          try { parsedBody = JSON.parse(rawBody); }
          catch { sendJson(nodeRes, 400, { error: "invalid JSON body" }); return; }
        } else if (method !== "GET" && method !== "HEAD") {
          rawBody = await collectBody(nodeReq);
        }
        const request = new Request(`http://localhost:${port}/mcp`, { method, headers, ...(rawBody !== undefined ? { body: rawBody } : {}) });
        const response = await dispatchMcp(request, parsedBody);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      // ---- REST: recall ----
      if (pathname === "/recall" && method === "POST") {
        const parsed = await parseJsonBody(nodeReq);
        if (!parsed.ok) { sendJson(nodeRes, 400, { error: "invalid JSON body" }); return; }
        const body = parsed.value as {
          query?: string; session?: boolean; type?: MemoryType;
          limit?: number; lexOnly?: boolean; minScore?: number; project?: string; full?: boolean; skim?: boolean; allPlatforms?: boolean;
          platform?: string; crossProject?: boolean;
        };
        if (body.session) {
          // Sync first (mirrors the CLI), and default the project to 'global' — the daemon's
          // cwd is HOME, not a project, so basename(cwd) would under-return (qmemd-wdf).
          const w = sessionSyncWarning(gitPullFfOnly(root));
          if (w) console.error(`[qmemd] ${w}`); // qmemd-bwr: sync off → daemon log, not the response
          const snapshot = await recallSession(root, { project: body.project ?? "global" });
          sendJson(nodeRes, 200, { snapshot });
          return;
        }
        if (body.type !== undefined && !(MEMORY_TYPES as string[]).includes(body.type)) {
          sendJson(nodeRes, 400, { error: `invalid type '${body.type}'. Use one of: ${MEMORY_TYPES.join(" | ")}` });
          return;
        }
        // Input-validation parity with the CLI (qmemd-4hh): reject a negative/non-finite minScore
        // (400, like cli requireValidType's sibling check), and clamp limit to >=1 so it never
        // reaches store.search as 0/negative — which slice(0, limit) would turn into an empty or
        // last-N-dropped result. A non-numeric limit falls back to the engine default (10).
        if (body.minScore !== undefined && (typeof body.minScore !== "number" || !Number.isFinite(body.minScore) || body.minScore < 0)) {
          sendJson(nodeRes, 400, { error: "minScore must be a number >= 0" });
          return;
        }
        const limit = body.limit !== undefined && Number.isFinite(Number(body.limit))
          ? Math.max(1, Math.floor(Number(body.limit)))
          : undefined;
        // Specific-platform scoping (qmemd-5gx REST half, shipped with vuk for CLI
        // delegation parity): validate against the closed set, and reject the combo with
        // allPlatforms exactly like the CLI does (qmemd-dbr) — otherwise one of the two
        // silently wins and the caller can't tell which.
        if (body.platform !== undefined && !(PLATFORMS as string[]).includes(body.platform)) {
          sendJson(nodeRes, 400, { error: `invalid platform '${body.platform}'. Use one of: ${PLATFORMS.join(" | ")}` });
          return;
        }
        if (body.platform !== undefined && body.allPlatforms) {
          sendJson(nodeRes, 400, { error: "platform and allPlatforms are mutually exclusive — pass only one" });
          return;
        }
        if (!body.query) { sendJson(nodeRes, 400, { error: "Provide query or session:true." }); return; }
        const { hits, degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden } = await recallQueryWithStatus(store, root, body.query, {
          // `full` is a deliberate REST-only extension; the MCP recall tool stays capped (agents call `get`).
          type: body.type, limit, lexOnly: body.lexOnly, minScore: body.minScore, fullBody: body.full, skim: body.skim,
          platform: body.allPlatforms ? "all" : (body.platform as Platform | undefined),
          project: body.project, crossProject: body.crossProject,
        });
        // degraded/vectorsPending: the embed-barrier health signal (qmemd-9t1), mirroring MCP.
        // moreMatches/belowFloor/saturated: the completeness counters (qmemd-40h), same mirror —
        // counts + a bool only, no prose (REST clients render their own footer).
        sendJson(nodeRes, 200, { hits: hits.map(toHitDTO), degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden });
        return;
      }

      // ---- REST: remember ----
      if (pathname === "/remember" && method === "POST") {
        const parsed = await parseJsonBody(nodeReq);
        if (!parsed.ok) { sendJson(nodeRes, 400, { error: "invalid JSON body" }); return; }
        const body = parsed.value as {
          fact?: string; type?: string; tags?: string[]; project?: string;
          pin?: boolean; source?: string; as?: string; replace?: string; supersedes?: string; force?: boolean; platforms?: unknown;
          ttl?: unknown; reviewBy?: unknown;
        };
        if (!body.fact || typeof body.fact !== "string") { sendJson(nodeRes, 400, { error: "Missing required field: fact" }); return; }
        if (body.type !== undefined && !(MEMORY_TYPES as string[]).includes(body.type)) {
          sendJson(nodeRes, 400, { error: `invalid type '${body.type}'. Use one of: ${MEMORY_TYPES.join(" | ")}` });
          return;
        }
        // tags must be an array of strings (qmemd-4hh): a non-array or non-string element reaches
        // engine frontmatter and corrupts it or 500s. The MCP tool's z.array(z.string()) enforces
        // this already, so the REST surface must match the contract.
        if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string"))) {
          sendJson(nodeRes, 400, { error: "tags must be an array of strings" });
          return;
        }
        // platforms must be an array of known OS tokens (qmemd-4hh parity): a non-array or
        // unknown element would corrupt frontmatter or 500. Mirrors the MCP z.array(enum).
        // Case-insensitive (qmemd-fvv): accept mixed case like the CLI; remember() lowercases before storing.
        if (body.platforms !== undefined && (!Array.isArray(body.platforms) || !body.platforms.every((p) => typeof p === "string" && (PLATFORMS as string[]).includes(p.toLowerCase())))) {
          sendJson(nodeRes, 400, { error: `platforms must be an array of: ${PLATFORMS.join(" | ")}` });
          return;
        }
        // ttl/reviewBy must be strings (4hh parity, 9su): a non-string would TypeError inside
        // the engine's .trim() and 500. Value/format validation lives in the engine (→ 400).
        if (body.ttl !== undefined && typeof body.ttl !== "string") {
          sendJson(nodeRes, 400, { error: "ttl must be a string like '90d'" });
          return;
        }
        if (body.reviewBy !== undefined && typeof body.reviewBy !== "string") {
          sendJson(nodeRes, 400, { error: "reviewBy must be a YYYY-MM-DD string" });
          return;
        }
        const res = await remember(store, root, {
          fact: body.fact, type: body.type as MemoryType | undefined, tags: body.tags,
          project: body.project, pinned: body.pin, source: body.source,
          as: body.as, replace: body.replace, supersedes: body.supersedes, force: body.force,
          platforms: body.platforms as Platform[] | undefined,
          ttl: body.ttl, reviewBy: body.reviewBy,
        });
        sendJson(nodeRes, 200, { wrote: res.wrote, slug: res.slug, type: res.type, duplicateOf: res.duplicateOf, duplicateDescription: res.duplicateDescription, duplicateBody: res.duplicateBody, disposition: res.disposition, indexed: res.indexed, synced: res.synced, syncWarning: res.syncWarning, dedupSkipped: res.dedupSkipped, reportWarning: res.reportWarning, supersededSlug: res.supersededSlug, conflictsWith: res.conflictsWith, supersedeWarning: res.supersedeWarning });
        return;
      }

      // ---- REST: forget ----
      if (pathname === "/forget" && method === "POST") {
        const parsed = await parseJsonBody(nodeReq);
        if (!parsed.ok) { sendJson(nodeRes, 400, { error: "invalid JSON body" }); return; }
        const body = parsed.value as { slug?: string };
        if (!body.slug) { sendJson(nodeRes, 400, { error: "Missing required field: slug" }); return; }
        const res = await forgetFact(store, root, body.slug); // unsafe slug throws -> caught -> 400
        sendJson(nodeRes, res.removed ? 200 : 404, { removed: res.removed, synced: res.synced, syncWarning: res.syncWarning });
        return;
      }

      // ---- REST: list ----
      if (pathname === "/list" && method === "GET") {
        const type = url.searchParams.get("type") ?? undefined;
        if (type !== undefined && !(MEMORY_TYPES as string[]).includes(type)) {
          sendJson(nodeRes, 400, { error: `invalid type '${type}'. Use one of: ${MEMORY_TYPES.join(" | ")}` });
          return;
        }
        const platformRaw = url.searchParams.get("platform");
        const platform = platformRaw === null ? undefined : platformRaw.toLowerCase(); // case-insensitive (qmemd-fvv)
        if (platform !== undefined && !(PLATFORMS as string[]).includes(platform)) {
          sendJson(nodeRes, 400, { error: `invalid platform '${platformRaw}'. Use one of: ${PLATFORMS.join(" | ")}` });
          return;
        }
        const entries = listFacts(root, {
          type: type as MemoryType | undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          project: url.searchParams.get("project") ?? undefined,
          platform: platform as Platform | undefined,
        });
        sendJson(nodeRes, 200, { entries: entries.map(toListEntryDTO) });
        return;
      }

      // ---- REST: get ----
      if (pathname === "/get" && method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) { sendJson(nodeRes, 400, { error: "Missing required query param: slug" }); return; }
        const fact = getFact(root, slug); // unsafe slug throws -> caught -> 400
        if (!fact) { sendJson(nodeRes, 404, { error: `No memory named '${slug}'.` }); return; }
        sendJson(nodeRes, 200, toFactDTO(fact));
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A client error with a path-free, client-safe message, not a server fault (qmemd-81n):
      // an unsafe slug (assertSafeSlug, qmemd-fd8), a --replace/--supersedes naming a nonexistent
      // fact (qmemd-acm/bri), or a bad supersedes combination (bri). 400, not the catch-all 500.
      if (msg.startsWith("unsafe slug") || msg.startsWith("no fact named") || msg.startsWith("invalid platform") || msg.startsWith("supersedes cannot") || msg.startsWith("a fact cannot supersede itself") || msg.startsWith("invalid review_by") || msg.startsWith("invalid ttl")) { sendJson(nodeRes, 400, { error: msg }); return; }
      console.error("HTTP handler error:", err);
      if (!nodeRes.headersSent) { nodeRes.writeHead(500); nodeRes.end("Internal Server Error"); }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    // Bind the IPv4 loopback explicitly, NOT "localhost". On an IPv6-first host
    // (e.g. CI, where localhost resolves to ::1) "localhost" binds ::1-only, but the
    // CLI client connects to 127.0.0.1 (src/client.ts) — so daemon delegation would
    // silently fail and the end-to-end loopback-guard tests get ECONNREFUSED. 127.0.0.1
    // is deterministic and is exactly what the client + the loopback guard target.
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });
  const actualPort = (httpServer.address() as import("node:net").AddressInfo).port;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // Per-request MCP servers+transports are already closed after each request (dispatchMcp),
      // so nothing MCP-persistent remains to tear down here (qmemd-pf9). Stop accepting
      // connections AND drop keep-alive sockets so close() resolves promptly — without
      // closeAllConnections an idle keep-alive client can stall it.
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      await store.close(); // always release the SQLite handle, even if teardown above throws
    }
  };

  // Process-global handlers: startMcpHttpServer is intended to run ONCE per process
  // (the daemon). The returned handle exposes no deregistration, so it must not be
  // called multiple times in a single process.
  const shutdown = (signal: string): void => {
    log(`Shutting down (${signal})...`);
    stop().then(() => process.exit(0)).catch((e) => { console.error("shutdown error:", e); process.exit(1); });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log(`qmemd MCP server listening on http://localhost:${actualPort}/mcp`);
  return { httpServer, port: actualPort, stop };
}
