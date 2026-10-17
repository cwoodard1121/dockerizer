import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { buildGroups, imageDeps, loadProject, normaliseImages, resolveBuildArgs, secretLookingArgs, selectImages } from '../src/project.js';
import { listUploadFiles, packageSource, removeTarball } from '../src/package-source.js';
import { dockerMatcher } from '../src/dockerignore.js';
import { buildRequestMulti } from '../src/build.js';
import { findShipLines, parseCompose, suggestConfig } from '../src/init.js';
import { tempTree } from './helpers.js';

test('.dockerignore uses Docker rules: an exception brings back a file inside an excluded folder', () => {
  const m = dockerMatcher('**\n!Dockerfile\n!packages/\n!scripts/build.mjs\n**/.env*\n');
  assert.equal(m.ignores('scripts/build.mjs'), false);
  assert.equal(m.ignores('scripts/other.mjs'), true);
  assert.equal(m.ignores('packages/a/b.js'), false);
  assert.equal(m.ignores('packages/a/.env.local'), true);
  assert.equal(m.ignores('.git/HEAD'), true);
  assert.equal(m.mayDescend('scripts'), true);
  assert.equal(m.mayDescend('deploy'), false);
  const n = dockerMatcher('*.log\n!keep.log\n');
  assert.equal(n.ignores('a.log'), true);
  assert.equal(n.ignores('sub/a.log'), false, 'Docker patterns are anchored at the root');
  assert.equal(n.ignores('keep.log'), false);
});

test('images: validation, shared repositories rejected, local bases pulled in by --only', () => {
  const root = tempTree({ Dockerfile: 'FROM node:24\n', 'deploy/app.Dockerfile': 'FROM app:base\n', 'deploy/proxy.Dockerfile': 'FROM caddy:2\n' });
  const images = normaliseImages([
    { name: 'base', image: 'app-base', localTag: 'app:base' },
    { name: 'app', dockerfile: 'deploy/app.Dockerfile', context: '.local/ctx' },
    { name: 'proxy', dockerfile: 'deploy/proxy.Dockerfile', context: 'deploy' },
  ], root);
  assert.equal(images[1].image, 'app');
  assert.equal(images[2].context, 'deploy');
  const read = (df) => fs.readFileSync(path.join(root, df), 'utf8');
  assert.deepEqual(selectImages(images, ['app'], read).selected.map((i) => i.name), ['base', 'app']);
  assert.deepEqual(selectImages(images, ['proxy'], read).selected.map((i) => i.name), ['proxy']);
  assert.throws(() => selectImages(images, ['nope'], read), /not an image/);
  assert.throws(() => normaliseImages([{ name: 'a', image: 'x' }, { name: 'b', image: 'x' }], root), /collide/);
  assert.throws(() => normaliseImages([{ name: 'a', push: false }], root), /localTag/);
  assert.throws(() => normaliseImages([{ name: 'a', image: 'x:1' }], root), /without a tag/);
  assert.throws(() => selectImages(normaliseImages([{ name: 'app', dockerfile: 'deploy/app.Dockerfile' }, { name: 'base', localTag: 'app:base' }], root), null, read), /later in the list/);
});

test('build args: only public names from the env file, ${git.sha} filled in, flags win', () => {
  const root = tempTree({ '.env': 'NEXT_PUBLIC_API=https://api.example.com\nDATABASE_PASSWORD=secret\nVITE_ID="abc"\n' });
  const [img] = normaliseImages([{ name: 'web', buildArgsFile: '.env', buildArgsFromEnv: ['NEXT_PUBLIC_*', 'VITE_*'], buildArgs: { GIT_SHA: '${git.sha}', MODE: '$MODE' } }], root);
  const warnings = [];
  const args = resolveBuildArgs(img, { root, env: {}, builtins: { 'git.sha': 'f00d' }, cliArgs: ['VITE_ID=override'], warn: (w) => warnings.push(w) });
  assert.deepEqual(args, ['NEXT_PUBLIC_API=https://api.example.com', 'VITE_ID=override', 'GIT_SHA=f00d', 'MODE=']);
  assert.ok(!args.join(' ').includes('secret'));
  assert.match(warnings[0], /MODE not set/);
  const [fromEnv] = normaliseImages([{ name: 'web', buildArgsFromEnv: 'VITE_*' }], root);
  assert.deepEqual(resolveBuildArgs(fromEnv, { root, env: { VITE_X: '1', SECRET: '2' } }), ['VITE_X=1']);
});

