# Research notes (checked 2026-10-16)

Facts the code depends on, with the official source for each. `cloud.google.com/build/docs/...` now
redirects to `docs.cloud.google.com/build/docs/...`; both URLs are the same page.

## 1. Free tier and pricing

- **Free allowance:** "Each billing account comes with 2,500 free build-minutes per month." Footnote:
  "This promotional free tier is for e2-standard-2 machine types in the default pool, and the limit is
  subject to change." No region is excluded. Source: https://cloud.google.com/build/pricing
- **Price after the free tier:** e2-standard-2 is **$0.006 per build-minute** (global table). Stored in
  `src/pricing.js` (`BUILD_PRICE_PER_MINUTE_USD`). Source: same page.
- **Billing rounding:** "A build-minute is incurred every minute that a build is in process. Partial
  minutes are billed at the actual number of seconds consumed." and "Build-minutes are not incurred for
  the time that a build is queued." Source: same page.
- **Region:** `northamerica-northeast2` (Toronto) is a Cloud Build region and "Cloud Build supports
  regional builds in private pools and default pools". Source: https://docs.cloud.google.com/build/docs/locations
  So the default region stays Toronto.
- **What the CLI does:** never sets `options.machineType` or `options.pool`, so builds use the default
  e2-standard-2 machine in the default pool, which is what the free tier covers.
- **Artifact Registry storage:** first 0.5 GiB-month per billing account free, then **$0.10 per
  GiB-month** (same for regional and multi-regional repos). Source: https://cloud.google.com/artifact-registry/pricing
- **Repo size field:** `Repository.sizeBytes` (string, int64): "Output only. The size, in bytes, of all
  artifact storage in this repository." Source:
  https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories

## 2. Service accounts and logging

- **Default build service account:** "Cloud Build now uses the Compute Engine default service account as
  the default service account" (rolled out May and June 2024, applies to projects on their first build
  after the change). Source: https://docs.cloud.google.com/build/docs/cloud-build-service-account-updates
  dockeriser does not rely on that account: every build sets `serviceAccount` explicitly.
- **User-specified service account needs a log destination.** With your own service account you "must
  store your build logs" in a Cloud Storage bucket in your project or in Cloud Logging:
  - Cloud Storage: set `options.logging` to `GCS_ONLY` and the top-level `logsBucket` to `gs://bucket`.
  - Cloud Logging: set `options.logging` to `CLOUD_LOGGING_ONLY`.
  - The bucket must not have a retention policy (a lifecycle delete rule is not a retention policy), and
    Google-owned log buckets can't be used.
  Source: https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts
- **What the CLI does:** `logsBucket: gs://<PROJECT>-dockeriser-logs` + `options.logging: 'GCS_ONLY'`.
  `GCS_ONLY` is what makes the log object `log-<BUILD_ID>.txt` exist, which is how logs are streamed.
  `options.defaultLogsBucketBehavior: REGIONAL_USER_OWNED_BUCKET` is the alternative when you do not pass
  `logsBucket` (Cloud Build then makes a bucket for you); it is not needed because we pass `logsBucket`.
- **Logs bucket region and role:** "ensure that your user-created bucket has the same region as your
  build", and for a user-created bucket the build's service account needs **Storage Admin
  (`roles/storage.admin`)** on it. Source: https://docs.cloud.google.com/build/docs/securing-builds/store-manage-build-logs
- Enum values confirmed in the installed package (`@google-cloud/cloudbuild` 6.2.0, `protos.d.ts`):
  `LoggingMode { LEGACY, GCS_ONLY, STACKDRIVER_ONLY, CLOUD_LOGGING_ONLY, NONE }`,
  `DefaultLogsBucketBehavior { REGIONAL_USER_OWNED_BUCKET, LEGACY_BUCKET }`.

## 3. Client library (`@google-cloud/cloudbuild` 6.2.0, read from the installed `.d.ts`)

- `createBuild({parent: 'projects/P/locations/R', projectId, build})` resolves to
  `[LROperation<IBuild, IBuildOperationMetadata>, ...]`. The doc comment says the operation "includes the
  build ID". `IBuildOperationMetadata` is `{ build?: IBuild }`; google-gax decodes it in the operation
  constructor (`_unpackResponse`), so `operation.metadata.build.id` is available immediately without
  calling `operation.promise()`.
- `getBuild({name: 'projects/P/locations/R/builds/ID'})` and `cancelBuild({name})` both resolve to
  `[IBuild, ...]`. `listBuildsAsync({parent, projectId, filter, pageSize})` iterates every page.
- google-gax loads protos with `enums: String` and `longs: String`, so `status` arrives as `'SUCCESS'` and
  timestamp `seconds` as strings. The code accepts numbers too.
- Build list filter syntax: `create_time>"2016-10-12T18:43:49+00:00" AND finish_time<"..."`; `>`/`>=`/`<`
  work on `create_time`. Source: https://docs.cloud.google.com/build/docs/view-build-results
