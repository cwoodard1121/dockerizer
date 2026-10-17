/**
 * Build-minute and storage usage estimates, plus the small local cache that keeps the
 * "x / 2,500 free min" line fresh after every build without an API call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';
import { mapGoogleError } from './errors.js';
import { AR_FREE_BYTES, AR_PRICE_PER_GIB_MONTH_USD, BILLING_URL, BUILD_PRICE_PER_MINUTE_USD, FREE_BUILD_MINUTES } from './pricing.js';
import { formatBytes } from './output.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_IDS_KEPT = 200;

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const num = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => `$${n.toFixed(2)}`;
/** Minutes for the one-line summary: one decimal below 10 so a short build doesn't read as 0. */
const minutes = (n) => (n > 0 && n < 9.95 ? n.toFixed(1).replace(/\.0$/, '') : num(n));

/**
 * Calendar month in UTC.
 * @param {string|undefined} month "YYYY-MM", or undefined for the month containing `now`.
 * @param {Date} now
 * @returns {{month: string, start: Date, end: Date, daysInMonth: number, isCurrent: boolean}}
 */
export function monthRange(month, now) {
  let year;
  let index;
  if (month) {
    const m = String(month).match(/^(\d{4})-(\d{2})$/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`--month "${month}" must look like YYYY-MM`);
    [year, index] = [Number(m[1]), Number(m[2]) - 1];
  } else {
    [year, index] = [now.getUTCFullYear(), now.getUTCMonth()];
  }
  const start = new Date(Date.UTC(year, index, 1));
  const end = new Date(Date.UTC(year, index + 1, 1));
  const label = `${year}-${String(index + 1).padStart(2, '0')}`;
  return { month: label, start, end, daysInMonth: (end - start) / DAY_MS, isCurrent: now >= start && now < end };
}

/** Seconds since epoch from a protobuf Timestamp (seconds may be a string). */
function tsSeconds(ts) {
  if (!ts || ts.seconds === undefined || ts.seconds === null) return undefined;
  return Number(ts.seconds) + (ts.nanos || 0) / 1e9;
}

/**
 * Billable seconds of one build: start to finish. Builds that never started or have not
 * finished return null and are not counted.
 * @param {object} build
 * @returns {number|null}
 */
export function buildSeconds(build) {
  const start = tsSeconds(build?.startTime);
  const finish = tsSeconds(build?.finishTime);
  if (start === undefined || finish === undefined || finish < start) return null;
  return finish - start;
}

/**
 * True when the build ran on the free-tier machine (default e2-standard-2, default pool).
 * @param {object} build
 * @returns {boolean}
 */
export function isFreeTierBuild(build) {
  const machine = build?.options?.machineType;
  const pool = build?.options?.pool?.name || build?.options?.workerPool;
  const defaultMachine = !machine || machine === 'UNSPECIFIED' || machine === 0;
  return defaultMachine && !pool;
}

/**
 * Add up builds.
 * @param {object[]} builds
 * @returns {{seconds: number, otherSeconds: number, builds: number, ids: string[]}}
 */
export function aggregateBuilds(builds) {
  const totals = { seconds: 0, otherSeconds: 0, builds: 0, ids: [] };
  for (const build of builds) {
    const secs = buildSeconds(build);
    if (secs === null) continue;
    if (isFreeTierBuild(build)) {
      totals.seconds += secs;
      totals.builds += 1;
    } else {
      totals.otherSeconds += secs;
    }
    if (build.id) totals.ids.push(build.id);
  }
  return totals;
}

/**
 * Turn raw totals into the usage summary (projection, overage, cost).
 * @param {{seconds: number, otherSeconds?: number, builds: number}} totals
 * @param {ReturnType<typeof monthRange>} range
 * @param {Date} now
 * @returns {object}
 */
export function projectUsage(totals, range, now) {
  const minutes = totals.seconds / 60;
  const elapsedDays = range.isCurrent ? Math.max((now - range.start) / DAY_MS, 1 / 24) : range.daysInMonth;
  const perDay = minutes / elapsedDays;
  const projected = range.isCurrent ? perDay * range.daysInMonth : minutes;
  const over = Math.max(0, minutes - FREE_BUILD_MINUTES);
  const projectedOver = Math.max(0, projected - FREE_BUILD_MINUTES);

  let crossDate = null;
  if (minutes < FREE_BUILD_MINUTES && range.isCurrent && perDay > 0) {
    const when = new Date(range.start.getTime() + (FREE_BUILD_MINUTES / perDay) * DAY_MS);
    if (when < range.end) crossDate = when.toISOString().slice(0, 10);
  }
  return {
    month: range.month,
    freeMinutes: FREE_BUILD_MINUTES,
    minutesUsed: round(minutes),
    minutesLeft: round(Math.max(0, FREE_BUILD_MINUTES - minutes)),
    percent: round((minutes / FREE_BUILD_MINUTES) * 100, 1),
    builds: totals.builds,
    avgMinutesPerBuild: totals.builds ? round(minutes / totals.builds) : 0,
    minutesPerDay: round(perDay),
    projectedMinutes: round(projected),
    crossDate,
    alreadyOver: minutes >= FREE_BUILD_MINUTES,
    overageMinutes: round(over),
    costSoFarUsd: round(over * BUILD_PRICE_PER_MINUTE_USD),
    projectedCostUsd: round(projectedOver * BUILD_PRICE_PER_MINUTE_USD),
    otherMachineMinutes: round((totals.otherSeconds || 0) / 60),
    pricePerMinuteUsd: BUILD_PRICE_PER_MINUTE_USD,
    billingUrl: BILLING_URL,
  };
}

