import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_PRICE_PER_MINUTE_USD, FREE_BUILD_MINUTES } from '../src/pricing.js';
import {
  aggregateBuilds, arStorageSummary, buildSeconds, cacheFromTotals, fetchBuildTotals, isFreeTierBuild, monthRange,
  progressBar, projectUsage, readUsageCache, recordBuild, summaryFromCache, usageLine, writeUsageCache,
} from '../src/usage.js';
import { tempTree, ts } from './helpers.js';

const build = (id, start, secs, extra = {}) => ({
  id,
  startTime: ts(start),
  finishTime: ts(new Date(Date.parse(start) + secs * 1000).toISOString()),
  ...extra,
});

test('pricing constants match the researched values', () => {
  assert.equal(FREE_BUILD_MINUTES, 2500);
  assert.equal(BUILD_PRICE_PER_MINUTE_USD, 0.006);
});

test('build minutes are billed per second from start to finish; unstarted builds do not count', () => {
  assert.equal(buildSeconds(build('a', '2026-10-01T00:00:00Z', 61)), 61);
  assert.equal(buildSeconds({ status: 'QUEUED', createTime: ts('2026-10-01T00:00:00Z') }), null);
  assert.equal(buildSeconds({ startTime: ts('2026-10-01T00:00:00Z') }), null);
  assert.equal(isFreeTierBuild({ options: {} }), true);
  assert.equal(isFreeTierBuild({ options: { machineType: 'E2_HIGHCPU_8' } }), false);
  assert.equal(isFreeTierBuild({ options: { pool: { name: 'projects/p/locations/r/workerPools/x' } } }), false);
});

test('monthly aggregation separates non-free-tier machines', () => {
  const totals = aggregateBuilds([
    build('a', '2026-10-01T00:00:00Z', 90),
    build('b', '2026-10-02T00:00:00Z', 30),
    build('c', '2026-10-02T00:00:00Z', 600, { options: { machineType: 'E2_HIGHCPU_8' } }),
    { id: 'q', status: 'QUEUED' },
  ]);
  assert.deepEqual(totals, { seconds: 120, otherSeconds: 600, builds: 2, ids: ['a', 'b', 'c'] });
});

test('projection math with a fixed clock (under the free tier)', () => {
  const now = new Date('2026-10-11T00:00:00Z'); // 10 days into a 31-day month
  const range = monthRange(undefined, now);
  assert.equal(range.month, '2026-10');
  assert.equal(range.daysInMonth, 31);
  const u = projectUsage({ seconds: 500 * 60, builds: 50 }, range, now);
  assert.equal(u.minutesUsed, 500);
  assert.equal(u.minutesLeft, 2000);
  assert.equal(u.percent, 20);
  assert.equal(u.avgMinutesPerBuild, 10);
  assert.equal(u.minutesPerDay, 50);
  assert.equal(u.projectedMinutes, 1550);
  assert.equal(u.crossDate, null); // 2,500 / 50 per day = day 50, after month end
  assert.equal(u.costSoFarUsd, 0);
  assert.equal(u.projectedCostUsd, 0);

  const fast = projectUsage({ seconds: 1000 * 60, builds: 10 }, range, now); // 100 min/day -> crosses on day 25
  assert.equal(fast.crossDate, '2026-10-26');
  assert.equal(fast.projectedMinutes, 3100);
  assert.equal(fast.projectedCostUsd, 3.6); // 600 over * $0.006
});

test('overage cost once past 2,500 minutes', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const u = projectUsage({ seconds: 2540 * 60, builds: 100 }, monthRange(undefined, now), now);
  assert.equal(u.alreadyOver, true);
  assert.equal(u.overageMinutes, 40);
  assert.equal(u.costSoFarUsd, 0.24);
  assert.equal(u.crossDate, null);
  assert.equal(usageLine(u), 'Cloud Build: 2,540 / 2,500 free min this month, over by 40 min ≈ $0.24');
});

test('past months use the full month and no projection beyond actuals', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  const range = monthRange('2026-10', now);
  assert.equal(range.isCurrent, false);
  const u = projectUsage({ seconds: 310 * 60, builds: 31 }, range, now);
  assert.equal(u.minutesPerDay, 10);
  assert.equal(u.projectedMinutes, 310);
  assert.throws(() => monthRange('2026-13', now));
  assert.throws(() => monthRange('Oct', now));
});

