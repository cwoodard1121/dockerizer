import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';
import { readUsageCache } from '../src/usage.js';
import { buildContext } from '../plugin/hooks/session-start.js';
import { gcsLogStorage, sink, tempTree, tick, ts } from './helpers.js';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HELLO = path.join(REPO, 'examples', 'hello');
const AR = 'northamerica-northeast2-docker.pkg.dev/demo-proj/docker-images';
const RESULT_KEYS = ['status', 'buildId', 'images', 'durationSec', 'consoleUrl', 'logFile', 'failedStep', 'failureInfo', 'errorTail'];

/** A home folder that looks fully set up (config + key file), plus an env with no real credentials. */
function setUpHome() {
  const home = tempTree({
    '.dockeriser/config.json': JSON.stringify({ project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images' }),
    '.dockeriser/key.json': JSON.stringify({ type: 'service_account' }),
  });
  return { home, env: { APPDATA: tempTree({}), PATH: '', NO_COLOR: '1' } };
}

/** Mock clients that run one build through QUEUED -> WORKING -> final. */
function mockClients(final, logText) {
  const calls = { upload: [], create: [], get: 0, cancel: 0 };
  let polls = 0;
  const cloudBuild = {
    createBuild: async (req) => {
      calls.create.push(req);
      return [{ metadata: { build: { id: 'b-1', name: 'projects/demo-proj/locations/northamerica-northeast2/builds/b-1' } } }];
    },
    getBuild: async () => {
      calls.get++;
      polls++;
      if (polls === 1) return [{ id: 'b-1', status: 'QUEUED' }];
      if (polls === 2) return [{ id: 'b-1', status: 'WORKING' }];
      return [{ id: 'b-1', startTime: ts('2026-10-16T10:00:00Z'), finishTime: ts('2026-10-16T10:02:00Z'), options: {}, ...final }];
    },
    cancelBuild: async () => {
      calls.cancel++;
      return [{}];
    },
  };
  const { storage } = gcsLogStorage(() => logText);
  storage.bucket = (name) => ({
    upload: async (file, opts) => {
      calls.upload.push({ name, file, opts, exists: fs.existsSync(file) });
      return [{}, { generation: '7' }];
    },
  });
  return { calls, createClients: async () => ({ cloudBuild, storage }) };
}

const deps = (extra) => ({
  stdout: sink(),
  stderr: sink(),
  sleep: tick,
  onSigint: () => () => {},
  now: () => new Date('2026-10-16T10:05:00Z'),
  ...extra,
});

test('build --json success: one JSON object on stdout with digests and usage; logs on stderr', async () => {
  const { home, env } = setUpHome();
  const tmpDir = tempTree({});
  const { calls, createClients } = mockClients(
    { status: 'SUCCESS', results: { images: [{ name: `${AR}/hello:v1`, digest: 'sha256:aa' }, { name: `${AR}/hello`, digest: 'sha256:aa' }, { name: `${AR}/hello:latest`, digest: 'sha256:aa' }] } },
    'Step #1: building\nDONE\n',
  );
  const d = deps({ env, homeDir: home, createClients, tmpDir });
  const code = await run(['build', HELLO, '--image', 'hello:v1', '--json'], d);
  assert.equal(code, 0);
  const out = JSON.parse(d.stdout.text());
  for (const key of RESULT_KEYS) assert.ok(key in out, key);
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.buildId, 'b-1');
  assert.deepEqual(out.images, [{ name: `${AR}/hello:v1`, digest: 'sha256:aa' }, { name: `${AR}/hello:latest`, digest: 'sha256:aa' }], 'untagged duplicate dropped');
  assert.equal(out.durationSec, 120);
  assert.equal(out.logFile, null);
  assert.equal(out.exitCode, 0);
  assert.equal(out.usage.minutesUsed, 2);
  assert.match(out.usage.line, /^Cloud Build: 2 \/ 2,500 free min this month/);
  assert.match(d.stderr.text(), /Step #1: building/);

  assert.equal(calls.upload[0].name, 'demo-proj-dockeriser-src');
  assert.equal(calls.upload[0].exists, true);
  assert.equal(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tgz')).length, 0, 'tarball deleted after upload');
  const req = calls.create[0];
  assert.equal(req.build.source.storageSource.generation, '7');
  assert.equal(req.build.logsBucket, 'gs://demo-proj-dockeriser-logs');
  assert.equal(readUsageCache(home).seconds, 120);
});

test('build --json failure: failed step, failure info, tail and saved log; exit 1', async () => {
  const { home, env } = setUpHome();
  const tmpDir = tempTree({});
  const { createClients } = mockClients(
    {
      status: 'FAILURE',
      failureInfo: { type: 'USER_BUILD_STEP', detail: 'step 1 failed' },
      steps: [{ name: 'gcr.io/cloud-builders/docker', status: 'SUCCESS' }, { id: 'build', name: 'gcr.io/cloud-builders/docker', args: ['build'], status: 'FAILURE' }],
    },
    'Step #1: RUN false\nERROR\n',
  );
  const d = deps({ env, homeDir: home, createClients, tmpDir });
  const code = await run(['build', HELLO, '--image', 'hello', '--json'], d);
  assert.equal(code, 1);
  const out = JSON.parse(d.stdout.text());
  assert.equal(out.status, 'FAILURE');
  assert.equal(out.failedStep.index, 1);
  assert.equal(out.failureInfo.type, 'USER_BUILD_STEP');
  assert.deepEqual(out.errorTail, ['Step #1: RUN false', 'ERROR']);
  assert.equal(out.logFile, path.join(tmpDir, 'dockeriser-b-1.log'));
  assert.equal(fs.readFileSync(out.logFile, 'utf8'), 'Step #1: RUN false\nERROR\n');
});

test('human failure output shows the block with console URL and log path', async () => {
  const { home, env } = setUpHome();
  const { createClients } = mockClients({ status: 'TIMEOUT' }, 'slow\n');
  const d = deps({ env, homeDir: home, createClients, tmpDir: tempTree({}) });
  assert.equal(await run(['build', HELLO, '--image', 'hello'], d), 1);
  const text = d.stdout.text();
  assert.match(text, /BUILD TIMEOUT/);
  assert.match(text, /console: +https:\/\/console\.cloud\.google\.com\/cloud-build\/builds;region=northamerica-northeast2\/b-1\?project=demo-proj/);
  assert.match(text, /full log: +.*dockeriser-b-1\.log/);
  assert.match(text, /Cloud Build: 2 \/ 2,500 free min this month/);
});

test('config error in --json mode prints an ERROR object and exits 2 without touching the network', async () => {
  const d = deps({ env: { APPDATA: tempTree({}) }, homeDir: tempTree({}), createClients: async () => assert.fail('no network') });
  const code = await run(['build', HELLO, '--image', 'hello', '--json'], d);
  assert.equal(code, 2);
  const out = JSON.parse(d.stdout.text());
  assert.equal(out.status, 'ERROR');
  assert.equal(out.error.type, 'ConfigError');
  for (const key of RESULT_KEYS) assert.ok(key in out, key);
});

test('no credentials: exit 3 before packaging; dry run needs none', async () => {
  const home = tempTree({ '.dockeriser/config.json': '{"project":"demo-proj"}' });
  const d = deps({ env: { APPDATA: tempTree({}) }, homeDir: home, createClients: async () => assert.fail('no network') });
  assert.equal(await run(['build', HELLO, '--image', 'hello'], d), 3);
  assert.match(d.stderr.text(), /No Google credentials found/);

  const dry = deps({ env: { APPDATA: tempTree({}) }, homeDir: home, createClients: async () => assert.fail('no network') });
  assert.equal(await run(['build', HELLO, '--image', 'hello', '--dry-run'], dry), 0);
  const req = JSON.parse(dry.stdout.text());
  assert.equal(req.build.serviceAccount, 'projects/demo-proj/serviceAccounts/dockeriser@demo-proj.iam.gserviceaccount.com');
});

test('status --offline is fast, never builds clients, and reports cached usage', async () => {
  const { home, env } = setUpHome();
  fs.writeFileSync(
    path.join(home, '.dockeriser', 'usage-cache.json'),
    JSON.stringify({ version: 1, month: '2026-10', project: 'demo-proj', region: 'northamerica-northeast2', seconds: 312 * 60, otherSeconds: 0, builds: 20, countedIds: [], partial: false }),
  );
  const d = deps({ env, homeDir: home, createClients: async () => assert.fail('status --offline must not create clients') });
  const started = performance.now();
  const code = await run(['status', '--offline', '--json'], d);
  const elapsed = performance.now() - started;
  assert.equal(code, 0);
  assert.ok(elapsed < 300, `took ${elapsed} ms`);
  const out = JSON.parse(d.stdout.text());
  assert.equal(out.configured, true);
  assert.equal(out.credentials.present, true);
  assert.equal(out.project, 'demo-proj');
  assert.equal(out.usageLine, 'Cloud Build: 312 / 2,500 free min this month (12%)');
});

test('doctor with no credentials: readable failing checks, skips network, non-zero exit', async () => {
  const d = deps({ env: { APPDATA: tempTree({}), NO_COLOR: '1' }, homeDir: tempTree({}), createClients: async () => assert.fail('no network') });
  const code = await run(['doctor'], d);
  assert.notEqual(code, 0);
  const text = d.stdout.text();
  assert.match(text, /\[FAIL\] Config/);
  assert.match(text, /\[FAIL\] Credentials/);
  assert.match(text, /\[skip\] Cloud Build API/);
  assert.doesNotMatch(text + d.stderr.text(), /at .*\.js:\d+/);
});

test('usage with no credentials gives a readable error and non-zero exit', async () => {
  const home = tempTree({ '.dockeriser/config.json': '{"project":"demo-proj"}' });
  const d = deps({ env: { APPDATA: tempTree({}) }, homeDir: home, createClients: async () => assert.fail('no network') });
  assert.equal(await run(['usage'], d), 3);
  assert.match(d.stderr.text(), /No Google credentials found/);
});

test('session-start hook: not-signed-in context when unconfigured', async () => {
  const text = await buildContext({ pluginRoot: path.join(REPO, 'plugin'), env: { APPDATA: tempTree({}), PATH: '' }, homeDir: tempTree({}) });
  assert.match(text, /^dockeriser \(Docker builds on Google Cloud Build\) is not signed in\. Don't run local `docker build`\. Tell the user to run \(or use \/dockeriser:setup\):/);
  assert.match(text, /winget install Google\.CloudSDK/);
  assert.match(text, /powershell -ExecutionPolicy Bypass -File ".*setup\.ps1"\n/);
  assert.match(text, /add -Project <your-project-id>/);
  assert.doesNotMatch(text, /gcloud auth/, 'the setup script does the sign-ins itself');
});

test('session-start hook and login: the real project ID goes into the setup command when known', async () => {
  const home = tempTree({ '.dockeriser/config.json': '{"project":"cam-builds-1"}' });
  const env = { APPDATA: tempTree({}), PATH: '' };
  const text = await buildContext({ pluginRoot: path.join(REPO, 'plugin'), env, homeDir: home });
  assert.match(text, /setup\.ps1" -Project cam-builds-1/);
  assert.doesNotMatch(text, /<your-project-id>/);

  const d = deps({ env, homeDir: home, createClients: async () => assert.fail('no network') });
  assert.equal(await run(['login'], d), 3);
  assert.match(d.stdout.text(), /setup\.ps1" -Project cam-builds-1/);
});

test('session-start hook: one line with the usage when configured', async () => {
  const { home, env } = setUpHome();
  fs.writeFileSync(
    path.join(home, '.dockeriser', 'usage-cache.json'),
    JSON.stringify({ version: 1, month: new Date().toISOString().slice(0, 7), project: 'demo-proj', region: 'northamerica-northeast2', seconds: 600, otherSeconds: 0, builds: 1, countedIds: [], partial: false }),
  );
  const text = await buildContext({ pluginRoot: path.join(REPO, 'plugin'), env, homeDir: home });
  assert.match(text, /^Docker builds: use dockeriser, not local docker build \(node ".*bin\/dockeriser\.js" build <dir> --image <name> --json, or \/dockeriser:build\)\. Deploy only when the user asks\. Cloud Build: 10 \/ 2,500 free min this month \(0%\) Heavy test gates \(full check, integration, e2e\): node ".*bin\/dockeriser\.js" ci <dir> --json \(or \/dockeriser:ci\) runs the "ci" steps of dockeriser\.json on a cloud VM instead of this PC, about 3 cents a run\.$/);
  assert.equal(text.includes('\n'), false);
  fs.writeFileSync(path.join(home, '.dockeriser', 'ci-cache.json'), JSON.stringify({ month: new Date().toISOString().slice(0, 7), spentUsd: 0.41, capUsd: 5, runs: 2, disabled: null }));
  assert.match(await buildContext({ pluginRoot: path.join(REPO, 'plugin'), env, homeDir: home }), / CI: \$0\.41 \/ \$5\.00 this month \(2 runs\)\.$/);
});

test('unknown commands and flags exit 2', async () => {
  const d = deps({});
  assert.equal(await run(['frobnicate'], d), 2);
  assert.equal(await run(['build', '--bogus'], deps({})), 2);
  const h = deps({});
  assert.equal(await run(['--help'], h), 0);
  assert.match(h.stdout.text(), /dockeriser build \[dir\] --image/);
});

test('first Ctrl-C cancels the build and exits 130; JSON still printed', async () => {
  const { home, env } = setUpHome();
  let handler;
  let cancelled = false;
  const cloudBuild = {
    createBuild: async () => [{ metadata: { build: { id: 'b-2' } } }],
    getBuild: async () => {
      if (!cancelled) {
        handler(); // simulate Ctrl-C while the build runs
        return [{ id: 'b-2', status: 'WORKING' }];
      }
      return [{ id: 'b-2', status: 'CANCELLED', startTime: ts('2026-10-16T10:00:00Z'), finishTime: ts('2026-10-16T10:00:30Z') }];
    },
    cancelBuild: async (req) => {
      assert.equal(req.name, 'projects/demo-proj/locations/northamerica-northeast2/builds/b-2');
      cancelled = true;
      return [{}];
    },
  };
  const { storage } = gcsLogStorage(() => 404);
  storage.bucket = () => ({ upload: async () => [{}, {}] });
  const d = deps({
    env,
    homeDir: home,
    tmpDir: tempTree({}),
    createClients: async () => ({ cloudBuild, storage }),
    onSigint: (h) => ((handler = h), () => {}),
    exit: () => assert.fail('first Ctrl-C must not exit immediately'),
  });
  const code = await run(['build', HELLO, '--image', 'hello', '--json'], d);
  assert.equal(code, 130);
  assert.equal(cancelled, true);
  assert.match(d.stderr.text(), /cancelling build/);
  const out = JSON.parse(d.stdout.text());
  assert.equal(out.status, 'CANCELLED');
  assert.equal(out.exitCode, 130);
});

test('build refuses a repeated --image; deploy --build --image a --image b builds those dockeriser.json images', async () => {
  const { home, env } = setUpHome();
  const d = deps({ env, homeDir: home });
  assert.equal(await run(['build', HELLO, '--image', 'a', '--image', 'b', '--json'], d), 2);
  assert.match(JSON.parse(d.stdout.text()).error.message, /one --image/);

  const dir = tempTree({
    'a/Dockerfile': 'FROM alpine\n',
    'b/Dockerfile': 'FROM alpine\n',
    'c/Dockerfile': 'FROM alpine\n',
    'dockeriser.json': JSON.stringify({ images: [{ name: 'a', context: 'a' }, { name: 'b', context: 'b' }, { name: 'c', context: 'c' }] }),
  });
  const d2 = deps({ env, homeDir: home, tmpDir: tempTree({}) });
  assert.equal(await run(['deploy', dir, '--build', '--image', 'a', '--image', 'b', '--to', 'root@203.0.113.5', '--mode', 'load-only', '--dry-run', '--sequential'], d2), 0);
  const steps = JSON.parse(d2.stdout.text()).request.build.steps.map((s) => s.id);
  assert.deepEqual(steps.filter((s) => s.startsWith('build-')), ['build-a', 'build-b']);
  const d3 = deps({ env, homeDir: home });
  assert.equal(await run(['deploy', dir, '--build', '--image', 'a', '--image', 'zz', '--to', 'root@203.0.113.5', '--dry-run', '--json'], d3), 2);
});

test('deploy --save and --no-save together exit 2', async () => {
  const { home, env } = setUpHome();
  const d = deps({ env, homeDir: home });
  assert.equal(await run(['deploy', tempTree({}), '--to', 'root@203.0.113.5', '--image', 'web', '--save', '--no-save', '--json'], d), 2);
  assert.match(JSON.parse(d.stdout.text()).error.message, /--save and --no-save/);
});

test('build warns about secret-looking build args by name, never by value', async () => {
  const { home, env } = setUpHome();
  const d = deps({ env, homeDir: home, tmpDir: tempTree({}) });
  assert.equal(await run(['build', HELLO, '--image', 'hello:v1', '--build-arg', 'API_TOKEN=abc123', '--build-arg', 'NEXT_PUBLIC_URL=x', '--dry-run'], d), 0);
  assert.match(d.stderr.text(), /build args API_TOKEN look like secrets/);
  assert.ok(!d.stderr.text().includes('abc123'));
});

test('prebuild runs for the selected images before packaging (dry run too); a failure stops the build', async () => {
  const { home, env } = setUpHome();
  const node = JSON.stringify(process.execPath);
  const stage = `${node} -e "require('fs').mkdirSync('app-ctx',{recursive:true});require('fs').writeFileSync('app-ctx/staged.txt','x');console.log('staged')"`;
  const dir = tempTree({
    'Dockerfile.app': 'FROM alpine\nCOPY staged.txt /\n',
    'web/Dockerfile': 'FROM alpine\n',
    'dockeriser.json': JSON.stringify({ images: [{ name: 'app', context: 'app-ctx', dockerfile: 'Dockerfile.app', prebuild: stage }, { name: 'web', context: 'web', prebuild: `${node} -e "process.exit(1)"` }] }),
  });
  const d = deps({ env, homeDir: home, tmpDir: tempTree({}) });
  assert.equal(await run(['build', dir, '--only', 'app', '--dry-run', '--json'], d), 0, d.stderr.text());
  assert.ok(fs.existsSync(path.join(dir, 'app-ctx', 'staged.txt')), 'the context was staged');
  assert.match(d.stderr.text(), /prebuild app:/);
  assert.match(d.stderr.text(), /staged/);
  assert.ok(JSON.parse(d.stdout.text()).source.fileCount >= 2);

  const d2 = deps({ env, homeDir: home, tmpDir: tempTree({}) });
  assert.equal(await run(['build', dir, '--dry-run', '--json'], d2), 2);
  assert.match(JSON.parse(d2.stdout.text()).error.message, /prebuild for image "web" failed \(exit 1\)/);
});
