---
name: init
description: Onboard any project to dockeriser - detect its Dockerfiles, compose files and ship scripts, work out the server, write dockeriser.json, and prove it with a first cloud build. Use for /dockeriser:init, or when asked to set up dockeriser (builds or deploys) for a project.
argument-hint: '[dir]'
---

# /dockeriser:init [dir]

`CLI` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"` (it finds dockeriser and installs its
packages the first time). The project folder is the argument, or the current project.

1. **Detect.** Run `CLI init "<dir>" --dry-run --json`. It returns the suggested `config`, `notes`,
   `found` (Dockerfiles, compose files) and `shipScripts`: existing scripts that do
   `docker save | ssh docker load`, with the line and a suggested replacement command.
   If `CLI status --offline --json` says `ready` is false, do `/dockeriser:setup` first.
2. **Read the project's own deploy story.** Read each ship or deploy script it found, plus README,
   AGENTS.md, CLAUDE.md and docs/ sections on deploying. Work out:
   - the server: `user@host`, port, SSH key, and any `~/.ssh/config` Host alias;
   - the remote folder and what runs after the images arrive (migrations, `setup.sh`,
     `docker compose up`);
   - which image names the server expects (`--tag-as`);
   - which build args are public (`NEXT_PUBLIC_*`, `VITE_*`) and where they come from.

   If the host isn't written down (it is often passed as a script argument), **ask the user in chat**.
   Never invent one. Hosts and IPs go only into this project's `dockeriser.json` or the user's saved
   servers, never into dockeriser itself.
3. **Offer to save the server by name.** Check `CLI server list --json` first; the same droplet may
   already be saved. Then:
   `CLI server add <name> --host <user@host> [--port N] [--key <path>]`. It checks SSH and Docker
   only; nothing is installed and no Google key goes on the server. If the user's droplets share one
   key, suggest putting `"sshKey"` in `%USERPROFILE%\.dockeriser\config.json` once.
4. **Write dockeriser.json.** Start from the detected config, then fix it with what you learned:
   - Image names, contexts and Dockerfile paths.
   - `localTag` for a base image that a later Dockerfile builds FROM (both then build in one Cloud
     Build run, so the FROM works unchanged).
   - `prebuild` for an image whose context a script assembles (e.g. `"node scripts/stage.mjs"`), so
     the build does it first instead of a separate manual step.
   - `buildArgsFile` plus `buildArgsFromEnv`, so only public variables are sent.
   - `"source": "git"` if the project builds from tracked files only.
   - The `deploy` section:
     - `server`
     - `mode`: `load-only` plus `then` when the project has its own remote script; `compose` with
       `composeDir`, `services` and `tagAs`; or `run` for a single container.
   Save it with `CLI init "<dir>" --force` and then edit, or write the file directly. Show the user the
   final file. Remind them that build args show up in the Cloud Build console, so never put secrets
   in them.
5. **Prove the build.** Run `CLI build "<dir>" --dry-run` to check what is uploaded, then a real
   `CLI build "<dir>" --json` (foreground, long timeout; the live log is on stderr). Summarise the
   images, digests, minutes and usage line. On failure, read `failedStep` and `errorTail` and fix it.
6. **Do not deploy** unless the user explicitly asks, and then follow the project's own ship rules
   (some repos say "ship only when the owner asks"). For a project that has a ship script, show the
   one line to replace (from `shipScripts`) instead of editing the script, unless asked to.
