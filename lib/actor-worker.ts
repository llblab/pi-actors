/**
 * Canonical mailbox-backed actor worker entrypoint logic.
 * Zones: worker demo, mailbox loop recipe runtime
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { appendRoomMessage, ensureRoomMember } from "./actor-rooms.ts";
import { handleMailboxLoopOnce, isMailboxLoopStopMessage } from "./mailbox-loop.ts";

interface ActorWorkerArgs {
  branch?: string;
  poll_ms?: string | number;
  run?: string;
  state_dir?: string;
}

export function parseActorWorkerArgs(argv: string[]): ActorWorkerArgs {
  const args: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args as ActorWorkerArgs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function runActorWorker(argv = process.argv.slice(2)): Promise<void> {
  const args = parseActorWorkerArgs(argv);
  const stateDir = String(args.state_dir ?? "");
  const run = String(args.run ?? "");
  const branch = String(args.branch ?? "worker");
  const pollMs = Math.max(50, Number(args.poll_ms ?? 1000));

  if (!stateDir || !run) {
    throw new Error("usage: actor-worker.mjs --state-dir <dir> --run <id> [--branch worker] [--poll-ms 1000]");
  }

  const branchAddress = `branch:${run}/${branch}`;
  const roomAddress = `room:${run}`;
  const journalPath = join(stateDir, "worker-events.jsonl");

  function journal(event: string, data: Record<string, unknown> = {}): void {
    appendFileSync(
      journalPath,
      `${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}\n`,
    );
  }

  function room(type: string, summary: string, body: Record<string, unknown> = {}): void {
    appendRoomMessage(stateDir, "main", {
      body,
      from: branchAddress,
      summary,
      to: roomAddress,
      type,
    });
  }

  ensureRoomMember(
    stateDir,
    run,
    "main",
    branchAddress,
    { display: branch, role: "worker", status: "present" },
    `${branch} joined as mailbox worker`,
  );
  room("awaiting_assignment", `${branch} awaiting assignment`, { branch });
  journal("worker.started", { branch, run });

  let stopping = false;
  while (!stopping) {
    const result = await handleMailboxLoopOnce(
      { address: branchAddress, kind: "branch", run, stateDir },
      (message) => {
        if (isMailboxLoopStopMessage(message)) {
          stopping = true;
          room("actor.leave", `${branch} stopping`, { branch, reason: message.type });
          journal("worker.stopping", { id: message.id, type: message.type });
          return;
        }
        room("task.claim", `${branch} claimed ${message.type}`, {
          branch,
          id: message.id,
          type: message.type,
        });
        room("task.result", `${branch} handled ${message.type}`, {
          branch,
          id: message.id,
          result: text(message.body),
          type: message.type,
        });
        room("awaiting_assignment", `${branch} awaiting assignment`, { branch });
        journal("task.handled", { id: message.id, type: message.type });
      },
      { owner: branchAddress },
    );
    if (!result.handled) await sleep(pollMs);
  }

  journal("worker.done", { branch, run });
}
