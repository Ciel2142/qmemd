import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "..");
const readText = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const readJSON = (rel: string) => JSON.parse(readText(rel));

describe("Claude plugin manifest (.claude-plugin/plugin.json)", () => {
  const manifest = () => readJSON(".claude-plugin/plugin.json");

  test("parses and declares name 'qmemd'", () => {
    expect(manifest().name).toBe("qmemd");
  });

  test("version matches package.json (C3 version parity)", () => {
    expect(manifest().version).toBe(readJSON("package.json").version);
  });

  test("declares the inline qmemd MCP server on the CLI", () => {
    const mcp = manifest().mcpServers?.qmemd;
    expect(mcp?.command).toBe("qmemd");
    expect(mcp?.args).toEqual(["mcp"]);
  });
});

describe("Claude marketplace (.claude-plugin/marketplace.json)", () => {
  const market = () => readJSON(".claude-plugin/marketplace.json");

  test("parses with owner Ciel2142", () => {
    expect(market().owner?.name).toBe("Ciel2142");
  });

  test("lists the qmemd plugin sourced at the repo root", () => {
    const entry = (market().plugins ?? []).find((p: { name: string }) => p.name === "qmemd");
    expect(entry).toBeDefined();
    expect(entry.source).toBe("./");
  });
});

describe("slash commands (commands/*.md)", () => {
  for (const verb of ["stale", "doctor"]) {
    test(`/${verb} has a description and runs the qmemd ${verb} verb`, () => {
      const md = readText(`commands/${verb}.md`);
      expect(md).toMatch(/^---\n[\s\S]*?\bdescription:\s*\S/m);
      expect(md).toContain(`${verb} $ARGUMENTS`);
    });
  }
});

describe("npm package payload (package.json files[])", () => {
  const files = (): string[] => readJSON("package.json").files;
  // The plugin install reads these at runtime via ${CLAUDE_PLUGIN_ROOT}; with no .npmignore,
  // files[] is the sole allowlist, so each MUST be listed or it is absent from the npm tarball (S3).
  for (const asset of ["skills", ".claude-plugin", "hooks", "commands", "claude/qmemd.md", "integrations"]) {
    test(`files[] ships plugin asset '${asset}'`, () => {
      expect(files()).toContain(asset);
    });
  }
});

describe("tool integrations (integrations/**)", () => {
  test("cursor mcp.json.example is valid JSON declaring the qmemd server", () => {
    const j = JSON.parse(readText("integrations/cursor/mcp.json.example"));
    expect(j.mcpServers?.qmemd?.command).toBe("qmemd");
    expect(j.mcpServers?.qmemd?.args).toEqual(["mcp"]);
  });

  test("codex config.toml.example declares [mcp_servers.qmemd]", () => {
    const toml = readText("integrations/codex/config.toml.example");
    expect(toml).toMatch(/\[mcp_servers\.qmemd\]/);
    expect(toml).toMatch(/command\s*=\s*"qmemd"/);
  });

  test("cursor .mdc is always-applied", () => {
    expect(readText("integrations/cursor/qmemd.mdc")).toMatch(/alwaysApply:\s*true/);
  });

  // Rule-copy parity: a sentinel from claude/qmemd.md must survive into both materialized copies.
  const RULE_SENTINEL = "Recall is project-scoped by default";
  test("the sentinel exists in the source rule (parity anchor)", () => {
    expect(readText("claude/qmemd.md")).toContain(RULE_SENTINEL);
  });
  for (const copy of ["integrations/cursor/qmemd.mdc", "integrations/codex/AGENTS.snippet.md", "integrations/windsurf/qmemd.md"]) {
    test(`${copy} carries the current rule body (sentinel parity)`, () => {
      expect(readText(copy)).toContain(RULE_SENTINEL);
    });
    test(`${copy} carries the regenerate-by-hand header`, () => {
      expect(readText(copy)).toContain("regenerate by hand from claude/qmemd.md");
    });
  }
});
