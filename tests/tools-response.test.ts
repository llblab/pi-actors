import "./test-environment.mjs";

import assert from "node:assert/strict";
import test from "node:test";
import { Document, parseDocument, isAlias, isCollection, isNode, visit } from "yaml";
import { renderYamlMetadata } from "../lib/tools-response.ts";

import {
  compactAsyncRunStatus,
  compactRecipeRegistry,
  compactYamlDocument,
  frameMetadataDocument,
  formatYamlNotice,
  formatInspectionHint,
  formatInspectNextAction,
  formatMarkdownField,
  nextActionMetadata,
  growYamlDocument,
  selectYamlField,
  selectYamlNode,
  formatRunFileNavigationHandoff,
  maybeJsonText,
  runNextActions,
  spaceToolError,
  spaceToolResult,
  spawnMetadataText,
  withLeadingLineBreak,
} from "../lib/tools-response.ts";

test("Whole YAML nodes and string groups fit from omission seeds or fail explicitly without undefined text", () => {
  for (const values of [["file"], Array.from({ length: 1600 }, (_, i) => "input_" + i), ["\ud800"]]) {
    const part = selectYamlField("args", values, 16384);
    const text = growYamlDocument(() => ({ tool: "demo", ...part.selected }), [part], 16384);
    const doc = parseDocument(text); assert.deepEqual(doc.errors, []);
    const value = doc.toJS(); assert.ok(Buffer.byteLength(text) <= 16384);
    if (values.length > 1) {
      assert.equal(value.args, "[omitted]"); assert.equal(value.args_omission.total, values.length);
    } else if (!values[0].isWellFormed()) {
      assert.equal(value.args, "[unavailable]"); assert.equal(value.args_omission.reason, "malformed_selected_text");
    } else assert.deepEqual(value.args, values);
  }
  const action = selectYamlNode("next", { tool: "actors_inspect", target: "run:" + "x".repeat(17000), view: "trace" }, 16384);
  const document = parseDocument(growYamlDocument(() => ({ run: "demo", ...action.selected }), [action], 16384)).toJS();
  assert.equal(document.next, "[omitted]"); assert.equal(document.next_omission.total, 1);
  for (const invalid of [{ selected: undefined }, { selected: "x".repeat(17000) }]) {
    assert.throws(() => growYamlDocument(() => invalid, [], 16384), /Selected YAML metadata document is unavailable:/);
    assert.throws(() => compactYamlDocument(invalid), /Selected YAML metadata document is unavailable:/);
  }
});

test("UI YAML notices keep uncapped well-formed fields and explicitly withhold malformed text", () => {
  const diagnostic = "notice · ".repeat(12000);
  const text = formatYamlNotice({ result: "failed", diagnostic, count: 2 });
  const doc = parseDocument(text); assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.toJS(), { result: "failed", diagnostic, count: 2 });
  assert.ok(Buffer.byteLength(text) > 49152); assert.equal(text.endsWith("\n"), false);
  assert.deepEqual(parseDocument(formatYamlNotice({ diagnostic: "\ud800" })).toJS(), {
    diagnostic: "[unavailable]", diagnostic_omission: { reason: "malformed_selected_text", shown: 0, omitted: 1, total: 1 },
  });
});

test("AX document framing keeps exactly one host-separation blank line", () => {
  // Every migrated model-facing document starts with exactly one LF; no emitter may add a second.
  for (const text of [withLeadingLineBreak("field: 1"), withLeadingLineBreak("\n\nfield: 1"),
    compactYamlDocument({ field: 1 }), compactYamlDocument({ field: 1, list: ["a"] })]) {
    assert.ok(text.startsWith("\n"));
    assert.equal(text.startsWith("\n\n"), false);
  }
  assert.equal(withLeadingLineBreak("\n\nfield: 1"), "\nfield: 1");
  assert.equal(compactYamlDocument({ field: 1 }), "\nfield: 1");
  // A separate opaque body is introduced by exactly one delimiter pair; metadata-only stays bare.
  assert.equal(frameMetadataDocument("field: 1\n", "body"), "---\nfield: 1\n---\nbody");
  assert.equal(frameMetadataDocument("field: 1\n"), "field: 1\n");
  // The shared error adapter normalizes any pre-existing leading newlines to one.
  const error = new Error("\n\nfield: 1");
  assert.equal(spaceToolError(error), error);
  assert.equal(error.message, "\nfield: 1");
});

