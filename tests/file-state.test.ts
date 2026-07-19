/**
 * File state persistence and canonical lock regressions.
 * Covers deterministic sibling contention, alias serialization, dead-owner recovery, and atomic JSON writes.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireFileMutationLock,
  mutationLockPath,
  writeJsonAtomic,
} from "../lib/file-state.ts";

const worker = new URL("./fixtures/file-lock-worker.ts", import.meta.url).pathname;

interface WorkerPaths {
  acquired: string;
  blocked: string;
  release: string;
  started: string;
}

function startLockWorker(
  target: string,
  paths: WorkerPaths,
  log: string,
  mode: "crash" | "first" | "second" | "unknown-owner",
  reclaimBarrier?: { proceed: string; ready: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        worker,
        target,
        paths.started,
        paths.acquired,
        paths.blocked,
        paths.release,
        log,
        mode,
        ...(reclaimBarrier
          ? [reclaimBarrier.ready, reclaimBarrier.proceed]
          : []),
      ],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (mode === "crash" && code === 73) resolve();
      else if (code === 0) resolve();
      else reject(new Error(`lock child exited ${code}`));
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

function workerPaths(root: string, name: string, release: string): WorkerPaths {
  return {
    acquired: join(root, `${name}-acquired`),
    blocked: join(root, `${name}-blocked`),
    release,
    started: join(root, `${name}-started`),
  };
}

async function assertDeterministicContention(
  root: string,
  firstTarget: string,
  secondTarget: string,
): Promise<void> {
  const log = join(root, "order.log");
  const release = join(root, "release");
  const firstPaths = workerPaths(root, "first", release);
  const secondPaths = workerPaths(root, "second", release);
  const first = startLockWorker(firstTarget, firstPaths, log, "first");
  await waitForFile(firstPaths.acquired);
  const second = startLockWorker(secondTarget, secondPaths, log, "second");
  await waitForFile(secondPaths.blocked);
  assert.equal(existsSync(secondPaths.acquired), false);
  await writeFile(release, "release\n");
  await Promise.all([first, second]);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "first:acquired",
    "first:released",
    "second:acquired",
    "second:released",
  ]);
}

test("File mutation locks deterministically serialize sibling processes", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-${process.pid}-${Date.now()}`);
  try {
    await mkdir(root, { recursive: true });
    const target = join(root, "recipe.json");
    await assertDeterministicContention(root, target, target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "File mutation locks deterministically serialize canonical path aliases",
  { skip: process.platform === "win32" },
  async () => {
    const root = join(
      tmpdir(),
      `pi-actors-file-lock-alias-${process.pid}-${Date.now()}`,
    );
    const realParent = join(root, "real");
    const aliasParent = join(root, "alias");
    try {
      await mkdir(realParent, { recursive: true });
      await symlink(realParent, aliasParent, "dir");
      await assertDeterministicContention(
        root,
        join(realParent, "recipe.json"),
        join(aliasParent, "recipe.json"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("File mutation locks immediately reclaim a proven-dead owner", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-crash-${process.pid}-${Date.now()}`);
  const target = join(root, "recipe.json");
  const log = join(root, "order.log");
  const release = join(root, "release");
  const crashedPaths = workerPaths(root, "crashed", release);
  const recoveryPaths = workerPaths(root, "recovery", release);
  try {
    await mkdir(root, { recursive: true });
    const crashed = startLockWorker(target, crashedPaths, log, "crash");
    await waitForFile(crashedPaths.acquired);
    await crashed;
    await writeFile(release, "release\n");

    await startLockWorker(target, recoveryPaths, log, "second");

    assert.equal(existsSync(recoveryPaths.acquired), true);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "crash:acquired",
      "second:acquired",
      "second:released",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Concurrent dead-owner reclaimers cannot remove the replacement lock", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-reclaim-${process.pid}-${Date.now()}`);
  const target = join(root, "recipe.json");
  const log = join(root, "order.log");
  const crashRelease = join(root, "crash-release");
  const sharedRelease = join(root, "release");
  const crashedPaths = workerPaths(root, "crashed", crashRelease);
  const firstPaths = workerPaths(root, "first", sharedRelease);
  const secondPaths = workerPaths(root, "second", sharedRelease);
  try {
    await mkdir(root, { recursive: true });
    const crashed = startLockWorker(target, crashedPaths, log, "crash");
    await waitForFile(crashedPaths.acquired);
    await crashed;

    const first = startLockWorker(target, firstPaths, log, "first");
    const second = startLockWorker(target, secondPaths, log, "second");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (existsSync(firstPaths.acquired) || existsSync(secondPaths.acquired)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      existsSync(firstPaths.acquired) || existsSync(secondPaths.acquired),
      true,
    );
    const winner = existsSync(firstPaths.acquired) ? firstPaths : secondPaths;
    const loser = winner === firstPaths ? secondPaths : firstPaths;
    await waitForFile(loser.blocked);
    assert.equal(existsSync(loser.acquired), false);
    await writeFile(sharedRelease, "release\n");
    await Promise.all([first, second]);

    const events = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(events[0], "crash:acquired");
    assert.deepEqual(events.slice(1), [
      `${winner === firstPaths ? "first" : "second"}:acquired`,
      `${winner === firstPaths ? "first" : "second"}:released`,
      `${loser === firstPaths ? "first" : "second"}:acquired`,
      `${loser === firstPaths ? "first" : "second"}:released`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stale reclaim cannot race old-owner release into deleting its replacement", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-release-race-${process.pid}-${Date.now()}`);
  const target = join(root, "recipe.json");
  const log = join(root, "order.log");
  const holderRelease = join(root, "holder-release");
  const replacementRelease = join(root, "replacement-release");
  const finalRelease = join(root, "final-release");
  const reclaimReady = join(root, "reclaim-ready");
  const reclaimProceed = join(root, "reclaim-proceed");
  const holderPaths = workerPaths(root, "holder", holderRelease);
  const replacementPaths = workerPaths(root, "replacement", replacementRelease);
  const finalPaths = workerPaths(root, "final", finalRelease);
  try {
    await mkdir(root, { recursive: true });
    const holder = startLockWorker(target, holderPaths, log, "unknown-owner");
    await waitForFile(holderPaths.acquired);
    const replacement = startLockWorker(
      target,
      replacementPaths,
      log,
      "first",
      { ready: reclaimReady, proceed: reclaimProceed },
    );
    await waitForFile(reclaimReady);

    await writeFile(holderRelease, "release\n");
    await waitForFile(holderPaths.blocked);
    await writeFile(reclaimProceed, "proceed\n");
    await waitForFile(replacementPaths.acquired);

    const final = startLockWorker(target, finalPaths, log, "second");
    await waitForFile(finalPaths.blocked);
    assert.equal(existsSync(finalPaths.acquired), false);
    await writeFile(replacementRelease, "release\n");
    await waitForFile(finalPaths.acquired);
    await writeFile(finalRelease, "release\n");
    await Promise.all([holder, replacement, final]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("File mutation locks recover an abandoned removal boundary", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-removal-crash-${process.pid}-${Date.now()}`);
  const target = join(root, "recipe.json");
  const lockPath = mutationLockPath(target);
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    await mkdir(reclaimPath, { recursive: true });
    await writeFile(join(reclaimPath, "owner.json"), "{}\n");
    const stale = new Date(Date.now() - 60_000);
    await utimes(reclaimPath, stale, stale);

    const release = acquireFileMutationLock(target);
    release();

    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(reclaimPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
    await rm(reclaimPath, { recursive: true, force: true });
  }
});

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
