import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowRuns, runCiInit } from '../src/ci-init.js';
import { tempTree } from './helpers.js';

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'appraiseme-ci.yml'), 'utf8');
const APPRAISEME_STEPS = [
  'npm ci', 'npm run check', 'npm run dev:services', 'npm run db:reset:test', 'npm run db:types:check',
  'npm run test:integration', 'npx playwright install --with-deps chromium', 'npm run test:e2e',
];

test('appraiseme\'s workflow gives its gate, without the failure/always steps or repeats', () => {
  const { steps, skipped } = parseWorkflowRuns(FIXTURE);
  assert.deepEqual([...new Set(steps)], APPRAISEME_STEPS);
  assert.ok(skipped.some((s) => /docker compose -f infra\/compose\/dependencies.yml ps/.test(s.run) && /failure\(\)/.test(s.if)));
  assert.ok(skipped.some((s) => /down --volumes/.test(s.run) && /always\(\)/.test(s.if)));
});

test('multi-line run blocks and quoted values', () => {
  const yml = ['jobs:', '  a:', '    steps:', '      - name: two lines', '        run: |', '          echo one', '          echo two', "      - run: 'npm test'", '      - uses: actions/checkout@v4', ''].join('\n');
  assert.deepEqual(parseWorkflowRuns(yml).steps, ['echo one\necho two', 'npm test']);
});

test('ci init writes the ci section from the workflows', () => {
  const dir = tempTree({ '.github/workflows/ci.yml': FIXTURE, 'dockeriser.json': '{"images":[{"name":"app"}]}\n' });
  const res = runCiInit({ dir });
  assert.equal(res.written, true);
  assert.equal(res.from, '.github/workflows/ci.yml');
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'dockeriser.json'), 'utf8'));
  assert.deepEqual(data.images, [{ name: 'app' }]);
  assert.deepEqual(data.ci.steps, APPRAISEME_STEPS);
});

test('without workflows, package.json scripts', () => {
  const dir = tempTree({ 'package.json': JSON.stringify({ scripts: { check: 'x', 'test:e2e': 'y', test: 'z' } }), 'package-lock.json': '{}' });
  const res = runCiInit({ dir, dryRun: true });
  assert.equal(res.written, false);
  assert.equal(res.from, 'package.json');
  assert.deepEqual(res.config.steps, ['npm ci', 'npm run check', 'npm run test:e2e']);
  assert.equal(fs.existsSync(path.join(dir, 'dockeriser.json')), false);
});

test('an existing ci section is kept unless --force', () => {
  const dir = tempTree({ 'dockeriser.json': '{"ci":{"steps":["make test"]}}', 'package.json': '{"scripts":{"test":"x"}}' });
  const res = runCiInit({ dir });
  assert.equal(res.written, false);
  assert.equal(res.exists, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'dockeriser.json'), 'utf8')).ci.steps, ['make test']);
  assert.equal(runCiInit({ dir, force: true }).written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'dockeriser.json'), 'utf8')).ci.steps, ['npm install', 'npm test']);
});
