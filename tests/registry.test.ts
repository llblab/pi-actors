import "./test-environment.mjs";

/**
 * Registry regression tests
 * Covers register/update/delete behavior independently from pi-facing schema assembly
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Text, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseDocument, isMap, isSeq } from "yaml";

function registryYaml(text: string): any {
  assert.ok(text.startsWith("\n"));
  assert.doesNotMatch(text, /^(?:---|```)/mu);
  const document = parseDocument(text, { version: "1.2", schema: "core" });
  assert.deepEqual(document.errors, []);
  assert.ok(isMap(document.contents));
  for (const key of ["registered_tools", "required_args", "optional_args", "warnings"]) {
    if (Array.isArray(document.toJS()[key])) assert.ok(isSeq(document.get(key, true)));
  }
  return document.toJS();
}

/** Bare block-YAML registry document text including the public adapter's one leading LF. */
function registryDocumentText(value: Record<string, unknown>): string | undefined {
  const rendered = renderYamlMetadata(value, Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1);
  return rendered.state === "available" ? "\n" + rendered.text : undefined;
}

/** Expected selected registry document; any unrenderable projection fails the assertion. */
function registryDocument(value: Record<string, unknown>): string {
  const text = registryDocumentText(value);
  assert.ok(text, "Expected a renderable registry document");
  return text;
}

/** Largest single-byte payload whose complete document still fits the model bound. */
function exactFit(document: (payload: string) => Record<string, unknown>): number {
  let low = 0, high = 16384;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const text = registryDocumentText(document("x".repeat(middle)));
    if (text !== undefined && Buffer.byteLength(text) <= 16384) low = middle;
    else high = middle - 1;
  }
  return low;
}

import type { RegisteredTool } from "../lib/config.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { createActiveSkillRecipeContext, readResolvedRecipeConfig, RUNTIME_OWNED_RECIPE_INPUT_NAMES } from "../lib/recipes-references.ts";
import * as Limits from "../lib/limits.ts";
import { executeRegisterTool } from "../lib/registry.ts";
import { createRegisterToolDefinition } from "../lib/tools-register.ts";
import { createAutoToolsRuntime } from "../lib/runtime.ts";
import { renderYamlMetadata } from "../lib/tools-response.ts";
import { mutationLockPath } from "../lib/file-state.ts";

const execFileAsync = promisify(execFile);

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), "pi-actors-registry-"));
  const tools = new Map<string, RegisteredTool>();
  const notifications: string[] = [];
  const runtimeRegistered: string[] = [];
  let activeTools = ["read", "smoke"];
  return {
    activeTools: () => activeTools,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    deps: {
      configPath: join(dir, "tool-registry.json"),
      getActiveTools: () => activeTools,
      getToolNameBlocker: () => undefined,
      getTools: () => tools,
      notify: (_ctx: unknown, message: string) => notifications.push(message),
      registerRuntimeTool: (cfg: RegisteredTool) => {
        runtimeRegistered.push(cfg.name);
      },
      reservedToolNames: new Set(["bash", "register_tool"]),
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
    },
    notifications,
    root: join(dir, "recipes"),
    runtimeRegistered,
    tools,
  };
}

type RegistryNoticeKind = "activated" | "promoted" | "deleted";
const registryNoticeReport = { activated: "Tool activated", promoted: "Promoted draft recipe", deleted: "Deleted tool" };
const registryNoticeExpected = (kind: RegistryNoticeKind, name: string) => "- report: " + registryNoticeReport[kind] + "\n- tool: " + name;

async function prepareRegistryNotice(kind: RegistryNoticeKind) {
  const h = await createHarness();
  const draft = join(h.root, "drafts", "notice.json");
  if (kind === "promoted") { await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, JSON.stringify({ description: "Draft", template: "echo" })); }
  if (kind === "deleted") await executeRegisterTool({ name: "notice", description: "Prior", template: "echo" }, {}, h.deps);
  h.notifications.length = 0; h.runtimeRegistered.length = 0;
  const params = kind === "promoted" ? { name: "notice", draft } : kind === "deleted" ? { name: "notice", template: null } : { name: "notice", description: "Notice", template: "echo" };
  return { h, params };
}

for (const kind of ["activated", "promoted", "deleted"] as const) test(`AX registry ${kind} notice preserves real UI gate and post-effect callback failures`, async () => {
  for (const visible of [false, true]) {
    const { h, params } = await prepareRegistryNotice(kind);
    try {
      const messages: Array<[string, string | undefined]> = [];
      const runtime = createAutoToolsRuntime({ configPath: h.deps.configPath, reservedToolNames: h.deps.reservedToolNames, registerTool(): never { throw Error("No live host registration"); }, exec: async (): Promise<never> => { throw Error("No command execution"); } });
      const ctx = { hasUI: visible, get ui() { assert.equal(visible, true); return { notify(message: string, type?: "info" | "warning" | "error") { messages.push([message, type]); assert.equal(existsSync(join(h.root, "notice.json")), kind !== "deleted"); assert.equal(h.tools.has("notice"), kind !== "deleted"); } }; } };
      const result = await executeRegisterTool(params, ctx, { ...h.deps, notify: runtime.notify });
      assert.deepEqual(messages, visible ? [[registryNoticeExpected(kind, "notice"), "info"]] : []);
      assert.equal(result.details.tool, "notice"); assert.equal(existsSync(join(h.root, "notice.json")), kind !== "deleted");
      assert.equal(h.tools.has("notice"), kind !== "deleted");
    } finally { await h.cleanup(); }
  }
  const opaque = Object.freeze({ toString(): never { throw Error("Do not coerce notification failure"); } });
  for (const cause of [undefined, "PRIVATE_PRIMITIVE", opaque]) {
    const { h, params } = await prepareRegistryNotice(kind); let calls = 0, rejected = false;
    try {
      try { await executeRegisterTool(params, {}, { ...h.deps, notify(_ctx, message, type) {
        calls++; assert.equal(message, registryNoticeExpected(kind, "notice")); assert.equal(type, "info");
        assert.equal(existsSync(join(h.root, "notice.json")), kind !== "deleted"); assert.equal(h.tools.has("notice"), kind !== "deleted"); throw cause;
      } }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.equal(calls, 1); assert.equal(existsSync(join(h.root, "notice.json")), kind !== "deleted"); assert.equal(h.tools.has("notice"), kind !== "deleted");
    } finally { await h.cleanup(); }
  }
  const { h, params } = await prepareRegistryNotice(kind);
  try {
    const messages: string[] = [];
    const runtime = createAutoToolsRuntime({ configPath: h.deps.configPath, reservedToolNames: h.deps.reservedToolNames, registerTool(): never { throw Error("No live host registration"); }, exec: async (): Promise<never> => { throw Error("No command execution"); } });
    const ctx = { hasUI: true, ui: { notify: (message: string) => messages.push(message) } };
    const definition = createRegisterToolDefinition({ ...h.deps, notify: runtime.notify });
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")), manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import, { runToolCall } = await import(new URL(entry, pathToFileURL(manifest)).href); let calls = 0;
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, ctx); } };
    const call = { type: "toolCall", id: "host-registry-notice", name: "register_tool", arguments: params };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(calls, 1); assert.equal(outcome.isError, false); assert.deepEqual(messages, [registryNoticeExpected(kind, "notice")]); assert.equal(outcome.result.details.tool, "notice");
  } finally { await h.cleanup(); }
});

test("AX registry notices preserve selected-name coercion and native literal wrapping without a model cap", async () => {
  const stop = Object.freeze({ stop: "after notice observation" });
  for (const kind of ["activated", "promoted", "deleted"] as const) for (const value of ["name\r\n# Heading\n- next: data\n  tool: data", "界👩‍💻é".repeat(2000), "bad\ud800"]) {
    const { h, params } = await prepareRegistryNotice(kind); let selected = false, conversions = 0, message: string | undefined, rejected = false;
    class LegacyName {
      trim() { return this; } toLowerCase() { return this; } replace() { return this; } slice() { return this; }
      [Symbol.toPrimitive]() { if (selected) { conversions++; return value; } return "notice"; }
    }
    const name = new LegacyName() as unknown as string;
    const tools = kind === "deleted" ? new Map([[name, h.tools.get("notice")!]]) : h.tools;
    try {
      try { await executeRegisterTool({ ...params, name }, {}, { ...h.deps, getTools: () => tools, get notify() {
        selected = true; return (_ctx: unknown, text: string, type: "info" | "warning" | "error") => { message = text; assert.equal(type, "info"); throw stop; };
      } }); } catch (error) { rejected = true; assert.equal(error, stop); }
      assert.equal(rejected, true); assert.equal(conversions, 1, "The old name interpolation occurs once after notify lookup"); assert.ok(message); assert.ok(message.isWellFormed());
      assert.ok(message.startsWith("- report: " + registryNoticeReport[kind] + "\n"));
      if (value.isWellFormed()) {
        if (/[\r\n]/u.test(value)) assert.ok(message.endsWith("- tool:\n  name\r\n  # Heading\n  - next: data\n    tool: data"));
        else { assert.equal(message, registryNoticeExpected(kind, value)); assert.ok(Buffer.byteLength(message) > 16384, "Ordinary notify retains full value; model cap is not borrowed"); }
        for (const width of [24, 52, 90, 140]) {
          const lines = new Text(message, 1, 0).render(width);
          assert.ok(lines.every(line => visibleWidth(line) <= width));
          assert.ok(lines.some(line => stripTerminalSequences(line).includes("- report:")));
          assert.ok(lines.some(line => stripTerminalSequences(line).includes("- tool:")));
        }
      } else assert.equal(message, "- report: " + registryNoticeReport[kind] + "\n- tool: [unavailable]\n- tool_omission:\n  - reason: malformed_selected_text\n  - shown: 0\n  - omitted: 1\n  - total: 1");
    } finally { await h.cleanup(); }
  }
});

const transactionMessage = (stage: string, generation: string, summary: string, error: string) =>
  registryDocument({ result: "Tool registration transaction failed.", stage, resolution_generation: generation, active_skills_summary: summary, error });

async function captureTransactionText(h: Awaited<ReturnType<typeof createHarness>>, generation: string, summary: string[], message: string, failAt?: string, cause?: unknown) {
  const events: string[] = [], NativeError = Error, lower = new NativeError("PRIVATE_ORIGINAL", { cause: "PRIVATE_CAUSE" }); let skills = 0, rejected = false, error: unknown;
  const selected = { [Symbol.toPrimitive]() { events.push("error_coerce"); if (failAt === "error_coerce") throw cause; return message; } };
  Object.defineProperty(lower, "message", { get() { events.push("message"); if (failAt === "message") throw cause; return selected; } });
  const context = { cwd: h.root, sessionId: "PRIVATE_SESSION", get generation() { events.push("generation"); if (failAt === "generation") throw cause; return { [Symbol.toPrimitive]() { events.push("generation_coerce"); if (failAt === "generation_coerce") throw cause; return generation; } } as unknown as string; }, get activeSkills() {
    if (++skills <= 2) { events.push("skills:" + skills); return { namespaces: {} }; }
    events.push("summary"); if (failAt === "summary") throw cause; return { namespaces: Object.fromEntries(summary.map(name => [name, []])) };
  } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Error")!;
  Object.defineProperty(globalThis, "Error", { configurable: true, get() { events.push("Error_lookup"); return NativeError; } });
  try { await executeRegisterTool({ name: "transaction_text", description: "Description", template: "echo" }, {}, { ...h.deps, getRecipeResolutionContext: () => context,
    registerRuntimeTool(cfg) { events.push("activate"); assert.equal(h.tools.get("transaction_text"), cfg); assert.equal(existsSync(join(h.root, "transaction_text.json")), true); throw lower; },
    setActiveTools(names) { events.push("setActive"); h.deps.setActiveTools(names); }, notify(): never { throw new NativeError("No notice"); },
  }); } catch (caught) { rejected = true; error = caught; }
  finally { Object.defineProperty(globalThis, "Error", descriptor); }
  assert.equal(rejected, true); assert.equal(existsSync(join(h.root, "transaction_text.json")), false); assert.equal(h.tools.has("transaction_text"), false);
  assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "Error"), descriptor); return { error, events };
}

test("AX transaction failure text preserves real stage effects, restoration and cleanup faults", async () => {
  const h = await createHarness(), primary = new Error("PRIMARY_ACTIVATION"), token = Object.freeze({ toString(): never { throw Error("Do not coerce cleanup fault"); } });
  const context = createRecipeResolutionContext("transaction-test", h.root, createActiveSkillRecipeContext([]));
  try {
    for (const existing of [false, true]) {
      h.tools.clear(); await rm(join(h.root, "transaction_case.json"), { force: true });
      if (existing) await executeRegisterTool({ name: "transaction_case", description: "Old", template: "echo old" }, {}, h.deps);
      h.runtimeRegistered.length = 0; h.notifications.length = 0;
      const path = join(h.root, "transaction_case.json"), before = existing ? await readFile(path, "utf8") : undefined, events: string[] = [];
      await assert.rejects(executeRegisterTool({ name: "transaction_case", update: true, description: "New", template: "echo new" }, {}, { ...h.deps, getRecipeResolutionContext: () => context,
        registerRuntimeTool(cfg) { events.push("register:" + cfg.description); assert.equal(h.tools.get("transaction_case"), cfg); assert.equal(JSON.parse(readFileSync(path, "utf8")).description, cfg.description); if (cfg.description === "New") throw primary; },
        setActiveTools(names) { events.push("setActive"); h.deps.setActiveTools(names); },
      }), (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message, transactionMessage("runtime_activation", context.generation, "<none>", primary.message)); return true; });
      assert.deepEqual(events, ["register:New", ...(existing ? ["register:Old"] : []), "setActive"]);
      assert.equal(existsSync(path), existing); if (existing) assert.equal(await readFile(path, "utf8"), before);
      assert.equal(h.tools.get("transaction_case")?.description, existing ? "Old" : undefined);
    }
    h.tools.clear(); h.notifications.length = 0;
    let skills = 0;
    const invalidPersisted = { ...context, get activeSkills() { if (++skills === 2) throw new Error("PERSISTED_ADMISSION"); return createActiveSkillRecipeContext([]); } };
    await assert.rejects(executeRegisterTool({ name: "admission_tx", description: "Description", template: "echo" }, {}, { ...h.deps, getRecipeResolutionContext: () => invalidPersisted }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, transactionMessage("persisted_admission", context.generation, "<none>", "Persisted tool recipe admission failed: PERSISTED_ADMISSION")); return true;
    }); assert.equal(existsSync(join(h.root, "admission_tx.json")), false);
    await mkdir(h.root, { recursive: true }); const blocker = join(h.root, "not-directory"); await writeFile(blocker, "BLOCKER"); let roots = 0;
    await assert.rejects(executeRegisterTool({ name: "persist_tx", description: "Description", template: "echo" }, {}, { ...h.deps, getRecipeResolutionContext: () => context, get recipeRoot() { return ++roots === 4 ? blocker : h.root; } }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /\nstage: "persist"\n/u); assert.match(error.message, /ENOTDIR|EEXIST/u); return true;
    }); assert.equal(roots, 4); assert.equal(await readFile(blocker, "utf8"), "BLOCKER");
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const position of ["delete", "reactivate", "setActive"]) {
      h.tools.clear(); await rm(join(h.root, "cleanup_tx.json"), { force: true });
      if (position === "reactivate") await executeRegisterTool({ name: "cleanup_tx", description: "Old", template: "echo old" }, {}, h.deps);
      const tools = new Map(h.tools); const originalDelete = tools.delete;
      tools.delete = function(name) { if (position === "delete") throw cause; return originalDelete.call(this, name); };
      let calls = 0, rejected = false;
      try { await executeRegisterTool({ name: "cleanup_tx", update: true, description: "New", template: "echo new" }, {}, { ...h.deps, getTools: () => tools,
        registerRuntimeTool() { if (++calls === 1) throw primary; if (position === "reactivate") throw cause; },
        setActiveTools(names) { if (position === "setActive") throw cause; h.deps.setActiveTools(names); },
      }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.equal(calls, position === "reactivate" ? 2 : 1);
      assert.equal(existsSync(join(h.root, "cleanup_tx.json")), position === "reactivate");
      assert.equal(tools.get("cleanup_tx")?.description, position === "delete" ? "New" : position === "reactivate" ? "Old" : undefined);
    }
    h.tools.clear(); h.notifications.length = 0; h.runtimeRegistered.length = 0;
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")), manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import, { runToolCall } = await import(new URL(entry, pathToFileURL(manifest)).href);
    const definition = createRegisterToolDefinition({ ...h.deps, getRecipeResolutionContext: () => context, registerRuntimeTool(): never { throw new Error("SDK_ACTIVATION"); } }); let calls = 0;
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
    const call = { type: "toolCall", id: "host-transaction", name: "register_tool", arguments: { name: "host_transaction", description: "Description", template: "echo" } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, transactionMessage("runtime_activation", context.generation, "<none>", "SDK_ACTIVATION")); assert.deepEqual(outcome.result.details, {});
    assert.equal(existsSync(join(h.root, "host_transaction.json")), false); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX transaction post-cleanup template keeps coercion order, raw faults and whole-field bounds", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce secondary fault"); } });
  const order = ["skills:1", "skills:2", "activate", "setActive", "Error_lookup", "generation", "generation_coerce", "summary", "Error_lookup", "message", "error_coerce"];
  try {
    const result = await captureTransactionText(h, "RESOLUTION", ["zeta", "alpha, beta"], "  message\n"); assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, transactionMessage("runtime_activation", "RESOLUTION", "alpha, beta, zeta", "  message\n")); assert.deepEqual(result.events, order);
    assert.deepEqual(Object.keys(result.error), []); assert.equal(Object.hasOwn(result.error, "cause"), false);
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const stage of ["generation", "generation_coerce", "summary", "message", "error_coerce"]) {
      const fault = await captureTransactionText(h, "RESOLUTION", [], "message", stage, cause); assert.equal(fault.error, cause); assert.deepEqual(fault.events, order.slice(0, order.indexOf(stage) + 1));
    }
    const read = async (generation: string, summary: string, error: string) => { const result = await captureTransactionText(h, generation, summary === "<none>" ? [] : [summary], error); assert.ok(result.error instanceof Error); assert.ok(result.error.message.isWellFormed()); assert.ok(Buffer.byteLength(result.error.message) <= 16384); return result.error.message; };
    for (const key of ["resolution_generation", "active_skills_summary", "error"]) {
      const values = ["RESOLUTION", "<none>", "message"], slot = ["resolution_generation", "active_skills_summary", "error"].indexOf(key);
      const minimal = [...values]; minimal[slot] = "x"; const width = 16384 - Buffer.byteLength(transactionMessage("runtime_activation", minimal[0], minimal[1], minimal[2])) + 1;
      const exact = [...values]; exact[slot] = "x".repeat(width); assert.equal(await read(exact[0], exact[1], exact[2]), transactionMessage("runtime_activation", exact[0], exact[1], exact[2]));
      const overflow = [...values]; overflow[slot] = "x".repeat(width + 1); assert.match(await read(overflow[0], overflow[1], overflow[2]), new RegExp("\\n" + key + ': "\\[omitted\\]"\\n' + key + '_omission:'));
      const malformed = [...values]; malformed[slot] = "bad\ud800"; assert.match(await read(malformed[0], malformed[1], malformed[2]), new RegExp("\\n" + key + ': "\\[unavailable\\]"\\n' + key + '_omission:\\n  reason: "malformed_selected_text"'));
      const unit = "界👩‍💻é", unicode = [...values]; unicode[slot] = unit.repeat(Math.floor(width / Buffer.byteLength(unit))) + "x".repeat(width % Buffer.byteLength(unit)); assert.equal(Buffer.byteLength(await read(unicode[0], unicode[1], unicode[2])), 16384);
    }
    for (const value of [undefined, "primitive", Symbol("selected")]) await assert.rejects(executeRegisterTool({ name: "primitive_tx", description: "Description", template: "echo" }, {}, { ...h.deps, registerRuntimeTool(): never { throw value; } }), (error: unknown) => { assert.ok(error instanceof Error); assert.ok(error.message.endsWith('error: ' + JSON.stringify(String(value)) + '\n')); return true; });
    let rejected = false;
    try { await executeRegisterTool({ name: "unprintable_tx", description: "Description", template: "echo" }, {}, { ...h.deps, registerRuntimeTool(): never { throw { toString(): never { throw token; } }; } }); }
    catch (error) { rejected = true; assert.equal(error, token); }
    assert.equal(rejected, true); assert.equal(existsSync(join(h.root, "unprintable_tx.json")), false); assert.equal(h.tools.has("unprintable_tx"), false);
  } finally { await h.cleanup(); }
});

