/**
 * Ambient run observability runtime.
 * Zones: run watcher lifecycle, terminal reconciliation, status animation, shutdown teardown
 * Owns event-driven run UI/delivery coordination and callback-generation fences; excludes actor execution semantics and public stream activation.
 */
import * as AsyncRuns from "./async-runs.ts";
import * as Observability from "./observability.ts";
import * as Pi from "./pi.ts";
import * as RunDelivery from "./run-delivery.ts";
export interface RunUiRuntime {
    close(): void;
    isCurrentSessionContext(ctx: Pi.ExtensionContext): boolean;
    flushCompletionBatch(ctx: Pi.ExtensionContext): boolean;
    onTurnEnd(event: Pi.TurnEndEvent, ctx: Pi.ExtensionContext): Pi.TurnEndEventResult | undefined;
    projectContext(messages: unknown[], ctx: Pi.ExtensionContext): unknown[];
    shutdown(eventReason: string, ownerId: string | undefined, ctx?: Pi.ExtensionContext): void;
    start(ctx: Pi.ExtensionContext, ownerId: string, event?: Pi.SessionStartEvent): void;
}
export interface RunUiRuntimeDeps {
    /** Trusted kernel opt-in for verified fresh creation; never actor data, continuity proof or bootstrap. */
    completionStreamSessionAdmission?: (ctx: Pi.ExtensionContext, event: Pi.SessionStartEvent) => boolean;
    captureCompletionBatch?: typeof RunDelivery.admitRunCompletionBatch;
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
/** Transcript-only view of the exact delivered content; never re-read a Run or infer body labels. */
export declare function registerRunCompletionRenderer(pi: Pi.ExtensionAPI): void;
export declare function createRunUiRuntime(deps: RunUiRuntimeDeps): RunUiRuntime;
