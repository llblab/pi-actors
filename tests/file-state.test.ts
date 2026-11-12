/**
 * File state persistence and canonical lock regressions.
 * Covers deterministic sibling contention, alias serialization, dead-owner recovery, and atomic JSON writes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acquireFileMutationLock,
  mutationLockPath,
  withFileMutationLock,
  writeJsonAtomic,
  writeTextAtomic,
} from "../lib/file-state.ts";

const worker = fileURLToPath(new URL("./fixtures/file-lock-worker.ts", import.meta.url));

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
  mode: "crash" | "first" | "publication-race" | "second" | "unknown-owner",
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

test("Exclusive atomic writes publish complete new files without overwriting a competing creator", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-exclusive-write-"));
  const target = join(root, "retained.json");
  try {
    writeTextAtomic(target, "complete", { exclusive: true });
    assert.equal(await readFile(target, "utf8"), "complete");
    assert.throws(() => writeTextAtomic(target, "replacement", { exclusive: true }), { code: "EEXIST" });
    assert.equal(await readFile(target, "utf8"), "complete");
    fs.unlinkSync(target);
    assert.throws(() => writeTextAtomic(target, "loser", { exclusive: true,
      onBeforeReplace: () => fs.writeFileSync(target, "competitor", { flag: "wx" }),
    }), { code: "EEXIST" });
    assert.equal(await readFile(target, "utf8"), "competitor");
    assert.deepEqual(await readdir(root), ["retained.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Exclusive publication preserves original failures and never rolls back a published target", async t => {
  for (const stage of ["unsupported", "after_publication"] as const) {
    const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-exclusive-failure-"));
    const target = join(root, "retained.json"), original = fs.linkSync;
    const cause = Object.freeze({ stage });
    let calls = 0;
    try {
      t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
        calls++;
        if (stage === "after_publication") Reflect.apply(original, fs, args);
        throw cause;
      });
      syncBuiltinESMExports();
      let failure: unknown;
      try { writeTextAtomic(target, "complete", { exclusive: true }); } catch (error) { failure = error; }
      assert.equal(failure, cause);
      assert.equal(calls, 1);
      if (stage === "after_publication") assert.equal(await readFile(target, "utf8"), "complete");
      else assert.equal(existsSync(target), false);
      assert.deepEqual(await readdir(root), stage === "after_publication" ? ["retained.json"] : []);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Locked file mutation preserves callback and release failures without replay or rollback", (t) => {
  // Data-only real file-lock interleavings; no worker/native workload or host-exit proof is introduced.
  for (const kind of ["return", "error", "aggregate", "undefined", "primitive", "hostile"] as const)
    for (const releaseKind of ["none", "error", "undefined"] as const) {
      const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-file-callback-")); const target = join(root, "state.json"); const lock = mutationLockPath(target);
      const nested = new Error("original private cause"); let coerced = 0, thenRead = 0, calls = 0, releases = 0;
      const primary: unknown = kind === "undefined" ? undefined : kind === "primitive" ? 0
        : kind === "hostile" ? { [Symbol.toPrimitive]() { coerced++; throw new Error("must not coerce"); } }
        : kind === "aggregate" ? new AggregateError([nested, undefined], "original aggregate", { cause: nested })
        : Object.assign(new Error("callback rejection", { cause: nested }), { details: { partial: true } });
      const releaseFailure = releaseKind === "undefined" ? undefined : new Error("controlled file-lock release fault");
      const returned = Object.freeze({ get then() { thenRead++; throw new Error("Synchronous wrapper must not inspect returned thenable"); } });
      const mkdir = fs.mkdirSync;
      const hook = t.mock.method(fs, "mkdirSync", ((...args: Parameters<typeof fs.mkdirSync>) => {
        if (String(args[0]).startsWith(lock + ".reclaim.") && String(args[0]).endsWith(".pending")) {
          releases++; if (releaseKind !== "none") throw releaseFailure;
        }
        return Reflect.apply(mkdir, fs, args);
      }) as typeof fs.mkdirSync);
      syncBuiltinESMExports(); let rejected = false; let caught: unknown; let result: unknown;
      try {
        result = withFileMutationLock(target, () => {
          calls++;
          const owner = JSON.parse(fs.readFileSync(join(lock, "owner.json"), "utf8"));
          writeJsonAtomic(join(root, "fixture-frame.json"), { kind: "controlled_file_lock_only", target, lock, owner, host_exit: "not_asserted" });
          assert.equal(owner.pid, process.pid); assert.ok(typeof owner.token === "string" && owner.token.length > 0);
          assert.equal(releases, 0);
          const contention = new Error("callback is still under the same lock");
          assert.throws(() => acquireFileMutationLock(target, { onContention() { throw contention; } }), error => error === contention);
          writeJsonAtomic(target, { kind, calls });
          if (kind !== "return") throw primary;
          return returned;
        });
      } catch (error) { rejected = true; caught = error; }
      finally { hook.mock.restore(); syncBuiltinESMExports(); }
      if (releaseKind !== "none") t.diagnostic(`Controlled file-lock fault retained: ${root}; host_exit=not_asserted; no native scope claim`);
      try {
        assert.equal(calls, 1); assert.equal(releases, 1); assert.equal(coerced, 0); assert.equal(thenRead, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { kind, calls: 1 }, "Already written bytes are never rolled back or rewritten for diagnostics");
        if (kind === "return" && releaseKind === "none") { assert.equal(rejected, false); assert.equal(result, returned); }
        else {
          assert.equal(rejected, true);
          if (kind === "return") assert.equal(caught, releaseFailure, "A release-only failure, including undefined, stays exact");
          else if (releaseKind === "none") assert.equal(caught, primary, "A single callback rejection stays exact");
          else {
            assert.ok(caught instanceof AggregateError); assert.deepEqual(caught.errors, [primary, releaseFailure]); assert.equal(caught.cause, primary);
            assert.equal(Object.hasOwn(caught, "cause"), true); assert.equal(Object.getOwnPropertyDescriptor(caught, "cause")?.enumerable, false);
            assert.equal(Object.getOwnPropertyDescriptor(caught, "errors")?.enumerable, false); assert.deepEqual(Object.keys(caught), []);
            if (primary instanceof AggregateError) { assert.deepEqual(primary.errors, [nested, undefined]); assert.equal(primary.cause, nested); }
          }
        }
        assert.equal(fs.existsSync(lock), releaseKind !== "none", "Faulted release is not cleanup proof");
      } finally {
        if (releaseKind === "none") fs.rmSync(root, { recursive: true, force: true });
        // Faulted owner/lock/frame is retained; neither a settled callback nor this host can certify native/host exit.
      }
    }
});

test("Atomic replacement preserves exact failures, inspection causes, partial bytes and bounded retries", (t) => {
  // Real writes/replacements plus controlled syscall errors, not new native workloads or transaction proof.
  for (const writer of ["text", "json"] as const) for (const phase of ["before", "after"] as const)
    for (const kind of ["undefined", "null", "zero", "string", "error", "aggregate", "hostile_text", "code_throws", "code_throws_undefined", "object_code"] as const) {
      const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-atomic-cause-")), target = join(root, "state β.json");
      const previous = "original😀\r\n", payload = { text: "new😀\r\n" }, next = writer === "text" ? payload.text : JSON.stringify(payload, null, 2) + "\n";
      fs.writeFileSync(target, previous);
      let renames = 0, callbacks = 0, codeReads = 0, coerced = 0, rejected = false; let caught: unknown;
      const child = new Error("original private cause"), observationFailure = kind === "code_throws_undefined" ? undefined : new Error("retry classification accessor fault");
      const hostileText = { [Symbol.toPrimitive]() { coerced++; throw new Error("must not coerce"); } };
      const primary: unknown = kind === "undefined" ? undefined : kind === "null" ? null : kind === "zero" ? 0 : kind === "string" ? "EPERM"
        : kind === "aggregate" ? new AggregateError([child, undefined], "original aggregate", { cause: child })
        : kind === "hostile_text" ? hostileText
        : kind.startsWith("code_throws") || kind === "object_code" ? { get code() { codeReads++; if (kind === "object_code") return hostileText; throw observationFailure; } }
        : Object.assign(new Error("rename rejection", { cause: child }), { details: { partial: true } });
      const rename = fs.renameSync;
      const hook = t.mock.method(fs, "renameSync", ((...args: Parameters<typeof fs.renameSync>) => {
        if (args[1] !== target) return Reflect.apply(rename, fs, args);
        renames++;
        fs.writeFileSync(join(root, "fixture-frame.json"), JSON.stringify({ kind, writer, phase, target, temp: args[0], owner_pid: process.pid, host_exit: "not_asserted" }));
        if (phase === "after") Reflect.apply(rename, fs, args);
        throw primary;
      }) as typeof fs.renameSync);
      syncBuiltinESMExports();
      try {
        if (writer === "text") writeTextAtomic(target, next, { onBeforeReplace() { callbacks++; } });
        else writeJsonAtomic(target, payload);
      } catch (error) { rejected = true; caught = error; }
      finally { hook.mock.restore(); syncBuiltinESMExports(); }
      t.diagnostic(`Controlled atomic replacement fault retained: ${root}; host_exit=not_asserted; no native scope claim`);
      assert.equal(rejected, true); assert.equal(renames, 1); assert.equal(callbacks, writer === "text" ? 1 : 0); assert.equal(coerced, 0);
      assert.equal(fs.readFileSync(target, "utf8"), phase === "after" ? next : previous, "Committed bytes remain and a pre-rename failure does not invent a replacement");
      if (kind === "code_throws" || kind === "code_throws_undefined") {
        assert.equal(codeReads, 1); assert.ok(caught instanceof AggregateError); assert.equal(caught.errors.length, 2);
        assert.equal(caught.errors[0], primary); assert.equal(caught.errors[1], observationFailure); assert.equal(caught.cause, primary);
        assert.equal(Object.getOwnPropertyDescriptor(caught, "cause")?.enumerable, false); assert.equal(Object.getOwnPropertyDescriptor(caught, "errors")?.enumerable, false);
        assert.deepEqual(Object.keys(caught), []);
      } else {
        assert.equal(caught, primary); assert.equal(codeReads, kind === "object_code" ? 1 : 0);
        if (primary instanceof AggregateError) { assert.deepEqual(primary.errors, [child, undefined]); assert.equal(primary.cause, child); }
      }
    }
  for (const code of ["EPERM", "EBUSY"] as const) for (const exhausted of [false, true]) {
    const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-atomic-retry-")), target = join(root, "state.json");
    fs.writeFileSync(target, "before"); let renames = 0, callbacks = 0, rejected = false; let caught: unknown;
    const delays: unknown[] = [], faults = Array.from({ length: 20 }, (_, i) => Object.assign(new Error(`controlled ${code} ${i}`), { code }));
    const rename = fs.renameSync, wait = Atomics.wait;
    const hook = t.mock.method(fs, "renameSync", ((...args: Parameters<typeof fs.renameSync>) => {
      if (args[1] !== target) return Reflect.apply(rename, fs, args);
      renames++; if (exhausted || renames < 3) throw faults[renames - 1];
      return Reflect.apply(rename, fs, args);
    }) as typeof fs.renameSync);
    const waitHook = t.mock.method(Atomics, "wait", ((...args: Parameters<typeof Atomics.wait>) => { delays.push(args[3]); return Reflect.apply(wait, Atomics, args); }) as typeof Atomics.wait);
    syncBuiltinESMExports();
    try { writeTextAtomic(target, "after😀", { onBeforeReplace() { callbacks++; } }); }
    catch (error) { rejected = true; caught = error; }
    finally { hook.mock.restore(); waitHook.mock.restore(); syncBuiltinESMExports(); }
    fs.writeFileSync(join(root, "fixture-frame.json"), JSON.stringify({ code, exhausted, renames, callbacks, delays, owner_pid: process.pid, host_exit: "not_asserted" }));
    t.diagnostic(`Controlled atomic retry fixture retained: ${root}; no native/host exit asserted`);
    assert.equal(callbacks, 1); assert.equal(renames, exhausted ? 20 : 3); assert.equal(rejected, exhausted);
    assert.deepEqual(delays, Array.from({ length: exhausted ? 19 : 2 }, () => 50), "Keep the original actual Atomics.wait count and interval");
    assert.equal(fs.readFileSync(target, "utf8"), exhausted ? "before" : "after😀");
    if (exhausted) assert.equal(caught, faults[19], "Ordinary exhausted retry retains its exact last native-shaped rejection");
  }
});

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

test("File mutation lock owner publication is atomic under contention", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-publish-${process.pid}-${Date.now()}`);
  const target = join(root, "recipe.json");
  const log = join(root, "order.log");
  const publisherRelease = join(root, "publisher-release");
  const contenderRelease = join(root, "contender-release");
  const publishReady = join(root, "publish-ready");
  const publishProceed = join(root, "publish-proceed");
  const publisherPaths = workerPaths(root, "publisher", publisherRelease);
  const contenderPaths = workerPaths(root, "contender", contenderRelease);
  try {
    await mkdir(root, { recursive: true });
    const publisher = startLockWorker(
      target,
      publisherPaths,
      log,
      "publication-race",
      { ready: publishReady, proceed: publishProceed },
    );
    await waitForFile(publishReady);
    const contender = startLockWorker(target, contenderPaths, log, "first");
    await waitForFile(contenderPaths.acquired);
    await writeFile(publishProceed, "proceed\n");
    await waitForFile(publisherPaths.blocked);
    assert.equal(existsSync(publisherPaths.acquired), false);
    await writeFile(contenderRelease, "release\n");
    await waitForFile(publisherPaths.acquired);
    await writeFile(publisherRelease, "release\n");
    await Promise.all([publisher, contender]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "first:acquired",
      "first:released",
      "publication-race:acquired",
      "publication-race:released",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("File mutation lock identity survives target materialization", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-materialize-${process.pid}-${Date.now()}`);
  try {
    await mkdir(root, { recursive: true });
    const target = join(root, "controls.jsonl");
    const before = mutationLockPath(target);
    await writeFile(target, "\n");
    assert.equal(mutationLockPath(target), before);
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

test(
  "Windows junction aliases share one canonical mutation lock",
  { skip: process.platform !== "win32" },
  async () => {
    const root = join(
      tmpdir(),
      `pi-actors-file-lock-junction-${process.pid}-${Date.now()}`,
    );
    const realParent = join(root, "real");
    const junctionParent = join(root, "junction");
    try {
      await mkdir(realParent, { recursive: true });
      await symlink(realParent, junctionParent, "junction");
      const realTarget = join(realParent, "recipe.json");
      const junctionTarget = join(junctionParent, "recipe.json");
      assert.equal(
        mutationLockPath(realTarget),
        mutationLockPath(junctionTarget),
      );
      await assertDeterministicContention(
        root,
        realTarget,
        junctionTarget,
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

test("File mutation locks reclaim a stale legacy ownerless boundary", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-ownerless-${process.pid}-${Date.now()}`);
  const target = join(root, "recipe.json");
  const lockPath = mutationLockPath(target);
  try {
    await mkdir(root, { recursive: true });
    await mkdir(lockPath, { recursive: true });
    const abandoned = new Date(Date.now() - 60_000);
    await utimes(lockPath, abandoned, abandoned);
    const unlock = acquireFileMutationLock(target);
    unlock();
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
});

test(
  "File mutation locks reclaim a killed child before its exit event is reaped",
  { skip: process.platform === "win32" },
  async () => {
    const root = join(tmpdir(), `pi-actors-file-lock-zombie-${process.pid}-${Date.now()}`);
    const target = join(root, "recipe.json");
    const releasePath = join(root, "release");
    const paths = workerPaths(root, "holder", releasePath);
    const log = join(root, "order.log");
    await mkdir(root, { recursive: true });
    const child = spawn(process.execPath, [
      "--experimental-strip-types", worker, target, paths.started, paths.acquired,
      paths.blocked, paths.release, log, "first",
    ], { stdio: "ignore" });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    try {
      await waitForFile(paths.acquired);
      child.kill("SIGKILL");
      const unlock = acquireFileMutationLock(target);
      unlock();
      await closed;
      assert.equal(existsSync(mutationLockPath(target)), false);
    } finally {
      child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
