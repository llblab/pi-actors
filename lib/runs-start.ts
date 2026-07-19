/**
 * Async run start guards.
 * Owns: active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  acquireFileMutationLock,
  type FileMutationLockOptions,
} from "./file-state.ts";
import {
  isAlive,
  verifyRunProcessIdentity,
  type RunProcessIdentity,
} from "./runs-process.ts";

type RunJsonReader = (path: string) => Record<string, unknown> | undefined;

export function assertNoActiveRunState(
  stateDir: string,
  readJson: RunJsonReader,
  _runnerPath: string,
): void {
  const meta = readJson(join(stateDir, "run.json"));
  if (!meta) return;
  const pid = Number(meta.pid || 0);
  const cwd = String(meta.cwd ?? "");
  if (!pid || !isAlive(pid)) return;
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
  if (identity.valid) {
    throw new Error(
      `Run state already has an active owned process: ${String(meta.run ?? stateDir)}. Stop it before reusing the same run_id or state_dir.`,
    );
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
  const existing = readJson(join(stateDir, "run.json"));
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
    "events.jsonl",
    "inbox.jsonl",
    "outbox.jsonl",
    "progress.json",
    "result.json",
    "stderr.log",
    "stdout.log",
    "terminal-handled.json",
  ]) {
    rmSync(join(stateDir, file), { force: true });
  }
}
