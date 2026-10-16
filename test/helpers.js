import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

/** Make a temp folder with the given files ({relPath: contents}). */
export function tempTree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockeriser-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

/** Writable that collects everything written to it. */
export function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.text = () => chunks.join('');
  return stream;
}

/** Yield to the event loop (lets polling loops interleave in tests). */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Fake Storage for the log tailer: answers the JSON-API range requests made through
 * `storage.authClient.request`. `contents(callNumber, start)` returns the whole object so far
 * (string), or an HTTP status number to fail with (404, 403, 503...).
 */
export function gcsLogStorage(contents) {
  const calls = [];
  const storage = {
    authClient: {
      request: async ({ url, headers }) => {
        const start = Number(headers.Range.match(/bytes=(\d+)-/)[1]);
        const [, bucket, name] = url.match(/\/b\/([^/]+)\/o\/([^?]+)/);
        calls.push({ bucket, name: decodeURIComponent(name), start });
        const text = contents(calls.length, start);
        if (typeof text === 'number') throw Object.assign(new Error(`HTTP ${text}`), { response: { status: text } });
        const buf = Buffer.from(text);
        if (start >= buf.length) throw Object.assign(new Error('HTTP 416'), { response: { status: 416 } });
        return { status: 206, data: buf.subarray(start) };
      },
    },
  };
  return { storage, calls };
}

/** Protobuf-style timestamp. */
export const ts = (iso) => ({ seconds: String(Math.floor(Date.parse(iso) / 1000)), nanos: 0 });
