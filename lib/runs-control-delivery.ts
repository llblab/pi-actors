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

import * as Control from "./control.ts";
import * as Limits from "./limits.ts";
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

const PREFLIGHT_CONTROL_ID = "00000000-0000-4000-8000-000000000000";

export function encodeRunControlWire(wire: {
  action: string;
  id: string;
  input?: unknown;
}): { bytes: number; payload: string } {
  const payload = `${JSON.stringify({
    id: wire.id,
    action: wire.action,
    ...(wire.input !== undefined ? { input: wire.input } : {}),
  })}\n`;
  const bytes = Buffer.byteLength(payload);
  if (bytes > Limits.CONTROL_WIRE_MAX_BYTES) {
    throw new Error(
      `Run Control wire record exceeds the ${Limits.CONTROL_WIRE_MAX_BYTES}-byte portable bound`,
    );
  }
  return { bytes, payload };
}

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
  let writeFailed = false, writeFailure: unknown;
  try {
    fd = openSync(endpoint.path, constants.O_WRONLY | constants.O_NONBLOCK);
    return writeSync(fd, payload);
  } catch (error) {
    writeFailed = true; writeFailure = error;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch (error) {
        if (writeFailed) throw new AggregateError([writeFailure, error], "Run Control FIFO write and close failed", { cause: writeFailure });
        throw error;
      }
    }
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

function aggregateControlFailure(failure: Error, causes: readonly unknown[], recording: unknown): AggregateError {
  return Object.assign(new AggregateError([...causes, recording], failure.message, { cause: causes[0] }), failure);
}

export async function deliverRunControl(
  run: string,
  stateDir: string,
  request: DeliverRunControlRequest,
  options: DeliverRunControlOptions = {},
): Promise<Record<string, unknown>> {
  const action = Control.normalizeControlAction(request.action);
  const input = request.input === undefined
    ? undefined
    : Control.normalizeControlInput(request.input);
  const normalizedRequest = {
    action,
    ...(input !== undefined ? { input } : {}),
    run_instance_id: request.run_instance_id,
  };
  encodeRunControlWire({
    id: PREFLIGHT_CONTROL_ID,
    action,
    ...(input !== undefined ? { input } : {}),
  });
  const control = appendRunControlInStateDir(stateDir, normalizedRequest);
  const endpoint = readRunControlEndpoint(stateDir, request.run_instance_id);
  if (!endpoint) {
    const failure = Object.assign(new Error("Run Control endpoint is not ready."), {
      action,
      control_id: control.id,
      reason: "endpoint_not_ready",
      run,
      run_instance_id: request.run_instance_id,
    });
    try {
      updateRunControlStatusInStateDir(stateDir, control.id, "failed",
        { error: "control endpoint is not ready for this Run generation" }, ["queued", "delivered"]);
    } catch (recordingError) {
      throw aggregateControlFailure(failure, [failure], recordingError);
    }
    throw failure;
  }
  try {
    const { bytes, payload } = encodeRunControlWire({
      id: control.id,
      action,
      ...(input !== undefined ? { input } : {}),
    });
    let written: number;
    if (endpoint.type === "fifo") {
      if ((options.platform ?? process.platform) === "win32") {
        throw new Error("FIFO Control delivery is unsupported on native Windows");
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
      action,
      bytes,
      control_id: control.id,
      delivery: "delivered",
      endpoint_type: endpoint.type,
      run,
      run_instance_id: request.run_instance_id,
    };
  } catch (error) {
    let reason: string;
    const causes: unknown[] = [error];
    try { reason = String(error instanceof Error ? error.message : error); }
    catch (formattingError) { reason = "failure text unavailable"; causes.push(formattingError); }
    const message = `Run Control delivery failed: ${reason}`;
    const failure = Object.assign(causes.length === 1 ? new Error(message, { cause: error })
      : new AggregateError(causes, message, { cause: error }), {
      action,
      control_id: control.id,
      endpoint_type: endpoint.type,
      reason: "delivery_failed",
      run,
      run_instance_id: request.run_instance_id,
    });
    try {
      updateRunControlStatusInStateDir(stateDir, control.id, "failed", { error: reason }, ["queued", "delivered"]);
    } catch (recordingError) {
      throw aggregateControlFailure(failure, causes, recordingError);
    }
    throw failure;
  }
}
