/**
 * Runtime wake notifications for actor state.
 * Zones: advisory wake layer, file-backed runtime state, cross-platform notification boundary
 * Owns best-effort live wake signals while durable mailbox/state files remain canonical.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { readJsonlFileResilient } from "./state-readers.ts";

export interface RuntimeWakeEvent {
  actor: string;
  id: string;
  metadata?: Record<string, unknown>;
  reason: string;
  state_dir: string;
  ts: string;
}

export interface RuntimeNotifierSubscription {
  close(): void;
}

export type RuntimeReconcileReason = "initial" | "poll" | "wake";

export interface RuntimeReconcileEvent {
  actor: string;
  reason: RuntimeReconcileReason;
  state_dir: string;
  ts: string;
}

export interface RuntimeNotifierSubscribeOptions {
  onReconcile?: (event: RuntimeReconcileEvent) => void;
}

export interface FileRuntimeNotifierOptions {
  pollIntervalMs?: number;
  replay?: boolean;
  watch?: boolean;
}

export interface RuntimeNotifier {
  notify(event: { actor: string; metadata?: Record<string, unknown>; reason: string }): RuntimeWakeEvent;
  subscribe(
    actor: string,
    onWake: (event: RuntimeWakeEvent) => void,
    options?: RuntimeNotifierSubscribeOptions,
  ): RuntimeNotifierSubscription;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

export function runtimeWakeFile(stateDir: string): string {
  return join(stateDir, "wake.jsonl");
}

function normalizeWakeEvent(
  stateDir: string,
  event: { actor: string; metadata?: Record<string, unknown>; reason: string },
): RuntimeWakeEvent {
  const actor = event.actor.trim();
  const reason = event.reason.trim();
  if (!actor) throw new Error("Runtime wake event requires actor.");
  if (!reason) throw new Error("Runtime wake event requires reason.");
  return {
    actor,
    id: randomUUID(),
    ...(event.metadata ? { metadata: event.metadata } : {}),
    reason,
    state_dir: stateDir,
    ts: new Date().toISOString(),
  };
}

export function notifyRuntimeWake(
  stateDir: string,
  event: { actor: string; metadata?: Record<string, unknown>; reason: string },
): RuntimeWakeEvent {
  const normalized = normalizeWakeEvent(stateDir, event);
  const file = runtimeWakeFile(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export function parseRuntimeWakeEventLine(
  line: string,
): RuntimeWakeEvent | undefined {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof record.actor !== "string" ||
      typeof record.id !== "string" ||
      typeof record.reason !== "string" ||
      typeof record.state_dir !== "string" ||
      typeof record.ts !== "string"
    ) {
      return undefined;
    }
    return {
      actor: record.actor,
      id: record.id,
      ...(record.metadata &&
      typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
        ? { metadata: record.metadata as Record<string, unknown> }
        : {}),
      reason: record.reason,
      state_dir: record.state_dir,
      ts: record.ts,
    };
  } catch {
    return undefined;
  }
}

export function readRuntimeWakeEvents(stateDir: string): RuntimeWakeEvent[] {
  return readJsonlFileResilient<Record<string, unknown>>(runtimeWakeFile(stateDir))
    .records.map((record) => parseRuntimeWakeEventLine(JSON.stringify(record)))
    .filter((event): event is RuntimeWakeEvent => Boolean(event));
}

export function createFileRuntimeNotifier(
  stateDir: string,
  options: FileRuntimeNotifierOptions = {},
): RuntimeNotifier {
  const file = runtimeWakeFile(stateDir);
  const pollIntervalMs = Math.max(
    25,
    Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  );

  return {
    notify: (event) => notifyRuntimeWake(stateDir, event),
    subscribe: (actor, onWake, subscribeOptions = {}) => {
      mkdirSync(dirname(file), { recursive: true });
      let position =
        options.replay || !existsSync(file) ? 0 : statSync(file).size;
      let closed = false;
      const reconcile = (reason: RuntimeReconcileReason): void => {
        if (closed) return;
        subscribeOptions.onReconcile?.({
          actor,
          reason,
          state_dir: stateDir,
          ts: new Date().toISOString(),
        });
      };
      const drain = (): void => {
        if (closed || !existsSync(file)) return;
        const buffer = readFileSync(file);
        if (position > buffer.length) position = 0;
        const chunk = buffer.subarray(position).toString("utf8");
        position = buffer.length;
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          const event = parseRuntimeWakeEventLine(line);
          if (event && event.actor === actor) {
            onWake(event);
            reconcile("wake");
          }
        }
      };

      let watcher: FSWatcher | undefined;
      if (options.watch !== false) {
        try {
          watcher = watch(
            dirname(file),
            { persistent: false },
            (_eventType, changedFile) => {
              if (!changedFile || String(changedFile) === basename(file)) drain();
            },
          );
        } catch {
          // fs.watch availability varies by platform/filesystem; polling below is the fallback.
        }
      }
      reconcile("initial");
      const timer = setInterval(() => {
        drain();
        reconcile("poll");
      }, pollIntervalMs);
      timer.unref?.();
      return {
        close: () => {
          closed = true;
          clearInterval(timer);
          watcher?.close();
        },
      };
    },
  };
}
