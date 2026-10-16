/**
 * `dockeriser server add | list | check | remove`.
 *
 * Transfer "ssh" (default): only checks SSH and Docker; nothing about Google goes on the server.
 * Transfer "pull": also creates (once) a read-only service account `dockeriser-puller` with
 * roles/artifactregistry.reader on the one repo, makes a key for it, streams the key over SSH into
 * /etc/dockeriser/puller.json (600, root), runs `docker login` there, and deletes the local copy.
 * The gcloud calls run as the signed-in gcloud user (the dockeriser account can't create accounts).
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuthError, ConfigError, DockeriserError } from './errors.js';
import { installDockerScript, installPullerKeyScript, probeScript, registryCheckScript, remoteBash } from './remote.js';
import { runScript } from './deploy.js';
import { checkServerName, resolveServer, saveServer } from './servers.js';
import { checkHost, sshError } from './ssh.js';
import { findGcloud } from './status.js';

export const PULLER_ID = 'dockeriser-puller';

/** Default gcloud runner: returns {code, stdout, stderr}; never prints. */
export function createGcloudRunner({ env = process.env } = {}) {
  return (args) => {
    const found = findGcloud({ env });
    if (!found.installed) throw new ConfigError('gcloud is not installed.', { fix: 'Install it (Windows: winget install Google.CloudSDK), open a new terminal, and sign in with `gcloud auth login`.' });
    const quoted = process.platform === 'win32' ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    const res = spawnSync(found.path, quoted, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, env });
    return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
  };
}

/**
 * Create (once) the puller service account, grant it read on the repo, and make a key file.
 * @returns {{email: string, keyFile: string, keyId: string|null}}
 */
export function makePullerKey({ gcloud, cfg, tmpDir, out }) {
  const email = `${PULLER_ID}@${cfg.project}.iam.gserviceaccount.com`;
  const p = ['--project', cfg.project];
  const fail = (what, res) => {
    const msg = res.stderr.trim().split('\n').slice(-2).join(' ');
    if (/not allowed|disableServiceAccountKeyCreation/i.test(msg)) {
      return new AuthError(`Google would not create a key for ${email}: ${msg}`, { fix: 'Your organisation blocks service account keys. Use the default transfer instead: dockeriser server add <name> --host <host> (no --transfer pull).' });
    }
    if (/auth|credential|login/i.test(msg)) return new AuthError(`gcloud could not ${what}: ${msg}`, { fix: 'Sign in with `gcloud auth login` as the project owner, then try again.' });
    return new DockeriserError(`gcloud could not ${what}: ${msg}`);
  };
  if (gcloud(['iam', 'service-accounts', 'describe', email, ...p, '--format=value(email)']).code !== 0) {
    const res = gcloud(['iam', 'service-accounts', 'create', PULLER_ID, ...p, '--display-name=dockeriser puller (read-only)']);
    if (res.code !== 0 && !/already exists/i.test(res.stderr)) throw fail('create the puller account', res);
    out.info(`    created ${email}`);
  }
  const bind = gcloud(['artifacts', 'repositories', 'add-iam-policy-binding', cfg.repo, '--location', cfg.region, ...p, `--member=serviceAccount:${email}`, '--role=roles/artifactregistry.reader', '--format=none']);
  if (bind.code !== 0) throw fail(`give ${email} read access to the ${cfg.repo} repo`, bind);
  const keyFile = path.join(tmpDir, `dockeriser-puller-${crypto.randomBytes(6).toString('hex')}.json`);
  const key = gcloud(['iam', 'service-accounts', 'keys', 'create', keyFile, `--iam-account=${email}`, ...p]);
  if (key.code !== 0) {
    fs.rmSync(keyFile, { force: true });
    throw fail('create a key', key);
  }
  let keyId = null;
  try {
    keyId = JSON.parse(fs.readFileSync(keyFile, 'utf8')).private_key_id || null; // only the id is kept
  } catch {
    keyId = null;
  }
  return { email, keyFile, keyId };
}

/**
 * Look at a server: SSH works, Docker works, disk; with transfer "pull", registry login works.
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, status: 'ok'|'fail'|'warn', detail: string, fix?: string}>}>}
 */
