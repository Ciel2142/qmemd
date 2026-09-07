---
name: qmemd-memory
description: Use when learning a durable preference, correction, gotcha, or reference, first touching a repo/system/tool, diagnosing tooling errors, implementing a named mechanism, or revisiting past context.
license: MIT
compatibility: Requires the qmemd CLI or MCP server.
allowed-tools: Bash(qmemd:*), mcp__qmemd__remember, mcp__qmemd__recall, mcp__qmemd__forget, mcp__qmemd__get, mcp__qmemd__list
---

# qmemd Memory

Durable facts live in `memory/{user,feedback,project,reference}/`. Use qmemd for
knowledge that outlasts the current task; use br / beads_rust for work state.
Keep each item in one lane.

## When to remember
- A durable user preference or identity fact → `--type user`
- Guidance on how to work / a correction → `--type feedback`
- A repo/system fact not in code or git → `--type project`
- A reference pointer or discovery (URL, dashboard, gotcha) → `--type reference`

## When to recall
Recall explicitly at these triggers; the session snapshot is not a substitute:
- **Before diagnosing a build/env/tooling error** — the cause and fix may be stored.
- **On first touch of a repo/system/tool this session**, including mid-session pivots.
- **When the user names a mechanism to implement** — recall it before designing.
- **When the user references past context.**

### The snapshot is partial — pull for the rest
If the SessionStart hook is configured, it supplies the snapshot. Otherwise run `qmemd recall --session` at task start; this reads no stdin and changes no hook state. Shown user/feedback bodies are whole; project/reference entries are summaries—use `show <slug>` for the body.

Every lane is budget-limited, including pins. Oversized facts are omitted, not cut into instruction fragments. Pins make facts eligible within scope, not guaranteed to appear. Unpinned project/reference facts are withheld by default (`QMEMD_SESSION_PROJECT_LIMIT=5` restores the five most recent per lane). An empty snapshot, omission notice, or missing footer is not proof that relevant facts are absent: use `recall "<topic>"` or `list`.

### Content-derived hooks: beacon and probe
The **beacon** (`PreToolUse`/Bash) reports eligible memory on first repo touch and matches command tokens to fact tags/slugs. The **probe** (`PostToolUseFailure`/Bash) matches failed commands and errors where that event is wired—Claude Code today, not Codex. Both exclude retired, foreign-project, and off-platform facts. Read a named fact with `qmemd show <slug>`; `qmemd hook stats` reports hook activity.

With valid session identity, hooks share a recent-200-slug history of delivered facts. Budget-omitted facts remain eligible; eviction or cache failure can allow repeats. Updating the CLI does not migrate hooks: update/reinstall the plugin or rerun the installer. Replace manual SessionStart registrations with `qmemd hook session` rather than adding duplicates.

## Commands
```bash
qmemd remember "<fact>" --type reference --tags a,b [--pin] [--project P] [--source S]  # defaults to the current repo; --project global for every repo
qmemd remember "<fact>" --as my-slug          # explicit slug
qmemd remember "<fact>" --replace my-slug     # update in place
qmemd remember "<fact>" --force               # write as a new entry despite a near-duplicate (vs --replace, which updates)
qmemd remember "<fact>" --ttl 90d             # schedule a re-verify date for a fact that ages (or --review-by YYYY-MM-DD)
qmemd recall "<query>" [--lex] [--type T] [--limit N] [--min-score N]
qmemd recall --session                        # on-demand snapshot; no stdin reads or hook-state updates
qmemd show <slug>                             # print one fact in full (no model); alias: qmemd get <slug>
qmemd list [--type T] [--tag t] [--project p] # browse the corpus (no model)
qmemd forget <slug>
qmemd reindex                                 # re-index after hand-editing a fact file (lex; no model)
qmemd rescope [--known a,b] [--alias old=new]... [--json] [--apply [plan.json|-]]  # migrate global project/reference facts to their inferred project (dry run by default; no model)
qmemd hook session                            # SessionStart envelope; consumes host JSON stdin (configured as a hook, not run by hand)
qmemd hook probe                              # PostToolUseFailure hook envelope — reads a failed Bash command + error from stdin (wired by hooks only where the host has that event — the Claude Code plugin today; not run by hand)
qmemd hook stats [--since <N>h|<N>d|<N>w] [--json]  # beacon/overlap/probe fired|matched|used|acted counts from the event log, default 7d (no model)
```
Prefer available qmemd MCP tools; use the CLI otherwise. MCP `get` corresponds to CLI `show` (alias `get`).

Maintenance on request: `qmemd doctor` / `qmemd stale` (Claude: `/qmemd:doctor` / `/qmemd:stale`).

## Usage conventions
- **Save raw before extracting.** When remembering a batch of fetched content, save the raw text first. Derive each fact's slug and description from the saved file, re-reading it when summarizing—not from working memory.
- **Search for the delta.** Before web search or another LLM, supply relevant recalled knowledge and ask what is new rather than rediscovering settled facts.
- **Remember selectively.** Store facts that are durable, non-obvious, and worth retrieving again. When in doubt, don't save.
- **Record provenance.** Supply `--source` / MCP `source` with the URL, user/date, or discovery tool. For conflicts, compare the surfaced source, type, and date: user/feedback outranks agent-observed project facts, which outrank external references. qmemd leaves resolution to you (`--replace`, `--force`, or reword).
- **Schedule review, not expiry.** For facts that age, set `--ttl 90d` / MCP `ttl: "90d"` or `--review-by YYYY-MM-DD` / MCP `reviewBy`. Without an explicit date, per-type defaults apply: project 90d, reference 180d, user/feedback durable. Review dates do not automatically hide or delete facts.

## Notes
- New facts are lex-searchable immediately. The first hybrid recall embeds pending facts; `--lex` and the session snapshot work meanwhile.
- `remember` warns on a near-duplicate instead of writing — use `--replace <slug>` to update.
- **Scope:** project/reference facts default to the cwd basename; user/feedback to `global`. A filesystem-root cwd falls back to `global`. Use `--project global` for cross-project knowledge; `--replace` preserves the stored scope. The HTTP daemon and REST API require an explicit project.
- Recall searches current-project + global facts. Global facts are eligible across projects, subject to selection rules and snapshot budgets. Use `--cross-project` / MCP `cross_project:true` to widen a thin result; foreign hits are labeled.
- **Hand edits:** run `qmemd reindex` afterward. Recall embeds indexed pending changes but does not rescan files. `remember --replace` reindexes automatically.
- Recall returns truncated previews; use `--full`, CLI `show`, or MCP `get` for whole bodies. `list` browses without loading a model.
- Hybrid recall applies a reranker relevance floor (`--min-score` / MCP `minScore`, default `0.575`). For unexpectedly thin results, lower it to `0.5` or disable it with `0`. Lex recall has no reranker or score floor.
- Partial results report `N more match` / `M below the relevance floor` (MCP/REST: `moreMatches`, `belowFloor`, `saturated`). Raise `limit` or use `minScore: 0` before concluding a fact is absent.
