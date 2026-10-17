/**
 * The VM side of `dockeriser ci`: which files go up, the startup script that runs the gate, and the
 * gcloud calls that create, watch, delete and sweep the spot VMs. The VMs are created and deleted
 * with the signed-in gcloud account (like `cleanup` and `server add`); they run as the dockeriser
 * service account, which can already read the source bucket and write the logs bucket.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AuthError, ConfigError, DockeriserError } from './errors.js';
import { utcStamp } from './image.js';

export const CI_LABEL = 'dockeriser-ci';
export const MAX_LIVE_VMS = 4;
/** --max-run-duration is the gate timeout plus this, for installing the toolchain and uploading. */
export const SETUP_ALLOWANCE_SEC = 15 * 60;
/** A VM this long past its own limit is a leftover, whatever its status says. */
const SWEEP_GRACE_SEC = 10 * 60;
const IMAGE_FAMILY = 'ubuntu-2404-lts-amd64';
const IMAGE_PROJECT = 'ubuntu-os-cloud';
const NO_CAPACITY = /ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources|STOCKOUT|resource pool exhausted/i;

/** `ci-YYYYMMDD-HHMMSS-<4 hex>` */
export function runIdFor(now, rand) {
  return `ci-${utcStamp(now)}-${rand}`;
}

/** Instance name for a run. */
export function vmNameFor(runId) {
  return `dockeriser-${runId}`;
}

/**
 * Files to upload: what `git add -A` would commit (tracked plus untracked files git does not
 * ignore), minus files deleted on disk. Ignored files such as .env and node_modules never leave.
 * @param {string} root
 * @param {typeof execFileSync} [exec]
 * @returns {string[]} POSIX paths relative to root.
 */
export function ciSourceFiles(root, exec = execFileSync) {
  let out;
  try {
    out = exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, windowsHide: true,
    });
  } catch (err) {
    throw new ConfigError(`dockeriser ci uploads what git would commit, but ${root} is not a git checkout (${String(err.stderr || err.message).trim().split('\n')[0]}).`, {
      fix: 'Run it in a git checkout with git installed.',
    });
  }
  const files = [...new Set(String(out).split('\0').filter(Boolean))];
  return files.filter((rel) => {
    try {
      return fs.lstatSync(path.join(root, rel)).isFile();
    } catch {
      return false; // deleted on disk
    }
  });
}

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const SAFE = /^[A-Za-z0-9._/-]+$/;

function safe(value, what) {
  if (!SAFE.test(String(value))) throw new ConfigError(`Unsafe characters in ${what}: ${value}`);
  return value;
}

/**
 * The gate script, run as the `ci` user in /home/ci/src. Each step runs in its own bash with
 * pipefail, bracketed by ::step / ::step-end lines; the first failure stops the gate.
 */
function gateScript({ steps, env }) {
  const lines = [
    '#!/bin/bash',
    'set -o pipefail',
    'cd /home/ci/src || exit 1',
    'export CI=true',
    ...Object.entries(env).map(([k, v]) => `export ${k}="$(printf %s '${b64(v)}' | base64 -d)"`),
    'step() {',
    '  local cmd; cmd=$(printf %s "$2" | base64 -d)',
    `  printf '\\n::step %s/${steps.length} $ %s\\n' "$1" "$cmd"`,
    '  local t0=$SECONDS',
    '  bash -o pipefail -c "$cmd" < /dev/null',
    '  local rc=$?',
    "  printf '::step-end %s rc=%s %ss\\n' \"$1\" \"$rc\" \"$((SECONDS - t0))\"",
    '  if [ "$rc" != 0 ]; then echo "$1" > /home/ci/failed-step; exit "$rc"; fi',
    '}',
    ...steps.map((s, i) => `step ${i + 1} '${b64(s)}'`),
    '',
  ];
  return lines.join('\n');
}

/**
 * The VM's startup script: install Docker and Node, fetch the source, run the gate as `ci` under a
 * timeout, upload the log to the logs bucket every 10 s and at the end, then power off. The log ends
 * with `::dockeriser-ci-result exit=<n> step=<k>` and DONE or ERROR.
 * @param {{runId: string, srcBucket: string, srcObject: string, logsBucket: string, steps: string[],
 *   env: Record<string, string>, node: string, docker: boolean, timeoutSec: number}} o
 * @returns {string}
 */
