/**
 * Template recipe reference helpers
 * Zones: registry config, async runs, path resolution
 * Owns detection, loading, and recipe-layer expansion for template recipe files
 */
import type { CommandTemplateValue } from "./command-templates.ts";
import * as CommandTemplates from "./command-templates.ts";
export interface TemplateRecipeImportBinding {
    from?: string;
    defaults?: Record<string, unknown>;
    values?: Record<string, unknown>;
}
export type TemplateRecipeImport = string | TemplateRecipeImportBinding;
export interface TemplateRecipeDefinition {
    description?: string;
    disabled?: boolean;
    singleton?: boolean;
    imports?: Record<string, TemplateRecipeImport>;
    template: CommandTemplateValue;
    args?: string[];
    defaults?: Record<string, unknown>;
    parallel?: boolean;
    concurrency?: number | string;
    min_successful?: number | string;
    label?: string;
    when?: boolean | string;
    timeout?: number | string;
    delay?: number | string;
    accept_output?: "review_evidence";
    output?: string;
    artifacts?: Record<string, string>;
    control?: string[];
    retire_when?: "children_terminal";
    retry?: number | string;
    failure?: CommandTemplates.CommandTemplateFailureScope;
    recover?: CommandTemplateValue;
    repeat?: number;
    values?: Record<string, unknown>;
    usage?: Record<string, unknown>;
}
export interface TemplateRecipeConfig extends TemplateRecipeDefinition {
    name?: string;
    async?: boolean;
    recipe_dir?: string;
    skill_dir?: string;
    singleton_run_id?: string;
    singleton_recipe_id?: string;
}
export interface TemplateRecipeContextRecord {
    alias?: string;
    depth: number;
    import_path: string[];
    logical_reference: string;
    name: string;
    recipe: Record<string, unknown>;
    role: "entry" | "import";
    skill?: string;
    source_file: string;
    source_kind: "active_skill_component" | "explicit_file_recipe" | "user_registry_capability";
}
export interface ReadResolvedRecipeConfigOptions {
    authoredEntry?: {
        path: string;
        recipe: Record<string, unknown>;
    };
    includeActorRecipeContext?: boolean;
    skillContext?: ActiveSkillRecipeContext;
}
export declare const RUNTIME_OWNED_RECIPE_INPUT_NAMES: readonly string[];
export declare function isRuntimeOwnedRecipeInput(name: string): boolean;
export interface ActiveSkillRecipeSource {
    name: string;
    filePath?: string;
    baseDir?: string;
}
export interface ActiveSkillRecipeContext {
    readonly namespaces: Readonly<Record<string, readonly string[]>>;
}
export declare function createActiveSkillRecipeContext(skills: ActiveSkillRecipeSource[]): ActiveSkillRecipeContext;
export declare const EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT: ActiveSkillRecipeContext;
export declare function getActiveSkillRecipeNamespaces(context: ActiveSkillRecipeContext): Record<string, string[]>;
export interface ActiveSkillRecipeComponent {
    file: string;
    identity: string;
    imports: Record<string, string>;
    skill: string;
    stem: string;
}
export interface SkillRecipeComponentDiagnostic {
    file?: string;
    reason: string;
    skill: string;
    stem?: string;
}
export interface SkillRecipeComponentInventory {
    components: ActiveSkillRecipeComponent[];
    partial: boolean;
    rejected: SkillRecipeComponentDiagnostic[];
}
export declare function inventoryActiveSkillRecipeComponents(context: ActiveSkillRecipeContext): SkillRecipeComponentInventory;
export declare function listActiveSkillRecipeComponents(context: ActiveSkillRecipeContext): ActiveSkillRecipeComponent[];
export declare function resolveRecipePath(value: string, baseDir?: string): string;
export declare function resolveRecipeReferencePath(value: unknown, baseDir?: string, context?: ActiveSkillRecipeContext): string | undefined;
export declare function getRecipePath(value: unknown, baseDir?: string, context?: ActiveSkillRecipeContext): string | undefined;
export declare function diagnoseRawRecipeConfigFailure(path: string): string | undefined;
export declare function readRawRecipeConfig(path: string): Record<string, unknown> | undefined;
export declare function getRecipeIdFromPath(file: string): string;
export declare function readResolvedRecipeConfig(file: string, stack?: string[], options?: ReadResolvedRecipeConfigOptions): TemplateRecipeConfig | undefined;
export declare function buildRecipeContextRecords(file: string, context?: ActiveSkillRecipeContext): TemplateRecipeContextRecord[];
export declare function getRecipeTemplate(value: unknown): CommandTemplateValue | undefined;
export declare function isRecipeReference(value: unknown): boolean;
export declare function isAsyncRecipeReference(value: unknown): boolean;
export declare function isRecipeTool(template: unknown, recipe: TemplateRecipeConfig | undefined): boolean;
