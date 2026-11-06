// Owns: Bounded raw MI wire decoding, query inputs and unadmitted provenance fragments, subordinate to process acquisition.
// Excludes: Identity construction/digest/comparison, status/liveness/lifecycle/publication/admission,
// fallback, native invocation and asset loading. Decoded data never admits a representation profile.

type NativeStage = 'application' | 'session' | 'input' | 'retrieval' | 'operation' | 'representation' | 'cleanup';
type RawTimestamp = {
  readonly profile: 'mi-timestamp-v1';
  readonly year: number; readonly month: number; readonly day: number;
  readonly hour: number; readonly minute: number; readonly second: number;
  readonly microseconds: number; readonly utc: number;
};
type RawRow = { readonly pid: number; readonly date: RawTimestamp; readonly exe: string; readonly cmd: string };
type DecodeOutcome =
  | { readonly kind: 'decoded_unadmitted'; readonly rows: readonly RawRow[] }
  | { readonly kind: 'unusable'; readonly reason: 'invalid_query' | 'invalid_wire' | 'unsupported_optional_fields' }
  | { readonly kind: 'unusable'; readonly reason: 'native_stage'; readonly stage: NativeStage };

export function queryArguments(profile: unknown, pids: unknown): string[] | undefined {
  if ((profile !== 'scalar' && profile !== 'shared') || !Array.isArray(pids) ||
    pids.length < 1 || pids.length > 64 || (profile === 'scalar' && pids.length !== 1)) return undefined;
  const selected: number[] = [];
  for (const pid of pids) {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || selected.includes(pid)) return undefined;
    selected.push(pid);
  }
  const query = `SELECT ${profile === 'shared' ? 'ProcessId,' : ''}CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE ${selected.map(pid => `ProcessId = ${pid}`).join(' OR ')}`;
  if (query.length > 4096 || !/^[\x00-\x7f]+$/.test(query)) return undefined;
  return [profile, ...selected.map(String)];
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

type ProvenanceBinding = {
  readonly source_sha256: string;
  readonly executable_sha256: string;
  readonly executable_bytes: number;
  readonly originating_source_commit: string;
  readonly originating_build_job: string;
};

export function decodeProvenanceBinding(value: unknown):
  | { readonly kind: 'decoded_binding_unadmitted'; readonly binding: ProvenanceBinding }
  | { readonly kind: 'unusable'; readonly reason: 'invalid_binding' } {
  const invalid = { kind: 'unusable', reason: 'invalid_binding' } as const;
  if (!exactKeys(value, ['source_sha256', 'executable_sha256', 'executable_bytes', 'originating_source_commit', 'originating_build_job'])) return invalid;
  const { source_sha256, executable_sha256, executable_bytes, originating_source_commit, originating_build_job } = value;
  if (typeof source_sha256 !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(source_sha256) ||
    typeof executable_sha256 !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(executable_sha256) ||
    typeof originating_source_commit !== 'string' || !/^[0-9a-f]{40}$(?![\s\S])/.test(originating_source_commit) ||
    typeof originating_build_job !== 'string' || !/^[1-9][0-9]*$(?![\s\S])/.test(originating_build_job) ||
    typeof executable_bytes !== 'number' || !Number.isSafeInteger(executable_bytes) || executable_bytes <= 0) return invalid;
  // These data claims verify neither the asset, its origin nor a representation profile.
  return { kind: 'decoded_binding_unadmitted', binding: { source_sha256, executable_sha256, executable_bytes, originating_source_commit, originating_build_job } };
}

function timestamp(value: unknown): RawTimestamp | undefined {
  if (!exactKeys(value, ['profile', 'year', 'month', 'day', 'hour', 'minute', 'second', 'microseconds', 'utc']) || value.profile !== 'mi-timestamp-v1') return undefined;
  const { year, month, day, hour, minute, second, microseconds, utc } = value;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number' ||
    typeof hour !== 'number' || typeof minute !== 'number' || typeof second !== 'number' ||
    typeof microseconds !== 'number' || typeof utc !== 'number' ||
    ![year, month, day, hour, minute, second, microseconds, utc].every(Number.isInteger)) return undefined;
  if (year < 1601 || year > 9999 || month < 1 || month > 12 || day < 1 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 ||
    microseconds < 0 || microseconds > 999999 || utc < -720 || utc > 840) return undefined;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]!) return undefined;
  return { profile: 'mi-timestamp-v1', year, month, day, hour, minute, second, microseconds, utc };
}

export function decodeResponse(bytes: Uint8Array, profile: unknown, pids: unknown): DecodeOutcome {
  const args = queryArguments(profile, pids);
  if (!args) return { kind: 'unusable', reason: 'invalid_query' };
  const invalid: DecodeOutcome = { kind: 'unusable', reason: 'invalid_wire' };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024 ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) return invalid;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid; }
  if (exactKeys(value, ['schema', 'status']) && value.schema === 'native-mi-v1') {
    switch (value.status) {
      case 'application': case 'session': case 'input': case 'retrieval': case 'operation': case 'representation': case 'cleanup':
        return { kind: 'unusable', reason: 'native_stage', stage: value.status };
      default: return invalid;
    }
  }
  const selected = args.slice(1).map(Number);
  if (!exactKeys(value, ['schema', 'status', 'profile', 'complete', 'rows']) || value.schema !== 'native-mi-v1' ||
    value.status !== 'ok' || value.profile !== profile || value.complete !== true || !Array.isArray(value.rows) ||
    value.rows.length > selected.length) return invalid;
  const rows: RawRow[] = [];
  const seen = new Set<number>();
  let optionalNull = false;
  for (const row of value.rows) {
    if (!exactKeys(row, profile === 'shared' ? ['pid', 'date', 'exe', 'cmd'] : ['date', 'exe', 'cmd'])) return invalid;
    const pid = profile === 'shared' ? row.pid : selected[0];
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || !selected.includes(pid) || seen.has(pid)) return invalid;
    seen.add(pid);
    // Preserve the raw optional-field distinction; no normalization or profile admission occurs here.
    if (row.exe === null || row.cmd === null) optionalNull = true;
    if ((row.exe !== null && typeof row.exe !== 'string') || (row.cmd !== null && typeof row.cmd !== 'string')) return invalid;
    const date = timestamp(row.date);
    if (!date) return invalid;
    // Null rows are never returned, even if the other rows are well formed.
    if (typeof row.exe === 'string' && typeof row.cmd === 'string') rows.push({ pid, date, exe: row.exe, cmd: row.cmd });
  }
  if (optionalNull) return { kind: 'unusable', reason: 'unsupported_optional_fields' };
  return { kind: 'decoded_unadmitted', rows };
}
