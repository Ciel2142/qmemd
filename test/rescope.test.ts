import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { planRescope } from "../src/rescope.js";
import { serializeMemory, type MemoryFrontmatter, type MemoryType } from "../src/engine.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FactOpts {
  type?: MemoryType;
  project?: string;
  tags?: string[];
  pinned?: boolean;
  supersededBy?: string;
}

async function writeFact(root: string, slug: string, opts: FactOpts = {}): Promise<void> {
  const type = opts.type ?? "project";
  await mkdir(join(root, type), { recursive: true });
  const fm: MemoryFrontmatter = {
    name: slug,
    description: `fact ${slug}`,
    type,
    tags: opts.tags ?? [],
    project: opts.project ?? "global",
    created: "2026-06-10",
    pinned: opts.pinned ?? false,
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
  };
  await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, `body for ${slug}`));
}

async function writeRawFact(root: string, type: MemoryType, slug: string, content: string): Promise<void> {
  await mkdir(join(root, type), { recursive: true });
  await writeFile(join(root, type, `${slug}.md`), content);
}

describe("planRescope — planner (w2-rescope)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-rescope-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // covers: SC-32
  test("corpus + --known name resolve slug-prefix hits; global/blank facts with no match add nothing", async () => {
    await writeFact(root, "omnimailcore-anchor", { project: "OmniMailCore" });
    await writeFact(root, "omnimailcore-x", { project: "global" });
    await writeFact(root, "foo-y", { project: "global" });
    await writeFact(root, "no-match-a", { project: "global" });
    await writeFact(root, "no-match-b", { project: "" });

    const plan = planRescope(root, { known: ["Foo"] });

    expect(plan.known).toContain("OmniMailCore");
    expect(plan.known).toContain("Foo");
    expect(plan.rows.find((r) => r.slug === "omnimailcore-x")).toEqual({
      slug: "omnimailcore-x", type: "project", from: "global", to: "OmniMailCore", reason: "slug-prefix",
    });
    expect(plan.rows.find((r) => r.slug === "foo-y")).toEqual({
      slug: "foo-y", type: "project", from: "global", to: "Foo", reason: "slug-prefix",
    });
    expect(plan.rows.find((r) => r.slug === "no-match-a")).toBeUndefined();
    expect(plan.rows.find((r) => r.slug === "no-match-b")).toBeUndefined();
  });

  // covers: SC-33
  test("longest-first known-name matching for slug-prefix", async () => {
    await writeFact(root, "check-new-foo", { project: "global" });
    await writeFact(root, "check-foo", { project: "global" });
    await writeFact(root, "check", { project: "global" });
    await writeFact(root, "checknewpassport-foo", { project: "global" });

    const plan = planRescope(root, { known: ["check", "check-new"] });

    expect(plan.rows.find((r) => r.slug === "check-new-foo")?.to).toBe("check-new");
    expect(plan.rows.find((r) => r.slug === "check-foo")?.to).toBe("check");
    expect(plan.rows.find((r) => r.slug === "check")?.to).toBe("check");
    expect(plan.rows.find((r) => r.slug === "checknewpassport-foo")).toBeUndefined();
    expect(plan.unmatched).toBe(1);
  });

  // covers: SC-34
  test("tag rule matches longest-first known name across all tags, slug-prefix wins when both apply", async () => {
    await writeFact(root, "a-foo", { project: "global", tags: ["b"] });
    await writeFact(root, "zzz", { project: "global", tags: ["check", "check-new"] });
    await writeFact(root, "untagged-slug", { project: "global", tags: ["checkx"] });

    const plan = planRescope(root, { known: ["a", "check", "check-new"] });

    expect(plan.rows.find((r) => r.slug === "a-foo")).toMatchObject({ to: "a", reason: "slug-prefix" });
    expect(plan.rows.find((r) => r.slug === "zzz")).toMatchObject({ to: "check-new", reason: "tag" });
    expect(plan.rows.find((r) => r.slug === "untagged-slug")).toBeUndefined();
    expect(plan.unmatched).toBe(1);
  });

  // covers: SC-35
  test("alias resolves a scoped fact directly, and redirects slug-prefix/tag hits on the alias source", async () => {
    await writeFact(root, "qmemd-scoped-fact", { project: "qmemd" });
    await writeFact(root, "qmemd-foo", { project: "global" });
    await writeFact(root, "tagged-with-qmemd", { project: "global", tags: ["qmemd"] });

    const plan = planRescope(root, { aliases: { qmemd: "qmemd-public" } });

    expect(plan.rows.find((r) => r.slug === "qmemd-scoped-fact")).toEqual({
      slug: "qmemd-scoped-fact", type: "project", from: "qmemd", to: "qmemd-public", reason: "alias",
    });
    expect(plan.rows.find((r) => r.slug === "qmemd-foo")).toMatchObject({ to: "qmemd-public", reason: "slug-prefix" });
    expect(plan.rows.find((r) => r.slug === "tagged-with-qmemd")).toMatchObject({ to: "qmemd-public", reason: "tag" });
  });

  // covers: SC-36
  test("user/feedback types never produce rows; unaliased non-global facts produce no row; superseded/pinned globals still included", async () => {
    await writeFact(root, "widget-in-user", { type: "user", project: "global", tags: [] });
    await writeFact(root, "widget-in-feedback", { type: "feedback", project: "global", tags: [] });
    await writeFact(root, "widget-anchor", { project: "widget" });
    await writeFact(root, "already-scoped", { project: "somethingelse" });
    await writeFact(root, "widget-pinned", { project: "global", pinned: true });
    await writeFact(root, "widget-superseded", { project: "global", supersededBy: "widget-pinned" });
    await writeFact(root, "unmatched-global", { project: "global" });

    const plan = planRescope(root);

    expect(plan.rows.find((r) => r.slug === "widget-in-user")).toBeUndefined();
    expect(plan.rows.find((r) => r.slug === "widget-in-feedback")).toBeUndefined();
    expect(plan.rows.find((r) => r.slug === "already-scoped")).toBeUndefined();
    expect(plan.rows.find((r) => r.slug === "widget-pinned")).toMatchObject({ to: "widget", reason: "slug-prefix" });
    expect(plan.rows.find((r) => r.slug === "widget-superseded")).toMatchObject({ to: "widget", reason: "slug-prefix" });
    expect(plan.unmatched).toBe(1);
  });

  // covers: INV-2
  test("a resolved alias target of global/blank never becomes a row; the fact counts as unmatched instead", async () => {
    await writeFact(root, "widget-anchor", { project: "widget" });
    await writeFact(root, "widget-foo", { project: "global" });

    const plan = planRescope(root, { aliases: { widget: "Global" } });

    expect(plan.rows.some((r) => r.to.toLowerCase() === "global")).toBe(false);
    expect(plan.rows.find((r) => r.slug === "widget-foo")).toBeUndefined();
    expect(plan.unmatched).toBe(1);
  });

  // covers: SC-40
  test("a fact with no project: line rows as global; a body line reading `project: other` is not mistaken for frontmatter", async () => {
    await writeFact(root, "widget-anchor", { project: "widget" });
    await writeRawFact(
      root,
      "project",
      "widget-noproject",
      [
        "---",
        "name: widget-noproject",
        "description: fact",
        "type: project",
        "tags: []",
        "created: 2026-06-10",
        "pinned: false",
        "---",
        "",
        "body mentions project: other in prose",
        "",
      ].join("\n"),
    );

    const plan = planRescope(root);

    const row = plan.rows.find((r) => r.slug === "widget-noproject");
    expect(row).toEqual({ slug: "widget-noproject", type: "project", from: "global", to: "widget", reason: "slug-prefix" });
  });
});
