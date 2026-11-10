/**
 * Local tool definition behavior
 * Zones: user recipe tools, generated schemas, async recipe launch
 * Owns wrapping saved local capabilities as executable pi tools
 */

import * as AsyncRuns from "./async-runs.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Limits from "./limits.ts";
import * as ModelContext from "./model-context.ts";
import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import * as Prompts from "./prompts.ts";
import type * as RecipeResolution from "./recipes-context.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import * as Schema from "./schema.ts";
import * as ToolsResponse from "./tools-response.ts";
import { readRunFileNavigationForContext } from "./tools-access.ts";

type JsonSchema = Schema.JsonSchema;

export interface RuntimeToolContext extends ModelContext.CurrentModelContext {
  recipeResolutionContext?: RecipeResolution.RecipeResolutionContext;
  cwd: string;
  /** Kernel-injected only; never sourced from tool input/actor values. */
  onSupervisionClockCaptured?: AsyncRuns.AsyncRunStartOptions["onSupervisionClockCaptured"];
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

/** Owned usage facts only; the JSON invocation example stays unparsed instructional body text. */
function runtimeToolUsageMetadata(
  cfg: RegisteredTool,
  required: string[],
  includeRunId: boolean,
): string {
  const optional = cfg.args.filter(
    (arg) =>
      !RecipesReferences.isRuntimeOwnedRecipeInput(arg) &&
      !required.includes(arg),
  );
  const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES;
  const tool = ToolsResponse.selectYamlField("tool", cfg.name, budget);
  const requiredPart = ToolsResponse.selectYamlField("required", required, budget);
  const optionalPart = ToolsResponse.selectYamlField("optional", [...optional, ...(includeRunId ? ["run_id"] : [])], budget);
  return ToolsResponse.growYamlDocument(() => ({ ...tool.selected, ...requiredPart.selected, ...optionalPart.selected }),
    [tool, requiredPart, optionalPart], budget);
}

function formatRuntimeToolUsageHint(
  cfg: RegisteredTool,
  required: string[],
  includeRunId: boolean,
): string {
  const optional = cfg.args.filter(
    (arg) =>
      !RecipesReferences.isRuntimeOwnedRecipeInput(arg) &&
      !required.includes(arg),
  );
  const exampleDefaults = {
    ...Schema.getExplicitToolArgDefaults(cfg.recipe?.args),
    ...cfg.defaults,
    ...(cfg.recipe?.values ?? {}),
  };
  const example: Record<string, unknown> = {};
  for (const arg of required)
    example[arg] = sampleValueForArg(arg, cfg.argTypes?.[arg], exampleDefaults);
  for (const arg of optional)
    example[arg] = sampleValueForArg(arg, cfg.argTypes?.[arg], exampleDefaults);
  if (includeRunId) example.run_id = `${cfg.name}-1`;
  return [
    `Expected call shape for ${cfg.name}:`,
    `${cfg.name}(${JSON.stringify(example, null, 2)})`,
  ].join("\n");
}

function resolveRecipeToolValues(
  cfg: RegisteredTool,
  callerValues: Record<string, unknown>,
  ctx: RuntimeToolContext,
): Record<string, unknown> {
  const recipeRuntimeValues = {
    ...(cfg.recipe?.recipe_dir
      ? { recipe_dir: cfg.recipe.recipe_dir }
      : {}),
    ...(cfg.recipe?.skill_dir ? { skill_dir: cfg.recipe.skill_dir } : {}),
  };
  return Schema.normalizeRuntimeValues(
    ModelContext.withCurrentModelValues(
      {
        ...Schema.getExplicitToolArgDefaults(cfg.recipe?.args),
        ...cfg.defaults,
        ...(cfg.recipe?.values ?? {}),
        ...callerValues,
        ...recipeRuntimeValues,
      },
      ctx,
    ),
    cfg.argTypes,
  );
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
  // Whole usage groups fit the header budget or carry explicit omission; the JSON example stays opaque.
  const header = runtimeToolUsageMetadata(cfg, required, includeRunId);
  return new Error(ToolsResponse.withLeadingLineBreak(ToolsResponse.frameMetadataDocument(header,
    `Invalid arguments for tool "${cfg.name}": ${message}\n\n${formatRuntimeToolUsageHint(cfg, required, includeRunId)}`)));
}

export function createRuntimeToolDefinition(
  cfg: RegisteredTool,
  exec: Execution.RegisteredToolExec,
): any {
  const paramSchema: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const isRecipe = RecipesReferences.isRecipeTool(cfg.template, cfg.recipe);
  const isAsyncRecipe = cfg.recipe
    ? cfg.recipe.async === true
    : RecipesReferences.isAsyncRecipeReference(cfg.template);
  const isSingletonRecipe = cfg.recipe?.singleton === true;
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
  const recipeInlineDefaults = Schema.getExplicitToolArgDefaults(
    cfg.recipe?.args,
  );
  const requiredArgs =
    isRecipe && cfg.storedArgs !== undefined
      ? new Set(
          cfg.args.filter(
            (arg) =>
              !Object.hasOwn(cfg.defaults, arg) &&
              !Object.hasOwn(recipeInlineDefaults, arg),
          ),
        )
      : !cfg.recipe && RecipesReferences.isRecipeReference(cfg.template) && !recipeTemplate
        ? new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)))
        : Schema.getRequiredToolArgNames(requiredTemplateConfig);
  for (const arg of cfg.args) {
    if (RecipesReferences.isRuntimeOwnedRecipeInput(arg)) continue;
    paramSchema[arg] = typedArgSchema(arg, cfg.argTypes?.[arg]);
    if (requiredArgs.has(arg)) required.push(arg);
  }
  if (isAsyncRecipe && !isSingletonRecipe)
    paramSchema.run_id = Schema.stringSchema(
      "Optional run id override for this async template recipe invocation.",
    );
  if (isAsyncRecipe) {
    paramSchema.transport_context = Schema.looseObjectSchema(
      "Optional originating transport route preserved for detached terminal follow-up.",
    );
  }
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
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: RuntimeToolContext,
    ) {
      let dispatchEntered = false;
      const execute: Execution.RegisteredToolExec = (...args) => {
        dispatchEntered = true;
        return exec(...args);
      };
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
          const { run_id, transport_context, ...values } = input;
          const base = cfg.recipe ? cfg.recipe : { file: String(cfg.template) };
          const runId = isSingletonRecipe
            ? undefined
            : typeof run_id === "string" && run_id.trim()
              ? run_id.trim()
              : `${cfg.name}-${Date.now()}`;
          const startParams: AsyncRuns.AsyncRunStartParams = {
            ...base,
            launch_source: "tool",
            launch_correlation: { tool_call_id: toolCallId },
            ...(transport_context &&
            typeof transport_context === "object" &&
            !Array.isArray(transport_context)
              ? {
                  transport_context: transport_context as Record<string, unknown>,
                } : {}),
            ownerId: getRunOwnerId(ctx),
            run_id: runId,
            tool: cfg.name,
            policy_values: ModelContext.withCurrentModelValues(
              { ...(cfg.recipe?.values ?? {}), ...values },
              ctx,
            ),
            values: resolveRecipeToolValues(cfg, values, ctx),
          };
          dispatchEntered = true;
          const meta = AsyncRuns.startRun(
            startParams,
            ctx.cwd,
            { skillContext: ctx.recipeResolutionContext?.activeSkills, onSupervisionClockCaptured: ctx.onSupervisionClockCaptured },
          );
          const details = { ...meta, file_navigation: readRunFileNavigationForContext(meta, ctx) };
          return {
            content: [
              {
                type: "text" as const,
                text: ToolsResponse.compactAsyncRunStatus(details),
              },
            ],
            details,
          };
        }
        if (isRecipe && recipeTemplate) {
          return await Execution.executeRegisteredTool(
            { ...cfg, template: recipeTemplate },
            resolveRecipeToolValues(
              cfg,
              params as Record<string, unknown>,
              ctx,
            ),
            execute,
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
          execute,
          ctx.cwd,
          signal,
        );
      } catch (error) {
        // Dispatch entry is not effect/closure proof; matching error text cannot justify argument repair or retry.
        if (dispatchEntered) throw error;
        throw formatRuntimeToolArgumentError(
          cfg,
          error,
          required,
          isAsyncRecipe && !isSingletonRecipe,
        );
      }
    },
  };
}