- `@google-cloud/storage` 8.4.0: `DownloadOptions extends CreateReadStreamOptions` with `start`/`end`, so
  `file.download({start, validation: false})` does a ranged read. A start past the end returns HTTP 416,
  which the tailer treats as "nothing new".

## 4. IAM: what each step needs

| Step | Permission | Role granted by setup | Source |
|---|---|---|---|
| Create, get, cancel, list builds | `cloudbuild.builds.create`, `.get`, `.update`, `.list` | `roles/cloudbuild.builds.editor` (project) | https://docs.cloud.google.com/build/docs/iam-roles-permissions |
| Call the APIs as this account (quota project) | `serviceusage.services.use` | `roles/serviceusage.serviceUsageConsumer` (project) | https://docs.cloud.google.com/build/docs/securing-builds/configure-access-to-resources |
| Run a build as a user-specified SA | `iam.serviceAccounts.actAs` on that SA | `roles/iam.serviceAccountUser` (on the SA itself) | https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts and the trigger docs: "Any user with the Cloud Build Editor role who has the iam.serviceAccounts.actAs permission…" |
| Upload source; build reads source | `storage.objects.create`, `.get`, `.list` | `roles/storage.objectAdmin` (source bucket only) | https://docs.cloud.google.com/storage/docs/access-control/iam-roles |
| Build writes its log; CLI reads it | bucket metadata + objects | `roles/storage.admin` (logs bucket only) | store-manage-build-logs page above; `objectAdmin` has no `storage.buckets.get` (IAM roles page) |
| Push (and pull the cache image) | `artifactregistry.repositories.uploadArtifacts`, downloads | `roles/artifactregistry.writer` (repo only) | https://docs.cloud.google.com/artifact-registry/docs/access-control |
| Write logs to Cloud Logging | `logging.logEntries.create` | `roles/logging.logWriter` (project) | kept from the design; not used while logging is `GCS_ONLY`, but lets you switch to `CLOUD_LOGGING_ONLY` without new grants |
| You signing in as the SA (impersonation) | `iam.serviceAccounts.getAccessToken` | `roles/iam.serviceAccountTokenCreator` for your user, on the SA | needed for `gcloud auth application-default login --impersonate-service-account` |

APIs enabled by setup: `cloudbuild`, `artifactregistry`, `storage`, `iam`, `iamcredentials` (impersonation
tokens), `logging`, `serviceusage`.

## Deviations from the original design (and why)

1. **Logs bucket gets `roles/storage.admin`, not `storage.objectAdmin`.** The logs page names Storage
   Admin for user-created log buckets, and `objectAdmin` lacks `storage.buckets.get`. It is granted on that
   one bucket only. The source bucket keeps `objectAdmin`; if a build ever fails with
   `FETCH_SOURCE_FAILED`, the CLI's hint says to grant Storage Admin there too.
2. **Added `roles/serviceusage.serviceUsageConsumer`.** Cloud Build Editor alone lacks
   `serviceusage.services.use`, which the docs say users of the Cloud Build tools need. It matters most
   for impersonation: gcloud's ADC file carries a `quota_project_id`, so requests name a quota project
   and the caller needs this permission.
3. **Added `roles/iam.serviceAccountTokenCreator` for the signed-in human, plus the `iamcredentials`
   API,** so the recommended impersonation sign-in works.
4. **Artifact Registry cleanup has two rules.** A Keep rule alone deletes nothing ("Keep policies work
   with delete policies"), so setup writes Keep (10 most recent versions) + Delete (`olderThan: 1d`,
   `tagState: any`). Source: https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy
5. **Build-minutes are billed per second, not rounded up per build.** The pricing page says partial
   minutes are billed by the second. So `buildMinutes` in the build result and all `usage` numbers use
   exact seconds / 60. The task asked for ceil per build; the docs say otherwise.

## Can only be verified with real credentials

- That `gcr.io/cloud-builders/docker` honours `DOCKER_BUILDKIT=1` + `BUILDKIT_INLINE_CACHE=1` and
  `--cache-from` (needs buildx in the builder image).
- Whether the final lines of `log-<ID>.txt` always land before the build status turns terminal (the
  tailer retries up to 5 times after the status changes, stopping early on the closing `DONE`/`ERROR` line).
- That Storage Admin on the logs bucket and Object Admin on the source bucket are enough for this
  account in practice, with no extra project-level storage grant.
- `serviceusage.services.use` being required in practice for key-file auth (granted either way).
- Setup script parts that need a real gcloud session: the `gcloud billing accounts list` output format
  (`name` with or without the `billingAccounts/` prefix; both handled), `gcloud billing budgets create`
  with `--budget-amount` given without a currency (meant to use the billing account's own currency) and
  `--billing-project` as the quota project, and the ADC impersonation check reading
  `service_account_impersonation_url` from `%APPDATA%\gcloud\application_default_credentials.json`.
