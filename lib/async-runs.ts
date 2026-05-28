/**
 * Command-template async run primitives
 * Zones: async runtime, lifecycle, state files
 * Owns detached run state, observation, log tailing, listing, and cancellation safety
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  cpSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandTemplateFailureScope,
  CommandTemplateValue,
} from "./command-templates.ts";
import { substituteCommandTemplateToken } from "./command-templates.ts";
import { writeJsonAtomic } from "./file-state.ts";
import { readJsonFileResilient, readJsonlFileResilient } from "./state-readers.ts";
import * as Paths from "./paths.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as RecipeUsage from "./recipe-usage.ts";
import { notifyRuntimeWake } from "./runtime-notifier.ts";

const START_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const RUN_INBOX_LOCK_TIMEOUT_MS = 5000;
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
  mailbox?: RecipeReferences.TemplateRecipeMailbox;
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
export type RunOutboxDelivery = "log" | "notify" | "followup";
export type RunOutboxLevel = "info" | "warning" | "error";

export interface RunOutboxEvent {
  body?: unknown;
  correlation_id?: string;
  data?: unknown;
  delivery: RunOutboxDelivery;
  event: string;
  from?: string;
  id: string;
  level: RunOutboxLevel;
  metadata?: Record<string, unknown>;
  reply_to?: string;
  run: string;
  state_dir: string;
  summary: string;
  to?: string;
  ts: string;
  type?: string;
}

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
  mailbox?: RecipeReferences.TemplateRecipeMailbox;
  recipe_context_records?: RecipeReferences.TemplateRecipeContextRecord[];
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

function safeRunId(value: string | undefined): string {
  const run = (value || `run-${Date.now()}`).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(run))
    throw new Error(
      "Run id may contain only letters, numbers, dot, underscore, and dash.",
    );
  return run;
}

export type RunArtifactDeclaration =
  | string
  | { path: string; kind?: string; media_type?: string; required?: boolean };

export interface RunArtifactManifestEntry {
  exists: boolean;
  kind?: string;
  media_type?: string;
  path: string;
  required?: boolean;
  sha256?: string;
  size?: number;
}

function resolveArtifactPaths(
  artifacts: Record<string, RunArtifactDeclaration> | undefined,
  values: Record<string, unknown>,
): Record<string, RunArtifactDeclaration> | undefined {
  if (!artifacts) return undefined;
  const resolved: Record<string, RunArtifactDeclaration> = {};
  for (const [key, value] of Object.entries(artifacts)) {
    if (!key.trim()) continue;
    if (typeof value === "string") {
      resolved[key] = substituteCommandTemplateToken(
        value,
        values,
        `recipe artifacts.${key}`,
      );
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.path === "string"
    ) {
      resolved[key] = {
        ...value,
        path: substituteCommandTemplateToken(
          value.path,
          values,
          `recipe artifacts.${key}.path`,
        ),
      };
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveArtifactManifest(
  artifacts: Record<string, RunArtifactDeclaration> | undefined,
): Record<string, RunArtifactManifestEntry> | undefined {
  if (!artifacts) return undefined;
  const manifest: Record<string, RunArtifactManifestEntry> = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    const declaration =
      typeof artifact === "string" ? { path: artifact } : artifact;
    if (!declaration?.path) continue;
    try {
      const content = readFileSync(declaration.path);
      manifest[name] = {
        exists: true,
        ...(declaration.kind ? { kind: declaration.kind } : {}),
        ...(declaration.media_type
          ? { media_type: declaration.media_type }
          : {}),
        path: declaration.path,
        ...(declaration.required !== undefined
          ? { required: declaration.required }
          : {}),
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
      };
    } catch {
      manifest[name] = {
        exists: false,
        ...(declaration.kind ? { kind: declaration.kind } : {}),
        ...(declaration.media_type
          ? { media_type: declaration.media_type }
          : {}),
        path: declaration.path,
        ...(declaration.required !== undefined
          ? { required: declaration.required }
          : {}),
      };
    }
  }
  return Object.keys(manifest).length > 0 ? manifest : undefined;
}

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
  const meta = readJson(join(stateDir, "run.json"));
  if (!meta) return;
  const pid = Number(meta.pid || 0);
  const cwd = String(meta.cwd ?? "");
  if (!pid || !isAlive(pid) || !pidMatchesRun(pid, cwd, stateDir)) return;
  throw new Error(
    `Run state already has an active owned process: ${String(meta.run ?? stateDir)}. Stop it before reusing the same run_id or state_dir.`,
  );
}

function resolveRecipeFile(file: string): string {
  return (
    RecipeReferences.getRecipePath(file, DEFAULT_RECIPE_ROOT) ??
    RecipeReferences.resolveRecipePath(file, DEFAULT_RECIPE_ROOT)
  );
}

function isMutableUsageRecipeFile(file: string): boolean {
  const userRoot = resolve(DEFAULT_RECIPE_ROOT);
  const resolved = resolve(file);
  return resolved.startsWith(`${userRoot}/`);
}

function readRecipeFile(file: string): AsyncRunStartParams {
  const path = resolveRecipeFile(file);
  const raw = RecipeReferences.readRawRecipeConfig(path);
  const includeActorRecipeContext =
    raw?.actor_context !== false && raw?.actor_context !== "off";
  const config = RecipeReferences.readResolvedRecipeConfig(path, [], {
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidMatchesRun(pid: number, cwd: string, stateDir: string): boolean {
  if (platform() !== "linux" || !existsSync(`/proc/${pid}`))
    return isAlive(pid);
  try {
    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return (
      procCwd === resolve(cwd) &&
      cmdline.includes(RUNNER_PATH) &&
      cmdline.includes(stateDir)
    );
  } catch {
    return false;
  }
}

function isWithinRunnerIdentityGrace(meta: Record<string, unknown>): boolean {
  const createdAt =
    typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : NaN;
  return (
    Number.isFinite(createdAt) &&
    Date.now() - createdAt >= 0 &&
    Date.now() - createdAt <= RUNNER_IDENTITY_GRACE_MS
  );
}

function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8").trimEnd();
  if (!content) return "";
  return content.split("\n").slice(-lines).join("\n");
}

function tailLines(path: string, lines: number): string[] {
  const content = tailFile(path, lines);
  return content ? content.split("\n") : [];
}

function getInterruptedRunStatus(
  stateDir: string,
): "cancelled" | "killed" | undefined {
  const events = readJsonlFileResilient<Record<string, unknown>>(
    join(stateDir, "events.jsonl"),
  ).records.slice(-200);
  for (const event of events.reverse()) {
    if (event.event === "run.kill") return "killed";
    if (event.event === "run.cancel") return "cancelled";
  }
  return undefined;
}

function acquireStateStartLock(stateDir: string): () => void {
  const lockDir = join(stateDir, ".start.lock");
  try {
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > START_LOCK_MAX_AGE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(
          join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), recovered: true })}\n`,
          "utf8",
        );
        return () => rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Keep the original lock acquisition error below.
    }
    throw new Error(
      `Run state is already being started: ${stateDir}. Retry after the current start finishes.`,
      { cause: error },
    );
  }
  return () => rmSync(lockDir, { recursive: true, force: true });
}

function prepareStateDirForStart(stateDir: string): void {
  const existing = readJson(join(stateDir, "run.json"));
  const existingPid = Number(existing?.pid || 0);
  const existingCwd =
    typeof existing?.cwd === "string" ? existing.cwd : undefined;
  const existingResult = readJson(join(stateDir, "result.json"));
  if (
    !existingResult &&
    existingPid &&
    existingCwd &&
    isAlive(existingPid) &&
    pidMatchesRun(existingPid, existingCwd, stateDir)
  ) {
    throw new Error(
      `Run is already running: ${String(existing?.run ?? stateDir)}`,
    );
  }
  for (const file of [
    "events.jsonl",
    "inbox.jsonl",
    "outbox.jsonl",
    "progress.json",
    "result.json",
    "stderr.log",
    "stdout.log",
    "terminal-handled.json",
  ]) {
    rmSync(join(stateDir, file), { force: true });
  }
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
        ? RecipeReferences.buildRecipeContextRecords(recipeFile)
        : undefined;
    if (recipeFile && isMutableUsageRecipeFile(recipeFile)) {
      RecipeUsage.recordRecipeLaunch(
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

function normalizeRunOutboxDelivery(value: unknown): RunOutboxDelivery {
  return value === "notify" || value === "followup" ? value : "log";
}

function normalizeRunOutboxLevel(value: unknown): RunOutboxLevel {
  return value === "warning" || value === "error" ? value : "info";
}

function normalizeRunOutboxEvent(
  raw: unknown,
  run: string,
  stateDir: string,
  index: number,
): RunOutboxEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const event =
    typeof record.event === "string" && record.event.trim()
      ? record.event.trim()
      : "run.event";
  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.trim()
      : event;
  const ts =
    typeof record.ts === "string" && record.ts.trim()
      ? record.ts.trim()
      : new Date(0).toISOString();
  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `${run}:${index}`;
  return {
    ...(record.body !== undefined ? { body: record.body } : {}),
    ...(typeof record.correlation_id === "string"
      ? { correlation_id: record.correlation_id }
      : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
    delivery: normalizeRunOutboxDelivery(record.delivery),
    ...(record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
    event,
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    id,
    level: normalizeRunOutboxLevel(record.level),
    ...(typeof record.reply_to === "string"
      ? { reply_to: record.reply_to }
      : {}),
    run,
    state_dir: stateDir,
    summary,
    ...(typeof record.to === "string" ? { to: record.to } : {}),
    ts,
    ...(typeof record.type === "string" ? { type: record.type } : {}),
  };
}

export function parseRunOutboxEventLine(
  line: string,
  run: string,
  stateDir: string,
  index: number,
): RunOutboxEvent | undefined {
  try {
    return normalizeRunOutboxEvent(JSON.parse(line), run, stateDir, index);
  } catch {
    return undefined;
  }
}

export function getRunStatus(runOrDir: string): Record<string, unknown> {
  const stateDir = resolve(
    runOrDir.includes("/")
      ? runOrDir
      : join(DEFAULT_STATE_ROOT, safeRunId(runOrDir)),
  );
  const meta = readJson(join(stateDir, "run.json"));
  if (!meta) throw new Error(`Run not found: ${runOrDir}`);
  const result = readJson(join(stateDir, "result.json"));
  const pid = Number(meta.pid || 0);
  const aliveOwnedRunner = Boolean(
    pid &&
    isAlive(pid) &&
    (!Array.isArray(meta.argv) ||
      pidMatchesRun(pid, String(meta.cwd ?? ""), stateDir) ||
      isWithinRunnerIdentityGrace(meta)),
  );
  const status: AsyncRunStatus = result
    ? Number(result.code ?? 0) === 0
      ? "done"
      : "failed"
    : aliveOwnedRunner
      ? "running"
      : (getInterruptedRunStatus(stateDir) ?? "exited");
  const terminalHandled = readJson(join(stateDir, "terminal-handled.json"));
  return {
    ...meta,
    eventsFile: join(stateDir, "events.jsonl"),
    inboxFile: join(stateDir, "inbox.jsonl"),
    outboxFile: join(stateDir, "outbox.jsonl"),
    progress: readJson(join(stateDir, "progress.json")) || null,
    result: result || null,
    ...(terminalHandled ? { terminal_handled: terminalHandled } : {}),
    state_dir: String(meta.state_dir ?? stateDir),
    stderrLog: join(stateDir, "stderr.log"),
    stdoutLog: join(stateDir, "stdout.log"),
    status,
  };
}

export interface RunStateIndexEntry {
  ownerId?: string;
  recipe?: string;
  run: string;
  state_dir: string;
  status: AsyncRunStatus;
  tool?: string;
  updated_at?: string;
}

function matchesStatusFilter(
  status: unknown,
  filter: string | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "active") return status === "running";
  if (filter === "terminal") return status !== "running";
  return status === filter;
}

export function listRunStateDirs(
  stateRoot = DEFAULT_STATE_ROOT,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (!existsSync(stateRoot) || seen.has(resolve(stateRoot))) return [];
  seen.add(resolve(stateRoot));
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(stateRoot, entry.name);
    if (existsSync(join(child, "run.json"))) result.push(child);
    if (depth + 1 < 8) result.push(...listRunStateDirs(child, depth + 1, seen));
  }
  return result;
}

function runIndexPath(stateRoot: string): string {
  return join(stateRoot, "index.json");
}

function indexEntryFromStatus(
  status: Record<string, unknown>,
): RunStateIndexEntry {
  const progress =
    status.progress && typeof status.progress === "object"
      ? (status.progress as Record<string, unknown>)
      : {};
  return {
    ...(typeof status.ownerId === "string" ? { ownerId: status.ownerId } : {}),
    ...(typeof status.recipe === "string" ? { recipe: status.recipe } : {}),
    run: String(status.run),
    state_dir: String(status.state_dir),
    status: status.status as AsyncRunStatus,
    ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
    updated_at:
      typeof progress.updatedAt === "string"
        ? progress.updatedAt
        : typeof status.createdAt === "string"
          ? status.createdAt
          : new Date(0).toISOString(),
  };
}

export function rebuildRunStateIndex(
  stateRoot = DEFAULT_STATE_ROOT,
): RunStateIndexEntry[] {
  mkdirSync(stateRoot, { recursive: true });
  const entries = listRunStateDirs(stateRoot)
    .flatMap((stateDir) => {
      try {
        return [indexEntryFromStatus(getRunStatus(stateDir))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  writeJsonAtomic(runIndexPath(stateRoot), {
    entries,
    rebuilt_at: new Date().toISOString(),
  });
  return entries;
}

export function readRunStateIndex(
  stateRoot = DEFAULT_STATE_ROOT,
): RunStateIndexEntry[] | undefined {
  const index = readJson(runIndexPath(stateRoot));
  if (!index || typeof index !== "object") return undefined;
  const entries = (index as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return undefined;
  const valid = entries.filter((entry): entry is RunStateIndexEntry => {
    const record =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    return (
      typeof record.run === "string" &&
      typeof record.state_dir === "string" &&
      typeof record.status === "string"
    );
  });
  if (valid.some((entry) => !existsSync(join(entry.state_dir, "run.json"))))
    return undefined;
  const indexedDirs = new Set(valid.map((entry) => resolve(entry.state_dir)));
  const stateDirs = listRunStateDirs(stateRoot).map((stateDir) => resolve(stateDir));
  if (stateDirs.some((stateDir) => !indexedDirs.has(stateDir))) return undefined;
  return valid;
}

export function listRuns(
  stateRoot = DEFAULT_STATE_ROOT,
  statusFilter?: string,
): Array<Record<string, unknown>> {
  if (!existsSync(stateRoot)) return [];
  const indexed = readRunStateIndex(stateRoot);
  if (indexed) {
    return indexed
      .filter((entry) => matchesStatusFilter(entry.status, statusFilter))
      .map((entry) => ({
        run: entry.run,
        state_dir: entry.state_dir,
        status: entry.status,
        ...(entry.tool ? { tool: entry.tool } : {}),
        ...(entry.recipe ? { recipe: entry.recipe } : {}),
      }));
  }
  return rebuildRunStateIndex(stateRoot)
    .filter((entry) => matchesStatusFilter(entry.status, statusFilter))
    .map((entry) => ({
      run: entry.run,
      state_dir: entry.state_dir,
      status: entry.status,
      ...(entry.tool ? { tool: entry.tool } : {}),
      ...(entry.recipe ? { recipe: entry.recipe } : {}),
    }));
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

export type RunInboxStatus =
  | "queued"
  | "sent"
  | "claimed"
  | "handled"
  | "failed";

export type RunInboxMessage = Record<string, unknown> & {
  id?: string;
  status?: RunInboxStatus | string;
};

export interface ProcessRunInboxResult {
  claimed: number;
  failed: number;
  handled: number;
}

function runInboxFile(stateDir: string): string {
  return join(stateDir, "inbox.jsonl");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRunInboxLock(stateDir: string): () => void {
  const lockDir = join(stateDir, ".inbox.lock");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > START_LOCK_MAX_AGE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > RUN_INBOX_LOCK_TIMEOUT_MS) {
        throw new Error("Run inbox lock timed out.", { cause: error });
      }
      sleepSync(10);
    }
  }
}

function parseRunInboxLine(line: string): RunInboxMessage | undefined {
  try {
    return JSON.parse(line) as RunInboxMessage;
  } catch {
    return undefined;
  }
}

function readRunInboxMessagesFromStateDir(stateDir: string): RunInboxMessage[] {
  return readJsonlFileResilient<RunInboxMessage>(runInboxFile(stateDir)).records;
}

function writeRunInboxMessages(
  stateDir: string,
  messages: RunInboxMessage[],
): void {
  writeFileSync(
    runInboxFile(stateDir),
    messages.length
      ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
      : "",
    "utf8",
  );
}

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
  const releaseLock = acquireRunInboxLock(stateDir);
  try {
    const messages = readRunInboxMessagesFromStateDir(stateDir);
    const timestampKey = `${nextStatus}_at`;
    let changed = false;
    const updated = messages.map((message) => {
      if (message.id !== id) return message;
      changed = true;
      return {
        ...message,
        ...metadata,
        [timestampKey]: new Date().toISOString(),
        status: nextStatus,
      };
    });
    if (changed) writeRunInboxMessages(stateDir, updated);
    return changed;
  } finally {
    releaseLock();
  }
}

export function claimRunInboxMessage(
  runOrDir: string,
  owner = "runtime",
  statuses: string[] = ["queued"],
): RunInboxMessage | undefined {
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  const releaseLock = acquireRunInboxLock(stateDir);
  try {
    const messages = readRunInboxMessagesFromStateDir(stateDir);
    const index = messages.findIndex((message) =>
      statuses.includes(String(message.status ?? "queued")),
    );
    if (index < 0) return undefined;
    const claimed = {
      ...messages[index],
      claimed_at: new Date().toISOString(),
      claimed_by: owner,
      id:
        typeof messages[index].id === "string"
          ? messages[index].id
          : randomUUID(),
      status: "claimed",
    } satisfies RunInboxMessage;
    messages[index] = claimed;
    writeRunInboxMessages(stateDir, messages);
    return claimed;
  } finally {
    releaseLock();
  }
}

export async function processRunInboxMessages(
  runOrDir: string,
  handler: (message: RunInboxMessage) => Promise<void> | void,
  options: { limit?: number; owner?: string; statuses?: string[] } = {},
): Promise<ProcessRunInboxResult> {
  const result: ProcessRunInboxResult = { claimed: 0, failed: 0, handled: 0 };
  const limit = Math.max(1, Number(options.limit ?? 1));
  const owner = options.owner ?? "runtime";
  for (let index = 0; index < limit; index += 1) {
    const message = claimRunInboxMessage(runOrDir, owner, options.statuses);
    if (!message?.id) break;
    result.claimed += 1;
    try {
      await handler(message);
      if (updateRunInboxMessageStatus(runOrDir, message.id, "handled")) {
        result.handled += 1;
      }
    } catch (error) {
      if (
        updateRunInboxMessageStatus(runOrDir, message.id, "failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      ) {
        result.failed += 1;
      }
    }
  }
  return result;
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
  const type = event.type || event.event || "run.message";
  const to = event.to || "coordinator";
  const metadata = event.metadata ?? {};
  const requiresResponse = metadata.requires_response === true;
  const payload = {
    ...(event.body !== undefined ? { body: event.body } : {}),
    ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
    delivery: normalizeRunOutboxDelivery(
      event.delivery ??
        (requiresResponse
          ? "followup"
          : to === "coordinator"
            ? "notify"
            : "log"),
    ),
    event: type,
    from: event.from || `run:${run}`,
    level: normalizeRunOutboxLevel(event.level),
    ...(event.metadata ? { metadata: event.metadata } : {}),
    ...(event.reply_to ? { reply_to: event.reply_to } : {}),
    summary: event.summary || type,
    to,
    ts: new Date().toISOString(),
    type,
  };
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

export interface SendRunMessageOptions {
  namedPipeSend?: (path: string, payload: string) => Promise<number>;
  platform?: NodeJS.Platform;
}

function getRunControlEndpoint(
  status: Record<string, unknown>,
  stateDir: string,
): AsyncRunControlEndpoint {
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
  const id = randomUUID();
  const ts = new Date().toISOString();
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
  const releaseLock = acquireRunInboxLock(stateDir);
  try {
    writeFileSync(
      runInboxFile(stateDir),
      `${JSON.stringify({ ...record, id, queued_at: ts, received_at: ts, status: "queued" })}\n`,
      { flag: "a" },
    );
  } finally {
    releaseLock();
  }
  return id;
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
  updateRunInboxMessageStatus(stateDir, inboxId, "sent", { bytes });
  if (terminalMessage) {
    markTerminalHandled(stateDir, {
      event: "run.message",
      message: trimmedMessage,
    });
  }
}

function sendRunMessageToFifo(
  endpoint: AsyncRunControlEndpoint,
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
  endpoint: AsyncRunControlEndpoint,
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
  endpoint: AsyncRunControlEndpoint,
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
    !pidMatchesRun(pid, String(status.cwd), stateDir) &&
    !isWithinRunnerIdentityGrace(status)
  )
    throw new Error(`Run pid owner mismatch: ${run}`);
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

export interface RunProcessSignalPlan {
  args?: string[];
  command?: string;
  signalTarget: "processGroup" | "process" | "processTree";
}

export function getRunProcessSignalPlan(
  pid: number,
  signal: NodeJS.Signals,
  runtimePlatform: NodeJS.Platform = process.platform,
): RunProcessSignalPlan {
  if (runtimePlatform === "win32") {
    return {
      args: [
        "/PID",
        String(pid),
        "/T",
        ...(signal === "SIGKILL" ? ["/F"] : []),
      ],
      command: "taskkill",
      signalTarget: "processTree",
    };
  }
  return { signalTarget: "processGroup" };
}

function signalOwnedRunProcess(
  pid: number,
  signal: NodeJS.Signals,
): RunProcessSignalPlan {
  const plan = getRunProcessSignalPlan(pid, signal);
  if (plan.command && plan.args) {
    const result = spawnSync(plan.command, plan.args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.trim() ||
          result.stdout?.trim() ||
          `${plan.command} failed`,
      );
    }
    return plan;
  }
  try {
    process.kill(-pid, signal);
    return { signalTarget: "processGroup" };
  } catch {
    process.kill(pid, signal);
    return { signalTarget: "process" };
  }
}

function markTerminalHandled(
  stateDir: string,
  details: Record<string, unknown>,
): void {
  writeJsonAtomic(join(stateDir, "terminal-handled.json"), {
    ...details,
    ts: new Date().toISOString(),
  });
}

function markTerminalProgress(
  stateDir: string,
  phase: "cancelled" | "killed",
): void {
  const existing = readJson(join(stateDir, "progress.json"));
  const progress =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const { activeSubagents: _activeSubagents, ...rest } = progress;
  writeJsonAtomic(join(stateDir, "progress.json"), {
    ...rest,
    completed: typeof progress.completed === "number" ? progress.completed : 0,
    failures: Array.isArray(progress.failures) ? progress.failures : [],
    phase,
    updatedAt: new Date().toISOString(),
  });
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
  if (!pidMatchesRun(pid, String(status.cwd), stateDir)) {
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

function archivePathFor(run: string, stateDir: string): string {
  const archiveRoot = join(dirname(stateDir), "archived");
  mkdirSync(archiveRoot, { recursive: true });
  return join(
    archiveRoot,
    `${safeRunId(run)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
}

export function archiveRun(runOrDir: string): Record<string, unknown> {
  const status = assertTerminalRun(runOrDir);
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? basename(stateDir));
  const archiveDir = archivePathFor(run, stateDir);
  renameSync(stateDir, archiveDir);
  mkdirSync(stateDir, { recursive: true });
  const tombstone = {
    archived: true,
    archive_dir: archiveDir,
    original_state_dir: stateDir,
    run,
    status: status.status,
    ts: new Date().toISOString(),
  };
  writeJsonAtomic(join(stateDir, "archive-tombstone.json"), tombstone);
  return tombstone;
}

export function pruneRun(
  runOrDir: string,
  options: { preserveArtifacts?: boolean } = {},
): Record<string, unknown> {
  const status = assertTerminalRun(runOrDir);
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? basename(stateDir));
  const manifest = resolveArtifactManifest(
    status.artifacts as Record<string, RunArtifactDeclaration> | undefined,
  );
  const preserved: Record<string, string> = {};
  if (options.preserveArtifacts && manifest) {
    const preserveRoot = join(
      dirname(stateDir),
      "preserved-artifacts",
      safeRunId(run),
    );
    mkdirSync(preserveRoot, { recursive: true });
    for (const [name, artifact] of Object.entries(manifest)) {
      if (!artifact.exists) continue;
      const target = join(preserveRoot, basename(artifact.path));
      cpSync(artifact.path, target, { force: true });
      preserved[name] = target;
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  return {
    pruned: true,
    preserved_artifacts: preserved,
    run,
    state_dir: stateDir,
    ts: new Date().toISOString(),
  };
}

export function killRun(runOrDir: string): Record<string, unknown> {
  const result = stopRun(runOrDir, "SIGKILL", "run.kill");
  return Object.hasOwn(result, "stopped")
    ? { killed: result.stopped, ...result }
    : result;
}