test("AX registry records select one read-only hint or opaque instruction without rewriting facts", () => {
  const actions = ["actors_inspect target=recipes view=imports verbose=true", "actors_run_spawn file=/not/automatically/run.json"];
  const summary = Object.freeze({ active: Object.freeze([{ current_policy: true }, {}]), drafts: Object.freeze([{}]), shadowed: Object.freeze([]),
    invalid: Object.freeze([{}]), disabled: Object.freeze([]), diagnostics: Object.freeze([{}]), recommendations: Object.freeze([{}]),
    skill_recipe_catalog_partial: true, next_actions: Object.freeze(actions) });
  const before = JSON.stringify(summary), text = compactRecipeRegistry(summary);
  assert.equal(text, [
    "", 'recipes: "registry"', "active: 2", "drafts: 1", "retained: 0", "shadowed: 0", "invalid: 1", "disabled: 0",
    "current_policy: 1", "skill_catalog_partial: true", "recommendations: 1", "diagnostics: 1",
    "next:", '  tool: "actors_inspect"', '  target: "recipes"', '  view: "imports"', "  verbose: true",
  ].join("\n"));
  assert.equal(JSON.stringify(summary), before); assert.deepEqual(JSON.parse(maybeJsonText(summary, true, text)), summary);
  for (const [action, view, verbose] of [["actors_inspect target=recipes view=doctor", "doctor", false], ["actors_inspect target=recipes view=summary verbose=true", "summary", true]] as const) {
    const value = compactRecipeRegistry({ next_actions: [action] });
    assert.ok(value.endsWith('next:\n  tool: "actors_inspect"\n  target: "recipes"\n  view: "' + view + '"' + (verbose ? "\n  verbose: true" : "")));
  }
  const advisory = "## Advice\r\n\r\n- tool: authored content · kept\n  - Nested";
  const content = compactRecipeRegistry({ next_actions: [advisory, actions[0]] });
  assert.ok(content.endsWith('next:\n  instruction: ' + JSON.stringify(advisory)));
  assert.doesNotMatch(content, /^next: |^tool: |inspect_target=/mu);
  const hostile = "actors_inspect target=recipes view=doctor\n- next: fake";
  assert.ok(compactRecipeRegistry({ next_actions: [hostile] }).includes('instruction: ' + JSON.stringify(hostile)));
  assert.doesNotMatch(compactRecipeRegistry({}), /next:|instruction:/mu);
  for (const [action, view, verbose] of [
    ["actors_inspect target=recipes view=doctor", "doctor", undefined],
    ["actors_inspect target=recipes view=imports verbose=true", "imports", true],
    ["actors_inspect target=recipes view=summary verbose=true", "summary", true],
  ] as const) {
    const expected = { next: { tool: "actors_inspect", target: "recipes", view, ...(verbose ? { verbose } : {}) } };
    const metadata = nextActionMetadata(action, 32);
    assert.deepEqual(metadata.full, expected); assert.equal(metadata.selected, metadata.full);
    assert.equal(formatInspectionHint(action), formatInspectNextAction("recipes", view, verbose, "actors_inspect"));
  }
  for (const action of ["", advisory, hostile, " actors_inspect target=recipes view=doctor",
    "actors_inspect target=recipes view=doctor ", "INSPECT target=recipes view=doctor",
    "actors_inspect target=recipes view=summary", "actors_inspect target=recipes view=imports verbose=false",
    "actors_inspect target=tool:demo view=status", "actors_inspect target=recipes view=doctor; actors_tool_register name=demo",
    "actors_inspect target=recipes view=doctor\r\n", "界👩‍💻".repeat(200), "\ud800"]) {
    for (const budget of [32, 16384]) {
      const instruction = selectYamlField("instruction", action, budget);
      assert.deepEqual(nextActionMetadata(action, budget), {
        full: { next: instruction.full }, selected: { next: instruction.selected },
      });
    }
    assert.equal(formatInspectionHint(action), formatMarkdownField("instruction", action));
  }
  const whole = "actors_run_spawn file=/owned/" + "directory/".repeat(2000) + "result.json";
  // An oversized opaque instruction is omitted whole rather than clipped or emitted past the shared budget.
  assert.ok(compactRecipeRegistry({ next_actions: [whole] }).endsWith([
    "next:", '  instruction: "[omitted]"', "  instruction_omission:", '    reason: "response_too_large"',
    "    shown: 0", "    omitted: 1", "    total: 1",
  ].join("\n")));
});

