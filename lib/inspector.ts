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
  const redactedRecord = (value: Record<string, unknown>): Record<string, unknown> =>
    SessionEvidence.redactSessionEvidenceValue(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key, entry]) =>
            entry !== undefined &&
            key !== "recipe_dir" &&
            key !== "skill_dir",
        ),
      ),
    ) as Record<string, unknown>;
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
        file: entry.file,
        import_path: entry.import_path,
        name: entry.name,
        qualified_name: entry.qualified_name,
      }),
    ),
    ...(definition ? { definition: redactedRecord(definition) } : {}),
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message),
    identity: redactedRecord({
      run: meta.run,
      recipe: meta.recipe,
      recipe_file: meta.recipe_file,
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
