/**
 * Public register_tool behavior
 * Zones: runtime tool registration, tool registry mutation, register_tool schema
 * Owns the public register_tool definition that persists local agent capabilities
 */
import * as Registry from "./registry.ts";
import * as Schema from "./schema.ts";
export type RegisterToolInput = Registry.RegisterToolInput;
export type RegisterToolRuntimeDeps<TContext> = Registry.RegisterToolRuntimeDeps<TContext>;
export declare function createRegisterToolDefinition<TContext>(deps: RegisterToolRuntimeDeps<TContext>): {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: Schema.JsonSchema;
    execute: (_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: TContext) => Promise<Registry.RegisterToolResult>;
};
