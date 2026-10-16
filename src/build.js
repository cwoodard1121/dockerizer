/**
 * Cloud Build request construction, submission, status polling and result summaries.
 * The request deliberately never sets options.machineType: the free tier only covers the
 * default e2-standard-2 machine in the default pool.
 */

import { ConfigError, isTransient, mapGoogleError } from './errors.js';
import { sleep as defaultSleep } from './logs.js';

export const DOCKER_BUILDER = 'gcr.io/cloud-builders/docker';
export const BUILD_TAG = 'dockeriser';
export const MAX_TIMEOUT_SEC = 24 * 60 * 60;

export const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILURE', 'TIMEOUT', 'CANCELLED', 'INTERNAL_ERROR', 'EXPIRED']);
const STATUS_BY_NUMBER = ['STATUS_UNKNOWN', 'QUEUED', 'WORKING', 'SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED', 'PENDING'];
const FAILURE_TYPES = ['FAILURE_TYPE_UNSPECIFIED', 'PUSH_FAILED', 'PUSH_IMAGE_NOT_FOUND', 'PUSH_NOT_AUTHORIZED', 'LOGGING_FAILURE', 'USER_BUILD_STEP', 'FETCH_SOURCE_FAILED'];

/** Extra hints for Cloud Build failure types that point at setup problems. */
const FAILURE_HINTS = {
  PUSH_NOT_AUTHORIZED: 'The build account cannot push to Artifact Registry. Grant it "Artifact Registry Writer" on the repo (re-run setup/setup.ps1).',
  PUSH_IMAGE_NOT_FOUND: 'The image was not produced, so there was nothing to push. Check the build step output above.',
  PUSH_FAILED: 'Pushing to Artifact Registry failed. Check that the repo exists in this region (`dockeriser doctor`).',
  LOGGING_FAILURE: 'The build could not write its log. Grant the build account "Storage Admin" on the logs bucket (re-run setup/setup.ps1).',
  FETCH_SOURCE_FAILED: 'The build could not read the uploaded source. Grant the build account "Storage Object Admin" on the source bucket; if that is already in place, grant "Storage Admin" on it.',
};

/**
 * Normalise a status that may arrive as a string ('SUCCESS') or enum number (3).
 * @param {string|number|null|undefined} status
 * @returns {string}
 */
export function statusName(status) {
  if (typeof status === 'number') return STATUS_BY_NUMBER[status] || 'STATUS_UNKNOWN';
  return status || 'STATUS_UNKNOWN';
}

/**
 * Parse --timeout: "20m", "1h", "90s", "1h30m" or a bare number of seconds.
 * @param {string|number} value
 * @returns {number} seconds
 */
export function parseTimeout(value) {
  const text = String(value).trim().toLowerCase();
  let seconds;
  if (/^\d+$/.test(text)) {
    seconds = Number(text);
  } else {
    const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m || !text) throw new ConfigError(`--timeout "${value}" is not a duration.`, { fix: 'Use e.g. 20m, 1h, 90s or 1h30m.' });
    seconds = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }
  if (seconds < 1 || seconds > MAX_TIMEOUT_SEC) {
    throw new ConfigError(`--timeout must be between 1s and 24h (got "${value}").`);
  }
  return seconds;
}

/**
 * Validate --build-arg values (KEY=VALUE, or KEY alone to pass through an empty value).
 * @param {string[]} [args]
 * @returns {string[]}
 */
export function parseBuildArgs(args = []) {
  return args.map((arg) => {
    const key = arg.split('=')[0];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigError(`--build-arg "${arg}" must look like KEY=VALUE.`);
    }
    return arg;
  });
}

/**
 * Build the CreateBuild request.
 *
 * @param {object} opts
 * @param {string} opts.project
 * @param {string} opts.region
 * @param {string} opts.serviceAccount Service account email that runs the build.
 * @param {string} opts.logsBucket Logs bucket name (no gs://).
 * @param {{bucket: string, object: string, generation?: string}} opts.source Uploaded tarball.
 * @param {string} opts.repository Image path without tag.
 * @param {string[]} opts.refs Every image:tag to produce (includes :latest).
 * @param {string} opts.dockerfile Dockerfile path relative to the source root (POSIX).
 * @param {string[]} [opts.buildArgs] Validated KEY=VALUE strings.
 * @param {boolean} [opts.noCache]
 * @param {number} opts.timeoutSec
 * @returns {{parent: string, projectId: string, build: object}}
 */
