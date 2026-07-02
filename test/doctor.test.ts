import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { auditFact, fixContent, auditMemory, fixMemory, type IssueCode, type FactIssue } from "../src/doctor.js";
import { serializeMemory, parseMemory, type MemoryFrontmatter } from "../src/engine.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NUL = String.fromCharCode(0); // a real null byte (a literal one does not survive a file write)

// A well-formed fact whose frontmatter type/name match the folder/slug it is checked against.
function validFact(over: Partial<MemoryFrontmatter> = {}, body = "Body text."): string {
  const fm: MemoryFrontmatter = {
    name: "slug", description: "d", type: "project", tags: [], project: "global",
    created: "2026-06-06", pinned: false, ...over,
  };
  return serializeMemory(fm, body);
}
const codes = (issues: FactIssue[]): IssueCode[] => issues.map(i => i.code);

describe("auditFact (pure)", () => {
  test("a well-formed fact has no issues", () => {
    expect(auditFact(validFact(), "project", "slug")).toEqual([]);
  });

  test("a quoted name that decodes to the slug is NOT a mismatch (unquoting handled)", () => {
    // slug 'true' is a YAML-reserved scalar, so serializeMemory writes name: "true".
    const content = validFact({ name: "true" }, "b");
    expect(content).toContain('name: "true"'); // sanity: it really is the quoted form
    expect(codes(auditFact(content, "project", "true"))).not.toContain("NAME_MISMATCH");
  });

  test("flags MISSING_OPEN when the file has no leading fence", () => {
    expect(codes(auditFact("name: x\ntype: project\n---\nbody", "project", "slug")))
      .toEqual(["MISSING_OPEN"]);
  });

  test("flags MISSING_CLOSE when the opening fence is never closed", () => {
    // parseMemory silently treats the whole file as body here — every field is lost.
    expect(codes(auditFact("---\nname: slug\ntype: project\n", "project", "slug")))
      .toEqual(["MISSING_CLOSE"]);
  });

  test("flags EMPTY_FRONTMATTER when the fences enclose no keys", () => {
    expect(codes(auditFact("---\n---\nbody", "project", "slug")))
      .toEqual(["EMPTY_FRONTMATTER"]);
  });

  test("flags YAML_PARSE on a fence line parseMemory would silently drop", () => {
    const content = "---\nname: slug\nthis line has no key\ntype: project\n---\n\nbody\n";
    expect(codes(auditFact(content, "project", "slug"))).toContain("YAML_PARSE");
  });

  test("flags TYPE_MISMATCH when frontmatter type differs from the folder", () => {
    const content = validFact({ name: "slug", type: "reference" }); // lives in project/
    expect(codes(auditFact(content, "project", "slug"))).toEqual(["TYPE_MISMATCH"]);
  });

  test("flags TYPE_MISMATCH on an unknown (non-closed) type value", () => {
    const content = "---\nname: slug\ntype: projekt\nproject: global\ncreated: 2026-06-06\npinned: false\n---\n\nbody\n";
    expect(codes(auditFact(content, "project", "slug"))).toEqual(["TYPE_MISMATCH"]);
  });

  test("flags TYPE_MISMATCH when the type field is missing entirely", () => {
    const content = "---\nname: slug\nproject: global\ncreated: 2026-06-06\npinned: false\n---\n\nbody\n";
    expect(codes(auditFact(content, "project", "slug"))).toEqual(["TYPE_MISMATCH"]);
  });

  test("flags NAME_MISMATCH when frontmatter name drifts from the filename", () => {
    const content = validFact({ name: "drifted", type: "project" });
    expect(codes(auditFact(content, "project", "real-slug"))).toEqual(["NAME_MISMATCH"]);
  });

  test("flags NULL_BYTES independently of frontmatter validity", () => {
    const content = validFact({ name: "slug" }, `body with a ${NUL} null`);
    expect(codes(auditFact(content, "project", "slug"))).toEqual(["NULL_BYTES"]);
  });

  test("marks only NULL_BYTES/TYPE_MISMATCH/NAME_MISMATCH as fixable", () => {
    const fixable = (c: string, ft: string, s: string): Record<string, boolean> =>
      Object.fromEntries(auditFact(c, ft, s).map(i => [i.code, i.fixable]));
    expect(fixable(validFact({ name: "drifted" }), "project", "real")).toEqual({ NAME_MISMATCH: true });
    expect(fixable("---\n---\nb", "project", "slug")).toEqual({ EMPTY_FRONTMATTER: false });
    expect(fixable("no-fence", "project", "slug")).toEqual({ MISSING_OPEN: false });
  });

  test("flags BODY_TEMPLATE_LEAK when the body carries leaked markup (qp-ey3)", () => {
    const content = validFact({ name: "slug", type: "project" },
      "Keystore alias is the cert CN.\n</fact>\n<parameter name=\"type\">project");
    expect(codes(auditFact(content, "project", "slug"))).toContain("BODY_TEMPLATE_LEAK");
  });

  test("does NOT flag BODY_TEMPLATE_LEAK for a token in a frontmatter value (body-only, qp-ey3)", () => {
    const content = validFact({ name: "slug", type: "project", description: "note </fact>" }, "clean body");
    expect(codes(auditFact(content, "project", "slug"))).not.toContain("BODY_TEMPLATE_LEAK");
  });
});

