/**
 * Native launch evidence persistence.
 * Owns: generation-bound intent/birth/settlement records and unresolved-scope mutation fences.
 * Excludes: runtime-local admission/acquisition, complete membership, termination, and restart execution.
 */

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import { assertOwnedRunStateDirectory } from "./runs-ownership.ts";
import { runProcessIdentityDigest, type RunProcessIdentity } from "./runs-process.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export const RUN_NATIVE_LAUNCH_FILE = "native-launches.json";
const SCHEMA = "run-native-launches-v1";

export interface RunNativeLaunchOwner {
  readonly run: string;
  readonly runInstanceId: string;
  readonly ownerId?: string;
  readonly pid: number;
  readonly processIdentityDigest?: string;
}

export interface RunNativeLaunchRequest {
  readonly commandId: string;
  readonly attempt: number;
}

export interface RunNativeLaunchBirth {
  readonly pid: number;
  readonly observed_at: string;
  readonly process_identity: Readonly<RunProcessIdentity>;
}

export interface RunNativeLaunchCloseSettlement {
  readonly basis?: never;
  readonly observed_at: string;
  readonly native_exit_code: number | null;
  readonly native_signal: NodeJS.Signals | null;
}

export interface RunNativeLaunchAbsenceSettlement {
  readonly basis: "verified_absence";
  readonly observed_at: string;
}

export type RunNativeLaunchSettlement = RunNativeLaunchCloseSettlement | RunNativeLaunchAbsenceSettlement;

export interface RunNativeLaunchIntent {
  readonly intent_id: string;
  readonly command_id: string;
  readonly attempt: number;
  readonly admitted_at: string;
  readonly birth?: RunNativeLaunchBirth;
  readonly settlement?: RunNativeLaunchSettlement;
}

export interface RunNativeLaunchLedger {
  readonly schema: typeof SCHEMA;
  readonly run: string;
  readonly run_instance_id: string;
  readonly ownerId?: string;
  readonly runner_pid: number;
  readonly runner_identity_digest: string | null;
  readonly intents: readonly RunNativeLaunchIntent[];
}

