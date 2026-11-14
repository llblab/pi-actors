import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { readProcessIdentity } from "../lib/runs-process.ts";
import { readRunControlsFromStateDir, updateRunControlStatusInStateDir } from "../lib/runs-controls.ts";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../lib/file-state.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import { claimRunStateDirectory } from "../lib/runs-ownership.ts";
import test from "node:test";
import { parseDocument } from "yaml";

import * as Limits from "../lib/limits.ts";
import type { ControlRequest } from "../lib/control.ts";
import { compactControlResult, createControlToolDefinition } from "../lib/tools-message.ts";
import { renderYamlMetadata } from "../lib/tools-response.ts";

/** Bare block-YAML Control receipt text including the public adapter's one leading LF. */
function controlDocumentText(value: Record<string, unknown>): string | undefined {
  const rendered = renderYamlMetadata(value, Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1);
  return rendered.state === "available" ? "\n" + rendered.text : undefined;
}
function controlDocument(value: Record<string, unknown>): string {
  const text = controlDocumentText(value);
  assert.ok(text, "Expected a renderable Control document");
  return text;
}
/** Largest single-byte payload whose complete document still fits the shared bound. */
function exactFit(document: (payload: string) => Record<string, unknown>): number {
  let low = 0, high = 16384;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const text = controlDocumentText(document("r".repeat(middle)));
    if (text !== undefined && Buffer.byteLength(text) <= 16384) low = middle;
    else high = middle - 1;
  }
  return low;
}
const omitted = (key: string, reason = "response_too_large", total = 1) => ({
  [key]: reason === "response_too_large" ? "[omitted]" : "[unavailable]",
  [key + "_omission"]: { reason, shown: 0, omitted: total, total } });

test("Compact Control receipts omit an unfit typed next as a whole action", () => {
  for (const size of [17000, 16300]) {
    const text = compactControlResult({ target: "run:demo", action: "pause" },
      { delivery: "queued", next_actions: ["actors_inspect target=run:" + "x".repeat(size) + " view=control"] });
    const doc = parseDocument(text);
    assert.deepEqual(doc.errors, []); assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    const value = doc.toJS();
    assert.equal(value.run, "demo"); assert.equal(value.delivery, "queued"); assert.equal(value.handling, "unconfirmed");
    assert.equal(value.next, "[omitted]");
    assert.deepEqual(value.next_omission, { reason: "response_too_large", shown: 0, omitted: 1, total: 1 });
  }
});

