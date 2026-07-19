/**
 * Async run status derivation regressions.
 * Covers explicit live-but-unverifiable survivor classification.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildRunStatus } from "../lib/runs-status.ts";

test("Live runner with unavailable identity proof remains an explicit running survivor", () => {
  const status = buildRunStatus(
    "/runs/ambiguous",
    "ambiguous",
    {
      createdAt: new Date(0).toISOString(),
      pid: process.pid,
      run: "ambiguous",
      state_dir: "/runs/ambiguous",
    },
    () => undefined,
    "/runner.mjs",
    0,
  );

  assert.equal(status.status, "running");
  assert.equal(status.process_identity_status, "unsupported_proof");
});
