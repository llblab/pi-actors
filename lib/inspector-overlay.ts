/**
 * Keyboard-driven actor inspector overlay.
 * Zones: overlay shell, tabs, owned-run/subagent selection, compact striped rows
 * Owns interactive TUI navigation; evidence parsing remains in inspector/session domains.
 */

import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";

import * as Inspector from "./inspector.ts";

export type ActorInspectorOverlayTab = "communications" | "turns";

type DetailLogicalLine = string | { sectionBreak: true };

const DETAIL_SECTION_BREAK: DetailLogicalLine = { sectionBreak: true };

export interface ActorInspectorOverlayOptions {
  done: () => void;
  ownerId: string;
  stateRoot: string;
  theme: Theme;
  tui: TUI;
}

export class ActorInspectorOverlay {
  private readonly done: () => void;
  private readonly ownerId: string;
  private readonly stateRoot: string;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly refreshTimer: NodeJS.Timeout;
  private runIndex = 0;
  private communicationChannel: "all" | "broadcast" | "direct" | "room" = "all";
  private communicationFrom = "all";
  private communicationUnread = false;
  private contentStripeIndices: number[] = [];
  private detailCommunication?: Inspector.ActorInspectorPreview;
  private detailOpen = false;
  private detailScroll = 0;
  private detailTurn?: Inspector.ActorInspectorTurnItem;
  private detailView: "evidence" | "transcript" = "evidence";
  private readonly readKeys = new Set<string>();
  private focus: "runs" | "tabs" | "list" | "detail" | "select" = "tabs";
  private filterControlIndex = 0;
  private menuLevel: "run" | "filter" | "value" = "filter";
  private selectorIndex = 0;
  private rowIndex = 0;
  private selectedRun?: string;
  private subagentIndex = 0;
  private tab: ActorInspectorOverlayTab = "communications";

  constructor(options: ActorInspectorOverlayOptions) {
    this.done = options.done;
    this.ownerId = options.ownerId;
    this.stateRoot = options.stateRoot;
    this.theme = options.theme;
    this.tui = options.tui;
    this.refreshTimer = setInterval(() => this.tui.requestRender(), 1000);
    this.refreshTimer.unref?.();
  }

