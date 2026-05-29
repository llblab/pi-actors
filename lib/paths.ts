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

export interface ExtensionRuntimePaths {
  configPath: string;
  runStateRoot: string;
  tempDir: string;
}

export function getConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "tool-registry.json");
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

export function getExtensionRuntimePaths(
  agentDir = getAgentDir(),
): ExtensionRuntimePaths {
  return {
    configPath: getConfigPath(agentDir),
    runStateRoot: getRunStateRoot(agentDir),
    tempDir: getExtensionTmpDir(agentDir),
  };
}

export const EXTENSION_RUNTIME_PATHS = getExtensionRuntimePaths();

export function getExtensionSkillsDir(extensionUrl: string): string {
  return join(dirname(fileURLToPath(extensionUrl)), "skills");
}

export function getExistingExtensionSkillPaths(extensionUrl: string): string[] {
  const skillsDir = getExtensionSkillsDir(extensionUrl);
  return existsSync(skillsDir) ? [skillsDir] : [];
}

export function getRecipeRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "recipes");
}

export function getRecipeDraftRoot(agentDir = getAgentDir()): string {
  return join(getRecipeRoot(agentDir), "drafts");
}

export function getPackagedRecipeRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledRoot = resolve(here, "..", "..", "recipes");
  if (existsSync(compiledRoot)) return compiledRoot;
  return resolve(here, "..", "recipes");
}
