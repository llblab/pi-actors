/**
 * Deterministic draft consolidation transaction and crash recovery.
 * Owns: cycle claim, source/target compare-and-swap, complete recipe persistence, source quarantine, journal transitions, rollback, and runtime evidence.
 */
import type { DraftConsolidationPlan } from "./draft-consolidation.ts";
import { type DraftConsolidationInventoryItem } from "./draft-consolidation.ts";
export type DraftConsolidationTransactionPhase = "prepared" | "targets_validated" | "sources_quarantined" | "committed_evidence_pending" | "committed" | "rolled_back" | "rollback_required";
interface TargetOperation {
    backupPath?: string;
    expectedSha256: string | null;
    intendedSha256: string;
    path: string;
    recipe: Record<string, unknown>;
    target: string;
}
interface SourceOperation {
    path: string;
    quarantinePath: string;
    sha256: string;
}
interface ConsolidationRootIdentity {
    dev: string;
    ino: string;
    path: string;
    realpath: string;
}
interface ConsolidationRootIdentities {
    cycleDir: ConsolidationRootIdentity;
    draftRoot: ConsolidationRootIdentity;
    recipeRoot: ConsolidationRootIdentity;
}
export interface DraftConsolidationJournal {
    cycleId: string;
    error?: string;
    operationsSha256: string;
    phase: DraftConsolidationTransactionPhase;
    plan: DraftConsolidationPlan;
    planSha256: string;
    roots: ConsolidationRootIdentities;
    sourceScope: "batch" | "complete";
    sources: SourceOperation[];
    targets: TargetOperation[];
    updatedAt: string;
}
export type DraftConsolidationCheckpoint = "prepared" | "target_written" | "targets_validated" | "source_quarantined" | "sources_quarantined" | "committed_evidence_pending" | "evidence_written";
export interface DraftConsolidationTransactionOptions {
    checkpoint?(point: DraftConsolidationCheckpoint): void;
    cycleDir: string;
    draftRoot: string;
    inventory: DraftConsolidationInventoryItem[];
    onLockContention?(): void;
    sourceScope?: "batch" | "complete";
    recipeRoot: string;
}
export interface DraftConsolidationTransactionResult {
    cycleId: string;
    evidencePath: string;
    phase: "committed" | "rolled_back";
    plan: DraftConsolidationPlan;
    sources: number;
    targets: number;
}
export declare function applyDraftConsolidationPlan(plan: DraftConsolidationPlan, options: DraftConsolidationTransactionOptions): DraftConsolidationTransactionResult;
export declare function recoverDraftConsolidationCycle(options: Pick<DraftConsolidationTransactionOptions, "cycleDir" | "draftRoot" | "recipeRoot">): DraftConsolidationTransactionResult;
export {};
