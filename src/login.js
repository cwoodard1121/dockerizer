/**
 * `dockeriser login`: work out the next sign-in step(s) and print only those.
 * Never opens a browser and never prompts.
 */

import { spawnSync } from 'node:child_process';
import { runDoctor } from './doctor.js';
import { EXIT } from './errors.js';
import { getOfflineStatus, nextSteps } from './status.js';

/**
 * Ask gcloud which account is active.
 * @param {string} gcloudPath
 * @param {{spawn?: typeof spawnSync, platform?: string}} [opts]
 * @returns {{loggedIn: boolean|undefined, account?: string}} loggedIn is undefined when gcloud could not be asked.
 */
export function gcloudAccount(gcloudPath, { spawn = spawnSync, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const res = spawn(win ? `"${gcloudPath}"` : gcloudPath, ['auth', 'list', '--format=json'], {
    shell: win, // gcloud is a .cmd script on Windows
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) return { loggedIn: undefined };
  try {
    const active = JSON.parse(res.stdout || '[]').find((a) => a.status === 'ACTIVE');
    return active ? { loggedIn: true, account: active.account } : { loggedIn: false };
  } catch {
    return { loggedIn: undefined };
  }
}

/**
 * Run the sign-in checks.
 * @param {object} opts
 * @param {Record<string, string|undefined>} opts.env
 * @param {string} opts.homeDir
 * @param {Date} opts.now
 * @param {Record<string, string|undefined>} [opts.flags]
 * @param {Function} opts.createClients
 * @param {typeof spawnSync} [opts.spawn]
 * @returns {Promise<{ready: boolean, exitCode: number, identity?: string, project?: string,
 *   gcloudAccount?: string, steps: ReturnType<typeof nextSteps>, failedChecks: object[], usage: object|null}>}
 */
export async function runLogin({ env, homeDir, now, flags = {}, createClients, spawn }) {
  const status = getOfflineStatus({ env, homeDir, now, flags });
  const gcloud = status.gcloud.installed ? gcloudAccount(status.gcloud.path, { spawn }) : { loggedIn: undefined };
  const base = { project: status.project, gcloudAccount: gcloud.account, usage: status.usage, failedChecks: [] };

  if (!status.ready) {
    const steps = nextSteps(status, { gcloudLoggedIn: status.gcloud.installed ? gcloud.loggedIn : false });
    return { ...base, ready: false, exitCode: status.configured ? EXIT.AUTH : EXIT.CONFIG, steps };
  }

  const { checks, exitCode } = await runDoctor({ flags, env, homeDir, createClients });
  const failedChecks = checks.filter((c) => c.status === 'fail');
  if (failedChecks.length) {
    const steps = failedChecks.map((c) => ({ title: `${c.name}: ${c.detail}`, commands: [], note: c.fix }));
    steps.push({ title: 'Then check again', commands: [`node "${status.cliPath}" login`] });
    return { ...base, ready: false, exitCode, steps, failedChecks };
  }
  const signIn = checks.find((c) => c.name === 'Google sign-in');
  const identity = signIn?.detail.match(/signed in as (\S+)/)?.[1] || status.serviceAccount;
  return { ...base, ready: true, exitCode: EXIT.OK, identity, steps: [] };
}
