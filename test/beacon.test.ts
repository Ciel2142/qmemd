import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  decideBeacon, pivotOverview, formatPivot, rememberSurfaced, followupOf, commandHash,
  isCaptureCommand, decideWriteBeacon, SURFACED_CAP, PIVOT_LIST_MAX,
  type BeaconState, type PivotOverview,
} from "../src/beacon.js";
import { runBeacon, stateFilePath, readState, writeState, pruneOldStates, formatWriteBeacon, runWriteBeacon } from "../src/beacon.js";
import { buildTokenMap, mapCachePath, type FactLine } from "../src/overlap.js";
import { eventLogPath, type HookEvent } from "../src/hookstats.js";
import { serializeMemory, type MemoryFrontmatter, type MemoryType } from "../src/engine.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const st = (over: Partial<BeaconState> = {}): BeaconState => ({
  repo: "x", callCount: 0, lastBeaconAtCall: 0, beaconedRepos: [], perRepo: {},
  surfacedSlugs: [], probedKeys: [], mapBuiltAtCall: 0, ...over,
});

const lines = (n: number): FactLine[] =>
  Array.from({ length: n }, (_, i) => ({ type: "project" as MemoryType, description: `desc ${i}`, slug: `f${String(i).padStart(2, "0")}` }));

const pov = (over: Partial<PivotOverview> = {}): PivotOverview => ({
  project: "beta", repo: { total: 0, tags: [], facts: [] }, global: { total: 0 }, ...over,
});

interface FactOpts { project?: string; tags?: string[]; description?: string }

async function writeFact(root: string, type: MemoryType, slug: string, opts: FactOpts = {}): Promise<void> {
  await mkdir(join(root, type), { recursive: true });
  const fm: MemoryFrontmatter = {
    name: slug,
    description: opts.description ?? `fact ${slug}`,
    type,
    tags: opts.tags ?? [],
    project: opts.project ?? "global",
    created: "2026-06-10",
    pinned: false,
  };
  await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, `body for ${slug}`));
}

function readEventLog(cache: string): HookEvent[] {
  const raw = readFileSync(eventLogPath(cache), "utf-8");
  return raw.split("\n").filter(l => l.trim() !== "").map(l => JSON.parse(l) as HookEvent);
}

describe("decideBeacon (pivot-only, w3)", () => {
  // covers: SC-45
  test("fires on the first call in a repo, then never again on a call count", () => {
    let d = decideBeacon(null, "repo-a");
    expect(d.fire).toBe(true);
    expect(d.next).toEqual(st({ repo: "repo-a", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: ["repo-a"] }));
    let refires = 0;
    for (let i = 0; i < 99; i++) {
      d = decideBeacon(d.next, "repo-a");
      if (d.fire) refires++;
    }
    expect(refires).toBe(0);
    expect(d.next.callCount).toBe(100); // callCount still advances on every call
  });

  // covers: SC-45
  test("a new repo fires; pivoting back to an already-beaconed repo does not", () => {
    const prev = st({ repo: "repo-a", callCount: 5, lastBeaconAtCall: 1, beaconedRepos: ["repo-a"] });
    const toB = decideBeacon(prev, "repo-b");
    expect(toB.fire).toBe(true);
    expect(toB.next.beaconedRepos).toEqual(["repo-a", "repo-b"]);
    expect(decideBeacon(toB.next, "repo-a").fire).toBe(false);
  });

  // covers: SC-57
  test("carries the surfaced/probed/map fields forward unchanged", () => {
    const prev = st({ repo: "repo-a", callCount: 3, beaconedRepos: ["repo-a"], surfacedSlugs: ["s1"], probedKeys: ["k1"], mapBuiltAtCall: 2 });
    const d = decideBeacon(prev, "repo-a");
    expect(d.next.surfacedSlugs).toEqual(["s1"]);
    expect(d.next.probedKeys).toEqual(["k1"]);
    expect(d.next.mapBuiltAtCall).toBe(2);
  });
});

