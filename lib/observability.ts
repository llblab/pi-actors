/**
 * Async run observability helpers
 * Zones: async runtime, ambient UI, diagnostics
 * Owns ambient summaries, terminal events, and run outbox delivery for detached command-template runs
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as Paths from "./paths.ts";
import { readJsonlFileResilient } from "./state-readers.ts";

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
  modelPolicy?: Record<string, unknown>;
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

export interface RunUiObservationState {
  eventLines: Map<string, number>;
  frame: number;
  observed: Map<string, RunObservedStatus>;
  outboxEventIds: Map<string, Set<string>>;
}

export interface RunUiSnapshot {
  outboxEvents: RunOutboxEvent[];
  status: string | undefined;
  summary: RunSummary;
  transitions: RunTransition[];
}

export interface RunUiNotificationSink {
  notify(message: string, level: "info" | "warning" | "error"): void;
  sendSteering(message: {
    customType: string;
    content: string;
    display: true;
    details: unknown;
  }): void;
}

export function createRunUiObservationState(): RunUiObservationState {
  return {
    eventLines: new Map<string, number>(),
    frame: 0,
    observed: new Map<string, RunObservedStatus>(),
    outboxEventIds: new Map<string, Set<string>>(),
  };
}

export function readRunUiSnapshot(
  state: RunUiObservationState,
  ownerId: string,
): RunUiSnapshot {
  const summary = summarizeRuns(undefined, ownerId);
  const status = renderRunStatus(summary, state.frame++);
  return {
    outboxEvents: detectRunOutboxEvents(
      state.eventLines,
      summary,
      state.outboxEventIds,
    ),
    status,
    summary,
    transitions: detectRunTransitions(state.observed, summary),
  };
}

export function pruneRunUiObservationState(
  state: RunUiObservationState,
  snapshot: Pick<RunUiSnapshot, "summary" | "transitions">,
): void {
  pruneRunObservationState(
    state.observed,
    state.eventLines,
    snapshot.summary,
    snapshot.transitions.map(
      (transition) => transition.stateDir ?? transition.run,
    ),
    state.outboxEventIds,
  );
}

export function deliverRunTransitionNotifications(
  transitions: RunTransition[],
  sink: RunUiNotificationSink,
): void {
  for (const transition of transitions) {
    if (!shouldNotifyRunTransition(transition)) continue;
    const text = formatRunTransitionMessage(transition);
    sink.notify(text, getRunTransitionNotificationType(transition));
    if (!shouldSendRunTransitionFollowUp(transition)) continue;
    sink.sendSteering({
      customType: "pi-actors-run",
      content: text,
      display: true,
      details: transition,
    });
    if (transition.stateDir) {
      AsyncRuns.markRunTerminalNotificationHandled(
        transition.stateDir,
        transition.to,
      );
    }
  }
}

export function deliverRunOutboxNotifications(
  events: RunOutboxEvent[],
  sink: RunUiNotificationSink,
): void {
  for (const event of events) {
    if (!shouldNotifyRunOutboxEvent(event)) continue;
    const text = formatRunOutboxMessage(event);
    sink.notify(text, getRunOutboxNotificationType(event));
    if (!shouldSendRunOutboxFollowUp(event)) continue;
    sink.sendSteering({
      customType: "pi-actors-run-message",
      content: text,
      display: true,
      details: event,
    });
  }
}

export interface RunRetirementCandidate {
  activeSubagents: number;
  childRuns: number;
  descendantSubagents: number;
  run: string;
  stateDir: string;
  terminalChildRuns: number;
}

export interface RunRetirementExecution {
  action: "stop" | "cancel" | "skip" | "failed";
  error?: string;
  run: string;
  stateDir: string;
}

export interface RunStateWatcher {
  close(): void;
  refresh(): void;
}

export function createRunStateWatcher(input: {
  stateRoot?: string;
  onChange: () => void;
}): RunStateWatcher {
  const stateRoot = input.stateRoot ?? Paths.getRunStateRoot();
  let stateRootWatcher: FSWatcher | undefined;
  const runDirWatchers = new Map<string, FSWatcher>();
  const close = (): void => {
    stateRootWatcher?.close();
    stateRootWatcher = undefined;
    for (const watcher of runDirWatchers.values()) watcher.close();
    runDirWatchers.clear();
  };
  const watchRunDir = (stateDir: string): void => {
    if (runDirWatchers.has(stateDir) || !existsSync(stateDir)) return;
    try {
      const watcher = watch(stateDir, input.onChange);
      watcher.on("error", () => {
        watcher.close();
        runDirWatchers.delete(stateDir);
      });
      runDirWatchers.set(stateDir, watcher);
    } catch {
      // Watching is best-effort; explicit inspect remains available.
    }
  };
  function refresh(): void {
    if (!existsSync(stateRoot)) return;
    if (!stateRootWatcher) {
      try {
        stateRootWatcher = watch(stateRoot, input.onChange);
        stateRootWatcher.on("error", () => {
          stateRootWatcher?.close();
          stateRootWatcher = undefined;
        });
      } catch {
        // Watching is best-effort; explicit inspect remains available.
      }
    }
    for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      watchRunDir(`${stateRoot}/${entry.name}`);
    }
  }
  return { close, refresh };
}

export interface RunRetirementExecutorOptions {
  attempted?: Set<string>;
  cancelRun: (candidate: RunRetirementCandidate) => Record<string, unknown>;
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  sendStop: (candidate: RunRetirementCandidate) => Promise<unknown>;
}

export interface RunTransition {
  from: RunObservedStatus;
  run: string;
  stateDir?: string;
  artifacts?: Record<string, string>;
  launchSource?: AsyncRuns.AsyncRunLaunchSource;
  modelPolicy?: Record<string, unknown>;
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
const RUN_STATE_DISCOVERY_MAX_DEPTH = 8;

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

function scanRunStateDirs(
  stateRoot: string,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (!existsSync(stateRoot) || seen.has(stateRoot)) return [];
  seen.add(stateRoot);
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
    if (depth + 1 < RUN_STATE_DISCOVERY_MAX_DEPTH)
      result.push(...scanRunStateDirs(child, depth + 1, seen));
  }
  return result;
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
      ...(status.model_policy &&
      typeof status.model_policy === "object" &&
      !Array.isArray(status.model_policy)
        ? { modelPolicy: status.model_policy as Record<string, unknown> }
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
  const runs = (
    AsyncRuns.readRunStateIndex(stateRoot)?.map((entry) => entry.state_dir) ??
    scanRunStateDirs(stateRoot)
  )
    .map((stateDir) => observeRun(stateDir))
    .filter((run): run is RunObservation => Boolean(run))
    .filter((run) => ownerId === undefined || run.ownerId === ownerId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const processSubagentsByRun = countRunningSubagentsByRun(stateRoot, ownerId);
  const runsWithDescendants = runs.map((run) => {
    const descendantSubagents = processSubagentsByRun.get(run.run) ?? 0;
    return descendantSubagents > 0 ? { ...run, descendantSubagents } : run;
  });
  const runningRuns = runsWithDescendants.filter(
    (run) => run.status === "running",
  );
  const running = runningRuns.length;
  const done = runsWithDescendants.filter(
    (run) => run.status === "done",
  ).length;
  const exited = runsWithDescendants.filter(
    (run) => run.status === "exited",
  ).length;
  const failed = runsWithDescendants.filter(
    (run) => run.status === "failed",
  ).length;
  const cancelled = runsWithDescendants.filter(
    (run) => run.status === "cancelled",
  ).length;
  const killed = runsWithDescendants.filter(
    (run) => run.status === "killed",
  ).length;
  const progressSubagents = runningRuns.reduce(
    (sum, run) => sum + Math.max(1, Math.floor(run.activeSubagents ?? 0)),
    0,
  );
  const processSubagents = [...processSubagentsByRun.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const runningSubagents = Math.max(
    progressSubagents,
    running + processSubagents,
  );
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

function getRunningRunPidMap(
  stateRoot: string,
  ownerId?: string,
): Map<string, string> {
  const pids = new Map<string, string>();
  for (const run of summarizeRunsWithoutSubagents(stateRoot, ownerId).runs) {
    if (run.status !== "running") continue;
    const status = AsyncRuns.getRunStatus(
      run.stateDir ?? join(stateRoot, run.run),
    );
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
  const runs = (
    AsyncRuns.readRunStateIndex(stateRoot)?.map((entry) => entry.state_dir) ??
    scanRunStateDirs(stateRoot)
  )
    .map((stateDir) => observeRun(stateDir))
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

function isNestedStateDir(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path);
}

export function findRunRetirementCandidates(
  summary: RunSummary,
): RunRetirementCandidate[] {
  return summary.runs
    .map((run) => {
      const activeSubagents = Math.max(0, Math.floor(run.activeSubagents ?? 0));
      const descendantSubagents = Math.max(
        0,
        Math.floor(run.descendantSubagents ?? 0),
      );
      const childRuns = run.stateDir
        ? summary.runs.filter(
            (child) =>
              child.stateDir !== undefined &&
              child.stateDir !== run.stateDir &&
              isNestedStateDir(run.stateDir!, child.stateDir),
          )
        : [];
      const runningChildRuns = childRuns.filter(
        (child) => child.status === "running",
      ).length;
      return {
        activeSubagents,
        childRuns: childRuns.length,
        descendantSubagents,
        ready:
          run.status === "running" &&
          run.retireWhen === "children_terminal" &&
          run.stateDir !== undefined &&
          !run.terminalHandled &&
          activeSubagents + descendantSubagents + runningChildRuns <= 0,
        run,
        terminalChildRuns: childRuns.filter((child) =>
          TERMINAL.has(child.status),
        ).length,
      };
    })
    .filter((item) => item.ready)
    .map((item) => ({
      activeSubagents: item.activeSubagents,
      childRuns: item.childRuns,
      descendantSubagents: item.descendantSubagents,
      run: item.run.run,
      stateDir: item.run.stateDir!,
      terminalChildRuns: item.terminalChildRuns,
    }));
}

export async function executeRunRetirements(
  summary: RunSummary,
  options: RunRetirementExecutorOptions,
): Promise<RunRetirementExecution[]> {
  const results: RunRetirementExecution[] = [];
  for (const candidate of findRunRetirementCandidates(summary)) {
    if (options.attempted?.has(candidate.stateDir)) {
      results.push({
        action: "skip",
        run: candidate.run,
        stateDir: candidate.stateDir,
      });
      continue;
    }
    options.attempted?.add(candidate.stateDir);
    try {
      await options.sendStop(candidate);
      options.notify?.(
        `Retiring actor ${candidate.run} after child runs reached terminal state`,
        "info",
      );
      results.push({
        action: "stop",
        run: candidate.run,
        stateDir: candidate.stateDir,
      });
      continue;
    } catch (error) {
      try {
        const cancelResult = options.cancelRun(candidate);
        const cancelled = Boolean(
          (cancelResult as { cancelled?: unknown }).cancelled,
        );
        options.notify?.(
          cancelled
            ? `Retiring actor ${candidate.run} by cancellation after graceful stop failed`
            : `Actor retirement skipped for ${candidate.run}: ${error instanceof Error ? error.message : String(error)}`,
          cancelled ? "warning" : "error",
        );
        results.push({
          action: cancelled ? "cancel" : "skip",
          ...(cancelled
            ? {}
            : {
                error: error instanceof Error ? error.message : String(error),
              }),
          run: candidate.run,
          stateDir: candidate.stateDir,
        });
      } catch (cancelError) {
        const message =
          cancelError instanceof Error
            ? cancelError.message
            : String(cancelError);
        options.notify?.(
          `Actor retirement failed for ${candidate.run}: ${message}`,
          "error",
        );
        results.push({
          action: "failed",
          error: message,
          run: candidate.run,
          stateDir: candidate.stateDir,
        });
      }
    }
  }
  return results;
}

function runObservationKey(
  run: Pick<RunObservation, "run" | "stateDir">,
): string {
  return run.stateDir ?? run.run;
}

export function detectRunTransitions(
  previous: Map<string, RunObservedStatus>,
  summary: RunSummary,
): RunTransition[] {
  const transitions: RunTransition[] = [];
  for (const run of summary.runs) {
    const key = runObservationKey(run);
    const old = previous.get(key);
    if (!run.terminalHandled && TERMINAL.has(run.status)) {
      transitions.push({
        from: old ?? "running",
        run: run.run,
        ...(run.stateDir ? { stateDir: run.stateDir } : {}),
        ...(run.artifacts ? { artifacts: run.artifacts } : {}),
        ...(run.launchSource ? { launchSource: run.launchSource } : {}),
        ...(run.modelPolicy ? { modelPolicy: run.modelPolicy } : {}),
        ...(run.recipeFile ? { recipeFile: run.recipeFile } : {}),
        ...(run.terminalHandled ? { terminalHandled: true } : {}),
        to: run.status,
        ...(run.tool ? { tool: run.tool } : {}),
      });
    }
    previous.set(key, run.status);
  }
  return transitions;
}

function normalizeOutboxDelivery(value: unknown): RunOutboxDelivery {
  return value === "notify" || value === "followup" ? value : "log";
}

function normalizeOutboxLevel(value: unknown): RunOutboxLevel {
  return value === "warning" || value === "error" ? value : "info";
}

function parseOutboxRecord(
  raw: Record<string, unknown>,
  run: RunObservation,
  index: number,
): RunOutboxEvent | undefined {
  if (!run.stateDir) return undefined;
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
}

function readOutboxRecords(run: RunObservation): Record<string, unknown>[] {
  if (!run.stateDir) return [];
  return readJsonlFileResilient<Record<string, unknown>>(
    join(run.stateDir, "outbox.jsonl"),
  ).records;
}

export function pruneRunObservationState(
  previousStatuses: Map<string, RunObservedStatus>,
  previousLineCounts: Map<string, number>,
  summary: RunSummary,
  terminalRuns: Iterable<string> = [],
  seenEventIds: Map<string, Set<string>> = new Map(),
): void {
  const activeRuns = new Set(summary.runs.map((run) => runObservationKey(run)));
  const terminalRunSet = new Set(terminalRuns);
  const terminalLineKeys = new Set(
    summary.runs
      .filter((run) => terminalRunSet.has(runObservationKey(run)))
      .map((run) => runObservationKey(run)),
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
  for (const key of seenEventIds.keys()) {
    if (terminalLineKeys.has(key) || !activeLineKeys.has(key)) {
      seenEventIds.delete(key);
    }
  }
}

export function detectRunOutboxEvents(
  previousLineCounts: Map<string, number>,
  summary: RunSummary,
  seenEventIds: Map<string, Set<string>> = new Map(),
): RunOutboxEvent[] {
  const events: RunOutboxEvent[] = [];
  for (const run of summary.runs) {
    const key = run.stateDir ?? run.run;
    const records = readOutboxRecords(run);
    const previousCount = previousLineCounts.get(key) ?? 0;
    const start = Math.min(previousCount, records.length);
    const seen = seenEventIds.get(key) ?? new Set<string>();
    for (let index = start; index < records.length; index += 1) {
      const event = parseOutboxRecord(records[index], run, index);
      if (!event || seen.has(event.id)) continue;
      events.push(event);
      seen.add(event.id);
    }
    previousLineCounts.set(key, records.length);
    seenEventIds.set(key, seen);
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

function formatTransitionPolicy(transition: RunTransition): string {
  if (!transition.modelPolicy) return "";
  const axis = (key: "model" | "thinking", label: string): string | undefined => {
    const value = transition.modelPolicy?.[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const source = typeof record.source === "string" ? record.source : "unused";
    if (source === "unused") return undefined;
    const renderedValue =
      typeof record.value === "string" && record.value.trim()
        ? ` (${record.value.trim()})`
        : "";
    return `${label}: ${source}${renderedValue}`;
  };
  const lines = [axis("model", "Model"), axis("thinking", "Thinking")].filter(
    (line): line is string => Boolean(line),
  );
  return lines.length ? `\nPolicy:\n- ${lines.join("\n- ")}` : "";
}

function formatTransitionNextActions(transition: RunTransition): string {
  const actions = [
    `inspect target=run:${transition.run} view=status`,
    transition.to === "done" && Object.keys(transition.artifacts ?? {}).length > 0
      ? `inspect target=run:${transition.run} view=artifacts`
      : `inspect target=run:${transition.run} view=tail`,
    `inspect target=run:${transition.run} view=messages`,
  ].filter(Boolean);
  return `\nNext actions: ${actions.join(" | ")}`;
}

export function formatRunTransitionMessage(transition: RunTransition): string {
  const artifacts = formatNamedArtifacts(transition.artifacts);
  const runFiles = formatRunFileList(getRunArtifacts(transition));
  const persistenceSuggestion = formatRecipePersistenceSuggestion(transition);
  const policy = formatTransitionPolicy(transition);
  const nextActions = formatTransitionNextActions(transition);
  if (transition.to === "done")
    return `Run ${transition.run} completed successfully.${policy}${artifacts}${runFiles}${nextActions}${persistenceSuggestion}`;
  if (transition.to === "failed")
    return `Run ${transition.run} failed.${policy}${artifacts}${runFiles}${nextActions}`;
  if (transition.to === "cancelled")
    return `Run ${transition.run} was cancelled.${policy}${nextActions}`;
  if (transition.to === "killed")
    return `Run ${transition.run} was force-killed.${policy}${nextActions}`;
  if (transition.to === "exited")
    return `Run ${transition.run} exited before writing a result.${policy}${nextActions}`;
  return `Run ${transition.run} finished with status ${transition.to}.${policy}${nextActions}`;
}
