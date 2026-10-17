/**
 * Package a local folder into a gzipped tarball, honouring .gcloudignore / .dockerignore.
 * Everything here is local: it fails fast before any network call.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import ignore from 'ignore';
import * as tar from 'tar';
import { ConfigError } from './errors.js';
import { dockerMatcher } from './dockerignore.js';

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
    return { matcher: dockerMatcher(fs.readFileSync(docker, 'utf8')), ignoreFile: '.dockerignore' };
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
        if (!matcher.ignores(`${rel}/`) || matcher.mayDescend?.(rel)) walk(path.join(absDir, entry.name), rel);
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
export async function packageSource(dir, { dockerfile, tmpDir = os.tmpdir(), warn = () => {}, images, include = [], source } = {}) {
  if (images) return packageImages(dir, { images, include, tmpDir, warn, source });
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

  const made = await writeTarball(root, files, { tmpDir, warn, ignoreFile });
  return { ...made, dockerfile: dockerfileRel, ignoreFile };
}

/** Tar + gzip `files` (POSIX paths relative to `root`) into the temp folder. */
async function writeTarball(root, files, { tmpDir, warn, ignoreFile, extras = [] }) {
  const out = path.join(tmpDir, `dockeriser-src-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tgz`);
  activeTempFiles.add(out);
  const plain = `${out}.tar`;
  try {
    if (extras.length === 0) {
      await tar.c({ gzip: true, file: out, cwd: root, portable: true, noDirRecurse: true, follow: false }, files);
    } else {
      // Extra roots go under their prefix: tar them up uncompressed, append, then gzip once.
      activeTempFiles.add(plain);
      await tar.c({ file: plain, cwd: root, portable: true, noDirRecurse: true, follow: false }, files);
      for (const extra of extras) {
        if (extra.files.length) await tar.r({ file: plain, cwd: extra.cwd, prefix: extra.prefix, portable: true, noDirRecurse: true, follow: false }, extra.files);
      }
      await pipeline(fs.createReadStream(plain), zlib.createGzip(), fs.createWriteStream(out));
      removeTarball(plain);
    }
    const bytes = fs.statSync(out).size;
    if (bytes > LARGE_UPLOAD_BYTES) {
      warn(`The upload is ${(bytes / 1024 / 1024).toFixed(0)} MB. Add big folders (node_modules, build output, data) to ${ignoreFile || '.dockerignore'} to speed it up.`);
    }
    return { path: out, bytes, fileCount: files.length, sha256: await sha256File(out) };
  } catch (err) {
    removeTarball(out);
    removeTarball(plain);
    throw err;
  }
}

/**
 * The ignore rules Docker itself applies to one image's build context: `<dockerfile>.dockerignore`
 * next to the Dockerfile, else `<context>/.dockerignore`. For the root context a `.gcloudignore`
 * wins (gcloud's upload rules). `.git/` is always left out.
 * @param {string} root Absolute project folder.
 * @param {{context: string, dockerfile: string}} image POSIX paths relative to root.
 * @returns {{matcher: import('ignore').Ignore, ignoreFile: string|null}}
 */
export function contextIgnore(root, { context, dockerfile }) {
  if (context === '.' && fs.existsSync(path.join(root, '.gcloudignore'))) return loadIgnore(root);
  for (const candidate of [`${dockerfile}.dockerignore`, context === '.' ? '.dockerignore' : `${context}/.dockerignore`]) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs)) return { matcher: dockerMatcher(fs.readFileSync(abs, 'utf8')), ignoreFile: candidate };
  }
  return { matcher: dockerMatcher(''), ignoreFile: null };
}

/** Walk `root/sub` with a matcher whose paths are relative to `root/sub`; returns root-relative paths. */
function listUnder(root, sub, matcher) {
  const abs = sub === '.' ? root : path.join(root, sub);
  return listFiles(abs, matcher).map((rel) => (sub === '.' ? rel : `${sub}/${rel}`));
}

/**
 * Tracked files of a git checkout (POSIX paths relative to `root`), for `"source": "git"`.
 * @param {string} root
 * @param {typeof execFileSync} [exec]
 * @returns {Set<string>}
 */