test("AX owned Control guards preserve exact pre-dispatch observations and expose only caller facts and selected options", async () => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
  const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
  const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
  for (const verbose of [false, true]) for (const mode of ["runtime_action", "runtime_port", "generation", "declared"]) {
    const events: string[] = [];
    const ctx = { sessionManager: { getSessionId() { events.push("session"); return "session-A"; } } };
    const declarations = ["pause", 7, "## Literal\r\nnext: do not execute\r\n\r\n  - body · stays", { toString() { throw Error("No object coercion"); } }];
    const status = {
      get ownerId() { events.push("owner"); return "session-A"; },
      get run_instance_id() { events.push("generation"); return mode === "generation" ? undefined : "PRIVATE_GENERATION"; },
      get control() { events.push("control"); assert.equal(mode, "declared"); return declarations; },
      private_payload: "PRIVATE_STATUS",
    };
    const deps = {
      getRunStatus(run: string) { events.push("status:" + run); return status; },
      get handleRuntimeControl(): undefined { events.push("runtime_port"); return undefined; },
    };
    const runtime = mode.startsWith("runtime");
    const action = mode === "runtime_action" ? "review.nope" : runtime ? "review.retry" : "resume";
    const request = { target: runtime ? "runtime" : "run:caller-owned", action, input: { token: "PRIVATE_INPUT" }, verbose };
    const expected = mode === "runtime_action"
      ? controlDocument({ target: "runtime", action: "review.nope", result: "unsupported runtime Control action",
          supported_actions: ["review.retry", "review.reset"] })
      : mode === "runtime_port" ? controlDocument({ target: "runtime", action: "review.retry", result: "runtime Control is unavailable" })
      : mode === "generation" ? controlDocument({ run: "caller-owned", action: "resume", result: "Run generation unavailable" })
      : controlDocument({ run: "caller-owned", action: "resume", result: "undeclared Run Control action",
          available_actions: ["pause", "## Literal\r\nnext: do not execute\r\n\r\n  - body · stays"] });
    await assert.rejects(createControlToolDefinition(deps).execute("owned-guard", request, undefined, undefined, ctx), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(Object.getPrototypeOf(error), Error.prototype);
      assert.equal(error.message, expected); assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(error.message, /PRIVATE_|session-A|PRIVATE_GENERATION|- next:|not applied|not sent|delivery:|handling:|no effects/u);
      assert.ok(Buffer.byteLength(error.message) <= 16384); return true;
    });
    const expectedEvents = runtime ? mode === "runtime_action" ? [] : ["runtime_port"]
      : ["status:caller-owned", "session", "owner", "owner", "owner", "generation", ...(mode === "declared" ? ["generation", "control", "control"] : [])];
    assert.deepEqual(events, expectedEvents);
    events.length = 0;
    const tool = createControlToolDefinition(deps);
    const hostTool = { ...tool, execute: (...values: [string, unknown, AbortSignal | undefined, unknown]) => tool.execute(...values, ctx) };
    const call = { type: "toolCall", id: "host-guard", name: "actors_control_apply", arguments: request };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(outcome.isError, true);
    assert.deepEqual(outcome.result.content, [{ type: "text", text: expected }]);
    assert.deepEqual(outcome.result.details, {});
    assert.deepEqual(events, expectedEvents);
    assert.equal(declarations[2], "## Literal\r\nnext: do not execute\r\n\r\n  - body · stays");
  }
  const token = Object.freeze({ private: "exact failure; never coerce", toString() { throw Error("Do not format"); } });
  const ctx = { sessionManager: { getSessionId: () => "session-A" } };
  const cases = [
    { params: { get target(): string { throw token; }, action: "pause" }, deps: {} },
    { params: { target: "run:demo", action: "pause" }, deps: { getRunStatus(): never { throw token; } } },
    { params: { target: "runtime", action: "review.retry" }, deps: { get handleRuntimeControl(): never { throw token; } } },
    { params: { target: "run:demo", action: "pause" }, deps: { getRunStatus: () => ({ ownerId: "session-A", get run_instance_id(): never { throw token; } }) } },
    { params: { target: "run:demo", action: "pause" }, deps: { getRunStatus: () => ({ ownerId: "session-A", run_instance_id: "G", get control(): never { throw token; } }) } },
  ];
  for (const value of cases) {
    let rejected = false;
    try { await createControlToolDefinition(value.deps).execute("unowned", value.params, undefined, undefined, ctx); }
    catch (cause) { rejected = true; assert.equal(cause, token); }
    assert.equal(rejected, true);
  }
  let effects = 0;
  for (const cause of [token, undefined, "PRIVATE_PRIMITIVE"]) {
    let rejected = false;
    try { await createControlToolDefinition({ handleRuntimeControl() { effects++; throw cause; } }).execute("runtime-effect", { target: "runtime", action: "review.retry" }, undefined, undefined, ctx); }
    catch (error) { rejected = true; assert.equal(error, cause); }
    assert.equal(rejected, true);
  }
  assert.equal(effects, 3, "Runtime callback exceptions after effects stay original, without retry or wrapper");
  class JoinFault extends Array<string> { override join(): never { throw token; } }
  class JoinCoercionFault extends Array<string> { override join(): string { return { toString() { throw token; } } as unknown as string; } }
  for (const declarations of [new JoinFault("stop"), new JoinCoercionFault("stop")]) {
    let rejected = false;
    try { await createControlToolDefinition({ getRunStatus: () => ({ ownerId: "session-A", run_instance_id: "G", control: declarations }) }).execute("join-fault", { target: "run:demo", action: "pause" }, undefined, undefined, ctx); }
    catch (error) { rejected = true; assert.equal(error, token); }
    assert.equal(rejected, true);
  }
});

