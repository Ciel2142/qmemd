import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMemoryServer, buildMemoryServerLazy } from "../src/mcp/server.js";
import { type GitRun } from "../src/git.js";
import { currentPlatform, platformVisible } from "../src/engine.js";

describe("MCP server tools (in-process)", () => {
  let root: string;
  let dbDir: string;
  let store: QMDStore;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-"));
    dbDir = await mkdtemp(join(tmpdir(), "qmemd-mcpdb-"));
    store = await openQmd({
      dbPath: join(dbDir, "i.sqlite"),
      config: { collections: { memory: { path: root, pattern: "**/*.md" } } },
    });
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  test("remember writes, then reports a near-duplicate", async () => {
    const first = await client.callTool({ name: "remember", arguments: { fact: "Use Bun not Node", type: "user" } });
    expect((first.structuredContent as { wrote: boolean }).wrote).toBe(true);
    const dup = await client.callTool({ name: "remember", arguments: { fact: "Use Bun not Node", type: "user" } });
    const sc = dup.structuredContent as { wrote: boolean; duplicateOf?: string };
    expect(sc.wrote).toBe(false);
    expect(sc.duplicateOf).toBe("use-bun-not-node");
    expect((dup.content as { text: string }[])[0].text).toContain("near-duplicate");
  });

  test("a report-shaped body writes but surfaces a non-blocking report warning to the model (a3k)", async () => {
    const report = "## What happened\nThe exchange 500'd.\n## Root cause\nDescriptor marshalled before signatures.\n## Fix\nStamp signatures first.";
    const res = await client.callTool({ name: "remember", arguments: { fact: report, type: "project" } });
    const sc = res.structuredContent as { wrote: boolean; reportWarning?: string };
    expect(sc.wrote).toBe(true);                              // non-blocking
    expect(sc.reportWarning).toContain("docs/reports/");      // ...but flagged in the structured result
    expect(JSON.stringify(sc)).not.toContain(root);           // qmemd-81n: no fs path leak
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("docs/reports/");                  // and in the model-facing text
  });

  test("a blocked remember surfaces the colliding fact to the model, no fs path (cs0)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Redpanda broker runs on lab pi\nKafka API on 9092 SASL_SSL", type: "project" } });
    const dup = await client.callTool({ name: "remember", arguments: { fact: "Redpanda broker lab", type: "project" } });
    const sc = dup.structuredContent as { wrote: boolean; duplicateOf?: string; duplicateDescription?: string; duplicateBody?: string };
    expect(sc.wrote).toBe(false);
    // The model can now distinguish a true duplicate from a contradicting/updating fact.
    expect(sc.duplicateDescription).toBe("Redpanda broker runs on lab pi");
    expect(sc.duplicateBody).toContain("Kafka API on 9092 SASL_SSL");
    // qmemd-81n: the absolute fs path must never reach the model.
    expect(JSON.stringify(sc)).not.toContain(root);
    expect(Object.keys(sc)).not.toContain("path");
    // The human-readable text shows the existing fact, not just its slug.
    const text = (dup.content as { text: string }[])[0].text;
    expect(text).toContain("Redpanda broker runs on lab pi");
    expect(text).toContain("Kafka API on 9092 SASL_SSL");
  });

  test("a high-similarity conflict surfaces as a contradiction/update, not a settled dup (5td)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "TLS certificate verification is enabled on the S3 client", type: "project" } });
    const conflict = await client.callTool({ name: "remember", arguments: { fact: "TLS certificate verification is disabled on the S3 client", type: "project" } });
    const sc = conflict.structuredContent as { wrote: boolean; disposition?: string };
    expect(sc.wrote).toBe(false);
    expect(sc.disposition).toBe("conflict");
    // The model is prompted to RESOLVE it (replace/force/reword), not told it's a settled dup.
    // "contradiction" is unique to the conflict message — the dup message ("near-duplicate …
    // to update it") would vacuously satisfy a looser /update/ match, so require the strong word.
    const text = (conflict.content as { text: string }[])[0].text.toLowerCase();
    expect(text).toMatch(/contradiction/);
    expect(JSON.stringify(sc)).not.toContain(root); // 81n: never the fs path
  });

  test("vkn: conflict result surfaces authorityComparison and an authority line, no fs path", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "The cache TTL is 60 seconds", type: "project" } });
    const res = await client.callTool({ name: "remember", arguments: { fact: "The cache TTL is 120 seconds", type: "user" } });
    const sc = res.structuredContent as { wrote: boolean; disposition?: string; authorityComparison?: { verdict: string; incoming: { tier: number }; existing: { tier: number } } };
    expect(sc.wrote).toBe(false);
    expect(sc.disposition).toBe("conflict");
    const cmp = sc.authorityComparison;
    expect(cmp).toBeDefined();
    expect(cmp!.verdict).toBe("incoming-higher");
    expect(cmp!.incoming.tier).toBe(2);
    expect(cmp!.existing.tier).toBe(1);
    // Model-facing text mentions authority; never leaks an absolute path.
    const raw = (res.content as { text: string }[])[0].text;
    expect(raw.toLowerCase()).toContain("authority");
    expect(raw).not.toContain(process.env.HOME ?? "/home/");
  });

  test("recall session returns the snapshot", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Always answer tersely", type: "user", as: "be-terse" } });
    const res = await client.callTool({ name: "recall", arguments: { session: true } });
    expect((res.content as { text: string }[])[0].text).toContain("Always answer tersely");
  });

  // qmemd-os1: the recall tool must DECLARE its output contract so the SDK validates
  // structuredContent (it skips validation entirely when outputSchema is absent) and
  // clients can see the degraded/completeness fields are part of the API.
  test("recall declares an outputSchema covering hits + health + completeness fields (os1)", async () => {
    const { tools } = await client.listTools();
    const recall = tools.find((t) => t.name === "recall");
    expect(recall?.outputSchema).toBeDefined();
    const props = Object.keys((recall!.outputSchema as { properties: Record<string, unknown> }).properties);
    for (const k of ["hits", "degraded", "vectorsPending", "moreMatches", "belowFloor", "saturated", "snapshot"]) {
      expect(props).toContain(k);
    }
  });

  // With an outputSchema declared, every non-error result MUST carry structuredContent
  // (SDK invariant) — so the session path gains { snapshot }, mirroring REST /recall's
  // session response shape.
  test("recall session returns the snapshot in structuredContent too (os1)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Session snapshot structured fact", type: "user", as: "snap-sc" } });
    const res = await client.callTool({ name: "recall", arguments: { session: true } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { snapshot: string }).snapshot).toContain("Session snapshot structured fact");
  });

  test("recall skim:true returns headline hits with no body (r0u)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Skimmable fact about Vault secrets", type: "project", as: "skim-fact" } });
    const res = await client.callTool({ name: "recall", arguments: { query: "Vault", lexOnly: true, skim: true } });
    const hits = (res.structuredContent as { hits: { slug: string; body?: string }[] }).hits;
    const h = hits.find(x => x.slug === "skim-fact");
    expect(h).toBeDefined();
    expect(h!.body).toBeUndefined();
  });

  test("recall session honors an explicit project param, surfacing that project's facts (3nq)", async () => {
    // A project-scoped, non-pinned fact only surfaces when the snapshot is taken
    // for that project. The MCP session previously passed empty opts (project
    // defaulted to "global"), so project facts never appeared (qmemd-3nq).
    await client.callTool({ name: "remember", arguments: { fact: "Alpha scoped deployment note", type: "project", project: "alpha-proj", as: "alpha-note" } });

    // Default snapshot (cwd basename, not "alpha-proj") must NOT include it.
    const def = await client.callTool({ name: "recall", arguments: { session: true } });
    expect((def.content as { text: string }[])[0].text).not.toContain("Alpha scoped deployment note");

    // Snapshot scoped to the fact's project MUST surface it.
    const scoped = await client.callTool({ name: "recall", arguments: { session: true, project: "alpha-proj" } });
    expect((scoped.content as { text: string }[])[0].text).toContain("Alpha scoped deployment note");
  });

  test("recall query (lexOnly) returns hits", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Redpanda runs on the lab pi", type: "project" } });
    const res = await client.callTool({ name: "recall", arguments: { query: "Redpanda", lexOnly: true } });
    const hits = (res.structuredContent as { hits: { slug: string }[] }).hits;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.some(h => h.slug === "redpanda-runs-on-the-lab-pi")).toBe(true);
  });

  test("recall accepts a minScore arg; ignored under lexOnly so the lex hit still returns (rde)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Grafana dashboards on the sandbox cluster", type: "project", as: "grafana-rde" } });
    // minScore is a hybrid-only floor; with lexOnly it must be accepted by the schema
    // yet not filter the lex result (BM25 scores are corpus-collapsed, not comparable).
    const res = await client.callTool({ name: "recall", arguments: { query: "Grafana", lexOnly: true, minScore: 0.99 } });
    expect(res.isError).toBeFalsy();
    const hits = (res.structuredContent as { hits: { slug: string }[] }).hits;
    expect(hits.some(h => h.slug === "grafana-rde")).toBe(true);
  });

  // qmemd-4hh: the MCP recall schema must reject the inputs the CLI already clamps/rejects
  // (limit must be a positive integer; minScore must be >= 0) so all three surfaces enforce
  // one contract. lexOnly keeps these model-free — validation must reject before dispatch.
  test("recall rejects a non-positive or non-integer limit (4hh parity)", async () => {
    // The SDK validates inputSchema and returns isError:true (not a promise rejection) when
    // the zod constraint fails — pre-fix these resolved as a normal success.
    for (const limit of [0, -5, 2.5]) {
      const res = await client.callTool({ name: "recall", arguments: { query: "x", lexOnly: true, limit } });
      expect(res.isError).toBe(true);
    }
  });

  test("recall rejects a negative minScore (4hh parity)", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "x", lexOnly: true, minScore: -1 } });
    expect(res.isError).toBe(true);
  });

  test("structuredContent never leaks the absolute filesystem path to the model (81n)", async () => {
    const w = await client.callTool({ name: "remember", arguments: { fact: "Path leak check", type: "reference", as: "leak-x" } });
    expect((w.structuredContent as Record<string, unknown>).path).toBeUndefined();
    expect(JSON.stringify(w.structuredContent)).not.toContain(root);

    const r = await client.callTool({ name: "recall", arguments: { query: "Path", lexOnly: true } });
    const hits = (r.structuredContent as { hits: Record<string, unknown>[] }).hits;
    expect(hits.every(h => h.path === undefined)).toBe(true);
    expect(hits.every(h => typeof h.body === "string")).toBe(true); // body present + path-free (bgf)
    expect(JSON.stringify(r.structuredContent)).not.toContain(root);

    const f = await client.callTool({ name: "forget", arguments: { slug: "leak-x" } });
    expect((f.structuredContent as Record<string, unknown>).path).toBeUndefined();
    expect(JSON.stringify(f.structuredContent)).not.toContain(root);
  });

  test("recall with neither query nor session is an error", async () => {
    const res = await client.callTool({ name: "recall", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("Provide a query or session");
  });

  test("forget on a missing slug is an error", async () => {
    const res = await client.callTool({ name: "forget", arguments: { slug: "does-not-exist" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("No memory named");
  });

  test("forget on an existing slug succeeds (success branch)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Temporary fact", type: "reference", as: "temp-x" } });
    const res = await client.callTool({ name: "forget", arguments: { slug: "temp-x" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("Forgot");
  });

  // --- reviewed: staleness reset over MCP (qmemd-pjl) ------------------------
  // Write verb mirroring forget: structuredContent is an allowlist (never the absolute
  // fs `path` markReviewed returns, qmemd-81n), and markReviewed's path-free throws
  // (invalid ttl / no fact named / unsafe slug) surface verbatim via sanitizeToolError.
  test("reviewed sets review_by forward and leaks no fs path (pjl)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Widget alpha config", type: "project", as: "widget-alpha" } });
    const res = await client.callTool({ name: "reviewed", arguments: { slug: "widget-alpha" } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.slug).toBe("widget-alpha");
    expect(String(sc.reviewBy)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // a forward review date
    expect(sc.path).toBeUndefined();                            // 81n: no fs path field
    expect(JSON.stringify(sc)).not.toContain(root);             // 81n: no fs path anywhere
    expect((res.content as { text: string }[])[0].text).toContain("widget-alpha");
  });

  test("reviewed ttl:never marks a fact durable (review_by: never)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Durable widget fact", type: "project", as: "durable-widget" } });
    const res = await client.callTool({ name: "reviewed", arguments: { slug: "durable-widget", ttl: "never" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { reviewBy: string }).reviewBy).toBe("never");
  });

  test("reviewed reviewBy sets the exact date", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Dated widget", type: "project", as: "dated-widget" } });
    const res = await client.callTool({ name: "reviewed", arguments: { slug: "dated-widget", reviewBy: "2027-01-01" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { reviewBy: string }).reviewBy).toBe("2027-01-01");
  });

  test("reviewed on a missing slug is an error (no fact named, verbatim)", async () => {
    const res = await client.callTool({ name: "reviewed", arguments: { slug: "no-such-slug" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("no fact named 'no-such-slug'");
  });

  test("reviewed rejects ttl + reviewBy together (invalid ttl, verbatim)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Mutex widget", type: "project", as: "mutex-widget" } });
    const res = await client.callTool({ name: "reviewed", arguments: { slug: "mutex-widget", ttl: "30d", reviewBy: "2027-01-01" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("invalid ttl");
  });

  test("reviewed with a traversal slug is rejected (fd8)", async () => {
    const res = await client.callTool({ name: "reviewed", arguments: { slug: "../../../../etc/qmemd-evil" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("unsafe slug");
  });

  test("recall query with no match returns 'No memories found.'", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "zzznomatchqqq", lexOnly: true } });
    expect((res.content as { text: string }[])[0].text).toBe("No memories found.");
  });

  test("remember pin:true maps to pinned and surfaces in the session snapshot", async () => {
    const w = await client.callTool({ name: "remember", arguments: { fact: "Pinned project fact", type: "project", pin: true, as: "pinned-fact" } });
    expect((w.structuredContent as { wrote: boolean }).wrote).toBe(true);
    const snap = await client.callTool({ name: "recall", arguments: { session: true } });
    expect((snap.content as { text: string }[])[0].text).toMatch(/pinned/i);
  });

  test("remember replace with a traversal slug is rejected, not written (fd8)", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "poison", replace: "../../../../etc/qmemd-evil" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("unsafe slug");
  });

  test("remember replace with a nonexistent slug is rejected, not silently created (acm)", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "Updated body", replace: "no-such-slug-xyz" } });
    expect(res.isError).toBe(true);
    // The path-free client-facing reason is surfaced verbatim (not scrubbed to "internal error").
    expect((res.content as { text: string }[])[0].text).toContain("no fact named 'no-such-slug-xyz'");
  });

  test("forget with a traversal slug is rejected, nothing deleted (fd8)", async () => {
    const res = await client.callTool({ name: "forget", arguments: { slug: "../../../../etc/qmemd-evil" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("unsafe slug");
  });

  test("get returns the full fact, with no fs path leaked (bgf/81n)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Full body fact about Qdrant vector DB", type: "project", as: "qdrant-note" } });
    const res = await client.callTool({ name: "get", arguments: { slug: "qdrant-note" } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.slug).toBe("qdrant-note");
    expect(String(sc.body)).toContain("Full body fact about Qdrant");
    expect(sc.path).toBeUndefined();
    expect(JSON.stringify(sc)).not.toContain(root);
  });

  test("get on a missing slug returns isError (bgf)", async () => {
    const res = await client.callTool({ name: "get", arguments: { slug: "no-such-slug" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("No memory named");
  });

  test("get with a traversal slug returns isError (bgf/fd8)", async () => {
    const res = await client.callTool({ name: "get", arguments: { slug: "../../../../etc/qmemd-evil" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("unsafe slug");
  });

  test("list returns entries with no fs path leaked (bgf/81n)", async () => {
    // Two genuinely distinct facts (no shared content tokens) so the near-dup pre-pass
    // (qmemd-i5y) does not collapse them — this test exercises list + no-path-leak, not dedup.
    await client.callTool({ name: "remember", arguments: { fact: "Bun is the project runtime", type: "user", as: "list-a" } });
    await client.callTool({ name: "remember", arguments: { fact: "Postgres stores the vector index", type: "project", as: "list-b" } });
    const res = await client.callTool({ name: "list", arguments: {} });
    expect(res.isError).toBeFalsy();
    const entries = (res.structuredContent as { entries: Record<string, unknown>[] }).entries;
    expect(entries.map(e => e.slug).sort()).toEqual(["list-a", "list-b"]);
    expect(entries.every(e => e.path === undefined)).toBe(true);
    expect(JSON.stringify(res.structuredContent)).not.toContain(root);
  });

  test("list with a type filter narrows results (bgf)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "User scoped fact", type: "user", as: "u-only" } });
    await client.callTool({ name: "remember", arguments: { fact: "Project scoped fact", type: "project", as: "p-only" } });
    const res = await client.callTool({ name: "list", arguments: { type: "user" } });
    const entries = (res.structuredContent as { entries: { slug: string }[] }).entries;
    expect(entries.map(e => e.slug)).toEqual(["u-only"]);
  });

  test("list over an empty corpus is a successful empty result, not an error (bgf)", async () => {
    const res = await client.callTool({ name: "list", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { entries: unknown[] }).entries).toEqual([]);
  });

  test("remember accepts supersedes and reports it in structuredContent (bri)", async () => {
    // Seed the fact to be superseded.
    const seed = await client.callTool({ name: "remember", arguments: { fact: "Old truth about the deploy pipeline", type: "project", as: "old-truth" } });
    expect((seed.structuredContent as { wrote: boolean }).wrote).toBe(true);

    // Supersede it with a new fact under a different slug.
    const res = await client.callTool({ name: "remember", arguments: { fact: "New truth about the deploy pipeline (revised)", type: "project", as: "new-truth", supersedes: "old-truth" } });
    const sc = res.structuredContent as { wrote: boolean; slug: string; supersededSlug?: string; conflictsWith?: string; supersedeWarning?: string };
    expect(sc.wrote).toBe(true);
    expect(sc.slug).toBe("new-truth");
    expect(sc.supersededSlug).toBe("old-truth");
    expect(sc.conflictsWith).toBeUndefined();
    expect(sc.supersedeWarning).toBeUndefined();

    // The model-facing text must mention the supersession.
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/[Ss]uperseded 'old-truth'/);

    // qmemd-81n: no absolute filesystem path in structuredContent.
    expect(JSON.stringify(sc)).not.toContain(root);
  });

  test("remember supersedes a missing slug returns isError (bri)", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "Replacement fact", type: "project", supersedes: "no-such-slug-bri" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("no fact named 'no-such-slug-bri'");
  });

  test("self-supersession surfaces verbatim through sanitizeToolError (bri)", async () => {
    // Seed the fact that will be used as both `as` and `supersedes`.
    const seed = await client.callTool({ name: "remember", arguments: { fact: "Self-slug original fact", type: "project", as: "self-slug-bri" } });
    expect((seed.structuredContent as { wrote: boolean }).wrote).toBe(true);

    // A fact cannot supersede itself — the engine throws "a fact cannot supersede itself ('<slug>')".
    // sanitizeToolError allowlists that prefix so it surfaces verbatim, not as "internal error".
    const res = await client.callTool({ name: "remember", arguments: { fact: "Self-slug updated fact", type: "project", as: "self-slug-bri", supersedes: "self-slug-bri" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/cannot supersede itself/);
    expect(text).not.toBe("internal error");
  });

  test("list text lane appends [superseded by <slug>] marker for retired facts (bri integration review)", async () => {
    // Seed and supersede: remember writes a new fact and stamps the old one.
    await client.callTool({ name: "remember", arguments: { fact: "Bri list text old truth about deploy", type: "project", as: "bri-list-old" } });
    await client.callTool({ name: "remember", arguments: { fact: "Bri list text new truth about deploy", type: "project", as: "bri-list-new", supersedes: "bri-list-old" } });

    const res = await client.callTool({ name: "list", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0].text;

    // The retired entry must carry the marker in the text lane.
    expect(text).toMatch(/\[superseded by bri-list-new\]/);

    // The active entry must NOT carry any superseded marker.
    const lines = text.split("\n");
    const newLine = lines.find(l => l.includes("bri-list-new"));
    expect(newLine).toBeDefined();
    expect(newLine).not.toMatch(/superseded/);

    // structuredContent must also carry supersededBy on the retired entry.
    const entries = (res.structuredContent as { entries: { slug: string; supersededBy?: string }[] }).entries;
    const oldEntry = entries.find(e => e.slug === "bri-list-old");
    expect(oldEntry).toBeDefined();
    expect(oldEntry!.supersededBy).toBe("bri-list-new");

    // qmemd-81n: no absolute path in structuredContent.
    expect(JSON.stringify(res.structuredContent)).not.toContain(root);
  });

  test("get on a retired fact exposes supersededBy in FactDTO (bri integration review)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Bri get old truth", type: "project", as: "bri-get-old" } });
    await client.callTool({ name: "remember", arguments: { fact: "Bri get new truth", type: "project", as: "bri-get-new", supersedes: "bri-get-old" } });

    const res = await client.callTool({ name: "get", arguments: { slug: "bri-get-old" } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { slug: string; supersededBy?: string; updated?: string; supersedes?: string; conflictsWith?: string };
    expect(sc.slug).toBe("bri-get-old");
    expect(sc.supersededBy).toBe("bri-get-new");
    // qmemd-81n: no absolute path in structuredContent.
    expect(JSON.stringify(sc)).not.toContain(root);
  });

  test("get on a superseding fact exposes supersedes + updated in FactDTO (bri integration review)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Bri get superseder old fact", type: "project", as: "bri-super-old" } });
    await client.callTool({ name: "remember", arguments: { fact: "Bri get superseder new fact", type: "project", as: "bri-super-new", supersedes: "bri-super-old" } });

    const res = await client.callTool({ name: "get", arguments: { slug: "bri-super-new" } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { slug: string; supersedes?: string; updated?: string; supersededBy?: string };
    expect(sc.slug).toBe("bri-super-new");
    expect(sc.supersedes).toBe("bri-super-old");
    // updated is an ISO instant set by remember() on write.
    expect(typeof sc.updated).toBe("string");
    expect(sc.supersededBy).toBeUndefined();
    expect(JSON.stringify(sc)).not.toContain(root);
  });

  test("get on a clean fact has no supersession fields in FactDTO (bri integration review)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "Bri get clean fact no supersession", type: "project", as: "bri-clean" } });
    const res = await client.callTool({ name: "get", arguments: { slug: "bri-clean" } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.supersededBy).toBeUndefined();
    expect(sc.supersedes).toBeUndefined();
    expect(sc.conflictsWith).toBeUndefined();
  });

  test("recall query scopes to the given project + global, hiding foreign (qmemd-due)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "alpha widgetport 7777 note", type: "project", project: "alpha", as: "alpha-due" } });
    await client.callTool({ name: "remember", arguments: { fact: "beta widgetport 7777 note", type: "project", project: "beta", as: "beta-due" } });
    const res = await client.callTool({ name: "recall", arguments: { query: "widgetport 7777", lexOnly: true, project: "alpha" } });
    const sc = res.structuredContent as { hits: { slug: string; project?: string }[]; crossProjectHidden: number };
    expect(sc.hits.some(h => h.slug === "alpha-due")).toBe(true);
    expect(sc.hits.some(h => h.slug === "beta-due")).toBe(false);
    expect(sc.crossProjectHidden).toBe(1);
    expect(sc.hits.find(h => h.slug === "alpha-due")!.project).toBe("alpha");
  });

  test("recall cross_project:true widens, labels provenance, and tags foreign hits in text (qmemd-due)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "alpha widgetport 7777 note", type: "project", project: "alpha", as: "alpha-due2" } });
    await client.callTool({ name: "remember", arguments: { fact: "beta widgetport 7777 note", type: "project", project: "beta", as: "beta-due2" } });
    const res = await client.callTool({ name: "recall", arguments: { query: "widgetport 7777", lexOnly: true, project: "alpha", cross_project: true } });
    const sc = res.structuredContent as { hits: { slug: string; project?: string }[]; crossProjectHidden: number };
    expect(sc.hits.find(h => h.slug === "beta-due2")!.project).toBe("beta");
    expect(sc.crossProjectHidden).toBe(0);
    expect((res.content as { text: string }[])[0].text).toMatch(/⊥ beta/);
  });

  test("recall outputSchema declares crossProjectHidden (qmemd-due)", async () => {
    const tools = (await client.listTools()).tools;
    const recall = tools.find((t) => t.name === "recall");
    const props = Object.keys((recall!.outputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toContain("crossProjectHidden");
  });
});

