/**
 * Runtime registry loading regressions
 * Covers 0.16 recipe-discovered tool activation
 */

import "./test-environment.mjs";
import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandTemplateExecResult } from "../lib/command-templates.ts";
import {
  createEmptyRecipeResolutionContext,
  createRecipeResolutionContext,
} from "../lib/recipes-context.ts";
import { createActiveSkillRecipeContext } from "../lib/recipes-references.ts";
import {
  createAutoToolsRuntime,
  createRecipeToolReloadWatcher,
} from "../lib/runtime.ts";

const exec = async (): Promise<CommandTemplateExecResult> => ({
  code: 0,
  killed: false,
  stderr: "",
  stdout: "ok",
});

async function writeRecipe(
  root: string,
  name: string,
  body: Record<string, unknown>,
) {
  await writeFile(join(root, `${name}.json`), JSON.stringify(body));
}

const watcherFailureNotice = "- report: Recipe live reload watcher failed\n- instruction: restart the session or use actors_tool_register again to refresh recipe tools.";
const watcherRefreshNotice = "- report: Recipe tools refreshed from ~/.pi/agent/recipes";

class NoticeWatcher extends EventEmitter {
  closed = false;
  readonly listener: (event: string, changedFile: string | null) => void;
  readonly events: unknown[];
  constructor(listener: NoticeWatcher["listener"], events: unknown[]) { super(); this.listener = listener; this.events = events; }
  close() { this.closed = true; this.events.push("close"); }
  change(file: string | null = null) { this.listener("rename", file); }
}

function createWatcherNoticeProbe() {
  const events: unknown[] = [], errors: unknown[] = [], notices: Array<[string, string | undefined]> = [], created: NoticeWatcher[] = [];
  const root = "/private/notifier-fixture/recipes", parent = "/private/notifier-fixture";
  const resolution = createEmptyRecipeResolutionContext("watcher-notice", parent);
  const loaded: Array<[unknown, unknown]> = [];
  const state = {
    rootExists: true, parentExists: true, watchFault: false,
    fault: undefined as { at: "ui" | "notify" | "call"; cause: unknown } | undefined,
    loadEffect: (): void => {}, reportEffect: (_error: unknown): void => {},
  };
  const ctx = { hasUI: true, get ui() {
    events.push("ui"); if (state.fault?.at === "ui") throw state.fault.cause;
    return { get notify() {
      events.push("notify.lookup"); if (state.fault?.at === "notify") throw state.fault.cause;
      return (message: string, type?: "info" | "warning" | "error") => {
        notices.push([message, type]); events.push(["notice", message, type]);
        if (state.fault?.at === "call") throw state.fault.cause;
      };
    } };
  } };
  const watcher = createRecipeToolReloadWatcher({
    loadTools(context, value) { events.push("load"); loaded.push([context, value]); state.loadEffect(); },
    setWatchStatus(status) { events.push(["status", status]); },
  }, {
    recipeRoot: root, reloadDelayMs: 5,
    exists(path) { events.push(["exists", path]); if (path === root) return state.rootExists; assert.equal(path, parent); return state.parentExists; },
    getResolutionContext() { events.push("resolution"); return resolution; },
    onCallbackError(error) { events.push(["error", error]); errors.push(error); state.reportEffect(error); },
    watchPath: ((_path: string, listener: NoticeWatcher["listener"]) => {
      events.push("watch"); if (state.watchFault) throw new Error("watch port failed");
      const next = new NoticeWatcher(listener, events); created.push(next); return next;
    }) as unknown as typeof import("node:fs").watch,
  });
  return { ctx, state, events, errors, notices, created, loaded, resolution, watcher };
}
const flushWatcherNotice = () => new Promise<void>(resolve => setTimeout(resolve, 25));