describe("formatPivot (w3)", () => {
  // covers: SC-46
  test("1..10 repo facts render one fact line each, no histogram, no global line", () => {
    const out = formatPivot(pov({ repo: { total: PIVOT_LIST_MAX, tags: [{ tag: "jdk", count: 2 }], facts: lines(PIVOT_LIST_MAX) }, global: { total: 3 } }));
    const rendered = out.split("\n");
    expect(rendered[0]).toBe("💡 qmemd · beta — 10 repo + 3 global memories");
    expect(rendered.slice(1, 11)).toEqual(lines(PIVOT_LIST_MAX).map(f => `   [project] ${f.description} (${f.slug})`));
    expect(rendered[11]).toBe('   → qmemd recall "beta <topic>" before diagnosing');
    expect(rendered.length).toBe(12);
    expect(out).not.toContain("global:");
  });

  // covers: SC-46
  test("more than 10 repo facts render one repo histogram line instead of fact lines", () => {
    const out = formatPivot(pov({
      repo: { total: 11, tags: [{ tag: "jdk", count: 5 }, { tag: "build", count: 2 }], facts: lines(11) },
      global: { total: 0 },
    }));
    const rendered = out.split("\n");
    expect(rendered[0]).toBe("💡 qmemd · beta — 11 repo + 0 global memories");
    expect(rendered[1]).toBe("   repo: jdk(5) build(2)");
    expect(rendered[2]).toBe('   → qmemd recall "beta <topic>" before diagnosing');
    expect(rendered.length).toBe(3);
    expect(out).not.toContain("(f00)");
  });

  // covers: SC-46
  test("zero repo facts with global facts render header and tail only", () => {
    const out = formatPivot(pov({ repo: { total: 0, tags: [], facts: [] }, global: { total: 7 } }));
    expect(out.split("\n")).toEqual([
      "💡 qmemd · beta — 0 repo + 7 global memories",
      '   → qmemd recall "beta <topic>" before diagnosing',
    ]);
  });

  // covers: SC-46
  test("the repo histogram caps at 12 tags with a (+N more) overflow", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ tag: `t${String(i).padStart(2, "0")}`, count: 15 - i }));
    const out = formatPivot(pov({ repo: { total: 15, tags: many, facts: lines(15) }, global: { total: 0 } }));
    expect(out).toContain("t11(4)");     // 12th tag shown
    expect(out).not.toContain("t12(3)"); // 13th capped
    expect(out).toContain("(+3 more)");
  });
});

describe("pivotOverview (w3)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-pov-"));
    await writeFact(root, "project", "zulu", { project: "beta", tags: ["jdk"] });
    await writeFact(root, "project", "alpha", { project: "beta", tags: ["jdk", "build"] });
    await writeFact(root, "reference", "kafka-ports", { project: "global" });
    await writeFact(root, "project", "other-repo-fact", { project: "gamma" });
    await writeFact(root, "user", "prefers-tabs", { project: "beta" });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // covers: SC-46
  // covers: INV-5
  test("lists in-scope project+reference facts sorted by slug, splits repo vs global, leaks no path", () => {
    const ov = pivotOverview(root, "beta");
    expect(ov.project).toBe("beta");
    expect(ov.repo.total).toBe(2);
    expect(ov.repo.facts.map(f => f.slug)).toEqual(["alpha", "zulu"]); // slug ascending
    expect(ov.repo.tags).toEqual([{ tag: "jdk", count: 2 }, { tag: "build", count: 1 }]);
    expect(ov.global.total).toBe(1); // the reference fact; user/feedback and other repos excluded
    const text = formatPivot(ov);
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/\//);
  });
});

