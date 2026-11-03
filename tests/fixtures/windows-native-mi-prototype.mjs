// Standalone, excluded experiment: importing this file never starts a native query.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
const commandDiagnostics = new WeakMap();
const prestdoutDiagnostics = new WeakMap();
const prestdoutDiagnosticKeys = ['schema', 'stage', 'case', 'reference', 'relation'];
export function projectPrestdoutDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object' || Reflect.ownKeys(value).length !== 5) return;
    const copy = Object.create(null);
    for (const key of prestdoutDiagnosticKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return;
      copy[key] = descriptor.value;
    }
    if (copy.schema !== 'native-mi-prestdout-diagnostic-v1' || copy.stage !== 'comparison' ||
      copy.case !== 'live-scalar-long' || copy.reference !== 'historical-full-instance' ||
      !['native-only-match', 'baseline-only-match', 'neither-match'].includes(copy.relation)) return;
    const line = JSON.stringify(copy) + '\n';
    return Buffer.byteLength(line, 'utf8') <= 512 ? line : undefined;
  } catch {}
}

// Only the first eligible LONG mismatch consumes the private candidate; retain facts, never strings.
export function firstLongCommandMismatchOwner() {
  let attempted = false, frozen;
  return {
    capture(caseName, report, snapshot, baseline, native) {
      if (attempted) return;
      try {
        if (caseName !== 'live-scalar-long' || report.stage !== 'comparison' ||
          report.profile !== 'scalar' || report.category !== 'command-mismatch') return;
        attempted = true;
        if (![snapshot, baseline, native].every(value => typeof value === 'string') || baseline === native) return;
        const relation = snapshot === native ? 'native-only-match' :
          snapshot === baseline ? 'baseline-only-match' : 'neither-match';
        const record = { schema: 'native-mi-prestdout-diagnostic-v1', stage: 'comparison',
          case: 'live-scalar-long', reference: 'historical-full-instance', relation };
        if (projectPrestdoutDiagnostic(record)) frozen = Object.freeze(record);
      } catch {}
    },
    associate(error) { try { if (frozen) prestdoutDiagnostics.set(error, frozen); } catch {} },
    project() { return projectPrestdoutDiagnostic(frozen); },
  };
}
const diagnosticKeys = ['schema', 'stage', 'case', 'reference', 'executable_relation', 'command_line_relation'];
const relations = ['equal-strings', 'different-strings', 'reference-only-string', 'native-only-string', 'both-nonstrings'];
const primitivePart = value => typeof value === 'string' ? value : undefined;
export function commandRelation(reference, native) {
  if (typeof reference === 'string') return typeof native === 'string' ?
    (reference === native ? 'equal-strings' : 'different-strings') : 'reference-only-string';
  return typeof native === 'string' ? 'native-only-string' : 'both-nonstrings';
}
export function projectCommandDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object' || Reflect.ownKeys(value).length !== diagnosticKeys.length) return;
    const copy = {};
    for (const key of diagnosticKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return;
      copy[key] = descriptor.value;
    }
    if (copy.schema !== 'native-mi-command-diagnostic-v1' || copy.stage !== 'comparison' ||
      !['live-scalar-short', 'live-scalar-long'].includes(copy.case) || copy.reference !== 'historical-full-instance' ||
      !relations.includes(copy.executable_relation) || !relations.includes(copy.command_line_relation)) return;
    const line = JSON.stringify(copy) + '\n';
    return Buffer.byteLength(line, 'utf8') <= 512 ? line : undefined;
  } catch {}
}

