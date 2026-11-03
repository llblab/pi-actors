// Standalone, excluded experiment: importing this file never starts a native query.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

export const MAX_BYTES = 1024 * 1024;
const schema = 'native-mi-v1';
const ownKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const fail = () => { throw new Error('Unsupported prototype evidence'); };
const hash = value => createHash('sha256').update(value).digest('hex');

const failureReports = new WeakMap();
const representationFailures = new WeakSet();
const flagKeys = ['date', 'command', 'digest', 'accepted', 'wrong_rejected', 'failure_unavailable'];
export function buildFailure(stage, code, bytes) {
  if (!['environment', 'compile', 'link', 'dumpbin', 'dependency-profile'].includes(stage)) fail();
  const text = Buffer.isBuffer(bytes) ? bytes.subarray(0, MAX_BYTES).toString('utf8') : '';
  const allowed = ['C1083', 'C2065', 'C2143', 'C2664', 'LNK1104', 'LNK1112', 'LNK2019', 'LNK2001', 'LNK1120'];
  return { schema: 'native-mi-build-failure-v1', status: 'failed', stage,
    exit_code: Number.isInteger(code) && code >= 0 && code <= 65535 ? code : null,
    codes: allowed.filter(token => new RegExp(`\\b${token}\\b`).test(text)) };
}

// Bound allocation and I/O before sanitizing an ephemeral compiler log.
export async function readBuildFailure(stage, code, path) {
  const unavailable = buildFailure(stage, code, Buffer.alloc(0));
  let file;
  try {
    file = await open(path, 'r');
    const bytes = Buffer.alloc(MAX_BYTES);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buildFailure(stage, code, bytes.subarray(0, offset));
  } catch { return unavailable; }
  finally { try { await file?.close(); } catch {} }
}

export function nativeFailure(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return 'protocol-unavailable';
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!['', '\n', '\r\n'].some(ending => text === JSON.stringify(value) + ending)) return 'protocol-unavailable';
    if (ownKeys(value, ['schema', 'status']) && value.schema === schema &&
      ['application', 'session', 'input', 'retrieval', 'operation', 'representation', 'cleanup'].includes(value.status)) return value.status;
  } catch {}
  return 'protocol-unavailable';
}

export function comparisonFailure(flags) {
  return flagKeys.find(key => flags[key] !== true) ? `${flagKeys.find(key => flags[key] !== true)}-mismatch` : null;
}

export function failureReport(stage = 'experiment', profile = null, category = 'unproven', flags) {
  const categories = ['unproven', 'protocol-unavailable', 'application', 'session', 'input', 'retrieval', 'operation',
    'representation', 'cleanup', 'cleanup-esrch-refused', ...flagKeys.map(key => `${key}-mismatch`)];
  if (!['experiment', 'native', 'comparison', 'cleanup'].includes(stage) ||
    ![null, 'scalar', 'shared'].includes(profile) || !categories.includes(category)) fail();
  const comparison = {};
  for (const key of flagKeys) if (typeof flags?.[key] === 'boolean') comparison[key] = flags[key];
  return { schema: 'native-mi-experiment-v1', status: 'unproven-retain-state', stage, profile, category, comparison };
}

export async function preservingCleanup(work, cleanup) {
  let primary, failed = false, result;
  try { result = await work(); } catch (error) { primary = error; failed = true; }
  try { await cleanup(); } catch (error) {
    if (!failed) throw error;
    throw new AggregateError([primary, error], 'Prototype failure and cleanup failure', { cause: primary });
  }
  if (failed) throw primary;
  return result;
}

export function queryArguments(profile, pids) {
  if (!['scalar', 'shared'].includes(profile) || !Array.isArray(pids) || !pids.length || pids.length > 64 ||
    (profile === 'scalar' && pids.length !== 1) || new Set(pids).size !== pids.length ||
    Array.from(pids).some(pid => !Number.isSafeInteger(pid) || pid <= 0)) fail();
  const query = `SELECT ${profile === 'shared' ? 'ProcessId,' : ''}CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE ${pids.map(pid => `ProcessId = ${pid}`).join(' OR ')}`;
  if (query.length > 4096 || !/^[\x00-\x7f]+$/.test(query)) fail();
  return [profile, ...pids.map(String)];
}

