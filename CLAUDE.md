# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

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

`bin/qmemd` execs `dist/cli/qmemd.js`, so a global/linked `qmemd` reflects `src/` only after `npm run build`.

## Architecture Overview

qmemd is a durable **memory engine over markdown facts**, backed by the `@tobilu/qmd` search SDK. It is the *sole* memory engine — upstream `qmd` (≥2.5.3) no longer ships `remember/recall/forget`.

Each fact is a markdown file at `$QMD_MEMORY_DIR/<type>/<slug>.md` with YAML frontmatter (`name/description/type/tags/project/platforms/created/pinned/review_by/updated/supersedes/superseded_by/conflicts_with/source` — only the first seven plus `pinned` always present). On every write the file is git-committed (and `git push`ed when an upstream is set), lex-indexed into a dedicated SQLite DB at `$QMEMD_DB` (never qmd's own index), and later embedded with the small `embeddinggemma-300M` model. Session-snapshot paths (CLI `recall --session` and the MCP/REST `session:true` branches) first run `git pull --ff-only`. Writes are lex-only; vectors are built lazily on the first hybrid recall.

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
- **Recall scopes to {current project, global} by default** (qmemd-due): `recallQuery` gates hits to the caller's project + `global` whenever a `project` reaches the engine (CLI sends `basename(cwd)`; the MCP tool resolves `project ?? opts.sessionDefaultProject ?? basename(cwd)`; REST passes `body.project` **verbatim** — undefined ⇒ no gate ⇒ whole corpus, the pre-feature contract). `--cross-project` (CLI) / `cross_project:true` (MCP) / `crossProject` (REST body) widen to every project; foreign hits then carry `project` provenance and render fenced — `[<type> ⊥ <project>]` under a `— other projects —` divider (display-only; engine ranking/`limit` unchanged). A `N cross-project matches hidden (--cross-project to include)` footer (the `completenessFooter` idiom, alongside `moreMatches`/`belowFloor`) advertises what the default gate dropped, so narrowing is never silent. The gate mirrors `recallSession`'s `inProject` (already project-gated); `RecallHit.project`/`RecallResult.crossProjectHidden` are the new surfaces.
- **Dedup is three-tier** (`remember`): Tier-1 exact-slug (file existence), Tier-2 FTS near-duplicate (BM25 score > `DEDUP_SCORE_FTS`; qmd ANDs all query terms, so unrelated facts don't false-dedup as the corpus grows), Tier-2.5 model-free token-set near-dup scan whose contradiction classifier (differing identifier / polarity / antonym) routes a likely update to a **surfaced conflict** (`disposition:"conflict"` + authority comparison) instead of a silent block or silent write. The engine never auto-resolves.
- **Staleness is surface-only** (qmemd-9su / qmemd-s4w): a fact with no explicit `review_by` inherits a per-type default review window (`project` 90d, `reference` 180d, `user`/`feedback` durable; env-tunable via `QMEMD_TTL_<TYPE>`); `qmemd stale` and `qmemd doctor` list facts **due** (explicit or implicit date past) plus the **never-reviewed backlog** (decay-prone, not yet due) and never mutate. `review_by: never` marks a fact durable. `qmemd reviewed <slug>` forward-sets `review_by` (leaving `updated` honest) to reset the clock. Recall ignores `review_by`; nothing auto-expires.
- **Indexing:** `remember`/`forget` reindex automatically. To adopt a dir written out-of-band, run `qmemd reindex` (builds the lex index) then `qmemd embed` (vectors). Hybrid `recall` self-heals pending embeds via a lazy barrier.
- **Validate before filesystem/index use:** `assertSafeSlug` (traversal/newline), CLI `requireValidType` + MCP zod enums (closed `MemoryType`). The MCP layer allowlists `structuredContent` — never leak absolute fs paths to the model.
- **Best-effort indexing:** a fact is written + git-committed *before* reindex; an index failure surfaces as `indexed:false` and self-heals on the next write — it never loses the fact.
- **Testing:** vitest, TDD. Unit tests inject a fake `QMDStore` and spy on a `calls[]` array; integration tests open a real qmd store over a tmp dir. Tests must not load the embedding model — exercise lex/filesystem paths only.
- **Frontmatter format: KEEP** (measured 2026-05-30 — no body-only/sidecar migration).