describe("rememberSurfaced (w3)", () => {
  // covers: SC-57
  test("appends new slugs and never duplicates an existing one", () => {
    const once = rememberSurfaced(st({ surfacedSlugs: ["a"] }), ["b", "a", "b"]);
    expect(once.surfacedSlugs).toEqual(["a", "b"]);
    expect(rememberSurfaced(once, ["a"]).surfacedSlugs).toEqual(["a", "b"]);
  });

  // covers: SC-57
  test("caps at SURFACED_CAP, evicting the oldest first", () => {
    const full = st({ surfacedSlugs: Array.from({ length: SURFACED_CAP }, (_, i) => `s${i}`) });
    const next = rememberSurfaced(full, ["fresh"]);
    expect(next.surfacedSlugs.length).toBe(SURFACED_CAP);
    expect(next.surfacedSlugs[0]).toBe("s1");                       // s0 evicted
    expect(next.surfacedSlugs[SURFACED_CAP - 1]).toBe("fresh");
  });
});

describe("followupOf / commandHash (w3)", () => {
  // covers: SC-71
  test("recall followups carry the query, wrapper-prefixed and flag-laden forms included", () => {
    expect(followupOf('rtk qmemd recall "repo build"')).toEqual({ kind: "recall", query: "repo build" });
    expect(followupOf("qmemd recall --limit 5 gradle")).toEqual({ kind: "recall", query: "gradle" });
    expect(followupOf("qmemd recall --session")).toBeNull();
  });

  // covers: SC-71
  test("show/get followups carry the slug; other verbs are not followups", () => {
    expect(followupOf("qmemd show a-slug")).toEqual({ kind: "show", slugs: ["a-slug"] });
    expect(followupOf("qmemd get a-slug --json")).toEqual({ kind: "show", slugs: ["a-slug"] });
    expect(followupOf('qmemd remember "x" --type project')).toBeNull();
    expect(followupOf("mvn test")).toBeNull();
  });

  // covers: SC-70
  test("commandHash is 12 hex characters, stable per command and distinct across commands", () => {
    expect(commandHash("mvn test")).toMatch(/^[0-9a-f]{12}$/);
    expect(commandHash("mvn test")).toBe(commandHash("mvn test"));
    expect(commandHash("mvn test")).not.toBe(commandHash("mvn verify"));
  });
});

