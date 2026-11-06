/**
 * Run result-producer admission and natural terminal publication.
 * Owns: producer authority, work/scoped evidence admission, first-result source bindings and natural-acceptance timing eligibility.
 * Excludes: workload execution, stop-request admission, process/tree proof, and delivery.
 */

import type { ChildProcess } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { types as UtilTypes } from "node:util";

import { readPendingCommandSpawnAdmission, requireFreshManagedCommandAttempt, requireNativeCommandAttemptClose, type CommandTemplateAttemptReceipt, type CommandTemplateManagedAttempt, type CommandTemplateSpawnAdmission } from "./command-templates.ts";
import { writeJsonAtomic } from "./file-state.ts";
import { assertRunDescendantPreparedMetadata, readRunDescendantLaunchLedger, readRunDescendantPreparation, recordRunDescendantLaunchIntentUnderLock, resolveRunDescendantLaunchTarget, type RunDescendantLaunchIntent, type RunDescendantLaunchRequest } from "./runs-descendant-launches.ts";
import { recordRunNativeLaunchBirthUnderLock, recordRunNativeLaunchIntentUnderLock, recordRunNativeLaunchSettlementUnderLock, type RunNativeLaunchBirth, type RunNativeLaunchIntent, type RunNativeLaunchRequest, type RunNativeLaunchCloseSettlement } from "./runs-native-launches.ts";
import { readRunNaturalOutcome, readRunStopClaim, RUN_OUTCOME_PROTOCOL, RUN_PRIMARY_TEXT_PROTOCOL, RUN_ARTIFACT_INVENTORY_PROTOCOL, decodeRunPrimaryTextBinding, decodeRunArtifactInventoryBinding, RUN_RESULT_DIAGNOSTICS_PROTOCOL, RUN_RESULT_DIAGNOSTIC_FIELDS, decodeRunResultDiagnosticsBinding, type RunResultDiagnosticCandidate, type RunResultDiagnosticsBinding, type RunPrimaryTextBinding, type RunArtifactInventoryBinding } from "./runs-outcomes.ts";
import { assertDistinctRunStateDirectories, assertOwnedRunStateDirectory, readOwnedRunStateDirectory } from "./runs-ownership.ts";
import { captureSpawnedNativeProcessIdentity, runProcessIdentityDigest, verifyRunProcessIdentity, type RunProcessIdentity, type SpawnIdentityCaptureDeps } from "./runs-process.ts";
import { acquireStateStartLock } from "./runs-start.ts";
import { appendRunTraceEvent, type AppendTraceEventInput } from "./runs-trace.ts";

export interface RunResultProducer {
  readonly run: string;
  readonly runInstanceId: string;
  readonly ownerId?: string;
  readonly pid: number;
  readonly processIdentityDigest?: string;
}

const admittedProducers = new WeakMap<RunResultProducer, string>();

/** Immutable admission capture, copied on read. Metadata cannot reconstruct its genuine producer key. */
export function readRunProducerCapturedMetadata(producer: RunResultProducer, maxBytes: number): Record<string, unknown> | undefined {
  const captured = admittedProducers.get(producer);
  if (captured === undefined) throw new Error("Run producer requires an identity admitted by this runtime.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Run producer metadata read budget is invalid.");
  return Buffer.byteLength(captured) <= maxBytes ? JSON.parse(captured) as Record<string, unknown> : undefined;
}

export interface RunProducerCleanupFailure {
  readonly status: "release_unproven";
  readonly error_code: string;
}

const cleanupFailures = new WeakMap<RunResultProducer, RunProducerCleanupFailure>();

/** Runtime-local diagnostics only; absence is not proof that a lifecycle lock was released. */
export function readRunProducerCleanupFailure(producer: RunResultProducer): Readonly<RunProducerCleanupFailure> | undefined {
  return cleanupFailures.get(producer);
}

function requireProducerCleanupAvailable(producer: RunResultProducer): void {
  if (cleanupFailures.has(producer)) throw new Error("Run producer lifecycle cleanup remains unproven.");
}

