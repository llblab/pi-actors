import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  decodeProvenanceBinding, decodeResponse, helperInvocation, loadHelperAsset, queryArguments,
  readHelperManifest, resolveHelperAsset,
} from "../lib/runs-process-windows-mi.ts";

const date = { profile: 'mi-timestamp-v1', year: 2000, month: 2, day: 29, hour: 23, minute: 59, second: 59, microseconds: 999999, utc: 0 };
const row = { date, exe: ' C:\\a.exe ', cmd: ' "a" \\ 😀\ud800\udfff ' };
const envelope = (rows: unknown[] = [row], profile = 'scalar') => ({ schema: 'native-mi-v1', status: 'ok', profile, complete: true, rows });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = (value: unknown, profile: unknown = 'scalar', pids: unknown = [1]) => decodeResponse(bytes(value), profile, pids);
const unusable = (value: unknown, profile: unknown = 'scalar', pids: unknown = [1]) => assert.equal(decode(value, profile, pids).kind, 'unusable');

const bindingClaims = () => ({ source_sha256: '0'.repeat(64), executable_sha256: 'abcdef0123456789'.repeat(4), executable_bytes: 1, originating_source_commit: '0'.repeat(40), originating_build_job: '1' });

test('provenance binding boundaries preserve exact primitive claims in fresh unadmitted outputs', () => {
  for (const executable_bytes of [1, Number.MAX_SAFE_INTEGER]) {
    for (const originating_build_job of ['1', '1234567890123456789012345678901234567890']) {
      const input = { ...bindingClaims(), executable_bytes, originating_build_job };
      const expected = { ...input };
      const first = decodeProvenanceBinding(input);
      const second = decodeProvenanceBinding(input);
      assert.deepEqual(first, { kind: 'decoded_binding_unadmitted', binding: expected });
      assert.deepEqual(second, first);
      assert.notEqual(first, second);
      assert.equal(first.kind, 'decoded_binding_unadmitted');
      assert.equal(second.kind, 'decoded_binding_unadmitted');
      if (first.kind !== 'decoded_binding_unadmitted' || second.kind !== 'decoded_binding_unadmitted') return;
      assert.notEqual(first.binding, input);
      assert.notEqual(first.binding, second.binding);
      assert.deepEqual(Object.keys(first.binding).sort(), Object.keys(expected).sort());
      assert.ok(Object.values(first.binding).every(value => typeof value === 'string' || typeof value === 'number'));
      input.source_sha256 = 'f'.repeat(64);
      input.executable_sha256 = '0'.repeat(64);
      input.executable_bytes = 2;
      input.originating_source_commit = 'f'.repeat(40);
      input.originating_build_job = '2';
      assert.deepEqual(first.binding, expected);
    }
  }
});

test('provenance binding exact five fields and complete lexical claims reject every malformed partition', () => {
  const invalid = { kind: 'unusable', reason: 'invalid_binding' };
  const valid = bindingClaims();
  for (const value of [null, [], true, false, 1, 'binding', { ...valid, extra: 1 }]) assert.deepEqual(decodeProvenanceBinding(value), invalid);
  for (const key of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid }; delete missing[key];
    assert.deepEqual(decodeProvenanceBinding(missing), invalid);
    for (const value of [null, [], {}, true]) assert.deepEqual(decodeProvenanceBinding({ ...valid, [key]: value }), invalid);
  }
  for (const [key, length] of [['source_sha256', 64], ['executable_sha256', 64], ['originating_source_commit', 40]] as const) {
    for (const value of [1, '', 'a'.repeat(length - 1), 'a'.repeat(length + 1), 'A'.repeat(length), 'g'.repeat(length), 'ａ'.repeat(length)]) {
      assert.deepEqual(decodeProvenanceBinding({ ...valid, [key]: value }), invalid);
    }
  }
  for (const value of [1, '', '0', '00', '01', '+1', '-1', '1.0', '1e2', ' 1', '1 ', '１', '١']) {
    assert.deepEqual(decodeProvenanceBinding({ ...valid, originating_build_job: value }), invalid);
  }
  for (const key of ['source_sha256', 'executable_sha256', 'originating_source_commit', 'originating_build_job'] as const) {
    for (const terminator of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
      for (const value of [terminator + valid[key], valid[key] + terminator]) {
        assert.deepEqual(decodeProvenanceBinding({ ...valid, [key]: value }), invalid);
      }
    }
  }
});

