/**
 * Run generation supervision policy, clocks and deadline observation.
 * Owns: policy/clock validation, genuine runtime-local origins, monotonic timing and one-shot bounded deadline wake protocol.
 * Excludes: canonical state admission, independent supervisor/recovery, report acceptance, lifecycle/work authority and stop/closure actuation.
 */
import { performance } from "node:perf_hooks";
import type { RunContextIndexIdentity } from "./runs-context-index.ts";

const POLICY_FIELDS = ["report_every", "max_runtime"] as const;
const DURATION_MULTIPLIERS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Shared lower bound for Run report policies and root-session diagnostic batches. */
export const RUN_DIAGNOSTIC_MIN_INTERVAL_MS = 60_000;

type PolicyField = typeof POLICY_FIELDS[number];
type PolicyLayer = "recipe" | "launch";
type NormalizedLayer = Record<PolicyField, number | null | undefined>;

export type RunSupervisionPolicySource = PolicyLayer | "unset";

export interface RunSupervisionPolicy {
  readonly report_every_ms: number | null;
  readonly max_runtime_ms: number | null;
}

export interface ResolvedRunSupervisionPolicy extends RunSupervisionPolicy {
  readonly provenance: {
    readonly report_every: RunSupervisionPolicySource;
    readonly max_runtime: RunSupervisionPolicySource;
  };
}

function requireDiagnosticInterval(milliseconds: number, label: string): void {
  if (milliseconds < RUN_DIAGNOSTIC_MIN_INTERVAL_MS) {
    throw new Error(`Invalid ${label}: interval must be at least ${RUN_DIAGNOSTIC_MIN_INTERVAL_MS}ms (1m).`);
  }
}

function normalizeDuration(
  value: unknown,
  field: PolicyField,
  layer: PolicyLayer,
): number | null {
  if (value === null) return null;
  const match = typeof value === "string"
    ? /^([1-9][0-9]*)(ms|s|m|h)$/u.exec(value)
    : null;
  // A final line terminator may satisfy $, but is not part of a literal duration.
  if (!match || match[0] !== value) {
    throw new Error(
      `Invalid ${layer}.${field}: expected a positive integer duration with ms/s/m/h, or null.`,
    );
  }
  const milliseconds = Number(match[1]) *
    DURATION_MULTIPLIERS[match[2] as keyof typeof DURATION_MULTIPLIERS];
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(
      `Invalid ${layer}.${field}: duration exceeds the safe integer millisecond range.`,
    );
  }
  if (field === "report_every") requireDiagnosticInterval(milliseconds, `${layer}.${field}`);
  return milliseconds;
}

function normalizeLayer(value: unknown, layer: PolicyLayer): NormalizedLayer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Run supervision ${layer} policy must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const normalized: NormalizedLayer = {
    report_every: undefined,
    max_runtime: undefined,
  };
  for (const field of POLICY_FIELDS) {
    if (!Object.hasOwn(record, field)) continue;
    const raw = record[field];
    if (raw !== undefined) normalized[field] = normalizeDuration(raw, field, layer);
  }
  return normalized;
}

export function resolveRunSupervisionPolicy(
  recipe: unknown = {},
  launch: unknown = {},
): ResolvedRunSupervisionPolicy {
  const recipePolicy = normalizeLayer(recipe, "recipe");
  const launchPolicy = normalizeLayer(launch, "launch");
  const select = (field: PolicyField): {
    value: number | null;
    source: RunSupervisionPolicySource;
  } => {
    const launchValue = launchPolicy[field];
    if (launchValue !== undefined) return { value: launchValue, source: "launch" };
    const recipeValue = recipePolicy[field];
    if (recipeValue !== undefined) return { value: recipeValue, source: "recipe" };
    return { value: null, source: "unset" };
  };
  const report = select("report_every");
  const maximum = select("max_runtime");
  return {
    report_every_ms: report.value,
    max_runtime_ms: maximum.value,
    provenance: { report_every: report.source, max_runtime: maximum.source },
  };
}

