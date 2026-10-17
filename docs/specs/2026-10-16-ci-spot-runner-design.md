# CI gates on a per-run spot VM, with a spend cap — design

Issue: #13 · Date: 2026-10-16 · Status: approved (the owner approved the whole change up front: "i approve everything")

## Summary

`dockeriser ci` runs a project's heavy gate (appraiseme: `npm run check`, the integration suite and
the Playwright suites) on a fresh Google Cloud spot VM, streams its log back, and deletes the VM.
It replaces long, RAM-hungry runs on the laptop. It also replaces GitHub-hosted CI, which is off on the
private appraiseme repo because those minutes ran out. It never touches the 2,500 free Cloud Build minutes the Docker
builds use. A hard-coded monthly cap turns CI off for every agent when spending, or the pace of
spending, becomes unsustainable.

## Goals

- `dockeriser ci [dir]` runs the `ci.steps` in `<dir>/dockeriser.json` in order on an
  `e2-standard-4` spot VM (4 vCPU, 16 GB) in the configured region, with Docker, Docker Compose and
  the project's Node version installed. It exits 0 when every step passes and 1 at the first failing
  step. The output names that step and the last log lines, and the full log is saved locally.
- The VM is deleted at the end of the run, on Ctrl-C, and on failure. A run that loses the laptop still ends:
  `--max-run-duration` with `DELETE`, and a sweep at the start of every run.
- A run costs about 3¢ (≈ $0.039/h all-in, see Data). The cost of each run is recorded in a shared
  monthly ledger in the logs bucket, so runs from any machine or account count.
- Over **$5.00 spent this month**, or from **day 7** of the month on a pace that projects past
  $5.00, CI is switched off. Every later `dockeriser ci` in that month refuses with exit 5 until the
  month ends. The figure is hard-coded in `src/pricing.js`.
- `dockeriser ci init [dir]` writes a starter `ci` section from the repo's GitHub workflow `run:`
  steps (or `package.json` scripts), for review.
- `dockeriser ci status` shows the month's spend, the cap, on/off and any live CI VMs. The
  SessionStart hook shows a one-line CI summary from a local cache.

## Non-goals

- Downloading test artifacts (Playwright report, traces) from the VM — follow-up issue.
- Secrets or `.env` files on the VM. Only files git would commit are uploaded, and `ci.env` takes public values only.
- Triggering on push or pull request (GitHub Actions). Runs are started by an agent or the owner.
- Machine families other than E2, whose prices are not in `pricing.js`.
- Changing appraiseme. Its agents add the `ci` section through their own workflow.

## Decisions

The owner approved the change up front, so each fork was decided here; this table is the record.

