import { describe, test, it, expect, beforeEach, afterEach, vi } from "vitest";
import { memoryRoot, indexDbPath } from "../src/paths.js";
import {
  parseMemory,
  serializeMemory,
  slugify,
  memoryFilePath,
  recallSession,
  truncateToBytes,
  assertSafeSlug,
  getFact,
  listFacts,
  nearDuplicate,
  classifyNearMatch,
  lowSimilarityConflict,
  tokenizeForDedup,
  firstLine,
  ANTONYM_PAIRS,
  tagHistogram,
  formatTagHistogram,
  reportShapeWarning,
  leakedMarkupTokens,
  stripLeakedMarkup,
  projectOverview,
  countUnreadableFacts,
  reviewByFromTtl,
  parseTtlDays,
  ttlDefaultDays,
  DURABLE_SENTINEL,
  isValidReviewBy,
  staleFacts,
  resolveReviewedDate,
  markReviewed,
  setFrontmatterKey,
  locateFences,
  Platform,
  type MemoryFrontmatter,
  type MemoryType,
} from "../src/engine.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp as mkt } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as openQmd, type QMDStore } from "@tobilu/qmd";

describe("paths", () => {
  test("memoryRoot honors QMD_MEMORY_DIR", () => {
    const prev = process.env.QMD_MEMORY_DIR;
    process.env.QMD_MEMORY_DIR = "/tmp/x";
    expect(memoryRoot()).toBe("/tmp/x");
    if (prev === undefined) delete process.env.QMD_MEMORY_DIR; else process.env.QMD_MEMORY_DIR = prev;
  });
  test("indexDbPath ends with qmemd/index.sqlite by default", () => {
    const prev = process.env.QMEMD_DB; delete process.env.QMEMD_DB;
    expect(indexDbPath().endsWith("qmemd/index.sqlite")).toBe(true);
    if (prev !== undefined) process.env.QMEMD_DB = prev;
  });
});

describe("slugify", () => {
  test("kebab-cases and trims", () => {
    expect(slugify("LM Studio embed host!")).toBe("lm-studio-embed-host");
  });
  test("collapses repeats and strips edges", () => {
    expect(slugify("  Foo --- Bar  ")).toBe("foo-bar");
  });
  test("truncates to 60 chars on a word boundary", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
  test("returns empty string when no alphanumerics remain", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!---???")).toBe("");
  });
});

describe("tokenizeForDedup (i5y)", () => {
  test("keeps a semver string atomic, not split on its dots", () => {
    expect(tokenizeForDedup("upgrade to 3.4.1 today")).toContain("3.4.1");
  });
  test("keeps an alphanumeric identifier atomic (jdk21)", () => {
    expect(tokenizeForDedup("build on jdk21")).toContain("jdk21");
  });
  test("lowercases and drops a small stopword set", () => {
    const toks = tokenizeForDedup("The Bun runtime IS on the host");
    expect(toks).toContain("bun");
    expect(toks).toContain("runtime");
    expect(toks).toContain("host");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("is");
    expect(toks).not.toContain("on");
  });
});

describe("nearDuplicate (model-free pre-pass, i5y)", () => {
  test("blocks two reworded near-duplicates (Dice >= 0.82)", () => {
    const r = nearDuplicate(
      "Redpanda broker runs on the lab pi server",
      "Redpanda broker runs on lab pi node",
    );
    expect(r.dice).toBeGreaterThanOrEqual(0.82);
    expect(r.duplicate).toBe(true);
  });

  test("vetoes a merge when identifier tokens conflict (jdk 21 vs jdk 25)", () => {
    // Identical phrasing except the protected version token — high token overlap, but
    // the differing identifier makes them distinct facts (a contradiction, not a dup).
    const r = nearDuplicate(
      "the alpha project builds green on jdk 21",
      "the alpha project builds green on jdk 25",
    );
    expect(r.identifierConflict).toBe(true);
    expect(r.duplicate).toBe(false);
  });

  test("does NOT block facts that share no content tokens", () => {
    const r = nearDuplicate(
      "Redpanda broker runs on lab pi",
      "PostgreSQL uses connection pooling",
    );
    expect(r.duplicate).toBe(false);
  });

  test("does NOT containment-block a short (<5 token) subset", () => {
    // "founder mode" subset-of "founder mode vs manager mode", but is too short to
    // safely containment-merge (it would subset-match many facts) — precision guard.
    const r = nearDuplicate("founder mode", "founder mode vs manager mode");
    expect(r.duplicate).toBe(false);
  });

  test("containment-blocks a >=5 token superset (overlap >= 0.90, Dice < 0.82)", () => {
    // Every A token is in B, but B adds enough tokens that Dice's length penalty drops
    // it below 0.82 — the overlap-coefficient branch (2.5b) is what catches it.
    const a = "spring kafka redpanda broker lab pi";
    const b = "spring kafka redpanda broker lab pi server node cluster extra";
    const r = nearDuplicate(a, b);
    expect(r.dice).toBeLessThan(0.82);
    expect(r.overlap).toBeGreaterThanOrEqual(0.90);
    expect(r.duplicate).toBe(true);
  });

  test("does not crash on empty / token-free input (returns no block)", () => {
    expect(nearDuplicate("", "anything").duplicate).toBe(false);
    expect(nearDuplicate("한국어 메모", "다른 메모").duplicate).toBe(false); // no ASCII tokens
  });

  test("loose same-topic phrasing drift stays below the auto-block floor (rso)", () => {
    // The qmemd-rso cluster shape: two genuine near-dups of the alpha JDK fact, heavily
    // reworded so each carries many unique tokens -> Dice ~0.2-0.4, far below 0.82. The i5y
    // pre-pass is built for TIGHT near-dups and intentionally does NOT catch loose drift: a
    // global threshold low enough to catch these would false-merge cross-repo facts (measured
    // 2026-06-05 — an alpha~beta JDK pair scored AS HIGH as an in-cluster pair, so the
    // classes are inseparable on global token-set similarity). Durable remedy is offline +
    // project-scoped (gbrain pattern), not a write gate — see the qmemd-rso follow-up.
    const r = nearDuplicate(
      "alpha local maven builds require jdk 21 temurin 25 breaks lombok annotation processing cannot find symbol on getters",
      "compiling the alpha repo needs a real jdk 21 because javac 25 stops running the lombok processor so builder methods vanish",
    );
    expect(r.dice).toBeLessThan(0.82);
    expect(r.duplicate).toBe(false);
  });
});

describe("classifyNearMatch (contradiction classifier, 5td)", () => {
  // Called only on a high-similarity near-match (the remember() loop gates on `meets`);
  // decides whether that near-match is a true paraphrase to BLOCK or a likely
  // contradiction/update to SURFACE. v1 is deterministic-only (T1a/T1b/T1c).

  test("T1a: a differing identifier (port/version/number) over shared text → conflict", () => {
    expect(classifyNearMatch(
      "Redpanda Kafka API listens on port 9092 with SASL_SSL",
      "Redpanda Kafka API listens on port 9093 with SASL_SSL",
    )).toBe("conflict");
  });

  test("T1b: an asymmetric negation cue (not/never/cannot) → conflict", () => {
    expect(classifyNearMatch(
      "the alpha crypto verify path is supported in this build",
      "the alpha crypto verify path is not supported in this build",
    )).toBe("conflict");
  });

  test("T1c: a split antonym pair (enabled/disabled) → conflict", () => {
    expect(classifyNearMatch(
      "TLS certificate verification is enabled on the S3 client",
      "TLS certificate verification is disabled on the S3 client",
    )).toBe("conflict");
  });

  test("a true paraphrase with no conflict cue → duplicate (the dedup to keep)", () => {
    expect(classifyNearMatch(
      "Redpanda broker runs on the lab pi server",
      "Redpanda broker runs on lab pi node",
    )).toBe("duplicate");
  });

  test("a word merely ENDING in 'nt' (agent/daemon) is NOT a negation cue → duplicate", () => {
    // Regression for the n't contraction branch: it must require the apostrophe, else any
    // word ending in 'nt' (agent, component, deployment, grant…) reads as an asymmetric
    // negation and a true synonym paraphrase is mis-surfaced as a contradiction.
    expect(classifyNearMatch(
      "the OTEL collector agent forwards spans to the gateway",
      "the OTEL collector daemon forwards spans to the gateway",
    )).toBe("duplicate");
  });

  test("a real n't contraction IS an asymmetric negation cue → conflict", () => {
    expect(classifyNearMatch(
      "the S3 client cert is verified on every request",
      "the S3 client cert isn't verified on every request",
    )).toBe("conflict");
  });

  test("a paraphrase that PRESERVES a comparative 'not' stays symmetric → duplicate (regression)", () => {
    // 'not' is load-bearing in 'use Bun not Node'; a faithful reword keeps it, so the cue
    // is present on BOTH sides → no polarity flip → still a duplicate, not a contradiction.
    expect(classifyNearMatch(
      "Use Bun not Node for this repo",
      "For this repo use Bun and not Node",
    )).toBe("duplicate");
  });

  test("every antonym member survives dedup tokenization — no stopword-shadowed dead pair (qmemd-c2x)", () => {
    // A pair whose member tokenizeForDedup strips can never fire antonymConflict (the token
    // is gone before the sets are built). 'on' is a DEDUP_STOPWORD, so ['on','off'] was dead.
    for (const member of ANTONYM_PAIRS.flat()) {
      expect(tokenizeForDedup(member)).toContain(member);
    }
  });
});

describe("authorityTier (qmemd-vkn)", () => {
  test("maps type to an authority ordinal: user/feedback > project > reference", async () => {
    const { authorityTier } = await import("../src/engine.js");
    expect(authorityTier("user")).toBe(2);
    expect(authorityTier("feedback")).toBe(2);
    expect(authorityTier("project")).toBe(1);
    expect(authorityTier("reference")).toBe(0);
  });
});

