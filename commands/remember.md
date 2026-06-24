---
description: Save a durable fact to qmemd memory
argument-hint: <fact> [--type user|feedback|project|reference] [--tags a,b] [--pin] [--ttl 90d]
allowed-tools: Bash(qmemd:*)
---
Store a durable fact in qmemd memory: **$ARGUMENTS**

Use the Bash tool to run `qmemd remember "<fact>"` with an appropriate `--type`:
user preference/identity → `user`; guidance on how to work → `feedback`; a
repo/system fact not in code or git → `project`; a URL/dashboard/discovery →
`reference`. Add any `--tags`, `--pin`, or `--ttl` the user specified.

If qmemd surfaces a near-duplicate or a conflict, show it and ask how to resolve —
`--replace <slug>` (update in place), `--supersedes <slug>` (retire the old fact),
or `--force` (write anyway) — rather than forcing blindly.
