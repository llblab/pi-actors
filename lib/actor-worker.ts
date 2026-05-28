/**
 * Canonical mailbox-backed actor worker entrypoint logic.
 * Zones: worker demo, mailbox loop recipe runtime
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRoomMessage, ensureRoomMember, readBranchInboxMessages } from "./actor-rooms.ts";
import { handleMailboxLoopOnce, isMailboxLoopStopMessage } from "./mailbox-loop.ts";

interface ActorWorkerArgs {
  artifact_dir?: string;
  branch?: string;
  poll_ms?: string | number;
  run?: string;
  stale_claim_ms?: string | number;
  state_dir?: string;
  write_artifacts?: string | boolean;
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

function enabled(value: unknown): boolean {
  return value !== false && value !== "false" && value !== "0";
}

function safeName(value: unknown): string {
  return String(value ?? "unknown").replaceAll(/[^A-Za-z0-9_.-]+/g, "_");
}

export async function runActorWorker(argv = process.argv.slice(2)): Promise<void> {
  const args = parseActorWorkerArgs(argv);
  const stateDir = String(args.state_dir ?? "");
  const run = String(args.run ?? "");
  const branch = String(args.branch ?? "worker");
  const pollMs = Math.max(50, Number(args.poll_ms ?? 1000));
  const staleClaimMs = Math.max(0, Number(args.stale_claim_ms ?? 0));
  const artifactDir = String(args.artifact_dir ?? join(stateDir, "worker-artifacts"));
  const writeArtifacts = enabled(args.write_artifacts ?? true);

  if (!stateDir || !run) {
    throw new Error("usage: actor-worker.mjs --state-dir <dir> --run <id> [--branch worker] [--poll-ms 1000]");
  }

  const branchAddress = `branch:${run}/${branch}`;
  const roomAddress = `room:${run}`;
  const journalPath = join(stateDir, "worker-events.jsonl");
  const statusPath = join(stateDir, "worker-status.json");
  if (writeArtifacts) mkdirSync(artifactDir, { recursive: true });

  function journal(event: string, data: Record<string, unknown> = {}): void {
    appendFileSync(
      journalPath,
      `${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}\n`,
    );
  }

  function staleClaims(): number {
    if (staleClaimMs <= 0) return 0;
    const cutoff = Date.now() - staleClaimMs;
    return readBranchInboxMessages(stateDir, run, branchAddress).filter((record) => {
      if (record.status !== "claimed" || !record.claimed_at) return false;
      const claimedAt = Date.parse(record.claimed_at);
      return Number.isFinite(claimedAt) && claimedAt < cutoff;
    }).length;
  }

  function status(state: string, data: Record<string, unknown> = {}): void {
    writeFileSync(
      statusPath,
      `${JSON.stringify({ artifact_dir: artifactDir, branch, run, stale_claims: staleClaims(), state, ts: new Date().toISOString(), ...data }, null, 2)}\n`,
    );
  }

  function writeResultArtifact(id: unknown, result: string): string | undefined {
    if (!writeArtifacts) return undefined;
    const path = join(artifactDir, `${safeName(id)}.txt`);
    writeFileSync(path, `${result}\n`);
    return path;
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
  journal("worker.started", { artifact_dir: artifactDir, branch, run, stale_claim_ms: staleClaimMs });
  status("awaiting_assignment", { handled: 0, stale_claim_ms: staleClaimMs });

  let handled = 0;

  let stopping = false;
  while (!stopping) {
    const result = await handleMailboxLoopOnce(
      { address: branchAddress, kind: "branch", run, stateDir },
      (message) => {
        if (isMailboxLoopStopMessage(message)) {
          stopping = true;
          room("actor.leave", `${branch} stopping`, { branch, reason: message.type });
          journal("worker.stopping", { id: message.id, type: message.type });
          status("stopping", { handled, reason: message.type });
          return;
        }
        room("task.claim", `${branch} claimed ${message.type}`, {
          branch,
          id: message.id,
          type: message.type,
        });
        const result = text(message.body);
        const artifact = writeResultArtifact(message.id, result);
        handled += 1;
        room("task.result", `${branch} handled ${message.type}`, {
          artifact,
          branch,
          id: message.id,
          result,
          type: message.type,
        });
        room("awaiting_assignment", `${branch} awaiting assignment`, { branch });
        journal("task.handled", { artifact, id: message.id, type: message.type });
        status("awaiting_assignment", {
          handled,
          last_artifact: artifact,
          last_id: message.id,
          last_type: message.type,
          stale_claim_ms: staleClaimMs,
        });
      },
      { owner: branchAddress },
    );
    if (!result.handled) await sleep(pollMs);
  }

  journal("worker.done", { branch, handled, run });
  status("done", { handled });
}
