import "./test-environment.mjs";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

import * as Limits from "../lib/limits.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";
import { renderYamlMetadata, spaceToolError } from "../lib/tools-response.ts";

/** Expected bare block-YAML inspect refusal text; the public adapter adds the single leading LF. */
function inspectDocument(value: Record<string, unknown>): string {
  const rendered = renderYamlMetadata(value, Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  assert.equal(rendered.state, "available");
  return (rendered as { text: string }).text.replace(/\n$/u, "");
}
/** Expected compact metadata document: one leading LF, no trailing LF. */
function compactInspectDocument(value: Record<string, unknown>): string {
  const rendered = renderYamlMetadata(value, Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  assert.equal(rendered.state, "available");
  return "\n" + (rendered as { text: string }).text.replace(/\n$/u, "");
}
const compactTriage = (failed: number, pending_controls: number, stale_controls: number, backpressured: number,
  incomplete_trace: number, attention: number) => compactInspectDocument({ runtime: "triage", failed, pending_controls,
  stale_controls, backpressured, incomplete_trace, attention });
const omittedField = (key: string) => ({ [key]: { state: "omitted", reason: "response_too_large", shown: 0, omitted: 1, total: 1 } });
/** Assert one refused inspect request returned the expected YAML document. */
function refuses(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected);
    return true;
  };
}
/** Largest single-byte payload whose complete refusal text still fits the shared budget. */
function exactFit(document: (payload: string) => Record<string, unknown>): number {
  let low = 0, high = Limits.RUN_DELIVERY_MODEL_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const rendered = renderYamlMetadata(document("x".repeat(middle)), Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    if (rendered.state === "available") low = middle;
    else high = middle - 1;
  }
  return low;
}
import { createActiveSkillRecipeContext } from "../lib/recipes-references.ts";

const sessionAContext = {
  sessionManager: { getSessionId: () => "session-a" },
};

async function fixture(): Promise<{ root: string; status: Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspect-kernel-"));
  const status = {
    artifacts: {},
    control: ["pause"],
    ownerId: "session-a",
    run: "demo",
    run_instance_id: "generation-a",
    state_dir: root,
    status: "running",
  };
  await writeFile(
    join(root, "run.json"),
    JSON.stringify({
      ...status,
      recipe: "demo-recipe",
      recipe_context_records: [{
        depth: 0,
        import_path: [],
        logical_reference: "demo.json",
        name: "demo-recipe",
        recipe: { control: ["pause"], template: "echo demo" },
        role: "entry",
        source_file: "/private/recipes/demo.json",
        source_kind: "explicit_file_recipe",
      }],
      template: "echo demo",
      values: {},
    }),
  );
  await writeFile(
    join(root, "trace.jsonl"),
    `${JSON.stringify({ id: "trace-1", ts: "2026-01-01T00:00:00.000Z", kind: "run.start" })}\n`,
  );
  await writeFile(
    join(root, "controls.jsonl"),
    `${JSON.stringify({ id: "control-1", run_instance_id: "generation-a", action: "pause", input: { token: "TOOL_CONTROL_SECRET", nested: { password: "TOOL_PASSWORD_SECRET", note: "token=TOOL_INLINE_SECRET" } }, status: "failed", queued_at: "2026-01-01T00:00:00.000Z", failed_at: "2026-01-01T00:00:01.000Z", error: "authorization=TOOL_ERROR_SECRET unavailable" })}\n`,
  );
  await writeFile(
    join(root, "control-endpoint.json"),
    JSON.stringify({
      path: "named-pipe-demo",
      ready_at: "2026-01-01T00:00:00.000Z",
      run_instance_id: "generation-a",
      type: "named-pipe",
    }),
  );
  return { root, status };
}


