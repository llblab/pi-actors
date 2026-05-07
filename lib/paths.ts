/**
 * Registry path helpers
 * Zones: paths, registry config, temp directory
 * Owns agent directory and auto-tools config path resolution
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
  return join(agentDir, "auto-tools.json");
}

export function getExtensionTmpDir(
  agentDir = getAgentDir(),
  extensionName = "pi-auto-tools",
): string {
  return join(agentDir, "tmp", extensionName);
}

export function getJobStateRoot(agentDir = getAgentDir()): string {
  return join(getExtensionTmpDir(agentDir), "jobs");
}

export function getJobTemplateRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "jobs");
}