test('provenance executable size representability refuses coercion and outcomes remain closed and unadmitted', () => {
  for (const executable_bytes of [0, -0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true, false, null, {}, []]) {
    assert.deepEqual(decodeProvenanceBinding({ ...bindingClaims(), executable_bytes }), { kind: 'unusable', reason: 'invalid_binding' });
  }
  for (let i = 0; i < 3; i++) {
    const result = decodeProvenanceBinding(bindingClaims());
    assert.deepEqual(result, { kind: 'decoded_binding_unadmitted', binding: bindingClaims() });
    assert.deepEqual(Object.keys(result).sort(), ['binding', 'kind']);
    assert.doesNotMatch(JSON.stringify(result), /approved|verified|identity|exec["_:]|path|profile|accepted/);
  }
});

test('query grammar preserves safe PID boundaries and rejects invalid selections without effects', () => {
  for (const pid of [1, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER]) assert.deepEqual(queryArguments('scalar', [pid]), ['scalar', String(pid)]);
  const pids = Array.from({ length: 64 }, (_, i) => Number.MAX_SAFE_INTEGER - i);
  assert.deepEqual(queryArguments('shared', pids), ['shared', ...pids.map(String)]);
  for (const input of [[], [...pids, 1], [1, 1], [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ['1'], new Array(1), null, {}, '1']) assert.equal(queryArguments('shared', input), undefined);
  assert.equal(queryArguments('scalar', [1, 2]), undefined);
  assert.equal(queryArguments('foreign', [1]), undefined);
  assert.equal(decodeResponse(bytes(envelope()), 'foreign', [1]).kind, 'unusable');
});

test('exact envelopes and scalar/shared correlation produce only fresh unadmitted raw data', () => {
  const result = decode(envelope());
  assert.deepEqual(result, { kind: 'decoded_unadmitted', rows: [{ pid: 1, ...row }] });
  assert.deepEqual(decode(envelope([])), { kind: 'decoded_unadmitted', rows: [] });
  assert.notEqual(decode(envelope()).kind === 'decoded_unadmitted' && (decode(envelope()) as typeof result), result);
  const shared = envelope([{ pid: Number.MAX_SAFE_INTEGER, ...row }, { pid: 1, ...row }], 'shared');
  assert.deepEqual(decode(shared, 'shared', [1, Number.MAX_SAFE_INTEGER]), { kind: 'decoded_unadmitted', rows: shared.rows });
  assert.deepEqual(decode(envelope([{ pid: 1, ...row }], 'shared'), 'shared', [1, 2]), { kind: 'decoded_unadmitted', rows: [{ pid: 1, ...row }] });
  for (const rows of [[row, row], [{ ...row, pid: 1 }], [{ date, exe: '', cmd: '', extra: true }]]) unusable(envelope(rows));
  for (const rows of [[{ pid: 1, ...row }, { pid: 1, ...row }], [{ pid: 3, ...row }], [{ pid: '1', ...row }], [row], [{ pid: 1, ...row }, { pid: 2, ...row, date: null }]]) unusable(envelope(rows, 'shared'), 'shared', [1, 2]);
  for (const key of Object.keys(envelope())) { const value: Record<string, unknown> = { ...envelope() }; delete value[key]; unusable(value); }
  for (const change of [{ extra: 1 }, { complete: false }, { complete: 1 }, { profile: 'shared' }, { schema: 'other' }, { rows: null }, { status: 'unknown' }]) unusable({ ...envelope(), ...change });
});

test('optional NULL refuses whole query before normalization; strings retain every UTF-16 unit', () => {
  for (const fields of [{ exe: null, cmd: '' }, { exe: '', cmd: null }, { exe: null, cmd: null }]) {
    assert.deepEqual(decode(envelope([{ ...row, ...fields }])), { kind: 'unusable', reason: 'unsupported_optional_fields' });
    assert.deepEqual(decode(envelope([{ pid: 1, ...row }, { pid: 2, ...row, ...fields }], 'shared'), 'shared', [1, 2]), { kind: 'unusable', reason: 'unsupported_optional_fields' });
  }
  for (const key of ['exe', 'cmd']) {
    for (const value of [false, 1, {}, []]) unusable(envelope([{ ...row, [key]: value }]));
    const missing: Record<string, unknown> = { ...row }; delete missing[key]; unusable(envelope([missing]));
  }
  for (const text of ['', ' \r\n\t ', '\\"😀\ud800x\udfff', '.exe\u0000.cmd']) assert.deepEqual(decode(envelope([{ ...row, exe: text, cmd: text }])), { kind: 'decoded_unadmitted', rows: [{ pid: 1, date, exe: text, cmd: text }] });
});

test('raw timestamps validate real calendar and precision without UTC admission or conversion', () => {
  for (const change of [{ year: 1601, month: 1, day: 1, microseconds: 0, utc: -720 }, { year: 9999, month: 12, day: 31, utc: 840 }, { year: 2024, utc: 60 }, { utc: 0 }]) {
    const raw = { ...date, ...change };
    assert.deepEqual(decode(envelope([{ ...row, date: raw }])), { kind: 'decoded_unadmitted', rows: [{ pid: 1, ...row, date: raw }] });
  }
  for (const change of [{ year: 1600 }, { year: 10000 }, { year: 1900 }, { month: 0 }, { month: 13 }, { month: 4, day: 31 }, { day: 0 }, { hour: 24 }, { minute: 60 }, { second: 60 }, { microseconds: -1 }, { microseconds: 1000000 }, { utc: -721 }, { utc: 841 }, { profile: 'UTC' }, { extra: 1 }]) unusable(envelope([{ ...row, date: { ...date, ...change } }]));
  for (const key of Object.keys(date)) {
    const missing: Record<string, unknown> = { ...date }; delete missing[key]; unusable(envelope([{ ...row, date: missing }]));
    if (key !== 'profile') for (const value of ['0', null, 0.5, true]) unusable(envelope([{ ...row, date: { ...date, [key]: value } }]));
  }
});

test('complete byte bound, strict UTF8, BOM and whole JSON parsing fail closed', () => {
  const base = bytes(envelope([{ ...row, cmd: '' }]));
  const exact = bytes(envelope([{ ...row, cmd: ' '.repeat(1024 * 1024 - base.length) }]));
  assert.equal(exact.length, 1024 * 1024);
  assert.equal(decodeResponse(exact, 'scalar', [1]).kind, 'decoded_unadmitted');
  for (const input of [Buffer.concat([exact, Buffer.from(' ')]), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), base]), Buffer.concat([base, Buffer.from('{}')]), base.subarray(0, base.length - 1), Buffer.from(''), Buffer.from('{"schema":')]) assert.equal(decodeResponse(input, 'scalar', [1]).kind, 'unusable');
  assert.equal(decodeResponse(new Uint8Array(base), 'scalar', [1]).kind, 'decoded_unadmitted');
  const reusable = bytes(envelope()); const result = decodeResponse(reusable, 'scalar', [1]); reusable.fill(0);
  assert.deepEqual(result, { kind: 'decoded_unadmitted', rows: [{ pid: 1, ...row }] });
});