describe("fixContent (pure, surgical)", () => {
  test("rewrites a drifted name to the slug, preserving body and other fields", () => {
    const before = validFact({ name: "drifted", type: "project" }, "Keep me.");
    const out = fixContent(before, "project", "real-slug");
    expect(out).not.toBeNull();
    expect(out!.fixed).toEqual(["NAME_MISMATCH"]);
    const fm = parseMemory(out!.content).frontmatter;
    expect(fm.name).toBe("real-slug");
    expect(out!.content).toContain("Keep me.");
    expect(fm.type).toBe("project"); // untouched
  });

  test("rewrites a mismatched type to the folder", () => {
    const before = validFact({ name: "slug", type: "reference" });
    const out = fixContent(before, "project", "slug");
    expect(out!.fixed).toEqual(["TYPE_MISMATCH"]);
    expect(parseMemory(out!.content).frontmatter.type).toBe("project");
  });

  test("strips null bytes", () => {
    const before = validFact({ name: "slug" }, `a${NUL}b`);
    const out = fixContent(before, "project", "slug");
    expect(out!.fixed).toEqual(["NULL_BYTES"]);
    expect(out!.content).not.toContain(NUL);
  });

  test("repairs name, type, and null bytes together in one pass", () => {
    const before = validFact({ name: "drifted", type: "reference" }, `x${NUL}y`);
    const out = fixContent(before, "project", "real");
    expect(out!.fixed.slice().sort()).toEqual(["NAME_MISMATCH", "NULL_BYTES", "TYPE_MISMATCH"]);
    const fm = parseMemory(out!.content).frontmatter;
    expect(fm.name).toBe("real");
    expect(fm.type).toBe("project");
    expect(out!.content).not.toContain(NUL);
  });

  test("inserts a missing name field rather than leaving it blank", () => {
    const before = "---\ntype: project\nproject: global\ncreated: 2026-06-06\npinned: false\n---\n\nbody\n";
    const out = fixContent(before, "project", "real");
    expect(out!.fixed).toEqual(["NAME_MISMATCH"]);
    expect(parseMemory(out!.content).frontmatter.name).toBe("real");
  });

  test("preserves an unrecognized frontmatter key (no lossy reserialize)", () => {
    const before = "---\nname: drifted\ntype: project\ncustom: keep-me\nproject: global\ncreated: 2026-06-06\npinned: false\n---\n\nBody.\n";
    const out = fixContent(before, "project", "real");
    expect(parseMemory(out!.content).frontmatter.name).toBe("real");
    expect(out!.content).toContain("custom: keep-me");
  });

  test("returns null for a clean fact (nothing to fix)", () => {
    expect(fixContent(validFact(), "project", "slug")).toBeNull();
  });

  test("does NOT attempt field surgery on a fence-broken file (returns null)", () => {
    // name drifts, but the missing close fence is unfixable → leave the file untouched.
    expect(fixContent("---\nname: drifted\n", "project", "real")).toBeNull();
  });

  test("strips a body leak but leaves frontmatter bytes untouched (qp-ey3)", () => {
    const content = validFact({ name: "slug", type: "project" },
      "Keystore alias is the cert CN.\n</fact>\n<parameter name=\"type\">project");
    const out = fixContent(content, "project", "slug");
    expect(out).not.toBeNull();
    expect(out!.fixed).toContain("BODY_TEMPLATE_LEAK");
    expect(parseMemory(out!.content).body).toContain("Keystore alias is the cert CN.");
    expect(out!.content).not.toContain("</fact>");
    expect(out!.content).not.toContain("<parameter");
    expect(out!.content).toContain("name: slug");
    expect(out!.content).toContain("type: project");
  });
});

