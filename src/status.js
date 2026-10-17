/**
 * Offline status and "what to do next" sign-in steps. No network calls and no Google
 * libraries here: the Claude Code SessionStart hook imports this file directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, homeSearch, resolveConfig, resolveCredentials, userHome } from './config.js';
import { readUsageCache, summaryFromCache } from './usage.js';

/** Root of this dockeriser checkout. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CLI_PATH = path.join(REPO_ROOT, 'bin', 'dockeriser.js');
export const SETUP_SCRIPT = path.join(REPO_ROOT, 'setup', 'setup.ps1');

/**
 * Find the gcloud executable without running it (PATH scan plus the default install folders).
 * @param {{env?: Record<string, string|undefined>, platform?: string}} [opts]
 * @returns {string|null}
 */
export function findGcloud({ env = process.env, platform = process.platform } = {}) {
  const names = platform === 'win32' ? ['gcloud.cmd', 'gcloud.exe'] : ['gcloud'];
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    const sdk = ['Google', 'Cloud SDK', 'google-cloud-sdk', 'bin'];
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (base) dirs.push(path.join(base, ...sdk));
    }
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Everything we can know locally: config, credentials file, gcloud presence, cached usage.
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.homeDir]
 * @param {Date} [opts.now]
 * @param {string} [opts.platform]
 * @param {Record<string, string|undefined>} [opts.flags] --project/--region/--repo.
 * @param {string[]} [opts.searched] Config files looked at (default: every place userHome() tries).
 */
export function getOfflineStatus({ env = process.env, homeDir, now = new Date(), platform = process.platform, flags = {}, searched } = {}) {
  if (!searched) searched = homeDir ? [path.join(configDir(homeDir, env), 'config.json')] : homeSearch({ env });
  if (!homeDir) homeDir = userHome({ env });
  const status = { configured: false, ready: false, cliPath: CLI_PATH, setupScript: SETUP_SCRIPT, home: homeDir, searched };
  try {
    const cfg = resolveConfig({ flags, env, homeDir, requireProject: false });
    Object.assign(status, {
      configured: Boolean(cfg.project),
      project: cfg.project || null,
      region: cfg.region,
      repo: cfg.repo,
      serviceAccount: cfg.serviceAccount || null,
      configFile: cfg.configFile,
    });
  } catch (err) {
    status.configError = err.message;
  }
  try {
    const creds = resolveCredentials({ env, homeDir, platform });
    status.credentials = { present: creds.source !== 'none', source: creds.source, path: creds.path || null, type: creds.type || null };
  } catch (err) {
    status.credentials = { present: false, source: 'env', path: env.GOOGLE_APPLICATION_CREDENTIALS || null, error: err.message };
  }
  const gcloud = findGcloud({ env, platform });
  status.gcloud = { installed: Boolean(gcloud), path: gcloud };
  status.usage = summaryFromCache(readUsageCache(homeDir), { now, project: status.project || undefined });
  status.ready = status.configured && status.credentials.present;
  return status;
}

/**
 * The one setup command, with the real project ID when config already has one.
 * @param {ReturnType<typeof getOfflineStatus>} status
 * @returns {string}
 */
export function setupCommand(status) {
  const project = status.project ? ` -Project ${status.project}` : '';
  return `powershell -ExecutionPolicy Bypass -File "${status.setupScript}"${project}`;
}

/**
 * The steps still needed, in order, with copy-paste commands. The setup script does the Google
 * sign-in, project, billing and credentials itself, so it is nearly always the only step.
 * @param {ReturnType<typeof getOfflineStatus>} status
 * @returns {Array<{title: string, commands: string[], note?: string}>}
 */
export function nextSteps(status) {
  if (status.ready) return [];
  const steps = [];
  if (!status.gcloud.installed) {
    steps.push({ title: 'Install the Google Cloud tool, then open a new terminal', commands: ['winget install Google.CloudSDK'] });
  }
  if (status.configError) {
    steps.push({ title: `Fix or delete the settings file: ${status.configError}`, commands: [`notepad "${status.configFile}"`] });
  }
  if (status.credentials.error) {
    steps.push({ title: status.credentials.error, commands: [], note: 'Fix the path, or remove the GOOGLE_APPLICATION_CREDENTIALS variable so the setup script can sign you in instead.' });
  }
  steps.push({
    title: 'Run the setup script (it signs you in to Google in the browser, sets up the project and billing, and checks everything; safe to re-run)',
    commands: [setupCommand(status)],
    note: status.project
      ? 'From Claude Code, type it in the prompt with a leading "!".'
      : 'In a normal terminal it asks which project to use. From Claude Code, type it with a leading "!" and add -Project <your-project-id> (it cannot ask questions there).',
  });
  return steps;
}

/**
 * Plain-text rendering of the steps.
 * @param {ReturnType<typeof nextSteps>} steps
 * @returns {string}
 */
export function formatSteps(steps) {
  return steps
    .map((s, i) => {
      const lines = [`${i + 1}. ${s.title}`, ...s.commands.map((c) => `     ${c}`)];
      if (s.note) lines.push(`   ${s.note}`);
      return lines.join('\n');
    })
    .join('\n');
}
