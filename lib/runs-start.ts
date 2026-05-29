/**
 * Async run start guards.
 * Owns active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isAlive, pidMatchesRun } from "./runs-process.ts";

const START_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export type RunJsonReader = (path: string) => Record<string, unknown> | undefined;

export function assertNoActiveRunState(
  stateDir: string,
  readJson: RunJsonReader,
  runnerPath: string,
): void {
  const meta = readJson(join(stateDir, "run.json"));
  if (!meta) return;
  const pid = Number(meta.pid || 0);
  const cwd = String(meta.cwd ?? "");
  if (!pid || !isAlive(pid) || !pidMatchesRun(pid, cwd, stateDir, runnerPath))
    return;
  throw new Error(
    `Run state already has an active owned process: ${String(meta.run ?? stateDir)}. Stop it before reusing the same run_id or state_dir.`,
  );
}

export function acquireStateStartLock(stateDir: string): () => void {
  const lockDir = join(stateDir, ".start.lock");
  try {
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > START_LOCK_MAX_AGE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(
          join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), recovered: true })}\n`,
          "utf8",
        );
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
  runnerPath: string,
): void {
  const existing = readJson(join(stateDir, "run.json"));
  const existingPid = Number(existing?.pid || 0);
  const existingCwd =
    typeof existing?.cwd === "string" ? existing.cwd : undefined;
  const existingResult = readJson(join(stateDir, "result.json"));
  if (
    !existingResult &&
    existingPid &&
    existingCwd &&
    isAlive(existingPid) &&
    pidMatchesRun(existingPid, existingCwd, stateDir, runnerPath)
  ) {
    throw new Error(
      `Run state already has an active owned process: ${String(existing?.run ?? stateDir)}. Stop it before restarting.`,
    );
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
