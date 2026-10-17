import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import * as tar from 'tar';
import { shq, sshArgs, sshError, checkHost } from '../src/ssh.js';
import { deployScript, dkRef, parseMarks, probeScript, logsScript, installPullerKeyScript, registryCheckScript, installDockerScript, loadCommand } from '../src/remote.js';
import { archiveSize, progressText, saveArchiveStream, saveManifest, tarHeader } from '../src/save-tar.js';
import { pickPlatform, createRegistryClient, MEDIA } from '../src/registry.js';
import { executeDeploy, planDeploy, parseTagAs, saveDeploySection } from '../src/deploy.js';
import { parseDeployImage } from '../src/image.js';
import { tempTree, sink } from './helpers.js';
import { createOutput } from '../src/output.js';

const CFG = { project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images' };
const REPO = 'northamerica-northeast2-docker.pkg.dev/demo-proj/docker-images';

/** Git Bash (Windows) or bash (elsewhere), for syntax checks and running scripts. */
function findBash() {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'] : ['/bin/bash', '/usr/bin/bash'];
  return candidates.find((c) => fs.existsSync(c)) || null;
}
const BASH = findBash();

function bashSyntaxOk(script) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-sh-')), 's.sh');
  fs.writeFileSync(file, script);
  const res = spawnSync(BASH, ['-n', file], { encoding: 'utf8' });
  return { ok: res.status === 0, err: res.stderr };
}

const out = () => {
  const stdout = sink();
  const stderr = sink();
  return { o: createOutput({ json: true, stdout, stderr, env: {} }), stdout, stderr };
};

test('ssh command lines: BatchMode, accept-new host keys, port and key only when given', () => {
  const a = sshArgs({ host: 'root@203.0.113.5' });
  assert.deepEqual(a.slice(0, 2), ['-o', 'BatchMode=yes']);
  assert.ok(a.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(!a.includes('-p') && !a.includes('-i'), 'leaves port and key to ~/.ssh/config');
  assert.equal(a.at(-1), 'root@203.0.113.5');
  const b = sshArgs({ host: 'deploy@web.example.com', port: 2222, key: '~/.ssh/id_ed25519' }, { homeDir: '/home/u' });
  assert.deepEqual(b.slice(b.indexOf('-p'), b.indexOf('-p') + 2), ['-p', '2222']);
  assert.equal(b[b.indexOf('-i') + 1], path.join('/home/u', '.ssh/id_ed25519'));
  assert.ok(b.includes('IdentitiesOnly=yes'));
  assert.throws(() => sshArgs({ host: '-oProxyCommand=evil' }), /not a valid ssh destination/);
  assert.throws(() => sshArgs({ host: 'a@b', port: 70000 }), /Port/);
  assert.equal(checkHost('myalias'), 'myalias');
});

test('ssh failures become friendly errors with the key fix', () => {
  const e = sshError({ code: 255, stderr: 'root@1.2.3.4: Permission denied (publickey).' }, { host: 'root@1.2.3.4', key: '~/.ssh/k' });
  assert.equal(e.exitCode, 3);
  assert.match(e.fix, /ssh-copy-id -i ~\/.ssh\/k root@1.2.3.4/);
  assert.match(e.fix, /authorized_keys/);
  assert.match(sshError({ code: 255, stderr: 'Connection timed out' }, { host: 'h' }).message, /Could not connect/);
});

test('shell quoting survives quotes, spaces and $', () => {
  assert.equal(shq(`it's $HOME`), `'it'\\''s $HOME'`);
  if (!BASH) return;
  const res = spawnSync(BASH, ['-c', `printf '%s' ${shq(`a 'b' "c" $d \`e\``)}`], { encoding: 'utf8' });
  assert.equal(res.stdout, `a 'b' "c" $d \`e\``);
});

const runItems = () => [{ label: 'web', key: 'web', dkRef: dkRef(`${REPO}/web`, 'sha256:abc123def4567890'), pullRef: `${REPO}/web@sha256:abc123def4567890` }];

