/**
 * Async run observability helpers
 * Zones: async runtime, ambient UI, diagnostics
 * Owns ambient summaries, terminal events, and run outbox delivery for detached command-template runs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

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
  descendantSubagents?: number;
  failures?: number;
  ownerId?: string;
  artifacts?: Record<string, string>;
  launchSource?: AsyncRuns.AsyncRunLaunchSource;
  recipeFile?: string;
  terminalHandled?: boolean;
  retireWhen?: string;
  run: string;
  tool?: string;
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

export interface RunRetirementCandidate {
  activeSubagents: number;
  descendantSubagents: number;
  run: string;
  stateDir: string;
}

export interface RunTransition {
  from: RunObservedStatus;
  run: string;
  stateDir?: string;
  artifacts?: Record<string, string>;
  launchSource?: AsyncRuns.AsyncRunLaunchSource;
  recipeFile?: string;
  terminalHandled?: boolean;
  to: RunObservedStatus;
  tool?: string;
}

export interface RunOutboxEvent {
  body?: unknown;
  data?: unknown;
  delivery: RunOutboxDelivery;
  event: string;
  id: string;
  level: RunOutboxLevel;
  metadata?: Record<string, unknown>;
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
const PROC_DESCENDANT_SCAN_TTL_MS = 1000;

const procDescendantScanCache = new Map<
  string,
  { counts: Map<string, number>; expiresAt: number; signature: string }
>();

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
      ...(status.artifacts &&
      typeof status.artifacts === "object" &&
      !Array.isArray(status.artifacts)
        ? { artifacts: status.artifacts as Record<string, string> }
        : {}),
      ...(status.launch_source === "spawn" || status.launch_source === "tool"
        ? { launchSource: status.launch_source }
        : {}),
      ...(typeof status.recipe_file === "string"
        ? { recipeFile: status.recipe_file }
        : {}),
      ...(status.terminal_handled ? { terminalHandled: true } : {}),
      ...(typeof status.retire_when === "string"
        ? { retireWhen: status.retire_when }
        : {}),
      run,
      stateDir,
      status: status.status as RunObservedStatus,
      ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
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
  const processSubagentsByRun = countRunningSubagentsByRun(stateRoot, ownerId);
  const runsWithDescendants = runs.map((run) => {
    const descendantSubagents = processSubagentsByRun.get(run.run) ?? 0;
    return descendantSubagents > 0 ? { ...run, descendantSubagents } : run;
  });
  const runningRuns = runsWithDescendants.filter((run) => run.status === "running");
  const running = runningRuns.length;
  const done = runsWithDescendants.filter((run) => run.status === "done").length;
  const exited = runsWithDescendants.filter((run) => run.status === "exited").length;
  const failed = runsWithDescendants.filter((run) => run.status === "failed").length;
  const cancelled = runsWithDescendants.filter((run) => run.status === "cancelled").length;
  const killed = runsWithDescendants.filter((run) => run.status === "killed").length;
  const progressSubagents = runningRuns.reduce(
    (sum, run) => sum + Math.max(1, Math.floor(run.activeSubagents ?? 0)),
    0,
  );
  const processSubagents = [...processSubagentsByRun.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const runningSubagents = Math.max(progressSubagents, running + processSubagents);
  return {
    cancelled,
    done,
    exited,
    failed,
    killed,
    running,
    runningSubagents,
    runs: runsWithDescendants,
    total: runsWithDescendants.length,
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

function getRunningRunPidMap(stateRoot: string, ownerId?: string): Map<string, string> {
  const pids = new Map<string, string>();
  for (const run of summarizeRunsWithoutSubagents(stateRoot, ownerId).runs) {
    if (run.status !== "running") continue;
    const status = AsyncRuns.getRunStatus(join(stateRoot, run.run));
    const pid = Number(status.pid || 0);
    if (pid > 0) pids.set(String(pid), run.run);
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

export function countRunningSubagentsByRun(
  stateRoot = Paths.getRunStateRoot(),
  ownerId?: string,
): Map<string, number> {
  const runPidMap = getRunningRunPidMap(stateRoot, ownerId);
  if (runPidMap.size === 0 || !existsSync("/proc")) return new Map();
  const signature = [...runPidMap.keys()].sort().join(",");
  const cacheKey = `${stateRoot}\0${ownerId ?? ""}`;
  const cached = procDescendantScanCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.signature === signature && cached.expiresAt > now) {
    return new Map(cached.counts);
  }
  const parentByPid = new Map<string, string>();
  const commandByPid = new Map<string, string>();
  let procEntries: import("node:fs").Dirent[];
  try {
    procEntries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return new Map();
  }
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const ppid = getProcPpid(entry.name);
    if (!ppid) continue;
    parentByPid.set(entry.name, ppid);
    commandByPid.set(entry.name, getProcCommand(entry.name));
  }
  const runForDescendant = (pid: string): string | undefined => {
    let current = parentByPid.get(pid);
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      const run = runPidMap.get(current);
      if (run) return run;
      seen.add(current);
      current = parentByPid.get(current);
    }
    return undefined;
  };
  const counts = new Map<string, number>();
  for (const [pid, command] of commandByPid.entries()) {
    if (!command.includes("pi -p") && !command.includes("pi\0-p")) continue;
    const run = runForDescendant(pid);
    if (run) counts.set(run, (counts.get(run) ?? 0) + 1);
  }
  procDescendantScanCache.set(cacheKey, {
    counts,
    expiresAt: now + PROC_DESCENDANT_SCAN_TTL_MS,
    signature,
  });
  return new Map(counts);
}

export function countRunningSubagents(
  stateRoot = Paths.getRunStateRoot(),
  ownerId?: string,
): number {
  return [...countRunningSubagentsByRun(stateRoot, ownerId).values()].reduce(
    (sum, count) => sum + count,
    0,
  );
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

export function findRunRetirementCandidates(
  summary: RunSummary,
): RunRetirementCandidate[] {
  return summary.runs
    .filter((run) => {
      const activeSubagents = Math.max(0, Math.floor(run.activeSubagents ?? 0));
      const descendantSubagents = Math.max(0, Math.floor(run.descendantSubagents ?? 0));
      return (
        run.status === "running" &&
        run.retireWhen === "children_terminal" &&
        run.stateDir &&
        activeSubagents + descendantSubagents <= 0
      );
    })
    .map((run) => ({
      activeSubagents: Math.max(0, Math.floor(run.activeSubagents ?? 0)),
      descendantSubagents: Math.max(0, Math.floor(run.descendantSubagents ?? 0)),
      run: run.run,
      stateDir: run.stateDir!,
    }));
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
        ...(run.launchSource ? { launchSource: run.launchSource } : {}),
        ...(run.recipeFile ? { recipeFile: run.recipeFile } : {}),
        ...(run.terminalHandled ? { terminalHandled: true } : {}),
        to: run.status,
        ...(run.tool ? { tool: run.tool } : {}),
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
      ...(raw.body !== undefined ? { body: raw.body } : {}),
      ...(raw.data !== undefined ? { data: raw.data } : {}),
      delivery: normalizeOutboxDelivery(raw.delivery),
      event,
      id,
      level: normalizeOutboxLevel(raw.level),
      ...(raw.metadata &&
      typeof raw.metadata === "object" &&
      !Array.isArray(raw.metadata)
        ? { metadata: raw.metadata as Record<string, unknown> }
        : {}),
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

export function pruneRunObservationState(
  previousStatuses: Map<string, RunObservedStatus>,
  previousLineCounts: Map<string, number>,
  summary: RunSummary,
  terminalRuns: Iterable<string> = [],
): void {
  const activeRuns = new Set(summary.runs.map((run) => run.run));
  const terminalRunSet = new Set(terminalRuns);
  const terminalLineKeys = new Set(
    summary.runs
      .filter((run) => terminalRunSet.has(run.run))
      .map((run) => run.stateDir ?? run.run),
  );
  const activeLineKeys = new Set(
    summary.runs.map((run) => run.stateDir ?? run.run),
  );
  for (const run of terminalRunSet) previousStatuses.delete(run);
  for (const run of previousStatuses.keys()) {
    if (!activeRuns.has(run)) previousStatuses.delete(run);
  }
  for (const key of previousLineCounts.keys()) {
    if (terminalLineKeys.has(key) || !activeLineKeys.has(key)) {
      previousLineCounts.delete(key);
    }
  }
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
  const split = (path: string): string[] =>
    dirname(path).split("/").filter(Boolean);
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
  const names = unique
    .map((path) => `\`${relativeName(base, path)}\``)
    .join(", ");
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
  return event.data &&
    typeof event.data === "object" &&
    !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)[key]
    : undefined;
}

function formatBodyPreview(body: unknown): string {
  if (body === undefined) return "";
  const rendered = typeof body === "string" ? body : JSON.stringify(body);
  const compact = rendered.replaceAll(/\s+/g, " ").trim();
  if (!compact) return "";
  return `\nBody: ${compact.length > 500 ? `${compact.slice(0, 500)}…` : compact}`;
}

export function formatRunOutboxMessage(event: RunOutboxEvent): string {
  if (event.event === "command.done")
    return `Run ${event.run}: ${event.summary}`;
  return `Run ${event.run}: ${event.summary}${formatBodyPreview(event.body)}${formatNamedArtifacts(getOutboxField(event, "artifacts"))}${formatRunFileList(getOutboxField(event, "run_files"))}`;
}

export function getRunTransitionNotificationType(
  transition: RunTransition,
): RunTransitionNotificationType {
  if (transition.to === "done" || transition.to === "cancelled") return "info";
  if (transition.to === "killed" || transition.to === "exited")
    return "warning";
  return "error";
}

export function shouldNotifyRunTransition(transition: RunTransition): boolean {
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

function isUserRecipeFile(file: string | undefined): boolean {
  if (!file) return false;
  const recipeRoot = resolve(Paths.getRecipeRoot());
  const path = resolve(file);
  return path === recipeRoot || path.startsWith(`${recipeRoot}/`);
}

export function shouldSuggestRecipePersistence(
  transition: RunTransition,
): boolean {
  if (transition.to !== "done") return false;
  if (isUserRecipeFile(transition.recipeFile)) return false;
  return Boolean(transition.recipeFile) || transition.launchSource === "spawn";
}

function formatRecipePersistenceSuggestion(transition: RunTransition): string {
  if (!shouldSuggestRecipePersistence(transition)) return "";
  if (transition.recipeFile) {
    return `\nAgent note: this actor completed successfully from recipe ${transition.recipeFile}. If this recipe fits this machine's recurring workflow, ask the operator whether to copy or register it as a durable tool recipe under ~/.pi/agent/recipes. Do not auto-save without confirmation.`;
  }
  return `\nAgent note: this actor was spawned directly and completed successfully. If this pattern fits this machine's recurring workflow, ask the operator whether to save it as a durable recipe/tool under ~/.pi/agent/recipes with register_tool. Do not auto-save without confirmation.`;
}

export function formatRunTransitionMessage(transition: RunTransition): string {
  const artifacts = formatNamedArtifacts(transition.artifacts);
  const runFiles = formatRunFileList(getRunArtifacts(transition));
  const persistenceSuggestion = formatRecipePersistenceSuggestion(transition);
  if (transition.to === "done")
    return `Run ${transition.run} completed successfully.${artifacts}${runFiles}\nUse inspect target=run:${transition.run} view=status or view=tail if the result needs inspection.${persistenceSuggestion}`;
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
