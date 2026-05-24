/**
 * File state persistence tests
 * Covers atomic JSON temp-file collision resistance.
 */

import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../lib/file-state.ts";

test("writeJsonAtomic uses collision-resistant temp names", async () => {
  const root = join(tmpdir(), `pi-actors-file-state-${process.pid}-${Date.now()}`);
  const file = join(root, "state.json");
  const originalNow = Date.now;
  try {
    Date.now = () => 1234567890;
    for (let i = 0; i < 50; i += 1) {
      writeJsonAtomic(file, { i });
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as { i: number };
    assert.equal(parsed.i, 49);
    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});