describe("MCP remember indexed warning (fake store) (32x)", () => {
  // Inject a store whose reindex (update) always throws so the fact lands on disk
  // but the post-write reindex fails — the remember tool must surface a soft
  // "not yet indexed" warning while still reporting wrote:true (qmemd-32x).
  let root: string;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-32x-"));
    const store = {
      async searchLex() { return []; },
      async update() { throw new Error("SQLITE_BUSY"); },
    } as unknown as QMDStore;
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  test("remember tool warns when a saved fact is not indexed (32x)", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "Unindexed MCP fact", type: "project" } });
    const sc = res.structuredContent as { wrote: boolean; indexed: boolean };
    expect(sc.wrote).toBe(true);
    expect(sc.indexed).toBe(false);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("Remembered");
    expect(text).toContain("not yet indexed");
  });
});

describe("MCP tool handlers sanitize downstream errors — no fs/db path leak (3lt)", () => {
  // Inject a store whose search throws an error whose message embeds an absolute path,
  // as a real SQLite SQLITE_CANTOPEN / fs EACCES would. With no per-handler guard the
  // SDK surfaces a thrown error's message verbatim as isError text (the same path the
  // unsafe-slug tests rely on) — leaking the QMEMD_DB / memory-root layout to the model.
  let root: string;
  let client: Client;
  const leaky = (r: string) => new Error(`SQLITE_CANTOPEN: unable to open database file ${r}/index.sqlite`);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-3lt-"));
    const store = {
      async searchLex() { throw leaky(root); },
      async search() { throw leaky(root); },
      async getStatus() { return { needsEmbedding: 0 }; },
      async update() { /* no-op */ },
      async embed() { return {}; },
    } as unknown as QMDStore;
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  test("remember: a thrown SQLite error is sanitized, never surfaced verbatim", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "trigger the leaky searchLex", type: "project" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).not.toContain(root);                 // no absolute path
    expect(text).not.toContain("SQLITE_CANTOPEN");     // no raw error class
    expect(text.toLowerCase()).toContain("internal error");
  });

  test("recall: a thrown SQLite error is sanitized, never surfaced verbatim", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "anything" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).not.toContain(root);
    expect(text.toLowerCase()).toContain("internal error");
  });

  test("an unsafe-slug message is still surfaced — it is path-free and client-facing (fd8)", async () => {
    // The guard must sanitize fs/db errors WITHOUT swallowing assertSafeSlug's intentional signal.
    const res = await client.callTool({ name: "get", arguments: { slug: "../../../../etc/qmemd-evil" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("unsafe slug");
  });
});

describe("daemon (HTTP) session snapshot scope + sync (wdf)", () => {
  // The HTTP daemon's cwd is HOME (systemd WorkingDirectory=%h), so basename(cwd) is the
  // username, not a project — scoping the snapshot to a non-existent project under-returns.
  // A daemon-built server must default the session project to 'global', and pull before the
  // snapshot (mirroring the CLI). The stdio server keeps basename(cwd) (qmemd-3nq).
  let root: string;
  let client: Client;
  const fakeStore = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  async function connect(server: ReturnType<typeof buildMemoryServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  }

  test("a daemon-built server defaults the session project to 'global', NOT cwd basename", async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-wdf-"));
    const cwdProj = basename(process.cwd());
    // A non-pinned project fact scoped to the cwd basename: surfaces under the stdio default
    // (basename cwd) but must NOT under the daemon default ('global').
    await connect(buildMemoryServer(fakeStore, root, { sessionDefaultProject: "global" }));
    await client.callTool({ name: "remember", arguments: { fact: "Daemon scope cwd-only fact", type: "project", project: cwdProj, as: "cwd-scoped" } });

    const def = await client.callTool({ name: "recall", arguments: { session: true } });
    expect((def.content as { text: string }[])[0].text).not.toContain("Daemon scope cwd-only fact");

    const scoped = await client.callTool({ name: "recall", arguments: { session: true, project: cwdProj } });
    expect((scoped.content as { text: string }[])[0].text).toContain("Daemon scope cwd-only fact");
  });

  test("the daemon session branch runs git pull --ff-only before the snapshot", async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-wdf-git-"));
    await mkdir(join(root, ".git"), { recursive: true }); // make isRepo() true
    const calls: string[][] = [];
    const run: GitRun = (args) => { calls.push(args); return 0; }; // upstream present (rev-parse → 0)
    await connect(buildMemoryServer(fakeStore, root, { sessionDefaultProject: "global", gitDeps: { run } }));

    await client.callTool({ name: "recall", arguments: { session: true } });
    expect(calls).toContainEqual(["pull", "--ff-only"]);
  });
});

