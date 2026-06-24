---
name: qmemd-memory
description: Store and recall durable knowledge with qmemd memory (remember/recall/forget). Use when learning a durable user preference, a non-obvious gotcha, a reference worth keeping, or when starting a task that touches a system/tool/repo you may have notes on.
license: MIT
compatibility: Requires the qmemd CLI or MCP server. qmemd is unversioned pre-1.0 (package.json is at 0.2.0, no CHANGELOG) — feature availability tracks the checkout's git log, not a version floor.
allowed-tools: Bash(qmemd:*), mcp__qmemd__remember, mcp__qmemd__recall, mcp__qmemd__forget, mcp__qmemd__get, mcp__qmemd__list
---

# qmemd Memory

Durable, searchable knowledge store. Plain-markdown facts, one per file, under
`memory/{user,feedback,project,reference}/`. This is the **knowledge lane** — distinct
from br / beads_rust (the work/issue lane). Never duplicate a fact across both.

## When to remember
- A durable user preference or identity fact → `--type user`
- Guidance on how to work / a correction → `--type feedback`
- A repo/system fact not in code or git → `--type project`
- A reference pointer or discovery (URL, dashboard, gotcha) → `--type reference`

## When to recall
Don't assume the session-start snapshot already handed you the relevant facts — it is **partial** (see "The snapshot is partial" below). Pull explicitly at these concrete moments:
- **Before diagnosing any build / env / tooling error** — recall first; the cause and fix may already be documented (`recall "<topic>"`).
- **On first touch of a repo / system / tool this session** — when you first work in it, *including a mid-session pivot to a sub-issue*. The trigger is the first touch, not "session start".
- **When a user instruction names a mechanism you're about to implement** — recall the mechanism before designing it.
- **When the user references past context** → `recall "<topic>"`.

### The snapshot is partial — pull for the rest
If the SessionStart hook (`qmemd recall --session`) is configured, the snapshot is injected automatically; otherwise run it yourself at task start. It carries every `user` + `feedback` fact (full body) + pinned facts **in scope** (current project + `global` — pin means "never sliced off within scope", not "surface everywhere"; pin with `project: global` to surface in every repo), but only the **most recent** non-pinned `project` and `reference` facts scoped to the current project (cwd basename) plus `global` — older in-scope facts are **sliced off**. When the snapshot ends with a footer like `14 project facts for <proj> (5 shown, 9 more) — qmemd list --type project --project <proj>` (optionally followed by `Unshown tags: …`), those 9 are real facts you have **not** seen — `recall "<topic>"` or `qmemd list` to pull them. An empty or footer-less snapshot is not proof that no relevant facts exist.

## Routing rule vs br
True regardless of what you're working on → qmemd memory. Only meaningful inside the
current work (task state, decisions tied to an issue) → br.

## Commands
```bash
qmemd remember "<fact>" --type reference --tags a,b [--pin] [--project P] [--source S]
qmemd remember "<fact>" --as my-slug          # explicit slug
qmemd remember "<fact>" --replace my-slug     # update in place
qmemd remember "<fact>" --force               # write as a new entry despite a near-duplicate (vs --replace, which updates)
qmemd remember "<fact>" --ttl 90d             # schedule a re-verify date for a fact that ages (or --review-by YYYY-MM-DD)
qmemd recall "<query>" [--lex] [--type T] [--limit N] [--min-score N]
qmemd recall --session                        # snapshot (used by the SessionStart hook)
qmemd show <slug>                             # print one fact in full (no model); alias: qmemd get <slug>
qmemd list [--type T] [--tag t] [--project p] # browse the corpus (no model)
qmemd stale [--limit N]                       # facts due for review + never-reviewed backlog — review queue, never removes (no model)
qmemd reviewed <slug> [--ttl <N>d|w|m|y|never] [--review-by DATE]  # re-verified & unchanged: reset the staleness clock (updated untouched; --ttl never = durable)
qmemd forget <slug>
qmemd reindex                                 # re-index after hand-editing a fact file (lex; no model)
qmemd doctor [--fix] [--json]                 # audit frontmatter integrity after a hand-edit; --fix repairs mechanical issues (writes .bak; no model)
```
Prefer the MCP tools (`remember`/`recall`/`forget`/`reviewed`/`get`/`list`) when the qmemd MCP server is running; the CLI commands above work identically otherwise (the MCP `get` tool ↔ the CLI `show` verb, which also accepts `get` as an alias).