// Candidate only: actual PowerShell differential equality, not this formula, admits a native profile.
export function candidateDate(value) {
  const fail = () => { const error = new Error('Unsupported prototype representation'); representationFailures.add(error); throw error; };
  const fields = ['profile', 'year', 'month', 'day', 'hour', 'minute', 'second', 'microseconds', 'utc'];
  if (!ownKeys(value, fields) || value.profile !== 'mi-timestamp-v1') fail();
  if (fields.slice(1).some(key => !Number.isInteger(value[key]))) fail();
  const { year, month, day, hour, minute, second, microseconds, utc } = value;
  if (year < 1601 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 ||
    microseconds < 0 || microseconds > 999999 || utc < -720 || utc > 840) fail();
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) fail();
  return `/Date(${calendar.getTime() - utc * 60000 + Math.floor(microseconds / 1000)})/`;
}

export function decodeResponse(bytes, profile, pids) {
  queryArguments(profile, pids);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  if (!ownKeys(value, ['schema', 'status', 'profile', 'complete', 'rows']) || value.schema !== schema ||
    value.status !== 'ok' || value.profile !== profile || value.complete !== true || !Array.isArray(value.rows) ||
    value.rows.length > pids.length) fail();
  const result = new Map();
  for (const row of value.rows) {
    if (!ownKeys(row, profile === 'shared' ? ['pid', 'date', 'exe', 'cmd'] : ['date', 'exe', 'cmd'])) fail();
    const pid = profile === 'shared' ? row.pid : pids[0];
    if (!Number.isSafeInteger(pid) || !pids.includes(pid) || result.has(pid)) fail();
    // Native types must be valid; optional provider null is normalized just like the legacy decoder.
    if (![row.exe, row.cmd].every(v => v === null || typeof v === 'string')) fail();
    result.set(pid, { platform: 'win32', start_time: candidateDate(row.date),
      command: `${typeof row.exe === 'string' ? row.exe : ''}\n${typeof row.cmd === 'string' ? row.cmd : ''}`.trim() });
  }
  return result; // Missing rows remain unavailable, never absence.
}

export function compareIdentity(expected, candidate, pid, digest, verify) {
  const date = candidate?.start_time === expected.start_time;
  const command = candidate?.command === expected.command;
  const digestEqual = digest(candidate) !== undefined && digest(candidate) === digest(expected);
  const decision = verify(pid, expected, 'win32', () => candidate, () => true);
  const wrong = verify(pid, { ...expected, start_time: expected.start_time + 'wrong' }, 'win32', () => candidate, () => true);
  const unavailable = verify(pid, expected, 'win32', () => undefined, () => true);
  return { date, command, digest: digestEqual, accepted: decision.status === 'valid',
    wrong_rejected: wrong.status === 'owner_mismatch', failure_unavailable: unavailable.status === 'unsupported_proof' };
}

export function unchangedFixtureFrame(original, current, originalBytes, currentBytes) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(field =>
    original[field] !== undefined && original[field] === current[field]) && originalBytes === currentBytes;
}

function absent(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

function capture(executable, args, receipts) {
  const start = performance.now();
  const cp = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const receipt = { pid: undefined, spawned: false, closed: false, code: null, signal: null, duration_ms: null };
  receipts.push(receipt);
  const chunks = [];
  let size = 0, invalid = false;
  cp.once('spawn', () => { receipt.spawned = true; receipt.pid = cp.pid; });
  cp.on('error', () => { invalid = true; });
  cp.stdout.on('data', bytes => { size += bytes.length; if (size <= MAX_BYTES) chunks.push(bytes); else invalid = true; });
  cp.stderr.on('data', () => { invalid = true; });
  return new Promise(resolveResult => cp.once('close', (code, signal) => {
    Object.assign(receipt, { closed: true, code, signal, duration_ms: performance.now() - start });
    resolveResult({ bytes: Buffer.concat(chunks), receipt, complete: !invalid,
      ok: !invalid && receipt.spawned && code === 0 && signal === null });
  }));
}

// The historical full-instance script is intentionally independent of the MI representation adapter.
export function oldReferenceCommand(pid) {
  queryArguments('scalar', [pid]);
  return [`$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\";`,
    'if ($null -eq $p) { exit 3 };',
    '$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress'].join(' ');
}

function referenceIdentity(bytes) {
  if (bytes.length > MAX_BYTES) fail();
  const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!ownKeys(row, ['CreationDate', 'ExecutablePath', 'CommandLine']) || typeof row.CreationDate !== 'string') fail();
  return { platform: 'win32', start_time: row.CreationDate,
    command: `${typeof row.ExecutablePath === 'string' ? row.ExecutablePath : ''}\n${typeof row.CommandLine === 'string' ? row.CommandLine : ''}`.trim() };
}

