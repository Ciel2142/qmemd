#!/usr/bin/env bash
#
# qmemd-shim.sh — the single PATH-or-npx resolution point for every qmemd hook
# and slash command. Execs the qmemd CLI with all passed args. Prefers a `qmemd`
# on PATH; falls back to `npx -y @ciel2142/qmemd`. Fail-open: if neither resolves
# it exits 0 so a PreToolUse hook never blocks a tool call.
#
# Deliberately fail-OPEN (not fail-loud like some resolvers): these callers are
# non-protocol hooks/commands where a missing binary must degrade silently, never
# block. The MCP server is the opposite case and is launched via bare `qmemd mcp`
# (see .claude-plugin/plugin.json), NOT through this npx fallback — a first-ever
# npx cold-start builds native deps (better-sqlite3, node-llama-cpp) before the
# server speaks protocol and would blow the client's initialize timeout (qmemd-faif.10).
set -uo pipefail

if command -v qmemd >/dev/null 2>&1; then
  exec qmemd "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx -y @ciel2142/qmemd "$@"
fi

# Neither qmemd nor npx available — fail open.
exit 0
