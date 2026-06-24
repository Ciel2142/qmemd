#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, join as pathJoin, dirname } from "node:path";
import { openMemoryStore, MEMORY_COLLECTION } from "../store.js";
import { remember, recallQueryWithStatus, recallSession, forget, getFact, listFacts, staleFacts, markReviewed, projectOverview, formatTagHistogram, countUnreadableFacts, pendingVectorPhrase, completenessFooter, MEMORY_TYPES, PLATFORMS, DEFAULT_MIN_SCORE, applyMerge } from "../engine.js";
import type { MemoryType, Platform, RecallResult, RecallHit, MergePlan, StaleReport } from "../engine.js";
import { tryDaemonRecall } from "../client.js";
import { runBeacon, runWriteBeacon } from "../beacon.js";
import { gitPullFfOnly, sessionSyncWarning } from "../git.js";
import { memoryRoot, cacheDir, daemonPaths, systemdUserDir, qmemdConfigDir, launchAgentsDir, macLogsDir } from "../paths.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from "node:fs";
import { serviceArtifacts, captureDaemonEnv, writeArtifacts, removeArtifacts } from "../service.js";
import { auditMemory, fixMemory, type FactReport } from "../doctor.js";
import { dedupReport, mergeProposal, buildMergeCommands, DEDUP_REPORT_DICE, type DedupReport, type MergeProposal } from "../dedup.js";

const g = "\x1b[32m", y = "\x1b[33m", d = "\x1b[2m", r = "\x1b[0m", cy = "\x1b[36m";

/**
 * Validate a CLI --type value against the closed MemoryType enum (qmemd-jzz).
 * parseArgs yields an arbitrary string; casting it straight to MemoryType let it
 * become a path segment (join(root, type) + mkdirSync), so `--type ../../x`
 * escaped the memory root and `--type bogus` wrote an unrecallable folder. The
 * MCP path is already guarded by a zod enum. Exits non-zero on an invalid value.
 */
function requireValidType(t: string | undefined): MemoryType | undefined {
  if (t === undefined) return undefined;
  if (!(MEMORY_TYPES as string[]).includes(t)) {
    console.error(`invalid --type '${t}'. Use one of: ${MEMORY_TYPES.join(" | ")}`);
    process.exit(1);
  }
  return t as MemoryType;
}

/** Validate a single --platform value against PLATFORMS (qmemd-jzz sibling). Exits 1 on invalid. */
function requireValidPlatform(p: string | undefined): Platform | undefined {
  if (p === undefined) return undefined;
  const lc = p.toLowerCase(); // case-insensitive, mirroring the lowercasing write path (qmemd-fvv)
  if (!(PLATFORMS as string[]).includes(lc)) {
    console.error(`invalid --platform '${p}'. Use one of: ${PLATFORMS.join(" | ")}`);
    process.exit(1);
  }
  return lc as Platform;
}

