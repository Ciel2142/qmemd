import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mapCachePath, corpusFingerprint, buildTokenMap, loadOrBuildTokenMap,
  stripWrappers, isOwnSubjectCommand, commandTokens, matchCommand,
  formatFactLine, formatOverlap,
  OVERLAP_SLUG_HEAD_TOKENS, OVERLAP_COMMAND_TOKEN_CAP, OVERLAP_COMMAND_STOPLIST,
  type TokenMap, type OverlapHit,
} from "../src/overlap.js";
import { serializeMemory, tokenizeForDedup, type MemoryFrontmatter, type MemoryType } from "../src/engine.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

interface FactOpts { project?: string; tags?: string[]; supersededBy?: string }

async function writeFact(root: string, type: MemoryType, slug: string, opts: FactOpts = {}): Promise<void> {
  await mkdir(join(root, type), { recursive: true });
  const fm: MemoryFrontmatter = {
    name: slug,
    description: `fact ${slug}`,
    type,
    tags: opts.tags ?? [],
    project: opts.project ?? "global",
    created: "2026-06-10",
    pinned: false,
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
  };
  await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, `body for ${slug}`));
}

function makeMap(entries: Record<string, string[]>, opts: { project?: string } = {}): TokenMap {
  const facts: TokenMap["facts"] = {};
  const tokens: Record<string, string[]> = {};
  for (const [slug, toks] of Object.entries(entries)) {
    facts[slug] = { type: "project", description: `desc ${slug}`, project: opts.project ?? "repo-a" };
    for (const t of toks) (tokens[t] ??= []).push(slug);
  }
  return { version: 1, fingerprint: "fp", project: opts.project ?? "repo-a", facts, tokens };
}

function fixture100(): TokenMap {
  const entries: Record<string, string[]> = {
    "sig-a": ["gadget", "gizmo"],
    "sig-b": ["gadget"],
    "sig-c": ["gadget"],
    "gz-b": ["gizmo"],
    "gz-c": ["gizmo"],
    "noise-a": ["widget", "gizmo2"],
    "noise-b": ["widget"],
    "noise-c": ["widget"],
    "noise-d": ["widget"],
    "gizmo2-b": ["gizmo2"],
    "stop-a": ["test", "helper2", "helper3"],
  };
  for (let i = 0; Object.keys(entries).length < 100; i++) entries[`filler-${i}`] = [`uniq${i}`];
  return makeMap(entries);
}

