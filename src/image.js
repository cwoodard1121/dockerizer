/**
 * Image reference handling: expand short names to Artifact Registry paths and pick a default tag.
 */

import { execFileSync } from 'node:child_process';
import { ConfigError } from './errors.js';

const AR_HOST = /^[a-z0-9-]+-docker\.pkg\.dev$/;
const NAME_PART = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Format a Date as YYYYMMDD-HHMMSS in UTC.
 * @param {Date} [date]
 * @returns {string}
 */
export function utcStamp(date = new Date()) {
  const iso = date.toISOString(); // 2026-10-16T21:03:09.123Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * Short git SHA of `dir` when it is inside a git repo and the files under `dir` match HEAD.
 * Returns null otherwise (not a repo, no commits, uncommitted changes, git missing).
 * @param {string} dir
 * @param {typeof execFileSync} [exec]
 * @returns {string|null}
 */
export function gitShaIfClean(dir, exec = execFileSync) {
  const git = (args) =>
    exec('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
  try {
    const sha = git(['rev-parse', '--short', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--untracked-files=normal', '--', '.']);
    return sha && !dirty ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Default tag: clean git SHA, else a UTC timestamp.
 * @param {string} dir
 * @param {{now?: Date, exec?: typeof execFileSync}} [opts]
 * @returns {string}
 */
export function defaultTag(dir, { now = new Date(), exec } = {}) {
  return gitShaIfClean(dir, exec) || utcStamp(now);
}

/**
 * Split "name[:tag]" at the tag colon (the last colon after the last slash).
 * @param {string} ref
 * @returns {{name: string, tag?: string}}
 */
function splitTag(ref) {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? { name: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { name: ref };
}

/**
 * Expand --image and --tag flags into the full list of image refs to build and push.
 * `myapp:1.2` becomes `<region>-docker.pkg.dev/<project>/<repo>/myapp:1.2`; a full
 * `*-docker.pkg.dev/...` ref is kept as-is. `:latest` is always added.
 *
 * @param {object} opts
 * @param {string} opts.image The --image value.
 * @param {string[]} [opts.extraTags] Values of --tag.
 * @param {string} opts.project
 * @param {string} opts.region
 * @param {string} opts.repo
 * @param {() => string} opts.fallbackTag Called only when no tag was given anywhere.
 * @returns {{repository: string, tags: string[], refs: string[], primary: string}}
 */
export function expandImage({ image, extraTags = [], project, region, repo, fallbackTag }) {
  if (!image) {
    throw new ConfigError('Missing --image.', { fix: 'Pass --image <name>[:<tag>], e.g. --image myapp:1.2' });
  }
  if (image.includes('@')) {
    throw new ConfigError(`--image "${image}" contains a digest; digests are produced by the build, not chosen.`, {
      fix: 'Pass a name and optional tag, e.g. myapp:1.2',
    });
  }
  const { name, tag } = splitTag(image.trim());
  const parts = name.split('/');
  let repository;
  if (AR_HOST.test(parts[0])) {
    if (parts.length < 4) {
      throw new ConfigError(`"${image}" is not a full Artifact Registry path.`, {
        fix: 'Use <region>-docker.pkg.dev/<project>/<repo>/<image>, or just <image> to use your configured repo.',
      });
    }
    repository = name;
  } else if (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost') {
    throw new ConfigError(`"${image}" points at a registry other than Artifact Registry.`, {
      fix: 'Use a short name (myapp:1.2) or a full <region>-docker.pkg.dev/... reference.',
    });
  } else {
    repository = `${region}-docker.pkg.dev/${project}/${repo}/${name}`;
  }

  const path = repository.split('/').slice(1);
  for (const part of path) {
    if (!NAME_PART.test(part)) {
      throw new ConfigError(`"${part}" is not a valid image name part (lowercase letters, digits, ".", "_", "-").`, {
        fix: 'Image names must be lowercase, e.g. my-app:1.2',
      });
    }
  }

  const wanted = [tag, ...extraTags].filter(Boolean);
  if (wanted.length === 0) wanted.push(fallbackTag());
  wanted.push('latest');
  const tags = [...new Set(wanted)];
  for (const t of tags) {
    if (!TAG.test(t)) {
      throw new ConfigError(`"${t}" is not a valid tag.`, {
        fix: 'Tags may use letters, digits, "_", "." and "-", start with a letter, digit or "_", max 128 chars.',
      });
    }
  }
  const refs = tags.map((t) => `${repository}:${t}`);
  return { repository, tags, refs, primary: refs[0] };
}
