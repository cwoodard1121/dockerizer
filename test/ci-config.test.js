import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourlyUsd, machineShape, nodeVersion, normaliseCi, runCostUsd } from '../src/ci-config.js';
import { tempTree } from './helpers.js';

test('normaliseCi applies the defaults', () => {
  const ci = normaliseCi({ steps: ['npm ci', ' npm test '] }, 'dockeriser.json');
  assert.deepEqual(ci, { steps: ['npm ci', 'npm test'], machine: 'e2-standard-4', diskGb: 40, timeout: '60m', timeoutSec: 3600, node: null, env: {}, docker: true });
});

test('normaliseCi refuses a missing or empty step list, a non-E2 machine and a bad env name', () => {
  assert.throws(() => normaliseCi(undefined, 'f'), /no "ci" section/);
  assert.throws(() => normaliseCi({ steps: [] }, 'f'), /"ci.steps"/);
  assert.throws(() => normaliseCi({ steps: ['  '] }, 'f'), /"ci.steps"/);
  assert.throws(() => normaliseCi({ steps: ['x'], machine: 'n2-standard-4' }, 'f'), /E2 machine/);
  assert.throws(() => normaliseCi({ steps: ['x'], env: { 'bad-name': '1' } }, 'f'), /bad-name/);
  assert.throws(() => normaliseCi({ steps: ['x'], diskGb: 5 }, 'f'), /diskGb/);
  assert.throws(() => normaliseCi({ steps: ['x'], timeout: 'forever' }, 'f'), /timeout/);
});

test('machine shapes and hourly price', () => {
  assert.deepEqual(machineShape('e2-standard-4'), { vcpu: 4, ramGib: 16 });
  assert.deepEqual(machineShape('e2-highmem-2'), { vcpu: 2, ramGib: 16 });
  assert.deepEqual(machineShape('e2-highcpu-8'), { vcpu: 8, ramGib: 8 });
  assert.equal(machineShape('e2-micro'), null);
  // 4 x 0.005 + 16 x 0.000668 + 40 x 0.11 / 730 + 0.0025
  assert.ok(Math.abs(hourlyUsd('e2-standard-4', 40) - 0.039216) < 0.0001);
  assert.ok(Math.abs(runCostUsd(1800, 'e2-standard-4', 40) - 0.019608) < 0.0001);
});

test('node version: ci.node, then .node-version, then .nvmrc, then lts', () => {
  assert.equal(nodeVersion(tempTree({ '.node-version': 'v24.14.0\n' }), { node: '22' }), '22');
  assert.equal(nodeVersion(tempTree({ '.node-version': 'v24.14.0\n', '.nvmrc': '20' }), { node: null }), '24.14.0');
  assert.equal(nodeVersion(tempTree({ '.nvmrc': 'lts/*\n' }), { node: null }), 'lts');
  assert.equal(nodeVersion(tempTree({ '.nvmrc': '20\n' }), { node: null }), '20');
  assert.equal(nodeVersion(tempTree({}), { node: null }), 'lts');
});
