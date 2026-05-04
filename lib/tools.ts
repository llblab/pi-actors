/**
 * Pi-facing tool definition helpers
 * Owns generated runtime tool schemas and the register_tool management tool schema
 */

import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import * as Prompts from "./prompts.ts";
import * as Registry from "./registry.ts";
import * as Schema from "./schema.ts";

export type RegisterToolInput = Registry.RegisterToolInput;
export type RegisterToolRuntimeDeps<TContext> =
  Registry.RegisterToolRuntimeDeps<TContext>;

type JsonSchema = Record<string, unknown>;

function stringSchema(description: string): JsonSchema {
  return { description, type: "string" };
}

function booleanSchema(description: string): JsonSchema {
  return { description, type: "boolean" };
}

function nullSchema(description: string): JsonSchema {
  return { description, type: "null" };
}

function arraySchema(description: string): JsonSchema {
  return { description, items: {}, type: "array" };
}

function unionSchema(anyOf: JsonSchema[]): JsonSchema {
  return { anyOf };
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema {
  return { additionalProperties: false, properties, required, type: "object" };
}

export function createRegisterToolDefinition<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
) {
  return {
    name: "register_tool",
    label: "Register Tool",
    description: Prompts.REGISTER_TOOL_DESCRIPTION,
    promptSnippet: Prompts.REGISTER_TOOL_PROMPT_SNIPPET,
    promptGuidelines: Prompts.REGISTER_TOOL_GUIDELINES,
    parameters: objectSchema(
      {
        args: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.args),
        description: stringSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.description,
        ),
        name: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.name),
        template: unionSchema([
          stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
          arraySchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateArray),
          nullSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateNull),
        ]),
        update: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.update),
      },
      ["name"],
    ),
    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) => Registry.executeRegisterTool(params, ctx, deps),
  };
}

export function createRuntimeToolDefinition(
  cfg: RegisteredTool,
  exec: Execution.RegisteredToolExec,
) {
  const paramSchema: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const requiredArgs = Schema.getRequiredToolArgNames({
    args: cfg.args,
    defaults: cfg.defaults,
    template: cfg.template,
  });
  for (const arg of cfg.args) {
    paramSchema[arg] = stringSchema(`Argument: ${arg}`);
    if (requiredArgs.has(arg)) required.push(arg);
  }
  return {
    name: cfg.name,
    label: cfg.name,
    description: cfg.description,
    parameters: objectSchema(paramSchema, required),
    promptSnippet: Prompts.formatRegisteredToolPromptSnippet(cfg.template),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      return Execution.executeRegisteredTool(
        cfg,
        params as Record<string, unknown>,
        exec,
        ctx.cwd,
        signal,
      );
    },
  };
}
