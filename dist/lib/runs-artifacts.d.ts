/**
 * Async run artifact declarations and manifest resolution.
 * Owns: artifact path template expansion and filesystem-backed artifact metadata.
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
export declare function resolveArtifactPaths(artifacts: Record<string, RunArtifactDeclaration> | undefined, values: Record<string, unknown>): Record<string, RunArtifactDeclaration> | undefined;
export declare function resolveArtifactManifest(artifacts: Record<string, RunArtifactDeclaration> | undefined): Record<string, RunArtifactManifestEntry> | undefined;
