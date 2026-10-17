import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { readCiCache } from '../src/ci-ledger.js';
import { fakeGcs, sink, tempTree, tick } from './helpers.js';

const LOGS = 'demo-proj-dockeriser-logs';

function setUp(ledger) {
  const home = tempTree({
    '.dockeriser/config.json': JSON.stringify({ project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images' }),
    '.dockeriser/key.json': JSON.stringify({ type: 'service_account' }),
  });
  const dir = tempTree({ 'dockeriser.json': JSON.stringify({ ci: { steps: ['npm ci', 'npm test'] } }), 'package.json': '{}', '.node-version': '24.14.0\n' });
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  const gcs = fakeGcs();
  if (ledger) gcs.put(LOGS, 'ci/ledger-2026-10.json', JSON.stringify(ledger));
  const uploads = [];
  gcs.storage.bucket = (name) => ({
    upload: async (file, opts) => {
      uploads.push({ name, object: opts.destination, exists: fs.existsSync(file) });
      return [{}, { generation: '1' }];
    },
  });
  return { home, dir, gcs, uploads };
}

const okLog = ['::phase gate', '', '::step 1/2 $ npm ci', 'added 1 package', '::step-end 1 rc=0 30s', '', '::step 2/2 $ npm test', 'ok', '::step-end 2 rc=0 12s', '::dockeriser-ci-result exit=0 step=0', 'DONE', ''].join('\n');
const failLog = ['::step 1/2 $ npm ci', '::step-end 1 rc=0 30s', '::step 2/2 $ npm test', 'Error: expected 2', '::step-end 2 rc=1 4s', '::dockeriser-ci-result exit=1 step=2', 'ERROR', ''].join('\n');

/**
 * Fake gcloud: `logs` is the log each successive VM writes (null: the VM vanishes without one).
 */
function fakeGcloud(gcs, logs) {
  const calls = [];
  const vms = new Map();
  let created = 0;
  const gcloud = (args) => {
    calls.push(args);
    const [, , verb, name] = args;
    if (verb === 'list') return { code: 0, stdout: '[]', stderr: '' };
    if (verb === 'create') {
      const log = logs[created++];
      vms.set(name, log === null ? 'GONE' : 'RUNNING');
      if (log !== null) gcs.put(LOGS, `log-${name.replace(/^dockeriser-/, '')}.txt`, log);
      return { code: 0, stdout: '[]', stderr: '' };
    }
    if (verb === 'describe') {
      const s = vms.get(name);
      return !s || s === 'GONE' ? { code: 1, stdout: '', stderr: `ERROR: The resource 'projects/demo-proj/zones/z/instances/${name}' was not found` } : { code: 0, stdout: `${s}\n`, stderr: '' };
    }
    if (verb === 'delete') {
      vms.set(name, 'GONE');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { gcloud, calls, verbs: () => calls.map((a) => a[2]) };
}

function deps({ home, gcs }, gcloud) {
  let t = Date.parse('2026-10-16T10:00:00Z');
  return {
    stdout: sink(), stderr: sink(), sleep: tick, onSigint: () => () => {}, exit: (c) => { throw new Error(`exit ${c}`); },
    homeDir: home, env: { APPDATA: tempTree({}), PATH: process.env.PATH, NO_COLOR: '1' }, tmpDir: tempTree({}),
    now: () => new Date(t), clock: () => new Date((t += 1000)),
    createClients: async () => ({ storage: gcs.storage }), gcloud,
  };
}

const json = (d) => JSON.parse(d.stdout.text());

test('ci: a passing gate deletes the VM and records the run', async () => {
  const s = setUp();
  const g = fakeGcloud(s.gcs, [okLog]);
  const d = deps(s, g.gcloud);
  const code = await run(['ci', s.dir, '--json'], d);
  const res = json(d);
  assert.equal(code, 0, d.stderr.text());
  assert.equal(res.status, 'SUCCESS');
  assert.deepEqual(res.steps.map((x) => [x.command, x.exitCode, x.durationSec]), [['npm ci', 0, 30], ['npm test', 0, 12]]);
  assert.deepEqual(g.verbs(), ['list', 'create', 'delete', 'describe']);
  assert.equal(res.vm.deleted, 'done');
  assert.ok(res.costUsd > 0 && res.costUsd < 0.05, String(res.costUsd));
  assert.ok(Math.abs(res.costUsd - (res.durationSec / 3600) * 0.0392164) < 1e-5);
  assert.equal(s.uploads.length, 1);
  assert.match(s.uploads[0].object, /^ci\/\d{8}-\d{6}-[0-9a-f]{8}\.tgz$/);
  const create = g.calls.find((a) => a[2] === 'create');
  assert.ok(create.includes('--provisioning-model=SPOT'));
  const ledger = JSON.parse(s.gcs.get(LOGS, 'ci/ledger-2026-10.json'));
  assert.equal(ledger.runs.length, 1);
  assert.equal(ledger.runs[0].status, 'SUCCESS');
  assert.equal(res.ci.runs, 1);
  assert.equal(readCiCache(s.home, {}).runs, 1);
});

test('ci: a failing step is named, with exit 1', async () => {
  const s = setUp();
  const g = fakeGcloud(s.gcs, [failLog]);
  const d = deps(s, g.gcloud);
  const code = await run(['ci', s.dir, '--json'], d);
  const res = json(d);
  assert.equal(code, 1);
  assert.equal(res.status, 'FAILURE');
  assert.deepEqual(res.failedStep, { index: 2, command: 'npm test', exitCode: 1 });
  assert.ok(res.errorTail.includes('Error: expected 2'));
  assert.ok(res.logFile && fs.existsSync(res.logFile));
  assert.ok(g.verbs().includes('delete'));
});

test('ci: when the month is switched off, it refuses with exit 5 and creates no VM', async () => {
  const s = setUp({ month: '2026-10', runs: [{ id: 'a', costUsd: 0.1 }], disabled: { at: '2026-10-09T00:00:00Z', reason: 'on pace for $9.00 by month end' } });
  const g = fakeGcloud(s.gcs, [okLog]);
  const d = deps(s, g.gcloud);
  const code = await run(['ci', s.dir, '--json'], d);
  assert.equal(code, 5);
  const res = json(d);
  assert.equal(res.status, 'CI_OFF');
  assert.match(res.error.message, /on pace for \$9\.00/);
  assert.deepEqual(g.calls, []);
  assert.equal(s.uploads.length, 0);
});

test('ci: over the cap without a flag yet, it switches off and says why', async () => {
  const s = setUp({ month: '2026-10', runs: [{ id: 'a', costUsd: 5.2 }] });
  const g = fakeGcloud(s.gcs, [okLog]);
  const d = deps(s, g.gcloud);
  assert.equal(await run(['ci', s.dir, '--json'], d), 5);
  assert.match(JSON.parse(s.gcs.get(LOGS, 'ci/ledger-2026-10.json')).disabled.reason, /\$5\.20 spent/);
});

test('ci: a VM that vanishes without a result is retried once', async () => {
  const s = setUp();
  const g = fakeGcloud(s.gcs, [null, okLog]);
  const d = deps(s, g.gcloud);
  const code = await run(['ci', s.dir, '--json'], d);
  assert.equal(code, 0, d.stderr.text());
  assert.equal(g.verbs().filter((v) => v === 'create').length, 2);
  assert.match(d.stderr.text(), /retrying once/);
  const ledger = JSON.parse(s.gcs.get(LOGS, 'ci/ledger-2026-10.json'));
  assert.deepEqual(ledger.runs.map((r) => r.status), ['PREEMPTED', 'SUCCESS']);
});

test('ci --no-retry reports the preemption', async () => {
  const s = setUp();
  const g = fakeGcloud(s.gcs, [null]);
  const d = deps(s, g.gcloud);
  assert.equal(await run(['ci', s.dir, '--json', '--no-retry'], d), 1);
  assert.equal(json(d).status, 'PREEMPTED');
});

test('ci --dry-run makes no calls and shows the VM and its script', async () => {
  const s = setUp();
  const g = fakeGcloud(s.gcs, []);
  const d = deps(s, g.gcloud);
  d.createClients = async () => {
    throw new Error('no network on a dry run');
  };
  assert.equal(await run(['ci', s.dir, '--dry-run', '--json', '--machine', 'e2-standard-8'], d), 0);
  const res = json(d);
  assert.equal(res.status, 'DRY_RUN');
  assert.ok(res.createArgs.includes('--machine-type=e2-standard-8'));
  assert.ok(res.script.includes("NODE_WANT='24.14.0'"));
  assert.equal(res.files, 3);
  assert.deepEqual(g.calls, []);
});

test('ci without a ci section explains ci init', async () => {
  const s = setUp();
  fs.writeFileSync(path.join(s.dir, 'dockeriser.json'), '{}');
  const d = deps(s, fakeGcloud(s.gcs, []).gcloud);
  assert.equal(await run(['ci', s.dir, '--json'], d), 2);
  assert.match(json(d).error.fix, /ci init/);
});
