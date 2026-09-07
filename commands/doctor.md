---
description: Audit qmemd frontmatter; repair mechanical issues only when requested
argument-hint: [--fix]
allowed-tools: Bash(qmemd:*)
---
Audit qmemd frontmatter integrity: **$ARGUMENTS**

Run `qmemd doctor` with the Bash tool. Report fence, type, name, null-byte,
platform, link, and `review_by` issues. This audit is read-only and loads no model.
Lenient memory parsing can otherwise silently default or drop malformed fields.

Only pass `--fix` if the user explicitly requests repairs. It repairs issues
marked fixable, including type/folder and name/filename mismatches and null bytes,
writing the original bytes to a sibling `.md.bak` before changing each fact.
Report what was repaired and what remains for manual review; repairs are not
automatically committed.

After approved repairs or hand edits, run `qmemd reindex` to refresh the search
index. `recall` alone does not rescan files.