test('run-mode script: ports, env file, health URL, rollback branch, and valid bash', () => {
  const s = deployScript({
    mode: 'run',
    transfer: 'ssh',
    items: runItems(),
    run: { name: 'web', ports: ['80:3000', '127.0.0.1:9000:9000'], envBase64: Buffer.from('A=1').toString('base64'), useEnv: true, healthUrl: 'http://localhost:3000/health' },
  });
  assert.match(s, /-p '80:3000' -p '127.0.0.1:9000:9000'/);
  assert.match(s, /--env-file "\$2"/);
  assert.match(s, /umask 077; printf '%s' 'QT0x' \| base64 -d/);
  assert.match(s, /curl -fsS -o \/dev\/null --max-time 5 'http:\/\/localhost:3000\/health'/);
  assert.match(s, /--restart unless-stopped/);
  assert.match(s, /rolling back to the previous image/);
  assert.match(s, /mark rolledback=1/);
  assert.match(s, /web:dk-abc123def456/);
  assert.ok(!s.includes('docker image prune'), 'never prunes images dockeriser did not pull');
  if (BASH) assert.deepEqual(bashSyntaxOk(s), { ok: true, err: '' });
});

test('compose, load-only (with --then), pull transfer, rollback, logs and helper scripts are valid bash', () => {
  const items = [
    { label: 'api', key: 'app:demo', tagAs: 'app:demo', services: ['api', 'worker'], dkRef: `${REPO}/app:dk-111111111111`, pullRef: `${REPO}/app@sha256:1111` },
    { label: 'web', key: 'web:demo', tagAs: 'web:demo', services: ['web'], dkRef: `${REPO}/web:dk-222222222222`, pullRef: `${REPO}/web@sha256:2222` },
  ];
  const compose = deployScript({ mode: 'compose', transfer: 'pull', items, compose: { dir: '/opt/my app', file: 'compose.prod.yml', project: 'demo' } });
  assert.ok(compose.includes(`$D pull '${REPO}/app@sha256:1111'`));
  assert.match(compose, /\$D compose -f 'compose.prod.yml' -p 'demo'/);
  assert.match(compose, /up -d --no-deps 'api' 'worker' 'web'/);
  assert.match(compose, /\$D tag "\$PREV_0" 'app:demo'/);
  const loadOnly = deployScript({ mode: 'load-only', transfer: 'ssh', items, then: `cd /opt/app && bash remote.sh "it's"` });
  assert.match(loadOnly, /mark health=skipped/);
  assert.match(loadOnly, /if bash -c 'cd \/opt\/app && bash remote.sh "it'\\''s"'; then mark then=ok/);
  const rollback = deployScript({ mode: 'compose', transfer: 'ssh', items, rollback: true, compose: { dir: '/opt/app' } });
  assert.match(rollback, /NEW_0=\$\(get 'app_demo.previous'\)/);
  assert.ok(!rollback.includes('removing old image'), 'rollback keeps every image');
  if (!BASH) return;
  for (const script of [compose, loadOnly, rollback, probeScript({ refs: ['a:b'] }), logsScript({ mode: 'compose', compose: { dir: '/opt/app' }, services: ['api'], follow: true }), installPullerKeyScript({ registryHost: 'r-docker.pkg.dev' }), registryCheckScript({ probeRef: 'x/y:z' }), installDockerScript()]) {
    assert.deepEqual(bashSyntaxOk(script), { ok: true, err: '' });
  }
  const lc = loadCommand();
  assert.ok(/^t=\$\(mktemp\) && echo [A-Za-z0-9+/=]+ \| base64 -d > \$t && bash \$t; r=\$\?; rm -f \$t; exit \$r$/.test(lc), lc);
  assert.ok(!/["'\n]/.test(lc), 'no quotes or newlines on the ssh command line');
  const decoded = Buffer.from(lc.match(/echo (\S+)/)[1], 'base64').toString();
  assert.match(decoded, /\$D load$/);
  if (BASH) assert.deepEqual(bashSyntaxOk(decoded), { ok: true, err: '' });
});

test('rollback path really runs: a container that dies is replaced by the previous image', { skip: !BASH }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-run-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'docker.log').replace(/\\/g, '/');
  // A fake docker: the new image's container stops at once; everything is logged.
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> '${log}'
case "$1 $2 $3" in
  "info "*|"info --format"*) [ "$2" = "--format" ] && echo /nonexistent; exit 0 ;;
esac
if [ "$1" = image ] && [ "$2" = inspect ]; then echo sha256:new; exit 0; fi
if [ "$1" = inspect ]; then
  case "$3" in
    '{{.Image}}') if grep -q 'run .* sha256:new' '${log}'; then echo sha256:new; else echo sha256:old; fi ;;
    '{{.State.Running}}') if tail -n 3 '${log}' | grep -q 'run .*sha256:old'; then echo true; else echo false; fi ;;
    '{{.RestartCount}}') echo 0 ;;
  esac
  exit 0
