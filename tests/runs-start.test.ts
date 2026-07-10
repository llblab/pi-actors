import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireStateStartLock } from "../lib/runs-start.ts";
import { readProcessIdentity } from "../lib/runs-process.ts";

async function createAgedLock(
  stateDir: string,
  owner: Record<string, unknown>,
): Promise<string> {
  const lockDir = join(stateDir, ".start.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify(owner));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lockDir, old, old);
  return lockDir;
}

test("Aged start locks remain protected while their recorded owner is alive", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-live-start-lock-"));
  const identity = readProcessIdentity(process.pid);
  assert(identity);
  const lockDir = await createAgedLock(stateDir, {
    pid: process.pid,
    process_identity: identity,
  });
  try {
    assert.throws(
      () => acquireStateStartLock(stateDir),
      /already being started/,
    );
    const owner = JSON.parse(
      await readFile(join(lockDir, "owner.json"), "utf8"),
    );
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.recovered, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Aged start locks are reclaimed only after their owner is proven dead", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-dead-start-lock-"));
  const lockDir = await createAgedLock(stateDir, {
    pid: 2_147_483_647,
    process_identity: {
      command: "dead",
      platform: process.platform,
      start_time: "dead",
    },
  });
  try {
    const release = acquireStateStartLock(stateDir);
    const owner = JSON.parse(
      await readFile(join(lockDir, "owner.json"), "utf8"),
    );
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.recovered, true);
    release();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
