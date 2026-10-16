/**
 * Package a local folder into a gzipped tarball, honouring .gcloudignore / .dockerignore.
 * Everything here is local: it fails fast before any network call.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import ignore from 'ignore';
import * as tar from 'tar';
import { ConfigError } from './errors.js';

export const LARGE_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Temp tarballs that still exist, so a Ctrl-C handler can delete them synchronously. */
export const activeTempFiles = new Set();

/** Delete every temp tarball still on disk (safe to call from a signal handler). */
export function cleanupTempFiles() {
  for (const file of [...activeTempFiles]) removeTarball(file);
}

/** Convert a native relative path to the POSIX form used in tar entries and ignore matching. */
export function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * Turn .dockerignore lines into gitignore lines with the same meaning. Docker patterns are
 * always relative to the context root, so each one is anchored with a leading "/".
 * @param {string} text Contents of .dockerignore.
 * @returns {string[]}
 */
export function dockerignoreToGitignore(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let pattern = (negate ? line.slice(1) : line).trim().replace(/\\/g, '/');
    pattern = pattern.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (!pattern || pattern === '.') continue;
    out.push(`${negate ? '!' : ''}/${pattern}`);
  }
  return out;
}

/**
 * Read .gcloudignore lines, expanding gcloud's `#!include:<file>` directive.
 * @param {string} dir
 * @param {string} text
 * @returns {string[]}
 */
function gcloudignoreLines(dir, text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const include = line.match(/^#!include:(.+)$/);
    if (include) {
      const file = path.join(dir, include[1].trim());
      if (fs.existsSync(file)) out.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/));
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Build the ignore matcher for a folder: .gcloudignore wins over .dockerignore; .git/ is always excluded.
 * @param {string} dir
 * @returns {{matcher: import('ignore').Ignore, ignoreFile: string|null}}
 */
export function loadIgnore(dir) {
  const matcher = ignore().add('.git/');
  const gcloud = path.join(dir, '.gcloudignore');
  const docker = path.join(dir, '.dockerignore');
  if (fs.existsSync(gcloud)) {
    matcher.add(gcloudignoreLines(dir, fs.readFileSync(gcloud, 'utf8')));
    return { matcher, ignoreFile: '.gcloudignore' };
  }
  if (fs.existsSync(docker)) {
    matcher.add(dockerignoreToGitignore(fs.readFileSync(docker, 'utf8')));
    return { matcher, ignoreFile: '.dockerignore' };
  }
  return { matcher, ignoreFile: null };
}

/**
 * List files under `dir` that survive the ignore rules, as sorted POSIX relative paths.
 * Ignored directories are pruned without being read.
 * @param {string} dir
 * @param {import('ignore').Ignore} matcher
 * @returns {string[]}
 */
export function listFiles(dir, matcher) {
  const files = [];
  const walk = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!matcher.ignores(`${rel}/`)) walk(path.join(absDir, entry.name), rel);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && !matcher.ignores(rel)) {
        files.push(rel);
      }
    }
  };
  walk(dir, '');
  return files.sort();
}

/**
 * Resolve the Dockerfile path relative to the build folder, as a POSIX path.
 * @param {string} dir Absolute build folder.
 * @param {string} [dockerfile] --dockerfile value (relative to the folder, or absolute inside it).
 * @returns {string}
 */
export function resolveDockerfile(dir, dockerfile = 'Dockerfile') {
  const abs = path.resolve(dir, dockerfile);
  const rel = path.relative(dir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ConfigError(`The Dockerfile ${dockerfile} is outside the build folder ${dir}.`, {
      fix: 'Cloud Build only receives the build folder; move the Dockerfile inside it or point --dockerfile at a file in it.',
    });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new ConfigError(`No Dockerfile found at ${abs}.`, {
      fix: 'Add a Dockerfile to the folder, or pass --dockerfile <path relative to the folder>.',
    });
  }
  return toPosix(rel);
}

/** SHA-256 of a file, streamed. */
async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Package `dir` into a gzipped tarball in the temp folder.
 *
 * @param {string} dir Folder to package.
 * @param {object} [opts]
 * @param {string} [opts.dockerfile] Dockerfile path relative to the folder.
 * @param {string} [opts.tmpDir] Where to write the tarball (defaults to os.tmpdir()).
 * @param {(msg: string) => void} [opts.warn] Called with a warning for very large uploads.
 * @returns {Promise<{path: string, bytes: number, fileCount: number, sha256: string,
 *   dockerfile: string, ignoreFile: string|null}>}
 * @throws {ConfigError} Folder missing, nothing left after ignores, or no Dockerfile.
 */
export async function packageSource(dir, { dockerfile, tmpDir = os.tmpdir(), warn = () => {} } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new ConfigError(`The folder ${root} does not exist.`, { fix: 'Pass the folder that holds your Dockerfile.' });
  }
  const { matcher, ignoreFile } = loadIgnore(root);
  const files = listFiles(root, matcher);
  if (files.length === 0) {
    throw new ConfigError(`Nothing to upload: every file in ${root} is excluded${ignoreFile ? ` by ${ignoreFile}` : ''}.`, {
      fix: ignoreFile ? `Loosen the rules in ${ignoreFile}.` : 'Point at a folder that contains your project.',
    });
  }
  const dockerfileRel = resolveDockerfile(root, dockerfile);
  if (!files.includes(dockerfileRel)) files.push(dockerfileRel); // Docker always sends the Dockerfile.

  const out = path.join(tmpDir, `dockeriser-src-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tgz`);
  activeTempFiles.add(out);
  try {
    await tar.c({ gzip: true, file: out, cwd: root, portable: true, noDirRecurse: true, follow: false }, files);
    const bytes = fs.statSync(out).size;
    if (bytes > LARGE_UPLOAD_BYTES) {
      warn(`The upload is ${(bytes / 1024 / 1024).toFixed(0)} MB. Add big folders (node_modules, build output, data) to ${ignoreFile || '.dockerignore'} to speed it up.`);
    }
    return { path: out, bytes, fileCount: files.length, sha256: await sha256File(out), dockerfile: dockerfileRel, ignoreFile };
  } catch (err) {
    removeTarball(out);
    throw err;
  }
}

/**
 * Delete a tarball made by packageSource.
 * @param {string} file
 */
export function removeTarball(file) {
  fs.rmSync(file, { force: true });
  activeTempFiles.delete(file);
}