// One experiment-local first attempt; only primitive facts survive scalar consumption.
export function commandDiagnosticOwner() {
  let attempted = false, frozen;
  return {
    capture(caseName, report, reference, native) {
      if (attempted) return;
      try {
        if (report.stage !== 'comparison' || report.profile !== 'scalar' || report.category !== 'command-mismatch' ||
          !['live-scalar-short', 'live-scalar-long'].includes(caseName)) return;
        attempted = true;
        if (!reference || !native) return;
        const referenceExe = primitivePart(reference.exe), referenceCmd = primitivePart(reference.cmd);
        const nativeExe = primitivePart(native.exe), nativeCmd = primitivePart(native.cmd);
        if (`${referenceExe ?? ''}\n${referenceCmd ?? ''}`.trim() === `${nativeExe ?? ''}\n${nativeCmd ?? ''}`.trim()) return;
        const record = { schema: 'native-mi-command-diagnostic-v1', stage: 'comparison', case: caseName,
          reference: 'historical-full-instance', executable_relation: commandRelation(referenceExe, nativeExe),
          command_line_relation: commandRelation(referenceCmd, nativeCmd) };
        if (projectCommandDiagnostic(record)) frozen = Object.freeze(record);
      } catch {}
    },
    associate(error) { if (frozen) commandDiagnostics.set(error, frozen); },
    project() { return projectCommandDiagnostic(frozen); },
  };
}

export function experimentFailure(error, report, diagnostic, prestdoutDiagnostic) {
  const privateError = new AggregateError([error], 'Prototype experiment failed', { cause: error });
  failureReports.set(privateError, report);
  diagnostic.associate(privateError);
  try { prestdoutDiagnostic?.associate(privateError); } catch {}
  return privateError;
}
export function emitExperimentFailure(error, write, outcome) {
  const prestdoutLine = projectPrestdoutDiagnostic(prestdoutDiagnostics.get(error));
  if (prestdoutLine) {
    try { write(prestdoutLine); } catch {}
  }
  const line = projectCommandDiagnostic(commandDiagnostics.get(error));
  if (line) {
    // Optional diagnostic I/O cannot preempt the original failure path.
    try { write(line); } catch {}
  }
  write(JSON.stringify(failureReports.get(error) ?? failureReport()) + '\n');
  outcome.exitCode = 1;
}
// Private data-only admission: no identity, lifecycle or writer-closure authority.
export function decodePrestdoutCapsule(bytes, nonce) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 131200 || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return;
    for (const byte of bytes) if (byte > 127) return;
    const lines = bytes.toString('ascii').split('\n');
    if (lines.length !== 5 || lines[0] !== 'native-mi-prestdout-witness-v1' || lines[1] !== nonce ||
      lines[2] !== '0041D8000000DC00D83DDE00' || lines[4] !== '' ||
      lines[3].length > 32767 * 4 || !/^(?:[0-9A-F]{4})*$/.test(lines[3])) return;
    let value = '';
    for (let i = 0; i < lines[3].length; i += 4) value += String.fromCharCode(parseInt(lines[3].slice(i, i + 4), 16));
    return value;
  } catch {}
}

// Cooperative owned-root fences, not authentication or writer-closure evidence.
export async function reservePrestdoutCapsule(path, nonce, io = { open, lstat }) {
  const keys = ['dev', 'ino', 'mode', 'nlink', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'];
  const frame = stats => {
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const copy = {};
    for (const key of keys) {
      const value = stats[key];
      if (typeof value !== 'bigint' || value < 0n) return;
      copy[key] = value;
    }
    if (copy.ino === 0n || copy.nlink !== 1n || copy.size > 131200n) return;
    return copy;
  };
  const equal = (a, b, fields = keys) => a && b && fields.every(key => a[key] === b[key]);
  let handle, original, openError, ready = false, attempted = false, closing, uncertain = false;
  const close = () => {
    if (!closing) closing = Promise.resolve().then(async () => {
      if (!handle) return uncertain ? { closed: false, error: openError } : { closed: true };
      try { await handle.close(); return { closed: true }; }
      catch (error) { uncertain = true; return { closed: false, error }; }
    });
    return closing;
  };
  const observe = async () => {
    const descriptor = frame(await handle.stat({ bigint: true }));
    const leaf = frame(await io.lstat(path, { bigint: true }));
    if (!equal(descriptor, leaf)) return;
    if (original && !equal(descriptor, original, ['dev', 'ino', 'birthtimeNs'])) return;
    return descriptor;
  };
  try {
    if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) throw undefined;
    try { handle = await io.open(path, 'wx+', 0o600); }
    catch (error) { uncertain = true; openError = error; throw error; }
    const seed = Buffer.from(`native-mi-prestdout-reservation-v1\n${nonce}\n`, 'ascii');
    await handle.writeFile(seed);
    original = await observe();
    ready = !!original && original.size === BigInt(seed.length);
  } catch {}
  if (!ready) await close();
  return Object.freeze({
    ready,
    retentionRequired: () => uncertain,
    close,
    async read() {
      if (attempted || !ready || closing) return;
      attempted = true;
      let candidate;
      try {
        const before = await observe();
        if (!before) return;
        // One bounded detection byte beyond the cap; explicit positions ignore seed offset.
        const bytes = Buffer.alloc(131201);
        let length = 0, eof = false;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - length) return;
          if (bytesRead === 0) { eof = true; break; }
          length += bytesRead;
        }
        if (!eof || length > 131200 || BigInt(length) !== before.size) return;
        const after = await observe();
        if (!equal(before, after)) return;
        candidate = decodePrestdoutCapsule(bytes.subarray(0, length), nonce);
      } catch {} finally {
        const result = await close();
        if (!result.closed) candidate = undefined;
      }
      return candidate;
    },
  });
}

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

