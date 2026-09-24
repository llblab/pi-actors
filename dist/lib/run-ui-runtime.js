/**
 * Ambient run observability runtime.
 * Zones: run watcher lifecycle, terminal reconciliation, status animation, shutdown teardown
 * Owns event-driven run UI coordination without owning actor execution semantics.
 */
import * as AsyncRuns from "./async-runs.js";
import * as Limits from "./limits.js";
import * as Observability from "./observability.js";
import * as Paths from "./paths.js";
import * as Pi from "./pi.js";
import * as RunDelivery from "./run-delivery.js";
import * as RunDeliveryLineage from "./run-delivery-lineage.js";
export function createRunUiRuntime(deps) {
    let activeContext;
    let activeOwnerId;
    let animationInterval;
    let deliveryTimeout;
    let notifyTimeout;
    let recoverQueuedSteers = false;
    let running = false;
    let lastWatcherDiagnosticId = 0;
    const observation = Observability.createRunUiObservationState();
    const deliveryObservation = Observability.createRunUiObservationState();
    const retirementAttempts = new Set();
    const steerDiagnostics = new Set();
    const close = () => {
        running = false;
        activeContext = undefined;
        activeOwnerId = undefined;
        try {
            watcher.close();
        }
        catch {
            /* cleanup must not escape a host callback */
        }
        try {
            reconciliation.close();
        }
        catch {
            /* cleanup must not escape a host callback */
        }
        if (notifyTimeout)
            clearTimeout(notifyTimeout);
        notifyTimeout = undefined;
        if (deliveryTimeout)
            clearTimeout(deliveryTimeout);
        deliveryTimeout = undefined;
        recoverQueuedSteers = false;
        steerDiagnostics.clear();
        if (animationInterval)
            clearInterval(animationInterval);
        animationInterval = undefined;
    };
    const stopAfterCallbackFailure = (label, error, expectedContext) => {
        if (activeContext !== expectedContext)
            return;
        close();
        try {
            deps.onCallbackError?.(error);
        }
        catch {
            /* host callback containment must remain no-throw */
        }
        const message = error instanceof Error ? error.message : String(error);
        try {
            expectedContext.ui.notify(`Actor ${label} failed: ${message}`, "error");
        }
        catch {
            /* stale context or unavailable UI */
        }
    };
    const runActiveCallback = (label, callback) => {
        if (!running || !activeContext || !activeOwnerId)
            return;
        const ctx = activeContext;
        try {
            if (deps.getActiveContext() !== ctx)
                return;
            callback(ctx, activeOwnerId);
        }
        catch (error) {
            stopAfterCallbackFailure(label, error, ctx);
        }
    };
    const retireCandidateRuns = (ctx, summary) => {
        void Observability.executeRunRetirements(summary, {
            attempted: retirementAttempts,
            cancelRun: (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
            notify: (message, level) => ctx.ui.notify(message, level),
            sendStop: async (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
        }).catch((error) => stopAfterCallbackFailure("Run retirement callback", error, ctx));
    };
    const journal = (ownerId) => RunDelivery.readRunDeliveryJournal(Paths.EXTENSION_RUNTIME_PATHS.tempDir, ownerId);
    const finishPresentedBatch = (ownerId, batch) => {
        if (batch.phase !== "presented")
            return false;
        for (const member of batch.members) {
            AsyncRuns.markRunTerminalNotificationHandled(member.state_dir, member.status, member.run_instance_id);
        }
        return RunDelivery.finalizeRunCompletionBatch({
            batchId: batch.batch_id,
            ownerId,
            tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
        });
    };
    const recoverPresentedBatch = (ownerId) => {
        const batch = journal(ownerId).completion_batch;
        if (batch?.phase === "presented")
            finishPresentedBatch(ownerId, batch);
    };
    const finishPresentedSteer = (ownerId, steer) => {
        if (steer.phase !== "presented")
            return false;
        AsyncRuns.markRunSteerPresentationHandled(steer.state_dir, steer.run_instance_id, steer.event_id, steer.steer_id);
        return RunDelivery.finalizeRunSteer({
            ownerId,
            steerId: steer.steer_id,
            tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
        });
    };
    const recoverPresentedSteers = (ownerId) => {
        for (const steer of journal(ownerId).steers) {
            if (steer.phase === "presented")
                finishPresentedSteer(ownerId, steer);
        }
    };
    const boundedSteerContent = (event) => {
        const text = Observability.formatRunAttentionMessage(event);
        if (Buffer.byteLength(text, "utf8") <= Limits.RUN_DELIVERY_STEER_MAX_BYTES) {
            return text;
        }
        let end = Math.min(text.length, Limits.RUN_DELIVERY_STEER_MAX_BYTES - 3);
        while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") >
            Limits.RUN_DELIVERY_STEER_MAX_BYTES - 3)
            end -= 1;
        return `${text.slice(0, end)}…`;
    };
    const admitSteerEvents = (ctx, ownerId, events) => {
        for (const event of events.filter(Observability.isRunSteerAttentionEvent)) {
            if (!event.runInstanceId) {
                Observability.retryRunAttentionEvent(observation, event);
                const key = `${event.stateDir}:${event.id}:missing_generation`;
                if (!steerDiagnostics.has(key)) {
                    steerDiagnostics.add(key);
                    ctx.ui.notify(`Actor urgent steer ${event.id} remains retryable because its Run generation is unavailable.`, "warning");
                }
                continue;
            }
            try {
                RunDelivery.admitRunSteerEnvelope({
                    content: boundedSteerContent(event),
                    eventId: event.id,
                    kind: event.kind,
                    level: event.level,
                    occurredAt: event.ts,
                    ownerId,
                    run: event.run,
                    runInstanceId: event.runInstanceId,
                    stateDir: event.stateDir,
                    tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
                });
            }
            catch (error) {
                Observability.retryRunAttentionEvent(observation, event);
                const message = error instanceof Error ? error.message : String(error);
                const key = `${event.stateDir}:${event.id}:${message}`;
                if (!steerDiagnostics.has(key)) {
                    steerDiagnostics.add(key);
                    ctx.ui.notify(`Actor urgent steer ${event.id} remains retryable: ${message.replaceAll(/\s+/g, " ").slice(0, 240)}`, "warning");
                }
            }
        }
    };
    const admitCompletionTransitions = (ownerId, snapshot) => {
        const existing = journal(ownerId).completion_batch;
        if (existing)
            return true;
        const members = Observability.collectRunCompletionBatchMembers(snapshot.transitions, snapshot.summary.runs).slice(0, Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS);
        if (members.length === 0)
            return false;
        RunDelivery.admitRunCompletionBatch({
            members,
            ownerId,
            tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
        });
        return true;
    };
    const isIdle = (ctx) => typeof ctx.isIdle !== "function" || ctx.isIdle();
    const isDeliveryRoot = (ownerId) => {
        const inheritedOwner = RunDeliveryLineage.getProcessDeliveryOwnerId();
        return inheritedOwner === undefined || inheritedOwner === ownerId;
    };
    let flushCompletionBatch = (_ctx) => false;
    const flushSteers = (ctx, ownerId) => {
        const recovering = recoverQueuedSteers;
        for (const steer of journal(ownerId).steers) {
            if (steer.phase === "presented") {
                finishPresentedSteer(ownerId, steer);
                continue;
            }
            let phase = steer.phase;
            if (phase === "queued") {
                if (!recovering)
                    continue;
                const evidence = Pi.inspectRunSteerSessionEvidence(ctx, {
                    content: steer.content,
                    eventId: steer.event_id,
                    steerId: steer.steer_id,
                });
                if (evidence.status === "present")
                    continue;
                if (evidence.status !== "absent") {
                    const key = `${steer.steer_id}:${evidence.status}:${evidence.reason ?? ""}`;
                    if (!steerDiagnostics.has(key)) {
                        steerDiagnostics.add(key);
                        ctx.ui.notify(`Actor urgent steer recovery is ${evidence.status}: ${evidence.reason ?? "conflicting session evidence"}. Event ${steer.event_id} remains queued.`, "warning");
                    }
                    continue;
                }
                if (!RunDelivery.resetRunSteerPending({
                    ownerId,
                    steerId: steer.steer_id,
                    tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
                }))
                    continue;
                phase = "pending";
            }
            if (phase !== "pending")
                continue;
            try {
                Pi.sendRunSteer(deps.pi, {
                    content: steer.content,
                    eventId: steer.event_id,
                    steerId: steer.steer_id,
                });
            }
            catch (error) {
                RunDelivery.recordRunSteerDeliveryFailure({
                    error,
                    ownerId,
                    steerId: steer.steer_id,
                    tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
                });
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Actor urgent steer delivery failed for event ${steer.event_id}: ${message.replaceAll(/\s+/g, " ").slice(0, 240)}`, "error");
                continue;
            }
            RunDelivery.markRunSteerQueued({
                ownerId,
                steerId: steer.steer_id,
                tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
            });
        }
        recoverQueuedSteers = false;
        return journal(ownerId).steers.length > 0;
    };
    const scheduleCompletionFlush = () => {
        if (!running)
            return;
        if (deliveryTimeout)
            clearTimeout(deliveryTimeout);
        deliveryTimeout = setTimeout(() => {
            deliveryTimeout = undefined;
            runActiveCallback("completion delivery callback", (ctx) => {
                flushCompletionBatch(ctx);
            });
        }, deps.deliveryDebounceMs ?? 100);
        deliveryTimeout.unref?.();
    };
    const update = (ctx, ownerId, notify = false, terminalOnly = false) => {
        const snapshot = Observability.readRunUiSnapshot(observation, ownerId);
        ctx.ui.setStatus("zz-pi-actors-runs", snapshot.status ? ctx.ui.theme.fg("dim", snapshot.status) : undefined);
        if (!notify)
            return false;
        const sink = Pi.createNotificationSink(deps.pi, ctx);
        retireCandidateRuns(ctx, snapshot.summary);
        const deliverySnapshot = isDeliveryRoot(ownerId)
            ? Observability.readRunDeliverySnapshot(deliveryObservation, ownerId)
            : undefined;
        const hasCompletionCandidates = deliverySnapshot
            ? Observability.collectRunCompletionBatchMembers(deliverySnapshot.transitions, deliverySnapshot.summary.runs).length > 0
            : false;
        const hasCompletionBatch = isDeliveryRoot(ownerId) &&
            Boolean(journal(ownerId).completion_batch);
        admitSteerEvents(ctx, ownerId, snapshot.attentionEvents);
        Observability.pruneRunUiObservationState(observation, snapshot);
        if (deliverySnapshot) {
            Observability.pruneRunUiObservationState(deliveryObservation, deliverySnapshot);
        }
        if (!terminalOnly) {
            Observability.deliverRunAttentionNotifications(snapshot.attentionEvents.filter((event) => !Observability.isRunSteerAttentionEvent(event)), sink);
        }
        const hasSteers = flushSteers(ctx, ownerId);
        if ((hasCompletionBatch || hasCompletionCandidates) && isIdle(ctx)) {
            scheduleCompletionFlush();
        }
        return hasCompletionBatch || hasCompletionCandidates || hasSteers;
    };
    const reportDiagnostics = (ctx) => {
        for (const diagnostic of watcher.getDiagnostics()) {
            if (diagnostic.id <= lastWatcherDiagnosticId)
                continue;
            lastWatcherDiagnosticId = diagnostic.id;
            ctx.ui.notify(diagnostic.message, diagnostic.code === "rearmed" ? "info" : "warning");
        }
    };
    const scheduleUpdate = () => {
        if (!running)
            return;
        if (notifyTimeout)
            clearTimeout(notifyTimeout);
        notifyTimeout = setTimeout(() => {
            runActiveCallback("Run watcher callback", (ctx, ownerId) => {
                watcher.refresh();
                const completionDeferred = update(ctx, ownerId, true);
                if (!completionDeferred)
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
    const reconciliation = (deps.createRunTerminalReconciliationLoop ??
        Observability.createRunTerminalReconciliationLoop)({
        onError: (error) => {
            if (!running || !activeContext)
                return;
            stopAfterCallbackFailure("terminal reconciliation callback", error, activeContext);
        },
        reconcile: () => {
            runActiveCallback("terminal reconciliation callback", (ctx, ownerId) => {
                update(ctx, ownerId, true);
                reportDiagnostics(ctx);
            });
        },
        refreshWatcher: () => {
            if (running)
                watcher.refresh();
        },
    });
    flushCompletionBatch = (ctx) => {
        const ownerId = activeOwnerId;
        if (!running || !ownerId)
            return false;
        try {
            if (Pi.getSessionId(ctx) !== ownerId)
                return false;
        }
        catch {
            return false;
        }
        if (flushSteers(ctx, ownerId))
            return true;
        if (!isDeliveryRoot(ownerId))
            return false;
        let batch = journal(ownerId).completion_batch;
        if (!batch) {
            const snapshot = Observability.readRunDeliverySnapshot(deliveryObservation, ownerId);
            admitCompletionTransitions(ownerId, snapshot);
            Observability.pruneRunUiObservationState(deliveryObservation, snapshot);
            batch = journal(ownerId).completion_batch;
        }
        if (!batch)
            return false;
        if (batch.phase === "presented") {
            finishPresentedBatch(ownerId, batch);
            const snapshot = Observability.readRunDeliverySnapshot(deliveryObservation, ownerId);
            admitCompletionTransitions(ownerId, snapshot);
            Observability.pruneRunUiObservationState(deliveryObservation, snapshot);
            batch = journal(ownerId).completion_batch;
            if (!batch)
                return false;
        }
        if (!isIdle(ctx))
            return true;
        const content = RunDelivery.formatRunCompletionBatchMessage(batch);
        if (batch.phase === "queued") {
            if (!RunDelivery.markRunCompletionBatchPresented({
                batchId: batch.batch_id,
                ownerId,
                tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
            }))
                return true;
            const accepted = journal(ownerId).completion_batch;
            if (accepted)
                finishPresentedBatch(ownerId, accepted);
            return flushCompletionBatch(ctx);
        }
        if (!isIdle(ctx))
            return true;
        try {
            Pi.sendRunCompletionBatch(deps.pi, batch.batch_id, content);
        }
        catch (error) {
            RunDelivery.recordRunCompletionBatchDeliveryFailure({
                batchId: batch.batch_id,
                error,
                ownerId,
                tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
            });
            throw error;
        }
        if (!RunDelivery.markRunCompletionBatchQueued({
            batchId: batch.batch_id,
            ownerId,
            tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
        })) {
            throw new Error("Completion batch changed before queue acknowledgment");
        }
        if (!RunDelivery.markRunCompletionBatchPresented({
            batchId: batch.batch_id,
            ownerId,
            tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
        })) {
            throw new Error("Completion batch changed before durable acceptance");
        }
        const accepted = journal(ownerId).completion_batch;
        if (accepted)
            finishPresentedBatch(ownerId, accepted);
        ctx.ui.notify(`Actor completions ready: ${batch.members.length}`, "info");
        return true;
    };
    return {
        close,
        flushCompletionBatch,
        projectContext(messages, ctx) {
            const ownerId = activeOwnerId;
            if (!running || !ownerId)
                return messages;
            try {
                if (Pi.getSessionId(ctx) !== ownerId)
                    return messages;
            }
            catch {
                return messages;
            }
            const steerContext = Pi.dedupeRunSteerContext(messages);
            let contextMessages = steerContext.messages;
            for (const steer of journal(ownerId).steers) {
                const presented = steerContext.steers.get(steer.steer_id);
                if (!presented ||
                    presented.eventId !== steer.event_id ||
                    presented.content !== steer.content) {
                    contextMessages = Pi.removeRunSteerFromContext(contextMessages, steer.steer_id);
                    continue;
                }
                if (!RunDelivery.markRunSteerQueued({
                    ownerId,
                    steerId: steer.steer_id,
                    tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
                }))
                    continue;
                if (!RunDelivery.markRunSteerPresented({
                    ownerId,
                    steerId: steer.steer_id,
                    tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
                }))
                    continue;
                const durable = journal(ownerId).steers.find((item) => item.steer_id === steer.steer_id);
                if (durable)
                    finishPresentedSteer(ownerId, durable);
            }
            const projected = Pi.dedupeRunCompletionBatchContext(contextMessages);
            const batch = journal(ownerId).completion_batch;
            if (!batch)
                return projected.messages;
            const content = projected.batches.get(batch.batch_id);
            if (content !== RunDelivery.formatRunCompletionBatchMessage(batch)) {
                return Pi.removeRunCompletionBatchFromContext(projected.messages, batch.batch_id);
            }
            if (!RunDelivery.markRunCompletionBatchQueued({
                batchId: batch.batch_id,
                ownerId,
                tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
            }))
                return projected.messages;
            if (!RunDelivery.markRunCompletionBatchPresented({
                batchId: batch.batch_id,
                ownerId,
                tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
            }))
                return projected.messages;
            const presented = journal(ownerId).completion_batch;
            if (presented)
                finishPresentedBatch(ownerId, presented);
            return projected.messages;
        },
        shutdown(eventReason, ownerId, ctx) {
            if (!ownerId)
                return;
            const teardown = (deps.teardownRunsOwnedByParent ?? AsyncRuns.teardownRunsOwnedByParent)(ownerId, Paths.EXTENSION_RUNTIME_PATHS.runStateRoot, { trigger: `session_shutdown:${eventReason}` });
            if (teardown.failed === 0 || !ctx)
                return;
            try {
                ctx.ui.notify(`Actor shutdown teardown: killed=${teardown.killed} failed=${teardown.failed} skipped=${teardown.skipped} discovery_failed=${teardown.discoveryFailed}. Summary: ${teardown.summaryPath ?? "unavailable"}.`, "warning");
            }
            catch {
                /* stale shutdown context */
            }
        },
        start(ctx, ownerId) {
            close();
            activeContext = ctx;
            activeOwnerId = ownerId;
            recoverQueuedSteers = true;
            running = true;
            try {
                recoverPresentedBatch(ownerId);
                recoverPresentedSteers(ownerId);
                Observability.primeRunAttentionState(observation, ownerId);
                update(ctx, ownerId, true, true);
                watcher.refresh();
                reconciliation.start();
                animationInterval = setInterval(() => {
                    runActiveCallback("status animation callback", (current, currentOwnerId) => update(current, currentOwnerId));
                }, deps.animationIntervalMs ?? 1000);
                animationInterval.unref?.();
            }
            catch (error) {
                close();
                throw error;
            }
        },
    };
}
