/**
 * Async run process control primitives.
 * Owns: platform signalling, stop-request admission, evidence-only member/preparation recovery, and terminal control markers.
 * Excludes: deadline eligibility and proof of complete owned-scope termination.
 */

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import { readRunSupervisionClock } from "./run-supervision.ts";
import { assertRunDescendantPreparedMetadata, readRunDescendantLaunchLedger, readRunDescendantPreparation, recordRunDescendantLaunchIntentUnderLock, resolveRunDescendantLaunchTarget, type RunDescendantLaunchIntent, type RunDescendantLaunchOwner, type RunDescendantLaunchRequest } from "./runs-descendant-launches.ts";
import { readRunNativeLaunchLedger, recordRunNativeLaunchSettlementUnderLock, type RunNativeLaunchAbsenceSettlement, type RunNativeLaunchOwner, type RunNativeLaunchSettlement } from "./runs-native-launches.ts";
import {
  readRunNaturalOutcome,
  readRunStopClaim,
  RUN_OUTCOME_PROTOCOL,
  writeRunStopClaimUnderLock,
  type RunStopClaim,
  type RunStopReason,
} from "./runs-outcomes.ts";
import { assertDistinctRunStateDirectories, readOwnedRunStateDirectory } from "./runs-ownership.ts";
import { acquireStateStartLock } from "./runs-start.ts";
import { readJsonFileResilient } from "./state-readers.ts";
import {
  observeRunProcessExit,
  runProcessIdentityDigest,
  verifyRunProcessIdentity,
  type RunProcessExitDeps,
  type RunProcessIdentity,
  type RunProcessIdentityResult,
} from "./runs-process.ts";

export interface RunProcessSignalPlan {
  args?: string[];
  command?: string;
  signalTarget: "processGroup" | "process" | "processTree";
}

export function getRunProcessSignalPlan(
  pid: number,
  signal: NodeJS.Signals,
  runtimePlatform: NodeJS.Platform = process.platform,
): RunProcessSignalPlan {
  if (runtimePlatform === "win32") {
    return {
      args: [
        "/PID",
        String(pid),
        "/T",
        ...(signal === "SIGKILL" ? ["/F"] : []),
      ],
      command: "taskkill",
      signalTarget: "processTree",
    };
  }
  return { signalTarget: "processGroup" };
}

export interface RunProcessSignalDeps {
  killProcess?: typeof process.kill;
  runtimePlatform?: NodeJS.Platform;
  spawnProcess?: typeof spawnSync;
  verifyIdentity?: (
    pid: number,
    expected: RunProcessIdentity,
    runtimePlatform: NodeJS.Platform,
  ) => RunProcessIdentityResult;
}

