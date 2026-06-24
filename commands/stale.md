---
description: List qmemd facts due for review plus the never-reviewed backlog (read-only; no model load).
---
Run the qmemd staleness review queue and summarize it for the user:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/hooks/qmemd-shim.sh" stale $ARGUMENTS
```

Report which facts are **due** and which are **never-reviewed backlog**. Do not modify anything — `stale` only lists; resolve entries with `qmemd reviewed <slug>` / `--replace` / `forget` only if the user asks.