function retainProducerCleanupFailure(producer: RunResultProducer, error: unknown): void {
  if (cleanupFailures.has(producer)) return;
  let code = "UNKNOWN";
  try {
    const value = (error as NodeJS.ErrnoException)?.code;
    if (typeof value === "string" && /^[A-Z0-9_]{1,64}$/.exec(value)?.[0] === value) code = value;
  } catch { /* An error getter must not replace the protected factory outcome. */ }
  cleanupFailures.set(producer, Object.freeze({ status: "release_unproven", error_code: code }));
  try { console.error("Run producer lifecycle cleanup failed; release remains unproven and further producer operations are fenced."); }
  catch { /* Diagnostics must not replace the protected factory outcome. */ }
}

/** Kernel lifecycle composition only; a child preparation's cleanup failure fences its genuine parent producer. */
export function reportRunProducerCleanupFailure(producer: RunResultProducer, error: unknown): void {
  if (!admittedProducers.has(producer)) throw new Error("Run producer requires an identity admitted by this runtime.");
  retainProducerCleanupFailure(producer, error);
}

/** Refuse deferred kernel completions without awaiting or reading custom then/catch properties. */
function requireSynchronousResultCallback(value: unknown, message: string): void {
  if (UtilTypes.isPromise(value)) {
    void Promise.prototype.then.call(value, undefined, () => {});
    throw new Error(message);
  }
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) throw new Error(message);
}

/** Opaque, synchronous first-result source admission; copied markers cannot recreate it. */
export interface RunResultDiagnosticsAdmission { readonly kernel_only: true }
const diagnosticAdmissions = new WeakMap<RunResultDiagnosticsAdmission, { stateDir: string; producer: RunResultProducer; candidate: RunResultDiagnosticCandidate }>();

/** Runtime-local timing eligibility only; the marker/serialized data is not authority. */
export interface RunNaturalResultTimingAdmission { readonly kernel_only: true }
export interface RunNaturalResultTimingAcceptance {
  readonly state: "available";
  readonly identity: Readonly<{ run: string; run_instance_id: string; ownerId?: string }>;
  readonly code: number;
  readonly recorded_status: "done" | "failed";
  readonly completed_at: string;
  readonly acceptance: "natural";
  readonly timing: "not_asserted";
}
export type RunNaturalResultTimingAcceptanceReading = Readonly<RunNaturalResultTimingAcceptance> |
  { readonly state: "unavailable"; readonly reason: "admission_invalid" | "admission_mismatch" };
interface NaturalTimingAdmission {
  readonly stateDir: string;
  readonly producer: RunResultProducer;
  readonly acceptance: Readonly<RunNaturalResultTimingAcceptance>;
  active: boolean;
}
const naturalTimingAdmissions = new WeakMap<RunNaturalResultTimingAdmission, NaturalTimingAdmission>();

export interface RunResultPublicationOptions {
  /** Invocation-local trusted kernel port; source preparation/publication must already be complete. */
  primaryText?: () => Readonly<RunPrimaryTextBinding>;
  /** Kernel-captured metadata source, prepared before result admission; never an actor result field. */
  artifactInventory?: () => Readonly<RunArtifactInventoryBinding>;
  /** First-winner source publication only, with a runtime-local candidate admission under the existing lock. */
  resultDiagnostics?: (admission: RunResultDiagnosticsAdmission) => Readonly<RunResultDiagnosticsBinding>;
  /** Natural-only postcommit event, before Trace. No clock/origin/sample, body, work or frozen timing authority. */
  naturalResultTiming?: (admission: RunNaturalResultTimingAdmission) => void;
  /** Synchronous evidence updates, only after producer and first-result admission. */
  prepare?: (context: { stopping: boolean }) => void;
  trace?: AppendTraceEventInput;
  /** Contention instrumentation must not mutate Run state before revalidation. */
  onLockContention?: () => void;
}

function requireIdentity(identity: RunResultProducer): void {
  if (!identity || typeof identity.run !== "string" || !identity.run ||
    typeof identity.runInstanceId !== "string" || !identity.runInstanceId) {
    throw new Error("Run result publication requires a captured Run and generation.");
  }
}

