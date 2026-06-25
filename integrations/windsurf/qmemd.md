---
trigger: always_on
description: qmemd durable-memory trigger policy — when to remember and recall.
---
<!-- Copy to .windsurf/rules/qmemd.md (project) or ~/.codeium/windsurf/memories/ global rules. -->
<!-- Adapted from claude/qmemd.md for Windsurf: memory is pull-only by default. Wire the
     optional pre_user_prompt hook (qmemd's integrations/windsurf/hooks.json.example) to
     inject memory before each prompt. Windsurf has NO session-start event, so no one-shot
     snapshot. Re-apply by hand if claude/qmemd.md changes — don't blind-copy. -->

# Memory (qmemd)

Durable knowledge lives in **qmemd memory** (knowledge lane); work/issue state lives in **br (beads_rust)** (work lane).

**Remember** (`remember` MCP tool, or `qmemd remember "<fact>" --type <type>`) when: the user states a durable preference (`type: user`), gives guidance/correction on how to work (`type: feedback`), I discover a non-obvious gotcha or a repo/system fact not in code/git (`type: project`), or hit a reference worth keeping — URL/dashboard/discovery (`type: reference`).

**Recall** (`recall` MCP tool, or `qmemd recall "<topic>"`) — **pull-only** unless you wired the optional `pre_user_prompt` hook (qmemd's `integrations/windsurf/hooks.json.example`), which injects memory **before each prompt** (Windsurf has no session-start event, so no one-shot snapshot). Either way, pull explicitly at these concrete moments:
- **Before diagnosing any build/env/tooling error** — the cause and fix may already be documented.
- **On first touch of a repo/system/tool this session** — the trigger is *first touch*, including a mid-session sub-issue pivot.
- **When a user instruction names a mechanism you're about to implement** — recall it before designing.
- **When the user references past context.**

When `recall` (or `qmemd list`) output ends with a footer like `14 project facts for <proj> (5 shown, 9 more) — qmemd list --type project --project <proj>`, more facts exist than it showed — re-run `qmemd list` or narrow the query to see them. A thin result is not proof a fact isn't stored.

**Recall is project-scoped by default** (qmemd-due): a `recall` query returns only facts for the current project (cwd basename) + `global` — another project's facts no longer surface unlabeled. To search across all projects (e.g. "have I hit this error in another repo?"), pass `--cross-project` (CLI) or `cross_project:true` (MCP `recall`); foreign hits then come back labeled with their project. When the default scope hid relevant foreign matches, recall prints a `N cross-project matches hidden (--cross-project to include)` footer — so a thin or empty result may be a **scoping** effect, not a true miss; widen before concluding a fact isn't stored.

**Routing tiebreaker:** true regardless of current work → qmemd; only meaningful inside this work → br. Never duplicate across lanes. Update with `qmemd remember --replace <slug>` (or edit the file, then `qmemd reindex` — a bare `recall` does not pick up file edits); remove with `qmemd forget <slug>`. Store: `$QMD_MEMORY_DIR`.

`qmemd tags [--project p]` prints the per-repo tag histogram of stored facts on demand — run it to see what memory exists for a repo before diagnosing.

Full how-to: the `qmemd-memory` skill.
