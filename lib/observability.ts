/**
 * Async run observability helpers
 * Zones: async runtime, ambient UI, diagnostics
 * Owns ambient summaries, terminal events, and Trace-attention delivery for detached Runs
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  watch,
  type FSWatcher,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
} from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as Paths from "./paths.ts";
import * as Limits from "./limits.ts";
import * as RunsTrace from "./runs-trace.ts";
import type { RunCompletionBatchMember } from "./run-delivery.ts";
import { readRunCompletionTextSource, readRunResultArtifactInventory, readRunResultDiagnosticOutcome } from "./runs-context-exports.ts";
import type { RunPrimaryTextBinding } from "./runs-outcomes.ts";
import { readJsonlFileResilient } from "./state-readers.ts";
import { Document } from "yaml";
import { formatLiteralBlock, formatMarkdownField } from "./tools-response.ts";

export type RunObservedStatus =
  | "running"
  | "done"
  | "failed"
  | "exited"
  | "cancelled"
  | "killed";
export type RunTraceAttention = "log" | "notify" | "followup" | "steer";
export type RunTraceLevel = "info" | "warning" | "error";

export interface RunObservation {
  activeSubagents?: number;
  completed?: number;
  descendantSubagents?: number;
  deliveryOwnerId?: string;
  deliveryParent?: {
    run: string;
    run_instance_id: string;
    state_dir: string;
  };
  failures?: number;
  ownerId?: string;
  artifacts?: Record<string, string>;
  launchCorrelation?: Record<string, string>;
  launchSource?: AsyncRuns.AsyncRunLaunchSource;
  modelPolicy?: Record<string, unknown>;
  notificationPolicy?: "normal" | "silent";
  recipeFile?: string;
  terminalHandled?: boolean;
  retireWhen?: string;
  run: string;
  runInstanceId?: string;
  semanticResult?: RunTerminalSemanticResult;
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
  attentionEventIds: Map<string, Set<string>>;
  legacyEventLines: Map<string, number>;
  frame: number;
  observed: Map<string, RunObservedStatus>;
}

export interface RunUiSnapshot {
  attentionEvents: RunAttentionEvent[];
  status: string | undefined;
  summary: RunSummary;
  transitions: RunTransition[];
}

export interface RunUiNotificationSink {
  notify(message: string, level: "info" | "warning" | "error"): void;
  sendFollowUp(message: {
    customType: string;
    content: string;
    display: false;
    details: unknown;
  }): void;
}

export function createRunUiObservationState(): RunUiObservationState {
  return {
    attentionEventIds: new Map<string, Set<string>>(),
    legacyEventLines: new Map<string, number>(),
    frame: 0,
    observed: new Map<string, RunObservedStatus>(),
  };
}

export function primeRunAttentionState(
  state: RunUiObservationState, ownerId: string, stateRoot?: string,
): void {
  detectRunAttentionEvents(state.legacyEventLines, summarizeRuns(stateRoot, ownerId),
    state.attentionEventIds, true);
}

export function readRunUiSnapshot(
  state: RunUiObservationState,
  ownerId: string,
  options: { includeAttention?: boolean; stateRoot?: string } = {},
): RunUiSnapshot {
  return projectRunUiSnapshot(state, summarizeRuns(options.stateRoot, ownerId), options.includeAttention);
}

function projectRunUiSnapshot(state: RunUiObservationState, summary: RunSummary, includeAttention?: boolean): RunUiSnapshot {
  const status = renderRunStatus(summary, state.frame++);
  return {
    attentionEvents:
      includeAttention === false
        ? []
        : detectRunAttentionEvents(
            state.legacyEventLines,
            summary,
            state.attentionEventIds,
          ),
    status,
    summary,
    transitions: detectRunTransitions(state.observed, summary),
  };
}

/** Observe every Run generation routed to one root coordinator. */
export function readRunDeliverySnapshot(
  state: RunUiObservationState,
  deliveryOwnerId: string,
  stateRoot?: string,
): RunUiSnapshot {
  return projectRunDeliverySnapshot(state, summarizeRuns(stateRoot, undefined, deliveryOwnerId));
}

function projectRunDeliverySnapshot(state: RunUiObservationState, summary: RunSummary): RunUiSnapshot {
  return {
    attentionEvents: [],
    status: undefined,
    summary,
    transitions: detectRunTransitions(state.observed, summary),
  };
}

/** Same-pass display/candidate projections only. No frame escapes or native fact is reused by flush/publication/control. */
export function readRunUiAndDeliverySnapshots(
  uiState: RunUiObservationState, deliveryState: RunUiObservationState, ownerId: string,
  stateRoot = Paths.getRunStateRoot(),
): { ui: RunUiSnapshot; delivery: RunUiSnapshot } {
  const runs = readRunObservations(stateRoot);
  return {
    ui: projectRunUiSnapshot(uiState, summarizeRunObservations(runs, stateRoot, ownerId)),
    delivery: projectRunDeliverySnapshot(deliveryState, summarizeRunObservations(runs, stateRoot, undefined, ownerId)),
  };
}

export function pruneRunUiObservationState(
  state: RunUiObservationState,
  snapshot: Pick<RunUiSnapshot, "summary" | "transitions">,
): void {
  pruneRunObservationState(
    state.observed,
    state.legacyEventLines,
    snapshot.summary,
    snapshot.transitions.map(
      (transition) => transition.stateDir ?? transition.run,
    ),
    state.attentionEventIds,
  );
}