export async function checkServer({ server, ssh, out, cfg }) {
  const checks = [];
  let probe;
  try {
    probe = await runScript({ ssh, server, script: probeScript(), out, quiet: true });
    checks.push({ name: 'SSH', status: 'ok', detail: `signed in as ${probe.values.user} (${probe.values.arch}${probe.values.sudo && probe.values.sudo !== 'none' ? ', sudo' : ''})` });
  } catch (err) {
    checks.push({ name: 'SSH', status: 'fail', detail: err.message, fix: err.fix });
    return { ok: false, checks };
  }
  if (probe.values.docker === 'missing' || !probe.values.docker) {
    checks.push({ name: 'Docker', status: 'fail', detail: 'not installed or not usable', fix: `dockeriser server add ${server.name || '<name>'} --host ${server.host} --install-docker   (or on the server: curl -fsSL https://get.docker.com | sh)` });
    return { ok: false, checks };
  }
  checks.push({ name: 'Docker', status: 'ok', detail: `version ${probe.values.docker}` });
  if (probe.values.arch && !/x86_64|amd64/.test(probe.values.arch)) {
    checks.push({ name: 'CPU', status: 'warn', detail: `${probe.values.arch}; Cloud Build makes linux/amd64 images` });
  }
  const kb = Number(probe.values.disk_kb);
  if (kb) checks.push({ name: 'Disk', status: kb < 2 * 1024 * 1024 ? 'warn' : 'ok', detail: `${(kb / 1024 / 1024).toFixed(1)} GB free for Docker` });
  if (server.transfer === 'pull') {
    const probeRef = `${cfg.region}-docker.pkg.dev/${cfg.project}/${cfg.repo}/dockeriser-access-check:none`;
    const reg = await runScript({ ssh, server, script: registryCheckScript({ probeRef }), out, quiet: true });
    if (reg.values.registry === 'ok') checks.push({ name: 'Registry login', status: 'ok', detail: `can read ${cfg.region}-docker.pkg.dev/${cfg.project}/${cfg.repo}` });
    else checks.push({ name: 'Registry login', status: 'fail', detail: 'the server cannot read the repo', fix: `Re-run: dockeriser server add ${server.name || '<name>'} --host ${server.host} --transfer pull` });
  } else {
    checks.push({ name: 'Transfer', status: 'ok', detail: 'ssh (images are streamed from Artifact Registry through this PC; no key on the server)' });
  }
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

/**
 * `server add`.
 * @param {object} opts
 */
export async function addServer({ name, flags, homeDir, env, cfg, ssh, gcloud, out, tmpDir }) {
  checkServerName(name);
  if (!flags.host) throw new ConfigError('Missing --host.', { fix: 'dockeriser server add <name> --host user@ip-or-hostname [--port 22] [--key ~/.ssh/id_ed25519]' });
  checkHost(flags.host);
  const transfer = flags.transfer || 'ssh';
  if (!['ssh', 'pull'].includes(transfer)) throw new ConfigError(`--transfer "${transfer}" must be ssh or pull.`);
  const previous = (() => {
    try {
      return resolveServer(name, { homeDir, env });
    } catch {
      return null;
    }
  })();
  const server = { name, host: flags.host, port: flags.port ? Number(flags.port) : undefined, key: flags.key || undefined, transfer };
  const effective = resolveServer(flags.host, { homeDir, env, flags: { key: flags.key, port: flags.port } });
  const conn = { ...effective, name, transfer };

  out.step(`Connecting to ${flags.host}`);
  let probe = await runScript({ ssh, server: conn, script: probeScript(), out, quiet: true });
  out.info(`    signed in as ${probe.values.user}`);
  if (probe.values.docker === 'missing') {
    if (!flags['install-docker']) {
      throw new ConfigError(`Docker is not installed on ${flags.host}.`, { fix: `Add --install-docker to install it with Docker's script, or run on the server: curl -fsSL https://get.docker.com | sh` });
    }
    out.step('Installing Docker (get.docker.com)');
    const res = await runScript({ ssh, server: conn, script: installDockerScript(), out });
    if (res.code !== 0) throw new DockeriserError(`Installing Docker failed on ${flags.host} (exit ${res.code}).`, { fix: 'Install it by hand on the server: curl -fsSL https://get.docker.com | sh' });
    probe = await runScript({ ssh, server: conn, script: probeScript(), out, quiet: true });
  }
  out.info(`    docker ${probe.values.docker}`);

  let keyId = previous?.keyId;
  if (transfer === 'pull') {
    out.step('Giving the server read-only access to the image repo');
    const made = makePullerKey({ gcloud, cfg, tmpDir, out });
    try {
      const script = installPullerKeyScript({ registryHost: `${cfg.region}-docker.pkg.dev` });
      const res = await ssh.exec(conn, remoteBash(script), { input: fs.readFileSync(made.keyFile) });
      if (res.code === 255) throw sshError(res, conn);
      if (!res.stdout.includes('login=ok')) throw new DockeriserError(`docker login on ${flags.host} failed: ${res.stderr.trim().split('\n').pop() || 'no detail'}`);
      out.info(`    key saved on the server as /etc/dockeriser/puller.json (600, root); docker is signed in`);
    } finally {
      fs.rmSync(made.keyFile, { force: true });
    }
    if (keyId && made.keyId && keyId !== made.keyId) {
      const del = gcloud(['iam', 'service-accounts', 'keys', 'delete', keyId, `--iam-account=${made.email}`, '--project', cfg.project, '--quiet']);
      if (del.code === 0) out.info('    removed the key this server used before');
    }
    keyId = made.keyId;
  }
  saveServer(homeDir, name, { ...server, keyId: transfer === 'pull' ? keyId : undefined });
  out.ok(`Saved server "${name}" (${flags.host}, transfer ${transfer})`);
  const check = await checkServer({ server: { ...conn, transfer }, ssh, out, cfg });
  return { name, server: { ...server }, check };
}

/** Print check results. */
export function printChecks(checks, out) {
  for (const c of checks) {
    const mark = c.status === 'ok' ? out.colour('green', 'ok  ') : c.status === 'warn' ? out.colour('yellow', 'warn') : out.colour('red', 'FAIL');
    out.info(`  ${mark} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== 'ok') out.info(`       fix: ${c.fix}`);
  }
}
