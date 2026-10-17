/**
 * `dockeriser ci init`: write a starter `ci` section into dockeriser.json. The steps come from the
 * repo's GitHub workflows (the `run:` steps in order; steps that only run on failure, always or when
 * cancelled are left out, and so are exact repeats), else from package.json scripts. Heuristic: the
 * output says to check the steps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_FILE, readProjectFile, writeProjectFile } from './project.js';

const CLEANUP_IF = /\b(failure|always|cancelled)\(\)/;

const unquote = (v) => {
  const t = v.trim();
  return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
};
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The `run:` commands of a workflow file, in order. A small line parser for the shape GitHub
 * workflows use (`- name:` / `run:` items, `run: |` blocks), not a full YAML parser.
 * @param {string} text
 * @returns {{steps: string[], skipped: Array<{run: string, if: string}>}}
 */
export function parseWorkflowRuns(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const items = [];
  let item = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = indentOf(line);
    const dash = /^(\s*)-\s+(.*)$/.exec(line);
    let body;
    if (dash) {
      item = { indent: dash[1].length, keyIndent: dash[1].length + 2, keys: {} };
      items.push(item);
      body = dash[2];
    } else if (item && ind === item.keyIndent) {
      body = line.trim();
    } else {
      if (item && ind <= item.indent) item = null;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(body);
    if (!kv) continue;
    const [, key, value] = kv;
    if (/^[|>][-+]?$/.test(value.trim())) {
      const block = [];
      let blockIndent = null;
      while (i + 1 < lines.length && (!lines[i + 1].trim() || indentOf(lines[i + 1]) > item.keyIndent)) {
        const next = lines[++i];
        if (!next.trim()) {
          block.push('');
          continue;
        }
        if (blockIndent === null) blockIndent = indentOf(next);
        block.push(next.slice(blockIndent));
      }
      item.keys[key] = block.join(value.trim().startsWith('>') ? ' ' : '\n').trim();
    } else {
      item.keys[key] = unquote(value);
    }
  }
  const steps = [];
  const skipped = [];
  for (const it of items) {
    const run = it.keys.run;
    if (!run) continue;
    if (it.keys.if && CLEANUP_IF.test(it.keys.if)) skipped.push({ run, if: it.keys.if });
    else steps.push(run);
  }
  return { steps, skipped };
}

/** Workflow files, sorted. */
function workflowFiles(root) {
  const dir = path.join(root, '.github', 'workflows');
  try {
    return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => `.github/workflows/${f}`);
  } catch {
    return [];
  }
}

/** Steps from package.json: install, then check (or lint/typecheck/test) and any e2e script. */
function packageSteps(root) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const scripts = pkg.scripts || {};
  const has = (f) => fs.existsSync(path.join(root, f));
  const [install, run] = has('pnpm-lock.yaml') ? ['pnpm install --frozen-lockfile', 'pnpm run'] : has('yarn.lock') ? ['yarn install --frozen-lockfile', 'yarn run'] : [has('package-lock.json') ? 'npm ci' : 'npm install', 'npm run'];
  const steps = [install];
  if (scripts.check) steps.push(`${run} check`);
  else for (const s of ['lint', 'typecheck']) if (scripts[s]) steps.push(`${run} ${s}`);
  if (!scripts.check && scripts.test) steps.push(run === 'npm run' ? 'npm test' : `${run} test`);
  for (const s of ['test:integration', 'test:e2e', 'e2e']) if (scripts[s]) steps.push(`${run} ${s}`);
  return steps;
}

/**
 * Work out a `ci` section and write it into dockeriser.json (unless one exists, or dryRun).
 * @param {{dir: string, force?: boolean, dryRun?: boolean}} opts
 * @returns {{file: string, written: boolean, exists: boolean, from: string|null, config: object|null, notes: string[]}}
 */
export function runCiInit({ dir, force = false, dryRun = false }) {
  const root = path.resolve(dir);
  const { file, data } = readProjectFile(root);
  const notes = [];
  let steps = [];
  let from = null;
  for (const wf of workflowFiles(root)) {
    const parsed = parseWorkflowRuns(fs.readFileSync(path.join(root, wf), 'utf8'));
    if (!parsed.steps.length) continue;
    from = from ? `${from}, ${wf}` : wf;
    steps.push(...parsed.steps);
    for (const s of parsed.skipped) notes.push(`left out (${wf}, runs only on "${s.if}"): ${s.run.split('\n')[0]}`);
  }
  if (steps.length) {
    const before = steps.length;
    steps = [...new Set(steps)];
    if (steps.length < before) notes.push(`dropped ${before - steps.length} repeated step(s) (one VM runs every job's steps once, in order)`);
    notes.push('steps that use GitHub actions (uses:) were left out: Node comes from .node-version/.nvmrc, and Docker is installed on the VM');
  } else {
    steps = packageSteps(root) || [];
    if (steps.length) from = 'package.json';
  }
  if (!steps.length) {
    notes.push('no GitHub workflow run: steps and no package.json found; write "ci": {"steps": [...]} by hand');
    return { file, written: false, exists: Boolean(data?.ci), from: null, config: null, notes };
  }
  const config = { steps };
  const exists = Boolean(data?.ci);
  const written = !dryRun && (!exists || force);
  if (written) writeProjectFile(file, { ...(data || {}), ci: config });
  if (!fs.existsSync(path.join(root, '.node-version')) && !fs.existsSync(path.join(root, '.nvmrc'))) notes.push('no .node-version or .nvmrc: the VM installs the latest Node LTS (set "ci.node" to pin one)');
  return { file: file || path.join(root, PROJECT_FILE), written, exists, from, config, notes };
}