test('upload: each context with its own ignore rules, a staged context under a gitignored folder, include entries', () => {
  const root = tempTree({
    Dockerfile: 'FROM node\n',
    '.dockerignore': '**\n!Dockerfile\n!apps/\n',
    '.gitignore': '.local/\n',
    'apps/web/index.js': '1',
    'docs/readme.md': 'no',
    'deploy/proxy.Dockerfile': 'FROM caddy\n',
    'deploy/Caddyfile': ':80',
    'deploy/app.Dockerfile': 'FROM app:base\n',
    '.local/ctx/migrations/1.sql': 'select 1',
    'extra/notes.txt': 'x',
    'extra/skip.bin': 'x',
  });
  const images = normaliseImages([
    { name: 'base', localTag: 'app:base' },
    { name: 'app', dockerfile: 'deploy/app.Dockerfile', context: '.local/ctx' },
    { name: 'proxy', dockerfile: 'deploy/proxy.Dockerfile', context: 'deploy' },
  ], root);
  const { files } = listUploadFiles(root, { images, include: ['extra/*.txt'] });
  assert.deepEqual(files, ['.local/ctx/migrations/1.sql', 'Dockerfile', 'apps/web/index.js', 'deploy/Caddyfile', 'deploy/app.Dockerfile', 'deploy/proxy.Dockerfile', 'extra/notes.txt']);
  assert.throws(() => listUploadFiles(root, { images: normaliseImages([{ name: 'x', context: 'missing' }], root) }), /does not exist/);
});

test('a context outside the project is packed under _ctx/<name>/ and the request points at it', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-sib-'));
  fs.mkdirSync(path.join(parent, 'app'));
  fs.mkdirSync(path.join(parent, 'solver', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'app', 'Dockerfile'), 'FROM alpine\n');
  fs.writeFileSync(path.join(parent, 'solver', 'Dockerfile'), 'FROM python:3.12-slim\n');
  fs.writeFileSync(path.join(parent, 'solver', 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(parent, 'solver', 'node_modules', 'x.js'), '1');
  fs.writeFileSync(path.join(parent, 'solver', '.dockerignore'), 'node_modules\n');
  const root = path.join(parent, 'app');
  const images = normaliseImages([{ name: 'app' }, { name: 'solver', context: '../solver' }], root);
  assert.equal(images[1].context, '_ctx/solver');
  assert.equal(images[1].dockerfile, '_ctx/solver/Dockerfile');
  const pkg = await packageSource(root, { images, tmpDir: parent });
  const entries = [];
  await tar.t({ file: pkg.path, onentry: (e) => entries.push(e.path) });
  removeTarball(pkg.path);
  assert.deepEqual(entries.sort(), ['Dockerfile', '_ctx/solver/.dockerignore', '_ctx/solver/Dockerfile', '_ctx/solver/main.py']);
  const req = buildRequestMulti({ project: 'p', region: 'r', serviceAccount: 'sa', logsBucket: 'l', source: { bucket: 'b', object: 'o' }, images: images.map((i) => ({ ...i, repository: `r-docker.pkg.dev/p/d/${i.image}`, refs: [`r-docker.pkg.dev/p/d/${i.image}:1`], buildArgs: [] })), timeoutSec: 60 });
  assert.deepEqual(req.build.steps.at(-1).args.slice(-3), ['-f', '_ctx/solver/Dockerfile', '_ctx/solver']);
});

test('multi-image request: order kept, local tags added, cache only for pushed images, images = pushed refs', () => {
  const req = buildRequestMulti({
    project: 'p', region: 'r', serviceAccount: 'sa@p.iam.gserviceaccount.com', logsBucket: 'p-dockeriser-logs', source: { bucket: 'b', object: 'o' }, timeoutSec: 600,
    images: [
      { name: 'base', repository: null, refs: [], push: false, localTag: 'app:base', dockerfile: 'Dockerfile', context: '.', buildArgs: ['REVISION=abc'] },
      { name: 'app', repository: 'r-docker.pkg.dev/p/d/app', refs: ['r-docker.pkg.dev/p/d/app:1', 'r-docker.pkg.dev/p/d/app:latest'], push: true, localTag: null, dockerfile: 'deploy/app.Dockerfile', context: '.local/ctx', buildArgs: [] },
    ],
  });
  assert.deepEqual(req.build.steps.map((s) => s.id), ['build-base', 'pull-cache-app', 'build-app']);
  assert.ok(req.build.steps[0].args.includes('app:base'));
  assert.ok(!req.build.steps[0].args.includes('--cache-from'));
  assert.deepEqual(req.build.steps[2].args.slice(-3), ['-f', 'deploy/app.Dockerfile', '.local/ctx']);
  assert.deepEqual(req.build.images, ['r-docker.pkg.dev/p/d/app:1', 'r-docker.pkg.dev/p/d/app:latest']);
  assert.equal(req.build.options.machineType, undefined);
});

test('dockeriser.json: missing file is fine; bad source is rejected', () => {
  const empty = tempTree({});
  assert.equal(loadProject(empty).exists, false);
  const bad = tempTree({ 'dockeriser.json': '{"source":"svn"}' });
  assert.throws(() => loadProject(bad), /"source"/);
});