export function buildRequest({ project, region, serviceAccount, logsBucket, source, repository, refs, dockerfile, buildArgs = [], noCache = false, timeoutSec }) {
  const cacheRef = `${repository}:latest`;
  const dockerArgs = ['build'];
  if (noCache) dockerArgs.push('--no-cache');
  else dockerArgs.push('--cache-from', cacheRef);
  dockerArgs.push('--build-arg', 'BUILDKIT_INLINE_CACHE=1');
  for (const arg of buildArgs) dockerArgs.push('--build-arg', arg);
  for (const ref of refs) dockerArgs.push('-t', ref);
  dockerArgs.push('-f', dockerfile, '.');

  const steps = [];
  if (!noCache) {
    steps.push({
      id: 'pull-cache',
      name: DOCKER_BUILDER,
      entrypoint: 'bash',
      args: ['-c', `docker pull ${cacheRef} || true`],
    });
  }
  steps.push({ id: 'build', name: DOCKER_BUILDER, env: ['DOCKER_BUILDKIT=1'], args: dockerArgs });

  const storageSource = { bucket: source.bucket, object: source.object };
  if (source.generation) storageSource.generation = source.generation;

  return {
    parent: `projects/${project}/locations/${region}`,
    projectId: project,
    build: {
      source: { storageSource },
      steps,
      images: refs,
      timeout: { seconds: timeoutSec },
      serviceAccount: `projects/${project}/serviceAccounts/${serviceAccount}`,
      logsBucket: `gs://${logsBucket}`,
      options: { logging: 'GCS_ONLY' },
      tags: [BUILD_TAG],
    },
  };
}

/**
 * Build the CreateBuild request for several images in ONE build, in order. The docker daemon on the
 * build VM keeps images between steps, so an image tagged with `localTag` can be used by a later
 * image's `FROM`. Pushed images get the registry cache (`--cache-from <repo>:latest`).
 *
 * @param {object} opts Same as buildRequest, except instead of repository/refs/dockerfile/buildArgs:
 * @param {Array<{name: string, repository: string|null, refs: string[], dockerfile: string, context: string,
 *   buildArgs: string[], localTag: string|null, push: boolean}>} opts.images
 * @returns {{parent: string, projectId: string, build: object}}
 */
export function buildRequestMulti({ project, region, serviceAccount, logsBucket, source, images, noCache = false, timeoutSec }) {
  const steps = [];
  const pushed = [];
  for (const img of images) {
    const cacheRef = img.push && img.repository ? `${img.repository}:latest` : null;
    const dockerArgs = ['build'];
    if (noCache) dockerArgs.push('--no-cache');
    else if (cacheRef) dockerArgs.push('--cache-from', cacheRef);
    dockerArgs.push('--build-arg', 'BUILDKIT_INLINE_CACHE=1');
    for (const arg of img.buildArgs || []) dockerArgs.push('--build-arg', arg);
    const tags = [...(img.push ? img.refs : []), ...(img.localTag ? [img.localTag] : [])];
    for (const ref of tags) dockerArgs.push('-t', ref);
    dockerArgs.push('-f', img.dockerfile, img.context || '.');
    if (cacheRef && !noCache) {
      steps.push({ id: `pull-cache-${img.name}`, name: DOCKER_BUILDER, entrypoint: 'bash', args: ['-c', `docker pull ${cacheRef} || true`] });
    }
    steps.push({ id: `build-${img.name}`, name: DOCKER_BUILDER, env: ['DOCKER_BUILDKIT=1'], args: dockerArgs });
    if (img.push) pushed.push(...img.refs);
  }
  const storageSource = { bucket: source.bucket, object: source.object };
  if (source.generation) storageSource.generation = source.generation;
  const build = {
    source: { storageSource },
    steps,
    timeout: { seconds: timeoutSec },
    serviceAccount: `projects/${project}/serviceAccounts/${serviceAccount}`,
    logsBucket: `gs://${logsBucket}`,
    options: { logging: 'GCS_ONLY' },
    tags: [BUILD_TAG],
  };
  if (pushed.length) build.images = pushed;
  return { parent: `projects/${project}/locations/${region}`, projectId: project, build };
}

/**
 * Submit the build and return its id straight from the operation metadata (no LRO wait).
 * @param {object} opts
 * @param {import('@google-cloud/cloudbuild').CloudBuildClient} opts.cloudBuild Injected client.
 * @param {ReturnType<typeof buildRequest>} opts.request
 * @param {object} [opts.ctx] Context for error messages.
 * @returns {Promise<{id: string, name: string, logUrl?: string}>}
 */
export async function submitBuild({ cloudBuild, request, ctx = {} }) {
  let operation;
  try {
    [operation] = await cloudBuild.createBuild(request);
  } catch (err) {
    throw mapGoogleError(err, { ...ctx, action: 'start the build' });
  }
  const build = operation?.metadata?.build;
  if (!build?.id) {
    throw mapGoogleError(new Error(`Cloud Build accepted the request but returned no build id (operation ${operation?.name}).`), ctx);
  }
  const parent = request.parent;
  return { id: build.id, name: build.name || `${parent}/builds/${build.id}`, logUrl: build.logUrl || undefined };
}

/**
 * Poll getBuild until the build reaches a terminal status.
 * @param {object} opts
 * @param {import('@google-cloud/cloudbuild').CloudBuildClient} opts.cloudBuild
 * @param {string} opts.name projects/P/locations/R/builds/ID
 * @param {(build: object) => void} [opts.onUpdate] Called after every poll.
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.intervalMs=2000]
 * @param {number} [opts.maxTransientErrors=5] Consecutive network errors tolerated.
 * @param {object} [opts.ctx]
 * @returns {Promise<object>} The final Build.
 */
