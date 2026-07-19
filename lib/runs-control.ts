/**
 * Async run process control primitives.
 * Owns: platform signal planning, owned-process signalling, and terminal control markers.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import {
  verifyRunProcessIdentity,
  type RunProcessIdentity,
  type RunProcessIdentityResult,
} from "./runs-process.ts";

export interface RunProcessSignalPlan {
  args?: string[];
  command?: string;
  signalTarget: "processGroup" | "process" | "processTree";
}

export function getRunProcessSignalPlan(
  pid: number,
  signal: NodeJS.Signals,
  runtimePlatform: NodeJS.Platform = process.platform,
): RunProcessSignalPlan {
  if (runtimePlatform === "win32") {
    return {
      args: [
        "/PID",
        String(pid),
        "/T",
        ...(signal === "SIGKILL" ? ["/F"] : []),
      ],
      command: "taskkill",
      signalTarget: "processTree",
    };
  }
  return { signalTarget: "processGroup" };
}

export interface RunProcessSignalDeps {
  killProcess?: typeof process.kill;
  runtimePlatform?: NodeJS.Platform;
  verifyIdentity?: (
    pid: number,
    expected: RunProcessIdentity,
    runtimePlatform: NodeJS.Platform,
  ) => RunProcessIdentityResult;
}

export function signalOwnedRunProcess(
  pid: number,
  signal: NodeJS.Signals,
  expectedIdentity?: RunProcessIdentity,
  deps: RunProcessSignalDeps = {},
): RunProcessSignalPlan {
  const runtimePlatform = deps.runtimePlatform ?? process.platform;
  if (expectedIdentity) {
    const proof = (deps.verifyIdentity ?? verifyRunProcessIdentity)(
      pid,
      expectedIdentity,
      runtimePlatform,
    );
    if (!proof.valid) {
      throw new Error(
        `Run process identity changed before signaling: ${proof.status.replaceAll("_", " ")}`,
      );
    }
  }
  const plan = getRunProcessSignalPlan(pid, signal, runtimePlatform);
  if (plan.command && plan.args) {
    const result = spawnSync(plan.command, plan.args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.trim() ||
          result.stdout?.trim() ||
          `${plan.command} failed`,
      );
    }
    return plan;
  }
  const killProcess = deps.killProcess ?? process.kill.bind(process);
  try {
    killProcess(-pid, signal);
    return { signalTarget: "processGroup" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    if (expectedIdentity) {
      const fallbackProof = (deps.verifyIdentity ?? verifyRunProcessIdentity)(
        pid,
        expectedIdentity,
        runtimePlatform,
      );
      if (!fallbackProof.valid) {
        throw new Error(
          `Run process identity changed before pid fallback: ${fallbackProof.status.replaceAll("_", " ")}`,
        );
      }
    }
    killProcess(pid, signal);
    return { signalTarget: "process" };
  }
}

export function markTerminalHandled(
  stateDir: string,
  details: Record<string, unknown>,
): void {
  writeJsonAtomic(join(stateDir, "terminal-handled.json"), {
    ...details,
    ts: new Date().toISOString(),
  });
}

export function buildTerminalProgress(
  existing: Record<string, unknown> | undefined,
  phase: "cancelled" | "killed",
): Record<string, unknown> {
  const progress = existing ?? {};
  const { activeSubagents: _activeSubagents, ...rest } = progress;
  return {
    ...rest,
    completed: typeof progress.completed === "number" ? progress.completed : 0,
    failures: Array.isArray(progress.failures) ? progress.failures : [],
    phase,
    updatedAt: new Date().toISOString(),
  };
}
