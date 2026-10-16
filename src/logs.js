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

/**
 * A function that returns the bytes of a Cloud Storage object from `start` onwards.
 *
 * It calls the JSON API with a Range header through the Storage client's auth client: one plain
 * request per poll, no retries. We deliberately do not use `file.download()`: that goes through the
 * library's streaming and retry machinery (teeny-request + retry-request), which re-pipes each retry
 * of a failed request into the same PassThrough. Polling every 1.5s against an object that is not there
 * yet (404), has nothing new (416) or is busy (429/503) built up error listeners on that stream
 * (MaxListenersExceededWarning), and a retried 503 can even crash with ERR_STREAM_UNABLE_TO_PIPE.
 *
 * @param {import('@google-cloud/storage').Storage} storage
 * @param {string} bucket
 * @param {string} object
 * @returns {(start: number) => Promise<Buffer>} Rejects with `err.code` set to the HTTP status.
 */
export function createRangeReader(storage, bucket, object) {
  const base = (storage.apiEndpoint || 'https://storage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  return async (start) => {
    let res;
    try {
      res = await storage.authClient.request({
        url,
        headers: { Range: `bytes=${start}-`, 'Accept-Encoding': 'identity' },
        responseType: 'arraybuffer',
        retry: false,
      });
    } catch (err) {
      const status = err?.response?.status ?? err?.status;
      if (typeof status === 'number') err.code = status;
      throw err;
    }
    const buf = Buffer.from(res.data);
    // A server that ignores Range answers 200 with the whole object.
    return res.status === 200 && start > 0 ? buf.subarray(start) : buf;
  };
}

export class LogTailer {
  /**
   * @param {object} opts
   * @param {import('@google-cloud/storage').Storage} [opts.storage] Storage client (used to build the reader).
   * @param {(start: number) => Promise<Buffer>} [opts.reader] Range reader; defaults to createRangeReader(storage, ...).
   * @param {string} opts.bucket Logs bucket name (no gs://).
   * @param {string} opts.buildId
   * @param {(text: string) => void} opts.onText Receives each new chunk of log text.
   * @param {string} [opts.logFile] Every byte read is appended here (the full log).
   * @param {(msg: string) => void} [opts.onWarn] Told once if logs cannot be read.
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {number} [opts.intervalMs=1500]
   * @param {number} [opts.ringSize=200] How many trailing lines to keep for error reports.
   */
  constructor({ storage, reader, bucket, buildId, onText, logFile, onWarn = () => {}, sleep: sleepFn = sleep, intervalMs = 1500, ringSize = 200 }) {
    this.read = reader || createRangeReader(storage, bucket, `log-${buildId}.txt`);
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
      buf = await this.read(this.offset);
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
