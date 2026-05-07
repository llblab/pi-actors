/**
 * Pi-facing tool definition helpers
 * Zones: pi tools, registry tools, job launchers
 * Owns generated runtime tool schemas and the register_tool management tool schema
 */

import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import * as Jobs from "./jobs.ts";
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

function looseObjectSchema(description: string): JsonSchema {
  return { additionalProperties: true, description, type: "object" };
}

function jsonText(value: unknown): string {
  return `\n${JSON.stringify(value, null, 2)}`;
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
        job: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.job),
        template: unionSchema([
          stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
          arraySchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateArray),
          nullSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateNull),
        ]),
        update: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.update),
      },
      [],
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

export function createJobToolDefinition<TContext extends { cwd: string }>(
  deps: { getTools: () => Map<string, RegisteredTool> },
): any {
  return {
    name: "template_job",
    label: "Template Job",
    description: "Manage detached template jobs. Actions: start, status, tail, list, cancel.",
    parameters: objectSchema(
      {
        action: stringSchema("Action: start, status, tail, list, or cancel."),
        file: stringSchema("Optional template job JSON file for start. Bare names resolve under ~/.pi/agent/jobs."),
        job: stringSchema("Job id or state directory. Required for status, tail, and cancel. Optional for start."),
        lines: stringSchema("Tail line count for tail. Default 40."),
        state_dir: stringSchema("Optional job state directory for start. Defaults to ~/.pi/agent/tmp/pi-auto-tools/jobs/{job}."),
        state_root: stringSchema("Optional state root for list. Defaults to ~/.pi/agent/tmp/pi-auto-tools/jobs."),
        template: unionSchema([
          stringSchema("Command template string for start"),
          arraySchema("Command template sequence or mode tree for start"),
        ]),
        tool: stringSchema("Optional registered auto-tool name to run as a detached job for start."),
        values: looseObjectSchema("Runtime placeholder values passed to the template for start"),
      },
      ["action"],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = params as Jobs.JobStartParams & {
        action?: string;
        job?: string;
        lines?: string;
        state_root?: string;
      };
      switch (input.action) {
        case "start": {
          const meta = Jobs.startJob(input, ctx.cwd, deps.getTools());
          return { content: [{ type: "text" as const, text: jsonText(meta) }], details: meta };
        }
        case "status": {
          if (!input.job) throw new Error("template_job action=status requires job.");
          const status = Jobs.getJobStatus(String(input.job));
          return { content: [{ type: "text" as const, text: jsonText(status) }], details: status };
        }
        case "tail": {
          if (!input.job) throw new Error("template_job action=tail requires job.");
          const text = Jobs.tailJob(String(input.job), Number(input.lines || 40));
          return { content: [{ type: "text" as const, text: `\n${text}` }], details: {} };
        }
        case "list": {
          const jobs = Jobs.listJobs(input.state_root);
          return { content: [{ type: "text" as const, text: jsonText(jobs) }], details: { jobs } };
        }
        case "cancel": {
          if (!input.job) throw new Error("template_job action=cancel requires job.");
          const result = Jobs.cancelJob(String(input.job));
          return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
        }
        default:
          throw new Error("template_job action must be one of: start, status, tail, list, cancel.");
      }
    },
  };
}

export function createRuntimeToolDefinition(
  cfg: RegisteredTool,
  exec: Execution.RegisteredToolExec,
  getTools?: () => Map<string, RegisteredTool>,
): any {
  const paramSchema: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const requiredArgs = cfg.template
    ? Schema.getRequiredToolArgNames({
      args: cfg.args,
      defaults: cfg.defaults,
      template: cfg.template,
    })
    : new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)));
  for (const arg of cfg.args) {
    paramSchema[arg] = stringSchema(`Argument: ${arg}`);
    if (requiredArgs.has(arg)) required.push(arg);
  }
  if (cfg.job) paramSchema.job_id = stringSchema("Optional job id override for this job-backed tool invocation.");
  return {
    name: cfg.name,
    label: cfg.name,
    description: cfg.description,
    parameters: objectSchema(paramSchema, required),
    promptSnippet: cfg.template
      ? Prompts.formatRegisteredToolPromptSnippet(cfg.template)
      : Prompts.formatJobBackedToolPromptSnippet(cfg.job!),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (cfg.job) {
        const input = params as Record<string, unknown>;
        const { job_id, ...values } = input;
        const meta = Jobs.startJob(
          {
            file: cfg.job,
            job: typeof job_id === "string" && job_id.trim()
              ? job_id.trim()
              : `${cfg.name}-${Date.now()}`,
            state_dir: "",
            values: { ...cfg.defaults, ...values },
          },
          ctx.cwd,
          getTools?.(),
        );
        return { content: [{ type: "text" as const, text: jsonText(meta) }], details: meta };
      }
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
