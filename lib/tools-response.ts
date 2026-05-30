/**
 * Public tool response formatting
 * Zones: compact text summaries, verbose JSON switching, next-action rendering
 * Owns model-facing response helpers shared by public tool execution paths
 */

import * as Limits from "./limits.ts";
import * as ToolsMailbox from "./tools-mailbox.ts";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jsonText(value: unknown): string {
  return `\n${JSON.stringify(value, null, 2)}`;
}

export function compactPreview(
  value: unknown,
  maxLength = Limits.COMPACT_PREVIEW_CHARS,
): string | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, undefined, 0);
  const compact = text.replaceAll(/\s+/g, "_");
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
    : compact;
}

export function compactNextActions(actions: string[]): string {
  return actions.length
    ? ` next=${actions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`
    : "";
}

function formatFailureCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

export function actorRunNextActions(run: unknown): string[] {
  const id = String(run ?? "").trim();
  if (!id) return [];
  return [
    `inspect target=run:${id} view=status`,
    `inspect target=run:${id} view=messages`,
    `message to=run:${id} type=<actor.action>`,
  ];
}

export function compactAsyncRunStatus(value: unknown): string {
  const status = asRecord(value);
  const progress = asRecord(status.progress);
  const result = asRecord(status.result);
  const run = String(status.run ?? "<unknown>");
  const tokens = [`run=${run}`, `status=${String(status.status ?? "unknown")}`];
  if (status.tool) tokens.push(`tool=${String(status.tool)}`);
  if (status.recipe) tokens.push(`recipe=${String(status.recipe)}`);
  if (status.retire_when)
    tokens.push(`retire_when=${String(status.retire_when)}`);
  if (Number(status.pid) > 0) tokens.push(`pid=${Number(status.pid)}`);
  if (progress.phase && progress.phase !== status.status)
    tokens.push(`phase=${String(progress.phase)}`);
  if (Number(progress.activeSubagents) > 0)
    tokens.push(`active=${Number(progress.activeSubagents)}`);
  if (Number(progress.completed) > 0)
    tokens.push(`completed=${Number(progress.completed)}`);
  const failures = formatFailureCount(progress.failures);
  if (failures !== undefined && failures > 0)
    tokens.push(`failures=${failures}`);
  if (result.code !== undefined) tokens.push(`code=${String(result.code)}`);
  if (result.killed === true) tokens.push("killed=true");
  const draftRecipe = status.draft_recipe;
  if (draftRecipe) tokens.push(`draft_recipe=${String(draftRecipe)}`);
  const nextActions = actorRunNextActions(run);
  if (nextActions.length > 0)
    tokens.push(
      `next=${nextActions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`,
    );
  return `\n${tokens.join(" ")}`;
}

export function compactInboxMessages(
  messages: Array<Record<string, unknown>>,
  emptyLabel: string,
): string {
  if (messages.length === 0) return `\n(no ${emptyLabel} messages)`;
  return `\n${messages
    .map((message) =>
      [
        ...(message.id ? [`id=${String(message.id)}`] : []),
        `status=${String(message.status ?? "")}`,
        `type=${String(message.type ?? "")}`,
        `from=${String(message.from ?? "")}`,
        `to=${String(message.to ?? "")}`,
        ...(message.queued_at
          ? [`queued_at=${String(message.queued_at)}`]
          : []),
        ...(message.sent_at ? [`sent_at=${String(message.sent_at)}`] : []),
        ...(message.claimed_at
          ? [`claimed_at=${String(message.claimed_at)}`]
          : []),
        ...(message.handled_at
          ? [`handled_at=${String(message.handled_at)}`]
          : []),
        ...(message.failed_at
          ? [`failed_at=${String(message.failed_at)}`]
          : []),
      ].join(" "),
    )
    .join("\n")}`;
}

export function compactBranchInbox(
  messages: Array<Record<string, unknown>>,
): string {
  return compactInboxMessages(messages, "branch inbox");
}

export function compactRunMailbox(
  run: string,
  mailbox: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): string {
  const normalized = ToolsMailbox.normalizeMailboxContracts(mailbox);
  return `\nrun=${run} accepts=${ToolsMailbox.mailboxTypes(normalized.accepts).join(",")} emits=${ToolsMailbox.mailboxTypes(normalized.emits).join(",")}${compactInboxMessages(messages, "run inbox")}`;
}

export function artifactNextActions(
  run: unknown,
  artifacts: Record<string, unknown>,
): string[] {
  const id = String(run ?? "").trim();
  if (!id || Object.keys(artifacts).length === 0) return [];
  return [
    `inspect target=run:${id} view=artifacts verbose=true`,
    `inspect target=run:${id} view=messages`,
  ];
}

export function maybeJsonText(
  value: unknown,
  verbose: boolean | undefined,
  compact: string,
): string {
  return verbose ? jsonText(value) : compact;
}

export function compactRecipeImports(summary: Record<string, unknown>): string {
  const active = Array.isArray(summary.active)
    ? (summary.active as Array<Record<string, unknown>>)
    : [];
  const lines = active.flatMap((entry) => {
    const imports = asRecord(entry.imports);
    return Object.entries(imports).map(([alias, value]) => {
      const binding =
        typeof value === "string" ? { from: value } : asRecord(value);
      return `recipe=${String(entry.id ?? "<unknown>")} alias=${alias} from=${String(binding.from ?? value)}`;
    });
  });
  return lines.length ? `\n${lines.join("\n")}` : "\n(no recipe imports)";
}

