/**
 * Pi-facing tool definition helpers
 * Zones: pi tools, registry tools, async run launchers
 * Owns generated runtime tool schemas and the register_tool management tool schema
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as ActorMessages from "./actor-messages.ts";
import * as ActorRooms from "./actor-rooms.ts";
import * as AsyncRuns from "./async-runs.ts";
import * as CommandTemplates from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import * as Limits from "./limits.ts";
import * as Paths from "./paths.ts";
import * as Prompts from "./prompts.ts";
import * as RecipeDiscovery from "./recipe-discovery.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as RecipeUsage from "./recipe-usage.ts";
import * as Registry from "./registry.ts";
import * as Schema from "./schema.ts";

export type RegisterToolInput = Registry.RegisterToolInput;
export type RegisterToolRuntimeDeps<TContext> =
  Registry.RegisterToolRuntimeDeps<TContext>;

export interface CoreActorToolDefinitionDeps<TContext extends AsyncRunToolContext> {
  configPath: string;
  getActiveTools: () => string[];
  getRuntimeTool: (name: string) => unknown;
  registryRuntime: Pick<
    RegisterToolRuntimeDeps<TContext>,
    | "getExternalToolConflict"
    | "getTools"
    | "notify"
    | "registerRuntimeTool"
  >;
  setActiveTools: (toolNames: string[]) => void;
}

export const RESERVED_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
  "register_tool",
  "message",
  "spawn",
  "inspect",
]);

type JsonSchema = Record<string, unknown>;

function stringSchema(description: string): JsonSchema {
  return { description, type: "string" };
}

function typedArgSchema(
  arg: string,
  type: Schema.ToolArgType | undefined,
): JsonSchema {
  if (!type || type.kind === "string") return stringSchema(`Argument: ${arg}`);
  if (type.kind === "path") return stringSchema(`Path argument: ${arg}`);
  if (type.kind === "int")
    return { description: `Integer argument: ${arg}`, type: "integer" };
  if (type.kind === "number")
    return { description: `Number argument: ${arg}`, type: "number" };
  if (type.kind === "bool")
    return { description: `Boolean argument: ${arg}`, type: "boolean" };
  if (type.kind === "array")
    return { description: `Array argument: ${arg}`, items: {}, type: "array" };
  return {
    description: `Enum argument: ${arg}`,
    enum: type.values,
    type: "string",
  };
}

function booleanSchema(description: string): JsonSchema {
  return { description, type: "boolean" };
}

function nullSchema(description: string): JsonSchema {
  return { description, type: "null" };
}

function arraySchema(description: string): JsonSchema {
  return { description, items: {}, type: "array" };
}

function unionSchema(anyOf: JsonSchema[]): JsonSchema {
  return { anyOf };
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema {
  return { additionalProperties: false, properties, required, type: "object" };
}

function sampleValueForArg(
  arg: string,
  type: Schema.ToolArgType | undefined,
  defaults: Record<string, unknown>,
): unknown {
  if (Object.hasOwn(defaults, arg)) return defaults[arg];
  if (!type || type.kind === "string") return `<${arg}>`;
  if (type.kind === "path") return `./${arg}`;
  if (type.kind === "int") return 1;
  if (type.kind === "number") return 1.5;
  if (type.kind === "bool") return true;
  if (type.kind === "array") return [`<${arg}>`];
  return type.values[0] ?? `<${arg}>`;
}

function shouldAddRuntimeToolUsageHint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^Argument \S+ must /.test(message) || /^Missing .* value: /.test(message)
  );
}

function formatRuntimeToolUsageHint(
  cfg: RegisteredTool,
  required: string[],
  includeRunId: boolean,
): string {
  const optional = cfg.args.filter((arg) => !required.includes(arg));
  const example: Record<string, unknown> = {};
  for (const arg of required)
    example[arg] = sampleValueForArg(arg, cfg.argTypes?.[arg], cfg.defaults);
  for (const arg of optional)
    example[arg] = sampleValueForArg(arg, cfg.argTypes?.[arg], cfg.defaults);
  if (includeRunId) example.run_id = `${cfg.name}-1`;
  const lines = [
    `Expected call shape for ${cfg.name}:`,
    `${cfg.name}(${JSON.stringify(example, null, 2)})`,
  ];
  if (required.length) lines.push(`Required: ${required.join(", ")}`);
  if (optional.length || includeRunId)
    lines.push(
      `Optional: ${[...optional, ...(includeRunId ? ["run_id"] : [])].join(", ")}`,
    );
  return lines.join("\n");
}

function formatRuntimeToolArgumentError(
  cfg: RegisteredTool,
  error: unknown,
  required: string[],
  includeRunId: boolean,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!shouldAddRuntimeToolUsageHint(error))
    return error instanceof Error ? error : new Error(message);
  return new Error(
    `Invalid arguments for tool "${cfg.name}": ${message}\n\n${formatRuntimeToolUsageHint(
      cfg,
      required,
      includeRunId,
    )}`,
  );
}

function looseObjectSchema(description: string): JsonSchema {
  return { additionalProperties: true, description, type: "object" };
}

function jsonText(value: unknown): string {
  return `\n${JSON.stringify(value, null, 2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFailureCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function actorRunNextActions(run: unknown): string[] {
  const id = String(run ?? "").trim();
  if (!id) return [];
  return [
    `inspect target=run:${id} view=status`,
    `inspect target=run:${id} view=messages`,
    `message to=run:${id} type=<actor.action>`,
  ];
}

function compactAsyncRunStatus(value: unknown): string {
  const status = asRecord(value);
  const progress = asRecord(status.progress);
  const result = asRecord(status.result);
  const run = String(status.run ?? "<unknown>");
  const tokens = [
    `run=${run}`,
    `status=${String(status.status ?? "unknown")}`,
  ];
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
  const draftRecipe = status.draft_recipe ?? status.candidate_recipe;
  if (draftRecipe) tokens.push(`draft_recipe=${String(draftRecipe)}`);
  const nextActions = actorRunNextActions(run);
  if (nextActions.length > 0)
    tokens.push(`next=${nextActions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`);
  return `\n${tokens.join(" ")}`;
}

function compactRunMessages(messages: AsyncRuns.RunOutboxEvent[]): string {
  if (messages.length === 0) return "\n(no actor messages)";
  return `\n${messages
    .map((message) =>
      [
        `run=${message.run}`,
        `type=${message.event}`,
        `level=${message.level}`,
        `summary=${message.summary.replaceAll(/\s+/g, "_")}`,
      ].join(" "),
    )
    .join("\n")}`;
}

function compactPreview(
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

function compactRoomPreviews(
  previews: ActorRooms.RoomMessagePreview[],
): string {
  if (previews.length === 0) return "\n(no room message previews)";
  return `\n${previews
    .map((preview) =>
      [
        `ts=${preview.timestamp}`,
        preview.from ? `from=${preview.from}` : "",
        `to=${preview.to}`,
        `type=${preview.type}`,
        preview.summary ? `summary=${compactPreview(preview.summary)}` : "",
        preview.body_preview
          ? `body=${compactPreview(preview.body_preview)}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")}`;
}

function compactRoomMessages(messages: ActorRooms.RoomTimelineEntry[]): string {
  if (messages.length === 0) return "\n(no room messages)";
  return `\n${messages
    .map((message) =>
      [
        `ts=${message.received_at}`,
        `from=${String(message.from ?? "<unknown>")}`,
        `to=${message.to}`,
        `type=${message.type}`,
        `summary=${String(message.summary ?? "").replaceAll(/\s+/g, "_")}`,
        compactPreview(message.body)
          ? `body=${compactPreview(message.body)}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")}`;
}

function compactRoomContacts(contacts: ActorRooms.RoomContact[]): string {
  if (contacts.length === 0) return "\n(no room contacts)";
  return `\n${contacts
    .map((contact) =>
      [
        `address=${contact.address}`,
        contact.role !== undefined ? `role=${String(contact.role)}` : "",
        contact.parent !== undefined ? `parent=${String(contact.parent)}` : "",
        contact.caps !== undefined
          ? `caps=${Array.isArray(contact.caps) ? contact.caps.join(",") : String(contact.caps)}`
          : "",
        contact.claim !== undefined
          ? `claim=${String(contact.claim).replaceAll(/\s+/g, "_")}`
          : "",
        contact.status !== undefined ? `status=${String(contact.status)}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")}`;
}

function compactRoomRoster(
  roster: Record<string, ActorRooms.RoomMember>,
): string {
  const members = Object.values(roster);
  if (members.length === 0) return "\n(no room members)";
  return `\n${members
    .map((member) =>
      [
        `address=${member.address}`,
        `role=${String(member.role ?? "")}`,
        member.parent !== undefined ? `parent=${String(member.parent)}` : "",
        member.caps !== undefined
          ? `caps=${Array.isArray(member.caps) ? member.caps.join(",") : String(member.caps)}`
          : "",
        member.claim !== undefined
          ? `claim=${String(member.claim).replaceAll(/\s+/g, "_")}`
          : "",
        `status=${String(member.status ?? "")}`,
        `last_seen=${member.last_seen}`,
      ].join(" "),
    )
    .join("\n")}`;
}

function compactRoomStatus(status: ActorRooms.RoomStatus): string {
  return `\nroom=${status.room} messages=${status.message_count} roster=${status.roster_count}${status.diagnostics_count ? ` diagnostics=${status.diagnostics_count}` : ""}${status.last_message_at ? ` last_message_at=${status.last_message_at}` : ""}${status.last_message_from ? ` last_from=${status.last_message_from}` : ""}${status.last_message_type ? ` last_type=${status.last_message_type}` : ""}${status.last_message_summary ? ` last_summary=${compactPreview(status.last_message_summary)}` : ""}`;
}

function compactCommunicationSnapshot(
  snapshot: ActorRooms.ActorCommunicationSnapshot | undefined,
): string {
  if (!snapshot) return "\n(no communication snapshot)";
  return `\nself=${snapshot.self} root=${snapshot.root} rooms=${snapshot.rooms.length} updated_at=${snapshot.updated_at}`;
}

function compactInboxMessages(
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

function compactBranchInbox(messages: Array<Record<string, unknown>>): string {
  return compactInboxMessages(messages, "branch inbox");
}

function normalizeMailboxEntry(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") return { type: value };
  const record = asRecord(value);
  if (typeof record.type !== "string" || !record.type.trim()) return undefined;
  return {
    type: record.type.trim(),
    ...(record.body_schema !== undefined
      ? { body_schema: record.body_schema }
      : {}),
    ...(record.ack !== undefined ? { ack: record.ack } : {}),
    ...(typeof record.idempotency === "string"
      ? { idempotency: record.idempotency }
      : {}),
    ...(typeof record.level === "string" ? { level: record.level } : {}),
    ...(record.requires_response === true ? { requires_response: true } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

function normalizeMailboxContracts(
  mailbox: Record<string, unknown>,
): Record<string, unknown[]> {
  const accepts = Array.isArray(mailbox.accepts)
    ? mailbox.accepts
        .map(normalizeMailboxEntry)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  const emits = Array.isArray(mailbox.emits)
    ? mailbox.emits
        .map(normalizeMailboxEntry)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  return { accepts, emits };
}

function mailboxTypes(entries: unknown[]): string[] {
  return entries.flatMap((entry) =>
    typeof asRecord(entry).type === "string"
      ? [String(asRecord(entry).type)]
      : [],
  );
}

function compactRunMailbox(
  run: string,
  mailbox: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): string {
  const normalized = normalizeMailboxContracts(mailbox);
  return `\nrun=${run} accepts=${mailboxTypes(normalized.accepts).join(",")} emits=${mailboxTypes(normalized.emits).join(",")}${compactInboxMessages(messages, "run inbox")}`;
}

function compactArtifactPath(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record.path ?? "<missing>");
}

function artifactNextActions(run: unknown, artifacts: Record<string, unknown>): string[] {
  const id = String(run ?? "").trim();
  if (!id || Object.keys(artifacts).length === 0) return [];
  return [
    `inspect target=run:${id} view=artifacts verbose=true`,
    `inspect target=run:${id} view=messages`,
  ];
}

function compactActorFiles(status: Record<string, unknown>): string {
  const run = String(status.run ?? "<unknown>");
  const artifacts = asRecord(status.artifacts);
  const files = [
    status.stdoutLog,
    status.stderrLog,
    status.eventsFile,
    status.outboxFile,
    status.state_dir
      ? `${String(status.state_dir)}/communication.json`
      : undefined,
    status.state_dir ? `${String(status.state_dir)}/result.json` : undefined,
  ].filter((file): file is string => typeof file === "string");
  const artifactText = Object.keys(artifacts).length
    ? ` artifacts=${Object.entries(artifacts)
        .map(([key, value]) => `${key}:${compactArtifactPath(value)}`)
        .join(",")}`
    : "";
  const nextActions = artifactNextActions(run, artifacts);
  const nextText = nextActions.length
    ? ` next=${nextActions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`
    : "";
  return `\nrun=${run}${artifactText}${files.length ? ` files=${files.join(",")}` : ""}${nextText}`;
}

function summarizeOtherSessions(
  currentSession: string,
  allRuns: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const otherRuns = allRuns.filter(
    (run) => run.ownerId && run.ownerId !== currentSession,
  );
  return {
    other_runs: otherRuns.length,
    other_sessions: new Set(otherRuns.map((run) => run.ownerId)).size,
  };
}

function compactSessionRuns(
  session: string,
  runs: Array<Record<string, unknown>>,
  summary: Record<string, unknown> = {},
): string {
  const suffix = [
    summary.other_sessions !== undefined
      ? `other_sessions=${String(summary.other_sessions)}`
      : "",
    summary.other_runs !== undefined
      ? `other_runs=${String(summary.other_runs)}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (runs.length === 0)
    return `\nsession=${session} runs=0${suffix ? ` ${suffix}` : ""}`;
  return `\nsession=${session} runs=${runs.length}${suffix ? ` ${suffix}` : ""}\n${runs
    .map((run) => {
      const tokens = [
        `run=${String(run.run ?? "")}`,
        `status=${String(run.status ?? "")}`,
      ];
      if (run.recipe) tokens.push(`recipe=${String(run.recipe)}`);
      if (run.retire_when)
        tokens.push(`retire_when=${String(run.retire_when)}`);
      return tokens.join(" ");
    })
    .join("\n")}`;
}

function getPiActorsRuntimeStatus(): Record<string, unknown> {
  const packagedRecipeRoot = Paths.getPackagedRecipeRoot();
  const packageRoot = dirname(packagedRecipeRoot);
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = existsSync(packageJsonPath)
    ? (JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  let git_commit: string | undefined;
  try {
    git_commit = execFileSync(
      "git",
      ["-C", packageRoot, "rev-parse", "--short", "HEAD"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    git_commit = undefined;
  }
  const entrypoint = new URL(import.meta.url).pathname;
  return {
    entrypoint,
    git_commit,
    mode: entrypoint.includes("/dist/") ? "dist" : "source",
    package_name: packageJson.name ?? "@llblab/pi-actors",
    package_root: packageRoot,
    recipe_root: Paths.getRecipeRoot(),
    packaged_recipe_root: packagedRecipeRoot,
    version: packageJson.version ?? "unknown",
  };
}

function compactPiActorsRuntimeStatus(status: Record<string, unknown>): string {
  return `\npi-actors version=${String(status.version)} mode=${String(status.mode)} path=${String(status.package_root)} entrypoint=${String(status.entrypoint)}${status.git_commit ? ` git=${String(status.git_commit)}` : ""}`;
}

function compactToolActor(name: string, tool: Record<string, unknown>): string {
  const parameters = asRecord(tool.parameters);
  const required = Array.isArray(parameters.required)
    ? parameters.required.join(",")
    : "";
  const properties = asRecord(parameters.properties);
  return `\ntool=${name} description=${String(tool.description ?? "").replaceAll(/\s+/g, "_")} args=${Object.keys(properties).join(",")} required=${required}`;
}

function compactRecipeImports(summary: Record<string, unknown>): string {
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

function compactRecipeDoctor(summary: Record<string, unknown>): string {
  const details = Array.isArray(summary.diagnostic_details)
    ? (summary.diagnostic_details as Array<Record<string, unknown>>)
    : [];
  const remediations = Array.isArray(summary.remediations)
    ? (summary.remediations as Array<Record<string, unknown>>)
    : [];
  const recommendations = Array.isArray(summary.recommendations)
    ? (summary.recommendations as Array<Record<string, unknown>>)
    : [];
  const counts = { error: 0, info: 0, warning: 0 };
  for (const detail of details) {
    const severity = String(detail.severity ?? "info");
    if (severity === "error" || severity === "warning" || severity === "info")
      counts[severity] += 1;
  }
  const topAction = asRecord(summary.top_action);
  const lines = [
    `recipes doctor errors=${counts.error} warnings=${counts.warning} info=${counts.info} actions=${remediations.length} recommendations=${recommendations.length}`,
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
    const blocked = item.blocked_candidate
      ? ` blocked=${compactPreview(item.blocked_candidate, Limits.DOCTOR_ACTION_PREVIEW_CHARS)}`
      : "";
    lines.push(
      `${String(item.severity ?? "info")} kind=${String(item.kind ?? "inspect")} id=${String(item.id ?? "root")}${blocked} action=${action ?? "inspect"}`,
    );
  }
  const nextActions = Array.isArray(summary.next_actions)
    ? (summary.next_actions as string[])
    : [];
  if (nextActions.length > 0) lines[0] = `${lines[0]}${compactNextActions(nextActions)}`;
  return `\n${lines.join("\n")}`;
}

function recipeRegistryNextActions(summary: Record<string, unknown>, view: string): string[] {
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
    const firstPath = typeof drafts[0]?.path === "string" ? drafts[0].path : undefined;
    if (firstPath) actions.push(`spawn file=${firstPath}`);
  }
  return [...new Set(actions)].slice(0, 4);
}

function compactNextActions(actions: string[]): string {
  return actions.length
    ? ` next=${actions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`
    : "";
}

function compactRecipeRegistry(summary: Record<string, unknown>): string {
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
  const drafts = Array.isArray(summary.drafts)
    ? summary.drafts.length
    : Array.isArray(summary.candidates)
      ? summary.candidates.length
      : 0;
  const recommendations = Array.isArray(summary.recommendations)
    ? summary.recommendations.length
    : 0;
  const nextActions = Array.isArray(summary.next_actions)
    ? (summary.next_actions as string[])
    : [];
  return `\nrecipes active=${active} drafts=${drafts} shadowed=${shadowed} invalid=${invalid} disabled=${disabled} recommendations=${recommendations} diagnostics=${diagnostics}${compactNextActions(nextActions)}`;
}

function actorMessageNextActions(
  message: ActorMessages.ActorMessage,
  result: Record<string, unknown>,
): string[] {
  const actions: string[] = [];
  const address = ActorMessages.parseActorAddress(message.to);
  if (result.delivery_error || result.sent === false) {
    if (address.kind === "run" && address.value) {
      actions.push(`inspect target=run:${address.value} view=status`);
      actions.push(`inspect target=run:${address.value} view=mailbox`);
    } else if (address.kind === "branch" && address.value) {
      actions.push(`inspect target=branch:${address.value}/${address.branch ?? "main"} view=mailbox`);
      actions.push(`inspect target=run:${address.value} view=status`);
    }
  }
  if (result.queued === true) {
    if (address.kind === "branch" && address.value) {
      actions.push(`inspect target=branch:${address.value}/${address.branch ?? "main"} view=mailbox`);
    } else if (address.kind === "run" && address.value) {
      actions.push(`inspect target=run:${address.value} view=mailbox`);
    }
  }
  return [...new Set(actions)].slice(0, 3);
}

function compactActorMessageResult(
  message: ActorMessages.ActorMessage,
  result: Record<string, unknown>,
): string {
  const tokens = [
    `to=${message.to}`,
    `type=${message.type}`,
    `message=${result.sent === true || result.stopped === true ? "sent" : "not_sent"}`,
  ];
  if (result.bytes !== undefined) tokens.push(`bytes=${String(result.bytes)}`);
  if (result.queued === true) tokens.push("queued=true");
  if (result.control) tokens.push(`control=${String(result.control)}`);
  if (result.outbox) tokens.push(`messages=${String(result.outbox)}`);
  if (result.message_count !== undefined)
    tokens.push(`messages=${String(result.message_count)}`);
  if (result.roster_count !== undefined)
    tokens.push(`roster=${String(result.roster_count)}`);
  if (result.room) tokens.push(`room=${String(result.room)}`);
  if (result.tool) tokens.push(`tool=${String(result.tool)}`);
  if (result.stopped === true) tokens.push("stopped=true");
  if (result.signal) tokens.push(`signal=${String(result.signal)}`);
  if (result.invoked === true) tokens.push("invoked=true");
  if (result.delivery_error) {
    tokens.push(`delivery_error=${compactPreview(result.delivery_error, 96)}`);
  }
  const nextActions = Array.isArray(result.next_actions)
    ? (result.next_actions as string[])
    : actorMessageNextActions(message, result);
  if (nextActions.length > 0)
    tokens.push(`next=${nextActions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`);
  return `\n${tokens.join(" ")}`;
}

function maybeJsonText(
  value: unknown,
  verbose: boolean | undefined,
  compact: string,
): string {
  return verbose ? jsonText(value) : compact;
}

export function createRegisterToolDefinition<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
) {
  return {
    name: "register_tool",
    label: "Register Tool",
    description: Prompts.REGISTER_TOOL_DESCRIPTION,
    promptSnippet: Prompts.REGISTER_TOOL_PROMPT_SNIPPET,
    promptGuidelines: Prompts.REGISTER_TOOL_GUIDELINES,
    parameters: objectSchema(
      {
        args: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.args),
        async: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.async),
        description: stringSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.description,
        ),
        name: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.name),
        state_dir: stringSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.state_dir,
        ),
        template: unionSchema([
          stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
          looseObjectSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
          arraySchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateArray),
          nullSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateNull),
        ]),
        update: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.update),
        values: looseObjectSchema(
          Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.values,
        ),
      },
      [],
    ),
    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) => Registry.executeRegisterTool(params, ctx, deps),
  };
}

export interface AsyncRunToolContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

function getRunOwnerId(ctx: AsyncRunToolContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.();
}

function messageBodyToRunLine(message: ActorMessages.ActorMessage): string {
  if (message.type !== "run.message") return JSON.stringify(message);
  if (typeof message.body === "string") return message.body;
  if (message.body === undefined) return message.type;
  return JSON.stringify(message.body);
}

function messageBodyToToolParams(
  message: ActorMessages.ActorMessage,
): Record<string, unknown> {
  if (
    message.body &&
    typeof message.body === "object" &&
    !Array.isArray(message.body)
  ) {
    return message.body as Record<string, unknown>;
  }
  if (message.body === undefined) return {};
  return { input: message.body };
}

function formatToolActorFailure(
  tool: string,
  message: ActorMessages.ActorMessage,
  params: Record<string, unknown>,
  error: unknown,
): Error {
  const original = error instanceof Error ? error.message : String(error);
  const paramsPreview = compactPreview(params, 240) ?? "{}";
  return Object.assign(
    new Error(
      `tool actor ${tool} failed for message type ${message.type}: ${original}; params=${paramsPreview}`,
    ),
    {
      message_type: message.type,
      original_error: original,
      params_preview: paramsPreview,
      tool,
    },
  );
}

function shadowedRecipeLaunchDiagnostic(
  recipe: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof recipe !== "string" ||
    recipe.includes("/") ||
    recipe.includes("~")
  )
    return undefined;
  const discovery = RecipeDiscovery.discoverRecipeSources([
    { root: Paths.getRecipeRoot(), defaultTool: true, mutableUsage: true },
    { root: Paths.getPackagedRecipeRoot(), defaultTool: false },
  ]);
  return RecipeDiscovery.getShadowedLaunchDiagnostic(discovery, recipe);
}

function candidateRecipeName(run: string): string {
  return `${run.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "spawn"}.json`;
}

function candidateRecipeDefaults(
  values: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const ignored = new Set([
    "actor_address",
    "communication_file",
    "default_room",
    "run_id",
    "state_dir",
  ]);
  const defaults = Object.fromEntries(
    Object.entries(values).filter(([key]) => !ignored.has(key)),
  );
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function writeSpawnCandidateRecipe(
  input: Record<string, unknown>,
  meta: AsyncRuns.AsyncRunMeta,
): string | undefined {
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.PI_ACTORS_ENABLE_SPAWN_CANDIDATES_IN_TEST !== "1"
  )
    return undefined;
  if (
    input.template === undefined ||
    input.file !== undefined ||
    input.recipe !== undefined
  )
    return undefined;
  const root = Paths.getRecipeCandidateRoot();
  mkdirSync(root, { recursive: true });
  const path = join(root, candidateRecipeName(String(meta.run)));
  const defaults = candidateRecipeDefaults(meta.values);
  const recipe = {
    async: true,
    description: `Draft recipe captured from spawn run ${String(meta.run)}`,
    ...(meta.artifacts ? { artifacts: meta.artifacts } : {}),
    ...(defaults ? { defaults } : {}),
    template: input.template,
  };
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx" });
  return path;
}

function enhanceSpawnRecipeError(error: unknown, recipe: unknown): Error {
  const diagnostic = shadowedRecipeLaunchDiagnostic(recipe);
  if (!diagnostic)
    return error instanceof Error ? error : new Error(String(error));
  const original = error instanceof Error ? error.message : String(error);
  return Object.assign(
    new Error(
      `${original} reason=${diagnostic.reason} active_path=${diagnostic.active_path} blocked_candidate=${diagnostic.blocked_candidate} hint=${diagnostic.hint}`,
    ),
    {
      ...diagnostic,
      original_error: original,
    },
  );
}

function runIdFromActorAddress(
  address: string | undefined,
): string | undefined {
  if (!address) return undefined;
  const parsed = ActorMessages.parseActorAddress(address);
  if (parsed.kind !== "run" || !parsed.value) {
    throw new Error(`Expected run:<id> actor address, received: ${address}`);
  }
  return parsed.value;
}

function assertMessageSenderBelongsToRun(
  message: ActorMessages.ActorMessage,
  run: string,
  routeLabel: string,
): void {
  if (!message.from) {
    throw new Error(`message to ${message.to} requires from=<actor address>.`);
  }
  const sender = ActorMessages.parseActorAddress(message.from);
  if (
    (sender.kind !== "run" && sender.kind !== "branch") ||
    sender.value !== run
  ) {
    throw new Error(
      `message to ${routeLabel} requires from=run:${run} or branch:${run}/<branch>; got ${message.from}.`,
    );
  }
}

async function routeBranchEnvelope(
  stateDir: string,
  runId: string,
  recipient: string,
  message: ActorMessages.ActorMessage,
  _options: { source: "direct" | "room-multicast" },
): Promise<Record<string, unknown>> {
  const branchMessage = { ...message, to: recipient };
  ActorRooms.appendBranchInboxMessage(
    stateDir,
    runId,
    recipient,
    branchMessage,
  );
  try {
    return await AsyncRuns.sendRunMessage(runId, JSON.stringify(branchMessage));
  } catch (error) {
    const record =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    if (record.queued === true) {
      return {
        control_path: record.control_path,
        control_type: record.control_type,
        delivery_error:
          record.delivery_error ??
          (error instanceof Error ? error.message : String(error)),
        inbox_id: record.inbox_id,
        queued: true,
        run: runId,
        sent: false,
        state_dir: stateDir,
      };
    }
    throw error;
  }
}

function getRoomMulticastRecipients(
  message: ActorMessages.ActorMessage,
  run: string,
): string[] {
  const raw = message.metadata?.recipients;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("room multicast metadata.recipients must be an array.");
  }
  return raw.map((recipient) => {
    if (typeof recipient !== "string") {
      throw new Error("room multicast recipients must be actor addresses.");
    }
    const parsed = ActorMessages.parseActorAddress(recipient);
    if (parsed.kind !== "branch" || parsed.value !== run) {
      throw new Error(
        `room multicast recipient must be branch:${run}/<branch>; got ${recipient}.`,
      );
    }
    return ActorMessages.formatActorAddress(parsed);
  });
}

export function createSpawnToolDefinition<
  TContext extends AsyncRunToolContext,
>(): any {
  return {
    name: "spawn",
    label: "Spawn",
    description:
      "Create an addressable actor from a recipe file or inline command template. Use instead of ad hoc shell backgrounding for work that may outlive this turn, needs steering/follow-up/artifacts, runs as a service, fans out, or should be inspected later. Currently spawns run:<id> actors backed by async runs.",
    parameters: objectSchema(
      {
        artifacts: looseObjectSchema(
          "Optional named artifact paths for the spawned actor.",
        ),
        as: stringSchema(
          "Optional actor address for the spawned run, e.g. run:<id>.",
        ),
        file: stringSchema(
          "Optional template recipe JSON file. Bare names resolve under ~/.pi/agent/recipes.",
        ),
        recipe: stringSchema(
          "Alias for file; template recipe JSON file/name to spawn.",
        ),
        state_dir: stringSchema("Optional explicit run state directory."),
        template: unionSchema([
          stringSchema("Inline command template string"),
          arraySchema("Inline command-template sequence or parallel tree"),
          looseObjectSchema(
            "Inline command-template object with flags such as parallel, repeat, retry, failure, and nested template.",
          ),
        ]),
        values: looseObjectSchema(
          "Runtime placeholder values passed to the actor.",
        ),
        verbose: booleanSchema("Return full JSON instead of compact text."),
      },
      [],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = asRecord(params);
      const runId = runIdFromActorAddress(
        typeof input.as === "string" ? input.as : undefined,
      );
      const recipe =
        typeof input.file === "string"
          ? input.file
          : typeof input.recipe === "string"
            ? input.recipe
            : undefined;
      let meta: AsyncRuns.AsyncRunMeta;
      try {
        meta = AsyncRuns.startRun(
          {
            file: recipe,
            launch_source: "spawn",
            ownerId: getRunOwnerId(ctx),
            run_id: runId,
            state_dir:
              typeof input.state_dir === "string" ? input.state_dir : undefined,
            ...(input.template !== undefined
              ? {
                  template:
                    input.template as AsyncRuns.AsyncRunStartParams["template"],
                }
              : {}),
            values: asRecord(input.values),
            ...(input.artifacts &&
            typeof input.artifacts === "object" &&
            !Array.isArray(input.artifacts)
              ? {
                  artifacts: input.artifacts as Record<
                    string,
                    AsyncRuns.RunArtifactDeclaration
                  >,
                }
              : {}),
          },
          ctx.cwd,
        );
      } catch (error) {
        throw enhanceSpawnRecipeError(error, recipe);
      }
      const candidateRecipe = writeSpawnCandidateRecipe(input, meta);
      const nextActions = actorRunNextActions(meta.run);
      const details = {
        ...meta,
        ...(candidateRecipe
          ? { candidate_recipe: candidateRecipe, draft_recipe: candidateRecipe }
          : {}),
        next_actions: nextActions,
      };
      ActorRooms.ensureDefaultRoom(meta.state_dir, String(meta.run));
      ActorRooms.writeCommunicationSnapshot(meta.state_dir, String(meta.run));
      return {
        content: [
          {
            type: "text" as const,
            text: maybeJsonText(
              details,
              input.verbose === true,
              compactAsyncRunStatus(details),
            ),
          },
        ],
        details,
      };
    },
  };
}

export interface InspectToolDeps<TContext = unknown> {
  getTool?: (name: string) => any | undefined;
  packagedRecipeRoot?: string;
  recipeRoot?: string;
}

function getContextSessionId(ctx: unknown): string | undefined {
  return (
    ctx as AsyncRunToolContext | undefined
  )?.sessionManager?.getSessionId?.();
}

function requireContextSessionId(ctx: unknown, actor: string): string {
  const sessionId = getContextSessionId(ctx);
  if (!sessionId) {
    throw new Error(
      `${actor} requires a current coordinator session; use session:<id> or session:all for explicit session inventory.`,
    );
  }
  return sessionId;
}

function sessionMismatchError(input: {
  currentSession?: string;
  expectedSession?: string;
  run?: string;
  target?: string;
}): Error {
  const ownerSession = input.expectedSession ?? "none";
  const currentSession = input.currentSession ?? "none";
  const actor = input.run ? `run:${input.run}` : (input.target ?? "session");
  const hintTarget = input.expectedSession
    ? `session:${input.expectedSession}`
    : "session:all";
  return Object.assign(
    new Error(
      `${actor} reason=session_mismatch owner_session=${ownerSession} current_session=${currentSession} hint=inspect_session:${input.expectedSession ?? "all"}`,
    ),
    {
      current_session: input.currentSession,
      hint: `inspect target=${hintTarget} view=status`,
      owner_session: input.expectedSession,
      reason: "session_mismatch",
      run: input.run,
      target: input.target,
    },
  );
}

function assertRunAccessibleToContext(
  runId: string,
  ctx: unknown,
): Record<string, unknown> {
  const status = AsyncRuns.getRunStatus(runId);
  const sessionId = getContextSessionId(ctx);
  if (sessionId && status.ownerId && status.ownerId !== sessionId) {
    throw sessionMismatchError({
      currentSession: sessionId,
      expectedSession: String(status.ownerId),
      run: runId,
    });
  }
  return status;
}

function assertRunExistsForActorMessage(
  runId: string,
): Record<string, unknown> {
  return AsyncRuns.getRunStatus(runId);
}

export function createInspectToolDefinition<TContext = unknown>(
  deps: InspectToolDeps<TContext> = {},
): any {
  return {
    name: "inspect",
    label: "Inspect",
    description:
      "Intentionally inspect actors at decision points, after follow-ups, or during diagnosis instead of polling. Core targets are run:<id> and tool:<name>; advanced targets include branch:<run>/<branch>, room:<run>, coordinator, session:<id>, and session:all.",
    parameters: objectSchema(
      {
        lines: stringSchema("Line count for tail/messages views. Default 40."),
        status: stringSchema(
          "Optional session run filter: all, running, active, terminal, done, failed, cancelled, killed, or exited.",
        ),
        target: stringSchema(
          "Actor address to inspect, e.g. run:<id> or tool:<name>; advanced: branch:<run>/<branch>, room:<run>, coordinator, session:<id>, session:all.",
        ),
        verbose: booleanSchema(
          "Return full JSON instead of compact text where available.",
        ),
        view: stringSchema(
          "Inspection view. Core run views: status, tail, messages, artifacts, files, mailbox. Advanced views include communication, roster, and contacts.",
        ),
      },
      ["target", "view"],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = asRecord(params);
      const target = String(input.target ?? "");
      const view = String(input.view ?? "");
      if (target === "recipes" || target === "recipe-registry") {
        if (
          view !== "status" &&
          view !== "summary" &&
          view !== "doctor" &&
          view !== "imports"
        ) {
          throw new Error(
            "inspect recipes supports view=status, view=summary, view=doctor, or view=imports.",
          );
        }
        const discovered = RecipeDiscovery.discoverRecipeSources([
          {
            root: deps.recipeRoot ?? Paths.getRecipeRoot(),
            defaultTool: true,
            mutableUsage: true,
          },
          { root: deps.packagedRecipeRoot ?? Paths.getPackagedRecipeRoot() },
        ]);
        const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
        const summaryBase = {
          ...RecipeDiscovery.summarizeDiscovery(discovered),
          drafts: RecipeDiscovery.listCandidateRecipes(
            join(recipeRoot, "candidates"),
          ),
          candidates: RecipeDiscovery.listCandidateRecipes(
            join(recipeRoot, "candidates"),
          ),
        };
        const summary = {
          ...summaryBase,
          next_actions: recipeRegistryNextActions(summaryBase, view),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                summary,
                input.verbose === true,
                view === "doctor"
                  ? compactRecipeDoctor(summary)
                  : view === "imports"
                    ? compactRecipeImports(summary)
                    : compactRecipeRegistry(summary),
              ),
            },
          ],
          details: summary,
        };
      }
      const address = ActorMessages.parseActorAddress(target);
      if (address.kind === "coordinator") {
        if (view !== "status" && view !== "runs") {
          throw new Error(
            "inspect coordinator supports view=status or view=runs.",
          );
        }
        const session = requireContextSessionId(ctx, "inspect coordinator");
        const allRuns = AsyncRuns.listRuns(
          undefined,
          typeof input.status === "string" ? input.status : undefined,
        ).map((run) => AsyncRuns.getRunStatus(String(run.state_dir)));
        const runs = allRuns.filter((run) => run.ownerId === session);
        const sessionSummary = summarizeOtherSessions(session, allRuns);
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                { session, runs, ...sessionSummary },
                input.verbose === true,
                compactSessionRuns(session, runs, sessionSummary),
              ),
            },
          ],
          details: { session, runs, ...sessionSummary },
        };
      }
      if (address.kind === "session") {
        if (view !== "status" && view !== "runs") {
          throw new Error(
            "inspect session:<id> supports view=status or view=runs.",
          );
        }
        const allRuns = AsyncRuns.listRuns(
          undefined,
          typeof input.status === "string" ? input.status : undefined,
        ).map((run) => AsyncRuns.getRunStatus(String(run.state_dir)));
        const runs = allRuns.filter(
          (run) => address.value === "all" || run.ownerId === address.value,
        );
        const sessionSummary =
          address.value === "all"
            ? {}
            : summarizeOtherSessions(address.value || "", allRuns);
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                { session: address.value, runs, ...sessionSummary },
                input.verbose === true,
                compactSessionRuns(address.value || "", runs, sessionSummary),
              ),
            },
          ],
          details: { session: address.value, runs, ...sessionSummary },
        };
      }
      if (address.kind === "tool" && address.value) {
        if (address.value === "pi-actors") {
          if (view !== "status") {
            throw new Error("inspect tool:pi-actors supports view=status.");
          }
          const details = getPiActorsRuntimeStatus();
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  details,
                  input.verbose === true,
                  compactPiActorsRuntimeStatus(details),
                ),
              },
            ],
            details,
          };
        }
        if (view !== "status" && view !== "schema") {
          throw new Error(
            "inspect tool:<name> supports view=status or view=schema.",
          );
        }
        const tool = deps.getTool?.(address.value);
        if (!tool) throw new Error(`tool actor not found: ${address.value}`);
        const details = {
          name: address.value,
          description: tool.description,
          parameters: tool.parameters,
          promptSnippet: tool.promptSnippet,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                details,
                input.verbose === true || view === "schema",
                compactToolActor(address.value, details),
              ),
            },
          ],
          details,
        };
      }
      if (address.kind === "room" && address.value && address.room) {
        const status = assertRunAccessibleToContext(address.value, ctx);
        const stateDir = String(status.state_dir ?? "");
        if (!stateDir)
          throw new Error(`room:${address.value} has no run state directory.`);
        if (view === "status") {
          const status = ActorRooms.getRoomStatus(stateDir, address.room);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  status,
                  input.verbose === true,
                  compactRoomStatus(status),
                ),
              },
            ],
            details: status,
          };
        }
        if (view === "previews") {
          const previews = ActorRooms.readRoomMessagePreviews(
            stateDir,
            address.room,
            Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  previews,
                  input.verbose === true,
                  compactRoomPreviews(previews),
                ),
              },
            ],
            details: { previews },
          };
        }
        if (view === "messages") {
          const messages = ActorRooms.readRoomMessages(
            stateDir,
            address.room,
            Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  messages,
                  input.verbose === true,
                  compactRoomMessages(messages),
                ),
              },
            ],
            details: { messages },
          };
        }
        if (view === "contacts") {
          const contacts = ActorRooms.readRoomContacts(stateDir, address.room);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  contacts,
                  input.verbose === true,
                  compactRoomContacts(contacts),
                ),
              },
            ],
            details: { contacts },
          };
        }
        if (view === "roster") {
          const roster = ActorRooms.readRoomRoster(stateDir, address.room);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  roster,
                  input.verbose === true,
                  compactRoomRoster(roster),
                ),
              },
            ],
            details: { roster },
          };
        }
        throw new Error(
          "inspect room:<run> supports view=status, view=messages, view=previews, view=roster, or view=contacts.",
        );
      }
      const runId =
        address.kind === "run" || address.kind === "branch"
          ? address.value
          : undefined;
      if (!runId)
        throw new Error(
          "inspect target must be run:<id>, branch:<run>/<branch>, coordinator, session:<id>, or tool:<name>.",
        );
      if (address.kind === "branch") {
        if (view !== "mailbox")
          throw new Error(
            "inspect branch:<run>/<branch> supports view=mailbox.",
          );
        const status = assertRunAccessibleToContext(runId, ctx);
        const branchInbox = ActorRooms.readBranchInboxDiagnostics(
          String(status.state_dir ?? ""),
          runId,
          target,
          Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
        );
        const messages = branchInbox.messages;
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                input.verbose === true ? branchInbox : messages,
                input.verbose === true,
                `${compactBranchInbox(messages.map((message) => ({ ...message })))}${branchInbox.corrupted > 0 ? `\ncorrupted=${branchInbox.corrupted}` : ""}`,
              ),
            },
          ],
          details: { corrupted: branchInbox.corrupted, messages },
        };
      }
      switch (view) {
        case "status": {
          const status = assertRunAccessibleToContext(runId, ctx);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  status,
                  input.verbose === true,
                  compactAsyncRunStatus(status),
                ),
              },
            ],
            details: status,
          };
        }
        case "tail": {
          assertRunAccessibleToContext(runId, ctx);
          const text = AsyncRuns.tailRun(
            runId,
            Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
          );
          return {
            content: [{ type: "text" as const, text: `\n${text}` }],
            details: {},
          };
        }
        case "messages": {
          assertRunAccessibleToContext(runId, ctx);
          const messages = AsyncRuns.readRunEvents(
            runId,
            Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  messages,
                  input.verbose === true,
                  compactRunMessages(messages),
                ),
              },
            ],
            details: { messages },
          };
        }
        case "artifacts":
        case "files": {
          const status = assertRunAccessibleToContext(runId, ctx);
          const artifactManifest = AsyncRuns.resolveArtifactManifest(
            status.artifacts as
              | Record<string, AsyncRuns.RunArtifactDeclaration>
              | undefined,
          );
          const details = artifactManifest
            ? {
                ...status,
                artifact_manifest: artifactManifest,
                next_actions: artifactNextActions(
                  status.run ?? runId,
                  asRecord(status.artifacts),
                ),
              }
            : status;
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  details,
                  input.verbose === true,
                  compactActorFiles(status),
                ),
              },
            ],
            details,
          };
        }
        case "mailbox": {
          const status = assertRunAccessibleToContext(runId, ctx);
          const mailbox = asRecord(status.mailbox);
          const normalizedMailbox = normalizeMailboxContracts(mailbox);
          const messages = AsyncRuns.readRunInboxMessages(
            runId,
            Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
          );
          const details = {
            mailbox,
            normalized_mailbox: normalizedMailbox,
            messages,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  details,
                  input.verbose === true,
                  compactRunMailbox(
                    String(status.run ?? runId),
                    mailbox,
                    messages,
                  ),
                ),
              },
            ],
            details,
          };
        }
        case "communication": {
          const status = assertRunAccessibleToContext(runId, ctx);
          const snapshot = ActorRooms.readCommunicationSnapshot(
            String(status.state_dir ?? ""),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  snapshot ?? {},
                  input.verbose === true,
                  compactCommunicationSnapshot(snapshot),
                ),
              },
            ],
            details: { communication: snapshot },
          };
        }
        default:
          throw new Error(
            "inspect view must be one of: status, tail, messages, artifacts, files, mailbox, communication; branch targets support mailbox.",
          );
      }
    },
  };
}

export interface ActorMessageToolDeps<TContext = unknown> {
  getTool?: (name: string) => any | undefined;
}

export function createActorMessageToolDefinition<TContext = unknown>(
  deps: ActorMessageToolDeps<TContext> = {},
): any {
  return {
    name: "message",
    label: "Message",
    description:
      "Send one typed addressed message to steer an existing actor instead of restarting it. Core routes are run:<id> and tool:<name>; advanced routes include branch:<run>/<branch>, room:<run> group timelines, coordinator, and session:<id>.",
    parameters: objectSchema(
      {
        body: unionSchema([
          stringSchema(
            "Message body. For run:<id>, this is the run-local command line.",
          ),
          looseObjectSchema("Structured JSON message body."),
          arraySchema("Structured JSON message body array."),
        ]),
        correlation_id: stringSchema(
          "Optional correlation id for workflow/task linkage.",
        ),
        from: stringSchema(
          "Optional sender address, such as coordinator or run:<id>.",
        ),
        metadata: looseObjectSchema(
          "Optional structured metadata for routing or domain hints.",
        ),
        reply_to: stringSchema("Optional message id this message replies to."),
        summary: stringSchema("Optional short human-facing summary."),
        to: stringSchema(
          "Destination actor address, e.g. run:<id> or tool:<name>; advanced: branch:<run>/<branch>, room:<run>, coordinator, session:<id>.",
        ),
        type: stringSchema(
          "Semantic message type, e.g. control.approve or checkpoint.needs_scope.",
        ),
        verbose: booleanSchema("Return full JSON instead of compact text."),
      },
      ["to", "type"],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const input = asRecord(params);
      const message = ActorMessages.normalizeActorMessage(input);
      const address = ActorMessages.parseActorAddress(message.to);
      let result: Record<string, unknown>;
      if (address.kind === "run" && address.value) {
        const status = assertRunAccessibleToContext(address.value, ctx);
        const normalizedMailbox = normalizeMailboxContracts(
          asRecord(status.mailbox),
        );
        const acceptedTypes = new Set(mailboxTypes(normalizedMailbox.accepts));
        const advisoryWarnings =
          acceptedTypes.size > 0 && !acceptedTypes.has(message.type)
            ? [
                `Message type ${message.type} is not declared in mailbox.accepts for run:${address.value}.`,
              ]
            : [];
        if (message.type === "control.kill") {
          result = AsyncRuns.killRun(address.value);
        } else if (message.type === "control.archive") {
          result = AsyncRuns.archiveRun(address.value);
        } else if (message.type === "control.prune") {
          const body = asRecord(message.body);
          result = AsyncRuns.pruneRun(address.value, {
            preserveArtifacts:
              body.preserve_artifacts === true ||
              body.preserveArtifacts === true,
          });
        } else {
          result = await AsyncRuns.sendRunMessage(
            address.value,
            messageBodyToRunLine(message),
          );
        }
        if (advisoryWarnings.length > 0)
          result = { ...result, warnings: advisoryWarnings };
      } else if (address.kind === "branch" && address.value) {
        const runId = address.value;
        if (message.from)
          assertMessageSenderBelongsToRun(
            message,
            runId,
            `branch:${runId}/<branch>`,
          );
        const status = assertRunAccessibleToContext(runId, ctx);
        const stateDir = String(status.state_dir ?? "");
        if (stateDir && address.branch) {
          const ensureBranchMember = (actorAddress: string) => {
            ActorRooms.ensureRoomMember(
              stateDir,
              runId,
              "main",
              actorAddress,
              {
                parent: `run:${runId}`,
                role: "branch",
                status: "present",
              },
              "Branch joined default room",
            );
            ActorRooms.writeBranchCommunicationSnapshot(
              stateDir,
              runId,
              actorAddress,
            );
          };
          ensureBranchMember(message.to);
          if (message.from) {
            const sender = ActorMessages.parseActorAddress(message.from);
            if (sender.kind === "branch" && sender.value === runId) {
              ensureBranchMember(message.from);
            }
          }
          ActorRooms.writeCommunicationSnapshot(stateDir, runId);
        }
        result = await routeBranchEnvelope(
          stateDir,
          runId,
          message.to,
          message,
          {
            source: "direct",
          },
        );
      } else if (address.kind === "room" && address.value && address.room) {
        const runId = address.value;
        assertMessageSenderBelongsToRun(message, runId, `room:${runId}`);
        const status = assertRunAccessibleToContext(runId, ctx);
        const stateDir = String(status.state_dir ?? "");
        if (!stateDir)
          throw new Error(`${message.to} has no run state directory.`);
        const recipients = getRoomMulticastRecipients(message, runId);
        const roomResult = ActorRooms.appendRoomMessage(
          stateDir,
          address.room,
          message,
        );
        await Promise.all(
          recipients.map((recipient) =>
            routeBranchEnvelope(stateDir, runId, recipient, message, {
              source: "room-multicast",
            }),
          ),
        );
        result = {
          ...roomResult,
          ...(recipients.length > 0
            ? { multicast: recipients, multicast_count: recipients.length }
            : {}),
        };
      } else if (address.kind === "tool" && address.value) {
        const tool = deps.getTool?.(address.value);
        if (!tool || typeof tool.execute !== "function") {
          throw new Error(
            `tool actor not found or not executable: ${address.value}`,
          );
        }
        const toolParams = messageBodyToToolParams(message);
        let toolResult: unknown;
        try {
          toolResult = await tool.execute(
            `message:${message.type}`,
            toolParams,
            _signal,
            _onUpdate,
            ctx,
          );
        } catch (error) {
          throw formatToolActorFailure(
            address.value,
            message,
            toolParams,
            error,
          );
        }
        result = {
          invoked: true,
          sent: true,
          tool: address.value,
          tool_result: toolResult,
        };
      } else if (address.kind === "coordinator" || address.kind === "session") {
        if (!message.from) {
          throw new Error(`message to ${address.kind} requires from=run:<id>.`);
        }
        const sender = ActorMessages.parseActorAddress(message.from);
        if (sender.kind !== "run" || !sender.value) {
          throw new Error(
            `message to ${address.kind} currently requires from=run:<id>.`,
          );
        }
        const senderStatus = assertRunAccessibleToContext(sender.value, ctx);
        if (address.kind === "session") {
          if (!senderStatus.ownerId) {
            throw sessionMismatchError({
              currentSession: undefined,
              expectedSession: address.value,
              run: sender.value,
              target: `session:${address.value}`,
            });
          }
          if (senderStatus.ownerId !== address.value) {
            throw sessionMismatchError({
              currentSession: String(senderStatus.ownerId),
              expectedSession: address.value,
              run: sender.value,
              target: `session:${address.value}`,
            });
          }
        }
        result = AsyncRuns.appendRunOutboxEvent(sender.value, {
          body: message.body,
          correlation_id: message.correlation_id,
          delivery:
            message.metadata?.requires_response === true ||
            address.kind === "session"
              ? "followup"
              : undefined,
          event: message.type,
          from: message.from,
          metadata: message.metadata,
          reply_to: message.reply_to,
          summary: message.summary,
          to: message.to,
          type: message.type,
        });
      } else {
        throw new Error(
          `message currently supports run:<id>, branch:<run>/<branch>, room:<run>, tool:<name>, coordinator, and session:<id> destinations; unsupported destination: ${message.to}`,
        );
      }
      const nextActions = actorMessageNextActions(message, result);
      const resultWithNext = nextActions.length
        ? { ...result, next_actions: nextActions }
        : result;
      return {
        content: [
          {
            type: "text" as const,
            text: maybeJsonText(
              { message, result: resultWithNext },
              input.verbose === true,
              compactActorMessageResult(message, resultWithNext),
            ),
          },
        ],
        details: { message, result: resultWithNext },
      };
    },
  };
}

export function createCoreActorToolDefinitions<TContext extends AsyncRunToolContext>(
  deps: CoreActorToolDefinitionDeps<TContext>,
): any[] {
  return [
    createRegisterToolDefinition<TContext>({
      configPath: deps.configPath,
      getActiveTools: deps.getActiveTools,
      getExternalToolConflict: deps.registryRuntime.getExternalToolConflict,
      getTools: deps.registryRuntime.getTools,
      notify: deps.registryRuntime.notify,
      registerRuntimeTool: deps.registryRuntime.registerRuntimeTool,
      reservedToolNames: RESERVED_TOOL_NAMES,
      setActiveTools: deps.setActiveTools,
    }),
    createSpawnToolDefinition<TContext>(),
    createActorMessageToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
    }),
    createInspectToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
    }),
  ];
}

export function createRuntimeToolDefinition(
  cfg: RegisteredTool,
  exec: Execution.RegisteredToolExec,
): any {
  const paramSchema: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const isRecipe = RecipeReferences.isRecipeTool(cfg.template, cfg.recipe);
  const isAsyncRecipe =
    cfg.recipe?.async === true ||
    RecipeReferences.isAsyncRecipeReference(cfg.template);
  const recipeTemplate =
    cfg.recipe?.template ?? RecipeReferences.getRecipeTemplate(cfg.template);
  const requiredTemplate = recipeTemplate ?? cfg.template!;
  const requiredTemplateConfig: CommandTemplates.CommandTemplateConfig =
    typeof requiredTemplate === "object" && !Array.isArray(requiredTemplate)
      ? {
          ...requiredTemplate,
          args: cfg.args,
          defaults: { ...(requiredTemplate.defaults ?? {}), ...cfg.defaults },
        }
      : {
          args: cfg.args,
          defaults: cfg.defaults,
          template: requiredTemplate,
        };
  const requiredArgs =
    isRecipe && cfg.storedArgs !== undefined
      ? new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)))
      : RecipeReferences.isRecipeReference(cfg.template) && !recipeTemplate
        ? new Set(cfg.args.filter((arg) => !Object.hasOwn(cfg.defaults, arg)))
        : Schema.getRequiredToolArgNames(requiredTemplateConfig);
  for (const arg of cfg.args) {
    paramSchema[arg] = typedArgSchema(arg, cfg.argTypes?.[arg]);
    if (requiredArgs.has(arg)) required.push(arg);
  }
  if (isAsyncRecipe)
    paramSchema.run_id = stringSchema(
      "Optional run id override for this async template recipe invocation.",
    );
  return {
    name: cfg.name,
    label: cfg.name,
    description: cfg.description,
    parameters: objectSchema(paramSchema, required),
    promptSnippet: isRecipe
      ? Prompts.formatRecipeToolPromptSnippet(
          cfg.recipe?.name ?? String(cfg.template),
          isAsyncRecipe,
        )
      : Prompts.formatRegisteredToolPromptSnippet(cfg.template),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: AsyncRunToolContext,
    ) {
      try {
        if (cfg.sourcePath)
          RecipeUsage.recordRecipeLaunch(cfg.sourcePath, new Date(), "tool");
        if (isAsyncRecipe) {
          const input = params as Record<string, unknown>;
          const { run_id, ...values } = input;
          const base = cfg.recipe ? cfg.recipe : { file: String(cfg.template) };
          const runId =
            typeof run_id === "string" && run_id.trim()
              ? run_id.trim()
              : `${cfg.name}-${Date.now()}`;
          const meta = AsyncRuns.startRun(
            {
              ...base,
              launch_source: "tool",
              ownerId: getRunOwnerId(ctx),
              run_id: runId,
              tool: cfg.name,
              values: Schema.normalizeRuntimeValues(
                { ...(cfg.recipe?.values ?? {}), ...cfg.defaults, ...values },
                cfg.argTypes,
              ),
            },
            ctx.cwd,
          );
          ActorRooms.ensureDefaultRoom(meta.state_dir, String(meta.run));
          ActorRooms.writeCommunicationSnapshot(
            meta.state_dir,
            String(meta.run),
          );
          return {
            content: [
              { type: "text" as const, text: compactAsyncRunStatus(meta) },
            ],
            details: meta,
          };
        }
        if (isRecipe && recipeTemplate) {
          const paramsWithDefaults = {
            ...(cfg.recipe?.values ?? {}),
            ...cfg.defaults,
            ...(params as Record<string, unknown>),
          };
          return await Execution.executeRegisteredTool(
            { ...cfg, template: recipeTemplate },
            Schema.normalizeRuntimeValues(paramsWithDefaults, cfg.argTypes),
            exec,
            ctx.cwd,
            signal,
          );
        }
        return await Execution.executeRegisteredTool(
          cfg,
          Schema.normalizeRuntimeValues(
            params as Record<string, unknown>,
            cfg.argTypes,
          ),
          exec,
          ctx.cwd,
          signal,
        );
      } catch (error) {
        throw formatRuntimeToolArgumentError(
          cfg,
          error,
          required,
          isAsyncRecipe,
        );
      }
    },
  };
}