| Question | Options | Chosen | Why |
| --- | --- | --- | --- |
| Where the gate runs | Cloud Build step · GitHub self-hosted runner · per-run GCE spot VM · Hetzner hourly VM | GCE spot VM | Cloud Build spends the free minutes the owner wants for Docker and has 8 GB; a runner needs repo admin (Cameron has push only, owner `savvaputilkin8`); Hetzner is a new account for ~1¢ less per run. |
| Machine | e2-standard-2 · e2-standard-4 · e2-standard-8 | e2-standard-4 default, `ci.machine` overrides (E2 only) | 16 GB holds Postgres + GoTrue + Redis + Mailpit + Chromium; $0.0307/h. |
| Spend cap figure | $2 · $5 · $10 per month | $5 | Same as the budget alert setup already creates (`setup.ps1 -Budget 5`), ≈ 160 full gates/month; a loop, not real use, gets there. |
| "After a date" | none · pace check from a set day | pace check from day 7: `spent × daysInMonth ÷ dayOfMonth > $5` → off | A burst in the first days projects wildly; a week of data is a real pace. |
| Who may turn it back on | nobody · owner command | `dockeriser ci enable` (owner only; the skill tells agents never to run it) skips the pace check for the rest of the month; the $5 hard stop has no override | The owner asked for a hard-coded ceiling. |
| Ledger location | local file · GCS object per month | `gs://<project>-dockeriser-logs/ci/ledger-YYYY-MM.json`, written with a generation precondition, mirrored to `~/.dockeriser/ci-cache.json` | Agents on other PCs count too; the logs bucket's 30-day auto-delete only drops a month that has had no runs for 30 days. |
| VM identity and cleanup | grant the service account compute admin so the VM deletes itself · laptop deletes | VM created and deleted with the signed-in gcloud account (as `cleanup` and `server add` do); VM runs as the `dockeriser` service account (already allowed to read the source bucket and write the logs bucket); no new roles | Least privilege. A VM that the laptop loses stops itself (disk only, $0.006/h) and is deleted by the next run's sweep; a runaway is deleted by `--max-run-duration`. |
| Log transport | serial port · GCS object | VM appends to a log and uploads it every 10 s to `log-<runId>.txt` in the logs bucket; the laptop reads it with the existing `LogTailer` | A serial port can slow a chatty e2e run; the object is also kept 30 days as evidence. |
| What is uploaded | tracked files · tracked + untracked-not-ignored | `git ls-files --cached --others --exclude-standard` (what `git add -A` would commit), minus files deleted on disk | An agent's new untracked file must be tested; ignored `.env`/`node_modules` never leave. |
| Preemption | fail · retry once | retry once on a new VM, both runs in the ledger | Preemption is not the code's fault. |
| Concurrency | unlimited · cap | at most 4 CI VMs at once (16 of the region's 24 E2 CPUs); a fifth run waits for a slot, up to 20 min | Parallel agents should queue, not fail. |
| Exit code when CI is off | 2 · new 5 | 5 (`EXIT.CI_OFF`) | Agents can tell "off" from a broken config. |
| `ci init` source | GitHub workflow `run:` steps · package.json scripts | workflows first (in order, `if: failure()/always()/cancelled()` steps skipped, exact repeats dropped), else `npm ci` + `check`/`test` scripts | appraiseme's `ci.yml` is exactly its gate. |
| OS and toolchain | Container-Optimised OS · Ubuntu 24.04 | Ubuntu 24.04 (`ubuntu-2404-lts-amd64`), Docker + Compose from Ubuntu's packages, Node from nodejs.org | COS has no Node and a read-only root; Ubuntu packages avoid `curl | sh`. |

## Approach

Approaches considered:
- **Chosen: per-run spot VM driven by dockeriser.** It costs about 3¢ per run, uses only the
  existing project and gcloud sign-in, and keeps the free minutes for Docker builds.
- Rejected: a Cloud Build step. It costs the same per minute, uses the free minutes and has half the RAM.
- Rejected: a long-lived VM registered as a GitHub runner. It needs repo admin and costs money
  while idle.

## Data and contracts

Prices, from the Cloud Billing catalogue (service `6F81-5844-456A`), effective 2026-10-16, Toronto:

| SKU | Price |
| --- | --- |
| Spot E2 core | $0.005 / vCPU-hour |
| Spot E2 RAM | $0.000668 / GiB-hour |
| Balanced persistent disk | $0.11 / GiB-month (≈ $0.000151 / GiB-hour) |
| External IPv4 on a spot VM | $0.0025 / hour |

e2-standard-4 + 40 GiB balanced disk + IP ≈ $0.0307 + $0.0060 + $0.0025 = **$0.0392 / hour**.
Other E2 shapes are priced from vCPU and GiB (`e2-standard-N`: N vCPU, 4N GiB; `highmem`: 8N;
`highcpu`: N). Other regions use the Toronto prices and the output says the cost is an estimate.

`dockeriser.json`:

```json
{
  "ci": {
    "steps": ["npm ci", "npm run check", "npm run dev:services", "npm run test:e2e"],
    "machine": "e2-standard-4",
    "diskGb": 40,
    "timeout": "60m",
    "node": "24.14.0",
    "env": { "SOME_PUBLIC_FLAG": "1" },
    "docker": true
  }
}
```

`steps` is required, with 1 to 50 non-empty strings. The other keys are optional, with the defaults shown. `node` falls back to
`.node-version`, then `.nvmrc`, then the latest LTS. `env` names must match `^[A-Z_][A-Z0-9_]*$`.
Names that look like secrets get a warning, and `CI=true` is always set.

Ledger object `ci/ledger-YYYY-MM.json`:

```json
{ "month": "2026-10", "capUsd": 5, "override": false, "disabled": null,
  "runs": [{ "id": "ci-20261016-231500-ab12", "startedAt": "…", "endedAt": "…", "machine": "e2-standard-4",
             "zone": "northamerica-northeast2-a", "status": "SUCCESS", "exitCode": 0,
             "durationSec": 1830, "costUsd": 0.0212, "by": "cameronwoodard1121@gmail.com", "dir": "appraiseme" }] }
```

`disabled` is `{ "at": ISO, "reason": "…" }` once the cap or the pace check trips.

The VM log ends with `::dockeriser-ci-result exit=<n> step=<k>` and then `DONE` (exit 0) or
`ERROR` (anything else). Each step is bracketed by `::step <k>/<n> $ <command>` and
`::step-end <k> rc=<n> <s>s`.

## Interfaces

| Name | Method / signature | Caller | Refuses |
| --- | --- | --- | --- |
| `dockeriser ci [dir]` | `--machine`, `--zone`, `--timeout`, `--no-retry`, `--dry-run`, `--json`, `--project/--region` | agents, owner | no `ci` section (2); not a git checkout (2); non-E2 machine (2); CI off (5); no gcloud sign-in (3) |
| `dockeriser ci init [dir]` | `--force`, `--dry-run`, `--json` | agents, owner | existing `ci` section without `--force` (prints, writes nothing) |
| `dockeriser ci status` | `--json` | agents, owner, hook (offline cache only) | — |
| `dockeriser ci enable` | — | owner only | over the $5 hard stop |
| `dockeriser ci cleanup` | `--json` | owner, agents | — |
| `EXIT.CI_OFF` | `5` | callers | — |
| JSON result of `ci` | `{status: SUCCESS\|FAILURE\|PREEMPTED\|TIMEOUT\|CI_OFF\|INTERRUPTED\|DRY_RUN, exitCode, runId, vm, durationSec, costUsd, steps[], failedStep, errorTail[], logFile, logObject, ci: {spentUsd, capUsd, runs, disabled, line}}` | agents | — |

## Screens

CLI (stderr in human mode):

```
==> Packaging C:\…\appraiseme (1234 files, 5.1 MB, what `git add -A` would commit)
==> Uploading source to gs://freebuilds-dockeriser-src/ci/20261016-231500-ab12cd34.tgz
==> Starting spot VM dockeriser-ci-20261016-231500-ab12 (e2-standard-4, northamerica-northeast2-a)
    <live log>
✔ CI passed in 31m 05s (8 steps) · ≈ $0.022 · VM deleted
CI: $0.41 / $5.00 this month (19 runs)
```

The failure block shows `CI FAILED at step 5/8: npm run test:integration (exit 1)`, the last 40 log
lines and the local log path. When CI is off: `CI is off for October 2026: <reason>. It turns back
on at the start of next month.` (exit 5). Hook line: `CI: $0.41 / $5.00 this month (19 runs); run heavy gates with dockeriser ci <dir>` or
`CI is OFF this month (<reason>)`.

## Behaviour and edge cases

- Before a run: sweep stray CI VMs (labelled `dockeriser-ci`) that are stopped, or older than their
  limit plus 10 min. Read the ledger and apply the cap and pace check (persisting `disabled` if one trips).
  Then wait for a slot (fewer than 4 live CI VMs).
- Zone fallback: try the region's zones in order when one has no spot capacity.
- The VM runs the steps as a `ci` user with passwordless sudo and the docker group, in `/home/ci/src`,
  under `timeout <timeout>`. Then it uploads the final log and powers off. `--max-run-duration` =
  timeout + 15 min with termination action `DELETE`.
- The laptop polls the log every 3 s and the VM status every 15 s. Missing or stopped without a result
  line means PREEMPTED: retry once unless `--no-retry`, recording both runs.
- Ctrl-C deletes the VM and records the run (exit 130). A second Ctrl-C quits without waiting for the delete;
  the next sweep removes it.
- Cost = (VM deletion requested, or found gone) − (create returned), × hourly rate. It is an estimate, and
  the real bill is on the Billing page.
- Ledger writes use `ifGenerationMatch`, with up to 5 retries on 412, so parallel runs never lose an entry.
- Nothing in the uploaded source is changed; nothing is written into the repo except by `ci init`.

## Testing

- Unit: `ci` section validation; machine pricing and run cost; cap and pace evaluation (day 6 vs day 7,
  override, hard stop); workflow `run:` parsing on appraiseme's `ci.yml`; source file list (untracked
  included, ignored and deleted files excluded); the startup script passes `bash -n` and embeds every step.
- CLI with fake gcloud and fake storage: SUCCESS path (create → log with result → delete → ledger
  written); FAILURE names the step; CI off refuses with exit 5 and creates no VM; PREEMPTED retries once;
  `--dry-run` makes no calls.
- Real: `examples/ci-hello` on a VM (Docker and Node work, VM gone, ledger entry), then appraiseme's
  full gate from a fresh clone in a scratch folder.
- Owner's success check: one appraiseme gate runs on a VM, costs under 5¢, leaves no VM behind, and
  the session hook shows the spend.

## Release

`Cloud setup`: the setup scripts now turn on `compute.googleapis.com` (already turned on in
`freebuilds` on 2026-10-16). The plugin goes to 0.5.0. After merge: pull the marketplace clone and tell
agents on the bus to `/plugin update` and use `dockeriser ci`.

## Deferred

- Download Playwright reports and traces from a failed run (issue to file).
- Pull-request status checks from a run (would need the repo owner's GitHub permissions).
