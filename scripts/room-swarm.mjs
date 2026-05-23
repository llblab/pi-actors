#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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
    ...(role.glyph ? { glyph: String(role.glyph) } : {}),
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

async function waitForPath(path, timeoutMs = 5000) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await sleep(50);
  }
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
  const child = spawn(new URL("./coordinator-locker.mjs", import.meta.url).pathname, [
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
    type: "coord.enqueue",
    body: { id: "room-swarm-artifact", task: "Own final room-swarm artifact synthesis", resources: [config.artifactPath || "artifact"] },
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
    const child = spawn("pi", [
      "--model", model,
      "--thinking", thinking,
      "--tools", "inspect,message",
      "--no-context-files",
      "--no-skills",
      "--no-session",
      "-p",
      prompt,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

async function participant(role, config) {
  const displayName = role.glyph ? `${role.glyph} ${role.name}` : role.name;
  const address = `branch:${config.runId}/${role.name}`;
  const joinPrompt = `You are ${displayName}, ${role.persona}. Mission: ${config.mission}. Call tool message exactly once with to=${shellQuote(config.room)}, from=${shellQuote(address)}, type='actor.join', summary='${displayName} joined', body JSON {"role":${JSON.stringify(role.persona)},"display":${JSON.stringify(displayName)},"glyph":${JSON.stringify(role.glyph ?? "")},"caps":["coordination","synthesis"],"claim":"coordinate on mission"}. Then print one short line.`;
  await runPi(joinPrompt, config.model, config.thinking);
  for (let round = 1; round <= config.rounds; round += 1) {
    const prompt = `You are ${displayName} (${address}), ${role.persona}. Mission: ${config.mission}. Round ${round}/${config.rounds}. First call inspect target=${config.room} view=previews lines=30 and inspect target=${config.room} view=contacts. Then call message once to ${config.room} from ${address} type=chat.message. Body: 2-4 sentences that react to a named participant, propose the next coordination step, and refine the shared artifact. Use contacts for peer names and addresses, but keep this packaged swarm's coordination room-visible; do not send direct branch messages unless a caller-specific worker protocol says recipients consume them. End stdout with summary <=160 chars.`;
    const result = await runPi(prompt, config.model, config.thinking);
    process.stdout.write(`[${role.name} round ${round}] code=${result.code}\n${result.stdout}\n`);
    if (result.stderr.trim()) process.stderr.write(`[${role.name} round ${round}] ${result.stderr}\n`);
    if (round < config.rounds && config.delay > 0) await new Promise((resolve) => setTimeout(resolve, config.delay * 1000));
  }
  const leavePrompt = `Call tool message exactly once with to=${shellQuote(config.room)}, from=${shellQuote(address)}, type='actor.leave', summary='${displayName} left', body='finished coordinated work'. Then print goodbye.`;
  await runPi(leavePrompt, config.model, config.thinking);
}

async function readRoomTranscript(config) {
  const messagesPath = `${agentDir()}/tmp/pi-actors/runs/${config.runId}/rooms/main/messages.jsonl`;
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
  await writeLockerMessage(locker, {
    type: "coord.claim",
    body: { owner: "room-swarm:synthesizer" },
  });
  const transcript = await readRoomTranscript(config);
  const prompt = `Synthesize this room-swarm transcript into a concise Markdown artifact. Mission: ${config.mission}. Include: Title, Consensus, Roles, Protocol, Final Artifact Shape, Next Actions, Open Questions. Use only the transcript evidence below.\n\nTRANSCRIPT:\n${transcript.slice(-24000)}`;
  const result = await runPi(prompt, config.model, config.thinking);
  await writeFile(config.artifactPath, result.stdout.trim() ? result.stdout : "# Room Swarm Artifact\n\nNo synthesis output.\n", "utf8");
  await writeLockerMessage(locker, {
    type: "coord.complete",
    body: { id: "room-swarm-artifact", artifact: config.artifactPath },
  });
  await writeLockerMessage(locker, {
    type: "lock.release",
    body: { resource: config.artifactPath },
  });
  process.stdout.write(`artifact=${config.artifactPath}\n`);
}

const defaultRoles = [
  { name: "mapper", glyph: "🗺️", persona: "systems mapper; tracks shared structure and dependencies" },
  { name: "memory", glyph: "🌿", persona: "memory keeper; preserves decisions and unresolved questions" },
  { name: "risk", glyph: "🧨", persona: "risk scout; challenges weak coordination and missing owners" },
  { name: "flow", glyph: "🌊", persona: "flow designer; turns scattered ideas into process rhythm" },
  { name: "operator", glyph: "🔥", persona: "operator; converts ideas into concrete next actions" },
  { name: "narrative", glyph: "📖", persona: "narrative synthesizer; keeps the artifact coherent" },
  { name: "interface", glyph: "✨", persona: "interface designer; makes outputs visible and usable" },
  { name: "facilitator", glyph: "🤫", persona: "facilitator; asks for consensus and convergence" },
];

const config = {
  runId: arg("run-id", process.env.run_id || process.env.RUN_ID || "room-swarm"),
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
  await Promise.all(config.roles.map(async (role) => {
    try {
      await participant(role, config);
    } catch (error) {
      failures.push(`${role.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  await synthesize(config, locker);
} finally {
  await stopLocker(locker);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
