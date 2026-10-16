/**
 * Stream a `docker save`-format archive built straight from registry blobs, for `docker load` on
 * the server. Layers go in as the registry stores them (gzip-compressed); `docker load` detects and
 * decompresses compressed layers itself (see docs/RESEARCH.md). Nothing is buffered beyond one
 * chunk: blobs are piped from HTTP into the tar stream, with their size and sha256 checked.
 *
 * Layout: manifest.json, then blobs/sha256/<hex> for each config and layer (each blob once).
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const BLOCK = 512;
const MAX_SIZE = 0o77777777777; // 8 GiB - 1, the ustar size field limit

/**
 * One ustar header block.
 * @param {string} name Path inside the archive (< 100 bytes).
 * @param {number} size
 * @param {number} [mtime] Seconds since epoch.
 * @returns {Buffer}
 */
export function tarHeader(name, size, mtime = 0) {
  if (Buffer.byteLength(name) >= 100) throw new Error(`tar entry name too long: ${name}`);
  if (size > MAX_SIZE) throw new Error(`tar entry too large: ${name} is ${size} bytes`);
  const h = Buffer.alloc(BLOCK, 0);
  const put = (str, offset, len) => h.write(str, offset, len, 'ascii');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder (spaces)
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** Zero padding after `size` bytes of data. */
export function tarPadding(size) {
  const rest = size % BLOCK;
  return Buffer.alloc(rest ? BLOCK - rest : 0, 0);
}

const blobPath = (digest) => `blobs/sha256/${digest.replace(/^sha256:/, '')}`;

/**
 * manifest.json contents for a set of images.
 * @param {Array<{manifest: {config: {digest: string}, layers: Array<{digest: string}>}, repoTags: string[]}>} images
 */
export function saveManifest(images) {
  return images.map(({ manifest, repoTags }) => ({
    Config: blobPath(manifest.config.digest),
    RepoTags: repoTags,
    Layers: manifest.layers.map((l) => blobPath(l.digest)),
  }));
}

/** Every blob the archive will hold, each once, in order. */
export function uniqueBlobs(images) {
  const seen = new Map();
  for (const { manifest } of images) {
    for (const b of [manifest.config, ...manifest.layers]) {
      if (!seen.has(b.digest)) seen.set(b.digest, { digest: b.digest, size: b.size, repository: manifest.repository });
    }
  }
  return [...seen.values()];
}

/** Total archive size in bytes (headers, data, padding and the two closing blocks). */
export function archiveSize(images) {
  const manifestBytes = Buffer.byteLength(JSON.stringify(saveManifest(images)));
  let total = BLOCK + manifestBytes + tarPadding(manifestBytes).length;
  for (const b of uniqueBlobs(images)) total += BLOCK + b.size + tarPadding(b.size).length;
  return total + 2 * BLOCK;
}

/**
 * The archive as a Node readable stream.
 * @param {object} opts
 * @param {Array<{manifest: object, repoTags: string[]}>} opts.images
 * @param {(repository: string, digest: string) => Promise<NodeJS.ReadableStream>} opts.openBlob
 * @param {number} [opts.mtime]
 * @returns {Readable}
 */
export function saveArchiveStream({ images, openBlob, mtime = Math.floor(Date.now() / 1000) }) {
  async function* generate() {
    const manifest = Buffer.from(JSON.stringify(saveManifest(images)));
    yield tarHeader('manifest.json', manifest.length, mtime);
    yield manifest;
    yield tarPadding(manifest.length);
    for (const blob of uniqueBlobs(images)) {
      yield tarHeader(blobPath(blob.digest), blob.size, mtime);
      const hash = crypto.createHash('sha256');
      let got = 0;
      const stream = await openBlob(blob.repository, blob.digest);
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        got += buf.length;
        if (got > blob.size) throw new Error(`Blob ${blob.digest} is larger than its manifest says (${blob.size} bytes).`);
        hash.update(buf);
        yield buf;
      }
      if (got !== blob.size) throw new Error(`Blob ${blob.digest} ended after ${got} of ${blob.size} bytes.`);
      const actual = `sha256:${hash.digest('hex')}`;
      if (blob.digest.startsWith('sha256:') && actual !== blob.digest) throw new Error(`Blob ${blob.digest} arrived with digest ${actual}.`);
      yield tarPadding(blob.size);
    }
    yield Buffer.alloc(2 * BLOCK, 0);
  }
  return Readable.from(generate(), { objectMode: false });
}

/**
 * Progress text: "120.3 / 845.0 MB (12.1 MB/s)".
 * @param {number} sent Bytes sent so far.
 * @param {number} total Total bytes.
 * @param {number} elapsedMs
 */
export function progressText(sent, total, elapsedMs) {
  const mb = (n) => (n / 1e6).toFixed(1);
  const rate = elapsedMs > 0 ? sent / 1e6 / (elapsedMs / 1000) : 0;
  const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
  return `${mb(sent)} / ${mb(total)} MB, ${pct}% (${rate.toFixed(1)} MB/s)`;
}