test("AX inspect owned refusals preserve all ten guards, sequences and original callback ordering", async () => {
  const { root, status } = await fixture();
  const calls: string[] = [];
  const tool = createInspectToolDefinition({ recipeRoot: root,
    getRunStatus: run => { calls.push("run:" + run); return status; },
    getTool: name => { calls.push("tool:" + name); return undefined; },
    getToolStatus: name => { calls.push("status:" + name); return name === "dormant" ? { callable_now: false, activation_boundary: "active_tool_set" } : undefined; },
  });
  const hostile = "## source\r\n\r\n- next: do not promote\n  - tool: no action · literal";
  const cases = [
    [{ target: "runtime", view: "snapshot" }, inspectDocument({ target_kind: "runtime", result: "unsupported view", supported_views: ["status", "runs", "triage"] }), []],
    [{ target: "recipes", view: "trace" }, inspectDocument({ target_kind: "recipes", result: "unsupported view", supported_views: ["status", "summary", "registry", "doctor", "imports", "reviews"] }), []],
    [{ target: "recipes", view: "status", identity: "missing/task" }, inspectDocument({ target_kind: "recipes", result: "identity requires view=doctor" }), []],
    [{ target: "run:demo", view: "status" }, inspectDocument({ target_kind: "run", result: "unsupported view", supported_views: ["recipe", "trace", "control"] }), []],
    [{ target: "run:demo", view: "trace", source: hostile }, inspectDocument({ target_kind: "run", source: hostile, result: "unsupported Trace source", supported_sources: ["all", "lifecycle", "control", "process", "agent", "artifact", "runtime"] }), ["run:demo"]],
    [{ target: "tool:../missing", view: "status" }, inspectDocument({ target: "tool:../missing", result: "invalid tool target" }), []],
    [{ target: "tool:demo", view: "trace" }, inspectDocument({ target_kind: "tool", result: "unsupported view", supported_views: ["status", "schema"] }), []],
    [{ target: "tool:missing", view: "status" }, inspectDocument({ tool: "missing", result: "registered tool not found", safety: "Do not substitute spawn for tool invocation.", next: { tool: "inspect", target: "recipes", view: "doctor" } }), ["tool:missing", "status:missing"]],
    [{ target: "tool:dormant", view: "schema" }, inspectDocument({ tool: "dormant", result: "registered; callable schema unavailable", callable_now: "false", activation_boundary: "active_tool_set", next: { tool: "inspect", target: "tool:dormant", view: "status" } }), ["tool:dormant", "status:dormant"]],
    [{ target: "coordinator", view: "status" }, inspectDocument({ target: "coordinator", result: "unsupported inspect target", supported_targets: ["run:<id>", "runtime", "recipes", "tool:<name>"] }), []],
  ] as const;
  const before = await readFile(join(root, "controls.jsonl"), "utf8");
  try {
    for (const [request, expected, observations] of cases) for (const verbose of [false, true]) {
      calls.length = 0;
      await assert.rejects(tool.execute("guard", { ...request, verbose }, undefined, undefined, sessionAContext), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.constructor, Error);
        assert.equal(error.message, expected);
        assert.equal(Object.hasOwn(error, "cause"), false);
        assert.equal(Object.hasOwn(error, "reason"), false);
        assert.equal(Object.hasOwn(error, "details"), false);
        assert.equal((error.message.match(/^- next:/gmu) ?? []).length, expected.includes("\n- next:") ? 1 : 0);
        return true;
      });
      assert.deepEqual(calls, observations);
    }
    assert.equal(await readFile(join(root, "controls.jsonl"), "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX inspect error whole-field budgets preserve exact boundaries and unowned failures without repair", async () => {
  const unknown = createInspectToolDefinition();
  const targetDocument = (target: unknown) => ({ target, result: "unsupported inspect target",
    supported_targets: ["run:<id>", "runtime", "recipes", "tool:<name>"] });
  const omission = { state: "omitted", reason: "response_too_large", shown: 0, omitted: 1, total: 1 };
  const allowance = exactFit((payload) => targetDocument(payload));
  const capture = async (tool: ReturnType<typeof createInspectToolDefinition>, request: unknown, ctx: unknown = {}) => {
    let captured: unknown;
    let rejected = false;
    await tool.execute("boundary", request, undefined, undefined, ctx).then(() => {}, (error: unknown) => { rejected = true; captured = error; });
    assert.equal(rejected, true);
    return captured;
  };
  for (const value of ["x".repeat(allowance), "界".repeat(Math.floor(allowance / 3)), "👩‍💻é".repeat(12), "next:\r\n- tool: literal"]) {
    const error = await capture(unknown, { target: value, view: "status" });
    assert.ok(error instanceof Error);
    assert.equal(error.message, inspectDocument(targetDocument(value)));
    assert.ok(Buffer.byteLength(error.message) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  }
  // Malformed selected text is unavailable as a whole field; it is never repaired or emitted raw.
  const malformedTarget = await capture(unknown, { target: "\ud800", view: "status" });
  assert.ok(malformedTarget instanceof Error);
  assert.equal(malformedTarget.message, inspectDocument(targetDocument(omission)));
  const exact = await capture(unknown, { target: "x".repeat(allowance), view: "status" });
  assert.ok(exact instanceof Error);
  assert.equal(spaceToolError(exact), exact);
  assert.equal(Buffer.byteLength(exact.message), Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  assert.equal(exact.message, "\n" + inspectDocument(targetDocument("x".repeat(allowance))));
  for (const value of ["x".repeat(allowance + 1), "界".repeat(allowance), "👩‍💻".repeat(allowance)]) {
    const error = await capture(unknown, { target: value, view: "status", verbose: true });
    assert.ok(error instanceof Error);
    assert.equal(error.message, inspectDocument(targetDocument(omission)));
    assert.ok(Buffer.byteLength(error.message) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    assert.doesNotMatch(error.message, /…|chars|^next:/mu);
  }
  const name = "a".repeat(Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  const selected = createInspectToolDefinition({ getToolStatus: () => ({ callable_now: false, activation_boundary: "active_tool_set" }) });
  const schema = await capture(selected, { target: "tool:" + name, view: "schema" });
  assert.ok(schema instanceof Error);
  assert.match(schema.message, /^tool:\n  state: "omitted"/u);
  assert.match(schema.message, /result: "registered; callable schema unavailable"\ncallable_now: "false"\nactivation_boundary: "active_tool_set"/u);
  assert.match(schema.message, /next_action:\n  state: "omitted"\n  reason: "response_too_large"\n  shown: 0\n  omitted: 1\n  total: 1$/u);
  assert.ok(Buffer.byteLength(schema.message) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  assert.doesNotMatch(schema.message, /^next:/mu);
  const omittedDocument = (key: string) => `${key}:\n  state: "omitted"\n  reason: "response_too_large"\n  shown: 0\n  omitted: 1\n  total: 1`;
  for (const remaining of [512, 384, 256, 192, 128, 64, 1]) {
    const boundaryName = "a".repeat(Limits.RUN_DELIVERY_MODEL_MAX_BYTES - remaining);
    const error = await capture(selected, { target: "tool:" + boundaryName, view: "schema" });
    assert.ok(error instanceof Error);
    if (error.message.startsWith(omittedDocument("tool"))) {
      assert.ok(Buffer.byteLength(error.message.replace(omittedDocument("tool"), `tool: ${JSON.stringify(boundaryName)}`)) + 1 > Limits.RUN_DELIVERY_MODEL_MAX_BYTES,
        "An omitted whole field must actually exceed the final shared budget, not merely a larger reserved placeholder");
    }
    if (error.message.endsWith(omittedDocument("next_action"))) {
      assert.ok(Buffer.byteLength(error.message.replace(omittedDocument("next_action"),
        `next:\n  tool: "inspect"\n  target: ${JSON.stringify("tool:" + boundaryName)}\n  view: "status"`)) + 1 > Limits.RUN_DELIVERY_MODEL_MAX_BYTES,
        "An omitted action must actually exceed the final shared budget");
    }
  }
  const missing = await capture(unknown, { target: "tool:" + name, view: "status" });
  assert.ok(missing instanceof Error);
  assert.match(missing.message, /^tool:\n  state: "omitted"/u);
  assert.match(missing.message, /safety: "Do not substitute spawn for tool invocation\."/u);
  assert.ok(missing.message.endsWith('next:\n  tool: "inspect"\n  target: "recipes"\n  view: "doctor"'));
  assert.ok(Buffer.byteLength(missing.message) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  const defaults = await capture(createInspectToolDefinition({ getToolStatus: () => ({}) }), { target: "tool:demo", view: "schema" });
  assert.ok(defaults instanceof Error);
  assert.match(defaults.message, /callable_now: "false"\nactivation_boundary: "host_registration"/u);
  let trapReads = 0;
  const trapped = Object.defineProperty(new Error("not observed"), "message", { get() { trapReads += 1; throw Symbol("message trap"); } });
  const raw = [undefined, "primitive", Symbol("opaque"), trapped, Object.freeze({ message: "not an Error", private: true }),
    new AggregateError([new Error("inner")], "external", { cause: new Error("original") })];
  for (const failure of raw) {
    const ports = [
      { request: { target: "run:demo", view: "trace" }, deps: { getRunStatus: () => { throw failure; } } },
      { request: { target: "tool:demo", view: "status" }, deps: { getTool: () => { throw failure; } } },
      { request: { target: "tool:demo", view: "status" }, deps: { getToolStatus: () => { throw failure; } } },
      { request: { target: "recipes", view: "status" }, deps: { registryStatus: () => { throw failure; } } },
    ];
    for (const port of ports) assert.equal(await capture(createInspectToolDefinition(port.deps), port.request, sessionAContext), failure);
    let messageReads = 0, boundaryReads = 0;
    const malformed = createInspectToolDefinition({ getToolStatus: () => ({
      get callable_now() { messageReads += 1; return { toString() { throw failure; } }; },
      get activation_boundary() { boundaryReads += 1; return "not observed"; },
    }) });
    assert.equal(await capture(malformed, { target: "tool:demo", view: "schema" }), failure);
    assert.equal(messageReads, 1); assert.equal(boundaryReads, 0);
  }
  assert.equal(trapReads, 0);
  const { root, status } = await fixture();
  try {
    const foreign = createInspectToolDefinition({ getRunStatus: () => ({ ...status, ownerId: "session-b" }) });
    const refused = await capture(foreign, { target: "run:demo", view: "trace", source: "do-not-echo-source" }, sessionAContext);
    assert.ok(refused instanceof Error);
    assert.equal((refused as Error & { reason?: string }).reason, "session_mismatch");
    assert.equal((refused as Error & { hint?: string }).hint, "inspect target=runtime view=runs");
    assert.doesNotMatch(refused.message, /do-not-echo-source/);
    let callableReads = 0, boundaryReads = 0;
    const opaque = "## Boundary\r\n\r\nnext: not trusted\n- tool: content";
    const once = createInspectToolDefinition({ getToolStatus: () => ({
      get callable_now() { callableReads += 1; return false; },
      get activation_boundary() { boundaryReads += 1; return opaque; },
    }) });
    const error = await capture(once, { target: "tool:demo", view: "schema" });
    assert.ok(error instanceof Error);
    assert.equal(error.message, inspectDocument({ tool: "demo", result: "registered; callable schema unavailable",
      callable_now: "false", activation_boundary: opaque, next: { tool: "inspect", target: "tool:demo", view: "status" } }));
    assert.equal(callableReads, 1); assert.equal(boundaryReads, 1);
    const fallback = createInspectToolDefinition({ listRuns: () => [status], getRunStatus: () => { throw undefined; } });
    const result = await fallback.execute("fallback", { target: "runtime", view: "runs" }, undefined, undefined, sessionAContext);
    assert.equal(result.details.runs.length, 1);
    assert.deepEqual(result.details.runs[0], status);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Compact tool inspection omits whole unfit argument groups without breaking verbose JSON", async () => {
  const large = Array.from({ length: 1600 }, (_, i) => "input_" + i);
  for (const required_args of [large, ["\ud800"], ["file"]]) {
    const facts = { callable_now: true, required_args, optional_args: large };
    const tool = createInspectToolDefinition({ getToolStatus: () => facts });
    for (const verbose of [false, true]) {
      const result = await tool.execute("bounds", { target: "tool:demo", view: "status", verbose }, undefined, undefined, {});
      assert.deepEqual(result.details.required_args, required_args);
      if (verbose) {
        assert.equal(result.content[0].text, "\n" + JSON.stringify(result.details, null, 2));
        continue;
      }
      const text = result.content[0].text, doc = parseDocument(text);
      assert.deepEqual(doc.errors, []); assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
      const value = doc.toJS();
      assert.equal(value.tool, "demo"); assert.equal(value.callable_now, true);
      assert.equal(value.optional_args, "[omitted]");
      assert.deepEqual(value.optional_args_omission, { reason: "response_too_large", shown: 0, omitted: large.length, total: large.length });
      if (required_args === large) assert.equal(value.required_args, "[omitted]");
      else if (required_args[0] === "\ud800") {
        assert.equal(value.required_args, "[unavailable]");
        assert.equal(value.required_args_omission.reason, "malformed_selected_text");
      } else assert.deepEqual(value.required_args, ["file"]);
    }
  }
});

test("AX compact inspection preserves Run views, tool facts and opaque advice while verbose schema stays exact", async () => {
  const { root, status } = await fixture();
  try {
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    for (const view of ["recipe", "trace", "control"]) {
      const compact = await tool.execute("compact", { target: "run:demo", view }, undefined, undefined, sessionAContext);
      const verbose = await tool.execute("verbose", { target: "run:demo", view, verbose: true }, undefined, undefined, sessionAContext);
      assert.equal(compact.content[0].text, compactInspectDocument({ run: "demo", view }));
      assert.deepEqual(compact.details, verbose.details); assert.equal(verbose.content[0].text, "\n" + JSON.stringify(verbose.details, null, 2));
      assert.doesNotMatch(JSON.stringify(compact), /TOOL_.*_SECRET|\/private\/recipes|run: run:/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  const advice = "## Advice\r\n\r\n- tool: source text · kept\n  - Nested";
  const facts = Object.freeze({ callable_now: true, activation_boundary: "current_session", source: "sample/task", required_args: Object.freeze(["file", "input path"]), optional_args: Object.freeze(["mode"]),
    launch_kind: "tool", spawn_calls: 2, tool_calls: 3, next_actions: Object.freeze([advice, "register_tool name=demo update=true"]) });
  const before = JSON.stringify(facts);
  const tool = createInspectToolDefinition({ getTool: () => ({ description: "Demo", parameters: { type: "object", properties: {} } }), getToolStatus: () => facts });
  const result = await tool.execute("tool", { target: "tool:demo", view: "status" }, undefined, undefined, {});
  assert.equal(result.content[0].text, compactInspectDocument({ tool: "demo", source: "sample/task", callable_now: true,
    activation_boundary: "current_session", required_args: ["file", "input path"], optional_args: ["mode"],
    launch_kind: "tool", spawn_calls: 2, tool_calls: 3, next: { instruction: advice } }));
  assert.equal(JSON.stringify(facts), before); assert.equal(result.details.next_actions, facts.next_actions);
  assert.equal(result.content[0].text.split("next:").length, 2, "Only one selected hint becomes a next node");
  const verbose = await tool.execute("verbose", { target: "tool:demo", view: "status", verbose: true }, undefined, undefined, {});
  assert.equal(verbose.content[0].text, "\n" + JSON.stringify(verbose.details, null, 2)); assert.deepEqual(verbose.details, result.details);
  const schema = await tool.execute("schema", { target: "tool:demo", view: "schema" }, undefined, undefined, {});
  // Generated definition metadata is YAML; the unchanged machine object still lives in details.
  assert.equal(schema.content[0].text, [
    "", 'name: "demo"', 'description: "Demo"', "parameters:", '  type: "object"', "  properties:", "    {}",
  ].join("\n") + "\n");
  assert.deepEqual(schema.details, { description: "Demo", name: "demo", parameters: { properties: {}, type: "object" },
    promptSnippet: undefined });
  assert.doesNotMatch(schema.content[0].text, /promptSnippet|undefined/u);
  const empty = createInspectToolDefinition({ getToolStatus: () => ({ callable_now: false, required_args: [], next_actions: ["inspect target=recipes view=doctor"] }) });
  const sparse = await empty.execute("sparse", { target: "tool:dormant", view: "status" }, undefined, undefined, {});
  assert.equal(sparse.content[0].text, compactInspectDocument({ tool: "dormant", source: "unknown", callable_now: false,
    activation_boundary: "unknown", required_args: "none", optional_args: "unknown", launch_kind: "none",
    spawn_calls: 0, tool_calls: 0, next: { tool: "inspect", target: "recipes", view: "doctor" } }));
});

test("Inspect exposes canonical Run Recipe, Trace, and Control views", async () => {
  const { root, status } = await fixture();
  try {
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    const recipe = await tool.execute("recipe", { target: "run:demo", view: "recipe", verbose: true }, undefined, undefined, sessionAContext);
    assert.equal(recipe.details.identity.recipe, "demo-recipe");
    assert.equal(recipe.details.identity.logical_reference, "demo.json");
    assert.equal(recipe.details.identity.source_kind, "explicit_file_recipe");
    assert.equal(recipe.details.composition[0].role, "entry");
    assert.equal(recipe.details.composition[0].recipe_stem, "demo-recipe");
    assert.doesNotMatch(JSON.stringify(recipe), /\/private\/recipes/);
    const trace = await tool.execute("trace", { target: "run:demo", view: "trace", source: "lifecycle", verbose: true }, undefined, undefined, sessionAContext);
    assert.equal(trace.details.items[0].kind, "run.start");
    assert.deepEqual(trace.details.summary, {
      history_complete: true,
      compacted: false,
      compactions_total: 0,
      dropped_events: 0,
      dropped_bytes: 0,
      dropped_event_count_exact: true,
      retained_events: 1,
      retained_bytes: Buffer.byteLength(await readFile(join(root, "trace.jsonl"))),
    });
    const control = await tool.execute("control", { target: "run:demo", view: "control", verbose: true }, undefined, undefined, sessionAContext);
    assert.deepEqual(control.details.actor_actions, ["pause"]);
    assert.deepEqual(control.details.runtime_actions, ["kill"]);
    assert.equal(control.details.endpoint.type, "named-pipe");
    assert.equal(control.details.pending, 0);
    assert.equal(control.details.pending_limit, Limits.RUN_CONTROL_PENDING_LIMIT);
    assert.equal(control.details.available, Limits.RUN_CONTROL_PENDING_LIMIT);
    assert.equal(control.details.backpressured, false);
    assert.equal(control.details.journal_limit, Limits.RUN_CONTROL_JOURNAL_MAX_BYTES);
    assert.equal(control.details.stale_pending, 0);
    assert.deepEqual(control.details.diagnostics, []);
    assert.equal(control.details.recent_controls[0].status, "failed");
    assert.equal(control.details.recent_controls[0].input.token, "[REDACTED]");
    assert.match(control.details.recent_controls[0].error, /\[REDACTED\]/);
    const exposed = JSON.stringify(control);
    for (const sentinel of [
      "TOOL_CONTROL_SECRET",
      "TOOL_PASSWORD_SECRET",
      "TOOL_INLINE_SECRET",
      "TOOL_ERROR_SECRET",
    ]) {
      assert.doesNotMatch(exposed, new RegExp(sentinel));
    }
    const controlTrace = await tool.execute(
      "control-trace",
      { target: "run:demo", view: "trace", source: "control", verbose: true },
      undefined,
      undefined,
      sessionAContext,
    );
    assert.equal(controlTrace.details.items[0].kind, "control.failed");
    assert.doesNotMatch(JSON.stringify(controlTrace), /TOOL_.*_SECRET/);
    const durable = await readFile(join(root, "controls.jsonl"), "utf8");
    assert.match(durable, /TOOL_CONTROL_SECRET/);
    assert.match(durable, /TOOL_ERROR_SECRET/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run inspection fails closed without a matching coordinator session", async () => {
  const { root, status } = await fixture();
  try {
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    await assert.rejects(
      tool.execute(
        "missing-session",
        { target: "run:demo", view: "trace" },
        undefined,
        undefined,
        {},
      ),
      (error: Error & { reason?: string }) =>
        error.reason === "session_unavailable" && /active coordinator session/.test(error.message),
    );
    await assert.rejects(
      tool.execute(
        "foreign-session",
        { target: "run:demo", view: "control" },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-b" } },
      ),
      (error: Error & { hint?: string; reason?: string }) =>
        error.reason === "session_mismatch" &&
        error.hint === "inspect target=runtime view=runs",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Inspect Control diagnoses structurally invalid retained records", async () => {
  const { root, status } = await fixture();
  try {
    await writeFile(join(root, "controls.jsonl"), `${JSON.stringify({
      id: "bad", run_instance_id: "generation-a", action: "pause",
      status: "claimed", queued_at: new Date().toISOString(), claimed_at: "invalid",
    })}\n`);
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    const control = await tool.execute("control", {
      target: "run:demo", view: "control", verbose: true,
    }, undefined, undefined, sessionAContext);
    assert.deepEqual(control.details.diagnostics, [{ reason: "invalid_status_timestamp" }]);
    assert.equal(control.details.pending, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Inspect rejects removed Run views on the canonical target", async () => {
  const { root, status } = await fixture();
  try {
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    await assert.rejects(
      tool.execute("status", { target: "run:demo", view: "status" }, undefined, undefined, sessionAContext),
      refuses(inspectDocument({ target_kind: "run", result: "unsupported view", supported_views: ["recipe", "trace", "control"] })),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Inspect treats recipes registry and summary as one inspection path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspect-recipe-alias-"));
  const recipeRoot = join(root, "recipes");
  try {
    await mkdir(join(recipeRoot, "drafts"), { recursive: true });
    await writeFile(join(recipeRoot, "task.json"), JSON.stringify({ template: "echo task" }));
    await writeFile(join(recipeRoot, "broken.json"), JSON.stringify({ description: "missing template" }));
    await writeFile(join(recipeRoot, "drafts", "draft.json"), JSON.stringify({ template: "echo draft" }));
    const tool = createInspectToolDefinition({ recipeRoot });
    for (const verbose of [false, true]) {
      const summary = await tool.execute(
        "summary",
        { target: "recipes", view: "summary", verbose },
        undefined,
        undefined,
        {},
      );
      const registry = await tool.execute(
        "registry",
        { target: "recipes", view: "registry", verbose },
        undefined,
        undefined,
        {},
      );
      assert.deepEqual(registry.details, summary.details);
      assert.equal(registry.content[0].text, summary.content[0].text);
      assert.deepEqual(summary.details.next_actions.slice(0, 2), [
        "inspect target=recipes view=doctor",
        "inspect target=recipes view=summary verbose=true",
      ]);
      assert.match(
        String(summary.details.next_actions[2]),
        /^spawn file=.*\/recipes\/drafts\/draft\.json$/,
      );
    }
    const compact = await tool.execute(
      "registry-compact",
      { target: "recipes", view: "registry" },
      undefined,
      undefined,
      {},
    );
    assert.match(
      compact.content[0].text,
      /^\nrecipes: "registry"\nactive: [1-9]\d*\ndrafts: 1\nshadowed: 0\ninvalid: 1\n/u,
    );
    await assert.rejects(
      tool.execute(
        "registry-identity",
        { target: "recipes", view: "registry", identity: "missing/task" },
        undefined,
        undefined,
        {},
      ),
      refuses(inspectDocument({ target_kind: "recipes", result: "identity requires view=doctor" })),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Inspect Recipe diagnostics distinguish user capabilities and active Skill components", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspect-recipes-"));
  const sampleSkill = join(root, "skills", "sample");
  const recipeRoot = join(root, "recipes");
  try {
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(join(sampleSkill, "recipes", "nested"), { recursive: true });
      await fs.mkdir(recipeRoot, { recursive: true });
      await fs.writeFile(join(sampleSkill, "recipes", "task.json"), JSON.stringify({ template: "echo skill" }));
      await fs.writeFile(join(sampleSkill, "recipes", "bad.json"), JSON.stringify({ description: "missing template" }));
      await fs.writeFile(join(sampleSkill, "recipes", "nested", "hidden.json"), JSON.stringify({ template: "echo hidden" }));
      await fs.writeFile(join(recipeRoot, "user-tool.json"), JSON.stringify({ template: "echo user" }));
    });
    const activeSkillRecipeContext = createActiveSkillRecipeContext([
      { name: "sample", baseDir: sampleSkill },
      { name: "duplicate", baseDir: "/skills/first" },
      { name: "duplicate", baseDir: "/skills/second" },
    ]);
    const recipeResolutionContext = createRecipeResolutionContext(
      "inspect-ambiguous-session",
      root,
      activeSkillRecipeContext,
    );
    const tool = createInspectToolDefinition({
      recipeRoot,
      registryStatus: () => ({
        active_tool_count: 1,
        last_scan_at: "2026-03-22T00:00:00.000Z",
        last_scan_counts: { active: 1, rejected: 0, scanned: 1 },
        registry_generation: 3,
        resolution_generation: "resolution-3",
        watch_status: "watching_root",
        watched_root: recipeRoot,
      }),
    });
    const result = await tool.execute(
      "recipes",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      { recipeResolutionContext },
    );
    assert.deepEqual(result.details.active_skill_recipe_identities, [
      "duplicate",
      "sample",
    ]);
    assert.equal(result.details.skill_recipe_namespaces, undefined);
    assert.equal(
      result.details.skill_recipe_namespace_diagnostics[0].name,
      "duplicate",
    );
    assert.equal(result.details.active[0].source_kind, "user_registry_capability");
    assert.equal(result.details.registry_generation, 3);
    assert.equal(result.details.resolution_generation, "resolution-3");
    assert.equal(result.details.watch_status, "watching_root");
    assert.equal(result.details.watched_root, "~/.pi/agent/recipes");
    assert.deepEqual(result.details.last_scan_counts, {
      active: 1,
      rejected: 0,
      scanned: 1,
    });
    assert.deepEqual(result.details.skill_recipe_components, [{
      identity: "sample/task",
      source_kind: "active_skill_component",
      skill: "sample",
      stem: "task",
      imports: {},
    }]);
    assert.equal(result.details.skill_recipe_catalog_partial, true);
    assert.match(
      result.details.skill_recipe_component_diagnostics[0].error,
      /Duplicate active Skill identity duplicate/,
    );
    const compactCatalog = await tool.execute(
      "compact-catalog",
      { target: "recipes", view: "status" },
      undefined,
      undefined,
      { recipeResolutionContext },
    );
    assert.match(compactCatalog.content[0].text, /skill_catalog_partial: true/u);
    assert.match(
      compactCatalog.content[0].text,
      /next:\n  tool: "inspect"\n  target: "recipes"\n  view: "imports"\n  verbose: true/u,
    );

    const focused = await tool.execute(
      "focused-component",
      { target: "recipes", view: "doctor", identity: "sample/task" },
      undefined,
      undefined,
      { recipeResolutionContext },
    );
    assert.deepEqual(focused.details, {
      identity: "sample/task",
      skill_active: true,
      resolvable: true,
      catalog_partial: true,
      component_status: "available",
      source_location: "<active-skill:sample>/task.json",
      resolution_generation: recipeResolutionContext.generation,
      next_actions: [
        "spawn recipe=sample/task",
        "register_tool name=<tool-name> from=sample/task",
      ],
    });
    assert.equal(focused.content[0].text, compactInspectDocument({ recipes: "doctor", identity: "sample/task",
      skill_active: "true", resolvable: "true", catalog_partial: "true", component_status: "available",
      source_location: "<active-skill:sample>/task.json", resolution_generation: focused.details.resolution_generation,
      next: { instruction: "spawn recipe=sample/task" } }));
    assert.doesNotMatch(focused.content[0].text, new RegExp(root));
    assert.ok(focused.content[0].text.includes('source_location: "<active-skill:sample>/task.json"\n'));
    assert.ok(focused.content[0].text.endsWith('next:\n  instruction: "spawn recipe=sample/task"'));
    assert.doesNotMatch(focused.content[0].text, /register_tool|next:-/mu);

    const inactive = await tool.execute(
      "inactive-component",
      { target: "recipes", view: "doctor", identity: "absent/task" },
      undefined,
      undefined,
      { recipeResolutionContext },
    );
    assert.equal(inactive.details.component_status, "skill_inactive");
    assert.equal(inactive.details.skill_active, false);
    assert.equal(inactive.details.resolvable, false);
    assert.match(inactive.details.rejected_reason, /Active Skill Recipe not found/);
    assert.deepEqual(inactive.details.next_actions, [
      "activate Skill absent",
      "inspect target=recipes view=doctor identity=absent/task",
    ]);

    const nestedDiagnostic = result.details.skill_recipe_component_diagnostics.find(
      (diagnostic: Record<string, unknown>) => String(diagnostic.error).includes("Nested Skill Recipe"),
    );
    assert.equal(
      nestedDiagnostic.file,
      "<active-skill:sample>/nested/hidden.json",
    );
    assert.match(
      nestedDiagnostic.error,
      /<active-skill:sample>\/nested\/hidden\.json/,
    );
    assert.doesNotMatch(nestedDiagnostic.error, new RegExp(root));

    const rejected = await tool.execute(
      "rejected-component",
      { target: "recipes", view: "doctor", identity: "sample/bad" },
      undefined,
      undefined,
      { recipeResolutionContext },
    );
    assert.equal(rejected.details.component_status, "rejected");
    assert.equal(rejected.details.source_location, "<active-skill:sample>/bad.json");
    assert.match(rejected.details.rejected_reason, /Invalid Skill Recipe component/);

    const ambiguous = await tool.execute(
      "ambiguous-component",
      { target: "recipes", view: "doctor", identity: "duplicate/task" },
      undefined,
      undefined,
      { recipeResolutionContext },
    );
    assert.equal(ambiguous.details.component_status, "ambiguous_skill");
    assert.match(ambiguous.details.rejected_reason, /Duplicate active Skill identity duplicate/);

    await assert.rejects(
      tool.execute(
        "misplaced-identity",
        { target: "recipes", view: "imports", identity: "sample/task" },
        undefined,
        undefined,
        { recipeResolutionContext },
      ),
      refuses(inspectDocument({ target_kind: "recipes", result: "identity requires view=doctor" })),
    );

    await rm(join(sampleSkill, "recipes", "bad.json"));
    await rm(join(sampleSkill, "recipes", "nested"), { recursive: true });
    const unambiguous = createActiveSkillRecipeContext([
      { name: "sample", baseDir: sampleSkill },
    ]);
    const unambiguousResolutionContext = createRecipeResolutionContext(
      "inspect-unambiguous-session",
      root,
      unambiguous,
    );
    const componentResult = await tool.execute(
      "components",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      { recipeResolutionContext: unambiguousResolutionContext },
    );
    assert.equal(componentResult.details.skill_recipe_catalog_partial, false);
    assert.deepEqual(componentResult.details.skill_recipe_components, [{
      identity: "sample/task",
      source_kind: "active_skill_component",
      skill: "sample",
      stem: "task",
      imports: {},
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AX runtime records preserve existing facts, full inventory and independent verbose navigation", async () => {
  const { root, status } = await fixture();
  try {
    const rows = Object.freeze([...Array.from({ length: 240 }, (_, index) => Object.freeze({ ...status, run: "owned-" + index, state_dir: join(root, "owned-" + index) })),
      Object.freeze({ ...status, run: "foreign", ownerId: "session-b", state_dir: join(root, "foreign") })]);
    const byDir = new Map(rows.map(row => [row.state_dir, row])); let reads = 0;
    const before = JSON.stringify(rows), tool = createInspectToolDefinition({ listRuns: () => [...rows], getRunStatus: dir => { reads++; return byDir.get(dir)!; }, runStateRoot: root });
    const runtime = await tool.execute("status", { target: "runtime", view: "status" }, undefined, undefined, {});
    assert.equal(runtime.content[0].text, compactInspectDocument({ runtime: "status", version: String(runtime.details.version),
      state_schema: String(runtime.details.state_schema), automatic_review: String(runtime.details.automatic_review) }));
    assert.equal(reads, 0); assert.doesNotMatch(runtime.content[0].text, /elapsed|snapshot|^next:/mu);
    const compact = await tool.execute("runs", { target: "runtime", view: "runs", lines: "1" }, undefined, undefined, sessionAContext);
    assert.equal(compact.content[0].text, compactInspectDocument({ runtime: "runs", runs: 240 })); assert.equal(compact.details.runs.length, 240);
    assert.equal(reads, 241); assert.equal(Object.hasOwn(compact.details, "navigation"), false);
    const verbose = await tool.execute("verbose", { target: "runtime", view: "runs", lines: "1", verbose: true }, undefined, undefined, sessionAContext);
    assert.equal(reads, 482); assert.deepEqual(verbose.details.runs, compact.details.runs); assert.ok(Object.hasOwn(verbose.details, "navigation"));
    assert.equal(verbose.content[0].text, "\n" + JSON.stringify(verbose.details, null, 2));
    assert.doesNotMatch(JSON.stringify(compact), /foreign/); assert.equal(JSON.stringify(rows), before);
    const failed = { ...status, status: "failed" }, triage = createInspectToolDefinition({ listRuns: () => [failed], getRunStatus: () => failed });
    const result = await triage.execute("triage", { target: "runtime", view: "triage" }, undefined, undefined, sessionAContext);
    assert.equal(result.content[0].text, compactTriage(1, 0, 0, 0, 0, 0));
    assert.equal(result.details.failed_runs.length, 1); assert.doesNotMatch(result.content[0].text, /^- next:|^- instruction:|elapsed|snapshot/mu);
    const structured = await triage.execute("triage-json", { target: "runtime", view: "triage", verbose: true }, undefined, undefined, sessionAContext);
    assert.deepEqual(structured.details, result.details); assert.equal(structured.content[0].text, "\n" + JSON.stringify(structured.details, null, 2));
    await assert.rejects(tool.execute("missing", { target: "runtime", view: "runs" }, undefined, undefined, {}), error => (error as any).reason === "session_unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Runtime status reports immutable source package identity", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const tool = createInspectToolDefinition();
  const previous = process.env.npm_package_version;
  process.env.npm_package_version = "9.9.9-untrusted";
  try {
    const result = await tool.execute(
      "status",
      { target: "runtime", view: "status" },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.details.version, pkg.version);
    assert.equal(result.details.state_schema, "run-kernel-v1");
    assert.match(result.content[0].text, new RegExp(`version: "${pkg.version.replaceAll(".", "\\.")}"\\nstate_schema: "run-kernel-v1"`));
  } finally {
    if (previous === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = previous;
  }
});

test("Runtime status uses the canonical automatic-review policy", async () => {
  const tool = createInspectToolDefinition();
  const previous = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  try {
    for (const value of ["0", "false", "off", " OFF "]) {
      process.env.PI_ACTORS_AUTOMATIC_REVIEW = value;
      const result = await tool.execute(
        "status",
        { target: "runtime", view: "status", verbose: true },
        undefined,
        undefined,
        {},
      );
      assert.equal(result.details.automatic_review, false, value);
    }
    process.env.PI_ACTORS_AUTOMATIC_REVIEW = "on";
    const enabled = await tool.execute(
      "status-enabled",
      { target: "runtime", view: "status", verbose: true },
      undefined,
      undefined,
      {},
    );
    assert.equal(enabled.details.automatic_review, true);
  } finally {
    if (previous === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
    else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previous;
  }
});

test("Inspect reports compacted and inexact Trace history", async () => {
  const { root, status } = await fixture();
  try {
    const marker = {
      id: "marker", ts: "2026-01-01T00:00:01.000Z",
      kind: "runtime.trace_compacted", level: "warning",
      data: { version: 1, compactions_total: 2, dropped_valid_events_total: 5,
        dropped_malformed_lines_total: 1, dropped_bytes_total: 500,
        dropped_event_count_exact: false, retained_events: 1, retained_bytes: 300,
        history_complete: false },
    };
    await writeFile(join(root, "trace.jsonl"), `${JSON.stringify(marker)}\n`);
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    const trace = await tool.execute("trace", {
      target: "run:demo", view: "trace", verbose: true,
    }, undefined, undefined, sessionAContext);
    assert.deepEqual(trace.details.summary, {
      history_complete: false, compacted: true, compactions_total: 2,
      dropped_events: 5, dropped_bytes: 500, dropped_event_count_exact: false,
      retained_events: 1,
      retained_bytes: Buffer.byteLength(await readFile(join(root, "trace.jsonl"))),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Runtime triage reports stale Controls and Trace attention", async () => {
  const { root, status } = await fixture();
  try {
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify({ id: "attention-1", ts: "2026-01-01T00:00:02.000Z", kind: "checkpoint.ready", summary: "Review checkpoint", attention: "followup" })}\n`,
    );
    await writeFile(
      join(root, "controls.jsonl"),
      `${JSON.stringify({ id: "queued-1", run_instance_id: "generation-a", action: "pause", input: { apiKey: "TRIAGE_API_SECRET", note: "Bearer TRIAGE_BEARER_SECRET" }, status: "queued", queued_at: "2026-01-01T00:00:01.000Z" })}\n`,
    );
    const tool = createInspectToolDefinition({
      getRunStatus: () => status,
      listRuns: () => [status],
    });
    const result = await tool.execute(
      "triage",
      { target: "runtime", view: "triage", verbose: true },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-a" } },
    );
    assert.equal(result.details.pending_control_count, 1);
    assert.equal(result.details.pending_controls.length, 1);
    assert.equal(result.details.pending_controls[0].id, "queued-1");
    assert.equal(result.details.pending_controls[0].status, "queued");
    assert.equal(result.details.stale_control_count, 1);
    assert.equal(result.details.stale_controls.length, 1);
    assert.equal(result.details.stale_controls[0].reason, "age_threshold_reached");
    assert.equal(result.details.pending_controls[0].input.apiKey, "[REDACTED]");
    assert.match(result.details.pending_controls[0].input.note, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(result), /TRIAGE_API_SECRET|TRIAGE_BEARER_SECRET/);
    assert.equal(result.details.attention_events[0].id, "attention-1");
    assert.deepEqual(result.details.next_actions, [
      "inspect target=run:demo view=control",
      "inspect target=run:demo view=trace source=runtime",
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Runtime triage distinguishes fresh saturation from stale work", async () => {
  const { root, status } = await fixture();
  try {
    const fresh = new Date().toISOString();
    const records = [
      ...Array.from({ length: Limits.RUN_CONTROL_PENDING_LIMIT }, (_, index) => ({
        id: `fresh-${index}`,
        run_instance_id: "generation-a",
        action: "pause",
        status: "queued",
        queued_at: fresh,
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: `stale-${index}`,
        run_instance_id: "generation-a",
        action: "pause",
        status: "queued",
        queued_at: "2020-01-01T00:00:00.000Z",
      })),
    ];
    await writeFile(
      join(root, "controls.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const tool = createInspectToolDefinition({
      getRunStatus: () => status,
      listRuns: () => [status],
    });
    const result = await tool.execute(
      "triage",
      { target: "runtime", view: "triage", verbose: true },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-a" } },
    );
    assert.equal(result.details.pending_control_count, Limits.RUN_CONTROL_PENDING_LIMIT + 2);
    assert.equal(result.details.pending_controls.length, 40);
    assert.equal(result.details.stale_control_count, 2);
    assert.equal(result.details.backpressured_run_count, 1);
    assert.deepEqual(result.details.backpressured_runs, [{
      run: "demo",
      pending: Limits.RUN_CONTROL_PENDING_LIMIT + 2,
      pending_limit: Limits.RUN_CONTROL_PENDING_LIMIT,
      journal_bytes: Buffer.byteLength(await readFile(join(root, "controls.jsonl"))),
    }]);
    assert.deepEqual(result.details.next_actions, ["inspect target=run:demo view=control"]);
    const compact = await tool.execute("compact-triage", { target: "runtime", view: "triage" }, undefined, undefined, sessionAContext);
    assert.equal(compact.content[0].text, compactTriage(0, 66, 2, 1, 0, 0));
    assert.equal(compact.details.pending_controls.length, 40); assert.equal(compact.details.pending_control_count, 66);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Runtime triage filters owners and diagnoses malformed Controls without stale inflation", async () => {
  const { root, status } = await fixture();
  const foreignRoot = await mkdtemp(join(tmpdir(), "pi-actors-inspect-foreign-"));
  const foreign = {
    ...status,
    ownerId: "session-b",
    run: "foreign",
    run_instance_id: "generation-b",
    state_dir: foreignRoot,
  };
  try {
    const now = new Date().toISOString();
    await writeFile(
      join(root, "controls.jsonl"),
      [
        JSON.stringify({
          id: "delivered-1",
          run_instance_id: "generation-a",
          action: "pause",
          status: "delivered",
          queued_at: now,
          delivered_at: now,
        }),
        "{malformed",
        JSON.stringify({
          id: "bad-time",
          run_instance_id: "generation-a",
          action: "pause",
          status: "claimed",
          queued_at: now,
          delivered_at: now,
          claimed_at: "not-a-time",
        }),
      ].join("\n"),
    );
    await writeFile(
      join(foreignRoot, "controls.jsonl"),
      `${JSON.stringify({
        id: "foreign-stale",
        run_instance_id: "generation-b",
        action: "pause",
        status: "queued",
        queued_at: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const tool = createInspectToolDefinition({
      getRunStatus: (target) => target === foreignRoot ? foreign : status,
      listRuns: () => [status, foreign],
    });
    await assert.rejects(
      tool.execute(
        "triage-missing-session",
        { target: "runtime", view: "triage", verbose: true },
        undefined,
        undefined,
        {},
      ),
      /reason=session_unavailable/,
    );
    const result = await tool.execute(
      "triage",
      { target: "runtime", view: "triage", verbose: true },
      undefined,
      undefined,
      sessionAContext,
    );
    assert.deepEqual(result.details.runs.map((run: Record<string, unknown>) => run.run), ["demo"]);
    assert.equal(result.details.pending_control_count, 1);
    assert.deepEqual(result.details.pending_controls.map((control: Record<string, unknown>) => control.id), ["delivered-1"]);
    assert.equal(result.details.stale_control_count, 0);
    assert.equal(result.details.stale_controls.length, 0);
    assert.equal(result.details.backpressured_run_count, 0);
    assert.deepEqual(
      result.details.control_diagnostics.map((diagnostic: Record<string, unknown>) => diagnostic.reason).sort(),
      ["invalid_control_json", "invalid_status_timestamp"],
    );
    assert.deepEqual(result.details.next_actions, []);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(foreignRoot, { force: true, recursive: true });
  }
});

test("Inspect rejects every removed target", async () => {
  const tool = createInspectToolDefinition();
  for (const target of [
    "coordinator",
    "session:all",
    "session:demo",
    "room:demo",
    "branch:demo/worker",
    "recipe-registry",
  ]) {
    await assert.rejects(
      tool.execute("removed", { target, view: "status" }, undefined, undefined, {}),
      /unsupported inspect target/,
    );
  }
});

test("Inspect treats tools as capability definitions, not runtime actors", async () => {
  const tool = createInspectToolDefinition({
    getTool: (name) =>
      name === "demo"
        ? { description: "Demo capability", parameters: { properties: {}, required: [] } }
        : undefined,
    getToolStatus: () => ({
      active_tool: true,
      activation: "current_session",
      activation_boundary: "current_session",
      callable_now: true,
      host_registered: true,
      launch_kind: "tool",
      optional_args: ["mode"],
      persisted: true,
      registry_active: true,
      required_args: ["file"],
      source: "sample/task",
      spawn_calls: 2,
      tool_calls: 3,
    }),
  });
  const result = await tool.execute(
    "tool",
    { target: "tool:demo", view: "status" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.details.name, "demo");
  assert.equal(result.details.activation, "current_session");
  assert.equal(result.details.callable_now, true);
  assert.equal(result.details.launch_kind, "tool");
  assert.equal(result.details.spawn_calls, 2);
  assert.equal(result.details.tool_calls, 3);
  assert.equal(result.details.source, "sample/task");
  assert.deepEqual(result.details.required_args, ["file"]);
  assert.deepEqual(result.details.optional_args, ["mode"]);
  assert.equal(result.content[0].text, compactInspectDocument({ tool: "demo", source: "sample/task", callable_now: true,
    activation_boundary: "current_session", required_args: ["file"], optional_args: ["mode"], launch_kind: "tool",
    spawn_calls: 2, tool_calls: 3, next: { instruction: "call tool demo" } }));
  await assert.rejects(
    tool.execute("runtime", { target: "tool:pi-actors", view: "triage" }, undefined, undefined, {}),
    refuses(inspectDocument({ target_kind: "tool", result: "unsupported view", supported_views: ["status", "schema"] })),
  );
});

test("Inspect diagnoses registered but inactive and unknown tools without spawn substitution", async () => {
  const tool = createInspectToolDefinition({
    getTool: () => undefined,
    getToolStatus: (name) =>
      name === "dormant"
        ? {
            active_tool: false,
            activation: "unverified",
            activation_boundary: "active_tool_set",
            callable_now: false,
            host_registered: true,
            optional_args: ["mode"],
            persisted: true,
            registry_active: true,
            required_args: ["file"],
            source: "sample/task",
            spawn_calls: 1,
            tool_calls: 0,
          }
        : undefined,
  });
  const status = await tool.execute(
    "inactive-status",
    { target: "tool:dormant", view: "status" },
    undefined,
    undefined,
    {},
  );
  assert.equal(status.details.callable_now, false);
  assert.equal(status.details.activation_boundary, "active_tool_set");
  assert.equal(status.content[0].text, compactInspectDocument({ tool: "dormant", source: "sample/task", callable_now: false,
    activation_boundary: "active_tool_set", required_args: ["file"], optional_args: ["mode"], launch_kind: "none",
    spawn_calls: 1, tool_calls: 0, next: { instruction: "register_tool name=dormant update=true" } }));
  assert.doesNotMatch(status.content[0].text, /next=spawn|spawn recipe=/);
  await assert.rejects(
    tool.execute(
      "inactive-schema",
      { target: "tool:dormant", view: "schema" },
      undefined,
      undefined,
      {},
    ),
    refuses(inspectDocument({ tool: "dormant", result: "registered; callable schema unavailable", callable_now: "false",
      activation_boundary: "active_tool_set", next: { tool: "inspect", target: "tool:dormant", view: "status" } })),
  );
  await assert.rejects(
    tool.execute(
      "unknown-status",
      { target: "tool:missing", view: "status" },
      undefined,
      undefined,
      {},
    ),
    refuses(inspectDocument({ tool: "missing", result: "registered tool not found",
      safety: "Do not substitute spawn for tool invocation.", next: { tool: "inspect", target: "recipes", view: "doctor" } })),
  );
});

test("Runtime verbose navigation uses the actual session, survives a new manager and preserves legacy failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-navigation-"));
  try {
    const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
    const { registerRunStateDirectory } = await import("../lib/runs-index.ts");
    const statuses: Record<string, any>[] = [];
    for (const ownerId of ["session-a", "session-b"]) {
      const run = `owned-${ownerId}`;
      const state_dir = claimRunStateDirectory(join(root, run), run);
      const status = { run, state_dir, ownerId, run_instance_id: `generation-${run}`, status: "done", pid: 0 };
      await writeFile(join(state_dir, "run.json"), JSON.stringify(status));
      registerRunStateDirectory(root, state_dir, status); statuses.push(status);
    }
    const tool = createInspectToolDefinition({ runStateRoot: root, listRuns: () => statuses,
      getRunStatus: path => statuses.find(row => row.state_dir === path)! });
    for (const ctx of [{ sessionManager: { getSessionId: () => "session-a" } }, { sessionManager: { getSessionId: () => "session-a" } }]) {
      const reply = await tool.execute("map", { target: "runtime", view: "runs", verbose: true, owner_session: "session-b" }, undefined, undefined, ctx);
      assert.equal(reply.details.navigation.state, "available");
      assert.deepEqual(reply.details.navigation.items.map((item: any) => item.run), ["owned-session-a"]);
      assert.doesNotMatch(reply.content[0].text, /owned-session-b/);
    }
    const compact = await tool.execute("compact", { target: "runtime", view: "runs" }, undefined, undefined,
      { sessionManager: { getSessionId: () => "session-a" } });
    assert.equal(Object.hasOwn(compact.details, "navigation"), false);
    await writeFile(join(root, "index.json"), "{broken");
    const unavailable = await tool.execute("missing", { target: "runtime", view: "runs", verbose: true }, undefined, undefined,
      { sessionManager: { getSessionId: () => "session-a" } });
    assert.equal(unavailable.details.runs.length, 1);
    assert.deepEqual(unavailable.details.navigation, { state: "unavailable", reason: "catalog_unavailable" });
    assert.equal(await readFile(join(root, "index.json"), "utf8"), "{broken");
    let selected = "session-a";
    const switching = createInspectToolDefinition({ runStateRoot: root, listRuns: () => { selected = "session-b"; return statuses; },
      getRunStatus: path => statuses.find(row => row.state_dir === path)! });
    await assert.rejects(switching.execute("switch", { target: "runtime", view: "runs", verbose: true }, undefined, undefined,
      { sessionManager: { getSessionId: () => selected } }), (error: any) => error.reason === "session_mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Runtime verbose navigation uses failed investigation for projection only and reuses exact observed rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-priority-"));
  try {
    const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
    const { registerRunStateDirectory } = await import("../lib/runs-index.ts");
    const rows: Record<string, any>[] = [];
    for (const [run, status, parent] of [["older", "done", undefined], ["failed-child", "failed", "older"], ["latest", "done", undefined]]) {
      const state_dir = claimRunStateDirectory(join(root, run!), run!);
      const row = { run, state_dir, run_instance_id: `generation-${run}`, ownerId: "session-a", status,
        ...(parent ? { delivery_parent: { run: parent, run_instance_id: `generation-${parent}`, state_dir: join(root, parent) } } : {}) };
      await writeFile(join(state_dir, "run.json"), JSON.stringify(row)); registerRunStateDirectory(root, state_dir, { ...row, status: "running" }); rows.push(row);
    }
    const before = await readFile(join(root, "index.json"));
    let failedOnly = false, mismatched = false, unavailable = false; const observations: string[] = [];
    const tool = createInspectToolDefinition({ runStateRoot: root, listRuns: () => failedOnly ? rows.filter(row => row.status === "failed") : rows,
      getRunStatus: directory => { observations.push(directory); if (unavailable) throw Error("Current status unavailable"); const row = rows.find(row => row.state_dir === directory)!;
        return mismatched ? { ...row, run_instance_id: "stale-generation" } : row; } });
    const ctx = { sessionManager: { getSessionId: () => "session-a" } };
    const normal = await tool.execute("normal", { target: "runtime", view: "runs", verbose: true, root_order: "failed_subtrees_first" }, undefined, undefined, ctx);
    assert.equal(observations.length, 3); assert.deepEqual(normal.details.navigation.items.map((row: any) => row.run), ["latest", "older", "failed-child"]);
    assert.equal(normal.details.navigation.priority.root_order, "latest_registration");
    failedOnly = true; observations.length = 0;
    const focused = await tool.execute("failed", { target: "runtime", view: "runs", verbose: true, status: "failed" }, undefined, undefined, ctx);
    assert.deepEqual(observations, [rows[1].state_dir]); assert.deepEqual(focused.details.runs.map((row: any) => row.run), ["failed-child"]);
    assert.deepEqual(focused.details.navigation.items.map((row: any) => row.run), ["older", "failed-child", "latest"]);
    assert.deepEqual(focused.details.navigation.priority, { root_order: "failed_subtrees_first", basis: "observed_failed_rows" });
    mismatched = true; observations.length = 0;
    const stale = await tool.execute("stale", { target: "runtime", view: "runs", verbose: true, status: "failed" }, undefined, undefined, ctx);
    assert.equal(observations.length, 1); assert.deepEqual(stale.details.navigation.items.map((row: any) => row.run), ["latest", "older", "failed-child"]);
    mismatched = false; unavailable = true; observations.length = 0;
    const missing = await tool.execute("unavailable", { target: "runtime", view: "runs", verbose: true, status: "failed" }, undefined, undefined, ctx);
    assert.equal(observations.length, 1); assert.equal(missing.details.runs[0].status, "failed"); // Preserve legacy injected inventory fallback, not its ranking authority.
    assert.deepEqual(missing.details.navigation.items.map((row: any) => row.run), ["latest", "older", "failed-child"]);
    const compact = await tool.execute("compact", { target: "runtime", view: "runs", status: "failed" }, undefined, undefined, ctx);
    assert.equal(Object.hasOwn(compact.details, "navigation"), false); assert.deepEqual(await readFile(join(root, "index.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Inspect schema documents kernel targets, focused Recipe identity, and Trace source", () => {
  const tool = createInspectToolDefinition();
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "identity",
    "lines",
    "source",
    "status",
    "target",
    "verbose",
    "view",
  ]);
  assert.match(tool.description, /Recipe, Trace, or Control/);
});
