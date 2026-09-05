# Memory (qmemd)

Durable knowledge lives in **qmemd memory** (knowledge lane); work/issue state lives in **br (beads_rust)** (work lane). Built-in Claude Code auto-memory is OFF (`autoMemoryEnabled: false`) — use qmemd, not `~/.claude/projects/*/memory/`.

**Remember** (`remember` MCP tool, or `qmemd remember "<fact>" --type <type>`) when: the user states a durable preference (`type: user`), gives guidance/correction on how to work (`type: feedback`), I discover a non-obvious gotcha or a repo/system fact not in code/git (`type: project`), or hit a reference worth keeping — URL/dashboard/discovery (`type: reference`). Facts scope to the current repo by default (`project`/`reference` → cwd basename; `user`/`feedback` → `global`); pass `project: global` (CLI `--project global`) for something true in every repo. `--replace` keeps the fact's stored scope.

**Recall** (`recall` MCP tool, or `qmemd recall "<topic>"`) — do **not** assume the session-start snapshot already handed you the relevant facts; every lane is **budget-limited**, including user/feedback and pins. Pull explicitly at these concrete moments:
- **Before diagnosing any build/env/tooling error** — the cause and fix may already be documented.
- **On first touch of a repo/system/tool this session** — the trigger is *first touch*, including a mid-session sub-issue pivot, not "session start".
- **When a user instruction names a mechanism you're about to implement** — recall it before designing.
- **When the user references past context.**

The snapshot emits whole user/feedback bodies and project/reference summaries when they fit its byte budget. Oversized facts are omitted, not cut into instruction fragments; omission counts include pinned facts. Pinning makes project/reference facts eligible within scope (current project + `global`), not guaranteed to appear; use `project: global` to pin globally. Unpinned project/reference facts are withheld by default (`QMEMD_SESSION_PROJECT_LIMIT=5` restores the five most recent per lane). Read summaries in full with `qmemd show <slug>`; use `recall` or `qmemd list` for omitted facts. A compact partial notice, an empty snapshot, or a missing footer is never proof that no relevant facts exist.

**Recall is project-scoped by default** (qmemd-due): a `recall` query returns only current-project + `global` facts. To search across all projects, pass `--cross-project` (CLI) / `cross_project:true` (MCP); foreign hits come back labeled. A thin or empty result may be a **scoping** effect, not a true miss — widen before concluding a fact isn't stored.

**Routing tiebreaker:** true regardless of current work → qmemd; only meaningful inside this work → br. Never duplicate across lanes. Update with `qmemd remember --replace <slug>` (or edit the file, then `qmemd reindex` — a bare `recall` does not pick up file edits); remove with `qmemd forget <slug>`. Store: `$QMD_MEMORY_DIR`.

Full how-to: the `qmemd-memory` skill.

**Memory-presence beacon:** `💡 qmemd` lines printed around a Bash command name facts qmemd
matched to that command or to its failure; read one with `qmemd show <slug>`.