async function captureCandidateRefusal(h: Awaited<ReturnType<typeof createHarness>>, branch: "source" | "recipe" | "falsy_from" | "draft", source = "alpha/task", diagnostic = "ADMISSION_MARKER", names: string[] = [], doctor = source, failAt?: string, cause?: unknown) {
  const events: string[] = []; let activeReads = 0, fromReads = 0, sourceReads = 0, rejected = false, error: unknown;
  const NativeError = Error, lower = new NativeError(diagnostic);
  const bounded = diagnostic.length <= 4096 ? diagnostic : diagnostic.slice(0, 4095) + "…";
  const sourceValue = { [Symbol.toPrimitive]() { const stage = ++sourceReads === 1 ? "source" : sourceReads === 2 ? "doctor_test" : "doctor_identity"; events.push(stage); if (failAt === stage) throw cause; return stage === "source" ? source : doctor; } };
  const context = { cwd: h.root, generation: "PRIVATE_GENERATION", sessionId: "PRIVATE_SESSION", get activeSkills() {
    if (++activeReads === 1) { events.push("admission"); throw lower; }
    events.push("summary"); if (failAt === "summary") throw cause; return { namespaces: Object.fromEntries(names.map(name => [name, []])) };
  } };
  const draft = join(h.root, "drafts", "candidate-observation.json");
  if (branch === "draft") { await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, JSON.stringify({ description: "Description", template: "echo" })); }
  const input = branch === "draft" ? { name: "candidate_error", draft } : branch === "recipe" ? { name: "candidate_error", description: "Description", template: "echo" }
    : { name: "candidate_error", description: "Description", get from() { fromReads++; return fromReads === 4 ? { trim: () => branch === "falsy_from" ? "" : sourceValue } : "alpha/task"; } };
  const joinDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "join")!;
  const errorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Error")!;
  const nativeJoin = Array.prototype.join;
  const selected = (value: unknown) => Array.isArray(value) && value.length === 1 && value[0] === bounded;
  // Serialize hooks around one awaited real admission; never replace its returned result.
  Object.defineProperty(Array.prototype, "join", { configurable: true, get() {
    if (selected(this)) { events.push("join_get"); if (failAt === "join_get") throw cause; }
    return function(this: unknown[], ...args: unknown[]) {
      if (selected(this) && args[0] === "; ") {
        events.push("join"); if (failAt === "join") throw cause;
        const value = Reflect.apply(nativeJoin, this, args);
        return { [Symbol.toPrimitive]() { events.push("diagnostics"); if (failAt === "diagnostics") throw cause; return value; } };
      }
      return Reflect.apply(nativeJoin, this, args);
    };
  } });
  Object.defineProperty(globalThis, "Error", { configurable: true, get() { events.push("Error_lookup"); return NativeError; } });
  try { await executeRegisterTool(input, {}, { ...h.deps, getRecipeResolutionContext: () => context,
    getActiveTools(): never { throw new NativeError("Refusal precedes activation"); }, registerRuntimeTool(): never { throw new NativeError("No dispatch"); }, notify(): never { throw new NativeError("No notice"); },
  }); } catch (caught) { rejected = true; error = caught; }
  finally { Object.defineProperty(Array.prototype, "join", joinDescriptor); Object.defineProperty(globalThis, "Error", errorDescriptor); }
  assert.equal(rejected, true); return { error, events, bounded, activeReads, fromReads };
}

async function captureRawDraftFailure(h: Awaited<ReturnType<typeof createHarness>>, reason: string | undefined, failAt?: string, cause?: unknown) {
  const draft = join(h.root, "drafts", "raw-observation.json"); await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, "null");
  const NativeError = Error, lower = new NativeError("PRIVATE_LOWER"), events: string[] = [];
  let reads = 0, stats = 0, rejected = false, error: unknown;
  const selected = { [Symbol.toPrimitive]() { events.push("reason"); if (failAt === "reason") throw cause; return reason; } };
  Object.defineProperty(lower, "message", { get() { events.push("message"); if (failAt === "message") throw cause; return reason === undefined ? undefined : selected; } });
  const readDescriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync")!, statDescriptor = Object.getOwnPropertyDescriptor(fs, "statSync")!;
  const errorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Error")!;
  Object.defineProperty(fs, "readFileSync", { ...readDescriptor, value: function(...args: unknown[]) {
    if (args[0] === draft) { events.push("read:" + ++reads); if (reads === 2) throw lower; }
    return Reflect.apply(readDescriptor.value, fs, args);
  } });
  Object.defineProperty(fs, "statSync", { ...statDescriptor, value: function(...args: unknown[]) {
    if (args[0] === draft) { events.push("stat:" + ++stats); if (stats === 2 && failAt === "stat") throw cause; }
    return Reflect.apply(statDescriptor.value, fs, args);
  } });
  syncBuiltinESMExports();
  Object.defineProperty(globalThis, "Error", { configurable: true, get() { events.push("Error_lookup"); return NativeError; } });
  try { await executeRegisterTool({ name: "raw_draft_error", draft }, {}, { ...h.deps,
    getRecipeResolutionContext(): never { throw new NativeError("Raw refusal precedes context"); }, registerRuntimeTool(): never { throw new NativeError("No dispatch"); }, notify(): never { throw new NativeError("No notice"); },
  }); } catch (caught) { rejected = true; error = caught; }
  finally { Object.defineProperty(globalThis, "Error", errorDescriptor); Object.defineProperty(fs, "readFileSync", readDescriptor); Object.defineProperty(fs, "statSync", statDescriptor); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync, readDescriptor.value); assert.equal(readFileSync, readDescriptor.value); assert.equal(fs.statSync, statDescriptor.value);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "Error"), errorDescriptor);
  assert.equal(rejected, true); assert.equal(await readFile(draft, "utf8"), "null"); return { error, events };
}

const draftInvalidHeader = registryDocument({ field: "draft", result: "Draft recipe is invalid." });
const draftInvalid = (key: "reason" | "diagnostics_summary", value: string) =>
  registryDocument({ field: "draft", result: "Draft recipe is invalid.", [key]: value });

test("AX draft raw refusal preserves two reads, reason presence and raw faults", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce secondary fault"); } });
  const order = ["stat:1", "read:1", "stat:2", "read:2", "Error_lookup", "message", "Error_lookup", "reason"];
  try {
    for (const reason of [undefined, "", "RAW_REASON"]) {
      const result = await captureRawDraftFailure(h, reason);
      assert.ok(result.error instanceof Error); assert.equal(result.error.message, reason === undefined ? draftInvalidHeader : draftInvalid("reason", reason));
      assert.deepEqual(result.events, reason === undefined ? order.slice(0, -1) : order);
      assert.deepEqual(Object.keys(result.error), []); assert.equal(Object.hasOwn(result.error, "cause"), false);
    }
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const stage of ["stat", "message", "reason"]) {
      const result = await captureRawDraftFailure(h, "RAW_REASON", stage, cause); assert.equal(result.error, cause);
      assert.deepEqual(result.events, stage === "stat" ? order.slice(0, 3) : order.slice(0, order.indexOf(stage) + 1));
    }
    const size = exactFit(reason => ({ field: "draft", result: "Draft recipe is invalid.", reason }));
    for (const payload of ["x".repeat(size), "界".repeat(Math.floor(size / 3)) + "x".repeat(size % 3)]) {
      const result = await captureRawDraftFailure(h, payload); assert.ok(result.error instanceof Error); assert.equal(result.error.message, draftInvalid("reason", payload)); assert.equal(Buffer.byteLength(result.error.message), 16384);
    }
    const overflow = await captureRawDraftFailure(h, "x".repeat(size + 1)); assert.ok(overflow.error instanceof Error); assert.match(overflow.error.message, /reason: "\[omitted\]"\nreason_omission:/u);
    const malformed = await captureRawDraftFailure(h, "bad\ud800"); assert.ok(malformed.error instanceof Error); assert.match(malformed.error.message, /\nreason: "\[unavailable\]"\nreason_omission:\n  reason: "malformed_selected_text"/u);
    const opaque = await captureRawDraftFailure(h, "# Heading\r\n- next: data\n  tool: data"); assert.ok(opaque.error instanceof Error); assert.equal(opaque.error.message, draftInvalid("reason", "# Heading\r\n- next: data\n  tool: data"));
    const draft = join(h.root, "drafts", "sdk-invalid.json"); await writeFile(draft, "null");
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")), manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import, { runToolCall } = await import(new URL(entry, pathToFileURL(manifest)).href);
    const definition = createRegisterToolDefinition(h.deps); let calls = 0;
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
    const call = { type: "toolCall", id: "host-raw-draft", name: "register_tool", arguments: { name: "host_raw", draft } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, draftInvalid("reason", "JSON recipe must be an object")); assert.deepEqual(outcome.result.details, {});
    assert.equal(h.tools.size, 0); assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX draft candidate refusal preserves real admission join after Error lookup and legacy cap", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce secondary fault"); } });
  const order = ["admission", "Error_lookup", "Error_lookup", "join_get", "join", "diagnostics"];
  try {
    const result = await captureCandidateRefusal(h, "draft"); assert.ok(result.error instanceof Error); assert.equal(result.error.message, draftInvalid("diagnostics_summary", "ADMISSION_MARKER")); assert.deepEqual(result.events, order);
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const stage of ["join_get", "join", "diagnostics"]) {
      const fault = await captureCandidateRefusal(h, "draft", "unused", "ADMISSION_MARKER", [], "unused", stage, cause); assert.equal(fault.error, cause); assert.deepEqual(fault.events, order.slice(0, order.indexOf(stage) + 1));
    }
    const original = "界".repeat(5000), bounded = original.slice(0, 4095) + "…";
    const capped = await captureCandidateRefusal(h, "draft", "unused", original); assert.ok(capped.error instanceof Error); assert.equal(capped.error.message, draftInvalid("diagnostics_summary", bounded)); assert.equal(capped.bounded, bounded);
    const malformed = await captureCandidateRefusal(h, "draft", "unused", "x".repeat(4094) + "😀tail"); assert.ok(malformed.error instanceof Error); assert.match(malformed.error.message, /\ndiagnostics_summary: "\[unavailable\]"\ndiagnostics_summary_omission:/u);
    const draft = join(h.root, "drafts", "sdk-candidate.json"); await writeFile(draft, JSON.stringify({ description: "Description", template: "echo" }));
    const marker = "SDK_DRAFT_ADMISSION", context = { cwd: h.root, generation: "PRIVATE_GENERATION", sessionId: "PRIVATE_SESSION", get activeSkills(): never { throw new Error(marker); } };
    const definition = createRegisterToolDefinition({ ...h.deps, getRecipeResolutionContext: () => context });
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")), manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import, { runToolCall } = await import(new URL(entry, pathToFileURL(manifest)).href); let calls = 0;
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
    const call = { type: "toolCall", id: "host-draft-admission", name: "register_tool", arguments: { name: "host_candidate", draft } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, draftInvalid("diagnostics_summary", marker)); assert.deepEqual(outcome.result.details, {});
    assert.equal(existsSync(join(h.root, "candidate_error.json")), false); assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

const candidateMessage = (diagnostics: string, source?: string, summary = "<none>", instruction = "inspect target=recipes view=doctor identity=alpha/task") =>
  registryDocument({ field: "recipe", ...(source === undefined ? {} : { source }),
    result: source === undefined ? "Tool recipe validation failed." : "Recipe source validation failed.",
    diagnostics_summary: diagnostics, ...(source === undefined ? {} : { active_skills_summary: summary, instruction }) });

for (const branch of ["source", "recipe"] as const) test(`AX candidate admission ${branch} refusal preserves real admission and branch evidence`, async () => {
  const h = await createHarness();
  try {
    const result = await captureCandidateRefusal(h, branch, "alpha/task", "ADMISSION_MARKER", ["zeta", "alpha, beta"]);
    assert.ok(result.error instanceof Error); assert.equal(result.error.message, candidateMessage("ADMISSION_MARKER", branch === "source" ? "alpha/task" : undefined, "alpha, beta, zeta"));
    assert.equal(Object.getPrototypeOf(result.error), Error.prototype); assert.deepEqual(Object.keys(result.error), []); assert.equal(Object.hasOwn(result.error, "cause"), false);
    assert.equal(result.activeReads, branch === "source" ? 2 : 1); assert.equal(existsSync(join(h.root, "candidate_error.json")), false);
    const marker = "SDK_ADMISSION_MARKER"; let active = 0;
    const context = { cwd: h.root, generation: "PRIVATE_GENERATION", sessionId: "PRIVATE_SESSION", get activeSkills() { if (++active === 1) throw new Error(marker); return createActiveSkillRecipeContext([]); } };
    const definition = createRegisterToolDefinition({ ...h.deps, getRecipeResolutionContext: () => context });
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"), entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(manifest)).href);
    let calls = 0; const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
    const call = { type: "toolCall", id: "host-candidate", name: "register_tool", arguments: branch === "source" ? { name: "host_candidate", from: "alpha/task" } : { name: "host_candidate", description: "Description", template: "echo" } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, candidateMessage(marker, branch === "source" ? "alpha/task" : undefined)); assert.deepEqual(outcome.result.details, {});
    assert.equal(h.tools.size, 0); assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX candidate refusal preserves pre-Error join, branch and secondary fault observations", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce secondary fault"); } });
  const order = ["admission", "Error_lookup", "source", "join_get", "join", "diagnostics", "summary", "doctor_test", "doctor_identity", "Error_lookup"];
  try {
    const source = await captureCandidateRefusal(h, "source", "shown", "ADMISSION_MARKER", [], "other/task");
    assert.deepEqual(source.events, order); assert.ok(source.error instanceof Error); assert.equal(source.error.message, candidateMessage("ADMISSION_MARKER", "shown", "<none>", "inspect target=recipes view=doctor identity=other/task"));
    for (const branch of ["recipe", "falsy_from"] as const) {
      const result = await captureCandidateRefusal(h, branch); assert.deepEqual(result.events, ["admission", "Error_lookup", "join_get", "join", "diagnostics", "Error_lookup"]);
      assert.ok(result.error instanceof Error); assert.equal(result.error.message, candidateMessage("ADMISSION_MARKER")); assert.equal(result.activeReads, 1);
    }
    const emptyDisplay = await captureCandidateRefusal(h, "source", "", "ADMISSION_MARKER", [], "invalid");
    assert.ok(emptyDisplay.error instanceof Error); assert.equal(emptyDisplay.error.message, candidateMessage("ADMISSION_MARKER", "", "<none>", "inspect target=recipes view=doctor"));
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const stage of ["source", "join_get", "join", "diagnostics", "summary", "doctor_test", "doctor_identity"]) {
      const result = await captureCandidateRefusal(h, "source", "shown", "ADMISSION_MARKER", [], "other/task", stage, cause);
      assert.equal(result.error, cause); assert.deepEqual(result.events, order.slice(0, order.indexOf(stage) + 1));
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX candidate refusal preserves legacy diagnostic cap and whole-field response bounds", async () => {
  const h = await createHarness();
  const read = async (source: string, diagnostics: string, summary = "<none>", doctor = "invalid", branch: "source" | "recipe" = "source") => {
    const result = await captureCandidateRefusal(h, branch, source, diagnostics, summary === "<none>" ? [] : [summary], doctor);
    assert.ok(result.error instanceof Error); assert.ok(result.error.message.isWellFormed()); assert.ok(Buffer.byteLength(result.error.message) <= 16384); return { text: result.error.message, bounded: result.bounded };
  };
  try {
    const original = "界".repeat(5000), capped = original.slice(0, 4095) + "…";
    assert.deepEqual(await read("alpha/task", original, "<none>", "invalid", "recipe"), { text: candidateMessage(capped), bounded: capped });
    const malformed = "x".repeat(4094) + "😀tail";
    const unavailable = await read("alpha/task", malformed, "<none>", "invalid", "recipe");
    assert.equal(unavailable.bounded.isWellFormed(), false); assert.match(unavailable.text, /\ndiagnostics_summary: "\[unavailable\]"\ndiagnostics_summary_omission:\n  reason: "malformed_selected_text"/u);
    const hint = "inspect target=recipes view=doctor";
    for (const key of ["source", "active_skills_summary"]) {
      const base = candidateMessage("ADMISSION_MARKER", key === "source" ? "x" : "short", key === "active_skills_summary" ? "x" : "<none>", hint);
      const width = 16384 - Buffer.byteLength(base) + 1;
      const source = key === "source" ? "x".repeat(width) : "short", summary = key === "active_skills_summary" ? "x".repeat(width) : "<none>";
      assert.equal((await read(source, "ADMISSION_MARKER", summary)).text, candidateMessage("ADMISSION_MARKER", source, summary, hint));
      assert.match((await read(key === "source" ? source + "x" : source, "ADMISSION_MARKER", key === "active_skills_summary" ? summary + "x" : summary)).text, new RegExp("\\n" + key + ': "\\[omitted\\]"\\n' + key + '_omission:'));
      const unit = "界👩‍💻é", unicode = unit.repeat(Math.floor(width / Buffer.byteLength(unit))) + "x".repeat(width % Buffer.byteLength(unit));
      assert.equal(Buffer.byteLength((await read(key === "source" ? unicode : source, "ADMISSION_MARKER", key === "active_skills_summary" ? unicode : summary)).text), 16384);
      assert.match((await read(key === "source" ? "bad\ud800" : "short", "ADMISSION_MARKER", key === "active_skills_summary" ? "bad\ud800" : "<none>")).text, new RegExp("\\n" + key + ': "\\[unavailable\\]"'));
    }
    const doctorPrefix = "inspect target=recipes view=doctor identity=";
    const base = candidateMessage("ADMISSION_MARKER", "short", "<none>", doctorPrefix + "a/b");
    const width = 16384 - Buffer.byteLength(base) + 1, doctor = "a/" + "b".repeat(width);
    assert.equal(Buffer.byteLength((await read("short", "ADMISSION_MARKER", "<none>", doctor)).text), 16384);
    assert.match((await read("short", "ADMISSION_MARKER", "<none>", doctor + "b")).text, /\ninstruction: "\[omitted\]"\ninstruction_omission:/u);
    const opaque = "# Heading\r\n- next: data\n  tool: data", body = await read("bad`````source", opaque, "alpha, beta\r\nlabel: data");
    const bodyDocument = registryYaml(body.text);
    assert.equal(bodyDocument.source, "bad`````source");
    assert.equal(bodyDocument.diagnostics_summary, opaque);
    assert.deepEqual(Object.keys(bodyDocument), ["field", "source", "result", "diagnostics_summary", "active_skills_summary", "instruction"]);
  } finally { await h.cleanup(); }
});

async function captureSourceNormalization(h: Awaited<ReturnType<typeof createHarness>>, source: string, reason: string, names: string[] = [], doctor = source, failAt?: string, cause?: unknown) {
  const events: string[] = []; let reads = 0, conversions = 0, rejected = false, error: unknown;
  const selectedSource = {
    startsWith() { events.push("startsWith"); return false; },
    [Symbol.toPrimitive]() { const stage = ++conversions === 1 ? "source" : conversions === 2 ? "doctor_test" : "doctor_identity"; events.push(stage); if (failAt === stage) throw cause; return stage === "source" ? source : doctor; },
  };
  const selectedReason = { [Symbol.toPrimitive]() { events.push("reason"); if (failAt === "reason") throw cause; return reason; } };
  const original = new Error("PRIVATE_ORIGINAL", { cause: "PRIVATE_CAUSE" });
  Object.defineProperty(original, "message", { get() { events.push("message"); if (failAt === "message") throw cause; return { trim() { events.push("trim"); if (failAt === "trim") throw cause; return selectedReason; } }; } });
  const context = { cwd: h.root, generation: "PRIVATE_GENERATION", sessionId: "PRIVATE_SESSION", get activeSkills() {
    events.push("skills"); if (failAt === "skills") throw cause; return { namespaces: Object.fromEntries(names.map(name => [name, []])) };
  } };
  const input = { name: "source_failure", get from() { reads++; return reads === 4 ? { trim: () => selectedSource } : "alpha/task"; }, get description(): never { events.push("spread"); throw original; } };
  try { await executeRegisterTool(input, {}, { ...h.deps, getRecipeResolutionContext: () => context,
    getTools(): never { throw Error("No lookup after source refusal"); }, registerRuntimeTool(): never { throw Error("No dispatch"); }, notify(): never { throw Error("No notice"); },
  }); } catch (caught) { rejected = true; error = caught; }
  assert.equal(rejected, true); assert.equal(reads, 6); return { error, events };
}

