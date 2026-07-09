import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { decideBeacon, formatBeacon, isCaptureCommand, decideWriteBeacon, type BeaconState } from "../src/beacon.js";
import { runBeacon, stateFilePath, readState, writeState, pruneOldStates, formatWriteBeacon, runWriteBeacon } from "../src/beacon.js";
import type { ProjectOverview } from "../src/engine.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ov = (project: string, repoTotal: number, globalTotal: number): ProjectOverview => ({
  project,
  total: repoTotal + globalTotal,
  tags: [{ tag: "jdk", count: 2 }, { tag: "build", count: 1 }],
  byType: { user: 0, feedback: 0, project: repoTotal + globalTotal, reference: 0 },
  repo: { total: repoTotal, tags: repoTotal ? [{ tag: "jdk", count: 2 }, { tag: "build", count: 1 }] : [] },
  global: { total: globalTotal, tags: globalTotal ? [{ tag: "k3s", count: 3 }, { tag: "pi", count: 1 }] : [] },
});

describe("decideBeacon (tfu)", () => {
  test("first call of a session fires full (no prior state)", () => {
    const d = decideBeacon(null, "beta", 20);
    expect(d.fire).toBe(true);
    expect(d.terse).toBe(false);
    expect(d.next).toEqual({ repo: "beta", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: ["beta"], perRepo: {} });
  });

  test("same repo before cooldown does not fire", () => {
    const prev: BeaconState = { repo: "beta", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: ["beta"], perRepo: {} };
    const d = decideBeacon(prev, "beta", 20);
    expect(d.fire).toBe(false);
    expect(d.next.callCount).toBe(2);
    expect(d.next.lastBeaconAtCall).toBe(1); // unchanged
  });

  test("same repo at the cooldown boundary re-fires terse", () => {
    const prev: BeaconState = { repo: "beta", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: ["beta"], perRepo: {} };
    let d = decideBeacon(prev, "beta", 3);   // call 2
    d = decideBeacon(d.next, "beta", 3);      // call 3
    d = decideBeacon(d.next, "beta", 3);      // call 4: 4-1=3 >= 3 → fire
    expect(d.fire).toBe(true);
    expect(d.terse).toBe(true);
    expect(d.next.lastBeaconAtCall).toBe(4);
  });

  test("pivot to a new repo fires full and records it", () => {
    const prev: BeaconState = { repo: "beta", callCount: 5, lastBeaconAtCall: 1, beaconedRepos: ["beta"], perRepo: {} };
    const d = decideBeacon(prev, "alpha", 20);
    expect(d.fire).toBe(true);
    expect(d.terse).toBe(false);                     // never beaconed alpha
    expect(d.next.beaconedRepos).toEqual(["beta", "alpha"]);
  });

  test("pivot BACK to an already-beaconed repo fires terse", () => {
    const prev: BeaconState = { repo: "alpha", callCount: 6, lastBeaconAtCall: 6, beaconedRepos: ["beta", "alpha"], perRepo: {} };
    const d = decideBeacon(prev, "beta", 20);
    expect(d.fire).toBe(true);
    expect(d.terse).toBe(true);                      // saw the full table earlier
  });
});

