import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as Limits from "../lib/limits.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";
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
      /supports view=recipe, view=trace, or view=control/,
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
    assert.match(compactCatalog.content[0].text, /skill_catalog_partial=true/);
    assert.match(
      compactCatalog.content[0].text,
      /next=inspect_target=recipes_view=imports_verbose=true/,
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
    assert.match(
      focused.content[0].text,
      /identity=sample\/task skill_active=true resolvable=true catalog_partial=true component_status=available/,
    );
    assert.doesNotMatch(focused.content[0].text, new RegExp(root));

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
      /identity is supported only with view=doctor/,
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
  assert.match(
    result.content[0].text,
    /tool=demo source=sample\/task callable_now=true activation_boundary=current_session required=file optional=mode launch_kind=tool spawn_calls=2 tool_calls=3/,
  );
  await assert.rejects(
    tool.execute("runtime", { target: "tool:pi-actors", view: "triage" }, undefined, undefined, {}),
    /supports view=status or view=schema/,
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
  assert.match(
    status.content[0].text,
    /tool=dormant source=sample\/task callable_now=false activation_boundary=active_tool_set.*next=register_tool name=dormant update=true/,
  );
  assert.doesNotMatch(status.content[0].text, /next=spawn|spawn recipe=/);
  await assert.rejects(
    tool.execute(
      "inactive-schema",
      { target: "tool:dormant", view: "schema" },
      undefined,
      undefined,
      {},
    ),
    /registered but its callable schema is unavailable; callable_now=false, activation_boundary=active_tool_set.*Next: inspect target=tool:dormant view=status/s,
  );
  await assert.rejects(
    tool.execute(
      "unknown-status",
      { target: "tool:missing", view: "status" },
      undefined,
      undefined,
      {},
    ),
    /Registered tool not found: missing.*Next: inspect target=recipes view=doctor; do not substitute spawn/s,
  );
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