function launchMetadata(text: string): Record<string, any> {
  assert.ok(text.startsWith("\n") && !text.startsWith("\n\n"));
  assert.ok(text.endsWith("\n"));
  assert.doesNotMatch(text.slice(1), /^(?:---|```|- run:)/u);
  assert.ok(Buffer.byteLength(text) <= 16384);
  const document = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  assert.equal(Array.isArray(document.toJS()), false);
  return document.toJS();
}

const launchHint = { tool: "actors_inspect", target: "runtime", view: "runs", verbose: true };
const omittedLaunchRow = { state: "omitted", reason: "response_too_large", shown: 0, omitted: 1, total: 1 };

test("Compact launch metadata is a native YAML mapping", () => {
  const text = compactAsyncRunStatus({ run: "demo", status: "running", pid: 123 });
  const document = parseDocument(text, { version: "1.2", schema: "core" });
  assert.deepEqual(document.errors, []);
  assert.equal(Array.isArray(document.toJS()), false);
  assert.equal(document.toJS().pid, 123);
});

test("AX launch records preserve flat facts, opaque values and the frozen completion handoff grammar", () => {
  const value = Object.freeze({ run: "demo", status: "running", launch_kind: "tool", reused: true, tool: "worker", pid: 123,
    recipe: "## Recipe\r\n- next: authored content", model_policy: Object.freeze({ model: Object.freeze({ source: "inherited", value: "provider/model" }), thinking: Object.freeze({ source: "unused" }) }) });
  const before = JSON.stringify(value), text = compactAsyncRunStatus(value);
  assert.deepEqual(launchMetadata(text), { run: "demo", state: "running", launch_kind: "tool", launch: "existing Run reused",
    model: { source: "inherited", value: "provider/model" }, tool: "worker", recipe: value.recipe, pid: 123,
    file_investigation: "optional; current session", next: launchHint });
  assert.equal(JSON.stringify(value), before); assert.deepEqual(JSON.parse(maybeJsonText(value, true, text)), value);
  assert.equal(compactAsyncRunStatus({ ...value, run: "run:demo" }), text, "Labeled display removes only the redundant Run namespace");
  assert.doesNotMatch(text, /run: run:|run=|status=| · |model_policy|thinking_policy|^- thinking:|completion=/m);
  const thinkingOnly = { ...value, model_policy: { model: { source: "unused" }, thinking: { source: "explicit", value: "off" } } };
  const thinkingText = compactAsyncRunStatus(thinkingOnly);
  assert.deepEqual(launchMetadata(thinkingText).thinking, { source: "explicit", value: "off" });
  assert.equal(launchMetadata(thinkingText).model, undefined);
  assert.doesNotMatch(thinkingText, /^- (?:model|model_policy|thinking_policy):/m);
  assert.deepEqual(JSON.parse(maybeJsonText(thinkingOnly, true, thinkingText)), thinkingOnly);
  assert.equal(formatRunFileNavigationHandoff(), "Files (optional; current session):\n`inspect target=runtime view=runs verbose=true`", "Shared old packet helper must not silently acquire the new launch format");
  const crowded = compactAsyncRunStatus({ ...value, recipe: "x".repeat(20000) });
  const crowdedFields = launchMetadata(crowded);
  assert.equal(crowdedFields.launch_fields, "omitted");
  assert.equal(crowdedFields.run, "demo"); assert.equal(crowdedFields.launch, "existing Run reused");
  assert.deepEqual(crowdedFields.next, launchHint);
});

test("A complete direct launch row needs no redundant session-wide map instruction", () => {
  const file_navigation = { state: "available", content_scope: "file_locations_only", run: "demo", run_instance_id: "generation-A",
    directory: "/owned/demo", files: [{ role: "metadata", state: "present", path: "/owned/demo/run.json", mutable: true }] };
  const value = { run: "demo", status: "running", launch_kind: "spawn", file_navigation };
  const text = compactAsyncRunStatus(value);
  assert.deepEqual(launchMetadata(text).run_files, { directory: "/owned/demo", metadata: "/owned/demo/run.json" });
  assert.equal(launchMetadata(text).next, undefined);
  assert.doesNotMatch(text, /file_investigation:|^next:/m);
  assert.ok(Buffer.byteLength(text) <= 16384);
  const base = { ...value, file_navigation: { ...file_navigation, directory: "" } };
  const padding = 16384 - Buffer.byteLength(compactAsyncRunStatus(base));
  const exact = compactAsyncRunStatus({ ...base, file_navigation: { ...base.file_navigation, directory: "x".repeat(padding) } });
  assert.equal(Buffer.byteLength(exact), 16384);
  assert.deepEqual(launchMetadata(exact).run_files, { directory: "x".repeat(padding), metadata: "/owned/demo/run.json" });
  assert.doesNotMatch(exact, /file_investigation:|state: omitted/);
  const over = compactAsyncRunStatus({ ...base, file_navigation: { ...base.file_navigation, directory: "x".repeat(padding + 1) } });
  assert.deepEqual(launchMetadata(over).run_files, omittedLaunchRow);
  assert.deepEqual(launchMetadata(over).next, launchHint);
});

test("A reused launch is explicit without claiming another Run was started", () => {
  const fresh = compactAsyncRunStatus({ run: "demo", status: "running", launch_kind: "spawn" });
  const reused = compactAsyncRunStatus({ run: "demo", status: "running", launch_kind: "spawn", reused: true });
  assert.match(reused, /existing Run reused/);
  assert.doesNotMatch(fresh, /reused/);
  assert.doesNotMatch(reused, /new Run|restarted|new generation|completion=/);
  const crowded = compactAsyncRunStatus({ run: "demo", run_instance_id: "generation-A", status: "running", reused: true, recipe: "x".repeat(16384), file_navigation: { state: "available" } });
  assert.equal(launchMetadata(crowded).launch_fields, "omitted");
  assert.equal(launchMetadata(crowded).launch, "existing Run reused");
  assert.ok(Buffer.byteLength(crowded) <= 16384);
});

test("Compact launch receipts hand off optional current-session file investigation while preserving spawn/tool and expert facts", () => {
  for (const launch_kind of ["spawn", "tool"]) {
    for (const status of ["running", "done", "failed", "killed"]) {
      const value = { run: "receipt-demo", status, launch_kind, pid: 123, tool: launch_kind === "tool" ? "worker" : undefined,
        next_actions: runNextActions("receipt-demo"), result: { code: status === "failed" ? 1 : 0 },
        progress: { phase: "observed", completed: 2, activeSubagents: 1, failures: ["reported"] } };
      const compact = compactAsyncRunStatus(value);
      const metadata = launchMetadata(compact);
      assert.equal(metadata.run, "receipt-demo");
      for (const [key, expected] of Object.entries({ state: status, launch_kind, pid: 123, phase: "observed", completed: 2, active_subagents: 1, failures: 1, code: status === "failed" ? 1 : 0 })) assert.equal(metadata[key], expected);
      assert.doesNotMatch(compact, /next=|view[:=] ?recipe|view[:=] ?trace|view[:=] ?control|completion=|outcome=/);
      assert.deepEqual(metadata.next, launchHint);
      assert.equal(metadata.file_investigation, "optional; current session");
      const verbose = JSON.parse(maybeJsonText(value, true, compact));
      assert.deepEqual(verbose.next_actions, ["actors_inspect target=run:receipt-demo view=recipe", "actors_inspect target=run:receipt-demo view=trace", "actors_inspect target=run:receipt-demo view=control", "actors_inspect target=runtime view=runs verbose=true"]);
      assert.equal(verbose.launch_kind, launch_kind); assert.equal(verbose.pid, 123);
    }
  }
  assert.deepEqual(runNextActions(""), []);
});

test("Compact launch receipts carry complete literal observed file locations within their shared budget", () => {
  const file_navigation = { state: "available", content_scope: "file_locations_only", file_inventory_scope: "canonical_starting_locations",
    run: "direct", run_instance_id: "generation-1", directory: "/owned/β\u0060\u0060\u0060\u0060",
    files: [{ role: "metadata", format_hint: "json", state: "present", path: "/owned/β/run.json", bytes_total: 12, mutable: true }] };
  const value = { run: "direct", status: "running", launch_kind: "spawn", file_navigation };
  const text = compactAsyncRunStatus(value);
  assert.equal(launchMetadata(text).run_files_observation, undefined);
  assert.deepEqual(launchMetadata(text).run_files, { directory: file_navigation.directory, metadata: "/owned/β/run.json" });
  assert.doesNotMatch(text, /format_hint:|purpose:|run_instance_id:|mutable:|bytes_total:|content_scope:|file_inventory_scope:/);
  assert.equal(Buffer.byteLength(text) <= 16384, true);
  const large = compactAsyncRunStatus({ ...value, file_navigation: { ...file_navigation, directory: "😀".repeat(16384) } });
  assert.deepEqual(launchMetadata(large).run_files, omittedLaunchRow);
  assert.ok(!large.includes("😀")); assert.ok(Buffer.byteLength(large) <= 16384);
  assert.deepEqual(launchMetadata(large).next, launchHint);
  const crowded = compactAsyncRunStatus({ ...value, recipe: "x".repeat(16300) });
  assert.equal(launchMetadata(crowded).run, "direct");
  assert.equal(launchMetadata(crowded).launch_fields, "omitted"); assert.ok(!crowded.includes("/owned"));
  const refused = compactAsyncRunStatus({ ...value, file_navigation: { state: "unavailable", reason: "session_changed" } });
  assert.equal(launchMetadata(refused).run_files.reason, "session_changed"); assert.ok(!refused.includes("/owned"));
});

test("Compact launch selects useful paths and preserves unavailable observations without optional-file noise", () => {
  const files = [
    { role: "metadata", state: "present", path: "/owned/run.json", format_hint: "json", bytes_total: 10, mutable: true },
    { role: "result", state: "missing", path: null, format_hint: "json", mutable: true },
    { role: "stderr", state: "missing", path: null, format_hint: "text", mutable: true },
    { role: "published_sessions", state: "unavailable", path: null, format_hint: "json", mutable: true },
  ];
  const value = { run: "selected", status: "failed", file_navigation: { state: "available", directory: "/owned", files } };
  const before = JSON.stringify(value), text = compactAsyncRunStatus(value);
  assert.deepEqual(launchMetadata(text).run_files, { directory: "/owned", metadata: "/owned/run.json", status: "Unavailable locations: published_sessions; Recorded result location missing" });
  assert.equal(launchMetadata(text).state, "failed");
  assert.doesNotMatch(text, /stderr|path: null|format_hint:|bytes_total:|mutable:/);
  assert.equal(JSON.stringify(value), before);
});

test("Compact launch native scalars, literal locations, privacy and wrapper spacing remain selected", () => {
  const path = " /owned/β😀/`file`\n---\r\n- next: literal \t";
  const navigation = Object.freeze({ state: "available", directory: path,
    files: Object.freeze([Object.freeze({ filename: "?", path, bytes_total: 12, mutable: true })]),
    nested: Object.freeze({ ["__proto__"]: Object.freeze({ path }), ["a\nb"]: "?" }) });
  const value = Object.freeze({ run: "run:run:demo", status: "running", pid: "123", file_navigation: navigation,
    progress: Object.freeze({ activeSubagents: "2", completed: 3, failures: Object.freeze(["failure"]) }),
    result: Object.freeze({ code: 0, killed: true }), draft_recipe: "?", private_unselected: { secret: "not disclosed" },
    catalog_registration: { state: "unavailable", reason: "catalog_registration_failed" } });
  const before = JSON.stringify(value), text = compactAsyncRunStatus(value), metadata = launchMetadata(text);
  assert.equal(metadata.run, "run:demo"); assert.equal(metadata.pid, 123);
  assert.equal(metadata.active_subagents, 2); assert.equal(metadata.completed, 3); assert.equal(metadata.failures, 1);
  assert.equal(metadata.code, 0); assert.equal(metadata.killed, true); assert.equal(metadata.draft_recipe, "?");
  assert.equal(metadata.catalog, "unavailable"); assert.deepEqual(metadata.run_files, { directory: path });
  assert.equal(metadata.next, undefined); assert.equal(metadata.file_investigation, undefined);
  assert.doesNotMatch(text, /not disclosed|```|^---|\{"state"/mu);
  assert.match(text, /^\nrun:/u); assert.match(text, /draft_recipe: "\?"/u);
  assert.equal(JSON.stringify(value), before);
  assert.equal(withLeadingLineBreak(text), text);
  const wrapped = spaceToolResult({ content: [{ type: "text", text }], details: value });
  assert.equal(wrapped.content[0].text, text); assert.equal(wrapped.details, value);
  assert.deepEqual(spaceToolResult(wrapped), wrapped);
  assert.ok(`header\n${text}`.startsWith('header\n\nrun:'));
  for (const file_navigation of [null, { state: "unavailable", reason: "session_changed" }]) {
    assert.deepEqual(launchMetadata(compactAsyncRunStatus({ run: "demo", file_navigation })).next, launchHint);
  }
});

test("Compact launch encoded boundary includes escapes, UTF-8, final newline and one boundary LF", () => {
  for (const prefix of ["😀β\\\"\t\r\n", "x"]) {
    const base = { run: "demo", status: "running", file_navigation: { state: "available", directory: prefix } };
    const padding = 16384 - Buffer.byteLength(compactAsyncRunStatus(base));
    const directory = prefix + "x".repeat(padding);
    const exact = compactAsyncRunStatus({ ...base, file_navigation: { ...base.file_navigation, directory } });
    assert.equal(Buffer.byteLength(exact), 16384);
    assert.equal(launchMetadata(exact).run_files.directory, directory);
    assert.equal(launchMetadata(exact).next, undefined);
    const over = launchMetadata(compactAsyncRunStatus({ ...base, file_navigation: { ...base.file_navigation, directory: directory + "x" } }));
    assert.deepEqual(over.run_files, omittedLaunchRow); assert.deepEqual(over.next, launchHint);
  }
  const extreme = launchMetadata(compactAsyncRunStatus({ run: "😀".repeat(20000), status: "x".repeat(20000),
    reused: true, run_instance_id: "x".repeat(20000), pid: 123, file_navigation: { state: "available", directory: "x".repeat(20000) } }));
  assert.equal(extreme.launch_fields, "omitted"); assert.equal(extreme.run, undefined);
  assert.deepEqual(extreme.run_files, omittedLaunchRow); assert.deepEqual(extreme.next, launchHint);
});

test("Compact launch refuses whole malformed selected values and keeps ordinary JSON navigation selection", () => {
  const unavailable = { state: "unavailable", reason: "metadata_invalid" };
  for (const directory of ["\uD800", "prefix\uDC00tail"]) {
    const metadata = launchMetadata(compactAsyncRunStatus({ run: "demo", file_navigation: { state: "available", directory } }));
    assert.deepEqual(metadata.run_files, unavailable); assert.deepEqual(metadata.next, launchHint);
    assert.doesNotMatch(JSON.stringify(metadata), /prefix|tail|\uFFFD/u);
  }
  assert.deepEqual(launchMetadata(compactAsyncRunStatus({ run: "\uD800", recipe: "\uDC00" })).run, unavailable);
  assert.deepEqual(launchMetadata(compactAsyncRunStatus({ run: "demo", recipe: "\uDC00" })).recipe, unavailable);
  const jsonNavigation = { state: "available", absent: undefined, number: Infinity, date: new Date("2026-01-01T00:00:00.000Z"), list: [undefined, NaN, -0] };
  assert.deepEqual(launchMetadata(compactAsyncRunStatus({ file_navigation: jsonNavigation })).run_files, JSON.parse(JSON.stringify(jsonNavigation)));
  let deep: unknown = {};
  for (let i = 0; i < 70; i++) deep = { child: deep };
  const refused = launchMetadata(compactAsyncRunStatus({ file_navigation: { state: "available", deep } }));
  assert.deepEqual(refused.run_files, unavailable); assert.deepEqual(refused.next, launchHint);
});

test("Compact launch observes selected getters and JSON hooks once in the existing order, preserving exact errors", () => {
  const observed: string[] = [];
  const numeric = { valueOf() { observed.push("number"); return 123; } };
  const navigation = { state: "available", toJSON() { observed.push("toJSON"); return { state: "available", directory: "/exact" }; } };
  const value = {
    get progress() { observed.push("progress"); return {}; },
    get result() { observed.push("result"); return {}; },
    get run() { observed.push("run"); return "demo"; },
    get pid() { observed.push("pid"); return numeric; },
    get file_navigation() { observed.push("navigation"); return navigation; },
    get private_unselected() { throw new Error("private read"); },
  };
  const text = compactAsyncRunStatus(value);
  assert.deepEqual(observed, ["progress", "result", "run", "pid", "number", "pid", "number", "navigation", "toJSON", "navigation"]);
  assert.equal(launchMetadata(text).run_files.directory, "/exact");
  let hooks = 0;
  const failure = { private: "cause" };
  assert.throws(() => compactAsyncRunStatus({ file_navigation: { toJSON() { hooks++; throw failure; } } }), error => error === failure);
  assert.equal(hooks, 1);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => compactAsyncRunStatus({ file_navigation: cycle }), TypeError);
  assert.throws(() => compactAsyncRunStatus({ file_navigation: { x: 1n } }), TypeError);
  assert.throws(() => compactAsyncRunStatus({ file_navigation: { toJSON() { return undefined; } } }), TypeError);
  let compactHooks = 0;
  const verboseValue = { run: "demo", file_navigation: { state: "available", toJSON() { compactHooks++; return { state: "available" }; } } };
  const compact = compactAsyncRunStatus(verboseValue);
  assert.equal(compactHooks, 1);
  const verbose = maybeJsonText(verboseValue, true, compact);
  assert.equal(compactHooks, 2); assert.ok(verbose.startsWith("\n{"));
  assert.deepEqual(JSON.parse(verbose), { run: "demo", file_navigation: { state: "available" } });
});