test('init: finds compose services, Dockerfiles, public build args and a docker save | ssh docker load script', () => {
  const compose = `name: demo\nservices:\n  api:\n    image: myapp-api:prod\n    build:\n      context: .\n      dockerfile: api.Dockerfile\n  web:\n    build: ./web\n    image: myapp-web:prod\n  db:\n    image: postgres:16\n`;
  assert.deepEqual(parseCompose(compose), [
    { service: 'api', image: 'myapp-api:prod', context: '.', dockerfile: 'api.Dockerfile' },
    { service: 'web', context: './web', image: 'myapp-web:prod' },
    { service: 'db', image: 'postgres:16' },
  ]);
  const ship = '#!/bin/bash\ndocker build -t myapp-api:prod .\ndocker save myapp-api:prod myapp-web:prod | gzip | ssh "$host" "gunzip | docker load"\nssh "$host" "cd /opt/myapp && bash remote.sh"\n';
  assert.equal(findShipLines(ship)[0].line, 3);
  assert.deepEqual(findShipLines(ship)[0].images, ['myapp-api:prod', 'myapp-web:prod']);
  const root = tempTree({
    'compose.yml': compose,
    'api.Dockerfile': 'FROM node:22-alpine\nARG GIT_SHA\n',
    'web/Dockerfile': 'FROM node:22\nARG NEXT_PUBLIC_API_URL\n',
    '.env': 'NEXT_PUBLIC_API_URL=x\n',
    'deploy/ship.sh': ship,
  });
  const { config, shipScripts } = suggestConfig(root);
  assert.deepEqual(config.images.map((i) => [i.name, i.dockerfile, i.context]), [['api', 'api.Dockerfile', '.'], ['web', 'web/Dockerfile', 'web']]);
  assert.deepEqual(config.images[0].buildArgs, { GIT_SHA: '${git.sha}' });
  assert.deepEqual(config.images[1].buildArgsFromEnv, ['NEXT_PUBLIC_*']);
  assert.equal(config.images[1].buildArgsFile, '.env');
  assert.equal(config.deploy.mode, 'load-only');
  assert.deepEqual(config.deploy.images, { api: { tagAs: 'myapp-api:prod' }, web: { tagAs: 'myapp-web:prod' } });
  assert.match(shipScripts[0].suggestion, /--mode load-only --tag-as api=myapp-api:prod --tag-as web=myapp-web:prod --then/);
  assert.ok(!JSON.stringify(config).match(/\d+\.\d+\.\d+\.\d+/), 'no hosts invented');
});

test('secret-looking build-arg names are flagged; public client prefixes are not', () => {
  assert.deepEqual(secretLookingArgs(['API_TOKEN=x', 'NEXT_PUBLIC_KEY=y', 'DB_PASSWORD=z', 'REVISION=1', 'STRIPE_SECRET_KEY=s', 'VITE_API_KEY=v', 'AWS_ACCESS_KEY_ID=a', 'SIGNING_KEY']), ['API_TOKEN', 'DB_PASSWORD', 'STRIPE_SECRET_KEY', 'AWS_ACCESS_KEY_ID', 'SIGNING_KEY']);
});

test('"prebuild" must be a non-empty command string', () => {
  const root = tempTree({ Dockerfile: 'FROM alpine\n' });
  assert.equal(normaliseImages([{ name: 'a', prebuild: 'npm run stage' }], root)[0].prebuild, 'npm run stage');
  assert.equal(normaliseImages([{ name: 'a' }], root)[0].prebuild, null);
  assert.throws(() => normaliseImages([{ name: 'a', prebuild: ['x'] }], root), /"prebuild" must be a command/);
});

test('buildGroups: images joined by a local-base FROM stay in one build; the rest build alone', () => {
  const root = tempTree({
    Dockerfile: 'FROM node:22\n',
    'app/Dockerfile': 'FROM app:base\n',
    'web/Dockerfile': 'FROM node:22\n',
    'proxy/Dockerfile': 'FROM caddy\n',
  });
  const images = normaliseImages([{ name: 'base', localTag: 'app:base' }, { name: 'web', context: 'web' }, { name: 'app', context: 'app' }, { name: 'proxy', context: 'proxy' }], root);
  const deps = imageDeps(images, (df) => fs.readFileSync(path.join(root, df), 'utf8'));
  assert.deepEqual(buildGroups(images, deps).map((g) => g.map((i) => i.name)), [['base', 'app'], ['web'], ['proxy']]);
  assert.deepEqual(buildGroups(images.slice(1), deps).map((g) => g.map((i) => i.name)), [['web'], ['app'], ['proxy']], 'a base that is not selected does not group');
});