const sourceFailureMessage = (source: string, reason: string, summary: string, instruction: string) =>
  registryDocument({ field: "from", source, result: "Recipe source is invalid.", reason, active_skills_summary: summary, instruction });

test("AX public source normalization preserves owned reasons, legacy summary and SDK errors", async () => {
  const h = await createHarness();
  try {
    const names = ["alpha, beta", ...Array.from({ length: 22 }, (_, i) => "skill" + String(i).padStart(2, "0"))];
    const context = createRecipeResolutionContext("source-test", h.root, createActiveSkillRecipeContext(names.map(name => ({ name, baseDir: join(h.root, "unused") }))));
    const summary = [...names].sort().slice(0, 20).join(", ");
    const cases = [
      ["std:old", "std: Recipe references were removed; use <skill>/<recipe> or an explicit .json/.md file path.", "inspect target=recipes view=doctor"],
      ["skill:alpha/task", "skill: Recipe references were removed; use alpha/task without a prefix.", "inspect target=recipes view=doctor identity=alpha/task"],
      ["invalid", "Tool from must use <skill>/<recipe> or an explicit .json/.md file path.", "inspect target=recipes view=doctor"],
    ];
    const deps = { ...h.deps, getRecipeResolutionContext: () => context };
    for (const [source, reason, hint] of cases) await assert.rejects(executeRegisterTool({ name: "bad_source", from: source }, {}, deps), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, sourceFailureMessage(source, reason, summary, hint)); assert.equal(Object.getPrototypeOf(error), Error.prototype);
      assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false); assert.doesNotMatch(error.message, /- next:|PRIVATE_|not applied|no effects/u); return true;
    });
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(deps);
    for (const [source, reason, hint] of cases.slice(0, 2)) {
      let calls = 0; const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-source-normalization", name: "register_tool", arguments: { name: "host_source", from: source } };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, sourceFailureMessage(source, reason, summary, hint)); assert.deepEqual(outcome.result.details, {});
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX source normalization keeps catch extent and original template and summary fault order", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce secondary fault"); } });
  const order = ["spread", "message", "trim", "startsWith", "source", "reason", "skills", "doctor_test", "doctor_identity"];
  try {
    const captured = await captureSourceNormalization(h, "displayed", "why", ["zeta", "alpha, beta"], "other/task");
    assert.ok(captured.error instanceof Error); assert.equal(captured.error.message, sourceFailureMessage("displayed", "why", "alpha, beta, zeta", "inspect target=recipes view=doctor identity=other/task"));
    assert.deepEqual(captured.events, order, "Display source and diagnostic hint may disagree; preserve old observations rather than repairing identity");
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const stage of ["message", "trim", "source", "reason", "skills", "doctor_test", "doctor_identity"]) {
      const result = await captureSourceNormalization(h, "displayed", "why", [], "alpha/task", stage, cause);
      assert.equal(result.error, cause); assert.deepEqual(result.events, order.slice(0, order.indexOf(stage) + 1));
    }
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const point of [3, 5]) {
      let reads = 0, rejected = false;
      try { await executeRegisterTool({ name: "outside_catch", get from() { if (++reads === point) throw cause; return "alpha/task"; } }, {}, h.deps); }
      catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.equal(reads, point);
    }
    for (const thrown of [undefined, "primitive", Symbol("selected")]) {
      await assert.rejects(executeRegisterTool({ name: "spread_failure", from: "alpha/task", get description(): never { throw thrown; } }, {}, h.deps), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.message, sourceFailureMessage("alpha/task", String(thrown), "<none>", "inspect target=recipes view=doctor identity=alpha/task")); return true;
      });
    }
    let rejected = false;
    try { await executeRegisterTool({ name: "string_fault", from: "alpha/task", get description(): never { throw { toString(): never { throw token; } }; } }, {}, h.deps); }
    catch (error) { rejected = true; assert.equal(error, token); } assert.equal(rejected, true);
    let fromReads = 0;
    await assert.rejects(executeRegisterTool({ name: "missing_display", get from() { return ++fromReads === 3 ? undefined : "alpha/task"; }, get description(): never { throw "why"; } }, {}, h.deps), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, sourceFailureMessage("undefined", "why", "<none>", "inspect target=recipes view=doctor")); return true;
    }); assert.equal(fromReads, 5);
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX source normalization fits whole selected fields with truthful omissions and opaque Markdown", async () => {
  const h = await createHarness();
  try {
    const normalHint = "inspect target=recipes view=doctor";
    const get = async (source: string, reason: string, summary: string, doctor = "invalid") => {
      const result = await captureSourceNormalization(h, source, reason, summary === "<none>" ? [] : [summary], doctor);
      assert.ok(result.error instanceof Error); const text = result.error.message;
      assert.ok(text.isWellFormed()); assert.ok(Buffer.byteLength(text) <= 16384); return text;
    };
    for (const key of ["source", "reason", "active_skills_summary"]) {
      const args = ["short", "why", "<none>"]; const slot = ["source", "reason", "active_skills_summary"].indexOf(key);
      const empty = [...args]; empty[slot] = "x";
      const base = sourceFailureMessage(empty[0], empty[1], empty[2], normalHint);
      const size = 16384 - Buffer.byteLength(base) + 1;
      const exact = [...args]; exact[slot] = "x".repeat(size);
      assert.equal(await get(exact[0], exact[1], exact[2]), sourceFailureMessage(exact[0], exact[1], exact[2], normalHint));
      const overflow = [...args]; overflow[slot] = "x".repeat(size + 1);
      assert.match(await get(overflow[0], overflow[1], overflow[2]), new RegExp("\\n" + key + ': "\\[omitted\\]"\\n' + key + '_omission:'));
      const malformed = [...args]; malformed[slot] = "bad\ud800";
      assert.match(await get(malformed[0], malformed[1], malformed[2]), new RegExp("\\n" + key + ': "\\[unavailable\\]"\\n' + key + '_omission:\\n  reason: "malformed_selected_text"'));
      const unit = "界👩‍💻é", unicode = [...args]; unicode[slot] = unit.repeat(Math.floor(size / Buffer.byteLength(unit))) + "x".repeat(size % Buffer.byteLength(unit));
      assert.equal(Buffer.byteLength(await get(unicode[0], unicode[1], unicode[2])), 16384);
    }
    const doctorPrefix = "inspect target=recipes view=doctor identity=";
    const base = sourceFailureMessage("short", "why", "<none>", doctorPrefix + "a/b");
    const width = 16384 - Buffer.byteLength(base) + 1;
    const exactDoctor = "a/" + "b".repeat(width);
    assert.equal(Buffer.byteLength(await get("short", "why", "<none>", exactDoctor)), 16384);
    assert.match(await get("short", "why", "<none>", exactDoctor + "b"), /\ninstruction: "\[omitted\]"\ninstruction_omission:/u);
    const opaque = "# Heading\r\n\r\n- next: forged\n  tool: not metadata\n`body`";
    const selected = await get("bad`````source", opaque, "a, b\r\nlabel: value");
    const selectedDocument = registryYaml(selected);
    assert.equal(selectedDocument.source, "bad`````source");
    assert.equal(selectedDocument.reason, opaque);
    assert.equal(selectedDocument.active_skills_summary, "a, b\r\nlabel: value");
    assert.deepEqual(Object.keys(selectedDocument), ["field", "source", "result", "reason", "active_skills_summary", "instruction"]);
    assert.ok(selected.endsWith("instruction: " + JSON.stringify(normalHint) + "\n"));
  } finally { await h.cleanup(); }
});

const draftPathFields = (kind: "root" | "missing") => kind === "root"
  ? { result: "Draft must be under the allowed root.", instruction: "Use inspect target=recipes view=summary to list drafts." }
  : { result: "Draft not found." };
const draftPathMessage = (kind: "root" | "missing", key: string, reference: string) =>
  registryDocument({ field: "draft", [key]: reference, ...draftPathFields(kind) });
const draftPathOmission = (kind: "root" | "missing", key: string, malformed = false) =>
  registryDocument({ field: "draft", [key]: malformed ? "[unavailable]" : "[omitted]",
    [key + "_omission"]: { reason: malformed ? "malformed_selected_text" : "response_too_large", shown: 0, omitted: 1, total: 1 },
    ...draftPathFields(kind) });