describe("serializeMemory / parseMemory round-trip", () => {
  const fm: MemoryFrontmatter = {
    name: "lm-studio-embed-host",
    description: "LM Studio embedding host on the Windows box",
    type: "reference",
    tags: ["embedding", "lab"],
    project: "global",
    platforms: [],
    created: "2026-05-29",
    pinned: false,
    source: "local-infra notes",
  };

  test("serialize produces frontmatter + body", () => {
    const out = serializeMemory(fm, "The fact body.\n");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("name: lm-studio-embed-host");
    expect(out).toContain("type: reference");
    expect(out).toContain("tags: [embedding, lab]");
    expect(out).toContain("pinned: false");
    expect(out.trimEnd().endsWith("The fact body.")).toBe(true);
  });

  test("parse recovers frontmatter and body", () => {
    const out = serializeMemory(fm, "The fact body.\n");
    const parsed = parseMemory(out);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe("The fact body.\n");
  });

  test("parse tolerates missing optional fields", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\ncreated: 2026-05-29\n---\nbody`;
    const parsed = parseMemory(text);
    expect(parsed.frontmatter.name).toBe("x");
    expect(parsed.frontmatter.tags).toEqual([]);
    expect(parsed.frontmatter.pinned).toBe(false);
    expect(parsed.frontmatter.project).toBe("global");
  });

  test("serializeMemory emits valid double-quoted YAML for tricky values (z4p)", () => {
    const tricky: MemoryFrontmatter = {
      name: "tricky-yaml",
      description: '"x": colon, quote, and # hash',
      type: "project", tags: [], project: "global",
      created: "2026-05-31", pinned: false,
    };
    const out = serializeMemory(tricky, "body");
    const descRaw = out.split("\n").find(l => l.startsWith("description: "))!.slice("description: ".length);
    expect(() => JSON.parse(descRaw)).not.toThrow();
    expect(JSON.parse(descRaw)).toBe(tricky.description);
    expect(parseMemory(out).frontmatter.description).toBe(tricky.description);
  });

  test("legacy bare quote-wrapped value (no special chars) is preserved, not stripped (z4p backward-compat)", () => {
    // A file from the OLD always-bare serializer whose value literally began+ended
    // with a quote (the fact's first line was a quoted sentence). The quotes are
    // PART of the value and must survive a read unchanged.
    const legacy = [
      "---",
      'description: "A quoted sentence with no colon"',
      "name: legacy-quoted",
      "type: project",
      "---",
      "body",
    ].join("\n");
    expect(parseMemory(legacy).frontmatter.description).toBe('"A quoted sentence with no colon"');
  });

  test("legacy bare value containing a colon round-trips through parseMemory (z4p coverage)", () => {
    const legacy = `---\ndescription: host: 1234 and more\nname: legacy-colon\ntype: project\n---\nbody`;
    expect(parseMemory(legacy).frontmatter.description).toBe("host: 1234 and more");
  });

  test("a new value that genuinely needs quoting round-trips (z4p)", () => {
    const fm: MemoryFrontmatter = {
      name: "needs-q", description: "key: value with colon", type: "user",
      tags: [], project: "global", created: "2026-05-31", pinned: false,
    };
    const out = serializeMemory(fm, "b");
    expect(out).toContain('description: "key: value with colon"');
    expect(parseMemory(out).frontmatter.description).toBe("key: value with colon");
  });

  test("a value with literal embedded quotes round-trips (z4p)", () => {
    const fm: MemoryFrontmatter = {
      name: "q", description: '"already quoted"', type: "user",
      tags: [], project: "global", created: "2026-05-31", pinned: false,
    };
    const out = serializeMemory(fm, "b");
    expect(parseMemory(out).frontmatter.description).toBe('"already quoted"');
  });

  test("reserved YAML scalars are quoted, not emitted bare (z4p reserved-scalar)", () => {
    // A strict YAML parser type-coerces these bare tokens to bool/number/null,
    // not the intended string. They must be double-quoted on the wire and still
    // round-trip back to the original string through parseMemory.
    const reserved = ["true", "false", "null", "~", "123", "+123", "-7", "1.5",
      ".inf", ".nan", "0o17", "0x1f", "NULL", "True", "yes", "off"];
    for (const v of reserved) {
      const fm: MemoryFrontmatter = {
        name: "n", description: v, type: "user",
        tags: [], project: "global", created: "2026-05-31", pinned: false,
      };
      const out = serializeMemory(fm, "b");
      const descRaw = out.split("\n").find(l => l.startsWith("description: "))!.slice("description: ".length);
      expect(descRaw.startsWith('"')).toBe(true);   // quoted, not bare
      expect(JSON.parse(descRaw)).toBe(v);          // valid double-quoted YAML scalar
      expect(parseMemory(out).frontmatter.description).toBe(v);
    }
  });

  test("a tag containing a comma or bracket survives the round-trip, not split (a08)", () => {
    const fm: MemoryFrontmatter = {
      name: "n", description: "d", type: "reference",
      tags: ["normal", "a, b", "with]bracket", "trailing "], project: "global",
      created: "2026-05-31", pinned: false,
    };
    const out = serializeMemory(fm, "b");
    expect(parseMemory(out).frontmatter.tags).toEqual(["normal", "a, b", "with]bracket", "trailing "]);
  });

  test("a tag containing a flow-mapping brace is quoted so the sequence stays strict-YAML-valid (a08 braces)", () => {
    // {/} are flow indicators: bare `tags: [x{y]` is rejected by a strict YAML
    // parser even though qmemd's lenient split would round-trip it.
    const fm: MemoryFrontmatter = {
      name: "n", description: "d", type: "reference",
      tags: ["x{y"], project: "global", created: "2026-05-31", pinned: false,
    };
    const out = serializeMemory(fm, "b");
    expect(out.split("\n").find(l => l.startsWith("tags: "))).toBe('tags: ["x{y"]');
    expect(parseMemory(out).frontmatter.tags).toEqual(["x{y"]);
  });

  test("plain tags stay bare (a08 backward-compat)", () => {
    const fm: MemoryFrontmatter = {
      name: "n", description: "d", type: "reference",
      tags: ["embedding", "lab"], project: "global",
      created: "2026-05-31", pinned: false,
    };
    expect(serializeMemory(fm, "b")).toContain("tags: [embedding, lab]");
  });

  test("quote-only-when-needed invariant: legacy unnecessary quotes preserved, code-written needs-quote round-trips exactly (0n6)", () => {
    // Quote-only-when-needed (qmemd-0n6). A legacy, hand-edited value that was
    // double-quoted but did NOT need quoting is PRESERVED verbatim — qmemd cannot
    // tell it apart from a fact whose text is itself a quoted sentence, so it
    // keeps the quotes rather than risk silently dropping data.
    const legacy = `---\nname: "simple text"\ndescription: d\ntype: project\ncreated: 2026-05-31\n---\nbody`;
    const parsed = parseMemory(legacy);
    expect(parsed.frontmatter.name).toBe('"simple text"');
    // Re-serializing keeps the value intact (it now contains literal quotes,
    // which DO need quoting, so it survives the round-trip).
    expect(parseMemory(serializeMemory(parsed.frontmatter, parsed.body)).frontmatter.name)
      .toBe('"simple text"');
    // A code-written value that genuinely needs quoting round-trips exactly:
    // only-when-needed quoting means no data loss for files the code writes.
    const fm: MemoryFrontmatter = {
      name: "key: val", description: "d", type: "project",
      tags: [], project: "global", created: "2026-05-31", pinned: false,
    };
    const out = serializeMemory(fm, "b");
    expect(out).toContain('name: "key: val"');           // quoted only because it needs it
    expect(parseMemory(out).frontmatter.name).toBe("key: val"); // decodes back exactly
  });
});

describe("temporal/supersession frontmatter (bri)", () => {
  const base: MemoryFrontmatter = {
    name: "f", description: "d", type: "project",
    tags: [], project: "global", platforms: [], created: "2026-06-10", pinned: false,
  };

  it("round-trips updated/supersedes/superseded_by/conflicts_with", () => {
    const fm: MemoryFrontmatter = {
      ...base,
      updated: "2026-06-10T14:32:05.123Z",
      supersedes: "old-fact",
      supersededBy: "new-fact",
      conflictsWith: "rival-fact",
    };
    const parsed = parseMemory(serializeMemory(fm, "body"));
    expect(parsed.frontmatter.updated).toBe("2026-06-10T14:32:05.123Z");
    expect(parsed.frontmatter.supersedes).toBe("old-fact");
    expect(parsed.frontmatter.supersededBy).toBe("new-fact");
    expect(parsed.frontmatter.conflictsWith).toBe("rival-fact");
  });

  it("omits absent fields from serialization and parses legacy facts unchanged", () => {
    const out = serializeMemory(base, "body");
    expect(out).not.toContain("updated:");
    expect(out).not.toContain("supersedes:");
    expect(out).not.toContain("superseded_by:");
    expect(out).not.toContain("conflicts_with:");
    const parsed = parseMemory(out);
    expect(parsed.frontmatter.updated).toBeUndefined();
    expect(parsed.frontmatter.supersedes).toBeUndefined();
    expect(parsed.frontmatter.supersededBy).toBeUndefined();
    expect(parsed.frontmatter.conflictsWith).toBeUndefined();
  });

  it("serializes the new fields after pinned, before source", () => {
    const out = serializeMemory({ ...base, updated: "2026-06-10T00:00:00.000Z", supersedes: "x", source: "s" }, "body");
    const lines = out.split("\n");
    const idx = (prefix: string) => lines.findIndex(l => l.startsWith(prefix));
    expect(idx("pinned:")).toBeLessThan(idx("updated:"));
    expect(idx("updated:")).toBeLessThan(idx("supersedes:"));
    expect(idx("supersedes:")).toBeLessThan(idx("source:"));
  });

  it("treats an empty value as absent", () => {
    const parsed = parseMemory("---\nname: f\ntype: project\nsuperseded_by:\nupdated:\n---\n\nbody\n");
    expect(parsed.frontmatter.supersededBy).toBeUndefined();
    expect(parsed.frontmatter.updated).toBeUndefined();
  });
});

describe("truncateToBytes", () => {
  test("never splits an astral codepoint into a replacement char (1ds)", () => {
    // 😀 is 4 UTF-8 bytes / a UTF-16 surrogate pair. Cutting mid-pair must not
    // leave a lone surrogate (which serialises to the 3-byte U+FFFD '�').
    expect(truncateToBytes("😀😀😀", 3)).toBe("");
    expect(truncateToBytes("😀😀😀", 4)).toBe("😀");
    expect(truncateToBytes("😀😀😀", 7)).toBe("😀");
    for (let n = 0; n <= 13; n++) {
      const r = truncateToBytes("😀😀😀", n);
      // lossless UTF-8 round-trip ⇒ no codepoint was split
      expect(Buffer.from(r, "utf-8").toString("utf-8")).toBe(r);
      expect(Buffer.byteLength(r, "utf-8")).toBeLessThanOrEqual(n);
    }
  });

  test("BMP multibyte and ASCII still truncate to the byte budget", () => {
    expect(truncateToBytes("héllo", 100)).toBe("héllo");   // fits
    expect(Buffer.byteLength(truncateToBytes("héllo", 3), "utf-8")).toBeLessThanOrEqual(3);
    expect(truncateToBytes("abc", 2)).toBe("ab");
  });
});

describe("firstLine (qmemd-yul)", () => {
  test("never splits an astral codepoint at the cut into a lone surrogate", () => {
    // 199 ASCII + 😀 (a surrogate pair straddling units 199/200): a UTF-16 slice(0,200)
    // keeps only the high surrogate, which serialises to the 3-byte U+FFFD '�'.
    const out = firstLine("a".repeat(199) + "😀");
    // lossless UTF-8 round-trip ⇒ no lone surrogate was emitted
    expect(Buffer.from(out, "utf-8").toString("utf-8")).toBe(out);
    expect(out.endsWith("😀")).toBe(true);
  });

  test("caps the first line at 200 codepoints, never half an astral char", () => {
    // 500 emoji = 1000 UTF-16 units; a unit-based slice(0,200) yields 100 whole emoji,
    // a codepoint-based slice yields 200. Either way the result must round-trip cleanly.
    const out = firstLine("😀".repeat(500));
    expect(Array.from(out).length).toBe(200);
    expect(Buffer.from(out, "utf-8").toString("utf-8")).toBe(out);
  });
});

describe("memoryFilePath", () => {
  test("joins root/type/slug.md", () => {
    expect(memoryFilePath("/m", "feedback", "be-terse")).toBe("/m/feedback/be-terse.md");
  });
});

describe("assertSafeSlug (fd8)", () => {
  test("accepts a normal kebab slug and the deterministic fallback slug", () => {
    expect(() => assertSafeSlug("indent-pref")).not.toThrow();
    expect(() => assertSafeSlug("redpanda-runs-on-the-lab-pi")).not.toThrow();
    expect(() => assertSafeSlug("mem-0123456789ab")).not.toThrow();
    // Every slug slugify() can emit must pass the guard, or legitimate writes break.
    expect(() => assertSafeSlug(slugify("Use Bun not Node") || "x")).not.toThrow();
  });

  test("rejects path separators and parent traversal (arbitrary .md write/delete)", () => {
    for (const bad of ["../../../../home/u/.claude/CLAUDE", "a/b", "a\\b", "..", "x/../y", "/abs"]) {
      expect(() => assertSafeSlug(bad)).toThrow(/unsafe slug/);
    }
  });

  test("rejects newline/carriage-return (git commit-message injection)", () => {
    expect(() => assertSafeSlug("ok\nCo-Authored-By: Evil <e@x>")).toThrow(/unsafe slug/);
    expect(() => assertSafeSlug("ok\rinjected")).toThrow(/unsafe slug/);
  });

  test("rejects the empty slug (collapses to a hidden, unrecallable dotfile)", () => {
    expect(() => assertSafeSlug("")).toThrow(/unsafe slug/);
  });
});

describe("recallSession", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("emits user + feedback bodies under a Memory header", async () => {
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(join(root, "user", "be-terse.md"), serializeMemory(
      { name: "be-terse", description: "Be terse", type: "user", tags: [], project: "global", created: "2026-05-29", pinned: false },
      "Always answer tersely."));
    const out = await recallSession(root, { project: "global" });
    expect(out).toContain("## Memory");
    expect(out).toContain("Be terse");
    expect(out).toContain("Always answer tersely.");
  });

  test("empty store yields empty string", async () => {
    expect(await recallSession(root, {})).toBe("");
  });

  test("default description (= body's first line) is not echoed above the body (8hk)", async () => {
    await mkdir(join(root, "feedback"), { recursive: true });
    const body = "Keep memories in a dedicated repo.\nDo not mix specs into the store.";
    // description equals the body's first line — the firstLine() default.
    await writeFile(join(root, "feedback", "dup.md"), serializeMemory(
      { name: "dup", description: "Keep memories in a dedicated repo.", type: "feedback", tags: [], project: "global", created: "2026-06-04", pinned: false },
      body));
    const out = await recallSession(root, { project: "global" });
    // First line appears exactly once — folded into the label, not repeated above the body.
    expect(out.split("Keep memories in a dedicated repo.").length - 1).toBe(1);
    expect(out).toContain("[feedback] Keep memories in a dedicated repo.");
    expect(out).toContain("Do not mix specs into the store."); // rest of body still present
  });

  test("a curated description (differs from body's first line) is still shown above the body (8hk)", async () => {
    await mkdir(join(root, "feedback"), { recursive: true });
    await writeFile(join(root, "feedback", "curated.md"), serializeMemory(
      { name: "curated", description: "Memory hygiene", type: "feedback", tags: [], project: "global", created: "2026-06-04", pinned: false },
      "Keep memories in a dedicated repo."));
    const out = await recallSession(root, { project: "global" });
    expect(out).toContain("[feedback] Memory hygiene");
    expect(out).toContain("Keep memories in a dedicated repo.");
  });

  test("over-budget user fact is truncated with ellipsis, not dropped (vwp)", async () => {
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(join(root, "user", "big.md"), serializeMemory(
      { name: "big", description: "Big user fact", type: "user", tags: [], project: "global", created: "2026-05-31", pinned: false },
      "X".repeat(5000)));
    const out = await recallSession(root, { project: "global", budgetBytes: 500 });
    expect(out).toContain("Big user fact");
    expect(out).toContain("…");
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(500);
    expect(out).not.toContain("X".repeat(5000));
  });

  test("trailing '(N more)' line never pushes output past the hard byte budget (vwp)", async () => {
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(join(root, "user", "a.md"), serializeMemory(
      { name: "a", description: "Fact A", type: "user", tags: [], project: "global", created: "2026-05-31", pinned: false },
      "X".repeat(5000)));
    await writeFile(join(root, "user", "b.md"), serializeMemory(
      { name: "b", description: "Fact B", type: "user", tags: [], project: "global", created: "2026-05-31", pinned: false },
      "Y".repeat(5000)));
    // First fact truncates to fill the budget; the second is dropped → a trailing
    // "(1 more …)" line would overflow unless it is itself budget-guarded.
    const out = await recallSession(root, { project: "global", budgetBytes: 300 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(300);
  });

  test("budget smaller than the header yields empty string, never an over-cap header (62p)", async () => {
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(join(root, "user", "x.md"), serializeMemory(
      { name: "x", description: "X", type: "user", tags: [], project: "global", created: "2026-05-31", pinned: false },
      "body"));
    // "## Memory (qmd)" is 15 bytes; any budget below that must NOT emit it.
    for (const b of [1, 5, 10, 14]) {
      const out = await recallSession(root, { project: "global", budgetBytes: b });
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(b);
    }
  });

  describe("env overrides QMEMD_SESSION_BUDGET / QMEMD_SESSION_PROJECT_LIMIT (y6s)", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      saved.budget = process.env.QMEMD_SESSION_BUDGET;
      saved.limit = process.env.QMEMD_SESSION_PROJECT_LIMIT;
    });
    afterEach(() => {
      if (saved.budget === undefined) delete process.env.QMEMD_SESSION_BUDGET; else process.env.QMEMD_SESSION_BUDGET = saved.budget;
      if (saved.limit === undefined) delete process.env.QMEMD_SESSION_PROJECT_LIMIT; else process.env.QMEMD_SESSION_PROJECT_LIMIT = saved.limit;
    });

    const seedUser = async (name: string, body: string) => {
      await mkdir(join(root, "user"), { recursive: true });
      await writeFile(join(root, "user", `${name}.md`), serializeMemory(
        { name, description: `Fact ${name}`, type: "user", tags: [], project: "global", created: "2026-05-31", pinned: false },
        body));
    };
    const seedProject = async (name: string, created: string) => {
      await mkdir(join(root, "project"), { recursive: true });
      await writeFile(join(root, "project", `${name}.md`), serializeMemory(
        { name, description: `Project fact ${name}`, type: "project", tags: [], project: "demo", created, pinned: false },
        `Body of ${name}`));
    };

    test("QMEMD_SESSION_BUDGET caps output like budgetBytes", async () => {
      await seedUser("big", "X".repeat(5000));
      process.env.QMEMD_SESSION_BUDGET = "300";
      const out = await recallSession(root, { project: "global" });
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(300);
      expect(out).toContain("## Memory");
    });

    test("explicit budgetBytes opt wins over the env var", async () => {
      await seedUser("big", "X".repeat(5000));
      process.env.QMEMD_SESSION_BUDGET = "3000";
      const out = await recallSession(root, { project: "global", budgetBytes: 150 });
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(150);
    });

    test("QMEMD_SESSION_PROJECT_LIMIT lowers the project slice", async () => {
      await seedProject("p1", "2026-06-01");
      await seedProject("p2", "2026-06-02");
      await seedProject("p3", "2026-06-03");
      process.env.QMEMD_SESSION_PROJECT_LIMIT = "1";
      const out = await recallSession(root, { project: "demo" });
      expect(out).toContain("Project fact p3"); // newest survives
      expect(out).not.toContain("Project fact p2");
      expect(out).not.toContain("Project fact p1");
      expect(out).toContain("(1 shown, 2 more)");
    });

    test("QMEMD_SESSION_PROJECT_LIMIT raises the project slice above the default 5", async () => {
      for (let i = 1; i <= 7; i++) await seedProject(`p${i}`, `2026-06-0${i}`);
      process.env.QMEMD_SESSION_PROJECT_LIMIT = "7";
      const out = await recallSession(root, { project: "demo" });
      for (let i = 1; i <= 7; i++) expect(out).toContain(`Project fact p${i}`);
      expect(out).not.toContain("more)"); // no gap footer — nothing dropped
    });

    test("invalid QMEMD_SESSION_BUDGET falls back to the 2000 default (hook path must never break)", async () => {
      await seedUser("big", "X".repeat(5000));
      process.env.QMEMD_SESSION_BUDGET = "abc";
      const out = await recallSession(root, { project: "global" });
      // falls back to 2000 — neither NaN/0 (empty output) nor unbounded (5000+ bytes)
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2000);
      expect(Buffer.byteLength(out, "utf-8")).toBeGreaterThan(300);
    });

    test("invalid QMEMD_SESSION_PROJECT_LIMIT falls back to the 5 default", async () => {
      await seedProject("p1", "2026-06-01");
      process.env.QMEMD_SESSION_PROJECT_LIMIT = "0";
      const out = await recallSession(root, { project: "demo" });
      // limit falls back to 5 (not 0): the project fact still surfaces
      expect(out).toContain("Project fact p1");
    });
  });

  test("a recent non-pinned reference (global or current project) appears (bgf)", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    await writeFile(join(root, "reference", "useful-url.md"), serializeMemory(
      { name: "useful-url", description: "Grafana dashboard URL", type: "reference", tags: [], project: "global", created: "2026-06-01", pinned: false },
      "https://grafana.example/d/abc"));
    const out = await recallSession(root, { project: "global" });
    expect(out).toContain("Grafana dashboard URL");
    expect(out).toContain("reference:global");
  });

  test("a reference scoped to a different project does not appear (bgf)", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    await writeFile(join(root, "reference", "other-proj-ref.md"), serializeMemory(
      { name: "other-proj-ref", description: "Other project ref", type: "reference", tags: [], project: "other-proj", created: "2026-06-01", pinned: false },
      "body"));
    // The only fact is a non-matching reference → nothing surfaces (empty snapshot).
    expect(await recallSession(root, { project: "global" })).toBe("");
  });

  test("a pinned reference appears once (pinned block), not duplicated in references (bgf)", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    await writeFile(join(root, "reference", "pinned-ref.md"), serializeMemory(
      { name: "pinned-ref", description: "Pinned reference fact", type: "reference", tags: [], project: "global", created: "2026-06-01", pinned: true },
      "body"));
    const out = await recallSession(root, { project: "global" });
    expect(out.split("Pinned reference fact").length - 1).toBe(1); // exactly one occurrence
    expect(out).toContain("pinned:reference");
  });

  // 57d: pin and project are different axes — project = scope (where the fact surfaces),
  // pin = priority (never falls out of the recency slice WITHIN that scope). A pinned fact
  // scoped to another project must not inject into this project's snapshot; that cross-repo
  // bleed is exactly the 3gv incident (an beta JDK fact priming unrelated repos).
  test("a pinned fact scoped to ANOTHER project is hidden — pin does not widen scope (57d)", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "jdk.md"), serializeMemory(
      { name: "jdk", description: "beta needs JDK 21", type: "project", tags: [], project: "beta", created: "2026-06-01", pinned: true },
      "body"));
    // The only fact is a pinned fact for a different project → nothing surfaces.
    expect(await recallSession(root, { project: "qmemd" })).toBe("");
  });

  test("a pinned fact for the CURRENT project still appears (57d)", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "jdk.md"), serializeMemory(
      { name: "jdk", description: "beta needs JDK 21", type: "project", tags: [], project: "beta", created: "2026-06-01", pinned: true },
      "body"));
    const out = await recallSession(root, { project: "beta" });
    expect(out).toContain("beta needs JDK 21");
    expect(out).toContain("pinned:project");
  });

  test("a project:global pinned fact appears in every project's snapshot (57d)", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "everywhere.md"), serializeMemory(
      { name: "everywhere", description: "Global pinned guidance", type: "project", tags: [], project: "global", created: "2026-06-01", pinned: true },
      "body"));
    const out = await recallSession(root, { project: "qmemd" });
    expect(out).toContain("Global pinned guidance");
    expect(out).toContain("pinned:project");
  });

  test("a pinned in-scope fact still bypasses the projectLimit recency slice (57d)", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    // Two newer non-pinned facts fill a projectLimit:2 slice; the OLD pinned fact must
    // still surface (via the pinned block) — pin exempts it from recency, within scope.
    await writeFile(join(root, "project", "new-a.md"), serializeMemory(
      { name: "new-a", description: "Newer fact A", type: "project", tags: [], project: "qmemd", created: "2026-06-05", pinned: false }, "a"));
    await writeFile(join(root, "project", "new-b.md"), serializeMemory(
      { name: "new-b", description: "Newer fact B", type: "project", tags: [], project: "qmemd", created: "2026-06-04", pinned: false }, "b"));
    await writeFile(join(root, "project", "old-pin.md"), serializeMemory(
      { name: "old-pin", description: "Old pinned anchor", type: "project", tags: [], project: "qmemd", created: "2026-01-01", pinned: true }, "c"));
    const out = await recallSession(root, { project: "qmemd", projectLimit: 2 });
    expect(out).toContain("Newer fact A");
    expect(out).toContain("Newer fact B");
    expect(out).toContain("Old pinned anchor");
  });

  test("the references block respects projectLimit (default 5) (bgf)", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    for (let i = 0; i < 7; i++) {
      await writeFile(join(root, "reference", `ref-${i}.md`), serializeMemory(
        { name: `ref-${i}`, description: `Reference number ${i}`, type: "reference", tags: [], project: "global", created: `2026-06-0${i + 1}`, pinned: false },
        "body"));
    }
    const out = await recallSession(root, { project: "global" });
    expect(out.split("\n").filter(l => l.includes("reference:global")).length).toBeLessThanOrEqual(5);
  });

  // qmemd-e3i — surface the silent slice-drop: projects/references beyond projectLimit
  // were dropped with ZERO signal (postmortem R1). Footer must announce the gap.
  const writeProject = async (root: string, i: number, created: string, tags: string[]) => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", `p-${i}.md`), serializeMemory(
      { name: `p-${i}`, description: `Project fact ${i}`, type: "project", tags, project: "alpha", created, pinned: false },
      "body"));
  };

  test("surfaces unshown project count when in-scope facts exceed projectLimit (e3i)", async () => {
    for (let i = 0; i < 14; i++) await writeProject(root, i, `2026-06-${String(i + 1).padStart(2, "0")}`, []);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 4000 });
    expect(out).toContain("14 project facts for alpha (5 shown, 9 more)");
    expect(out).toContain("qmemd list --type project --project alpha");
  });

  test("no unshown footer when in-scope facts fit within projectLimit (e3i)", async () => {
    for (let i = 0; i < 3; i++) await writeProject(root, i, `2026-06-0${i + 1}`, []);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 4000 });
    expect(out).not.toContain("shown,");
    expect(out).not.toContain("Unshown tags:");
  });

  test("unshown-tag histogram lists hidden facts' tags by frequency, desc (e3i)", async () => {
    // 5 newest (shown) carry no tags; the 9 older (unshown) carry the tags we histogram.
    for (let i = 0; i < 5; i++) await writeProject(root, i, `2026-06-2${i}`, []);
    for (let i = 0; i < 4; i++) await writeProject(root, 100 + i, `2026-06-0${i + 1}`, ["security"]);
    for (let i = 0; i < 3; i++) await writeProject(root, 200 + i, `2026-06-1${i}`, ["jdk"]);
    for (let i = 0; i < 2; i++) await writeProject(root, 300 + i, `2026-05-2${i}`, ["crypto"]);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 4000 });
    expect(out).toContain("Unshown tags: security(4) jdk(3) crypto(2)");
  });

  test("unshown footer is dropped (not overflowed) when the budget has no room (e3i)", async () => {
    for (let i = 0; i < 14; i++) await writeProject(root, i, `2026-06-${String(i + 1).padStart(2, "0")}`, ["jdk"]);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 100 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(100);
    expect(out).not.toContain("more)");
    expect(out).not.toContain("Unshown tags:");
  });

  test("histogram never appears without its count footer when budget drops the footer (e3i)", async () => {
    // 5 newest (shown) tagless; 1 oldest (unshown) tagged. Budget fits neither the
    // ~93-byte footer nor the project lines, but the short histogram WOULD fit alone —
    // it must not orphan itself above a missing count footer.
    for (let i = 0; i < 5; i++) await writeProject(root, i, `2026-06-1${i}`, []);
    await writeProject(root, 99, "2026-06-01", ["security"]);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 50 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(50);
    expect(out).not.toContain("Unshown tags:");
    // General invariant: a histogram is only meaningful beneath its count footer.
    if (out.includes("Unshown tags:")) expect(out).toMatch(/\d+ more\)/);
  });

  test("footer 'shown' count reflects facts actually emitted, not the slice length, under budget pressure (e3i)", async () => {
    // 8 in-scope facts with long descriptions; a mid-range budget admits the footer
    // but budget-drops some of the 5 sliced facts. 'shown' must equal the lines that
    // actually appear, and shown + more must equal the true in-scope total (8).
    const longDesc = "D".repeat(220);
    for (let i = 0; i < 8; i++) {
      await mkdir(join(root, "project"), { recursive: true });
      await writeFile(join(root, "project", `p-${i}.md`), serializeMemory(
        { name: `p-${i}`, description: longDesc, type: "project", tags: [], project: "alpha", created: `2026-06-0${i + 1}`, pinned: false },
        "body"));
    }
    const out = await recallSession(root, { project: "alpha", budgetBytes: 1100 });
    const m = out.match(/\((\d+) shown, (\d+) more\)/);
    expect(m).not.toBeNull();
    const shown = Number(m![1]), more = Number(m![2]);
    const projLines = out.split("\n").filter(l => l.startsWith("[project:alpha]")).length;
    expect(shown).toBe(projLines);     // 'shown' == lines actually emitted
    expect(shown + more).toBe(8);      // accounts for every in-scope fact
  });

  test("unshown count is surfaced for references too (e3i)", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, "reference", `r-${i}.md`), serializeMemory(
        { name: `r-${i}`, description: `Ref ${i}`, type: "reference", tags: [], project: "global", created: `2026-06-0${i + 1}`, pinned: false },
        "body"));
    }
    const out = await recallSession(root, { project: "global", budgetBytes: 4000 });
    expect(out).toContain("8 reference facts for global (5 shown, 3 more)");
    expect(out).toContain("qmemd list --type reference --project global");
  });

  test("coverage footer still ships when always-on feedback bodies fill the budget (mqt)", async () => {
    // Always-on feedback bodies large enough to exceed the 2000-byte cap on their own —
    // emitted FIRST with full bodies, they starve the e3i gap signal that emits last.
    await mkdir(join(root, "feedback"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      const body = `Feedback fact ${i}. ` + "x".repeat(250);
      await writeFile(join(root, "feedback", `fb-${i}.md`), serializeMemory(
        { name: `fb-${i}`, description: body, type: "feedback", tags: [], project: "global", created: `2026-06-0${i + 1}`, pinned: false },
        body));
    }
    // ...plus a project corpus over projectLimit, so a slice-gap exists and the footer must fire.
    for (let i = 0; i < 14; i++) await writeProject(root, i, `2026-06-${String(i + 1).padStart(2, "0")}`, ["win"]);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 2000 });
    // The gap signal must survive the feedback flood (postmortem R1 / qmemd-mqt) and never
    // push past the hard cap.
    expect(out).toContain("qmemd list --type project --project alpha");
    expect(out).toMatch(/\(\d+ shown, \d+ more\)/);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2000);
  });

  test("Unshown-tags histogram survives the same feedback flood the footer survives (a1d)", async () => {
    // Same flood as the mqt test: always-on feedback bodies large enough to fill the 2000-byte
    // cap. The mqt fix reserved the footer's bytes so the gap COUNT survives; a1d extends the
    // reservation to the histogram so the topic HINT survives too instead of being dropped after
    // the footer. All unshown facts share one tag so the histogram content is deterministic.
    await mkdir(join(root, "feedback"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      const body = `Feedback fact ${i}. ` + "x".repeat(250);
      await writeFile(join(root, "feedback", `fb-${i}.md`), serializeMemory(
        { name: `fb-${i}`, description: body, type: "feedback", tags: [], project: "global", created: `2026-06-0${i + 1}`, pinned: false },
        body));
    }
    for (let i = 0; i < 14; i++) await writeProject(root, i, `2026-06-${String(i + 1).padStart(2, "0")}`, ["win"]);
    const out = await recallSession(root, { project: "alpha", budgetBytes: 2000 });
    expect(out).toMatch(/\(\d+ shown, \d+ more\)/);     // footer (mqt) still present
    expect(out).toMatch(/Unshown tags: win\(\d+\)/);    // histogram hint survives (a1d)
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2000);
  });

  test("the histogram is capped to a fitting tag prefix when the full set exceeds the reserve (a1d)", async () => {
    // A diverse unshown tag vocabulary whose full "Unshown tags:" line (~173 bytes) exceeds the
    // bounded reserve cap (120). Under a feedback flood the emit-time cap-to-fit must keep the
    // highest-count tags and trim the long tail rather than drop the whole hint — exercising the
    // prefix-shrink branch (review finding), not just the full-fit path the single-tag test covers.
    await mkdir(join(root, "feedback"), { recursive: true });
    for (let i = 0; i < 6; i++) {
      const body = `Feedback fact ${i}. ` + "x".repeat(250);
      await writeFile(join(root, "feedback", `fb-${i}.md`), serializeMemory(
        { name: `fb-${i}`, description: body, type: "feedback", tags: [], project: "global", created: `2026-06-0${i + 1}`, pinned: false }, body));
    }
    await mkdir(join(root, "project"), { recursive: true });
    const mk = (i: number, created: string, tags: string[]) => writeFile(join(root, "project", `p-${i}.md`), serializeMemory(
      { name: `p-${i}`, description: `Project fact ${i}`, type: "project", tags, project: "alpha", created, pinned: false }, "body"));
    for (let i = 0; i < 5; i++) await mk(900 + i, `2026-06-2${i}`, []);              // newest 5 shown, tagless
    for (let i = 0; i < 3; i++) await mk(100 + i, `2026-06-1${i}`, ["topcommon"]);   // count 3 (sorts first)
    for (let i = 0; i < 7; i++) await mk(200 + i, `2026-05-0${i + 1}`, [`distincttaglong0${i}`]); // count 1 each
    const out = await recallSession(root, { project: "alpha", budgetBytes: 1500 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(1500);
    expect(out).toMatch(/\(\d+ shown, \d+ more\)/);              // footer present
    expect(out).toContain("Unshown tags: topcommon(3)");        // highest-count tag kept, first
    expect(out).not.toContain("distincttaglong06");             // long tail trimmed (truncation ran)
    const histLine = out.split("\n").find(l => l.startsWith("Unshown tags:")) ?? "";
    expect((histLine.match(/distincttaglong/g) ?? []).length).toBeLessThan(7); // strict prefix, not all
  });

  test("Unshown-tags histogram survives a second lane's budget-drop footer at the default budget (qmemd-trp)", async () => {
    // Regression for qmemd-trp. a1d reserved bytes for the histogram, but reserveFooter only
    // reserved a lane's footer on SLICE-OVERFLOW (inScope > projectLimit). A footer ALSO fires
    // when a lane is BUDGET-DROPPED (its slice fit count-wise but bytes pushed the one-liners
    // out). Here the reference lane has only 2 facts (<= projectLimit 5, so it was never
    // reserved), yet the tight default budget drops one -> its UNRESERVED footer fires and ate
    // the histogram's reserved tail, leaving the bare "(N shown, M more)" nag with no topic
    // hint -- the exact failure e3i/a1d exist to prevent (postmortem 2026-06-09).
    //
    // Corpus mirrors the wild trigger: 2 always-on feedback bodies + 1 pinned project + a
    // 20-fact project lane (slice-overflow -> reserved footer + histogram reserve) + a 2-fact
    // reference lane that budget-drops. The filler length lands bodies at the budget edge where
    // the reference footer competes with the histogram (qmemd-trp byte-ledger, budget=2000).
    await mkdir(join(root, "feedback"), { recursive: true });
    await writeFile(join(root, "feedback", "fb-short.md"), serializeMemory(
      { name: "fb-short", description: "Short feedback.", type: "feedback", tags: [], project: "global", created: "2026-06-09", pinned: false }, "Short feedback body."));
    const filler = "Filler feedback fact. " + "x".repeat(375);
    await writeFile(join(root, "feedback", "fb-filler.md"), serializeMemory(
      { name: "fb-filler", description: filler, type: "feedback", tags: [], project: "global", created: "2026-06-08", pinned: false }, filler));

    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "p-pin.md"), serializeMemory(
      { name: "p-pin", description: "Pinned project fact " + "z".repeat(120), type: "project", tags: [], project: "alpha", created: "2026-06-07", pinned: true }, "body"));
    const ptags = ["alpha", "beta", "gamma"];
    for (let i = 0; i < 20; i++) {
      await writeFile(join(root, "project", `p-${i}.md`), serializeMemory(
        { name: `p-${i}`, description: `Project fact ${i} ` + "q".repeat(120), type: "project", tags: [ptags[i % 3]], project: "alpha", created: `2026-05-${String(i + 1).padStart(2, "0")}`, pinned: false }, "body"));
    }
    await mkdir(join(root, "reference"), { recursive: true });
    for (let i = 0; i < 2; i++) {
      await writeFile(join(root, "reference", `r-${i}.md`), serializeMemory(
        { name: `r-${i}`, description: `Reference fact ${i} ` + "y".repeat(40), type: "reference", tags: ["refwin"], project: "alpha", created: `2026-06-0${i + 1}`, pinned: false }, "body"));
    }

    const out = await recallSession(root, { project: "alpha", budgetBytes: 2000 });
    // Both lanes fire a footer: project via slice-overflow, reference via budget-drop. The
    // reference lane has only 2 facts, so its footer can ONLY be a budget-drop footer.
    expect(out).toMatch(/\d+ project facts for alpha \(\d+ shown, \d+ more\)/);
    expect(out).toMatch(/\d+ reference facts for alpha \(\d+ shown, \d+ more\)/);
    // The topic hint must survive the second footer -- the bug dropped it here.
    expect(out).toMatch(/Unshown tags:/);
    // ...without ever exceeding the hard cap.
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2000);
  });
});

describe("recallSession supersession + recency (bri)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-bri-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("hides superseded facts from every lane, pinned included", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await mkdir(join(root, "feedback"), { recursive: true });
    await writeFile(join(root, "project", "live.md"), serializeMemory(
      { name: "live", description: "live description", type: "project", tags: [], project: "global", created: "2026-01-01", pinned: false },
      "live body"));
    await writeFile(join(root, "project", "retired.md"), serializeMemory(
      { name: "retired", description: "retired description", type: "project", tags: [], project: "global", created: "2026-01-01", pinned: false, supersededBy: "live" },
      "retired body"));
    await writeFile(join(root, "project", "retired-pin.md"), serializeMemory(
      { name: "retired-pin", description: "retired-pin description", type: "project", tags: [], project: "global", created: "2026-01-01", pinned: true, supersededBy: "live" },
      "retired-pin body"));
    await writeFile(join(root, "feedback", "old-guidance.md"), serializeMemory(
      { name: "old-guidance", description: "old-guidance description", type: "feedback", tags: [], project: "global", created: "2026-01-01", pinned: false, supersededBy: "live" },
      "old-guidance body"));
    const snap = await recallSession(root, { project: "global" });
    expect(snap).toContain("live description");
    expect(snap).not.toContain("retired description");
    expect(snap).not.toContain("retired-pin description");
    expect(snap).not.toContain("old-guidance description");
  });

  it("collapses a chain to its head", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "v1.md"), serializeMemory(
      { name: "v1", description: "v1 description", type: "project", tags: [], project: "global", created: "2026-01-01", pinned: false, supersededBy: "v2" },
      "v1 body"));
    await writeFile(join(root, "project", "v2.md"), serializeMemory(
      { name: "v2", description: "v2 description", type: "project", tags: [], project: "global", created: "2026-01-02", pinned: false, supersededBy: "v3", supersedes: "v1" },
      "v2 body"));
    await writeFile(join(root, "project", "v3.md"), serializeMemory(
      { name: "v3", description: "v3 description", type: "project", tags: [], project: "global", created: "2026-01-03", pinned: false, supersedes: "v2" },
      "v3 body"));
    const snap = await recallSession(root, { project: "global" });
    expect(snap).toContain("v3 description");
    expect(snap).not.toContain("v1 description");
    expect(snap).not.toContain("v2 description");
  });

  it("orders same-day facts by the updated instant, legacy facts by created", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "morning.md"), serializeMemory(
      { name: "morning", description: "morning description", type: "project", tags: [], project: "global", created: "2026-06-10", pinned: false, updated: "2026-06-10T08:00:00.000Z" },
      "morning body"));
    await writeFile(join(root, "project", "evening.md"), serializeMemory(
      { name: "evening", description: "evening description", type: "project", tags: [], project: "global", created: "2026-06-10", pinned: false, updated: "2026-06-10T20:00:00.000Z" },
      "evening body"));
    await writeFile(join(root, "project", "legacy.md"), serializeMemory(
      { name: "legacy", description: "legacy description", type: "project", tags: [], project: "global", created: "2026-06-09", pinned: false },
      "legacy body"));
    const snap = await recallSession(root, { project: "global", projectLimit: 2 });
    // newest two of the three survive the slice: evening (T20) and morning (T08), both on 2026-06-10
    // legacy (2026-06-09) falls off the slice
    expect(snap.indexOf("evening description")).toBeGreaterThan(-1);
    expect(snap.indexOf("morning description")).toBeGreaterThan(-1);
    expect(snap.indexOf("evening description")).toBeLessThan(snap.indexOf("morning description"));
    expect(snap).not.toContain("legacy description");
  });

  it("does not report a retired off-platform fact as platform-hidden", async () => {
    // A fact that is BOTH superseded (retired) AND scoped to a foreign platform must vanish
    // silently — it is not an active fact, so it must not be counted in the
    // "platform-scoped … hidden" footer (bri spec-compliance fix).
    await mkdir(join(root, "user"), { recursive: true });
    await mkdir(join(root, "feedback"), { recursive: true });
    // retired user fact on a foreign platform — must NOT contribute to platformHiddenUF
    await writeFile(join(root, "user", "retired-win-pref.md"), serializeMemory(
      { name: "retired-win-pref", description: "retired win pref", type: "user",
        tags: [], project: "global", created: "2026-01-01", pinned: false,
        platforms: ["windows"], supersededBy: "new-pref" },
      "retired windows preference"));
    // retired feedback fact on a foreign platform — same
    await writeFile(join(root, "feedback", "retired-win-guidance.md"), serializeMemory(
      { name: "retired-win-guidance", description: "retired win guidance", type: "feedback",
        tags: [], project: "global", created: "2026-01-01", pinned: false,
        platforms: ["windows"], supersededBy: "new-guidance" },
      "retired windows guidance"));
    // one live cross-platform user fact so the snapshot is non-empty
    await writeFile(join(root, "user", "live-pref.md"), serializeMemory(
      { name: "live-pref", description: "live pref", type: "user",
        tags: [], project: "global", created: "2026-01-02", pinned: false },
      "live preference"));
    const snap = await recallSession(root, { project: "global", platform: "linux" });
    // The retired+off-platform facts must not appear in the platform-hidden signal.
    // Only the 0 active facts were filtered by platform → no platform-hidden footer.
    expect(snap).not.toMatch(/platform-scoped.*hidden on linux/i);
    // The live cross-platform fact should still appear.
    expect(snap).toContain("live pref");
  });
});

describe("tagHistogram / formatTagHistogram (tfu)", () => {
  test("counts tags across lists, sorts by count desc then tag asc", () => {
    const h = tagHistogram([["jdk", "build"], ["jdk"], ["security"], ["build"], ["jdk"]]);
    expect(h).toEqual([
      { tag: "jdk", count: 3 },
      { tag: "build", count: 2 },
      { tag: "security", count: 1 },
    ]);
  });
  test("empty input yields empty histogram and empty string", () => {
    expect(tagHistogram([])).toEqual([]);
    expect(tagHistogram([[], []])).toEqual([]);
    expect(formatTagHistogram([])).toBe("");
  });
  test("formats as space-joined tag(count) matching the snapshot's existing line", () => {
    const h = tagHistogram([["security"], ["security"], ["security"], ["security"], ["jdk"], ["jdk"], ["jdk"], ["crypto"], ["crypto"]]);
    expect(formatTagHistogram(h)).toBe("security(4) jdk(3) crypto(2)");
  });
});

describe("reportShapeWarning (qmemd-a3k)", () => {
  test("flags a body with multiple markdown headings", () => {
    const body = "## Summary\nA thing broke today.\n## Root cause\nThe order was wrong.\n## Fix\nReorder it.";
    const w = reportShapeWarning(body);
    expect(w).not.toBeNull();
    expect(w).toContain("docs/reports/");
  });

  test("flags a long heading-less multi-paragraph write-up", () => {
    const para = "x".repeat(240);
    const body = [para, para, para, para, para].join("\n\n"); // 5 paragraphs, > 1200 chars
    expect(body.length).toBeGreaterThan(1200);
    expect(reportShapeWarning(body)).not.toBeNull();
  });

  test("does NOT flag a normal long single-paragraph fact", () => {
    // Mirrors a real memory fact: one dense paragraph, no headings, no blank lines.
    const body = ("qmemd is the sole memory engine over markdown facts backed by the qmd search SDK; "
      + "each fact is a markdown file with YAML frontmatter, git-committed on write and lex-indexed "
      + "into a dedicated SQLite DB, then embedded lazily on the first hybrid recall. ").repeat(3);
    expect(body.length).toBeGreaterThan(600);
    expect(reportShapeWarning(body)).toBeNull();
  });

  test("does NOT flag a thorough 4-paragraph atomic fact (real rtk-040 shape)", () => {
    // A real durable fact in the live store (rtk-040-git-log-strips-merge-commits) is 4 blank-line
    // blocks / ~1063 chars: observed behaviour, reproduction, workaround, status note. It is one
    // atomic gotcha, NOT a report — the heuristic must not flag it (review finding, qmemd-a3k).
    const block = "x".repeat(260);
    const body = [block, block, block, block].join("\n\n"); // 4 paragraphs, ~1052 chars, no headings
    expect(body.length).toBeGreaterThan(1000);
    expect(reportShapeWarning(body)).toBeNull();
  });

  test("does NOT flag a long body with exactly two paragraphs (boundary)", () => {
    const para = "x".repeat(350);
    const body = para + "\n\n" + para; // 2 paragraphs, > 600 chars, no headings
    expect(body.length).toBeGreaterThan(600);
    expect(reportShapeWarning(body)).toBeNull();
  });

  test("does NOT flag a short fact", () => {
    expect(reportShapeWarning("Use Bun not Node for this repo.")).toBeNull();
  });

  test("does NOT flag two short paragraphs", () => {
    expect(reportShapeWarning("First short note.\n\nSecond short note.")).toBeNull();
  });
});

describe("leakedMarkupTokens / stripLeakedMarkup (pure, qp-ey3)", () => {
  test("clean prose has no tokens and strips to itself (byte-identity)", () => {
    const s = "Keystore alias is the cert CN.\n\nSecond paragraph.\n";
    expect(leakedMarkupTokens(s)).toEqual([]);
    expect(stripLeakedMarkup(s)).toBe(s);
  });

  test("detects each canonical token by its fixed label (never a raw slice)", () => {
    expect(leakedMarkupTokens("a </fact>")).toEqual(["</fact>"]);
    expect(leakedMarkupTokens("a <fact> b")).toEqual(["<fact>"]);
    expect(leakedMarkupTokens('<parameter name="type">project')).toEqual(["<parameter name="]);
    expect(leakedMarkupTokens('<invoke name="x">')).toEqual(["<invoke>"]);
    expect(leakedMarkupTokens("</invoke>")).toEqual(["</invoke>"]);
    expect(leakedMarkupTokens("<function_calls>")).toEqual(["<function_calls>"]);
    expect(leakedMarkupTokens("</function_calls>")).toEqual(["</function_calls>"]);
  });

  test("strips the real six-case shape (trailing </fact> + bare parameter line)", () => {
    const body = "Keystore alias is the cert CN.\n</fact>\n<parameter name=\"type\">project";
    const out = stripLeakedMarkup(body);
    expect(leakedMarkupTokens(out)).toEqual([]);
    expect(out).toContain("Keystore alias is the cert CN.");
    expect(out).not.toContain("</fact>");
    expect(out).not.toContain("<parameter");
  });

  test("is a fixed point — closed under splicing/nesting", () => {
    expect(leakedMarkupTokens(stripLeakedMarkup("<fa<fact>ct>"))).toEqual([]);
    expect(leakedMarkupTokens(stripLeakedMarkup("<function<function_calls>_calls>"))).toEqual([]);
  });

  test("is idempotent", () => {
    const x = "note\n</fact>\n<parameter name=\"type\">project\n";
    expect(stripLeakedMarkup(stripLeakedMarkup(x))).toBe(stripLeakedMarkup(x));
  });

  test("drops a bare parameter line but preserves a pre-existing blank line", () => {
    expect(stripLeakedMarkup('a\n<parameter name="x">y\nb')).toBe("a\nb");
    expect(stripLeakedMarkup('a\n\n<parameter name="x">y\nb')).toBe("a\n\nb");
  });

  test("whitespace-indented parameter line is still detected + stripped", () => {
    expect(leakedMarkupTokens('  <parameter name="x">y')).toEqual(["<parameter name="]);
    expect(stripLeakedMarkup('a\n  <parameter name="x">y\nb')).toBe("a\nb");
  });
});

describe("remember (SDK-backed)", () => {
  let root: string, dbPath: string, store: QMDStore;
  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-mem-"));
    dbPath = join(await mkt(join(tmpdir(), "qmemd-db-")), "i.sqlite");
    store = await openQmd({ dbPath, config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  test("writes a typed fact and returns its slug", async () => {
    const { remember } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "Use Bun not Node", type: "user" });
    expect(res.wrote).toBe(true);
    expect(res.slug).toBe("use-bun-not-node");
    expect(res.type).toBe("user");
  });

  test("near-duplicate is reported, not written", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Use Bun not Node", type: "user" });
    const dup = await remember(store, root, { fact: "Use Bun not Node", type: "user" });
    expect(dup.wrote).toBe(false);
    expect(dup.duplicateOf).toBe("use-bun-not-node");
  });

  test("a report-shaped body still writes but surfaces a reportWarning (qmemd-a3k)", async () => {
    const { remember } = await import("../src/engine.js");
    const report = "## What happened\nThe cross-instance exchange 500'd.\n## Root cause\nDescriptor marshalled before signatures.\n## Fix\nStamp signatures first.";
    const res = await remember(store, root, { fact: report, type: "project" });
    expect(res.wrote).toBe(true);             // non-blocking: the fact is still stored
    expect(res.reportWarning).toBeTruthy();   // ...but the mis-route is flagged
    expect(res.reportWarning).toContain("docs/reports/");
  });

  test("a normal fact carries no reportWarning (qmemd-a3k)", async () => {
    const { remember } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "Redis admin password is rotated in both users.acl and the compose healthcheck", type: "project" });
    expect(res.wrote).toBe(true);
    expect(res.reportWarning).toBeUndefined();
  });

  test("strips leaked markup, writes the clean fact, and surfaces sanitizedWarning (qp-ey3)", async () => {
    const { remember } = await import("../src/engine.js");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = "Keystore alias is the cert CN.\n</fact>\n<parameter name=\"type\">project";
    const res = await remember(store, root, { fact: raw, type: "reference" });
    expect(res.wrote).toBe(true);
    expect(res.sanitizedWarning).toBeTruthy();
    const onDisk = readFileSync(res.path, "utf-8");
    expect(onDisk).not.toContain("</fact>");
    expect(onDisk).not.toContain("<parameter");
    expect(onDisk).toContain("Keystore alias is the cert CN.");
    expect(spy.mock.calls.some(c => String(c[0]).includes("pre-strip raw"))).toBe(true);
    spy.mockRestore();
  });

  test("a clean fact carries no sanitizedWarning (qp-ey3)", async () => {
    const { remember } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "Postgres listens on 5432", type: "project" });
    expect(res.wrote).toBe(true);
    expect(res.sanitizedWarning).toBeUndefined();
  });

  test("a fact that is ENTIRELY leaked markup is refused (qp-ey3)", async () => {
    const { remember } = await import("../src/engine.js");
    await expect(remember(store, root, { fact: "</fact>\n<parameter name=\"type\">project", type: "reference" }))
      .rejects.toThrow(/entirely leaked tool-call markup/);
  });

  test("--force writes despite duplicate", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Use Bun not Node", type: "user" });
    const forced = await remember(store, root, { fact: "Use Bun not Node", type: "user", force: true });
    expect(forced.wrote).toBe(true);
  });

  test("Tier-2: a differently-worded near-duplicate dedups via FTS, not exact slug (6d3)", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "Redpanda broker runs on lab pi", type: "project" });
    expect(first.wrote).toBe(true);
    // The new fact's words are a subset of the first's, so it maps to a DIFFERENT slug
    // with no file on disk — Tier-1 (exact-slug file existence) cannot fire. qmd's
    // AND-query still returns the first fact, so Tier-2 (FTS score > DEDUP_SCORE_FTS)
    // is what catches it. Previously the only dedup test exercised Tier-1 and never
    // reached Tier-2 (6d3). (On a dedup hit the result's slug is the *duplicate's*.)
    expect(existsSync(memoryFilePath(root, "project", slugify("Redpanda broker lab")))).toBe(false);
    const near = await remember(store, root, { fact: "Redpanda broker lab", type: "project" });
    expect(near.wrote).toBe(false);
    expect(near.duplicateOf).toBe(first.slug);
  });

  test("Tier-2: facts sharing no tokens are NOT deduped — AND-semantics, no false positive (6d3)", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Redpanda broker runs on lab pi", type: "project" });
    // No overlapping tokens → qmd's AND-query returns nothing → Tier-2 cannot fire,
    // so this distinct fact is written. Guards against false dedup as the corpus grows.
    const distinct = await remember(store, root, { fact: "PostgreSQL uses connection pooling", type: "project" });
    expect(distinct.wrote).toBe(true);
  });

  test("Tier-1: a blocked exact-duplicate surfaces the existing fact's description + body (cs0)", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Use Bun not Node for this repo", type: "user" });
    const dup = await remember(store, root, { fact: "Use Bun not Node for this repo", type: "user" });
    expect(dup.wrote).toBe(false);
    expect(dup.duplicateOf).toBe("use-bun-not-node-for-this-repo");
    // The decider must SEE what it collided with, not just the slug (cs0).
    expect(dup.duplicateDescription).toBe("Use Bun not Node for this repo");
    expect(dup.duplicateBody).toBe("Use Bun not Node for this repo");
  });

  test("Tier-1: a cross-type slug collision is blocked — slugs are globally unique (bs0)", async () => {
    const { remember } = await import("../src/engine.js");
    // First fact under 'user' with an explicit slug.
    const first = await remember(store, root, { fact: "The sky is blue today", type: "user", as: "collide-bs0" });
    expect(first.wrote).toBe(true);
    expect(first.type).toBe("user");
    // A SECOND, unrelated fact (no shared tokens, so Tier-2 FTS and Tier-2.5 cannot fire)
    // reusing the SAME explicit slug under a DIFFERENT type. Pre-fix Tier-1 only checked the
    // 'project' folder (empty), so it wrote a second 'collide-bs0.md' under project/ —
    // unreachable by getFact/forget/--replace, which all resolve the 'user' copy first.
    const second = await remember(store, root, { fact: "Postgres listens on port 5432", type: "project", as: "collide-bs0" });
    expect(second.wrote).toBe(false);
    expect(second.duplicateOf).toBe("collide-bs0");
    // Reported with the EXISTING fact's type, not the rejected input's.
    expect(second.type).toBe("user");
    // Exactly one file carries the slug — no orphan under project/.
    expect(existsSync(memoryFilePath(root, "user", "collide-bs0"))).toBe(true);
    expect(existsSync(memoryFilePath(root, "project", "collide-bs0"))).toBe(false);
  });

  test("Tier-1: a slug collision with a conflicting identifier classifies as conflict, not duplicate (cbv)", async () => {
    const { remember } = await import("../src/engine.js");
    // Same explicit slug, firstLines differing by a port number. Pre-fix the Tier-1 branch
    // hardcoded disposition:'duplicate', mis-reporting a contradiction as settled — the
    // classifier Tier-2/2.5 already run must fire here too.
    const first = await remember(store, root, { fact: "Postgres listens on port 5432", type: "project", as: "pg-port-cbv" });
    expect(first.wrote).toBe(true);
    const second = await remember(store, root, { fact: "Postgres listens on port 5433", type: "project", as: "pg-port-cbv" });
    expect(second.wrote).toBe(false);
    expect(second.duplicateOf).toBe("pg-port-cbv");
    expect(second.disposition).toBe("conflict");
    // The conflict surface carries the authority comparison, mirroring Tier-2.5 (vkn).
    expect(second.authorityComparison).toBeDefined();
  });

  test("Tier-1: two distinct long facts colliding via 60-char slug truncation surface as conflict (cbv)", async () => {
    const { remember, slugify } = await import("../src/engine.js");
    // slugify truncates at 60 chars on a word boundary, so two DISTINCT facts sharing a
    // long prefix map to the SAME slug — the issue's real-world trigger. The differing
    // antonym tail (enabled vs disabled) never reaches the slug.
    const a = "solar caches edm options in a caffeine cache and the flag is enabled";
    const b = "solar caches edm options in a caffeine cache and the flag is disabled";
    expect(slugify(a)).toBe(slugify(b)); // genuine Tier-1 collision, not a Tier-2 near-match
    const first = await remember(store, root, { fact: a, type: "project" });
    expect(first.wrote).toBe(true);
    const second = await remember(store, root, { fact: b, type: "project" });
    expect(second.wrote).toBe(false);
    expect(second.disposition).toBe("conflict");
    expect(second.authorityComparison).toBeDefined();
  });

  test("Tier-1: an exact re-remember still classifies as a plain duplicate (cbv regression guard)", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Use Bun not Node for builds", type: "user" });
    const dup = await remember(store, root, { fact: "Use Bun not Node for builds", type: "user" });
    expect(dup.wrote).toBe(false);
    expect(dup.disposition).toBe("duplicate");
    expect(dup.authorityComparison).toBeUndefined();
  });

  test("Tier-2: a blocked near-duplicate surfaces the matched fact's description + body (cs0)", async () => {
    const { remember } = await import("../src/engine.js");
    // Distinct description (first line) and body so we prove BOTH are surfaced, not echoed
    // from the rejected input. The matched fact is found via FTS, not exact slug.
    const first = await remember(store, root, {
      fact: "Redpanda broker runs on lab pi\nKafka API listens on 9092 with SASL_SSL",
      type: "project",
    });
    const near = await remember(store, root, { fact: "Redpanda broker lab", type: "project" });
    expect(near.wrote).toBe(false);
    expect(near.duplicateOf).toBe(first.slug);
    expect(near.duplicateDescription).toBe("Redpanda broker runs on lab pi");
    expect(near.duplicateBody).toContain("Kafka API listens on 9092 with SASL_SSL");
  });

  test("Tier-2.5: a reworded near-dup that BM25 AND misses is blocked by the model-free pre-pass (i5y)", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "Redpanda broker runs on the lab pi server", type: "project" });
    expect(first.wrote).toBe(true);
    // B adds a token ("node") absent from A, so qmd's AND-query cannot match all of B's
    // terms -> Tier-2 BM25 misses; B's slug differs -> Tier-1 misses. The token-set
    // pre-pass (Dice ~0.83) is what catches it.
    const near = await remember(store, root, { fact: "Redpanda broker runs on lab pi node", type: "project" });
    expect(near.wrote).toBe(false);
    expect(near.duplicateOf).toBe(first.slug);
    // A true paraphrase (no conflict cue) classifies as a plain duplicate, not a contradiction.
    expect(near.disposition).toBe("duplicate");
    // Reuses the cs0 preview so the decider sees what it collided with (not blocked blind).
    expect(near.duplicateDescription).toBe("Redpanda broker runs on the lab pi server");
  });

  test("Tier-2.5: a conflicting identifier SURFACES as a contradiction, not a silent write (5td)", async () => {
    const { remember } = await import("../src/engine.js");
    // Near-identical phrasing differing ONLY by the version token. i5y kept both facts
    // (write-both, identifier veto); 5td instead routes the high-similarity numeric conflict
    // to the cs0 SURFACE so the agent resolves it (replace = update, force = keep both).
    const a = await remember(store, root, { fact: "The alpha project builds green on JDK 21", type: "project" });
    expect(a.wrote).toBe(true);
    const b = await remember(store, root, { fact: "The alpha project builds green on JDK 25", type: "project" });
    expect(b.wrote).toBe(false);
    expect(b.duplicateOf).toBe(a.slug);
    expect(b.disposition).toBe("conflict");
    // The surface shows the colliding fact (cs0 reuse), so the agent isn't blocked blind.
    expect(b.duplicateDescription).toBe("The alpha project builds green on JDK 21");
    // --force is the escape hatch when the two numbers are genuinely distinct facts.
    const forced = await remember(store, root, { fact: "The alpha project builds green on JDK 25", type: "project", force: true });
    expect(forced.wrote).toBe(true);
  });

  test("Tier-2.5: an antonym/polarity flip SURFACES as a contradiction (enabled vs disabled) (5td)", async () => {
    const { remember } = await import("../src/engine.js");
    // Same predicate, opposite state — the exact 'X enabled' → 'X disabled' update signal a
    // pure similarity threshold would silently swallow as a near-duplicate.
    const a = await remember(store, root, { fact: "TLS certificate verification is enabled on the S3 client", type: "project" });
    expect(a.wrote).toBe(true);
    const b = await remember(store, root, { fact: "TLS certificate verification is disabled on the S3 client", type: "project" });
    expect(b.wrote).toBe(false);
    expect(b.duplicateOf).toBe(a.slug);
    expect(b.disposition).toBe("conflict");
  });

  test("vkn: conflict attaches authorityComparison; equal tiers when both project", async () => {
    const { remember } = await import("../src/engine.js");
    const a = await remember(store, root, { fact: "The cache TTL is 60 seconds", type: "project", source: "obs 2026-06-01" });
    expect(a.wrote).toBe(true);
    const b = await remember(store, root, { fact: "The cache TTL is 120 seconds", type: "project", source: "obs 2026-06-08" });
    expect(b.wrote).toBe(false);
    expect(b.disposition).toBe("conflict");
    const cmp = b.authorityComparison;
    expect(cmp).toBeDefined();
    expect(cmp!.incoming).toEqual({ type: "project", tier: 1, source: "obs 2026-06-08" });
    expect(cmp!.existing.type).toBe("project");
    expect(cmp!.existing.tier).toBe(1);
    expect(cmp!.existing.source).toBe("obs 2026-06-01");
    expect(cmp!.existing.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cmp!.verdict).toBe("equal");
  });

  test("vkn: verdict existing-higher guards a user fact against a project overwrite", async () => {
    const { remember } = await import("../src/engine.js");
    const a = await remember(store, root, { fact: "The deploy endpoint is enabled on staging", type: "user" });
    expect(a.wrote).toBe(true);
    const b = await remember(store, root, { fact: "The deploy endpoint is disabled on staging", type: "project" });
    expect(b.disposition).toBe("conflict");
    expect(b.authorityComparison!.verdict).toBe("existing-higher");
    expect(b.authorityComparison!.existing.tier).toBe(2);
    expect(b.authorityComparison!.incoming.tier).toBe(1);
  });

  test("vkn: verdict incoming-higher when a user fact contradicts a project fact", async () => {
    const { remember } = await import("../src/engine.js");
    const a = await remember(store, root, { fact: "The log output is enabled in production", type: "project" });
    expect(a.wrote).toBe(true);
    const b = await remember(store, root, { fact: "The log output is disabled in production", type: "user" });
    expect(b.disposition).toBe("conflict");
    expect(b.authorityComparison!.verdict).toBe("incoming-higher");
  });

  test("vkn: no authorityComparison on the write path or a pure duplicate", async () => {
    const { remember } = await import("../src/engine.js");
    const w = await remember(store, root, { fact: "Grafana runs on the sandbox k3s cluster", type: "project" });
    expect(w.wrote).toBe(true);
    expect(w.authorityComparison).toBeUndefined();
    const dup = await remember(store, root, { fact: "Grafana runs on the sandbox k3s cluster", type: "project" });
    expect(dup.wrote).toBe(false);
    expect(dup.disposition).toBe("duplicate");
    expect(dup.authorityComparison).toBeUndefined();
  });

  test("Tier-2.5 (rso): loose near-dups with heavy drift currently BOTH write — global-scan limitation", async () => {
    const { remember } = await import("../src/engine.js");
    // Two facts encode the SAME truth (build alpha on a real JDK 21) but drift heavily in
    // supporting detail, so neither Tier-2 (BM25 AND misses on the extra tokens) nor Tier-2.5
    // (Dice well below 0.82) fires — both write. This is the qmemd-rso bug, and the chosen
    // disposition is to DOCUMENT it, not to add a write-path catcher: the measured remedy is
    // offline + project-scoped (gbrain scope-by-entity), because a global threshold low enough
    // to catch loose drift false-merges cross-repo facts. Pins current behavior so a future
    // scoped tier flips this assertion deliberately.
    const a = await remember(store, root, {
      fact: "alpha local Maven builds require JDK 21; the default Temurin 25 makes Lombok fail annotation processing with cannot find symbol on getters",
      type: "project", project: "alpha",
    });
    expect(a.wrote).toBe(true);
    const b = await remember(store, root, {
      fact: "Compiling the alpha repo needs a real JDK 21 because under the sdkman default 25 javac no longer runs the Lombok processor so builder methods vanish and the spring boot parent forces release 17 unless you pass Djava version 21",
      type: "project", project: "alpha",
    });
    expect(b.wrote).toBe(true); // loose drift -> not caught (rso-documented limitation)
  });

  test("a long existing body is truncated with an ellipsis in the duplicate preview (cs0)", async () => {
    const { remember } = await import("../src/engine.js");
    const longBody = "Redpanda broker on the lab pi. " + "x".repeat(600);
    await remember(store, root, { fact: longBody, type: "project" });
    const dup = await remember(store, root, { fact: longBody, type: "project" });
    expect(dup.wrote).toBe(false);
    expect(dup.duplicateBody).toMatch(/…$/);
    expect(Buffer.byteLength(dup.duplicateBody!.replace(/…$/, ""), "utf-8")).toBeLessThanOrEqual(500);
  });

  test("NFC and NFD variants of a CJK-only fact dedupe to one (n63)", async () => {
    const { remember } = await import("../src/engine.js");
    // All-Hangul: no ASCII alphanumerics, so slugify() -> "" and the fallbackSlug HASH
    // path decides dedup. NFC (composed syllables) and NFD (decomposed jamo) are
    // different bytes for the same text — today they hash apart and both write.
    const base = "한국어 메모 버그";
    const nfc = base.normalize("NFC");
    const nfd = base.normalize("NFD");
    expect(nfc).not.toBe(nfd); // precondition: the two normalization forms differ
    const first = await remember(store, root, { fact: nfc, type: "project" });
    expect(first.wrote).toBe(true);
    const dup = await remember(store, root, { fact: nfd, type: "project" });
    expect(dup.wrote).toBe(false);
    expect(dup.duplicateOf).toBe(first.slug);
  });

  test("the stored fact is NOT hash-normalized — BOM + CRLF survive on disk (n63)", async () => {
    const { remember } = await import("../src/engine.js");
    const raw = "﻿한국어\r\n메모"; // leading BOM + CRLF: the exact bytes normalizeForHash strips
    const res = await remember(store, root, { fact: raw, type: "project" });
    expect(res.wrote).toBe(true);
    const parsed = parseMemory(readFileSync(res.path, "utf-8"));
    // normalizeForHash (BOM strip + CRLF->LF + NFKC) feeds the dedup identity ONLY,
    // never storage — the raw BOM and CRLF must still be on disk.
    expect(parsed.body).toContain("﻿"); // BOM preserved
    expect(parsed.body).toContain("\r\n");   // CRLF preserved
  });

  test("a leading BOM + trailing CRLF does not defeat fallback-hash dedup (n63)", async () => {
    const { remember } = await import("../src/engine.js");
    const clean = "한국어 메모 노트";
    const first = await remember(store, root, { fact: clean, type: "project" });
    expect(first.wrote).toBe(true);
    // Same CJK fact decorated with a leading BOM + trailing CRLF — normalizeForHash
    // must strip both so it hashes to the SAME fallback slug (guards the BOM strip).
    const decorated = await remember(store, root, { fact: "﻿한국어 메모 노트\r\n", type: "project" });
    expect(decorated.wrote).toBe(false);
    expect(decorated.duplicateOf).toBe(first.slug);
  });

  test("an ASCII fact with a trailing newline still dedupes via slugify (n63 unchanged)", async () => {
    const { remember } = await import("../src/engine.js");
    const a = await remember(store, root, { fact: "Use Ripgrep not grep", type: "user" });
    const b = await remember(store, root, { fact: "Use Ripgrep not grep\n", type: "user" });
    expect(a.wrote).toBe(true);
    expect(b.wrote).toBe(false);
    expect(b.duplicateOf).toBe("use-ripgrep-not-grep");
  });

  test("remember leaves the fact pending embedding (lex-only write path)", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Vectors are built lazily on recall", type: "project" });
    const status = await store.getStatus();
    expect(status.needsEmbedding).toBeGreaterThan(0);
  });

  test("remember normalizes mixed-case platforms to canonical lowercase on disk (qmemd-fvv)", async () => {
    const { remember } = await import("../src/engine.js");
    // REST/MCP may hand the engine mixed case; the single write choke point must lowercase
    // so disk stays canonical and parseMemory's lowercase read never diverges from the file.
    const res = await remember(store, root, { fact: "metal embed mixed case", type: "project", platforms: ["MacOS", "LINUX"] as unknown as Platform[] });
    expect(res.wrote).toBe(true);
    expect(parseMemory(readFileSync(res.path, "utf-8")).frontmatter.platforms).toEqual(["macos", "linux"]);
  });

  test("replace updates in place across types when --type omitted/mismatched (s5f)", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "Prefer tabs over spaces", type: "user", as: "indent-pref" });
    expect(first.type).toBe("user");
    expect(existsSync(join(root, "user", "indent-pref.md"))).toBe(true);
    const upd = await remember(store, root, { fact: "Prefer spaces over tabs", replace: "indent-pref" });
    expect(upd.wrote).toBe(true);
    expect(upd.type).toBe("user");
    expect(existsSync(join(root, "reference", "indent-pref.md"))).toBe(false);
    expect(readFileSync(join(root, "user", "indent-pref.md"), "utf-8")).toContain("Prefer spaces over tabs");
  });

  test("force does not orphan a duplicate slug across types (s5f/force)", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "Old fact", type: "user", as: "dup-slug" });
    const forced = await remember(store, root, { fact: "New fact", type: "reference", force: true, as: "dup-slug" });
    expect(forced.wrote).toBe(true);
    expect(forced.type).toBe("user");                                          // relocated to the existing folder
    expect(existsSync(join(root, "reference", "dup-slug.md"))).toBe(false);    // no orphan
    expect(readFileSync(join(root, "user", "dup-slug.md"), "utf-8")).toContain("New fact");
  });

  test("replace inherits the existing fact's metadata when a field is not re-passed (q65)", async () => {
    const { remember } = await import("../src/engine.js");
    // Seed a fact carrying every optional field, with a created date in the past so
    // a re-stamp to today() is detectable.
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(join(root, "user", "rich.md"), serializeMemory(
      { name: "rich", description: "Original desc", type: "user",
        tags: ["alpha", "beta"], project: "myproj", created: "2026-01-15",
        pinned: true, source: "https://example.com/src" },
      "Original body"));
    // Replace with ONLY a new body — no tags/project/pin/source/type passed.
    const upd = await remember(store, root, { fact: "Updated body text", replace: "rich" });
    expect(upd.wrote).toBe(true);
    expect(upd.type).toBe("user");
    const fm = parseMemory(readFileSync(join(root, "user", "rich.md"), "utf-8")).frontmatter;
    expect(fm.tags).toEqual(["alpha", "beta"]);                  // tags preserved (was wiped to [])
    expect(fm.project).toBe("myproj");                           // project preserved (was reset to global)
    expect(fm.pinned).toBe(true);                                // pin preserved (was silently unpinned)
    expect(fm.source).toBe("https://example.com/src");          // source preserved (was dropped)
    expect(fm.created).toBe("2026-01-15");                       // created preserved (was re-stamped today)
    expect(fm.description).toBe("Updated body text");           // description refreshes from the new body
    expect(parseMemory(readFileSync(join(root, "user", "rich.md"), "utf-8")).body.trim()).toBe("Updated body text");
  });

  test("replace still lets explicitly-passed fields override the existing ones (q65)", async () => {
    const { remember } = await import("../src/engine.js");
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(join(root, "user", "rich2.md"), serializeMemory(
      { name: "rich2", description: "d", type: "user",
        tags: ["old"], project: "oldproj", created: "2026-01-15", pinned: true, source: "old-src" },
      "Original body"));
    const upd = await remember(store, root, {
      fact: "New body", replace: "rich2",
      tags: ["new"], project: "newproj", source: "new-src",
    });
    expect(upd.wrote).toBe(true);
    const fm = parseMemory(readFileSync(join(root, "user", "rich2.md"), "utf-8")).frontmatter;
    expect(fm.tags).toEqual(["new"]);          // explicit override wins
    expect(fm.project).toBe("newproj");        // explicit override wins
    expect(fm.source).toBe("new-src");         // explicit override wins
    expect(fm.created).toBe("2026-01-15");     // created always preserved from the existing fact
  });

  test("replace with a traversal slug is rejected before any write (fd8)", async () => {
    const { remember } = await import("../src/engine.js");
    await expect(
      remember(store, root, { fact: "poison", replace: "../../../../etc/qmemd-evil" }),
    ).rejects.toThrow(/unsafe slug/);
    // Sibling of root must not have been written (the escape never happened).
    expect(existsSync(join(root, "..", "..", "..", "..", "etc", "qmemd-evil.md"))).toBe(false);
  });

  test("replace with a newline slug is rejected (fd8 commit-injection)", async () => {
    const { remember } = await import("../src/engine.js");
    await expect(
      remember(store, root, { fact: "poison", replace: "ok\nCo-Authored-By: Evil <e@x>" }),
    ).rejects.toThrow(/unsafe slug/);
  });

  test("replace targeting a slug that does not exist throws — never fabricates a fact (acm)", async () => {
    const { remember } = await import("../src/engine.js");
    // A typo'd --replace target must NOT fall through to the create path and silently write a
    // NEW fact reporting wrote:true; that fabricates a duplicate instead of updating (qmemd-acm).
    await expect(
      remember(store, root, { fact: "Updated body", replace: "never-was-written" }),
    ).rejects.toThrow(/no fact named 'never-was-written' to replace/);
    // Nothing fabricated under any type folder.
    for (const t of ["user", "feedback", "project", "reference"]) {
      expect(existsSync(join(root, t, "never-was-written.md"))).toBe(false);
    }
  });

  test("force on a brand-new slug still creates — force is not replace (acm guard)", async () => {
    const { remember } = await import("../src/engine.js");
    // Regression guard for the acm fix: the replace-missing throw must be replace-specific.
    // --force on a fresh slug is the legitimate "write even if a near-duplicate exists" path.
    const res = await remember(store, root, { fact: "Brand new forced fact", type: "project", force: true, as: "forced-new" });
    expect(res.wrote).toBe(true);
    expect(existsSync(join(root, "project", "forced-new.md"))).toBe(true);
  });
});

describe("remember stamps updated (bri)", () => {
  // Reuses the surrounding suite's tmp-root beforeEach pattern with a minimal fake store.
  let root: string;
  // Minimal fake store: searchLex returns [] (no FTS hit) and update is a no-op.
  const store = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;
  beforeEach(async () => { root = await mkt(join(tmpdir(), "qmemd-bri-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("stamps a full ISO instant on create", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "alpha fact", type: "project" });
    expect(res.wrote).toBe(true);
    const f = getFact(root, res.slug)!;
    expect(f.frontmatter.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("refreshes updated on --replace but preserves created", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    // seed a legacy fact with an old created and NO updated
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "old-fact.md"),
      "---\nname: old-fact\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\n---\n\nold body\n");
    const res = await remember(store, root, { fact: "new body", replace: "old-fact" });
    expect(res.wrote).toBe(true);
    const f = getFact(root, "old-fact")!;
    expect(f.frontmatter.created).toBe("2020-01-01");
    expect(f.frontmatter.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("preserves supersession links on --replace (retirement state survives an in-place update)", async () => {
    const { remember } = await import("../src/engine.js");
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "retired.md"),
      "---\nname: retired\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\nsuperseded_by: successor\n---\n\nold body\n");
    const res = await remember(store, root, { fact: "edited body", replace: "retired" });
    expect(res.wrote).toBe(true);
    expect(getFact(root, "retired")!.frontmatter.supersededBy).toBe("successor");
  });
});

describe("recallQuery + forget (SDK-backed)", () => {
  let root: string, dbPath: string, store: QMDStore;
  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-rq-"));
    dbPath = join(await mkt(join(tmpdir(), "qmemd-rqdb-")), "i.sqlite");
    store = await openQmd({ dbPath, config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  test("lexOnly recall finds a remembered fact", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    await remember(store, root, { fact: "Redpanda runs on the lab pi", type: "project" });
    const hits = await recallQuery(store, root, "Redpanda", { lexOnly: true });
    expect(hits.some(h => h.slug === "redpanda-runs-on-the-lab-pi")).toBe(true);
  });

  test("remember surfaces a port-flip as a conflict, not a silent second fact (733 e2e)", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "redis on 6379", type: "project" });
    expect(first.wrote).toBe(true);
    // The single differing token (6380) drops Dice below the dup floor, so without the
    // low-similarity-conflict check this contradicting fact is written as a second file.
    const second = await remember(store, root, { fact: "redis on 6380", type: "project" });
    expect(second.wrote).toBe(false);
    expect(second.disposition).toBe("conflict");
    expect(second.duplicateOf).toBe("redis-on-6379");
  });

  test("remember surfaces an enabled→disabled flip as a conflict (733 e2e)", async () => {
    const { remember } = await import("../src/engine.js");
    await remember(store, root, { fact: "S3 TLS verification enabled", type: "project" });
    const flip = await remember(store, root, { fact: "S3 TLS verification disabled", type: "project" });
    expect(flip.wrote).toBe(false);
    expect(flip.disposition).toBe("conflict");
  });

  test("forget removes the fact", async () => {
    const { remember, recallQuery, forget } = await import("../src/engine.js");
    await remember(store, root, { fact: "Temporary fact about widgets", type: "reference" });
    const gone = await forget(store, root, "temporary-fact-about-widgets");
    expect(gone.removed).toBe(true);
    const hits = await recallQuery(store, root, "widgets", { lexOnly: true });
    expect(hits.some(h => h.slug === "temporary-fact-about-widgets")).toBe(false);
  });

  test("forget with a traversal slug is rejected before any rmSync (fd8)", async () => {
    const { forget } = await import("../src/engine.js");
    // Plant a file outside root that a traversal slug would resolve to, and prove
    // the guard refuses to delete it.
    const outside = join(root, "..", `qmemd-fd8-victim-${process.pid}.md`);
    await writeFile(outside, "do not delete me");
    try {
      await expect(forget(store, root, "../" + `qmemd-fd8-victim-${process.pid}`)).rejects.toThrow(/unsafe slug/);
      expect(existsSync(outside)).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });

  test("recall hits carry a body, truncated to RECALL_BODY_CAP with an ellipsis (bgf)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    const longBody = "Redpanda broker detail. " + "padding ".repeat(120); // > 500 bytes, one line
    await remember(store, root, { fact: longBody, type: "project" });
    const hits = await recallQuery(store, root, "Redpanda", { lexOnly: true });
    const hit = hits.find(h => h.description.startsWith("Redpanda broker detail"));
    expect(hit).toBeDefined();
    expect(hit!.body).toBeDefined();
    // body = capped (<=500 bytes) + "…" (3 bytes)
    expect(Buffer.byteLength(hit!.body!, "utf-8")).toBeLessThanOrEqual(503);
    expect(hit!.body!.endsWith("…")).toBe(true);
  });

  test("recall with fullBody:true returns the untruncated body (bgf)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    const longBody = "Postgres tuning note. " + "padding ".repeat(120);
    await remember(store, root, { fact: longBody, type: "project" });
    const hits = await recallQuery(store, root, "Postgres", { lexOnly: true, fullBody: true });
    const hit = hits.find(h => h.description.startsWith("Postgres tuning note"));
    expect(hit!.body).toBe(longBody.trim());
    expect(hit!.body!.endsWith("…")).toBe(false);
  });

  test("a short body is attached whole, with no ellipsis (bgf)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    await remember(store, root, { fact: "Short fact about Qdrant", type: "project" });
    const hits = await recallQuery(store, root, "Qdrant", { lexOnly: true });
    const hit = hits.find(h => h.slug === "short-fact-about-qdrant");
    expect(hit!.body).toBe("Short fact about Qdrant");
  });

  test("recall with skim:true omits the body but keeps description + canonical type (r0u)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    const longBody = "Redis ACL note. " + "padding ".repeat(120); // body would normally be attached
    await remember(store, root, { fact: longBody, type: "project" });
    const hits = await recallQuery(store, root, "Redis", { lexOnly: true, skim: true });
    const hit = hits.find(h => h.description.startsWith("Redis ACL note"));
    expect(hit).toBeDefined();
    expect(hit!.body).toBeUndefined();   // skim is headline-only: no body in the output
    expect(hit!.type).toBe("project");   // description + type are still backfilled from frontmatter
  });

  test("skim:true takes precedence over fullBody (r0u)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    await remember(store, root, { fact: "Minio bucket note here", type: "project" });
    const hits = await recallQuery(store, root, "Minio", { lexOnly: true, skim: true, fullBody: true });
    const hit = hits.find(h => h.slug === "minio-bucket-note-here");
    expect(hit!.body).toBeUndefined();
  });

  test("default recall scopes to the caller's project + global, hides foreign (qmemd-due)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    await remember(store, root, { fact: "alpha gateway uses widgetport 7777", type: "project", project: "alpha" });
    await remember(store, root, { fact: "beta gateway uses widgetport 7777", type: "project", project: "beta" });
    await remember(store, root, { fact: "everyone shares widgetport 7777", type: "project", project: "global" });
    const hits = await recallQuery(store, root, "widgetport 7777", { lexOnly: true, project: "alpha" });
    const slugs = hits.map(h => h.slug);
    expect(slugs).toContain("alpha-gateway-uses-widgetport-7777");
    expect(slugs).toContain("everyone-shares-widgetport-7777");
    expect(slugs).not.toContain("beta-gateway-uses-widgetport-7777");
  });

  test("crossProject:true widens to the whole corpus and reports 0 hidden (qmemd-due)", async () => {
    const { remember, recallQueryWithStatus } = await import("../src/engine.js");
    await remember(store, root, { fact: "alpha gateway uses widgetport 7777", type: "project", project: "alpha" });
    await remember(store, root, { fact: "beta gateway uses widgetport 7777", type: "project", project: "beta" });
    const res = await recallQueryWithStatus(store, root, "widgetport 7777", { lexOnly: true, project: "alpha", crossProject: true });
    expect(res.hits.map(h => h.slug)).toContain("beta-gateway-uses-widgetport-7777");
    expect(res.crossProjectHidden).toBe(0);
  });

  test("crossProjectHidden counts the foreign matches the default gate hid (qmemd-due)", async () => {
    const { remember, recallQueryWithStatus } = await import("../src/engine.js");
    await remember(store, root, { fact: "alpha gateway uses widgetport 7777", type: "project", project: "alpha" });
    await remember(store, root, { fact: "beta gateway uses widgetport 7777", type: "project", project: "beta" });
    const res = await recallQueryWithStatus(store, root, "widgetport 7777", { lexOnly: true, project: "alpha" });
    expect(res.crossProjectHidden).toBe(1); // beta hidden; alpha shown
  });

  test("each recall hit carries its project (qmemd-due)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    await remember(store, root, { fact: "alpha gateway uses widgetport 7777", type: "project", project: "alpha" });
    const hits = await recallQuery(store, root, "widgetport 7777", { lexOnly: true, project: "alpha" });
    expect(hits.find(h => h.slug === "alpha-gateway-uses-widgetport-7777")!.project).toBe("alpha");
  });

  test("omitting project keeps the pre-cross-project whole-corpus behaviour (qmemd-due)", async () => {
    const { remember, recallQuery } = await import("../src/engine.js");
    await remember(store, root, { fact: "alpha gateway uses widgetport 7777", type: "project", project: "alpha" });
    await remember(store, root, { fact: "beta gateway uses widgetport 7777", type: "project", project: "beta" });
    const slugs = (await recallQuery(store, root, "widgetport 7777", { lexOnly: true })).map(h => h.slug);
    expect(slugs).toEqual(expect.arrayContaining([
      "alpha-gateway-uses-widgetport-7777", "beta-gateway-uses-widgetport-7777",
    ]));
  });
});

describe("recallQuery embed barrier (fake store)", () => {
  // No real files needed: recallQuery's frontmatter backfill readFileSync is
  // wrapped in try/catch, so a non-existent path just skips the backfill.
  const root = "/tmp/qmemd-fake-barrier";

  function fakeStore(opts: { needsEmbedding: number; embedThrows?: boolean }) {
    const calls: string[] = [];
    const store = {
      async getStatus() {
        calls.push("getStatus");
        return { totalDocuments: 1, needsEmbedding: opts.needsEmbedding, hasVectorIndex: true, collections: [] };
      },
      async embed() {
        calls.push("embed");
        if (opts.embedThrows) throw new Error("model unavailable");
        return { docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: 1 };
      },
      async search() {
        calls.push("search");
        return [{ file: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.9 }];
      },
      async searchLex() {
        calls.push("searchLex");
        return [{ filepath: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.5 }];
      },
    } as unknown as QMDStore;
    return { store, calls };
  }

  test("hybrid recall embeds before searching when docs are pending", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store, calls } = fakeStore({ needsEmbedding: 2 });
    const hits = await recallQuery(store, root, "foo");
    expect(calls).toContain("embed");
    expect(calls.indexOf("embed")).toBeLessThan(calls.indexOf("search"));
    expect(hits.length).toBe(1);
  });

  test("hybrid recall skips embed when nothing is pending", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store, calls } = fakeStore({ needsEmbedding: 0 });
    await recallQuery(store, root, "foo");
    expect(calls).toContain("getStatus");
    expect(calls).not.toContain("embed");
    expect(calls).toContain("search");
  });

  test("lexOnly recall never embeds", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store, calls } = fakeStore({ needsEmbedding: 5 });
    await recallQuery(store, root, "foo", { lexOnly: true });
    expect(calls).not.toContain("getStatus");
    expect(calls).not.toContain("embed");
    expect(calls).toContain("searchLex");
  });

  test("embed failure does not crash recall; search falls open to lex (cw2)", async () => {
    // Pre-cw2 this still ran the HYBRID search after an embed throw — which re-attempts
    // the same model load. Model unavailable ⇒ the search must be model-free.
    const { recallQuery } = await import("../src/engine.js");
    const { store, calls } = fakeStore({ needsEmbedding: 1, embedThrows: true });
    const hits = await recallQuery(store, root, "foo");
    expect(calls).toContain("embed");
    expect(calls).toContain("searchLex");
    expect(calls).not.toContain("search");
    expect(hits.length).toBe(1);
  });
});

describe("lowSimilarityConflict — value-flip below the dup floor (733)", () => {
  // A single differing value token deflates Dice/overlap below the near-dup floor on a SHORT
  // headline, so the pair never reaches classifyNearMatch and the contradiction is silently
  // written. These are exactly the port/version/polarity flips i5y/5td exist to surface.
  test("a differing port is a conflict even though Dice falls below the floor", () => {
    expect(lowSimilarityConflict("redis on 6379", "redis on 6380")).toBe(true);
  });
  test("a differing version is a conflict", () => {
    expect(lowSimilarityConflict("JDK 25", "JDK 21")).toBe(true);
  });
  test("an antonym flip on a short headline is a conflict", () => {
    expect(lowSimilarityConflict("TLS verification enabled", "TLS verification disabled")).toBe(true);
  });
  test("unrelated facts that merely carry different numbers are NOT a conflict", () => {
    expect(lowSimilarityConflict("JDK 21", "Postgres 14")).toBe(false);
  });
  test("two bare values with no shared subject are NOT a conflict", () => {
    expect(lowSimilarityConflict("6379", "6380")).toBe(false);
  });
  test("a true paraphrase with no value flip is NOT a conflict here", () => {
    expect(lowSimilarityConflict("redis runs on the pi", "redis is on pi")).toBe(false);
  });
});

describe("unreadable/corrupt fact surfacing (e5h)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-e5h-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // A directory whose name ends in .md is listed by readdirSync but makes readFileSync throw
  // EISDIR — a deterministic, cross-platform stand-in for an unreadable/corrupt fact file.
  async function plantUnreadable(type: string, name: string) {
    await mkdir(join(root, type, name), { recursive: true });
  }
  async function plantReadable(type: MemoryType, slug: string) {
    await mkdir(join(root, type), { recursive: true });
    await writeFile(join(root, type, `${slug}.md`), serializeMemory(
      { name: slug, description: slug, type, tags: [], project: "global", created: "2026-06-07", pinned: false }, slug));
  }

  test("countUnreadableFacts counts read-failing files across every type folder", async () => {
    await plantReadable("project", "ok-fact");
    await plantUnreadable("project", "broken-a.md");
    await plantUnreadable("reference", "broken-b.md");
    expect(countUnreadableFacts(root)).toBe(2);
  });

  test("countUnreadableFacts is 0 for a clean corpus", async () => {
    await plantReadable("user", "clean");
    expect(countUnreadableFacts(root)).toBe(0);
  });

  test("recallSession surfaces an unreadable-fact count footer pointing at doctor", async () => {
    await plantReadable("user", "be-terse");
    await plantUnreadable("project", "corrupt.md");
    const out = await recallSession(root, { project: "global" });
    expect(out).toContain("be-terse");
    expect(out).toMatch(/1 fact.*unreadable/i);
    expect(out).toContain("qmemd doctor");
  });

  test("recallSession surfaces unreadable even when NO readable fact exists (would otherwise be empty)", async () => {
    await plantUnreadable("project", "corrupt.md");
    const out = await recallSession(root, { project: "global" });
    // Silence here is exactly the corruption-hiding e5h fixes — the snapshot must speak up.
    expect(out).toMatch(/1 fact.*unreadable/i);
    expect(out).toContain("qmemd doctor");
  });

  test("a fully clean corpus emits no unreadable footer", async () => {
    await plantReadable("user", "clean");
    const out = await recallSession(root, { project: "global" });
    expect(out).not.toMatch(/unreadable/i);
  });

  test("remember reports dedupSkipped when an unreadable candidate is skipped during the near-dup scan", async () => {
    const { remember } = await import("../src/engine.js");
    const store = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;
    await plantUnreadable("project", "corrupt.md"); // an unreadable dedup candidate
    const res = await remember(store, root, { fact: "A brand new distinct fact about Qdrant vectors", type: "project" });
    expect(res.wrote).toBe(true);          // the new fact still lands
    expect(res.dedupSkipped).toBe(1);      // but the corruption-driven dedup gap is visible
  });

  test("remember reports dedupSkipped:0 for a clean corpus", async () => {
    const { remember } = await import("../src/engine.js");
    const store = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;
    const res = await remember(store, root, { fact: "Another entirely distinct fact about Redis", type: "project" });
    expect(res.dedupSkipped).toBe(0);
  });
});

describe("recallQueryWithStatus degraded signal (9t1)", () => {
  // The embed barrier silently degrades a hybrid recall to lex-like results when the model
  // is unavailable (e.g. the Mac metal load failure) or only partially embeds. recallQuery
  // returns a normal-looking hit list, so the agent cannot tell no-relevant-facts from
  // semantic-half-skipped. recallQueryWithStatus surfaces degraded/vectorsPending so the
  // caller can warn — mirroring the remember-path indexed:false signal.
  const root = "/tmp/qmemd-fake-degraded";

  // getStatus reports a live pending counter that a successful embed decrements (to 0, or
  // to embedLeavesPending for a partial embed); a throwing embed leaves it untouched.
  function fakeStore(opts: { pending: number; embedThrows?: boolean; embedLeavesPending?: number; statusThrows?: boolean }) {
    let pending = opts.pending;
    return {
      async getStatus() {
        if (opts.statusThrows) throw new Error("status query failed");
        return { totalDocuments: 1, needsEmbedding: pending, hasVectorIndex: true, collections: [] };
      },
      async embed() {
        if (opts.embedThrows) throw new Error("model unavailable");
        pending = opts.embedLeavesPending ?? 0;
        return { docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: 1 };
      },
      async search() { return [{ file: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.9 }]; },
      async searchLex() { return [{ filepath: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.5 }]; },
    } as unknown as QMDStore;
  }

  test("embed failure flags degraded:true with the pending count; hits still return", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(fakeStore({ pending: 3, embedThrows: true }), root, "foo");
    expect(res.degraded).toBe(true);
    expect(res.vectorsPending).toBe(3);
    expect(res.hits.length).toBe(1); // degrades to a result, never crashes
  });

  test("getStatus failure flags degraded with vectorsPending -1 (unknown), not a misleading 0", async () => {
    // When getStatus() itself throws, the pending count was never read. Leaving vectorsPending
    // at its 0 initializer makes the warning say "0 vector(s) still pending" — which reads as
    // "nothing to do" when the real failure is the status query. -1 is the unknown sentinel.
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(fakeStore({ pending: 4, statusThrows: true }), root, "foo");
    expect(res.degraded).toBe(true);
    expect(res.vectorsPending).toBe(-1);
    expect(res.hits.length).toBe(1); // still degrades to a result, never crashes
  });

  test("a fully successful embed is NOT degraded", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(fakeStore({ pending: 2, embedLeavesPending: 0 }), root, "foo");
    expect(res.degraded).toBe(false);
    expect(res.vectorsPending).toBe(0);
  });

  test("a partial embed (some vectors still pending) flags degraded", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(fakeStore({ pending: 5, embedLeavesPending: 2 }), root, "foo");
    expect(res.degraded).toBe(true);
    expect(res.vectorsPending).toBe(2);
  });

  test("nothing pending: a warm hybrid recall is not degraded", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(fakeStore({ pending: 0 }), root, "foo");
    expect(res.degraded).toBe(false);
    expect(res.vectorsPending).toBe(0);
  });

  test("lexOnly recall is never flagged degraded (it runs no embed by design)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(fakeStore({ pending: 9 }), root, "foo", { lexOnly: true });
    expect(res.degraded).toBe(false);
    expect(res.vectorsPending).toBe(0);
    expect(res.hits.length).toBe(1);
  });

  test("recallQuery stays a hits-only convenience returning a bare array", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const hits = await recallQuery(fakeStore({ pending: 0 }), root, "foo");
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBe(1);
  });
});

describe("embed barrier timeout — fail open to lex (cw2)", () => {
  // The barrier awaits store.embed() on the first hybrid recall after writes. A stalled
  // model load made that await hang forever — the existing try/catch handles a THROW but
  // not a hang. cw2 bounds the await (QMEMD_EMBED_TIMEOUT_MS, default 6s) and, on timeout
  // OR error, routes the search to the model-free lex path: a hybrid search would
  // re-attempt the same model load and hang/throw all over again.
  const root = "/tmp/qmemd-fake-cw2";
  const ENV = "QMEMD_EMBED_TIMEOUT_MS";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

  // Live pending counter (the 9t1 fixture) + a calls[] trace + injectable embed behavior.
  // markDone() simulates a successful embed clearing the queue.
  function fakeStore(opts: { pending: number; embed: (markDone: () => void) => Promise<unknown> }) {
    let pending = opts.pending;
    const calls: string[] = [];
    const store = {
      async getStatus() {
        calls.push("getStatus");
        return { totalDocuments: 1, needsEmbedding: pending, hasVectorIndex: true, collections: [] };
      },
      embed() {
        calls.push("embed");
        return opts.embed(() => { pending = 0; });
      },
      async search() { calls.push("search"); return [{ file: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.9 }]; },
      async searchLex() { calls.push("searchLex"); return [{ filepath: "qmd://memory/user/foo.md", title: "Foo fact", score: 0.5 }]; },
    } as unknown as QMDStore;
    return { store, calls };
  }

  test("a hung embed times out and recall falls open to lex instead of hanging", async () => {
    process.env[ENV] = "40";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { recallQueryWithStatus } = await import("../src/engine.js");
      const { store, calls } = fakeStore({ pending: 2, embed: () => new Promise(() => {}) }); // never settles
      const res = await recallQueryWithStatus(store, root, "foo");
      expect(res.degraded).toBe(true);
      expect(res.vectorsPending).toBe(2); // pre-embed count — the queue was never re-read
      expect(calls).toContain("searchLex");
      expect(calls).not.toContain("search"); // model unavailable: hybrid would hang again
      expect(res.hits.length).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a fast embed inside the bound still yields a hybrid (non-degraded) recall", async () => {
    process.env[ENV] = "200";
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const { store, calls } = fakeStore({
      pending: 2,
      embed: async (markDone) => { markDone(); return { docsProcessed: 2, chunksEmbedded: 2, errors: 0, durationMs: 1 }; },
    });
    const res = await recallQueryWithStatus(store, root, "foo");
    expect(res.degraded).toBe(false);
    expect(res.vectorsPending).toBe(0);
    expect(calls).toContain("search");
    expect(calls).not.toContain("searchLex");
  });

  test("an embed that rejects AFTER the timeout lost the race does not crash anything", async () => {
    process.env[ENV] = "30";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { recallQueryWithStatus } = await import("../src/engine.js");
      const { store, calls } = fakeStore({
        pending: 1,
        embed: () => new Promise((_, reject) => { setTimeout(() => reject(new Error("late model failure")), 100); }),
      });
      const res = await recallQueryWithStatus(store, root, "foo");
      expect(res.degraded).toBe(true);
      expect(calls).toContain("searchLex");
      // Let the orphaned rejection fire inside the test — an unhandled rejection here
      // fails the run, proving the raced-out embed promise is swallowed.
      await new Promise(r => setTimeout(r, 150));
    } finally {
      errSpy.mockRestore();
    }
  });

  test("timeout default is 6s; env override wins; junk values fall back", async () => {
    const { embedTimeoutMs, DEFAULT_EMBED_TIMEOUT_MS } = await import("../src/engine.js");
    expect(DEFAULT_EMBED_TIMEOUT_MS).toBe(6000);
    delete process.env[ENV];
    expect(embedTimeoutMs()).toBe(DEFAULT_EMBED_TIMEOUT_MS);
    process.env[ENV] = "250";
    expect(embedTimeoutMs()).toBe(250);
    for (const junk of ["abc", "-5", "0", ""]) {
      process.env[ENV] = junk;
      expect(embedTimeoutMs()).toBe(DEFAULT_EMBED_TIMEOUT_MS);
    }
  });
});

describe("recall drops malformed index paths (qmemd-4ri)", () => {
  // parseVirtualMemoryPath yields type:"" for an index filepath missing its <type>/
  // segment. The old `(type || "reference") as MemoryType` fallback silently relabeled
  // such a hit under a fabricated reference path — masking index corruption instead of
  // surfacing it. A hit whose type segment is not a real MemoryType must be dropped
  // with a stderr warning, while well-formed hits in the same result set survive.
  const root = "/tmp/qmemd-fake-4ri";

  test("lex path: a filepath with no type segment is dropped with a warning, not relabeled reference", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const store = {
      async searchLex() {
        return [
          { filepath: "orphan.md", title: "Orphan", score: 0.5 },
          { filepath: "qmd://memory/user/good.md", title: "Good", score: 0.4 },
        ];
      },
    } as unknown as QMDStore;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await recallQueryWithStatus(store, root, "orphan", { lexOnly: true });
      expect(res.hits.map(h => h.slug)).toEqual(["good"]);
      expect(errSpy.mock.calls.flat().join("\n")).toMatch(/malformed/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("hybrid path: the same guard applies to the .file mapping", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const store = {
      async getStatus() { return { totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async search() {
        return [
          { file: "orphan.md", title: "Orphan", score: 0.9 },
          { file: "qmd://memory/user/good.md", title: "Good", score: 0.8 },
        ];
      },
    } as unknown as QMDStore;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await recallQueryWithStatus(store, root, "orphan");
      expect(res.hits.map(h => h.slug)).toEqual(["good"]);
      expect(errSpy.mock.calls.flat().join("\n")).toMatch(/malformed/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a non-empty but bogus type segment is dropped too (the cast lied for those as well)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const store = {
      // "qmd://memory/bogus.md" parses to type "memory" — non-empty, still not a MemoryType.
      async searchLex() { return [{ filepath: "qmd://memory/bogus.md", title: "Bogus", score: 0.5 }]; },
    } as unknown as QMDStore;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await recallQueryWithStatus(store, root, "bogus", { lexOnly: true });
      expect(res.hits).toEqual([]);
      expect(errSpy.mock.calls.flat().join("\n")).toMatch(/malformed/i);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("pendingVectorPhrase (9t1 degraded-warning rendering)", () => {
  // Shared by the CLI + MCP degraded warnings so the "N vector(s) still pending" wording
  // can't drift. -1 is the unknown sentinel (getStatus threw) — must NOT print "-1 vector(s)".
  test("renders a known count verbatim", async () => {
    const { pendingVectorPhrase } = await import("../src/engine.js");
    expect(pendingVectorPhrase(3)).toBe("3 vector(s)");
    expect(pendingVectorPhrase(0)).toBe("0 vector(s)");
  });

  test("renders the -1 unknown sentinel as words, not a negative count", async () => {
    const { pendingVectorPhrase } = await import("../src/engine.js");
    expect(pendingVectorPhrase(-1)).toBe("an unknown number of vectors");
  });
});

describe("recallQuery type filter over-fetch (fake store) (pwn)", () => {
  // A store that ranks across all types and HONORS the limit it is given, so the
  // requested type can sit just outside the top-`limit` rows. recallQuery must
  // over-fetch BEFORE the post-filter — otherwise the type filter yields empty
  // even though matching facts of that type exist further down (qmemd-pwn).
  const root = "/tmp/qmemd-fake-pwn";
  type Ranked = { type: string; slug: string };

  function rankedStore(ranked: Ranked[]) {
    return {
      async getStatus() { return { totalDocuments: ranked.length, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search(o: { limit?: number }) {
        return ranked.slice(0, o?.limit ?? 10).map(t => ({ file: `qmd://memory/${t.type}/${t.slug}.md`, title: t.slug, score: 0.9 }));
      },
      async searchLex(_q: string, o?: { limit?: number }) {
        return ranked.slice(0, o?.limit ?? 10).map(t => ({ filepath: `qmd://memory/${t.type}/${t.slug}.md`, title: t.slug, score: 0.5 }));
      },
    } as unknown as QMDStore;
  }

  // Three user facts rank above the lone project fact; with limit 3 the project
  // fact is row 4 — outside the user-visible window.
  const ranked: Ranked[] = [
    { type: "user", slug: "u1" }, { type: "user", slug: "u2" },
    { type: "user", slug: "u3" }, { type: "project", slug: "p1" },
  ];

  test("lexOnly: a requested type outside the top-limit is still returned (pwn)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const hits = await recallQuery(rankedStore(ranked), root, "q", { type: "project", limit: 3, lexOnly: true });
    expect(hits.map(h => h.slug)).toContain("p1");
  });

  test("hybrid: a requested type outside the top-limit is still returned (pwn)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const hits = await recallQuery(rankedStore(ranked), root, "q", { type: "project", limit: 3 });
    expect(hits.map(h => h.slug)).toContain("p1");
  });

  test("the user-visible limit is still enforced after the post-filter slice (pwn)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const many: Ranked[] = Array.from({ length: 20 }, (_, i) => ({ type: "project", slug: `p${i}` }));
    const hits = await recallQuery(rankedStore(many), root, "q", { type: "project", limit: 3, lexOnly: true });
    expect(hits.length).toBe(3);
  });
});

