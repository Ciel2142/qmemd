#!/usr/bin/env node
// Hook proxy — run `qmemd <args>`, falling back to `npx -y @ciel2142/qmemd <args>`
// when qmemd is not on PATH (the README contract for the plugin's hooks). Used by
// the SessionStart snapshot (`recall --session`) and the PreToolUse beacon
// (`hook beacon`).
//
// Why a node wrapper instead of a bare `qmemd …` hook string: it adds the npx
// fallback, and it avoids POSIX shell operators (`||`, `2>`) that break when
// cmd.exe runs the hook string on Windows.
//
// Fail-open: any spawn failure → exit 0. A hook must never block Bash or a session.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

export const NPX_PACKAGE = "@ciel2142/qmemd";

/** The npx fallback argv used when `qmemd` is not on PATH. Pure (for tests). */
export function npxFallback(args) {
  return ["npx", "-y", NPX_PACKAGE, ...args];
}

/** Best-effort synchronous PATH probe, honouring Windows shim extensions. */
export function onPath(bin) {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { if (existsSync(join(dir, bin + ext))) return true; } catch { /* skip dir */ }
    }
  }
  return false;
}

function main(args) {
  const [command, ...rest] = onPath("qmemd") ? ["qmemd", ...args] : npxFallback(args);
  // npm installs `qmemd`/`npx` as .cmd shims on Windows, which need a shell to
  // resolve. The argv is fixed (recall/--session, hook/beacon) — nothing
  // user-controlled to escape. stdio is inherited so the beacon's stdin payload
  // and the snapshot's stdout pass straight through.
  const child = spawn(command, rest, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("error", () => process.exit(0));
  child.on("exit", (code) => process.exit(typeof code === "number" ? code : 0));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2));
}
