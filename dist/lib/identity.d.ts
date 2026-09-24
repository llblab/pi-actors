/**
 * Identifier normalization helpers
 * Zones: registry identity, shared validation
 * Owns stable tool, argument, and file-label identifier normalization
 */
export declare function normalizeIdentifier(value: string, prefix: string): string;
export declare function normalizeToolName(value: string): string;
export declare function normalizeArgName(value: string): string;
export declare function sanitizeFilePart(value: string): string;