/** Decode persisted milliseconds without coercing strings or inventing absent settings. */
export function decodeRunSupervisionPolicy(value: unknown): RunSupervisionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored run supervision policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  const read = (field: "report_every_ms" | "max_runtime_ms"): number | null => {
    const milliseconds = Object.hasOwn(record, field) ? record[field] : undefined;
    if (milliseconds === null) return null;
    if (typeof milliseconds === "number" &&
      Number.isSafeInteger(milliseconds) && milliseconds > 0) {
      if (field === "report_every_ms") requireDiagnosticInterval(milliseconds, `stored supervision ${field}`);
      return milliseconds;
    }
    throw new Error(
      `Invalid stored supervision ${field}: expected positive integer milliseconds or null.`,
    );
  };
  return { report_every_ms: read("report_every_ms"), max_runtime_ms: read("max_runtime_ms") };
}

/** Compare already-normalized values, not their provenance or generation clocks. */
export function sameRunSupervisionPolicy(
  left: RunSupervisionPolicy,
  right: RunSupervisionPolicy,
): boolean {
  return left.report_every_ms === right.report_every_ms &&
    left.max_runtime_ms === right.max_runtime_ms;
}

export interface RunSupervisionState extends RunSupervisionPolicy {
  readonly deadline_at: string | null;
}

export interface RunSupervisionClock {
  readonly started_at: string;
  readonly supervision: RunSupervisionState;
}

function timestamp(milliseconds: number, field: string): string {
  if (!Number.isSafeInteger(milliseconds) ||
    !Number.isFinite(new Date(milliseconds).getTime())) {
    throw new Error(`Invalid run supervision ${field}: timestamp is outside the representable millisecond range.`);
  }
  return new Date(milliseconds).toISOString();
}

function parseStart(value: unknown): number {
  if (typeof value !== "string") {
    throw new Error("Invalid run supervision started_at: expected a canonical ISO timestamp.");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || timestamp(milliseconds, "started_at") !== value) {
    throw new Error("Invalid run supervision started_at: expected a canonical ISO timestamp.");
  }
  return milliseconds;
}

export function createRunSupervisionClock(
  policy: unknown,
  startedAtMs: number,
): RunSupervisionClock {
  const normalized = decodeRunSupervisionPolicy(policy);
  const startedAt = timestamp(startedAtMs, "started_at");
  const deadlineAt = normalized.max_runtime_ms === null
    ? null
    : timestamp(startedAtMs + normalized.max_runtime_ms, "deadline_at");
  return {
    started_at: startedAt,
    supervision: { ...normalized, deadline_at: deadlineAt },
  };
}

/** Wholly absent legacy clocks stay absent; decoding never consults current time. */
export function readRunSupervisionClock(value: unknown): RunSupervisionClock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Run supervision clock metadata must be an object.");
  }
  const record = value as Record<string, unknown>;
  const hasStart = Object.hasOwn(record, "started_at");
  const hasPolicy = Object.hasOwn(record, "supervision");
  if (!hasStart && !hasPolicy && !Object.hasOwn(record, "supervision_provenance")) return undefined;
  if (!hasStart || !hasPolicy) throw new Error("Run supervision clock metadata is incomplete.");
  const clock = createRunSupervisionClock(record.supervision, parseStart(record.started_at));
  if (Object.hasOwn(record, "createdAt") && record.createdAt !== clock.started_at) {
    throw new Error("Run supervision started_at contradicts generation creation time.");
  }
  const stored = record.supervision as Record<string, unknown>;
  if (!Object.hasOwn(stored, "deadline_at") || stored.deadline_at !== clock.supervision.deadline_at) {
    throw new Error("Run supervision deadline_at contradicts its captured start and policy.");
  }
  return clock;
}

// --- Runtime-local timing ---

export const RUN_SUPERVISION_TIMER_SLICE_MAX_MS = 2_147_483_647;
export interface RunSupervisionTimeSource {
  wallNow(): number;
  monotonicNow(): { readonly milliseconds: number; readonly epoch: object };
}
export interface RunSupervisionTimeOrigin { readonly wall_ms: number; }
type ClockFault = "clock_unavailable" | "monotonic_unavailable" | "monotonic_reversed" | "monotonic_epoch_changed";
export type RunSupervisionTimeObservation =
  | { readonly state: "available"; readonly elapsed_ms: number; readonly remaining_ms: number | null;
      readonly deadline_state: "pending" | "due" | "disabled"; readonly deadline_wake_ms: number | null }
  | { readonly state: "unproven"; readonly reason: ClockFault; readonly elapsed_ms: null; readonly remaining_ms: null;
      readonly deadline_state: "unproven" | "due" | "disabled"; readonly deadline_wake_ms: 0 | null };