test("Compact policy and fallback retain observation order without adopting unsupported selected objects", () => {
  const observed: string[] = [];
  const axis = {
    get source() { observed.push("source"); return "explicit"; },
    get value() { observed.push("value"); return " model "; },
  };
  const status = {
    run: "demo", reused: true, recipe: "x".repeat(20000), model_policy: { model: axis },
    get run_instance_id() { observed.push("generation"); return "generation-A"; },
    get pid() { observed.push("pid"); return 123; },
  };
  const metadata = launchMetadata(compactAsyncRunStatus(status));
  assert.deepEqual(observed, ["source", "source", "source", "source", "value", "value", "value", "pid", "pid", "generation", "generation", "pid", "pid"]);
  assert.equal(metadata.launch, "existing Run reused"); assert.equal(metadata.run_instance_id, "generation-A"); assert.equal(metadata.pid, 123);
  assert.deepEqual(metadata.next, launchHint);
  const model = launchMetadata(compactAsyncRunStatus({ model_policy: { model: { source: "explicit", value: " model " }, thinking: { source: "unused", value: "not selected" } } }));
  assert.deepEqual(model.model, { source: "explicit", value: "model" }); assert.equal(model.thinking, undefined);
  const malformed = launchMetadata(compactAsyncRunStatus({ model_policy: { model: { source: "explicit", value: "\uD800" } } }));
  assert.deepEqual(malformed.model, { state: "unavailable", reason: "metadata_invalid" });
  let reads = 0;
  const unstable = { get source() { reads++; return reads < 4 ? "explicit" : Symbol("unsupported"); } };
  assert.throws(() => compactAsyncRunStatus({ model_policy: { model: unstable } }), TypeError);
  assert.equal(reads, 4);
  const unavailable = launchMetadata(compactAsyncRunStatus({ file_navigation: { state: "available", toJSON() { return { state: "unavailable", reason: "selected_unavailable" }; } } }));
  assert.deepEqual(unavailable.next, launchHint); assert.equal(unavailable.run_files.reason, "selected_unavailable");
});

