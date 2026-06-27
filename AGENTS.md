# Agent Instructions

This project uses **br** (beads_rust) for issue tracking. Run `br robot-docs guide` for the agent workflow, command reference, and session-close protocol.

> **Architecture in one line:** issues live in a local SQLite database
> (`.beads/beads.db`); `.beads/issues.jsonl` is the git-tracked export —
> commit it to sync across machines. `br sync` reconciles DB ↔ JSONL.

## Quick Reference

```bash
br ready                # Find available work
br show <id>            # View issue details
br update <id> --claim  # Claim work (assignee + status=in_progress)
br close <id>           # Complete work
br sync                 # Reconcile the SQLite DB with issues.jsonl
```

## Non-Interactive Shell Commands

`cp`/`mv`/`rm` may be aliased to `-i` and hang on a y/n prompt. Always force/batch: `cp -f`, `mv -f`, `rm -f`, `rm -rf`, `cp -rf`; `scp`/`ssh -o BatchMode=yes`; `apt-get -y`; `brew` with `HOMEBREW_NO_AUTO_UPDATE=1`.

## Rules

- Use `br` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Use **qmemd** (`qmemd remember` / `qmemd recall`) for durable knowledge — do NOT use the issue tracker or MEMORY.md files for facts

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
