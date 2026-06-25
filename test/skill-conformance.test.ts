import { describe, test, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// qmemd-4lr: conformance guard for skills/qmemd-memory/SKILL.md (gbrain
// test/skills-conformance.test.ts pattern). The skill is the agent-facing manual;
// a refactor that drops a required section (or the frontmatter the skill loader
// keys on) silently degrades every future session. Cheap structural pins only —
// no wording asserts beyond the core verbs.

const SKILL_PATH = join(__dirname, "..", "skills", "qmemd-memory", "SKILL.md");

describe("qmemd-memory SKILL.md conformance (4lr)", () => {
  let raw: string;
  beforeAll(async () => { raw = await readFile(SKILL_PATH, "utf-8"); });

  test("has YAML frontmatter with the loader-keyed name and a description", () => {
    expect(raw.startsWith("---\n")).toBe(true);
    const fm = raw.slice(4, raw.indexOf("\n---", 4));
    expect(fm).toMatch(/^name: qmemd-memory$/m);
    expect(fm).toMatch(/^description: .+/m);
  });

  test("keeps the required sections", () => {
    for (const section of [
      "## When to remember",
      "## When to recall",
      "## Routing rule vs br",
      "## Commands",
      "## Usage conventions",
    ]) {
      expect(raw, `missing section '${section}'`).toContain(`\n${section}\n`);
    }
  });

  test("documents all three core verbs", () => {
    for (const verb of ["remember", "recall", "forget"]) {
      expect(raw).toMatch(new RegExp(`qmemd ${verb}|\\b${verb}\\b`));
    }
  });

  test("warns that the session snapshot is partial", () => {
    expect(raw.toLowerCase()).toContain("partial");
  });

  // 751594b: the cursor/codex plugins ship a real *copy* of the root skill (plugin
  // packaging can't carry symlinks), so nothing makes them track root except this guard.
  test("plugin skill copies are byte-identical to root (no drift)", async () => {
    for (const copy of [
      join(__dirname, "..", "integrations", "cursor", "skills", "qmemd-memory", "SKILL.md"),
      join(__dirname, "..", "integrations", "codex", "skills", "qmemd-memory", "SKILL.md"),
    ]) {
      const body = await readFile(copy, "utf-8");
      expect(body, `${copy} drifted — re-copy skills/qmemd-memory/SKILL.md over it`).toEqual(raw);
    }
  });
});
