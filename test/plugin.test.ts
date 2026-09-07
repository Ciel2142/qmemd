import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanEnv } from "./support/env.js";
import { z } from "zod";
// Exercise plugin scripts and installer migrations through their executable surface.

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

  // The Codex integration manifest drifted behind package.json during a release
  // (qp-plugin-manifest-version-drift-iz4); keep its published version in sync.
  test("codex plugin manifest tracks package.json version", () => {
    expect(readJSON("integrations/codex/.codex-plugin/plugin.json").version).toBe(pkg.version);
  });

  test("plugin.json declares NO MCP server — the user registers exactly one", () => {
    // The plugin used to declare `qmemd mcp` inline. That stood up a SECOND server next to
    // whichever one the user already ran (a `qmemd` entry in ~/.claude.json, or the shared
    // HTTP daemon from `qmemd mcp install-service`): all six tools duplicated in the model's
    // context under two prefixes, and the two processes free to drift to different versions
    // — the plugin's stdio child kept serving the old build until Claude Code restarted,
    // while an `npm i -g` upgrade moved the daemon immediately.
    // The plugin now ships hooks + commands + the skill only. Corroboration that this is the
    // intended wiring: skills/qmemd-memory/SKILL.md's allowed-tools already name the
    // mcp__qmemd__* tools of a user-registered server, never mcp__plugin_qmemd_qmemd__*.
    const p = readJSON(".claude-plugin/plugin.json");
    expect(p.mcpServers).toBeUndefined();
    // The plugin's own value must still be there — removing MCP must not empty the manifest.
    expect(p.name).toBe("qmemd");
    expect(existsSync(join(REPO, "hooks/hooks.json"))).toBe(true);
    expect(existsSync(join(REPO, "skills/qmemd-memory/SKILL.md"))).toBe(true);
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

  // A PreToolUse hook exiting non-zero blocks the tool call, so a crashing qmemd (or a
  // failed npx fallback) must not reach Claude Code as the proxy's own status.
  // covers: INV-4
  test.skipIf(process.platform === "win32")("a child exiting non-zero still exits 0, output passed through", () => {
    const dir = mkdtempSync(join(tmpdir(), "qmemd-proxy-"));
    try {
      const fake = join(dir, "qmemd");
      writeFileSync(fake, "#!/bin/sh\necho proxied-output\nexit 3\n");
      chmodSync(fake, 0o755);
      const r = spawnSync(process.execPath, [join(REPO, "hooks", "run-qmemd.mjs"), "hook", "beacon"], {
        encoding: "utf8", env: { ...process.env, PATH: dir },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("proxied-output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform === "win32")("configured plugin snapshot prevents the first beacon from repeating delivered memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmemd-plugin-session-"));
  const bin = join(dir, "bin");
  const tsx = join(REPO, "node_modules", ".bin", "tsx");
  const cli = join(REPO, "src", "cli", "qmemd.ts");
  try {
    mkdirSync(bin);
    const shim = join(bin, "qmemd");
    writeFileSync(shim, `#!/bin/sh\nexec "${tsx}" "${cli}" "$@"\n`);
    chmodSync(shim, 0o755);
    const env = cleanEnv({
      CLAUDE_PLUGIN_ROOT: REPO,
      PATH: `${bin}:${process.env.PATH}`,
      QMD_MEMORY_DIR: join(dir, "memory"),
      QMEMD_DB: join(dir, "memory", ".idx", "i.sqlite"),
      XDG_CACHE_HOME: join(dir, "cache"),
      QMEMD_SESSION_BUDGET: "2000",
    });
    const saved = spawnSync(tsx, [cli, "remember", "Use gradle daemon diagnostics",
      "--type", "reference", "--project", "global", "--pin", "--as", "gradle-daemon",
      "--tags", "gradle,daemon,clean"], { cwd: dir, env, encoding: "utf8" });
    expect(saved.status, saved.stderr).toBe(0);
    const groups = z.array(z.object({
      matcher: z.string(), hooks: z.array(z.object({ command: z.string() })),
    }));
    const hooks = z.object({ SessionStart: groups, PreToolUse: groups }).parse(readJSON("hooks/hooks.json").hooks);
    const sessionContext = z.object({
      suppressOutput: z.literal(true),
      hookSpecificOutput: z.object({
        hookEventName: z.literal("SessionStart"), additionalContext: z.string(),
      }),
    });
    const invoke = (command: string, session: string) => {
      const result = spawnSync("sh", ["-c", command], {
        cwd: dir, env, encoding: "utf8",
        input: JSON.stringify({
          session_id: session, cwd: dir, tool_name: "Bash",
          tool_input: { command: "gradle daemon clean" },
        }),
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const contexts = hooks.SessionStart.flatMap((group) =>
      group.hooks.map((hook) => sessionContext.parse(JSON.parse(invoke(hook.command, "plugin-session")))));
    const snapshot = contexts.find((out) =>
      out.hookSpecificOutput.additionalContext.includes("gradle-daemon"));
    expect(snapshot?.suppressOutput).toBe(true);
    expect(snapshot?.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const beacon = hooks.PreToolUse.find((group) => group.matcher === "Bash")!.hooks[0].command;
    expect(invoke(beacon, "plugin-session")).not.toContain("gradle-daemon");
    expect(invoke(beacon, "fresh-session")).toContain("gradle-daemon");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

describe.skipIf(process.platform === "win32")("Claude integration installer snapshot migration", () => {
  const legacyCommands = [
    "qmemd recall --session",
    'qmemd recall --session --project "$(basename "$PWD")"',
  ];
  const canonical = "qmemd hook session";
  const unrelated = { type: "command", command: "qmemd recall --session --project custom", timeout: 7 };
  const unrelatedGroup = { matcher: "resume", hooks: [unrelated] };
  const postToolUse = [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }];
  const cases = [
    { name: "historical PowerShell command", commands: [legacyCommands[0]] },
    { name: "historical bash command", commands: [legacyCommands[1]] },
    { name: "mixed old/new duplicates", commands: [...legacyCommands, canonical, canonical] },
  ];

  test.each(cases)("$name migrates once and uninstalls without touching unrelated settings", ({ commands }) => {
    const dir = mkdtempSync(join(tmpdir(), "qmemd-installer-"));
    const settingsPath = join(dir, "settings.json");
    const memoryPath = join(dir, "CLAUDE.md");
    const seed = {
      theme: "dark",
      autoMemoryEnabled: true,
      hooks: {
        SessionStart: [{
          ...unrelatedGroup,
          hooks: [...unrelatedGroup.hooks, ...commands.map((command) => ({ type: "command", command }))],
        }],
        PostToolUse: postToolUse,
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo before" }] }],
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo stopped" }] }],
      },
    };
    const install = (...args: string[]) => {
      const result = spawnSync("bash", [join(REPO, "scripts", "install-claude-integration.sh"), ...args], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(readFileSync(settingsPath, "utf8"));
    };
    try {
      writeFileSync(settingsPath, JSON.stringify(seed));
      writeFileSync(memoryPath, "# Personal instructions\n");
      for (let pass = 0; pass < 2; pass++) {
        const settings = install("--no-disable-memory");
        expect(settings.hooks.SessionStart).toEqual([
          unrelatedGroup,
          { matcher: "*", hooks: [{ type: "command", command: canonical }] },
        ]);
        expect(settings.theme).toBe(seed.theme);
        expect(settings.autoMemoryEnabled).toBe(true);
        expect(settings.hooks.PostToolUse).toEqual(postToolUse);
        expect(settings.hooks.PreToolUse).toEqual([
          ...seed.hooks.PreToolUse,
          { matcher: "Bash", hooks: [{ type: "command", command: "qmemd hook beacon" }] },
        ]);
        expect(settings.hooks.Stop).toEqual(seed.hooks.Stop);
      }
      // Uninstall must clean old registrations too, not only the newly installed form.
      const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
      installed.hooks.SessionStart[0].hooks.push(
        ...legacyCommands.map((command) => ({ type: "command", command })),
      );
      writeFileSync(settingsPath, JSON.stringify(installed));
      for (let pass = 0; pass < 2; pass++) {
        expect(install("--uninstall")).toEqual({
          ...seed, hooks: { ...seed.hooks, SessionStart: [unrelatedGroup] },
        });
        expect(readFileSync(memoryPath, "utf8")).toBe("# Personal instructions\n");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
