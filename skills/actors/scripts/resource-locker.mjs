#!/usr/bin/env node

/**
 * Local coordination locker service.
 *
 * Owns queue, lease-lock, journal, snapshot, and platform control endpoint
 * behavior for the locker/coordinator-locker recipe surfaces. Kept standalone
 * because no non-script TypeScript domain consumes this implementation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

async function importRuntimeModule(name) {
  const root = packageRoot();
  const compiled = join(root, "lib", `${name}.js`);
  const source = join(root, "lib", `${name}.ts`);
  return await import(pathToFileURL(existsSync(compiled) ? compiled : source).href);
}

const { acquireFileMutationLock, writeJsonAtomic, writeTextAtomic } = await importRuntimeModule("file-state");
const { readJsonlFileResilient } = await importRuntimeModule("state-readers");
const LOCKER_JOURNAL_MAX_RECORDS = 512;
const LOCKER_JOURNAL_MAX_BYTES = 1024 * 1024;
const { claimRunControlByIdInStateDir, updateRunControlStatusInStateDir } =
  await importRuntimeModule("runs-controls");
const { appendRunTraceEvent } = await importRuntimeModule("runs-trace");

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

async function runLocker(argv = process.argv.slice(2)) {
  const { mode, stateDir, leaseMs, lines } = parseArgs(argv);
  const queuePath = join(stateDir, "queue.json");
  const locksPath = join(stateDir, "locks.json");
  const journalPath = join(stateDir, "journal.jsonl");
  const controlPath = join(stateDir, "control.fifo");
  let runInstanceId;
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
    writeJsonAtomic(path, value);
  }
  function getControlEndpoint() {
    if (process.platform !== "win32") return { path: controlPath, type: "fifo" };
    const hash = createHash("sha256")
      .update(resolve(stateDir))
      .digest("hex")
      .slice(0, 20);
    return { path: `\\\\.\\pipe\\pi-actors-locker-${hash}`, type: "named-pipe" };
  }
  function writeControlEndpoint(endpoint) {
    if (!runInstanceId) throw new Error("Run generation unavailable for Control endpoint");
    writeJson(join(stateDir, "control-endpoint.json"), {
      ...endpoint,
      ready_at: new Date().toISOString(),
      run_instance_id: runInstanceId,
    });
  }
  function journal(event, data = {}) {
    const release = acquireFileMutationLock(journalPath);
    try {
      const records = [...readJsonlFileResilient(journalPath).records,
        { event, ts: new Date().toISOString(), ...data }]
        .slice(-LOCKER_JOURNAL_MAX_RECORDS);
      let content = encodeJournal(records);
      while (records.length && Buffer.byteLength(content) > LOCKER_JOURNAL_MAX_BYTES) {
        records.shift();
        content = encodeJournal(records);
      }
      writeTextAtomic(journalPath, content);
    } finally { release(); }
  }
  function encodeJournal(records) {
    return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  }
  function emitTrace(kind, summary, data = {}, level = "info") {
    appendRunTraceEvent(stateDir, {
      attention: "followup",
      data,
      kind,
      level,
      summary,
    });
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
  function normalizeControl(line) {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try {
      const control = JSON.parse(trimmed);
      if (
        !control ||
        typeof control !== "object" ||
        typeof control.id !== "string" ||
        typeof control.action !== "string"
      ) {
        throw new Error("invalid Control envelope");
      }
      return control;
    } catch (error) {
      throw new Error(
        `Invalid Control envelope: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  function handle(control) {
    const action = control.action;
    const body =
      control.input && typeof control.input === "object" ? control.input : {};
    let queue = readJson(queuePath, { items: [] });
    let locks = cleanExpiredLocks(readJson(locksPath, {}));
    if (action === "stop") {
      writeJson(locksPath, locks);
      journal("lock.stopped", {});
      emitTrace("lock.stopped", "Locker stopped", {
        queueDepth: queue.items?.length ?? 0,
      });
      return true;
    }
    if (action === "enqueue") {
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
      emitTrace("lock.enqueued", `Queued task ${item.id}`, {
        id: item.id,
        queueDepth: queue.items.length,
      });
      return;
    }
    if (action === "claim") {
      const owner = body.owner;
      if (!owner) throw new Error("claim input.owner is required");
      const item = nextTask(queue, locks);
      if (!item) {
        writeJson(queuePath, queue);
        writeJson(locksPath, locks);
        emitTrace("lock.empty", "No claimable task", {
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
      emitTrace("lock.assigned", `Assigned task ${item.id}`, { owner, task: item });
      return;
    }
    if (action === "acquire") {
      const resource = body.resource;
      const owner = body.owner;
      if (!resource || !owner)
        throw new Error("acquire input.resource and input.owner are required");
      if (locks[resource])
        emitTrace(
          "lock.denied",
          `Lock denied ${resource}`,
          { resource, owner, current: locks[resource] },
          "warning",
        );
      else {
        locks[resource] = { owner, expiresAt: now() + leaseMs };
        emitTrace("lock.granted", `Lock granted ${resource}`, { resource, owner });
      }
      writeJson(locksPath, locks);
      return;
    }
    if (action === "renew") {
      const resource = body.resource;
      const owner = body.owner;
      if (!resource || !owner)
        throw new Error("renew input.resource and input.owner are required");
      const current = locks[resource];
      if (!current) {
        emitTrace(
          "lock.denied",
          `Lock renew denied ${resource}`,
          { resource, owner, reason: "missing" },
          "warning",
        );
      } else if (current.owner !== owner) {
        emitTrace(
          "lock.denied",
          `Lock renew denied ${resource}`,
          { resource, owner, current },
          "warning",
        );
      } else {
        locks[resource] = { ...current, expiresAt: now() + leaseMs };
        emitTrace("lock.renewed", `Lock renewed ${resource}`, { resource, owner });
      }
      writeJson(locksPath, locks);
      return;
    }
    if (action === "release") {
      const resource = body.resource;
      if (resource) delete locks[resource];
      writeJson(locksPath, locks);
      emitTrace("lock.released", `Lock released ${resource}`, { resource });
      return;
    }
    if (
      action === "complete" || action === "fail"
    ) {
      const eventType = `lock.${action}`;
      journal(eventType, body);
      emitTrace(
        eventType,
        `${eventType} ${body.id ?? ""}`.trim(),
        body,
        eventType === "lock.fail" ? "error" : "info",
      );
      writeJson(locksPath, locks);
      writeJson(queuePath, queue);
      return;
    }
    journal("lock.unknown", { action, input: body });
    emitTrace("lock.unknown", `Unknown Control ${action}`, { action, input: body }, "warning");
  }
  if (mode === "snapshot") {
    printSnapshot();
    process.exit(0);
  }
  const startupRun = readJson(join(stateDir, "run.json"), undefined);
  if (!startupRun || typeof startupRun.run_instance_id !== "string") {
    throw new Error("Run generation unavailable for Control service");
  }
  runInstanceId = startupRun.run_instance_id;
  function handleLine(line) {
    const control = normalizeControl(line);
    if (!control) return false;
    const claimed = claimRunControlByIdInStateDir(
      stateDir, runInstanceId, control.id,
    );
    if (!claimed) {
      emitTrace(
        "lock.control_rejected",
        "Rejected stale or unjournaled Control",
        { id: control.id },
        "warning",
      );
      return false;
    }
    try {
      const stopping = handle(claimed) === true;
      updateRunControlStatusInStateDir(
        stateDir, claimed.id, "handled", {}, ["claimed"],
      );
      return stopping;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      updateRunControlStatusInStateDir(
        stateDir, claimed.id, "failed", { error: text }, ["claimed"],
      );
      journal("lock.error", { error: text });
      emitTrace("lock.error", text, { error: text }, "error");
      return false;
    }
  }
  async function serveFifo(endpoint) {
    if (!existsSync(endpoint.path)) {
      const result = spawnSync("mkfifo", [endpoint.path]);
      if (result.status !== 0)
        throw new Error(`mkfifo failed: ${result.stderr?.toString?.() ?? ""}`);
    }
    writeControlEndpoint(endpoint);
    while (true) {
      const fs = await import("node:fs");
      const fd = fs.openSync(endpoint.path, fs.constants.O_RDWR);
      const stream = fs.createReadStream(undefined, {
        autoClose: false,
        encoding: "utf8",
        fd,
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (handleLine(line)) {
          fs.writeSync(fd, "\n");
          stream.destroy();
          return;
        }
      }
      fs.closeSync(fd);
    }
  }
  async function serveNamedPipe(endpoint) {
    let resolveStopped;
    const stopped = new Promise((resolve) => {
      resolveStopped = resolve;
    });
    const server = createServer((socket) => {
      const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!handleLine(line)) return;
        rl.close();
        socket.destroy();
        server.close(() => resolveStopped());
      });
    });
    await new Promise((resolveReady, rejectReady) => {
      server.once("error", rejectReady);
      server.listen(endpoint.path, () => {
        server.off("error", rejectReady);
        writeControlEndpoint(endpoint);
        resolveReady();
      });
    });
    await stopped;
  }
  const endpoint = getControlEndpoint();
  writeJson(queuePath, readJson(queuePath, { items: [] }));
  writeJson(locksPath, cleanExpiredLocks(readJson(locksPath, {})));
  journal("lock.started", { leaseMs, control: endpoint.type });
  emitTrace("lock.started", "Locker ready", { leaseMs, control: endpoint.type });
  if (endpoint.type === "named-pipe") await serveNamedPipe(endpoint);
  else await serveFifo(endpoint);
}

try {
  await runLocker(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