export function startupScript(o) {
  const gate = gateScript(o);
  const node = safe(o.node, 'the Node version');
  return `#!/bin/bash
# dockeriser ci ${safe(o.runId, 'the run id')}: install the toolchain, run the gate as user "ci", upload the log, power off.
SRC_BUCKET='${safe(o.srcBucket, 'the source bucket')}'
SRC_OBJECT='${safe(o.srcObject, 'the source object')}'
LOGS_BUCKET='${safe(o.logsBucket, 'the logs bucket')}'
LOG_OBJECT='log-${o.runId}.txt'
NODE_WANT='${node}'
${o.docker ? 'INSTALL_DOCKER=1' : 'INSTALL_DOCKER=0'}
GATE_TIMEOUT=${Number(o.timeoutSec)}
LOG=/var/log/dockeriser-ci.log
: > "$LOG"
log() { printf '%s\\n' "$*" >> "$LOG"; }
token() { curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'; }
push_log() { curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(token)" -H 'Content-Type: text/plain; charset=utf-8' --data-binary @"$LOG" "https://storage.googleapis.com/upload/storage/v1/b/$LOGS_BUCKET/o?uploadType=media&name=$LOG_OBJECT" || true; }
finish() {
  trap - EXIT
  kill "$PUSHER" 2>/dev/null
  log "::dockeriser-ci-result exit=$1 step=$2"
  if [ "$1" = 0 ]; then log DONE; else log ERROR; fi
  push_log
  sync
  shutdown -h now
  exit 0
}
setup_fail() { log "::dockeriser-ci-setup-failed $1"; finish 1 0; }
( while sleep 10; do push_log; done ) &
PUSHER=$!
trap 'finish 1 0' EXIT

log "::phase setup ($(nproc) vCPU, $(free -m | awk '/Mem:/{print $2}') MiB, $(. /etc/os-release; echo "$PRETTY_NAME"))"
export DEBIAN_FRONTEND=noninteractive
useradd -m -s /bin/bash ci && echo 'ci ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ci || setup_fail 'could not create the ci user'
if [ "$INSTALL_DOCKER" = 1 ]; then
  log '::phase docker'
  { apt-get -o DPkg::Lock::Timeout=600 update -q && apt-get -o DPkg::Lock::Timeout=600 install -y -q docker.io docker-compose-v2; } >> "$LOG" 2>&1 || setup_fail 'could not install Docker'
  usermod -aG docker ci
  systemctl start docker
fi
log "::phase node $NODE_WANT"
pick_node() { curl -fsS https://nodejs.org/dist/index.json | python3 -c '
import json, sys
want = sys.argv[1]
for r in json.load(sys.stdin):
    v = r["version"].lstrip("v")
    if (want == "lts" and r["lts"]) or v.split(".")[:len(want.split("."))] == want.split("."):
        print("v" + v); break' "$NODE_WANT"; }
case "$NODE_WANT" in
  *.*.*) NODE_VER="v$NODE_WANT" ;;
  *) NODE_VER=$(pick_node) ;;
esac
[ -n "$NODE_VER" ] || setup_fail "no Node release matches $NODE_WANT"
curl -fsS "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1 || setup_fail "could not install Node $NODE_VER"
log "node $(node --version), npm $(npm --version)$([ "$INSTALL_DOCKER" = 1 ] && echo ", $(docker --version), $(docker compose version)")"
log '::phase source'
mkdir -p /home/ci/src
SRC_URL="https://storage.googleapis.com/storage/v1/b/$SRC_BUCKET/o/$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SRC_OBJECT")?alt=media"
curl -fsS -H "Authorization: Bearer $(token)" "$SRC_URL" | tar -xz -C /home/ci/src || setup_fail 'could not download the source'
chown -R ci:ci /home/ci
cat > /home/ci/gate.sh <<'GATE'
${gate}GATE
chmod 755 /home/ci/gate.sh
log '::phase gate'
timeout --kill-after=30 "$GATE_TIMEOUT" sudo -u ci -H bash /home/ci/gate.sh >> "$LOG" 2>&1
RC=$?
STEP=$(cat /home/ci/failed-step 2>/dev/null || echo 0)
if [ "$RC" = 124 ] || [ "$RC" = 137 ]; then log "::dockeriser-ci-timeout after $GATE_TIMEOUT s"; RC=124; fi
finish "$RC" "$STEP"
`;
}

