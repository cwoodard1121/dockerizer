---
name: dockeriser
description: Use instead of local Docker whenever you would "docker build", "build image", "build a container", "push image", "cloud build", or need a Docker image built and pushed. Runs the build on Google Cloud Build with the dockeriser CLI, streams the log, pushes to Artifact Registry and returns a JSON result with image digests.
---

# Building Docker images with dockeriser

Do not run local `docker build` or `docker push` on this machine. Build with dockeriser, which runs
the build on Google Cloud Build (free tier: 2,500 build-minutes a month) and pushes to Artifact Registry.

Run the CLI through the plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"` (called `CLI`
below; it finds the dockeriser folder and runs `npm install` there the first time). If
`${CLAUDE_PLUGIN_ROOT}` was not filled in, use `node "<path>"` with the CLI path from the session-start note.
`/dockeriser:build` does all of this for one folder.

## 1. Check sign-in first (instant, no network)

```
CLI status --offline --json
```

If `ready` is `false`, do NOT fall back to local docker. First look at `searched`: dockeriser looks in
your real profile even when this account's USERPROFILE/HOME points elsewhere, so "not configured" with
those paths really means nothing is set up (or set DOCKERISER_CONFIG_DIR to the folder that has
config.json). Use `/dockeriser:setup` (asks for the project in
chat, then runs the setup script; a browser opens for Google sign-in). Or tell the user to type, in the
Claude prompt:

```
! powershell -ExecutionPolicy Bypass -File "<repo>\setup\setup.ps1" -Project <id>
```

`<repo>` is the folder above `bin` in the CLI path. Use the project ID from the status output (`project`)
if there is one; otherwise ask the user for their project ID (or tell them to run the command without `-Project`
in their own terminal, where it asks). If `gcloud` is not installed (`gcloud.installed: false`), the first
step is `winget install Google.CloudSDK` and a new terminal. Then stop and wait for them.

## 2. Build

```
CLI build <dir> --image <name>[:<tag>] --json
```

- `<dir>` holds the Dockerfile (or pass `--dockerfile path/relative/to/dir`).
- `--image myapp:1.2` is pushed to `<region>-docker.pkg.dev/<project>/docker-images/myapp:1.2`; `:latest`
  is always pushed too. No tag = short git SHA (clean repo) or a UTC timestamp.
- Other flags: `--tag t` (repeatable), `--build-arg K=V` (repeatable), `--timeout 30m`, `--no-cache`,
  `--dry-run` (print the request, no network).
- With `--json`, the build log streams to stderr and stdout gets exactly one JSON object. Builds take
  minutes; run it with a long timeout (or in the background) rather than polling.
- **Projects with several images** (a `dockeriser.json` with `images`): `CLI build <dir> --json` builds
  them all: images that build FROM another image's `localTag` share one Cloud Build run, in order (the
  FROM works unchanged); the rest build in parallel, one Cloud Build each, still one JSON result
  (`builds[]` lists each). `--only a,b` builds a subset (plus any local base they need);
  `--sequential` uses one run. An image's `"prebuild"` command stages a script-built context first. No dockeriser.json yet: `/dockeriser:init` detects Dockerfiles, compose files and ship scripts
  and writes one. Build args are visible in the Cloud Build console: public values only, never secrets.

## 3. Read the result

```jsonc
{
  "status": "SUCCESS",            // or FAILURE | TIMEOUT | CANCELLED | INTERNAL_ERROR | EXPIRED | ERROR
  "exitCode": 0,
  "buildId": "…",
  "images": [{ "name": "…/myapp:1.2", "digest": "sha256:…", "durationSec": 70 }],
  "durationSec": 74,
  "buildMinutes": 1.23,
  "consoleUrl": "https://console.cloud.google.com/cloud-build/builds;region=…",
  "logFile": null,                // failures: full log saved here
  "failedStep": null,             // failures: {index, id, name, status, args}
  "failureInfo": null,            // failures: {type, detail, hint?}
  "errorTail": [],                // failures: last 50 log lines
  "usage": { "line": "Cloud Build: 0.2 / 2,500 free min this month (0%)", "percent": 0, … },
  "error": { "type": "ConfigError", "message": "…", "fix": "…" }   // only when status is ERROR
}
```

Use `images[].name@digest` when deploying. On failure, read `failedStep`, `failureInfo` and `errorTail`
first; fix the Dockerfile or code and build again. `error.fix` says exactly what to do for setup problems.

| exit code | meaning | what to do |
|---|---|---|
| 0 | success | use the image refs |
| 1 | build failed (or unexpected error) | read errorTail / failedStep, fix, rebuild |
| 2 | config or input problem (no project, bad flag, missing Dockerfile, API off) | follow `error.fix` |
| 3 | credentials or permission problem | give the user the steps from `CLI login` |
| 4 | source upload failed | follow `error.fix` (usually re-run setup) |
| 130 | interrupted; the build was cancelled | rebuild if still needed |

## 4. Getting the image onto a server

The build already pushed the image; nothing is pulled to this PC. Its address is
`images[].name@digest`.

- **Deploy only when the user asks**, following the project's own ship rules (AGENTS.md, CLAUDE.md,
  README). Then use `/dockeriser:deploy` (or `CLI build <dir> --deploy <server> --json` for the exact
  images just built). It streams images over SSH into `docker load` with health checks and rollback;
  `/dockeriser:server` saves servers, `/dockeriser:rollback` and `/dockeriser:logs` follow up.
- On a PC signed in to gcloud: `gcloud auth configure-docker <region>-docker.pkg.dev` once, then
  `docker pull <address>`.

## 5. Heavy test gates go to a VM too

A long gate (full `npm run check`, integration, Playwright e2e) eats this PC's memory for a long time.
When the project's dockeriser.json has a `"ci"` section, run `CLI ci <dir> --json` instead: it runs the
steps on a fresh spot VM and deletes it, about 3 cents a run, without using the free build minutes.
`/dockeriser:ci` has the details. Exit 5 means CI is off for the month (the spend cap): run the gate
locally and never run `ci enable`, which is the owner's override.

## 6. After building

If `usage.percent` is over 80 (or the line says "over by"), tell the user the usage line in one sentence.
`/dockeriser:usage` gives the full picture. Image storage over the free 0.5 GB: the repo keeps the 20
newest versions of each image; `/dockeriser:cleanup` deletes older ones now (only when asked).
