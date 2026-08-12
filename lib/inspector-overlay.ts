/**
 * Keyboard-driven Actor Inspector overlay for concrete Run instances.
 * Zones: owned actor selection, Recipe/Trace/Control tabs, safe Run Kill confirmation
 * Owns manual kernel navigation; evidence parsing and lifecycle mutation stay in ports.
 */

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";

import * as ActorInspector from "./inspector.ts";
import * as ControlProjection from "./control-projection.ts";
import * as RunsControls from "./runs-controls.ts";
import * as RunControlDelivery from "./runs-control-delivery.ts";
import * as RunsTrace from "./runs-trace.ts";
import * as Limits from "./limits.ts";
import { computeRunControlCapacity } from "./run-evidence-policy.ts";
import * as RuntimeTriage from "./runtime-triage.ts";
import * as TraceProjection from "./trace-projection.ts";

export type ActorInspectorTab = "recipe" | "trace" | "control";

type InspectorFocus = "runs" | "tabs" | "document" | "list" | "detail" | "select";
type SelectorMode = "run" | "source";

export interface ActorInspectorActionResult {
  ok: boolean;
  message: string;
}

export interface ActorInspectorOverlayOptions {
  done: () => void;
  killRun?: (run: string, runInstanceId: string) => ActorInspectorActionResult;
  ownerId: string;
  readRuns?: typeof ActorInspector.readActorInspectorRuns;
  readTrace?: typeof TraceProjection.projectRunTrace;
  stateRoot: string;
  theme: Theme;
  tui: TUI;
}

interface KillConfirmation {
  run: string;
  runInstanceId: string;
  status: string;
}

const TABS: ActorInspectorTab[] = ["recipe", "trace", "control"];
const TRACE_SOURCES: TraceProjection.TraceSourceFilter[] = [
  "all",
  "lifecycle",
  "control",
  "process",
  "agent",
  "artifact",
  "runtime",
];

export class ActorInspectorOverlay {
  private readonly done: () => void;
  private readonly killRun?: (run: string, runInstanceId: string) => ActorInspectorActionResult;
  private readonly ownerId: string;
  private readonly readRuns: typeof ActorInspector.readActorInspectorRuns;
  private readonly readTrace: typeof TraceProjection.projectRunTrace;
  private readonly stateRoot: string;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly refreshTimer: NodeJS.Timeout;
  private contentStripeIndices: number[] = [];
  private documentScroll = 0;
  private detailScroll = 0;
  private feedback?: ActorInspectorActionResult;
  private focus: InspectorFocus = "runs";
  private killConfirmation?: KillConfirmation;
  private killDialogChoice: "cancel" | "kill" = "cancel";
  private rowIndex = 0;
  private runCache?: ActorInspector.ActorInspectorRunItem[];
  private selectedTraceId?: string;
  private runIndex = 0;
  private selectorIndex = 0;
  private selectorMode?: SelectorMode;
  private tabIndex = 0;
  private traceCache?: {
    run: string;
    runInstanceId?: string;
    items: TraceProjection.TraceItem[];
  };
  private traceDetail?: TraceProjection.TraceItem;
  private traceSourceIndex = 0;

  constructor(options: ActorInspectorOverlayOptions) {
    this.done = options.done;
    this.killRun = options.killRun;
    this.ownerId = options.ownerId;
    this.readRuns = options.readRuns ?? ActorInspector.readActorInspectorRuns;
    this.readTrace = options.readTrace ?? TraceProjection.projectRunTrace;
    this.stateRoot = options.stateRoot;
    this.theme = options.theme;
    this.tui = options.tui;
    this.refreshTimer = setInterval(() => {
      this.invalidate();
      this.tui.requestRender();
    }, 1_000);
    this.refreshTimer.unref?.();
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
  }

  invalidate(): void {
    this.runCache = undefined;
    this.traceCache = undefined;
  }