describe("overlap module", () => {
  let root: string;
  let cacheDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmemd-overlap-root-"));
    cacheDir = await mkdtemp(join(tmpdir(), "qmemd-overlap-cache-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  // covers: SC-47
  test("buildTokenMap scopes to repo+global project/reference facts, tokenizing tags∪slug-head, skipping superseded and user facts; cache is keyed by repo", async () => {
    await writeFact(root, "project", "alpha-widget", { project: "repo-a", tags: ["Gadget", "jdk21"] });
    await writeFact(root, "project", "beta-thing", { project: "repo-b", tags: ["other"] });
    await writeFact(root, "reference", "global-doc", { project: "global", tags: ["shared"] });
    await writeFact(root, "user", "user-pref", { project: "global", tags: ["ignored"] });
    await writeFact(root, "project", "old-fact", { project: "repo-a", tags: ["supertag"], supersededBy: "alpha-widget" });

    const map = buildTokenMap(root, "repo-a");

    expect(Object.keys(map.facts).sort()).toEqual(["alpha-widget", "global-doc"]);
    expect(map.facts["alpha-widget"]).toEqual({ type: "project", description: "fact alpha-widget", project: "repo-a" });
    const expectedTokens = new Set([...tokenizeForDedup("alpha-widget"), ...tokenizeForDedup("Gadget"), ...tokenizeForDedup("jdk21")]);
    for (const t of expectedTokens) expect(map.tokens[t]).toContain("alpha-widget");
    expect(map.tokens["other"]).toBeUndefined();
    expect(map.tokens["ignored"]).toBeUndefined();
    expect(map.tokens["supertag"]).toBeUndefined();

    const cacheA = mapCachePath(cacheDir, root, "repo-a");
    const cacheB = mapCachePath(cacheDir, root, "repo-b");
    expect(cacheA).not.toBe(cacheB);
    loadOrBuildTokenMap(cacheA, root, "repo-a", true);
    loadOrBuildTokenMap(cacheB, root, "repo-b", true);
    expect(existsSync(cacheA)).toBe(true);
    expect(existsSync(cacheB)).toBe(true);
  });

  // covers: SC-47
  test("buildTokenMap takes only the first OVERLAP_SLUG_HEAD_TOKENS of a tokenized slug, not the whole slug", async () => {
    expect(OVERLAP_SLUG_HEAD_TOKENS).toBe(4);
    await writeFact(root, "project", "alpha-bravo-charlie-delta-echo-foxtrot", { project: "repo-a", tags: [] });

    const map = buildTokenMap(root, "repo-a");
    const slug = "alpha-bravo-charlie-delta-echo-foxtrot";
    const headTokens = tokenizeForDedup(slug).slice(0, OVERLAP_SLUG_HEAD_TOKENS);
    for (const t of headTokens) expect(map.tokens[t]).toContain(slug);
    for (const t of tokenizeForDedup(slug).slice(OVERLAP_SLUG_HEAD_TOKENS)) expect(map.tokens[t]).toBeUndefined();
  });

  // covers: SC-48
  test("unchanged fingerprint returns the cached map without a corpus walk", async () => {
    await writeFact(root, "project", "fact-one", { project: "repo-a", tags: ["alpha"] });
    const cachePath = mapCachePath(cacheDir, root, "repo-a");
    const built = loadOrBuildTokenMap(cachePath, root, "repo-a", true);
    expect(built.tokens["alpha"]).toContain("fact-one");

    // same file, same dir mtime + entry count → fingerprint unchanged
    await writeFact(root, "project", "fact-one", { project: "repo-a", tags: ["zzz"] });
    const reused = loadOrBuildTokenMap(cachePath, root, "repo-a", false);
    expect(reused.tokens["alpha"]).toContain("fact-one");
    expect(reused.tokens["zzz"]).toBeUndefined();
  });

  // covers: SC-48
  test("force, a changed fingerprint, or a missing cache file each trigger a rebuild", async () => {
    await writeFact(root, "project", "fact-one", { project: "repo-a", tags: ["alpha"] });
    const cachePath = mapCachePath(cacheDir, root, "repo-a");

    const first = loadOrBuildTokenMap(cachePath, root, "repo-a", false);
    expect(first.tokens["alpha"]).toContain("fact-one");
    expect(existsSync(cachePath)).toBe(true);

    await writeFact(root, "project", "fact-one", { project: "repo-a", tags: ["zzz"] });
    const forced = loadOrBuildTokenMap(cachePath, root, "repo-a", true);
    expect(forced.tokens["zzz"]).toContain("fact-one");
    expect(forced.tokens["alpha"]).toBeUndefined();

    await writeFact(root, "project", "fact-two", { project: "repo-a", tags: ["beta"] });
    const afterAdd = loadOrBuildTokenMap(cachePath, root, "repo-a", false);
    expect(afterAdd.tokens["beta"]).toContain("fact-two");
  });

  // covers: SC-48
  test("corpusFingerprint changes only for project/reference dirs, not user/", async () => {
    await writeFact(root, "project", "p1", { project: "repo-a" });
    const before = corpusFingerprint(root);
    await writeFact(root, "user", "u1", { project: "global" });
    expect(corpusFingerprint(root)).toBe(before);
    await writeFact(root, "reference", "r1", { project: "global" });
    expect(corpusFingerprint(root)).not.toBe(before);
  });

  // covers: SC-49
  test("a corrupt or wrong-version cache file rebuilds without throwing", async () => {
    await writeFact(root, "project", "fact-one", { project: "repo-a", tags: ["alpha"] });
    const cachePath = mapCachePath(cacheDir, root, "repo-a");
    mkdirSync(dirname(cachePath), { recursive: true });

    writeFileSync(cachePath, "{");
    expect(() => loadOrBuildTokenMap(cachePath, root, "repo-a", false)).not.toThrow();
    const rebuilt1 = loadOrBuildTokenMap(cachePath, root, "repo-a", false);
    expect(rebuilt1.tokens["alpha"]).toContain("fact-one");
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).version).toBe(1);

    writeFileSync(cachePath, JSON.stringify({ version: 2, project: "repo-a", fingerprint: "x", facts: {}, tokens: {} }));
    const rebuilt2 = loadOrBuildTokenMap(cachePath, root, "repo-a", false);
    expect(rebuilt2.tokens["alpha"]).toContain("fact-one");
  });

  // covers: SC-51
  test("stripWrappers drops env assignments and wrapper words; commandTokens normalises basenames and flags", () => {
    const tokens = commandTokens("FOO=1 BAR=2 sudo rtk npx --no-install ./scripts/run.sh --flag /usr/bin/kubectl");
    for (const t of ["run.sh", "kubectl", "install", "flag"]) expect(tokens).toContain(t);
    for (const t of ["foo", "bar", "1", "2", "sudo", "rtk", "npx", "scripts", "usr", "bin"]) expect(tokens).not.toContain(t);

    expect(commandTokens("time nice npm test")).toEqual(["npm", "test"]);
  });

  // covers: SC-52
  test("own-subject commands (word-boundary exact) skip; a prefix name does not", () => {
    for (const cmd of ['rtk qmemd recall "x"', "br ready", "sudo br close q-1"]) {
      expect(isOwnSubjectCommand(cmd)).toBe(true);
      expect(commandTokens(cmd)).toEqual([]);
    }
    expect(isOwnSubjectCommand("")).toBe(false);
    expect(commandTokens("")).toEqual([]);
    expect(isOwnSubjectCommand("qmemd-tool run")).toBe(false);
    expect(commandTokens("qmemd-tool run")).not.toEqual([]);
  });

  // covers: SC-51
  test("commandTokens cuts the command at the first heredoc marker; body tokens after it are dropped", () => {
    const tokens = commandTokens("git commit -F - <<'EOF'\nlegitimate keyword forgery\nEOF");
    expect(tokens).toContain("commit");
    for (const t of ["legitimate", "keyword", "forgery", "eof"]) expect(tokens).not.toContain(t);

    const dashVariant = commandTokens("cat <<-EOF\nhidden token\nEOF");
    expect(dashVariant).not.toContain("hidden");
  });

  // covers: SC-51
  test("commandTokens drops tokens shorter than 3 characters and all-digit tokens", () => {
    const tokens = commandTokens("go -f 42 to widget");
    expect(tokens).toEqual(["widget"]);
  });

  // covers: SC-51
  test("commandTokens dedupes preserving order and caps at OVERLAP_COMMAND_TOKEN_CAP tokens", () => {
    expect(OVERLAP_COMMAND_TOKEN_CAP).toBe(24);
    const words = Array.from({ length: 26 }, (_, i) => `word${i}`);
    const raw = [words[0], words[0], ...words.slice(1)]; // word0 repeated up front
    const tokens = commandTokens(raw.join(" "));
    expect(tokens.length).toBe(OVERLAP_COMMAND_TOKEN_CAP);
    expect(tokens).toEqual(words.slice(0, OVERLAP_COMMAND_TOKEN_CAP));
  });

  // covers: SC-53
  test("distinctive tokens: a stoplist token never contributes; DF cap=3 over 100 facts admits df=3, excludes df=4", () => {
    const map = fixture100();
    expect(Object.keys(map.facts).length).toBe(100);

    const capHit = matchCommand(["gadget", "gizmo"], map, new Set());
    expect(capHit.find(h => h.slug === "sig-a")).toEqual({ slug: "sig-a", score: 2, tokens: ["gadget", "gizmo"] });

    const overCap = matchCommand(["widget", "gizmo2"], map, new Set());
    expect(overCap.find(h => h.slug === "noise-a")).toBeUndefined();

    const stopHit = matchCommand(["test", "helper2", "helper3"], map, new Set());
    expect(stopHit.find(h => h.slug === "stop-a")).toEqual({ slug: "stop-a", score: 2, tokens: ["helper2", "helper3"] });
  });

  // covers: SC-53
  test("a token in OVERLAP_COMMAND_STOPLIST never contributes to score", () => {
    expect(OVERLAP_COMMAND_STOPLIST.has("gradle")).toBe(true);
    const map = makeMap({ a: ["gradle", "zzyzx"], b: ["gradle"] });

    expect(matchCommand(["gradle", "zzyzx"], map, new Set())).toEqual([]); // score 1 (zzyzx only), below min-score
  });

  // covers: SC-54
  test("fires at score >= 2; score 1 with a DF=1 token does NOT fire; each hit reports score and tokens", () => {
    const map = makeMap({ a: ["x1", "x2"], b: ["x1"], c: ["x2"], d: ["y1"], e: ["y1"], f: ["z1"] });

    expect(matchCommand(["x1", "x2"], map, new Set())).toEqual([{ slug: "a", score: 2, tokens: ["x1", "x2"] }]);
    expect(matchCommand(["y1"], map, new Set())).toEqual([]);
    expect(matchCommand(["z1"], map, new Set())).toEqual([]); // DF=1 unique token, score 1 — no longer fires (R-9d)
  });

  // covers: SC-50
  test("a query token colliding with an inherited Object.prototype name does not throw and yields no hit (R-10)", () => {
    const map = makeMap({ unrelated: ["widget"] });
    expect(() => matchCommand(["constructor", "toString", "hasOwnProperty", "foo"], map, new Set())).not.toThrow();
    expect(matchCommand(["constructor", "toString", "hasOwnProperty", "foo"], map, new Set())).toEqual([]);
  });

  // covers: SC-55
  test("exclusion applies before ranking; results order score desc then slug asc, sliced to 3", () => {
    const map = makeMap({
      top: ["t1", "t2", "t3", "t4", "t5"],
      second: ["u1", "u2", "u3", "u4"],
      third: ["v1", "v2", "v3"],
      fourth: ["w1", "w2", "w3"],
      fifth: ["y1", "y2"],
    });
    const allTokens = ["t1", "t2", "t3", "t4", "t5", "u1", "u2", "u3", "u4", "v1", "v2", "v3", "w1", "w2", "w3", "y1", "y2"];

    const hits = matchCommand(allTokens, map, new Set(["top"]));
    expect(hits.map(h => h.slug)).toEqual(["second", "fourth", "third"]);
    expect(hits.map(h => h.score)).toEqual([4, 3, 3]);

    expect(matchCommand([], map, new Set())).toEqual([]);
    const emptyMap: TokenMap = { version: 1, fingerprint: "fp", project: "repo-a", facts: {}, tokens: {} };
    expect(matchCommand(["t1"], emptyMap, new Set())).toEqual([]);
  });

  // covers: SC-56
  test("formatOverlap renders the header, one fact line per hit, and a single show-tail naming the top slug", () => {
    const map: TokenMap = {
      version: 1, fingerprint: "fp", project: "repo-a",
      facts: {
        "alpha-fact": { type: "project", description: "A short fact about alpha.", project: "repo-a" },
        "beta-fact": { type: "reference", description: "x".repeat(150), project: "global" },
      },
      tokens: {},
    };
    const hits: OverlapHit[] = [
      { slug: "alpha-fact", score: 3, tokens: ["alpha"] },
      { slug: "beta-fact", score: 2, tokens: ["beta"] },
    ];
    const out = formatOverlap("repo-a", hits, map);
    const lines = out.split("\n");
    expect(lines[0]).toBe("💡 qmemd · repo-a — facts matching this command:");
    expect(lines[1]).toBe("   [project] A short fact about alpha. (alpha-fact)");
    expect(lines[2]).toBe(`   [reference] ${"x".repeat(120)}… (beta-fact)`);
    expect(lines[3]).toBe("   → qmemd show alpha-fact for the full fact");
    expect(lines.length).toBe(4);
  });

  // covers: SC-56
  test("formatFactLine has no trailing ellipsis for a description at or under the cap", () => {
    const short: import("../src/overlap.js").FactLine = { type: "project", description: "short desc", slug: "s" };
    expect(formatFactLine(short)).toBe("   [project] short desc (s)");
  });
});
