# qmemd

[![npm version](https://img.shields.io/npm/v/@ciel2142/qmemd)](https://www.npmjs.com/package/@ciel2142/qmemd)

Durable memory engine: remember, recall, and forget plain-markdown facts backed by the [`@tobilu/qmd`](https://github.com/tobi/qmd) SDK. `qmemd` opens its own dedicated qmd index whose only collection is the memory data directory.

## What it is

Facts are stored as individual markdown files under `$QMD_MEMORY_DIR/{user,feedback,project,reference}/`. The engine provides BM25 lex search and optional vector (embedding) search over that collection, plus a session-snapshot recall for use in AI agent hooks.

There are four fact types:
- `user` — durable user preferences or identity facts
- `feedback` — guidance on how to work / corrections
- `project` — repo/system facts not in code or git
- `reference` — reference pointers and discoveries (URLs, dashboards, gotchas)

## Install (users)

Published to npm as **`@ciel2142/qmemd`** (the installed CLI command is `qmemd`). Requires **Node ≥ 22** (Bun also works).

```bash
npm install -g @ciel2142/qmemd        # global CLI (command: qmemd)
npx @ciel2142/qmemd recall "<topic>"  # or run without installing
```

> **npm ships the CLI only.** `npm install -g` puts the `qmemd` command on your
> PATH, but the `scripts/` installers (`install-claude-integration.sh`,
> `install-windows.ps1`) are **not** in the npm package — they need a git checkout.
> To turn an npm-installed `qmemd` into Claude Code's memory engine, install the
> [Claude Code plugin](#install-as-a-claude-code-plugin-recommended) (it bundles the
> hooks, commands, skill, and trigger rule), then do the one step the plugin can't:
> set `autoMemoryEnabled: false` in `~/.claude/settings.json`.

---

## Install (dev)

`qmemd` depends on [`@tobilu/qmd`](https://www.npmjs.com/package/@tobilu/qmd) `2.5.3` from the npm registry, so a clean clone installs standalone.

```bash
# In this repo (Node ≥ 22 is the official runtime; Bun also works):
npm install              # or: bun install — resolves @tobilu/qmd@2.5.3 from the registry
npm run build            # tsc -p tsconfig.json → dist/

# Put qmemd itself on PATH:
npm link                 # or: bun link
```

> **Rebuild after `src/` changes:** `bin/qmemd` execs `dist/cli/qmemd.js`, so a linked or
> global `qmemd` reflects your edits only after `npm run build`. To run straight from
> source without a build, use `npm run qmemd -- <verb>` (tsx).

> **Note:** `@tobilu/qmd` is published to npm, so `bun install` resolves it like any other
> dependency — no local `qmd` checkout or `bun link @tobilu/qmd` is required for qmemd.
> (The standalone `qmd` CLI/MCP is a *separate* tool that may still run from a local fork
> checkout via its own global `bun link`; that is independent of qmemd's dependency.) To
> develop qmemd against an unreleased `qmd`, run `bun link @tobilu/qmd` against your
> checkout to temporarily override the registry version with a symlink.

## Install (Windows, native)

Runs `qmemd` as your Claude Code memory engine on native Windows (PowerShell / cmd).

> **Needs a git checkout** — `scripts\install-windows.ps1` is not in the npm
> package. If you installed via `npm i -g @ciel2142/qmemd`, use the
> [plugin](#install-as-a-claude-code-plugin-recommended) instead.

**Prerequisites** (the installer checks and stops with instructions if any are missing):

- **Bun for Windows** — `winget install Oven-sh.Bun` (reopen the shell afterward).
- **git** — `winget install Git.Git`.

> **Note:** `@tobilu/qmd` is published to npm, so `bun install` resolves it like any
> other dependency — no local `qmd` checkout or `bun link @tobilu/qmd` is required.
> (The standalone `qmd` CLI/MCP is a *separate* tool that may still run from a local
> fork checkout via its own global `bun link`; that is independent of qmemd.)

**Install:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
# keep Claude's built-in auto-memory:
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -NoDisableMemory
```

The installer: builds qmemd (`bun install` / `bun run build`), adds `<repo>\bin`
to your **User** PATH (so the `qmemd.cmd` shim
resolves — **open a new shell**, and fully **restart Claude Code**, to pick it up), and idempotently wires
`settings.json` (SessionStart `qmemd recall --session`, PreToolUse(Bash) `qmemd
hook beacon`, `autoMemoryEnabled=false`) plus the `@import` in `CLAUDE.md`. It
honors `$env:CLAUDE_CONFIG_DIR` (default `%USERPROFILE%\.claude`).

Then, **in the new shell** (so the `qmemd` shim resolves), register the MCP server
yourself (pick a scope):

```powershell
claude mcp add qmemd -- qmemd mcp
```

> **Embeddings on Windows:** the native qmd embedding model is unverified on
> Windows, but install never depends on it. Lex recall, the session snapshot, and
> the beacon are model-free and work regardless; only hybrid (semantic) `recall`
> needs the model, and it loads lazily on first use. If it fails to load, lex
> recall (`qmemd recall --lex "<query>"`) still works.

> **Optional — idiomatic data dir:** `setx QMD_MEMORY_DIR "%LOCALAPPDATA%\qmd-memory"`
> (otherwise facts live under `%USERPROFILE%\.local\share\qmd-memory`).

## Verify the install

```bash
qmemd --version   # prints the version → the CLI is on your PATH
```

Not found? The fix depends on **how** you installed:

- **`npm i -g` (Linux / macOS / Windows):** npm's global bin dir is already on PATH
  from a standard Node install — no PATH edit, no new shell. If `qmemd` is still
  missing, that dir isn't on your PATH: `npm prefix -g` prints it (`<prefix>/bin` on
  Linux/macOS, `%APPDATA%\npm` on Windows) — add it, or reinstall Node so its
  installer wires PATH. `npx @ciel2142/qmemd <verb>` always works with no PATH setup.
- **git checkout (`npm link` / `bun link`, or `install-windows.ps1`):** these add a
  directory to PATH, which only affects shells opened **afterward** — open a new
  shell, and **fully restart Claude Code** so its hook/MCP child processes inherit
  the new PATH.

> PATH setup is a **checkout-only** concern. `npm i -g @ciel2142/qmemd` installs into
> a directory already on PATH, so the new-shell / restart-Claude step does not
> apply — prefer it unless you are developing qmemd itself.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `QMD_MEMORY_DIR` | `~/.local/share/qmd-memory` | Memory data directory (markdown facts live here) |
| `QMEMD_DB` | `~/.cache/qmemd/index.sqlite` | Dedicated qmd index database |
| `QMEMD_EMBED_MODEL` | `embeddinggemma-300M` (Q8 GGUF) | Embedding model for hybrid recall — independent of qmd's own `QMD_EMBED_MODEL`; pinned to the index via a sidecar marker, mismatches warn at open |
| `QMEMD_EMBED_TIMEOUT_MS` | `6000` | Bound on the lazy embed barrier in hybrid recall; on timeout recall fails open to lexical search (flagged `degraded`) |
| `QMEMD_HTTP_PORT` | `8182` | Port for `qmemd mcp --http` / the installed service (CLI `--port` wins) |
| `QMEMD_BEACON_EVERY` | `20` | Re-fire cadence of the PreToolUse memory-presence beacon (every N Bash calls; a repo pivot always fires) |
| `QMEMD_SESSION_BUDGET` | `2000` | Byte cap on the session snapshot (`recall --session` and the MCP/REST session paths); invalid values fall back to the default |
| `QMEMD_SESSION_PROJECT_LIMIT` | `5` | Max recent project/reference facts in the session snapshot; invalid values fall back to the default |
| `QMEMD_TTL_<TYPE>` | `project` 90d · `reference` 180d · `user`/`feedback` durable | Per-type default review window applied when a fact has no explicit `review_by` (e.g. `QMEMD_TTL_PROJECT=180d`, or `never`); an unparseable value falls back to the built-in default. Surfaces via `qmemd stale` — never auto-expires |
| `XDG_CACHE_HOME` | `~/.cache` | Base for the default `QMEMD_DB` plus beacon/daemon state under `<cache>/qmemd/` |

### Git-backed sync

If `$QMD_MEMORY_DIR` is a git repo with a configured upstream, qmemd keeps it in
sync — entirely best-effort and gated, never failing a write:

- **One-time setup** (manual): `git init`, `git remote add origin <url>`, then
  `git push -u origin <branch>` to set the upstream. No auto-init.
- **On `remember` / `forget`:** stage + commit the change, then `git push`.
- **On session start** (`qmemd recall --session`, and the MCP/REST `session:true`
  paths): `git pull --ff-only` first.

Gating: no `.git` → nothing runs; `.git` but no upstream → commit only; `.git` +
upstream → commit/push/pull. Every git call is bounded by a 5s timeout, so a slow
or offline remote adds at most ~5s and then proceeds locally. Divergent histories
make `pull --ff-only` a silent no-op (reconcile manually); a push rejected because
the local branch is behind is harmless — the next session's pull fast-forwards.

### Backup & recovery

The markdown corpus under `$QMD_MEMORY_DIR` is the **only** source of truth; the
index at `$QMEMD_DB` is a derived cache. To restore on a new machine (or after a
lost/corrupt index): clone the memory repo to `$QMD_MEMORY_DIR`, then `qmemd
reindex` (rebuilds the lex index) and `qmemd embed` (rebuilds vectors). Nothing
else needs backing up — deleting `$QMEMD_DB` is always safe.

## Verbs

```bash
qmemd remember "<fact>" [--type user|feedback|project|reference] [--tags a,b] [--platforms linux,macos] [--pin] [--as slug] [--replace slug] [--supersedes slug] [--source S] [--ttl 90d|--review-by YYYY-MM-DD] [--force]
qmemd recall "<query>" [--lex] [--type T] [--platform P|--all-platforms] [--limit N] [--min-score N] [--full|--skim] [--json]
qmemd recall --session          # start-of-session snapshot (user/feedback/pinned + recent project + reference facts)
qmemd show <slug>               # print one fact in full (frontmatter + body)  (alias: qmemd get <slug>)
qmemd list [--type T] [--tag t] [--project p] [--platform P] [--json]   # browse the corpus (model-free)
qmemd tags [--project p] [--json]  # tag(count) overview for a project (model-free)
qmemd stale [--limit N] [--json]   # facts due for review + never-reviewed backlog; lists only, never removes (model-free)
qmemd reviewed <slug> [--ttl <N>d|w|m|y|never] [--review-by YYYY-MM-DD]  # re-verified & unchanged: reset the staleness clock (review_by forward-set, updated untouched; --ttl never = durable)
qmemd forget <slug>
qmemd reindex                   # rebuild the lex index from the memory dir (after out-of-band edits; model-free)
qmemd embed [--force]           # (re-)embed the memory collection
qmemd status                    # show store status as JSON
qmemd doctor [--fix] [--json]   # audit frontmatter integrity; --fix repairs mechanical issues (writes .bak, model-free)
qmemd mcp                       # start the stdio MCP server (--http for the daemon; install-service for a durable unit)
```

`remember` warns on a near-duplicate instead of writing — use `--replace <slug>` to update in place, `--supersedes <slug>` to retire the old fact under this new one (hidden from recall, kept on disk + git), or `--force` to write a new entry anyway. Dedup runs in three tiers: exact slug, FTS (BM25), then a model-free token-set near-dup pass whose contradiction classifier tells a true paraphrase (blocked as a duplicate) from a likely update — a differing version/number, polarity flip, or antonym — which is **surfaced as a conflict** with a type-derived authority comparison for you to resolve; qmemd never auto-resolves.

`remember --ttl <N>d|w|m|y` (or `--review-by YYYY-MM-DD`) schedules a re-verify date for facts that age — rotating creds, version pins, temporary states. A fact with **no** explicit `review_by` still ages: it inherits a per-type default review window — `project` 90 days, `reference` 180 days, `user`/`feedback` durable (never surface) — tunable per type via `QMEMD_TTL_<TYPE>` (see [Env vars](#env-vars)). `qmemd stale` then lists facts **due** (an explicit `review_by`, or an inherited window, now past) plus the never-reviewed backlog (decay-prone but not yet due); an undatable fact surfaces as due today. It is review-only: nothing is hidden or deleted, and recall ignores `review_by`.

Resolve each surfaced entry with one of:

- `qmemd reviewed <slug>` — you re-checked the fact and it is **still correct**: reset the staleness clock to `today + the type's window`. It forward-sets `review_by` only, leaving `updated` honest (content age stays truthful). Add `--ttl <N>d|w|m|y|never` or `--review-by YYYY-MM-DD` to set the next date explicitly; `--ttl never` (→ `review_by: never`) marks the fact permanently durable.
- `qmemd remember --replace <slug>` — the fact **changed**: edit it in place (re-arm the clock with a fresh `--ttl`).
- `qmemd remember --supersedes <slug>` — retire it under a successor fact.
- `qmemd forget <slug>` — drop it.

```bash
# after re-verifying each fact is still accurate:
qmemd reviewed redpanda-ca-cert                              # clock → today + the type's default window
qmemd reviewed clickhouse-sandbox-password --ttl 180d       # ...or set the next review 180 days out
qmemd reviewed deploybot-macmini-ssh --review-by 2026-12-31  # ...or pin an explicit next-review date
qmemd reviewed redpanda-acl-convention --ttl never          # decided permanent: stop surfacing (review_by: never)
```

Over MCP the `reviewed` tool mirrors the CLI — `{ slug, ttl?, reviewBy? }`, same semantics (see [MCP server](#mcp-server)).

`recall` returns a truncated body preview per hit (≤500 bytes; pass `--full` for the whole body). `show <slug>` prints one fact in full, and `list` browses the corpus by type/tag/project without loading the model.

`recall` reports completeness (qmemd-40h): when matches exceed `--limit` or hybrid hits fall below the relevance floor, a footer notes `N more match (raise --limit)` / `M below the 0.575 relevance floor (--min-score 0 shows all)` — `N+` when the search pool saturated and the count is a lower bound. Humans see it in-band; `--json` keeps the array shape and prints the note on stderr; MCP/REST return `moreMatches`/`belowFloor`/`saturated` fields.

Hybrid `recall` applies a relevance floor (`--min-score`, default `0.575`): hits the reranker scores below it are dropped. The floor is on the **reranker score** — the reranker's calibrated relevance judgement (≈`0.5` for a neutral/irrelevant hit, ≈`0.7+` for a genuinely relevant one) — *not* the displayed score, which is position-dominated (rank-1 carries a large RRF bonus regardless of relevance). Pass `--min-score 0` to disable the floor, or a higher value to tighten. The floor is **hybrid-only** — `--lex` ignores it, because the lexical path runs no reranker.

A freshly remembered fact is lex-searchable immediately. Vector (semantic) recall embeds any not-yet-embedded facts on demand — the first hybrid `recall` after a write does the embedding inline, so there is no background daemon to run.

## MCP server

`qmemd mcp` is a **stdio** MCP server by default. It exposes six tools: `remember`, `recall`, `forget`, `reviewed`, `get`, and `list`, with the same semantics as the CLI verbs (the MCP `get` tool ↔ the CLI `show` verb; `remember` takes the same `supersedes`/`platforms`/`ttl`/`reviewBy` parameters). `recall` carries a truncated body preview per hit; `get` returns one fact's full body by slug; `list` browses by type/tag/project; `reviewed` resets a fact's staleness clock (forward-sets `review_by`, accepting the same `ttl`/`reviewBy`).

Register it under `mcpServers` in your MCP client config (e.g. `~/.claude.json`), using any server name (here `qmemd`):

```json
{
  "mcpServers": {
    "qmemd": {
      "command": "qmemd",
      "args": ["mcp"]
    }
  }
}
```

## Install as a Claude Code plugin (recommended)

qmemd ships as a native Claude Code plugin that bundles the skill, the MCP server,
both hooks (session snapshot + beacon), and the `/qmemd:*` commands in one install.
It is the recommended path for most users: it wires the same SessionStart snapshot
and beacon hooks the `scripts/` installers do, but works straight from an
`npm i -g` install — no git checkout required.

1. **Install the CLI.** The plugin launches the MCP server as `qmemd mcp` and the
   `/qmemd:*` commands shell out to it, so the `qmemd` command must be on PATH:

   ```bash
   npm install -g @ciel2142/qmemd
   ```

   The hooks fall back to `npx -y @ciel2142/qmemd` when the CLI isn't on PATH, but a
   first-ever `npx` MCP cold-start can exceed the client's initialize timeout — a
   global install is the reliable path.

2. **Add the marketplace, then install the plugin** (run these inside Claude Code):

   ```text
   /plugin marketplace add Ciel2142/qmemd
   /plugin install qmemd@qmemd
   ```

3. **Disable Claude's built-in auto-memory** — the one step a plugin can't do, since
   it is an app-level setting a plugin may not change: set
   `"autoMemoryEnabled": false` in `~/.claude/settings.json` so it stops competing
   with qmemd.

4. **Restart Claude Code, then verify:** the `/qmemd:*` commands appear in the
   slash-command menu, and a fresh session injects the qmemd rule + the
   `recall --session` snapshot at the top of its context (the SessionStart hook).
   `qmemd --version` confirms the CLI from step 1.

**Migrating from the bash installer?** The plugin and
`scripts/install-claude-integration.sh` wire the *same* SessionStart + beacon hooks;
running both double-fires the beacon. Remove the bash-installer wiring first:

```bash
scripts/install-claude-integration.sh --uninstall
```

Conversely, don't run `scripts/install-claude-integration.sh` while the plugin is
enabled — it re-wires the same hooks and re-introduces the double-fire. Use the
plugin **or** the bash installer, not both.

For **Codex** and **Cursor**, copy-paste MCP + rule snippets live in
[`integrations/`](integrations/README.md).

## Integrate with Claude Code

> **Installed from npm?** The `scripts/install-claude-integration.sh` below is not
> in the npm package (it needs a git checkout). From an `npm i -g` install, wire
> everything through the [plugin](#install-as-a-claude-code-plugin-recommended)
> instead — it automates the trigger rule and SessionStart hook, leaving only
> `autoMemoryEnabled: false` for you.

Registering the MCP server makes the `remember`/`recall` tools available, but two
more pieces turn qmemd into the agent's actual memory engine:

1. **A trigger rule** — when to remember and recall — `@import`ed into your
   global `~/.claude/CLAUDE.md`. The rule lives in this repo at
   [`claude/qmemd.md`](claude/qmemd.md) (the [`qmemd-memory`](skills/qmemd-memory/SKILL.md)
   skill is the on-demand how-to; this rule is the always-on policy).
2. **A SessionStart hook** that injects the session snapshot
   (`qmemd recall --session`) at the start of every session.
3. **`autoMemoryEnabled: false`** so Claude's built-in auto-memory stops
   competing with qmemd.

An idempotent installer wires all three:

```bash
scripts/install-claude-integration.sh                      # wire it up
scripts/install-claude-integration.sh --no-disable-memory  # ...but keep built-in auto-memory
```

It edits `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) and appends one
`@`-import line to `~/.claude/CLAUDE.md` — re-running never duplicates. It does
**not** register the MCP server (the `-s` scope is yours to pick); it prints the
`claude mcp add` command to run yourself. The `@`-import is a live link: the rule
updates when you `git pull` this repo, so keep the checkout in place.

> **Already have the rule inline?** If you previously pasted the `# Memory (qmemd)`
> block directly into `~/.claude/CLAUDE.md`, delete that inline copy after running
> the installer — the `@`-import now supplies it, and keeping both duplicates the
> rule in every session's context. The installer dedupes its own `@`-import line,
> but it can't detect a hand-pasted inline copy.

## HTTP API (REST + MCP over HTTP)

By default `qmemd mcp` speaks stdio. Run it instead as a long-lived **localhost
HTTP server** to get a programmable REST API over your memory — for non-MCP
clients like scripts, cron jobs, `curl`, or a local web UI — alongside
MCP-over-HTTP for Claude sessions, all sharing one store. (A single process also
keeps the embedding model resident across sessions, but that is a minor effect:
hybrid recall is rare and the session-start snapshot is model-free — the REST
surface is the reason to run it.)

```bash
qmemd mcp install-service          # write a systemd --user (Linux) / launchd (macOS) unit, then print the activate commands
qmemd mcp install-service --print  # preview the unit + commands without writing anything
qmemd mcp uninstall-service        # remove the generated unit files

qmemd mcp --http --daemon          # dev-only: unsupervised background process (dies on SIGTERM, no restart)
qmemd mcp stop                     # stop the --daemon process
curl localhost:8182/health         # {"status":"ok","uptime":N}
```

Point Claude Code at it (replaces the stdio registration — use one or the other):

```bash
claude mcp add --transport http qmemd http://localhost:8182/mcp
```

REST endpoints (localhost, JSON):

| Method | Path        | Body / query                                                       |
|--------|-------------|--------------------------------------------------------------------|
| POST   | `/recall`   | `{query, lexOnly?, minScore?, type?, limit?, full?, skim?, allPlatforms?, platform?}` or `{session:true, project?}` |
| POST   | `/remember` | `{fact, type?, tags?, project?, pin?, source?, as?, replace?, supersedes?, force?, platforms?, ttl?, reviewBy?}` |
| POST   | `/forget`   | `{slug}`                                                            |
| GET    | `/list`     | `?type=&tag=&project=&platform=`                                    |
| GET    | `/get`      | `?slug=`                                                            |

The server binds `localhost` only with no auth — same single-user trust boundary
as the CLI. For a durable daemon that restarts on crash and survives reboot, run
`qmemd mcp install-service`: it generates a systemd **user** service (Linux) or a
launchd LaunchAgent (macOS) capturing the current environment, then prints the
`systemctl --user enable --now` / `launchctl bootstrap` commands to run. The bare
`--daemon` flag is dev-only and unsupervised.

## Build & test

```bash
npm run build            # tsc -p tsconfig.json → dist/
npm test                 # vitest run (model-free: lex/filesystem paths only)
npm run qmemd -- <verb>  # run the CLI from source via tsx, e.g. npm run qmemd -- recall --session
```
