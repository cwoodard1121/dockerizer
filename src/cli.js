/**
 * Command-line front end. `run()` takes every side effect as a dependency so tests can drive it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync as childExec, spawn } from 'node:child_process';
import { applyCredentials, homeSearch, resolveConfig, resolveCredentials, resourceNames, userHome } from './config.js';
import { AuthError, ConfigError, DockeriserError, EXIT, mapGoogleError } from './errors.js';
import { defaultTag, expandImage } from './image.js';
import { cleanupTempFiles, packageSource, removeTarball } from './package-source.js';
import { sourceObjectName, uploadSource } from './upload.js';
import { buildRequest, buildRequestMulti, cancelBuild, consoleUrl, exitCodeForStatus, imageDuration, parseBuildArgs, parseTimeout, statusName, stepDurations, submitBuild, summarizeBuild, waitForBuild } from './build.js';
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
import { buildGroups, imageDeps, loadProject, readBuildArgsFile, resolveBuildArgs, secretLookingArgs, selectImages, splitList } from './project.js';
import { executeDeploy, imageFlags, planDeploy, saveDeploySection, streamLogs } from './deploy.js';
import { createRegistryClient } from './registry.js';
import { createSshRunner } from './ssh.js';
import { addServer, checkServer, createGcloudRunner, printChecks } from './server.js';
import { listServers, removeServer, resolveServer } from './servers.js';
import { runInit } from './init.js';
import { DEFAULT_KEEP, runCleanup } from './cleanup.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const USAGE = `dockeriser ${VERSION} - build Docker images on Google Cloud Build instead of locally, and deploy them over SSH

Usage:
  dockeriser build [dir] --image <name>[:<tag>] [options]   one image
  dockeriser build [dir] [--only a,b]                       the images listed in <dir>/dockeriser.json
  dockeriser deploy [dir] --to <server> [options]           put built images on a server (never automatic)
  dockeriser rollback [dir] [--to <server>]                 go back to the previous image(s)
  dockeriser logs [dir] [--to <server>] [--follow]          container logs over SSH
  dockeriser server add <name> --host <user@host> [--port 22] [--key <path>] [--transfer ssh|pull] [--install-docker]
  dockeriser server list | check <name> | remove <name>
  dockeriser init [dir] [--force]                           write a starter dockeriser.json for a project
  dockeriser cleanup [--keep 20] [--dry-run]                keep the newest N versions of each image, delete the rest
  dockeriser login                       say what (if anything) is left to sign in
  dockeriser usage [--month YYYY-MM]     free build-minutes used this month, projection, cost
  dockeriser status --offline            instant local check (no network): set up? credentials? usage
  dockeriser doctor                      check every piece of setup online, with fixes
  dockeriser --help | --version
  (every command takes --json; --project, --region, --repo override the config;
   DOCKERISER_CONFIG_DIR points at another .dockeriser folder)

Build options:
  -i, --image <ref>        myapp[:tag] (pushed to <region>-docker.pkg.dev/<project>/<repo>/myapp)
                           or a full <region>-docker.pkg.dev/... reference. Without it, dockeriser.json is used.
      --only <names>       with dockeriser.json: build only these images (and any local base they need)
      --sequential         with dockeriser.json: one Cloud Build run (default: images sharing no local
                           base build in parallel, one Cloud Build each)
  -t, --tag <tag>          extra tag (repeatable). :latest is always pushed too.
                           Default tag: short git SHA if <dir> is clean in git, else UTC YYYYMMDD-HHMMSS
  -f, --dockerfile <path>  Dockerfile relative to <dir> (default: Dockerfile)
      --build-arg K=V      passed to docker build (repeatable). Visible in the Cloud Build console: no secrets.
      --build-arg-file <f> KEY=VALUE lines read on this PC and passed as build args
      --timeout <dur>      build timeout, e.g. 20m, 1h, 90s (default: 20m)
      --no-cache           build without the registry cache
      --deploy <server>    after a successful build, deploy the exact images just built
      --dry-run            package locally and print the Cloud Build request; no network calls
      --json               print one JSON result on stdout (logs and messages go to stderr)
      --debug              show stack traces

Deploy options (flags win over dockeriser.json's "deploy" section, which wins over the settings the
first deploy saves in ~/.dockeriser/projects/):
      --to <server>        saved server name or user@host
      --mode <mode>        run (default: one container) | compose | load-only
      --transfer <how>     ssh (default: stream through this PC, nothing on the server) | pull (server pulls)
      --build              build first, then deploy the exact digests
      --image <ref>        image to deploy, repeatable: name[:tag] or name@sha256:<digest> (default: the
                           images in dockeriser.json, at :latest)
      --name <container>   run mode: container name (default: image name)
  -p, --publish <h:c>      run mode: port mapping, repeatable (e.g. -p 80:3000)
      --env-file <file>    run mode: .env file copied to the server (600), never stored in dockeriser.json
      --health-url <url>   run mode: must answer 2xx within 60s, else automatic rollback
      --compose-dir <dir>  compose mode: folder on the server with the compose file
      --compose-file <f>   compose mode: compose file name; --compose-project <p>: project name
      --service <names>    compose mode: services to restart (repeatable or comma list)
      --tag-as <ref>       local name for the image on the server, e.g. myapp-web:prod (or image=ref);
                           with several --image, one bare value each, in the same order
      --upload <l>:<r>     send a local folder or file to a server folder first, repeatable (one ssh
                           connection; not undone by rollback)
      --keep-env <keys>    keep these lines of the server's <folder>/.env when --upload replaces it
      --then "<command>"   run this on the server after the images (and uploads) are in place
      --save | --no-save   write the settings into dockeriser.json | keep nothing (default: per user)
      --dry-run            print the remote script; no connection
Server options: --host, --port, --key (default: "sshKey" in ~/.dockeriser/config.json), --transfer, --install-docker
Logs options: --follow, --tail <n> (default 100)
Cleanup options: --keep <n> (default 20), --dry-run (show what would go; change nothing)

Exit codes: 0 success, 1 build or deploy failed, 2 config/input error, 3 credentials/permission error,
            4 upload error, 130 interrupted (build cancelled).`;

const OPTIONS = {
  image: { type: 'string', short: 'i', multiple: true },
  tag: { type: 'string', short: 't', multiple: true },
  dockerfile: { type: 'string', short: 'f' },
  'build-arg': { type: 'string', multiple: true },
  'build-arg-file': { type: 'string' },
  only: { type: 'string', multiple: true },
  timeout: { type: 'string', default: '20m' },
  'no-cache': { type: 'boolean', default: false },
  sequential: { type: 'boolean', default: false },
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
  // deploy
  deploy: { type: 'string' },
  to: { type: 'string' },
  mode: { type: 'string' },
  transfer: { type: 'string' },
  build: { type: 'boolean', default: false },
  name: { type: 'string' },
  publish: { type: 'string', short: 'p', multiple: true },
  'env-file': { type: 'string' },
  'health-url': { type: 'string' },
  'compose-dir': { type: 'string' },
  'compose-file': { type: 'string' },
  'compose-project': { type: 'string' },
  service: { type: 'string', multiple: true },
  'tag-as': { type: 'string', multiple: true },
  then: { type: 'string' },
  upload: { type: 'string', multiple: true },
  'keep-env': { type: 'string', multiple: true },
  save: { type: 'boolean', default: false },
  'no-save': { type: 'boolean', default: false },
  follow: { type: 'boolean', default: false },
  tail: { type: 'string' },
  // server
  host: { type: 'string' },
  port: { type: 'string' },
  key: { type: 'string' },
  'install-docker': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  // cleanup
  keep: { type: 'string' },
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
 * @param {{exec: Function}} [deps.ssh] SSH runner (see src/ssh.js).
 * @param {(args: string[]) => {code: number, stdout: string, stderr: string}} [deps.gcloud]
 * @param {typeof fetch} [deps.fetch] For the registry client.
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv, deps = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    homeDir = userHome({ env }),
    createClients = realCreateClients,
    sleep = realSleep,
    now = () => new Date(),
    tmpDir = os.tmpdir(),
    exit = (code) => process.exit(code),
    cwd = process.cwd(),
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
  // --image repeats only for deploy; every other command takes one.
  const imageList = flags.image || [];
  flags.image = command === 'deploy' ? (imageList.length ? imageList : undefined) : imageList[0];

  if (flags.version) {
    stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (flags.help || !command) {
    (command || flags.help ? stdout : stderr).write(`${USAGE}\n`);
    return flags.help ? EXIT.OK : EXIT.CONFIG;
  }

  const ctx = { flags, rest, env, homeDir, now: now(), createClients, tmpDir, cwd, deps, sleep, exit, sigint, stdout, stderr };
  const handlers = {
    doctor: doctorCommand,
    usage: usageCommand,
    status: statusCommand,
    login: loginCommand,
    deploy: deployCommand,
    rollback: rollbackCommand,
    logs: logsCommand,
    server: serverCommand,
    init: initCommand,
    cleanup: cleanupCommand,
  };
  if (handlers[command]) {
    const out = createOutput({ json: flags.json || (flags['dry-run'] && (command === 'deploy' || command === 'rollback')), stdout, stderr, env });
    try {
      return await handlers[command]({ ...ctx, out });
    } catch (err) {
      return fail(out, err instanceof DockeriserError ? err : mapGoogleError(err), flags.json, flags.debug);
    }
  }
  if (command !== 'build') {
    const out = createOutput({ json: flags.json, stdout, stderr, env });
    return fail(out, new ConfigError(`Unknown command "${command}".`, { fix: 'Commands: build, deploy, rollback, logs, server, init, cleanup, login, usage, status, doctor. Run `dockeriser --help`.' }), flags.json);
  }

  // Dry runs keep stdout for the request JSON only.
  const out = createOutput({ json: flags.json || flags['dry-run'], stdout, stderr, env });
  try {
    if (rest.length > 1) throw new ConfigError(`Unexpected extra argument "${rest[1]}".`, { fix: 'Pass one folder; quote paths with spaces.' });
    if (imageList.length > 1) {
      throw new ConfigError(`build takes one --image (got ${imageList.length}: ${imageList.join(', ')}).`, { fix: 'List several images in dockeriser.json and run `dockeriser build` (or --only a,b), or run one build per image.' });
    }
    const dir = rest[0] || (flags.image ? null : cwd);
    if (!dir) throw new ConfigError('Missing <dir>.', { fix: 'Usage: dockeriser build <dir> --image <name>[:<tag>]' });
    const built = await runBuild({ ...ctx, out, dir });
    if (built.dryRun) return EXIT.OK;
    const summary = built.summary;
    if (flags.deploy && built.exitCode === 0) {
      const deployFlags = { ...flags, to: flags.deploy, image: undefined };
      const result = await deployWith({ ...ctx, out, flags: deployFlags, dir, built: built.images });
      if (flags.json) out.result({ ...summary, exitCode: result.exitCode, deploy: result });
      return result.exitCode;
    }
    if (flags.json) out.result({ ...summary, exitCode: built.exitCode });
    return built.exitCode;
  } catch (err) {
    return fail(out, err instanceof DockeriserError ? err : mapGoogleError(err), flags.json, flags.debug);
  }
}

/** Git builtins for ${git.sha} / ${git.short} / $GIT_SHA in build args (HEAD, even with local changes). */
function gitBuiltins(dir) {
  try {
    const full = String(childExec('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true })).trim();
    return full ? { 'git.sha': full, GIT_SHA: full, 'git.short': full.slice(0, 7) } : {};
  } catch {
    return {};
  }
}

/**
 * Package, upload, build and wait. Returns the summary instead of printing the JSON result.
 * @returns {Promise<{exitCode: number, summary?: object, images?: Array<{name: string, repository: string, digest: string}>, dryRun?: boolean}>}
 */
async function runBuild({ flags, env, homeDir, now, createClients, tmpDir, sleep, exit, sigint, out, dir }) {
  // names: every submitted build; Ctrl-C cancels all of them.
  const state = { interrupted: false, names: [], phase: 'local', cancelPromise: null };
  let gctx = {};
  let clients;
  const cancelOne = (name) =>
    cancelBuild(clients.cloudBuild, name).catch((err) => {
      out.error(mapGoogleError(err, { ...gctx, action: 'cancel the build' }), flags.debug);
      exit(EXIT.INTERRUPTED);
    });
  const requestCancel = () => Promise.all(state.names.map(cancelOne));
  const removeSigint = sigint(() => {
    if (state.interrupted || !state.names.length) {
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
    out.warn(`cancelling ${state.names.length > 1 ? `${state.names.length} builds` : 'build'}… (press Ctrl-C again to quit without waiting)`);
    state.cancelPromise = requestCancel();
  });

  try {
    const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
    gctx = { project: cfg.project, region: cfg.region, serviceAccount: cfg.serviceAccount };
    const timeoutSec = parseTimeout(flags.timeout);
    const cliArgs = parseBuildArgs(flags['build-arg']);
    const cliFileArgs = flags['build-arg-file'] ? readBuildArgsFile(path.resolve(flags['build-arg-file'])) : [];
    const names = resourceNames(cfg);
    const fallbackTag = () => defaultTag(dir, { now });

    // One image (--image) or the dockeriser.json list.
    const project = flags.image ? null : loadProject(dir);
    let specs;
    let pkgOpts;
    let prebuilds = [];
    let groups;
    if (flags.image) {
      const image = expandImage({ image: flags.image, extraTags: flags.tag, project: cfg.project, region: cfg.region, repo: cfg.repo, fallbackTag });
      specs = [{ name: image.repository.split('/').pop(), repository: image.repository, refs: image.refs, push: true, single: true }];
      pkgOpts = { dockerfile: flags.dockerfile };
      specs[0].buildArgs = [...cliFileArgs, ...cliArgs];
      groups = [specs];
    } else {
      if (!project.exists || !project.images.length) {
        throw new ConfigError(`No --image given and ${project.file} lists no images.`, { fix: 'Pass --image <name>[:<tag>], or run `dockeriser init` to write a dockeriser.json.' });
      }
      const readDockerfile = (df) => {
        try {
          return fs.readFileSync(path.join(project.root, df), 'utf8');
        } catch {
          return '';
        }
      };
      const { selected, added } = selectImages(project.images, splitList(flags.only), readDockerfile);
      if (added.length) out.info(`    also building ${added.join(', ')} (needed as a local base)`);
      prebuilds = selected.filter((img) => img.prebuild);
      const tag = flags.tag?.length ? null : fallbackTag();
      const builtins = gitBuiltins(project.root);
      specs = selected.map((img) => {
        const exp = img.push ? expandImage({ image: tag ? `${img.image}:${tag}` : img.image, extraTags: flags.tag, project: cfg.project, region: cfg.region, repo: cfg.repo, fallbackTag }) : null;
        return {
          ...img,
          repository: exp?.repository || null,
          refs: exp?.refs || [],
          buildArgs: parseBuildArgs(resolveBuildArgs(img, { root: project.root, env, builtins, cliFileArgs, cliArgs, warn: out.warn })),
        };
      });
      pkgOpts = { images: specs, include: project.include, source: project.source };
      // Images that share no local base build at the same time, each on its own Cloud Build machine.
      const parallel = !flags.sequential && project.raw?.parallel !== false;
      groups = parallel ? buildGroups(specs, imageDeps(project.images, readDockerfile)) : [specs];
    }
    for (const s of specs) {
      const secretish = secretLookingArgs(s.buildArgs || []);
      if (secretish.length) out.warn(`Image "${s.name}": build args ${secretish.join(', ')} look like secrets; build args are visible in the Cloud Build console and the image history. Use a runtime env file for secrets.`);
    }
    const many = groups.length > 1;
    const labelOf = (group) => group.map((s) => s.name).join('+');

    if (!flags['dry-run']) requireCredentials(env, homeDir, cfg);
    for (const img of prebuilds) await runPrebuild({ img, root: project.root, env, out });

    out.step(`Packaging ${path.resolve(dir)}${specs.length > 1 ? ` (${specs.map((s) => s.name).join(', ')})` : ''}`);
    const pkg = await packageSource(dir, { ...pkgOpts, tmpDir, warn: out.warn });
    let requests;
    try {
      out.info(`    ${pkg.fileCount} files, ${formatBytes(pkg.bytes)}${pkg.ignoreFile ? ` (using ${pkg.ignoreFile})` : ''}`);
      const object = sourceObjectName(pkg.sha256, now);
      const requestFor = (src, group) =>
        group[0].single
          ? buildRequest({
              project: cfg.project, region: cfg.region, serviceAccount: cfg.serviceAccount, logsBucket: names.logsBucket, source: src,
              repository: group[0].repository, refs: group[0].refs, dockerfile: pkg.dockerfile, buildArgs: group[0].buildArgs, noCache: flags['no-cache'], timeoutSec,
            })
          : buildRequestMulti({
              project: cfg.project, region: cfg.region, serviceAccount: cfg.serviceAccount, logsBucket: names.logsBucket, source: src,
              images: group, noCache: flags['no-cache'], timeoutSec,
            });

      if (flags['dry-run']) {
        const reqs = groups.map((g) => requestFor({ bucket: names.sourceBucket, object }, g));
        const sourceInfo = { bytes: pkg.bytes, fileCount: pkg.fileCount, sha256: pkg.sha256, ignoreFile: pkg.ignoreFile };
        if (flags.json) out.result(many ? { status: 'DRY_RUN', exitCode: 0, parallel: true, builds: groups.map((g) => g.map((s) => s.name)), requests: reqs, source: sourceInfo } : { status: 'DRY_RUN', exitCode: 0, request: reqs[0], source: sourceInfo });
        else out.result(many ? reqs : reqs[0]);
        return { exitCode: EXIT.OK, dryRun: true };
      }

      clients = await createClients({ project: cfg.project });
      out.step(`Uploading source to gs://${names.sourceBucket}/${object}`);
      const source = await uploadSource({
        storage: clients.storage, bucket: names.sourceBucket, object, file: pkg.path, bytes: pkg.bytes, project: cfg.project, serviceAccount: cfg.serviceAccount,
      });
      requests = groups.map((g) => requestFor(source, g));
    } finally {
      removeTarball(pkg.path);
    }

    out.step(`Starting Cloud Build in ${cfg.region}${many ? `: ${groups.map(labelOf).join(', ')} in parallel (${groups.length} builds)` : ''}`);
    state.phase = 'submitting';
    const started = Date.now();
    const jobs = [];
    for (const [i, group] of groups.entries()) {
      if (state.interrupted) break; // Ctrl-C while submitting: start no more
      const submitted = await submitBuild({ cloudBuild: clients.cloudBuild, request: requests[i], ctx: gctx });
      state.names.push(submitted.name);
      jobs.push({ group, submitted, label: labelOf(group) });
      out.info(`    ${many ? `${labelOf(group)}: ` : ''}build ${submitted.id}`);
      out.info(`    ${consoleUrl(cfg.region, submitted.id, cfg.project)}`);
      if (state.interrupted) {
        out.warn('cancelling build…');
        state.cancelPromise = requestCancel();
      }
    }
    state.phase = 'running';

    // Wait for every build, each with its own log tail; several builds' lines carry a [name] prefix.
    const finished = await Promise.all(
      jobs.map(async (job) => {
        const logFile = path.join(tmpDir, `dockeriser-${job.submitted.id}.log`);
        const lines = many ? prefixLines(`[${job.label}] `, out.log) : null;
        const tailer = new LogTailer({ storage: clients.storage, bucket: names.logsBucket, buildId: job.submitted.id, onText: lines ? lines.push : out.log, logFile, onWarn: out.warn, sleep }).start();
        let build;
        try {
          let lastStatus;
          build = await waitForBuild({
            cloudBuild: clients.cloudBuild,
            name: job.submitted.name,
            sleep,
            ctx: gctx,
            onUpdate: (b) => {
              const s = statusName(b.status);
              if (s !== lastStatus && (s === 'QUEUED' || s === 'PENDING')) out.info(`    ${many ? `${job.label}: ` : ''}${s.toLowerCase()}… waiting for a worker`);
              lastStatus = s;
            },
          });
          await tailer.drain();
        } finally {
          await tailer.stop();
          lines?.end();
        }
        const refs = job.group.flatMap((s) => s.refs);
        const summary = summarizeBuild(build, {
          project: cfg.project, region: cfg.region, logFile, tail: tailer.tail(50), refs, fallbackDurationSec: (Date.now() - started) / 1000,
        });
        // Label each pushed image with its dockeriser.json name and the seconds its steps took.
        const durations = stepDurations(build);
        for (const img of summary.images) {
          const spec = job.group.find((s) => s.refs.includes(img.name));
          if (spec && !spec.single) img.image = spec.name;
          const sec = spec ? imageDuration(durations, spec.single ? null : spec.name) : null;
          if (sec !== null) img.durationSec = sec;
        }
        if (summary.status === 'SUCCESS') fs.rmSync(logFile, { force: true });
        return { build, summary, id: job.submitted.id };
      }),
    );
    await state.cancelPromise;

    // Usage after every build has finished, one at a time (one cache file).
    let usage = null;
    for (const f of finished) usage = recordUsage({ homeDir, build: f.build, buildId: f.id, project: cfg.project, region: cfg.region, now, warn: out.warn }) || usage;
    const summary = many ? mergeSummaries(finished.map((f) => f.summary), (Date.now() - started) / 1000) : finished[0].summary;
    summary.usage = usage;
    const exitCode = state.interrupted ? EXIT.INTERRUPTED : exitCodeForStatus(summary.status);

    if (!flags.json) {
      if (summary.status === 'SUCCESS') printSuccess(out, summary);
      else printFailure(out, summary);
      if (summary.usage) out.info(summary.usage.line);
    }
    // One entry per pushed spec, with its digest, for a deploy that follows.
    const images = specs
      .filter((s) => s.push)
      .map((s) => {
        const hit = summary.images.find((i) => s.refs.includes(i.name) && i.digest);
        return hit ? { name: s.name, repository: s.repository, digest: hit.digest } : null;
      })
      .filter(Boolean);
    return { exitCode, summary, images };
  } finally {
    removeSigint();
  }
}

/**
 * One result for several parallel builds: the first failed build's details (else the first build's)
 * at the top level, every image, wall-clock seconds, summed build-minutes, and each build in `builds`.
 */
export function mergeSummaries(summaries, wallSec) {
  const failed = summaries.find((s) => s.status !== 'SUCCESS');
  const head = failed || summaries[0];
  return {
    ...head,
    status: failed ? failed.status : 'SUCCESS',
    images: summaries.flatMap((s) => s.images),
    durationSec: Math.round(wallSec),
    buildMinutes: Math.round(summaries.reduce((n, s) => n + s.buildMinutes, 0) * 100) / 100,
    parallel: true,
    builds: summaries,
  };
}

/** Prefix every complete line of streamed text (partial lines wait for their end). */
function prefixLines(prefix, write) {
  let buf = '';
  return {
    push: (text) => {
      buf += text;
      const i = buf.lastIndexOf('\n');
      if (i < 0) return;
      write(buf.slice(0, i + 1).replace(/^(?=.)/gm, prefix));
      buf = buf.slice(i + 1);
    },
    end: () => {
      if (buf) write(`${prefix}${buf}\n`);
      buf = '';
    },
  };
}

/**
 * Run an image's "prebuild" command on this PC (platform shell, project folder), streaming its
 * output to stderr. Runs on --dry-run too: the context it stages has to exist to be packaged.
 */
function runPrebuild({ img, root, env, out }) {
  out.info(`    prebuild ${img.name}: ${img.prebuild}`);
  return new Promise((resolve, reject) => {
    const child = spawn(img.prebuild, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const relay = (d) => out.log(String(d).replace(/^(?=.)/gm, '      '));
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (err) => reject(new ConfigError(`prebuild for image "${img.name}" could not start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ConfigError(`prebuild for image "${img.name}" failed (exit ${code}): ${img.prebuild}`, { fix: 'Run the command yourself in the project folder, fix it, then build again.' }));
    });
  });
}

/** Lazily create the registry client (needs Google credentials). */
function registryFactory({ env, homeDir, cfg, createClients, deps }) {
  let client = null;
  return async () => {
    if (client) return client;
    requireCredentials(env, homeDir, cfg);
    const { storage } = await createClients({ project: cfg.project });
    const auth = storage.authClient;
    client = createRegistryClient({
      fetch: deps.fetch,
      getAccessToken: async () => {
        const t = await auth.getAccessToken();
        const token = typeof t === 'string' ? t : t?.token;
        if (!token) throw new AuthError('Could not get a Google access token for Artifact Registry.', { fix: 'Run `dockeriser login` to see what is missing.' });
        return token;
      },
    });
    return client;
  };
}

/** Plan + run a deploy (shared by deploy, deploy --build and build --deploy). */
async function deployWith({ flags, env, homeDir, createClients, deps, out, dir, built = null, rollback = false }) {
  if (flags.save && flags['no-save']) throw new ConfigError('--save and --no-save cannot be used together.', { fix: '--save writes the settings into dockeriser.json; --no-save keeps nothing; by default they are kept per user.' });
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
  const plan = planDeploy({ dir, flags, cfg, homeDir, env, built, rollback });
  const ssh = deps.ssh || createSshRunner({ homeDir });
  const result = await executeDeploy({ plan, ssh, getRegistry: registryFactory({ env, homeDir, cfg, createClients, deps }), out, dryRun: flags['dry-run'] });
  result.saved = null;
  if (!flags['dry-run'] && !rollback && result.exitCode === 0) {
    const saved = saveDeploySection(plan, { homeDir, where: flags['no-save'] ? 'none' : flags.save ? 'file' : 'state' });
    if (saved) {
      result.saved = saved.kind;
      const where = saved.kind === 'dockeriser.json' ? `in ${saved.file}` : `for this folder in ${saved.file} (not in the repo; --save puts them in dockeriser.json)`;
      out.info(`    saved these deploy settings ${where}; next time just run: dockeriser deploy${flags.build ? ' --build' : ''}`);
    }
  }
  return result;
}

/**
 * What `deploy --build` builds: one --image as an ad-hoc build, several --image values as the
 * matching dockeriser.json images (--only), none as the whole dockeriser.json list.
 */
function buildSelection(dir, images) {
  if (images.length <= 1) return { image: images[0] };
  const project = loadProject(dir);
  const find = (n) => project.images.find((i) => i.name === n || i.image === n);
  const missing = images.filter((n) => !find(n));
  if (missing.length) {
    throw new ConfigError(`deploy --build with several --image values builds them from ${project.file}, which has no image ${missing.join(', ')}.`, {
      fix: project.images.length ? `Images there: ${project.images.map((i) => i.name).join(', ')}.` : 'Run `dockeriser init`, or build and deploy one --image at a time.',
    });
  }
  return { image: undefined, only: images.map((n) => find(n).name) };
}

/** `dockeriser deploy [dir] --to <server> ...` */
async function deployCommand(ctx) {
  const { flags, rest, cwd, out } = ctx;
  const dir = rest[0] || cwd;
  let built = null;
  let buildSummary = null;
  if (flags.build) {
    const b = await runBuild({ ...ctx, dir, flags: { ...flags, json: true, ...buildSelection(dir, imageFlags(flags)) } });
    if (b.dryRun) return EXIT.OK;
    buildSummary = b.summary;
    if (!flags.json) {
      if (b.summary.status === 'SUCCESS') printSuccess(out, b.summary);
      else printFailure(out, b.summary);
    }
    if (b.exitCode !== 0) {
      if (flags.json) out.result({ status: 'BUILD_FAILED', exitCode: b.exitCode, build: buildSummary });
      return b.exitCode;
    }
    built = b.images;
  }
  const result = await deployWith({ ...ctx, dir, built });
  if (flags['dry-run'] && !flags.json) {
    ctx.stdout.write(result.script);
    return EXIT.OK;
  }
  if (flags.json) out.result(buildSummary ? { ...result, build: buildSummary } : result);
  return result.exitCode;
}

/** `dockeriser rollback [dir] [--to <server>]` */
async function rollbackCommand(ctx) {
  const { flags, rest, cwd, out } = ctx;
  const result = await deployWith({ ...ctx, dir: rest[0] || cwd, rollback: true });
  if (flags['dry-run'] && !flags.json) ctx.stdout.write(result.script);
  else if (flags.json) out.result(result);
  return result.exitCode;
}

/** `dockeriser logs [dir] [--to <server>] [--name] [--follow]` */
async function logsCommand({ flags, rest, cwd, env, homeDir, deps, out }) {
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir, requireProject: false });
  const plan = planDeploy({ dir: rest[0] || cwd, flags, cfg: { project: cfg.project || 'unset', region: cfg.region, repo: cfg.repo }, homeDir, env, rollback: true });
  const ssh = deps.ssh || createSshRunner({ homeDir });
  const tail = flags.tail ? Number(flags.tail) : 100;
  if (!Number.isInteger(tail) || tail < 0) throw new ConfigError('--tail must be a whole number.');
  return streamLogs({ plan, ssh, out, tail, follow: flags.follow });
}

/** `dockeriser server add|list|check|remove` */
async function serverCommand({ flags, rest, env, homeDir, tmpDir, deps, out }) {
  const [sub, name] = rest;
  const ssh = deps.ssh || createSshRunner({ homeDir });
  if (sub === 'list' || !sub) {
    const list = listServers(homeDir);
    if (flags.json) out.result(list);
    else if (!list.servers.length) out.info('No saved servers. Add one: dockeriser server add <name> --host user@ip');
    else {
      for (const s of list.servers) out.info(`${s.name.padEnd(14)} ${s.host}${s.port ? `:${s.port}` : ''}  transfer ${s.transfer || 'ssh'}${s.key ? `  key ${s.key}` : ''}`);
      if (list.sshKey) out.info(`default ssh key: ${list.sshKey}`);
    }
    return EXIT.OK;
  }
  if (!name) throw new ConfigError(`Missing server name.`, { fix: `dockeriser server ${sub} <name>` });
  if (sub === 'add') {
    const needsGoogle = flags.transfer === 'pull';
    const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir, requireProject: needsGoogle });
    const res = await addServer({ name, flags, homeDir, env, cfg, ssh, gcloud: deps.gcloud || createGcloudRunner({ env }), out, tmpDir });
    if (flags.json) out.result({ ok: res.check.ok, exitCode: res.check.ok ? 0 : 1, ...res });
    else printChecks(res.check.checks, out);
    return res.check.ok ? EXIT.OK : EXIT.BUILD_FAILED;
  }
  if (sub === 'check') {
    const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir, requireProject: false });
    const server = resolveServer(name, { homeDir, env, flags: { key: flags.key, port: flags.port } });
    const res = await checkServer({ server, ssh, out, cfg });
    if (flags.json) out.result({ ok: res.ok, exitCode: res.ok ? 0 : 1, server: name, checks: res.checks });
    else printChecks(res.checks, out);
    return res.ok ? EXIT.OK : EXIT.BUILD_FAILED;
  }
  if (sub === 'remove') {
    removeServer(homeDir, name);
    if (flags.json) out.result({ ok: true, removed: name });
    else out.ok(`Removed server "${name}" from your config (nothing was changed on the server).`);
    return EXIT.OK;
  }
  throw new ConfigError(`Unknown server command "${sub}".`, { fix: 'Use: server add | list | check | remove' });
}

/** `dockeriser cleanup [--keep 20] [--dry-run]` */
async function cleanupCommand({ flags, env, homeDir, tmpDir, deps, out }) {
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
  const keep = flags.keep === undefined ? DEFAULT_KEEP : Number(flags.keep);
  if (!Number.isInteger(keep) || keep < 1) throw new ConfigError(`--keep "${flags.keep}" must be a whole number of versions, 1 or more.`);
  const dryRun = flags['dry-run'];
  out.step(`${dryRun ? 'Checking' : 'Cleaning up'} ${cfg.region}-docker.pkg.dev/${cfg.project}/${cfg.repo} (keeping the ${keep} newest versions of each image)`);
  const res = runCleanup({ gcloud: deps.gcloud || createGcloudRunner({ env }), cfg, keep, dryRun, tmpDir, out });
  if (flags.json) {
    out.result(res);
    return EXIT.OK;
  }
  for (const i of res.images) {
    out.info(`  ${i.name.padEnd(24)} ${String(i.versions).padStart(3)} version${i.versions === 1 ? ' ' : 's'}, keeping ${i.kept}, ${dryRun ? 'would delete' : 'deleted'} ${i.deleting.length}`);
  }
  const n = dryRun ? res.wouldDelete : res.deleted;
  out.ok(`${dryRun ? 'Would delete' : 'Deleted'} ${n} old version${n === 1 ? '' : 's'}${res.bytesFreedUpTo ? ` (up to ${formatBytes(res.bytesFreedUpTo)}; layers shared with kept versions stay)` : ''}.`);
  out.info(dryRun
    ? 'Dry run: nothing deleted and the cleanup policy not changed. Run without --dry-run to do it.'
    : `Cleanup policy: keep the ${keep} newest versions of each image; Artifact Registry deletes older ones about once a day.`);
  return EXIT.OK;
}

/** `dockeriser init [dir] [--force] [--dry-run]` */
async function initCommand({ flags, rest, cwd, out }) {
  const res = runInit({ dir: rest[0] || cwd, force: flags.force, dryRun: flags['dry-run'] });
  if (flags.json) {
    out.result({ ...res, found: res.found });
    return EXIT.OK;
  }
  if (res.written) out.ok(`Wrote ${res.file}`);
  else if (res.exists) out.warn(`${res.file} already exists; not changed (use --force to replace it). Suggested contents:`);
  out.info(JSON.stringify(res.config, null, 2));
  const found = res.found;
  out.info(`\nFound: ${found.dockerfiles.length} Dockerfile(s)${found.compose.length ? `, compose: ${found.compose.join(', ')}` : ''}`);
  for (const n of res.notes) out.info(`  - ${n}`);
  for (const s of res.shipScripts) {
    out.info(`\n${s.file}:${s.line} ships images with docker save | ssh docker load:`);
    out.info(`    ${s.text}`);
    out.info('  Replace that line with (build on Google first: dockeriser build):');
    out.info(`    ${s.suggestion}`);
  }
  out.info('\nCheck: image names, contexts and the deploy section. Then: dockeriser build --dry-run, dockeriser build.');
  out.info('Deploys only happen when you run `dockeriser deploy` (add --to <server> the first time).');
  return EXIT.OK;
}

/**
 * Stop early, before packaging, when no credentials can be found.
 * @param {Record<string, string|undefined>} env
 * @param {string} homeDir
 * @param {{project: string}} cfg
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
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
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
  const status = getOfflineStatus({ env, homeDir, now, flags, searched: homeSearch({ env }) });
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
    out.info(`configured:   ${status.configured ? `yes (project ${status.project}, region ${status.region}, ${status.configFile})` : `no (looked in: ${status.searched.join(', ')})`}`);
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
  if (s.builds) printBuilds(out, s.builds);
  else out.info(`  ${c('dim', 'console:')} ${s.consoleUrl}`);
}

/** One line per parallel build: images, status, time, console link. */
function printBuilds(out, builds) {
  for (const b of builds) {
    const names = [...new Set(b.images.map((i) => i.image || i.name.split('/').pop().split(':')[0]))].join(', ') || 'no pushed images';
    out.info(`  build ${b.buildId} (${names}): ${b.status} in ${formatDuration(b.durationSec)}  ${b.consoleUrl}`);
  }
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
  if (s.builds) printBuilds(out, s.builds);
}
