# Agent feedback from shipping appraiseme (0.4.0) — design

Issue: #2 #3 #4 #5 #6 #7 #8 #9 #10 · Date: 2026-10-16 · Status: approved (review waived by the owner)

## Summary

The appraiseme agent shipped a real project through dockeriser 0.3.0 and hit eight generic gaps
that forced manual steps: config not found under a Claude account's `USERPROFILE`, single-image
deploys, no deploy by digest, script-staged contexts, a dirtied checkout, no config-bundle upload,
sequential builds and missing timings. This release closes all eight so a `ship.sh`-style deploy is
one dockeriser command from any account.

## Goals

- Every account (`USERPROFILE=C:\Users\camer\.claude-<account>`) finds the same `~/.dockeriser`,
  including the SessionStart hook and `setup.ps1`; failures list every path searched (#2).
- `deploy --image a --image b` deploys both; `--tag-as` pairs with them; `build` refuses repeats (#3).
- `deploy --image name@sha256:<hex>` deploys that exact image (#4).
- A per-image `prebuild` command stages a context before packaging; the existing same-build
  `FROM <localTag>` support is easy to find (#5).
- A deploy never writes into the repo unless asked (`--save`) (#6).
- `--upload <local>:<remote>` sends folders over SSH before `--then`, and `--keep-env KEY,…` keeps
  those lines of the server's existing `<remote>/.env` (#7).
- Old images are cleaned up: the 20 newest versions of each image are kept, older ones deleted by
  the repo's cleanup policy daily and on demand by `dockeriser cleanup` (#10, owner request).
- Independent images build at the same time on separate Cloud Build machines, one JSON result (#8).
- Deploy JSON has `durationSec`; build JSON has per-image `durationSec`; secret-looking build-arg
  names are warned about (#9).

## Non-goals

- A `"base": <image>` key with digest substitution into `FROM`: same-build `localTag` already
  does this without rewriting Dockerfiles (see Decisions).
- Rolling back uploaded files on a failed deploy.
- A concurrency limit inside one Cloud Build (all steps share one VM).
- appraiseme's own `ship.sh` changes (the appraiseme agent owns those).

## Decisions

The owner said "don't ask my opinion", so each fork was decided here; this table is the record.

| Question | Options | Chosen | Why |
| --- | --- | --- | --- |
| Spec review | wait for approval · proceed | proceed | Owner waived questions and asked for the update when done. |
| Home override variable | `DOCKERISER_HOME` · `DOCKERISER_CONFIG_DIR` · `DOCKERISER_USER_HOME` | `DOCKERISER_CONFIG_DIR` (the `.dockeriser` folder itself) | `DOCKERISER_HOME` already means "the checkout to run"; a folder path parallels `CLOUDSDK_CONFIG`. |
| Home lookup order | env home first · real profile first | override → `os.homedir()` → `os.userInfo().homedir`; first with `.dockeriser/config.json` wins | Respects a deliberately configured override home; falls back to the real profile that setup writes. |
| Where writes go when no config exists anywhere | env home · real profile | real profile (`os.userInfo().homedir`) | All accounts converge on one config. |
| `~` in key paths | env home · resolved home | resolved home | The keys live in the real profile's `.ssh`. |
| Repeated `--image` on build | last wins · error | error (exit 2) | The feedback asked for a loud failure; several images belong in dockeriser.json. |
| `--tag-as` pairing with several `--image` | positional · `name=ref` only | both: `name=ref`, or all bare values in `--image` order when counts match; mixed or mismatched → error | Positional is what the agent typed; mixing is ambiguous. |
| Digest on build | allow · refuse | refuse (unchanged) | The build produces digests. |
| `deploy --build --image a --image b` | error · treat as `--only` | names of dockeriser.json images become `--only`; otherwise error | Builds the asked images and deploys their exact digests. |
| Local base images | `base:` key + FROM rewrite · existing `localTag` + `prebuild` | existing `localTag` + new `prebuild`, plus `init`/docs pointing at it | Same-build FROM already works (one build, one daemon); the agent hit the staged context, not the FROM. |
| `prebuild` scope | project-level · per image | per image, run for selected images only, in order, from the project root, through the platform shell, also on `--dry-run`, output to stderr; non-zero exit stops (exit 2) | `--only web` must not stage app's context; packaging needs the context even in a dry run. |
| Where deploy settings are saved | dockeriser.json · `~/.dockeriser/projects/` · nothing | `~/.dockeriser/projects/<folder>-<8 hex of path>.json` by default; `--save` writes dockeriser.json; `--no-save` neither | Repo stays clean; `--save` keeps the option of committing settings. |
| Precedence of saved settings | per-user over file · file over per-user | flags > dockeriser.json `deploy` > per-user saved | The committed file is the deliberate choice. |
| Upload connections | one per upload · one for all | one SSH connection for all uploads, extracted to a temp dir first, then copied into place | The appraiseme droplet drops a 7th SSH connection inside 30 s. |
| Upload ownership | ssh user · `$S` (sudo when available) | `$S`, like the rest of the remote scripts | Targets like `/opt/app` are root-owned. |
| `--keep-env` semantics | guess · ship.sh's | ship.sh's release pins: before extracting, read `KEY=` lines of the existing `<remote>/.env`; after, drop those keys from the new `.env` and append the kept lines | Matches the script the feature replaces (appraiseme `deploy/ship.sh`, #413). |
| Parallel builds | `waitFor` in one build · one build per dependency group | one build per group, sharing one upload; `--sequential` / `"parallel": false` opts out | Steps of one build share one e2-standard-2 VM; separate builds get their own (default pool allows 10–30 concurrent). |
| Parallel JSON shape | array · object | object as today plus `builds[]` | A bare array breaks every caller of the current shape and `fail()`'s object. |
| Deploy `durationSec` per item | per item · top level | top level, and per item the transfer share is not knowable (one archive, one script) so items get `transferred` as today; `timings` gives check/transfer/upload/script seconds | Honest numbers; one image per deploy gets its time from the top level. |
| Secret-looking build args | refuse · warn | warn once per image, names only | Values like `NEXT_PUBLIC_*` are fine; a heuristic must not block builds. |
| Image retention (#10) | keep 10 (today) · keep 20 | keep 20 newest versions per image, plus the existing "delete anything older than 1 day" rule | Owner: "retain 20 copies of whatever project … then delete". |
| Who deletes | build account (needs repoAdmin) · signed-in gcloud owner | the signed-in gcloud user, through the existing gcloud runner | The build account keeps write-only rights; agents can't delete images with it. |
| Cleanup timing | policy only (runs about daily) · policy + delete now | `dockeriser cleanup` sets the policy and deletes versions beyond N now; `--dry-run` lists only | The owner wants it clear and done, not "within a day". |
| What counts as a version | tags · manifests | manifests (digests), newest by `createTime`; the one tagged `latest` is never deleted | Matches the policy's `mostRecentVersions`. |
| Version | 0.3.1 · 0.4.0 | 0.4.0 (`package.json`, `plugin/package.json`) | New flags and a behaviour change; makes `/plugin update` offer it. |

## Approach

One branch, one PR, one task per issue, in the order #2 → #3/#4 → #6 → #9 → #5 → #7 → #8 so the
account-blocking fix lands first and the largest change (parallel builds) last, in its own function.

- Home: `userHome()` / `homeSearch()` in `config.js`; every `= os.homedir()` default uses it;
  `configDir(homeDir, env)` honours `DOCKERISER_CONFIG_DIR`.
- Deploy images: `OPTIONS.image` becomes `multiple`; `parseDeployImage()` (deploy only) accepts a digest.
- Saved deploy state: `src/project-state.js` (read/write the per-user file); `planDeploy` merges it.
- Upload: `uploadScript()` in `remote.js`, tar stream built with the `tar` package in `deploy.js`.
- Parallel: `buildGroups()` in `project.js` (components of the FROM-dependency graph);
  `runBuild` submits each group with its own tailer and merges summaries.

Beaten: `waitFor` in one build (no real speed-up on 2 vCPUs, risk of OOM with Next.js builds);
a `base:` key (rewrites Dockerfiles for something `localTag` already does).

## Data and contracts

- `~/.dockeriser/projects/<name>-<hash>.json`: `{"root": "<abs path>", "deploy": {<same keys as the dockeriser.json deploy section>}, "savedAt": "<ISO>"}`.
  For deploys of explicit `--image` values the saved section holds `images: {<name>: {tagAs?, services?}}`
  and `imageRefs: ["<repository>[:tag]", …]` so a bare `deploy`/`rollback`/`logs` reproduces it.
- dockeriser.json: images gain `"prebuild": "<command>"`; the top level gains `"parallel": false`;
  `deploy` gains `"upload": ["<local>:<remote>", …]`, `"keepEnv": ["KEY", …]`, `"imageRefs"`.
- Build `--json`: unchanged keys, plus `images[].durationSec` (that image's build step) and, when more
  than one build ran, `builds[]` (each a build summary with `images`) and `parallel: true`;
  top-level `status` = first non-SUCCESS (else SUCCESS), `buildId`/`consoleUrl`/`logFile`/`failedStep`/
  `errorTail` = the first failed build's (else the first build's), `durationSec` = wall clock,
  `buildMinutes` = sum.
- Deploy `--json`: plus `durationSec`, `timings: {checkSec, transferSec, uploadSec, scriptSec}`,
  `uploads: [{from, to, bytes, files, keptEnv}]`, `saved: "project-state"|"dockeriser.json"|null`.
- `status --json`: plus `home` and `searched: [<config.json paths>]`.

## Interfaces

| Name | Method / signature | Caller | Refuses |
| --- | --- | --- | --- |
| `deploy --image` | repeatable; `name[:tag][@sha256:<64 hex>]` | agents, users | malformed digest; several images in run mode |
| `deploy --tag-as` | repeatable; `name=ref` or positional | agents | mixed forms; bare count ≠ image count |
| `deploy --save` / `--no-save` | booleans | users | both together |
| `deploy --upload <local>:<remote>` | repeatable | agents | local missing; remote not absolute |
| `deploy --keep-env KEY,…` | comma list / repeatable | agents | invalid names; no `--upload` |
| `dockeriser cleanup [--keep 20] [--dry-run] [--json]` | command | users, agents | `--keep` < 1; gcloud missing or signed out |
| `build --sequential` | boolean | users | — |
| `build --image` repeated | — | — | always (exit 2) |
| `DOCKERISER_CONFIG_DIR` | env var: the `.dockeriser` folder | users | — |
| `userHome({env, osHome, realHome, exists})` | → string | cli, status, servers, config | — |
| `parseDeployImage(value, cfg)` | → `{name, repository, tag, digest}` | `planDeploy` | non-AR registry, bad digest |
| `buildGroups(images, deps)` | → `Array<images>` | `runBuild` | — |
| `uploadScript({uploads, keepEnv})` | → bash string | `executeDeploy` | — |

## Screens

CLI only. New/changed text:
- `status` when not configured: `configured: no (looked in: <path>, <path>)`.
- Build: `    prebuild app: <command>`; `    building in parallel: base+app, web, proxy (3 builds)`;
  log lines prefixed `[web] ` when several builds run; warning
  `Image "web": build args SECRET_KEY look like secrets; build args are visible in the Cloud Build console.`
- Cleanup: one line per image, `planner-server  7 versions, keeping 7, deleting 0`, then
  `Cleanup policy: keep the 20 newest versions of each image, delete older ones daily.`; the usage
  storage line adds `Old images: dockeriser cleanup keeps the 20 newest of each.` when over the allowance.
- Deploy: `Uploading .local/deploy/bundle → /opt/appraiseme (12 files, 34.1 KB)`;
  `    kept APP_IMAGE, WEB_IMAGE from the server's .env`; save line becomes
  `saved these deploy settings for this folder in <file>; next time just run: dockeriser deploy`.

## Behaviour and edge cases

- Ctrl-C during parallel builds cancels every submitted build.
- Usage cache is updated after all builds finish, one build at a time (no concurrent writes).
- A failed group does not cancel the others; exit 1 if any failed; `--deploy`/`--build` deploy only
  when all succeeded.
- Upload extraction happens in a temp dir; the copy into place happens only after the tar stream
  ends cleanly, so a broken stream changes nothing. `.env` contents are never printed.
- `--keep-env` keys missing on the server are left as the bundle has them.
- Cleanup deletes with `--delete-tags`, never the `latest` version, and reports bytes freed as the
  sum of image sizes (an upper bound: layers are shared).
- Rollback does not touch uploaded files (stated in help and README).

## Testing

Unit tests in `test/` for: home lookup order and searched paths (fake `exists`); repeated `--image`
on build → exit 2; deploy of two `--image` values with positional `--tag-as` and of a digest
(through the fake ssh runner, dry-run script and real-path); per-user save then `rollback` and
`logs` with no flags; `--save` writing dockeriser.json; secret-name warnings; `prebuild` running and
failing; upload script syntax (`bash -n`) and a local run of the keep-env logic with bash; tar stream
contents; build groups; parallel run with two fake builds (merged JSON, prefixed logs, cancel both).
cleanup with a fake gcloud runner (policy JSON written, only versions beyond N deleted, `latest`
kept, dry run deletes nothing).
Gates: `npm test`, the hello `--dry-run`, a real hello build (build.js changed), the PowerShell parser
check of `setup.ps1` and `bash -n setup/setup.sh`.
Owner's check: from an appraiseme agent, `dockeriser status` is ready and `dockeriser deploy` ships
app+web+proxy plus the bundle in one command.

## Release

Local — merge, then `git pull --ff-only` in each account's `plugins/marketplaces/dockerizer` clone
(the CLI agents run); `/plugin update` per account refreshes the skills and hook copies. Then
`dockeriser cleanup` once on the live repo to switch it from 10 to 20.

## Deferred

None.
