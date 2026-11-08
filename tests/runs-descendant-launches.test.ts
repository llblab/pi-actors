/** Mirrors lib/runs-descendant-launches.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  mkdir,
} from "node:fs/promises";
import {
  syncBuiltinESMExports,
} from "node:module";
import {
  tmpdir,
} from "node:os";
import {
  join,
  sep,
} from "node:path";
import test from "node:test";
import {
  after,
  type TestContext,
  describe,
} from "node:test";
import {
  type RunDescendantLaunchRequest,
  type RunDescendantPreparation,
} from "../lib/runs-descendant-launches.ts";
import childProcess from "node:child_process";
import {
  spawn,
  type ChildProcess,
  execFile,
} from "node:child_process";
import {
  setTimeout as delay,
} from "node:timers/promises";
import {
  type RunProcessIdentity,
} from "../lib/runs-process.ts";
import {
  randomUUID,
} from "node:crypto";
import {
  promisify,
} from "node:util";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Intent admission", { concurrency: false }, async () => {


const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-descendant-intent-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});

const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { assertNoRetainedDescendantLaunchScope, readRunDescendantLaunchLedger, RUN_DESCENDANT_LAUNCH_FILE } = await import("../lib/runs-descendant-launches.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { admitRunResultProducer, publishRunResult, readRunProducerCleanupFailure, withRunDescendantIntentAdmission } = await import("../lib/runs-results.ts");

type Producer = ReturnType<typeof admitRunResultProducer>["producer"];

async function fixture(t: TestContext, legacy = false) {
  const root = await mkdtemp(join(agentDir, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "parent");
  // Unit kernel in this test process, not an independently running async-runner.
  const meta = { run: "parent", run_instance_id: "parent-generation", state_dir: stateDir, pid: process.pid,
    ...(legacy ? {} : { ownerId: "parent-owner", process_identity: readProcessIdentity(process.pid) }),
    outcome_protocol: RUN_OUTCOME_PROTOCOL };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const request = { run: "child", runInstanceId: "child-generation", ownerId: "different-child-owner", stateDir: join(root, "child") };
  return { root, stateDir, meta, producer, request, path: join(stateDir, RUN_DESCENDANT_LAUNCH_FILE) };
}

function ledger(stateDir: string, producer: Producer) {
  const reading = readRunDescendantLaunchLedger(stateDir, producer);
  assert.equal(reading.state, "available");
  if (reading.state !== "available") throw Error("Expected descendant-intent evidence");
  return reading.ledger;
}

test("Declared child generation is retained before synchronous preparation under the parent's work lock", async (t) => {
  const { stateDir, producer, request, path } = await fixture(t);
  const before = await readFile(join(stateDir, "run.json"), "utf8");
  assert.deepEqual(readRunDescendantLaunchLedger(stateDir, producer), { state: "absent" });
  const returned = Object.freeze({ preparation: "not a child membership receipt" });
  const value = withRunDescendantIntentAdmission(stateDir, producer, request, (intent) => {
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
    assert.equal(existsSync(path), true);
    const stored = ledger(stateDir, producer);
    assert.deepEqual(stored.intents, [intent]);
    assert.equal(stored.run_instance_id, producer.runInstanceId);
    assert.equal(stored.ownerId, producer.ownerId);
    assert.equal(stored.runner_pid, process.pid);
    assert.equal(stored.runner_identity_digest, producer.processIdentityDigest ?? null);
    assert.deepEqual(intent.child, { run: request.run, run_instance_id: request.runInstanceId,
      ownerId: request.ownerId, state_dir: request.stateDir });
    for (const object of [intent, intent.child, stored, stored.intents, stored.intents[0]!.child]) assert.equal(Object.isFrozen(object), true);
    for (const key of ["birth", "membership", "complete", "settlement", "pid"]) assert.equal(Object.hasOwn(intent, key), false);
    assert.equal(existsSync(request.stateDir), false);
    return returned;
  });
  assert.equal(value, returned);
  assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), before);
  assert.equal(existsSync(join(stateDir, "result.json")), false);
  assert.throws(() => assertNoRetainedDescendantLaunchScope(stateDir), /scope is unproven/);
});

test("A throwing preparation retains uncertainty and cannot replay the same declared child generation", async (t) => {
  const { stateDir, producer, request, path } = await fixture(t);
  const original = Object.freeze(new Error("interrupted child preparation"));
  assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, request, () => {
    fs.mkdirSync(request.stateDir);
    fs.writeFileSync(join(request.stateDir, "partial-preparation"), "not membership");
    throw original;
  }), (error) => error === original);
  const bytes = await readFile(path, "utf8");
  assert.equal(ledger(stateDir, producer).intents.length, 1);
  assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, run: "alias", ownerId: "another-owner" },
    () => assert.fail("Duplicate generation preparation ran")), /generation is already retained/);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal(await readFile(join(request.stateDir, "partial-preparation"), "utf8"), "not membership");
  withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "later-declared-generation" }, () => undefined);
  assert.equal(ledger(stateDir, producer).intents.length, 2);
});

test("Stop claims and accepted results deny new intent/preparation without changing retained evidence", async (t) => {
  for (const stop of [false, true]) for (const existing of [false, true]) {
    const { stateDir, producer, request, path } = await fixture(t);
    if (existing) withRunDescendantIntentAdmission(stateDir, producer, request, () => undefined);
    if (stop) assert.equal(claimRunStop(stateDir, { runInstanceId: producer.runInstanceId, ownerId: producer.ownerId, reason: "manual_kill" }, {
      verifyIdentity: () => ({ status: "valid", valid: true }),
    }).status, "stop_requested");
    else publishRunResult(stateDir, producer, { code: 0 });
    const bytes = existing ? await readFile(path, "utf8") : undefined;
    const outcome = await readFile(join(stateDir, stop ? "stop-claim.json" : "result.json"), "utf8");
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "another-child" },
      () => assert.fail("Closed parent prepared a child")), /stopping or unproven|terminal or unproven/);
    assert.equal(existing ? await readFile(path, "utf8") : existsSync(path), bytes ?? false);
    assert.equal(await readFile(join(stateDir, stop ? "stop-claim.json" : "result.json"), "utf8"), outcome);
  }
});

test("Copies and stale parent owner/generation/process/protocol metadata cannot reserve descendant work", async (t) => {
  const { stateDir, producer, request, path, meta } = await fixture(t);
  for (const copy of [{ ...producer }, JSON.parse(JSON.stringify(producer))]) {
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, copy, request, () => assert.fail("Copy admitted preparation")), /admitted by this runtime/);
  }
  assert.equal(existsSync(path), false);
  withRunDescendantIntentAdmission(stateDir, producer, request, () => undefined);
  const bytes = await readFile(path, "utf8");
  for (const [delta, expected] of [
    [{ run_instance_id: "replacement-parent" }, /generation changed/],
    [{ ownerId: "replacement-owner" }, /owner changed/],
    [{ pid: process.pid + 1 }, /process changed/],
    [{ process_identity: { platform: "linux", start_time: "replacement", command: "replacement" } }, /process identity changed/],
    [{ outcome_protocol: "unsupported" }, /protocol changed/],
    [{ state_dir: join(stateDir, "replacement") }, /state identity changed/],
  ] as const) {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, ...delta });
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "another-child" },
      () => assert.fail("Stale parent prepared a child")), expected);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

test("Intent persistence failure remains outside preparation and preserves an earlier journal byte-for-byte", async (t) => {
  const { stateDir, producer, request, path } = await fixture(t);
  const rename = fs.renameSync;
  let inject = true;
  const failure = Object.assign(new Error("injected descendant intent EIO"), { code: "EIO" });
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (inject && String(to) === path) throw failure;
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, request,
      () => assert.fail("Unretained preparation ran")), (error) => error === failure);
    assert.equal(existsSync(path), false);
    inject = false;
    withRunDescendantIntentAdmission(stateDir, producer, request, () => undefined);
    const bytes = await readFile(path, "utf8");
    inject = true;
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "another-child" },
      () => assert.fail("Unretained append preparation ran")), (error) => error === failure);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
});

test("Malformed or foreign header, intent, and child declarations refuse rather than reset or launder evidence", async (t) => {
  const { stateDir, producer, request, path } = await fixture(t);
  withRunDescendantIntentAdmission(stateDir, producer, request, () => undefined);
  const bytes = await readFile(path, "utf8");
  const changes = [
    (v: any) => { v.schema = "unsupported"; },
    (v: any) => { v.run = "foreign"; },
    (v: any) => { v.run_instance_id = "foreign"; },
    (v: any) => { v.ownerId = "foreign"; },
    (v: any) => { v.runner_pid = String(v.runner_pid); },
    (v: any) => { v.runner_identity_digest = "forged"; },
    (v: any) => { v.complete = true; },
    (v: any) => { v.intents[0].intent_id = "00000000-0000-4000-7000-000000000001"; },
    (v: any) => { v.intents[0].intent_id += "\n"; },
    (v: any) => { v.intents[0].admitted_at = "yesterday"; },
    (v: any) => { v.intents[0].membership = true; },
    (v: any) => { v.intents.push({ ...v.intents[0] }); },
    (v: any) => { v.intents.push({ ...v.intents[0], intent_id: "00000000-0000-4000-8000-000000000001" }); },
    (v: any) => { v.intents[0].child.ownerId = 1; },
    (v: any) => { v.intents[0].child.state_dir = "relative"; },
    (v: any) => { v.intents[0].child.state_dir = stateDir; },
    (v: any) => { v.intents[0].child.run_instance_id = producer.runInstanceId; },
    (v: any) => { v.intents[0].child.birth = { pid: 1 }; },
  ];
  for (const change of changes) {
    const modified = JSON.parse(bytes);
    change(modified);
    writeJsonAtomic(path, modified);
    const retained = await readFile(path, "utf8");
    assert.equal(readRunDescendantLaunchLedger(stateDir, producer).state, "invalid");
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "another-child" },
      () => assert.fail("Invalid journal admitted preparation")), /evidence is unavailable or invalid/);
    assert.equal(await readFile(path, "utf8"), retained);
  }
  await writeFile(path, "{unresolved");
  assert.equal(readRunDescendantLaunchLedger(stateDir, producer).state, "invalid");
  assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "another-child" },
    () => assert.fail("Malformed journal admitted preparation")), /evidence is unavailable or invalid/);
  assert.equal(await readFile(path, "utf8"), "{unresolved");
});

test("Requests require exact own generation fields and normalized declared locations, never actor-supplied authority", async (t) => {
  const { stateDir, producer, request, path, root } = await fixture(t);
  for (const invalid of [
    { ...request, run: "" }, { ...request, run: "child\n" }, { ...request, runInstanceId: "" },
    { ...request, runInstanceId: producer.runInstanceId }, { ...request, ownerId: null },
    { ...request, stateDir: "relative" }, { ...request, stateDir }, { ...request, stateDir: request.stateDir + sep },
    { ...request, stateDir: `${root}${sep}child${sep}..${sep}child` },
    { ...request, nativeScopePath: "/actor-supplied" }, Object.create(request),
  ]) {
    assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, invalid as RunDescendantLaunchRequest,
      () => assert.fail("Invalid declaration prepared a child")), /identity or request is invalid/);
    assert.equal(existsSync(path), false);
  }
});

test("Legacy-unbound parent evidence and omitted child owner stay declarations; even a valid empty ledger stays fenced", async (t) => {
  const { stateDir, producer, request, path } = await fixture(t, true);
  withRunDescendantIntentAdmission(stateDir, producer, { ...request, ownerId: undefined }, () => undefined);
  const stored = ledger(stateDir, producer);
  assert.equal(stored.runner_identity_digest, null);
  assert.equal(Object.hasOwn(stored, "ownerId"), false);
  assert.equal(Object.hasOwn(stored.intents[0]!.child, "ownerId"), false);
  writeJsonAtomic(path, { ...stored, intents: [] });
  assert.equal(ledger(stateDir, producer).intents.length, 0);
  assert.throws(() => assertNoRetainedDescendantLaunchScope(stateDir), /scope is unproven/);
});

test("Release failure preserves exact preparation outcome and quarantines the producer, not its retained plan", async (t) => {
  for (const throwing of [false, true]) {
    const { stateDir, producer, request, path } = await fixture(t);
    const lock = mutationLockPath(join(stateDir, ".lifecycle"));
    const mkdir = fs.mkdirSync;
    const value = Object.freeze({ prepared: true });
    const primary = Object.freeze(new Error("original preparation failure"));
    let inject = false;
    let token: string | undefined;
    let returned: unknown;
    let thrown: unknown;
    fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (inject && String(path).startsWith(`${lock}.reclaim.`)) throw Object.assign(new Error("release EIO"), { code: "EIO" });
      return Reflect.apply(mkdir, fs, [path, ...args]);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    try {
      try {
        returned = withRunDescendantIntentAdmission(stateDir, producer, request, () => {
          token = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token;
          inject = true;
          if (throwing) throw primary;
          return value;
        });
      } catch (error) { thrown = error; }
      fs.mkdirSync = mkdir; syncBuiltinESMExports();
      assert.equal(throwing ? thrown : returned, throwing ? primary : value);
      if (!throwing) assert.equal(thrown, undefined);
      assert.equal(existsSync(lock), true);
      assert.deepEqual(readRunProducerCleanupFailure(producer), { status: "release_unproven", error_code: "EIO" });
      const bytes = await readFile(path, "utf8");
      assert.throws(() => withRunDescendantIntentAdmission(stateDir, producer, { ...request, runInstanceId: "another-child" },
        () => assert.fail("Quarantined producer prepared a child")), /cleanup remains unproven/);
      assert.equal(await readFile(path, "utf8"), bytes);
    } finally {
      fs.mkdirSync = mkdir; syncBuiltinESMExports();
      if (token && existsSync(lock)) {
        const held = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
        assert.equal(held.token, token);
        assert.equal(held.pid, process.pid);
        rmSync(lock, { recursive: true, force: true });
      }
    }
  }
});

});

await describe("Unpublished preparation", { concurrency: false }, async () => {

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-descendant-preparation-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});

const AsyncRuns = await import("../lib/async-runs.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const Descendants = await import("../lib/runs-descendant-launches.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { admitRunResultProducer, publishRunResult, readRunProducerCleanupFailure, revalidateRunWorkAdmission, withRunWorkAdmission } = await import("../lib/runs-results.ts");
const { createRunSupervisionClock, resolveRunSupervisionPolicy } = await import("../lib/run-supervision.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { archiveTerminalRun, pruneTerminalRun } = await import("../lib/runs-retention.ts");
const { acquireStateStartLock, assertNoActiveRunState, prepareStateDirForStart } = await import("../lib/runs-start.ts");
const { readJsonFileResilient } = await import("../lib/state-readers.ts");
const preparationFile = Descendants.RUN_DESCENDANT_PREPARATION_FILE;
const preparedMetaFile = Descendants.RUN_DESCENDANT_PREPARED_META_FILE;
const scopeError = /descendant .*scope is unproven/;
const readJson = (path: string) => readJsonFileResilient<Record<string, unknown> | undefined>(path, undefined).value;

async function ownedState(t: TestContext, run = "child") {
  const root = await mkdtemp(join(agentDir, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), run);
  return { root, stateDir };
}

test("A retained child-side preparation fences replacement/retirement before prepared metadata can be lost", async (t) => {
  for (const file of [preparationFile, preparedMetaFile]) {
    const { root, stateDir } = await ownedState(t);
    writeJsonAtomic(join(stateDir, "run.json"), { run: "child", run_instance_id: "prepared-child", state_dir: stateDir, pid: 0 });
    // Opaque evidence is enough to require refusal; it is not a native birth or membership receipt.
    writeJsonAtomic(join(stateDir, file), { retained: "unresolved child preparation" });
    const before = ["run.json", file].map((name) => readFileSync(join(stateDir, name), "utf8"));
    const release = acquireStateStartLock(stateDir);
    try {
      const status = { run: "child", state_dir: stateDir, status: "interrupted" };
      for (const action of [
        () => assertNoActiveRunState(stateDir, readJson, "unused"),
        () => prepareStateDirForStart(stateDir, readJson, "unused"),
        () => archiveTerminalRun(status),
        () => pruneTerminalRun(status),
      ]) {
        assert.throws(action, scopeError);
        assert.deepEqual(["run.json", file].map((name) => readFileSync(join(stateDir, name), "utf8")), before);
      }
    } finally { release(); }
    assert.equal(existsSync(join(root, "archived")), false);
  }
});

async function parentFixture(t: TestContext, capturedIdentity = true) {
  const { root, stateDir } = await ownedState(t, "parent");
  const clock = createRunSupervisionClock(resolveRunSupervisionPolicy({}, { max_runtime: "5m" }), Date.now());
  const meta = { run: "parent", run_instance_id: "parent-generation", ownerId: "parent-owner", state_dir: stateDir,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: capturedIdentity ? readProcessIdentity(process.pid) : undefined,
    outcome_protocol: "run-outcome-v1" };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  // This is a synchronous unit kernel, not an independently running async-runner.
  const producer = admitRunResultProducer(stateDir).producer;
  const childDir = join(root, "child");
  const params = { run_id: "child", state_dir: childDir, ownerId: "different-child-owner",
    template: `${process.execPath} -e "process.exit(0)"` };
  const prepare = () => AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, params, process.cwd());
  return { root, stateDir, meta, producer, childDir, params, prepare, parentPath: join(stateDir, Descendants.RUN_DESCENDANT_LAUNCH_FILE),
    childPath: join(childDir, preparationFile) };
}

function parentLedger(stateDir: string, producer: ReturnType<typeof admitRunResultProducer>["producer"]) {
  const reading = Descendants.readRunDescendantLaunchLedger(stateDir, producer);
  assert.equal(reading.state, "available");
  if (reading.state !== "available") throw Error("Expected retained descendant ledger");
  return reading.ledger;
}

test("Preparation uses the real start pipeline's fresh generation without native spawn, captures, or a launch receipt", async (t) => {
  const { stateDir, producer, childDir, params, childPath } = await parentFixture(t);
  const parentBefore = await readFile(join(stateDir, "run.json"), "utf8");
  const catalog = join(agentDir, "tmp", "pi-actors", "runs", "index.json");
  const catalogBefore = existsSync(catalog) ? readFileSync(catalog) : undefined;
  const spawn = childProcess.spawn;
  const rename = fs.renameSync;
  let nativeSpawns = 0;
  let simultaneousLocks = false;
  childProcess.spawn = (() => { nativeSpawns++; throw Error("Prepare-only attempted native spawn"); }) as typeof childProcess.spawn;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === childPath) {
      simultaneousLocks = [stateDir, childDir].every((dir) => existsSync(mutationLockPath(join(dir, ".lifecycle"))));
    }
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  let intent: ReturnType<typeof AsyncRuns.prepareDescendantRunGeneration>;
  try {
    intent = AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, {
      ...params, values: { run_instance_id: "actor-data-generation", delivery_parent: { run_instance_id: "untrusted-lineage" },
        parent_producer: { pid: 1, process_identity_digest: "actor-data" } },
      ...({ run_instance_id: "copied-generation", pid: process.pid } as object),
    }, process.cwd(), { onSupervisionClockCaptured: () => assert.fail("Unpublished preparation must not emit an ordinary launch clock handoff") });
  } finally { childProcess.spawn = spawn; fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.throws(() => {
    const status = AsyncRuns.getRunStatus(childDir);
    assert.fail(`Prepared state was published as Run status ${String(status.status)}`);
  }, /Run not found/);
  const meta = readJson(join(childDir, preparedMetaFile))!;
  assert.match(String(meta.run_instance_id), /^[0-9a-f-]{36}$/);
  assert.notEqual(meta.run_instance_id, "copied-generation");
  assert.notEqual(meta.run_instance_id, "actor-data-generation");
  assert.equal((meta.values as Record<string, unknown>).run_instance_id, "actor-data-generation");
  assert.equal(meta.pid, 0);
  assert.equal(Object.hasOwn(meta, "process_identity"), false);
  assert.equal(meta.ownerId, params.ownerId);
  assert.equal(meta.createdAt, meta.started_at);
  assert.equal(existsSync(join(childDir, "run.json")), false);
  assert.equal(existsSync(join(childDir, "progress.json")), false);
  assert.equal(nativeSpawns, 0);
  assert.deepEqual(existsSync(catalog) ? readFileSync(catalog) : undefined, catalogBefore);
  assert.equal(simultaneousLocks, true);
  for (const name of ["stdout.log", "stderr.log", "trace.jsonl", "result.json", "terminal-handled.json"]) assert.equal(existsSync(join(childDir, name)), false);
  assert.equal(existsSync(mutationLockPath(join(childDir, ".lifecycle"))), false);
  assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), parentBefore);
  assert.deepEqual(parentLedger(stateDir, producer).intents, [intent]);
  assert.equal(intent.child.run_instance_id, meta.run_instance_id);
  const parent = { run: producer.run, run_instance_id: producer.runInstanceId, ownerId: producer.ownerId, state_dir: stateDir };
  const marker = Descendants.readRunDescendantPreparation(childDir, intent.child, parent)!;
  assert.ok(marker);
  assert.deepEqual(marker.parent_producer, { pid: producer.pid, process_identity_digest: producer.processIdentityDigest ?? null });
  assert.deepEqual((meta.values as Record<string, unknown>).parent_producer, { pid: 1, process_identity_digest: "actor-data" });
  assert.deepEqual(intent.preparation, { preparation_id: marker.preparation_id, prepared_at: marker.prepared_at });
  for (const object of [intent, intent.child, intent.preparation, marker, marker.parent, marker.child, marker.parent_producer]) assert.equal(Object.isFrozen(object), true);
  for (const object of [intent, marker]) for (const key of ["birth", "membership", "complete", "native_pid", "settlement"]) assert.equal(Object.hasOwn(object, key), false);
});

test("Copied producers, accepted stop/result, and stale parent generations reject before touching child state", async (t) => {
  for (const mode of ["copy", "serialized", "stop", "terminal", "replacement"]) {
    const { stateDir, producer, params, childDir, meta, parentPath } = await parentFixture(t);
    let candidate = producer;
    if (mode === "copy") candidate = { ...producer };
    if (mode === "serialized") candidate = JSON.parse(JSON.stringify(producer));
    if (mode === "stop") assert.equal(claimRunStop(stateDir, {
      runInstanceId: producer.runInstanceId, ownerId: producer.ownerId, reason: "manual_kill",
    }, { verifyIdentity: () => ({ status: "valid", valid: true }) }).status, "stop_requested");
    if (mode === "terminal") publishRunResult(stateDir, producer, { code: 0 });
    if (mode === "replacement") writeJsonAtomic(join(stateDir, "run.json"), { ...meta, run_instance_id: "replacement" });
    assert.throws(() => AsyncRuns.prepareDescendantRunGeneration(stateDir, candidate, params, process.cwd()),
      /admitted by this runtime|stopping or unproven|terminal or unproven|generation changed/);
    assert.equal(existsSync(childDir), false);
    assert.equal(existsSync(parentPath), false);
  }
});

test("Self and known aliases refuse before a second lifecycle lock; live singleton attachment cannot impersonate new preparation", async (t) => {
  const { root, stateDir, producer, params, parentPath } = await parentFixture(t);
  const aliases = [stateDir];
  if (process.platform !== "win32") {
    const alias = join(root, "alias");
    await symlink(stateDir, alias);
    aliases.push(alias);
  }
  const before = await readFile(join(stateDir, "run.json"), "utf8");
  for (const path of aliases) assert.throws(() => AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, {
    ...params, state_dir: path, singleton: true,
  }, process.cwd()), /cannot target its parent state/);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), before);
  assert.equal(existsSync(parentPath), false);
  const other = await parentFixture(t);
  assert.throws(() => AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, {
    ...params, run_id: "parent", state_dir: other.stateDir, singleton: true,
  }, process.cwd()), /already has an active owned process/);
});

test("Prepare-only admission requires fresh state and cannot replace previous metadata, results, captures, or unrelated artifacts", async (t) => {
  for (const file of ["run.json", "result.json", "stdout.log", "user-artifact.txt"]) {
    const { childDir, parentPath, childPath, prepare } = await parentFixture(t);
    claimRunStateDirectory(childDir, "child");
    if (file === "run.json") writeJsonAtomic(join(childDir, file), {
      run: "child", run_instance_id: "previous-generation", state_dir: childDir, pid: 0,
    });
    else fs.writeFileSync(join(childDir, file), "previous retained evidence");
    const before = readFileSync(join(childDir, file), "utf8");
    assert.throws(prepare, /requires fresh state/);
    assert.equal(readFileSync(join(childDir, file), "utf8"), before);
    assert.equal(existsSync(parentPath), false);
    assert.equal(existsSync(childPath), false);
    assert.equal(existsSync(join(childDir, preparedMetaFile)), false);
  }
});

test("Prepare-only Recipe resolution does not count as a launch or mutate the temporary registry Recipe", async (t) => {
  const { stateDir, producer, childDir } = await parentFixture(t);
  const file = join(agentDir, "recipes", "prepared-only.json");
  fs.mkdirSync(join(agentDir, "recipes"), { recursive: true });
  const recipe = JSON.stringify({ async: true, template: `${process.execPath} -e "process.exit(0)"` });
  fs.writeFileSync(file, recipe);
  t.after(() => rm(file, { force: true }));
  const intent = AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, {
    file, run_id: "child", state_dir: childDir, ownerId: "different-child-owner",
  }, process.cwd());
  assert.ok(intent.preparation);
  assert.equal(await readFile(file, "utf8"), recipe);
  assert.equal(readJson(join(childDir, preparedMetaFile))?.pid, 0);
});

test("A competing child generation during lifecycle contention is refused, never adopted as this preparation", async (t) => {
  const { stateDir, producer, childDir, params, parentPath, childPath } = await parentFixture(t);
  const release = acquireStateStartLock(childDir);
  let released = false;
  let contended = false;
  let replacementBytes = "";
  try {
    assert.throws(() => AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, {
      ...params, singleton: true, lifecycleHooks: { onLockContention() {
        if (released) return;
        contended = true;
        assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
        // Inject a peer kernel's active replacement while the fixture owns its child lock.
        claimRunStateDirectory(childDir, "child");
        const replacement = { run: "child", run_instance_id: "competing-generation", ownerId: params.ownerId,
          state_dir: childDir, pid: process.pid, process_identity: readProcessIdentity(process.pid),
          createdAt: new Date().toISOString(), outcome_protocol: "run-outcome-v1" };
        writeJsonAtomic(join(childDir, "run.json"), replacement);
        replacementBytes = readFileSync(join(childDir, "run.json"), "utf8");
        release();
        released = true;
      } },
    }, process.cwd()), /singleton|active owned process|requires fresh state/);
  } finally { if (!released) release(); }
  assert.equal(contended, true);
  assert.equal(await readFile(join(childDir, "run.json"), "utf8"), replacementBytes);
  assert.equal(existsSync(parentPath), false);
  assert.equal(existsSync(childPath), false);
});

test("Parent and child identity are revalidated after preparation before committing the parent's prepared fact", async (t) => {
  for (const mutation of ["parent-generation", "parent-stop", "child-generation", "child-pid"]) {
    const { stateDir, meta, childDir, childPath, parentPath, prepare } = await parentFixture(t);
    const rename = fs.renameSync;
    let changed = false;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      const result = rename(from, to);
      if (!changed && String(to) === childPath) {
        changed = true;
        if (mutation === "parent-generation") fs.writeFileSync(join(stateDir, "run.json"), JSON.stringify({ ...meta, run_instance_id: "replacement" }));
        else if (mutation === "parent-stop") fs.writeFileSync(join(stateDir, "stop-claim.json"), "{unproven");
        else {
          const child = readJson(join(childDir, preparedMetaFile))!;
          fs.writeFileSync(join(childDir, preparedMetaFile), JSON.stringify({ ...child,
            ...(mutation === "child-generation" ? { run_instance_id: "replacement" } : { pid: process.pid }) }));
        }
      }
      return result;
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.throws(prepare, /generation changed|stopping or unproven|prepared metadata is unavailable or invalid/); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(changed, true);
    assert.equal(existsSync(childPath), true);
    assert.equal(existsSync(parentPath), false);
    assert.throws(() => prepareStateDirForStart(childDir, readJson, "unused"), scopeError);
  }
});

test("Marker or parent publication I/O failure admits no native work and never implicitly retries a retained preparation", async (t) => {
  for (const failedFile of ["marker", "parent"]) {
    const { stateDir, childDir, childPath, parentPath, prepare } = await parentFixture(t);
    const path = failedFile === "marker" ? childPath : parentPath;
    const rename = fs.renameSync;
    const failure = Object.assign(new Error("injected preparation publication EIO"), { code: "EIO" });
    let refusals = 0;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path) { refusals++; throw failure; }
      return rename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.throws(prepare, (error) => error === failure); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(refusals, 1);
    assert.equal(existsSync(parentPath), false);
    assert.equal(readJson(join(childDir, preparedMetaFile))?.pid, 0);
    for (const name of ["run.json", "progress.json", "stdout.log", "result.json"]) assert.equal(existsSync(join(childDir, name)), false);
    const retained = [preparedMetaFile, ...(failedFile === "parent" ? [preparationFile] : [])];
    const before = retained.map((name) => readFileSync(join(childDir, name), "utf8"));
    assert.throws(prepare, scopeError);
    assert.deepEqual(retained.map((name) => readFileSync(join(childDir, name), "utf8")), before);
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  }
});

test("Preparation records and prepared facts decode strictly without upgrading declarations into native membership", async (t) => {
  const { stateDir, producer, childDir, childPath, parentPath, prepare } = await parentFixture(t);
  const intent = prepare();
  const marker = JSON.parse(await readFile(childPath, "utf8"));
  const parentBytes = await readFile(parentPath, "utf8");
  for (const change of [
    (v: any) => { v.schema = "unsupported"; },
    (v: any) => { v.preparation_id = "00000000-0000-4000-7000-000000000001"; },
    (v: any) => { v.prepared_at = "unknown"; },
    (v: any) => { v.parent.run_instance_id = "foreign"; },
    (v: any) => { v.child.run_instance_id = "foreign"; },
    (v: any) => { v.child.ownerId = "foreign"; },
    (v: any) => { v.birth = { pid: 1 }; },
    ...[null, [], {}, { pid: 0, process_identity_digest: null }, { pid: -1, process_identity_digest: null },
      { pid: "1", process_identity_digest: null }, { pid: 0.5, process_identity_digest: null },
      { pid: Number.MAX_SAFE_INTEGER + 1, process_identity_digest: null }, { pid: 1 }, { process_identity_digest: null },
      { pid: 1, process_identity_digest: "A".repeat(64) }, { pid: 1, process_identity_digest: "a".repeat(63) },
      { pid: 1, process_identity_digest: `${"a".repeat(64)}\n` },
      { pid: 1, process_identity_digest: null, birth: {} },
    ].map((binding) => (v: any) => { v.parent_producer = binding; }),
  ]) {
    const modified = structuredClone(marker);
    change(modified);
    writeJsonAtomic(childPath, modified);
    assert.equal(Descendants.readRunDescendantPreparation(childDir, intent.child, marker.parent), undefined);
    withRunWorkAdmission(stateDir, producer, () => {
      const release = acquireStateStartLock(childDir);
      try {
        assert.throws(() => Descendants.recordRunDescendantLaunchIntentUnderLock(stateDir, producer, {
          run: intent.child.run, runInstanceId: intent.child.run_instance_id, ownerId: intent.child.ownerId, stateDir: childDir,
        }, marker), /preparation binding changed or is unavailable/);
      } finally { release(); }
    });
    assert.equal(await readFile(parentPath, "utf8"), parentBytes);
  }
  writeJsonAtomic(childPath, marker);
  for (const invalid of [{}, { preparation_id: marker.preparation_id, prepared_at: "invalid" },
    { ...intent.preparation, complete: true }, { ...intent.preparation, native_pid: 1 }]) {
    const modified = JSON.parse(parentBytes);
    modified.intents[0].preparation = invalid;
    writeJsonAtomic(parentPath, modified);
    assert.equal(Descendants.readRunDescendantLaunchLedger(stateDir, producer).state, "invalid");
    assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(stateDir), scopeError);
  }
});

test("Marker storage rejects invalid or mismatched producer descriptors before touching retained preparation", async (t) => {
  const { stateDir, producer, childDir, childPath, prepare } = await parentFixture(t);
  const intent = prepare();
  const marker = JSON.parse(await readFile(childPath, "utf8"));
  const before = await readFile(childPath, "utf8");
  for (const delta of [{ run: "foreign" }, { runInstanceId: "foreign" }, { ownerId: "foreign" },
    { pid: 0 }, { pid: "1" }, { processIdentityDigest: "unproven" }]) {
    withRunWorkAdmission(stateDir, producer, () => {
      const release = acquireStateStartLock(childDir);
      try {
        assert.throws(() => Descendants.recordRunDescendantPreparationUnderLock(childDir, intent.child,
          marker.parent, { ...producer, ...delta } as any), /producer binding is invalid/);
      } finally { release(); }
    });
    assert.equal(await readFile(childPath, "utf8"), before);
  }
});

test("Binding records the originally admitted producer even if parent metadata changes before marker storage", async (t) => {
  const { stateDir, meta, producer, childDir, childPath, parentPath, prepare } = await parentFixture(t);
  const rename = fs.renameSync;
  let changed = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const value = rename(from, to);
    if (!changed && String(to) === join(childDir, preparedMetaFile)) {
      changed = true;
      // Fault after admission, before marker storage; a new PID/fingerprint must never replace the captured producer.
      fs.writeFileSync(join(stateDir, "run.json"), JSON.stringify({ ...meta, pid: producer.pid + 1,
        process_identity: { platform: "linux", start_time: "replacement", command: "replacement" } }));
    }
    return value;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(prepare, /producer process changed/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(changed, true);
  const marker = JSON.parse(await readFile(childPath, "utf8"));
  assert.deepEqual(marker.parent_producer, { pid: producer.pid, process_identity_digest: producer.processIdentityDigest ?? null });
  assert.notEqual(marker.parent_producer.pid, readJson(join(stateDir, "run.json"))?.pid);
  assert.equal(existsSync(parentPath), false);
  assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(childDir), scopeError);
  for (const name of ["run.json", "stdout.log", "trace.jsonl", "result.json"]) assert.equal(existsSync(join(childDir, name)), false);
});

test("Unavailable captured fingerprints remain explicit null metadata, never a repaired native identity", async (t) => {
  const { stateDir, producer, childDir, childPath, prepare } = await parentFixture(t, false);
  assert.equal(producer.processIdentityDigest, undefined);
  const parentBefore = await readFile(join(stateDir, "run.json"), "utf8");
  const intent = prepare();
  const marker = Descendants.readRunDescendantPreparation(childDir, intent.child,
    JSON.parse(await readFile(childPath, "utf8")).parent)!;
  assert.deepEqual(marker.parent_producer, { pid: producer.pid, process_identity_digest: null });
  assert.equal(parentLedger(stateDir, producer).runner_identity_digest, null);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), parentBefore);
  assert.equal(Object.hasOwn(readJson(join(stateDir, "run.json"))!, "process_identity"), false);
  assert.equal(readJson(join(childDir, preparedMetaFile))?.pid, 0);
  assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(childDir), scopeError);
});

test("Work revalidation is exact-reference and callback-scoped, not authority reconstructed from a producer snapshot", async (t) => {
  const { stateDir, producer } = await parentFixture(t);
  assert.throws(() => revalidateRunWorkAdmission(stateDir, producer), /active runtime-local admission/);
  let late: (() => void) | undefined;
  withRunWorkAdmission(stateDir, producer, () => {
    revalidateRunWorkAdmission(stateDir, producer);
    assert.throws(() => revalidateRunWorkAdmission(stateDir, { ...producer }), /active runtime-local admission/);
    assert.throws(() => revalidateRunWorkAdmission(join(stateDir, "other"), producer), /active runtime-local admission/);
    late = () => revalidateRunWorkAdmission(stateDir, producer);
  });
  assert.throws(late!, /active runtime-local admission/);
  const original = new Error("preparation callback failed");
  assert.throws(() => withRunWorkAdmission(stateDir, producer, () => { throw original; }), (error) => error === original);
  assert.throws(() => revalidateRunWorkAdmission(stateDir, producer), /active runtime-local admission/);
});

test("Nested child/parent release failures preserve the first action outcome and quarantine with the first cleanup cause", async (t) => {
  for (const throwing of [false, true]) {
    const { stateDir, producer, childDir, childPath, parentPath, params, prepare } = await parentFixture(t);
    const locks = [stateDir, childDir].map((dir) => mutationLockPath(join(dir, ".lifecycle")));
    const tokens = new Map<string, string>();
    const mkdir = fs.mkdirSync;
    const rename = fs.renameSync;
    const primary = Object.freeze(Object.assign(new Error("original parent publication failure"), { code: "EIO" }));
    let armed = false;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      const result = rename(from, to);
      if (String(to) === childPath) {
        for (const path of locks) tokens.set(path, JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token);
        armed = true;
      }
      if (throwing && String(to) === parentPath) throw primary;
      return result;
    }) as typeof fs.renameSync;
    fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (armed && locks.some((lock) => String(path).startsWith(`${lock}.reclaim.`))) {
        throw Object.assign(new Error("injected nested cleanup failure"), {
          code: String(path).startsWith(`${locks[1]}.reclaim.`) ? "ENOSPC" : "EIO",
        });
      }
      return Reflect.apply(mkdir, fs, [path, ...args]);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    let value: ReturnType<typeof prepare> | undefined;
    let error: unknown;
    try {
      try { value = prepare(); } catch (caught) { error = caught; }
      fs.mkdirSync = mkdir; fs.renameSync = rename; syncBuiltinESMExports();
      if (throwing) assert.equal(error, primary);
      else {
        assert.equal(error, undefined);
        assert.ok(value?.preparation);
        assert.deepEqual(parentLedger(stateDir, producer).intents, [value]);
      }
      assert.deepEqual(readRunProducerCleanupFailure(producer), { status: "release_unproven", error_code: "ENOSPC" });
      assert.equal(existsSync(childPath), true);
      for (const lock of locks) assert.equal(existsSync(lock), true);
      assert.throws(() => AsyncRuns.prepareDescendantRunGeneration(stateDir, producer, {
        ...params, state_dir: join(childDir, "new-child"),
      }, process.cwd()), /cleanup remains unproven/);
    } finally {
      fs.mkdirSync = mkdir; fs.renameSync = rename; syncBuiltinESMExports();
      for (const [path, token] of tokens) if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
        assert.equal(owner.token, token);
        assert.equal(owner.pid, process.pid);
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
});

});

await describe("Reconciliation", { concurrency: false }, async () => {


const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-descendant-reconcile-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});

const { getRunStatus, prepareDescendantRunGeneration } = await import("../lib/async-runs.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const Descendants = await import("../lib/runs-descendant-launches.ts");
const Producers = await import("../lib/runs-results.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { acquireStateStartLock } = await import("../lib/runs-start.ts");
const { createRunSupervisionClock, resolveRunSupervisionPolicy } = await import("../lib/run-supervision.ts");

async function splitFixture(t: TestContext) {
  const root = await mkdtemp(join(agentDir, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "parent"), "parent");
  const clock = createRunSupervisionClock(resolveRunSupervisionPolicy({}, { max_runtime: "5m" }), Date.now());
  // Unit kernel in this process; no independent runner or child workload is started.
  const meta = { run: "parent", run_instance_id: "parent-generation", ownerId: "parent-owner", state_dir: stateDir,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: readProcessIdentity(process.pid),
    outcome_protocol: "run-outcome-v1" };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const producer = Producers.admitRunResultProducer(stateDir).producer;
  const childDir = join(root, "child");
  const parentPath = join(stateDir, Descendants.RUN_DESCENDANT_LAUNCH_FILE);
  const childPath = join(childDir, Descendants.RUN_DESCENDANT_PREPARATION_FILE);
  const stagedPath = join(childDir, Descendants.RUN_DESCENDANT_PREPARED_META_FILE);
  const rename = fs.renameSync;
  const failure = Object.freeze(Object.assign(new Error("injected split parent publication EIO"), { code: "EIO" }));
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === parentPath) throw failure;
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => prepareDescendantRunGeneration(stateDir, producer, {
      run_id: "child", state_dir: childDir, ownerId: "different-child-owner", template: `${process.execPath} -e "process.exit(0)"`,
    }, process.cwd()), (error) => error === failure);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(existsSync(parentPath), false);
  const preparation = JSON.parse(await readFile(childPath, "utf8")) as RunDescendantPreparation;
  assert.deepEqual(preparation.parent_producer, { pid: producer.pid, process_identity_digest: producer.processIdentityDigest ?? null });
  const request = { run: preparation.child.run, runInstanceId: preparation.child.run_instance_id,
    ownerId: preparation.child.ownerId, stateDir: childDir };
  return { root, stateDir, meta, producer, childDir, parentPath, childPath, stagedPath, preparation, request };
}

function withChildEvidence<T>(fixture: Awaited<ReturnType<typeof splitFixture>>, record: () => T): T {
  return Producers.withRunProducerEvidence(fixture.stateDir, fixture.producer, () => {
    const release = acquireStateStartLock(fixture.childDir);
    try { return record(); }
    finally { release(); }
  });
}

test("Preparation reconciliation upgrades the exact declared intent without replacing its id, admission time, or child", async (t) => {
  const fixture = await splitFixture(t);
  const { stateDir, producer, request, preparation, stagedPath, childPath } = fixture;
  const original = Producers.withRunDescendantIntentAdmission(stateDir, producer, request, (intent) => intent);
  const childBytes = [stagedPath, childPath].map((path) => readFileSync(path, "utf8"));
  const upgraded = withChildEvidence(fixture, () => Descendants.recordRunDescendantLaunchIntentUnderLock(stateDir, producer, request, preparation));
  assert.equal(upgraded.intent_id, original.intent_id);
  assert.equal(upgraded.admitted_at, original.admitted_at);
  assert.deepEqual(upgraded.child, original.child);
  assert.deepEqual(upgraded.preparation, { preparation_id: preparation.preparation_id, prepared_at: preparation.prepared_at });
  assert.deepEqual([stagedPath, childPath].map((path) => readFileSync(path, "utf8")), childBytes);
});

test("Staged metadata cannot authorize a new prepared fact while a canonical Run publication also exists", async (t) => {
  const fixture = await splitFixture(t);
  const { stateDir, producer, request, preparation, childDir, parentPath } = fixture;
  writeJsonAtomic(join(childDir, "run.json"), { run: "child", run_instance_id: request.runInstanceId,
    state_dir: childDir, ownerId: request.ownerId, pid: process.pid });
  assert.throws(() => withChildEvidence(fixture, () => Descendants.recordRunDescendantLaunchIntentUnderLock(
    stateDir, producer, request, preparation,
  )), /published or unavailable/);
  assert.equal(existsSync(parentPath), false);
});

function protectedBytes(fixture: Awaited<ReturnType<typeof splitFixture>>) {
  const parent = ["run.json", "progress.json", "result.json", "stop-claim.json", "trace.jsonl", "terminal-handled.json"];
  return { parent: parent.map((name) => {
    const path = join(fixture.stateDir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }), child: [fixture.stagedPath, fixture.childPath].map((path) => readFileSync(path, "utf8")) };
}

function reconcile(fixture: Awaited<ReturnType<typeof splitFixture>>) {
  return Producers.reconcileRunDescendantPreparation(fixture.stateDir, fixture.producer, fixture.request);
}

test("Explicit reconciliation retains missing parent preparation under ordered locks without work, root changes, or child publication", async (t) => {
  const fixture = await splitFixture(t);
  const { stateDir, producer, childDir, parentPath, preparation } = fixture;
  const before = protectedBytes(fixture);
  const spawn = childProcess.spawn;
  const rename = fs.renameSync;
  let orderedLocks = false;
  let writes = 0;
  childProcess.spawn = (() => { throw Error("Evidence reconciliation attempted native spawn"); }) as typeof childProcess.spawn;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === parentPath) {
      writes++;
      orderedLocks = [stateDir, childDir].every((dir) => existsSync(mutationLockPath(join(dir, ".lifecycle"))));
    }
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  let result: ReturnType<typeof reconcile>;
  try { result = reconcile(fixture); }
  finally { childProcess.spawn = spawn; fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(result.status, "recorded");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.intent), true);
  assert.deepEqual(result.intent.preparation, { preparation_id: preparation.preparation_id, prepared_at: preparation.prepared_at });
  assert.equal(writes, 1);
  assert.equal(orderedLocks, true);
  assert.deepEqual(protectedBytes(fixture), before);
  assert.equal(Descendants.readRunDescendantLaunchLedger(stateDir, producer).state, "available");
  assert.throws(() => getRunStatus(childDir), /Run not found/);
  for (const path of [stateDir, childDir]) {
    assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(path), /scope is unproven/);
    assert.equal(existsSync(mutationLockPath(join(path, ".lifecycle"))), false);
  }
});

test("An accepted prepared fact is reused byte-exactly without probing inaccessible child evidence", async (t) => {
  const fixture = await splitFixture(t);
  const first = reconcile(fixture);
  const bytes = await readFile(fixture.parentPath, "utf8");
  // Historical accepted facts stay immutable even when only unbound legacy child metadata remains.
  const { parent_producer: _binding, ...legacy } = fixture.preparation;
  writeJsonAtomic(fixture.childPath, legacy);
  const read = fs.readFileSync;
  const lstat = fs.lstatSync;
  let childProbes = 0;
  const denied = (path: fs.PathLike | number) => {
    if (String(path).startsWith(fixture.childDir)) { childProbes++; throw Object.assign(new Error("child evidence denied"), { code: "EACCES" }); }
  };
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    denied(path);
    return Reflect.apply(read, fs, [path, ...args]);
  }) as typeof fs.readFileSync;
  fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
    denied(path);
    return Reflect.apply(lstat, fs, [path, ...args]);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  let again: ReturnType<typeof reconcile>;
  try { again = reconcile(fixture); }
  finally { fs.readFileSync = read; fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.equal(again.status, "already_recorded");
  assert.deepEqual(again.intent, first.intent);
  assert.equal(childProbes, 0);
  assert.equal(await readFile(fixture.parentPath, "utf8"), bytes);
});

test("Reconciliation adds evidence while stopping or naturally terminal without regressing root truth", async (t) => {
  for (const mode of ["manual-stop", "malformed-stop", "captured-result", "success", "failure", "natural-then-malformed"]) {
    const fixture = await splitFixture(t);
    const { stateDir, producer } = fixture;
    if (mode === "manual-stop" || mode === "captured-result") {
      assert.equal(claimRunStop(stateDir, { runInstanceId: producer.runInstanceId, ownerId: producer.ownerId, reason: "manual_kill" }, {
        verifyIdentity: () => ({ status: "valid", valid: true }),
      }).status, "stop_requested");
    }
    if (mode === "success" || mode === "natural-then-malformed" || mode === "captured-result") Producers.publishRunResult(stateDir, producer, { code: 0 });
    if (mode === "failure") Producers.publishRunResult(stateDir, producer, { code: 7 });
    if (mode === "malformed-stop" || mode === "natural-then-malformed") fs.writeFileSync(join(stateDir, "stop-claim.json"), "{unproven");
    const before = protectedBytes(fixture);
    const status = getRunStatus(stateDir);
    const evidenceStatus = Producers.withRunProducerEvidence(stateDir, producer, (context) => context.status);
    if (mode === "natural-then-malformed") t.diagnostic(`Before reconciliation: accepted evidence=${evidenceStatus}; existing status projection=${String(status.status)}`);
    assert.equal(reconcile(fixture).status, "recorded");
    assert.deepEqual(protectedBytes(fixture), before);
    const after = getRunStatus(stateDir);
    assert.equal(after.status, status.status);
    assert.equal(after.phase, status.phase);
    assert.equal(Producers.withRunProducerEvidence(stateDir, producer, (context) => context.status), evidenceStatus);
    if (mode === "success" || mode === "natural-then-malformed") assert.equal(evidenceStatus, "done");
    if (mode === "failure") assert.equal(evidenceStatus, "failed");
    assert.throws(() => Producers.withRunWorkAdmission(stateDir, producer, () => assert.fail("Evidence reopened work")), /stopping or unproven|terminal or unproven/);
  }
});

test("Copied producers and changed parent identities cannot reconcile; invalid natural evidence also remains refused", async (t) => {
  for (const mode of ["copy", "serialized", "generation", "owner", "pid", "fingerprint", "protocol", "result"]) {
    const fixture = await splitFixture(t);
    const { stateDir, producer, request, meta, parentPath } = fixture;
    let candidate = producer;
    if (mode === "copy") candidate = { ...producer };
    if (mode === "serialized") candidate = JSON.parse(JSON.stringify(producer));
    const delta = mode === "generation" ? { run_instance_id: "replacement" } : mode === "owner" ? { ownerId: "replacement" }
      : mode === "pid" ? { pid: process.pid + 1 } : mode === "fingerprint" ? { process_identity: { platform: "linux", start_time: "other", command: "other" } }
      : mode === "protocol" ? { outcome_protocol: "unsupported" } : {};
    if (Object.keys(delta).length) writeJsonAtomic(join(stateDir, "run.json"), { ...meta, ...delta });
    if (mode === "result") writeJsonAtomic(join(stateDir, "result.json"), { run_instance_id: producer.runInstanceId, code: "invalid" });
    const before = protectedBytes(fixture);
    assert.throws(() => Producers.reconcileRunDescendantPreparation(stateDir, candidate, request),
      /admitted by this runtime|generation changed|owner changed|process changed|process identity changed|protocol changed|evidence state is unavailable or invalid/);
    assert.deepEqual(protectedBytes(fixture), before);
    assert.equal(existsSync(parentPath), false);
  }
});

test("Exact child references and reciprocal records are required; missing or corrupt evidence is not reconstructed", async (t) => {
  for (const mode of ["generation", "owner", "run", "path", "marker-missing", "marker-corrupt", "marker-foreign", "metadata-missing", "metadata-foreign", "metadata-pid", "canonical", "parent-corrupt"]) {
    const fixture = await splitFixture(t);
    const { stateDir, producer, request, childPath, stagedPath, childDir, parentPath } = fixture;
    const candidate = { ...request,
      ...(mode === "generation" ? { runInstanceId: "foreign" } : mode === "owner" ? { ownerId: "foreign" }
        : mode === "run" ? { run: "foreign" } : mode === "path" ? { stateDir: join(fixture.root, "missing-child") } : {}) };
    if (mode === "marker-missing") fs.rmSync(childPath);
    if (mode === "marker-corrupt") fs.writeFileSync(childPath, "{unproven");
    if (mode === "marker-foreign") writeJsonAtomic(childPath, { ...fixture.preparation, parent: { ...fixture.preparation.parent, run_instance_id: "foreign" } });
    if (mode === "metadata-missing") fs.rmSync(stagedPath);
    if (mode === "metadata-foreign" || mode === "metadata-pid") {
      const metadata = JSON.parse(readFileSync(stagedPath, "utf8"));
      writeJsonAtomic(stagedPath, { ...metadata, ...(mode === "metadata-foreign" ? { run_instance_id: "foreign" } : { pid: process.pid }) });
    }
    if (mode === "canonical") writeJsonAtomic(join(childDir, "run.json"), { run_instance_id: request.runInstanceId, pid: 0 });
    if (mode === "parent-corrupt") fs.writeFileSync(parentPath, "{unproven");
    const parentBytes = existsSync(parentPath) ? readFileSync(parentPath, "utf8") : undefined;
    const childEntries = fs.readdirSync(childDir).sort();
    assert.throws(() => Producers.reconcileRunDescendantPreparation(stateDir, producer, candidate));
    assert.equal(existsSync(parentPath) ? readFileSync(parentPath, "utf8") : undefined, parentBytes);
    assert.deepEqual(fs.readdirSync(childDir).sort(), childEntries);
    if (mode === "path") assert.equal(existsSync(candidate.stateDir), false);
    assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(childDir), /scope is unproven/);
  }
});

test("Unbound or foreign producer references stay readable evidence but cannot create or upgrade a prepared fact", async (t) => {
  for (const declared of [false, true]) for (const mode of ["legacy", "pid", "digest"]) {
    const fixture = await splitFixture(t);
    const { stateDir, producer, childDir, childPath, parentPath, preparation, request } = fixture;
    if (declared) Producers.withRunDescendantIntentAdmission(stateDir, producer, request, () => undefined);
    const modified = structuredClone(preparation);
    if (mode === "legacy") delete (modified as { parent_producer?: unknown }).parent_producer;
    else if (mode === "pid") (modified.parent_producer as { pid: number }).pid = producer.pid + 1;
    else (modified.parent_producer as { process_identity_digest: string | null }).process_identity_digest =
      producer.processIdentityDigest === undefined ? "a".repeat(64) : null;
    writeJsonAtomic(childPath, modified);
    assert.ok(Descendants.readRunDescendantPreparation(childDir, preparation.child, preparation.parent));
    const before = protectedBytes(fixture);
    const parentBytes = existsSync(parentPath) ? readFileSync(parentPath, "utf8") : undefined;
    assert.throws(() => reconcile(fixture), /preparation producer binding changed or is unavailable/);
    assert.deepEqual(protectedBytes(fixture), before);
    assert.equal(existsSync(parentPath) ? readFileSync(parentPath, "utf8") : undefined, parentBytes);
    assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(childDir), /scope is unproven/);
    assert.equal(existsSync(join(childDir, "run.json")), false);
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
    assert.equal(existsSync(mutationLockPath(join(childDir, ".lifecycle"))), false);
  }
});

test("A declared row cannot be rebound through reconciliation and accepted preparation cannot be replaced", async (t) => {
  const fixture = await splitFixture(t);
  const { stateDir, producer, request, parentPath } = fixture;
  Producers.withRunDescendantIntentAdmission(stateDir, producer, { ...request, ownerId: "different-declared-owner" }, () => undefined);
  const bytes = await readFile(parentPath, "utf8");
  assert.throws(() => reconcile(fixture), /preparation target changed/);
  assert.equal(await readFile(parentPath, "utf8"), bytes);
  const other = await splitFixture(t);
  reconcile(other);
  const accepted = await readFile(other.parentPath, "utf8");
  const conflict = { ...other.preparation, preparation_id: "00000000-0000-4000-8000-000000000001" };
  assert.throws(() => withChildEvidence(other, () => Descendants.recordRunDescendantLaunchIntentUnderLock(
    other.stateDir, other.producer, other.request, conflict,
  )), /preparation binding changed or is unavailable/);
  assert.equal(await readFile(other.parentPath, "utf8"), accepted);
});

test("Each reconciliation call attempts publication once; a fresh call repairs pre-commit EIO or reuses an after-commit winner", async (t) => {
  for (const afterCommit of [false, true]) {
    const fixture = await splitFixture(t);
    const before = protectedBytes(fixture);
    const rename = fs.renameSync;
    const failure = Object.freeze(Object.assign(new Error("explicit reconciliation EIO"), { code: "EIO" }));
    let attempts = 0;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== fixture.parentPath) return rename(from, to);
      attempts++;
      if (afterCommit) rename(from, to);
      throw failure;
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.throws(() => reconcile(fixture), (error) => error === failure); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(attempts, 1);
    assert.deepEqual(protectedBytes(fixture), before);
    assert.equal(existsSync(fixture.parentPath), afterCommit);
    const accepted = afterCommit ? readFileSync(fixture.parentPath, "utf8") : undefined;
    assert.equal(reconcile(fixture).status, afterCommit ? "already_recorded" : "recorded");
    if (accepted) assert.equal(readFileSync(fixture.parentPath, "utf8"), accepted);
  }
});

async function waitFor(path: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw Error("Reconciliation fixture handshake timed out");
    await delay(10);
  }
}

test("A reconciler waiting for child admission revalidates parent generation and current child evidence before writing", async (t) => {
  for (const mutation of ["parent", "child", "canonical"]) {
    const fixture = await splitFixture(t);
    const { root, stateDir, childDir, parentPath, stagedPath } = fixture;
    const workerPath = join(root, "peer.mjs");
    const ready = join(root, "ready");
    const observed = join(root, "observed");
    const releasePeer = join(root, "release-peer");
    const startUrl = new URL("../lib/runs-start.ts", import.meta.url).href;
    fs.writeFileSync(workerPath, `import fs from 'node:fs';import {join} from 'node:path';import {acquireStateStartLock} from ${JSON.stringify(startUrl)};
      const release=acquireStateStartLock(${JSON.stringify(childDir)});fs.writeFileSync(${JSON.stringify(ready)},'ready');
      try{const end=Date.now()+8000;while(!fs.existsSync(${JSON.stringify(observed)})&&!fs.existsSync(${JSON.stringify(releasePeer)})){
        if(Date.now()>end)throw Error('peer handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
        if(fs.existsSync(${JSON.stringify(observed)})){
          const path=${JSON.stringify(mutation === "parent" ? join(stateDir, "run.json") : stagedPath)};
          const meta=JSON.parse(fs.readFileSync(path,'utf8'));
          if(${JSON.stringify(mutation)}==='canonical')fs.writeFileSync(${JSON.stringify(join(childDir, "run.json"))},JSON.stringify(meta));
          else {fs.writeFileSync(path+'.peer',JSON.stringify({...meta,run_instance_id:'peer-replacement'}));fs.renameSync(path+'.peer',path)}
        }}finally{release()}
    `);
    const peer = childProcess.spawn(process.execPath, ["--experimental-strip-types", workerPath], {
      stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "peer-agent") },
    });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => peer.once("close", (code, signal) => resolve([code, signal])));
    let stderr = "";
    peer.on("error", (error) => { stderr += String(error); });
    peer.stderr!.on("data", (bytes) => { stderr += String(bytes); });
    const lstat = fs.lstatSync;
    try {
      await waitFor(ready);
      fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
        if (String(path) === stagedPath) fs.writeFileSync(observed, "parent-evidence-admitted");
        return Reflect.apply(lstat, fs, [path, ...args]);
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      assert.throws(() => reconcile(fixture), /generation changed|prepared metadata is unavailable or invalid|published or unavailable/);
      assert.equal(existsSync(parentPath), false);
    } finally {
      fs.lstatSync = lstat; syncBuiltinESMExports();
      fs.writeFileSync(releasePeer, "release");
      const [code, signal] = await closed;
      assert.equal(code, 0, stderr);
      assert.equal(signal, null, stderr);
    }
  }
});

test("Child release failure preserves recorded evidence or the primary error and fences further producer operations", async (t) => {
  for (const throwing of [false, true]) {
    const fixture = await splitFixture(t);
    const lock = mutationLockPath(join(fixture.childDir, ".lifecycle"));
    const mkdir = fs.mkdirSync;
    const rename = fs.renameSync;
    const primary = Object.freeze(Object.assign(new Error("primary reconciliation publication error"), { code: "EIO" }));
    let armed = false;
    let token: string | undefined;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      const result = rename(from, to);
      if (String(to) === fixture.parentPath) {
        token = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token;
        armed = true;
        if (throwing) throw primary;
      }
      return result;
    }) as typeof fs.renameSync;
    fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (armed && String(path).startsWith(`${lock}.reclaim.`)) throw Object.assign(new Error("child release ENOSPC"), { code: "ENOSPC" });
      return Reflect.apply(mkdir, fs, [path, ...args]);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    let value: ReturnType<typeof reconcile> | undefined;
    let error: unknown;
    try {
      try { value = reconcile(fixture); } catch (caught) { error = caught; }
      fs.mkdirSync = mkdir; fs.renameSync = rename; syncBuiltinESMExports();
      if (throwing) assert.equal(error, primary);
      else { assert.equal(error, undefined); assert.equal(value?.status, "recorded"); }
      assert.equal(existsSync(fixture.parentPath), true);
      assert.deepEqual(Producers.readRunProducerCleanupFailure(fixture.producer), { status: "release_unproven", error_code: "ENOSPC" });
      const bytes = readFileSync(fixture.parentPath, "utf8");
      assert.throws(() => reconcile(fixture), /cleanup remains unproven/);
      assert.equal(readFileSync(fixture.parentPath, "utf8"), bytes);
    } finally {
      fs.mkdirSync = mkdir; fs.renameSync = rename; syncBuiltinESMExports();
      if (token && existsSync(lock)) {
        const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
        assert.equal(owner.token, token);
        assert.equal(owner.pid, process.pid);
        fs.rmSync(lock, { recursive: true, force: true });
      }
    }
  }
});

});

await describe("Producer-loss recovery", { concurrency: false }, async () => {

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-descendant-recovery-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});

const Control = await import("../lib/runs-control.ts");
const Descendants = await import("../lib/runs-descendant-launches.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { acquireStateStartLock } = await import("../lib/runs-start.ts");
const { captureSpawnedNativeProcessIdentity, readProcessLiveness } = await import("../lib/runs-process.ts");
const { createRunSupervisionClock, resolveRunSupervisionPolicy } = await import("../lib/run-supervision.ts");

async function waitFor(path: string) {
  const until = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > until) throw Error("Descendant recovery fixture handshake timed out");
    await delay(5);
  }
}

async function producerFixture(t: TestContext, options: { hold?: boolean; declared?: boolean; outcome?: string; ownerless?: boolean } = {}) {
  const root = await mkdtemp(join(agentDir, "case-"));
  const stateDir = claimRunStateDirectory(join(root, "parent"), "parent");
  const childDir = join(root, "child");
  const parentPath = join(stateDir, Descendants.RUN_DESCENDANT_LAUNCH_FILE);
  const childPath = join(childDir, Descendants.RUN_DESCENDANT_PREPARATION_FILE);
  const stagedPath = join(childDir, Descendants.RUN_DESCENDANT_PREPARED_META_FILE);
  const go = join(root, "go");
  const finish = join(root, "finish");
  const ready = join(root, "prepared");
  const worker = join(root, "producer.mjs");
  const urls = Object.fromEntries(["async-runs", "runs-results", "runs-control"].map((name) => [name, new URL(`../lib/${name}.ts`, import.meta.url).href]));
  await writeFile(worker, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    import {prepareDescendantRunGeneration} from ${JSON.stringify(urls["async-runs"])};
    import {admitRunResultProducer,withRunDescendantIntentAdmission,publishRunResult} from ${JSON.stringify(urls["runs-results"])};
    import {claimRunStop} from ${JSON.stringify(urls["runs-control"])};
    const end=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(go)})){if(Date.now()>end)throw Error('launch handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
    const stateDir=${JSON.stringify(stateDir)},childDir=${JSON.stringify(childDir)};
    const {producer}=admitRunResultProducer(stateDir);const rename=fs.renameSync;
    const refusal=Object.freeze(Object.assign(Error('split parent publication'),{code:'EIO'}));
    cp.spawn=()=>{throw Error('Preparation attempted native workload')};
    fs.renameSync=(from,to)=>{if(String(to)===${JSON.stringify(parentPath)})throw refusal;return rename(from,to)};syncBuiltinESMExports();
    try {prepareDescendantRunGeneration(stateDir,producer,{run_id:'child',state_dir:childDir,ownerId:'child-owner',template:process.execPath+' -e "process.exit(0)"'},process.cwd());throw Error('Expected split publication refusal')}
    catch(error){if(error!==refusal)throw error}finally{fs.renameSync=rename;syncBuiltinESMExports()}
    const marker=JSON.parse(fs.readFileSync(${JSON.stringify(childPath)},'utf8'));
    const child={run:marker.child.run,runInstanceId:marker.child.run_instance_id,ownerId:marker.child.ownerId,stateDir:childDir};
    ${options.declared ? "withRunDescendantIntentAdmission(stateDir,producer,child,()=>undefined);" : ""}
    ${options.outcome === "captured" ? "if(claimRunStop(stateDir,{runInstanceId:producer.runInstanceId,ownerId:producer.ownerId,reason:'manual_kill'}).status!=='stop_requested')throw Error('stop not admitted');publishRunResult(stateDir,producer,{code:0});" : ""}
    ${options.outcome === "success" || options.outcome === "natural-bad-stop" ? "publishRunResult(stateDir,producer,{code:0});" : ""}
    ${options.outcome === "failure" ? "publishRunResult(stateDir,producer,{code:7});" : ""}
    ${options.outcome === "bad-stop" || options.outcome === "natural-bad-stop" ? "fs.writeFileSync(stateDir+'/stop-claim.json','{unproven');" : ""}
    fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify(child));
    ${options.hold ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})||Date.now()>end){clearInterval(timer);process.exit(42)}},5);` : "process.exit(42);"}`);
  let processHandle: ChildProcess | undefined;
  let closed: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let stderr = "";
  const peers = new Map<ChildProcess, Promise<[number | null, NodeJS.Signals | null]>>();
  const retain = (peer: ChildProcess) => {
    const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => peer.once("close", (code, signal) => resolve([code, signal])));
    peer.on("error", () => undefined);
    peers.set(peer, ended);
    return ended;
  };
  t.after(async () => {
    for (const [peer, ended] of peers) {
      if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGKILL");
      await ended;
    }
    writeFileSync(finish, "finish");
    if (processHandle) {
      if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const clock = createRunSupervisionClock(resolveRunSupervisionPolicy({}, { max_runtime: "5m" }), Date.now());
  const release = acquireStateStartLock(stateDir);
  let meta: Record<string, unknown>;
  try {
    processHandle = spawn(process.execPath, ["--experimental-strip-types", worker], { stdio: ["ignore", "ignore", "pipe"] });
    closed = new Promise((resolve) => processHandle!.once("close", (code, signal) => resolve([code, signal])));
    processHandle.on("error", (error) => { stderr += String(error); });
    processHandle.stderr!.on("data", (bytes) => { stderr = (stderr + String(bytes)).slice(-16_384); });
    const identity = captureSpawnedNativeProcessIdentity(processHandle);
    assert.ok(identity, "Fresh fixture producer identity must be captured before admitting preparation");
    meta = { run: "parent", run_instance_id: "parent-generation", ...(options.ownerless ? {} : { ownerId: "parent-owner" }), state_dir: stateDir,
      createdAt: clock.started_at, ...clock, pid: processHandle.pid, process_identity: identity, outcome_protocol: "run-outcome-v1" };
    writeJsonAtomic(join(stateDir, "run.json"), meta);
  } finally { release(); }
  writeFileSync(go, "go");
  await waitFor(ready);
  if (!options.hold) {
    assert.deepEqual(await closed, [42, null], stderr);
    assert.equal(readProcessLiveness(processHandle.pid!), "dead");
  }
  const child = JSON.parse(await readFile(ready, "utf8"));
  const preparation = JSON.parse(await readFile(childPath, "utf8"));
  return { root, stateDir, childDir, parentPath, childPath, stagedPath, meta: meta!, preparation,
    request: { runInstanceId: "parent-generation", ...(options.ownerless ? {} : { ownerId: "parent-owner" }), child },
    finish, closed: closed!, processHandle, retain };
}

function protectedBytes(f: Awaited<ReturnType<typeof producerFixture>>) {
  return [...["run.json", "result.json", "stop-claim.json", "progress.json", "trace.jsonl", "terminal-handled.json"]
    .map((name) => join(f.stateDir, name)), f.stagedPath, f.childPath]
    .map((path) => existsSync(path) ? readFileSync(path, "utf8") : null);
}

const recover = Control.recoverRunDescendantPreparation;

test("An exited original producer permits exact metadata repair or monotonic upgrade without work, outcomes, or closure", async (t) => {
  for (const declared of [false, true]) for (const ownerless of [false, true]) {
    const f = await producerFixture(t, { declared, ownerless });
    const before = protectedBytes(f);
    const prior = existsSync(f.parentPath) ? JSON.parse(await readFile(f.parentPath, "utf8")).intents[0] : undefined;
    const result = recover(f.stateDir, f.request);
    assert.equal(result.status, "recorded");
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.intent), true);
    assert.deepEqual(result.intent.child, f.preparation.child);
    assert.deepEqual(result.intent.preparation, { preparation_id: f.preparation.preparation_id, prepared_at: f.preparation.prepared_at });
    if (prior) {
      assert.equal(result.intent.intent_id, prior.intent_id);
      assert.equal(result.intent.admitted_at, prior.admitted_at);
    }
    assert.deepEqual(protectedBytes(f), before);
    for (const path of [f.stateDir, f.childDir]) assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(path), /scope is unproven/);
    for (const name of ["run.json", "progress.json", "stdout.log", "result.json"]) assert.equal(existsSync(join(f.childDir, name)), false);
  }
});

test("Accepted preparation facts are reused without native observations or child probes", async (t) => {
  const f = await producerFixture(t);
  const first = recover(f.stateDir, f.request);
  assert.equal(first.status, "recorded");
  const bytes = await readFile(f.parentPath, "utf8");
  const read = fs.readFileSync, lstat = fs.lstatSync;
  let childProbes = 0;
  const denied = (path: fs.PathLike | number) => {
    if (String(path).startsWith(f.childDir)) { childProbes++; throw Object.assign(Error("child denied"), { code: "EACCES" }); }
  };
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => { denied(path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
  fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => { denied(path); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  let result: any;
  try { result = recover(f.stateDir, f.request, { probe: () => assert.fail("Accepted fact reprobed native PID") }); }
  finally { fs.readFileSync = read; fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.equal(result.status, "already_recorded");
  assert.deepEqual(result.intent, first.intent);
  assert.equal(childProbes, 0);
  assert.equal(await readFile(f.parentPath, "utf8"), bytes);
});

test("A live original producer cannot be replaced by controller recovery", async (t) => {
  const f = await producerFixture(t, { hold: true });
  const before = protectedBytes(f);
  assert.deepEqual(recover(f.stateDir, f.request), { status: "unproven", reason: "producer_running" });
  assert.deepEqual(protectedBytes(f), before);
  assert.equal(existsSync(f.parentPath), false);
  writeFileSync(f.finish, "finish");
  assert.deepEqual(await f.closed, [42, null]);
});

test("Denied, false, missing, reused, live, and unsupported observations cannot become producer-exit proof", async (t) => {
  const f = await producerFixture(t);
  const before = protectedBytes(f);
  for (const mode of ["denied", "false", "live", "missing", "reused", "unsupported"]) {
    let probes = 0;
    const result = recover(f.stateDir, f.request, {
      runtimePlatform: mode === "unsupported" ? (process.platform === "linux" ? "darwin" : "linux") : process.platform,
      probe: (pid: number, signal: number) => {
        probes++;
        assert.equal(pid, f.meta.pid);
        assert.equal(signal, 0);
        if (mode === "denied") throw Object.assign(Error("denied"), { code: "EPERM" });
        return mode !== "false";
      },
      readIdentity: () => mode === "missing" ? undefined : mode === "reused"
        ? { ...(f.meta.process_identity as RunProcessIdentity), start_time: "replacement" } : f.meta.process_identity as RunProcessIdentity,
    });
    assert.equal(result.status, "unproven", mode);
    assert.equal(result.reason, mode === "live" ? "producer_running" : "producer_exit_unproven", mode);
    assert.equal(probes, mode === "unsupported" ? 0 : 1);
    assert.equal(existsSync(f.parentPath), false);
    assert.deepEqual(protectedBytes(f), before);
  }
});

test("Unbound or unavailable saved identity stays unproven without bare-PID repair", async (t) => {
  for (const mode of ["legacy-marker", "null-binding", "missing-saved-identity"]) {
    const f = await producerFixture(t);
    const marker = structuredClone(f.preparation);
    if (mode === "legacy-marker") delete marker.parent_producer;
    if (mode === "null-binding") marker.parent_producer.process_identity_digest = null;
    if (mode === "missing-saved-identity") {
      const { process_identity: _identity, ...legacy } = f.meta;
      writeJsonAtomic(join(f.stateDir, "run.json"), legacy);
    } else writeJsonAtomic(f.childPath, marker);
    const before = protectedBytes(f);
    const result = recover(f.stateDir, f.request, { probe: () => assert.fail("Unbound PID probed"), readIdentity: () => assert.fail("Identity recaptured") });
    assert.deepEqual(result, { status: "unproven", reason: mode === "legacy-marker" ? "producer_binding_unavailable" : "producer_identity_unavailable" });
    assert.deepEqual(protectedBytes(f), before);
    assert.equal(existsSync(f.parentPath), false);
  }
});

test("Reference, ownership, generation, protocol, and evidence refusals precede native observation and never create missing state", async (t) => {
  const noProbe = { probe: () => assert.fail("Rejected recovery probed a PID") };
  const input = await producerFixture(t);
  for (const request of [undefined, { ...input.request, runInstanceId: "" }, { ...input.request, ownerId: "" }, { ...input.request, child: undefined }, { ...input.request, child: [] }]) {
    assert.equal(recover(input.stateDir, request as Parameters<typeof recover>[1], noProbe).status, "rejected");
    assert.equal(existsSync(input.parentPath), false);
  }
  const missing = join(input.root, "no-parent");
  assert.equal(recover(missing, input.request, noProbe).status, "rejected");
  assert.equal(existsSync(missing), false);
  for (const mode of ["generation", "owner", "protocol", "pid", "digest", "request-generation", "child-generation", "child-owner", "missing-path", "self-path",
    "marker-missing", "marker-corrupt", "marker-foreign", "marker-pid", "marker-digest", "staged-missing", "staged-foreign", "staged-pid", "canonical", "parent-corrupt"]) {
    const f = await producerFixture(t);
    const request = structuredClone(f.request);
    if (mode === "request-generation") request.runInstanceId = "replacement";
    if (mode === "child-generation") request.child.runInstanceId = "replacement";
    if (mode === "child-owner") request.child.ownerId = "replacement";
    if (mode === "missing-path") request.child.stateDir = join(f.root, "missing");
    if (mode === "self-path") request.child.stateDir = f.stateDir;
    const delta = mode === "generation" ? { run_instance_id: "replacement" } : mode === "owner" ? { ownerId: "replacement" }
      : mode === "protocol" ? { outcome_protocol: "future" } : mode === "pid" ? { pid: Number(f.meta.pid) + 1 }
      : mode === "digest" ? { process_identity: { platform: process.platform, start_time: "replacement", command: "replacement" } } : {};
    if (Object.keys(delta).length) writeJsonAtomic(join(f.stateDir, "run.json"), { ...f.meta, ...delta });
    if (mode === "marker-missing") rmSync(f.childPath);
    if (mode === "marker-corrupt") writeFileSync(f.childPath, "{unproven");
    if (mode.startsWith("marker-") && !["marker-missing", "marker-corrupt"].includes(mode)) {
      const marker = structuredClone(f.preparation);
      if (mode === "marker-foreign") marker.parent.ownerId = "replacement";
      if (mode === "marker-pid") marker.parent_producer.pid++;
      if (mode === "marker-digest") marker.parent_producer.process_identity_digest = "a".repeat(64) === marker.parent_producer.process_identity_digest ? "b".repeat(64) : "a".repeat(64);
      writeJsonAtomic(f.childPath, marker);
    }
    if (mode === "staged-missing") rmSync(f.stagedPath);
    if (mode === "staged-foreign" || mode === "staged-pid") writeJsonAtomic(f.stagedPath, {
      ...JSON.parse(readFileSync(f.stagedPath, "utf8")), ...(mode === "staged-foreign" ? { run_instance_id: "replacement" } : { pid: 1 }),
    });
    if (mode === "canonical") writeJsonAtomic(join(f.childDir, "run.json"), { run_instance_id: request.child.runInstanceId, pid: 0 });
    if (mode === "parent-corrupt") writeFileSync(f.parentPath, "{unproven");
    const parentBytes = existsSync(f.parentPath) ? readFileSync(f.parentPath, "utf8") : undefined;
    const children = fs.readdirSync(f.childDir).sort();
    const result = recover(f.stateDir, request, noProbe);
    assert.equal(result.status, "rejected", mode);
    assert.equal(existsSync(f.parentPath) ? readFileSync(f.parentPath, "utf8") : undefined, parentBytes);
    assert.deepEqual(fs.readdirSync(f.childDir).sort(), children);
    if (mode === "missing-path") assert.equal(existsSync(request.child.stateDir), false);
  }
});

test("Recovery preserves natural, captured, malformed, and stopping root evidence and its original clock", async (t) => {
  for (const outcome of ["success", "failure", "captured", "bad-stop", "natural-bad-stop", "opaque"]) {
    const f = await producerFixture(t, { outcome });
    if (outcome === "opaque") for (const name of ["result.json", "stop-claim.json", "progress.json", "trace.jsonl", "terminal-handled.json"]) writeFileSync(join(f.stateDir, name), `retained ${name}`);
    const before = protectedBytes(f);
    assert.equal(recover(f.stateDir, f.request).status, "recorded");
    assert.deepEqual(protectedBytes(f), before);
    assert.throws(() => Descendants.assertNoRetainedDescendantLaunchScope(f.stateDir), /scope is unproven/);
  }
});

test("Observation-time changes cannot retarget metadata; an exact already-accepted winner is reused", async (t) => {
  for (const mode of ["generation", "pid", "fingerprint", "marker", "staged", "canonical", "parent-corrupt", "winner"]) {
    const f = await producerFixture(t);
    let probes = 0;
    let winnerBytes: string | undefined;
    const result = recover(f.stateDir, f.request, { probe: (pid: number, signal: number) => {
      probes++;
      assert.equal(pid, f.meta.pid); assert.equal(signal, 0);
      if (mode === "generation" || mode === "pid" || mode === "fingerprint") writeJsonAtomic(join(f.stateDir, "run.json"), {
        ...f.meta, ...(mode === "generation" ? { run_instance_id: "replacement" } : mode === "pid" ? { pid: Number(f.meta.pid) + 1 }
          : { process_identity: { platform: process.platform, start_time: "replacement", command: "replacement" } }),
      });
      if (mode === "marker") writeJsonAtomic(f.childPath, { ...f.preparation, preparation_id: "00000000-0000-4000-8000-000000000001" });
      if (mode === "staged") writeJsonAtomic(f.stagedPath, { ...JSON.parse(readFileSync(f.stagedPath, "utf8")), pid: 1 });
      if (mode === "canonical") writeJsonAtomic(join(f.childDir, "run.json"), { pid: 0 });
      if (mode === "parent-corrupt") writeFileSync(f.parentPath, "{unproven");
      if (mode === "winner") {
        writeJsonAtomic(f.parentPath, { schema: "run-descendant-launches-v1", run: f.meta.run, run_instance_id: f.meta.run_instance_id,
          ownerId: f.meta.ownerId, runner_pid: f.meta.pid, runner_identity_digest: f.preparation.parent_producer.process_identity_digest,
          intents: [{ intent_id: "00000000-0000-4000-8000-000000000002", admitted_at: new Date().toISOString(), child: f.preparation.child,
            preparation: { preparation_id: f.preparation.preparation_id, prepared_at: f.preparation.prepared_at } }] });
        winnerBytes = readFileSync(f.parentPath, "utf8");
      }
      throw Object.assign(Error("captured producer absent"), { code: "ESRCH" });
    } });
    assert.equal(probes, 1);
    if (mode === "winner") {
      assert.equal(result.status, "already_recorded");
      assert.equal(readFileSync(f.parentPath, "utf8"), winnerBytes);
    } else {
      assert.equal(result.status, "rejected", mode);
      if (mode !== "parent-corrupt") assert.equal(existsSync(f.parentPath), false);
    }
  }
});

test("Publication is attempted once per call and a later explicit call makes fresh observations after EIO", async (t) => {
  for (const afterCommit of [false, true]) {
    const f = await producerFixture(t);
    const before = protectedBytes(f);
    const rename = fs.renameSync;
    const refusal = Object.freeze(Object.assign(Error("recovery publication EIO"), { code: "EIO" }));
    let writes = 0, probes = 0;
    const deps = { probe: () => { probes++; throw Object.assign(Error("gone"), { code: "ESRCH" }); } };
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== f.parentPath) return rename(from, to);
      writes++;
      if (afterCommit) rename(from, to);
      throw refusal;
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.throws(() => recover(f.stateDir, f.request, deps), (error) => error === refusal); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(writes, 1);
    assert.equal(probes, 1);
    assert.deepEqual(protectedBytes(f), before);
    const result = recover(f.stateDir, f.request, deps);
    assert.equal(result.status, afterCommit ? "already_recorded" : "recorded");
    assert.equal(probes, afterCommit ? 1 : 2);
  }
});

test("Parent/child lifecycle contention revalidates generation and unpublished metadata before probing native identity", async (t) => {
  for (const mode of ["parent-generation", "child-generation", "canonical"]) {
    const f = await producerFixture(t);
    const held = join(f.root, "held"), blocked = join(f.root, "blocked"), script = join(f.root, "holder.mjs");
    const state = mode === "parent-generation" ? f.stateDir : f.childDir;
    const mutationPath = mode === "parent-generation" ? join(f.stateDir, "run.json") : mode === "child-generation" ? f.stagedPath : join(f.childDir, "run.json");
    const value = mode === "parent-generation" ? { ...f.meta, run_instance_id: "replacement" } : mode === "child-generation"
      ? { ...JSON.parse(readFileSync(f.stagedPath, "utf8")), run_instance_id: "replacement" } : { pid: 0 };
    await writeFile(script, `import {existsSync,writeFileSync} from 'node:fs';
      import {acquireStateStartLock} from ${JSON.stringify(new URL("../lib/runs-start.ts", import.meta.url).href)};
      import {writeJsonAtomic} from ${JSON.stringify(new URL("../lib/file-state.ts", import.meta.url).href)};
      const release=acquireStateStartLock(${JSON.stringify(state)});
      try {writeFileSync(${JSON.stringify(held)},'held');const end=Date.now()+10000;
        while(!existsSync(${JSON.stringify(blocked)})){if(Date.now()>end)throw Error('holder timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
        writeJsonAtomic(${JSON.stringify(mutationPath)},${JSON.stringify(value)});
      } finally {release()}`);
    const peer = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: "ignore" });
    const closed = f.retain(peer);
    await waitFor(held);
    let contentions = 0;
    const result = recover(f.stateDir, f.request, {
      onLockContention: () => {
        contentions++;
        if (mode !== "parent-generation") assert.equal(JSON.parse(readFileSync(join(mutationLockPath(join(f.stateDir, ".lifecycle")), "owner.json"), "utf8")).pid, process.pid);
        writeFileSync(blocked, "blocked");
      },
      probe: () => assert.fail("Changed identity/state reached native observation"),
    });
    assert.equal(result.status, "rejected");
    assert.ok(contentions > 0);
    assert.deepEqual(await closed, [0, null]);
    assert.equal(existsSync(f.parentPath), false);
  }
});

test("Nested release failures preserve the action and first cleanup cause, then quarantine only this runtime's recovery scope", async (t) => {
  for (const throwing of [false, true]) {
    const f = await producerFixture(t);
    const locks = [f.childDir, f.stateDir].map((dir) => mutationLockPath(join(dir, ".lifecycle")));
    const tokens = new Map<string, string>();
    const rename = fs.renameSync, mkdir = fs.mkdirSync;
    const primary = Object.freeze(Object.assign(Error("original recovery publication failure"), { code: "EIO" }));
    let armed = false, releases = 0;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === f.parentPath) {
        for (const path of locks) tokens.set(path, JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token);
        armed = true;
        if (throwing) throw primary;
      }
      return rename(from, to);
    }) as typeof fs.renameSync;
    fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (armed && locks.some((lock) => String(path).startsWith(`${lock}.reclaim.`))) {
        releases++;
        throw Object.assign(Error("recovery release refused"), { code: String(path).startsWith(`${locks[0]}.reclaim.`) ? "ENOSPC" : "EIO" });
      }
      return Reflect.apply(mkdir, fs, [path, ...args]);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    let result: any, error: unknown;
    try {
      try { result = recover(f.stateDir, f.request); } catch (caught) { error = caught; }
      fs.renameSync = rename; fs.mkdirSync = mkdir; syncBuiltinESMExports();
      assert.equal(releases, 2);
      if (throwing) assert.equal(error, primary);
      else {
        assert.equal(error, undefined);
        assert.equal(result.status, "recorded");
        assert.deepEqual(result.cleanup, { status: "release_unproven", error_code: "ENOSPC" });
        assert.equal(Object.isFrozen(result.cleanup), true);
      }
      const again = recover(f.stateDir, JSON.parse(JSON.stringify(f.request)), { probe: () => assert.fail("Quarantined recovery made native observations") });
      assert.equal(again.status, "rejected");
      assert.equal(again.code, "run_descendant_recovery_cleanup_unproven");
      assert.deepEqual(again.cleanup, { status: "release_unproven", error_code: "ENOSPC" });
      assert.equal(existsSync(f.parentPath), !throwing);
    } finally {
      fs.renameSync = rename; fs.mkdirSync = mkdir; syncBuiltinESMExports();
      for (const [path, token] of tokens) if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
        assert.equal(owner.pid, process.pid); assert.equal(owner.token, token);
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
});

});

await describe("Reuse and retirement", { concurrency: false }, async () => {

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-descendant-reuse-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
const capturedRunners = new Set<number>();
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(async () => {
  try {
    // A failed per-case teardown must not let the outer cleanup erase live/unproven producer state.
    for (const pid of capturedRunners) await waitExit(pid);
    rmSync(agentDir, { recursive: true, force: true });
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
    else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  }
});

const { archiveRun, getRunStatus, pruneRun, startRun } = await import("../lib/async-runs.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { readRunDescendantLaunchLedger, RUN_DESCENDANT_LAUNCH_FILE: scopeFile } = await import("../lib/runs-descendant-launches.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { readProcessLiveness, runProcessIdentityDigest } = await import("../lib/runs-process.ts");
const { archiveTerminalRun, pruneTerminalRun } = await import("../lib/runs-retention.ts");
const { acquireStateStartLock, assertNoActiveRunState, prepareStateDirForStart } = await import("../lib/runs-start.ts");
const { readJsonFileResilient } = await import("../lib/state-readers.ts");
const exec = promisify(execFile);
const error = /descendant launch scope is unproven/;
const readJson = (path: string) => readJsonFileResilient<Record<string, unknown> | undefined>(path, undefined).value;

async function fixture(t: TestContext, retained = true) {
  const root = await mkdtemp(join(agentDir, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "parent");
  writeJsonAtomic(join(stateDir, "run.json"), {
    run: "parent", run_instance_id: "parent-generation", ownerId: "parent-owner", state_dir: stateDir,
    pid: 0, createdAt: new Date().toISOString(), outcome_protocol: "run-outcome-v1",
  });
  writeJsonAtomic(join(stateDir, "execution.json"), { run_instance_id: "parent-generation", commands: [] });
  await mkdir(join(stateDir, "captures"));
  // Opaque retained evidence intentionally proves neither a child birth nor a terminal parent.
  if (retained) writeJsonAtomic(join(stateDir, scopeFile), { retained: "unresolved descendant reservation" });
  return { root, stateDir };
}

async function snapshot(stateDir: string) {
  return Promise.all(["run.json", "execution.json", scopeFile].map((name) => readFile(join(stateDir, name), "utf8")));
}

test("Retained descendant reservations fence replacement and retirement before any state mutation", async (t) => {
  const { root, stateDir } = await fixture(t);
  const before = await snapshot(stateDir);
  const status = { run: "parent", state_dir: stateDir, status: "interrupted" };
  const release = acquireStateStartLock(stateDir);
  try {
    for (const action of [
      () => assertNoActiveRunState(stateDir, readJson, "unused"),
      () => prepareStateDirForStart(stateDir, readJson, "unused"),
      () => archiveTerminalRun(status),
      () => pruneTerminalRun(status),
    ]) {
      assert.throws(action, error);
      assert.deepEqual(await snapshot(stateDir), before);
    }
  } finally { release(); }
  assert.equal(existsSync(join(root, "archived")), false);
  assert.equal(existsSync(join(stateDir, "captures")), true);
});

async function waitExit(pid: number) {
  const deadline = Date.now() + 15_000;
  while (readProcessLiveness(pid) !== "dead") {
    if (Date.now() >= deadline) throw Error("Captured fixture runner exit remains unproven");
    await delay(10);
  }
  capturedRunners.delete(pid);
}

test("Exited opt-in producers retain child-plan fences through natural result acceptance and public retirement", async (t) => {
  for (const natural of [false, true]) {
    const { root, stateDir } = await fixture(t, false);
    const url = (name: string) => new URL(`../lib/${name}.ts`, import.meta.url).href;
    await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import {join} from 'node:path';
      import {writeJsonAtomic} from ${JSON.stringify(url("file-state"))};
      import {readProcessIdentity} from ${JSON.stringify(url("runs-process"))};
      import {admitRunResultProducer,publishRunResult,withRunDescendantIntentAdmission} from ${JSON.stringify(url("runs-results"))};
      const stateDir=process.argv[1];
      writeJsonAtomic(join(stateDir,'run.json'),{run:'parent',run_instance_id:'parent-generation',ownerId:'parent-owner',
        state_dir:stateDir,pid:process.pid,process_identity:readProcessIdentity(process.pid),outcome_protocol:'run-outcome-v1'});
      const {producer}=admitRunResultProducer(stateDir);
      const failure=new Error('child birth remains unknown');
      try{withRunDescendantIntentAdmission(stateDir,producer,{run:'child',runInstanceId:'declared-child',ownerId:'other-owner',
        stateDir:process.argv[2]},()=>{throw failure})}catch(error){if(error!==failure)throw error}
      if(${JSON.stringify(natural)})publishRunResult(stateDir,producer,{code:0});
    `, stateDir, join(root, "declared-child")], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") } });
    const meta = readJson(join(stateDir, "run.json"))!;
    assert.equal(readProcessLiveness(Number(meta.pid)), "dead");
    const owner = { run: String(meta.run), runInstanceId: String(meta.run_instance_id), ownerId: String(meta.ownerId),
      pid: Number(meta.pid), processIdentityDigest: runProcessIdentityDigest(meta.process_identity) };
    assert.equal(readRunDescendantLaunchLedger(stateDir, owner).state, "available");
    const before = await snapshot(stateDir);
    const result = natural ? await readFile(join(stateDir, "result.json"), "utf8") : undefined;
    let unexpectedPid: number | undefined;
    try {
      assert.throws(() => { unexpectedPid = startRun({ run_id: "parent", state_dir: stateDir,
        template: `${process.execPath} -e "process.exit(0)"` }, process.cwd()).pid;
        capturedRunners.add(unexpectedPid);
      }, error);
      assert.throws(() => archiveRun(stateDir, { ownerId: owner.ownerId, runInstanceId: owner.runInstanceId }), error);
      assert.throws(() => pruneRun(stateDir), error);
      assert.deepEqual(await snapshot(stateDir), before);
      assert.equal(natural ? await readFile(join(stateDir, "result.json"), "utf8") : existsSync(join(stateDir, "result.json")), result ?? false);
      assert.equal(existsSync(join(root, "archived")), false);
      const records = (await readFile(join(root, "retention.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(records.some((record) => record.outcome === "handled"), false);
    } finally { if (unexpectedPid) await waitExit(unexpectedPid); }
  }
});

test("Nonregular, corrupt, foreign, and empty child-plan paths all retain the mutation fence", async (t) => {
  const kinds = ["directory", "corrupt", "foreign", "empty", ...(process.platform === "win32" ? [] : ["symlink", "dangling"])];
  for (const kind of kinds) {
    const { root, stateDir } = await fixture(t);
    const path = join(stateDir, scopeFile);
    const before = await Promise.all(["run.json", "execution.json"].map((file) => readFile(join(stateDir, file), "utf8")));
    await rm(path);
    const target = join(root, "private-target");
    await writeFile(target, "private evidence");
    if (kind === "directory") await mkdir(path);
    else if (kind === "symlink" || kind === "dangling") await symlink(kind === "symlink" ? target : join(root, "missing"), path);
    else await writeFile(path, kind === "corrupt" ? "{unproven" : kind === "empty" ? "" : JSON.stringify({ run_instance_id: "foreign" }));
    const status = getRunStatus(stateDir);
    for (const action of [
      () => assertNoActiveRunState(stateDir, readJson, "unused"),
      () => prepareStateDirForStart(stateDir, readJson, "unused"),
      () => archiveTerminalRun(status),
      () => pruneTerminalRun(status),
    ]) assert.throws(action, error);
    assert.deepEqual(await Promise.all(["run.json", "execution.json"].map((file) => readFile(join(stateDir, file), "utf8"))), before);
    assert.equal(await readFile(target, "utf8"), "private evidence");
    assert.equal(existsSync(join(root, "archived")), false);
  }
});

test("Unavailable child-plan presence evidence fails closed before mutation", async (t) => {
  const { root, stateDir } = await fixture(t, false);
  const path = join(stateDir, scopeFile);
  const before = await Promise.all(["run.json", "execution.json"].map((file) => readFile(join(stateDir, file), "utf8")));
  const lstat = fs.lstatSync;
  fs.lstatSync = ((candidate: fs.PathLike, ...args: unknown[]) => {
    if (String(candidate) === path) throw Object.assign(new Error("presence denied"), { code: "EACCES" });
    return Reflect.apply(lstat, fs, [candidate, ...args]);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    const status = { run: "parent", state_dir: stateDir, status: "interrupted" };
    for (const action of [
      () => assertNoActiveRunState(stateDir, readJson, "unused"),
      () => prepareStateDirForStart(stateDir, readJson, "unused"),
      () => archiveTerminalRun(status),
      () => pruneTerminalRun(status),
    ]) assert.throws(action, error);
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.deepEqual(await Promise.all(["run.json", "execution.json"].map((file) => readFile(join(stateDir, file), "utf8"))), before);
  assert.equal(existsSync(join(root, "archived")), false);
});

test("Live singleton attachment preserves its generation/clock and retained child plan, but replacement after exit refuses", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(agentDir, "singleton-"));
  const skill = join(root, "child-scope-singleton");
  const file = join(skill, "recipes", "worker.json");
  const script = join(root, "gate.cjs");
  const ready = join(root, "ready");
  const go = join(root, "go");
  const stateDir = join(root, "state");
  const pids = new Set<number>();
  t.after(async () => {
    await writeFile(go, "go");
    for (const pid of pids) await waitExit(pid);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(skill, "recipes"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: child-scope-singleton\ndescription: Child scope singleton fixture.\n---\n");
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');
    const end=Date.now()+10000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(timer);process.exit(0)}},10);`);
  await writeFile(file, JSON.stringify({ async: true, singleton: true, template: `${process.execPath} ${script}` }));
  const launch = () => {
    const run = startRun({ file, state_dir: stateDir, ownerId: "singleton-owner" }, process.cwd());
    pids.add(run.pid);
    capturedRunners.add(run.pid);
    return run;
  };
  const first = launch();
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw Error("Singleton fixture handshake timed out");
    await delay(10);
  }
  const release = acquireStateStartLock(stateDir);
  try {
    // Simulated retained plan, not production child admission or membership evidence.
    writeJsonAtomic(join(stateDir, scopeFile), { schema: "run-descendant-launches-v1", run: first.run,
      run_instance_id: first.run_instance_id, ownerId: first.ownerId, runner_pid: first.pid,
      runner_identity_digest: runProcessIdentityDigest(first.process_identity) ?? null,
      intents: [{ intent_id: randomUUID(), admitted_at: new Date().toISOString(),
        child: { run: "child", run_instance_id: "declared-child", ownerId: "another-owner", state_dir: join(root, "declared-child") } }] });
  } finally { release(); }
  const before = await readFile(join(stateDir, "run.json"), "utf8");
  const journal = await readFile(join(stateDir, scopeFile), "utf8");
  const reused = launch();
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.run_instance_id, first.run_instance_id);
  assert.equal(reused.started_at, first.started_at);
  assert.deepEqual(reused.supervision, first.supervision);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), before);
  assert.equal(await readFile(join(stateDir, scopeFile), "utf8"), journal);
  await writeFile(go, "go");
  await waitExit(first.pid);
  assert.throws(launch, error);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), before);
  assert.equal(await readFile(join(stateDir, scopeFile), "utf8"), journal);
});

});
