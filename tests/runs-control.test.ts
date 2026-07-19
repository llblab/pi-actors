/**
 * Run process-control boundary regressions.
 * Covers immediate identity revalidation and fail-closed process-group fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { signalOwnedRunProcess } from "../lib/runs-control.ts";
import type { RunProcessIdentity } from "../lib/runs-process.ts";

const identity: RunProcessIdentity = {
  command: "node async-runner.mjs /runs/demo",
  cwd: "/repo",
  platform: "linux",
  start_time: "100",
};

test("Process control revalidates identity immediately before signaling", () => {
  let signals = 0;
  assert.throws(
    () => signalOwnedRunProcess(123, "SIGKILL", identity, {
      killProcess: (() => {
        signals += 1;
        return true;
      }) as typeof process.kill,
      runtimePlatform: "linux",
      verifyIdentity: () => ({ status: "owner_mismatch", valid: false }),
    }),
    /identity changed before signaling: owner mismatch/,
  );
  assert.equal(signals, 0);
});

test("Process-group ESRCH alone permits exact-process fallback", () => {
  const targets: number[] = [];
  const result = signalOwnedRunProcess(123, "SIGTERM", identity, {
    killProcess: ((pid: number) => {
      targets.push(pid);
      if (pid < 0) {
        const error = new Error("group absent") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill,
    runtimePlatform: "linux",
    verifyIdentity: () => ({ status: "valid", valid: true }),
  });

  assert.deepEqual(targets, [-123, 123]);
  assert.deepEqual(result, { signalTarget: "process" });
});

test("Exact-pid fallback revalidates identity after group ESRCH", () => {
  const targets: number[] = [];
  let proofs = 0;
  assert.throws(
    () => signalOwnedRunProcess(123, "SIGKILL", identity, {
      killProcess: ((pid: number) => {
        targets.push(pid);
        const error = new Error("group absent") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }) as typeof process.kill,
      runtimePlatform: "linux",
      verifyIdentity: () => {
        proofs += 1;
        return proofs === 1
          ? { status: "valid", valid: true }
          : { status: "owner_mismatch", valid: false };
      },
    }),
    /identity changed before pid fallback: owner mismatch/,
  );
  assert.deepEqual(targets, [-123]);
  assert.equal(proofs, 2);
});

test("Process-group authorization errors fail closed without pid fallback", () => {
  const targets: number[] = [];
  assert.throws(
    () => signalOwnedRunProcess(123, "SIGKILL", identity, {
      killProcess: ((pid: number) => {
        targets.push(pid);
        const error = new Error("not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }) as typeof process.kill,
      runtimePlatform: "linux",
      verifyIdentity: () => ({ status: "valid", valid: true }),
    }),
    /not permitted/,
  );
  assert.deepEqual(targets, [-123]);
});