async function currentReference(pid, receipts) {
  // Evaluate the actual existing scalar owner with a lexical transport receipt, not a global spawn interceptor.
  // spawnSync's returned status is native termination, not an asynchronous 'close' dispatch receipt.
  const source = await readFile(new URL('../../lib/runs-process.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('function readWindowsIdentity(');
  const end = source.indexOf('export const WINDOWS_IDENTITY_QUERY_PID_LIMIT', begin);
  assert.ok(begin > 0 && end > begin);
  const dispatchBegin = source.indexOf('export function readProcessIdentity(');
  const dispatchEnd = source.indexOf('export function runProcessIdentityDigest(', dispatchBegin);
  assert.ok(dispatchBegin > end && dispatchEnd > dispatchBegin);
  const scalar = stripTypeScriptTypes(source.slice(begin, end) + '\n' +
    source.slice(dispatchBegin, dispatchEnd).replace('export function readProcessIdentity', 'function readProcessIdentity'));
  const start = performance.now();
  const read = runInNewContext(`${scalar}\nreadProcessIdentity`, { spawnSync: (...args) => {
    const result = spawnSync(...args);
    receipts.push({ pid: result.pid, spawned: Number.isSafeInteger(result.pid) && result.pid > 0,
      terminated: result.status !== null && !result.signal && !result.error,
      code: result.status, signal: result.signal, duration_ms: performance.now() - start });
    return result;
  } });
  return { identity: JSON.parse(JSON.stringify(read(pid, 'win32') ?? null)), sourceHash: hash(source), duration_ms: performance.now() - start };
}

async function experiment(helper) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !helper || !resolve(helper).endsWith('.exe')) fail();
  const { runProcessIdentityDigest: digest, verifyRunProcessIdentity: verify } = await import('../../lib/runs-process.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-native-mi-'));
  const receipts = [];
  let child, childReceipt, released = false, completed = false;
  let closePromise;
  const durations = {};
  let report = failureReport();
  try {
    return await preservingCleanup(async () => {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', root], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    childReceipt = { pid: undefined, spawned: false, ready: false, closed: false, released: false, error: false };
    child.on('error', () => { childReceipt.error = true; });
    receipts.push(childReceipt);
    closePromise = new Promise(resolveClose => child.once('close', (code, signal) => {
      Object.assign(childReceipt, { closed: true, code, signal, close_dispatch_ms: performance.now() });
      resolveClose();
    }));
    await new Promise((resolveReady, reject) => {
      child.once('spawn', () => Object.assign(childReceipt, { pid: child.pid, spawned: true, spawn_dispatch_ms: performance.now() }));
      child.once('error', reject);
      child.once('close', () => { if (!childReceipt.ready) reject(new Error('Child closed before ready')); });
      child.once('message', message => {
        if (!ownKeys(message, ['schema']) || message.schema !== 'native-mi-child-ready-v1' || !childReceipt.spawned) reject(new Error('Invalid readiness'));
        else { childReceipt.ready = true; resolveReady(); }
      });
    });
    const fence = () => { if (!childReceipt.ready || childReceipt.closed || childReceipt.error || child.exitCode !== null || child.signalCode !== null || child.pid !== childReceipt.pid) fail(); };
    fence();
    const current = await currentReference(child.pid, receipts);
    durations.current_reference_ms = current.duration_ms;
    fence();
    const historical = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', oldReferenceCommand(child.pid)], receipts);
    durations.old_reference_ms = historical.receipt.duration_ms;
    if (!historical.ok || !current.identity) fail();
    const expected = referenceIdentity(historical.bytes);
    assert.deepEqual(current.identity, expected);
    const frame = JSON.stringify({ schema: 'fixture-owned-not-sdk-run-v1', pid: child.pid, identity: expected, digest: digest(expected) });
    const path = join(root, 'identity.json');
    await writeFile(path, frame, { flag: 'wx' });
    const physical = await lstat(path, { bigint: true });
    const readFrame = async () => {
      fence();
      const now = await lstat(path, { bigint: true });
      const bytes = await readFile(path, 'utf8');
      assert.ok(unchangedFixtureFrame(physical, now, frame, bytes));
      const after = await lstat(path, { bigint: true });
      assert.ok(unchangedFixtureFrame(physical, after, frame, bytes));
      fence();
      return JSON.parse(bytes).identity;
    };
    const compatibility = {};
    for (const profile of ['scalar', 'shared']) {
      const original = await readFrame();
      const native = await capture(helper, queryArguments(profile, [child.pid]), receipts);
      durations[`${profile}_ms`] = native.receipt.duration_ms;
      report = failureReport('native', profile, native.complete ? nativeFailure(native.bytes) : 'protocol-unavailable');
      if (!native.ok) fail();
      await readFrame();
      report = failureReport('native', profile, 'protocol-unavailable');
      let candidate;
      try { candidate = decodeResponse(native.bytes, profile, [child.pid]).get(child.pid); }
      catch (error) {
        if (representationFailures.has(error)) report = failureReport('native', profile, 'representation');
        throw error;
      }
      const flags = compareIdentity(original, candidate, child.pid, digest, verify);
      compatibility[profile] = flags;
      report = failureReport('comparison', profile, comparisonFailure(flags) ?? 'unproven', flags);
      if (!Object.values(flags).every(v => v === true)) fail();
    }
    await readFrame();
    report = failureReport('cleanup', report.profile, 'cleanup', report.comparison);
    childReceipt.released = true;
    released = true;
    child.send({ schema: 'native-mi-child-release-v1' });
    await closePromise;
    if (childReceipt.code !== 0 || childReceipt.signal !== null || childReceipt.error) fail();
    if (!receipts.every(r => r.spawned && (r.closed || r.terminated) && r.code === 0 && r.signal === null)) fail();
    durations.child_spawn_to_close_dispatch_ms = childReceipt.close_dispatch_ms - childReceipt.spawn_dispatch_ms;
    // Probe every captured process afresh immediately before each deletion. Unknown roots are retained.
    report = failureReport('cleanup', report.profile, 'cleanup-esrch-refused', report.comparison);
    if (!receipts.every(r => absent(r.pid))) fail();
    await rm(root, { recursive: true });
    completed = true;
    return { schema: 'native-mi-experiment-v1', status: 'compatible-tested-child-only', compatibility, durations,
      close_basis: 'parent-monotonic-dispatch-not-kernel-exit',
      lifecycle: { child_spawned_ready_released_closed: true, native_helper_actual_closes: 2,
        historical_reference_actual_close: true, current_reference_sync_native_termination: true },
      sources: { reader: current.sourceHash, harness: hash(await readFile(fileURLToPath(import.meta.url))),
        native: hash(await readFile(new URL('../../native/windows-mi/windows-mi.cpp', import.meta.url))) },
      artifact_sha256: hash(await readFile(helper)), cleanup: 'fresh-esrch-all-captured-processes' };
    }, async () => {
    if (!completed && child && childReceipt?.spawned && !released && !childReceipt.closed && child.connected) {
      // Even on query failure, release only our own workload naturally; never delete uncertain state.
      child.send({ schema: 'native-mi-child-release-v1' });
      await closePromise;
    }
    });
  } catch (error) {
    const privateError = new AggregateError([error], 'Prototype experiment failed', { cause: error });
    failureReports.set(privateError, report);
    throw privateError;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === '--child') {
  const gate = setInterval(() => {}, 1000);
  process.once('message', message => {
    if (!ownKeys(message, ['schema']) || message.schema !== 'native-mi-child-release-v1') return;
    clearInterval(gate);
    if (process.connected) process.disconnect();
  });
  process.send({ schema: 'native-mi-child-ready-v1' });
} else if (isMain && process.argv[2] === '--build-failure') {
  const stage = process.argv[3];
  console.log(JSON.stringify(await readBuildFailure(stage, Number(process.argv[4]), process.argv[5])));
} else if (isMain) {
  try { console.log(JSON.stringify(await experiment(process.argv[2]))); }
  catch (error) { console.log(JSON.stringify(failureReports.get(error) ?? failureReport())); process.exitCode = 1; }
}
