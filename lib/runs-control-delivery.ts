/**
 * Run Control delivery.
 * Zones: generation-fenced endpoint resolution, FIFO/named-pipe writes, durable outcomes
 * Owns delivery of persisted actor-local Controls to ready service endpoints.
 */

import {
  closeSync,
  constants,
  existsSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import {
  appendRunControlInStateDir,
  updateRunControlStatusInStateDir,
} from "./runs-controls.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export interface RunControlEndpoint {
  path: string;
  type: "fifo" | "named-pipe";
}

export interface DeliverRunControlOptions {
  namedPipeSend?: (path: string, payload: string) => Promise<number>;
  platform?: NodeJS.Platform;
}

export interface DeliverRunControlRequest {
  action: string;
  input?: unknown;
  run_instance_id: string;
}

export const FIFO_ATOMIC_CONTROL_MAX_BYTES = 512;

export function readRunControlEndpoint(
  stateDir: string,
  runInstanceId: string,
): RunControlEndpoint | undefined {
  const endpoint = readJsonFileResilient<Record<string, unknown>>(
    join(stateDir, "control-endpoint.json"),
    {},
  ).value;
  if (endpoint.run_instance_id !== runInstanceId) return undefined;
  if (
    (endpoint.type === "fifo" || endpoint.type === "named-pipe") &&
    typeof endpoint.path === "string" &&
    endpoint.path.trim()
  ) {
    return { path: endpoint.path, type: endpoint.type };
  }
  return undefined;
}

function sendToFifo(endpoint: RunControlEndpoint, payload: string): number {
  if (!existsSync(endpoint.path))
    throw new Error(`Run Control FIFO not found: ${endpoint.path}`);
  const stat = statSync(endpoint.path);
  if ((stat.mode & constants.S_IFMT) !== constants.S_IFIFO) {
    throw new Error(`Run Control endpoint is not a FIFO: ${endpoint.path}`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(endpoint.path, constants.O_WRONLY | constants.O_NONBLOCK);
    return writeSync(fd, payload);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sendToNamedPipe(
  endpoint: RunControlEndpoint,
  payload: string,
  send?: (path: string, payload: string) => Promise<number>,
): Promise<number> {
  if (send) return send(endpoint.path, payload);
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.path);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("named pipe connection timed out"));
    }, 5000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(Buffer.byteLength(payload));
    };
    socket.on("error", finish);
    socket.on("connect", () => socket.end(payload, () => finish()));
  });
}

export async function deliverRunControl(
  run: string,
  stateDir: string,
  request: DeliverRunControlRequest,
  options: DeliverRunControlOptions = {},
): Promise<Record<string, unknown>> {
  const control = appendRunControlInStateDir(stateDir, request);
  const endpoint = readRunControlEndpoint(stateDir, request.run_instance_id);
  if (!endpoint) {
    updateRunControlStatusInStateDir(
      stateDir,
      control.id,
      "failed",
      { error: "control endpoint is not ready for this Run generation" },
      ["queued", "delivered"],
    );
    throw Object.assign(new Error("Run Control endpoint is not ready."), {
      action: request.action,
      control_id: control.id,
      reason: "endpoint_not_ready",
      run,
      run_instance_id: request.run_instance_id,
    });
  }
  const wire = {
    id: control.id,
    action: request.action,
    ...(request.input !== undefined ? { input: request.input } : {}),
  };
  const payload = `${JSON.stringify(wire)}\n`;
  const bytes = Buffer.byteLength(payload);
  try {
    let written: number;
    if (endpoint.type === "fifo") {
      if ((options.platform ?? process.platform) === "win32") {
        throw new Error("FIFO Control delivery is unsupported on native Windows");
      }
      if (bytes > FIFO_ATOMIC_CONTROL_MAX_BYTES) {
        throw new Error(
          `FIFO Control payload exceeds the ${FIFO_ATOMIC_CONTROL_MAX_BYTES}-byte portable atomic-write bound`,
        );
      }
      written = sendToFifo(endpoint, payload);
    } else {
      written = await sendToNamedPipe(endpoint, payload, options.namedPipeSend);
    }
    if (written !== bytes) {
      throw new Error(`Run Control endpoint wrote ${written} of ${bytes} bytes`);
    }
    updateRunControlStatusInStateDir(stateDir, control.id, "delivered");
    return {
      action: request.action,
      bytes,
      control_id: control.id,
      delivery: "delivered",
      endpoint_type: endpoint.type,
      run,
      run_instance_id: request.run_instance_id,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateRunControlStatusInStateDir(
      stateDir,
      control.id,
      "failed",
      { error: reason },
      ["queued", "delivered"],
    );
    throw Object.assign(new Error(`Run Control delivery failed: ${reason}`), {
      action: request.action,
      control_id: control.id,
      endpoint_type: endpoint.type,
      reason: "delivery_failed",
      run,
      run_instance_id: request.run_instance_id,
    });
  }
}
