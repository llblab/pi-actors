// Owns: Bounded raw MI wire decoding, query inputs, unadmitted provenance fragments, and unrouted
// helper manifest/asset verification plus a shell-free invocation spec, subordinate to process acquisition.
// Excludes: Identity construction/digest/comparison, status/liveness/lifecycle/publication/admission, fallback,
// process spawning and package inventory. No production reader imports this owner; decoded data, verified
// asset bytes and the invocation spec never admit a representation profile, architecture or activation.
import { createHash } from 'node:crypto';
const MANIFEST_MAX_BYTES = 32 * 1024;
const EXECUTABLE_MAX_BYTES = 8 * 1024 * 1024;
const HELPER_VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/u;
const MODULE_FILE = /\/lib\/runs-process-windows-mi\.(?:ts|js)$/u;
export function queryArguments(profile, pids) {
    if ((profile !== 'scalar' && profile !== 'shared') || !Array.isArray(pids) ||
        pids.length < 1 || pids.length > 64 || (profile === 'scalar' && pids.length !== 1))
        return undefined;
    const selected = [];
    for (const pid of pids) {
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || selected.includes(pid))
            return undefined;
        selected.push(pid);
    }
    const query = `SELECT ${profile === 'shared' ? 'ProcessId,' : ''}CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE ${selected.map(pid => `ProcessId = ${pid}`).join(' OR ')}`;
    if (query.length > 4096 || !/^[\x00-\x7f]+$/.test(query))
        return undefined;
    return [profile, ...selected.map(String)];
}
function exactKeys(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function decodeProvenanceBinding(value) {
    const invalid = { kind: 'unusable', reason: 'invalid_binding' };
    if (!exactKeys(value, ['source_sha256', 'executable_sha256', 'executable_bytes', 'originating_source_commit', 'originating_build_job']))
        return invalid;
    const { source_sha256, executable_sha256, executable_bytes, originating_source_commit, originating_build_job } = value;
    if (typeof source_sha256 !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(source_sha256) ||
        typeof executable_sha256 !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(executable_sha256) ||
        typeof originating_source_commit !== 'string' || !/^[0-9a-f]{40}$(?![\s\S])/.test(originating_source_commit) ||
        typeof originating_build_job !== 'string' || !/^[1-9][0-9]*$(?![\s\S])/.test(originating_build_job) ||
        typeof executable_bytes !== 'number' || !Number.isSafeInteger(executable_bytes) || executable_bytes <= 0)
        return invalid;
    // These data claims verify neither the asset, its origin nor a representation profile.
    return { kind: 'decoded_binding_unadmitted', binding: { source_sha256, executable_sha256, executable_bytes, originating_source_commit, originating_build_job } };
}
function timestamp(value) {
    if (!exactKeys(value, ['profile', 'year', 'month', 'day', 'hour', 'minute', 'second', 'microseconds', 'utc']) || value.profile !== 'mi-timestamp-v1')
        return undefined;
    const { year, month, day, hour, minute, second, microseconds, utc } = value;
    if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number' ||
        typeof hour !== 'number' || typeof minute !== 'number' || typeof second !== 'number' ||
        typeof microseconds !== 'number' || typeof utc !== 'number' ||
        ![year, month, day, hour, minute, second, microseconds, utc].every(Number.isInteger))
        return undefined;
    if (year < 1601 || year > 9999 || month < 1 || month > 12 || day < 1 ||
        hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 ||
        microseconds < 0 || microseconds > 999999 || utc < -720 || utc > 840)
        return undefined;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > days[month - 1])
        return undefined;
    return { profile: 'mi-timestamp-v1', year, month, day, hour, minute, second, microseconds, utc };
}
export function decodeResponse(bytes, profile, pids) {
    const args = queryArguments(profile, pids);
    if (!args)
        return { kind: 'unusable', reason: 'invalid_query' };
    const invalid = { kind: 'unusable', reason: 'invalid_wire' };
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024 ||
        (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))
        return invalid;
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return invalid;
    }
    if (exactKeys(value, ['schema', 'status']) && value.schema === 'native-mi-v1') {
        switch (value.status) {
            case 'application':
            case 'session':
            case 'input':
            case 'retrieval':
            case 'operation':
            case 'representation':
            case 'cleanup':
                return { kind: 'unusable', reason: 'native_stage', stage: value.status };
            default: return invalid;
        }
    }
    const selected = args.slice(1).map(Number);
    if (!exactKeys(value, ['schema', 'status', 'profile', 'complete', 'rows']) || value.schema !== 'native-mi-v1' ||
        value.status !== 'ok' || value.profile !== profile || value.complete !== true || !Array.isArray(value.rows) ||
        value.rows.length > selected.length)
        return invalid;
    const rows = [];
    const seen = new Set();
    let optionalNull = false;
    for (const row of value.rows) {
        if (!exactKeys(row, profile === 'shared' ? ['pid', 'date', 'exe', 'cmd'] : ['date', 'exe', 'cmd']))
            return invalid;
        const pid = profile === 'shared' ? row.pid : selected[0];
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || !selected.includes(pid) || seen.has(pid))
            return invalid;
        seen.add(pid);
        // Preserve the raw optional-field distinction; no normalization or profile admission occurs here.
        if (row.exe === null || row.cmd === null)
            optionalNull = true;
        if ((row.exe !== null && typeof row.exe !== 'string') || (row.cmd !== null && typeof row.cmd !== 'string'))
            return invalid;
        const date = timestamp(row.date);
        if (!date)
            return invalid;
        // Null rows are never returned, even if the other rows are well formed.
        if (typeof row.exe === 'string' && typeof row.cmd === 'string')
            rows.push({ pid, date, exe: row.exe, cmd: row.cmd });
    }
    if (optionalNull)
        return { kind: 'unusable', reason: 'unsupported_optional_fields' };
    return { kind: 'decoded_unadmitted', rows };
}
function boundedText(bytes, maximumBytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes)
        return undefined;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return undefined;
    }
}
function boundedLexemes(value, maximum) {
    if (!Array.isArray(value) || value.length > maximum)
        return undefined;
    const selected = [];
    for (const item of value) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 128 || !/^[\x20-\x7e]+$/.test(item) || selected.includes(item))
            return undefined;
        selected.push(item);
    }
    return selected;
}
/** Bounded complete-manifest reader: one strict UTF-8 JSON document with an exact reviewed shape. */
export function readHelperManifest(bytes) {
    const invalid = { kind: 'unusable', reason: 'invalid_manifest' };
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MANIFEST_MAX_BYTES)
        return { kind: 'unusable', reason: 'oversize_manifest' };
    const text = boundedText(bytes, MANIFEST_MAX_BYTES);
    if (text === undefined)
        return invalid;
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return invalid;
    }
    if (!exactKeys(value, ['helper_version', 'architecture', 'protocol', 'profiles', 'native_source_sha256',
        'executable_bytes', 'executable_sha256', 'toolchain', 'dependencies', 'originating_source_commit', 'originating_build_job']))
        return invalid;
    const { helper_version, architecture, protocol, profiles, native_source_sha256, executable_bytes, executable_sha256, toolchain, dependencies, originating_source_commit, originating_build_job } = value;
    if (typeof helper_version !== 'string' || !HELPER_VERSION.test(helper_version) ||
        architecture !== 'windows-x64' || protocol !== 'native-mi-v1' ||
        !Array.isArray(profiles) || profiles.length !== 2 || profiles[0] !== 'scalar' || profiles[1] !== 'shared')
        return { kind: 'unusable', reason: 'unsupported_manifest' };
    if (typeof native_source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(native_source_sha256) ||
        typeof executable_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(executable_sha256) ||
        typeof originating_source_commit !== 'string' || !/^[0-9a-f]{40}$/.test(originating_source_commit) ||
        typeof originating_build_job !== 'string' || !/^[1-9][0-9]*$/.test(originating_build_job) ||
        typeof executable_bytes !== 'number' || !Number.isSafeInteger(executable_bytes) || executable_bytes <= 0)
        return invalid;
    if (executable_bytes > EXECUTABLE_MAX_BYTES)
        return { kind: 'unusable', reason: 'unsupported_manifest' };
    if (!exactKeys(toolchain, ['compiler', 'sdk', 'build_arguments']))
        return invalid;
    const compiler = boundedLexemes([toolchain.compiler], 1)?.[0];
    const sdk = boundedLexemes([toolchain.sdk], 1)?.[0];
    const buildArguments = boundedLexemes(toolchain.build_arguments, 32);
    const dependencyNames = boundedLexemes(dependencies, 32);
    if (compiler === undefined || sdk === undefined || buildArguments === undefined || dependencyNames === undefined)
        return invalid;
    // Fresh primitive claims only; the caller still owns target/version/source-digest policy.
    return {
        kind: 'manifest_unadmitted',
        manifest: {
            helper_version, architecture: 'windows-x64', protocol: 'native-mi-v1', profiles: ['scalar', 'shared'],
            native_source_sha256, executable_bytes, executable_sha256,
            toolchain: { compiler, sdk, build_arguments: buildArguments }, dependencies: dependencyNames,
            originating_source_commit, originating_build_job,
        },
    };
}
/**
 * Fixed versioned package-relative lookup. Never searches cwd, PATH or caller locations: the only base is
 * the sibling `native/` directory of this module's own `lib/` (source) or `dist/lib/` (compiled) home.
 */