describe("beacon marker IO (tfu)", () => {
  let cache: string;
  beforeEach(async () => { cache = await mkdtemp(join(tmpdir(), "qmemd-cache-")); });
  afterEach(async () => { await rm(cache, { recursive: true, force: true }); });

  test("readState returns null when absent; round-trips after writeState", () => {
    const p = stateFilePath(cache, "sess-1");
    expect(readState(p)).toBeNull();
    const s = st({ repo: "x", callCount: 3, lastBeaconAtCall: 1, beaconedRepos: ["x"], perRepo: { x: { calls: 3, captures: 1, writeFired: false } }, surfacedSlugs: ["a"], probedKeys: ["k"], mapBuiltAtCall: 3 });
    writeState(p, s);
    expect(readState(p)).toEqual(s);
  });

  // covers: SC-58
  test("a pre-feature marker reads with surfacedSlugs/probedKeys/mapBuiltAtCall defaults", () => {
    const p = stateFilePath(cache, "pre-feature");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ repo: "beta", callCount: 12, lastBeaconAtCall: 1, beaconedRepos: ["beta"], perRepo: { beta: { calls: 12, captures: 0, writeFired: false } } }));
    const s = readState(p)!;
    expect(s).toEqual(st({ repo: "beta", callCount: 12, lastBeaconAtCall: 1, beaconedRepos: ["beta"], perRepo: { beta: { calls: 12, captures: 0, writeFired: false } } }));
    expect(decideBeacon(s, "beta").fire).toBe(false); // an already-beaconed repo does not re-pivot
  });

  // Write-beacon (qmemd-yl3): markers written before perRepo existed must still parse,
  // defaulting perRepo to {} rather than being rejected as a shape mismatch.
  test("readState back-compat: a marker missing perRepo parses with perRepo = {}", () => {
    const p = stateFilePath(cache, "old");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ repo: "x", callCount: 5, lastBeaconAtCall: 2, beaconedRepos: ["x"] }));
    expect(readState(p)).toEqual(st({ repo: "x", callCount: 5, lastBeaconAtCall: 2, beaconedRepos: ["x"] }));
  });

  test("readState rejects a marker whose perRepo is a non-object", () => {
    const p = stateFilePath(cache, "bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ repo: "x", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: [], perRepo: 7 }));
    expect(readState(p)).toBeNull();
  });

  test("writeState prunes only on the first and every 20th call — not per Bash call (qp-nq2)", async () => {
    const p = stateFilePath(cache, "gated");
    // Seed a stale sibling marker (8 days old) that only a prune sweep would remove.
    mkdirSync(dirname(p), { recursive: true });
    const stale = join(dirname(p), "stale-session.json");
    writeFileSync(stale, "{}");
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    writeState(p, st({ callCount: 7 })); // mid-session call: sweep must NOT run
    expect(existsSync(stale)).toBe(true);
    writeState(p, st({ callCount: 20 })); // gate call: sweep runs, stale marker goes
    expect(existsSync(stale)).toBe(false);
  });

  // covers: SC-69
  test("writeState prunes the event log on the same cadence as the marker sweep", () => {
    const p = stateFilePath(cache, "events");
    const evp = eventLogPath(cache);
    const day = 24 * 60 * 60 * 1000;
    const line = (daysAgo: number, kind: string) =>
      JSON.stringify({ v: 1, ts: new Date(Date.now() - daysAgo * day).toISOString(), session: "s", repo: "r", kind });
    mkdirSync(dirname(evp), { recursive: true });
    writeFileSync(evp, `${line(31, "pivot")}\n${line(29, "overlap")}\n`);
    writeState(p, st({ callCount: 7 }), evp);
    expect(readEventLog(cache).map(e => e.kind)).toEqual(["pivot", "overlap"]); // off-cadence: untouched
    writeState(p, st({ callCount: 20 }), evp);
    expect(readEventLog(cache).map(e => e.kind)).toEqual(["overlap"]);          // 31d line dropped
  });

  test("stateFilePath sanitizes a hostile session id to one safe segment", () => {
    const p = stateFilePath(cache, "../../etc/passwd");
    expect(p.startsWith(join(cache, "hook"))).toBe(true);
    expect(p).not.toContain("..");
  });

  // qmemd-4y2: one marker file is written per session and nothing else deletes them. Prune is
  // best-effort, mtime-based, and must never throw on the Bash PreToolUse hot path.
  test("pruneOldStates deletes markers older than maxAge, keeps fresh + non-json (qmemd-4y2)", () => {
    const hookDir = join(cache, "hook");
    mkdirSync(hookDir, { recursive: true });
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const stale = join(hookDir, "stale.json");
    const fresh = join(hookDir, "fresh.json");
    const other = join(hookDir, "keep.txt");
    for (const p of [stale, fresh, other]) writeFileSync(p, "{}");
    utimesSync(stale, new Date(now - 8 * day), new Date(now - 8 * day));
    utimesSync(fresh, new Date(now - 1 * day), new Date(now - 1 * day));
    utimesSync(other, new Date(now - 30 * day), new Date(now - 30 * day));
    pruneOldStates(hookDir, 7 * day, now);
    expect(existsSync(stale)).toBe(false);  // 8d > 7d → pruned
    expect(existsSync(fresh)).toBe(true);   // 1d < 7d → kept
    expect(existsSync(other)).toBe(true);   // non-.json never touched
  });

  test("pruneOldStates fails open on a missing dir (qmemd-4y2)", () => {
    expect(() => pruneOldStates(join(cache, "does-not-exist"), 1000, 2000)).not.toThrow();
  });

  test("writeState opportunistically prunes a stale sibling marker (qmemd-4y2)", () => {
    const stale = stateFilePath(cache, "ancient");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "{}");
    utimesSync(stale, new Date(0), new Date(0)); // epoch → far past the 7-day window
    const cur = stateFilePath(cache, "current");
    writeState(cur, st({ repo: "x", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: ["x"] }));
    expect(existsSync(stale)).toBe(false); // pruned by the write
    expect(existsSync(cur)).toBe(true);    // the just-written marker survives
  });
});