describe("recallQuery rerank-score floor (fake store) (rde)", () => {
  // The floor is applied to the RERANKER score (explain.rerankScore: ~0.5 neutral,
  // ~0.7+ relevant), NOT the exposed blended .score — that one is position-dominated
  // (rank-1 gets a big RRF bonus → ~0.9 even when irrelevant), so it is a rank proxy,
  // not a confidence signal. recallQuery requests explain traces and filters
  // rerankScore itself; lexOnly never floors (the lex path runs no reranker).
  const root = "/tmp/qmemd-fake-minscore";

  // Three hybrid hits: relevant (rerank 0.73), neutral/irrelevant (0.50), and one
  // with NO explain at all (rerank skipped) which must pass through, not be dropped.
  function captureStore() {
    const searchOpts: Array<Record<string, unknown>> = [];
    const lexOpts: Array<Record<string, unknown>> = [];
    const store = {
      async getStatus() { return { totalDocuments: 3, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search(o: Record<string, unknown>) {
        searchOpts.push(o);
        return [
          { file: "qmd://memory/user/relevant.md", title: "Relevant", score: 0.93, explain: { rerankScore: 0.73 } },
          { file: "qmd://memory/user/neutral.md", title: "Neutral", score: 0.56, explain: { rerankScore: 0.50 } },
          { file: "qmd://memory/user/norerank.md", title: "NoRerank", score: 0.40 }, // explain absent
        ];
      },
      async searchLex(_q: string, o?: Record<string, unknown>) {
        lexOpts.push(o ?? {});
        return [{ filepath: "qmd://memory/user/neutral.md", title: "Neutral", score: 0.5 }];
      },
    } as unknown as QMDStore;
    return { store, searchOpts, lexOpts };
  }

  test("hybrid recall requests explain traces and does NOT use qmd's blended-score minScore", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store, searchOpts } = captureStore();
    await recallQuery(store, root, "foo");
    expect(searchOpts[0].explain).toBe(true);
    expect(searchOpts[0].minScore).toBeUndefined();
  });

  test("the default 0.575 floor drops the neutral (rerank 0.50) hit but keeps the relevant (0.73) one", async () => {
    const { recallQuery, DEFAULT_MIN_SCORE } = await import("../src/engine.js");
    const { store } = captureStore();
    expect(DEFAULT_MIN_SCORE).toBe(0.575);
    const slugs = (await recallQuery(store, root, "foo")).map(h => h.slug);
    expect(slugs).toContain("relevant");
    expect(slugs).not.toContain("neutral");
  });

  test("a hit with no rerankScore (rerank skipped) is kept, not silently dropped", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store } = captureStore();
    const slugs = (await recallQuery(store, root, "foo")).map(h => h.slug);
    expect(slugs).toContain("norerank");
  });

  test("an explicit minScore above the relevant band drops even the 0.73 hit (but never the no-rerank one)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store } = captureStore();
    const slugs = (await recallQuery(store, root, "foo", { minScore: 0.8 })).map(h => h.slug);
    expect(slugs).not.toContain("relevant");
    expect(slugs).not.toContain("neutral");
    expect(slugs).toContain("norerank"); // undefined rerankScore is never floored
  });

  test("minScore:0 disables the floor — the neutral 0.50 hit is kept", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store } = captureStore();
    const slugs = (await recallQuery(store, root, "foo", { minScore: 0 })).map(h => h.slug);
    expect(slugs).toContain("neutral");
  });

  test("lexOnly recall never floors (no reranker), even with an explicit minScore (rde)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const { store, searchOpts, lexOpts } = captureStore();
    const slugs = (await recallQuery(store, root, "foo", { lexOnly: true, minScore: 0.9 })).map(h => h.slug);
    expect(searchOpts.length).toBe(0);              // hybrid search never reached
    expect(lexOpts[0].minScore).toBeUndefined();    // no floor leaks into the lex path
    expect(slugs).toContain("neutral");             // the lex hit survives regardless
  });
});

