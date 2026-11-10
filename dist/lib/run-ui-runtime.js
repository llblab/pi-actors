/**
 * Ambient run observability runtime.
 * Zones: run watcher lifecycle, terminal reconciliation, status animation, shutdown teardown
 * Owns event-driven run UI/delivery coordination and callback-generation fences; excludes actor execution semantics and public stream activation.
 */
import { Container, Markdown, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import * as AsyncRuns from "./async-runs.js";
import * as Limits from "./limits.js";
import * as Observability from "./observability.js";
import * as Paths from "./paths.js";
import * as Pi from "./pi.js";
import * as RunDelivery from "./run-delivery.js";
import * as RunDeliveryLineage from "./run-delivery-lineage.js";
import * as RunIndex from "./runs-index.js";
import { formatYamlNotice } from "./tools-response.js";
function formatSteerDiagnosticMessage(eventId, stage, message) {
    let end = Math.min(message.length, 240);
    const last = message.charCodeAt(end - 1), next = message.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        end -= 1;
    const preview = message.slice(0, end), clipped = end < message.length;
    // The 240-pair-aligned preview and its explicit unknown-loss marker are unchanged; only metadata is YAML.
    const diagnostic = Buffer.from(preview).toString("utf8") !== preview
        ? { diagnostic: "unavailable", diagnostic_reason: "malformed legacy preview", diagnostic_omission: "[omitted: unknown]" }
        : { diagnostic: preview + (clipped ? "…" : ""), ...(clipped ? { diagnostic_omission: "[omitted: unknown]" } : {}) };
    return formatYamlNotice({ event: eventId, attention: "steer", stage,
        result: stage === "admission" ? "remains retryable" : "request failed",
        ...(stage === "delivery" ? { delivery: "unconfirmed", presentation: "unconfirmed" } : {}),
        ...diagnostic });
}
/** Transcript-only view of the exact delivered content; never re-read a Run or infer body labels. */
export function registerRunCompletionRenderer(pi) {
    pi.registerMessageRenderer(Pi.RUN_COMPLETION_BATCH_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
        if (typeof message.content !== "string")
            return undefined;
        let presentation;
        try {
            presentation = Object.getOwnPropertyDescriptor(message.details, "pi_actors_presentation")?.value;
        }
        catch { /* no layout hint */ }
        const view = RunDelivery.readRunCompletionPresentation(message.content, presentation);
        if (!view)
            return undefined;
        if (!expanded && view.segments) {
            const component = new Container(), markdownTheme = { ...Pi.getMarkdownTheme(), codeBlockIndent: "" };
            component.addChild(new Spacer(1));
            let pieces = 0;
            for (const segment of view.segments) {
                // Only compiler separator/marker chunks drive spacing; whitespace bodies remain Markdown.
                if (segment.kind === "separator" || (segment.kind === "marker" && /^\n+$/u.test(segment.text)))
                    continue;
                if (pieces++)
                    component.addChild(new Spacer(1));
                const text = stripTerminalSequences(segment.text).replaceAll(/\r\n|\r/gu, "\n");
                component.addChild(segment.kind === "body"
                    ? new Markdown(text, outputPad, 0, markdownTheme, { color: value => theme.fg("customMessageText", value) })
                    : new Text(theme.fg("muted", text), outputPad, 0));
            }
            component.addChild(new Spacer(1));
            component.addChild(new Text(theme.fg("muted", "Expand message for technical details."), outputPad, 0));
            component.addChild(new Spacer(1));
            return component;
        }
        if (!expanded && view.blocks) {
            const component = new Container(), markdownTheme = { ...Pi.getMarkdownTheme(), codeBlockIndent: "" };
            component.addChild(new Spacer(1));
            for (const [index, [kind, start, end]] of view.blocks.entries()) {
                if (index)
                    component.addChild(new Spacer(1));
                let text = stripTerminalSequences(message.content.slice(start, end)).replaceAll(/\r\n|\r/gu, "\n");
                if (kind === "header") {
                    // Only validated compiler headers may hide whole reference rows; body lookalikes stay visible.
                    text = text.split("\n").filter(line => !line.startsWith("references: ") && !line.startsWith("run_files: ")).join("\n").replace(/\n$/u, "");
                }
                component.addChild(kind === "body"
                    ? new Markdown(text, outputPad, 0, markdownTheme, { color: value => theme.fg("customMessageText", value) })
                    : new Text(theme.fg(kind === "header" || kind === "marker" ? "muted" : "customMessageText", text), outputPad, 0));
            }
            component.addChild(new Spacer(1));
            component.addChild(new Text(theme.fg("muted", "Expand message for technical details."), outputPad, 0));
            component.addChild(new Spacer(1));
            return component;
        }
        const text = expanded ? message.content : view.text;
        const label = view.yaml || (view.records && !view.single) ? "" : theme.fg("customMessageLabel", view.single ? "Run result" : "Run Batch") + "\n\n";
        return new Text(label + theme.fg("customMessageText", stripTerminalSequences(text).replaceAll(/\r\n|\r/gu, "\n"))
            + (!expanded && view.compact ? "\n\n" + theme.fg("muted", "Expand message for technical details.") : ""), outputPad, 1);
    });
}
export function createRunUiRuntime(deps) {
    if (deps.captureCompletionBatch && deps.completionStreamSessionAdmission)
        throw new Error("Candidate completion capture cannot use completion streams");
    const fencedCompletionSession = Boolean(deps.captureCompletionBatch || deps.completionStreamSessionAdmission);
    let activeContext;
    let activeOwnerId;
    let sessionTicket;
    let sessionManager;
    let streamSessionAdmitted = false;
    const contextTickets = new WeakMap();
    const seenManagers = new WeakSet();
    let animationInterval;
    let displayRunningSubagents = 0;
    let displayFrame = 0;
    let deliveryTimeout;
    let notifyTimeout;
    let recoverQueuedSteers = false;
    let running = false;
    let lastWatcherDiagnosticId = 0;
    const observation = Observability.createRunUiObservationState();
    const deliveryObservation = Observability.createRunUiObservationState();
    const retirementAttempts = new Set();
    const steerDiagnostics = new Set();
    const completionDiagnostics = new Set();
    const close = () => {
        running = false;
        displayRunningSubagents = 0;
        displayFrame = 0;
        sessionTicket = undefined;
        sessionManager = undefined;
        streamSessionAdmitted = false;
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
        completionDiagnostics.clear();
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
            expectedContext.ui.notify(formatYamlNotice({ callback: label, result: "failed", diagnostic: message }), "error");
        }
        catch {
            /* stale context or unavailable UI */
        }
    };
    const runActiveCallback = (label, callback, expectedTicket) => {
        if (expectedTicket !== sessionTicket || !running || !activeContext || !activeOwnerId)
            return;
        const ctx = activeContext;
        try {
            if (deps.getActiveContext() !== ctx)
                return;
            callback(ctx, activeOwnerId);
        }
        catch (error) {
            if (expectedTicket === sessionTicket)
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
    const admitSteerEvents = (ctx, ownerId, events) => {
        for (const event of events.filter(Observability.isRunSteerAttentionEvent)) {
            if (!event.runInstanceId) {
                Observability.retryRunAttentionEvent(observation, event);
                const key = `${event.stateDir}:${event.id}:missing_generation`;
                if (!steerDiagnostics.has(key)) {
                    steerDiagnostics.add(key);
                    ctx.ui.notify(formatSteerDiagnosticMessage(event.id, "admission", "Run generation unavailable."), "warning");
                }
                continue;
            }
            try {
                if (journal(ownerId).steers.some(steer => steer.run === event.run && steer.state_dir === event.stateDir &&
                    steer.run_instance_id === event.runInstanceId && steer.event_id === event.id))
                    continue;
                RunDelivery.admitRunSteerEnvelope({
                    content: Observability.formatRunSteerMessage(event),
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
                    ctx.ui.notify(formatSteerDiagnosticMessage(event.id, "admission", message), "warning");
                }
            }
        }
    };
    const admitCompletionTransitions = (ctx, ownerId, snapshot) => {
        const existing = journal(ownerId).completion_batch;
        if (existing)
            return true;
        const members = Observability.collectRunCompletionBatchMembers(snapshot.transitions, snapshot.summary.runs).slice(0, Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS);
        if (members.length === 0 || !isCurrentOwner(ctx))
            return false;
        const fileNavigation = [];
        for (const member of RunDelivery.orderRunCompletionMembers(members, true)) {
            let locations;
            try {
                const observed = snapshot.summary.runs.find(run => run.run === member.run && run.runInstanceId === member.run_instance_id && run.stateDir === member.state_dir);
                locations = !observed ? Object.freeze({ state: "unavailable", reason: "identity_unavailable" })
                    : observed.ownerId !== ownerId ? Object.freeze({ state: "unavailable", reason: "session_mismatch" })
                        : RunIndex.readRunDirectoryNavigation(member.state_dir, { run: member.run, run_instance_id: member.run_instance_id, ownerId: observed.ownerId }, Pi.getSessionId(ctx));
            }
            catch {
                locations = Object.freeze({ state: "unavailable", reason: "navigation_unavailable" });
            }
            fileNavigation.push({ member_index: members.indexOf(member), locations });
            if (Buffer.byteLength(JSON.stringify(fileNavigation), "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) {
                fileNavigation.pop();
                break;
            }
        }
        if (!isCurrentOwner(ctx))
            return false;
        if (!canUseCompletionSession(ctx, ownerId))
            return false;
        const capture = deps.completionStreamSessionAdmission ? RunDelivery.captureRunCompletionStreamBatch : deps.captureCompletionBatch ?? RunDelivery.admitRunCompletionBatch;
        capture({
            members,
            fileNavigation,
            ownerId,
            tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
        });
        return true;
    };
    const acceptCompletionBatch = (ownerId, batchId) => {
        const input = { batchId, ownerId, tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir };
        if (!RunDelivery.markRunCompletionBatchQueued(input))
            return false;
        if (!RunDelivery.markRunCompletionBatchPresented(input))
            return false;
        const accepted = journal(ownerId).completion_batch;
        return accepted ? finishPresentedBatch(ownerId, accepted) : false;
    };
    const reconcileCompletionBatch = (ctx, ownerId) => {
        const batch = journal(ownerId).completion_batch;
        if (!batch)
            return false;
        if (batch.phase === "pending") {
            // Returning boundary drafts is not acceptance: prove the exact entry before acknowledging it.
            const evidence = Pi.inspectRunCompletionBatchSessionEvidence(ctx, {
                batchId: batch.batch_id,
                content: RunDelivery.formatRunCompletionBatchMessage(batch),
            });
            if (evidence.status === "absent")
                return false;
            if (evidence.status !== "present") {
                const key = `${batch.batch_id}:${evidence.status}:${evidence.reason ?? ""}`;
                if (!completionDiagnostics.has(key)) {
                    completionDiagnostics.add(key);
                    ctx.ui.notify("\n" + formatYamlNotice({ batch: batch.batch_id, stage: "completion recovery",
                        evidence: evidence.status, phase: "pending", reason: evidence.reason ?? "conflicting session evidence" }), "warning");
                }
                return true;
            }
        }
        if (fencedCompletionSession && !canUseCompletionSession(ctx, ownerId))
            return true;
        return !acceptCompletionBatch(ownerId, batch.batch_id);
    };
    const pendingCompletionBatch = (ctx, ownerId) => {
        const existing = journal(ownerId).completion_batch;
        if (existing)
            return existing;
        const snapshot = Observability.readRunDeliverySnapshot(deliveryObservation, ownerId);
        admitCompletionTransitions(ctx, ownerId, snapshot);
        Observability.pruneRunUiObservationState(deliveryObservation, snapshot);
        return journal(ownerId).completion_batch;
    };
    const isCurrentOwner = (ctx) => {
        if (!running || !activeOwnerId)
            return false;
        if (!fencedCompletionSession) {
            try {
                return Pi.getSessionId(ctx) === activeOwnerId;
            }
            catch {
                return false;
            }
        }
        const ticket = sessionTicket, ownerId = activeOwnerId, known = contextTickets.get(ctx);
        if (!ticket || (known && known !== ticket))
            return false;
        try {
            if (deps.getActiveContext() !== activeContext)
                return false;
            const manager = ctx.sessionManager;
            if (manager !== sessionManager || manager.getSessionId() !== ownerId || ticket !== sessionTicket || !running)
                return false;
            contextTickets.set(ctx, ticket);
            return true;
        }
        catch {
            return false;
        }
    };
    const canUseCompletionSession = (ctx, ownerId) => {
        if (deps.captureCompletionBatch && !isCurrentOwner(ctx))
            return false;
        if (!deps.completionStreamSessionAdmission)
            return !journal(ownerId).completion_stream;
        if (!isCurrentOwner(ctx))
            return false;
        const ticket = sessionTicket, state = journal(ownerId).completion_stream;
        // No metadata is not disconnected. The opt-in path never bootstraps or falls back to local indices.
        return streamSessionAdmitted && Boolean(state) && ticket === sessionTicket && isCurrentOwner(ctx);
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
                        ctx.ui.notify(formatYamlNotice({ event: steer.event_id, attention: "steer", stage: "recovery",
                            evidence: evidence.status, phase: "queued", reason: evidence.reason ?? "conflicting session evidence" }), "warning");
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
                ctx.ui.notify(formatSteerDiagnosticMessage(steer.event_id, "delivery", message), "error");
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
        const ticket = sessionTicket;
        if (deliveryTimeout)
            clearTimeout(deliveryTimeout);
        deliveryTimeout = setTimeout(() => {
            if (ticket !== sessionTicket)
                return;
            deliveryTimeout = undefined;
            runActiveCallback("completion delivery callback", (ctx) => {
                flushCompletionBatch(ctx);
            }, ticket);
        }, deps.deliveryDebounceMs ?? 100);
        deliveryTimeout.unref?.();
    };
    const update = (ctx, ownerId, notify = false, terminalOnly = false) => {
        // Derive both projections before any UI/retirement callback. The subsequent
        // flush still observes afresh; these facts only drive display/candidate scheduling.
        const ticket = sessionTicket;
        const pair = notify && isDeliveryRoot(ownerId)
            ? Observability.readRunUiAndDeliverySnapshots(observation, deliveryObservation, ownerId)
            : undefined;
        const snapshot = pair?.ui ?? Observability.readRunUiSnapshot(observation, ownerId);
        if (ticket !== sessionTicket || (fencedCompletionSession && !isCurrentOwner(ctx)))
            return false;
        // Animation retains display data only; all admission paths continue observing independently.
        displayRunningSubagents = snapshot.summary.runningSubagents;
        displayFrame = 0;
        const status = snapshot.status && ctx.mode === "tui" ? ctx.ui.theme.fg("dim", snapshot.status) : snapshot.status;
        if (ticket !== sessionTicket)
            return false;
        ctx.ui.setStatus("zz-pi-actors-runs", status);
        if (ticket !== sessionTicket)
            return false;
        if (!notify || (fencedCompletionSession && !isCurrentOwner(ctx)))
            return false;
        const sink = Pi.createNotificationSink(deps.pi, ctx);
        retireCandidateRuns(ctx, snapshot.summary);
        const deliverySnapshot = pair?.delivery;
        const hasCompletionCandidates = deliverySnapshot
            ? Observability.hasRunCompletionBatchMembers(deliverySnapshot.transitions, deliverySnapshot.summary.runs)
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
    const scheduleUpdate = (ticket) => {
        if (ticket !== sessionTicket || !running)
            return;
        if (notifyTimeout)
            clearTimeout(notifyTimeout);
        notifyTimeout = setTimeout(() => {
            if (ticket !== sessionTicket)
                return;
            runActiveCallback("Run watcher callback", (ctx, ownerId) => {
                watcher.refresh();
                const completionDeferred = update(ctx, ownerId, true);
                if (ticket !== sessionTicket)
                    return;
                if (!completionDeferred)
                    deps.onRunEvent();
                if (ticket === sessionTicket)
                    reportDiagnostics(ctx);
            }, ticket);
        }, deps.notificationDelayMs ?? 50);
        notifyTimeout.unref?.();
    };
    const createWatcher = (ticket) => (deps.createRunStateWatcher ?? Observability.createRunStateWatcher)({
        stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
        onChange: () => scheduleUpdate(ticket),
    });
    const createReconciliation = (ticket) => (deps.createRunTerminalReconciliationLoop ??
        Observability.createRunTerminalReconciliationLoop)({
        onError: (error) => {
            if (ticket !== sessionTicket || !running || !activeContext)
                return;
            stopAfterCallbackFailure("terminal reconciliation callback", error, activeContext);
        },
        reconcile: () => {
            runActiveCallback("terminal reconciliation callback", (ctx, ownerId) => {
                update(ctx, ownerId, true);
                reportDiagnostics(ctx);
            }, ticket);
        },
        refreshWatcher: () => {
            if (ticket === sessionTicket && running)
                watcher.refresh();
        },
    });
    let watcher = createWatcher(undefined);
    let reconciliation = createReconciliation(undefined);
    flushCompletionBatch = (ctx) => {
        const ownerId = activeOwnerId;
        if (!ownerId || !isCurrentOwner(ctx))
            return false;
        if (flushSteers(ctx, ownerId))
            return true;
        if (!isDeliveryRoot(ownerId))
            return false;
        if (!canUseCompletionSession(ctx, ownerId))
            return true;
        if (reconcileCompletionBatch(ctx, ownerId))
            return true;
        const batch = pendingCompletionBatch(ctx, ownerId);
        if (!batch)
            return false;
        if (!isIdle(ctx))
            return true;
        const projected = RunDelivery.projectRunCompletionBatchPresentation(batch);
        if (!isIdle(ctx) || !isCurrentOwner(ctx))
            return true;
        try {
            Pi.sendRunCompletionBatch(deps.pi, batch.batch_id, projected.content, projected.presentation);
        }
        catch (error) {
            if (fencedCompletionSession && !isCurrentOwner(ctx))
                throw error;
            RunDelivery.recordRunCompletionBatchDeliveryFailure({
                batchId: batch.batch_id,
                error,
                ownerId,
                tempDir: Paths.EXTENSION_RUNTIME_PATHS.tempDir,
            });
            throw error;
        }
        if (fencedCompletionSession && !canUseCompletionSession(ctx, ownerId))
            return true;
        if (!acceptCompletionBatch(ownerId, batch.batch_id)) {
            throw new Error("Completion batch changed before durable acceptance");
        }
        return true;
    };
    return {
        close,
        isCurrentSessionContext: isCurrentOwner,
        flushCompletionBatch,
        onTurnEnd(event, ctx) {
            const ownerId = activeOwnerId;
            if (!ownerId || !isCurrentOwner(ctx) || !isDeliveryRoot(ownerId) ||
                event.outcome !== "completed" || isIdle(ctx) || ctx.signal?.aborted ||
                ctx.hasPendingMessages?.() || event.context.pendingMessages.length > 0)
                return undefined;
            if (flushSteers(ctx, ownerId) || !canUseCompletionSession(ctx, ownerId) || reconcileCompletionBatch(ctx, ownerId))
                return undefined;
            const batch = pendingCompletionBatch(ctx, ownerId);
            if (!batch || !isCurrentOwner(ctx))
                return undefined;
            const projected = RunDelivery.projectRunCompletionBatchPresentation(batch);
            const entry = Pi.createRunCompletionBatchEntry(batch.batch_id, projected.content, projected.presentation);
            if (!canUseCompletionSession(ctx, ownerId))
                return undefined;
            return { entries: [...event.entries, entry], continue: true };
        },
        projectContext(messages, ctx) {
            const ownerId = activeOwnerId;
            if (!ownerId || !isCurrentOwner(ctx))
                return messages;
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
            if (!canUseCompletionSession(ctx, ownerId))
                return contextMessages;
            const projected = Pi.dedupeRunCompletionBatchContext(contextMessages);
            const batch = journal(ownerId).completion_batch;
            if (!batch)
                return projected.messages;
            const content = projected.batches.get(batch.batch_id);
            if (content !== RunDelivery.formatRunCompletionBatchMessage(batch)) {
                return Pi.removeRunCompletionBatchFromContext(projected.messages, batch.batch_id);
            }
            if (!fencedCompletionSession || canUseCompletionSession(ctx, ownerId))
                acceptCompletionBatch(ownerId, batch.batch_id);
            return projected.messages;
        },
        shutdown(eventReason, ownerId, ctx) {
            if (!ownerId)
                return;
            const teardown = (deps.teardownRunsOwnedByParent ?? AsyncRuns.teardownRunsOwnedByParent)(ownerId, Paths.EXTENSION_RUNTIME_PATHS.runStateRoot, { trigger: `session_shutdown:${eventReason}` });
            if (teardown.failed === 0 || !ctx)
                return;
            try {
                ctx.ui.notify(formatYamlNotice({ stage: "shutdown teardown", killed: teardown.killed,
                    failed: teardown.failed, skipped: teardown.skipped, discovery_failed: teardown.discoveryFailed,
                    summary: teardown.summaryPath ?? "unavailable",
                    basis: "teardown report; not scope closure" }), "warning");
            }
            catch {
                /* stale shutdown context */
            }
        },
        start(ctx, ownerId, event) {
            close();
            const ticket = {};
            sessionTicket = ticket;
            activeContext = ctx;
            activeOwnerId = ownerId;
            recoverQueuedSteers = true;
            running = true;
            try {
                if (fencedCompletionSession) {
                    sessionManager = ctx.sessionManager;
                    const fresh = !seenManagers.has(sessionManager) && !contextTickets.has(ctx);
                    seenManagers.add(sessionManager);
                    if (!contextTickets.has(ctx))
                        contextTickets.set(ctx, ticket);
                    if (deps.captureCompletionBatch && !fresh)
                        sessionManager = undefined;
                    if (deps.completionStreamSessionAdmission && fresh && event && (event.reason === "new" || event.reason === "fork") && isCurrentOwner(ctx)) {
                        const admitted = deps.completionStreamSessionAdmission(ctx, event) === true && isCurrentOwner(ctx);
                        if (ticket !== sessionTicket)
                            return;
                        streamSessionAdmitted = admitted;
                    }
                }
                if (ticket !== sessionTicket)
                    return;
                watcher = createWatcher(ticket);
                reconciliation = createReconciliation(ticket);
                if (canUseCompletionSession(ctx, ownerId))
                    recoverPresentedBatch(ownerId);
                recoverPresentedSteers(ownerId);
                Observability.primeRunAttentionState(observation, ownerId);
                update(ctx, ownerId, true, true);
                if (ticket !== sessionTicket)
                    return;
                watcher.refresh();
                if (ticket !== sessionTicket)
                    return;
                reconciliation.start();
                if (ticket !== sessionTicket || ctx.mode !== "tui")
                    return;
                animationInterval = setInterval(() => {
                    runActiveCallback("status animation callback", (current) => {
                        const status = Observability.renderSubagentStatus(displayRunningSubagents, ++displayFrame);
                        const themed = status ? current.ui.theme.fg("dim", status) : status;
                        if (ticket !== sessionTicket)
                            return;
                        current.ui.setStatus("zz-pi-actors-runs", themed);
                    }, ticket);
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
