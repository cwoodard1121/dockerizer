/**
 * The CI spend ledger: one JSON object per calendar month (UTC) in the logs bucket,
 * `ci/ledger-YYYY-MM.json`, listing every `dockeriser ci` run with its estimated cost. Every
 * machine and account reads and writes the same object, so the cap counts everyone's runs. Writes
 * use a generation precondition, so two runs finishing together never lose an entry. Rewriting the
 * object resets its age, so the bucket's 30-day auto-delete only drops a month with no runs for 30 days.
 * A summary is mirrored to ~/.dockeriser/ci-cache.json for the offline status and the session hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';
import { CI_MONTHLY_CAP_USD, CI_PACE_FROM_DAY, CI_RUNAWAY_FACTOR, CI_RUNAWAY_MIN_SPENT_USD } from './pricing.js';
import { monthRange } from './usage.js';
import { sleep as realSleep } from './logs.js';

const BASE = 'https://storage.googleapis.com';

/** Object name of a month's ledger. */
export const ledgerObject = (month) => `ci/ledger-${month}.json`;

/** A ledger with no runs. */
export function emptyLedger(month) {
  return { month, capUsd: CI_MONTHLY_CAP_USD, override: false, disabled: null, runs: [] };
}

const money = (n) => `$${n.toFixed(2)}`;
const round4 = (n) => Math.round(n * 10000) / 10000;

/** Estimated USD of every run in the ledger. */
export function spentUsd(ledger) {
  return round4(ledger.runs.reduce((n, r) => n + (Number(r.costUsd) || 0), 0));
}

/**
 * Whether CI may run now. Off once the month's spend reaches the cap; from day CI_PACE_FROM_DAY
 * (unless the owner set `override`), also off when the pace so far projects past the cap.
 * @param {{runs: Array<{costUsd: number}>, override?: boolean, disabled?: {reason: string}|null}} ledger
 * @param {Date} now
 * @returns {{ok: boolean, reason: string|null, spentUsd: number, projectedUsd: number, capUsd: number}}
 */
export function evaluateCap(ledger, now) {
  const range = monthRange(undefined, now);
  const spent = spentUsd(ledger);
  // spent x daysInMonth / dayOfMonth: today counts as a whole day.
  const projected = round4((spent / now.getUTCDate()) * range.daysInMonth);
  const base = { spentUsd: spent, projectedUsd: projected, capUsd: CI_MONTHLY_CAP_USD };
  if (ledger.disabled) return { ok: false, reason: ledger.disabled.reason, ...base };
  if (spent >= CI_MONTHLY_CAP_USD) {
    return { ok: false, reason: `${money(spent)} spent, the ${money(CI_MONTHLY_CAP_USD)} monthly cap`, ...base };
  }
  // Runaway: before the pace check starts, a pace past 3x the cap (once $1 is spent) is a loop, not use.
  if (!ledger.override && spent >= CI_RUNAWAY_MIN_SPENT_USD && projected > CI_MONTHLY_CAP_USD * CI_RUNAWAY_FACTOR) {
    return { ok: false, reason: `runaway pace: ${money(projected)} by month end, over ${CI_RUNAWAY_FACTOR}x the ${money(CI_MONTHLY_CAP_USD)} monthly cap`, ...base };
  }
  if (!ledger.override && now.getUTCDate() >= CI_PACE_FROM_DAY && projected > CI_MONTHLY_CAP_USD) {
    return { ok: false, reason: `on pace for ${money(projected)} by month end, over the ${money(CI_MONTHLY_CAP_USD)} monthly cap`, ...base };
  }
  return { ok: true, reason: null, ...base };
}

function httpStatus(err) {
  return err?.response?.status ?? err?.code;
}

/**
 * Read a month's ledger and its generation (0 when it does not exist yet).
 * @param {{authClient: {request: Function}}} storage
 * @param {string} bucket
 * @param {string} month YYYY-MM
 * @returns {Promise<{ledger: object, generation: number}>}
 */
