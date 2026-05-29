/**
 * Async run process identity helpers.
 * Owns liveness checks and Linux runner identity matching for run-owned processes.
 */

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pidMatchesRun(
  pid: number,
  cwd: string,
  stateDir: string,
  runnerPath: string,
): boolean {
  if (platform() !== "linux" || !existsSync(`/proc/${pid}`))
    return isAlive(pid);
  try {
    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return (
      procCwd === resolve(cwd) &&
      cmdline.includes(runnerPath) &&
      cmdline.includes(stateDir)
    );
  } catch {
    return false;
  }
}

export function isWithinRunnerIdentityGrace(
  meta: Record<string, unknown>,
  graceMs: number,
): boolean {
  const createdAt =
    typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : NaN;
  return (
    Number.isFinite(createdAt) &&
    Date.now() - createdAt >= 0 &&
    Date.now() - createdAt <= graceMs
  );
}
