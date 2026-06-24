# Issue tracking (beads_rust / br)

This repo tracks work with **br** (beads_rust) — an agent-first issue tracker backed by a
local SQLite database plus a git-tracked JSONL export.

- Database: `.beads/beads.db` — local working copy (not the cross-machine source of truth)
- Export: `.beads/issues.jsonl` — commit this; it is how issues sync via git
- Config: `.beads/config.yaml`, metadata: `.beads/metadata.json`

## Common commands

```bash
br ready                                  # ready (unblocked) work
br create "Title" -t task -p 1 -d "body"  # new issue
br show <id>                              # issue details
br update <id> --claim                    # claim (assignee + status=in_progress)
br close <id>                            # complete
br dep add <id> <depends-on>             # wire a dependency (default type: blocks)
br list                                   # browse
br sync                                   # reconcile the DB with issues.jsonl
```

Run `br --help` for the full command list and `br robot-docs guide` for the agent workflow.
