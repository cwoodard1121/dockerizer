---
name: rollback
description: Roll a dockeriser deploy back to the previous image(s) on the server. Use for /dockeriser:rollback, only when the user asks.
argument-hint: '[dir] [server]'
---

# /dockeriser:rollback [dir] [server]

`CLI` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"`. Only roll back when the user asks.

1. Preview: `CLI rollback "<dir>" [--to <server>] --dry-run`.
2. Run: `CLI rollback "<dir>" [--to <server>] --json`. It uses the image IDs dockeriser recorded on the
   server at the last deploy:
   - `run` mode recreates the container on the previous image, with the env file already on the server,
     and health-checks it;
   - `compose` re-tags the previous images and restarts the services;
   - `load-only` re-tags them and runs the `then` command again, if one is set.
3. Summarise `status`, the server, and each item's `imageId`. Rolling back twice goes forward again.
   If it says there is no previous image, nothing was recorded, e.g. because the project was never
   deployed with dockeriser.
