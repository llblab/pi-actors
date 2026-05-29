/**
 * Async run mailbox state.
 * Owns durable run inbox records, claim locks, and handler status transitions.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJsonlFileResilient } from "./state-readers.ts";

const RUN_INBOX_LOCK_TIMEOUT_MS = 5000;
const STALE_INBOX_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export type RunInboxStatus =
  | "queued"
  | "sent"
  | "claimed"
  | "handled"
  | "failed";

export type RunInboxMessage = Record<string, unknown> & {
  id?: string;
  status?: RunInboxStatus | string;
};

export interface ProcessRunInboxResult {
  claimed: number;
  failed: number;
  handled: number;
}

export function runInboxFile(stateDir: string): string {
  return join(stateDir, "inbox.jsonl");
}

export function parseRunInboxLine(line: string): RunInboxMessage | undefined {
  try {
    return JSON.parse(line) as RunInboxMessage;
  } catch {
    return undefined;
  }
}

export function readRunInboxMessagesFromStateDir(
  stateDir: string,
): RunInboxMessage[] {
  return readJsonlFileResilient<RunInboxMessage>(runInboxFile(stateDir))
    .records;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRunInboxLock(stateDir: string): () => void {
  const lockDir = join(stateDir, ".inbox.lock");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_INBOX_LOCK_MAX_AGE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > RUN_INBOX_LOCK_TIMEOUT_MS) {
        throw new Error("Run inbox lock timed out.", { cause: error });
      }
      sleepSync(10);
    }
  }
}

function writeRunInboxMessages(
  stateDir: string,
  messages: RunInboxMessage[],
): void {
  writeFileSync(
    runInboxFile(stateDir),
    messages.length
      ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
      : "",
    "utf8",
  );
}

export function updateRunInboxMessageStatusInStateDir(
  stateDir: string,
  id: string,
  nextStatus: RunInboxStatus,
  metadata: Record<string, unknown> = {},
): boolean {
  const releaseLock = acquireRunInboxLock(stateDir);
  try {
    const messages = readRunInboxMessagesFromStateDir(stateDir);
    const timestampKey = `${nextStatus}_at`;
    let changed = false;
    const updated = messages.map((message) => {
      if (message.id !== id) return message;
      changed = true;
      return {
        ...message,
        ...metadata,
        [timestampKey]: new Date().toISOString(),
        status: nextStatus,
      };
    });
    if (changed) writeRunInboxMessages(stateDir, updated);
    return changed;
  } finally {
    releaseLock();
  }
}

export function claimRunInboxMessageInStateDir(
  stateDir: string,
  owner = "runtime",
  statuses: string[] = ["queued"],
): RunInboxMessage | undefined {
  const releaseLock = acquireRunInboxLock(stateDir);
  try {
    const messages = readRunInboxMessagesFromStateDir(stateDir);
    const index = messages.findIndex((message) =>
      statuses.includes(String(message.status ?? "queued")),
    );
    if (index < 0) return undefined;
    const claimed = {
      ...messages[index],
      claimed_at: new Date().toISOString(),
      claimed_by: owner,
      id:
        typeof messages[index].id === "string"
          ? messages[index].id
          : randomUUID(),
      status: "claimed",
    } satisfies RunInboxMessage;
    messages[index] = claimed;
    writeRunInboxMessages(stateDir, messages);
    return claimed;
  } finally {
    releaseLock();
  }
}

export function appendRunInboxMessageInStateDir(
  stateDir: string,
  record: Record<string, unknown>,
): string {
  const id = randomUUID();
  const ts = new Date().toISOString();
  const releaseLock = acquireRunInboxLock(stateDir);
  try {
    writeFileSync(
      runInboxFile(stateDir),
      `${JSON.stringify({ ...record, id, queued_at: ts, received_at: ts, status: "queued" })}\n`,
      { flag: "a" },
    );
  } finally {
    releaseLock();
  }
  return id;
}

export async function processRunInboxMessagesInStateDir(
  stateDir: string,
  handler: (message: RunInboxMessage) => Promise<void> | void,
  options: { limit?: number; owner?: string; statuses?: string[] } = {},
): Promise<ProcessRunInboxResult> {
  const result: ProcessRunInboxResult = { claimed: 0, failed: 0, handled: 0 };
  const limit = Math.max(1, Number(options.limit ?? 1));
  const owner = options.owner ?? "runtime";
  for (let index = 0; index < limit; index += 1) {
    const message = claimRunInboxMessageInStateDir(
      stateDir,
      owner,
      options.statuses,
    );
    if (!message?.id) break;
    result.claimed += 1;
    try {
      await handler(message);
      if (updateRunInboxMessageStatusInStateDir(stateDir, message.id, "handled")) {
        result.handled += 1;
      }
    } catch (error) {
      if (
        updateRunInboxMessageStatusInStateDir(stateDir, message.id, "failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      ) {
        result.failed += 1;
      }
    }
  }
  return result;
}
