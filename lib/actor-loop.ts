/**
 * Minimal actor mailbox loop helpers.
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

export type ActorLoopMailboxMessage = RunInboxMessage | BranchInboxRecord;

export type ActorLoopTarget =
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

export interface ActorLoopClaimOptions {
  owner?: string;
  statuses?: string[];
}

export interface ActorLoopHandleResult {
  handled: boolean;
  id?: string;
  message?: ActorLoopMailboxMessage;
  target: ActorLoopTarget;
}

function messageId(
  message: ActorLoopMailboxMessage | undefined,
): string | undefined {
  return typeof message?.id === "string" ? message.id : undefined;
}

export function claimActorLoopMessage(
  target: ActorLoopTarget,
  options: ActorLoopClaimOptions = {},
): ActorLoopMailboxMessage | undefined {
  const owner = options.owner ?? "actor-loop";
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

export function updateActorLoopMessageStatus(
  target: ActorLoopTarget,
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

export async function handleActorLoopOnce(
  target: ActorLoopTarget,
  handler: (message: ActorLoopMailboxMessage) => Promise<void> | void,
  options: ActorLoopClaimOptions = {},
): Promise<ActorLoopHandleResult> {
  const message = claimActorLoopMessage(target, options);
  const id = messageId(message);
  if (!message || !id) return { handled: false, target };
  try {
    await handler(message);
    updateActorLoopMessageStatus(target, id, "handled");
    return { handled: true, id, message, target };
  } catch (error) {
    updateActorLoopMessageStatus(target, id, "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
