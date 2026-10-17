# CI gates on a per-run spot VM — plan

Issue: #13 · Spec: `docs/specs/2026-10-16-ci-spot-runner-design.md` · Branch: `feat/ci-spot-runner` · Date: 2026-10-16

**Goal:** `dockeriser ci` runs a project's heavy gate on a per-run spot VM, with a hard-coded $5/month cap that turns CI off.
**Approach:** Package what `git add -A` would commit, upload it to the source bucket, then create an
Ubuntu spot VM with gcloud whose startup script installs Docker and Node, runs `ci.steps`, and
uploads its log to the logs bucket. The laptop tails that log with `LogTailer`, deletes the VM, and records
the cost in a monthly ledger object that gates every later run.
**Release:** Cloud setup (setup turns on `compute.googleapis.com`), plugin 0.5.0

## File structure

- Create: `src/ci-config.js` — the `ci` section: validation, defaults, machine shape and price, Node version.
- Create: `src/ci-ledger.js` — monthly ledger in GCS (read and write with a generation precondition), cap and pace check, local cache, CI line.
- Create: `src/ci-vm.js` — source file list, run ids and VM names, the startup script, gcloud create/describe/delete/list/sweep, log marker parsing.
- Create: `src/ci-init.js` — `ci init`: GitHub workflow `run:` steps or package.json scripts → `ci` section.
- Create: `src/ci.js` — the `ci` command: run, status, enable, cleanup, init; output and JSON result.
- Modify: `src/cli.js` — `ci` handler, flags `--machine --zone --no-retry`, `--timeout` default moved into build, USAGE.
- Modify: `src/errors.js` — `EXIT.CI_OFF = 5`.
- Modify: `src/pricing.js` — spot E2, disk and IP prices; `CI_MONTHLY_CAP_USD`, `CI_PACE_FROM_DAY`.
- Modify: `src/package-source.js` — export `packageFiles(root, files, opts)`.
- Modify: `src/status.js` — offline status carries `ci` from the cache.
- Modify: `plugin/hooks/session-start.js` — CI line.
- Create: `plugin/skills/ci/SKILL.md` — `/dockeriser:ci`.
- Modify: `plugin/skills/dockeriser/SKILL.md` — when to use `ci`, never `ci enable`.
- Modify: `setup/setup.ps1`, `setup/setup.sh` — add `compute.googleapis.com`.
- Modify: `README.md`, `docs/RESEARCH.md` — the `ci` reference, prices with source and date.
- Create: `examples/ci-hello/` — smallest real run (a dockeriser.json with a `ci` section and a tiny script).
- Modify: `package.json`, `package-lock.json`, `plugin/.claude-plugin/plugin.json` — 0.5.0.
- Test: `test/ci-config.test.js`, `test/ci-ledger.test.js`, `test/ci-vm.test.js`, `test/ci-init.test.js`, `test/ci-cli.test.js`, `test/plugin.test.js`.

## Interface checklist

`dockeriser ci [dir] | ci init | ci status | ci enable | ci cleanup`, `EXIT.CI_OFF`:

- [x] 1) `parseArgs` options in `src/cli.js` (`machine`, `zone`, `no-retry`; `timeout` default removed from OPTIONS)
- [x] 2) `--help` text
- [x] 3) README command reference, exit code 5, `ci` JSON result
- [x] 4) `plugin/skills/ci/SKILL.md` and `plugin/skills/dockeriser/SKILL.md`
- [x] 5) tests in `test/`

## Tasks

### Task 1: ci section, machine prices, run cost

Files: Create `src/ci-config.js` · Modify `src/pricing.js` · Test `test/ci-config.test.js`

- [x] Failing tests: `normaliseCi` rejects a missing or empty `steps` list, a non-E2 machine, and a bad
  env name, and applies the defaults (`e2-standard-4`, 40, `60m`, `docker: true`). `machineShape('e2-standard-4')`
  is `{vcpu: 4, ramGib: 16}`. `hourlyUsd('e2-standard-4', 40)` ≈ 0.0392. `runCostUsd(1800, …)` ≈ 0.0196.
  `nodeVersion(dir, ci)` reads `ci.node`, then `.node-version`, then `.nvmrc`, then `lts`.
- [x] `node --test test/ci-config.test.js` → FAIL: cannot find module `../src/ci-config.js`
- [x] Implement it, with the prices as constants in `pricing.js` (catalogue date 2026-10-16).
- [x] `node --test test/ci-config.test.js` → pass
- [x] Commit: `feat(ci): ci section, E2 spot prices and run cost (#13)`, push

### Task 2: ledger, cap and pace check

Files: Create `src/ci-ledger.js` · Test `test/ci-ledger.test.js`

- [x] Failing tests:
  - `evaluateCap`: spent ≥ $5 → off on any day.
  - $1.50 on day 6 → on; $1.50 on day 7 of a 31-day month (projects $6.64) → off.
  - `override` skips the pace check but not the hard stop.
  - `recordRun` retries on 412 and keeps both runs when two writers race.
  - `readLedger` of a missing object → an empty ledger for the month.
  - `ciLine` text, on and off.
