/**
 * Actor Inspector run actions.
 * Owns: exact-session run-action authorization, canonical kill routing, and bounded operator feedback.
 */

import { join } from "node:path";

import { safeRunId } from "./runs-identity.ts";

const FEEDBACK_LIMIT = 180;

export interface ActorInspectorKillResult {
  ok: boolean;
  message: string;
}

export interface ActorInspectorKillDeps {
  getRunStatus: (runOrDir: string) => Record<string, unknown>;
  killRun: (
    runOrDir: string,
    expected: { ownerId: string; runInstanceId: string },
  ) => Record<string, unknown>;
}

function bounded(value: unknown): string {
  const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
  return text.length <= FEEDBACK_LIMIT
    ? text
    : `${text.slice(0, FEEDBACK_LIMIT - 1)}…`;
}

export function killOwnedInspectorRun(
  ownerId: string,
  run: string,
  stateRoot: string,
  expectedRunInstanceId: string,
  deps: ActorInspectorKillDeps,
): ActorInspectorKillResult {
  let stateDir: string;
  try {
    stateDir = join(stateRoot, safeRunId(run));
  } catch (error) {
    return {
      ok: false,
      message: `Kill rejected: ${bounded(error instanceof Error ? error.message : error)}`,
    };
  }
  try {
    const status = deps.getRunStatus(stateDir);
    if (status.ownerId !== ownerId) {
      return { ok: false, message: "Kill rejected: run ownership changed." };
    }
    if (status.status !== "running") {
      return {
        ok: false,
        message: `Kill unavailable: run is ${bounded(status.status || "terminal")}.`,
      };
    }
    if (status.run_instance_id !== expectedRunInstanceId) {
      return { ok: false, message: "Kill rejected: run generation changed." };
    }
    const result = deps.killRun(stateDir, {
      ownerId,
      runInstanceId: expectedRunInstanceId,
    });
    if (result.killed === true) {
      return { ok: true, message: `Killed run:${run}.` };
    }
    return {
      ok: false,
      message: `Kill failed: ${bounded(result.reason || "control rejected")}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Kill failed: ${bounded(error instanceof Error ? error.message : error)}.`,
    };
  }
}
