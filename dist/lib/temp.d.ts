/**
 * Extension temp-directory helpers
 * Zones: temp directory, cleanup, runtime files
 * Owns ordinary pi-agent tmp directory preparation and stale-entry cleanup; Run retirement is separate.
 */
export declare const DEFAULT_TEMP_MAX_AGE_MS: number;
export declare function cleanupStaleTempEntries(tempDir: string, maxAgeMs?: number, now?: number, preservedEntries?: Set<string>): Promise<number>;
export declare function prepareExtensionTempDir(tempDir: string, maxAgeMs?: number): Promise<number>;
