/**
 * Registry path helpers
 * Zones: paths, registry config, temp directory
 * Owns agent directory, tools config, recipe root, and actor run state root resolution
 */
export declare function getAgentDir(env?: Record<string, string | undefined>): string;
export declare function isAutomaticRecipeReviewEnabled(env?: Record<string, string | undefined>): boolean;
export interface ExtensionRuntimePaths {
    configPath: string;
    runStateRoot: string;
    tempDir: string;
}
export declare function getConfigPath(agentDir?: string): string;
export declare function getExtensionTmpDir(agentDir?: string, extensionName?: string): string;
export declare function getRunStateRoot(agentDir?: string): string;
export declare function getDraftSleepRoot(agentDir?: string): string;
export declare function getDraftSleepStatePath(agentDir?: string): string;
export declare function getDraftSleepBatchDir(batchId: string, agentDir?: string): string;
export declare function getToolReviewRoot(agentDir?: string): string;
export declare function getToolReviewStatePath(agentDir?: string): string;
export declare function getToolReviewBatchDir(reviewId: string, agentDir?: string): string;
export declare function getExtensionRuntimePaths(agentDir?: string): ExtensionRuntimePaths;
export declare const EXTENSION_RUNTIME_PATHS: ExtensionRuntimePaths;
export declare function getExtensionPackageRoot(extensionUrl: string): string;
export interface RawExtensionCheckoutOptions {
    agentDir?: string;
    cwd?: string;
}
export declare function isRawExtensionCheckout(extensionUrl: string, options?: RawExtensionCheckoutOptions): boolean;
export declare function getExtensionSkillsDir(extensionUrl: string): string;
export declare function getExistingExtensionSkillPaths(extensionUrl: string): string[];
export declare function getRecipeRoot(agentDir?: string): string;
export declare function getRecipeDraftRoot(agentDir?: string): string;
