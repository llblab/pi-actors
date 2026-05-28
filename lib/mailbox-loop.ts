/**
 * Minimal mailbox loop helpers.
 * Zones: mailbox-consuming actors, run/branch inbox claiming, handler status transitions
 * Owns small reusable primitives for recipe authors; scheduling and task policy stay outside.
 */

import {
  claimBranchInboxMessage,
  updateBranchInboxMessageStatus,
  type BranchInboxRecord,
} from "./actor-rooms.ts";
import {
  claimRunInboxMessage,
  updateRunInboxMessageStatus,
  type RunInboxMessage,
} from "./async-runs.ts";

export type MailboxLoopMessage = RunInboxMessage | BranchInboxRecord;

export type MailboxLoopTarget =
  | {
      kind: "run";
      runOrDir: string;
    }
  | {
      address: string;
      kind: "branch";
      run: string;
      stateDir: string;
    };

export interface MailboxLoopClaimOptions {
  owner?: string;
  statuses?: string[];
}

export interface MailboxLoopHandleResult {
  handled: boolean;
  id?: string;
  message?: MailboxLoopMessage;
  target: MailboxLoopTarget;
}

export interface MailboxLoopDrainOptions extends MailboxLoopClaimOptions {
  maxMessages?: number;
  stopOnControl?: boolean;
}

export interface MailboxLoopDrainResult {
  handled: number;
  stopped: boolean;
  target: MailboxLoopTarget;
}

export function isMailboxLoopStopMessage(message: unknown): boolean {
  const type =
    message && typeof message === "object" && "type" in message
      ? (message as { type?: unknown }).type
      : undefined;
  return type === "control.kill";
}

function messageId(
  message: MailboxLoopMessage | undefined,
): string | undefined {
  return typeof message?.id === "string" ? message.id : undefined;
}

export function claimMailboxLoopMessage(
  target: MailboxLoopTarget,
  options: MailboxLoopClaimOptions = {},
): MailboxLoopMessage | undefined {
  const owner = options.owner ?? "mailbox-loop";
  const statuses = options.statuses ?? ["queued"];
  return target.kind === "run"
    ? claimRunInboxMessage(target.runOrDir, owner, statuses)
    : claimBranchInboxMessage(
        target.stateDir,
        target.run,
        target.address,
        owner,
        statuses,
      );
}

export function updateMailboxLoopMessageStatus(
  target: MailboxLoopTarget,
  id: string,
  status: "claimed" | "handled" | "failed",
  metadata: Record<string, unknown> = {},
): boolean {
  return target.kind === "run"
    ? updateRunInboxMessageStatus(target.runOrDir, id, status, metadata)
    : updateBranchInboxMessageStatus(
        target.stateDir,
        target.run,
        target.address,
        id,
        status,
        metadata,
      );
}

export async function handleMailboxLoopOnce(
  target: MailboxLoopTarget,
  handler: (message: MailboxLoopMessage) => Promise<void> | void,
  options: MailboxLoopClaimOptions = {},
): Promise<MailboxLoopHandleResult> {
  const message = claimMailboxLoopMessage(target, options);
  const id = messageId(message);
  if (!message || !id) return { handled: false, target };
  try {
    await handler(message);
    updateMailboxLoopMessageStatus(target, id, "handled");
    return { handled: true, id, message, target };
  } catch (error) {
    updateMailboxLoopMessageStatus(target, id, "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function drainMailboxLoopMessages(
  target: MailboxLoopTarget,
  handler: (message: MailboxLoopMessage) => Promise<void> | void,
  options: MailboxLoopDrainOptions = {},
): Promise<MailboxLoopDrainResult> {
  const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? 100));
  let handled = 0;
  for (; handled < maxMessages; handled += 1) {
    const result = await handleMailboxLoopOnce(target, handler, options);
    if (!result.handled || !result.message) {
      return { handled, stopped: false, target };
    }
    if (
      options.stopOnControl !== false &&
      isMailboxLoopStopMessage(result.message)
    ) {
      return { handled: handled + 1, stopped: true, target };
    }
  }
  return { handled, stopped: false, target };
}
