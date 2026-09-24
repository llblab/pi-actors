/**
 * File state persistence helpers
 * Zones: file persistence, atomic writes, runtime state support
 * Owns generic durable JSON file writes shared by registry config and async run state.
 */
export declare function mutationLockPath(path: string): string;
export interface FileMutationLockOptions {
    onBeforeLockPublish?(): void;
    onBeforeReclaimRemove?(): void;
    onContention?(): void;
    onRemovalContention?(): void;
}
export declare function acquireFileMutationLock(path: string, options?: FileMutationLockOptions): () => void;
export declare function withFileMutationLock<T>(path: string, mutate: () => T, options?: FileMutationLockOptions): T;
export declare function writeTextAtomic(path: string, content: string, options?: {
    onBeforeReplace?(): void;
}): void;
export declare function writeJsonAtomic(path: string, value: unknown): void;
