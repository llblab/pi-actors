/**
 * Registry path helpers
 * Zones: paths, registry config, temp directory
 * Owns agent directory, tools config, recipe root, and actor run state root resolution
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getAgentDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.PI_CODING_AGENT_DIR
    ? resolve(env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

export function getConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "actors-tools.json");
}

export function getExtensionTmpDir(
  agentDir = getAgentDir(),
  extensionName = "pi-actors",
): string {
  return join(agentDir, "tmp", extensionName);
}

export function getRunStateRoot(agentDir = getAgentDir()): string {
  return join(getExtensionTmpDir(agentDir), "runs");
}

export function getRecipeRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "recipes");
}
