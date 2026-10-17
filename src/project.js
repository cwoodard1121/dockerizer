/**
 * Per-project settings in `dockeriser.json` (next to the code being built): the images to build
 * in one Cloud Build submission, extra upload includes, and the deploy target. Local files only.
 *
 * {
 *   "include": [".local/deploy/app-context"],            // uploaded even if an ignore file drops them
 *   "images": [{ "name": "base", "image": "appraiseme-app-base", "dockerfile": "Dockerfile",
 *                "context": ".", "buildArgs": {"REVISION": "${REVISION}"}, "buildArgsFile": ".local/web.env",
 *                "localTag": "appraiseme-app:base", "push": true }],
 *   "deploy": { "server": "prod", "mode": "run|compose|pull", ... }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';

export const PROJECT_FILE = 'dockeriser.json';
export const DEPLOY_MODES = ['run', 'compose', 'load-only'];
export const TRANSFERS = ['ssh', 'pull'];

/** Accept older/alternative spellings of a deploy mode. */
export function canonicalMode(mode) {
  if (mode === 'pull' || mode === 'load' || mode === 'pull-only') return 'load-only';
  return mode;
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const LOCAL_TAG = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const PORT = /^(?:(?:\d{1,3}\.){3}\d{1,3}:)?\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/;
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Read `<dir>/dockeriser.json`. Missing file => data null. A UTF-8 BOM is tolerated.
 * @param {string} dir
 * @returns {{file: string, data: object|null}}
 */
export function readProjectFile(dir) {
  const file = path.join(path.resolve(dir), PROJECT_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, data: null };
    throw new ConfigError(`Could not read ${file}: ${err.message}`);
  }
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected a JSON object');
    return { file, data };
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (${err.message}).`, { fix: `Fix the file; see "dockeriser.json" in the README.` });
  }
}

/**
 * Write `<dir>/dockeriser.json` (2-space JSON, trailing newline, no BOM).
 * @param {string} file
 * @param {object} data
 */
export function writeProjectFile(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** A path relative to the project root, as POSIX, refusing anything that escapes the root. */
export function relInside(root, value, what) {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${what} must be a non-empty path.`);
  const abs = path.resolve(root, value.trim());
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ConfigError(`${what} "${value}" is outside the project folder ${root}.`, { fix: 'Only files inside the folder are uploaded; use a path inside it.' });
  }
  return rel ? rel.split(path.sep).join('/') : '.';
}

/**
 * Parse KEY=VALUE lines (a .env-style file). Blank lines, `#` comments and a leading `export ` are
 * ignored; one pair of matching outer quotes is removed from the value.
 * @param {string} text
 * @param {string} [file] For error messages.
 * @returns {Array<[string, string]>}
 */
export function parseKeyValueLines(text, file = 'the file') {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) throw new ConfigError(`Line ${i + 1} of ${file} is not KEY=VALUE.`, { fix: 'Use one KEY=VALUE per line; # starts a comment.' });
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out.push([m[1], value]);
  });
  return out;
}

/**
 * Read a build-args file into KEY=VALUE strings.
 * @param {string} file Absolute path.
 * @returns {string[]}
 */
