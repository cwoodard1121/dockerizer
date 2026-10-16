import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as tar from 'tar';
import { ConfigError } from '../src/errors.js';
import { activeTempFiles, dockerignoreToGitignore, loadIgnore, listFiles, packageSource, removeTarball } from '../src/package-source.js';
import { tempTree } from './helpers.js';

async function entries(file) {
  const names = [];
  await tar.t({ file, onReadEntry: (e) => names.push(e.path) });
  return names.sort();
}

test('.git/ is always excluded and entries use forward slashes', async () => {
  const dir = tempTree({ Dockerfile: 'FROM alpine', 'src/app/main.js': 'x', '.git/HEAD': 'ref', '.git/objects/ab': 'y' });
  const pkg = await packageSource(dir);
  try {
    assert.deepEqual(await entries(pkg.path), ['Dockerfile', 'src/app/main.js']);
    assert.equal(pkg.fileCount, 2);
    assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pkg.bytes > 0);
  } finally {
    removeTarball(pkg.path);
  }
  assert.equal(fs.existsSync(pkg.path), false);
  assert.equal(activeTempFiles.size, 0);
});

test('.gcloudignore takes precedence over .dockerignore', async () => {
  const dir = tempTree({
    Dockerfile: 'FROM alpine',
    '.gcloudignore': 'secret.txt\n',
    '.dockerignore': 'keep.txt\n',
    'secret.txt': 's',
    'keep.txt': 'k',
  });
  const { matcher, ignoreFile } = loadIgnore(dir);
  assert.equal(ignoreFile, '.gcloudignore');
  const files = listFiles(dir, matcher);
  assert.ok(files.includes('keep.txt'));
  assert.ok(!files.includes('secret.txt'));
});

test('.gcloudignore #!include: pulls in another file', () => {
  const dir = tempTree({ Dockerfile: 'x', '.gcloudignore': '#!include:.gitignore\n', '.gitignore': 'dist/\n', 'dist/a.js': 'a', 'b.js': 'b' });
  const { matcher } = loadIgnore(dir);
  assert.deepEqual(listFiles(dir, matcher), ['.gcloudignore', '.gitignore', 'Dockerfile', 'b.js']);
});

test('.dockerignore patterns are anchored at the root like Docker', () => {
  assert.deepEqual(dockerignoreToGitignore('# c\nnode_modules\n./build\n/dist\n!keep\n**/*.log\n'), [
    '/node_modules',
    '/build',
    '/dist',
    '!/keep',
    '/**/*.log',
  ]);
  const dir = tempTree({ Dockerfile: 'x', '.dockerignore': 'node_modules\n*.md\n', 'node_modules/a.js': 'a', 'README.md': 'r', 'docs/guide.md': 'g' });
  const { matcher, ignoreFile } = loadIgnore(dir);
  assert.equal(ignoreFile, '.dockerignore');
  // "*.md" only matches at the root in Docker, so docs/guide.md stays.
  assert.deepEqual(listFiles(dir, matcher), ['.dockerignore', 'Dockerfile', 'docs/guide.md']);
});

test('the Dockerfile is sent even when an ignore file excludes it', async () => {
  const dir = tempTree({ Dockerfile: 'FROM alpine', '.dockerignore': 'Dockerfile\n', 'app.js': 'x' });
  const pkg = await packageSource(dir);
  try {
    assert.ok((await entries(pkg.path)).includes('Dockerfile'));
  } finally {
    removeTarball(pkg.path);
  }
});

test('missing Dockerfile fails before packaging', async () => {
  const dir = tempTree({ 'app.js': 'x' });
  await assert.rejects(packageSource(dir), (err) => err instanceof ConfigError && /No Dockerfile/.test(err.message));
  await assert.rejects(packageSource(dir, { dockerfile: '../Dockerfile' }), /outside the build folder/);
});

test('empty folder (after ignores) fails', async () => {
  const empty = tempTree({});
  await assert.rejects(packageSource(empty), /Nothing to upload/);
  const allIgnored = tempTree({ '.gcloudignore': '*\n', Dockerfile: 'x' });
  await assert.rejects(packageSource(allIgnored), /excluded by \.gcloudignore/);
});

test('missing folder fails', async () => {
  await assert.rejects(packageSource('Z:/definitely/not/here'), (err) => err.exitCode === 2 && /does not exist/.test(err.message));
});

test('custom --dockerfile path is used relative to the folder', async () => {
  const dir = tempTree({ 'docker/prod.Dockerfile': 'FROM alpine', 'app.js': 'x' });
  const pkg = await packageSource(dir, { dockerfile: 'docker/prod.Dockerfile' });
  removeTarball(pkg.path);
  assert.equal(pkg.dockerfile, 'docker/prod.Dockerfile');
});

test('small uploads do not warn (threshold is 100 MB)', async () => {
  const dir = tempTree({ Dockerfile: 'x' });
  const warnings = [];
  const { LARGE_UPLOAD_BYTES } = await import('../src/package-source.js');
  assert.equal(LARGE_UPLOAD_BYTES, 100 * 1024 * 1024);
  const pkg = await packageSource(dir, { warn: (m) => warnings.push(m) });
  removeTarball(pkg.path);
  assert.deepEqual(warnings, []);
});