describe("auditMemory (filesystem walk)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-doctor-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("reports only problematic facts, with a relative (non-absolute) path", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "clean.md"), validFact({ name: "clean", type: "project" }));
    await writeFile(join(root, "project", "broken.md"), validFact({ name: "broken", type: "reference" }));
    const reports = auditMemory(root);
    expect(reports.map(r => r.slug)).toEqual(["broken"]);
    expect(reports[0]!.relpath).toBe("project/broken.md");
    expect(reports[0]!.relpath).not.toContain(root); // never leak the absolute fs path
    expect(codes(reports[0]!.issues)).toEqual(["TYPE_MISMATCH"]);
  });

  test("ignores .md.bak backups and non-markdown files", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "x.md.bak"), validFact({ name: "nope", type: "reference" }));
    await writeFile(join(root, "project", "notes.txt"), "junk");
    expect(auditMemory(root)).toEqual([]);
  });

  test("review_by: never is a valid durable sentinel — not flagged REVIEW_BY_MALFORMED (s4w)", () => {
    const content = serializeMemory(
      { name: "durable", description: "d", type: "project", tags: [], project: "global",
        created: "2026-01-01", pinned: false, reviewBy: "never" },
      "Body.");
    const issues = auditFact(content, "project", "durable");
    expect(issues.map(i => i.code)).not.toContain("REVIEW_BY_MALFORMED");
  });
});

