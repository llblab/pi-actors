/**
 * Async run observability helpers
 * Zones: async runtime, ambient UI, diagnostics
 * Owns ambient summaries, terminal events, and run outbox delivery for detached command-template runs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, join } from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as Paths from "./paths.ts";

export type RunObservedStatus =
  | "running"
  | "done"
  | "failed"
  | "exited"
  | "cancelled"
  | "killed";
export type RunOutboxDelivery = "log" | "notify" | "followup";
export type RunOutboxLevel = "info" | "warning" | "error";

export interface RunObservation {
  activeSubagents?: number;
  completed?: number;
  failures?: number;
  ownerId?: string;
  artifacts?: Record<string, string>;
  terminalHandled?: boolean;
  run: string;
  stateDir?: string;
  status: RunObservedStatus;
  updatedAt?: string;
}

export interface RunSummary {
  cancelled: number;
  done: number;
  exited: number;
  failed: number;
  killed: number;
  running: number;
  runningSubagents: number;
  runs: RunObservation[];
  total: number;
}

export interface RunTransition {
  from: RunObservedStatus;
  run: string;
  stateDir?: string;
  artifacts?: Record<string, string>;
  terminalHandled?: boolean;
  to: RunObservedStatus;
}

export interface RunOutboxEvent {
  data?: unknown;
  delivery: RunOutboxDelivery;
  event: string;
  id: string;
  level: RunOutboxLevel;
  run: string;
  stateDir: string;
  summary: string;
  ts: string;
}

export type RunTransitionNotificationType = "info" | "warning" | "error";

const TERMINAL = new Set<RunObservedStatus>([
  "done",
  "failed",
  "exited",
  "cancelled",
  "killed",
]);

function toNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function getProgress(status: Record<string, unknown>): Record<string, unknown> {
  const progress = status.progress;
  return progress && typeof progress === "object"
    ? (progress as Record<string, unknown>)
    : {};
}

function getUpdatedAt(status: Record<string, unknown>): string | undefined {
  const progress = getProgress(status);
  return typeof progress.updatedAt === "string"
    ? progress.updatedAt
    : typeof status.createdAt === "string"
      ? status.createdAt
      : undefined;
}

function observeRun(stateDir: string): RunObservation | undefined {
  try {
    const status = AsyncRuns.getRunStatus(stateDir);
    const progress = getProgress(status);
    const run = typeof status.run === "string" ? status.run : undefined;
    if (!run) return undefined;
    return {
      activeSubagents: toNumber(progress.activeSubagents),
      completed: toNumber(progress.completed),
      failures: Array.isArray(progress.failures)
        ? progress.failures.length
        : undefined,
      ...(typeof status.ownerId === "string"
        ? { ownerId: status.ownerId }
        : {}),
      ...(status.artifacts && typeof status.artifacts === "object" && !Array.isArray(status.artifacts)
        ? { artifacts: status.artifacts as Record<string, string> }
        : {}),
      ...(status.terminal_handled ? { terminalHandled: true } : {}),
      run,
      stateDir,
      status: status.status as RunObservedStatus,
      updatedAt: getUpdatedAt(status),
    };
  } catch {
    return undefined;
  }
}

export function summarizeRuns(
  stateRoot = Paths.getRunStateRoot(),
  ownerId?: string,
): RunSummary {
  if (!existsSync(stateRoot)) {
    return {
      cancelled: 0,
      done: 0,
      exited: 0,
      failed: 0,
      killed: 0,
      running: 0,
      runningSubagents: 0,
      runs: [],
      total: 0,
    };
  }
  const runs = readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => observeRun(join(stateRoot, entry.name)))
    .filter((run): run is RunObservation => Boolean(run))
    .filter((run) => ownerId === undefined || run.ownerId === ownerId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const runningRuns = runs.filter((run) => run.status === "running");
  const running = runningRuns.length;
  const done = runs.filter((run) => run.status === "done").length;
  const exited = runs.filter((run) => run.status === "exited").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const cancelled = runs.filter((run) => run.status === "cancelled").length;
  const killed = runs.filter((run) => run.status === "killed").length;
  const runningSubagents = runningRuns.reduce(
    (sum, run) => sum + Math.max(1, Math.floor(run.activeSubagents ?? 0)),
    0,
  );
  return {
    cancelled,
    done,
    exited,
    failed,
    killed,
    running,
    runningSubagents,
    runs,
    total: runs.length,
  };
}

function readProcFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function getProcPpid(pid: string): string | undefined {
  const stat = readProcFile(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  const close = stat.lastIndexOf(")");
  if (close === -1) return undefined;
  return stat.slice(close + 2).split(" ")[1];
}

function getProcCommand(pid: string): string {
  return (readProcFile(`/proc/${pid}/cmdline`) ?? "").replaceAll("\0", " ");
}

function getRunningRunPids(stateRoot: string, ownerId?: string): Set<string> {
  const pids = new Set<string>();
  for (const run of summarizeRunsWithoutSubagents(stateRoot, ownerId).runs) {
    if (run.status !== "running") continue;
    const status = AsyncRuns.getRunStatus(join(stateRoot, run.run));
    const pid = Number(status.pid || 0);
    if (pid > 0) pids.add(String(pid));
  }
  return pids;
}

function summarizeRunsWithoutSubagents(
  stateRoot: string,
  ownerId?: string,
): Omit<RunSummary, "runningSubagents"> {
  if (!existsSync(stateRoot))
    return {
      cancelled: 0,
      done: 0,
      exited: 0,
      failed: 0,
      killed: 0,
      running: 0,
      runs: [],
      total: 0,
    };
  const runs = readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => observeRun(join(stateRoot, entry.name)))
    .filter((run): run is RunObservation => Boolean(run))
    .filter((run) => ownerId === undefined || run.ownerId === ownerId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const running = runs.filter((run) => run.status === "running").length;
  const done = runs.filter((run) => run.status === "done").length;
  const exited = runs.filter((run) => run.status === "exited").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const cancelled = runs.filter((run) => run.status === "cancelled").length;
  const killed = runs.filter((run) => run.status === "killed").length;
  return {
    cancelled,
    done,
    exited,
    failed,
    killed,
    running,
    runs,
    total: runs.length,
  };
}

export function countRunningSubagents(
  stateRoot = Paths.getRunStateRoot(),
  ownerId?: string,
): number {
  const runPids = getRunningRunPids(stateRoot, ownerId);
  if (runPids.size === 0 || !existsSync("/proc")) return 0;
  const parentByPid = new Map<string, string>();
  const commandByPid = new Map<string, string>();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const ppid = getProcPpid(entry.name);
    if (!ppid) continue;
    parentByPid.set(entry.name, ppid);
    commandByPid.set(entry.name, getProcCommand(entry.name));
  }
  const descendantOfRun = (pid: string): boolean => {
    let current = parentByPid.get(pid);
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (runPids.has(current)) return true;
      seen.add(current);
      current = parentByPid.get(current);
    }
    return false;
  };
  let count = 0;
  for (const [pid, command] of commandByPid.entries()) {
    if (!command.includes("pi -p") && !command.includes("pi\0-p")) continue;
    if (descendantOfRun(pid)) count++;
  }
  return count;
}

export function renderSubagentStatus(
  count: number,
  frame = 0,
): string | undefined {
  if (count <= 0) return undefined;
  if (count === 1) return frame % 2 === 0 ? "▶" : "▷";
  const active = frame % count;
  return Array.from({ length: count }, (_value, index) =>
    index === active ? "▶" : "▷",
  ).join(" ");
}

export function renderRunStatus(
  summary: RunSummary,
  frame = 0,
): string | undefined {
  return renderSubagentStatus(summary.runningSubagents, frame);
}

export function detectRunTransitions(
  previous: Map<string, RunObservedStatus>,
  summary: RunSummary,
): RunTransition[] {
  const transitions: RunTransition[] = [];
  for (const run of summary.runs) {
    const old = previous.get(run.run);
    if (old && old !== run.status && TERMINAL.has(run.status)) {
      transitions.push({
        from: old,
        run: run.run,
        ...(run.stateDir ? { stateDir: run.stateDir } : {}),
        ...(run.artifacts ? { artifacts: run.artifacts } : {}),
        ...(run.terminalHandled ? { terminalHandled: true } : {}),
        to: run.status,
      });
    }
    previous.set(run.run, run.status);
  }
  return transitions;
}

function normalizeOutboxDelivery(value: unknown): RunOutboxDelivery {
  return value === "notify" || value === "followup" ? value : "log";
}

function normalizeOutboxLevel(value: unknown): RunOutboxLevel {
  return value === "warning" || value === "error" ? value : "info";
}

function parseOutboxLine(
  line: string,
  run: RunObservation,
  index: number,
): RunOutboxEvent | undefined {
  if (!run.stateDir) return undefined;
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const event =
      typeof raw.event === "string" && raw.event.trim()
        ? raw.event.trim()
        : "run.event";
    const summary =
      typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.trim()
        : event;
    const ts =
      typeof raw.ts === "string" && raw.ts.trim()
        ? raw.ts.trim()
        : new Date(0).toISOString();
    const id =
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `${run.run}:${index}`;
    return {
      ...(raw.data !== undefined ? { data: raw.data } : {}),
      delivery: normalizeOutboxDelivery(raw.delivery),
      event,
      id,
      level: normalizeOutboxLevel(raw.level),
      run: run.run,
      stateDir: run.stateDir,
      summary,
      ts,
    };
  } catch {
    return undefined;
  }
}

function readOutboxLines(run: RunObservation): string[] {
  if (!run.stateDir) return [];
  const path = join(run.stateDir, "outbox.jsonl");
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").trimEnd();
  return content ? content.split("\n") : [];
}

export function detectRunOutboxEvents(
  previousLineCounts: Map<string, number>,
  summary: RunSummary,
): RunOutboxEvent[] {
  const events: RunOutboxEvent[] = [];
  for (const run of summary.runs) {
    const key = run.stateDir ?? run.run;
    const lines = readOutboxLines(run);
    const previousCount = previousLineCounts.get(key) ?? 0;
    const start = Math.min(previousCount, lines.length);
    for (let index = start; index < lines.length; index += 1) {
      const event = parseOutboxLine(lines[index], run, index);
      if (event) events.push(event);
    }
    previousLineCounts.set(key, lines.length);
  }
  return events;
}

export function getRunOutboxNotificationType(
  event: RunOutboxEvent,
): RunTransitionNotificationType {
  return event.level;
}

export function shouldNotifyRunOutboxEvent(event: RunOutboxEvent): boolean {
  return event.delivery === "notify" || event.delivery === "followup";
}

export function shouldSendRunOutboxFollowUp(event: RunOutboxEvent): boolean {
  return event.delivery === "followup";
}

function commonDirectory(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const split = (path: string): string[] => dirname(path).split("/").filter(Boolean);
  const first = split(paths[0]);
  let length = first.length;
  for (const path of paths.slice(1)) {
    const parts = split(path);
    length = Math.min(length, parts.length);
    for (let index = 0; index < length; index += 1) {
      if (first[index] !== parts[index]) {
        length = index;
        break;
      }
    }
  }
  if (length === 0) return paths[0].startsWith("/") ? "/" : undefined;
  return `${paths[0].startsWith("/") ? "/" : ""}${first.slice(0, length).join("/")}`;
}

function relativeName(base: string | undefined, path: string): string {
  if (!base) return basename(path) || path;
  const name = relative(base, path);
  return name && !name.startsWith("..") ? name : basename(path) || path;
}

function formatPathGroup(label: string, paths: string[]): string {
  const unique = [...new Set(paths.filter(Boolean))].slice(0, 8);
  if (unique.length === 0) return "";
  const base = commonDirectory(unique);
  const names = unique.map((path) => `\`${relativeName(base, path)}\``).join(", ");
  return `\n${label}:\n- Base: ${base ? `\`${base}\`` : "current run"}\n- Files: ${names}`;
}

function formatRunFileList(files: unknown): string {
  if (!Array.isArray(files)) return "";
  return formatPathGroup(
    "Run files",
    files.filter((file): file is string => typeof file === "string"),
  );
}

function formatNamedArtifacts(artifacts: unknown): string {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts))
    return "";
  return formatPathGroup(
    "Artifacts",
    Object.values(artifacts as Record<string, unknown>).filter(
      (path): path is string => typeof path === "string",
    ),
  );
}

function getOutboxField(event: RunOutboxEvent, key: string): unknown {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)[key]
    : undefined;
}

export function formatRunOutboxMessage(event: RunOutboxEvent): string {
  if (event.event === "command.done") return `Run ${event.run}: ${event.summary}`;
  return `Run ${event.run}: ${event.summary}${formatNamedArtifacts(getOutboxField(event, "artifacts"))}${formatRunFileList(getOutboxField(event, "run_files"))}`;
}

export function getRunTransitionNotificationType(
  transition: RunTransition,
): RunTransitionNotificationType {
  if (transition.to === "done" || transition.to === "cancelled") return "info";
  if (transition.to === "killed" || transition.to === "exited")
    return "warning";
  return "error";
}

export function shouldNotifyRunTransition(
  transition: RunTransition,
): boolean {
  if (transition.terminalHandled) return false;
  return (
    transition.to === "done" ||
    transition.to === "failed" ||
    transition.to === "killed" ||
    transition.to === "exited"
  );
}

export function shouldSendRunTransitionFollowUp(
  transition: RunTransition,
): boolean {
  return shouldNotifyRunTransition(transition);
}

function getRunArtifacts(transition: RunTransition): string[] {
  if (!transition.stateDir) return [];
  return [
    join(transition.stateDir, "stdout.log"),
    join(transition.stateDir, "stderr.log"),
    join(transition.stateDir, "result.json"),
    join(transition.stateDir, "events.jsonl"),
    join(transition.stateDir, "outbox.jsonl"),
  ];
}

export function formatRunTransitionMessage(transition: RunTransition): string {
  const artifacts = formatNamedArtifacts(transition.artifacts);
  const runFiles = formatRunFileList(getRunArtifacts(transition));
  if (transition.to === "done")
    return `Run ${transition.run} completed successfully.${artifacts}${runFiles}\nUse inspect target=run:${transition.run} view=status or view=tail if the result needs inspection.`;
  if (transition.to === "failed")
    return `Run ${transition.run} failed.${artifacts}${runFiles}\nUse inspect target=run:${transition.run} view=status or view=tail for details.`;
  if (transition.to === "cancelled")
    return `Run ${transition.run} was cancelled. Use inspect target=run:${transition.run} view=status or view=tail if analysis is needed.`;
  if (transition.to === "killed")
    return `Run ${transition.run} was force-killed. Use inspect target=run:${transition.run} view=status or view=tail if analysis is needed.`;
  if (transition.to === "exited")
    return `Run ${transition.run} exited before writing a result. Use inspect target=run:${transition.run} view=status or view=tail if analysis is needed.`;
  return `Run ${transition.run} finished with status ${transition.to}. Use inspect target=run:${transition.run} view=status or view=tail if analysis is needed.`;
}
