/**
 * Pi-facing tool definition helpers
 * Zones: pi tools, registry tools, async run launchers
 * Owns generated runtime tool schemas and the register_tool management tool schema
 */

import type { RegisteredTool } from "./config.ts";
import * as AsyncRuns from "./async-runs.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Execution from "./execution.ts";
import * as Prompts from "./prompts.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as Registry from "./registry.ts";
import * as Schema from "./schema.ts";

export type RegisterToolInput = Registry.RegisterToolInput;
export type RegisterToolRuntimeDeps<TContext> =
  Registry.RegisterToolRuntimeDeps<TContext>;

type JsonSchema = Record<string, unknown>;

function stringSchema(description: string): JsonSchema {
  return { description, type: "string" };
}

function typedArgSchema(
  arg: string,
  type: Schema.ToolArgType | undefined,
): JsonSchema {
  if (!type || type.kind === "string") return stringSchema(`Argument: ${arg}`);
  if (type.kind === "path") return stringSchema(`Path argument: ${arg}`);
  if (type.kind === "int")
    return { description: `Integer argument: ${arg}`, type: "integer" };
  if (type.kind === "number")
    return { description: `Number argument: ${arg}`, type: "number" };
  if (type.kind === "bool")
    return { description: `Boolean argument: ${arg}`, type: "boolean" };
  if (type.kind === "array")
    return { description: `Array argument: ${arg}`, items: {}, type: "array" };
  return {
    description: `Enum argument: ${arg}`,
    enum: type.values,
    type: "string",
  };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFailureCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function compactAsyncRunStatus(value: unknown): string {
  const status = asRecord(value);
  const progress = asRecord(status.progress);
  const result = asRecord(status.result);
  const tokens = [
    `run=${String(status.run ?? "<unknown>")}`,
    `status=${String(status.status ?? "unknown")}`,
  ];
  if (status.tool) tokens.push(`tool=${String(status.tool)}`);
  if (status.recipe) tokens.push(`recipe=${String(status.recipe)}`);
  if (Number(status.pid) > 0) tokens.push(`pid=${Number(status.pid)}`);
  if (progress.phase && progress.phase !== status.status)
    tokens.push(`phase=${String(progress.phase)}`);
  if (Number(progress.activeSubagents) > 0)
    tokens.push(`active=${Number(progress.activeSubagents)}`);
  if (Number(progress.completed) > 0)
    tokens.push(`completed=${Number(progress.completed)}`);
  const failures = formatFailureCount(progress.failures);
  if (failures !== undefined && failures > 0)
    tokens.push(`failures=${failures}`);
  if (result.code !== undefined) tokens.push(`code=${String(result.code)}`);
  if (result.killed === true) tokens.push("killed=true");
  return `\n${tokens.join(" ")}`;
}

function compactAsyncRunList(runs: Array<Record<string, unknown>>): string {
  if (runs.length === 0) return "\n(no async runs)";
  return `\n${runs
    .map((run) =>
      [
        `run=${String(run.run ?? "<unknown>")}`,
        `status=${String(run.status ?? "unknown")}`,
        ...(run.tool ? [`tool=${String(run.tool)}`] : []),
        ...(run.recipe ? [`recipe=${String(run.recipe)}`] : []),
      ].join(" "),
    )
    .join("\n")}`;
}

function compactRunEvents(events: AsyncRuns.RunOutboxEvent[]): string {
  if (events.length === 0) return "\n(no run events)";
  return `\n${events
    .map((event) =>
      [
        `run=${event.run}`,
        `event=${event.event}`,
        `level=${event.level}`,
        `delivery=${event.delivery}`,
        `summary=${event.summary.replaceAll(/\s+/g, "_")}`,
      ].join(" "),
    )
    .join("\n")}`;
}

function compactSendResult(
  runId: string,
  result: Record<string, unknown>,
): string {
  const tokens = [
    `run=${runId}`,
    `send=${result.sent === true ? "sent" : "not_sent"}`,
  ];
  if (result.bytes !== undefined) tokens.push(`bytes=${String(result.bytes)}`);
  if (result.control) tokens.push(`control=${String(result.control)}`);
  return `\n${tokens.join(" ")}`;
}

function compactStopResult(
  action: "cancel" | "kill",
  runId: string,
  result: Record<string, unknown>,
): string {
  const status = asRecord(result.status);
  const stopped = result.stopped === true;
  const tokens = [`run=${runId}`, `${action}=${stopped ? "sent" : "not_sent"}`];
  if (result.reason)
    tokens.push(`reason=${String(result.reason).replaceAll(" ", "_")}`);
  if (status.status) tokens.push(`status=${String(status.status)}`);
  if (result.signal) tokens.push(`signal=${String(result.signal)}`);
  if (result.signalTarget) tokens.push(`target=${String(result.signalTarget)}`);
  return `\n${tokens.join(" ")}`;
}

function maybeJsonText(
  value: unknown,
  verbose: boolean | undefined,
  compact: string,
): string {
  return verbose ? jsonText(value) : compact;
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
        async: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.async),
        description: stringSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.description,
        ),
        name: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.name),
        state_dir: stringSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.state_dir,
        ),
        template: unionSchema([
          stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
          arraySchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateArray),
          nullSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateNull),
        ]),
        update: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.update),
        values: looseObjectSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.values,
        ),
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

