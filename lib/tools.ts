/**
 * Pi-facing tool definition helpers
 * Zones: pi tools, registry tools, async run launchers
 * Owns generated runtime tool schemas and the register_tool management tool schema
 */

import * as ActorMessages from "./actor-messages.ts";
import * as AsyncRuns from "./async-runs.ts";
import * as CommandTemplates from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import * as Prompts from "./prompts.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as Registry from "./registry.ts";
import * as Schema from "./schema.ts";

export type RegisterToolInput = Registry.RegisterToolInput;
export type RegisterToolRuntimeDeps<TContext> =
  Registry.RegisterToolRuntimeDeps<TContext>;

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

function compactAsyncRunStatus(value: unknown): string {
  const status = asRecord(value);
  const progress = asRecord(status.progress);
  const result = asRecord(status.result);
  const tokens = [
    `run=${String(status.run ?? "<unknown>")}`,
    `status=${String(status.status ?? "unknown")}`,
  ];
  if (status.tool) tokens.push(`tool=${String(status.tool)}`);
  if (status.recipe) tokens.push(`recipe=${String(status.recipe)}`);
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

function compactActorFiles(status: Record<string, unknown>): string {
  const run = String(status.run ?? "<unknown>");
  const artifacts = asRecord(status.artifacts);
  const files = [
    status.stdoutLog,
    status.stderrLog,
    status.eventsFile,
    status.outboxFile,
    status.state_dir ? `${String(status.state_dir)}/result.json` : undefined,
  ].filter((file): file is string => typeof file === "string");
  const artifactText = Object.keys(artifacts).length
    ? ` artifacts=${Object.entries(artifacts)
        .map(([key, value]) => `${key}:${String(value)}`)
        .join(",")}`
    : "";
  return `\nrun=${run}${artifactText}${files.length ? ` files=${files.join(",")}` : ""}`;
}

function compactSessionRuns(
  session: string,
  runs: Array<Record<string, unknown>>,
): string {
  if (runs.length === 0) return `\nsession=${session} runs=0`;
  return `\nsession=${session} runs=${runs.length}\n${runs
    .map(
      (run) =>
        `run=${String(run.run ?? "")} status=${String(run.status ?? "")}${run.recipe ? ` recipe=${String(run.recipe)}` : ""}`,
    )
    .join("\n")}`;
}

function compactToolActor(name: string, tool: Record<string, unknown>): string {
  const parameters = asRecord(tool.parameters);
  const required = Array.isArray(parameters.required)
    ? parameters.required.join(",")
    : "";
  const properties = asRecord(parameters.properties);
  return `\ntool=${name} description=${String(tool.description ?? "").replaceAll(/\s+/g, "_")} args=${Object.keys(properties).join(",")} required=${required}`;
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
  if (result.control) tokens.push(`control=${String(result.control)}`);
  if (result.outbox) tokens.push(`messages=${String(result.outbox)}`);
  if (result.tool) tokens.push(`tool=${String(result.tool)}`);
  if (result.stopped === true) tokens.push("stopped=true");
  if (result.signal) tokens.push(`signal=${String(result.signal)}`);
  if (result.invoked === true) tokens.push("invoked=true");
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

export function createSpawnToolDefinition<
  TContext extends AsyncRunToolContext,
>(): any {
  return {
    name: "spawn",
    label: "Spawn",
    description:
      "Create an addressable actor from a recipe file or inline command template. Currently spawns run:<id> actors backed by async runs.",
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
      const meta = AsyncRuns.startRun(
        {
          file:
            typeof input.file === "string"
              ? input.file
              : typeof input.recipe === "string"
                ? input.recipe
                : undefined,
          ownerId: getRunOwnerId(ctx),
          run_id: runId,
          state_dir:
            typeof input.state_dir === "string" ? input.state_dir : undefined,
          template: input.template as AsyncRuns.AsyncRunStartParams["template"],
          values: asRecord(input.values),
          ...(input.artifacts &&
          typeof input.artifacts === "object" &&
          !Array.isArray(input.artifacts)
            ? { artifacts: input.artifacts as Record<string, string> }
            : {}),
        },
        ctx.cwd,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: maybeJsonText(
              meta,
              input.verbose === true,
              compactAsyncRunStatus(meta),
            ),
          },
        ],
        details: meta,
      };
    },
  };
}

