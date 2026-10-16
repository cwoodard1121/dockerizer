import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest, consoleUrl, exitCodeForStatus, failureInfo, findFailedStep, parseBuildArgs, parseTimeout,
  statusName, submitBuild, summarizeBuild, waitForBuild,
} from '../src/build.js';
import { AuthError, ConfigError, GRPC } from '../src/errors.js';
import { ts } from './helpers.js';

const repo = 'northamerica-northeast2-docker.pkg.dev/demo-proj/docker-images/hello';
const opts = {
  project: 'demo-proj',
  region: 'northamerica-northeast2',
  serviceAccount: 'dockeriser@demo-proj.iam.gserviceaccount.com',
  logsBucket: 'demo-proj-dockeriser-logs',
  source: { bucket: 'demo-proj-dockeriser-src', object: 'source/x.tgz', generation: '42' },
  repository: repo,
  refs: [`${repo}:v1`, `${repo}:latest`],
  dockerfile: 'Dockerfile',
  buildArgs: ['A=1'],
  timeoutSec: 1200,
};

test('build request: SA + logsBucket + GCS_ONLY, no machineType, regional parent', () => {
  const req = buildRequest(opts);
  assert.equal(req.parent, 'projects/demo-proj/locations/northamerica-northeast2');
  const b = req.build;
  assert.equal(b.serviceAccount, 'projects/demo-proj/serviceAccounts/dockeriser@demo-proj.iam.gserviceaccount.com');
  assert.equal(b.logsBucket, 'gs://demo-proj-dockeriser-logs');
  assert.deepEqual(b.options, { logging: 'GCS_ONLY' });
  assert.equal(JSON.stringify(req).includes('machineType'), false);
  assert.deepEqual(b.images, opts.refs);
  assert.deepEqual(b.tags, ['dockeriser']);
  assert.deepEqual(b.timeout, { seconds: 1200 });
  assert.deepEqual(b.source.storageSource, { bucket: 'demo-proj-dockeriser-src', object: 'source/x.tgz', generation: '42' });
});

test('build request: cache-from on by default', () => {
  const { steps } = buildRequest(opts).build;
  assert.equal(steps.length, 2);
  assert.equal(steps[0].entrypoint, 'bash');
  assert.deepEqual(steps[0].args, ['-c', `docker pull ${repo}:latest || true`]);
  assert.deepEqual(steps[1].env, ['DOCKER_BUILDKIT=1']);
  const args = steps[1].args.join(' ');
  assert.match(args, new RegExp(`--cache-from ${repo}:latest`));
  assert.match(args, /--build-arg BUILDKIT_INLINE_CACHE=1 --build-arg A=1/);
  assert.match(args, /-t \S+:v1 -t \S+:latest -f Dockerfile \.$/);
});

test('build request: --no-cache drops the pull step and cache-from', () => {
  const { steps } = buildRequest({ ...opts, noCache: true }).build;
  assert.equal(steps.length, 1);
  assert.ok(steps[0].args.includes('--no-cache'));
  assert.ok(!steps[0].args.includes('--cache-from'));
});

test('timeouts and build args are validated', () => {
  assert.equal(parseTimeout('20m'), 1200);
  assert.equal(parseTimeout('1h30m'), 5400);
  assert.equal(parseTimeout('90s'), 90);
  assert.equal(parseTimeout('600'), 600);
  assert.throws(() => parseTimeout('soon'), ConfigError);
  assert.throws(() => parseTimeout('25h'), ConfigError);
  assert.deepEqual(parseBuildArgs(['A=1', 'B']), ['A=1', 'B']);
  assert.throws(() => parseBuildArgs(['=x']), ConfigError);
});

test('submitBuild takes the id from operation metadata without waiting', async () => {
  let promiseCalled = false;
  const cloudBuild = {
    createBuild: async () => [{ name: 'operations/x', metadata: { build: { id: 'b-123' } }, promise: () => (promiseCalled = true) }],
  };
  const res = await submitBuild({ cloudBuild, request: { parent: 'projects/p/locations/r', build: {} } });
  assert.deepEqual(res, { id: 'b-123', name: 'projects/p/locations/r/builds/b-123', logUrl: undefined });
  assert.equal(promiseCalled, false);

  const denied = { createBuild: async () => Promise.reject(Object.assign(new Error('7 PERMISSION_DENIED: no'), { code: GRPC.PERMISSION_DENIED })) };
  await assert.rejects(submitBuild({ cloudBuild: denied, request: { parent: 'x' } }), AuthError);
});

