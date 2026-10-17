import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciLine, ciSummary, emptyLedger, evaluateCap, readCiCache, readLedger, summaryFromCiCache, updateLedger, writeCiCache } from '../src/ci-ledger.js';
import { fakeGcs, tempTree } from './helpers.js';

const run = (costUsd) => ({ id: `ci-${Math.random()}`, costUsd, status: 'SUCCESS' });
const ledgerWith = (...costs) => ({ ...emptyLedger('2026-10'), runs: costs.map(run) });

test('the hard stop turns CI off on any day', () => {
  const res = evaluateCap(ledgerWith(3, 2), new Date('2026-10-02T12:00:00Z'));
  assert.equal(res.ok, false);
  assert.match(res.reason, /\$5\.00 spent.*\$5\.00 monthly cap/);
});

test('the pace check starts on day 7', () => {
  const ledger = ledgerWith(1.5);
  assert.equal(evaluateCap(ledger, new Date('2026-10-06T23:00:00Z')).ok, true);
  const day7 = evaluateCap(ledger, new Date('2026-10-07T01:00:00Z'));
  assert.equal(day7.ok, false); // 1.5 x 31 / 7 = 6.64
  assert.match(day7.reason, /on pace for \$6\.64/);
  assert.equal(evaluateCap(ledgerWith(1), new Date('2026-10-07T01:00:00Z')).ok, true); // 4.43
});

test('the owner override skips the pace check, not the hard stop', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(evaluateCap({ ...ledgerWith(3), override: true }, now).ok, true);
  assert.equal(evaluateCap({ ...ledgerWith(5.01), override: true }, now).ok, false);
});

test('a disabled ledger stays off', () => {
  const ledger = { ...ledgerWith(0.1), disabled: { at: '2026-10-08T00:00:00Z', reason: 'on pace for $9.00' } };
  const res = evaluateCap(ledger, new Date('2026-10-09T00:00:00Z'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'on pace for $9.00');
});

test('readLedger of a missing object is an empty ledger for that month', async () => {
  const gcs = fakeGcs();
  const { ledger, generation } = await readLedger(gcs.storage, 'logs', '2026-10');
  assert.deepEqual(ledger, emptyLedger('2026-10'));
  assert.equal(generation, 0);
});

test('updateLedger retries on a precondition failure and keeps both writers\' runs', async () => {
  const gcs = fakeGcs();
  let raced = false;
  gcs.beforeWrite = () => {
    if (raced) return;
    raced = true;
    // Another machine writes between our read and our write.
    gcs.put('logs', 'ci/ledger-2026-10.json', JSON.stringify({ ...emptyLedger('2026-10'), runs: [{ id: 'other', costUsd: 0.02 }] }));
  };
  const ledger = await updateLedger(gcs.storage, 'logs', '2026-10', (l) => {
    l.runs.push({ id: 'mine', costUsd: 0.03 });
  }, { sleep: async () => {} });
  assert.deepEqual(ledger.runs.map((r) => r.id), ['other', 'mine']);
  const stored = JSON.parse(gcs.get('logs', 'ci/ledger-2026-10.json'));
  assert.deepEqual(stored.runs.map((r) => r.id), ['other', 'mine']);
});

test('summary line, cache round trip', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  const on = ciSummary(ledgerWith(0.25, 0.16), now);
  assert.equal(on.line, 'CI: $0.41 / $5.00 this month (2 runs)');
  const off = ciSummary({ ...ledgerWith(0.1), disabled: { at: 'x', reason: '$5.00 spent' } }, now);
  assert.equal(ciLine(off), 'CI is OFF for 2026-10 ($5.00 spent); it turns back on next month');
  const home = tempTree({});
  const env = { DOCKERISER_CONFIG_DIR: `${home}/.dockeriser` };
  writeCiCache(home, on, env);
  assert.equal(summaryFromCiCache(readCiCache(home, env), now).line, on.line);
  assert.equal(summaryFromCiCache(readCiCache(home, env), new Date('2026-11-01T00:00:00Z')), null);
});