test("AX owned Control guard bounds admit whole targets and option sequences or truthful whole omissions", async () => {
  const ctx = { sessionManager: { getSessionId: () => "session-A" } };
  const capture = async (run: string, control?: unknown, generation?: string, verbose = false): Promise<string> => {
    try { await createControlToolDefinition({ getRunStatus: () => ({ ownerId: "session-A", run_instance_id: generation, control }) }).execute("guard-bound", { target: `run:${run}`, action: "pause", verbose }, undefined, undefined, ctx); }
    catch (error) { assert.ok(error instanceof Error); assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false); assert.ok(error.message.isWellFormed()); assert.ok(Buffer.byteLength(error.message) <= 16384); return error.message; }
    throw Error("Expected guard refusal, not dispatch");
  };
  const guardDocument = (run: string) => ({ run, action: "pause", result: "Run generation unavailable" });
  const exact = "r".repeat(exactFit(guardDocument));
  for (const verbose of [false, true]) {
    assert.equal(await capture(exact, undefined, undefined, verbose), controlDocument(guardDocument(exact)));
    assert.equal(Buffer.byteLength(await capture(exact, undefined, undefined, verbose)), 16384);
    assert.equal(await capture(exact + "r", undefined, undefined, verbose),
      controlDocument({ ...omitted("run"), action: "pause", result: "Run generation unavailable" }));
  }
  const declaredDocument = (values: readonly string[]) => ({ run: "demo", action: "pause", result: "undeclared Run Control action",
    ...(values.length ? { available_actions: [...values] } : { available_actions: "none" }) });
  for (const values of [[], ["stop"], ["none"], [""], ["stop", "stop"], ["界👩‍💻é", "## body\nnext: literal\n\n  - tail · literal"]]) {
    const before = JSON.stringify(values);
    assert.equal(await capture("demo", values, "G"), controlDocument(declaredDocument(values)));
    assert.equal(JSON.stringify(values), before);
  }
  for (const values of [["stop".repeat(5000)], ["stop".repeat(5000), "other"]]) {
    assert.equal(await capture("demo", values, "G"), controlDocument({ run: "demo", action: "pause",
      result: "undeclared Run Control action", ...omitted("available_actions", "response_too_large", values.length) }));
  }
  // A fitting complete singleton must not be displaced by a larger omission scaffold.
  const tight = "r".repeat(exactFit(payload => ({ run: payload, action: "pause", result: "undeclared Run Control action", available_actions: ["stop"] })));
  assert.equal(await capture(tight, ["stop"], "G"), controlDocument({ run: tight, action: "pause",
    result: "undeclared Run Control action", available_actions: ["stop"] }));
  const count = exactFit(payload => ({ run: "demo", action: "pause", result: "undeclared Run Control action", available_actions: [payload] }));
  for (const delta of [0, 1]) {
    const output = await capture("demo", ["s".repeat(count + delta)], "G");
    if (delta === 0) {
      assert.equal(output, controlDocument({ run: "demo", action: "pause", result: "undeclared Run Control action", available_actions: ["s".repeat(count)] }));
      assert.equal(Buffer.byteLength(output), 16384);
    } else { assert.match(output, /available_actions: "\[omitted\]"/u); assert.doesNotMatch(output, /s{20}/u); }
  }
  const unit = "界👩‍💻é";
  const unicode = unit.repeat(Math.floor(count / Buffer.byteLength(unit))) + "s".repeat(count % Buffer.byteLength(unit));
  assert.equal(Buffer.byteLength(unicode), count);
  assert.equal(await capture("demo", [unicode], "G"), controlDocument({ run: "demo", action: "pause",
    result: "undeclared Run Control action", available_actions: [unicode] }));
  assert.match(await capture("demo", [unicode + "界"], "G"), /available_actions: "\[omitted\]"/u);
  const malformed = ["good", "bad\ud800"];
  assert.equal(await capture("demo", malformed, "G"), controlDocument({ run: "demo", action: "pause",
    result: "undeclared Run Control action", ...omitted("available_actions", "malformed_selected_text", 2) }));
  assert.equal(malformed[1], "bad\ud800", "Malformed selected text is withheld, not repaired");
});