export async function readLedger(storage, bucket, month) {
  const url = `${BASE}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(ledgerObject(month))}`;
  let generation;
  try {
    const meta = await storage.authClient.request({ url, retry: false });
    generation = Number(meta.data.generation);
  } catch (err) {
    if (httpStatus(err) === 404) return { ledger: emptyLedger(month), generation: 0 };
    throw err;
  }
  const res = await storage.authClient.request({ url: `${url}?alt=media&generation=${generation}`, responseType: 'arraybuffer', retry: false });
  let ledger;
  try {
    ledger = JSON.parse(Buffer.from(res.data).toString('utf8'));
  } catch {
    ledger = null;
  }
  if (!ledger || !Array.isArray(ledger.runs)) ledger = emptyLedger(month); // unreadable: start over rather than block CI
  return { ledger: { ...emptyLedger(month), ...ledger, capUsd: CI_MONTHLY_CAP_USD }, generation };
}

/**
 * Write a ledger only if the stored generation is still `generation` (0: only if absent).
 * Rejects with HTTP status 412 when someone else wrote first.
 */
export async function writeLedger(storage, bucket, ledger, generation) {
  const url = `${BASE}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(ledgerObject(ledger.month))}&ifGenerationMatch=${generation}`;
  await storage.authClient.request({ url, method: 'POST', data: `${JSON.stringify(ledger, null, 2)}\n`, headers: { 'Content-Type': 'application/json' }, retry: false });
}

/**
 * Read, change and write a month's ledger, starting over when another writer got there first.
 * @param {object} storage
 * @param {string} bucket
 * @param {string} month
 * @param {(ledger: object) => void} mutate Changes the ledger in place.
 * @param {{attempts?: number, sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<object>} The ledger as written.
 */
export async function updateLedger(storage, bucket, month, mutate, { attempts = 6, sleep = realSleep } = {}) {
  for (let i = 1; ; i++) {
    const { ledger, generation } = await readLedger(storage, bucket, month);
    mutate(ledger);
    try {
      await writeLedger(storage, bucket, ledger, generation);
      return ledger;
    } catch (err) {
      if (httpStatus(err) !== 412 || i >= attempts) throw err;
      await sleep(200 * i + Math.floor(Math.random() * 200));
    }
  }
}

/**
 * What status, the hook and the JSON result show about CI this month.
 * @returns {{month: string, spentUsd: number, capUsd: number, runs: number, disabled: object|null, override: boolean, line: string}}
 */
export function ciSummary(ledger, now) {
  const cap = evaluateCap({ ...ledger, disabled: null }, now);
  const summary = {
    month: ledger.month,
    spentUsd: cap.spentUsd,
    projectedUsd: cap.projectedUsd,
    capUsd: CI_MONTHLY_CAP_USD,
    runs: ledger.runs.length,
    disabled: ledger.disabled || null,
    override: Boolean(ledger.override),
  };
  return { ...summary, line: ciLine(summary) };
}

/** One line: spend against the cap, or that CI is off and why. */
export function ciLine(s) {
  if (s.disabled) return `CI is OFF for ${s.month} (${s.disabled.reason}); it turns back on next month`;
  return `CI: ${money(s.spentUsd)} / ${money(s.capUsd)} this month (${s.runs} run${s.runs === 1 ? '' : 's'})`;
}

/** Where the offline copy of the summary lives. */
export function ciCachePath(homeDir, env = process.env) {
  return path.join(configDir(homeDir, env), 'ci-cache.json');
}

/** The offline copy, or null. */
export function readCiCache(homeDir, env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(ciCachePath(homeDir, env), 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Save the offline copy (creates the folder). */
export function writeCiCache(homeDir, summary, env = process.env) {
  const file = ciCachePath(homeDir, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** The cached summary if it is for this month, else null. */
export function summaryFromCiCache(cache, now) {
  if (!cache || cache.month !== monthRange(undefined, now).month) return null;
  return { ...cache, line: ciLine(cache) };
}