test("AX Recipe watcher warning preserves direct UI, failed-before-notify dedup and exact contained callback faults", async () => {
  const opaque = Object.freeze({ toString(): never { throw Error("Do not coerce callback cause"); } });
  const faults = [undefined, { at: "ui", cause: opaque }, { at: "notify", cause: undefined }, { at: "call", cause: "PRIVATE_FAILURE" }, { at: "call", cause: undefined }, { at: "call", cause: opaque }] as const;
  for (const origin of ["missing_parent", "root_start", "root_error", "parent_error"] as const) for (const fault of faults) for (const hasUI of [true, false]) {
    const h = createWatcherNoticeProbe();
    try {
      h.ctx.hasUI = hasUI; h.state.fault = fault; h.state.reportEffect = () => { throw opaque; };
      if (origin === "missing_parent" || origin === "parent_error") h.state.rootExists = false;
      if (origin === "missing_parent") h.state.parentExists = false;
      if (origin === "root_start") h.state.watchFault = true;
      const emitterOrigin = origin === "root_error" || origin === "parent_error";
      if (emitterOrigin) { h.watcher.watch(h.ctx); h.events.length = 0; }
      const trigger = () => emitterOrigin ? h.created[0]!.emit("error", opaque) : h.watcher.watch(h.ctx);
      assert.doesNotThrow(trigger);
      assert.deepEqual(h.notices, !fault || fault.at === "call" ? [[watcherFailureNotice, "warning"]] : []);
      assert.deepEqual(h.errors, fault ? [fault.cause] : []); assert.equal(h.loaded.length, 0);
      const failed = h.events.findIndex(value => Array.isArray(value) && value[0] === "status" && value[1] === "failed");
      assert.ok(failed >= 0 && failed < h.events.indexOf("ui"));
      assert.equal(h.events.filter(value => value === "ui").length, 1);
      if (emitterOrigin) { assert.equal(h.created[0]!.closed, true); assert.ok(h.events.indexOf("close") < failed); }
      assert.doesNotThrow(trigger); assert.equal(h.events.filter(value => value === "ui").length, 1, "failureNotified already set even when the warning port throws");
      assert.deepEqual(h.errors, fault ? [fault.cause] : []);
      assert.doesNotMatch(h.notices.map(value => value[0]).join("\n"), /PRIVATE_|notifier-fixture|^- (next|tool|source|callable_now):/m);
    } finally { h.watcher.close(); }
  }
  const h = createWatcherNoticeProbe();
  try {
    h.state.watchFault = true; h.watcher.watch(h.ctx); assert.deepEqual(h.notices, [[watcherFailureNotice, "warning"]]);
    h.state.watchFault = false; h.watcher.watch(h.ctx); h.created[0]!.change("drafts/new.json"); await flushWatcherNotice();
    assert.equal(h.loaded.length, 1); assert.equal(h.notices.length, 1);
    h.created[0]!.emit("error", opaque); assert.deepEqual(h.notices, [[watcherFailureNotice, "warning"], [watcherFailureNotice, "warning"]]);
  } finally { h.watcher.close(); }
  for (const width of [24, 52, 90, 140]) assert.ok(new Text(watcherFailureNotice, 1, 0).render(width).every(line => visibleWidth(line) <= width));
});

