import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeMemory, type MemoryFrontmatter } from "../src/engine.js";

// End-to-end CLI guard for qmemd-jzz: an unvalidated --type was cast straight to
// MemoryType and became a path segment (join(root, type) + mkdirSync), so
// `--type ../../x` escaped the memory root and `--type bogus` wrote an
// unrecallable folder. The CLI must reject an invalid --type before opening the
// store or touching the filesystem.

const CLI = resolve(__dirname, "..", "src", "cli", "qmemd.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(args: string[], root: string) {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, QMD_MEMORY_DIR: root, QMEMD_DB: join(root, ".idx", "i.sqlite") },
  });
}

describe("CLI --type validation (jzz)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("remember --type with a traversal value exits non-zero and writes nothing outside root", async () => {
    const escape = "../../../../tmp/qmemd-jzz-evil-" + process.pid;
    const res = runCli(["remember", "a durable fact", "--type", escape], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --type/i);
    // The traversal dir/file must never have been created.
    expect(existsSync(join(root, escape))).toBe(false);
    expect(existsSync(resolve(root, escape))).toBe(false);
  });

  test("remember --type with a bogus (non-enum) value exits non-zero with the valid set listed", async () => {
    const res = runCli(["remember", "a durable fact", "--type", "bogus"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --type/i);
    expect(res.stderr).toMatch(/user/);
    expect(res.stderr).toMatch(/feedback/);
    expect(res.stderr).toMatch(/project/);
    expect(res.stderr).toMatch(/reference/);
    // Nothing was written under the bogus folder.
    expect(existsSync(join(root, "bogus"))).toBe(false);
  });

  test("recall --type with an invalid value exits non-zero (jzz applies to recall too)", async () => {
    const res = runCli(["recall", "anything", "--type", "../escape"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --type/i);
  });
});

describe("CLI --help / -h prints usage (qmemd-3ix)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // parseArgs is strict; before qmemd-3ix neither --help nor -h was declared, so the
  // canonical discovery command threw ERR_PARSE_ARGS_UNKNOWN_OPTION before verb dispatch
  // and the top-level main().catch dumped a raw TypeError + stack trace. --help must
  // print the usage block (same one as bare `qmemd` / `qmemd help`) and exit 0 instead.
  test("--help exits 0 and prints usage, not a stack trace", () => {
    const res = runCli(["--help"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/qmemd <remember\|recall\|forget/);
    expect(res.stdout).toMatch(/recall <query>/);
    expect(res.stderr).not.toMatch(/ERR_PARSE_ARGS_UNKNOWN_OPTION|TypeError/);
  });

  test("-h is an alias for --help (exit 0, usage on stdout)", () => {
    const res = runCli(["-h"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/qmemd <remember\|recall\|forget/);
    expect(res.stderr).not.toMatch(/ERR_PARSE_ARGS_UNKNOWN_OPTION|TypeError/);
  });
});

describe("CLI `get` is a hidden alias for `show` (qmemd-gs8)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // Agents reflexively type `qmemd get <slug>` because the MCP surface names the tool
  // `get` (mcp__qmemd__get, and qmd's own mcp__qmd__get), but the CLI verb is `show`.
  // Before gs8, `get` fell into the default case → printUsage + exit 1. `get` must
  // dispatch byte-identically to `show` (same filesystem-only getFact path, no model).
  test("`get <slug>` prints the same fact as `show <slug>` and exits 0", () => {
    const w = runCli(["remember", "The widget cache TTL is 90 seconds", "--type", "project", "--as", "widget-cache-ttl"], root);
    expect(w.status).toBe(0);
    const show = runCli(["show", "widget-cache-ttl"], root);
    const get = runCli(["get", "widget-cache-ttl"], root);
    expect(get.status).toBe(0);
    expect(get.stdout).toBe(show.stdout); // identical render, ANSI codes included
    expect(get.stdout).toMatch(/90 seconds/);
  });

  test("`get` on a missing slug exits non-zero with the same message as `show`", () => {
    const res = runCli(["get", "no-such-slug"], root);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toMatch(/No memory named/);
  });
});

describe("CLI surfaces unreadable facts (e5h)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-e5h-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // A directory named *.md makes readFileSync throw EISDIR — a stand-in for a corrupt fact.
  async function seed() {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "ok.md"),
      "---\nname: ok\ndescription: ok fact\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-07\npinned: false\n---\n\nok fact\n");
    await mkdir(join(root, "project", "corrupt.md"), { recursive: true });
  }

  test("list warns about unreadable facts on stderr (stdout stays the clean list), pointing at doctor", async () => {
    await seed();
    const res = runCli(["list"], root);
    expect(res.stdout).toContain("ok");                  // the readable fact still lists on stdout
    expect(res.stderr).toMatch(/1 fact.*unreadable/i);   // the corrupt one is surfaced, not hidden
    expect(res.stderr).toContain("qmemd doctor");
  });

  test("list over a clean corpus prints no unreadable warning", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "ok.md"),
      "---\nname: ok\ndescription: ok fact\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-07\npinned: false\n---\n\nok fact\n");
    const res = runCli(["list"], root);
    expect(res.stderr).not.toMatch(/unreadable/i);
  });
});

describe("CLI recall --min-score (rde)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-minscore-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("a non-numeric --min-score exits non-zero before opening the store", async () => {
    const res = runCli(["recall", "anything", "--min-score", "abc"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --min-score/i);
  });

  test("a negative --min-score exits non-zero (=, so parseArgs keeps the value)", async () => {
    const res = runCli(["recall", "anything", "--min-score=-1"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --min-score/i);
  });

  test("--min-score with --lex prints a hybrid-only note, and lex recall still works (model-free)", async () => {
    const w = runCli(["remember", "Redpanda runs on the lab pi", "--type", "project"], root);
    expect(w.status).toBe(0);
    const res = runCli(["recall", "Redpanda", "--lex", "--min-score", "0.5"], root);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/--min-score is ignored with --lex/i);
    expect(res.stdout).toMatch(/Redpanda/); // the lex hit is unaffected by the ignored floor
  });
});

