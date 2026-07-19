/**
 * Automatic recipe-review confidentiality projection.
 * Owns: value-free model inputs derived from trusted immutable draft/tool captures.
 */

import type {
  DraftReviewInput,
  DraftReviewResult,
} from "./draft-review.ts";
import type {
  ToolReviewInput,
  ToolReviewResult,
} from "./tool-review.ts";

function occurrenceId(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(2, "0")}`;
}

export const draftReviewIdentity = (index: number): string => occurrenceId("draft", index);
export const toolReviewIdentity = (index: number): string => occurrenceId("tool", index);

function contentGroups(hashes: string[]): string[] {
  const groups = new Map<string, string>();
  return hashes.map((hash) => {
    let group = groups.get(hash);
    if (!group) {
      group = occurrenceId("content_group", groups.size);
      groups.set(hash, group);
    }
    return group;
  });
}

function draftContentGroups(input: DraftReviewInput): string[] {
  return contentGroups([
    ...input.activeTools.map((tool) => tool.sha256),
    ...input.drafts.map((draft) => draft.sha256),
  ]);
}

export function draftReviewRevision(input: DraftReviewInput, index: number): string {
  return draftContentGroups(input)[input.activeTools.length + index]!;
}

export function toolReviewRevision(input: ToolReviewInput, index: number): string {
  return contentGroups(input.tools.map((tool) => tool.sha256))[index]!;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function countRecord(value: unknown): number {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

function templateShape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { kind: "command", nodes: 1 };
  if (Array.isArray(value)) {
    return {
      branches: value.length,
      kind: "sequence",
      nodes: 1 + value.reduce((total, child) => total + Number(templateShape(child).nodes ?? 0), 0),
    };
  }
  if (!value || typeof value !== "object") return { kind: "invalid", nodes: 0 };
  const record = value as Record<string, unknown>;
  const children = Array.isArray(record.template)
    ? record.template
    : record.template === undefined
      ? []
      : [record.template];
  return {
    branches: children.length,
    conditional: record.when !== undefined,
    kind: record.parallel === true ? "parallel" : "object",
    repeat: record.repeat !== undefined,
    retry: record.retry !== undefined,
    nodes: 1 + children.reduce(
      (total, child) => total + Number(templateShape(child).nodes ?? 0),
      0,
    ),
  };
}

function contractShape(recipe: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!recipe) return undefined;
  const mailbox = recipe.mailbox && typeof recipe.mailbox === "object" && !Array.isArray(recipe.mailbox)
    ? recipe.mailbox as Record<string, unknown>
    : {};
  return {
    argument_count: countArray(recipe.args),
    artifact_count: countRecord(recipe.artifacts),
    async: recipe.async === true,
    default_count: countRecord(recipe.defaults),
    import_count: countRecord(recipe.imports),
    mailbox_accepts_count: countArray(mailbox.accepts),
    mailbox_emits_count: countArray(mailbox.emits),
    template_shape: templateShape(recipe.template),
  };
}

function usageShape(usage: Record<string, unknown> | undefined): Record<string, number> {
  const numeric = (key: string): number => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  };
  return {
    lifetime_calls: numeric("lifetime_calls") || numeric("calls"),
    revision: numeric("revision"),
    revision_calls: numeric("revision_calls"),
  };
}

export function projectDraftReviewInput(input: DraftReviewInput): Record<string, unknown> {
  return {
    activeTools: input.activeTools.map((_tool, index) => ({
      name: occurrenceId("active_tool", index),
      sha256: draftContentGroups(input)[index],
    })),
    batchId: input.batchId,
    createdAt: input.createdAt,
    drafts: input.drafts.map((draft, index) => ({
      contract: contractShape(draft.recipe),
      draft: draftReviewIdentity(index),
      riskLabels: [...draft.riskLabels],
      sha256: draftReviewRevision(input, index),
      usage: usageShape(draft.usage),
      valid: draft.valid,
    })),
  };
}

export function restoreDraftReviewResult(
  input: DraftReviewInput,
  result: DraftReviewResult,
): DraftReviewResult {
  const drafts = new Map(input.drafts.map((draft, index) => [draftReviewIdentity(index), {
    draft,
    revision: draftReviewRevision(input, index),
  }]));
  return {
    ...result,
    decisions: result.decisions.map((decision) => {
      const captured = drafts.get(decision.draft);
      return {
        ...decision,
        draft: captured?.draft.path ?? `unknown:${decision.draft}`,
        sha256: captured && decision.sha256 === captured.revision
          ? captured.draft.sha256
          : `invalid:${decision.sha256}`,
      };
    }),
  };
}

export function projectToolReviewInput(input: ToolReviewInput): Record<string, unknown> {
  return {
    createdAt: input.createdAt,
    reviewId: input.reviewId,
    tools: input.tools.map((tool, index) => ({
      contract: contractShape(tool.recipe),
      name: toolReviewIdentity(index),
      riskLabels: [...tool.riskLabels],
      sha256: toolReviewRevision(input, index),
      usage: usageShape(tool.usage),
      valid: tool.valid,
    })),
  };
}

export function restoreToolReviewResult(
  input: ToolReviewInput,
  result: ToolReviewResult,
): ToolReviewResult {
  const tools = new Map(input.tools.map((tool, index) => [toolReviewIdentity(index), {
    revision: toolReviewRevision(input, index),
    tool,
  }]));
  return {
    ...result,
    decisions: result.decisions.map((decision) => {
      const captured = tools.get(decision.source);
      return {
        ...decision,
        sha256: captured && decision.sha256 === captured.revision
          ? captured.tool.sha256
          : `invalid:${decision.sha256}`,
        source: captured?.tool.name ?? `unknown:${decision.source}`,
        ...(decision.target
          ? { target: tools.get(decision.target)?.tool.name ?? decision.target }
          : {}),
      };
    }),
  };
}