export interface AsyncRunToolContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

function getRunOwnerId(ctx: AsyncRunToolContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.();
}

export function createAsyncRunToolDefinition<
  TContext extends AsyncRunToolContext,
>(): any {
  return {
    name: "async_run",
    label: "Async Run",
    description:
      "Manage detached async runs. Actions: start, status, tail, list, events, send, cancel, kill.",
    parameters: objectSchema(
      {
        action: stringSchema(
          "Action: start, status, tail, list, events, send, cancel, or kill.",
        ),
        failure: stringSchema(
          "Failure propagation for start: continue, branch, or root.",
        ),
        file: stringSchema(
          "Optional template recipe JSON file for start. Bare names resolve under ~/.pi/agent/recipes.",
        ),
        lines: stringSchema(
          "Tail/event line count for tail or events. Default 40.",
        ),
        message: stringSchema(
          "Line-delimited message for send to a run control FIFO. A trailing newline is added when omitted.",
        ),
        parallel: booleanSchema(
          "Run an inline or recipe-envelope template array concurrently for start.",
        ),
        recover: unionSchema([
          stringSchema(
            "Recovery command template run between failed retry attempts for start",
          ),
          arraySchema("Recovery command-template sequence for start"),
        ]),
        run_id: stringSchema(
          "Run id or state directory. Required for status, tail, cancel, and kill. Optional for start.",
        ),
        state_dir: stringSchema(
          "Optional run state directory for start. Defaults to ~/.pi/agent/tmp/pi-auto-tools/runs/{run_id}.",
        ),
        state_root: stringSchema(
          "Optional state root for list. Defaults to ~/.pi/agent/tmp/pi-auto-tools/runs.",
        ),
        status: stringSchema(
          "Optional list filter: all, running, active, terminal, done, failed, cancelled, killed, or exited.",
        ),
        template: unionSchema([
          stringSchema("Command template string for start"),
          arraySchema("Command template sequence or parallel tree for start"),
        ]),
        values: looseObjectSchema(
          "Runtime placeholder values passed to the template for start",
        ),
        when: stringSchema(
          "Optional start node guard expression, for example flag or !flag.",
        ),
        verbose: booleanSchema(
          "Return full JSON instead of compact text for start, status, list, events, send, cancel, and kill.",
        ),
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
      const input = params as AsyncRuns.AsyncRunStartParams & {
        action?: string;
        lines?: string;
        message?: string;
        state_root?: string;
        status?: string;
        verbose?: boolean;
      };
      switch (input.action) {
        case "start": {
          const meta = AsyncRuns.startRun(
            { ...input, ownerId: getRunOwnerId(ctx) },
            ctx.cwd,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  meta,
                  input.verbose,
                  compactAsyncRunStatus(meta),
                ),
              },
            ],
            details: meta,
          };
        }
        case "status": {
          if (!input.run_id)
            throw new Error("async_run action=status requires run_id.");
          const status = AsyncRuns.getRunStatus(String(input.run_id));
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  status,
                  input.verbose,
                  compactAsyncRunStatus(status),
                ),
              },
            ],
            details: status,
          };
        }
        case "tail": {
          if (!input.run_id)
            throw new Error("async_run action=tail requires run_id.");
          const text = AsyncRuns.tailRun(
            String(input.run_id),
            Number(input.lines || 40),
          );
          return {
            content: [{ type: "text" as const, text: `\n${text}` }],
            details: {},
          };
        }
        case "list": {
          const runs = AsyncRuns.listRuns(input.state_root, input.status);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  runs,
                  input.verbose,
                  compactAsyncRunList(runs),
                ),
              },
            ],
            details: { runs },
          };
        }
        case "events": {
          if (!input.run_id)
            throw new Error("async_run action=events requires run_id.");
          const events = AsyncRuns.readRunEvents(
            String(input.run_id),
            Number(input.lines || 40),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  events,
                  input.verbose,
                  compactRunEvents(events),
                ),
              },
            ],
            details: { events },
          };
        }
        case "send": {
          if (!input.run_id)
            throw new Error("async_run action=send requires run_id.");
          if (typeof input.message !== "string")
            throw new Error("async_run action=send requires message.");
          const runId = String(input.run_id);
          const result = AsyncRuns.sendRunMessage(runId, input.message);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  result,
                  input.verbose,
                  compactSendResult(runId, result),
                ),
              },
            ],
            details: result,
          };
        }
        case "cancel": {
          if (!input.run_id)
            throw new Error("async_run action=cancel requires run_id.");
          const runId = String(input.run_id);
          const result = AsyncRuns.cancelRun(runId);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  result,
                  input.verbose,
                  compactStopResult("cancel", runId, result),
                ),
              },
            ],
            details: result,
          };
        }
        case "kill": {
          if (!input.run_id)
            throw new Error("async_run action=kill requires run_id.");
          const runId = String(input.run_id);
          const result = AsyncRuns.killRun(runId);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  result,
                  input.verbose,
                  compactStopResult("kill", runId, result),
                ),
              },
            ],
            details: result,
          };
        }
        default:
          throw new Error(
            "async_run action must be one of: start, status, tail, list, events, send, cancel, kill.",
          );
      }
    },
  };
}

