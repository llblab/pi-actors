/**
 * Tool-review lineage projection.
 * Zones: approved source coverage, target ownership, lineage transition semantics
 * Owns deterministic keep/evolve/replace/demote/merge/split grouping; filesystem mutation and recovery remain separate.
 */

import type {
  ToolReviewApprovedPlan,
  ToolReviewApprovedSource,
  ToolReviewApprovedTarget,
} from "./tool-review-transaction.ts";

export type ToolReviewLineageOperation =
  | {
      action: "keep";
      sources: [ToolReviewApprovedSource];
      targets: [];
    }
  | {
      action: "demote" | "evolve" | "replace";
      sources: [ToolReviewApprovedSource];
      targets: [ToolReviewApprovedTarget];
    }
  | {
      action: "merge";
      sources: ToolReviewApprovedSource[];
      targets: [ToolReviewApprovedTarget];
    }
  | {
      action: "split";
      sources: [ToolReviewApprovedSource];
      targets: ToolReviewApprovedTarget[];
    };

function sameNames(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((name, index) => name === [...expected].sort()[index])
  );
}

export function projectToolReviewLineage(
  plan: ToolReviewApprovedPlan,
): ToolReviewLineageOperation[] {
  const sources = new Map<string, ToolReviewApprovedSource>();
  for (const source of plan.sources) {
    if (sources.has(source.name)) {
      throw new Error(`Duplicate tool review lineage source: ${source.name}`);
    }
    sources.set(source.name, source);
  }
  const targetsBySource = new Map<string, ToolReviewApprovedTarget[]>();
  for (const target of plan.targets) {
    if (target.sources.length === 0 || new Set(target.sources).size !== target.sources.length) {
      throw new Error(`Invalid tool review lineage target sources: ${target.name}`);
    }
    for (const sourceName of target.sources) {
      if (!sources.has(sourceName)) {
        throw new Error(`Unknown tool review lineage target source: ${sourceName}`);
      }
      const entries = targetsBySource.get(sourceName) ?? [];
      entries.push(target);
      targetsBySource.set(sourceName, entries);
    }
  }

  const operations: ToolReviewLineageOperation[] = [];
  const handled = new Set<string>();
  for (const source of plan.sources) {
    if (handled.has(source.name)) continue;
    const targets = targetsBySource.get(source.name) ?? [];
    if (source.action === "keep") {
      if (targets.length > 0) {
        throw new Error(`Kept tool owns lineage targets: ${source.name}`);
      }
      operations.push({ action: "keep", sources: [source], targets: [] });
      handled.add(source.name);
      continue;
    }
    if (
      source.action === "demote" ||
      source.action === "evolve" ||
      source.action === "replace"
    ) {
      if (
        targets.length !== 1 ||
        targets[0]!.lineage !== source.action ||
        !sameNames(targets[0]!.sources, [source.name])
      ) {
        throw new Error(`Invalid ${source.action} lineage target: ${source.name}`);
      }
      operations.push({
        action: source.action,
        sources: [source],
        targets: [targets[0]!],
      });
      handled.add(source.name);
      continue;
    }
    if (source.action === "merge") {
      if (targets.length !== 1 || targets[0]!.lineage !== "merge") {
        throw new Error(`Invalid merge lineage target: ${source.name}`);
      }
      const target = targets[0]!;
      const groupSources = target.sources.map((name) => sources.get(name)!);
      if (
        groupSources.length < 2 ||
        groupSources.some((candidate) => candidate.action !== "merge") ||
        !sameNames(
          target.sources,
          groupSources.map((candidate) => candidate.name),
        )
      ) {
        throw new Error(`Invalid merge lineage group: ${target.name}`);
      }
      operations.push({ action: "merge", sources: groupSources, targets: [target] });
      for (const candidate of groupSources) handled.add(candidate.name);
      continue;
    }
    if (source.action === "split") {
      if (
        targets.length < 2 ||
        targets.some(
          (target) =>
            target.lineage !== "split" ||
            !sameNames(target.sources, [source.name]),
        )
      ) {
        throw new Error(`Invalid split lineage targets: ${source.name}`);
      }
      operations.push({
        action: "split",
        sources: [source],
        targets: [...targets].sort((left, right) => left.name.localeCompare(right.name)),
      });
      handled.add(source.name);
      continue;
    }
    throw new Error(`Unsupported tool review lineage action: ${source.action}`);
  }
  if (handled.size !== plan.sources.length) {
    throw new Error("Tool review lineage projection does not cover every source.");
  }
  return operations;
}
