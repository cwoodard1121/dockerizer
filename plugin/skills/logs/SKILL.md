---
name: logs
description: Show a deployed container's logs (docker logs or docker compose logs) over SSH with dockeriser. Use for /dockeriser:logs.
argument-hint: '[dir] [server]'
---

# /dockeriser:logs [dir] [server]

`CLI` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"`.

- `CLI logs "<dir>" [--to <server>] [--name <container>] [--tail 200]`. The server, mode, container
  name and compose services come from dockeriser.json. Compose mode shows the services' logs.
- `--follow` streams until stopped. Only use it in the background, or with a short timeout.
- Summarise the errors or warnings that matter instead of pasting long logs.
- `load-only` deploys start no containers. For those, read the project's own docs for where its logs
  are.
