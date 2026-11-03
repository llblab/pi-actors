/** Mirrors lib/tools-local.ts; controlled ports prove error presentation, not native actuation. */
import assert from "node:assert/strict";
import test from "node:test";
import type { RegisteredTool } from "../lib/config.ts";
import { createRuntimeToolDefinition } from "../lib/tools-local.ts";

const config: RegisteredTool = {
  args: ["mode"], argTypes: { mode: { kind: "enum", values: ["check", "fix"] } },
  defaults: { mode: "check" }, description: "Controlled error boundary", name: "boundary", template: "check {mode}",
};

test("Runtime executor failures retain the original cause and details even when their text resembles argument validation", async () => {
  for (const recipe of [undefined, { template: "check {mode}" }]) {
    for (const message of ["Argument mode must remain recorded.", "Missing command template value: recorded"]) {
      const cause = new Error("original persistence cause");
      const error = Object.assign(new AggregateError([cause], message, { cause }), { details: { partial_effect: "controlled-port-entered" } });
      let calls = 0;
      const signal = new AbortController().signal;
      const definition = createRuntimeToolDefinition({ ...config, ...(recipe ? { recipe } : {}) }, async (command, args, options) => {
        calls++;
        assert.equal(command, "check"); assert.deepEqual(args, ["check"]);
        assert.equal(options?.cwd, "/controlled"); assert.equal(options?.signal, signal);
        throw error;
      });
      await assert.rejects(definition.execute("failure", {}, signal, undefined, { cwd: "/controlled" }), (actual: unknown) => {
        assert.equal(actual, error);
        assert.equal(error.cause, cause);
        assert.deepEqual(error.errors, [cause]);
        assert.deepEqual(error.details, { partial_effect: "controlled-port-entered" });
        assert.doesNotMatch(error.message, /Invalid arguments|Expected call shape/);
        return true;
      });
      assert.equal(calls, 1, "No automatic retry");
    }
  }
});

test("Runtime validation repair hints stop after the first execution entry, including later missing template values", async () => {
  for (const late of [false, true]) {
    const effects: string[] = [];
    const definition = createRuntimeToolDefinition({ ...config, args: ["mode", "missing"], template: late ? ["check {mode}", "check {missing}"] : ["check {missing}", "check {mode}"] }, async () => {
      effects.push("controlled effect");
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    });
    await assert.rejects(definition.execute("missing", {}, undefined, undefined, { cwd: "/controlled" }), (error: Error) => {
      assert.match(error.message, /Missing command template value: missing/);
      if (late) assert.doesNotMatch(error.message, /Invalid arguments|Expected call shape/);
      else assert.match(error.message, /Invalid arguments[\s\S]*Expected call shape/);
      return true;
    });
    assert.equal(effects.length, late ? 1 : 0);
  }
});

test("Runtime async handoff faults preserve their cause while caller normalization still has useful guidance", async () => {
  let executorCalls = 0, handoffReads = 0;
  const error = Object.assign(new Error("Missing launch value: observer", { cause: new Error("original launcher cause") }), { details: { launch: "unproven" } });
  const definition = createRuntimeToolDefinition({ ...config, recipe: { async: true, template: "check {mode}" } }, async () => {
    executorCalls++;
    throw new Error("The synchronous executor must not be used");
  });
  const context = {
    cwd: "/controlled",
    get onSupervisionClockCaptured(): never { handoffReads++; throw error; },
  };
  await assert.rejects(definition.execute("bad-input", { mode: "delete" }, undefined, undefined, context), /Invalid arguments[\s\S]*Expected call shape/);
  assert.equal(handoffReads, 0, "Caller normalization refuses before launcher options are read");
  await assert.rejects(definition.execute("handoff", {}, undefined, undefined, context), (actual: unknown) => {
    assert.equal(actual, error);
    assert.deepEqual(error.details, { launch: "unproven" });
    assert.doesNotMatch(error.message, /Invalid arguments|Expected call shape/);
    return true;
  });
  assert.equal(handoffReads, 1);
  assert.equal(executorCalls, 0);
});