export function readBuildArgsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Build-args file ${file} could not be read (${err.code || err.message}).`, {
      fix: 'Create it first (it is read on this PC, before upload), or fix the path.',
    });
  }
  return parseKeyValueLines(text.replace(/^﻿/, ''), file).map(([k, v]) => `${k}=${v}`);
}

/**
 * Replace `${VAR}` in a build-arg value with the local environment variable (missing => empty,
 * reported through `onMissing`).
 */
export function expandEnv(value, env, onMissing = () => {}, builtins = {}) {
  const lookup = (name) => {
    if (env[name] !== undefined) return env[name];
    if (builtins[name] !== undefined) return builtins[name];
    onMissing(name);
    return '';
  };
  return String(value)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_, name) => lookup(name))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => lookup(name));
}

/** Simple glob for variable names: `NEXT_PUBLIC_*`, `VITE_*`, exact names. */
export function nameMatches(name, globs) {
  const esc = (g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return globs.some((g) => new RegExp(`^${esc(g)}$`).test(name));
}

/**
 * Work out one image's build args, lowest to highest priority: buildArgsFile (filtered by
 * buildArgsFromEnv when given), local env vars matching buildArgsFromEnv (when there is no file),
 * buildArgs from dockeriser.json (with ${VAR}, $VAR, ${git.sha}, ${git.short} filled in),
 * then the --build-arg-file and --build-arg flags.
 * @returns {string[]} KEY=VALUE strings
 */
export function resolveBuildArgs(img, { root, env, builtins = {}, cliFileArgs = [], cliArgs = [], warn = () => {} }) {
  const merged = new Map();
  const add = (kv) => {
    const i = kv.indexOf('=');
    if (i < 0) merged.set(kv, '');
    else merged.set(kv.slice(0, i), kv.slice(i + 1));
  };
  if (img.buildArgsFile) {
    for (const kv of readBuildArgsFile(path.join(root, img.buildArgsFile))) {
      if (!img.buildArgsFromEnv.length || nameMatches(kv.split('=')[0], img.buildArgsFromEnv)) add(kv);
    }
  } else if (img.buildArgsFromEnv.length) {
    for (const [k, v] of Object.entries(env)) if (v !== undefined && nameMatches(k, img.buildArgsFromEnv)) add(`${k}=${v}`);
  }
  const missing = new Set();
  for (const [k, v] of Object.entries(img.buildArgs)) add(`${k}=${expandEnv(v, env, (n) => missing.add(n), builtins)}`);
  if (missing.size) warn(`Image "${img.name}": ${[...missing].join(', ')} not set on this PC; passing empty values.`);
  cliFileArgs.forEach(add);
  cliArgs.forEach(add);
  return [...merged].map(([k, v]) => `${k}=${v}`);
}

/** Prefixes of values that frameworks bake into client bundles on purpose (public by design). */
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_*', 'VITE_*', 'PUBLIC_*', 'EXPO_PUBLIC_*', 'REACT_APP_*', 'NUXT_PUBLIC_*'];
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|(?:^|_)KEY$/i;

/**
 * Build-arg names that look like secrets. Build args show in the Cloud Build console and the
 * image history, so these deserve a warning (never a refusal: the heuristic can be wrong).
 * @param {string[]} kvs KEY=VALUE (or KEY) strings.
 * @returns {string[]}
 */
export function secretLookingArgs(kvs) {
  return kvs.map((kv) => kv.split('=')[0]).filter((k) => SECRET_NAME.test(k) && !nameMatches(k, PUBLIC_PREFIXES));
}

/**
 * Validate and normalise the `images` list.
 * @param {unknown} images
 * @param {string} root Project folder.
 * @returns {Array<{name: string, image: string, dockerfile: string, context: string,
 *   buildArgs: Record<string, string>, buildArgsFile: string|null, localTag: string|null, push: boolean}>}
 */
export function normaliseImages(images, root) {
  if (images === undefined) return [];
  if (!Array.isArray(images)) throw new ConfigError(`"images" in ${PROJECT_FILE} must be a list.`);
  const seen = new Set();
  const pushedRepos = new Map();
  return images.map((raw, i) => {
    const where = `images[${i}] in ${PROJECT_FILE}`;
    if (!raw || typeof raw !== 'object') throw new ConfigError(`${where} must be an object.`);
    const name = String(raw.name || '').trim();
    if (!ID.test(name)) throw new ConfigError(`${where} needs a "name" (lowercase letters, digits, ".", "_", "-").`);
    if (seen.has(name)) throw new ConfigError(`Two images in ${PROJECT_FILE} are called "${name}".`);
    seen.add(name);
    const image = String(raw.image || name).trim();
    if (image.includes(':') || image.includes('@')) {
      throw new ConfigError(`${where}: "image" is a name without a tag (tags come from --tag or the git SHA).`, { fix: `Use e.g. "image": "${image.split(/[:@]/)[0]}".` });
    }
    // A context outside the project (e.g. a sibling repo) is packed into the same upload under _ctx/<name>/.
    const ctxAbs = path.resolve(root, String(raw.context ?? '.').trim() || '.');
    const ctxRel = path.relative(root, ctxAbs);
    const external = ctxRel.startsWith('..') || path.isAbsolute(ctxRel) ? ctxAbs : null;
    const context = external ? `_ctx/${name}` : relInside(root, raw.context ?? '.', `${where} "context"`);
    let dockerfile;
    if (external) {
      const dfAbs = path.resolve(raw.dockerfile ? root : ctxAbs, raw.dockerfile ?? 'Dockerfile');
      const inCtx = path.relative(ctxAbs, dfAbs);
      const inRoot = path.relative(root, dfAbs);
      if (!inCtx.startsWith('..') && !path.isAbsolute(inCtx)) dockerfile = `${context}/${inCtx.split(path.sep).join('/')}`;
      else if (!inRoot.startsWith('..') && !path.isAbsolute(inRoot)) dockerfile = inRoot.split(path.sep).join('/');
      else throw new ConfigError(`${where}: the Dockerfile must be inside the project folder or inside its context ${ctxAbs}.`);
    } else {
      dockerfile = relInside(root, raw.dockerfile ?? (context === '.' ? 'Dockerfile' : `${context}/Dockerfile`), `${where} "dockerfile"`);
    }
    const buildArgs = {};
    if (raw.buildArgs !== undefined) {
      if (!raw.buildArgs || typeof raw.buildArgs !== 'object' || Array.isArray(raw.buildArgs)) {
        throw new ConfigError(`${where}: "buildArgs" must be an object of KEY: "value".`);
      }
      for (const [k, v] of Object.entries(raw.buildArgs)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ConfigError(`${where}: build arg "${k}" is not a valid name.`);
        buildArgs[k] = String(v);
      }
    }
    const buildArgsFile = raw.buildArgsFile ? relInside(root, raw.buildArgsFile, `${where} "buildArgsFile"`) : null;
    const buildArgsFromEnv = splitList(raw.buildArgsFromEnv);
    const localTag = raw.localTag ? String(raw.localTag).trim() : null;
    if (localTag && !LOCAL_TAG.test(localTag)) throw new ConfigError(`${where}: "localTag" "${localTag}" is not a valid image name.`);
    const push = raw.push === undefined ? true : Boolean(raw.push);
    if (!push && !localTag) throw new ConfigError(`${where} has "push": false and no "localTag", so nothing could use it.`);
    if (push) {
      if (pushedRepos.has(image)) {
        throw new ConfigError(`Images "${pushedRepos.get(image)}" and "${name}" both push to "${image}", so their tags (including :latest) would collide.`, {
          fix: `Give one a different "image" (e.g. "${image}-base"), or set "push": false on the one only used by a later FROM.`,
        });
      }
      pushedRepos.set(image, name);
    }
    return { name, image, dockerfile, context, external, buildArgs, buildArgsFile, buildArgsFromEnv, localTag, push };
  });
}

/** Image references a Dockerfile builds FROM (including COPY --from=). */
export function dockerfileBaseRefs(text) {
  const refs = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const from = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
    if (from) refs.add(from[1]);
    for (const m of line.matchAll(/--from=(\S+)/gi)) refs.add(m[1]);
  }
  return refs;
}

/**
 * Pick the images to build: all of them, or the `--only` names plus any earlier image whose
 * localTag they build FROM (so `--only app` also builds the base it needs). Keeps file order.
 * @param {ReturnType<typeof normaliseImages>} images
 * @param {string[]|null} only
 * @param {(dockerfile: string) => string} readDockerfile Returns the Dockerfile text ('' if missing).
 * @returns {{selected: typeof images, added: string[]}}
 */
export function selectImages(images, only, readDockerfile) {
  const byTag = new Map(images.filter((i) => i.localTag).map((i) => [i.localTag, i]));
  const deps = new Map();
  images.forEach((img, index) => {
    const needs = [];
    for (const ref of dockerfileBaseRefs(readDockerfile(img.dockerfile))) {
      const dep = byTag.get(ref);
      if (!dep || dep === img) continue;
      if (images.indexOf(dep) > index) {
        throw new ConfigError(`Image "${img.name}" builds FROM ${ref}, which image "${dep.name}" makes later in the list.`, {
          fix: `Move "${dep.name}" above "${img.name}" in ${PROJECT_FILE}; images are built in order.`,
        });
      }
      needs.push(dep.name);
    }
    deps.set(img.name, needs);
  });
  if (!only || only.length === 0) return { selected: images, added: [] };
  const names = new Set(images.map((i) => i.name));
  for (const n of only) {
    if (!names.has(n)) throw new ConfigError(`--only "${n}" is not an image in ${PROJECT_FILE}.`, { fix: `Images: ${[...names].join(', ')}.` });
  }
  const want = new Set();
  const visit = (n) => {
    if (want.has(n)) return;
    want.add(n);
    for (const d of deps.get(n) || []) visit(d);
  };
  only.forEach(visit);
  return { selected: images.filter((i) => want.has(i.name)), added: [...want].filter((n) => !only.includes(n)) };
}

/** Split a comma list flag ("a,b , c") into names. */
export function splitList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
}

/**
 * Validate and normalise the `deploy` section. Unknown keys are kept out; .env contents never go here.
 * @param {unknown} raw
 * @returns {object|null}
 */
export function normaliseDeploy(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`"deploy" in ${PROJECT_FILE} must be an object.`);
  const d = {};
  if (raw.server !== undefined) d.server = String(raw.server);
  if (raw.mode !== undefined) d.mode = canonicalMode(String(raw.mode));
  if (raw.transfer !== undefined) d.transfer = String(raw.transfer);
  if (raw.name !== undefined) d.name = String(raw.name);
  if (raw.image !== undefined) d.image = String(raw.image);
  if (raw.ports !== undefined) d.ports = splitList(raw.ports);
  if (raw.envFile !== undefined) d.envFile = String(raw.envFile);
  if (raw.healthUrl !== undefined) d.healthUrl = String(raw.healthUrl);
  if (raw.composeDir !== undefined) d.composeDir = String(raw.composeDir);
  if (raw.composeFile !== undefined) d.composeFile = String(raw.composeFile);
  if (raw.composeProject !== undefined) d.composeProject = String(raw.composeProject);
  if (raw.then !== undefined) d.then = String(raw.then);
  if (raw.only !== undefined) d.only = splitList(raw.only);
  if (raw.imageRefs !== undefined) d.imageRefs = splitList(raw.imageRefs);
  if (raw.images !== undefined) {
    if (!raw.images || typeof raw.images !== 'object' || Array.isArray(raw.images)) {
      throw new ConfigError(`"deploy.images" in ${PROJECT_FILE} must map image names to {"tagAs", "services"}.`);
    }
    d.images = {};
    for (const [name, v] of Object.entries(raw.images)) {
      const entry = typeof v === 'string' ? { tagAs: v } : v || {};
      d.images[name] = {};
      if (entry.tagAs) d.images[name].tagAs = String(entry.tagAs);
      if (entry.services) d.images[name].services = splitList(entry.services);
    }
  }
  return d;
}

/**
 * Check one deploy target's values (after flags and dockeriser.json are merged).
 * @param {object} t
 */
export function validateDeployTarget(t) {
  if (!DEPLOY_MODES.includes(t.mode)) throw new ConfigError(`Deploy mode "${t.mode}" is not one of ${DEPLOY_MODES.join(', ')}.`);
  if (!TRANSFERS.includes(t.transfer)) throw new ConfigError(`Transfer "${t.transfer}" is not one of ${TRANSFERS.join(', ')}.`);
  for (const p of t.ports || []) {
    if (!PORT.test(p)) throw new ConfigError(`Port mapping "${p}" is not valid.`, { fix: 'Use HOST:CONTAINER, e.g. -p 80:3000 (or 127.0.0.1:8080:3000, 53:53/udp).' });
  }
  if (t.mode === 'run' && t.name && !CONTAINER.test(t.name)) throw new ConfigError(`Container name "${t.name}" is not valid.`);
  if (t.healthUrl && !/^https?:\/\/\S+$/.test(t.healthUrl)) throw new ConfigError(`--health-url "${t.healthUrl}" must start with http:// or https://.`);
  if (t.mode === 'compose' && t.composeDir && !t.composeDir.startsWith('/')) throw new ConfigError(`--compose-dir "${t.composeDir}" must be an absolute path on the server.`);
  for (const item of t.items || []) {
    if (item.tagAs && !LOCAL_TAG.test(item.tagAs)) throw new ConfigError(`--tag-as "${item.tagAs}" is not a valid image name.`);
    for (const s of item.services || []) if (!SERVICE.test(s)) throw new ConfigError(`Service name "${s}" is not valid.`);
    if ((t.mode === 'compose' || t.mode === 'load-only') && !item.tagAs) {
      throw new ConfigError(`Mode "${t.mode}" needs a --tag-as name for ${item.label}, so the server's compose file can keep using its usual image name.`, {
        fix: `Pass --tag-as <name:tag>, or set "deploy.images.<name>.tagAs" in ${PROJECT_FILE}.`,
      });
    }
  }
  if (t.mode === 'compose') {
    if (!t.composeDir) throw new ConfigError('Mode "compose" needs --compose-dir (the folder on the server with the compose file).');
    if (!(t.items || []).some((i) => (i.services || []).length)) {
      throw new ConfigError('Mode "compose" needs the services to restart.', { fix: `Pass --service api,worker or set "deploy.images.<name>.services" in ${PROJECT_FILE}.` });
    }
  }
}

/**
 * Load and validate `<dir>/dockeriser.json`.
 * @param {string} dir
 * @returns {{file: string, root: string, exists: boolean, raw: object|null, source: 'dir'|'git',
 *   include: string[], images: ReturnType<typeof normaliseImages>, deploy: object|null}}
 */
export function loadProject(dir) {
  const root = path.resolve(dir);
  const { file, data } = readProjectFile(root);
  if (!data) return { file, root, exists: false, raw: null, source: 'dir', include: [], images: [], deploy: null };
  const source = data.source === undefined ? 'dir' : String(data.source);
  if (!['dir', 'git'].includes(source)) throw new ConfigError(`"source" in ${PROJECT_FILE} must be "dir" or "git".`);
  const include = splitList(data.include);
  return { file, root, exists: true, raw: data, source, include, images: normaliseImages(data.images, root), deploy: normaliseDeploy(data.deploy) };
}