## Usage conventions
Discipline for *how* to call these, adapted from gbrain's filing rules.

- **Save raw before you extract.** When you `remember` in a loop over fetched content (web pages, emails, API dumps), write the raw text to a fact first, then derive each fact's slug + description *from the saved file* — not from your in-context memory of what you read. Re-read the file when summarizing a batch. LLM working memory drifts under batch load (gbrain measured 13/13 extracted amounts wrong from memory while the saved files were correct).
- **Recall is a delta filter for downstream search.** Before sending a topic to a web search or another LLM, prepend what you already know and ask only for what is *new*: "Here is what I know: `<recall output>`. Find what changed since `<date>`." Stops the downstream tool re-surfacing settled facts you already hold.
- **Notability gate — when in doubt, don't remember.** A fact earns a file only if it is durable, non-obvious, and you'd search for it again. A junk fact wastes attention and degrades recall precision; a missing fact can always be added later, a noisy corpus is hard to clean.
- **Fill `source` for provenance.** Pass `--source` (CLI) / `source` (MCP) with where the fact came from — a URL, `"user, <date>"`, or the tool that produced it. When a new write conflicts with an existing fact, qmemd surfaces both facts' `source` (verbatim), `type`, and date so you can judge which wins — user-authored facts (`type: user`/`feedback`) outrank agent-observed ones (`project`), which outrank external pages (`reference`). qmemd never auto-resolves; it surfaces the comparison and you decide (`--replace`/`--force`/reword).
- **Set `--ttl` on facts that age.** A rotating credential, a version pin, a DHCP-assigned IP, a "temporary" state: give it a shelf life at write time (`--ttl 90d`, or `ttl: "90d"` on the MCP tool; explicit date via `--review-by`). A fact with no `--ttl` still ages on a per-type default window (`project` 90d, `reference` 180d; `user`/`feedback` durable). `qmemd stale` is the review queue — it only *lists* what is due (recall never hides or expires anything); resolve each entry with `qmemd reviewed <slug>` when you re-checked it and it is still correct (resets the clock — `review_by` forward-set, `updated` left honest; `--ttl never` marks it permanently durable), or `--replace` when the fact changed, `--supersedes` to retire it, or `forget` to drop it.

## Notes
- A freshly remembered fact is lex-searchable immediately; the first semantic `recall`
  embeds it inline (seconds). `recall --lex` and the session snapshot work meanwhile.
- `remember` warns on a near-duplicate instead of writing — use `--replace <slug>` to update.
- Facts default to `project: global` (surface everywhere). Pass `--project <name>` to scope a fact: project-scoped facts appear in `recall --session` only when the current project (cwd basename) matches; `global` facts always appear. A free-text `recall "<query>"` is not project-filtered.
- Memories are plain markdown — you can hand-edit a file directly. A `recall` does **not** pick up content changes on its own (it only embeds facts the index already flags as pending; it never rescans files). After a hand-edit run `qmemd reindex` (lex, no model); the next hybrid `recall` then re-embeds the changed fact. Edits made via `remember --replace` reindex automatically. If a hand-edit may have broken the frontmatter (a fence, the `type`/`name`, a stray line), run `qmemd doctor` to audit it — `parseMemory` is lenient and would silently default a malformed `type`/`name` or drop an unparseable line rather than error. `qmemd doctor --fix` repairs the mechanical issues (type-vs-folder, name-vs-filename, null bytes) in place, writing a `.bak` first and leaving the change for you to review and commit.
- `recall` carries a truncated body preview per hit (pass `--full` / use `get` for the whole body). Use `show <slug>` / the MCP `get` tool to read one fact in full, and `list` to browse by type/tag/project without loading the model.
- Hybrid `recall` floors hits by the reranker's relevance score (`--min-score`, MCP `minScore`; default `0.575`) — hits the reranker scores below it (≈`0.5` = neutral/irrelevant, ≈`0.7+` = relevant) are dropped. If a recall comes back emptier than expected, lower it (`--min-score 0.5`) or disable it (`--min-score 0`). The floor is **hybrid-only**: `--lex` runs no reranker, so a `--lex` recall is never score-filtered.
- `recall` flags partial results: `N more match` / `M below the relevance floor` (CLI footer; `moreMatches`/`belowFloor`/`saturated` fields on MCP/REST). Do not read a truncated list as "no such fact" — raise `limit` or pass `minScore: 0` and re-check.