describe("fixMemory (filesystem repair)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-doctorfix-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("writes a .md.bak of the original, repairs in place, and clears the issue", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    const path = join(root, "project", "drift.md");
    const original = validFact({ name: "was-drifted", type: "project" });
    await writeFile(path, original);

    const results = fixMemory(root);
    expect(results.map(r => r.fixed)).toEqual([["NAME_MISMATCH"]]);

    expect(existsSync(path + ".bak")).toBe(true);
    expect(readFileSync(path + ".bak", "utf-8")).toBe(original); // backup is the pre-fix bytes
    expect(parseMemory(readFileSync(path, "utf-8")).frontmatter.name).toBe("drift");
    expect(auditMemory(root)).toEqual([]); // .bak is invisible to the re-audit; fact is clean
  });

  test("is idempotent — a second run finds nothing to fix", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    await writeFile(join(root, "reference", "r.md"), validFact({ name: "drift", type: "reference" }));
    expect(fixMemory(root).length).toBe(1);
    expect(fixMemory(root)).toEqual([]);
  });

  // --- .bak hygiene (qmemd-g6q): the writer of .bak files keeps them out of git ---

  test("writing a .bak also ensures a root .gitignore covering *.bak", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "drift.md"), validFact({ name: "was-drifted", type: "project" }));
    fixMemory(root);
    expect(readFileSync(join(root, ".gitignore"), "utf-8").split(/\r?\n/)).toContain("*.bak");
  });

  test("appends *.bak to an existing .gitignore without clobbering it", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".DS_Store\n");
    await writeFile(join(root, "project", "drift.md"), validFact({ name: "was-drifted", type: "project" }));
    fixMemory(root);
    const lines = readFileSync(join(root, ".gitignore"), "utf-8").split(/\r?\n/);
    expect(lines).toContain(".DS_Store");
    expect(lines).toContain("*.bak");
  });

  test("leaves a .gitignore that already ignores *.bak untouched, and writes none on a clean run", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "*.bak\n");
    await writeFile(join(root, "project", "drift.md"), validFact({ name: "was-drifted", type: "project" }));
    fixMemory(root);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("*.bak\n"); // not duplicated
    // A run with nothing to fix must not fabricate a .gitignore.
    const clean = await mkdtemp(join(tmpdir(), "qmemd-doctorfix-clean-"));
    try {
      await mkdir(join(clean, "project"), { recursive: true });
      await writeFile(join(clean, "project", "ok.md"), validFact({ name: "ok", type: "project" }));
      expect(fixMemory(clean)).toEqual([]);
      expect(existsSync(join(clean, ".gitignore"))).toBe(false);
    } finally {
      await rm(clean, { recursive: true, force: true });
    }
  });
});

describe("supersession link audits (bri)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-doctor-links-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const fact = (slug: string, extra = ""): string =>
    `---\nname: ${slug}\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2026-01-01\npinned: false\n${extra}---\n\nbody\n`;
  const write = async (slug: string, extra = "") => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", `${slug}.md`), fact(slug, extra));
  };

  test("flags a malformed link slug (pure auditFact)", () => {
    const issues = auditFact(fact("a", "supersedes: ../escape\n"), "project", "a");
    expect(issues.some(i => i.code === "LINK_MALFORMED")).toBe(true);
    // self-reference is malformed too
    const self = auditFact(fact("a", "supersedes: a\n"), "project", "a");
    expect(self.some(i => i.code === "LINK_MALFORMED")).toBe(true);
  });

  test("flags dangling supersedes (not fixable) and dangling superseded_by (fixable)", async () => {
    await write("fwd", "supersedes: gone\n");
    await write("rev", "superseded_by: gone\n");
    const reports = auditMemory(root);
    const fwd = reports.find(r => r.slug === "fwd")!;
    expect(fwd.issues.some(i => i.code === "LINK_DANGLING_SUPERSEDES" && !i.fixable)).toBe(true);
    const rev = reports.find(r => r.slug === "rev")!;
    expect(rev.issues.some(i => i.code === "LINK_DANGLING_SUPERSEDED_BY" && i.fixable)).toBe(true);
  });

  test("flags a one-sided pair (fixable on TARGET) and a mutual cycle (not fixable)", async () => {
    await write("new-fact", "supersedes: old-fact\n");
    await write("old-fact"); // lacks superseded_by — the partial-write case
    await write("cyc-a", "superseded_by: cyc-b\n");
    await write("cyc-b", "superseded_by: cyc-a\n");
    const reports = auditMemory(root);
    // LINK_ONE_SIDED is reported on the TARGET (old-fact, missing its stamp), not the superseder
    expect(reports.find(r => r.slug === "old-fact")!.issues.some(i => i.code === "LINK_ONE_SIDED" && i.fixable)).toBe(true);
    expect(reports.find(r => r.slug === "cyc-a")!.issues.some(i => i.code === "LINK_CYCLE" && !i.fixable)).toBe(true);
    expect(reports.find(r => r.slug === "cyc-b")!.issues.some(i => i.code === "LINK_CYCLE")).toBe(true);
  });

  test("--fix clears a dangling superseded_by (un-supersede) and completes a one-sided pair, with .bak", async () => {
    await write("rev", "superseded_by: gone\n");
    await write("new-fact", "supersedes: old-fact\n");
    await write("old-fact");
    const results = fixMemory(root);
    expect(results.some(r => r.slug === "rev" && r.fixed.includes("LINK_DANGLING_SUPERSEDED_BY"))).toBe(true);
    expect(results.some(r => r.slug === "old-fact" && r.fixed.includes("LINK_ONE_SIDED"))).toBe(true);
    const rev = parseMemory(readFileSync(join(root, "project", "rev.md"), "utf-8"));
    expect(rev.frontmatter.supersededBy).toBeUndefined();        // visible again
    const old = parseMemory(readFileSync(join(root, "project", "old-fact.md"), "utf-8"));
    expect(old.frontmatter.supersededBy).toBe("new-fact");        // stamp completed
    expect(existsSync(join(root, "project", "rev.md.bak"))).toBe(true);
    expect(existsSync(join(root, "project", "old-fact.md.bak"))).toBe(true);
    // idempotent: second run repairs nothing
    expect(fixMemory(root)).toHaveLength(0);
  });
});

