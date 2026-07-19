/**
 * Actor Inspector action regressions.
 * Covers exact-owner and run-generation kill authorization, lifecycle races, and bounded failures.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { killOwnedInspectorRun } from "../lib/inspector-actions.ts";

const INSTANCE_A = "instance-a";

function kill(
  deps: Parameters<typeof killOwnedInspectorRun>[4],
  expectedRunInstanceId = INSTANCE_A,
) {
  return killOwnedInspectorRun(
    "session-a",
    "demo",
    "/runs",
    expectedRunInstanceId,
    deps,
  );
}

test("Inspector kill routes exact owner and generation through canonical control", () => {
  const calls: string[] = [];
  const result = kill({
    getRunStatus: (stateDir) => {
      calls.push(`status:${stateDir}`);
      return {
        ownerId: "session-a",
        run_instance_id: INSTANCE_A,
        status: "running",
      };
    },
    killRun: (stateDir, expected) => {
      calls.push(`kill:${stateDir}:${expected.ownerId}:${expected.runInstanceId}`);
      return { killed: true };
    },
  });

  assert.deepEqual(result, { ok: true, message: "Killed run:demo." });
  assert.deepEqual(calls, [
    `status:${join("/runs", "demo")}`,
    `kill:${join("/runs", "demo")}:session-a:${INSTANCE_A}`,
  ]);
});

test("Inspector kill rejects ownership changes before control", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-b",
      run_instance_id: "instance-b",
      status: "running",
    }),
    killRun: () => assert.fail("unowned run must not be controlled"),
  });

  assert.deepEqual(result, {
    ok: false,
    message: "Kill rejected: run ownership changed.",
  });
});

test("Inspector kill rejects a race to terminal", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: INSTANCE_A,
      status: "done",
    }),
    killRun: () => assert.fail("terminal run must not be controlled"),
  });

  assert.deepEqual(result, {
    ok: false,
    message: "Kill unavailable: run is done.",
  });
});

test("Inspector kill rejects same-owner replacement during confirmation", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: "instance-b",
      status: "running",
    }),
    killRun: () => assert.fail("replacement generation must not be controlled"),
  });

  assert.deepEqual(result, {
    ok: false,
    message: "Kill rejected: run generation changed.",
  });
});

test("Inspector kill passes generation fencing to canonical control", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: INSTANCE_A,
      status: "running",
    }),
    killRun: (_stateDir, expected) => {
      assert.deepEqual(expected, {
        ownerId: "session-a",
        runInstanceId: INSTANCE_A,
      });
      return { killed: false, reason: "run generation changed" };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    message: "Kill failed: run generation changed.",
  });
});

test("Inspector kill bounds canonical control failures", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: INSTANCE_A,
      status: "running",
    }),
    killRun: () => ({ killed: false, reason: `owner mismatch ${"x".repeat(400)}` }),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /^Kill failed: owner mismatch/);
  assert.equal(result.message.length <= 195, true);
  assert.match(result.message, /…\.$/);
});
