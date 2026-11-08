/**
 * Async run start guards.
 * Owns: active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */

import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import {
  acquireFileMutationLock,
  mutationLockPath,
  type FileMutationLockOptions,
} from "./file-state.ts";
import { assertNoRetainedDescendantLaunchScope } from "./runs-descendant-launches.ts";
import { assertNoRetainedNativeLaunchScope } from "./runs-native-launches.ts";
import { isRunStopResultCapture, readRunStopClaim, RUN_STOP_CLAIM_FILE } from "./runs-outcomes.ts";
import { RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.ts";
import {
  isAlive,
  verifyRunProcessIdentity,
  type RunProcessIdentity,
} from "./runs-process.ts";

type RunJsonReader = (path: string) => Record<string, unknown> | undefined;

function assertNoPendingStop(stateDir: string, meta: Record<string, unknown>): void {
  const stop = readRunStopClaim(stateDir, meta);
  if (stop.state === "pending" || stop.state === "invalid") {
    throw new Error("Run stop is pending or unproven; confirm the complete owned scope before restarting.");
  }
}

function assertNoUnresolvedCapture(result: Record<string, unknown> | undefined): void {
  if (isRunStopResultCapture(result)) {
    throw new Error("Run stop result capture is not confirmed terminal evidence.");
  }
}

export function readActiveOwnedRunState(
  stateDir: string,
  readJson: RunJsonReader,
  _runnerPath: string,
): Record<string, unknown> | undefined {
  const meta = readJson(join(stateDir, "run.json"));
  if (!meta) return undefined;
  assertNoPendingStop(stateDir, meta);
  const result = readJson(join(stateDir, "result.json"));
  assertNoUnresolvedCapture(result);
  if (typeof result?.completedAt === "string") return undefined;
  const pid = Number(meta.pid || 0);
  if (!pid || !isAlive(pid)) return undefined;
  const identity = verifyRunProcessIdentity(
    pid,
    meta.process_identity as RunProcessIdentity | undefined,
  );
  if (identity.status === "owner_mismatch") {
    throw new Error(
      `Run state process identity does not match the live pid: ${String(meta.run ?? stateDir)}. Refusing to reuse the state directory while pid ${pid} is alive.`,
    );
  }
  if (identity.status === "unsupported_proof") {
    throw new Error(
      `Run state process identity proof is unavailable: ${String(meta.run ?? stateDir)}. Refusing to reuse the state directory while pid ${pid} is alive.`,
    );
  }
  return identity.valid ? meta : undefined;
}

export function assertNoActiveRunState(
  stateDir: string,
  readJson: RunJsonReader,
  runnerPath: string,
): void {
  assertNoRetainedDescendantLaunchScope(stateDir);
  assertNoRetainedNativeLaunchScope(stateDir);
  const meta = readActiveOwnedRunState(stateDir, readJson, runnerPath);
  if (meta) {
    throw new Error(
      `Run state already has an active owned process: ${String(meta.run ?? stateDir)}. Stop it before reusing the same run_id or state_dir.`,
    );
  }
}

/** Prepare-only metadata must neither replace an earlier Run nor erase unrelated retained evidence. */
export function assertFreshRunPreparationState(stateDir: string): void {
  assertNoRetainedDescendantLaunchScope(stateDir);
  let entries: string[];
  try { entries = readdirSync(stateDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lock = basename(mutationLockPath(join(stateDir, ".lifecycle")));
  if (entries.some((name) => name !== RUN_STATE_OWNERSHIP_FILE && name !== lock && !name.startsWith(`${lock}.`))) {
    throw new Error("Run descendant preparation requires fresh state without published Run metadata or retained evidence.");
  }
}

export function acquireStateStartLock(
  stateDir: string,
  options: FileMutationLockOptions = {},
): () => void {
  return acquireFileMutationLock(join(stateDir, ".lifecycle"), options);
}

export function prepareStateDirForStart(
  stateDir: string,
  readJson: RunJsonReader,
  _runnerPath: string,
): void {
  assertNoRetainedDescendantLaunchScope(stateDir);
  assertNoRetainedNativeLaunchScope(stateDir);
  const existing = readJson(join(stateDir, "run.json"));
  assertNoPendingStop(stateDir, existing ?? {});
  assertNoUnresolvedCapture(readJson(join(stateDir, "result.json")));
  const existingPid = Number(existing?.pid || 0);
  if (existingPid && isAlive(existingPid)) {
    const identity = verifyRunProcessIdentity(
      existingPid,
      existing?.process_identity as RunProcessIdentity | undefined,
    );
    if (identity.status === "owner_mismatch") {
      throw new Error(
        `Run state process identity does not match the live pid: ${String(existing?.run ?? stateDir)}. Refusing to prepare the state directory while pid ${existingPid} is alive.`,
      );
    }
    if (identity.status === "unsupported_proof") {
      throw new Error(
        `Run state process identity proof is unavailable: ${String(existing?.run ?? stateDir)}. Refusing to prepare the state directory while pid ${existingPid} is alive.`,
      );
    }
    if (identity.valid) {
      throw new Error(
        `Run state already has an active owned process: ${String(existing?.run ?? stateDir)}. Stop it before restarting.`,
      );
    }
  }
  for (const file of [
    "control-endpoint.json",
    "controls.jsonl",
    "events.jsonl",
    "execution.json",
    "progress.json",
    "result.json",
    RUN_STOP_CLAIM_FILE,
    "stderr.log",
    "stdout.log",
    "terminal-delivery-failure.json",
    "terminal-handled.json",
    "trace.jsonl",
  ]) {
    rmSync(join(stateDir, file), { force: true });
  }
}