describe("PLATFORM_UNKNOWN (platform scoping)", () => {
  const wrap = (platformsLine: string) =>
    `---\nname: f\ndescription: d\ntype: project\n${platformsLine}\ncreated: 2026-06-08\n---\nbody`;

  test("flags an unknown platform token, needs review, not auto-fixed", () => {
    const issues = auditFact(wrap("platforms: [linux, freebsd]"), "project", "f");
    const iss = issues.find(i => i.code === "PLATFORM_UNKNOWN");
    expect(iss).toBeTruthy();
    expect(iss!.fixable).toBe(false);
    expect(iss!.detail).toContain("freebsd");
  });

  test("a valid platforms line is clean", () => {
    expect(auditFact(wrap("platforms: [linux, macos]"), "project", "f").some(i => i.code === "PLATFORM_UNKNOWN")).toBe(false);
  });

  test("a quoted token with an internal comma is reported as the one token parseMemory dropped, not split into two (qmemd-alu)", () => {
    // splitFlowSeq (what parseMemory uses) keeps "linux,macos" as ONE token because the comma
    // is inside quotes; parseMemory drops that single unknown token. A naive split(",") instead
    // reports two phantom tokens (linux + macos) parseMemory never saw.
    const iss = auditFact(wrap('platforms: ["linux,macos"]'), "project", "f").find(i => i.code === "PLATFORM_UNKNOWN");
    expect(iss).toBeTruthy();
    // Scope to the reported-tokens portion (the "(valid: linux, macos, windows)" suffix always
    // contains "linux, macos", so assert on the part before it).
    const reported = (iss!.detail ?? "").split("(valid:")[0]!;
    expect(reported).toContain("linux,macos");        // the real single dropped token (comma intact, no space)
    expect(reported).not.toMatch(/linux,\s+macos/);   // NOT the misleading two-token split
  });

  test("no platforms line is clean (cross-platform default)", () => {
    const content = `---\nname: f\ndescription: d\ntype: project\ncreated: 2026-06-08\n---\nbody`;
    expect(auditFact(content, "project", "f").some(i => i.code === "PLATFORM_UNKNOWN")).toBe(false);
  });

  test("--fix does not touch a PLATFORM_UNKNOWN fact (fixContent returns null for it alone)", async () => {
    const { fixContent } = await import("../src/doctor.js");
    // Only issue is the unknown platform → nothing mechanical to do.
    expect(fixContent(wrap("platforms: [linux, freebsd]"), "project", "f")).toBeNull();
  });
});

