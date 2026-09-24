/**
 * Keyboard-driven Actor Inspector overlay for concrete Run instances.
 * Zones: owned actor selection, Recipe/Trace/Control tabs, safe Run Kill confirmation
 * Owns manual kernel navigation; evidence parsing and lifecycle mutation stay in ports.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";
import * as ActorInspector from "./inspector.ts";
import * as TraceProjection from "./trace-projection.ts";
export type ActorInspectorTab = "recipe" | "trace" | "control";
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
export declare class ActorInspectorOverlay {
    private readonly done;
    private readonly killRun?;
    private readonly ownerId;
    private readonly readRuns;
    private readonly readTrace;
    private readonly stateRoot;
    private readonly theme;
    private readonly tui;
    private readonly refreshTimer;
    private contentSelectedRows;
    private contentStripeIndices;
    private documentScroll;
    private detailScroll;
    private feedback?;
    private focus;
    private killConfirmation?;
    private killDialogChoice;
    private rowIndex;
    private runCache?;
    private selectedTraceId?;
    private runIndex;
    private selectorIndex;
    private selectorMode?;
    private tabIndex;
    private traceCache?;
    private traceDetail?;
    private traceSourceIndex;
    constructor(options: ActorInspectorOverlayOptions);
    dispose(): void;
    invalidate(): void;
    handleInput(data: string): void;
    render(width: number): string[];
    private get tab();
    private runs;
    private contentViewportRows;
    private resetContentPosition;
    private cycleRun;
    private handleScrollableInput;
    private handleSelectorInput;
    private openSourceSelector;
    private cycleTraceSource;
    private requestKill;
    private handleKillInput;
    private confirmKill;
    private renderKillDialog;
    private renderRunControl;
    private renderTabs;
    private renderContent;
    private renderSelector;
    private runSelectorOptions;
    private renderMenuBox;
    private renderTraceList;
    private renderTraceDetail;
    private controlDocument;
    private allTraceItems;
    private traceSources;
    private traceSource;
    private traceItems;
    private readRunMeta;
    private documentProjection;
    private inlineDocumentValue;
    private labeledDocumentLines;
    private labeledScalarLines;
    private document;
    private wrapDocument;
    private styleDocumentLine;
    private visiblePrefix;
    private renderKeyHints;
    private statusColor;
    private footerBorder;
    private compositeMenuLine;
    private stripeBackground;
    private stripedRow;
    private row;
    private border;
    private fit;
    private center;
}
