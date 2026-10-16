/**
 * Upload the source tarball to the dockeriser source bucket.
 */

import { AuthError, UploadError, mapGoogleError } from './errors.js';
import { utcStamp } from './image.js';

/** Files above this size use a resumable upload (survives flaky connections). */
export const RESUMABLE_THRESHOLD = 8 * 1024 * 1024;

/**
 * Object name for an upload: source/<YYYYMMDD-HHMMSS>-<first 8 of sha256>.tgz
 * @param {string} sha256
 * @param {Date} [now]
 * @returns {string}
 */
export function sourceObjectName(sha256, now = new Date()) {
  return `source/${utcStamp(now)}-${sha256.slice(0, 8)}.tgz`;
}

/**
 * Upload a tarball and return where it landed.
 *
 * @param {object} opts
 * @param {import('@google-cloud/storage').Storage} opts.storage Injected Storage client.
 * @param {string} opts.bucket Bucket name (no gs://).
 * @param {string} opts.object Object name.
 * @param {string} opts.file Local tarball path.
 * @param {number} opts.bytes Tarball size.
 * @param {string} opts.project
 * @param {string} [opts.serviceAccount] Used to name the identity in permission errors.
 * @returns {Promise<{bucket: string, object: string, generation?: string}>}
 * @throws {UploadError|AuthError}
 */
export async function uploadSource({ storage, bucket, object, file, bytes, project, serviceAccount }) {
  try {
    const [, metadata] = await storage.bucket(bucket).upload(file, {
      destination: object,
      resumable: bytes > RESUMABLE_THRESHOLD,
      validation: 'crc32c',
      contentType: 'application/gzip',
      metadata: { metadata: { createdBy: 'dockeriser' } },
    });
    return { bucket, object, generation: metadata?.generation === undefined ? undefined : String(metadata.generation) };
  } catch (err) {
    throw mapUploadError(err, { bucket, project, serviceAccount });
  }
}

/**
 * Map a Cloud Storage error during upload to an actionable error.
 * @param {any} err
 * @param {{bucket: string, project: string, serviceAccount?: string}} ctx
 * @returns {UploadError|AuthError|import('./errors.js').DockeriserError}
 */
export function mapUploadError(err, { bucket, project, serviceAccount }) {
  const msg = String(err?.message || err);
  const who = serviceAccount || 'your account';
  if (err?.code === 404 || /bucket does not exist|No such bucket/i.test(msg)) {
    return new UploadError(`The source bucket gs://${bucket} does not exist.`, {
      fix: `Run setup/setup.ps1 -Project ${project} to create it (safe to re-run).`,
      cause: err,
    });
  }
  if (err?.code === 403 && /billing/i.test(msg)) {
    return new UploadError(`Cloud Storage refused the upload because billing is off for project ${project}.`, {
      fix: `Link a billing account at https://console.cloud.google.com/billing/linkedaccount?project=${project}.`,
      cause: err,
    });
  }
  if (err?.code === 403) {
    return new UploadError(`${who} is not allowed to upload to gs://${bucket}.`, {
      fix: `Grant it "Storage Object Admin" (roles/storage.objectAdmin) on that bucket, or re-run setup/setup.ps1 -Project ${project}.`,
      cause: err,
    });
  }
  const mapped = mapGoogleError(err, { project, serviceAccount, action: `upload to gs://${bucket}` });
  if (mapped instanceof AuthError) return mapped;
  return new UploadError(mapped.message, { fix: mapped.fix, cause: err });
}
