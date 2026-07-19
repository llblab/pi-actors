/**
 * Local tool definition behavior
 * Zones: user recipe tools, generated schemas, async recipe launch
 * Owns wrapping saved local capabilities as executable pi tools
 */

import * as Rooms from "./rooms.ts";
import * as AsyncRuns from "./async-runs.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as ModelContext from "./model-context.ts";
import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import * as Prompts from "./prompts.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import * as Schema from "./schema.ts";
import * as ToolsResponse from "./tools-response.ts";

type JsonSchema = Schema.JsonSchema;

export interface RuntimeToolContext extends ModelContext.CurrentModelContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

function getRunOwnerId(ctx: RuntimeToolContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.();
}

function typedArgSchema(
  arg: string,
  type: Schema.ToolArgType | undefined,
): JsonSchema {
  const description =
    !type || type.kind === "string"
      ? `Argument: ${arg}`
      : type.kind === "path"
        ? `Path argument: ${arg}`
        : `${type.kind[0].toUpperCase()}${type.kind.slice(1)} argument: ${arg}`;
  return Schema.typedArgSchema(description, type);
}

function sampleValueForArg(
  arg: string,
  type: Schema.ToolArgType | undefined,
  defaults: Record<string, unknown>,
): unknown {
  if (Object.hasOwn(defaults, arg)) return defaults[arg];
  if (!type || type.kind === "string") return `<${arg}>`;
  if (type.kind === "path") return `./${arg}`;
  if (type.kind === "int") return 1;
  if (type.kind === "number") return 1.5;
  if (type.kind === "bool") return true;
  if (type.kind === "array") return [`<${arg}>`];
  return type.values[0] ?? `<${arg}>`;
}

function shouldAddRuntimeToolUsageHint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^Argument \S+ must /.test(message) || /^Missing .* value: /.test(message)
  );
}

function formatRuntimeToolUsageHint(
  cfg: RegisteredTool,
  required: string[],
  includeRunId: boolean,
): string {
  const optional = cfg.args.filter((arg) => !required.includes(arg));
  const example: Record<string, unknown> = {};
  for (const arg of required)
    example[arg] = sampleValueForArg(arg, cfg.argTypes?.[arg], cfg.defaults);
  for (const arg of optional)
    example[arg] = sampleValueForArg(arg, cfg.argTypes?.[arg], cfg.defaults);
  if (includeRunId) example.run_id = `${cfg.name}-1`;
  const lines = [
    `Expected call shape for ${cfg.name}:`,
    `${cfg.name}(${JSON.stringify(example, null, 2)})`,
  ];
  if (required.length) lines.push(`Required: ${required.join(", ")}`);
  if (optional.length || includeRunId)
    lines.push(
      `Optional: ${[...optional, ...(includeRunId ? ["run_id"] : [])].join(", ")}`,
    );
  return lines.join("\n");
}

function formatRuntimeToolArgumentError(
  cfg: RegisteredTool,
  error: unknown,
  required: string[],
  includeRunId: boolean,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!shouldAddRuntimeToolUsageHint(error))
    return error instanceof Error ? error : new Error(message);
  return new Error(
    `Invalid arguments for tool "${cfg.name}": ${message}\n\n${formatRuntimeToolUsageHint(
      cfg,
      required,
      includeRunId,
    )}`,
  );
}

export function createRuntimeToolDefinition(
  cfg: RegisteredTool,
  exec: Execution.RegisteredToolExec,
): any {
  const paramSchema: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const isRecipe = RecipesReferences.isRecipeTool(cfg.template, cfg.recipe);
  const isAsyncRecipe =
    cfg.recipe?.async === true ||
    RecipesReferences.isAsyncRecipeReference(cfg.template);
  const recipeTemplate =
    cfg.recipe?.template ?? RecipesReferences.getRecipeTemplate(cfg.template);
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
      : RecipesReferences.isRecipeReference(cfg.template) && !recipeTemplate
        ? new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)))
        : Schema.getRequiredToolArgNames(requiredTemplateConfig);
  for (const arg of cfg.args) {
    paramSchema[arg] = typedArgSchema(arg, cfg.argTypes?.[arg]);
    if (requiredArgs.has(arg)) required.push(arg);
  }
  if (isAsyncRecipe)
    paramSchema.run_id = Schema.stringSchema(
      "Optional run id override for this async template recipe invocation.",
    );
  return {
    name: cfg.name,
    label: cfg.name,
    description: cfg.description,
    parameters: Schema.objectSchema(paramSchema, required),
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
      ctx: RuntimeToolContext,
    ) {
      try {
        if (
          cfg.sourcePath &&
          !RecipesUsage.recordRecipeLaunch(cfg.sourcePath, new Date(), "tool")
        ) {
          throw new Error(
            `Recipe launch rejected because its source changed during activation: ${cfg.sourcePath}. Reload recipe tools and retry.`,
          );
        }
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
              launch_source: "tool",
              ownerId: getRunOwnerId(ctx),
              run_id: runId,
              tool: cfg.name,
              policy_values: ModelContext.withCurrentModelValues(
                { ...(cfg.recipe?.values ?? {}), ...values },
                ctx,
              ),
              values: Schema.normalizeRuntimeValues(
                ModelContext.withCurrentModelValues(
                  { ...(cfg.recipe?.values ?? {}), ...cfg.defaults, ...values },
                  ctx,
                ),
                cfg.argTypes,
              ),
            },
            ctx.cwd,
          );
          Rooms.ensureDefaultRoom(meta.state_dir, String(meta.run));
          Rooms.writeCommunicationSnapshot(meta.state_dir, String(meta.run));
          return {
            content: [
              {
                type: "text" as const,
                text: ToolsResponse.compactAsyncRunStatus(meta),
              },
            ],
            details: meta,
          };
        }
        if (isRecipe && recipeTemplate) {
          const paramsWithDefaults = ModelContext.withCurrentModelValues(
            {
              ...(cfg.recipe?.values ?? {}),
              ...cfg.defaults,
              ...(params as Record<string, unknown>),
            },
            ctx,
          );
          return await Execution.executeRegisteredTool(
            { ...cfg, template: recipeTemplate },
            Schema.normalizeRuntimeValues(paramsWithDefaults, cfg.argTypes),
            exec,
            ctx.cwd,
            signal,
          );
        }
        return await Execution.executeRegisteredTool(
          cfg,
          Schema.normalizeRuntimeValues(
            ModelContext.withCurrentModelValues(
              params as Record<string, unknown>,
              ctx,
            ),
            cfg.argTypes,
          ),
          exec,
          ctx.cwd,
          signal,
        );
      } catch (error) {
        throw formatRuntimeToolArgumentError(
          cfg,
          error,
          required,
          isAsyncRecipe,
        );
      }
    },
  };
}
