// Temporary fixture-only witness. No native query or lifecycle authority.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const FILES = 512, BYTES = 2048, WRITES = 8192;
const enabled = () => process.env.PI_ACTORS_WINDOWS_BOUNDARY_TIMING === "1";
let phaseSink, settlementObserver;
// Exact callsite hints only; alignment tests falsify drift. Never authenticated lifecycle proof.
export const callerSites = [
  ["sharedinventory", "readWindowsProcessIdentities", "runs-process", 144, 106, "const result = spawnSync("],
  ["directscalarstatus", "", "runs-status", 66, 34, "return deriveRunStatus("],
  ["directscalarstatus", "", "runs-status", 196, 185, "const identity = identities === undefined"],
  ["runnerbirth", "captureSpawnedRunProcessIdentity", "runs-process", 226, 174, "return captureFreshProcessIdentity("],
  ["managedchildbirth", "captureSpawnedNativeProcessIdentity", "runs-process", 239, 181, "return captureFreshProcessIdentity("],
  ["produceradmission", "admitRunResultProducer", "runs-results", 199, 146, "requireNoNativeProducerContradiction(meta)"],
  ["publicationentry", "publishRunResult", "runs-results", 512, 410, "requireNoNativeProducerContradiction(meta)"],
  ["postprepare", "publishRunResult", "runs-results", 532, 434, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
  ["postprimary", "publishRunResult", "runs-results", 538, 440, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
  ["postartifact", "publishRunResult", "runs-results", 545, 447, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
  ["diagnosticsbefore", "withRunResultDiagnosticsAdmission", "runs-results", 468, 371, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
  ["diagnosticsafter", "withRunResultDiagnosticsAdmission", "runs-results", 470, 373, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
  ["postdiagnostic", "publishRunResult", "runs-results", 556, 458, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
  ["finalprecommit", "publishRunResult", "runs-results", 560, 466, "requireNoNativeProducerContradiction(readCapturedProducerMeta("],
];
const callers = new Set(["unknown", ...callerSites.map(row => row[0])]);
export function classifyNativeCaller(stack, kind) {
  if (typeof stack !== "string" || stack.length > 32768) return "unknown";
  const frames = stack.split("\n").slice(1, 16);
  const has = (name, file, source, packed) => frames.some(frame => {
    const match = /^\s+at (.*?)\(?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*[\\/]lib[\\/]([^\\/]+)\.(ts|js)):(\d+):\d+\)?$/.exec(frame);
    return match && match[3] === file && Number(match[5]) === (match[4] === "ts" ? source : packed) &&
      (!name || match[1].trim() === name);
  });
  if (kind === "shared") return has("readWindowsProcessIdentities", "runs-process", 144, 106) ? "sharedinventory" : "unknown";
  if (kind !== "scalar" || !has("readWindowsIdentity", "runs-process", 108, 71)) return "unknown";
  return callerSites.slice(1).find(([, name, file, source, packed]) => has(name, file, source, packed))?.[0] ?? "unknown";
}
export function beginSettlementTiming() { try { return settlementObserver?.beginSettlement(); } catch {} }
export function endSettlementTiming(ticket) { try { return settlementObserver?.endSettlement(ticket); } catch {} }
export function readSettlementTiming(ticket) {
  if (!ticket) return undefined;
  try { return settlementObserver?.readSettlement(ticket); } catch {}
}
export function markTiming(phase) {
  if (["prompt", "model_request", "spawn_return", "gate", "settle", "registration_launch", "result_wait"].includes(phase)) phaseSink?.(phase);
}
export function observeNative(original, emit, { origin = performance.now(), now = () => performance.now(),
  classify = kind => classifyNativeCaller(new Error().stack, kind) } = {}) {
  let sequence = 0, observerFailure, active, lastWindow, lastTicket, previous = 0;
  const local = () => {
    const value = now() - origin;
    if (!Number.isFinite(value) || value < previous) {
      if (active) active.data = { state: "unavailable" };
      throw new Error("Unavailable local observer clock");
    }
    previous = value;
    return value;
  };
  const inspect = build => {
    if (observerFailure) return;
    try { return build(); } catch (error) { observerFailure = { error }; }
  };
  const report = build => inspect(() => emit(build()));
  const wrapped = function (...args) {
    const query = inspect(() => {
      if (args[0] !== "powershell.exe" || !Array.isArray(args[1]) || args[1].length !== 4 ||
        args[1][0] !== "-NoProfile" || args[1][1] !== "-NonInteractive" || args[1][2] !== "-Command" ||
        typeof args[1][3] !== "string") return null;
      const command = args[1][3];
      const scalar = command.match(/^\$p = Get-CimInstance Win32_Process(?: -Property CreationDate,ExecutablePath,CommandLine)? -Filter "ProcessId = ([1-9][0-9]*)"; if \(\$null -eq \$p\) \{ exit 3 \}; \$p \| Select-Object CreationDate,ExecutablePath,CommandLine \| ConvertTo-Json -Compress(?![\s\S])/);
      if (scalar) return { pid: Number(scalar[1]), kind: "scalar" };
      const shared = command.length <= 4096 && command.match(/^\$ErrorActionPreference = "Stop"; \$p = Get-CimInstance Win32_Process(?: -Property ProcessId,CreationDate,ExecutablePath,CommandLine)? -Filter "ProcessId = ([1-9][0-9]*)(?: OR ProcessId = [1-9][0-9]*){0,63}"; ConvertTo-Json -InputObject @\(\$p \| Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine\) -Compress(?![\s\S])/);
      if (!shared) return null;
      const pids = [...command.matchAll(/ProcessId = ([1-9][0-9]*)/g)].map(match => Number(match[1]));
      return pids.every(Number.isSafeInteger) && new Set(pids).size === pids.length ? { pid: pids[0], kind: "shared" } : null;
    });
    if (!query || !Number.isSafeInteger(query.pid)) return Reflect.apply(original, this, args);
    let caller = "unknown";
    try { const hint = classify(query.kind); if (callers.has(hint)) caller = hint; } catch {}
    const seq = ++sequence, before = inspect(local);
    const window = active;
    let site;
    if (window?.data.state === "observed") {
      if (sequence > WRITES / 2) window.data = { state: "unavailable" };
      else {
        window.data.calls++;
        site = window.data.sites.find(row => row.caller === caller && row.query_kind === query.kind);
        if (!site) window.data.sites.push(site = { caller, query_kind: query.kind, calls: 0, total_ms: 0, max_ms: 0 });
        site.calls++;
      }
    }
    report(() => ({ site: "windows_identity", caller, query_kind: query.kind, sequence: seq, target_pid: query.pid, phase: "before", elapsed_ms: 0,
      before_call_ms: before, native_start_ms: null, completed_ms: null }));
    const start = inspect(() => local() + origin);
    let value;
    try { value = Reflect.apply(original, this, args); }
    catch (error) {
      const end = inspect(() => local() + origin);
      recordDuration(window, site, end - start);
      report(() => ({ site: "windows_identity", caller, query_kind: query.kind, sequence: seq, target_pid: query.pid, phase: "throw", elapsed_ms: end - start,
        before_call_ms: before, native_start_ms: start - origin, completed_ms: end - origin }));
      throw error;
    }
    const end = inspect(() => local() + origin);
    recordDuration(window, site, end - start);
    report(() => {
      const status = value !== null && (typeof value === "object" || typeof value === "function")
        ? Object.getOwnPropertyDescriptor(value, "status") : undefined;
      return { site: "windows_identity", caller, query_kind: query.kind, sequence: seq, target_pid: query.pid, phase: "after", elapsed_ms: end - start,
        before_call_ms: before, native_start_ms: start - origin, completed_ms: end - origin,
        exit_code: status && "value" in status && Number.isInteger(status.value) ? status.value : null };
    });
    return value;
  };
  function recordDuration(window, site, duration) {
    if (window?.data.state !== "observed") return;
    if (!Number.isFinite(duration) || duration < 0) { window.data = { state: "unavailable" }; return; }
    window.data.total_ms += duration; window.data.max_ms = Math.max(window.data.max_ms, duration);
    site.total_ms += duration; site.max_ms = Math.max(site.max_ms, duration);
  }
  wrapped.beginSettlement = () => {
    if (active) return undefined;
    const ticket = {};
    try { active = { ticket, data: { state: "observed", start_ms: local(), end_ms: null,
      start_sequence: sequence, end_sequence: null, calls: 0, total_ms: 0, max_ms: 0, sites: [] } }; }
    catch { active = { ticket, data: { state: "unavailable" } }; }
    return ticket;
  };
  wrapped.endSettlement = ticket => {
    if (!active || active.ticket !== ticket) return;
    try {
      const end = local();
      if (active.data.state === "observed" && end >= active.data.start_ms) {
        active.data.end_ms = end; active.data.end_sequence = sequence;
      } else active.data = { state: "unavailable" };
    } catch { active.data = { state: "unavailable" }; }
    lastWindow = active.data; lastTicket = active.ticket; active = undefined;
  };
  wrapped.readSettlement = ticket => copySettlement(ticket !== undefined && ticket !== (active?.ticket ?? lastTicket)
    ? undefined : active?.data ?? lastWindow);
  wrapped.readObserverFailure = () => observerFailure;
  return wrapped;
}
function copySettlement(window) {
  const unavailable = { state: "unavailable" };
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= WRITES / 2;
  const finite = value => Number.isFinite(value) && value >= 0;
  const durations = row => finite(row.total_ms) && finite(row.max_ms) && row.max_ms <= row.total_ms &&
    row.total_ms <= row.calls * row.max_ms &&
    (row.calls !== 0 || (row.total_ms === 0 && row.max_ms === 0));
  if (window?.state !== "observed" || !count(window.start_sequence) || !count(window.calls) ||
    !finite(window.start_ms) || window.start_sequence + window.calls > WRITES / 2 || !durations(window) ||
    ((window.end_ms === null) !== (window.end_sequence === null))) return unavailable;
  if (window.end_ms !== null && (!finite(window.end_ms) || !count(window.end_sequence) ||
    window.end_sequence - window.start_sequence !== window.calls ||
    window.end_ms - window.start_ms < window.total_ms)) return unavailable;
  const result = Object.fromEntries(["state", "start_ms", "end_ms", "start_sequence", "end_sequence", "calls", "total_ms", "max_ms"].map(key => [key, window[key]]));
  if (window.sites !== undefined) {
    if (!Array.isArray(window.sites) || window.sites.length > callers.size * 2) return unavailable;
    const seen = new Set(); let calls = 0, total = 0, maximum = 0;
    result.sites = [];
    for (const row of window.sites) {
      if (!row || !callers.has(row.caller) || !["scalar", "shared"].includes(row.query_kind) ||
        !count(row.calls) || row.calls === 0 || !durations(row)) return unavailable;
      const key = row.caller + ":" + row.query_kind;
      if (seen.has(key)) return unavailable;
      seen.add(key); calls += row.calls; total += row.total_ms; maximum = Math.max(maximum, row.max_ms);
      result.sites.push(Object.fromEntries(["caller", "query_kind", "calls", "total_ms", "max_ms"].map(key => [key, row[key]])));
    }
    if (calls !== window.calls || !finite(total) || Math.abs(total - window.total_ms) > Number.EPSILON * Math.max(1, total) * WRITES || maximum !== window.max_ms) return unavailable;
  }
  return Buffer.byteLength(JSON.stringify(result)) <= BYTES ? result : unavailable;
}
// Optional fields are independently withheld; legacy snapshots remain usable.
export function projectTimingAttribution(native, window) {
  const last_native = native && callers.has(native.caller) && ["scalar", "shared"].includes(native.query_kind)
    ? { caller: native.caller, query_kind: native.query_kind } : undefined;
  const settlement = copySettlement(window);
  return { last_native: last_native ?? { caller: "unknown", query_kind: "unknown" }, settlement };
}
function install(directory, stream) {
  const original = childProcess.spawnSync;
  const instance = randomUUID();
  const enrolledAt = performance.now();
  const script = basename(process.argv[1] ?? "");
  const role = script === "completion-boundary-sdk.mjs" ? "sdk_driver"
    : script === "registration-truth.test.ts" ? "registration_driver" : script === "async-runner.mjs" ? "runner" : "workload";
  let file, writes = 0, calls = 0, total = 0, maximum = 0, firstNative, lastPhase = null, failure, lastNative, observed;
  for (let slot = 0; slot < FILES; slot++) {
    const candidate = join(directory, `${slot}.json`);
    try { const fd = openSync(candidate, "wx"); closeSync(fd); file = candidate; break; }
    catch (error) { if (error.code !== "EEXIST") { failure = error; break; } }
  }
  if (!file && !failure) failure = new Error("Timing file cap exhausted");
  const markFailure = () => {
    try { writeFileSync(join(directory, "unusable"), "unusable"); }
    catch (markerError) {
      failure = new AggregateError([failure, markerError], "Timing snapshot and unusable marker failed");
      try { console.error("fixture-native-timing unusable: telemetry I/O failure"); }
      catch (reportError) { failure = new AggregateError([failure, reportError], "Timing failure report failed"); }
    }
  };
  if (failure) markFailure();
  const emit = event => {
    if (failure || writes >= WRITES) return;
    if (event.sequence !== undefined) lastNative = event;
    if (event.phase === "before") { calls++; firstNative ??= performance.now() - enrolledAt; }
    else { total += event.elapsed_ms; maximum = Math.max(maximum, event.elapsed_ms); }
    try {
      const snapshot = { schema: "fixture-native-timing-v1", stream, role, pid: process.pid, instance,
        snapshot_at_ms: performance.now() - enrolledAt,
        writes: ++writes, write_cap: WRITES, saturated: writes === WRITES, omitted_records: writes === WRITES ? "unknown_after_cap" : 0,
        calls, total_ms: total, max_ms: maximum, first_native_ms: firstNative ?? null, last_phase: lastPhase, event };
      let text = JSON.stringify({ ...snapshot, attribution: projectTimingAttribution(lastNative, role === "sdk_driver" ? observed?.readSettlement() : undefined) });
      if (Buffer.byteLength(text) > BYTES) text = JSON.stringify({ ...snapshot,
        attribution: projectTimingAttribution(lastNative, undefined) });
      if (Buffer.byteLength(text) > BYTES) text = JSON.stringify(snapshot);
      if (Buffer.byteLength(text) > BYTES) throw new Error("Timing byte cap exceeded");
      writeFileSync(file, text);
    } catch (error) { failure = error; markFailure(); }
  };
  const previousSink = phaseSink;
  phaseSink = phase => {
    lastPhase = { phase, elapsed_ms: performance.now() - enrolledAt };
    emit({ site: "fixture_phase", phase: "marker", elapsed_ms: 0 });
  };
  // Persist enrollment even if startup never reaches a native query.
  emit({ site: "enrollment", phase: "enrolled", elapsed_ms: 0 });
  observed = observeNative(original, emit, { origin: enrolledAt });
  const previousObserver = settlementObserver;
  if (role === "sdk_driver") settlementObserver = observed;
  childProcess.spawnSync = observed;
  syncBuiltinESMExports();
  return () => {
    phaseSink = previousSink;
    settlementObserver = previousObserver;
    childProcess.spawnSync = original; syncBuiltinESMExports();
    const observerFailure = observed.readObserverFailure();
    if (observerFailure) failure = failure
      ? new AggregateError([failure, observerFailure.error], "Timing sink failures")
      : new Error("Timing sink failed", { cause: observerFailure.error });
    if (failure) throw new Error("Fixture timing evidence unusable", { cause: failure });
  };
}
export function selectTimingSamples(rows, requestedPids = []) {
  const selected = new Set((Array.isArray(requestedPids) ? requestedPids.slice(0, 2) : []).filter(pid => Number.isSafeInteger(pid) && pid > 0));
  return [...rows].sort((a, b) => Number(b.role.endsWith("_driver")) - Number(a.role.endsWith("_driver")) ||
    Number(selected.has(b.pid)) - Number(selected.has(a.pid)) ||
    Number(b.event.phase === "before") - Number(a.event.phase === "before") || b.max_ms - a.max_ms).slice(0, 8);
}
// Scoped callers own one patched enrollment and finish it exactly once; no overlapping restoration.
export function enrollTiming(root, stream, patch = false) {
  if (!enabled()) return { env: {}, finish() {} };
  const readerOrigin = performance.now();
  const directory = join(root, "native-timing");
  mkdirSync(directory, { recursive: true });
  const keys = ["PI_ACTORS_FIXTURE_TIMING_DIR", "PI_ACTORS_FIXTURE_TIMING_STREAM", "NODE_OPTIONS"];
  const saved = keys.map(key => process.env[key]);
  const env = { PI_ACTORS_FIXTURE_TIMING_DIR: directory, PI_ACTORS_FIXTURE_TIMING_STREAM: stream,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${import.meta.url}`.trim() };
  let restore = () => {};
  if (patch) {
    for (const key of keys) process.env[key] = env[key];
    restore = install(directory, stream);
  }
  return { env, finish({ requestedPids = [] } = {}) {
    let failure;
    try { restore(); } catch (error) { failure = error; }
    finally { if (patch) keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
    try {
      const names = readdirSync(directory);
      if (names.includes("unusable")) throw new Error("Timing child evidence unusable");
      if (names.length > FILES || names.some(name => !/^(0|[1-9][0-9]{0,2})\.json$/.test(name) || Number(name.slice(0, -5)) >= FILES)) throw new Error("Timing inventory invalid");
      const rows = names.map(name => {
        const path = join(directory, name);
        if (statSync(path).size > BYTES) throw new Error("Timing file oversized");
        return JSON.parse(readFileSync(path, "utf8"));
      });
      // Export only our closed numeric/boolean fields, never file content or paths.
      const valid = rows.every(row => row.schema === "fixture-native-timing-v1" && row.stream === stream &&
        typeof row.instance === "string" && /^[0-9a-f-]{36}$/.test(row.instance) && Number.isSafeInteger(row.pid) && row.pid > 0 &&
        ["sdk_driver", "registration_driver", "runner", "workload"].includes(row.role) && Number.isSafeInteger(row.calls) &&
        [row.calls, row.total_ms, row.max_ms, row.snapshot_at_ms].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0) &&
        (row.first_native_ms === null || (typeof row.first_native_ms === "number" && Number.isFinite(row.first_native_ms) && row.first_native_ms >= 0)) &&
        typeof row.saturated === "boolean" && ["before", "after", "throw", "enrolled", "marker"].includes(row.event?.phase) &&
        (row.last_phase === null || (["prompt", "model_request", "spawn_return", "gate", "settle", "registration_launch", "result_wait"].includes(row.last_phase?.phase) &&
          typeof row.last_phase.elapsed_ms === "number" && Number.isFinite(row.last_phase.elapsed_ms) && row.last_phase.elapsed_ms >= 0)) &&
        (row.event.sequence === undefined || (Number.isSafeInteger(row.event.sequence) && row.event.sequence > 0 &&
          Number.isSafeInteger(row.event.target_pid) && row.event.target_pid > 0 &&
          typeof row.event.before_call_ms === "number" && Number.isFinite(row.event.before_call_ms) && row.event.before_call_ms >= 0 &&
          [row.event.native_start_ms, row.event.completed_ms].every(value => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)))));
      if (!valid || !rows.length) throw new Error("Timing enrollment unavailable");
      console.log("fixture-native-timing " + JSON.stringify({ schema: "fixture-native-summary-v1", stream, usable: !failure,
        clock_scope: "writer offsets are process-local since enrollment; never subtract reader and writer offsets",
        observation: { reader_pid: process.pid, elapsed_since_reader_enrollment_ms: performance.now() - readerOrigin },
        duration_scope: "sum of recorded call durations, not wall-clock critical-path time",
        snapshot_scope: "last saved events only; before does not establish a still-running native call",
        attribution_scope: "advisory caller hints; settlement bracket is slightly wider than policy, driver-local only; no original-runner liveness or whole-scope proof",
        processes: rows.length, calls: rows.reduce((n, row) => n + row.calls, 0),
        saturated: rows.filter(row => row.saturated).length,
        omitted_records: rows.some(row => row.saturated) ? "unknown_after_cap" : 0,
        active_at_last_snapshot: rows.filter(row => row.event.phase === "before").length,
        total_native_ms: rows.reduce((n, row) => n + row.total_ms, 0),
        selection_scope: "requested diagnostic PIDs only prioritize existing last snapshots; not generation binding or liveness",
        samples: selectTimingSamples(rows, requestedPids).map(row => ({ pid: row.pid, instance: row.instance, role: row.role,
          calls: row.calls, total_ms: row.total_ms, max_ms: row.max_ms, first_native_ms: row.first_native_ms, snapshot_at_ms: row.snapshot_at_ms,
          active_at_last_snapshot: row.event.phase === "before", sequence: row.event.sequence ?? 0,
          native_event: row.event.sequence === undefined ? null : { phase: row.event.phase, target_pid: row.event.target_pid,
            before_call_ms: row.event.before_call_ms, native_start_ms: row.event.native_start_ms, completed_ms: row.event.completed_ms },
          last_phase: row.last_phase === null ? null : { phase: row.last_phase.phase, elapsed_ms: row.last_phase.elapsed_ms },
          attribution: projectTimingAttribution(row.attribution?.last_native, row.attribution?.settlement) })) }));
    } catch (error) { failure = failure ? new AggregateError([failure, error], "Timing failures") : error; }
    if (failure) { console.log(`fixture-native-timing ${JSON.stringify({ schema: "fixture-native-summary-v1", stream, usable: false })}`); throw failure; }
  } };
}
if (enabled() && process.env.PI_ACTORS_FIXTURE_TIMING_DIR && ["sdk-source", "sdk-packed", "registration"].includes(process.env.PI_ACTORS_FIXTURE_TIMING_STREAM)) {
  install(process.env.PI_ACTORS_FIXTURE_TIMING_DIR, process.env.PI_ACTORS_FIXTURE_TIMING_STREAM);
}
