---
description: Audit qmemd frontmatter integrity after a hand-edit (mechanical issues; no model load)
argument-hint: [--fix]
allowed-tools: Bash(qmemd:*)
---
Audit qmemd frontmatter integrity: **$ARGUMENTS**

Use the Bash tool to run `qmemd doctor`. Report any fence/type/name/null-byte/
platform/link/review_by divergences. Only pass `--fix` (which writes a `.bak` and
repairs the mechanical subset) if the user explicitly asks — `doctor` is read-only
otherwise.