fi
if [ "$1" = logs ]; then echo "Error: boom"; exit 0; fi
exit 0
`, { mode: 0o755 });
  const script = deployScript({ mode: 'run', transfer: 'ssh', items: runItems(), run: { name: 'web', ports: ['80:3000'], waitSec: 0 } });
  const res = spawnSync(BASH, ['-s'], {
    input: script,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)}:${process.env.PATH}`, HOME: dir },
  });
  const { values, logs } = parseMarks(res.stdout);
  assert.equal(res.status, 10, res.stdout + res.stderr);
  assert.equal(values.health, 'failed');
  assert.equal(values.rolledback, '1');
  assert.equal(values.previous, 'sha256:old');
  assert.deepEqual(logs, ['Error: boom']);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /run -d --name web --restart unless-stopped --label dockeriser=1 -p 80:3000 sha256:new/);
  assert.match(calls, /run -d --name web --restart unless-stopped --label dockeriser=1 -p 80:3000 sha256:old/);
});

const blob = (text) => {
  const buf = Buffer.from(text);
  return { buf, digest: `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`, size: buf.length };
};

test('docker save archive: valid tar, manifest.json shape, each blob once, size and progress maths', async () => {
  const config = blob('{"rootfs":{}}');
  const l1 = blob('layer-one');
  const l2 = blob('layer-two-longer');
  const blobs = new Map([config, l1, l2].map((b) => [b.digest, b.buf]));
  const manifest = { repository: `${REPO}/web`, config: { digest: config.digest, size: config.size }, layers: [l1, l2].map((b) => ({ digest: b.digest, size: b.size })) };
  const manifest2 = { ...manifest, layers: [manifest.layers[0]] }; // shares a layer
  const images = [{ manifest, repoTags: [`${REPO}/web:dk-1`] }, { manifest: manifest2, repoTags: [`${REPO}/web:dk-2`] }];
  assert.deepEqual(saveManifest(images)[0], {
    Config: `blobs/sha256/${config.digest.slice(7)}`,
    RepoTags: [`${REPO}/web:dk-1`],
    Layers: [`blobs/sha256/${l1.digest.slice(7)}`, `blobs/sha256/${l2.digest.slice(7)}`],
  });
  const chunks = [];
  for await (const c of saveArchiveStream({ images, openBlob: async (_r, d) => Readable.from([blobs.get(d)]), mtime: 0 })) chunks.push(c);
  const archive = Buffer.concat(chunks);
  assert.equal(archive.length, archiveSize(images));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-tar-'));
  const file = path.join(dir, 'a.tar');
  fs.writeFileSync(file, archive);
  const entries = [];
  await tar.t({ file, onentry: (e) => entries.push([e.path, e.size]) });
  assert.deepEqual(entries.map((e) => e[0]), ['manifest.json', ...[config, l1, l2].map((b) => `blobs/sha256/${b.digest.slice(7)}`)]);
  await tar.x({ file, cwd: dir });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'blobs/sha256', l2.digest.slice(7)), 'utf8'), 'layer-two-longer');
  assert.equal(tarHeader('x', 1).length, 512);
  // A blob that does not match its digest is refused.
  const bad = saveArchiveStream({ images: [images[1]], openBlob: async () => Readable.from([Buffer.from('tampered')]) });
  await assert.rejects(async () => {
    for await (const _ of bad); // eslint-disable-line no-unused-vars
  }, /larger than|ended after|arrived with digest/);
  assert.equal(progressText(50e6, 200e6, 10_000), '50.0 / 200.0 MB, 25% (5.0 MB/s)');
  assert.equal(progressText(0, 0, 0), '0.0 / 0.0 MB, 100% (0.0 MB/s)');
});