test('waitForBuild polls until terminal and rides out transient errors', async () => {
  const seq = [
    () => [{ status: 'QUEUED' }],
    () => Promise.reject(Object.assign(new Error('unavailable'), { code: GRPC.UNAVAILABLE })),
    () => [{ status: 2 }],
    () => [{ status: 'SUCCESS', id: 'b' }],
  ];
  const seen = [];
  let calls = 0;
  const cloudBuild = { getBuild: async (req) => (seen.push(req.name), seq[calls++]()) };
  const build = await waitForBuild({ cloudBuild, name: 'projects/p/locations/r/builds/b', sleep: async () => {} });
  assert.equal(build.status, 'SUCCESS');
  assert.equal(calls, 4);
  assert.ok(seen.every((n) => n === 'projects/p/locations/r/builds/b'));
});

test('status names, exit codes and console URL', () => {
  assert.equal(statusName(3), 'SUCCESS');
  assert.equal(statusName(4), 'FAILURE');
  assert.equal(statusName('TIMEOUT'), 'TIMEOUT');
  assert.equal(exitCodeForStatus('SUCCESS'), 0);
  for (const s of ['FAILURE', 'TIMEOUT', 'CANCELLED', 'INTERNAL_ERROR', 'EXPIRED']) assert.equal(exitCodeForStatus(s), 1);
  assert.equal(consoleUrl('r1', 'id1', 'p1'), 'https://console.cloud.google.com/cloud-build/builds;region=r1/id1?project=p1');
});

const failed = {
  id: 'b9',
  status: 'FAILURE',
  startTime: ts('2026-10-16T10:00:00Z'),
  finishTime: ts('2026-10-16T10:01:30Z'),
  failureInfo: { type: 'USER_BUILD_STEP', detail: 'Build step failure: build step 1 "gcr.io/cloud-builders/docker" failed' },
  steps: [
    { id: 'pull-cache', name: 'gcr.io/cloud-builders/docker', entrypoint: 'bash', args: ['-c', 'docker pull x || true'], status: 'SUCCESS' },
    { id: 'build', name: 'gcr.io/cloud-builders/docker', args: ['build', '-t', 'x', '.'], status: 'FAILURE' },
  ],
};

test('failed step detection and failure info hints', () => {
  assert.deepEqual(findFailedStep(failed), { index: 1, id: 'build', name: 'gcr.io/cloud-builders/docker', status: 'FAILURE', args: 'build -t x .' });
  assert.equal(findFailedStep({ steps: [{ status: 'SUCCESS' }] }), null);
  assert.equal(failureInfo({ failureInfo: { type: 3, detail: 'denied' } }).type, 'PUSH_NOT_AUTHORIZED');
  assert.match(failureInfo({ failureInfo: { type: 'PUSH_NOT_AUTHORIZED' } }).hint, /Artifact Registry Writer/);
  assert.deepEqual(failureInfo({ statusDetail: 'timed out' }), { type: 'FAILURE_TYPE_UNSPECIFIED', detail: 'timed out' });
});

test('summary of a failed build carries step, failure info, tail and log file', () => {
  const tail = Array.from({ length: 80 }, (_, i) => `line ${i}`);
  const s = summarizeBuild(failed, { project: 'p', region: 'r', logFile: 'C:/tmp/dockeriser-b9.log', tail });
  assert.equal(s.status, 'FAILURE');
  assert.equal(s.durationSec, 90);
  assert.equal(s.buildMinutes, 1.5);
  assert.equal(s.failedStep.index, 1);
  assert.equal(s.failureInfo.type, 'USER_BUILD_STEP');
  assert.equal(s.errorTail.length, 50);
  assert.equal(s.errorTail[49], 'line 79');
  assert.equal(s.logFile, 'C:/tmp/dockeriser-b9.log');
});

test('summary of a successful build lists digests and no failure fields', () => {
  const ok = { ...failed, status: 'SUCCESS', results: { images: [{ name: 'a:v1', digest: 'sha256:1' }, { name: 'a:latest', digest: 'sha256:1' }] } };
  const s = summarizeBuild(ok, { project: 'p', region: 'r', logFile: 'x', tail: ['a'] });
  assert.deepEqual(s.images, [{ name: 'a:v1', digest: 'sha256:1' }, { name: 'a:latest', digest: 'sha256:1' }]);
  assert.equal(s.logFile, null);
  assert.equal(s.failedStep, null);
  assert.equal(s.failureInfo, null);
  assert.deepEqual(s.errorTail, []);
});
