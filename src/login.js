/**
 * `dockeriser login`: work out the next sign-in step(s) and print only those.
 * Never opens a browser and never prompts. The setup script does the browser sign-ins, so the
 * answer is nearly always "run setup/setup.ps1" (with the real project ID when it is known).
 */

import { runDoctor } from './doctor.js';
import { EXIT } from './errors.js';
import { getOfflineStatus, nextSteps, setupCommand } from './status.js';

/**
 * Run the sign-in checks: local first (instant), then the online checks once config and
 * credentials exist.
 * @param {object} opts
 * @param {Record<string, string|undefined>} opts.env
 * @param {string} opts.homeDir
 * @param {Date} opts.now
 * @param {Record<string, string|undefined>} [opts.flags]
 * @param {Function} opts.createClients
 * @returns {Promise<{ready: boolean, exitCode: number, identity?: string, project?: string,
 *   steps: ReturnType<typeof nextSteps>, failedChecks: object[], usage: object|null}>}
 */
export async function runLogin({ env, homeDir, now, flags = {}, createClients }) {
  const status = getOfflineStatus({ env, homeDir, now, flags });
  const base = { project: status.project, usage: status.usage, failedChecks: [] };

  if (!status.ready) {
    return { ...base, ready: false, exitCode: status.configured ? EXIT.AUTH : EXIT.CONFIG, steps: nextSteps(status) };
  }

  const { checks, exitCode } = await runDoctor({ flags, env, homeDir, createClients });
  const failedChecks = checks.filter((c) => c.status === 'fail');
  if (failedChecks.length) {
    const steps = failedChecks.map((c) => ({ title: `${c.name}: ${c.detail}`, commands: [], note: c.fix }));
    steps.push({ title: 'Re-running the setup script fixes most of these (safe to re-run)', commands: [setupCommand(status)] });
    return { ...base, ready: false, exitCode, steps, failedChecks };
  }
  const signIn = checks.find((c) => c.name === 'Google sign-in');
  const identity = signIn?.detail.match(/signed in as (\S+)/)?.[1] || status.serviceAccount;
  return { ...base, ready: true, exitCode: EXIT.OK, identity, steps: [] };
}
