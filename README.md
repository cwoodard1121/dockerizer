# dockeriser

Build Docker images on **Google Cloud Build** instead of on your own PC. It uploads a folder, runs the
build on Google's machines, shows the build output live, and stores the finished image in your Google
Cloud account. Normal use fits in Google's free 2,500 build-minutes a month.

## Setup (about 5 minutes)

1. Install Google's command-line tool, then open a new terminal:
   ```
   winget install Google.CloudSDK
   ```
2. From this folder, run the setup script. It asks which project to use (or pass `-Project my-id`):
   ```
   powershell -ExecutionPolicy Bypass -File setup\setup.ps1
   ```
   Or from anywhere:
   ```
   powershell -ExecutionPolicy Bypass -File "C:\Users\camer\Desktop\Projects\dockeriser\setup\setup.ps1"
   ```
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
| `/dockeriser:build [dir] [image]` | Builds on Cloud Build and pushes. `dir` defaults to the current project folder, `image` to the folder name. Shows the live log, then the image address and digest, minutes used and the usage line; on failure, the failed step, the error lines and the full log file. |
| `/dockeriser:setup [project-id]` | Asks in chat which project to use (lists yours, or offers to create one), then runs the setup script. |
| `/dockeriser:doctor` | Online check of every piece of setup; explains each failure and its fix. |
| `/dockeriser:status` | Instant local check (no network): set up or not, and this month's usage line. |
| `/dockeriser:usage` | Free build-minutes used this month, the month-end projection, any estimated cost and image storage. |
| `/dockeriser:login` | What's left to do to sign in, if anything. |

Each one finds the dockeriser folder the same way the session hook does and runs `npm install` there the
first time.

### What the script does

- Signs you in to Google in your browser (only if you aren't already).
- Uses the project you pick, or creates a new one, and links your billing account (needed even for the free tier).
- Turns on the Google services dockeriser needs and makes a private place for images and build files, with old files cleaned up automatically.
- Creates a `dockeriser` account with only the permissions builds need.
- Sets a $5/month budget alert so you get an email before any surprise (`-Budget 10` to change).
- Lets dockeriser sign in as that account (one more browser sign-in, no password files).
- Checks everything at the end. Safe to run again any time; it only fixes what's missing.

More detail, the click-through version, key files for headless machines (advanced), and the full
permissions list: [docs/SETUP.md](docs/SETUP.md).

## Getting the image

A build pushes the image to Artifact Registry by itself and prints its full address with the digest,
for example `northamerica-northeast2-docker.pkg.dev/<project>/docker-images/hello:v1@sha256:…`. Nothing
is downloaded to your PC.

- **On a PC signed in to gcloud** (already done on Cameron's MSI): run this once, then pull by address:
  ```
  gcloud auth configure-docker northamerica-northeast2-docker.pkg.dev
  docker pull <address>
  ```
- **On a server or droplet** (no gcloud sign-in): make a service account with only
  `roles/artifactregistry.reader` on the `docker-images` repo, create a key for it, copy the key to the
  server, and there run:
  ```
  cat key.json | docker login -u _json_key --password-stdin https://northamerica-northeast2-docker.pkg.dev
  docker pull <address>
  ```

dockeriser doesn't SSH anywhere or deploy anything; running the image on a server is a separate step.

### Check usage

```
node bin\dockeriser.js usage
```

Or in Claude Code: `/dockeriser:usage`. Shows how many of the 2,500 free minutes you've used this month,
where you're heading by month end, and any estimated cost.

## Commands

```
dockeriser build <dir> --image <name>[:<tag>] [options]
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
| `--dry-run` | package locally and print the Cloud Build request; no network |
| `--json` | one JSON object on stdout; logs and messages go to stderr |
| `--project`, `--region`, `--repo` | override config |
| `--debug` | show stack traces |

Settings come from flags, then env (`DOCKERISER_PROJECT`, `DOCKERISER_REGION`, `DOCKERISER_REPO`,
`DOCKERISER_SERVICE_ACCOUNT`), then `%USERPROFILE%\.dockeriser\config.json`. Defaults: region
`northamerica-northeast2`, repo `docker-images`, service account `dockeriser@<project>.iam.gserviceaccount.com`.

Credentials: `GOOGLE_APPLICATION_CREDENTIALS`, else `%USERPROFILE%\.dockeriser\key.json`, else gcloud's
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
  "images": [{ "name": "northamerica-northeast2-docker.pkg.dev/p/docker-images/hello:v1", "digest": "sha256:…" }],
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

`usage --json` returns `minutesUsed`, `minutesLeft`, `percent`, `builds`, `avgMinutesPerBuild`,
`minutesPerDay`, `projectedMinutes`, `crossDate`, `overageMinutes`, `costSoFarUsd`, `projectedCostUsd`,
`arStorage` and `billingUrl`. `status --offline --json` returns `configured`, `credentials.present`,
`project`, `usageLine` and `nextSteps`.

## Usage tracking

`dockeriser usage` adds up this month's builds from the Cloud Build API (start to finish, per second,
default machine only) and saves the result to `%USERPROFILE%\.dockeriser\usage-cache.json`. Every
`build` adds its own minutes to that cache, so the line printed after each build stays current without an
API call. Numbers are estimates for one project and region; the free minutes are shared by your whole
billing account. The real bill: https://console.cloud.google.com/billing. Prices live in `src/pricing.js`.

## Claude Code plugin

`plugin/` is a Claude Code plugin: a `dockeriser` skill (agents use it instead of local `docker build`),
the six [slash commands](#slash-commands-claude-code), and a SessionStart hook that tells each session,
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

1. `${CLAUDE_PLUGIN_ROOT}/..`: works when the plugin is loaded straight from a checkout (a local
   directory marketplace, or development).
2. `C:/Users/camer/Desktop/Projects/dockeriser`: the owner's working copy.
3. `<config>/plugins/marketplaces/dockerizer/` (worked out from the cache path): the marketplace clone.

A checkout with `node_modules` installed wins; otherwise the note says to run `npm install` there. If
none exists, the note tells the user to clone the repo. The hook only reads local files (it imports
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
`src/output.js`.
