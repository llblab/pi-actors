/**
 * Descendant Run launch-intent evidence.
 * Owns: declared/prepared parent-child generation facts, strict persistence, and unresolved-scope mutation fences.
 * Excludes: authenticating child birth/membership, work/control authority, exhaustive scope, and termination.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import { assertOwnedRunStateDirectory } from "./runs-ownership.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export const RUN_DESCENDANT_LAUNCH_FILE = "descendant-launches.json";
export const RUN_DESCENDANT_PREPARATION_FILE = "descendant-preparation.json";
export const RUN_DESCENDANT_PREPARED_META_FILE = "prepared-run.json";
const SCHEMA = "run-descendant-launches-v1";
const PREPARATION_SCHEMA = "run-descendant-preparation-v1";

export interface RunDescendantLaunchOwner {
  readonly run: string;
  readonly runInstanceId: string;
  readonly ownerId?: string;
  readonly pid: number;
  readonly processIdentityDigest?: string;
}

export interface RunDescendantLaunchRequest {
  readonly run: string;
  readonly runInstanceId: string;
  readonly ownerId?: string;
  readonly stateDir: string;
}

export interface RunDescendantLaunchTarget {
  readonly run: string;
  readonly run_instance_id: string;
  readonly ownerId?: string;
  readonly state_dir: string;
}

export interface RunDescendantPreparedFact {
  readonly preparation_id: string;
  readonly prepared_at: string;
}

/** Persisted reference to the original producer, never a reconstructed runtime capability or native membership proof. */
export interface RunDescendantProducerBinding {
  readonly pid: number;
  readonly process_identity_digest: string | null;
}

export interface RunDescendantPreparation extends RunDescendantPreparedFact {
  readonly schema: typeof PREPARATION_SCHEMA;
  readonly parent: Readonly<RunDescendantLaunchTarget>;
  readonly child: Readonly<RunDescendantLaunchTarget>;
  // Absent only in retained unbound metadata; new prepared facts require the original binding.
  readonly parent_producer?: Readonly<RunDescendantProducerBinding>;
}

export interface RunDescendantLaunchIntent {
  readonly intent_id: string;
  readonly admitted_at: string;
  readonly child: Readonly<RunDescendantLaunchTarget>;
  readonly preparation?: Readonly<RunDescendantPreparedFact>;
}

export interface RunDescendantLaunchLedger {
  readonly schema: typeof SCHEMA;
  readonly run: string;
  readonly run_instance_id: string;
  readonly ownerId?: string;
  readonly runner_pid: number;
  readonly runner_identity_digest: string | null;
  readonly intents: readonly Readonly<RunDescendantLaunchIntent>[];
}