/**
 * gcloud arguments that create one CI VM.
 * @returns {string[]}
 */
export function createArgs({ name, project, zone, machine, diskGb, serviceAccount, maxRunSec, scriptFile }) {
  return [
    'compute', 'instances', 'create', name,
    `--project=${project}`, `--zone=${zone}`, `--machine-type=${machine}`,
    '--provisioning-model=SPOT', '--instance-termination-action=DELETE', `--max-run-duration=${maxRunSec}s`,
    `--image-family=${IMAGE_FAMILY}`, `--image-project=${IMAGE_PROJECT}`, `--boot-disk-size=${diskGb}GB`, '--boot-disk-type=pd-balanced',
    `--service-account=${serviceAccount}`, '--scopes=cloud-platform',
    `--labels=${CI_LABEL}=1,max-run=${maxRunSec}`,
    `--metadata-from-file=startup-script=${scriptFile}`,
    '--format=json', '--quiet',
  ];
}

/** The region's zones to try, in order (a single --zone if given). */
export function zonesFor(region, zone) {
  return zone ? [zone] : ['a', 'b', 'c'].map((z) => `${region}-${z}`);
}

const lastLines = (text, n = 3) => String(text).trim().split('\n').slice(-n).join(' ').trim();

/** Turn a failed gcloud compute call into an actionable error. */
export function gcloudError(what, res, project) {
  const msg = lastLines(res.stderr) || `exit ${res.code}`;
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(msg) && /compute/i.test(msg)) {
    return new ConfigError(`The Compute Engine API is off in project ${project}, so dockeriser ci cannot create a VM.`, {
      fix: `gcloud services enable compute.googleapis.com --project ${project}   (or re-run setup/setup.ps1)`,
    });
  }
  if (/QUOTA_EXCEEDED|Quota .* exceeded/i.test(msg)) {
    return new DockeriserError(`Google refused the VM: a quota is used up (${msg}).`, { fix: 'Wait for other CI runs to finish (`dockeriser ci status`), or use a smaller --machine.' });
  }
  if (/auth|credential|login|reauth/i.test(msg) && !/permission/i.test(msg)) {
    return new AuthError(`gcloud could not ${what}: ${msg}`, { fix: 'Sign in with `gcloud auth login` as the project owner, then try again.' });
  }
  if (/PERMISSION_DENIED|permission|forbidden|iam\.serviceAccounts\.actAs/i.test(msg)) {
    return new AuthError(`gcloud is not allowed to ${what}: ${msg}`, { fix: `Use a gcloud account that owns project ${project} (gcloud auth login), or grant it Compute Instance Admin and Service Account User.` });
  }
  return new DockeriserError(`gcloud could not ${what}: ${msg}`);
}

/**
 * Create the VM in the first zone with spot capacity.
 * @param {{gcloud: Function, zones: string[], argsFor: (zone: string) => string[], project?: string, warn: (m: string) => void}} o
 * @returns {{zone: string}}
 */
export function createVm({ gcloud, zones, argsFor, project, warn }) {
  let last;
  for (const zone of zones) {
    const res = gcloud(argsFor(zone));
    if (res.code === 0) return { zone };
    last = res;
    if (!NO_CAPACITY.test(res.stderr)) throw gcloudError('create the CI VM', res, project);
    warn(`no spot capacity in ${zone}${zone === zones[zones.length - 1] ? '' : ', trying the next zone'}`);
  }
  throw new DockeriserError(`No spot capacity for this machine in ${zones.join(', ')} right now (${lastLines(last.stderr, 1)}).`, {
    fix: 'Try again in a few minutes, or pass --zone in another region\'s zone, or a smaller --machine.',
  });
}