export function createRuntimeToolDefinition(
  cfg: RegisteredTool,
  exec: Execution.RegisteredToolExec,
): any {
  const paramSchema: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const isRecipe = RecipeReferences.isRecipeTool(cfg.template, cfg.recipe);
  const isAsyncRecipe =
    cfg.recipe?.async === true ||
    RecipeReferences.isAsyncRecipeReference(cfg.template);
  const recipeTemplate =
    cfg.recipe?.template ?? RecipeReferences.getRecipeTemplate(cfg.template);
  const requiredTemplate = recipeTemplate ?? cfg.template!;
  const requiredTemplateConfig: CommandTemplates.CommandTemplateConfig =
    typeof requiredTemplate === "object" && !Array.isArray(requiredTemplate)
      ? {
          ...requiredTemplate,
          args: cfg.args,
          defaults: { ...(requiredTemplate.defaults ?? {}), ...cfg.defaults },
        }
      : {
          args: cfg.args,
          defaults: cfg.defaults,
          template: requiredTemplate,
        };
  const requiredArgs =
    isRecipe && cfg.storedArgs !== undefined
      ? new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)))
      : RecipeReferences.isRecipeReference(cfg.template) && !recipeTemplate
        ? new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)))
        : Schema.getRequiredToolArgNames(requiredTemplateConfig);
  for (const arg of cfg.args) {
    paramSchema[arg] = typedArgSchema(arg, cfg.argTypes?.[arg]);
    if (requiredArgs.has(arg)) required.push(arg);
  }
  if (isAsyncRecipe)
    paramSchema.run_id = stringSchema(
      "Optional run id override for this async template recipe invocation.",
    );
  return {
    name: cfg.name,
    label: cfg.name,
    description: cfg.description,
    parameters: objectSchema(paramSchema, required),
    promptSnippet: isRecipe
      ? Prompts.formatRecipeToolPromptSnippet(
          cfg.recipe?.name ?? String(cfg.template),
          isAsyncRecipe,
        )
      : Prompts.formatRegisteredToolPromptSnippet(cfg.template),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: AsyncRunToolContext,
    ) {
      if (isAsyncRecipe) {
        const input = params as Record<string, unknown>;
        const { run_id, ...values } = input;
        const base = cfg.recipe ? cfg.recipe : { file: String(cfg.template) };
        const runId =
          typeof run_id === "string" && run_id.trim()
            ? run_id.trim()
            : `${cfg.name}-${Date.now()}`;
        const meta = AsyncRuns.startRun(
          {
            ...base,
            ownerId: getRunOwnerId(ctx),
            run_id: runId,
            tool: cfg.name,
            values: Schema.normalizeRuntimeValues(
              { ...(cfg.recipe?.values ?? {}), ...cfg.defaults, ...values },
              cfg.argTypes,
            ),
          },
          ctx.cwd,
        );
        return {
          content: [
            { type: "text" as const, text: compactAsyncRunStatus(meta) },
          ],
          details: meta,
        };
      }
      if (isRecipe && recipeTemplate) {
        const paramsWithDefaults = {
          ...(cfg.recipe?.values ?? {}),
          ...cfg.defaults,
          ...(params as Record<string, unknown>),
        };
        return Execution.executeRegisteredTool(
          { ...cfg, template: recipeTemplate },
          Schema.normalizeRuntimeValues(paramsWithDefaults, cfg.argTypes),
          exec,
          ctx.cwd,
          signal,
        );
      }
      return Execution.executeRegisteredTool(
        cfg,
        Schema.normalizeRuntimeValues(
          params as Record<string, unknown>,
          cfg.argTypes,
        ),
        exec,
        ctx.cwd,
        signal,
      );
    },
  };
}
