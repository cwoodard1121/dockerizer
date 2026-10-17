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

## 5. Deploying to a server (checked 2026-10-16)

### Getting images out of Google: what it costs

- Artifact Registry bills data leaving a repository for a client outside Google (a DigitalOcean
  droplet, a home PC) at **Premium Tier internet rates**: "network traffic leaving a repository to a
  client that is not a Google product". https://cloud.google.com/artifact-registry/pricing
- Premium Tier, to North America, per account per month: **first 1 GiB free**, then **$0.12/GiB** up to
  1 TiB, $0.11/GiB to 10 TiB, $0.08/GiB above. The 200 GiB/month free allowance is Standard Tier only and
  does not apply. https://cloud.google.com/vpc/network-pricing
- Cloud Build: "Network egress will be charged according to standard rates", so a build that pushes to
  an outside registry pays the same egress. https://cloud.google.com/build/pricing
- Only changed layers move. A pull by digest downloads only layers the server lacks; dockeriser's ssh
  transfer skips an image the server already has (same content tag) but otherwise sends the whole image
  through the PC, so for big, often-changing images `--transfer pull` moves fewer bytes.
- Example: a 300 MB image where each deploy changes 40 MB of layers, deployed 60 times a month: pull
  transfer ≈ 2.4 GB ≈ $0.17; ssh transfer of the full image ≈ 18 GB ≈ $2.04 (minus the free 1 GiB).

### DigitalOcean Container Registry (DOCR) instead?

| Plan | Price | Repos | Storage | Overage |
|---|---|---|---|---|
| Starter | $0 | 1 | 500 MiB | none |
| Basic | $5/mo | 5 | 5 GiB | $0.02/GiB |
| Professional | $20/mo | unlimited | 100 GiB | $0.02/GiB |

Sources: https://www.digitalocean.com/pricing/container-registry,
https://docs.digitalocean.com/products/container-registry/details/pricing/. DOCR's pages say nothing
about bandwidth; DigitalOcean's bandwidth docs say inbound transfer to Droplets is free
(https://docs.digitalocean.com/platform/billing/bandwidth/), so a droplet pulling from DOCR should cost
nothing on the DO side (inferred, not stated outright).

**Decision: stay on Artifact Registry.** Cloud Build would still push every changed layer out of
Google (same ~$0.12/GiB), and DOCR adds $5-20 a month (Starter's one repository and 500 MiB is too
small for multi-image projects). It only pays off when many droplets pull the same images. No DOCR
target was built.

### `docker load` of an archive built from registry blobs

- moby's loader (`daemon/internal/image/tarexport/load.go`) untars the whole archive to a temp folder
  before reading `manifest.json` (`chrootarchive.Untar(...)`), so entry order does not matter, and
  passes each layer file through `compression.DecompressStream(...)`, which detects gzip (and zstd,
  xz, bzip2). So registry layers can go in as-is, still compressed: no local Docker and no
  decompression on the PC. The layer digests the config lists (`rootfs.diff_ids`) are checked against
  the decompressed data by Docker itself.
  https://github.com/moby/moby/blob/master/daemon/internal/image/tarexport/load.go
- With the containerd image store (the default on new Docker installs), `docker load` goes through
  containerd's archive importer, which also reads docker-save archives and detects layer compression.
  Not yet tried against a live server; `dockeriser server check` plus a first deploy of a small image
  will show it.
- `docker load` does not record a registry digest, so dockeriser tags each image it loads as
  `<repository>:dk-<first 12 hex of the digest>` and uses that tag to tell whether the server already
  has the image.
- Registry API: Artifact Registry accepts a Google access token as a bearer token on
  `https://<region>-docker.pkg.dev/v2/...`; dockeriser also handles the standard 401 challenge by
  exchanging it with basic auth `oauth2accesstoken:<token>`, the way `docker login` does.

## 6. Parallel builds and image cleanup (checked 2026-10-16)

- **Steps in one build share one worker.** `waitFor: ['-']` starts a step "immediately", so steps can
  run concurrently, but they run on the build's single worker VM (e2-standard-2 by default, 2 vCPUs).
  Source: https://docs.cloud.google.com/build/docs/configuring-builds/configure-build-step-order
  So independent images go to **separate builds** (one machine each), sharing one uploaded source.
- **Concurrent builds:** the default pool allows "10 - 30" concurrent builds per project (global, not
  per region), and the quota cannot be raised. Source: https://docs.cloud.google.com/build/quotas
  dockeriser starts one build per group of dependent images, a handful at most.
- **Minutes:** builds are billed per second each, so N parallel builds cost about the same minutes as
  one sequential run plus each build's start-up and cache pull.
- **`gcloud artifacts repositories set-cleanup-policies`** "sets or updates" policies: a rule with a
  name the file doesn't mention stays. `dockeriser cleanup` therefore removes an older
  `keep-N-most-recent` rule with `delete-cleanup-policies --policynames=…` (gcloud 589.0.0). Two
  Keep rules would be harmless anyway (a version kept by any Keep rule is kept), only confusing.
- **Versions** come from `gcloud artifacts docker images list <repo> --include-tags --format=json`:
  `package`, `version` (the digest), `tags` (a list), `createTime`, `metadata.imageSizeBytes`.
  Image sizes overlap (shared layers), so "bytes freed" is an upper bound.

## 7. CI on spot VMs (checked 2026-10-16)

- **Prices** from the Cloud Billing catalogue API (Compute Engine, service `6F81-5844-456A`, `skus` list,
  effective 2026-10-16T07:00Z), Toronto: "Spot Preemptible E2 Instance Core" $0.005/h, "Spot
  Preemptible E2 Instance Ram" $0.000668/GiB-h (on demand: $0.024013 and $0.003218), "Balanced PD
  Capacity" $0.11/GiB-month, "External IP Charge on a Spot Preemptible VM" $0.0025/h (global SKU). So
  e2-standard-4 spot = $0.030688/h; with 40 GiB balanced disk and the IP, $0.0392/h.
- **Quota** in `freebuilds`, northamerica-northeast2: `E2_CPUS` 24, `CPUS` 100,
  `PREEMPTIBLE_CPUS` 0 (spot VMs then count against the normal CPU quota), `IN_USE_ADDRESSES` 8. Hence at most 4
  e2-standard-4 CI VMs at once.
- **gcloud 589**: `compute instances create` takes `--provisioning-model=SPOT`,
  `--instance-termination-action=DELETE` (applies on preemption *and* on automatic termination) and
  `--max-run-duration` ("relative to the last time when the VM began running"). A guest
  `shutdown -h` only stops the VM (status TERMINATED; the disk is still billed), so dockeriser deletes it.
  Image family `ubuntu-2404-lts-amd64` in `ubuntu-os-cloud` (10 GB image).
- **Ubuntu 24.04 packages** `docker.io` and `docker-compose-v2` give `docker compose` without the
  get.docker.com script.

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