/** Split + validate a comma-separated --platforms value (like --tags). Exits 1 on any unknown token. */
function parsePlatformsCsv(s: string | undefined): Platform[] | undefined {
  if (s === undefined) return undefined; // flag absent → undefined → inherit the existing scope on --replace
  const toks = s.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  if (toks.length === 0) return []; // explicit --platforms "" → [] → CLEAR scope to cross-platform; the CLI un-scope path on --replace, matching the MCP/HTTP platforms:[] surface (qmemd-t0z)
  const bad = toks.filter(t => !(PLATFORMS as string[]).includes(t));
  if (bad.length > 0) {
    console.error(`invalid --platforms '${bad.join(", ")}'. Use any of: ${PLATFORMS.join(" | ")}`);
    process.exit(1);
  }
  return [...new Set(toks)] as Platform[];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** Render doctor's per-fact integrity report: the relative path, then each issue
 *  with its code, detail, and whether `--fix` can repair it. (qmemd-61h) */
function printDoctorReports(reports: FactReport[]): void {
  for (const rep of reports) {
    console.log(`${cy}${rep.relpath}${r}`);
    for (const iss of rep.issues) {
      const tag = iss.fixable ? `${g}fixable${r}` : `${y}needs review${r}`;
      console.log(`  ${iss.code}${iss.detail ? ` — ${iss.detail}` : ""} ${d}[${tag}]${r}`);
    }
  }
}

/** Render the offline within-project near-dup report (qmemd-dao): one block per cluster
 *  (project, member count, Dice range, member headlines), then a summary footer. The
 *  clusters are review candidates for merge — never auto-merged. (no model) */
function printDedupReport(report: DedupReport): void {
  const { clusters, threshold, comparisons } = report;
  if (clusters.length === 0) {
    console.log(`${g}✓${r} no within-project near-dup clusters above Dice ${threshold}.`);
    return;
  }
  for (const c of clusters) {
    const range = c.minDice === c.maxDice ? c.maxDice.toFixed(2) : `${c.minDice.toFixed(2)}–${c.maxDice.toFixed(2)}`;
    console.log(`${cy}[${c.project}]${r} cluster of ${c.members.length} ${d}· dice ${range}${r}`);
    for (const m of c.members) console.log(`  ${m.slug} ${d}— ${m.description}${r}`);
  }
  const buckets = new Set(clusters.map(c => c.project)).size;
  console.log(`\n${y}${clusters.length} cluster(s)${r} across ${buckets} project bucket(s) ${d}· ${comparisons} within-bucket comparisons · token-set Dice ≥ ${threshold} (no model)${r}`);
  console.log(`${d}↳ review each cluster, then fold unique detail into one keeper: ${r}qmemd remember --replace <keeper> ${d}and${r} qmemd forget <others>`);
}

function printMergeProposal(p: MergeProposal): void {
  if (p.clusters.length === 0) {
    console.log(`${g}✓${r} no within-project near-dup clusters above Dice ${p.threshold}.`);
    return;
  }
  for (const c of p.clusters) {
    const range = c.minDice === c.maxDice ? c.maxDice.toFixed(2) : `${c.minDice.toFixed(2)}–${c.maxDice.toFixed(2)}`;
    console.log(`\n${cy}[${c.project}]${r} cluster of ${c.members.length} ${d}· dice ${range} · keeper hint: ${c.suggestedKeeper}${r}`);
    for (const m of c.members) {
      const scope = m.platforms.length ? m.platforms.join(",") : "all";
      const star = m.slug === c.suggestedKeeper ? " ★" : "";
      console.log(`  ${m.slug}${star} ${d}[${m.tags.join(",") || "no tags"} · ${scope}${m.pinned ? " · pinned" : ""}]${r}`);
      for (const line of m.body.split("\n")) console.log(`    ${d}${line}${r}`);
    }
    console.log(`${d}↳ fold every unique datum into the keeper, then retire the rest:${r}`);
    for (const cmd of buildMergeCommands(c)) console.log(`  ${cmd}`);
  }
  console.log(`\n${y}${p.clusters.length} cluster(s)${r} ${d}· proposal only — review bodies, edit the folded text, run the commands (no model, no mutation)${r}`);
}

/** Render a recall result: hits (or JSON), the 9t1 degraded warning, and the 40h
 *  completeness footer. Shared by the local store path and the warm-daemon delegated
 *  path (qmemd-vuk) so the two are indistinguishable in output. */
function printRecallResult(res: RecallResult, json: boolean, minScore: number | undefined, scope: { project?: string; crossProject?: boolean } = {}): void {
  const { hits, degraded, vectorsPending, moreMatches, belowFloor, saturated, crossProjectHidden } = res;
  if (degraded) console.error(`${y}warning:${r} hybrid recall degraded to lexical — ${pendingVectorPhrase(vectorsPending)} still pending; semantic matches may be missing (run: qmemd embed)`);
  const footer = completenessFooter({ moreMatches, belowFloor, saturated, crossProjectHidden }, minScore ?? DEFAULT_MIN_SCORE, "cli");
  if (json) { console.log(JSON.stringify(hits, null, 2)); if (footer) console.error(`note: ${footer}`); return; }
  if (hits.length === 0) { console.log(`${d}No memories found.${footer ? ` ↳ ${footer}` : ""}${r}`); return; }
  // In --cross-project mode, partition for DISPLAY only (qmemd-due): current-project + global hits
  // first, then a divider, then foreign hits tagged with their project. In default mode the engine
  // already removed foreign hits, so `foreign` is empty and the divider never prints.
  const isForeign = (h: RecallHit): boolean =>
    !!scope.crossProject && scope.project !== undefined && h.project !== scope.project && h.project !== "global";
  const line = (h: RecallHit, tag: string): void => {
    const plat = h.platforms?.length ? ` ${d}{${h.platforms.join(",")}}${r}` : "";
    console.log(`${cy}[${h.type}${tag}]${r} ${h.description} ${d}(${h.slug})${r}${plat}`);
    if (h.body) console.log(`  ${h.body.replace(/\n/g, "\n  ")}`); // indented, mirrors recallSession withBody
  };
  for (const h of hits.filter(x => !isForeign(x))) line(h, "");
  const foreign = hits.filter(isForeign);
  if (foreign.length) {
    console.log(`${d}— other projects —${r}`);
    for (const h of foreign) line(h, ` ⊥ ${h.project}`);
  }
  if (footer) console.log(`${d}↳ ${footer}${r}`);
}

/** Render the staleness report (due + unreviewed lanes). Single source — called by
 *  both `stale` and `doctor` (Task 6). (qmemd-s4w) */
function printStale(report: StaleReport): void {
  const today = new Date().toISOString().slice(0, 10);
  const overdueDays = (d: string): number =>
    Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000));
  if (report.due.length > 0) {
    console.log(`${y}Due for review (${report.due.length}):${r}`);
    for (const e of report.due) {
      const od = overdueDays(e.dueDate!);
      const how = e.reviewBy ? "review_by" : "implicit"; // implicit = never reviewed, past its type window
      console.log(`  ${cy}[${e.type}]${r} ${e.slug} ${d}—${r} ${e.description} ${d}(${how} ${e.dueDate}${od > 0 ? `, ${od}d overdue` : ", due today"})${r}`);
    }
  }
  if (report.unreviewed.length > 0) {
    console.log(`${cy}Never reviewed (${report.unreviewed.length} of ${report.unreviewedTotal} decay-prone, not yet due):${r}`);
    for (const e of report.unreviewed) {
      const touched = (e.updated ?? e.created ?? "").slice(0, 10) || "unknown";
      console.log(`  ${cy}[${e.type}]${r} ${e.slug} ${d}—${r} ${e.description} ${d}(last touched ${touched})${r}`);
    }
  }
}

