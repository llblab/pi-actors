/**
 * Public spawn tool behavior
 * Zones: actor launch, draft recipe capture, launch diagnostics
 * Owns the public spawn execution path for run-backed actors
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as AsyncRuns from "./async-runs.js";
import { withFileMutationLock } from "./file-state.js";
import * as ModelContext from "./model-context.js";
import * as Paths from "./paths.js";
import * as RecipesUsage from "./recipes-usage.js";
import * as Schema from "./schema.js";
import * as ToolsResponse from "./tools-response.js";
const asRecord = ToolsResponse.asRecord;
const maybeJsonText = ToolsResponse.maybeJsonText;
function getRunOwnerId(ctx) {
    return ctx.sessionManager?.getSessionId?.();
}
function draftRecipeName(run) {
    return `${run.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "spawn"}.json`;
}
function draftRecipeDefaults(values) {
    const ignored = new Set(["run_id", "state_dir", "trace_file"]);
    const defaults = Object.fromEntries(Object.entries(values).filter(([key]) => !ignored.has(key)));
    return Object.keys(defaults).length > 0 ? defaults : undefined;
}
function writeSpawnDraftRecipe(input, meta) {
    if (process.env.NODE_TEST_CONTEXT &&
        process.env.PI_ACTORS_ENABLE_SPAWN_DRAFTS_IN_TEST !== "1")
        return undefined;
    if (input.template === undefined ||
        input.file !== undefined ||
        input.recipe !== undefined)
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
    withFileMutationLock(root, () => withFileMutationLock(path, () => writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx" })));
    RecipesUsage.recordRecipeLaunch(path, new Date(), "spawn", Paths.getRecipeRoot());
    return path;
}
function runIdFromTarget(target) {
    if (!target)
        return undefined;
    if (!target.startsWith("run:")) {
        throw new Error(`spawn.as accepts only run:<id>; received: ${target}`);
    }
    const run = target.slice(4);
    if (!run || !/^[A-Za-z0-9_.-]+$/.test(run)) {
        throw new Error(`invalid spawn Run target: ${target}`);
    }
    return run;
}
export function createSpawnToolDefinition() {
    return {
        name: "spawn",
        label: "Spawn",
        description: "Create one controllable Run from a Recipe file or inline command template.",
        parameters: Schema.objectSchema({
            artifacts: Schema.looseObjectSchema("Optional named artifact paths for the spawned Run."),
            as: Schema.stringSchema("Optional Run identity in exact run:<id> form."),
            file: Schema.stringSchema("Optional Recipe reference as <skill>/<recipe> or an explicit .json/.md file path."),
            recipe: Schema.stringSchema("Alias for file."),
            template: Schema.unionSchema([
                Schema.stringSchema("Inline command template string"),
                Schema.arraySchema("Inline command-template sequence or parallel tree"),
                Schema.looseObjectSchema("Inline command-template object with flags such as parallel, repeat, retry, failure, and nested template."),
            ]),
            values: Schema.looseObjectSchema("Runtime placeholder values passed to the actor."),
            transport_context: Schema.looseObjectSchema("Optional originating transport route preserved for detached terminal follow-up, e.g. Telegram chat_id and thread_id."),
            verbose: Schema.booleanSchema("Return full JSON instead of compact text."),
        }, []),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const input = asRecord(params);
            if (input.state_dir !== undefined) {
                throw new Error("spawn.state_dir is not supported; run state is runtime-owned so run:<id> remains addressable and retention-safe.");
            }
            const runId = runIdFromTarget(typeof input.as === "string" ? input.as : undefined);
            const recipe = typeof input.file === "string"
                ? input.file
                : typeof input.recipe === "string"
                    ? input.recipe
                    : undefined;
            const meta = AsyncRuns.startRun({
                file: recipe,
                launch_source: "spawn",
                launch_correlation: { tool_call_id: toolCallId },
                ownerId: getRunOwnerId(ctx),
                ...(input.transport_context
                    ? { transport_context: asRecord(input.transport_context) } : {}),
                run_id: runId,
                ...(input.template !== undefined
                    ? {
                        template: input.template,
                    }
                    : {}),
                values: ModelContext.withCurrentModelValues(asRecord(input.values), ctx),
                ...(input.artifacts &&
                    typeof input.artifacts === "object" &&
                    !Array.isArray(input.artifacts)
                    ? {
                        artifacts: input.artifacts,
                    }
                    : {}),
            }, ctx.cwd, { skillContext: ctx.recipeResolutionContext?.activeSkills });
            const draftRecipe = writeSpawnDraftRecipe(input, meta);
            const nextActions = ToolsResponse.runNextActions(meta.run);
            const details = {
                ...meta,
                ...(draftRecipe ? { draft_recipe: draftRecipe } : {}),
                next_actions: nextActions,
            };
            return {
                content: [
                    {
                        type: "text",
                        text: maybeJsonText(details, input.verbose === true, ToolsResponse.compactAsyncRunStatus(details)),
                    },
                ],
                details,
            };
        },
    };
}
