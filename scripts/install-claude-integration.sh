#!/usr/bin/env bash
#
# install-claude-integration.sh — wire qmemd into Claude Code as the memory engine.
#
# Idempotent. Re-running is safe; it never duplicates a hook or import line.
#
#   1. @import this repo's rule file (claude/qmemd.md) into ~/.claude/CLAUDE.md
#      so every session gets the remember/recall trigger policy.
#   2. Merge the SessionStart snapshot hook (`qmemd recall --session ...`) into
#      ~/.claude/settings.json so the session-start memory snapshot is injected.
#   3. Set `autoMemoryEnabled: false` so Claude's built-in auto-memory stops
#      competing with qmemd (opt out with --no-disable-memory).
#   4. Print — but do NOT run — the MCP registration command (the -s scope is
#      yours to choose).
#
# Honors $CLAUDE_CONFIG_DIR (defaults to $HOME/.claude). Requires jq.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-claude-integration.sh [--no-disable-memory]

  --no-disable-memory   Do not touch autoMemoryEnabled (leave Claude's built-in
                        auto-memory as-is). Default is to set it false.
  --uninstall           Remove the SessionStart snapshot hook, the PreToolUse
                        beacon hook, and the CLAUDE.md @import (for migrating to
                        the native plugin). Leaves autoMemoryEnabled untouched.
  --write-beacon        Also wire the experimental Stop write-beacon hook
                        (off by default; needs QMEMD_WRITE_BEACON=1 at runtime).
  -h, --help            Show this help.
EOF
}

DISABLE_MEMORY=1
UNINSTALL=0
WRITE_BEACON=0
for arg in "$@"; do
  case "$arg" in
    --no-disable-memory) DISABLE_MEMORY=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --write-beacon) WRITE_BEACON=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

# Resolve repo root from this script's real location (<repo>/scripts/<this>).
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RULE_FILE="$REPO_ROOT/claude/qmemd.md"
[ -f "$RULE_FILE" ] || { echo "error: rule file not found: $RULE_FILE" >&2; exit 1; }

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
MEMORY_MD="$CLAUDE_DIR/CLAUDE.md"
HOOK_CMD='qmemd recall --session --project "$(basename "$PWD")"'
BEACON_CMD='qmemd hook beacon'
WRITE_BEACON_CMD='qmemd hook write-beacon'
IMPORT_LINE="@$RULE_FILE"

mkdir -p "$CLAUDE_DIR"

