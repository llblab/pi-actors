/**
 * Persistent tool registry config helpers
 * Zones: registry config, persistence, normalization
 * Owns registered-tool config loading, normalization, unsupported-shape rejection, and serialization
 */
import type { CommandTemplateValue } from "./command-templates.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as Schema from "./schema.ts";
export interface RegisteredTool {
    name: string;
    description: string;
    args: string[];
    defaults: Record<string, string>;
    argTypes?: Record<string, Schema.ToolArgType>;
    recipe?: RecipesReferences.TemplateRecipeConfig;
    template?: CommandTemplateValue;
    storedArgs?: string[];
    storedDefaults?: Record<string, string>;
    sourcePath?: string;
}
export interface LoadConfigResult {
    tools: Map<string, RegisteredTool>;
    warnings: string[];
    changed: boolean;
}
export declare function serializeTools(source: Map<string, RegisteredTool>): Record<string, unknown>;
export declare function saveTools(path: string, source: Map<string, RegisteredTool>): string | undefined;
export declare function getStoredEntries(raw: unknown): Array<[string | undefined, unknown]>;
export declare function normalizeStoredTool(key: string | undefined, value: unknown, reservedToolNames: Set<string>): {
    cfg?: RegisteredTool;
    changed: boolean;
    warning?: string;
};
export declare function loadToolConfig(path: string, reservedToolNames: Set<string>): LoadConfigResult;
