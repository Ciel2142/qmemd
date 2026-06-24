---
description: Delete a fact from qmemd memory by slug
argument-hint: <slug>
allowed-tools: Bash(qmemd:*)
---
Forget (delete) a qmemd fact: **$ARGUMENTS**

Use the Bash tool to run `qmemd forget <slug>`. If the exact slug is unknown, run
`qmemd list` or `qmemd recall "<topic>"` first to find it, confirm the right fact
with the user, then delete it.
