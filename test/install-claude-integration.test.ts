import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// qmemd-inu: reusable Claude Code integration installer. The script must, against
// an isolated CLAUDE_CONFIG_DIR, (1) set autoMemoryEnabled:false so Claude's
// built-in auto-memory stops competing with qmemd, (2) merge the SessionStart
// snapshot hook, (3) inject an @import of the repo's generic rule file into
// CLAUDE.md — all idempotently and without clobbering existing config.

const REPO = resolve(__dirname, "..");
const SCRIPT = join(REPO, "scripts", "install-claude-integration.sh");
const RULE_FILE = join(REPO, "claude", "qmemd.md");
const IMPORT_LINE = `@${RULE_FILE}`;

function run(home: string, args: string[] = []) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`install script exited ${r.status}\nSTDERR:\n${r.stderr}\nSTDOUT:\n${r.stdout}`);
  }
  return r.stdout;
}

describe("install-claude-integration.sh", () => {
  let home: string;
  const settingsPath = () => join(home, ".claude", "settings.json");
  const memoryPath = () => join(home, ".claude", "CLAUDE.md");
  const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
  const hookCommands = (s: any): string[] =>
    (s.hooks?.SessionStart ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "qmemd-install-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("creates settings.json with autoMemoryEnabled:false", () => {
    run(home);
    expect(readSettings().autoMemoryEnabled).toBe(false);
  });

  test("merges the SessionStart snapshot hook", () => {
    run(home);
    const cmds = hookCommands(readSettings());
    expect(cmds.some((c) => c.includes("qmemd recall --session"))).toBe(true);
  });

  test("injects an @import of the repo rule file into CLAUDE.md", () => {
    run(home);
    expect(readFileSync(memoryPath(), "utf8")).toContain(IMPORT_LINE);
  });

  test("is idempotent: second run adds no duplicate hook or import", () => {
    run(home);
    run(home);
    const cmds = hookCommands(readSettings()).filter((c) => c.includes("qmemd recall --session"));
    expect(cmds).toHaveLength(1);
    const md = readFileSync(memoryPath(), "utf8");
    expect(md.split(IMPORT_LINE).length - 1).toBe(1);
  });

  test("preserves existing settings keys and hooks", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({
        existingKey: 42,
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    run(home);
    const s = readSettings();
    expect(s.existingKey).toBe(42);
    expect(hookCommands(s)).toContain("echo hi");
    expect(hookCommands(s).some((c) => c.includes("qmemd recall --session"))).toBe(true);
  });

  test("preserves existing CLAUDE.md content when appending the import", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(memoryPath(), "@RTK.md\n\n# My stuff\n");
    run(home);
    const md = readFileSync(memoryPath(), "utf8");
    expect(md).toContain("@RTK.md");
    expect(md).toContain("# My stuff");
    expect(md).toContain(IMPORT_LINE);
  });

  test("--no-disable-memory leaves autoMemoryEnabled untouched", () => {
    run(home, ["--no-disable-memory"]);
    expect(readSettings().autoMemoryEnabled).toBeUndefined();
  });

  test("prints the MCP registration command instead of running it", () => {
    const out = run(home);
    expect(out).toContain("claude mcp add");
  });

  test("ships a generic rule file with no maintainer-specific paths", () => {
    const rule = readFileSync(RULE_FILE, "utf8");
    expect(rule).not.toContain("/home/user");
    expect(rule).not.toMatch(/\.local\/share\/qmd-memory/);
    expect(rule).toContain("$QMD_MEMORY_DIR");
    expect(rule.toLowerCase()).toContain("recall");
  });

  const preToolUseCommands = (s: any): string[] =>
    (s.hooks?.PreToolUse ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

  test("merges the PreToolUse(Bash) beacon hook", () => {
    run(home);
    const s = readSettings();
    const block = (s.hooks?.PreToolUse ?? []).find((g: any) =>
      (g.hooks ?? []).some((h: any) => h.command === "qmemd hook beacon"));
    expect(block).toBeDefined();
    expect(block.matcher).toBe("Bash");
  });

  test("re-running does not duplicate the beacon hook (idempotent)", () => {
    run(home);
    run(home);
    const cmds = preToolUseCommands(readSettings());
    expect(cmds.filter((c) => c === "qmemd hook beacon").length).toBe(1);
  });

  test("preserves an existing unrelated PreToolUse hook through the beacon merge", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "other-cmd" }] }] },
      }),
    );
    run(home);
    const cmds = preToolUseCommands(readSettings());
    expect(cmds).toContain("other-cmd");
    expect(cmds).toContain("qmemd hook beacon");
  });

  test("--uninstall removes the SessionStart hook, beacon, and @import", () => {
    run(home);
    run(home, ["--uninstall"]);
    const s = readSettings();
    expect(hookCommands(s).some((c) => c.includes("qmemd recall --session"))).toBe(false);
    expect(preToolUseCommands(s).includes("qmemd hook beacon")).toBe(false);
    expect(readFileSync(memoryPath(), "utf8")).not.toContain(IMPORT_LINE);
  });

  test("--uninstall leaves autoMemoryEnabled:false in place", () => {
    run(home);
    run(home, ["--uninstall"]);
    expect(readSettings().autoMemoryEnabled).toBe(false);
  });

  test("--uninstall preserves unrelated hooks and keys", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({
        existingKey: 7,
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "echo keep" }] }] },
      }),
    );
    run(home);
    run(home, ["--uninstall"]);
    const s = readSettings();
    expect(s.existingKey).toBe(7);
    expect(hookCommands(s)).toContain("echo keep");
  });

  test("--uninstall is idempotent (second run no-ops)", () => {
    run(home);
    run(home, ["--uninstall"]);
    const afterFirst = readSettings();
    run(home, ["--uninstall"]);
    const afterSecond = readSettings();
    // A genuine no-op: the second uninstall leaves settings deep-equal to the
    // post-first-uninstall state. A destructive second run would diverge here.
    expect(afterSecond).toEqual(afterFirst);
    expect(hookCommands(afterSecond).some((c) => c.includes("qmemd recall --session"))).toBe(false);
  });

  const stopCommands = (s: any): string[] =>
    (s.hooks?.Stop ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

  test("default run wires no Stop write-beacon hook", () => {
    run(home);
    expect(stopCommands(readSettings())).not.toContain("qmemd hook write-beacon");
  });

  test("--write-beacon merges a Stop hook (matcher '*')", () => {
    run(home, ["--write-beacon"]);
    const s = readSettings();
    const block = (s.hooks?.Stop ?? []).find((g: any) =>
      (g.hooks ?? []).some((h: any) => h.command === "qmemd hook write-beacon"));
    expect(block).toBeDefined();
    expect(block.matcher).toBe("*");
  });

  test("--write-beacon is idempotent", () => {
    run(home, ["--write-beacon"]);
    run(home, ["--write-beacon"]);
    expect(stopCommands(readSettings()).filter((c) => c === "qmemd hook write-beacon").length).toBe(1);
  });

  test("--uninstall removes the Stop write-beacon hook", () => {
    run(home, ["--write-beacon"]);
    run(home, ["--uninstall"]);
    expect(stopCommands(readSettings()).includes("qmemd hook write-beacon")).toBe(false);
  });
});