/** The usage block, shared by bare `qmemd`, `qmemd help`, and `qmemd --help`/`-h`. */
function printUsage(): void {
  console.log("qmemd <remember|recall|forget|reviewed|show|list|stale|status|embed|reindex|doctor|dedup|mcp>");
  console.log("  qmemd remember <fact> [--type user|feedback|project|reference] [--tags a,b] [--platforms linux,macos] [--pin] [--as slug] [--replace slug] [--supersedes slug] [--source S] [--ttl 90d|--review-by YYYY-MM-DD] [--force]");
  console.log("    --supersedes <slug>: write this fact AND retire <slug> (hidden from recall, linked in frontmatter, one commit)");
  console.log("    --ttl <N>d|w|m|y / --review-by <date>: schedule a re-verify date for a fact that ages — `qmemd stale` surfaces it once due");
  console.log("    on --replace: omit --tags/--platforms/--review-by to keep the existing values, or pass \"\" to clear them");
  console.log("  qmemd recall <query> [--lex] [--cross-project] [--type T] [--platform P|--all-platforms] [--limit N] [--min-score N] [--full|--skim] [--json]");
  console.log("  qmemd recall --session                 - session snapshot (for hooks)");
  console.log("  qmemd show <slug>                      - print one fact in full (no model)");
  console.log("  qmemd list [--type T] [--tag t] [--project p] [--platform P] [--json]  - browse the corpus (no model)");
  console.log("  qmemd stale [--limit N] [--json]       - facts past review_by + oldest unreviewed; lists only, never removes (no model)");
  console.log("  qmemd reviewed <slug> [--ttl <N>d|w|m|y|never] [--review-by <date>]  - re-verified & unchanged: forward-set review_by (updated untouched); --ttl never = durable");
  console.log("  qmemd tags [--project p] [--json]      - tag(count) overview for a project (no model)");
  console.log("  qmemd forget <slug> [<slug>...]");
  console.log("  qmemd reindex                          - rebuild the lex index from the memory dir (no model)");
  console.log("  qmemd doctor [--fix] [--json]          - audit frontmatter integrity; --fix repairs mechanical issues (writes .bak, no model)");
  console.log("  qmemd dedup [--min-dice N] [--project p] [--merge] [--apply <plan.json|->] [--force] [--json] - within-project near-dup report / merge proposal / atomic apply");
  console.log("  qmemd mcp                              - stdio MCP server (default)");
  console.log("  qmemd mcp --http [--port N] [--daemon] - HTTP MCP + REST server (default 8182; --daemon is dev-only)");
  console.log("  qmemd mcp install-service [--port N] [--print] - generate a systemd/launchd service (recommended for a durable daemon)");
  console.log("  qmemd mcp uninstall-service             - remove the generated service files");
  console.log("  qmemd mcp stop                         - stop the HTTP daemon");
  console.log("  qmemd embed [--force] | status | reindex");
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      type: { type: "string" }, tags: { type: "string" }, project: { type: "string" },
      source: { type: "string" }, as: { type: "string" }, replace: { type: "string" },
      pin: { type: "boolean" }, force: { type: "boolean" }, lex: { type: "boolean" },
      session: { type: "boolean" }, limit: { type: "string" }, json: { type: "boolean" },
      full: { type: "boolean" }, skim: { type: "boolean" }, tag: { type: "string" },
      http: { type: "boolean" }, daemon: { type: "boolean" }, port: { type: "string" },
      print: { type: "boolean" }, "min-score": { type: "string" }, fix: { type: "boolean" },
      report: { type: "boolean" },
      merge: { type: "boolean" }, "min-dice": { type: "string" }, apply: { type: "string" },
      platforms: { type: "string" }, "all-platforms": { type: "boolean" }, platform: { type: "string" },
      "cross-project": { type: "boolean" },
      // -h/--help must be a declared option: parseArgs is strict, so an undeclared
      // --help threw ERR_PARSE_ARGS_UNKNOWN_OPTION before dispatch and the top-level
      // catch dumped a raw stack trace (qmemd-3ix). Route it to printUsage, exit 0.
      help: { type: "boolean", short: "h" },
      supersedes: { type: "string" },
      "review-by": { type: "string" }, ttl: { type: "string" },
    },
  });
  const [verb, ...rest] = positionals;
  if (values.help) { printUsage(); return; }
  const root = memoryRoot();

  switch (verb) {
    case "remember": {
      const fact = rest.join(" ").trim();
      if (!fact) { console.error("Usage: qmemd remember <fact> [--type T] [--tags a,b] [--platforms a,b] [--pin] [--as slug] [--replace slug] [--supersedes slug] [--source S] [--force]"); process.exit(1); }
      // --platform / --all-platforms are recall/list flags; remember scopes with --platforms
      // (plural). parseArgs registers all three globally, so without this guard the singular
      // flag is silently swallowed and the fact written cross-platform (qmemd-s5j).
      if (values.platform !== undefined || values["all-platforms"]) {
        console.error("remember scopes with --platforms (plural, comma-separated), e.g. --platforms linux,macos. --platform / --all-platforms are recall/list flags.");
        process.exit(1);
      }
      const type = requireValidType(values.type); // reject before opening the store (qmemd-jzz)
      const store = await openMemoryStore();
      try {
        const res = await remember(store, root, {
          fact, type,
          // Present-empty → [] (CLEAR on --replace), absent → undefined (inherit) — the same
          // mapping parsePlatformsCsv gives --platforms, matching the MCP/HTTP tags:[] surface;
          // a truthiness check left the CLI with no way to clear tags (qmemd-s0r).
          tags: values.tags !== undefined ? String(values.tags).split(",").map(s => s.trim()).filter(Boolean) : undefined,
          // Pass undefined (not false) when --pin is absent so a --replace inherits the
          // existing fact's pin instead of silently unpinning it (qmemd-q65). parseArgs
          // yields true when present, undefined when absent — never false.
          pinned: values.pin, project: values.project, source: values.source,
          as: values.as, replace: values.replace, force: !!values.force,
          platforms: parsePlatformsCsv(values.platforms),
          supersedes: values.supersedes,
          // Staleness schedule (9su): engine validates both and rejects the combination;
          // --review-by "" clears on --replace (the tags/platforms present-empty pattern).
          reviewBy: values["review-by"], ttl: values.ttl,
        });
        if (!res.wrote) {
          // A `conflict` is a likely contradiction/update (same topic, a changed value) to
          // resolve, not a settled near-duplicate (qmemd-5td).
          if (res.disposition === "conflict") console.log(`${y}Possible contradiction/update vs '${res.duplicateOf}'.${r} Review: --replace ${res.duplicateOf} to update it, --supersedes ${res.duplicateOf} to retire it under this new fact, --force to keep both (records conflicts_with), or reword to write a distinct fact.`);
          else console.log(`${y}Near-duplicate of '${res.duplicateOf}'.${r} Use --replace ${res.duplicateOf} to update, or --force to add anyway.`);
          // qmemd-vkn: on a conflict, show both facts' type-derived authority + the colliding
          // fact's raw source/date so the operator can judge which wins (never auto-resolved).
          if (res.authorityComparison) {
            const c = res.authorityComparison;
            const lean = c.verdict === "existing-higher"
              ? "existing is MORE authoritative — don't overwrite without cause"
              : c.verdict === "incoming-higher"
                ? "yours is more authoritative"
                : "equal authority — use recency/context to decide";
            console.log(`  ${y}Authority:${r} yours type:${c.incoming.type} (tier ${c.incoming.tier}) vs existing '${res.duplicateOf}' type:${c.existing.type} (tier ${c.existing.tier}, created ${c.existing.created}) — ${lean}`);
            if (c.existing.source) console.log(`    existing source: ${c.existing.source}`);
            if (c.incoming.source) console.log(`    your source: ${c.incoming.source}`);
          }
        }
        else {
          console.log(`${g}✓${r} remembered '${res.slug}' (${res.type}) → ${res.path}`);
          if (res.supersededSlug) console.log(`  superseded '${res.supersededSlug}' — hidden from recall (still on disk + git)`);
          if (res.conflictsWith) console.log(`  ${y}conflicts_with '${res.conflictsWith}'${r} recorded — two contradictory facts now coexist; review them`);
          if (res.supersedeWarning) console.error(`${y}warning:${r} ${res.supersedeWarning}`);
          if (!res.indexed) console.error(`${y}warning:${r} fact saved but not yet indexed (recall may lag until next reindex)`);
          if (res.syncWarning) console.error(`${y}warning:${r} ${res.syncWarning}`);
          if (res.dedupSkipped > 0) console.error(`${y}warning:${r} ${res.dedupSkipped} candidate fact(s) unreadable during the near-dup scan — a duplicate may have been missed; run: qmemd doctor`);
          if (res.reportWarning) console.error(`${y}warning:${r} ${res.reportWarning}`);
        }
      } finally { await store.close(); }
      break;
    }
    case "recall": {
      if (values.session) {
        const pull = gitPullFfOnly(root); // session-start sync; best-effort, writes nothing to stdout
        // git unavailable (binary missing / crashed / timed out) ⇒ sync is silently off; say so
        // once on stderr so stdout stays the clean snapshot (qmemd-bwr).
        const w = sessionSyncWarning(pull);
        if (w) console.error(`${y}warning:${r} ${w}`);
        const out = await recallSession(root, { project: basename(process.cwd()) });
        // `recall --session` is the SessionStart hook snapshot. Ride the JSON envelope
        // with suppressOutput so it is injected as additionalContext silently — raw stdout
        // surfaces a visible "hook success:" banner that crowds the user's first prompt
        // (qp-sessionstart-envelope-b6j). recallSession()'s string contract is unchanged.
        if (out) console.log(JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out },
        }));
        break;
      }
      const query = rest.join(" ").trim();
      if (!query) { console.error(`Usage: qmemd recall <query> [--lex] [--type T] [--platform P|--all-platforms] [--limit N] [--min-score N] [--full] [--skim] [--json]\n       qmemd recall --session`); process.exit(1); }
      const type = requireValidType(values.type); // reject before opening the store (qmemd-jzz)
      // No `|| default` on numeric input: it silently swallowed --limit 0 and
      // --limit abc as 10 (qmemd-1jt). Missing → default; given → must be an int >= 1.
      const limit = values.limit === undefined ? 10 : parseInt(String(values.limit), 10);
      if (!Number.isInteger(limit) || limit < 1) {
        console.error(`invalid --limit '${values.limit}'. Use an integer >= 1 (default 10).`);
        process.exit(1);
      }
      // --min-score: hybrid confidence floor (default DEFAULT_MIN_SCORE). Pass through
      // only when given; the engine applies the default. Reject non-numeric/negative.
      let minScore: number | undefined;
      if (values["min-score"] !== undefined) {
        minScore = parseFloat(String(values["min-score"]));
        if (!Number.isFinite(minScore) || minScore < 0) {
          console.error(`invalid --min-score '${values["min-score"]}'. Use a number >= 0 (default ${DEFAULT_MIN_SCORE}; 0 disables).`);
          process.exit(1);
        }
        // The floor applies to hybrid recall only — BM25 lex scores are corpus-collapsed
        // and not on a comparable 0–1 scale, so --lex ignores it (rde).
        if (values.lex) console.error(`${y}note:${r} --min-score is ignored with --lex (the floor applies to hybrid recall only).`);
      }
      const allPlatforms = !!values["all-platforms"];
      // --all-platforms (disable the host gate) and --platform P (scope to one OS) are
      // mutually exclusive — the help advertises them as `--platform P|--all-platforms`.
      // Reject the combo: otherwise --all-platforms short-circuits requireValidPlatform and
      // an invalid (or merely contradictory) --platform is silently swallowed (qmemd-dbr).
      if (allPlatforms && values.platform !== undefined) {
        console.error(`--all-platforms and --platform are mutually exclusive — pass only one. --all-platforms shows every platform; --platform P scopes to one OS.`);
        process.exit(1);
      }
      const platform = allPlatforms ? "all" : requireValidPlatform(values.platform);
      // Project scope (qmemd-due): default recall is gated to this repo (cwd basename) + global;
      // --cross-project widens to every project. basename(cwd) mirrors `recall --session` (line 287).
      const project = basename(process.cwd());
      const crossProject = !!values["cross-project"];
      // Warm-daemon delegation (qmemd-vuk), hybrid only: a cold hybrid recall pays the
      // embedding-model load (~1.6s measured) that the HTTP daemon already amortizes.
      // --lex is model-free and as fast locally, so it never probes. Best-effort: null
      // (daemon down / different root / older daemon / bad response) → the local path
      // below runs exactly as before.
      if (!values.lex) {
        const delegated = await tryDaemonRecall(root, {
          query, type, limit, minScore, fullBody: !!values.full, skim: !!values.skim, platform, project, crossProject,
        });
        if (delegated) { printRecallResult(delegated, !!values.json, minScore, { project, crossProject }); break; }
      }
      const store = await openMemoryStore();
      try {
        const result = await recallQueryWithStatus(store, root, query, {
          type, limit, lexOnly: !!values.lex, fullBody: !!values.full, skim: !!values.skim, minScore, platform, project, crossProject,
        });
        printRecallResult(result, !!values.json, minScore, { project, crossProject });
      } finally { await store.close(); }
      break;
    }
    case "forget": {
      // Variadic: a merge fold (dedup --merge, qmemd-a6e) retires every non-keeper slug in one
      // `qmemd forget <s1> <s2> ...` call. Each slug is an independent delete+reindex; a missing
      // one is reported and flips the exit code but does not stop the rest from being removed.
      const slugs = rest;
      if (slugs.length === 0) { console.error("Usage: qmemd forget <slug> [<slug>...]"); process.exit(1); }
      const store = await openMemoryStore();
      let allRemoved = true;
      try {
        for (const slug of slugs) {
          const res = await forget(store, root, slug);
          if (res.removed) console.log(`${g}✓${r} forgot '${slug}'`);
          else { console.log(`${y}No memory named '${slug}'.${r}`); allRemoved = false; }
          if (res.syncWarning) console.error(`${y}warning:${r} ${res.syncWarning}`);
        }
      } finally { await store.close(); }
      if (!allRemoved) process.exit(1);
      break;
    }
    case "reviewed": {
      // s4w: content-free staleness reset — forward-set review_by, leave updated honest.
      const slug = rest[0];
      if (!slug) { console.error("Usage: qmemd reviewed <slug> [--ttl <N>d|w|m|y|never] [--review-by <date>]"); process.exit(1); }
      const store = await openMemoryStore();
      try {
        const res = await markReviewed(store, root, slug, { ttl: values.ttl, reviewBy: values["review-by"] });
        console.log(res.reviewBy === "never"
          ? `${g}✓${r} ${slug} marked durable ${d}(review_by: never — will not surface)${r}`
          : `${g}✓${r} ${slug} reviewed ${d}(next review ${res.reviewBy})${r}`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      } finally { await store.close(); }
      break;
    }
    case "get": // hidden alias — agents pattern-match the MCP `get` tool (mcp__qmemd__get / mcp__qmd__get) onto the CLI; canonical verb stays `show` (qmemd-gs8)
    case "show": {
      const slug = rest[0];
      if (!slug) { console.error("Usage: qmemd show <slug>"); process.exit(1); }
      // Filesystem-only — no store. An unsafe slug throws via assertSafeSlug → main().catch → exit 1.
      const fact = getFact(root, slug);
      if (!fact) { console.log(`${y}No memory named '${slug}'.${r}`); process.exit(1); }
      const fm = fact.frontmatter;
      console.log(`${cy}[${fact.type}]${r} ${fm.description}`);
      console.log(`${d}tags:${r} ${fm.tags.join(", ") || "—"}  ${d}platforms:${r} ${(fm.platforms ?? []).join(", ") || "—"}  ${d}pinned:${r} ${fm.pinned}  ${d}created:${r} ${fm.created}${fm.updated ? `  ${d}updated:${r} ${fm.updated}` : ""}${fm.reviewBy ? `  ${d}review_by:${r} ${fm.reviewBy}` : ""}`);
      if (fm.supersedes) console.log(`${d}supersedes:${r} ${fm.supersedes}`);
      if (fm.supersededBy) console.log(`${y}superseded by '${fm.supersededBy}' — hidden from recall${r}`);
      if (fm.conflictsWith) console.log(`${y}conflicts with '${fm.conflictsWith}' (unresolved)${r}`);
      console.log("");
      console.log(fact.body.trim());
      break;
    }
    case "list": {
      const type = requireValidType(values.type); // reject an invalid --type (qmemd-jzz)
      const platform = requireValidPlatform(values.platform); // reject an invalid --platform (qmemd-jzz sibling)
      const entries = listFacts(root, { type, tag: values.tag, project: values.project, platform });
      // Surface unreadable/corrupt files on stderr (stdout stays the clean list / JSON) so a
      // silent skip in listFacts doesn't hide them — corpus-wide, since a broken file is
      // broken regardless of the active filter (qmemd-e5h).
      const unreadable = countUnreadableFacts(root);
      if (unreadable > 0) console.error(`${y}warning:${r} ${unreadable} fact(s) unreadable — run: qmemd doctor`);
      if (values.json) { console.log(JSON.stringify(entries, null, 2)); break; }
      if (entries.length === 0) { console.log(`${d}No memories.${r}`); break; }
      for (const t of MEMORY_TYPES) {
        const group = entries.filter(e => e.type === t);
        if (group.length === 0) continue;
        console.log(`${cy}[${t}]${r}`);
        for (const e of group) {
          const plat = e.platforms.length ? ` ${d}{${e.platforms.join(",")}}${r}` : "";
          const sup = e.supersededBy ? ` ${y}[superseded by ${e.supersededBy}]${r}` : "";
          console.log(`  ${e.slug} ${d}—${r} ${e.description}${plat}${sup}`);
        }
      }
      break;
    }
    case "tags": {
      // Model-free tag(count) overview for a project (defaults to cwd basename).
      const project = values.project ?? basename(process.cwd());
      const ov = projectOverview(root, project);
      if (values.json) { console.log(JSON.stringify(ov)); break; }
      if (ov.total === 0) { console.log(`${d}No memories for ${project}.${r}`); break; }
      const shape = formatTagHistogram(ov.tags) || "(untagged)";
      console.log(`${cy}${project}${r} — ${ov.total} memories ${d}(project ${ov.byType.project}, reference ${ov.byType.reference}, user ${ov.byType.user}, feedback ${ov.byType.feedback})${r}`);
      console.log(`  ${shape}`);
      break;
    }
    case "stale": {
      // Offline staleness pass (9su/s4w): list facts due for review + the never-reviewed
      // backlog. Filesystem-only, no model, strictly read-only — SURFACE for review, never
      // auto-delete. Exit 0 always: a review queue, not an integrity failure (doctor gates).
      const limit = values.limit === undefined ? 10 : parseInt(String(values.limit), 10);
      if (!Number.isInteger(limit) || limit < 1) {
        console.error(`invalid --limit '${values.limit}'. Use an integer >= 1 (default 10).`);
        process.exit(1);
      }
      const report = staleFacts(root, { limit });
      if (values.json) { console.log(JSON.stringify(report, null, 2)); break; }
      if (report.due.length === 0 && report.unreviewedTotal === 0) {
        console.log(`${g}✓${r} nothing due — every decay-prone fact is scheduled or recently reviewed.`);
        break;
      }
      printStale(report);
      console.log(`${d}Resolve: qmemd show <slug> → re-verify, then 'reviewed <slug>' to reset the clock, 'remember --replace <slug> <fact>' if it changed, '--supersedes <slug>' to retire, or 'forget <slug>'.${r}`);
      break;
    }
    case "hook": {
      // qmemd hook <beacon|write-beacon>. Both read a hook event on stdin and emit a
      // non-blocking additionalContext nudge. MUST fail open — never exit non-zero in a
      // way that blocks the command/turn, never load the embedding model.
      const sub = rest[0];
      if (sub === "beacon") {
        try {
          const stdinText = await readStdin();
          // 0 = fire on every call (clamped to 1); non-numeric/negative → 20 silently (qmemd-1jt).
          const rawEvery = parseInt(process.env.QMEMD_BEACON_EVERY ?? "20", 10);
          const everyN = Number.isInteger(rawEvery) && rawEvery >= 0 ? Math.max(1, rawEvery) : 20;
          const ctx = runBeacon(stdinText, { memoryRoot: root, cacheDir: cacheDir(), everyN });
          if (ctx) {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx },
            }) + "\n");
          }
        } catch { /* fail-open: swallow everything, exit 0 — must never block Bash */ }
      } else if (sub === "write-beacon") {
        // Write-side capture beacon (qmemd-yl3), Stop hook. OFF unless QMEMD_WRITE_BEACON is
        // truthy — when unset this is a silent no-op even if the hook is wired.
        try {
          if (/^(1|true)$/i.test(process.env.QMEMD_WRITE_BEACON ?? "")) {
            const stdinText = await readStdin();
            const rawMin = parseInt(process.env.QMEMD_WRITE_BEACON_MIN ?? "20", 10);
            const threshold = Number.isInteger(rawMin) && rawMin >= 0 ? Math.max(1, rawMin) : 20;
            const ctx = runWriteBeacon(stdinText, { cacheDir: cacheDir(), threshold });
            if (ctx) {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: "Stop", additionalContext: ctx },
              }) + "\n");
            }
          }
        } catch { /* fail-open: swallow everything, exit 0 — must never block the turn */ }
      } else {
        console.error("Usage: qmemd hook <beacon|write-beacon>   (reads a hook event JSON on stdin)");
      }
      break;
    }
    case "status": {
      const store = await openMemoryStore();
      try { console.log(JSON.stringify(await store.getStatus(), null, 2)); } finally { await store.close(); }
      break;
    }
    case "embed": {
      const store = await openMemoryStore();
      try {
        const res = await store.embed({ collection: "memory", force: !!values.force });
        console.log(`${g}✓${r} embedded`, JSON.stringify(res));
      } finally { await store.close(); }
      break;
    }
    case "reindex": {
      // Rebuild the FTS (lex) index by scanning the memory dir — no model load.
      // The store only auto-indexes on remember/forget, so this adopts/refreshes a
      // dir written out-of-band (e.g. a qmd cutover, or the parity gate) (qmemd-bu9).
      // Vectors are separate: run `qmemd embed` afterwards if hybrid recall is needed.
      const store = await openMemoryStore();
      try {
        const res = await store.update({ collections: [MEMORY_COLLECTION] });
        console.log(`${g}✓${r} reindexed`, JSON.stringify(res));
      } finally { await store.close(); }
      break;
    }
    case "mcp": {
      const sub = rest[0]; // "stop" | undefined
      const { pidPath, logPath } = daemonPaths();

      if (sub === "stop") {
        if (!existsSync(pidPath)) { console.log("Not running (no PID file)."); break; }
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        if (Number.isNaN(pid)) {
          unlinkSync(pidPath);
          console.log("Cleaned up stale PID file (corrupt PID).");
          break;
        }
        try {
          process.kill(pid, 0);             // alive?
          process.kill(pid, "SIGTERM");
          unlinkSync(pidPath);
          console.log(`Stopped qmemd MCP server (PID ${pid}).`);
        } catch {
          unlinkSync(pidPath);
          console.log("Cleaned up stale PID file (server was not running).");
        }
        break;
      }
      if (sub === "install-service" || sub === "uninstall-service") {
        const port = Number(values.port) || Number(process.env.QMEMD_HTTP_PORT) || 8182;
        const platform = process.platform;
        if (platform !== "linux" && platform !== "darwin") {
          console.error(`install-service supports linux and darwin only (got '${platform}').`);
          process.exit(1);
        }
        const exec = { bin: process.execPath, entry: fileURLToPath(import.meta.url) };
        const dirs = {
          systemdUser: systemdUserDir(),
          qmemdConfig: qmemdConfigDir(),
          launchAgents: launchAgentsDir(),
          macLogs: macLogsDir(),
        };
        const artifacts = serviceArtifacts(platform, { port, exec, env: captureDaemonEnv(platform), dirs });

        if (sub === "install-service") {
          if (values.print) {
            for (const f of artifacts.files) console.log(`# ${f.path}\n${f.content}`);
            console.log("# Activate by running:");
            for (const c of artifacts.activation) console.log(c);
            break;
          }
          writeArtifacts(artifacts);
          for (const f of artifacts.files) console.log(`${g}✓${r} wrote ${f.path}`);
          console.log("\nActivate by running:");
          for (const c of artifacts.activation) console.log(`  ${c}`);
          break;
        }

        // uninstall-service — print the stop/disable commands first, then remove our files.
        console.log("Stop & disable the service (run these):");
        for (const c of artifacts.deactivation) console.log(`  ${c}`);
        console.log("");
        const removed = removeArtifacts(artifacts);
        if (removed.length === 0) console.log("No qmemd service files found.");
        else for (const p of removed) console.log(`${g}✓${r} removed ${p}`);
        break;
      }
      if (sub !== undefined) {
        console.error(`Unknown subcommand: ${sub}`);
        console.error("Usage: qmemd mcp [--http] [--port N] [--daemon]\n       qmemd mcp install-service [--port N] [--print]\n       qmemd mcp uninstall-service\n       qmemd mcp stop");
        process.exit(1);
      }

      if (values.http) {
        const port = Number(values.port) || Number(process.env.QMEMD_HTTP_PORT) || 8182;

        if (values.daemon) {
          if (existsSync(pidPath)) {
            const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
            try {
              process.kill(existingPid, 0); // alive?
              console.error(`Already running (PID ${existingPid}). Run 'qmemd mcp stop' first.`);
              process.exit(1);
            } catch { /* stale pidfile — continue */ }
          }
          mkdirSync(cacheDir(), { recursive: true });
          const logFd = openSync(logPath, "w"); // truncate — fresh log per daemon run
          const selfPath = fileURLToPath(import.meta.url);
          const tsxPath = pathJoin(dirname(selfPath), "..", "..", "node_modules", "tsx", "dist", "esm", "index.mjs");
          const spawnArgs = selfPath.endsWith(".ts")
            ? ["--import", tsxPath, selfPath, "mcp", "--http", "--port", String(port)]
            : [selfPath, "mcp", "--http", "--port", String(port)];
          const child = spawn(process.execPath, spawnArgs, { stdio: ["ignore", logFd, logFd], detached: true });
          child.unref();
          closeSync(logFd); // parent's copy; the child inherited the fd
          if (child.pid === undefined) {
            console.error(`Failed to start daemon (no PID from spawn). See ${logPath}`);
            process.exit(1);
          }
          writeFileSync(pidPath, String(child.pid));
          console.log(`Started on http://localhost:${port}/mcp (PID ${child.pid})`);
          console.log(`Logs: ${logPath}`);
          console.error(`${y}note:${r} --daemon is unsupervised (dev-only). For a durable, reboot-surviving service run 'qmemd mcp install-service'.`);
          break;
        }

        // Foreground HTTP — drop the top-level catch's process so the server's own
        // SIGTERM/SIGINT graceful-shutdown handlers run.
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        const { startMcpHttpServer } = await import("../mcp/server.js");
        try {
          await startMcpHttpServer(port);
        } catch (e: unknown) {
          if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "EADDRINUSE") {
            console.error(`Port ${port} already in use. Try a different port with --port.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        const { startMcpServer } = await import("../mcp/server.js");
        await startMcpServer();
      }
      break;
    }
    case "doctor": {
      // Frontmatter integrity audit (qmemd-61h). Filesystem-only — NEVER opens the
      // store or loads the embedding model (mirrors recallSession/listFacts). Exits
      // non-zero when issues remain so it can gate a preflight / pre-commit hook.
      const staleLimit = values.limit === undefined ? 10 : Math.max(1, parseInt(String(values.limit), 10) || 10);
      if (values.fix) {
        const fixes = fixMemory(root);             // surgical mechanical repairs, each leaves a .bak
        const remaining = auditMemory(root);       // re-audit: what's left needs manual review
        const fixStale = staleFacts(root, { limit: staleLimit });
        if (values.json) {
          console.log(JSON.stringify({ fixed: fixes, remaining, stale: fixStale }, null, 2));
        } else {
          if (fixes.length === 0) console.log(`${d}No mechanical fixes to apply.${r}`);
          for (const fx of fixes) console.log(`${g}✓${r} fixed ${fx.relpath} ${d}(${fx.fixed.join(", ")}) → backup ${fx.backupRelpath}${r}`);
          if (remaining.length > 0) {
            console.log(`\n${y}Remaining (needs manual review):${r}`);
            printDoctorReports(remaining);
          } else if (fixes.length > 0) {
            console.log(`${g}✓${r} all integrity issues resolved.`);
          }
          printStale(fixStale);
        }
        if (remaining.length > 0) process.exitCode = 1;
        break;
      }
      const reports = auditMemory(root);
      const stale = staleFacts(root, { limit: staleLimit });
      if (values.json) {
        console.log(JSON.stringify({ integrity: reports, stale }, null, 2));
        if (reports.length > 0) process.exitCode = 1; // integrity-only gate (stale never gates)
        break;
      }
      if (reports.length === 0) {
        console.log(`${g}✓${r} no integrity issues found.`);
      } else {
        printDoctorReports(reports);
        const fixable = reports.reduce((n, rp) => n + rp.issues.filter(i => i.fixable).length, 0);
        console.log(`\n${y}${reports.length} fact(s) with issues${r}${fixable > 0 ? ` ${d}(${fixable} fixable — run: qmemd doctor --fix)${r}` : ""}`);
        process.exitCode = 1;
      }
      if (stale.due.length > 0 || stale.unreviewedTotal > 0) {
        console.log(`\n${d}Review queue (advisory — not an integrity failure):${r}`);
        printStale(stale);
      }
      break;
    }
    case "dedup": {
      // Offline within-project loose near-dup report (qmemd-dao). Filesystem-only — NEVER
      // opens the store or loads the model (mirrors doctor/stale). A REVIEW SURFACE, not a
      // gate: scopes candidates by project (gbrain's entity-prefilter), surfaces clusters of
      // loose paraphrases the write-path Dice floor (0.82) provably cannot catch, and exits 0
      // always (`stale` precedent) — it never mutates or merges. `--report` is accepted but
      // implicit (the only mode; merge UX is a follow-up).
      let threshold: number | undefined;
      if (values["min-dice"] !== undefined) {
        threshold = parseFloat(String(values["min-dice"]));
        if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
          console.error(`invalid --min-dice '${values["min-dice"]}'. Use a number in (0, 1] (default ${DEDUP_REPORT_DICE}).`);
          process.exit(1);
        }
      }
      // Optional: restrict to one project bucket. Reject an empty/whitespace value (a likely
      // typo) loudly rather than silently surfacing nothing — no fact carries project "".
      const project = values.project;
      if (project !== undefined && project.trim() === "") {
        console.error(`invalid --project '' (empty). Omit --project to scan every bucket, or name a project.`);
        process.exit(1);
      }
      if (values.apply !== undefined) {
        let planText: string;
        try { planText = values.apply === "-" ? readFileSync(0, "utf-8") : readFileSync(values.apply, "utf-8"); }
        catch (e) { console.error(`cannot read plan '${values.apply}': ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
        let plan: MergePlan;
        try { plan = JSON.parse(planText); }
        catch (e) { console.error(`invalid plan JSON: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
        if (!plan || typeof plan !== "object" || typeof (plan as MergePlan).foldedBody !== "string" || !Array.isArray((plan as MergePlan).cluster?.members)) {
          console.error(`invalid plan: expected { cluster, foldedBody, keeper? } (from 'qmemd dedup --merge --json')`); process.exit(1);
        }
        const store = await openMemoryStore();
        try {
          const res = await applyMerge(store, root, plan, { force: !!values.force });
          if (values.json) { console.log(JSON.stringify(res, null, 2)); }
          else {
            console.log(`${g}✓${r} merged → '${res.keeper}'; retired ${res.retired.join(", ") || "(none)"}`);
            if (res.loss.lostProse.length > 0) console.error(`${d}note:${r} ${res.loss.lostProse.length} prose token(s) dropped (rephrasing)`);
            if (res.loss.lostIdentifiers.length > 0) console.error(`${y}warning:${r} --force overrode ${res.loss.lostIdentifiers.length} identifier loss: ${res.loss.lostIdentifiers.map(l => l.token).join(", ")}`);
            if (!res.committed) console.error(`${y}note:${r} no git commit (not a repo or nothing to commit)`);
          }
        } catch (e) {
          console.error(`${y}${e instanceof Error ? e.message : String(e)}${r}`);
          process.exitCode = 1;
        } finally { await store.close(); }
        break;
      }
      if (values.merge) {
        const proposal = mergeProposal(root, { ...(threshold !== undefined ? { threshold } : {}), ...(project !== undefined ? { project } : {}) });
        if (proposal.unreadable > 0) console.error(`${y}warning:${r} ${proposal.unreadable} fact(s) unreadable and skipped — run: qmemd doctor`);
        if (values.json) { console.log(JSON.stringify(proposal, null, 2)); break; }
        printMergeProposal(proposal);
        break;
      }
      const report = dedupReport(root, { ...(threshold !== undefined ? { threshold } : {}), ...(project !== undefined ? { project } : {}) });
      if (report.unreadable > 0) console.error(`${y}warning:${r} ${report.unreadable} fact(s) unreadable and skipped — run: qmemd doctor`);
      if (values.json) { console.log(JSON.stringify(report, null, 2)); break; }
      printDedupReport(report);
      break;
    }
    default:
      printUsage();
      if (verb && verb !== "help") process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