test("Public message compact refusals explain a completed Run without object coercion", async () => {
  const run = `message-done-${randomUUID()}`;
  const stateDir = join(getRunStateRoot(), run);
  mkdirSync(getRunStateRoot(), { recursive: true });
  claimRunStateDirectory(stateDir, run);
  writeJsonAtomic(join(stateDir, "run.json"), { run, state_dir: stateDir, run_instance_id: "generation-A", ownerId: "session-A", pid: 0 });
  writeJsonAtomic(join(stateDir, "result.json"), { code: 0, completedAt: new Date().toISOString() });
  try {
    const tool = createControlToolDefinition();
    const ctx = { sessionManager: { getSessionId: () => "session-A" } };
    const response = await tool.execute("completed-kill", { target: `run:${run}`, action: "kill" }, undefined, undefined, ctx);
    assert.equal(response.content[0].text, controlDocument({ run, action: "kill", result: "not applied", reason: "not running", state: "done" }));
    assert.doesNotMatch(response.content[0].text, /\[object Object\]|next=|inspect/);
    assert.equal(response.details.result.stopped, false);
    assert.equal(response.details.result.killed, false);
    assert.equal(response.details.result.status.run_instance_id, "generation-A");
    const verbose = await tool.execute("completed-kill-verbose", { target: `run:${run}`, action: "kill", verbose: true }, undefined, undefined, ctx);
    assert.deepEqual(JSON.parse(verbose.content[0].text).result, response.details.result);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("Compact Control progress distinguishes attempts, delivery, completion and refusal without raw dumps", () => {
  const cases: Array<{ action: string; result: Record<string, unknown>; document: Record<string, unknown> }> = [
    { action: "kill", result: { stopped: true, killed: true, scope_closed: true, pid: 321, signal: "SIGKILL" },
      document: { result: "kill attempted", termination: "unconfirmed", next: { tool: "actors_inspect", target: "run:demo", view: "trace" } } },
    { action: "kill", result: { stopped: false, killed: false, reason: "owner mismatch", status: { status: "running" } },
      document: { result: "not applied", reason: "owner mismatch", next: { tool: "actors_inspect", target: "run:demo", view: "trace" } } },
    { action: "archive", result: { archived: true, status: "done" }, document: { result: "archived" } },
    { action: "archive", result: { archived: false, reason: "ownership changed" },
      document: { result: "not applied", reason: "ownership changed", next: { tool: "actors_inspect", target: "runtime", view: "runs" } } },
    { action: "prune", result: { pruned: true }, document: { result: "pruned" } },
    { action: "prune", result: { pruned: false, reason: "run generation changed" },
      document: { result: "not applied", reason: "run generation changed", next: { tool: "actors_inspect", target: "runtime", view: "runs" } } },
    { action: "pause", result: { delivery: "queued", control_id: "control-A" },
      document: { delivery: "queued", handling: "unconfirmed", control_id: "control-A", next: { tool: "actors_inspect", target: "run:demo", view: "control" } } },
    { action: "pause", result: { delivery: "delivered" },
      document: { delivery: "delivered", handling: "unconfirmed", next: { tool: "actors_inspect", target: "run:demo", view: "control" } } },
    { action: "pause", result: { delivery: "failed" }, document: { delivery: "failed" } },
    { action: "pause", result: { status: "handled" }, document: { result: "handled" } },
  ];
  for (const value of cases) {
    const request: ControlRequest = { target: "run:demo", action: value.action };
    const result = Object.freeze({ ...value.result, private_payload: "DO_NOT_DUMP", stdout: "DO_NOT_DUMP" });
    assert.equal(compactControlResult(request, result), controlDocument({ run: "demo", action: value.action, ...value.document }));
  }
});

test("Compact Control gives one relevant follow-up and never coerces nested status objects", () => {
  const status = { status: "done", toString() { throw Error("Object coercion is not a summary"); } };
  const request: ControlRequest = { target: "run:demo", action: "kill" };
  assert.equal(compactControlResult(request, { stopped: false, reason: "not running", status }),
    controlDocument({ run: "demo", action: "kill", result: "not applied", reason: "not running", state: "done" }));
  const result = Object.freeze({ stopped: true, next_actions: Object.freeze(["actors_inspect target=run:demo view=trace", "do not repeat the action"]) });
  assert.equal(compactControlResult(request, result),
    controlDocument({ run: "demo", action: "kill", result: "kill attempted", termination: "unconfirmed",
      next: { tool: "actors_inspect", target: "run:demo", view: "trace" } }));
});

test("AX Control records stay bare YAML, keep authored values opaque and distinguish next actions from facts", () => {
  const request: ControlRequest = { target: "run:demo", action: "pause" };
  const delivered = Object.freeze({ delivery: "delivered", control_id: "control-A", private_payload: "PRIVATE_PAYLOAD",
    next_actions: Object.freeze(["actors_inspect target=run:demo view=control", "Do not repeat"]) });
  const before = JSON.stringify(delivered);
  const rendered = compactControlResult(request, delivered);
  assert.equal(rendered, controlDocument({ run: "demo", action: "pause", delivery: "delivered", handling: "unconfirmed",
    control_id: "control-A", next: { tool: "actors_inspect", target: "run:demo", view: "control" } }));
  assert.equal(JSON.stringify(delivered), before); assert.doesNotMatch(rendered, /run: run:| · |PRIVATE_PAYLOAD|Do not repeat/);
  assert.equal(rendered.split("next:").length, 2, "At most one relevant action, not all saved hints");
  const reason = "## Explanation\r\n- next: authored Markdown\r\n\r\nKeep this · literal value";
  const instruction = "Read the saved note\n- tool: this is only text";
  const runtime = Object.freeze({ status: "handled", reason, next_actions: Object.freeze([instruction]) });
  assert.equal(compactControlResult({ target: "runtime", action: "review.retry" }, runtime),
    controlDocument({ target: "runtime", action: "review.retry", result: "handled", reason, next: { instruction } }));
  assert.equal(runtime.reason, reason); assert.equal(runtime.next_actions[0], instruction);
});

test("Public retirement receipts describe completed operations rather than accepted requests", async () => {
  const tool = createControlToolDefinition();
  const ctx = { sessionManager: { getSessionId: () => "session-A" } };
  for (const action of ["archive", "prune"]) {
    const run = `message-${action}-${randomUUID()}`;
    const stateDir = join(getRunStateRoot(), run);
    claimRunStateDirectory(stateDir, run);
    writeJsonAtomic(join(stateDir, "run.json"), { run, state_dir: stateDir, run_instance_id: "generation-A", ownerId: "session-A", pid: 0 });
    writeJsonAtomic(join(stateDir, "result.json"), { code: 0, completedAt: new Date().toISOString() });
    let archiveDir: string | undefined;
    try {
      const response = await tool.execute("retire", { target: `run:${run}`, action }, undefined, undefined, ctx);
      if (typeof response.details.result.archive_dir === "string") archiveDir = response.details.result.archive_dir;
      assert.equal(response.content[0].text,
        controlDocument({ run, action, result: action === "archive" ? "archived" : "pruned" }));
      assert.equal(response.details.result[action === "archive" ? "archived" : "pruned"], true);
      assert.doesNotMatch(response.content[0].text, /accepted|inspect|retention_id/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      if (archiveDir) rmSync(archiveDir, { recursive: true, force: true });
    }
  }
});

test("Raw Control detail remains explicit rather than default context", async () => {
  const tool = createControlToolDefinition({ handleRuntimeControl: () => ({ status: "handled", private_payload: "DETAIL_ONLY" }) });
  const params = { target: "runtime", action: "review.retry" };
  const compact = await tool.execute("compact", params, undefined, undefined, {});
  assert.equal(compact.content[0].text, controlDocument({ target: "runtime", action: "review.retry", result: "handled" }));
  assert.doesNotMatch(compact.content[0].text, /DETAIL_ONLY/);
  const verbose = await tool.execute("verbose", { ...params, verbose: true }, undefined, undefined, {});
  assert.equal(JSON.parse(verbose.content[0].text).result.private_payload, "DETAIL_ONLY");
  assert.equal(compact.details.result.private_payload, "DETAIL_ONLY");
});

test("Public identity-change refusals preserve action facts without disclosing replacement state", async () => {
  for (const action of ["kill", "archive", "prune"]) for (const change of ["generation", "owner"]) {
    const run = `message-changed-${randomUUID()}`;
    const stateDir = join(getRunStateRoot(), run);
    claimRunStateDirectory(stateDir, run);
    writeJsonAtomic(join(stateDir, "run.json"), { run, state_dir: stateDir, run_instance_id: change === "generation" ? "generation-B" : "generation-A", ownerId: change === "owner" ? "session-B" : "session-A", pid: 0,
      values: { private_token: "REPLACEMENT_PRIVATE_VALUE" }, cwd: "/replacement-private-cwd" });
    writeJsonAtomic(join(stateDir, "result.json"), { code: 0, completedAt: new Date().toISOString() });
    try {
      const before = readFileSync(join(stateDir, "run.json"));
      const tool = createControlToolDefinition({ getRunStatus: () => ({ run, state_dir: stateDir, ownerId: "session-A", run_instance_id: "generation-A" }) });
      const ctx = { sessionManager: { getSessionId: () => "session-A" } };
      const response = await tool.execute("changed", { target: `run:${run}`, action }, undefined, undefined, ctx);
      const receipt = response.details.result;
      assert.match(response.content[0].text, /not applied/);
      assert.equal(response.content[0].text, controlDocument({ run, action, result: "not applied",
        reason: change === "owner" ? "ownership changed" : "run generation changed",
        next: { tool: "actors_inspect", target: "runtime", view: "runs" } }));
      assert.equal(Object.hasOwn(receipt, "status"), false, `${action}/${change}: no replacement status`);
      assert.equal(receipt[action === "kill" ? "killed" : action === "archive" ? "archived" : "pruned"], false);
      assert.equal(receipt.reason, change === "owner" ? "ownership changed" : "run generation changed");
      assert.deepEqual(receipt.next_actions, ["actors_inspect target=runtime view=runs"]);
      const verbose = await tool.execute("changed-verbose", { target: `run:${run}`, action, verbose: true }, undefined, undefined, ctx);
      assert.deepEqual(JSON.parse(verbose.content[0].text).result, receipt);
      for (const value of [response, verbose]) {
        assert.doesNotMatch(JSON.stringify(value), /REPLACEMENT_PRIVATE_VALUE|replacement-private-cwd|session-B|generation-B/);
      }
      assert.deepEqual(readFileSync(join(stateDir, "run.json")), before);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  }
});

test("Actor-local Control failures stay bounded errors through the actual host tool boundary", async (t) => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
  const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
  const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
  const privateCause = new Error("PRIVATE_CAUSE");
  const original = Object.assign(new AggregateError([privateCause], "PRIVATE_TRANSPORT_MESSAGE", { cause: privateCause }),
    { control_id: "UNADMITTED_PRIVATE_ID", run_instance_id: "PRIVATE_GENERATION", details: { token: "PRIVATE_DETAILS" } });
  const opaque = { toString() { throw new Error("Failure coercion must not run"); } };
  const mkdir = fs.mkdirSync;
  let armed = false, attempts = 0, failure: unknown;
  const spy = t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (armed) { armed = false; attempts++; throw failure; }
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    const failureDocument = (run: string) => ({ run, action: "pause", result: "request failed",
      delivery: "unconfirmed", handling: "unconfirmed",
      warning: "Effects may already exist.\nDo not repeat automatically.",
      next: { tool: "actors_inspect", target: "runtime", view: "runs" } });
    const exact = "run:" + "r".repeat(exactFit(payload => failureDocument(payload)));
    for (failure of [original, undefined, "PRIVATE_PRIMITIVE", opaque]) for (const verbose of [false, true]) for (const target of ["run:bounded-failure", exact, exact + "r"]) {
      const tool = createControlToolDefinition({ getRunStatus: () => ({ control: ["pause"], ownerId: "session-A", run_instance_id: "generation-A" }) });
      const ctx = { sessionManager: { getSessionId: () => "session-A" } };
      const args = { target, action: "pause", input: { token: "CALLER_INPUT" }, verbose };
      const expected = target === exact + "r"
        ? controlDocument({ ...omitted("run"), action: "pause", result: "request failed", delivery: "unconfirmed",
            handling: "unconfirmed", warning: "Effects may already exist.\nDo not repeat automatically.",
            next: { tool: "actors_inspect", target: "runtime", view: "runs" } })
        : controlDocument(failureDocument(target.slice(4)));
      armed = true;
      await assert.rejects(tool.execute("direct-failure", args, undefined, undefined, ctx), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, expected);
        assert.equal(error.cause, failure);
        assert.equal(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable, false);
        assert.deepEqual(Object.keys(error), []);
        return true;
      });
      const hostTool = { ...tool, execute: (...values: [string, unknown, AbortSignal | undefined, unknown]) => tool.execute(...values, ctx) };
      const call = { type: "toolCall", id: "host-failure", name: "actors_control_apply", arguments: args };
      armed = true;
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] },
        assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(outcome.isError, true);
      assert.deepEqual(outcome.result.content, [{ type: "text", text: expected }]);
      assert.deepEqual(outcome.result.details, {});
      assert.doesNotMatch(JSON.stringify(outcome.result), /PRIVATE_|UNADMITTED_|CALLER_INPUT|generation-A|session-A/);
      assert.ok(Buffer.byteLength(outcome.result.content[0].text) <= 16 * 1024);
      if (target === exact) assert.equal(Buffer.byteLength(outcome.result.content[0].text), 16 * 1024);
      if (target === "run:bounded-failure") assert.ok(Buffer.byteLength(outcome.result.content[0].text) < 512);
    }
    assert.equal(attempts, 48, "Each direct/host call attempts admission once, not transport or retry");
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("Actor-local failure projection withholds correlation across awaited context and generation changes", { skip: process.platform !== "linux" }, async (t) => {
  // A controlled transport uses the live test host's observed identity; no runner/socket is launched or signalled.
  const pid = process.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const identity = readProcessIdentity(pid);
  assert.ok(identity);
  const connect = net.createConnection;
  let socket: EventEmitter, connections = 0;
  const spy = t.mock.method(net, "createConnection", ((..._args: unknown[]) => {
    connections++;
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  }) as typeof connect);
  syncBuiltinESMExports();
  try {
    for (const change of ["stable", "session", "ABA", "manager", "generation", "owner"]) for (const verbose of [false, true]) {
      const run = `message-await-${randomUUID()}`;
      const stateDir = join(getRunStateRoot(), run);
      claimRunStateDirectory(stateDir, run);
      const meta = { run, state_dir: stateDir, ownerId: "session-A", run_instance_id: "generation-A", pid, process_identity: identity, control: ["pause"] };
      writeJsonAtomic(join(stateDir, "run.json"), meta);
      writeJsonAtomic(join(stateDir, "control-endpoint.json"), { type: "named-pipe", path: "CONTROLLED_PRIVATE_ENDPOINT", run_instance_id: "generation-A" });
      let session = "session-A", sent = 0, wire: { id: string } | undefined;
      const ctx = { sessionManager: { getSessionId: () => session } };
      let ready!: () => void;
      const entered = new Promise<void>(resolve => { ready = resolve; });
      socket = Object.assign(new EventEmitter(), { end(payload: string) { sent++; wire = JSON.parse(payload); ready(); }, destroy() {} });
      const tool = createControlToolDefinition();
      const pending = tool.execute("await-failure", { target: `run:${run}`, action: "pause", verbose }, undefined, undefined, ctx);
      // Attach the assertion before waiting, so a broken admission never becomes an unhandled rejection.
      const assertion = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, controlDocument({ run, action: "pause", result: "request failed",
          delivery: "unconfirmed", handling: "unconfirmed",
          warning: "Effects may already exist.\nDo not repeat automatically.",
          next: { tool: "actors_inspect", target: "runtime", view: "runs" } }));
        const kernel = error.cause as Error & { control_id: string; run_instance_id: string };
        assert.equal(kernel.control_id, wire?.id);
        assert.equal(kernel.run_instance_id, "generation-A");
        assert.equal(kernel.cause, transportFailure);
        assert.doesNotMatch(error.message, /PRIVATE_|generation-|session-|CONTROLLED_|view=control/);
        assert.deepEqual(Object.keys(error), []);
        return true;
      });
      const transportFailure = new Error("PRIVATE_TRANSPORT_FAILURE", { cause: new Error("PRIVATE_ORIGINAL_CAUSE") });
      let faultSent = false;
      try {
        // A failed admission rejects the race instead of waiting indefinitely for a transport it never reached.
        await Promise.race([entered, pending.then(() => { throw new Error("Unexpected Control success"); })]);
        assert.ok(wire?.id);
        assert.equal(updateRunControlStatusInStateDir(stateDir, wire.id, "claimed"), true);
        assert.equal(updateRunControlStatusInStateDir(stateDir, wire.id, "handled"), true);
        if (change === "session" || change === "ABA") session = "session-B";
        if (change === "ABA") { await Promise.resolve(); session = "session-A"; }
        if (change === "manager") ctx.sessionManager = { getSessionId: () => "session-A" };
        if (change === "generation" || change === "owner") writeJsonAtomic(join(stateDir, "run.json"), { ...meta,
          ...(change === "generation" ? { run_instance_id: "PRIVATE_REPLACEMENT_GENERATION" } : { ownerId: "PRIVATE_REPLACEMENT_OWNER" }),
          values: { secret: "PRIVATE_REPLACEMENT_VALUE" } });
        faultSent = true;
        socket.emit("error", transportFailure);
        await assertion;
        assert.equal(sent, 1);
        assert.equal(readRunControlsFromStateDir(stateDir)[0].status, "handled");
      } finally {
        if (!faultSent && socket.listenerCount("error") > 0) socket.emit("error", transportFailure);
        await Promise.allSettled([pending, assertion]);
      }
      // Retain metadata for the live host: this fixture does not assert host exit or native scope closure.
    }
    assert.equal(connections, 12);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("SDK context guards do not grant an atomic recipient lease for Control error enrichment", async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
  const { runToolCall } = await import(new URL(JSON.parse(readFileSync(manifest, "utf8")).exports["."].import, pathToFileURL(manifest)).href);
  const root = join(getRunStateRoot(), "recipient-sdk-" + randomUUID()); mkdirSync(root, { recursive: true });
  const manager = sdk.SessionManager.inMemory(root), owner = manager.getSessionId();
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const model = { id: "recipient-fence", name: "Recipient fence fixture", provider: "recipient-fence", api: "recipient-fence", baseUrl: "https://unused.invalid",
    reasoning: false, input: ["text" as const], contextWindow: 200000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let providerCalls = 0, executions = 0;
  let current: import("@earendil-works/pi-coding-agent").ExtensionToolContext | undefined;
  let copied: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
        streamSimple() { providerCalls++; throw new Error("No provider/network request belongs to this data-only SDK probe"); } });
      pi.registerTool({ name: "recipient_scope_probe", label: "Recipient scope probe", description: "Controlled scope evidence, not a Control operation", parameters: createControlToolDefinition().parameters,
        async execute(_id, _args, _signal, _update, ctx) {
          executions++; current = ctx; copied = { ...ctx };
          assert.equal(ctx.sessionManager, manager); assert.equal(ctx.sessionManager.getSessionId(), owner);
          // Hypothetical enrichment checked here still has no atomic publication/recipient lease.
          throw new Error("FIXTURE_CANDIDATE_CORRELATION");
        } });
    }] });
  let session: Awaited<ReturnType<typeof sdk.createAgentSession>>["session"] | undefined;
  let resume = () => {}, pending: Promise<any> | undefined;
  try {
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model, thinkingLevel: "off" }));
    session.setActiveToolsByName(["recipient_scope_probe"]);
    const tool = session.agent.state.tools.find(item => item.name === "recipient_scope_probe"); assert.ok(tool);
    const call = { type: "toolCall", id: "scope-first", name: tool.name, arguments: { target: "runtime", action: "review.retry" } };
    const options = { tools: [tool], context: { systemPrompt: "", messages: [], tools: [tool] }, assistantMessage: { role: "assistant", content: [call] } };
    const first = await runToolCall(call, options); assert.equal(first.isError, true);
    const previous = current!; assert.equal(previous.sessionManager, manager, "A completed call's context still passes runner-lifetime checks");
    assert.equal(previous.signal, undefined, "Idle public runToolCall is supported without an active agent-turn signal");
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const awaiting: Promise<any> = runToolCall({ ...call, id: "scope-second" }, { ...options, afterToolCall: async () => { entered(); await gate; } });
    pending = awaiting;
    await Promise.race([ready, awaiting.then(() => { throw new Error("The controlled post-tool hook must remain pending"); })]);
    assert.notEqual(current, previous); assert.equal(current!.sessionManager, previous.sessionManager);
    const guarded = current!, snapshot = copied!;
    session.dispose();
    assert.throws(() => guarded.sessionManager, /stale/);
    assert.throws(() => previous.sessionManager, /stale/);
    assert.equal(snapshot.sessionManager.getSessionId(), owner, "Eager context copies retain readable manager data after SDK revocation");
    resume(); const outcome = await pending;
    assert.equal(outcome.isError, true); assert.deepEqual(outcome.result.content, [{ type: "text", text: "FIXTURE_CANDIDATE_CORRELATION" }]);
    assert.deepEqual(outcome.result.details, {}); assert.equal(executions, 2); assert.equal(providerCalls, 0);
    // Public core helper emits no transcript and is not an AgentSessionRuntime replacement/delivery claim.
    assert.deepEqual(session.messages, []);
  } finally {
    resume(); if (pending) await Promise.allSettled([pending]); session?.dispose();
    rmSync(root, { recursive: true, force: true }); // SDK/data only: no Actor/runner/socket/native workload was started.
  }
});

