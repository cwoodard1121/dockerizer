/**
 * Per-user deploy settings for a project folder, kept in ~/.dockeriser/projects/ so a deploy never
 * writes into the repo (release tools refuse a dirty checkout). One file per folder:
 *   { "root": "<absolute folder>", "deploy": { <same keys as the dockeriser.json "deploy" section> }, "savedAt": "<ISO>" }
 * A "deploy" section in dockeriser.json, when present, wins over this file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir, readConfigFile } from './config.js';

/**
 * Path of the settings file for a project folder: <name>-<8 hex of the absolute path>.json.
 * @param {string} homeDir
 * @param {string} root Project folder.
 * @param {Record<string, string|undefined>} [env]
 */
export function stateFile(homeDir, root, env = process.env) {
  const abs = path.resolve(root);
  const id = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  const name = path.basename(abs).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return path.join(configDir(homeDir, env), 'projects', `${name}-${hash}.json`);
}

/**
 * Read the saved deploy section for a folder (null when none).
 * @param {string} homeDir
 * @param {string} root
 * @returns {{file: string, deploy: object|null}}
 */
export function readProjectState(homeDir, root) {
  const file = stateFile(homeDir, root);
  const data = readConfigFile(file);
  return { file, deploy: data.deploy && typeof data.deploy === 'object' ? data.deploy : null };
}

/**
 * Save the deploy section for a folder.
 * @param {string} homeDir
 * @param {string} root
 * @param {object} deploy
 * @param {Date} [now]
 * @returns {string} The file written.
 */
export function writeProjectState(homeDir, root, deploy, now = new Date()) {
  const file = stateFile(homeDir, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ root: path.resolve(root), deploy, savedAt: now.toISOString() }, null, 2)}\n`);
  return file;
}
