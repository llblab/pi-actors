/**
 * Shared response formatting.
 * Zones: compact text summaries, snapshot/literal rendering, JSON switching, next-action rendering.
 * Owns model-facing formatting shared by tool and coordinator delivery paths.
 * Excludes: evidence reads/admission, source visibility, clock measurement and lifecycle/delivery authority.
 */
export type YamlMetadataRendering = {
    readonly state: "available";
    readonly text: string;
} | {
    readonly state: "unavailable";
    readonly reason: "budget_invalid" | "metadata_invalid" | "metadata_too_large";
};
/** Pure selected-metadata formatting, not admission or authority. */
export declare function renderYamlMetadata(value: unknown, byteBudget: number): YamlMetadataRendering;
export type YamlPart = {
    full: Record<string, unknown>;
    selected: Record<string, unknown>;
};
/** One selected metadata node, kept whole or covered by a field/group omission. */
export declare function selectYamlNode(key: string, value: unknown, byteBudget: number, total?: number): YamlPart;
/** Opaque selected text or string sequence; malformed selections stay unavailable without repair. */
export declare function selectYamlField(key: string, value: string | readonly string[], byteBudget: number): YamlPart;
/** Grow whole selected fields in priority order while the complete document still fits. */
export declare function growYamlDocument(render: () => Record<string, unknown>, order: readonly YamlPart[], byteBudget: number): string;
/** Uncapped UI-only flat metadata; never borrow a model-output allowance for notices. */
export declare function formatYamlNotice(value: Record<string, string | number | boolean>): string;
/** Close one rendered YAML header; a separate opaque body gets exactly one delimiter pair. */
export declare function frameMetadataDocument(header: string, body?: string): string;
export declare function formatMarkdownField(key: string, value: string, depth?: number): string;
export declare function formatInspectNextAction(target: string, view: string, verbose?: boolean): string;
export declare function formatLiteralBlock(value: string): string;
export type RunSnapshotRendering = {
    readonly state: "available";
    readonly text: string;
} | {
    readonly state: "unavailable";
    readonly reason: "snapshot_invalid" | "snapshot_too_large" | "format_invalid" | "render_too_large";
};
/** Pure formatting of already-admitted snapshots. DTO/schema validity is NOT source, timing, visibility or lifecycle authority. */
export declare function renderRunSnapshot(value: unknown, format?: "text" | "json"): Readonly<RunSnapshotRendering>;
export declare function withLeadingLineBreak(text: string): string;
export declare function spaceToolResult<T>(result: T): T;
export declare function spaceToolError(error: unknown): unknown;
export declare function asRecord(value: unknown): Record<string, unknown>;
export declare function jsonText(value: unknown): string;
export declare function compactPreview(value: unknown, maxLength?: number): string | undefined;
export declare function compactNextActions(actions: string[]): string;
/** Frozen older completion-format text: new launch layout must not change this shared packet helper. */
export declare function formatRunFileNavigationHandoff(): string;
export declare function runNextActions(run: unknown): string[];
export declare function compactAsyncRunStatus(value: unknown): string;
export declare function maybeJsonText(value: unknown, verbose: boolean | undefined, compact: string): string;
/** Full spawn metadata retains legacy JSON selection; projection is not launch or source authority. */
export declare function spawnMetadataText(value: unknown, verbose: boolean | undefined, compact: string): string;
export declare function compactRecipeImports(summary: Record<string, unknown>): string;
export declare function compactRecipeDoctor(summary: Record<string, unknown>): string;
export declare function recipeRegistryNextActions(summary: Record<string, unknown>, view: string): string[];
/** Compact metadata-only document text: one leading LF, no trailing LF, shared emitter budget. */
export declare function compactYamlDocument(value: Record<string, unknown>): string;
/** Only the closed read-only Recipe inspect literals become typed next; other advice stays opaque content. */
export declare function nextActionMetadata(action: string, byteBudget: number): YamlPart;
/** Only these existing read-only inspection hints become action nodes; other advice stays content. */
export declare function formatInspectionHint(action: string): string;
export declare function compactRecipeRegistry(summary: Record<string, unknown>): string;
export declare const DEFAULT_INSPECT_LINES = 40;
