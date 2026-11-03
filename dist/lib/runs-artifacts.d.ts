/**
 * Async run artifact declarations and manifest resolution.
 * Owns: artifact path expansion, captured-reference validation, body-free metadata observation and explicit hashing.
 * Excludes: generation admission, export publication, directory scans and production/immutable-content proof.
 */
export type RunArtifactDeclaration = string | {
    path: string;
    kind?: string;
    media_type?: string;
    required?: boolean;
};
export interface RunArtifactManifestEntry {
    exists: boolean;
    kind?: string;
    media_type?: string;
    path: string;
    required?: boolean;
    sha256?: string;
    size?: number;
}
export interface RunArtifactReference {
    readonly name: string;
    readonly path: string;
    readonly kind?: string;
    readonly media_type?: string;
    readonly required?: boolean;
}
export type RunArtifactReferencesReading = {
    readonly state: "available";
    readonly references: readonly Readonly<RunArtifactReference>[];
} | {
    readonly state: "unavailable";
    readonly reason: "artifact_declarations_invalid" | "artifact_base_unavailable";
};
export type RunArtifactObservation = Readonly<RunArtifactReference & {
    availability: "available" | "missing" | "unavailable";
    bytes_total?: number;
    modified_at?: string;
    reason?: "artifact_not_regular" | "artifact_changed" | "artifact_unreadable" | "artifact_size_unavailable";
}>;
/** Captured paths only: no placeholder/environment expansion, directory discovery or fallback to this process's cwd. */
export declare function describeRunArtifactReferences(artifacts: unknown, cwd: unknown): RunArtifactReferencesReading;
/** Readability/stat evidence only. A declared file need not have been created by this Run and is never hashed here. */
export declare function observeRunArtifactReference(reference: Readonly<RunArtifactReference>): RunArtifactObservation;
export declare function resolveArtifactPaths(artifacts: Record<string, RunArtifactDeclaration> | undefined, values: Record<string, unknown>): Record<string, RunArtifactDeclaration> | undefined;
export declare function resolveArtifactManifest(artifacts: Record<string, RunArtifactDeclaration> | undefined): Record<string, RunArtifactManifestEntry> | undefined;
