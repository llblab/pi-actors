export type ExecutionFileReferenceReading = {
    readonly availability: "available";
    readonly path: string;
    readonly local_path: string;
    readonly bytes_total: number;
    readonly mutable: true;
    readonly unchanged: () => boolean;
} | {
    readonly availability: "unavailable";
    readonly reason: "invalid_reference" | "reference_missing" | "reference_unavailable" | "reference_changed" | "reference_size_unrepresentable";
};
export declare const RUN_STREAM_SOURCE_MAX_BYTES: number;
export type ExecutionTextReading = {
    readonly availability: "available";
    readonly reference: Extract<ExecutionFileReferenceReading, {
        availability: "available";
    }>;
    readonly text: string;
} | {
    readonly availability: "unavailable";
    readonly reason: Extract<ExecutionFileReferenceReading, {
        availability: "unavailable";
    }>["reason"] | "reference_too_large" | "reference_invalid_text";
};
/** Metadata-only: never reads body bytes, regardless of file size. */
export declare function observeExecutionFileReference(stateDir: string, request: unknown): Readonly<ExecutionFileReferenceReading>;
/** Raw text is kernel-local input to an authorized projection, never a tool/model result. */
export declare function readExecutionSessionText(stateDir: string, path: string): Readonly<ExecutionTextReading>;
/** Explicit command capture input only; neither this read nor its path authorizes publication. */
export declare function readExecutionCaptureText(stateDir: string, path: string): Readonly<ExecutionTextReading>;
/** Canonical runner text is kernel-local input, not complete command capture or a model-visible privacy projection. */
export declare function readExecutionRunnerStreamText(stateDir: string, stream: unknown): Readonly<ExecutionTextReading>;