test("AX Recipe watcher refresh preserves pending-change/load order, old root report and exact secondary-fault order", async () => {
  for (const files of [["tool.json"], ["drafts/captured.json"], ["drafts\\captured.json"], [null], ["tool.json", "drafts/other.json", null]]) for (const hasUI of [true, false]) {
    const h = createWatcherNoticeProbe();
    try {
      h.ctx.hasUI = hasUI; h.watcher.watch(h.ctx); h.events.length = 0;
      for (const file of files) h.created[0]!.change(file); await flushWatcherNotice();
      const active = files.some(file => file && !file.startsWith("drafts"));
      assert.deepEqual(h.loaded, [[h.ctx, h.resolution]]); assert.deepEqual(h.errors, []);
      assert.deepEqual(h.notices, active ? [[watcherRefreshNotice, "info"]] : []);
      if (active) assert.ok(h.events.indexOf("resolution") < h.events.indexOf("load") && h.events.indexOf("load") < h.events.indexOf("ui"));
      assert.doesNotMatch(h.notices.map(value => value[0]).join("\n"), /notifier-fixture|^- (source|root|next|tool|callable_now):/m);
      h.events.length = 0; h.watcher.close(); const closed = [...h.events]; h.created[0]!.change("later.json"); h.created[0]!.emit("error", "stale");
      await flushWatcherNotice(); assert.deepEqual(h.events, closed); assert.equal(h.loaded.length, 1);
    } finally { h.watcher.close(); }
  }
  const opaque = Object.freeze({ toString(): never { throw Error("Do not coerce callback cause"); } });
  for (const phase of ["load", "info"] as const) for (const cause of [undefined, "PRIVATE_PRIMARY", opaque]) for (const secondaryFault of (phase === "load" ? [false, true] : [false])) {
    const h = createWatcherNoticeProbe(), secondary = Object.freeze({ secondary: true });
    try {
      h.state.reportEffect = () => { throw Error("observer fault stays contained"); };
      if (phase === "load") h.state.loadEffect = () => { if (secondaryFault) h.state.fault = { at: "call", cause: secondary }; throw cause; };
      else h.state.fault = { at: "call", cause };
      h.watcher.watch(h.ctx); h.events.length = 0; h.created[0]!.change("tool.json"); await flushWatcherNotice();
      assert.deepEqual(h.loaded, [[h.ctx, h.resolution]]);
      assert.deepEqual(h.notices.map(value => value[0]), phase === "load" ? [watcherFailureNotice] : [watcherRefreshNotice, watcherFailureNotice]);
      assert.deepEqual(h.errors, phase === "load" ? (secondaryFault ? [secondary, cause] : [cause]) : [cause, cause]);
      const lastError = h.events.findLastIndex(value => Array.isArray(value) && value[0] === "error"); assert.ok(lastError > h.events.indexOf("load"));
      if (phase === "info") {
        h.state.fault = undefined; h.events.length = 0; h.notices.length = 0; h.errors.length = 0;
        h.created[0]!.change("drafts/next.json"); await flushWatcherNotice();
        assert.deepEqual(h.notices, [[watcherRefreshNotice, "info"]], "Only a fresh event schedules load; original pending info survives its callback fault");
        assert.deepEqual(h.errors, []); assert.equal(h.loaded.length, 2);
      }
    } finally { h.watcher.close(); }
  }
  for (const width of [24, 52, 90, 140]) assert.ok(new Text(watcherRefreshNotice, 1, 0).render(width).every(line => visibleWidth(line) <= width));
});

const skippedStartupWarning = "Recipe conflict could not be exposed as a tool: Command template repeat must be a positive integer or {array.length} with an array argument/default.";
const startupReport = "- report: pi-actors recipe registry warning\n";
const startupInstruction = "- instruction: Next: actors_inspect target=recipes view=doctor\n";
const conflictStartupRecipe = { description: "Conflict", args: ["items:string"], template: { repeat: "{items.length}", template: "echo" } };

