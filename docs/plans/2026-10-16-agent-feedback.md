# Agent feedback 0.4.0 — plan

Issue: #2–#10 · Spec: `docs/specs/2026-10-16-agent-feedback-design.md` · Branch: `feat/agent-feedback-0.4` · Date: 2026-10-16

**Goal:** close the nine gaps from the appraiseme ship and the owner's image-retention request in one release.
**Approach:** one task per issue, in the order #2 → #3/#4 → #6 → #9 → #5 → #7 → #10 → #8, each test-first.
**Release:** Local

## File structure

- Modify: `src/config.js` — `userHome()`, `homeSearch()`, `configDir(homeDir, env)` with `DOCKERISER_CONFIG_DIR`; searched paths in the no-project error.
- Modify: `src/servers.js`, `src/ssh.js`, `src/status.js`, `src/usage.js` — default `homeDir` from `userHome()`; status reports `home` and `searched`.
- Modify: `setup/setup.ps1`, `setup/setup.sh` — config folder from the real profile / `DOCKERISER_CONFIG_DIR`; cleanup keeps 20.
- Modify: `src/image.js` — `parseDeployImage()` accepting `@sha256:<64 hex>`.
- Modify: `src/deploy.js` — several `--image`, positional `--tag-as`, per-user saved state, uploads, timings.
- Create: `src/project-state.js` — read/write `~/.dockeriser/projects/<name>-<hash>.json`.
- Modify: `src/project.js` — `prebuild`, `parallel`, `buildGroups()`, deploy keys `upload`/`keepEnv`/`imageRefs`, `secretLookingArgs()`.
- Modify: `src/remote.js` — `uploadScript()`.
- Create: `src/cleanup.js` — plan and run image cleanup through gcloud.
- Modify: `src/build.js` — `stepDurations()` for per-image `durationSec`.
- Modify: `src/cli.js` — options, help, `cleanup` command, repeated `--image` refusal, prebuild, parallel builds.
- Modify: `src/init.js` — note when a Dockerfile builds FROM another image's local tag.
- Modify: `README.md`, `plugin/skills/{dockeriser,build,deploy,init}/SKILL.md`, new `plugin/skills/cleanup/SKILL.md`, `docs/appraiseme-migration.md`, `docs/RESEARCH.md`.
- Modify: `package.json`, `plugin/package.json` — 0.4.0.
- Tests: `test/home.test.js` (new), `test/deploy.test.js`, `test/project.test.js`, `test/cli.test.js`, `test/build.test.js`, `test/cleanup.test.js` (new), `test/plugin.test.js`.

## Interface checklist

For each of `deploy --image` (repeatable, digest), `deploy --tag-as` (positional), `deploy --save/--no-save`,
`deploy --upload`, `deploy --keep-env`, `build --sequential`, `cleanup`, `DOCKERISER_CONFIG_DIR`, and the
new JSON fields:

- [x] 1) `parseArgs` options in `src/cli.js`
- [x] 2) `--help` text
- [x] 3) README command reference / exit codes / `--json` schema
- [x] 4) `plugin/skills/dockeriser/SKILL.md` (+ deploy/build/init/cleanup skills)
- [x] 5) tests in `test/`

## Tasks

### Task 1: home folder (#2)

Files: `src/config.js`, `src/servers.js`, `src/ssh.js`, `src/status.js`, `src/usage.js`, `src/cli.js`, `setup/setup.ps1`, `setup/setup.sh` · Test `test/home.test.js`

- [x] Tests: `userHome` returns `DOCKERISER_CONFIG_DIR`'s parent semantics via `configDir`; with
  `osHome` lacking config and `realHome` having it, returns `realHome`; with neither, returns `realHome`;
  `os.userInfo()` throwing falls back to `osHome`; `homeSearch` lists both config paths;
  `resolveConfig` no-project error `fix` names every searched path; `getOfflineStatus` exposes `home` + `searched`.
