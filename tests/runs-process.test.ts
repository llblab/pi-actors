/**
 * Cross-platform run process identity regression tests.
 * Covers capture and reused-pid verification without platform-specific processes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  captureRunProcessIdentity,
  type RunProcessIdentity,
  verifyRunProcessIdentity,
} from "../lib/runs-process.ts";

const runner = "/agent/pi-actors/scripts/async-runner.mjs";
const stateDir = "/agent/tmp/pi-actors/runs/review";

function identity(runtimePlatform: NodeJS.Platform, startTime = "100"): RunProcessIdentity {
  return {
    command: `node ${runner} ${stateDir}`,
    ...(runtimePlatform === "linux" ? { cwd: "/work" } : {}),
    platform: runtimePlatform,
    start_time: startTime,
  };
}

for (const runtimePlatform of ["linux", "darwin", "win32"] as const) {
  test(`Run process identity rejects reused pids on ${runtimePlatform}`, () => {
    const expected = identity(runtimePlatform);
    const valid = verifyRunProcessIdentity(
      42,
      expected,
      runtimePlatform,
      () => expected,
      () => true,
    );
    assert.deepEqual(valid, { status: "valid", valid: true });

    const reused = verifyRunProcessIdentity(
      42,
      expected,
      runtimePlatform,
      () => identity(runtimePlatform, "200"),
      () => true,
    );
    assert.deepEqual(reused, { status: "owner_mismatch", valid: false });
  });
}

test("Run process identity distinguishes dead and unsupported proofs", () => {
  assert.deepEqual(
    verifyRunProcessIdentity(42, identity("linux"), "linux", () => undefined, () => false),
    { status: "dead_pid", valid: false },
  );
  assert.deepEqual(
    verifyRunProcessIdentity(42, undefined, "darwin", () => undefined, () => true),
    { status: "unsupported_proof", valid: false },
  );
});

test("Run process identity capture validates runner command and cwd", () => {
  const expected = identity("linux");
  assert.deepEqual(
    captureRunProcessIdentity(42, "/work", stateDir, runner, "linux", () => expected),
    expected,
  );
  assert.equal(
    captureRunProcessIdentity(42, "/other", stateDir, runner, "linux", () => expected),
    undefined,
  );
  assert.equal(
    captureRunProcessIdentity(42, "/work", "/wrong", runner, "linux", () => expected),
    undefined,
  );
});
