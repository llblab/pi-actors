/**
 * Extension temp-directory helpers
 * Zones: temp directory, cleanup, runtime files
 * Owns pi-agent tmp directory preparation and stale-entry cleanup
 */
export declare const DEFAULT_TEMP_MAX_AGE_MS: number;
export declare const DEFAULT_RUN_MAX_AGE_MS: number;
export declare function cleanupStaleTempEntries(tempDir: string, maxAgeMs?: number, now?: number, preservedEntries?: Set<string>): Promise<number>;
export declare function cleanupStaleRunEntries(runsDir: string, maxAgeMs?: number, now?: number): Promise<number>;
export declare function prepareExtensionTempDir(tempDir: string, maxAgeMs?: number, runMaxAgeMs?: number): Promise<number>;
