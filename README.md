# dockeriser

Build Docker images on **Google Cloud Build** instead of on your own PC. It uploads a folder, runs the
build on Google's machines, shows the build output live, and stores the finished image in your Google
Cloud account. Normal use fits in Google's free 2,500 build-minutes a month. It can then put the images
on your own server over SSH, with health checks and rollback. It works for any project: one Dockerfile,
several chained images, or compose.

## Setup (about 5 minutes)

1. Install Google's command-line tool, then open a new terminal:
   ```
   winget install Google.CloudSDK
   ```
2. From this folder, run the setup script. It asks which project to use (or pass `-Project my-id`):
   ```
   powershell -ExecutionPolicy Bypass -File setup\setup.ps1
   ```
   (From another folder, give the full path to `setup\setup.ps1` in your dockeriser folder.)
   In Claude Code, `/dockeriser:setup` does this step for you: it asks in chat which project to use, then
   runs the script. Either way a browser opens for the Google sign-in. At the end the script may print
   "waiting for Google to apply the new permissions…" for up to about 3 minutes; that is normal.
3. Try a build:
   ```
   node bin\dockeriser.js build examples\hello --image hello
   ```
   The first real build took 11 seconds and used about 0.2 of the 2,500 free minutes.

The same steps with copy buttons: [docs/setup.html](docs/setup.html).

### Slash commands (Claude Code)

