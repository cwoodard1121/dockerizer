/**
 * `dockeriser cleanup`: keep the newest N versions of every image in the repo and delete the rest,
 * now and from then on. "From then on" is the repo's cleanup policy (Artifact Registry applies it
 * about once a day): Keep the N most recent versions + Delete anything older than a day (a Keep rule
 * alone deletes nothing; docs/RESEARCH.md). "Now" deletes the versions beyond N straight away.
 *
 * Runs gcloud as the signed-in user (the project owner), so the build account never needs the right
 * to delete images. A version is one manifest (digest); the one tagged `latest` is never deleted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, DockeriserError } from './errors.js';

export const DEFAULT_KEEP = 20;
const KEEP_RULE = /^keep-\d+-most-recent$/;

/**
 * The cleanup policy file gcloud takes.
 * @param {number} keep
 */
export function cleanupPolicy(keep) {
  return [
    { name: `keep-${keep}-most-recent`, action: { type: 'Keep' }, mostRecentVersions: { keepCount: keep } },
    { name: 'delete-older-than-1d', action: { type: 'Delete' }, condition: { tagState: 'any', olderThan: '1d' } },
  ];
}

/**
 * Decide what goes, per image: the `keep` newest versions (by createTime) and anything tagged
 * `latest` stay.
 * @param {Array<{package: string, version: string, tags?: string[]|string, createTime: string, metadata?: {imageSizeBytes?: string}}>} versions
 * @param {number} keep
 * @returns {Array<{name: string, package: string, versions: number, kept: number, delete: Array<{version: string, tags: string[], createTime: string, bytes: number}>, bytes: number}>}
 */
export function planCleanup(versions, keep) {
  const byPackage = new Map();
  for (const v of versions) {
    if (!byPackage.has(v.package)) byPackage.set(v.package, []);
    byPackage.get(v.package).push(v);
  }
  return [...byPackage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, list]) => {
      const sorted = [...list].sort((a, b) => Date.parse(b.createTime) - Date.parse(a.createTime));
      const tagsOf = (v) => (Array.isArray(v.tags) ? v.tags : String(v.tags || '').split(',').filter(Boolean));
      const doomed = sorted.slice(keep).filter((v) => !tagsOf(v).includes('latest'));
      const bytes = (vs) => vs.reduce((n, v) => n + Number(v.metadata?.imageSizeBytes || 0), 0);
      return {
        name: pkg.split('/').pop(),
        package: pkg,
        versions: sorted.length,
        kept: sorted.length - doomed.length,
        delete: doomed.map((v) => ({ version: v.version, tags: tagsOf(v), createTime: v.createTime, bytes: Number(v.metadata?.imageSizeBytes || 0) })),
        bytes: bytes(sorted),
      };
    });
}

/** Turn a failed gcloud call into an error with the sign-in fix. */
function gcloudError(res, what) {
  const msg = (res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ');
  return new DockeriserError(`gcloud could not ${what}: ${msg || `exit ${res.code}`}`, {
    fix: 'Sign in as the project owner with `gcloud auth login`, then run `dockeriser cleanup` again.',
  });
}

/**
 * Plan, and unless dryRun, set the policy and delete the versions beyond `keep`.
 * @param {object} opts
 * @param {(args: string[]) => {code: number, stdout: string, stderr: string}} opts.gcloud
 * @param {{project: string, region: string, repo: string}} opts.cfg
 * @param {number} [opts.keep]
 * @param {boolean} [opts.dryRun]
 * @param {string} opts.tmpDir
 * @param {object} opts.out Output helpers.
 */
export function runCleanup({ gcloud, cfg, keep = DEFAULT_KEEP, dryRun = false, tmpDir, out }) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new ConfigError('--keep must be a whole number from 1 to 1000.');
  const where = ['--location', cfg.region, '--project', cfg.project];
  const repoPath = `${cfg.region}-docker.pkg.dev/${cfg.project}/${cfg.repo}`;

  const listed = gcloud(['artifacts', 'docker', 'images', 'list', repoPath, '--include-tags', '--format=json', '--project', cfg.project]);
  if (listed.code !== 0) throw gcloudError(listed, `list the images in ${repoPath}`);
  let versions;
  try {
    versions = JSON.parse(listed.stdout || '[]');
  } catch {
    throw new DockeriserError(`gcloud returned something other than JSON for the image list of ${repoPath}.`);
  }
  const images = planCleanup(versions, keep);

  let policy = 'unchanged';
  const deleted = [];
  if (!dryRun) {
    const file = path.join(tmpDir, `dockeriser-cleanup-policy-${process.pid}.json`);
    fs.writeFileSync(file, `${JSON.stringify(cleanupPolicy(keep), null, 2)}\n`);
    try {
      const set = gcloud(['artifacts', 'repositories', 'set-cleanup-policies', cfg.repo, ...where, '--policy', file, '--no-dry-run', '--quiet']);
      if (set.code !== 0) throw gcloudError(set, `set the cleanup policy on ${cfg.repo}`);
    } finally {
      fs.rmSync(file, { force: true });
    }
    // "Set or update" keeps rules it was not given: drop an older keep-N rule (setup used keep-10).
    const desc = gcloud(['artifacts', 'repositories', 'describe', cfg.repo, ...where, '--format=json']);
    const stale = desc.code === 0 ? Object.keys(safeJson(desc.stdout)?.cleanupPolicies || {}).filter((n) => KEEP_RULE.test(n) && n !== `keep-${keep}-most-recent`) : [];
    if (stale.length) {
      const del = gcloud(['artifacts', 'repositories', 'delete-cleanup-policies', cfg.repo, ...where, `--policynames=${stale.join(',')}`, '--quiet']);
      if (del.code !== 0) throw gcloudError(del, `remove the old cleanup rule ${stale.join(', ')}`);
    }
    policy = 'set';
    for (const img of images) {
      for (const v of img.delete) {
        const res = gcloud(['artifacts', 'docker', 'images', 'delete', `${img.package}@${v.version}`, '--delete-tags', '--quiet', '--project', cfg.project]);
        if (res.code !== 0) throw gcloudError(res, `delete ${img.name}@${v.version.slice(0, 19)}`);
        deleted.push({ image: img.name, version: v.version });
        out.info(`    deleted ${img.name}@${v.version.slice(0, 19)}${v.tags.length ? ` (${v.tags.join(', ')})` : ''}`);
      }
    }
  }

  const toDelete = images.reduce((n, i) => n + i.delete.length, 0);
  return {
    ok: true,
    exitCode: 0,
    dryRun,
    keep,
    repository: repoPath,
    policy,
    images: images.map((i) => ({ name: i.name, versions: i.versions, kept: i.kept, deleting: i.delete.map((v) => v.version), bytes: i.bytes })),
    deleted: dryRun ? 0 : deleted.length,
    wouldDelete: dryRun ? toDelete : 0,
    // Sum of image sizes: an upper bound on space freed, since layers are shared between versions.
    bytesFreedUpTo: images.reduce((n, i) => n + i.delete.reduce((m, v) => m + v.bytes, 0), 0),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
