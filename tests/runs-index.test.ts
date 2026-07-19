/**
 * Run-state discovery regressions.
 * Covers explicit depth truncation and unbounded teardown discovery.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverRunStateDirs } from "../lib/runs-index.ts";

test("Run discovery reports depth truncation instead of silently omitting state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-run-discovery-"));
  try {
    let nested = root;
    for (let depth = 0; depth < 10; depth += 1) {
      nested = join(nested, `level-${depth}`);
      await mkdir(nested);
    }
    await writeFile(join(nested, "run.json"), "{}\n");

    const bounded = discoverRunStateDirs(root, 4);
    assert.equal(bounded.stateDirs.length, 0);
    assert.equal(
      bounded.issues.some((issue) => issue.reason === "depth_truncated"),
      true,
    );

    const unbounded = discoverRunStateDirs(root, Number.POSITIVE_INFINITY);
    assert.deepEqual(unbounded.stateDirs, [nested]);
    assert.deepEqual(unbounded.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
