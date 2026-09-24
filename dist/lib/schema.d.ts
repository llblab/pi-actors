/**
 * Auto-tools schema helpers
 * Zones: tool schema, registry args, command-template placeholders
 * Owns tool argument declarations, placeholder-derived tool schemas, and persisted registry normalization
 */
import * as CommandTemplates from "./command-templates.ts";
export type ToolArgType = {
    kind: "string";
} | {
    kind: "path";
} | {
    kind: "int";
} | {
    kind: "number";
} | {
    kind: "bool";
} | {
    kind: "array";
} | {
    kind: "enum";
    values: string[];
};
export interface ParsedToolArgToken {
    arg: string;
    defaultValue?: string;
    declaration: string;
    type: ToolArgType;
}
export interface ToolArgSpec {
    args: string[];
    argTypes: Record<string, ToolArgType>;
    declarations: string[];
    defaults: Record<string, string>;
    error?: string;
}
export type JsonSchema = Record<string, unknown>;
export declare function stringSchema(description: string): JsonSchema;
export declare function typedArgSchema(description: string, type: ToolArgType | undefined): JsonSchema;
export declare function booleanSchema(description: string): JsonSchema;
export declare function nullSchema(description: string): JsonSchema;
export declare function arraySchema(description: string): JsonSchema;
export declare function unionSchema(anyOf: JsonSchema[]): JsonSchema;
export declare function objectSchema(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema;
export declare function looseObjectSchema(description: string): JsonSchema;
export declare function parseToolArgToken(value: string): ParsedToolArgToken;
export declare function parseToolArgDeclarations(value: string): ToolArgSpec;
export declare function parseToolArgDeclarationList(value: unknown[]): ToolArgSpec;
export declare function normalizeStoredToolArgDeclarations(argsValue: unknown, defaultsValue: unknown): ToolArgSpec & {
    changed: boolean;
    provided: boolean;
};
export declare function formatToolArgs(args: string[]): string;
export declare function getTemplatePlaceholderNames(config: CommandTemplates.CommandTemplateConfig): string[];
export declare function assertCompatibleToolArgTypes(...sources: Array<Record<string, ToolArgType> | undefined>): void;
export declare function getTemplateArgTypes(config: CommandTemplates.CommandTemplateConfig): Record<string, ToolArgType>;
export declare function getExplicitToolArgNames(args: string[] | undefined): string[];
export declare function getExplicitToolArgDefaults(args: string[] | string | undefined): Record<string, string>;
export declare function getToolArgNames(config: CommandTemplates.CommandTemplateConfig): string[];
export declare function getRequiredToolArgNames(config: CommandTemplates.CommandTemplateConfig): Set<string>;
export declare function normalizeRuntimeValues(values: Record<string, unknown>, argTypes: Record<string, ToolArgType> | undefined): Record<string, unknown>;