test("Public message tool exposes only the exact Control schema", () => {
  const tool = createControlToolDefinition();
  assert.equal(tool.name, "actors_control_apply");
  assert.equal(tool.label, "Control");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "action",
    "input",
    "target",
    "verbose",
  ]);
  assert.deepEqual([...tool.parameters.required].sort(), ["action", "target"]);
});

test("Public message tool routes only allowlisted runtime Controls", async () => {
  const calls: Array<{ action: string; input: unknown }> = [];
  const tool = createControlToolDefinition({
    handleRuntimeControl(action, input) {
      calls.push({ action, input });
      return { status: "handled" };
    },
  });
  const response = await tool.execute(
    "call-1",
    { action: "review.retry", input: { scope: "draft" }, target: "runtime" },
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(calls, [
    { action: "review.retry", input: { scope: "draft" } },
  ]);
  assert.equal(response.content[0].text, controlDocument({ target: "runtime", action: "review.retry", result: "handled" }));
  assert.equal(Object.hasOwn(response.details.result, "sent"), false);
  await assert.rejects(
    tool.execute(
      "call-2",
      { action: "shutdown", target: "runtime" },
      undefined,
      undefined,
      {},
    ),
    /unsupported runtime Control action/,
  );
});

test("Public message Run operations fail closed without a matching coordinator session", async () => {
  const tool = createControlToolDefinition({
    getRunStatus: () => ({
      control: ["pause"],
      ownerId: "session-a",
      run_instance_id: "generation-a",
      status: "running",
    }),
  });
  await assert.rejects(
    tool.execute(
      "missing-session",
      { action: "pause", target: "run:demo" },
      undefined,
      undefined,
      {},
    ),
    (error: Error & { reason?: string }) => error.reason === "session_unavailable",
  );
  await assert.rejects(
    tool.execute(
      "foreign-session",
      { action: "pause", target: "run:demo" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-b" } },
    ),
    (error: Error & { reason?: string }) => error.reason === "session_mismatch",
  );
});

test("Public message tool rejects every legacy envelope before dispatch", async () => {
  const tool = createControlToolDefinition();
  await assert.rejects(
    tool.execute(
      "call-1",
      { to: "run:demo", type: "control.pause" },
      undefined,
      undefined,
      {},
    ),
    /actor-message fields are removed: to, type/,
  );
});
