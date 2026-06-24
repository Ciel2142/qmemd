import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mergeProposal, buildMergeCommands, buildBodyUnion } from "../src/dedup.js";
import type { MergeProposalMember } from "../src/dedup.js";
import { serializeMemory, type MemoryFrontmatter, type MemoryType, type Platform } from "../src/engine.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Rich fact writer — controls tags/platforms/pinned/created so union + keeper logic is testable.
async function writeFact(
  root: string,
  slug: string,
  opts: {
    project: string; body: string; type?: MemoryType;
    tags?: string[]; platforms?: Platform[]; pinned?: boolean; created?: string; reviewBy?: string;
  },
): Promise<void> {
  const type = opts.type ?? "project";
  await mkdir(join(root, type), { recursive: true });
  const fm: MemoryFrontmatter = {
    name: slug, description: opts.body, type, tags: opts.tags ?? [], project: opts.project,
    created: opts.created ?? "2026-06-10", pinned: opts.pinned ?? false,
    ...(opts.platforms ? { platforms: opts.platforms } : {}),
    ...(opts.reviewBy ? { reviewBy: opts.reviewBy } : {}),
  };
  await writeFile(join(root, type, slug + ".md"), serializeMemory(fm, opts.body));
}

// The rso alpha JDK pair: shares {alpha, jdk, 21}, Dice ≈ 0.35 — clusters above the 0.18 floor.
const JDK_A = "build alpha jdk 21 maven lombok works";
const JDK_B = "alpha requires jdk 21 real install sdkman default";

describe("mergeProposal — agent-judge consolidation proposal (qmemd-a6e)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-merge-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("enriches each cluster member with full body + frontmatter", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, tags: ["jdk"], platforms: ["linux"], pinned: true });
    await writeFact(root, "factb", { project: "alpha", body: JDK_B, tags: ["lombok"] });

    const proposal = mergeProposal(root);
    expect(proposal.clusters).toHaveLength(1);
    const m = proposal.clusters[0]!.members;
    expect(m.map(x => x.slug)).toEqual(["facta", "factb"]); // sorted by slug
    expect(m[0]!.body).toBe(JDK_A);
    expect(m[0]!.tags).toEqual(["jdk"]);
    expect(m[0]!.platforms).toEqual(["linux"]);
    expect(m[0]!.pinned).toBe(true);
    expect(m[1]!.body).toBe(JDK_B);
    expect(m[1]!.platforms).toEqual([]); // unscoped → [] (all)
    expect(m[1]!.pinned).toBe(false);
  });

  test("unions tags across members (sorted) and ORs pinned", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, tags: ["jdk", "build"], pinned: false });
    await writeFact(root, "factb", { project: "alpha", body: JDK_B, tags: ["build", "lombok"], pinned: true });

    const c = mergeProposal(root).clusters[0]!;
    expect(c.unionTags).toEqual(["build", "jdk", "lombok"]); // deduped + sorted
    expect(c.anyPinned).toBe(true);
  });

  test("unions platforms (sorted) when every member is scoped", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, platforms: ["linux"] });
    await writeFact(root, "factb", { project: "alpha", body: JDK_B, platforms: ["macos"] });

    expect(mergeProposal(root).clusters[0]!.unionPlatforms).toEqual(["linux", "macos"]);
  });

  test("widens platforms to all ([]) when any member is unscoped", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, platforms: ["linux"] });
    await writeFact(root, "factb", { project: "alpha", body: JDK_B }); // unscoped = all

    // Narrowing to [linux] would silently stop the fact surfacing on macos/windows — data loss.
    expect(mergeProposal(root).clusters[0]!.unionPlatforms).toEqual([]);
  });

  test("suggests the keeper with the most scope (tags + platforms)", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, tags: ["jdk"] });                       // score 1
    await writeFact(root, "factb", { project: "alpha", body: JDK_B, tags: ["jdk", "build"], platforms: ["linux"] }); // score 3

    expect(mergeProposal(root).clusters[0]!.suggestedKeeper).toBe("factb");
  });

  test("breaks a scope tie by longer body", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A + " extra detail here" }); // longer, score 0
    await writeFact(root, "factb", { project: "alpha", body: JDK_B });                        // score 0

    expect(mergeProposal(root).clusters[0]!.suggestedKeeper).toBe("facta");
  });

  test("builds the replace+forget verb skeleton with unioned scope + pin", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, tags: ["jdk", "build"], platforms: ["linux"], pinned: true }); // score 3 → keeper
    await writeFact(root, "factb", { project: "alpha", body: JDK_B, tags: ["build"], platforms: ["linux"] });                       // score 2
    await writeFact(root, "factc", { project: "alpha", body: "alpha jdk 21 lombok annotation processing", tags: ["jdk"], platforms: ["linux"] }); // score 2

    const c = mergeProposal(root).clusters[0]!;
    const [replace, forget] = buildMergeCommands(c);
    expect(c.suggestedKeeper).toBe("facta");
    expect(replace).toContain("qmemd remember --replace facta");
    expect(replace).toContain("--tags build,jdk"); // union {jdk,build} sorted
    expect(replace).toContain("--platforms linux"); // all scoped → union stays ["linux"]
    expect(replace).toContain("--pin");             // facta pinned → anyPinned
    expect(forget).toBe("qmemd forget factb factc");
  });

  test("emits --platforms \"\" (clear→all) when the union is widest", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, platforms: ["linux"] });
    await writeFact(root, "factb", { project: "alpha", body: JDK_B }); // unscoped → union = [] (all)

    const [replace] = buildMergeCommands(mergeProposal(root).clusters[0]!);
    expect(replace).toContain(`--platforms ""`);
  });

  test("acceptance: a 5-fact cluster surfaces every member's unique datum (no loss)", async () => {
    // A bd-close-style cluster: 5 facts, same topic + project, each with one unique detail.
    const facts: Record<string, string> = {
      bd1: "qmemd repo bd close broken depends_on_id schema error rolls back",
      bd2: "qmemd repo bd close broken workaround edit issues jsonl directly",
      bd3: "qmemd repo bd close broken use bd update status closed instead",
      bd4: "qmemd repo bd close broken blocker check query missing deps column",
      bd5: "qmemd repo bd close broken jsonl is the durable source of truth",
    };
    for (const [slug, body] of Object.entries(facts)) {
      await writeFact(root, slug, { project: "qmemd", body, tags: ["bd", "close"] });
    }

    const proposal = mergeProposal(root);
    expect(proposal.clusters).toHaveLength(1);
    const c = proposal.clusters[0]!;
    expect(c.members).toHaveLength(5);
    // Every unique datum is present across the surfaced member bodies — nothing dropped.
    for (const unique of ["depends_on_id", "jsonl directly", "status closed", "deps column", "source of truth"]) {
      expect(c.members.some(m => m.body.includes(unique))).toBe(true);
    }
    expect(facts[c.suggestedKeeper]).toBeDefined(); // keeper is one of the cluster
    expect(c.unionTags).toEqual(["bd", "close"]);
  });

  test("no member leaks an absolute filesystem path", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A });
    await writeFact(root, "factb", { project: "alpha", body: JDK_B });

    const json = JSON.stringify(mergeProposal(root));
    expect(json).not.toContain(root);                          // tmp dir never embedded
    expect(json).not.toContain('"path"');                      // no path field on members
  });
});

