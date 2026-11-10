/**
 * Public spawn tool behavior
 * Zones: actor launch, draft recipe capture, launch diagnostics
 * Owns the public spawn execution path for run-backed actors
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import { withFileMutationLock } from "./file-state.ts";
import * as Limits from "./limits.ts";
import * as ModelContext from "./model-context.ts";
import * as Paths from "./paths.ts";
import type * as RecipeResolution from "./recipes-context.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import * as Schema from "./schema.ts";
import * as ToolsResponse from "./tools-response.ts";
import { readRunFileNavigationForContext } from "./tools-access.ts";

export interface SpawnToolContext extends ModelContext.CurrentModelContext {
  recipeResolutionContext?: RecipeResolution.RecipeResolutionContext;
  cwd: string;
  /** Kernel-injected only; never sourced from tool input/actor values. */
  onSupervisionClockCaptured?: AsyncRuns.AsyncRunStartOptions["onSupervisionClockCaptured"];
  sessionManager?: { getSessionId?: () => string };
}

const asRecord = ToolsResponse.asRecord;
const spawnMetadataText = ToolsResponse.spawnMetadataText;

function getRunOwnerId(ctx: SpawnToolContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.();
}

function draftRecipeName(run: string): string {
  return `${run.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "spawn"}.json`;
}

function draftRecipeDefaults(
  values: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const ignored = new Set(["run_id", "state_dir", "trace_file"]);
  const defaults = Object.fromEntries(
    Object.entries(values).filter(([key]) => !ignored.has(key)),
  );
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function writeSpawnDraftRecipe(
  input: Record<string, unknown>,
  meta: AsyncRuns.AsyncRunMeta,
): string | undefined {
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.PI_ACTORS_ENABLE_SPAWN_DRAFTS_IN_TEST !== "1"
  )
    return undefined;
  if (
    input.template === undefined ||
    input.file !== undefined ||
    input.recipe !== undefined
  )
    return undefined;
  const root = Paths.getRecipeDraftRoot();
  mkdirSync(root, { recursive: true });
  const path = join(root, draftRecipeName(String(meta.run)));
  const defaults = draftRecipeDefaults(meta.values);
  const recipe = {
    async: true,
    description: `Draft recipe captured from spawn run ${String(meta.run)}`,
    ...(meta.artifacts ? { artifacts: meta.artifacts } : {}),
    ...(defaults ? { defaults } : {}),
    template: input.template,
  };
  withFileMutationLock(root, () =>
    withFileMutationLock(path, () =>
      writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx" }),
    ),
  );
  RecipesUsage.recordRecipeLaunch(path, new Date(), "spawn", Paths.getRecipeRoot());
  return path;
}

/** Compiler-owned pre-launch diagnostics only; selected caller values are not admitted Run ids. */
function spawnGuardText(kind: "state_dir" | "namespace" | "id", value?: string): string {
  const facts = kind === "state_dir"
    ? { result: "unsupported field", reason: "Run state is runtime-owned; run:<id> remains addressable and retention-safe." }
    : { result: kind === "namespace" ? "unsupported Run target" : "invalid Run target", accepted_format: "run:<id>",
        ...(kind === "id" ? { id_rule: "nonempty ASCII letters, digits, underscore, dot or hyphen" } : {}) };
  // Measure the shared emitter's own projection: an unfit selected value must become an omission, not a clip.
  const render = (selected?: Record<string, unknown>): string | undefined => {
    const rendered = ToolsResponse.renderYamlMetadata({ field: kind === "state_dir" ? "state_dir" : "as", ...(selected ?? {}), ...facts },
      Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    return rendered.state === "available"
      ? ToolsResponse.withLeadingLineBreak(ToolsResponse.frameMetadataDocument(rendered.text))
      : undefined;
  };
  const required = (selected?: Record<string, unknown>) => render(selected) ?? render()!;
  const wellFormed = value !== undefined && value.isWellFormed();
  if (value !== undefined && wellFormed) {
    const complete = render({ value });
    if (complete !== undefined && Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES) return complete;
  }
  if (value === undefined) return required();
  const reason = wellFormed ? "response_too_large" : "malformed_selected_text";
  return required({ value: reason === "response_too_large" ? "[omitted]" : "[unavailable]",
    value_omission: { reason, shown: 0, omitted: 1, total: 1 } });
}

function runIdFromTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  if (!target.startsWith("run:")) {
    throw new Error(spawnGuardText("namespace", `${target}`));
  }
  const run = target.slice(4);
  if (!run || !/^[A-Za-z0-9_.-]+$/.test(run)) {
    throw new Error(spawnGuardText("id", `${target}`));
  }
  return run;
}