describe("formatBeacon (tfu)", () => {
  test("full form names the repo, split counts, both tag shapes, and a recall example", () => {
    const s = formatBeacon(ov("beta", 14, 3), false);
    expect(s).toContain("beta");
    expect(s).toContain("14 repo + 3 global memories:");
    expect(s).toMatch(/repo: +jdk\(2\) build\(1\)/);
    expect(s).toMatch(/global: +k3s\(3\) pi\(1\)/);
    expect(s).toContain('qmemd recall "beta');
  });
  test("full form does not assert load-state it cannot know (i34)", () => {
    const s = formatBeacon(ov("beta", 14, 3), false);
    expect(s).not.toContain("not loaded this session");
    expect(s).toContain("recall before diagnosing");
  });
  test("terse form is one line with split counts and no tag shape", () => {
    const s = formatBeacon(ov("beta", 14, 3), true);
    expect(s).toContain("beta");
    expect(s).toContain("14 repo + 3 global");
    expect(s).not.toContain("jdk(2)");
    expect(s.split("\n").length).toBe(1);
  });
  test("never leaks a filesystem path (qmemd-81n)", () => {
    expect(formatBeacon(ov("beta", 3, 2), false)).not.toMatch(/\//);
    expect(formatBeacon(ov("beta", 3, 2), true)).not.toMatch(/\//);
  });
  test("zero-repo omits the repo line but keeps the honest count", () => {
    const s = formatBeacon(ov("beta", 0, 5), false);
    expect(s).toContain("0 repo + 5 global memories:");
    expect(s).not.toMatch(/\n {3}repo:/);
    expect(s).toMatch(/global: +k3s\(3\)/);
  });
  test("zero-global omits the global line", () => {
    const s = formatBeacon(ov("beta", 5, 0), false);
    expect(s).toContain("5 repo + 0 global memories:");
    expect(s).not.toMatch(/\n {3}global:/);
    expect(s).toMatch(/repo: +jdk\(2\)/);
  });
  test("histogram lines cap at 12 tags with a (+N more) overflow", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ tag: `t${String(i).padStart(2, "0")}`, count: 15 - i }));
    const wide: ProjectOverview = {
      project: "beta", total: 15, tags: many,
      byType: { user: 0, feedback: 0, project: 15, reference: 0 },
      repo: { total: 15, tags: many }, global: { total: 0, tags: [] },
    };
    const s = formatBeacon(wide, false);
    expect(s).toContain("t11(4)");        // 12th tag shown
    expect(s).not.toContain("t12(3)");    // 13th capped
    expect(s).toContain("(+3 more)");
  });
  test("a scope with facts but no tags renders (untagged)", () => {
    const bare: ProjectOverview = {
      project: "x", total: 2, tags: [],
      byType: { user: 0, feedback: 0, project: 2, reference: 0 },
      repo: { total: 2, tags: [] }, global: { total: 0, tags: [] },
    };
    expect(formatBeacon(bare, false)).toContain("(untagged)");
  });
});

describe("beacon marker IO (tfu)", () => {
  let cache: string;
  beforeEach(async () => { cache = await mkdtemp(join(tmpdir(), "qmemd-cache-")); });
  afterEach(async () => { await rm(cache, { recursive: true, force: true }); });

  test("readState returns null when absent; round-trips after writeState", () => {
    const p = stateFilePath(cache, "sess-1");
    expect(readState(p)).toBeNull();
    const s: BeaconState = {
      repo: "x", callCount: 3, lastBeaconAtCall: 1, beaconedRepos: ["x"],
      perRepo: { x: { calls: 3, captures: 1, writeFired: false } },
    };
    writeState(p, s);
    expect(readState(p)).toEqual(s);
  });

  // Write-beacon (qmemd-yl3): markers written before perRepo existed must still parse,
  // defaulting perRepo to {} rather than being rejected as a shape mismatch.
  test("readState back-compat: a marker missing perRepo parses with perRepo = {}", () => {
    const p = stateFilePath(cache, "old");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ repo: "x", callCount: 5, lastBeaconAtCall: 2, beaconedRepos: ["x"] }));
    expect(readState(p)).toEqual({ repo: "x", callCount: 5, lastBeaconAtCall: 2, beaconedRepos: ["x"], perRepo: {} });
  });

  test("readState rejects a marker whose perRepo is a non-object", () => {
    const p = stateFilePath(cache, "bad");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ repo: "x", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: [], perRepo: 7 }));
    expect(readState(p)).toBeNull();
  });

  test("writeState prunes only on the first and every 20th call — not per Bash call (qp-nq2)", async () => {
    const p = stateFilePath(cache, "gated");
    const state = (callCount: number): BeaconState =>
      ({ repo: "x", callCount, lastBeaconAtCall: 0, beaconedRepos: [], perRepo: {} });
    // Seed a stale sibling marker (8 days old) that only a prune sweep would remove.
    mkdirSync(dirname(p), { recursive: true });
    const stale = join(dirname(p), "stale-session.json");
    writeFileSync(stale, "{}");
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    writeState(p, state(7)); // mid-session call: sweep must NOT run
    expect(existsSync(stale)).toBe(true);
    writeState(p, state(20)); // gate call: sweep runs, stale marker goes
    expect(existsSync(stale)).toBe(false);
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
    writeState(cur, { repo: "x", callCount: 1, lastBeaconAtCall: 1, beaconedRepos: ["x"], perRepo: {} });
    expect(existsSync(stale)).toBe(false); // pruned by the write
    expect(existsSync(cur)).toBe(true);    // the just-written marker survives
  });
});

