/**
 * `dockeriser ci [dir] | ci init | ci status | ci enable | ci cleanup`.
 *
 * `ci [dir]` runs the `ci.steps` of dockeriser.json on a fresh spot VM: package what git would
 * commit, upload it, check the monthly ledger (the cap can turn CI off), create the VM, stream its
 * log from the logs bucket, delete the VM and record the run's estimated cost in the ledger.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { applyCredentials, homeSearch, resolveConfig, resolveCredentials, resourceNames } from './config.js';
import { AuthError, ConfigError, DockeriserError, EXIT } from './errors.js';
import { parseTimeout } from './build.js';
import { LogTailer } from './logs.js';
import { formatBytes, formatDuration } from './output.js';
import { packageFiles, removeTarball } from './package-source.js';
import { uploadSource } from './upload.js';
import { utcStamp } from './image.js';
import { monthRange } from './usage.js';
import { readProjectFile, secretLookingArgs } from './project.js';
import { createGcloudRunner } from './server.js';
import { SETUP_SCRIPT } from './status.js';
import { CI_MONTHLY_CAP_USD } from './pricing.js';
import { hourlyUsd, machineShape, nodeVersion, normaliseCi, runCostUsd } from './ci-config.js';
import { ciSummary, evaluateCap, readLedger, updateLedger, writeCiCache } from './ci-ledger.js';
import {
  MAX_LIVE_VMS, SETUP_ALLOWANCE_SEC, ciSourceFiles, createArgs, createVm, deleteVm, listCiVms, parseResult, parseSteps,
  runIdFor, startupScript, sweep, vmNameFor, vmStatus, zonesFor,
} from './ci-vm.js';
import { runCiInit } from './ci-init.js';

const LOG_POLL_MS = 3000;
const STATUS_EVERY = 5; // log polls between VM status checks (≈ 15 s)
const SLOT_WAIT_MS = 30000;
const SLOT_WAIT_MAX_MS = 20 * 60 * 1000;

/** Route `ci` and its subcommands. */
export async function ciCommand(ctx) {
  const [sub, ...more] = ctx.rest;
  const handlers = { init: initSub, status: statusSub, enable: enableSub, cleanup: cleanupSub };
  if (handlers[sub]) return handlers[sub]({ ...ctx, rest: more });
  if (ctx.rest.length > 1) throw new ConfigError(`Unexpected extra argument "${ctx.rest[1]}".`, { fix: 'Usage: dockeriser ci [dir] | ci init [dir] | ci status | ci enable | ci cleanup' });
  return runSub({ ...ctx, dir: sub || ctx.cwd });
}

function credentials({ env, homeDir, cfg }) {
  const creds = resolveCredentials({ env, homeDir });
  if (creds.source === 'none' && !env.METADATA_SERVER_DETECTION) {
    throw new AuthError('No Google credentials found.', { fix: `Run the setup script; it signs you in: powershell -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}" -Project ${cfg.project}` });
  }
  applyCredentials(creds, env);
}

const money = (n) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
const randHex = () => crypto.randomBytes(2).toString('hex');

/** Persist "off" in the ledger once a check trips, and mirror the summary locally. */
async function recordOff({ storage, bucket, month, reason, clock, homeDir, env, warn }) {
  try {
    const ledger = await updateLedger(storage, bucket, month, (l) => {
      if (!l.disabled) l.disabled = { at: clock().toISOString(), reason };
    });
    const summary = ciSummary(ledger, clock());
    writeCiCache(homeDir, summary, env);
    return summary;
  } catch (err) {
    warn(`Could not update the CI ledger: ${err.message}`);
    return null;
  }
}