test('manifest lists: linux/amd64 is picked; attestations and missing platforms handled', async () => {
  const index = { manifests: [
    { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
    { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } },
    { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
  ] };
  assert.equal(pickPlatform(index).digest, 'sha256:amd');
  assert.throws(() => pickPlatform({ manifests: [index.manifests[0], { digest: 'x', platform: { os: 'windows', architecture: 'amd64' } }] }), /no linux\/amd64/);

  // Through the registry client, with a mocked fetch: index -> image manifest, plus the 401 token exchange.
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET', init.headers?.Authorization]);
    const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
    if (url.startsWith('https://auth.example/token')) return { ok: true, status: 200, json: async () => ({ token: 'registry-token' }), headers: h({}) };
    if (init.headers?.Authorization === 'Bearer google-token') return { ok: false, status: 401, headers: h({ 'www-authenticate': 'Bearer realm="https://auth.example/token",service="r"' }) };
    if (url.endsWith('/manifests/sha256:top')) return { ok: true, status: 200, headers: h({ 'docker-content-digest': 'sha256:top' }), text: async () => JSON.stringify({ mediaType: MEDIA.ociIndex, manifests: index.manifests }) };
    if (url.endsWith('/manifests/sha256:amd')) return { ok: true, status: 200, headers: h({}), text: async () => JSON.stringify({ mediaType: MEDIA.ociManifest, config: { digest: 'sha256:cfg', size: 5 }, layers: [{ digest: 'sha256:l1', size: 9, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }] }) };
    if (url.endsWith('/manifests/latest')) return { ok: true, status: 200, headers: h({ 'docker-content-digest': 'sha256:top' }) };
    return { ok: false, status: 404, headers: h({}) };
  };
  const reg = createRegistryClient({ getAccessToken: async () => 'google-token', fetch });
  const m = await reg.imageManifest(`${REPO}/web@sha256:top`);
  assert.equal(m.manifestDigest, 'sha256:amd');
  assert.equal(m.config.digest, 'sha256:cfg');
  assert.equal(m.layers[0].size, 9);
  assert.equal(await reg.resolveDigest(`${REPO}/web:latest`), 'sha256:top');
  assert.ok(calls.some(([u, , a]) => u.startsWith('https://auth.example/token') && a === `Basic ${Buffer.from('oauth2accesstoken:google-token').toString('base64')}`));
  assert.ok(calls.some(([, , a]) => a === 'Bearer registry-token'));
});

/** A project folder + saved server for deploy tests. */
function deployFixture(projectJson) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-home-'));
  fs.mkdirSync(path.join(home, '.dockeriser'));
  fs.writeFileSync(path.join(home, '.dockeriser', 'config.json'), JSON.stringify({ project: 'demo-proj', sshKey: '~/.ssh/shared', servers: { prod: { host: 'root@203.0.113.5' } } }));
  const dir = tempTree({ Dockerfile: 'FROM alpine\n', '.env': 'SECRET=hunter2\n', ...(projectJson ? { 'dockeriser.json': JSON.stringify(projectJson) } : {}) });
  return { home, dir };
}

test('deploy settings: flags beat dockeriser.json; the first deploy saves settings but never .env contents', () => {
  const { home, dir } = deployFixture(null);
  const plan = planDeploy({ dir, flags: { to: 'prod', image: 'web', publish: ['80:3000'], 'env-file': '.env', 'health-url': 'http://localhost:3000/' }, cfg: CFG, homeDir: home, env: {} });
  assert.equal(plan.mode, 'run');
  assert.equal(plan.transfer, 'ssh');
  assert.equal(plan.server.key, '~/.ssh/shared', 'default key from config');
  assert.equal(plan.run.name, 'web');
  assert.equal(plan.items[0].repository, `${REPO}/web`);
  assert.equal(plan.items[0].tag, 'latest');
  const where = saveDeploySection(plan, { homeDir: home });
  assert.equal(where.kind, 'project-state');
  assert.ok(!fs.existsSync(path.join(dir, 'dockeriser.json')), 'the repo is left alone');
  const saved = JSON.parse(fs.readFileSync(where.file, 'utf8'));
  assert.ok(where.file.startsWith(path.join(home, '.dockeriser', 'projects')));
  assert.equal(saved.root, path.resolve(dir));
  assert.deepEqual(saved.deploy, { server: 'prod', mode: 'run', name: 'web', ports: ['80:3000'], envFile: '.env', healthUrl: 'http://localhost:3000/', image: 'web' });
  assert.ok(!JSON.stringify(saved).includes('hunter2'));

  // Second run: dockeriser.json supplies everything; flags still win.
  const again = planDeploy({ dir, flags: { publish: ['8080:3000'] }, cfg: CFG, homeDir: home, env: {} });
  assert.deepEqual(again.run.ports, ['8080:3000']);
  assert.equal(again.run.healthUrl, 'http://localhost:3000/');
  assert.equal(again.saveSection, null, 'existing settings are not rewritten');
  // A raw user@host works without saving a server.
  const raw = planDeploy({ dir, flags: { to: 'deploy@web.example.com', image: 'web' }, cfg: CFG, homeDir: home, env: {} });
  assert.equal(raw.server.host, 'deploy@web.example.com');
  assert.equal(raw.server.key, '~/.ssh/shared');
  assert.throws(() => planDeploy({ dir, flags: { to: 'prod', image: 'web', mode: 'compose' }, cfg: CFG, homeDir: home, env: {} }), /--tag-as/);
});

