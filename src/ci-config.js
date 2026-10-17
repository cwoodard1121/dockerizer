/**
 * The `ci` section of dockeriser.json: the gate steps `dockeriser ci` runs on a spot VM, and the
 * machine they run on. Also the machine's price, from the constants in pricing.js.
 *
 * "ci": { "steps": ["npm ci", "npm run check"], "machine": "e2-standard-4", "diskGb": 40,
 *         "timeout": "60m", "node": "24.14.0", "env": {"KEY": "public value"}, "docker": true }
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { parseTimeout } from './build.js';
import {
  CI_PD_BALANCED_GIB_MONTH_USD, CI_SPOT_E2_CORE_HOUR_USD, CI_SPOT_E2_RAM_GIB_HOUR_USD, CI_SPOT_IP_HOUR_USD,
} from './pricing.js';

export const CI_DEFAULTS = Object.freeze({ machine: 'e2-standard-4', diskGb: 40, timeout: '60m' });
const MAX_STEPS = 50;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HOURS_PER_MONTH = 730;

/**
 * vCPUs and GiB of an E2 machine type with a fixed shape, or null.
 * @param {string} machine e.g. e2-standard-4
 * @returns {{vcpu: number, ramGib: number}|null}
 */
export function machineShape(machine) {
  const m = /^e2-(standard|highmem|highcpu)-(\d+)$/.exec(String(machine));
  if (!m) return null;
  const vcpu = Number(m[2]);
  if (![2, 4, 8, 16, 32].includes(vcpu) || (m[1] === 'highmem' && vcpu > 16)) return null;
  const perCpu = { standard: 4, highmem: 8, highcpu: 1 }[m[1]];
  return { vcpu, ramGib: vcpu * perCpu };
}

/**
 * Estimated USD per hour of one CI VM: spot E2 cores and memory, the boot disk and the IP.
 * @param {string} machine
 * @param {number} diskGb
 */
export function hourlyUsd(machine, diskGb) {
  const shape = machineShape(machine);
  if (!shape) throw new ConfigError(`No price for machine type "${machine}".`);
  return shape.vcpu * CI_SPOT_E2_CORE_HOUR_USD + shape.ramGib * CI_SPOT_E2_RAM_GIB_HOUR_USD
    + (diskGb * CI_PD_BALANCED_GIB_MONTH_USD) / HOURS_PER_MONTH + CI_SPOT_IP_HOUR_USD;
}

/**
 * Estimated USD for a VM that existed for `seconds`.
 * @param {number} seconds
 * @param {string} machine
 * @param {number} diskGb
 */
export function runCostUsd(seconds, machine, diskGb) {
  return (Math.max(0, seconds) / 3600) * hourlyUsd(machine, diskGb);
}

/**
 * Validate the `ci` section and fill in the defaults.
 * @param {unknown} raw
 * @param {string} file For messages.
 * @returns {{steps: string[], machine: string, diskGb: number, timeout: string, timeoutSec: number,
 *   node: string|null, env: Record<string, string>, docker: boolean}}
 */
export function normaliseCi(raw, file) {
  if (raw === undefined || raw === null) {
    throw new ConfigError(`${file} has no "ci" section, so dockeriser does not know which gate to run.`, {
      fix: 'Run `dockeriser ci init` to write one from the GitHub workflow or package.json, then check the steps.',
    });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`"ci" in ${file} must be an object.`);
  const steps = Array.isArray(raw.steps) ? raw.steps.map((s) => (typeof s === 'string' ? s.trim() : '')) : [];
  if (!steps.length || steps.length > MAX_STEPS || steps.some((s) => !s)) {
    throw new ConfigError(`"ci.steps" in ${file} must be a list of 1 to ${MAX_STEPS} shell commands.`, { fix: 'e.g. "steps": ["npm ci", "npm run check"]' });
  }
  const machine = raw.machine === undefined ? CI_DEFAULTS.machine : String(raw.machine).trim();
  if (!machineShape(machine)) {
    throw new ConfigError(`"ci.machine" "${machine}" is not a supported E2 machine type.`, {
      fix: 'Use an E2 machine with a fixed shape: e2-standard-2|4|8|16|32, e2-highmem-2|4|8|16, e2-highcpu-2|4|8|16|32 (dockeriser only has E2 prices).',
    });
  }
  const diskGb = raw.diskGb === undefined ? CI_DEFAULTS.diskGb : Number(raw.diskGb);
  if (!Number.isInteger(diskGb) || diskGb < 20 || diskGb > 500) throw new ConfigError(`"ci.diskGb" must be a whole number from 20 to 500 (got ${JSON.stringify(raw.diskGb)}).`);
  const timeout = raw.timeout === undefined ? CI_DEFAULTS.timeout : String(raw.timeout);
  let timeoutSec;
  try {
    timeoutSec = parseTimeout(timeout);
  } catch {
    throw new ConfigError(`"ci.timeout" "${timeout}" is not a duration from 1s to 24h.`, { fix: 'e.g. "45m" or "1h30m".' });
  }
  const env = {};
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw new ConfigError(`"ci.env" in ${file} must be an object of NAME: value.`);
    for (const [k, v] of Object.entries(raw.env)) {
      if (!ENV_NAME.test(k)) throw new ConfigError(`"ci.env" name "${k}" must be upper case letters, digits and _.`);
      env[k] = String(v);
    }
  }
  const node = raw.node === undefined || raw.node === null ? null : String(raw.node).trim().replace(/^v/, '') || null;
  return { steps, machine, diskGb, timeout, timeoutSec, node, env, docker: raw.docker !== false };
}

/**
 * The Node version to install on the VM: `ci.node`, else `.node-version`, else `.nvmrc`, else "lts".
 * An exact version (24.14.0), a major (24) or "lts".
 * @param {string} root
 * @param {{node: string|null}} ci
 */
export function nodeVersion(root, ci) {
  if (ci.node) return ci.node;
  for (const f of ['.node-version', '.nvmrc']) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8').trim();
    } catch {
      continue;
    }
    const v = text.split(/\r?\n/)[0].trim().replace(/^v/, '');
    if (/^\d+(\.\d+){0,2}$/.test(v)) return v;
    if (/^lts/i.test(v) || v === 'node') return 'lts';
  }
  return 'lts';
}