- [x] `node --test test/ci-ledger.test.js` → FAIL: module missing
- [x] Implement: JSON API through `storage.authClient.request` (GET `alt=json` for the generation,
  then GET `alt=media&generation=`; POST upload with `ifGenerationMatch`, 0 for a new object). Cache at
  `~/.dockeriser/ci-cache.json`.
- [x] Green, commit: `feat(ci): monthly ledger with a $5 cap and a day-7 pace check (#13)`, push

### Task 3: source list, startup script, VM control

Files: Create `src/ci-vm.js` · Modify `src/package-source.js` · Test `test/ci-vm.test.js`

- [x] Failing tests:
  - `ciSourceFiles` in a temp git repo includes an untracked file and leaves out an ignored one and a deleted tracked one.
  - `startupScript` passes `bash -n` (skipped when bash is missing) and embeds every step (base64), the bucket names, `CI=true` and `shutdown`.
  - `createArgs` has `--provisioning-model=SPOT`, `--instance-termination-action=DELETE`, `--max-run-duration=4500s` for a 60m timeout, and the labels.
  - `createVm` falls back to the next zone on `ZONE_RESOURCE_POOL_EXHAUSTED`.
  - `parseResult` and `parseSteps` read the markers.
  - `sweep` deletes stopped and over-age VMs only.
- [x] `node --test test/ci-vm.test.js` → FAIL
- [x] Implement. Export `packageFiles(root, files, {tmpDir, warn})` from `package-source.js` (wraps `writeTarball`).
- [x] Green, commit: `feat(ci): VM startup script, source list and gcloud control (#13)`, push

### Task 4: `ci init`

Files: Create `src/ci-init.js` · Test `test/ci-init.test.js`

- [x] Failing test: appraiseme's `ci.yml` (copied as a fixture string) gives the steps `npm ci`,
  `npm run check`, `npm run dev:services`, `npm run db:reset:test`, `npm run db:types:check`,
  `npm run test:integration`, `npx playwright install --with-deps chromium` and `npm run test:e2e`, with
  the `if: failure()` diagnostics and `if: always()` teardown skipped. With no workflows and a package.json
  that has a `check` script, the steps are `npm ci` and `npm run check`. An existing `ci` section without `--force` is not overwritten.
- [x] Red, implement, green. Commit: `feat(ci): ci init from GitHub workflow steps (#13)`, push

### Task 5: the `ci` command

Files: Create `src/ci.js` · Modify `src/cli.js`, `src/errors.js` · Test `test/ci-cli.test.js`

- [x] Failing tests drive `run(['ci', dir, '--json'], deps)` with a fake `gcloud` (create, describe, delete, list) and a fake storage:
  - SUCCESS: exit 0, VM deleted, ledger has one run.
  - FAILURE: exit 1 and `failedStep.command` is set.
  - A disabled ledger: exit 5 and no create call.
  - Missing log, then the VM gone: PREEMPTED, retried once.
  - `--dry-run`: no gcloud calls, and the result has `script` and `createArgs`.
- [x] Red, implement, green; `npm test` all pass.
- [x] Commit: `feat(ci): dockeriser ci runs a gate on a spot VM (#13)`, push

### Task 6: plugin, hook, setup, docs, version

Files: Modify `src/status.js`, `plugin/hooks/session-start.js`, `plugin/skills/dockeriser/SKILL.md`,
`setup/setup.ps1`, `setup/setup.sh`, `README.md`, `docs/RESEARCH.md`, versions · Create
`plugin/skills/ci/SKILL.md`, `examples/ci-hello/*` · Test `test/plugin.test.js`

- [x] Failing test: `ci` is in the slash-command list in `plugin.test.js`, and `buildContext` includes the CI line when the cache exists.
- [x] Implement, `npm test` green, then `bash -n setup/setup.sh` and the PowerShell parser check of `setup/setup.ps1`.
- [x] Commit: `docs+plugin: 0.5.0 — dockeriser ci (#13)`, push

## Verification

- [x] `npm test` → all pass
- [x] `bash -n setup/setup.sh` and `[System.Management.Automation.Language.Parser]::ParseFile` on `setup/setup.ps1` → no errors
- [x] `node bin/dockeriser.js build examples/hello --image hello --project demo-proj --dry-run` → unchanged request (the `--timeout` default moved)
- [x] Real: `node bin/dockeriser.js ci examples/ci-hello` → SUCCESS, VM gone (`gcloud compute instances list`), ledger entry
- [ ] Real: appraiseme's full gate from a fresh clone in the scratchpad → result, duration and cost recorded
- [ ] Owner's success check: an appraiseme gate on a VM, under 5¢, no VM left, hook shows the spend

## Deviations

- Task 5 planned `deleteVm(wait: false)` (gcloud `--async`) and a describe 10 s later. The first real
  run showed gcloud 589's `compute instances delete` has no `--async` (the fake gcloud in the tests
  did not check flags), so the VM was left behind and deleted by hand. The delete is now synchronous
  (22 s measured), and the CLI test pins the exact delete arguments and rejects `--async`.
- Added CLI tests for `ci status`, `ci enable` (lifts a pace stop, refuses the hard stop) and `ci cleanup` (`--force`), which the plan had not listed.
