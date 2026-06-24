import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "..");
const readJSON = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const SHIM = join(REPO, "hooks", "qmemd-shim.sh");

// Absolute path to bash, resolved via the ambient shell, so the fail-open test
// can invoke bash while handing the shim a PATH that contains neither qmemd nor
// npx — exercising the terminal `exit 0` branch directly.
const BASH = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

const stub = async (dir: string, name: string, marker: string) => {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\necho "${marker} $*"\n`);
  await chmod(p, 0o755);
};

describe("hooks/qmemd-shim.sh (PATH-or-npx resolver)", () => {
  let bin: string;
  beforeEach(async () => { bin = await mkdtemp(join(tmpdir(), "qmemd-shim-")); });
  afterEach(async () => { await rm(bin, { recursive: true, force: true }); });

  test("execs qmemd on PATH with all args", async () => {
    await stub(bin, "qmemd", "QMEMD-STUB");
    const r = spawnSync("bash", [SHIM, "recall", "--session"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
    });
    expect(r.stdout).toContain("QMEMD-STUB recall --session");
  });

  test("falls back to npx -y @ciel2142/qmemd when qmemd is absent", async () => {
    await stub(bin, "npx", "NPX-STUB");
    // Curated PATH: stub dir + system bins only — excludes any globally-installed qmemd.
    const r = spawnSync("bash", [SHIM, "stale"], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8",
    });
    expect(r.stdout).toContain("NPX-STUB -y @ciel2142/qmemd stale");
  });

  test("fail-open: exits 0 when neither qmemd nor npx resolves", () => {
    // PATH = the empty tmp dir only: neither qmemd nor npx resolves, so the shim
    // must reach its terminal `exit 0`. bash is invoked by absolute path (BASH)
    // because the curated PATH deliberately excludes it.
    const r = spawnSync(BASH, [SHIM, "hook", "beacon"], {
      env: { ...process.env, PATH: bin }, encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});

describe("hooks/session-start.sh (rule + snapshot emitter)", () => {
  const SS = join(REPO, "hooks", "session-start.sh");
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qmemd-ss-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("emits the rule, a divider, then the recall snapshot", async () => {
    await mkdir(join(root, "claude"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, "claude", "qmemd.md"), "# Memory (qmemd)\nRULE-BODY\n");
    await stub(join(root, "hooks"), "qmemd-shim.sh", "RECALL-STUB");
    const r = spawnSync(BASH, [SS], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("# Memory (qmemd)");
    expect(r.stdout).toContain("\n---\n");
    expect(r.stdout).toContain("RECALL-STUB recall --session --project");
  });

  test("fail-open: exits 0 when the rule file is absent", () => {
    const r = spawnSync(BASH, [SS], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("hooks/hooks.json wiring", () => {
  test("SessionStart runs session-start.sh under the plugin root", () => {
    const h = readJSON("hooks/hooks.json");
    const cmds = (h.hooks?.SessionStart ?? []).flatMap(
      (g: { hooks?: { command: string }[] }) => (g.hooks ?? []).map((x) => x.command));
    expect(cmds.some((c: string) => c.includes("session-start.sh") && c.includes("${CLAUDE_PLUGIN_ROOT}"))).toBe(true);
  });

  test("PreToolUse(Bash) fires the beacon through the shim", () => {
    const h = readJSON("hooks/hooks.json");
    const grp = (h.hooks?.PreToolUse ?? []).find((g: { matcher?: string }) => g.matcher === "Bash");
    expect(grp).toBeDefined();
    const cmds = (grp.hooks ?? []).map((x: { command: string }) => x.command);
    expect(cmds.some((c: string) => c.includes("qmemd-shim.sh") && c.includes("hook beacon"))).toBe(true);
  });
});
