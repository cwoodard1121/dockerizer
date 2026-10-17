import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanupPolicy, planCleanup, runCleanup } from '../src/cleanup.js';
import { createGcloudRunner } from '../src/server.js';
import { findGcloud } from '../src/status.js';
import { createOutput } from '../src/output.js';
import { run } from '../src/cli.js';
import { sink, tempTree } from './helpers.js';

const CFG = { project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images' };
const PKG = 'northamerica-northeast2-docker.pkg.dev/demo-proj/docker-images';

/** n versions of an image, newest last; the newest is tagged latest. */
function versions(name, n, { latestAt = n - 1 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    package: `${PKG}/${name}`,
    version: `sha256:${String(i).padStart(64, '0')}`,
    tags: i === latestAt ? [`v${i}`, 'latest'] : [`v${i}`],
    createTime: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    metadata: { imageSizeBytes: '1000' },
  }));
}

/** Fake gcloud: records calls, answers list/describe. */
function fakeGcloud(list, { policies = { 'keep-10-most-recent': {}, 'delete-older-than-1d': {} }, fail } = {}) {
  const calls = [];
  const gcloud = (args) => {
    calls.push(args);
    if (fail && args.includes(fail)) return { code: 1, stdout: '', stderr: 'ERROR: (gcloud) permission denied' };
    if (args.slice(0, 4).join(' ') === 'artifacts docker images list') return { code: 0, stdout: JSON.stringify(list), stderr: '' };
    if (args.slice(0, 3).join(' ') === 'artifacts repositories describe') return { code: 0, stdout: JSON.stringify({ cleanupPolicies: policies }), stderr: '' };
    if (args.includes('set-cleanup-policies')) gcloud.policy = JSON.parse(fs.readFileSync(args[args.indexOf('--policy') + 1], 'utf8'));
    return { code: 0, stdout: '', stderr: '' };
  };
  gcloud.calls = calls;
  return gcloud;
}

const out = () => createOutput({ json: true, stdout: sink(), stderr: sink(), env: {} });

test('planCleanup keeps the newest N of each image and never the one tagged latest', () => {
  const plan = planCleanup([...versions('web', 25), ...versions('api', 3), ...versions('old', 22, { latestAt: 0 })], 20);
  const web = plan.find((p) => p.name === 'web');
  assert.equal(web.versions, 25);
  assert.equal(web.kept, 20);
  assert.deepEqual(web.delete.map((d) => d.tags[0]), ['v4', 'v3', 'v2', 'v1', 'v0'], 'the 5 oldest go');
  assert.equal(plan.find((p) => p.name === 'api').delete.length, 0);
  const old = plan.find((p) => p.name === 'old');
  assert.ok(!old.delete.some((d) => d.tags.includes('latest')), 'latest survives even when old');
  assert.equal(old.delete.length, 1);
});

test('cleanupPolicy pairs Keep N with Delete older than a day', () => {
  assert.deepEqual(cleanupPolicy(20), [
    { name: 'keep-20-most-recent', action: { type: 'Keep' }, mostRecentVersions: { keepCount: 20 } },
    { name: 'delete-older-than-1d', action: { type: 'Delete' }, condition: { tagState: 'any', olderThan: '1d' } },
  ]);
});

test('runCleanup sets the policy, drops the old keep-10 rule and deletes only versions beyond N', () => {
  const gcloud = fakeGcloud([...versions('web', 22), ...versions('api', 2)]);
  const res = runCleanup({ gcloud, cfg: CFG, keep: 20, tmpDir: tempTree({}), out: out() });
  assert.equal(res.policy, 'set');
  assert.equal(gcloud.policy[0].mostRecentVersions.keepCount, 20);
  const dels = gcloud.calls.filter((a) => a.slice(0, 4).join(' ') === 'artifacts docker images delete');
  assert.deepEqual(dels.map((a) => a[4]).sort(), [`${PKG}/web@sha256:${'0'.repeat(64)}`, `${PKG}/web@sha256:${'0'.repeat(63)}1`]);
  for (const d of dels) assert.ok(d.includes('--delete-tags') && d.includes('--quiet'));
  const drop = gcloud.calls.find((a) => a.includes('delete-cleanup-policies'));
  assert.ok(drop.includes('--policynames=keep-10-most-recent'));
  assert.equal(res.deleted, 2);
  assert.equal(res.bytesFreedUpTo, 2000);
});

test('runCleanup --dry-run lists only; a gcloud failure says to sign in as the owner', () => {
  const gcloud = fakeGcloud(versions('web', 22));
  const res = runCleanup({ gcloud, cfg: CFG, keep: 20, dryRun: true, tmpDir: tempTree({}), out: out() });
  assert.equal(res.wouldDelete, 2);
  assert.equal(res.policy, 'unchanged');
  assert.deepEqual(gcloud.calls.map((a) => a.slice(0, 3).join(' ')), ['artifacts docker images']);
  assert.throws(() => runCleanup({ gcloud: fakeGcloud([], { fail: 'list' }), cfg: CFG, tmpDir: tempTree({}), out: out() }), (e) => /permission denied/.test(e.message) && /gcloud auth login/.test(e.fix));
  assert.throws(() => runCleanup({ gcloud, cfg: CFG, keep: 0, tmpDir: tempTree({}), out: out() }), /--keep/);
});

test('cleanup command: --json result, --keep parsed, default 20', async () => {
  const home = tempTree({ '.dockeriser/config.json': JSON.stringify(CFG) });
  const gcloud = fakeGcloud(versions('web', 23));
  const stdout = sink();
  const code = await run(['cleanup', '--dry-run', '--json'], { env: { NO_COLOR: '1' }, homeDir: home, stdout, stderr: sink(), gcloud, tmpDir: tempTree({}) });
  assert.equal(code, 0);
  const res = JSON.parse(stdout.text());
  assert.equal(res.keep, 20);
  assert.equal(res.wouldDelete, 3);
  const stdout2 = sink();
  assert.equal(await run(['cleanup', '--keep', '5', '--dry-run', '--json'], { env: {}, homeDir: home, stdout: stdout2, stderr: sink(), gcloud, tmpDir: tempTree({}) }), 0);
  assert.equal(JSON.parse(stdout2.text()).wouldDelete, 18);
  assert.equal(await run(['cleanup', '--keep', 'x', '--json'], { env: {}, homeDir: home, stdout: sink(), stderr: sink(), gcloud, tmpDir: tempTree({}) }), 2);
});

test('the gcloud runner finds gcloud by path (it used to read a field findGcloud never returns)', { skip: !findGcloud() }, () => {
  const res = createGcloudRunner()(['--version']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Google Cloud SDK/);
});
