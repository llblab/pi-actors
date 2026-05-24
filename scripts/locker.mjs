#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

function parseArgs(argv) {
  const args = { mode: "serve", stateDir: "", leaseMs: 600000, lines: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "serve" || arg === "snapshot") args.mode = arg;
    else if (arg === "--state-dir") args.stateDir = argv[++index] ?? "";
    else if (arg === "--lease-ms")
      args.leaseMs = Number(argv[++index] ?? args.leaseMs);
    else if (arg === "--lines")
      args.lines = Number(argv[++index] ?? args.lines);
  }
  if (!args.stateDir) throw new Error("--state-dir is required");
  if (!Number.isFinite(args.leaseMs) || args.leaseMs <= 0)
    args.leaseMs = 600000;
  if (!Number.isFinite(args.lines) || args.lines <= 0) args.lines = 20;
  return args;
}

const { mode, stateDir, leaseMs, lines } = parseArgs(process.argv.slice(2));
const queuePath = join(stateDir, "queue.json");
const locksPath = join(stateDir, "locks.json");
const journalPath = join(stateDir, "journal.jsonl");
const outboxPath = join(stateDir, "outbox.jsonl");
const controlPath = join(stateDir, "control.fifo");
mkdirSync(stateDir, { recursive: true });

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function journal(event, data = {}) {
  appendFileSync(
    journalPath,
    `${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}\n`,
  );
}
function outbox(type, summary, body = {}, level = "info") {
  appendFileSync(
    outboxPath,
    `${JSON.stringify({ to: "coordinator", from: `run:${process.env.run_id ?? "locker"}`, type, event: type, summary, body, data: body, delivery: "followup", level, ts: new Date().toISOString() })}\n`,
  );
}
function now() {
  return Date.now();
}
function cleanExpiredLocks(locks) {
  const current = now();
  const kept = {};
  for (const [key, lock] of Object.entries(locks)) {
    if (Number(lock.expiresAt) > current) kept[key] = lock;
    else journal("lock.expired", { resource: key, owner: lock.owner });
  }
  return kept;
}
function normalizeMessage(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (["stop", "quit", "exit", "cancel"].includes(trimmed.toLowerCase())) {
    return { type: "control.stop", body: {} };
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return { type: "lock.enqueue", body: { task: trimmed } };
  }
}
function tailJournal(count) {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}
function printSnapshot() {
  const locks = cleanExpiredLocks(readJson(locksPath, {}));
  writeJson(locksPath, locks);
  const queue = readJson(queuePath, { items: [] });
  console.log(
    JSON.stringify(
      {
        queueDepth: Array.isArray(queue.items) ? queue.items.length : 0,
        queue,
        locks,
        journal: tailJournal(lines),
      },
      null,
      2,
    ),
  );
}
function nextTask(queue, locks) {
  const items = Array.isArray(queue.items) ? queue.items : [];
  const index = items.findIndex((item) => {
    const resources = Array.isArray(item.resources) ? item.resources : [];
    return resources.every((resource) => !locks[resource]);
  });
  if (index < 0) return undefined;
  return items.splice(index, 1)[0];
}
function handle(message) {
  const type = message.type || message.event || "lock.enqueue";
  const body =
    message.body && typeof message.body === "object" ? message.body : message;
  let queue = readJson(queuePath, { items: [] });
  let locks = cleanExpiredLocks(readJson(locksPath, {}));
  if (type === "control.stop" || type === "control.cancel") {
    writeJson(locksPath, locks);
    journal("control.stop", {});
    outbox("lock.stopped", "Locker stopped", {
      queueDepth: queue.items?.length ?? 0,
    });
    process.exit(0);
  }
  if (type === "lock.enqueue" || type === "coord.enqueue") {
    const item = {
      id: body.id || `task-${Date.now()}`,
      task: body.task ?? body,
      resources: body.resources ?? [],
      enqueuedAt: new Date().toISOString(),
    };
    queue.items = [...(queue.items ?? []), item];
    writeJson(queuePath, queue);
    writeJson(locksPath, locks);
    journal("lock.enqueued", { id: item.id, resources: item.resources });
    outbox("lock.enqueued", `Queued task ${item.id}`, {
      id: item.id,
      queueDepth: queue.items.length,
    });
    return;
  }
  if (type === "lock.claim" || type === "coord.claim") {
    const owner = body.owner || message.from || "worker";
    const item = nextTask(queue, locks);
    if (!item) {
      writeJson(queuePath, queue);
      writeJson(locksPath, locks);
      outbox("lock.empty", "No claimable task", {
        owner,
        queueDepth: queue.items?.length ?? 0,
      });
      return;
    }
    for (const resource of item.resources ?? [])
      locks[resource] = { owner, task: item.id, expiresAt: now() + leaseMs };
    writeJson(queuePath, queue);
    writeJson(locksPath, locks);
    journal("lock.assigned", {
      id: item.id,
      owner,
      resources: item.resources,
    });
    outbox("lock.assigned", `Assigned task ${item.id}`, { owner, task: item });
    return;
  }
  if (type === "lock.acquire") {
    const resource = body.resource;
    const owner = body.owner || message.from || "worker";
    if (!resource) throw new Error("lock.acquire body.resource is required");
    if (locks[resource])
      outbox(
        "lock.denied",
        `Lock denied ${resource}`,
        { resource, owner, current: locks[resource] },
        "warning",
      );
    else {
      locks[resource] = { owner, expiresAt: now() + leaseMs };
      outbox("lock.granted", `Lock granted ${resource}`, { resource, owner });
    }
    writeJson(locksPath, locks);
    return;
  }
  if (type === "lock.renew") {
    const resource = body.resource;
    const owner = body.owner || message.from || "worker";
    if (!resource) throw new Error("lock.renew body.resource is required");
    const current = locks[resource];
    if (!current) {
      outbox("lock.denied", `Lock renew denied ${resource}`, { resource, owner, reason: "missing" }, "warning");
    } else if (current.owner !== owner) {
      outbox("lock.denied", `Lock renew denied ${resource}`, { resource, owner, current }, "warning");
    } else {
      locks[resource] = { ...current, expiresAt: now() + leaseMs };
      outbox("lock.renewed", `Lock renewed ${resource}`, { resource, owner });
    }
    writeJson(locksPath, locks);
    return;
  }
  if (type === "lock.release") {
    const resource = body.resource;
    if (resource) delete locks[resource];
    writeJson(locksPath, locks);
    outbox("lock.released", `Lock released ${resource}`, { resource });
    return;
  }
  if (type === "lock.complete" || type === "lock.fail" || type === "coord.complete" || type === "coord.fail") {
    const eventType = type.startsWith("coord.") ? type.replace("coord.", "lock.") : type;
    journal(eventType, body);
    outbox(
      eventType,
      `${eventType} ${body.id ?? ""}`.trim(),
      body,
      eventType === "lock.fail" ? "error" : "info",
    );
    writeJson(locksPath, locks);
    writeJson(queuePath, queue);
    return;
  }
  journal("lock.unknown", { type, body });
  outbox("lock.unknown", `Unknown message ${type}`, { type, body }, "warning");
}

if (mode === "snapshot") {
  printSnapshot();
  process.exit(0);
}

if (!existsSync(controlPath)) {
  const result = spawnSync("mkfifo", [controlPath]);
  if (result.status !== 0)
    throw new Error(`mkfifo failed: ${result.stderr?.toString?.() ?? ""}`);
}
writeJson(queuePath, readJson(queuePath, { items: [] }));
writeJson(locksPath, cleanExpiredLocks(readJson(locksPath, {})));
journal("lock.started", { leaseMs });
outbox("lock.started", "Locker ready", { leaseMs });

while (true) {
  const stream = await import("node:fs").then((fs) =>
    fs.createReadStream(controlPath, { encoding: "utf8" }),
  );
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const message = normalizeMessage(line);
    if (!message) continue;
    try {
      handle(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      journal("lock.error", { error: text });
      outbox("lock.error", text, { error: text }, "error");
    }
  }
}