test('native failures expose only closed stages; module has no higher-domain imports or admission', () => {
  for (const stage of ['application', 'session', 'input', 'retrieval', 'operation', 'representation', 'cleanup']) {
    assert.deepEqual(decode({ schema: 'native-mi-v1', status: stage }), { kind: 'unusable', reason: 'native_stage', stage });
    unusable({ schema: 'native-mi-v1', status: stage, error: 'private' });
  }
  unusable({ schema: 'native-mi-v1', status: 'other' });
  const source = readFileSync(new URL("../lib/runs-process-windows-mi.ts", import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]\./);
  assert.doesNotMatch(JSON.stringify(decode(envelope())), /start_time|identity|accepted|dead_pid|\/Date\(/);
});

const manifestClaims = () => ({
  helper_version: '1.2.3', architecture: 'windows-x64', protocol: 'native-mi-v1', profiles: ['scalar', 'shared'],
  native_source_sha256: '0'.repeat(64), executable_bytes: 4, executable_sha256: 'a'.repeat(64),
  toolchain: { compiler: 'MSVC 19.44', sdk: 'Windows SDK 10.0.26100', build_arguments: ['/O2', '/utf-8'] },
  dependencies: ['kernel32.dll'],
  originating_source_commit: '0'.repeat(40), originating_build_job: '12345',
});
const manifestBytes = (value: unknown = manifestClaims()) => Buffer.from(JSON.stringify(value));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('helper manifest reader is bounded, exact-shape and fresh-claim only', () => {
  const claims = manifestClaims();
  const input = manifestBytes(claims);
  const first = readHelperManifest(input);
  const second = readHelperManifest(input);
  assert.equal(first.kind, 'manifest_unadmitted');
  assert.equal(second.kind, 'manifest_unadmitted');
  if (first.kind !== 'manifest_unadmitted' || second.kind !== 'manifest_unadmitted') return;
  assert.deepEqual(first.manifest, { ...claims, architecture: 'windows-x64', protocol: 'native-mi-v1', profiles: ['scalar', 'shared'] });
  assert.notEqual(first.manifest, second.manifest);
  assert.notEqual(first.manifest, claims);
  claims.helper_version = '9.9.9';
  claims.dependencies.push('user32.dll');
  assert.equal(first.manifest.helper_version, '1.2.3');
  assert.deepEqual(first.manifest.dependencies, ['kernel32.dll']);

  // Complete-document bounds: over 32KiB is refused before any parse.
  const padded = Buffer.concat([input, Buffer.from(' '.repeat(32 * 1024 - input.length + 1))]);
  assert.deepEqual(readHelperManifest(padded), { kind: 'unusable', reason: 'oversize_manifest' });
  const exact = Buffer.concat([input, Buffer.from(' '.repeat(32 * 1024 - input.length))]);
  assert.equal(readHelperManifest(exact).kind, 'manifest_unadmitted');
  assert.deepEqual(readHelperManifest(Buffer.alloc(0)), { kind: 'unusable', reason: 'invalid_manifest' });

  const invalid = (value: unknown) => assert.deepEqual(readHelperManifest(manifestBytes(value)), { kind: 'unusable', reason: 'invalid_manifest' });
  for (const extra of [
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xff]), Buffer.from(JSON.stringify(manifestClaims()), 'utf8'),
  ]) if (extra[0] !== 0x7b) assert.deepEqual(readHelperManifest(Buffer.concat([extra, input])), { kind: 'unusable', reason: 'invalid_manifest' });
  invalid({ ...manifestClaims(), extra: true });
  invalid({ ...manifestClaims(), dependencies: undefined });
  invalid({ ...manifestClaims(), native_source_sha256: 'A'.repeat(64) });
  invalid({ ...manifestClaims(), native_source_sha256: '0'.repeat(63) });
  invalid({ ...manifestClaims(), executable_sha256: 'a'.repeat(63) });
  invalid({ ...manifestClaims(), originating_source_commit: '0'.repeat(39) });
  invalid({ ...manifestClaims(), originating_build_job: '0' });
  invalid({ ...manifestClaims(), executable_bytes: 0 });
  invalid({ ...manifestClaims(), executable_bytes: 1.5 });
  invalid({ ...manifestClaims(), toolchain: { compiler: 'c', sdk: 's' } });
  invalid({ ...manifestClaims(), toolchain: { compiler: '', sdk: 's', build_arguments: [] } });
  invalid({ ...manifestClaims(), dependencies: ['kernel32.dll', 'kernel32.dll'] });
  invalid({ ...manifestClaims(), dependencies: ['k'.repeat(129)] });
  invalid({ ...manifestClaims(), dependencies: ['bad\u0001name'] });
  const unsupported = (value: unknown) => assert.deepEqual(readHelperManifest(manifestBytes(value)), { kind: 'unusable', reason: 'unsupported_manifest' });
  unsupported({ ...manifestClaims(), helper_version: '1.2' });
  unsupported({ ...manifestClaims(), helper_version: '01.2.3' });
  unsupported({ ...manifestClaims(), architecture: 'windows-arm64' });
  unsupported({ ...manifestClaims(), protocol: 'native-mi-v2' });
  unsupported({ ...manifestClaims(), profiles: ['shared', 'scalar'] });
  unsupported({ ...manifestClaims(), profiles: [] });
  unsupported({ ...manifestClaims(), executable_bytes: 8 * 1024 * 1024 + 1 });
});