function requireNoNativeProducerContradiction(meta: Record<string, unknown>): void {
  const proof = verifyRunProcessIdentity(process.pid, meta.process_identity as RunProcessIdentity | undefined);
  if (proof.status === "owner_mismatch" || proof.status === "dead_pid") {
    throw new Error("Run result producer process identity changed.");
  }
  // Unavailable native proof preserves exact self-PID legacy binding, never forced-stop authority.
}

function readProducerMeta(stateDir: string, run: string): Record<string, unknown> {
  const canonical = assertOwnedRunStateDirectory(stateDir, run);
  const path = join(canonical, "run.json");
  let meta: unknown;
  try {
    if (!lstatSync(path).isFile()) throw new Error("Not a regular metadata file.");
    meta = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Run result producer metadata is unavailable or invalid.");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Run result producer metadata is unavailable or invalid.");
  }
  const record = meta as Record<string, unknown>;
  if (record.run !== run || record.state_dir !== canonical) {
    throw new Error("Run result producer state identity changed.");
  }
  if (typeof record.run_instance_id !== "string" || !record.run_instance_id ||
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
    (record.ownerId !== undefined && (typeof record.ownerId !== "string" || !record.ownerId))) {
    throw new Error("Run result producer identity is unavailable or invalid.");
  }
  return record;
}

function readCapturedProducerMeta(stateDir: string, producer: RunResultProducer): Record<string, unknown> {
  const meta = readProducerMeta(stateDir, producer.run);
  if (meta.run_instance_id !== producer.runInstanceId) throw new Error("Run result producer generation changed.");
  if (meta.ownerId !== producer.ownerId) throw new Error("Run result producer owner changed.");
  if (meta.pid !== producer.pid || producer.pid !== process.pid) {
    throw new Error("Run result producer process changed.");
  }
  if (runProcessIdentityDigest(meta.process_identity) !== producer.processIdentityDigest) {
    throw new Error("Run result producer process identity changed.");
  }
  if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL) throw new Error("Run outcome protocol changed.");
  return meta;
}