export async function waitForBuild({ cloudBuild, name, onUpdate = () => {}, sleep = defaultSleep, intervalMs = 2000, maxTransientErrors = 5, ctx = {} }) {
  let errors = 0;
  for (;;) {
    try {
      const [build] = await cloudBuild.getBuild({ name });
      errors = 0;
      onUpdate(build);
      if (TERMINAL_STATUSES.has(statusName(build.status))) return build;
    } catch (err) {
      if (!isTransient(err) || ++errors > maxTransientErrors) throw mapGoogleError(err, { ...ctx, action: 'check the build status' });
    }
    await sleep(intervalMs);
  }
}

/**
 * Ask Cloud Build to cancel a running build.
 * @param {import('@google-cloud/cloudbuild').CloudBuildClient} cloudBuild
 * @param {string} name projects/P/locations/R/builds/ID
 * @returns {Promise<object>} The build as returned by the API.
 */
export async function cancelBuild(cloudBuild, name) {
  const [build] = await cloudBuild.cancelBuild({ name });
  return build;
}

/**
 * Cloud console link for a build.
 * @param {string} region
 * @param {string} id
 * @param {string} project
 */
export function consoleUrl(region, id, project) {
  return `https://console.cloud.google.com/cloud-build/builds;region=${region}/${id}?project=${project}`;
}

/** Seconds since epoch from a protobuf Timestamp (seconds may be a string). */
function tsSeconds(ts) {
  if (!ts || ts.seconds === undefined || ts.seconds === null) return undefined;
  return Number(ts.seconds) + (ts.nanos || 0) / 1e9;
}

/**
 * The step that broke the build, if any.
 * @param {object} build
 * @returns {{index: number, id?: string, name: string, status: string, args: string}|null}
 */
export function findFailedStep(build) {
  const steps = build?.steps || [];
  const bad = ['FAILURE', 'TIMEOUT', 'INTERNAL_ERROR', 'CANCELLED', 'EXPIRED'];
  let index = steps.findIndex((s) => ['FAILURE', 'TIMEOUT'].includes(statusName(s.status)));
  if (index < 0) index = steps.findIndex((s) => bad.includes(statusName(s.status)));
  if (index < 0) return null;
  const step = steps[index];
  const args = [step.entrypoint, ...(step.args || [])].filter(Boolean).join(' ');
  return {
    index,
    id: step.id || undefined,
    name: step.name,
    status: statusName(step.status),
    args: args.length > 160 ? `${args.slice(0, 157)}...` : args,
  };
}

/**
 * Process exit code for a terminal build status.
 * @param {string} status
 * @returns {number}
 */
export function exitCodeForStatus(status) {
  return statusName(status) === 'SUCCESS' ? 0 : 1;
}

/**
 * Normalise failureInfo (type may arrive as an enum number) and attach a setup hint.
 * @param {object} build
 * @returns {{type: string, detail: string, hint?: string}|null}
 */
export function failureInfo(build) {
  const info = build?.failureInfo;
  if (!info || (!info.type && !info.detail)) {
    return build?.statusDetail ? { type: 'FAILURE_TYPE_UNSPECIFIED', detail: build.statusDetail } : null;
  }
  const type = typeof info.type === 'number' ? FAILURE_TYPES[info.type] || String(info.type) : info.type || 'FAILURE_TYPE_UNSPECIFIED';
  const out = { type, detail: info.detail || '' };
  if (FAILURE_HINTS[type]) out.hint = FAILURE_HINTS[type];
  return out;
}

/**
 * Summarise a finished build into the shape printed by --json.
 * @param {object} build Final Build from getBuild.
 * @param {object} ctx
 * @param {string} ctx.project
 * @param {string} ctx.region
 * @param {string|null} [ctx.logFile] Saved full log (failures only).
 * @param {string[]} [ctx.tail] Last log lines.
 * @param {string[]} [ctx.refs] Requested image:tag refs; other entries in results.images (such as the
 *   untagged repository name Cloud Build also reports) are dropped.
 * @param {number} [ctx.fallbackDurationSec] Used when the API timestamps are missing.
 */
export function summarizeBuild(build, { project, region, logFile = null, tail = [], refs, fallbackDurationSec }) {
  const status = statusName(build.status);
  const start = tsSeconds(build.startTime) ?? tsSeconds(build.createTime);
  const finish = tsSeconds(build.finishTime);
  const exactSec = start !== undefined && finish !== undefined ? Math.max(0, finish - start) : fallbackDurationSec || 0;
  const durationSec = Math.round(exactSec);
  const failed = status !== 'SUCCESS';
  return {
    status,
    buildId: build.id,
    images: (build.results?.images || [])
      .filter((img) => !refs || refs.includes(img.name))
      .map((img) => ({ name: img.name, digest: img.digest })),
    durationSec,
    buildMinutes: Math.round((exactSec / 60) * 100) / 100, // billed per second, see docs/RESEARCH.md
    consoleUrl: consoleUrl(region, build.id, project),
    logFile: failed ? logFile : null,
    failedStep: failed ? findFailedStep(build) : null,
    failureInfo: failed ? failureInfo(build) : null,
    errorTail: failed ? tail.slice(-50) : [],
  };
}
