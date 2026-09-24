/**
 * Actor Inspector evidence readers.
 * Zones: owned actor-instance inventory and captured Recipe projection
 * Owns actor-instance TUI evidence; Trace, Control, and execution parsing stay in their domains.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as SessionEvidence from "./session-evidence.js";
import { readJsonFileResilient } from "./state-readers.js";
function matchesOwner(stateDir, ownerId) {
    const meta = readJsonFileResilient(path.join(stateDir, "run.json"), {}).value;
    return meta.ownerId === ownerId;
}
export function readActorInspectorRuns(stateRoot, ownerId) {
    try {
        return fs
            .readdirSync(stateRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .flatMap((entry) => {
            const stateDir = path.join(stateRoot, entry.name);
            if (!matchesOwner(stateDir, ownerId))
                return [];
            const runMeta = readJsonFileResilient(path.join(stateDir, "run.json"), {}).value;
            const progress = readJsonFileResilient(path.join(stateDir, "progress.json"), {}).value;
            const result = readJsonFileResilient(path.join(stateDir, "result.json"), {}).value;
            return [{
                    run: entry.name,
                    ...(typeof runMeta.run_instance_id === "string"
                        ? { runInstanceId: runMeta.run_instance_id }
                        : {}),
                    status: String(progress.phase ??
                        (Object.keys(result).length ? "terminal" : "unknown")),
                    ...(typeof progress.updatedAt === "string"
                        ? { updatedAt: progress.updatedAt }
                        : typeof result.completedAt === "string"
                            ? { updatedAt: result.completedAt }
                            : {}),
                }];
        })
            .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
            right.run.localeCompare(left.run));
    }
    catch {
        return [];
    }
}
export function readActorInspectorRecipe(stateDir) {
    const result = readJsonFileResilient(path.join(stateDir, "run.json"), {});
    const meta = result.value;
    const contexts = Array.isArray(meta.recipe_context_records)
        ? meta.recipe_context_records.filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        : [];
    const primary = contexts.find((entry) => entry.depth === 0) ?? contexts[0];
    const definition = primary?.recipe &&
        typeof primary.recipe === "object" &&
        !Array.isArray(primary.recipe)
        ? primary.recipe
        : undefined;
    const stripPrivateOrigins = (value) => {
        if (Array.isArray(value))
            return value.map(stripPrivateOrigins);
        if (!value || typeof value !== "object")
            return value;
        return Object.fromEntries(Object.entries(value)
            .filter(([key, entry]) => entry !== undefined &&
            key !== "recipe_dir" &&
            key !== "skill_dir" &&
            key !== "source_file")
            .map(([key, entry]) => [
            key,
            key === "actorRecipeContext" && entry && typeof entry === "object"
                ? stripPrivateOrigins(Object.fromEntries(Object.entries(entry).filter(([contextKey]) => contextKey !== "file")))
                : stripPrivateOrigins(entry),
        ]));
    };
    const redactedRecord = (value) => SessionEvidence.redactSessionEvidenceValue(stripPrivateOrigins(value));
    const primarySourceKind = primary?.source_kind === "active_skill_component"
        ? "active_skill_component"
        : primary?.source_kind === "user_registry_capability" ||
            meta.launch_source === "tool"
            ? "user_registry_capability"
            : "explicit_file_recipe";
    const primaryLogicalReference = typeof primary?.logical_reference === "string"
        ? primary.logical_reference
        : typeof primary?.name === "string"
            ? primary.name
            : typeof meta.recipe === "string"
                ? meta.recipe
                : "unknown";
    const launchValues = meta.values && typeof meta.values === "object" && !Array.isArray(meta.values)
        ? Object.fromEntries(Object.entries(meta.values).filter(([key]) => key !== "recipe_dir" && key !== "skill_dir"))
        : meta.values;
    return {
        composition: contexts.map((entry) => redactedRecord({
            ...(typeof entry.alias === "string" ? { alias: entry.alias } : {}),
            depth: entry.depth,
            import_path: entry.import_path,
            logical_reference: entry.logical_reference ?? entry.name,
            recipe_stem: entry.name,
            role: entry.role,
            ...(typeof entry.skill === "string" ? { skill: entry.skill } : {}),
            source_kind: entry.source_kind === "active_skill_component"
                ? "active_skill_component"
                : entry.source_kind === "user_registry_capability" ||
                    (entry.depth === 0 && meta.launch_source === "tool")
                    ? "user_registry_capability"
                    : "explicit_file_recipe",
        })),
        ...(definition ? { definition: redactedRecord(definition) } : {}),
        diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message),
        identity: redactedRecord({
            run: meta.run,
            recipe: meta.recipe,
            recipe_stem: primary?.name ?? meta.recipe,
            logical_reference: primaryLogicalReference,
            ...(typeof primary?.skill === "string" ? { skill: primary.skill } : {}),
            source_kind: primarySourceKind,
            launch_kind: meta.launch_kind ?? meta.launch_source,
            launch_source: meta.launch_source,
            ...(meta.singleton === true
                ? { singleton: true, singleton_recipe_id: meta.singleton_recipe_id }
                : {}),
        }),
        launch: redactedRecord({
            cwd: meta.cwd,
            template: meta.template,
            values: launchValues,
            model_policy: meta.model_policy,
            control: meta.control,
            artifacts: meta.artifacts,
            notification_policy: meta.notification_policy,
            retire_when: meta.retire_when,
            singleton_values: meta.singleton_values,
        }),
    };
}