function assertRunWorkAdmitted(stateDir: string, meta: Record<string, unknown>): void {
  const stop = readRunStopClaim(stateDir, meta);
  if (stop.state === "pending" || stop.state === "invalid") {
    throw new Error("Run work admission is stopping or unproven.");
  }
  try {
    lstatSync(join(stateDir, "result.json"));
    throw new Error("Run work admission is terminal or unproven.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function admitRunResultProducer(
  stateDir: string,
): { meta: Record<string, unknown>; producer: RunResultProducer } {
  const release = acquireStateStartLock(stateDir);
  try {
    const owned = readOwnedRunStateDirectory(stateDir);
    const meta = readProducerMeta(owned.stateDir, owned.run);
    if (meta.pid !== process.pid) throw new Error("Run result producer process changed.");
    requireNoNativeProducerContradiction(meta);
    assertRunWorkAdmitted(owned.stateDir, meta);
    if (meta.outcome_protocol === undefined) {
      // A cached host may use the unchanged CLI; bind the protocol before any workload starts.
      meta.outcome_protocol = RUN_OUTCOME_PROTOCOL;
      writeJsonAtomic(join(owned.stateDir, "run.json"), meta);
    }
    if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL) throw new Error("Run outcome protocol is unsupported.");
    const processIdentityDigest = runProcessIdentityDigest(meta.process_identity);
    const producer = Object.freeze({
      run: owned.run,
      runInstanceId: String(meta.run_instance_id),
      ...(typeof meta.ownerId === "string" ? { ownerId: meta.ownerId } : {}),
      pid: process.pid,
      ...(processIdentityDigest ? { processIdentityDigest } : {}),
    });
    admittedProducers.set(producer, JSON.stringify(meta));
    return { meta, producer };
  } finally {
    release();
  }
}

function withAdmittedProducer<T>(
  stateDir: string,
  producer: RunResultProducer,
  action: (meta: Record<string, unknown>) => T,
  options: Pick<RunResultPublicationOptions, "onLockContention">,
): T {
  requireIdentity(producer);
  if (!admittedProducers.has(producer)) throw new Error("Run producer requires an identity admitted by this runtime.");
  requireProducerCleanupAvailable(producer);
  const release = acquireStateStartLock(stateDir, { onContention: options.onLockContention });
  try {
    return action(readCapturedProducerMeta(stateDir, producer));
  } finally {
    try { release(); }
    catch (error) { retainProducerCleanupFailure(producer, error); }
  }
}

const activeWorkAdmissions = new WeakMap<RunResultProducer, string>();

/** Revalidate only inside this producer's exact synchronous work callback; never a new work permission. */
export function revalidateRunWorkAdmission(stateDir: string, producer: RunResultProducer): void {
  if (activeWorkAdmissions.get(producer) !== stateDir) {
    throw new Error("Run work revalidation requires its active runtime-local admission.");
  }
  requireProducerCleanupAvailable(producer);
  assertRunWorkAdmitted(stateDir, readCapturedProducerMeta(stateDir, producer));
}

/**
 * Synchronous kernel preparation/native launch only. Never await workload or inference under this lock.
 * Runtime-local authority retains its native fingerprint without OS reprobes; a live self-PID cannot recycle.
 * Separate child-Run admission and complete owned-scope receipts remain with their lifecycle owners.
 */
export function withRunWorkAdmission<T>(
  stateDir: string,
  producer: RunResultProducer,
  admit: () => T,
  options: Pick<RunResultPublicationOptions, "onLockContention"> = {},
): T {
  return withAdmittedProducer(stateDir, producer, (meta) => {
    assertRunWorkAdmitted(stateDir, meta);
    const previous = activeWorkAdmissions.get(producer);
    activeWorkAdmissions.set(producer, stateDir);
    try { return admit(); }
    finally {
      if (previous === undefined) activeWorkAdmissions.delete(producer);
      else activeWorkAdmissions.set(producer, previous);
    }
  }, options);
}

/**
 * Declared intent only, not a child-start capability or membership receipt.
 * Run synchronous kernel preparation after persistence; never await workload/inference here.
 */
export function withRunDescendantIntentAdmission<T>(
  stateDir: string,
  producer: RunResultProducer,
  request: RunDescendantLaunchRequest,
  prepare: (intent: Readonly<RunDescendantLaunchIntent>) => T,
  options: Pick<RunResultPublicationOptions, "onLockContention"> = {},
): T {
  return withRunWorkAdmission(stateDir, producer, () => {
    const intent = recordRunDescendantLaunchIntentUnderLock(stateDir, producer, request);
    return prepare(intent);
  }, options);
}

export interface RunDescendantReconciliationResult {
  readonly status: "recorded" | "already_recorded";
  readonly intent: Readonly<RunDescendantLaunchIntent>;
}

/** Same-runtime evidence repair only: never spawn, reconstruct a producer, reopen work, or release scope fences. */
export function reconcileRunDescendantPreparation(
  stateDir: string,
  producer: RunResultProducer,
  request: RunDescendantLaunchRequest,
  options: Pick<RunResultPublicationOptions, "onLockContention"> = {},
): Readonly<RunDescendantReconciliationResult> {
  return withRunProducerEvidence(stateDir, producer, () => {
    const canonical = assertOwnedRunStateDirectory(stateDir, producer.run);
    const child = resolveRunDescendantLaunchTarget(request, producer, canonical);
    if (!child) throw new Error("Run descendant launch identity or request is invalid.");
    const readRecorded = () => {
      const reading = readRunDescendantLaunchLedger(canonical, producer);
      if (reading.state === "invalid") throw new Error("Run descendant launch evidence is unavailable or invalid.");
      const intent = reading.state === "available"
        ? reading.ledger.intents.find((item) => item.child.run_instance_id === child.run_instance_id) : undefined;
      if (intent && (intent.child.run !== child.run || intent.child.ownerId !== child.ownerId || intent.child.state_dir !== child.state_dir)) {
        throw new Error("Run descendant preparation target changed.");
      }
      return intent?.preparation ? intent : undefined;
    };
    const accepted = readRecorded();
    if (accepted) return Object.freeze({ status: "already_recorded", intent: accepted });
    assertDistinctRunStateDirectories(canonical, child.state_dir);
    assertRunDescendantPreparedMetadata(child.state_dir, child);
    const release = acquireStateStartLock(child.state_dir);
    try {
      requireProducerCleanupAvailable(producer);
      readProducerEvidenceStatus(stateDir, readCapturedProducerMeta(stateDir, producer));
      const existing = readRecorded();
      if (existing) return Object.freeze({ status: "already_recorded", intent: existing });
      const parent = { run: producer.run, run_instance_id: producer.runInstanceId,
        ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }), state_dir: canonical };
      const preparation = readRunDescendantPreparation(child.state_dir, child, parent);
      if (!preparation) throw new Error("Run descendant preparation binding changed or is unavailable.");
      const intent = recordRunDescendantLaunchIntentUnderLock(canonical, producer, {
        run: child.run, runInstanceId: child.run_instance_id, ownerId: child.ownerId, stateDir: child.state_dir,
      }, preparation);
      return Object.freeze({ status: "recorded", intent });
    } finally {
      try { release(); }
      catch (error) { retainProducerCleanupFailure(producer, error); }
    }
  }, options);
}