test("YAML metadata descriptive keys stay plain while ambiguous, BOM and prototype keys round-trip", () => {
  const value = { run: "demo", state: "running", next: { tool: "actors_inspect" }, ["__proto__"]: { path: "?" },
    ["true"]: "string key", ["a\nb"]: "multiline key", ["\uFEFF"]: "BOM key" };
  const text = yamlRoundTrip(value);
  assert.match(text, /^run:/u); assert.match(text, /^state:/mu); assert.match(text, /^next:/mu);
});

test("tool output contributes exactly one leading line break", () => {
  assert.equal(withLeadingLineBreak("result"), "\nresult");
  assert.equal(withLeadingLineBreak("\nresult"), "\nresult");
  assert.equal(withLeadingLineBreak("\n\nresult"), "\nresult");
  assert.equal(`header\n${withLeadingLineBreak("\n\nresult")}`, "header\n\nresult");
  assert.deepEqual(
    spaceToolResult({
      content: [
        { type: "text", text: "result" },
        { type: "image", data: "unchanged" },
      ],
      details: { ok: true },
    }),
    {
      content: [
        { type: "text", text: "\nresult" },
        { type: "image", data: "unchanged" },
      ],
      details: { ok: true },
    },
  );
});

test("tool errors contribute exactly one leading line break", () => {
  const error = new Error("failure");
  assert.equal(spaceToolError(error), error);
  assert.equal(error.message, "\nfailure");
  const repeated = spaceToolError(error) as Error;
  assert.equal(repeated.message, "\nfailure");
  assert.equal((spaceToolError("failure") as Error).message, "\nfailure");
});

