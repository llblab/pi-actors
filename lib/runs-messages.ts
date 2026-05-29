/**
 * Async run message delivery.
 * Owns run control endpoint resolution, inbox enqueueing, wake notification,
 * transport writes, and delivery receipts.
 */

import {
  closeSync,
  constants,
  existsSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { markTerminalHandled } from "./runs-control.ts";
import {
  appendRunInboxMessageInStateDir,
  updateRunInboxMessageStatusInStateDir,
} from "./runs-mailbox.ts";
import { notifyRuntimeWake } from "./runtime-notifier.ts";

export interface RunControlEndpoint {
  path: string;
  type: "fifo" | "mailbox" | "named-pipe";
}

export interface SendRunMessageOptions {
  namedPipeSend?: (path: string, payload: string) => Promise<number>;
  platform?: NodeJS.Platform;
}

export function getRunControlEndpoint(
  status: Record<string, unknown>,
  stateDir: string,
): RunControlEndpoint {
  const control = status.control;
  if (control && typeof control === "object" && !Array.isArray(control)) {
    const record = control as Record<string, unknown>;
    if (
      (record.type === "fifo" ||
        record.type === "mailbox" ||
        record.type === "named-pipe") &&
      typeof record.path === "string" &&
      record.path.trim()
    ) {
      return { path: record.path, type: record.type };
    }
  }
  return { path: join(stateDir, "control.fifo"), type: "fifo" };
}

function appendRunInboxMessage(stateDir: string, message: string): string {
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(message) as unknown;
    record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { body: parsed, type: "run.message" };
  } catch {
    record = { body: message, type: "run.message" };
  }
  return appendRunInboxMessageInStateDir(stateDir, record);
}

function writeRunMessageReceipt(
  stateDir: string,
  message: string,
  bytes: number,
  inboxId: string,
): void {
  const trimmedMessage = message.trim().toLowerCase();
  const terminalMessage = ["stop", "cancel", "quit", "exit"].includes(
    trimmedMessage,
  );
  const ts = new Date().toISOString();
  writeFileSync(
    join(stateDir, "events.jsonl"),
    `${JSON.stringify({ bytes, event: "run.message", inbox_id: inboxId, terminal: terminalMessage || undefined, ts })}\n`,
    { flag: "a" },
  );
  updateRunInboxMessageStatusInStateDir(stateDir, inboxId, "sent", { bytes });
  if (terminalMessage) {
    markTerminalHandled(stateDir, {
      event: "run.message",
      message: trimmedMessage,
    });
  }
}

function sendRunMessageToFifo(
  endpoint: RunControlEndpoint,
  payload: string,
): number {
  if (!existsSync(endpoint.path))
    throw new Error(`Run control FIFO not found: ${endpoint.path}`);
  const stat = statSync(endpoint.path);
  if ((stat.mode & constants.S_IFMT) !== constants.S_IFIFO) {
    throw new Error(`Run control endpoint is not a FIFO: ${endpoint.path}`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(endpoint.path, constants.O_WRONLY | constants.O_NONBLOCK);
    return writeSync(fd, payload);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function notifyRunMessageWake(
  stateDir: string,
  run: string,
  bytes: number,
  endpoint: RunControlEndpoint,
  inboxId: string,
): Record<string, unknown> | undefined {
  try {
    const event = notifyRuntimeWake(stateDir, {
      actor: `run:${run}`,
      metadata: { bytes, control_type: endpoint.type, inbox_id: inboxId },
      reason: "run.message",
    });
    return { wake: "wake.jsonl", wake_id: event.id };
  } catch {
    return undefined;
  }
}

function sendRunMessageToNamedPipe(
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
    socket.on("connect", () => {
      socket.end(payload, () => finish());
    });
  });
}

export async function deliverRunMessage(
  status: Record<string, unknown>,
  run: string,
  stateDir: string,
  message: string,
  options: SendRunMessageOptions = {},
): Promise<Record<string, unknown>> {
  const endpoint = getRunControlEndpoint(status, stateDir);
  const payload = message.endsWith("\n") ? message : `${message}\n`;
  const payloadBytes = Buffer.byteLength(payload);
  const inboxId = appendRunInboxMessage(stateDir, message);
  const wake = notifyRunMessageWake(
    stateDir,
    run,
    payloadBytes,
    endpoint,
    inboxId,
  );
  const runtimePlatform = options.platform ?? process.platform;
  if (endpoint.type === "mailbox") {
    return {
      ...(wake ?? {}),
      bytes: payloadBytes,
      control: "inbox.jsonl",
      control_path: endpoint.path,
      control_type: endpoint.type,
      inbox_id: inboxId,
      queued: true,
      run,
      sent: true,
      state_dir: stateDir,
    };
  }
  try {
    if (endpoint.type === "fifo") {
      if (runtimePlatform === "win32") {
        throw new Error(
          "run actor messages on native Windows require a named-pipe control endpoint; this recipe still exposes Unix FIFO control.",
        );
      }
      const bytes = sendRunMessageToFifo(endpoint, payload);
      writeRunMessageReceipt(stateDir, message, bytes, inboxId);
      return {
        ...(wake ?? {}),
        bytes,
        control: "control.fifo",
        control_path: endpoint.path,
        control_type: endpoint.type,
        inbox_id: inboxId,
        run,
        sent: true,
        state_dir: stateDir,
      };
    }
    const bytes = await sendRunMessageToNamedPipe(
      endpoint,
      payload,
      options.namedPipeSend,
    );
    writeRunMessageReceipt(stateDir, message, bytes, inboxId);
    return {
      ...(wake ?? {}),
      bytes,
      control: endpoint.path,
      control_path: endpoint.path,
      control_type: endpoint.type,
      inbox_id: inboxId,
      run,
      sent: true,
      state_dir: stateDir,
    };
  } catch (error) {
    const deliveryError =
      error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        `Run control endpoint is not ready: ${endpoint.path}: ${deliveryError}`,
      ),
      {
        control_path: endpoint.path,
        control_type: endpoint.type,
        delivery_error: deliveryError,
        inbox_id: inboxId,
        queued: true,
        run,
        sent: false,
        state_dir: stateDir,
      },
    );
  }
}
