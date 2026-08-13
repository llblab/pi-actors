/**
 * Actor Inspector evidence readers.
 * Zones: owned actor-instance inventory and captured Recipe projection
 * Owns actor-instance TUI evidence; Trace, Control, and execution parsing stay in their domains.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as SessionEvidence from "./session-evidence.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export interface ActorInspectorRunItem {
  run: string;
  runInstanceId?: string;
  status: string;
  updatedAt?: string;
}

function matchesOwner(stateDir: string, ownerId: string): boolean {
  const meta = readJsonFileResilient<Record<string, unknown>>(
    path.join(stateDir, "run.json"),
    {},
  ).value;
  return meta.ownerId === ownerId;
}

export function readActorInspectorRuns(
  stateRoot: string,
  ownerId: string,
): ActorInspectorRunItem[] {
  try {
    return fs
      .readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const stateDir = path.join(stateRoot, entry.name);
        if (!matchesOwner(stateDir, ownerId)) return [];
        const runMeta = readJsonFileResilient<Record<string, unknown>>(
          path.join(stateDir, "run.json"),
          {},
        ).value;
        const progress = readJsonFileResilient<Record<string, unknown>>(
          path.join(stateDir, "progress.json"),
          {},
        ).value;
        const result = readJsonFileResilient<Record<string, unknown>>(
          path.join(stateDir, "result.json"),
          {},
        ).value;
        return [{
          run: entry.name,
          ...(typeof runMeta.run_instance_id === "string"
            ? { runInstanceId: runMeta.run_instance_id }
            : {}),
          status: String(
            progress.phase ??
              (Object.keys(result).length ? "terminal" : "unknown"),
          ),
          ...(typeof progress.updatedAt === "string"
            ? { updatedAt: progress.updatedAt }
            : typeof result.completedAt === "string"
              ? { updatedAt: result.completedAt }
              : {}),
        }];
      })
      .sort((left, right) =>
        String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
        right.run.localeCompare(left.run),
      );
  } catch {
    return [];
  }
}

export interface ActorInspectorRecipeView {
  composition: Array<Record<string, unknown>>;
  definition?: Record<string, unknown>;
  diagnostics: string[];
  identity: Record<string, unknown>;
  launch: Record<string, unknown>;
}

export function readActorInspectorRecipe(
  stateDir: string,
): ActorInspectorRecipeView {
  const result = readJsonFileResilient<Record<string, unknown>>(
    path.join(stateDir, "run.json"),
    {},
  );
  const meta = result.value;
  const contexts = Array.isArray(meta.recipe_context_records)
    ? meta.recipe_context_records.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
  const primary = contexts.find((entry) => entry.depth === 0) ?? contexts[0];
  const definition =
    primary?.recipe &&
    typeof primary.recipe === "object" &&
    !Array.isArray(primary.recipe)
      ? (primary.recipe as Record<string, unknown>)
      : undefined;
  const stripPrivateOrigins = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripPrivateOrigins);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, entry]) =>
            entry !== undefined &&
            key !== "recipe_dir" &&
            key !== "skill_dir" &&
            key !== "source_file",
        )
        .map(([key, entry]) => [
          key,
          key === "actorRecipeContext" && entry && typeof entry === "object"
            ? stripPrivateOrigins(
                Object.fromEntries(
                  Object.entries(entry as Record<string, unknown>).filter(
                    ([contextKey]) => contextKey !== "file",
                  ),
                ),
              )
            : stripPrivateOrigins(entry),
        ]),
    );
  };
  const redactedRecord = (value: Record<string, unknown>): Record<string, unknown> =>
    SessionEvidence.redactSessionEvidenceValue(
      stripPrivateOrigins(value),
    ) as Record<string, unknown>;
  const primarySourceKind =
    primary?.source_kind === "active_skill_component"
      ? "active_skill_component"
      : primary?.source_kind === "user_registry_capability" ||
          meta.launch_source === "tool"
        ? "user_registry_capability"
        : "explicit_file_recipe";
  const primaryLogicalReference =
    typeof primary?.logical_reference === "string"
      ? primary.logical_reference
      : typeof primary?.name === "string"
        ? primary.name
        : typeof meta.recipe === "string"
          ? meta.recipe
          : "unknown";
  const launchValues =
    meta.values && typeof meta.values === "object" && !Array.isArray(meta.values)
      ? Object.fromEntries(
          Object.entries(meta.values as Record<string, unknown>).filter(
            ([key]) => key !== "recipe_dir" && key !== "skill_dir",
          ),
        )
      : meta.values;
  return {
    composition: contexts.map((entry) =>
      redactedRecord({
        ...(typeof entry.alias === "string" ? { alias: entry.alias } : {}),
        depth: entry.depth,
        import_path: entry.import_path,
        logical_reference: entry.logical_reference ?? entry.name,
        recipe_stem: entry.name,
        role: entry.role,
        ...(typeof entry.skill === "string" ? { skill: entry.skill } : {}),
        source_kind:
          entry.source_kind === "active_skill_component"
            ? "active_skill_component"
            : entry.source_kind === "user_registry_capability" ||
                (entry.depth === 0 && meta.launch_source === "tool")
              ? "user_registry_capability"
              : "explicit_file_recipe",
      }),
    ),
    ...(definition ? { definition: redactedRecord(definition) } : {}),
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message),
    identity: redactedRecord({
      run: meta.run,
      recipe: meta.recipe,
      recipe_stem: primary?.name ?? meta.recipe,
      logical_reference: primaryLogicalReference,
      ...(typeof primary?.skill === "string" ? { skill: primary.skill } : {}),
      source_kind: primarySourceKind,
      launch_source: meta.launch_source,
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
    }),
  };
}