export interface RunSupervisionTimebase {
  readonly clock: Readonly<RunSupervisionClock>;
  readonly observe: () => Readonly<RunSupervisionTimeObservation>;
}
export type RunSupervisionTimebaseReading =
  | { readonly state: "available"; readonly timebase: Readonly<RunSupervisionTimebase> }
  | { readonly state: "unavailable"; readonly reason: "clock_unconfigured" | "clock_invalid" | "origin_unavailable" | "origin_mismatch" | "clock_changed" };
interface OriginEvidence {
  readonly wall: number;
  readonly start: number;
  readonly epoch: object;
  readonly read: RunSupervisionTimeSource["monotonicNow"];
  last: number;
  elapsed: number;
  signature?: string;
  fault?: ClockFault;
}
const origins = new WeakMap<object, OriginEvidence>();
const systemEpoch = Object.freeze({});
const systemSource: RunSupervisionTimeSource = {
  wallNow: () => Date.now(), monotonicNow: () => ({ milliseconds: performance.now(), epoch: systemEpoch }),
};
function monotonic(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }

/** Capture synchronously at generation admission; the returned exact reference, not its DTO, retains continuity. */
export function captureRunSupervisionTimeOrigin(source: RunSupervisionTimeSource = systemSource): Readonly<RunSupervisionTimeOrigin> {
  const wall = source.wallNow();
  createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, wall);
  const read = source.monotonicNow.bind(source); const sample = read();
  const milliseconds = sample?.milliseconds; const epoch = sample?.epoch;
  if (!monotonic(milliseconds) || !epoch || typeof epoch !== "object") {
    throw new Error("Run supervision time origin requires a finite monotonic sample and runtime-local epoch.");
  }
  const origin = Object.freeze({ wall_ms: wall });
  origins.set(origin, { wall, start: milliseconds, last: milliseconds, elapsed: 0, epoch, read });
  return origin;
}

function observe(evidence: OriginEvidence, maximum: number | null): Readonly<RunSupervisionTimeObservation> {
  if (!evidence.fault) {
    try {
      const sample = evidence.read(); const milliseconds = sample?.milliseconds; const epoch = sample?.epoch;
      if (epoch !== evidence.epoch) evidence.fault = "monotonic_epoch_changed";
      else if (!monotonic(milliseconds)) evidence.fault = "monotonic_unavailable";
      else if (milliseconds < evidence.last) evidence.fault = "monotonic_reversed";
      else { evidence.last = milliseconds; evidence.elapsed = Math.floor(milliseconds - evidence.start); }
    } catch { evidence.fault = "clock_unavailable"; }
  }
  const due = maximum !== null && evidence.elapsed >= maximum;
  if (evidence.fault) return Object.freeze({ state: "unproven", reason: evidence.fault, elapsed_ms: null, remaining_ms: null,
    deadline_state: maximum === null ? "disabled" : due ? "due" : "unproven", deadline_wake_ms: due ? 0 : null });
  // Integer subtraction preserves ceil(maximum - elapsed) even when a huge allowance loses fractional precision.
  const remaining = maximum === null ? null : Math.max(0, maximum - evidence.elapsed);
  return Object.freeze({ state: "available", elapsed_ms: evidence.elapsed, remaining_ms: remaining,
    deadline_state: maximum === null ? "disabled" : due ? "due" : "pending",
    deadline_wake_ms: remaining === null ? null : Math.min(remaining, RUN_SUPERVISION_TIMER_SLICE_MAX_MS) });
}

/** Stored metadata alone cannot recreate an origin, renew a budget or clear previously latched clock uncertainty. */
export function createRunSupervisionTimebase(metadata: unknown, origin: unknown): Readonly<RunSupervisionTimebaseReading> {
  let decoded: RunSupervisionClock | undefined;
  try { decoded = readRunSupervisionClock(metadata); }
  catch { return Object.freeze({ state: "unavailable", reason: "clock_invalid" }); }
  if (!decoded) return Object.freeze({ state: "unavailable", reason: "clock_unconfigured" });
  const evidence = origin && typeof origin === "object" ? origins.get(origin) : undefined;
  if (!evidence) return Object.freeze({ state: "unavailable", reason: "origin_unavailable" });
  if (Date.parse(decoded.started_at) !== evidence.wall) return Object.freeze({ state: "unavailable", reason: "origin_mismatch" });
  const signature = JSON.stringify(decoded);
  if (evidence.signature !== undefined && evidence.signature !== signature) return Object.freeze({ state: "unavailable", reason: "clock_changed" });
  evidence.signature = signature;
  const clock = Object.freeze({ started_at: decoded.started_at, supervision: Object.freeze({ ...decoded.supervision }) });
  return Object.freeze({ state: "available", timebase: Object.freeze({ clock, observe: () => observe(evidence, clock.supervision.max_runtime_ms) }) });
}

