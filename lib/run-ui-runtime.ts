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
  shutdown(eventReason: string, ctx: Pi.ExtensionContext): void;
  start(ctx: Pi.ExtensionContext): void;
}

export interface RunUiRuntimeDeps {
  getActiveContext(): Pi.ExtensionContext | undefined;
  getRunOwnerId(ctx: Pi.ExtensionContext): string;
  onRunEvent(): void;
  pi: Pi.ExtensionAPI;
}

export function createRunUiRuntime(deps: RunUiRuntimeDeps): RunUiRuntime {
  let animationInterval: NodeJS.Timeout | undefined;
  let notifyTimeout: NodeJS.Timeout | undefined;
  let lastWatcherDiagnosticId = 0;
  const observation = Observability.createRunUiObservationState();
  const retirementAttempts = new Set<string>();
  const terminalNotificationsInFlight = new Set<string>();

  const retireCandidateRuns = (
    ctx: Pi.ExtensionContext,
    summary: Observability.RunSummary,
  ): void => {
    void Observability.executeRunRetirements(summary, {
      attempted: retirementAttempts,
      cancelRun: (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
      notify: (message, level) => ctx.ui.notify(message, level),
      sendStop: (candidate) => AsyncRuns.sendRunMessage(candidate.stateDir, "stop"),
    });
  };
  const update = (
    ctx: Pi.ExtensionContext,
    notify = false,
    terminalOnly = false,
  ): void => {
    const ownerId = deps.getRunOwnerId(ctx);
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
      Observability.deliverRunOutboxNotifications(snapshot.outboxEvents, sink);
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
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = setTimeout(() => {
      const ctx = deps.getActiveContext();
      if (!ctx) return;
      watcher.refresh();
      update(ctx, true);
      deps.onRunEvent();
      reportDiagnostics(ctx);
    }, 50);
    notifyTimeout.unref?.();
  };
  const watcher = Observability.createRunStateWatcher({
    stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
    onChange: scheduleUpdate,
  });
  const reconciliation = Observability.createRunTerminalReconciliationLoop({
    onError: (error) => {
      const ctx = deps.getActiveContext();
      if (!ctx) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Actor terminal reconciliation failed: ${message}`, "error");
    },
    reconcile: () => {
      const ctx = deps.getActiveContext();
      if (!ctx) return;
      Observability.reconcileRunTerminalNotifications({
        inFlight: terminalNotificationsInFlight,
        ownerId: deps.getRunOwnerId(ctx),
        sink: Pi.createNotificationSink(deps.pi, ctx),
        state: observation,
      });
      reportDiagnostics(ctx);
    },
    refreshWatcher: () => watcher.refresh(),
  });
  const close = (): void => {
    watcher.close();
    reconciliation.close();
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = undefined;
    if (animationInterval) clearInterval(animationInterval);
    animationInterval = undefined;
  };

  return {
    close,
    shutdown(eventReason, ctx) {
      close();
      const teardown = AsyncRuns.teardownRunsOwnedByParent(
        deps.getRunOwnerId(ctx),
        Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
        { trigger: `session_shutdown:${eventReason}` },
      );
      if (teardown.failed === 0) return;
      try {
        ctx.ui.notify(
          `Actor shutdown teardown: killed=${teardown.killed} failed=${teardown.failed} skipped=${teardown.skipped} discovery_failed=${teardown.discoveryFailed}. Summary: ${teardown.summaryPath ?? "unavailable"}.`,
          "warning",
        );
      } catch {
        /* stale shutdown context */
      }
    },
    start(ctx) {
      close();
      update(ctx, true, true);
      watcher.refresh();
      reconciliation.start();
      animationInterval = setInterval(() => {
        if (deps.getActiveContext() === ctx) update(ctx);
      }, 1000);
      animationInterval.unref?.();
    },
  };
}
