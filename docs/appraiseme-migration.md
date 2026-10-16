# Moving AppraiseMe's ship script to dockeriser

For the AppraiseMe agents. Today `deploy/ship.sh <ip>` builds four images on the laptop, then sends
them with `docker save … | gzip -1 | ssh … 'gunzip | docker load'`. With dockeriser the images are
built on Google Cloud Build and streamed from Artifact Registry straight into `docker load` on the
droplet. They never touch the laptop's Docker, and the laptop doesn't even need Docker running.
Everything after the load (the config tarball, `setup.sh`, `docker compose up`) stays exactly as it is.

dockeriser does not change this repo by itself. These are the edits to make.

## 1. One-time setup (Cameron, by hand)

1. Set up dockeriser once on the PC: `/dockeriser:setup` in Claude Code, or the setup script in the
   dockeriser README.
2. Save the droplet under a name. Use the key ship.sh already uses (`$SSH_KEY`, which defaults to
   `~/.ssh/pecunia_droplet_ed25519`):
   ```
   dockeriser server add appraiseme --host root@<droplet IP> --key ~/.ssh/pecunia_droplet_ed25519
   ```
   This only checks that SSH and Docker work. Nothing is installed on the droplet, and no Google key
   goes on it (the default transfer is `ssh`). If all droplets share one key, set `"sshKey"` once in
   `%USERPROFILE%\.dockeriser\config.json` and leave out `--key`.

## 2. `dockeriser.json` (repo root)

```json
{
  "images": [
    {
      "name": "base",
      "image": "appraiseme-app-base",
      "dockerfile": "Dockerfile",
      "context": ".",
      "localTag": "appraiseme-app:base",
      "buildArgs": { "REVISION": "${REVISION}", "RELEASE": "${RELEASE}" }
    },
    {
      "name": "app",
      "image": "appraiseme-app",
      "dockerfile": "deploy/app.Dockerfile",
      "context": ".local/deploy/app-context"
    },
    {
      "name": "web",
      "image": "appraiseme-web",
      "dockerfile": "deploy/web.Dockerfile",
      "context": ".",
      "buildArgsFile": ".local/deploy/web-build.env",
      "buildArgsFromEnv": ["NEXT_PUBLIC_*"],
      "buildArgs": { "REVISION": "${REVISION}" }
    },
    {
      "name": "proxy",
      "image": "appraiseme-proxy",
      "dockerfile": "deploy/proxy.Dockerfile",
      "context": "deploy"
    }
  ],
  "deploy": {
    "server": "appraiseme",
    "mode": "load-only",
    "images": {
      "app": { "tagAs": "appraiseme-app:demo" },
      "web": { "tagAs": "appraiseme-web:demo" },
      "proxy": { "tagAs": "appraiseme-proxy:demo" }
    }
  }
}
```

Notes:
- **All four images are built in one Cloud Build run, in order.** `base` is tagged `appraiseme-app:base`
  on the build machine, so `deploy/app.Dockerfile`'s `FROM appraiseme-app:base` works unchanged.
- `base` is also pushed, as `appraiseme-app-base`. This gives it a layer cache, so later builds skip the
  slow 4-stage build when nothing changed. Set `"push": false` to skip storing it.
- **What gets uploaded.** The root `.dockerignore` starts with `**`, so for the `.` contexts
  dockeriser sends only what that file allows, the same as Docker. The `deploy/` and
  `.local/deploy/app-context` contexts have no `.dockerignore`, so they are sent whole, even though
  `.local/` is gitignored. Run the existing staging step first so the app context exists.
- **Build args.** `REVISION` and `RELEASE` come from environment variables of the same name on the
  laptop. Only `NEXT_PUBLIC_*` lines are read from `web-build.env`. Build args are visible in the Cloud
  Build console. That is fine for these public values, but never use build args for secrets.
- **What the droplet gets.** The deploy loads each image and tags it `appraiseme-*:demo`, the names
  `compose.yml` already uses. If `/opt/appraiseme/.env` pins `APP_IMAGE`, `WEB_IMAGE` or `PROXY_IMAGE`
  to something else, those pins win, as they do today.

## 3. The ship.sh change

Keep everything before the builds: `configure.mjs`, the key-fingerprint guard, `release-number.mjs
claim`, and staging `.local/deploy/app-context`. Replace the `docker build …` lines and the
`docker save "${images[@]}" | gzip -1 | remote 'gunzip | docker load'` line with:

```bash
dockeriser="${DOCKERISER:-dockeriser}"   # or: node /path/to/dockeriser/bin/dockeriser.js
case "${ONLY:-all}" in
  app) names=app ;;
  web) names=web ;;
  proxy) names=proxy ;;
  *) names=app,web,proxy ;;
esac
REVISION="$revision" RELEASE="$release" $dockeriser build . --only "$names" --deploy appraiseme --mode load-only --json \
  > .local/deploy/dockeriser-result.json || { echo "dockeriser build/deploy failed; see above" >&2; exit 1; }
```

`--only app` also builds `base`, because `app` is built FROM it. After this line the images are on the
droplet with their usual names. The rest of ship.sh runs unchanged: the bundle tarball, `bash setup.sh`
and the partial `docker compose up -d --force-recreate …`.

**SSH connections.** dockeriser opens 3 SSH connections per deploy: look, load, finish. The droplet's
ufw drops a 7th connection within 30 seconds, so keep ship.sh's own connections to the few it already
uses.

## 4. Try it with one image first

`proxy` is the smallest image and doesn't depend on `base`:

```bash
ONLY=proxy bash deploy/ship.sh <ip>
# or by itself, without the rest of ship.sh:
dockeriser build . --only proxy --deploy appraiseme --mode load-only
```

Then check on the droplet with `docker image ls appraiseme-proxy`. It should be tagged `demo`, plus a
`…/appraiseme-proxy:dk-<id>` tag that dockeriser uses to tell what is already there.

## 5. If something goes wrong

- **The old path still works.** Run the previous ship.sh from git, or keep the old block behind a
  switch such as `if [ "${USE_DOCKERISER:-1}" = 1 ]; then … else <old docker build + save|load> fi`.
- **Go back to the previous images:** `dockeriser rollback`, run from the repo. It re-tags the
  previous image IDs dockeriser recorded on the droplet. Then restart the services the usual way.
- **Disk.** After each successful deploy, dockeriser keeps the current and previous image of each one,
  and removes older images that it loaded itself. It never touches images it didn't load, such as the
  ones from the old `docker load` path.
