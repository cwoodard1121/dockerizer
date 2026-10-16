---
name: login
description: Walk Cameron through signing dockeriser in to Google Cloud. Setup is one PowerShell command that does the Google sign-in, project, billing and credentials. Use when dockeriser says it is not signed in, when a dockeriser build exits with code 2 or 3, or when asked to set up or log in to dockeriser or Cloud Build.
---

# dockeriser login

Run the CLI through the plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"` (called `CLI`
below; it finds the dockeriser folder and runs `npm install` there the first time). If
`${CLAUDE_PLUGIN_ROOT}` was not filled in, use `node "<path>"` with the path from the session-start note, or
`node "C:/Users/camer/Desktop/Projects/dockeriser/bin/dockeriser.js"`.
The repo folder is the one above `bin` in `cliPath` from `CLI status --offline --json`.

1. Run `CLI login`. It never opens a browser or asks questions; it prints only what is left to do.
2. If it prints "Signed in as …", relay that line and the usage line. Done.
3. Otherwise the step is nearly always the setup script. The easiest route is `/dockeriser:setup`, which
   asks for the project in chat and runs it. Or give Cameron the command it printed, to type in
   the Claude prompt with a leading `!`:

   ```
   ! powershell -ExecutionPolicy Bypass -File "<repo>\setup\setup.ps1" -Project <id>
   ```

   - If `login` printed a real project ID, use it as is.
   - If not, ask him which project ID to use (or say: run it without `-Project` in your own terminal and
     it will list your projects and ask). From the Claude prompt it can't ask questions.
   - It opens the browser for Google sign-in (once or twice); you cannot do that part for him.
   - If `login` says gcloud is missing, the first step is `winget install Google.CloudSDK`, then a new terminal.
   - The script ends by running `dockeriser login` itself. On a first run it may print "waiting for Google
     to apply the new permissions…" for up to about 3 minutes; that is normal.
4. After he says it finished, run `CLI login` again to confirm.
