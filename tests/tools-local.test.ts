/** Mirrors lib/tools-local.ts; controlled ports prove error presentation, not native actuation. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";
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

test("Runtime usage headers omit unfit argument groups and preserve the complete JSON example", async () => {
  const args = Array.from({ length: 1600 }, (_, i) => "input_" + i);
  const definition = createRuntimeToolDefinition({ ...config, args, defaults: {}, template: "check " + args.map(arg => "{" + arg + "}").join(" ") },
    async () => { throw new Error("Must not enter execution"); });
  await assert.rejects(definition.execute("usage-large", {}, undefined, undefined, { cwd: "/work" }), (error: Error) => {
    const end = error.message.indexOf("\n---\n", 5);
    assert.ok(end > 5);
    const header = error.message.slice(5, end), doc = parseDocument(header);
    assert.deepEqual(doc.errors, []);
    assert.ok(Buffer.byteLength(header) < 16384);
    assert.deepEqual(doc.toJS(), { tool: "boundary", required: "[omitted]",
      required_omission: { reason: "response_too_large", shown: 0, omitted: args.length, total: args.length }, optional: [] });
    const example = Object.fromEntries(args.map(arg => [arg, "<" + arg + ">"]));
    assert.ok(error.message.endsWith("boundary(" + JSON.stringify(example, null, 2) + ")"));
    assert.doesNotMatch(error.message, /undefined---/);
    return true;
  });
});

test("Runtime argument repair keeps owned usage facts in a YAML header and the JSON example verbatim", async () => {
  const checker = () => createRuntimeToolDefinition({
    argTypes: { mode: { kind: "enum", values: ["check", "fix"] } },
    args: ["file", "mode"],
    defaults: { mode: "check" },
    description: "Run checker",
    name: "check_tool",
    template: "check {file} {mode}",
  }, async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));
  await assert.rejects(checker().execute("usage", { file: "README.md", mode: "delete" }, undefined, undefined, { cwd: "/work" }), (error: Error) => {
    assert.equal(error.message, [
      "",
      "---",
      'tool: "check_tool"',
      "required:",
      '  - "file"',
      "optional:",
      '  - "mode"',
      "---",
      'Invalid arguments for tool "check_tool": Argument mode must be one of: check, fix.',
      "",
      "Expected call shape for check_tool:",
      "check_tool({",
      '  "file": "<file>",',
      '  "mode": "check"',
      "})",
    ].join("\n"));
    return true;
  });
  // The same owned facts carry the async run_id option; empty required stays a real empty sequence.
  const asyncTool = createRuntimeToolDefinition({ ...config, recipe: { async: true, template: "check {mode}" } }, async () => {
    throw new Error("The synchronous executor must not be used");
  });
  await assert.rejects(asyncTool.execute("usage-async", { mode: "delete" }, undefined, undefined, { cwd: "/work" }), (error: Error) => {
    assert.match(error.message, /^\n---\ntool: "boundary"\nrequired:\n  \[\]\noptional:\n  - "mode"\n  - "run_id"\n---\nInvalid arguments for tool "boundary": /u);
    assert.match(error.message, /\nExpected call shape for boundary:\nboundary\(\{\n  "mode": "check",\n  "run_id": "boundary-1"\n\}\)$/);
    return true;
  });
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
