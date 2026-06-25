# qmemd integrations (Codex, Cursor & Windsurf)

qmemd's Claude Code packaging is a native plugin (see the repo README). Codex,
Cursor, and Windsurf wire qmemd in by hand: an **MCP server** for the
`remember`/`recall`/`forget` tools, plus an **always-on rule** so the agent recalls
proactively. Every file here is copy-paste; nothing is generated.

Install the CLI first so the MCP server resolves: `npm i -g @ciel2142/qmemd`
(the command is `qmemd`). A first-ever `npx` MCP cold-start can exceed the client's
initialize timeout, so a global install is the reliable path for the MCP server.

## Codex CLI

1. **MCP** — paste `codex/config.toml.example`'s `[mcp_servers.qmemd]` block into
   `~/.codex/config.toml`, or run `codex mcp add qmemd -- qmemd mcp`.
2. **Rule** — append `codex/AGENTS.snippet.md` (drop the `<!-- … -->` header lines)
   into `~/.codex/AGENTS.md` (global) or your repo-root `AGENTS.md`.
3. **Skill (optional)** — copy `../skills/qmemd-memory/` to
   `~/.agents/skills/qmemd-memory/` (or repo `.agents/skills/qmemd-memory/`).

## Cursor

1. **MCP** — paste `cursor/mcp.json.example`'s `mcpServers` into `.cursor/mcp.json`
   (project) or `~/.cursor/mcp.json` (global).
2. **Rule** — copy `cursor/qmemd.mdc` into `.cursor/rules/`. It is `alwaysApply: true`,
   so it is injected at the start of every chat.
3. **Skill (optional)** — copy `../skills/qmemd-memory/` to `.cursor/skills/`,
   `.claude/skills/`, or `.agents/skills/` (Cursor reads all three).

## Windsurf

1. **MCP** — Windsurf reads the same `mcpServers` shape as Cursor: paste
   `cursor/mcp.json.example`'s `mcpServers` into `~/.codeium/windsurf/mcp_config.json`.
2. **Rule** — copy `windsurf/qmemd.md` into `.windsurf/rules/` (project) or add it as a
   global rule. It is `trigger: always_on`, so it is injected into every conversation.

> All three rule files are **adapted** from `../claude/qmemd.md`, not verbatim copies: each is
> pull-only by default and points at its platform's optional hooks (below). If
> `../claude/qmemd.md` changes, re-apply the edits by hand — don't blind-copy over them.

## Optional: Claude-style hooks (auto snapshot + beacon)

The MCP + rule above make memory **pull-only** — the agent must call `recall` itself. Claude
Code also wires two hooks that push memory automatically: a **SessionStart** snapshot
(`qmemd recall --session`) and a **PreToolUse** beacon (`qmemd hook beacon`). Cursor, Codex CLI,
and Windsurf have since shipped hook engines that run the same two commands. Both emit a
`hookSpecificOutput.additionalContext` JSON envelope (verified against `../src/cli/qmemd.ts`).
E2E-test in your client before relying on it — hook schemas move fast.

### Codex CLI — full parity

1. Enable the hooks engine: add a `[features]` section with `codex_hooks = true` to
   `~/.codex/config.toml` (already in `codex/config.toml.example`). Needs a recent Codex CLI
   (hooks shipped v0.114.0+).
2. Copy `codex/hooks.json.example` to `~/.codex/hooks.json` (user) or `.codex/hooks.json` (repo):
   `SessionStart` → snapshot, `PreToolUse` (Bash) → beacon. Codex reads `additionalContext` from
   the same envelope Claude does.

### Cursor — full parity

- **Reuse your Claude wiring (zero config):** if you already run qmemd's Claude hooks
  (`.claude/settings.json`), enable Cursor Settings → *third-party skills*. Cursor maps
  `SessionStart → sessionStart` and `PreToolUse → preToolUse` and parses `hookSpecificOutput`,
  so the snapshot + beacon fire unchanged.
- **Or native:** copy `cursor/hooks.json.example` to `.cursor/hooks.json`.

### Windsurf — partial (no session-start event)

Windsurf's Cascade hooks have **no session-start event**, so there is no one-shot snapshot.
`windsurf/hooks.json.example` wires `pre_user_prompt` to inject the snapshot **before each
prompt** instead — it strips qmemd's JSON envelope to raw text (via `node`), since Windsurf
shows hook stdout verbatim. Copy it to `.windsurf/hooks.json` (repo) or
`~/.codeium/windsurf/hooks.json` (global). The `PreToolUse` beacon has no Windsurf equivalent.
