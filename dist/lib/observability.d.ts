/**
 * Async run observability helpers
 * Zones: async runtime, ambient UI, diagnostics
 * Owns ambient summaries, terminal events, and Trace-attention delivery for detached Runs
 */
import { type FSWatcher } from "node:fs";
import * as AsyncRuns from "./async-runs.ts";
import type { RunCompletionBatchMember } from "./run-delivery.ts";
export type RunObservedStatus = "running" | "done" | "failed" | "exited" | "cancelled" | "killed";
export type RunTraceAttention = "log" | "notify" | "followup" | "steer";
export type RunTraceLevel = "info" | "warning" | "error";
export interface RunObservation {
    activeSubagents?: number;
    completed?: number;
    descendantSubagents?: number;
    deliveryOwnerId?: string;
    deliveryParent?: {
        run: string;
        run_instance_id: string;
        state_dir: string;
    };
    failures?: number;
    ownerId?: string;
    artifacts?: Record<string, string>;
    launchCorrelation?: Record<string, string>;
    launchSource?: AsyncRuns.AsyncRunLaunchSource;
    modelPolicy?: Record<string, unknown>;
    notificationPolicy?: "normal" | "silent";
    recipeFile?: string;
    terminalHandled?: boolean;
    retireWhen?: string;
    run: string;
    runInstanceId?: string;
    semanticResult?: RunTerminalSemanticResult;
    tool?: string;
    stateDir?: string;
    status: RunObservedStatus;
    updatedAt?: string;
}
export interface RunSummary {
    cancelled: number;
    done: number;
    exited: number;
    failed: number;
    killed: number;
    running: number;
    runningSubagents: number;
    runs: RunObservation[];
    total: number;
}
export interface RunUiObservationState {
    attentionEventIds: Map<string, Set<string>>;
    legacyEventLines: Map<string, number>;
    frame: number;
    observed: Map<string, RunObservedStatus>;
}
export interface RunUiSnapshot {
    attentionEvents: RunAttentionEvent[];
    status: string | undefined;
    summary: RunSummary;
    transitions: RunTransition[];
}
export interface RunUiNotificationSink {
    notify(message: string, level: "info" | "warning" | "error"): void;
    sendFollowUp(message: {
        customType: string;
        content: string;
        display: false;
        details: unknown;
    }): void;
}
export declare function createRunUiObservationState(): RunUiObservationState;
export declare function primeRunAttentionState(state: RunUiObservationState, ownerId: string, stateRoot?: string): void;
export declare function readRunUiSnapshot(state: RunUiObservationState, ownerId: string, options?: {
    includeAttention?: boolean;
    stateRoot?: string;
}): RunUiSnapshot;
/** Observe every Run generation routed to one root coordinator. */
export declare function readRunDeliverySnapshot(state: RunUiObservationState, deliveryOwnerId: string, stateRoot?: string): RunUiSnapshot;
export declare function pruneRunUiObservationState(state: RunUiObservationState, snapshot: Pick<RunUiSnapshot, "summary" | "transitions">): void;
export declare function deliverRunAttentionNotifications(events: RunAttentionEvent[], sink: RunUiNotificationSink): void;
export interface RunRetirementCandidate {
    activeSubagents: number;
    childRuns: number;
    descendantSubagents: number;
    run: string;
    stateDir: string;
    terminalChildRuns: number;
}
export interface RunRetirementExecution {
    action: "stop" | "cancel" | "skip" | "failed";
    error?: string;
    run: string;
    stateDir: string;
}
export type RunStateWatcherDiagnosticCode = "attach_failed" | "error" | "removed" | "rearmed";
export interface RunStateWatcherDiagnostic {
    code: RunStateWatcherDiagnosticCode;
    id: number;
    message: string;
    path: string;
    scope: "root" | "run";
    ts: string;
}
export interface RunStateWatcher {
    close(): void;
    getDiagnostics(): RunStateWatcherDiagnostic[];
    refresh(): void;
}
export declare function createRunStateWatcher(input: {
    exists?: (path: string) => boolean;
    listDirectories?: (path: string) => string[];
    onChange: () => void;
    stateRoot?: string;
    watchPath?: (path: string, onChange: () => void) => FSWatcher;
}): RunStateWatcher;
export interface RunTerminalReconciliationLoop {
    close(): void;
    reconcileNow(): void;
    start(): void;
}
export declare function createRunTerminalReconciliationLoop(input: {
    intervalMs?: number;
    onError?: (error: unknown) => void;
    reconcile: () => void;
    refreshWatcher: () => void;
}): RunTerminalReconciliationLoop;
export interface RunRetirementExecutorOptions {
    attempted?: Set<string>;
    cancelRun: (candidate: RunRetirementCandidate) => Record<string, unknown>;
    notify?: (message: string, level: "info" | "warning" | "error") => void;
    sendStop: (candidate: RunRetirementCandidate) => Promise<unknown>;
}
export interface RunTransition {
    deliveryParent?: {
        run: string;
        run_instance_id: string;
        state_dir: string;
    };
    from: RunObservedStatus;
    run: string;
    runInstanceId?: string;
    stateDir?: string;
    terminalAt?: string;
    artifacts?: Record<string, string>;
    launchCorrelation?: Record<string, string>;
    launchSource?: AsyncRuns.AsyncRunLaunchSource;
    modelPolicy?: Record<string, unknown>;
    recipeFile?: string;
    terminalHandled?: boolean;
    to: RunObservedStatus;
    tool?: string;
    semanticResult?: RunTerminalSemanticResult;
}
export interface RunTerminalSemanticResult {
    body?: string;
    correlationId?: string;
    metadata: Record<string, unknown>;
    summary: string;
    synthesized: boolean;
    type: string;
}
export interface RunAttentionEvent {
    body?: unknown;
    data?: unknown;
    attention: RunTraceAttention;
    id: string;
    kind: string;
    level: RunTraceLevel;
    metadata?: Record<string, unknown>;
    run: string;
    runInstanceId?: string;
    stateDir: string;
    summary: string;
    ts: string;
}
export type RunTransitionNotificationType = "info" | "warning" | "error";
export declare function summarizeRuns(stateRoot?: string, ownerId?: string, deliveryOwnerId?: string): RunSummary;
export declare function countRunningSubagentsByRun(stateRoot?: string, ownerId?: string): Map<string, number>;
export declare function countRunningSubagents(stateRoot?: string, ownerId?: string): number;
export declare function renderSubagentStatus(count: number, frame?: number): string | undefined;
export declare function renderRunStatus(summary: RunSummary, frame?: number): string | undefined;
export declare function findRunRetirementCandidates(summary: RunSummary): RunRetirementCandidate[];
export declare function executeRunRetirements(summary: RunSummary, options: RunRetirementExecutorOptions): Promise<RunRetirementExecution[]>;
export declare function detectRunTransitions(previous: Map<string, RunObservedStatus>, summary: RunSummary): RunTransition[];
export declare function pruneRunObservationState(previousStatuses: Map<string, RunObservedStatus>, previousLineCounts: Map<string, number>, summary: RunSummary, terminalRuns?: Iterable<string>, seenEventIds?: Map<string, Set<string>>): void;
export declare function detectRunAttentionEvents(legacyLineCounts: Map<string, number>, summary: RunSummary, seenEventIds?: Map<string, Set<string>>, prime?: boolean): RunAttentionEvent[];
export declare function getRunAttentionNotificationType(event: RunAttentionEvent): RunTransitionNotificationType;
export declare function shouldNotifyRunAttentionEvent(event: RunAttentionEvent): boolean;
export declare function isRunSteerAttentionEvent(event: RunAttentionEvent): boolean;
export declare function retryRunAttentionEvent(state: RunUiObservationState, event: Pick<RunAttentionEvent, "id" | "stateDir">): void;
export declare function shouldSendRunAttentionFollowUp(event: RunAttentionEvent): boolean;
export declare function formatRunAttentionMessage(event: RunAttentionEvent): string;
export declare function getRunTransitionNotificationType(transition: RunTransition): RunTransitionNotificationType;
export declare function shouldNotifyRunTransition(transition: RunTransition): boolean;
/** Build exact immutable members only after each containing root Run is terminal. */
export declare function collectRunCompletionBatchMembers(transitions: RunTransition[], deliveryRuns?: RunObservation[]): RunCompletionBatchMember[];
export declare function formatRunTransitionMessage(transition: RunTransition): string;