- [x] Red: `node --test test/home.test.js` → FAIL (`userHome` not exported)
- [x] Implement:
  ```js
  export function userHome({ env = process.env, osHome = os.homedir(), realHome = safeRealHome(), exists = fs.existsSync } = {}) {
    const homes = [...new Set([osHome, realHome].filter(Boolean))];
    return homes.find((h) => exists(path.join(h, '.dockeriser', 'config.json'))) || realHome || osHome;
  }
  export function configDir(homeDir = userHome(), env = process.env) {
    return env.DOCKERISER_CONFIG_DIR ? path.resolve(env.DOCKERISER_CONFIG_DIR) : path.join(homeDir, '.dockeriser');
  }
  ```
  setup.ps1: `$ConfigDir = if ($env:DOCKERISER_CONFIG_DIR) { … } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dockeriser' }`; setup.sh: `${DOCKERISER_CONFIG_DIR:-$HOME/.dockeriser}`.
- [x] Green: `npm test` → all pass
- [x] Commit: `fix(config): find ~/.dockeriser in the real profile when USERPROFILE points elsewhere (#2)`

### Task 2: several images and digests on deploy (#3, #4)

Files: `src/image.js`, `src/deploy.js`, `src/cli.js` · Test `test/deploy.test.js`, `test/cli.test.js`

- [x] Tests: `build --image a --image b` → exit 2 "one --image"; `planDeploy` with `image: ['a','b']`,
  `tag-as: ['a:prod','b:prod']`, mode load-only → two items paired in order; mixed `name=ref` + bare → error;
  count mismatch → error; `parseDeployImage('web@sha256:<64>')` → digest set, tag null; `executeDeploy`
  dry-run with a digest item makes no registry call; bad digest → ConfigError; `deploy --build --image a --image b`
  with dockeriser.json images a, b builds `--only a,b`.
- [x] Red → FAIL; implement `OPTIONS.image.multiple = true`, `parseTagAs(values, names)` positional branch,
  `parseDeployImage()`; Green: `npm test` → pass
- [x] Commit: `feat(deploy): several --image values, positional --tag-as, deploy by digest (#3 #4)`

### Task 3: deploy settings outside the repo (#6)

Files: `src/project-state.js`, `src/deploy.js`, `src/cli.js` · Test `test/deploy.test.js`

- [x] Tests: first deploy (fake ssh) writes `~/.dockeriser/projects/<name>-<hash>.json`, not dockeriser.json;
  then `rollback` and `logs` with no flags resolve the same server and items; `--save` writes dockeriser.json;
  `--no-save` writes neither; `--save --no-save` → exit 2; a dockeriser.json deploy section wins over the saved one;
  explicit `--image` deploys save `imageRefs`.
- [x] Implement `stateFile(homeDir, root)`, `readProjectState`, `writeProjectState`; `planDeploy({…, homeDir})`
  merges `d = project.deploy || saved.deploy`; `saveDeploySection(plan, {where})`.
- [x] Commit: `feat(deploy): keep deploy settings per user, --save writes dockeriser.json (#6)`

### Task 4: timings and secret-looking build args (#9)

Files: `src/deploy.js`, `src/build.js`, `src/project.js`, `src/cli.js` · Test `test/deploy.test.js`, `test/build.test.js`, `test/project.test.js`

- [x] Tests: deploy result has numeric `durationSec` and `timings.{checkSec,transferSec,uploadSec,scriptSec}`;
  `stepDurations(build)` maps `build-<name>` step timing to seconds; single-image build gets its `build` step;
  `secretLookingArgs(['API_TOKEN=x','NEXT_PUBLIC_KEY=y','DB_PASSWORD=z'])` → `['API_TOKEN','DB_PASSWORD']`.
- [x] Commit: `feat: deploy durations, per-image build durations, warn on secret-looking build args (#9)`

### Task 5: prebuild and local-base discoverability (#5)