describe("remember reindex best-effort (fake store) (1ro)", () => {
  test("fact persists and remember resolves wrote:true even if reindex throws", async () => {
    const { remember } = await import("../src/engine.js");
    const calls: string[] = [];
    const store = {
      async searchLex() { calls.push("searchLex"); return []; },
      async update() { calls.push("update"); throw new Error("SQLITE_BUSY"); },
    } as unknown as QMDStore;
    const tmp = await mkt(join(tmpdir(), "qmemd-1ro-"));
    try {
      const res = await remember(store, tmp, { fact: "Durable under reindex failure", type: "project" });
      expect(res.wrote).toBe(true);
      expect(calls).toContain("update");
      expect(existsSync(join(tmp, "project", `${res.slug}.md`))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("remember indexed signal (32x)", () => {
  test("reindex failure returns wrote:true, indexed:false; fact still persists+commits (32x)", async () => {
    const { remember } = await import("../src/engine.js");
    const store = {
      async searchLex() { return []; },
      async update() { throw new Error("SQLITE_BUSY"); },
    } as unknown as QMDStore;
    const tmp = await mkt(join(tmpdir(), "qmemd-32x-"));
    try {
      const res = await remember(store, tmp, { fact: "Unindexed fact", type: "project" });
      // Don't regress 1ro: the write still happens and wrote stays true.
      expect(res.wrote).toBe(true);
      expect(res.indexed).toBe(false);
      expect(existsSync(join(tmp, "project", `${res.slug}.md`))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("a normal remember returns indexed:true (32x)", async () => {
    const { remember } = await import("../src/engine.js");
    const store = {
      async searchLex() { return []; },
      async update() { /* reindex succeeds */ },
    } as unknown as QMDStore;
    const tmp = await mkt(join(tmpdir(), "qmemd-32x-ok-"));
    try {
      const res = await remember(store, tmp, { fact: "Indexed fact", type: "project" });
      expect(res.wrote).toBe(true);
      expect(res.indexed).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("dedup/no-write path reports indexed:true (32x)", async () => {
    const { remember } = await import("../src/engine.js");
    const store = {
      async searchLex() { return []; },
      async update() { /* reindex succeeds */ },
    } as unknown as QMDStore;
    const tmp = await mkt(join(tmpdir(), "qmemd-32x-dup-"));
    try {
      const first = await remember(store, tmp, { fact: "Dedup fact", type: "project" });
      expect(first.wrote).toBe(true);
      // Same slug already on disk → Tier-1 dedup, nothing newly written.
      const second = await remember(store, tmp, { fact: "Dedup fact", type: "project" });
      expect(second.wrote).toBe(false);
      expect(second.indexed).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("remember sync signal (ddr)", () => {
  const okStore = () => ({ async searchLex() { return []; }, async update() { /* reindex ok */ } } as unknown as QMDStore);

  test("a failing git commit returns wrote:true but synced:false; the fact still persists locally", async () => {
    const { remember } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-ddr-commit-"));
    try {
      await mkdir(join(tmp, ".git"), { recursive: true }); // a repo, so gitCommit proceeds past isRepo
      const run = (args: string[]) => {
        if (args[0] === "rev-parse") return 0; // upstream exists
        if (args[0] === "diff") return 1;       // changes staged
        if (args[0] === "commit") return 128;   // unconfigured identity → commit fails
        return 0;
      };
      const res = await remember(okStore(), tmp, { fact: "Sync-fail fact alpha", type: "project" }, { run });
      expect(res.wrote).toBe(true);
      expect(res.synced).toBe(false);
      expect(res.syncWarning).toBeTruthy();
      expect(existsSync(join(tmp, "project", `${res.slug}.md`))).toBe(true); // local write survives
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("a failing git push (upstream set) returns synced:false with a push reason", async () => {
    const { remember } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-ddr-push-"));
    try {
      await mkdir(join(tmp, ".git"), { recursive: true });
      const run = (args: string[]) => {
        if (args[0] === "rev-parse") return 0; // upstream exists
        if (args[0] === "diff") return 1;       // staged
        if (args[0] === "commit") return 0;     // commit ok
        if (args[0] === "push") return 1;       // push fails
        return 0;
      };
      const res = await remember(okStore(), tmp, { fact: "Push-fail fact beta", type: "project" }, { run });
      expect(res.synced).toBe(false);
      expect(res.syncWarning).toMatch(/push/i);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("the benign no-repo path reports synced:true (no warning)", async () => {
    const { remember } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-ddr-norepo-"));
    try {
      const res = await remember(okStore(), tmp, { fact: "No-repo fact gamma", type: "project" });
      expect(res.synced).toBe(true);
      expect(res.syncWarning).toBeFalsy();
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("nothing-to-commit (no staged changes) stays synced:true — not flagged as a failure", async () => {
    const { remember } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-ddr-noop-"));
    try {
      await mkdir(join(tmp, ".git"), { recursive: true });
      const run = (args: string[]) => {
        if (args[0] === "rev-parse") return 1; // no upstream
        if (args[0] === "diff") return 0;       // NOTHING staged
        return 0;
      };
      const res = await remember(okStore(), tmp, { fact: "No-op fact delta", type: "project" }, { run });
      expect(res.synced).toBe(true);
      expect(res.syncWarning).toBeFalsy();
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("remember and forget scope the git commit to the fact's own path (qmemd-g6q)", async () => {
    const { remember, forget } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-g6q-spec-"));
    try {
      await mkdir(join(tmp, ".git"), { recursive: true });
      const calls: string[][] = [];
      const run = (args: string[]) => {
        calls.push(args);
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return 0; // a repo
        if (args[0] === "rev-parse") return 1; // no upstream — skip push
        if (args[0] === "diff") return 1;       // staged
        return 0;
      };
      const res = await remember(okStore(), tmp, { fact: "Pathspec fact zeta", type: "project" }, { run });
      const rel = `project/${res.slug}.md`;
      expect(calls).toContainEqual(["add", "-A", "--", rel]);
      expect(calls).toContainEqual(["commit", "-m", `remember: ${res.slug}`, "--", rel]);
      calls.length = 0;
      await forget(okStore(), tmp, res.slug, { run });
      expect(calls).toContainEqual(["add", "-A", "--", rel]);
      expect(calls).toContainEqual(["commit", "-m", `forget: ${res.slug}`, "--", rel]);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("forget surfaces synced:false when its commit fails", async () => {
    const { remember, forget } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-ddr-forget-"));
    try {
      // Seed a fact with no repo (write succeeds, synced n/a), THEN make it a repo and
      // forget with a failing commit runner.
      const res = await remember(okStore(), tmp, { fact: "Forget-fail fact epsilon", type: "project" });
      await mkdir(join(tmp, ".git"), { recursive: true });
      const run = (args: string[]) => {
        if (args[0] === "rev-parse") return 0;
        if (args[0] === "diff") return 1;
        if (args[0] === "commit") return 128;
        return 0;
      };
      const del = await forget(okStore(), tmp, res.slug, { run });
      expect(del.removed).toBe(true);
      expect(del.synced).toBe(false);
      expect(del.syncWarning).toBeTruthy();
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
});

describe("parseMemory frontmatter type safety (h4j)", () => {
  // The `"`-prefix guard already means JSON.parse can only yield a string (a JSON
  // value starting with `"` IS a string), so a non-string never reaches a string
  // field — these lock that invariant; the typeof guard makes the cast honest.
  test("a hand-edited non-string-looking scalar stays a string in a string field (h4j)", () => {
    for (const raw of ["[1,2]", "123", "true", "null", '"[9,9]"', '{"a":1}']) {
      const fm = parseMemory(`---\nname: ${raw}\ntype: user\n---\nbody\n`).frontmatter;
      expect(typeof fm.name).toBe("string");
    }
  });

  test("tags decode to strings even when entries look numeric (h4j)", () => {
    const fm = parseMemory("---\ntags: [1, 2, 3]\nname: n\ntype: user\n---\nb\n").frontmatter;
    expect(fm.tags.length).toBe(3);
    expect(fm.tags.every(t => typeof t === "string")).toBe(true);
  });
});

describe("parseMemory source field empty-string policy (qmemd-9go)", () => {
  // A present-but-empty `source:` line is a value (""), distinct from an absent line
  // (undefined). The old `unquoteScalar(val) || undefined` conflated the two — the same
  // ||-for-missing class as the created-date bug. Lock the present/absent distinction.
  test("a present-but-empty source decodes to '' (not coerced to undefined)", () => {
    const fm = parseMemory("---\nname: s\ntype: project\ncreated: 2026-06-06\npinned: false\nsource:\n---\n\nbody\n").frontmatter;
    expect(fm.source).toBe("");
  });
  test("an absent source line stays undefined", () => {
    const fm = parseMemory("---\nname: s\ntype: project\ncreated: 2026-06-06\npinned: false\n---\n\nbody\n").frontmatter;
    expect(fm.source).toBeUndefined();
  });
  test("a real source value round-trips", () => {
    const fm = parseMemory("---\nname: s\ntype: project\ncreated: 2026-06-06\npinned: false\nsource: code-review\n---\n\nbody\n").frontmatter;
    expect(fm.source).toBe("code-review");
  });
});

describe("forget reclaims tombstone + orphaned rows (2dh)", () => {
  type RawDB = { prepare(sql: string): { get(): { c: number } } };

  test("after forget, no active=0 tombstone row remains in the index (2dh)", async () => {
    const { remember, forget } = await import("../src/engine.js");
    const tmp = await mkt(join(tmpdir(), "qmemd-2dh-"));
    const dbDir = await mkt(join(tmpdir(), "qmemd-2dhdb-"));
    const store = await openQmd({ dbPath: join(dbDir, "i.sqlite"), config: { collections: { memory: { path: tmp, pattern: "**/*.md" } } } });
    try {
      const w = await remember(store, tmp, { fact: "Reclaimable fact", type: "project", as: "reclaim-x" });
      expect(w.wrote).toBe(true);
      const db = (store.internal as unknown as { db: RawDB }).db;
      const count = (sql: string) => db.prepare(sql).get().c;
      expect(count("SELECT COUNT(*) AS c FROM documents WHERE active = 1")).toBeGreaterThanOrEqual(1);

      const res = await forget(store, tmp, "reclaim-x");
      expect(res.removed).toBe(true);
      // The soft-deleted tombstone (active=0) must be hard-dropped, not leaked.
      expect(count("SELECT COUNT(*) AS c FROM documents WHERE active = 0")).toBe(0);
      // And the document is fully gone (no row of either flag for that file).
      expect(count("SELECT COUNT(*) AS c FROM documents")).toBe(0);
    } finally {
      await store.close();
      await rm(tmp, { recursive: true, force: true });
      await rm(dbDir, { recursive: true, force: true });
    }
  });

  test("forget still returns removed:true when reclaim cleanup throws (best-effort) (2dh)", async () => {
    const { forget } = await import("../src/engine.js");
    // Real file on disk so forget enters the removal branch; a fake store whose
    // update() succeeds but whose `internal` access throws, so the Maintenance
    // cleanup blows up — forget must swallow it and still report removed:true.
    const tmp = await mkt(join(tmpdir(), "qmemd-2dh-be-"));
    const dir = join(tmp, "project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "be-x.md"), "---\nname: be-x\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2026-06-01\npinned: false\n---\nbody\n");
    const store = { async update() { /* reindex ok */ }, get internal(): never { throw new Error("no internal"); } } as unknown as QMDStore;
    try {
      const res = await forget(store, tmp, "be-x");
      expect(res.removed).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("listFacts (bgf)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-list-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function put(type: MemoryType, slug: string, over: Partial<MemoryFrontmatter> = {}, body = "body") {
    await mkdir(join(root, type), { recursive: true });
    const fm: MemoryFrontmatter = {
      name: slug, description: `desc ${slug}`, type, tags: [], project: "global",
      created: "2026-06-01", pinned: false, ...over,
    };
    await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, body));
  }

  test("empty dir returns []", () => {
    expect(listFacts(root)).toEqual([]);
  });

  test("type filter narrows to one folder", async () => {
    await put("user", "u1");
    await put("project", "p1");
    expect(listFacts(root, { type: "user" }).map(e => e.slug)).toEqual(["u1"]);
  });

  test("tag filter keeps only facts carrying the tag", async () => {
    await put("reference", "tagged", { tags: ["lab"] });
    await put("reference", "untagged", { tags: [] });
    expect(listFacts(root, { tag: "lab" }).map(e => e.slug)).toEqual(["tagged"]);
  });

  test("project 'alpha' includes global, project 'global' returns global-only", async () => {
    await put("project", "alpha-fact", { project: "alpha" });
    await put("project", "global-fact", { project: "global" });
    expect(listFacts(root, { project: "alpha" }).map(e => e.slug).sort()).toEqual(["alpha-fact", "global-fact"]);
    expect(listFacts(root, { project: "global" }).map(e => e.slug)).toEqual(["global-fact"]);
  });

  test("sorted by created descending", async () => {
    await put("project", "old", { created: "2026-01-01" });
    await put("project", "new", { created: "2026-06-01" });
    expect(listFacts(root).map(e => e.slug)).toEqual(["new", "old"]);
  });

  test("slug is the filename stem even when frontmatter.name was hand-edited to differ", async () => {
    await put("project", "real-slug", { name: "drifted-name" });
    expect(listFacts(root).map(e => e.slug)).toEqual(["real-slug"]);
  });

  test("platform filter keeps facts valid on that platform (via platformVisible)", async () => {
    await put("project", "mac-only", { platforms: ["macos"] });
    await put("project", "cross", { platforms: [] });
    await put("project", "linux-ok", { platforms: ["linux"] });
    const slugs = listFacts(root, { platform: "linux" }).map(e => e.slug).sort();
    expect(slugs).toEqual(["cross", "linux-ok"]); // mac-only excluded; cross-platform always included
  });

  test("no platform filter returns everything (browse shows all)", async () => {
    await put("project", "mac-only", { platforms: ["macos"] });
    await put("project", "cross", {});
    expect(listFacts(root).map(e => e.slug).sort()).toEqual(["cross", "mac-only"]);
  });

  test("ListEntry carries platforms", async () => {
    await put("project", "mac-only", { platforms: ["macos"] });
    expect(listFacts(root).find(e => e.slug === "mac-only")?.platforms).toEqual(["macos"]);
  });

  it("carries supersededBy so audit surfaces can mark retired facts (bri)", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "retired.md"),
      "---\nname: retired\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2026-01-01\npinned: false\nsuperseded_by: live\n---\n\nbody\n");
    const entries = listFacts(root, {});
    expect(entries.find(e => e.slug === "retired")!.supersededBy).toBe("live");
  });
});

describe("getFact (bgf)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-get-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("returns the full fact (frontmatter + body) for an existing slug", async () => {
    await mkdir(join(root, "reference"), { recursive: true });
    await writeFile(join(root, "reference", "grafana-url.md"), serializeMemory(
      { name: "grafana-url", description: "Grafana dashboard", type: "reference", tags: ["obs"], project: "global", created: "2026-06-01", pinned: false },
      "https://grafana.example/d/abc\nsecond line"));
    const fact = getFact(root, "grafana-url");
    expect(fact).not.toBeNull();
    expect(fact!.type).toBe("reference");
    expect(fact!.frontmatter.description).toBe("Grafana dashboard");
    expect(fact!.body.trim()).toBe("https://grafana.example/d/abc\nsecond line");
  });

  test("returns null when no folder holds the slug", () => {
    expect(getFact(root, "no-such-slug")).toBeNull();
  });

  test("finds a fact stored under a non-default type (cross-type scan)", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "lab-pi.md"), serializeMemory(
      { name: "lab-pi", description: "Pi at .34", type: "project", tags: [], project: "global", created: "2026-06-01", pinned: false },
      "body"));
    expect(getFact(root, "lab-pi")!.type).toBe("project");
  });

  test("an unsafe slug throws via assertSafeSlug (fd8)", () => {
    expect(() => getFact(root, "../etc/passwd")).toThrow(/unsafe slug/);
    expect(() => getFact(root, "ok\ninjected")).toThrow(/unsafe slug/);
  });
});

describe("recallQuery exposes calibrated rerank score + orders by it (qmemd-373)", () => {
  // qmd returns hybrid hits in blended-RRF order, where rank-1 carries a large position
  // bonus (blended .score ≈ 0.9) regardless of true relevance — a rank proxy the agent
  // over-trusts. The reranker's explain.rerankScore (~0.5 neutral, ~0.7+ relevant) is the
  // calibrated relevance signal qmemd already uses for the floor. recallQuery must EXPOSE
  // that as the hit score and ORDER by it, so a weak rank-1 (high blended, low rerank)
  // cannot sit above a strong rank-2 (qmemd-373, measured F3 field report).
  const root = "/tmp/qmemd-fake-373";

  function store373() {
    return {
      async getStatus() { return { totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      // Returned in blended order: topical is rank-1 by position (0.93) but weaker on
      // rerank (0.60); relevant is rank-2 by position (0.55) but the stronger match (0.72).
      async search() {
        return [
          { file: "qmd://memory/project/topical.md", title: "Topical", score: 0.93, explain: { rerankScore: 0.60 } },
          { file: "qmd://memory/project/relevant.md", title: "Relevant", score: 0.55, explain: { rerankScore: 0.72 } },
        ];
      },
      async searchLex() { return []; },
    } as unknown as QMDStore;
  }

  test("the exposed .score is the reranker score, not qmd's position-dominated blended score", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const hits = await recallQuery(store373(), root, "q");
    expect(hits.find(h => h.slug === "relevant")?.score).toBe(0.72); // not the blended 0.55
    expect(hits.find(h => h.slug === "topical")?.score).toBe(0.60);  // not the blended 0.93
  });

  test("hits are ordered by rerank score, so a weak rank-1 cannot outrank a strong rank-2", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const slugs = (await recallQuery(store373(), root, "q")).map(h => h.slug);
    expect(slugs).toEqual(["relevant", "topical"]); // reordered from the blended [topical, relevant]
  });

  test("falls back to the blended score for ordering/display only when rerank was skipped (explain absent)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const store = {
      async getStatus() { return { totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search() { return [{ file: "qmd://memory/project/norerank.md", title: "NoRerank", score: 0.42 }]; },
      async searchLex() { return []; },
    } as unknown as QMDStore;
    expect((await recallQuery(store, root, "q"))[0]?.score).toBe(0.42); // no rerank → blended is the fallback
  });

  test("lexOnly hits keep their BM25 score (the lex path runs no reranker)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    const store = {
      async getStatus() { return { totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search() { return []; },
      async searchLex() { return [{ filepath: "qmd://memory/project/lexhit.md", title: "LexHit", score: 0.5 }]; },
    } as unknown as QMDStore;
    expect((await recallQuery(store, root, "q", { lexOnly: true }))[0]?.score).toBe(0.5);
  });
});

describe("projectOverview (tfu)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-ov-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const write = async (type: MemoryType, name: string, project: string, tags: string[]) => {
    await mkdir(join(root, type), { recursive: true });
    await writeFile(join(root, type, `${name}.md`), serializeMemory(
      { name, description: name, type, tags, project, created: "2026-06-01", pinned: false }, "body"));
  };

  test("counts project+global facts and histograms their tags", async () => {
    await write("project", "a", "beta", ["jdk", "build"]);
    await write("project", "b", "beta", ["jdk"]);
    await write("project", "c", "global", ["k3s"]);
    await write("project", "d", "other-repo", ["nope"]); // excluded (different project)
    const ov = projectOverview(root, "beta", ["project", "reference"]);
    expect(ov.total).toBe(3); // a, b, c (global) — not d
    expect(formatTagHistogram(ov.tags)).toBe("jdk(2) build(1) k3s(1)");
    expect(ov.byType.project).toBe(3);
    expect(ov.byType.reference).toBe(0);
  });

  test("restricting types excludes always-on user/feedback from the count", async () => {
    await write("project", "p", "beta", ["build"]);
    await write("feedback", "f", "global", ["convention"]);
    const beacon = projectOverview(root, "beta", ["project", "reference"]);
    expect(beacon.total).toBe(1); // feedback excluded
    const all = projectOverview(root, "beta");
    expect(all.total).toBe(2);    // default = all types
  });

  test("empty project yields total 0 and empty tags", async () => {
    const ov = projectOverview(root, "nothing", ["project", "reference"]);
    expect(ov.total).toBe(0);
    expect(ov.tags).toEqual([]);
  });

  test("splits repo-scoped vs global facts into repo/global sub-overviews", async () => {
    await write("project", "a", "beta", ["jdk", "build"]);
    await write("project", "b", "beta", ["jdk"]);
    await write("project", "c", "global", ["k3s"]);
    await write("project", "d", "other-repo", ["nope"]); // excluded entirely
    const ov = projectOverview(root, "beta", ["project", "reference"]);
    // mixed fields unchanged
    expect(ov.total).toBe(3);
    expect(formatTagHistogram(ov.tags)).toBe("jdk(2) build(1) k3s(1)");
    // new split
    expect(ov.repo.total).toBe(2);
    expect(formatTagHistogram(ov.repo.tags)).toBe("jdk(2) build(1)");
    expect(ov.global.total).toBe(1);
    expect(formatTagHistogram(ov.global.tags)).toBe("k3s(1)");
  });

  test("listFacts entries carry the frontmatter project", async () => {
    await write("project", "a", "beta", ["jdk"]);
    await write("project", "c", "global", ["k3s"]);
    const entries = listFacts(root, { project: "beta" });
    expect(entries.find(e => e.slug === "a")?.project).toBe("beta");
    expect(entries.find(e => e.slug === "c")?.project).toBe("global");
  });

  test("querying project 'global' puts everything in global, repo stays 0", async () => {
    await write("project", "c", "global", ["k3s"]);
    await write("project", "d", "other-repo", ["nope"]); // gated out
    const ov = projectOverview(root, "global", ["project", "reference"]);
    expect(ov.repo.total).toBe(0);
    expect(ov.repo.tags).toEqual([]);
    expect(ov.global.total).toBe(1);
    expect(ov.total).toBe(1);
  });
});

describe("platform primitives (platform scoping)", () => {
  test("PLATFORMS is the closed linux|macos|windows set", async () => {
    const { PLATFORMS } = await import("../src/engine.js");
    expect(PLATFORMS).toEqual(["linux", "macos", "windows"]);
  });

  test("platformFromNode maps node platforms to OS families, unknown → all", async () => {
    const { platformFromNode } = await import("../src/engine.js");
    expect(platformFromNode("linux")).toBe("linux");
    expect(platformFromNode("darwin")).toBe("macos");
    expect(platformFromNode("win32")).toBe("windows");
    // Anything else disables filtering rather than hiding facts.
    expect(platformFromNode("freebsd" as NodeJS.Platform)).toBe("all");
    expect(platformFromNode("aix" as NodeJS.Platform)).toBe("all");
  });

  test("currentPlatform derives from process.platform via platformFromNode", async () => {
    const { currentPlatform, platformFromNode } = await import("../src/engine.js");
    expect(currentPlatform()).toBe(platformFromNode(process.platform));
  });

  test("platformVisible truth table: all / empty / member / non-member", async () => {
    const { platformVisible } = await import("../src/engine.js");
    // current === "all" always shows (exotic host never hides).
    expect(platformVisible([], "all")).toBe(true);
    expect(platformVisible(["macos"], "all")).toBe(true);
    // empty platforms = cross-platform = always shows.
    expect(platformVisible([], "linux")).toBe(true);
    // membership.
    expect(platformVisible(["macos"], "macos")).toBe(true);
    expect(platformVisible(["linux", "macos"], "linux")).toBe(true);
    // non-member hides.
    expect(platformVisible(["macos"], "linux")).toBe(false);
    expect(platformVisible(["windows"], "linux")).toBe(false);
  });

  test("assertValidPlatforms accepts known tokens, throws a path-free error on unknown", async () => {
    const { assertValidPlatforms } = await import("../src/engine.js");
    expect(() => assertValidPlatforms(["linux", "macos"])).not.toThrow();
    expect(() => assertValidPlatforms([])).not.toThrow();
    expect(() => assertValidPlatforms(["linux", "freebsd"])).toThrow(/invalid platform/);
    // Message names the offending token and the valid set — never a filesystem path.
    try { assertValidPlatforms(["bogus"]); } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("bogus");
      expect(msg).toContain("linux | macos | windows");
      expect(msg).not.toContain("/");
    }
  });
});

describe("serializeMemory / parseMemory — platforms field", () => {
  const base = (over: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter => ({
    name: "n", description: "d", type: "project", tags: [], project: "global",
    created: "2026-06-08", pinned: false, ...over,
  });

  test("empty/omitted platforms emits NO platforms line (no corpus churn)", () => {
    expect(serializeMemory(base({ platforms: [] }), "b")).not.toContain("platforms:");
    expect(serializeMemory(base(), "b")).not.toContain("platforms:"); // undefined too
  });

  test("non-empty platforms emits a flow list after project, before created", () => {
    const out = serializeMemory(base({ platforms: ["linux", "macos"] }), "b");
    expect(out).toContain("platforms: [linux, macos]");
    const lines = out.split("\n");
    expect(lines.indexOf("project: global")).toBeLessThan(lines.findIndex(l => l.startsWith("platforms:")));
    expect(lines.findIndex(l => l.startsWith("platforms:"))).toBeLessThan(lines.indexOf("created: 2026-06-08"));
  });

  test("platforms round-trips through serialize → parse", () => {
    const out = serializeMemory(base({ platforms: ["windows"] }), "body");
    expect(parseMemory(out).frontmatter.platforms).toEqual(["windows"]);
  });

  test("parse defaults platforms to [] when the line is absent", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\ncreated: 2026-06-08\n---\nbody`;
    expect(parseMemory(text).frontmatter.platforms).toEqual([]);
  });

  test("parse drops unknown tokens, lowercases, and dedupes", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\nplatforms: [LINUX, freebsd, linux, MacOS]\ncreated: 2026-06-08\n---\nbody`;
    // freebsd dropped (unknown); LINUX/linux collapse; MacOS → macos.
    expect(parseMemory(text).frontmatter.platforms).toEqual(["linux", "macos"]);
  });
});

describe("recallSession platform gate (core fix)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-plat-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function put(type: MemoryType, slug: string, over: Partial<MemoryFrontmatter> = {}, body = "body text") {
    await mkdir(join(root, type), { recursive: true });
    const fm: MemoryFrontmatter = {
      name: slug, description: `desc ${slug}`, type, tags: [], project: "global",
      created: "2026-06-08", pinned: false, ...over,
    };
    await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, body));
  }

  test("a [macos] fact is hidden on linux, shown on mac; cross-platform always shows", async () => {
    await put("project", "mac-only", { platforms: ["macos"] });
    await put("project", "everywhere", { platforms: [] });
    const onLinux = await recallSession(root, { project: "global", platform: "linux" });
    expect(onLinux).not.toContain("mac-only");
    expect(onLinux).toContain("everywhere");
    const onMac = await recallSession(root, { project: "global", platform: "macos" });
    expect(onMac).toContain("mac-only");
    expect(onMac).toContain("everywhere");
  });

  test("user, feedback, and pinned lanes are all gated", async () => {
    await put("user", "mac-pref", { platforms: ["macos"] }, "a mac-only preference");
    await put("feedback", "win-guidance", { platforms: ["windows"] }, "a windows-only correction");
    await put("reference", "linux-pin", { platforms: ["linux"], pinned: true, description: "a pinned linux ref" }, "a pinned linux ref");
    const onLinux = await recallSession(root, { project: "global", platform: "linux" });
    expect(onLinux).not.toContain("a mac-only preference");
    expect(onLinux).not.toContain("a windows-only correction");
    expect(onLinux).toContain("a pinned linux ref"); // pinned + on-platform shows
  });

  test("current === all (exotic host) disables the gate — everything shows", async () => {
    await put("project", "mac-only", { platforms: ["macos"] });
    const out = await recallSession(root, { project: "global", platform: "all" });
    expect(out).toContain("mac-only");
  });

  test("the project footer count reflects the platform-filtered in-scope set", async () => {
    // 6 project facts in scope, but 2 are macos-only → on linux only 4 are in scope,
    // under the projectLimit of 5, so NO "N more" footer fires.
    for (let i = 0; i < 4; i++) await put("project", `p${i}`, { created: `2026-06-0${i + 1}` });
    await put("project", "m0", { platforms: ["macos"], created: "2026-06-07" });
    await put("project", "m1", { platforms: ["macos"], created: "2026-06-08" });
    const onLinux = await recallSession(root, { project: "global", platform: "linux" });
    expect(onLinux).not.toContain("more) — qmemd list"); // 4 in scope ≤ 5 → no footer
    // On mac all 6 are in scope (> 5) → the footer fires and counts 6.
    const onMac = await recallSession(root, { project: "global", platform: "macos" });
    expect(onMac).toContain("6 project facts for global");
  });

  test("hidden user/feedback facts emit a platform-hidden signal, not silence (qmemd-b1a)", async () => {
    // The spec filters every lane by platform; the BUG is that user/feedback — lanes the
    // agent is told are EXHAUSTIVE — vanish with no footer or beacon. Keep the filter, but
    // announce the hidden count so guidance is never silently withheld.
    await put("user", "mac-pref", { platforms: ["macos"] }, "a mac-only preference");
    await put("feedback", "win-fix", { platforms: ["windows"] }, "a windows-only correction");
    await put("user", "cross", {}, "a universal pref");
    const onLinux = await recallSession(root, { project: "global", platform: "linux" });
    expect(onLinux).toContain("a universal pref");           // on-platform still shown
    expect(onLinux).not.toContain("a mac-only preference");  // off-platform still filtered (spec)
    expect(onLinux).not.toContain("a windows-only correction");
    expect(onLinux).toMatch(/2 .*user\/feedback.*hidden on linux/i); // ...but signalled
  });

  test("an all-off-platform user/feedback corpus still emits a snapshot (signal), not '' (qmemd-b1a)", async () => {
    // Previously a corpus whose only facts are off-platform returned "" — total silence
    // for a lane the agent treats as exhaustive. The hidden signal must break that silence.
    await put("feedback", "win-only", { platforms: ["windows"] }, "windows guidance");
    const onLinux = await recallSession(root, { project: "global", platform: "linux" });
    expect(onLinux).not.toBe("");
    expect(onLinux).toMatch(/1 .*user\/feedback.*hidden on linux/i);
  });

  test("the footer's suggested list command is platform-scoped to match its filtered count (qmemd-b1a)", async () => {
    // 7 project facts in scope on linux → the "N more" footer fires (>5). Its count is the
    // platform-FILTERED in-scope total (spec), so the suggested `list` must also carry
    // --platform, else running it shows MORE facts than the count promised.
    for (let i = 0; i < 7; i++) await put("project", `p${i}`, { created: `2026-06-0${i + 1}` });
    const onLinux = await recallSession(root, { project: "global", platform: "linux" });
    expect(onLinux).toContain("7 project facts for global");
    expect(onLinux).toContain("qmemd list --type project --project global --platform linux");
  });

  test("on an exotic host (platform 'all') the footer command omits --platform (qmemd-b1a)", async () => {
    // current === "all" disables filtering, so the count is un-scoped and the command must
    // not append a bogus `--platform all` (not a real platform token).
    for (let i = 0; i < 7; i++) await put("project", `p${i}`, { created: `2026-06-0${i + 1}` });
    const out = await recallSession(root, { project: "global", platform: "all" });
    expect(out).toContain("7 project facts for global");
    expect(out).not.toContain("--platform");
  });
});

describe("remember platforms (SDK-backed)", () => {
  let root: string, dbPath: string, store: QMDStore;
  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-mem-plat-"));
    dbPath = join(await mkt(join(tmpdir(), "qmemd-db-")), "i.sqlite");
    store = await openQmd({ dbPath, config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  test("platforms are written to the fact frontmatter", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "Metal embed load fails on this mac", type: "project", platforms: ["macos"] });
    expect(res.wrote).toBe(true);
    expect(getFact(root, res.slug)!.frontmatter.platforms).toEqual(["macos"]);
  });

  test("platforms are inherited on --replace when not passed (like tags/project)", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "Systemd user units serve the daemon", type: "project", platforms: ["linux"] });
    await remember(store, root, { fact: "Systemd user units serve the qmemd daemon", replace: first.slug });
    expect(getFact(root, first.slug)!.frontmatter.platforms).toEqual(["linux"]);
  });

  test("an explicit platforms on --replace overrides the inherited value", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "fact a", type: "project", platforms: ["linux"] });
    await remember(store, root, { fact: "fact a revised", replace: first.slug, platforms: ["linux", "macos"] });
    expect(getFact(root, first.slug)!.frontmatter.platforms).toEqual(["linux", "macos"]);
  });

  // Contract lock for qmemd-t0z: an explicit empty array CLEARS scope (≠ omitted, which
  // inherits). The CLI un-scope path (--platforms "") and the MCP/HTTP platforms:[] surface
  // all rely on this engine guarantee, so pin it down.
  test("an explicit empty platforms array on --replace clears scope back to cross-platform (qmemd-t0z)", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "fact b", type: "project", platforms: ["macos"] });
    await remember(store, root, { fact: "fact b revised", replace: first.slug, platforms: [] });
    expect(getFact(root, first.slug)!.frontmatter.platforms).toEqual([]);
  });

  test("an unknown platform token is rejected before any write", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    await expect(remember(store, root, { fact: "bad", type: "project", platforms: ["freebsd" as Platform] }))
      .rejects.toThrow(/invalid platform/);
    // Nothing was written.
    expect(getFact(root, slugify("bad"))).toBeNull();
  });
});

// qmemd-sr3: created preservation on --replace. `|| today()` treated an empty-string
// created (reachable: a file with a bare `created: ` line parses to "") as missing and
// fabricated today's date — making an old fact look newest to authority/recency
// consumers. Replace must preserve what the file says: a real date verbatim, and an
// empty created as the honest "unknown" (?? semantics; only a fresh write defaults).
describe("remember --replace preserves created (qmemd-sr3, SDK-backed)", () => {
  let root: string, dbPath: string, store: QMDStore;
  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-mem-created-"));
    dbPath = join(await mkt(join(tmpdir(), "qmemd-db-")), "i.sqlite");
    store = await openQmd({ dbPath, config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  const rewriteCreated = async (path: string, to: string) => {
    const text = readFileSync(path, "utf-8").replace(/^created:.*$/m, `created: ${to}`.trimEnd());
    await writeFile(path, text);
  };

  test("a real created date survives --replace verbatim", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "The daemon restarts via systemd", type: "project" });
    await rewriteCreated(first.path, "2020-01-01");
    await remember(store, root, { fact: "The daemon restarts via systemd user units", replace: first.slug });
    expect(getFact(root, first.slug)!.frontmatter.created).toBe("2020-01-01");
  });

  test("an empty created is preserved, not silently replaced with today()", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "The daemon logs to the cache dir", type: "project" });
    await rewriteCreated(first.path, "");
    await remember(store, root, { fact: "The daemon logs into the cache directory", replace: first.slug });
    expect(getFact(root, first.slug)!.frontmatter.created).toBe("");
  });
});

describe("recallQuery platform gate + one-read restructure", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-rq-plat-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function put(type: MemoryType, slug: string, platforms: Platform[], body = "body") {
    await mkdir(join(root, type), { recursive: true });
    const fm: MemoryFrontmatter = {
      name: slug, description: `desc ${slug}`, type, tags: [], project: "global",
      created: "2026-06-08", pinned: false, platforms,
    };
    await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, body));
  }

  // A store that ranks the slugs we put on disk, honouring the limit it is given, so the
  // over-fetch + gate behaviour can be exercised against real files (lex path = model-free).
  function diskStore(ranked: Array<{ type: string; slug: string }>) {
    return {
      async getStatus() { return { totalDocuments: ranked.length, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search(o: { limit?: number }) {
        return ranked.slice(0, o?.limit ?? 10).map(t => ({ file: `qmd://memory/${t.type}/${t.slug}.md`, title: t.slug, score: 0.9, explain: { rerankScore: 0.8 } }));
      },
      async searchLex(_q: string, o?: { limit?: number }) {
        return ranked.slice(0, o?.limit ?? 10).map(t => ({ filepath: `qmd://memory/${t.type}/${t.slug}.md`, title: t.slug, score: 0.5 }));
      },
    } as unknown as QMDStore;
  }

  test("default (host) platform drops off-platform hits, keeps cross-platform + on-platform", async () => {
    const { recallQuery } = await import("../src/engine.js");
    await put("project", "mac-only", ["macos"]);
    await put("project", "cross", []);
    await put("project", "linux-ok", ["linux"]);
    const ranked = [{ type: "project", slug: "mac-only" }, { type: "project", slug: "cross" }, { type: "project", slug: "linux-ok" }];
    const slugs = (await recallQuery(diskStore(ranked), root, "q", { lexOnly: true, platform: "linux" })).map(h => h.slug);
    expect(slugs).not.toContain("mac-only");
    expect(slugs).toContain("cross");
    expect(slugs).toContain("linux-ok");
  });

  test("over-fetch fills to limit when top-ranked hits are off-platform", async () => {
    const { recallQuery } = await import("../src/engine.js");
    for (let i = 0; i < 3; i++) await put("project", `m${i}`, ["macos"]);
    for (let i = 0; i < 3; i++) await put("project", `l${i}`, ["linux"]);
    const ranked = [
      ...[0, 1, 2].map(i => ({ type: "project", slug: `m${i}` })),
      ...[0, 1, 2].map(i => ({ type: "project", slug: `l${i}` })),
    ];
    const hits = await recallQuery(diskStore(ranked), root, "q", { lexOnly: true, limit: 3, platform: "linux" });
    expect(hits.length).toBe(3);            // filled past the off-platform top rows
    expect(hits.every(h => h.slug.startsWith("l"))).toBe(true);
  });

  test("platform 'all' shows every platform", async () => {
    const { recallQuery } = await import("../src/engine.js");
    await put("project", "mac-only", ["macos"]);
    const slugs = (await recallQuery(diskStore([{ type: "project", slug: "mac-only" }]), root, "q", { lexOnly: true, platform: "all" })).map(h => h.slug);
    expect(slugs).toContain("mac-only");
  });

  test("hits carry their platforms from frontmatter", async () => {
    const { recallQuery } = await import("../src/engine.js");
    await put("project", "mac-only", ["macos"]);
    const hits = await recallQuery(diskStore([{ type: "project", slug: "mac-only" }]), root, "q", { lexOnly: true, platform: "all" });
    expect(hits[0]?.platforms).toEqual(["macos"]);
  });

  test("an unreadable candidate fails open (shown) under a platform filter", async () => {
    const { recallQuery } = await import("../src/engine.js");
    // No file on disk for this slug → parse throws → fail-open → still returned on linux.
    const slugs = (await recallQuery(diskStore([{ type: "project", slug: "ghost" }]), root, "q", { lexOnly: true, platform: "linux" })).map(h => h.slug);
    expect(slugs).toContain("ghost");
  });

  test("refetches when a saturated pool gates to fewer than limit on-platform hits (qmemd-amm)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    // 9 macos facts rank above 1 linux fact. limit=2 ⇒ pool = limit*MEMORY_TYPES.length = 8,
    // so the linux fact (rank 10) never enters the gated pool. Without a refetch the platform
    // gate empties the saturated pool and recall returns 0 on linux — dropping an on-platform
    // hit that exists (qmemd-pwn class, extended to the platform dimension).
    for (let i = 0; i < 9; i++) await put("project", `m${i}`, ["macos"]);
    await put("project", "linux-deep", ["linux"]);
    const ranked = [
      ...Array.from({ length: 9 }, (_, i) => ({ type: "project", slug: `m${i}` })),
      { type: "project", slug: "linux-deep" },
    ];
    const hits = await recallQuery(diskStore(ranked), root, "q", { lexOnly: true, limit: 2, platform: "linux" });
    expect(hits.map(h => h.slug)).toContain("linux-deep");
  });

  test("does not refetch when the pool was not saturated (corpus exhausted) (qmemd-amm)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    // Only 2 facts exist, both off-platform. The pool (8) is never saturated, so the gate
    // legitimately underflows — recall returns [] without an unbounded refetch.
    await put("project", "m0", ["macos"]);
    await put("project", "m1", ["macos"]);
    const ranked = [{ type: "project", slug: "m0" }, { type: "project", slug: "m1" }];
    const hits = await recallQuery(diskStore(ranked), root, "q", { lexOnly: true, limit: 2, platform: "linux" });
    expect(hits.length).toBe(0);
  });

  test("hybrid saturation signal counts RAW rows, not post-rerank-floor survivors (qmemd-amm)", async () => {
    const { recallQuery } = await import("../src/engine.js");
    // 9 macos + 1 deep linux. The hybrid pool (limit*4=8) is saturated with macos rows, but
    // SOME fall below the rerank floor (DEFAULT_MIN_SCORE=0.575). The refetch must still fire —
    // proving the saturation check uses the raw row count (8 === fetchLimit), NOT the shorter
    // post-filter survivor count. If rawCount were taken after the floor, no refetch would fire
    // and linux-deep (rank 10) would be dropped.
    for (let i = 0; i < 9; i++) await put("project", `m${i}`, ["macos"]);
    await put("project", "linux-deep", ["linux"]);
    const ranked = [
      ...Array.from({ length: 9 }, (_, i) => ({ type: "project", slug: `m${i}` })),
      { type: "project", slug: "linux-deep" },
    ];
    // Hybrid store: honors the limit; first 3 rows get a below-floor rerankScore, so the
    // post-filter hit list is shorter than the raw row count the saturation check reads.
    const hybridStore = {
      async getStatus() { return { totalDocuments: ranked.length, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search(o: { limit?: number }) {
        return ranked.slice(0, o?.limit ?? 10).map((t, i) => ({ file: `qmd://memory/${t.type}/${t.slug}.md`, title: t.slug, score: 0.9, explain: { rerankScore: i < 3 ? 0.2 : 0.8 } }));
      },
      async searchLex() { return []; },
    } as unknown as QMDStore;
    const hits = await recallQuery(hybridStore, root, "q", { limit: 2, platform: "linux" }); // hybrid (no lexOnly)
    expect(hits.map(h => h.slug)).toContain("linux-deep");
  });
});

describe("recall completeness counters (40h)", () => {
  // No files on disk: the type/platform gate fail-opens on unreadable candidates (fm null),
  // so fake-store hits pass the gates and the counters are exercised in isolation.
  const root = "/tmp/qmemd-fake-40h";

  function lexStore(slugs: string[]) {
    return {
      async getStatus() { return { totalDocuments: slugs.length, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search() { return []; },
      async searchLex(_q: string, o?: { limit?: number }) {
        // Honors the pool cap like the real store — saturation is observable.
        return slugs.slice(0, o?.limit ?? 10).map(s => ({ filepath: `qmd://memory/project/${s}.md`, title: s, score: 0.5 }));
      },
    } as unknown as QMDStore;
  }

  function hybridFloorStore(rows: Array<{ type: string; slug: string; rerank?: number }>) {
    return {
      async getStatus() { return { totalDocuments: rows.length, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search(o: { limit?: number }) {
        return rows.slice(0, o?.limit ?? 10).map(r => ({
          file: `qmd://memory/${r.type}/${r.slug}.md`, title: r.slug, score: 0.9,
          ...(r.rerank !== undefined ? { explain: { rerankScore: r.rerank } } : {}),
        }));
      },
      async searchLex() { return []; },
    } as unknown as QMDStore;
  }

  test("lex surplus is exact when the pool is not saturated (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const slugs = ["a", "b", "c", "d", "e"]; // 5 matches; pool 3*4=12 → unsaturated
    const res = await recallQueryWithStatus(lexStore(slugs), root, "q", { lexOnly: true, limit: 3 });
    expect(res.hits.length).toBe(3);
    expect(res.moreMatches).toBe(2);
    expect(res.saturated).toBe(false);
    expect(res.belowFloor).toBe(0);
  });

  test("lex surplus is a lower bound when the pool saturates (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const slugs = Array.from({ length: 20 }, (_, i) => `s${i}`); // pool 12 comes back full
    const res = await recallQueryWithStatus(lexStore(slugs), root, "q", { lexOnly: true, limit: 3 });
    expect(res.hits.length).toBe(3);
    expect(res.moreMatches).toBe(9);   // 12 in pool − 3 shown
    expect(res.saturated).toBe(true);  // 20 > 12: matches may sit past the pool
  });

  test("hybrid floor drops are counted; minScore 0 zeroes the count (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const rows = [
      { type: "user", slug: "relevant", rerank: 0.73 },
      { type: "user", slug: "neutral-1", rerank: 0.50 },
      { type: "user", slug: "neutral-2", rerank: 0.52 },
      { type: "user", slug: "norerank" }, // explain absent → kept, never counted as dropped
    ];
    const def = await recallQueryWithStatus(hybridFloorStore(rows), root, "q");
    expect(def.hits.map(h => h.slug).sort()).toEqual(["norerank", "relevant"]);
    expect(def.belowFloor).toBe(2);
    expect(def.moreMatches).toBe(0);

    const open = await recallQueryWithStatus(hybridFloorStore(rows), root, "q", { minScore: 0 });
    expect(open.belowFloor).toBe(0);
    expect(open.hits.length).toBe(4);
  });

  test("a floor-dropped hit the type gate would also drop is NOT counted (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const rows = [
      { type: "project", slug: "kept", rerank: 0.80 },
      { type: "project", slug: "proj-low", rerank: 0.50 },  // in scope: counts
      { type: "user", slug: "user-low", rerank: 0.50 },     // off-type: must not count
    ];
    const res = await recallQueryWithStatus(hybridFloorStore(rows), root, "q", { type: "project" });
    expect(res.hits.map(h => h.slug)).toEqual(["kept"]);
    expect(res.belowFloor).toBe(1); // lowering the floor would surface exactly proj-low
  });

  test("lexOnly recall always reports belowFloor 0 — no reranker runs (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(lexStore(["a", "b"]), root, "q", { lexOnly: true, minScore: 0.9 });
    expect(res.belowFloor).toBe(0);
  });

  test("a clean exhaustive recall reports all-zero counters (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const res = await recallQueryWithStatus(lexStore(["only", "two"]), root, "q", { lexOnly: true, limit: 10 });
    expect(res.hits.length).toBe(2);
    expect(res.moreMatches).toBe(0);
    expect(res.belowFloor).toBe(0);
    expect(res.saturated).toBe(false);
  });

  test("a non-widened recall (platform all, no type) saturates without a refetch (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const slugs = Array.from({ length: 20 }, (_, i) => `w${i}`); // widen=false → pool = limit
    const res = await recallQueryWithStatus(lexStore(slugs), root, "q", { lexOnly: true, limit: 3, platform: "all" });
    expect(res.hits.length).toBe(3);
    expect(res.moreMatches).toBe(0);  // every pooled hit shown — the surplus is invisible to the pool
    expect(res.saturated).toBe(true); // corpus (20) extends past the pool (3): counters are lower bounds
  });

  test("the amm corpus-wide refetch clears saturated — the pool was the whole corpus (40h)", async () => {
    const { recallQueryWithStatus, serializeMemory } = await import("../src/engine.js");
    const diskRoot = await mkdtemp(join(tmpdir(), "qmemd-40h-"));
    try {
      await mkdir(join(diskRoot, "project"), { recursive: true });
      const put = async (slug: string, platforms: Platform[]) =>
        writeFile(join(diskRoot, "project", `${slug}.md`), serializeMemory(
          { name: slug, description: slug, type: "project", tags: [], project: "global", created: "2026-06-09", pinned: false, platforms },
          "body"));
      for (let i = 0; i < 9; i++) await put(`m${i}`, ["macos"]);
      await put("linux-deep", ["linux"]);
      const ranked = [...Array.from({ length: 9 }, (_, i) => `m${i}`), "linux-deep"];
      const store = {
        async getStatus() { return { totalDocuments: 10, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
        async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
        async search() { return []; },
        async searchLex(_q: string, o?: { limit?: number }) {
          return ranked.slice(0, o?.limit ?? 10).map(s => ({ filepath: `qmd://memory/project/${s}.md`, title: s, score: 0.5 }));
        },
      } as unknown as QMDStore;
      // limit 2, platform linux: the first pool (8) is all macos → gated underflow on a
      // saturated pool → corpus-wide refetch (10) → the gate finds linux-deep. The final pool
      // covered the corpus, so saturated must come back false (nothing can sit past it).
      const res = await recallQueryWithStatus(store, diskRoot, "q", { lexOnly: true, limit: 2, platform: "linux" });
      expect(res.hits.map(h => h.slug)).toEqual(["linux-deep"]);
      expect(res.saturated).toBe(false);
      expect(res.moreMatches).toBe(0);
    } finally { await rm(diskRoot, { recursive: true, force: true }); }
  });

  test("a full pool that covered the whole corpus is exhaustion, not saturation (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const slugs = Array.from({ length: 12 }, (_, i) => `t${i}`); // corpus 12 == pool 3*4
    const res = await recallQueryWithStatus(lexStore(slugs), root, "q", { lexOnly: true, limit: 3 });
    expect(res.hits.length).toBe(3);
    expect(res.moreMatches).toBe(9);   // exact — the pool was the corpus
    expect(res.saturated).toBe(false);
  });

  test("a failed getStatus keeps saturated conservatively true (40h)", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    const base = lexStore(Array.from({ length: 12 }, (_, i) => `t${i}`)) as { getStatus(): Promise<unknown> };
    base.getStatus = async () => { throw new Error("status unavailable"); };
    const res = await recallQueryWithStatus(base as unknown as QMDStore, root, "q", { lexOnly: true, limit: 3 });
    expect(res.hits.length).toBe(3);
    expect(res.saturated).toBe(true);
  });
});

describe("completenessFooter (40h)", () => {
  test("returns null when nothing is hidden (40h footer)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 0, saturated: false }, 0.575, "cli")).toBeNull();
  });

  test("exact surplus renders a plain count, cli style (40h footer)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 3, belowFloor: 0, saturated: false }, 0.575, "cli"))
      .toBe("3 more match (raise --limit)");
  });

  test("a saturated surplus renders N+ (40h footer)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 9, belowFloor: 0, saturated: true }, 0.575, "cli"))
      .toBe("9+ more match (raise --limit)");
  });

  test("a saturated full page with no counted surplus says more may match, api style (40h footer)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 0, saturated: true }, 0.575, "api"))
      .toBe("more may match (raise limit)");
  });

  test("floor drops render the effective floor and style-specific flag (40h footer)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 2, saturated: false }, 0.575, "cli"))
      .toBe("2 below the 0.575 relevance floor (--min-score 0 shows all)");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 2, saturated: false }, 0.7, "api"))
      .toBe("2 below the 0.7 relevance floor (minScore 0 shows all)");
  });

  test("both parts join with a semicolon (40h footer)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 4, belowFloor: 1, saturated: true }, 0.575, "cli"))
      .toBe("4+ more match (raise --limit); 1 below the 0.575 relevance floor (--min-score 0 shows all)");
  });

  test("completenessFooter surfaces hidden cross-project matches, pluralised (qmemd-due)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 0, saturated: false, crossProjectHidden: 3 }, 0.575, "cli"))
      .toBe("3 cross-project matches hidden (--cross-project to include)");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 0, saturated: false, crossProjectHidden: 1 }, 0.575, "api"))
      .toBe("1 cross-project match hidden (cross_project to include)");
  });

  test("completenessFooter omits the cross-project clause at 0 / when absent (qmemd-due)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 0, belowFloor: 0, saturated: false, crossProjectHidden: 0 }, 0.575, "cli")).toBeNull();
    expect(completenessFooter({ moreMatches: 0, belowFloor: 0, saturated: false }, 0.575, "cli")).toBeNull();
  });

  test("completenessFooter orders cross-project between more-matches and below-floor (qmemd-due)", async () => {
    const { completenessFooter } = await import("../src/engine.js");
    expect(completenessFooter({ moreMatches: 2, belowFloor: 4, saturated: false, crossProjectHidden: 1 }, 0.575, "cli"))
      .toBe("2 more match (raise --limit); 1 cross-project match hidden (--cross-project to include); 4 below the 0.575 relevance floor (--min-score 0 shows all)");
  });
});

