/**
 * Public inspect tool behavior
 * Zones: actor observation, recipe registry inspection, room/session/tool/run views
 * Owns the public inspect execution path and compact observation responses
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as Limits from "./limits.ts";
import * as Messages from "./messages.ts";
import * as Paths from "./paths.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as Rooms from "./rooms.ts";
import * as Schema from "./schema.ts";
import * as ToolsAccess from "./tools-access.ts";
import * as ToolsMailbox from "./tools-mailbox.ts";
import * as ToolsResponse from "./tools-response.ts";

const asRecord = ToolsResponse.asRecord;
const maybeJsonText = ToolsResponse.maybeJsonText;

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

function compactRoomPreviews(previews: Rooms.RoomMessagePreview[]): string {
  if (previews.length === 0) return "\n(no room message previews)";
  return `\n${previews
    .map((preview) =>
      [
        `ts=${preview.timestamp}`,
        preview.from ? `from=${preview.from}` : "",
        `to=${preview.to}`,
        `type=${preview.type}`,
        preview.summary
          ? `summary=${ToolsResponse.compactPreview(preview.summary)}`
          : "",
        preview.body_preview
          ? `body=${ToolsResponse.compactPreview(preview.body_preview)}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")}`;
}

function compactRoomMessages(messages: Rooms.RoomTimelineEntry[]): string {
  if (messages.length === 0) return "\n(no room messages)";
  return `\n${messages
    .map((message) =>
      [
        `ts=${message.received_at}`,
        `from=${String(message.from ?? "<unknown>")}`,
        `to=${message.to}`,
        `type=${message.type}`,
        `summary=${String(message.summary ?? "").replaceAll(/\s+/g, "_")}`,
        ToolsResponse.compactPreview(message.body)
          ? `body=${ToolsResponse.compactPreview(message.body)}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")}`;
}

function compactRoomContacts(contacts: Rooms.RoomContact[]): string {
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

function compactRoomRoster(roster: Record<string, Rooms.RoomMember>): string {
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

function compactRoomStatus(status: Rooms.RoomStatus): string {
  return `\nroom=${status.room} messages=${status.message_count} roster=${status.roster_count}${status.diagnostics_count ? ` diagnostics=${status.diagnostics_count}` : ""}${status.last_message_at ? ` last_message_at=${status.last_message_at}` : ""}${status.last_message_from ? ` last_from=${status.last_message_from}` : ""}${status.last_message_type ? ` last_type=${status.last_message_type}` : ""}${status.last_message_summary ? ` last_summary=${ToolsResponse.compactPreview(status.last_message_summary)}` : ""}`;
}

function compactCommunicationSnapshot(
  snapshot: Rooms.ActorCommunicationSnapshot | undefined,
): string {
  if (!snapshot) return "\n(no communication snapshot)";
  return `\nself=${snapshot.self} root=${snapshot.root} rooms=${snapshot.rooms.length} updated_at=${snapshot.updated_at}`;
}

function compactArtifactPath(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record.path ?? "<missing>");
}

function readBoundedReviewEvidence(
  status: Record<string, unknown>,
  limit: number,
): Record<string, unknown> | undefined {
  const evidenceFile = status.evidenceFile;
  if (typeof evidenceFile !== "string" || !existsSync(evidenceFile))
    return undefined;
  try {
    const manifest = asRecord(JSON.parse(readFileSync(evidenceFile, "utf8")));
    const commands = Array.isArray(manifest.commands) ? manifest.commands : [];
    const bounded = commands.slice(-Math.max(1, limit));
    return {
      ...manifest,
      commands: bounded,
      commands_total: commands.length,
      ...(bounded.length < commands.length ? { commands_truncated: true } : {}),
    };
  } catch {
    return {
      status: "invalid",
      error: "review evidence manifest is unreadable",
    };
  }
}

function compactActorFiles(status: Record<string, unknown>): string {
  const run = String(status.run ?? "<unknown>");
  const artifacts = asRecord(status.artifacts);
  const files = [
    status.stdoutLog,
    status.stderrLog,
    status.eventsFile,
    status.outboxFile,
    status.evidenceFile,
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
  const nextActions = ToolsResponse.artifactNextActions(run, artifacts);
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

function isStaleClaim(message: AsyncRuns.RunInboxMessage, now: number): boolean {
  if (message.status !== "claimed") return false;
  const claimedAt = Date.parse(String(message.claimed_at ?? ""));
  return Number.isFinite(claimedAt) && now - claimedAt > 5 * 60 * 1000;
}

function getRunTriageSignals(
  runs: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const now = Date.now();
  const staleClaims: Array<Record<string, unknown>> = [];
  const attentionMessages: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    const stateDir = String(run.state_dir ?? "");
    const runId = String(run.run ?? "");
    if (!stateDir) continue;
    try {
      for (const message of AsyncRuns.readRunInboxMessages(stateDir, 200)) {
        if (!isStaleClaim(message, now)) continue;
        staleClaims.push({
          run: runId,
          id: message.id,
          claimed_at: message.claimed_at,
          claimed_by: message.claimed_by,
          type: message.type,
        });
      }
    } catch {}
    try {
      for (const event of AsyncRuns.readRunEvents(stateDir, 80)) {
        if (event.metadata?.requires_response !== true) continue;
        attentionMessages.push({
          run: runId,
          id: event.id,
          summary: event.summary,
          type: event.type ?? event.event,
        });
      }
    } catch {}
  }
  return { attention_messages: attentionMessages, stale_claims: staleClaims };
}

function isTriageHighRiskRecipe(recipe: Record<string, unknown>): boolean {
  if (recipe.tool !== true) return false;
  const labels = Array.isArray(recipe.risk_labels)
    ? recipe.risk_labels.map((label) => String(label))
    : [];
  return labels.some((label) => label !== "risk.long_running");
}

function getPiActorsTriage(
  ctx: unknown,
  deps: InspectToolDeps,
): Record<string, unknown> {
  const runtime = getPiActorsRuntimeStatus();
  const currentSession = ToolsAccess.getContextSessionId(ctx);
  const listRuns = deps.listRuns ?? AsyncRuns.listRuns;
  const getRunStatus = deps.getRunStatus ?? AsyncRuns.getRunStatus;
  const allRuns = listRuns().flatMap((run) => {
    try {
      return [getRunStatus(String(run.state_dir))];
    } catch {
      return [];
    }
  });
  const visibleRuns = currentSession
    ? allRuns.filter(
        (run) => !run.ownerId || run.ownerId === currentSession,
      )
    : allRuns;
  const activeRuns = visibleRuns.filter((run) => run.status === "running");
  const failedRuns = visibleRuns.filter((run) => run.status === "failed");
  const otherRuns = currentSession
    ? allRuns.filter((run) => run.ownerId && run.ownerId !== currentSession)
    : [];
  const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
  const discovered = RecipesDiscovery.discoverRecipeSources([
    { root: recipeRoot, defaultTool: true, mutableUsage: true },
    { root: deps.packagedRecipeRoot ?? Paths.getPackagedRecipeRoot() },
  ]);
  const recipeSummary: Record<string, unknown> = {
    ...RecipesDiscovery.summarizeDiscovery(discovered),
    drafts: RecipesDiscovery.listDraftRecipes(join(recipeRoot, "drafts")),
  };
  const activeRecipes = Array.isArray(recipeSummary.active)
    ? (recipeSummary.active as Array<Record<string, unknown>>)
    : [];
  const highRiskRecipes = activeRecipes.filter(isTriageHighRiskRecipe);
  const signals = getRunTriageSignals(visibleRuns);
  const attentionMessages = signals.attention_messages as Array<
    Record<string, unknown>
  >;
  const staleClaims = signals.stale_claims as Array<Record<string, unknown>>;
  const invalidRecipes = Array.isArray(recipeSummary.invalid)
    ? (recipeSummary.invalid as Array<Record<string, unknown>>)
    : [];
  const remediations = Array.isArray(recipeSummary.remediations)
    ? (recipeSummary.remediations as Array<Record<string, unknown>>)
    : [];
  const drafts = Array.isArray(recipeSummary.drafts)
    ? (recipeSummary.drafts as Array<Record<string, unknown>>)
    : [];
  const nextActions = [
    invalidRecipes.length || remediations.length
      ? "inspect target=recipes view=doctor"
      : "",
    drafts.length ? "inspect target=recipes view=summary verbose=true" : "",
    failedRuns[0]?.run
      ? `inspect target=run:${String(failedRuns[0].run)} view=tail lines=80`
      : "",
    attentionMessages[0]?.run
      ? `inspect target=run:${String(attentionMessages[0].run)} view=messages`
      : "",
    activeRuns.length
      ? "inspect target=session:all view=runs status=active"
      : "",
  ].filter(Boolean);
  return {
    runtime,
    current_session: currentSession ?? null,
    active_runs: activeRuns.map((run) => ({
      run: run.run,
      ownerId: run.ownerId,
      recipe: run.recipe,
      status: run.status,
    })),
    other_session_runs: otherRuns.length,
    invalid_recipes: invalidRecipes,
    blocking_recipes: remediations.filter((item) =>
      String(item.kind ?? "").startsWith("blocking_"),
    ),
    high_risk_recipes: highRiskRecipes.map((recipe) => ({
      id: recipe.id,
      path: recipe.path,
      risk_labels: recipe.risk_labels,
    })),
    draft_recipes: drafts,
    stale_claims: staleClaims,
    recent_failed_runs: failedRuns.slice(0, 5).map((run) => ({
      run: run.run,
      recipe: run.recipe,
      status: run.status,
    })),
    attention_messages: attentionMessages.slice(-10),
    next_actions: [...new Set(nextActions)].slice(0, 5),
  };
}

function compactPiActorsTriage(summary: Record<string, unknown>): string {
  const runtime = asRecord(summary.runtime);
  const activeRuns = Array.isArray(summary.active_runs)
    ? summary.active_runs.length
    : 0;
  const invalidRecipes = Array.isArray(summary.invalid_recipes)
    ? summary.invalid_recipes.length
    : 0;
  const blockingRecipes = Array.isArray(summary.blocking_recipes)
    ? summary.blocking_recipes.length
    : 0;
  const highRiskRecipes = Array.isArray(summary.high_risk_recipes)
    ? summary.high_risk_recipes.length
    : 0;
  const drafts = Array.isArray(summary.draft_recipes)
    ? summary.draft_recipes.length
    : 0;
  const staleClaims = Array.isArray(summary.stale_claims)
    ? summary.stale_claims.length
    : 0;
  const failedRuns = Array.isArray(summary.recent_failed_runs)
    ? summary.recent_failed_runs.length
    : 0;
  const attention = Array.isArray(summary.attention_messages)
    ? summary.attention_messages.length
    : 0;
  const nextActions = Array.isArray(summary.next_actions)
    ? (summary.next_actions as string[])
    : [];
  return `\ntriage version=${String(runtime.version ?? "unknown")} mode=${String(runtime.mode ?? "unknown")} active_runs=${activeRuns} other_runs=${String(summary.other_session_runs ?? 0)} invalid_recipes=${invalidRecipes} blocking_recipes=${blockingRecipes} high_risk_recipes=${highRiskRecipes} drafts=${drafts} stale_claims=${staleClaims} failed_runs=${failedRuns} attention=${attention}${ToolsResponse.compactNextActions(nextActions)}`;
}

function compactToolActor(name: string, tool: Record<string, unknown>): string {
  const parameters = asRecord(tool.parameters);
  const required = Array.isArray(parameters.required)
    ? parameters.required.join(",")
    : "";
  const properties = asRecord(parameters.properties);
  return `\ntool=${name} description=${String(tool.description ?? "").replaceAll(/\s+/g, "_")} args=${Object.keys(properties).join(",")} required=${required}`;
}

export interface InspectToolDeps<TContext = unknown> {
  getRunStatus?: (runOrDir: string) => Record<string, any>;
  getTool?: (name: string) => any | undefined;
  listRuns?: () => Array<Record<string, any>>;
  packagedRecipeRoot?: string;
  recipeRoot?: string;
}

export function createInspectToolDefinition<TContext = unknown>(
  deps: InspectToolDeps<TContext> = {},
): any {
  return {
    name: "inspect",
    label: "Inspect",
    description:
      "Intentionally inspect actors at decision points, after follow-ups, or during diagnosis instead of polling. Core targets are run:<id> and tool:<name>; advanced targets include branch:<run>/<branch>, room:<run>, coordinator, session:<id>, and session:all.",
    parameters: Schema.objectSchema(
      {
        lines: Schema.stringSchema(
          "Line count for tail/messages views. Default 40.",
        ),
        status: Schema.stringSchema(
          "Optional session run filter: all, running, active, terminal, done, failed, cancelled, killed, or exited.",
        ),
        target: Schema.stringSchema(
          "Actor address to inspect, e.g. run:<id> or tool:<name>; advanced: branch:<run>/<branch>, room:<run>, coordinator, session:<id>, session:all.",
        ),
        verbose: Schema.booleanSchema(
          "Return full JSON instead of compact text where available.",
        ),
        view: Schema.stringSchema(
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
        const discovered = RecipesDiscovery.discoverRecipeSources([
          {
            root: deps.recipeRoot ?? Paths.getRecipeRoot(),
            defaultTool: true,
            mutableUsage: true,
          },
          { root: deps.packagedRecipeRoot ?? Paths.getPackagedRecipeRoot() },
        ]);
        const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
        const summaryBase = {
          ...RecipesDiscovery.summarizeDiscovery(discovered),
          drafts: RecipesDiscovery.listDraftRecipes(join(recipeRoot, "drafts")),
        };
        const summary = {
          ...summaryBase,
          next_actions: ToolsResponse.recipeRegistryNextActions(
            summaryBase,
            view,
          ),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                summary,
                input.verbose === true,
                view === "doctor"
                  ? ToolsResponse.compactRecipeDoctor(summary)
                  : view === "imports"
                    ? ToolsResponse.compactRecipeImports(summary)
                    : ToolsResponse.compactRecipeRegistry(summary),
              ),
            },
          ],
          details: summary,
        };
      }
      const address = Messages.parseActorAddress(target);
      if (address.kind === "coordinator") {
        if (view !== "status" && view !== "runs") {
          throw new Error(
            "inspect coordinator supports view=status or view=runs.",
          );
        }
        const session = ToolsAccess.requireContextSessionId(
          ctx,
          "inspect coordinator",
        );
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
          if (view !== "status" && view !== "triage") {
            throw new Error(
              "inspect tool:pi-actors supports view=status or view=triage.",
            );
          }
          const details =
            view === "triage"
              ? getPiActorsTriage(ctx, deps)
              : getPiActorsRuntimeStatus();
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  details,
                  input.verbose === true,
                  view === "triage"
                    ? compactPiActorsTriage(details)
                    : compactPiActorsRuntimeStatus(details),
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
        const status = ToolsAccess.assertRunAccessibleToContext(
          address.value,
          ctx,
        );
        const stateDir = String(status.state_dir ?? "");
        if (!stateDir)
          throw new Error(`room:${address.value} has no run state directory.`);
        if (view === "status") {
          const status = Rooms.getRoomStatus(stateDir, address.room);
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
          const previews = Rooms.readRoomMessagePreviews(
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
          const messages = Rooms.readRoomMessages(
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
          const contacts = Rooms.readRoomContacts(stateDir, address.room);
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
          const roster = Rooms.readRoomRoster(stateDir, address.room);
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
        const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
        const branchInbox = Rooms.readBranchInboxDiagnostics(
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
                `${ToolsResponse.compactBranchInbox(messages.map((message) => ({ ...message })))}${branchInbox.corrupted > 0 ? `\ncorrupted=${branchInbox.corrupted}` : ""}`,
              ),
            },
          ],
          details: { corrupted: branchInbox.corrupted, messages },
        };
      }
      switch (view) {
        case "status": {
          const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  status,
                  input.verbose === true,
                  ToolsResponse.compactAsyncRunStatus(status),
                ),
              },
            ],
            details: status,
          };
        }
        case "tail": {
          ToolsAccess.assertRunAccessibleToContext(runId, ctx);
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
          ToolsAccess.assertRunAccessibleToContext(runId, ctx);
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
          const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
          const artifactManifest = AsyncRuns.resolveArtifactManifest(
            status.artifacts as
              | Record<string, AsyncRuns.RunArtifactDeclaration>
              | undefined,
          );
          const reviewEvidence = readBoundedReviewEvidence(
            status,
            Number(input.lines || Limits.DEFAULT_INSPECT_LINES),
          );
          const details = artifactManifest
            ? {
                ...status,
                ...(reviewEvidence ? { review_evidence: reviewEvidence } : {}),
                artifact_manifest: artifactManifest,
                next_actions: ToolsResponse.artifactNextActions(
                  status.run ?? runId,
                  asRecord(status.artifacts),
                ),
              }
            : {
                ...status,
                ...(reviewEvidence ? { review_evidence: reviewEvidence } : {}),
              };
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
          const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
          const mailbox = asRecord(status.mailbox);
          const normalizedMailbox =
            ToolsMailbox.normalizeMailboxContracts(mailbox);
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
                  ToolsResponse.compactRunMailbox(
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
          const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
          const snapshot = Rooms.readCommunicationSnapshot(
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
