# Project Instructions for AI Agents

## Issue Tracker (beads_rust / br)

This project uses **br** (beads_rust) for issue tracking. Run `br robot-docs guide` for the agent workflow, and `br --help` for the command list.

### Quick Reference

```bash
br ready                # Find available work
br show <id>            # View issue details
br update <id> --claim  # Claim work (assignee + status=in_progress)
br close <id>           # Complete work
```

### Rules

- Use `br` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `br robot-docs guide` for the detailed command reference and session-close protocol
- Use **qmemd** (`qmemd remember` / `qmemd recall`) for durable knowledge — do NOT use the issue tracker or MEMORY.md files for facts

**Architecture in one line:** issues live in a local SQLite DB (`.beads/beads.db`); `.beads/issues.jsonl` is the git-tracked export — commit it to sync across machines; `br sync` reconciles DB ↔ JSONL.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds


## Build & Test

Official runtime is **Node ≥ 22**; **Bun** also works (`bun.lock`, runtime-neutral code). The package is ESM (`"type": "module"`) and TypeScript `strict`.

```bash
npm install              # install deps (or `bun install`; @tobilu/qmd@2.5.3 from npm registry — see README; qmemd-u0f)
npm run build            # tsc -p tsconfig.json → dist/  (the `qmemd` bin runs dist, so rebuild after src changes)
npm test                 # vitest run --reporter=verbose  (no model load — lex/filesystem paths only)
npm run qmemd -- <verb>  # run the CLI from source via tsx, e.g. npm run qmemd -- recall --session
```

## Architecture Overview

qmemd is a durable **memory engine over markdown facts**, backed by the `@tobilu/qmd` search SDK (qmd ≥2.5.3 ships no `remember/recall/forget`).

Each fact is a markdown file at `$QMD_MEMORY_DIR/<type>/<slug>.md` with YAML frontmatter (`name/description/type/tags/project/platforms/created` + `pinned` always present; optional fields `supersedes`/`review_by`/`source` etc. in engine.ts). Every write is git-committed (pushed if upstream set), lex-indexed into `$QMEMD_DB` (never qmd's own index), then embedded lazily on the first hybrid recall. Session-snapshot paths (`recall --session`, `session:true`) git-pull --ff-only first.

Layers (`src/`):
- `paths.ts` — `memoryRoot()` (`$QMD_MEMORY_DIR`), `indexDbPath()` (`$QMEMD_DB`), cache/config dirs (`$XDG_CACHE_HOME`).
- `git.ts` — best-effort, gated git sync: `gitCommit` / `gitPush` / `gitPullFfOnly` over an injectable `GitRun` runner. Repo/upstream-gated, 5s-timeout, never throws.
- `store.ts` — `openMemoryStore()` wraps `createStore` over the single `memory` collection; pins the embed model (`$QMEMD_EMBED_MODEL`) to the index via a sidecar marker.
- `engine.ts` — core: frontmatter serialize/parse, `recallSession()` (filesystem-only snapshot, no model), `remember()` (write + three-tier dedup/conflict surfacing + supersession + reindex), `recallQuery()` (lex or hybrid search), `staleFacts()` (review_by staleness pass, read-only), `forget()` (delete + reclaim orphans). `reindexMemory()` = `store.update()`.
- `cli/qmemd.ts` — CLI: `remember | recall | forget | reviewed | show(/get) | list | tags | stale | hook | status | embed | reindex | doctor | mcp` (+ `mcp install-service | uninstall-service | stop`).
- `doctor.ts` — frontmatter integrity audit (qmemd-61h): `auditFact`/`fixContent` (pure) + `auditMemory`/`fixMemory` (fs walkers). doctor is the separate validation pass that lenient `parseMemory` is not: it flags fence/type/name/null-byte/platform/link/review_by divergence from physical truth, and `--fix` repairs the mechanical subset surgically, writing a `.bak`. Filesystem-only, no model.
- `beacon.ts` — PreToolUse memory-presence beacon (`qmemd hook beacon`): non-blocking nudge with the repo's unloaded-fact tag histogram; throttled, fail-open.
- `service.ts` — `install-service` artifacts: systemd --user / launchd unit generation + env capture.
- `mcp/server.ts` — MCP server exposing `remember | recall | forget | reviewed | get | list` tools; stdio by default, `--http` serves stateless MCP-over-HTTP plus a REST surface (localhost-guarded against DNS rebinding/CSRF).

Memory types: `user | feedback | project | reference`.

## Conventions & Patterns

- **Two lanes:** durable knowledge → qmemd memory; work/issue state → br (beads_rust) (above). Never duplicate across lanes.
- **Recall scopes to {current project, global} by default** (qmemd-due): a project reaching the engine gates hits to that project + `global`; `--cross-project` / `cross_project` / `crossProject` widen to the whole corpus (foreign hits render fenced + a `N cross-project matches hidden` footer). CLI/MCP always resolve a concrete project (`basename(cwd)` / `project ?? sessionDefaultProject ?? cwd`); **REST passes `body.project` verbatim — undefined ⇒ no gate ⇒ whole corpus (the pre-feature contract; don't add a default)**. Glyph (`[<type> ⊥ <project>]`) + surfaces: `cli/qmemd.ts` + `mcp/server.ts` render, `engine.ts recallQuery` gate.
- **Dedup is three-tier** (`remember`): exact-slug, FTS BM25 (> `DEDUP_SCORE_FTS`), then a model-free token-set near-dup pass whose contradiction classifier routes a likely update to a **surfaced conflict** (`disposition:"conflict"`) instead of a silent block or write — the engine never auto-resolves. Tier detail: README + dedup.ts.
- **Staleness is surface-only** (qmemd-9su): facts without explicit `review_by` inherit a per-type window (`project` 90d, `reference` 180d, `user`/`feedback` durable; env `QMEMD_TTL_<TYPE>`); `qmemd stale`/`qmemd doctor` list **due** + the **never-reviewed backlog** and never mutate. `review_by: never` marks a fact durable. `qmemd reviewed <slug>` forward-sets `review_by` (leaving `updated` honest). Recall ignores `review_by`; nothing auto-expires.
- **Indexing:** `remember`/`forget` reindex automatically. To adopt a dir written out-of-band, run `qmemd reindex` (builds the lex index) then `qmemd embed` (vectors). Hybrid `recall` self-heals pending embeds via a lazy barrier.
- **Validate before filesystem/index use:** `assertSafeSlug` (traversal/newline), CLI `requireValidType` + MCP zod enums (closed `MemoryType`). The MCP layer allowlists `structuredContent` — never leak absolute fs paths to the model.
- **Best-effort indexing:** a fact is written + git-committed *before* reindex; an index failure surfaces as `indexed:false` and self-heals on the next write — it never loses the fact.
- **Testing:** vitest, TDD. Unit tests inject a fake `QMDStore` and spy on a `calls[]` array; integration tests open a real qmd store over a tmp dir. Tests must not load the embedding model — exercise lex/filesystem paths only.
- **Frontmatter format: KEEP** (measured 2026-05-30 — no body-only/sidecar migration).
