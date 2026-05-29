/**
 * Public message tool behavior
 * Zones: addressed actor messages, run controls, branch/room delivery, tool actor invocation
 * Owns the public message execution path and compact delivery responses
 */

import * as AsyncRuns from "./async-runs.ts";
import * as Messages from "./messages.ts";
import * as Rooms from "./rooms.ts";
import * as Schema from "./schema.ts";
import * as ToolsAccess from "./tools-access.ts";
import * as ToolsMailbox from "./tools-mailbox.ts";
import * as ToolsResponse from "./tools-response.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maybeJsonText(
  value: unknown,
  verbose: boolean | undefined,
  compact: string,
): string {
  return verbose ? ToolsResponse.jsonText(value) : compact;
}

function messageBodyToRunLine(message: Messages.ActorMessage): string {
  if (message.type !== "run.message") return JSON.stringify(message);
  if (typeof message.body === "string") return message.body;
  if (message.body === undefined) return message.type;
  return JSON.stringify(message.body);
}

function messageBodyToToolParams(
  message: Messages.ActorMessage,
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
  message: Messages.ActorMessage,
  params: Record<string, unknown>,
  error: unknown,
): Error {
  const original = error instanceof Error ? error.message : String(error);
  const paramsPreview = ToolsResponse.compactPreview(params, 240) ?? "{}";
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

function assertMessageSenderBelongsToRun(
  message: Messages.ActorMessage,
  run: string,
  routeLabel: string,
): void {
  if (!message.from) {
    throw new Error(`message to ${message.to} requires from=<actor address>.`);
  }
  const sender = Messages.parseActorAddress(message.from);
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
  message: Messages.ActorMessage,
  _options: { source: "direct" | "room-multicast" },
): Promise<Record<string, unknown>> {
  const branchMessage = { ...message, to: recipient };
  Rooms.appendBranchInboxMessage(stateDir, runId, recipient, branchMessage);
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
  message: Messages.ActorMessage,
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
    const parsed = Messages.parseActorAddress(recipient);
    if (parsed.kind !== "branch" || parsed.value !== run) {
      throw new Error(
        `room multicast recipient must be branch:${run}/<branch>; got ${recipient}.`,
      );
    }
    return Messages.formatActorAddress(parsed);
  });
}

function actorMessageNextActions(
  message: Messages.ActorMessage,
  result: Record<string, unknown>,
): string[] {
  const actions: string[] = [];
  const address = Messages.parseActorAddress(message.to);
  if (result.delivery_error || result.sent === false) {
    if (address.kind === "run" && address.value) {
      actions.push(`inspect target=run:${address.value} view=status`);
      actions.push(`inspect target=run:${address.value} view=mailbox`);
    } else if (address.kind === "branch" && address.value) {
      actions.push(
        `inspect target=branch:${address.value}/${address.branch ?? "main"} view=mailbox`,
      );
      actions.push(`inspect target=run:${address.value} view=status`);
    }
  }
  if (result.queued === true) {
    if (address.kind === "branch" && address.value) {
      actions.push(
        `inspect target=branch:${address.value}/${address.branch ?? "main"} view=mailbox`,
      );
    } else if (address.kind === "run" && address.value) {
      actions.push(`inspect target=run:${address.value} view=mailbox`);
    }
  }
  return [...new Set(actions)].slice(0, 3);
}

function compactActorMessageResult(
  message: Messages.ActorMessage,
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
    tokens.push(
      `delivery_error=${ToolsResponse.compactPreview(result.delivery_error, 96)}`,
    );
  }
  const nextActions = Array.isArray(result.next_actions)
    ? (result.next_actions as string[])
    : actorMessageNextActions(message, result);
  if (nextActions.length > 0)
    tokens.push(
      `next=${nextActions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`,
    );
  return `\n${tokens.join(" ")}`;
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
    parameters: Schema.objectSchema(
      {
        body: Schema.unionSchema([
          Schema.stringSchema(
            "Message body. For run:<id>, this is the run-local command line.",
          ),
          Schema.looseObjectSchema("Structured JSON message body."),
          Schema.arraySchema("Structured JSON message body array."),
        ]),
        correlation_id: Schema.stringSchema(
          "Optional correlation id for workflow/task linkage.",
        ),
        from: Schema.stringSchema(
          "Optional sender address, such as coordinator or run:<id>.",
        ),
        metadata: Schema.looseObjectSchema(
          "Optional structured metadata for routing or domain hints.",
        ),
        reply_to: Schema.stringSchema(
          "Optional message id this message replies to.",
        ),
        summary: Schema.stringSchema("Optional short human-facing summary."),
        to: Schema.stringSchema(
          "Destination actor address, e.g. run:<id> or tool:<name>; advanced: branch:<run>/<branch>, room:<run>, coordinator, session:<id>.",
        ),
        type: Schema.stringSchema(
          "Semantic message type, e.g. control.approve or checkpoint.needs_scope.",
        ),
        verbose: Schema.booleanSchema(
          "Return full JSON instead of compact text.",
        ),
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
      const message = Messages.normalizeActorMessage(input);
      const address = Messages.parseActorAddress(message.to);
      let result: Record<string, unknown>;
      if (address.kind === "run" && address.value) {
        const status = ToolsAccess.assertRunAccessibleToContext(
          address.value,
          ctx,
        );
        const normalizedMailbox = ToolsMailbox.normalizeMailboxContracts(
          asRecord(status.mailbox),
        );
        const acceptedTypes = new Set(
          ToolsMailbox.mailboxTypes(normalizedMailbox.accepts),
        );
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
        const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
        const stateDir = String(status.state_dir ?? "");
        if (stateDir && address.branch) {
          const ensureBranchMember = (actorAddress: string) => {
            Rooms.ensureRoomMember(
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
            Rooms.writeBranchCommunicationSnapshot(
              stateDir,
              runId,
              actorAddress,
            );
          };
          ensureBranchMember(message.to);
          if (message.from) {
            const sender = Messages.parseActorAddress(message.from);
            if (sender.kind === "branch" && sender.value === runId) {
              ensureBranchMember(message.from);
            }
          }
          Rooms.writeCommunicationSnapshot(stateDir, runId);
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
        const status = ToolsAccess.assertRunAccessibleToContext(runId, ctx);
        const stateDir = String(status.state_dir ?? "");
        if (!stateDir)
          throw new Error(`${message.to} has no run state directory.`);
        const recipients = getRoomMulticastRecipients(message, runId);
        const roomResult = Rooms.appendRoomMessage(
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
        const sender = Messages.parseActorAddress(message.from);
        if (sender.kind !== "run" || !sender.value) {
          throw new Error(
            `message to ${address.kind} currently requires from=run:<id>.`,
          );
        }
        const senderStatus = ToolsAccess.assertRunAccessibleToContext(
          sender.value,
          ctx,
        );
        if (address.kind === "session") {
          if (!senderStatus.ownerId) {
            throw ToolsAccess.sessionMismatchError({
              currentSession: undefined,
              expectedSession: address.value,
              run: sender.value,
              target: `session:${address.value}`,
            });
          }
          if (senderStatus.ownerId !== address.value) {
            throw ToolsAccess.sessionMismatchError({
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