describe("MCP remember surfaces dedupSkipped on a corrupt corpus (e5h)", () => {
  // An unreadable candidate (a *.md directory → EISDIR) makes the near-dup scan skip it: the
  // remember tool must report that gap so the agent knows a duplicate may have been missed.
  let root: string;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-e5h-"));
    await mkdir(join(root, "project", "corrupt.md"), { recursive: true });
    const store = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  test("remember reports dedupSkipped and warns in the text when a candidate is unreadable", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "A distinct fact about Vault secret leasing", type: "project" } });
    const sc = res.structuredContent as { wrote: boolean; dedupSkipped: number };
    expect(sc.wrote).toBe(true);
    expect(sc.dedupSkipped).toBe(1);
    const text = (res.content as { text: string }[])[0].text.toLowerCase();
    expect(text).toContain("unreadable");
    expect(JSON.stringify(sc)).not.toContain(root); // 81n: count carries no fs path
  });
});

describe("MCP recall surfaces the embed-degraded signal (9t1)", () => {
  // Inject a store whose embed throws (the real Mac metal load failure) while vectors are
  // pending: the hybrid recall silently degrades toward lexical. The tool must report
  // degraded/vectorsPending so the agent doesn't mistake a half-skipped result for a
  // confident no-relevant-facts answer.
  let root: string;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-9t1-"));
    const store = {
      async getStatus() { return { totalDocuments: 1, needsEmbedding: 4, hasVectorIndex: true, collections: [] }; },
      async embed() { throw new Error("model unavailable"); },
      async search() { return [{ file: "qmd://memory/project/foo.md", title: "Foo fact", score: 0.9 }]; },
      async searchLex() { return [{ filepath: "qmd://memory/project/foo.md", title: "Foo fact", score: 0.5 }]; },
    } as unknown as QMDStore;
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  test("a degraded hybrid recall reports degraded:true + vectorsPending and warns in the text", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "foo" } });
    const sc = res.structuredContent as { degraded: boolean; vectorsPending: number; hits: unknown[] };
    expect(sc.degraded).toBe(true);
    expect(sc.vectorsPending).toBe(4);
    expect(sc.hits.length).toBe(1); // still returns the (degraded) hit, never crashes
    const text = (res.content as { text: string }[])[0].text.toLowerCase();
    expect(text).toContain("degraded");
    expect(JSON.stringify(sc)).not.toContain(root); // 81n: degraded signal carries no fs path
  });

  test("a lexOnly recall is never marked degraded (no embed attempted)", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "foo", lexOnly: true } });
    const sc = res.structuredContent as { degraded: boolean; vectorsPending: number };
    expect(sc.degraded).toBe(false);
    expect(sc.vectorsPending).toBe(0);
  });
});

