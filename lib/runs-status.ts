/**
 * Async run status and log readers.
 * Owns status derivation from run state files plus bounded log/event tails.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AsyncRunStatus } from "./async-runs.ts";
import { isAlive, isWithinRunnerIdentityGrace, pidMatchesRun } from "./runs-process.ts";
import { readJsonlFileResilient } from "./state-readers.ts";

export type RunJsonReader = (path: string) => Record<string, unknown> | undefined;

function getInterruptedRunStatus(
  stateDir: string,
): "cancelled" | "killed" | undefined {
  const events = readJsonlFileResilient<Record<string, unknown>>(
    join(stateDir, "events.jsonl"),
  ).records.slice(-200);
  for (const event of events.reverse()) {
    if (event.event === "run.kill") return "killed";
    if (event.event === "run.cancel") return "cancelled";
  }
  return undefined;
}

export function buildRunStatus(
  stateDir: string,
  runOrDir: string,
  meta: Record<string, unknown>,
  readJson: RunJsonReader,
  runnerPath: string,
  runnerIdentityGraceMs: number,
): Record<string, unknown> {
  const result = readJson(join(stateDir, "result.json"));
  const pid = Number(meta.pid || 0);
  const aliveOwnedRunner = Boolean(
    pid &&
      isAlive(pid) &&
      (!Array.isArray(meta.argv) ||
        pidMatchesRun(pid, String(meta.cwd ?? ""), stateDir, runnerPath) ||
        isWithinRunnerIdentityGrace(meta, runnerIdentityGraceMs)),
  );
  const status: AsyncRunStatus = result
    ? Number(result.code ?? 0) === 0
      ? "done"
      : "failed"
    : aliveOwnedRunner
      ? "running"
      : (getInterruptedRunStatus(stateDir) ?? "exited");
  const terminalHandled = readJson(join(stateDir, "terminal-handled.json"));
  return {
    ...meta,
    eventsFile: join(stateDir, "events.jsonl"),
    inboxFile: join(stateDir, "inbox.jsonl"),
    outboxFile: join(stateDir, "outbox.jsonl"),
    progress: readJson(join(stateDir, "progress.json")) || null,
    result: result || null,
    ...(terminalHandled ? { terminal_handled: terminalHandled } : {}),
    state_dir: String(meta.state_dir ?? stateDir),
    stderrLog: join(stateDir, "stderr.log"),
    stdoutLog: join(stateDir, "stdout.log"),
    status,
  };
}

export function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8").trimEnd();
  if (!content) return "";
  return content.split("\n").slice(-lines).join("\n");
}

export function tailLines(path: string, lines: number): string[] {
  const content = tailFile(path, lines);
  return content ? content.split("\n") : [];
}
