/**
 * Command-template async run lifecycle facade.
 * Owns launch, state observation, listing, message/control facade methods, and retention while runs-* subdomains own narrower run internals.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandTemplateFailureScope,
  CommandTemplateValue,
} from "./command-templates.ts";
import { writeJsonAtomic } from "./file-state.ts";
import * as Paths from "./paths.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import {
  resolveArtifactManifest,
  resolveArtifactPaths,
  type RunArtifactDeclaration,
  type RunArtifactManifestEntry,
} from "./runs-artifacts.ts";
import { safeRunId } from "./runs-identity.ts";
import {
  buildTerminalProgress,
  getRunProcessSignalPlan,
  markTerminalHandled,
  signalOwnedRunProcess,
  type RunProcessSignalPlan,
} from "./runs-control.ts";
import {
  buildRunOutboxEventPayload,
  parseRunOutboxEventLine,
  type RunOutboxEvent,
} from "./runs-outbox.ts";
import { archiveTerminalRun, pruneTerminalRun } from "./runs-retention.ts";
import {
  isAlive,
  isWithinRunnerIdentityGrace,
  pidMatchesRun,
} from "./runs-process.ts";
import * as RunsStart from "./runs-start.ts";
import * as RunsIndex from "./runs-index.ts";
import {
  claimRunInboxMessageInStateDir,
  parseRunInboxLine,
  processRunInboxMessagesInStateDir,
  readRunInboxMessagesFromStateDir,
  runInboxFile,
  type ProcessRunInboxResult,
  type RunInboxMessage,
  type RunInboxStatus,
  updateRunInboxMessageStatusInStateDir,
} from "./runs-mailbox.ts";
import {
  deliverRunMessage,
  type SendRunMessageOptions,
} from "./runs-messages.ts";
import { buildRunStatus, tailFile, tailLines } from "./runs-status.ts";
import { readJsonFileResilient } from "./state-readers.ts";

const RUNNER_IDENTITY_GRACE_MS = 5000;

export type AsyncRunLaunchSource = "spawn" | "tool";

export interface AsyncRunControlEndpoint {
  path: string;
  type: "fifo" | "mailbox" | "named-pipe";
}

export interface AsyncRunStartParams {
  async?: boolean;
  control?: AsyncRunControlEndpoint;
  file?: string;
  launch_source?: AsyncRunLaunchSource;
  name?: string;
  ownerId?: string;
  run_id?: string;
  state_dir?: string;
  tool?: string;
  template?: CommandTemplateValue;
  args?: string[];
  defaults?: Record<string, unknown>;
  parallel?: boolean;
  label?: string;
  when?: boolean | string;
  timeout?: number | string;
  delay?: number | string;
  output?: string;
  artifacts?: Record<string, RunArtifactDeclaration>;
  mailbox?: RecipesReferences.TemplateRecipeMailbox;
  retire_when?: "children_terminal";
  retry?: number | string;
  failure?: CommandTemplateFailureScope;
  recover?: CommandTemplateValue;
  repeat?: number;
  values?: Record<string, unknown>;
  actor_context?: boolean | string;
  cwd?: string;
}

export type AsyncRunStatus =
  | "running"
  | "done"
  | "failed"
  | "exited"
  | "cancelled"
  | "killed";

export interface AsyncRunMeta {
  argv: string[];
  createdAt: string;
  cwd: string;
  launch_source?: AsyncRunLaunchSource;
  ownerId?: string;
  pid: number;
  recipe?: string;
  recipe_file?: string;
  run: string;
  state_dir: string;
  status: AsyncRunStatus;
  tool?: string;
  template: CommandTemplateValue;
  values: Record<string, unknown>;
  artifacts?: Record<string, RunArtifactDeclaration>;
  control?: AsyncRunControlEndpoint;
  mailbox?: RecipesReferences.TemplateRecipeMailbox;
  recipe_context_records?: RecipesReferences.TemplateRecipeContextRecord[];
  retire_when?: "children_terminal";
}

const DEFAULT_STATE_ROOT = Paths.getRunStateRoot();
const DEFAULT_RECIPE_ROOT = Paths.getRecipeRoot();

function packageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  if (
    basename(moduleDir) === "lib" &&
    basename(dirname(moduleDir)) === "dist"
  ) {
    return dirname(dirname(moduleDir));
  }
  return dirname(moduleDir);
}

const PACKAGE_ROOT = packageRoot();
const RUNNER_PATH = join(PACKAGE_ROOT, "scripts", "async-runner.mjs");

function asyncRunnerArgv(stateDir: string): string[] {
  return existsSync(join(PACKAGE_ROOT, "dist", "lib", "execution.js"))
    ? [RUNNER_PATH, stateDir]
    : ["--experimental-strip-types", RUNNER_PATH, stateDir];
}

export { safeRunId } from "./runs-identity.ts";

export { resolveArtifactManifest } from "./runs-artifacts.ts";
export type {
  RunArtifactDeclaration,
  RunArtifactManifestEntry,
} from "./runs-artifacts.ts";

function resolveRunTemplate(params: AsyncRunStartParams): {
  template: CommandTemplateValue;
} {
  if (!params.template) throw new Error("spawn requires file or template.");
  const envelope: Record<string, unknown> = {};
  for (const key of [
    "args",
    "defaults",
    "parallel",
    "label",
    "when",
    "timeout",
    "delay",
    "output",
    "retry",
    "failure",
    "recover",
    "repeat",
  ] as const) {
    if (params[key] !== undefined) envelope[key] = params[key];
  }
  if (Object.keys(envelope).length === 0) return { template: params.template };
  if (typeof params.template === "object" && !Array.isArray(params.template)) {
    return { template: { ...envelope, ...params.template } };
  }
  return { template: { ...envelope, template: params.template } };
}

function resolveStateDir(params: AsyncRunStartParams, run: string): string {
  return resolve(params.state_dir || join(DEFAULT_STATE_ROOT, run));
}

function assertNoActiveRunState(stateDir: string): void {
  RunsStart.assertNoActiveRunState(stateDir, readJson, RUNNER_PATH);
}

function resolveRecipeFile(file: string): string {
  return (
    RecipesReferences.resolveRecipeReferencePath(file, Paths.getRecipeRoot()) ??
    RecipesReferences.getRecipePath(file, Paths.getRecipeRoot()) ??
    RecipesReferences.resolveRecipePath(file, Paths.getRecipeRoot())
  );
}

function isMutableUsageRecipeFile(file: string): boolean {
  const userRoot = resolve(DEFAULT_RECIPE_ROOT);
  const resolved = resolve(file);
  return resolved.startsWith(`${userRoot}/`);
}

function readRecipeFile(file: string): AsyncRunStartParams {
  const path = resolveRecipeFile(file);
  const raw = RecipesReferences.readRawRecipeConfig(path);
  const includeActorRecipeContext =
    raw?.actor_context !== false && raw?.actor_context !== "off";
  const config = RecipesReferences.readResolvedRecipeConfig(path, [], {
    includeActorRecipeContext,
  });
  if (!config) {
    throw new Error(`Template recipe must define template: ${path}`);
  }
  if (config.disabled === true) {
    throw new Error(`Template recipe is disabled: ${path}`);
  }
  return {
    ...(config as AsyncRunStartParams),
    file: path,
    ...(includeActorRecipeContext ? {} : { actor_context: false }),
  };
}

function getRunIdFromFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const name = basename(file, extname(file));
  return name || undefined;
}

function resolveStartParams(params: AsyncRunStartParams): AsyncRunStartParams {
  if (!params.file) return params;
  const fileParams = readRecipeFile(params.file);
  return {
    ...fileParams,
    ...params,
    run_id:
      params.run_id ||
      fileParams.run_id ||
      fileParams.name ||
      getRunIdFromFile(fileParams.file),
    values: { ...(fileParams.values ?? {}), ...(params.values ?? {}) },
  };
}

function readJson(path: string): Record<string, unknown> | undefined {
  return readJsonFileResilient<Record<string, unknown> | undefined>(
    path,
    undefined,
  ).value;
}

function acquireStateStartLock(stateDir: string): () => void {
  return RunsStart.acquireStateStartLock(stateDir);
}

function prepareStateDirForStart(stateDir: string): void {
  RunsStart.prepareStateDirForStart(stateDir, readJson, RUNNER_PATH);
}

export function startRun(
  params: AsyncRunStartParams,
  cwd: string,
): AsyncRunMeta {
  const startParams = resolveStartParams(params);
  const resolved = resolveRunTemplate(startParams);
  const run = safeRunId(startParams.run_id);
  const stateDir = resolveStateDir(startParams, run);
  assertNoActiveRunState(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const releaseStartLock = acquireStateStartLock(stateDir);
  try {
    assertNoActiveRunState(stateDir);
    prepareStateDirForStart(stateDir);
    const stdout = join(stateDir, "stdout.log");
    const stderr = join(stateDir, "stderr.log");
    const recipeFile = startParams.file
      ? resolveRecipeFile(startParams.file)
      : undefined;
    const recipe = startParams.name || getRunIdFromFile(recipeFile);
    const includeActorRecipeContext =
      startParams.actor_context !== false &&
      startParams.actor_context !== "off";
    const recipeContextRecords =
      recipeFile && includeActorRecipeContext
        ? RecipesReferences.buildRecipeContextRecords(recipeFile)
        : undefined;
    if (recipeFile && isMutableUsageRecipeFile(recipeFile)) {
      RecipesUsage.recordRecipeLaunch(
        recipeFile,
        new Date(),
        startParams.launch_source === "tool" ? "tool" : "spawn",
      );
    }
    const outFd = openSync(stdout, "a");
    const errFd = openSync(stderr, "a");
    const argv = asyncRunnerArgv(stateDir);
    const values = {
      ...(startParams.values || {}),
      actor_address: `run:${run}`,
      communication_file: join(stateDir, "communication.json"),
      default_room: `room:${run}`,
      run_id: run,
      state_dir: stateDir,
    };
    const outputValues = {
      ...(startParams.defaults || {}),
      ...values,
    };
    const artifacts = resolveArtifactPaths(startParams.artifacts, outputValues);
    const meta: AsyncRunMeta = {
      argv: [process.execPath, ...argv],
      createdAt: new Date().toISOString(),
      cwd,
      ...(startParams.launch_source
        ? { launch_source: startParams.launch_source }
        : {}),
      ...(startParams.ownerId ? { ownerId: startParams.ownerId } : {}),
      pid: 0,
      ...(recipe ? { recipe } : {}),
      ...(recipeFile ? { recipe_file: recipeFile } : {}),
      run,
      state_dir: stateDir,
      status: "running",
      ...(startParams.tool ? { tool: startParams.tool } : {}),
      template: resolved.template,
      values,
      ...(artifacts ? { artifacts } : {}),
      ...(startParams.control ? { control: startParams.control } : {}),
      ...(startParams.mailbox ? { mailbox: startParams.mailbox } : {}),
      ...(recipeContextRecords && recipeContextRecords.length > 0
        ? { recipe_context_records: recipeContextRecords }
        : {}),
      ...(startParams.retire_when === "children_terminal"
        ? { retire_when: "children_terminal" as const }
        : {}),
    };
    writeJsonAtomic(join(stateDir, "run.json"), meta);
    const child = spawn(process.execPath, argv, {
      cwd,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    closeSync(outFd);
    closeSync(errFd);
    meta.pid = child.pid ?? 0;
    writeJsonAtomic(join(stateDir, "run.json"), meta);
    writeJsonAtomic(join(stateDir, "progress.json"), {
      completed: 0,
      failures: [],
      phase: "starting",
      updatedAt: new Date().toISOString(),
    });
    writeFileSync(
      join(stateDir, "events.jsonl"),
      `${JSON.stringify({ event: "run.start", run, pid: meta.pid, ts: new Date().toISOString() })}\n`,
      { flag: "a" },
    );
    child.unref();
    return meta;
  } finally {
    releaseStartLock();
  }
}

export { parseRunOutboxEventLine } from "./runs-outbox.ts";
export type {
  RunOutboxDelivery,
  RunOutboxEvent,
  RunOutboxLevel,
} from "./runs-outbox.ts";

export function getRunStatus(runOrDir: string): Record<string, unknown> {
  const stateDir = resolve(
    runOrDir.includes("/")
      ? runOrDir
      : join(DEFAULT_STATE_ROOT, safeRunId(runOrDir)),
  );
  const meta = readJson(join(stateDir, "run.json"));
  if (!meta) throw new Error(`Run not found: ${runOrDir}`);
  return buildRunStatus(
    stateDir,
    runOrDir,
    meta,
    readJson,
    RUNNER_PATH,
    RUNNER_IDENTITY_GRACE_MS,
  );
}

export type { RunStateIndexEntry } from "./runs-index.ts";

export function listRunStateDirs(
  stateRoot = DEFAULT_STATE_ROOT,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  return RunsIndex.listRunStateDirs(stateRoot, depth, seen);
}

export function rebuildRunStateIndex(
  stateRoot = DEFAULT_STATE_ROOT,
): RunsIndex.RunStateIndexEntry[] {
  return RunsIndex.rebuildRunStateIndex(stateRoot, getRunStatus);
}

export function readRunStateIndex(
  stateRoot = DEFAULT_STATE_ROOT,
): RunsIndex.RunStateIndexEntry[] | undefined {
  return RunsIndex.readRunStateIndex(stateRoot, readJson);
}

export function listRuns(
  stateRoot = DEFAULT_STATE_ROOT,
  statusFilter?: string,
): Array<Record<string, unknown>> {
  return RunsIndex.listRuns(stateRoot, getRunStatus, readJson, statusFilter);
}

export function tailRun(runOrDir: string, lines = 40): string {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  const events = tailFile(join(stateDir, "events.jsonl"), lines);
  if (events) return events;
  return (
    tailFile(join(stateDir, "stdout.log"), lines) ||
    tailFile(join(stateDir, "stderr.log"), lines)
  );
}

export function readRunEvents(runOrDir: string, lines = 40): RunOutboxEvent[] {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? runOrDir);
  return tailLines(join(stateDir, "outbox.jsonl"), lines)
    .map((line, index) => parseRunOutboxEventLine(line, run, stateDir, index))
    .filter((event): event is RunOutboxEvent => Boolean(event));
}

export type {
  ProcessRunInboxResult,
  RunInboxMessage,
  RunInboxStatus,
} from "./runs-mailbox.ts";

export function readRunInboxMessages(
  runOrDir: string,
  lines = 40,
): RunInboxMessage[] {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  return tailLines(runInboxFile(stateDir), lines)
    .map(parseRunInboxLine)
    .filter((message): message is RunInboxMessage => Boolean(message));
}

export function updateRunInboxMessageStatus(
  runOrDir: string,
  id: string,
  nextStatus: RunInboxStatus,
  metadata: Record<string, unknown> = {},
): boolean {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  return updateRunInboxMessageStatusInStateDir(
    stateDir,
    id,
    nextStatus,
    metadata,
  );
}

export function claimRunInboxMessage(
  runOrDir: string,
  owner = "runtime",
  statuses: string[] = ["queued"],
): RunInboxMessage | undefined {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  return claimRunInboxMessageInStateDir(stateDir, owner, statuses);
}

export async function processRunInboxMessages(
  runOrDir: string,
  handler: (message: RunInboxMessage) => Promise<void> | void,
  options: { limit?: number; owner?: string; statuses?: string[] } = {},
): Promise<ProcessRunInboxResult> {
  const status = getRunStatus(runOrDir);
  return processRunInboxMessagesInStateDir(
    String(status.state_dir),
    handler,
    options,
  );
}

export function appendRunOutboxEvent(
  runOrDir: string,
  event: {
    body?: unknown;
    correlation_id?: string;
    data?: unknown;
    delivery?: string;
    event?: string;
    from?: string;
    level?: string;
    metadata?: Record<string, unknown>;
    reply_to?: string;
    summary?: string;
    to?: string;
    type?: string;
  },
): Record<string, unknown> {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? runOrDir);
  const payload = buildRunOutboxEventPayload(run, event);
  const line = `${JSON.stringify(payload)}\n`;
  writeFileSync(join(stateDir, "outbox.jsonl"), line, { flag: "a" });
  return {
    bytes: Buffer.byteLength(line),
    outbox: "outbox.jsonl",
    run,
    sent: true,
    state_dir: stateDir,
  };
}

export type { SendRunMessageOptions } from "./runs-messages.ts";

export async function sendRunMessage(
  runOrDir: string,
  message: string,
  options: SendRunMessageOptions = {},
): Promise<Record<string, unknown>> {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? runOrDir);
  if (status.status !== "running")
    throw new Error(`Run is not running: ${run}`);
  const pid = Number(status.pid || 0);
  if (!pid || !isAlive(pid)) throw new Error(`Run pid is not alive: ${run}`);
  if (
    !pidMatchesRun(pid, String(status.cwd), stateDir, RUNNER_PATH) &&
    !isWithinRunnerIdentityGrace(status, RUNNER_IDENTITY_GRACE_MS)
  )
    throw new Error(`Run pid owner mismatch: ${run}`);
  return deliverRunMessage(status, run, stateDir, message, options);
}

export { getRunProcessSignalPlan } from "./runs-control.ts";
export type { RunProcessSignalPlan } from "./runs-control.ts";

function markTerminalProgress(
  stateDir: string,
  phase: "cancelled" | "killed",
): void {
  const existing = readJson(join(stateDir, "progress.json"));
  const progress =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : undefined;
  writeJsonAtomic(
    join(stateDir, "progress.json"),
    buildTerminalProgress(progress, phase),
  );
}

function stopRun(
  runOrDir: string,
  signal: NodeJS.Signals,
  event: string,
): Record<string, unknown> {
  const status = getRunStatus(runOrDir);
  const pid = Number(status.pid || 0);
  const stateDir = String(status.state_dir);
  if (status.status !== "running")
    return { stopped: false, reason: "not running", status };
  if (!pid || !isAlive(pid))
    return { stopped: false, reason: "pid not alive", status };
  if (!pidMatchesRun(pid, String(status.cwd), stateDir, RUNNER_PATH)) {
    return { stopped: false, reason: "pid owner mismatch", status };
  }
  const signalResult = signalOwnedRunProcess(pid, signal);
  writeFileSync(
    join(stateDir, "events.jsonl"),
    `${JSON.stringify({ event, pid, signal, ...signalResult, ts: new Date().toISOString() })}\n`,
    { flag: "a" },
  );
  markTerminalHandled(stateDir, { event, signal });
  if (event === "run.kill") markTerminalProgress(stateDir, "killed");
  if (event === "run.cancel") markTerminalProgress(stateDir, "cancelled");
  return { stopped: true, pid, signal, ...signalResult, state_dir: stateDir };
}

export function cancelRun(runOrDir: string): Record<string, unknown> {
  const result = stopRun(runOrDir, "SIGTERM", "run.cancel");
  return Object.hasOwn(result, "stopped")
    ? { cancelled: result.stopped, ...result }
    : result;
}

function assertTerminalRun(runOrDir: string): Record<string, unknown> {
  const status = getRunStatus(runOrDir);
  if (status.status === "running") {
    throw new Error("Only terminal runs can be archived or pruned.");
  }
  return status;
}

export function archiveRun(runOrDir: string): Record<string, unknown> {
  return archiveTerminalRun(assertTerminalRun(runOrDir));
}

export function pruneRun(
  runOrDir: string,
  options: { preserveArtifacts?: boolean } = {},
): Record<string, unknown> {
  return pruneTerminalRun(assertTerminalRun(runOrDir), options);
}

export function killRun(runOrDir: string): Record<string, unknown> {
  const result = stopRun(runOrDir, "SIGKILL", "run.kill");
  return Object.hasOwn(result, "stopped")
    ? { killed: result.stopped, ...result }
    : result;
}