for (const kind of ["root", "missing"] as const) test(`AX draft path ${kind} refusal preserves selected literal and whole-reference bounds`, async () => {
  const h = await createHarness(), key = kind === "root" ? "allowed_root" : "path";
  const ref = (payload: string) => kind === "root" ? join(h.root, payload, "drafts") : join(h.root, "drafts", payload);
  const expected = (reference: string) => draftPathMessage(kind, key, reference);
  const capture = async (reference: string, caller?: string) => {
    let roots = 0, rejected = false, result: unknown;
    try { await executeRegisterTool({ name: "draft_path", draft: kind === "root" ? caller ?? join(h.root, "FORBIDDEN_CALLER") : reference }, {}, { ...h.deps,
      get recipeRoot() { roots++; return roots === 1 ? h.root : kind === "root" ? dirname(reference) : h.root; },
      getTools(): never { throw Error("Path guards precede tool lookup"); },
      getRecipeResolutionContext(): never { throw Error("No new context read"); },
      notify(): never { throw Error("No notice"); },
      registerRuntimeTool(): never { throw Error("No dispatch"); },
    }); } catch (error) { rejected = true; result = error; }
    assert.equal(rejected, true); assert.equal(roots, 2);
    assert.ok(result instanceof Error); assert.equal(Object.getPrototypeOf(result), Error.prototype); assert.deepEqual(Object.keys(result), []); assert.equal(Object.hasOwn(result, "cause"), false);
    assert.ok(result.message.isWellFormed()); assert.ok(Buffer.byteLength(result.message) <= 16384);
    assert.doesNotMatch(result.message, /FORBIDDEN_CALLER|- next:|not applied|no effects|callable_now|exists: true/u); return result.message;
  };
  try {
    const plain = ref("short"); assert.equal(await capture(plain), expected(plain));
    if (kind === "root") {
      assert.equal(await capture(plain, plain), expected(plain), "Equality still refuses");
      assert.equal(await capture(plain, join(plain, "..prefix")), expected(plain), "Original dot-prefix refusal is not repaired into a new containment rule");
    }
    const quoted = ref("literal`````界\r\nnext: data");
    assert.equal(await capture(quoted), expected(quoted));
    const allowance = exactFit(payload => ({ field: "draft", [key]: ref(payload), ...draftPathFields(kind) }));
    const exact = ref("x".repeat(allowance));
    assert.equal(await capture(exact), expected(exact)); assert.equal(Buffer.byteLength(expected(exact)), 16384);
    const omitted = draftPathOmission(kind, key);
    assert.equal(await capture(ref("x".repeat(allowance + 1))), omitted);
    const unit = "界👩‍💻é", payload = unit.repeat(Math.floor(allowance / Buffer.byteLength(unit))) + "x".repeat(allowance % Buffer.byteLength(unit));
    assert.ok(Buffer.byteLength(await capture(ref(payload))) <= 16384); assert.equal(await capture(ref(payload + "界")), omitted);
    assert.equal(await capture(ref("bad\ud800")), draftPathOmission(kind, key, true));
    assert.equal(h.tools.size, 0); assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX draft path refusals preserve root and draft observations, raw faults and actual SDK errors", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce fault"); } });
  const missing = join(h.root, "drafts", "missing.json"), outside = join(h.root, "FORBIDDEN_CALLER.json");
  try {
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const mode of ["outer_root", "guard_root", "draft_trim", "draft_string"]) {
      let roots = 0, drafts = 0, rejected = false;
      const input = { name: "path_fault", get draft() { drafts++;
        if (mode === "draft_trim" && drafts === 2) return { trim(): never { throw cause; } };
        if (mode === "draft_string" && drafts === 5) return { toString(): never { throw cause; } };
        return missing;
      } };
      try { await executeRegisterTool(input, {}, { ...h.deps, get recipeRoot() {
        roots++; if (mode === "outer_root" || mode === "guard_root" && roots === 2) throw cause; return h.root;
      } }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
      if (mode === "outer_root") assert.deepEqual([roots, drafts], [1, 0]);
      if (mode === "guard_root") assert.deepEqual([roots, drafts], [2, 5]);
      if (mode === "draft_trim") assert.deepEqual([roots, drafts], [1, 2]);
      if (mode === "draft_string") assert.deepEqual([roots, drafts], [1, 5]);
    }
    await assert.rejects(executeRegisterTool({ name: "bad_root", draft: missing }, {}, { ...h.deps, recipeRoot: {} as string }), (error: unknown) => {
      assert.ok(error instanceof TypeError); assert.doesNotMatch(error.message, /- field: draft/u); return true;
    });
    const existing = join(h.root, "drafts", "existing.json"), bytes = "PRIVATE_BODY_NOT_READ";
    await mkdir(dirname(existing), { recursive: true }); await writeFile(existing, bytes);
    let rejected = false;
    try { await executeRegisterTool({ name: "existing_path", draft: existing }, {}, { ...h.deps, getTools(): never { throw token; } }); }
    catch (error) { rejected = true; assert.equal(error, token); }
    assert.equal(rejected, true); assert.equal(await readFile(existing, "utf8"), bytes);
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    for (const [draft, kind, key, reference] of [[outside, "root", "allowed_root", resolve(h.root, "drafts")], [missing, "missing", "path", resolve(missing)]] as const) {
      let calls = 0;
      const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-draft-path", name: "register_tool", arguments: { name: "host_path", draft } };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, draftPathMessage(kind, key, reference)); assert.deepEqual(outcome.result.details, {});
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

const runtimeDefaultText = (key: string) => registryDocument({ field: "defaults", key,
  result: "Tool defaults cannot set runtime-owned input.", instruction: "remove that default and retry register_tool; the runtime supplies it." });

test("AX runtime-owned default refusal preserves finite first-key selection and copy order without values", async () => {
  const h = await createHarness(), draft = join(h.root, "drafts", "runtime-key.json");
  const bytes = JSON.stringify({ description: "PRIVATE_DRAFT", template: "echo untouched" });
  const names = ["owner_id", "recipe_dir", "run_instance_id", "runtime_state_root", "session_id", "skill_dir", "state_dir", "trace_file"];
  assert.deepEqual(RUNTIME_OWNED_RECIPE_INPUT_NAMES, names); assert.equal(Object.isFrozen(RUNTIME_OWNED_RECIPE_INPUT_NAMES), true);
  try {
    await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, bytes);
    const symbol = Symbol("private copied symbol");
    const groups: Array<[string, Array<string | symbol>]> = [...names.map(key => [key, [key]] as [string, string[]]),
      ["owner_id", ["17", "PRIVATE_SAFE", ...names, symbol]],
      ["trace_file", [...names].reverse()],
      ["runtime_state_root", ["OWNER_ID", " owner_id", "owner_id\ud800", "PRIVATE_SAFE", "runtime_state_root", "owner_id"]],
    ];
    for (const route of ["ordinary", "draft"]) for (const [selected, keys] of groups) {
      const copy: string[] = [], stages: string[] = []; let drafts = 0;
      const body = Object.fromEntries(keys.map(key => [key, Object.freeze({ toString(): never { throw Error("Do not stringify default values"); } })]));
      const ordered = Reflect.ownKeys(body);
      const defaults = new Proxy(body, {
        ownKeys(target) { copy.push("keys"); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { copy.push("descriptor:" + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
        get(target, key, receiver) { copy.push("value:" + String(key)); return Reflect.get(target, key, receiver); },
      });
      const input = { name: "runtime_key", from: "private-owner/reference", defaults,
        // Direct changing-getter promotion probe, not a two-source SDK DTO.
        get draft() { return route === "draft" && ++drafts > 1 ? draft : undefined; },
      };
      await assert.rejects(executeRegisterTool(input, {}, { ...h.deps,
        getRecipeResolutionContext() { stages.push("resolution"); return undefined; },
        getTools() { stages.push("getTools"); return h.tools; },
        getToolNameBlocker() { stages.push("blocker"); return undefined; },
        registerRuntimeTool(): never { throw Error("No dispatch"); },
        getActiveTools(): never { throw Error("No activation read"); },
        notify(): never { throw Error("No notice"); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.message, runtimeDefaultText(selected)); assert.equal(Object.getPrototypeOf(error), Error.prototype);
        assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false); assert.ok(error.message.isWellFormed()); assert.ok(Buffer.byteLength(error.message) < 1024);
        assert.doesNotMatch(error.message, /PRIVATE_|private-owner|- next:|no effects|not applied|callable_now|supported_keys/u); return true;
      });
      assert.deepEqual(copy, ["keys", ...ordered.flatMap(key => ["descriptor:" + String(key), "value:" + String(key)])]);
      assert.deepEqual(stages, [...(route === "ordinary" ? ["resolution"] : []), "getTools", "blocker"]);
      if (route === "draft") assert.equal(drafts, 5);
      assert.equal(await readFile(draft, "utf8"), bytes); assert.equal(existsSync(join(h.root, "runtime_key.json")), false);
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX runtime-owned default guard keeps late-copy faults, delegation condition and real SDK key order", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce fault"); } });
  try {
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) {
      const reads: string[] = []; let rejected = false;
      const defaults = { get owner_id() { reads.push("owner"); return "PRIVATE_VALUE"; }, get tail(): never { reads.push("tail"); throw cause; } };
      try { await executeRegisterTool({ name: "copy_fault", from: "private-owner/reference", defaults }, {}, h.deps); }
      catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.deepEqual(reads, ["owner", "tail"], "Do not refuse before the original full copy finishes");
      let templates = 0; rejected = false;
      try { await executeRegisterTool({ name: "command_default", description: "Description", defaults: { owner_id: "PRIVATE_VALUE" }, get template() { if (++templates === 2) throw cause; return "echo first"; } }, {}, h.deps); }
      catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.equal(templates, 2, "The delegated-source guard is not a global command-template default ban");
    }
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    for (const keys of [["state_dir", "owner_id"], ["owner_id", "state_dir"]]) {
      const defaults = Object.fromEntries(keys.map(key => [key, "PRIVATE_VALUE"])); const original = JSON.stringify(defaults); let calls = 0;
      const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-runtime-key", name: "register_tool", arguments: { name: "host_key", from: "private-owner/reference", defaults } };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, runtimeDefaultText(keys[0])); assert.deepEqual(outcome.result.details, {}); assert.equal(JSON.stringify(defaults), original);
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

const authoredGuardText = {
  defaults: registryDocument({ field: "defaults", result: "Tool defaults must be an object." }),
  description: registryDocument({ field: "description", result: "Tool description is required for command-template registration." }),
  null: registryDocument({ field: "template", result: "Tool template cannot be null here." }),
  required: registryDocument({ field: "template", result: "Tool template is required." }),
};

for (const kind of ["defaults", "description", "null", "required"] as const) test(`AX authored guard ${kind} preserves authoring stages without body echo`, async () => {
  const h = await createHarness(), draft = join(h.root, "drafts", "authored.json");
  const bytes = JSON.stringify({ description: "PRIVATE_DRAFT", ...(kind === "required" ? {} : { template: "echo retained" }) });
  try {
    await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, bytes);
    for (const route of [...(kind === "defaults" ? ["from"] : []), "command", "draft"]) {
      const events: string[] = []; let templates = 0, drafts = 0;
      const input: Record<string, unknown> = {
        name: "authored",
        description: { trim() { events.push("description.trim"); return kind === "description" ? "" : "PRIVATE_DESCRIPTION"; }, toString(): never { throw Error("No description coercion for copy"); } },
        defaults: kind === "defaults" ? false : undefined,
      };
      if (route === "from") input.from = "private-owner/reference";
      else if (route === "command") Object.defineProperty(input, "template", { enumerable: true, get() { templates++; return templates === 1 ? "echo first" : kind === "null" ? null : undefined; } });
      else if (kind === "null") {
        // Direct changing-getter probe; not a cloneable two-source SDK request.
        Object.defineProperty(input, "draft", { enumerable: true, get() { drafts++; return drafts === 1 ? undefined : draft; } });
        Object.defineProperty(input, "template", { enumerable: true, get() { templates++; return null; } });
      } else input.draft = draft;
      await assert.rejects(executeRegisterTool(input, {}, { ...h.deps,
        getRecipeResolutionContext() { events.push("resolution"); return undefined; },
        getTools() { events.push("getTools"); return h.tools; },
        getToolNameBlocker() { events.push("blocker"); return undefined; },
        getActiveTools(): never { throw Error("No activation read"); },
        registerRuntimeTool(): never { throw Error("No dispatch"); },
        notify(): never { throw Error("No notice"); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.message, authoredGuardText[kind]); assert.equal(Object.getPrototypeOf(error), Error.prototype);
        assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false); assert.ok(Buffer.byteLength(error.message) < 1024);
        assert.doesNotMatch(error.message, /PRIVATE_|private-owner|- next:|- instruction:|not applied|no effects|callable_now/u); return true;
      });
      assert.deepEqual(events, [...(route === "draft" ? [] : ["resolution"]), "getTools", "blocker", "description.trim"]);
      assert.equal(templates, route === "command" ? ["null", "required"].includes(kind) ? 2 : 1 : route === "draft" && kind === "null" ? 1 : 0);
      if (route === "draft" && kind === "null") assert.equal(drafts, 5);
      assert.equal(await readFile(draft, "utf8"), bytes); assert.equal(existsSync(join(h.root, "authored.json")), false);
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX authored constants preserve Schema and observation faults plus SDK phase ownership", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce unowned fault"); } });
  try {
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const mode of ["args", "description_trim", "defaults_keys", "defaults_descriptor", "defaults_value", "retained_template"]) {
      h.tools.clear(); let templates = 0;
      if (mode === "retained_template") h.tools.set("fault_author", { name: "fault_author", description: "Existing", args: [], defaults: {}, get template(): never { throw cause; } });
      const defaults = new Proxy({ secret: 1 }, {
        ownKeys(target) { if (mode === "defaults_keys") throw cause; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { if (mode === "defaults_descriptor") throw cause; return Reflect.getOwnPropertyDescriptor(target, key); },
        get(target, key, receiver) { if (mode === "defaults_value") throw cause; return Reflect.get(target, key, receiver); },
      });
      let rejected = false;
      try { await executeRegisterTool({ name: "fault_author", update: true,
        get args() { if (mode === "args") throw cause; return undefined; },
        description: { trim() { if (mode === "description_trim") throw cause; return "Description"; } },
        defaults, get template() { return mode === "retained_template" && ++templates > 1 ? undefined : "echo"; },
      }, {}, h.deps); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
    }
    h.tools.clear();
    await assert.rejects(executeRegisterTool({ name: "schema_args", args: "same,same", template: "echo", get description(): never { throw Error("Schema error precedes description"); } }, {}, h.deps), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "\nDuplicate argument name(s): same"); return true;
    });
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    for (const [params, isError, expectedCalls, pattern] of [
      [{ name: "host_author", template: "echo", description: "" }, true, 1, /\nfield: "description"\nresult: "Tool description is required/u],
      [{ name: "host_author", template: "echo", description: "Description", defaults: false }, true, 0, /Validation failed for tool "register_tool":/u],
      [{ name: "host_author", template: null }, false, 1, /result: "not found"/u],
    ] as const) {
      let calls = 0;
      const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-authored", name: "register_tool", arguments: params };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(calls, expectedCalls); assert.equal(outcome.isError, isError); assert.match(outcome.result.content[0].text, pattern);
      assert.deepEqual(outcome.result.details, isError ? {} : { tool: "host_author" });
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []); assert.deepEqual(h.activeTools(), ["read", "smoke"]);
  } finally { await h.cleanup(); }
});

const templateShapeText = {
  nested: registryDocument({ field: "template", result: "Nested Recipe-shaped templates are not a register_tool source mode.",
    instruction: "retry with from=<skill>/<recipe> and defaults={...}." }),
  empty: registryDocument({ field: "template", result: "Tool template sequence is empty." }),
  type: registryDocument({ field: "template", result: "unsupported template type", supported_types: ["string", "object", "sequence"] }),
};

for (const kind of ["nested", "empty", "type"] as const) test(`AX template shape ${kind} refusal preserves both helper call paths without source echo`, async () => {
  const h = await createHarness();
  const draft = join(h.root, "drafts", "shape.json"), draftBytes = JSON.stringify({ description: "PRIVATE_DRAFT", template: "echo retained" });
  try {
    await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, draftBytes);
    for (const phase of ["front", "authored", "draft_authored"]) {
      let templates = 0, drafts = 0; const events: string[] = [];
      const input = {
        name: "shape", description: "PRIVATE_DESCRIPTION",
        get template() { templates++; return phase === "authored" && templates === 1 ? "echo first" : kind === "nested" ? { template: "PRIVATE_NAMESPACE/ref" } : kind === "empty" ? [] : false; },
        // Direct changing-getter probe, not a cloneable two-source SDK request.
        get draft() { drafts++; return phase === "draft_authored" && drafts > 1 ? draft : undefined; },
      };
      await assert.rejects(executeRegisterTool(input, {}, { ...h.deps,
        getRecipeResolutionContext() { events.push("resolution"); return undefined; },
        getTools() { events.push("getTools"); return h.tools; },
        getToolNameBlocker() { events.push("blocker"); return undefined; },
        getActiveTools(): never { throw Error("No activation read"); },
        registerRuntimeTool(): never { throw Error("No dispatch"); },
        notify(): never { throw Error("No notice"); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.message, templateShapeText[kind]); assert.equal(Object.getPrototypeOf(error), Error.prototype);
        assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false);
        assert.ok(Buffer.byteLength(error.message) < 1024); assert.doesNotMatch(error.message, /PRIVATE_|- next:|no effects|not applied|callable_now/u); return true;
      });
      assert.deepEqual(events, phase === "front" ? ["resolution"] : phase === "authored" ? ["resolution", "getTools", "blocker"] : ["getTools", "blocker"]);
      assert.equal(templates, phase === "authored" ? 2 : 1);
      assert.equal(drafts, phase === "draft_authored" ? 5 : 2);
      assert.equal(existsSync(join(h.root, "shape.json")), false); assert.equal(await readFile(draft, "utf8"), draftBytes);
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []); assert.deepEqual(h.activeTools(), ["read", "smoke"]);
  } finally { await h.cleanup(); }
});

test("AX template shape guards preserve accessor and expansion faults, special values and actual SDK ownership", async () => {
  const h = await createHarness(), token = Object.freeze({ toString(): never { throw Error("Do not coerce unowned fault"); } });
  try {
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const mode of ["template_get", "reference_trim", "own_keys", "descriptor", "array_expand", "object_expand"]) {
      let gets = 0; const events: string[] = [];
      const value = mode === "template_get" ? { get template(): never { throw cause; } }
        : mode === "reference_trim" ? { get template() { return ++gets === 1 ? "PRIVATE_NAMESPACE/ref" : { trim(): never { throw cause; } }; } }
        : mode === "own_keys" || mode === "descriptor" ? new Proxy({ template: "PRIVATE_NAMESPACE/ref" }, {
          get(target, key, receiver) { events.push("get:" + String(key)); return Reflect.get(target, key, receiver); },
          ownKeys(target) { events.push("ownKeys"); if (mode === "own_keys") throw cause; return Reflect.ownKeys(target); },
          getOwnPropertyDescriptor(): never { events.push("descriptor"); throw cause; },
        })
        : mode === "array_expand" ? new Proxy([], { get(target, key, receiver) { if (key === "flatMap") throw cause; return Reflect.get(target, key, receiver); } })
        : { get defaults(): never { throw cause; } };
      let rejected = false;
      try { await executeRegisterTool({ name: "fault_shape", template: value }, {}, h.deps); }
      catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
      if (mode === "reference_trim") assert.equal(gets, 2);
      if (mode === "own_keys" || mode === "descriptor") assert.deepEqual(events, ["get:template", "get:template", "ownKeys", ...(mode === "descriptor" ? ["descriptor"] : [])]);
    }
    await assert.rejects(executeRegisterTool({ name: "dependency", template: { template: "echo", repeat: 0 } }, {}, h.deps), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "Command template repeat must be a positive integer."); return true;
    });
    const blocked = Object.freeze({ effect: "old blocker reached" });
    for (const value of ["echo", { template: "echo" }, ["echo"], undefined]) {
      let rejected = false;
      try { await executeRegisterTool({ name: "valid_shape", template: value }, {}, { ...h.deps, getToolNameBlocker(): never { throw blocked; } }); }
      catch (error) { rejected = true; assert.equal(error, blocked); }
      assert.equal(rejected, true);
    }
    for (const value of [null, ""]) {
      const result = await executeRegisterTool({ name: "absent_shape", template: value }, {}, { ...h.deps, getToolNameBlocker(): never { throw Error("Deletion precedes blocker"); } });
      assert.match(result.content[0].text, /result: "not found"/u);
    }
    for (const [value, expected] of [[null, registryDocument({ field: "template", result: "Tool template cannot be null here." })], [undefined, registryDocument({ field: "template", result: "Tool template is required." })]] as const) {
      let reads = 0;
      await assert.rejects(executeRegisterTool({ name: "late_shape", description: "Description", get template() { return ++reads === 1 ? "echo" : value; } }, {}, h.deps), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.message, expected); return true;
      }); assert.equal(reads, 2);
    }
    const unsupported = Object.assign(function privateBody() {}, { toString(): never { throw Error("No unsupported-value coercion"); } });
    for (const value of [false, 7, Symbol("private unsupported"), unsupported]) await assert.rejects(executeRegisterTool({ name: "unsupported_shape", template: value }, {}, h.deps), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, templateShapeText.type); return true;
    });
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition({ ...h.deps, getToolNameBlocker: () => "HOST_BLOCKER" });
    for (const [value, expected] of [[{ template: "PRIVATE_NAMESPACE/ref" }, templateShapeText.nested], [[], templateShapeText.empty], [7, "\nHOST_BLOCKER"]] as const) {
      let calls = 0, received: unknown;
      const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; received = (args[1] as { template: unknown }).template; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-shape", name: "register_tool", arguments: { name: "host_shape", template: value } };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, expected); assert.deepEqual(outcome.result.details, {});
      if (typeof value === "number") { assert.equal(received, "7"); assert.equal(value, 7); }
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

async function checkDuplicateRegistrationGuard(kind: "ordinary" | "draft") {
  const h = await createHarness();
  const target = join(h.root, "smoke.json"), draft = join(h.root, "drafts", "candidate.json");
  const cfg: RegisteredTool = Object.freeze({ name: "smoke", description: "Existing", template: "echo prior", args: [], defaults: {}, async: false });
  const before = "PRIVATE_INVALID_TARGET", draftBytes = "PRIVATE_DRAFT_MUST_NOT_BE_READ";
  const duplicateFields = { result: "Tool already registered.", instruction: "Use update=true to overwrite." };
  const expected = registryDocument({ field: "name", value: "smoke", ...duplicateFields });
  try {
    await mkdir(kind === "draft" ? dirname(draft) : h.root, { recursive: true });
    if (kind === "draft") await writeFile(draft, draftBytes);
    for (const present of ["map", "file", "both"]) {
      await rm(target, { force: true }); h.tools.clear();
      if (present !== "file") h.tools.set("smoke", cfg);
      if (present !== "map") await writeFile(target, before);
      const events: string[] = [];
      const tools = new Map(h.tools);
      tools.get = name => { events.push("map.get"); return h.tools.get(name); };
      const input = { name: "SMOKE", ...(kind === "draft" ? { draft } : { description: "PRIVATE_DESCRIPTION", template: "echo private" }), get update() { events.push("update"); return false; } };
      await assert.rejects(executeRegisterTool(input, {}, { ...h.deps,
        getRecipeResolutionContext() { events.push("resolution"); return undefined; },
        getTools() { events.push("getTools"); return tools; },
        getToolNameBlocker() { events.push("blocker"); return undefined; },
        getActiveTools(): never { throw Error("No activation read"); },
        setActiveTools(): never { throw Error("No mutation"); },
        notify(): never { throw Error("No notification"); },
        registerRuntimeTool(): never { throw Error("No dispatch"); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(Object.getPrototypeOf(error), Error.prototype); assert.equal(error.message, expected);
        assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false);
        assert.doesNotMatch(error.message, /PRIVATE_|- next:|not applied|no effects|callable_now|rollback/u); return true;
      });
      assert.deepEqual(events, [...(kind === "ordinary" ? ["resolution"] : []), "getTools", "map.get", "blocker", "update"]);
      assert.equal(h.tools.get("smoke"), present === "file" ? undefined : cfg);
      assert.equal(existsSync(target), present !== "map");
      if (present !== "map") assert.equal(await readFile(target, "utf8"), before);
      if (kind === "draft") assert.equal(await readFile(draft, "utf8"), draftBytes);
    }
    const token = Object.freeze({ toString(): never { throw Error("Do not coerce fault"); } });
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const port of ["getTools", "map.get", "blocker", "update", ...(kind === "ordinary" ? ["resolution"] : [])]) {
      const tools = new Map(h.tools);
      tools.get = () => { if (port === "map.get") throw cause; return cfg; };
      const input = { name: "smoke", ...(kind === "draft" ? { draft } : { template: "echo keep" }), get update() { if (port === "update") throw cause; return false; } };
      let rejected = false;
      try { await executeRegisterTool(input, {}, { ...h.deps,
        getRecipeResolutionContext() { if (port === "resolution") throw cause; return undefined; },
        getTools() { if (port === "getTools") throw cause; return tools; },
        getToolNameBlocker() { if (port === "blocker") throw cause; return undefined; },
      }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
    }
    await assert.rejects(executeRegisterTool({ name: "smoke", ...(kind === "draft" ? { draft } : {}), get update(): never { throw Error("Blocker must precede update"); } }, {}, { ...h.deps, getToolNameBlocker: () => "DEPENDENCY_BLOCKER" }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "\nDEPENDENCY_BLOCKER"); return true;
    });
    const capture = async (value: string | symbol, fail = false, cause: unknown = undefined) => {
      let atMessage = false, conversions = 0, rejected = false, result: unknown;
      class LegacyName {
        trim() { return this; } toLowerCase() { return this; } replace() { return this; } slice() { return this; }
        [Symbol.toPrimitive]() { conversions++; if (atMessage && fail) throw cause; return atMessage ? value : "smoke"; }
      }
      const tools = new Map<string, RegisteredTool>(); tools.get = () => cfg;
      try { await executeRegisterTool({ name: new LegacyName() as unknown as string, ...(kind === "draft" ? { draft } : {}), get update() { atMessage = true; return false; } }, {}, { ...h.deps, getTools: () => tools }); }
      catch (error) { rejected = true; result = error; }
      assert.equal(rejected, true); assert.equal(conversions, 5, "Two normalizations, lock/target paths and original display conversion"); return result;
    };
    const message = async (value: string) => { const error = await capture(value); assert.ok(error instanceof Error); assert.ok(error.message.isWellFormed()); assert.ok(Buffer.byteLength(error.message) <= 16384); return error.message; };
    const count = exactFit(value => ({ field: "name", value, ...duplicateFields }));
    assert.equal(await message("x".repeat(count)), registryDocument({ field: "name", value: "x".repeat(count), ...duplicateFields }));
    assert.equal(await message("x".repeat(count + 1)), registryDocument({ field: "name", value: "[omitted]",
      value_omission: { reason: "response_too_large", shown: 0, omitted: 1, total: 1 }, ...duplicateFields }));
    const unit = "界👩‍💻é", unicode = unit.repeat(Math.floor(count / Buffer.byteLength(unit))) + "x".repeat(count % Buffer.byteLength(unit));
    assert.ok(Buffer.byteLength(await message(unicode)) <= 16384); assert.match(await message(unicode + "界"), /value: "\[omitted\]"/u);
    assert.match(await message("bad\ud800"), /value: "\[unavailable\]"\nvalue_omission:\n  reason: "malformed_selected_text"/u);
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) assert.equal(await capture("unused", true, cause), cause);
    assert.ok(await capture(Symbol("native template refusal")) instanceof TypeError);
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps); let calls = 0;
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; return definition.execute(...args, {}); } };
    const call = { type: "toolCall", id: "host-duplicate", name: "register_tool", arguments: { name: "SMOKE", ...(kind === "draft" ? { draft } : {}) } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(calls, 1); assert.equal(outcome.isError, true); assert.equal(outcome.result.content[0].text, expected); assert.deepEqual(outcome.result.details, {});
    assert.equal(await readFile(target, "utf8"), before); if (kind === "draft") assert.equal(await readFile(draft, "utf8"), draftBytes);
    assert.deepEqual(h.activeTools(), ["read", "smoke"]); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
}

test("AX ordinary duplicate refusal preserves ownership predicates, effects, faults and selected name", async () => {
  await checkDuplicateRegistrationGuard("ordinary");
});

test("AX draft duplicate refusal preserves ownership predicates, effects, faults and selected name", async () => {
  await checkDuplicateRegistrationGuard("draft");
});

