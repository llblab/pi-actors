#!/usr/bin/env node

/**
 * Actor-neutral client for the local Music Player playback protocol.
 *
 * Reads portable JSON status and sends bounded generation-fenced commands to
 * the playback service endpoint without reading pi-actors Run or Control state.
 */

import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const ACTIONS = new Set([
  "play",
  "resume",
  "pause",
  "toggle",
  "next",
  "previous",
  "seek",
  "volume",
  "stop",
  "status",
]);

function fail(message, code = 1) {
  console.error(`music-player: ${message}`);
  process.exit(code);
}

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function parsePercent(value, label) {
  if (!/^\d+$/.test(String(value))) {
    fail(`${label} percent must be an integer 0..100`, 2);
  }
  const percent = Number(value);
  if (percent < 0 || percent > 100) {
    fail(`${label} percent must be an integer 0..100`, 2);
  }
  return percent;
}

function projectCurrentProgress(status, nowMs = Date.now()) {
  const duration = Number(status.duration_seconds);
  let position = Number(status.position_seconds);
  const updatedAtMs = Number(status.position_updated_at_ms);
  if (!Number.isFinite(position)) position = 0;
  if (status.state === "playing" && Number.isFinite(updatedAtMs)) {
    position += Math.max(0, nowMs - updatedAtMs) / 1000;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ...status, progress_percent: null };
  }
  position = Math.min(Math.max(position, 0), duration);
  return {
    ...status,
    progress_percent: Math.round((position / duration) * 100),
    position_seconds: position,
    position_updated_at_ms: nowMs,
  };
}

async function sendCommand(endpoint, action, input) {
  const payload = `${JSON.stringify({
    action,
    ...(input !== undefined ? { input } : {}),
    service_instance_id: endpoint.service_instance_id,
  })}\n`;
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(endpoint.path);
    let content = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectResponse(new Error("playback service command timed out"));
    }, 5_000);
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      content += chunk;
      if (Buffer.byteLength(content, "utf8") > 4096) {
        socket.destroy(new Error("playback service response is too large"));
      }
    });
    socket.on("error", rejectResponse);
    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        resolveResponse(JSON.parse(content.trim()));
      } catch {
        rejectResponse(new Error("playback service returned invalid JSON"));
      }
    });
  });
  if (!response?.ok) {
    throw new Error(response?.error || "playback service rejected the command");
  }
}

const [action = "status", rawStateDir, ...actionArgs] = process.argv.slice(2);
if (!ACTIONS.has(action) || !rawStateDir) {
  fail("usage: playback-client.mjs <status|play|resume|pause|toggle|next|previous|seek|volume|stop> <state-dir> [action args]", 2);
}
const stateDir = expandPath(rawStateDir);
if (action === "status") {
  const status = readJson(join(stateDir, "player.json"), { state: "unknown" });
  process.stdout.write(`${JSON.stringify(projectCurrentProgress(status))}\n`);
  process.exit(0);
}
const endpointPath = join(stateDir, "playback-endpoint.json");
if (!existsSync(endpointPath)) fail(`playback service is not active: ${stateDir}`, 3);
const endpoint = readJson(endpointPath, {});
if (
  typeof endpoint.path !== "string" ||
  !endpoint.path ||
  typeof endpoint.service_instance_id !== "string" ||
  !endpoint.service_instance_id
) fail(`playback service endpoint is invalid: ${stateDir}`, 3);
let input;
if (action === "seek" || action === "volume") {
  input = { percent: parsePercent(actionArgs[0], action) };
}
try {
  await sendCommand(endpoint, action === "resume" ? "play" : action, input);
  console.log(`music-player: command=${action} handled state_dir=${stateDir}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 3);
}
