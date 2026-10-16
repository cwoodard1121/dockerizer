#!/usr/bin/env node
/**
 * Plugin launcher: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" <dockeriser args>`.
 * Finds the dockeriser checkout the same way the SessionStart hook does ($DOCKERISER_HOME, the
 * plugin's parent folder, then the marketplace clone), runs `npm install --omit=dev` there once if
 * the Node packages are missing, then runs the CLI with the given arguments and its exit code.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateRoots, pickRoot, REPO_URL, MARKETPLACE } from '../hooks/session-start.js';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const picked = pickRoot(candidateRoots(pluginRoot, process.env));

if (!picked) {
  process.stderr.write(
    `The dockeriser CLI was not found. In Claude Code run /plugin marketplace add ${MARKETPLACE} (it keeps a copy),\nor clone ${REPO_URL} anywhere and set DOCKERISER_HOME to that folder.\n`,
  );
  process.exit(2);
}

if (!picked.installed || !fs.existsSync(path.join(picked.root, 'node_modules'))) {
  process.stderr.write(`Installing dockeriser's Node packages in ${picked.root} (one time)...\n`);
  const npm = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: picked.root,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32', // npm is a .cmd script on Windows
  });
  if (npm.status !== 0) {
    process.stderr.write(`npm install failed in ${picked.root}. Run it there by hand, then try again.\n`);
    process.exit(2);
  }
}

const res = spawnSync(process.execPath, [path.join(picked.root, 'bin', 'dockeriser.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