/** The VM's status (RUNNING, STOPPING, TERMINATED…), or GONE when it no longer exists. */
export function vmStatus({ gcloud, project, name, zone }) {
  const res = gcloud(['compute', 'instances', 'describe', name, `--project=${project}`, `--zone=${zone}`, '--format=value(status)']);
  if (res.code === 0) return res.stdout.trim() || 'UNKNOWN';
  if (/not found|was not found|notFound/i.test(res.stderr)) return 'GONE';
  return 'UNKNOWN';
}

/**
 * Delete the VM; a VM that is already gone counts as deleted. With `wait: false` the delete is
 * only requested (gcloud --async), which returns in seconds.
 * @returns {{ok: boolean, error?: string}}
 */
export function deleteVm({ gcloud, project, name, zone, wait = true }) {
  const res = gcloud(['compute', 'instances', 'delete', name, `--project=${project}`, `--zone=${zone}`, '--quiet', ...(wait ? [] : ['--async'])]);
  if (res.code === 0 || /not found|was not found|notFound/i.test(res.stderr)) return { ok: true };
  return { ok: false, error: lastLines(res.stderr) };
}

/**
 * Every CI VM in the project.
 * @returns {Array<{name: string, zone: string, status: string, createdAt: string, maxRunSec: number}>}
 */
export function listCiVms({ gcloud, project }) {
  const res = gcloud(['compute', 'instances', 'list', `--project=${project}`, `--filter=labels.${CI_LABEL}:*`, '--format=json']);
  if (res.code !== 0) throw gcloudError('list the CI VMs', res, project);
  let list;
  try {
    list = JSON.parse(res.stdout || '[]');
  } catch {
    list = [];
  }
  return list.map((vm) => ({
    name: vm.name,
    zone: String(vm.zone || '').split('/').pop(),
    status: vm.status,
    createdAt: vm.creationTimestamp,
    maxRunSec: Number(vm.labels?.['max-run']) || 24 * 3600,
  }));
}

/**
 * Delete leftover CI VMs: stopped ones (a run whose laptop went away) and any past its own limit.
 * @returns {{deleted: string[], live: Array<object>}}
 */
export function sweep({ gcloud, project, now, vms, warn = () => {} }) {
  const deleted = [];
  const live = [];
  for (const vm of vms) {
    const ageSec = (now - new Date(vm.createdAt)) / 1000;
    const stale = ['TERMINATED', 'STOPPED', 'SUSPENDED'].includes(vm.status) || ageSec > vm.maxRunSec + SWEEP_GRACE_SEC;
    if (!stale) {
      live.push(vm);
      continue;
    }
    const res = deleteVm({ gcloud, project, name: vm.name, zone: vm.zone, wait: false });
    if (res.ok) deleted.push(vm.name);
    else warn(`could not delete leftover CI VM ${vm.name}: ${res.error}`);
  }
  return { deleted, live };
}

/**
 * The result line the VM writes last, or null.
 * @param {string[]} lines
 * @returns {{exitCode: number, step: number}|null}
 */
export function parseResult(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^::dockeriser-ci-result exit=(\d+) step=(\d+)/.exec(lines[i].trim());
    if (m) return { exitCode: Number(m[1]), step: Number(m[2]) };
  }
  return null;
}

/**
 * Every step the log shows, with its exit code and seconds when it finished.
 * @param {string} text
 * @returns {Array<{index: number, command: string, exitCode: number|null, durationSec: number|null}>}
 */
export function parseSteps(text) {
  const steps = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    let m = /^::step (\d+)\/\d+ \$ (.*)$/.exec(line);
    if (m) {
      steps.set(Number(m[1]), { index: Number(m[1]), command: m[2], exitCode: null, durationSec: null });
      continue;
    }
    m = /^::step-end (\d+) rc=(\d+) (\d+)s$/.exec(line);
    if (m && steps.has(Number(m[1]))) Object.assign(steps.get(Number(m[1])), { exitCode: Number(m[2]), durationSec: Number(m[3]) });
  }
  return [...steps.values()];
}