const activeNativeAdmissions = new WeakMap<RunNativeLaunchIntent, {
  stateDir: string;
  producer: RunResultProducer;
  spawnAdmission: CommandTemplateSpawnAdmission | undefined;
  attempted: boolean;
}>();
const observedNativeAttempts = new WeakSet<CommandTemplateManagedAttempt>();
const claimedNativeAdmissions = new WeakSet<CommandTemplateSpawnAdmission>();
const boundNativeMembers = new WeakMap<RunNativeLaunchIntent, {
  stateDir: string;
  producer: RunResultProducer;
  spawnAdmission: CommandTemplateSpawnAdmission;
  process: ChildProcess;
  birth: Readonly<RunNativeLaunchBirth>;
  attempted: boolean;
}>();

/** Called only by the executor's synchronous managed observer inside this native launch admission. */
export function bindRunNativeLaunchProcess(
  stateDir: string,
  producer: RunResultProducer,
  intent: Readonly<RunNativeLaunchIntent>,
  context: CommandTemplateManagedAttempt,
  deps: SpawnIdentityCaptureDeps = {},
): Readonly<RunNativeLaunchBirth> {
  const admission = activeNativeAdmissions.get(intent);
  if (!admission || !admission.spawnAdmission || admission.producer !== producer || admission.stateDir !== stateDir || admission.attempted) {
    throw new Error("Run native birth requires its active runtime-local launch admission.");
  }
  requireProducerCleanupAvailable(producer);
  admission.attempted = true;
  const managed = requireFreshManagedCommandAttempt(context, admission.spawnAdmission);
  if (managed.attempt !== intent.attempt || observedNativeAttempts.has(managed)) {
    throw new Error("Run native birth managed attempt changed or was already observed.");
  }
  observedNativeAttempts.add(managed);
  readCapturedProducerMeta(stateDir, producer);
  const identity = captureSpawnedNativeProcessIdentity(managed.process, deps);
  if (!identity) throw new Error("Run native launch process proof is unavailable.");
  readCapturedProducerMeta(stateDir, producer);
  requireFreshManagedCommandAttempt(context, admission.spawnAdmission);
  const birth = recordRunNativeLaunchBirthUnderLock(stateDir, producer, intent, {
    pid: managed.process.pid!, observed_at: new Date().toISOString(), process_identity: identity,
  });
  boundNativeMembers.set(intent, { stateDir, producer, spawnAdmission: admission.spawnAdmission, process: managed.process, birth, attempted: false });
  return birth;
}

