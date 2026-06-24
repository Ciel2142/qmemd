---
description: Audit qmemd frontmatter integrity after a hand-edit; report mechanical issues (no model load).
---
Run the qmemd frontmatter integrity audit and summarize it for the user:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/hooks/qmemd-shim.sh" doctor $ARGUMENTS
```

Report any fence/type/name/null-byte/platform/link/review_by divergences. Only pass `--fix` (which writes a `.bak` and repairs the mechanical subset) if the user asks.
