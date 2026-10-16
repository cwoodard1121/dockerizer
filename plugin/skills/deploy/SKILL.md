---
name: deploy
description: Deploy images built on Cloud Build to a server over SSH with dockeriser (run, compose or load-only), with health checks and automatic rollback. Use for /dockeriser:deploy, ONLY when the user explicitly asks to deploy or ship.
argument-hint: '[dir] [server]'
---

# /dockeriser:deploy [dir] [server]

`CLI` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"`.

**Only deploy when the user asked for it in this conversation.** Follow the project's own ship rules
(AGENTS.md, CLAUDE.md, README) first. Building is always fine; deploying is not automatic.

1. Read `<dir>/dockeriser.json`. Its `deploy` section holds the server, mode and image mapping. If it
   is missing, run `/dockeriser:init` first, or ask the user for the server and mode.
2. Preview what will run on the server: `CLI deploy "<dir>" [--to <server>] --dry-run`. Settings come
   from flags first, then dockeriser.json. The first deploy saves them into dockeriser.json (never the
   .env contents).
3. Deploy:
   - Freshly built, exact digests: `CLI deploy "<dir>" --build --json`.
   - The latest pushed images: `CLI deploy "<dir>" --json`.

   Run in the foreground with a long timeout; progress and server output are on stderr.
   - Modes:
     - `run`: one container (`--name`, `-p 80:3000`, `--env-file .env`, `--health-url`). Still running
       after 10s, plus the health URL answering, or it rolls back by itself.
     - `compose`: `--compose-dir /opt/app --service api,worker --tag-as app:prod`. Waits up to 120s for
       the services to be healthy, else rolls back.
     - `load-only`: `--tag-as name:tag` per image (`--tag-as web=myapp-web:prod`), plus
       `--then "cd /opt/app && bash remote.sh"` for projects with their own remote script.
   - Transfer:
     - `ssh` (default): streams the image through this PC; nothing is set up on the server. Images
       the server already has are skipped.
     - `pull`: the server downloads only changed layers itself (set up with
       `server add --transfer pull`).
4. Summarise the JSON:
   - `status` (SUCCESS / ROLLED_BACK / FAILED), the server, each item's image, digest and
     `transferred`, plus `diskFreeBefore` and `diskFreeAfter` (KB).
   - On failure: the health reason, `logsTail` (the last container log lines), and whether
     `rolledBack` is true.
   - Exit code 3 means SSH auth; relay the fix (add the public key to the server).
5. To go back later: `/dockeriser:rollback`.