export interface InspectToolDeps<TContext = unknown> {
  getTool?: (name: string) => any | undefined;
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

function assertRunAccessibleToContext(
  runId: string,
  ctx: unknown,
): Record<string, unknown> {
  const status = AsyncRuns.getRunStatus(runId);
  const sessionId = getContextSessionId(ctx);
  if (sessionId && status.ownerId && status.ownerId !== sessionId) {
    throw new Error(
      `run:${runId} is owned by session:${status.ownerId}; current session is ${sessionId}.`,
    );
  }
  return status;
}

export function createInspectToolDefinition<TContext = unknown>(
  deps: InspectToolDeps<TContext> = {},
): any {
  return {
    name: "inspect",
    label: "Inspect",
    description:
      "Intentionally inspect an actor. Supports run:<id> views: status, tail, messages, artifacts, files, mailbox; coordinator/session status; and tool:<name> status/schema.",
    parameters: objectSchema(
      {
        lines: stringSchema("Line count for tail/messages views. Default 40."),
        status: stringSchema(
          "Optional session run filter: all, running, active, terminal, done, failed, cancelled, killed, or exited.",
        ),
        target: stringSchema(
          "Actor address to inspect, e.g. run:<id>, coordinator, session:<id>, session:all, or tool:<name>.",
        ),
        verbose: booleanSchema(
          "Return full JSON instead of compact text where available.",
        ),
        view: stringSchema(
          "Inspection view: status, tail, messages, artifacts, files, or mailbox.",
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
      const address = ActorMessages.parseActorAddress(target);
      const view = String(input.view ?? "");
      if (address.kind === "coordinator") {
        if (view !== "status" && view !== "runs") {
          throw new Error(
            "inspect coordinator supports view=status or view=runs.",
          );
        }
        const session = requireContextSessionId(ctx, "inspect coordinator");
        const runs = AsyncRuns.listRuns(
          undefined,
          typeof input.status === "string" ? input.status : undefined,
        )
          .map((run) => AsyncRuns.getRunStatus(String(run.state_dir)))
          .filter((run) => run.ownerId === session);
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                { session, runs },
                input.verbose === true,
                compactSessionRuns(session, runs),
              ),
            },
          ],
          details: { session, runs },
        };
      }
      if (address.kind === "session") {
        if (view !== "status" && view !== "runs") {
          throw new Error(
            "inspect session:<id> supports view=status or view=runs.",
          );
        }
        const runs = AsyncRuns.listRuns(
          undefined,
          typeof input.status === "string" ? input.status : undefined,
        )
          .map((run) => AsyncRuns.getRunStatus(String(run.state_dir)))
          .filter(
            (run) => address.value === "all" || run.ownerId === address.value,
          );
        return {
          content: [
            {
              type: "text" as const,
              text: maybeJsonText(
                { session: address.value, runs },
                input.verbose === true,
                compactSessionRuns(address.value || "", runs),
              ),
            },
          ],
          details: { session: address.value, runs },
        };
      }
      if (address.kind === "tool" && address.value) {
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
      const runId = address.kind === "run" ? address.value : undefined;
      if (!runId)
        throw new Error(
          "inspect target must be run:<id>, coordinator, session:<id>, or tool:<name>.",
        );
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
          const text = AsyncRuns.tailRun(runId, Number(input.lines || 40));
          return {
            content: [{ type: "text" as const, text: `\n${text}` }],
            details: {},
          };
        }
        case "messages": {
          assertRunAccessibleToContext(runId, ctx);
          const messages = AsyncRuns.readRunEvents(
            runId,
            Number(input.lines || 40),
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
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  status,
                  input.verbose === true,
                  compactActorFiles(status),
                ),
              },
            ],
            details: status,
          };
        }
        case "mailbox": {
          const status = assertRunAccessibleToContext(runId, ctx);
          const mailbox = asRecord(status.mailbox);
          return {
            content: [
              {
                type: "text" as const,
                text: maybeJsonText(
                  mailbox,
                  input.verbose === true,
                  `\nrun=${String(status.run ?? runId)} accepts=${Array.isArray(mailbox.accepts) ? mailbox.accepts.join(",") : ""} emits=${Array.isArray(mailbox.emits) ? mailbox.emits.join(",") : ""}`,
                ),
              },
            ],
            details: { mailbox },
          };
        }
        default:
          throw new Error(
            "inspect view must be one of: status, tail, messages, artifacts, files, mailbox.",
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
      "Send one typed addressed message. Routes to run:<id> mailboxes, branch:<run>/<branch> mailboxes, tool:<name> calls, and coordinator/session-bound run messages.",
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
          "Destination actor address, e.g. run:<id>, branch:<run>/<branch>, coordinator, session:<id>, or tool:<name>.",
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
        assertRunAccessibleToContext(address.value, ctx);
        if (
          message.type === "control.stop" ||
          message.type === "control.cancel"
        ) {
          result = AsyncRuns.cancelRun(address.value);
        } else if (message.type === "control.kill") {
          result = AsyncRuns.killRun(address.value);
        } else {
          result = AsyncRuns.sendRunMessage(
            address.value,
            messageBodyToRunLine(message),
          );
        }
      } else if (address.kind === "branch" && address.value) {
        assertRunAccessibleToContext(address.value, ctx);
        result = AsyncRuns.sendRunMessage(
          address.value,
          JSON.stringify(message),
        );
      } else if (address.kind === "tool" && address.value) {
        const tool = deps.getTool?.(address.value);
        if (!tool || typeof tool.execute !== "function") {
          throw new Error(
            `tool actor not found or not executable: ${address.value}`,
          );
        }
        const toolResult = await tool.execute(
          `message:${message.type}`,
          messageBodyToToolParams(message),
          _signal,
          _onUpdate,
          ctx,
        );
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
            throw new Error(
              `message to session:${address.value} requires sender run owner ${address.value}; got no owner.`,
            );
          }
          if (senderStatus.ownerId !== address.value) {
            throw new Error(
              `message to session:${address.value} requires sender run owner ${address.value}; got ${senderStatus.ownerId}.`,
            );
          }
        }
        result = AsyncRuns.appendRunOutboxEvent(sender.value, {
          body: message.body,
          correlation_id: message.correlation_id,
          delivery: address.kind === "session" ? "followup" : undefined,
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
          `message currently supports run:<id>, branch:<run>/<branch>, tool:<name>, coordinator, and session:<id> destinations; unsupported destination: ${message.to}`,
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: maybeJsonText(
              { message, result },
              input.verbose === true,
              compactActorMessageResult(message, result),
            ),
          },
        ],
        details: { message, result },
      };
    },
  };
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