/** Actual direct-process close only; recording while stopping never grants whole-scope terminal authority. */
export function recordRunNativeLaunchSettlement(
  stateDir: string,
  producer: RunResultProducer,
  intent: Readonly<RunNativeLaunchIntent>,
  receipt: CommandTemplateAttemptReceipt,
  options: Pick<RunResultPublicationOptions, "onLockContention"> = {},
): Readonly<RunNativeLaunchCloseSettlement> {
  const member = boundNativeMembers.get(intent);
  if (!member || member.stateDir !== stateDir || member.producer !== producer || member.attempted) {
    throw new Error("Run native settlement requires its runtime-local bound member.");
  }
  const close = requireNativeCommandAttemptClose(receipt, member.spawnAdmission, member.process);
  if (close.pid !== member.birth.pid || receipt.attempt !== intent.attempt) throw new Error("Run native settlement member changed.");
  member.attempted = true;
  return withRunProducerEvidence(stateDir, producer, () => {
    requireNativeCommandAttemptClose(receipt, member.spawnAdmission, member.process);
    return recordRunNativeLaunchSettlementUnderLock(stateDir, producer, {
      intent, birth: member.birth, settlement: {
        observed_at: new Date().toISOString(), native_exit_code: close.nativeExitCode, native_signal: close.nativeSignal,
      },
    });
  }, options);
}

/**
 * Private native launch primitive: retain admission before invoking the synchronous factory.
 * Journal writes precede the factory; lifecycle cleanup failure is retained separately, never replacing its outcome.
 * A throw retains uncertainty, never rollback or proof that no child was born.
 * Runner wiring requires crash/reuse fences and birth/member proof; this receipt alone grants no stop authority.
 */
export function withRunNativeLaunchAdmission(
  stateDir: string,
  producer: RunResultProducer,
  request: RunNativeLaunchRequest,
  start: (intent: Readonly<RunNativeLaunchIntent>) => ChildProcess,
  options: Pick<RunResultPublicationOptions, "onLockContention"> = {},
): ChildProcess {
  return withRunWorkAdmission(stateDir, producer, () => {
    const spawnAdmission = readPendingCommandSpawnAdmission();
    if (spawnAdmission) {
      if (claimedNativeAdmissions.has(spawnAdmission)) throw new Error("Run native spawn admission was already claimed.");
      claimedNativeAdmissions.add(spawnAdmission);
    }
    const intent = recordRunNativeLaunchIntentUnderLock(stateDir, producer, request);
    activeNativeAdmissions.set(intent, { stateDir, producer, spawnAdmission, attempted: false });
    try { return start(intent); }
    finally { activeNativeAdmissions.delete(intent); }
  }, options);
}

function readProducerEvidenceStatus(stateDir: string, meta: Record<string, unknown>): "running" | "stopping" | "done" | "failed" {
  const stop = readRunStopClaim(stateDir, meta);
  const outcome = readRunNaturalOutcome(stateDir, meta);
  if (outcome.state === "invalid") throw new Error("Run evidence state is unavailable or invalid.");
  return outcome.state === "accepted" ? outcome.status
    : stop.state === "pending" || stop.state === "invalid" || outcome.state === "captured" ? "stopping" : "running";
}

/** Synchronous evidence writes only, including while stopping; this never grants work or terminal authority. */
export function withRunProducerEvidence<T>(
  stateDir: string,
  producer: RunResultProducer,
  record: (context: { readonly status: "running" | "stopping" | "done" | "failed" }) => T,
  options: Pick<RunResultPublicationOptions, "onLockContention"> = {},
): T {
  return withAdmittedProducer(stateDir, producer, (meta) => {
    return record(Object.freeze({ status: readProducerEvidenceStatus(stateDir, meta) }));
  }, options);
}

/** Evidence only within the exact active first-result callback, never nested lock/work/result authority. */
export function withRunResultDiagnosticsAdmission<T>(stateDir: string, producer: RunResultProducer, admission: RunResultDiagnosticsAdmission,
  record: (candidate: RunResultDiagnosticCandidate) => T): T {
  const active = diagnosticAdmissions.get(admission);
  if (!active || active.stateDir !== stateDir || active.producer !== producer || !admittedProducers.has(producer)) {
    throw new Error("Run result diagnostics requires its active runtime-local admission.");
  }
  requireProducerCleanupAvailable(producer); requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
  const value = record(active.candidate);
  requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
  return value;
}

