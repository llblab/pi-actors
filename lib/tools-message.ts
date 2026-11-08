/**
 * Public Control facade under the stable `message` tool name.
 * Zones: Control request validation, Run/runtime dispatch, recipient-scoped receipts
 * Owns public Control execution; journaling, delivery, and lifecycle mutation stay in Run domains.
 */

import * as AsyncRuns from "./async-runs.ts";
import * as Control from "./control.ts";
import * as Schema from "./schema.ts";
import * as ToolsAccess from "./tools-access.ts";
import * as Limits from "./limits.ts";
import * as ToolsResponse from "./tools-response.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const controlField = ToolsResponse.formatMarkdownField;

/** Only the four compiler-owned guard sites below; never wraps dispatch/dependency errors. */
function controlGuardText(
  request: Control.ControlRequest,
  result: "unsupported runtime Control action" | "runtime Control is unavailable" | "Run generation unavailable" | "undeclared Run Control action",
  options?: { key: "supported_actions" | "available_actions"; values: readonly string[] },
): string {
  const key = request.target === "runtime" ? "target" : "run";
  const identity = controlField(key, request.target === "runtime" ? request.target : request.target.slice(4));
  const omittedIdentity = `- ${key}: [omitted]\n- ${key}_omission:\n  - reason: response_too_large\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
  const fixed = [controlField("action", request.action), controlField("result", result)];
  let fullOptions = "", omittedOptions = "";
  if (options) {
    const rows: string[] = [];
    let malformed = false;
    // Values were selected by the original string filter, not by a new action grammar.
    for (let index = 0; index < options.values.length; index++) {
      const value = options.values[index];
      if (!value.isWellFormed()) { malformed = true; break; }
      rows.push("  - " + value.replaceAll(/\r\n|\r|\n/gu, newline => newline + "    "));
    }
    omittedOptions = `- ${options.key}: [${malformed ? "unavailable" : "omitted"}]\n- ${options.key}_omission:\n  - reason: ${malformed ? "malformed_selected_text" : "response_too_large"}\n  - shown: 0\n  - omitted: ${options.values.length}\n  - total: ${options.values.length}`;
    fullOptions = malformed ? omittedOptions : rows.length ? `- ${options.key}:\n${rows.join("\n")}` : controlField(options.key, "none");
  }
  // Start with the shorter complete-or-omitted rendering: adding an omission scaffold must
  // never manufacture overflow when the complete small field would fit. Then grow only.
  let selectedIdentity = Buffer.byteLength(identity) <= Buffer.byteLength(omittedIdentity) ? identity : omittedIdentity;
  let selectedOptions = Buffer.byteLength(fullOptions) <= Buffer.byteLength(omittedOptions) ? fullOptions : omittedOptions;
  const render = (target: string, choices: string) => ToolsResponse.withLeadingLineBreak(
    [target, ...fixed, ...(options ? [choices] : [])].join("\n"));
  if (Buffer.byteLength(render(identity, selectedOptions)) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES) selectedIdentity = identity;
  if (options && Buffer.byteLength(render(selectedIdentity, fullOptions)) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES) selectedOptions = fullOptions;
  return render(selectedIdentity, selectedOptions);
}

function controlNext(action: string): string {
  const inspect = /^inspect target=([^\s]+) view=([^\s]+)$/u.exec(action);
  return inspect ? ToolsResponse.formatInspectNextAction(inspect[1], inspect[2])
    : "- next:\n" + controlField("instruction", action, 1);
}

/** Pure first-layer copy; legacy stopped/killed flags are not scope-closure proof. */
export function compactControlResult(
  request: Control.ControlRequest,
  result: Record<string, unknown>,
): string {
  const fields = [request.target.startsWith("run:") ? controlField("run", request.target.slice(4)) : controlField("target", request.target),
    controlField("action", request.action)];
  if (result.stopped === false || result.archived === false || result.pruned === false) {
    fields.push(controlField("result", "not applied"));
    if (typeof result.reason === "string") fields.push(controlField("reason", result.reason));
    const observed = asRecord(result.status);
    if (result.reason === "not running" && typeof observed.status === "string") fields.push(controlField("state", observed.status));
  } else if (request.action === "kill" && result.stopped === true) {
    fields.push(controlField("result", "kill attempted"), controlField("termination", "unconfirmed"));
  } else if (result.archived === true) {
    fields.push(controlField("result", "archived"));
  } else if (result.pruned === true) {
    fields.push(controlField("result", "pruned"));
  } else if (result.delivery === "queued" || result.delivery === "delivered") {
    fields.push(controlField("delivery", result.delivery), controlField("handling", "unconfirmed"));
  } else {
    fields.push(controlField(typeof result.delivery === "string" ? "delivery" : "result",
      typeof result.delivery === "string" ? result.delivery : typeof result.status === "string" ? result.status : "accepted"));
    if (typeof result.reason === "string") fields.push(controlField("reason", result.reason));
  }
  if (typeof result.control_id === "string") fields.push(controlField("control_id", result.control_id));
  const actions = Array.isArray(result.next_actions) ? result.next_actions
    : request.target.startsWith("run:") ? runNextActions(request.target.slice(4), result) : [];
  const next = actions.find((action): action is string => typeof action === "string" && action.length > 0);
  if (next) fields.push(controlNext(next));
  return ToolsResponse.withLeadingLineBreak(fields.join("\n"));
}

function runNextActions(run: string, result: Record<string, unknown>): string[] {
  if (result.stopped === true) return [`inspect target=run:${run} view=trace`];
  if (result.stopped === false || result.archived === false || result.pruned === false) {
    if (result.reason === "ownership changed" || result.reason === "run generation changed") {
      return ["inspect target=runtime view=runs"];
    }
    if (result.stopped === false && result.reason !== "not running") return [`inspect target=run:${run} view=trace`];
  }
  if (result.delivery === "queued" || result.delivery === "delivered") {
    return [`inspect target=run:${run} view=control`];
  }
  return [];
}

export interface ControlToolDeps {
  getRunStatus?: (run: string) => Record<string, unknown>;
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
          throw new Error(controlGuardText(request, "unsupported runtime Control action", {
            key: "supported_actions", values: ["review.retry", "review.reset"],
          }));
        }
        if (!deps.handleRuntimeControl) {
          throw new Error(controlGuardText(request, "runtime Control is unavailable"));
        }
        result = deps.handleRuntimeControl(request.action, request.input);
      } else {
        const run = request.target.slice(4);
        const status = deps.getRunStatus
          ? ToolsAccess.assertRunStatusAccessibleToContext(
              run,
              deps.getRunStatus(run),
              ctx,
            )
          : ToolsAccess.assertRunAccessibleToContext(run, ctx);
        const runInstanceId =
          typeof status.run_instance_id === "string"
            ? status.run_instance_id
            : undefined;
        if (!runInstanceId) throw new Error(controlGuardText(request, "Run generation unavailable"));
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
            // The old join/template evaluation may itself throw or have observable hooks.
            // Preserve it before the new presentation; it is not an action-list parser.
            void `${declared.join(",") || "none"}`;
            throw new Error(controlGuardText(request, "undeclared Run Control action", {
              key: "available_actions", values: declared,
            }));
          }
          try {
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
          } catch (cause) {
            // Admission-era correlation is not current reply-scope proof after an awaited dispatch.
            const summary = [controlField("action", request.action), controlField("result", "request failed"),
              controlField("delivery", "unconfirmed"), controlField("handling", "unconfirmed"),
              controlField("warning", "Effects may already exist.\nDo not repeat automatically."),
              controlNext("inspect target=runtime view=runs")].join("\n");
            // Reserve both line breaks; display one whole caller-owned id or explicit whole-id omission.
            const identity = controlField("run", run);
            const target = Buffer.byteLength(identity) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - Buffer.byteLength(summary) - 2
              ? identity
              : "- run: [omitted]\n- run_omission:\n  - reason: response_too_large\n  - shown: 0\n  - omitted: 1\n  - total: 1";
            throw new Error(ToolsResponse.withLeadingLineBreak(target + "\n" + summary), { cause });
          }
        }
        // A refused identity change must not publish the replacement's status, even in verbose/details.
        if (result.reason === "ownership changed" || result.reason === "run generation changed") {
          result = { ...result };
          delete result.status;
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
