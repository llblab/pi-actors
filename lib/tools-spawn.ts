/**
 * Public spawn tool behavior
 * Zones: actor launch, draft recipe capture, launch diagnostics
 * Owns the public spawn execution path for run-backed actors
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as Messages from "./messages.ts";
import * as ModelContext from "./model-context.ts";
import * as Paths from "./paths.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as Rooms from "./rooms.ts";
import * as Schema from "./schema.ts";
import * as ToolsResponse from "./tools-response.ts";

export interface SpawnToolContext extends ModelContext.CurrentModelContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

const asRecord = ToolsResponse.asRecord;
const maybeJsonText = ToolsResponse.maybeJsonText;

function getRunOwnerId(ctx: SpawnToolContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.();
}

function shadowedRecipeLaunchDiagnostic(
  recipe: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof recipe !== "string" ||
    recipe.includes("/") ||
    recipe.includes("~")
  )
    return undefined;
  const discovery = RecipesDiscovery.discoverRecipeSources([
    { root: Paths.getRecipeRoot(), defaultTool: true, mutableUsage: true },
    { root: Paths.getPackagedRecipeRoot(), defaultTool: false },
  ]);
  return RecipesDiscovery.getShadowedLaunchDiagnostic(discovery, recipe);
}

function draftRecipeName(run: string): string {
  return `${run.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "spawn"}.json`;
}

function draftRecipeDefaults(
  values: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const ignored = new Set([
    "actor_address",
    "communication_file",
    "default_room",
    "run_id",
    "state_dir",
  ]);
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
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx" });
  return path;
}

function enhanceSpawnRecipeError(error: unknown, recipe: unknown): Error {
  const diagnostic = shadowedRecipeLaunchDiagnostic(recipe);
  if (!diagnostic)
    return error instanceof Error ? error : new Error(String(error));
  const original = error instanceof Error ? error.message : String(error);
  return Object.assign(
    new Error(
      `${original} reason=${diagnostic.reason} active_path=${diagnostic.active_path} blocked_fallback=${diagnostic.blocked_fallback} hint=${diagnostic.hint}`,
    ),
    {
      ...diagnostic,
      original_error: original,
    },
  );
}

function runIdFromActorAddress(
  address: string | undefined,
): string | undefined {
  if (!address) return undefined;
  const parsed = Messages.parseActorAddress(address);
  if (parsed.kind !== "run" || !parsed.value) {
    throw new Error(`Expected run:<id> actor address, received: ${address}`);
  }
  return parsed.value;
}

export function createSpawnToolDefinition<
  TContext extends SpawnToolContext,
>(): any {
  return {
    name: "spawn",
    label: "Spawn",
    description:
      "Create an addressable actor from a recipe file or inline command template. Use instead of ad hoc shell backgrounding for work that may outlive this turn, needs steering/follow-up/artifacts, runs as a service, fans out, or should be inspected later. Currently spawns run:<id> actors backed by async runs.",
    parameters: Schema.objectSchema(
      {
        artifacts: Schema.looseObjectSchema(
          "Optional named artifact paths for the spawned actor.",
        ),
        as: Schema.stringSchema(
          "Optional actor address for the spawned run, e.g. run:<id>.",
        ),
        file: Schema.stringSchema(
          "Optional template recipe JSON file. Bare names resolve under ~/.pi/agent/recipes.",
        ),
        recipe: Schema.stringSchema(
          "Alias for file; template recipe JSON file/name to spawn.",
        ),
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
        verbose: Schema.booleanSchema(
          "Return full JSON instead of compact text.",
        ),
      },
      [],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = asRecord(params);
      if (input.state_dir !== undefined) {
        throw new Error(
          "spawn.state_dir is not supported; run state is runtime-owned so run:<id> remains addressable and retention-safe.",
        );
      }
      const runId = runIdFromActorAddress(
        typeof input.as === "string" ? input.as : undefined,
      );
      const recipe =
        typeof input.file === "string"
          ? input.file
          : typeof input.recipe === "string"
            ? input.recipe
            : undefined;
      let meta: AsyncRuns.AsyncRunMeta;
      try {
        meta = AsyncRuns.startRun(
          {
            file: recipe,
            launch_source: "spawn",
            ownerId: getRunOwnerId(ctx),
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
        );
      } catch (error) {
        throw enhanceSpawnRecipeError(error, recipe);
      }
      const draftRecipe = writeSpawnDraftRecipe(input, meta);
      const nextActions = ToolsResponse.actorRunNextActions(meta.run);
      const details = {
        ...meta,
        ...(draftRecipe ? { draft_recipe: draftRecipe } : {}),
        next_actions: nextActions,
      };
      Rooms.ensureDefaultRoom(meta.state_dir, String(meta.run));
      Rooms.writeCommunicationSnapshot(meta.state_dir, String(meta.run));
      return {
        content: [
          {
            type: "text" as const,
            text: maybeJsonText(
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
