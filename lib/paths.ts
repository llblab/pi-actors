/**
 * Registry path helpers
 * Zones: paths, registry config, temp directory
 * Owns agent directory, tools config, recipe root, and actor run state root resolution
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getAgentDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.PI_CODING_AGENT_DIR
    ? resolve(env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

export function getConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "legacy-tool-registry.json");
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

export function getRecipeCandidateRoot(agentDir = getAgentDir()): string {
  return join(getRecipeRoot(agentDir), "candidates");
}

export function getPackagedRecipeRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledRoot = resolve(here, "..", "..", "recipes");
  if (existsSync(compiledRoot)) return compiledRoot;
  return resolve(here, "..", "recipes");
}
