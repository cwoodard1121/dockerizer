/**
 * Saved servers and the default SSH key, in the per-user ~/.dockeriser/config.json:
 *   { "sshKey": "~/.ssh/id_ed25519", "servers": { "prod": { "host": "root@203.0.113.10", "port": 22, "key": "...", "transfer": "ssh" } } }
 * A deploy target can be a saved name or a raw `user@host` (or a ~/.ssh/config Host alias).
 */

import fs from 'node:fs';
import path from 'node:path';
import { configDir, readConfigFile, userHome } from './config.js';
import { ConfigError } from './errors.js';
import { checkHost } from './ssh.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Path of the per-user config file. */
export function configFile(homeDir = userHome()) {
  return path.join(configDir(homeDir), 'config.json');
}

/** Read the whole config file ({} when missing). */
export function readUserConfig(homeDir = userHome()) {
  return readConfigFile(configFile(homeDir));
}

/** Merge `patch` into the config file and write it back (BOM-less UTF-8, 2-space JSON). */
export function updateUserConfig(homeDir, patch) {
  const file = configFile(homeDir);
  const data = { ...readConfigFile(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/** Validate a server name. */
export function checkServerName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new ConfigError(`"${name}" is not a valid server name.`, { fix: 'Use letters, digits, ".", "_" or "-", e.g. prod or web-1.' });
  }
  return name;
}

/**
 * Resolve a deploy target to connection settings.
 * @param {string} target Saved server name, or user@host / ssh alias.
 * @param {{homeDir?: string, env?: Record<string, string|undefined>, flags?: {key?: string, port?: string}}} [opts]
 * @returns {{name: string|null, host: string, port?: number, key?: string, transfer: 'ssh'|'pull', keyId?: string, saved: boolean}}
 */
export function resolveServer(target, { homeDir = userHome(), env = process.env, flags = {} } = {}) {
  if (!target) {
    throw new ConfigError('No server given.', { fix: 'Pass --to <server> (a name from `dockeriser server list`, or user@host), or set "deploy.server" in dockeriser.json.' });
  }
  const cfg = readUserConfig(homeDir);
  const servers = cfg.servers || {};
  const defaultKey = flags.key || env.DOCKERISER_SSH_KEY || cfg.sshKey || undefined;
  if (Object.prototype.hasOwnProperty.call(servers, target)) {
    const s = servers[target];
    return {
      name: target,
      host: checkHost(s.host),
      port: flags.port ? Number(flags.port) : s.port,
      key: flags.key || s.key || defaultKey,
      transfer: s.transfer || 'ssh',
      keyId: s.keyId,
      saved: true,
    };
  }
  // Not a saved name: a raw user@host, or a Host alias from ~/.ssh/config.
  return { name: null, host: checkHost(target), port: flags.port ? Number(flags.port) : undefined, key: defaultKey, transfer: 'ssh', saved: false };
}

/** List saved servers (no secrets are stored, so all fields are safe to print). */
export function listServers(homeDir = userHome()) {
  const cfg = readUserConfig(homeDir);
  return { sshKey: cfg.sshKey || null, servers: Object.entries(cfg.servers || {}).map(([name, s]) => ({ name, ...s })) };
}

/** Save (add or replace) one server. */
export function saveServer(homeDir, name, server) {
  const cfg = readUserConfig(homeDir);
  const servers = { ...(cfg.servers || {}) };
  servers[checkServerName(name)] = Object.fromEntries(Object.entries(server).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return updateUserConfig(homeDir, { servers });
}

/** Remove one saved server. */
export function removeServer(homeDir, name) {
  const cfg = readUserConfig(homeDir);
  const servers = { ...(cfg.servers || {}) };
  if (!servers[name]) throw new ConfigError(`No saved server called "${name}".`, { fix: 'See `dockeriser server list`.' });
  delete servers[name];
  return updateUserConfig(homeDir, { servers });
}