function yamlRoundTrip(value: unknown, budget = 49152): string {
  const result = renderYamlMetadata(value, budget);
  assert.equal(result.state, "available");
  if (result.state !== "available") throw new Error("Expected available metadata");
  assert.ok(Buffer.byteLength(result.text) <= budget);
  assert.doesNotMatch(result.text, /^(?:\n|---|\.\.\.|%YAML|```)/u);
  const document = parseDocument(result.text, { version: "1.2", schema: "core", uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  visit(document, (_key, node) => {
    assert.equal(isAlias(node), false);
    if (isCollection(node) && node.items.length) assert.notEqual(node.flow, true);
    if (isNode(node)) assert.equal(node.tag, undefined);
  });
  assert.deepEqual(document.toJS(), value);
  return result.text;
}

test("YAML metadata property partitions preserve types, ordering, exact scalar strings and input", () => {
  const strings = ["", "?", "yes", "on", "null", "true", "2026-01-01", "1e3", "0xFF", "---", "# x", ": x", "`quoted`", "\"'", "😀β中", "a\nb", "a\r\nb", "\t x\t", "a\n", "a\n\n", "\n", "\r", "\u0000", "\uFEFF", "---\nnext: fake\n```"];
  for (let seed = 0; seed < strings.length; seed++) {
    const value = Object.freeze({ [strings[seed]]: strings[(seed + 1) % strings.length],
      sequence: Object.freeze([null, true, false, 0, 1.5, Number.MAX_VALUE, Number.MIN_VALUE, {}, [], ...strings]),
      nested: Object.freeze({ second: "2", first: 1 }) });
    const before = JSON.stringify(value);
    const text = yamlRoundTrip(value);
    assert.equal(JSON.stringify(value), before);
    const parsed = parseDocument(text).toJS();
    assert.deepEqual(Object.keys(parsed), Object.keys(value));
    assert.deepEqual(Object.keys(parsed.nested), ["second", "first"]);
  }
  yamlRoundTrip([]); yamlRoundTrip({});
  const shared = { value: "same" };
  yamlRoundTrip([shared, shared]);
  const nullPrototype = Object.assign(Object.create(null), { safe: "value", toJSON: "not a hook" });
  const result = renderYamlMetadata(nullPrototype, 1000);
  assert.equal(result.state, "available");
  if (result.state === "available") assert.deepEqual(parseDocument(result.text).toJS(), { safe: "value", toJSON: "not a hook" });
});

test("YAML metadata refuses unsupported own-data graphs without getters, coercion or leaked causes", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { calls++; return "private"; } });
  const cycle: unknown[] = []; cycle.push(cycle);
  const extra = [1]; Object.assign(extra, { extra: 2 });
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  const symbol = { [Symbol("private")]: 1 };
  const invalid = [undefined, "body", null, 1, true, new Date(), new Error(), new Map(), new Set(), new Uint8Array(),
    Object.create({}), getter, cycle, extra, hidden, symbol, new Array(2), { x: undefined }, { x: () => calls++ },
    { x: Symbol() }, { x: 1n }, { x: NaN }, { x: Infinity }, { x: -0 }, { x: "\uD800" }, { "\uDC00": 1 },
    { toJSON() { calls++; return {}; } }, new Proxy({}, { ownKeys() { throw new Error("private cause"); } }),
    new Proxy({}, { getPrototypeOf() { throw "private cause"; } }),
    new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw "private cause"; } })];
  for (const value of invalid) assert.deepEqual(renderYamlMetadata(value, 16384), { state: "unavailable", reason: "metadata_invalid" });
  assert.equal(calls, 0);
  assert.equal(cycle[0], cycle);
});