describe("remember --supersedes (bri)", () => {
  let root: string;
  const store = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;
  let gitCalls: string[][];
  let git: { run: (args: string[]) => number };

  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-bri-sup-"));
    gitCalls = [];
    // diff=1 → staged, rev-parse (upstream)=1 → no upstream (skip push); everything else ok
    git = { run: (args: string[]) => { gitCalls.push(args); return args[0] === "diff" ? 1 : 0; } };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function seed(slug: string, body = "the old truth"): Promise<void> {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", `${slug}.md`),
      `---\nname: ${slug}\ndescription: d\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\n---\n\n${body}\n`);
  }

  it("stamps supersedes on the new fact and superseded_by on the old, in one commit", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    await seed("old-truth");
    const res = await remember(store, root, { fact: "the new truth about ports", type: "project", supersedes: "old-truth" }, git);
    expect(res.wrote).toBe(true);
    expect(res.supersededSlug).toBe("old-truth");
    const neu = getFact(root, res.slug)!;
    expect(neu.frontmatter.supersedes).toBe("old-truth");
    const old = getFact(root, "old-truth")!;
    expect(old.frontmatter.supersededBy).toBe(res.slug);
    expect(old.frontmatter.updated).toBeUndefined(); // retirement stamp must NOT bump content age
    expect(old.body.trim()).toBe("the old truth");   // body untouched
    // ONE commit carrying BOTH pathspecs
    const commits = gitCalls.filter(a => a[0] === "commit");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain(`project/${res.slug}.md`);
    expect(commits[0]).toContain("project/old-truth.md");
  });

  it("skips dedup (the successor would otherwise near-dup its predecessor)", async () => {
    const { remember } = await import("../src/engine.js");
    await seed("old-truth", "build with jdk 21 only");
    const res = await remember(store, root, { fact: "build with jdk 21 only", type: "project", as: "new-truth", supersedes: "old-truth" }, git);
    expect(res.wrote).toBe(true); // Tier-2.5 would have blocked this as a duplicate
  });

  it("rejects a missing target", async () => {
    const { remember } = await import("../src/engine.js");
    await expect(remember(store, root, { fact: "x y z", supersedes: "nope" }, git))
      .rejects.toThrow("no fact named 'nope' to supersede");
  });

  it("rejects self-supersession and the --replace combination", async () => {
    const { remember } = await import("../src/engine.js");
    await seed("self-slug");
    await expect(remember(store, root, { fact: "irrelevant", as: "self-slug", supersedes: "self-slug" }, git))
      .rejects.toThrow(/cannot supersede itself/);
    await expect(remember(store, root, { fact: "irrelevant", replace: "self-slug", supersedes: "self-slug" }, git))
      .rejects.toThrow(/cannot be combined with replace/);
  });

  it("surfaces a warning when the target has no frontmatter fence, instead of silently no-op'ing (qp-yf2 C7)", async () => {
    const { remember } = await import("../src/engine.js");
    // A fenceless hand-written/adopted fact whose body contains --- rules:
    // setFrontmatterKey cannot stamp it, so the stamp must be reported as NOT done.
    const fenceless = "Setup notes\n---\nstep 1\n---\nstep 2\n";
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "old-truth.md"), fenceless);
    const res = await remember(store, root, { fact: "the new truth about ports", type: "project", supersedes: "old-truth" }, git);
    expect(res.wrote).toBe(true); // the new fact itself is still written
    expect(res.supersedeWarning).toMatch(/no frontmatter fence/);
    // Old file byte-identical — never corrupted, never falsely stamped.
    expect(readFileSync(join(root, "project", "old-truth.md"), "utf-8")).toBe(fenceless);
    // The commit must carry ONLY the new fact — no unstamped old path riding along.
    const commits = gitCalls.filter(a => a[0] === "commit");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain(`project/${res.slug}.md`);
    expect(commits[0]).not.toContain("project/old-truth.md");
  });
});

