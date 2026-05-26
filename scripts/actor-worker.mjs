#!/usr/bin/env node

/**
 * Canonical mailbox-backed actor worker demo.
 *
 * This helper demonstrates the long-lived branch-worker pattern for pi-actors:
 * join the default room, claim branch inbox messages one at a time, publish
 * task.claim/task.result/awaiting_assignment room events, and exit cleanly on
 * control.stop/cancel/kill. It is intentionally policy-light and does not own
 * task selection, model choice, prompts, or project-specific work.
 */

import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function scriptFile() {
  return fileURLToPath(import.meta.url);
}

function packageRoot() {
  return dirname(dirname(scriptFile()));
}

function libModulePath(name) {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", `${name}.js`);
  return existsSync(compiled) ? compiled : join(root, "lib", `${name}.ts`);
}

async function importLib(name) {
  return import(pathToFileURL(libModulePath(name)).href);
}

function parseArgs(argv) {
  const args = {};
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
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const args = parseArgs(process.argv.slice(2));
const stateDir = String(args.state_dir ?? "");
const run = String(args.run ?? "");
const branch = String(args.branch ?? "worker");
const pollMs = Math.max(50, Number(args.poll_ms ?? 1000));

if (!stateDir || !run) {
  console.error("usage: actor-worker.mjs --state-dir <dir> --run <id> [--branch worker] [--poll-ms 1000]");
  process.exit(2);
}

const branchAddress = `branch:${run}/${branch}`;
const roomAddress = `room:${run}`;
const journalPath = join(stateDir, "worker-events.jsonl");

const { appendRoomMessage, ensureRoomMember } = await importLib("actor-rooms");
const { handleMailboxLoopOnce, isMailboxLoopStopMessage } = await importLib("mailbox-loop");

function journal(event, data = {}) {
  appendFileSync(
    journalPath,
    `${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}\n`,
  );
}

function room(type, summary, body = {}) {
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
