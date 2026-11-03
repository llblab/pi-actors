/**
 * Canonical Run clock binding and explicit runtime-local supervision ownership.
 * Owns: bounded readonly clock/frame admission, origin/reference retention, first-natural timing freezes, composed snapshots and cooperative same-origin controller claims.
 * Excludes: origin creation/backfill, global/cross-runtime leases, independent supervision/recovery, work/native authority and actuation.
 */
import { lstatSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readRunSupervisionClock, createRunSupervisionController, createRunSupervisionTimebase,
  type RunSupervisionClock, type RunSupervisionController, type RunSupervisionControllerPorts, type RunSupervisionControllerSnapshot,
  type RunSupervisionTimebaseReading, type RunSupervisionTimeObservation } from "./run-supervision.ts";
import { readRunContextIdentity, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES, type RunContextIndexIdentity } from "./runs-context-index.ts";
import { readOwnedRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.ts";
import { readJsonFileResilient } from "./state-readers.ts";
import { admitRunSnapshotReferenceReader, type RunSnapshotReferenceReader, type RunSnapshotReferencesReading } from "./runs-context-exports.ts";
import { readRunSnapshotFacts, type RunSnapshotFactsReading } from "./runs-status.ts";
import { projectRunSnapshot, type RunSnapshot, type RunSnapshotProjection } from "./runs-snapshot.ts";
import { withRunNaturalResultTimingAdmission, readRunNaturalResultTimingAcceptance,
  type RunNaturalResultTimingAdmission, type RunNaturalResultTimingAcceptance, type RunResultProducer } from "./runs-results.ts";

export type RunSupervisionBindingReading =
  | { readonly state: "available"; readonly identity: Readonly<RunContextIndexIdentity>; readonly clock: Readonly<RunSupervisionClock>; readonly unchanged: () => boolean }
  | { readonly state: "unavailable"; readonly reason: "identity_unavailable" | "identity_mismatch" | "observation_changed" |
      "clock_metadata_unavailable" | "clock_unconfigured" | "clock_invalid" };
type Unavailable = Extract<RunSupervisionBindingReading, { state: "unavailable" }>;
type ObservedBinding = Extract<RunSupervisionBindingReading, { state: "available" }> & { readonly frameUnchanged: () => boolean };
export type BoundRunSupervisionControllerReading =
  | { readonly state: "available"; readonly controller: Readonly<RunSupervisionController> }
  | Unavailable | Extract<RunSupervisionTimebaseReading, { state: "unavailable" }>;
function unavailable(reason: Unavailable["reason"]): Readonly<Unavailable> { return Object.freeze({ state: "unavailable", reason }); }
function sameObject(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function observeBinding(stateDir: string, expected: unknown): Readonly<ObservedBinding | Unavailable> {
  const owner = readRunContextIdentity(stateDir, expected);
  if (owner.state === "unavailable") return owner;
  try {
    const root = owner.local_path; const path = join(root, "run.json"); const markerPath = join(root, RUN_STATE_OWNERSHIP_FILE);
    const directory = lstatSync(root, { bigint: true }); const marker = lstatSync(markerPath, { bigint: true }); const before = lstatSync(path, { bigint: true });
    if (!directory.isDirectory() || !marker.isFile() || !before.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES)) return unavailable("clock_metadata_unavailable");
    const read = readJsonFileResilient<unknown>(path, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
    const unchanged = (): boolean => {
      try { return owner.unchanged() && sameFile(before, lstatSync(path, { bigint: true })); } catch { return false; }
    };
    if (!unchanged()) return unavailable("observation_changed");
    if (read.diagnostics.length || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) return unavailable("clock_metadata_unavailable");
    const meta = read.value as Record<string, unknown>;
    if (meta.run !== owner.identity.run || meta.run_instance_id !== owner.identity.run_instance_id || meta.ownerId !== owner.identity.ownerId || meta.state_dir !== root) return unavailable("identity_mismatch");
    let decoded: RunSupervisionClock | undefined;
    try { decoded = readRunSupervisionClock(meta); } catch { return unavailable("clock_invalid"); }
    if (!decoded) return unavailable("clock_unconfigured");
    const clock = Object.freeze({ started_at: decoded.started_at, supervision: Object.freeze({ ...decoded.supervision }) });
    const frameUnchanged = (): boolean => {
      try { const current = lstatSync(root, { bigint: true }); return current.isDirectory() && sameObject(directory, current) && sameFile(marker, lstatSync(markerPath, { bigint: true })); }
      catch { return false; }
    };
    if (!unchanged() || !frameUnchanged()) return unavailable("observation_changed");
    return Object.freeze({ state: "available", identity: owner.identity, clock, unchanged, frameUnchanged });
  } catch { return unavailable("clock_metadata_unavailable"); }
}

/** Curated metadata only; no current-time read, clock repair, lifecycle/native observation or role body. */
export function readRunSupervisionBinding(stateDir: string, expected: unknown): Readonly<RunSupervisionBindingReading> {
  const observed = observeBinding(stateDir, expected);
  return observed.state === "unavailable" ? observed : Object.freeze({ state: "available", identity: observed.identity, clock: observed.clock, unchanged: observed.unchanged });
}

/** Does not start automatically; origin must be the genuine reference retained from generation admission. */
export function createRunSupervisionControllerFromState(stateDir: string, expected: unknown, origin: unknown,
  ports: Omit<RunSupervisionControllerPorts, "readCurrent">): Readonly<BoundRunSupervisionControllerReading> {
  const initial = observeBinding(stateDir, expected);
  if (initial.state === "unavailable") return initial;
  const timebase = createRunSupervisionTimebase(initial.clock, origin);
  if (timebase.state === "unavailable") return timebase;
  if (!initial.unchanged()) return unavailable("observation_changed");
  const controller = createRunSupervisionController(initial.identity, timebase.timebase, {
    ...ports,
    readCurrent: () => {
      if (!initial.frameUnchanged()) return null;
      const current = observeBinding(stateDir, initial.identity);
      if (current.state === "unavailable" || !current.unchanged() || !initial.frameUnchanged()) return null;
      return Object.freeze({ identity: current.identity, clock: current.clock });
    },
  });
  return Object.freeze({ state: "available", controller });
}


// --- Explicit runtime-local retention ---

export type RunSupervisionOwnerReading =
  | { readonly state: "retained" | "stopped" | "released"; readonly identity: Readonly<RunContextIndexIdentity>; readonly controller?: Readonly<RunSupervisionControllerSnapshot> }
  | { readonly state: "controlled"; readonly identity: Readonly<RunContextIndexIdentity>; readonly controller: Readonly<RunSupervisionControllerSnapshot> }
  | { readonly state: "unavailable"; readonly reason: Extract<BoundRunSupervisionControllerReading, { state: "unavailable" }>["reason"] |
      "identity_invalid" | "origin_not_retained" | "owner_closed" | "controller_claimed" };
type OwnerUnavailable = Extract<RunSupervisionOwnerReading, { state: "unavailable" }>;
export type RunSupervisionOwnerTimeReading =
  | { readonly state: "available"; readonly basis: "since_admission"; readonly identity: Readonly<RunContextIndexIdentity>;
      readonly timing: Readonly<RunSupervisionTimeObservation>; readonly unchanged: () => boolean }
  | { readonly state: "unavailable"; readonly reason: OwnerUnavailable["reason"] | "owner_stopped" };
export type RunSupervisionOwnerReferencesReading = RunSnapshotReferencesReading | OwnerUnavailable |
  { readonly state: "unavailable"; readonly reason: "owner_stopped" | "references_not_retained" };
export type RunSupervisionOwnerSnapshotReading =
  | { readonly state: "available"; readonly snapshot: Readonly<RunSnapshot>; readonly unchanged: () => boolean }
  | Extract<RunSnapshotProjection | RunSnapshotFactsReading | RunSupervisionOwnerReferencesReading, { state: "unavailable" }>;
export type RunSupervisionOwnerNaturalTimeReading =
  | { readonly state: "available"; readonly basis: "first_natural_acceptance"; readonly identity: Readonly<RunContextIndexIdentity>;
      readonly elapsed_ms: number; readonly natural_acceptance: Readonly<{ code: number; recorded_status: "done" | "failed"; completed_at: string }>;
      readonly unchanged: () => boolean }
  | Extract<RunSupervisionOwnerTimeReading, { state: "unavailable" }>
  | { readonly state: "unavailable"; readonly reason: "natural_time_not_captured" | "natural_time_capturing" | "natural_time_unproven" | "natural_acceptance_mismatch" };
export interface RunSupervisionOwnerClose {
  readonly state: "closed";
  readonly timer_cleanup?: "unproven";
}
export interface RunSupervisionOwner {
  readonly onSupervisionClockCaptured: (capture: unknown) => void;
  readonly start: (expected: unknown) => Readonly<RunSupervisionOwnerReading>;
  readonly stop: (expected: unknown) => Readonly<RunSupervisionOwnerReading>;
  readonly release: (expected: unknown) => Readonly<RunSupervisionOwnerReading>;
  readonly snapshot: (expected: unknown) => Readonly<RunSupervisionOwnerReading>;
  readonly observeTime: (expected: unknown, stateDir?: string) => Readonly<RunSupervisionOwnerTimeReading>;
  readonly observeReferences: (expected: unknown, stateDir?: string) => Readonly<RunSupervisionOwnerReferencesReading>;
  /** Active postcommit admission only; the first authorized attempt is final across original-origin owners. */
  readonly captureNaturalTime: (expected: unknown, producer: RunResultProducer, admission: RunNaturalResultTimingAdmission, stateDir?: string) => Readonly<RunSupervisionOwnerNaturalTimeReading>;
  /** Historical elapsed plus current owner/clock/frame, not current result/lifecycle or a new sample. */
  readonly observeFrozenNaturalTime: (expected: unknown, stateDir?: string) => Readonly<RunSupervisionOwnerNaturalTimeReading>;
  readonly observeSnapshot: (expected: unknown, capturedAt: unknown, stateDir?: string) => Readonly<RunSupervisionOwnerSnapshotReading>;
  readonly close: () => Readonly<RunSupervisionOwnerClose>;
}
interface SharedOriginClaim {
  readonly binding: string;
  readonly frameUnchanged: () => boolean;
  holder?: object;
  natural?: FrozenNaturalTime;
}
type FrozenNaturalTime =
  | { readonly state: "capturing" | "unproven"; readonly producer: RunResultProducer; readonly admission: RunNaturalResultTimingAdmission }
  | { readonly state: "frozen"; readonly producer: RunResultProducer; readonly admission: RunNaturalResultTimingAdmission;
      readonly acceptance: Readonly<RunNaturalResultTimingAcceptance>; readonly elapsed_ms: number };
// Cooperative claims share only genuine origins in this module/runtime, never persisted or native scope authority.
const sharedOriginClaims = new WeakMap<object, SharedOriginClaim>();
interface RetainedSupervision {
  readonly claim: SharedOriginClaim;
  readonly token: object;
  readonly identity: Readonly<RunContextIndexIdentity>;
  readonly stateDir: string;
  readonly origin: object;
  readonly clockKey: string;
  readonly references?: Readonly<RunSnapshotReferenceReader>;
  readonly frameUnchanged: () => boolean;
  stopped: boolean;
  controller?: Readonly<RunSupervisionController>;
}
function own(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}
function ownerIdentity(value: unknown): Readonly<RunContextIndexIdentity> | undefined {
  const run = own(value, "run"); const generation = own(value, "run_instance_id");
  const descriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "ownerId") : undefined; const owner = descriptor?.value;
  if (typeof run !== "string" || !run || /[^A-Za-z0-9_.-]/u.test(run) || typeof generation !== "string" || !generation ||
    (descriptor && !Object.hasOwn(descriptor, "value")) || (owner !== undefined && (typeof owner !== "string" || !owner))) return undefined;
  return Object.freeze({ run, run_instance_id: generation, ...(owner === undefined ? {} : { ownerId: owner }) });
}
function ownerKey(identity: RunContextIndexIdentity): string { return JSON.stringify([identity.run, identity.run_instance_id, identity.ownerId ?? null]); }
function retainAdmissionFrame(stateDir: string, run: string): (() => boolean) | undefined {
  try {
    const directory = lstatSync(stateDir, { bigint: true }); const markerPath = join(stateDir, RUN_STATE_OWNERSHIP_FILE); const marker = lstatSync(markerPath, { bigint: true });
    if (!directory.isDirectory() || !marker.isFile()) return undefined;
    const unchanged = (): boolean => {
      try { const current = lstatSync(stateDir, { bigint: true }); return current.isDirectory() && sameObject(directory, current) && sameFile(marker, lstatSync(markerPath, { bigint: true })); }
      catch { return false; }
    };
    const owned = readOwnedRunStateDirectory(stateDir, { maxBytes: RUN_CONTEXT_INDEX_METADATA_MAX_BYTES });
    return owned.run === run && owned.stateDir === stateDir && unchanged() ? unchanged : undefined;
  } catch { return undefined; }
}

/** Explicit retention with cooperative same-origin claims; no default watcher, cross-process lease or independent supervisor. */
export function createRunSupervisionOwner(ports: Omit<RunSupervisionControllerPorts, "readCurrent">): Readonly<RunSupervisionOwner> {
  const schedule = ports.schedule; const notify = ports.onDeadlineDue;
  if (typeof notify !== "function" || (schedule !== undefined && typeof schedule !== "function")) throw new Error("Run supervision owner requires synchronous controller ports.");
  const retainedPorts = Object.freeze({ onDeadlineDue: notify.bind(ports), ...(schedule === undefined ? {} : { schedule: schedule.bind(ports) }) });
  const records = new Map<string, RetainedSupervision>(); const origins = new WeakMap<object, string>();
  let closed = false; let cleanupUnproven = false;
  const absent = (reason: OwnerUnavailable["reason"]): Readonly<OwnerUnavailable> => Object.freeze({ state: "unavailable", reason });
  const find = (expected: unknown): RetainedSupervision | Readonly<OwnerUnavailable> => {
    if (closed) return absent("owner_closed");
    const identity = ownerIdentity(expected); if (!identity) return absent("identity_invalid");
    return records.get(ownerKey(identity)) ?? absent("origin_not_retained");
  };
  const view = (record: RetainedSupervision): Readonly<RunSupervisionOwnerReading> => {
    const controller = record.controller?.snapshot();
    return record.stopped ? Object.freeze({ state: "stopped", identity: record.identity, ...(controller ? { controller } : {}) })
      : controller ? Object.freeze({ state: "controlled", identity: record.identity, controller })
      : Object.freeze({ state: "retained", identity: record.identity });
  };
  const snapshot = (expected: unknown): Readonly<RunSupervisionOwnerReading> => { const record = find(expected); return "state" in record ? record : view(record); };
  const rememberCleanup = (record: RetainedSupervision): void => { if (record.controller?.snapshot().timer_cleanup === "unproven") cleanupUnproven = true; };
  const releaseClaim = (record: RetainedSupervision): void => { if (record.claim.holder === record.token) record.claim.holder = undefined; };
  const stopRecord = (record: RetainedSupervision): void => {
    if (record.stopped) return;
    record.stopped = true; record.controller?.stop(); rememberCleanup(record);
  };
  const revokedRecord = (record: RetainedSupervision): Extract<RunSupervisionOwnerTimeReading, { state: "unavailable" }> | undefined => {
    if (closed) return absent("owner_closed");
    if (records.get(ownerKey(record.identity)) !== record) return absent("origin_not_retained");
    if (record.stopped) return Object.freeze({ state: "unavailable", reason: "owner_stopped" });
    if (!record.frameUnchanged()) return absent("observation_changed");
    // Frame ports are synchronous, but can reenter this owner; never let their last read hide revocation.
    if (closed) return absent("owner_closed");
    if (records.get(ownerKey(record.identity)) !== record) return absent("origin_not_retained");
    return record.stopped ? Object.freeze({ state: "unavailable", reason: "owner_stopped" }) : undefined;
  };
  const owner: Readonly<RunSupervisionOwner> = Object.freeze({
    onSupervisionClockCaptured: (capture: unknown): void => {
      if (closed) throw new Error("Run supervision owner is closed.");
      const identity = ownerIdentity(own(capture, "identity")); const stateDir = own(capture, "state_dir"); const origin = own(capture, "origin"); const metadata = own(capture, "clock");
      if (own(capture, "kind") !== "run_clock_origin_captured" || own(capture, "visibility") !== "kernel_only" ||
        own(capture, "publication") !== "unpublished" || own(capture, "work_started") !== false ||
        !identity || typeof stateDir !== "string" || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir || !origin || typeof origin !== "object") {
        throw new Error("Run supervision clock capture is invalid.");
      }
      const referenceDescriptor = Object.getOwnPropertyDescriptor(capture as object, "snapshot_references");
      const references = referenceDescriptor && Object.hasOwn(referenceDescriptor, "value")
        ? admitRunSnapshotReferenceReader(stateDir, identity, referenceDescriptor.value) : undefined;
      if (referenceDescriptor && !references) throw new Error("Run supervision snapshot-reference capture is invalid.");
      const key = ownerKey(identity); const existing = records.get(key); let decoded: RunSupervisionClock | undefined;
      const policy = own(metadata, "supervision");
      try { decoded = readRunSupervisionClock({ started_at: own(metadata, "started_at"), supervision: {
        report_every_ms: own(policy, "report_every_ms"), max_runtime_ms: own(policy, "max_runtime_ms"), deadline_at: own(policy, "deadline_at"),
      }, ...(metadata && typeof metadata === "object" && Object.hasOwn(metadata, "createdAt") ? { createdAt: own(metadata, "createdAt") } : {}) }); }
      catch { throw new Error("Run supervision clock capture is invalid."); }
      if (!decoded) throw new Error("Run supervision clock capture is invalid.");
      const clockKey = JSON.stringify(decoded);
      if (existing) {
        if (existing.origin !== origin || existing.stateDir !== stateDir || existing.clockKey !== clockKey || existing.references !== references || !existing.frameUnchanged()) {
          throw new Error("Run supervision clock capture conflicts with retained identity, state or origin.");
        }
        return;
      }
      if (origins.has(origin)) throw new Error("Run supervision origin is already retained or released by this owner.");
      const timebase = createRunSupervisionTimebase(decoded, origin);
      if (timebase.state === "unavailable") throw new Error("Run supervision clock capture origin is unavailable or incompatible.");
      const frameUnchanged = retainAdmissionFrame(stateDir, identity.run);
      if (!frameUnchanged) throw new Error("Run supervision admission state frame is unavailable or changed.");
      const binding = JSON.stringify([stateDir, key]); let claim = sharedOriginClaims.get(origin);
      if (claim && claim.binding !== binding) throw new Error("Run supervision origin binding already belongs to another identity or state.");
      if (claim && !claim.frameUnchanged()) throw new Error("Run supervision origin admission frame changed.");
      if (closed) throw new Error("Run supervision owner is closed.");
      if (records.has(key) || origins.has(origin)) throw new Error("Run supervision origin is already retained or released by this owner.");
      if (!claim) { claim = { binding, frameUnchanged }; sharedOriginClaims.set(origin, claim); }
      records.set(key, { identity, stateDir, origin, clockKey, references, frameUnchanged: claim.frameUnchanged, claim, token: {}, stopped: false }); origins.set(origin, key);
    },
    start: (expected: unknown): Readonly<RunSupervisionOwnerReading> => {
      const record = find(expected); if ("state" in record) return record;
      if (record.stopped) return view(record);
      if (!record.controller) {
        if (!record.frameUnchanged()) return absent("observation_changed");
        if (record.claim.holder && record.claim.holder !== record.token) return absent("controller_claimed");
        record.claim.holder = record.token;
        try {
          const scheduleWake = retainedPorts.schedule;
          const controllerPorts = scheduleWake ? { ...retainedPorts, schedule: (wake: () => void, milliseconds: number) =>
            scheduleWake(() => { try { wake(); } finally { rememberCleanup(record); } }, milliseconds) } : retainedPorts;
          const reading = createRunSupervisionControllerFromState(record.stateDir, record.identity, record.origin, controllerPorts);
          if (reading.state === "unavailable") return reading;
          if (!record.frameUnchanged()) { reading.controller.stop(); return absent("observation_changed"); }
          if (closed || records.get(ownerKey(record.identity)) !== record || record.stopped) { reading.controller.stop(); return snapshot(expected); }
          record.controller = reading.controller;
        } finally { if (!record.controller) releaseClaim(record); }
      }
      record.controller.start(); rememberCleanup(record); return snapshot(expected);
    },
    stop: (expected: unknown): Readonly<RunSupervisionOwnerReading> => { const record = find(expected); if ("state" in record) return record; stopRecord(record); return view(record); },
    release: (expected: unknown): Readonly<RunSupervisionOwnerReading> => {
      const record = find(expected); if ("state" in record) return record;
      stopRecord(record); releaseClaim(record); records.delete(ownerKey(record.identity)); const controller = record.controller?.snapshot();
      return Object.freeze({ state: "released", identity: record.identity, ...(controller ? { controller } : {}) });
    },
    snapshot,
    observeReferences: (expected: unknown, stateDir?: string): Readonly<RunSupervisionOwnerReferencesReading> => {
      const record = find(expected); if ("state" in record) return record;
      if (stateDir !== undefined && stateDir !== record.stateDir) return absent("identity_mismatch");
      const revoked = () => revokedRecord(record);
      const initial = revoked(); if (initial) return initial;
      if (!record.references) return Object.freeze({ state: "unavailable", reason: "references_not_retained" });
      const reading = record.references.read(); const afterRead = revoked(); if (afterRead) return afterRead;
      if (reading.state === "unavailable") return reading;
      const unchanged = (): boolean => !revoked() && reading.unchanged() && !revoked() &&
        !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
      if (!unchanged()) return revoked() ?? absent("observation_changed");
      return Object.freeze({ ...reading, unchanged });
    },
    captureNaturalTime: (expected: unknown, producer: RunResultProducer, admission: RunNaturalResultTimingAdmission, stateDir?: string): Readonly<RunSupervisionOwnerNaturalTimeReading> => {
      const record = find(expected); if ("state" in record) return record;
      if (stateDir !== undefined && stateDir !== record.stateDir) return absent("identity_mismatch");
      const initial = revokedRecord(record); if (initial) return initial;
      let attempt: FrozenNaturalTime | undefined; let staged: FrozenNaturalTime | undefined; let stable: (() => boolean) | undefined;
      try {
        const refused = withRunNaturalResultTimingAdmission(record.stateDir, producer, admission, acceptance => {
          if (ownerKey(acceptance.identity) !== ownerKey(record.identity)) return absent("identity_mismatch");
          const existing = record.claim.natural;
          if (existing) return existing.admission !== admission || existing.producer !== producer
            ? Object.freeze({ state: "unavailable" as const, reason: "natural_acceptance_mismatch" as const }) : undefined;
          attempt = Object.freeze({ state: "capturing", producer, admission }); record.claim.natural = attempt;
          const observed = owner.observeTime(record.identity, record.stateDir);
          if (observed.state === "available" && observed.timing.state === "available") {
            stable = observed.unchanged;
            staged = Object.freeze({ state: "frozen", producer, admission, acceptance, elapsed_ms: observed.timing.elapsed_ms });
          }
          return undefined;
        });
        if (refused) return refused;
        if (attempt && record.claim.natural === attempt) {
          const revoked = revokedRecord(record);
          if (!staged || !stable || !stable() || revoked || revokedRecord(record)) {
            record.claim.natural = Object.freeze({ state: "unproven", producer, admission });
            return revoked ?? revokedRecord(record) ?? Object.freeze({ state: "unavailable", reason: "natural_time_unproven" });
          }
          record.claim.natural = staged;
        }
      } catch (error) {
        if (attempt && record.claim.natural === attempt) record.claim.natural = Object.freeze({ state: "unproven", producer, admission });
        throw error;
      }
      return owner.observeFrozenNaturalTime(record.identity, record.stateDir);
    },
    observeFrozenNaturalTime: (expected: unknown, stateDir?: string): Readonly<RunSupervisionOwnerNaturalTimeReading> => {
      const record = find(expected); if ("state" in record) return record;
      if (stateDir !== undefined && stateDir !== record.stateDir) return absent("identity_mismatch");
      const initial = revokedRecord(record); if (initial) return initial;
      const frozen = record.claim.natural;
      if (!frozen) return Object.freeze({ state: "unavailable", reason: "natural_time_not_captured" });
      if (frozen.state !== "frozen") return Object.freeze({ state: "unavailable", reason: frozen.state === "capturing" ? "natural_time_capturing" : "natural_time_unproven" });
      const acceptance = readRunNaturalResultTimingAcceptance(record.stateDir, frozen.producer, frozen.admission);
      if (acceptance !== frozen.acceptance) return Object.freeze({ state: "unavailable", reason: "natural_acceptance_mismatch" });
      const binding = observeBinding(record.stateDir, record.identity);
      const afterRead = revokedRecord(record); if (afterRead) return afterRead;
      if (binding.state === "unavailable") return binding;
      if (JSON.stringify(binding.clock) !== record.clockKey) return absent("clock_changed");
      const unchanged = (): boolean => !revokedRecord(record) && record.claim.natural === frozen && binding.unchanged() && binding.frameUnchanged() &&
        !revokedRecord(record) && !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
      if (!unchanged()) return revokedRecord(record) ?? absent("observation_changed");
      return Object.freeze({ state: "available", basis: "first_natural_acceptance", identity: record.identity, elapsed_ms: frozen.elapsed_ms,
        natural_acceptance: Object.freeze({ code: acceptance.code, recorded_status: acceptance.recorded_status, completed_at: acceptance.completed_at }), unchanged });
    },
    observeSnapshot: (expected: unknown, capturedAt: unknown, stateDir?: string): Readonly<RunSupervisionOwnerSnapshotReading> => {
      const record = find(expected); if ("state" in record) return record;
      if (stateDir !== undefined && stateDir !== record.stateDir) return absent("identity_mismatch");
      const initial = revokedRecord(record); if (initial) return initial;
      const references = owner.observeReferences(record.identity, record.stateDir);
      const afterReferences = revokedRecord(record); if (afterReferences) return afterReferences;
      if (references.state === "unavailable") return references;
      if (references.references.cwd === null) return Object.freeze({ state: "unavailable", reason: "references_unavailable" });
      const facts = readRunSnapshotFacts(record.stateDir, record.identity, capturedAt, owner.observeTime, owner.observeFrozenNaturalTime);
      const afterFacts = revokedRecord(record); if (afterFacts) return afterFacts;
      if (facts.state === "unavailable") return facts;
      const unchanged = (): boolean => !revokedRecord(record) && references.unchanged() && facts.unchanged() &&
        !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
      if (!unchanged()) return revokedRecord(record) ?? absent("observation_changed");
      // Canonical lifecycle/time are facts, not permission to expose their mutable cwd/index fields.
      const projected = projectRunSnapshot(record.identity, { identity: facts.facts.identity, captured_at: facts.facts.captured_at,
        lifecycle: facts.facts.lifecycle, timing: facts.facts.timing, cwd: references.references.cwd,
        ...(references.references.context_index ? { context_index: references.references.context_index } : {}) });
      if (!unchanged()) return revokedRecord(record) ?? absent("observation_changed");
      return projected.state === "unavailable" ? projected : Object.freeze({ ...projected, unchanged });
    },
    observeTime: (expected: unknown, stateDir?: string): Readonly<RunSupervisionOwnerTimeReading> => {
      const record = find(expected); if ("state" in record) return record;
      if (stateDir !== undefined && stateDir !== record.stateDir) return absent("identity_mismatch");
      const revoked = () => revokedRecord(record);
      const initial = revoked(); if (initial) return initial;
      const binding = observeBinding(record.stateDir, record.identity);
      const afterRead = revoked(); if (afterRead) return afterRead;
      if (binding.state === "unavailable") return binding;
      if (JSON.stringify(binding.clock) !== record.clockKey) return absent("clock_changed");
      const timebase = createRunSupervisionTimebase(binding.clock, record.origin);
      if (timebase.state === "unavailable") return timebase;
      const unchanged = (): boolean => !revoked() && binding.unchanged() && binding.frameUnchanged() &&
        !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
      if (!unchanged()) return revoked() ?? absent("observation_changed");
      const timing = timebase.timebase.observe();
      const afterSample = revoked(); if (afterSample) return afterSample;
      if (!unchanged()) return revoked() ?? absent("observation_changed");
      return Object.freeze({ state: "available", basis: "since_admission", identity: record.identity, timing, unchanged });
    },
    close: (): Readonly<RunSupervisionOwnerClose> => {
      if (!closed) { closed = true; for (const record of records.values()) { stopRecord(record); releaseClaim(record); } records.clear(); }
      return Object.freeze({ state: "closed", ...(cleanupUnproven ? { timer_cleanup: "unproven" as const } : {}) });
    },
  });
  return owner;
}