/** `dockeriser ci [dir]` */
async function runSub({ flags, env, homeDir, createClients, tmpDir, deps, sleep, exit, sigint, out, dir }) {
  const clock = deps.clock || (() => new Date());
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
  const names = resourceNames(cfg);
  const root = path.resolve(dir);
  const { file, data } = readProjectFile(root);
  if (!data) throw new ConfigError(`No dockeriser.json in ${root}, so dockeriser does not know which gate to run.`, { fix: 'Run `dockeriser ci init` there to write a "ci" section from the GitHub workflow or package.json.' });
  const ci = normaliseCi(data.ci, file);
  if (flags.machine) {
    if (!machineShape(flags.machine)) throw new ConfigError(`--machine "${flags.machine}" is not a supported E2 machine type.`, { fix: 'e.g. e2-standard-4 or e2-standard-8.' });
    ci.machine = flags.machine;
  }
  if (flags.timeout) {
    ci.timeoutSec = parseTimeout(flags.timeout);
    ci.timeout = flags.timeout;
  }
  const secretish = secretLookingArgs(Object.keys(ci.env));
  if (secretish.length) out.warn(`ci.env ${secretish.join(', ')} look like secrets; ci.env is in the VM's startup script, visible in the Cloud console. Use public values only.`);
  const files = ciSourceFiles(root);
  const node = nodeVersion(root, ci);
  const zones = zonesFor(cfg.region, flags.zone);
  const maxRunSec = ci.timeoutSec + SETUP_ALLOWANCE_SEC;
  const rate = hourlyUsd(ci.machine, ci.diskGb);
  const estimate = cfg.region === 'northamerica-northeast2' ? '' : ' (estimated with Toronto prices)';
  const scriptFor = (runId, srcObject) => startupScript({ runId, srcBucket: names.sourceBucket, srcObject, logsBucket: names.logsBucket, steps: ci.steps, env: ci.env, node, docker: ci.docker, timeoutSec: ci.timeoutSec });
  const argsFor = (name, scriptFile) => (zone) => createArgs({ name, project: cfg.project, zone, machine: ci.machine, diskGb: ci.diskGb, serviceAccount: cfg.serviceAccount, maxRunSec, scriptFile });

  if (flags['dry-run']) {
    const runId = runIdFor(clock(), 'xxxx');
    const srcObject = `ci/${utcStamp(clock())}-sha256.tgz`;
    const result = {
      status: 'DRY_RUN', exitCode: 0, runId, vm: { name: vmNameFor(runId), zones, machine: ci.machine, diskGb: ci.diskGb, maxRunSec },
      steps: ci.steps, node, files: files.length, hourlyUsd: rate, maxCostUsd: Math.round(runCostUsd(maxRunSec, ci.machine, ci.diskGb) * 10000) / 10000,
      createArgs: argsFor(vmNameFor(runId), '<startup-script>')(zones[0]), script: scriptFor(runId, srcObject),
    };
    if (flags.json) out.result(result);
    else {
      out.info(`Would run ${ci.steps.length} step(s) on ${ci.machine} (${zones.join(' / ')}), Node ${node}, ${files.length} files, at most ${formatDuration(maxRunSec)} ≈ ${money(result.maxCostUsd)}${estimate}.`);
      out.info(`gcloud ${result.createArgs.join(' ')}`);
      out.log(result.script);
    }
    return EXIT.OK;
  }

  credentials({ env, homeDir, cfg });
  const gcloud = deps.gcloud || createGcloudRunner({ env });
  const { storage } = await createClients({ project: cfg.project });
  const month = monthRange(undefined, clock()).month;

  // The cap: refuse before anything costs money.
  const { ledger } = await readLedger(storage, names.logsBucket, month);
  const cap = evaluateCap(ledger, clock());
  if (!cap.ok) {
    const summary = (await recordOff({ storage, bucket: names.logsBucket, month, reason: cap.reason, clock, homeDir, env, warn: out.warn })) || ciSummary({ ...ledger, disabled: { reason: cap.reason } }, clock());
    const message = `CI is off for ${month}: ${cap.reason}. It turns back on at the start of next month.`;
    if (flags.json) out.result({ status: 'CI_OFF', exitCode: EXIT.CI_OFF, error: { type: 'CiOff', message, fix: 'Run the gate locally, or wait for next month. Only the owner can lift a pace stop (dockeriser ci enable); the hard stop has no override.' }, ci: summary });
    else out.error(new DockeriserError(message, { exitCode: EXIT.CI_OFF, fix: 'Run the gate locally, or wait for next month.' }));
    return EXIT.CI_OFF;
  }

  // Leftover VMs go first; then wait for a free slot.
  let live = sweepNow({ gcloud, cfg, clock, out });
  const waitStart = Date.now();
  while (live.length >= MAX_LIVE_VMS) {
    if (Date.now() - waitStart > SLOT_WAIT_MAX_MS) throw new DockeriserError(`${live.length} CI VMs are still running after 20 minutes of waiting.`, { fix: 'See them with `dockeriser ci status`; `dockeriser ci cleanup --force` deletes every CI VM.' });
    out.info(`    ${live.length} CI VMs are running (the limit is ${MAX_LIVE_VMS}); waiting for one to finish…`);
    await sleep(SLOT_WAIT_MS);
    live = sweepNow({ gcloud, cfg, clock, out });
  }

  out.step(`Packaging ${root}`);
  const pkg = await packageFiles(root, files, { tmpDir, warn: out.warn });
  let srcObject;
  try {
    out.info(`    ${pkg.fileCount} files, ${formatBytes(pkg.bytes)} (what \`git add -A\` would commit)`);
    srcObject = `ci/${utcStamp(clock())}-${pkg.sha256.slice(0, 8)}.tgz`;
    out.step(`Uploading source to gs://${names.sourceBucket}/${srcObject}`);
    await uploadSource({ storage, bucket: names.sourceBucket, object: srcObject, file: pkg.path, bytes: pkg.bytes, project: cfg.project, serviceAccount: cfg.serviceAccount });
  } finally {
    removeTarball(pkg.path);
  }

  const attempts = flags['no-retry'] ? 1 : 2;
  let res;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    res = await oneRun({ cfg, ci, names, srcObject, scriptFor, argsFor, zones, maxRunSec, gcloud, storage, clock, sleep, exit, sigint, out, tmpDir, root });
    res.summary = await record({ res, storage, names, month, clock, homeDir, env, out, root });
    if (res.status !== 'PREEMPTED' || attempt === attempts) break;
    out.warn(`the spot VM was taken back by Google before the gate finished; retrying once on a new VM (${money(res.costUsd)} spent on the first)`);
  }

  const exitCode = { SUCCESS: EXIT.OK, INTERRUPTED: EXIT.INTERRUPTED }[res.status] ?? EXIT.BUILD_FAILED;
  const result = {
    status: res.status, exitCode, runId: res.runId, vm: res.vm, durationSec: res.durationSec, costUsd: res.costUsd,
    steps: res.steps, failedStep: res.failedStep, errorTail: res.status === 'SUCCESS' ? [] : res.tail, logFile: res.logFile,
    logObject: `gs://${names.logsBucket}/log-${res.runId}.txt`, ci: res.summary,
  };
  if (flags.json) out.result(result);
  else printResult(out, result, estimate);
  return exitCode;
}

