/**
 * Async run status and log readers.
 * Owns: status derivation, readonly canonical snapshot-fact admission and bounded log/event tails.
 * Excludes: snapshot timing/visibility authority, export publication, scheduling and native scope closure.
 */
import type { RunSnapshotFacts } from "./runs-snapshot.ts";
export type AsyncRunStatus = "running" | "done" | "failed" | "exited" | "cancelled" | "killed";
type RunJsonReader = (path: string) => Record<string, unknown> | undefined;
export declare function buildRunStatus(stateDir: string, runOrDir: string, meta: Record<string, unknown>, readJson: RunJsonReader, _runnerPath: string, _runnerIdentityGraceMs: number): Record<string, unknown>;
/** Fixed kernel inventory path. Native frames are synchronous locals, never capabilities returned to consumers. */
export declare function readRunInventoryStatuses(stateDirs: readonly string[], readJson: RunJsonReader, scalarStatus: (stateDir: string) => Record<string, unknown>): (Record<string, unknown> | undefined)[];
export type RunSnapshotFactsReading = {
    readonly state: "available";
    readonly facts: Readonly<RunSnapshotFacts>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "identity_unavailable" | "identity_mismatch" | "observation_changed" | "observation_unavailable" | "references_unavailable" | "snapshot_too_large";
};
/** Kernel-local facts only. Opt-in timing must be the original retained owner's method, never actor data or a cached DTO. */
export declare function readRunSnapshotFacts(stateDir: string, expected: unknown, capturedAt: unknown, observeTime?: (expected: unknown, stateDir?: string) => unknown, observeFrozenNaturalTime?: (expected: unknown, stateDir?: string) => unknown): Readonly<RunSnapshotFactsReading>;
export declare function tailFile(path: string, lines: number): string;
export declare function tailLines(path: string, lines: number): string[];
export {};