test('helper asset lookup is fixed, versioned and package-relative to this module only', () => {
  const source = resolveHelperAsset(new URL('../lib/runs-process-windows-mi.ts', import.meta.url).href, { platform: 'win32', arch: 'x64' }, '1.2.3');
  assert.equal(source.kind, 'located');
  if (source.kind !== 'located') return;
  assert.ok(source.manifest_url.href.endsWith('/native/windows-mi/win32-x64/1.2.3/manifest.json'));
  assert.ok(source.executable_url.href.endsWith('/native/windows-mi/win32-x64/1.2.3/helper.exe'));
  assert.equal(source.manifest_url.href.includes('/lib/'), false);
  const compiled = resolveHelperAsset('file:///pkg/dist/lib/runs-process-windows-mi.js', { platform: 'win32', arch: 'x64' }, '1.2.3');
  assert.equal(compiled.kind, 'located');
  if (compiled.kind === 'located') {
    assert.equal(compiled.manifest_url.href, 'file:///pkg/dist/native/windows-mi/win32-x64/1.2.3/manifest.json');
    assert.equal(compiled.executable_url.href, 'file:///pkg/dist/native/windows-mi/win32-x64/1.2.3/helper.exe');
  }
  const unusable = (moduleUrl: unknown, runtime: unknown, version: unknown, reason: string) =>
    assert.deepEqual(resolveHelperAsset(moduleUrl, runtime, version), { kind: 'unusable', reason });
  const sourceUrl = new URL('../lib/runs-process-windows-mi.ts', import.meta.url).href;
  unusable(sourceUrl, { platform: 'linux', arch: 'x64' }, '1.2.3', 'unsupported_target');
  unusable(sourceUrl, { platform: 'win32', arch: 'arm64' }, '1.2.3', 'unsupported_target');
  unusable(sourceUrl, { platform: 'win32' }, '1.2.3', 'unsupported_target');
  unusable(sourceUrl, { platform: 'win32', arch: 'x64' }, '1.2', 'unsupported_version');
  unusable(sourceUrl, { platform: 'win32', arch: 'x64' }, '../../etc', 'unsupported_version');
  unusable('file:///pkg/lib/other-owner.ts', { platform: 'win32', arch: 'x64' }, '1.2.3', 'unsupported_location');
  const rootModule = resolveHelperAsset('file:///pkg/lib/runs-process-windows-mi.ts', { platform: 'win32', arch: 'x64' }, '1.2.3');
  assert.equal(rootModule.kind, 'located');
  if (rootModule.kind === 'located') assert.equal(rootModule.manifest_url.href, 'file:///pkg/native/windows-mi/win32-x64/1.2.3/manifest.json');
  unusable('https://example.test/lib/runs-process-windows-mi.ts', { platform: 'win32', arch: 'x64' }, '1.2.3', 'unsupported_location');
  unusable('not a url', { platform: 'win32', arch: 'x64' }, '1.2.3', 'unsupported_location');
});