export function createSpawnToolDefinition<
  TContext extends SpawnToolContext,
>(): any {
  return {
    name: "spawn",
    label: "Spawn",
    description:
      "Create one controllable Run from a Recipe file or inline command template.",
    parameters: Schema.objectSchema(
      {
        artifacts: Schema.looseObjectSchema(
          "Optional named artifact paths for the spawned Run.",
        ),
        as: Schema.stringSchema(
          "Optional Run identity in exact run:<id> form.",
        ),
        file: Schema.stringSchema(
          "Optional Recipe reference as <skill>/<recipe> or an explicit .json/.md file path.",
        ),
        recipe: Schema.stringSchema("Alias for file."),
        template: Schema.unionSchema([
          Schema.stringSchema("Inline command template string"),
          Schema.arraySchema(
            "Inline command-template sequence or parallel tree",
          ),
          Schema.looseObjectSchema(
            "Inline command-template object with flags such as parallel, repeat, retry, failure, and nested template.",
          ),
        ]),
        values: Schema.looseObjectSchema(
          "Runtime placeholder values passed to the actor.",
        ),
        transport_context: Schema.looseObjectSchema(
          "Optional originating transport route preserved for detached terminal follow-up, e.g. Telegram chat_id and thread_id.",
        ),
        verbose: Schema.booleanSchema(
          "Return full YAML instead of compact text.",
        ),
      },
      [],
    ),
    async execute(
      toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = asRecord(params);
      if (input.state_dir !== undefined) {
        throw new Error(spawnGuardText("state_dir"));
      }
      const runId = runIdFromTarget(
        typeof input.as === "string" ? input.as : undefined,
      );
      const recipe =
        typeof input.file === "string"
          ? input.file
          : typeof input.recipe === "string"
            ? input.recipe
            : undefined;
      const meta = AsyncRuns.startRun(
        {
          file: recipe,
          launch_source: "spawn",
          launch_correlation: { tool_call_id: toolCallId },
          ownerId: getRunOwnerId(ctx),
          ...(input.transport_context
            ? { transport_context: asRecord(input.transport_context) } : {}),
          run_id: runId,
          ...(input.template !== undefined
            ? {
                template:
                  input.template as AsyncRuns.AsyncRunStartParams["template"],
              }
            : {}),
          values: ModelContext.withCurrentModelValues(
            asRecord(input.values),
            ctx,
          ),
          ...(input.artifacts &&
          typeof input.artifacts === "object" &&
          !Array.isArray(input.artifacts)
            ? {
                artifacts: input.artifacts as Record<
                  string,
                  AsyncRuns.RunArtifactDeclaration
                >,
              }
            : {}),
        },
        ctx.cwd,
        { skillContext: ctx.recipeResolutionContext?.activeSkills, onSupervisionClockCaptured: ctx.onSupervisionClockCaptured },
      );
      const draftRecipe = writeSpawnDraftRecipe(input, meta);
      const nextActions = ToolsResponse.runNextActions(meta.run);
      const details = {
        ...meta,
        file_navigation: readRunFileNavigationForContext(meta, ctx),
        ...(draftRecipe ? { draft_recipe: draftRecipe } : {}),
        next_actions: nextActions,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: spawnMetadataText(
              details,
              input.verbose === true,
              ToolsResponse.compactAsyncRunStatus(details),
            ),
          },
        ],
        details,
      };
    },
  };
}
