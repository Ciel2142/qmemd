import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mergeProposal } from "../src/dedup.js";
import { mergeLossCheck, applyMerge, serializeMemory, getFact, type MemoryFrontmatter } from "../src/engine.js";
import { type QMDStore } from "@tobilu/qmd";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mergeLossCheck — token-diff data-loss guard (qmemd-4aa)", () => {
  test("flags a vanished identifier token as BLOCKING (the JDK-8321319 case)", () => {
    const sources = [{ slug: "a", text: "root cause is jdk-8321319 not lombok" }];
    const loss = mergeLossCheck(sources, "root cause is lombok");
    expect(loss.lostIdentifiers.map(l => l.token)).toContain("8321319"); // tokenizer splits on '-'; the digit-bearing part is the blocking id
    expect(loss.lostIdentifiers[0]!.slug).toBe("a");
  });

  test("classifies a vanished prose token as non-blocking noise", () => {
    const sources = [{ slug: "a", text: "qmemd uses port 6379 for redis" }];
    const loss = mergeLossCheck(sources, "redis on port 6379"); // 'uses' dropped (rephrase)
    expect(loss.lostIdentifiers).toEqual([]);                    // 6379 kept → no block
    expect(loss.lostProse.map(l => l.token)).toContain("uses");
  });

  test("no loss when the fold contains every source identifier", () => {
    const sources = [{ slug: "a", text: "jdk 21 port 9092" }, { slug: "b", text: "jdk 21 sasl" }];
    const loss = mergeLossCheck(sources, "jdk 21 port 9092 sasl auth");
    expect(loss.lostIdentifiers).toEqual([]);
  });

  test("attributes each lost token to its source slug and dedupes within a source", () => {
    const sources = [{ slug: "x", text: "8321319 8321319 widget" }];
    const loss = mergeLossCheck(sources, "nothing here");
    expect(loss.lostIdentifiers).toEqual([{ slug: "x", token: "8321319" }]); // once, not twice
  });

  test("handles empty sources", () => {
    expect(mergeLossCheck([], "anything")).toEqual({ lostIdentifiers: [], lostProse: [] });
  });
});

