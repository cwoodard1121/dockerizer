/**
 * Offline status and "what to do next" sign-in steps. No network calls and no Google
 * libraries here: the Claude Code SessionStart hook imports this file directly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, resolveCredentials } from './config.js';
import { readUsageCache, summaryFromCache } from './usage.js';

/** Root of this dockeriser checkout. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CLI_PATH = path.join(REPO_ROOT, 'bin', 'dockeriser.js');
export const SETUP_SCRIPT = path.join(REPO_ROOT, 'setup', 'setup.ps1');
export const SETUP_GUIDE = path.join(REPO_ROOT, 'docs', 'SETUP.md');

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
 */
export function getOfflineStatus({ env = process.env, homeDir = os.homedir(), now = new Date(), platform = process.platform, flags = {} } = {}) {
  const status = { configured: false, ready: false, cliPath: CLI_PATH, setupScript: SETUP_SCRIPT };
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
 * The sign-in steps still needed, in order, with copy-paste commands.
 * @param {ReturnType<typeof getOfflineStatus>} status
 * @param {{gcloudLoggedIn?: boolean}} [opts] Unknown (undefined) when gcloud was not asked.
 * @returns {Array<{title: string, commands: string[], note?: string}>}
 */
export function nextSteps(status, { gcloudLoggedIn } = {}) {
  if (status.ready) return [];
  const steps = [];
  const needsGcloud = !status.configured || !status.credentials.present;
  if (needsGcloud && !status.gcloud.installed) {
    steps.push({
      title: 'Install the Google Cloud CLI (then open a new terminal so it is on PATH)',
      commands: ['winget install Google.CloudSDK'],
    });
  }
  if (needsGcloud && gcloudLoggedIn !== true) {
    steps.push({
      title: gcloudLoggedIn === false ? 'Sign in to Google (a browser window opens)' : 'Sign in to Google if you have not already (a browser window opens)',
      commands: ['gcloud auth login'],
      note: 'From Claude Code, type it in the prompt as: ! gcloud auth login  (an AI agent cannot do the browser sign-in for you).',
    });
  }
  if (status.configError) {
    steps.push({ title: `Fix the config file: ${status.configError}`, commands: [`notepad "${status.configFile || '%USERPROFILE%\\.dockeriser\\config.json'}"`] });
  } else if (!status.configured) {
    steps.push({
      title: `Set up the Google Cloud project (needs a project with billing linked; guide: ${SETUP_GUIDE})`,
      commands: [`powershell -ExecutionPolicy Bypass -File "${status.setupScript}" -Project <your-project-id>`],
      note: 'Replace <your-project-id> with your project ID. The script is safe to re-run.',
    });
  }
  if (!status.credentials.present || !status.configured) {
    if (status.credentials.error) {
      steps.push({ title: status.credentials.error, commands: [], note: 'Fix the path, or remove the GOOGLE_APPLICATION_CREDENTIALS variable to use gcloud credentials instead.' });
    } else if (!status.credentials.present) {
      const sa = status.serviceAccount || 'dockeriser@<your-project-id>.iam.gserviceaccount.com';
      steps.push({
        title: 'Let dockeriser act as its service account (a browser window opens)',
        commands: [`gcloud auth application-default login --impersonate-service-account=${sa}`],
        note: 'No-browser alternative for a headless box: re-run setup with -CreateKey to save a key file at %USERPROFILE%\\.dockeriser\\key.json.',
      });
    }
  }
  steps.push({ title: 'Check that everything works', commands: [`node "${status.cliPath}" login`] });
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
