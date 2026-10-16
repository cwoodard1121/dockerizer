/**
 * Settings resolution: CLI flags > environment variables > ~/.dockeriser/config.json > defaults.
 * Also works out which Google credentials will be used, without reading their contents.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, AuthError } from './errors.js';

export const DEFAULT_REGION = 'northamerica-northeast2';
export const DEFAULT_REPO = 'docker-images';

const FIELDS = [
  { key: 'project', env: 'DOCKERISER_PROJECT' },
  { key: 'region', env: 'DOCKERISER_REGION' },
  { key: 'repo', env: 'DOCKERISER_REPO' },
  { key: 'serviceAccount', env: 'DOCKERISER_SERVICE_ACCOUNT' },
];

/**
 * Folder that holds config.json and (optionally) key.json.
 * @param {string} [homeDir]
 * @returns {string}
 */
export function configDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.dockeriser');
}

/**
 * Read ~/.dockeriser/config.json. Missing file => {}. A UTF-8 BOM (Windows PowerShell) is tolerated.
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new ConfigError(`Could not read ${file}: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (${err.message}).`, {
      fix: 'Fix or delete the file, or re-run setup/setup.ps1 to rewrite it.',
    });
  }
}

/**
 * Resolve project/region/repo/serviceAccount.
 *
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.flags] Values from the command line.
 * @param {Record<string, string|undefined>} [opts.env] Environment (defaults to process.env).
 * @param {string} [opts.homeDir] Home folder (defaults to os.homedir()).
 * @param {boolean} [opts.requireProject=true] Throw ConfigError when no project is found.
 * @returns {{project?: string, region: string, repo: string, serviceAccount?: string,
 *   sources: Record<string, string>, configFile: string}}
 */
export function resolveConfig({ flags = {}, env = process.env, homeDir = os.homedir(), requireProject = true } = {}) {
  const configFile = path.join(configDir(homeDir), 'config.json');
  const file = readConfigFile(configFile);
  const out = { sources: {}, configFile };

  for (const { key, env: envName } of FIELDS) {
    const candidates = [
      [flags[key], 'flag'],
      [env[envName], `env ${envName}`],
      [file[key], 'config file'],
    ];
    const hit = candidates.find(([v]) => typeof v === 'string' && v.trim() !== '');
    if (hit) {
      out[key] = hit[0].trim();
      out.sources[key] = hit[1];
    }
  }

  if (!out.region) [out.region, out.sources.region] = [DEFAULT_REGION, 'default'];
  if (!out.repo) [out.repo, out.sources.repo] = [DEFAULT_REPO, 'default'];

  if (!out.project) {
    if (requireProject) {
      throw new ConfigError('No Google Cloud project is set, so dockeriser does not know where to build or what to check.', {
        fix: `Pass --project <id>, set DOCKERISER_PROJECT, or run setup/setup.ps1 (it writes ${configFile}).`,
      });
    }
    return out;
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(out.project)) {
    throw new ConfigError(`"${out.project}" does not look like a Google Cloud project ID.`, {
      fix: 'Use the project ID (lowercase, e.g. my-project-123), not the display name or number.',
    });
  }
  if (!out.serviceAccount) {
    out.serviceAccount = `dockeriser@${out.project}.iam.gserviceaccount.com`;
    out.sources.serviceAccount = 'default';
  }
  return out;
}

/** Bucket and repo names derived from the project, shared by every module and the setup scripts. */
export function resourceNames({ project, region, repo }) {
  return {
    sourceBucket: `${project}-dockeriser-src`,
    logsBucket: `${project}-dockeriser-logs`,
    registryHost: `${region}-docker.pkg.dev`,
    repoPath: `${region}-docker.pkg.dev/${project}/${repo}`,
  };
}

/**
 * Where gcloud keeps the Application Default Credentials file.
 * @param {Record<string, string|undefined>} env
 * @param {string} homeDir
 * @param {string} platform
 */
function gcloudAdcPath(env, homeDir, platform) {
  if (env.CLOUDSDK_CONFIG) return path.join(env.CLOUDSDK_CONFIG, 'application_default_credentials.json');
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');
}

/**
 * Work out which credentials the Google libraries will pick up. Never reads key contents
 * beyond the "type" field (to tell a key file from an impersonation file).
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.homeDir]
 * @param {string} [opts.platform]
 * @returns {{source: 'env'|'dockeriser-key'|'gcloud-adc'|'none', path?: string, type?: string, setEnv?: string}}
 *   `setEnv` is a key path that should be exported as GOOGLE_APPLICATION_CREDENTIALS.
 * @throws {AuthError} GOOGLE_APPLICATION_CREDENTIALS points at a file that does not exist.
 */
export function resolveCredentials({ env = process.env, homeDir = os.homedir(), platform = process.platform } = {}) {
  const fromEnv = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new AuthError(`GOOGLE_APPLICATION_CREDENTIALS points at ${fromEnv}, but that file does not exist.`, {
        fix: 'Fix the path, or unset the variable to fall back to gcloud credentials.',
      });
    }
    return { source: 'env', path: fromEnv, type: credentialType(fromEnv) };
  }
  const key = path.join(configDir(homeDir), 'key.json');
  if (fs.existsSync(key)) return { source: 'dockeriser-key', path: key, type: credentialType(key), setEnv: key };
  const adc = gcloudAdcPath(env, homeDir, platform);
  if (fs.existsSync(adc)) return { source: 'gcloud-adc', path: adc, type: credentialType(adc) };
  return { source: 'none' };
}

/** Read only the "type" field of a credentials file (service_account, impersonated_service_account, authorized_user). */
function credentialType(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).type || 'unknown';
  } catch {
    return 'unreadable';
  }
}

/**
 * Point the Google libraries at the chosen credentials. When nothing is on disk we tell the auth
 * library not to probe the GCE metadata server (that probe takes seconds on a normal PC);
 * set METADATA_SERVER_DETECTION=assume-present yourself when running on Google Cloud VMs.
 * @param {ReturnType<typeof resolveCredentials>} creds
 * @param {Record<string, string|undefined>} [env]
 */
export function applyCredentials(creds, env = process.env) {
  if (creds.setEnv) env.GOOGLE_APPLICATION_CREDENTIALS = creds.setEnv;
  if (creds.source === 'none' && !env.METADATA_SERVER_DETECTION) env.METADATA_SERVER_DETECTION = 'none';
}