test("AX ordinary registration name and missing-source guards preserve stage observations and existing result paths", async () => {
  const h = await createHarness();
  try {
    for (const mode of ["invalid", "reserved", "source"]) {
      const events: string[] = [], reads: string[] = [];
      class Reserved extends Set<string> { override has(name: string) { events.push("reserved:" + name); return super.has(name); } }
      class Tools extends Map<string, RegisteredTool> { override get(name: string) { events.push("map.get:" + name); return super.get(name); } }
      const tools = new Tools();
      const params = new Proxy({ name: mode === "invalid" ? "@@@" : mode === "reserved" ? "BASH" : "fresh" }, {
        get(target, key, receiver) { reads.push(String(key)); if (["description", "defaults"].includes(String(key))) throw Error("Do not read undisplayed caller body"); return Reflect.get(target, key, receiver); },
      });
      const expected = mode === "invalid" ? registryDocument({ field: "name", result: "Invalid tool name." })
        : mode === "reserved" ? registryDocument({ field: "name", value: "bash", result: "Reserved tool name." })
        : registryDocument({ result: "New registration requires exactly one source mode.", source_modes: ["from", "template", "draft"], instruction: "retry register_tool with one source field." });
      await assert.rejects(executeRegisterTool(params, {}, {
        ...h.deps,
        reservedToolNames: new Reserved(["bash"]),
        getRecipeResolutionContext() { events.push("resolution"); return undefined; },
        getTools() { events.push("getTools"); return tools; },
        getToolNameBlocker(name: string) { events.push("blocker:" + name); return undefined; },
        getActiveTools(): never { throw Error("Guard precedes activation"); },
        notify(): never { throw Error("No notification"); },
        registerRuntimeTool(): never { throw Error("No dispatch"); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(Object.getPrototypeOf(error), Error.prototype); assert.equal(error.message, expected);
        assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false); assert.ok(Buffer.byteLength(error.message) <= 16384);
        assert.doesNotMatch(error.message, /- next:|not applied|no effects|callable_now|generation/u); return true;
      });
      assert.deepEqual(events, mode === "invalid" ? [] : mode === "reserved" ? ["reserved:bash"] : ["reserved:fresh", "resolution", "getTools", "map.get:fresh", "blocker:fresh"]);
      assert.equal(reads.filter(x => x === "name").length, 4);
      assert.equal(reads.filter(x => x === "draft").length, mode === "source" ? 2 : 1);
      assert.equal(reads.filter(x => x === "from").length, mode === "source" ? 3 : 0);
      assert.equal(reads.filter(x => x === "template").length, mode === "source" ? 1 : 0);
      assert.equal(existsSync(join(h.root, "fresh.json")), false);
    }
    const listed = await executeRegisterTool({ name: "" }, {}, h.deps);
    assert.deepEqual(registryYaml(listed.content[0].text).registered_tools, []); assert.deepEqual(listed.details, { tool: "register_tool" });
    await executeRegisterTool({ name: "existing", description: "Old", template: "echo retained" }, {}, h.deps);
    const updated = await executeRegisterTool({ name: "existing", description: "New", update: true }, {}, h.deps);
    assert.equal(updated.details.persisted, true); assert.equal(h.tools.get("existing")?.description, "New");
    assert.equal(JSON.parse(await readFile(join(h.root, "existing.json"), "utf8")).template, "echo retained", "An update still needs no new source");
  } finally { await h.cleanup(); }
});

test("AX ordinary registration guard projection preserves unowned faults, scalar bounds and SDK coercion", async () => {
  const h = await createHarness(); const token = Object.freeze({ toString(): never { throw Error("Do not coerce unowned failure"); } });
  try {
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) for (const mode of ["name_get", "normalize", "reserved", "resolution", "template", "getTools", "map_get", "blocker"]) {
      class Reserved extends Set<string> { override has(name: string) { if (mode === "reserved") throw cause; return super.has(name); } }
      class Tools extends Map<string, RegisteredTool> { override get(name: string) { if (mode === "map_get") throw cause; return super.get(name); } }
      const params = mode === "name_get" ? { get name(): never { throw cause; } }
        : mode === "normalize" ? { name: { trim(): never { throw cause; } } }
        : mode === "template" ? { name: "fault_name", get template(): never { throw cause; } } : { name: "fault_name" };
      let rejected = false;
      try { await executeRegisterTool(params, {}, { ...h.deps,
        reservedToolNames: new Reserved(),
        getRecipeResolutionContext() { if (mode === "resolution") throw cause; return undefined; },
        getTools() { if (mode === "getTools") throw cause; return new Tools(); },
        getToolNameBlocker() { if (mode === "blocker") throw cause; return undefined; },
      }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
    }
    await assert.rejects(executeRegisterTool({ name: "blocked" }, {}, { ...h.deps, getToolNameBlocker: () => "DEPENDENCY_BLOCKER" }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "\nDEPENDENCY_BLOCKER"); return true;
    });
    const capture = async (value: string) => {
      let atMessage = false, coercions = 0;
      class LegacyName {
        trim() { return this; } toLowerCase() { return this; } replace() { return this; } slice() { return this; }
        [Symbol.toPrimitive]() { coercions++; return atMessage ? value : "smoke"; }
      }
      class Reserved extends Set<string> { override has() { atMessage = true; return true; } }
      let message: string | undefined;
      try { await executeRegisterTool({ name: new LegacyName() as unknown as string }, {}, { ...h.deps, reservedToolNames: new Reserved() }); }
      catch (error) { assert.ok(error instanceof Error); message = error.message; }
      assert.equal(coercions, 4, "Original two normalizations, lock path and final display conversion remain");
      assert.ok(message); assert.ok(message.isWellFormed()); assert.ok(Buffer.byteLength(message) <= 16384); return message;
    };
    const count = exactFit(value => ({ field: "name", value, result: "Reserved tool name." }));
    assert.equal(await capture("x".repeat(count)), registryDocument({ field: "name", value: "x".repeat(count), result: "Reserved tool name." }));
    assert.equal(await capture("x".repeat(count + 1)), registryDocument({ field: "name", value: "[omitted]",
      value_omission: { reason: "response_too_large", shown: 0, omitted: 1, total: 1 }, result: "Reserved tool name." }));
    const unit = "界👩‍💻é", unicode = unit.repeat(Math.floor(count / Buffer.byteLength(unit))) + "x".repeat(count % Buffer.byteLength(unit));
    assert.ok(Buffer.byteLength(await capture(unicode)) <= 16384);
    assert.match(await capture(unicode + "界"), /value: "\[omitted\]"/u);
    assert.match(await capture("bad\ud800"), /value: "\[unavailable\]"\nvalue_omission:\n  reason: "malformed_selected_text"/u);
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    for (const [params, isError, callsExpected, pattern] of [
      [{ name: "@@@" }, true, 1, /\nfield: "name"\nresult: "Invalid tool name."/u],
      [{ name: "BASH" }, true, 1, /\nvalue: "bash"\nresult: "Reserved tool name."/u],
      [{ name: "host_fresh" }, true, 1, /\nresult: "New registration requires exactly one source mode."/u],
      [{ name: "" }, false, 1, /registered_tools:\n  \[\]/u],
      [{ name: 7 }, true, 1, /\nresult: "New registration requires exactly one source mode."/u],
      [{ name: {} }, true, 0, /Validation failed for tool "register_tool":/u],
    ] as const) {
      let calls = 0, receivedName: unknown;
      const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; receivedName = (args[1] as { name?: unknown }).name; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-name-source", name: "register_tool", arguments: params };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(outcome.isError, isError); assert.equal(calls, callsExpected); assert.match(outcome.result.content[0].text, pattern);
      assert.deepEqual(outcome.result.details, isError ? {} : { tool: "register_tool" });
      if (typeof params.name === "number") { assert.equal(receivedName, "7"); assert.equal(params.name, 7); }
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX registry source-mode guard constants preserve descriptor and getter order without source echo", async () => {
  const h = await createHarness();
  const expected = {
    values: registryDocument({ field: "values", result: "register_tool values was removed.", replacement_fields: ["defaults", "from"],
      instruction: "retry register_tool with defaults for caller inputs, or use from=<skill>/<recipe> for maintained composition." }),
    from: registryDocument({ field: "from", result: "Tool from must be a non-empty Recipe reference.",
      reference_forms: ["<skill>/<recipe>", "explicit .json path", "explicit .md path"],
      instruction: "retry register_tool with from=<skill>/<recipe> or an explicit .json/.md path." }),
    mixed: registryDocument({ result: "Use exactly one register_tool source mode.", source_modes: ["from", "template", "draft"],
      instruction: "remove the extra source fields and retry register_tool." }),
    inherited: registryDocument({ field: "from", result: "register_tool from inherits args and async behavior.", inherited_fields: ["args", "async"],
      instruction: "retry register_tool with from and optional defaults only; omit args and async." }),
  };
  try {
    for (const named of [false, true]) for (const mode of ["values", "from", "from_empty", "mixed", "args", "async", "both"] as const) {
      const events: string[] = [];
      const raw: Record<string, unknown> = {};
      if (named) raw.name = "guard_only";
      if (mode === "values") Object.defineProperty(raw, "values", { get(): never { throw Error("Presence guard must not read values"); } });
      else Object.defineProperty(raw, "from", { get() { return mode === "from" ? { toString(): never { throw Error("Do not coerce supplied reference"); } } : mode === "from_empty" ? "" : "PRIVATE_SOURCE"; } });
      if (mode === "mixed") Object.defineProperty(raw, "template", { get(): never { throw Error("Only template presence is observed"); } });
      if (mode === "args" || mode === "both") Object.defineProperty(raw, "args", { get(): never { throw Error("Only args presence is observed"); } });
      if (mode === "async" || mode === "both") Object.defineProperty(raw, "async", { get(): never { throw Error("Only async presence is observed"); } });
      const params = new Proxy(raw, { get(target, key, receiver) { events.push("get:" + String(key)); return Reflect.get(target, key, receiver); },
        getOwnPropertyDescriptor(target, key) { events.push("has:" + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); } });
      const key = mode === "values" ? "values" : mode.startsWith("from") ? "from" : mode === "mixed" ? "mixed" : "inherited";
      await assert.rejects(executeRegisterTool(params, {}, {
        ...h.deps,
        getTools(): never { throw Error("Guard precedes list/registry lookup"); },
        getRecipeResolutionContext(): never { throw Error("Guard precedes resolution"); },
        notify(): never { throw Error("No notifier on local guard"); },
        registerRuntimeTool(): never { throw Error("No registration dispatch"); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(Object.getPrototypeOf(error), Error.prototype); assert.equal(error.message, expected[key]);
        assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false);
        assert.ok(Buffer.byteLength(error.message) < 1024); assert.doesNotMatch(error.message, /PRIVATE_SOURCE|- next:|not applied|no effects|callable_now|generation/u); return true;
      });
      const order = ["get:name", ...(named ? ["get:name"] : []), "has:values", ...(mode === "values" ? [] : ["has:from", "get:from", ...(mode === "from" ? [] : ["get:from", ...(mode === "from_empty" ? [] : ["get:draft", "has:template", ...(mode === "mixed" ? [] : ["has:args", ...(mode === "async" ? ["has:async"] : [])])])])])];
      assert.deepEqual(events, order);
    }
    assert.deepEqual(h.notifications, []); assert.deepEqual(h.runtimeRegistered, []); assert.equal(h.tools.size, 0);
    assert.equal(existsSync(join(h.root, "guard_only.json")), false);
  } finally { await h.cleanup(); }
});

test("AX registry source-mode refusals keep unowned observation faults and host schema ownership", async () => {
  const h = await createHarness();
  const token = Object.freeze({ toString(): never { throw Error("Do not format original failure"); } });
  try {
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", token]) {
      const descriptor = (key: string, values: Record<string, unknown>) => new Proxy(values, { getOwnPropertyDescriptor(target, property) { if (property === key) throw cause; return Reflect.getOwnPropertyDescriptor(target, property); } });
      let fromReads = 0;
      const requests = [descriptor("values", {}), descriptor("from", {}), { get from(): never { throw cause; } },
        { get from(): unknown { return ++fromReads === 1 ? "string gate" : { trim(): never { throw cause; } }; } },
        { get draft(): never { throw cause; } }, descriptor("template", {}),
        descriptor("args", { from: "PRIVATE_SOURCE" }), descriptor("async", { from: "PRIVATE_SOURCE" })];
      for (const params of requests) {
        let rejected = false;
        try { await executeRegisterTool(params, {}, h.deps); }
        catch (error) { rejected = true; assert.equal(error, cause); }
        assert.equal(rejected, true);
      }
    }
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    for (const [params, isError, reachesFacade, pattern] of [
      [{ values: { caller: "data" } }, true, false, /Validation failed for tool "register_tool":/u],
      [{ from: {} }, true, false, /Validation failed for tool "register_tool":/u],
      [{ from: 7 }, false, true, /registered_tools:\n  \[\]/u],
      [{ from: "" }, true, true, /\nfield: "from"\nresult: "Tool from must be a non-empty Recipe reference."/u],
      [{ from: "PRIVATE_SOURCE", template: "echo" }, true, true, /\nresult: "Use exactly one register_tool source mode."/u],
      [{ from: "PRIVATE_SOURCE", args: "x" }, true, true, /inherited_fields:\n  - "args"\n  - "async"/u],
      [{ from: "PRIVATE_SOURCE", async: true }, true, true, /inherited_fields:\n  - "args"\n  - "async"/u],
    ] as const) {
      let calls = 0, receivedFrom: unknown;
      const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => { calls++; receivedFrom = (args[1] as { from?: unknown }).from; return definition.execute(...args, {}); } };
      const call = { type: "toolCall", id: "host-mode-guard", name: "register_tool", arguments: params };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(outcome.isError, isError, JSON.stringify({ params, calls, result: outcome.result })); assert.match(outcome.result.content[0].text, pattern);
      assert.equal(calls, reachesFacade ? 1 : 0); assert.deepEqual(outcome.result.details, isError ? {} : { tool: "register_tool" });
      if ("from" in params && typeof params.from === "number") { assert.equal(receivedFrom, "7"); assert.equal(params.from, 7, "Host clones/coerces before execute; caller input stays numeric"); }
      if (reachesFacade) assert.doesNotMatch(outcome.result.content[0].text, /PRIVATE_SOURCE|- next:/u);
    }
    assert.equal(h.tools.size, 0); assert.deepEqual(h.runtimeRegistered, []); assert.deepEqual(h.notifications, []);
  } finally { await h.cleanup(); }
});

test("AX draft promotion receipt preserves selected flag text and original activation and effect order", async () => {
  for (const mode of ["void", "false", "true", "toggle", "zero", "opaque"]) for (const update of [false, true]) {
    const h = await createHarness(), events: string[] = []; let reads = 0;
    const draft = join(h.root, "drafts", "source.json");
    const source = JSON.stringify({ description: "PRIVATE_DESCRIPTION", args: ["file", "lang=PRIVATE_DEFAULT"], template: "echo {file} {lang}" });
    const opaqueText = "## Legacy claim\r\nnext: body only\r\n\r\n  · literal";
    const opaque = { [Symbol.toPrimitive](hint: string) { events.push("coerce:" + hint); return opaqueText; } };
    const selected: unknown = mode === "zero" ? 0 : mode === "opaque" ? opaque : mode === "true" || mode === "toggle";
    try {
      await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, source);
      if (update) await executeRegisterTool({ name: "promoted", description: "Old", template: "echo old" }, {}, h.deps);
      const result = await executeRegisterTool({ name: "promoted", draft, update }, {}, {
        ...h.deps,
        notify(ctx: unknown, message: string) { events.push("notify"); h.deps.notify(ctx, message); },
        registerRuntimeTool(cfg: RegisteredTool) {
          events.push("register"); h.deps.registerRuntimeTool(cfg);
          const args = cfg.args, recipe = cfg.recipe;
          Object.defineProperty(cfg, "args", { get() { events.push("args"); return args; } });
          Object.defineProperty(cfg, "recipe", { get() { events.push("recipe"); return recipe; } });
          if (mode === "void") return undefined;
          return {
            get active_tool() { events.push("active"); return mode !== "false"; },
            get activation(): "current_session" | "unverified" { events.push("activation"); return mode === "false" ? "unverified" : "current_session"; },
            get host_registered() { events.push("host"); return mode !== "false"; },
            get callable_now() { events.push("callable:" + ++reads); return (mode === "toggle" && reads > 1 ? false : selected) as boolean; },
          };
        },
      });
      const expectedEvents = ["register", "args", "recipe", "recipe", ...(mode === "void" ? [] : ["callable:1"]), "notify",
        ...(mode === "opaque" ? ["coerce:string"] : []), ...(mode === "void" ? [] : ["active", "activation", "callable:2",
          ...(["false", "zero", "toggle"].includes(mode) ? ["host", ...(mode === "false" ? [] : ["active"])] : [])]),
        "args", ...(mode === "void" ? [] : ["host"])];
      assert.deepEqual(events, expectedEvents, "No activation reread or flag coercion before notify");
      assert.equal(result.details.promoted, true); assert.equal(result.details.persisted, true); assert.equal(result.details.registry_active, true);
      assert.equal(result.details.callable_now, mode === "void" ? false : selected);
      assert.equal(result.details.activation_boundary, mode === "void" ? "session_activation_unverified" : mode === "false" ? "host_registration" : ["zero", "toggle"].includes(mode) ? "callability_verification" : "current_session");
      assert.deepEqual(result.details.required_args, ["file"]); assert.deepEqual(result.details.optional_args, ["lang"]);
      const invocation = ["true", "toggle", "opaque"].includes(mode);
      assert.deepEqual(result.details.next_actions, invocation ? ["call tool promoted", "inspect target=tool:promoted view=status"] : ["inspect target=tool:promoted view=status"]);
      const flag = mode === "opaque" ? opaqueText : mode === "zero" ? "0" : mode === "true" || mode === "toggle" ? "true" : "false";
      assert.deepEqual(registryYaml(result.content[0].text), { tool: "promoted", result: update ? "updated" : "registered", source: "draft", callable_now: flag,
        ...(invocation ? { instruction: "call tool promoted" } : { next: { tool: "inspect", target: "tool:promoted", view: "status" } }) });
      assert.doesNotMatch(result.content[0].text, /PRIVATE_|activation_boundary:|required_args:|optional_args:|defaults:|persisted:|host_registered:|warnings:/u);
      assert.equal(await readFile(draft, "utf8"), source);
      assert.equal(JSON.parse(await readFile(join(h.root, "promoted.json"), "utf8")).template, "echo {file} {lang}");
    } finally { await h.cleanup(); }
  }
  for (const cause of [undefined, "PRIVATE_PRIMITIVE", Object.freeze({ toString(): never { throw Error("Never format original failure"); } })]) for (const mode of ["register", "summary", "notify", "coerce", "details"]) {
    const h = await createHarness(); const draft = join(h.root, "drafts", "fault.json"); let effects = 0, notified = 0;
    try {
      await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, JSON.stringify({ description: "Retained", template: "echo" }));
      let rejected = false;
      try { await executeRegisterTool({ name: "fault_promotion", draft }, {}, {
        ...h.deps,
        notify() { notified++; if (mode === "notify") throw cause; },
        registerRuntimeTool(cfg: RegisteredTool) {
          effects++; if (mode === "register") throw cause;
          if (mode === "summary") Object.defineProperty(cfg, "args", { get(): never { throw cause; } });
          return { get active_tool() { if (mode === "details") throw cause; return true; }, activation: "current_session", host_registered: true,
            callable_now: (mode === "coerce" ? { [Symbol.toPrimitive](): never { throw cause; } } : true) as boolean };
        },
      }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.equal(effects, 1); assert.equal(notified, ["register", "summary"].includes(mode) ? 0 : 1);
      assert.equal(JSON.parse(await readFile(join(h.root, "fault_promotion.json"), "utf8")).description, "Retained");
      assert.equal(h.tools.has("fault_promotion"), true, "Promotion retains its old post-effect boundary, not ordinary registration rollback");
    } finally { await h.cleanup(); }
  }
});

test("AX draft promotion receipt bounds the exact selected display without adding compact facts", async () => {
  const h = await createHarness(); const draft = join(h.root, "drafts", "bounded.json");
  let value = "x", coercions = 0;
  const display = { [Symbol.toPrimitive](hint: string) { assert.equal(hint, "string"); coercions++; return value; } };
  try {
    await mkdir(dirname(draft), { recursive: true }); await writeFile(draft, JSON.stringify({ description: "Bound", template: "echo" }));
    const run = () => executeRegisterTool({ name: "bounded", draft, update: true }, {}, { ...h.deps,
      registerRuntimeTool: () => ({ active_tool: true, activation: "current_session", host_registered: true, callable_now: display as unknown as boolean }) });
    await run();
    const base = await run();
    value = "false";
    const falseDisplay = await run(); assert.equal(registryYaml(falseDisplay.content[0].text).callable_now, "false"); assert.equal(registryYaml(falseDisplay.content[0].text).instruction, "call tool bounded");
    const count = 16384 - Buffer.byteLength(base.content[0].text) + 1;
    value = "x".repeat(count);
    const full = await run(); assert.equal(Buffer.byteLength(full.content[0].text), 16384); assert.equal(registryYaml(full.content[0].text).callable_now, value);
    value += "x";
    const omitted = await run(); assert.ok(Buffer.byteLength(omitted.content[0].text) <= 16384);
    assert.equal(registryYaml(omitted.content[0].text).callable_now, "[omitted]");
    assert.deepEqual(registryYaml(omitted.content[0].text).callable_now_omission, { reason: "response_too_large", shown: 0, omitted: 1, total: 1 });
    assert.doesNotMatch(omitted.content[0].text, /x{40}/u); assert.equal(omitted.details.callable_now, display);
    const unit = "界👩‍💻é";
    value = unit.repeat(Math.floor(count / Buffer.byteLength(unit))) + "x".repeat(count % Buffer.byteLength(unit));
    assert.equal(Buffer.byteLength((await run()).content[0].text), 16384);
    value += "界";
    assert.equal(registryYaml((await run()).content[0].text).callable_now, "[omitted]");
    value = "bad\ud800";
    const malformed = await run(); assert.ok(malformed.content[0].text.isWellFormed());
    assert.equal(registryYaml(malformed.content[0].text).callable_now, "[unavailable]"); assert.equal(registryYaml(malformed.content[0].text).callable_now_omission.reason, "malformed_selected_text");
    assert.equal(value.charCodeAt(3), 0xd800); assert.equal(coercions, 8, "Exactly one old flag conversion per promotion");
    // Separate probes do not alter the original scenario's coercion-count assertion.
    for (const selected of ["true", "0", "null", "[]", "\uFEFFopaque\r\nnext: body\r\n\"\\界"]) {
      value = selected; assert.equal(registryYaml((await run()).content[0].text).callable_now, selected);
    }
    value = "\"";
    const escapedBase = await run();
    const escapedRoom = 16384 - Buffer.byteLength(escapedBase.content[0].text);
    value = "\"".repeat(1 + Math.floor(escapedRoom / 2)) + "x".repeat(escapedRoom % 2);
    const escaped = await run(); assert.equal(Buffer.byteLength(escaped.content[0].text), 16384); assert.equal(registryYaml(escaped.content[0].text).callable_now, value);
    value += "x"; assert.equal(registryYaml((await run()).content[0].text).callable_now_omission.reason, "response_too_large");
    await assert.rejects(executeRegisterTool({ name: "symbol_promotion", draft }, {}, { ...h.deps,
      registerRuntimeTool: () => ({ active_tool: true, activation: "current_session", host_registered: true, callable_now: Symbol("legacy") as unknown as boolean }) }), TypeError);
    assert.equal(h.tools.has("symbol_promotion"), true, "Template Symbol coercion stays a post-effect failure, unlike String(Symbol)");
    assert.equal(JSON.parse(await readFile(join(h.root, "symbol_promotion.json"), "utf8")).description, "Bound");
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => definition.execute(...args, {}) };
    const call = { type: "toolCall", id: "host-promotion", name: "register_tool", arguments: { name: "host_promoted", draft } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(outcome.isError, false); assert.equal(outcome.result.details.promoted, true); assert.equal(outcome.result.details.callable_now, false);
    assert.deepEqual(registryYaml(outcome.result.content[0].text), { tool: "host_promoted", result: "registered", source: "draft", callable_now: "false", next: { tool: "inspect", target: "tool:host_promoted", view: "status" } });
  } finally { await h.cleanup(); }
});

test("AX registry list preserves selected names, order and coercion with whole-group coverage", async () => {
  const h = await createHarness();
  const capture = async (values: unknown[]) => {
    const events: string[] = [];
    class NameMap extends Map<string, RegisteredTool> { override keys() { events.push("keys"); return super.keys(); } }
    const map = new NameMap();
    const cfg = Object.defineProperty({}, "private_body", { get(): never { throw Error("Do not inspect tool bodies"); } }) as RegisteredTool;
    for (const value of values) map.set(value as string, cfg);
    const result = await executeRegisterTool({}, { get sessionManager(): never { throw Error("No session lookup for current registry names"); } }, {
      ...h.deps,
      getTools() { events.push("getTools"); return map; },
      getActiveTools(): never { throw Error("No activation inference"); },
      notify(): never { throw Error("No list notification"); },
      get recipeRoot(): never { throw Error("No filesystem path lookup"); },
    });
    assert.deepEqual(events, ["getTools", "keys"]);
    assert.deepEqual(result.details, { tool: "register_tool" });
    assert.deepEqual([...map.keys()], values, "Sorting/projecting does not reorder or mutate the registry");
    assert.ok(Buffer.byteLength(result.content[0].text) <= 16384); assert.ok(result.content[0].text.isWellFormed());
    return result.content[0].text;
  };
  const coverage = (shown: number, omitted: number, total: number, reason?: string) => ({ ...(reason ? { reason } : {}), shown, omitted, total });
  const expectedList = (names: string[], total = names.length, reason?: string) => ({ registered_tools: reason ? (reason === "malformed_selected_text" ? "[unavailable]" : "[omitted]") : names, registered_tools_coverage: coverage(names.length, total - names.length, total, reason) });
  try {
    assert.deepEqual(registryYaml(await capture([])), expectedList([]));
    for (const values of [["solo"], ["zeta", "alpha"], ["界👩‍💻é", "## Name\r\nnext: body\r\n\r\n  - opaque · literal"], ["null", "true", "12", "[]", "\uFEFFname", "a\"b\\c"]]) {
      assert.deepEqual(registryYaml(await capture(values)), expectedList([...values].sort()));
    }
    const base = await capture(["a"]);
    const count = 16384 - Buffer.byteLength(base) + 1;
    const exact = "a".repeat(count);
    assert.equal(Buffer.byteLength(await capture([exact])), 16384);
    assert.deepEqual(registryYaml(await capture([exact + "a"])), expectedList([], 1, "response_too_large"));
    assert.deepEqual(registryYaml(await capture([exact, "z"])), expectedList([], 2, "response_too_large"));
    const escaped = "\"".repeat(Math.floor(count / 2)) + "a".repeat(count % 2);
    assert.equal(Buffer.byteLength(await capture([escaped])), 16384);
    assert.deepEqual(registryYaml(await capture([escaped])), expectedList([escaped]));
    assert.deepEqual(registryYaml(await capture([escaped + "a"])), expectedList([], 1, "response_too_large"));
    const unit = "界👩‍💻é";
    const unicode = unit.repeat(Math.floor(count / Buffer.byteLength(unit))) + "x".repeat(count % Buffer.byteLength(unit));
    assert.equal(Buffer.byteLength(await capture([unicode])), 16384);
    assert.deepEqual(registryYaml(await capture([unicode])), expectedList([unicode]));
    assert.deepEqual(registryYaml(await capture([unicode + "界"])), expectedList([], 1, "response_too_large"));
    const malformed = "bad\ud800";
    assert.deepEqual(registryYaml(await capture([malformed])), expectedList([], 1, "malformed_selected_text"));
    let coercions = 0;
    const key = { [Symbol.toPrimitive](hint: string) { assert.equal(hint, "string"); coercions++; return "## Captured\n- next: content"; } };
    assert.deepEqual(registryYaml(await capture([key])), expectedList(["## Captured\n- next: content"]));
    assert.equal(coercions, 1, "Use the captured compiler-prefixed row, never coerce the original key again");
    for (const cause of [undefined, "PRIVATE_PRIMITIVE", Object.freeze({ toString(): never { throw Error("Do not format failure"); } })]) {
      let rejected = false;
      try { await capture([{ [Symbol.toPrimitive](): never { throw cause; } }]); }
      catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
    }
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    const hostTool = { ...definition, execute: (...values: [string, unknown, AbortSignal | undefined, unknown]) => definition.execute(...values, {}) };
    const call = { type: "toolCall", id: "host-list", name: "register_tool", arguments: {} };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(outcome.isError, false); assert.deepEqual(registryYaml(outcome.result.content[0].text), expectedList([]));
    assert.deepEqual(outcome.result.details, { tool: "register_tool" });
  } finally { await h.cleanup(); }
});

test("AX registry deletion preserves lookup and partial effects while keeping reload instruction opaque", async () => {
  for (const found of [false, true]) for (const file of [false, true]) {
    const h = await createHarness(), events: string[] = [];
    const recipePath = join(h.root, "smoke.json");
    class DeleteMap extends Map<string, RegisteredTool> {
      override has(name: string) { events.push("has"); return super.has(name); }
      override delete(name: string) { events.push("delete"); assert.equal(existsSync(recipePath), false, "File removal stays before map deletion"); return super.delete(name); }
    }
    const tools = new DeleteMap();
    if (found) tools.set("smoke", { name: "smoke", args: [], defaults: {}, description: "PRIVATE_BODY", template: "PRIVATE_TEMPLATE" });
    try {
      if (file) { await mkdir(h.root, { recursive: true }); await writeFile(recipePath, "ORIGINAL_RECIPE_BYTES"); }
      const result = await executeRegisterTool({ name: "SMOKE", template: null }, {}, {
        ...h.deps,
        getTools() { events.push("getTools"); return tools; },
        getActiveTools() { events.push("getActive"); return h.activeTools(); },
        setActiveTools(names: string[]) { events.push("setActive"); h.deps.setActiveTools(names); },
        notify(ctx: unknown, message: string) { events.push("notify"); h.deps.notify(ctx, message); },
      });
      assert.deepEqual(result.details, { tool: "smoke" });
      assert.deepEqual(registryYaml(result.content[0].text), { tool: "smoke", result: found ? "deleted" : "not found", ...(found ? { instruction: "Reload to remove it from the complete registry." } : {}) });
      assert.deepEqual(events, found ? ["getTools", "has", "delete", "getActive", "setActive", "notify"] : ["getTools", "has"]);
      assert.deepEqual(h.activeTools(), found ? ["read"] : ["read", "smoke"]);
      assert.deepEqual(h.notifications, found ? ["- report: Deleted tool\n- tool: smoke"] : []);
      if (!found && file) assert.equal(await readFile(recipePath, "utf8"), "ORIGINAL_RECIPE_BYTES", "A current-map miss does not authorize orphan-file deletion");
      else assert.equal(existsSync(recipePath), false);
      assert.doesNotMatch(result.content[0].text, /PRIVATE_|- next:|callable_now|active_tool|not applied|no effects|closure|automatically/u);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 16384);
    } finally { await h.cleanup(); }
  }
  const boundHarness = await createHarness();
  try {
    const display = async (value: string) => {
      let atReceipt = false, coercions = 0;
      class LegacyName {
        trim() { return this; } toLowerCase() { return this; } replace() { return this; } slice() { return this; }
        [Symbol.toPrimitive]() { coercions++; return atReceipt ? value : "smoke"; }
      }
      class MissingMap extends Map<string, RegisteredTool> { override has() { atReceipt = true; return false; } }
      const name = new LegacyName();
      const result = await executeRegisterTool({ name: name as unknown as string, template: null }, {}, { ...boundHarness.deps, getTools: () => new MissingMap() });
      assert.equal(coercions, 4, "Keep the original normalizer/path/name template observations, including one receipt conversion");
      assert.equal(result.details.tool, name); assert.ok(result.content[0].text.isWellFormed()); assert.ok(Buffer.byteLength(result.content[0].text) <= 16384);
      return result.content[0].text;
    };
    for (const value of ["null", "true", "[]", "\uFEFFopaque\r\nnext: body\r\n\"\\界"]) assert.deepEqual(registryYaml(await display(value)), { tool: value, result: "not found" });
    const exact = "x".repeat(16384 - Buffer.byteLength(await display("")));
    assert.equal(Buffer.byteLength(await display(exact)), 16384);
    assert.deepEqual(registryYaml(await display(exact)), { tool: exact, result: "not found" });
    for (const [value, reason, tool] of [[exact + "x", "response_too_large", "[omitted]"], ["bad\ud800", "malformed_selected_text", "[unavailable]"]]) {
      assert.deepEqual(registryYaml(await display(value)), { tool, tool_omission: { reason, shown: 0, omitted: 1, total: 1 }, result: "not found" });
    }
    const escaped = "\"".repeat(Math.floor(exact.length / 2)) + "x".repeat(exact.length % 2);
    assert.equal(Buffer.byteLength(await display(escaped)), 16384);
    assert.deepEqual(registryYaml(await display(escaped)), { tool: escaped, result: "not found" });
    assert.equal(registryYaml(await display(escaped + "x")).tool_omission.reason, "response_too_large");
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(boundHarness.deps);
    const hostTool = { ...definition, execute: (...values: [string, unknown, AbortSignal | undefined, unknown]) => definition.execute(...values, {}) };
    for (const found of [false, true]) {
      if (found) boundHarness.tools.set("smoke", { name: "smoke", args: [], defaults: {}, description: "Fixture", template: "echo" });
      const call = { type: "toolCall", id: "host-delete", name: "register_tool", arguments: { name: "smoke", template: null } };
      const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
      assert.equal(outcome.isError, false, "Absent tool remains a returned result, not a new Error");
      assert.deepEqual(registryYaml(outcome.result.content[0].text), { tool: "smoke", result: found ? "deleted" : "not found", ...(found ? { instruction: "Reload to remove it from the complete registry." } : {}) });
      assert.deepEqual(outcome.result.details, { tool: "smoke" });
    }
  } finally { await boundHarness.cleanup(); }
  for (const cause of [undefined, "PRIVATE_PRIMITIVE", Object.freeze({ toString(): never { throw Error("Do not coerce failure"); } })]) for (const fault of ["getTools", "has", "delete", "getActive", "setActive", "notify"]) {
    const h = await createHarness(); const events: string[] = [];
    const path = join(h.root, "smoke.json");
    class FaultMap extends Map<string, RegisteredTool> {
      override has(name: string) { events.push("has"); if (fault === "has") throw cause; return super.has(name); }
      override delete(name: string) { events.push("delete"); const result = super.delete(name); if (fault === "delete") throw cause; return result; }
    }
    const tools = new FaultMap([["smoke", { name: "smoke", args: [], defaults: {}, description: "Fixture", template: "echo" }]]);
    try {
      await mkdir(h.root, { recursive: true }); await writeFile(path, "RETAIN_OR_REMOVE_ONCE");
      let rejected = false;
      try { await executeRegisterTool({ name: "smoke", template: null }, {}, {
        ...h.deps,
        getTools() { events.push("getTools"); if (fault === "getTools") throw cause; return tools; },
        getActiveTools() { events.push("getActive"); if (fault === "getActive") throw cause; return h.activeTools(); },
        setActiveTools(names: string[]) { events.push("setActive"); h.deps.setActiveTools(names); if (fault === "setActive") throw cause; },
        notify(ctx: unknown, message: string) { events.push("notify"); h.deps.notify(ctx, message); if (fault === "notify") throw cause; },
      }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
      const order = ["getTools", "has", "delete", "getActive", "setActive", "notify"];
      const index = order.indexOf(fault); assert.deepEqual(events, order.slice(0, index + 1));
      assert.equal(existsSync(path), index < 2); assert.equal(Map.prototype.has.call(tools, "smoke"), index < 2);
      assert.deepEqual(h.activeTools(), index < 4 ? ["read", "smoke"] : ["read"]);
      assert.deepEqual(h.notifications, index < 5 ? [] : ["- report: Deleted tool\n- tool: smoke"]);
    } finally { await h.cleanup(); }
  }
});

test("AX registration receipt preserves activation observations, opaque warnings and existing machine facts", async () => {
  for (const mode of ["unverified", "callable", "toggle"]) for (const update of [false, true]) {
    const h = await createHarness();
    const events: string[] = [];
    let callableReads = 0;
    try {
      if (update) await executeRegisterTool({ name: "receipt", description: "Old", template: "echo old" }, {}, h.deps);
      const deps = {
        ...h.deps,
        notify(ctx: unknown, message: string) { events.push("notify"); h.deps.notify(ctx, message); },
        registerRuntimeTool(cfg: RegisteredTool) {
          events.push("register"); h.deps.registerRuntimeTool(cfg);
          const args = cfg.args, recipe = cfg.recipe;
          Object.defineProperty(cfg, "args", { get() { events.push("args"); return args; } });
          Object.defineProperty(cfg, "recipe", { get() { events.push("recipe"); return recipe; } });
          if (mode === "unverified") return undefined;
          return {
            get active_tool() { events.push("active"); return true; },
            get activation(): "current_session" { events.push("activation"); return "current_session"; },
            get host_registered() { events.push("host"); return true; },
            get callable_now() { callableReads++; events.push("callable:" + callableReads); return mode === "callable" || callableReads % 2 === 1; },
          };
        },
      };
      const label = "## Authored\r\nnext: still a label\r\n\r\n  - literal · warning";
      const result = await executeRegisterTool({ name: "receipt", description: "PRIVATE_DESCRIPTION", args: "file,lang=ru", update,
        template: { label, template: "bash -c 'echo fixed' {file} {lang}" } }, {}, deps);
      const expectedEvents = ["register", ...(mode === "unverified" ? [] : ["host", "active", "callable:1"]), "notify",
        "recipe", "recipe", "recipe", ...(mode === "unverified" ? [] : ["callable:2"]), "args", "recipe", "recipe",
        ...(mode === "toggle" ? ["callable:3"] : []),
        ...(mode === "unverified" ? [] : ["active", "activation", mode === "toggle" ? "callable:4" : "callable:3", ...(mode === "toggle" ? ["host", "active"] : [])]),
        "args", ...(mode === "unverified" ? [] : ["host"]), "recipe"];
      assert.deepEqual(events, expectedEvents, "No new activation/boundary or cfg observations to build copy");
      const callable = mode === "callable";
      assert.equal(result.details.callable_now, callable);
      assert.equal(result.details.activation_boundary, mode === "unverified" ? "session_activation_unverified" : mode === "toggle" ? "callability_verification" : "current_session");
      assert.deepEqual(result.details.required_args, ["file"]); assert.deepEqual(result.details.optional_args, ["lang"]);
      assert.deepEqual(result.details.next_actions, callable ? ["call tool receipt", "inspect target=tool:receipt view=status"] : ["inspect target=tool:receipt view=status"]);
      assert.equal(result.details.persisted, true); assert.equal(result.details.registry_active, true); assert.equal(result.details.source, "template");
      const warnings = result.details.templateWarnings!;
      assert.equal(warnings.length, 1); assert.ok(warnings[0].startsWith(label + ": invokes bash;"));
      assert.deepEqual(registryYaml(result.content[0].text), {
        tool: "receipt", result: callable ? update ? "updated" : "registered" : "persisted", source: "template", callable_now: callable,
        ...(callable ? {} : { activation_boundary: mode === "toggle" ? "current_session" : "session_activation_unverified" }),
        required_args: ["file"], optional_args: ["lang"], warnings: [warnings[0]],
        ...(callable ? { instruction: "call tool receipt" } : { next: { tool: "inspect", target: "tool:receipt", view: "status" } }),
      });
      assert.doesNotMatch(result.content[0].text, /PRIVATE_DESCRIPTION|defaults:|host_registered:|registry_active:|validated:|not sandboxed by.*- next:/u);
      const stored = JSON.parse(await readFile(join(h.root, "receipt.json"), "utf8"));
      assert.equal(stored.template.label, label); assert.deepEqual(stored.defaults, { lang: "ru" });
    } finally { await h.cleanup(); }
  }
  const token = Object.freeze({ toString() { throw Error("Do not coerce original failure"); } });
  for (const cause of [token, undefined, "PRIVATE_PRIMITIVE"]) for (const mode of ["notify", "warning", "args_join", "late_activation"]) {
    const h = await createHarness(); let effects = 0, gets = 0;
    try {
      class JoinFault extends Array<string> { override join(): never { throw cause; } }
      let rejected = false;
      try { await executeRegisterTool({ name: "fault", description: "Retained", template: "echo {file}" }, {}, {
        ...h.deps,
        notify() { if (mode === "notify") throw cause; },
        registerRuntimeTool(cfg: RegisteredTool) {
          effects++;
          if (mode === "warning") Object.defineProperty(cfg, "recipe", { get(): never { throw cause; } });
          if (mode === "args_join") cfg.args = new JoinFault("file");
          if (mode === "late_activation") return { active_tool: true, activation: "current_session", host_registered: true, get callable_now() { if (++gets > 1) throw cause; return true; } };
        },
      }); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true); assert.equal(effects, 1);
      assert.equal(JSON.parse(await readFile(join(h.root, "fault.json"), "utf8")).description, "Retained");
      assert.equal(h.tools.has("fault"), true, "Copy/notification failures after persistence do not trigger a new rollback or retry");
    } finally { await h.cleanup(); }
  }
});

test("AX registration receipt budgets whole argument groups, prioritizes warnings and preserves literal source", async () => {
  const h = await createHarness();
  try {
    const first = await executeRegisterTool({ name: "tight", description: "Bound", args: "a", template: "echo {a}" }, {}, h.deps);
    const size = 16384 - Buffer.byteLength(first.content[0].text) + 1;
    const arg = "a".repeat(size);
    const full = await executeRegisterTool({ name: "tight", description: "Bound", args: arg, template: `echo {${arg}}`, update: true }, {}, h.deps);
    assert.equal(Buffer.byteLength(full.content[0].text), 16384); assert.deepEqual(registryYaml(full.content[0].text).required_args, [arg]);
    const large = arg + "a";
    const omitted = await executeRegisterTool({ name: "tight", description: "Bound", args: large, template: `echo {${large}}`, update: true }, {}, h.deps);
    assert.equal(registryYaml(omitted.content[0].text).required_args, "[omitted]");
    assert.deepEqual(registryYaml(omitted.content[0].text).required_args_omission, { reason: "response_too_large", shown: 0, omitted: 1, total: 1 });
    assert.doesNotMatch(omitted.content[0].text, /a{40}/u); assert.deepEqual(omitted.details.required_args, [large]);
    assert.ok(Buffer.byteLength(omitted.content[0].text) <= 16384);
    const label = "界👩‍💻é".repeat(70) + "\r\nnext: opaque";
    const warning = await executeRegisterTool({ name: "tight", description: "Bound", args: arg, template: { label, template: `bash -c 'echo fixed' {${arg}}` }, update: true }, {}, h.deps);
    assert.equal(registryYaml(warning.content[0].text).required_args, "[omitted]");
    assert.deepEqual(registryYaml(warning.content[0].text).warnings, [warning.details.templateWarnings![0]]);
    assert.ok(Buffer.byteLength(warning.content[0].text) <= 16384);
    const optionalBase = await executeRegisterTool({ name: "optional", description: "Bound", args: "a=PRIVATE_DEFAULT", template: "echo {a}" }, {}, h.deps);
    const optionalSize = 16384 - Buffer.byteLength(optionalBase.content[0].text) + 1;
    const optionalArg = "o".repeat(optionalSize);
    const optionalFull = await executeRegisterTool({ name: "optional", description: "Bound", args: optionalArg + "=PRIVATE_DEFAULT", template: `echo {${optionalArg}}`, update: true }, {}, h.deps);
    assert.equal(Buffer.byteLength(optionalFull.content[0].text), 16384); assert.doesNotMatch(optionalFull.content[0].text, /PRIVATE_DEFAULT/u);
    const optionalLarge = optionalArg + "o";
    const optionalOmitted = await executeRegisterTool({ name: "optional", description: "Bound", args: optionalLarge + "=PRIVATE_DEFAULT", template: `echo {${optionalLarge}}`, update: true }, {}, h.deps);
    assert.equal(registryYaml(optionalOmitted.content[0].text).optional_args, "[omitted]"); assert.deepEqual(optionalOmitted.details.optional_args, [optionalLarge]);
    assert.equal(optionalOmitted.details.defaults![optionalLarge], "PRIVATE_DEFAULT"); assert.doesNotMatch(optionalOmitted.content[0].text, /PRIVATE_DEFAULT|o{40}/u);
    const largeWarning = await executeRegisterTool({ name: "large_warning", description: "Bound", template: { label: "界".repeat(6000), template: "bash -c 'echo fixed'" } }, {}, h.deps);
    assert.equal(registryYaml(largeWarning.content[0].text).warnings, "[omitted]");
    assert.deepEqual(registryYaml(largeWarning.content[0].text).warnings_omission, { reason: "response_too_large", shown: 0, omitted: 1, total: 1 });
    assert.ok(largeWarning.details.templateWarnings![0].startsWith("界".repeat(6000))); assert.ok(Buffer.byteLength(largeWarning.content[0].text) < 1024);
    const malformed = await executeRegisterTool({ name: "malformed", description: "Bound", template: "echo" }, {}, {
      ...h.deps, registerRuntimeTool(cfg: RegisteredTool) { cfg.args = ["bad\ud800"]; },
    });
    assert.equal(registryYaml(malformed.content[0].text).required_args, "[unavailable]"); assert.equal(registryYaml(malformed.content[0].text).required_args_omission.reason, "malformed_selected_text");
    assert.ok(malformed.content[0].text.isWellFormed()); assert.deepEqual(malformed.details.required_args, ["bad\ud800"]);
    const selectedArgs = async (args: unknown[]) => executeRegisterTool({ name: "selected_args", description: "Bound", template: "echo", update: true }, {}, {
      ...h.deps, registerRuntimeTool(cfg: RegisteredTool) { cfg.args = args as string[]; },
    });
    for (const args of [[], ["false"], ["true", "null", "[]", "0", "\uFEFFopaque\r\nnext: body\r\n\"\\界"]]) {
      const selected = await selectedArgs(args);
      assert.deepEqual(registryYaml(selected.content[0].text).required_args, args);
      assert.deepEqual(registryYaml(selected.content[0].text).optional_args, []);
      assert.equal(Object.hasOwn(registryYaml(selected.content[0].text), "warnings"), false);
    }
    const nontext = await selectedArgs([0]);
    assert.deepEqual(registryYaml(nontext.content[0].text).required_args_omission, { reason: "malformed_selected_text", shown: 0, omitted: 1, total: 1 });
    const escapedBase = await selectedArgs(["\""]);
    const escapedRoom = 16384 - Buffer.byteLength(escapedBase.content[0].text);
    const escapedArg = "\"".repeat(1 + Math.floor(escapedRoom / 2)) + "x".repeat(escapedRoom % 2);
    const escapedFull = await selectedArgs([escapedArg]);
    assert.equal(Buffer.byteLength(escapedFull.content[0].text), 16384); assert.deepEqual(registryYaml(escapedFull.content[0].text).required_args, [escapedArg]);
    assert.equal(registryYaml((await selectedArgs([escapedArg + "x"])).content[0].text).required_args_omission.reason, "response_too_large");
    const unicodeArg = "界".repeat(Math.floor((escapedRoom + 2) / 3)) + "x".repeat((escapedRoom + 2) % 3);
    const unicodeFull = await selectedArgs([unicodeArg]);
    assert.equal(Buffer.byteLength(unicodeFull.content[0].text), 16384); assert.deepEqual(registryYaml(unicodeFull.content[0].text).required_args, [unicodeArg]);
    assert.equal(registryYaml((await selectedArgs([unicodeArg + "x"])).content[0].text).required_args_omission.reason, "response_too_large");
    assert.deepEqual(registryYaml((await selectedArgs([escapedArg, "z"])).content[0].text).required_args_omission, { reason: "response_too_large", shown: 0, omitted: 2, total: 2 });
    const source = join(h.root, "source ``` literal.json");
    await writeFile(source, JSON.stringify({ description: "Literal", args: ["name"], template: "echo {name}" }));
    const sourced = await executeRegisterTool({ name: "from_literal", from: source }, {}, h.deps);
    assert.equal(sourced.details.source, source);
    assert.equal(registryYaml(sourced.content[0].text).source, source);
    assert.equal(await readFile(source, "utf8"), JSON.stringify({ description: "Literal", args: ["name"], template: "echo {name}" }));
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
    const definition = createRegisterToolDefinition(h.deps);
    const hostTool = { ...definition, execute: (...values: [string, unknown, AbortSignal | undefined, unknown]) => definition.execute(...values, {}) };
    const call = { type: "toolCall", id: "host-registration", name: "register_tool", arguments: { name: "host_receipt", description: "Host", template: "echo" } };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(outcome.isError, false); assert.equal(outcome.result.details.persisted, true); assert.equal(outcome.result.details.callable_now, false);
    assert.deepEqual(registryYaml(outcome.result.content[0].text), { tool: "host_receipt", result: "persisted", source: "template", callable_now: false,
      activation_boundary: "session_activation_unverified", required_args: [], optional_args: [], next: { tool: "inspect", target: "tool:host_receipt", view: "status" } });
    assert.deepEqual(outcome.result.details.required_args, []); assert.deepEqual(outcome.result.details.next_actions, ["inspect target=tool:host_receipt view=status"]);
  } finally { await h.cleanup(); }
});

test("Retained creation leaves same-named exposed tools and every host port untouched", async () => {
  for (const async of [false, true]) {
    const h = await createHarness();
    try {
      await executeRegisterTool({ name: "remember", description: "Existing tool", template: "echo exposed" }, {}, h.deps);
      h.deps.setActiveTools(["read", "remember"]);
      const existing = h.tools.get("remember"), before = await readFile(join(h.root, "remember.json"), "utf8");
      const denied = (): never => { throw Error("Retention must not access host or tool-map ports"); };
      const result = await executeRegisterTool({ name: "remember", description: "Retained capability", template: "echo {text}", async, expose: false }, {}, {
        ...h.deps, getTools: denied, getActiveTools: denied, setActiveTools: denied, registerRuntimeTool: denied, notify: denied,
      });
      const path = join(h.root, "library", "remember.json");
      assert.equal(result.details.kind, "retained_recipe");
      assert.equal(result.details.recipe, path);
      assert.equal(result.details.activation, "not_requested");
      assert.equal(result.details.persisted, true);
      assert.equal(result.details.async, async);
      for (const key of ["callable_now", "active_tool", "host_registered", "registry_active"]) assert.equal(Object.hasOwn(result.details, key), false);
      assert.deepEqual(result.details.required_args, ["text"]);
      assert.deepEqual(result.details.optional_args, async ? ["run_id", "transport_context"] : []);
      assert.deepEqual(result.details.next_actions, ["inspect target=recipes view=summary verbose=true"]);
      const document = registryYaml(result.content[0].text);
      assert.equal(document.kind, "retained_recipe");
      assert.equal(document.result, "retained");
      assert.equal(document.activation, "not_requested");
      assert.equal(document.recipe, path);
      assert.equal(Object.hasOwn(document, "callable_now"), false);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        description: "Retained capability", template: "echo {text}", async,
      });
      assert.equal(await readFile(join(h.root, "remember.json"), "utf8"), before);
      assert.equal(h.tools.get("remember"), existing);
      assert.deepEqual(h.activeTools(), ["read", "remember"]);
      assert.equal(existsSync(join(h.root, ".usage")), false);
    } finally { await h.cleanup(); }
  }
});

test("Retained from preserves compact delegation and source-owned origins", async () => {
  const h = await createHarness();
  const skill = join(h.root, "..", "sample");
  try {
    await mkdir(join(skill, "recipes"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: sample\ndescription: Test\n---\n");
    await writeFile(join(skill, "recipes", "task.json"), JSON.stringify({
      async: true, description: "Source", args: ["text:string"], template: "echo {text} {recipe_dir} {skill_dir}",
    }));
    const context = { recipeResolutionContext: createRecipeResolutionContext("retained", dirname(h.root),
      createActiveSkillRecipeContext([{ name: "sample", baseDir: skill }])) };
    const result = await executeRegisterTool({ name: "saved", from: "sample/task", defaults: { text: "value" }, expose: false }, context, h.deps);
    const path = join(h.root, "library", "saved.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { template: "sample/task", defaults: { text: "value" } });
    const effective = readResolvedRecipeConfig(path, [], { skillContext: context.recipeResolutionContext.activeSkills })!;
    assert.equal(effective.async, true);
    assert.ok(JSON.stringify(effective.template).includes(JSON.stringify(skill).slice(1, -1)));
    assert.ok(JSON.stringify(effective.template).includes(JSON.stringify(join(skill, "recipes")).slice(1, -1)));
    assert.equal(result.details.async, true);
    assert.deepEqual(h.runtimeRegistered, []);
  } finally { await h.cleanup(); }
});

test("Retained preflight refuses unsupported modes, invalid input and oversized content before storage", async () => {
  const cases = [
    { expose: false, template: "echo", description: "Missing name" },
    { name: "saved", expose: "false", template: "echo", description: "Wrong type" },
    { name: "saved", expose: false, update: true, template: "echo", description: "Update" },
    { name: "saved", expose: false, template: null },
    { name: "saved", expose: false, template: "" },
    { name: "saved", expose: false, draft: "/unread/draft.json" },
    { name: "saved", expose: false, description: "Missing source" },
    { name: "saved", expose: false, template: "echo" },
    { name: "saved", expose: false, description: "Too large", template: "echo " + "x".repeat(1024 * 1024) },
  ];
  for (const input of cases) {
    const h = await createHarness();
    try {
      await assert.rejects(executeRegisterTool(input, {}, h.deps));
      assert.equal(existsSync(join(h.root, "library")), false);
      assert.deepEqual(h.runtimeRegistered, []);
      assert.deepEqual([...h.tools.keys()], []);
    } finally { await h.cleanup(); }
  }
  const h = await createHarness();
  try {
    const draft = join(h.root, "drafts", "source.json");
    await mkdir(dirname(draft), { recursive: true });
    await writeFile(draft, JSON.stringify({ template: "echo draft" }));
    await assert.rejects(executeRegisterTool({ name: "saved", from: draft, expose: false }, {}, h.deps), /disposable draft/);
    assert.equal(existsSync(join(h.root, "library")), false);
    assert.equal(await readFile(draft, "utf8"), JSON.stringify({ template: "echo draft" }));
  } finally { await h.cleanup(); }
});

test("Retained direct draft delegation is refused in authored template graphs as well as from", async () => {
  const h = await createHarness();
  const draft = join(h.root, "drafts", "source.json");
  try {
    await mkdir(dirname(draft), { recursive: true });
    await writeFile(draft, JSON.stringify({ template: "echo draft" }));
    for (const template of [draft, "../drafts/source.json", [draft], [{ template: draft, timeout: 1000 }]]) {
      await assert.rejects(executeRegisterTool({ name: "saved", description: "Draft dependency", template, expose: false }, {}, h.deps), /disposable draft/);
      assert.equal(existsSync(join(h.root, "library")), false);
    }
    assert.equal(await readFile(draft, "utf8"), JSON.stringify({ template: "echo draft" }));
    const stable = join(dirname(h.root), "stable.json");
    await writeFile(stable, JSON.stringify({ template: "echo stable" }));
    const saved = await executeRegisterTool({ name: "stable_graph", description: "Stable delegation",
      template: [stable, { template: "echo final" }], expose: false }, {}, h.deps);
    assert.equal(saved.details.kind, "retained_recipe");
    assert.deepEqual(h.runtimeRegistered, []);
  } finally { await h.cleanup(); }
});

test("Retained root-release failure reports uncertain effects and preserves the exact published cause", async t => {
  const h = await createHarness();
  const path = join(h.root, "library", "saved.json"), rootLock = mutationLockPath(h.root);
  const original = fs.writeFileSync, cause = Object.freeze({ private: "ROOT_RELEASE_SENTINEL" });
  let injected = false;
  try {
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).startsWith(rootLock + ".reclaim.") && String(args[0]).endsWith("owner.json") && existsSync(path)) {
        injected = true; throw cause;
      }
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    let failure: unknown;
    try { await executeRegisterTool({ name: "saved", description: "Release failure", template: "echo saved", expose: false }, {}, h.deps); }
    catch (error) { failure = error; }
    assert.equal(injected, true);
    assert.ok(failure instanceof Error);
    assert.equal(failure.cause, cause);
    assert.match(failure.message, /effects.*unknown/);
    assert.equal(registryYaml(failure.message).operation, "retain");
    assert.equal(failure.message.includes("ROOT_RELEASE_SENTINEL"), false);
    assert.equal(JSON.parse(await readFile(path, "utf8")).template, "echo saved");
    assert.deepEqual(h.runtimeRegistered, []);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    // The intentionally failed original lock release is not repaired or guessed absent by the fixture.
    t.diagnostic(`Controlled retained root-release fixture retained: ${h.root}; no native closure claim`);
  }
});

test("Retained duplicate stems and publication failures preserve existing and published files", async t => {
  for (const extension of ["json", "md"]) {
    const h = await createHarness();
    try {
      const library = join(h.root, "library");
      await mkdir(library, { recursive: true });
      const path = join(library, `saved.${extension}`);
      await writeFile(path, "existing");
      await assert.rejects(executeRegisterTool({ name: "saved", template: "echo new", description: "New", expose: false }, {}, h.deps), /already exists/);
      assert.equal(await readFile(path, "utf8"), "existing");
      assert.deepEqual(h.runtimeRegistered, []);
    } finally { await h.cleanup(); }
  }
  for (const published of [false, true]) {
    const h = await createHarness();
    const original = fs.linkSync, cause = Object.freeze({ published });
    try {
      t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
        if (published) Reflect.apply(original, fs, args);
        throw cause;
      });
      syncBuiltinESMExports();
      let failure: unknown;
      try { await executeRegisterTool({ name: "saved", template: "echo new", description: "New", expose: false }, {}, h.deps); }
      catch (error) { failure = error; }
      assert.ok(failure instanceof Error);
      assert.equal(failure.cause, cause);
      assert.match(failure.message, /effects.*unknown/);
      const path = join(h.root, "library", "saved.json");
      assert.equal(existsSync(path), published);
      if (published) assert.equal(JSON.parse(await readFile(path, "utf8")).template, "echo new");
      assert.deepEqual(h.runtimeRegistered, []);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.cleanup(); }
  }
});