  handleInput(data: string): void {
    const runs = this.runs();
    this.ensureSelectedRun(runs);
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.focus === "select") {
        if (this.menuLevel === "value") {
          this.menuLevel = "filter";
          this.selectorIndex = this.filterControlIndex;
        } else this.focus = this.menuLevel === "run" ? "runs" : "tabs";
      } else if (this.focus === "detail") this.backDetail();
      else this.done();
      this.tui.requestRender();
      return;
    }
    if (this.focus === "select") {
      const options = this.menuOptions();
      if (matchesKey(data, "up"))
        this.selectorIndex = Math.max(0, this.selectorIndex - 1);
      else if (matchesKey(data, "down"))
        this.selectorIndex = Math.min(options.length - 1, this.selectorIndex + 1);
      else if (matchesKey(data, "left")) this.backMenu();
      else if (
        matchesKey(data, "return") ||
        (matchesKey(data, "right") && this.menuLevel !== "value")
      )
        this.applyMenuOption(options[this.selectorIndex]);
      this.tui.requestRender();
      return;
    }
    if (this.focus === "detail") {
      if (matchesKey(data, "up")) this.detailScroll = Math.max(0, this.detailScroll - 1);
      else if (matchesKey(data, "down")) this.detailScroll += 1;
      else if (matchesKey(data, "left")) this.backDetail();
      else if (
        (matchesKey(data, "right") || matchesKey(data, "return")) &&
        this.detailView === "evidence" &&
        this.tab === "turns"
      ) {
        this.detailView = "transcript";
        this.detailScroll = 0;
      }
      this.tui.requestRender();
      return;
    }
    if (this.focus === "runs") {
      if (matchesKey(data, "left")) this.cycleRun(runs, -1);
      else if (matchesKey(data, "right")) this.cycleRun(runs, 1);
      else if (matchesKey(data, "down")) this.focus = "tabs";
      else if (matchesKey(data, "return") && runs.length > 0) this.openRunMenu();
    } else if (this.focus === "tabs") {
      if (matchesKey(data, "left") || matchesKey(data, "right")) {
        this.tab = this.tab === "communications" ? "turns" : "communications";
        this.filterControlIndex = 0;
        this.rowIndex = 0;
      } else if (matchesKey(data, "up")) this.focus = "runs";
      else if (matchesKey(data, "down") && this.listItemCount() > 0)
        this.focus = "list";
      else if (matchesKey(data, "return")) this.openFilterMenu();
    } else if (this.focus === "list") {
      const count = this.tab === "communications" ? this.communicationPreviews().length : this.turnItems().length;
      if (matchesKey(data, "up")) {
        if (this.rowIndex === 0) this.focus = "tabs";
        else this.rowIndex -= 1;
      } else if (matchesKey(data, "down"))
        this.rowIndex = Math.min(Math.max(0, count - 1), this.rowIndex + 1);
      else if (matchesKey(data, "return") || matchesKey(data, "right"))
        this.openDetail();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.ensureSelectedRun(this.runs());
    const safeWidth = Math.max(24, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const lines: string[] = [];
    lines.push(this.border("╭", " Actor Inspector ", "╮", innerWidth));
    lines.push(this.row(this.renderRunControl(), innerWidth));
    let selector = this.focus === "select"
      ? this.menuLevel === "run"
        ? this.renderMenuBox(
            this.runs().map(
              (run, index, runs) =>
                `#${runs.length - index}  ${run.run}  ${run.status}`,
            ),
            this.selectorIndex,
            undefined,
            undefined,
            false,
            false,
            this.contentViewportRows(),
          )
        : this.renderFilterMenus(innerWidth)
      : [];
    const selectorAnchor = this.selectorAnchor();
    if (this.menuLevel === "run" && selector.length > 0) {
      const popup = selector[0];
      const popupWidth = visibleWidth(popup);
      const leading = this.fit(
        this.takeVisiblePrefix(this.renderTabs(), selectorAnchor),
        selectorAnchor,
      );
      const trailingWidth = Math.max(0, innerWidth - selectorAnchor - popupWidth);
      const trailing = this.fit(
        this.dropVisiblePrefix(this.renderTabs(), selectorAnchor + popupWidth),
        trailingWidth,
      );
      lines.push(this.row(`${leading}${popup}${trailing}`, innerWidth, true));
      selector = selector.slice(1);
    } else lines.push(this.row(this.renderTabs(), innerWidth));
    const selectorTop = selector[0];
    if (selectorTop) {
      const leadingBorder = "─".repeat(selectorAnchor);
      const remainingBorder = "─".repeat(
        Math.max(0, innerWidth - visibleWidth(selectorTop) - selectorAnchor),
      );
      lines.push(
        `${this.theme.fg("border", `├${leadingBorder}`)}${selectorTop}${this.theme.fg("border", `${remainingBorder}┤`)}`,
      );
    } else lines.push(this.border("├", "", "┤", innerWidth));
    this.contentStripeIndices = [];
    const content = this.detailOpen
      ? this.renderDetail(innerWidth)
      : this.selectedRun
        ? this.renderTimeline(innerWidth)
        : this.renderRunSelector(innerWidth);
    const contentViewportRows = this.contentViewportRows();
    const selectorRows = selector.slice(1);
    for (let index = 0; index < Math.max(content.length, contentViewportRows); index += 1) {
      const base = content[index] ?? "";
      const stripeIndex = index < content.length
        ? this.contentStripeIndices[index] ?? index
        : 0;
      const popup = selectorRows[index];
      if (!popup) {
        lines.push(this.stripedRow(base, innerWidth, stripeIndex));
        continue;
      }
      const transparentPrefix = popup.match(/^ +/)?.[0].length ?? 0;
      const visiblePopup = popup.slice(transparentPrefix);
      const popupWidth = visibleWidth(visiblePopup);
      const popupAnchor = selectorAnchor + transparentPrefix;
      const baseWidth = Math.max(0, innerWidth - popupWidth - popupAnchor);
      const leadingBase = this.stripeBackground(
        this.fit(this.takeVisiblePrefix(base, popupAnchor), popupAnchor),
        stripeIndex,
      );
      const preservedBase = this.stripeBackground(
        this.fit(
          this.dropVisiblePrefix(base, popupWidth + popupAnchor),
          baseWidth,
        ),
        stripeIndex,
      );
      lines.push(this.row(`${leadingBase}${visiblePopup}${preservedBase}`, innerWidth, true));
    }
    lines.push(this.border("├", "", "┤", innerWidth));
    lines.push(this.row(this.renderKeyHints(), innerWidth));
    lines.push(this.border("╰", "", "╯", innerWidth));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.refreshTimer);
  }

  private runs(): Inspector.ActorInspectorRunItem[] {
    return Inspector.readActorInspectorRuns(this.stateRoot, this.ownerId);
  }

  private ensureSelectedRun(runs: Inspector.ActorInspectorRunItem[]): void {
    if (!this.selectedRun) this.selectedRun = runs[0]?.run;
  }

  private contentViewportRows(): number {
    const overlayRows = Math.floor(this.tui.terminal.rows * 0.94);
    return Math.max(4, Math.min(16, overlayRows - 7));
  }

  private selectRun(run: string, index: number): void {
    this.selectedRun = run;
    this.runIndex = index;
    this.rowIndex = 0;
    this.subagentIndex = 0;
    this.communicationFrom = "all";
  }

  private cycleRun(
    runs: Inspector.ActorInspectorRunItem[],
    direction: -1 | 1,
  ): void {
    if (runs.length === 0) return;
    const currentIndex = Math.max(
      0,
      runs.findIndex((run) => run.run === this.selectedRun),
    );
    const nextIndex = (currentIndex + direction + runs.length) % runs.length;
    const next = runs[nextIndex];
    if (next) this.selectRun(next.run, nextIndex);
  }

  private listItemCount(): number {
    return this.tab === "communications"
      ? this.communicationPreviews().length
      : this.turnItems().length;
  }

  private selectorAnchor(): number {
    if (this.menuLevel === "run") {
      const runControl = stripVTControlCharacters(this.renderRunControl());
      return Math.max(0, runControl.indexOf("Run:") - 2);
    }
    const label = this.tab === "communications" ? "Messages" : "Turns";
    const tabs = stripVTControlCharacters(this.renderTabs());
    return Math.max(0, tabs.indexOf(label) - 2);
  }

  private renderKeyHints(): string {
    const hint = (keys: string, description: string) =>
      `${this.theme.fg("accent", keys)}${this.theme.fg("dim", ` ${description}`)}`;
    if (this.focus === "select")
      return this.menuLevel === "value"
        ? ` ${hint("↑↓", "option")}  ${hint("enter", "apply")}  ${hint("←/esc", "back")}`
        : ` ${hint("↑↓", "option")}  ${hint("→/enter", "open")}  ${hint("←/esc", "back")}`;
    if (this.focus === "detail")
      return this.tab === "turns" && this.detailView === "evidence"
        ? ` ${hint("↑↓", "scroll")}  ${hint("→/enter", "readable")}  ${hint("←/esc", "back")}`
        : ` ${hint("↑↓", "scroll")}  ${hint("←/esc", this.detailView === "transcript" ? "evidence" : "back")}`;
    if (this.focus === "list")
      return ` ${hint("↑↓", "row")}  ${hint("→/enter", "open")}  ${hint("esc", "close")}`;
    if (this.focus === "runs")
      return ` ${hint("←→", "run")}  ${hint("↓", "tabs")}  ${hint("enter", "list")}  ${hint("esc", "close")}`;
    return ` ${hint("←→", "navigate")}  ${hint("↑↓", "change row")}  ${hint("enter", "select")}  ${hint("esc", "close")}`;
  }

  private renderRunControl(): string {
    const runs = this.runs();
    const runIndex = runs.findIndex((item) => item.run === this.selectedRun);
    const run = runs[runIndex];
    const focused = this.focus === "runs";
    const active = focused || (this.focus === "select" && this.menuLevel === "run");
    const prefix = active ? this.theme.fg("accent", " ← ") : "   ";
    const suffix = active ? this.theme.fg("accent", " → ") : "   ";
    if (!run) {
      const empty = this.theme.fg("muted", `${prefix}Run: none${suffix}`);
      return focused ? this.theme.bg("selectedBg", empty) : empty;
    }
    const statusColor = run.status === "failed"
      ? "error"
      : run.status === "running"
        ? "warning"
        : run.status === "done"
          ? "success"
          : "muted";
    const sequence = runs.length - runIndex;
    const value = `${prefix}${this.theme.fg("muted", "Run: ")}${this.theme.fg("text", `#${sequence}`)}  ${this.theme.fg("accent", run.run)}  ${this.theme.fg(statusColor, run.status)}${suffix}`;
    return focused ? this.theme.bg("selectedBg", value) : value;
  }

  private activeMessageFilters(): string[] {
    return [
      ...(this.communicationChannel === "all" ? [] : [this.communicationChannel]),
      ...(this.communicationUnread ? ["unread"] : []),
      ...(this.communicationFrom === "all" ? [] : [this.communicationFrom]),
    ];
  }

  private renderTabs(): string {
    const tab = (id: ActorInspectorOverlayTab, label: string) => {
      const selected = this.tab === id;
      const focused = selected && this.focus === "tabs";
      const runActive =
        this.focus === "runs" ||
        (this.focus === "select" && this.menuLevel === "run");
      const display = selected && !runActive ? `[ ${label} ]` : `  ${label}  `;
      const value = ` ${display} `;
      if (!selected) return this.theme.fg("muted", value);
      const colored = this.theme.fg("accent", value);
      return focused ? this.theme.bg("selectedBg", colored) : colored;
    };
    const messageFilters = this.activeMessageFilters();
    const subagent = this.subagents()[this.subagentIndex] ?? "all";
    const messagesLabel = `Messages${messageFilters.length > 0 ? ` (${messageFilters.join(", ")})` : ""}`;
    const turnsLabel = `Turns${subagent === "all" ? "" : ` (${subagent})`}`;
    return `${tab("communications", messagesLabel)} ${tab("turns", turnsLabel)}`;
  }

  private renderRunSelector(width: number): string[] {
    const runs = this.runs();
    if (runs.length === 0) return [this.theme.fg("muted", " No owned actor runs")];
    this.runIndex = Math.min(this.runIndex, runs.length - 1);
    return runs.slice(0, this.contentViewportRows()).map((run, index) => {
      const selected = index === this.runIndex;
      const prefix = selected ? this.theme.fg("accent", " ▶ ") : "   ";
      const label = `${prefix}#${runs.length - index}  run:${run.run}`;
      const status = ` ${run.status}`;
      return selected
        ? this.theme.fg("accent", `${label}${status}`)
        : `${label}${this.theme.fg("muted", status)}`;
    });
  }

  private renderTimeline(width: number): string[] {
    if (!this.selectedRun) return [];
    const run = this.runs().find((item) => item.run === this.selectedRun);
    if (!run) {
      this.selectedRun = undefined;
      return [this.theme.fg("warning", " Selected run is no longer owned by this session")];
    }
    const rows =
      this.tab === "communications"
        ? this.communicationRows()
        : this.turnRows();
    if (rows.length === 0) {
      this.contentStripeIndices = [0];
      const filtered = this.tab === "communications"
        ? this.activeMessageFilters().length > 0
        : (this.subagents()[this.subagentIndex] ?? "all") !== "all";
      return [
        this.theme.fg(
          "muted",
          filtered
            ? " No results for the active filters. Enter on the tab to adjust."
            : this.tab === "communications"
              ? " No messages in this run"
              : " No persisted turns in this run",
        ),
      ];
    }
    this.rowIndex = Math.min(this.rowIndex, rows.length - 1);
    const viewportRows = this.contentViewportRows();
    const start = Math.max(
      0,
      Math.min(
        this.rowIndex - Math.floor(viewportRows / 2),
        Math.max(0, rows.length - viewportRows),
      ),
    );
    const stripeIndices = this.tab === "communications"
      ? this.communicationPreviews().map((preview, index) =>
          Math.max(0, (preview.sequence ?? index + 1) - 1),
        )
      : this.turnItems().map((turn) => Math.max(0, turn.index - 1));
    const visibleRows = rows.slice(start, start + viewportRows);
    this.contentStripeIndices = visibleRows.map(
      (_, offset) => stripeIndices[start + offset] ?? start + offset,
    );
    return visibleRows.map((row, offset) => {
        const index = start + offset;
        const selected = this.focus === "list" && index === this.rowIndex;
        return selected
          ? this.theme.fg("accent", ` ▶ ${row}`)
          : `   ${row}`;
      });
  }

  private communicationPreviews(): Inspector.ActorInspectorPreview[] {
    if (!this.selectedRun) return [];
    const channels =
      this.communicationChannel === "all"
        ? undefined
        : [this.communicationChannel];
    return Inspector.readActorInspectorPreviews(this.stateRoot, 100, {
      channels,
      currentRunOnly: false,
      ownerId: this.ownerId,
      readKeys: this.readKeys,
      run: this.selectedRun,
      unreadOnly: this.communicationUnread,
    })
      .filter(
        (preview) =>
          this.communicationFrom === "all" ||
          this.communicationActorLabel(preview.from_display ?? preview.from) ===
            this.communicationFrom,
      )
      .reverse();
  }

  private communicationActorLabel(actor?: string): string {
    const value = actor ?? "unknown";
    if (value.startsWith("run:")) return value.slice("run:".length);
    return value.replace(/^branch:[^/]+\//, "");
  }

  private communicationFromOptions(): string[] {
    if (!this.selectedRun) return ["all"];
    const actors = Inspector.readActorInspectorRoster(
      this.stateRoot,
      this.selectedRun,
    ).map((member) =>
      this.communicationActorLabel(member.display ?? member.address),
    );
    return ["all", ...new Set(actors)];
  }

  private communicationRows(): string[] {
    return this.communicationPreviews().map((preview) => {
      const actor = preview.from_display ?? preview.from ?? "unknown";
      const target = preview.channel === "room" ? "#all" : preview.to;
      const text = preview.summary ?? preview.body_preview ?? "(no body)";
      return `#${preview.sequence ?? "?"}  ${preview.needs_response ? "! " : ""}${actor} → ${target}  ${preview.type}  ${text}`;
    });
  }

  private renderDetail(width: number): string[] {
    if (this.tab === "communications") {
      const preview = this.detailCommunication;
      if (!preview) return [this.theme.fg("warning", " Communication row is no longer available")];
      const fields: Array<[string, unknown]> = [
        ["channel", preview.channel],
        ["run", preview.run],
        ["from", preview.from_display ?? preview.from],
        ["to", preview.to],
        ["type", preview.type],
        ["summary", preview.summary],
        ["body", preview.body_preview],
        ["attention", preview.needs_response],
        ["inbox", preview.inbox_status],
        ["timestamp", preview.timestamp],
      ];
      return fields
        .filter(([, value]) => value !== undefined)
        .map(([label, value]) =>
          truncateToWidth(
            ` ${label.padEnd(12, " ")} ${typeof value === "string" ? value : JSON.stringify(value)}`,
            width,
            "…",
          ),
        );
    }
    const turn = this.detailTurn;
    if (!turn) return [this.theme.fg("warning", " Turn row is no longer available")];
    const logicalLines = this.detailView === "transcript"
      ? this.turnTranscriptLines(turn)
      : this.turnEvidenceLines(turn);
    const wrapped = this.wrapDetailLines(logicalLines, width);
    const viewportRows = this.contentViewportRows();
    const maxStart = Math.max(0, wrapped.lines.length - viewportRows);
    this.detailScroll = Math.min(this.detailScroll, maxStart);
    this.contentStripeIndices = wrapped.stripeIndices.slice(
      this.detailScroll,
      this.detailScroll + viewportRows,
    );
    return wrapped.lines.slice(
      this.detailScroll,
      this.detailScroll + viewportRows,
    );
  }

  private wrapDetailLines(
    lines: DetailLogicalLine[],
    width: number,
  ): { lines: string[]; stripeIndices: number[] } {
    const wrappedLines: string[] = [];
    const stripeIndices: number[] = [];
    let sectionIndex = 0;
    for (const line of lines) {
      if (typeof line !== "string") {
        sectionIndex += 1;
        continue;
      }
      const physicalLines = line.replaceAll("\t", "  ").split(/\r?\n/);
      for (const physicalLine of physicalLines) {
        if (!physicalLine.trim()) continue;
        const leading = physicalLine.match(/^ */)?.[0] ?? "";
        const content = physicalLine.slice(leading.length);
        const contentWidth = Math.max(1, width - visibleWidth(leading));
        const wrapped = visibleWidth(physicalLine) <= width
          ? [physicalLine]
          : wrapTextWithAnsi(content, contentWidth).map(
              (visualLine) => `${leading}${visualLine}`,
            );
        for (const visualLine of wrapped) {
          if (!visualLine.trim()) continue;
          wrappedLines.push(visualLine);
          stripeIndices.push(sectionIndex);
        }
      }
    }
    return { lines: wrappedLines, stripeIndices };
  }

  private detailSection(
    title: string,
    content: string[],
  ): DetailLogicalLine[] {
    if (content.length === 0) return [];
    return [
      ` ${title}`,
      ...content.flatMap((line) =>
        line
          .split(/\r?\n/)
          .filter((physicalLine) => physicalLine.trim().length > 0)
          .map((physicalLine) => `   ${physicalLine}`),
      ),
      DETAIL_SECTION_BREAK,
    ];
  }

  private readableValueLines(
    value: unknown,
    indent = "",
    depth = 0,
  ): string[] {
    if (depth > 8) return [`${indent}[nested value]`];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^[{[]/.test(trimmed)) {
        try {
          return this.readableValueLines(JSON.parse(trimmed), indent, depth + 1);
        } catch {
          // Keep non-JSON text as written.
        }
      }
      return value.split(/\r?\n/).map((line) => `${indent}${line}`);
    }
    if (value === null || value === undefined)
      return [`${indent}${String(value)}`];
    if (typeof value !== "object") return [`${indent}${String(value)}`];
    if (Array.isArray(value)) {
      if (value.length === 0) return [`${indent}(empty)`];
      return value.flatMap((item) => {
        if (
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return this.readableValueLines(
            (item as { text: string }).text,
            indent,
            depth + 1,
          );
        }
        if (!item || typeof item !== "object")
          return [`${indent}- ${String(item)}`];
        return [
          `${indent}-`,
          ...this.readableValueLines(item, `${indent}  `, depth + 1),
        ];
      });
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}(empty)`];
    return entries.flatMap(([key, item]) => {
      if (!item || typeof item !== "object") {
        const scalar = typeof item === "string" ? item : String(item);
        const [first = "", ...rest] = scalar.split(/\r?\n/);
        return [
          `${indent}${key}: ${first}`,
          ...rest.map((line) => `${indent}  ${line}`),
        ];
      }
      return [
        `${indent}${key}:`,
        ...this.readableValueLines(item, `${indent}  `, depth + 1),
      ];
    });
  }

  private turnEvidenceLines(
    turn: Inspector.ActorInspectorTurnItem,
  ): DetailLogicalLine[] {
    const lines: DetailLogicalLine[] = [];
    const commandNumber = /^command-(\d+)$/.exec(turn.commandId)?.[1];
    const subagent = commandNumber
      ? String(Number.parseInt(commandNumber, 10))
      : turn.commandId;
    const stage =
      turn.stage && turn.stage !== "subagent" && turn.stage !== "command"
        ? ` (${turn.stage})`
        : "";
    lines.push(` Subagent ${subagent}${stage}`, DETAIL_SECTION_BREAK);
    if (turn.userText)
      lines.push(...this.detailSection("User", [turn.userText]));
    if (turn.thinking)
      lines.push(...this.detailSection("Thinking", [turn.thinking]));
    if (turn.assistantText)
      lines.push(...this.detailSection("Assistant", [turn.assistantText]));
    for (const [index, tool] of turn.toolCalls.entries()) {
      const content = [
        ...(tool.arguments === undefined
          ? []
          : ["Input", ...this.readableValueLines(tool.arguments, "  ")]),
        ...(tool.result === undefined
          ? []
          : ["Result", ...this.readableValueLines(tool.result, "  ")]),
        `call id: ${tool.id}`,
      ];
      lines.push(
        ...this.detailSection(
          `Tool ${index + 1} (${tool.name}${tool.resultError ? ", Error" : ""})`,
          content,
        ),
      );
    }
    const execution = [
      ...(!turn.thinking ? ["thinking: not persisted"] : []),
      ...(turn.model ? [`model: ${turn.model}`] : []),
      ...(turn.stopReason ? [`stop reason: ${turn.stopReason}`] : []),
      ...(turn.error ? [`error: ${turn.error}`] : []),
      ...(turn.usage === undefined
        ? []
        : ["Usage", ...this.readableValueLines(turn.usage, "  ")]),
      ...(turn.unmatchedToolResults > 0
        ? [`unmatched tool results: ${turn.unmatchedToolResults}`]
        : []),
    ];
    if (execution.length > 0)
      lines.push(...this.detailSection("Execution", execution));
    if (turn.diagnostics.length > 0)
      lines.push(...this.detailSection("Diagnostics", turn.diagnostics));
    const provenance = [
      "Session",
      `  ${turn.sessionFile}`,
      ...(turn.sessionTruncated ? ["  turn list truncated"] : []),
      ...(turn.promptFile
        ? [
            "Prompt",
            `  ${turn.promptFile}${turn.promptBytes ? ` (${turn.promptBytes} bytes)` : ""}`,
          ]
        : []),
      ...(turn.recipeContext === undefined
        ? []
        : [
            "Recipe Context",
            ...this.readableValueLines(turn.recipeContext, "  "),
          ]),
    ];
    lines.push(...this.detailSection("Provenance", provenance));
    return lines.length > 0 ? lines : [" No persisted turn evidence"];
  }

  private readablePromptText(text: string): string {
    const wrapped = /^\s*<file\b[^>]*>\s*([\s\S]*?)\s*<\/file>\s*$/i.exec(text);
    return wrapped?.[1]?.trim() || text;
  }

  private turnTranscriptLines(
    turn: Inspector.ActorInspectorTurnItem,
  ): DetailLogicalLine[] {
    const lines: DetailLogicalLine[] = [];
    if (turn.userText)
      lines.push(
        ...this.detailSection("User", [this.readablePromptText(turn.userText)]),
      );
    if (turn.thinking)
      lines.push(...this.detailSection("Thinking", [turn.thinking]));
    if (turn.assistantText)
      lines.push(...this.detailSection("Assistant", [turn.assistantText]));
    for (const tool of turn.toolCalls) {
      const content = [
        ...(tool.arguments === undefined
          ? []
          : ["Input", ...this.readableValueLines(tool.arguments, "  ")]),
        ...(tool.result === undefined
          ? []
          : ["Result", ...this.readableValueLines(tool.result, "  ")]),
      ];
      lines.push(
        ...this.detailSection(
          `Tool (${tool.name}${tool.resultError ? ", Error" : ""})`,
          content,
        ),
      );
    }
    if (turn.error) lines.push(...this.detailSection("Error", [turn.error]));
    return lines.length > 0 ? lines : [" No readable turn content"];
  }

  private turnItems(): Inspector.ActorInspectorTurnItem[] {
    if (!this.selectedRun) return [];
    const selectedSubagent = this.subagents()[this.subagentIndex];
    return Inspector.readActorInspectorTurns(
      path.join(this.stateRoot, this.selectedRun),
    )
      .filter(
        (turn) =>
          !selectedSubagent ||
          selectedSubagent === "all" ||
          turn.commandId === selectedSubagent,
      )
      .reverse();
  }

  private turnRows(): string[] {
    return this.turnItems().map((turn) => {
      const commandNumber = /^command-(\d+)$/.exec(turn.commandId)?.[1];
      const subagent = commandNumber
        ? `Subagent ${Number.parseInt(commandNumber, 10)}`
        : `Subagent ${turn.commandId}`;
      const stage =
        turn.stage && turn.stage !== "subagent" && turn.stage !== "command"
          ? ` (${turn.stage})`
          : "";
      const toolNames = [...new Set(turn.toolCalls.map((tool) => tool.name))];
      const action = turn.toolCalls.length === 0
        ? ""
        : turn.toolCalls.length === 1
          ? `  (${toolNames[0]})`
          : toolNames.length === 1
            ? `  (${toolNames[0]}, ${turn.toolCalls.length} calls)`
            : turn.toolCalls.length <= 2
              ? `  (${toolNames.join(", ")})`
              : `  (${turn.toolCalls.length} tools)`;
      const failed = turn.error || turn.toolCalls.some((tool) => tool.resultError)
        ? "  (error)"
        : "";
      const preview = this.readablePromptText(
        turn.assistantText ?? turn.userText ?? "(no text)",
      ).replaceAll(/\s+/g, " ").trim();
      return `#${turn.index}  ${subagent}${stage}  ${turn.model ?? "unknown model"}${action}${failed}  ${preview}`;
    });
  }

  private subagents(): string[] {
    if (!this.selectedRun || this.tab !== "turns") return ["all"];
    const ids = Inspector.readActorInspectorTurns(
      path.join(this.stateRoot, this.selectedRun),
    ).map((turn) => turn.commandId);
    return ["all", ...new Set(ids)];
  }

  private valueOptions(): string[] {
    if (this.tab === "turns") return this.subagents();
    if (this.filterControlIndex === 0)
      return ["all", "room", "direct", "broadcast"];
    if (this.filterControlIndex === 1) return ["all", "unread"];
    return this.communicationFromOptions();
  }

  private filterOptions(): string[] {
    return this.tab === "communications"
      ? ["Channel", "State", "From"]
      : ["Subagent"];
  }

  private menuOptions(): string[] {
    if (this.menuLevel === "run") return this.runs().map((run) => run.run);
    if (this.menuLevel === "filter") return this.filterOptions();
    return this.valueOptions();
  }

  private backMenu(): void {
    if (this.menuLevel === "value") {
      this.menuLevel = "filter";
      this.selectorIndex = this.filterControlIndex;
      return;
    }
    this.focus = this.menuLevel === "run" ? "runs" : "tabs";
  }

  private openRunMenu(): void {
    const options = this.runs();
    this.selectorIndex = Math.max(0, options.findIndex((run) => run.run === this.selectedRun));
    this.menuLevel = "run";
    this.focus = "select";
  }

  private openFilterMenu(): void {
    this.selectorIndex = this.filterControlIndex;
    this.menuLevel = "filter";
    this.focus = "select";
  }

  private applyMenuOption(value?: string): void {
    if (!value) return;
    if (this.menuLevel === "run") {
      this.selectRun(
        value,
        Math.max(0, this.runs().findIndex((run) => run.run === value)),
      );
      this.focus = "runs";
      return;
    }
    if (this.menuLevel === "filter") {
      this.filterControlIndex = this.selectorIndex;
      const options = this.valueOptions();
      const current = this.currentFilterValue();
      this.selectorIndex = Math.max(0, options.indexOf(current));
      this.menuLevel = "value";
      return;
    }
    if (this.tab === "turns")
      this.subagentIndex = Math.max(0, this.subagents().indexOf(value));
    else if (this.filterControlIndex === 0)
      this.communicationChannel = value as typeof this.communicationChannel;
    else if (this.filterControlIndex === 1)
      this.communicationUnread = value === "unread";
    else this.communicationFrom = value;
    this.rowIndex = 0;
    this.menuLevel = "filter";
    this.selectorIndex = this.filterControlIndex;
  }

  private filterValue(index: number): string {
    if (this.tab === "turns") return this.subagents()[this.subagentIndex] ?? "all";
    if (index === 0) return this.communicationChannel;
    if (index === 1) return this.communicationUnread ? "unread" : "all";
    return this.communicationFrom;
  }

  private currentFilterValue(): string {
    return this.filterValue(this.filterControlIndex);
  }

  private renderMenuBox(
    options: string[],
    focusedIndex: number,
    current?: string,
    parentIndex?: number,
    omitLeftBorder = false,
    omitRightBorder = false,
    maxVisibleOptions = options.length,
  ): string[] {
    const visibleLimit = Math.max(1, Math.min(maxVisibleOptions, options.length));
    const anchorIndex = Math.max(
      0,
      Math.min(
        options.length - 1,
        focusedIndex >= 0 ? focusedIndex : (parentIndex ?? 0),
      ),
    );
    const maxStart = Math.max(0, options.length - visibleLimit);
    const start = Math.max(
      0,
      Math.min(anchorIndex - Math.floor(visibleLimit / 2), maxStart),
    );
    const visibleOptions = options.slice(start, start + visibleLimit);
    const hiddenAbove = start > 0;
    const hiddenBelow = start + visibleOptions.length < options.length;
    const contentWidth = Math.max(
      4,
      ...options.map((option) => visibleWidth(option) + 4),
    );
    const border = (left: string, right: string, marker = "") =>
      this.theme.fg(
        "border",
        `${omitLeftBorder ? "" : left}${marker}${"─".repeat(Math.max(0, contentWidth - visibleWidth(marker)))}${omitRightBorder ? "" : right}`,
      );
    return [
      border("╭", "╮", hiddenAbove ? "↑" : ""),
      ...visibleOptions.map((option, localIndex) => {
        const index = start + localIndex;
        const focused = index === focusedIndex;
        const row = this.fit(`${focused ? " ▶ " : "   "}${option}`, contentWidth);
        const colored = focused || option === current || index === parentIndex
          ? this.theme.fg("accent", row)
          : row;
        const styled = focused || index === parentIndex
          ? this.theme.bg("selectedBg", colored)
          : colored;
        return `${omitLeftBorder ? "" : this.theme.fg("border", "│")}${styled}${omitRightBorder ? "" : this.theme.fg("border", "│")}`;
      }),
      border("╰", "╯", hiddenBelow ? "↓" : ""),
    ];
  }

  private renderFilterMenus(_width: number): string[] {
    const filters = this.filterOptions().map(
      (filter, index) => `${filter}: ${this.filterValue(index)}`,
    );
    const maxVisibleOptions = Math.max(1, this.contentViewportRows() - 1);
    const parentFocus = this.menuLevel === "filter" ? this.selectorIndex : -1;
    const parent = this.renderMenuBox(
      filters,
      parentFocus,
      undefined,
      this.menuLevel === "value" ? this.filterControlIndex : undefined,
      false,
      false,
      maxVisibleOptions,
    );
    if (this.menuLevel !== "value") return parent;
    const parentShared = this.renderMenuBox(
      filters,
      parentFocus,
      undefined,
      this.filterControlIndex,
      false,
      true,
      maxVisibleOptions,
    );
    const child = this.renderMenuBox(
      this.valueOptions(),
      this.selectorIndex,
      this.currentFilterValue(),
      undefined,
      false,
      false,
      maxVisibleOptions,
    );
    return Array.from({ length: Math.max(parent.length, child.length) }, (_, index) =>
      child[index]
        ? `${parentShared[index] ?? " ".repeat(visibleWidth(parentShared[0]))}${child[index]}`
        : (parent[index] ?? ""),
    );
  }

  private openDetail(): void {
    if (this.tab === "communications") {
      const preview = this.communicationPreviews()[this.rowIndex];
      this.detailCommunication = preview;
      if (preview) this.readKeys.add(Inspector.inspectorPreviewReadKey(preview));
    } else this.detailTurn = this.turnItems()[this.rowIndex];
    this.detailScroll = 0;
    this.detailView = "evidence";
    this.detailOpen = Boolean(this.detailCommunication || this.detailTurn);
    if (this.detailOpen) this.focus = "detail";
  }

  private backDetail(): void {
    if (this.detailView === "transcript") {
      this.detailView = "evidence";
      this.detailScroll = 0;
      return;
    }
    this.closeDetail();
  }

  private closeDetail(): void {
    this.detailOpen = false;
    this.detailCommunication = undefined;
    this.detailTurn = undefined;
    this.detailScroll = 0;
    this.detailView = "evidence";
    this.focus = "list";
  }

  private border(left: string, title: string, right: string, width: number): string {
    const titleText = truncateToWidth(title, width, "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(titleText)));
    return this.theme.fg("border", `${left}${titleText}${fill}${right}`);
  }

  private stripeBackground(content: string, index: number): string {
    if (index % 2 === 0) return content;
    const segments = content.split("…");
    return segments
      .map((segment, segmentIndex) =>
        `${this.theme.bg("customMessageBg", segment)}${segmentIndex < segments.length - 1 ? this.theme.bg("customMessageBg", "…") : ""}`,
      )
      .join("");
  }

  private stripedRow(content: string, width: number, index: number): string {
    return this.row(
      this.stripeBackground(this.fit(content, width), index),
      width,
      true,
    );
  }

  private row(content: string, width: number, fitted = false): string {
    const body = fitted ? content : this.fit(content, width);
    return `${this.theme.fg("border", "│")}${body}${this.theme.fg("border", "│")}`;
  }

  private takeVisiblePrefix(content: string, width: number): string {
    const plain = stripVTControlCharacters(content);
    let consumed = 0;
    let result = "";
    for (const character of plain) {
      const characterWidth = visibleWidth(character);
      if (consumed + characterWidth > width) break;
      result += character;
      consumed += characterWidth;
    }
    return result;
  }

  private dropVisiblePrefix(content: string, width: number): string {
    const plain = stripVTControlCharacters(content);
    let consumed = 0;
    let index = 0;
    for (const character of plain) {
      if (consumed >= width) break;
      consumed += visibleWidth(character);
      index += character.length;
    }
    return plain.slice(index);
  }

  private fit(content: string, width: number): string {
    // A Component render entry must remain exactly one terminal row. Persisted
    // prompts, messages, and tool results may contain line breaks or tabs;
    // passing those through lets them escape the overlay compositor and corrupt
    // the underlying TUI during tab changes.
    const singleLine = content.replace(/[\r\n\t]/g, " ");
    const bounded = truncateToWidth(singleLine, width, "…");
    return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
  }
}