test('helper asset loading verifies exact declared bytes and never partial data', () => {
  const location = resolveHelperAsset(new URL('../lib/runs-process-windows-mi.ts', import.meta.url).href, { platform: 'win32', arch: 'x64' }, '1.2.3');
  assert.equal(location.kind, 'located');
  if (location.kind !== 'located') return;
  const executable = Buffer.from('MZ-helper-bytes');
  const claims = { ...manifestClaims(), executable_bytes: executable.byteLength, executable_sha256: sha256(executable) };
  const manifest = manifestBytes(claims);
  const reader = (files: Record<string, Uint8Array | undefined>) => (url: URL, maximumBytes: number) => {
    const value = files[url.href];
    return value === undefined ? undefined : value.subarray(0, Math.min(value.byteLength, maximumBytes));
  };
  const verified = loadHelperAsset(location, reader({ [location.manifest_url.href]: manifest, [location.executable_url.href]: executable }));
  assert.deepEqual(verified, { kind: 'asset_verified_unadmitted', manifest: loadManifestClaim(manifest), executable_sha256: claims.executable_sha256, executable_bytes: executable.byteLength });
  assert.deepEqual(loadHelperAsset(location, reader({})), { kind: 'unusable', reason: 'missing_manifest' });
  // A limit-respecting reader must not admit a valid prefix of an over-limit document.
  const prefix = Buffer.from(JSON.stringify(claims).padEnd(32 * 1024, ' ') + 'not JSON');
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: prefix, [location.executable_url.href]: executable })),
    { kind: 'unusable', reason: 'oversize_manifest' });
  const exact = Buffer.from(JSON.stringify(claims).padEnd(32 * 1024, ' '));
  assert.equal(loadHelperAsset(location, reader({ [location.manifest_url.href]: exact, [location.executable_url.href]: executable })).kind, 'asset_verified_unadmitted');
  // A reader that over-delivers is still refused by the bounded manifest read.
  assert.deepEqual(loadHelperAsset(location, () => Buffer.alloc(32 * 1024 + 1)), { kind: 'unusable', reason: 'oversize_manifest' });
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: Buffer.from('null') })), { kind: 'unusable', reason: 'invalid_manifest' });
  const wrongVersion = { ...claims, helper_version: '1.2.4' };
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: manifestBytes(wrongVersion), [location.executable_url.href]: executable })), { kind: 'unusable', reason: 'version_mismatch' });
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: manifest })), { kind: 'unusable', reason: 'missing_asset' });
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: manifest, [location.executable_url.href]: Buffer.concat([executable, Buffer.from('!')]) })), { kind: 'unusable', reason: 'oversize_asset' });
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: manifest, [location.executable_url.href]: executable.subarray(0, executable.byteLength - 1) })), { kind: 'unusable', reason: 'size_mismatch' });
  const tampered = Buffer.from(executable);
  tampered[0] = 0x4e;
  assert.deepEqual(loadHelperAsset(location, reader({ [location.manifest_url.href]: manifest, [location.executable_url.href]: tampered })), { kind: 'unusable', reason: 'digest_mismatch' });
  // A reader may return more than requested; the exact declared size still decides.
  const overDelivering = (url: URL) => url.href === location.manifest_url.href ? manifest : executable;
  assert.deepEqual(loadHelperAsset(location, overDelivering), { kind: 'asset_verified_unadmitted', manifest: loadManifestClaim(manifest), executable_sha256: claims.executable_sha256, executable_bytes: executable.byteLength });
});

