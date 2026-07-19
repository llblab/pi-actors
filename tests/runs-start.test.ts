/**
 * Async run lifecycle-lock regressions.
 * Covers token-owned release and sequential restart/control acquisition.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireStateStartLock } from "../lib/runs-start.ts";

test("Lifecycle lock release is idempotent and permits the next generation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-lifecycle-lock-"));
  try {
    const releaseFirst = acquireStateStartLock(stateDir);
    releaseFirst();
    releaseFirst();

    const releaseSecond = acquireStateStartLock(stateDir);
    assert.equal(typeof releaseSecond, "function");
    releaseSecond();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
