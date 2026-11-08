import type { RunContextIndexIdentity } from "./runs-context-index.ts";
/** Shared lower bound for Run report policies and root-session diagnostic batches. */
export declare const RUN_DIAGNOSTIC_MIN_INTERVAL_MS = 60000;
type PolicyLayer = "recipe" | "launch";
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
export declare function resolveRunSupervisionPolicy(recipe?: unknown, launch?: unknown): ResolvedRunSupervisionPolicy;
/** Decode persisted milliseconds without coercing strings or inventing absent settings. */
export declare function decodeRunSupervisionPolicy(value: unknown): RunSupervisionPolicy;
/** Compare already-normalized values, not their provenance or generation clocks. */
export declare function sameRunSupervisionPolicy(left: RunSupervisionPolicy, right: RunSupervisionPolicy): boolean;
export interface RunSupervisionState extends RunSupervisionPolicy {
    readonly deadline_at: string | null;
}
export interface RunSupervisionClock {
    readonly started_at: string;
    readonly supervision: RunSupervisionState;
}
export declare function createRunSupervisionClock(policy: unknown, startedAtMs: number): RunSupervisionClock;
/** Wholly absent legacy clocks stay absent; decoding never consults current time. */
export declare function readRunSupervisionClock(value: unknown): RunSupervisionClock | undefined;
export declare const RUN_SUPERVISION_TIMER_SLICE_MAX_MS = 2147483647;
export interface RunSupervisionTimeSource {
    wallNow(): number;
    monotonicNow(): {
        readonly milliseconds: number;
        readonly epoch: object;
    };
}
export interface RunSupervisionTimeOrigin {
    readonly wall_ms: number;
}
type ClockFault = "clock_unavailable" | "monotonic_unavailable" | "monotonic_reversed" | "monotonic_epoch_changed";
export type RunSupervisionTimeObservation = {
    readonly state: "available";
    readonly elapsed_ms: number;
    readonly remaining_ms: number | null;
    readonly deadline_state: "pending" | "due" | "disabled";
    readonly deadline_wake_ms: number | null;
} | {
    readonly state: "unproven";
    readonly reason: ClockFault;
    readonly elapsed_ms: null;
    readonly remaining_ms: null;
    readonly deadline_state: "unproven" | "due" | "disabled";
    readonly deadline_wake_ms: 0 | null;
};
export interface RunSupervisionTimebase {
    readonly clock: Readonly<RunSupervisionClock>;
    readonly observe: () => Readonly<RunSupervisionTimeObservation>;
}
export type RunSupervisionTimebaseReading = {
    readonly state: "available";
    readonly timebase: Readonly<RunSupervisionTimebase>;
} | {
    readonly state: "unavailable";
    readonly reason: "clock_unconfigured" | "clock_invalid" | "origin_unavailable" | "origin_mismatch" | "clock_changed";
};
/** Capture synchronously at generation admission; the returned exact reference, not its DTO, retains continuity. */
export declare function captureRunSupervisionTimeOrigin(source?: RunSupervisionTimeSource): Readonly<RunSupervisionTimeOrigin>;
/** Stored metadata alone cannot recreate an origin, renew a budget or clear previously latched clock uncertainty. */
export declare function createRunSupervisionTimebase(metadata: unknown, origin: unknown): Readonly<RunSupervisionTimebaseReading>;
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
    readCurrent(): {
        readonly identity: unknown;
        readonly clock: unknown;
    } | null;
    /** Must enqueue asynchronously and return one synchronous cancellation function. */
    schedule?: (wake: () => void, milliseconds: number) => () => void;
    /** Synchronous observation only, not delivery acceptance or permission to signal/finalize a Run. */
    onDeadlineDue(event: Readonly<RunSupervisionDeadlineObservation>): void;
}
type ControllerReason = "binding_unavailable" | "binding_changed" | "clock_changed" | "clock_invalid" | "clock_unproven" | "timer_unavailable" | "timer_provider_invalid" | "notification_failed";
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
/** No lifecycle/work lock is held here; the caller owns authoritative state ports and any later admitted action. */
export declare function createRunSupervisionController(expected: unknown, timebase: RunSupervisionTimebase, ports: RunSupervisionControllerPorts): Readonly<RunSupervisionController>;
export {};
