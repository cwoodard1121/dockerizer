---
name: usage
description: Show how much of the 2,500 free Cloud Build minutes dockeriser has used this month, the projection to month end, any estimated cost, and Artifact Registry storage. Use when asked about Cloud Build usage, free minutes, build costs or the dockeriser bill.
---

# dockeriser usage

Run the CLI through the plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"` (called `CLI`
below; it finds the dockeriser folder and runs `npm install` there the first time). If
`${CLAUDE_PLUGIN_ROOT}` was not filled in, use `node "<path>"` with the CLI path from the session-start note.

1. Run `CLI usage --json` (add `--month YYYY-MM` if a past month was asked for).
2. If it exits non-zero, show the `error.message` and `error.fix`. For exit code 2 or 3, run
   `CLI login` and relay its steps instead.
3. Otherwise summarise in at most five short lines, plain words:
   - minutes used out of 2,500 and the percent (`minutesUsed`, `percent`), minutes left
   - pace: `minutesPerDay`, projected month-end total (`projectedMinutes`), and `crossDate` if set
   - money: if `overageMinutes` > 0, `costSoFarUsd` so far and `projectedCostUsd` by month end; otherwise say it is free so far
   - storage: `arStorage.sizeBytes` against the 0.5 GB free allowance, with `estMonthlyUsd` if over
4. End with one line: these are estimates for this project only; the free minutes are shared across the
   whole billing account, and the real bill is at `billingUrl`.