describe("runBeacon orchestration (tfu)", () => {
  let root: string, cache: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-beac-root-"));
    cache = await mkdtemp(join(tmpdir(), "qmemd-beac-cache-"));
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "jdk.md"),
      `---\nname: jdk\ndescription: jdk\ntype: project\ntags: [jdk, build]\nproject: beta\ncreated: 2026-06-01\npinned: false\n---\n\nbody\n`);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });

  const evt = (over: Record<string, unknown> = {}) => JSON.stringify({
    session_id: "s1", cwd: "/work/beta", tool_name: "Bash", tool_input: { command: "mvn test" }, ...over,
  });

  test("non-Bash tool returns null (silent)", () => {
    expect(runBeacon(evt({ tool_name: "Read" }), { memoryRoot: root, cacheDir: cache, everyN: 20 })).toBeNull();
  });
  test("repo with no memories returns null", () => {
    expect(runBeacon(evt({ cwd: "/work/empty-repo" }), { memoryRoot: root, cacheDir: cache, everyN: 20 })).toBeNull();
  });
  test("first Bash in a repo with memories returns the full beacon", () => {
    const out = runBeacon(evt(), { memoryRoot: root, cacheDir: cache, everyN: 20 });
    expect(out).toContain("beta");
    expect(out).toContain("build(1)");
    expect(out).toContain("jdk(1)");
  });
  test("second Bash same session/repo within cooldown returns null", () => {
    runBeacon(evt(), { memoryRoot: root, cacheDir: cache, everyN: 20 });
    expect(runBeacon(evt(), { memoryRoot: root, cacheDir: cache, everyN: 20 })).toBeNull();
  });
  test("malformed stdin returns null (fail-open)", () => {
    expect(runBeacon("not json", { memoryRoot: root, cacheDir: cache, everyN: 20 })).toBeNull();
  });

  // qmemd-abi: the corpus scan is the expensive step on the hottest path (every Bash
  // PreToolUse). The throttle must run first; throttled calls never touch the corpus.
  test("throttled call does not scan the corpus (qmemd-abi)", () => {
    let scans = 0;
    const overview = (_root: string, project: string) => { scans++; return ov(project, 14, 0); };
    const deps = { memoryRoot: root, cacheDir: cache, everyN: 20, overview };
    expect(runBeacon(evt(), deps)).toContain("beta"); // first call fires → one scan
    expect(scans).toBe(1);
    expect(runBeacon(evt(), deps)).toBeNull();               // within cooldown → no scan
    expect(scans).toBe(1);
  });

  test("fact-less repo advances the throttle: scan runs 1/everyN, not every call (qmemd-abi)", () => {
    let scans = 0;
    const empty = (project: string): ProjectOverview =>
      ({ project, total: 0, tags: [], byType: { user: 0, feedback: 0, project: 0, reference: 0 },
         repo: { total: 0, tags: [] }, global: { total: 0, tags: [] } });
    const overview = (_root: string, project: string) => { scans++; return empty(project); };
    const deps = { memoryRoot: root, cacheDir: cache, everyN: 20, overview };
    expect(runBeacon(evt(), deps)).toBeNull(); // pivot fire-attempt → scan → empty → silent
    expect(runBeacon(evt(), deps)).toBeNull(); // within cooldown → no scan
    expect(scans).toBe(1);
  });

  test("empty-corpus fire does not mark the repo beaconed: first real beacon is full (qmemd-abi)", () => {
    let total = 0;
    const overview = (_root: string, project: string): ProjectOverview => ({
      project, total,
      tags: total ? [{ tag: "jdk", count: 2 }] : [],
      byType: { user: 0, feedback: 0, project: total, reference: 0 },
      repo: { total, tags: total ? [{ tag: "jdk", count: 2 }] : [] },
      global: { total: 0, tags: [] },
    });
    const deps = { memoryRoot: root, cacheDir: cache, everyN: 2, overview };
    expect(runBeacon(evt(), deps)).toBeNull();      // call 1: fire-attempt, corpus empty
    total = 3;                                      // facts appear mid-session
    expect(runBeacon(evt(), deps)).toBeNull();      // call 2: sinceLast=1 < 2 — throttled
    const out = runBeacon(evt(), deps);             // call 3: sinceLast=2 ≥ 2 → fires
    expect(out).toContain("3 repo + 0 global memories:"); // full table…
    expect(out).toContain("jdk(2)");                    // …not the terse one-liner
  });

  // Write-beacon accounting (qmemd-yl3): runBeacon records per-repo work + captures on
  // EVERY Bash call (firing or throttled), so the Stop-hook write beacon can read it.
  test("bumps perRepo.calls on a firing and a throttled call (qmemd-yl3)", () => {
    const deps = { memoryRoot: root, cacheDir: cache, everyN: 20 };
    runBeacon(evt(), deps);                       // call 1 (fires)
    runBeacon(evt(), deps);                       // call 2 (throttled)
    const st = readState(stateFilePath(cache, "s1"))!;
    expect(st.perRepo["beta"].calls).toBe(2);
    expect(st.perRepo["beta"].captures).toBe(0);
  });

  test("bumps perRepo.captures when the command is a capture verb (qmemd-yl3)", () => {
    const deps = { memoryRoot: root, cacheDir: cache, everyN: 20 };
    runBeacon(evt({ tool_input: { command: "mvn test" } }), deps);
    runBeacon(evt({ tool_input: { command: 'qmemd remember "x" --type project' } }), deps);
    const st = readState(stateFilePath(cache, "s1"))!;
    expect(st.perRepo["beta"].calls).toBe(2);
    expect(st.perRepo["beta"].captures).toBe(1);
  });

  test("per-repo isolation: a capture in repo A leaves repo B's record intact (qmemd-yl3)", () => {
    const deps = { memoryRoot: root, cacheDir: cache, everyN: 20 };
    runBeacon(evt({ cwd: "/work/repoA", tool_input: { command: "br close x" } }), deps); // A: capture
    runBeacon(evt({ cwd: "/work/repoB", tool_input: { command: "mvn test" } }), deps);   // B: work, no capture
    const st = readState(stateFilePath(cache, "s1"))!;
    expect(st.perRepo["repoA"]).toEqual({ calls: 1, captures: 1, writeFired: false });
    expect(st.perRepo["repoB"]).toEqual({ calls: 1, captures: 0, writeFired: false });
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
  const withRepo = (repo: string, act: { calls: number; captures: number; writeFired: boolean }): BeaconState => ({
    repo, callCount: act.calls, lastBeaconAtCall: 0, beaconedRepos: [], perRepo: { [repo]: act },
  });

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
    const st: BeaconState = {
      repo: "a", callCount: 0, lastBeaconAtCall: 0, beaconedRepos: [],
      perRepo: {
        a: { calls: 40, captures: 0, writeFired: true },   // already nudged
        b: { calls: 22, captures: 0, writeFired: false },  // fresh
      },
    };
    const d = decideWriteBeacon(st, "b", 20);
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
    writeState(stateFilePath(cache, "s1"), {
      repo, callCount: act.calls, lastBeaconAtCall: 0, beaconedRepos: [], perRepo: { [repo]: act },
    });

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
