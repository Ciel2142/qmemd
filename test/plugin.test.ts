import { describe, test, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// Plugin hook scripts are plain runtime .mjs (outside src/, so tsc/typecheck ignore
// them — see tsconfig.typecheck.json). We import their pure helpers directly and
// exercise the executable behaviour via spawn.
import { buildSessionContext, ruleFilePath } from "../hooks/inject-rule.mjs";
import { npxFallback, NPX_PACKAGE } from "../hooks/run-qmemd.mjs";

// qmemd plugin packaging: README + package.json advertise install via
// `/plugin marketplace add Ciel2142/qmemd` → `/plugin install qmemd@qmemd`, but the
// plugin artifacts were missing. These pins guard the manifest shape (the formats
// are easy to get subtly wrong) and the cross-platform hook contract.

const REPO = resolve(__dirname, "..");
const readJSON = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf-8"));
const pkg = readJSON("package.json");

describe("Claude Code plugin manifests", () => {
  test("marketplace.json: name qmemd, single plugin sourced at repo root", () => {
    const m = readJSON(".claude-plugin/marketplace.json");
    expect(m.name).toBe("qmemd");
    expect(m.owner?.name).toBeTruthy();
    expect(Array.isArray(m.plugins)).toBe(true);
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0].name).toBe("qmemd");
    expect(m.plugins[0].source).toBe("./");
  });

  test("the README install command `qmemd@qmemd` resolves (plugin@marketplace)", () => {
    const m = readJSON(".claude-plugin/marketplace.json");
    expect(`${m.plugins[0].name}@${m.name}`).toBe("qmemd@qmemd");
  });

  test("plugin.json: name qmemd, version tracks package.json", () => {
    const p = readJSON(".claude-plugin/plugin.json");
    expect(p.name).toBe("qmemd");
    expect(p.version).toBe(pkg.version);
  });

  test("marketplace plugin entry version tracks package.json", () => {
    const m = readJSON(".claude-plugin/marketplace.json");
    expect(m.plugins[0].version).toBe(pkg.version);
  });

  // The Codex/Cursor integration manifests carry the same version and drifted to 0.6.0
  // while package.json was 0.7.0 (qp-plugin-manifest-version-drift-iz4). Pin them too so
  // a future release bump cannot silently miss any of the four manifests.
  test("codex + cursor plugin manifests track package.json version", () => {
    expect(readJSON("integrations/codex/.codex-plugin/plugin.json").version).toBe(pkg.version);
    expect(readJSON("integrations/cursor/.cursor-plugin/plugin.json").version).toBe(pkg.version);
  });

  test("plugin.json declares the inline qmemd MCP server, no corpus/index override", () => {
    // Claude Code plugins declare MCP either inline in plugin.json (used here) or via
    // a WRAPPED `.mcp.json` ({ "mcpServers": {...} }) — a bare server map is only valid
    // in ~/.claude.json, not in a plugin, so it would silently fail to register.
    const mcp = readJSON(".claude-plugin/plugin.json").mcpServers?.qmemd;
    expect(mcp).toBeDefined();
    expect(mcp.command).toBe("qmemd");
    expect(mcp.args).toEqual(["mcp"]);
    // Must never repoint the user's durable git-backed corpus or its index.
    const env = mcp.env ?? {};
    expect(env.QMD_MEMORY_DIR).toBeUndefined();
    expect(env.QMEMD_DB).toBeUndefined();
  });
});

describe("plugin hooks.json", () => {
  let hooks: any;
  beforeAll(() => { hooks = readJSON("hooks/hooks.json").hooks; });
  const cmds = (group: any[]): string[] =>
    (group ?? []).flatMap((g) => (g.hooks ?? []).map((h: any) => h.command));

  test("SessionStart injects the always-on rule and the session snapshot", () => {
    const c = cmds(hooks.SessionStart);
    expect(c.some((x) => x.includes("inject-rule.mjs"))).toBe(true);
    expect(c.some((x) => x.includes("run-qmemd.mjs") && x.includes("recall --session"))).toBe(true);
  });

  test("PreToolUse(Bash) fires the memory-presence beacon", () => {
    const block = (hooks.PreToolUse ?? []).find((g: any) =>
      (g.hooks ?? []).some((h: any) => h.command.includes("hook beacon")));
    expect(block).toBeDefined();
    expect(block.matcher).toBe("Bash");
  });

  test("hook commands are cross-platform: ${CLAUDE_PLUGIN_ROOT}, no POSIX-only operators", () => {
    const all = [...cmds(hooks.SessionStart), ...cmds(hooks.PreToolUse)];
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(c, c).toContain("${CLAUDE_PLUGIN_ROOT}");
      // `||`, `&&`, `2>` would break when cmd.exe runs the hook string on Windows.
      expect(c, c).not.toMatch(/\|\||&&|2>/);
    }
  });
});

describe("/qmemd:* commands", () => {
  const VERBS = ["recall", "remember", "forget", "list", "stale", "status"];
  for (const v of VERBS) {
    test(`commands/${v}.md: frontmatter description + shells out to qmemd ${v}`, () => {
      // Normalize EOL so the structural checks hold however git checked the file
      // out (autocrlf yields CRLF on Windows).
      const raw = readFileSync(join(REPO, "commands", `${v}.md`), "utf-8").replace(/\r\n/g, "\n");
      expect(raw.startsWith("---\n")).toBe(true);
      const fm = raw.slice(4, raw.indexOf("\n---", 4));
      expect(fm).toMatch(/^description: .+/m);
      expect(raw).toMatch(new RegExp(`qmemd ${v}`));
    });
  }
});

describe("inject-rule.mjs (SessionStart rule injection)", () => {
  const SCRIPT = join(REPO, "hooks", "inject-rule.mjs");

  test("buildSessionContext wraps content as SessionStart additionalContext", () => {
    const out = JSON.parse(buildSessionContext("# Memory (qmemd)\nbody"));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("# Memory (qmemd)");
  });

  test("buildSessionContext sets suppressOutput so the rule does not banner the prompt", () => {
    // Raw SessionStart stdout (or an envelope without suppressOutput) surfaces as a
    // visible "hook success:" banner that crowds the user's first prompt. suppressOutput
    // injects additionalContext silently.
    const out = JSON.parse(buildSessionContext("# Memory (qmemd)\nbody"));
    expect(out.suppressOutput).toBe(true);
  });

  test("ruleFilePath resolves claude/qmemd.md under the plugin root", () => {
    expect(ruleFilePath("/x")).toBe(join("/x", "claude", "qmemd.md"));
  });

  test("emits the repo rule from CLAUDE_PLUGIN_ROOT as valid additionalContext JSON", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO }, encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("# Memory (qmemd)");
    expect(out.suppressOutput).toBe(true);
  });

  test("fail-open: missing rule file → exit 0 with no output", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      // test/ has no claude/qmemd.md, so the read throws and the hook stays silent.
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(REPO, "test") }, encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

describe("run-qmemd.mjs (PATH→npx fallback proxy)", () => {
  test("npxFallback builds the README-documented npx invocation", () => {
    expect(npxFallback(["recall", "--session"]))
      .toEqual(["npx", "-y", NPX_PACKAGE, "recall", "--session"]);
  });

  test("fallback targets the published package", () => {
    expect(NPX_PACKAGE).toBe("@ciel2142/qmemd");
  });

  test("is syntactically valid (node --check)", () => {
    const r = spawnSync(process.execPath, ["--check", join(REPO, "hooks", "run-qmemd.mjs")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});
