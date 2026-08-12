import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as Limits from "../lib/limits.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";

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
        file: "/recipes/demo.json",
        import_path: [],
        name: "demo-recipe",
        recipe: { control: ["pause"], template: "echo demo" },
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

test("Inspect exposes canonical Run Recipe, Trace, and Control views", async () => {
  const { root, status } = await fixture();
  try {
    const tool = createInspectToolDefinition({ getRunStatus: () => status });
    const recipe = await tool.execute("recipe", { target: "run:demo", view: "recipe", verbose: true }, undefined, undefined, {});
    assert.equal(recipe.details.identity.recipe, "demo-recipe");
    const trace = await tool.execute("trace", { target: "run:demo", view: "trace", source: "lifecycle", verbose: true }, undefined, undefined, {});
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
    const control = await tool.execute("control", { target: "run:demo", view: "control", verbose: true }, undefined, undefined, {});
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
      {},
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
    }, undefined, undefined, {});
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
      tool.execute("status", { target: "run:demo", view: "status" }, undefined, undefined, {}),
      /supports view=recipe, view=trace, or view=control/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
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
    assert.match(result.content[0].text, new RegExp(`version=${pkg.version} state_schema=run-kernel-v1`));
  } finally {
    if (previous === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = previous;
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
    }, undefined, undefined, {});
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
    const result = await tool.execute(
      "triage",
      { target: "runtime", view: "triage", verbose: true },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-a" } },
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
  });
  const result = await tool.execute(
    "tool",
    { target: "tool:demo", view: "status", verbose: true },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.details.name, "demo");
  await assert.rejects(
    tool.execute("runtime", { target: "tool:pi-actors", view: "triage" }, undefined, undefined, {}),
    /supports view=status or view=schema/,
  );
});

test("Inspect schema documents only kernel targets and Trace source", () => {
  const tool = createInspectToolDefinition();
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "lines",
    "source",
    "status",
    "target",
    "verbose",
    "view",
  ]);
  assert.match(tool.description, /Recipe, Trace, or Control/);
});
