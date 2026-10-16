/**
 * `dockeriser doctor`: check every piece of setup and say how to fix what is missing.
 */

import { applyCredentials, resolveConfig, resolveCredentials, resourceNames } from './config.js';
import { EXIT, mapGoogleError } from './errors.js';

/** HTTP-ish status of an error from either gRPC, Cloud Storage or gaxios. */
function statusOf(err) {
  return err?.response?.status ?? err?.status ?? err?.code;
}

const SETUP_FIX = (project) => `Run setup/setup.ps1 -Project ${project || '<project-id>'} (safe to re-run).`;

/**
 * Run all checks. Network checks are skipped (not failed) when config or credentials are missing.
 *
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.flags] --project/--region/--repo values.
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.homeDir]
 * @param {(o: {project: string}) => Promise<{cloudBuild: any, storage: any}>} opts.createClients
 * @returns {Promise<{checks: Array<{name: string, status: 'pass'|'fail'|'skip'|'warn', detail: string, fix?: string}>, exitCode: number}>}
 */
export async function runDoctor({ flags = {}, env = process.env, homeDir, createClients }) {
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });
  let failCode = 0;
  const fail = (code, name, detail, fix) => {
    add(name, 'fail', detail, fix);
    if (!failCode) failCode = code;
  };

  // 1. Config
  let cfg;
  try {
    cfg = resolveConfig({ flags, env, homeDir, requireProject: false });
    if (cfg.project) {
      add('Config', 'pass', `project ${cfg.project} (${cfg.sources.project}), region ${cfg.region}, repo ${cfg.repo}, service account ${cfg.serviceAccount}`);
    } else {
      fail(EXIT.CONFIG, 'Config', 'No project set.', `Pass --project <id>, set DOCKERISER_PROJECT, or run setup/setup.ps1 (writes ${cfg.configFile}).`);
    }
  } catch (err) {
    fail(EXIT.CONFIG, 'Config', err.message, err.fix);
  }

  // 2. Credentials
  let creds = null;
  let authOk = false;
  try {
    creds = resolveCredentials({ env, homeDir });
    applyCredentials(creds, env);
    if (creds.source === 'none') {
      fail(EXIT.AUTH, 'Credentials', 'No Google credentials found (no GOOGLE_APPLICATION_CREDENTIALS, no ~/.dockeriser/key.json, no gcloud application-default login).',
        `Either run setup/setup.ps1 -CreateKey (key file), or run \`gcloud auth application-default login --impersonate-service-account=${cfg?.serviceAccount || '<service account email>'}\`. See docs/SETUP.md.`);
    } else {
      const label = { env: 'GOOGLE_APPLICATION_CREDENTIALS', 'dockeriser-key': 'dockeriser key file', 'gcloud-adc': 'gcloud application-default login' }[creds.source];
      add('Credentials', 'pass', `${label} at ${creds.path} (type: ${creds.type})`);
      if (creds.type === 'authorized_user') {
        add('Identity', 'warn', 'These are your personal gcloud credentials, not the dockeriser service account.',
          'Recommended: `gcloud auth application-default login --impersonate-service-account=<service account email>` so builds use only the dockeriser permissions.');
      }
    }
  } catch (err) {
    fail(EXIT.AUTH, 'Credentials', err.message, err.fix);
  }

  const canNetwork = Boolean(cfg?.project && creds && creds.source !== 'none');
  const skipped = ['Google sign-in', 'Cloud Build API', 'Source bucket', 'Logs bucket', 'Artifact Registry repo'];
  if (!canNetwork) {
    for (const name of skipped) add(name, 'skip', 'skipped (needs a project and credentials first)');
    return { checks, exitCode: failCode || EXIT.BUILD_FAILED };
  }

  const ctx = { project: cfg.project, region: cfg.region, serviceAccount: cfg.serviceAccount };
  const names = resourceNames(cfg);
  const { cloudBuild, storage } = await createClients({ project: cfg.project });

  // 3. Can we get a token?
  try {
    const auth = storage.authClient;
    const client = await auth.getClient();
    await client.getAccessToken();
    const email = (await auth.getCredentials().catch(() => ({})))?.client_email;
    add('Google sign-in', 'pass', email ? `signed in as ${email}` : 'access token obtained');
    authOk = true;
    if (email && email !== cfg.serviceAccount && email.endsWith('.gserviceaccount.com')) {
      add('Identity', 'warn', `Signed in as ${email} but builds run as ${cfg.serviceAccount}.`,
        `That works only if ${email} has "Service Account User" on ${cfg.serviceAccount}.`);
    }
  } catch (err) {
    const mapped = mapGoogleError(err, { ...ctx, action: 'get an access token' });
    fail(EXIT.AUTH, 'Google sign-in', mapped.message, mapped.fix);
  }
  if (!authOk) {
    for (const name of skipped.slice(1)) add(name, 'skip', 'skipped (sign-in failed)');
    return { checks, exitCode: failCode };
  }

  // 4. Cloud Build API reachable in the region
  try {
    await cloudBuild.listBuilds({ projectId: cfg.project, parent: `projects/${cfg.project}/locations/${cfg.region}`, pageSize: 1 }, { autoPaginate: false });
    add('Cloud Build API', 'pass', `reachable in ${cfg.region}`);
  } catch (err) {
    const mapped = mapGoogleError(err, { ...ctx, action: 'list builds' });
    fail(mapped.exitCode, 'Cloud Build API', mapped.message, mapped.fix);
  }

  // 5-6. Buckets (object list works with bucket-level object roles)
  for (const [label, bucket, role] of [
    ['Source bucket', names.sourceBucket, 'Storage Object Admin'],
    ['Logs bucket', names.logsBucket, 'Storage Admin'],
  ]) {
    try {
      await storage.bucket(bucket).getFiles({ maxResults: 1, autoPaginate: false });
      add(label, 'pass', `gs://${bucket}`);
    } catch (err) {
      const code = statusOf(err);
      if (code === 404) fail(EXIT.CONFIG, label, `gs://${bucket} does not exist.`, SETUP_FIX(cfg.project));
      else if (code === 403) fail(EXIT.AUTH, label, `No access to gs://${bucket}.`, `Grant ${cfg.serviceAccount} "${role}" on the bucket. ${SETUP_FIX(cfg.project)}`);
      else {
        const mapped = mapGoogleError(err, { ...ctx, api: 'storage.googleapis.com', action: `read gs://${bucket}` });
        fail(mapped.exitCode, label, mapped.message, mapped.fix);
      }
    }
  }

  // 7. Artifact Registry repo
  const repoUrl = `https://artifactregistry.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/repositories/${cfg.repo}`;
  try {
    const res = await storage.authClient.request({ url: repoUrl });
    const format = res.data?.format;
    if (format && format !== 'DOCKER') fail(EXIT.CONFIG, 'Artifact Registry repo', `${cfg.repo} exists but is a ${format} repo, not Docker.`, 'Use --repo with a Docker repo, or delete and re-run setup.');
    else add('Artifact Registry repo', 'pass', names.repoPath);
  } catch (err) {
    const code = statusOf(err);
    const msg = String(err?.response?.data?.error?.message || err?.message || err);
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
      fail(EXIT.CONFIG, 'Artifact Registry repo', 'The Artifact Registry API is turned off.', `Enable it at https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com?project=${cfg.project}`);
    } else if (code === 404) {
      fail(EXIT.CONFIG, 'Artifact Registry repo', `${names.repoPath} does not exist.`, SETUP_FIX(cfg.project));
    } else if (code === 403) {
      fail(EXIT.AUTH, 'Artifact Registry repo', `No access to ${names.repoPath}.`, `Grant ${cfg.serviceAccount} "Artifact Registry Writer" on the repo. ${SETUP_FIX(cfg.project)}`);
    } else {
      fail(EXIT.BUILD_FAILED, 'Artifact Registry repo', msg, 'Re-run with --debug for details.');
    }
  }

  return { checks, exitCode: failCode };
}

/**
 * Print doctor results for humans.
 * @param {Awaited<ReturnType<typeof runDoctor>>['checks']} checks
 * @param {ReturnType<import('./output.js').createOutput>} out
 */
export function printDoctor(checks, out) {
  const c = out.colour;
  const badge = { pass: c('green', '[ok]  '), fail: c('red', '[FAIL]'), skip: c('dim', '[skip]'), warn: c('yellow', '[warn]') };
  const width = Math.max(...checks.map((ch) => ch.name.length));
  out.info('dockeriser doctor');
  for (const ch of checks) {
    out.info(`  ${badge[ch.status]} ${ch.name.padEnd(width)}  ${ch.detail}`);
    if (ch.fix) out.info(`         ${' '.repeat(width)}  ${c('dim', 'fix:')} ${ch.fix}`);
  }
  const failed = checks.filter((ch) => ch.status === 'fail').length;
  out.info();
  if (failed) out.info(c('red', `${failed} check${failed === 1 ? '' : 's'} failed.`));
  else out.ok('All checks passed. Try: dockeriser build examples/hello --image hello');
}