async function createStartupWarningProbe(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-startup-warning-")), recipeRoot = join(root, "recipes");
  await mkdir(recipeRoot);
  for (const [name, body] of Object.entries(files)) await writeFile(join(recipeRoot, name + ".json"), JSON.stringify(body));
  const notices: Array<[string, string | undefined]> = [], effects: string[] = [];
  const state = { visible: true, notify: (): void => {} };
  const runtime = createAutoToolsRuntime({ recipeRoot, configPath: join(root, "registry.json"), exec: async (): Promise<never> => { throw Error("No execution"); }, reservedToolNames: new Set(["read"]), registerTool() { effects.push("register"); } });
  const ctx = { get hasUI() { effects.push("hasUI"); return state.visible; }, get ui() { effects.push("ui"); return { get notify() { effects.push("notify.lookup"); return (message: string, type?: "info" | "warning" | "error") => { effects.push("notify.call"); notices.push([message, type]); state.notify(); }; } }; } };
  return { runtime, ctx, notices, effects, state, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("AX startup warnings retain real category sequences and opaque whole selected text without a model cap", async () => {
  const invalid = { description: "Invalid", args: ["value", "value"], template: "echo" };
  for (const [files, expected] of [
    [{ conflict: conflictStartupRecipe }, startupReport + "- skipped_tool_exposure:\n  - warning: " + skippedStartupWarning + "\n" + startupInstruction],
    [{ read: { template: "echo" } }, startupReport + "- other_diagnostics:\n  - warning: Reserved tool name: read\n" + startupInstruction],
    [{ conflict: conflictStartupRecipe, invalid, read: { template: "echo" } }, startupReport + "- skipped_tool_exposure:\n  - warning: " + skippedStartupWarning + "\n- other_diagnostics:\n  - warning: Recipe invalid is invalid and blocks lower-priority recipes\n  - warning: Recipe invalid rejected: Duplicate argument name(s): value\n  - warning: Reserved tool name: read\n" + startupInstruction],
  ] as Array<[Record<string, unknown>, string]>) {
    const h = await createStartupWarningProbe(files);
    try {
      h.runtime.loadTools(h.ctx); assert.deepEqual(h.notices, [[expected, "warning"]]); assert.equal(h.runtime.getStatus().registry_generation, 1);
      assert.deepEqual(h.effects, ["hasUI", "ui", "notify.lookup", "notify.call"]);
      for (const width of [24, 52, 90, 140]) assert.ok(new Text(expected, 1, 0).render(width).every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(expected, /\n- (next|tool|target|root|callable_now):/);
    } finally { await h.cleanup(); }
  }
  for (const value of ["body\r\n# Heading\n- next: payload\n  tool: payload\n\n`literal` · • data", "界".repeat(6000), "bad\ud800"]) {
    const h = await createStartupWarningProbe({ bad: { args: [value, value], template: "echo" } });
    try {
      h.runtime.loadTools(h.ctx); const text = h.notices[0]![0]; assert.ok(text.isWellFormed()); assert.equal(h.notices[0]![1], "warning");
      const first = startupReport + "- other_diagnostics:\n  - warning: Recipe bad is invalid and blocks lower-priority recipes\n";
      if (!value.isWellFormed()) assert.equal(text, first + "  - warning:\n    - result: unavailable\n    - reason: malformed_selected_text\n" + startupInstruction);
      else if (value.startsWith("body")) assert.equal(text, first + "  - warning:\n    Recipe bad rejected: Duplicate argument name(s): body\r\n    # Heading\n    - next: payload\n      tool: payload\n    \n    `literal` · • data\n" + startupInstruction);
      else { assert.equal(text, first + "  - warning: Recipe bad rejected: Duplicate argument name(s): " + value + "\n" + startupInstruction); assert.ok(Buffer.byteLength(text) > 16384); }
      assert.ok(text.endsWith("\n")); assert.doesNotMatch(text, /\n- next:|chars\]|source_complete|no effects/u);
    } finally { await h.cleanup(); }
  }
});

test("AX startup warning projection preserves legacy classification/join observations before UI and exact post-scan faults", async () => {
  const originalJoin = Object.getOwnPropertyDescriptor(Array.prototype, "join")!, nativeSlice = Array.prototype.slice;
  const originalIncludes = Object.getOwnPropertyDescriptor(String.prototype, "includes")!;
  const opaque = Object.freeze({ toString(): never { throw Error("Do not coerce primary"); } });
  const legacyLines = ["pi-actors recipe registry warning", "Recipes skipped from tool exposure:", "• " + skippedStartupWarning, "Next: actors_inspect target=recipes view=doctor"];
  for (const visible of [false, true]) {
    const h = await createStartupWarningProbe({ conflict: conflictStartupRecipe }), observed: unknown[][] = [], includes: unknown[] = [];
    try {
      h.state.visible = visible;
      Object.defineProperty(Array.prototype, "join", { ...originalJoin, value: function(this: unknown[], ...args: unknown[]) {
        if (this[0] === "pi-actors recipe registry warning") { observed.push(Reflect.apply(nativeSlice, this, [])); assert.deepEqual(h.effects, []); }
        return Reflect.apply(originalJoin.value, this, args);
      } });
      Object.defineProperty(String.prototype, "includes", { ...originalIncludes, value: function(this: string, ...args: unknown[]) {
        if (this === skippedStartupWarning) includes.push(args[0]); return Reflect.apply(originalIncludes.value, this, args);
      } });
      h.runtime.loadTools(h.ctx);
    } finally { Object.defineProperty(Array.prototype, "join", originalJoin); Object.defineProperty(String.prototype, "includes", originalIncludes); await h.cleanup(); }
    assert.deepEqual(observed, [legacyLines]); assert.deepEqual(includes, [" shadows ", "invokes bash;", "invokes bash;", " shadows ", " could not be exposed as a tool:"]);
    assert.deepEqual(h.effects, visible ? ["hasUI", "ui", "notify.lookup", "notify.call"] : ["hasUI"]);
    assert.equal(h.notices.length, visible ? 1 : 0); if (visible) assert.ok(h.notices[0]![0].startsWith(startupReport));
  }
  for (const phase of ["startup_filter", "shadow_filter", "skipped_filter", "join", "notify"] as const) for (const cause of [undefined, "PRIVATE_PRIMARY", opaque]) {
    const h = await createStartupWarningProbe({ conflict: conflictStartupRecipe }); let calls = 0, rejected = false, joins = 0;
    try {
      if (phase === "notify") h.state.notify = () => { throw cause; };
      Object.defineProperty(Array.prototype, "join", { ...originalJoin, value: function(this: unknown[], ...args: unknown[]) {
        if (this[0] === "pi-actors recipe registry warning") { joins++; if (phase === "join") throw cause; }
        return Reflect.apply(originalJoin.value, this, args);
      } });
      Object.defineProperty(String.prototype, "includes", { ...originalIncludes, value: function(this: string, ...args: unknown[]) {
        if (this === skippedStartupWarning) { calls++; if ((phase === "startup_filter" && calls === 1) || (phase === "shadow_filter" && calls === 4) || (phase === "skipped_filter" && calls === 5)) throw cause; }
        return Reflect.apply(originalIncludes.value, this, args);
      } });
      try { h.runtime.loadTools(h.ctx); } catch (error) { rejected = true; assert.equal(error, cause); }
    } finally { Object.defineProperty(Array.prototype, "join", originalJoin); Object.defineProperty(String.prototype, "includes", originalIncludes); }
    try {
      assert.equal(rejected, true); assert.equal(h.runtime.getStatus().registry_generation, 1); assert.equal(h.runtime.getStatus().last_scan_counts.scanned, 1);
      assert.equal(joins, phase === "join" || phase === "notify" ? 1 : 0); assert.deepEqual(h.effects, phase === "notify" ? ["hasUI", "ui", "notify.lookup", "notify.call"] : []);
      assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, "join"), originalJoin); assert.deepEqual(Object.getOwnPropertyDescriptor(String.prototype, "includes"), originalIncludes);
    } finally { await h.cleanup(); }
  }
  for (const mode of ["opaque_result", "symbol_result", "coercion_failure"] as const) {
    const h = await createStartupWarningProbe({ conflict: conflictStartupRecipe }); const conversions: string[] = []; let failure: unknown, rejected = false;
    try {
      h.state.visible = false;
      Object.defineProperty(Array.prototype, "join", { ...originalJoin, value: function(this: unknown[], ...args: unknown[]) {
        if (this[0] === "pi-actors recipe registry warning") return mode === "symbol_result" ? Symbol("legacy layout") : { [Symbol.toPrimitive](hint: string) { conversions.push(hint); if (mode === "coercion_failure") throw opaque; return "discarded compiler layout"; } };
        return Reflect.apply(originalJoin.value, this, args);
      } });
      try { h.runtime.loadTools(h.ctx); } catch (error) { rejected = true; failure = error; }
    } finally { Object.defineProperty(Array.prototype, "join", originalJoin); }
    try {
      assert.deepEqual(conversions, mode === "symbol_result" ? [] : ["string"]);
      assert.equal(rejected, mode !== "opaque_result"); if (mode === "coercion_failure") assert.equal(failure, opaque); if (mode === "symbol_result") assert.ok(failure instanceof TypeError);
      assert.deepEqual(h.effects, mode === "opaque_result" ? ["hasUI"] : []); assert.equal(h.runtime.getStatus().registry_generation, 1);
      assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, "join"), originalJoin);
    } finally { await h.cleanup(); }
  }
});

