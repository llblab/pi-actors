/**
 * Run context-index metadata, deterministic references and admitted publication.
 * Owns: bounded identity/index reads, role schema, regular references and admitted index publication.
 * Excludes: role-body reads/creation/redaction, model exposure authorization, lifecycle admission and native authority.
 */
export declare const RUN_CONTEXT_INDEX_FILE = "context-index.json";
export declare const RUN_CONTEXT_INDEX_METADATA_MAX_BYTES: number;
/** Canonical run.json input, not an index/marker/model-output allowance. */
export declare const RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES: number;
declare const EXPORTS: {
    readonly recipe: readonly ["recipe.json", "application/json", false];
    readonly result: readonly ["result.json", "application/json", false];
    readonly trace: readonly ["trace.jsonl", "application/x-ndjson", true];
    readonly control: readonly ["control.json", "application/json", true];
    readonly execution: readonly ["execution.json", "application/json", true];
    readonly artifacts: readonly ["artifacts.json", "application/json", false];
    readonly sessions: readonly ["sessions.json", "application/json", true];
    readonly stdout: readonly ["stdout.log", "text/plain", true];
    readonly stderr: readonly ["stderr.log", "text/plain", true];
};
export type RunContextRole = keyof typeof EXPORTS;
export declare function runContextExportPath(role: RunContextRole): string;
export interface RunContextIndexIdentity {
    readonly run: string;
    readonly run_instance_id: string;
    readonly ownerId?: string;
}
export interface RunContextCoverage {
    readonly truncated: boolean;
    readonly redacted: boolean;
    readonly history_complete?: boolean;
}
export type RunContextEntry = {
    readonly availability: "available";
    readonly path: string;
    readonly media_type: string;
    readonly bytes_total: number;
    readonly mutable: boolean;
    readonly coverage: Readonly<RunContextCoverage>;
} | {
    readonly availability: "pending" | "not_applicable";
    readonly path: null;
} | {
    readonly availability: "unavailable";
    readonly path: null;
    readonly reason: string;
};
export interface RunContextIndex {
    readonly schema: "run-context-index-v1";
    readonly run: string;
    readonly run_instance_id: string;
    readonly updated_at: string;
    readonly entries: Readonly<Record<RunContextRole, Readonly<RunContextEntry>>>;
}
export type RunContextIndexReading = {
    readonly state: "available";
    readonly index: Readonly<RunContextIndex>;
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly local_path: string;
} | {
    readonly state: "unavailable";
    readonly reason: "identity_unavailable" | "identity_mismatch" | "index_unavailable" | "index_invalid" | "role_unavailable" | "observation_changed";
};
export type RunContextIdentityReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly local_path: string;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "identity_unavailable" | "identity_mismatch" | "observation_changed";
};
export type RunContextExportLocationReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly path: string;
    readonly local_path: string;
    readonly bytes_total: number;
    readonly mutable: true;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "role_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "export_missing" | "export_unavailable" | "export_size_unrepresentable";
};
/** Shared readonly owner/generation observation without requiring an index or granting body/work authority. */
export declare function readRunContextIdentity(stateDir: string, expected: unknown): Readonly<RunContextIdentityReading>;
/** Physical fixed-role location only: no index/producer, role-body reads or curated publication certification. */
export declare function observeRunContextExportLocation(stateDir: string, expected: unknown, role: unknown): Readonly<RunContextExportLocationReading>;
/** Kernel-local metadata, not proof that bodies are redacted/immutable or permission to expose local_path. */
export declare function readRunContextIndex(stateDir: string, expected: unknown): Readonly<RunContextIndexReading>;
export interface RunContextIndexPublication {
    readonly index: Readonly<RunContextIndex>;
    readonly local_path: string;
}
/** Trusted persistence only: the caller must hold evidence admission and supply authorized export-owner metadata, not actor flags. */
export declare function writeRunContextIndexUnderLock(stateDir: string, expected: unknown, updates: unknown): Readonly<RunContextIndexPublication>;
export {};