test('deploy settings: multi-image load-only from dockeriser.json, --only, and --tag-as pairs', () => {
  const { home, dir } = deployFixture({
    images: [
      { name: 'base', image: 'app-base', localTag: 'app:base', push: false },
      { name: 'api', image: 'app' },
      { name: 'web', image: 'web' },
    ],
    deploy: { server: 'prod', mode: 'pull', images: { api: { tagAs: 'app:demo' }, web: { tagAs: 'web:demo' } }, then: 'cd /opt/app && bash setup.sh' },
  });
  const plan = planDeploy({ dir, flags: {}, cfg: CFG, homeDir: home, env: {} });
  assert.equal(plan.mode, 'load-only', '"pull" is read as load-only');
  assert.deepEqual(plan.items.map((i) => [i.name, i.tagAs]), [['api', 'app:demo'], ['web', 'web:demo']]);
  assert.equal(plan.then, 'cd /opt/app && bash setup.sh');
  const only = planDeploy({ dir, flags: { only: ['web'], 'tag-as': ['web=web:canary'] }, cfg: CFG, homeDir: home, env: {} });
  assert.deepEqual(only.items.map((i) => [i.name, i.tagAs]), [['web', 'web:canary']]);
  assert.deepEqual(parseTagAs(['myapp:1'], ['web']), { web: 'myapp:1' });
  assert.throws(() => parseTagAs(['myapp:1'], ['a', 'b']), /which image/);
});

/** Mock ssh runner: answers by recognising the script. */
function mockSsh({ have = [], deployStdout, deployCode = 0 }) {
  const calls = [];
  return {
    calls,
    async exec(server, cmd, { input, onStdout = () => {} } = {}) {
      if (cmd === 'bash -s' && input.includes('mark user=')) {
        calls.push('probe');
        const lines = ['@@dk user="root" sudo="none" arch="x86_64"', '@@dk docker="27.1.0"', '@@dk disk_kb="20000000"', ...have.map((i) => `@@dk have=${i} id="sha256:x"`)];
        return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
      }
      if (cmd.startsWith('t=$(mktemp)') && Buffer.from(cmd.match(/echo (\S+)/)[1], 'base64').toString().includes('$D load')) {
        calls.push('load');
        const chunks = [];
        for await (const c of input) chunks.push(c);
        this.loaded = Buffer.concat(chunks);
        return { code: 0, stdout: 'Loaded image: x\n', stderr: '' };
      }
      calls.push('deploy');
      this.script = input;
      onStdout(deployStdout);
      return { code: deployCode, stdout: deployStdout, stderr: '' };
    },
  };
}

function mockRegistry() {
  const config = blob('{"cfg":1}');
  const layer = blob('the-layer');
  const blobs = new Map([config, layer].map((b) => [b.digest, b.buf]));
  return {
    resolveDigest: async () => 'sha256:aaaaaaaaaaaaaaaa',
    imageManifest: async (ref) => ({ repository: ref.split('@')[0], digest: 'sha256:aaaaaaaaaaaaaaaa', manifestDigest: 'sha256:aaaaaaaaaaaaaaaa', config: { digest: config.digest, size: config.size }, layers: [{ digest: layer.digest, size: layer.size }] }),
    blobStream: async (_r, d) => Readable.from([blobs.get(d)]),
  };
}