export function gitTrackedFiles(root, exec = execFileSync) {
  let out;
  try {
    out = exec('git', ['ls-files', '-z', '--cached', '--', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    throw new ConfigError(`"source": "git" is set, but git could not list the files in ${root} (${String(err.stderr || err.message).trim().split('\n')[0]}).`, {
      fix: 'Run it inside a git checkout with git installed, or remove "source" from dockeriser.json.',
    });
  }
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * Files to upload for a multi-image build: for every image, exactly what Docker would send for its
 * context (its own ignore rules), plus every Dockerfile, plus each `include` entry (a file, a folder,
 * or a glob), even when an ignore file or a parent folder would drop it. `.git/` is never uploaded.
 * Images with an external context (outside the project) are packed separately; see packageImages.
 * With `tracked` (a Set from gitTrackedFiles), context files must also be tracked by git;
 * Dockerfiles and `include` entries are added either way.
 * @param {string} root Absolute project folder.
 * @param {{images: Array<{name: string, context: string, dockerfile: string, external?: string|null}>, include?: string[], tracked?: Set<string>|null}} opts
 * @returns {{files: string[], ignoreFiles: string[]}}
 */
export function listUploadFiles(root, { images, include = [], tracked = null }) {
  const files = new Set();
  const ignoreFiles = new Set();
  const walked = new Set();
  for (const img of images) {
    if (img.external) {
      if (!img.dockerfile.startsWith(`${img.context}/`)) files.add(img.dockerfile);
      continue;
    }
    const ctxAbs = path.join(root, img.context);
    if (!fs.existsSync(ctxAbs) || !fs.statSync(ctxAbs).isDirectory()) {
      throw new ConfigError(`Image "${img.name}": the build context ${img.context} does not exist in ${root}.`, {
        fix: 'Create it first (staged contexts are made on this PC before upload), or fix "context" in dockeriser.json.',
      });
    }
    const dfAbs = path.join(root, img.dockerfile);
    if (!fs.existsSync(dfAbs) || !fs.statSync(dfAbs).isFile()) {
      throw new ConfigError(`Image "${img.name}": no Dockerfile at ${img.dockerfile}.`, { fix: 'Fix "dockerfile" in dockeriser.json (paths are relative to the folder holding it).' });
    }
    const { matcher, ignoreFile } = contextIgnore(root, img);
    const key = `${img.context}|${ignoreFile}`;
    if (ignoreFile) ignoreFiles.add(ignoreFile);
    if (!walked.has(key)) {
      walked.add(key);
      for (const f of listUnder(root, img.context, matcher)) if (!tracked || tracked.has(f)) files.add(f);
    }
    files.add(img.dockerfile);
  }
  for (const f of includeFiles(root, include)) files.add(f);
  return { files: [...files].sort(), ignoreFiles: [...ignoreFiles] };
}

/** Expand `include` entries (files, folders, globs relative to root). */
function includeFiles(root, include) {
  const files = [];
  for (const entry of include) {
    const clean = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const globAt = clean.search(/[*?[]/);
    if (globAt < 0) {
      const abs = path.join(root, clean);
      if (!fs.existsSync(abs)) throw new ConfigError(`"include" entry ${entry} does not exist in ${root}.`, { fix: 'Create it first, or remove it from "include" in dockeriser.json.' });
      if (fs.statSync(abs).isDirectory()) files.push(...listUnder(root, clean, ignore().add('.git/')));
      else files.push(clean);
      continue;
    }
    const base = clean.slice(0, globAt).replace(/[^/]*$/, '').replace(/\/$/, '') || '.';
    if (!fs.existsSync(path.join(root, base))) continue;
    const pattern = ignore().add(clean);
    for (const f of listUnder(root, base, ignore().add('.git/'))) if (pattern.ignores(f)) files.push(f);
  }
  return files;
}

/**
 * packageSource for a dockeriser.json multi-image build. External contexts (outside the project,
 * e.g. a sibling repo) go into the same tarball under `_ctx/<image name>/`, filtered by their own
 * .dockerignore.
 */
async function packageImages(dir, { images, include, tmpDir, warn, source }) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new ConfigError(`The folder ${root} does not exist.`, { fix: 'Pass the folder that holds dockeriser.json.' });
  }
  const tracked = source === 'git' ? gitTrackedFiles(root) : null;
  const { files, ignoreFiles } = listUploadFiles(root, { images, include, tracked });
  const extras = [];
  for (const img of images.filter((i) => i.external)) {
    if (!fs.existsSync(img.external) || !fs.statSync(img.external).isDirectory()) {
      throw new ConfigError(`Image "${img.name}": the build context ${img.external} does not exist.`, { fix: 'Check out that folder next to this project, or fix "context" in dockeriser.json.' });
    }
    const { matcher, ignoreFile } = contextIgnore(img.external, { context: '.', dockerfile: path.join(img.external, 'Dockerfile') });
    if (ignoreFile) ignoreFiles.push(`${img.context}/${ignoreFile}`);
    const extraFiles = listFiles(img.external, matcher);
    if (img.dockerfile.startsWith(`${img.context}/`)) {
      const df = img.dockerfile.slice(img.context.length + 1);
      if (!fs.existsSync(path.join(img.external, df))) throw new ConfigError(`Image "${img.name}": no Dockerfile at ${path.join(img.external, df)}.`);
      if (!extraFiles.includes(df)) extraFiles.push(df);
    }
    extras.push({ cwd: img.external, prefix: img.context, files: extraFiles });
  }
  const ignoreFile = ignoreFiles.join(', ') || null;
  const made = await writeTarball(root, files, { tmpDir, warn, ignoreFile, extras });
  return { ...made, fileCount: made.fileCount + extras.reduce((n, e) => n + e.files.length, 0), dockerfile: null, ignoreFile };
}

/**
 * Delete a tarball made by packageSource.
 * @param {string} file
 */
export function removeTarball(file) {
  fs.rmSync(file, { force: true });
  activeTempFiles.delete(file);
}

/**
 * Tar + gzip an explicit list of files (POSIX paths relative to `root`), for `dockeriser ci`.
 * @param {string} root
 * @param {string[]} files
 * @param {{tmpDir?: string, warn?: (msg: string) => void}} [opts]
 * @returns {Promise<{path: string, bytes: number, fileCount: number, sha256: string}>}
 */
export async function packageFiles(root, files, { tmpDir = os.tmpdir(), warn = () => {} } = {}) {
  if (!files.length) throw new ConfigError(`Nothing to upload from ${root}.`, { fix: 'Run it in the project folder.' });
  return writeTarball(path.resolve(root), files, { tmpDir, warn, ignoreFile: '.gitignore' });
}