function sweepNow({ gcloud, cfg, clock, out }) {
  const res = sweep({ gcloud, project: cfg.project, now: clock(), vms: listCiVms({ gcloud, project: cfg.project }), warn: out.warn });
  if (res.deleted.length) out.info(`    deleted ${res.deleted.length} leftover CI VM(s): ${res.deleted.join(', ')}`);
  return res.live;
}

/** Create one VM, follow it to the end, delete it. Never throws after the VM exists. */
async function oneRun({ cfg, ci, names, srcObject, scriptFor, argsFor, zones, maxRunSec, gcloud, storage, clock, sleep, exit, sigint, out, tmpDir }) {
  const runId = runIdFor(clock(), randHex());
  const name = vmNameFor(runId);
  const scriptFile = path.join(tmpDir, `dockeriser-${runId}.sh`);
  fs.writeFileSync(scriptFile, scriptFor(runId, srcObject));
  out.step(`Starting spot VM ${name} (${ci.machine}, ${zones.length > 1 ? `${zones[0]}…` : zones[0]})`);
  let zone;
  try {
    ({ zone } = createVm({ gcloud, zones, argsFor: argsFor(name, scriptFile), project: cfg.project, warn: out.warn }));
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
  const createdAt = clock();
  out.info(`    ${zone}; the gate starts after Docker and Node are installed (about 2 minutes)`);

  const logFile = path.join(tmpDir, `dockeriser-${runId}.log`);
  const state = { interrupted: false };
  const removeSigint = sigint(() => {
    if (state.interrupted) {
      out.warn(`quitting without waiting; ${name} is deleted by the next dockeriser ci run (or: dockeriser ci cleanup --force)`);
      exit(EXIT.INTERRUPTED);
      return;
    }
    state.interrupted = true;
    out.warn('stopping: deleting the VM… (press Ctrl-C again to quit without waiting)');
  });
  const tailer = new LogTailer({ storage, bucket: names.logsBucket, buildId: runId, onText: out.log, logFile, onWarn: out.warn, sleep, intervalMs: LOG_POLL_MS }).start();
  let status = null;
  let result = null;
  try {
    for (let i = 1; !status; i++) {
      await sleep(LOG_POLL_MS);
      result = parseResult(tailer.tail(5));
      if (result) break;
      if (state.interrupted) status = 'INTERRUPTED';
      else if ((clock() - createdAt) / 1000 > maxRunSec + 120) status = 'TIMEOUT';
      else if (i % STATUS_EVERY === 0) {
        const s = vmStatus({ gcloud, project: cfg.project, name, zone });
        if (s === 'GONE' || s === 'TERMINATED' || s === 'STOPPED') {
          await tailer.drain();
          result = parseResult(tailer.tail(5));
          if (!result) status = 'PREEMPTED';
        }
      }
    }
    if (result) await tailer.drain();
  } finally {
    await tailer.stop();
    removeSigint();
  }
  const endedAt = clock();
  const del = deleteVm({ gcloud, project: cfg.project, name, zone, wait: false });
  if (!del.ok) out.warn(`could not delete ${name}: ${del.error}. The next dockeriser ci run deletes it, or: dockeriser ci cleanup --force`);
  let deleted = del.ok ? 'requested' : 'failed';
  if (del.ok) {
    await sleep(10000);
    const s = vmStatus({ gcloud, project: cfg.project, name, zone });
    if (s === 'GONE') deleted = 'done';
  }

  if (result) status = result.exitCode === 0 ? 'SUCCESS' : result.exitCode === 124 ? 'TIMEOUT' : 'FAILURE';
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const steps = parseSteps(text);
  const failed = result && result.step ? steps.find((s) => s.index === result.step) : null;
  const setupFailed = /^::dockeriser-ci-setup-failed (.*)$/m.exec(text);
  const durationSec = Math.round((endedAt - createdAt) / 1000);
  const costUsd = Math.round(runCostUsd(durationSec, ci.machine, ci.diskGb) * 1e6) / 1e6;
  if (status === 'SUCCESS') fs.rmSync(logFile, { force: true });
  return {
    runId, status, durationSec, costUsd, steps, totalSteps: ci.steps.length,
    failedStep: failed ? { index: failed.index, command: failed.command, exitCode: failed.exitCode } : setupFailed ? { index: 0, command: `VM setup: ${setupFailed[1]}`, exitCode: result?.exitCode ?? null } : null,
    tail: tailer.tail(40).filter((l) => !/^(::dockeriser-ci-result|DONE$|ERROR$)/.test(l)),
    logFile: status === 'SUCCESS' ? null : logFile,
    vm: { name, zone, machine: ci.machine, deleted },
    startedAt: createdAt.toISOString(), endedAt: endedAt.toISOString(),
  };
}

/** Add the run to the ledger, turn CI off if that crossed a line, mirror the summary. */
async function record({ res, storage, names, month, clock, homeDir, env, out, root }) {
  const by = os.hostname();
  try {
    const ledger = await updateLedger(storage, names.logsBucket, month, (l) => {
      l.runs.push({
        id: res.runId, startedAt: res.startedAt, endedAt: res.endedAt, machine: res.vm.machine, zone: res.vm.zone, status: res.status,
        exitCode: res.status === 'SUCCESS' ? 0 : 1, durationSec: res.durationSec, costUsd: res.costUsd, by, dir: path.basename(root),
      });
      const cap = evaluateCap({ ...l, disabled: null }, clock());
      if (!cap.ok && !l.disabled) l.disabled = { at: clock().toISOString(), reason: cap.reason };
    });
    const summary = ciSummary(ledger, clock());
    writeCiCache(homeDir, summary, env);
    return summary;
  } catch (err) {
    out.warn(`Could not record the run in the CI ledger: ${err.message}`);
    return null;
  }
}

function printResult(out, r, estimate) {
  out.info();
  const vm = r.vm.deleted === 'done' ? 'VM deleted' : r.vm.deleted === 'requested' ? 'VM deletion requested' : `VM ${r.vm.name} NOT deleted`;
  const cost = `≈ ${money(r.costUsd)}${estimate}`;
  if (r.status === 'SUCCESS') {
    out.ok(`CI passed in ${formatDuration(r.durationSec)} (${r.steps.length} steps) · ${cost} · ${vm}`);
    for (const s of r.steps) out.info(`  ${String(s.durationSec ?? '?').padStart(5)}s  ${s.command}`);
  } else {
    const c = out.colour;
    const head = r.failedStep ? `at step ${r.failedStep.index}/${r.steps.length || '?'}: ${r.failedStep.command}${r.failedStep.exitCode !== null ? ` (exit ${r.failedStep.exitCode})` : ''}` : '';
    const what = { FAILURE: 'CI FAILED', TIMEOUT: 'CI TIMED OUT', PREEMPTED: 'CI VM WAS TAKEN BACK (spot preemption) TWICE', INTERRUPTED: 'CI STOPPED' }[r.status] || `CI ${r.status}`;
    out.info(c('red', c('bold', `${what}${head ? ` ${head}` : ''}`)) + ` after ${formatDuration(r.durationSec)} · ${cost} · ${vm}`);
    if (r.errorTail.length) {
      out.info(`  last ${r.errorTail.length} log lines:`);
      for (const line of r.errorTail) out.info(`    ${line}`);
    }
    if (r.logFile) out.info(`  full log:    ${r.logFile}`);
    out.info(`  log object:  ${r.logObject}`);
  }
  if (r.ci) out.info(r.ci.line);
}

/** `dockeriser ci init [dir]` */
async function initSub({ flags, rest, cwd, out }) {
  const res = runCiInit({ dir: rest[0] || cwd, force: flags.force, dryRun: flags['dry-run'] });
  if (flags.json) {
    out.result(res);
    return EXIT.OK;
  }
  if (res.written) out.ok(`Wrote the "ci" section of ${res.file}${res.from ? ` (steps from ${res.from})` : ''}`);
  else if (res.exists) out.warn(`${res.file} already has a "ci" section; not changed (use --force to replace it). Suggested:`);
  else if (res.config) out.info(`Suggested "ci" section${res.from ? ` (steps from ${res.from})` : ''}; nothing written (--dry-run):`);
  if (res.config) out.info(JSON.stringify({ ci: res.config }, null, 2));
  for (const n of res.notes) out.info(`  - ${n}`);
  if (res.config) out.info('\nCheck the steps (they run in order on one VM; the first failure stops the gate). Then: dockeriser ci --dry-run, dockeriser ci.');
  return EXIT.OK;
}

/** Ledger + live VMs, for status and enable. */
async function ledgerContext({ flags, env, homeDir, createClients, deps }) {
  const clock = deps.clock || (() => new Date());
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
  credentials({ env, homeDir, cfg });
  const { storage } = await createClients({ project: cfg.project });
  return { clock, cfg, storage, names: resourceNames(cfg), month: monthRange(undefined, clock()).month, gcloud: deps.gcloud || createGcloudRunner({ env }) };
}

/** `dockeriser ci status` */
async function statusSub(ctx) {
  const { flags, homeDir, env, out } = ctx;
  const { clock, cfg, storage, names, month, gcloud } = await ledgerContext(ctx);
  const { ledger } = await readLedger(storage, names.logsBucket, month);
  const summary = ciSummary(ledger, clock());
  writeCiCache(homeDir, summary, env);
  const cap = evaluateCap(ledger, clock());
  let vms = [];
  let vmError = null;
  try {
    vms = listCiVms({ gcloud, project: cfg.project });
  } catch (err) {
    vmError = err.message;
  }
  const result = { ...summary, on: cap.ok, reason: cap.reason, projectedUsd: cap.projectedUsd, vms, vmError, recent: ledger.runs.slice(-5) };
  if (flags.json) {
    out.result(result);
    return EXIT.OK;
  }
  out.info(summary.line);
  if (cap.ok) out.info(`  pace: ${money(cap.projectedUsd)} by month end at this rate (off past ${money(CI_MONTHLY_CAP_USD)}; the pace check starts on day 7)${ledger.override ? '; the owner lifted the pace check this month' : ''}`);
  for (const r of ledger.runs.slice(-5)) out.info(`  ${r.startedAt?.slice(0, 16).replace('T', ' ')}  ${String(r.status).padEnd(11)} ${formatDuration(r.durationSec || 0).padStart(8)}  ${money(r.costUsd || 0).padStart(7)}  ${r.dir || ''}`);
  if (vmError) out.warn(`could not list CI VMs: ${vmError}`);
  else out.info(vms.length ? `live CI VMs: ${vms.map((v) => `${v.name} (${v.status}, ${v.zone})`).join(', ')}` : 'no CI VMs running');
  return EXIT.OK;
}

/** `dockeriser ci enable` (owner only): lift the pace check for the rest of the month. */
async function enableSub(ctx) {
  const { flags, homeDir, env, out } = ctx;
  const { clock, storage, names, month } = await ledgerContext(ctx);
  let refused = null;
  const ledger = await updateLedger(storage, names.logsBucket, month, (l) => {
    const hard = evaluateCap({ ...l, disabled: null, override: true }, clock());
    if (!hard.ok) {
      refused = hard.reason;
      return;
    }
    l.override = true;
    l.disabled = null;
  });
  if (refused) throw new ConfigError(`CI stays off for ${month}: ${refused}. The $${CI_MONTHLY_CAP_USD} hard stop has no override.`, { fix: 'It turns back on at the start of next month.' });
  const summary = ciSummary(ledger, clock());
  writeCiCache(homeDir, summary, env);
  if (flags.json) out.result({ ok: true, ...summary });
  else out.ok(`CI is on for the rest of ${month}; the pace check is lifted, the $${CI_MONTHLY_CAP_USD} hard stop still applies. ${summary.line}`);
  return EXIT.OK;
}

/** `dockeriser ci cleanup [--force]`: delete leftover CI VMs (every CI VM with --force). */
async function cleanupSub({ flags, env, homeDir, deps, out }) {
  const clock = deps.clock || (() => new Date());
  const cfg = resolveConfig({ searched: homeSearch({ env }), flags, env, homeDir });
  const gcloud = deps.gcloud || createGcloudRunner({ env });
  const vms = listCiVms({ gcloud, project: cfg.project });
  let deleted = [];
  if (flags.force) {
    for (const vm of vms) {
      const res = deleteVm({ gcloud, project: cfg.project, name: vm.name, zone: vm.zone, wait: false });
      if (res.ok) deleted.push(vm.name);
      else out.warn(`could not delete ${vm.name}: ${res.error}`);
    }
  } else {
    deleted = sweep({ gcloud, project: cfg.project, now: clock(), vms, warn: out.warn }).deleted;
  }
  const left = vms.filter((v) => !deleted.includes(v.name)).map((v) => v.name);
  if (flags.json) out.result({ ok: true, deleted, running: left });
  else {
    out.ok(deleted.length ? `Deleting ${deleted.length} CI VM(s): ${deleted.join(', ')}` : 'No leftover CI VMs.');
    if (left.length) out.info(`Still running (a live gate; --force deletes them too): ${left.join(', ')}`);
  }
  return EXIT.OK;
}
