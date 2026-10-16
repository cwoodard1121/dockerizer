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

/** Protobuf-style timestamp. */
export const ts = (iso) => ({ seconds: String(Math.floor(Date.parse(iso) / 1000)), nanos: 0 });
