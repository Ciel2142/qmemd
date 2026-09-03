import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import {
  headTokens, errorLine, buildProbeQuery, probeKey, formatProbe, runProbe,
  PROBE_ERROR_LINE_CAP, PROBE_MAX_TOKENS, type ProbeDeps,
} from "../src/probe.js";
import { readState, writeState, stateFilePath, SURFACED_CAP, type BeaconState } from "../src/beacon.js";
import { eventLogPath, type HookEvent } from "../src/hookstats.js";
import type { RecallHit, RecallOptions, RecallResult } from "../src/engine.js";

const st = (over: Partial<BeaconState> = {}): BeaconState => ({
  repo: "repo-a", callCount: 3, lastBeaconAtCall: 1, beaconedRepos: ["repo-a"], perRepo: {},
  surfacedSlugs: [], probedKeys: [], mapBuiltAtCall: 0, ...over,
});

const hit = (slug: string, over: Partial<RecallHit> = {}): RecallHit => ({
  slug, path: `/abs/memory/project/${slug}.md`, type: "project",
  description: `desc ${slug}`, platforms: [], project: "repo-a", ...over,
});

const result = (hits: RecallHit[]): RecallResult => ({ hits, degraded: false, vectorsPending: 0 });

const evt = (over: Record<string, unknown> = {}) => JSON.stringify({
  session_id: "s1", cwd: "/work/repo-a", tool_name: "Bash", is_interrupt: false,
  error: "Exit code 1\nnpm ERR! ERESOLVE unable to resolve dependency tree",
  tool_input: { command: "npm ci" }, ...over,
});

type RecallFn = (query: string, opts: RecallOptions) => Promise<RecallResult>;

function harness(root: string, cache: string, recall: RecallFn, over: Partial<ProbeDeps> = {}) {
  const spy = { opens: 0, closes: 0 };
  const calls: { query: string; opts: RecallOptions }[] = [];
  const store = { close: async () => { spy.closes++; } } as unknown as QMDStore;
  const deps: ProbeDeps = {
    memoryRoot: root,
    cacheDir: cache,
    openStore: async () => { spy.opens++; return store; },
    recall: async (_store, _root, query, opts = {}) => { calls.push({ query, opts }); return recall(query, opts); },
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    ...over,
  };
  return { deps, spy, calls };
}

const events = (cache: string): HookEvent[] =>
  readFileSync(eventLogPath(cache), "utf-8").split("\n").filter(l => l.trim() !== "").map(l => JSON.parse(l) as HookEvent);

describe("probe query building", () => {
  // covers: SC-59
  test("head tokens survive wrappers, env assignments and the script connective, and lead the query", () => {
    expect(headTokens("sudo rtk npm run build")).toEqual(["npm", "build"]);
    expect(headTokens("FOO=1 git push origin main")).toEqual(["git", "push"]);
    expect(buildProbeQuery("sudo rtk npm run build", "Exit code 1\ntsc emitted errors").slice(0, 2))
      .toEqual(["npm", "build"]);
  });

  // covers: SC-60
  test("errorLine drops the exit-code header and blank lines, caps at 200, and is empty for a header-only error", () => {
    expect(errorLine("Exit code 1\n\nError: Cannot find module 'express'"))
      .toBe("Error: Cannot find module 'express'");
    expect(errorLine("Exit code 1")).toBe("");
    expect(errorLine(`Exit code 2\n${"x".repeat(300)}`)).toHaveLength(PROBE_ERROR_LINE_CAP);
    expect(buildProbeQuery("", "Exit code 1")).toEqual([]);
  });

  // covers: SC-60
  test("query filters drop hashes, bare numbers and whole path words, dedupe, and cap at eight tokens", () => {
    const q = buildProbeQuery("npm ci", "Exit code 1\ndeadbeef abc1234 abc123 jdk21 42 /x/y/z npm");
    expect(q).toEqual(["npm", "ci", "abc123", "jdk21"]);
    expect(buildProbeQuery("npm ci", "Exit code 1\ncannot read src/api/user.ts"))
      .toEqual(["npm", "ci", "cannot", "read"]);
    const many = buildProbeQuery("mvn verify", `Exit code 1\n${Array.from({ length: 20 }, (_, i) => `word${String.fromCharCode(97 + i)}`).join(" ")}`);
    expect(many).toHaveLength(PROBE_MAX_TOKENS);
  });

  // covers: SC-61
  test("probeKey is stable per head+line and changes with either", () => {
    expect(probeKey(["npm", "ci"], "boom")).toBe(probeKey(["npm", "ci"], "boom"));
    expect(probeKey(["npm", "ci"], "boom")).not.toBe(probeKey(["npm", "ci"], "bang"));
    expect(probeKey(["npm", "ci"], "boom")).not.toBe(probeKey(["npm", "test"], "boom"));
  });
});