test('deploy over ssh transfer: streams the image, then a failed health check rolls back and exits non-zero', async () => {
  const { home, dir } = deployFixture(null);
  const plan = planDeploy({ dir, flags: { to: 'prod', image: 'web', publish: ['80:3000'] }, cfg: CFG, homeDir: home, env: {} });
  const ssh = mockSsh({ deployStdout: ['@@dk disk_before_kb="20000000"', '@@dk item=0 new="sha256:new"', '@@dk previous="sha256:old"', 'starting web...', '@@dk health=failed reason="the container is not running"', '@@dk logs-begin', 'Error: boom', '@@dk logs-end', 'rolling back to the previous image...', '@@dk rolledback=1', ''].join('\n'), deployCode: 10 });
  const { o, stderr } = out();
  const result = await executeDeploy({ plan, ssh, getRegistry: async () => mockRegistry(), out: o });
  assert.deepEqual(ssh.calls, ['probe', 'load', 'deploy']);
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.exitCode, 1);
  assert.equal(result.rolledBack, true);
  assert.equal(result.previousDigest, 'sha256:old');
  assert.deepEqual(result.logsTail, ['Error: boom']);
  assert.equal(result.digest, 'sha256:aaaaaaaaaaaaaaaa');
  assert.equal(result.transferredBytes, ssh.loaded.length);
  assert.match(stderr.text(), /Health check failed/);
  assert.match(ssh.script, /web:dk-aaaaaaaaaaaa/);
  // The streamed archive is a valid docker-save tar tagged with dockeriser's ref.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-l-')), 'x.tar');
  fs.writeFileSync(f, ssh.loaded);
  await tar.x({ file: f, cwd: path.dirname(f) });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(f), 'manifest.json'), 'utf8'))[0].RepoTags, [`${REPO}/web:dk-aaaaaaaaaaaa`]);
});

test('deploy over ssh transfer: an image the server already has is not sent again', async () => {
  const { home, dir } = deployFixture(null);
  const plan = planDeploy({ dir, flags: { to: 'prod', image: 'web' }, cfg: CFG, homeDir: home, env: {} });
  const ssh = mockSsh({ have: [0], deployStdout: '@@dk item=0 new="sha256:new"\n@@dk previous=""\n@@dk health=ok\n@@dk disk_after_kb="19000000"\n@@dk result=ok\n' });
  const { o } = out();
  const result = await executeDeploy({ plan, ssh, getRegistry: async () => mockRegistry(), out: o });
  assert.deepEqual(ssh.calls, ['probe', 'deploy']);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.items[0].transferred, 'skipped');
  assert.equal(result.diskFreeBefore, 20000000);
  assert.equal(result.diskFreeAfter, 19000000);
});

test('deploy dry run prints the script without the env file contents', async () => {
  const { home, dir } = deployFixture(null);
  const plan = planDeploy({ dir, flags: { to: 'prod', image: 'web', 'env-file': '.env' }, cfg: CFG, homeDir: home, env: {} });
  const { o } = out();
  const result = await executeDeploy({ plan, ssh: { exec: () => assert.fail('no ssh on dry run') }, getRegistry: () => assert.fail('no registry'), out: o, dryRun: true });
  assert.equal(result.status, 'DRY_RUN');
  assert.ok(!result.script.includes(Buffer.from('SECRET=hunter2\n').toString('base64')));
  assert.ok(!result.script.includes('hunter2'));
});

