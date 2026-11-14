/**
 * Public Control facade under the stable `actors_control_apply` tool name.
 * Zones: Control request validation, Run/runtime dispatch, recipient-scoped receipts
 * Owns public Control execution; journaling, delivery, and lifecycle mutation stay in Run domains.
 */
import * as AsyncRuns from "./async-runs.js";
import * as Control from "./control.js";
import * as Schema from "./schema.js";
import * as ToolsAccess from "./tools-access.js";
import * as Limits from "./limits.js";
import * as ToolsResponse from "./tools-response.js";
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
const CONTROL_BUDGET = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;
function controlMetadata(value) {
    return ToolsResponse.renderYamlMetadata(value, CONTROL_BUDGET).text;
}
/** One opaque selected scalar as a whole value or an explicit whole-field omission, never a clip. */
function controlSelected(key, value) {
    return ToolsResponse.selectYamlField(key, value, CONTROL_BUDGET);
}
/** Compiler-selected option strings stay a native sequence; malformed selections stay unavailable. */
function controlChoices(options) {
    const key = options.key, values = options.values;
    // Values were selected by the original string filter, not a new action grammar.
    const wellFormed = values.every((value) => typeof value === "string" && value.isWellFormed());
    const omitted = { [key]: wellFormed ? "[omitted]" : "[unavailable]",
        [key + "_omission"]: { reason: wellFormed ? "response_too_large" : "malformed_selected_text",
            shown: 0, omitted: values.length, total: values.length } };
    const full = !wellFormed ? omitted : values.length ? { [key]: [...values] } : { [key]: "none" };
    const complete = ToolsResponse.renderYamlMetadata(full, CONTROL_BUDGET);
    return { full, selected: complete.state === "available" && Buffer.byteLength(complete.text) <= Buffer.byteLength(controlMetadata(omitted)) ? full : omitted };
}
/** Grow whole selected fields in priority order while the complete document still fits. */
function controlDocument(render, order) {
    return ToolsResponse.growYamlDocument(render, order, CONTROL_BUDGET);
}
/** Only producer-known read-only inspect literals become typed next; other advice stays opaque content. */
function controlNextPart(action) {
    const inspect = /^actors_inspect target=([^\s]+) view=([^\s]+)$/u.exec(action);
    if (inspect) {
        return ToolsResponse.selectYamlNode("next", { tool: "actors_inspect", target: inspect[1], view: inspect[2] }, CONTROL_BUDGET);
    }
    const wellFormed = action.isWellFormed();
    const omitted = { next: { instruction: wellFormed ? "[omitted]" : "[unavailable]",
            instruction_omission: { reason: wellFormed ? "response_too_large" : "malformed_selected_text", shown: 0, omitted: 1, total: 1 } } };
    const full = wellFormed ? { next: { instruction: action } } : omitted;
    const complete = wellFormed ? ToolsResponse.renderYamlMetadata(full, CONTROL_BUDGET) : undefined;
    const selected = complete?.state === "available" && Buffer.byteLength(complete.text) <= Buffer.byteLength(controlMetadata(omitted))
        ? full : omitted;
    return { full, selected };
}
/** Only the four compiler-owned guard sites below; never wraps dispatch/dependency errors. */
function controlGuardText(request, result, options) {
    const key = request.target === "runtime" ? "target" : "run";
    const identity = controlSelected(key, request.target === "runtime" ? request.target : request.target.slice(4));
    const choices = options ? controlChoices(options) : undefined;
    const render = () => ({ ...identity.selected, action: request.action, result,
        ...(choices ? choices.selected : {}) });
    // Whole identity first, then the complete option sequence: the shorter seed must never manufacture overflow.
    return ToolsResponse.withLeadingLineBreak(controlDocument(render, choices ? [identity, choices] : [identity]));
}
/** Pure first-layer copy; legacy stopped/killed flags are not scope-closure proof. */
export function compactControlResult(request, result) {
    const key = request.target.startsWith("run:") ? "run" : "target";
    const identity = controlSelected(key, key === "run" ? request.target.slice(4) : request.target);
    const facts = {};
    if (result.stopped === false || result.archived === false || result.pruned === false) {
        facts.result = "not applied";
    }
    else if (request.action === "kill" && result.stopped === true) {
        facts.result = "kill attempted";
        facts.termination = "unconfirmed";
    }
    else if (result.archived === true) {
        facts.result = "archived";
    }
    else if (result.pruned === true) {
        facts.result = "pruned";
    }
    else if (result.delivery === "queued" || result.delivery === "delivered") {
        facts.delivery = result.delivery;
        facts.handling = "unconfirmed";
    }
    else {
        facts[typeof result.delivery === "string" ? "delivery" : "result"] =
            typeof result.delivery === "string" ? result.delivery : typeof result.status === "string" ? result.status : "accepted";
    }
    const notApplied = result.stopped === false || result.archived === false || result.pruned === false;
    const reason = typeof result.reason === "string" ? controlSelected("reason", result.reason) : undefined;
    const observed = asRecord(result.status);
    const state = notApplied && result.reason === "not running" && typeof observed.status === "string"
        ? controlSelected("state", observed.status) : undefined;
    const controlId = typeof result.control_id === "string" ? controlSelected("control_id", result.control_id) : undefined;
    const actions = Array.isArray(result.next_actions) ? result.next_actions
        : request.target.startsWith("run:") ? runNextActions(request.target.slice(4), result) : [];
    const next = actions.find((action) => typeof action === "string" && action.length > 0);
    const nextPart = next === undefined ? undefined : controlNextPart(next);
    const parts = [identity, ...(reason ? [reason] : []), ...(state ? [state] : []), ...(controlId ? [controlId] : []), ...(nextPart ? [nextPart] : [])];
    const render = () => ({ ...identity.selected, action: request.action, ...facts,
        ...(reason ? reason.selected : {}), ...(state ? state.selected : {}), ...(controlId ? controlId.selected : {}),
        ...(nextPart ? nextPart.selected : {}) });
    return ToolsResponse.withLeadingLineBreak(controlDocument(render, parts));
}
function runNextActions(run, result) {
    if (result.stopped === true)
        return [`actors_inspect target=run:${run} view=trace`];
    if (result.stopped === false || result.archived === false || result.pruned === false) {
        if (result.reason === "ownership changed" || result.reason === "run generation changed") {
            return ["actors_inspect target=runtime view=runs"];
        }
        if (result.stopped === false && result.reason !== "not running")
            return [`actors_inspect target=run:${run} view=trace`];
    }
    if (result.delivery === "queued" || result.delivery === "delivered") {
        return [`actors_inspect target=run:${run} view=control`];
    }
    return [];
}
export function createControlToolDefinition(deps = {}) {
    return {
        name: "actors_control_apply",
        label: "Control",
        description: "Apply one Run/runtime Control action. This is not chat or peer messaging.",
        parameters: Schema.objectSchema({
            target: Schema.stringSchema("Run target run:<id>, or literal runtime."),
            action: Schema.stringSchema("Lowercase ASCII Control action, at most 64 characters."),
            input: Schema.unionSchema([
                Schema.stringSchema("Optional Control input string; serialized JSON must fit 380 bytes."),
                Schema.looseObjectSchema("Optional structured Control input; serialized JSON must fit 380 bytes."),
                Schema.arraySchema("Optional structured Control input array; serialized JSON must fit 380 bytes."),
            ]),
            verbose: Schema.booleanSchema("Return full JSON instead of compact text."),
        }, ["target", "action"]),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const request = Control.normalizeControlRequest(params);
            let result;
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
            }
            else {
                const run = request.target.slice(4);
                const status = deps.getRunStatus
                    ? ToolsAccess.assertRunStatusAccessibleToContext(run, deps.getRunStatus(run), ctx)
                    : ToolsAccess.assertRunAccessibleToContext(run, ctx);
                const runInstanceId = typeof status.run_instance_id === "string"
                    ? status.run_instance_id
                    : undefined;
                if (!runInstanceId)
                    throw new Error(controlGuardText(request, "Run generation unavailable"));
                if (request.action === "kill") {
                    result = AsyncRuns.killRun(run, {
                        ...(typeof status.ownerId === "string"
                            ? { ownerId: status.ownerId }
                            : {}),
                        runInstanceId,
                    });
                }
                else if (request.action === "archive") {
                    result = AsyncRuns.archiveRun(run, {
                        ...(typeof status.ownerId === "string"
                            ? { ownerId: status.ownerId }
                            : {}),
                        runInstanceId,
                    });
                }
                else if (request.action === "prune") {
                    const input = asRecord(request.input);
                    result = AsyncRuns.pruneRun(run, {
                        preserveArtifacts: input.preserve_artifacts === true ||
                            input.preserveArtifacts === true,
                    }, {
                        ...(typeof status.ownerId === "string"
                            ? { ownerId: status.ownerId }
                            : {}),
                        runInstanceId,
                    });
                }
                else {
                    const declared = Array.isArray(status.control)
                        ? status.control.filter((action) => typeof action === "string")
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
                        result = await AsyncRuns.sendRunControl(run, {
                            action: request.action,
                            ...(request.input !== undefined ? { input: request.input } : {}),
                            run_instance_id: runInstanceId,
                        }, {
                            ...(typeof status.ownerId === "string"
                                ? { ownerId: status.ownerId }
                                : {}),
                        });
                    }
                    catch (cause) {
                        // Admission-era correlation is not current reply-scope proof after an awaited dispatch.
                        // Display one whole caller-owned id or an explicit whole-id omission; the warning stays literal.
                        const identity = controlSelected("run", run);
                        const next = controlNextPart("actors_inspect target=runtime view=runs");
                        const render = () => ({ ...identity.selected, action: request.action,
                            result: "request failed", delivery: "unconfirmed", handling: "unconfirmed",
                            warning: "Effects may already exist.\nDo not repeat automatically.", ...next.selected });
                        throw new Error(ToolsResponse.withLeadingLineBreak(controlDocument(render, [identity])), { cause });
                    }
                }
                // A refused identity change must not publish the replacement's status, even in verbose/details.
                if (result.reason === "ownership changed" || result.reason === "run generation changed") {
                    result = { ...result };
                    delete result.status;
                }
                const nextActions = runNextActions(run, result);
                if (nextActions.length > 0)
                    result = { ...result, next_actions: nextActions };
            }
            const response = { control: request, result };
            return {
                content: [
                    {
                        type: "text",
                        text: request.verbose === true
                            ? ToolsResponse.jsonText(response)
                            : compactControlResult(request, result),
                    },
                ],
                details: response,
            };
        },
    };
}
