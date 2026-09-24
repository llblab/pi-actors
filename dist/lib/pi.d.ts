/**
 * Pi SDK adapter boundary.
 * Zones: pi agent sdk boundary, extension host adapters
 * Owns direct pi SDK imports and exposes narrow pi-actors-facing helpers/types for the composition root.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as SessionEvidence from "./session-evidence.ts";
export type { ExtensionAPI, ExtensionContext };
export declare const RUN_COMPLETION_BATCH_CUSTOM_TYPE = "pi-actors-run-batch";
export declare const RUN_STEER_CUSTOM_TYPE = "pi-actors-run-steer";
export interface PiNotificationSink {
    notify(message: string, level: "info" | "warning" | "error"): void;
    sendFollowUp(message: {
        customType: string;
        content: string;
        display: false;
        details: unknown;
    }): void;
}
export declare function getSessionId(ctx: ExtensionContext): string;
export declare function createNotificationSink(pi: ExtensionAPI, ctx: ExtensionContext): PiNotificationSink;
export declare function sendRunCompletionBatch(pi: ExtensionAPI, batchId: string, content: string): void;
export declare function sendRunSteer(pi: ExtensionAPI, input: {
    content: string;
    eventId: string;
    steerId: string;
}): void;
/** Collapse exact retry duplicates and remove conflicting delivery envelopes. */
export declare function dedupeRunCompletionBatchContext(messages: unknown[]): {
    batches: Map<string, string>;
    conflicts: Set<string>;
    messages: unknown[];
};
export declare function removeRunCompletionBatchFromContext(messages: unknown[], batchId: string): unknown[];
export declare function dedupeRunSteerContext(messages: unknown[]): {
    conflicts: Set<string>;
    messages: unknown[];
    steers: Map<string, {
        content: string;
        eventId: string;
    }>;
};
export declare function removeRunSteerFromContext(messages: unknown[], steerId: string): unknown[];
export declare function inspectRunSteerSessionEvidence(ctx: ExtensionContext, input: {
    content: string;
    eventId: string;
    steerId: string;
}): SessionEvidence.ActiveSessionEntryEvidence;
export declare function registerToolDefinitions(pi: ExtensionAPI, definitions: Iterable<unknown>): void;
