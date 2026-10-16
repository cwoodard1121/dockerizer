---
name: status
description: Instant local check of dockeriser (no network) - is it set up, are credentials present, and this month's free build-minute usage line. Use for /dockeriser:status.
---

# /dockeriser:status

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" status --offline --json` (if `${CLAUDE_PLUGIN_ROOT}` was
   not filled in, use `node "C:/Users/camer/Desktop/Projects/dockeriser/bin/dockeriser.js" status --offline --json`).
   It reads local files only and returns in well under a second.
2. Summarise in two or three lines: set up or not (`configured`, with `project` and `region`), credentials
   present or not, and `usageLine` if there is one (it comes from the local cache, updated after every build).
3. If `ready` is false, show the `nextSteps` commands, or offer `/dockeriser:setup`.
4. For a live check against Google, offer `/dockeriser:doctor`; for the full month's numbers, `/dockeriser:usage`.