test('deploy several --image values, paired in order with bare --tag-as values', () => {
  const { home, dir } = deployFixture(null);
  const plan = planDeploy({ dir, flags: { to: 'prod', mode: 'load-only', image: ['app', 'web:v2'], 'tag-as': ['app:demo', 'web:demo'] }, cfg: CFG, homeDir: home, env: {} });
  assert.deepEqual(plan.items.map((i) => [i.name, i.repository, i.tag, i.tagAs]), [
    ['app', `${REPO}/app`, 'latest', 'app:demo'],
    ['web', `${REPO}/web`, 'v2', 'web:demo'],
  ]);
  const named = planDeploy({ dir, flags: { to: 'prod', mode: 'load-only', image: ['app', 'web'], 'tag-as': ['web=web:x', 'app=app:x'] }, cfg: CFG, homeDir: home, env: {} });
  assert.deepEqual(named.items.map((i) => i.tagAs), ['app:x', 'web:x']);
  assert.throws(() => planDeploy({ dir, flags: { to: 'prod', mode: 'load-only', image: ['app', 'web'], 'tag-as': ['app:demo'] }, cfg: CFG, homeDir: home, env: {} }), /1 --tag-as value.*2 images/);
  assert.throws(() => parseTagAs(['app=app:x', 'web:x'], ['app', 'web']), /mix/);
  assert.throws(() => planDeploy({ dir, flags: { to: 'prod', image: ['app', 'web'] }, cfg: CFG, homeDir: home, env: {} }), /Mode "run" starts one container/);
  assert.throws(() => planDeploy({ dir, flags: { to: 'prod', mode: 'load-only', image: ['app', 'app:v2'], 'tag-as': ['a:1', 'a:2'] }, cfg: CFG, homeDir: home, env: {} }), /twice/);
});

test('deploy by digest: the exact image, no tag lookup', async () => {
  const { home, dir } = deployFixture(null);
  const digest = `sha256:${'ab'.repeat(32)}`;
  assert.deepEqual(parseDeployImage(`web@${digest}`, CFG), { name: 'web', repository: `${REPO}/web`, tag: null, digest });
  assert.equal(parseDeployImage(`${REPO}/web:v1@${digest}`, CFG).tag, 'v1');
  assert.deepEqual(parseDeployImage('web', CFG), { name: 'web', repository: `${REPO}/web`, tag: 'latest', digest: null });
  assert.throws(() => parseDeployImage('web@sha256:abc', CFG), /sha256:<64 hex/);
  const plan = planDeploy({ dir, flags: { to: 'prod', image: [`web@${digest}`] }, cfg: CFG, homeDir: home, env: {} });
  assert.equal(plan.items[0].digest, digest);
  const { o } = out();
  const result = await executeDeploy({ plan, ssh: { exec: () => assert.fail('no ssh') }, getRegistry: () => assert.fail('a digest needs no lookup'), out: o, dryRun: true });
  assert.equal(result.digest, digest);
  assert.match(result.script, new RegExp(`web:dk-${'ab'.repeat(6)}`));
});

test('per-user deploy settings: rollback and logs reuse them; --save writes dockeriser.json; dockeriser.json wins', () => {
  const { home, dir } = deployFixture(null);
  const plan = planDeploy({ dir, flags: { to: 'prod', mode: 'load-only', image: ['app', 'web'], 'tag-as': ['app:demo', 'web:demo'], then: 'bash /opt/x/setup.sh' }, cfg: CFG, homeDir: home, env: {} });
  saveDeploySection(plan, { homeDir: home });
  for (const rollback of [true, false]) {
    const again = planDeploy({ dir, flags: {}, cfg: CFG, homeDir: home, env: {}, rollback });
    assert.equal(again.server.host, 'root@203.0.113.5');
    assert.equal(again.mode, 'load-only');
    assert.deepEqual(again.items.map((i) => [i.repository, i.tagAs, i.key]), [[`${REPO}/app`, 'app:demo', 'app:demo'], [`${REPO}/web`, 'web:demo', 'web:demo']]);
    assert.equal(again.then, 'bash /opt/x/setup.sh');
    assert.equal(again.saveSection, null, 'saved settings are not rewritten');
  }
  assert.equal(saveDeploySection(plan, { homeDir: home, where: 'none' }), null);
  const file = saveDeploySection(plan, { homeDir: home, where: 'file' });
  assert.equal(file.kind, 'dockeriser.json');
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'dockeriser.json'), 'utf8'));
  assert.deepEqual(written.deploy.imageRefs, [`${REPO}/app`, `${REPO}/web`]);
  // dockeriser.json's own deploy section beats the per-user one.
  fs.writeFileSync(path.join(dir, 'dockeriser.json'), JSON.stringify({ deploy: { server: 'root@198.51.100.7', mode: 'load-only', image: 'other', images: { other: { tagAs: 'other:x' } } } }));
  const fromFile = planDeploy({ dir, flags: {}, cfg: CFG, homeDir: home, env: {} });
  assert.equal(fromFile.server.host, 'root@198.51.100.7');
  assert.deepEqual(fromFile.items.map((i) => i.name), ['other']);
});