// Candidate only: equality covers exercised fixture rows, not production UTC/environment/precision admission.
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
  return decodeResponseParts(bytes, profile, pids).identities;
}
function decodeResponseParts(bytes, profile, pids) {
  queryArguments(profile, pids);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  if (!ownKeys(value, ['schema', 'status', 'profile', 'complete', 'rows']) || value.schema !== schema ||
    value.status !== 'ok' || value.profile !== profile || value.complete !== true || !Array.isArray(value.rows) ||
    value.rows.length > pids.length) fail();
  const result = new Map(), parts = new Map();
  for (const row of value.rows) {
    if (!ownKeys(row, profile === 'shared' ? ['pid', 'date', 'exe', 'cmd'] : ['date', 'exe', 'cmd'])) fail();
    const pid = profile === 'shared' ? row.pid : pids[0];
    if (!Number.isSafeInteger(pid) || !pids.includes(pid) || result.has(pid)) fail();
    // Native types must be valid; optional provider null is normalized just like the legacy decoder.
    if (![row.exe, row.cmd].every(v => v === null || typeof v === 'string')) fail();
    parts.set(pid, { exe: primitivePart(row.exe), cmd: primitivePart(row.cmd) });
    result.set(pid, { platform: 'win32', start_time: candidateDate(row.date),
      command: `${typeof row.exe === 'string' ? row.exe : ''}\n${typeof row.cmd === 'string' ? row.cmd : ''}`.trim() });
  }
  return { identities: result, parts }; // Missing rows remain unavailable, never absence.
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

// The full-instance query stays independent of the MI adapter; stdout intentionally uses explicit UTF8.
export function oldReferenceCommand(pid) {
  queryArguments('scalar', [pid]);
  return [`$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\";`,
    'if ($null -eq $p) { exit 3 }; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true);',
    '$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress'].join(' ');
}

// Pure optional LONG builder; erasing its insertion restores the whole UTF8-corrected reference command.
export function prestdoutReferenceCommand(pid, path, nonce) {
  const original = oldReferenceCommand(pid);
  if (typeof path !== 'string' || !path.length || path.length > 32767 || /[\u0000\r\n]/.test(path) ||
    typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) fail();
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const insertion = `& { try {
    $s = $p.CommandLine;
    if ($s -isnot [System.String] -or $s.Length -gt 32767) { return };
    $transcribe = { param([System.String]$text)
      $hex = New-Object System.Text.StringBuilder;
      for ($i = 0; $i -lt $text.Length; $i++) {
        [void]$hex.Append(([int][char]$text[$i]).ToString('X4', [System.Globalization.CultureInfo]::InvariantCulture));
      };
      return $hex.ToString();
    };
    $control = -join ([char[]](0x0041,0xD800,0x0000,0xDC00,0xD83D,0xDE00));
    $controlHex = & $transcribe $control;
    $sHex = & $transcribe $s;
    $nonce = ${literal(nonce)};
    $seed = [System.Text.Encoding]::ASCII.GetBytes("native-mi-prestdout-reservation-v1" + [char]10 + $nonce + [char]10);
    $capsule = [System.Text.Encoding]::ASCII.GetBytes("native-mi-prestdout-witness-v1" + [char]10 + $nonce + [char]10 + $controlHex + [char]10 + $sHex + [char]10);
    if ($capsule.Length -gt 131200) { return };
    $stream = $null;
    try {
      $stream = [System.IO.FileStream]::new(${literal(path)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite);
      $received = New-Object byte[] ($seed.Length + 1);
      $length = 0;
      $eof = $false;
      while ($length -lt $received.Length) {
        $count = $stream.Read($received, $length, $received.Length - $length);
        if ($count -eq 0) { $eof = $true; break };
        $length += $count;
      };
      if (-not $eof -or $length -ne $seed.Length) { return };
      for ($i = 0; $i -lt $seed.Length; $i++) { if ($received[$i] -ne $seed[$i]) { return } };
      $stream.SetLength(0);
      $stream.Position = 0;
      $stream.Write($capsule, 0, $capsule.Length);
      $stream.Flush();
    } finally { if ($null -ne $stream) { $stream.Dispose() } };
  } catch {} } *> $null; `;
  const finalPipeline = '$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  return original.slice(0, -finalPipeline.length) + insertion + finalPipeline;
}

function referenceParts(bytes) {
  if (bytes.length > MAX_BYTES) fail();
  const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!ownKeys(row, ['CreationDate', 'ExecutablePath', 'CommandLine']) || typeof row.CreationDate !== 'string') fail();
  return { parts: { exe: primitivePart(row.ExecutablePath), cmd: primitivePart(row.CommandLine) },
    identity: { platform: 'win32', start_time: row.CreationDate,
      command: `${typeof row.ExecutablePath === 'string' ? row.ExecutablePath : ''}\n${typeof row.CommandLine === 'string' ? row.CommandLine : ''}`.trim() } };
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

// Initiation order is role order; callback faults retain callback encounter order, then close faults
// retain role settlement order. Each fault is surfaced once, including across cleanup re-entry.
export async function releaseChildren(children) {
  const faults = [];
  const record = value => { faults.push(value); };
  for (const child of children) {
    const r = child.receipt;
    if (!r.spawned || r.closed || r.release_attempted || !child.process.connected) continue;
    r.release_attempted = true;
    let settled, deliveryDone = false;
    child.delivery = new Promise(resolveDelivery => { settled = resolveDelivery; });
    const finish = (failed, error) => {
      if (deliveryDone) return;
      deliveryDone = true;
      if (failed) { r.release_failed = true; record(error); }
      else r.release_callback = true;
      settled();
    };
    try {
      child.process.send({ schema: 'native-mi-child-release-v1' }, error => {
        finish(error !== null && error !== undefined, error);
      }); // false is backpressure, not a failed send or delivery receipt.
    } catch (error) {
      if (deliveryDone) { r.release_failed = true; record(error); }
      else finish(true, error);
    }
  }
  // No close promise is consumed until every eligible original child has been attempted.
  for (const child of children) if (child.delivery) await child.delivery;
  for (const child of children) {
    const r = child.receipt;
    if (r.release_attempted && !r.release_failed && r.release_callback && !child.closeChecked) {
      child.closeChecked = true;
      try {
        await child.closePromise;
        if (!r.closed || r.code !== 0 || r.signal !== null || r.error) record(new Error('Unproven natural child close'));
      } catch (error) { record(error); }
    }
  }
  if (faults.length === 1) throw faults[0];
  if (faults.length) throw new AggregateError(faults, 'Prototype release failures', { cause: faults[0] });
}

export function argvAcknowledgement(extraArgv) {
  const text = JSON.stringify(extraArgv);
  return { schema: 'native-mi-child-ready-v1', argv_utf16_units: text.length, argv_sha256: hash(text) };
}

export function matchesArgvAcknowledgement(message, extraArgv) {
  if (!ownKeys(message, ['schema', 'argv_utf16_units', 'argv_sha256'])) return false;
  const expected = argvAcknowledgement(extraArgv);
  return Object.keys(expected).every(key => message[key] === expected[key]);
}

const durationKeys = ['current_reference_short_ms', 'old_reference_short_ms', 'current_reference_long_ms',
  'old_reference_long_ms', 'scalar_short_ms', 'scalar_long_ms', 'shared_live_ms',
  'scalar_short_missing_ms', 'shared_post_close_ms', 'short_spawn_to_close_dispatch_ms', 'long_spawn_to_close_dispatch_ms'];
const roleLifeKeys = ['spawned', 'ready', 'argv_verified', 'release_attempted', 'release_callback', 'closed_natural'];

// Select only closed experiment facts; private frame, argv and receipt fields never enter the report.
export function twoChildSuccess(compatibility, durations, lifecycle, sources, artifact) {
  const flags = value => {
    if (!value || flagKeys.some(key => value[key] !== true)) fail();
    return Object.fromEntries(flagKeys.map(key => [key, true]));
  };
  const missing = value => {
    if (value?.missing !== true || value.unsupported_proof !== true) fail();
    return { missing: true, unsupported_proof: true };
  };
  const life = value => {
    if (!value || roleLifeKeys.some(key => value[key] !== true)) fail();
    return Object.fromEntries(roleLifeKeys.map(key => [key, true]));
  };
  const times = {};
  for (const key of durationKeys) {
    if (typeof durations[key] !== 'number' || !Number.isFinite(durations[key]) || durations[key] < 0) fail();
    times[key] = durations[key];
  }
  const hashes = {};
  for (const key of ['reader', 'harness', 'native']) {
    if (typeof sources[key] !== 'string' || sources[key].length !== 64 || !/^[0-9a-f]+$/.test(sources[key])) fail();
    hashes[key] = sources[key];
  }
  if (typeof artifact !== 'string' || artifact.length !== 64 || !/^[0-9a-f]+$/.test(artifact) ||
    lifecycle.child_actual_closes !== 2 || lifecycle.native_helper_actual_closes !== 5 ||
    lifecycle.historical_reference_actual_closes !== 2 || lifecycle.current_reference_sync_native_terminations !== 2) fail();
  return { schema: 'native-mi-experiment-v1', status: 'compatible-tested-two-children-only',
    children: { count: 2, long_unicode_argv_verified: true },
    reference_basis: 'per-child-current-projected-scalar-and-historical-full-instance',
    compatibility: { live: {
      scalar: { short: flags(compatibility.live.scalar.short), long: flags(compatibility.live.scalar.long) },
      shared: { short: flags(compatibility.live.shared.short), long: flags(compatibility.live.shared.long) } },
      post_close: { scalar: { short: missing(compatibility.post_close.scalar.short) },
        shared: { short: missing(compatibility.post_close.shared.short), long: flags(compatibility.post_close.shared.long) } } },
    durations: times, close_basis: 'parent-monotonic-dispatch-not-kernel-exit',
    lifecycle: { short: life(lifecycle.short), long: life(lifecycle.long), child_actual_closes: 2,
      native_helper_actual_closes: 5, historical_reference_actual_closes: 2, current_reference_sync_native_terminations: 2 },
    sources: hashes, artifact_sha256: artifact, cleanup: 'fresh-esrch-all-captured-processes' };
}

async function experiment(helper) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !helper || !resolve(helper).endsWith('.exe')) fail();
  const { runProcessIdentityDigest: digest, verifyRunProcessIdentity: verify } = await import('../../lib/runs-process.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-native-mi-'));
  const receipts = [], children = [], nativeReceipts = [], historicalReceipts = [], currentReceipts = [];
  const durations = {};
  const diagnostic = commandDiagnosticOwner(), historicalParts = new Map();
  const prestdoutDiagnostic = firstLongCommandMismatchOwner();
  let nativeParts, prestdoutSnapshot, prestdoutOwner;
  let privateClosed = false, privateUncertain = false, privateFailed = false, privateFault, privateSurfaced = false;
  const rememberPrivateFault = error => {
    privateUncertain = true;
    if (!privateFailed) { privateFailed = true; privateFault = error; }
  };
  const closePrestdout = async () => {
    if (!prestdoutOwner || privateClosed) return;
    privateClosed = true;
    try {
      const result = await prestdoutOwner.close();
      if (!result.closed) rememberPrivateFault(result.error);
      if (prestdoutOwner.retentionRequired()) privateUncertain = true;
    } catch (error) { rememberPrivateFault(error); }
  };
  let completed = false, readerHash, report = failureReport();
  const createChild = (role, extraArgv) => {
    const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', root, ...extraArgv],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const receipt = { pid: undefined, spawned: false, ready: false, argv_verified: false, closed: false, error: false };
    const child = { role, process: processChild, receipt };
    children.push(child); receipts.push(receipt);
    let resolveReady, rejectReady;
    child.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.closePromise = new Promise(resolveClose => processChild.once('close', (code, signal) => {
      Object.assign(receipt, { closed: true, code, signal, close_dispatch_ms: performance.now() });
      if (!receipt.ready) rejectReady(new Error('Child closed before ready'));
      resolveClose();
    }));
    processChild.on('error', error => { receipt.error = true; rejectReady(error); });
    processChild.once('spawn', () => {
      Object.assign(receipt, { pid: processChild.pid, spawned: true, spawn_dispatch_ms: performance.now() });
      if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) rejectReady(new Error('Invalid captured child PID'));
    });
    processChild.once('message', message => {
      if (!receipt.spawned || receipt.closed || receipt.error || !matchesArgvAcknowledgement(message, extraArgv)) {
        rejectReady(new Error('Invalid argv readiness')); return;
      }
      receipt.ready = true; receipt.argv_verified = true; resolveReady();
    });
    return child;
  };
  const liveFence = child => {
    const r = child.receipt, cp = child.process;
    if (!r.ready || !r.argv_verified || r.closed || r.error || cp.exitCode !== null || cp.signalCode !== null ||
      !cp.connected || cp.pid !== r.pid || !Number.isSafeInteger(r.pid) || r.pid <= 0) fail();
  };
  const frames = async live => {
    live.forEach(liveFence);
    const result = {};
    for (const child of children) if (child.frame) {
      const before = await lstat(child.path, { bigint: true });
      const bytes = await readFile(child.path, 'utf8');
      const after = await lstat(child.path, { bigint: true });
      if (!unchangedFixtureFrame(child.physical, before, child.frame, bytes) ||
        !unchangedFixtureFrame(child.physical, after, child.frame, bytes)) fail();
      result[child.role] = JSON.parse(bytes);
    }
    live.forEach(liveFence);
    return result;
  };
  try {
    return await preservingCleanup(async () => {
      createChild('short', ['short', 'plain']);
      createChild('long', ['long', '漢字😀 "quoted" \\ segment '.repeat(256), 'trailing\\']);
      const ready = await Promise.allSettled(children.map(child => child.ready));
      const readyFaults = ready.filter(result => result.status === 'rejected').map(result => result.reason);
      if (readyFaults.length === 1) throw readyFaults[0];
      if (readyFaults.length) throw new AggregateError(readyFaults, 'Prototype readiness failures', { cause: readyFaults[0] });
      for (const child of children) {
        await frames(children);
        const current = await currentReference(child.receipt.pid, receipts);
        currentReceipts.push(receipts.at(-1));
        durations['current_reference_' + child.role + '_ms'] = current.duration_ms;
        await frames(children);
        let historicalCommand = oldReferenceCommand(child.receipt.pid);
        if (child.role === 'long') {
          let capsulePath, nonce;
          try {
            nonce = randomBytes(16).toString('hex');
            capsulePath = join(root, 'prestdout-' + nonce);
          } catch {}
          if (capsulePath) {
            try { prestdoutOwner = await reservePrestdoutCapsule(capsulePath, nonce); }
            catch (error) { rememberPrivateFault(error); }
            try {
              if (prestdoutOwner?.ready) historicalCommand = prestdoutReferenceCommand(child.receipt.pid, capsulePath, nonce);
            } catch {}
          }
        }
        const historical = await capture('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', historicalCommand], receipts);
        historicalReceipts.push(historical.receipt);
        durations['old_reference_' + child.role + '_ms'] = historical.receipt.duration_ms;
        await frames(children);
        if (!current.identity || !historical.ok) fail();
        const decoded = referenceParts(historical.bytes), old = decoded.identity;
        assert.deepEqual(current.identity, old);
        historicalParts.set(child.role, decoded.parts);
        if (readerHash !== undefined && readerHash !== current.sourceHash) fail();
        readerHash = current.sourceHash;
        child.path = join(root, child.role + '-identity.json');
        child.frame = JSON.stringify({ schema: 'fixture-owned-not-sdk-run-v1', pid: child.receipt.pid,
          current: current.identity, historical: old, digest: digest(current.identity) });
        await writeFile(child.path, child.frame, { flag: 'wx' });
        child.physical = await lstat(child.path, { bigint: true });
        await frames(children);
        if (child.role === 'long' && prestdoutOwner) {
          if (prestdoutOwner.ready) {
            try { prestdoutSnapshot = await prestdoutOwner.read(); } catch {}
          }
          await closePrestdout();
        }
      }
      const [short, long] = children;
      const compatibility = { live: { scalar: {}, shared: {} }, post_close: { scalar: {}, shared: {} } };
      const observe = async (profile, selected, live, key) => {
        const originals = await frames(live);
        const native = await capture(helper, queryArguments(profile, selected), receipts);
        nativeReceipts.push(native.receipt);
        durations[key] = native.receipt.duration_ms;
        report = failureReport('native', profile, native.complete ? nativeFailure(native.bytes) : 'protocol-unavailable');
        if (!native.ok) fail();
        await frames(live);
        report = failureReport('native', profile, 'protocol-unavailable');
        let rows;
        try {
          const decoded = decodeResponseParts(native.bytes, profile, selected);
          rows = decoded.identities;
          nativeParts = profile === 'scalar' && ['scalar_short_ms', 'scalar_long_ms'].includes(key) ?
            decoded.parts.get(selected[0]) : undefined;
        }
        catch (error) {
          if (representationFailures.has(error)) report = failureReport('native', profile, 'representation');
          throw error;
        }
        return { rows, originals };
      };
      const present = (sample, child, profile) => {
        const original = sample.originals[child.role], candidate = sample.rows.get(child.receipt.pid);
        const current = compareIdentity(original.current, candidate, child.receipt.pid, digest, verify);
        const historical = compareIdentity(original.historical, candidate, child.receipt.pid, digest, verify);
        const flags = Object.fromEntries(flagKeys.map(key => [key, current[key] === true && historical[key] === true]));
        report = failureReport('comparison', profile, comparisonFailure(flags) ?? 'unproven', flags);
        if (profile === 'scalar') {
          diagnostic.capture('live-scalar-' + child.role, report, historicalParts.get(child.role), nativeParts);
          if (child.role === 'long') {
            prestdoutDiagnostic.capture('live-scalar-long', report, prestdoutSnapshot,
              historicalParts.get('long')?.cmd, nativeParts?.cmd);
            prestdoutSnapshot = undefined;
          }
          historicalParts.delete(child.role);
          nativeParts = undefined;
        }
        if (!Object.values(flags).every(value => value === true)) fail();
        return flags;
      };
      const missing = (sample, profile) => {
        if (sample.rows.has(short.receipt.pid)) fail();
        for (const expected of [sample.originals.short.current, sample.originals.short.historical]) {
          if (verify(short.receipt.pid, expected, 'win32', () => sample.rows.get(short.receipt.pid), () => true).status !== 'unsupported_proof') fail();
        }
        report = failureReport('comparison', profile);
        return { missing: true, unsupported_proof: true };
      };
      for (const child of children) {
        const sample = await observe('scalar', [child.receipt.pid], children, 'scalar_' + child.role + '_ms');
        compatibility.live.scalar[child.role] = present(sample, child, 'scalar');
      }
      const selected = [long.receipt.pid, short.receipt.pid];
      const shared = await observe('shared', selected, children, 'shared_live_ms');
      compatibility.live.shared.short = present(shared, short, 'shared');
      compatibility.live.shared.long = present(shared, long, 'shared');
      report = failureReport('cleanup', 'shared', 'cleanup');
      await frames(children);
      await releaseChildren([short]);
      if (!short.receipt.closed || short.receipt.code !== 0 || short.receipt.signal !== null || short.receipt.error) fail();
      const scalarMissing = await observe('scalar', [short.receipt.pid], [long], 'scalar_short_missing_ms');
      compatibility.post_close.scalar.short = missing(scalarMissing, 'scalar');
      const sharedMissing = await observe('shared', selected, [long], 'shared_post_close_ms');
      compatibility.post_close.shared.short = missing(sharedMissing, 'shared');
      compatibility.post_close.shared.long = present(sharedMissing, long, 'shared');
      await frames([long]);
      report = failureReport('cleanup', 'shared', 'cleanup');
      await releaseChildren(children);
      if (!receipts.every(r => r.spawned && (r.closed || r.terminated) && r.code === 0 && r.signal === null)) fail();
      const lifecycle = {};
      for (const child of children) {
        const r = child.receipt;
        durations[child.role + '_spawn_to_close_dispatch_ms'] = r.close_dispatch_ms - r.spawn_dispatch_ms;
        lifecycle[child.role] = Object.fromEntries(roleLifeKeys.map(key =>
          [key, key === 'closed_natural' ? r.closed && r.code === 0 && r.signal === null && !r.error : r[key] === true]));
      }
      Object.assign(lifecycle, { child_actual_closes: children.filter(c => c.receipt.closed).length,
        native_helper_actual_closes: nativeReceipts.filter(r => r.closed).length,
        historical_reference_actual_closes: historicalReceipts.filter(r => r.closed).length,
        current_reference_sync_native_terminations: currentReceipts.filter(r => r.terminated).length });
      await closePrestdout();
      if (privateFailed) { privateSurfaced = true; throw privateFault; }
      if (privateUncertain || (prestdoutOwner && !privateClosed)) fail();
      const result = twoChildSuccess(compatibility, durations, lifecycle, { reader: readerHash,
        harness: hash(await readFile(fileURLToPath(import.meta.url))),
        native: hash(await readFile(new URL('../../native/windows-mi/windows-mi.cpp', import.meta.url))) },
      hash(await readFile(helper)));
      // Missing data, send callbacks and natural-close receipts never replace these fresh probes.
      report = failureReport('cleanup', 'shared', 'cleanup-esrch-refused');
      if (!receipts.every(r => absent(r.pid))) fail();
      await rm(root, { recursive: true });
      completed = true;
      return result;
    }, async () => {
      historicalParts.clear();
      nativeParts = undefined;
      prestdoutSnapshot = undefined;
      await preservingCleanup(async () => {
        if (!completed) {
          await Promise.allSettled(children.map(child => child.ready));
          await releaseChildren(children);
        }
      }, async () => {
        await closePrestdout();
        if (privateFailed && !privateSurfaced) { privateSurfaced = true; throw privateFault; }
      });
    });
  } catch (error) {
    throw experimentFailure(error, report, diagnostic, prestdoutDiagnostic);
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
  process.send(argvAcknowledgement(process.argv.slice(4)));
} else if (isMain && process.argv[2] === '--build-failure') {
  const stage = process.argv[3];
  console.log(JSON.stringify(await readBuildFailure(stage, Number(process.argv[4]), process.argv[5])));
} else if (isMain) {
  try { console.log(JSON.stringify(await experiment(process.argv[2]))); }
  catch (error) { emitExperimentFailure(error, line => process.stdout.write(line), process); }
}