describe("runProbe", () => {
  let root: string, cache: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-probe-"));
    cache = await mkdtemp(join(tmpdir(), "qmemd-probec-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  const okRecall: RecallFn = async () => result([hit("a")]);

  // covers: SC-61
  test("a non-Bash tool, an interrupt, an empty error, an own-subject command and a header-only error stay silent without opening the store", async () => {
    const { deps, spy } = harness(root, cache, okRecall);
    expect(await runProbe(evt({ tool_name: "Read" }), deps)).toBeNull();
    expect(await runProbe(evt({ is_interrupt: true }), deps)).toBeNull();
    expect(await runProbe(evt({ error: "   " }), deps)).toBeNull();
    expect(await runProbe(evt({ tool_input: { command: "rtk qmemd recall x" } }), deps)).toBeNull();
    expect(await runProbe(evt({ tool_input: { command: "br ready" } }), deps)).toBeNull();
    expect(await runProbe(evt({ error: "Exit code 1", tool_input: { command: "" } }), deps)).toBeNull();
    expect(spy.opens).toBe(0);
  });

  // covers: SC-61
  test("an identical failure probes once per session; a different error line probes again", async () => {
    const { deps, spy } = harness(root, cache, async () => result([]));
    await runProbe(evt(), deps);
    await runProbe(evt(), deps);
    expect(spy.opens).toBe(1);
    await runProbe(evt({ error: "Exit code 1\nnpm ERR! network timeout" }), deps);
    expect(spy.opens).toBe(2);
  });

  // covers: SC-61
  test("probedKeys is capped at SURFACED_CAP, oldest out", async () => {
    const path = stateFilePath(cache, "s1");
    const old = Array.from({ length: SURFACED_CAP }, (_, i) => `key${i}`);
    writeState(path, st({ probedKeys: old }));
    const { deps } = harness(root, cache, async () => result([]));
    await runProbe(evt(), deps);
    const keys = readState(path)!.probedKeys;
    expect(keys).toHaveLength(SURFACED_CAP);
    expect(keys).not.toContain("key0");
    expect(keys.at(-1)).toBe(probeKey(["npm", "ci"], "npm ERR! ERESOLVE unable to resolve dependency tree"));
  });

  // covers: SC-62
  test("the search is lex-only, skimmed, scoped to the repo and widened by the surfaced set", async () => {
    writeState(stateFilePath(cache, "s1"), st({ surfacedSlugs: ["x", "y"] }));
    const { deps, calls } = harness(root, cache, async () => result([]));
    await runProbe(evt(), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe("npm ci err eresolve unable resolve dependency tree");
    expect(calls[0].opts).toEqual({ lexOnly: true, skim: true, limit: 5, project: "repo-a" });
  });

  // covers: SC-63
  test("already-surfaced hits are filtered before the three-hit slice, and the block names the rest", async () => {
    writeState(stateFilePath(cache, "s1"), st({ surfacedSlugs: ["a", "b"] }));
    const { deps } = harness(root, cache, async () => result(["a", "b", "c", "d", "e"].map(s => hit(s))));
    const block = await runProbe(evt(), deps);
    expect(block).toBe([
      "💡 qmemd · repo-a — this failure may be documented:",
      "   [project] desc c (c)",
      "   [project] desc d (d)",
      "   [project] desc e (e)",
      "   → qmemd show c for the full fact",
    ].join("\n"));
    expect(readState(stateFilePath(cache, "s1"))!.surfacedSlugs).toEqual(["a", "b", "c", "d", "e"]);
  });

  // covers: SC-63
  // covers: INV-7
  test("a probe whose every hit is already surfaced is silent, and a probe-surfaced slug never returns", async () => {
    const { deps } = harness(root, cache, async () => result([hit("a")]));
    expect(await runProbe(evt(), deps)).toContain("(a)");
    expect(await runProbe(evt({ error: "Exit code 1\nnpm ERR! network timeout" }), deps)).toBeNull();
  });

  // covers: SC-64
  test("an openStore rejection, a recall rejection and unparsable stdin all yield null; a rejected recall still closes", async () => {
    const failOpen = harness(root, cache, okRecall, { openStore: async () => { throw new Error("no store"); } });
    expect(await runProbe(evt(), failOpen.deps)).toBeNull();
    const failRecall = harness(root, cache, async () => { throw new Error("lex blew up"); });
    expect(await runProbe(evt(), failRecall.deps)).toBeNull();
    expect(failRecall.spy.closes).toBe(1);
    // A rejected search still counts as run: the repeat is throttled, not retried (R-13).
    expect(await runProbe(evt(), failRecall.deps)).toBeNull();
    expect(failRecall.spy.opens).toBe(1);
    expect(events(cache).filter(e => e.kind === "probe")).toHaveLength(1);
    const { deps, spy } = harness(root, cache, okRecall);
    expect(await runProbe("not json", deps)).toBeNull();
    expect(spy.opens).toBe(0);
  });

  // covers: SC-64
  test("a recall that never resolves times out to null and still closes the store", async () => {
    const { deps, spy } = harness(root, cache, () => new Promise<RecallResult>(() => {}), { timeoutMs: 20 });
    expect(await runProbe(evt(), deps)).toBeNull();
    expect(spy.closes).toBe(1);
  });

  // covers: INV-4
  test("a throw in the post-search accounting resolves null instead of rejecting", async () => {
    const { deps, spy } = harness(root, cache, okRecall, { now: () => { throw new Error("clock gone"); } });
    await expect(runProbe(evt(), deps)).resolves.toBeNull();
    expect(spy.closes).toBe(1);
  });

  // covers: SC-70
  test("a probe with hits logs slugs and the query; a probe without hits logs the query alone", async () => {
    const withHits = harness(root, cache, async () => result([hit("a")]));
    await runProbe(evt(), withHits.deps);
    expect(events(cache)).toEqual([{
      v: 1, ts: "2026-09-03T10:00:00.000Z", session: "s1", repo: "repo-a", kind: "probe",
      query: "npm ci err eresolve unable resolve dependency tree", slugs: ["a"],
    }]);
    const noHits = harness(root, cache, async () => result([]));
    await runProbe(evt({ error: "Exit code 1\nnpm ERR! network timeout" }), noHits.deps);
    expect(events(cache)[1]).toEqual({
      v: 1, ts: "2026-09-03T10:00:00.000Z", session: "s1", repo: "repo-a", kind: "probe",
      query: "npm ci err network timeout",
    });
  });

  // covers: INV-5
  test("neither the block nor the event carries the hit's filesystem path", async () => {
    const { deps } = harness(root, cache, async () => result([hit("a", { path: "/home/secret/memory/project/a.md" })]));
    const block = await runProbe(evt(), deps);
    expect(block).not.toContain("/home/secret");
    expect(readFileSync(eventLogPath(cache), "utf-8")).not.toContain("/home/secret");
  });
});

describe("formatProbe", () => {
  // covers: SC-63
  test("renders the header, one line per fact and a single show tail for the top hit", () => {
    const block = formatProbe("repo-a", [
      { type: "project", description: "one", slug: "s1" },
      { type: "reference", description: "two", slug: "s2" },
    ]);
    expect(block.split("\n")).toEqual([
      "💡 qmemd · repo-a — this failure may be documented:",
      "   [project] one (s1)",
      "   [reference] two (s2)",
      "   → qmemd show s1 for the full fact",
    ]);
  });
});
