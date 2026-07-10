/**
 * Async run start guards.
 * Owns active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  isAlive,
  readProcessIdentity,
  verifyRunProcessIdentity,
  type RunProcessIdentity,
} from "./runs-process.ts";

const START_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export type RunJsonReader = (path: string) => Record<string, unknown> | undefined;

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

function writeStartLockOwner(lockDir: string, recovered = false): void {
  const processIdentity = readProcessIdentity(process.pid);
  writeFileSync(
    join(lockDir, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ...(processIdentity ? { process_identity: processIdentity } : {}),
      ...(recovered ? { recovered: true } : {}),
    })}\n`,
    "utf8",
  );
}

function isStartLockOwnerProvenDead(lockDir: string): boolean {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf8"),
    ) as Record<string, unknown>;
    const pid = Number(owner.pid || 0);
    if (!pid) return false;
    return verifyRunProcessIdentity(
      pid,
      owner.process_identity as RunProcessIdentity | undefined,
    ).status === "dead_pid";
  } catch {
    return false;
  }
}

export function acquireStateStartLock(stateDir: string): () => void {
  const lockDir = join(stateDir, ".start.lock");
  try {
    mkdirSync(lockDir);
    writeStartLockOwner(lockDir);
  } catch (error) {
    try {
      const stat = statSync(lockDir);
      if (
        Date.now() - stat.mtimeMs > START_LOCK_MAX_AGE_MS &&
        isStartLockOwnerProvenDead(lockDir)
      ) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeStartLockOwner(lockDir, true);
        return () => rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Keep the original lock acquisition error below.
    }
    throw new Error(
      `Run state is already being started: ${stateDir}. Retry after the current start finishes.`,
      { cause: error },
    );
  }
  return () => rmSync(lockDir, { recursive: true, force: true });
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