export function compactRecipeDoctor(summary: Record<string, unknown>): string {
  const details = Array.isArray(summary.diagnostic_details)
    ? (summary.diagnostic_details as Array<Record<string, unknown>>)
    : [];
  const remediations = Array.isArray(summary.remediations)
    ? (summary.remediations as Array<Record<string, unknown>>)
    : [];
  const recommendations = Array.isArray(summary.recommendations)
    ? (summary.recommendations as Array<Record<string, unknown>>)
    : [];
  const riskSummary = Array.isArray(summary.risk_summary)
    ? (summary.risk_summary as Array<Record<string, unknown>>)
    : [];
  const counts = { error: 0, info: 0, warning: 0 };
  for (const detail of details) {
    const severity = String(detail.severity ?? "info");
    if (severity === "error" || severity === "warning" || severity === "info")
      counts[severity] += 1;
  }
  const riskCount = riskSummary.reduce(
    (total, item) => total + Number(item.count ?? 0),
    0,
  );
  const topRisks = riskSummary
    .slice(0, 4)
    .map((item) => `${String(item.label)}:${String(item.count ?? 0)}`)
    .join(",");
  const topAction = asRecord(summary.top_action);
  const lines = [
    `recipes doctor errors=${counts.error} warnings=${counts.warning} info=${counts.info} actions=${remediations.length} recommendations=${recommendations.length} risks=${riskCount}${topRisks ? ` top_risks=${topRisks}` : ""}`,
  ];
  if (Object.keys(topAction).length > 0) {
    const action = compactPreview(
      topAction.action,
      Limits.DOCTOR_ACTION_PREVIEW_CHARS,
    );
    lines.push(
      `top severity=${String(topAction.severity ?? "info")} kind=${String(topAction.kind ?? "inspect")} id=${String(topAction.id ?? "root")} action=${action ?? "inspect"}`,
    );
  }
  for (const item of remediations.slice(0, 8)) {
    const action = compactPreview(
      item.action,
      Limits.DOCTOR_ACTION_PREVIEW_CHARS,
    );
    const blocked = item.blocked_fallback
      ? ` blocked=${compactPreview(item.blocked_fallback, Limits.DOCTOR_ACTION_PREVIEW_CHARS)}`
      : "";
    const labels = Array.isArray(item.risk_labels)
      ? ` labels=${(item.risk_labels as unknown[]).map(String).slice(0, 4).join(",")}`
      : "";
    lines.push(
      `${String(item.severity ?? "info")} kind=${String(item.kind ?? "inspect")} id=${String(item.id ?? "root")}${blocked}${labels} action=${action ?? "inspect"}`,
    );
  }
  const nextActions = Array.isArray(summary.next_actions)
    ? (summary.next_actions as string[])
    : [];
  if (nextActions.length > 0)
    lines[0] = `${lines[0]}${compactNextActions(nextActions)}`;
  return `\n${lines.join("\n")}`;
}

export function recipeRegistryNextActions(
  summary: Record<string, unknown>,
  view: string,
): string[] {
  const actions: string[] = [];
  const drafts = Array.isArray(summary.drafts)
    ? (summary.drafts as Array<Record<string, unknown>>)
    : [];
  const invalid = Array.isArray(summary.invalid) ? summary.invalid.length : 0;
  const diagnostics = Array.isArray(summary.diagnostics)
    ? summary.diagnostics.length
    : 0;
  const topAction = asRecord(summary.top_action);
  if (view !== "doctor" && (invalid > 0 || diagnostics > 0)) {
    actions.push("inspect target=recipes view=doctor");
  }
  if (view === "doctor" && typeof topAction.action === "string") {
    actions.push(String(topAction.action));
  }
  if (drafts.length > 0) {
    actions.push("inspect target=recipes view=summary verbose=true");
    const firstPath =
      typeof drafts[0]?.path === "string" ? drafts[0].path : undefined;
    if (firstPath) actions.push(`spawn file=${firstPath}`);
  }
  return [...new Set(actions)].slice(0, 4);
}

export function compactRecipeRegistry(
  summary: Record<string, unknown>,
): string {
  const active = Array.isArray(summary.active) ? summary.active.length : 0;
  const shadowed = Array.isArray(summary.shadowed)
    ? summary.shadowed.length
    : 0;
  const invalid = Array.isArray(summary.invalid) ? summary.invalid.length : 0;
  const disabled = Array.isArray(summary.disabled)
    ? summary.disabled.length
    : 0;
  const diagnostics = Array.isArray(summary.diagnostics)
    ? summary.diagnostics.length
    : 0;
  const drafts = Array.isArray(summary.drafts) ? summary.drafts.length : 0;
  const recommendations = Array.isArray(summary.recommendations)
    ? summary.recommendations.length
    : 0;
  const nextActions = Array.isArray(summary.next_actions)
    ? (summary.next_actions as string[])
    : [];
  return `\nrecipes active=${active} drafts=${drafts} shadowed=${shadowed} invalid=${invalid} disabled=${disabled} recommendations=${recommendations} diagnostics=${diagnostics}${compactNextActions(nextActions)}`;
}

export const DEFAULT_INSPECT_LINES = Limits.DEFAULT_INSPECT_LINES;
