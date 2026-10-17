---
name: ci
description: Run a project's heavy test gate (the full check, integration and e2e suites) on a fresh Google Cloud spot VM instead of this PC, with dockeriser ci. Use for /dockeriser:ci, or whenever a long, memory-hungry gate (npm run check plus integration and Playwright, a "full CI run", "run CI", "run the gates") would otherwise run locally. Also sets a project up for it (ci init) and shows the month's CI spend (ci status).
---

# dockeriser ci

Run the CLI through the plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"` (called `CLI`
below; it finds the dockeriser folder and runs `npm install` there the first time). If
`${CLAUDE_PLUGIN_ROOT}` was not filled in, use `node "<path>"` with the CLI path from the session-start note.

`CLI ci <dir>` uploads what `git add -A` would commit (ignored files such as `.env` and `node_modules`
never leave), starts an e2e-capable spot VM (4 vCPU, 16 GB, Docker + Compose + the project's Node),
runs the `"ci"` steps of `<dir>/dockeriser.json` in order, streams the log, deletes the VM and records
the cost (about 3 cents for a 45-minute gate). It never uses the free Cloud Build minutes.

## When to use it (and when not)

Run the gate **locally by default**. Use `CLI ci` only when one of these is true:

- **Memory is tight**: this PC has less than about 6 GB free (PowerShell:
  `[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)` gives GB free),
  or other agents are already running builds or test stacks here.
- **The gate's ports are taken**: another stack (another agent's dev services, compose project or e2e
  run) already holds the ports the gate binds, e.g. Postgres, Redis, the API or the web server. Check with
  `Get-NetTCPConnection -State Listen` or `docker ps`. Two stacks on one PC collide, and the gate's
  teardown (`docker compose down --volumes`) can wipe the other one's data.

Otherwise run it locally: it is free and needs no upload.

## 1. Set the project up (once)

If `<dir>/dockeriser.json` has no `"ci"` section, run `CLI ci init <dir> --dry-run` and read the
suggested steps. They come from the repo's GitHub workflow `run:` steps (or package.json). Write it with
`CLI ci init <dir>` only if this repo's rules let you change the repo now (a committed file goes
through that project's own change workflow and PR), then commit it there.

## 2. Run the gate

```
CLI ci <dir> --json
```

Runs take as long as the gate plus about 2 minutes of VM setup: start it with a long timeout or in the
background and wait; do not poll. stdout gets one JSON object:

```jsonc
{
  "status": "SUCCESS",          // FAILURE | TIMEOUT | PREEMPTED | INTERRUPTED | CI_OFF | ERROR
  "exitCode": 0,
  "steps": [{ "index": 1, "command": "npm ci", "exitCode": 0, "durationSec": 41 }],
  "failedStep": null,           // {index, command, exitCode} on failure
  "errorTail": [],              // last log lines on failure
  "logFile": null,              // the full log on failure
  "durationSec": 1830, "costUsd": 0.0199,
  "vm": { "name": "dockeriser-ci-…", "zone": "…", "deleted": "done" },
  "ci": { "line": "CI: $0.41 / $5.00 this month (19 runs)", "spentUsd": 0.41, "disabled": null }
}
```

On FAILURE read `failedStep` and `errorTail` (then `logFile`) and fix the code, the same as a local
failure. Report the gate in a PR as: `dockeriser ci → <status> (<steps passed>/<steps>, <duration>, run <vm.name>)`.

| exit | meaning | what to do |
|---|---|---|
| 0 | every step passed | |
| 1 | a step failed, the gate timed out, or the spot VM was taken back twice | read `failedStep`/`errorTail`; for PREEMPTED, run again |
| 2 | config problem (no `ci` section, not a git checkout, bad machine) | follow `error.fix` |
| 3 | not signed in to Google / gcloud | relay `error.fix`; `/dockeriser:login` |
| 5 | **CI is off this month** (the spend cap) | run the gate locally instead and say so; never try to turn it back on |

## Rules

- **Never run `CLI ci enable`.** It is the owner's override and only the owner runs it. The $5/month
  cap, the day-7 pace check and the runaway stop (a pace past $15 once $1 is spent) are deliberate: when CI is off, fall back to the local gate.
- Use `ci` for the long gates, not for a single quick test.
- `CLI ci status --json` shows this month's spend, whether CI is on, the last runs and any live CI VMs.
- A run that was interrupted leaves no VM for long: the next run deletes leftovers. `CLI ci cleanup`
  does it now (`--force` also deletes running gates, only when asked).