export function resolveHelperAsset(moduleUrl, runtime, helperVersion) {
    let url;
    try {
        url = new URL(String(moduleUrl));
    }
    catch {
        return { kind: 'unusable', reason: 'unsupported_location' };
    }
    if (url.protocol !== 'file:' || !MODULE_FILE.test(url.pathname))
        return { kind: 'unusable', reason: 'unsupported_location' };
    const target = runtime;
    if (target?.platform !== 'win32' || target?.arch !== 'x64')
        return { kind: 'unusable', reason: 'unsupported_target' };
    if (typeof helperVersion !== 'string' || !HELPER_VERSION.test(helperVersion))
        return { kind: 'unusable', reason: 'unsupported_version' };
    const directory = `../native/windows-mi/win32-x64/${helperVersion}/`;
    return {
        kind: 'located', helper_version: helperVersion,
        manifest_url: new URL(`${directory}manifest.json`, url),
        executable_url: new URL(`${directory}helper.exe`, url),
    };
}
/** Trusted exact-byte selection: bounded manifest read, exact declared size, then exact SHA-256 match. */
export function loadHelperAsset(location, read) {
    const manifestBytes = read(location.manifest_url, MANIFEST_MAX_BYTES + 1);
    if (manifestBytes === undefined)
        return { kind: 'unusable', reason: 'missing_manifest' };
    if (manifestBytes.byteLength > MANIFEST_MAX_BYTES)
        return { kind: 'unusable', reason: 'oversize_manifest' };
    const reading = readHelperManifest(manifestBytes);
    if (reading.kind === 'unusable')
        return { kind: 'unusable', reason: reading.reason };
    const { manifest } = reading;
    if (manifest.helper_version !== location.helper_version)
        return { kind: 'unusable', reason: 'version_mismatch' };
    // One extra byte detects growth; a shorter read can never satisfy the declared size.
    const executableBytes = read(location.executable_url, manifest.executable_bytes + 1);
    if (executableBytes === undefined)
        return { kind: 'unusable', reason: 'missing_asset' };
    if (executableBytes.byteLength > manifest.executable_bytes)
        return { kind: 'unusable', reason: 'oversize_asset' };
    if (executableBytes.byteLength !== manifest.executable_bytes)
        return { kind: 'unusable', reason: 'size_mismatch' };
    const digest = createHash('sha256').update(executableBytes).digest('hex');
    if (digest !== manifest.executable_sha256)
        return { kind: 'unusable', reason: 'digest_mismatch' };
    return { kind: 'asset_verified_unadmitted', manifest, executable_sha256: digest, executable_bytes: executableBytes.byteLength };
}
/** Shell-free invocation spec only: no spawn, retry, fallback or execution-policy bypass. */
export function helperInvocation(executablePath, profile, pids) {
    if (typeof executablePath !== 'string' || executablePath.length === 0 || executablePath.length > 4096 ||
        !/^[A-Za-z]:[\\/][^\x00\r\n"]*\.exe$/.test(executablePath))
        return { kind: 'unusable', reason: 'unsupported_executable' };
    const query = queryArguments(profile, pids);
    if (!query)
        return { kind: 'unusable', reason: 'invalid_query' };
    return { kind: 'invocation_unadmitted', command: executablePath, args: query,
        options: { shell: false, windowsHide: true } };
}
