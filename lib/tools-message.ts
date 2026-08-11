/**
 * Public Control facade under the stable `message` tool name.
 * Zones: Control request validation, Run/runtime dispatch, compact receipts
 * Owns public Control execution; journaling, delivery, and lifecycle mutation stay in Run domains.
 */

import * as AsyncRuns from "./async-runs.ts";
import * as Control from "./control.ts";
import * as Schema from "./schema.ts";
import * as ToolsAccess from "./tools-access.ts";
import * as ToolsResponse from "./tools-response.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactControlResult(
  request: Control.ControlRequest,
  result: Record<string, unknown>,
): string {
  const tokens = [
    `target=${request.target}`,
    `action=${request.action}`,
    `status=${String(result.delivery ?? result.status ?? (result.stopped === true ? "handled" : "accepted"))}`,
  ];
  if (result.control_id) tokens.push(`control=${String(result.control_id)}`);
  if (result.reason) tokens.push(`reason=${String(result.reason).replaceAll(/\s+/g, "_")}`);
  if (Array.isArray(result.next_actions) && result.next_actions.length > 0) {
    tokens.push(
      `next=${(result.next_actions as string[])
        .map((action) => action.replaceAll(/\s+/g, "_"))
        .join("|")}`,
    );
  }
  return `\n${tokens.join(" ")}`;
}

function runNextActions(run: string, result: Record<string, unknown>): string[] {
  if (result.delivery === "queued" || result.delivery === "delivered") {
    return [`inspect target=run:${run} view=control`];
  }
  if (result.stopped === true) return [`inspect target=run:${run} view=control`];
  return [];
}

export interface ControlToolDeps {
  handleRuntimeControl?: (
    action: string,
    input: unknown,
  ) => Record<string, unknown>;
}

export function createControlToolDefinition<TContext = unknown>(
  deps: ControlToolDeps = {},
): any {
  return {
    name: "message",
    label: "Control",
    description:
      "Apply one Control action to an existing Run or the pi-actors runtime.",
    parameters: Schema.objectSchema(
      {
        target: Schema.stringSchema("Run target run:<id>, or literal runtime."),
        action: Schema.stringSchema("Lowercase ASCII Control action, at most 64 characters."),
        input: Schema.unionSchema([
          Schema.stringSchema("Optional Control input string; serialized JSON must fit 380 bytes."),
          Schema.looseObjectSchema("Optional structured Control input; serialized JSON must fit 380 bytes."),
          Schema.arraySchema("Optional structured Control input array; serialized JSON must fit 380 bytes."),
        ]),
        verbose: Schema.booleanSchema("Return full JSON instead of compact text."),
      },
      ["target", "action"],
    ),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: TContext,
    ) {
      const request = Control.normalizeControlRequest(params);
      let result: Record<string, unknown>;
      if (request.target === "runtime") {
        if (request.action !== "review.retry" && request.action !== "review.reset") {
          throw new Error(
            `unsupported runtime Control action: ${request.action}; use review.retry or review.reset`,
          );
        }
        if (!deps.handleRuntimeControl) {
          throw new Error("runtime Control is unavailable");
        }
        result = deps.handleRuntimeControl(request.action, request.input);
      } else {
        const run = request.target.slice(4);
        const status = ToolsAccess.assertRunAccessibleToContext(run, ctx);
        const runInstanceId =
          typeof status.run_instance_id === "string"
            ? status.run_instance_id
            : undefined;
        if (!runInstanceId) throw new Error(`Run generation unavailable: ${run}`);
        if (request.action === "kill") {
          result = AsyncRuns.killRun(run, {
            ...(typeof status.ownerId === "string"
              ? { ownerId: status.ownerId }
              : {}),
            runInstanceId,
          });
        } else if (request.action === "archive") {
          result = AsyncRuns.archiveRun(run, {
            ...(typeof status.ownerId === "string"
              ? { ownerId: status.ownerId }
              : {}),
            runInstanceId,
          });
        } else if (request.action === "prune") {
          const input = asRecord(request.input);
          result = AsyncRuns.pruneRun(
            run,
            {
              preserveArtifacts:
                input.preserve_artifacts === true ||
                input.preserveArtifacts === true,
            },
            {
              ...(typeof status.ownerId === "string"
                ? { ownerId: status.ownerId }
                : {}),
              runInstanceId,
            },
          );
        } else {
          const declared = Array.isArray(status.control)
            ? status.control.filter(
                (action): action is string => typeof action === "string",
              )
            : [];
          if (!declared.includes(request.action)) {
            throw new Error(
              `undeclared Run Control action: ${request.action}; available=${declared.join(",") || "none"}`,
            );
          }
          result = await AsyncRuns.sendRunControl(
            run,
            {
              action: request.action,
              ...(request.input !== undefined ? { input: request.input } : {}),
              run_instance_id: runInstanceId,
            },
            {
              ...(typeof status.ownerId === "string"
                ? { ownerId: status.ownerId }
                : {}),
            },
          );
        }
        const nextActions = runNextActions(run, result);
        if (nextActions.length > 0) result = { ...result, next_actions: nextActions };
      }
      const response = { control: request, result };
      return {
        content: [
          {
            type: "text" as const,
            text:
              request.verbose === true
                ? ToolsResponse.jsonText(response)
                : compactControlResult(request, result),
          },
        ],
        details: response,
      };
    },
  };
}