export function deliverRunAttentionNotifications(
  events: RunAttentionEvent[],
  sink: RunUiNotificationSink,
): void {
  for (const event of events) {
    if (!shouldNotifyRunAttentionEvent(event)) continue;
    const text = formatRunAttentionMessage(event);
    sink.notify(text, getRunAttentionNotificationType(event));
    if (!shouldSendRunAttentionFollowUp(event)) continue;
    sink.sendFollowUp({
      customType: "pi-actors-run-trace",
      content: text,
      display: false,
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

export type RunStateWatcherDiagnosticCode =
  | "attach_failed"
  | "error"
  | "removed"
  | "rearmed";

export interface RunStateWatcherDiagnostic {
  code: RunStateWatcherDiagnosticCode;
  id: number;
  message: string;
  path: string;
  scope: "root" | "run";
  ts: string;
}

export interface RunStateWatcher {
  close(): void;
  getDiagnostics(): RunStateWatcherDiagnostic[];
  refresh(): void;
}

const RUN_WATCHER_DIAGNOSTIC_LIMIT = 32;

export function createRunStateWatcher(input: {
  exists?: (path: string) => boolean;
  listDirectories?: (path: string) => string[];
  onChange: () => void;
  stateRoot?: string;
  watchPath?: (path: string, onChange: () => void) => FSWatcher;
}): RunStateWatcher {
  const stateRoot = input.stateRoot ?? Paths.getRunStateRoot();
  const pathExists = input.exists ?? existsSync;
  const listDirectories =
    input.listDirectories ??
    ((path: string) =>
      readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(path, entry.name)));
  const watchPath = input.watchPath ?? ((path, onChange) => watch(path, onChange));
  let diagnosticId = 0;
  let rootDegraded = false;
  let stateRootWatcher: FSWatcher | undefined;
  const degradedRunDirs = new Set<string>();
  const diagnostics: RunStateWatcherDiagnostic[] = [];
  const lastDiagnosticSignatures = new Map<string, string>();
  const runDirWatchers = new Map<string, FSWatcher>();
  const record = (
    code: RunStateWatcherDiagnosticCode,
    scope: "root" | "run",
    path: string,
    error?: unknown,
  ): void => {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    const signature = `${code}${detail}`;
    const signatureKey = `${scope}:${path}`;
    if (lastDiagnosticSignatures.get(signatureKey) === signature) return;
    lastDiagnosticSignatures.set(signatureKey, signature);
    const recovery =
      code === "rearmed"
        ? "; terminal watch acceleration restored"
        : "; terminal reconciliation remains active and watcher rearm will retry";
    diagnostics.push({
      code,
      id: ++diagnosticId,
      message: [formatMarkdownField("watcher", code), formatMarkdownField("scope", scope),
        formatMarkdownField("path", formatLiteralBlock(path)),
        ...(detail ? [formatMarkdownField("diagnostic", detail.slice(2))] : []),
        formatMarkdownField("recovery", recovery.slice(2))].join("\n"),
      path,
      scope,
      ts: new Date().toISOString(),
    });
    if (diagnostics.length > RUN_WATCHER_DIAGNOSTIC_LIMIT) diagnostics.shift();
  };
  const removeRunWatcher = (
    stateDir: string,
    watcher: FSWatcher,
    options: { degraded?: boolean; error?: unknown } = {},
  ): void => {
    if (runDirWatchers.get(stateDir) !== watcher) return;
    watcher.close();
    runDirWatchers.delete(stateDir);
    if (options.degraded === false) {
      degradedRunDirs.delete(stateDir);
      lastDiagnosticSignatures.delete(`run:${stateDir}`);
      return;
    }
    degradedRunDirs.add(stateDir);
    if (options.error) record("error", "run", stateDir, options.error);
    record("removed", "run", stateDir);
  };
  const close = (): void => {
    stateRootWatcher?.close();
    stateRootWatcher = undefined;
    for (const watcher of runDirWatchers.values()) watcher.close();
    runDirWatchers.clear();
  };
  const watchRunDir = (stateDir: string): void => {
    if (runDirWatchers.has(stateDir) || !pathExists(stateDir)) return;
    try {
      const watcher = watchPath(stateDir, input.onChange);
      watcher.on("error", (error) =>
        removeRunWatcher(stateDir, watcher, { error }),
      );
      runDirWatchers.set(stateDir, watcher);
      if (degradedRunDirs.delete(stateDir)) record("rearmed", "run", stateDir);
    } catch (error) {
      degradedRunDirs.add(stateDir);
      record("attach_failed", "run", stateDir, error);
    }
  };
  function refresh(): void {
    if (!pathExists(stateRoot)) return;
    if (!stateRootWatcher) {
      try {
        const watcher = watchPath(stateRoot, input.onChange);
        stateRootWatcher = watcher;
        watcher.on("error", (error) => {
          if (stateRootWatcher !== watcher) return;
          watcher.close();
          stateRootWatcher = undefined;
          rootDegraded = true;
          record("error", "root", stateRoot, error);
          record("removed", "root", stateRoot);
        });
        if (rootDegraded) {
          rootDegraded = false;
          record("rearmed", "root", stateRoot);
        }
      } catch (error) {
        rootDegraded = true;
        record("attach_failed", "root", stateRoot, error);
      }
    }
    let stateDirs: string[];
    try {
      stateDirs = listDirectories(stateRoot);
    } catch (error) {
      record("attach_failed", "root", stateRoot, error);
      return;
    }
    const present = new Set(stateDirs);
    for (const [stateDir, watcher] of runDirWatchers) {
      if (present.has(stateDir) && pathExists(stateDir)) continue;
      removeRunWatcher(stateDir, watcher, { degraded: false });
    }
    for (const stateDir of stateDirs) watchRunDir(stateDir);
  }
  return {
    close,
    getDiagnostics: () => [...diagnostics],
    refresh,
  };
}

export interface RunTerminalReconciliationLoop {
  close(): void;
  reconcileNow(): void;
  start(): void;
}

export function createRunTerminalReconciliationLoop(input: {
  intervalMs?: number;
  onError?: (error: unknown) => void;
  reconcile: () => void;
  refreshWatcher: () => void;
}): RunTerminalReconciliationLoop {
  const intervalMs = input.intervalMs ?? 10_000;
  let interval: NodeJS.Timeout | undefined;
  const reconcileNow = (): void => {
    try {
      input.refreshWatcher();
      input.reconcile();
    } catch (error) {
      try {
        input.onError?.(error);
      } catch {
        /* reconciliation callbacks must never escape into the host event loop */
      }
    }
  };
  const close = (): void => {
    if (interval) clearInterval(interval);
    interval = undefined;
  };
  const start = (): void => {
    close();
    interval = setInterval(reconcileNow, intervalMs);
    interval.unref?.();
  };
  return { close, reconcileNow, start };
}

export interface RunRetirementExecutorOptions {
  attempted?: Set<string>;
  cancelRun: (candidate: RunRetirementCandidate) => Record<string, unknown>;
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  sendStop: (candidate: RunRetirementCandidate) => Promise<unknown>;
}

export interface RunTransition {
  ownerId?: string;
  deliveryParent?: {
    run: string;
    run_instance_id: string;
    state_dir: string;
  };
  from: RunObservedStatus;
  run: string;
  runInstanceId?: string;
  stateDir?: string;
  terminalAt?: string;
  artifacts?: Record<string, string>;
  launchCorrelation?: Record<string, string>;
  launchSource?: AsyncRuns.AsyncRunLaunchSource;
  modelPolicy?: Record<string, unknown>;
  recipeFile?: string;
  terminalHandled?: boolean;
  to: RunObservedStatus;
  tool?: string;
  semanticResult?: RunTerminalSemanticResult;
}

export interface RunTerminalSemanticResult {
  body?: string;
  /** Marker hints only; source admission belongs to eligible packet collection, never ambient observation. */
  hasPrimaryText?: true;
  hasArtifactInventory?: true;
  hasResultDiagnostics?: true;
  correlationId?: string;
  metadata: Record<string, unknown>;
  summary: string;
  synthesized: boolean;
  type: string;
}

export interface RunAttentionEvent {
  body?: unknown;
  data?: unknown;
  attention: RunTraceAttention;
  id: string;
  kind: string;
  level: RunTraceLevel;
  metadata?: Record<string, unknown>;
  run: string;
  runInstanceId?: string;
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
  const result = status.result &&
    typeof status.result === "object" &&
    !Array.isArray(status.result)
    ? status.result as Record<string, unknown>
    : {};
  return typeof result.completed_at === "string"
    ? result.completed_at
    : typeof progress.updatedAt === "string"
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

const TERMINAL_RESULT_BYTES = 8 * 1024;
const TERMINAL_RESULT_CHARS = 4_000;

function readBoundedStart(path: string): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = Math.min(fstatSync(fd).size, TERMINAL_RESULT_BYTES);
    const buffer = Buffer.alloc(size);
    const bytes = readSync(fd, buffer, 0, size, 0);
    const text = buffer.subarray(0, bytes).toString("utf8").trim();
    return text.length > TERMINAL_RESULT_CHARS
      ? `${text.slice(0, TERMINAL_RESULT_CHARS - 1)}…`
      : text;
  } finally {
    closeSync(fd);
  }
}

function semanticBodyFromStdout(stateDir: string): string | undefined {
  const text = readBoundedStart(join(stateDir, "stdout.log"));
  if (!text) return undefined;
  const withoutMarker = text.replace(/^ACTOR_REVIEW_RESULT\s*(?:\r?\n)?/, "").trim();
  return withoutMarker || undefined;
}

function terminalSemanticResult(
  status: Record<string, unknown>,
  stateDir: string,
  observedStatus: RunObservedStatus,
): RunTerminalSemanticResult {
  const correlation = status.launch_correlation &&
    typeof status.launch_correlation === "object" &&
    !Array.isArray(status.launch_correlation)
    ? status.launch_correlation as Record<string, unknown>
    : {};
  const correlationId =
    typeof correlation.correlation_id === "string"
      ? correlation.correlation_id
      : typeof correlation.tool_call_id === "string"
        ? correlation.tool_call_id
        : undefined;
  const reviewCompleted = false;
  const result = status.result &&
    typeof status.result === "object" &&
    !Array.isArray(status.result)
    ? status.result as Record<string, unknown>
    : {};
  const type = reviewCompleted
    ? "review.completed"
    : observedStatus === "done" ? "run.done" : "run.failed";
  const hasPrimary = Object.hasOwn(result, "primary_text_protocol");
  const hasDiagnostics = Object.hasOwn(result, "result_diagnostics_protocol");
  const stdoutBody = !hasPrimary && !hasDiagnostics && observedStatus === "done" ? semanticBodyFromStdout(stateDir) : undefined;
  return {
    ...(hasPrimary ? { hasPrimaryText: true as const } : {}),
    ...(Object.hasOwn(result, "artifact_inventory_protocol") ? { hasArtifactInventory: true as const } : {}),
    ...(hasDiagnostics ? { hasResultDiagnostics: true as const } : {}),
    ...(!hasDiagnostics && (stdoutBody || typeof result.error === "string") ? { body: stdoutBody ?? result.error as string } : {}),
    ...(correlationId ? { correlationId } : {}),
    metadata: {
      ...(status.transport_context &&
      typeof status.transport_context === "object" &&
      !Array.isArray(status.transport_context)
        ? {
            transport_context: status.transport_context as Record<string, unknown>,
          } : {}),
      run: String(status.run ?? ""), status: observedStatus,
    },
    summary: reviewCompleted ? "Review completed." :
      observedStatus === "done" ? "Run completed." : `Run ${observedStatus}.`,
    synthesized: true,
    type,
  };
}

function observeRun(stateDir: string, observed?: Record<string, unknown>): RunObservation | undefined {
  try {
    const status = observed ?? AsyncRuns.getRunStatus(stateDir);
    const progress = getProgress(status);
    const run = typeof status.run === "string" ? status.run : undefined;
    if (!run) return undefined;
    const observedStatus = status.status as RunObservedStatus;
    return {
      activeSubagents: toNumber(progress.activeSubagents),
      completed: toNumber(progress.completed),
      ...(status.launch_correlation &&
      typeof status.launch_correlation === "object" &&
      !Array.isArray(status.launch_correlation)
        ? { launchCorrelation: status.launch_correlation as Record<string, string> }
        : {}),
      failures: Array.isArray(progress.failures)
        ? progress.failures.length
        : undefined,
      ...(typeof status.delivery_owner_id === "string"
        ? { deliveryOwnerId: status.delivery_owner_id }
        : {}),
      ...(status.delivery_parent &&
      typeof status.delivery_parent === "object" &&
      !Array.isArray(status.delivery_parent) &&
      typeof (status.delivery_parent as Record<string, unknown>).run === "string" &&
      typeof (status.delivery_parent as Record<string, unknown>).run_instance_id === "string" &&
      typeof (status.delivery_parent as Record<string, unknown>).state_dir === "string"
        ? {
            deliveryParent: status.delivery_parent as {
              run: string;
              run_instance_id: string;
              state_dir: string;
            },
          }
        : {}),
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
      ...(status.notification_policy === "silent"
        ? { notificationPolicy: "silent" as const }
        : {}),
      ...(typeof status.recipe_file === "string"
        ? { recipeFile: status.recipe_file }
        : {}),
      ...(typeof status.run_instance_id === "string"
        ? { runInstanceId: status.run_instance_id }
        : {}),
      ...(status.terminal_handled ? { terminalHandled: true } : {}),
      ...(typeof status.retire_when === "string"
        ? { retireWhen: status.retire_when }
        : {}),
      ...(TERMINAL.has(observedStatus)
        ? { semanticResult: terminalSemanticResult(status, stateDir, observedStatus) }
        : {}),
      run,
      stateDir,
      status: observedStatus,
      ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
      updatedAt: getUpdatedAt(status),
    };
  } catch {
    return undefined;
  }
}

function readRunObservations(stateRoot: string): RunObservation[] | undefined {
  if (!existsSync(stateRoot)) return undefined;
  const directories = AsyncRuns.readRunStateIndex(stateRoot)?.map((entry) => entry.state_dir) ?? scanRunStateDirs(stateRoot);
  return AsyncRuns.getRunInventoryStatuses(directories)
    .map((status, index) => status ? observeRun(directories[index], status) : undefined)
    .filter((run): run is RunObservation => Boolean(run));
}

export function summarizeRuns(
  stateRoot = Paths.getRunStateRoot(),
  ownerId?: string,
  deliveryOwnerId?: string,
): RunSummary {
  return summarizeRunObservations(readRunObservations(stateRoot), stateRoot, ownerId, deliveryOwnerId);
}

function summarizeRunObservations(
  observations: RunObservation[] | undefined, stateRoot: string, ownerId?: string, deliveryOwnerId?: string,
): RunSummary {
  if (observations === undefined) {
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
  const runs = observations
    .filter((run) => deliveryOwnerId !== undefined
      ? run.deliveryOwnerId === deliveryOwnerId ||
        (run.deliveryOwnerId === undefined && run.ownerId === deliveryOwnerId)
      : ownerId === undefined || run.ownerId === ownerId)
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
  // This backend cannot contribute without procfs; do not pay for native Run
  // identity probes (notably synchronous Windows/macOS probes) just to discard them.
  if (!existsSync("/proc")) return new Map();
  const runPidMap = getRunningRunPidMap(stateRoot, ownerId);
  if (runPidMap.size === 0) return new Map();
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

function formatRunRetirementNotice(run: string, action: RunRetirementExecution["action"], message = ""): string {
  const fields = [formatMarkdownField("run", run.startsWith("run:") ? run.slice(4) : run), formatMarkdownField("retirement", action)];
  if (action === "stop") fields.push(formatMarkdownField("result", "request returned"), formatMarkdownField("reason", "child runs reached terminal state"));
  else if (action === "cancel") fields.push(formatMarkdownField("result", "cancellation reported"), formatMarkdownField("reason", "stop path failed"));
  else fields.push(formatMarkdownField("result", action === "skip" ? "skipped" : "failed"), formatMarkdownField("diagnostic", message));
  fields.push(formatMarkdownField("closure", "unconfirmed"));
  return fields.join("\n");
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
        formatRunRetirementNotice(candidate.run, "stop"),
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
            ? formatRunRetirementNotice(candidate.run, "cancel")
            : formatRunRetirementNotice(candidate.run, "skip", `${error instanceof Error ? error.message : String(error)}`),
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
          formatRunRetirementNotice(candidate.run, "failed", `${message}`),
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
    if (
      run.notificationPolicy !== "silent" &&
      !run.terminalHandled &&
      TERMINAL.has(run.status)
    ) {
      transitions.push({
        from: old ?? "running",
        run: run.run,
        ...(run.ownerId === undefined ? {} : { ownerId: run.ownerId }),
        ...(run.deliveryParent ? { deliveryParent: run.deliveryParent } : {}),
        ...(run.stateDir ? { stateDir: run.stateDir } : {}),
        ...(run.artifacts ? { artifacts: run.artifacts } : {}),
        ...(run.launchCorrelation ? { launchCorrelation: run.launchCorrelation } : {}),
        ...(run.launchSource ? { launchSource: run.launchSource } : {}),
        ...(run.modelPolicy ? { modelPolicy: run.modelPolicy } : {}),
        ...(run.recipeFile ? { recipeFile: run.recipeFile } : {}),
        ...(run.runInstanceId ? { runInstanceId: run.runInstanceId } : {}),
        ...(run.semanticResult ? { semanticResult: run.semanticResult } : {}),
        ...(run.terminalHandled ? { terminalHandled: true } : {}),
        ...(run.updatedAt ? { terminalAt: run.updatedAt } : {}),
        to: run.status,
        ...(run.tool ? { tool: run.tool } : {}),
      });
    }
    previous.set(key, run.status);
  }
  return transitions;
}

function normalizeTraceAttention(value: unknown): RunTraceAttention {
  return value === "notify" || value === "followup" ? value : "log";
}

function normalizeTraceLevel(value: unknown): RunTraceLevel {
  return value === "warning" || value === "error" ? value : "info";
}

function parseAttentionRecord(
  raw: Record<string, unknown>,
  run: RunObservation,
  index: number,
): RunAttentionEvent | undefined {
  if (!run.stateDir) return undefined;
  const event =
    typeof raw.kind === "string" && raw.kind.trim()
      ? raw.kind.trim()
      : typeof raw.event === "string" && raw.event.trim()
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
    attention:
      raw.attention === "notify" ||
      raw.attention === "followup" ||
      raw.attention === "steer"
        ? raw.attention
        : normalizeTraceAttention(raw.delivery),
    id,
    kind: event,
    level: normalizeTraceLevel(raw.level),
    ...(raw.metadata &&
    typeof raw.metadata === "object" &&
    !Array.isArray(raw.metadata)
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
    run: run.run,
    ...(run.runInstanceId ? { runInstanceId: run.runInstanceId } : {}),
    stateDir: run.stateDir,
    summary,
    ts,
  };
}

function readTraceAttentionRecords(run: RunObservation): {
  canonical: boolean; records: Record<string, unknown>[];
} {
  if (!run.stateDir) return { canonical: true, records: [] };
  if (existsSync(join(run.stateDir, "trace.jsonl"))) return {
    canonical: true,
    records: RunsTrace.readRunTraceJournal(run.stateDir).events.map(
      ({ event }) => event as unknown as Record<string, unknown>),
  };
  return { canonical: false, records: readJsonlFileResilient<Record<string, unknown>>(
    join(run.stateDir, "outbox.jsonl")).records };
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
  const activeLineKeys = new Set(summary.runs.map((run) => run.stateDir ?? run.run));
  for (const run of terminalRunSet) previousStatuses.delete(run);
  for (const run of previousStatuses.keys())
    if (!activeRuns.has(run)) previousStatuses.delete(run);
  for (const key of previousLineCounts.keys())
    if (!activeLineKeys.has(key)) previousLineCounts.delete(key);
  for (const key of seenEventIds.keys())
    if (!activeLineKeys.has(key)) seenEventIds.delete(key);
}

export function detectRunAttentionEvents(
  legacyLineCounts: Map<string, number>, summary: RunSummary,
  seenEventIds: Map<string, Set<string>> = new Map(), prime = false,
): RunAttentionEvent[] {
  const events: RunAttentionEvent[] = [];
  for (const run of summary.runs) {
    const key = run.stateDir ?? run.run;
    const read = readTraceAttentionRecords(run);
    const retained = new Set<string>();
    const seen = seenEventIds.get(key) ?? new Set<string>();
    const presentedSteerIds = new Set(read.records.flatMap((record) => {
      if (
        record.kind !== "delivery.steer_presented" ||
        !record.data ||
        typeof record.data !== "object" ||
        Array.isArray(record.data)
      ) return [];
      const eventId = (record.data as Record<string, unknown>).event_id;
      return typeof eventId === "string" && eventId ? [eventId] : [];
    }));
    const start = read.canonical ? 0
      : Math.min(legacyLineCounts.get(key) ?? 0, read.records.length);
    for (const [index, record] of read.records.entries()) {
      const event = parseAttentionRecord(record, run, index);
      if (!event || !shouldNotifyRunAttentionEvent(event) ||
          event.kind === "runtime.trace_compacted") continue;
      retained.add(event.id);
      if (isRunSteerAttentionEvent(event) && presentedSteerIds.has(event.id)) {
        seen.add(event.id);
        continue;
      }
      if (run.notificationPolicy === "silent") seen.add(event.id);
      else if (prime) {
        if (!isRunSteerAttentionEvent(event)) seen.add(event.id);
      } else if (index >= start && !seen.has(event.id)) {
        events.push(event); seen.add(event.id);
      }
    }
    seenEventIds.set(key, new Set([...retained].filter((id) => seen.has(id))));
    if (read.canonical) legacyLineCounts.delete(key);
    else legacyLineCounts.set(key, read.records.length);
  }
  return events;
}

export function getRunAttentionNotificationType(
  event: RunAttentionEvent,
): RunTransitionNotificationType {
  return event.level;
}

export function shouldNotifyRunAttentionEvent(event: RunAttentionEvent): boolean {
  if (event.kind === "command.done") return false;
  return event.attention === "notify" ||
    event.attention === "followup" ||
    event.attention === "steer";
}

export function isRunSteerAttentionEvent(event: RunAttentionEvent): boolean {
  return event.kind !== "command.done" && event.attention === "steer";
}

export function retryRunAttentionEvent(
  state: RunUiObservationState,
  event: Pick<RunAttentionEvent, "id" | "stateDir">,
): void {
  state.attentionEventIds.get(event.stateDir)?.delete(event.id);
}

export function shouldSendRunAttentionFollowUp(event: RunAttentionEvent): boolean {
  return event.attention === "followup";
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

function getAttentionDataField(event: RunAttentionEvent, key: string): unknown {
  return event.data &&
    typeof event.data === "object" &&
    !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)[key]
    : undefined;
}

type AttentionPaths = { shown: number; omitted: number; total: number; paths?: string[] };
type AttentionMetadata = {
  run: string; checkpoint: string;
  body?: "unavailable"; body_reason?: string; body_omission?: string; body_basis?: string; body_upstream?: string;
  artifacts?: AttentionPaths; run_files?: AttentionPaths;
};
type AttentionCheckpoint = { metadata: AttentionMetadata; body?: string };

/** Only selected shallow compiler fields enter YAML; the selected body stays opaque and unindented. */
function renderAttention({ metadata, body }: AttentionCheckpoint): string {
  const header = new Document(metadata).toString({ lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).slice(0, -1);
  return body === undefined ? header : `---\n${header}\n---\n${body}`;
}

/** Ordinary selection has no urgent-steer or compact-output byte/depth allowance. */
export function formatRunAttentionMessage(event: RunAttentionEvent): string {
  const checkpoint = formatAXAttentionCheckpoint(event);
  if (event.kind === "command.done") return renderAttention(checkpoint);
  for (const section of attentionPathSections(event)) {
    checkpoint.metadata[section.key] = formatAXAttentionPaths(
      section.paths.slice(0, 8).filter(path => Buffer.from(path).toString("utf8") === path), section.paths.length);
  }
  return renderAttention(checkpoint);
}

function formatAXAttentionCheckpoint(event: RunAttentionEvent): AttentionCheckpoint {
  const run = event.run.startsWith("run:") ? event.run.slice(4) : event.run;
  const metadata: AttentionMetadata = { run, checkpoint: event.summary };
  const checkpoint: AttentionCheckpoint = { metadata };
  if (event.kind === "command.done" || event.body === undefined) return checkpoint;
  const rendered = typeof event.body === "string" ? event.body : JSON.stringify(event.body);
  if (!rendered.trim()) return checkpoint;
  let end = Math.min(rendered.length, 500);
  const last = rendered.charCodeAt(end - 1), next = rendered.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  const preview = rendered.slice(0, end), clipped = end < rendered.length;
  if (Buffer.from(preview).toString("utf8") !== preview) {
    metadata.body = "unavailable";
    metadata.body_reason = "malformed_legacy_preview";
    metadata.body_omission = "[omitted: unknown]";
  } else {
    // Retain the old final body observation and structured-preview ellipsis placement, not its compiler fence.
    checkpoint.body = typeof event.body === "string" ? preview + (clipped ? "…" : "") : preview + (clipped ? "\n…" : "");
    if (clipped) metadata.body_omission = "[omitted: unknown]";
  }
  metadata.body_basis = "Legacy record; original completeness/privacy unproven.";
  metadata.body_upstream = "[omitted: unknown]";
  return checkpoint;
}

function attentionPathSections(event: RunAttentionEvent): Array<{ key: "artifacts" | "run_files"; paths: string[] }> {
  const artifacts = getAttentionDataField(event, "artifacts"), files = getAttentionDataField(event, "run_files");
  if (event.kind === "command.done") return [];
  return [
    { key: "artifacts" as const, values: artifacts && typeof artifacts === "object" && !Array.isArray(artifacts) ? Object.values(artifacts) : [] },
    { key: "run_files" as const, values: Array.isArray(files) ? files : [] },
  ].map(({ key, values }) => ({ key,
    paths: [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))],
  })).filter(section => section.paths.length > 0);
}

function formatAXAttentionPaths(paths: string[], total: number): AttentionPaths {
  return { shown: paths.length, omitted: total - paths.length, total, ...(paths.length ? { paths } : {}) };
}

/** Saved envelope.content is replayed before this formatter; only fresh complete candidates are fitted. */
export function formatRunSteerMessage(event: RunAttentionEvent): string {
  const limit = Limits.RUN_DELIVERY_STEER_MAX_BYTES;
  const checkpoint = formatAXAttentionCheckpoint(event);
  // YAML can escape malformed UTF-16: validate essential source values before serialization or reference reads.
  if ([checkpoint.metadata.run, checkpoint.metadata.checkpoint].some(value => Buffer.from(value).toString("utf8") !== value)
    || Buffer.byteLength(renderAttention(checkpoint)) > limit) {
    throw new Error("Urgent steer checkpoint text exceeds its Unicode/byte delivery limits");
  }
  const sections = attentionPathSections(event);
  if (event.kind === "command.done") return renderAttention(checkpoint);
  const selected: AttentionMetadata = { ...checkpoint.metadata };
  for (const [index, section] of sections.entries()) {
    const reserve: Partial<AttentionMetadata> = {};
    for (const next of sections.slice(index + 1)) reserve[next.key] = formatAXAttentionPaths([], next.paths.length);
    const candidates = section.paths.slice(0, 8).filter(path => Buffer.from(path).toString("utf8") === path);
    let fitted = false;
    for (let shown = candidates.length; shown >= 0; shown -= 1) {
      const group = formatAXAttentionPaths(candidates.slice(0, shown), section.paths.length);
      const candidate = { ...selected, [section.key]: group, ...reserve };
      if (Buffer.byteLength(renderAttention({ ...checkpoint, metadata: candidate })) <= limit) {
        selected[section.key] = group; fitted = true; break;
      }
    }
    if (!fitted) throw new Error("Urgent steer checkpoint and reference coverage exceed the delivery byte limit");
  }
  return renderAttention({ ...checkpoint, metadata: selected });
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

function deliveryGenerationIdentity(input: {
  runInstanceId?: string;
  stateDir?: string;
}): string | undefined {
  return input.stateDir && input.runInstanceId
    ? `${input.stateDir}\0${input.runInstanceId}`
    : undefined;
}

function deliveryTreePosition(
  input: {
    deliveryParent?: RunObservation["deliveryParent"];
    runInstanceId?: string;
    stateDir?: string;
  },
  runsByIdentity: Map<string, RunObservation>,
): { depth: number; rootIdentity: string } | undefined {
  const ownIdentity = deliveryGenerationIdentity(input);
  if (!ownIdentity) return undefined;
  let parent = input.deliveryParent;
  let depth = 0;
  let rootIdentity = ownIdentity;
  const visited = new Set([ownIdentity]);
  while (parent) {
    const identity = `${parent.state_dir}\0${parent.run_instance_id}`;
    if (visited.has(identity)) return undefined;
    visited.add(identity);
    const ancestor = runsByIdentity.get(identity);
    if (!ancestor || ancestor.notificationPolicy === "silent") return undefined;
    depth += 1;
    rootIdentity = identity;
    parent = ancestor.deliveryParent;
  }
  return { depth, rootIdentity };
}

/** Eligibility is metadata-only; ambient candidate checks must not read full primary bodies. */
function readyRunCompletions(transitions: RunTransition[], deliveryRuns: RunObservation[]) {
  const runsByIdentity = new Map(deliveryRuns.flatMap(run => {
    const identity = deliveryGenerationIdentity(run);
    return identity ? [[identity, run] as const] : [];
  }));
  const incompleteRoots = new Set(deliveryRuns.flatMap(run => {
    if (TERMINAL.has(run.status)) return [];
    const position = deliveryTreePosition(run, runsByIdentity);
    return position ? [position.rootIdentity] : [];
  }));
  return transitions.flatMap(transition => {
    if (!shouldNotifyRunTransition(transition) || !transition.stateDir || !transition.runInstanceId ||
      !transition.terminalAt || Number.isNaN(Date.parse(transition.terminalAt))) return [];
    const position = deliveryTreePosition(transition, runsByIdentity);
    if (!position || incompleteRoots.has(position.rootIdentity)) return [];
    return [{ transition: { ...transition, stateDir: transition.stateDir, runInstanceId: transition.runInstanceId,
      terminalAt: transition.terminalAt }, depth: position.depth }];
  });
}

export function hasRunCompletionBatchMembers(transitions: RunTransition[], deliveryRuns: RunObservation[] = []): boolean {
  return readyRunCompletions(transitions, deliveryRuns).length > 0;
}

/** Freeze primary/artifact source observations only for eligible members entering packet admission. */
export function collectRunCompletionBatchMembers(
  transitions: RunTransition[],
  deliveryRuns: RunObservation[] = [],
): RunCompletionBatchMember[] {
  const admitted = readyRunCompletions(transitions, deliveryRuns).map(({ transition, depth }) => {
    const hasPrimary = transition.semanticResult?.hasPrimaryText === true;
    const hasDiagnostics = transition.semanticResult?.hasResultDiagnostics === true;
    const diagnosticReading = hasDiagnostics ? readRunResultDiagnosticOutcome(transition.stateDir, { run: transition.run,
      run_instance_id: transition.runInstanceId, ...(transition.ownerId === undefined ? {} : { ownerId: transition.ownerId }) }, transition.to) : undefined;
    const diagnostics = diagnosticReading?.state === "available" && diagnosticReading.terminal_status === transition.to && diagnosticReading.unchanged()
      ? { ...diagnosticReading.binding, diagnostic_excerpt: diagnosticReading.excerpt } : diagnosticReading
        ? { result_diagnostics: null, result_diagnostics_unavailable: diagnosticReading.state === "unavailable"
          ? diagnosticReading.result_diagnostics_unavailable ?? diagnosticReading.reason : diagnosticReading.terminal_status !== transition.to ? "outcome_mismatch" : "observation_changed" } : undefined;
    const reading = hasPrimary ? readRunCompletionTextSource(transition.stateDir, { run: transition.run,
      run_instance_id: transition.runInstanceId, ...(transition.ownerId === undefined ? {} : { ownerId: transition.ownerId }) }) : undefined;
    const primary: Readonly<RunPrimaryTextBinding> | undefined = !reading ? undefined
      : reading.state === "available" && reading.result_acceptance === "natural" && transition.to === "done" && reading.unchanged()
        ? Object.freeze({ output: reading.original_output ?? reading.output })
        : Object.freeze({ output: null, output_unavailable: reading.state === "unavailable"
          ? reading.output_unavailable ?? reading.reason : reading.result_acceptance !== "natural" ? "nonterminal_capture" : "observation_changed" });
    // Existing unsupported session/composition/failure displays stay diagnostics, never substitute for a lost source.
    const legacyDisplay = !hasPrimary || (reading?.state === "unavailable" && reading.reason === "output_unavailable" &&
      ["not_selected", "selection_not_supported", "primary_not_selected_for_failure"].includes(reading.output_unavailable ?? ""));
    const body = !hasDiagnostics && legacyDisplay ? transition.semanticResult?.body ??
      (hasPrimary && transition.to === "done" ? semanticBodyFromStdout(transition.stateDir) : undefined) : undefined;
    const hasInventory = transition.semanticResult?.hasArtifactInventory === true;
    const inventoryReading = hasInventory ? readRunResultArtifactInventory(transition.stateDir, { run: transition.run,
      run_instance_id: transition.runInstanceId, ...(transition.ownerId === undefined ? {} : { ownerId: transition.ownerId }) }) : undefined;
    const inventory = inventoryReading?.state === "available" && inventoryReading.terminal_status === transition.to && inventoryReading.unchanged() ? inventoryReading.binding : inventoryReading
      ? { artifact_inventory: null, artifact_inventory_unavailable: inventoryReading.state === "unavailable"
        ? inventoryReading.artifact_inventory_unavailable ?? inventoryReading.reason : inventoryReading.terminal_status !== transition.to ? "outcome_mismatch" : "observation_changed" } : undefined;
    const artifactEntries = hasInventory ? [] : Object.entries(transition.artifacts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1])).slice(0, 4);
    const rawSummary = transition.semanticResult?.summary.trim() || `Run ${transition.to}.`;
    return {
      ...(artifactEntries.length > 0 ? { artifacts: Object.fromEntries(artifactEntries) } : {}),
      ...(primary ? { primary_text: primary } : {}),
      ...(primary?.output && reading?.state === "available" ? { completion_text: Object.freeze({ text: reading.output.preview,
        shown_bytes: reading.output.shown_bytes }) } : {}),
      ...inventory,
      ...diagnostics,
      ...(body?.trim() ? { output: body.trim().length > 4_000 ? `${body.trim().slice(0, 3_999)}…` : body.trim() } : {}),
      ...(transition.deliveryParent ? { parent_run: transition.deliveryParent.run,
        parent_run_instance_id: transition.deliveryParent.run_instance_id, parent_state_dir: transition.deliveryParent.state_dir } : {}),
      run: transition.run, run_instance_id: transition.runInstanceId, state_dir: transition.stateDir,
      status: transition.to as RunCompletionBatchMember["status"],
      summary: rawSummary.length > 1_000 ? `${rawSummary.slice(0, 999)}…` : rawSummary,
      terminal_at: transition.terminalAt, tree_depth: depth,
    };
  });
  return admitted.sort((left, right) => left.tree_depth - right.tree_depth ||
    left.terminal_at.localeCompare(right.terminal_at) || left.run.localeCompare(right.run) ||
    left.run_instance_id.localeCompare(right.run_instance_id) || left.state_dir.localeCompare(right.state_dir)
  ).map(({ tree_depth: _depth, ...member }) => member);
}

const TERMINAL_FOLLOW_UP_ARTIFACT_LIMIT = 4;
const TERMINAL_FOLLOW_UP_IDENTIFIER_CHARS = 120;
const TERMINAL_FOLLOW_UP_PATH_CHARS = 320;

function compactTerminalText(value: string, limit: number): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function formatTerminalPath(path: string): string {
  return `\`${compactTerminalText(path, TERMINAL_FOLLOW_UP_PATH_CHARS)}\``;
}

function formatTerminalResultLocations(transition: RunTransition): string {
  const artifactPaths = [...new Set(
    Object.values(transition.artifacts ?? {}).filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    ),
  )];
  if (artifactPaths.length === 0)
    return transition.stateDir ? `\nBase: ${formatTerminalPath(transition.stateDir)}` : "";
  const base = commonDirectory(artifactPaths);
  const artifactPreview = artifactPaths
    .slice(0, TERMINAL_FOLLOW_UP_ARTIFACT_LIMIT)
    .map((path) => formatTerminalPath(base ? relativeName(base, path) : path));
  const omitted = artifactPaths.length - artifactPreview.length;
  const artifacts = `${artifactPreview.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
  return `${base ? `\nBase: ${formatTerminalPath(base)}` : ""}\nArtifacts: ${artifacts}`;
}

export function formatRunTransitionMessage(transition: RunTransition): string {
  const run = compactTerminalText(
    transition.run,
    TERMINAL_FOLLOW_UP_IDENTIFIER_CHARS,
  );
  return `Run: \`${run}\`\nStatus: \`${transition.to}\`${formatTerminalResultLocations(transition)}`;
}
