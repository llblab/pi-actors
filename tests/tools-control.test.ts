import assert from "node:assert/strict";
import test from "node:test";

import { createControlToolDefinition } from "../lib/tools-message.ts";

test("Public message tool exposes only the exact Control schema", () => {
  const tool = createControlToolDefinition();
  assert.equal(tool.name, "message");
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
  assert.match(response.content[0].text, /target=runtime action=review\.retry status=handled/);
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