test('usage line and progress bar formats', () => {
  assert.equal(usageLine({ minutesUsed: 312.4, overageMinutes: 0, costSoFarUsd: 0 }), 'Cloud Build: 312 / 2,500 free min this month (12%)');
  assert.equal(progressBar(0.5, 10), '[#####-----]');
  assert.equal(progressBar(2, 4), '[####]');
});

test('Artifact Registry storage against 0.5 GiB free', () => {
  assert.equal(arStorageSummary(100 * 1024 ** 2).estMonthlyUsd, 0);
  const over = arStorageSummary(1.5 * 1024 ** 3);
  assert.equal(over.overBytes, 1024 ** 3);
  assert.equal(over.estMonthlyUsd, 0.1);
  assert.equal(over.percentOfFree, 300);
});

test('fetchBuildTotals pages through listBuildsAsync with a create_time filter', async () => {
  let request;
  const cloudBuild = {
    async *listBuildsAsync(req, options) {
      request = req;
      assert.deepEqual(options, { autoPaginate: false }, 'no AutopaginateTrueWarning');
      yield build('a', '2026-10-03T00:00:00Z', 120);
      yield build('b', '2026-10-04T00:00:00Z', 60);
    },
  };
  const range = monthRange('2026-10', new Date('2026-10-15T00:00:00Z'));
  const totals = await fetchBuildTotals({ cloudBuild, project: 'p', region: 'r', range });
  assert.equal(totals.seconds, 180);
  assert.equal(request.parent, 'projects/p/locations/r');
  assert.equal(request.filter, 'create_time>="2026-10-01T00:00:00+00:00" AND create_time<"2026-11-01T00:00:00+00:00"');
});

test('cache: incremental update after each build, no double counting, month rollover', () => {
  const home = tempTree({});
  const now = new Date('2026-10-16T12:00:00Z');
  const range = monthRange(undefined, now);
  writeUsageCache(home, cacheFromTotals({ totals: { seconds: 600, otherSeconds: 0, builds: 3, ids: ['x'] }, range, project: 'p', region: 'r', now }));

  let cache = recordBuild(readUsageCache(home), { buildId: 'n1', build: build('n1', '2026-10-16T11:00:00Z', 120), project: 'p', region: 'r', now });
  assert.equal(cache.seconds, 720);
  assert.equal(cache.builds, 4);
  assert.equal(cache.partial, false);
  cache = recordBuild(cache, { buildId: 'n1', build: build('n1', '2026-10-16T11:00:00Z', 120), project: 'p', region: 'r', now });
  assert.equal(cache.seconds, 720, 'same build is not counted twice');
  writeUsageCache(home, cache);

  const summary = summaryFromCache(readUsageCache(home), { now, project: 'p' });
  assert.equal(summary.minutesUsed, 12);
  assert.equal(summary.line, 'Cloud Build: 12 / 2,500 free min this month (0%)');
  assert.equal(summaryFromCache(readUsageCache(home), { now, project: 'other' }), null);

  const nextMonth = new Date('2026-11-01T00:30:00Z');
  const rolled = recordBuild(cache, { buildId: 'n2', build: build('n2', '2026-11-01T00:00:00Z', 60), project: 'p', region: 'r', now: nextMonth });
  assert.equal(rolled.month, '2026-11');
  assert.equal(rolled.seconds, 60);
  assert.equal(rolled.partial, true);
  assert.match(summaryFromCache(rolled, { now: nextMonth }).line, /\(run `dockeriser usage` for the full month\)$/);
});

test('first build with no cache shows the minutes of that build, not 0', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const cache = recordBuild(null, { buildId: 'b', build: build('b', '2026-10-16T11:59:00Z', 11), project: 'p', region: 'r', now });
  assert.equal(summaryFromCache(cache, { now }).line, 'Cloud Build: 0.2 / 2,500 free min this month (0%) (run `dockeriser usage` for the full month)');
  assert.equal(usageLine({ minutesUsed: 9.96, overageMinutes: 0 }), 'Cloud Build: 10 / 2,500 free min this month (0%)');
  assert.equal(usageLine({ minutesUsed: 3, overageMinutes: 0 }), 'Cloud Build: 3 / 2,500 free min this month (0%)');
});