// Minimal fake store: update() is a no-op spy; missing `.internal` is swallowed by
// applyMerge's best-effort reindex try/catch (mirrors forget).
const okStore = () => ({ async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore);

async function writeFact(root: string, slug: string, body: string, project = "alpha", tags: string[] = ["jdk"]): Promise<void> {
  await mkdir(join(root, "project"), { recursive: true });
  const fm: MemoryFrontmatter = { name: slug, description: body.split("\n")[0]!, type: "project", tags, project, created: "2026-06-10", pinned: false };
  await writeFile(join(root, "project", slug + ".md"), serializeMemory(fm, body));
}

describe("applyMerge — atomic merge transaction (qmemd-3fb)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-apply-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("rewrites the keeper, deletes the others, applies union scope", async () => {
    await writeFact(root, "facta", "alpha jdk 21 maven works", "alpha", ["jdk", "build"]);
    await writeFact(root, "factb", "alpha jdk 21 sdkman install", "alpha", ["jdk", "sdkman"]);
    const cluster = mergeProposal(root).clusters[0]!;

    const res = await applyMerge(okStore(), root, { cluster, foldedBody: "alpha jdk 21 maven sdkman install works" });

    expect(res.retired).toEqual(cluster.members.map(m => m.slug).filter(s => s !== res.keeper));
    expect(existsSync(join(root, "project", res.keeper + ".md"))).toBe(true);
    for (const s of res.retired) expect(existsSync(join(root, "project", s + ".md"))).toBe(false);
    const kept = getFact(root, res.keeper)!;
    expect(kept.body.trim()).toBe("alpha jdk 21 maven sdkman install works"); // parsed body round-trips with a trailing newline
    expect(kept.frontmatter.tags).toEqual(["build", "jdk", "sdkman"]); // union, sorted
    expect(kept.frontmatter.created).toBe("2026-06-10");               // preserved
    expect(kept.frontmatter.updated).toBeTruthy();                     // bumped
  });

  test("blocks (throws, corpus untouched) when a folded body drops an identifier", async () => {
    await writeFact(root, "facta", "root cause is jdk-8321319 not lombok");
    await writeFact(root, "factb", "alpha jdk-8321319 build fails");
    const cluster = mergeProposal(root).clusters[0]!;
    const before = cluster.members.map(m => readFileSync(getFact(root, m.slug)!.path, "utf-8"));

    await expect(applyMerge(okStore(), root, { cluster, foldedBody: "root cause is lombok build fails" }))
      .rejects.toThrow(/identifier token/);
    // corpus byte-identical: nothing written, nothing deleted
    cluster.members.forEach((m, i) => expect(readFileSync(getFact(root, m.slug)!.path, "utf-8")).toBe(before[i]));
  });

  test("--force overrides an identifier-loss block", async () => {
    await writeFact(root, "facta", "uses jdk-8321319 here");
    await writeFact(root, "factb", "alpha jdk-8321319 detail");
    const cluster = mergeProposal(root).clusters[0]!;

    const res = await applyMerge(okStore(), root, { cluster, foldedBody: "merged without the id" }, { force: true });
    expect(res.loss.lostIdentifiers.length).toBeGreaterThan(0);
    expect(existsSync(join(root, "project", res.keeper + ".md"))).toBe(true);
  });

  test("rejects an invalid plan (keeper not a member; missing member) untouched", async () => {
    await writeFact(root, "facta", "alpha jdk 21 maven");
    await writeFact(root, "factb", "alpha jdk 21 sdkman");
    const cluster = mergeProposal(root).clusters[0]!;

    await expect(applyMerge(okStore(), root, { cluster, foldedBody: "x", keeper: "ghost" }))
      .rejects.toThrow(/keeper/);
    // a member that vanished after the proposal
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(join(root, "project", "factb.md"));
    await expect(applyMerge(okStore(), root, { cluster, foldedBody: "x" }))
      .rejects.toThrow(/no longer exists/);
  });

  test("commits the whole fold in exactly ONE commit", async () => {
    await writeFact(root, "facta", "alpha jdk 21 maven");
    await writeFact(root, "factb", "alpha jdk 21 sdkman");
    await writeFact(root, "factc", "alpha jdk 21 lombok");
    const cluster = mergeProposal(root).clusters[0]!;
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return 0; // a repo
      if (args[0] === "rev-parse") return 1; // no upstream
      if (args[0] === "diff") return 1;      // staged
      return 0;
    };
    await applyMerge(okStore(), root, { cluster, foldedBody: "alpha jdk 21 maven sdkman lombok" }, {}, { run });
    expect(calls.filter(a => a[0] === "commit")).toHaveLength(1); // one atomic commit, not three
  });

  test("acceptance: the 5-fact bd-close cluster collapses to one fact, every datum kept", async () => {
    const facts: Record<string, string> = {
      bd1: "qmemd repo bd close broken depends_on_id schema error rolls back",
      bd2: "qmemd repo bd close broken workaround edit issues jsonl directly",
      bd3: "qmemd repo bd close broken use bd update status closed instead",
      bd4: "qmemd repo bd close broken blocker check query missing deps column",
      bd5: "qmemd repo bd close broken jsonl is the durable source of truth",
    };
    for (const [slug, body] of Object.entries(facts)) await writeFact(root, slug, body, "qmemd", ["bd", "close"]);
    const cluster = mergeProposal(root).clusters[0]!;
    // Agent "edits down" — here the superset draft itself is already lossless.
    const res = await applyMerge(okStore(), root, { cluster, foldedBody: cluster.draftBody });

    expect(res.retired).toHaveLength(4);
    expect(res.loss.lostIdentifiers).toEqual([]);
    const kept = getFact(root, res.keeper)!;
    for (const datum of ["depends_on_id", "jsonl", "status closed", "deps column", "source of truth"]) {
      expect(kept.body).toContain(datum);
    }
    for (const s of res.retired) expect(existsSync(join(root, "project", s + ".md"))).toBe(false);
  });
});
