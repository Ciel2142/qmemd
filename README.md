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

`qmemd` depends on [`@tobilu/qmd`](https://www.npmjs.com/package/@tobilu/qmd) `2.8.3` from the npm registry, so a clean clone installs standalone.

```bash
# In this repo (Node ≥ 22 is the official runtime; Bun also works):
npm install              # or: bun install — resolves @tobilu/qmd@2.8.3 from the registry
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
`settings.json` (SessionStart `qmemd hook session`, PreToolUse(Bash) `qmemd
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
| `QMEMD_SESSION_BUDGET` | `2000` | Byte cap on the session snapshot (`hook session`, `recall --session`, and the MCP/REST session paths); invalid values fall back to the default |
| `QMEMD_SESSION_PROJECT_LIMIT` | `0` | Recent unpinned project/reference facts in the session snapshot. `0` (the default) makes the snapshot pinned-only; set `5` to restore the recency-sliced lanes. Invalid values fall back to the default |
| `QMEMD_TTL_<TYPE>` | `project` 90d · `reference` 180d · `user`/`feedback` durable | Per-type default review window applied when a fact has no explicit `review_by` (e.g. `QMEMD_TTL_PROJECT=180d`, or `never`); an unparseable value falls back to the built-in default. Surfaces via `qmemd stale` — never auto-expires |
| `XDG_CACHE_HOME` | `~/.cache` | Base for the default `QMEMD_DB` plus beacon/daemon state under `<cache>/qmemd/` |

### Git-backed sync

If `$QMD_MEMORY_DIR` is a git repo with a configured upstream, qmemd keeps it in
sync — entirely best-effort and gated, never failing a write:

- **One-time setup** (manual): `git init`, `git remote add origin <url>`, then
  `git push -u origin <branch>` to set the upstream. No auto-init.
- **On `remember` / `forget`:** stage + commit the change, then `git push`.
- **On a session snapshot** (`qmemd hook session`, `qmemd recall --session`, and the
  MCP/REST `session:true` paths): `git pull --ff-only` first.

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
qmemd recall --session          # on-demand snapshot (user + feedback + pinned facts, plus a coverage footer)
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
qmemd rescope [--known a,b] [--alias old=new]... [--json] [--apply [plan.json|-]]   # migrate global project/reference facts to their inferred project (dry run by default, model-free)
qmemd mcp                       # start the stdio MCP server (--http for the daemon; install-service for a durable unit)
qmemd hook session              # SessionStart hook — snapshot envelope, reads host JSON on stdin
qmemd hook beacon               # PreToolUse(Bash) hook — pivot + overlap blocks (wired via hook config, reads a hook event JSON on stdin)
qmemd hook probe                # PostToolUseFailure(Bash) hook — names facts matching a failed command (wired via hook config, reads a hook event JSON on stdin)
qmemd hook write-beacon         # Stop hook — write-side capture nudge (unchanged; wired via hook config)
qmemd hook stats [--since <N>h|<N>d|<N>w] [--json]   # hook trigger/uptake stats from the event log, default 7d (model-free)
```

### Session snapshot completeness

`hook session` and `recall --session` emit whole user/feedback bodies and
project/reference summaries within `QMEMD_SESSION_BUDGET` (default 2,000 UTF-8 bytes). Oversized facts are omitted,
not cut into instruction fragments; shorter later facts can still fit. Coverage
counts include omitted pins. Pinning makes a fact eligible in the current project
plus `global`, not guaranteed to appear. Unpinned project/reference facts remain
withheld by default; `QMEMD_SESSION_PROJECT_LIMIT=5` restores the recency slices.

Use `qmemd show <slug>` for a summary's full fact and `recall` or `qmemd list` to
retrieve omitted facts. A compact partial notice, empty snapshot, or missing footer
is not proof that the store has no relevant memories.

Configure `qmemd hook session` for SessionStart: it consumes the host's JSON on
stdin and emits the `suppressOutput` / `hookSpecificOutput.additionalContext`
SessionStart envelope. For an on-demand snapshot, run `qmemd recall --session`;
it never reads or waits for stdin and never updates hook session state.

### Content-derived hooks

Two `PreToolUse`(Bash) blocks and one `PostToolUseFailure`(Bash) probe push memory
without a `recall` call, each printed as a `💡 qmemd` block around the Bash tool call —
read any named fact with `qmemd show <slug>`.

Pivot and overlap counts, tags, and guidance include only active facts for the
current project plus `global` that match the host platform. Cached overlap hits
are checked against current fact metadata before delivery, so retirement or
platform changes cannot resurrect ineligible guidance from an old map.

When `qmemd hook session` receives a valid `session_id` in the host's stdin JSON,
it records only the facts actually delivered in the snapshot. Later pivot lists,
overlap blocks, and failure probes skip those facts; budget- or policy-omitted
facts remain eligible. Pivot counts and tag histograms still describe the full
eligible corpus. The shared history retains the latest 200 slugs per session;
eviction or a cache I/O failure can allow repeats. Missing or invalid session
identity and cache failures never block snapshot delivery. On-demand
`qmemd recall --session` does not read stdin or update this history.

- **Pivot block** — fires once per repo per session, on the first Bash call in that
  repo: `💡 qmemd · <repo> — R repo + G global memories`, then either up to ten
  `[type] description (slug)` lines or one `repo: tag(count) …` histogram line, then
  `→ qmemd recall "<repo> <topic>" before diagnosing`. A repo with no in-scope facts
  stays silent and unmarked, so the first pivot after facts appear still fires.
- **Overlap block** — fires on any Bash call whose command tokens overlap a fact's
  tags/slug: `💡 qmemd · <repo> — facts matching this command:`, up to three fact
  lines, then `→ qmemd show <slug> for the full fact`. Previously surfaced facts
  are skipped while retained in the shared history; on the pivot call the two
  blocks join with one blank line.
- **Probe** — `hooks/hooks.json`'s `PostToolUseFailure`/`Bash` entry (`qmemd hook
  probe`, `timeout: 10`) runs after a failed Bash call, builds a query from the
  command and the first line of the error (dropping an `Exit code N` header), and
  returns a `PostToolUseFailure` envelope naming matching in-scope facts. Each
  distinct failure probes once per session; the store opens lex-only, and any
  failure — bad input, a store error, a timeout — fails open (no output).
- **`qmemd hook stats`** — reads `~/.cache/qmemd/hook/events.jsonl` and prints one row
  per kind (`pivot`, `overlap`, `probe`) with `fired matched used acted` counts and
  the two proportions (`used/matched`, `acted/fired`) with 95% Wilson intervals. A
  missing or damaged event log never exits non-zero; `--json` emits the same numbers
  as JSON.

`remember` warns on a near-duplicate instead of writing — use `--replace <slug>` to update in place, `--supersedes <slug>` to retire the old fact under this new one (hidden from recall, kept on disk + git), or `--force` to write a new entry anyway. Dedup runs in three tiers: exact slug, FTS (BM25), then a model-free token-set near-dup pass whose contradiction classifier tells a true paraphrase (blocked as a duplicate) from a likely update — a differing version/number, polarity flip, or antonym — which is **surfaced as a conflict** with a type-derived authority comparison for you to resolve; qmemd never auto-resolves.

`remember --ttl <N>d|w|m|y` (or `--review-by YYYY-MM-DD`) schedules a re-verify date for facts that age — rotating creds, version pins, temporary states. A fact with **no** explicit `review_by` still ages: it inherits a per-type default review window — `project` 90 days, `reference` 180 days, `user`/`feedback` durable (never surface) — tunable per type via `QMEMD_TTL_<TYPE>` (see [Env vars](#env-vars)). `qmemd stale` then lists facts **due** (an explicit `review_by`, or an inherited window, now past) plus the never-reviewed backlog (decay-prone but not yet due); an undatable fact surfaces as due today. It is review-only: nothing is hidden or deleted, and recall ignores `review_by`.

Resolve each surfaced entry with one of:

- `qmemd reviewed <slug>` — you re-checked the fact and it is **still correct**: reset the staleness clock to `today + the type's window`. It forward-sets `review_by` only, leaving `updated` honest (content age stays truthful). Add `--ttl <N>d|w|m|y|never` or `--review-by YYYY-MM-DD` to set the next date explicitly; `--ttl never` (→ `review_by: never`) marks the fact permanently durable.
- `qmemd remember --replace <slug>` — the fact **changed**: edit it in place (re-arm the clock with a fresh `--ttl`). Omit `--type` to keep the existing one; pass a different one to **retype** the fact — it moves to that folder in one commit. (`--force` never retypes: it keeps the existing folder.)
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

### Rescope existing facts

`qmemd rescope` migrates global `project`/`reference` facts to the project their slug or tags actually belong to — `user`/`feedback` facts are never touched. Dry run is the default: it prints one `<slug> | <from> | <to> | <reason>` row per match in plan order, then a `<to>: N` count per target project (highest count first), then `N unmatched`; the corpus is only scanned, never opened for writes. Review the plan, then either edit it with `--json` (prints the plan as JSON) or apply it.

`--apply` runs the freshly computed plan; `--apply plan.json` or `--apply -` (stdin) applies a plan you reviewed or edited first. Every apply is all-or-nothing in one commit (`rescope: N facts`, singularized to `rescope: 1 fact` for a single-fact apply) — either every matched fact moves or none do. Use `--known a,b` to add extra project names to match beyond what's already in the corpus, and repeatable `--alias old=new` to route facts scoped `old` to `new` instead (and add `new` to the known set).

To undo an apply: `git revert <commit>` inside `$QMD_MEMORY_DIR`, then `qmemd reindex`.

`recall` returns a truncated body preview per hit (≤500 bytes; pass `--full` for the whole body). `show <slug>` prints one fact in full, and `list` browses the corpus by type/tag/project without loading the model.

`recall` reports completeness (qmemd-40h): when matches exceed `--limit` or hybrid hits fall below the relevance floor, a footer notes `N more match (raise --limit)` / `M below the 0.575 relevance floor (--min-score 0 shows all)` — `N+` when the search pool saturated and the count is a lower bound. Humans see it in-band; `--json` keeps the array shape and prints the note on stderr; MCP/REST return `moreMatches`/`belowFloor`/`saturated` fields.

Hybrid `recall` applies a relevance floor (`--min-score`, default `0.575`) to the **reranker score**, which is also the displayed hybrid score. A small number of near-threshold hits with distinctive query overlap can be rescued and are marked `↓below-floor` (`rescued:true` in JSON). The score is model- and runtime-dependent, not a calibrated probability; historical score bands do not carry across scoring-runtime changes. The existing floor remains pending broader calibration. Pass `--min-score 0` to disable it, or a higher value to tighten. The floor is **hybrid-only** — `--lex` ignores it, because the lexical path runs no reranker.

A freshly remembered fact is lex-searchable immediately. Vector (semantic) recall embeds any not-yet-embedded facts on demand — the first hybrid `recall` after a write does the embedding inline, so there is no background daemon to run.

## MCP server

`qmemd mcp` is a **stdio** MCP server by default. It exposes six tools: `remember`, `recall`, `forget`, `reviewed`, `get`, and `list`, with the same semantics as the CLI verbs (the MCP `get` tool ↔ the CLI `show` verb; `remember` takes the same `supersedes`/`platforms`/`ttl`/`reviewBy` parameters). `recall` carries a truncated body preview per hit; `get` returns one fact's full body by slug; `list` browses by type/tag/project; `reviewed` resets a fact's staleness clock (forward-sets `review_by`, accepting the same `ttl`/`reviewBy`).

Both stdio and HTTP support MCP revision `2026-07-28` and legacy clients using `initialize`. Stdio opens the database only when a tool needs it and closes the store on EOF or termination. HTTP keeps one warm store, returns JSON for both protocol eras, and requires the daemon token on `/mcp`; `DELETE /mcp` remains an authenticated empty acknowledgment.

Over stdio, `remember`'s `project` is optional and scopes to the current repo when omitted (`project`/`reference` → cwd basename; `user`/`feedback` → `global`); pass `project: "global"` for something true in every repo. A cwd at the filesystem root has no basename, so it falls back to `global` too. `replace` keeps the fact's stored scope rather than re-homing it. The shared HTTP daemon (below) has no cwd to fall back to, so it requires `project` explicitly.

**Breaking changes:** the daemon `remember` tool (`--http`) now requires `project` — a call that omitted it used to default to `global` and now fails validation. Pass the repo basename or `global` explicitly.

**Breaking changes:** `QMEMD_BEACON_EVERY` is removed — the PreToolUse beacon no longer re-fires on a timer, only once per repo per session (the pivot block) plus on a content match (the overlap block); a script or env setting relying on the old N-call re-fire cadence has no effect.

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

qmemd ships as a native Claude Code plugin that bundles the skill, all three hooks
(session snapshot + beacon + failure probe), and the `/qmemd:*` commands in one
install. It is the recommended path for most users: it wires the same SessionStart
snapshot and beacon hooks the `scripts/` installers do — plus the
`PostToolUseFailure` probe, which those installers do not wire yet (tracked as
`qp-fe0`) — and works straight from an `npm i -g` install, no git checkout
required.

The plugin deliberately does **not** declare an MCP server. Register one yourself,
either the stdio server ([MCP server](#mcp-server) above) or the shared HTTP daemon
(`qmemd mcp install-service`, see [HTTP API](#http-api-rest--mcp-over-http)) — one
server, one set of tools. A plugin-declared server would stand up a *second*
process alongside whichever one you already run, duplicating all six tools in the
model's context and letting the two drift to different versions.

1. **Install the CLI.** The hooks and the `/qmemd:*` commands shell out to it (as
   does whichever MCP server you register), so the `qmemd` command must be on PATH:

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
   `hook session` snapshot at the top of its context (the SessionStart hook).
   `qmemd status` confirms the CLI from step 1 (there is no `--version` flag).

**Migrating from the bash installer?** The plugin and
`scripts/install-claude-integration.sh` wire the *same* SessionStart + beacon hooks
(the plugin adds the `PostToolUseFailure` probe on top; the bash and PowerShell
installers wire snapshot + beacon only for now); running both double-fires the
beacon. Remove the bash-installer wiring first:

```bash
scripts/install-claude-integration.sh --uninstall
```

Conversely, don't run `scripts/install-claude-integration.sh` while the plugin is
enabled — it re-wires the same hooks and re-introduces the double-fire. Use the
plugin **or** the bash installer, not both.

For **Codex** and **Windsurf**, MCP + rule snippets live in
[`integrations/`](integrations/README.md).

**Cursor support has been removed.** Existing local installations are not
automatically uninstalled: remove the qmemd-specific Cursor plugin or copied
hooks, rules, and skills from your editor configuration. Do not remove shared
Claude configuration. The generic MCP API remains available, but qmemd no longer
ships or maintains a Cursor integration.

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
   (`qmemd hook session`) at the start of every session.
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

**Existing snapshot registrations:** updating the checkout or CLI alone does not
upgrade installed hooks. Re-run the installer for your platform, or update/reinstall
your plugin and restart the host. The installers replace historical qmemd
SessionStart registrations rather than adding a second snapshot hook. For manual
wiring, replace the old SessionStart command with `qmemd hook session`; keep
`qmemd recall --session` for on-demand snapshots only.

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
qmemd mcp token                    # print the daemon's auth token (mints it if the daemon hasn't started)
curl localhost:8182/health         # {"status":"ok","uptime":N} — the one route that needs no token
```

### Authentication

The daemon binds loopback and rejects non-loopback `Host` and cross-origin
`Origin` headers, but that only covers the *browser* threat model: any other
process on the machine sends a loopback Host and no Origin, so it could read the
whole corpus. Every route therefore requires a shared secret — the one exemption
is `GET /health`, which returns a hash of the memory root and no fact data, and
which the CLI must probe before it has any reason to authenticate.

The token is 32 random bytes, minted on first start into
`${XDG_CACHE_HOME:-~/.cache}/qmemd/daemon-token` with mode `0600`. It never
appears in a unit file, an environment dump, or a URL. The `qmemd` CLI reads that
file itself, so warm-daemon delegation needs no configuration; other clients send
it as the `x-qmemd-token` header:

```bash
curl -H "x-qmemd-token: $(qmemd mcp token)" localhost:8182/list
```

Point Claude Code at it (replaces the stdio registration — use one or the other):

```bash
claude mcp add --transport http qmemd http://localhost:8182/mcp \
  --header "x-qmemd-token: $(qmemd mcp token)"
```

Without the header the daemon answers `401`. A `qmemd recall` whose delegation is
rejected falls back to the local cold path rather than failing — the same
degradation as an unreachable daemon.

REST endpoints (localhost, JSON):

| Method | Path        | Body / query                                                       |
|--------|-------------|--------------------------------------------------------------------|
| POST   | `/recall`   | `{query, lexOnly?, minScore?, type?, limit?, full?, skim?, allPlatforms?, platform?}` or `{session:true, project?}` |
| POST   | `/remember` | `{fact, project, type?, tags?, pin?, source?, as?, replace?, supersedes?, force?, platforms?, ttl?, reviewBy?}` |
| POST   | `/forget`   | `{slug}`                                                            |
| GET    | `/list`     | `?type=&tag=&project=&platform=`                                    |
| GET    | `/get`      | `?slug=`                                                            |

`POST /remember` requires `project` — there is no cwd on the server side to default
it from, so a request that omits it gets `400 {"error":"Missing required field:
project"}` rather than a silently-scoped write.

**Breaking changes:** REST `POST /remember` now requires `project` — a request that
omitted it used to default to `global` and now fails with a `400`. Pass the repo
basename or `global` explicitly.

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
