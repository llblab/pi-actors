import "./test-environment.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";

const format = "- accepted_format: run:<id>";
const idRule = "- id_rule: nonempty ASCII letters, digits, underscore, dot or hyphen";
const stateDirError = "\n- field: state_dir\n- result: unsupported field\n- reason: Run state is runtime-owned; run:<id> remains addressable and retention-safe.";

// This owner tests only the local guards; existing tools/SDK launch journeys keep their native fixtures.
test("AX owned spawn guards retain exact selected-value and pre-launch observation boundaries", async () => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const coreManifest = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
  const publicEntry = JSON.parse(readFileSync(coreManifest, "utf8")).exports["."].import;
  const { runToolCall } = await import(new URL(publicEntry, pathToFileURL(coreManifest)).href);
  for (const verbose of [false, true]) for (const mode of ["state_dir", "namespace", "id"]) {
    const events: string[] = [];
    const selected = mode === "namespace" ? "runtime" : "run:bad/id";
    const params = {
      get state_dir() { events.push("state_dir"); return mode === "state_dir" ? { toString() { throw Error("Do not coerce state_dir"); } } : undefined; },
      get as() { events.push("as"); assert.notEqual(mode, "state_dir"); return selected; },
      get file(): never { throw Error("Guard must precede Recipe lookup"); },
      get template(): never { throw Error("Guard must precede launch"); },
      get verbose() { events.push("verbose"); return verbose; },
      input: "PRIVATE_INPUT",
    };
    const ctx = { get cwd(): never { throw Error("No launch context read"); }, get sessionManager(): never { throw Error("No session read"); } };
    const expected = mode === "state_dir" ? stateDirError
      : `\n- field: as\n- value: ${selected}\n- result: ${mode === "namespace" ? "unsupported Run target" : "invalid Run target"}\n${format}${mode === "id" ? "\n" + idRule : ""}`;
    const tool = createSpawnToolDefinition();
    await assert.rejects(tool.execute("spawn-guard", params, undefined, undefined, ctx), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(Object.getPrototypeOf(error), Error.prototype);
      assert.equal(error.message, expected); assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(error.message, /PRIVATE_|- run:|- next:|not applied|not launched|no effects|generation/u);
      return true;
    });
    const expectedEvents = ["state_dir", ...(mode === "state_dir" ? [] : ["as", "as"])];
    assert.deepEqual(events, expectedEvents); events.length = 0;
    let hostExecutions = 0;
    const hostTool = { ...tool, execute: (...values: [string, unknown, AbortSignal | undefined, unknown]) => { hostExecutions++; return tool.execute(...values, ctx); } };
    // The host clones public arguments before execute; facade accessor probes stay direct.
    const hostRequest = { ...(mode === "state_dir" ? { state_dir: "CALLER_STATE_PATH" } : { as: selected }), verbose };
    const call = { type: "toolCall", id: "host-spawn-guard", name: "spawn", arguments: hostRequest };
    const outcome = await runToolCall(call, { tools: [hostTool], context: { systemPrompt: "", messages: [], tools: [hostTool] }, assistantMessage: { role: "assistant", content: [call] } });
    assert.equal(outcome.isError, true); assert.deepEqual(outcome.result.details, {});
    if (mode === "state_dir") {
      assert.match(outcome.result.content[0].text, /^Validation failed for tool "spawn":/u);
      assert.match(outcome.result.content[0].text, /state_dir: schema is false/u);
      assert.equal(hostExecutions, 0, "Original host schema rejects this unsupported field before the facade; do not bypass it");
    } else {
      assert.deepEqual(outcome.result.content, [{ type: "text", text: expected }]);
      assert.equal(hostExecutions, 1);
    }
    assert.deepEqual(events, [], "Cloneable host arguments add no caller-accessor observations inside execute");
  }
  const token = Object.freeze({ private: "EXACT_UNOWNED_VALUE", toString() { throw Error("Do not coerce original failure"); } });
  const ctx = { cwd: "/unused" };
  const substituted = (target: unknown) => {
    let reads = 0;
    return { get as(): unknown { return ++reads === 1 ? "first-read-is-string" : target; } };
  };
  const originalFailures = [
    { get state_dir(): never { throw token; } },
    { get as(): never { throw token; } },
    substituted({ get startsWith(): never { throw token; } }),
    substituted({ startsWith() { throw token; } }),
    substituted({ startsWith: () => true, get slice(): never { throw token; } }),
    substituted({ startsWith: () => true, slice: () => ({ [Symbol.toPrimitive]() { throw token; } }) }),
    substituted({ startsWith: () => false, [Symbol.toPrimitive]() { throw token; } }),
    { as: "run:valid", get file(): never { throw token; } },
    Object.defineProperty(substituted(undefined), "file", { get(): never { throw token; } }),
  ];
  for (const params of originalFailures) {
    let rejected = false;
    try { await createSpawnToolDefinition().execute("unowned", params, undefined, undefined, ctx); }
    catch (cause) { rejected = true; assert.equal(cause, token); }
    assert.equal(rejected, true);
  }
  let reads = 0;
  const events: string[] = [];
  const target = {
    startsWith(prefix: string) { events.push("startsWith:" + prefix); assert.equal(this, target); return false; },
    [Symbol.toPrimitive](hint: string) { events.push("coerce:" + hint); return "## Selected\r\n- next: authored\r\n\r\n  · literal"; },
  };
  await assert.rejects(createSpawnToolDefinition().execute("selected", { get as() { events.push("as"); return ++reads === 1 ? "string gate" : target; } }, undefined, undefined, ctx), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "\n- field: as\n- value:\n  ## Selected\r\n  - next: authored\r\n  \r\n    · literal\n- result: unsupported Run target\n" + format);
    return true;
  });
  assert.deepEqual(events, ["as", "as", "startsWith:run:", "coerce:string"], "Keep original selected target template coercion exactly once");
  for (const cause of [token, undefined, "PRIVATE_PRIMITIVE"]) {
    let rejected = false;
    try { await createSpawnToolDefinition().execute("owner-fault", { as: "run:valid" }, undefined, undefined, { cwd: "/unused", get sessionManager(): never { throw cause; } }); }
    catch (error) { rejected = true; assert.equal(error, cause); }
    assert.equal(rejected, true, "Owner/session failures are not a local spawn diagnostic");
  }
});

