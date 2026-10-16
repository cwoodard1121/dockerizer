---
name: server
description: Save, list and check deploy servers for dockeriser (SSH + Docker checks; optional read-only registry key). Use for /dockeriser:server, or when a deploy needs a server that is not saved yet.
argument-hint: '[add|list|check|remove] [name]'
---

# /dockeriser:server [add|list|check|remove] [name]

`CLI` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"`.

- **list**: `CLI server list --json`. Show the names, hosts, transfer and default key.
- **add**:
  1. Ask the user in chat for the host (`user@ip-or-hostname`, or a `~/.ssh/config` alias), plus a port
     and SSH key path if they aren't the defaults. Look in the project's deploy scripts and docs first,
     but never guess an IP.
  2. Run `CLI server add <name> --host <user@host> [--port N] [--key <path>] --json`. It uses the system
     ssh with key auth only (BatchMode; a new host key is accepted the first time). If no `--key` is
     given, it uses the config `sshKey`, then ssh's defaults and `~/.ssh/config`.
  3. If Docker is missing, it stops and prints the fix. Re-run with `--install-docker` only if the user
     agrees; that runs Docker's get.docker.com script on the server.
  4. `--transfer pull` is optional. It creates a read-only Google service account for the one image
     repo, puts its key on the server (`/etc/dockeriser/puller.json`, mode 600), and runs docker login
     there. The server then downloads only changed layers, which is faster for big or frequent images.
     It uses the user's own gcloud sign-in. The default, `ssh`, needs no setup and puts no secrets on
     the server, but uploads each image through this PC's connection.
  5. If SSH auth fails, relay the fix: `ssh-copy-id`, or paste the `.pub` key into
     `~/.ssh/authorized_keys` (DigitalOcean: Settings > Security > SSH keys).
- **check**: `CLI server check <name> --json`. Explain each failed check and its fix.
- **remove**: `CLI server remove <name>`. This only edits the local config.
