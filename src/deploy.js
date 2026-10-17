/**
 * `dockeriser deploy` / `rollback` / `logs`: put images built on Cloud Build onto a server over SSH.
 *
 * Settings: flags > dockeriser.json "deploy" > defaults. Transfer "ssh" (default) streams the image
 * from Artifact Registry through this PC into `docker load` on the server (no local Docker, no
 * local disk, nothing to set up on the server); transfer "pull" makes the server `docker pull` with
 * its own read-only key (see `server add --transfer pull`). Modes: "run" (one container,
 * health check, automatic rollback), "compose" (retag + `docker compose up` + health, rollback),
 * "load-only" (retag only, optionally followed by --then "<remote command>").
 *
 * Connections used per deploy (servers that rate-limit SSH care): transfer ssh = 3 (look, load,
 * deploy script), transfer pull = 1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { ConfigError, DockeriserError, EXIT } from './errors.js';
import { expandImage, parseDeployImage } from './image.js';
import { canonicalMode, loadProject, normaliseDeploy, splitList, validateDeployTarget, writeProjectFile } from './project.js';
import { readProjectState, writeProjectState } from './project-state.js';
import { deployScript, dkRef, itemMarks, loadCommand, logsScript, parseMarks, probeScript, stateKey } from './remote.js';
import { archiveSize, progressText, saveArchiveStream } from './save-tar.js';
import { resolveServer } from './servers.js';
import { sshError } from './ssh.js';

/** Exit code for a deploy that reached the server but failed (health check, rollback, --then). */
export const DEPLOY_FAILED = EXIT.BUILD_FAILED;

/**
 * Split repeated `--tag-as` values: `name=ref` pairs, one bare ref for a single image, or one bare
 * ref per image in `--image` order (`positional`, when the counts match).
 */
export function parseTagAs(values = [], names = [], { positional = false } = {}) {
  const named = (v) => {
    const eq = v.indexOf('=');
    return eq > 0 && !v.slice(0, eq).includes(':') && !v.slice(0, eq).includes('/') ? [v.slice(0, eq), v.slice(eq + 1)] : null;
  };
  const bare = values.filter((v) => !named(v));
  if (bare.length && bare.length < values.length && names.length > 1) {
    throw new ConfigError('--tag-as values mix <image>=<name:tag> and bare <name:tag> forms.', { fix: 'Use one form: all <image>=<name:tag>, or one bare value per --image, in the same order.' });
  }
  if (positional && names.length > 1 && bare.length === values.length && values.length) {
    if (values.length !== names.length) {
      throw new ConfigError(`${values.length} --tag-as value${values.length === 1 ? '' : 's'} for ${names.length} images.`, { fix: 'Pass one --tag-as per --image, in the same order, or use --tag-as <image>=<name:tag>.' });
    }
    return Object.fromEntries(names.map((n, i) => [n, values[i]]));
  }
  const map = {};
  for (const v of values) {
    const pair = named(v);
    if (pair) map[pair[0]] = pair[1];
    else if (names.length === 1) map[names[0]] = v;
    else throw new ConfigError(`--tag-as "${v}" does not say which image it is for.`, { fix: `With several images use --tag-as <image>=<name:tag>, e.g. --tag-as ${names[0] || 'web'}=myapp-web:prod.` });
  }
  return map;
}

/** The deploy `--image` values as a list (the CLI passes an array; older callers a string). */
export function imageFlags(flags) {
  return [].concat(flags.image ?? []).filter(Boolean);
}

/** Short image name: last path part of a repository. */
const shortName = (repository) => repository.split('/').pop();

/**
 * Work out everything a deploy needs from flags, dockeriser.json and the saved servers. No network.
 * @param {object} opts
 * @param {string} opts.dir Project folder.
 * @param {object} opts.flags Parsed CLI flags.
 * @param {{project: string, region: string, repo: string}} opts.cfg
 * @param {string} opts.homeDir
 * @param {Record<string, string|undefined>} opts.env
 * @param {Array<{name: string, repository: string, digest: string}>} [opts.built] Images just built (exact digests).
 * @param {boolean} [opts.rollback]
 */