describe("MCP platform scoping", () => {
  let root: string;
  let dbDir: string;
  let store: QMDStore;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp-plat-"));
    dbDir = await mkdtemp(join(tmpdir(), "qmemd-mcp-platdb-"));
    store = await openQmd({
      dbPath: join(dbDir, "i.sqlite"),
      config: { collections: { memory: { path: root, pattern: "**/*.md" } } },
    });
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  test("remember accepts a platforms array and writes it", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "Metal load fails on this mac", type: "project", platforms: ["macos"] } });
    expect((res.structuredContent as { wrote: boolean }).wrote).toBe(true);
    const slug = (res.structuredContent as { slug: string }).slug;
    const got = await client.callTool({ name: "get", arguments: { slug } });
    expect((got.structuredContent as { platforms: string[] }).platforms).toEqual(["macos"]);
  });

  test("remember rejects an unknown platform token (zod enum)", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "bad", type: "project", platforms: ["freebsd"] } });
    expect(res.isError).toBe(true);
  });

  test("list accepts a platform filter and labels entries", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "mac fact", type: "project", platforms: ["macos"] } });
    await client.callTool({ name: "remember", arguments: { fact: "cross fact", type: "project" } });
    const res = await client.callTool({ name: "list", arguments: { platform: "linux" } });
    const slugs = (res.structuredContent as { entries: { slug: string }[] }).entries.map((e) => e.slug);
    expect(slugs).toContain("cross-fact");
    expect(slugs).not.toContain("mac-fact");
    expect((res.structuredContent as { entries: { platforms: unknown }[] }).entries.every((e) => Array.isArray(e.platforms))).toBe(true);
  });

  test("recall allPlatforms:true disables the host gate", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "mac only fact about widgets", type: "project", platforms: ["macos"] } });
    const all = await client.callTool({ name: "recall", arguments: { query: "widgets", lexOnly: true, allPlatforms: true } });
    expect((all.structuredContent as { hits: { slug: string }[] }).hits.some((h) => h.slug === "mac-only-fact-about-widgets")).toBe(true);
    // default recall is host-scoped: the macos fact appears iff this host can see macos facts.
    const scoped = await client.callTool({ name: "recall", arguments: { query: "widgets", lexOnly: true } });
    const present = (scoped.structuredContent as { hits: { slug: string }[] }).hits.some((h) => h.slug === "mac-only-fact-about-widgets");
    expect(present).toBe(platformVisible(["macos"], currentPlatform()));
  });

  // qmemd-5gx MCP half (REST half shipped with vuk): a specific platform arg so an
  // agent on linux can ask for only the macos facts — allPlatforms alone can't.
  test("recall with a specific platform scopes to that OS (5gx MCP half)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "platgate zulu linux side", type: "project", platforms: ["linux"] } });
    await client.callTool({ name: "remember", arguments: { fact: "platgate zulu macos side", type: "project", platforms: ["macos"] } });
    const res = await client.callTool({ name: "recall", arguments: { query: "platgate zulu", lexOnly: true, platform: "macos" } });
    expect(res.isError).toBeFalsy();
    const hits = (res.structuredContent as { hits: { slug: string; platforms: string[] }[] }).hits;
    expect(hits.length).toBe(1);
    expect(hits[0].slug).toBe("platgate-zulu-macos-side");
    expect(hits[0].platforms).toEqual(["macos"]);
  });

  test("recall rejects an unknown platform token (zod enum, 5gx)", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "x", lexOnly: true, platform: "beos" } });
    expect(res.isError).toBe(true);
  });

  test("recall rejects platform combined with allPlatforms (5gx, mirrors REST + CLI dbr)", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "x", lexOnly: true, platform: "macos", allPlatforms: true } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/mutually exclusive/i);
  });

  test("recall reports moreMatches in text and structuredContent (40h)", async () => {
    // Facts share ONLY the query marker token — higher overlap can trip the i5y near-dup prepass.
    await client.callTool({ name: "remember", arguments: { fact: "fortyh redpanda broker nine", type: "project", as: "fh-a" } });
    await client.callTool({ name: "remember", arguments: { fact: "fortyh grafana dashboard alpha", type: "project", as: "fh-b" } });
    await client.callTool({ name: "remember", arguments: { fact: "fortyh qdrant collection beta", type: "project", as: "fh-c" } });
    const res = await client.callTool({ name: "recall", arguments: { query: "fortyh", lexOnly: true, limit: 1 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { hits: unknown[]; moreMatches: number; belowFloor: number; saturated: boolean };
    expect(sc.hits.length).toBe(1);
    expect(sc.moreMatches).toBe(2);   // 3 match, 1 shown; pool 1*4=4 > 3 → exact, unsaturated
    expect(sc.belowFloor).toBe(0);
    expect(sc.saturated).toBe(false);
    expect((res.content as { text: string }[])[0].text).toContain("note: 2 more match (raise limit)");
  });

  test("a complete recall carries zero counters and no note (40h)", async () => {
    await client.callTool({ name: "remember", arguments: { fact: "solo zeta marker fact", type: "project", as: "fh-solo" } });
    const res = await client.callTool({ name: "recall", arguments: { query: "zeta", lexOnly: true } });
    const sc = res.structuredContent as { moreMatches: number; belowFloor: number; saturated: boolean };
    expect(sc.moreMatches).toBe(0);
    expect(sc.belowFloor).toBe(0);
    expect(sc.saturated).toBe(false);
    expect((res.content as { text: string }[])[0].text).not.toContain("note:");
  });
});

describe("MCP review_by / ttl (9su)", () => {
  let root: string;
  let dbDir: string;
  let store: QMDStore;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-mcp9su-"));
    dbDir = await mkdtemp(join(tmpdir(), "qmemd-mcp9sudb-"));
    store = await openQmd({
      dbPath: join(dbDir, "i.sqlite"),
      config: { collections: { memory: { path: root, pattern: "**/*.md" } } },
    });
    const server = buildMemoryServer(store, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  test("remember accepts ttl and get returns the stored reviewBy", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "Deploy host IP may shift", type: "project", ttl: "30d" } });
    const sc = res.structuredContent as { wrote: boolean; slug: string };
    expect(sc.wrote).toBe(true);
    const got = await client.callTool({ name: "get", arguments: { slug: sc.slug } });
    const fact = got.structuredContent as { reviewBy?: string };
    expect(fact.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("remember accepts an explicit reviewBy date", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "Cert expires end of year", type: "project", reviewBy: "2026-12-01" } });
    expect((res.structuredContent as { wrote: boolean }).wrote).toBe(true);
    const got = await client.callTool({ name: "get", arguments: { slug: (res.structuredContent as { slug: string }).slug } });
    expect((got.structuredContent as { reviewBy?: string }).reviewBy).toBe("2026-12-01");
  });

  test("ttl validation errors surface verbatim (path-free), not as 'internal error'", async () => {
    const res = await client.callTool({ name: "remember", arguments: { fact: "x y z", ttl: "soon" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/^invalid ttl/);
    expect(text).not.toContain(root);
    const combo = await client.callTool({ name: "remember", arguments: { fact: "x y z", ttl: "90d", reviewBy: "2026-12-01" } });
    expect(combo.isError).toBe(true);
    expect((combo.content as { text: string }[])[0].text).toMatch(/^invalid ttl/);
    const bad = await client.callTool({ name: "remember", arguments: { fact: "x y z", reviewBy: "soon" } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0].text).toMatch(/^invalid review_by/);
  });
});