export type RunNativeLaunchReading =
  | { state: "absent" | "invalid" }
  | { state: "available"; ledger: RunNativeLaunchLedger };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function intentId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(value)?.[0] === value;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!text(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function validRequest(value: unknown): value is RunNativeLaunchRequest {
  if (!record(value)) return false;
  return typeof value.commandId === "string" &&
    /^command-[0-9]{3,}$/.exec(value.commandId)?.[0] === value.commandId &&
    Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0;
}

function validOwner(owner: RunNativeLaunchOwner): boolean {
  return !!owner && text(owner.run) && text(owner.runInstanceId) &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    (owner.ownerId === undefined || text(owner.ownerId)) &&
    (owner.processIdentityDigest === undefined ||
      (typeof owner.processIdentityDigest === "string" && /^[a-f0-9]{64}$/.exec(owner.processIdentityDigest)?.[0] === owner.processIdentityDigest));
}

function decodeBirth(value: unknown, runnerPid: number): RunNativeLaunchBirth | undefined {
  if (!record(value) || !onlyKeys(value, ["pid", "observed_at", "process_identity"]) ||
    !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || value.pid === runnerPid ||
    !canonicalTimestamp(value.observed_at) || !record(value.process_identity)) return undefined;
  const identity = value.process_identity;
  if (!onlyKeys(identity, ["platform", "start_time", "command", "cwd"]) || !runProcessIdentityDigest(identity) ||
    (identity.cwd !== undefined && !text(identity.cwd))) return undefined;
  return Object.freeze({
    pid: Number(value.pid), observed_at: value.observed_at,
    process_identity: Object.freeze({
      platform: identity.platform as NodeJS.Platform, start_time: String(identity.start_time), command: String(identity.command),
      ...(identity.cwd === undefined ? {} : { cwd: String(identity.cwd) }),
    }),
  });
}

function decodeSettlement(value: unknown): RunNativeLaunchSettlement | undefined {
  if (!record(value) || !canonicalTimestamp(value.observed_at)) return undefined;
  if (value.basis === "verified_absence") {
    return onlyKeys(value, ["basis", "observed_at"])
      ? Object.freeze({ basis: "verified_absence", observed_at: value.observed_at }) : undefined;
  }
  if (!onlyKeys(value, ["observed_at", "native_exit_code", "native_signal"])) return undefined;
  const code = value.native_exit_code;
  const signal = value.native_signal;
  if (!((Number.isSafeInteger(code) && signal === null) ||
    (code === null && typeof signal === "string" && /^SIG[A-Z0-9]+$/.exec(signal)?.[0] === signal))) return undefined;
  return Object.freeze({
    observed_at: value.observed_at, native_exit_code: code as number | null, native_signal: signal as NodeJS.Signals | null,
  });
}

function decode(value: unknown, owner: RunNativeLaunchOwner): RunNativeLaunchLedger | undefined {
  if (!record(value) || !onlyKeys(value, ["schema", "run", "run_instance_id", "ownerId", "runner_pid", "runner_identity_digest", "intents"]) ||
    value.schema !== SCHEMA || value.run !== owner.run ||
    value.run_instance_id !== owner.runInstanceId || value.ownerId !== owner.ownerId ||
    value.runner_pid !== owner.pid || value.runner_identity_digest !== (owner.processIdentityDigest ?? null) ||
    !Array.isArray(value.intents)) return undefined;
  const ids = new Set<string>();
  const attempts = new Map<string, number>();
  const births = new Set<string>();
  const intents: RunNativeLaunchIntent[] = [];
  for (const item of value.intents) {
    if (!record(item) || !onlyKeys(item, ["intent_id", "command_id", "attempt", "admitted_at", "birth", "settlement"]) ||
      !intentId(item.intent_id) || ids.has(item.intent_id) ||
      !validRequest({ commandId: item.command_id, attempt: item.attempt }) || !canonicalTimestamp(item.admitted_at)) return undefined;
    const command = String(item.command_id);
    const attempt = Number(item.attempt);
    if (attempt !== (attempts.get(command) ?? 0) + 1) return undefined;
    const birth = item.birth === undefined ? undefined : decodeBirth(item.birth, owner.pid);
    if (item.birth !== undefined && !birth) return undefined;
    if (birth) {
      const key = JSON.stringify([birth.process_identity.platform, birth.pid, birth.process_identity.start_time]);
      if (births.has(key)) return undefined;
      births.add(key);
    }
    const settlement = item.settlement === undefined ? undefined : decodeSettlement(item.settlement);
    if (item.settlement !== undefined && (!birth || !settlement)) return undefined;
    ids.add(item.intent_id);
    attempts.set(command, attempt);
    intents.push(Object.freeze({ intent_id: item.intent_id, command_id: command, attempt, admitted_at: item.admitted_at,
      ...(birth ? { birth } : {}), ...(settlement ? { settlement } : {}) }));
  }
  return Object.freeze({
    schema: SCHEMA, run: owner.run, run_instance_id: owner.runInstanceId,
    ...(owner.ownerId === undefined ? {} : { ownerId: owner.ownerId }),
    runner_pid: owner.pid, runner_identity_digest: owner.processIdentityDigest ?? null,
    intents: Object.freeze(intents),
  });
}

/** Even every recorded member's settlement is not complete-scope closure or mutation authority. */
export function assertNoRetainedNativeLaunchScope(stateDir: string): void {
  try { lstatSync(join(stateDir, RUN_NATIVE_LAUNCH_FILE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; }
  throw new Error("Run native launch scope is unproven; confirm the complete owned scope before replacing or retiring its state.");
}

/** Absence or an available admission list never proves no child was born or complete scope membership. */
export function readRunNativeLaunchLedger(stateDir: string, owner: RunNativeLaunchOwner): RunNativeLaunchReading {
  if (!validOwner(owner)) return { state: "invalid" };
  let path: string;
  try { path = join(assertOwnedRunStateDirectory(stateDir, owner.run), RUN_NATIVE_LAUNCH_FILE); }
  catch { return { state: "invalid" }; }
  try { if (!lstatSync(path).isFile()) return { state: "invalid" }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid" }; }
  const read = readJsonFileResilient<unknown>(path, undefined);
  if (read.diagnostics.length) return { state: "invalid" };
  const ledger = decode(read.value, owner);
  return ledger ? { state: "available", ledger } : { state: "invalid" };
}

/** Storage only: caller must hold lifecycle admission and supply a kernel-acquired birth, never replayed runtime authority. */
export function recordRunNativeLaunchBirthUnderLock(
  stateDir: string,
  owner: RunNativeLaunchOwner,
  intent: Readonly<RunNativeLaunchIntent>,
  birth: RunNativeLaunchBirth,
): Readonly<RunNativeLaunchBirth> {
  if (!validOwner(owner)) throw new Error("Run native launch identity or request is invalid.");
  const canonical = assertOwnedRunStateDirectory(stateDir, owner.run);
  const current = readRunNativeLaunchLedger(canonical, owner);
  if (current.state !== "available") throw new Error("Run native launch evidence is unavailable or invalid.");
  const index = current.ledger.intents.findIndex((item) => item.intent_id === intent.intent_id);
  const prior = current.ledger.intents[index];
  if (!prior || prior.birth || prior.command_id !== intent.command_id || prior.attempt !== intent.attempt ||
    prior.admitted_at !== intent.admitted_at) throw new Error("Run native launch birth binding changed or is already retained.");
  const updated = decode({ ...current.ledger, intents: current.ledger.intents.map((item, i) => i === index ? { ...item, birth } : item) }, owner);
  if (!updated) throw new Error("Run native launch birth evidence is unavailable or invalid.");
  writeJsonAtomic(join(canonical, RUN_NATIVE_LAUNCH_FILE), updated);
  return updated.intents[index]!.birth!;
}

/** Storage only: exact retained birth plus admitted native-close or verified-absence evidence, never work authority. */
export function recordRunNativeLaunchSettlementUnderLock<T extends RunNativeLaunchSettlement>(
  stateDir: string,
  owner: RunNativeLaunchOwner,
  update: { intent: Readonly<RunNativeLaunchIntent>; birth: RunNativeLaunchBirth; settlement: T },
): Readonly<T> {
  if (!validOwner(owner)) throw new Error("Run native launch identity or request is invalid.");
  const canonical = assertOwnedRunStateDirectory(stateDir, owner.run);
  const current = readRunNativeLaunchLedger(canonical, owner);
  if (current.state !== "available") throw new Error("Run native launch evidence is unavailable or invalid.");
  const { intent, birth, settlement } = update;
  const index = current.ledger.intents.findIndex((item) => item.intent_id === intent.intent_id);
  const prior = current.ledger.intents[index];
  if (!prior?.birth || prior.settlement || prior.command_id !== intent.command_id || prior.attempt !== intent.attempt ||
    prior.admitted_at !== intent.admitted_at || prior.birth.pid !== birth.pid || prior.birth.observed_at !== birth.observed_at ||
    runProcessIdentityDigest(prior.birth.process_identity) !== runProcessIdentityDigest(birth.process_identity)) {
    throw new Error("Run native launch settlement binding changed or is already retained.");
  }
  const updated = decode({ ...current.ledger, intents: current.ledger.intents.map((item, i) => i === index ? { ...item, settlement } : item) }, owner);
  if (!updated) throw new Error("Run native launch settlement evidence is unavailable or invalid.");
  writeJsonAtomic(join(canonical, RUN_NATIVE_LAUNCH_FILE), updated);
  return updated.intents[index]!.settlement! as Readonly<T>;
}

/** Kernel storage only: caller must hold lifecycle/work admission. No reset or rollback of existing intents. */
export function recordRunNativeLaunchIntentUnderLock(
  stateDir: string,
  owner: RunNativeLaunchOwner,
  request: RunNativeLaunchRequest,
): Readonly<RunNativeLaunchIntent> {
  if (!validOwner(owner) || !validRequest(request)) throw new Error("Run native launch identity or request is invalid.");
  const canonical = assertOwnedRunStateDirectory(stateDir, owner.run);
  const current = readRunNativeLaunchLedger(canonical, owner);
  if (current.state === "invalid") throw new Error("Run native launch evidence is unavailable or invalid.");
  const prior = current.state === "available" ? current.ledger.intents : [];
  const last = prior.filter((item) => item.command_id === request.commandId).at(-1)?.attempt ?? 0;
  if (request.attempt !== last + 1) throw new Error("Run native launch attempt is duplicate or out of order.");
  const intent = Object.freeze({ intent_id: randomUUID(), command_id: request.commandId, attempt: request.attempt, admitted_at: new Date().toISOString() });
  writeJsonAtomic(join(canonical, RUN_NATIVE_LAUNCH_FILE), {
    schema: SCHEMA, run: owner.run, run_instance_id: owner.runInstanceId,
    ...(owner.ownerId === undefined ? {} : { ownerId: owner.ownerId }),
    runner_pid: owner.pid, runner_identity_digest: owner.processIdentityDigest ?? null,
    intents: [...prior, intent],
  });
  return intent;
}
