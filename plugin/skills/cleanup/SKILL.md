---
name: cleanup
description: Delete old images from dockeriser's Artifact Registry repo, keeping the 20 newest versions of each image (or --keep N), and set the repo's daily cleanup policy to match. Use when asked to clean up old builds or images, free registry storage, or when usage says storage is over the free 0.5 GB.
---

# dockeriser cleanup

Run the CLI through the plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js"` (called `CLI`
below; it finds the dockeriser folder and runs `npm install` there the first time). If
`${CLAUDE_PLUGIN_ROOT}` was not filled in, use `node "<path>"` with the CLI path from the session-start note.

Deleting images cannot be undone, so look first:

1. Run `CLI cleanup --dry-run --json` (add `--keep N` if the user named a number; the default is 20).
2. Tell the user per image how many versions there are and how many would be deleted (`images[]`,
   `wouldDelete`). If `wouldDelete` is 0, say nothing needs deleting and stop, unless the cleanup
   policy should still be set (then go on).
3. Only when the user asked to delete (or confirms now), run `CLI cleanup --json` with the same `--keep`.
   Report `deleted` and that the repo now keeps the N newest versions of each image and Artifact
   Registry deletes older ones about once a day. `bytesFreedUpTo` is an upper bound (layers are shared).
4. On a non-zero exit show `error.message` and `error.fix`. It runs gcloud as the signed-in user, so a
   permission error means: sign in as the project owner with `gcloud auth login`.

Never delete images to "make room" without the user asking. Servers keep their own copies, so a
deploy's rollback still works after cleanup.
