/**
 * Ambient run observability runtime.
 * Zones: run watcher lifecycle, terminal reconciliation, status animation, shutdown teardown
 * Owns event-driven run UI coordination without owning actor execution semantics.
 */

import * as AsyncRuns from "./async-runs.ts";
import * as Observability from "./observability.ts";
import * as Paths from "./paths.ts";
import * as Pi from "./pi.ts";

export interface RunUiRuntime {
  close(): void;
  shutdown(
    eventReason: string,
    ownerId: string | undefined,
    ctx?: Pi.ExtensionContext,
  ): void;
  start(ctx: Pi.ExtensionContext, ownerId: string): void;
}

export interface RunUiRuntimeDeps {
  animationIntervalMs?: number;
  createRunStateWatcher?: typeof Observability.createRunStateWatcher;
  createRunTerminalReconciliationLoop?:
    typeof Observability.createRunTerminalReconciliationLoop;
  getActiveContext(): Pi.ExtensionContext | undefined;
  notificationDelayMs?: number;
  onCallbackError?: (error: unknown) => void;
  onRunEvent(): void;
  pi: Pi.ExtensionAPI;
  teardownRunsOwnedByParent?: typeof AsyncRuns.teardownRunsOwnedByParent;
}

export function createRunUiRuntime(deps: RunUiRuntimeDeps): RunUiRuntime {
  let activeContext: Pi.ExtensionContext | undefined;
  let activeOwnerId: string | undefined;
  let animationInterval: NodeJS.Timeout | undefined;
  let notifyTimeout: NodeJS.Timeout | undefined;
  let running = false;
  let lastWatcherDiagnosticId = 0;
  const observation = Observability.createRunUiObservationState();
  const retirementAttempts = new Set<string>();
  const terminalNotificationsInFlight = new Set<string>();

  const close = (): void => {
    running = false;
    activeContext = undefined;
    activeOwnerId = undefined;
    try {
      watcher.close();
    } catch {
      /* cleanup must not escape a host callback */
    }
    try {
      reconciliation.close();
    } catch {
      /* cleanup must not escape a host callback */
    }
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = undefined;
    if (animationInterval) clearInterval(animationInterval);
    animationInterval = undefined;
  };
  const stopAfterCallbackFailure = (
    label: string,
    error: unknown,
    expectedContext: Pi.ExtensionContext,
  ): void => {
    if (activeContext !== expectedContext) return;
    close();
    try {
      deps.onCallbackError?.(error);
    } catch {
      /* host callback containment must remain no-throw */
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      expectedContext.ui.notify(`Actor ${label} failed: ${message}`, "error");
    } catch {
      /* stale context or unavailable UI */
    }
  };
  const runActiveCallback = (
    label: string,
    callback: (ctx: Pi.ExtensionContext, ownerId: string) => void,
  ): void => {
    if (!running || !activeContext || !activeOwnerId) return;
    const ctx = activeContext;
    try {
      if (deps.getActiveContext() !== ctx) return;
      callback(ctx, activeOwnerId);
    } catch (error) {
      stopAfterCallbackFailure(label, error, ctx);
    }
  };
  const retireCandidateRuns = (
    ctx: Pi.ExtensionContext,
    summary: Observability.RunSummary,
  ): void => {
    void Observability.executeRunRetirements(summary, {
      attempted: retirementAttempts,
      cancelRun: (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
      notify: (message, level) => ctx.ui.notify(message, level),
      sendStop: async (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
    }).catch((error) =>
      stopAfterCallbackFailure("Run retirement callback", error, ctx),
    );
  };
  const update = (
    ctx: Pi.ExtensionContext,
    ownerId: string,
    notify = false,
    terminalOnly = false,
  ): void => {
    const snapshot = Observability.readRunUiSnapshot(observation, ownerId);
    ctx.ui.setStatus(
      "zz-pi-actors-runs",
      snapshot.status ? ctx.ui.theme.fg("dim", snapshot.status) : undefined,
    );
    if (!notify) return;
    const sink = Pi.createNotificationSink(deps.pi, ctx);
    retireCandidateRuns(ctx, snapshot.summary);
    Observability.deliverRunTransitionNotifications(
      snapshot.transitions,
      sink,
      terminalNotificationsInFlight,
    );
    Observability.pruneRunUiObservationState(observation, snapshot);
    if (!terminalOnly) {
      Observability.deliverRunAttentionNotifications(snapshot.attentionEvents, sink);
    }
  };
  const reportDiagnostics = (ctx: Pi.ExtensionContext): void => {
    for (const diagnostic of watcher.getDiagnostics()) {
      if (diagnostic.id <= lastWatcherDiagnosticId) continue;
      lastWatcherDiagnosticId = diagnostic.id;
      ctx.ui.notify(
        diagnostic.message,
        diagnostic.code === "rearmed" ? "info" : "warning",
      );
    }
  };
  const scheduleUpdate = (): void => {
    if (!running) return;
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = setTimeout(() => {
      runActiveCallback("Run watcher callback", (ctx, ownerId) => {
        watcher.refresh();
        update(ctx, ownerId, true);
        deps.onRunEvent();
        reportDiagnostics(ctx);
      });
    }, deps.notificationDelayMs ?? 50);
    notifyTimeout.unref?.();
  };
  const watcher = (deps.createRunStateWatcher ?? Observability.createRunStateWatcher)({
    stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
    onChange: scheduleUpdate,
  });
  const reconciliation = (
    deps.createRunTerminalReconciliationLoop ??
    Observability.createRunTerminalReconciliationLoop
  )({
    onError: (error) => {
      if (!running || !activeContext) return;
      stopAfterCallbackFailure(
        "terminal reconciliation callback",
        error,
        activeContext,
      );
    },
    reconcile: () => {
      runActiveCallback("terminal reconciliation callback", (ctx, ownerId) => {
        Observability.reconcileRunTerminalNotifications({
          inFlight: terminalNotificationsInFlight,
          ownerId,
          sink: Pi.createNotificationSink(deps.pi, ctx),
          state: observation,
          includeAttention: true,
        });
        reportDiagnostics(ctx);
      });
    },
    refreshWatcher: () => {
      if (running) watcher.refresh();
    },
  });

  return {
    close,
    shutdown(eventReason, ownerId, ctx) {
      if (!ownerId) return;
      const teardown = (
        deps.teardownRunsOwnedByParent ?? AsyncRuns.teardownRunsOwnedByParent
      )(
        ownerId,
        Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
        { trigger: `session_shutdown:${eventReason}` },
      );
      if (teardown.failed === 0 || !ctx) return;
      try {
        ctx.ui.notify(
          `Actor shutdown teardown: killed=${teardown.killed} failed=${teardown.failed} skipped=${teardown.skipped} discovery_failed=${teardown.discoveryFailed}. Summary: ${teardown.summaryPath ?? "unavailable"}.`,
          "warning",
        );
      } catch {
        /* stale shutdown context */
      }
    },
    start(ctx, ownerId) {
      close();
      activeContext = ctx;
      activeOwnerId = ownerId;
      running = true;
      try {
        Observability.primeRunAttentionState(observation, ownerId);
        update(ctx, ownerId, true, true);
        watcher.refresh();
        reconciliation.start();
        animationInterval = setInterval(() => {
          runActiveCallback("status animation callback", (current, currentOwnerId) =>
            update(current, currentOwnerId),
          );
        }, deps.animationIntervalMs ?? 1000);
        animationInterval.unref?.();
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
