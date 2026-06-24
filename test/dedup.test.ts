import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { dedupReport, DEDUP_REPORT_DICE } from "../src/dedup.js";
import { serializeMemory, type MemoryFrontmatter, type MemoryType } from "../src/engine.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Write a fact whose dedup compare text (name + first body line) tokenizes predictably.
// `name` doubles as the slug stem (the filename); the engine compares `name + firstLine(body)`.
async function writeFact(
  root: string,
  slug: string,
  opts: { project: string; body: string; type?: MemoryType; supersededBy?: string },
): Promise<void> {
  const type = opts.type ?? "project";
  await mkdir(join(root, type), { recursive: true });
  const fm: MemoryFrontmatter = {
    name: slug, description: opts.body, type, tags: [], project: opts.project,
    created: "2026-06-10", pinned: false,
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
  };
  await writeFile(join(root, type, slug + ".md"), serializeMemory(fm, opts.body));
}

const slugsOf = (members: { slug: string }[]) => members.map(m => m.slug).sort();

describe("dedupReport — offline within-project loose near-dup surface (qmemd-dao)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-dedup-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("surfaces a loose within-project near-dup pair the write-path Dice floor (0.82) misses", async () => {
    // facta~factb share {alpha, jdk, 21}: Dice ≈ 0.35 — below the 0.82 write floor,
    // above the 0.18 report floor. The exact alpha JDK failure rso documented.
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factb", { project: "alpha", body: "alpha requires jdk 21 real install sdkman default" });

    const report = dedupReport(root);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.project).toBe("alpha");
    expect(slugsOf(report.clusters[0]!.members)).toEqual(["facta", "factb"]);
    expect(report.clusters[0]!.maxDice).toBeGreaterThanOrEqual(DEDUP_REPORT_DICE);
    expect(report.clusters[0]!.maxDice).toBeLessThan(0.82);
  });

  test("NEVER clusters same-topic facts across project buckets (the cross-repo false-merge guard)", async () => {
    // Near-identical JDK facts, different project: → must stay apart (alpha vs beta).
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factd", { project: "beta", body: "build beta jdk 21 maven lombok works" });

    expect(dedupReport(root).clusters).toEqual([]);
  });

  test("does not surface an unrelated within-project pair below the report floor", async () => {
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factc", { project: "alpha", body: "redis admin password lab acl locked anonymous noauth blocked" });

    expect(dedupReport(root).clusters).toEqual([]);
  });

  test("groups transitively-linked facts into ONE cluster (A-B edge, B-E edge, no A-E edge)", async () => {
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factb", { project: "alpha", body: "alpha requires jdk 21 real install sdkman default" });
    await writeFact(root, "facte", { project: "alpha", body: "requires sdkman zzz yyy" });

    const report = dedupReport(root);
    expect(report.clusters).toHaveLength(1);
    expect(slugsOf(report.clusters[0]!.members)).toEqual(["facta", "factb", "facte"]);
    // 2 edges (A-B, B-E) — not the absent A-E pair.
    expect(report.clusters[0]!.edges).toHaveLength(2);
    expect(report.clusters[0]!.edges.every(e => e.dice >= DEDUP_REPORT_DICE)).toBe(true);
  });

  test("excludes superseded facts — a retired near-dup never clusters", async () => {
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factf", { project: "alpha", body: "build alpha jdk 21 maven lombok works", supersededBy: "facta" });

    expect(dedupReport(root).clusters).toEqual([]);
  });

  test("threshold is overridable — a mid-similarity pair clusters at the default but not at a raised floor", async () => {
    await writeFact(root, "factg", { project: "proj", body: "alpha beta gamma delta epsilon kappa" });
    await writeFact(root, "facth", { project: "proj", body: "alpha beta zeta eta theta iota" });

    expect(dedupReport(root).clusters).toHaveLength(1);            // default 0.18 catches it
    expect(dedupReport(root, { threshold: 0.5 }).clusters).toEqual([]); // raised floor drops it
  });

  test("project filter restricts the scan to a single bucket", async () => {
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factb", { project: "alpha", body: "alpha requires jdk 21 real install sdkman default" });
    await writeFact(root, "factg", { project: "proj", body: "alpha beta gamma delta epsilon kappa" });
    await writeFact(root, "facth", { project: "proj", body: "alpha beta zeta eta theta iota" });

    const report = dedupReport(root, { project: "alpha" });
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.project).toBe("alpha");
  });

  test("clusters are sorted by maxDice descending (strongest candidates first)", async () => {
    // alpha pair ≈ 0.35; proj pair ≈ 0.29 — alpha should rank first.
    await writeFact(root, "facta", { project: "alpha", body: "build alpha jdk 21 maven lombok works" });
    await writeFact(root, "factb", { project: "alpha", body: "alpha requires jdk 21 real install sdkman default" });
    await writeFact(root, "factg", { project: "proj", body: "alpha beta gamma delta epsilon kappa" });
    await writeFact(root, "facth", { project: "proj", body: "alpha beta zeta eta theta iota" });

    const report = dedupReport(root);
    expect(report.clusters).toHaveLength(2);
    expect(report.clusters[0]!.maxDice).toBeGreaterThanOrEqual(report.clusters[1]!.maxDice);
    expect(report.clusters[0]!.project).toBe("alpha");
  });

  test("an empty corpus yields no clusters and the active threshold", async () => {
    const report = dedupReport(root);
    expect(report.clusters).toEqual([]);
    expect(report.threshold).toBe(DEDUP_REPORT_DICE);
  });
});
