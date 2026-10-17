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

/**
 * Fake Cloud Storage JSON API behind `storage.authClient.request`: object metadata (generation),
 * media reads (optionally with a Range or a generation) and media uploads with ifGenerationMatch.
 * `beforeWrite()` runs before each upload is applied (to simulate another writer).
 */
export function fakeGcs() {
  const objects = new Map(); // "bucket/name" -> {data: Buffer, generation: number}
  let nextGen = 1;
  const api = {
    calls: [],
    beforeWrite: null,
    put(bucket, name, text) {
      objects.set(`${bucket}/${name}`, { data: Buffer.from(text), generation: nextGen++ });
    },
    get(bucket, name) {
      return objects.get(`${bucket}/${name}`)?.data.toString();
    },
    has(bucket, name) {
      return objects.has(`${bucket}/${name}`);
    },
  };
  const fail = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
  api.storage = {
    authClient: {
      request: async ({ url, method = 'GET', headers = {}, data }) => {
        const u = new URL(url);
        api.calls.push({ method, url });
        if (method === 'POST') {
          const bucket = decodeURIComponent(u.pathname.match(/\/b\/([^/]+)\/o/)[1]);
          const name = u.searchParams.get('name');
          api.beforeWrite?.();
          const cur = objects.get(`${bucket}/${name}`);
          const want = u.searchParams.get('ifGenerationMatch');
          if (want !== null && Number(want) !== (cur ? cur.generation : 0)) throw fail(412);
          const obj = { data: Buffer.from(data), generation: nextGen++ };
          objects.set(`${bucket}/${name}`, obj);
          return { status: 200, data: { generation: String(obj.generation) } };
        }
        const [, bucket, name] = u.pathname.match(/\/b\/([^/]+)\/o\/(.+)$/);
        const obj = objects.get(`${decodeURIComponent(bucket)}/${decodeURIComponent(name)}`);
        if (!obj) throw fail(404);
        if (u.searchParams.get('alt') !== 'media') return { status: 200, data: { generation: String(obj.generation) } };
        const gen = u.searchParams.get('generation');
        if (gen && Number(gen) !== obj.generation) throw fail(404);
        const start = headers.Range ? Number(headers.Range.match(/bytes=(\d+)-/)[1]) : 0;
        if (start >= obj.data.length && start > 0) throw fail(416);
        return { status: headers.Range ? 206 : 200, data: obj.data.subarray(start) };
      },
    },
  };
  return api;
}