describe("CLI remember conflict surface (5td)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-5td-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("a high-similarity contradiction prints a contradiction prompt with both resolutions", async () => {
    const a = runCli(["remember", "TLS certificate verification is enabled on the S3 client", "--type", "project"], root);
    expect(a.status).toBe(0);
    const b = runCli(["remember", "TLS certificate verification is disabled on the S3 client", "--type", "project"], root);
    expect(b.status).toBe(0);
    // "contradiction" appears ONLY in the conflict message — the plain near-dup message
    // (which also carries "update"/"--replace"/"--force") must not satisfy this.
    expect(b.stdout).toMatch(/contradiction/i);
    expect(b.stdout).toMatch(/--replace/);
    expect(b.stdout).toMatch(/--force/);
  });

  test("vkn: CLI conflict prints the authority line", async () => {
    runCli(["remember", "The cache TTL is 60 seconds", "--type", "project"], root);
    const out = runCli(["remember", "The cache TTL is 120 seconds", "--type", "user"], root).stdout;
    expect(out).toMatch(/Authority:/);
    expect(out).toMatch(/tier 2/);          // the incoming user fact
    expect(out).toMatch(/more authoritative/);
  });

  test("a true paraphrase still prints the plain near-duplicate message, not a contradiction", async () => {
    runCli(["remember", "Redpanda broker runs on the lab pi server", "--type", "project"], root);
    const dup = runCli(["remember", "Redpanda broker runs on lab pi node", "--type", "project"], root);
    expect(dup.stdout).toMatch(/near-duplicate/i);
    expect(dup.stdout).not.toMatch(/contradiction/i);
  });
});

describe("CLI remember report-shape warning (a3k)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-a3k-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("a report-shaped body still writes (exit 0) but prints a non-blocking docs/reports warning", async () => {
    const report = "## What happened\nThe exchange 500'd.\n## Root cause\nDescriptor marshalled before signatures.\n## Fix\nStamp signatures first.";
    const res = runCli(["remember", report, "--type", "project"], root);
    expect(res.status).toBe(0);                       // non-blocking: write succeeds
    expect(res.stdout).toMatch(/remembered/);         // the fact was stored
    expect(res.stderr).toMatch(/docs\/reports\//);    // ...and the mis-route is flagged
  });

  test("a normal fact prints no report warning", async () => {
    const res = runCli(["remember", "Redis admin user is on with full ACL; default user is off", "--type", "project"], root);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/docs\/reports\//);
  });
});

describe("CLI reindex verb (bu9)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-reindex-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("reindex builds the lex index for a pre-existing (externally written) memory file (bu9)", async () => {
    // Simulate adopting a dir written out-of-band: a markdown fact on disk that
    // qmemd never wrote, so its index has no knowledge of it until `reindex`
    // scans the filesystem (the gap the removed `qmemd watch` daemon used to fill).
    const dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "redpanda-fact.md"),
      "---\nname: redpanda-fact\ndescription: Redpanda runs on the lab pi\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-01\npinned: false\n---\nRedpanda runs on the lab pi at 192.0.2.34\n");

    // Before reindex: the lex index is empty, so recall finds nothing.
    const before = runCli(["recall", "Redpanda", "--lex", "--json"], root);
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout)).toHaveLength(0);

    // reindex scans the dir and (re)builds the FTS index — no model load.
    const idx = runCli(["reindex"], root);
    expect(idx.status).toBe(0);

    // After reindex: the externally-written fact is recallable.
    const after = runCli(["recall", "Redpanda", "--lex", "--json"], root);
    expect(after.status).toBe(0);
    const hits = JSON.parse(after.stdout) as { slug: string }[];
    expect(hits.some(h => h.slug === "redpanda-fact")).toBe(true);
  });
});

describe("CLI recall --full (bgf)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-full-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("recall caps the body by default and returns the full body with --full", async () => {
    const dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    const longBody = "Redpanda detail. " + "padding ".repeat(120); // > 500 bytes, one line
    await writeFile(join(dir, "redpanda-detail.md"),
      `---\nname: redpanda-detail\ndescription: Redpanda detail\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-01\npinned: false\n---\n${longBody}\n`);
    expect(runCli(["reindex"], root).status).toBe(0);

    const capped = runCli(["recall", "Redpanda", "--lex", "--json"], root);
    expect(capped.status).toBe(0);
    const ch = (JSON.parse(capped.stdout) as { slug: string; body?: string }[]).find(h => h.slug === "redpanda-detail");
    expect(ch?.body).toBeDefined();
    expect(Buffer.byteLength(ch!.body!, "utf-8")).toBeLessThanOrEqual(503);
    expect(ch!.body!.endsWith("…")).toBe(true);

    const full = runCli(["recall", "Redpanda", "--lex", "--full", "--json"], root);
    const fh = (JSON.parse(full.stdout) as { slug: string; body?: string }[]).find(h => h.slug === "redpanda-detail");
    expect(fh!.body).toBe(longBody.trim());
    expect(fh!.body!.endsWith("…")).toBe(false);
  });

  test("recall --skim returns headline hits with no body (r0u)", async () => {
    const dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skim-note.md"),
      `---\nname: skim-note\ndescription: Skim note detail\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-01\npinned: false\n---\nSkim note body that must not appear in skim output.\n`);
    expect(runCli(["reindex"], root).status).toBe(0);

    const res = runCli(["recall", "Skim", "--lex", "--skim", "--json"], root);
    expect(res.status).toBe(0);
    const h = (JSON.parse(res.stdout) as { slug: string; body?: string }[]).find(x => x.slug === "skim-note");
    expect(h).toBeDefined();
    expect(h!.body).toBeUndefined();
  });
});

