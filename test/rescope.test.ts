import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { planRescope, applyRescope, setProjectLine, isRescopePlan, type RescopePlan, type RescopeRow } from "../src/rescope.js";
import { serializeMemory, type MemoryFrontmatter, type MemoryType } from "../src/engine.js";
import type { QMDStore } from "@tobilu/qmd";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

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

    const plan = planRescope(root, { known: ["a", "b", "check", "check-new"] });

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

describe("setProjectLine — surgical project: rewrite (w2-rescope)", () => {
  // covers: SC-38
  test("replaces the value on the first project: line inside the fences, leaving every other line untouched", () => {
    const content = ["---", "name: n", "project: global", "type: project", "---", "", "body", ""].join("\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "name: n", "project: widget", "type: project", "---", "", "body", ""].join("\n"));
  });

  // covers: SC-38
  test("a body line that is itself `project: other` (outside the fences) is not mistaken for the frontmatter line", () => {
    const content = ["---", "name: n", "type: project", "---", "", "project: other", ""].join("\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "name: n", "type: project", "project: widget", "---", "", "project: other", ""].join("\n"));
  });

  // covers: SC-38
  test("preserves the original key spelling, colon spacing, and CRLF line ending; only the value span changes", () => {
    const crlf = "---\r\nname: n\r\nProject:   global\r\ntype: project\r\n---\r\n\r\nbody\r\n";
    const out = setProjectLine(crlf, "widget");
    expect(out).toBe("---\r\nname: n\r\nProject:   widget\r\ntype: project\r\n---\r\n\r\nbody\r\n");
  });

  // covers: SC-38, INV-3
  test("a blank CRLF value: the \\r is not swallowed into the pre-colon spacing capture", () => {
    const crlf = "---\r\nname: n\r\nproject:\r\ntype: project\r\n---\r\n\r\nbody\r\n";
    const out = setProjectLine(crlf, "widget");
    expect(out).toBe("---\r\nname: n\r\nproject:widget\r\ntype: project\r\n---\r\n\r\nbody\r\n");
  });

  // covers: SC-38, INV-3
  test("a blank LF value with no space after the colon", () => {
    const content = ["---", "name: n", "project:", "type: project", "---", "", "body", ""].join("\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "name: n", "project:widget", "type: project", "---", "", "body", ""].join("\n"));
  });

  // covers: SC-38, INV-3
  test("a blank LF value with trailing spaces: the value is inserted after the preserved spacing", () => {
    const content = ["---", "name: n", "project:   ", "type: project", "---", "", "body", ""].join("\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "name: n", "project:   widget", "type: project", "---", "", "body", ""].join("\n"));
  });

  // covers: SC-40
  test("inserts project: <value> directly after the first type: line when no project: line exists", () => {
    const content = ["---", "name: n", "type: project", "tags: []", "---", "", "body", ""].join("\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "name: n", "type: project", "project: widget", "tags: []", "---", "", "body", ""].join("\n"));
  });

  // covers: SC-40
  test("inserts project: <value> right after the opening fence when neither project: nor type: exists", () => {
    const content = ["---", "name: n", "tags: []", "---", "", "body", ""].join("\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "project: widget", "name: n", "tags: []", "---", "", "body", ""].join("\n"));
  });

  // covers: SC-38
  test("content with no byte-0 fence is returned unchanged", () => {
    const content = "no frontmatter here\nproject: other\n";
    expect(setProjectLine(content, "widget")).toBe(content);
  });

  // covers: SC-40
  test("inserting an absent project: into a CRLF file uses CRLF for the inserted line too", () => {
    const content = ["---", "name: x", "description: d", "type: project", "tags: []", "---", "", "body", ""].join("\r\n");
    const out = setProjectLine(content, "widget");
    expect(out).toBe(["---", "name: x", "description: d", "type: project", "project: widget", "tags: []", "---", "", "body", ""].join("\r\n"));
  });
});

describe("isRescopePlan — shape check for a plan read from a file (w2-rescope)", () => {
  const validRow: RescopeRow = { slug: "s", type: "project", from: "global", to: "widget", reason: "slug-prefix" };
  const validPlan: RescopePlan = { known: ["widget"], rows: [validRow], unmatched: 0, version: 1 };

  // covers: SC-42
  test("accepts a well-formed plan", () => {
    expect(isRescopePlan(validPlan)).toBe(true);
  });

  // covers: SC-42
  test("rejects non-object, null, and array values", () => {
    for (const v of [null, undefined, "plan", 42, [], [validRow]]) {
      expect(isRescopePlan(v)).toBe(false);
    }
  });

  // covers: SC-42
  test("rejects a plan missing a required field or with a wrong-typed field", () => {
    expect(isRescopePlan({ ...validPlan, rows: "not-an-array" })).toBe(false);
    expect(isRescopePlan({ ...validPlan, known: [1, 2] })).toBe(false);
    expect(isRescopePlan({ ...validPlan, unmatched: "0" })).toBe(false);
    const { known: _known, ...noKnown } = validPlan;
    expect(isRescopePlan(noKnown)).toBe(false);
  });

  // covers: SC-42
  test("plan.version is not validated: any version value, present or absent, is accepted", () => {
    expect(isRescopePlan({ ...validPlan, version: 2 })).toBe(true);
    const { version: _version, ...noVersion } = validPlan;
    expect(isRescopePlan(noVersion)).toBe(true);
  });

  // covers: SC-42
  test("rejects a row with a malformed field (missing key, non-string slug, bad reason)", () => {
    const { slug: _slug, ...rowNoSlug } = validRow;
    expect(isRescopePlan({ ...validPlan, rows: [rowNoSlug] })).toBe(false);
    expect(isRescopePlan({ ...validPlan, rows: [{ ...validRow, slug: 5 }] })).toBe(false);
    expect(isRescopePlan({ ...validPlan, rows: [{ ...validRow, reason: "bogus" }] })).toBe(false);
  });

  // covers: SC-42
  test("a row's type is not restricted to project/reference: an invalid or traversal-shaped type still passes the shape check, so phase 1 can reject it", () => {
    expect(isRescopePlan({ ...validPlan, rows: [{ ...validRow, type: "user" }] })).toBe(true);
    expect(isRescopePlan({ ...validPlan, rows: [{ ...validRow, type: "../../etc" }] })).toBe(true);
  });
});

function fakeStore(opts: { updateThrows?: boolean } = {}): { store: QMDStore; calls: unknown[] } {
  const calls: unknown[] = [];
  const store = {
    async searchLex() { return []; },
    async update(args: unknown) {
      calls.push(args);
      if (opts.updateThrows) throw new Error("SQLITE_BUSY");
    },
  } as unknown as QMDStore;
  return { store, calls };
}

function fakeGit(opts: { commitStatus?: number } = {}): { run: (args: string[], cwd: string) => number; calls: string[][] } {
  const calls: string[][] = [];
  const run = (args: string[]): number => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return 0;
    if (args[0] === "rev-parse") return 0; // upstream present
    if (args[0] === "diff") return 1; // changes staged
    if (args[0] === "commit") return opts.commitStatus ?? 0;
    return 0; // push, add
  };
  return { run, calls };
}

describe("applyRescope — apply (w2-rescope)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-rescope-apply-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // covers: SC-37
  test("a 3-row plan where row 2's slug has no file on disk: only row 2 is rejected, but nothing is applied", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "c", { project: "global" });
    const before = { a: readFileSync(join(root, "project", "a.md"), "utf-8"), c: readFileSync(join(root, "project", "c.md"), "utf-8") };
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "missing", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "c", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run, calls: gitCalls } = fakeGit();

    const res = await applyRescope(store, root, plan, { run });

    expect(res.rejected).toEqual([rows[1]]);
    expect(res.applied).toBe(0);
    expect(readFileSync(join(root, "project", "a.md"), "utf-8")).toBe(before.a);
    expect(readFileSync(join(root, "project", "c.md"), "utf-8")).toBe(before.c);
    expect(gitCalls.filter((a) => a[0] === "commit")).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  // covers: SC-37
  test("a row whose disk project no longer equals its plan from is rejected as stale, blocking the whole apply", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "somethingelse" });
    await writeFact(root, "c", { project: "global" });
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "b", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "c", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();

    const res = await applyRescope(store, root, plan);

    expect(res.rejected).toEqual([rows[1]]);
    expect(res.applied).toBe(0);
    expect(calls).toEqual([]);
  });

  // covers: SC-37
  test("the same type/slug appearing twice in the plan rejects the duplicate and blocks the whole apply", async () => {
    await writeFact(root, "a", { project: "global" });
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();

    const res = await applyRescope(store, root, plan);

    expect(res.applied).toBe(0);
    expect(res.rejected).toEqual([rows[1]]);
    expect(readFileSync(join(root, "project", "a.md"), "utf-8")).toContain("project: global");
    expect(calls).toEqual([]);
  });

  // covers: SC-37
  test("a fenceless fact file cannot be rewritten honestly and is rejected in phase 1", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "no-fences.md"), "no frontmatter at all\nproject: other\n");
    const rows: RescopeRow[] = [{ slug: "no-fences", type: "project", from: "global", to: "widget", reason: "slug-prefix" }];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();

    const res = await applyRescope(store, root, plan);

    expect(res.applied).toBe(0);
    expect(res.rejected).toEqual(rows);
    expect(readFileSync(join(root, "project", "no-fences.md"), "utf-8")).toBe("no frontmatter at all\nproject: other\n");
    expect(calls).toEqual([]);
  });

  // covers: SC-37
  test("re-applying an already-applied plan rejects every row (disk project now equals to, not from)", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "b", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store } = fakeStore();
    const { run } = fakeGit();

    const first = await applyRescope(store, root, plan, { run });
    expect(first.applied).toBe(2);
    expect(first.rejected).toEqual([]);

    const second = await applyRescope(store, root, plan, { run });
    expect(second.applied).toBe(0);
    expect(second.rejected).toEqual(rows);
  });

  // covers: SC-38, INV-3
  test("apply changes only the project: value; tags, supersedes, review_by, pinned, and a multi-paragraph body stay byte-identical", async () => {
    const dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    const before = [
      "---",
      "description: fact widget-anchor",
      "name: widget-anchor",
      'tags: ["needs quoting: yes", plain]',
      "type: project",
      "supersedes: widget-older",
      "project: global",
      "review_by: 2027-01-01",
      "pinned: true",
      "created: 2026-06-10",
      "---",
      "",
      "First paragraph of the fact.",
      "",
      "Second paragraph with more detail and a list:",
      "- one",
      "- two",
      "",
    ].join("\n");
    const expected = [
      "---",
      "description: fact widget-anchor",
      "name: widget-anchor",
      'tags: ["needs quoting: yes", plain]',
      "type: project",
      "supersedes: widget-older",
      "project: widget",
      "review_by: 2027-01-01",
      "pinned: true",
      "created: 2026-06-10",
      "---",
      "",
      "First paragraph of the fact.",
      "",
      "Second paragraph with more detail and a list:",
      "- one",
      "- two",
      "",
    ].join("\n");
    await writeFile(join(dir, "widget-anchor.md"), before);
    const rows: RescopeRow[] = [{ slug: "widget-anchor", type: "project", from: "global", to: "widget", reason: "slug-prefix" }];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store } = fakeStore();

    const res = await applyRescope(store, root, plan);

    expect(res.applied).toBe(1);
    expect(readFileSync(join(dir, "widget-anchor.md"), "utf-8")).toBe(expected);
    const entries = readdirSync(dir);
    expect(entries.some((f) => f.endsWith(".bak"))).toBe(false);
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  // covers: SC-37
  test("a throw mid-write restores the already-written file from its pre-image and removes the in-flight temp file", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    const dir = join(root, "project");
    const beforeA = readFileSync(join(dir, "a.md"), "utf-8");
    const beforeB = readFileSync(join(dir, "b.md"), "utf-8");
    await mkdir(join(dir, `b.md.rescope-${process.pid}.tmp`), { recursive: true });
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "b", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();

    await expect(applyRescope(store, root, plan)).rejects.toThrow(/EISDIR/i);

    expect(readFileSync(join(dir, "a.md"), "utf-8")).toBe(beforeA);
    expect(readFileSync(join(dir, "b.md"), "utf-8")).toBe(beforeB);
    expect(existsSync(join(dir, `a.md.rescope-${process.pid}.tmp`))).toBe(false);
    expect(calls).toEqual([]);
  });

  // covers: SC-37, INV-3
  test("a rename failure mid-apply restores every already-renamed file byte-for-byte and leaves no temp behind", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    await writeFact(root, "c", { project: "global" });
    const dir = join(root, "project");
    const before: Record<string, string> = {
      a: readFileSync(join(dir, "a.md"), "utf-8"),
      b: readFileSync(join(dir, "b.md"), "utf-8"),
      c: readFileSync(join(dir, "c.md"), "utf-8"),
    };
    const rows: RescopeRow[] = ["a", "b", "c"].map((slug) => ({ slug, type: "project", from: "global", to: "widget", reason: "slug-prefix" }));
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run, calls: gitCalls } = fakeGit();
    const { renameSync: realRenameSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((oldPath, newPath) => {
      if (String(newPath).endsWith("c.md")) throw new Error("simulated rename failure");
      return realRenameSync(oldPath as Parameters<typeof realRenameSync>[0], newPath as Parameters<typeof realRenameSync>[1]);
    });

    try {
      await expect(applyRescope(store, root, plan, { run })).rejects.toThrow(/simulated rename failure/);

      for (const slug of ["a", "b", "c"]) {
        expect(readFileSync(join(dir, `${slug}.md`), "utf-8")).toBe(before[slug]);
      }
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(gitCalls.filter((a) => a[0] === "commit")).toHaveLength(0);
      expect(calls).toEqual([]);
    } finally {
      vi.mocked(renameSync).mockImplementation(realRenameSync);
    }
  });

  // covers: SC-37
  test("a restore that itself fails names the still-rescoped fact as <type>/<slug>, carries the original error as cause, and restores the rest", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    await writeFact(root, "c", { project: "global" });
    const dir = join(root, "project");
    const beforeB = readFileSync(join(dir, "b.md"), "utf-8");
    const beforeC = readFileSync(join(dir, "c.md"), "utf-8");
    const aRestoreTmp = join(dir, `a.md.rescope-restore-${process.pid}.tmp`);
    const rows: RescopeRow[] = ["a", "b", "c"].map((slug) => ({ slug, type: "project", from: "global", to: "widget", reason: "slug-prefix" }));
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run, calls: gitCalls } = fakeGit();
    const { writeFileSync: realWriteFileSync, renameSync: realRenameSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((oldPath, newPath) => {
      if (String(newPath).endsWith("c.md")) throw new Error("simulated rename failure");
      return realRenameSync(oldPath as Parameters<typeof realRenameSync>[0], newPath as Parameters<typeof realRenameSync>[1]);
    });
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (path === aRestoreTmp) throw new Error("simulated restore write failure");
      return realWriteFileSync(path as Parameters<typeof realWriteFileSync>[0], data as Parameters<typeof realWriteFileSync>[1], options as Parameters<typeof realWriteFileSync>[2]);
    });

    try {
      const err: unknown = await applyRescope(store, root, plan, { run }).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("rescope rollback incomplete; still rescoped on disk: project/a");
      expect((err as Error).message).not.toContain(root);
      expect(((err as Error).cause as Error).message).toMatch(/simulated rename failure/);
      expect(readFileSync(join(dir, "a.md"), "utf-8")).toContain("project: widget");
      expect(readFileSync(join(dir, "b.md"), "utf-8")).toBe(beforeB);
      expect(readFileSync(join(dir, "c.md"), "utf-8")).toBe(beforeC);
      expect(gitCalls.filter((a) => a[0] === "commit")).toHaveLength(0);
      expect(calls).toEqual([]);
    } finally {
      vi.mocked(renameSync).mockImplementation(realRenameSync);
      vi.mocked(writeFileSync).mockImplementation(realWriteFileSync);
    }
  });

  // covers: SC-37, INV-3
  test("a target rewritten by a concurrent writer between plan and apply aborts before any rename: no file rescoped, no temp, no commit, no reindex", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    const dir = join(root, "project");
    const aPath = join(dir, "a.md");
    const bPath = join(dir, "b.md");
    const beforeA = readFileSync(aPath, "utf-8");
    const rows: RescopeRow[] = ["a", "b"].map((slug) => ({ slug, type: "project", from: "global", to: "widget", reason: "slug-prefix" }));
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run, calls: gitCalls } = fakeGit();
    const { writeFileSync: realWriteFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      const out = realWriteFileSync(path as Parameters<typeof realWriteFileSync>[0], data as Parameters<typeof realWriteFileSync>[1], options as Parameters<typeof realWriteFileSync>[2]);
      // A concurrent remember lands on b while rescope is still staging its temp files.
      if (String(path).startsWith(aPath)) realWriteFileSync(bPath, `${readFileSync(bPath, "utf-8")}\nconcurrent edit\n`);
      return out;
    });

    try {
      await expect(applyRescope(store, root, plan, { run })).rejects.toThrow(/fact project\/b changed during apply; re-run rescope/);

      expect(readFileSync(aPath, "utf-8")).toBe(beforeA);
      const afterB = readFileSync(bPath, "utf-8");
      expect(afterB).toContain("concurrent edit");
      expect(afterB).toMatch(/^project: global$/m);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(gitCalls.filter((a) => a[0] === "commit")).toHaveLength(0);
      expect(calls).toEqual([]);
    } finally {
      vi.mocked(writeFileSync).mockImplementation(realWriteFileSync);
    }
  });

  // covers: SC-39
  test("3 applied rows commit once with all three paths and rescope: 3 facts, push once, reindex once", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    await writeFact(root, "c", { project: "global" });
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "b", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "c", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run, calls: gitCalls } = fakeGit();

    const res = await applyRescope(store, root, plan, { run });

    expect(res.applied).toBe(3);
    const commits = gitCalls.filter((a) => a[0] === "commit");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain("rescope: 3 facts");
    for (const s of ["a", "b", "c"]) expect(commits[0]).toContain(`project/${s}.md`);
    expect(gitCalls.filter((a) => a[0] === "push")).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(res.synced).toBe(true);
    expect(res.indexed).toBe(true);
  });

  // covers: SC-39
  test("an empty plan performs no write, commit, push, or reindex", async () => {
    const plan: RescopePlan = { known: [], rows: [], unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run, calls: gitCalls } = fakeGit();

    const res = await applyRescope(store, root, plan, { run });

    expect(res).toEqual({ applied: 0, rejected: [], synced: true, indexed: true });
    expect(gitCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  // covers: SC-39
  test("a commit failure (exit 128) leaves files rewritten, synced:false with a warning, but still reindexes", async () => {
    await writeFact(root, "a", { project: "global" });
    const rows: RescopeRow[] = [{ slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" }];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const { run } = fakeGit({ commitStatus: 128 });

    const res = await applyRescope(store, root, plan, { run });

    expect(res.applied).toBe(1);
    expect(readFileSync(join(root, "project", "a.md"), "utf-8")).toMatch(/project: widget/);
    expect(res.synced).toBe(false);
    expect(res.syncWarning).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(res.indexed).toBe(true);
  });

  // covers: SC-41
  test("a reindex rejection surfaces indexed:false without throwing; files stay rewritten and committed", async () => {
    await writeFact(root, "a", { project: "global" });
    const rows: RescopeRow[] = [{ slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" }];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store } = fakeStore({ updateThrows: true });
    const { run, calls: gitCalls } = fakeGit();

    const res = await applyRescope(store, root, plan, { run });

    expect(res.applied).toBe(1);
    expect(res.indexed).toBe(false);
    expect(readFileSync(join(root, "project", "a.md"), "utf-8")).toMatch(/project: widget/);
    expect(gitCalls.filter((a) => a[0] === "commit")).toHaveLength(1);
  });

  // covers: SC-42
  test("a plan row with a traversal slug or a newline slug rejects the whole plan and writes nothing outside <root>/<type>/", async () => {
    const memoryRoot = join(root, "memory");
    await writeFact(memoryRoot, "a", { project: "global" });
    await writeFact(memoryRoot, "../../x", { project: "global" });
    await writeFact(memoryRoot, "bad\nslug", { project: "global" });
    const traversalPath = join(memoryRoot, "project", "../../x.md");
    const newlinePath = join(memoryRoot, "project", "bad\nslug.md");
    const traversalBefore = readFileSync(traversalPath, "utf-8");
    const newlineBefore = readFileSync(newlinePath, "utf-8");
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "../../x", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
      { slug: "bad\nslug", type: "project", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();

    const res = await applyRescope(store, memoryRoot, plan);

    expect(res.applied).toBe(0);
    expect(res.rejected).toEqual([rows[1], rows[2]]);
    expect(readFileSync(join(memoryRoot, "project", "a.md"), "utf-8")).toContain("project: global");
    expect(readFileSync(traversalPath, "utf-8")).toBe(traversalBefore);
    expect(readFileSync(newlinePath, "utf-8")).toBe(newlineBefore);
    expect(calls).toEqual([]);
  });

  // covers: INV-2
  test("a row targeting global, blank, or a user-type fact is rejected", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    await writeFact(root, "u", { project: "global", type: "user" });
    const rows: RescopeRow[] = [
      { slug: "a", type: "project", from: "global", to: "Global", reason: "slug-prefix" },
      { slug: "b", type: "project", from: "global", to: "", reason: "slug-prefix" },
      { slug: "u", type: "user", from: "global", to: "widget", reason: "slug-prefix" },
    ];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();

    const res = await applyRescope(store, root, plan);

    expect(res.applied).toBe(0);
    expect(res.rejected).toEqual(rows);
    expect(calls).toEqual([]);
  });

  // covers: SC-40
  test("apply on a fact with no project: line inserts project: <to> right after the type: line", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    const content = ["---", "name: widget-noproject", "description: fact", "type: project", "tags: []", "created: 2026-06-10", "pinned: false", "---", "", "project: other", ""].join("\n");
    await writeFile(join(root, "project", "widget-noproject.md"), content);
    const rows: RescopeRow[] = [{ slug: "widget-noproject", type: "project", from: "global", to: "widget", reason: "slug-prefix" }];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store } = fakeStore();

    const res = await applyRescope(store, root, plan);

    expect(res.applied).toBe(1);
    const after = readFileSync(join(root, "project", "widget-noproject.md"), "utf-8");
    expect(after).toBe(["---", "name: widget-noproject", "description: fact", "type: project", "project: widget", "tags: []", "created: 2026-06-10", "pinned: false", "---", "", "project: other", ""].join("\n"));
  });
  // covers: SC-39
  test("a failed git add of one path fails the whole commit: no commit runs, synced:false, files stay rewritten and still reindex", async () => {
    await writeFact(root, "a", { project: "global" });
    await writeFact(root, "b", { project: "global" });
    await writeFact(root, "c", { project: "global" });
    const rows: RescopeRow[] = ["a", "b", "c"].map((slug) => ({ slug, type: "project", from: "global", to: "widget", reason: "slug-prefix" }));
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const { store, calls } = fakeStore();
    const gitCalls: string[][] = [];
    const run = (args: string[]): number => {
      gitCalls.push(args);
      if (args[0] === "add") return args[args.length - 1] === "project/b.md" ? 1 : 0;
      if (args[0] === "diff") return 1;
      return 0;
    };

    const res = await applyRescope(store, root, plan, { run });

    expect(res.applied).toBe(3);
    expect(gitCalls.filter((a) => a[0] === "commit")).toHaveLength(0);
    expect(res.synced).toBe(false);
    expect(res.syncWarning).toMatch(/add-failed/);
    for (const slug of ["a", "b", "c"]) {
      expect(readFileSync(join(root, "project", `${slug}.md`), "utf-8")).toMatch(/^project: widget$/m);
    }
    expect(calls).toHaveLength(1);
    expect(res.indexed).toBe(true);
  });

  // covers: SC-41
  test("a reindex failure logs only the error code and the recovery command, never the raw message", async () => {
    await writeFact(root, "a", { project: "global" });
    const rows: RescopeRow[] = [{ slug: "a", type: "project", from: "global", to: "widget", reason: "slug-prefix" }];
    const plan: RescopePlan = { known: ["widget"], rows, unmatched: 0, version: 1 };
    const dbPath = join(root, ".idx", "i.sqlite");
    const store = {
      async searchLex() { return []; },
      async update() {
        const e = Object.assign(new Error(`database is locked: ${dbPath}`), { code: "SQLITE_BUSY" });
        throw e;
      },
    } as unknown as QMDStore;
    const { run } = fakeGit();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });

    try {
      const res = await applyRescope(store, root, plan, { run });

      expect(res.indexed).toBe(false);
      expect(logged).toContain("[qmemd] rescope: reindex failed (SQLITE_BUSY); run qmemd reindex");
      expect(logged.join("\n")).not.toContain("database is locked");
      expect(logged.join("\n")).not.toContain(dbPath);
    } finally {
      spy.mockRestore();
    }
  });
});
