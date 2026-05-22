/**
 * Command-template async run primitives
 * Zones: async runtime, lifecycle, state files
 * Owns detached run state, observation, log tailing, listing, and cancellation safety
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import type {
  CommandTemplateFailureScope,
  CommandTemplateValue,
} from "./command-templates.ts";
import { substituteCommandTemplateToken } from "./command-templates.ts";
import { writeJsonAtomic } from "./file-state.ts";
import * as Paths from "./paths.ts";
import * as RecipeReferences from "./recipe-references.ts";

export interface AsyncRunStartParams {
  async?: boolean;
  file?: string;
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
  artifacts?: Record<string, string>;
  mailbox?: RecipeReferences.TemplateRecipeMailbox;
  retry?: number | string;
  failure?: CommandTemplateFailureScope;
  recover?: CommandTemplateValue;
  repeat?: number;
  values?: Record<string, unknown>;
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
  artifacts?: Record<string, string>;
  mailbox?: RecipeReferences.TemplateRecipeMailbox;
}

const DEFAULT_STATE_ROOT = Paths.getRunStateRoot();
const DEFAULT_RECIPE_ROOT = Paths.getRecipeRoot();
const RUNNER_PATH = new URL("../scripts/async-runner.mjs", import.meta.url)
  .pathname;

function safeRunId(value: string | undefined): string {
  const run = (value || `run-${Date.now()}`).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(run))
    throw new Error(
      "Run id may contain only letters, numbers, dot, underscore, and dash.",
    );
  return run;
}

function resolveArtifactPaths(
  artifacts: Record<string, string> | undefined,
  values: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!artifacts) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(artifacts)) {
    if (!key.trim()) continue;
    resolved[key] = substituteCommandTemplateToken(
      value,
      values,
      `recipe artifacts.${key}`,
    );
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
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

function resolveRecipeFile(file: string): string {
  return RecipeReferences.resolveRecipePath(file, DEFAULT_RECIPE_ROOT);
}

function readRecipeFile(file: string): AsyncRunStartParams {
  const path = resolveRecipeFile(file);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (Object.hasOwn(raw, "tool")) {
    throw new Error(
      `Template recipe cannot define tool; use template in ${path}`,
    );
  }
  const config = RecipeReferences.readResolvedRecipeConfig(path);
  if (!config) {
    throw new Error(`Template recipe must define template: ${path}`);
  }
  return { ...(config as AsyncRunStartParams), file: path };
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
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
  const events = tailFile(join(stateDir, "events.jsonl"), 200);
  if (!events) return undefined;
  for (const line of events.split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event === "run.kill") return "killed";
      if (event.event === "run.cancel") return "cancelled";
    } catch {
      // Ignore malformed event lines.
    }
  }
  return undefined;
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
  mkdirSync(stateDir, { recursive: true });
  prepareStateDirForStart(stateDir);
  const stdout = join(stateDir, "stdout.log");
  const stderr = join(stateDir, "stderr.log");
  const recipeFile = startParams.file
    ? resolveRecipeFile(startParams.file)
    : undefined;
  const recipe = startParams.name || getRunIdFromFile(recipeFile);
  const outFd = openSync(stdout, "a");
  const errFd = openSync(stderr, "a");
  const argv = ["--experimental-strip-types", RUNNER_PATH, stateDir];
  const values = {
    ...(startParams.values || {}),
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
    ...(startParams.mailbox ? { mailbox: startParams.mailbox } : {}),
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
      pidMatchesRun(pid, String(meta.cwd ?? ""), stateDir)),
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

function matchesStatusFilter(
  status: unknown,
  filter: string | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "active") return status === "running";
  if (filter === "terminal") return status !== "running";
  return status === filter;
}

export function listRuns(
  stateRoot = DEFAULT_STATE_ROOT,
  statusFilter?: string,
): Array<Record<string, unknown>> {
  if (!existsSync(stateRoot)) return [];
  const runs: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const stateDir = join(stateRoot, entry.name);
      const status = getRunStatus(stateDir);
      if (!matchesStatusFilter(status.status, statusFilter)) continue;
      runs.push({
        run: status.run,
        state_dir: stateDir,
        status: status.status,
        ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
        ...(typeof status.recipe === "string" ? { recipe: status.recipe } : {}),
      });
    } catch {
      // Ignore malformed run dirs.
    }
  }
  return runs;
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
  const payload = {
    ...(event.body !== undefined ? { body: event.body } : {}),
    ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
    delivery: normalizeRunOutboxDelivery(
      event.delivery ?? (to === "coordinator" ? "followup" : "log"),
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

export function sendRunMessage(
  runOrDir: string,
  message: string,
): Record<string, unknown> {
  if (process.platform === "win32") {
    throw new Error(
      "run actor messages require Unix FIFO support; use WSL/Linux/macOS or a recipe-specific Windows transport.",
    );
  }
  const status = getRunStatus(runOrDir);
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? runOrDir);
  if (status.status !== "running")
    throw new Error(`Run is not running: ${run}`);
  const pid = Number(status.pid || 0);
  if (!pid || !isAlive(pid)) throw new Error(`Run pid is not alive: ${run}`);
  if (!pidMatchesRun(pid, String(status.cwd), stateDir))
    throw new Error(`Run pid owner mismatch: ${run}`);
  const controlPath = join(stateDir, "control.fifo");
  if (!existsSync(controlPath))
    throw new Error(`Run control FIFO not found: ${controlPath}`);
  const stat = statSync(controlPath);
  if ((stat.mode & constants.S_IFMT) !== constants.S_IFIFO) {
    throw new Error(`Run control endpoint is not a FIFO: ${controlPath}`);
  }
  const payload = message.endsWith("\n") ? message : `${message}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(controlPath, constants.O_WRONLY | constants.O_NONBLOCK);
    const bytes = writeSync(fd, payload);
    const trimmedMessage = message.trim().toLowerCase();
    const terminalMessage = ["stop", "cancel", "quit", "exit"].includes(
      trimmedMessage,
    );
    writeFileSync(
      join(stateDir, "events.jsonl"),
      `${JSON.stringify({ bytes, event: "run.message", terminal: terminalMessage || undefined, ts: new Date().toISOString() })}\n`,
      { flag: "a" },
    );
    if (terminalMessage) {
      markTerminalHandled(stateDir, {
        event: "run.message",
        message: trimmedMessage,
      });
    }
    return {
      bytes,
      control: "control.fifo",
      run,
      sent: true,
      state_dir: stateDir,
    };
  } catch (error) {
    throw new Error(
      `Run control FIFO is not ready: ${controlPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function signalOwnedRunProcess(
  pid: number,
  signal: NodeJS.Signals,
): { signalTarget: "processGroup" | "process" } {
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
  return { stopped: true, pid, signal, ...signalResult, state_dir: stateDir };
}

export function cancelRun(runOrDir: string): Record<string, unknown> {
  const result = stopRun(runOrDir, "SIGTERM", "run.cancel");
  return Object.hasOwn(result, "stopped")
    ? { cancelled: result.stopped, ...result }
    : result;
}

export function killRun(runOrDir: string): Record<string, unknown> {
  const result = stopRun(runOrDir, "SIGKILL", "run.kill");
  return Object.hasOwn(result, "stopped")
    ? { killed: result.stopped, ...result }
    : result;
}
