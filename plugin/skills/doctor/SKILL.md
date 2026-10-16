---
name: doctor
description: Check every part of the dockeriser Google Cloud setup online and explain any failure with its fix. Use for /dockeriser:doctor, or when builds fail with setup or permission errors.
---

# /dockeriser:doctor

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" doctor --json`.
2. `ok: true`: say everything is in place in one line (project, region, signed-in account).
3. Otherwise, for each check with `status: "fail"`, give its name, what is wrong (`detail`) and the fix
   (`fix`) in plain words. Checks marked `skip` only ran because an earlier one failed; don't list them.
   `warn` checks are worth one short line.
4. Most fixes are "re-run the setup script"; offer `/dockeriser:setup`. Right after a fresh setup, a
   failed "Google sign-in" usually clears by itself within a few minutes while Google applies the new
   permissions, so suggest trying again shortly before anything else.
