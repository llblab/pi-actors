/**
 * Registry path helpers
 * Zones: paths, registry config, temp directory
 * Owns agent directory, tools config, recipe root, and actor run state root resolution
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function getAgentDir(env = process.env) {
    return env.PI_CODING_AGENT_DIR
        ? resolve(env.PI_CODING_AGENT_DIR)
        : join(homedir(), ".pi", "agent");
}
export function isAutomaticRecipeReviewEnabled(env = process.env) {
    const value = env.PI_ACTORS_AUTOMATIC_REVIEW?.trim().toLowerCase();
    return value === undefined || !["0", "false", "off"].includes(value);
}
export function getConfigPath(agentDir = getAgentDir()) {
    return join(agentDir, "tool-registry.json");
}
export function getExtensionTmpDir(agentDir = getAgentDir(), extensionName = "pi-actors") {
    return join(agentDir, "tmp", extensionName);
}
export function getRunStateRoot(agentDir = getAgentDir()) {
    return join(getExtensionTmpDir(agentDir), "runs");
}
export function getDraftSleepRoot(agentDir = getAgentDir()) {
    return join(getExtensionTmpDir(agentDir), "draft-sleep");
}
export function getDraftSleepStatePath(agentDir = getAgentDir()) {
    return join(getDraftSleepRoot(agentDir), "state.json");
}
export function getDraftSleepBatchDir(batchId, agentDir = getAgentDir()) {
    if (!/^[a-f0-9-]{36}$/u.test(batchId)) {
        throw new Error("Invalid draft sleep batch id.");
    }
    return join(getDraftSleepRoot(agentDir), "batches", batchId);
}
export function getToolReviewRoot(agentDir = getAgentDir()) {
    return join(getExtensionTmpDir(agentDir), "tool-review");
}
export function getToolReviewStatePath(agentDir = getAgentDir()) {
    return join(getToolReviewRoot(agentDir), "state.json");
}
export function getToolReviewBatchDir(reviewId, agentDir = getAgentDir()) {
    if (!/^[a-f0-9-]{36}$/u.test(reviewId)) {
        throw new Error("Invalid tool review id.");
    }
    return join(getToolReviewRoot(agentDir), "batches", reviewId);
}
export function getExtensionRuntimePaths(agentDir = getAgentDir()) {
    return {
        configPath: getConfigPath(agentDir),
        runStateRoot: getRunStateRoot(agentDir),
        tempDir: getExtensionTmpDir(agentDir),
    };
}
export const EXTENSION_RUNTIME_PATHS = getExtensionRuntimePaths();
export function getExtensionPackageRoot(extensionUrl) {
    let current = dirname(fileURLToPath(extensionUrl));
    while (true) {
        if (existsSync(join(current, "package.json")))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return dirname(fileURLToPath(extensionUrl));
        current = parent;
    }
}
export function isRawExtensionCheckout(extensionUrl, options = {}) {
    const packageRoot = resolve(getExtensionPackageRoot(extensionUrl));
    const agentDir = resolve(options.agentDir ?? getAgentDir());
    const cwd = resolve(options.cwd ?? process.cwd());
    return dirname(packageRoot) === join(agentDir, "extensions") ||
        dirname(packageRoot) === join(cwd, ".pi", "extensions");
}
export function getExtensionSkillsDir(extensionUrl) {
    return join(getExtensionPackageRoot(extensionUrl), "skills");
}
export function getExistingExtensionSkillPaths(extensionUrl) {
    const skillsDir = getExtensionSkillsDir(extensionUrl);
    return existsSync(skillsDir) ? [skillsDir] : [];
}
export function getRecipeRoot(agentDir = getAgentDir()) {
    return join(agentDir, "recipes");
}
export function getRecipeDraftRoot(agentDir = getAgentDir()) {
    return join(getRecipeRoot(agentDir), "drafts");
}
