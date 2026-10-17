import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../src/cli.js';
import { readUsageCache } from '../src/usage.js';
import { sink, tempTree, tick, ts } from './helpers.js';

const AR = 'northamerica-northeast2-docker.pkg.dev/demo-proj/docker-images';

function setUpHome() {
  const home = tempTree({
    '.dockeriser/config.json': JSON.stringify({ project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images' }),
    '.dockeriser/key.json': JSON.stringify({ type: 'service_account' }),
  });
  return { home, env: { APPDATA: tempTree({}), PATH: '', NO_COLOR: '1' } };
}

/** base -> app share a build; web and proxy build alone. */
function project() {
  return tempTree({
    Dockerfile: 'FROM node:22\n',
    'app/Dockerfile': 'FROM app:base\n',
    'web/Dockerfile': 'FROM node:22\n',
    'proxy/Dockerfile': 'FROM caddy\n',
    'dockeriser.json': JSON.stringify({ images: [{ name: 'base', localTag: 'app:base', push: false }, { name: 'app', context: 'app' }, { name: 'web', context: 'web' }, { name: 'proxy', context: 'proxy' }] }),
  });
}

/**
 * Fake Cloud Build + Storage for several builds. Build n's final status is statuses[n-1]; its log
 * is "line from b-n". Each build's images come from the refs in its request.
 */
function fakeClients(statuses, { holdUntil } = {}) {
  const calls = { create: [], cancel: [], uploads: 0 };
  const polls = new Map();
  const reqs = new Map();
  const cloudBuild = {
    createBuild: async (req) => {
      calls.create.push(req);
      const id = `b-${calls.create.length}`;
      reqs.set(id, req);
      return [{ metadata: { build: { id, name: `projects/demo-proj/locations/northamerica-northeast2/builds/${id}` } } }];
    },
    getBuild: async ({ name }) => {
      const id = name.split('/').pop();
      polls.set(id, (polls.get(id) || 0) + 1);
      if (holdUntil && !holdUntil()) return [{ id, status: 'WORKING' }];
      if (polls.get(id) < 2) return [{ id, status: 'WORKING' }];
      const n = Number(id.slice(2));
      const status = statuses[n - 1];
      const req = reqs.get(id);
      const steps = req.build.steps.map((s) => ({ ...s, timing: { startTime: ts('2026-10-16T10:00:00Z'), endTime: ts('2026-10-16T10:00:30Z') } }));
      const images = status === 'SUCCESS' ? (req.build.images || []).map((ref) => ({ name: ref, digest: `sha256:${String(n).repeat(64)}` })) : [];
      return [{ id, status, steps, startTime: ts('2026-10-16T10:00:00Z'), finishTime: ts(`2026-10-16T10:0${n}:00Z`), options: {}, results: { images } }];
    },
    cancelBuild: async ({ name }) => {
      calls.cancel.push(name.split('/').pop());
      return [{}];
    },
  };
  const storage = {
    authClient: {
      request: async ({ url, headers }) => {
        const start = Number(headers.Range.match(/bytes=(\d+)-/)[1]);
        const id = decodeURIComponent(url.match(/\/o\/([^?]+)/)[1]).replace(/^log-|\.txt$/g, '');
        const buf = Buffer.from(`line from ${id}\n`);
        if (start >= buf.length) throw Object.assign(new Error('HTTP 416'), { response: { status: 416 } });
        return { status: 206, data: buf.subarray(start) };
      },
    },
    bucket: () => ({ upload: async () => (calls.uploads++, [{}, { generation: '7' }]) }),
  };
  return { calls, createClients: async () => ({ cloudBuild, storage }) };
}

const deps = (extra) => ({ stdout: sink(), stderr: sink(), sleep: tick, onSigint: () => () => {}, now: () => new Date('2026-10-16T10:05:00Z'), tmpDir: tempTree({}), ...extra });

test('independent images build in parallel: one upload, one build per group, one merged JSON', async () => {
  const { home, env } = setUpHome();
  const { calls, createClients } = fakeClients(['SUCCESS', 'SUCCESS', 'SUCCESS']);
  const d = deps({ env, homeDir: home, createClients });
  const code = await run(['build', project(), '--tag', 'v1', '--json'], d);
  assert.equal(code, 0, d.stderr.text());
  assert.equal(calls.uploads, 1, 'the source is uploaded once');
  assert.equal(calls.create.length, 3);
  const steps = calls.create.map((r) => r.build.steps.filter((s) => s.id.startsWith('build-')).map((s) => s.id));
  assert.deepEqual(steps, [['build-base', 'build-app'], ['build-web'], ['build-proxy']]);
  const objects = new Set(calls.create.map((r) => r.build.source.storageSource.object));
  assert.equal(objects.size, 1, 'every build reads the same upload');

  const out = JSON.parse(d.stdout.text());
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.parallel, true);
  assert.equal(out.builds.length, 3);
  assert.equal(out.buildId, 'b-1');
  assert.deepEqual(out.images.filter((i) => i.name.endsWith(':v1')).map((i) => [i.image, i.durationSec]), [['app', 60], ['web', 60], ['proxy', 60]]);
  assert.equal(out.buildMinutes, 1 + 2 + 3, 'summed');
  const err = d.stderr.text();
  assert.match(err, /in parallel \(3 builds\)/);
  assert.match(err, /\[base\+app\] line from b-1/);
  assert.match(err, /\[web\] line from b-2/);
  assert.equal(readUsageCache(home).builds, 3, 'every build counted in the usage cache');
});

test('one failed parallel build fails the whole result with its details; the others still finish', async () => {
  const { home, env } = setUpHome();
  const { createClients } = fakeClients(['SUCCESS', 'FAILURE', 'SUCCESS']);
  const d = deps({ env, homeDir: home, createClients });
  assert.equal(await run(['build', project(), '--json'], d), 1);
  const out = JSON.parse(d.stdout.text());
  assert.equal(out.status, 'FAILURE');
  assert.equal(out.buildId, 'b-2', 'top level describes the failed build');
  assert.deepEqual(out.builds.map((b) => b.status), ['SUCCESS', 'FAILURE', 'SUCCESS']);
  assert.ok(out.logFile && fs.existsSync(out.logFile));
});

test('--sequential and "parallel": false keep one build; --dry-run shows every request', async () => {
  const { home, env } = setUpHome();
  const dir = project();
  const one = fakeClients(['SUCCESS']);
  assert.equal(await run(['build', dir, '--sequential', '--json'], deps({ env, homeDir: home, createClients: one.createClients })), 0);
  assert.equal(one.calls.create.length, 1);
  const raw = JSON.parse(fs.readFileSync(`${dir}/dockeriser.json`, 'utf8'));
  fs.writeFileSync(`${dir}/dockeriser.json`, JSON.stringify({ ...raw, parallel: false }));
  const two = fakeClients(['SUCCESS']);
  assert.equal(await run(['build', dir, '--json'], deps({ env, homeDir: home, createClients: two.createClients })), 0);
  assert.equal(two.calls.create.length, 1);
  fs.writeFileSync(`${dir}/dockeriser.json`, JSON.stringify(raw));
  const d = deps({ env, homeDir: home });
  assert.equal(await run(['build', dir, '--dry-run', '--json'], d), 0);
  const dry = JSON.parse(d.stdout.text());
  assert.deepEqual(dry.builds, [['base', 'app'], ['web'], ['proxy']]);
  assert.equal(dry.requests.length, 3);
});

test('Ctrl-C during parallel builds cancels every one of them', async () => {
  const { home, env } = setUpHome();
  let fire;
  let released = false;
  const { calls, createClients } = fakeClients(['CANCELLED', 'CANCELLED', 'CANCELLED'], { holdUntil: () => released });
  const d = deps({
    env,
    homeDir: home,
    createClients,
    onSigint: (h) => ((fire = h), () => {}),
    sleep: async () => {
      await tick();
      if (calls.create.length === 3 && !calls.cancel.length) fire();
      if (calls.cancel.length === 3) released = true;
    },
  });
  assert.equal(await run(['build', project(), '--json'], d), 130);
  assert.deepEqual(calls.cancel.sort(), ['b-1', 'b-2', 'b-3']);
});
