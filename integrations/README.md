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

> The three rule files (`cursor/qmemd.mdc`, `codex/AGENTS.snippet.md`,
> `windsurf/qmemd.md`) are verbatim copies of `../claude/qmemd.md`. If that rule
> changes, regenerate them by hand (re-run the `cat` recipe in the plan, or copy the
> new body in).