test("Retained receipts omit whole oversized argument groups and never echo authored defaults", async () => {
  const h = await createHarness();
  const names = Array.from({ length: 1000 }, (_, index) => `argument_with_long_name_${index}`);
  try {
    const result = await executeRegisterTool({ name: "bounded", description: "Bounded receipt", expose: false,
      template: "echo {secret_arg} " + names.map(name => `{${name}}`).join(" "),
      defaults: { secret_arg: "PRIVATE_DEFAULT_SENTINEL" },
    }, {}, h.deps);
    const text = result.content[0].text, document = registryYaml(text);
    assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    assert.equal(document.required_args, "[omitted]");
    assert.equal(document.required_args_omission.total, names.length);
    assert.deepEqual(result.details.required_args, names);
    assert.deepEqual(result.details.optional_args, ["secret_arg"]);
    assert.equal(document.recipe, join(h.root, "library", "bounded.json"));
    assert.equal((text + JSON.stringify(result.details)).includes("PRIVATE_DEFAULT_SENTINEL"), false);
  } finally { await h.cleanup(); }
});

test("Retained mode passes through the actual SDK Boolean schema without activating a tool", async () => {
  const h = await createHarness();
  try {
    const definition = createRegisterToolDefinition(h.deps);
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const manifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import;
    const { runToolCall } = await import(new URL(entry, pathToFileURL(manifest)).href);
    let calls = 0;
    const hostTool = { ...definition, execute: (...args: [string, unknown, AbortSignal | undefined, unknown]) => {
      calls++; return definition.execute(...args, {});
    } };
    const dispatch = (arguments_: Record<string, unknown>) => {
      const call = { type: "toolCall", id: "retained-sdk", name: "register_tool", arguments: arguments_ };
      return runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] },
        assistantMessage: { role: "assistant", content: [call] } });
    };
    const accepted = await dispatch({ name: "sdk_retained", expose: false, description: "SDK retained", template: "echo" });
    assert.equal(accepted.isError, false);
    assert.equal(accepted.result.details.kind, "retained_recipe");
    assert.equal(accepted.result.details.activation, "not_requested");
    assert.equal(calls, 1);
    for (const expose of ["not-a-boolean", {}]) {
      const rejected = await dispatch({ name: "sdk_invalid", expose, description: "Invalid", template: "echo" });
      assert.equal(rejected.isError, true);
      assert.equal(calls, 1);
    }
    assert.deepEqual(h.runtimeRegistered, []);
    assert.equal(existsSync(join(h.root, "library", "sdk_invalid.json")), false);
  } finally { await h.cleanup(); }
});

