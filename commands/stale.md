---
description: Show qmemd facts due for review plus the never-reviewed backlog
argument-hint: [--limit N]
allowed-tools: Bash(qmemd:*)
---
Show the qmemd review queue: **$ARGUMENTS**

Run `qmemd stale` with the Bash tool, passing `--limit` if supplied. Summarize
facts due for review and the never-reviewed backlog. This command is read-only
and loads no model. A review date is not an expiry date: overdue facts are not
automatically hidden or deleted.

Resolve entries only with the user's approval:
- Re-verified and unchanged: `qmemd reviewed <slug>` sets `review_by` using the
  type's default policy: today plus its review window, or `never` for a durable
  default. It leaves `updated` unchanged. Use `--ttl <N>d|w|m|y`
  or `--review-by YYYY-MM-DD` for a specific next review; `--ttl never` marks the
  fact permanently durable. The MCP equivalent is `reviewed`.
- Changed: `qmemd remember "<corrected fact>" --replace <slug>`. Supply a fresh
  `--ttl` or `--review-by` when the next review date should change.
- Superseded: `qmemd remember "<successor fact>" --supersedes <slug>` retires the
  old fact under its successor.
- No longer worth keeping: `qmemd forget <slug>` deletes it.
