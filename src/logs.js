/**
 * Live build logs. Cloud Build writes log-<BUILD_ID>.txt into the logs bucket while the build
 * runs; we read only the bytes we have not seen yet (HTTP range reads), the same way
 * `gcloud builds submit` streams logs.
 */

import fs from 'node:fs';
import { isTransient } from './errors.js';

const TERMINAL_LINE = /^(DONE|ERROR\b.*)$/;

/** Promise-based sleep. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LogTailer {
  /**
   * @param {object} opts
   * @param {import('@google-cloud/storage').Storage} opts.storage Injected Storage client.
   * @param {string} opts.bucket Logs bucket name (no gs://).
   * @param {string} opts.buildId
   * @param {(text: string) => void} opts.onText Receives each new chunk of log text.
   * @param {string} [opts.logFile] Every byte read is appended here (the full log).
   * @param {(msg: string) => void} [opts.onWarn] Told once if logs cannot be read.
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {number} [opts.intervalMs=1500]
   * @param {number} [opts.ringSize=200] How many trailing lines to keep for error reports.
   */
  constructor({ storage, bucket, buildId, onText, logFile, onWarn = () => {}, sleep: sleepFn = sleep, intervalMs = 1500, ringSize = 200 }) {
    this.file = storage.bucket(bucket).file(`log-${buildId}.txt`);
    this.onText = onText;
    this.logFile = logFile;
    this.onWarn = onWarn;
    this.sleep = sleepFn;
    this.intervalMs = intervalMs;
    this.ringSize = ringSize;
    this.offset = 0;
    this.lines = [];
    this.partial = '';
    this.decoder = new TextDecoder('utf-8');
    this.disabled = false;
    this.stopped = false;
    this.loop = null;
    this.wake = null;
    if (logFile) fs.writeFileSync(logFile, '');
  }

  /**
   * Fetch any bytes past the current offset.
   * @returns {Promise<number>} Number of new bytes (0 when nothing new or not readable yet).
   */
  async readOnce() {
    if (this.disabled) return 0;
    let buf;
    try {
      [buf] = await this.file.download({ start: this.offset, validation: false });
    } catch (err) {
      // 404: log object not created yet. 416: no bytes past our offset yet.
      if (err?.code === 404 || err?.code === 416 || isTransient(err)) return 0;
      this.disabled = true;
      const hint = err?.code === 403 ? ' The account needs read access to the logs bucket (roles/storage.admin on it; re-run setup).' : '';
      this.onWarn(`Live logs unavailable (${err?.message || err}).${hint} The build keeps running; status is still tracked.`);
      return 0;
    }
    if (!buf?.length) return 0;
    this.offset += buf.length;
    if (this.logFile) fs.appendFileSync(this.logFile, buf);
    const text = this.decoder.decode(buf, { stream: true });
    if (text) {
      this.remember(text);
      this.onText(text);
    }
    return buf.length;
  }

  /** Keep the last `ringSize` complete lines plus the current partial line. */
  remember(text) {
    const parts = (this.partial + text).split(/\r?\n/);
    this.partial = parts.pop();
    this.lines.push(...parts);
    if (this.lines.length > this.ringSize) this.lines.splice(0, this.lines.length - this.ringSize);
  }

  /**
   * The last `n` lines seen.
   * @param {number} [n=50]
   * @returns {string[]}
   */
  tail(n = 50) {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-n);
  }

  /** True once the log ends with Cloud Build's closing DONE/ERROR line. */
  sawEnd() {
    const last = this.tail(1)[0];
    return last !== undefined && TERMINAL_LINE.test(last.trim());
  }

  /** Start polling in the background. */
  start() {
    this.loop = (async () => {
      while (!this.stopped) {
        await this.readOnce();
        if (this.stopped) break;
        await Promise.race([this.sleep(this.intervalMs), new Promise((resolve) => (this.wake = resolve))]);
      }
    })();
    return this;
  }

  /** Stop polling and wait for any in-flight read to finish. */
  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  /**
   * After the build is finished: read until the closing line shows up and nothing new arrives,
   * retrying a few times because the last flush can land a moment after the status changes.
   * @param {{attempts?: number, delayMs?: number}} [opts]
   */
  async drain({ attempts = 5, delayMs = 1000 } = {}) {
    await this.stop();
    for (let i = 0; i < attempts; i++) {
      const got = await this.readOnce();
      if (this.disabled || (got === 0 && this.sawEnd())) break;
      if (i < attempts - 1) await this.sleep(got ? 0 : delayMs);
    }
    const rest = this.decoder.decode();
    if (rest) {
      this.remember(rest);
      this.onText(rest);
    }
  }
}