test("Retained storage refuses symlink roots and leaves foreign content untouched", async () => {
  for (const slot of ["root", "library", "target"] as const) {
    const h = await createHarness();
    const foreign = join(dirname(h.root), "foreign");
    try {
      await mkdir(foreign, { recursive: true });
      await writeFile(join(foreign, "keep.json"), "foreign");
      if (slot === "root") fs.symlinkSync(foreign, h.root, process.platform === "win32" ? "junction" : "dir");
      else {
        await mkdir(h.root);
        if (slot === "library") fs.symlinkSync(foreign, join(h.root, "library"), process.platform === "win32" ? "junction" : "dir");
        else {
          await mkdir(join(h.root, "library"));
          fs.symlinkSync(foreign, join(h.root, "library", "saved.json"), process.platform === "win32" ? "junction" : "dir");
        }
      }
      await assert.rejects(executeRegisterTool({ name: "saved", description: "New", template: "echo", expose: false }, {}, h.deps));
      assert.deepEqual(fs.readdirSync(foreign), ["keep.json"]);
      assert.equal(await readFile(join(foreign, "keep.json"), "utf8"), "foreign");
      assert.deepEqual(h.runtimeRegistered, []);
    } finally { await h.cleanup(); }
  }
});

test("Retained commit rechecks library identity and cannot clobber a late competing file", async t => {
  for (const changed of ["directory", "competitor", "markdown"] as const) {
    const h = await createHarness();
    const library = join(h.root, "library"), path = join(library, "saved.json");
    try {
      let injected = false;
      if (changed === "directory") {
        const original = fs.writeFileSync;
        t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
          const result = Reflect.apply(original, fs, args);
          if (!injected && String(args[0]).startsWith(path + ".") && String(args[0]).endsWith(".tmp")) {
            injected = true; fs.renameSync(library, join(h.root, "original-library")); fs.mkdirSync(library);
          }
          return result;
        });
      } else {
        const original = fs.linkSync;
        t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
          if (String(args[1]) === path && !injected) {
            injected = true; fs.writeFileSync(changed === "markdown" ? path.replace(/\.json$/u, ".md") : path, "competitor", { flag: "wx" });
          }
          return Reflect.apply(original, fs, args);
        });
      }
      syncBuiltinESMExports();
      await assert.rejects(executeRegisterTool({ name: "saved", description: "New", template: "echo new", expose: false }, {}, h.deps), /effects.*unknown/);
      assert.equal(injected, true);
      if (changed === "directory") assert.equal(existsSync(path), false);
      else if (changed === "markdown") {
        assert.equal(await readFile(path.replace(/\.json$/u, ".md"), "utf8"), "competitor");
        assert.equal(JSON.parse(await readFile(path, "utf8")).template, "echo new");
      } else assert.equal(await readFile(path, "utf8"), "competitor");
      assert.deepEqual(h.runtimeRegistered, []);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.cleanup(); }
  }
});

