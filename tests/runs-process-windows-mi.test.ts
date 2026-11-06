import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { queryArguments, decodeResponse, decodeProvenanceBinding } from "../lib/runs-process-windows-mi.ts";

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
