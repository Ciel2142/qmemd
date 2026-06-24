---
description: Browse the qmemd corpus by type/tag/project (model-free)
argument-hint: [--type T] [--tag t] [--project p] [--platform P]
allowed-tools: Bash(qmemd:*)
---
List facts in the qmemd corpus: **$ARGUMENTS**

Use the Bash tool to run `qmemd list` with any `--type`, `--tag`, `--project`, or
`--platform` filters the user gave, and present the results. This is model-free
browsing — no semantic search. Use `/qmemd:recall` when the user wants to search by
meaning rather than filter by metadata.
