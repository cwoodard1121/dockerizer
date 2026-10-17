import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as tar from 'tar';
import { parseMarks, uploadScript } from '../src/remote.js';
import { executeDeploy, parseUpload, planDeploy } from '../src/deploy.js';
import { createOutput } from '../src/output.js';
import { sink, tempTree } from './helpers.js';

const CFG = { project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images' };
const BASH = (process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'] : ['/bin/bash', '/usr/bin/bash']).find((c) => fs.existsSync(c)) || null;
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function fixture() {
  const home = tempTree({ '.dockeriser/config.json': JSON.stringify({ project: 'demo-proj', servers: { prod: { host: 'root@203.0.113.5' } } }) });
  const dir = tempTree({
    'bundle/.env': 'APP_IMAGE=app:new\nOTHER=1\n',
    'bundle/setup.sh': 'echo setup\n',
    'bundle/conf/proxy.conf': 'listen 80;\n',
    'extra.txt': 'hello\n',
  });
  return { home, dir };
}

test('--upload values: local inside the project, absolute server folder, Windows drive letters', () => {
  const { dir } = fixture();
  const u = parseUpload('bundle:/opt/app/', dir);
  assert.deepEqual([u.rel, u.to, u.isDir], ['bundle', '/opt/app', true]);
  assert.equal(parseUpload(`${path.join(dir, 'extra.txt')}:/opt/app`, dir).isDir, false);
  assert.throws(() => parseUpload('bundle:opt/app', dir), /absolute folder/);
  assert.throws(() => parseUpload('bundle:/', dir), /into \//);
  assert.throws(() => parseUpload('missing:/opt/app', dir), /does not exist/);
  assert.throws(() => parseUpload(`${os.tmpdir()}:/opt/app`, dir), /outside the project/);
});

test('--keep-env needs an --upload; uploads are saved with the deploy settings and skipped on rollback', () => {
  const { home, dir } = fixture();
  assert.throws(() => planDeploy({ dir, flags: { to: 'prod', image: 'web', 'keep-env': ['APP_IMAGE'] }, cfg: CFG, homeDir: home, env: {} }), /nothing is uploaded/);
  assert.throws(() => planDeploy({ dir, flags: { to: 'prod', image: 'web', upload: ['bundle:/opt/app'], 'keep-env': ['BAD-NAME'] }, cfg: CFG, homeDir: home, env: {} }), /not a variable name/);
  const plan = planDeploy({ dir, flags: { to: 'prod', image: 'web', mode: 'load-only', 'tag-as': ['web:demo'], upload: ['bundle:/opt/app'], 'keep-env': ['APP_IMAGE,WEB_IMAGE'] }, cfg: CFG, homeDir: home, env: {} });
  assert.deepEqual(plan.saveSection.upload, ['bundle:/opt/app']);
  assert.deepEqual(plan.saveSection.keepEnv, ['APP_IMAGE', 'WEB_IMAGE']);
  const back = planDeploy({ dir, flags: { to: 'prod', image: 'web', mode: 'load-only', 'tag-as': ['web:demo'], upload: ['bundle:/opt/app'] }, cfg: CFG, homeDir: home, env: {}, rollback: true });
  assert.deepEqual(back.uploads, []);
});

test('the upload script really unpacks the tar and keeps the server\'s pinned .env lines', { skip: !BASH }, async () => {
  const { dir } = fixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-up-'));
  const dest = path.join(work, 'opt', 'app');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, '.env'), 'APP_IMAGE=app:release-7\nOTHER=0\nSERVER_ONLY=x\n');
  fs.writeFileSync(path.join(dest, 'keep-me.txt'), 'old\n');
  const tgz = path.join(work, 'up.tgz');
  await tar.c({ cwd: dir, gzip: true, portable: true, file: tgz }, ['bundle', 'extra.txt']);
  const script = uploadScript({ uploads: [{ rel: 'bundle', to: posix(dest), isDir: true }, { rel: 'extra.txt', to: posix(path.join(work, 'files')), isDir: false }], keepEnv: ['APP_IMAGE', 'WEB_IMAGE'] });
  const file = path.join(work, 'up.sh');
  fs.writeFileSync(file, script);
  assert.equal(spawnSync(BASH, ['-n', file]).status, 0);
  const env = { ...process.env, HOME: posix(work) };
  const res = spawnSync(BASH, [file], { input: fs.readFileSync(tgz), env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const { values, marks } = parseMarks(res.stdout);
  assert.equal(values.upload, 'ok');
  assert.equal(marks.find((m) => m.up === '0' && m.kept !== undefined).kept, 'APP_IMAGE');
  const envText = fs.readFileSync(path.join(dest, '.env'), 'utf8');
  assert.match(envText, /^APP_IMAGE=app:release-7$/m, 'the pinned line survives');
  assert.ok(!envText.includes('app:new'), "the bundle's value for a kept key is dropped");
  assert.match(envText, /^OTHER=1$/m, 'other keys come from the bundle');
  assert.ok(fs.existsSync(path.join(dest, 'conf', 'proxy.conf')));
  assert.ok(fs.existsSync(path.join(dest, 'keep-me.txt')), 'files the upload does not bring are left alone');
  assert.equal(fs.readFileSync(path.join(work, 'files', 'extra.txt'), 'utf8'), 'hello\n');

  // A broken stream changes nothing.
  fs.writeFileSync(path.join(dest, '.env'), 'APP_IMAGE=app:release-8\n');
  const broken = spawnSync(BASH, [file], { input: Buffer.from('not a tarball'), env, encoding: 'utf8' });
  assert.equal(broken.status, 31);
  assert.equal(fs.readFileSync(path.join(dest, '.env'), 'utf8'), 'APP_IMAGE=app:release-8\n');
});

test('deploy with two uploads: one extra ssh connection, before the deploy script; result lists them', async () => {
  const { home, dir } = fixture();
  const plan = planDeploy({ dir, flags: { to: 'prod', image: [`web@sha256:${'c'.repeat(64)}`], mode: 'load-only', 'tag-as': ['web:demo'], transfer: 'pull', upload: ['bundle:/opt/app', 'extra.txt:/opt/files'], 'keep-env': ['APP_IMAGE'] }, cfg: CFG, homeDir: home, env: {} });
  const calls = [];
  const ssh = {
    async exec(_server, cmd, { input } = {}) {
      const decoded = cmd.startsWith('t=$(mktemp)') ? Buffer.from(cmd.match(/echo (\S+)/)[1], 'base64').toString() : '';
      if (decoded.includes('# dockeriser upload')) {
        calls.push('upload');
        const chunks = [];
        for await (const c of input) chunks.push(c);
        const tgz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-tgz-')), 'x.tgz');
        fs.writeFileSync(tgz, Buffer.concat(chunks));
        const names = [];
        await tar.t({ file: tgz, onReadEntry: (e) => names.push(e.path) });
        this.names = names;
        return { code: 0, stdout: '@@dk up=0 kept="APP_IMAGE"\n@@dk up=0 ok=1\n@@dk up=1 ok=1\n@@dk upload=ok\n', stderr: '' };
      }
      calls.push('deploy');
      return { code: 0, stdout: '@@dk item=0 new="sha256:n"\n@@dk health=skipped\n@@dk result=ok\n', stderr: '' };
    },
  };
  const o = createOutput({ json: true, stdout: sink(), stderr: sink(), env: {} });
  const result = await executeDeploy({ plan, ssh, getRegistry: async () => ({}), out: o });
  assert.deepEqual(calls, ['upload', 'deploy']);
  assert.ok(ssh.names.some((n) => n.startsWith('bundle/')) && ssh.names.includes('extra.txt'));
  assert.deepEqual(result.uploads.map((u) => [u.from, u.to, u.files, u.keptEnv]), [['bundle', '/opt/app', 3, ['APP_IMAGE']], ['extra.txt', '/opt/files', 1, []]]);
  assert.equal(typeof result.timings.uploadSec, 'number');
});

test('a failed upload stops the deploy before the deploy script', async () => {
  const { home, dir } = fixture();
  const plan = planDeploy({ dir, flags: { to: 'prod', image: [`web@sha256:${'c'.repeat(64)}`], mode: 'load-only', 'tag-as': ['web:demo'], transfer: 'pull', upload: ['bundle:/opt/app'] }, cfg: CFG, homeDir: home, env: {} });
  const calls = [];
  const ssh = { exec: async () => (calls.push('x'), { code: 33, stdout: '@@dk up=0 error=copy\n', stderr: 'could not copy into /opt/app\n' }) };
  const o = createOutput({ json: true, stdout: sink(), stderr: sink(), env: {} });
  await assert.rejects(executeDeploy({ plan, ssh, getRegistry: async () => ({}), out: o }), /Uploading to root@203.0.113.5 failed \(exit 33\): could not copy/);
  assert.equal(calls.length, 1);
});
