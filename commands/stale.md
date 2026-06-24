---
description: Show qmemd facts due for review plus the never-reviewed backlog
argument-hint: [--limit N]
allowed-tools: Bash(qmemd:*)
---
Show the qmemd staleness review queue.

Use the Bash tool to run `qmemd stale` (pass `--limit` if the user gave one).
Summarize what is due and the never-reviewed backlog. Resolving is manual and
qmemd never auto-expires — for each entry the options are: `qmemd reviewed <slug>`
(re-verified, still correct → resets the clock), `qmemd remember --replace <slug>`
(the fact changed), `--supersedes <slug>` (retire it), or `qmemd forget <slug>`
(drop it). Never mutate without the user's go-ahead.