describe("REVIEW_BY_MALFORMED (9su)", () => {
  test("flags a non-date review_by — the fact would be silently exempt from staleness", () => {
    const content = validFact().replace("---\n", "---\nreview_by: soon\n");
    const issues = auditFact(content, "project", "slug");
    expect(codes(issues)).toContain("REVIEW_BY_MALFORMED");
    expect(issues.find(i => i.code === "REVIEW_BY_MALFORMED")!.fixable).toBe(false);
  });

  test("flags an impossible calendar date", () => {
    const content = validFact().replace("---\n", "---\nreview_by: 2026-02-30\n");
    expect(codes(auditFact(content, "project", "slug"))).toContain("REVIEW_BY_MALFORMED");
  });

  test("a valid review_by is clean; an absent one is clean", () => {
    const withDate = validFact().replace("---\n", "---\nreview_by: 2026-09-08\n");
    expect(codes(auditFact(withDate, "project", "slug"))).not.toContain("REVIEW_BY_MALFORMED");
    expect(codes(auditFact(validFact(), "project", "slug"))).not.toContain("REVIEW_BY_MALFORMED");
  });
});

describe("doctor agrees with the engine's own output (qmemd-nuc drift lock)", () => {
  // doctor re-implements parseMemory's raw key extraction (FM_KEY_RE + last-wins + BOM strip)
  // and INTENTIONALLY diverges on the semantic gates (it flags an unknown type that parseMemory
  // silently coerces). This locks the agreement contract: any fact the engine itself writes via
  // serializeMemory must audit clean. If parseMemory/serializeMemory key handling drifts from
  // doctor's view (e.g. the quoting rule or the line regex), one of these serialized facts stops
  // auditing clean and this test fails — turning qmemd-nuc's silent audit-drift into a caught
  // regression without coupling doctor to parseMemory's gating internals.
  const cases: { name: string; fm: Partial<MemoryFrontmatter> }[] = [
    { name: "minimal", fm: {} },
    { name: "reserved-scalar name (serializer quotes it)", fm: { name: "true" } },
    { name: "numeric-looking name", fm: { name: "123" } },
    { name: "description with colon-space (needs quoting)", fm: { description: "key: value pair" } },
    { name: "description with a leading hash", fm: { description: "#lead hash" } },
    { name: "tags with commas/brackets/quotes", fm: { tags: ["a,b", "c[d]", 'e"f'] } },
    { name: "platforms set", fm: { platforms: ["linux", "macos"] } },
    { name: "pinned true", fm: { pinned: true } },
    { name: "review_by set", fm: { reviewBy: "2027-01-01" } },
    { name: "updated instant", fm: { updated: "2026-06-06T12:00:00.000Z" } },
    { name: "supersession links", fm: { supersedes: "old-a", supersededBy: "new-b", conflictsWith: "rival-c" } },
    { name: "source set", fm: { source: "code-review" } },
  ];
  for (const c of cases) {
    test(`a serialized fact audits clean: ${c.name}`, () => {
      const slug = c.fm.name ?? "slug";
      const folder = c.fm.type ?? "project";
      const content = validFact(c.fm);
      // sanity: parseMemory round-trips name to the very slug doctor checks the filename against
      expect(parseMemory(content).frontmatter.name).toBe(slug);
      expect(auditFact(content, folder, slug)).toEqual([]);
    });
  }

  test("doctor still flags an unknown type that parseMemory silently coerces (the divergence is intentional)", () => {
    // parseMemory drops `type: projekt` → default 'reference'; doctor must NOT adopt that gate, or
    // an off-folder/unknown type would audit clean. Locks the deliberate raw-vs-effective split.
    const content = "---\nname: slug\ntype: projekt\nproject: global\ncreated: 2026-06-06\npinned: false\n---\n\nbody\n";
    expect(parseMemory(content).frontmatter.type).toBe("reference"); // coerced to default
    expect(codes(auditFact(content, "project", "slug"))).toContain("TYPE_MISMATCH");
  });
});
