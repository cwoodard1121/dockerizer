/**
 * `dockeriser init`: look at a project and write a starter dockeriser.json.
 * Finds Dockerfiles, compose files (service -> build/image mapping) and existing ship scripts that
 * do `docker save ... | ssh ... docker load`, and prints what to check. Local files only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_FILE, dockerfileBaseRefs } from './project.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', '.venv', 'venv', '__pycache__', 'coverage', 'target', '.turbo', '.cache']);
const DOCKERFILE = /^(?:Dockerfile(?:\..+)?|.+\.[Dd]ockerfile)$/;
const COMPOSE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;
const SCRIPT = /\.(?:sh|bash|ps1|mjs|cjs|js|ts)$|^Makefile$|^justfile$/;
const PUBLIC_ARG = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_)/;
const SHA_ARG = /^(GIT_SHA|GIT_COMMIT|COMMIT_SHA|COMMIT|REVISION|SOURCE_COMMIT|BUILD_SHA)$/;

/** Walk the project (depth-limited), returning POSIX relative paths of interesting files. */
export function scanFiles(root, { maxDepth = 4 } = {}) {
  const found = { dockerfiles: [], compose: [], scripts: [], envFiles: [] };
  const walk = (abs, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.deploy')) walk(path.join(abs, e.name), r, depth + 1);
      } else if (e.isFile()) {
        if (DOCKERFILE.test(e.name) && !e.name.endsWith('.dockerignore')) found.dockerfiles.push(r);
        else if (COMPOSE.test(e.name)) found.compose.push(r);
        else if (depth <= 2 && SCRIPT.test(e.name)) found.scripts.push(r);
        if (depth === 0 && /^\.env(\..+)?$/.test(e.name) && !/example|sample|template/.test(e.name)) found.envFiles.push(r);
      }
    }
  };
  walk(root, '', 0);
  for (const k of Object.keys(found)) found[k].sort();
  return found;
}

/**
 * Minimal compose reader: services with their `image` and `build` (context, dockerfile).
 * Handles the common block style; anything unusual is simply skipped.
 * @param {string} text
 * @returns {Array<{service: string, image?: string, context?: string, dockerfile?: string}>}
 */
export function parseCompose(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inServices = false;
  let svcIndent = -1;
  let current = null;
  let inBuild = false;
  let buildIndent = -1;
  const val = (s) => s.trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inServices = line === 'services:';
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (svcIndent < 0) svcIndent = indent;
    if (indent === svcIndent) {
      const m = line.match(/^([A-Za-z0-9._-]+):\s*$/);
      current = m ? { service: m[1] } : null;
      if (current) out.push(current);
      inBuild = false;
      continue;
    }
    if (!current) continue;
    if (inBuild && indent <= buildIndent) inBuild = false;
    let m;
    if (!inBuild && (m = line.match(/^image:\s*(.+)$/))) current.image = val(m[1]);
    else if (!inBuild && (m = line.match(/^build:\s*(.*)$/))) {
      if (m[1].trim()) current.context = val(m[1]);
      else {
        inBuild = true;
        buildIndent = indent;
        current.context = current.context || '.';
      }
    } else if (inBuild && (m = line.match(/^context:\s*(.+)$/))) current.context = val(m[1]);
    else if (inBuild && (m = line.match(/^dockerfile:\s*(.+)$/))) current.dockerfile = val(m[1]);
  }
  return out;
}

/** Find `docker save ... | ... docker load` in a script. */
export function findShipLines(text) {
  if (!/docker\s+save/.test(text) || !/docker\s+load/.test(text)) return [];
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/docker\s+save/.test(line)) {
      const after = line.split(/docker\s+save/)[1].split('|')[0];
      const images = after.split(/\s+/).filter((t) => t && !t.startsWith('-') && !t.startsWith('>'));
      hits.push({ line: i + 1, text: line.trim(), images });
    }
  });
  return hits;
}

/** Lowercase, docker-safe name. */
export function safeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'app';
}

/** Strip registry and tag from an image ref: "ghcr.io/me/web:1" -> "web". */
const repoName = (ref) => ref.split('@')[0].replace(/:[^/:]+$/, '').split('/').pop();

/**
 * Build the starter config and notes.
 * @param {string} root
 * @returns {{config: object, notes: string[], shipScripts: Array<{file: string, line: number, text: string, suggestion: string}>, found: object}}
 */
