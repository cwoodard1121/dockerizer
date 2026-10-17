/**
 * Typed errors and the mapping from Google API errors to friendly messages.
 * Every error the CLI shows the user goes through here so exit codes stay consistent.
 */

export const EXIT = Object.freeze({
  OK: 0,
  BUILD_FAILED: 1,
  CONFIG: 2,
  AUTH: 3,
  UPLOAD: 4,
  CI_OFF: 5,
  INTERRUPTED: 130,
});

/** Base class: an error with a process exit code and an optional fix hint. */
export class DockeriserError extends Error {
  /**
   * @param {string} message What went wrong, in plain words.
   * @param {{exitCode?: number, fix?: string, cause?: unknown}} [opts]
   */
  constructor(message, { exitCode = EXIT.BUILD_FAILED, fix, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.fix = fix;
  }
}

/** Bad input or missing setup (exit 2). */
export class ConfigError extends DockeriserError {
  constructor(message, opts = {}) {
    super(message, { ...opts, exitCode: EXIT.CONFIG });
  }
}

/** Credentials missing, invalid, or lacking permission (exit 3). */
export class AuthError extends DockeriserError {
  constructor(message, opts = {}) {
    super(message, { ...opts, exitCode: EXIT.AUTH });
  }
}

/** Source upload to Cloud Storage failed (exit 4). */
export class UploadError extends DockeriserError {
  constructor(message, opts = {}) {
    super(message, { ...opts, exitCode: EXIT.UPLOAD });
  }
}

/** The build ran and ended in a non-success status (exit 1). */
export class BuildFailedError extends DockeriserError {
  /**
   * @param {string} message
   * @param {{report?: object, cause?: unknown}} [opts]
   */
  constructor(message, { report, cause } = {}) {
    super(message, { exitCode: EXIT.BUILD_FAILED, cause });
    this.report = report;
  }
}

/** gRPC status codes we treat specially (from google.rpc.Code). */
export const GRPC = Object.freeze({
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
});

/**
 * True when an error is worth retrying (network blip, server busy).
 * @param {any} err
 * @returns {boolean}
 */
export function isTransient(err) {
  const code = err?.code;
  return (
    code === GRPC.UNAVAILABLE ||
    code === GRPC.DEADLINE_EXCEEDED ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 429 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504
  );
}

const API_DISABLED = /has not been used in project|is disabled|SERVICE_DISABLED|API has not been enabled/i;
const BILLING = /billing/i;
const NO_CREDENTIALS = /Could not load the default credentials|invalid_grant|invalid_rapt|reauthenticat|Could not refresh access token|unable to impersonate/i;

/**
 * Turn any thrown error from the Google client libraries into a DockeriserError
 * with a one-paragraph explanation and the fix. DockeriserErrors pass through.
 *
 * @param {any} err The original error.
 * @param {{project?: string, region?: string, serviceAccount?: string, api?: string, action?: string}} [ctx]
 *   What we were doing, so the message can name the exact resource and fix.
 * @returns {DockeriserError}
 */
export function mapGoogleError(err, ctx = {}) {
  if (err instanceof DockeriserError) return err;
  const raw = String(err?.details || err?.message || err || 'unknown error');
  const project = ctx.project || '<project>';
  const who = ctx.serviceAccount ? `the account ${ctx.serviceAccount}` : 'your account';
  const api = ctx.api || 'cloudbuild.googleapis.com';
  const action = ctx.action ? ` while trying to ${ctx.action}` : '';
  const code = err?.code;

  if (code === GRPC.FAILED_PRECONDITION && BILLING.test(raw)) {
    return new ConfigError(
      `Project ${project} has no active billing account${action}. Cloud Build needs billing linked even when you stay inside the free tier.`,
      { fix: `Link a billing account at https://console.cloud.google.com/billing/linkedaccount?project=${project}.`, cause: err },
    );
  }
  if (API_DISABLED.test(raw)) {
    const name = raw.match(/([a-z]+\.googleapis\.com)/)?.[1] || api;
    return new ConfigError(
      `The ${name} API is turned off for project ${project}${action}. Google returns this until the API is enabled once per project.`,
      {
        fix: `Enable it at https://console.cloud.google.com/apis/library/${name}?project=${project} (or re-run setup/setup.ps1), wait a minute, then retry.`,
        cause: err,
      },
    );
  }
  if (code === GRPC.UNAUTHENTICATED || code === 401 || NO_CREDENTIALS.test(raw)) {
    return new AuthError(
      `Google did not accept the credentials${action}. Either no credentials were found, the key file is wrong or revoked, or your gcloud login has expired.`,
      {
        fix: 'Re-run the setup script (powershell -ExecutionPolicy Bypass -File setup\\setup.ps1 from the dockeriser folder); it signs you in again. `dockeriser doctor` shows which credentials are in use.',
        cause: err,
      },
    );
  }
  if (code === GRPC.PERMISSION_DENIED || code === 403) {
    const perm = raw.match(/([a-z]+(?:\.[a-zA-Z]+){2,})/)?.[1];
    return new AuthError(
      `Permission denied${action}: ${who} is missing a permission${perm ? ` (${perm})` : ''} in project ${project}.`,
      {
        fix: 'Re-run setup/setup.ps1 to restore the service account roles, then run `dockeriser doctor`. See docs/SETUP.md "Troubleshooting" for which role covers which permission.',
        cause: err,
      },
    );
  }
  if (code === GRPC.NOT_FOUND || code === 404) {
    return new ConfigError(
      `Not found${action}: project ${project}${ctx.region ? ` in region ${ctx.region}` : ''} or the resource it points at does not exist (or you cannot see it).`,
      { fix: 'Check the --project and --region values (`dockeriser doctor` prints them), and that setup/setup.ps1 has been run for this project.', cause: err },
    );
  }
  if (code === GRPC.INVALID_ARGUMENT || code === 400) {
    return new ConfigError(`Google rejected the request${action}: ${raw}`, {
      fix: 'Check the flags you passed (image name, tags, timeout, build args). Re-run with --dry-run to see the exact request.',
      cause: err,
    });
  }
  if (code === GRPC.RESOURCE_EXHAUSTED || code === 429) {
    return new DockeriserError(`Google says a quota was hit${action}: ${raw}`, {
      fix: 'Wait a minute and retry. If it keeps happening, check quotas at https://console.cloud.google.com/iam-admin/quotas?project=' + project,
      cause: err,
    });
  }
  return new DockeriserError(`Unexpected error${action}: ${raw}`, {
    fix: 'Re-run with --debug to see the full stack trace.',
    cause: err,
  });
}
