# Setting up dockeriser

This gets your Google Cloud account ready so `dockeriser build` can build Docker images on Google's
machines instead of yours. You do it once. It takes about 5 minutes.

## The short version

1. Install Google's command-line tool, then open a new terminal:
   ```
   winget install Google.CloudSDK
   ```
2. From the dockeriser folder, run the setup script. It asks which project to use (or pass `-Project my-id`):
   ```
   powershell -ExecutionPolicy Bypass -File setup\setup.ps1
   ```
   Full-path form, from anywhere:
   ```
   powershell -ExecutionPolicy Bypass -File "C:\Users\camer\Desktop\Projects\dockeriser\setup\setup.ps1"
   ```
3. Try a build:
   ```
   node bin\dockeriser.js build examples\hello --image hello
   ```

The first real build took 11 seconds and used about 0.2 of the 2,500 free minutes.

**From Claude Code:** `/dockeriser:setup` does step 2 for you. It asks in chat which project to use
(listing your projects if gcloud is signed in, or offering to create one), warns that a browser will open,
then runs the script with `-Project <id>`. If gcloud is missing it tells you to type
`! winget install Google.CloudSDK` and restart the terminal. You can also type the step 2 command
yourself with a leading `!`, adding `-Project <your-id>`, since the script can't ask questions there.
Install the plugin first: `/plugin marketplace add cwoodard1121/dockerizer`,
`/plugin install dockeriser@dockerizer`, `/reload-plugins`.

## What you are setting up, in plain words

- A **project**: a folder in Google Cloud that holds everything below.
- A **robot account** called `dockeriser`. The tool signs in as this account, and the build runs as it.
- Two **storage folders** ("buckets"): one for the uploaded code (files deleted after 1 day) and one for
  build logs (deleted after 30 days). Both private.
- An **image shelf** ("Artifact Registry repo") called `docker-images`, where finished images go. It keeps
  the 10 newest versions of each image and clears out older ones, so you stay inside the free storage.
- A **budget alert** that emails you at 50%, 90% and 100% of $5 a month (change it with `-Budget 10`,
  turn it off with `-Budget 0`).

## What the script does, step by step

Each step prints one line: ✔ done, "skipped" (already done) or ✖ (problem, with what to do). Running it
again is safe; it only does what is missing.

1. **Checks for gcloud.** If it's missing, it prints the `winget` command and stops.
2. **Signs you in to Google** (`gcloud auth login`, in the browser) if you aren't already.
3. **Picks the project.** With `-Project` it uses that. Without, it offers the project you used last time,
   or lists your projects with a "Create a new project" choice. For a new one it opens the Google Cloud
   "create project" page and asks for the ID; type a new ID and it creates the project for you.
   The choice is saved in `%USERPROFILE%\.dockeriser\config.json`.
4. **Links billing.** Billing has to be linked even for the free tier (Google won't run builds without
   it; you only pay past the free amounts). One billing account: linked automatically. Several: it lists
   them and tells you to re-run with `-BillingAccount <id>`. None: it prints the link to create one.
5. **Turns on the Google services** it needs, creates the robot account, the image shelf (with cleanup)
   and the two buckets (with auto-delete), and gives the robot account its permissions.
6. **Sets the budget alert.** If your account isn't allowed to (it needs Billing Account Administrator),
   it warns and carries on.
7. **Lets dockeriser sign in as the robot account** (a second, one-time browser sign-in:
   `gcloud auth application-default login --impersonate-service-account=...`). No key file to lose.
8. **Checks everything** by running `dockeriser login`, after installing the Node packages if needed.
   Google takes a minute or two to apply new permissions, so on a first run this check can fail at
   first. The script prints "waiting for Google to apply the new permissions…" and tries again every
   15 seconds, for up to about 3 minutes. That is normal; leave it running.

Options: `-Project <id>`, `-Region <region>` (default `northamerica-northeast2`, Toronto),
`-BillingAccount <id>`, `-Budget <dollars>` (default 5, 0 = none), `-CreateKey` (see below).
Git Bash, macOS or Linux: `setup/setup.sh` takes the same options.

