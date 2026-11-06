/** Mirrors lib/runs-native-launches.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
  execFile,
} from "node:child_process";
import {
  once,
} from "node:events";
import fs from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  syncBuiltinESMExports,
} from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import test from "node:test";
import {
  type TestContext,
  describe,
} from "node:test";
import {
  mutationLockPath,
  writeJsonAtomic,
} from "../lib/file-state.ts";
import * as Control from "../lib/runs-control.ts";
import {
  claimRunStop,
} from "../lib/runs-control.ts";
import {
  RUN_NATIVE_LAUNCH_FILE,
  readRunNativeLaunchLedger,
  assertNoRetainedNativeLaunchScope,
  type RunNativeLaunchIntent,
} from "../lib/runs-native-launches.ts";
import {
  RUN_OUTCOME_PROTOCOL,
} from "../lib/runs-outcomes.ts";
import {
  claimRunStateDirectory,
} from "../lib/runs-ownership.ts";
import {
  readProcessIdentity,
  captureSpawnedNativeProcessIdentity,
  type SpawnIdentityCaptureDeps,
  readProcessLiveness,
  runProcessIdentityDigest,
  type RunProcessExitDeps,
} from "../lib/runs-process.ts";
import * as ProducerRuntime from "../lib/runs-results.ts";
import * as Producers from "../lib/runs-results.ts";
import {
  admitRunResultProducer,
  publishRunResult,
  withRunNativeLaunchAdmission,
} from "../lib/runs-results.ts";
import {
  randomUUID,
} from "node:crypto";
import {
  execCommandTemplate,
  readPendingCommandSpawnAdmission,
  requireFreshManagedCommandAttempt,
  type CommandTemplateManagedAttempt,
  type CommandTemplateAttemptReceipt,
} from "../lib/command-templates.ts";
import {
  setTimeout as delay,
} from "node:timers/promises";
import {
  promisify,
} from "node:util";
import {
  archiveRun,
  getRunStatus,
  pruneRun,
  startRun,
} from "../lib/async-runs.ts";
import {
  archiveTerminalRun,
  pruneTerminalRun,
} from "../lib/runs-retention.ts";
import {
  acquireStateStartLock,
  assertNoActiveRunState,
  prepareStateDirForStart,
} from "../lib/runs-start.ts";
import {
  readJsonFileResilient,
} from "../lib/state-readers.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Intent admission", { concurrency: false }, async () => {


async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-native-intent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "native");
  const meta = {
    run: "native", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir,
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL,
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const producer = admitRunResultProducer(stateDir).producer;
  return { root, stateDir, meta, producer, path: join(stateDir, RUN_NATIVE_LAUNCH_FILE) };
}

function retainedChild(t: TestContext): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},100)"], { stdio: "ignore" });
  const exit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  });
  return child;
}

function observedExit(child: ChildProcess): Promise<unknown[]> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, "exit");
}

const request = { commandId: "command-001", attempt: 1 };

test("Native factory runs only after immutable generation-bound intent is retained under lifecycle admission", async (t) => {
  const { stateDir, producer, path } = await fixture(t);
  assert.deepEqual(readRunNativeLaunchLedger(stateDir, producer), { state: "absent" });
  assert.equal(existsSync(path), false);
  const child = withRunNativeLaunchAdmission(stateDir, producer, request, (intent) => {
    assert.equal(Object.isFrozen(intent), true);
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
    const stored = readRunNativeLaunchLedger(stateDir, producer);
    assert.equal(stored.state, "available");
    if (stored.state !== "available") throw Error("Expected retained native intent");
    assert.deepEqual(stored.ledger.intents, [intent]);
    assert.equal(stored.ledger.run_instance_id, producer.runInstanceId);
    assert.equal(stored.ledger.ownerId, producer.ownerId);
    assert.equal(stored.ledger.runner_pid, process.pid);
    assert.equal(Object.isFrozen(stored.ledger.intents), true);
    assert.equal(Object.hasOwn(intent, "pid"), false);
    assert.equal(Object.hasOwn(stored.ledger, "complete"), false);
    return retainedChild(t);
  });
  assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  assert.deepEqual(await observedExit(child), [0, null]);
  assert.equal(JSON.parse(await readFile(path, "utf8")).intents.length, 1);
  assert.equal(existsSync(join(stateDir, "result.json")), false);
});

test("A throwing factory cannot erase an intent or prove that no native child was born", async (t) => {
  const { stateDir, producer, path } = await fixture(t);
  const original = Object.freeze(new Error("factory interrupted after spawn"));
  let child: ChildProcess | undefined;
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => {
    child = retainedChild(t);
    throw original;
  }), (error) => error === original);
  assert.ok(child?.pid);
  const bytes = await readFile(path, "utf8");
  assert.equal(JSON.parse(bytes).intents.length, 1);
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => assert.fail("Duplicate factory ran")), /duplicate or out of order/);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  assert.deepEqual(await observedExit(child), [0, null]);
});

test("Release I/O failure preserves returning and throwing factories with separate stranded-lock diagnostics", async (t) => {
  for (const mode of ["return", "throw"]) {
    const { stateDir, producer, path } = await fixture(t);
    const lockPath = mutationLockPath(join(stateDir, ".lifecycle"));
    const mkdir = fs.mkdirSync;
    const primary = Object.freeze(new Error("original native factory failure"));
    let inject = false;
    let token: string | undefined;
    let child: ChildProcess | undefined;
    let value: ChildProcess | undefined;
    let observed: unknown;
    fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (inject && String(path).startsWith(`${lockPath}.reclaim.`)) {
        throw Object.assign(new Error("injected cleanup EIO"), { code: "EIO" });
      }
      return Reflect.apply(mkdir, fs, [path, ...args]);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    try {
      try {
        value = withRunNativeLaunchAdmission(stateDir, producer, request, () => {
          token = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token;
          child = retainedChild(t);
          inject = true;
          if (mode === "throw") throw primary;
          return child;
        });
      } catch (error) { observed = error; }
      finally { fs.mkdirSync = mkdir; syncBuiltinESMExports(); }
      if (mode === "return") {
        assert.equal(observed, undefined);
        assert.equal(value, child);
      } else assert.equal(observed, primary);
      assert.ok(child?.pid);
      assert.equal(existsSync(lockPath), true);
      const cleanup = ProducerRuntime.readRunProducerCleanupFailure(producer);
      assert.equal(cleanup?.status, "release_unproven");
      assert.equal(cleanup?.error_code, "EIO");
      assert.equal(Object.isFrozen(cleanup), true);
      const bytes = await readFile(path, "utf8");
      assert.equal(JSON.parse(bytes).intents.length, 1);
      assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, { ...request, attempt: 2 }, () => assert.fail("Stranded owner admitted work")), /cleanup remains unproven/);
      assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }), /cleanup remains unproven/);
      assert.equal(await readFile(path, "utf8"), bytes);
      assert.equal(existsSync(join(stateDir, "result.json")), false);
    } finally {
      fs.mkdirSync = mkdir; syncBuiltinESMExports();
      if (token && existsSync(lockPath)) {
        const held = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
        assert.equal(held.token, token);
        assert.equal(held.pid, process.pid);
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
      if (child) await observedExit(child);
    }
  }
});

test("Stop and accepted terminal results reject launch admission before any native receipt or factory", async (t) => {
  for (const stop of [false, true]) {
    const { stateDir, producer, path } = await fixture(t);
    if (stop) {
      assert.equal(claimRunStop(stateDir, { runInstanceId: producer.runInstanceId, ownerId: producer.ownerId, reason: "manual_kill" }, {
        verifyIdentity: () => ({ status: "valid", valid: true }),
      }).status, "stop_requested");
    } else publishRunResult(stateDir, producer, { code: 0 });
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => assert.fail("Closed work factory ran")), /stopping or unproven|terminal or unproven/);
    assert.equal(existsSync(path), false);
  }
});

test("Ledger corruption and persistence failure remain outside the native factory", async (t) => {
  for (const kind of ["malformed", "directory", "foreign"]) {
    const { stateDir, producer, path } = await fixture(t);
    if (kind === "directory") await mkdir(path);
    else if (kind === "malformed") writeFileSync(path, "{unproven");
    else writeJsonAtomic(path, { schema: "run-native-launches-v1", run: producer.run, run_instance_id: "foreign", intents: [] });
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => assert.fail("Unretained work ran")), /native launch evidence is unavailable or invalid/);
    assert.equal(readRunNativeLaunchLedger(stateDir, producer).state, "invalid");
    if (kind !== "directory") assert.equal(readFileSync(path, "utf8").includes(kind === "malformed" ? "{unproven" : "foreign"), true);
  }
});

test("An actual intent write failure never releases the native factory", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { stateDir, producer, path } = await fixture(t);
  await chmod(stateDir, 0o500);
  let factories = 0;
  try {
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => { factories++; return retainedChild(t); }),
      (error) => ["EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code)));
    assert.equal(factories, 0);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  } finally { await chmod(stateDir, 0o700); }
});

test("Forged or replaced producer authority cannot append or replace native intents", async (t) => {
  const { stateDir, producer, meta, path } = await fixture(t);
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, { ...producer }, request, () => assert.fail("Forged factory ran")), /admitted by this runtime/);
  assert.equal(existsSync(path), false);
  const child = withRunNativeLaunchAdmission(stateDir, producer, request, () => retainedChild(t));
  await observedExit(child);
  const bytes = await readFile(path, "utf8");
  for (const [delta, expected] of [
    [{ run_instance_id: "generation-b" }, /generation changed/],
    [{ ownerId: "owner-b" }, /owner changed/],
    [{ pid: process.pid + 1 }, /process changed/],
    [{ process_identity: { platform: "linux", start_time: "other", command: "other" } }, /process identity changed/],
  ] as const) {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, ...delta });
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, { ...request, attempt: 2 }, () => assert.fail("Stale factory ran")), expected);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
  assert.equal(readRunNativeLaunchLedger(stateDir, { ...producer, runInstanceId: "generation-b" }).state, "invalid");
});

test("Native intent ordering is per command, strictly positive and never silently repaired", async (t) => {
  const { stateDir, producer, path } = await fixture(t);
  const noSpawn = Object.freeze(new Error("Retain admission without pretending birth"));
  const admit = (commandId: string, attempt: number) => assert.throws(
    () => withRunNativeLaunchAdmission(stateDir, producer, { commandId, attempt }, () => { throw noSpawn; }),
    (error) => error === noSpawn,
  );
  for (const value of [{ commandId: "command-001\n", attempt: 1 }, { commandId: "command-001", attempt: 0 }, { commandId: "command-001", attempt: 1.1 }]) {
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, value, () => assert.fail("Invalid request ran")), /identity or request is invalid/);
  }
  assert.equal(existsSync(path), false);
  admit("command-001", 1); admit("command-002", 1); admit("command-001", 2);
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, { commandId: "command-001", attempt: 4 }, () => assert.fail("Skipped attempt ran")), /duplicate or out of order/);
  const bytes = await readFile(path, "utf8");
  const ledger = JSON.parse(bytes);
  assert.deepEqual(ledger.intents.map((item: { command_id: string; attempt: number }) => [item.command_id, item.attempt]), [["command-001", 1], ["command-002", 1], ["command-001", 2]]);
  ledger.intents[2].attempt = 1;
  writeJsonAtomic(path, ledger);
  assert.equal(readRunNativeLaunchLedger(stateDir, producer).state, "invalid");
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, { ...request, attempt: 3 }, () => assert.fail("Corrupt ledger reset")), /unavailable or invalid/);
});

test("A malformed persisted intent UUID is rejected without rewriting retained evidence", async (t) => {
  const { stateDir, producer, path } = await fixture(t);
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => { throw Error("retained"); }), /retained/);
  const ledger = JSON.parse(await readFile(path, "utf8"));
  ledger.intents[0].intent_id = "not-a-uuid";
  writeJsonAtomic(path, ledger);
  const bytes = await readFile(path, "utf8");
  assert.equal(readRunNativeLaunchLedger(stateDir, producer).state, "invalid");
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, { ...request, attempt: 2 }, () => assert.fail("Malformed UUID admitted work")), /unavailable or invalid/);
  assert.equal(await readFile(path, "utf8"), bytes);
});

test("Unknown persisted fields cannot be dropped by a subsequent intent append", async (t) => {
  for (const location of ["ledger", "intent"]) {
    const { stateDir, producer, path } = await fixture(t);
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => { throw Error("intent retained"); }), /intent retained/);
    const ledger = JSON.parse(await readFile(path, "utf8"));
    (location === "ledger" ? ledger : ledger.intents[0]).future_birth_evidence = { pid: 12345 };
    writeJsonAtomic(path, ledger);
    const bytes = await readFile(path, "utf8");
    assert.equal(readRunNativeLaunchLedger(stateDir, producer).state, "invalid");
    assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, { ...request, attempt: 2 }, () => assert.fail("Unknown evidence was erased")), /unavailable or invalid/);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

test("A symlink ledger is rejected without touching its target", { skip: process.platform === "win32" }, async (t) => {
  const { root, stateDir, producer, path } = await fixture(t);
  const target = join(root, "target");
  writeFileSync(target, "private target");
  await symlink(target, path);
  assert.equal(readRunNativeLaunchLedger(stateDir, producer).state, "invalid");
  assert.throws(() => withRunNativeLaunchAdmission(stateDir, producer, request, () => assert.fail("Symlink allowed native launch")), /unavailable or invalid/);
  assert.equal(await readFile(target, "utf8"), "private target");
});

});

await describe("Birth binding", { concurrency: false }, async () => {


async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-native-birth-"));
  const children = new Map<ChildProcess, Promise<void>>();
  t.after(async () => {
    for (const [child, closed] of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const stateDir = claimRunStateDirectory(join(root, "state"), "birth");
  const meta = {
    run: "birth", state_dir: stateDir, run_instance_id: "generation-a", ownerId: "owner-a",
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL,
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const producer = Producers.admitRunResultProducer(stateDir).producer;
  const go = join(root, "go");
  const script = join(root, "native.cjs");
  await writeFile(script, `const fs=require('node:fs');console.log('managed native output');
    const end=Date.now()+10000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(t);process.exit(7)}},5)`);
  const retain = (process: ChildProcess) => {
    if (!children.has(process)) children.set(process, new Promise((resolve) => process.once("close", () => resolve())));
    return process;
  };
  return { root, stateDir, meta, producer, go, script, retain, path: join(stateDir, RUN_NATIVE_LAUNCH_FILE) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = { commandId: "command-001", attempt: 1 };
function launch(f: Fixture, observe: (context: CommandTemplateManagedAttempt, intent: Readonly<RunNativeLaunchIntent>) => void) {
  let intent: Readonly<RunNativeLaunchIntent>;
  return execCommandTemplate(process.execPath, [f.script], {
    cwd: f.root, captureDir: join(f.stateDir, "captures"),
    admitSpawn: (start) => Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, request, (value) => { intent = value; return start(); }),
    onAttemptManaged: (context) => {
      f.retain(context.process);
      try { observe(context, intent!); } finally { writeFileSync(f.go, "go"); }
    },
  });
}

test("A live managed native birth is retained with exact admission/generation before its callback returns", async (t) => {
  const f = await fixture(t);
  let context: CommandTemplateManagedAttempt | undefined;
  let admission: Readonly<RunNativeLaunchIntent> | undefined;
  const result = await launch(f, (value, intent) => {
    context = value; admission = intent;
    assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), true);
    assert.equal(readPendingCommandSpawnAdmission(), undefined);
    assert.equal(requireFreshManagedCommandAttempt(value), value);
    assert.throws(() => requireFreshManagedCommandAttempt({ ...value }), /fresh managed attempt/);
    const birth = Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, value);
    const ledger = JSON.parse(readFileSync(f.path, "utf8"));
    assert.equal(ledger.run_instance_id, f.producer.runInstanceId);
    assert.equal(ledger.intents[0].birth?.pid, value.process.pid);
    assert.deepEqual(ledger.intents[0].birth.process_identity, readProcessIdentity(value.process.pid!));
    assert.equal(Object.isFrozen(birth), true);
    assert.equal(Object.isFrozen(birth.process_identity), true);
    const bytes = readFileSync(f.path, "utf8");
    assert.throws(() => Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, value), /active runtime-local launch admission/);
    assert.equal(readFileSync(f.path, "utf8"), bytes);
  });
  assert.equal(result.code, 7);
  assert.ok(context && admission);
  assert.throws(() => requireFreshManagedCommandAttempt(context!), /fresh managed attempt/);
  assert.throws(() => Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, admission!, context!), /active runtime-local launch admission/);
  const ledger = readRunNativeLaunchLedger(f.stateDir, f.producer);
  assert.equal(ledger.state, "available");
  if (ledger.state !== "available") throw Error("Expected native birth");
  assert.equal(Object.isFrozen(ledger.ledger.intents[0]!.birth!.process_identity), true);
  Producers.publishRunResult(f.stateDir, f.producer, { code: 7 });
  assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
});

test("Copied authorities and replaced owner/generation cannot bind a native birth", async (t) => {
  for (const mode of ["producer", "intent", "context", "generation", "owner", "fingerprint"]) {
    const f = await fixture(t);
    let before = "";
    await assert.rejects(() => launch(f, (context, intent) => {
      before = readFileSync(f.path, "utf8");
      if (["generation", "owner", "fingerprint"].includes(mode)) {
        writeJsonAtomic(join(f.stateDir, "run.json"), { ...f.meta,
          ...(mode === "generation" ? { run_instance_id: "replacement" } : mode === "owner" ? { ownerId: "replacement" }
            : { process_identity: { platform: "linux", command: "changed", start_time: "changed" } }),
        });
      }
      Producers.bindRunNativeLaunchProcess(f.stateDir, mode === "producer" ? { ...f.producer } : f.producer,
        mode === "intent" ? { ...intent } : intent,
        mode === "context" ? { ...context } : context);
    }), /runtime-local launch admission|fresh managed attempt|generation changed|owner changed|process identity changed/);
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.equal(JSON.parse(before).intents[0].birth, undefined);
  }
});

test("A real nested managed process cannot be substituted for the admitted native factory", async (t) => {
  const f = await fixture(t);
  let nested: Promise<unknown> | undefined;
  const result = await launch(f, (_context, intent) => {
    nested = execCommandTemplate(process.execPath, [f.script], {
      onAttemptManaged: (other) => { f.retain(other.process); Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, other); },
    }).then(() => assert.fail("A different native factory was bound"), (error) => error);
  });
  assert.equal(result.code, 7);
  assert.match(String(await nested), /fresh managed attempt/);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents[0].birth, undefined);
});

test("An already-born process cannot acquire a retroactive intent or reuse one spawn-admission ticket", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => execCommandTemplate(process.execPath, [f.script], {
    onAttemptManaged: (context) => {
      f.retain(context.process);
      try {
        Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, request, (intent) => {
          Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, context);
          return context.process;
        });
      } finally { writeFileSync(f.go, "go"); }
    },
  }), /active runtime-local launch admission/);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents[0].birth, undefined);
  const next = await fixture(t);
  const original = new Error("unused native intent");
  await assert.rejects(() => execCommandTemplate(process.execPath, [], {
    admitSpawn: () => {
      assert.throws(() => Producers.withRunNativeLaunchAdmission(next.stateDir, next.producer, request, () => { throw original; }), (error) => error === original);
      return Producers.withRunNativeLaunchAdmission(next.stateDir, next.producer, { commandId: "command-002", attempt: 1 }, () => assert.fail("Ticket reused"));
    },
  }), /spawn admission was already claimed/);
  assert.equal(JSON.parse(readFileSync(next.path, "utf8")).intents.length, 1);
});

test("A missing native PID and a genuine attempt-ordinal mismatch retain only unresolved intent", async (t) => {
  const missing = await fixture(t);
  let intent: Readonly<RunNativeLaunchIntent>;
  await assert.rejects(() => execCommandTemplate(join(missing.root, "missing-executable"), [], {
    admitSpawn: (start) => Producers.withRunNativeLaunchAdmission(missing.stateDir, missing.producer, request, (value) => { intent = value; return start(); }),
    onAttemptManaged: (context) => {
      assert.equal(context.process.pid, undefined);
      Producers.bindRunNativeLaunchProcess(missing.stateDir, missing.producer, intent!, context, { readIdentity: () => assert.fail("Missing PID probed") });
    },
    onAttemptComplete: (receipt) => assert.equal(Object.hasOwn(receipt, "nativeExitCode"), false),
  }), /process proof is unavailable/);
  assert.equal(JSON.parse(readFileSync(missing.path, "utf8")).intents[0].birth, undefined);
  const ordinal = await fixture(t);
  assert.throws(() => Producers.withRunNativeLaunchAdmission(ordinal.stateDir, ordinal.producer, request, () => { throw Error("earlier intent"); }), /earlier intent/);
  await assert.rejects(() => execCommandTemplate(process.execPath, [ordinal.script], {
    admitSpawn: (start) => Producers.withRunNativeLaunchAdmission(ordinal.stateDir, ordinal.producer, { ...request, attempt: 2 }, (value) => { intent = value; return start(); }),
    onAttemptManaged: (context) => {
      ordinal.retain(context.process);
      try { Producers.bindRunNativeLaunchProcess(ordinal.stateDir, ordinal.producer, intent!, context); }
      finally { writeFileSync(ordinal.go, "go"); }
    },
  }), /managed attempt changed/);
  assert.equal(JSON.parse(readFileSync(ordinal.path, "utf8")).intents.every((entry: RunNativeLaunchIntent) => !entry.birth), true);
});

test("Native proof uncertainty and contradictions stay intent-only and cannot be retried into authority", async (t) => {
  for (const kind of ["unsupported", "absent", "changed_birth", "changed_platform"]) {
    const f = await fixture(t);
    let reads = 0;
    const deps: SpawnIdentityCaptureDeps = {
      runtimePlatform: kind === "unsupported" ? "freebsd" : "linux", now: () => 0, wait: () => {},
      readIdentity: () => {
        reads++;
        if (kind === "absent") return undefined;
        return { platform: kind === "changed_platform" ? "win32" : "linux", start_time: reads === 1 ? "birth-a" : "birth-b", command: reads === 1 ? "" : "native" };
      },
    };
    await assert.rejects(() => launch(f, (context, intent) => {
      const before = readFileSync(f.path, "utf8");
      assert.throws(() => Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, context, deps), /process proof is unavailable/);
      const count = reads;
      assert.throws(() => Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, context, { readIdentity: () => assert.fail("Native contradiction retried") }), /active runtime-local launch admission/);
      assert.equal(reads, count);
      assert.equal(readFileSync(f.path, "utf8"), before);
      throw new Error("observed native proof remained unproven");
    }), /remained unproven/);
    assert.equal(reads, kind === "unsupported" ? 0 : kind === "absent" ? 101 : kind === "changed_birth" ? 2 : 1);
  }
});

test("Birth persistence failure retains the exact managed child, captures, and intent without a fabricated receipt", async (t) => {
  const f = await fixture(t);
  const primary = Object.freeze(Object.assign(new Error("injected native birth EIO"), { code: "EIO" }));
  const rename = fs.renameSync;
  let before = "";
  let actual: ChildProcess | undefined;
  let returned: ChildProcess | undefined;
  let intent: Readonly<RunNativeLaunchIntent>;
  await assert.rejects(() => execCommandTemplate(process.execPath, [f.script], {
    captureDir: join(f.stateDir, "captures"),
    admitSpawn: (start) => {
      returned = Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, request, (value) => { intent = value; return start(); });
      return returned;
    },
    onAttemptManaged: (context) => {
      actual = f.retain(context.process);
      before = readFileSync(f.path, "utf8");
      fs.renameSync = ((from, to) => { if (String(to) === f.path) throw primary; return rename(from, to); }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      try { Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent!, context); }
      finally { fs.renameSync = rename; syncBuiltinESMExports(); writeFileSync(f.go, "go"); }
    },
    onAttemptComplete: (receipt) => { assert.equal(receipt.nativeExitCode, 7); assert.match(receipt.result.stdout, /managed native output/); },
  }), (error) => error === primary);
  assert.equal(returned, actual);
  assert.equal(readFileSync(f.path, "utf8"), before);
  assert.equal(JSON.parse(before).intents[0].birth, undefined);
});

test("Malformed, duplicate, and unknown birth evidence fails closed without a lossy append", async (t) => {
  const f = await fixture(t);
  await launch(f, (context, intent) => { Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, context); });
  const original = JSON.parse(readFileSync(f.path, "utf8"));
  for (const kind of ["pid", "self", "time", "platform", "empty", "unknown", "duplicate"]) {
    const data = structuredClone(original);
    const birth = data.intents[0].birth;
    if (kind === "pid") birth.pid = 0;
    if (kind === "self") birth.pid = process.pid;
    if (kind === "time") birth.observed_at = "tomorrow";
    if (kind === "platform") birth.process_identity.platform = "freebsd";
    if (kind === "empty") birth.process_identity.start_time = "";
    if (kind === "unknown") birth.process_identity.future_proof = true;
    if (kind === "duplicate") data.intents.push({ ...data.intents[0], intent_id: randomUUID(), command_id: "command-002" });
    writeJsonAtomic(f.path, data);
    const bytes = readFileSync(f.path, "utf8");
    assert.equal(readRunNativeLaunchLedger(f.stateDir, f.producer).state, "invalid");
    assert.throws(() => Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, { ...request, attempt: 2 }, () => assert.fail("Corrupt birth erased")), /unavailable or invalid/);
    assert.equal(readFileSync(f.path, "utf8"), bytes);
    assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
  }
});

test("Appending a later intent preserves the immutable native birth but grants no scope closure", async (t) => {
  const f = await fixture(t);
  await launch(f, (context, intent) => { Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent, context); });
  const birth = JSON.parse(readFileSync(f.path, "utf8")).intents[0].birth;
  assert.throws(() => Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, { ...request, attempt: 2 }, () => { throw Error("retained next intent"); }), /retained next intent/);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).intents[0].birth, birth);
  assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
});

test("Native acquisition accepts supported observed identities without runner argv and rejects handle changes", () => {
  for (const runtimePlatform of ["linux", "darwin", "win32"] as const) {
    const child = { pid: 424242, exitCode: null, signalCode: null };
    const identity = { platform: runtimePlatform, command: "native leaf", start_time: "native-birth" };
    assert.deepEqual(captureSpawnedNativeProcessIdentity(child, { runtimePlatform, readIdentity: () => identity }), identity);
    assert.equal(captureSpawnedNativeProcessIdentity(child, {
      runtimePlatform, readIdentity: () => { child.pid++; return identity; },
    }), undefined);
  }
});

});

await describe("Settlement", { concurrency: false }, async () => {


async function fixture(t: TestContext, signal = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-native-settlement-"));
  const children = new Map<ChildProcess, Promise<void>>();
  t.after(async () => {
    for (const [child, closed] of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const stateDir = claimRunStateDirectory(join(root, "state"), "settlement");
  const meta = {
    run: "settlement", state_dir: stateDir, run_instance_id: "generation-a", ownerId: "owner-a",
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL,
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const producer = Producers.admitRunResultProducer(stateDir).producer;
  const go = join(root, "go");
  const script = join(root, "native.cjs");
  await writeFile(script, `const fs=require('node:fs');console.log('native settlement output');
    const end=Date.now()+10000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(t);${signal ? "process.kill(process.pid,'SIGTERM')" : "process.exit(7)"}}},5)`);
  const retain = (child: ChildProcess) => {
    children.set(child, new Promise((resolve) => child.once("close", () => resolve())));
  };
  return { root, stateDir, meta, producer, go, script, retain, path: join(stateDir, RUN_NATIVE_LAUNCH_FILE) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = { commandId: "command-001", attempt: 1 };
function launch(f: Fixture, complete: (intent: Readonly<RunNativeLaunchIntent>, receipt: CommandTemplateAttemptReceipt) => void,
  hooks: { managed?: (context: CommandTemplateManagedAttempt, intent: Readonly<RunNativeLaunchIntent>) => void; admitted?: () => void } = {}) {
  let intent: Readonly<RunNativeLaunchIntent>;
  return execCommandTemplate(process.execPath, [f.script], {
    retry: 3, captureDir: join(f.stateDir, "captures"),
    admitSpawn: (start) => {
      const child = Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, request, (value) => { intent = value; return start(); });
      try { hooks.admitted?.(); } finally { writeFileSync(f.go, "go"); }
      return child;
    },
    onAttemptManaged: (context) => { f.retain(context.process); Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, intent!, context); hooks.managed?.(context, intent!); },
    onAttemptComplete: (receipt) => complete(intent!, receipt),
  });
}

function retain(f: Fixture, intent: Readonly<RunNativeLaunchIntent>, receipt: CommandTemplateAttemptReceipt) {
  return Producers.recordRunNativeLaunchSettlement(f.stateDir, f.producer, intent, receipt);
}

test("The exact native close persists immutable member settlement before command completion, never scope closure", async (t) => {
  const f = await fixture(t);
  let receipt: CommandTemplateAttemptReceipt | undefined;
  let bound: Readonly<RunNativeLaunchIntent> | undefined;
  // Reject after the observed failed workload so an authored retry does not create another test launch.
  const stopRetry = new Error("observed native settlement");
  await assert.rejects(() => launch(f, (intent, value) => {
    receipt = value; bound = intent;
    assert.equal(value.nativeExitCode, 7);
    assert.equal(value.nativeSignal, null);
    const settlement = retain(f, intent, value);
    assert.equal(Object.isFrozen(settlement), true);
    const stored = JSON.parse(readFileSync(f.path, "utf8"));
    assert.equal(stored.intents[0].settlement.native_exit_code, 7);
    assert.equal(stored.intents[0].settlement.native_signal, null);
    assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
    const bytes = readFileSync(f.path, "utf8");
    assert.throws(() => retain(f, intent, value), /runtime-local bound member/);
    assert.equal(readFileSync(f.path, "utf8"), bytes);
    throw stopRetry;
  }), (error) => error === stopRetry);
  assert.ok(receipt && bound);
  assert.throws(() => retain(f, bound!, receipt!), /runtime-local bound member/);
  assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
  const read = readRunNativeLaunchLedger(f.stateDir, f.producer);
  assert.equal(read.state, "available");
  if (read.state === "available") assert.equal(Object.isFrozen(read.ledger.intents[0]!.settlement), true);
});

test("A native signal is never normalized to success and remains an observed signal rather than exit code zero", { skip: process.platform === "win32" }, async (t) => {
  const plain = await execCommandTemplate(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"]);
  assert.notEqual(plain.code, 0);
  assert.equal(plain.killed, false);
  const f = await fixture(t, true);
  const observed = new Error("native signal observed");
  await assert.rejects(() => launch(f, (intent, receipt) => {
    assert.equal(receipt.nativeExitCode, null);
    assert.equal(receipt.nativeSignal, "SIGTERM");
    const settlement = retain(f, intent, receipt);
    assert.equal(settlement.native_exit_code, null);
    assert.equal(settlement.native_signal, "SIGTERM");
    assert.notEqual(receipt.result.code, 0);
    throw observed;
  }), (error) => error === observed);
});

test("Copied authorities and expired receipts cannot reconstruct settlement permission", async (t) => {
  for (const mode of ["receipt", "intent", "producer", "late"]) {
    const f = await fixture(t);
    let original: CommandTemplateAttemptReceipt | undefined;
    let bound: Readonly<RunNativeLaunchIntent> | undefined;
    let bytes = "";
    const observed = new Error("deferred observation");
    await assert.rejects(() => launch(f, (intent, receipt) => {
      original = receipt; bound = intent; bytes = readFileSync(f.path, "utf8");
      if (mode === "late") throw observed;
      Producers.recordRunNativeLaunchSettlement(f.stateDir, mode === "producer" ? { ...f.producer } : f.producer,
        mode === "intent" ? { ...intent } : intent, mode === "receipt" ? { ...receipt } : receipt);
    }), (error) => mode === "late" ? error === observed : /runtime-local bound member|process-close receipt/.test(String(error)));
    if (mode === "late") assert.throws(() => retain(f, bound!, original!), /process-close receipt/);
    assert.equal(readFileSync(f.path, "utf8"), bytes);
    assert.equal(JSON.parse(bytes).intents[0].settlement, undefined);
  }
});

test("A rejected fabricated close preserves the subsequent genuine settlement without a recursive lifecycle lock", async (t) => {
  const f = await fixture(t);
  const observed = new Error("native close was not granted early");
  await assert.rejects(() => launch(f, (intent, receipt) => { retain(f, intent, receipt); throw observed; }, {
    managed: (_context, intent) => {
      assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), true);
      assert.throws(() => retain(f, intent, {
        attempt: 1, result: { stdout: "", stderr: "", code: 0, killed: false }, nativeExitCode: 0, nativeSignal: null,
      }), /process-close receipt/);
    },
  }), (error) => error === observed);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents[0].settlement.native_exit_code, 7);
});

test("A rejected copied receipt preserves the authentic receipt in the same close callback", async (t) => {
  const f = await fixture(t);
  const observed = new Error("authentic settlement retained");
  await assert.rejects(() => launch(f, (intent, receipt) => {
    const before = readFileSync(f.path, "utf8");
    assert.throws(() => retain(f, intent, { ...receipt }), /process-close receipt/);
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.equal(retain(f, intent, receipt).native_exit_code, 7);
    throw observed;
  }), (error) => error === observed);
});

test("A failed spawn or unobserved birth grants no member settlement despite a completion callback", async (t) => {
  for (const missing of [false, true]) {
    const f = await fixture(t);
    let intent: Readonly<RunNativeLaunchIntent>;
    await assert.rejects(() => execCommandTemplate(missing ? join(f.root, "missing-executable") : process.execPath, missing ? [] : [f.script], {
      admitSpawn: (start) => Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, request, (value) => { intent = value; return start(); }),
      onAttemptManaged: (context) => { f.retain(context.process); writeFileSync(f.go, "go"); },
      onAttemptComplete: (receipt) => {
        if (missing) {
          assert.equal(Object.hasOwn(receipt, "nativeExitCode"), false);
          assert.equal(Object.hasOwn(receipt, "nativeSignal"), false);
        }
        retain(f, intent!, receipt);
      },
    }), /runtime-local bound member/);
    assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents[0].birth, undefined);
    assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents[0].settlement, undefined);
  }
});

test("Another real native close cannot settle the member even within the same generation", async (t) => {
  const f = await fixture(t);
  let first: Readonly<RunNativeLaunchIntent>;
  let second: Readonly<RunNativeLaunchIntent>;
  const launchOne = (number: number) => execCommandTemplate(process.execPath, [f.script], {
    admitSpawn: (start) => Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, { commandId: `command-00${number}`, attempt: 1 }, (intent) => {
      if (number === 1) first = intent; else second = intent;
      return start();
    }),
    onAttemptManaged: (context) => { f.retain(context.process); Producers.bindRunNativeLaunchProcess(f.stateDir, f.producer, number === 1 ? first! : second!, context); },
    onAttemptComplete: (receipt) => { if (number === 2) retain(f, first!, receipt); },
  });
  const one = launchOne(1);
  const two = launchOne(2);
  const both = Promise.allSettled([one, two]);
  writeFileSync(f.go, "go");
  const results = await both;
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  if (results[1]!.status === "rejected") assert.match(String(results[1]!.reason), /process-close receipt/);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents.every((intent: RunNativeLaunchIntent) => !intent.settlement), true);
});

test("Settlement evidence is allowed while stopping or after natural acceptance without changing root truth", async (t) => {
  for (const mode of ["stopping", "done", "failed"]) {
    const f = await fixture(t);
    let accepted: string | undefined;
    const observed = new Error("settlement recorded");
    await assert.rejects(() => launch(f, (intent, receipt) => { retain(f, intent, receipt); throw observed; }, {
      admitted: () => {
        if (mode === "stopping") {
          assert.equal(claimRunStop(f.stateDir, { runInstanceId: f.producer.runInstanceId, ownerId: f.producer.ownerId, reason: "manual_kill" }, {
            verifyIdentity: () => ({ status: "valid", valid: true }),
          }).status, "stop_requested");
        } else {
          Producers.publishRunResult(f.stateDir, f.producer, { code: mode === "done" ? 0 : 7 });
          accepted = readFileSync(join(f.stateDir, "result.json"), "utf8");
        }
      },
    }), (error) => error === observed);
    if (accepted) assert.equal(readFileSync(join(f.stateDir, "result.json"), "utf8"), accepted);
    else assert.equal(existsSync(join(f.stateDir, "result.json")), false);
    assert.equal(existsSync(join(f.stateDir, "handled.json")), false);
    assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
  }
});

test("Replaced generation, owner, or persisted birth rejects a late close before rewriting evidence", async (t) => {
  for (const mode of ["generation", "owner", "birth"]) {
    const f = await fixture(t);
    let before = "";
    await assert.rejects(() => launch(f, (intent, receipt) => retain(f, intent, receipt), {
      admitted: () => {
        if (mode === "birth") {
          const ledger = JSON.parse(readFileSync(f.path, "utf8"));
          ledger.intents[0].birth.process_identity.start_time = "replacement-birth";
          writeJsonAtomic(f.path, ledger);
        } else writeJsonAtomic(join(f.stateDir, "run.json"), { ...f.meta, ...(mode === "generation" ? { run_instance_id: "replacement" } : { ownerId: "replacement" }) });
        before = readFileSync(f.path, "utf8");
      },
    }), /generation changed|owner changed|settlement binding changed/);
    assert.equal(readFileSync(f.path, "utf8"), before);
  }
});

test("Settlement-write failure leaves birth unresolved and preserves the first execution rejection", async (t) => {
  for (const earlier of [false, true]) {
    const f = await fixture(t);
    const primary = new Error("earlier managed observation failure");
    const io = Object.assign(new Error("injected settlement EIO"), { code: "EIO" });
    const rename = fs.renameSync;
    let before = "";
    let storeError: unknown;
    let retryError: unknown;
    await assert.rejects(() => launch(f, (intent, receipt) => {
      before = readFileSync(f.path, "utf8");
      fs.renameSync = ((from, to) => { if (String(to) === f.path) throw io; return rename(from, to); }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      try {
        assert.equal(receipt.nativeExitCode, 7);
        assert.match(receipt.result.stdout, /native settlement output/);
        retain(f, intent, receipt);
      } catch (error) { storeError = error; }
      finally { fs.renameSync = rename; syncBuiltinESMExports(); }
      try { retain(f, intent, receipt); }
      catch (error) { retryError = error; }
      throw storeError;
    }, { managed: () => { if (earlier) throw primary; } }), (error) => error === (earlier ? primary : io));
    assert.equal(storeError, io);
    assert.match(String(retryError), /runtime-local bound member/);
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.equal(JSON.parse(before).intents[0].settlement, undefined);
    assert.equal(existsSync(join(f.stateDir, "captures", "attempt-002")), false);
  }
});

test("Settlement schema is strict and later intents preserve accepted native-close facts", async (t) => {
  const f = await fixture(t);
  const observed = new Error("accepted native settlement");
  await assert.rejects(() => launch(f, (intent, receipt) => { retain(f, intent, receipt); throw observed; }), (error) => error === observed);
  const original = JSON.parse(readFileSync(f.path, "utf8"));
  const append = () => Producers.withRunNativeLaunchAdmission(f.stateDir, f.producer, { ...request, attempt: 2 }, () => { throw Error("next unresolved intent"); });
  assert.throws(append, /next unresolved intent/);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).intents[0].settlement, original.intents[0].settlement);
  for (const mode of ["unknown", "code", "signal", "both", "neither", "time", "no_birth"]) {
    const ledger = structuredClone(original);
    const settlement = ledger.intents[0].settlement;
    if (mode === "unknown") settlement.complete_scope = true;
    if (mode === "code") settlement.native_exit_code = "7";
    if (mode === "signal") { settlement.native_exit_code = null; settlement.native_signal = "SIGTERM\n"; }
    if (mode === "both") settlement.native_signal = "SIGTERM";
    if (mode === "neither") settlement.native_exit_code = null;
    if (mode === "time") settlement.observed_at = "yesterday";
    if (mode === "no_birth") delete ledger.intents[0].birth;
    writeJsonAtomic(f.path, ledger);
    const bytes = readFileSync(f.path, "utf8");
    assert.equal(readRunNativeLaunchLedger(f.stateDir, f.producer).state, "invalid");
    assert.throws(append, /unavailable or invalid/);
    assert.equal(readFileSync(f.path, "utf8"), bytes);
    assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
  }
});

test("Already recorded settlement survives producer death but serialized recovery data grants no capability", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const announced = join(f.root, "announced");
  const ready = join(f.root, "ready");
  const worker = join(f.root, "worker.mjs");
  const commandUrl = new URL("../lib/command-templates.ts", import.meta.url).href;
  const producerUrl = new URL("../lib/runs-results.ts", import.meta.url).href;
  await writeFile(worker, `import {existsSync,writeFileSync} from 'node:fs';
    import {execCommandTemplate} from ${JSON.stringify(commandUrl)};
    import {admitRunResultProducer,withRunNativeLaunchAdmission,bindRunNativeLaunchProcess,recordRunNativeLaunchSettlement} from ${JSON.stringify(producerUrl)};
    writeFileSync(${JSON.stringify(announced)},'ready');
    const until=Date.now()+10000;while(!existsSync(${JSON.stringify(ready)})){if(Date.now()>until)throw Error('handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
    const {producer}=admitRunResultProducer(${JSON.stringify(f.stateDir)});let intent;
    await execCommandTemplate(process.execPath,[${JSON.stringify(f.script)}],{
      admitSpawn:start=>withRunNativeLaunchAdmission(${JSON.stringify(f.stateDir)},producer,${JSON.stringify(request)},value=>{intent=value;return start()}),
      onAttemptManaged:context=>{bindRunNativeLaunchProcess(${JSON.stringify(f.stateDir)},producer,intent,context);writeFileSync(${JSON.stringify(f.go)},'go')},
      onAttemptComplete:receipt=>{recordRunNativeLaunchSettlement(${JSON.stringify(f.stateDir)},producer,intent,receipt);process.exit(42)}
    });`);
  const child = spawn(process.execPath, ["--experimental-strip-types", worker], { stdio: ["ignore", "ignore", "pipe"] });
  f.retain(child);
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += String(data); });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const until = Date.now() + 10_000;
  while (!existsSync(announced)) { if (Date.now() > until) throw Error("Worker handshake timed out"); await delay(5); }
  const identity = readProcessIdentity(child.pid!);
  writeJsonAtomic(join(f.stateDir, "run.json"), { ...f.meta, pid: child.pid, process_identity: identity });
  writeFileSync(ready, "ready");
  assert.equal(await exit, 42, stderr);
  assert.equal(readProcessLiveness(child.pid!), "dead");
  const bytes = readFileSync(f.path, "utf8");
  const owner = { ...f.producer, pid: child.pid!, processIdentityDigest: runProcessIdentityDigest(identity) };
  const read = readRunNativeLaunchLedger(f.stateDir, owner);
  assert.equal(read.state, "available");
  if (read.state !== "available") throw Error("Recorded native settlement missing");
  const settlement = read.ledger.intents[0]!.settlement;
  assert.ok(settlement && settlement.basis === undefined);
  assert.equal(settlement.native_exit_code, 7);
  assert.equal(existsSync(join(f.stateDir, "result.json")), false);
  assert.throws(() => Producers.recordRunNativeLaunchSettlement(f.stateDir, owner, read.ledger.intents[0]!, {
    attempt: 1, result: { stdout: "", stderr: "", code: 7, killed: false }, nativeExitCode: 7, nativeSignal: null,
  }), /runtime-local bound member/);
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
});

});

await describe("Recovery", { concurrency: false }, async () => {


async function waitFor(path: string) {
  const until = Date.now() + 10_000;
  while (!existsSync(path)) { if (Date.now() > until) throw Error("Recovery fixture handshake timed out"); await delay(5); }
}

async function exitedProducer(t: TestContext, recordClose = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-native-recovery-"));
  const stateDir = claimRunStateDirectory(join(root, "state"), "recovery");
  const announced = join(root, "announced");
  const ready = join(root, "ready");
  const go = join(root, "go");
  const script = join(root, "native.cjs");
  await writeFile(script, `const fs=require('node:fs');const until=Date.now()+10000;
    const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>until){clearInterval(t);process.exit(7)}},5)`);
  const worker = join(root, "producer.mjs");
  const commandUrl = new URL("../lib/command-templates.ts", import.meta.url).href;
  const producerUrl = new URL("../lib/runs-results.ts", import.meta.url).href;
  await writeFile(worker, `import {existsSync,writeFileSync} from 'node:fs';
    import {execCommandTemplate} from ${JSON.stringify(commandUrl)};
    import {admitRunResultProducer,withRunNativeLaunchAdmission,bindRunNativeLaunchProcess,recordRunNativeLaunchSettlement} from ${JSON.stringify(producerUrl)};
    writeFileSync(${JSON.stringify(announced)},'ready');const until=Date.now()+10000;
    while(!existsSync(${JSON.stringify(ready)})){if(Date.now()>until)throw Error('handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
    const {producer}=admitRunResultProducer(${JSON.stringify(stateDir)});let intent;
    await execCommandTemplate(process.execPath,[${JSON.stringify(script)}],{
      admitSpawn:start=>withRunNativeLaunchAdmission(${JSON.stringify(stateDir)},producer,{commandId:'command-001',attempt:1},value=>{intent=value;return start()}),
      onAttemptManaged:context=>{bindRunNativeLaunchProcess(${JSON.stringify(stateDir)},producer,intent,context);writeFileSync(${JSON.stringify(go)},'go')},
      onAttemptComplete:receipt=>{${recordClose ? `recordRunNativeLaunchSettlement(${JSON.stringify(stateDir)},producer,intent,receipt);` : ""}process.exit(42)}
    });`);
  const child = spawn(process.execPath, ["--experimental-strip-types", worker], { stdio: ["ignore", "ignore", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const children = new Map<ChildProcess, Promise<unknown>>([[child, closed]]);
  const retain = (other: ChildProcess) => children.set(other, new Promise((resolve) => other.once("close", resolve)));
  t.after(async () => {
    writeFileSync(go, "go");
    for (const [owned, ended] of children) {
      if (owned.exitCode === null && owned.signalCode === null) {
        if (owned !== child || !existsSync(join(stateDir, RUN_NATIVE_LAUNCH_FILE))) owned.kill("SIGKILL");
      }
      await ended;
    }
    await rm(root, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += String(data); });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  await waitFor(announced);
  const meta = {
    run: "recovery", state_dir: stateDir, run_instance_id: "generation-a", ownerId: "owner-a", pid: child.pid,
    process_identity: readProcessIdentity(child.pid!), outcome_protocol: RUN_OUTCOME_PROTOCOL,
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  writeFileSync(ready, "ready");
  assert.equal(await exit, 42, stderr);
  assert.equal(readProcessLiveness(child.pid!), "dead");
  const path = join(stateDir, RUN_NATIVE_LAUNCH_FILE);
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  if (recordClose) assert.equal(ledger.intents[0].settlement.native_exit_code, 7);
  else assert.equal(ledger.intents[0].settlement, undefined);
  assert.equal(readProcessLiveness(ledger.intents[0].birth.pid), "dead");
  return { root, stateDir, path, ledger, meta, retain, request: { runInstanceId: "generation-a", ownerId: "owner-a", intentId: ledger.intents[0].intent_id } };
}

test("A missing member settlement recovers only verified absence, never an invented native exit or scope closure", async (t) => {
  const f = await exitedProducer(t);
  const metaBytes = readFileSync(join(f.stateDir, "run.json"), "utf8");
  const result = Control.recoverRunNativeMemberExit(f.stateDir, f.request);
  assert.equal(result.status, "recorded");
  const stored = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(stored.intents[0].settlement.basis, "verified_absence");
  assert.equal(Object.hasOwn(stored.intents[0].settlement, "native_exit_code"), false);
  assert.equal(Object.hasOwn(stored.intents[0].settlement, "native_signal"), false);
  assert.equal(readFileSync(join(f.stateDir, "run.json"), "utf8"), metaBytes);
  assert.equal(existsSync(join(f.stateDir, "result.json")), false);
  assert.equal(existsSync(join(f.stateDir, "handled.json")), false);
  assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
  const bytes = readFileSync(f.path, "utf8");
  assert.equal(Control.recoverRunNativeMemberExit(f.stateDir, f.request, { probe: () => assert.fail("Recorded fact reprobed") }).status, "already_recorded");
  assert.equal(readFileSync(f.path, "utf8"), bytes);
});

test("Existing native-close evidence is retained without manufacturing recovered exit facts", async (t) => {
  const f = await exitedProducer(t, true);
  const before = readFileSync(f.path, "utf8");
  const result = Control.recoverRunNativeMemberExit(f.stateDir, f.request, { probe: () => assert.fail("Existing settlement reprobed") });
  assert.equal(result.status, "already_recorded");
  if (result.status !== "already_recorded") throw Error("Expected existing close");
  assert.equal(result.settlement.basis, undefined);
  assert.equal(Object.isFrozen(result.settlement), true);
  assert.equal(readFileSync(f.path, "utf8"), before);
});

test("A live real producer retains exclusive settlement responsibility even after its native child exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-live-native-recovery-"));
  const stateDir = claimRunStateDirectory(join(root, "state"), "live-recovery");
  const go = join(root, "go");
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  t.after(async () => { writeFileSync(go, "go"); if (closed) await closed; await rm(root, { recursive: true, force: true }); });
  writeJsonAtomic(join(stateDir, "run.json"), {
    run: "live-recovery", state_dir: stateDir, run_instance_id: "generation-a", ownerId: "owner-a",
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL,
  });
  const producer = Producers.admitRunResultProducer(stateDir).producer;
  let intent: Readonly<RunNativeLaunchIntent>;
  await execCommandTemplate(process.execPath, ["-e", `const fs=require('node:fs');const end=Date.now()+10000;
    const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(t);process.exit(7)}},5)`], {
    admitSpawn: (start) => Producers.withRunNativeLaunchAdmission(stateDir, producer, { commandId: "command-001", attempt: 1 }, (value) => { intent = value; return start(); }),
    onAttemptManaged: (context) => {
      child = context.process; closed = new Promise((resolve) => child!.once("close", resolve));
      try { Producers.bindRunNativeLaunchProcess(stateDir, producer, intent!, context); }
      finally { writeFileSync(go, "go"); }
    },
  });
  const path = join(stateDir, RUN_NATIVE_LAUNCH_FILE);
  const before = readFileSync(path, "utf8");
  assert.deepEqual(Control.recoverRunNativeMemberExit(stateDir, { runInstanceId: producer.runInstanceId, ownerId: producer.ownerId, intentId: intent!.intent_id }), {
    status: "unproven", reason: "producer_running",
  });
  assert.equal(readFileSync(path, "utf8"), before);
});

test("Unknown, denied, live, or reused producer/member PIDs never become verified absence", async (t) => {
  const f = await exitedProducer(t);
  const before = readFileSync(f.path, "utf8");
  const rootPid = f.meta.pid!;
  const birth = f.ledger.intents[0].birth;
  for (const mode of ["producer_alive", "producer_denied", "producer_reused", "member_alive", "member_denied", "member_false", "member_missing", "member_reused"]) {
    const calls: number[] = [];
    const deps: RunProcessExitDeps = {
      probe: (pid, signal) => {
        calls.push(pid);
        assert.equal(signal, 0);
        assert.ok(pid > 0);
        if (pid === rootPid && !mode.startsWith("producer")) throw Object.assign(new Error("gone producer"), { code: "ESRCH" });
        if (mode.endsWith("denied")) throw Object.assign(new Error("denied"), { code: "EPERM" });
        return mode === "member_false" ? false : true;
      },
      readIdentity: (pid) => {
        if (mode === "member_missing") return undefined;
        const identity = pid === rootPid ? f.meta.process_identity! : birth.process_identity;
        return mode.endsWith("reused") ? { ...identity, start_time: "foreign-birth" } : identity;
      },
    };
    const result = Control.recoverRunNativeMemberExit(f.stateDir, f.request, deps);
    assert.equal(result.status, "unproven", mode);
    if (mode.startsWith("producer")) assert.deepEqual(calls, [rootPid]);
    else assert.deepEqual(calls, [rootPid, birth.pid]);
    assert.equal(readFileSync(f.path, "utf8"), before);
  }
});

test("A missing birth or legacy producer identity is not repaired from a bare PID", async (t) => {
  const f = await exitedProducer(t);
  const original = structuredClone(f.ledger);
  const noProbe = { probe: () => assert.fail("Unbound evidence probed"), readIdentity: () => assert.fail("A birth was recaptured") };
  delete f.ledger.intents[0].birth;
  writeJsonAtomic(f.path, f.ledger);
  assert.deepEqual(Control.recoverRunNativeMemberExit(f.stateDir, f.request, noProbe), { status: "unproven", reason: "birth_unavailable" });
  original.runner_identity_digest = null;
  writeJsonAtomic(f.path, original);
  const { process_identity: _identity, ...legacy } = f.meta;
  writeJsonAtomic(join(f.stateDir, "run.json"), legacy);
  const before = readFileSync(f.path, "utf8");
  assert.deepEqual(Control.recoverRunNativeMemberExit(f.stateDir, f.request, noProbe), { status: "unproven", reason: "producer_identity_unavailable" });
  assert.equal(readFileSync(f.path, "utf8"), before);
});

test("Generation/owner/protocol and journal corruption reject before native observation", async (t) => {
  const f = await exitedProducer(t);
  const noProbe = { probe: () => assert.fail("Rejected recovery probed a PID") };
  const bytes = readFileSync(f.path, "utf8");
  for (const request of [
    { ...f.request, runInstanceId: "" }, { ...f.request, intentId: "" }, { ...f.request, runInstanceId: "stale" },
    { ...f.request, ownerId: "foreign" }, { ...f.request, intentId: "not-present" },
  ]) {
    assert.equal(Control.recoverRunNativeMemberExit(f.stateDir, request, noProbe).status, "rejected");
    assert.equal(readFileSync(f.path, "utf8"), bytes);
  }
  writeJsonAtomic(join(f.stateDir, "run.json"), { ...f.meta, outcome_protocol: "future" });
  assert.equal(Control.recoverRunNativeMemberExit(f.stateDir, f.request, noProbe).status, "rejected");
  writeJsonAtomic(join(f.stateDir, "run.json"), f.meta);
  for (const mode of ["malformed", "unknown", "mixed", "no_birth"]) {
    const data = structuredClone(f.ledger);
    if (mode === "unknown") data.intents[0].future_scope_proof = true;
    if (mode === "mixed") data.intents[0].settlement = { basis: "verified_absence", observed_at: new Date().toISOString(), native_exit_code: 0 };
    if (mode === "no_birth") { delete data.intents[0].birth; data.intents[0].settlement = { basis: "verified_absence", observed_at: new Date().toISOString() }; }
    if (mode === "malformed") writeFileSync(f.path, "{invalid"); else writeJsonAtomic(f.path, data);
    const before = readFileSync(f.path, "utf8");
    assert.equal(Control.recoverRunNativeMemberExit(f.stateDir, f.request, noProbe).status, "rejected");
    assert.equal(readFileSync(f.path, "utf8"), before);
  }
});

test("Recovery revalidates generation after lifecycle contention before any native probe", async (t) => {
  const f = await exitedProducer(t);
  const held = join(f.root, "held");
  const blocked = join(f.root, "blocked");
  const holderFile = join(f.root, "holder.mjs");
  const startUrl = new URL("../lib/runs-start.ts", import.meta.url).href;
  const stateUrl = new URL("../lib/file-state.ts", import.meta.url).href;
  await writeFile(holderFile, `import {existsSync,writeFileSync} from 'node:fs';
    import {acquireStateStartLock} from ${JSON.stringify(startUrl)};import {writeJsonAtomic} from ${JSON.stringify(stateUrl)};
    const release=acquireStateStartLock(${JSON.stringify(f.stateDir)});
    try {writeFileSync(${JSON.stringify(held)},'held');const end=Date.now()+10000;
      while(!existsSync(${JSON.stringify(blocked)})){if(Date.now()>end)throw Error('contention handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
      writeJsonAtomic(${JSON.stringify(join(f.stateDir, "run.json"))},${JSON.stringify({ ...f.meta, run_instance_id: "replacement" })});
    } finally {release()}`);
  const holder = spawn(process.execPath, ["--experimental-strip-types", holderFile], { stdio: "ignore" });
  f.retain(holder);
  const exit = new Promise((resolve) => holder.once("exit", resolve));
  await waitFor(held);
  const before = readFileSync(f.path, "utf8");
  assert.deepEqual(Control.recoverRunNativeMemberExit(f.stateDir, f.request, {
    onLockContention: () => writeFileSync(blocked, "blocked"), probe: () => assert.fail("Replacement PID was probed"),
  }), { status: "rejected", code: "run_generation_mismatch" });
  assert.equal(await exit, 0);
  assert.equal(readFileSync(f.path, "utf8"), before);
});

test("Generation or birth changes during observation cannot retarget recovered evidence", async (t) => {
  for (const mode of ["generation", "birth"]) {
    const f = await exitedProducer(t);
    const before = readFileSync(f.path, "utf8");
    const recover = () => Control.recoverRunNativeMemberExit(f.stateDir, f.request, {
      probe: (pid) => {
        if (pid === f.ledger.intents[0].birth.pid) {
          if (mode === "generation") writeJsonAtomic(join(f.stateDir, "run.json"), { ...f.meta, run_instance_id: "replacement" });
          else { const changed = structuredClone(f.ledger); changed.intents[0].birth.process_identity.start_time = "replacement"; writeJsonAtomic(f.path, changed); }
        }
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    if (mode === "generation") {
      assert.deepEqual(recover(), { status: "rejected", code: "run_identity_changed" });
      assert.equal(readFileSync(f.path, "utf8"), before);
    } else {
      assert.throws(recover, /settlement binding changed/);
      assert.equal(JSON.parse(readFileSync(f.path, "utf8")).intents[0].settlement, undefined);
    }
  }
});

test("Recovery I/O refusal preserves unresolved evidence and all root outcome/cause bytes", async (t) => {
  const f = await exitedProducer(t);
  const files = ["result.json", "stop-claim.json", "progress.json", "terminal-handled.json", "trace.jsonl"];
  for (const file of files) writeFileSync(join(f.stateDir, file), `retained ${file}`);
  const bytes = readFileSync(f.path, "utf8");
  const io = Object.assign(new Error("injected recovery EIO"), { code: "EIO" });
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => { if (String(to) === f.path) throw io; return rename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(() => Control.recoverRunNativeMemberExit(f.stateDir, f.request), (error) => error === io); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  assert.equal(Control.recoverRunNativeMemberExit(f.stateDir, f.request).status, "recorded");
  for (const file of files) assert.equal(readFileSync(join(f.stateDir, file), "utf8"), `retained ${file}`);
  assert.throws(() => assertNoRetainedNativeLaunchScope(f.stateDir), /scope is unproven/);
});

});

await describe("Reuse and retirement", { concurrency: false }, async () => {


const exec = promisify(execFile);
const readJson = (path: string) => readJsonFileResilient<Record<string, unknown> | undefined>(path, undefined).value;
const error = /native launch scope is unproven/;
const retained = ["run.json", "stdout.log", "execution.json", RUN_NATIVE_LAUNCH_FILE];

async function fixture(t: TestContext, natural = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-native-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "native-reuse");
  const url = (name: string) => new URL(`../lib/${name}.ts`, import.meta.url).href;
  await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    import {writeJsonAtomic} from ${JSON.stringify(url("file-state"))};
    import {readProcessIdentity} from ${JSON.stringify(url("runs-process"))};
    import {admitRunResultProducer,publishRunResult,withRunNativeLaunchAdmission} from ${JSON.stringify(url("runs-results"))};
    const stateDir=process.argv[1];
    writeJsonAtomic(join(stateDir,'run.json'),{run:'native-reuse',run_instance_id:'reuse-generation',ownerId:'reuse-owner',
      state_dir:stateDir,pid:process.pid,process_identity:readProcessIdentity(process.pid),outcome_protocol:'run-outcome-v1'});
    const {producer}=admitRunResultProducer(stateDir);const original=new Error('native birth unknown');
    try{withRunNativeLaunchAdmission(stateDir,producer,{commandId:'command-001',attempt:1},()=>{throw original})}
    catch(error){if(error!==original)throw error}
    writeFileSync(join(stateDir,'stdout.log'),'preserved output\\n');
    writeJsonAtomic(join(stateDir,'execution.json'),{run_instance_id:producer.runInstanceId,commands:[]});
    if(${JSON.stringify(natural)})publishRunResult(stateDir,producer,{code:0});
  `, stateDir]);
  const meta = readJson(join(stateDir, "run.json"))!;
  assert.equal(readProcessLiveness(Number(meta.pid)), "dead");
  return { root, stateDir, meta };
}

async function snapshot(stateDir: string) {
  return Promise.all(retained.map((file) => readFile(join(stateDir, file), "utf8")));
}

async function waitExit(pid: number) {
  const deadline = Date.now() + 10_000;
  while (readProcessLiveness(pid) !== "dead") {
    if (Date.now() >= deadline) throw Error("Captured fixture runner exit remains unproven");
    await delay(10);
  }
}

test("Exited opt-in producers cannot have native-intent evidence bypassed by preparation or retirement", async (t) => {
  for (const natural of [false, true]) {
    const { root, stateDir } = await fixture(t, natural);
    const before = await snapshot(stateDir);
    const result = existsSync(join(stateDir, "result.json")) ? await readFile(join(stateDir, "result.json"), "utf8") : undefined;
    const status = getRunStatus(stateDir);
    assert.notEqual(status.status, "running");
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
    assert.equal(result === undefined ? existsSync(join(stateDir, "result.json")) : await readFile(join(stateDir, "result.json"), "utf8"), result === undefined ? false : result);
  }
});

test("Public restart, archive and prune refuse the unresolved scope before replacing generation or evidence", async (t) => {
  const { root, stateDir, meta } = await fixture(t);
  const before = await snapshot(stateDir);
  const replacement = join(root, "replacement");
  const params = { run_id: "native-reuse", state_dir: stateDir, template: `${process.execPath} -e "require('node:fs').writeFileSync('${replacement.replaceAll("\\", "/")}', 'replacement')"` };
  assert.throws(() => startRun(params, process.cwd()), error);
  assert.throws(() => archiveRun(stateDir, { ownerId: String(meta.ownerId), runInstanceId: String(meta.run_instance_id) }), error);
  assert.throws(() => pruneRun(stateDir), error);
  assert.deepEqual(await snapshot(stateDir), before);
  assert.equal(existsSync(replacement), false);
  assert.equal(existsSync(join(root, "archived")), false);
  const records = (await readFile(join(root, "retention.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.some((record) => record.outcome === "handled"), false);
});

test("A compatible live singleton keeps its generation and clock, but cannot restart unresolved scope after exit", { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-native-singleton-"));
  const skill = join(root, "native-singleton");
  const recipe = join(skill, "recipes", "worker.json");
  const script = join(root, "gate.cjs");
  const ready = join(root, "ready");
  const go = join(root, "go");
  const stateDir = join(root, "state");
  let pid: number | undefined;
  let unexpectedPid: number | undefined;
  t.after(async () => {
    await writeFile(go, "go");
    if (pid) await waitExit(pid);
    if (unexpectedPid) await waitExit(unexpectedPid);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(skill, "recipes"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: native-singleton\ndescription: Native scope fixture.\n---\n");
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');
    const end=Date.now()+15000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(timer);process.exit(0)}},10);`);
  await writeFile(recipe, JSON.stringify({ async: true, singleton: true, template: `${process.execPath} ${script}` }));
  const launch = () => startRun({ file: recipe, state_dir: stateDir, ownerId: "singleton-owner" }, process.cwd());
  const first = launch();
  pid = first.pid;
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw Error("Singleton fixture handshake timed out");
    await delay(10);
  }
  // Simulated retained opt-in journal, not an assertion of production admission or membership.
  const release = acquireStateStartLock(stateDir);
  try {
    writeJsonAtomic(join(stateDir, RUN_NATIVE_LAUNCH_FILE), {
      schema: "run-native-launches-v1", run: first.run, run_instance_id: first.run_instance_id,
      ownerId: first.ownerId, runner_pid: first.pid, runner_identity_digest: runProcessIdentityDigest(first.process_identity) ?? null,
      intents: [{ intent_id: randomUUID(), command_id: "command-001", attempt: 1, admitted_at: new Date().toISOString() }],
    });
  } finally { release(); }
  const metadata = await readFile(join(stateDir, "run.json"), "utf8");
  const ledger = await readFile(join(stateDir, RUN_NATIVE_LAUNCH_FILE), "utf8");
  const reused = launch();
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.run_instance_id, first.run_instance_id);
  assert.equal(reused.started_at, first.started_at);
  assert.deepEqual(reused.supervision, first.supervision);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), metadata);
  assert.equal(await readFile(join(stateDir, RUN_NATIVE_LAUNCH_FILE), "utf8"), ledger);
  await writeFile(go, "go");
  await waitExit(first.pid);
  assert.throws(() => { unexpectedPid = launch().pid; }, error);
  assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), metadata);
  assert.equal(await readFile(join(stateDir, RUN_NATIVE_LAUNCH_FILE), "utf8"), ledger);
});

test("A valid empty intent ledger still supplies no owned-scope closure proof", async (t) => {
  const { stateDir, meta } = await fixture(t);
  const path = join(stateDir, RUN_NATIVE_LAUNCH_FILE);
  const ledger = JSON.parse(await readFile(path, "utf8"));
  ledger.intents = [];
  writeJsonAtomic(path, ledger);
  const reading = readRunNativeLaunchLedger(stateDir, {
    run: String(meta.run), runInstanceId: String(meta.run_instance_id), ownerId: String(meta.ownerId),
    pid: Number(meta.pid), processIdentityDigest: runProcessIdentityDigest(meta.process_identity),
  });
  assert.equal(reading.state, "available");
  const before = await snapshot(stateDir);
  assert.throws(() => prepareStateDirForStart(stateDir, readJson, "unused"), error);
  assert.deepEqual(await snapshot(stateDir), before);
});

test("Directory and supported symlink scope records cannot be bypassed as missing evidence", async (t) => {
  for (const kind of process.platform === "win32" ? ["directory"] : ["directory", "symlink"]) {
    const { root, stateDir } = await fixture(t);
    const path = join(stateDir, RUN_NATIVE_LAUNCH_FILE);
    const evidence = await Promise.all(retained.slice(0, -1).map((file) => readFile(join(stateDir, file), "utf8")));
    await rm(path);
    const target = join(root, "target");
    await writeFile(target, "private target");
    if (kind === "directory") await mkdir(path);
    else await symlink(target, path);
    const status = getRunStatus(stateDir);
    for (const action of [
      () => prepareStateDirForStart(stateDir, readJson, "unused"),
      () => archiveTerminalRun(status),
      () => pruneTerminalRun(status),
    ]) assert.throws(action, error);
    assert.deepEqual(await Promise.all(retained.slice(0, -1).map((file) => readFile(join(stateDir, file), "utf8"))), evidence);
    assert.equal(await readFile(target, "utf8"), "private target");
    assert.equal(existsSync(join(root, "archived")), false);
  }
});

test("Unavailable scope-presence evidence fails closed before state mutation", async (t) => {
  const { stateDir } = await fixture(t);
  const before = await snapshot(stateDir);
  const path = join(stateDir, RUN_NATIVE_LAUNCH_FILE);
  const lstat = fs.lstatSync;
  fs.lstatSync = ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === path) throw Object.assign(new Error("injected scope lookup failure"), { code: "EIO" });
    return Reflect.apply(lstat, fs, [file, ...args]);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try { assert.throws(() => prepareStateDirForStart(stateDir, readJson, "unused"), error); }
  finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.deepEqual(await snapshot(stateDir), before);
});

test("Malformed, empty, and foreign native scope records cannot authorize evidence replacement", async (t) => {
  for (const content of ["{unproven", "", JSON.stringify({ schema: "run-native-launches-v1", run: "foreign", intents: [] })]) {
    const { stateDir } = await fixture(t);
    await writeFile(join(stateDir, RUN_NATIVE_LAUNCH_FILE), content);
    const before = await snapshot(stateDir);
    assert.throws(() => prepareStateDirForStart(stateDir, readJson, "unused"), error);
    assert.deepEqual(await snapshot(stateDir), before);
  }
});

});