export function signalOwnedRunProcess(
  pid: number,
  signal: NodeJS.Signals,
  expectedIdentity?: RunProcessIdentity,
  deps: RunProcessSignalDeps = {},
): RunProcessSignalPlan {
  const runtimePlatform = deps.runtimePlatform ?? process.platform;
  if (expectedIdentity) {
    const proof = (deps.verifyIdentity ?? verifyRunProcessIdentity)(
      pid,
      expectedIdentity,
      runtimePlatform,
    );
    if (!proof.valid) {
      throw new Error(
        `Run process identity changed before signaling: ${proof.status.replaceAll("_", " ")}`,
      );
    }
  }
  const plan = getRunProcessSignalPlan(pid, signal, runtimePlatform);
  if (plan.command && plan.args) {
    const spawnProcess = deps.spawnProcess ?? spawnSync;
    let result = spawnProcess(plan.command, plan.args, { encoding: "utf8" });
    if (
      runtimePlatform === "win32" &&
      result.status !== 0 &&
      !plan.args.includes("/F")
    ) {
      result = spawnProcess(plan.command, [...plan.args, "/F"], {
        encoding: "utf8",
      });
    }
    if (result.status !== 0) {
      if (expectedIdentity) {
        const finalProof = (deps.verifyIdentity ?? verifyRunProcessIdentity)(
          pid,
          expectedIdentity,
          runtimePlatform,
        );
        if (finalProof.status === "dead_pid") return plan;
      }
      throw new Error(
        result.stderr?.trim() ||
          result.stdout?.trim() ||
          `${plan.command} failed`,
      );
    }
    return plan;
  }
  const killProcess = deps.killProcess ?? process.kill.bind(process);
  try {
    killProcess(-pid, signal);
    return { signalTarget: "processGroup" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    if (expectedIdentity) {
      const fallbackProof = (deps.verifyIdentity ?? verifyRunProcessIdentity)(
        pid,
        expectedIdentity,
        runtimePlatform,
      );
      if (!fallbackProof.valid) {
        throw new Error(
          `Run process identity changed before pid fallback: ${fallbackProof.status.replaceAll("_", " ")}`,
        );
      }
    }
    killProcess(pid, signal);
    return { signalTarget: "process" };
  }
}

function readOwnedRunControlMeta(stateDir: string): { stateDir: string; meta: Record<string, unknown> } | undefined {
  const owned = readOwnedRunStateDirectory(stateDir);
  const path = join(owned.stateDir, "run.json");
  if (!lstatSync(path).isFile()) return undefined;
  const read = readJsonFileResilient<unknown>(path, undefined);
  if (read.diagnostics.length || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) return undefined;
  const meta = read.value as Record<string, unknown>;
  if (meta.run !== owned.run || meta.state_dir !== owned.stateDir) return undefined;
  return { stateDir: owned.stateDir, meta };
}

export interface RunStopClaimRequest {
  runInstanceId: string;
  ownerId?: string;
  reason: RunStopReason;
}

export type RunStopClaimResult =
  | { status: "stop_requested"; stopped: false; reused: boolean; claim: Readonly<RunStopClaim> }
  | { status: "already_terminal"; terminal_status: "done" | "failed" }
  | { status: "rejected"; code: string };

/**
 * Requests only: no signal, handled marker, or claim of physical termination.
 * The supervisor owns deadline eligibility; this owner revalidates configuration and identity.
 * Legacy producers cannot participate until they bind the serialized outcome protocol.
 */
export function claimRunStop(
  stateDir: string,
  request: RunStopClaimRequest,
  deps: RunProcessSignalDeps & { onLockContention?: () => void } = {},
): RunStopClaimResult {
  const reject = (code: string): RunStopClaimResult => ({ status: "rejected", code });
  if (!request || typeof request.runInstanceId !== "string" || !request.runInstanceId) {
    return reject("run_generation_required");
  }
  if (request.reason !== "manual_kill" && request.reason !== "max_runtime") return reject("invalid_stop_reason");
  const release = acquireStateStartLock(stateDir, { onContention: deps.onLockContention });
  try {
    const owned = readOwnedRunControlMeta(stateDir);
    if (!owned) return reject("run_identity_unavailable");
    const { meta } = owned;
    if (meta.run_instance_id !== request.runInstanceId) return reject("run_generation_mismatch");
    if (meta.ownerId !== request.ownerId) return reject("run_owner_mismatch");
    if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL) return reject("run_outcome_protocol_unavailable");
    const natural = readRunNaturalOutcome(owned.stateDir, meta);
    if (natural.state === "accepted") return { status: "already_terminal", terminal_status: natural.status };
    const stop = readRunStopClaim(owned.stateDir, meta);
    if (stop.state === "pending") return { status: "stop_requested", stopped: false, reused: true, claim: stop.claim };
    if (stop.state !== "absent") return reject("run_stop_state_unavailable");
    if (natural.state !== "absent") return reject("run_result_proof_unavailable");
    if (!Number.isSafeInteger(meta.pid) || Number(meta.pid) <= 0 ||
      (meta.ownerId !== undefined && (typeof meta.ownerId !== "string" || !meta.ownerId))) {
      return reject("run_identity_unavailable");
    }
    if (request.reason === "max_runtime") {
      try {
        if (readRunSupervisionClock(meta)?.supervision.max_runtime_ms == null) return reject("run_deadline_unconfigured");
      } catch {
        return reject("run_deadline_unproven");
      }
    }
    const proof = (deps.verifyIdentity ?? verifyRunProcessIdentity)(
      Number(meta.pid), meta.process_identity as RunProcessIdentity, deps.runtimePlatform ?? process.platform,
    );
    if (!proof.valid) return reject("run_process_unproven");
    const claim = writeRunStopClaimUnderLock(owned.stateDir, meta, request.reason);
    return { status: "stop_requested", stopped: false, reused: false, claim };
  } finally {
    release();
  }
}

export interface RunNativeMemberRecoveryRequest {
  runInstanceId: string;
  ownerId?: string;
  intentId: string;
}

export type RunNativeMemberRecoveryResult =
  | { status: "recorded"; settlement: Readonly<RunNativeLaunchAbsenceSettlement> }
  | { status: "already_recorded"; settlement: Readonly<RunNativeLaunchSettlement> }
  | { status: "unproven"; reason: string }
  | { status: "rejected"; code: string };