  handleInput(data: string): void {
    const runs = this.runs();
    this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (this.killConfirmation) {
      this.handleKillInput(data);
      this.tui.requestRender();
      return;
    }
    if (data.toLowerCase() === "k") {
      this.requestKill(runs[this.runIndex]);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.focus === "select") {
        this.selectorMode = undefined;
        this.focus = this.tab === "trace" ? "tabs" : "runs";
      } else if (this.focus === "detail") {
        this.selectedTraceId = this.traceDetail?.id;
        this.traceDetail = undefined;
        this.detailScroll = 0;
        this.focus = "list";
      } else if (this.focus === "document" || this.focus === "list") {
        if (this.focus === "list") this.selectedTraceId = undefined;
        this.focus = "tabs";
      } else {
        this.done();
      }
      this.tui.requestRender();
      return;
    }
    if (this.focus === "select") {
      this.handleSelectorInput(data, runs);
      this.tui.requestRender();
      return;
    }
    if (this.focus === "detail") {
      this.handleScrollableInput(data, "detail");
      this.tui.requestRender();
      return;
    }
    if (this.focus === "document") {
      if (matchesKey(data, "left")) this.focus = "tabs";
      else if (matchesKey(data, "up") && this.documentScroll === 0) this.focus = "tabs";
      else this.handleScrollableInput(data, "document");
      this.tui.requestRender();
      return;
    }
    if (this.focus === "runs") {
      if (matchesKey(data, "left")) this.cycleRun(runs, -1);
      else if (matchesKey(data, "right")) this.cycleRun(runs, 1);
      else if (matchesKey(data, "down")) this.focus = "tabs";
      else if (matchesKey(data, "return") && runs.length > 0) {
        this.selectorMode = "run";
        this.selectorIndex = this.runIndex;
        this.focus = "select";
      }
    } else if (this.focus === "tabs") {
      if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
        const direction = matchesKey(data, "left") ? -1 : 1;
        this.tabIndex = (this.tabIndex + direction + TABS.length) % TABS.length;
        this.resetContentPosition();
      } else if (matchesKey(data, "up")) {
        this.focus = "runs";
      } else if (matchesKey(data, "down")) {
        const items = this.tab === "trace" ? this.traceItems(runs[this.runIndex]) : [];
        this.focus = items.length > 0 ? "list" : "document";
        if (this.focus === "list") {
          this.rowIndex = 0;
          this.selectedTraceId = items[0]?.id;
        }
      } else if (matchesKey(data, "return")) {
        if (this.tab === "trace") this.openSourceSelector(runs[this.runIndex]);
        else this.focus = "document";
      }
    } else if (this.focus === "list") {
      const items = this.traceItems(runs[this.runIndex]);
      const count = items.length;
      if (matchesKey(data, "left")) {
        this.selectedTraceId = undefined;
        this.focus = "tabs";
      } else if (matchesKey(data, "up")) {
        if (this.rowIndex === 0) {
          this.selectedTraceId = undefined;
          this.focus = "tabs";
        } else this.rowIndex -= 1;
      } else if (matchesKey(data, "down")) {
        this.rowIndex = Math.min(Math.max(0, count - 1), this.rowIndex + 1);
      } else if (matchesKey(data, "pageUp")) {
        this.rowIndex = Math.max(0, this.rowIndex - this.contentViewportRows());
      } else if (matchesKey(data, "pageDown")) {
        this.rowIndex = Math.min(
          Math.max(0, count - 1),
          this.rowIndex + this.contentViewportRows(),
        );
      } else if (matchesKey(data, "return") || matchesKey(data, "right")) {
        const item = items[this.rowIndex];
        if (item) {
          this.traceDetail = item;
          this.detailScroll = 0;
          this.focus = "detail";
        }
      }
      if (this.focus === "list") this.selectedTraceId = items[this.rowIndex]?.id;
    }
    if (data.toLowerCase() === "f" && this.tab === "trace") {
      this.cycleTraceSource(runs[this.runIndex]);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(24, width);
    const innerWidth = safeWidth - 2;
    const runs = this.runs();
    this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
    const run = runs[this.runIndex];
    if (this.killConfirmation) return this.renderKillDialog(innerWidth);

    const lines = [this.border("╭", " Actor Inspector ", "╮", innerWidth)];
    lines.push(this.row(this.renderRunControl(run, runs.length - this.runIndex), innerWidth));
    lines.push(this.row(this.renderTabs(run), innerWidth));
    lines.push(this.border("├", "", "┤", innerWidth));

    this.contentStripeIndices = [];
    let content = this.renderContent(run, innerWidth);
    if (this.feedback) {
      const color = this.feedback.ok
        ? "success"
        : /^Kill (failed|rejected)/u.test(this.feedback.message)
          ? "error"
          : "warning";
      content = [this.theme.fg(color, ` ${this.feedback.message}`), ...content];
      this.contentStripeIndices = [0, ...this.contentStripeIndices];
    }
    const viewportRows = this.contentViewportRows();
    content = content.slice(0, viewportRows);
    for (let index = 0; index < viewportRows; index += 1) {
      lines.push(this.stripedRow(
        content[index] ?? "",
        innerWidth,
        this.contentStripeIndices[index] ?? index,
      ));
    }
    lines.push(this.footerBorder(this.renderKeyHints(), innerWidth));
    return lines;
  }

  private get tab(): ActorInspectorTab {
    return TABS[this.tabIndex]!;
  }

  private runs(): ActorInspector.ActorInspectorRunItem[] {
    if (this.runCache) return this.runCache;
    this.runCache = this.readRuns(this.stateRoot, this.ownerId);
    return this.runCache;
  }

  private contentViewportRows(): number {
    const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? 30;
    const overlayRows = Math.floor(rows * 0.94);
    return Math.max(4, Math.min(24, overlayRows - 5));
  }

  private resetContentPosition(): void {
    this.documentScroll = 0;
    this.detailScroll = 0;
    this.rowIndex = 0;
    this.selectedTraceId = undefined;
    this.traceDetail = undefined;
  }

  private cycleRun(runs: ActorInspector.ActorInspectorRunItem[], direction: -1 | 1): void {
    if (runs.length === 0) return;
    this.runIndex = (this.runIndex + direction + runs.length) % runs.length;
    this.resetContentPosition();
  }

  private handleScrollableInput(data: string, target: "detail" | "document"): void {
    const key = target === "detail" ? "detailScroll" : "documentScroll";
    if (matchesKey(data, "up")) this[key] = Math.max(0, this[key] - 1);
    else if (matchesKey(data, "down")) this[key] += 1;
    else if (matchesKey(data, "pageUp")) {
      this[key] = Math.max(0, this[key] - this.contentViewportRows());
    } else if (matchesKey(data, "pageDown")) {
      this[key] += this.contentViewportRows();
    } else if (matchesKey(data, "left") && target === "detail") {
      this.selectedTraceId = this.traceDetail?.id;
      this.traceDetail = undefined;
      this.detailScroll = 0;
      this.focus = "list";
    }
  }

  private handleSelectorInput(
    data: string,
    runs: ActorInspector.ActorInspectorRunItem[],
  ): void {
    const run = runs[this.runIndex];
    const options = this.selectorMode === "run"
      ? runs.map((item) => item.run)
      : this.traceSources(run);
    if (matchesKey(data, "up")) this.selectorIndex = Math.max(0, this.selectorIndex - 1);
    else if (matchesKey(data, "down")) {
      this.selectorIndex = Math.min(Math.max(0, options.length - 1), this.selectorIndex + 1);
    } else if (matchesKey(data, "left")) {
      this.focus = this.selectorMode === "run" ? "runs" : "tabs";
      this.selectorMode = undefined;
    } else if (matchesKey(data, "return") || matchesKey(data, "right")) {
      if (this.selectorMode === "run") {
        this.runIndex = this.selectorIndex;
        this.focus = "runs";
      } else {
        this.traceSourceIndex = this.selectorIndex;
        this.focus = "tabs";
      }
      this.selectorMode = undefined;
      this.resetContentPosition();
    }
  }

  private openSourceSelector(run?: ActorInspector.ActorInspectorRunItem): void {
    const sources = this.traceSources(run);
    this.selectorMode = "source";
    this.selectorIndex = Math.min(this.traceSourceIndex, sources.length - 1);
    this.focus = "select";
  }

  private cycleTraceSource(run?: ActorInspector.ActorInspectorRunItem): void {
    const sources = this.traceSources(run);
    this.traceSourceIndex = (this.traceSourceIndex + 1) % sources.length;
    this.resetContentPosition();
  }

  private requestKill(run?: ActorInspector.ActorInspectorRunItem): void {
    this.feedback = undefined;
    if (this.focus !== "runs") {
      this.feedback = { ok: false, message: "Focus Run before using Kill." };
      return;
    }
    if (!run) {
      this.feedback = { ok: false, message: "Kill unavailable: no owned run." };
      return;
    }
    if (!this.killRun) {
      this.feedback = { ok: false, message: "Kill unavailable in this Inspector." };
      return;
    }
    if (run.status !== "running") {
      this.feedback = { ok: false, message: `Kill unavailable: run is ${run.status}.` };
      return;
    }
    if (!run.runInstanceId) {
      this.feedback = { ok: false, message: "Kill unavailable: run generation unavailable." };
      return;
    }
    this.killConfirmation = {
      run: run.run,
      runInstanceId: run.runInstanceId,
      status: run.status,
    };
    this.killDialogChoice = "cancel";
  }

  private handleKillInput(data: string): void {
    const key = data.toLowerCase();
    if (matchesKey(data, "escape") || key === "n") {
      this.feedback = { ok: false, message: "Kill cancelled." };
      this.killConfirmation = undefined;
      this.killDialogChoice = "cancel";
    } else if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.killDialogChoice = this.killDialogChoice === "cancel" ? "kill" : "cancel";
    } else if (key === "y") {
      this.confirmKill();
    } else if (matchesKey(data, "return")) {
      if (this.killDialogChoice === "kill") this.confirmKill();
      else {
        this.feedback = { ok: false, message: "Kill cancelled." };
        this.killConfirmation = undefined;
      }
    }
  }

  private confirmKill(): void {
    const confirmation = this.killConfirmation;
    this.killConfirmation = undefined;
    this.killDialogChoice = "cancel";
    if (!confirmation || !this.killRun) return;
    try {
      const result = this.killRun(confirmation.run, confirmation.runInstanceId);
      this.feedback = result.ok ? undefined : result;
      if (result.ok) this.invalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.feedback = {
        ok: false,
        message: `Kill failed: ${message.replaceAll(/\s+/g, " ").slice(0, 160)}.`,
      };
    }
  }

  private renderKillDialog(innerWidth: number): string[] {
    const confirmation = this.killConfirmation!;
    const cancel = this.killDialogChoice === "cancel"
      ? this.theme.bg("customMessageBg", this.theme.fg("accent", "  Cancel  "))
      : this.theme.fg("muted", "  Cancel  ");
    const kill = this.killDialogChoice === "kill"
      ? this.theme.bg("customMessageBg", this.theme.fg("error", "  Kill actor  "))
      : this.theme.fg("error", "  Kill actor  ");
    const body = [
      "",
      this.theme.fg("error", "Kill this running actor?"),
      "",
      `${this.theme.fg("muted", "Run:")} ${this.theme.fg("accent", `run:${confirmation.run}`)}`,
      `${this.theme.fg("muted", "Current status:")} ${this.theme.fg("warning", confirmation.status)}`,
      "",
      this.theme.fg("text", "This invokes generation-fenced runtime kill."),
      "",
      `${cancel}    ${kill}`,
      "",
    ];
    const lines = [this.border("╭", " Confirm Actor Kill ", "╮", innerWidth)];
    const availableRows = this.contentViewportRows() + 3;
    const topPadding = Math.max(0, Math.floor((availableRows - body.length) / 2));
    const rows = [...Array.from({ length: topPadding }, () => ""), ...body].slice(0, availableRows);
    while (rows.length < availableRows) rows.push("");
    for (const line of rows) lines.push(this.row(this.center(line, innerWidth), innerWidth));
    lines.push(this.footerBorder(this.renderKeyHints(), innerWidth));
    return lines;
  }

  private renderRunControl(
    run: ActorInspector.ActorInspectorRunItem | undefined,
    sequence: number,
  ): string {
    const active = this.focus === "runs" || (this.focus === "select" && this.selectorMode === "run");
    const prefix = active ? this.theme.fg("accent", " ← ") : "   ";
    const suffix = active ? this.theme.fg("accent", " → ") : "   ";
    if (!run) {
      const empty = this.theme.fg("muted", `${prefix}Run: none${suffix}`);
      return this.focus === "runs" ? this.theme.bg("customMessageBg", empty) : empty;
    }
    const value = `${prefix}${this.theme.fg("muted", "Run: ")}${this.theme.fg("text", `#${sequence}`)}  ${this.theme.fg("accent", run.run)}  ${this.theme.fg(this.statusColor(run.status), run.status)}${suffix}`;
    return this.focus === "runs" ? this.theme.bg("customMessageBg", value) : value;
  }

  private renderTabs(run?: ActorInspector.ActorInspectorRunItem): string {
    const source = this.traceSource(run);
    return TABS.map((tab, index) => {
      const base = `${tab[0]!.toUpperCase()}${tab.slice(1)}`;
      const label = tab === "trace" && source !== "all" ? `${base} (${source})` : base;
      const selected = index === this.tabIndex;
      const display = selected && this.focus !== "runs" ? `[ ${label} ]` : `  ${label}  `;
      const value = ` ${display} `;
      if (!selected) return this.theme.fg("muted", value);
      const colored = this.theme.fg("accent", value);
      return this.focus === "tabs" ? this.theme.bg("customMessageBg", colored) : colored;
    }).join(" ");
  }

  private renderContent(
    run: ActorInspector.ActorInspectorRunItem | undefined,
    width: number,
  ): string[] {
    if (!run) return [this.theme.fg("muted", " No owned actor runs")];
    if (this.focus === "select") return this.renderSelector(run);
    if (this.focus === "detail") return this.renderTraceDetail(width);
    if (this.tab === "trace") return this.renderTraceList(run);
    const stateDir = path.join(this.stateRoot, run.run);
    const value = this.tab === "recipe"
      ? ActorInspector.readActorInspectorRecipe(stateDir)
      : this.controlDocument(run, stateDir);
    const projection = this.documentProjection(value, width);
    const maxStart = Math.max(0, projection.lines.length - this.contentViewportRows());
    this.documentScroll = Math.min(this.documentScroll, maxStart);
    this.contentStripeIndices = projection.stripes.slice(
      this.documentScroll,
      this.documentScroll + this.contentViewportRows(),
    );
    return projection.lines.slice(
      this.documentScroll,
      this.documentScroll + this.contentViewportRows(),
    );
  }

  private renderSelector(run: ActorInspector.ActorInspectorRunItem): string[] {
    const options = this.selectorMode === "run"
      ? this.runs().map((item) => `run:${item.run}  ${item.status}`)
      : this.traceSources(run).map((source) => `Trace source: ${source}`);
    const lines = this.renderMenuBox(options, this.selectorIndex);
    this.contentStripeIndices = lines.map(() => 0);
    return lines;
  }

  private renderMenuBox(options: string[], focusedIndex: number): string[] {
    if (options.length === 0) return [this.theme.fg("muted", " No options")];
    const visibleLimit = Math.max(1, Math.min(this.contentViewportRows(), options.length));
    const maxStart = Math.max(0, options.length - visibleLimit);
    const start = Math.max(0, Math.min(focusedIndex - Math.floor(visibleLimit / 2), maxStart));
    const visible = options.slice(start, start + visibleLimit);
    const width = Math.max(8, ...options.map((option) => visibleWidth(option) + 4));
    const border = (left: string, right: string, marker = "") =>
      this.theme.fg("borderAccent", `${left}${marker}${"─".repeat(Math.max(0, width - visibleWidth(marker)))}${right}`);
    return [
      border("╭", "╮", start > 0 ? "↑" : ""),
      ...visible.map((option, offset) => {
        const index = start + offset;
        const row = this.fit(`${index === focusedIndex ? " ▶ " : "   "}${option}`, width);
        const colored = index === focusedIndex ? this.theme.fg("accent", row) : row;
        const styled = index === focusedIndex ? this.theme.bg("customMessageBg", colored) : colored;
        return `${this.theme.fg("borderAccent", "│")}${styled}${this.theme.fg("borderAccent", "│")}`;
      }),
      border("╰", "╯", start + visible.length < options.length ? "↓" : ""),
    ];
  }

  private renderTraceList(run: ActorInspector.ActorInspectorRunItem): string[] {
    const items = this.traceItems(run);
    const summary = RunsTrace.summarizeRunTraceJournal(
      RunsTrace.readRunTraceJournal(path.join(this.stateRoot, run.run)));
    const banner = summary.history_complete ? [] : [this.theme.fg("warning",
      ` ! Trace history incomplete: ${summary.compacted ? `${summary.compactions_total} compaction(s), ` : ""}${summary.dropped_event_count_exact ? summary.dropped_events : "unknown"} dropped event(s), ${summary.dropped_bytes} bytes`)];
    if (items.length === 0) return [...banner, this.theme.fg("muted", " No Trace evidence")];
    if (this.selectedTraceId) {
      const selectedIndex = items.findIndex((item) => item.id === this.selectedTraceId);
      if (selectedIndex >= 0) this.rowIndex = selectedIndex;
      else this.selectedTraceId = undefined;
    }
    this.rowIndex = Math.min(this.rowIndex, items.length - 1);
    if (this.focus === "list" && !this.selectedTraceId) {
      this.selectedTraceId = items[this.rowIndex]?.id;
    }
    const viewportRows = this.contentViewportRows();
    const maxStart = Math.max(0, items.length - viewportRows);
    const start = Math.max(0, Math.min(this.rowIndex - Math.floor(viewportRows / 2), maxStart));
    this.contentStripeIndices = items
      .slice(start, start + viewportRows)
      .map((_item, offset) => start + offset);
    return [...banner, ...items.slice(start, start + viewportRows - banner.length).map((item, offset) => {
      const index = start + offset;
      const detail = item.detail && typeof item.detail === "object"
        ? item.detail as Record<string, unknown>
        : {};
      const marker = item.level === "error"
        ? this.theme.fg("error", "!")
        : detail.attention
          ? this.theme.fg("warning", "A")
          : " ";
      const prefix = this.focus === "list" && index === this.rowIndex
        ? this.theme.fg("accent", " ▶ ")
        : "   ";
      const row = `${prefix}${this.theme.fg("text", `#${items.length - index}`)} ${marker} ${this.theme.fg("muted", item.source)}/${this.theme.fg(item.level === "error" ? "error" : "accent", item.kind)}  ${this.theme.fg("text", item.summary)}`;
      return this.focus === "list" && index === this.rowIndex
        ? this.theme.fg("accent", row)
        : row;
    })];
  }

  private renderTraceDetail(width: number): string[] {
    if (!this.traceDetail) return [this.theme.fg("warning", " Trace row is no longer available")];
    const projection = this.documentProjection(this.traceDetail, width);
    const maxStart = Math.max(0, projection.lines.length - this.contentViewportRows());
    this.detailScroll = Math.min(this.detailScroll, maxStart);
    this.contentStripeIndices = projection.stripes.slice(
      this.detailScroll,
      this.detailScroll + this.contentViewportRows(),
    );
    return projection.lines.slice(
      this.detailScroll,
      this.detailScroll + this.contentViewportRows(),
    );
  }

  private controlDocument(
    run: ActorInspector.ActorInspectorRunItem,
    stateDir: string,
  ): Record<string, unknown> {
    const endpoint = run.runInstanceId
      ? RunControlDelivery.readRunControlEndpoint(stateDir, run.runInstanceId)
      : undefined;
    const meta = this.readRunMeta(stateDir);
    const journal = RunsControls.readRunControlJournalFromStateDir(stateDir);
    const capacity = computeRunControlCapacity(journal.records);
    const stalePending = journal.records.reduce<number>((count, control) => count + Number(Boolean(
      RuntimeTriage.classifyRuntimeControl({ run: run.run,
        runInstanceId: run.runInstanceId, status: run.status }, control, Date.now()).stale)), 0);
    return {
      status: run.status,
      run_instance_id: run.runInstanceId,
      pending: capacity.pending, pending_limit: capacity.limit,
      available: capacity.available, backpressured: capacity.backpressured,
      journal_bytes: (() => { try { return statSync(RunsControls.runControlsFile(stateDir)).size; } catch { return 0; } })(),
      journal_limit: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES,
      stale_pending: stalePending,
      diagnostics: journal.diagnostics.map((item) => item.line === undefined
        ? { reason: "unreadable_control_journal" } : { line: item.line, reason: "invalid_control_json" }),
      actor_actions: Array.isArray(meta.control) ? meta.control : [],
      runtime_actions: run.status === "running" ? ["kill"] : ["archive", "prune"],
      endpoint,
      recent_controls: journal.records.slice(-20).reverse().map((control) =>
        ControlProjection.projectRunControl(control as RunsControls.RunControlRecord)),
    };
  }

  private allTraceItems(run?: ActorInspector.ActorInspectorRunItem): TraceProjection.TraceItem[] {
    if (!run) return [];
    if (
      this.traceCache?.run === run.run &&
      this.traceCache.runInstanceId === run.runInstanceId
    ) {
      return this.traceCache.items;
    }
    const items = this.readTrace(path.join(this.stateRoot, run.run), {
      limit: 100,
      source: "all",
    });
    this.traceCache = { run: run.run, runInstanceId: run.runInstanceId, items };
    return items;
  }

  private traceSources(run?: ActorInspector.ActorInspectorRunItem): TraceProjection.TraceSourceFilter[] {
    const present = new Set(this.allTraceItems(run).map((item) => item.source));
    return TRACE_SOURCES.filter((source) => source === "all" || present.has(source));
  }

  private traceSource(run?: ActorInspector.ActorInspectorRunItem): TraceProjection.TraceSourceFilter {
    const sources = this.traceSources(run);
    this.traceSourceIndex %= sources.length;
    return sources[this.traceSourceIndex] ?? "all";
  }

  private traceItems(run?: ActorInspector.ActorInspectorRunItem): TraceProjection.TraceItem[] {
    const source = this.traceSource(run);
    const items = this.allTraceItems(run);
    return source === "all" ? items : items.filter((item) => item.source === source);
  }

  private readRunMeta(stateDir: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(path.join(stateDir, "run.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private documentProjection(
    value: unknown,
    width: number,
  ): { lines: string[]; stripes: number[] } {
    const sections = value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>).map(([key, item]) =>
          this.labeledDocumentLines(key, item)
        )
      : [this.document(value)];
    const lines: string[] = [];
    const stripes: number[] = [];
    sections.forEach((section, sectionIndex) => {
      const wrapped = this.wrapDocument(section, width);
      lines.push(...wrapped.map((line) => this.styleDocumentLine(line)));
      stripes.push(...wrapped.map(() => sectionIndex));
    });
    return { lines, stripes };
  }

  private inlineDocumentValue(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      if (value.every((item) =>
        (item === null || typeof item !== "object") &&
        !(typeof item === "string" && /[\r\n]/u.test(item))
      )) {
        return `[${value.map((item) => String(item ?? "none")).join(", ")}]`;
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      if (Object.keys(value as Record<string, unknown>).length === 0) return "{}";
    }
    return undefined;
  }

  private labeledDocumentLines(key: string, value: unknown, depth = 0): string[] {
    const inline = this.inlineDocumentValue(value);
    if (inline !== undefined) return [`${"  ".repeat(depth)}${key}: ${inline}`];
    if (value && typeof value === "object") {
      const indent = "  ".repeat(depth);
      const nested = this.document(value, depth);
      return [`${indent}${key}: ${nested[0]!.slice(indent.length)}`, ...nested.slice(1)];
    }
    return this.labeledScalarLines(key, value, depth);
  }

  private labeledScalarLines(key: string, value: unknown, depth = 0): string[] {
    const indent = "  ".repeat(depth);
    const [first = "", ...rest] = String(value ?? "none").split(/\r?\n/u);
    return [
      `${indent}${key}: ${first}`,
      ...rest.map((line) => `${indent}  ${line}`),
    ];
  }

  private document(value: unknown, depth = 0): string[] {
    if (value === null || value === undefined) return [`${"  ".repeat(depth)}none`];
    const inline = this.inlineDocumentValue(value);
    if (inline !== undefined) return [`${"  ".repeat(depth)}${inline}`];
    if (Array.isArray(value)) {
      const indent = "  ".repeat(depth);
      return [
        `${indent}[`,
        ...value.flatMap((item, index) => {
          const marker = `${indent}  - #${index + 1}`;
          const itemInline = this.inlineDocumentValue(item);
          return itemInline !== undefined
            ? [`${marker}: ${itemInline}`]
            : [marker, ...this.document(item, depth + 2)];
        }),
        `${indent}]`,
      ];
    }
    if (typeof value === "object") {
      const indent = "  ".repeat(depth);
      const entries = Object.entries(value as Record<string, unknown>);
      return [
        `${indent}{`,
        ...entries.flatMap(([key, item], index) => {
          const lines = this.labeledDocumentLines(key, item, depth + 1);
          if (index < entries.length - 1) lines[lines.length - 1] += ",";
          return lines;
        }),
        `${indent}}`,
      ];
    }
    return String(value)
      .split(/\r?\n/u)
      .map((line) => `${"  ".repeat(depth)}${line}`);
  }

  private wrapDocument(lines: string[], width: number): string[] {
    return lines.flatMap((line) => {
      const normalized = line.replaceAll("\t", "  ");
      if (visibleWidth(normalized) <= width) return [normalized];
      const leading = normalized.match(/^ */u)?.[0] ?? "";
      const continuation = `${leading}  `;
      const wrapped: string[] = [];
      let rest = normalized.slice(leading.length);
      let prefix = leading;
      while (rest && visibleWidth(`${prefix}${rest}`) > width) {
        const available = Math.max(1, width - visibleWidth(prefix));
        const candidate = this.visiblePrefix(rest, available);
        const minimumBreak = Math.floor(candidate.length * 0.6);
        const preferred = Math.max(
          candidate.lastIndexOf(" "),
          candidate.lastIndexOf("/"),
          candidate.lastIndexOf(","),
        );
        const cut = preferred >= minimumBreak ? preferred + 1 : candidate.length;
        wrapped.push(`${prefix}${rest.slice(0, cut).trimEnd()}`);
        rest = rest.slice(cut).trimStart();
        prefix = continuation;
      }
      if (rest) wrapped.push(`${prefix}${rest}`);
      return wrapped;
    });
  }

  private styleDocumentLine(line: string): string {
    const indent = line.match(/^ */u)?.[0] ?? "";
    const content = line.slice(indent.length);
    if (/^- #\d+$/u.test(content) || content.endsWith(":")) {
      return `${indent}${this.theme.fg("accent", content)}`;
    }
    const labeled = /^([^:]+:)(.*)$/u.exec(content);
    if (labeled) {
      return `${indent}${this.theme.fg("muted", labeled[1])}${this.theme.fg("text", labeled[2])}`;
    }
    return `${indent}${this.theme.fg(content === "none" || content === "[]" ? "muted" : "text", content)}`;
  }

  private visiblePrefix(value: string, width: number): string {
    let consumed = 0;
    let result = "";
    for (const character of value) {
      const characterWidth = visibleWidth(character);
      if (consumed + characterWidth > width) break;
      result += character;
      consumed += characterWidth;
    }
    return result;
  }

  private renderKeyHints(): string {
    const hint = (keys: string, description: string) =>
      `${this.theme.fg("accent", keys)}${this.theme.fg("borderAccent", ` ${description}`)}`;
    const divider = this.theme.fg("borderAccent", " ─ ");
    const hints = (...items: Array<[string, string]>) =>
      items.map(([keys, description]) => hint(keys, description)).join(divider);
    if (this.killConfirmation) {
      return hints(["←→/tab", "choose"], ["enter/y", "confirm"], ["esc/n", "cancel"]);
    }
    if (this.focus === "select") {
      return hints(["↑↓", "option"], ["enter/→", "apply"], ["←/esc", "back"]);
    }
    if (this.focus === "detail") {
      return hints(["↑↓/pgup/pgdn", "scroll"], ["←/esc", "back"]);
    }
    if (this.focus === "document") {
      return hints(["↑↓/pgup/pgdn", "scroll"], ["↑ at top", "tabs"], ["←/esc", "tabs"]);
    }
    if (this.focus === "list") {
      return hints(["↑↓/pgup/pgdn", "row"], ["→/enter", "open"], ["←", "tabs"], ["esc", "close"]);
    }
    if (this.focus === "runs") {
      const items: Array<[string, string]> = [["←→", "run"], ["↓", "tabs"], ["enter", "list"]];
      const run = this.runs()[this.runIndex];
      if (this.killRun && run?.status === "running" && run.runInstanceId) items.push(["k", "kill"]);
      items.push(["esc", "close"]);
      return hints(...items);
    }
    return this.tab === "trace"
      ? hints(["←→", "tabs"], ["↑↓", "focus"], ["enter/f", "source"], ["esc", "close"])
      : hints(["←→", "tabs"], ["↑↓", "focus"], ["enter", "open"], ["esc", "close"]);
  }

  private statusColor(status: string): "error" | "warning" | "success" | "muted" {
    if (status === "failed") return "error";
    if (status === "running") return "warning";
    if (status === "done" || status === "terminal") return "success";
    return "muted";
  }

  private footerBorder(hints: string, width: number): string {
    const prefix = " ";
    const suffix = " ─";
    const content = truncateToWidth(
      hints,
      Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix)),
      "",
    );
    const fill = "─".repeat(
      Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - visibleWidth(content)),
    );
    return `${this.theme.fg("borderAccent", `╰${prefix}`)}${content}${this.theme.fg("borderAccent", `${suffix}${fill}╯`)}`;
  }

  private stripeBackground(content: string, index: number): string {
    return index % 2 === 0 ? content : this.theme.bg("customMessageBg", content);
  }

  private stripedRow(content: string, width: number, index: number): string {
    const fitted = this.fit(content, width);
    return `${this.theme.fg("borderAccent", "│")}${this.stripeBackground(fitted, index)}${this.theme.fg("borderAccent", "│")}`;
  }

  private row(content: string, width: number): string {
    return `${this.theme.fg("borderAccent", "│")}${this.fit(content, width)}${this.theme.fg("borderAccent", "│")}`;
  }

  private border(left: string, label: string, right: string, width: number): string {
    const bounded = truncateToWidth(label, width, "");
    return this.theme.fg(
      "borderAccent",
      `${left}${bounded}${"─".repeat(Math.max(0, width - visibleWidth(bounded)))}${right}`,
    );
  }

  private fit(content: string, width: number): string {
    const bounded = truncateToWidth(content, width, "");
    return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
  }

  private center(content: string, width: number): string {
    const padding = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
    return `${" ".repeat(padding)}${content}`;
  }
}