describe("force records conflicts_with (cr4)", () => {
  let root: string;
  const store = { async searchLex() { return []; }, async update() { /* no-op */ } } as unknown as QMDStore;
  let gitCalls: string[][];
  let git: { run: (args: string[]) => number };

  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-cr4-"));
    gitCalls = [];
    // diff=1 → staged, rev-parse (upstream)=1 → no upstream (skip push); everything else ok
    git = { run: (args: string[]) => { gitCalls.push(args); return args[0] === "diff" ? 1 : 0; } };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("stamps conflicts_with when --force writes past a detected contradiction", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "kafka-port.md"),
      "---\nname: kafka-port\ndescription: kafka broker listens on port 9092\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\n---\n\nkafka broker listens on port 9092\n");
    // identifier flip (9092 → 9093) on a near-identical headline = a classifier conflict
    // --as "kafka-port-v2": slugs tokenize to {kafka,port,v2} vs {kafka,port} — identifier sets
    // {v2,9093} vs {9092} are non-subset (identifiersConflict) over an equal residual topic,
    // so lowSimilarityConflict fires (Dice 0.727 < DEDUP_DICE keeps the high-sim path out).
    const res = await remember(store, root, { fact: "kafka broker listens on port 9093", type: "project", as: "kafka-port-v2", force: true }, git);
    expect(res.wrote).toBe(true);
    expect(res.conflictsWith).toBe("kafka-port");
    expect(getFact(root, "kafka-port-v2")!.frontmatter.conflictsWith).toBe("kafka-port");
    // marker only: the old fact is untouched
    expect(getFact(root, "kafka-port")!.frontmatter.supersededBy).toBeUndefined();
  });

  it("does not stamp on a conflict-free force", async () => {
    const { remember, getFact } = await import("../src/engine.js");
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "redis-acl.md"),
      "---\nname: redis-acl\ndescription: redis acl locks the default user\ntype: project\ntags: []\nproject: global\ncreated: 2020-01-01\npinned: false\n---\n\nredis acl locks the default user\n");
    const res = await remember(store, root, { fact: "entirely unrelated topic about cheese", force: true }, git);
    expect(res.conflictsWith).toBeUndefined();
    expect(getFact(root, res.slug)!.frontmatter.conflictsWith).toBeUndefined();
  });
});

