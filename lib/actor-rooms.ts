/**
 * Actor room persistence helpers.
 * Zones: room timelines, room rosters, cross-branch discovery state
 * Owns small file-backed room state; routing policy stays in tools/runtime adapters.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import type { ActorMessage } from "./actor-messages.ts";

const STATE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const STATE_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_ROOM_MAX_MESSAGES = 10000;
const DEFAULT_BRANCH_INBOX_TERMINAL_RETAINED = 2000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 250;

export interface RoomMember {
  address: string;
  caps?: unknown;
  claim?: unknown;
  display?: unknown;
  joined_at: string;
  last_seen: string;
  parent?: unknown;
  role?: unknown;
  status?: string;
}

export interface RoomTimelineEntry extends ActorMessage {
  received_at: string;
}

export interface RoomAppendResult {
  room: string;
  message_count: number;
  roster_count: number;
  sent: true;
}

export interface RoomMessagePreview {
  body_preview?: string;
  from?: string;
  summary?: string;
  timestamp: string;
  to: string;
  type: string;
}

export interface RoomStatus {
  room: string;
  message_count: number;
  roster_count: number;
  last_message_at?: string;
  last_message_from?: string;
  last_message_summary?: string;
  last_message_type?: string;
}

export interface RoomContact {
  address: string;
  caps?: unknown;
  claim?: unknown;
  parent?: unknown;
  role?: unknown;
  status?: string;
}

export interface ActorCommunicationSnapshot {
  contacts?: RoomContact[];
  parent?: string;
  root: string;
  self: string;
  rooms: Array<{
    address: string;
    members?: RoomMember[];
    name: string;
  }>;
  updated_at: string;
}

function roomDir(stateDir: string, room: string): string {
  return path.join(stateDir, "rooms", room);
}

function messagesFile(stateDir: string, room: string): string {
  return path.join(roomDir(stateDir, room), "messages.jsonl");
}

function rosterFile(stateDir: string, room: string): string {
  return path.join(roomDir(stateDir, room), "roster.json");
}

function snapshotFile(stateDir: string): string {
  return path.join(stateDir, "communication.json");
}

function branchSnapshotFile(stateDir: string, branch: string): string {
  return path.join(stateDir, "branches", branch, "communication.json");
}

function branchInboxFile(stateDir: string, branch: string): string {
  return path.join(stateDir, "branches", branch, "inbox.jsonl");
}

function branchIdFromAddress(address: string | undefined, run: string): string | undefined {
  if (!address) return undefined;
  const match = new RegExp(`^branch:${run}/(.+)$`).exec(address);
  return match?.[1];
}

function ensureRoomDir(stateDir: string, room: string): void {
  fs.mkdirSync(roomDir(stateDir, room), { recursive: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(parentDir: string, name: string, label: string): () => void {
  fs.mkdirSync(parentDir, { recursive: true });
  const lockDir = path.join(parentDir, name);
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      );
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > STATE_LOCK_MAX_AGE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`${label} lock timed out.`, { cause: error });
      }
      sleepSync(10);
    }
  }
}

function acquireRoomLock(stateDir: string, room: string): () => void {
  return acquireStateLock(roomDir(stateDir, room), ".append.lock", `Room append ${room}`);
}

function acquireBranchInboxLock(stateDir: string, branch: string): () => void {
  return acquireStateLock(path.dirname(branchInboxFile(stateDir, branch)), ".inbox.lock", `Branch inbox ${branch}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runFromRoomAddress(address: string): string | undefined {
  const match = /^room:([^/]+)(?:\/main)?$/.exec(address);
  return match?.[1];
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function roomMaxMessages(): number {
  return positiveEnvInt("PI_ACTORS_ROOM_MAX_MESSAGES", DEFAULT_ROOM_MAX_MESSAGES);
}

function snapshotMinIntervalMs(): number {
  return positiveEnvInt(
    "PI_ACTORS_COMMUNICATION_SNAPSHOT_MIN_MS",
    DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
  );
}

function rosterMinIntervalMs(): number {
  return positiveEnvInt(
    "PI_ACTORS_ROOM_ROSTER_MIN_MS",
    DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
  );
}

function compactRoomMessages(stateDir: string, room: string): void {
  const maxMessages = roomMaxMessages();
  const file = messagesFile(stateDir, room);
  const lines = readJsonlTailLines(file, maxMessages + 1);
  if (lines.length <= maxMessages) return;
  const kept = lines.slice(-maxMessages);
  fs.writeFileSync(file, `${kept.join("\n")}\n`);
  writeJsonFile(path.join(roomDir(stateDir, room), "compaction.json"), {
    compacted_at: new Date().toISOString(),
    max_messages: maxMessages,
  });
}

function readJsonlLineCount(file: string): number {
  const stat = fs.statSync(file);
  if (stat.size === 0) return 0;
  const fd = fs.openSync(file, "r");
  try {
    const chunkSize = 64 * 1024;
    const chunk = Buffer.allocUnsafe(chunkSize);
    let position = 0;
    let count = 0;
    let lastByte: number | undefined;
    while (position < stat.size) {
      const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunkSize, stat.size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] === 10) count += 1;
      }
      lastByte = chunk[bytesRead - 1];
    }
    return lastByte === 10 ? count : count + 1;
  } finally {
    fs.closeSync(fd);
  }
}

function readRoomMessageCount(stateDir: string, room: string): number {
  try {
    return readJsonlLineCount(messagesFile(stateDir, room));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function readJsonlTailLines(file: string, limit: number): string[] {
  const lineLimit = Math.max(1, limit);
  const stat = fs.statSync(file);
  if (stat.size === 0) return [];
  const fd = fs.openSync(file, "r");
  try {
    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    let position = stat.size;
    let newlines = 0;
    while (position > 0 && newlines <= lineLimit) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      fs.readSync(fd, chunk, 0, size, position);
      chunks.unshift(chunk);
      for (let index = size - 1; index >= 0; index -= 1) {
        if (chunk[index] === 10) newlines += 1;
      }
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-lineLimit);
  } finally {
    fs.closeSync(fd);
  }
}

export function readRoomRoster(
  stateDir: string,
  room: string,
): Record<string, RoomMember> {
  return readJsonFile<Record<string, RoomMember>>(rosterFile(stateDir, room), {});
}

function writeRoomRoster(
  stateDir: string,
  room: string,
  roster: Record<string, RoomMember>,
): void {
  ensureRoomDir(stateDir, room);
  writeJsonFile(rosterFile(stateDir, room), roster);
}

function shouldDebounceFile(file: string, minIntervalMs: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < minIntervalMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function shouldDebounceSnapshot(file: string): boolean {
  return shouldDebounceFile(file, snapshotMinIntervalMs());
}

function comparableRosterMember(member: RoomMember | undefined): string {
  if (!member) return "";
  const { last_seen: _lastSeen, ...semantic } = member;
  return JSON.stringify(semantic);
}

function shouldWriteRoomRosterMember(
  stateDir: string,
  room: string,
  before: RoomMember | undefined,
  after: RoomMember,
): boolean {
  if (!before) return true;
  if (comparableRosterMember(before) !== comparableRosterMember(after)) {
    return true;
  }
  return !shouldDebounceFile(rosterFile(stateDir, room), rosterMinIntervalMs());
}

function updateRosterForMessage(
  stateDir: string,
  room: string,
  message: ActorMessage,
  receivedAt: string,
): Record<string, RoomMember> {
  const roster = readRoomRoster(stateDir, room);
  if (!message.from) return roster;
  const body = asRecord(message.body);
  const current = roster[message.from];
  const next = message.type === "actor.leave"
    ? {
        address: message.from,
        joined_at: current?.joined_at ?? receivedAt,
        last_seen: receivedAt,
        ...(current?.caps !== undefined ? { caps: current.caps } : {}),
        ...(current?.claim !== undefined ? { claim: current.claim } : {}),
        ...(current?.display !== undefined ? { display: current.display } : {}),
        ...(current?.parent !== undefined ? { parent: current.parent } : {}),
        ...(current?.role !== undefined ? { role: current.role } : { role: "actor" }),
        status: String(body.status ?? "left"),
      }
    : {
        address: message.from,
        joined_at: current?.joined_at ?? receivedAt,
        last_seen: receivedAt,
        ...(body.caps !== undefined ? { caps: body.caps } : current?.caps !== undefined ? { caps: current.caps } : {}),
        ...(body.claim !== undefined ? { claim: body.claim } : current?.claim !== undefined ? { claim: current.claim } : {}),
        ...(body.display !== undefined ? { display: body.display } : current?.display !== undefined ? { display: current.display } : {}),
        ...(body.parent !== undefined ? { parent: body.parent } : current?.parent !== undefined ? { parent: current.parent } : {}),
        ...(body.role !== undefined ? { role: body.role } : current?.role !== undefined ? { role: current.role } : { role: "actor" }),
        status: String(body.status ?? current?.status ?? "present"),
      };
  roster[message.from] = next;
  if (shouldWriteRoomRosterMember(stateDir, room, current, next)) {
    writeRoomRoster(stateDir, room, roster);
  }
  return roster;
}

export function readBranchInboxMessages(
  stateDir: string,
  run: string,
  address: string,
  limit = 40,
): Array<ActorMessage & { id?: string; queued_at?: string; status?: string }> {
  const branch = branchIdFromAddress(address, run);
  if (!branch) throw new Error(`Expected branch:${run}/<branch>; got ${address}`);
  try {
    return readJsonlTailLines(branchInboxFile(stateDir, branch), limit).map(
      (line) => JSON.parse(line),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function getBranchInboxTerminalRetainLimit(): number {
  const value = Number(process.env.PI_ACTORS_BRANCH_INBOX_TERMINAL_RETAINED ?? "");
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_BRANCH_INBOX_TERMINAL_RETAINED;
}

function compactBranchInboxMessages<T extends { status?: string }>(
  messages: T[],
): T[] {
  const retainTerminal = getBranchInboxTerminalRetainLimit();
  const active = messages.filter(
    (message) => message.status !== "handled" && message.status !== "failed",
  );
  const terminal = messages.filter(
    (message) => message.status === "handled" || message.status === "failed",
  );
  return [...terminal.slice(-retainTerminal), ...active];
}

export function appendBranchInboxMessage(
  stateDir: string,
  run: string,
  address: string,
  message: ActorMessage,
): void {
  const branch = branchIdFromAddress(address, run);
  if (!branch) throw new Error(`Expected branch:${run}/<branch>; got ${address}`);
  const releaseLock = acquireBranchInboxLock(stateDir, branch);
  try {
    fs.writeFileSync(
      branchInboxFile(stateDir, branch),
      `${JSON.stringify({ ...message, id: randomUUID(), queued_at: new Date().toISOString(), status: "queued" })}\n`,
      { flag: "a" },
    );
  } finally {
    releaseLock();
  }
}

export function updateBranchInboxMessageStatus(
  stateDir: string,
  run: string,
  address: string,
  id: string,
  status: "claimed" | "handled" | "failed",
  metadata: Record<string, unknown> = {},
): boolean {
  const branch = branchIdFromAddress(address, run);
  if (!branch) throw new Error(`Expected branch:${run}/<branch>; got ${address}`);
  const releaseLock = acquireBranchInboxLock(stateDir, branch);
  try {
    const file = branchInboxFile(stateDir, branch);
    const messages = readBranchInboxMessages(stateDir, run, address, Number.MAX_SAFE_INTEGER);
    let changed = false;
    const timestampKey = `${status}_at`;
    const updated = messages.map((message) => {
      if (message.id !== id) return message;
      changed = true;
      return { ...message, ...metadata, [timestampKey]: new Date().toISOString(), status };
    });
    if (!changed) return false;
    const compacted = compactBranchInboxMessages(updated);
    fs.writeFileSync(file, `${compacted.map((message) => JSON.stringify(message)).join("\n")}\n`);
    return true;
  } finally {
    releaseLock();
  }
}

export function appendRoomMessage(
  stateDir: string,
  room: string,
  message: ActorMessage,
): RoomAppendResult {
  const releaseLock = acquireRoomLock(stateDir, room);
  try {
    const receivedAt = new Date().toISOString();
    const entry: RoomTimelineEntry = { ...message, received_at: receivedAt };
    fs.appendFileSync(messagesFile(stateDir, room), `${JSON.stringify(entry)}\n`);
    compactRoomMessages(stateDir, room);
    const roster = updateRosterForMessage(stateDir, room, message, receivedAt);
    const run = runFromRoomAddress(message.to);
    if (run) {
      writeCommunicationSnapshot(stateDir, run);
      if (message.from && branchIdFromAddress(message.from, run)) {
        writeBranchCommunicationSnapshotDebounced(stateDir, run, message.from);
      }
    }
    return {
      message_count: readRoomMessageCount(stateDir, room),
      room,
      roster_count: Object.keys(roster).length,
      sent: true,
    };
  } finally {
    releaseLock();
  }
}

export function readRoomMessages(
  stateDir: string,
  room: string,
  limit = 40,
): RoomTimelineEntry[] {
  try {
    const lines = readJsonlTailLines(messagesFile(stateDir, room), limit);
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function previewValue(value: unknown, maxLength = 120): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const compact = text.replaceAll(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
    : compact;
}

export function readRoomMessagePreviews(
  stateDir: string,
  room: string,
  limit = 40,
): RoomMessagePreview[] {
  return readRoomMessages(stateDir, room, limit).map((message) => ({
    ...(previewValue(message.body) ? { body_preview: previewValue(message.body) } : {}),
    ...(message.from ? { from: message.from } : {}),
    ...(message.summary ? { summary: message.summary } : {}),
    timestamp: message.received_at,
    to: message.to,
    type: message.type,
  }));
}

export function getRoomStatus(stateDir: string, room: string): RoomStatus {
  const messageCount = readRoomMessageCount(stateDir, room);
  const [last] = readRoomMessages(stateDir, room, 1);
  return {
    ...(last
      ? {
          last_message_at: last.received_at,
          ...(last.from ? { last_message_from: last.from } : {}),
          ...(last.summary ? { last_message_summary: last.summary } : {}),
          last_message_type: last.type,
        }
      : {}),
    message_count: messageCount,
    room,
    roster_count: Object.keys(readRoomRoster(stateDir, room)).length,
  };
}

export function ensureRoomMember(
  stateDir: string,
  run: string,
  room: string,
  address: string,
  body: Record<string, unknown>,
  summary: string,
): RoomAppendResult {
  const roster = readRoomRoster(stateDir, room);
  if (roster[address]) {
    return {
      message_count: readRoomMessageCount(stateDir, room),
      room,
      roster_count: Object.keys(roster).length,
      sent: true,
    };
  }
  return appendRoomMessage(stateDir, room, {
    body,
    from: address,
    summary,
    to: `room:${run}`,
    type: "actor.join",
  });
}

export function ensureDefaultRoom(stateDir: string, run: string): RoomAppendResult {
  return ensureRoomMember(
    stateDir,
    run,
    "main",
    `run:${run}`,
    { role: "run", status: "present" },
    "Run joined default room",
  );
}

export function readCommunicationSnapshot(
  stateDir: string,
): ActorCommunicationSnapshot | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(snapshotFile(stateDir), "utf8"),
    ) as ActorCommunicationSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readRoomContacts(
  stateDir: string,
  room: string,
  self?: string,
): RoomContact[] {
  return Object.values(readRoomRoster(stateDir, room))
    .filter((member) => member.address !== self)
    .map((member) => ({
      address: member.address,
      ...(member.caps !== undefined ? { caps: member.caps } : {}),
      ...(member.claim !== undefined ? { claim: member.claim } : {}),
      ...(member.parent !== undefined ? { parent: member.parent } : {}),
      ...(member.role !== undefined ? { role: member.role } : {}),
      ...(member.status !== undefined ? { status: member.status } : {}),
    }));
}

function buildCommunicationSnapshot(
  stateDir: string,
  run: string,
  self: string,
): ActorCommunicationSnapshot {
  const mainRoster = Object.values(readRoomRoster(stateDir, "main"));
  const contacts = readRoomContacts(stateDir, "main", self);
  return {
    ...(contacts.length > 0 ? { contacts } : {}),
    ...(self !== `run:${run}` ? { parent: `run:${run}` } : {}),
    root: `run:${run}`,
    self,
    rooms: [
      {
        address: `room:${run}`,
        ...(mainRoster.length > 0 ? { members: mainRoster } : {}),
        name: "main",
      },
    ],
    updated_at: new Date().toISOString(),
  };
}

export function writeCommunicationSnapshot(
  stateDir: string,
  run: string,
): ActorCommunicationSnapshot {
  const snapshot = buildCommunicationSnapshot(stateDir, run, `run:${run}`);
  writeJsonFile(snapshotFile(stateDir), snapshot);
  return snapshot;
}

export function writeBranchCommunicationSnapshot(
  stateDir: string,
  run: string,
  self: string,
): ActorCommunicationSnapshot {
  const branch = branchIdFromAddress(self, run);
  if (!branch) throw new Error(`Expected branch:${run}/<branch>; got ${self}`);
  const snapshot = buildCommunicationSnapshot(stateDir, run, self);
  writeJsonFile(branchSnapshotFile(stateDir, branch), snapshot);
  return snapshot;
}

function writeBranchCommunicationSnapshotDebounced(
  stateDir: string,
  run: string,
  self: string,
): ActorCommunicationSnapshot | undefined {
  const branch = branchIdFromAddress(self, run);
  if (!branch) throw new Error(`Expected branch:${run}/<branch>; got ${self}`);
  if (shouldDebounceSnapshot(branchSnapshotFile(stateDir, branch))) return undefined;
  return writeBranchCommunicationSnapshot(stateDir, run, self);
}
