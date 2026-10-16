import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LogTailer, createRangeReader } from '../src/logs.js';
import { AuthError, ConfigError, DockeriserError, GRPC, mapGoogleError } from '../src/errors.js';
import { mapUploadError, sourceObjectName } from '../src/upload.js';
import { gcsLogStorage, tempTree } from './helpers.js';

/** Fake Storage whose single log object grows according to `contents()` (null = not created yet). */
function fakeStorage(contents) {
  return gcsLogStorage((n) => contents(n) ?? 404);
}

test('range reader: one plain JSON-API request per poll with a Range header, no retries', async () => {
  const seen = [];
  const storage = {
    authClient: {
      request: async (opts) => {
        seen.push(opts);
        return { status: 206, data: new TextEncoder().encode('abc').buffer };
      },
    },
  };
  const read = createRangeReader(storage, 'my-logs', 'log-b 1.txt');
  assert.equal((await read(5)).toString(), 'abc');
  assert.equal(seen[0].url, 'https://storage.googleapis.com/storage/v1/b/my-logs/o/log-b%201.txt?alt=media');
  assert.equal(seen[0].headers.Range, 'bytes=5-');
  assert.equal(seen[0].retry, false);
  assert.equal(seen[0].responseType, 'arraybuffer');

  const whole = { authClient: { request: async () => ({ status: 200, data: Buffer.from('0123456789') }) }, apiEndpoint: 'http://127.0.0.1:9/' };
  assert.equal((await createRangeReader(whole, 'b', 'o')(4)).toString(), '456789', 'a 200 reply ignoring Range is sliced');

  const missing = { authClient: { request: async () => Promise.reject(Object.assign(new Error('nope'), { response: { status: 404 } })) } };
  await assert.rejects(createRangeReader(missing, 'b', 'o')(0), (err) => err.code === 404);
});

test('tailer reads only new bytes, tolerates 404 and 416, and keeps the full log', async () => {
  const stages = [null, null, 'Step 1\n', 'Step 1\nStep 2\n', 'Step 1\nStep 2\n', 'Step 1\nStep 2\nDONE\n'];
  const { storage, calls } = fakeStorage((n) => stages[Math.min(n - 1, stages.length - 1)]);
  const printed = [];
  const logFile = path.join(tempTree({}), 'full.log');
  const t = new LogTailer({ storage, bucket: 'logs', buildId: 'b1', onText: (s) => printed.push(s), logFile, sleep: async () => {} });
  for (let i = 0; i < 4; i++) await t.readOnce();
  assert.deepEqual(calls.map((c) => c.start), [0, 0, 0, 7]);
  assert.equal(calls[0].name, 'log-b1.txt');
  assert.equal(calls[0].bucket, 'logs');
  await t.drain({ attempts: 5, delayMs: 0 });
  assert.equal(printed.join(''), 'Step 1\nStep 2\nDONE\n');
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'Step 1\nStep 2\nDONE\n');
  assert.deepEqual(t.tail(2), ['Step 2', 'DONE']);
});

test('final drain retries until the closing line arrives', async () => {
  let n = 0;
  const stages = ['a\n', 'a\n', 'a\n', 'a\nb\nERROR\n'];
  const { storage } = fakeStorage(() => stages[Math.min(n++, stages.length - 1)]);
  const t = new LogTailer({ storage, bucket: 'l', buildId: 'b', onText: () => {}, sleep: async () => {} });
  await t.drain({ attempts: 6, delayMs: 0 });
  assert.deepEqual(t.tail(10), ['a', 'b', 'ERROR']);
});

test('drain gives up after the attempt limit when the log never closes', async () => {
  const { storage, calls } = fakeStorage(() => 'still going\n');
  const t = new LogTailer({ storage, bucket: 'l', buildId: 'b', onText: () => {}, sleep: async () => {} });
  await t.drain({ attempts: 3, delayMs: 0 });
  assert.equal(calls.length, 3);
});