test("Sibling retained creators have one winner without host registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retained-process-"));
  const module = new URL("../lib/registry.ts", import.meta.url).href;
  const source = (template: string) => `
    import { join } from "node:path";
    const { executeRegisterTool } = await import(${JSON.stringify(module)});
    const root = ${JSON.stringify(root)};
    const denied = () => { throw Error("No host or tool map"); };
    const deps = { configPath: join(root, "config.json"), recipeRoot: root,
      getToolNameBlocker: () => undefined, reservedToolNames: new Set(),
      getTools: denied, getActiveTools: denied, setActiveTools: denied, notify: denied, registerRuntimeTool: denied };
    try { await executeRegisterTool(${JSON.stringify({ name: "shared", template, description: "Retained", expose: false })}, {}, deps); console.log("retained"); }
    catch (error) { console.log("rejected:" + error.message); }
  `;
  try {
    const results = await Promise.all(["echo first", "echo second"].map(template => execFileAsync(process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source(template)])));
    const outputs = results.map(result => result.stdout.trim());
    assert.equal(outputs.filter(value => value === "retained").length, 1);
    assert.equal(outputs.filter(value => /already exists/.test(value)).length, 1);
    const saved = JSON.parse(await readFile(join(root, "library", "shared.json"), "utf8"));
    assert.ok(["echo first", "echo second"].includes(saved.template));
    assert.equal(existsSync(join(root, "shared.json")), false);
    assert.equal(existsSync(join(root, ".usage")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Registry mutations register template-backed tools", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        args: "file,lang=ru",
        description: "Transcribe audio",
        name: "Transcribe",
        template: "~/bin/transcribe {file} {lang}",
      },
      {},
      harness.deps,
    );
    assert.equal(harness.tools.get("transcribe")?.defaults.lang, "ru");
    const stored = JSON.parse(
      await readFile(join(dirname(harness.deps.configPath), "recipes", "transcribe.json"), "utf8"),
    );
    assert.deepEqual(stored, {
      description: "Transcribe audio",
      args: ["file", "lang"],
      defaults: { lang: "ru" },
      template: "~/bin/transcribe {file} {lang}",
    });
    assert.deepEqual(harness.runtimeRegistered, ["transcribe"]);
    const receipt = registryYaml(result.content[0].text);
    assert.equal(receipt.tool, "transcribe"); assert.equal(receipt.result, "persisted"); assert.equal(receipt.source, "template");
    assert.equal(receipt.callable_now, false); assert.equal(receipt.activation_boundary, "session_activation_unverified");
    assert.deepEqual(result.details.required_args, ["file"]);
    assert.deepEqual(result.details.optional_args, ["lang"]);
    assert.equal(result.details.source, "template");
    assert.equal(result.details.activation_boundary, "session_activation_unverified");
    assert.deepEqual(result.details.next_actions, [
      "inspect target=tool:transcribe view=status",
    ]);
    assert.equal("config" in result.details, false);
    assert.equal("template" in result.details, false);
  } finally {
    await harness.cleanup();
  }
});

test("Concurrent same-name registry mutations have one collision winner", async () => {
  const harness = await createHarness();
  try {
    const attempts = await Promise.allSettled([
      executeRegisterTool(
        { description: "First", name: "shared", template: "echo first" },
        {},
        harness.deps,
      ),
      executeRegisterTool(
        { description: "Second", name: "shared", template: "echo second" },
        {},
        harness.deps,
      ),
    ]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      ["fulfilled", "rejected"],
    );
    assert.match(
      String(attempts[1].status === "rejected" ? attempts[1].reason : ""),
      /already registered/,
    );
    const stored = JSON.parse(
      await readFile(join(dirname(harness.deps.configPath), "recipes", "shared.json"), "utf8"),
    );
    assert.equal(stored.template, "echo first");
  } finally {
    await harness.cleanup();
  }
});

test("Sibling processes cannot silently overwrite the same registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-registry-process-"));
  const registryUrl = new URL("../lib/registry.ts", import.meta.url).href;
  const childSource = (description: string, template: string) => `
    import { join } from "node:path";
    const { executeRegisterTool } = await import(${JSON.stringify(registryUrl)});
    const root = ${JSON.stringify(root)};
    const tools = new Map();
    const deps = {
      configPath: join(root, "registry.json"),
      recipeRoot: root,
      getActiveTools: () => [],
      getToolNameBlocker: () => undefined,
      getTools: () => tools,
      notify: () => {},
      registerRuntimeTool: () => {},
      reservedToolNames: new Set(),
      setActiveTools: () => {},
    };
    try {
      await executeRegisterTool(${JSON.stringify({ name: "shared", description, template })}, {}, deps);
      console.log("registered");
    } catch (error) {
      console.log("rejected:" + (error instanceof Error ? error.message : String(error)));
    }
  `;
  try {
    const attempts = await Promise.all([
      execFileAsync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childSource("First", "echo first"),
      ]),
      execFileAsync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childSource("Second", "echo second"),
      ]),
    ]);
    const outputs = attempts.map((attempt) => attempt.stdout.trim()).sort();
    assert.equal(outputs.filter((output) => output === "registered").length, 1);
    assert.equal(
      outputs.filter((output) => /rejected:[\s\S]*already registered/.test(output)).length,
      1,
      JSON.stringify(outputs),
    );
    const stored = JSON.parse(
      await readFile(join(root, "shared.json"), "utf8"),
    );
    assert.equal(["echo first", "echo second"].includes(stored.template), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Registry mutations register typed command-template args progressively", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        args: "file:path,request_timeout:int=60000,speed:number=1.5,dry_run:bool=true,mode:enum(check,fix)=check",
        description: "Run checker",
        name: "check_tool",
        template: "check {file} {request_timeout} {speed} {dry_run} {mode}",
      },
      {},
      harness.deps,
    );
    assert.deepEqual(harness.tools.get("check_tool")?.args, [
      "file",
      "request_timeout",
      "speed",
      "dry_run",
      "mode",
    ]);
    assert.deepEqual(harness.tools.get("check_tool")?.storedArgs, [
      "file:path",
      "request_timeout:int",
      "speed:number",
      "dry_run:bool",
      "mode:enum(check,fix)",
    ]);
    assert.deepEqual(harness.tools.get("check_tool")?.argTypes?.request_timeout, {
      kind: "int",
    });
    assert.deepEqual(harness.tools.get("check_tool")?.argTypes?.speed, {
      kind: "number",
    });
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations specialize active-Skill Recipes through from", async () => {
  const harness = await createHarness();
  try {
    const skillDir = join(dirname(harness.root), "skills", "music-player");
    await mkdir(join(skillDir, "recipes"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: music-player\n---\n");
    await writeFile(
      join(skillDir, "recipes", "playback.json"),
      JSON.stringify({
        args: ["command:enum(play,status)", "volume:int", "state_dir:path"],
        artifacts: { state: "{state_dir}/state.json" },
        async: true,
        control: ["play", "status"],
        defaults: { command: "play", volume: 70 },
        description: "Control local media.",
        template: "echo {skill_dir} {command} {volume} {state_dir}",
      }),
    );
    const recipeResolutionContext = createRecipeResolutionContext(
      "registry-from",
      dirname(harness.root),
      createActiveSkillRecipeContext([{ name: "music-player", baseDir: skillDir }]),
    );
    const result = await executeRegisterTool(
      {
        defaults: { volume: 35 },
        from: "music-player/playback",
        name: "music_player",
      },
      { recipeResolutionContext },
      harness.deps,
    );
    const stored = JSON.parse(
      await readFile(join(harness.root, "music_player.json"), "utf8"),
    );
    assert.deepEqual(stored, {
      defaults: { volume: 35 },
      template: "music-player/playback",
    });
    const tool = harness.tools.get("music_player")!;
    assert.equal(tool.description, "Control local media.");
    assert.equal(tool.recipe?.async, true);
    assert.deepEqual(tool.recipe?.control, ["play", "status"]);
    assert.deepEqual(tool.recipe?.artifacts, { state: "{state_dir}/state.json" });
    assert.deepEqual(tool.args, ["command", "volume"]);
    assert.deepEqual(tool.argTypes?.command, {
      kind: "enum",
      values: ["play", "status"],
    });
    assert.deepEqual(tool.argTypes?.volume, { kind: "int" });
    assert.deepEqual(result.details.defaults, { command: "play", volume: "35" });
    assert.equal(result.details.async, true);
    await assert.rejects(
      executeRegisterTool(
        {
          defaults: { volume: "loud" },
          from: "music-player/playback",
          name: "bad_volume",
        },
        { recipeResolutionContext },
        harness.deps,
      ),
      /music-player\/playback.*validation failed.*volume.*integer.*instruction: "inspect target=recipes view=doctor identity=music-player\/playback/is,
    );
    await assert.rejects(
      executeRegisterTool(
        {
          defaults: { unknown: "value" },
          from: "music-player/playback",
          name: "bad_default",
        },
        { recipeResolutionContext },
        harness.deps,
      ),
      /music-player\/playback.*validation failed.*Unknown delegated Recipe default argument: unknown.*instruction: "inspect target=recipes view=doctor identity=music-player\/playback/is,
    );
    await assert.rejects(
      executeRegisterTool(
        {
          defaults: { state_dir: "/tmp/copied-state" },
          from: "music-player/playback",
          name: "bad_origin",
        },
        { recipeResolutionContext },
        harness.deps,
      ),
      /key: "state_dir".*runtime-owned.*instruction: "remove that default and retry register_tool/is,
    );
    await assert.rejects(readFile(join(harness.root, "bad_volume.json"), "utf8"));
    await assert.rejects(readFile(join(harness.root, "bad_default.json"), "utf8"));
    await assert.rejects(readFile(join(harness.root, "bad_origin.json"), "utf8"));
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations reject ambiguous or copied Recipe source modes", async () => {
  const harness = await createHarness();
  try {
    for (const [params, pattern] of [
      [
        { description: "Mixed", from: "music-player/playback", name: "mixed", template: "echo" },
        /exactly one register_tool source mode.*instruction: \"remove the extra source fields and retry register_tool/s,
      ],
      [
        { args: "source:path", from: "music-player/playback", name: "copied_args" },
        /from inherits args and async behavior.*instruction: \"retry register_tool with from and optional defaults only/s,
      ],
      [
        { name: "missing_source" },
        /requires exactly one source mode.*instruction: \"retry register_tool with one source field/s,
      ],
      [
        { from: "", name: "empty_from" },
        /non-empty Recipe reference.*instruction: \"retry register_tool with from=<skill>\/<recipe>/s,
      ],
      [
        { from: "skill:music-player/playback", name: "prefixed_from" },
        /skill: Recipe references were removed.*instruction: "inspect target=recipes view=doctor identity=music-player\/playback/s,
      ],
      [
        { from: "std:player", name: "std_from" },
        /std: Recipe references were removed.*instruction: "inspect target=recipes view=doctor/s,
      ],
      [
        { description: "Nested", name: "nested", template: { template: "music-player/playback" } },
        /Nested Recipe-shaped templates.*instruction: \"retry with from=<skill>\/<recipe> and defaults=/is,
      ],
      [
        { description: "Legacy values", name: "legacy_values", template: "echo", values: { x: 1 } },
        /values was removed.*instruction: \"retry register_tool with defaults/is,
      ],
    ] as const) {
      await assert.rejects(executeRegisterTool(params, {}, harness.deps), pattern);
    }
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations specialize explicit Recipe paths through from", async () => {
  const harness = await createHarness();
  try {
    const cwd = dirname(harness.root);
    const sourceDir = join(cwd, "source");
    const sourcePath = join(sourceDir, "docs-review.json");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      sourcePath,
      JSON.stringify({
        args: ["scope:path", "model:string"],
        description: "Start docs review actor",
        template: "review {scope} {model}",
      }),
    );
    const recipeResolutionContext = createRecipeResolutionContext(
      "registry-file-from",
      cwd,
      createActiveSkillRecipeContext([]),
    );
    const result = await executeRegisterTool(
      {
        defaults: { model: "selected-model" },
        from: "./source/docs-review.json",
        name: "docs_review",
      },
      { recipeResolutionContext },
      harness.deps,
    );
    assert.equal(
      (harness.tools.get("docs_review")?.recipe?.template as { template: string })
        .template,
      "review {scope} {model}",
    );
    assert.deepEqual(harness.tools.get("docs_review")?.args, ["scope", "model"]);
    assert.deepEqual(harness.runtimeRegistered, ["docs_review"]);
    assert.equal(result.details.source, "./source/docs-review.json");
    assert.deepEqual(result.details.required_args, ["scope"]);
    assert.deepEqual(result.details.optional_args, ["model"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(harness.root, "docs_review.json"), "utf8")),
      { defaults: { model: "selected-model" }, template: sourcePath },
    );
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations apply defaults to co-located command Recipes", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        async: true,
        description: "Start review run",
        name: "review_run",
        defaults: { prompt: "Review risks." },
        template: "review {scope} {prompt}",
      },
      {},
      harness.deps,
    );
    const registeredRecipe = harness.tools.get("review_run")?.recipe;
    assert.equal(registeredRecipe?.async, true);
    assert.equal(registeredRecipe?.name, "review_run");
    assert.equal(registeredRecipe?.description, "Start review run");
    assert.equal(
      (registeredRecipe?.template as { template: string }).template,
      "review {scope} {prompt}",
    );
    const stored = JSON.parse(
      await readFile(join(harness.root, "review_run.json"), "utf8"),
    );
    assert.equal(stored.values, undefined);
    assert.deepEqual(stored.defaults, { prompt: "Review risks." });
    assert.deepEqual(registeredRecipe?.defaults, { prompt: "Review risks." });
    assert.deepEqual(harness.tools.get("review_run")?.args, ["scope", "prompt"]);
    assert.equal(result.details.async, true);
    assert.deepEqual(result.details.required_args, ["scope"]);
    assert.deepEqual(result.details.optional_args, [
      "prompt",
      "run_id",
      "transport_context",
    ]);
    assert.equal("recipeName" in result.details, false);
    assert.equal("state_dir" in result.details, false);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register command-template sequences", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        args: "text,mp3,ogg",
        description: "Create voice artifact",
        name: "voice_tool",
        template: [
          "tts --text {text} --out {mp3}",
          { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
        ],
      },
      {},
      harness.deps,
    );
    assert.equal(
      harness.tools.get("voice_tool")?.template,
      join(harness.root, "voice_tool.json"),
    );
    assert.deepEqual(harness.tools.get("voice_tool")?.recipe?.template, {
      args: ["text", "mp3", "ogg"],
      template: [
        "tts --text {text} --out {mp3}",
        { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
      ],
    });
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register object command templates", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        description: "Run guarded object template",
        name: "object_tool",
        template: {
          parallel: true,
          recover: "echo recovered",
          retry: 2,
          template: [
            "echo {topic}",
            { template: "echo done", timeout: 123 },
          ],
          timeout: 456,
        },
      },
      {},
      harness.deps,
    );
    assert.equal(
      harness.tools.get("object_tool")?.template,
      join(harness.root, "object_tool.json"),
    );
    assert.deepEqual(harness.tools.get("object_tool")?.recipe?.template, {
      parallel: true,
      recover: "echo recovered",
      retry: 2,
      template: [
        "echo {topic}",
        { template: "echo done", timeout: 123 },
      ],
      timeout: 456,
    });
    assert.deepEqual(harness.tools.get("object_tool")?.args, ["topic"]);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations reject invalid object command templates", async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Bad object template",
          name: "bad_object_tool",
          template: { repeat: 0, template: "echo nope" },
        },
        {},
        harness.deps,
      ),
      /repeat must be a positive integer/,
    );
    await assert.rejects(
      readFile(join(harness.root, "bad_object_tool.json"), "utf8"),
    );
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations reject overwrites without update=true", async () => {
  const harness = await createHarness();
  harness.tools.set("smoke", {
    args: [],
    defaults: {},
    description: "Old",
    name: "smoke",
    template: "old",
  });
  try {
    await assert.rejects(
      executeRegisterTool(
        {
          description: "New",
          name: "smoke",
          template: "new",
        },
        {},
        harness.deps,
      ),
      /already registered/,
    );
  } finally {
    await harness.cleanup();
  }
});

test("Registry activation failure restores prior bytes state and active tools", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        description: "Working tool",
        name: "working_tool",
        template: "echo working",
      },
      {},
      harness.deps,
    );
    const path = join(harness.root, "working_tool.json");
    const priorBytes = await readFile(path, "utf8");
    const priorActive = harness.activeTools();
    const failingDeps = {
      ...harness.deps,
      registerRuntimeTool: (cfg: RegisteredTool) =>
        cfg.description === "Broken replacement"
          ? {
              active_tool: false,
              activation: "unverified" as const,
              callable_now: false,
              host_registered: true,
            }
          : {
              active_tool: true,
              activation: "current_session" as const,
              callable_now: true,
              host_registered: true,
            },
    };
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Broken replacement",
          name: "working_tool",
          template: "echo broken",
          update: true,
        },
        {},
        failingDeps,
      ),
      /Tool \\\"working_tool\\\" activation failed at active_tool_set.*callable_now=false.*Registration was rolled back.*Next: inspect target=runtime view=status; do not use spawn as proof/s,
    );
    assert.equal(await readFile(path, "utf8"), priorBytes);
    assert.equal(harness.tools.get("working_tool")?.description, "Working tool");
    assert.deepEqual(harness.activeTools(), priorActive);
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Broken new tool",
          name: "broken_new",
          template: "echo broken",
        },
        {},
        {
          ...harness.deps,
          registerRuntimeTool: () => ({
            active_tool: false,
            activation: "unverified" as const,
            callable_now: false,
            host_registered: false,
          }),
        },
      ),
      /Tool \\"broken_new\\\" activation failed at host_registration.*callable_now=false.*Registration was rolled back.*Next: inspect target=runtime view=status; do not use spawn as proof/s,
    );
    await assert.rejects(readFile(join(harness.root, "broken_new.json"), "utf8"));
    assert.equal(harness.tools.has("broken_new"), false);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations delete tools and deactivate them", async () => {
  const harness = await createHarness();
  harness.tools.set("smoke", {
    args: [],
    defaults: {},
    description: "Old",
    name: "smoke",
    template: "old",
  });
  try {
    const result = await executeRegisterTool(
      {
        name: "smoke",
        template: null,
      },
      {},
      harness.deps,
    );
    assert.equal(harness.tools.has("smoke"), false);
    assert.deepEqual(harness.activeTools(), ["read"]);
    assert.match(result.content[0].text, /tool: "smoke"\nresult: "deleted"/);
  } finally {
    await harness.cleanup();
  }
});
