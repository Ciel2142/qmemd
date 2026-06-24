---
description: Show qmemd store status (counts, index/embed state)
allowed-tools: Bash(qmemd:*)
---
Report qmemd store status.

Use the Bash tool to run `qmemd status` and summarize the JSON for the user —
where the corpus and index live, how many facts are indexed, and whether any
vectors are pending. If the user is diagnosing a problem, also suggest
`qmemd doctor` (frontmatter integrity audit) as a follow-up.