test("YAML metadata budgets include UTF-8, escaping, indentation and final newline with whole refusal", () => {
  for (const value of [{ x: "😀β" }, { nested: { list: ["a\r\nb", "\t", {}] } }, [], { x: "x".repeat(16000) }]) {
    const text = yamlRoundTrip(value);
    const bytes = Buffer.byteLength(text);
    assert.deepEqual(renderYamlMetadata(value, bytes), { state: "available", text });
    assert.deepEqual(renderYamlMetadata(value, bytes - 1), { state: "unavailable", reason: "metadata_too_large" });
  }
  for (const budget of [0, -1, 1.5, NaN, Infinity, 49153, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(renderYamlMetadata({}, budget), { state: "unavailable", reason: "budget_invalid" });
  }
  assert.equal(renderYamlMetadata({ x: "a".repeat(1000000) }, 16384).state, "unavailable");
  assert.equal(renderYamlMetadata(Array.from({ length: 50000 }, () => null), 49152).state, "unavailable");
  let deep: unknown = {};
  for (let i = 0; i < 10000; i++) deep = [deep];
  assert.deepEqual(renderYamlMetadata(deep, 49152), { state: "unavailable", reason: "metadata_invalid" });
  let descriptors = 0;
  const wide = new Proxy(Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), "x"])), {
    getOwnPropertyDescriptor(target, key) { descriptors++; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  assert.equal(renderYamlMetadata(wide, 32).state, "unavailable");
  assert.ok(descriptors < 20, "Descriptor walk must stop before traversing a wide graph");
});