describe("recallQuery supersession + recency tie-break (bri)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-bri-rq-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // Write a fact file on disk with given frontmatter fields.
  async function put(slug: string, over: Partial<MemoryFrontmatter> = {}, body = "body text") {
    await mkdir(join(root, "project"), { recursive: true });
    const fm: MemoryFrontmatter = {
      name: slug, description: `desc ${slug}`, type: "project", tags: [],
      project: "global", created: "2026-06-01", pinned: false, ...over,
    };
    await writeFile(join(root, "project", `${slug}.md`), serializeMemory(fm, body));
  }

  // Fake hybrid result: .file URI + explain.rerankScore (rq-plat harness shape).
  const hyb = (slug: string, rerankScore: number) =>
    ({ file: `qmd://memory/project/${slug}.md`, title: slug, score: 0.9, explain: { rerankScore } });

  // Fake lex result: .filepath + .score (rq-plat harness shape).
  const lex = (slug: string, score: number) =>
    ({ filepath: `qmd://memory/project/${slug}.md`, title: slug, score });

  it("drops superseded facts from hits (and from the completeness counters)", async () => {
    const { recallQueryWithStatus, RECENCY_TIE_BUCKET: _rtb } = await import("../src/engine.js");
    await put("live");
    await put("retired", { supersededBy: "live" });
    const fakeStore = {
      async getStatus() { return { totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search() { return [hyb("live", 0.8), hyb("retired", 0.8)]; },
      async searchLex() { return []; },
    } as unknown as QMDStore;
    const res = await recallQueryWithStatus(fakeStore, root, "q", {});
    expect(res.hits.map(h => h.slug)).toEqual(["live"]);
    // moreMatches and belowFloor must not count the superseded hit
    expect(res.moreMatches).toBe(0);
    expect(res.belowFloor).toBe(0);
  });

  it("breaks near-equal rerank scores by updated recency, without mutating scores", async () => {
    const { recallQueryWithStatus, RECENCY_TIE_BUCKET } = await import("../src/engine.js");
    // fresh (0.71) and stale (0.72) land in the same bucket: Math.round(0.71/0.02)=36, Math.round(0.72/0.02)=36
    expect(Math.round(0.71 / RECENCY_TIE_BUCKET)).toBe(Math.round(0.72 / RECENCY_TIE_BUCKET));
    // distant has a lower rerank score (different bucket) → recency must NOT promote it above fresh/stale
    expect(Math.round(0.60 / RECENCY_TIE_BUCKET)).toBeLessThan(Math.round(0.71 / RECENCY_TIE_BUCKET));
    await put("fresh", { updated: "2026-06-10T20:00:00.000Z" });
    await put("stale", { updated: "2026-06-01T00:00:00.000Z" });
    await put("distant");  // updated absent → falls back to created: 2026-06-01 (same as stale, but bucket lower)
    const fakeStore = {
      async getStatus() { return { totalDocuments: 3, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search() { return [hyb("fresh", 0.71), hyb("stale", 0.72), hyb("distant", 0.60)]; },
      async searchLex() { return []; },
    } as unknown as QMDStore;
    const res = await recallQueryWithStatus(fakeStore, root, "q", { minScore: 0 });
    expect(res.hits.map(h => h.slug)).toEqual(["fresh", "stale", "distant"]);
    // Raw score exposed unchanged — not mutated by the bucket tie-break
    expect(res.hits[0]!.score).toBeCloseTo(0.71);
  });

  it("tie-breaks the lex path only on exact score equality", async () => {
    const { recallQueryWithStatus } = await import("../src/engine.js");
    // a and b share score 3.0; b is fresher → b first. c has score 3.1 → stays above both.
    await put("a", { created: "2026-05-01" });
    await put("b", { updated: "2026-06-09T12:00:00.000Z" });
    await put("c", { created: "2026-05-01" });
    const fakeStore = {
      async getStatus() { return { totalDocuments: 3, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
      async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      async search() { return []; },
      async searchLex() { return [lex("a", 3.0), lex("b", 3.0), lex("c", 3.1)]; },
    } as unknown as QMDStore;
    const res = await recallQueryWithStatus(fakeStore, root, "q", { lexOnly: true });
    expect(res.hits.map(h => h.slug)).toEqual(["c", "b", "a"]);
  });
});

// =============================================================================
// Staleness layer (qmemd-9su): review_by frontmatter, ttl sugar, staleFacts pass
// =============================================================================

describe("review_by frontmatter (9su)", () => {
  test("serializeMemory writes review_by when set and parseMemory round-trips it", () => {
    const fm: MemoryFrontmatter = {
      name: "s", description: "d", type: "project", tags: [], project: "global",
      created: "2026-06-10", pinned: false, reviewBy: "2026-09-08",
    };
    const out = serializeMemory(fm, "body");
    expect(out).toContain("review_by: 2026-09-08");
    expect(parseMemory(out).frontmatter.reviewBy).toBe("2026-09-08");
  });

  test("review_by is omitted when absent and parses to undefined", () => {
    const fm: MemoryFrontmatter = {
      name: "s", description: "d", type: "project", tags: [], project: "global",
      created: "2026-06-10", pinned: false,
    };
    const out = serializeMemory(fm, "body");
    expect(out).not.toContain("review_by");
    expect(parseMemory(out).frontmatter.reviewBy).toBeUndefined();
  });
});

describe("reviewByFromTtl (9su)", () => {
  const from = new Date("2026-06-10T12:00:00.000Z");
  test("converts day/week/month/year ttls to a YYYY-MM-DD date", () => {
    expect(reviewByFromTtl("90d", from)).toBe("2026-09-08");
    expect(reviewByFromTtl("2w", from)).toBe("2026-06-24");
    expect(reviewByFromTtl("6m", from)).toBe("2026-12-07");  // m = 30 days, deterministic
    expect(reviewByFromTtl("1y", from)).toBe("2027-06-10");  // y = 365 days
  });
  test("rejects malformed and zero ttls with a client-safe 'invalid ttl' message", () => {
    expect(() => reviewByFromTtl("soon", from)).toThrow(/^invalid ttl/);
    expect(() => reviewByFromTtl("90", from)).toThrow(/^invalid ttl/);
    expect(() => reviewByFromTtl("0d", from)).toThrow(/^invalid ttl/);
  });
});

describe("parseTtlDays (s4w)", () => {
  test("returns total days for d/w/m/y, null for malformed or zero", () => {
    expect(parseTtlDays("90d")).toBe(90);
    expect(parseTtlDays("2w")).toBe(14);
    expect(parseTtlDays("6m")).toBe(180); // m = 30 days
    expect(parseTtlDays("1y")).toBe(365);
    expect(parseTtlDays("0d")).toBeNull();
    expect(parseTtlDays("soon")).toBeNull();
    expect(parseTtlDays("90")).toBeNull();
  });
});

describe("ttlDefaultDays (s4w)", () => {
  afterEach(() => {
    delete process.env.QMEMD_TTL_PROJECT;
    delete process.env.QMEMD_TTL_REFERENCE;
  });
  test("hardcoded defaults: project 90, reference 180, feedback/user durable (null)", () => {
    expect(ttlDefaultDays("project")).toBe(90);
    expect(ttlDefaultDays("reference")).toBe(180);
    expect(ttlDefaultDays("feedback")).toBeNull();
    expect(ttlDefaultDays("user")).toBeNull();
  });
  test("env override parses a duration; 'never' means durable; garbage falls back to default", () => {
    process.env.QMEMD_TTL_PROJECT = "30d";
    expect(ttlDefaultDays("project")).toBe(30);
    process.env.QMEMD_TTL_REFERENCE = "never";
    expect(ttlDefaultDays("reference")).toBeNull();
    process.env.QMEMD_TTL_PROJECT = "garbage";
    expect(ttlDefaultDays("project")).toBe(90); // unparseable → hardcoded default, never throws
  });
});

describe("isValidReviewBy (9su)", () => {
  test("accepts a real YYYY-MM-DD date, rejects malformed and impossible dates", () => {
    expect(isValidReviewBy("2026-09-08")).toBe(true);
    expect(isValidReviewBy("soon")).toBe(false);
    expect(isValidReviewBy("2026-13-01")).toBe(false);
    expect(isValidReviewBy("2026-02-30")).toBe(false);
    expect(isValidReviewBy("")).toBe(false);
    expect(isValidReviewBy("never")).toBe(true); // durable sentinel (s4w)
  });
});

describe("remember review_by / ttl (9su, SDK-backed)", () => {
  let root: string, dbPath: string, store: QMDStore;
  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-rvb-"));
    dbPath = join(await mkt(join(tmpdir(), "qmemd-rvbdb-")), "i.sqlite");
    store = await openQmd({ dbPath, config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  test("remember with reviewBy stores review_by in frontmatter", async () => {
    const { remember } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "Redis port is 6379", type: "project", reviewBy: "2026-12-01" });
    expect(res.wrote).toBe(true);
    expect(getFact(root, res.slug)!.frontmatter.reviewBy).toBe("2026-12-01");
  });

  test("remember with ttl computes review_by = today + N", async () => {
    const { remember } = await import("../src/engine.js");
    const res = await remember(store, root, { fact: "LM Studio token rotates quarterly", type: "project", ttl: "90d" });
    expect(res.wrote).toBe(true);
    expect(getFact(root, res.slug)!.frontmatter.reviewBy).toBe(reviewByFromTtl("90d"));
  });

  test("remember rejects ttl combined with reviewBy", async () => {
    const { remember } = await import("../src/engine.js");
    await expect(remember(store, root, { fact: "x y z", reviewBy: "2026-12-01", ttl: "90d" }))
      .rejects.toThrow(/^invalid ttl/);
  });

  test("remember rejects a malformed reviewBy", async () => {
    const { remember } = await import("../src/engine.js");
    await expect(remember(store, root, { fact: "x y z", reviewBy: "soon" }))
      .rejects.toThrow(/^invalid review_by/);
  });

  test("replace inherits review_by when not passed; empty string clears it (q65 pattern)", async () => {
    const { remember } = await import("../src/engine.js");
    const first = await remember(store, root, { fact: "Qdrant REST is 6333", type: "project", reviewBy: "2026-12-01" });
    const updated = await remember(store, root, { fact: "Qdrant REST is 6333 (verified)", replace: first.slug });
    expect(getFact(root, updated.slug)!.frontmatter.reviewBy).toBe("2026-12-01");
    const cleared = await remember(store, root, { fact: "Qdrant REST is 6333 (timeless)", replace: first.slug, reviewBy: "" });
    expect(getFact(root, cleared.slug)!.frontmatter.reviewBy).toBeUndefined();
  });
});

describe("staleFacts (9su, filesystem-only)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-stale-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const put = async (type: MemoryType, slug: string, over: Partial<MemoryFrontmatter> = {}, body = "Body.") => {
    const fm: MemoryFrontmatter = {
      name: slug, description: `desc ${slug}`, type, tags: [], project: "global",
      created: "2026-01-01", pinned: false, ...over,
    };
    await mkdir(join(root, type), { recursive: true });
    await writeFile(join(root, type, `${slug}.md`), serializeMemory(fm, body));
  };

  test("facts past (or at) review_by are due, oldest first; future ones are neither due nor unreviewed", async () => {
    await put("project", "overdue-a", { reviewBy: "2026-05-01" });
    await put("project", "overdue-b", { reviewBy: "2026-03-01" });
    await put("project", "due-today", { reviewBy: "2026-06-10" });
    await put("project", "future", { reviewBy: "2026-12-01" });
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due.map(e => e.slug)).toEqual(["overdue-b", "overdue-a", "due-today"]);
    expect(rep.unreviewed.map(e => e.slug)).not.toContain("future");
  });

  test("decay-prone facts with no review_by past their type window are implicitly due (s4w)", async () => {
    await put("project", "old", { created: "2025-01-01" });                                       // +90d ⇒ 2025-04-01, due
    await put("project", "mid", { created: "2025-06-01", updated: "2026-01-01T00:00:00.000Z" });  // anchor 2026-01-01 ⇒ 2026-04-01, due
    await put("user", "durable-new", { created: "2026-06-01" });                                   // user ⇒ exempt
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due.map(e => e.slug)).toEqual(["old", "mid"]); // sorted by effective dueDate asc
    expect(rep.due[0]!.dueDate).toBe("2025-04-01");
    expect(rep.unreviewed).toEqual([]);
    expect(rep.unreviewedTotal).toBe(0);
  });

  test("a recent decay-prone fact is backlog (never reviewed, not yet due) (s4w)", async () => {
    await put("project", "recent", { created: "2026-06-01" }); // +90d ⇒ 2026-08-30, future
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due).toEqual([]);
    expect(rep.unreviewed.map(e => e.slug)).toEqual(["recent"]);
    expect(rep.unreviewedTotal).toBe(1);
  });

  test("durable types (user/feedback) with no review_by are exempt from both lanes (s4w)", async () => {
    await put("user", "pref", { created: "2020-01-01" });
    await put("feedback", "guidance", { created: "2020-01-01" });
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due).toEqual([]);
    expect(rep.unreviewed).toEqual([]);
    expect(rep.unreviewedTotal).toBe(0);
  });

  test("review_by: never is exempt even for an ancient decay-prone fact (s4w)", async () => {
    await put("project", "evergreen", { created: "2020-01-01", reviewBy: "never" });
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due).toEqual([]);
    expect(rep.unreviewed).toEqual([]);
  });

  test("updated (not created) is the staleness anchor — a recent touch resets the clock (s4w)", async () => {
    await put("project", "touched", { created: "2024-01-01", updated: "2026-06-09T00:00:00.000Z" });
    const rep = staleFacts(root, { today: "2026-06-10" }); // anchor 2026-06-09 ⇒ due 2026-09-07, future
    expect(rep.due).toEqual([]);
    expect(rep.unreviewed.map(e => e.slug)).toEqual(["touched"]);
  });

  test("an explicit future review_by overrides an old anchor — stays quiet (s4w)", async () => {
    await put("project", "scheduled", { created: "2020-01-01", reviewBy: "2027-01-01" });
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due).toEqual([]);
    expect(rep.unreviewed).toEqual([]);
  });

  test("superseded facts are excluded from both lanes (retired, not stale)", async () => {
    await put("project", "retired-due", { reviewBy: "2026-01-01", supersededBy: "winner" });
    await put("project", "retired-old", { created: "2024-01-01", supersededBy: "winner" });
    await put("project", "winner", { created: "2026-06-01" });
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due).toEqual([]);
    expect(rep.unreviewed.map(e => e.slug)).toEqual(["winner"]);
  });

  test("a malformed review_by fails open to the type default — surfaced, never silently exempt (s4w)", async () => {
    await put("project", "typo", { reviewBy: "soon" }); // default created 2026-01-01 ⇒ +90d 2026-04-01, due
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due.map(e => e.slug)).toEqual(["typo"]); // surfaced (doctor separately flags REVIEW_BY_MALFORMED)
    expect(rep.unreviewed).toEqual([]);
  });

  test("entries carry slug/type/description/project and the review metadata", async () => {
    await put("reference", "doc-link", { reviewBy: "2026-05-01", project: "qmemd" });
    const rep = staleFacts(root, { today: "2026-06-10" });
    expect(rep.due[0]).toMatchObject({
      slug: "doc-link", type: "reference", description: "desc doc-link",
      project: "qmemd", reviewBy: "2026-05-01", created: "2026-01-01",
    });
    expect(rep.due[0]!.dueDate).toBe("2026-05-01"); // explicit review_by is the effective dueDate
  });

  test("an undatable decay-prone fact (missing created) is surfaced as due, never crashes (s4w)", async () => {
    // Write a project fact directly with no valid created/updated so the anchor is unparseable.
    await mkdir(join(root, "project"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "project", "broken.md"), [
      "---",
      "name: broken",
      "description: no created",
      "type: project",
      "tags: []",
      "project: global",
      "pinned: false",
      "---",
      "",
      "Body.",
    ].join("\n"));
    // Must not throw — the crash the fix addresses.
    let rep: ReturnType<typeof staleFacts>;
    expect(() => { rep = staleFacts(root, { today: "2026-06-10" }); }).not.toThrow();
    // The undatable fact must be surfaced as due, not silently exempted.
    expect(rep!.due.map(e => e.slug)).toContain("broken");
    // …and its effective dueDate is a real date (today), never an empty/non-date string.
    expect(rep!.due.find(e => e.slug === "broken")!.dueDate).toBe("2026-06-10");
  });
});