export function suggestConfig(root) {
  const found = scanFiles(root);
  const projectName = safeName(path.basename(root));
  const notes = [];
  const images = [];
  const deployImages = {};
  const used = new Set();
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return '';
    }
  };
  const uniq = (n) => {
    let name = n;
    for (let i = 2; used.has(name); i++) name = `${n}-${i}`;
    used.add(name);
    return name;
  };

  // 1. Compose services that build an image.
  let composeFile = null;
  let composeServices = [];
  for (const file of found.compose) {
    const services = parseCompose(read(file));
    if (!services.length) continue;
    composeFile = composeFile || file;
    composeServices = composeServices.length ? composeServices : services.map((s) => ({ ...s, file }));
    const dir = path.posix.dirname(file);
    for (const s of services.filter((x) => x.context !== undefined)) {
      const context = path.posix.normalize(path.posix.join(dir, s.context));
      if (context.startsWith('..')) {
        notes.push(`compose service "${s.service}" builds from ${context}, outside this folder; it is listed with that context (packed under _ctx/).`);
      }
      const dockerfile = path.posix.normalize(path.posix.join(context, s.dockerfile || 'Dockerfile'));
      if (images.some((i) => i.dockerfile === dockerfile && i.context === context)) {
        const existing = images.find((i) => i.dockerfile === dockerfile && i.context === context);
        if (s.image) (deployImages[existing.name] ||= { services: [] }).services.push(s.service);
        continue;
      }
      const name = uniq(safeName(s.service));
      images.push({ name, image: safeName(s.image ? repoName(s.image) : `${projectName}-${s.service}`), dockerfile, context });
      deployImages[name] = { ...(s.image ? { tagAs: s.image } : {}), services: [s.service] };
    }
  }

  // 2. Dockerfiles not already covered by compose.
  for (const df of found.dockerfiles) {
    if (images.some((i) => i.dockerfile === df)) continue;
    const base = path.posix.basename(df);
    const dir = path.posix.dirname(df);
    let name;
    let context;
    if (base === 'Dockerfile') {
      name = dir === '.' ? projectName : safeName(path.posix.basename(dir));
      context = dir;
    } else {
      name = safeName(base.replace(/^Dockerfile\./, '').replace(/\.[Dd]ockerfile$/, ''));
      context = '.';
      notes.push(`${df}: context guessed as the project folder; change "context" if it builds from ${dir}.`);
    }
    images.push({ name: uniq(name), image: safeName(name === projectName ? name : `${projectName}-${name}`), dockerfile: df, context });
  }

  // 3. Build args, chained FROMs.
  const envFile = found.envFiles.find((f) => /\.env\.(local|production)$/.test(f)) || found.envFiles.find((f) => f === '.env') || null;
  for (const img of images) {
    const text = read(img.dockerfile);
    const args = [...text.matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
    const pub = [...new Set(args.filter((a) => PUBLIC_ARG.test(a)).map((a) => `${a.match(PUBLIC_ARG)[1]}*`))];
    if (pub.length) {
      img.buildArgsFromEnv = pub;
      if (envFile) img.buildArgsFile = envFile;
      notes.push(`image "${img.name}" takes public build args (${pub.join(', ')}); only those are sent${envFile ? `, read from ${envFile}` : ' (from this PC\'s environment)'}. Build args are visible in the Cloud Build console, so never put secrets in them.`);
    }
    const sha = args.filter((a) => SHA_ARG.test(a));
    if (sha.length) img.buildArgs = Object.fromEntries(sha.map((a) => [a, '${git.sha}']));
    for (const ref of dockerfileBaseRefs(text)) {
      const dep = images.find((o) => o !== img && (o.image === repoName(ref) || ref.startsWith(`${o.image}:`)));
      if (dep && !ref.includes('/')) {
        dep.localTag = ref;
        notes.push(`image "${img.name}" builds FROM ${ref}; "${dep.name}" now gets "localTag": "${ref}" and must come first.`);
      }
    }
  }

  // 4. Existing ship scripts.
  const shipScripts = [];
  for (const file of found.scripts) {
    for (const hit of findShipLines(read(file))) {
      const tagAs = hit.images.filter((t) => !t.includes('$')).map((t) => {
        const match = images.find((i) => i.image === safeName(repoName(t)) || repoName(t).includes(i.name));
        return `${match ? match.name : safeName(repoName(t))}=${t}`;
      });
      const suggestion = `dockeriser deploy --to <server> --mode load-only ${tagAs.map((t) => `--tag-as ${t}`).join(' ') || '--tag-as <image>=<name:tag>'} --then "cd /opt/${projectName} && <the remote steps your script runs after docker load>"`;
      shipScripts.push({ file, line: hit.line, text: hit.text, suggestion });
      for (const t of tagAs) {
        const [n, ref] = t.split('=');
        if (images.some((i) => i.name === n)) (deployImages[n] ||= {}).tagAs = ref;
      }
    }
  }

  images.sort((a, b) => (b.localTag ? 1 : 0) - (a.localTag ? 1 : 0)); // local bases build first
  const config = {};
  if (images.length > 1 || images.some((i) => i.localTag || i.buildArgsFromEnv || i.buildArgs || i.context !== '.' || i.dockerfile !== 'Dockerfile')) {
    config.images = images.map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)));
  } else if (images.length === 1) {
    config.images = [{ name: images[0].name, image: images[0].image }];
  }
  if (shipScripts.length) {
    config.deploy = { mode: 'load-only', images: Object.fromEntries(Object.entries(deployImages).filter(([, v]) => v.tagAs).map(([k, v]) => [k, { tagAs: v.tagAs }])) };
    config.deploy.then = `cd /opt/${projectName} && <the remote steps your script runs after docker load>`;
  } else if (composeFile && Object.values(deployImages).some((v) => v.tagAs)) {
    config.deploy = {
      mode: 'compose',
      composeDir: `/opt/${projectName}`,
      images: Object.fromEntries(Object.entries(deployImages).filter(([, v]) => v.tagAs).map(([k, v]) => [k, v])),
    };
    if (path.posix.basename(composeFile) !== 'compose.yml' && path.posix.basename(composeFile) !== 'docker-compose.yml') config.deploy.composeFile = path.posix.basename(composeFile);
  } else if (images.length === 1) {
    config.deploy = { mode: 'run', name: images[0].name };
  }
  if (!images.length) notes.push('No Dockerfile found. Add one (or pass --dockerfile to `dockeriser build`) before building.');
  return { config, notes, shipScripts, found };
}

/** Write (or show) the suggested config. */
export function runInit({ dir, force = false, dryRun = false }) {
  const root = path.resolve(dir);
  const file = path.join(root, PROJECT_FILE);
  const { config, notes, shipScripts, found } = suggestConfig(root);
  const exists = fs.existsSync(file);
  let written = false;
  if (!dryRun && (!exists || force)) {
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    written = true;
  }
  return { file, exists, written, config, notes, shipScripts, found };
}
