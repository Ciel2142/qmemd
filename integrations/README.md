# qmemd integrations (Codex & Windsurf)

qmemd's Claude Code packaging is a native plugin (see the repo README). **Codex also
has a native plugin** (next section) — the recommended path. Windsurf, and
anyone who prefers manual wiring, can copy-paste the pieces by hand: an **MCP server** for
the `remember`/`recall`/`forget` tools, plus an **always-on rule** so the agent recalls
proactively.

Install the CLI first so the MCP server resolves: `npm i -g @ciel2142/qmemd`
(the command is `qmemd`). A first-ever `npx` MCP cold-start can exceed the client's
initialize timeout, so a global install is the reliable path for the MCP server.

## Install as a native plugin (Codex)

The Codex plugin bundles the MCP server, the skill, and snapshot + beacon hooks into a
single install. Its directory sits alongside the manual snippets and carries a copy of
the root skill (`skills/qmemd-memory/`), kept byte-identical by a conformance test
(plugin packaging can't ship symlinks reliably). The CLI prereq above still applies.
Validated against Codex's published plugin spec (2026-06) — install locally and test
before publishing to a marketplace.

**Codex** — manifest `codex/.codex-plugin/plugin.json` (skill + MCP + hooks at
`codex/hooks/hooks.json`). Enable the hooks engine first (`codex_hooks = true`, see
`codex/config.toml.example`):

- **Personal:** add the plugin to `~/.agents/plugins/marketplace.json`, then enable it from
  `codex /plugins`.
- **Repo marketplace:** `codex plugin marketplace add Ciel2142/qmemd`, then install from
  `codex /plugins`.

Codex has no always-on *rule* component, so the remember/recall policy still comes from
`codex/AGENTS.snippet.md` (append to `AGENTS.md`) — the SessionStart hook supplies the live
memory snapshot. Marketplace publishing also wants the `interface` block's privacy/terms URLs
and a logo; fill those into `plugin.json` before submitting.

## Codex CLI

1. **MCP** — paste `codex/config.toml.example`'s `[mcp_servers.qmemd]` block into
   `~/.codex/config.toml`, or run `codex mcp add qmemd -- qmemd mcp`.
2. **Rule** — append `codex/AGENTS.snippet.md` (drop the `<!-- … -->` header lines)
   into `~/.codex/AGENTS.md` (global) or your repo-root `AGENTS.md`.
3. **Skill (optional)** — copy `../skills/qmemd-memory/` to
   `~/.agents/skills/qmemd-memory/` (or repo `.agents/skills/qmemd-memory/`).

## Cursor support removed

qmemd no longer ships or maintains a Cursor integration. Deleting these repository
assets does not uninstall existing local copies: remove any previously installed
qmemd-specific Cursor plugin or copied qmemd hook, rule, and skill configuration from
your editor setup yourself. Do not remove shared Claude configuration. The generic MCP
API remains available to arbitrary clients; this is not maintained Cursor support.

## Windsurf

1. **MCP** — paste [`windsurf/mcp.json.example`](windsurf/mcp.json.example)'s
   `mcpServers` into `~/.codeium/windsurf/mcp_config.json`.
2. **Rule** — copy `windsurf/qmemd.md` into `.windsurf/rules/` (project) or add it as a
   global rule. It is `trigger: always_on`, so it is injected into every conversation.

> Both rule files are **adapted** from `../claude/qmemd.md`, not verbatim copies: each is
> pull-only by default and points at its platform's optional hooks (below). If
> `../claude/qmemd.md` changes, re-apply the edits by hand — don't blind-copy over them.

## Optional: Claude-style hooks (auto snapshot + beacon + probe)

The MCP + rule above make memory **pull-only** — the agent must call `recall` itself. Claude
Code also wires three hooks that push memory automatically: a **SessionStart** snapshot
(`qmemd hook session`), a **PreToolUse** beacon (`qmemd hook beacon`, content-derived —
a once-per-repo pivot block plus an overlap block for a command that matches a fact), and a
**PostToolUseFailure** probe (`qmemd hook probe`) that names facts matching a failed Bash
command and its error. Which of the three you actually get depends on where you install:

| Host / install | Hooks wired |
| --- | --- |
| Claude Code plugin | snapshot + beacon + probe |
| `scripts/install-claude-integration.sh`, `scripts/install-windows.ps1` | snapshot + beacon |
| Codex CLI (`codex/hooks/hooks.json`) | snapshot + beacon |
| Windsurf (`windsurf/hooks.json.example`) | prompt-time snapshot only |

Every row but Windsurf's consumes qmemd's `hookSpecificOutput.additionalContext` JSON
envelope (verified against `../src/cli/qmemd.ts`); Windsurf shows hook stdout verbatim, so
its wiring strips the envelope to raw text. The per-host sections below say why the probe
stops where it does. E2E-test in your client before relying on it — hook schemas move
fast.

`qmemd hook session` reads the host's JSON stdin and emits the SessionStart envelope.
With a valid `session_id`, only facts actually delivered in that snapshot enter the
shared recent-200-slug history used by beacon and probe. Budget- or policy-omitted
facts remain eligible; pivot counts and tag histograms still cover the full eligible
corpus. Evicted slugs can repeat. Missing/invalid session identity or a cache failure
never prevents snapshot output; cache failures can allow repeats.

For an on-demand snapshot, use `qmemd recall --session`: it never reads or waits for
stdin and never mutates hook session state. Do not register it for SessionStart.
When upgrading an existing setup, update/reinstall the plugin or rerun the relevant
installer; for manual wiring, replace the historical SessionStart command with
`qmemd hook session` rather than adding a second registration. Updating this checkout
alone does not upgrade installed copies.

### Codex CLI — snapshot + beacon parity, no failure probe

1. Enable the hooks engine: add a `[features]` section with `codex_hooks = true` to
   `~/.codex/config.toml` (already in `codex/config.toml.example`). Needs a recent Codex CLI
   (hooks shipped v0.114.0+).
2. Copy `codex/hooks/hooks.json` to `~/.codex/hooks.json` (user) or `.codex/hooks.json` (repo):
   `SessionStart` → `qmemd hook session`, `PreToolUse` (Bash) → beacon. Codex reads
   `additionalContext` from the same envelope Claude does.

Codex has no `PostToolUseFailure` event: its `PostToolUse` also runs on a non-zero Bash exit,
but the outcome lives inside an untyped `tool_response` rather than the `error`/`is_interrupt`
fields the probe reads, so `codex/hooks/hooks.json` ships no probe entry — a
`PostToolUse`-shaped adapter is a tracked follow-up, not this wave.

### Windsurf — partial (no session-start event)

Windsurf's Cascade hooks have **no session-start event**, so there is no one-shot snapshot.
`windsurf/hooks.json.example` wires `pre_user_prompt` to inject the snapshot **before each
prompt** instead — it strips qmemd's JSON envelope to raw text (via `node`), since Windsurf
shows hook stdout verbatim. Copy it to `.windsurf/hooks.json` (repo) or
`~/.codeium/windsurf/hooks.json` (global). The `PreToolUse` beacon and the `PostToolUseFailure`
probe both have no Windsurf equivalent.
