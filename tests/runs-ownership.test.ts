/**
 * Run state ownership regression tests.
 * Covers launch claims, symlink aliases, and destructive retention guards.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertOwnedRunStateDirectory,
  claimRunStateDirectory,
  RUN_STATE_OWNERSHIP_FILE,
} from "../lib/runs-ownership.ts";
import { archiveTerminalRun, pruneTerminalRun } from "../lib/runs-retention.ts";

test("Run state ownership claims only empty canonical directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-run-ownership-"));
  try {
    const owned = join(root, "owned");
    claimRunStateDirectory(owned, "owned-run");
    const marker = JSON.parse(await readFile(join(owned, RUN_STATE_OWNERSHIP_FILE), "utf8"));
    assert.equal(marker.run, "owned-run");
    assert.equal(marker.state_dir, owned);
    assert.equal(typeof marker.ownership_token, "string");
    assert.equal(assertOwnedRunStateDirectory(owned, "owned-run"), owned);
    assert.throws(
      () => assertOwnedRunStateDirectory(owned, "other-run"),
      /ownership marker does not match/,
    );

    const unrelated = join(root, "project-root");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "package.json"), "{}");
    assert.throws(
      () => claimRunStateDirectory(unrelated, "unsafe"),
      /existing non-run directory/,
    );

    const alias = join(root, "alias");
    await symlink(owned, alias, "dir");
    assert.throws(
      () => claimRunStateDirectory(alias, "owned-run"),
      /cannot be a symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Destructive retention rejects forged run metadata without ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retention-ownership-"));
  const forged = join(root, "unrelated");
  try {
    await mkdir(forged);
    await writeFile(join(forged, "important.txt"), "keep");
    const status = { run: "forged", state_dir: forged, status: "done" };
    assert.throws(() => archiveTerminalRun(status), /ownership marker is missing or invalid/);
    assert.throws(() => pruneTerminalRun(status), /ownership marker is missing or invalid/);
    assert.equal(await readFile(join(forged, "important.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