export function planDeploy({ dir, flags, cfg, homeDir, env, built = null, rollback = false }) {
  const project = loadProject(dir);
  // dockeriser.json's deploy section wins; else what an earlier deploy saved for this folder.
  const saved = project.deploy ? null : readProjectState(homeDir, project.root);
  const d = project.deploy || normaliseDeploy(saved?.deploy) || {};
  const target = flags.to || d.server;
  const server = resolveServer(target, { homeDir, env, flags: { key: flags.key, port: flags.port } });
  const mode = canonicalMode(flags.mode || d.mode || (flags['compose-dir'] || d.composeDir ? 'compose' : 'run'));
  const transfer = flags.transfer || d.transfer || server.transfer || 'ssh';
  const only = splitList(flags.only).length ? splitList(flags.only) : d.only || [];

  // Which images.
  let sources;
  if (built) {
    sources = built.map((b) => ({ name: b.name, repository: b.repository, digest: b.digest }));
    // Built images that the deploy section does not map (e.g. a pushed base image) stay put.
    const wanted = imageFlags(flags);
    if (wanted.length > 1) sources = wanted.map((n) => sources.find((s) => s.name === n || shortName(s.repository) === n)).filter(Boolean); // --image order, for --tag-as pairing
    else if (only.length) sources = sources.filter((s) => only.includes(s.name));
    else if (d.images && Object.keys(d.images).length && sources.some((s) => d.images[s.name])) sources = sources.filter((s) => d.images[s.name]);
  } else if (imageFlags(flags).length) {
    sources = imageFlags(flags).map((v) => parseDeployImage(v, cfg));
    const seen = new Set();
    for (const s of sources) {
      if (seen.has(s.name)) throw new ConfigError(`--image names "${s.name}" twice.`, { fix: 'Deploy each image once; pick one tag or digest.' });
      seen.add(s.name);
    }
  } else if (d.imageRefs?.length) {
    sources = d.imageRefs.map((v) => parseDeployImage(v, cfg));
  } else if (project.images.length) {
    let list = project.images.filter((i) => i.push);
    if (only.length) list = list.filter((i) => only.includes(i.name));
    else if (d.images && Object.keys(d.images).length) list = list.filter((i) => d.images[i.name]); // the mapped ones
    if (mode === 'run' && d.image) list = list.filter((i) => i.name === d.image || i.image === d.image);
    sources = list.map((i) => ({ name: i.name, repository: `${cfg.region}-docker.pkg.dev/${cfg.project}/${cfg.repo}/${i.image}`, tag: 'latest' }));
  } else if (d.image) {
    const img = expandImage({ image: d.image, project: cfg.project, region: cfg.region, repo: cfg.repo, fallbackTag: () => 'latest' });
    sources = [{ name: shortName(img.repository), repository: img.repository, tag: img.tags[0] }];
  } else {
    throw new ConfigError('Nothing to deploy: no --image and no images in dockeriser.json.', { fix: 'Pass --image <name>, run `dockeriser init`, or deploy with --build.' });
  }
  if (sources.length === 0) throw new ConfigError('No images matched (check --only and "push" in dockeriser.json).');
  if (mode === 'run' && sources.length > 1) {
    throw new ConfigError(`Mode "run" starts one container, but ${sources.length} images were picked (${sources.map((s) => s.name).join(', ')}).`, {
      fix: 'Pass --image or --only <one image>, or set "deploy.image" in dockeriser.json; for several images use --mode compose or load-only.',
    });
  }

  const tagAs = parseTagAs(flags['tag-as'] || [], sources.map((s) => s.name), { positional: imageFlags(flags).length > 1 });
  const flagServices = splitList(flags.service);
  const items = sources.map((s, i) => {
    const conf = d.images?.[s.name] || {};
    const item = {
      name: s.name,
      label: s.name,
      repository: s.repository,
      digest: s.digest || null,
      tag: s.tag || null,
      tagAs: tagAs[s.name] || conf.tagAs || null,
      services: i === 0 && flagServices.length ? flagServices : conf.services || [],
    };
    return item;
  });

  const run = {};
  if (mode === 'run') {
    run.name = flags.name || d.name || shortName(items[0].repository);
    run.ports = (flags.publish && flags.publish.length ? flags.publish : d.ports) || [];
    run.envFile = flags['env-file'] || d.envFile || null;
    run.healthUrl = flags['health-url'] || d.healthUrl || null;
    run.useEnv = Boolean(run.envFile);
    items[0].key = run.name;
  }
  const compose = { dir: flags['compose-dir'] || d.composeDir || null, file: flags['compose-file'] || d.composeFile || null, project: flags['compose-project'] || d.composeProject || null };
  for (const it of items) if (!it.key) it.key = it.tagAs || it.name;
  const then = flags.then || d.then || null;

  const plan = { project, server, target, mode, transfer, items, run, compose, then, rollback, explicitImages: !built && imageFlags(flags).length > 0 };
  validateDeployTarget({ mode, transfer, ports: run.ports, name: run.name, healthUrl: run.healthUrl, composeDir: compose.dir, items });
  // Written after the first good deploy; settings that already exist are not rewritten unless --save.
  plan.saveSection = project.deploy || saved?.deploy ? null : deploySection(plan);
  return plan;
}

