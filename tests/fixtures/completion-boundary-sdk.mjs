/**
 * Zones: source/packed extension, public Pi SDK lifecycle evidence.
 * Owns isolated public-spawn/provider probes and durable exit evidence; candidate uses privileged kernel composition, no network.
 */
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { Document, parseDocument, isScalar, visit } from "yaml";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { markTiming, beginSettlementTiming, endSettlementTiming, readSettlementTiming } from "./windows-native-timing.mjs";
import { settleCapturedRunner, readSettlementFailureWitness } from "./sdk-runner-settlement.mjs";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession, CustomMessageComponent, DefaultResourceLoader, initTheme, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const [packageDir, agentDir, layout = "packed", profile] = process.argv.slice(2);
assert.ok(layout === "source" || layout === "packed");
assert.ok(profile === undefined || profile === "yaml-candidate");
const candidate = profile === "yaml-candidate";
const loadOwner = name => import(pathToFileURL(join(packageDir, layout === "source" ? `lib/${name}.ts` : `dist/lib/${name}.js`)).href);
const delivery = candidate ? await loadOwner("run-delivery") : undefined;
const extensionRuntime = candidate ? await loadOwner("extension-runtime") : undefined;
// Privileged fixture composition, explicitly NOT the unchanged default entrypoint.
function candidateActors(pi, captures) {
  const runtime = extensionRuntime.createActorExtensionRuntime(pi, undefined, undefined, input => {
    const batch = delivery.captureRunCompletionYamlCandidateBatch(input);
    const capture = { input, batch }; captures.push(capture);
    capture.journal = JSON.parse(readFileSync(delivery.getRunDeliveryJournalPath(input.tempDir, input.ownerId), "utf8"));
    return batch;
  });
  pi.on("session_start", (event, ctx) => runtime.onSessionStart(ctx, event));
  pi.on("turn_end", (event, ctx) => runtime.onTurnEnd(event, ctx));
  pi.on("agent_settled", (_event, ctx) => runtime.onAgentSettled(ctx));
  pi.on("context", (event, ctx) => ({ messages: runtime.onContext(event.messages, ctx) }));
  pi.on("session_shutdown", (event, ctx) => runtime.onSessionShutdown(event.reason, ctx));
  pi.on("before_agent_start", (event, ctx) => runtime.beforeAgentStart(event.systemPrompt, event.systemPromptOptions.skills ?? [], ctx));
  runtime.registerCoreTools();
}
const manifestPath = join(agentDir, "fixture-processes.json");
const captured = [], terminalReads = [];
let originalObserverSlot, eligibleAttemptConsumed = false;
let launching = false;
const persistCapture = () => writeFile(manifestPath, JSON.stringify({ schema: "primary-sdk-fixture-v1", complete: !launching && captured.every(run => run.settled), launching, captured, terminal_reads: terminalReads }));
await mkdir(agentDir, { recursive: true });
await persistCapture();
const actors = (await import(pathToFileURL(join(packageDir, layout === "source" ? "index.ts" : "dist/pi-actors/index.js")).href)).default;
const model = {
  id: "boundary-fixture", name: "Boundary Fixture", api: "boundary-fixture", provider: "boundary-fixture",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const gateExpiryMarker = "PI_ACTORS_SDK_FIXTURE_GATE_EXPIRED_V1";
function failureContext(stage, run, result, evidence) {
  const text = JSON.stringify({ schema: "sdk-fixture-failure-v1", stage, mode: run.mode, request: run.request, index: run.index,
    run: run.run, run_instance_id: run.run_instance_id, pid: run.pid, state_dir: run.state_dir,
    terminal_acceptance: result?.terminal_acceptance, code: result?.code, signal: result?.signal,
    failure_reason: result?.failure_reason,
    gate_expiry_marker_observed: typeof result?.error === "string" ? result.error.includes(gateExpiryMarker) : undefined,
    failure_evidence: evidence,
  }, (_key, value) => typeof value === "string" && value.length > 2048 ? "[whole field omitted: size limit]" : value);
  return Buffer.byteLength(text, "utf8") <= 8192 ? text : JSON.stringify({ schema: "sdk-fixture-failure-v1",
    stage: "diagnostic_omission", details: "whole record omitted: diagnostic byte bound" });
}
function reportFailure(stage, run, result) {
  // Diagnostic I/O must not replace the exact original rejection, including falsy values.
  try { console.error(failureContext(stage, run, result)); } catch {}
}
// Finite private ledger: presence and occurrence order do not depend on caught-value truthiness.
function originalRunnerFaultLedger() {
  const stages = ["subscribe", "unsubscribe", "candidate", "spawn_attach", "spawn_remove", "spawn_snapshot",
    "close_attach", "close_remove", "frame_bind", "frame_refusal", "close_clock", "catch_clock", "runtime_fields", "projection", "disposal"];
  const entries = stages.map(stage => ({ stage, present: false, ordinal: 0, value: undefined }));
  let ordinal = 0;
  return {
    record(stage, value) { try {
      const entry = entries.find(entry => entry.stage === stage);
      if (entry && !entry.present) { entry.present = true; entry.ordinal = ++ordinal; entry.value = value; }
    } catch {} },
    tokens() { try { return entries.filter(entry => entry.present).sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.stage); } catch { return []; } },
  };
}
function armOriginalRunner(options) { try { return observeOriginalRunner(options()); } catch {} }
function observeOriginalRunner({ channel, executable, runner, directory, alias, now }) {
  const faults = originalRunnerFaultLedger();
  let active = true, admitting = true, reserved = false, candidate, frame, signature, refused = false;
  let subscriptionOwned = false, unsubscribeAttempted = false, admissionConfirmed = true;
  let spawnOwned = false, spawnRemoveAttempted = false, closeOwned = false, closeRemoveAttempted = false;
  let listenersConfirmed = true, coverage = false, spawnSeen = false, processReceipt, bound = false;
  let closeObserved = false, closeAt, disposed = false, consumed = false, bindAttempted = false, projectionAttempted = false;
  const guarded = (stage, operation) => { try { return operation(); } catch (value) { faults.record(stage, value); } };
  const endAdmission = () => { try {
    admitting = false;
    if (subscriptionOwned && !unsubscribeAttempted) {
      unsubscribeAttempted = true; admissionConfirmed = false;
      guarded("unsubscribe", () => { if (channel.unsubscribe(onCandidate) === true) admissionConfirmed = true; else faults.record("unsubscribe", undefined); });
    }
  } catch (value) { faults.record("unsubscribe", value); } };
  const removeSpawn = () => { try {
    if (spawnOwned && !spawnRemoveAttempted) {
      spawnRemoveAttempted = true;
      guarded("spawn_remove", () => { candidate.removeListener("spawn", onSpawn); spawnOwned = false; });
      if (spawnOwned) listenersConfirmed = false;
    }
  } catch (value) { listenersConfirmed = false; faults.record("spawn_remove", value); } };
  const removeClose = () => { try {
    if (closeOwned && !closeRemoveAttempted) {
      closeRemoveAttempted = true;
      guarded("close_remove", () => { candidate.removeListener("close", onClose); closeOwned = false; });
      if (closeOwned) listenersConfirmed = false;
    }
  } catch (value) { listenersConfirmed = false; faults.record("close_remove", value); } };
  const dispose = () => { try {
    if (disposed) { candidate = undefined; frame = undefined; return; }
    disposed = true; active = false; admitting = false;
    endAdmission(); removeSpawn(); removeClose(); candidate = undefined; frame = undefined;
  } catch (value) { faults.record("disposal", value); } };
  const matchProcess = () => { try {
    if (signature && processReceipt) bound = signature[2] === processReceipt.pid && signature[3] === directory;
  } catch (value) { refused = true; faults.record("frame_bind", value); } };
  const onClose = () => { try {
    if (!active || closeObserved) return;
    closeObserved = true;
    guarded("close_clock", () => { const value = now(); if (Number.isFinite(value) && value >= 0) closeAt = value; });
    removeSpawn(); removeClose(); candidate = undefined;
  } catch (value) { coverage = false; faults.record("close_clock", value); } };
  const onSpawn = () => { try {
    if (!active || spawnSeen) return;
    spawnSeen = true;
    let snapshotRead = false;
    guarded("spawn_snapshot", () => {
      const file = candidate.spawnfile, argv = candidate.spawnargs, pid = candidate.pid;
      snapshotRead = true;
      if (file !== executable || !Number.isSafeInteger(pid) || pid <= 0 || !Array.isArray(argv)) return;
      const plain = argv.length === 3 && argv[0] === executable && argv[1] === runner && argv[2] === directory;
      const strip = argv.length === 4 && argv[0] === executable && argv[1] === "--experimental-strip-types" && argv[2] === runner && argv[3] === directory;
      if (!plain && !strip) return;
      processReceipt = { pid }; matchProcess();
      closeOwned = true;
      let attached = false;
      guarded("close_attach", () => { candidate.on("close", onClose); attached = true; });
      coverage = attached;
      if (!attached) dispose();
    });
    if (!snapshotRead) dispose();
    else removeSpawn();
  } catch (value) { coverage = false; faults.record("spawn_snapshot", value); dispose(); } };
  const onCandidate = message => { try {
    if (!active || !admitting || reserved) return;
    reserved = true;
    let admitted = false;
    guarded("candidate", () => { candidate = message.process; admitted = !!candidate; });
    if (!admitted) { dispose(); return; }
    spawnOwned = true;
    let attached = false;
    guarded("spawn_attach", () => { candidate.on("spawn", onSpawn); attached = true; });
    if (!attached) dispose();
  } catch (value) { faults.record("candidate", value); dispose(); } };
  const readSignature = run => [run.run, run.run_instance_id, run.pid, run.state_dir, run.mode, run.request, run.index];
  const bind = run => { try {
    if (bindAttempted) return;
    bindAttempted = true; frame = run;
    guarded("frame_bind", () => {
      const first = readSignature(run);
      if (first[0] !== alias || typeof first[1] !== "string" || !first[1] || !Number.isSafeInteger(first[2]) || first[2] <= 0 ||
        first[3] !== directory || first[4] !== "overflow" || first[5] !== 1 || first[6] !== 0) { refused = true; return; }
      signature = Object.freeze(first); matchProcess();
    });
    if (!signature) refused = true;
  } catch (value) { refused = true; faults.record("frame_bind", value); } };
  const selects = run => { try {
    if (consumed || refused || !signature || run !== frame) return false;
    let unchanged = false;
    guarded("frame_refusal", () => { unchanged = readSignature(run).every((value, index) => value === signature[index]); });
    if (!unchanged) refused = true;
    return unchanged;
  } catch (value) { refused = true; faults.record("frame_refusal", value); return false; } };
  const success = run => { try { if (selects(run)) { consumed = true; dispose(); } } catch (value) { faults.record("disposal", value); } };
  const failure = run => { try {
    if (!selects(run) || projectionAttempted) return;
    projectionAttempted = true; consumed = true;
    const frozenBound = bound, frozenCoverage = coverage, frozenClose = closeObserved, frozenCloseAt = closeAt;
    let retained = candidate, runtimeTerminalFields = "unavailable";
    const captureUnchanged = () => {
      const unchanged = readSignature(run).every((value, index) => value === signature?.[index]);
      return unchanged && active && !disposed && candidate === retained && frame === run && bound === frozenBound &&
        coverage === frozenCoverage && closeObserved === frozenClose && closeAt === frozenCloseAt;
    };
    if (frozenBound && frozenCoverage && retained && active && !disposed) guarded("runtime_fields", () => {
      if (!captureUnchanged()) return;
      const code = retained.exitCode;
      if (!captureUnchanged()) return;
      const signal = retained.signalCode;
      if (!captureUnchanged()) return;
      if (code === null && signal === null) runtimeTerminalFields = "null_pair";
      else if (Number.isSafeInteger(code) && signal === null) runtimeTerminalFields = "exit_code_set";
      else if (code === null && typeof signal === "string" && Object.hasOwn(osConstants.signals, signal)) runtimeTerminalFields = "signal_code_set";
    });
    let sampled;
    guarded("catch_clock", () => { const value = now(); if (Number.isFinite(value) && value >= 0 &&
      (!frozenClose || (Number.isFinite(frozenCloseAt) && frozenCloseAt <= value))) sampled = value; });
    if (runtimeTerminalFields !== "unavailable") {
      let unchanged = false;
      guarded("runtime_fields", () => { unchanged = captureUnchanged(); });
      if (!unchanged) runtimeTerminalFields = "unavailable";
    }
    retained = undefined;
    dispose();
    return guarded("projection", () => Object.freeze({ schema: "fixture-original-runner-close-v1",
      scope: "retained original object; callback and public runtime field observations only; no absence/scope authority", boundary: "settlement_catch_entry",
      runtime_terminal_fields: runtimeTerminalFields,
      binding: frozenBound ? "matched" : "unavailable",
      observation: frozenBound && frozenCoverage ? frozenClose ? "close_observed" : "close_not_observed" : "unavailable",
      ...(!frozenBound || !frozenCoverage ? { reason: !frozenBound ? "process_binding_unavailable" : "listener_coverage_unavailable" } : {}),
      clock_scope: "same-driver unshifted performance clock", clock_valid: sampled !== undefined,
      ...(sampled !== undefined ? { sampled_ms: sampled, ...(frozenBound && frozenCoverage && frozenClose ? { close_observed_ms: frozenCloseAt } : {}) } : {}),
      admission_teardown: admissionConfirmed ? "confirmed" : "unconfirmed",
      listener_teardown: listenersConfirmed ? "confirmed" : "unconfirmed", faults: Object.freeze(faults.tokens()),
    }));
  } catch (value) { faults.record("projection", value); dispose(); } };
  try {
    subscriptionOwned = true;
    let subscribed = false;
    guarded("subscribe", () => { channel.subscribe(onCandidate); subscribed = true; });
    if (!subscribed) dispose();
  } catch (value) { faults.record("subscribe", value); dispose(); }
  return { endAdmission, bind, success, failure, dispose };
}
async function settle(run) {
  let ticket;
  try { ticket = beginSettlementTiming(); } catch {}
  try {
    try { await settleCapturedRunner(run, persistCapture); originalObserverSlot?.success(run); }
    finally { try { endSettlementTiming(ticket); } catch {} }
  } catch (error) {
    const originalRunner = originalObserverSlot?.failure(run);
    try {
      let driverAttribution;
      try { driverAttribution = readSettlementTiming(ticket); } catch {}
      const evidence = { ...(originalRunner ? { original_runner: originalRunner } : {}), settlement: readSettlementFailureWitness(error), outcome: await observeFailureOutcome(run),
        driver_attribution: driverAttribution ? { scope: "advisory driver-local bracket slightly wider than policy; no other-process overlap, original-runner liveness or whole-scope proof", window: driverAttribution } : undefined };
      console.error(failureContext("settle", run, undefined, evidence));
    } catch (later) { throw new AggregateError([error, later], "SDK settlement diagnostic failed; retaining state"); }
    throw error;
  }
}
function failureFileStamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
function sameFailureFile(a, b) { return failureFileStamp(a).every((value, index) => value === failureFileStamp(b)[index]); }
function unavailableFailureFileError(error) {
  if (error === null || !["object", "function"].includes(typeof error)) return false;
  let property;
  try { property = Object.getOwnPropertyDescriptor(error, "code"); }
  catch (later) { throw new AggregateError([error, later], "Failure snapshot error inspection failed"); }
  return property && "value" in property && ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(property.value);
}
async function readFailureJson(path) {
  try {
    const pathBefore = await lstat(path);
    if (!pathBefore.isFile() || pathBefore.size > 65536) return undefined;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let failed = false, original;
    try {
      const before = await file.stat();
      if (!before.isFile() || !sameFailureFile(pathBefore, before)) return undefined;
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== before.size || !sameFailureFile(before, await file.stat()) || !sameFailureFile(before, await lstat(path))) return undefined;
      let value;
      // Malformed/incomplete source is unavailable; never retain a parser error containing body bytes.
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))); }
      catch (error) { if (error instanceof SyntaxError || unavailableFailureFileError(error)) return undefined; throw error; }
      return { path, stamp: before, value };
    } catch (error) { failed = true; original = error; throw error; }
    finally {
      try { await file.close(); }
      catch (error) { if (failed) throw new AggregateError([original, error], "Failure snapshot read and close failed"); throw error; }
    }
  } catch (error) {
    if (unavailableFailureFileError(error)) return undefined;
    throw error;
  }
}
async function failureJsonUnchanged(snapshot) {
  try { return sameFailureFile(snapshot.stamp, await lstat(snapshot.path)); }
  catch (error) { if (unavailableFailureFileError(error)) return false; throw error; }
}
async function observeFailureStage(expected, ownerId, read, unchanged) {
  const unavailable = reason => ({ state: "unavailable", reason });
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  // Only the first overflow's existing single-command records; never command text, identities or source bodies.
  const execution = await read(join(expected.state_dir, "execution.json"));
  const native = await read(join(expected.state_dir, "native-launches.json"));
  let executionView = unavailable("source_unavailable"), nativeView = unavailable("source_unavailable");
  if (execution) {
    const value = execution.value, command = value?.commands?.[0];
    if (value?.version !== 1 || value.run !== expected.run || value.run_instance_id !== expected.run_instance_id ||
      !["running", "done", "failed", "stopping"].includes(value.status) || !Array.isArray(value.commands) || value.commands.length > 1 ||
      (command !== undefined && (command?.id !== "command-001" || !["running", "done", "failed"].includes(command.status) ||
        !Array.isArray(command.attempts) || command.attempts.length > 1))) executionView = unavailable("uncorrelated_or_unrecognized");
    else executionView = { state: "observed", status: value.status, command_recorded: command !== undefined,
      command_status: command?.status ?? "not_recorded", attempts_recorded: command?.attempts.length ?? 0,
      recorded_exit_code: Number.isSafeInteger(command?.native_exit_code) ? command.native_exit_code : "not_recorded" };
    if (!(await unchanged(execution))) executionView = unavailable("source_changed");
  }
  if (native) {
    const value = native.value, intent = value?.intents?.[0];
    if (value?.schema !== "run-native-launches-v1" || value.run !== expected.run || value.run_instance_id !== expected.run_instance_id ||
      value.runner_pid !== expected.pid || value.ownerId !== ownerId || !Array.isArray(value.intents) || value.intents.length > 1 ||
      (intent !== undefined && (intent?.command_id !== "command-001" || intent.attempt !== 1 ||
        (intent.birth !== undefined && (!record(intent.birth) || !Number.isSafeInteger(intent.birth.pid) || intent.birth.pid <= 0)) ||
        (intent.settlement !== undefined && !record(intent.settlement))))) nativeView = unavailable("uncorrelated_or_unrecognized");
    else nativeView = { state: "observed", intents_recorded: value.intents.length, birth_recorded: intent?.birth !== undefined,
      settlement_recorded: intent?.settlement !== undefined,
      recorded_exit_code: Number.isSafeInteger(intent?.settlement?.native_exit_code) ? intent.settlement.native_exit_code : "not_recorded" };
    if (!(await unchanged(native))) nativeView = unavailable("source_changed");
  }
  return { scope: "separately checked saved metadata; not atomic, native identity/exit or whole-scope proof",
    execution: executionView, native_journal: nativeView };
}
async function observeFailureOutcome(run, read = readFailureJson, unchanged = failureJsonUnchanged) {
  const scope = "generation-correlated observation only; not ownership, native identity or exit proof";
  const unavailable = reason => ({ state: "unavailable", reason, scope });
  const expected = { run: run.run, pid: run.pid, run_instance_id: run.run_instance_id, state_dir: run.state_dir };
  const collectStage = run.mode === "overflow" && run.index === 0;
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0 || typeof expected.run !== "string" || !expected.run ||
    typeof expected.run_instance_id !== "string" || !expected.run_instance_id || expected.run_instance_id.length > 128 ||
    typeof expected.state_dir !== "string" || !expected.state_dir || expected.state_dir.length > 2048) return unavailable("invalid_capture");
  const metadata = await read(join(expected.state_dir, "run.json"));
  if (!metadata) return unavailable("metadata_source_unavailable");
  const meta = metadata.value;
  if (meta?.run !== expected.run || meta?.run_instance_id !== expected.run_instance_id || meta?.pid !== expected.pid || meta?.state_dir !== expected.state_dir)
    return unavailable("metadata_mismatch");
  const result = await read(join(expected.state_dir, "result.json"));
  const stage = collectStage ? await observeFailureStage(expected, meta.ownerId, read, unchanged) : undefined;
  if (!(await unchanged(metadata))) return unavailable("metadata_changed");
  let outcome;
  if (!result) outcome = unavailable("result_source_unavailable");
  else if (result.value?.run_instance_id !== expected.run_instance_id) outcome = unavailable("result_mismatch");
  else if (!(await unchanged(result))) outcome = unavailable("result_changed");
  else outcome = { state: "observed", scope,
    terminal_acceptance: ["natural", "stop", "cancelled"].includes(result.value.terminal_acceptance) ? result.value.terminal_acceptance : "unavailable",
    code: Number.isSafeInteger(result.value.code) ? result.value.code : "unavailable" };
  if (Object.keys(expected).some(key => run[key] !== expected[key]) || (collectStage && (run.mode !== "overflow" || run.index !== 0)))
    return unavailable("capture_changed");
  return { ...outcome, ...(stage ? { stage } : {}) };
}
const workReadinessFrames = new WeakMap();
function captureWorkFrame(run, ownerId) {
  workReadinessFrames.set(run, Object.freeze({ run: run.run, run_instance_id: run.run_instance_id, pid: run.pid,
    state_dir: run.state_dir, mode: run.mode, ownerId }));
}
function workFileMissing(error) {
  if (error === null || !["object", "function"].includes(typeof error)) return false;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(error, "code"); }
  catch (later) { throw new AggregateError([error, later], "Work readiness error inspection failed"); }
  return descriptor && "value" in descriptor && descriptor.value === "ENOENT";
}
async function readWorkJson(path, missing = false, maxBytes = 65536) {
  let pathBefore;
  try { pathBefore = await lstat(path); }
  catch (error) { if (missing && workFileMissing(error)) return undefined; throw error; }
  assert.ok(pathBefore.isFile() && pathBefore.size <= maxBytes, "Unusable work readiness source");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let failed = false, original;
  try {
    const before = await file.stat();
    assert.ok(before.isFile() && sameFailureFile(pathBefore, before), "Work readiness source changed");
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    assert.ok(bytesRead === before.size && sameFailureFile(before, await file.stat()) && sameFailureFile(before, await lstat(path)), "Work readiness source changed");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid work readiness record");
    return { path, stamp: before, value };
  } catch (error) { failed = true; original = error; throw error; }
  finally {
    try { await file.close(); }
    catch (error) { if (failed) throw new AggregateError([original, error], "Work readiness read and close failed"); throw error; }
  }
}
async function waitForWorkReadiness(run, ownerId, expectedCode, {
  read = readWorkJson,
  stat = lstat,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  // Readonly functional readiness; only the existing whole-layout watchdog bounds this wait.
  const capturedFrame = workReadinessFrames.get(run);
  assert.ok(capturedFrame && capturedFrame.ownerId === ownerId, "Work readiness original owner unavailable");
  const { ownerId: _owner, ...expected } = capturedFrame;
  assert.ok(Object.keys(expected).every(key => run[key] === expected[key]), "Work readiness capture changed");
  assert.ok(typeof ownerId === "string" && ownerId && [0, 7].includes(expectedCode));
  assert.ok(typeof expected.run === "string" && expected.run && typeof expected.run_instance_id === "string" && expected.run_instance_id &&
    Number.isSafeInteger(expected.pid) && expected.pid > 0 && typeof expected.state_dir === "string" && expected.state_dir);
  const directory = await stat(expected.state_dir);
  assert.ok(directory.isDirectory(), "Invalid work readiness directory");
  const fence = async snapshot => {
    assert.ok(Object.keys(expected).every(key => run[key] === expected[key]), "Work readiness capture changed");
    const current = await stat(expected.state_dir);
    assert.ok(current.isDirectory() && current.dev === directory.dev && current.ino === directory.ino, "Work readiness directory changed");
    if (snapshot) assert.ok(sameFailureFile(snapshot.stamp, await stat(snapshot.path)), "Work readiness source changed");
    try { await stat(join(expected.state_dir, "stop-claim.json")); }
    catch (error) { if (workFileMissing(error)) return; throw error; }
    assert.fail("Work readiness refuses stop claims");
  };
  const metadata = await read(join(expected.state_dir, "run.json"), false, 1024 * 1024);
  const meta = metadata.value;
  const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  assert.ok(meta.run === expected.run && meta.run_instance_id === expected.run_instance_id && meta.pid === expected.pid &&
    meta.state_dir === expected.state_dir && meta.ownerId === ownerId && meta.outcome_protocol === "run-outcome-v1" &&
    typeof meta.cwd === "string" && meta.cwd && timestamp(meta.createdAt), "Unsupported work readiness metadata");
  for (;;) {
    await fence(metadata);
    const result = await read(join(expected.state_dir, "result.json"), true, 65536);
    await fence(metadata);
    if (result) {
      const value = result.value;
      assert.ok(value.run_instance_id === expected.run_instance_id && value.terminal_acceptance === "natural" &&
        !Object.hasOwn(value, "stop_claim_id") && value.code === expectedCode && timestamp(value.completedAt) &&
        (value.signal === undefined || value.signal === null) && value.killed === false &&
        (expectedCode === 7 ? typeof value.error === "string" : value.error === undefined && value.failure_reason === undefined) &&
        value.primary_text_protocol === "run-primary-text-v1" && value.artifact_inventory_protocol === "run-artifact-inventory-v1" &&
        value.result_diagnostics_protocol === "run-result-diagnostics-v1", "Unsupported work readiness outcome");
      await fence(result); await fence(metadata);
      return;
    }
    await sleep(25);
  }
}
async function readRetainedText(reference, bytesTotal) {
  const file = await open(reference.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    assert.ok(before.isFile() && before.size === bytesTotal && before.size <= 4 * 1024 * 1024);
    const chunks = []; let offset = 0;
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(8192, before.size - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      assert.ok(bytesRead > 0, "Retained source ended before the bounded read completed");
      chunks.push(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
    const bytes = Buffer.concat(chunks); const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.sha256);
    return body;
  } finally { await file.close(); }
}
async function readSource(reference, expected) {
  assert.deepEqual(reference, expected.source, "Read only the exact reference delivered to model context");
  const body = await readRetainedText(reference, expected.bytes_total);
  assert.equal([...body].length, expected.chars_total);
  assert.equal([...expected.preview].length, expected.chars_shown);
  assert.equal(expected.chars_shown + expected.chars_omitted, expected.chars_total);
  assert.equal(expected.truncated, expected.chars_omitted > 0);
  assert.equal(Buffer.from(body).subarray(expected.shown_bytes.start, expected.shown_bytes.end).toString("utf8"), expected.preview);
  return body;
}
async function readMemberInventory(references, count) {
  const reference = references.find(value => value.members_total !== undefined); assert.ok(reference, "Model context must retain its captured-member inventory reference");
  assert.equal(reference.members_total, count); assert.match(reference.path, /inventory-[a-f0-9]{64}\.json$/);
  const body = await readRetainedText(reference, reference.bytes_total); const inventory = JSON.parse(body);
  assert.equal(inventory.schema, "run-completion-inventory-v1"); assert.equal(inventory.scope, "captured_completion_members");
  assert.equal(inventory.members_total, count); assert.equal(inventory.members.length, count); assert.equal(inventory.artifacts, "not_included");
  assert.equal(inventory.diagnostics, "not_included"); assert.equal(inventory.private_locations, "not_included");
  assert.equal(inventory.result_diagnostics, "captured_bindings_only");
  return { reference, inventory, body };
}
function literalBlocks(text) {
  return [...text.matchAll(/(?:^|\n)( *)(`{3,})text\n([\s\S]*?)\n\1\2(?=\n|$)/gu)].map(match => {
    const indent = match[1], lines = match[3].split("\n");
    assert.ok(lines.every(line => line.startsWith(indent)), "AX value indentation must be uniform, never source normalization");
    return lines.map(line => line.slice(indent.length)).join("\n");
  });
}
// Launch receipts alone use literalBlocks; completion bodies are opaque Markdown.
// BEGIN INDEPENDENT PURE ORACLE
// Pure independent completion oracle; public YAML only, no product expectations.
// Dependencies supplied by the fixture/probe: assert and public yaml
// (Document, parseDocument, isScalar, visit). No product modules or decoder.
function oracleYaml(value) {
  const document = new Document(value, { version: "1.2", schema: "core", aliasDuplicateObjects: false });
  visit(document, { Pair(_key, pair) {
    if (isScalar(pair.key) && typeof pair.key.value === "string" && pair.key.value.includes("\uFEFF")) pair.key.type = "QUOTE_DOUBLE";
  } });
  return document.toString({ collectionStyle: "block", indent: 2, lineWidth: 0, directives: false,
    defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE", doubleQuotedAsJSON: true });
}
function completionCore(text) {
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0 && text.isWellFormed() && Buffer.byteLength(text, "utf8") <= 49152);
  const mapping = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const exactKeys = (value, required, optional = []) => {
    assert.ok(mapping(value));
    assert.ok(required.every(key => Object.hasOwn(value, key)));
    assert.ok(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  };
  const endpoint = offset => {
    assert.ok(!(/[\uD800-\uDBFF]/u.test(text[offset - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(text[offset] ?? "")));
  };
  const records = []; let cursor = 0, batchId, service;
  while (cursor < text.length) {
    assert.ok(records.length < 64);
    const start = cursor, framed = text.startsWith("---\n", start);
    // This search is ONLY in the current compiler header. No body search occurs.
    const end = text.indexOf(framed ? "\n---\n" : "\n\n", start + (framed ? 4 : 0));
    if (framed) assert.ok(end >= start + 4);
    const yamlEnd = end < 0 ? text.length : end + 1;
    const yaml = text.slice(start + (framed ? 4 : 0), yamlEnd);
    assert.ok(yaml.endsWith("\n") && !yaml.includes("\n\n"));
    const document = parseDocument(yaml, { version: "1.2", schema: "core", uniqueKeys: true });
    assert.deepEqual(document.errors, []); assert.deepEqual(document.warnings, []);
    const header = document.toJS({ maxAliasCount: 0 }); assert.ok(mapping(header));
    assert.equal(oracleYaml(header), yaml, "Canonical compiler header only; no YAML/body normalization");
    const bookkeeping = header._completion;
    const first = records.length === 0;
    if (first) {
      exactKeys(bookkeeping, ["codec", "batch_id"], ["service", "parts"]);
      assert.equal(bookkeeping.codec, "completion_yaml_core_v1");
      assert.equal(typeof bookkeeping.batch_id, "string");
      assert.ok(bookkeeping.batch_id.trim() && bookkeeping.batch_id.length <= 128);
      batchId = bookkeeping.batch_id;
      if (Object.hasOwn(bookkeeping, "service")) {
        service = bookkeeping.service;
        exactKeys(service, [], ["header_layout", "omitted_results", "omitted_states", "inventory_warning", "result_inventory"]);
        if (service.header_layout !== undefined) assert.ok(["rooted_files_v1", "rooted_files_v2"].includes(service.header_layout));
        assert.ok(Object.keys(service).length > 0);
        if (Object.hasOwn(service, "omitted_results")) assert.ok(Number.isSafeInteger(service.omitted_results) && service.omitted_results > 0);
        if (Object.hasOwn(service, "omitted_states")) {
          exactKeys(service.omitted_states, [], ["failed", "killed", "exited"]);
          assert.ok(Object.keys(service.omitted_states).length > 0);
          for (const count of Object.values(service.omitted_states)) assert.ok(Number.isSafeInteger(count) && count > 0);
          assert.ok(Object.values(service.omitted_states).reduce((a, b) => a + b, 0) <= service.omitted_results);
        }
        if (Object.hasOwn(service, "inventory_warning")) assert.equal(typeof service.inventory_warning, "string");
        if (Object.hasOwn(service, "result_inventory")) {
          const ref = service.result_inventory;
          exactKeys(ref, ["path", "sha256", "bytes_total", "members_total"], ["root"]);
          assert.ok(typeof ref.path === "string" || mapping(ref.path));
          assert.match(ref.sha256, /^[a-f0-9]{64}$/u);
          assert.ok(Number.isSafeInteger(ref.bytes_total) && ref.bytes_total > 0);
          assert.ok(Number.isSafeInteger(ref.members_total) && ref.members_total > 0 && ref.members_total <= 256);
        }
      }
    } else if (bookkeeping !== undefined) exactKeys(bookkeeping, ["parts"]);
    const lengths = bookkeeping?.parts;
    if (framed) assert.ok(Array.isArray(lengths) && lengths.length > 0);
    else assert.equal(lengths, undefined);
    cursor = framed ? end + 5 : yamlEnd;
    const headerBlock = { kind: "header", start, end: cursor, text: text.slice(start, cursor) };
    const blocks = [headerBlock];
    let bodySelected = false, nonemptyPart = false;
    for (const descriptor of lengths ?? []) {
      assert.ok(mapping(descriptor) && Object.keys(descriptor).length === 1);
      const kind = Object.keys(descriptor)[0], length = descriptor[kind];
      assert.ok(["body", "marker"].includes(kind));
      assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= text.length - cursor);
      endpoint(cursor); endpoint(cursor + length);
      const value = text.slice(cursor, cursor + length); assert.ok(value.isWellFormed());
      blocks.push({ kind, start: cursor, end: cursor + length, text: value }); cursor += length;
      bodySelected ||= kind === "body"; nonemptyPart ||= length > 0;
    }
    if (framed) assert.ok(bodySelected || nonemptyPart, "Empty marker-only wrappers are not selected body0");
    const keys = Object.keys(header).filter(key => key !== "_completion");
    if (!keys.length) {
      assert.ok(first && !framed && service && cursor === text.length, "Zero rows require one bare service-only header");
      break;
    }
    const indexed = Object.hasOwn(header, "index");
    assert.deepEqual(keys.slice(0, indexed ? 3 : 2), indexed ? ["index", "run", "state"] : ["run", "state"]);
    if (indexed) assert.ok(Number.isSafeInteger(header.index) && header.index === records.length, "Ordinary displayed indices remain packet-local");
    else assert.equal(service?.header_layout, "rooted_files_v2");
    assert.equal(typeof header.run, "string"); assert.ok(header.run.length > 0);
    assert.ok(["done", "failed", "killed", "exited"].includes(header.state));
    const allowed = ["index", "run", "state", "kind", "preview_field", "redacted", "result_state", "parent_run", "primary_unavailable",
      "diagnostic_metadata_unavailable", "artifact_declarations", "artifact_inventory_unavailable", "run_files_unavailable", "references", "run_files", "files", "run_files_omission", "text_warnings"];
    assert.ok(keys.every(key => allowed.includes(key)), "No body-coverage metadata or legacy facade fields");
    if (Object.hasOwn(header, "kind")) {
      assert.equal(keys[indexed ? 3 : 2], "kind"); assert.ok(["primary", "diagnostic"].includes(header.kind));
    }
    if (Object.hasOwn(header, "redacted")) assert.equal(header.redacted, true);
    if (header.files) {
      const restored = rootedTechnical(header);
      // Non-enumerable compatibility facts keep subsequent independent raw-header cost checks honest.
      Object.defineProperty(header, "references", { value: restored.references });
      if (restored.runFiles) Object.defineProperty(header, "run_files", { value: restored.runFiles });
    }
    for (const detail of [header.references?.primary, header.references?.diagnostic_metadata].filter(Boolean)) {
      for (const key of ["state", "chars_shown", "chars_total", "chars_omitted", "utf8_range", "shown_bytes", "truncated", "upstream_truncated"])
        assert.equal(Object.hasOwn(detail, key), false, `No YAML body coverage: ${key}`);
    }
    records.push({ index: header.index, header, blocks, bodySelected, text: text.slice(start, cursor) });
    if (cursor === text.length) break;
    const separator = framed ? "\n\n" : "\n";
    assert.equal(text.slice(cursor, cursor + separator.length), separator, "Exact compiler LF record separator");
    cursor += separator.length;
    assert.ok(cursor < text.length, "No final separator/tail");
  }
  assert.equal(cursor, text.length, "Whole core consumed; no compiler tail or extra bytes");
  assert.ok(batchId);
  assert.equal(records.some(record => !Object.hasOwn(record.header, "index")), service?.header_layout === "rooted_files_v2" && records.length === 1,
    "Only a new packet with exactly one shown result omits its display index");
  return { batchId, service: service ?? {}, records };
}
function completionPacket(text) {
  try { completionCore(text); return true; } catch { return false; }
}
function completionRecords(text) { return completionCore(text).records; }
function containsRootedPath(text, path) {
  return completionRecords(text).some(record => record.header.files?.groups?.some(group => typeof group.root === "string"
    && group.entries.some(entry => typeof entry.path === "string" && join(group.root, entry.path) === path)));
}
// Independent reconstruction of selected source bindings from explicit header roots.
// No body parsing, cwd lookup, product projector or evidence refresh participates.
function rootedTechnical(header) {
  const files = header.files, references = { ...files?.notes };
  let runFiles;
  if (!files) return {};
  const entries = (files.groups ?? []).flatMap(group => group.entries.map(entry => ({
    ...entry, path: typeof group.root === "string" && typeof entry.path === "string" ? join(group.root, entry.path) : entry.path,
  })));
  for (const role of ["primary", "diagnostic_metadata", "artifact_inventory"]) {
    const entry = entries.find(entry => entry.role === role);
    if (!entry) continue;
    const { role: _role, purpose, path, source, ...detail } = entry;
    references[role] = { ...detail, source: { path, ...source } };
  }
  const declarations = entries.filter(entry => entry.role === "artifact");
  if (declarations.length) references.artifacts = { scope: declarations[0].scope,
    declarations: declarations.map(entry => ({ name: entry.name, path: entry.path })) };
  if (files.observation) {
    const { group, ...observation } = files.observation;
    if (observation.state === "available") {
      const directory = files.groups[group].root;
      const selected = entries.filter(entry => entry.format_hint).map(({ purpose, ...entry }) => entry);
      runFiles = { run: observation.run, run_instance_id: observation.run_instance_id,
        locations: { ...observation, directory, files: selected } };
    } else {
      const { run, run_instance_id, ...locations } = observation;
      runFiles = { run, run_instance_id, locations };
    }
  }
  return { references, runFiles };
}

function technicalObjects(text) {
  const packet = typeof text === "string" ? completionCore(text) : { records: [text], service: {} };
  return [...packet.records.flatMap(record => [record.header.references, record.header.run_files].filter(Boolean)),
    ...(packet.service.result_inventory ? [(() => {
      const { root, ...reference } = packet.service.result_inventory;
      return { ...reference, path: root ? join(root, reference.path) : reference.path };
    })()] : [])];
}
function deliveredBody(record, full) {
  assert.ok(full.isWellFormed());
  const bodies = record.blocks.filter(block => block.kind === "body");
  assert.equal(bodies.length, 1, "Selected producer body is one part, including selected empty body0");
  const body = bodies[0].text, shown = [...body].length, total = [...full].length;
  assert.equal(body, [...full].slice(0, shown).join(""), "Actual independently recovered producer/postprivacy source prefix");
  assert.ok(shown <= total);
  assert.ok(!(full[body.length - 1] === "\r" && full[body.length] === "\n"), "Source prefix must not split an original CRLF pair");
  const omission = total - shown, cut = record.blocks.indexOf(bodies[0]);
  const known = record.blocks.filter(block => block.kind === "marker" && /^\[\d+ characters omitted\]$/u.test(block.text));
  assert.deepEqual(known.map(block => block.text), omission ? [`[${omission} characters omitted]`] : []);
  if (omission) {
    assert.equal(record.blocks[cut + 1]?.kind, "marker"); assert.equal(record.blocks[cut + 1]?.text, "\n");
    assert.equal(record.blocks[cut + 2]?.kind, "marker"); assert.equal(record.blocks[cut + 2]?.text, `[${omission} characters omitted]`);
  }
  return body;
}
function deliveredReferences(text) {
  if (!completionPacket(text)) return [];
  return technicalObjects(text).flatMap(value => [
    ...(value.path && value.sha256 ? [value] : []),
    ...[value.primary?.source, value.artifact_inventory?.source, value.diagnostic_metadata?.source].filter(Boolean),
  ]);
}
// END INDEPENDENT PURE ORACLE

// Independent costs from canonical inventory/source facts. No product formatter/fitter.
function requiredReferenceFacts(member) {
  const output = member.primary_text.output, diagnostic = member.result_diagnostics;
  return {
    primary: { scope: output.text_basis === "actor_response"
      ? "Executor-selected final Actor response at capture; admission privacy; prior stream clipping remains separate."
      : "Exported primary text at capture; admission privacy, not complete Actor output.",
      ...(output.text_basis ? { text_basis: output.text_basis } : {}),
      ...(output.redacted ? { redacted: true } : {}), source: output.source },
    diagnostic_metadata: { scope: "Diagnostic metadata only; not primary output; admission privacy for recorded fields.",
      recorded_fields_not_shown: diagnostic.fields, source: { ...diagnostic.source, bytes_total: diagnostic.bytes_total, fields: diagnostic.fields } },
  };
}
function rootedRequiredFacts(member, minimal = false) {
  const facts = requiredReferenceFacts(member), groups = [];
  assert.equal(dirname(facts.primary.source.path), dirname(facts.diagnostic_metadata.source.path), "Independent evidence-root cost premise");
  for (const [role, purpose] of [["primary", "Full result text"], ["diagnostic_metadata", "Recorded error and command metadata"]]) {
    const { source: { path, ...source }, ...detail } = facts[role];
    const root = dirname(path);
    let group = groups.find(item => item.root === root);
    if (!group) { group = { root, entries: [] }; groups.push(group); }
    group.entries.push({ role, purpose, ...(minimal ? { scope: detail.scope } : detail), source, path: basename(path) });
  }
  return { read_first: { group: 0, entry: 0 }, groups };
}
function mandatoryOutcomeBytes(members) {
  // Native fixture sources share evidence/; their parent-root representation is no larger than
  // Run-root plus repeated evidence/ prefixes. Keep required roles/purposes/privacy scopes/read_first; drop optional facts and all non-reference metadata.
  return members.reduce((sum, member, index) => sum + Buffer.byteLength(oracleYaml({ index, run: member.run,
    state: "done", kind: "primary", files: rootedRequiredFacts(member, true) })), 0);
}
function outcome65UpperBound(inventory, inventoryReference, batchId, legacyCompanionRuns) {
  // Constructor-owned set plus caller marker-absence check binds this private legacy-only model.
  // Inventory source absence alone does not establish a navigation-refusal reason.
  assert.equal(legacyCompanionRuns.size, 64);
  assert.equal(inventory.members.length, 65);
  const genuine = inventory.members.filter(member => member.primary_text?.output);
  assert.equal(genuine.length, 1);
  assert.equal(inventory.members[0], genuine[0]);
  // At most64 production candidates => maximum frozen equal body share floor(49152/64).
  // Hypothetically adding65th row must not enlarge that share. This is NOT a65-row encoder call.
  const maximumBodyBytes = Math.floor(49152 / 64);
  const locationOmission = { reason: "packet_byte_limit", shown: 0, omitted: 1, total: 1 };
  const unknown = "[omitted: unknown] (upstream completeness unproven)";
  let bytes = 0;
  for (const [index, member] of inventory.members.entries()) {
    let metadata, parts, payloadBytes;
    if (index === 0) {
      const output = member.primary_text.output;
      metadata = { index, run: member.run, state: "done", kind: "primary", redacted: true,
        files: rootedRequiredFacts(member), text_warnings: [unknown], run_files_omission: locationOmission };
      // Decimal maximum source count bounds omitted-count spelling; no full source bytes charged.
      const omitted = `[${output.chars_total} characters omitted]`;
      parts = [{ body: maximumBodyBytes }, { marker: 1 }, { marker: omitted.length }];
      payloadBytes = maximumBodyBytes + 1 + Buffer.byteLength(omitted);
    } else {
      assert.equal(member.primary_text, undefined); assert.equal(member.result_diagnostics, undefined);
      assert.equal(member.artifact_inventory, undefined);
      assert.ok(legacyCompanionRuns.has(member.run), "Unproven legacy companion constructor");
      metadata = { index, run: member.run, state: "done", result_state: "not captured",
        run_files_unavailable: "identity_unavailable", run_files_omission: locationOmission };
      parts = []; payloadBytes = 0;
    }
    metadata._completion = { ...(index === 0 ? { codec: "completion_yaml_core_v1", batch_id: batchId,
      service: { header_layout: "rooted_files_v2", omitted_results: 1,
        result_inventory: { ...inventoryReference, root: dirname(inventoryReference.path), path: basename(inventoryReference.path) } } } : {}),
      ...(parts.length ? { parts } : {}) };
    // Includes complete canonical header, both fences, payload and two-LF record separator.
    // Extra omitted_results:1 remains as conservative service overhead even in hypothetical65 rows.
    bytes += Buffer.byteLength(oracleYaml(metadata)) + 8 + payloadBytes + (index < 64 ? 2 : 0);
  }
  return bytes;
}

// Independent boundary oracle: YAML is parsed ONLY inside the compiler header.
// Raw body/marker lengths are relative UTF-16 lengths, never body-label searches.
function candidateRecord(text, batchId) {
  const independent = completionCore(text); assert.equal(independent.batchId, batchId);
  assert.ok(text.startsWith("---\nrun: "));
  const end = text.indexOf("\n---\n", 4); assert.ok(end > 4);
  const yaml = text.slice(4, end + 1);
  const document = parseDocument(yaml, { version: "1.2", schema: "core", uniqueKeys: true });
  assert.deepEqual(document.errors, []); assert.deepEqual(document.warnings, []);
  const header = document.toJS({ maxAliasCount: 0 });
  assert.deepEqual(Object.keys(header).slice(0, 3), ["run", "state", "kind"]);
  assert.equal(Object.hasOwn(header, "index"), false); assert.equal(header.state, "done"); assert.equal(header.kind, "primary");
  const core = header._completion;
  assert.deepEqual(Object.keys(core), ["codec", "batch_id", "service", "parts"]);
  assert.deepEqual(core.service, { header_layout: "rooted_files_v2" });
  assert.equal(core.codec, "completion_yaml_core_v1"); assert.equal(core.batch_id, batchId);
  assert.ok(Array.isArray(core.parts) && core.parts.length > 0);
  const blocks = []; let cursor = end + 5;
  for (const part of core.parts) {
    const keys = Object.keys(part); assert.equal(keys.length, 1);
    const kind = keys[0], length = part[kind];
    assert.ok(["body", "marker"].includes(kind) && Number.isSafeInteger(length) && length >= 0);
    const value = text.slice(cursor, cursor + length); assert.equal(value.length, length); assert.ok(value.isWellFormed());
    blocks.push({ kind, text: value }); cursor += length;
  }
  assert.equal(cursor, text.length, "Whole packet consumed: no extra compiler HTML tail or unadmitted bytes");
  const restored = rootedTechnical(header);
  Object.defineProperty(header, "references", { value: restored.references });
  if (restored.runFiles) Object.defineProperty(header, "run_files", { value: restored.runFiles });
  for (const ref of [header.references?.primary, header.references?.diagnostic_metadata].filter(Boolean)) {
    for (const key of ["chars_shown", "chars_total", "chars_omitted", "shown_bytes", "truncated", "upstream_truncated"]) assert.equal(Object.hasOwn(ref, key), false);
  }
  assert.match(yaml, /files:\n/u); assert.match(yaml, /_completion:\n  codec:/u);
  const decoded = delivery.readCompletionYamlCarrier(text); assert.equal(decoded.state, "available");
  assert.equal(decoded.packet.batchId, batchId); // Auxiliary consistency, NOT the expected body/source oracle.
  return { header, blocks };
}
const digest = value => createHash("sha256").update(value).digest("hex");
const reports = [];
for (const mode of candidate ? ["tools"] : ["tools", "final", "overflow", "primary-overflow", "row-limit", "failure", "artifact-large", "source-loss", "session-response"]) {
  let manager = candidate ? SessionManager.create(agentDir, join(agentDir, "sessions")) : SessionManager.inMemory(agentDir);
  const candidateCaptures = [], candidateContexts = [], candidateProviders = [];
  const defaultContexts = [];
  let candidateText, candidateEvidence;
  const ownerId = manager.getSessionId();
  const overflowCount = 40; const overflowMode = mode === "overflow" || mode === "primary-overflow"; const rowLimitMode = mode === "row-limit";
  const failureMode = mode === "failure"; const artifactMode = mode === "artifact-large"; const lossMode = mode === "source-loss";
  const sessionMode = mode === "session-response";
  const companionCount = candidate ? 0 : rowLimitMode ? 64 : overflowMode || failureMode || artifactMode || lossMode || sessionMode ? 0 : 1;
  const companionName = index => rowLimitMode ? `${mode}-${String(index).padStart(2, "0")}` : `${mode}-second`;
  // Compact JSON references no longer carry the old padded technical blocks. A bounded public alias
  // forces byte overflow through actual encoded identity/reference rows, not command/source length.
  const overflowSuffix = "encoded-row-witness-".repeat(5).slice(0, 95);
  assert.equal(overflowSuffix.length, 95, "Overflow alias suffix stays within its fixture bound");
  const overflowName = index => `${mode}-${index}-${overflowSuffix}`;
  const completionRequest = candidate ? 2 : overflowMode ? overflowCount + 2 : lossMode ? 4 : 3;
  const stateDirs = overflowMode ? [] : [undefined, ...Array.from({ length: companionCount }, (_, i) => join(agentDir, "tmp", "pi-actors", "runs", companionName(i + 1)))];
  const generations = overflowMode ? [] : [undefined, ...Array.from({ length: companionCount }, (_, i) => `${mode}-generation-${i + 1}`)];
  const modeRuns = []; const requests = []; const errors = []; const diagnosticSources = new Map(); const primarySources = new Map();
  let toolExecutions = 0; let starts = 0; let settled = 0; let sends = 0; let spawnCalls = 0;
  let launchNavigationShown = 0; let launchNavigationUnavailable = 0;
  let terminalSelection, terminalBatchText, terminalResearch; const terminalReadEvents = [];
  const legacyCompanionRuns = new Set();
  let primarySourcesRecovered = 0; let omittedPrimarySourcesRecovered = 0; let rowLimitEvidence; let failureEvidence; let artifactEvidence;
  let shutdown; let startContext; let primary; let artifactInventory; let currentRun; let providerError; let providerFailed = false; let companionEpoch;
  const parkedSources = []; const lossBatchContexts = []; let restoredSources = 0; let lossResultBytes;
  const primaryText = " \r\n\uFEFF🌍 ````` exact  \r\nBearer hidden-prefix-sdk-token\n" + "x".repeat(mode === "tools" || mode === "primary-overflow" ? 2 * 1024 * 1024 : 128 * 1024) + "\nBearer hidden-sdk-source-token\nTAIL🌈";
  const script = join(agentDir, `${mode}-emit.cjs`); const gate = join(agentDir, `${mode}-release`);
  const emitted = mode === "overflow" ? "ACTUAL_COMPOSITION_RESULT\n" + "y".repeat(8192) : primaryText;
  const artifactRoot = join(agentDir, `${mode}-artifacts`); const artifactLiteral = "hidden-artifact-reference-token";
  const artifactCount = artifactMode ? 1800 : mode === "tools" || lossMode ? 5 : 0;
  const artifactDeclarations = Object.fromEntries(Array.from({ length: artifactCount }, (_, i) => [`declared-${i}`,
    artifactMode ? i === 0 ? { path: join(artifactRoot, "binary.bin"), kind: "binary", media_type: "application/octet-stream", required: true }
      : i === 1 ? { path: join(artifactRoot, "large.txt"), kind: "report", media_type: "text/plain", required: true }
      : join(artifactRoot, i === artifactCount - 1 ? `${artifactLiteral}.bin` : `not-created-${i}.bin`)
      : join(agentDir, `never-created-${i}.bin`)]));
  const failureLiteral = "hidden-failure-literal-token"; const legacyFailureCanary = "LEGACY_FAILURE_STREAM_ONLY_CANARY";
  const failureText = "FAILURE-HEAD \uFEFF\r\n````` \uFFFD🌍\nBearer hidden-failure-prefix-token\n" + "界🧪".repeat(2000) +
    "\n" + failureLiteral + "\nBearer hidden-failure-tail-token\nFAILURE-TAIL🌈\r\n ";
  await writeFile(script, `const fs = require('node:fs'); const emit = () => {${failureMode
    ? `process.stderr.write(${JSON.stringify(failureText)}); process.exitCode=7;`
    : `${artifactMode ? `fs.mkdirSync(${JSON.stringify(artifactRoot)}, {recursive:true});
      fs.writeFileSync(${JSON.stringify(artifactDeclarations["declared-0"].path)}, Buffer.alloc(8*1024*1024, 0xff));
      fs.writeFileSync(${JSON.stringify(artifactDeclarations["declared-1"].path)}, '界'.repeat(2*1024*1024));` : ""}
      process.stdout.write(${JSON.stringify(emitted)});`}};
    if (${JSON.stringify(mode)} !== 'tools') { const deadline = Date.now() + 300000; const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); emit(); }
      else if (Date.now() >= deadline) { clearInterval(timer); process.stderr.write(${JSON.stringify(gateExpiryMarker + "\n")}); process.exitCode = 1; }
    }, 10); } else emit();`);
  const sessionProvider = join(agentDir, "session-response-provider.mjs");
  if (sessionMode) await writeFile(sessionProvider, `
    import fs from "node:fs";
    export default function(pi) {
      const model = ${JSON.stringify({ ...model, id: "actor-response-fixture", provider: "actor-response-fixture", api: "actor-response-fixture" })};
      let calls = 0;
      pi.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
        streamSimple: () => {
          const result = (async () => {
            if (++calls !== 1) throw Error("Unexpected finite Actor model replay");
            const deadline = performance.now() + 300000;
            while (!fs.existsSync(${JSON.stringify(gate)})) {
              if (performance.now() >= deadline) throw Error("Actor response fixture gate expired");
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            return { role:"assistant", api:model.api, provider:model.provider, model:model.id, timestamp:Date.now(), stopReason:"stop",
              content:[{type:"text", text:${JSON.stringify(primaryText)}}],
              usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
          })();
          return { async *[Symbol.asyncIterator]() { const message = await result; yield {type:"done",reason:"stop",message}; }, result:()=>result };
        }});
    }`);
  const readOutcome = async run => {
    let result;
    try {
      result = JSON.parse(await readFile(join(run.state_dir, "result.json"), "utf8"));
      assert.equal(result.terminal_acceptance, "natural");
      assert.equal(result.code, failureMode ? 7 : 0, failureContext("readOutcome", run, result));
      assert.equal(result.primary_text_protocol, "run-primary-text-v1");
      assert.equal(result.artifact_inventory_protocol, "run-artifact-inventory-v1");
      assert.equal(result.result_diagnostics_protocol, "run-result-diagnostics-v1");
      if (rowLimitMode) {
        const meta = JSON.parse(await readFile(join(run.state_dir, "run.json"), "utf8"));
        companionEpoch = Math.max(Date.parse(meta.createdAt), Date.parse(result.completedAt)); assert.ok(Number.isFinite(companionEpoch));
      }
      const diagnosticFields = ["command", "error", "failure_reason"].filter(key => typeof result[key] === "string");
      if (diagnosticFields.length) {
        const reference = result.result_diagnostics; assert.deepEqual(reference.fields, diagnosticFields);
        const metadata = JSON.parse(await readRetainedText(reference.source, reference.bytes_total));
        assert.deepEqual(Object.keys(metadata.fields), diagnosticFields); assert.equal(metadata.schema, "run-result-diagnostics-v1");
        assert.equal(metadata.privacy_scope, "producer_admission"); assert.equal(metadata.primary_text, "not_included");
        diagnosticSources.set(run.run, { reference, metadata });
      } else { assert.equal(result.result_diagnostics, null); assert.equal(result.result_diagnostics_unavailable, "not_recorded"); }
      if (artifactCount > 0) {
        assert.ok(result.artifact_inventory); artifactInventory = result.artifact_inventory; assert.equal(result.artifact_inventory.declarations_total, artifactCount);
        const inventory = JSON.parse(await readRetainedText(result.artifact_inventory.source, result.artifact_inventory.bytes_total));
        assert.equal(inventory.schema, "run-artifact-inventory-v1"); assert.equal(inventory.capture_scope, "producer_admission");
        assert.equal(inventory.contents, "not_read"); assert.equal(inventory.availability, "not_observed"); assert.equal(inventory.production_provenance, "not_asserted");
        assert.deepEqual(inventory.artifacts.map(item => item.name), Object.keys(artifactDeclarations));
      } else { assert.equal(result.artifact_inventory, null); assert.equal(result.artifact_inventory_unavailable, "not_declared"); }
      if (failureMode) {
        assert.equal(result.output, null); assert.equal(result.output_unavailable, "primary_not_selected_for_failure");
        const diagnostic = diagnosticSources.get(run.run); assert.ok(diagnostic); assert.equal(typeof diagnostic.metadata.fields.error, "string");
        const expected = result.error.replaceAll("hidden-failure-prefix-token", "[REDACTED]").replaceAll("hidden-failure-tail-token", "[REDACTED]").replaceAll(failureLiteral, "[REDACTED]");
        assert.equal(diagnostic.metadata.fields.error, expected); assert.ok(Array.from(expected).length > 1000);
        assert.ok(result.error.includes(failureLiteral) && result.error.includes("hidden-failure-prefix-token") && result.error.includes("hidden-failure-tail-token"));
        const execution = JSON.parse(await readFile(join(run.state_dir, "execution.json"), "utf8")); assert.equal(execution.commands[0].exit_code, 7);
        assert.equal(expected.includes(legacyFailureCanary), false);
        // Only the unrelated runner stream gets this post-exit canary; it cannot become metadata or fallback body.
        await writeFile(join(run.state_dir, "stdout.log"), legacyFailureCanary);
        return;
      }
      if (mode === "overflow") {
        assert.equal(result.output.text_basis, "actor_response");
        primarySources.set(run.run, result.output); return;
      }
      if (sessionMode) { assert.equal(result.output.text_basis, "actor_response"); assert.equal(result.output.upstream_truncated, false); }
      primary = { output: result.output }; assert.ok(primary.output); primarySources.set(run.run, primary.output);
      const execution = JSON.parse(await readFile(join(run.state_dir, "execution.json"), "utf8"));
      assert.equal(execution.commands[0].stdout_truncated, mode === "tools" || mode === "primary-overflow");
      assert.doesNotMatch(JSON.stringify(execution), /stdoutSha256/); assert.doesNotMatch(JSON.stringify(result), /stdoutSha256/);
    } catch (error) { reportFailure("readOutcome", run, result); throw error; }
  };
  const spawnArgs = index => sessionMode ? { as: `run:${mode}-first`,
    template: "{node} {pi} --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-tools --extension {provider} --provider actor-response-fixture --model actor-response-fixture --thinking off -p 'LAUNCH_SESSION_PROMPT_NOT_THE_RESULT'",
    values: { node: process.execPath, pi: fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))), provider: sessionProvider } } : ({ as: `run:${overflowMode ? overflowName(index) : `${mode}-first`}`,
    template: mode === "overflow" ? ["{node} {script} {padding}"] : overflowMode ? "{node} {script} {padding}" : "{node} {script}",
    values: { node: process.execPath, script, ...(overflowMode ? { padding: "界".repeat(3000) } : {}),
      ...(failureMode ? { api_key: failureLiteral } : artifactMode ? { api_key: artifactLiteral } : {}) }, ...(mode === "final" ? { verbose: true } : {}),
    ...(artifactCount > 0 ? { artifacts: artifactDeclarations } : {}) });
  const complete = async (index) => {
    assert.ok(Number.isSafeInteger(index) && index > 0 && index <= companionCount);
    // These legacy companions are synthetic metadata only; deterministic times keep the genuine outcome first.
    const stateDir = stateDirs[index]; const timestamp = new Date(rowLimitMode ? companionEpoch + index : Date.now()).toISOString();
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "run.json"), JSON.stringify({
      createdAt: timestamp, cwd: agentDir, notification_policy: "normal", ownerId,
      pid: 999_999_999, run: companionName(index), run_instance_id: generations[index], state_dir: stateDir,
    }));
    await writeFile(join(stateDir, "result.json"), JSON.stringify({ code: 0, finished_at: timestamp }));
    if (rowLimitMode) legacyCompanionRuns.add(companionName(index));
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager: settings, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerProvider(model.provider, {
        api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
        streamSimple: (_model, context) => {
          const request = requests.length + 1;
          assert.ok(request <= (candidate ? 3 : completionRequest), "Completion continuation must terminate");
          markTiming("model_request");
          requests.push(context.messages);
          const result = (async () => {
            if ((request === 2 && (mode === "final" || rowLimitMode || failureMode || artifactMode || lossMode || sessionMode)) || (request === overflowCount + 1 && overflowMode)) {
              assert.ok(currentRun && !currentRun.settled, "Real commands stay gated until the final-answer model request");
              assert.equal(modeRuns.length, overflowMode ? overflowCount : 1);
              markTiming("gate");
              await writeFile(gate, "release");
              for (const run of modeRuns) { await waitForWorkReadiness(run, ownerId, failureMode ? 7 : 0); await settle(run); await readOutcome(run); }
              if (mode === "final" || rowLimitMode) for (let index = 1; index <= companionCount; index++) await complete(index);
              if (lossMode) {
                lossResultBytes = await readFile(join(currentRun.state_dir, "result.json"));
                const diagnostic = diagnosticSources.get(currentRun.run); assert.ok(diagnostic); assert.ok(primary.output && artifactInventory);
                for (const [index, value] of [primary.output, artifactInventory, diagnostic.reference].entries()) {
                  const reference = value.source; assert.equal(dirname(reference.path), join(currentRun.state_dir, "evidence"));
                  assert.equal(reference.run_instance_id, currentRun.run_instance_id);
                  const body = await readRetainedText(reference, value.bytes_total); const parked = join(agentDir, `${mode}-parked-${index}`);
                  await assert.rejects(lstat(parked), { code: "ENOENT" });
                  await rename(reference.path, parked); await assert.rejects(lstat(reference.path), { code: "ENOENT" });
                  parkedSources.push({ reference, bytesTotal: value.bytes_total, body, parked });
                }
                // A separate raw stream canary cannot replace any of the three missing publication sources.
                await writeFile(join(currentRun.state_dir, "stdout.log"), "SOURCE_LOSS_RAW_STREAM_CANARY");
              }
            }
            if (!candidate && mode === "tools" && (request === 2 || request === 3)) {
              const observed = defaultContexts.at(-1); assert.ok(observed);
              const converted = context.messages.filter(message => typeof message.content === "string" ? message.content === observed.content
                : message.content?.some(part => part.type === "text" && part.text === observed.content));
              assert.equal(converted.length, 1); assert.equal(converted[0].role, "user");
              assert.equal(Object.hasOwn(converted[0], "customType"), false); assert.equal(Object.hasOwn(converted[0], "details"), false);
              const core = completionCore(observed.content);
              assert.equal(observed.details.pi_actors_delivery.batch_id, core.batchId);
              assert.deepEqual(observed.details.pi_actors_presentation, { format: "completion_yaml_core_v1", content_sha256: digest(observed.content) });
            }
            if (candidate && request >= 2) {
              const observed = candidateContexts.at(-1); assert.ok(observed);
              const parts = context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
                : (message.content ?? []).flatMap(part => part.type === "text" ? [part.text] : []));
              const matches = parts.filter(text => text === observed.content); assert.equal(matches.length, 1);
              candidateProviders.push({ content_sha256: digest(matches[0]), messages: context.messages.length });
              const converted = context.messages.filter(message => (typeof message.content === "string" ? message.content === observed.content
                : message.content?.some(part => part.type === "text" && part.text === observed.content)));
              assert.equal(converted.length, 1); assert.equal(converted[0].role, "user");
              assert.equal(Object.hasOwn(converted[0], "customType"), false); assert.equal(Object.hasOwn(converted[0], "details"), false);
              assert.equal(candidateCaptures.length, 1, "No recapture on continuation/reopen");
              const { input, batch, journal: capturedJournal } = candidateCaptures[0];
              assert.deepEqual(capturedJournal.completion_batch, batch);
              assert.equal(capturedJournal.owner_id, ownerId); assert.equal(batch.phase, "pending");
              assert.equal(input.ownerId, ownerId); assert.equal(batch.result_layout, "completion_yaml_files_v2");
              assert.equal(batch.members.length, 1); assert.equal(batch.members[0].run, currentRun.run);
              assert.equal(batch.members[0].run_instance_id, currentRun.run_instance_id);
              const record = candidateRecord(matches[0], batch.batch_id);
              assert.equal(record.header.run, currentRun.run);
              assert.deepEqual(batch.members[0].primary_text, primary);
              assert.deepEqual(batch.members[0].artifact_inventory, artifactInventory);
              assert.deepEqual(batch.members[0].result_diagnostics, diagnosticSources.get(currentRun.run).reference);
              assert.deepEqual(record.header.references.artifact_inventory.source, { ...artifactInventory.source,
                bytes_total: artifactInventory.bytes_total, declarations_total: artifactInventory.declarations_total });
              assert.deepEqual(record.header.references.primary.source, primary.output.source);
              if (record.header.run_files) {
                assert.equal(record.header.run_files.run_instance_id, currentRun.run_instance_id);
                assert.equal(record.header.run_files.locations.directory, currentRun.state_dir);
              } else assert.equal(record.header.run_files_omission?.omitted, 1);
              assert.deepEqual(record.header.references.diagnostic_metadata.source, { ...diagnosticSources.get(currentRun.run).reference.source,
                bytes_total: diagnosticSources.get(currentRun.run).reference.bytes_total, fields: diagnosticSources.get(currentRun.run).reference.fields });
              const full = await readSource(record.header.references.primary.source, primary.output);
              assert.ok(full.startsWith(" \r\n\uFEFF🌍 ````` exact  \r\n")); assert.ok(full.endsWith("TAIL🌈"));
              assert.doesNotMatch(full, /hidden-sdk-source-token|hidden-prefix-sdk-token/);
              assert.equal(full, primaryText.replaceAll("hidden-prefix-sdk-token", "[REDACTED]").replaceAll("hidden-sdk-source-token", "[REDACTED]"));
              deliveredBody(record, full);
              const body = record.blocks.filter(block => block.kind === "body").map(block => block.text).join("");
              assert.ok(body.length > 0); assert.equal(body, [...full].slice(0, [...body].length).join(""));
              const omitted = [...full].length - [...body].length;
              const bodyIndex = record.blocks.findIndex(block => block.kind === "body");
              assert.ok(omitted > 0);
              assert.deepEqual(record.blocks.slice(bodyIndex + 1, bodyIndex + 3), [
                { kind: "marker", text: "\n" }, { kind: "marker", text: `[${omitted} characters omitted]` },
              ], "Known loss immediately follows the raw prefix through the compiler newline part");
              assert.ok(Buffer.byteLength(matches[0]) <= 49152);
              if (request === 2) candidateText = matches[0]; else assert.equal(matches[0], candidateText);
              candidateEvidence = { batch_id: batch.batch_id, content_sha256: digest(matches[0]), source_sha256: digest(full),
                body_sha256: digest(body), source_bytes: Buffer.byteLength(full), shown_chars: [...body].length,
                journal_path: delivery.getRunDeliveryJournalPath(input.tempDir, ownerId) };
            }
            if (!candidate && ((mode === "tools" ? request === 2 : request === completionRequest) || (lossMode && request === 3))) {
              assert.equal(settled, 0, "The batch reaches the provider before idle settlement");
              assert.equal(starts, 1, "Overlay must not start another agent run");
              assert.equal(toolExecutions, overflowMode ? overflowCount : mode === "tools" || (lossMode && request === completionRequest) ? 2 : 1);
              assert.equal(spawnCalls, overflowMode ? overflowCount : 1);
              const text = JSON.stringify(context.messages);
              const expectedMembers = overflowMode ? overflowCount : companionCount + 1;
              const parts = context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
                : (message.content ?? []).flatMap(part => part.type === "text" ? [part.text] : []));
              const packets = parts.filter(completionPacket); assert.equal(packets.length, 1);
              const navigationBatch = packets[0];
              assert.doesNotMatch(navigationBatch, /^(?:result_kind|preview_kind|legacy_basis):|^kind: (?:legacy|response)$/mu);
              // Modern public runners carry explicit primary/diagnostic protocols;
              // even unavailable sources must not become untracked fallback text.
              assert.doesNotMatch(navigationBatch, /\[omitted: unknown\] \(summary\/fallback text: original completeness\/privacy unproven\)/u);
              if (expectedMembers === 1) assert.doesNotMatch(navigationBatch, /^- completions:|^- members:|^\s*- #0:/mu);
              assert.doesNotMatch(navigationBatch, /(?:^|\n)- (?:completions|members|batch|presentation|window_start|window_end|runtime_summaries|file_investigation|next|done_count|failed_count):/u);
              const technical = technicalObjects(navigationBatch);
              const records = completionRecords(navigationBatch);
              assert.match(navigationBatch, records.length === 1 ? /^(?:---\n)?run:/u : /^(?:---\n)?index: 0\nrun:/u);
              const service = completionCore(navigationBatch).service;
              const omitted = service.omitted_results ?? 0;
              assert.equal(records.length + omitted, expectedMembers);
              const locations = technical.filter(value => value.locations), shown = locations.length;
              const omittedReferences = records.filter(record => record.header.run_files_omission?.omitted === 1 || record.blocks.some(block => block.kind === "marker" && block.text === "Run-file reference omitted (packet byte limit).")).length;
              assert.equal(shown + omittedReferences, records.length, "Each displayed result has a whole reference or its explicit omission");
              for (const record of records) {
                const run = record.header.run; assert.ok(run);
                for (const value of technicalObjects(record)) {
                  if (value.locations) assert.equal(value.run.replace(/^run:/u, ""), run);
                  for (const reference of [value.primary?.source, value.artifact_inventory?.source, value.diagnostic_metadata?.source].filter(Boolean)) {
                    const slot = stateDirs.findIndex(directory => reference.path.startsWith(directory + sep)); assert.ok(slot >= 0);
                    assert.equal(reference.run_instance_id, generations[slot]);
                    const native = modeRuns.find(value => value.state_dir === stateDirs[slot]);
                    assert.equal(run, (native?.run ?? companionName(slot)).replace(/^run:/u, ""));
                  }
                }
              }
              for (const row of locations) if (row.locations.state === "available") {
                const index = stateDirs.indexOf(row.locations.directory); assert.ok(index >= 0);
                assert.equal(row.locations.run_instance_id, generations[index]); assert.equal(row.run_instance_id, generations[index]);
                assert.equal(row.run, row.locations.run); assert.equal(row.locations.files.length, 9);
                assert.equal(row.locations.files.find(file => file.role === "result")?.path, join(stateDirs[index], "result.json"));
                assert.equal(row.locations.content_scope, "file_locations_only");
              }
              if (mode === "tools") {
                const selected = locations.find(row => row.locations.state === "available" && row.locations.directory === currentRun.state_dir); assert.ok(selected);
                const result = selected.locations.files.find(file => file.role === "result"); assert.equal(result.state, "present");
                terminalSelection = { run: selected.run, run_instance_id: selected.run_instance_id, directory: selected.locations.directory,
                  path: result.path, owner: ownerId };
                terminalBatchText = navigationBatch;
              }
              assert.ok(Buffer.byteLength(navigationBatch) <= 48 * 1024);
              const references = parts.flatMap(deliveredReferences);
              const diagnosticReferences = references.filter(reference => Array.isArray(reference.fields));
              if (!overflowMode && !rowLimitMode && !failureMode && !lossMode) assert.equal(references.length, artifactCount > 0 ? 3 : 2);
              if (lossMode) {
                assert.equal(references.length, 0); assert.equal(parkedSources.length, 3);
                const batchText = navigationBatch;
                assert.equal(records.filter(record => record.header.state === "done").length, 1);
                assert.equal(records[0].header.primary_unavailable, "source_unavailable");
                assert.equal(records[0].header.artifact_inventory_unavailable, "source_unavailable");
                assert.equal(records[0].header.diagnostic_metadata_unavailable, "source_unavailable");
                assert.ok(technical.some(value => value.artifact_warning === "no legacy path fallback" && value.diagnostic_warning === "no legacy body fallback"));
                assert.doesNotMatch(batchText, /SOURCE_LOSS_RAW_STREAM_CANARY|never-created-|TAIL🌈|exact|Legacy diagnostic display|Retained .* source at capture/);
                assert.deepEqual(await readFile(join(currentRun.state_dir, "result.json")), lossResultBytes);
                assert.ok(Buffer.byteLength(batchText) <= 48 * 1024); lossBatchContexts.push(batchText);
                if (request === 3) { assert.equal(restoredSources, 0); for (const source of parkedSources) await assert.rejects(lstat(source.reference.path), { code: "ENOENT" }); }
                else { assert.equal(restoredSources, 3); assert.equal(batchText, lossBatchContexts[0], "Later context must reuse the same unavailable packet after fixture restores original sources"); }
              } else if (failureMode) {
                assert.equal(references.length, 1); assert.equal(diagnosticReferences.length, 1);
                const diagnostic = diagnosticSources.get(currentRun.run); assert.ok(diagnostic);
                const reference = diagnosticReferences[0]; assert.deepEqual(reference, { ...diagnostic.reference.source,
                  bytes_total: diagnostic.reference.bytes_total, fields: diagnostic.reference.fields });
                const metadata = JSON.parse(await readRetainedText(reference, reference.bytes_total)); assert.deepEqual(metadata, diagnostic.metadata);
                assert.equal(metadata.primary_text, "not_included"); assert.equal(metadata.privacy_scope, "producer_admission");
                const full = metadata.fields.error; const preview = Array.from(full).slice(0, 1000).join("");
                const total = Array.from(full).length; const shown = Array.from(preview).length;
                const batchText = navigationBatch;
                assert.equal(records.filter(record => record.header.state === "failed").length, 1);
                assert.equal(records[0].header.primary_unavailable, "primary_not_selected_for_failure");
                assert.match(batchText, /Diagnostic metadata only; not primary output/);
                const coverage = technical.find(value => value.diagnostic_metadata)?.diagnostic_metadata; assert.ok(coverage);
                assert.equal(coverage.field, "error");
                const delivered = deliveredBody(records[0], full);
                assert.equal(delivered, preview); assert.equal([...delivered].length, shown);
                assert.equal(Buffer.byteLength(delivered), Buffer.byteLength(preview)); assert.ok(total > shown);
                assert.deepEqual(coverage.recorded_fields_not_shown, ["failure_reason"]);
                assert.ok(full.includes("\uFEFF") && full.includes("\uFFFD") && full.includes("`````") && full.includes("FAILURE-TAIL🌈"));
                for (const value of [batchText, JSON.stringify(metadata)]) assert.doesNotMatch(value, /hidden-failure-prefix-token|hidden-failure-tail-token|hidden-failure-literal-token|LEGACY_FAILURE_STREAM_ONLY_CANARY|Legacy diagnostic display/);
                assert.ok(Buffer.byteLength(batchText) <= 48 * 1024);
                failureEvidence = { workloadCode: 7, diagnosticField: "error", diagnosticCharsTotal: total, diagnosticCharsShown: shown };
              } else if (rowLimitMode) {
                const { inventory, body } = await readMemberInventory(references, expectedMembers);
                assert.equal(inventory.members.filter(member => member.primary_text?.output).length, 1);
                assert.equal(inventory.members.filter(member => member.result_diagnostics !== undefined).length, 1);
                const byRun = (left, right) => left[0].localeCompare(right[0]);
                assert.deepEqual(inventory.members.map(member => [member.run, member.run_instance_id, member.status]).sort(byRun),
                  stateDirs.map((_, index) => [index === 0 ? currentRun.run : companionName(index), generations[index], "done"]).sort(byRun));
                const batchText = navigationBatch;
                const shownRuns = records.filter(record => record.header.state === "done").map(record => record.header.run);
                assert.equal(shownRuns.length, 64); assert.deepEqual(shownRuns, inventory.members.slice(0, 64).map(member => member.run));
                assert.deepEqual(records.map(record => record.index), Array.from({ length: 64 }, (_, index) => index));
                assert.ok(shownRuns.includes(currentRun.run)); assert.equal(service.omitted_results, 1);
                const omitted = inventory.members[64]; assert.notEqual(omitted.run, currentRun.run);
                const projectedBytes = Buffer.byteLength(batchText);
                const inventoryReference = references.find(reference => reference.members_total !== undefined);
                // Legacy constructor writes run/result only. Physical marker absence forces identity_unavailable
                // under the pinned source identity contract; fail closed if that constructor domain changed.
                for (const stateDir of stateDirs.slice(1)) {
                  await assert.rejects(lstat(join(stateDir, ".pi-actors-run-state.json")), { code: "ENOENT" });
                }
                const withOmittedRowBytes = outcome65UpperBound(inventory, inventoryReference, completionCore(batchText).batchId, legacyCompanionRuns);
                // Report-only observed64 outcome cost. It does NOT establish the independent65 upper bound above.
                const rowSelectionBytes = records.reduce((bytes, record, index) => {
                  const metadata = structuredClone(record.header); delete metadata.run_files;
                  const parts = record.blocks.filter(block => block.kind !== "header").map(block => ({ [block.kind]: block.text }));
                  if (metadata.files) {
                    delete metadata.files.observation;
                    if (metadata.files.groups) {
                      for (const group of metadata.files.groups) group.entries = group.entries.filter(entry => !entry.format_hint);
                      // Fixture reference groups precede the navigation-only group, so filtering empty suffix groups preserves read_first.
                      metadata.files.groups = metadata.files.groups.filter(group => group.entries.length);
                      if (!metadata.files.groups.length) delete metadata.files.groups;
                    }
                    if (!metadata.files.groups) delete metadata.files.read_first;
                    if (!Object.keys(metadata.files).length) delete metadata.files;
                  }
                  metadata.run_files_omission = { reason: "packet_byte_limit", shown: 0, omitted: 1, total: 1 };
                  metadata._completion = { ...(index === 0 ? { codec: "completion_yaml_core_v1",
                    batch_id: completionCore(batchText).batchId, service } : {}),
                    ...(parts.length ? { parts: parts.map(part => { const kind = Object.keys(part)[0]; return { [kind]: part[kind].length }; }) } : {}) };
                  return bytes + Buffer.byteLength(oracleYaml(metadata)) + (parts.length ? 8 : 0)
                    + parts.reduce((sum, part) => sum + Buffer.byteLength(Object.values(part)[0]), 0) + (index < 63 ? parts.length ? 2 : 1 : 0);
                }, 0);
                assert.ok(withOmittedRowBytes < 49152, "Hypothetical65 outcomes fit bytes before locations; production64-row cap omits one");
                for (const member of inventory.members.filter(member => member.run !== currentRun.run)) {
                  assert.equal(member.primary_text, undefined); assert.equal(member.result_diagnostics, undefined); assert.equal(member.artifact_inventory, undefined);
                }
                const genuine = inventory.members.find(member => member.run === currentRun.run); assert.deepEqual(genuine.primary_text, primary);
                const recovered = await readSource(genuine.primary_text.output.source, primary.output);
                assert.ok(recovered.endsWith("TAIL🌈")); assert.doesNotMatch(recovered, /hidden-sdk-source-token|hidden-prefix-sdk-token/);
                deliveredBody(records.find(record => record.header.run === genuine.run), recovered);
                assert.equal(diagnosticReferences.length, 1); assert.doesNotMatch(body, /state_dir|owner_id|steers|summary|diagnostic_excerpt/);
                rowLimitEvidence = { syntheticCompanions: companionCount, capturedMembers: expectedMembers, shownMembers: shownRuns.length,
                  omittedMembers: expectedMembers - shownRuns.length, projectedBytes, rowSelectionBytes, withOmittedRowBytes,
                  rowBudgetBasis: "outcomes_before_locations" };
              } else if (overflowMode) {
                assert.ok(references.some(value => value.members_total !== undefined), JSON.stringify({ mode, expected: overflowCount,
                  shown: records.length, bytes: Buffer.byteLength(navigationBatch), references: references.length }));
                const { inventory, body } = await readMemberInventory(references, overflowCount);
                const byRun = (left, right) => left[0].localeCompare(right[0]);
                assert.deepEqual(inventory.members.map(member => [member.run, member.run_instance_id, member.status]).sort(byRun), modeRuns.map(run => [run.run, run.run_instance_id, "done"]).sort(byRun));
                for (const member of inventory.members) {
                  if (mode === "overflow") {
                    const output = primarySources.get(member.run); assert.ok(output); assert.deepEqual(member.primary_text, { output });
                    assert.equal(output.text_basis, "actor_response");
                    const reply = await readSource(output.source, output); assert.ok(reply.startsWith("ACTUAL_COMPOSITION_RESULT\n"));
                    const record = records.find(record => record.header.run === member.run);
                    if (record) deliveredBody(record, reply);
                  }
                  else {
                    const output = primarySources.get(member.run); assert.ok(output);
                    assert.deepEqual(member.primary_text, { output }); assert.equal(output.source.run_instance_id, member.run_instance_id);
                    const body = await readSource(member.primary_text.output.source, output);
                    assert.ok(Buffer.byteLength(body) > 2 * 1024 * 1024); assert.ok(body.endsWith("TAIL🌈"));
                    assert.ok(body.startsWith(" \r\n\uFEFF🌍 ````` exact  \r\n")); assert.ok(body.includes("[REDACTED]"));
                    assert.doesNotMatch(body, /hidden-sdk-source-token|hidden-prefix-sdk-token/); primarySourcesRecovered++;
                    const record = records.find(record => record.header.run === member.run);
                    if (record) deliveredBody(record, body);
                  }
                  assert.equal(member.artifact_inventory, null); assert.equal(member.artifact_inventory_unavailable, "not_declared");
                  const diagnostic = diagnosticSources.get(member.run); assert.ok(diagnostic);
                  assert.deepEqual(member.result_diagnostics, diagnostic.reference);
                  const metadata = JSON.parse(await readRetainedText(diagnostic.reference.source, diagnostic.reference.bytes_total));
                  assert.deepEqual(metadata, diagnostic.metadata);
                  assert.ok(metadata.fields.command.includes("界".repeat(3000)));
                }
                assert.doesNotMatch(body, /legacy-body-canary|state_dir|owner_id|steers|summary|diagnostic_excerpt/);
                const batchText = navigationBatch;
                const shownRuns = records.map(record => record.header.run); const shown = shownRuns.length;
                assert.deepEqual(shownRuns, inventory.members.slice(0, shown).map(member => member.run));
                assert.ok(shown > 0 && shown < overflowCount); assert.equal(diagnosticReferences.length, shown);
                // Required row fields derive ONLY from recovered canonical member/source facts.
                const minimumEncodedBytes = mandatoryOutcomeBytes(inventory.members);
                assert.ok(minimumEncodedBytes > 48 * 1024, `Actual compact minimum rows must force byte overflow: ${minimumEncodedBytes}`);
                if (mode === "overflow") for (const member of inventory.members) {
                  const output = primarySources.get(member.run); assert.ok(output);
                  const response = await readSource(output.source, output); assert.match(response, /ACTUAL_COMPOSITION_RESULT/);
                }
                if (mode === "primary-overflow") {
                  assert.equal(primarySources.size, overflowCount);
                  const shownPrimaryRefs = references.filter(reference => reference.members_total === undefined && reference.fields === undefined && reference.declarations_total === undefined);
                  assert.equal(shownPrimaryRefs.length, shown);
                  for (const run of shownRuns) assert.ok(shownPrimaryRefs.some(reference => reference.path === primarySources.get(run).source.path));
                  for (const member of inventory.members.slice(shown)) assert.ok(member.primary_text.output, "Every omitted member keeps its available primary reference");
                  omittedPrimarySourcesRecovered = overflowCount - shown;
                }
                assert.doesNotMatch(batchText, /legacy-body-canary|Legacy diagnostic display|hidden-sdk-source-token|hidden-prefix-sdk-token/);
                assert.equal(service.omitted_results, overflowCount - shown);
                assert.ok(Buffer.byteLength(batchText) <= 48 * 1024); assert.equal(batchText.includes("projection.json"), false);
              } else {
                assert.match(text, new RegExp(`${mode}-first`)); if (companionCount > 0) assert.match(text, new RegExp(`${mode}-second`));
                assert.ok(primary?.output);
                const primaryRecord = records.find(record => record.header.references?.primary); assert.ok(primaryRecord);
                assert.ok(text.includes(primary.output.source.sha256)); assert.equal(primaryRecord.header.redacted, true);
                const coverage = primaryRecord.header.references.primary; assert.ok(coverage);
                assert.doesNotMatch(text, /hidden-sdk-source-token|hidden-prefix-sdk-token/);
                const primaryReference = references.find(reference => reference.declarations_total === undefined && reference.fields === undefined);
                const body = await readSource(primaryReference, primary.output);
                const shownText = deliveredBody(primaryRecord, body); assert.ok(shownText.startsWith(primary.output.preview));
                const shownChars = [...shownText].length, omittedChars = primary.output.chars_total - shownChars;
                assert.ok(omittedChars > 0); assert.equal([...body].length, primary.output.chars_total);
                assert.equal(Buffer.byteLength(body), primary.output.bytes_total);
                assert.equal(Buffer.from(body).subarray(0, Buffer.byteLength(shownText)).toString("utf8"), shownText);
                const unknown = (primaryRecord.header.text_warnings ?? []).filter(text => text.includes("upstream completeness unproven"));
                assert.equal(unknown.length, primary.output.upstream_truncated ? 1 : 0);
                assert.equal(diagnosticReferences.length, 1); const diagnostic = diagnosticSources.get(`${mode}-first`); assert.ok(diagnostic);
                const diagnosticReference = diagnosticReferences[0]; assert.deepEqual(diagnosticReference, { ...diagnostic.reference.source,
                  bytes_total: diagnostic.reference.bytes_total, fields: diagnostic.reference.fields });
                const metadata = JSON.parse(await readRetainedText(diagnosticReference, diagnosticReference.bytes_total));
                assert.deepEqual(metadata, diagnostic.metadata); assert.equal(metadata.primary_text, "not_included");
                const batchText = navigationBatch;
                assert.match(batchText, /Diagnostic metadata only; not primary output/);
                assert.ok(technical.some(value => value.diagnostic_metadata)); assert.ok(containsRootedPath(batchText, diagnosticReference.path));
                if (artifactCount > 0) {
                  const reference = references.find(reference => reference.declarations_total === artifactCount); assert.ok(reference); assert.ok(artifactInventory);
                  assert.deepEqual(reference, { ...artifactInventory.source, bytes_total: artifactInventory.bytes_total, declarations_total: artifactCount });
                  const inventory = JSON.parse(await readRetainedText(reference, reference.bytes_total));
                  assert.equal(inventory.artifacts.length, artifactCount); assert.equal(inventory.contents, "not_read"); assert.equal(inventory.availability, "not_observed");
                  assert.equal(inventory.production_provenance, "not_asserted");
                  assert.equal(Number(primaryRecord.header.artifact_declarations), artifactCount);
                  assert.ok(technical.some(value => value.artifact_inventory?.scope.startsWith("Metadata only"))); assert.ok(containsRootedPath(batchText, reference.path));
                  assert.equal(batchText.includes("never-created-"), false, "No legacy path slice substitutes for the admitted inventory");
                  if (artifactMode) {
                    assert.equal(inventory.run, currentRun.run); assert.equal(inventory.run_instance_id, currentRun.run_instance_id);
                    assert.equal(reference.run_instance_id, currentRun.run_instance_id); assert.equal(inventory.inventory_complete, true);
                    assert.ok(reference.bytes_total > 64 * 1024 && reference.bytes_total <= 4 * 1024 * 1024);
                    assert.deepEqual(inventory.summary, { declared: artifactCount, references_disclosed: artifactCount - 1, references_withheld: 1 });
                    const expected = Object.entries(artifactDeclarations).map(([name, declaration], index) => {
                      const item = typeof declaration === "string" ? { path: declaration } : declaration;
                      return index === artifactCount - 1 ? { name, path: null, availability: "not_observed", reason: "artifact_reference_redacted" }
                        : { name, ...item, availability: "not_observed" };
                    });
                    assert.deepEqual(inventory.artifacts, expected);
                    assert.doesNotMatch(JSON.stringify(inventory), /hidden-artifact-reference-token/);
                    const viewBytes = await readFile(join(currentRun.state_dir, "evidence", "artifacts.json")); assert.ok(viewBytes.length <= 64 * 1024);
                    const view = JSON.parse(viewBytes); assert.equal(view.content_scope, "captured_artifact_inventory_reference");
                    assert.deepEqual(view.inventory, artifactInventory); assert.deepEqual(view.summary, inventory.summary); assert.deepEqual(view.artifacts, []);
                    assert.equal(view.artifacts_shown, 0); assert.equal(view.artifacts_omitted, artifactCount);
                    const trace = (await readFile(join(currentRun.state_dir, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
                    const commandDone = trace.find(event => event.kind === "command.done"); assert.ok(commandDone);
                    assert.equal(commandDone.data.code, 0); assert.equal(commandDone.attention, undefined); assert.equal(commandDone.data.artifacts, undefined);
                    assert.deepEqual(commandDone.data.artifact_inventory, artifactInventory); assert.ok(Buffer.byteLength(JSON.stringify(commandDone)) <= 64 * 1024);
                    // Fixture-only stats observe our two outputs, not inventory/body permission or a production claim in the packet.
                    const binary = await lstat(artifactDeclarations["declared-0"].path); const largeText = await lstat(artifactDeclarations["declared-1"].path);
                    assert.ok(binary.isFile() && largeText.isFile()); assert.equal(binary.size, 8 * 1024 * 1024); assert.equal(largeText.size, 6 * 1024 * 1024);
                    assert.doesNotMatch(batchText, /hidden-artifact-reference-token|not-created-|binary\.bin|large\.txt|artifact_reference_redacted/);
                    assert.ok(Buffer.byteLength(batchText) <= 48 * 1024);
                    artifactEvidence = { artifactDeclarationsRecovered: artifactCount, artifactReferencesWithheld: 1, artifactSourceBytes: reference.bytes_total,
                      fixtureBinaryBytes: binary.size, fixtureTextBytes: largeText.size };
                  }
                }
                assert.ok(Buffer.byteLength(body) > (mode === "tools" ? 2 * 1024 * 1024 : 128 * 1024)); assert.ok(body.endsWith(sessionMode ? "TAIL🌈\n" : "TAIL🌈"));
                if (sessionMode) {
                  assert.equal(primaryRecord.header.kind, "primary");
                  assert.doesNotMatch(navigationBatch, /--session-dir|--provider|LAUNCH_SESSION_PROMPT_NOT_THE_RESULT/);
                  const execution = JSON.parse(await readFile(join(currentRun.state_dir, "execution.json"), "utf8"));
                  assert.equal(execution.commands[0].session_dir, "sessions/command-001"); assert.equal(execution.commands[0].session_files.length, 1);
                }
                assert.ok(body.includes("[REDACTED]")); assert.doesNotMatch(body, /hidden-sdk-source-token|hidden-prefix-sdk-token/);
              }
              for (const [index, stateDir] of stateDirs.entries()) {
                const handled = JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"));
                assert.equal(handled.run_instance_id, generations[index]);
              }
            }
            if (!candidate && mode === "tools" && request === 3) {
              const latest = [...context.messages].reverse().find(message => message.role === "toolResult");
              assert.equal(latest.toolName, "read"); assert.notEqual(latest.isError, true);
              assert.deepEqual(terminalReadEvents, [{ path: terminalSelection.path, offset: 1, limit: 2000 }]);
              const body = latest.content.filter(part => part.type === "text").map(part => part.text).join("\n"), result = JSON.parse(body);
              assert.equal(result.run_instance_id, terminalSelection.run_instance_id); assert.equal(result.code, 0); assert.equal(result.terminal_acceptance, "natural");
              const parts = context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
                : (message.content ?? []).flatMap(part => part.type === "text" ? [part.text] : []));
              assert.equal(parts.find(completionPacket), terminalBatchText, "A tool continuation must reuse the exact frozen terminal packet");
              terminalResearch = { ...terminalSelection, actual_read: terminalReadEvents[0],
                parsed_json_sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"), frozen_packet_reused: true };
            }
            const tools = overflowMode ? request <= overflowCount : request === 1;
            const readTerminal = !candidate && mode === "tools" && request === 2;
            const restore = lossMode && request === 3;
            return {
              role: "assistant", api: model.api, provider: model.provider, model: model.id,
              content: tools ? [
                { type: "toolCall", id: `fixture-spawn-${request}`, name: "spawn", arguments: spawnArgs(request - 1) },
                ...(!candidate && mode === "tools" ? [{ type: "toolCall", id: "fixture-call-1", name: "finish_fixture", arguments: { index: 1 } }] : []),
              ] : readTerminal ? [{ type: "toolCall", id: "fixture-terminal-read", name: "read", arguments: { path: terminalSelection.path, offset: 1, limit: 2000 } }]
                : restore ? [{ type: "toolCall", id: "fixture-restore-sources", name: "restore_fixture_sources", arguments: {} }]
                : [{ type: "text", text: request < completionRequest ? "Initial answer" : "Completion results integrated" }],
              stopReason: tools || restore || readTerminal ? "toolUse" : "stop", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
          })().catch(error => { if (!providerFailed) { providerError = error; providerFailed = true; } throw error; });
          return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: "done", reason: message.stopReason, message }; }, result: () => result };
        },
      });
      pi.registerTool({
        name: "finish_fixture", label: "Finish fixture", description: "Complete an isolated legacy companion Run",
        parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
        execute: async (_id, { index }) => { assert.equal(index, 1); await complete(index); toolExecutions++; return { content: [{ type: "text", text: "Fixture done" }], details: {} }; },
      });
      if (lossMode) pi.registerTool({
        name: "restore_fixture_sources", label: "Restore fixture sources", description: "Move original parked fixture sources back without changing the captured packet",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          assert.equal(parkedSources.length, 3); assert.equal(lossBatchContexts.length, 1);
          for (const source of parkedSources) {
            await assert.rejects(lstat(source.reference.path), { code: "ENOENT" });
            await rename(source.parked, source.reference.path);
            assert.equal(await readRetainedText(source.reference, source.bytesTotal), source.body); restoredSources++;
          }
          toolExecutions++;
          return { content: [{ type: "text", text: "Fixture originals restored; prior captured outcome remains unchanged" }], details: {} };
        },
      });
      pi.on("turn_end", event => ({ entries: [...event.entries, { type: "custom", customType: "fixture-before-actors" }] }));
      (candidate ? ports => candidateActors(ports, candidateCaptures) : actors)({ ...pi,
        registerTool: definition => {
          if (definition.name !== "spawn") return pi.registerTool(definition);
          const spawnTool = { ...definition, execute: async (...args) => {
            assert.equal(launching, false, "This fixture issues one public launch per model request, never overlapping captures");
            launching = true; await persistCapture();
            let admission;
            if (mode === "overflow" && spawnCalls === 0 && requests.length === 1 && !eligibleAttemptConsumed) {
              eligibleAttemptConsumed = true;
              admission = armOriginalRunner(() => ({ channel: channel("child_process"), executable: process.execPath,
                runner: join(packageDir, "scripts/async-runner.mjs"), directory: join(agentDir, "tmp", "pi-actors", "runs", overflowName(0)),
                alias: overflowName(0), now: () => performance.now() }));
              originalObserverSlot = admission;
            }
            let reply;
            try { reply = await definition.execute(...args); }
            finally { admission?.endAdmission(); }
            // Capture the real public launch receipt before assertions or any awaited fixture operation.
            const run = { pid: reply.details?.pid, state_dir: reply.details?.state_dir, run: reply.details?.run,
              run_instance_id: reply.details?.run_instance_id, settled: false, mode, request: requests.length, index: spawnCalls };
            captureWorkFrame(run, ownerId);
            captured.push(run); modeRuns.push(run); currentRun = run; launching = false; await persistCapture();
            admission?.bind(run);
            assert.ok(Number.isSafeInteger(run.pid) && run.pid > 0 && typeof run.state_dir === "string" && typeof run.run_instance_id === "string");
            const index = overflowMode ? spawnCalls : 0;
            markTiming("spawn_return");
            stateDirs[index] = run.state_dir; generations[index] = run.run_instance_id; spawnCalls++;
            const expertActions = ["recipe", "trace", "control"].map(view => `inspect target=run:${run.run} view=${view}`);
            assert.deepEqual(reply.details.next_actions, [...expertActions, "inspect target=runtime view=runs verbose=true"], "Expert actions remain alongside optional fresh-session navigation");
            const receipt = reply.content.filter(part => part.type === "text").map(part => part.text).join("\n");
            assert.ok(receipt.startsWith("\n")); assert.equal(receipt.startsWith("\n\n"), false);
            const launchDocument = mode === "final" ? undefined : parseDocument(receipt, { version: "1.2", schema: "core", uniqueKeys: true });
            if (launchDocument) assert.deepEqual(launchDocument.errors, [], "Compact launch metadata is one bare YAML document");
            const launchMetadata = launchDocument?.toJS();
            const navigation = reply.details.file_navigation;
            assert.ok(navigation && ["available", "unavailable"].includes(navigation.state));
            if (navigation.state === "available") {
              launchNavigationShown++;
              assert.equal(navigation.run, run.run); assert.equal(navigation.run_instance_id, run.run_instance_id);
              assert.equal(navigation.directory, run.state_dir); assert.equal(navigation.content_scope, "file_locations_only");
              assert.equal(navigation.file_inventory_scope, "canonical_starting_locations"); assert.equal(navigation.files.length, 9);
              assert.equal(navigation.files.find(file => file.role === "metadata")?.path, join(run.state_dir, "run.json"));
              if (mode !== "final") {
                assert.deepEqual(launchMetadata.run_files, navigation, "Actual compact YAML receipt carries every selected starting-location value");
                assert.equal(launchMetadata.run_files_observation, "Observed locations; mutable.");
                assert.equal(literalBlocks(receipt).length, 0, "Launch metadata has no object-JSON fence or completion Markdown body");
              }
            } else {
              launchNavigationUnavailable++;
              assert.deepEqual(Object.keys(navigation).sort(), ["reason", "state"]);
            }
            if (mode !== "final") {
              assert.equal(launchMetadata.run, run.run); assert.equal(launchMetadata.launch_kind, "spawn");
              assert.equal(launchMetadata.pid, run.pid); assert.doesNotMatch(receipt, /next=|inspect_target=|view[:=] ?recipe|view[:=] ?trace|view[:=] ?control/);
              const directLocationsShown = navigation.state === "available" && launchMetadata.run_files?.state === "available";
              if (directLocationsShown) assert.equal(Object.hasOwn(launchMetadata, "next"), false,
                "Complete direct launch locations replace the redundant map hint");
              else assert.deepEqual(launchMetadata.next, { tool: "inspect", target: "runtime", view: "runs", verbose: true },
                "Absent/unavailable/omitted rows retain exactly one native fallback node");
            } else {
              // Fresh full success is native block YAML, never legacy JSON or an unavailable projection.
              const expected = JSON.parse(JSON.stringify(reply.details));
              const document = parseDocument(receipt, { version: "1.2", schema: "core", uniqueKeys: true });
              assert.deepEqual(document.errors, []); assert.deepEqual(document.warnings, []);
              assert.notEqual(document.directives.docStart, true); assert.notEqual(document.directives.docEnd, true);
              assert.notEqual(document.directives.yaml.explicit, true);
              visit(document, {
                Node(_key, node) {
                  assert.equal(node.tag, undefined); assert.equal(node.anchor, undefined);
                  if (Array.isArray(node.items) && node.items.length)
                    assert.notEqual(node.flow, true, "Fresh full metadata rejects nonempty flow collections, including JSON");
                },
                Alias() { assert.fail("Fresh full metadata has no aliases"); },
              });
              assert.deepEqual(document.toJS({ maxAliasCount: 0 }), expected, "Full YAML preserves exactly the JSON-selected details");
              assert.equal(receipt, "\n" + oracleYaml(expected),
                "One separator LF, bare canonical metadata only; no frontmatter, whole fence or authored body");
            }
            // Tools-mode alone waits for producer exit to fix boundary ordering; the public reply stays unchanged.
            if (mode === "tools") { await waitForWorkReadiness(run, ownerId, failureMode ? 7 : 0); await settle(run); await readOutcome(run); }
            toolExecutions++;
            return reply;
          } };
          return pi.registerTool(spawnTool);
        },
        on: (name, handler) => {
          if (name === "session_shutdown") shutdown = handler;
          return pi.on(name, (event, ctx) => { if (name === "session_start") startContext = ctx; return handler(event, ctx); });
        },
        sendMessage: (...args) => { sends++; return pi.sendMessage(...args); },
      });
      if (!candidate && mode === "tools") pi.on("context", event => {
        for (const message of event.messages) if (message.customType === "pi-actors-run-batch") defaultContexts.push(structuredClone(message));
      }); // Passive AFTER actors; no replacement return and no capture dependency injection.
      if (candidate) pi.on("context", event => {
        for (const message of event.messages) if (message.customType === "pi-actors-run-batch") candidateContexts.push(structuredClone(message));
      }); // Passive observer AFTER actors, with no replacement return.
      pi.on("turn_end", event => { assert.ok(event.entries.some(entry => entry.customType === "fixture-before-actors")); });
      pi.on("agent_start", () => { starts++; }); pi.on("agent_settled", () => { settled++; });
    }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  let { session } = await createAgentSession({ cwd: agentDir, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: manager, model, thinkingLevel: "off" });
  let primaryError; let primaryFailed = false;
  let unlisten = session.subscribe(event => {
    if (event.type === "tool_execution_start" && event.toolName === "read") {
      const args = structuredClone(event.args); terminalReadEvents.push(args);
      terminalReads.push({ mode, owner: manager.getSessionId(), args });
    }
  });
  try {
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    session.setActiveToolsByName(["spawn", "finish_fixture", ...(mode === "tools" ? ["read"] : []), ...(lossMode ? ["restore_fixture_sources"] : [])]);
    markTiming("prompt");
    try {
      await session.prompt(mode === "tools" ? "Launch the completion-boundary fixture, then investigate its result once using a delivered terminal location. Do not poll or inspect status."
        : "Launch the public spawn completion-boundary fixture.");
    } catch (error) { if (providerFailed) throw providerError; throw error; }
    markTiming("settle");
    if (providerFailed) throw providerError;
    assert.deepEqual(errors, []);
    assert.equal(requests.length, completionRequest, JSON.stringify({ mode, toolExecutions, spawnCalls,
      captures: captured.map(run => ({ settled: run.settled, pid: run.pid })) }));
    assert.equal(starts, 1); assert.equal(settled, 1);
    assert.equal(sends, 0, "Active completion delivery must not use native sendMessage queues");
    const batches = manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "pi-actors-run-batch");
    assert.equal(batches.length, 1); assert.equal(session.getLastAssistantText(), "Completion results integrated");
    if (lossMode) { assert.equal(lossBatchContexts.length, 2); assert.equal(batches[0].content, lossBatchContexts[0]); }
    assert.equal(terminalReadEvents.length, !candidate && mode === "tools" ? 1 : 0); if (!candidate && mode === "tools") assert.ok(terminalResearch);
    if (!candidate && mode === "tools") {
      const entry = batches[0];
      assert.equal(entry.content, terminalBatchText);
      assert.equal(defaultContexts.length, 2, "Initial result and existing selective-read continuation, not extra requests");
      for (const observed of defaultContexts) {
        assert.equal(observed.content, entry.content); assert.deepEqual(observed.details, entry.details);
      }
      assert.deepEqual(entry.details.pi_actors_presentation, { format: "completion_yaml_core_v1", content_sha256: digest(entry.content) });
      const core = completionCore(entry.content); assert.equal(entry.details.pi_actors_delivery.batch_id, core.batchId);
      terminalResearch.defaultProof = { route: "unchanged-index-no-capture-DI", storage: "in-memory-branch-not-disk-reopen",
        batch_id: core.batchId, content_sha256: digest(entry.content), native_entry_sha256: digest(JSON.stringify(entry)),
        context_observations: defaultContexts.length, added_sdk_sessions: 0, added_provider_requests: 0, added_public_runs: 0 };
    }
    if (candidate) {
      const entry = batches[0], file = manager.getSessionFile(); assert.ok(file);
      assert.equal(entry.content, candidateText); assert.deepEqual(entry.details, candidateContexts.at(-1).details);
      assert.deepEqual(entry.details.pi_actors_presentation, { format: "completion_yaml_core_v1", content_sha256: digest(candidateText) });
      assert.equal(entry.details.pi_actors_delivery.batch_id, candidateCaptures[0].batch.batch_id);
      const diskEntries = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const disk = diskEntries.filter(row => row.type === "custom_message" && row.customType === entry.customType);
      assert.deepEqual(disk, [entry], "Actual SDK disk content AND details, not a manually appended source");
      const journalBefore = await readFile(candidateEvidence.journal_path);
      const journal = JSON.parse(journalBefore); assert.equal(journal.owner_id, ownerId);
      assert.equal(journal.completion_batch, undefined);
      assert.deepEqual(journal.receipts.map(row => [row.kind, row.delivery_id]), [["completion_batch", candidateCaptures[0].batch.batch_id]]);
      assert.equal(typeof journal.receipts[0].presented_at, "string");
      assert.equal(candidateCaptures.length, 1);
      assert.equal(candidateContexts.length, 1); assert.equal(candidateProviders.length, 1);
      initTheme("dark");
      const renderer = session.extensionRunner.getMessageRenderer(entry.customType); assert.equal(typeof renderer, "function");
      const rendererInputs = [], rendererObservations = [];
      const descendants = value => [value, ...(value.children ?? []).flatMap(descendants)];
      const record = candidateRecord(entry.content, candidateCaptures[0].batch.batch_id);
      const expectedBody = record.blocks.filter(block => block.kind === "body").map(block => block.text).join("").replaceAll(/\r\n|\r/gu, "\n");
      const component = new CustomMessageComponent(entry, (message, options, theme) => {
        rendererInputs.push(structuredClone(message));
        const original = renderer(message, options, theme);
        // Diagnostic native descendants, not a public SDK introspection contract.
        const nodes = descendants(original), markdown = nodes.filter(node => node.constructor.name === "Markdown");
        rendererObservations.push({ expanded: options.expanded, markdown_bodies: markdown.length,
          text_nodes: nodes.filter(node => node.constructor.name === "Text").length,
          body_sha256: markdown.length === 1 ? digest(markdown[0].text) : null,
          expanded_text_sha256: options.expanded && original.constructor.name === "Text" ? digest(stripTerminalSequences(original.text)) : null });
        return original; // NEVER replace the actual registered native component.
      });
      assert.ok(component.render(72).length); component.invalidate(); assert.ok(component.render(52).length);
      component.setExpanded(true); assert.ok(component.render(52).length);
      assert.ok(rendererInputs.length > 0); assert.equal(rendererInputs[0].content, entry.content);
      assert.deepEqual(rendererInputs[0].details, entry.details);
      // Assert OUTSIDE the SDK callback: its native fallback catches renderer throws.
      assert.deepEqual(rendererObservations.map(row => row.expanded), [false, false, true]);
      assert.deepEqual(rendererObservations.map(row => row.markdown_bodies), [1, 1, 0]);
      assert.deepEqual(rendererObservations.map(row => row.body_sha256), [digest(expectedBody), digest(expectedBody), null]);
      assert.ok(rendererObservations.every(row => row.text_nodes > 0));
      assert.equal(rendererObservations[2].expanded_text_sha256, digest(entry.content.replaceAll(/\r\n|\r/gu, "\n")));
      await shutdown({ type: "session_shutdown", reason: "quit" }, startContext);
      session.dispose(); unlisten(); unlisten = () => {};
      manager = SessionManager.open(file); assert.equal(manager.getSessionId(), ownerId);
      assert.deepEqual(manager.getBranch().filter(row => row.type === "custom_message" && row.customType === entry.customType), [entry]);
      await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: agentDir, agentDir, resourceLoader: loader, settingsManager: settings,
        sessionManager: manager, model, thinkingLevel: "off" }));
      await session.bindExtensions({ onError: error => errors.push(error.error) });
      session.setActiveToolsByName([]);
      try { await session.prompt("Continue from the saved completion without launching or reading anything."); }
      catch (error) { if (providerFailed) throw providerError; throw error; }
      assert.deepEqual(errors, []); assert.equal(requests.length, 3); assert.equal(spawnCalls, 1);
      assert.equal(candidateCaptures.length, 1); assert.equal(candidateContexts.length, 2); assert.equal(candidateProviders.length, 2);
      assert.equal(candidateContexts[1].content, entry.content); assert.deepEqual(candidateContexts[1].details, entry.details);
      assert.equal(sends, 0); assert.deepEqual(await readFile(candidateEvidence.journal_path), journalBefore);
      assert.deepEqual(manager.getBranch().filter(row => row.type === "custom_message" && row.customType === entry.customType), [entry]);
      candidateEvidence = { ...candidateEvidence, layout, profile, composition: "privileged-fourth-capture-port-not-default-entrypoint",
        owner: ownerId, session_file: file, native_entry_sha256: digest(JSON.stringify(entry)), session_file_sha256: digest(await readFile(file)),
        capture_count: candidateCaptures.length, native_entries: disk.length, context_count: candidateContexts.length,
        provider_count: candidateProviders.length, renderer_calls: rendererInputs.length, renderer_observations: rendererObservations,
        reopened: true, journal_sha256: digest(journalBefore), capture_journal_sha256: digest(JSON.stringify(candidateCaptures[0].journal)),
        component: "public-manual-native-not-interactive", frame: { ...currentRun } };
      await writeFile(join(agentDir, "candidate-witness.json"), JSON.stringify(candidateEvidence));
    }
    reports.push({ mode, requests: requests.length, starts, settled, batches: batches.length, nativeSends: sends, toolExecutions, publicSpawns: spawnCalls, launchNavigationShown, launchNavigationUnavailable,
      ...(candidate ? { candidate: candidateEvidence } : {}), ...(terminalResearch ? { terminalResearch } : {}),
      ...(mode === "primary-overflow" ? { primarySourcesRecovered, omittedPrimarySourcesRecovered } : {}),
      ...(rowLimitMode ? rowLimitEvidence : {}), ...(failureMode ? failureEvidence : {}), ...(artifactMode ? artifactEvidence : {}),
      ...(lossMode ? { missingSources: parkedSources.length, restoredSources, reusedBatchContexts: lossBatchContexts.length } : {}) });
  } catch (error) { primaryError = error; primaryFailed = true; throw error; }
  finally {
    const cleanupErrors = [];
    try { await writeFile(gate, "release"); } catch (error) { cleanupErrors.push(error); }
    try { for (const run of captured) { try { await settle(run); } catch (error) { cleanupErrors.push(error); } } }
    finally { originalObserverSlot?.dispose(); }
    try { if (shutdown && startContext) await shutdown({ type: "session_shutdown", reason: "quit" }, startContext); }
    catch (error) { cleanupErrors.push(error); }
    try { session.dispose(); } catch (error) { cleanupErrors.push(error); }
    try { unlisten(); } catch (error) { cleanupErrors.push(error); }
    try { await persistCapture(); } catch (error) { cleanupErrors.push(error); }
    if (launching || captured.some(run => !run.settled)) {
      throw new AggregateError([...(primaryFailed ? [primaryError] : []), ...cleanupErrors], "Captured fixture runner exit remains unproven; retaining state");
    }
    if (cleanupErrors.length) throw new AggregateError([...(primaryFailed ? [primaryError] : []), ...cleanupErrors], "Fixture shutdown failed after proven producer exit");
  }
}
console.log(JSON.stringify(reports));