## Advanced: key file instead of browser sign-in

For a headless machine with no browser (e.g. a dedicated agent box), add `-CreateKey`. The script saves
`%USERPROFILE%\.dockeriser\key.json`, which dockeriser finds automatically (or set
`GOOGLE_APPLICATION_CREDENTIALS` to its path), and skips the second browser sign-in. Treat this file like
a password: anyone who has it can build and push as the robot account. It lives outside the code folder on
purpose, and `.gitignore` blocks `key.json` in case it gets copied in. Some organisations block key
creation (policy `iam.disableServiceAccountKeyCreation`); then use the normal browser sign-in.

## Getting the image

Every build pushes the image to the `docker-images` repo by itself and prints the full address with
its digest (`<region>-docker.pkg.dev/<project>/docker-images/<name>:<tag>@sha256:…`). Nothing is pulled
to your PC.

- **On a PC signed in to gcloud** (already done on Cameron's MSI), once:
  `gcloud auth configure-docker northamerica-northeast2-docker.pkg.dev`. After that,
  `docker pull <address>` works.
- **On a server or droplet**, by hand: create a service account with only
  `roles/artifactregistry.reader` on the `docker-images` repo, create a key for it, copy the key to the
  server (keep it private, `chmod 600`), then on the server:
  `cat key.json | docker login -u _json_key --password-stdin https://northamerica-northeast2-docker.pkg.dev`
  and `docker pull <address>`.

dockeriser itself doesn't SSH anywhere or deploy; running the image on a server is a separate step.

## Doing it by clicking instead (no script)

Replace `P` with your project ID and `R` with your region (`northamerica-northeast2`).

1. **APIs**: https://console.cloud.google.com/apis/library?project=P. Enable Cloud Build API, Artifact
   Registry API, Cloud Storage API, Identity and Access Management (IAM) API, IAM Service Account
   Credentials API, Cloud Logging API, Service Usage API.
2. **Robot account**: IAM & Admin > Service Accounts > Create. Name `dockeriser`.
3. **Project permissions**: IAM & Admin > IAM > Grant access. Principal
   `dockeriser@P.iam.gserviceaccount.com`. Roles: *Cloud Build Editor*, *Logs Writer*, *Service Usage Consumer*.
4. **Image shelf**: Artifact Registry > Create repository. Name `docker-images`, format Docker, region R.
   Open it > Cleanup policies: add a *Keep* policy "keep most recent versions: 10" and a *Delete* policy
   "older than 1 day, any tag state". (Keep alone deletes nothing.) Then Permissions > Add principal: the
   robot account with *Artifact Registry Writer*.
5. **Buckets**: Cloud Storage > Create. `P-dockeriser-src`, region R (single region), uniform access,
   "enforce public access prevention" on. Lifecycle: delete objects older than 1 day. Permissions: robot
   account with *Storage Object Admin*. Again for `P-dockeriser-logs`: lifecycle 30 days, permission
   *Storage Admin*.
6. **Let it run builds as itself**: Service Accounts > dockeriser > Permissions > Grant access: the robot
   account itself with *Service Account User*. Also add yourself with *Service Account Token Creator*
   (needed for the browser sign-in as the robot account).
7. **Config file**: create `%USERPROFILE%\.dockeriser\config.json`:
   ```json
   { "project": "P", "region": "R", "repo": "docker-images", "serviceAccount": "dockeriser@P.iam.gserviceaccount.com" }
   ```
8. Optional key file: Service Accounts > dockeriser > Keys > Add key > JSON. Save it as
   `%USERPROFILE%\.dockeriser\key.json`.

## Why more than "Artifact Registry Writer" and "Cloud Build Editor"

Those two are the core, but on their own a build fails. The extras, each limited as tightly as possible:

| Extra permission | Why it is needed |
|---|---|
| Storage Object Admin on the source bucket only | Your code is uploaded there and the build reads it back. |
| Storage Admin on the logs bucket only | The build writes its log there and dockeriser reads it to show you live output. Google's docs ask for Storage Admin here because the build checks the bucket itself before writing, which the smaller role can't do. |
| Service Account User on the robot account itself | Telling Cloud Build "run as this account" requires permission to use that account. Since the robot both starts and runs the build, it needs this on itself. |
| Service Usage Consumer (project) | Lets the account make API calls billed to this project. gcloud sign-ins add a "bill this project" note to each call, which needs this. |
| Logs Writer (project) | Lets builds write to Cloud Logging. Not used today (logs go to the bucket), but switching costs no new setup. |
| Service Account Token Creator for **you** on the robot account | Lets dockeriser use your Google sign-in to act as the robot account, instead of a key file. |

## Costs

**Free:**
- 2,500 build-minutes per month on the default machine (e2-standard-2). dockeriser never picks a bigger
  machine, so all builds use the free kind. The 2,500 minutes are shared by every project on your billing
  account.
- 0.5 GB of image storage in Artifact Registry. The cleanup policy keeps this small.

**Can cost money:**
- Build time past 2,500 minutes: about $0.006 per minute (billed per second). 100 extra minutes is about $0.60.
- Image storage past 0.5 GB: about $0.10 per GB per month.
- Cloud Storage for uploads and logs: tiny, and auto-deleted (1 day / 30 days).
- Network: downloading images out of Google Cloud to your PC or another cloud.

`dockeriser usage` shows minutes used, the month-end projection, and estimated cost. It is an estimate;
the real bill is at https://console.cloud.google.com/billing.

**Budget alert:** the setup script creates one called `dockeriser` ($5 a month, emails at 50/90/100%;
change with `-Budget`). To make or edit one by hand: Billing > Budgets & alerts > Create budget. A budget
warns you; it does not stop spending.

## Troubleshooting

| Error message (from dockeriser) | Cause | Fix |
|---|---|---|
| No Google Cloud project is set | Setup not run yet | Run the setup script |
| No Google credentials found | Sign-in not finished | Run the setup script again |
| GOOGLE_APPLICATION_CREDENTIALS points at … but that file does not exist | Wrong path in the variable | Fix the path or remove the variable |
| The cloudbuild.googleapis.com API is turned off | API not enabled | Click the link in the message, or re-run setup; wait a minute |
| Project … has no active billing account | Billing not linked | Run the setup script (it links billing) |
| Permission denied … (cloudbuild.builds.create) | Cloud Build Editor missing | Re-run setup |
| Permission denied … (iam.serviceAccounts.actAs) | Service Account User missing on the robot account | Re-run setup |
| Permission denied … (iam.serviceAccounts.getAccessToken) | Your account can't act as the robot account yet | Re-run setup while signed in as yourself |
| Permission denied … (serviceusage.services.use) | Service Usage Consumer missing | Re-run setup |
| The source bucket gs://…-dockeriser-src does not exist | Setup not run for this project | Re-run setup |
| … is not allowed to upload to gs://…-dockeriser-src | Storage Object Admin missing on that bucket | Re-run setup |
| Live logs unavailable … | Can't read the logs bucket | Re-run setup (Storage Admin on the logs bucket) |
| BUILD FAILURE, reason PUSH_NOT_AUTHORIZED | Artifact Registry Writer missing on the repo | Re-run setup |
| BUILD FAILURE, reason LOGGING_FAILURE | Build can't write its log | Re-run setup; check the logs bucket has no retention policy |
| BUILD FAILURE, reason FETCH_SOURCE_FAILED | Build can't read the upload | Re-run setup; if it persists, grant Storage Admin on the source bucket |
| BUILD FAILURE, reason USER_BUILD_STEP | Your Dockerfile or code failed | Read the last log lines printed (full log path is shown) |
| BUILD TIMEOUT | Build took longer than `--timeout` (default 20m) | Pass `--timeout 45m` |
| Google did not accept the credentials | Expired login or revoked key | Run the setup script again |
| gcloud: Key creation is not allowed on this service account | Organisation policy blocks keys | Run setup without `-CreateKey` |
| ✖ could not create the budget alert | Your account isn't a billing admin | Set one by hand: Billing > Budgets & alerts |
| You have more than one billing account | Script can't guess which | Re-run with the `-BillingAccount` it printed |