/** The dockeriser.json "deploy" section a first deploy writes (paths only, never .env contents). */
export function deploySection(plan) {
  const s = { server: plan.target, mode: plan.mode };
  if (plan.transfer !== plan.server.transfer) s.transfer = plan.transfer;
  if (plan.mode === 'run') {
    s.name = plan.run.name;
    if (plan.run.ports.length) s.ports = plan.run.ports;
    if (plan.run.envFile) s.envFile = plan.run.envFile;
    if (plan.run.healthUrl) s.healthUrl = plan.run.healthUrl;
    if (plan.items.length === 1 && !plan.project.images.length) s.image = plan.items[0].name;
  }
  if (plan.mode === 'compose') {
    s.composeDir = plan.compose.dir;
    if (plan.compose.file) s.composeFile = plan.compose.file;
    if (plan.compose.project) s.composeProject = plan.compose.project;
  }
  const images = {};
  for (const it of plan.items) {
    const e = {};
    if (it.tagAs) e.tagAs = it.tagAs;
    if (it.services.length) e.services = it.services;
    if (Object.keys(e).length) images[it.name] = e;
  }
  if (Object.keys(images).length) s.images = images;
  // Explicit --image values, so a bare deploy, rollback or logs finds the same images (never a digest).
  if (plan.explicitImages && plan.items.length > 1) s.imageRefs = plan.items.map((it) => it.repository);
  else if (plan.explicitImages && !s.image && !plan.project.images.length) s.image = plan.items[0].name;
  if (plan.then) s.then = plan.then;
  return s;
}

/**
 * Save the deploy settings after a good deploy: per user (default, the repo stays clean), into
 * dockeriser.json (`--save`, always rewrites the section), or nowhere (`--no-save`).
 * @param {ReturnType<typeof planDeploy>} plan
 * @param {{homeDir: string, where?: 'state'|'file'|'none'}} opts
 * @returns {{kind: 'project-state'|'dockeriser.json', file: string}|null}
 */
export function saveDeploySection(plan, { homeDir, where = 'state' }) {
  if (where === 'none') return null;
  if (where === 'file') {
    const data = plan.project.raw ? { ...plan.project.raw } : {};
    data.deploy = deploySection(plan);
    writeProjectFile(plan.project.file, data);
    return { kind: 'dockeriser.json', file: plan.project.file };
  }
  if (!plan.saveSection) return null;
  return { kind: 'project-state', file: writeProjectState(homeDir, plan.project.root, plan.saveSection) };
}

