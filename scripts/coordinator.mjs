#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function numberArg(name, fallback) {
  const value = Number(arg(name, String(fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boolArg(name, fallback = false) {
  const value = arg(name, String(fallback)).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function normalizeRoles(value) {
  if (!Array.isArray(value)) throw new Error("roles must be an array");
  return value.map((role, index) => ({
    name: String(role.name ?? `actor-${index + 1}`),
    persona: String(role.persona ?? role.role ?? "room participant"),
  }));
}

function parseRoles(raw) {
  if (!raw.trim()) return defaultRoles;
  try {
    return normalizeRoles(JSON.parse(raw));
  } catch {
    return raw.split(",").map((item, index) => ({
      name: item.trim() || `actor-${index + 1}`,
      persona: "room participant",
    }));
  }
}

async function loadRoles(raw, path) {
  if (path.trim()) return normalizeRoles(JSON.parse(await readFile(path, "utf8")));
  return parseRoles(raw);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi/agent`;
}

function runStateDir(runId) {
  return `${agentDir()}/tmp/pi-actors/runs/${runId}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const STATE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const STATE_LOCK_TIMEOUT_MS = 5000;

async function waitForPath(path, timeoutMs = 5000) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await sleep(50);
  }
}

async function acquireStateLock(parentDir, name, label) {
  await mkdir(parentDir, { recursive: true });
  const lockDir = `${parentDir}/${name}`;
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(`${lockDir}/owner.json`, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
      return async () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      try {
        const current = await stat(lockDir);
        if (Date.now() - current.mtimeMs > STATE_LOCK_MAX_AGE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`${label} lock timed out.`, { cause: error });
      }
      await sleep(10);
    }
  }
}

async function acquireBranchInboxLock(runId, branchName) {
  return acquireStateLock(`${runStateDir(runId)}/branches/${branchName}`, ".inbox.lock", `Branch inbox ${branchName}`);
}

async function writeLockerMessage(locker, message) {
  if (!locker) return;
  await waitForPath(locker.controlPath);
  await writeFile(locker.controlPath, `${JSON.stringify(message)}\n`, { flag: "a" });
  await sleep(50);
}

async function startLocker(config) {
  if (!config.locker) return undefined;
  const lockerStateDir = `${runStateDir(config.runId)}/locker`;
  await mkdir(lockerStateDir, { recursive: true });
  const child = spawn(new URL("./locker.mjs", import.meta.url).pathname, [
    "serve",
    "--state-dir",
    lockerStateDir,
    "--lease-ms",
    String(config.lockerLeaseMs),
  ], {
    env: { ...process.env, run_id: config.runId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[locker] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[locker] ${chunk}`));
  const locker = { child, controlPath: `${lockerStateDir}/control.fifo`, stateDir: lockerStateDir };
  await waitForPath(locker.controlPath);
  await writeLockerMessage(locker, {
    type: "lock.enqueue",
    body: { id: "coordinator-artifact", task: "Own final artifact synthesis", resources: [config.artifactPath || "artifact"] },
  });
  return locker;
}

async function stopLocker(locker) {
  if (!locker) return;
  try {
    await writeLockerMessage(locker, { type: "control.stop", body: {} });
    await sleep(100);
  } finally {
    if (!locker.child.killed) locker.child.kill("SIGTERM");
  }
}

function runPi(prompt, model, thinking) {
  return new Promise((resolve) => {
    const args = [
      "--tools", "inspect,message",
      "--no-context-files",
      "--no-skills",
      "--no-session",
    ];
    if (model) {
      args.push("--model", model);
    }
    if (thinking) {
      args.push("--thinking", thinking);
    }
    args.push("-p", prompt);

    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

async function readRoomTranscript(config) {
  const messagesPath = `${runStateDir(config.runId)}/rooms/main/messages.jsonl`;
  try {
    const raw = await readFile(messagesPath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-160)
      .map((line) => {
        try {
          const message = JSON.parse(line);
          const from = String(message.from || "unknown").replace(/^branch:[^/]+\//, "");
          const type = String(message.type || "message");
          const body = typeof message.body === "string" ? message.body : JSON.stringify(message.body ?? "");
          return `${from} [${type}]: ${body}`;
        } catch {
          return line;
        }
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function synthesize(config, locker) {
  if (!config.artifactPath) return;
  if (locker) {
    await writeLockerMessage(locker, {
      type: "lock.claim",
      body: { owner: "coordinator:synthesizer" },
    });
  }
  const transcript = await readRoomTranscript(config);
  const prompt = `Synthesize this transcript into a concise Markdown artifact. Mission: ${config.mission}. Include: Title, Consensus, Roles, Protocol, Final Artifact Shape, Next Actions, Open Questions. Use only the transcript evidence below.\n\nTRANSCRIPT:\n${transcript.slice(-24000)}`;
  const result = await runPi(prompt, config.model, config.thinking);
  await writeFile(config.artifactPath, result.stdout.trim() ? result.stdout : "# Synthesis Artifact\n\nNo synthesis output.\n", "utf8");
  if (locker) {
    await writeLockerMessage(locker, {
      type: "lock.complete",
      body: { id: "coordinator-artifact", artifact: config.artifactPath },
    });
    await writeLockerMessage(locker, {
      type: "lock.release",
      body: { resource: config.artifactPath },
    });
  }
  process.stdout.write(`artifact=${config.artifactPath}\n`);
}

async function readInboxLines(inboxPath) {
  if (!existsSync(inboxPath)) return [];
  const content = await readFile(inboxPath, "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeInboxMessages(inboxPath, messages) {
  await writeFile(inboxPath, messages.map((message) => JSON.stringify(message)).join("\n") + "\n", "utf8");
}

async function claimQueuedInboxMessages(runId, branchName) {
  const inboxPath = `${runStateDir(runId)}/branches/${branchName}/inbox.jsonl`;
  const releaseLock = await acquireBranchInboxLock(runId, branchName);
  try {
    const messages = await readInboxLines(inboxPath);
    const claimedAt = new Date().toISOString();
    const queuedMessages = [];
    const updated = messages.map((msg, index) => {
      if (msg.status !== "queued" && msg.status) return msg;
      const claimed = {
        ...msg,
        claimed_at: claimedAt,
        id: msg.id || `legacy-${Date.now()}-${index}`,
        status: "claimed",
      };
      queuedMessages.push(claimed);
      return claimed;
    });
    if (queuedMessages.length > 0) await writeInboxMessages(inboxPath, updated);
    return queuedMessages;
  } catch {
    return [];
  } finally {
    await releaseLock();
  }
}

async function updateInboxMessagesStatus(runId, branchName, ids, status) {
  const inboxPath = `${runStateDir(runId)}/branches/${branchName}/inbox.jsonl`;
  const releaseLock = await acquireBranchInboxLock(runId, branchName);
  try {
    const messages = await readInboxLines(inboxPath);
    const idSet = new Set(ids);
    const updated = messages.map((msg) => {
      if (!msg.id || !idSet.has(msg.id)) return msg;
      return { ...msg, [`${status}_at`]: new Date().toISOString(), status };
    });
    await writeInboxMessages(inboxPath, updated);
  } catch {
    // Best-effort write
  } finally {
    await releaseLock();
  }
}

async function executeParticipantPrompt(role, basePrompt, config) {
  const branchName = role.name;
  const queuedMessages = await claimQueuedInboxMessages(config.runId, branchName);

  let finalPrompt = basePrompt;
  const claimedIds = [];

  if (queuedMessages.length > 0) {
    let inboxSection = "\n\nDIRECT INBOX MESSAGES FOR YOU (FIFO queue):\n";
    for (const msg of queuedMessages) {
      const bodyText = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body ?? "");
      inboxSection += `- From: ${msg.from || "unknown"} (Type: ${msg.type || "message"})\n  Body: ${bodyText}\n`;
      if (msg.id) claimedIds.push(msg.id);
    }
    inboxSection += "\nPlease acknowledge and address these direct messages in your response.\n";
    finalPrompt += inboxSection;
  }

  const result = await runPi(finalPrompt, config.model, config.thinking);

  if (claimedIds.length > 0) {
    const finalStatus = result.code === 0 ? "handled" : "failed";
    await updateInboxMessagesStatus(config.runId, branchName, claimedIds, finalStatus);
  }

  return result;
}

async function participantRound(role, round, config) {
  const displayName = role.name;
  const address = `branch:${config.runId}/${role.name}`;
  const prompt = `You are ${displayName} (${address}), ${role.persona}. Mission: ${config.mission}. Round ${round}/${config.rounds}. First call inspect target=${config.room} view=previews lines=30 and inspect target=${config.room} view=contacts. Then call message once to ${config.room} from ${address} type=chat.message. Body: 2-4 sentences that react to a named participant, propose the next coordination step, and refine the shared artifact. Use contacts for peer names and addresses. End stdout with summary <=160 chars.`;
  const result = await executeParticipantPrompt(role, prompt, config);
  process.stdout.write(`[${role.name} round ${round}] code=${result.code}\n${result.stdout}\n`);
  if (result.stderr.trim()) process.stderr.write(`[${role.name} round ${round}] ${result.stderr}\n`);
}

async function participantJoin(role, config) {
  const displayName = role.name;
  const address = `branch:${config.runId}/${role.name}`;
  const joinPrompt = `You are ${displayName}, ${role.persona}. Mission: ${config.mission}. Call tool message exactly once with to=${shellQuote(config.room)}, from=${shellQuote(address)}, type='actor.join', summary='${displayName} joined', body JSON {"role":${JSON.stringify(role.persona)},"display":${JSON.stringify(displayName)},"caps":["coordination","synthesis"],"claim":"coordinate on mission"}. Then print one short line.`;
  await runPi(joinPrompt, config.model, config.thinking);
}

async function participantLeave(role, config) {
  const displayName = role.name;
  const address = `branch:${config.runId}/${role.name}`;
  const leavePrompt = `Call tool message exactly once with to=${shellQuote(config.room)}, from=${shellQuote(address)}, type='actor.leave', summary='${displayName} left', body='finished coordinated work'. Then print goodbye.`;
  await runPi(leavePrompt, config.model, config.thinking);
}

// 1. consensus / swarm mode: iterative chat in a room
async function runConsensus(config, locker) {
  await Promise.all(config.roles.map((role) => participantJoin(role, config)));
  for (let round = 1; round <= config.rounds; round += 1) {
    await Promise.all(config.roles.map((role) => participantRound(role, round, config)));
    if (round < config.rounds && config.delay > 0) await sleep(config.delay * 1000);
  }
  await Promise.all(config.roles.map((role) => participantLeave(role, config)));
}

// 2. pipeline mode: sequential step-by-step
async function runPipeline(config, locker) {
  for (const role of config.roles) {
    await participantJoin(role, config);
    for (let round = 1; round <= config.rounds; round += 1) {
      await participantRound(role, round, config);
      if (round < config.rounds && config.delay > 0) await sleep(config.delay * 1000);
    }
    await participantLeave(role, config);
  }
}

// 3. fanout mode: run completely parallel independent processes
async function runFanout(config, locker) {
  await Promise.all(config.roles.map(async (role) => {
    await participantJoin(role, config);
    for (let round = 1; round <= config.rounds; round += 1) {
      await participantRound(role, round, config);
      if (round < config.rounds && config.delay > 0) await sleep(config.delay * 1000);
    }
    await participantLeave(role, config);
  }));
}

// 4. pool mode: dynamic task pulling from the locker queue
async function runPool(config, locker) {
  if (!locker) {
    throw new Error("Pool mode requires locker enabled (--locker=true)");
  }
  // Enqueue a set of sub-tasks based on the mission splits (for demo/simulation, we enqueue 3 sub-tasks)
  for (let index = 1; index <= 3; index += 1) {
    await writeLockerMessage(locker, {
      type: "lock.enqueue",
      body: { id: `subtask-${index}`, task: `Execute subtask ${index} under mission: ${config.mission}`, resources: [`resource-${index}`] },
    });
  }

  // Workers concurrently poll task queue
  await Promise.all(config.roles.map(async (role) => {
    const address = `branch:${config.runId}/${role.name}`;
    await participantJoin(role, config);
    
    while (true) {
      // Dequeue/Claim a task from the locker
      await writeLockerMessage(locker, {
        type: "lock.claim",
        body: { owner: role.name },
      });
      await sleep(100);

      // Check locks and queue state from locker snapshot
      const lockerData = await readJsonFile(`${locker.stateDir}/locks.json`);
      const assignedTask = Object.values(lockerData).find(lock => lock.owner === role.name);
      
      if (!assignedTask) {
        // No task assigned or queue is empty
        break;
      }

      const taskId = assignedTask.task;
      const prompt = `You are ${role.name}, ${role.persona}. You have been assigned task ${taskId}: "${assignedTask.task}". Solve it as part of the overall mission: ${config.mission}. End your response with a clear summary.`;
      const result = await executeParticipantPrompt(role, prompt, config);
      
      process.stdout.write(`[${role.name} completed ${taskId}] code=${result.code}\n${result.stdout}\n`);

      // Report task completion back to locker and release resource locks
      await writeLockerMessage(locker, {
        type: "lock.complete",
        body: { id: taskId, result: result.stdout },
      });
      // Release any locks associated with this resource
      for (const [res, lock] of Object.entries(lockerData)) {
        if (lock.owner === role.name) {
          await writeLockerMessage(locker, {
            type: "lock.release",
            body: { resource: res },
          });
        }
      }
    }

    await participantLeave(role, config);
  }));
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

const defaultRoles = [
  { name: "mapper", persona: "systems mapper; tracks shared structure and dependencies" },
  { name: "memory", persona: "memory keeper; preserves decisions and unresolved questions" },
  { name: "risk", persona: "risk scout; challenges weak coordination and missing owners" },
  { name: "flow", persona: "flow designer; turns scattered ideas into process rhythm" },
  { name: "operator", persona: "operator; converts ideas into concrete next actions" },
  { name: "narrative", persona: "narrative synthesizer; keeps the artifact coherent" },
  { name: "interface", persona: "interface designer; makes outputs visible and usable" },
  { name: "facilitator", persona: "facilitator; asks for consensus and convergence" },
];

const config = {
  runId: arg("run-id", process.env.run_id || process.env.RUN_ID || "coordinator-run"),
  mode: arg("mode", "consensus"), // "consensus" (default/swarm), "pipeline", "fanout", "pool"
  mission: arg("mission", "Coordinate a shared artifact and converge on next actions"),
  model: arg("model", ""),
  thinking: arg("thinking", "off"),
  roles: await loadRoles(arg("roles", ""), arg("roles-path", "")),
  rounds: numberArg("rounds", 4),
  delay: numberArg("delay", 10),
  artifactPath: arg("artifact-path", ""),
  locker: boolArg("locker", false),
  lockerLeaseMs: numberArg("locker-lease-ms", 600000),
};

if (!config.model) {
  console.error("--model is required");
  process.exit(2);
}
config.room = `room:${config.runId}`;

const failures = [];
const locker = await startLocker(config);

try {
  if (config.mode === "pipeline") {
    await runPipeline(config, locker);
  } else if (config.mode === "fanout") {
    await runFanout(config, locker);
  } else if (config.mode === "pool") {
    await runPool(config, locker);
  } else {
    // default: consensus / swarm
    await runConsensus(config, locker);
  }
  await synthesize(config, locker);
} catch (globalError) {
  failures.push(`Global coordinator error: ${globalError.message}`);
} finally {
  await stopLocker(locker);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
