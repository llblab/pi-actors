/**
 * Draft-memory consolidation contracts.
 * Owns: complete inventory normalization and promote/merge/discard plan validation for the automatic executor.
 */
export type DraftConsolidationAction = "promote" | "merge" | "discard";
export interface DraftConsolidationInventoryItem {
    id: string;
    path: string;
    sha256: string;
    valid: boolean;
    description?: string;
    diagnostics?: unknown;
    riskLabels?: string[];
    templatePreview?: string;
}
export interface DraftConsolidationPlanItem {
    action: DraftConsolidationAction;
    draft: string;
    rationale: string;
    recipe?: Record<string, unknown>;
    sha256: string;
    target?: string;
    targetSha256?: string | null;
}
export interface DraftConsolidationPlan {
    createdAt: string;
    cycleId: string;
    drafts: DraftConsolidationPlanItem[];
}
export interface DraftConsolidationPlanValidation {
    ok: boolean;
    errors: string[];
}
export declare function normalizeDraftConsolidationInventory(records: Array<Record<string, unknown>>): DraftConsolidationInventoryItem[];
export declare function validateDraftConsolidationPlan(inventory: DraftConsolidationInventoryItem[], plan: DraftConsolidationPlan): DraftConsolidationPlanValidation;
