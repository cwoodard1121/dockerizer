/**
 * SSH plumbing for servers: builds ssh command lines and runs them through an injectable runner.
 * Uses the system OpenSSH client with key auth only (BatchMode, so it never prompts), and leaves
 * ~/.ssh/config in charge of anything not given explicitly (user, port, key, host aliases).
 */

import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthError, ConfigError, DockeriserError } from './errors.js';

/** Quote a value for a POSIX shell (single quotes, safe for any content). */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The ssh executable: Windows' built-in OpenSSH when present, else `ssh` from PATH. */
export function defaultSshPath({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.DOCKERISER_SSH) return env.DOCKERISER_SSH;
  if (platform === 'win32') {
    const builtIn = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (exists(builtIn)) return builtIn;
  }
  return 'ssh';
}

/** Expand a leading ~ in a key path. */
export function expandHome(p, homeDir = os.homedir()) {
  if (!p) return p;
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(homeDir, p.slice(2)) : p;
}

/**
 * Validate a `user@host` / `host` / ssh-config alias.
 * @param {string} host
 */
export function checkHost(host) {
  if (typeof host !== 'string' || !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._:\-[\]]+$/.test(host) || host.startsWith('-')) {
    throw new ConfigError(`--host "${host}" is not a valid ssh destination.`, { fix: 'Use user@ip-or-hostname, e.g. root@203.0.113.10, or a Host alias from ~/.ssh/config.' });
  }
  return host;
}

/**
 * ssh arguments (everything before the remote command).
 * @param {{host: string, port?: number|string, key?: string}} server
 * @param {{connectTimeout?: number, homeDir?: string}} [opts]
 * @returns {string[]}
 */
export function sshArgs(server, { connectTimeout = 15, homeDir } = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15'];
  if (server.port !== undefined && server.port !== null && String(server.port) !== '') {
    const port = Number(server.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`Port "${server.port}" is not valid.`);
    args.push('-p', String(port));
  }
  if (server.key) args.push('-i', expandHome(server.key, homeDir), '-o', 'IdentitiesOnly=yes');
  args.push(checkHost(server.host));
  return args;
}

/**
 * Turn a failed ssh run into a friendly error (exit 255 is ssh's own failure).
 * @param {{code: number, stderr: string}} res
 * @param {{name?: string, host: string, key?: string}} server
 * @returns {DockeriserError}
 */
export function sshError(res, server) {
  const err = res.stderr || '';
  const keyHint = server.key ? `${server.key}.pub` : '~/.ssh/id_ed25519.pub';
  if (/Permission denied|Too many authentication failures|no mutual signature/i.test(err)) {
    return new AuthError(`The server ${server.host} did not accept the SSH key.`, {
      fix: `Add your public key to the server: ssh-copy-id ${server.key ? `-i ${server.key} ` : ''}${server.host}   or paste the contents of ${keyHint} into ~/.ssh/authorized_keys on the server (DigitalOcean: Settings > Security > SSH keys, or the droplet's Access console). Make one with ssh-keygen -t ed25519 if you have none.`,
    });
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(err)) {
    return new AuthError(`The host key of ${server.host} does not match the one in your known_hosts.`, {
      fix: 'If the server was rebuilt, remove the old entry with: ssh-keygen -R <host>  then try again.',
    });
  }
  if (/Could not resolve hostname|Name or service not known/i.test(err)) {
    return new ConfigError(`The host name in ${server.host} could not be found.`, { fix: 'Check the IP or host name.' });
  }
  if (/timed out|Connection refused|No route to host|Connection reset|closed by remote host/i.test(err)) {
    return new DockeriserError(`Could not connect to ${server.host} over SSH (${err.trim().split('\n').pop()}).`, {
      fix: 'Check the server is on, the IP is right, and port 22 (or --port) is open in its firewall. If it rate-limits SSH, wait 30 seconds.',
    });
  }
  return new DockeriserError(`SSH to ${server.host} failed with exit code ${res.code}: ${err.trim().split('\n').slice(-3).join(' ')}`);
}

/**
 * Real runner: spawns ssh, writes `input` (string, Buffer or readable stream) to its stdin, and
 * streams output through the callbacks while also collecting it.
 * @param {{spawn?: typeof realSpawn, sshPath?: string, homeDir?: string}} [opts]
 */
export function createSshRunner({ spawn = realSpawn, sshPath = defaultSshPath(), homeDir } = {}) {
  return {
    /**
     * @param {{host: string, port?: number, key?: string}} server
     * @param {string} remoteCommand Run by the remote user's shell.
     * @param {{input?: string|Buffer|NodeJS.ReadableStream, onStdout?: (s: string) => void, onStderr?: (s: string) => void, interactive?: boolean}} [opts]
     * @returns {Promise<{code: number, stdout: string, stderr: string}>}
     */
    exec(server, remoteCommand, { input, onStdout = () => {}, onStderr = () => {}, interactive = false } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(sshPath, [...sshArgs(server, { homeDir }), remoteCommand], {
          stdio: [interactive ? 'inherit' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => {
          stdout += d;
          onStdout(d);
        });
        child.stderr.on('data', (d) => {
          stderr += d;
          onStderr(d);
        });
        child.on('error', (err) => {
          if (err.code === 'ENOENT') reject(new ConfigError(`ssh was not found (${sshPath}).`, { fix: 'Install the OpenSSH client (Windows: Settings > System > Optional features > OpenSSH Client).' }));
          else reject(err);
        });
        child.on('close', (code) => resolve({ code: code ?? 255, stdout, stderr }));
        if (!interactive) {
          child.stdin.on('error', () => {}); // EPIPE when the remote side exits early; the exit code tells the story
          if (input === undefined || input === null) child.stdin.end();
          else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
          else {
            input.on('error', (err) => {
              child.stdin.destroy();
              child.kill();
              reject(err);
            });
            input.pipe(child.stdin);
          }
        }
      });
    },
  };
}