function fullSpawnMetadata(text: string): any {
  assert.ok(text.startsWith("\n") && !text.startsWith("\n\n"));
  assert.doesNotMatch(text.slice(1), /^(?:---|\.\.\.|%YAML|```)/u);
  const document = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  visit(document, (_key, node) => {
    assert.equal(isAlias(node), false);
    if (isCollection(node) && node.items.length) assert.notEqual(node.flow, true);
    if (isNode(node)) assert.equal(node.tag, undefined);
  });
  return document.toJS();
}

test("Full spawn YAML preserves JSON-selected facts, order, normalization and opaque strings", () => {
  const shared = { kept: true };
  const value = {
    run: "demo", file_navigation: { state: "available", ["__proto__"]: { literal: true }, ["\uFEFF"]: "BOM key" },
    next_actions: ["actors_inspect target=run:demo view=trace"], date: new Date("2026-01-01T00:00:00.000Z"),
    values: [undefined, , Symbol("omitted"), NaN, Infinity, -0, shared, shared],
    strings: ["", "?", "true", "null", "1e3", "😀β中", "\u0000", "\uFEFF", " a\r\nb\r\tc\n  ", "---\nnext: authored\n```"],
    absent: undefined, symbol: Symbol("omitted"), method() {},
  };
  Object.defineProperty(value, "privateCause", { get() { throw new Error("private cause read"); } });
  const selected = JSON.parse(JSON.stringify(value)), descriptors = Object.getOwnPropertyDescriptors(value);
  const text = spawnMetadataText(value, true, "unused"), actual = fullSpawnMetadata(text);
  assert.deepEqual(actual, selected);
  assert.deepEqual(Object.keys(actual), Object.keys(selected));
  assert.deepEqual(Object.keys(actual.file_navigation), Object.keys(selected.file_navigation));
  assert.ok(Object.hasOwn(actual.file_navigation, "__proto__"));
  assert.equal(actual.run_files, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
  const wrapped = spaceToolResult({ content: [{ type: "text", text }], details: value });
  assert.equal(wrapped.details, value); assert.equal(wrapped.content[0].text, text);
  for (const root of [null, true, 0, "", [], {}]) assert.deepEqual(fullSpawnMetadata(spawnMetadataText(root, true, "unused")), root);
});

test("Full spawn selector retains verbose, eager compact and full-hook order with exact false output", () => {
  const events: string[] = [];
  const input = { get verbose() { events.push("verbose"); return true; } };
  const value = { get selected() { events.push("getter"); return { toJSON() { events.push("toJSON"); return { exact: "value" }; } }; } };
  const text = spawnMetadataText(value, input.verbose === true, (() => { events.push("compact"); return "compact"; })());
  assert.deepEqual(events, ["verbose", "compact", "getter", "toJSON"]);
  assert.deepEqual(fullSpawnMetadata(text), { selected: { exact: "value" } });
  const unselected = new Proxy({}, { get() { throw new Error("unselected original graph read"); } });
  assert.equal(spawnMetadataText(unselected, false, "\n\nopaque compact"), "\n\nopaque compact");
  let selections = 0;
  const compactFailure = { original: "compact" };
  assert.throws(() => spawnMetadataText({ toJSON() { selections++; return {}; } }, true, (() => { throw compactFailure; })()), error => error === compactFailure);
  assert.equal(selections, 0);
});

test("Full spawn original stringify failures preserve exact thrown values and once-only hooks", () => {
  for (const failure of [undefined, "original", Symbol("original"), Object.freeze({ private: "cause" })]) {
    for (const kind of ["getter", "toJSON"]) {
      let calls = 0, caught = false, actual: unknown;
      const value = kind === "getter"
        ? { get selected() { calls++; throw failure; } }
        : { toJSON() { calls++; throw failure; } };
      try { spawnMetadataText(value, true, "unused"); } catch (error) { caught = true; actual = error; }
      assert.equal(caught, true); assert.equal(actual, failure); assert.equal(calls, 1);
    }
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [cycle, { bigint: 1n }]) {
    let legacy: unknown;
    try { JSON.stringify(value, null, 2); } catch (error) { legacy = error; }
    assert.throws(() => spawnMetadataText(value, true, "unused"), error => error instanceof TypeError && error.message === (legacy as Error).message);
  }
});

test("Full spawn absent JSON selection withholds the whole projection without calling JSON.parse", () => {
  const originalParse = JSON.parse;
  let parses = 0, hooks = 0;
  const texts: string[] = [];
  try {
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => { parses++; return originalParse(...args); };
    for (const value of [undefined, () => undefined, Symbol("absent"), { toJSON() { hooks++; return undefined; } }]) {
      texts.push(spawnMetadataText(value, true, "unused"));
    }
  } finally { JSON.parse = originalParse; }
  assert.equal(parses, 0); assert.equal(hooks, 1);
  for (const text of texts) {
    const metadata = fullSpawnMetadata(text);
    assert.deepEqual(Object.keys(metadata), ["projection", "reason", "warning"]);
    assert.equal(metadata.projection, "unavailable"); assert.equal(metadata.reason, "yaml_projection_failed");
    assert.match(metadata.warning, /not a workload-failure or no-effects receipt/);
    assert.match(metadata.warning, /Do not repeat automatically/);
    assert.doesNotMatch(text, /value_state|^undefined$/mu);
  }
});

test("Full spawn malformed selected keys or values withhold all facts without repair or a source rewalk", () => {
  for (const malformed of ["\uD800", "prefix\uDC00tail"]) for (const key of [false, true]) {
    let reads = 0;
    const value = key
      ? { get selected() { reads++; return "not-shown"; }, [malformed]: "not-shown" }
      : { get selected() { reads++; return malformed; }, other: "not-shown" };
    const text = spawnMetadataText(value, true, "unused"), metadata = fullSpawnMetadata(text);
    assert.equal(reads, 1); assert.equal(metadata.reason, "malformed_selected_text");
    assert.deepEqual(Object.keys(metadata), ["projection", "reason", "warning"]);
    assert.doesNotMatch(text, /not-shown|prefix|tail|\uFFFD/u);
  }
});

test("Full spawn metadata borrows neither the compact byte allowance nor depth64 ceiling", () => {
  const large = { retained: "x".repeat(65537) };
  const text = spawnMetadataText(large, true, "unused");
  assert.ok(Buffer.byteLength(text) > 49152); assert.deepEqual(fullSpawnMetadata(text), large);
  let deep: unknown = { leaf: "retained" };
  for (let i = 0; i < 96; i++) deep = { child: deep };
  assert.deepEqual(fullSpawnMetadata(spawnMetadataText(deep, true, "unused")), deep);
  assert.deepEqual(renderYamlMetadata(large, 49152), { state: "unavailable", reason: "metadata_too_large" });
  assert.deepEqual(renderYamlMetadata(deep, 49152), { state: "unavailable", reason: "metadata_invalid" });
});

test("Full spawn recoverable clone and style faults give one fixed receipt without hook replay or cause leaks", () => {
  const originalStyle = Document.prototype.toString, originalParse = JSON.parse;
  const failure = Object.defineProperty({}, "message", { get() { throw new Error("private cause observed"); } });
  let reads = 0, renders = 0, parses = 0;
  const value = { get selected() { reads++; return "not-shown"; } };
  let styleText: string, cloneText: string;
  try {
    Document.prototype.toString = function () { renders++; throw failure; };
    styleText = spawnMetadataText(value, true, "unused");
    assert.equal(renders, 1); assert.equal(reads, 1);
    assert.deepEqual(renderYamlMetadata({ selected: "value" }, 49152), { state: "unavailable", reason: "metadata_invalid" });
  } finally { Document.prototype.toString = originalStyle; }
  try {
    JSON.parse = () => { parses++; throw failure; };
    cloneText = spawnMetadataText(value, true, "unused");
  } finally { JSON.parse = originalParse; }
  assert.equal(reads, 2); assert.equal(parses, 1);
  for (const text of [styleText!, cloneText!]) {
    const metadata = fullSpawnMetadata(text);
    assert.equal(metadata.projection, "unavailable"); assert.equal(metadata.reason, "yaml_projection_failed");
    assert.deepEqual(Object.keys(metadata), ["projection", "reason", "warning"]);
    assert.doesNotMatch(text, /not-shown|private cause observed/u);
  }
});
