/**
 * Ambient run observability runtime.
 * Zones: run watcher lifecycle, terminal reconciliation, status animation, shutdown teardown
 * Owns event-driven run UI coordination without owning actor execution semantics.
 */
import * as AsyncRuns from "./async-runs.ts";
import * as Observability from "./observability.ts";
import * as Pi from "./pi.ts";
export interface RunUiRuntime {
    close(): void;
    flushCompletionBatch(ctx: Pi.ExtensionContext): boolean;
    projectContext(messages: unknown[], ctx: Pi.ExtensionContext): unknown[];
    shutdown(eventReason: string, ownerId: string | undefined, ctx?: Pi.ExtensionContext): void;
    start(ctx: Pi.ExtensionContext, ownerId: string): void;
}
export interface RunUiRuntimeDeps {
    animationIntervalMs?: number;
    createRunStateWatcher?: typeof Observability.createRunStateWatcher;
    createRunTerminalReconciliationLoop?: typeof Observability.createRunTerminalReconciliationLoop;
    deliveryDebounceMs?: number;
    getActiveContext(): Pi.ExtensionContext | undefined;
    notificationDelayMs?: number;
    onCallbackError?: (error: unknown) => void;
    onRunEvent(): void;
    pi: Pi.ExtensionAPI;
    teardownRunsOwnedByParent?: typeof AsyncRuns.teardownRunsOwnedByParent;
}
export declare function createRunUiRuntime(deps: RunUiRuntimeDeps): RunUiRuntime;
