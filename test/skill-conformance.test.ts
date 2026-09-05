import { describe, test, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

  // Plugin packaging cannot reliably carry symlinks, so keep the shipped copy in sync.
  test("Codex plugin skill is byte-identical to root (no drift)", async () => {
    const copy = join(__dirname, "..", "integrations", "codex", "skills", "qmemd-memory", "SKILL.md");
    const body = await readFile(copy, "utf-8");
    expect(body, `${copy} drifted — re-copy skills/qmemd-memory/SKILL.md over it`).toEqual(raw);
  });
});
