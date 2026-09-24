/**
 * Tool-review lineage projection.
 * Zones: approved source coverage, target ownership, lineage transition semantics
 * Owns deterministic keep/evolve/replace/demote/merge/split grouping; filesystem mutation and recovery remain separate.
 */
import type { ToolReviewApprovedPlan, ToolReviewApprovedSource, ToolReviewApprovedTarget } from "./tool-review-transaction.ts";
export type ToolReviewLineageOperation = {
    action: "keep";
    sources: [ToolReviewApprovedSource];
    targets: [];
} | {
    action: "demote" | "evolve" | "replace";
    sources: [ToolReviewApprovedSource];
    targets: [ToolReviewApprovedTarget];
} | {
    action: "merge";
    sources: ToolReviewApprovedSource[];
    targets: [ToolReviewApprovedTarget];
} | {
    action: "split";
    sources: [ToolReviewApprovedSource];
    targets: ToolReviewApprovedTarget[];
};
export declare function projectToolReviewLineage(plan: ToolReviewApprovedPlan): ToolReviewLineageOperation[];