/** Evidence only after producer exit; never repair birth, dispatch signals, reopen work, or finalize a scope. */
export function recoverRunNativeMemberExit(
  stateDir: string,
  request: RunNativeMemberRecoveryRequest,
  deps: RunProcessExitDeps & { onLockContention?: () => void } = {},
): RunNativeMemberRecoveryResult {
  const reject = (code: string): RunNativeMemberRecoveryResult => ({ status: "rejected", code });
  if (!request || typeof request.runInstanceId !== "string" || !request.runInstanceId) return reject("run_generation_required");
  if (typeof request.intentId !== "string" || !request.intentId) return reject("run_native_intent_required");
  const release = acquireStateStartLock(stateDir, { onContention: deps.onLockContention });
  try {
    let owned: ReturnType<typeof readOwnedRunControlMeta>;
    try { owned = readOwnedRunControlMeta(stateDir); } catch { return reject("run_identity_unavailable"); }
    if (!owned) return reject("run_identity_unavailable");
    const { meta } = owned;
    if (meta.run_instance_id !== request.runInstanceId) return reject("run_generation_mismatch");
    if (meta.ownerId !== request.ownerId) return reject("run_owner_mismatch");
    if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL) return reject("run_outcome_protocol_unavailable");
    if (!Number.isSafeInteger(meta.pid) || Number(meta.pid) <= 0 ||
      (meta.ownerId !== undefined && (typeof meta.ownerId !== "string" || !meta.ownerId))) return reject("run_identity_unavailable");
    const owner: RunNativeLaunchOwner = {
      run: String(meta.run), runInstanceId: request.runInstanceId,
      ...(meta.ownerId === undefined ? {} : { ownerId: String(meta.ownerId) }),
      pid: Number(meta.pid), processIdentityDigest: runProcessIdentityDigest(meta.process_identity),
    };
    const read = readRunNativeLaunchLedger(owned.stateDir, owner);
    if (read.state !== "available") return reject("run_native_evidence_unavailable");
    const intent = read.ledger.intents.find((item) => item.intent_id === request.intentId);
    if (!intent) return reject("run_native_intent_unavailable");
    if (intent.settlement) return { status: "already_recorded", settlement: intent.settlement };
    if (!intent.birth) return { status: "unproven", reason: "birth_unavailable" };
    if (!owner.processIdentityDigest) return { status: "unproven", reason: "producer_identity_unavailable" };
    const producer = observeRunProcessExit(owner.pid, meta.process_identity as RunProcessIdentity, deps);
    if (producer.status !== "exited") return { status: "unproven", reason: producer.status === "running" ? "producer_running" : "producer_exit_unproven" };
    const member = observeRunProcessExit(intent.birth.pid, intent.birth.process_identity, deps);
    if (member.status !== "exited") return { status: "unproven", reason: member.status === "running" ? "member_running" : "member_exit_unproven" };
    let current: ReturnType<typeof readOwnedRunControlMeta>;
    try { current = readOwnedRunControlMeta(owned.stateDir); } catch { return reject("run_identity_changed"); }
    if (!current || current.stateDir !== owned.stateDir || current.meta.run !== owner.run ||
      current.meta.run_instance_id !== owner.runInstanceId || current.meta.ownerId !== owner.ownerId ||
      current.meta.pid !== owner.pid || current.meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL ||
      runProcessIdentityDigest(current.meta.process_identity) !== owner.processIdentityDigest) return reject("run_identity_changed");
    const settlement = recordRunNativeLaunchSettlementUnderLock(owned.stateDir, owner, {
      intent, birth: intent.birth, settlement: { basis: "verified_absence", observed_at: new Date().toISOString() },
    });
    return { status: "recorded", settlement };
  } finally { release(); }
}

export interface RunDescendantPreparationRecoveryRequest {
  runInstanceId: string;
  ownerId?: string;
  child: RunDescendantLaunchRequest;
}

export interface RunDescendantRecoveryCleanupFailure {
  readonly status: "release_unproven";
  readonly error_code: string;
}

export type RunDescendantPreparationRecoveryResult = (
  | { status: "recorded" | "already_recorded"; intent: Readonly<RunDescendantLaunchIntent> }
  | { status: "unproven"; reason: string }
  | { status: "rejected"; code: string }
) & { readonly cleanup?: Readonly<RunDescendantRecoveryCleanupFailure> };

const descendantRecoveryCleanupFailures = new Map<string, Readonly<RunDescendantRecoveryCleanupFailure>>();

