import { type RunContextEntry, type RunContextIndexIdentity, type RunContextIndexPublication } from "./runs-context-index.ts";
import { type RunExecutionReferenceReading } from "./runs-execution-evidence.ts";
import { type RunResultProducer } from "./runs-results.ts";
export declare const SESSION_ASSISTANT_PREVIEW_MAX_BYTES: number;
export interface SessionAssistantPreviewMessage {
    readonly ordinal: number;
    readonly assistant_text: string;
    readonly text_chars_observed: number;
    readonly text_chars_shown: number;
    readonly text_chars_omitted: number;
    readonly preview_clipped: boolean;
}
export interface SessionAssistantPreview {
    readonly content_scope: "assistant_visible_text_preview";
    readonly source_scope: "last_recorded_branch";
    readonly primary_text: "not_exported";
    readonly order: "oldest_first";
    readonly coverage: {
        readonly truncated: true;
        readonly redacted: true;
        readonly history_complete: false;
    };
    readonly text_limit_chars: number;
    readonly messages_total: number;
    readonly messages_shown: number;
    readonly messages_omitted: number;
    readonly messages: readonly Readonly<SessionAssistantPreviewMessage>[];
}
export type SessionAssistantPreviewReading = {
    readonly state: "available";
    readonly preview: Readonly<SessionAssistantPreview>;
} | {
    readonly state: "unavailable";
    readonly reason: "session_invalid" | "preview_too_large";
};
/** Preview clipping happens after origin/secret projection, never by slicing raw/private session fields. */
export declare function projectSessionAssistantPreview(source: string, recipe?: Record<string, unknown>, redactEvidence?: (value: unknown) => unknown): Readonly<SessionAssistantPreviewReading>;
export type RunSessionPreviewReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly command_id: string;
    readonly source_updated_at: string;
    readonly preview: Readonly<SessionAssistantPreview>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: Extract<RunExecutionReferenceReading, {
        state: "unavailable";
    }>["reason"] | "session_metadata_unavailable" | "session_metadata_redacted" | "session_unavailable" | "session_too_large" | "session_invalid" | "preview_too_large";
};
/** This policy is fixed in the kernel; serialized reference DTOs or actor visibility flags cannot widen it. */
export declare function readRunSessionPreview(stateDir: string, expected: unknown, query: unknown): Readonly<RunSessionPreviewReading>;
export declare const RUN_CONTEXT_SESSIONS_MAX_BYTES: number;
declare const COVERAGE: Readonly<{
    truncated: true;
    redacted: true;
    history_complete: false;
}>;
type Unavailable = {
    readonly status: "unavailable";
    readonly reason: Extract<RunSessionPreviewReading, {
        state: "unavailable";
    }>["reason"] | "session_view_too_large" | "session_admission_unavailable" | "session_identity_redacted";
};
export type RunSessionContextExportResult = Unavailable | {
    readonly status: "written";
    readonly captured_at: string;
    readonly entry: Readonly<RunContextEntry>;
};
/** A real producer is required for both privacy capture and each subsequent evidence commit. */
export declare function writeRunSessionContextExport(stateDir: string, producer: RunResultProducer, query: unknown): Readonly<RunSessionContextExportResult>;
/** Preview, catalog and context index are separate effects; no failed phase rolls earlier commits back. */
export declare function writeRunSessionContextIndex(stateDir: string, producer: RunResultProducer, query: unknown): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
export type RunSessionContextPreviewReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly export_id: string;
    readonly command_id: string;
    readonly captured_at: string;
    readonly path: string;
    readonly media_type: "application/json";
    readonly bytes_total: number;
    readonly mutable: true;
    readonly coverage: typeof COVERAGE;
    readonly preview: Readonly<SessionAssistantPreview>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "selection_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "sessions_unavailable" | "catalog_unavailable" | "preview_not_listed" | "preview_unavailable" | "preview_invalid" | "preview_too_large";
};
/** Read only the selected published body: index metadata never substitutes for nested format/generation admission. */
export declare function readRunSessionContextPreview(stateDir: string, expected: unknown, exportId: unknown): Readonly<RunSessionContextPreviewReading>;
export {};