describe("runBeacon orchestration (w3)", () => {
  let root: string, cache: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-beac-root-"));
    cache = await mkdtemp(join(tmpdir(), "qmemd-beac-cache-"));
    await writeFact(root, "project", "jdk", { project: "beta", tags: ["jdk", "build"], description: "jdk toolchain notes" });
    await writeFact(root, "project", "gradle-daemon", { project: "global", tags: ["gradle", "daemon", "clean"], description: "gradle daemon gotcha" });
    await writeFact(root, "project", "kube-ctl", { project: "global", tags: ["kubectl", "apply", "manifest"], description: "kubectl apply notes" });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });

  const deps = () => ({ memoryRoot: root, cacheDir: cache });

  const evt = (command = "mvn test", over: Record<string, unknown> = {}) => JSON.stringify({
    session_id: "s1", cwd: "/work/beta", tool_name: "Bash", tool_input: { command }, ...over,
  });

  const marker = () => readState(stateFilePath(cache, "s1"));

  // covers: INV-4
  test("a non-Bash tool and malformed stdin are silent", () => {
    expect(runBeacon(evt("mvn test", { tool_name: "Read" }), deps())).toBeNull();
    expect(runBeacon("not json", deps())).toBeNull();
  });

  // covers: SC-45
  test("pivots once per repo and never re-fires on a call count", () => {
    process.env.QMEMD_BEACON_EVERY = "1";
    try {
      const first = runBeacon(evt(), deps());
      expect(first).toContain("💡 qmemd · beta — 1 repo + 2 global memories");
      expect(first).toContain("   [project] jdk toolchain notes (jdk)");
      for (let i = 0; i < 5; i++) expect(runBeacon(evt(), deps())).toBeNull();
      expect(marker()!.beaconedRepos).toEqual(["beta"]);
      expect(runBeacon(evt("mvn test", { cwd: "/work/gamma" }), deps())).toContain("0 repo + 2 global");
    } finally { delete process.env.QMEMD_BEACON_EVERY; }
  });

  // covers: SC-45
  test("a repo with zero in-scope facts is silent and is not marked beaconed", () => {
    const bare = join(cache, "bare-root");
    mkdirSync(bare, { recursive: true });
    expect(runBeacon(evt(), { memoryRoot: bare, cacheDir: cache })).toBeNull();
    const state = marker()!;
    expect(state.beaconedRepos).toEqual([]);
    expect(state.callCount).toBe(1);
  });

  // covers: SC-56
  test("pivot and overlap on one call are joined by a blank line; a later overlap prints alone", () => {
    const first = runBeacon(evt("gradle clean --daemon"), deps());
    const blocks = first!.split("\n\n");
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toContain("💡 qmemd · beta — 1 repo + 2 global memories");
    expect(blocks[1].split("\n")).toEqual([
      "💡 qmemd · beta — facts matching this command:",
      "   [project] gradle daemon gotcha (gradle-daemon)",
      "   → qmemd show gradle-daemon for the full fact",
    ]);
    const later = runBeacon(evt("kubectl apply -f manifest"), deps());
    expect(later!.split("\n\n").length).toBe(1);
    expect(later).toContain("(kube-ctl)");
  });

  // covers: INV-7
  // covers: SC-57
  test("a surfaced slug is never surfaced again in the session", () => {
    runBeacon(evt("gradle clean --daemon"), deps());
    expect(marker()!.surfacedSlugs).toContain("gradle-daemon");
    expect(runBeacon(evt("gradle clean --daemon"), deps())).toBeNull();
  });

  // covers: INV-7
  test("pivot-listed slugs are excluded from the overlap on the same call (D-w3-6)", async () => {
    await writeFact(root, "project", "jdk", { project: "beta", tags: ["jdk", "build", "toolchain"], description: "jdk toolchain notes" });
    const pivoted = runBeacon(evt("jdk toolchain"), deps());
    expect(pivoted).toContain("(jdk)");
    expect(pivoted).not.toContain("facts matching this command");
    // Control: the same command in a session that never listed jdk does match it.
    writeState(stateFilePath(cache, "s2"), st({ repo: "beta", callCount: 1, beaconedRepos: ["beta"] }));
    const out = runBeacon(evt("jdk toolchain", { session_id: "s2" }), deps());
    expect(out).toContain("💡 qmemd · beta — facts matching this command:");
    expect(out).toContain("(jdk)");
  });

  // covers: SC-50
  test("a token-map build failure keeps the pivot block, prints no overlap, and persists state", () => {
    const hostile = join(cache, "hostile-root");
    mkdirSync(hostile, { recursive: true });
    writeFileSync(join(hostile, "project"), "not a directory"); // corpus walk throws
    const overview = () => pov({ repo: { total: 1, tags: [], facts: [{ type: "project", description: "d", slug: "s" }] }, global: { total: 0 } });
    const out = runBeacon(evt("gradle clean --daemon"), { memoryRoot: hostile, cacheDir: cache, overview });
    expect(out).toContain("💡 qmemd · beta — 1 repo + 0 global memories");
    expect(out).not.toContain("facts matching this command");
    expect(marker()!.callCount).toBe(1);
  });

  // covers: SC-70
  test("a pivot and an overlap hit each log one event", () => {
    // Pinned to the current instant, not a literal: writeState prunes the log on this same
    // call, dropping any line older than 30 days.
    const ts = new Date().toISOString();
    runBeacon(evt("gradle clean --daemon"), { ...deps(), now: () => new Date(ts) });
    const evs = readEventLog(cache);
    expect(evs.length).toBe(2);
    expect(evs[0]).toEqual({ v: 1, ts, session: "s1", repo: "beta", kind: "pivot", slugs: ["jdk"] });
    expect(evs[1]).toEqual({
      v: 1, ts, session: "s1", repo: "beta", kind: "overlap",
      slugs: ["gradle-daemon"], cmdHash: commandHash("gradle clean --daemon"),
    });
  });

  // covers: SC-70
  test("an overlap call with zero hits logs nothing (D-w3-7)", () => {
    writeState(stateFilePath(cache, "s1"), st({ repo: "beta", callCount: 1, beaconedRepos: ["beta"] }));
    expect(runBeacon(evt("mvn test"), deps())).toBeNull();
    expect(existsSync(eventLogPath(cache))).toBe(false);
  });

  // covers: SC-71
  test("a followup command logs a followup event and is never overlap-matched", () => {
    writeState(stateFilePath(cache, "s1"), st({ repo: "beta", callCount: 1, beaconedRepos: ["beta"] }));
    expect(runBeacon(evt('rtk qmemd recall "gradle daemon"'), deps())).toBeNull();
    const evs = readEventLog(cache);
    expect(evs.length).toBe(1);
    expect(evs[0].kind).toBe("followup");
    expect(evs[0].query).toBe("gradle daemon");
  });

  // covers: SC-48
  test("the 40-call insurance rebuild picks up an in-place tag edit", async () => {
    const mapPath = mapCachePath(cache, root, "beta");
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, JSON.stringify(buildTokenMap(root, "beta")));
    // In-place rewrite: same file count, same directory mtime → the fingerprint still matches.
    await writeFact(root, "project", "jdk", { project: "beta", tags: ["jdk", "build", "zebra"], description: "jdk toolchain notes" });
    writeState(stateFilePath(cache, "s1"), st({ repo: "beta", callCount: 39, beaconedRepos: ["beta"], mapBuiltAtCall: 1 }));
    expect(runBeacon(evt("zebra jdk"), deps())).toBeNull();     // call 40: 40-1 = 39 < 40 → cached map
    const out = runBeacon(evt("zebra jdk"), deps());            // call 41: 41-1 = 40 → forced rebuild
    expect(out).toContain("(jdk)");
    expect(marker()!.mapBuiltAtCall).toBe(41);

    // A fingerprint-driven rebuild on a non-forced call does not reset the cadence (R-3).
    await writeFact(root, "project", "orangutan", { project: "beta", tags: ["orangutan", "sanctuary"] });
    expect(runBeacon(evt("orangutan sanctuary"), deps())).toContain("(orangutan)");
    expect(marker()!.mapBuiltAtCall).toBe(41);
  });

  // Write-beacon accounting (qmemd-yl3): runBeacon records per-repo work + captures on
  // EVERY Bash call (pivoting or not), so the Stop-hook write beacon can read it.
  test("bumps perRepo.calls on a pivoting and a non-pivoting call (qmemd-yl3)", () => {
    runBeacon(evt(), deps());
    runBeacon(evt(), deps());
    expect(marker()!.perRepo["beta"]).toEqual({ calls: 2, captures: 0, writeFired: false });
  });

  test("bumps perRepo.captures when the command is a capture verb (qmemd-yl3)", () => {
    runBeacon(evt("mvn test"), deps());
    runBeacon(evt('qmemd remember "x" --type project'), deps());
    const act = marker()!.perRepo["beta"];
    expect(act.calls).toBe(2);
    expect(act.captures).toBe(1);
  });

  test("per-repo isolation: a capture in repo A leaves repo B's record intact (qmemd-yl3)", () => {
    runBeacon(evt("br close x", { cwd: "/work/repoA" }), deps());
    runBeacon(evt("mvn test", { cwd: "/work/repoB" }), deps());
    const st2 = marker()!;
    expect(st2.perRepo["repoA"]).toEqual({ calls: 1, captures: 1, writeFired: false });
    expect(st2.perRepo["repoB"]).toEqual({ calls: 1, captures: 0, writeFired: false });
  });
});

