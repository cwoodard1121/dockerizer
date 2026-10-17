---
name: build
description: Build Docker images on Google Cloud Build with dockeriser and push them to Artifact Registry (one image, or every image in dockeriser.json). Use for /dockeriser:build, or whenever asked to build or push a Docker image.
argument-hint: '[dir] [image]'
---

# /dockeriser:build [dir] [image]

`RUN` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"`. It finds the dockeriser folder and
installs its packages the first time.

Arguments: `$ARGUMENTS`

1. Work out the inputs:
   - `dir`: the first argument, else the current project folder.
   - If `<dir>/dockeriser.json` lists `images`, build those: `RUN build "<dir>" --json`, adding
     `--only a,b` for a subset (a local base image they build FROM is added automatically). Images
     sharing no local base build in parallel (one Cloud Build each); an image's `prebuild` command
     stages its context first. Don't run several builds yourself from the shell.
   - Otherwise, `image` is the second argument, else the folder name in lowercase (letters, digits,
     `-`, `_`, `.`): `RUN build "<dir>" --image <image> --json`.
   - New project with several images, compose files or a ship script: suggest `/dockeriser:init` first.
2. Check sign-in first: `RUN status --offline --json`. If `ready` is false, don't build, and don't fall
   back to local `docker build`. Follow `/dockeriser:setup` instead.
3. Build. The live build log goes to stderr, so show it while it runs: foreground, with a long timeout
   (about 30 minutes). Stdout is one JSON object. `--dry-run` shows what would be uploaded and the
   request, with no network.
4. Summarise from the JSON:
   - Success: each `images[].name@digest` (with `image` = its dockeriser.json name, and its own
     `durationSec`), `durationSec`, `buildMinutes` (an 11 second build is about 0.2 minutes) and
     `usage.line`. Parallel builds add `builds[]`, one result per Cloud Build.
   - A warning that build args "look like secrets": tell the user; build args are visible in the
     Cloud Build console.
   - Failure: `status`, `failedStep` (number, name, command), `failureInfo` (type, detail, hint), the
     `errorTail` lines that show the error, `logFile` (the full log) and `consoleUrl`.
   - `status: "ERROR"`: show `error.message` and `error.fix`. Exit 3 means sign-in; use
     `/dockeriser:setup`.
5. After a build, the images are in Artifact Registry and nothing is pulled to this PC.
   - **Deploying is a separate, explicit step.** Only do it when the user asks, and follow the
     project's own ship rules (AGENTS.md, CLAUDE.md, README). When asked, use `/dockeriser:deploy`, or
     `RUN build "<dir>" --deploy <server> --json` to ship the exact digests just built.
   - To pull by hand on a PC signed in to gcloud: run
     `gcloud auth configure-docker <region>-docker.pkg.dev` once, then `docker pull <address>`.
