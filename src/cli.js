/**
 * Command-line front end. `run()` takes every side effect as a dependency so tests can drive it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyCredentials, resolveConfig, resolveCredentials, resourceNames } from './config.js';
import { AuthError, ConfigError, DockeriserError, EXIT, mapGoogleError } from './errors.js';
import { defaultTag, expandImage } from './image.js';
import { cleanupTempFiles, packageSource, removeTarball } from './package-source.js';
import { sourceObjectName, uploadSource } from './upload.js';
import { buildRequest, cancelBuild, consoleUrl, exitCodeForStatus, parseBuildArgs, parseTimeout, statusName, submitBuild, summarizeBuild, waitForBuild } from './build.js';
import { LogTailer, sleep as realSleep } from './logs.js';
import { createOutput, formatBytes, formatDuration } from './output.js';
import { printDoctor, runDoctor } from './doctor.js';
import { runLogin } from './login.js';
import { SETUP_SCRIPT, formatSteps, getOfflineStatus, nextSteps } from './status.js';
import {
  arStorageSummary, cacheFromTotals, fetchBuildTotals, fetchRepoSize, formatUsageReport, monthRange,
  projectUsage, readUsageCache, recordBuild, summaryFromCache, usageLine, writeUsageCache,
} from './usage.js';
import { createClients as realCreateClients } from './clients.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const USAGE = `dockeriser ${VERSION} - build Docker images on Google Cloud Build instead of locally

Usage:
  dockeriser build <dir> --image <name>[:<tag>] [options]
  dockeriser login                       say what (if anything) is left to sign in
  dockeriser usage [--month YYYY-MM]     free build-minutes used this month, projection, cost
  dockeriser status --offline            instant local check (no network): set up? credentials? usage
  dockeriser doctor                      check every piece of setup online, with fixes
  dockeriser --help | --version
  (login, usage, status and doctor also take --json, --project, --region, --repo)

Build options:
  -i, --image <ref>        myapp[:tag] (pushed to <region>-docker.pkg.dev/<project>/<repo>/myapp)
                           or a full <region>-docker.pkg.dev/... reference
  -t, --tag <tag>          extra tag (repeatable). :latest is always pushed too.
                           Default tag: short git SHA if <dir> is clean in git, else UTC YYYYMMDD-HHMMSS
  -f, --dockerfile <path>  Dockerfile relative to <dir> (default: Dockerfile)
      --build-arg K=V      passed to docker build (repeatable)
      --timeout <dur>      build timeout, e.g. 20m, 1h, 90s (default: 20m)
      --no-cache           build without the registry cache
      --dry-run            package locally and print the Cloud Build request; no network calls
      --json               print one JSON result on stdout (logs and messages go to stderr)
      --project <id>       Google Cloud project   (env DOCKERISER_PROJECT, or ~/.dockeriser/config.json)
      --region <region>    build + registry region (default: northamerica-northeast2)
      --repo <name>        Artifact Registry repo  (default: docker-images)
      --debug              show stack traces

Exit codes: 0 success, 1 build failed, 2 config/input error, 3 credentials/permission error,
            4 upload error, 130 interrupted (build cancelled).`;

const OPTIONS = {
  image: { type: 'string', short: 'i' },
  tag: { type: 'string', short: 't', multiple: true },
  dockerfile: { type: 'string', short: 'f' },
  'build-arg': { type: 'string', multiple: true },
  timeout: { type: 'string', default: '20m' },
  'no-cache': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  project: { type: 'string' },
  region: { type: 'string' },
  repo: { type: 'string' },
  debug: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
  month: { type: 'string' },
  offline: { type: 'boolean', default: false },
};

/** Default process hooks for SIGINT; tests replace this. */
function onSigint(handler) {
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

/**
 * Run the CLI.
 * @param {string[]} argv Arguments after the script name.
 * @param {object} [deps] Injected side effects (all optional).
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {NodeJS.WritableStream} [deps.stdout]
 * @param {NodeJS.WritableStream} [deps.stderr]
 * @param {string} [deps.homeDir]
 * @param {typeof realCreateClients} [deps.createClients]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => Date} [deps.now]
 * @param {(handler: () => void) => () => void} [deps.onSigint]
 * @param {(code: number) => never} [deps.exit]
 * @param {string} [deps.tmpDir]
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv, deps = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    homeDir = os.homedir(),
    createClients = realCreateClients,
    sleep = realSleep,
    now = () => new Date(),
    tmpDir = os.tmpdir(),
    exit = (code) => process.exit(code),
  } = deps;
  const sigint = deps.onSigint || onSigint;

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    const out = createOutput({ json: argv.includes('--json'), stdout, stderr, env });
    return fail(out, new ConfigError(err.message, { fix: 'Run `dockeriser --help` for usage.' }), argv.includes('--json'));
  }
  const { values: flags, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (flags.version) {
    stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (flags.help || !command) {
    (command || flags.help ? stdout : stderr).write(`${USAGE}\n`);
    return flags.help ? EXIT.OK : EXIT.CONFIG;
  }

  const handlers = { doctor: doctorCommand, usage: usageCommand, status: statusCommand, login: loginCommand };
  if (handlers[command]) {
    const out = createOutput({ json: flags.json, stdout, stderr, env });
    try {
      return await handlers[command]({ flags, out, env, homeDir, now: now(), createClients });
    } catch (err) {
      return fail(out, err instanceof DockeriserError ? err : mapGoogleError(err), flags.json, flags.debug);
    }
  }
  if (command !== 'build') {
    const out = createOutput({ json: flags.json, stdout, stderr, env });
    return fail(out, new ConfigError(`Unknown command "${command}".`, { fix: 'Commands: build, login, usage, status, doctor. Run `dockeriser --help`.' }), flags.json);
  }

  // Dry runs keep stdout for the request JSON only.
  const out = createOutput({ json: flags.json || flags['dry-run'], stdout, stderr, env });
  const state = { interrupted: false, buildName: null, phase: 'local', cancelPromise: null };
  let ctx = {};

  const removeSigint = sigint(() => {
    if (state.interrupted || !state.buildName) {
      if (state.phase === 'submitting' && !state.interrupted) {
        state.interrupted = true; // cancel as soon as the build id arrives
        out.warn('cancelling build… (press Ctrl-C again to quit without cancelling)');
        return;
      }
      cleanupTempFiles();
      exit(EXIT.INTERRUPTED);
      return;
    }
    state.interrupted = true;
    out.warn('cancelling build… (press Ctrl-C again to quit without waiting)');
    state.cancelPromise = requestCancel();
  });
  let clients;
  const requestCancel = () =>
    cancelBuild(clients.cloudBuild, state.buildName).catch((err) => {
      out.error(mapGoogleError(err, { ...ctx, action: 'cancel the build' }), flags.debug);
      exit(EXIT.INTERRUPTED);
    });

  try {
    const [dir] = rest;
    if (!dir) throw new ConfigError('Missing <dir>.', { fix: 'Usage: dockeriser build <dir> --image <name>[:<tag>]' });
    if (rest.length > 1) throw new ConfigError(`Unexpected extra argument "${rest[1]}".`, { fix: 'Pass one folder; quote paths with spaces.' });

    const cfg = resolveConfig({ flags, env, homeDir });
    ctx = { project: cfg.project, region: cfg.region, serviceAccount: cfg.serviceAccount };
    const timeoutSec = parseTimeout(flags.timeout);
    const buildArgs = parseBuildArgs(flags['build-arg']);
    const image = expandImage({
      image: flags.image,
      extraTags: flags.tag,
      project: cfg.project,
      region: cfg.region,
      repo: cfg.repo,
      fallbackTag: () => defaultTag(dir, { now: now() }),
    });
    const names = resourceNames(cfg);

    if (!flags['dry-run']) requireCredentials(env, homeDir, cfg);

    out.step(`Packaging ${path.resolve(dir)}`);
    const pkg = await packageSource(dir, { dockerfile: flags.dockerfile, tmpDir, warn: out.warn });
    let source;
    try {
      out.info(`    ${pkg.fileCount} files, ${formatBytes(pkg.bytes)}${pkg.ignoreFile ? ` (using ${pkg.ignoreFile})` : ''}`);
      const object = sourceObjectName(pkg.sha256, now());
      const requestFor = (src) =>
        buildRequest({
          project: cfg.project,
          region: cfg.region,
          serviceAccount: cfg.serviceAccount,
          logsBucket: names.logsBucket,
          source: src,
          repository: image.repository,
          refs: image.refs,
          dockerfile: pkg.dockerfile,
          buildArgs,
          noCache: flags['no-cache'],
          timeoutSec,
        });

      if (flags['dry-run']) {
        const request = requestFor({ bucket: names.sourceBucket, object });
        const sourceInfo = { bytes: pkg.bytes, fileCount: pkg.fileCount, sha256: pkg.sha256, ignoreFile: pkg.ignoreFile };
        if (flags.json) out.result({ status: 'DRY_RUN', exitCode: 0, request, source: sourceInfo });
        else out.result(request);
        return EXIT.OK;
      }

      clients = await createClients({ project: cfg.project });
      out.step(`Uploading source to gs://${names.sourceBucket}/${object}`);
      source = await uploadSource({
        storage: clients.storage,
        bucket: names.sourceBucket,
        object,
        file: pkg.path,
        bytes: pkg.bytes,
        project: cfg.project,
        serviceAccount: cfg.serviceAccount,
      });
      source.request = requestFor(source);
    } finally {
      removeTarball(pkg.path);
    }

    out.step(`Starting Cloud Build in ${cfg.region}`);
    state.phase = 'submitting';
    const started = Date.now();
    const submitted = await submitBuild({ cloudBuild: clients.cloudBuild, request: source.request, ctx });
    state.buildName = submitted.name;
    state.phase = 'running';
    const url = consoleUrl(cfg.region, submitted.id, cfg.project);
    out.info(`    build ${submitted.id}`);
    out.info(`    ${url}`);
    if (state.interrupted) {
      out.warn('cancelling build…');
      state.cancelPromise = requestCancel();
    }

    const logFile = path.join(tmpDir, `dockeriser-${submitted.id}.log`);
    const tailer = new LogTailer({
      storage: clients.storage,
      bucket: names.logsBucket,
      buildId: submitted.id,
      onText: out.log,
      logFile,
      onWarn: out.warn,
      sleep,
    }).start();

    let build;
    try {
      let lastStatus;
      build = await waitForBuild({
        cloudBuild: clients.cloudBuild,
        name: submitted.name,
        sleep,
        ctx,
        onUpdate: (b) => {
          const s = statusName(b.status);
          if (s !== lastStatus && (s === 'QUEUED' || s === 'PENDING')) out.info(`    ${s.toLowerCase()}… waiting for a worker`);
          lastStatus = s;
        },
      });
      await tailer.drain();
    } finally {
      await tailer.stop();
    }
    await state.cancelPromise;

    const summary = summarizeBuild(build, {
      project: cfg.project,
      region: cfg.region,
      logFile,
      tail: tailer.tail(50),
      fallbackDurationSec: (Date.now() - started) / 1000,
    });
    if (summary.status === 'SUCCESS') fs.rmSync(logFile, { force: true });
    const exitCode = state.interrupted ? EXIT.INTERRUPTED : exitCodeForStatus(summary.status);
    summary.usage = recordUsage({ homeDir, build, buildId: submitted.id, project: cfg.project, region: cfg.region, now: now(), warn: out.warn });

    if (flags.json) out.result({ ...summary, exitCode });
    else if (summary.status === 'SUCCESS') printSuccess(out, summary);
    else printFailure(out, summary);
    if (!flags.json && summary.usage) out.info(summary.usage.line);
    return exitCode;
  } catch (err) {
    return fail(out, err instanceof DockeriserError ? err : mapGoogleError(err, ctx), flags.json, flags.debug);
  } finally {
    removeSigint();
  }
}

/**
 * Stop early, before packaging, when no credentials can be found.
 * @param {Record<string, string|undefined>} env
 * @param {string} homeDir
 * @param {{serviceAccount: string}} cfg
 */
function requireCredentials(env, homeDir, cfg) {
  const creds = resolveCredentials({ env, homeDir });
  if (creds.source === 'none' && !env.METADATA_SERVER_DETECTION) {
    throw new AuthError('No Google credentials found.', {
      fix: `Run the setup script; it signs you in: powershell -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}" -Project ${cfg.project}`,
    });
  }
  applyCredentials(creds, env);
}

/**
 * Add a finished build to the local usage cache and return the summary for output.
 * Never throws: usage tracking must not break a build.
 */
function recordUsage({ homeDir, build, buildId, project, region, now, warn }) {
  try {
    const cache = recordBuild(readUsageCache(homeDir), { buildId, build, project, region, now });
    writeUsageCache(homeDir, cache);
    return summaryFromCache(cache, { now, project });
  } catch (err) {
    warn(`Could not update the usage cache: ${err.message}`);
    return null;
  }
}

/** `dockeriser doctor` */
async function doctorCommand({ flags, out, env, homeDir, createClients }) {
  const { checks, exitCode } = await runDoctor({ flags, env, homeDir, createClients });
  if (flags.json) out.result({ ok: exitCode === 0, exitCode, checks });
  else printDoctor(checks, out);
  return exitCode;
}

/** `dockeriser usage [--month YYYY-MM]` */
async function usageCommand({ flags, out, env, homeDir, now, createClients }) {
  const cfg = resolveConfig({ flags, env, homeDir });
  let range;
  try {
    range = monthRange(flags.month, now);
  } catch (err) {
    throw new ConfigError(err.message);
  }
  requireCredentials(env, homeDir, cfg);
  const { cloudBuild, storage } = await createClients({ project: cfg.project });
  const totals = await fetchBuildTotals({ cloudBuild, project: cfg.project, region: cfg.region, range });

  let arStorage = null;
  let arStorageError = null;
  try {
    arStorage = arStorageSummary(await fetchRepoSize({ auth: storage.authClient, project: cfg.project, region: cfg.region, repo: cfg.repo }));
  } catch (err) {
    arStorageError = String(err?.response?.data?.error?.message || err?.message || err).slice(0, 160);
  }

  const summary = projectUsage(totals, range, now);
  if (range.isCurrent) {
    try {
      writeUsageCache(homeDir, cacheFromTotals({ totals, range, project: cfg.project, region: cfg.region, now, arStorage }));
    } catch (err) {
      out.warn(`Could not write the usage cache: ${err.message}`);
    }
  }
  const report = {
    ...summary,
    project: cfg.project,
    region: cfg.region,
    repo: cfg.repo,
    source: 'api',
    asOf: now.toISOString(),
    line: usageLine(summary),
    arStorage,
    arStorageError,
    note: 'Estimates from build history in this project and region only. The free minutes are shared across the whole billing account, so builds in other projects count too. The real bill is on the Billing page.',
  };
  if (flags.json) out.result(report);
  else for (const line of formatUsageReport(report)) out.info(line);
  return EXIT.OK;
}

/** `dockeriser status [--offline]` */
async function statusCommand({ flags, out, env, homeDir, now, createClients }) {
  const status = getOfflineStatus({ env, homeDir, now, flags });
  const steps = nextSteps(status);
  let live = null;
  if (!flags.offline && status.ready) {
    const { checks, exitCode } = await runDoctor({ flags, env, homeDir, createClients });
    live = { ok: exitCode === 0, failed: checks.filter((c) => c.status === 'fail') };
  }
  const result = { ...status, usageLine: status.usage?.line || null, nextSteps: steps, live };
  if (flags.json) {
    out.result(result);
  } else {
    out.info(`configured:   ${status.configured ? `yes (project ${status.project}, region ${status.region})` : 'no'}`);
    out.info(`credentials:  ${status.credentials.present ? `yes (${status.credentials.path})` : 'no'}`);
    out.info(`gcloud:       ${status.gcloud.installed ? 'installed' : 'not found'}`);
    if (live) out.info(`online check: ${live.ok ? 'ok' : live.failed.map((c) => c.name).join(', ') + ' failing (run dockeriser doctor)'}`);
    if (status.usage) out.info(status.usage.line);
    if (steps.length) out.info(`\nNext steps:\n${formatSteps(steps)}`);
  }
  if (live && !live.ok) return EXIT.AUTH;
  return status.ready ? EXIT.OK : status.configured ? EXIT.AUTH : EXIT.CONFIG;
}

/** `dockeriser login` */
async function loginCommand({ flags, out, env, homeDir, now, createClients }) {
  const res = await runLogin({ env, homeDir, now, flags, createClients });
  if (flags.json) {
    out.result(res);
    return res.exitCode;
  }
  if (res.ready) {
    out.ok(`Signed in as ${res.identity}, project ${res.project}`);
    out.info(res.usage?.line || 'Run `dockeriser usage` to see this month\'s free build-minutes.');
    return EXIT.OK;
  }
  out.info('Not signed in yet. Next step' + (res.steps.length > 1 ? 's' : '') + ':\n');
  out.info(formatSteps(res.steps));
  return res.exitCode;
}

/** Print an error (and the JSON error object in --json mode) and return its exit code. */
function fail(out, err, json, debug = false) {
  out.error(err, debug);
  const exitCode = err.exitCode ?? EXIT.BUILD_FAILED;
  if (json) {
    out.result({
      status: 'ERROR',
      exitCode,
      buildId: null,
      images: [],
      durationSec: 0,
      consoleUrl: null,
      logFile: null,
      failedStep: null,
      failureInfo: null,
      errorTail: [],
      error: { type: err.name || 'Error', message: err.message, fix: err.fix || null },
    });
  }
  return exitCode;
}

/** Success block for humans. */
export function printSuccess(out, s) {
  const c = out.colour;
  out.info();
  out.ok(`SUCCESS in ${formatDuration(s.durationSec)} (${s.buildMinutes.toFixed(2)} build-minutes, billed per second)`);
  for (const img of s.images) out.info(`  ${img.name}${img.digest ? `@${img.digest}` : ''}`);
  out.info(`  ${c('dim', 'console:')} ${s.consoleUrl}`);
}

/** Failure block for humans. */
export function printFailure(out, s) {
  const c = out.colour;
  out.info();
  out.info(c('red', c('bold', `BUILD ${s.status}`)) + ` after ${formatDuration(s.durationSec)}`);
  if (s.failureInfo) {
    out.info(`  reason:      ${s.failureInfo.type}${s.failureInfo.detail ? ` - ${s.failureInfo.detail}` : ''}`);
    if (s.failureInfo.hint) out.info(`  hint:        ${s.failureInfo.hint}`);
  }
  if (s.failedStep) {
    const st = s.failedStep;
    out.info(`  failed step: #${st.index}${st.id ? ` ${st.id}` : ''} (${st.name}) ${st.status}`);
    out.info(`               ${st.args}`);
  }
  if (s.errorTail.length) {
    out.info(`  last ${s.errorTail.length} log lines:`);
    for (const line of s.errorTail) out.info(`    ${line}`);
  }
  if (s.logFile) out.info(`  full log:    ${s.logFile}`);
  out.info(`  console:     ${s.consoleUrl}`);
}
