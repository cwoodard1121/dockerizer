import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyCredentials, resolveConfig, resolveCredentials, resourceNames } from '../src/config.js';
import { ConfigError, AuthError } from '../src/errors.js';
import { defaultTag, expandImage, gitShaIfClean, utcStamp } from '../src/image.js';
import { tempTree } from './helpers.js';

const base = { project: 'demo-proj', region: 'northamerica-northeast2', repo: 'docker-images', fallbackTag: () => 'abc1234' };
const AR = 'northamerica-northeast2-docker.pkg.dev/demo-proj/docker-images';

test('short image names expand to Artifact Registry and always add :latest', () => {
  const r = expandImage({ ...base, image: 'myapp:1.2' });
  assert.equal(r.repository, `${AR}/myapp`);
  assert.deepEqual(r.refs, [`${AR}/myapp:1.2`, `${AR}/myapp:latest`]);
  assert.equal(r.primary, `${AR}/myapp:1.2`);
});

test('no tag uses the fallback tag; --tag adds more; duplicates collapse', () => {
  assert.deepEqual(expandImage({ ...base, image: 'myapp' }).tags, ['abc1234', 'latest']);
  assert.deepEqual(expandImage({ ...base, image: 'myapp:v1', extraTags: ['v1', 'stable', 'latest'] }).tags, ['v1', 'stable', 'latest']);
});

test('full Artifact Registry refs are used as-is', () => {
  const full = 'us-east1-docker.pkg.dev/other/repo/team/app:9';
  const r = expandImage({ ...base, image: full });
  assert.equal(r.refs[0], full);
  assert.equal(r.repository, 'us-east1-docker.pkg.dev/other/repo/team/app');
});

test('bad image refs are rejected with ConfigError', () => {
  for (const image of ['docker.io/library/nginx', 'MyApp', 'app@sha256:abc', 'localhost:5000/x', 'us-docker.pkg.dev/p/app', 'app:-bad']) {
    assert.throws(() => expandImage({ ...base, image }), ConfigError, image);
  }
  assert.throws(() => expandImage({ ...base, image: '' }), /Missing --image/);
});

test('default tag: clean git SHA, else UTC timestamp', () => {
  const clean = (cmd, args) => (args[0] === 'rev-parse' ? 'abc1234\n' : '');
  const dirty = (cmd, args) => (args[0] === 'rev-parse' ? 'abc1234\n' : ' M Dockerfile\n');
  const noGit = () => {
    throw new Error('not a git repository');
  };
  const now = new Date('2026-10-16T21:03:09.500Z');
  assert.equal(gitShaIfClean('.', clean), 'abc1234');
  assert.equal(gitShaIfClean('.', dirty), null);
  assert.equal(defaultTag('.', { now, exec: clean }), 'abc1234');
  assert.equal(defaultTag('.', { now, exec: dirty }), '20261016-210309');
  assert.equal(defaultTag('.', { now, exec: noGit }), '20261016-210309');
  assert.equal(utcStamp(new Date('2026-01-02T03:04:05Z')), '20260102-030405');
});

test('config precedence: flags > env > config file > defaults', () => {
  const home = tempTree({ '.dockeriser/config.json': '\uFEFF' + JSON.stringify({ project: 'file-proj', region: 'us-east1', repo: 'file-repo', serviceAccount: 'sa@file.iam.gserviceaccount.com' }) });
  const fromFile = resolveConfig({ env: {}, homeDir: home });
  assert.equal(fromFile.project, 'file-proj');
  assert.equal(fromFile.region, 'us-east1');
  assert.equal(fromFile.sources.project, 'config file');

  const fromEnv = resolveConfig({ env: { DOCKERISER_PROJECT: 'env-proj', DOCKERISER_REPO: 'env-repo' }, homeDir: home });
  assert.equal(fromEnv.project, 'env-proj');
  assert.equal(fromEnv.repo, 'env-repo');
  assert.equal(fromEnv.region, 'us-east1');

  const fromFlags = resolveConfig({ flags: { project: 'flag-proj', region: 'europe-west1' }, env: { DOCKERISER_PROJECT: 'env-proj' }, homeDir: home });
  assert.equal(fromFlags.project, 'flag-proj');
  assert.equal(fromFlags.region, 'europe-west1');
  assert.equal(fromFlags.sources.project, 'flag');

  const defaults = resolveConfig({ flags: { project: 'demo-proj' }, env: {}, homeDir: tempTree({}) });
  assert.equal(defaults.region, 'northamerica-northeast2');
  assert.equal(defaults.repo, 'docker-images');
  assert.equal(defaults.serviceAccount, 'dockeriser@demo-proj.iam.gserviceaccount.com');
  assert.deepEqual(resourceNames(defaults), {
    sourceBucket: 'demo-proj-dockeriser-src',
    logsBucket: 'demo-proj-dockeriser-logs',
    registryHost: 'northamerica-northeast2-docker.pkg.dev',
    repoPath: `${AR}`,
  });
});

test('missing project is a ConfigError with exit code 2; bad JSON too', () => {
  assert.throws(() => resolveConfig({ env: {}, homeDir: tempTree({}) }), (err) => err instanceof ConfigError && err.exitCode === 2);
  assert.equal(resolveConfig({ env: {}, homeDir: tempTree({}), requireProject: false }).project, undefined);
  assert.throws(() => resolveConfig({ env: {}, homeDir: tempTree({ '.dockeriser/config.json': '{oops' }) }), /not valid JSON/);
  assert.throws(() => resolveConfig({ flags: { project: 'My Project' }, env: {}, homeDir: tempTree({}) }), /project ID/);
});

test('credential discovery order and metadata-probe guard', () => {
  const home = tempTree({ '.dockeriser/key.json': JSON.stringify({ type: 'service_account' }) });
  const key = path.join(home, '.dockeriser', 'key.json');
  const found = resolveCredentials({ env: {}, homeDir: home, platform: 'win32' });
  assert.equal(found.source, 'dockeriser-key');
  assert.equal(found.type, 'service_account');
  assert.equal(found.setEnv, key);

  const envFile = path.join(tempTree({ 'k.json': '{"type":"impersonated_service_account"}' }), 'k.json');
  assert.equal(resolveCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: envFile }, homeDir: home }).source, 'env');
  assert.throws(() => resolveCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: 'Z:/nope.json' }, homeDir: home }), AuthError);

  const appData = tempTree({ 'gcloud/application_default_credentials.json': '{"type":"authorized_user"}' });
  const adc = resolveCredentials({ env: { APPDATA: appData }, homeDir: tempTree({}), platform: 'win32' });
  assert.equal(adc.source, 'gcloud-adc');

  const none = resolveCredentials({ env: { APPDATA: tempTree({}) }, homeDir: tempTree({}), platform: 'win32' });
  assert.equal(none.source, 'none');
  const env = {};
  applyCredentials(none, env);
  assert.equal(env.METADATA_SERVER_DETECTION, 'none');
  const env2 = {};
  applyCredentials(found, env2);
  assert.equal(env2.GOOGLE_APPLICATION_CREDENTIALS, key);
  assert.ok(fs.existsSync(key));
});
