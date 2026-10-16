---
name: build
description: Build a Docker image on Google Cloud Build with dockeriser and push it to Artifact Registry. Use for /dockeriser:build, or whenever asked to build or push a Docker image.
argument-hint: '[dir] [image]'
---

# /dockeriser:build [dir] [image]

Run the CLI through the plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" <args>` (called
`RUN` below). It finds the dockeriser folder and installs its packages the first time. If
`${CLAUDE_PLUGIN_ROOT}` was not filled in, use `node "C:/Users/camer/Desktop/Projects/dockeriser/bin/dockeriser.js"`.

Arguments: `$ARGUMENTS`

1. Work out the inputs:
   - `dir`: the first argument, else the current project folder (the folder with the Dockerfile).
   - `image`: the second argument, else the folder name in lowercase (letters, digits, `-`, `_`, `.` only).
2. Check sign-in first: `RUN status --offline --json`. If `ready` is false, don't build and don't fall
   back to local `docker build`; follow the `/dockeriser:setup` steps instead.
3. Build: `RUN build "<dir>" --image <image> --json`. The live build log goes to stderr, so show it while
   it runs (run it in the foreground with a long timeout, about 30 minutes). Stdout is one JSON object.
4. Summarise from the JSON:
   - Success: each `images[].name@digest`, `durationSec` and `buildMinutes` (an 11 second build is about
     0.2 minutes), and `usage.line`.
   - Failure: `status`, `failedStep` (number, name, command), `failureInfo` (type, detail, hint), the
     `errorTail` lines that show the error, and `logFile` (the full log) plus `consoleUrl`.
   - `status: "ERROR"`: show `error.message` and `error.fix`. Exit 3 means sign-in; use `/dockeriser:setup`.
5. Getting the image: the build already pushed it, and nothing is pulled to this PC. Its address is
   `images[].name@digest`. On a PC signed in to gcloud (Cameron's MSI already is), run
   `gcloud auth configure-docker northamerica-northeast2-docker.pkg.dev` once, then `docker pull <address>`.
   On a server, the manual way is a service account with only `roles/artifactregistry.reader` on the repo,
   a key copied to the server, then `cat key.json | docker login -u _json_key --password-stdin
   https://northamerica-northeast2-docker.pkg.dev` and `docker pull <address>`. dockeriser does not SSH or
   deploy; running it on a server is a separate step.
