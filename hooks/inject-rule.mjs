#!/usr/bin/env node
// SessionStart hook — inject qmemd's always-on rule (claude/qmemd.md) into the
// session as additionalContext. This is the plugin equivalent of the bash
// installer's `@import` of the rule into ~/.claude/CLAUDE.md: a plugin cannot edit
// the user's CLAUDE.md, so the rule rides in on SessionStart instead.
//
// Plugin-bundled (not a `qmemd` CLI verb) so it versions with the rule file in this
// repo, independent of whichever npm-installed qmemd the hooks shell out to. The
// session snapshot ships as a separate hook (`run-qmemd.mjs recall --session`).
//
// Fail-open: any error → exit 0 with no output. A session must never fail to start
// because the rule could not be read.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Wrap rule markdown in the Claude Code SessionStart additionalContext envelope. */
export function buildSessionContext(ruleContent) {
  return JSON.stringify({
    // suppressOutput: inject the rule as additionalContext silently. Without it (or with
    // raw stdout) Claude Code echoes a visible "hook success:" banner that crowds the
    // user's first prompt.
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ruleContent,
    },
  });
}

/** The always-on rule file shipped in the plugin, relative to its root. */
export function ruleFilePath(pluginRoot) {
  return join(pluginRoot, "claude", "qmemd.md");
}

function main() {
  try {
    // CLAUDE_PLUGIN_ROOT is exported into hook processes; fall back to this script's
    // own location (hooks/ → repo root) when run directly (e.g. tests, dev).
    const here = dirname(fileURLToPath(import.meta.url));
    const root = process.env.CLAUDE_PLUGIN_ROOT || join(here, "..");
    const rule = readFileSync(ruleFilePath(root), "utf-8");
    if (rule.trim()) process.stdout.write(buildSessionContext(rule));
  } catch {
    // Fail-open: a missing/unreadable rule file stays silent.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