describe("isCaptureCommand (write-beacon, qmemd-yl3)", () => {
  test.each([
    'qmemd remember "x" --type project',
    "qmemd reviewed some-slug",
    "br create --title=foo --type=task",
    "br close qp-1 qp-2",
    "br update qp-1 --claim",
    'br q "quick capture"',
    "rtk br close qp-1",          // rtk-rewritten prefix still matches
  ])("matches capture verb: %s", (cmd) => {
    expect(isCaptureCommand(cmd)).toBe(true);
  });

  test.each([
    'qmemd recall "x"',
    "br show qp-1",
    "br ready",
    "echo remember to push",
    "git commit -m 'create thing'",
    "",
  ])("does not match near-miss: %s", (cmd) => {
    expect(isCaptureCommand(cmd)).toBe(false);
  });
});

describe("decideWriteBeacon (write-beacon, qmemd-yl3)", () => {
  const withRepo = (repo: string, act: { calls: number; captures: number; writeFired: boolean }): BeaconState =>
    st({ repo, callCount: act.calls, perRepo: { [repo]: act } });

  test("below threshold does not fire", () => {
    const d = decideWriteBeacon(withRepo("a", { calls: 19, captures: 0, writeFired: false }), "a", 20);
    expect(d.fire).toBe(false);
  });

  test("at threshold with a capture does not fire", () => {
    const d = decideWriteBeacon(withRepo("a", { calls: 25, captures: 1, writeFired: false }), "a", 20);
    expect(d.fire).toBe(false);
  });

  test("at threshold with zero captures fires and latches that repo", () => {
    const d = decideWriteBeacon(withRepo("a", { calls: 20, captures: 0, writeFired: false }), "a", 20);
    expect(d.fire).toBe(true);
    expect(d.next!.perRepo["a"].writeFired).toBe(true);
  });

  test("an already-latched repo does not fire again", () => {
    const d = decideWriteBeacon(withRepo("a", { calls: 40, captures: 0, writeFired: true }), "a", 20);
    expect(d.fire).toBe(false);
  });

  test("a different repo at threshold fires independently", () => {
    const state = st({
      repo: "a",
      perRepo: {
        a: { calls: 40, captures: 0, writeFired: true },   // already nudged
        b: { calls: 22, captures: 0, writeFired: false },  // fresh
      },
    });
    const d = decideWriteBeacon(state, "b", 20);
    expect(d.fire).toBe(true);
    expect(d.next!.perRepo["b"].writeFired).toBe(true);
    expect(d.next!.perRepo["a"].writeFired).toBe(true); // untouched
  });

  test("null state (no marker) never fires", () => {
    const d = decideWriteBeacon(null, "a", 20);
    expect(d.fire).toBe(false);
    expect(d.next).toBeNull();
  });

  test("a repo with no activity record never fires", () => {
    const d = decideWriteBeacon(withRepo("a", { calls: 30, captures: 0, writeFired: false }), "other", 20);
    expect(d.fire).toBe(false);
  });
});