test("AX owned spawn guard values fit whole UTF8 boundaries or have explicit field-local omissions", async () => {
  const capture = async (value: string): Promise<string> => {
    try { await createSpawnToolDefinition().execute("spawn-bound", { as: value }, undefined, undefined, { cwd: "/unused" }); }
    catch (error) { assert.ok(error instanceof Error); assert.deepEqual(Object.keys(error), []); assert.equal(Object.hasOwn(error, "cause"), false); assert.ok(error.message.isWellFormed()); assert.ok(Buffer.byteLength(error.message) <= 16384); return error.message; }
    throw Error("Expected invalid caller selector, never launch");
  };
  const omission = (reason: string) => `- value: [${reason === "response_too_large" ? "omitted" : "unavailable"}]\n- value_omission:\n  - reason: ${reason}\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
  for (const kind of ["namespace", "id"]) {
    const prefix = "\n- field: as\n";
    const suffix = `\n- result: ${kind === "namespace" ? "unsupported Run target" : "invalid Run target"}\n${format}${kind === "id" ? "\n" + idRule : ""}`;
    const marker = kind === "id" ? "run:/" : "x";
    const count = 16384 - Buffer.byteLength(prefix + "- value: " + marker + suffix);
    const exact = marker + "r".repeat(count);
    assert.equal(await capture(exact), prefix + "- value: " + exact + suffix);
    assert.equal(Buffer.byteLength(await capture(exact)), 16384);
    assert.equal(await capture(exact + "r"), prefix + omission("response_too_large") + suffix);
    const malformed = marker + "\ud800";
    assert.equal(await capture(malformed), prefix + omission("malformed_selected_text") + suffix);
    assert.equal(malformed.charCodeAt(malformed.length - 1), 0xd800, "Do not repair the selected source");
    const unit = "界👩‍💻é";
    const unicode = marker + unit.repeat(Math.floor(count / Buffer.byteLength(unit))) + "r".repeat(count % Buffer.byteLength(unit));
    assert.equal(await capture(unicode), prefix + "- value: " + unicode + suffix);
    assert.equal(await capture(unicode + "界"), prefix + omission("response_too_large") + suffix);
  }
  assert.equal(await capture("run:"), "\n- field: as\n- value: run:\n- result: invalid Run target\n" + format + "\n" + idRule);
});