test('ring buffer keeps only the last N lines; multibyte text survives chunk splits', async () => {
  const full = Buffer.from(Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n') + '\nhé\n');
  let offsetCalls = 0;
  const reader = async (start) => {
    offsetCalls++;
    if (start >= full.length) throw Object.assign(new Error('416'), { code: 416 });
    return full.subarray(start, Math.min(full.length, start + 7)); // 7-byte chunks split "é"
  };
  const out = [];
  const t = new LogTailer({ reader, bucket: 'l', buildId: 'b', onText: (s) => out.push(s), ringSize: 200, sleep: async () => {} });
  while ((await t.readOnce()) > 0);
  assert.ok(offsetCalls > 10);
  assert.equal(out.join(''), full.toString());
  assert.equal(t.lines.length, 200);
  assert.deepEqual(t.tail(2), ['l299', 'hé']);
});

test('a 403 on the log object disables tailing with one warning', async () => {
  const { storage } = gcsLogStorage(() => 403);
  const warnings = [];
  const t = new LogTailer({ storage, bucket: 'l', buildId: 'b', onText: () => {}, onWarn: (w) => warnings.push(w) });
  await t.readOnce();
  await t.readOnce();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /logs bucket/);
});

test('busy (503) and missing (404) answers are not fatal and add nothing', async () => {
  const { storage, calls } = gcsLogStorage((n) => (n === 1 ? 503 : n === 2 ? 404 : 'ok\n'));
  const out = [];
  const t = new LogTailer({ storage, bucket: 'l', buildId: 'b', onText: (s) => out.push(s) });
  assert.equal(await t.readOnce(), 0);
  assert.equal(await t.readOnce(), 0);
  assert.equal(await t.readOnce(), 3);
  assert.equal(calls.length, 3);
  assert.equal(out.join(''), 'ok\n');
});

test('gRPC errors map to friendly typed errors', () => {
  const ctx = { project: 'p1', serviceAccount: 'sa@p1.iam.gserviceaccount.com' };
  const denied = mapGoogleError(Object.assign(new Error("7 PERMISSION_DENIED: The caller does not have permission 'cloudbuild.builds.create'"), { code: GRPC.PERMISSION_DENIED }), ctx);
  assert.ok(denied instanceof AuthError);
  assert.equal(denied.exitCode, 3);
  assert.match(denied.message, /cloudbuild\.builds\.create/);

  const unauth = mapGoogleError(Object.assign(new Error('16 UNAUTHENTICATED'), { code: GRPC.UNAUTHENTICATED }), ctx);
  assert.ok(unauth instanceof AuthError);

  const notFound = mapGoogleError(Object.assign(new Error('5 NOT_FOUND'), { code: GRPC.NOT_FOUND }), ctx);
  assert.ok(notFound instanceof ConfigError);

  const disabled = mapGoogleError(
    Object.assign(new Error('9 FAILED_PRECONDITION: Cloud Build API has not been used in project p1 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudbuild.googleapis.com/overview?project=p1'), { code: GRPC.FAILED_PRECONDITION }),
    ctx,
  );
  assert.ok(disabled instanceof ConfigError);
  assert.match(disabled.fix, /https:\/\/console\.cloud\.google\.com\/apis\/library\/cloudbuild\.googleapis\.com\?project=p1/);

  const billing = mapGoogleError(Object.assign(new Error('9 FAILED_PRECONDITION: billing account is disabled'), { code: GRPC.FAILED_PRECONDITION }), ctx);
  assert.match(billing.message, /billing/);

  const noCreds = mapGoogleError(new Error('Could not load the default credentials.'), ctx);
  assert.ok(noCreds instanceof AuthError);

  const unknown = mapGoogleError(new Error('weird'), ctx);
  assert.ok(unknown instanceof DockeriserError);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.fix, /--debug/);
});

test('upload errors name the missing bucket or role', () => {
  const ctx = { bucket: 'p-dockeriser-src', project: 'p', serviceAccount: 'sa@p.iam.gserviceaccount.com' };
  const missing = mapUploadError(Object.assign(new Error('The specified bucket does not exist.'), { code: 404 }), ctx);
  assert.equal(missing.exitCode, 4);
  assert.match(missing.fix, /setup\/setup\.ps1 -Project p/);
  const denied = mapUploadError(Object.assign(new Error('does not have storage.objects.create access'), { code: 403 }), ctx);
  assert.match(denied.fix, /roles\/storage\.objectAdmin/);
  const auth = mapUploadError(new Error('Could not load the default credentials.'), ctx);
  assert.equal(auth.exitCode, 3);
  assert.equal(sourceObjectName('abcdef1234', new Date('2026-10-16T01:02:03Z')), 'source/20261016-010203-abcdef12.tgz');
});