describe("formatWriteBeacon (write-beacon, qmemd-yl3)", () => {
  test("names the repo + count, steers lanes, leaks no fs path", () => {
    const s = formatWriteBeacon("beta", 31);
    expect(s).toContain("beta");
    expect(s).toContain("31 Bash calls");
    expect(s).toContain("durable → qmemd");
    expect(s).toContain("work-state → br");
    expect(s).not.toMatch(/\/(home|Users|work)\//); // no absolute fs path leaks (qmemd-81n); prose slashes (gotcha/decision/preference) are fine
  });
});

describe("runWriteBeacon orchestration (write-beacon, qmemd-yl3)", () => {
  let cache: string;
  beforeEach(async () => { cache = await mkdtemp(join(tmpdir(), "qmemd-wb-")); });
  afterEach(async () => { await rm(cache, { recursive: true, force: true }); });

  const stop = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ session_id: "s1", cwd: "/work/beta", ...over });

  const seed = (act: { calls: number; captures: number; writeFired: boolean }, repo = "beta") =>
    writeState(stateFilePath(cache, "s1"), st({ repo, callCount: act.calls, perRepo: { [repo]: act } }));

  test("malformed stdin returns null (fail-open)", () => {
    expect(runWriteBeacon("not json", { cacheDir: cache, threshold: 20 })).toBeNull();
  });

  test("no marker for the session returns null", () => {
    expect(runWriteBeacon(stop(), { cacheDir: cache, threshold: 20 })).toBeNull();
  });

  test("gate-tripping marker returns the nudge line naming the repo", () => {
    seed({ calls: 22, captures: 0, writeFired: false });
    const out = runWriteBeacon(stop(), { cacheDir: cache, threshold: 20 });
    expect(out).toContain("beta");
    expect(out).toContain("22 Bash calls");
  });

  test("fires at most once per repo: a second Stop is silent after the latch", () => {
    seed({ calls: 22, captures: 0, writeFired: false });
    expect(runWriteBeacon(stop(), { cacheDir: cache, threshold: 20 })).not.toBeNull();
    expect(runWriteBeacon(stop(), { cacheDir: cache, threshold: 20 })).toBeNull(); // latched
  });

  test("a repo with a capture never nudges", () => {
    seed({ calls: 50, captures: 1, writeFired: false });
    expect(runWriteBeacon(stop(), { cacheDir: cache, threshold: 20 })).toBeNull();
  });
});