function retainDescendantRecoveryCleanupFailure(key: string, error: unknown): Readonly<RunDescendantRecoveryCleanupFailure> {
  const prior = descendantRecoveryCleanupFailures.get(key);
  if (prior) return prior;
  let code = "UNKNOWN";
  try {
    const value = (error as NodeJS.ErrnoException)?.code;
    if (typeof value === "string" && /^[A-Z0-9_]{1,64}$/.exec(value)?.[0] === value) code = value;
  } catch { /* A diagnostic getter cannot replace an action outcome. */ }
  const failure = Object.freeze({ status: "release_unproven" as const, error_code: code });
  descendantRecoveryCleanupFailures.set(key, failure);
  try { console.error("Run descendant recovery lifecycle cleanup failed; release remains unproven and this runtime's recovery scope is fenced."); }
  catch { /* A diagnostic sink cannot replace an action outcome. */ }
  return failure;
}

/** Post-producer metadata evidence only; never recreate a producer, launch work, invent exits, or release scope guards. */
export function recoverRunDescendantPreparation(
  stateDir: string,
  request: RunDescendantPreparationRecoveryRequest,
  deps: RunProcessExitDeps & { onLockContention?: () => void } = {},
): Readonly<RunDescendantPreparationRecoveryResult> {
  const reject = (code: string): RunDescendantPreparationRecoveryResult => ({ status: "rejected", code });
  const generation = request?.runInstanceId;
  if (typeof generation !== "string" || !generation) return Object.freeze(reject("run_generation_required"));
  const ownerId = request.ownerId;
  if (ownerId !== undefined && (typeof ownerId !== "string" || !ownerId)) return Object.freeze(reject("run_owner_mismatch"));
  if (!request.child || typeof request.child !== "object" || Array.isArray(request.child)) return Object.freeze(reject("run_descendant_target_required"));
  const childRequest = Object.freeze({ ...request.child });
  let directory: ReturnType<typeof readOwnedRunStateDirectory>;
  try { directory = readOwnedRunStateDirectory(stateDir); } catch { return Object.freeze(reject("run_identity_unavailable")); }
  const key = JSON.stringify([directory.stateDir, generation, ownerId ?? null]);
  const quarantined = descendantRecoveryCleanupFailures.get(key);
  if (quarantined) return Object.freeze({ ...reject("run_descendant_recovery_cleanup_unproven"), cleanup: quarantined });
  const releaseParent = acquireStateStartLock(directory.stateDir, { onContention: deps.onLockContention });
  let releaseChild: (() => void) | undefined;
  let result!: RunDescendantPreparationRecoveryResult;
  let primary: unknown;
  let failed = false;
  let cleanup: Readonly<RunDescendantRecoveryCleanupFailure> | undefined;
  try {
    result = (() : RunDescendantPreparationRecoveryResult => {
      let owned: ReturnType<typeof readOwnedRunControlMeta>;
      try { owned = readOwnedRunControlMeta(directory.stateDir); } catch { return reject("run_identity_unavailable"); }
      if (!owned) return reject("run_identity_unavailable");
      const { meta } = owned;
      if (meta.run_instance_id !== generation) return reject("run_generation_mismatch");
      if (meta.ownerId !== ownerId) return reject("run_owner_mismatch");
      if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL) return reject("run_outcome_protocol_unavailable");
      if (!Number.isSafeInteger(meta.pid) || Number(meta.pid) <= 0) return reject("run_identity_unavailable");
      const owner: RunDescendantLaunchOwner = { run: String(meta.run), runInstanceId: generation,
        ...(ownerId === undefined ? {} : { ownerId }), pid: Number(meta.pid), processIdentityDigest: runProcessIdentityDigest(meta.process_identity) };
      const child = resolveRunDescendantLaunchTarget(childRequest, owner, owned.stateDir);
      if (!child) return reject("run_descendant_target_invalid");
      const readIntent = (): { intent?: Readonly<RunDescendantLaunchIntent>; error?: string } => {
        const reading = readRunDescendantLaunchLedger(owned.stateDir, owner);
        if (reading.state === "invalid") return { error: "run_descendant_evidence_unavailable" };
        const intent = reading.state === "available" ? reading.ledger.intents.find((item) => item.child.run_instance_id === child.run_instance_id) : undefined;
        if (intent && (intent.child.run !== child.run || intent.child.ownerId !== child.ownerId || intent.child.state_dir !== child.state_dir)) {
          return { error: "run_descendant_target_mismatch" };
        }
        return { intent };
      };
      const sameParent = (): boolean => {
        try {
          const current = readOwnedRunControlMeta(owned.stateDir);
          return Boolean(current && current.stateDir === owned.stateDir && current.meta.run === owner.run &&
            current.meta.run_instance_id === generation && current.meta.ownerId === ownerId && current.meta.pid === owner.pid &&
            current.meta.outcome_protocol === RUN_OUTCOME_PROTOCOL && runProcessIdentityDigest(current.meta.process_identity) === owner.processIdentityDigest);
        } catch { return false; }
      };
      const initial = readIntent();
      if (initial.error) return reject(initial.error);
      if (initial.intent?.preparation) return { status: "already_recorded", intent: initial.intent };
      try {
        assertDistinctRunStateDirectories(owned.stateDir, child.state_dir);
        assertRunDescendantPreparedMetadata(child.state_dir, child);
      } catch { return reject("run_descendant_preparation_unavailable"); }
      releaseChild = acquireStateStartLock(child.state_dir, { onContention: deps.onLockContention });
      if (!sameParent()) return reject("run_identity_changed");
      const admitted = readIntent();
      if (admitted.error) return reject(admitted.error);
      if (admitted.intent?.preparation) return { status: "already_recorded", intent: admitted.intent };
      const parent = { run: owner.run, run_instance_id: generation, ...(ownerId === undefined ? {} : { ownerId }), state_dir: owned.stateDir };
      try { assertRunDescendantPreparedMetadata(child.state_dir, child); }
      catch { return reject("run_descendant_preparation_unavailable"); }
      const preparation = readRunDescendantPreparation(child.state_dir, child, parent);
      if (!preparation) return reject("run_descendant_preparation_unavailable");
      if (!preparation.parent_producer) return { status: "unproven", reason: "producer_binding_unavailable" };
      if (preparation.parent_producer.process_identity_digest === null || !owner.processIdentityDigest) {
        return { status: "unproven", reason: "producer_identity_unavailable" };
      }
      if (preparation.parent_producer.pid !== owner.pid || preparation.parent_producer.process_identity_digest !== owner.processIdentityDigest) {
        return reject("run_descendant_producer_mismatch");
      }
      const producer = observeRunProcessExit(owner.pid, meta.process_identity as RunProcessIdentity, deps);
      if (producer.status !== "exited") return { status: "unproven", reason: producer.status === "running" ? "producer_running" : "producer_exit_unproven" };
      if (!sameParent()) return reject("run_identity_changed");
      const current = readIntent();
      if (current.error) return reject(current.error);
      if (current.intent?.preparation) {
        if (current.intent.preparation.preparation_id !== preparation.preparation_id || current.intent.preparation.prepared_at !== preparation.prepared_at) {
          return reject("run_descendant_preparation_changed");
        }
        return { status: "already_recorded", intent: current.intent };
      }
      const retained = readRunDescendantPreparation(child.state_dir, child, parent);
      if (!retained || JSON.stringify(retained) !== JSON.stringify(preparation)) return reject("run_descendant_preparation_changed");
      try { assertRunDescendantPreparedMetadata(child.state_dir, child); }
      catch { return reject("run_descendant_preparation_changed"); }
      const intent = recordRunDescendantLaunchIntentUnderLock(owned.stateDir, owner, {
        run: child.run, runInstanceId: child.run_instance_id, ownerId: child.ownerId, stateDir: child.state_dir,
      }, preparation);
      return { status: "recorded", intent };
    })();
  } catch (error) { primary = error; failed = true; }
  finally {
    for (const release of [releaseChild, releaseParent]) if (release) {
      try { release(); } catch (error) { cleanup = retainDescendantRecoveryCleanupFailure(key, error); }
    }
  }
  if (failed) throw primary;
  return Object.freeze({ ...result, ...(cleanup ? { cleanup } : {}) });
}

export function markTerminalHandled(
  stateDir: string,
  details: Record<string, unknown>,
): void {
  writeJsonAtomic(join(stateDir, "terminal-handled.json"), {
    ...details,
    ts: new Date().toISOString(),
  });
}

export function buildTerminalProgress(
  existing: Record<string, unknown> | undefined,
  phase: "cancelled" | "killed",
): Record<string, unknown> {
  const progress = existing ?? {};
  const { activeSubagents: _activeSubagents, ...rest } = progress;
  return {
    ...rest,
    completed: typeof progress.completed === "number" ? progress.completed : 0,
    failures: Array.isArray(progress.failures) ? progress.failures : [],
    phase,
    updatedAt: new Date().toISOString(),
  };
}