function loadManifestClaim(bytes: Uint8Array) {
  const reading = readHelperManifest(bytes);
  assert.equal(reading.kind, 'manifest_unadmitted');
  if (reading.kind !== 'manifest_unadmitted') throw new Error('unexpected manifest reading');
  return reading.manifest;
}

test('helper invocation is a shell-free spec with the fixed query arguments only', () => {
  const executable = 'C:\\Program Files\\pi-actors\\helper.exe';
  assert.deepEqual(helperInvocation(executable, 'scalar', [7]), {
    kind: 'invocation_unadmitted', command: executable,
    args: ['scalar', '7'], options: { shell: false, windowsHide: true },
  });
  const shared = helperInvocation('C:/helper.exe', 'shared', [1, 64]);
  assert.equal(shared.kind, 'invocation_unadmitted');
  if (shared.kind === 'invocation_unadmitted') assert.deepEqual(shared.args, ['shared', '1', '64']);
  for (const bad of [undefined, '', 'helper.exe', 'relative\\helper.exe', 'C:\\helper\\', 'C:\\he"lper.exe',
    'C:\\helper.exe\r\nstart calc', 'C:\\helper.exe\u0000', 'x'.repeat(4097)]) {
    assert.deepEqual(helperInvocation(bad, 'scalar', [1]), { kind: 'unusable', reason: 'unsupported_executable' });
  }
  for (const [profile, pids] of [['other', [1]], ['scalar', []], ['scalar', [1, 2]], ['shared', [0]], ['shared', [1, 1]], ['shared', [1.5]]] as const) {
    assert.deepEqual(helperInvocation(executable, profile, pids), { kind: 'unusable', reason: 'invalid_query' });
  }
});
