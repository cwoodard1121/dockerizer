#!/usr/bin/env node
/**
 * Claude Code SessionStart hook for the dockeriser plugin.
 * Reads local state only (no network), injects one short note for the agent, always exits 0.
 *
 * Finding the CLI: marketplace installs copy only plugin/ into
 * <config>/plugins/cache/<marketplace>/dockeriser/<version>/, so the plugin's parent is not a
 * checkout. We try, in order: $DOCKERISER_HOME (any checkout you point it at), the plugin's parent
 * folder (directory marketplace / running from the repo), then the full git clone Claude Code keeps
 * at <config>/plugins/marketplaces/dockerizer/. Nothing user-specific is hardcoded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_URL = 'https://github.com/cwoodard1121/dockerizer';
export const MARKETPLACE = 'cwoodard1121/dockerizer';

/**
 * Candidate checkout folders, best first.
 * @param {string} pluginRoot
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function candidateRoots(pluginRoot, env = process.env) {
  return [
    ...(env.DOCKERISER_HOME ? [path.resolve(env.DOCKERISER_HOME)] : []),
    path.resolve(pluginRoot, '..'),
    // <config>/plugins/cache/<marketplace>/<plugin>/<version> -> <config>/plugins/marketplaces/dockerizer
    path.resolve(pluginRoot, '..', '..', '..', '..', 'marketplaces', 'dockerizer'),
  ];
}

/**
 * Pick the checkout to use: one with dependencies installed wins, else any with the CLI.
 * @param {string[]} roots
 * @returns {{root: string, installed: boolean}|null}
 */
export function pickRoot(roots) {
  const withCli = roots.filter((r) => fs.existsSync(path.join(r, 'bin', 'dockeriser.js')) && fs.existsSync(path.join(r, 'src', 'status.js')));
  const ready = withCli.find((r) => fs.existsSync(path.join(r, 'node_modules', '@google-cloud', 'cloudbuild')));
  if (ready) return { root: ready, installed: true };
  return withCli.length ? { root: withCli[0], installed: false } : null;
}

/**
 * Build the context text for the agent.
 * @param {object} opts
 * @param {string} opts.pluginRoot
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.homeDir]
 * @returns {Promise<string>}
 */
export async function buildContext({ pluginRoot, env = process.env, homeDir }) {
  const picked = pickRoot(candidateRoots(pluginRoot, env));
  if (!picked) {
    return [
      'dockeriser (Docker builds on Google Cloud Build) is installed as a plugin, but its CLI was not found.',
      `Don't run local \`docker build\`. Tell the user to add the marketplace in Claude Code (/plugin marketplace add ${MARKETPLACE}),`,
      `or to clone ${REPO_URL} anywhere and set DOCKERISER_HOME to that folder.`,
    ].join('\n');
  }
  const status = await import(pathToFileURL(path.join(picked.root, 'src', 'status.js')).href);
  const s = status.getOfflineStatus({ env, ...(homeDir ? { homeDir } : {}) });
  const cli = path.join(picked.root, 'bin', 'dockeriser.js').replace(/\\/g, '/');
  const install = picked.installed ? '' : `\nFirst run once: cd "${picked.root}" && npm install --omit=dev (the /dockeriser:* commands do this themselves)`;
  if (!s.ready) {
    return [
      "dockeriser (Docker builds on Google Cloud Build) is not signed in. Don't run local `docker build`. Tell the user to run (or use /dockeriser:setup):",
      status.formatSteps(status.nextSteps(s)),
    ].join('\n') + install;
  }
  const usage = s.usage?.line ? ` ${s.usage.line}` : '';
  const ci = s.ci?.line ? ` ${s.ci.line}.` : '';
  return `Docker builds: use dockeriser, not local docker build (node "${cli}" build <dir> --image <name> --json, or /dockeriser:build). Deploy only when the user asks.${usage} Heavy test gates (full check, integration, e2e): node "${cli}" ci <dir> --json (or /dockeriser:ci) runs the "ci" steps of dockeriser.json on a cloud VM instead of this PC, about 3 cents a run.${ci}${install}`;
}

async function main() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const additionalContext = await buildContext({ pluginRoot });
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
  } catch {
    // A broken hook must never block a session.
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
