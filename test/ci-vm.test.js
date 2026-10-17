import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ciSourceFiles, createArgs, createVm, parseResult, parseSteps, runIdFor, startupScript, sweep, vmNameFor } from '../src/ci-vm.js';
import { tempTree } from './helpers.js';

const hasBash = spawnSync('bash', ['--version'], { windowsHide: true }).status === 0;
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });

test('ciSourceFiles: what `git add -A` would commit', () => {
  const dir = tempTree({ 'a.js': '1', 'gone.js': '2', '.gitignore': 'node_modules/\n.env\n', 'new.js': '3', '.env': 'SECRET=1', 'node_modules/x/i.js': '4' });
  git(dir, 'init', '-q');
  git(dir, 'add', 'a.js', 'gone.js', '.gitignore');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
  fs.rmSync(path.join(dir, 'gone.js'));
  assert.deepEqual(ciSourceFiles(dir).sort(), ['.gitignore', 'a.js', 'new.js']);
});

test('ciSourceFiles refuses a folder that is not a git checkout', () => {
  assert.throws(() => ciSourceFiles(tempTree({ 'a.js': '1' }), () => { throw Object.assign(new Error('fatal: not a git repository'), { stderr: 'fatal: not a git repository' }); }), /git checkout/);
});

test('run ids and VM names are valid instance names', () => {
  const id = runIdFor(new Date('2026-10-16T23:15:00Z'), 'ab12');
  assert.equal(id, 'ci-20261016-231500-ab12');
  assert.equal(vmNameFor(id), 'dockeriser-ci-20261016-231500-ab12');
  assert.match(vmNameFor(id), /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
});

const scriptOpts = {
  runId: 'ci-20261016-231500-ab12', srcBucket: 'p-dockeriser-src', srcObject: 'ci/20261016-231500-abcdef12.tgz', logsBucket: 'p-dockeriser-logs',
  steps: ["npm ci", "echo 'quoted' && npm run check"], env: { FOO: "a b 'c'" }, node: '24.14.0', docker: true, timeoutSec: 3600,
};

test('the startup script embeds every step and setting', () => {
  const s = startupScript(scriptOpts);
  for (const step of scriptOpts.steps) assert.ok(s.includes(Buffer.from(step).toString('base64')), step);
  assert.ok(s.includes(Buffer.from("a b 'c'").toString('base64')));
  for (const want of ["SRC_BUCKET='p-dockeriser-src'", "LOGS_BUCKET='p-dockeriser-logs'", "LOG_OBJECT='log-ci-20261016-231500-ab12.txt'", "NODE_WANT='24.14.0'", 'GATE_TIMEOUT=3600', 'export CI=true', 'shutdown -h now', 'docker-compose-v2', '::dockeriser-ci-result']) {
    assert.ok(s.includes(want), want);
  }
  assert.ok(!s.includes('\r'));
  assert.ok(!startupScript({ ...scriptOpts, docker: false }).includes('INSTALL_DOCKER=1'));
});

test('the startup script is valid bash', { skip: !hasBash && 'bash not installed' }, () => {
  const file = path.join(tempTree({}), 'startup.sh');
  fs.writeFileSync(file, startupScript(scriptOpts));
  const res = spawnSync('bash', ['-n', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, res.stderr);
});

test('createArgs: a spot VM that deletes itself at the limit', () => {
  const args = createArgs({ name: 'dockeriser-ci-x', project: 'p', zone: 'northamerica-northeast2-a', machine: 'e2-standard-4', diskGb: 40, serviceAccount: 'dockeriser@p.iam.gserviceaccount.com', maxRunSec: 4500, scriptFile: '/tmp/s.sh' });
  for (const want of ['--provisioning-model=SPOT', '--instance-termination-action=DELETE', '--max-run-duration=4500s', '--machine-type=e2-standard-4', '--boot-disk-size=40GB',
    '--image-family=ubuntu-2404-lts-amd64', '--image-project=ubuntu-os-cloud', '--labels=dockeriser-ci=1,max-run=4500', '--metadata-from-file=startup-script=/tmp/s.sh',
    '--service-account=dockeriser@p.iam.gserviceaccount.com', '--scopes=cloud-platform', '--zone=northamerica-northeast2-a', '--project=p']) {
    assert.ok(args.includes(want), want);
  }
});

test('createVm moves to the next zone when one has no spot capacity', () => {
  const calls = [];
  const gcloud = (args) => {
    calls.push(args.find((a) => a.startsWith('--zone=')));
    return calls.length === 1 ? { code: 1, stdout: '', stderr: 'ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - The zone does not have enough resources available to fulfill the request. ZONE_RESOURCE_POOL_EXHAUSTED' } : { code: 0, stdout: '[]', stderr: '' };
  };
  const res = createVm({ gcloud, zones: ['z-a', 'z-b', 'z-c'], argsFor: (zone) => [`--zone=${zone}`], warn: () => {} });
  assert.equal(res.zone, 'z-b');
  assert.deepEqual(calls, ['--zone=z-a', '--zone=z-b']);
});

test('createVm explains a turned-off Compute Engine API', () => {
  const gcloud = () => ({ code: 1, stdout: '', stderr: 'ERROR: Compute Engine API has not been used in project p before or it is disabled. SERVICE_DISABLED' });
  assert.throws(() => createVm({ gcloud, zones: ['z-a'], argsFor: () => [], project: 'p', warn: () => {} }), (err) => /Compute Engine API/.test(err.message) && /services enable compute/.test(err.fix));
});

test('result and step markers', () => {
  const log = ['::phase setup', '', '::step 1/2 $ npm ci', 'added 3 packages', '::step-end 1 rc=0 41s', '', '::step 2/2 $ npm test', 'boom', '::step-end 2 rc=1 7s', '::dockeriser-ci-result exit=1 step=2', 'ERROR'].join('\n');
  assert.deepEqual(parseResult(log.split('\n')), { exitCode: 1, step: 2 });
  assert.equal(parseResult(['::step 1/2 $ npm ci']), null);
  assert.deepEqual(parseSteps(log), [
    { index: 1, command: 'npm ci', exitCode: 0, durationSec: 41 },
    { index: 2, command: 'npm test', exitCode: 1, durationSec: 7 },
  ]);
});

test('sweep deletes stopped CI VMs and ones past their limit, nothing else', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const vms = [
    { name: 'dockeriser-ci-running', zone: 'z', status: 'RUNNING', createdAt: '2026-10-16T11:30:00Z', maxRunSec: 4500 },
    { name: 'dockeriser-ci-stopped', zone: 'z', status: 'TERMINATED', createdAt: '2026-10-16T11:50:00Z', maxRunSec: 4500 },
    { name: 'dockeriser-ci-old', zone: 'z', status: 'RUNNING', createdAt: '2026-10-16T10:00:00Z', maxRunSec: 4500 },
  ];
  const deleted = [];
  const gcloud = (args) => {
    deleted.push(args[3]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = sweep({ gcloud, project: 'p', now, vms });
  assert.deepEqual(deleted, ['dockeriser-ci-stopped', 'dockeriser-ci-old']);
  assert.deepEqual(res.live.map((v) => v.name), ['dockeriser-ci-running']);
});
