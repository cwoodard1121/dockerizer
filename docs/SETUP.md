# Setting up dockeriser

This gets your Google Cloud account ready so `dockeriser build` can build Docker images on Google's
machines instead of yours. You do it once. It takes about 15 minutes.

## What you are setting up, in plain words

- A **project**: a folder in Google Cloud that holds everything below.
- A **robot account** called `dockeriser`. The tool signs in as this account, and the build runs as it.
- Two **storage folders** ("buckets"): one for the uploaded code (files deleted after 1 day) and one for
  build logs (deleted after 30 days). Both private.
- An **image shelf** ("Artifact Registry repo") called `docker-images`, where finished images go. It keeps
  the 10 newest versions of each image and clears out older ones, so you stay inside the free storage.

## Step 1. Install the Google Cloud tool

```
winget install Google.CloudSDK
```

Close and reopen your terminal so the `gcloud` command is found.

## Step 2. Sign in

```
gcloud auth login
```

A browser window opens. Pick your Google account. (From Claude Code, type `! gcloud auth login` in the
prompt. An AI agent can't do this browser step for you.)

## Step 3. Pick or create a project, and turn on billing

1. Create a project at https://console.cloud.google.com/projectcreate (or use an existing one). Note the
   **project ID** (lowercase, like `cameron-builds-123`). It is not the display name.
2. Link a billing account at https://console.cloud.google.com/billing/linkedaccount?project=YOUR-PROJECT-ID

**Billing has to be linked even if you only use the free tier.** Google won't run builds without it. You
are only charged if you go past the free amounts (see Costs below).

## Step 4. Run the setup script

From the dockeriser folder:

```
powershell -ExecutionPolicy Bypass -File setup\setup.ps1 -Project YOUR-PROJECT-ID
```

Options: `-Region us-central1` (default `northamerica-northeast2`, Toronto), `-CreateKey` (save a key
file, see Step 5). Safe to run again; it skips anything already done. Git Bash/macOS/Linux:
`setup/setup.sh -Project YOUR-PROJECT-ID`.

## Step 5. Choose how dockeriser signs in

**Option A, recommended if you have gcloud installed: sign in as the robot account.** No key file to lose.

```
gcloud auth application-default login --impersonate-service-account=dockeriser@YOUR-PROJECT-ID.iam.gserviceaccount.com
```

A browser opens once. After that, dockeriser uses your login to borrow the robot account's permissions.

**Option B, for a headless box with no browser (e.g. an agent machine): a key file.**
Re-run setup with `-CreateKey`. It saves `%USERPROFILE%\.dockeriser\key.json`, which dockeriser finds
automatically (or set `GOOGLE_APPLICATION_CREDENTIALS` to its path). Treat this file like a password:
anyone who has it can build and push as the robot account. It lives outside the code folder on purpose,
and `.gitignore` blocks `key.json` in case it gets copied in. If your organisation blocks key creation
(policy `iam.disableServiceAccountKeyCreation`), use Option A.

## Step 6. Check

```
node bin\dockeriser.js login     # tells you the next step, if any
node bin\dockeriser.js doctor    # checks every piece, with the fix for anything wrong
node bin\dockeriser.js build examples\hello --image hello
```

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
   (needed for Option A sign-in).
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
| Service Account Token Creator for **you** on the robot account | Lets you sign in as the robot account (Option A) instead of using a key file. |

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

**Set a budget alert** (emails you before surprises): Billing > Budgets & alerts > Create budget. Pick the
billing account, set an amount like $5, keep the 50/90/100% alerts. Note: a budget warns you, it does
not stop spending.

## Troubleshooting

| Error message (from dockeriser) | Cause | Fix |
|---|---|---|
| No Google Cloud project is set | No config yet | Run setup (Step 4), or pass `--project` |
| No Google credentials found | Step 5 not done | Do Step 5 (Option A or B) |
| GOOGLE_APPLICATION_CREDENTIALS points at … but that file does not exist | Wrong path in the variable | Fix the path or remove the variable |
| The cloudbuild.googleapis.com API is turned off | API not enabled | Click the link in the message, or re-run setup; wait a minute |
| Project … has no active billing account | Billing not linked | Step 3, part 2 |
| Permission denied … (cloudbuild.builds.create) | Cloud Build Editor missing | Re-run setup |
| Permission denied … (iam.serviceAccounts.actAs) | Service Account User missing on the robot account | Re-run setup |
| Permission denied … (iam.serviceAccounts.getAccessToken) | Option A sign-in without Token Creator | Re-run setup while signed in as yourself |
| Permission denied … (serviceusage.services.use) | Service Usage Consumer missing | Re-run setup |
| The source bucket gs://…-dockeriser-src does not exist | Setup not run for this project | Re-run setup |
| … is not allowed to upload to gs://…-dockeriser-src | Storage Object Admin missing on that bucket | Re-run setup |
| Live logs unavailable … | Can't read the logs bucket | Re-run setup (Storage Admin on the logs bucket) |
| BUILD FAILURE, reason PUSH_NOT_AUTHORIZED | Artifact Registry Writer missing on the repo | Re-run setup |
| BUILD FAILURE, reason LOGGING_FAILURE | Build can't write its log | Re-run setup; check the logs bucket has no retention policy |
| BUILD FAILURE, reason FETCH_SOURCE_FAILED | Build can't read the upload | Re-run setup; if it persists, grant Storage Admin on the source bucket |
| BUILD FAILURE, reason USER_BUILD_STEP | Your Dockerfile or code failed | Read the last log lines printed (full log path is shown) |
| BUILD TIMEOUT | Build took longer than `--timeout` (default 20m) | Pass `--timeout 45m` |
| Google did not accept the credentials | Expired login or revoked key | Re-run the Step 5 command |
| gcloud: Key creation is not allowed on this service account | Organisation policy blocks keys | Use Option A |
