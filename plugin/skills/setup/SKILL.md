---
name: setup
description: Set up dockeriser on Google Cloud from inside Claude Code - pick or create the project in chat, then run the setup script with -Project. Use for /dockeriser:setup, or when dockeriser is not signed in.
argument-hint: '[project-id]'
---

# /dockeriser:setup [project-id]

The setup script can't ask questions from inside Claude Code, so you ask in chat and pass the answer.

Arguments: `$ARGUMENTS`

1. Find the repo folder: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" status --offline --json` and take
   the folder above `bin` in `cliPath`. The
   script is `<repo>\setup\setup.ps1`. The same output says whether `gcloud` is installed and which
   `project` is already saved.
2. If `gcloud.installed` is false: tell the user to type `! winget install Google.CloudSDK`, then close and
   reopen the terminal (and Claude Code) so `gcloud` is found. Stop until they say it's done.
3. Pick the project:
   - A project ID was given as the argument: use it.
   - Otherwise, if `gcloud auth list --filter=status:ACTIVE --format="value(account)"` shows an account,
     list projects with `gcloud projects list --format="value(projectId,name)"` and ask the user in chat which
     one to use, offering the saved `project` first and "create a new project" last.
   - New project: ask for an ID (6-30 characters, lowercase letters, digits and hyphens, starting with a
     letter, e.g. `my-builds-123`). The script creates it.
   - Not signed in to gcloud yet: ask for the project ID (or a new one); the script signs them in first.
4. Tell the user a browser window will open for the Google sign-ins (once or twice), then run in the
   foreground with a long timeout (about 10 minutes):
   `powershell -ExecutionPolicy Bypass -File "<repo>\setup\setup.ps1" -Project <id>`
   If running it yourself is not possible, give them the same command to type with a leading `!`.
5. Each step prints one line (done, skipped, or a problem with what to do). Right after the permissions
   step it may print "waiting for Google to apply the new permissions…" for up to about 3 minutes; that is
   normal. Relay any line marked with a cross and its fix. Common ones: more than one billing account
   (re-run with the `-BillingAccount` it printed) or no billing account (it prints the link to create one).
6. The script ends by running `dockeriser login`. When it says "Signed in as …", suggest
   `/dockeriser:build` on `examples\hello` as a first test.