/** Exact active first-natural callback only; never reacquires the already-held lifecycle lock. */
export function withRunNaturalResultTimingAdmission<T>(stateDir: string, producer: RunResultProducer, admission: RunNaturalResultTimingAdmission,
  record: (acceptance: Readonly<RunNaturalResultTimingAcceptance>) => T): T {
  const active = naturalTimingAdmissions.get(admission);
  if (!active || !active.active || active.stateDir !== stateDir || active.producer !== producer || !admittedProducers.has(producer)) {
    throw new Error("Run natural result timing requires its active runtime-local admission.");
  }
  requireProducerCleanupAvailable(producer); requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
  const value = record(active.acceptance);
  requireSynchronousResultCallback(value, "Run natural result timing admission must complete synchronously.");
  requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
  return value;
}

/** Pure historical acceptance receipt, not a current-file/status fence, elapsed sample or timing authority. */
export function readRunNaturalResultTimingAcceptance(stateDir: string, producer: RunResultProducer, admission: unknown): Readonly<RunNaturalResultTimingAcceptanceReading> {
  const retained = naturalTimingAdmissions.get(admission as RunNaturalResultTimingAdmission);
  if (!retained) return Object.freeze({ state: "unavailable", reason: "admission_invalid" });
  if (retained.stateDir !== stateDir || retained.producer !== producer) return Object.freeze({ state: "unavailable", reason: "admission_mismatch" });
  return retained.acceptance;
}

