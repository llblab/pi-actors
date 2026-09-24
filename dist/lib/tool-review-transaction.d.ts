/**
 * Journaled active-tool portfolio mutation.
 * Zones: approved-plan CAS, source quarantine, target commit, crash recovery
 * Owns deterministic filesystem mutation; reviewer policy and runtime activation remain separate domains.
 */
import type { ToolReviewDecision } from "./tool-review.ts";
export interface ToolReviewApprovedSource {
    action: ToolReviewDecision["action"];
    name: string;
    path: string;
    sha256: string;
}
export interface ToolReviewApprovedTarget {
    expectedSha256: string | null;
    lineage: "demote" | "evolve" | "merge" | "replace" | "split";
    name: string;
    path: string;
    recipe: Record<string, unknown>;
    sources: string[];
}
export interface ToolReviewApprovedPlan {
    createdAt: string;
    decisions: ToolReviewDecision[];
    reviewId: string;
    sources: ToolReviewApprovedSource[];
    targets: ToolReviewApprovedTarget[];
}
export type ToolReviewTransactionPhase = "committed" | "prepared" | "rollback_required" | "rolled_back" | "sources_quarantined" | "targets_written";
export interface ToolReviewTransactionResult {
    evidencePath?: string;
    journalPath: string;
    phase: ToolReviewTransactionPhase;
    quarantineDir: string;
}
export type ToolReviewTransactionCheckpoint = "evidence_written" | "prepared" | "source_quarantined" | "sources_quarantined" | "target_written" | "targets_written";
export interface ToolReviewTransactionOptions {
    checkpoint?(checkpoint: ToolReviewTransactionCheckpoint): void;
    now?(): Date;
    recipeRoot: string;
}
interface PathContainmentApi {
    isAbsolute(path: string): boolean;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
    sep: string;
}
export declare function isPathContained(path: string, root: string, pathApi?: PathContainmentApi): boolean;
export declare function applyToolReviewPlan(approvedPath: string, options: ToolReviewTransactionOptions): ToolReviewTransactionResult;
export declare function recoverToolReviewTransaction(approvedPath: string, options: ToolReviewTransactionOptions): ToolReviewTransactionResult;
export {};
