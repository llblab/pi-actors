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

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeDraftConsolidationInventory(
  records: Array<Record<string, unknown>>,
): DraftConsolidationInventoryItem[] {
  return records
    .flatMap((record) => {
      if (
        typeof record.id !== "string" ||
        typeof record.path !== "string" ||
        typeof record.sha256 !== "string" ||
        typeof record.valid !== "boolean"
      ) {
        return [];
      }
      return [{
        id: record.id,
        path: record.path,
        sha256: record.sha256,
        valid: record.valid,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
        ...(record.diagnostics !== undefined
          ? { diagnostics: record.diagnostics }
          : {}),
        ...(Array.isArray(record.risk_labels)
          ? {
              riskLabels: record.risk_labels.filter(
                (label): label is string => typeof label === "string",
              ),
            }
          : {}),
        ...(typeof record.template_preview === "string"
          ? { templatePreview: record.template_preview }
          : {}),
      }];
    })
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.path.localeCompare(right.path),
    );
}

export function validateDraftConsolidationPlan(
  inventory: DraftConsolidationInventoryItem[],
  plan: DraftConsolidationPlan,
): DraftConsolidationPlanValidation {
  const errors: string[] = [];
  if (!/^[a-f0-9-]{36}$/u.test(plan.cycleId)) {
    errors.push("plan cycleId must be a UUID");
  }
  const inventoryByPath = new Map(inventory.map((item) => [item.path, item]));
  const seen = new Set<string>();
  const targetRecipes = new Map<string, string>();
  const targetPreconditions = new Map<string, string | null>();
  const targetActions = new Map<string, DraftConsolidationAction>();
  for (const item of plan.drafts) {
    const source = inventoryByPath.get(item.draft);
    if (!source) {
      errors.push(`unknown draft: ${item.draft}`);
      continue;
    }
    if (seen.has(item.draft)) {
      errors.push(`duplicate draft decision: ${item.draft}`);
      continue;
    }
    seen.add(item.draft);
    if (item.sha256 !== source.sha256) {
      errors.push(`draft changed after inventory: ${item.draft}`);
    }
    if (!item.rationale.trim()) {
      errors.push(`missing rationale: ${item.draft}`);
    }
    if (item.action === "discard") {
      if (
        item.target !== undefined ||
        item.targetSha256 !== undefined ||
        item.recipe !== undefined
      ) {
        errors.push(`discard must not declare target, targetSha256, or recipe: ${item.draft}`);
      }
    } else if (!item.target || !TOOL_NAME_PATTERN.test(item.target)) {
      errors.push(`${item.action} requires snake_case target: ${item.draft}`);
    } else if (
      item.targetSha256 !== null &&
      (typeof item.targetSha256 !== "string" || !item.targetSha256)
    ) {
      errors.push(`${item.action} requires target precondition: ${item.draft}`);
    } else if (
      !item.recipe ||
      typeof item.recipe !== "object" ||
      Array.isArray(item.recipe) ||
      !Object.hasOwn(item.recipe, "template")
    ) {
      errors.push(`${item.action} requires normalized recipe: ${item.draft}`);
    } else {
      const serialized = canonicalJson(item.recipe);
      const prior = targetRecipes.get(item.target);
      if (prior !== undefined && prior !== serialized) {
        errors.push(`target recipe differs across decisions: ${item.target}`);
      }
      targetRecipes.set(item.target, serialized);
      if (
        targetPreconditions.has(item.target) &&
        targetPreconditions.get(item.target) !== item.targetSha256
      ) {
        errors.push(`target precondition differs across decisions: ${item.target}`);
      }
      targetPreconditions.set(item.target, item.targetSha256 ?? null);
      const priorAction = targetActions.get(item.target);
      if (
        (item.action === "promote" && priorAction !== undefined) ||
        (item.action === "merge" && priorAction === "promote")
      ) {
        errors.push(`target cannot mix or repeat promotion: ${item.target}`);
      }
      targetActions.set(item.target, item.action);
    }
    if (!source.valid && item.action !== "discard") {
      errors.push(`invalid draft may only be discarded: ${item.draft}`);
    }
  }
  for (const item of inventory) {
    if (!seen.has(item.path)) errors.push(`missing draft decision: ${item.path}`);
  }
  return { ok: errors.length === 0, errors };
}