test("Runtime skips invalid user recipes without aborting load", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "bad-repeat", {
      description: "Bad repeat",
      template: { repeat: "{count}", template: "echo {item}" },
    });
    const notifications: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      recipeRoot,
      registerTool: () => assert.fail("invalid recipe should not register"),
      reservedToolNames: new Set(),
    });
    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });
    assert.equal(runtime.getTools().has("bad-repeat"), false);
    assert.match(
      notifications.join("\n"),
      /Recipe bad-repeat rejected:.*Command template repeat/s,
    );
    assert.match(
      notifications.join("\n"),
      /Next: actors_inspect target=recipes view=doctor/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime reconciles Skill-dependent user tools only with the supplied live context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-live-context-"));
  try {
    const recipeRoot = join(root, "recipes");
    const mediaSkill = join(root, "skills", "music-player");
    await Promise.all([
      mkdir(recipeRoot, { recursive: true }),
      mkdir(join(mediaSkill, "recipes"), { recursive: true }),
    ]);
    await writeRecipe(recipeRoot, "music_player", {
      description: "Play local music",
      template: "music-player/playback",
    });
    await writeFile(
      join(mediaSkill, "recipes", "playback.json"),
      JSON.stringify({
        async: true,
        args: ["source:path"],
        control: ["play", "stop"],
        template: "echo {source}",
      }),
    );
    const registered: Array<{ name: string; required: string[] }> = [];
    let activeTools = ["read"];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "registry.json"),
      exec,
      getActiveTools: () => activeTools,
      recipeRoot,
      registerTool: (definition) => {
        registered.push({
          name: definition.name,
          required: definition.parameters.required,
        });
        activeTools = [...new Set([...activeTools, definition.name])];
      },
      reservedToolNames: new Set(),
      setActiveTools: (names) => {
        activeTools = names;
      },
    });
    const runtimeContext = { hasUI: false, ui: { notify() {} } };
    runtime.loadTools(runtimeContext);
    assert.equal(runtime.getTools().has("music_player"), false);
    assert.deepEqual(registered, []);
    assert.equal(runtime.getStatus().registry_generation, 1);
    assert.equal(runtime.getStatus().resolution_generation, undefined);
    const resolutionContext = createRecipeResolutionContext(
      "runtime-live-session",
      root,
      createActiveSkillRecipeContext([{ name: "music-player", baseDir: mediaSkill }]),
    );
    runtime.loadTools(runtimeContext, resolutionContext);
    assert.equal(runtime.getTools().get("music_player")?.recipe?.async, true);
    assert.deepEqual(runtime.getTools().get("music_player")?.recipe?.control, [
      "play",
      "stop",
    ]);
    assert.deepEqual(registered, [
      { name: "music_player", required: ["source"] },
    ]);
    assert.equal(runtime.getStatus().registry_generation, 2);
    assert.equal(
      runtime.getStatus().resolution_generation,
      resolutionContext.generation,
    );
    assert.deepEqual(runtime.getStatus().last_scan_counts, {
      active: 1,
      rejected: 0,
      scanned: 1,
    });
    runtime.loadTools(runtimeContext, resolutionContext);
    assert.equal(registered.length, 1);
    runtime.loadTools(runtimeContext);
    assert.equal(runtime.getTools().has("music_player"), false);
    assert.deepEqual(activeTools, ["read"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime suppresses routine bash wrapper startup warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "bash-wrapper", {
      description: "Trusted local wrapper",
      template: "bash -- ./script.sh",
    });
    const notifications: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      recipeRoot,
      registerTool: () => {},
      reservedToolNames: new Set(),
    });
    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });
    assert.equal(runtime.getTools().has("bash-wrapper"), true);
    assert.equal(notifications.join("\n"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime treats same-id recipe shadowing as a normal override", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(packagedRecipeRoot, "music_player", {
      description: "Packaged player",
      template: "echo packaged",
    });
    await writeRecipe(recipeRoot, "music_player", {
      description: "User player",
      template: "echo user",
    });
    const notifications: string[] = [];
    const registered: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      recipeRoot,
      registerTool: (definition) => registered.push(definition.name),
      reservedToolNames: new Set(),
    });
    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });
    assert.deepEqual(registered, ["music_player"]);
    assert.equal(
      runtime.getTools().get("music_player")?.description,
      "User player",
    );
    assert.equal(notifications.join("\n"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime keeps reserved tool names protected during recipe loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "read", {
      description: "Unsafe core override",
      template: "echo nope",
    });
    const notifications: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      recipeRoot,
      registerTool: () => assert.fail("reserved recipe should not register"),
      reservedToolNames: new Set(["read"]),
    });
    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });
    assert.match(notifications.join("\n"), /Reserved tool name: read/);
    assert.match(
      notifications.join("\n"),
      /Next: actors_inspect target=recipes view=doctor/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime loads tools from discovered user recipes by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "user-tool", {
      description: "User tool",
      args: ["scope:path"],
      template: "echo {scope}",
    });
    await writeRecipe(recipeRoot, "recipe-only", {
      description: "Recipe only",
      template: "echo hidden",
    });
    await writeRecipe(packagedRecipeRoot, "stdlib-component", {
      description: "Packaged component",
      template: "echo component",
    });
    await writeRecipe(packagedRecipeRoot, "stdlib-tool", {
      description: "Packaged component",
      template: "echo component",
    });
    const registered: string[] = [];
    let activeTools = ["read"];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      getActiveTools: () => activeTools,
      recipeRoot,
      registerTool: (definition) => {
        registered.push(definition.name);
        activeTools = [...new Set([...activeTools, definition.name])];
      },
      reservedToolNames: new Set(),
      setActiveTools: (toolNames) => {
        activeTools = toolNames;
      },
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.deepEqual([...runtime.getTools().keys()].sort(), [
      "recipe-only",
      "user-tool",
    ]);
    assert.equal(
      runtime.getTools().get("user-tool")?.sourcePath,
      join(recipeRoot, "user-tool.json"),
    );
    assert.equal(
      runtime.getTools().get("recipe-only")?.sourcePath,
      join(recipeRoot, "recipe-only.json"),
    );
    assert.equal(runtime.getTools().get("stdlib-tool"), undefined);
    assert.deepEqual(registered.sort(), ["recipe-only", "user-tool"]);
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.deepEqual(registered.sort(), ["recipe-only", "user-tool"]);
    await writeRecipe(recipeRoot, "user-tool", {
      description: "Updated user tool",
      args: ["scope:path"],
      template: "echo updated {scope}",
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.deepEqual(registered.sort(), [
      "recipe-only",
      "user-tool",
      "user-tool",
    ]);
    await writeRecipe(packagedRecipeRoot, "fallback", {
      description: "Packaged fallback",
      template: "echo packaged",
    });
    await writeRecipe(recipeRoot, "fallback", {
      description: "Broken user winner",
      template: "echo broken",
      repeat: 0,
    });
    const warnings: string[] = [];
    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => warnings.push(message) },
    });
    assert.equal(runtime.getTools().has("fallback"), false);
    assert.match(warnings.join("\n"), /Command template repeat/);
    await writeRecipe(recipeRoot, "fallback", {
      description: "Recovered user winner",
      template: "echo recovered {topic}",
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.equal(
      runtime.getTools().get("fallback")?.description,
      "Recovered user winner",
    );
    assert.deepEqual(runtime.getTools().get("fallback")?.args, ["topic"]);
    await unlink(join(recipeRoot, "user-tool.json"));
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.equal(runtime.getTools().has("user-tool"), false);
    assert.deepEqual(activeTools.sort(), ["fallback", "read", "recipe-only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stale recipe watcher callbacks cannot close a replacement watcher", async () => {
  class FakeWatcher extends EventEmitter {
    closed = false;
    readonly path: string;
    readonly listener: (event: string, changedFile: string | null) => void;
    constructor(
      path: string,
      listener: (event: string, changedFile: string | null) => void,
    ) {
      super();
      this.path = path;
      this.listener = listener;
    }
    close(): void {
      this.closed = true;
    }
    change(changedFile: string | null = null): void {
      this.listener("rename", changedFile);
    }
  }
  const recipeRoot = "/agent/recipes";
  let rootExists = true;
  let loads = 0;
  const resolutionContext = createEmptyRecipeResolutionContext(
    "watcher-session",
    "/agent",
  );
  const loadedContexts: unknown[] = [];
  const watchers: FakeWatcher[] = [];
  const watcher = createRecipeToolReloadWatcher(
    {
      loadTools: (_ctx, context) => {
        loads += 1;
        loadedContexts.push(context);
      },
    },
    {
      exists: (path) => path === "/agent" || (path === recipeRoot && rootExists),
      getResolutionContext: () => resolutionContext,
      recipeRoot,
      watchPath: ((path: string, listener: FakeWatcher["listener"]) => {
        const created = new FakeWatcher(path, listener);
        watchers.push(created);
        return created;
      }) as unknown as typeof import("node:fs").watch,
    },
  );
  const ctx = { hasUI: true, ui: { notify() {} } };
  watcher.watch(ctx);
  const firstRoot = watchers[0]!;
  rootExists = false;
  firstRoot.change();
  const parent = watchers[1]!;
  rootExists = true;
  parent.change("recipes");
  const replacementRoot = watchers[2]!;
  firstRoot.emit("error", new Error("delayed stale error"));
  firstRoot.change("stale-event.json");
  assert.equal(replacementRoot.closed, false);
  replacementRoot.change("tool.json");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(loads, 1);
  assert.deepEqual(loadedContexts, [resolutionContext]);
  assert.equal(replacementRoot.closed, false);
  watcher.close();
});

test("Recipe reload callback failures close through the session owner without escaping", async () => {
  class FakeWatcher extends EventEmitter {
    closed = false;
    readonly listener: (event: string, changedFile: string | null) => void;
    constructor(listener: (event: string, changedFile: string | null) => void) {
      super();
      this.listener = listener;
    }
    close(): void {
      this.closed = true;
    }
    change(): void {
      this.listener("change", "tool.json");
    }
  }
  let stale = false;
  let callbackErrors = 0;
  let watcher: ReturnType<typeof createRecipeToolReloadWatcher>;
  const created: FakeWatcher[] = [];
  const ctx = {
    hasUI: true,
    get ui() {
      if (stale) throw new Error("stale recipe reload context");
      return { notify() {} };
    },
  };
  watcher = createRecipeToolReloadWatcher(
    {
      loadTools: () => {
        void ctx.ui;
      },
    },
    {
      exists: () => true,
      onCallbackError: () => {
        callbackErrors += 1;
        watcher.close();
      },
      recipeRoot: "/agent/recipes",
      reloadDelayMs: 5,
      watchPath: ((_path: string, listener: FakeWatcher["listener"]) => {
        const next = new FakeWatcher(listener);
        created.push(next);
        return next;
      }) as unknown as typeof import("node:fs").watch,
    },
  );
  watcher.watch(ctx);
  created[0]!.change();
  stale = true;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(callbackErrors >= 1, true);
  assert.equal(created[0]!.closed, true);
  assert.doesNotThrow(() => watcher.close());
});

test("Recipe watcher rearms when the recipe root appears", {
  skip: process.platform === "win32"
    ? "Node's Windows fs watcher asserts when its watched directory is removed"
    : process.platform === "darwin"
      ? "macOS fs watcher delivery for a newly created recipe root is nondeterministic"
      : false,
}, async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-runtime-watch-root-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let loads = 0;
  const notifications: string[] = [];
  const watcher = createRecipeToolReloadWatcher({
    loadTools() {
      loads += 1;
    },
  });
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  async function waitForLoad(previous: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (loads > previous) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`recipe watcher did not reload after ${previous}`);
  }
  try {
    watcher.watch(ctx);
    const recipeRoot = join(agentDir, "recipes");
    await mkdir(recipeRoot);
    await waitForLoad(0);
    let previousLoads = loads;
    await writeRecipe(recipeRoot, "first", {
      description: "First",
      template: "echo first",
    });
    await waitForLoad(0);
    assert.match(notifications.join("\n"), /Recipe tools refreshed/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    notifications.length = 0;
    previousLoads = loads;
    const draftRoot = join(recipeRoot, "drafts");
    await mkdir(draftRoot);
    await writeRecipe(draftRoot, "captured", {
      description: "Captured draft",
      template: "echo draft",
    });
    await waitForLoad(previousLoads);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.doesNotMatch(notifications.join("\n"), /Recipe tools refreshed/);
    previousLoads = loads;
    await rm(recipeRoot, { recursive: true, force: true });
    await waitForLoad(previousLoads);
    previousLoads = loads;
    await mkdir(recipeRoot);
    await writeRecipe(recipeRoot, "second", {
      description: "Second",
      template: "echo second",
    });
    await waitForLoad(previousLoads);
    watcher.close();
    watcher.close();
  } finally {
    watcher.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