export type RunDescendantLaunchReading =
  | { state: "absent" | "invalid" }
  | { state: "available"; ledger: Readonly<RunDescendantLaunchLedger> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function required(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalText(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || (Object.hasOwn(value, key) && (value[key] === undefined || text(value[key])));
}

function validOwner(value: unknown): value is RunDescendantLaunchOwner {
  if (!record(value) || !required(value, ["run", "runInstanceId", "pid"]) ||
    !text(value.run) || !text(value.runInstanceId) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
    !optionalText(value, "ownerId")) return false;
  return !("processIdentityDigest" in value) || (Object.hasOwn(value, "processIdentityDigest") &&
    (value.processIdentityDigest === undefined || (typeof value.processIdentityDigest === "string" &&
      /^[a-f0-9]{64}$/.exec(value.processIdentityDigest)?.[0] === value.processIdentityDigest)));
}

function intentId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(value)?.[0] === value;
}

function timestamp(value: unknown): value is string {
  if (!text(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function decodeReference(value: unknown): Readonly<RunDescendantLaunchTarget> | undefined {
  if (!record(value) || !onlyKeys(value, ["run", "run_instance_id", "ownerId", "state_dir"]) ||
    !required(value, ["run", "run_instance_id", "state_dir"]) || typeof value.run !== "string" ||
    /^[A-Za-z0-9_.-]+$/.exec(value.run)?.[0] !== value.run || !text(value.run_instance_id) ||
    !optionalText(value, "ownerId") || !text(value.state_dir) || !isAbsolute(value.state_dir) ||
    resolve(value.state_dir) !== value.state_dir) return undefined;
  // A normalized declaration is not filesystem identity, existence, or child ownership proof.
  return Object.freeze({ run: value.run, run_instance_id: value.run_instance_id,
    ...(value.ownerId === undefined ? {} : { ownerId: String(value.ownerId) }), state_dir: value.state_dir });
}

function decodeTarget(value: unknown, owner: RunDescendantLaunchOwner, stateDir: string): Readonly<RunDescendantLaunchTarget> | undefined {
  const target = decodeReference(value);
  return target && target.run_instance_id !== owner.runInstanceId && target.state_dir !== stateDir ? target : undefined;
}

function decodePreparedFact(value: unknown): Readonly<RunDescendantPreparedFact> | undefined {
  if (!record(value) || !onlyKeys(value, ["preparation_id", "prepared_at"]) ||
    !intentId(value.preparation_id) || !timestamp(value.prepared_at)) return undefined;
  return Object.freeze({ preparation_id: value.preparation_id, prepared_at: value.prepared_at });
}

function decodeProducerBinding(value: unknown): Readonly<RunDescendantProducerBinding> | undefined {
  if (!record(value) || !onlyKeys(value, ["pid", "process_identity_digest"]) ||
    !required(value, ["pid", "process_identity_digest"]) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
    (value.process_identity_digest !== null && (typeof value.process_identity_digest !== "string" ||
      /^[a-f0-9]{64}$/.exec(value.process_identity_digest)?.[0] !== value.process_identity_digest))) return undefined;
  return Object.freeze({ pid: Number(value.pid), process_identity_digest: value.process_identity_digest as string | null });
}

function decodePreparation(value: unknown): Readonly<RunDescendantPreparation> | undefined {
  if (!record(value) || !onlyKeys(value, ["schema", "preparation_id", "prepared_at", "parent", "child", "parent_producer"]) ||
    value.schema !== PREPARATION_SCHEMA || !intentId(value.preparation_id) || !timestamp(value.prepared_at)) return undefined;
  const parent = decodeReference(value.parent);
  const child = decodeReference(value.child);
  const producer = Object.hasOwn(value, "parent_producer") ? decodeProducerBinding(value.parent_producer) : undefined;
  if (!parent || !child || parent.run_instance_id === child.run_instance_id || parent.state_dir === child.state_dir ||
    ("parent_producer" in value && (!Object.hasOwn(value, "parent_producer") || !producer))) return undefined;
  return Object.freeze({ schema: PREPARATION_SCHEMA, preparation_id: value.preparation_id, prepared_at: value.prepared_at, parent, child,
    ...(producer ? { parent_producer: producer } : {}) });
}

function sameReference(a: RunDescendantLaunchTarget, b: RunDescendantLaunchTarget): boolean {
  return a.run === b.run && a.run_instance_id === b.run_instance_id && a.ownerId === b.ownerId && a.state_dir === b.state_dir;
}

/** Validated reference data only; resolving a target never grants work or membership authority. */
export function resolveRunDescendantLaunchTarget(value: unknown, owner: RunDescendantLaunchOwner, stateDir: string): Readonly<RunDescendantLaunchTarget> | undefined {
  if (!record(value) || !onlyKeys(value, ["run", "runInstanceId", "ownerId", "stateDir"]) ||
    !required(value, ["run", "runInstanceId", "stateDir"]) || !optionalText(value, "ownerId")) return undefined;
  return decodeTarget({ run: value.run, run_instance_id: value.runInstanceId,
    ...(value.ownerId === undefined ? {} : { ownerId: value.ownerId }), state_dir: value.stateDir }, owner, stateDir);
}

function decode(value: unknown, owner: RunDescendantLaunchOwner, stateDir: string): Readonly<RunDescendantLaunchLedger> | undefined {
  if (!record(value) || !onlyKeys(value, ["schema", "run", "run_instance_id", "ownerId", "runner_pid", "runner_identity_digest", "intents"]) ||
    value.schema !== SCHEMA || value.run !== owner.run || value.run_instance_id !== owner.runInstanceId ||
    value.ownerId !== owner.ownerId || value.runner_pid !== owner.pid ||
    value.runner_identity_digest !== (owner.processIdentityDigest ?? null) || !Array.isArray(value.intents)) return undefined;
  const ids = new Set<string>();
  const generations = new Set<string>();
  const preparations = new Set<string>();
  const intents: Readonly<RunDescendantLaunchIntent>[] = [];
  for (const item of value.intents) {
    if (!record(item) || !onlyKeys(item, ["intent_id", "admitted_at", "child", "preparation"]) || !intentId(item.intent_id) ||
      ids.has(item.intent_id) || !timestamp(item.admitted_at)) return undefined;
    const child = decodeTarget(item.child, owner, stateDir);
    const preparation = item.preparation === undefined ? undefined : decodePreparedFact(item.preparation);
    if (!child || generations.has(child.run_instance_id) || (item.preparation !== undefined && !preparation) ||
      (preparation && preparations.has(preparation.preparation_id))) return undefined;
    ids.add(item.intent_id);
    generations.add(child.run_instance_id);
    if (preparation) preparations.add(preparation.preparation_id);
    intents.push(Object.freeze({ intent_id: item.intent_id, admitted_at: item.admitted_at, child,
      ...(preparation ? { preparation } : {}) }));
  }
  return Object.freeze({ schema: SCHEMA, run: owner.run, run_instance_id: owner.runInstanceId,
    ...(owner.ownerId === undefined ? {} : { ownerId: owner.ownerId }), runner_pid: owner.pid,
    runner_identity_digest: owner.processIdentityDigest ?? null, intents: Object.freeze(intents) });
}

/** Only ENOENT permits mutation; an empty or invalid journal is not closure proof. */
export function assertNoRetainedDescendantLaunchScope(stateDir: string): void {
  assertNoRetainedDescendantFiles(stateDir, [RUN_DESCENDANT_LAUNCH_FILE, RUN_DESCENDANT_PREPARATION_FILE, RUN_DESCENDANT_PREPARED_META_FILE]);
}

function assertNoRetainedDescendantFiles(stateDir: string, files: readonly string[]): void {
  for (const file of files) {
    try { lstatSync(join(stateDir, file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; }
    throw new Error("Run descendant launch scope is unproven; confirm the complete owned scope before replacing or retiring its state.");
  }
}

/** Declared generations and paths confer no child work/control authority or exhaustive membership. */
export function readRunDescendantLaunchLedger(stateDir: string, owner: RunDescendantLaunchOwner): RunDescendantLaunchReading {
  if (!validOwner(owner)) return { state: "invalid" };
  let canonical: string;
  try { canonical = assertOwnedRunStateDirectory(stateDir, owner.run); }
  catch { return { state: "invalid" }; }
  const path = join(canonical, RUN_DESCENDANT_LAUNCH_FILE);
  try { if (!lstatSync(path).isFile()) return { state: "invalid" }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid" }; }
  const read = readJsonFileResilient<unknown>(path, undefined);
  if (read.diagnostics.length) return { state: "invalid" };
  const ledger = decode(read.value, owner, canonical);
  return ledger ? { state: "available", ledger } : { state: "invalid" };
}

/** Retained preparation data is evidence, never a native-start or membership capability. */
export function readRunDescendantPreparation(
  stateDir: string,
  child: RunDescendantLaunchTarget,
  parent: RunDescendantLaunchTarget,
): Readonly<RunDescendantPreparation> | undefined {
  try {
    const canonical = assertOwnedRunStateDirectory(stateDir, child.run);
    const path = join(canonical, RUN_DESCENDANT_PREPARATION_FILE);
    if (!lstatSync(path).isFile()) return undefined;
    const value = decodePreparation(JSON.parse(readFileSync(path, "utf8")));
    return value && child.state_dir === canonical && sameReference(value.child, child) && sameReference(value.parent, parent) ? value : undefined;
  } catch { return undefined; }
}

/** Fresh evidence checks only, not a capability reconstructed from staged metadata. */
export function assertRunDescendantPreparedMetadata(stateDir: string, child: RunDescendantLaunchTarget): void {
  const canonical = assertOwnedRunStateDirectory(stateDir, child.run);
  let unpublished = false;
  try { lstatSync(join(canonical, "run.json")); }
  catch (error) { unpublished = (error as NodeJS.ErrnoException).code === "ENOENT"; }
  if (!unpublished) throw new Error("Run descendant preparation is published or unavailable.");
  const path = join(canonical, RUN_DESCENDANT_PREPARED_META_FILE);
  if (!lstatSync(path).isFile()) throw new Error("Run descendant prepared metadata is unavailable or invalid.");
  const meta: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!record(meta) || meta.run !== child.run || meta.run_instance_id !== child.run_instance_id ||
    meta.ownerId !== child.ownerId || meta.state_dir !== canonical || child.state_dir !== canonical ||
    meta.pid !== 0 || meta.process_identity !== undefined) {
    throw new Error("Run descendant prepared metadata is unavailable or invalid.");
  }
}

/** Storage only: the kernel prepare-only branch owns child creation and holds parent then child lifecycle locks. */
export function recordRunDescendantPreparationUnderLock(
  stateDir: string,
  child: RunDescendantLaunchTarget,
  parent: RunDescendantLaunchTarget,
  producer: RunDescendantLaunchOwner,
): Readonly<RunDescendantPreparation> {
  const parentReference = decodeReference(parent);
  if (!validOwner(producer) || !parentReference || parentReference.run !== producer.run ||
    parentReference.run_instance_id !== producer.runInstanceId || parentReference.ownerId !== producer.ownerId) {
    throw new Error("Run descendant preparation producer binding is invalid.");
  }
  const canonical = assertOwnedRunStateDirectory(stateDir, child.run);
  assertNoRetainedDescendantFiles(canonical, [RUN_DESCENDANT_LAUNCH_FILE, RUN_DESCENDANT_PREPARATION_FILE]);
  assertRunDescendantPreparedMetadata(canonical, child);
  const preparation = decodePreparation({ schema: PREPARATION_SCHEMA, preparation_id: randomUUID(),
    prepared_at: new Date().toISOString(), child, parent: parentReference,
    parent_producer: { pid: producer.pid, process_identity_digest: producer.processIdentityDigest ?? null } });
  if (!preparation || preparation.child.state_dir !== canonical) throw new Error("Run descendant preparation binding is invalid.");
  writeJsonAtomic(join(canonical, RUN_DESCENDANT_PREPARATION_FILE), preparation);
  return preparation;
}

/** Storage only: bare intents require work admission; prepared facts may use evidence admission. Validate child evidence under its lock. */
export function recordRunDescendantLaunchIntentUnderLock(
  stateDir: string,
  owner: RunDescendantLaunchOwner,
  request: RunDescendantLaunchRequest,
  preparation?: RunDescendantPreparation,
): Readonly<RunDescendantLaunchIntent> {
  if (!validOwner(owner)) throw new Error("Run descendant launch identity or request is invalid.");
  const canonical = assertOwnedRunStateDirectory(stateDir, owner.run);
  const child = resolveRunDescendantLaunchTarget(request, owner, canonical);
  if (!child) throw new Error("Run descendant launch identity or request is invalid.");
  const current = readRunDescendantLaunchLedger(canonical, owner);
  if (current.state === "invalid") throw new Error("Run descendant launch evidence is unavailable or invalid.");
  const prior = current.state === "available" ? current.ledger.intents : [];
  const index = prior.findIndex((item) => item.child.run_instance_id === child.run_instance_id);
  const existing = prior[index];
  if (existing && preparation === undefined) throw new Error("Run descendant launch generation is already retained.");
  if (existing && !sameReference(existing.child, child)) throw new Error("Run descendant preparation target changed.");
  let prepared: Readonly<RunDescendantPreparedFact> | undefined;
  if (preparation !== undefined) {
    const parent = { run: owner.run, run_instance_id: owner.runInstanceId,
      ...(owner.ownerId === undefined ? {} : { ownerId: owner.ownerId }), state_dir: canonical };
    const claimed = decodePreparation(preparation);
    if (!claimed || !sameReference(claimed.parent, parent) || !sameReference(claimed.child, child)) {
      throw new Error("Run descendant preparation binding changed or is unavailable.");
    }
    if (existing?.preparation && (existing.preparation.preparation_id !== claimed.preparation_id ||
      existing.preparation.prepared_at !== claimed.prepared_at)) {
      throw new Error("Run descendant preparation binding changed or is unavailable.");
    }
    const retained = readRunDescendantPreparation(child.state_dir, child, parent);
    if (!retained || JSON.stringify(claimed) !== JSON.stringify(retained)) {
      throw new Error("Run descendant preparation binding changed or is unavailable.");
    }
    assertRunDescendantPreparedMetadata(child.state_dir, child);
    if (existing?.preparation) return existing;
    if (!retained.parent_producer || retained.parent_producer.pid !== owner.pid ||
      retained.parent_producer.process_identity_digest !== (owner.processIdentityDigest ?? null)) {
      throw new Error("Run descendant preparation producer binding changed or is unavailable.");
    }
    prepared = Object.freeze({ preparation_id: retained.preparation_id, prepared_at: retained.prepared_at });
  }
  const intent = existing ? Object.freeze({ ...existing, preparation: prepared! })
    : Object.freeze({ intent_id: randomUUID(), admitted_at: new Date().toISOString(), child,
        ...(prepared ? { preparation: prepared } : {}) });
  const intents = existing ? prior.map((item, i) => i === index ? intent : item) : [...prior, intent];
  const updated = decode({ schema: SCHEMA, run: owner.run, run_instance_id: owner.runInstanceId,
    ...(owner.ownerId === undefined ? {} : { ownerId: owner.ownerId }), runner_pid: owner.pid,
    runner_identity_digest: owner.processIdentityDigest ?? null, intents }, owner, canonical);
  if (!updated) throw new Error("Run descendant launch evidence is unavailable or invalid.");
  writeJsonAtomic(join(canonical, RUN_DESCENDANT_LAUNCH_FILE), updated);
  return updated.intents[existing ? index : updated.intents.length - 1]!;
}