// --- Deadline observation ---

export interface RunSupervisionDeadlineObservation {
  readonly kind: "run_deadline_due";
  readonly identity: Readonly<RunContextIndexIdentity>;
  readonly deadline_at: string;
  readonly timing: Readonly<RunSupervisionTimeObservation>;
  readonly scope_closure: "not_asserted";
  readonly stop_requested: false;
}
export interface RunSupervisionControllerPorts {
  /** Synchronous caller-admitted state; stored metadata/DTOs never reconstruct work or actuation authority. */
  readCurrent(): { readonly identity: unknown; readonly clock: unknown } | null;
  /** Must enqueue asynchronously and return one synchronous cancellation function. */
  schedule?: (wake: () => void, milliseconds: number) => () => void;
  /** Synchronous observation only, not delivery acceptance or permission to signal/finalize a Run. */
  onDeadlineDue(event: Readonly<RunSupervisionDeadlineObservation>): void;
}
type ControllerReason = "binding_unavailable" | "binding_changed" | "clock_changed" | "clock_invalid" | "clock_unproven" |
  "timer_unavailable" | "timer_provider_invalid" | "notification_failed";
export interface RunSupervisionControllerSnapshot {
  readonly state: "idle" | "armed" | "disabled" | "due" | "stopped" | "unproven";
  readonly identity: Readonly<RunContextIndexIdentity>;
  readonly deadline_due: boolean;
  readonly pending_wake_ms: number | null;
  readonly reason?: ControllerReason;
  readonly timer_cleanup?: "unproven";
}
export interface RunSupervisionController {
  readonly start: () => Readonly<RunSupervisionControllerSnapshot>;
  readonly stop: () => Readonly<RunSupervisionControllerSnapshot>;
  readonly snapshot: () => Readonly<RunSupervisionControllerSnapshot>;
}
function identity(value: unknown): Readonly<RunContextIndexIdentity> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const read = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
  const run = read("run"); const generation = read("run_instance_id"); const owner = read("ownerId");
  if (typeof run !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(run) || typeof generation !== "string" || !generation ||
    (owner !== undefined && (typeof owner !== "string" || !owner))) return undefined;
  return Object.freeze({ run, run_instance_id: generation, ...(owner === undefined ? {} : { ownerId: owner }) });
}
function sameIdentity(a: RunContextIndexIdentity, b: RunContextIndexIdentity): boolean {
  return a.run === b.run && a.run_instance_id === b.run_instance_id && a.ownerId === b.ownerId;
}
function number(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function timingSnapshot(value: RunSupervisionTimeObservation, maximum: number): Readonly<RunSupervisionTimeObservation> | undefined {
  const state = value?.state; const elapsed = value?.elapsed_ms; const remaining = value?.remaining_ms;
  const deadline = value?.deadline_state; const wake = value?.deadline_wake_ms;
  if (state === "available" && number(elapsed) && number(remaining) && remaining === Math.max(0, maximum - elapsed) &&
    deadline === (elapsed >= maximum ? "due" : "pending") && wake === Math.min(remaining, RUN_SUPERVISION_TIMER_SLICE_MAX_MS)) {
    return Object.freeze({ state, elapsed_ms: elapsed, remaining_ms: remaining, deadline_state: deadline, deadline_wake_ms: wake });
  }
  if (state === "unproven" && elapsed === null && remaining === null && (deadline === "due" || deadline === "unproven") && wake === (deadline === "due" ? 0 : null)) {
    const reason = value.reason;
    if (["clock_unavailable", "monotonic_unavailable", "monotonic_reversed", "monotonic_epoch_changed"].includes(reason)) {
      return Object.freeze({ state, reason, elapsed_ms: null, remaining_ms: null, deadline_state: deadline, deadline_wake_ms: deadline === "due" ? 0 : null });
    }
  }
  return undefined;
}
function scheduleNode(wake: () => void, milliseconds: number): () => void {
  const timer = setTimeout(wake, milliseconds); return () => clearTimeout(timer);
}

/** No lifecycle/work lock is held here; the caller owns authoritative state ports and any later admitted action. */
export function createRunSupervisionController(expected: unknown, timebase: RunSupervisionTimebase, ports: RunSupervisionControllerPorts): Readonly<RunSupervisionController> {
  const bound = identity(expected);
  if (!bound) throw new Error("Run supervision controller requires an exact Run/generation/owner binding.");
  const decoded = readRunSupervisionClock(timebase.clock);
  if (!decoded || typeof timebase.observe !== "function") throw new Error("Run supervision controller requires a configured timebase.");
  const clockKey = JSON.stringify(decoded); const maximum = decoded.supervision.max_runtime_ms; const deadlineAt = decoded.supervision.deadline_at;
  const observe = timebase.observe.bind(timebase); const readCurrent = ports.readCurrent.bind(ports);
  const schedule = ports.schedule?.bind(ports) ?? scheduleNode; const notify = ports.onDeadlineDue.bind(ports);
  let state: RunSupervisionControllerSnapshot["state"] = maximum === null ? "disabled" : "idle";
  let started = false; let active = false; let due = false; let reason: ControllerReason | undefined; let cleanup = false;
  let ticket: object | undefined; let cancel: (() => void) | undefined; let pending: number | null = null;
  const snapshot = (): Readonly<RunSupervisionControllerSnapshot> => Object.freeze({ state, identity: bound, deadline_due: due, pending_wake_ms: pending,
    ...(reason ? { reason } : {}), ...(cleanup ? { timer_cleanup: "unproven" as const } : {}) });
  const cancelOnce = (action: () => void): void => { try { action(); } catch { cleanup = true; } };
  const disarm = (): void => { const action = cancel; ticket = undefined; cancel = undefined; pending = null; if (action) cancelOnce(action); };
  const fail = (cause: ControllerReason): void => { active = false; reason ??= cause; if (state !== "stopped") state = "unproven"; disarm(); };
  const checkBinding = (): ControllerReason | undefined => {
    try {
      const current = readCurrent(); const currentIdentity = identity(current?.identity);
      if (!currentIdentity) return "binding_unavailable";
      if (!sameIdentity(bound, currentIdentity)) return "binding_changed";
      const clock = readRunSupervisionClock(current?.clock);
      return clock && JSON.stringify(clock) === clockKey ? undefined : "clock_changed";
    } catch { return "binding_unavailable"; }
  };
  const arm = (milliseconds: number): void => {
    const currentTicket = {}; ticket = currentTicket; pending = milliseconds; state = "armed";
    let scheduling = true; let action: (() => void) | undefined;
    try {
      action = schedule(() => {
        if (!active || ticket !== currentTicket) return;
        if (scheduling) { fail("timer_provider_invalid"); return; }
        ticket = undefined; cancel = undefined; pending = null; step();
      }, milliseconds);
    } catch { cleanup = true; fail("timer_unavailable"); }
    finally { scheduling = false; }
    if (typeof action !== "function") { cleanup = true; if (active) fail("timer_provider_invalid"); return; }
    if (!active || ticket !== currentTicket) cancelOnce(action); else cancel = action;
  };
  const step = (): void => {
    if (!active || maximum === null || deadlineAt === null) return;
    const before = checkBinding(); if (!active) return; if (before) { fail(before); return; }
    let timing: Readonly<RunSupervisionTimeObservation> | undefined;
    try { timing = timingSnapshot(observe(), maximum); } catch { fail("clock_invalid"); return; }
    if (!active) return;
    if (!timing) { fail("clock_invalid"); return; }
    if (timing.deadline_state !== "due" && timing.state === "unproven") { fail("clock_unproven"); return; }
    const after = checkBinding(); if (!active) return; if (after) { fail(after); return; }
    if (timing.deadline_state === "due") {
      due = true; active = false; state = "due";
      const event = Object.freeze({ kind: "run_deadline_due" as const, identity: bound, deadline_at: deadlineAt, timing,
        scope_closure: "not_asserted" as const, stop_requested: false as const });
      try { notify(event); } catch { fail("notification_failed"); }
    } else if (timing.deadline_wake_ms !== null) arm(timing.deadline_wake_ms);
  };
  return Object.freeze({ snapshot, start: () => { if (!started) { started = true; if (maximum !== null && state === "idle") { active = true; step(); } } return snapshot(); },
    stop: () => { active = false; state = "stopped"; disarm(); return snapshot(); } });
}