describe("MCP stdio connect-first: lazy store (qmemd-faif.10)", () => {
  // The stdio launch must answer the `initialize` handshake BEFORE opening the SQLite store, so a
  // cold start (or a clean-room install whose native better-sqlite3 binding is unbuilt) still speaks
  // protocol. The store opens lazily on the first tool call, not at connect.
  test("initialize + listTools answer with zero store-opens; first tool call opens it once", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmemd-lazy-"));
    const dbDir = await mkdtemp(join(tmpdir(), "qmemd-lazydb-"));
    let opens = 0;
    let store: QMDStore | undefined;
    const getStore = async (): Promise<QMDStore> => {
      opens++;
      store ??= await openQmd({
        dbPath: join(dbDir, "i.sqlite"),
        config: { collections: { memory: { path: root, pattern: "**/*.md" } } },
      });
      return store;
    };
    const server = buildMemoryServerLazy(getStore, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "lazy-client", version: "1.0.0" });
    await client.connect(clientTransport); // performs the initialize handshake

    expect(opens).toBe(0); // connect/initialize must not open the store
    await client.listTools();
    expect(opens).toBe(0); // nor does tool discovery
    await client.callTool({ name: "list", arguments: {} });
    expect(opens).toBe(0); // list is filesystem-only — still no store
    await client.callTool({ name: "recall", arguments: { query: "anything", lexOnly: true } });
    expect(opens).toBe(1); // a store-backed tool opens it lazily, exactly once

    await client.close();
    await store?.close();
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });
});

describe("MCP recall capability gate", () => {
  test("stdio server auto-resolves an unspecified recall to lex on a weak host", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmemd-mcpcap-"));
    const dbDir = await mkdtemp(join(tmpdir(), "qmemd-mcpcapdb-"));
    const store = await openQmd({ dbPath: join(dbDir, "i.sqlite"), config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });

    let resolverCalls = 0;
    const server = buildMemoryServer(store, root, { resolveAutoMode: async () => { resolverCalls++; return "lex"; } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(ct);

    // Seed a fact via the remember tool (writes md + lex-reindex; no model).
    await client.callTool({ name: "remember", arguments: { fact: "wabbit tracks here", type: "project" } });

    // Recall WITHOUT lexOnly => the cold stdio server must consult the resolver and run lex.
    const res = await client.callTool({ name: "recall", arguments: { query: "wabbit" } });
    const text = (res.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");

    expect(resolverCalls).toBe(1);
    expect(text).toContain("wabbit tracks here");

    await client.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });
});
