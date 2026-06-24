#!/usr/bin/env node
// scripts/smoke-clean-room.cjs — clean-room publish smoke (qmemd-faif.9).
//
// Packs the package, installs the tarball into a throwaway temp dir with --ignore-scripts (no
// native build), then proves the PUBLISHED artifact actually works:
//   1. the tarball ships the plugin assets the hooks/commands read (qmemd-faif.8 payload guard),
//   2. the bin runs (`qmemd --help` — qmemd has no --version; --help is native-free),
//   3. the MCP server answers `initialize` before any native dep is needed (connect-first,
//      qmemd-faif.10) — de-risks the N1 npx/MCP cold-start that would otherwise blow the timeout,
//   4. nothing surfaces MODULE_NOT_FOUND.
//
// Wired into package.json `prepublishOnly` so every publish re-verifies this path. Must NOT load
// the embedding model (repo rule): `--help` and the lazy connect-first `initialize` never do.
const { spawnSync, spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const MODULE_NOT_FOUND_RE = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/;
const REQUIRED_ASSETS = [
  "skills/qmemd-memory/SKILL.md",
  ".claude-plugin/plugin.json",
  "hooks/qmemd-shim.sh",
  "commands/stale.md",
  "claude/qmemd.md",
  "integrations/cursor/qmemd.mdc",
];

const die = (msg) => { console.error(`✗ clean-room smoke: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

// Spawn `qmemd mcp`, send one `initialize` request, resolve with the response. Kills the server as
// soon as it answers; rejects on timeout (the cold-start failure mode this smoke exists to catch).
function mcpInitialize(binJs, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binJs, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const done = (fn, arg) => { clearTimeout(timer); child.kill("SIGKILL"); fn(arg); };
    const timer = setTimeout(
      () => done(reject, new Error(`MCP initialize timed out after ${timeoutMs}ms. stderr:\n${err}`)),
      timeoutMs,
    );
    child.stdout.on("data", (d) => {
      out += d.toString();
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.id === 1 && msg.result) return done(resolve, msg.result);
        } catch { /* partial line — wait for more */ }
      }
    });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => done(reject, e));
    const req = {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "clean-room-smoke", version: "0" } },
    };
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "qmemd-cleanroom-"));
  try {
    // 1) pack
    const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" });
    if (pack.status !== 0) die(`npm pack failed:\n${pack.stderr}`);
    const tarball = join(work, JSON.parse(pack.stdout)[0].filename.replace(/^.*\//, ""));
    if (!existsSync(tarball)) die(`packed tarball not found: ${tarball}`);
    ok(`packed ${tarball.replace(work + "/", "")}`);

    // 2) install into a throwaway project, no native build
    const app = join(work, "app");
    mkdirSync(app, { recursive: true });
    spawnSync("npm", ["init", "-y"], { cwd: app, encoding: "utf8" });
    const inst = spawnSync("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, encoding: "utf8" });
    if (inst.status !== 0) die(`npm install failed:\n${inst.stderr}`);
    if (MODULE_NOT_FOUND_RE.test(inst.stderr || "")) die(`install surfaced a missing module:\n${inst.stderr}`);
    const pkgDir = join(app, "node_modules", "@ciel2142", "qmemd");
    if (!existsSync(pkgDir)) die(`installed package dir not found: ${pkgDir}`);
    ok("installed tarball (--ignore-scripts --no-audit --no-fund)");

    // 3) shipped plugin assets present (qmemd-faif.8 payload)
    for (const asset of REQUIRED_ASSETS) {
      if (!existsSync(join(pkgDir, asset))) die(`shipped tarball is missing plugin asset: ${asset}`);
    }
    ok(`plugin assets present (${REQUIRED_ASSETS.length} checked)`);

    const binJs = join(pkgDir, JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin.qmemd);
    // hermetic env: never touch real memory or the real index
    const env = { ...process.env, QMD_MEMORY_DIR: join(work, "mem"), QMEMD_DB: join(work, "idx.sqlite") };

    // 4) the bin runs
    const help = spawnSync(process.execPath, [binJs, "--help"], { encoding: "utf8", env });
    if (help.status !== 0) die(`'qmemd --help' exited ${help.status}:\n${help.stderr}`);
    if (MODULE_NOT_FOUND_RE.test((help.stderr || "") + (help.stdout || ""))) die(`'qmemd --help' hit a missing module:\n${help.stderr}`);
    ok("qmemd --help runs");

    // 5) MCP initialize handshake (connect-first; native binding unbuilt under --ignore-scripts)
    const result = await mcpInitialize(binJs, env, 30000);
    if (!result.serverInfo || result.serverInfo.name !== "qmemd") {
      die(`MCP initialize returned an unexpected result: ${JSON.stringify(result)}`);
    }
    ok(`MCP initialize handshake OK (serverInfo: ${result.serverInfo.name} ${result.serverInfo.version})`);

    console.log("\nclean-room smoke passed.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => die(e.message || String(e)));
