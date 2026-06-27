# Memory (qmemd)

Durable knowledge lives in **qmemd memory** (knowledge lane); work/issue state lives in **br (beads_rust)** (work lane). Built-in Claude Code auto-memory is OFF (`autoMemoryEnabled: false`) — use qmemd, not `~/.claude/projects/*/memory/`.

**Remember** (`remember` MCP tool, or `qmemd remember "<fact>" --type <type>`) when: the user states a durable preference (`type: user`), gives guidance/correction on how to work (`type: feedback`), I discover a non-obvious gotcha or a repo/system fact not in code/git (`type: project`), or hit a reference worth keeping — URL/dashboard/discovery (`type: reference`).

**Recall** (`recall` MCP tool, or `qmemd recall "<topic>"`) — do **not** assume the session-start snapshot already handed you the relevant facts; it is **partial** (recent project/reference facts are sliced). Pull explicitly at these concrete moments:
- **Before diagnosing any build/env/tooling error** — the cause and fix may already be documented.
- **On first touch of a repo/system/tool this session** — the trigger is *first touch*, including a mid-session sub-issue pivot, not "session start".
- **When a user instruction names a mechanism you're about to implement** — recall it before designing.
- **When the user references past context.**

The snapshot injects every user + feedback fact (complete) but only the **most recent** project/reference facts for the current project + global (sliced) — recall project/reference explicitly. Pinned facts surface only **in scope**, not everywhere; use `project: global` to pin globally. A trailing footer (`N project facts … (M shown, K more)`) means more exist — `recall`/`qmemd list` to see them. An empty/footer-less snapshot is not proof no relevant facts exist.

**Recall is project-scoped by default** (qmemd-due): a `recall` query returns only current-project + `global` facts. To search across all projects, pass `--cross-project` (CLI) / `cross_project:true` (MCP); foreign hits come back labeled. A thin or empty result may be a **scoping** effect, not a true miss — widen before concluding a fact isn't stored.

**Routing tiebreaker:** true regardless of current work → qmemd; only meaningful inside this work → br. Never duplicate across lanes. Update with `qmemd remember --replace <slug>` (or edit the file, then `qmemd reindex` — a bare `recall` does not pick up file edits); remove with `qmemd forget <slug>`. Store: `$QMD_MEMORY_DIR`.

Full how-to: the `qmemd-memory` skill.

**Memory-presence beacon:** when you see a `💡 qmemd · <repo> — N memories…` line injected
before a Bash command, qmemd is telling you it holds N project/reference facts for this repo
that you have not loaded this session. Treat it as a prompt to `recall` the relevant `tag` (e.g.
`qmemd recall "<repo> build"`) **before** diagnosing — especially build/toolchain errors. The
beacon is throttled (re-fires only on a repo pivot or every ~20 Bash calls) and never blocks the
command. `qmemd tags [--project p]` prints the same overview on demand.
