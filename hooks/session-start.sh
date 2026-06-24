#!/usr/bin/env bash
#
# session-start.sh — SessionStart hook. Its plain stdout is injected as session
# context (empirically confirmed by qmemd's existing recall --session hook).
# Emits the always-on qmemd rule (claude/qmemd.md) + a divider + the session
# snapshot (recall --session, via the shim). Fail-open: a missing rule or a failed
# recall degrades to partial output, never a blocking non-zero exit.
set -uo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
RULE="$ROOT/claude/qmemd.md"
SHIM="$ROOT/hooks/qmemd-shim.sh"

if [ -n "$ROOT" ] && [ -f "$RULE" ]; then
  cat "$RULE"
  printf '\n\n---\n\n'
fi

if [ -n "$ROOT" ] && [ -f "$SHIM" ]; then
  bash "$SHIM" recall --session --project "$(basename "$PWD")" 2>/dev/null || true
fi

exit 0