describe("CLI show (bgf)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-show-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("show prints type, description, tags and body — never the fs path", async () => {
    const dir = join(root, "reference");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "grafana-url.md"),
      `---\nname: grafana-url\ndescription: Grafana dashboard\ntype: reference\ntags: [obs, lab]\nproject: global\ncreated: 2026-06-01\npinned: false\n---\nhttps://grafana.example/d/abc\n`);
    const res = runCli(["show", "grafana-url"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Grafana dashboard");
    expect(res.stdout).toContain("https://grafana.example/d/abc");
    expect(res.stdout).toContain("obs");
    expect(res.stdout).not.toContain(root); // no absolute fs path leaked
  });

  test("show on a missing slug exits 1 with 'No memory named'", async () => {
    const res = runCli(["show", "no-such-slug"], root);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain("No memory named 'no-such-slug'.");
  });
});

describe("CLI list (bgf)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-listcli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function put(type: string, slug: string, desc: string) {
    const dir = join(root, type);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug}.md`),
      `---\nname: ${slug}\ndescription: ${desc}\ntype: ${type}\ntags: []\nproject: global\ncreated: 2026-06-01\npinned: false\n---\nbody\n`);
  }

  test("list --json emits a JSON array of entries", async () => {
    await put("user", "u1", "User fact one");
    await put("project", "p1", "Project fact one");
    const res = runCli(["list", "--json"], root);
    expect(res.status).toBe(0);
    const entries = JSON.parse(res.stdout) as { slug: string }[];
    expect(entries.map(e => e.slug).sort()).toEqual(["p1", "u1"]);
  });

  test("list (human) groups by type", async () => {
    await put("user", "u1", "User fact one");
    const res = runCli(["list"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[user]");
    expect(res.stdout).toContain("u1");
    expect(res.stdout).toContain("User fact one");
  });

  test("list over an empty corpus prints 'No memories.'", async () => {
    const res = runCli(["list"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("No memories.");
  });
});

describe("CLI remember --replace inherits metadata (q65)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-q65cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // End-to-end guard for the CLI flag→input mapping: --pin maps to `pinned` and an
  // absent --pin must reach remember() as undefined (not false), or a --replace that
  // omits --pin silently unpins the existing fact. Engine-level q65 tests can't catch
  // a `!!values.pin` regression here because they call remember() directly.
  test("--replace without --pin/--tags keeps the existing pin and tags", async () => {
    const first = runCli(["remember", "Original fact body", "--type", "user", "--as", "pintest", "--pin", "--tags", "alpha,beta"], root);
    expect(first.status).toBe(0);
    const upd = runCli(["remember", "Updated fact body", "--replace", "pintest"], root);
    expect(upd.status).toBe(0);
    const listed = runCli(["list", "--json"], root);
    expect(listed.status).toBe(0);
    const entry = (JSON.parse(listed.stdout) as { slug: string; pinned: boolean; tags: string[] }[]).find(e => e.slug === "pintest");
    expect(entry).toBeDefined();
    expect(entry!.pinned).toBe(true);                // pin preserved (a !!values.pin regression would unpin)
    expect(entry!.tags).toEqual(["alpha", "beta"]);  // tags preserved
  });

  // Sibling of qmemd-t0z: --platforms "" clears scope, so --tags "" must clear tags the
  // same way (present-empty → []), matching the MCP/HTTP tags:[] surface. The old
  // `values.tags ? … : undefined` mapping treated "" as absent → inherit, leaving the
  // CLI with NO path to clear tags on --replace (qmemd-s0r).
  test("--replace --tags \"\" clears tags back to [], not inherits", async () => {
    const first = runCli(["remember", "Tagged fact body", "--type", "user", "--as", "s0rclear", "--tags", "alpha,beta"], root);
    expect(first.status).toBe(0);
    const upd = runCli(["remember", "Updated fact body", "--replace", "s0rclear", "--tags", ""], root);
    expect(upd.status).toBe(0);
    const listed = runCli(["list", "--json"], root);
    expect(listed.status).toBe(0);
    const entry = (JSON.parse(listed.stdout) as { slug: string; tags: string[] }[]).find(e => e.slug === "s0rclear");
    expect(entry).toBeDefined();
    expect(entry!.tags).toEqual([]); // explicit empty cleared the tags
  });
});

function runHook(stdin: string, root: string, cache: string, everyN?: string) {
  return spawnSync(TSX, [CLI, "hook", "beacon"], {
    encoding: "utf-8",
    input: stdin,
    env: {
      ...process.env,
      QMD_MEMORY_DIR: root,
      QMEMD_DB: join(root, ".idx", "i.sqlite"),
      XDG_CACHE_HOME: cache,
      ...(everyN ? { QMEMD_BEACON_EVERY: everyN } : {}),
    },
  });
}

function runWriteHook(stdin: string, root: string, cache: string, opts: { on?: boolean; min?: string } = {}) {
  return spawnSync(TSX, [CLI, "hook", "write-beacon"], {
    encoding: "utf-8",
    input: stdin,
    env: {
      ...process.env,
      QMD_MEMORY_DIR: root,
      QMEMD_DB: join(root, ".idx", "i.sqlite"),
      XDG_CACHE_HOME: cache,
      QMEMD_WRITE_BEACON: opts.on ? "1" : "", // explicit so host env never leaks in
      ...(opts.min ? { QMEMD_WRITE_BEACON_MIN: opts.min } : {}),
    },
  });
}

describe("CLI hook beacon e2e (tfu)", () => {
  let root: string, cache: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-hook-"));
    cache = await mkdtemp(join(tmpdir(), "qmemd-hookc-"));
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "jdk.md"),
      `---\nname: jdk\ndescription: jdk\ntype: project\ntags: [jdk, build]\nproject: beta\ncreated: 2026-06-01\npinned: false\n---\n\nbody\n`);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });

  const evt = (over: Record<string, unknown> = {}) => JSON.stringify({
    session_id: "s1", cwd: "/work/beta", tool_name: "Bash", tool_input: { command: "mvn test" }, ...over,
  });

  test("first Bash emits PreToolUse additionalContext, exit 0", () => {
    const res = runHook(evt(), root, cache);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("beta");
    expect(out.hookSpecificOutput.additionalContext).toContain("build(1)");
    expect(out.hookSpecificOutput.additionalContext).toContain("jdk(1)");
  });

  test("second Bash within cooldown emits nothing, exit 0", () => {
    runHook(evt(), root, cache);
    const res = runHook(evt(), root, cache);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  test("non-Bash tool emits nothing, exit 0", () => {
    const res = runHook(evt({ tool_name: "Read" }), root, cache);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  test("malformed stdin never blocks: exit 0, no output", () => {
    const res = runHook("garbage", root, cache);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  test("re-fires after everyN Bash calls when QMEMD_BEACON_EVERY=1", () => {
    const first = runHook(evt(), root, cache, "1");   // call 1: first fire (full)
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("beta");
    const second = runHook(evt(), root, cache, "1");  // call 2: everyN=1, 2-1=1 >= 1 → re-fires (terse)
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("beta");
  });

  // qmemd-1jt: `parseInt(...) || 20` coerced QMEMD_BEACON_EVERY=0 to 20 — the opposite of
  // the stated intent (0 = fire on every call). 0 must behave like every-call; a
  // non-numeric value falls back to the default silently (hook path stays fail-open).
  test("QMEMD_BEACON_EVERY=0 fires on every call, not silently every 20 (qmemd-1jt)", () => {
    const first = runHook(evt(), root, cache, "0");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("beta");
    const second = runHook(evt(), root, cache, "0");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("beta");
  });

  test("non-numeric QMEMD_BEACON_EVERY falls back to the default cooldown (qmemd-1jt)", () => {
    const first = runHook(evt(), root, cache, "abc");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("beta");   // pivot fire unaffected
    const second = runHook(evt(), root, cache, "abc");
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe("");           // default cooldown (20) applies
  });
});

describe("CLI hook write-beacon e2e (qmemd-yl3)", () => {
  let root: string, cache: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-whook-"));
    cache = await mkdtemp(join(tmpdir(), "qmemd-whookc-"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });

  const bash = (cmd: string) => JSON.stringify({
    session_id: "s1", cwd: "/work/beta", tool_name: "Bash", tool_input: { command: cmd },
  });
  const stop = JSON.stringify({ session_id: "s1", cwd: "/work/beta" });

  test("enabled + work-without-capture fires a Stop nudge, exit 0", () => {
    runHook(bash("mvn test"), root, cache); // one Bash call → perRepo.calls=1, captures=0
    const res = runWriteHook(stop, root, cache, { on: true, min: "1" });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(out.hookSpecificOutput.additionalContext).toContain("beta");
  });

  test("a capture in the repo suppresses the nudge, exit 0", () => {
    runHook(bash('qmemd remember "x" --type project'), root, cache); // captures=1
    const res = runWriteHook(stop, root, cache, { on: true, min: "1" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  test("disabled (QMEMD_WRITE_BEACON unset) is a silent no-op, exit 0", () => {
    runHook(bash("mvn test"), root, cache);
    const res = runWriteHook(stop, root, cache, { on: false, min: "1" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });
});

describe("CLI recall --limit validation (qmemd-1jt)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // `parseInt(...) || 10` silently turned an explicit --limit 0 and a non-numeric
  // --limit into the default — user input discarded with no error.
  test("--limit 0 exits non-zero instead of silently becoming 10", async () => {
    const res = runCli(["recall", "anything", "--limit", "0"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --limit/i);
  });

  test("non-numeric --limit exits non-zero instead of silently becoming 10", async () => {
    const res = runCli(["recall", "anything", "--limit", "abc"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid --limit/i);
  });

  test("a valid --limit still recalls (model-free lex path)", async () => {
    const w = runCli(["remember", "Redpanda broker runs on the lab pi", "--type", "project"], root);
    expect(w.status).toBe(0);
    const res = runCli(["recall", "Redpanda", "--lex", "--limit", "1", "--json"], root);
    expect(res.status).toBe(0);
  });
});

describe("CLI tags verb (tfu)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-tags-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const writeProj = async (name: string, project: string, tags: string[]) => {
    await mkdir(join(root, "project"), { recursive: true });
    const fm = `---\nname: ${name}\ndescription: ${name}\ntype: project\ntags: [${tags.join(", ")}]\nproject: ${project}\ncreated: 2026-06-01\npinned: false\n---\n\nbody\n`;
    await writeFile(join(root, "project", `${name}.md`), fm);
  };

  test("--project --json prints an overview with total and tags", async () => {
    await writeProj("jdk-fact", "beta", ["jdk", "build"]);
    await writeProj("k3s-fact", "beta", ["k3s"]);
    const res = runCli(["tags", "--project", "beta", "--json"], root);
    expect(res.status).toBe(0);
    const ov = JSON.parse(res.stdout);
    expect(ov.total).toBe(2);
    expect(ov.tags).toEqual(expect.arrayContaining([{ tag: "jdk", count: 1 }, { tag: "build", count: 1 }, { tag: "k3s", count: 1 }]));
  });

  test("human output names the project and lists tag(count)", async () => {
    await writeProj("jdk-fact", "beta", ["jdk", "build"]);
    const res = runCli(["tags", "--project", "beta"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("beta");
    expect(res.stdout).toMatch(/jdk\(1\)/);
  });
});

describe("doctor (CLI, qmemd-61h)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-doctor-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const writeFact = async (type: string, file: string, content: string) => {
    await mkdir(join(root, type), { recursive: true });
    await writeFile(join(root, type, file), content);
  };
  // A clean project fact whose name matches `name` and type matches the project/ folder.
  const clean = (name: string) =>
    `---\nname: ${name}\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-06\npinned: false\n---\n\nbody\n`;

  test("clean corpus reports 0 issues and exits 0", async () => {
    await writeFact("project", "ok.md", clean("ok"));
    const res = runCli(["doctor"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no .*issues/i);
  });

  test("flags a type mismatch and a name drift, exits non-zero", async () => {
    await writeFact("project", "scoped.md", clean("scoped").replace("type: project", "type: reference"));
    await writeFact("project", "drift.md", clean("not-the-stem"));
    const res = runCli(["doctor"], root);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("project/scoped.md");
    expect(res.stdout).toContain("TYPE_MISMATCH");
    expect(res.stdout).toContain("project/drift.md");
    expect(res.stdout).toContain("NAME_MISMATCH");
  });

  test("flags a broken fence (missing close), exits non-zero", async () => {
    await writeFact("reference", "broke.md", "---\nname: broke\ntype: reference\n"); // no closing fence
    const res = runCli(["doctor"], root);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("MISSING_CLOSE");
  });

  test("--json emits a machine-readable report (integrity + stale) and exits non-zero on findings", async () => {
    await writeFact("project", "scoped.md", clean("scoped").replace("type: project", "type: reference"));
    const res = runCli(["doctor", "--json"], root);
    expect(res.status).not.toBe(0);
    const out = JSON.parse(res.stdout);
    expect(Array.isArray(out.integrity)).toBe(true);
    expect(out.integrity[0].relpath).toBe("project/scoped.md");
    expect(out.integrity[0].issues[0].code).toBe("TYPE_MISMATCH");
    expect(out.stale).toHaveProperty("unreviewedTotal");
  });

  test("a stale-but-valid fact does NOT make doctor exit non-zero (staleness is advisory)", async () => {
    // an ancient project fact with no integrity problem: implicitly due, but not "broken"
    await writeFact("project", "ancient.md",
      "---\nname: ancient\ndescription: ancient fact\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\n---\n\nBody.\n");
    const res = runCli(["doctor"], root);
    expect(res.status).toBe(0);                       // exit code is integrity-only
    expect(res.stdout).toContain("Due for review");   // but the advisory section shows it
    expect(res.stdout).toContain("ancient");
  });

  test("--json carries the stale report even with zero integrity issues", async () => {
    await writeFact("project", "ancient.md",
      "---\nname: ancient\ndescription: ancient fact\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\n---\n\nBody.\n");
    const res = runCli(["doctor", "--json"], root);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.integrity).toEqual([]);
    expect(out.stale.due.map((e: { slug: string }) => e.slug)).toContain("ancient");
  });

  test("--fix repairs mechanical issues, leaves a .bak, and a re-audit is clean (exit 0)", async () => {
    await writeFact("project", "drift.md", clean("wrong-name")); // NAME_MISMATCH (stem is 'drift')
    const fix = runCli(["doctor", "--fix"], root);
    expect(fix.status).toBe(0); // nothing unfixable remains
    expect(fix.stdout).toMatch(/drift\.md/);
    expect(existsSync(join(root, "project", "drift.md.bak"))).toBe(true);
    expect(runCli(["doctor"], root).status).toBe(0); // re-audit clean
  });

  test("--fix still exits non-zero when an unfixable issue remains", async () => {
    await writeFact("project", "drift.md", clean("wrong-name"));   // fixable NAME_MISMATCH
    await writeFact("reference", "broke.md", "---\nname: broke\n"); // unfixable MISSING_CLOSE
    const res = runCli(["doctor", "--fix"], root);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("MISSING_CLOSE");
  });

  test("is filesystem-only: never opens the store / loads a model (no index DB created)", async () => {
    await writeFact("project", "ok.md", clean("ok"));
    runCli(["doctor"], root);
    // openMemoryStore() would create QMEMD_DB; doctor must not.
    expect(existsSync(join(root, ".idx", "i.sqlite"))).toBe(false);
  });
});

describe("dedup (CLI, qmemd-dao)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-dedup-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // name doubles as the slug stem; the engine compares `name + firstLine(body)`.
  const fact = (name: string, project: string, body: string) =>
    `---\nname: ${name}\ndescription: ${body}\ntype: project\ntags: []\nproject: ${project}\ncreated: 2026-06-10\npinned: false\n---\n\n${body}\n`;
  const writeFact = async (name: string, project: string, body: string) => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", name + ".md"), fact(name, project, body));
  };

  test("a corpus with no within-project near-dups reports nothing and exits 0", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    await writeFact("factc", "alpha", "redis admin password lab acl locked anonymous noauth blocked");
    const res = runCli(["dedup"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no .*cluster/i);
  });

  test("surfaces a loose within-project cluster the write-path floor misses, exits 0", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    await writeFact("factb", "alpha", "alpha requires jdk 21 real install sdkman default");
    const res = runCli(["dedup"], root);
    expect(res.status).toBe(0); // a review surface, not a gate
    expect(res.stdout).toContain("alpha");
    expect(res.stdout).toContain("facta");
    expect(res.stdout).toContain("factb");
  });

  test("does NOT surface same-topic facts across project buckets (cross-repo guard)", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    await writeFact("factd", "beta", "build beta jdk 21 maven lombok works");
    const res = runCli(["dedup"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no .*cluster/i);
  });

  test("--json emits the structured DedupReport", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    await writeFact("factb", "alpha", "alpha requires jdk 21 real install sdkman default");
    const res = runCli(["dedup", "--json"], root);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.threshold).toBe(0.18);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].members.map((m: { slug: string }) => m.slug).sort()).toEqual(["facta", "factb"]);
  });

  test("--min-dice raises the floor and drops a mid-similarity cluster", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    await writeFact("factb", "alpha", "alpha requires jdk 21 real install sdkman default");
    const res = runCli(["dedup", "--min-dice", "0.8", "--json"], root);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).clusters).toEqual([]);
  });

  test("is filesystem-only: never opens the store / loads a model (no index DB created)", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    runCli(["dedup"], root);
    expect(existsSync(join(root, ".idx", "i.sqlite"))).toBe(false);
  });

  test("rejects an empty --project instead of silently surfacing nothing", async () => {
    await writeFact("facta", "alpha", "build alpha jdk 21 maven lombok works");
    await writeFact("factb", "alpha", "alpha requires jdk 21 real install sdkman default");
    const res = runCli(["dedup", "--project", ""], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--project/);
  });
});

describe("CLI platform scoping (qmemd-vsc)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-plat-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("remember --platforms macos writes the field; show prints it", () => {
    const out = runCli(["remember", "Metal embed load fails on this mac", "--type", "project", "--platforms", "macos"], root);
    expect(out.status).toBe(0);
    const show = runCli(["show", "metal-embed-load-fails-on-this-mac"], root);
    expect(show.stdout).toContain("platforms:");
    expect(show.stdout).toContain("macos");
  });

  test("remember --platforms rejects an unknown token (exit 1, path-free)", () => {
    const out = runCli(["remember", "bad", "--type", "project", "--platforms", "freebsd"], root);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/invalid --platforms/i);
    expect(out.stderr).not.toContain("/"); // path-free (qmemd-81n sibling)
  });

  test("list --platform linux filters out a macos fact and labels the rest", () => {
    runCli(["remember", "a mac fact", "--type", "project", "--platforms", "macos"], root);
    runCli(["remember", "a cross fact", "--type", "project"], root);
    const out = runCli(["list", "--platform", "linux"], root);
    expect(out.stdout).toContain("a-cross-fact");
    expect(out.stdout).not.toContain("a-mac-fact");
    expect(out.stdout).not.toContain("{macos}"); // the filtered fact's platform label must not bleed through
  });

  test("list --platform rejects an unknown token (exit 1)", () => {
    const out = runCli(["list", "--platform", "freebsd"], root);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/invalid --platform/i);
  });

  test("recall --all-platforms surfaces a macos fact via the JSON path (host gate disabled)", () => {
    runCli(["remember", "a mac fact about cogs", "--type", "project", "--platforms", "macos"], root);
    const out = runCli(["recall", "cogs", "--lex", "--all-platforms", "--json"], root);
    const hits = JSON.parse(out.stdout) as { slug: string; platforms: string[] }[];
    expect(hits.some((h) => h.slug === "a-mac-fact-about-cogs")).toBe(true);
    expect(hits.every((h) => Array.isArray(h.platforms))).toBe(true);
  });

  test("recall rejects --all-platforms combined with an invalid --platform instead of swallowing it (qmemd-dbr)", () => {
    const out = runCli(["recall", "anything", "--lex", "--all-platforms", "--platform", "freebsd"], root);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/mutually exclusive/i);
  });

  test("recall rejects --all-platforms combined with a VALID --platform (the combo is contradictory) (qmemd-dbr)", () => {
    const out = runCli(["recall", "anything", "--lex", "--all-platforms", "--platform", "linux"], root);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/mutually exclusive/i);
  });

  test("remember --replace --platforms \"\" un-scopes a host-scoped fact back to cross-platform (qmemd-t0z)", () => {
    expect(runCli(["remember", "a mac-only quirk", "--type", "project", "--as", "t0zclear", "--platforms", "macos"], root).status).toBe(0);
    expect(runCli(["show", "t0zclear"], root).stdout).toContain("macos"); // sanity: scoped to macos
    const repl = runCli(["remember", "a quirk, now cross-platform", "--type", "project", "--replace", "t0zclear", "--platforms", ""], root);
    expect(repl.status).toBe(0);
    expect(runCli(["show", "t0zclear"], root).stdout).not.toContain("macos"); // explicit empty cleared the scope
  });

  test("remember --replace WITHOUT --platforms still inherits the existing scope (qmemd-t0z regression)", () => {
    expect(runCli(["remember", "a linux quirk", "--type", "project", "--as", "t0zinherit", "--platforms", "linux"], root).status).toBe(0);
    const repl = runCli(["remember", "a linux quirk, revised", "--type", "project", "--replace", "t0zinherit"], root);
    expect(repl.status).toBe(0);
    expect(runCli(["show", "t0zinherit"], root).stdout).toContain("linux"); // omitted --platforms inherits, not clears
  });

  test("remember rejects the singular --platform instead of silently ignoring it (qmemd-s5j)", () => {
    const out = runCli(["remember", "a mac thing", "--type", "project", "--platform", "macos"], root);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/--platforms/); // points the user at the correct plural write flag
    // the fact must NOT have been silently written (cross-platform) under the wrong flag
    expect(runCli(["show", "a-mac-thing"], root).status).not.toBe(0);
  });

  test("remember rejects --all-platforms (a recall/list flag) (qmemd-s5j)", () => {
    const out = runCli(["remember", "another thing", "--type", "project", "--all-platforms"], root);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/--platforms/);
  });

  test("list --platform accepts mixed case and matches the lowercase fact (qmemd-fvv)", () => {
    runCli(["remember", "a mac fact", "--type", "project", "--platforms", "macos"], root);
    const out = runCli(["list", "--platform", "MacOS"], root);
    expect(out.status).toBe(0); // MacOS normalized to macos, not a hard exit-1 reject
    expect(out.stdout).toContain("a-mac-fact");
  });
});

describe("CLI recall completeness footer (40h)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-40h-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function putRedpanda(n: number) {
    const dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      await writeFile(join(dir, `redpanda-${i}.md`),
        `---\nname: redpanda-${i}\ndescription: Redpanda fact ${i}\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-09\npinned: false\n---\nRedpanda body ${i}\n`);
    }
    expect(runCli(["reindex"], root).status).toBe(0);
  }

  test("human recall prints the footer when matches exceed --limit (40h)", async () => {
    await putRedpanda(5); // pool 2*4=8 > 5 → exact surplus of 3
    const res = runCli(["recall", "Redpanda", "--lex", "--limit", "2"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("3 more match");
    expect(res.stdout).toContain("--limit");
  });

  test("--json keeps the array shape and reports the footer on stderr (40h)", async () => {
    await putRedpanda(5);
    const res = runCli(["recall", "Redpanda", "--lex", "--limit", "2", "--json"], root);
    expect(res.status).toBe(0);
    const hits = JSON.parse(res.stdout) as unknown[];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBe(2);
    expect(res.stderr).toContain("3 more match");
  });

  test("a complete recall prints no footer (40h)", async () => {
    await putRedpanda(2);
    const res = runCli(["recall", "Redpanda", "--lex"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("more match");
    expect(res.stdout).not.toContain("relevance floor");
  });
});

describe("CLI --supersedes flag (bri)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-bri-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("remember --supersedes: exit 0, prints superseded line, list marks old fact", async () => {
    // Write the fact to be superseded first.
    const old = runCli(["remember", "Redis default user is enabled with no password", "--type", "project", "--as", "redis-auth-old"], root);
    expect(old.status).toBe(0);

    // Write the new fact, superseding the old one.
    const res = runCli(["remember", "Redis default user is off; auth via admin/admin", "--type", "project", "--as", "redis-auth-new", "--supersedes", "redis-auth-old"], root);
    expect(res.status).toBe(0);
    // stdout must contain a superseded confirmation line.
    expect(res.stdout).toMatch(/superseded 'redis-auth-old'/);

    // list must show the old fact with the [superseded by ...] marker.
    const list = runCli(["list"], root);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/superseded by redis-auth-new/);
  });
});

describe("CLI stale verb + remember --ttl/--review-by (9su)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("remember --ttl writes review_by; stale lists it once due", async () => {
    const w = runCli(["remember", "Gitea PAT rotates", "--type", "project", "--ttl", "1d"], root);
    expect(w.status).toBe(0);
    const file = readFileSync(join(root, "project", "gitea-pat-rotates.md"), "utf-8");
    expect(file).toMatch(/review_by: \d{4}-\d{2}-\d{2}/);
  });

  test("remember rejects --ttl combined with --review-by", () => {
    const res = runCli(["remember", "some fact", "--ttl", "90d", "--review-by", "2026-12-01"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid ttl/);
  });

  test("remember rejects a malformed --review-by", () => {
    const res = runCli(["remember", "some fact", "--review-by", "soon"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid review_by/);
  });

  test("stale lists due facts and oldest-unreviewed, exits 0, never mutates", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "overdue.md"),
      "---\nname: overdue\ndescription: overdue fact\ntype: project\ntags: []\nproject: global\ncreated: 2026-01-01\npinned: false\nreview_by: 2020-01-01\n---\n\nBody.\n");
    await writeFile(join(root, "project", "ageless.md"),
      "---\nname: ageless\ndescription: ageless fact\ntype: project\ntags: []\nproject: global\ncreated: 2026-01-02\npinned: false\n---\n\nBody.\n");
    const res = runCli(["stale"], root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("overdue");
    expect(res.stdout).toContain("ageless");
    // listing never rewrites the files
    expect(readFileSync(join(root, "project", "overdue.md"), "utf-8")).toContain("review_by: 2020-01-01");
  });

  test("stale --json emits the structured report", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "overdue.md"),
      "---\nname: overdue\ndescription: overdue fact\ntype: project\ntags: []\nproject: global\ncreated: 2026-01-01\npinned: false\nreview_by: 2020-01-01\n---\n\nBody.\n");
    const res = runCli(["stale", "--json"], root);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.due[0].slug).toBe("overdue");
    expect(parsed.unreviewedTotal).toBe(0);
  });

  test("reviewed forward-sets review_by without bumping updated", async () => {
    const w = runCli(["remember", "The CD registry PAT is named cd-registry", "--type", "project"], root);
    expect(w.status).toBe(0);
    const file = join(root, "project", "the-cd-registry-pat-is-named-cd-registry.md");
    const before = readFileSync(file, "utf-8");
    const res = runCli(["reviewed", "the-cd-registry-pat-is-named-cd-registry", "--ttl", "30d"], root);
    expect(res.status).toBe(0);
    const after = readFileSync(file, "utf-8");
    expect(after).toMatch(/review_by: \d{4}-\d{2}-\d{2}/);
    // updated line (if any) is unchanged: the only differing frontmatter line is review_by
    const updatedBefore = before.match(/^updated:.*$/m)?.[0];
    const updatedAfter = after.match(/^updated:.*$/m)?.[0];
    expect(updatedAfter).toBe(updatedBefore);
  });

  test("reviewed --ttl never marks a fact durable", async () => {
    runCli(["remember", "Inbucket is the canonical mail sink", "--type", "project"], root);
    const res = runCli(["reviewed", "inbucket-is-the-canonical-mail-sink", "--ttl", "never"], root);
    expect(res.status).toBe(0);
    expect(readFileSync(join(root, "project", "inbucket-is-the-canonical-mail-sink.md"), "utf-8")).toContain("review_by: never");
  });

  test("reviewed on a missing slug errors (non-zero, client-safe message)", () => {
    const res = runCli(["reviewed", "no-such-slug"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/no fact named 'no-such-slug'/);
  });

  test("reviewed rejects --ttl combined with --review-by", () => {
    runCli(["remember", "Qdrant gRPC is 6334", "--type", "project"], root);
    const res = runCli(["reviewed", "qdrant-grpc-is-6334", "--ttl", "30d", "--review-by", "2027-01-01"], root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/invalid ttl/);
  });
});

// `qmemd dedup --merge` emits a `qmemd forget <s1> <s2> ...` skeleton (buildMergeCommands,
// qmemd-a6e) and its unit test asserts that variadic form — but the CLI forget case read
// only rest[0], so the emitted command silently retired just the first slug, leaving the
// rest of a merged cluster un-forgotten. forget must honor every slug it is handed.
describe("CLI forget is variadic (qmemd-a6e merge skeleton)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function writeFact(slug: string): Promise<void> {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(
      join(root, "project", slug + ".md"),
      `---\nname: ${slug}\ndescription: ${slug} body\ntype: project\ntags: []\nproject: p\ncreated: 2026-06-10\npinned: false\n---\n${slug} body\n`,
    );
  }

  test("forget removes every slug passed, not just the first", async () => {
    await writeFact("facta");
    await writeFact("factb");
    await writeFact("factc");

    const res = runCli(["forget", "factb", "factc"], root);
    expect(res.status).toBe(0);
    expect(existsSync(join(root, "project", "facta.md"))).toBe(true);  // untouched
    expect(existsSync(join(root, "project", "factb.md"))).toBe(false); // removed
    expect(existsSync(join(root, "project", "factc.md"))).toBe(false); // removed (the bug: was left behind)
    expect(res.stdout).toContain("factb");
    expect(res.stdout).toContain("factc");
  });

  test("forget exits non-zero when any slug is missing, but still removes the present ones", async () => {
    await writeFact("facta");

    const res = runCli(["forget", "facta", "nope"], root);
    expect(res.status).not.toBe(0);                                   // 'nope' absent → non-zero
    expect(existsSync(join(root, "project", "facta.md"))).toBe(false); // present slug still removed
    expect(res.stdout).toMatch(/No memory named 'nope'/);
  });
});

describe("CLI recall project scoping (qmemd-due)", () => {
  let root: string;
  // Run recall from a cwd whose basename is the project we want to scope to.
  function runCliIn(args: string[], cwd: string) {
    return spawnSync(TSX, [CLI, ...args], {
      encoding: "utf-8", cwd,
      env: { ...process.env, QMD_MEMORY_DIR: root, QMEMD_DB: join(root, ".idx", "i.sqlite") },
    });
  }
  let cwdAlpha: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-cli-due-"));
    cwdAlpha = join(root, "cwd", "alpha");
    await mkdir(cwdAlpha, { recursive: true });
    runCli(["remember", "alpha gateway widgettimeout fix", "--type", "project", "--project", "alpha"], root);
    runCli(["remember", "beta gateway widgettimeout fix", "--type", "project", "--project", "beta"], root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("default recall (cwd basename 'alpha') hides foreign facts and notes the hidden count", () => {
    const res = runCliIn(["recall", "gateway widgettimeout", "--lex"], cwdAlpha);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("alpha gateway widgettimeout fix");
    expect(res.stdout).not.toContain("beta gateway widgettimeout fix");
    expect(res.stdout).toMatch(/cross-project match.*--cross-project to include/);
  });

  test("--cross-project shows foreign facts under a divider, tagged with their project", () => {
    const res = runCliIn(["recall", "gateway widgettimeout", "--lex", "--cross-project"], cwdAlpha);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("alpha gateway widgettimeout fix");
    expect(res.stdout).toContain("— other projects —");
    expect(res.stdout).toMatch(/⊥ beta/);
    // widened ⇒ nothing hidden ⇒ no hidden-count footer
    expect(res.stdout).not.toMatch(/cross-project match.*to include/);
  });
});

describe("dedup --apply (qmemd-3fb)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // Seed a fact FILE directly (bypasses remember's dedup so two near-dups can coexist),
  // using serializeMemory for a guaranteed-parseable round-trip (mirrors merge-apply.test.ts).
  async function seedFact(slug: string, body: string, project: string, tags: string[]): Promise<void> {
    await mkdir(join(root, "project"), { recursive: true });
    const fm: MemoryFrontmatter = { name: slug, description: body, type: "project", tags, project, created: "2026-06-10", pinned: false };
    await writeFile(join(root, "project", slug + ".md"), serializeMemory(fm, body));
  }
  // dedup --apply reads the plan from stdin ('-'); spawnSync supports `input` (see runHook ~line 392).
  const applyStdin = (input: string) =>
    spawnSync(TSX, [CLI, "dedup", "--apply", "-"], {
      encoding: "utf-8", input,
      env: { ...process.env, QMD_MEMORY_DIR: root, QMEMD_DB: join(root, ".idx", "i.sqlite") },
    });

  test("applies a folded plan from stdin: keeper rewritten, others gone", async () => {
    await seedFact("facta", "alpha jdk 21 maven works", "alpha", ["jdk", "build"]);
    await seedFact("factb", "alpha jdk 21 sdkman install", "alpha", ["jdk", "sdkman"]);

    const proposal = JSON.parse(runCli(["dedup", "--merge", "--json"], root).stdout);
    const cluster = proposal.clusters[0];
    const plan = JSON.stringify({ cluster, foldedBody: "alpha jdk 21 maven sdkman install works" });

    const out = applyStdin(plan);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/merged → '/);
    expect(JSON.parse(runCli(["list", "--json"], root).stdout)).toHaveLength(1); // 2 → 1
  });

  test("a folded body that drops an identifier exits non-zero, corpus intact", async () => {
    await seedFact("facta", "root cause jdk-8321319 not lombok", "alpha", ["jdk"]);
    await seedFact("factb", "alpha jdk-8321319 build", "alpha", ["jdk"]);
    const cluster = JSON.parse(runCli(["dedup", "--merge", "--json"], root).stdout).clusters[0];
    const plan = JSON.stringify({ cluster, foldedBody: "root cause lombok build" });

    const out = applyStdin(plan);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/identifier token/);
    expect(JSON.parse(runCli(["list", "--json"], root).stdout)).toHaveLength(2); // untouched
  });

  test("rejects a malformed plan (cluster without a members array) with a clean message", () => {
    // A hand-crafted plan that passes a naive truthy `cluster` check but lacks members —
    // the shape guard must reject it cleanly BEFORE applyMerge, not crash with a TypeError.
    const out = applyStdin(JSON.stringify({ cluster: {}, foldedBody: "x" }));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/invalid plan/);
  });
});
