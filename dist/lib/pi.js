/**
 * Pi SDK adapter boundary.
 * Zones: pi agent sdk boundary, extension host adapters
 * Owns direct pi SDK imports and exposes narrow pi-actors-facing helpers/types for the composition root.
 */
import * as SessionEvidence from "./session-evidence.js";
import * as RunDelivery from "./run-delivery.js";
export { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
export const RUN_COMPLETION_BATCH_CUSTOM_TYPE = "pi-actors-run-batch";
export const RUN_STEER_CUSTOM_TYPE = "pi-actors-run-steer";
export function getSessionId(ctx) {
    return ctx.sessionManager.getSessionId();
}
export function createNotificationSink(pi, ctx) {
    return {
        notify: (message, level) => ctx.ui.notify(message, level),
        sendFollowUp: (message) => pi.sendMessage(message, {
            deliverAs: "followUp",
            triggerTurn: true,
        }),
    };
}
export function createRunCompletionBatchEntry(batchId, content, presentation) {
    return {
        type: "custom_message",
        customType: RUN_COMPLETION_BATCH_CUSTOM_TYPE,
        content,
        display: true,
        details: {
            pi_actors_delivery: {
                batch_id: batchId,
                kind: "completion_batch",
            },
            ...(presentation === undefined ? {} : { pi_actors_presentation: presentation }),
        },
    };
}
export function sendRunCompletionBatch(pi, batchId, content, presentation) {
    const { type: _type, ...message } = createRunCompletionBatchEntry(batchId, content, presentation);
    pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
}
export function sendRunSteer(pi, input) {
    pi.sendMessage({
        customType: RUN_STEER_CUSTOM_TYPE,
        content: input.content,
        display: false,
        details: {
            pi_actors_delivery: {
                event_id: input.eventId,
                kind: "urgent_steer",
                steer_id: input.steerId,
            },
        },
    }, {
        deliverAs: "steer",
        triggerTurn: true,
    });
}
function hasCompletionFrontmatterPrefix(content) {
    const opening = /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)/u.exec(content);
    if (!opening)
        return false;
    for (const line of content.slice(opening[0].length).split(/\r\n|\r|\n/u)) {
        const field = line.trim();
        if (field === "---")
            return false;
        if (!field)
            continue;
        if (/^(?:index|run|state|kind)[ \t]*:/iu.test(field) ||
            ["index", "run", "state", "kind"].some(key => key.startsWith(field.toLowerCase())))
            return true;
        // Continue through plausible metadata, not arbitrary thematic-break prose.
        if (!/^[a-z_][a-z0-9_-]*[ \t]*:/iu.test(field))
            return false;
    }
    return false;
}
function unheaderedCompletionId(content) {
    // Preserve the existing legacy RegExp coercion before inspecting compiler-owned record framing.
    const legacyId = /^Batch: `([^`]{1,128})`$/mu.exec(content)?.[1];
    if (typeof content === "string") {
        const core = RunDelivery.readCompletionYamlCarrier(content);
        if (core.state === "available")
            return core.packet.batchId;
        // Initial compiler headers only: never recover identity by scanning authored bodies.
        if (/^(?:index: (?:\d+|"\?")\nrun: [^\n]*\nstate:|_completion:\n  (?:codec|batch_id):)/u.test(content))
            return { malformed: true };
    }
    if (typeof content === "string" && (hasCompletionFrontmatterPrefix(content) || /^(?:#|Run #|— Новый поток|- run:|- #0:\n|- result: omitted \(model byte limit\)\n|- omitted_results:)/u.test(content))) {
        return RunDelivery.readRunCompletionRecordMarker(content)?.batchId ?? { malformed: true };
    }
    return legacyId;
}
function completionBatchMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message))
        return undefined;
    const record = message;
    if (record.customType !== RUN_COMPLETION_BATCH_CUSTOM_TYPE ||
        typeof record.content !== "string")
        return undefined;
    const details = record.details;
    const delivery = details && typeof details === "object" && !Array.isArray(details)
        ? details.pi_actors_delivery
        : undefined;
    const envelope = delivery && typeof delivery === "object" && !Array.isArray(delivery)
        ? delivery
        : undefined;
    const detailedId = envelope?.kind === "completion_batch" &&
        typeof envelope.batch_id === "string"
        ? envelope.batch_id
        : undefined;
    // Retained headers or the new closed footer identify delivery; authored labels never override either.
    const contentId = record.content.startsWith("- completion:")
        ? /^- completion: ([^\r\n\u2028\u2029]{1,128})\n- presentation: ax_records\n/u.exec(record.content)?.[1]
        : record.content.startsWith("- completions:")
            ? /^- completions: [1-9]\d{0,2}\n- batch: ([^\r\n\u2028\u2029]{1,128})\n/u.exec(record.content)?.[1]
            : unheaderedCompletionId(record.content);
    const batchId = detailedId ?? (typeof contentId === "string" ? contentId : undefined);
    if (!batchId || batchId.length > 128)
        return contentId && typeof contentId === "object" ? contentId : undefined;
    return { batchId, content: record.content };
}
/** Collapse exact retry duplicates and remove conflicting delivery envelopes. */
export function dedupeRunCompletionBatchContext(messages) {
    const batches = new Map();
    const conflicts = new Set();
    for (const message of messages) {
        const batch = completionBatchMessage(message);
        if (!batch || "malformed" in batch)
            continue;
        const existing = batches.get(batch.batchId);
        if (existing !== undefined && existing !== batch.content) {
            conflicts.add(batch.batchId);
        }
        else if (existing === undefined) {
            batches.set(batch.batchId, batch.content);
        }
    }
    const retained = new Set();
    const filtered = messages.filter((message) => {
        const batch = completionBatchMessage(message);
        if (!batch || "malformed" in batch)
            return true;
        if (conflicts.has(batch.batchId) || retained.has(batch.batchId))
            return false;
        retained.add(batch.batchId);
        return true;
    });
    for (const batchId of conflicts)
        batches.delete(batchId);
    return { batches, conflicts, messages: filtered };
}
export function removeRunCompletionBatchFromContext(messages, batchId) {
    return messages.filter((message) => {
        const batch = completionBatchMessage(message);
        return !batch || "malformed" in batch || batch.batchId !== batchId;
    });
}
function steerMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message))
        return undefined;
    const record = message;
    if (record.customType !== RUN_STEER_CUSTOM_TYPE || typeof record.content !== "string") {
        return undefined;
    }
    const details = record.details;
    if (!details || typeof details !== "object" || Array.isArray(details))
        return undefined;
    const delivery = details.pi_actors_delivery;
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery))
        return undefined;
    const envelope = delivery;
    if (envelope.kind !== "urgent_steer" ||
        typeof envelope.steer_id !== "string" ||
        !envelope.steer_id ||
        envelope.steer_id.length > 128 ||
        typeof envelope.event_id !== "string" ||
        !envelope.event_id ||
        envelope.event_id.length > 256)
        return undefined;
    return {
        content: record.content,
        eventId: envelope.event_id,
        steerId: envelope.steer_id,
    };
}
export function dedupeRunSteerContext(messages) {
    const conflicts = new Set();
    const steers = new Map();
    for (const message of messages) {
        const steer = steerMessage(message);
        if (!steer)
            continue;
        const existing = steers.get(steer.steerId);
        if (existing &&
            (existing.content !== steer.content || existing.eventId !== steer.eventId)) {
            conflicts.add(steer.steerId);
        }
        else if (!existing) {
            steers.set(steer.steerId, {
                content: steer.content,
                eventId: steer.eventId,
            });
        }
    }
    const retained = new Set();
    const filtered = messages.filter((message) => {
        const steer = steerMessage(message);
        if (!steer)
            return true;
        if (conflicts.has(steer.steerId) || retained.has(steer.steerId))
            return false;
        retained.add(steer.steerId);
        return true;
    });
    for (const steerId of conflicts)
        steers.delete(steerId);
    return { conflicts, messages: filtered, steers };
}
export function removeRunSteerFromContext(messages, steerId) {
    return messages.filter((message) => steerMessage(message)?.steerId !== steerId);
}
export function inspectRunCompletionBatchSessionEvidence(ctx, input) {
    let unidentifiedRecord = false;
    const evidence = SessionEvidence.inspectBoundedActiveSessionEntries({
        getEntry: (id) => ctx.sessionManager.getEntry(id),
        leaf: ctx.sessionManager.getLeafEntry(),
        match: (entry) => {
            const batch = completionBatchMessage(entry);
            if (batch && "malformed" in batch) {
                unidentifiedRecord = true;
                return undefined;
            }
            if (!batch || batch.batchId !== input.batchId)
                return undefined;
            return batch.content === input.content ? "present" : "conflict";
        },
    });
    // An unidentified new record may be this pending epoch; it cannot prove absence or permit replay.
    return evidence.status === "absent" && unidentifiedRecord
        ? { ...evidence, status: "unknown", reason: "completion record correlation is unavailable" } : evidence;
}
export function inspectRunSteerSessionEvidence(ctx, input) {
    return SessionEvidence.inspectBoundedActiveSessionEntries({
        getEntry: (id) => ctx.sessionManager.getEntry(id),
        leaf: ctx.sessionManager.getLeafEntry(),
        match: (entry) => {
            const steer = steerMessage(entry);
            if (!steer || steer.steerId !== input.steerId)
                return undefined;
            return steer.content === input.content && steer.eventId === input.eventId
                ? "present"
                : "conflict";
        },
    });
}
export function registerToolDefinitions(pi, definitions) {
    for (const definition of definitions)
        pi.registerTool(definition);
}
