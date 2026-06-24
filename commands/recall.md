---
description: Recall durable facts from qmemd memory (semantic + lexical search)
argument-hint: <query> [--lex] [--type user|feedback|project|reference] [--limit N] [--cross-project]
allowed-tools: Bash(qmemd:*)
---
Recall durable facts from qmemd memory matching the user's request: **$ARGUMENTS**

Use the Bash tool to run `qmemd recall` with the free-text query quoted, passing
through any flags the user included verbatim (`--lex`, `--type`, `--limit`,
`--cross-project`, `--min-score`, `--full`). Present the matching facts concisely.
If nothing matches, say so and suggest broadening the query or adding
`--cross-project` to search beyond the current project.