After the plugin is installed (see [Claude Code plugin](#claude-code-plugin)):

| Command | What it does |
|---|---|
| `/dockeriser:init [dir]` | Onboards any project: detects Dockerfiles, compose files and existing ship scripts, works out the server (asks you if it isn't written down), offers to save it, writes `dockeriser.json`, and runs a first build. Never deploys unless you ask. |
| `/dockeriser:build [dir] [image]` | Builds on Cloud Build and pushes: the images in `dockeriser.json`, or one image named after the folder. Shows the live log, then each image address and digest, minutes used and the usage line; on failure, the failed step, the error lines and the full log file. |
| `/dockeriser:deploy [dir] [server]` | Puts the images on your server over SSH (run, compose or load-only), with health checks and automatic rollback. Only when you ask. |
| `/dockeriser:server [add\|list\|check]` | Saves a server (asks for the host in chat), lists them, or checks SSH and Docker on one. |
| `/dockeriser:rollback [dir]` | Goes back to the previous image(s) on the server. |
| `/dockeriser:logs [dir]` | The deployed container's logs, over SSH. |
| `/dockeriser:cleanup` | Deletes old images from the registry, keeping the 20 newest versions of each (shows what would go first), and sets the daily cleanup policy to match. |
| `/dockeriser:setup [project-id]` | Asks in chat which Google Cloud project to use (lists yours, or offers to create one), then runs the setup script. |
| `/dockeriser:doctor` | Online check of every piece of setup; explains each failure and its fix. |
| `/dockeriser:status` | Instant local check (no network): set up or not, and this month's usage line. |
| `/dockeriser:usage` | Free build-minutes used this month, the month-end projection, any estimated cost and image storage. |
| `/dockeriser:login` | What's left to do to sign in, if anything. |

Each one finds the dockeriser CLI the same way the session hook does, and runs `npm install` there the
first time.

### What the script does

- Signs you in to Google in your browser (only if you aren't already).
- Uses the project you pick, or creates a new one, and links your billing account (needed even for the free tier).
- Turns on the Google services dockeriser needs and makes a private place for images and build files, with old files cleaned up automatically (the 20 newest versions of each image are kept).
- Creates a `dockeriser` account with only the permissions builds need.
- Sets a $5/month budget alert so you get an email before any surprise (`-Budget 10` to change).
- Lets dockeriser sign in as that account (one more browser sign-in, no password files).
- Checks everything at the end. Safe to run again any time; it only fixes what's missing.

More detail, the click-through version, key files for headless machines (advanced), and the full
permissions list: [docs/SETUP.md](docs/SETUP.md).

## Projects with several images (`dockeriser.json`)

Put a `dockeriser.json` next to your code, or run `dockeriser init` (`/dockeriser:init`) to write a
starter one. `dockeriser build` with no `--image` then builds every image in it. `--only a,b` builds a
subset, plus any local base image they need.

- Images that build `FROM` another image's `localTag` go **in one Cloud Build run, in order**, so that
  `FROM` works unchanged; nothing is rewritten.
- Images that share no local base build **at the same time**, each as its own Cloud Build on its own
  machine, from one upload. `--sequential` (or `"parallel": false`) puts everything in one run.

```json
{
  "images": [
    { "name": "base", "image": "shop-base", "localTag": "shop:base" },
    { "name": "app", "image": "shop-app", "dockerfile": "deploy/app.Dockerfile", "context": ".local/app-context" },
    { "name": "web", "image": "shop-web", "dockerfile": "web/Dockerfile", "context": "web",
      "buildArgsFile": ".env", "buildArgsFromEnv": ["NEXT_PUBLIC_*"], "buildArgs": { "GIT_SHA": "${git.sha}" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Short id, used by `--only` and the deploy section |
| `image` | Image name in Artifact Registry (default: `name`). Tags come from `--tag` or the git SHA |
| `dockerfile` | Path from the folder holding dockeriser.json (default: `<context>/Dockerfile`) |
| `context` | Build context folder (default `.`). A folder outside the project, such as `../other-repo`, is packed into the same upload under `_ctx/<name>/` |
| `localTag` | Extra local tag (e.g. `shop:base`), so a later image can `FROM` it inside the same build |
| `push` | `false` to build an image only for later images to use, without storing it (default `true`) |
| `buildArgs` | `{"KEY": "value"}`. `${VAR}` and `$VAR` come from your environment; `${git.sha}` and `${git.short}` come from git |
| `buildArgsFile` | A KEY=VALUE file read on your PC (e.g. `.env`) |
| `buildArgsFromEnv` | Name patterns such as `["NEXT_PUBLIC_*", "VITE_*"]`. Only matching keys from `buildArgsFile` (or your environment) are sent, never the whole .env |
| `prebuild` | A command run on your PC, in the project folder, before packaging (e.g. `"node scripts/stage-app-context.mjs"`), for a context a script assembles. Runs on `--dry-run` too; a failure stops the build |

Top-level fields:
- `include`: extra files or folders to upload, even if an ignore file or a gitignored parent folder
  leaves them out.
- `source: "git"`: upload only files tracked by git.
- `parallel: false`: build every image in one Cloud Build run.
- `deploy`: see [Deploy to a server](#deploy-to-a-server).

**What gets uploaded:**
- For each image, exactly what Docker would send for its context. dockeriser uses that context's own
  `.dockerignore` (or `<Dockerfile>.dockerignore`) with Docker's rules, so `**` followed by
  `!exceptions` works.
- Every Dockerfile, and the `include` entries.
- A staged context under a gitignored folder (like `.local/`) is still sent. `.git/` never is.

**Build args are visible in the Cloud Build console**, so use them only for public values such as
`NEXT_PUBLIC_*`, never secrets. dockeriser warns when a build-arg name looks like a secret (`*_TOKEN`,
`*_PASSWORD`, `*_SECRET*`, `*_KEY`, …, but not `NEXT_PUBLIC_*`, `VITE_*` or other public prefixes). Examples for common setups are in [docs/examples/](docs/examples/).

## Deploy to a server

dockeriser can put the images on your own server over SSH: a DigitalOcean droplet, or any Linux box
with Docker. **It only deploys when you run `deploy`.** Building never deploys by itself.

1. Save the server once. This checks SSH and Docker; add `--install-docker` to install Docker if it's
   missing.
   ```
   dockeriser server add prod --host root@203.0.113.10 --key ~/.ssh/id_ed25519
   ```
   - If all your servers use one key, put `"sshKey": "~/.ssh/id_ed25519"` in
     `~\.dockeriser\config.json` and leave out `--key`.
   - Hosts from `~/.ssh/config` work too, and `--to` also takes a raw `user@host`.
2. Deploy. The first time, pass the settings. They are saved for this folder in
   `~\.dockeriser\projects\`, not in the repo, so the checkout stays clean. `--save` writes them into
   `dockeriser.json` instead (to commit them); `--no-save` keeps nothing. A `deploy` section in
   `dockeriser.json` wins over the saved one. Your .env contents are never saved.
   ```
   dockeriser deploy --to prod --image web -p 80:3000 --env-file .env --health-url http://localhost:3000/health
   ```
3. After that, `dockeriser deploy --build` builds and ships in one go, using the exact digests just built.

**Picking images.** Without `--image`, the images in `dockeriser.json` are deployed at `:latest`.
- `--image` repeats: `--image app --image web --tag-as app:demo --tag-as web:demo` pairs the bare
  `--tag-as` values with the images in order (or use `--tag-as web=web:demo`).
- `--image web@sha256:<digest>` deploys that exact image, with no tag lookup.
- `deploy --build --image app --image web` builds those `dockeriser.json` images and deploys their digests.

**Modes:**
- **`run`** (default): one container with `--restart unless-stopped`. It must still be running after
  10 seconds, and `--health-url` (if given) must answer within 60 seconds. Otherwise dockeriser prints
  the last 50 log lines and starts the previous version again.
- **`compose`**: `--compose-dir /opt/app --service api,worker --tag-as myapp-api:prod`.
  1. Tags the new image with the name your compose file already uses.
  2. Runs `docker compose up -d --no-deps` for those services.
  3. Waits up to 120 seconds for them to be healthy. If they aren't, it re-tags the previous image and
     restarts them.
- **`load-only`**: puts the images on the server under the names you choose
  (`--tag-as web=myapp-web:prod`), then stops, or runs `--then "cd /opt/app && bash remote.sh"`. This is
  for projects that already have their own remote script: their `docker save | gzip | ssh docker load`
  line becomes one `dockeriser deploy --mode load-only` command.

**Config files.** `--upload <local folder or file>:<server folder>` (repeatable) sends files from the
project before the deploy script and `--then`, all in one tar stream over one extra SSH connection.
They are unpacked into a temp folder first, so a broken stream changes nothing; then copied into place
(with sudo when the SSH user has it). `--keep-env APP_IMAGE,WEB_IMAGE` keeps those lines of the
server's existing `<server folder>/.env` when the upload brings a new `.env`, such as image pins a
release wrote there. Uploaded files are not rolled back by `dockeriser rollback`.

A whole ship script then becomes one command:
```
dockeriser deploy --to prod --mode load-only --tag-as app=app:demo --tag-as web=web:demo \
  --upload .local/deploy/bundle:/opt/app --keep-env APP_IMAGE,WEB_IMAGE --then "cd /opt/app && bash setup.sh"
```

**How the image gets there.** Two transfers:
- **`ssh`** (default): no setup and no secrets on the server, but every deploy uploads through your
  PC's connection.
- **`pull`** (`server add … --transfer pull`): a one-time setup leaves a read-only key on the server,
  and deploys are faster after that.

In detail:
- `ssh` streams each image from Artifact Registry through your PC straight into `docker load` on the
  server. It needs no local Docker and no local disk, and skips images the server already has.
- `pull` gives the server a read-only key for this one repo (`/etc/dockeriser/puller.json`, mode 600).
  The server then downloads only the layers it lacks.

**After a good deploy**, dockeriser:
- keeps the current and previous image of each one on the server;
- removes older images that it put there itself, and never anything else;
- prints free disk before and after.

`dockeriser rollback` goes back to the previous image, and `dockeriser logs [--follow]` shows the
container logs. Both use the settings the first deploy saved.

**Costs.** Images leaving Google for a server outside Google count as internet egress. The first 1 GiB a
month is free, then it's about $0.12/GiB in North America.
- With `pull`, only changed layers move. `ssh` sends a changed image whole.
- Example: a 300 MB image deployed 60 times a month costs about $2 with `ssh`. With `pull` it costs
  cents, if only 40 MB of layers change each time.
- Why not DigitalOcean's registry: Cloud Build would still send the same bytes out of Google, and it
  adds $5-20 a month. It only pays off with many servers.

Numbers and sources: [docs/RESEARCH.md](docs/RESEARCH.md#5-deploying-to-a-server-checked-2026-10-16).

## Getting the image yourself

A build pushes the image to Artifact Registry and prints its full address with the digest. Nothing is
downloaded to your PC. To pull it by hand on a PC signed in to gcloud:

```
gcloud auth configure-docker northamerica-northeast2-docker.pkg.dev
docker pull <address>
```

### Check usage

```
node bin\dockeriser.js usage
```

Or in Claude Code: `/dockeriser:usage`. Shows how many of the 2,500 free minutes you've used this month,
where you're heading by month end, and any estimated cost.

### Old images

The image repo keeps the **20 newest versions of each image**; Artifact Registry deletes older ones
about once a day. To delete them now (and set that policy on a repo made by an older setup):

```
dockeriser cleanup --dry-run     # what would go, per image
dockeriser cleanup               # delete it; --keep N for another number
```

The version tagged `latest` is never deleted. It runs gcloud as you (the project owner), so the
`dockeriser` build account cannot delete images. Servers keep their own copies, so rollbacks still work.

## Commands

```
dockeriser build [dir] --image <name>[:<tag>] [options]   one image
dockeriser build [dir] [--only a,b]    the images in dockeriser.json (--build-arg-file, --deploy <server>)
dockeriser init [dir] [--force]        write a starter dockeriser.json (detects Dockerfiles, compose, ship scripts)
dockeriser deploy [dir] --to <server>  see "Deploy to a server"; --dry-run prints the remote script
dockeriser rollback [dir] | logs [dir] [--follow]
dockeriser cleanup [--keep 20] [--dry-run]   keep the newest N versions of each image, delete the rest
dockeriser server add <name> --host <user@host> [--port] [--key] [--transfer ssh|pull] [--install-docker]
dockeriser server list | check <name> | remove <name>
dockeriser login                       next sign-in step(s), if any
dockeriser usage [--month YYYY-MM]     free build-minutes used, projection, estimated cost, image storage
dockeriser status --offline            instant local check, no network (used by the Claude Code hook)
dockeriser doctor                      online check of every piece of setup, with fixes
```

`build` options:

| Option | Meaning |
|---|---|
| `-i, --image` | `myapp[:tag]` goes to `<region>-docker.pkg.dev/<project>/<repo>/myapp`; a full `*-docker.pkg.dev/...` ref is used as-is |
| `-t, --tag` | extra tag, repeatable. `:latest` is always pushed too |
| (no tag) | short git SHA when `<dir>` is in git with no uncommitted changes, else UTC `YYYYMMDD-HHMMSS` |
| `-f, --dockerfile` | Dockerfile path relative to `<dir>` (default `Dockerfile`) |
| `--build-arg K=V` | passed to `docker build`, repeatable |
| `--timeout` | `20m` (default), `1h`, `90s`, `1h30m` |
| `--no-cache` | skip the registry cache (`--cache-from <image>:latest` is used otherwise) |
| `--sequential` | with dockeriser.json: one Cloud Build run instead of parallel builds |
| `--dry-run` | package locally and print the Cloud Build request; no network |
| `--json` | one JSON object on stdout; logs and messages go to stderr |
| `--project`, `--region`, `--repo` | override config |
| `--debug` | show stack traces |

Settings come from flags, then env (`DOCKERISER_PROJECT`, `DOCKERISER_REGION`, `DOCKERISER_REPO`,
`DOCKERISER_SERVICE_ACCOUNT`), then `~\.dockeriser\config.json`.

`~` is your Windows account's own profile folder (`C:\Users\<you>`), found even when `USERPROFILE` or
`HOME` points somewhere else, as it does in Claude Code accounts (`C:\Users\<you>\.claude-work`):
dockeriser uses the first of the two that has `.dockeriser\config.json`, and `status` lists every path
it looked in. `DOCKERISER_CONFIG_DIR` points at a different `.dockeriser` folder. Defaults: region
`northamerica-northeast2`, repo `docker-images`, service account `dockeriser@<project>.iam.gserviceaccount.com`.

Credentials: `GOOGLE_APPLICATION_CREDENTIALS`, else `~\.dockeriser\key.json`, else gcloud's
application-default login (ideally with `--impersonate-service-account`). On a Google Cloud VM with no
file, set `METADATA_SERVER_DETECTION=assume-present`.

What gets uploaded: everything in `<dir>` except `.git/` and whatever `.gcloudignore` excludes (gitignore
rules, `#!include:` supported) or, if there is no `.gcloudignore`, `.dockerignore` (Docker rules). The
Dockerfile is always included.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | build failed (FAILURE, TIMEOUT, CANCELLED, INTERNAL_ERROR, EXPIRED) or an unexpected error |
| 2 | config or input problem (no project, bad flag, missing Dockerfile, API turned off) |
| 3 | credentials or permission problem |
| 4 | source upload failed |
| 130 | interrupted with Ctrl-C (first Ctrl-C cancels the build and waits; a second quits at once) |

## `--json` result (for AI agents)

```jsonc
{
  "status": "SUCCESS",          // FAILURE | TIMEOUT | CANCELLED | INTERNAL_ERROR | EXPIRED | ERROR
  "exitCode": 0,
  "buildId": "8c1d…",
  "images": [{ "name": "northamerica-northeast2-docker.pkg.dev/p/docker-images/hello:v1", "digest": "sha256:…", "durationSec": 70 }],
  "durationSec": 74,
  "buildMinutes": 1.23,         // billed per second
  "consoleUrl": "https://console.cloud.google.com/cloud-build/builds;region=…/8c1d…?project=p",
  "logFile": null,              // on failure: full log saved in the temp folder
  "failedStep": null,           // on failure: { index, id, name, status, args }
  "failureInfo": null,          // on failure: { type, detail, hint? }
  "errorTail": [],              // on failure: last 50 log lines
  "usage": { "line": "Cloud Build: 0.2 / 2,500 free min this month (0%)", "minutesUsed": 0.18, "percent": 0, … },
  "error": { "type": "ConfigError", "message": "…", "fix": "…" }   // only when status is "ERROR"
}
```

When dockeriser.json images build in parallel, the result is still one object: `status` is the first
non-SUCCESS one, `buildId`/`consoleUrl`/`logFile`/`failedStep`/`errorTail` describe the first failed
build (else the first), `images` lists every image, `durationSec` is wall-clock, `buildMinutes` the
sum, plus `parallel: true` and `builds` (each build's own result). `images[].durationSec` is that
image's cache pull plus build step. A parallel `--dry-run --json` returns `builds` (image names per
build) and `requests` instead of `request`.

`deploy --json` / `rollback --json` return `status` (SUCCESS, ROLLED_BACK, FAILED), `exitCode`,
`server`, `mode`, `transfer`, `container`, `image`, `digest`, `previousDigest`, `rolledBack`, `logsTail`
(last container log lines on failure), `items` (one per image: `name`, `digest`, `tagAs`, `transferred`,
`imageId`, `previousImageId`), `transferredBytes`, `diskFreeBefore` and `diskFreeAfter` (KB), `then`,
`uploads` (`from`, `to`, `files`, `bytes`, `keptEnv`), `durationSec`, `timings` (`checkSec`,
`transferSec`, `uploadSec`, `scriptSec`) and `saved` (`project-state`, `dockeriser.json` or null).
`build --deploy` adds the deploy result under `deploy`.

`cleanup --json` returns `keep`, `repository`, `policy` (`set` or `unchanged`), `images` (`name`,
`versions`, `kept`, `deleting`, `bytes`), `deleted`, `wouldDelete` (dry run) and `bytesFreedUpTo`.

`usage --json` returns `minutesUsed`, `minutesLeft`, `percent`, `builds`, `avgMinutesPerBuild`,
`minutesPerDay`, `projectedMinutes`, `crossDate`, `overageMinutes`, `costSoFarUsd`, `projectedCostUsd`,
`arStorage` and `billingUrl`. `status --offline --json` returns `configured`, `credentials.present`,
`project`, `configFile`, `home`, `searched` (every config.json path looked at), `usageLine` and `nextSteps`.

## Usage tracking

`dockeriser usage` adds up this month's builds from the Cloud Build API (start to finish, per second,
default machine only) and saves the result to `~\.dockeriser\usage-cache.json`. Every
`build` adds its own minutes to that cache, so the line printed after each build stays current without an
API call. Numbers are estimates for one project and region; the free minutes are shared by your whole
billing account. The real bill: https://console.cloud.google.com/billing. Prices live in `src/pricing.js`.

## Claude Code plugin

`plugin/` is a Claude Code plugin: a `dockeriser` skill (agents use it instead of local `docker build`),
the [slash commands](#slash-commands-claude-code), and a SessionStart hook that tells each session,
offline, whether dockeriser is signed in and how many free minutes are used.

Install from GitHub by typing these in Claude Code:

```
/plugin marketplace add cwoodard1121/dockerizer
/plugin install dockeriser@dockerizer
/reload-plugins
```

To get a newer version later: `/plugin update dockeriser@dockerizer`, then `/reload-plugins`. The slash
commands run `plugin/scripts/run.js`, which finds the CLI as below and runs it.

**How the hook finds the CLI.** Claude Code copies only the plugin folder into
`<config>/plugins/cache/dockerizer/dockeriser/<version>/`, so the folder above the plugin there is not a
checkout. For a GitHub marketplace it also keeps a full clone of this repo at
`<config>/plugins/marketplaces/dockerizer/`. The hook (`plugin/hooks/session-start.js`) tries, in order:

1. `DOCKERISER_HOME`, if set: any checkout you point it at.
2. `${CLAUDE_PLUGIN_ROOT}/..`: works when the plugin is loaded straight from a checkout (a local
   directory marketplace, or during development).
3. `<config>/plugins/marketplaces/dockerizer/` (worked out from the cache path): the marketplace clone.
   Installing the plugin is enough, so no separate clone is needed, on any PC or for any user.

A checkout with `node_modules` installed wins. Otherwise the slash commands run
`npm install --omit=dev` there on first use. If no checkout exists, the note says to add the
marketplace or set `DOCKERISER_HOME`. The hook only reads local files (it imports
`src/status.js`, which loads no Google libraries), never touches the network, and always exits 0. This
works the same in every Claude config folder, because each folder's cache path leads to its own
marketplace clone.

## Development

Node 22+, no build step. Sources for every Google Cloud fact the code relies on (prices, free tier,
permissions): [docs/RESEARCH.md](docs/RESEARCH.md).

```
npm test        # node:test, all Google clients mocked
node bin/dockeriser.js build examples/hello --image hello --project demo-proj --dry-run
```

Layout: `bin/dockeriser.js` (entry), `src/cli.js` (commands), `src/config.js`, `src/image.js`,
`src/package-source.js`, `src/upload.js`, `src/build.js`, `src/logs.js`, `src/usage.js`,
`src/pricing.js`, `src/status.js`, `src/login.js`, `src/doctor.js`, `src/clients.js`, `src/errors.js`,
`src/output.js`, plus `src/project.js` (dockeriser.json), `src/dockerignore.js`, `src/init.js`,
`src/deploy.js`, `src/remote.js` (server-side bash), `src/ssh.js`, `src/servers.js`, `src/server.js`,
`src/registry.js` (Registry v2 client) and `src/save-tar.js` (docker-save stream).
