/**
 * Console formatting. Human messages go to stdout normally, or stderr in --json mode so
 * stdout carries exactly one JSON object. Colour only on a TTY and only when NO_COLOR is unset.
 */

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, dim: 2, bold: 1 };

/**
 * @param {object} [opts]
 * @param {boolean} [opts.json] --json mode.
 * @param {NodeJS.WritableStream & {isTTY?: boolean}} [opts.stdout]
 * @param {NodeJS.WritableStream & {isTTY?: boolean}} [opts.stderr]
 * @param {Record<string, string|undefined>} [opts.env]
 */
export function createOutput({ json = false, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const human = json ? stderr : stdout;
  const useColour = Boolean(human.isTTY) && !env.NO_COLOR;
  const errColour = Boolean(stderr.isTTY) && !env.NO_COLOR;
  const paint = (on) => (name, text) => (on ? `\x1b[${CODES[name]}m${text}\x1b[0m` : text);
  const c = paint(useColour);
  const ce = paint(errColour);

  return {
    json,
    colour: c,
    /** Plain line for humans. */
    info: (msg = '') => human.write(`${msg}\n`),
    /** A stage heading, e.g. "==> Uploading source". */
    step: (msg) => human.write(`${c('cyan', '==>')} ${c('bold', msg)}\n`),
    /** Success line. */
    ok: (msg) => human.write(`${c('green', msg)}\n`),
    /** Warning on stderr. */
    warn: (msg) => stderr.write(`${ce('yellow', 'warning:')} ${msg}\n`),
    /** Raw build log text (no newline added). */
    log: (text) => human.write(text),
    /**
     * Print an error and its fix on stderr; the stack only with --debug.
     * @param {any} err
     * @param {boolean} [debug]
     */
    error(err, debug = false) {
      stderr.write(`${ce('red', 'error:')} ${err?.message || err}\n`);
      if (err?.fix) stderr.write(`${ce('dim', '  fix:')} ${err.fix}\n`);
      if (debug) {
        stderr.write(`${err?.stack || ''}\n`);
        if (err?.cause?.stack) stderr.write(`caused by: ${err.cause.stack}\n`);
      } else if (!err?.fix) {
        stderr.write(`${ce('dim', '  (re-run with --debug for the full stack trace)')}\n`);
      }
    },
    /** The single machine-readable result on stdout. */
    result: (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`),
  };
}

/**
 * Human-readable byte size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * "1m 05s" style duration.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