/**
 * Artifact Registry storage against the free allowance.
 * @param {number} sizeBytes
 * @returns {{sizeBytes: number, freeBytes: number, overBytes: number, percentOfFree: number, estMonthlyUsd: number}}
 */
export function arStorageSummary(sizeBytes) {
  const overBytes = Math.max(0, sizeBytes - AR_FREE_BYTES);
  return {
    sizeBytes,
    freeBytes: AR_FREE_BYTES,
    overBytes,
    percentOfFree: round((sizeBytes / AR_FREE_BYTES) * 100, 1),
    estMonthlyUsd: round((overBytes / 1024 ** 3) * AR_PRICE_PER_GIB_MONTH_USD),
  };
}

/**
 * Fetch and add up every build in a month (all pages).
 * @param {object} opts
 * @param {import('@google-cloud/cloudbuild').CloudBuildClient} opts.cloudBuild
 * @param {string} opts.project
 * @param {string} opts.region
 * @param {ReturnType<typeof monthRange>} opts.range
 */
export async function fetchBuildTotals({ cloudBuild, project, region, range }) {
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const filter = `create_time>="${iso(range.start)}" AND create_time<"${iso(range.end)}"`;
  const builds = [];
  try {
    for await (const build of cloudBuild.listBuildsAsync({ projectId: project, parent: `projects/${project}/locations/${region}`, filter, pageSize: 100 }, { autoPaginate: false })) {
      builds.push(build);
    }
  } catch (err) {
    throw mapGoogleError(err, { project, region, action: 'list this month\'s builds' });
  }
  return aggregateBuilds(builds);
}

/**
 * Size of the Artifact Registry repo (Repository.sizeBytes).
 * @param {object} opts
 * @param {{request: (o: {url: string}) => Promise<{data: any}>}} opts.auth GoogleAuth-like client.
 * @param {string} opts.project
 * @param {string} opts.region
 * @param {string} opts.repo
 * @returns {Promise<number>}
 */
export async function fetchRepoSize({ auth, project, region, repo }) {
  const res = await auth.request({ url: `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${region}/repositories/${repo}` });
  return Number(res.data?.sizeBytes || 0);
}

/**
 * The one-line summary printed after builds and by status.
 * @param {{minutesUsed: number, overageMinutes: number, costSoFarUsd: number}} u
 * @param {{partial?: boolean}} [opts]
 * @returns {string}
 */
export function usageLine(u, { partial = false } = {}) {
  const base = `Cloud Build: ${minutes(u.minutesUsed)} / ${num(FREE_BUILD_MINUTES)} free min this month`;
  const tail = partial ? ' (run `dockeriser usage` for the full month)' : '';
  if (u.overageMinutes > 0) return `${base}, over by ${num(u.overageMinutes)} min ≈ ${usd(u.costSoFarUsd)}${tail}`;
  return `${base} (${Math.round((u.minutesUsed / FREE_BUILD_MINUTES) * 100)}%)${tail}`;
}

/** Text progress bar. */
export function progressBar(fraction, width = 30) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

/**
 * Full human report for `dockeriser usage`.
 * @param {object} u Summary from projectUsage, plus project/region/repo/arStorage.
 * @returns {string[]}
 */
