---
name: dockeriser
description: Use instead of local Docker whenever you would "docker build", "build image", "build a container", "push image", "cloud build", or need a Docker image built and pushed. Runs the build on Google Cloud Build with the dockeriser CLI, streams the log, pushes to Artifact Registry and returns a JSON result with image digests.
---

# Building Docker images with dockeriser

Do not run local `docker build` or `docker push` on this machine. Build with dockeriser, which runs
the build on Google Cloud Build (free tier: 2,500 build-minutes a month) and pushes to Artifact Registry.

The CLI path is in the session-start note ("node \"<path>\" build ..."). If there is no note, use
`C:/Users/camer/Desktop/Projects/dockeriser/bin/dockeriser.js`. Below, `CLI` means that path.

## 1. Check sign-in first (instant, no network)

```
node CLI status --offline --json
```

If `ready` is `false`, do NOT fall back to local docker. Setup is one command, which he runs himself
because it opens the browser for Google sign-in. Tell Cameron to type, in the Claude prompt:

```
! powershell -ExecutionPolicy Bypass -File "<repo>\setup\setup.ps1" -Project <id>
```

`<repo>` is the folder above `bin` in the CLI path. Use the project ID from the status output (`project`)
if there is one; otherwise ask him for his project ID (or tell him to run the command without `-Project`
in his own terminal, where it asks). If `gcloud` is not installed (`gcloud.installed: false`), the first
step is `winget install Google.CloudSDK` and a new terminal. Then stop and wait for him.

## 2. Build

```
node CLI build <dir> --image <name>[:<tag>] --json
```

- `<dir>` holds the Dockerfile (or pass `--dockerfile path/relative/to/dir`).
- `--image myapp:1.2` is pushed to `<region>-docker.pkg.dev/<project>/docker-images/myapp:1.2`; `:latest`
  is always pushed too. No tag = short git SHA (clean repo) or a UTC timestamp.
- Other flags: `--tag t` (repeatable), `--build-arg K=V` (repeatable), `--timeout 30m`, `--no-cache`,
  `--dry-run` (print the request, no network).
- With `--json`, the build log streams to stderr and stdout gets exactly one JSON object. Builds take
  minutes; run it with a long timeout (or in the background) rather than polling.

## 3. Read the result

```jsonc
{
  "status": "SUCCESS",            // or FAILURE | TIMEOUT | CANCELLED | INTERNAL_ERROR | EXPIRED | ERROR
  "exitCode": 0,
  "buildId": "…",
  "images": [{ "name": "…/myapp:1.2", "digest": "sha256:…" }],
  "durationSec": 74,
  "buildMinutes": 1.23,
  "consoleUrl": "https://console.cloud.google.com/cloud-build/builds;region=…",
  "logFile": null,                // failures: full log saved here
  "failedStep": null,             // failures: {index, id, name, status, args}
  "failureInfo": null,            // failures: {type, detail, hint?}
  "errorTail": [],                // failures: last 50 log lines
  "usage": { "line": "Cloud Build: 312 / 2,500 free min this month (12%)", "percent": 12.5, … },
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
| 3 | credentials or permission problem | give Cameron the steps from `node CLI login` |
| 4 | source upload failed | follow `error.fix` (usually re-run setup) |
| 130 | interrupted; the build was cancelled | rebuild if still needed |

## 4. After building

If `usage.percent` is over 80 (or the line says "over by"), tell Cameron the usage line in one sentence.
`/dockeriser:usage` gives the full picture.