describe("resolveReviewedDate (s4w, pure)", () => {
  const from = new Date("2026-06-10T12:00:00.000Z");
  test("no flags ⇒ today + type window; durable type ⇒ never", () => {
    expect(resolveReviewedDate("project", {}, from)).toBe("2026-09-08");   // +90d
    expect(resolveReviewedDate("reference", {}, from)).toBe("2026-12-07"); // +180d
    expect(resolveReviewedDate("user", {}, from)).toBe("never");
    expect(resolveReviewedDate("feedback", {}, from)).toBe("never");
  });
  test("--ttl and --review-by forms", () => {
    expect(resolveReviewedDate("project", { ttl: "30d" }, from)).toBe("2026-07-10");
    expect(resolveReviewedDate("project", { ttl: "never" }, from)).toBe("never");
    expect(resolveReviewedDate("project", { reviewBy: "2027-01-01" }, from)).toBe("2027-01-01");
    expect(resolveReviewedDate("project", { reviewBy: "never" }, from)).toBe("never");
  });
  test("rejects ttl+reviewBy together and a malformed value", () => {
    expect(() => resolveReviewedDate("project", { ttl: "30d", reviewBy: "2027-01-01" }, from)).toThrow(/^invalid ttl/);
    expect(() => resolveReviewedDate("project", { reviewBy: "soon" }, from)).toThrow(/^invalid review_by/);
  });
});

describe("markReviewed (s4w, SDK-backed)", () => {
  let root: string, dbPath: string, store: QMDStore;
  beforeEach(async () => {
    root = await mkt(join(tmpdir(), "qmemd-rev-"));
    dbPath = join(await mkt(join(tmpdir(), "qmemd-revdb-")), "i.sqlite");
    store = await openQmd({ dbPath, config: { collections: { memory: { path: root, pattern: "**/*.md" } } } });
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  test("forward-sets review_by and leaves updated byte-identical", async () => {
    const { remember, markReviewed } = await import("../src/engine.js");
    const r = await remember(store, root, { fact: "Vault token rotates monthly", type: "project" });
    const before = readFileSync(getFact(root, r.slug)!.path, "utf-8");
    const updatedBefore = getFact(root, r.slug)!.frontmatter.updated;
    const res = await markReviewed(store, root, r.slug, { ttl: "30d" });
    expect(isValidReviewBy(res.reviewBy)).toBe(true);
    const after = getFact(root, r.slug)!;
    expect(after.frontmatter.reviewBy).toBe(res.reviewBy);
    expect(after.frontmatter.updated).toBe(updatedBefore); // updated NOT bumped
    expect(before).not.toBe(readFileSync(after.path, "utf-8")); // review_by line did change
  });

  test("bare reviewed on a durable type sets review_by: never", async () => {
    const { remember, markReviewed } = await import("../src/engine.js");
    const r = await remember(store, root, { fact: "Always prefer Bun over npm here", type: "feedback" });
    const res = await markReviewed(store, root, r.slug, {});
    expect(res.reviewBy).toBe("never");
    expect(getFact(root, r.slug)!.frontmatter.reviewBy).toBe("never");
  });

  test("throws on a missing fact", async () => {
    const { markReviewed } = await import("../src/engine.js");
    await expect(markReviewed(store, root, "no-such-slug", {})).rejects.toThrow(/no fact named 'no-such-slug'/);
  });

  test("throws on a fenceless fact instead of reporting a success that never lands (qp-yf2 C6)", async () => {
    const { markReviewed } = await import("../src/engine.js");
    // setFrontmatterKey would return the content unchanged, git would no-op, and the
    // fact would resurface in `qmemd stale` forever — fail loudly with the repair path.
    const fenceless = "Setup notes\n---\nstep 1\n---\nstep 2\n";
    await mkdir(join(root, "project"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "project", "fenceless.md"), fenceless);
    await expect(markReviewed(store, root, "fenceless", {})).rejects.toThrow(/no frontmatter fence/);
    // File byte-identical — the failed verb must not touch it.
    expect(readFileSync(join(root, "project", "fenceless.md"), "utf-8")).toBe(fenceless);
  });

  test("re-reviewing with the same date is an idempotent success, not a false failure", async () => {
    // Pins the guard design: the failure predicate is locateFences()=null, NOT
    // written-bytes equality — a same-value restamp writes identical bytes and is fine.
    const { remember, markReviewed } = await import("../src/engine.js");
    const r = await remember(store, root, { fact: "Vault token rotates monthly", type: "project" });
    const first = await markReviewed(store, root, r.slug, { reviewBy: "2027-01-01" });
    expect(first.reviewBy).toBe("2027-01-01");
    const second = await markReviewed(store, root, r.slug, { reviewBy: "2027-01-01" });
    expect(second.reviewBy).toBe("2027-01-01");
    expect(getFact(root, r.slug)!.frontmatter.reviewBy).toBe("2027-01-01");
  });
});

describe("walkFactFiles (shared corpus walk, qp-nq2)", () => {
  let root: string;
  beforeEach(async () => { root = await mkt(join(tmpdir(), "qmemd-walk-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const seed = async (type: string, slug: string, content = "---\nname: x\n---\nbody") => {
    await mkdir(join(root, type), { recursive: true });
    await writeFile(join(root, type, `${slug}.md`), content);
  };

  test("yields every .md across type folders with slug/relpath/raw; skips non-md and .md.bak", async () => {
    const { walkFactFiles } = await import("../src/engine.js");
    await seed("project", "alpha");
    await seed("user", "beta", "raw bytes");
    await writeFile(join(root, "project", "alpha.md.bak"), "backup");
    await writeFile(join(root, "project", "notes.txt"), "not a fact");
    const seen = [...walkFactFiles(root)].map(f => ({ type: f.type, slug: f.slug, relpath: f.relpath, raw: f.raw }));
    expect(seen).toContainEqual({ type: "project", slug: "alpha", relpath: "project/alpha.md", raw: "---\nname: x\n---\nbody" });
    expect(seen).toContainEqual({ type: "user", slug: "beta", relpath: "user/beta.md", raw: "raw bytes" });
    expect(seen).toHaveLength(2);
  });

  test("types option restricts the walk to the given folders", async () => {
    const { walkFactFiles } = await import("../src/engine.js");
    await seed("project", "alpha");
    await seed("reference", "gamma");
    const seen = [...walkFactFiles(root, { types: ["reference"] })].map(f => f.slug);
    expect(seen).toEqual(["gamma"]);
  });

  test("an unreadable entry invokes onUnreadable with the relpath and is skipped", async () => {
    const { walkFactFiles } = await import("../src/engine.js");
    await seed("project", "good");
    // A DIRECTORY named like a fact file: readFileSync throws EISDIR — deterministic
    // unreadable entry without permission-bit games.
    await mkdir(join(root, "project", "broken.md"), { recursive: true });
    const bad: string[] = [];
    const seen = [...walkFactFiles(root, { onUnreadable: rp => bad.push(rp) })].map(f => f.slug);
    expect(seen).toEqual(["good"]);
    expect(bad).toEqual(["project/broken.md"]);
  });
});

describe("setFrontmatterKey / locateFences (fence-location, qp-yf2)", () => {
  const wellFenced = "---\ntype: project\nname: foo\ncreated: 2026-01-01\n---\nbody line\n";

  test("locateFences anchors the open fence at byte 0 like parseMemory", () => {
    // A fenceless note whose BODY contains --- horizontal rules must NOT be
    // seen as frontmatter (parseMemory requires the fence at content start).
    const fenceless = "Setup notes\n---\nstep 1\n---\nstep 2\n";
    expect(locateFences(fenceless)).toBeNull();
    // A real frontmatter block is located at line 0.
    expect(locateFences(wellFenced)).toEqual({ open: 0, close: 4 });
  });

  test("does not corrupt a fenceless body that contains --- rules", () => {
    // C5: setFrontmatterKey must return the content byte-for-byte unchanged
    // when there is no byte-0 frontmatter fence, instead of splicing the key
    // between two markdown horizontal rules in the prose.
    const fenceless = "Setup notes\n---\nstep 1\n---\nstep 2\n";
    expect(setFrontmatterKey(fenceless, "review_by", "2026-10-02")).toBe(fenceless);
  });

  test("still replaces an existing key in a well-fenced fact", () => {
    const out = setFrontmatterKey(wellFenced, "type", "user");
    expect(out).toBe("---\ntype: user\nname: foo\ncreated: 2026-01-01\n---\nbody line\n");
  });

  test("still inserts an absent key just after the open fence", () => {
    const out = setFrontmatterKey(wellFenced, "review_by", "2026-10-02");
    expect(out).toBe("---\nreview_by: 2026-10-02\ntype: project\nname: foo\ncreated: 2026-01-01\n---\nbody line\n");
  });

  test("returns content unchanged when the open fence has no close", () => {
    const noClose = "---\ntype: project\nname: foo\nbody with no closing fence\n";
    expect(setFrontmatterKey(noClose, "review_by", "2026-10-02")).toBe(noClose);
  });
});