export function formatUsageReport(u) {
  const monthName = new Date(`${u.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lines = [
    `Cloud Build usage, ${monthName} (project ${u.project}, region ${u.region})`,
    `  ${progressBar(u.minutesUsed / FREE_BUILD_MINUTES)}  ${u.minutesUsed.toFixed(1)} / ${num(FREE_BUILD_MINUTES)} free min (${u.percent}%)`,
    `  minutes left:         ${u.minutesLeft.toFixed(1)}`,
    `  builds:               ${u.builds} (avg ${u.avgMinutesPerBuild.toFixed(1)} min each)`,
    `  rate so far:          ${u.minutesPerDay.toFixed(1)} min/day`,
    `  projected month end:  ${num(u.projectedMinutes)} min`,
  ];
  if (u.alreadyOver) lines.push('  free minutes:         used up this month');
  else lines.push(`  would hit 2,500 on:   ${u.crossDate || 'not this month at this rate'}`);
  if (u.overageMinutes > 0 || u.projectedCostUsd > 0) {
    lines.push(`  over the free tier:   ${num(u.overageMinutes)} min ≈ ${usd(u.costSoFarUsd)} so far; projected ≈ ${usd(u.projectedCostUsd)} by month end (at $${u.pricePerMinuteUsd}/min)`);
  }
  if (u.otherMachineMinutes > 0) {
    lines.push(`  other machines:       ${u.otherMachineMinutes.toFixed(1)} min on non-default machines/pools (not free, priced differently)`);
  }
  if (u.arStorage) {
    const a = u.arStorage;
    const over = a.overBytes > 0 ? `, over by ${formatBytes(a.overBytes)} ≈ ${usd(a.estMonthlyUsd)}/month` : '';
    lines.push(`Artifact Registry (${u.repo}): ${formatBytes(a.sizeBytes)} of 0.5 GB free (${a.percentOfFree}%)${over}`);
    if (a.overBytes > 0) lines.push('  old images: `dockeriser cleanup` keeps the 20 newest versions of each image and deletes the rest (also daily, by the repo policy)');
  } else if (u.arStorageError) {
    lines.push(`Artifact Registry (${u.repo}): size unavailable (${u.arStorageError})`);
  }
  lines.push(
    '',
    `These are estimates from build history in this project and region only. The ${num(FREE_BUILD_MINUTES)} free minutes are`,
    'shared across your whole billing account, so builds in other projects count too.',
    `Your real bill: ${BILLING_URL}`,
  );
  return lines;
}

// ---------- cache ----------

/** Path of the usage cache file. */
export function cachePath(homeDir) {
  return path.join(configDir(homeDir), 'usage-cache.json');
}

/**
 * Read the cache; null when missing or unreadable.
 * @param {string} homeDir
 * @returns {object|null}
 */
export function readUsageCache(homeDir) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(homeDir), 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * Write the cache (creates ~/.dockeriser if needed).
 * @param {string} homeDir
 * @param {object} cache
 */
export function writeUsageCache(homeDir, cache) {
  fs.mkdirSync(configDir(homeDir), { recursive: true });
  fs.writeFileSync(cachePath(homeDir), `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * Cache contents after a full API refresh.
 * @param {object} opts
 * @returns {object}
 */
export function cacheFromTotals({ totals, range, project, region, now, arStorage = null }) {
  return {
    version: 1,
    month: range.month,
    project,
    region,
    seconds: totals.seconds,
    otherSeconds: totals.otherSeconds || 0,
    builds: totals.builds,
    countedIds: totals.ids.slice(-CACHE_IDS_KEPT),
    partial: false,
    fetchedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    arStorage,
  };
}

/**
 * Add one finished build to the cache. Starts a fresh (partial) month when the month,
 * project or region changed. A build already counted is ignored.
 * @param {object|null} cache
 * @param {{buildId: string, build: object, project: string, region: string, now: Date}} opts
 * @returns {object} The new cache.
 */
export function recordBuild(cache, { buildId, build, project, region, now }) {
  const month = monthRange(undefined, now).month;
  const fresh = !cache || cache.month !== month || cache.project !== project || cache.region !== region;
  const next = fresh
    ? { version: 1, month, project, region, seconds: 0, otherSeconds: 0, builds: 0, countedIds: [], partial: true, fetchedAt: null, arStorage: null }
    : { ...cache, countedIds: [...(cache.countedIds || [])] };
  next.updatedAt = now.toISOString();
  if (next.countedIds.includes(buildId)) return next;
  const secs = buildSeconds(build);
  if (secs === null) return next;
  if (isFreeTierBuild(build)) {
    next.seconds += secs;
    next.builds += 1;
  } else {
    next.otherSeconds += secs;
  }
  next.countedIds = [...next.countedIds, buildId].slice(-CACHE_IDS_KEPT);
  return next;
}

/**
 * Usage summary from the cache (no network). Null when the cache is for another month/project.
 * @param {object|null} cache
 * @param {{now: Date, project?: string}} opts
 * @returns {object|null}
 */
export function summaryFromCache(cache, { now, project }) {
  if (!cache) return null;
  const range = monthRange(undefined, now);
  if (cache.month !== range.month || (project && cache.project !== project)) return null;
  const summary = projectUsage(cache, range, now);
  return { ...summary, source: 'cache', partial: Boolean(cache.partial), updatedAt: cache.updatedAt, line: usageLine(summary, { partial: cache.partial }) };
}