# --- Uninstall path (plugin migration) ----------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  if [ -f "$SETTINGS" ]; then
    tmp="$(mktemp)"
    jq --arg s "$HOOK_CMD" --arg b "$BEACON_CMD" --arg w "$WRITE_BEACON_CMD" '
      .hooks.SessionStart = ((.hooks.SessionStart // [])
        | map(.hooks |= map(select(.command != $s)))
        | map(select((.hooks | length) > 0)))
      | .hooks.PreToolUse = ((.hooks.PreToolUse // [])
        | map(.hooks |= map(select(.command != $b)))
        | map(select((.hooks | length) > 0)))
      | .hooks.Stop = ((.hooks.Stop // [])
        | map(.hooks |= map(select(.command != $w)))
        | map(select((.hooks | length) > 0)))
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  fi
  if [ -f "$MEMORY_MD" ]; then
    tmp="$(mktemp)"
    grep -vxF "$IMPORT_LINE" "$MEMORY_MD" > "$tmp" || true
    mv "$tmp" "$MEMORY_MD"
  fi
  echo "qmemd → Claude Code integration uninstalled (config dir: $CLAUDE_DIR)"
  echo "  • SessionStart snapshot hook: removed (if present)"
  echo "  • PreToolUse beacon hook    : removed (if present)  ($BEACON_CMD)"
  echo "  • CLAUDE.md @import         : removed (if present)  ($IMPORT_LINE)"
  echo "  • autoMemoryEnabled         : left unchanged (keep it false for the plugin)"
  echo
  echo "If you registered the MCP server, unregister it:  claude mcp remove qmemd"
  exit 0
fi

# --- 1 & 3. settings.json: SessionStart hook + autoMemoryEnabled --------------
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

hook_was_present="$(jq --arg cmd "$HOOK_CMD" \
  'any(.hooks.SessionStart[]?.hooks[]?; .command == $cmd) // false' "$SETTINGS")"

tmp="$(mktemp)"
jq --arg cmd "$HOOK_CMD" --argjson disable "$DISABLE_MEMORY" '
  (if $disable == 1 then .autoMemoryEnabled = false else . end)
  | .hooks = (.hooks // {})
  | .hooks.SessionStart = (.hooks.SessionStart // [])
  | if any(.hooks.SessionStart[]?.hooks[]?; .command == $cmd)
    then .
    else .hooks.SessionStart += [
      { "matcher": "*", "hooks": [ { "type": "command", "command": $cmd } ] }
    ]
    end
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

# --- 1b. settings.json: PreToolUse(Bash) memory-presence beacon (qmemd-tfu) -----
beacon_was_present="$(jq --arg cmd "$BEACON_CMD" \
  'any(.hooks.PreToolUse[]?.hooks[]?; .command == $cmd) // false' "$SETTINGS")"

tmp="$(mktemp)"
jq --arg cmd "$BEACON_CMD" '
  .hooks = (.hooks // {})
  | .hooks.PreToolUse = (.hooks.PreToolUse // [])
  | if any(.hooks.PreToolUse[]?.hooks[]?; .command == $cmd)
    then .
    else .hooks.PreToolUse += [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": $cmd } ] }
    ]
    end
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

# --- 1c. settings.json: opt-in Stop write-beacon (qmemd-yl3) -------------------
if [ "$WRITE_BEACON" = "1" ]; then
  tmp="$(mktemp)"
  jq --arg cmd "$WRITE_BEACON_CMD" '
    .hooks = (.hooks // {})
    | .hooks.Stop = (.hooks.Stop // [])
    | if any(.hooks.Stop[]?.hooks[]?; .command == $cmd)
      then .
      else .hooks.Stop += [
        { "matcher": "*", "hooks": [ { "type": "command", "command": $cmd } ] }
      ]
      end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
fi

if [ "$beacon_was_present" = "true" ]; then beacon_status="already present"; else beacon_status="added"; fi

if [ "$hook_was_present" = "true" ]; then
  hook_status="already present"
else
  hook_status="added"
fi

# --- 2. CLAUDE.md: @import the rule file --------------------------------------
[ -f "$MEMORY_MD" ] || : > "$MEMORY_MD"
if grep -qxF "$IMPORT_LINE" "$MEMORY_MD"; then
  import_status="already present"
else
  # Ensure a trailing newline before appending so we never join two lines.
  if [ -s "$MEMORY_MD" ] && [ -n "$(tail -c1 "$MEMORY_MD")" ]; then
    printf '\n' >> "$MEMORY_MD"
  fi
  printf '%s\n' "$IMPORT_LINE" >> "$MEMORY_MD"
  import_status="added"
fi

# --- Summary ------------------------------------------------------------------
echo "qmemd → Claude Code integration installed (config dir: $CLAUDE_DIR)"
echo "  • CLAUDE.md @import        : $import_status  ($IMPORT_LINE)"
echo "  • SessionStart snapshot hook: $hook_status"
echo "  • PreToolUse beacon hook    : $beacon_status  ($BEACON_CMD)"
if [ "$WRITE_BEACON" = "1" ]; then
  echo "  • Stop write-beacon hook    : added (opt-in)  ($WRITE_BEACON_CMD)"
fi
if [ "$DISABLE_MEMORY" = "1" ]; then
  echo "  • autoMemoryEnabled         : set to false (built-in auto-memory off)"
else
  echo "  • autoMemoryEnabled         : left unchanged (--no-disable-memory)"
fi
echo
echo "Last step — register the MCP server (pick a scope, this script won't run it):"
echo "    claude mcp add qmemd -- qmemd mcp        # stdio (default)"
echo "  Or, if you run the HTTP daemon:"
echo "    claude mcp add --transport http qmemd http://localhost:8182/mcp"
