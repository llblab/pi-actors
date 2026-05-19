/**
 * Extension temp-directory tests
 * Covers stale cleanup without system tmp coupling
 */

import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupStaleTempEntries,
  prepareExtensionTempDir,
} from "../lib/temp.ts";

test("Extension temp cleanup removes stale files and directories", async () => {
  const root = join(
    tmpdir(),
    `pi-actors-temp-${process.pid}-${Date.now()}`,
  );
  const staleFile = join(root, "old.txt");
  const staleDir = join(root, "old-dir");
  const freshFile = join(root, "fresh.txt");
  try {
    await mkdir(staleDir, { recursive: true });
    await writeFile(staleFile, "old");
    await writeFile(join(staleDir, "nested.txt"), "old");
    await writeFile(freshFile, "fresh");
    const now = Date.now();
    const old = new Date(now - 2000);
    await utimes(staleFile, old, old);
    await utimes(staleDir, old, old);
    const removed = await cleanupStaleTempEntries(root, 1000, now);
    assert.equal(removed, 2);
    await assert.rejects(stat(staleFile));
    await assert.rejects(stat(staleDir));
    assert.equal((await stat(freshFile)).isFile(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Extension temp preparation creates directory", async () => {
  const root = join(
    tmpdir(),
    `pi-actors-temp-prepare-${process.pid}-${Date.now()}`,
  );
  try {
    await prepareExtensionTempDir(root);
    assert.equal((await stat(root)).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