// Minimal member literal — only slug + body matter to buildBodyUnion.
const mkMember = (slug: string, body: string): MergeProposalMember => ({
  slug, type: "project", description: body, body, tags: [], platforms: [], pinned: false, created: "2026-06-10",
});

describe("buildBodyUnion — subtractive-fold scaffold (qmemd-5so)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-merge-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("keeper's lines come first, then other members' novel lines", () => {
    const members = [mkMember("a", "alpha\nshared"), mkMember("b", "shared\nbeta")];
    expect(buildBodyUnion(members, "b")).toBe("shared\nbeta\nalpha");
  });

  test("deduplicates identical lines by trimmed match (first occurrence wins)", () => {
    const members = [mkMember("a", "keep\n  dup  "), mkMember("b", "dup\nextra")];
    expect(buildBodyUnion(members, "a")).toBe("keep\n  dup  \nextra");
  });

  test("collapses consecutive blank lines and trims leading/trailing blanks", () => {
    const members = [mkMember("a", "\n\nx\n\n"), mkMember("b", "\ny\n")];
    expect(buildBodyUnion(members, "a")).toBe("x\n\ny");
  });

  test("is deterministic across calls", () => {
    const members = [mkMember("a", "one\ntwo"), mkMember("b", "two\nthree")];
    expect(buildBodyUnion(members, "a")).toBe(buildBodyUnion(members, "a"));
  });

  test("mergeProposal exposes draftBody as the keeper-first superset", async () => {
    await writeFact(root, "facta", { project: "alpha", body: JDK_A, tags: ["jdk"], platforms: ["linux"] }); // keeper (most scope)
    await writeFact(root, "factb", { project: "alpha", body: JDK_B });

    const c = mergeProposal(root).clusters[0]!;
    expect(c.draftBody.startsWith(JDK_A)).toBe(true);          // keeper spine first
    expect(c.draftBody).toContain("sdkman");                   // factb's novel content present
    for (const tok of ["maven", "lombok", "sdkman", "install"]) expect(c.draftBody).toContain(tok);
  });
});