Files: `src/project.js`, `src/cli.js`, `src/init.js`, docs · Test `test/project.test.js`, `test/cli.test.js`

- [x] Tests: `prebuild` must be a non-empty string; `build --dry-run` runs the selected images' prebuild
  (writes a marker file into the context, which then appears in the package); a failing prebuild → exit 2
  naming the image; `--only web` skips app's prebuild; `init` notes a FROM of another image's `localTag`.
- [x] Commit: `feat(build): per-image prebuild command; point at same-build local bases (#5)`

### Task 6: upload and keep-env (#7)

Files: `src/remote.js`, `src/deploy.js`, `src/project.js`, `src/cli.js` · Test `test/deploy.test.js`

- [x] Tests: `parseUpload('C:\\x\\b:/opt/app')` → `{from, to:'/opt/app'}`; relative remote → error;
  missing local → error; `uploadScript` passes `bash -n`; run it locally with bash against a temp
  "remote" dir fed by a real tar stream: files land, `.env` keeps `APP_IMAGE` from the old file and
  drops the bundle's value; broken stream changes nothing; `executeDeploy` uses exactly one extra ssh
  exec for two uploads, before the deploy script, and records `uploads[]`; `--keep-env` without `--upload` → error.
- [x] Commit: `feat(deploy): --upload folders over one SSH connection, --keep-env server lines (#7)`

### Task 7: image cleanup keeps 20 (#10)

Files: `src/cleanup.js`, `src/cli.js`, `src/usage.js`, `setup/*`, `plugin/skills/cleanup/SKILL.md` · Test `test/cleanup.test.js`, `test/plugin.test.js`

- [x] Tests: `planCleanup(versions, 20)` keeps the 20 newest per package and anything tagged `latest`;
  `cleanupPolicy(20)` JSON = keep-20 + delete-older-than-1d; command with a fake gcloud: sets the policy,
  deletes only planned digests with `--delete-tags`, `--dry-run` deletes and sets nothing; gcloud failure → error with fix.
- [x] Commit: `feat: dockeriser cleanup keeps the 20 newest versions of each image (#10)`

### Task 8: parallel builds (#8)

Files: `src/project.js`, `src/cli.js` · Test `test/project.test.js`, `test/cli.test.js`

- [x] Tests: `buildGroups` of base→app, web, proxy → `[[base, app], [web], [proxy]]` in file order;
  `parallel: false` / `--sequential` → one group; CLI run with a fake Cloud Build client: three
  `createBuild` calls sharing one source object, logs prefixed `[web] `, merged JSON has `builds[]`,
  aggregate status FAILURE when one fails, `buildMinutes` summed; SIGINT cancels every build; usage cache
  records all three.
- [x] Commit: `feat(build): build independent images in parallel Cloud Builds (#8)`

### Task 9: docs, version

- [x] README, skills, migration doc, RESEARCH note (waitFor/one VM, 10–30 concurrent builds), 0.4.0.
- [x] Commit: `docs+plugin: 0.4.0 — feedback from the appraiseme ship (#2–#10)`

## Verification

- [x] `npm test` → all pass
- [x] `node bin/dockeriser.js build examples/hello --image hello --project demo-proj --dry-run` → request JSON
- [x] `node bin/dockeriser.js build examples/hello --image hello` (real) → SUCCESS
- [x] `bash -n setup/setup.sh` and the PowerShell parser check of `setup/setup.ps1` → no errors
- [x] `USERPROFILE=C:\Users\camer\.claude-appraiseme node bin/dockeriser.js status --offline` → configured
- [x] `node bin/dockeriser.js cleanup --dry-run` then `cleanup` → policy keeps 20
- [ ] owner's check: an appraiseme agent ships with one `dockeriser deploy`

## Deviations
- Task 6: the code was written before its tests (`test/upload.test.js`, a new file rather than
  `test/deploy.test.js`); the tests then passed first time, so they were checked by breaking the
  keep-env grep by hand once before committing.
