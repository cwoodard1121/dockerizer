# dockeriser

Build Docker images on **Google Cloud Build** instead of with local `docker build`. It packages a folder,
uploads it, starts the build, streams the log to your terminal, and pushes the image to **Artifact
Registry**. Builds run on Google's default machine, which is covered by the free tier
(2,500 build-minutes a month).

Node 22+, no build step. Windows-first (PowerShell setup script), works anywhere Node runs.

## Quick start

```
npm install
powershell -ExecutionPolicy Bypass -File setup\setup.ps1 -Project YOUR-PROJECT-ID   # once; see docs/SETUP.md
gcloud auth application-default login --impersonate-service-account=dockeriser@YOUR-PROJECT-ID.iam.gserviceaccount.com
node bin/dockeriser.js login
node bin/dockeriser.js build examples/hello --image hello
```

Full setup guide, costs and troubleshooting: [docs/SETUP.md](docs/SETUP.md). Source notes for every
cloud fact the code relies on: [docs/RESEARCH.md](docs/RESEARCH.md).

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
  "usage": { "line": "Cloud Build: 312 / 2,500 free min this month (12%)", "minutesUsed": 312.4, "percent": 12.5, … },
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

`plugin/` is a Claude Code plugin: a `dockeriser` skill (use this instead of local `docker build`),
`/dockeriser:login`, `/dockeriser:usage`, and a SessionStart hook that tells each session, offline,
whether dockeriser is signed in and how many free minutes are used.

Install from GitHub:

```
claude plugin marketplace add cwoodard1121/dockerizer
claude plugin install dockeriser@dockerizer
```

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

```
npm test        # node:test, all Google clients mocked
node bin/dockeriser.js build examples/hello --image hello --project demo-proj --dry-run
```

Layout: `bin/dockeriser.js` (entry), `src/cli.js` (commands), `src/config.js`, `src/image.js`,
`src/package-source.js`, `src/upload.js`, `src/build.js`, `src/logs.js`, `src/usage.js`,
`src/pricing.js`, `src/status.js`, `src/login.js`, `src/doctor.js`, `src/clients.js`, `src/errors.js`,
`src/output.js`.