export function publishRunResult(
  stateDir: string,
  producer: RunResultProducer,
  result: Record<string, unknown>,
  options: RunResultPublicationOptions = {},
): boolean {
  requireIdentity(producer);
  if (!admittedProducers.has(producer)) throw new Error("Run producer requires an identity admitted by this runtime.");
  requireProducerCleanupAvailable(producer);
  const code = result && typeof result === "object" ? Object.getOwnPropertyDescriptor(result, "code")?.value : undefined;
  if (!result || typeof result !== "object" || Array.isArray(result) || !Number.isSafeInteger(code)) {
    throw new Error("Run result code must be a safe integer.");
  }
  const release = acquireStateStartLock(stateDir, { onContention: options.onLockContention });
  try {
    const meta = readCapturedProducerMeta(stateDir, producer);
    requireNoNativeProducerContradiction(meta);
    const stop = readRunStopClaim(stateDir, meta);
    if (stop.state === "invalid") throw new Error("Run stop state is unavailable or invalid.");
    const path = join(stateDir, "result.json");
    try {
      if (!lstatSync(path).isFile()) throw new Error("Run result path is not a regular file.");
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const descriptors = Object.getOwnPropertyDescriptors(result);
    if (Object.values(descriptors).some(field => field.enumerable && !Object.hasOwn(field, "value"))) throw new Error("Run result fields must be data properties.");
    const input = Object.fromEntries(Object.entries(descriptors).filter(([, field]) => field.enumerable).map(([key, field]) => [key, field.value]));
    if (typeof input.toJSON === "function") throw new Error("Run result serialization must preserve its data fields.");
    const { stop_claim_id: _claim, terminal_acceptance: _acceptance, output: _output, output_unavailable: _unavailable, primary_text_protocol: _primaryProtocol,
      artifact_inventory: _inventory, artifact_inventory_unavailable: _inventoryUnavailable, artifact_inventory_protocol: _inventoryProtocol,
      result_diagnostics: _diagnostics, result_diagnostics_unavailable: _diagnosticsUnavailable, result_diagnostics_protocol: _diagnosticsProtocol, ...fields } = input;
    const capture: Readonly<Record<string, unknown>> = Object.freeze({ ...fields, code });
    if (options.prepare) {
      requireSynchronousResultCallback(options.prepare({ stopping: stop.state === "pending" }), "Run result preparation must complete synchronously.");
      requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
    }
    let primary: Readonly<RunPrimaryTextBinding> | undefined;
    if (options.primaryText) {
      const value = options.primaryText();
      requireSynchronousResultCallback(value, "Run primary text binding must complete synchronously.");
      requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
      primary = decodeRunPrimaryTextBinding(stateDir, producer.runInstanceId, value);
    }
    let inventory: Readonly<RunArtifactInventoryBinding> | undefined;
    if (options.artifactInventory) {
      const value = options.artifactInventory();
      requireSynchronousResultCallback(value, "Run artifact inventory binding must complete synchronously.");
      requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
      inventory = decodeRunArtifactInventoryBinding(stateDir, producer.runInstanceId, value);
    }
    let diagnostics: Readonly<RunResultDiagnosticsBinding> | undefined;
    if (options.resultDiagnostics) {
      const candidate = Object.freeze(Object.fromEntries(RUN_RESULT_DIAGNOSTIC_FIELDS.flatMap(key => typeof capture[key] === "string" ? [[key, capture[key]]] : []))) as RunResultDiagnosticCandidate;
      const admission: RunResultDiagnosticsAdmission = Object.freeze({ kernel_only: true });
      diagnosticAdmissions.set(admission, { stateDir, producer, candidate });
      try {
        const value = options.resultDiagnostics(admission);
        requireSynchronousResultCallback(value, "Run result diagnostics binding must complete synchronously.");
        requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
        diagnostics = decodeRunResultDiagnosticsBinding(stateDir, producer.runInstanceId, value);
      } finally { diagnosticAdmissions.delete(admission); }
    }
    if (options.prepare || options.primaryText || options.artifactInventory || options.resultDiagnostics) requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
    const completedAt = new Date().toISOString();
    writeJsonAtomic(path, {
      ...capture,
      ...primary,
      ...(primary ? { primary_text_protocol: RUN_PRIMARY_TEXT_PROTOCOL } : {}),
      ...inventory,
      ...(inventory ? { artifact_inventory_protocol: RUN_ARTIFACT_INVENTORY_PROTOCOL } : {}),
      ...diagnostics,
      ...(diagnostics ? { result_diagnostics_protocol: RUN_RESULT_DIAGNOSTICS_PROTOCOL } : {}),
      run_instance_id: producer.runInstanceId,
      completedAt,
      ...(stop.state === "pending"
        ? { terminal_acceptance: "after_stop_claim", stop_claim_id: stop.claim.claim_id }
        : { terminal_acceptance: "natural" }),
    });
    if (stop.state !== "pending" && options.naturalResultTiming) {
      requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
      const admission: RunNaturalResultTimingAdmission = Object.freeze({ kernel_only: true });
      const identity = Object.freeze({ run: producer.run, run_instance_id: producer.runInstanceId,
        ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) });
      const acceptance: Readonly<RunNaturalResultTimingAcceptance> = Object.freeze({ state: "available", identity,
        code: code as number, recorded_status: code === 0 ? "done" : "failed", completed_at: completedAt, acceptance: "natural", timing: "not_asserted" });
      const retained: NaturalTimingAdmission = { stateDir, producer, acceptance, active: true };
      naturalTimingAdmissions.set(admission, retained);
      try {
        requireSynchronousResultCallback(options.naturalResultTiming(admission), "Run natural result timing observer must complete synchronously.");
        requireNoNativeProducerContradiction(readCapturedProducerMeta(stateDir, producer));
      } finally { retained.active = false; }
    }
    if (stop.state === "pending") {
      appendRunTraceEvent(stateDir, {
        kind: "run.result_captured",
        summary: "Captured workload result while stopping",
        data: { code, stop_claim_id: stop.claim.claim_id },
      });
    } else if (options.trace) appendRunTraceEvent(stateDir, options.trace);
    return true;
  } finally {
    try { release(); } catch (error) { retainProducerCleanupFailure(producer, error); }
  }
}
