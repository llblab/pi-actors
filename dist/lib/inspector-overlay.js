/**
 * Keyboard-driven Actor Inspector overlay for concrete Run instances.
 * Zones: owned actor selection, Recipe/Trace/Control tabs, safe Run Kill confirmation
 * Owns manual kernel navigation; evidence parsing and lifecycle mutation stay in ports.
 */
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Document, isScalar, visit } from "yaml";
import { matchesKey, Markdown, sliceByColumn, truncateToWidth, visibleWidth, } from "@earendil-works/pi-tui";
import * as ActorInspector from "./inspector.js";
import * as ControlProjection from "./control-projection.js";
import * as RunsControls from "./runs-controls.js";
import * as RunControlDelivery from "./runs-control-delivery.js";
import * as RunsTrace from "./runs-trace.js";
import * as Limits from "./limits.js";
import { computeRunControlCapacity, runControlStatusTimestamp } from "./run-evidence-policy.js";
import * as RuntimeTriage from "./runtime-triage.js";
import { normalizeRecipeControl } from "./recipe-control.js";
import * as TraceProjection from "./trace-projection.js";
const TABS = ["recipe", "trace", "control"];
const TRACE_SOURCES = [
    "all",
    "lifecycle",
    "control",
    "process",
    "agent",
    "artifact",
    "runtime",
];
export class ActorInspectorOverlay {
    done;
    killRun;
    ownerId;
    readRuns;
    readTrace;
    stateRoot;
    theme;
    tui;
    refreshTimer;
    contentSelectedRows = new Set();
    contentStripeIndices = [];
    documentScroll = 0;
    detailScroll = 0;
    feedback;
    feedbackFromAction = false;
    feedbackScroll = 0;
    feedbackPageRows = 1;
    inspectorFrame;
    focus = "runs";
    killConfirmation;
    killDialogChoice = "cancel";
    killDialogScroll = 0;
    killDialogPageRows = 1;
    rowIndex = 0;
    runCache;
    selectedTraceId;
    controlCache;
    controlSelection;
    runIndex = 0;
    selectorIndex = 0;
    selectorMode;
    tabIndex = 0;
    traceCache;
    traceDetail;
    traceSourceIndex = 0;
    constructor(options) {
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
    dispose() {
        clearInterval(this.refreshTimer);
    }
    invalidate() {
        this.runCache = undefined;
        this.traceCache = undefined;
        this.controlCache = undefined;
    }
    handleInput(data) {
        if (matchesKey(data, "ctrl+c")) {
            this.done();
            return;
        }
        if (this.killConfirmation) {
            this.handleKillInput(data);
            this.tui.requestRender();
            return;
        }
        if (this.feedback) {
            if (matchesKey(data, "escape")) {
                this.feedback = undefined;
                this.feedbackFromAction = false;
                this.feedbackScroll = 0;
            }
            else if (matchesKey(data, "up"))
                this.feedbackScroll = Math.max(0, this.feedbackScroll - 1);
            else if (matchesKey(data, "down"))
                this.feedbackScroll++;
            else if (matchesKey(data, "pageUp"))
                this.feedbackScroll = Math.max(0, this.feedbackScroll - this.feedbackPageRows);
            else if (matchesKey(data, "pageDown"))
                this.feedbackScroll += this.feedbackPageRows;
            this.tui.requestRender();
            return;
        }
        const runs = this.runs();
        this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
        if (data.toLowerCase() === "k") {
            this.requestKill(runs[this.runIndex]);
            this.tui.requestRender();
            return;
        }
        if (this.tab === "control" && (this.focus === "list" || this.focus === "detail")) {
            this.handleControlInput(data, runs[this.runIndex]);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "escape")) {
            if (this.focus === "select") {
                this.selectorMode = undefined;
                this.focus = this.tab === "trace" ? "tabs" : "runs";
            }
            else if (this.focus === "detail") {
                this.selectedTraceId = this.traceDetail?.id;
                this.traceDetail = undefined;
                this.detailScroll = 0;
                this.focus = "list";
            }
            else if (this.focus === "document" || this.focus === "list") {
                if (this.focus === "list")
                    this.selectedTraceId = undefined;
                this.focus = "tabs";
            }
            else {
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
            if (this.tab === "control" && matchesKey(data, "return"))
                this.openControlList(runs[this.runIndex]);
            else if (matchesKey(data, "left"))
                this.focus = "tabs";
            else if (matchesKey(data, "up") && this.documentScroll === 0)
                this.focus = "tabs";
            else
                this.handleScrollableInput(data, "document");
            this.tui.requestRender();
            return;
        }
        if (this.focus === "runs") {
            if (matchesKey(data, "left"))
                this.cycleRun(runs, -1);
            else if (matchesKey(data, "right"))
                this.cycleRun(runs, 1);
            else if (matchesKey(data, "down"))
                this.focus = "tabs";
            else if (matchesKey(data, "return") && runs.length > 0) {
                this.selectorMode = "run";
                this.selectorIndex = this.runIndex;
                this.focus = "select";
            }
        }
        else if (this.focus === "tabs") {
            if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
                const direction = matchesKey(data, "left") ? -1 : 1;
                this.tabIndex = (this.tabIndex + direction + TABS.length) % TABS.length;
                this.resetContentPosition();
            }
            else if (matchesKey(data, "up")) {
                this.focus = "runs";
            }
            else if (matchesKey(data, "down")) {
                const items = this.tab === "trace" ? this.traceItems(runs[this.runIndex]) : [];
                this.focus = items.length > 0 ? "list" : "document";
                if (this.focus === "list") {
                    this.rowIndex = 0;
                    this.selectedTraceId = items[0]?.id;
                }
            }
            else if (matchesKey(data, "return")) {
                if (this.tab === "trace")
                    this.openSourceSelector(runs[this.runIndex]);
                else if (this.tab === "control")
                    this.openControlList(runs[this.runIndex]);
                else
                    this.focus = "document";
            }
        }
        else if (this.focus === "list") {
            const items = this.traceItems(runs[this.runIndex]);
            const count = items.length;
            if (matchesKey(data, "left")) {
                this.selectedTraceId = undefined;
                this.focus = "tabs";
            }
            else if (matchesKey(data, "up")) {
                if (this.rowIndex === 0) {
                    this.selectedTraceId = undefined;
                    this.focus = "tabs";
                }
                else
                    this.rowIndex -= 1;
            }
            else if (matchesKey(data, "down")) {
                this.rowIndex = Math.min(Math.max(0, count - 1), this.rowIndex + 1);
            }
            else if (matchesKey(data, "pageUp")) {
                this.rowIndex = Math.max(0, this.rowIndex - this.contentViewportRows());
            }
            else if (matchesKey(data, "pageDown")) {
                this.rowIndex = Math.min(Math.max(0, count - 1), this.rowIndex + this.contentViewportRows());
            }
            else if (matchesKey(data, "return") || matchesKey(data, "right")) {
                const item = items[this.rowIndex];
                if (item) {
                    this.traceDetail = item;
                    this.detailScroll = 0;
                    this.focus = "detail";
                }
            }
            if (this.focus === "list")
                this.selectedTraceId = items[this.rowIndex]?.id;
        }
        if (data.toLowerCase() === "f" && this.tab === "trace") {
            this.cycleTraceSource(runs[this.runIndex]);
        }
        this.tui.requestRender();
    }
    render(width) {
        const safeWidth = Math.max(24, width);
        const modal = !!(this.killConfirmation || this.feedback);
        if (!modal || !this.inspectorFrame)
            this.inspectorFrame = { width: safeWidth, lines: this.renderInspector(safeWidth) };
        const lines = this.modalUnderlay(safeWidth);
        if (this.killConfirmation)
            this.compositePopup(lines, this.renderKillDialog(safeWidth - 2, lines.length), safeWidth);
        else if (this.feedback)
            this.compositePopup(lines, this.renderFeedbackPopup(safeWidth, lines.length), safeWidth);
        return lines;
    }
    renderInspector(safeWidth) {
        const innerWidth = safeWidth - 2;
        const runs = this.runs();
        this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
        const run = runs[this.runIndex];
        const lines = [this.border("╭", " Actor Inspector ", "╮", innerWidth)];
        lines.push(this.row(this.renderRunControl(run, runs.length - this.runIndex - 1, innerWidth), innerWidth));
        lines.push(this.row(this.renderTabs(run), innerWidth));
        lines.push(this.border("├", "", "┤", innerWidth));
        this.contentSelectedRows.clear();
        this.contentStripeIndices = [];
        let content = this.renderContent(run, innerWidth);
        const viewportRows = this.contentViewportRows();
        content = content.slice(0, viewportRows);
        for (let index = 0; index < viewportRows; index += 1) {
            lines.push(this.stripedRow(content[index] ?? "", innerWidth, this.contentStripeIndices[index] ?? index, this.contentSelectedRows.has(index)));
        }
        lines.push(this.footerBorder(this.renderKeyHints(), innerWidth));
        if (this.focus === "select") {
            const runSelector = this.selectorMode === "run";
            const startRow = runSelector ? 2 : 3;
            const horizontalOffset = runSelector ? 5 : 12;
            const availableRows = Math.max(3, lines.length - startRow - 1);
            const menu = this.renderSelector(run, availableRows, innerWidth);
            for (const [offset, menuLine] of menu.entries()) {
                const target = startRow + offset;
                if (target >= lines.length - 1)
                    break;
                lines[target] = this.compositeMenuLine(lines[target], menuLine, innerWidth, horizontalOffset);
            }
        }
        return lines;
    }
    get tab() {
        return TABS[this.tabIndex];
    }
    runs() {
        if (this.runCache)
            return this.runCache;
        this.runCache = this.readRuns(this.stateRoot, this.ownerId);
        return this.runCache;
    }
    contentViewportRows() {
        const rows = this.tui.terminal?.rows ?? 30;
        const overlayRows = Math.floor(rows * 0.94);
        return Math.max(4, Math.min(24, overlayRows - 5));
    }
    resetContentPosition() {
        this.documentScroll = 0;
        this.detailScroll = 0;
        this.rowIndex = 0;
        this.selectedTraceId = undefined;
        this.traceDetail = undefined;
    }
    cycleRun(runs, direction) {
        if (runs.length === 0)
            return;
        this.runIndex = (this.runIndex + direction + runs.length) % runs.length;
        this.resetContentPosition();
    }
    handleScrollableInput(data, target) {
        const key = target === "detail" ? "detailScroll" : "documentScroll";
        const pageRows = () => this.contentViewportRows();
        if (matchesKey(data, "up"))
            this[key] = Math.max(0, this[key] - 1);
        else if (matchesKey(data, "down"))
            this[key] += 1;
        else if (matchesKey(data, "pageUp")) {
            this[key] = Math.max(0, this[key] - pageRows());
        }
        else if (matchesKey(data, "pageDown")) {
            this[key] += pageRows();
        }
        else if (matchesKey(data, "left") && target === "detail") {
            this.selectedTraceId = this.traceDetail?.id;
            this.traceDetail = undefined;
            this.detailScroll = 0;
            this.focus = "list";
        }
    }
    handleSelectorInput(data, runs) {
        const run = runs[this.runIndex];
        const options = this.selectorMode === "run"
            ? runs.map((item) => item.run)
            : this.traceSources(run);
        if (matchesKey(data, "up"))
            this.selectorIndex = Math.max(0, this.selectorIndex - 1);
        else if (matchesKey(data, "down")) {
            this.selectorIndex = Math.min(Math.max(0, options.length - 1), this.selectorIndex + 1);
        }
        else if (matchesKey(data, "left")) {
            this.focus = this.selectorMode === "run" ? "runs" : "tabs";
            this.selectorMode = undefined;
        }
        else if (matchesKey(data, "return") || matchesKey(data, "right")) {
            if (this.selectorMode === "run") {
                this.runIndex = this.selectorIndex;
                this.focus = "runs";
            }
            else {
                this.traceSourceIndex = this.selectorIndex;
                this.focus = "tabs";
            }
            this.selectorMode = undefined;
            this.resetContentPosition();
        }
    }
    openSourceSelector(run) {
        const sources = this.traceSources(run);
        this.selectorMode = "source";
        this.selectorIndex = Math.min(this.traceSourceIndex, sources.length - 1);
        this.focus = "select";
    }
    cycleTraceSource(run) {
        const sources = this.traceSources(run);
        this.traceSourceIndex = (this.traceSourceIndex + 1) % sources.length;
        this.resetContentPosition();
    }
    requestKill(run) {
        this.feedback = undefined;
        this.feedbackFromAction = false;
        this.feedbackScroll = 0;
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
        this.killDialogScroll = 0;
    }
    handleKillInput(data) {
        const key = data.toLowerCase();
        if (matchesKey(data, "pageUp")) {
            this.killDialogScroll = Math.max(0, this.killDialogScroll - this.killDialogPageRows);
        }
        else if (matchesKey(data, "pageDown")) {
            this.killDialogScroll += this.killDialogPageRows;
        }
        else if (matchesKey(data, "escape") || key === "n") {
            this.feedback = undefined;
            this.killConfirmation = undefined;
            this.killDialogChoice = "cancel";
        }
        else if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
            this.killDialogChoice = this.killDialogChoice === "cancel" ? "kill" : "cancel";
        }
        else if (key === "y") {
            this.confirmKill();
        }
        else if (matchesKey(data, "return")) {
            if (this.killDialogChoice === "kill")
                this.confirmKill();
            else {
                this.feedback = undefined;
                this.killConfirmation = undefined;
            }
        }
    }
    confirmKill() {
        const confirmation = this.killConfirmation;
        this.killConfirmation = undefined;
        this.killDialogChoice = "cancel";
        if (!confirmation || !this.killRun)
            return;
        this.feedbackFromAction = true;
        try {
            const result = this.killRun(confirmation.run, confirmation.runInstanceId);
            this.feedback = result.ok ? undefined : result;
            if (result.ok)
                this.invalidate();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const normalized = message.replaceAll(/\s+/g, " ");
            let selected = normalized.slice(0, 160);
            const clipped = typeof normalized === "string" && normalized.length > 160;
            if (clipped && typeof selected === "string" && /[\uD800-\uDBFF]/u.test(selected.at(-1) ?? "") && /[\uDC00-\uDFFF]/u.test(normalized[160]))
                selected = selected.slice(0, -1);
            this.feedback = {
                ok: false,
                message: ActorInspector.formatActorInspectorKillFeedback("failed", `${selected}`, { clipped }),
            };
        }
    }
    renderKillDialog(width, maxRows) {
        const innerWidth = Math.min(width, 70), textWidth = innerWidth - 2;
        const confirmation = this.killConfirmation;
        const cancel = this.killDialogChoice === "cancel"
            ? this.theme.bg("selectedBg", this.theme.fg("accent", " Cancel "))
            : this.theme.fg("muted", " Cancel ");
        const kill = this.killDialogChoice === "kill"
            ? this.theme.bg("selectedBg", this.theme.fg("error", " Kill actor "))
            : this.theme.fg("error", " Kill actor ");
        const details = this.documentProjection({
            run: confirmation.run,
            state: confirmation.status,
            action: "generation-fenced runtime kill",
        }, textWidth).lines;
        const safety = this.closureWarning(textWidth).map(line => this.theme.fg("warning", line));
        const choices = visibleWidth(cancel) + 2 + visibleWidth(kill) <= textWidth
            ? [this.center(`${cancel}  ${kill}`, textWidth)]
            : [this.center(cancel, textWidth), this.center(kill, textWidth)];
        const layout = this.popupLayout(maxRows, safety.length + 1 + choices.length, details.length);
        this.killDialogPageRows = layout.pageRows;
        this.killDialogScroll = Math.min(this.killDialogScroll, Math.max(0, details.length - this.killDialogPageRows));
        const visible = details.slice(this.killDialogScroll, this.killDialogScroll + this.killDialogPageRows);
        const hints = innerWidth < 30 ? this.keyHints(["↵", "pick"], ["esc", "back"])
            : innerWidth < 60 ? this.keyHints(["←→/tab", "choose"], ["↵", "pick"], ["esc", "back"]) : this.renderKeyHints(true);
        return [
            this.border("╭", " Confirm Actor Kill ", "╮", innerWidth),
            ...(layout.top ? [this.row("", innerWidth)] : []),
            ...visible.map(line => this.row("  " + line, innerWidth)),
            ...(layout.paged ? [this.row("  " + this.theme.fg("muted", `${this.killDialogScroll + 1}-${this.killDialogScroll + visible.length}/${details.length} pgup/pgdn`), innerWidth)] : []),
            ...[...safety, "", ...choices].map(line => this.row("  " + line, innerWidth)),
            ...(layout.bottom ? [this.row("", innerWidth)] : []),
            this.footerBorder(hints, innerWidth),
        ];
    }
    renderRunControl(run, sequence, width) {
        const active = this.focus === "runs" || (this.focus === "select" && this.selectorMode === "run");
        const prefix = active ? this.theme.fg("accent", " ← ") : "   ";
        const suffix = active ? this.theme.fg("accent", " → ") : "   ";
        if (!run) {
            const empty = this.theme.fg("muted", `${prefix}Run: none${suffix}`);
            return active ? this.theme.bg("selectedBg", empty) : empty;
        }
        const value = `${prefix}${this.theme.fg("muted", "Run: ")}${this.theme.fg("text", `#${sequence}`)}  ${this.theme.fg("accent", run.run)}  ${this.theme.fg(this.statusColor(run.status), run.status)}${suffix}`;
        const bounded = truncateToWidth(value, width, "…");
        return active ? this.theme.bg("selectedBg", bounded) : bounded;
    }
    renderTabs(run) {
        const source = this.tab === "trace" ? this.traceSource(run) : "all";
        return TABS.map((tab, index) => {
            const base = `${tab[0].toUpperCase()}${tab.slice(1)}`;
            const label = tab === "trace" && source !== "all" ? `${base}: ${source}` : base;
            const selected = index === this.tabIndex;
            const bracketed = selected && this.focus !== "runs";
            if (!selected) {
                const display = bracketed ? `[ ${label} ]` : `  ${label}  `;
                return this.theme.fg("muted", ` ${display} `);
            }
            const coloredLabel = tab === "trace" && source !== "all"
                ? `${this.theme.fg("accent", `${base}:`)} ${this.theme.fg("text", source)}`
                : this.theme.fg("accent", label);
            const colored = bracketed
                ? ` ${this.theme.fg("accent", "[ ")}${coloredLabel}${this.theme.fg("accent", " ]")} `
                : `   ${coloredLabel}   `;
            const active = this.focus === "tabs"
                || (this.focus === "select" && this.selectorMode === "source");
            return active ? this.theme.bg("selectedBg", colored) : colored;
        }).join(" ");
    }
    renderContent(run, width) {
        if (!run)
            return [this.theme.fg("muted", " No owned actor runs")];
        if (this.tab === "control" && (this.focus === "list" || this.focus === "detail"))
            return this.renderControlContent(run, width);
        if (this.focus === "detail")
            return this.renderTraceDetail(width);
        if (this.tab === "trace")
            return this.renderTraceList(run, width);
        const selectedRun = run.run;
        const stateDir = path.join(this.stateRoot, selectedRun);
        const value = this.tab === "recipe"
            ? ActorInspector.readActorInspectorRecipe(stateDir)
            : this.controlDocument(run, stateDir);
        const body = this.documentProjection(value, width);
        const identity = this.documentProjection({ selected_run_id: selectedRun }, width);
        const projection = {
            lines: [...identity.lines, ...body.lines],
            stripes: [...identity.stripes, ...body.stripes.map(index => index + 1)],
        };
        const maxStart = Math.max(0, projection.lines.length - this.contentViewportRows());
        this.documentScroll = Math.min(this.documentScroll, maxStart);
        this.contentStripeIndices = projection.stripes.slice(this.documentScroll, this.documentScroll + this.contentViewportRows());
        return projection.lines.slice(this.documentScroll, this.documentScroll + this.contentViewportRows());
    }
    modalUnderlay(width) {
        const frame = this.inspectorFrame;
        const height = this.contentViewportRows() + 5;
        if (frame.width === width && frame.lines.length === height)
            return frame.lines.slice();
        // Resize the frozen underlay without refreshing evidence behind an open modal.
        const innerWidth = width - 2;
        const content = (index) => sliceByColumn(frame.lines[index] ?? "", 1, frame.width - 2, true);
        return [
            this.border("╭", " Actor Inspector ", "╮", innerWidth),
            this.row(content(1), innerWidth),
            this.row(content(2), innerWidth),
            this.border("├", "", "┤", innerWidth),
            ...Array.from({ length: height - 5 }, (_, index) => this.row(index < frame.lines.length - 5 ? content(index + 4) : "", innerWidth)),
            this.footerBorder(content(frame.lines.length - 1), innerWidth),
        ];
    }
    compositePopup(lines, popup, width) {
        const popupWidth = visibleWidth(popup[0]);
        const left = Math.floor((width - popupWidth) / 2);
        const top = Math.floor((lines.length - popup.length) / 2);
        for (const [offset, line] of popup.entries()) {
            const base = lines[top + offset];
            const right = left + popupWidth;
            // Terminal-default background masks underlying stripes; selected buttons keep their own fill.
            lines[top + offset] = `${sliceByColumn(base, 0, left, true)}\u001b[49m${line}\u001b[49m${sliceByColumn(base, right, width - right, true)}`;
        }
    }
    popupLayout(maxRows, fixedRows, detailRows) {
        // Reserve readable text, pinned safety and choices before decorative blank rows.
        const minimum = 2 + fixedRows + Math.min(2, detailRows);
        const paddingRows = Math.min(2, Math.max(0, maxRows - minimum));
        const height = Math.min(maxRows, Math.max(maxRows - 2, minimum + paddingRows));
        const slots = height - 2 - fixedRows - paddingRows;
        const paged = detailRows > slots;
        return { top: paddingRows > 0, bottom: paddingRows > 1, pageRows: Math.min(detailRows, slots - Number(paged)), paged };
    }
    renderFeedbackPopup(width, maxRows) {
        const feedback = this.feedback;
        const innerWidth = Math.min(70, width - 2), textWidth = innerWidth - 2;
        const color = feedback.ok
            ? "success"
            : /^(?:Kill (?:failed|rejected)|- action: kill\n- result: (?:failed|rejected)\n)/u.test(feedback.message) ? "error" : "warning";
        const message = `${feedback.message}`;
        const details = this.wrapDocument(message.split(/\r\n|\r|\n/u).map(text => ({ text })), textWidth).map(line => line.text);
        const safety = this.feedbackFromAction ? [...this.closureWarning(textWidth), "No automatic retry."] : [];
        const layout = this.popupLayout(maxRows, safety.length, details.length);
        this.feedbackPageRows = layout.pageRows;
        this.feedbackScroll = Math.min(this.feedbackScroll, Math.max(0, details.length - this.feedbackPageRows));
        const visible = details.slice(this.feedbackScroll, this.feedbackScroll + this.feedbackPageRows);
        return [
            this.border("╭", " Notice ", "╮", innerWidth),
            ...(layout.top ? [this.row("", innerWidth)] : []),
            ...visible.map(line => this.row("  " + this.theme.fg(color, line), innerWidth)),
            ...(layout.paged ? [this.row("  " + this.theme.fg("muted", `${this.feedbackScroll + 1}-${this.feedbackScroll + visible.length}/${details.length} ↑↓ pgup/pgdn`), innerWidth)] : []),
            ...safety.map(line => this.row("  " + this.theme.fg("warning", line), innerWidth)),
            ...(layout.bottom ? [this.row("", innerWidth)] : []),
            this.footerBorder(this.keyHints(["esc", "close"]), innerWidth),
        ];
    }
    closureWarning(width) {
        return width >= visibleWidth("- closure: unconfirmed")
            ? ["- closure: unconfirmed"] : ["- closure:", "  unconfirmed"];
    }
    renderSelector(run, availableRows, width) {
        // Run menu reserves five offset columns, two markers, two borders and one right-padding column.
        const options = this.selectorMode === "run"
            ? this.runSelectorOptions(Math.max(0, width - 10))
            : this.traceSources(run).map((source) => ({
                content: `${this.theme.fg("accent", "Trace:")} ${this.theme.fg("text", source)}`,
                preserveColors: true,
            }));
        return this.renderMenuBox(options, this.selectorIndex, availableRows);
    }
    runSelectorOptions(width) {
        const runs = this.runs();
        const sequenceWidth = Math.max(2, ...runs.map((_item, index) => `#${runs.length - index - 1}`.length));
        const runWidth = Math.max(1, ...runs.map((item) => visibleWidth(item.run)));
        return runs.map((item, index) => ({
            content: truncateToWidth([
                this.theme.fg("text", this.fit(`#${runs.length - index - 1}`, sequenceWidth)),
                this.theme.fg("accent", this.fit(item.run, runWidth)),
                this.theme.fg(this.statusColor(item.status), item.status),
            ].join("  "), width, "…"),
            preserveColors: true,
        }));
    }
    renderMenuBox(options, focusedIndex, availableRows) {
        if (options.length === 0)
            return [this.theme.fg("muted", " No options")];
        const visibleLimit = Math.max(1, Math.min(availableRows - 2, options.length));
        const maxStart = Math.max(0, options.length - visibleLimit);
        const start = Math.max(0, Math.min(focusedIndex - Math.floor(visibleLimit / 2), maxStart));
        const visible = options.slice(start, start + visibleLimit);
        const runMenu = this.selectorMode === "run";
        const width = Math.max(8, ...options.map((option) => visibleWidth(option.content) + (runMenu ? 3 : 4)));
        // Reset both menu edges so sliced document backgrounds cannot bleed through.
        const ownBackground = (line) => runMenu ? `\u001b[49m${line}\u001b[49m` : line;
        const border = (left, right, marker = "") => ownBackground(this.theme.fg("borderAccent", `${left}${marker}${"─".repeat(Math.max(0, width - visibleWidth(marker)))}${right}`));
        return [
            border("╭", "╮", start > 0 ? "↑" : ""),
            ...visible.map((option, offset) => {
                const index = start + offset;
                const marker = index === focusedIndex
                    ? this.theme.fg("accent", runMenu ? "▶ " : " ▶ ")
                    : runMenu ? "  " : "   ";
                const row = this.fit(`${marker}${option.content}`, width - Number(runMenu)) + (runMenu ? " " : "");
                const colored = index === focusedIndex && !option.preserveColors
                    ? this.theme.fg("accent", row)
                    : row;
                const background = index === focusedIndex ? "selectedBg" : runMenu && index % 2 ? "customMessageBg" : undefined;
                // Native truncation emits full SGR resets; repaint each resulting segment.
                const styled = background === undefined ? colored : runMenu
                    ? colored.split("\u001b[0m").map(part => this.theme.bg(background, part)).join("\u001b[0m")
                    : this.theme.bg(background, colored);
                return ownBackground(`${this.theme.fg("borderAccent", "│")}${styled}${this.theme.fg("borderAccent", "│")}`);
            }),
            border("╰", "╯", start + visible.length < options.length ? "↓" : ""),
        ];
    }
    traceTableLine(text, width) {
        const [first = "", ...rest] = text.split(/\r\n|\r|\n/u);
        return truncateToWidth(first + (rest.length ? "…" : ""), width, "…");
    }
    renderTraceList(run, width) {
        const items = this.traceItems(run);
        const summary = this.traceCache.journalSummary ??= RunsTrace.summarizeRunTraceJournal(RunsTrace.readRunTraceJournal(path.join(this.stateRoot, run.run)));
        const banner = summary.history_complete ? [] : [this.theme.fg("warning", width < visibleWidth(" ! Trace history incomplete:") ? " ! Trace incomplete…" : this.traceTableLine(` ! Trace history incomplete: ${summary.compacted ? `${summary.compactions_total} compaction(s), ` : ""}${summary.dropped_event_count_exact ? summary.dropped_events : "unknown"} dropped event(s), ${summary.dropped_bytes} bytes`, width))];
        if (items.length === 0)
            return [...banner, this.theme.fg("muted", " No Trace evidence")];
        if (this.selectedTraceId) {
            const selectedIndex = items.findIndex((item) => item.id === this.selectedTraceId);
            if (selectedIndex >= 0)
                this.rowIndex = selectedIndex;
            else
                this.selectedTraceId = undefined;
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
        const selectedViewportRow = banner.length + this.rowIndex - start;
        if (this.focus === "list" &&
            selectedViewportRow >= banner.length &&
            selectedViewportRow < viewportRows) {
            this.contentSelectedRows.add(selectedViewportRow);
        }
        return [...banner, ...items.slice(start, start + viewportRows - banner.length).map((item, offset) => {
                const index = start + offset;
                const detail = item.detail && typeof item.detail === "object"
                    ? item.detail
                    : {};
                const attention = item.level !== "error" && detail.attention
                    ? this.theme.fg("warning", "A") + " "
                    : "";
                const prefix = this.focus === "list" && index === this.rowIndex
                    ? this.theme.fg("accent", "▶ ")
                    : "  ";
                const chronology = item[TraceProjection.TRACE_ITEM_CHRONOLOGY];
                const sequence = chronology?.state === "available" ? chronology.ordinal : "?";
                const row = `${prefix}${this.theme.fg("text", `#${sequence}`)} ${attention}${this.theme.fg("muted", item.source)}/${this.theme.fg(item.level === "error" ? "error" : "accent", item.kind)}  ${this.theme.fg("text", item.summary)}`;
                const preview = this.traceTableLine(row, width);
                return this.focus === "list" && index === this.rowIndex
                    ? this.theme.fg("accent", preview)
                    : preview;
            })];
    }
    renderTraceDetail(width) {
        if (!this.traceDetail)
            return [this.theme.fg("warning", " Trace row is no longer available")];
        const sequence = this.traceDetail[TraceProjection.TRACE_ITEM_SEQUENCE];
        const value = {
            ...(sequence !== undefined ? { projection_sequence: sequence } : {}),
            ...this.traceDetail,
            chronology: this.traceDetail[TraceProjection.TRACE_ITEM_CHRONOLOGY] ?? { state: "unavailable", reason: "metadata_unavailable" },
        };
        const projection = this.traceDetail.source === "agent" && this.traceDetail.kind === "agent.turn"
            ? this.agentDetailProjection(value, width) : this.documentProjection(value, width);
        const maxStart = Math.max(0, projection.lines.length - this.contentViewportRows());
        this.detailScroll = Math.min(this.detailScroll, maxStart);
        this.contentStripeIndices = projection.stripes.slice(this.detailScroll, this.detailScroll + this.contentViewportRows());
        return projection.lines.slice(this.detailScroll, this.detailScroll + this.contentViewportRows());
    }
    agentDetailSegments(value) {
        const extractedBody = Symbol("extracted-body");
        const bodies = [];
        // Only typed SessionEvidenceTurn slots are bodies. Never inspect authored text for framing.
        const select = (item, field) => {
            if (typeof item === "string") {
                bodies.push({ field, text: item });
                return extractedBody;
            }
            return item;
        };
        const record = value;
        const detail = record.detail;
        let metadata = value;
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
            const retained = Object.fromEntries(Object.entries(detail).map(([key, item]) => {
                if (["assistantText", "userText", "thinking"].includes(key) && typeof item === "string") {
                    return [key, select(item, ["detail", key])];
                }
                if (key !== "toolCalls" || !Array.isArray(item))
                    return [key, item];
                return [key, item.map((call, callIndex) => {
                        if (!call || typeof call !== "object" || Array.isArray(call))
                            return call;
                        return Object.fromEntries(Object.entries(call).map(([name, result]) => {
                            if (name !== "result")
                                return [name, result];
                            const field = ["detail", key, callIndex, name];
                            if (typeof result === "string")
                                return [name, select(result, field)];
                            if (!Array.isArray(result))
                                return [name, result];
                            return [name, result.map((block, blockIndex) => {
                                    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string")
                                        return block;
                                    select(block.text, [...field, blockIndex, "text"]);
                                    return Object.fromEntries(Object.entries(block).filter(([slot]) => slot !== "text"));
                                })];
                        }).filter(([, item]) => item !== extractedBody));
                    })];
            }).filter(([, item]) => item !== extractedBody));
            metadata = { ...record, detail: retained };
        }
        return [{ kind: "metadata", value: metadata }, ...bodies.flatMap(({ field, text }) => [
                { kind: "metadata", value: { field } }, { kind: "body", text },
            ])];
    }
    metadataText(value) {
        // Copy own selected data, so the library cannot invoke an object's toJSON hook.
        const copy = (item) => {
            // UI-only value state: keep an own undefined slot visible, distinct from null or literal text.
            if (item === undefined)
                return { value_state: "undefined" };
            if (typeof item === "function")
                throw new TypeError("Inspector metadata must be selected own data");
            if (!item || typeof item !== "object")
                return item;
            if (Array.isArray(item))
                return Array.from({ length: item.length }, (_, index) => {
                    const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                    if (descriptor && !Object.hasOwn(descriptor, "value"))
                        throw new TypeError("Inspector metadata must be selected own data");
                    return copy(descriptor?.value);
                });
            const result = Object.create(null);
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
                if (!descriptor.enumerable)
                    continue;
                if (!Object.hasOwn(descriptor, "value"))
                    throw new TypeError("Inspector metadata must be selected own data");
                result[key] = copy(descriptor.value);
            }
            return result;
        };
        const document = new Document(copy(value), { version: "1.2", schema: "core", aliasDuplicateObjects: false });
        visit(document, { Pair(_key, pair) {
                if (isScalar(pair.key) && typeof pair.key.value === "string" && pair.key.value.includes("\uFEFF"))
                    pair.key.type = "QUOTE_DOUBLE";
            } });
        return document.toString({ collectionStyle: "block", indent: 2, lineWidth: 0, directives: false,
            defaultStringType: "PLAIN", doubleQuotedAsJSON: true });
    }
    agentDetailProjection(value, width) {
        const segments = this.agentDetailSegments(value);
        const lines = [], stripes = [];
        const markdownTheme = { ...getMarkdownTheme(), codeBlockIndent: "" };
        const detailStripe = Object.keys(value).indexOf("detail");
        const append = (rendered, stripe) => {
            lines.push(...rendered);
            stripes.push(...rendered.map(() => stripe));
        };
        const metadata = (selected, stripe) => {
            // yaml's standard serializer has no completion-wire budget/depth ceiling. Data is already admitted upstream.
            const yaml = this.metadataText(selected).replace(/\n$/u, "");
            append(this.wrapDocument(yaml.split("\n").map(text => ({ text })), width).map(line => this.theme.fg("muted", line.text)), stripe);
        };
        segments.forEach((segment, index) => {
            if (index)
                append([""], detailStripe);
            if (segment.kind === "body") {
                append(new Markdown(segment.text, 0, 0, markdownTheme, { color: text => this.theme.fg("text", text) }).render(width), detailStripe);
            }
            else if (index === 0) {
                // Serialize root entries separately to retain root-field stripe provenance without parsing YAML rows.
                Object.entries(segment.value).forEach(([key, item], stripe) => metadata({ [key]: item }, stripe));
            }
            else {
                if (segments[index + 1]?.kind === "body")
                    append([this.theme.fg("muted", "---")], detailStripe);
                metadata(segment.value, detailStripe);
                if (segments[index + 1]?.kind === "body")
                    append([this.theme.fg("muted", "---")], detailStripe);
            }
        });
        return { lines, stripes };
    }
    controlDocument(run, stateDir) {
        return this.controlObservation(run, stateDir).document;
    }
    controlObservation(run, stateDir = path.join(this.stateRoot, run.run)) {
        if (this.controlCache?.run === run.run && this.controlCache.generation === run.runInstanceId)
            return this.controlCache;
        const meta = this.readRunMeta(stateDir);
        const bound = Boolean(meta && !Array.isArray(meta) && run.runInstanceId && meta.run === run.run
            && meta.run_instance_id === run.runInstanceId && meta.ownerId === this.ownerId);
        const diagnostics = [];
        let actions = [];
        if (!bound)
            diagnostics.push({ reason: "metadata_binding_unavailable" });
        else {
            try {
                actions = normalizeRecipeControl(meta.control) ?? [];
            }
            catch {
                diagnostics.push({ reason: "invalid_action_declarations" });
            }
        }
        const endpoint = bound ? RunControlDelivery.readRunControlEndpoint(stateDir, run.runInstanceId) : undefined;
        const journal = bound ? RunsControls.readRunControlJournalFromStateDir(stateDir) : { records: [], diagnostics: [] };
        diagnostics.push(...journal.diagnostics.map(item => item.line === undefined
            ? { reason: "unreadable_control_journal" } : { reason: "invalid_control_json", line: item.line }));
        const now = Date.now();
        const ids = new Map();
        for (const value of journal.records) {
            if (value && typeof value === "object" && typeof value.id === "string") {
                const id = value.id;
                ids.set(id, (ids.get(id) ?? 0) + 1);
            }
        }
        const accepted = [];
        for (const [parsedIndex, value] of journal.records.entries()) {
            const classification = RuntimeTriage.classifyRuntimeControl(run, value, now);
            if (classification.diagnostic) {
                diagnostics.push({ reason: classification.diagnostic.reason });
                continue;
            }
            const record = value;
            if (record.run_instance_id !== run.runInstanceId) {
                diagnostics.push({ reason: "foreign_generation" });
                continue;
            }
            if (ids.get(record.id) !== 1) {
                diagnostics.push({ reason: "duplicate_control_id" });
                continue;
            }
            if (["queued_at", "delivered_at", "claimed_at", "handled_at", "failed_at"].some(field => {
                const timestamp = record[field];
                return (field === "queued_at" || timestamp !== undefined) && (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)));
            })) {
                diagnostics.push({ reason: "invalid_record_timestamp" });
                continue;
            }
            accepted.push({ id: record.id, value: ControlProjection.projectRunControl(record), parsedIndex,
                age: Math.max(0, now - Date.parse(runControlStatusTimestamp(record, record.status))),
                reason: classification.stale?.reason });
        }
        const capacity = computeRunControlCapacity(journal.records);
        const partial = diagnostics.length > 0;
        const rows = accepted.filter(row => row.parsedIndex >= journal.records.length - 20).reverse();
        const readiness = partial ? "data_unavailable" : run.status !== "running" ? "not_ready"
            : !actions.length ? "unsupported" : capacity.backpressured ? "backpressure" : endpoint ? "ready_recorded_endpoint" : "not_ready";
        const reason = partial ? "partial_observation" : run.status !== "running" ? "run_terminal"
            : !actions.length ? "no_declared_actor_actions" : capacity.backpressured ? "pending_limit_reached"
                : endpoint ? "recorded_endpoint_only_not_connection_proof" : "recorded_endpoint_unavailable";
        this.controlCache = { run: run.run, generation: run.runInstanceId, rows, document: {
                actor_control_readiness: readiness, reason, actor_actions: actions,
                data_state: partial ? "partial" : "available", pending: bound ? capacity.pending : null,
                pending_limit: capacity.limit, available: partial ? null : capacity.available,
                backpressured: bound ? capacity.backpressured : null,
                runtime_actions: bound ? run.status === "running" ? this.killRun && run.runInstanceId ? ["kill"] : [] : ["archive", "prune"] : [],
                runtime_actions_note: "API capabilities; only existing Run-focus Kill is interactive",
                request_history: { shown: rows.length, retained: journal.records.length, parsed_suffix_limit: 20,
                    partial: partial || journal.records.length > 20, coverage: "recent parsed journal records; malformed-line coverage unavailable; not complete lifetime history" },
                request_navigation: "Enter opens requests; Down scrolls overview",
                evidence: "Saved non-atomic observation; delivered != handled; handled != Run completion; stale never expires requests",
                status: run.status, run_instance_id: run.runInstanceId,
                journal_bytes: (() => { try {
                    return statSync(RunsControls.runControlsFile(stateDir)).size;
                }
                catch {
                    return null;
                } })(),
                journal_limit: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES,
                stale_pending: accepted.filter(row => row.reason).length, diagnostics,
                endpoint, recent_controls: rows.map(row => row.value),
            } };
        return this.controlCache;
    }
    selectedControl(observation) {
        const selection = this.controlSelection;
        return selection?.run === observation.run && selection.generation === observation.generation
            ? observation.rows.find(row => row.id === selection.id) : undefined;
    }
    openControlList(run) {
        this.focus = "list";
        this.rowIndex = 0;
        const observation = run ? this.controlObservation(run) : undefined;
        const first = observation?.rows[0];
        this.controlSelection = first ? { run: observation.run, generation: observation.generation, id: first.id } : undefined;
    }
    handleControlInput(data, run) {
        if (matchesKey(data, "escape") || matchesKey(data, "left")) {
            this.focus = this.focus === "detail" ? "list" : "tabs";
            this.detailScroll = 0;
            return;
        }
        if (!run)
            return;
        const observation = this.controlObservation(run);
        const selected = this.selectedControl(observation);
        if (this.focus === "detail") {
            this.handleScrollableInput(data, "detail");
            return;
        }
        const index = selected ? observation.rows.indexOf(selected) : -1;
        let next = index;
        if (matchesKey(data, "up"))
            next = Math.max(0, index - 1);
        else if (matchesKey(data, "down"))
            next = Math.min(observation.rows.length - 1, index + 1);
        else if (matchesKey(data, "pageUp"))
            next = Math.max(0, index - this.contentViewportRows());
        else if (matchesKey(data, "pageDown"))
            next = Math.min(observation.rows.length - 1, index + this.contentViewportRows());
        else if ((matchesKey(data, "return") || matchesKey(data, "right")) && selected) {
            this.focus = "detail";
            this.detailScroll = 0;
            return;
        }
        if (next !== index && observation.rows[next])
            this.controlSelection = {
                run: observation.run, generation: observation.generation, id: observation.rows[next].id,
            };
    }
    renderControlContent(run, width) {
        const observation = this.controlObservation(run);
        const selected = this.selectedControl(observation);
        if (this.focus === "detail") {
            const projection = this.documentProjection(selected ? selected.value : { request: "unavailable", reason: "selected Run/generation/id no longer available" }, width);
            this.detailScroll = Math.min(this.detailScroll, Math.max(0, projection.lines.length - this.contentViewportRows()));
            this.contentStripeIndices = projection.stripes.slice(this.detailScroll, this.detailScroll + this.contentViewportRows());
            return projection.lines.slice(this.detailScroll, this.detailScroll + this.contentViewportRows());
        }
        const coverage = observation.document.request_history;
        const banner = this.traceTableLine(` Requests ${coverage.shown}/${coverage.retained} parsed; recent20${coverage.partial ? "; partial" : ""}`, width);
        if (!observation.rows.length)
            return [banner, " No requests", this.traceTableLine(" Saved observation; history may be partial", width)];
        const index = selected ? observation.rows.indexOf(selected) : -1;
        const count = Math.max(1, this.contentViewportRows() - 2);
        const start = Math.max(0, index - Math.floor(count / 2));
        const rows = observation.rows.slice(start, start + count);
        this.contentStripeIndices = [0, 0, ...rows.map((_row, offset) => start + offset + 1)];
        if (index >= start)
            this.contentSelectedRows.add(index - start + 2);
        return [banner, this.traceTableLine(index < 0 ? " Selection unavailable; arrows select a request" : " Status | action | status age | error/stale", width),
            ...rows.map(row => this.traceTableLine(`${row === selected ? "▶" : " "} ${row.value.status} | ${row.value.action} | ${Math.floor(row.age / 1000)}s | ${row.value.error ?? row.reason ?? ""}`, width))];
    }
    allTraceItems(run) {
        if (!run)
            return [];
        if (this.traceCache?.run === run.run &&
            this.traceCache.runInstanceId === run.runInstanceId) {
            return this.traceCache.items;
        }
        const items = this.readTrace(path.join(this.stateRoot, run.run), {
            limit: 100,
            source: "all",
        });
        this.traceCache = { run: run.run, runInstanceId: run.runInstanceId, items };
        return items;
    }
    traceSources(run) {
        const present = new Set(this.allTraceItems(run).map((item) => item.source));
        return TRACE_SOURCES.filter((source) => source === "all" || present.has(source));
    }
    traceSource(run) {
        const sources = this.traceSources(run);
        this.traceSourceIndex %= sources.length;
        return sources[this.traceSourceIndex] ?? "all";
    }
    traceItems(run) {
        const source = this.traceSource(run);
        const items = this.allTraceItems(run);
        return source === "all" ? items : items.filter((item) => item.source === source);
    }
    readRunMeta(stateDir) {
        try {
            return JSON.parse(readFileSync(path.join(stateDir, "run.json"), "utf8"));
        }
        catch {
            return {};
        }
    }
    documentProjection(value, width) {
        // Copy before enumerating roots: accessors and hooks must never run during projection.
        const selected = this.metadataText(value);
        const descriptors = value && typeof value === "object" && !Array.isArray(value)
            ? Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) => descriptor.enumerable) : [];
        const sections = descriptors.length
            ? descriptors.map(([key, descriptor]) => this.metadataText({ [key]: descriptor.value }))
            : [selected];
        const lines = [];
        const stripes = [];
        sections.forEach((section, sectionIndex) => {
            const wrapped = this.wrapDocument(section.replace(/\n$/u, "").split("\n").map(text => ({ text })), width);
            lines.push(...wrapped.map((line) => this.theme.fg("muted", line.text)));
            stripes.push(...wrapped.map(() => sectionIndex));
        });
        return { lines, stripes };
    }
    wrapDocument(lines, width) {
        return lines.flatMap((line) => {
            // Keep the existing terminal tab display policy; never alter the source value.
            const text = line.text.replaceAll("\t", "  ");
            const label = line.label?.replaceAll("\t", "  ");
            if (visibleWidth(text) <= width)
                return [{ text, label }];
            const leading = text.match(/^ */u)?.[0] ?? "";
            const hanging = label === undefined ? leading : `${leading}  `;
            const continuation = hanging.length <= width - 2 ? hanging : "";
            const wrapped = [];
            const columns = visibleWidth(text);
            let offset = 0;
            while (offset < columns) {
                const prefix = offset === 0 ? "" : continuation;
                const available = width - visibleWidth(prefix);
                // Native cell slicing keeps graphemes; retain separators instead of trimming authored spaces.
                let part = sliceByColumn(text, offset, available, true);
                const preferred = Math.max(part.lastIndexOf(" "), part.lastIndexOf("/"), part.lastIndexOf(","));
                if (offset + visibleWidth(part) < columns && preferred >= Math.floor(part.length * 0.6)) {
                    part = sliceByColumn(text, offset, visibleWidth(part.slice(0, preferred + 1)), true);
                }
                const consumed = visibleWidth(part);
                const labelPart = label === undefined ? "" : sliceByColumn(label, offset, consumed, true);
                wrapped.push({ text: prefix + part, ...(labelPart ? { label: prefix + labelPart } : {}) });
                offset += consumed;
            }
            return wrapped;
        });
    }
    keyHints(...items) {
        const hint = (keys, description) => `${this.theme.fg("accent", keys)}${this.theme.fg("borderAccent", ` ${description}`)}`;
        const divider = this.theme.fg("borderAccent", " ─ ");
        return items.map(([keys, description]) => hint(keys, description)).join(divider);
    }
    renderKeyHints(killConfirmation = false) {
        if (killConfirmation) {
            return this.keyHints(["←→/tab", "choose"], ["enter", "pick"], ["y", "kill"], ["esc/n", "cancel"]);
        }
        if (this.focus === "select") {
            return this.keyHints(["↑↓", "option"], ["enter/→", "apply"], ["←/esc", "back"]);
        }
        if (this.focus === "detail") {
            return this.keyHints(["↑↓/pgup/pgdn", "scroll"], ["←/esc", "back"]);
        }
        if (this.tab === "control" && this.focus === "document") {
            return this.keyHints(["↑↓/pgup/pgdn", "scroll"], ["enter", "requests"], ["←/esc", "tabs"]);
        }
        if (this.tab === "control" && this.focus === "list") {
            return this.keyHints(["↑↓/pgup/pgdn", "row"], ["→/enter", "YAML"], ["←/esc", "tabs"]);
        }
        if (this.tab === "control" && this.focus === "tabs") {
            return this.keyHints(["←→", "tabs"], ["↓", "overview"], ["enter", "requests"], ["esc", "close"]);
        }
        if (this.focus === "document") {
            return this.keyHints(["↑↓/pgup/pgdn", "scroll"], ["↑ at top", "tabs"], ["←/esc", "tabs"]);
        }
        if (this.focus === "list") {
            return this.keyHints(["↑↓/pgup/pgdn", "row"], ["→/enter", "open"], ["←", "tabs"], ["esc", "close"]);
        }
        if (this.focus === "runs") {
            const items = [["←→", "run"], ["↓", "tabs"], ["enter", "list"]];
            const run = this.runs()[this.runIndex];
            if (this.killRun && run?.status === "running" && run.runInstanceId)
                items.push(["k", "kill"]);
            items.push(["esc", "close"]);
            return this.keyHints(...items);
        }
        return this.tab === "trace"
            ? this.keyHints(["←→", "tabs"], ["↑↓", "focus"], ["enter/f", "source"], ["esc", "close"])
            : this.keyHints(["←→", "tabs"], ["↑↓", "focus"], ["enter", "open"], ["esc", "close"]);
    }
    statusColor(status) {
        if (status === "failed")
            return "error";
        if (status === "running")
            return "warning";
        if (status === "done" || status === "terminal")
            return "success";
        return "muted";
    }
    footerBorder(hints, width) {
        const prefix = " ";
        const suffix = " ─";
        const content = truncateToWidth(hints, Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix)), "");
        const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - visibleWidth(content)));
        return `${this.theme.fg("borderAccent", `╰${prefix}`)}${content}${this.theme.fg("borderAccent", `${suffix}${fill}╯`)}`;
    }
    compositeMenuLine(baseLine, menuLine, innerWidth, horizontalOffset) {
        const offset = Math.max(0, Math.min(horizontalOffset, innerWidth));
        const menuWidth = Math.min(innerWidth - offset, visibleWidth(menuLine));
        const baseInner = sliceByColumn(baseLine, 1, innerWidth, true);
        const prefix = sliceByColumn(baseInner, 0, offset, true);
        const suffixStart = offset + menuWidth;
        const suffix = sliceByColumn(baseInner, suffixStart, Math.max(0, innerWidth - suffixStart), true);
        const remainder = this.fit(suffix, innerWidth - suffixStart);
        return `${this.theme.fg("borderAccent", "│")}${this.fit(prefix, offset)}${truncateToWidth(menuLine, menuWidth, "")}${remainder}${this.theme.fg("borderAccent", "│")}`;
    }
    stripeBackground(content, index) {
        return index % 2 === 0 ? content : this.theme.bg("customMessageBg", content);
    }
    stripedRow(content, width, index, selected) {
        if (!selected) {
            const fitted = this.fit(content, width);
            return `${this.theme.fg("borderAccent", "│")}${this.stripeBackground(fitted, index)}${this.theme.fg("borderAccent", "│")}`;
        }
        const selectedContent = truncateToWidth(`${content} `, width, "");
        const remainder = " ".repeat(Math.max(0, width - visibleWidth(selectedContent)));
        return `${this.theme.fg("borderAccent", "│")}${this.theme.bg("selectedBg", selectedContent)}${this.stripeBackground(remainder, index)}${this.theme.fg("borderAccent", "│")}`;
    }
    row(content, width) {
        return `${this.theme.fg("borderAccent", "│")}${this.fit(content, width)}${this.theme.fg("borderAccent", "│")}`;
    }
    border(left, label, right, width) {
        const bounded = truncateToWidth(label, width, "");
        return this.theme.fg("borderAccent", `${left}${bounded}${"─".repeat(Math.max(0, width - visibleWidth(bounded)))}${right}`);
    }
    fit(content, width) {
        const bounded = truncateToWidth(content, width, "");
        return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
    }
    center(content, width) {
        const padding = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
        return `${" ".repeat(padding)}${content}`;
    }
}
