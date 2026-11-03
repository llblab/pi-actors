import { type RunSupervisionClock, type RunSupervisionController, type RunSupervisionControllerPorts, type RunSupervisionControllerSnapshot, type RunSupervisionTimebaseReading, type RunSupervisionTimeObservation } from "./run-supervision.ts";
import { type RunContextIndexIdentity } from "./runs-context-index.ts";
import { type RunSnapshotReferencesReading } from "./runs-context-exports.ts";
import { type RunSnapshotFactsReading } from "./runs-status.ts";
import { type RunSnapshot, type RunSnapshotProjection } from "./runs-snapshot.ts";
import { type RunNaturalResultTimingAdmission, type RunResultProducer } from "./runs-results.ts";
export type RunSupervisionBindingReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly clock: Readonly<RunSupervisionClock>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "identity_unavailable" | "identity_mismatch" | "observation_changed" | "clock_metadata_unavailable" | "clock_unconfigured" | "clock_invalid";
};
type Unavailable = Extract<RunSupervisionBindingReading, {
    state: "unavailable";
}>;
export type BoundRunSupervisionControllerReading = {
    readonly state: "available";
    readonly controller: Readonly<RunSupervisionController>;
} | Unavailable | Extract<RunSupervisionTimebaseReading, {
    state: "unavailable";
}>;
/** Curated metadata only; no current-time read, clock repair, lifecycle/native observation or role body. */
export declare function readRunSupervisionBinding(stateDir: string, expected: unknown): Readonly<RunSupervisionBindingReading>;
/** Does not start automatically; origin must be the genuine reference retained from generation admission. */
export declare function createRunSupervisionControllerFromState(stateDir: string, expected: unknown, origin: unknown, ports: Omit<RunSupervisionControllerPorts, "readCurrent">): Readonly<BoundRunSupervisionControllerReading>;
export type RunSupervisionOwnerReading = {
    readonly state: "retained" | "stopped" | "released";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly controller?: Readonly<RunSupervisionControllerSnapshot>;
} | {
    readonly state: "controlled";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly controller: Readonly<RunSupervisionControllerSnapshot>;
} | {
    readonly state: "unavailable";
    readonly reason: Extract<BoundRunSupervisionControllerReading, {
        state: "unavailable";
    }>["reason"] | "identity_invalid" | "origin_not_retained" | "owner_closed" | "controller_claimed";
};
type OwnerUnavailable = Extract<RunSupervisionOwnerReading, {
    state: "unavailable";
}>;
export type RunSupervisionOwnerTimeReading = {
    readonly state: "available";
    readonly basis: "since_admission";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly timing: Readonly<RunSupervisionTimeObservation>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: OwnerUnavailable["reason"] | "owner_stopped";
};
export type RunSupervisionOwnerReferencesReading = RunSnapshotReferencesReading | OwnerUnavailable | {
    readonly state: "unavailable";
    readonly reason: "owner_stopped" | "references_not_retained";
};
export type RunSupervisionOwnerSnapshotReading = {
    readonly state: "available";
    readonly snapshot: Readonly<RunSnapshot>;
    readonly unchanged: () => boolean;
} | Extract<RunSnapshotProjection | RunSnapshotFactsReading | RunSupervisionOwnerReferencesReading, {
    state: "unavailable";
}>;
export type RunSupervisionOwnerNaturalTimeReading = {
    readonly state: "available";
    readonly basis: "first_natural_acceptance";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly elapsed_ms: number;
    readonly natural_acceptance: Readonly<{
        code: number;
        recorded_status: "done" | "failed";
        completed_at: string;
    }>;
    readonly unchanged: () => boolean;
} | Extract<RunSupervisionOwnerTimeReading, {
    state: "unavailable";
}> | {
    readonly state: "unavailable";
    readonly reason: "natural_time_not_captured" | "natural_time_capturing" | "natural_time_unproven" | "natural_acceptance_mismatch";
};
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
/** Explicit retention with cooperative same-origin claims; no default watcher, cross-process lease or independent supervisor. */
export declare function createRunSupervisionOwner(ports: Omit<RunSupervisionControllerPorts, "readCurrent">): Readonly<RunSupervisionOwner>;
export {};
