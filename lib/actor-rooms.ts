/**
 * Actor room persistence helpers.
 * Zones: room timelines, room rosters, cross-branch discovery state
 * Owns small file-backed room state; routing policy stays in tools/runtime adapters.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ActorMessage } from "./actor-messages.ts";

export interface RoomMember {
  address: string;
  caps?: unknown;
  claim?: unknown;
  display?: unknown;
  glyph?: unknown;
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

function branchIdFromAddress(address: string | undefined, run: string): string | undefined {
  if (!address) return undefined;
  const match = new RegExp(`^branch:${run}/(.+)$`).exec(address);
  return match?.[1];
}

function ensureRoomDir(stateDir: string, room: string): void {
  fs.mkdirSync(roomDir(stateDir, room), { recursive: true });
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

function updateRosterForMessage(
  stateDir: string,
  room: string,
  message: ActorMessage,
  receivedAt: string,
): Record<string, RoomMember> {
  const roster = readRoomRoster(stateDir, room);
  if (!message.from) return roster;
  if (message.type === "actor.leave") {
    delete roster[message.from];
    writeRoomRoster(stateDir, room, roster);
    return roster;
  }
  const body = asRecord(message.body);
  const current = roster[message.from];
  roster[message.from] = {
    address: message.from,
    joined_at: current?.joined_at ?? receivedAt,
    last_seen: receivedAt,
    ...(body.caps !== undefined ? { caps: body.caps } : current?.caps !== undefined ? { caps: current.caps } : {}),
    ...(body.claim !== undefined ? { claim: body.claim } : current?.claim !== undefined ? { claim: current.claim } : {}),
    ...(body.display !== undefined ? { display: body.display } : current?.display !== undefined ? { display: current.display } : {}),
    ...(body.glyph !== undefined ? { glyph: body.glyph } : current?.glyph !== undefined ? { glyph: current.glyph } : {}),
    ...(body.parent !== undefined ? { parent: body.parent } : current?.parent !== undefined ? { parent: current.parent } : {}),
    ...(body.role !== undefined ? { role: body.role } : current?.role !== undefined ? { role: current.role } : { role: "actor" }),
    status: String(body.status ?? current?.status ?? "present"),
  };
  writeRoomRoster(stateDir, room, roster);
  return roster;
}

export function appendRoomMessage(
  stateDir: string,
  room: string,
  message: ActorMessage,
): RoomAppendResult {
  ensureRoomDir(stateDir, room);
  const receivedAt = new Date().toISOString();
  const entry: RoomTimelineEntry = { ...message, received_at: receivedAt };
  fs.appendFileSync(messagesFile(stateDir, room), `${JSON.stringify(entry)}\n`);
  const roster = updateRosterForMessage(stateDir, room, message, receivedAt);
  const run = runFromRoomAddress(message.to);
  if (run) {
    writeCommunicationSnapshot(stateDir, run);
    if (message.from && branchIdFromAddress(message.from, run)) {
      writeBranchCommunicationSnapshot(stateDir, run, message.from);
    }
  }
  return {
    message_count: readRoomMessages(stateDir, room).length,
    room,
    roster_count: Object.keys(roster).length,
    sent: true,
  };
}

export function readRoomMessages(
  stateDir: string,
  room: string,
  limit = 40,
): RoomTimelineEntry[] {
  try {
    const lines = fs
      .readFileSync(messagesFile(stateDir, room), "utf8")
      .split("\n")
      .filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => JSON.parse(line));
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
  const messages = readRoomMessages(stateDir, room, Number.MAX_SAFE_INTEGER);
  const last = messages[messages.length - 1];
  return {
    ...(last
      ? {
          last_message_at: last.received_at,
          ...(last.from ? { last_message_from: last.from } : {}),
          ...(last.summary ? { last_message_summary: last.summary } : {}),
          last_message_type: last.type,
        }
      : {}),
    message_count: messages.length,
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
      message_count: readRoomMessages(stateDir, room).length,
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