/** Bytes counter that reports progress at most every `everyMs`. */
function progressCounter(total, onProgress, { now = () => Date.now(), everyMs = 2000 } = {}) {
  const start = now();
  let sent = 0;
  let last = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const t = now();
      if (t - last >= everyMs) {
        last = t;
        onProgress(progressText(sent, total, t - start), sent);
      }
      cb(null, chunk);
    },
    flush(cb) {
      onProgress(progressText(sent, total, now() - start), sent);
      cb();
    },
  });
}

/** Split streamed text into lines, holding partial lines until complete. */
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(text) {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/**
 * Run a script on the server through `bash -s`, streaming its non-marker output.
 * @returns {Promise<{code: number, stdout: string, stderr: string, marks: object[], logs: string[], values: object}>}
 */
export async function runScript({ ssh, server, script, out, quiet = false }) {
  const lines = lineSplitter((line) => {
    if (!quiet && !line.startsWith('@@dk ')) out.log(`  ${line}\n`);
  });
  const res = await ssh.exec(server, 'bash -s', {
    input: script,
    onStdout: (t) => lines.push(t),
    onStderr: (t) => {
      if (!quiet) out.log(t.replace(/^(?=.)/gm, '  '));
    },
  });
  lines.end();
  if (res.code === 255) throw sshError(res, server);
  return { ...res, ...parseMarks(res.stdout) };
}

/** Human disk text from KB. */
const gb = (kb) => (kb ? `${(Number(kb) / 1024 / 1024).toFixed(1)} GB free` : 'unknown');

/**
 * Carry out a planned deploy (or rollback).
 * @param {object} opts
 * @param {ReturnType<typeof planDeploy>} opts.plan
 * @param {{exec: Function}} opts.ssh Injected ssh runner.
 * @param {() => Promise<ReturnType<import('./registry.js').createRegistryClient>>} [opts.getRegistry] Lazy registry client.
 * @param {object} opts.out Output helpers.
 * @param {boolean} [opts.dryRun] Print the remote script instead of running anything.
 * @returns {Promise<object>} The result object (also the --json output).
 */
export async function executeDeploy({ plan, ssh, getRegistry, out, dryRun = false, now = () => Date.now() }) {
  const { server, mode, transfer, items, rollback } = plan;
  const t0 = now();
  const secs = (ms) => Math.round(ms / 100) / 10;
  const timings = { checkSec: 0, transferSec: 0, uploadSec: 0, scriptSec: 0 };
  const timed = async (key, fn) => {
    const t = now();
    try {
      return await fn();
    } finally {
      timings[key] = secs(now() - t);
    }
  };
  const result = {
    status: 'SUCCESS',
    exitCode: 0,
    action: rollback ? 'rollback' : 'deploy',
    server: server.name || server.host,
    host: server.host,
    mode,
    transfer,
    container: mode === 'run' ? plan.run.name : null,
    image: items[0].repository,
    digest: items[0].digest,
    previousDigest: null,
    rolledBack: false,
    logsTail: [],
    items: [],
    transferredBytes: 0,
    diskFreeBefore: null,
    diskFreeAfter: null,
    then: plan.then ? 'not-run' : null,
    durationSec: 0,
    timings,
  };
  const done = () => {
    result.durationSec = secs(now() - t0);
    return result;
  };

  // 1. Exact digests (a build hands them over; otherwise <image>:<tag> is looked up).
  if (!rollback) {
    for (const it of items) {
      if (!it.digest) {
        if (dryRun) it.digest = `sha256:${'0'.repeat(64)}`;
        else {
          const registry = await getRegistry();
          it.digest = await registry.resolveDigest(`${it.repository}:${it.tag || 'latest'}`);
        }
      }
      it.dkRef = dkRef(it.repository, it.digest);
      it.pullRef = `${it.repository}@${it.digest}`;
    }
    result.digest = items[0].digest;
  } else {
    for (const it of items) it.dkRef = it.dkRef || '';
  }

  // 2. Env file (run mode): read locally, sent inside the script's stdin, never printed or saved.
  let envBase64 = null;
  if (mode === 'run' && plan.run.envFile && !rollback) {
    const envPath = path.resolve(plan.project.root, plan.run.envFile);
    try {
      envBase64 = fs.readFileSync(envPath).toString('base64');
    } catch (err) {
      throw new ConfigError(`The env file ${envPath} could not be read (${err.code || err.message}).`);
    }
  }
  const scriptFor = (env64) =>
    deployScript({
      mode,
      transfer,
      items,
      rollback,
      run: { ...plan.run, envBase64: env64 },
      compose: plan.compose,
      then: plan.then,
    });

  if (dryRun) {
    result.status = 'DRY_RUN';
    result.script = scriptFor(envBase64 ? 'UkVEQUNURUQ=' : null); // env contents are never shown
    return done();
  }

  // 3. Transfer "ssh": skip images the server already has, stream the rest into docker load.
  if (transfer === 'ssh' && !rollback) {
    const registry = await getRegistry();
    out.step(`Checking ${server.host}`);
    const probe = await timed('checkSec', () => runScript({ ssh, server, script: probeScript({ refs: items.map((i) => i.dkRef) }), out, quiet: true }));
    if (probe.values.docker === 'missing') {
      throw new ConfigError(`Docker is not installed on ${server.host}.`, { fix: `Run: dockeriser server add <name> --host ${server.host} --install-docker   (or on the server: curl -fsSL https://get.docker.com | sh)` });
    }
    result.diskFreeBefore = Number(probe.values.disk_kb) || null;
    const have = new Set(probe.marks.filter((m) => m.have !== undefined).map((m) => Number(m.have)));
    const toSend = [];
    for (const [i, it] of items.entries()) {
      if (have.has(i)) {
        it.transferred = 'skipped';
        out.info(`    ${it.label}: already on the server, not sending`);
      } else if (!toSend.some((t) => t.dkRef === it.dkRef)) {
        it.manifest = await registry.imageManifest(it.pullRef);
        it.transferred = 'sent';
        toSend.push(it);
      } else {
        it.transferred = 'sent';
      }
    }
    if (toSend.length) {
      const images = toSend.map((it) => ({ manifest: it.manifest, repoTags: [it.dkRef] }));
      const total = archiveSize(images);
      out.step(`Sending ${toSend.map((t) => t.label).join(', ')} to ${server.host} (${(total / 1e6).toFixed(1)} MB, compressed layers)`);
      const archive = saveArchiveStream({ images, openBlob: (repo, digest) => registry.blobStream(repo, digest) });
      let sent = 0;
      const counter = progressCounter(total, (text, n) => {
        sent = n;
        out.info(`    ${text}`);
      }, { now });
      archive.on('error', (err) => counter.destroy(err));
      const piped = archive.pipe(counter);
      const res = await timed('transferSec', () => ssh.exec(server, loadCommand(), { input: piped, onStdout: (t) => out.log(t.replace(/^(?=.)/gm, '    ')), onStderr: (t) => out.log(t.replace(/^(?=.)/gm, '    ')) }));
      if (res.code === 255) throw sshError(res, server);
      if (res.code !== 0) throw new DockeriserError(`docker load failed on ${server.host} (exit ${res.code}): ${res.stderr.trim().split('\n').slice(-2).join(' ')}`, { fix: 'Check free disk space on the server (`df -h`), then deploy again.' });
      result.transferredBytes = sent;
    }
  }

  // 4. The deploy script: one SSH session.
  out.step(`${rollback ? 'Rolling back' : 'Deploying'} on ${server.host} (${mode})`);
  const res = await timed('scriptSec', () => runScript({ ssh, server, script: scriptFor(envBase64), out }));
  const v = res.values;
  if (v.error === 'no-docker') throw new ConfigError(`Docker is not usable on ${server.host}.`, { fix: 'Install it with `dockeriser server add <name> --host <host> --install-docker`.' });
  if (v.error === 'no-previous') throw new ConfigError(`There is no previous image recorded on ${server.host} to roll back to.`);
  result.diskFreeBefore = result.diskFreeBefore ?? (Number(v.disk_before_kb) || null);
  result.diskFreeAfter = Number(v.disk_after_kb) || null;
  result.logsTail = res.logs;
  result.previousDigest = v.previous || itemMarks(res.marks, 0).previous || null;
  result.rolledBack = v.rolledback === '1';
  result.items = items.map((it, i) => {
    const m = itemMarks(res.marks, i);
    return { name: it.name, image: it.repository, digest: it.digest || null, tagAs: it.tagAs, services: it.services, transferred: it.transferred || (transfer === 'pull' ? 'pulled' : null), imageId: m.new || null, previousImageId: (mode === 'run' ? v.previous : m.previous) || null };
  });
  if (plan.then) result.then = v.then || 'not-run';

  if (res.code === 0 && v.result === 'ok') {
    out.ok(`${rollback ? 'Rolled back' : 'Deployed'} ${items.map((i) => i.label).join(', ')} on ${server.host}${mode === 'run' ? ` (container ${plan.run.name})` : ''}`);
    if (result.diskFreeBefore || result.diskFreeAfter) out.info(`    disk: ${gb(result.diskFreeBefore)} before, ${gb(result.diskFreeAfter)} after`);
    return done();
  }
  result.exitCode = res.code === 0 ? DEPLOY_FAILED : res.code === 20 ? EXIT.CONFIG : DEPLOY_FAILED;
  result.status = result.rolledBack ? 'ROLLED_BACK' : 'FAILED';
  if (v.health === 'failed') {
    out.error({ message: `Health check failed on ${server.host}: ${v.reason || 'see the log lines above'}`, fix: result.rolledBack ? 'The previous version is running again. Fix the problem and deploy again.' : v.rolledback === '0' ? 'There was no previous version to roll back to.' : 'Rolling back also failed; check the server.' });
  } else if (v.then === 'failed') {
    out.error({ message: `The --then command failed on ${server.host} (exit ${v.code}).`, fix: 'The new images are in place. Fix the command, or run `dockeriser rollback` to go back.' });
  } else if (v.error) {
    out.error({ message: `Deploy failed on ${server.host}: ${v.error}`, fix: res.stderr.trim().split('\n').slice(-2).join(' ') || null });
  } else {
    out.error({ message: `Deploy failed on ${server.host} (exit ${res.code}).`, fix: res.stderr.trim().split('\n').slice(-2).join(' ') || null });
  }
  return done();
}

/**
 * `dockeriser logs`: docker logs (or compose logs) over SSH, streamed straight through.
 */
export async function streamLogs({ plan, ssh, out, tail = 100, follow = false }) {
  const services = [...new Set(plan.items.flatMap((i) => i.services))];
  const script = logsScript({ mode: plan.mode === 'compose' ? 'compose' : 'run', name: plan.run.name || plan.items[0].key, compose: plan.compose, services, tail, follow });
  if (plan.mode === 'load-only') throw new ConfigError('Mode "load-only" does not start containers, so dockeriser has no logs to show.', { fix: 'Use `ssh <server> docker logs <container>`, or deploy with --mode run or compose.' });
  const res = await ssh.exec(plan.server, 'bash -s', { input: script, onStdout: (t) => out.log(t), onStderr: (t) => out.log(t) });
  if (res.code === 255) throw sshError(res, plan.server);
  return res.code === 0 ? EXIT.OK : EXIT.BUILD_FAILED;
}

export { stateKey };
