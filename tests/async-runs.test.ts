/** Mirrors lib/async-runs.ts; related contracts share this owner while retaining their fixtures and hooks. */
import "./test-environment.mjs";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mutationLockPath, writeJsonAtomic, writeTextAtomic } from "../lib/file-state.ts";
import { acquireStateStartLock } from "../lib/runs-start.ts";
import { signalOwnedRunProcess } from "../lib/runs-control.ts";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import childProcess, {
  execFile,
} from "node:child_process";
import {
  existsSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  basename, join,
} from "node:path";
import test from "node:test";
import {
  describe,
} from "node:test";
import {
  promisify,
} from "node:util";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import {
  archiveRun,
  cancelRun,
  getRunProcessSignalPlan,
  getRunStatus,
  killRun,
  listRuns,
  pruneRun,
  readRunStateIndex,
  rebuildRunStateIndex,
  startRun,
  tailRun,
  teardownRunsOwnedByParent,
  sendRunControl,
} from "../lib/async-runs.ts";
import {
  createRunUiObservationState,
  executeRunRetirements,
  pruneRunUiObservationState,
  readRunUiSnapshot,
  summarizeRuns,
} from "../lib/observability.ts";
import * as Limits from "../lib/limits.ts";
import { compactAsyncRunStatus } from "../lib/tools-response.ts";
import {
  readProcessLiveness,
  readProcessIdentity,
} from "../lib/runs-process.ts";
import {
  appendRunControlInStateDir,
  readRunControlsFromStateDir,
  updateRunControlStatusInStateDir,
} from "../lib/runs-controls.ts";
import {
  appendRunTraceEvent,
  summarizeRunTraceJournal,
  readRunTraceJournal,
} from "../lib/runs-trace.ts";
import {
  pruneTerminalRun,
} from "../lib/runs-retention.ts";
import {
  createActiveSkillRecipeContext,
} from "../lib/recipes-references.ts";
import {
  claimRunStateDirectory,
} from "../lib/runs-ownership.ts";
import {
  getRunStateRoot,
} from "../lib/paths.ts";
import {
  readRecipeUsage,
} from "../lib/recipes-usage.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Run lifecycle", { concurrency: false }, async () => {
/**
 * Async run primitive regression tests
 * Covers detached state files, status/list/tail, and cancellation stale-state behavior
 */


const execFileAsync = promisify(execFile);
const controlRaceWorker = fileURLToPath(
  new URL("./fixtures/run-control-race-worker.ts", import.meta.url),
);


async function waitForResult(
  stateDir: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const status = getRunStatus(stateDir);
    if (status.result) return status.result as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run did not finish");
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`file did not appear: ${path}`);
}

async function waitForFileContent(
  path: string,
  pattern: RegExp,
  minBytes = 0,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const content = await readFile(path, "utf8");
      if (pattern.test(content) && Buffer.byteLength(content) >= minBytes) return;
    } catch {
      // File is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file content did not appear: ${path}`);
}

async function waitForJsonStatus(
  path: string,
  status: string,
): Promise<Record<string, any>> {
  for (let i = 0; i < 40; i++) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.status === status) return value;
    } catch {
      // File is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`json status did not appear: ${path} -> ${status}`);
}

async function waitForJsonField(
  path: string,
  field: string,
  expected: unknown,
): Promise<Record<string, any>> {
  let observed: unknown;
  for (let i = 0; i < 200; i++) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      observed = value[field];
      if (observed === expected) return value;
    } catch {
      // File is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `json field did not appear: ${path} -> ${field}=${String(expected)} (observed ${String(observed)})`,
  );
}

async function waitForStatus(
  stateDir: string,
  expected: string,
  attempts = 40,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < attempts; i++) {
    const status = getRunStatus(stateDir);
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run did not reach status: ${expected}`);
}

async function waitForRunProcessExit(stateDir: string): Promise<void> {
  const pid = getRunStatus(stateDir).pid;
  assert.ok(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
  for (let i = 0; i < 200; i++) {
    if (readProcessLiveness(pid) === "dead") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Captured fixture runner exit remains unproven");
}

async function withFixtureCleanup<T>(body: () => T | Promise<T>, cleanup: () => unknown | Promise<unknown>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await body() }; }
  catch (error) { outcome = { ok: false, error }; }
  try { await cleanup(); } catch (error) {
    if (!outcome.ok) throw new AggregateError([outcome.error, error], "Fixture body and cleanup failed; state may be retained");
    throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

test("Fixture cleanup preserves exact falsy failures, ordered dual causes and proof-before-deletion", async () => {
  const cleanupFailure = new Error("cleanup sentinel");
  for (const primary of [undefined, null, false, 0, "", new Error("primary sentinel")]) {
    for (const phase of ["primary", "cleanup", "both"] as const) {
      let caught = false, actual: unknown, deleted = false;
      try {
        await withFixtureCleanup(async () => { if (phase !== "cleanup") throw primary; }, async () => {
          if (phase !== "primary") throw cleanupFailure;
          deleted = true;
        });
      } catch (error) { caught = true; actual = error; }
      assert.equal(caught, true);
      assert.equal(deleted, phase === "primary");
      if (phase === "both") {
        assert.ok(actual instanceof AggregateError);
        assert.deepEqual(actual.errors, [primary, cleanupFailure]);
        assert.equal(actual.errors[0], primary); assert.equal(actual.errors[1], cleanupFailure);
      } else assert.equal(actual, phase === "primary" ? primary : cleanupFailure);
    }
  }
  assert.equal(await withFixtureCleanup(async () => "retained result", async () => undefined), "retained result");
});

async function stopCapturedFixtureRun(meta: ReturnType<typeof startRun>, stateDir: string): Promise<void> {
  if (readProcessLiveness(meta.pid) !== "dead") {
    assert.ok(meta.process_identity, "Captured fixture birth identity is unavailable; retaining state");
    signalOwnedRunProcess(meta.pid, "SIGKILL", meta.process_identity);
  }
  await waitForRunProcessExit(stateDir);
}

test("Async runs reject reuse of an active run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-active-"));
  const stateDir = join(root, "active");
  try {
    startRun(
      {
        run_id: "active",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    assert.throws(
      () =>
        startRun(
          {
            run_id: "active",
            state_dir: stateDir,
            template: `${JSON.stringify(process.execPath)} -e "console.log('replacement')"`,
          },
          process.cwd(),
        ),
      /active owned process/,
    );
    cancelRun(stateDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Singleton Skill Recipes reuse one compatible active Run and reject conflicting identity or values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-singleton-"));
  const skillDir = join(root, "music-player");
  const recipeDir = join(skillDir, "recipes");
  const recipe = join(recipeDir, "playback.json");
  const alternateRecipe = join(recipeDir, "alternate.json");
  const stateDir = join(root, "state"), ready = join(root, "ready");
  const workload = "const fs=require('node:fs'),p=process.argv[1],tmp=p+'.'+process.pid; fs.writeFileSync(tmp,String(process.pid)); fs.renameSync(tmp,p); setTimeout(() => {}, Number(process.argv[2]));";
  const template = (duration: number) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(workload)} ${JSON.stringify(ready)} ${duration}`;
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: music-player\ndescription: Test singleton.\n---\n",
  );
  await writeFile(
    recipe,
    JSON.stringify({
      async: true,
      singleton: true,
      args: ["source:string"],
      defaults: { source: "music" },
      control: ["stop"],
      template: template(10000),
    }),
  );
  await writeFile(
    alternateRecipe,
    JSON.stringify({
      async: true,
      singleton: true,
      args: ["source:string"],
      defaults: { source: "music" },
      control: ["stop"],
      template: template(20000),
    }),
  );
  type Birth = { pid: number | undefined; close?: { code: number | null; signal: NodeJS.Signals | null }; meta?: ReturnType<typeof startRun>; stopAttempted?: boolean };
  const births: Birth[] = [], workloads = new Set<number>(), spawn = childProcess.spawn;
  let dispatched = false, accepted = false;
  const spawnHook = t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child: childProcess.ChildProcess = Reflect.apply(spawn, childProcess, args);
    const birth: Birth = { pid: child.pid }; births.push(birth);
    child.once("close", (code, signal) => { birth.close = { code, signal }; });
    return child;
  });
  syncBuiltinESMExports();
  const settle = async (birth: Birth) => {
    assert.ok(typeof birth.pid === "number" && Number.isSafeInteger(birth.pid) && birth.pid > 0, `Unknown runner birth; retaining ${root}`);
    if (!birth.stopAttempted && readProcessLiveness(birth.pid) !== "dead" && birth.meta?.process_identity) {
      birth.stopAttempted = true;
      signalOwnedRunProcess(birth.pid, "SIGKILL", birth.meta.process_identity);
    }
    for (let i = 0; i < 200; i++) {
      if (birth.close && readProcessLiveness(birth.pid) === "dead") return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Captured singleton runner close/absence remains unproven; retaining ${root}`);
  };
  try { await withFixtureCleanup(async () => {
    const launch = () => {
      dispatched = true;
      const meta = startRun({ file: recipe, state_dir: stateDir, ownerId: "session-a" }, process.cwd());
      if (!meta.reused) {
        const birth = births.find(item => item.pid === meta.pid && item.meta === undefined);
        assert.ok(birth, `Returned runner has no captured birth; retaining ${root}`); birth.meta = meta;
      }
      return meta;
    };
    const first = launch();
    await waitForFile(ready); // Producer admission and command launch precede deliberate metadata mutation.
    await waitForStatus(stateDir, "running");
    const rememberWorkload = async () => {
      const pid = Number(await readFile(ready, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0); workloads.add(pid);
    };
    await rememberWorkload();
    assert.equal(first.run, "music-player");
    assert.equal(first.singleton, true);
    assert.equal(first.started_at, first.createdAt);
    assert.deepEqual(first.supervision, { report_every_ms: null, max_runtime_ms: null, deadline_at: null });
    assert.deepEqual(first.supervision_provenance, { report_every: "unset", max_runtime: "unset" });
    const beforeReuse = await readFile(join(stateDir, "run.json"), "utf8");
    const catalog = join(getRunStateRoot(), "index.json");
    const firstRegistration = JSON.parse(await readFile(catalog, "utf8")).entries.find((row: { state_dir: string }) => row.state_dir === stateDir);
    assert.equal(firstRegistration.run_instance_id, first.run_instance_id); assert.equal(firstRegistration.ownerId, "session-a");
    const reused = launch();
    assert.equal(reused.reused, true);
    assert.match(compactAsyncRunStatus(reused), /existing Run reused/);
    assert.doesNotMatch(compactAsyncRunStatus(first), /existing Run reused/);
    assert.equal(reused.pid, first.pid);
    assert.equal(reused.run_instance_id, first.run_instance_id);
    assert.equal(reused.started_at, first.started_at);
    assert.deepEqual(reused.supervision, first.supervision);
    assert.equal(reused.catalog_registration, undefined);
    const afterReuse = JSON.parse(await readFile(catalog, "utf8")).entries;
    assert.equal(afterReuse[0].state_dir, stateDir); assert.equal(afterReuse[0].run_instance_id, first.run_instance_id);
    assert.equal(afterReuse.filter((row: { state_dir: string }) => row.state_dir === stateDir).length, 1);
    assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), beforeReuse);
    const stored = JSON.parse(beforeReuse);
    const malformed = { ...stored };
    delete malformed.supervision;
    const malformedBytes = JSON.stringify(malformed);
    writeTextAtomic(join(stateDir, "run.json"), malformedBytes);
    assert.throws(launch, /supervision clock metadata is incomplete/);
    assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), malformedBytes);
    const different = JSON.stringify({
      ...stored,
      supervision: {
        ...stored.supervision,
        max_runtime_ms: 60_000,
        deadline_at: new Date(Date.parse(stored.started_at) + 60_000).toISOString(),
      },
      supervision_provenance: { report_every: "unset", max_runtime: "recipe" },
    });
    writeTextAtomic(join(stateDir, "run.json"), different);
    assert.throws(launch, /incompatible supervision policy/);
    assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), different);
    const legacy = { ...stored };
    delete legacy.started_at;
    delete legacy.supervision;
    delete legacy.supervision_provenance;
    const legacyBytes = JSON.stringify(legacy);
    writeTextAtomic(join(stateDir, "run.json"), legacyBytes);
    const legacyReused = launch();
    assert.equal(legacyReused.reused, true);
    assert.equal(legacyReused.started_at, undefined);
    assert.equal(legacyReused.supervision, undefined);
    assert.equal(await readFile(join(stateDir, "run.json"), "utf8"), legacyBytes);
    writeTextAtomic(join(stateDir, "run.json"), beforeReuse);
    assert.throws(
      () =>
        startRun(
          {
            file: recipe,
            state_dir: stateDir,
            ownerId: "session-a",
            values: { source: "other" },
          },
          process.cwd(),
        ),
      /incompatible Recipe identity, owner, startup values, or Control contract/,
    );
    assert.throws(
      () =>
        startRun(
          { file: alternateRecipe, state_dir: stateDir, ownerId: "session-a" },
          process.cwd(),
        ),
      /incompatible Recipe identity, owner, startup values, or Control contract/,
    );
    assert.throws(
      () =>
        startRun(
          { file: recipe, run_id: "other", state_dir: join(root, "other") },
          process.cwd(),
        ),
      /singleton Recipe run identity is run:music-player/,
    );
    assert.equal(births.length, 1, "Reuse and refusals must not create another runner");
    await writeFile(join(stateDir, "workload-state.json"), "retained\n");
    births[0].stopAttempted = true; cancelRun(stateDir);
    await settle(births[0]);
    await rm(ready);
    const restarted = launch();
    await waitForFile(ready); await rememberWorkload();
    assert.equal(restarted.run, "music-player");
    assert.notEqual(restarted.run_instance_id, first.run_instance_id);
    assert.equal(restarted.started_at, restarted.createdAt);
    assert.deepEqual(restarted.supervision, first.supervision);
    assert.equal(await readFile(join(stateDir, "workload-state.json"), "utf8"), "retained\n");
    assert.equal(births.length, 2); births[1].stopAttempted = true; cancelRun(stateDir); accepted = true;
  }, async () => {
    assert.ok(!dispatched || births.length > 0, `Runner birth remains unknown; retaining ${root}`);
    for (const birth of [...births].reverse()) await settle(birth);
    for (const pid of workloads) {
      for (let i = 0; i < 200 && readProcessLiveness(pid) !== "dead"; i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(readProcessLiveness(pid), "dead", `Captured workload absence remains unproven; retaining ${root}`);
    }
    for (const birth of births) assert.equal(readProcessLiveness(birth.pid!), "dead", `Fresh runner absence unproven; retaining ${root}`);
    for (const pid of workloads) assert.equal(readProcessLiveness(pid), "dead", `Fresh workload absence unproven; retaining ${root}`);
    if (accepted) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed singleton fixture retained: ${root}`);
  }); } finally { spawnHook.mock.restore(); syncBuiltinESMExports(); }
});

test("Singleton reuse rejects a terminal result while its runner process exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-singleton-terminal-"));
  const skillDir = join(root, "service");
  const recipeDir = join(skillDir, "recipes");
  const recipe = join(recipeDir, "worker.json");
  const stateDir = join(root, "state"), ready = join(root, "ready");
  let captured: ReturnType<typeof startRun> | undefined;
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: service\ndescription: Test singleton terminal boundary.\n---\n",
  );
  await writeFile(
    recipe,
    JSON.stringify({
      async: true,
      singleton: true,
      template: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 10000)")} ${JSON.stringify(ready)}`,
    }),
  );
  await withFixtureCleanup(async () => {
    const first = startRun(
      { file: recipe, state_dir: stateDir, ownerId: "session-a" },
      process.cwd(),
    );
    captured = first;
    await waitForFile(ready); // Mutate evidence only after the real workload crossed producer admission.
    await waitForStatus(stateDir, "running");
    await writeFile(
      join(stateDir, "result.json"),
      JSON.stringify({ code: 0, completedAt: new Date().toISOString() }),
    );
    assert.throws(
      () =>
        startRun(
          { file: recipe, state_dir: stateDir, ownerId: "session-a" },
          process.cwd(),
        ),
      /active owned process/,
    );
  }, async () => {
    if (!captured) return; // A throwing start does not prove that no process was born.
    await stopCapturedFixtureRun(captured, stateDir);
    await rm(root, { recursive: true, force: true });
  });
});

test("Async run controls fail closed on persisted process identity mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-process-identity-"));
  const stateDir = join(root, "identity"), ready = join(root, "ready");
  const template = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 30000)")} ${JSON.stringify(ready)}`;
  let captured: ReturnType<typeof startRun> | undefined;
  await withFixtureCleanup(async () => {
    const meta = startRun(
      {
        run_id: "identity",
        state_dir: stateDir,
        template,
      },
      process.cwd(),
    );
    captured = meta;
    assert.equal(typeof meta.process_identity?.start_time, "string");
    await waitForFile(ready);
    assert.deepEqual(readProcessIdentity(meta.pid), meta.process_identity, "Live runner identity must be readable before persisted-only mutation");
    const runPath = join(stateDir, "run.json");
    const stored = JSON.parse(await readFile(runPath, "utf8"));
    await writeFile(
      runPath,
      JSON.stringify({
        ...stored,
        process_identity: {
          ...stored.process_identity,
          start_time: `${stored.process_identity.start_time}-reused`,
        },
      }),
    );
    assert.throws(
      () =>
        startRun(
          {
            run_id: "identity",
            state_dir: stateDir,
            template,
          },
          process.cwd(),
        ),
      /identity does not match the live pid/,
    );
    assert.doesNotThrow(() => process.kill(meta.pid, 0));
    const status = getRunStatus(stateDir);
    assert.equal(status.process_identity_status, "owner_mismatch");
    const cancelled = cancelRun(stateDir);
    assert.equal(cancelled.cancelled, false);
    assert.equal(cancelled.process_identity_status, "owner_mismatch");
    assert.doesNotThrow(() => process.kill(meta.pid, 0));
    await writeFile(runPath, JSON.stringify(stored));
  }, async () => {
    if (!captured) return;
    await stopCapturedFixtureRun(captured, stateDir);
    await rm(root, { recursive: true, force: true });
  });
});

test(
  "Async runs capture process identity from a symlinked launch cwd",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-symlink-cwd-"));
    const realCwd = join(root, "real-cwd");
    const aliasCwd = join(root, "alias-cwd");
    const stateDir = join(root, "state");
    try {
      await mkdir(realCwd);
      await symlink(realCwd, aliasCwd, "dir");
      const meta = startRun(
        {
          run_id: "symlink-cwd",
          state_dir: stateDir,
          template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 3000)"`,
        },
        aliasCwd,
      );
      assert.equal(meta.process_identity?.cwd, await realpath(realCwd));
      assert.equal(getRunStatus(stateDir).process_identity_status, "valid");
      killRun(stateDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Async runs write state files and finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "hello");
  try {
    const meta = startRun(
      {
        run_id: "hello",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('hello ' + process.argv[1])" {name}`,
        values: { name: "world" },
      },
      process.cwd(),
    );
    assert.equal(meta.run, "hello");
    assert.equal(meta.state_schema, "run-kernel-v1");
    assert.equal(meta.ownerId, undefined);
    assert.equal(meta.values.actor_address, undefined);
    assert.equal(meta.values.communication_file, undefined);
    assert.equal(meta.values.default_room, undefined);
    assert.equal(meta.values.trace_file, join(stateDir, "trace.jsonl"));
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const status = getRunStatus(stateDir);
    assert.equal(status.status, "done");
    assert.equal((listRuns(root)[0] || {}).run, "hello");
    assert.match(
      await readFile(join(stateDir, "trace.jsonl"), "utf8"),
      /"kind":"run\.(start|runner\.start|done)"/,
    );
    assert.match(
      await readFile(join(stateDir, "stdout.log"), "utf8"),
      /hello world/,
    );
    const evidence = JSON.parse(
      await readFile(join(stateDir, "execution.json"), "utf8"),
    );
    assert.equal(evidence.version, 1);
    assert.equal(evidence.run, "hello");
    assert.equal(evidence.status, "done");
    assert.equal(evidence.commands.length, 1);
    assert.equal(evidence.commands[0].id, "command-001");
    assert.equal(evidence.commands[0].semantic_acceptance, "not_required");
    assert.deepEqual(evidence.commands[0].attempts, [
      {
        attempt: 1,
        code: 0,
        native_exit_code: 0,
        killed: false,
        stdout: {
          path: "captures/command-001/attempt-001/stdout.log",
          bytes: 12,
        },
        stderr: {
          path: "captures/command-001/attempt-001/stderr.log",
          bytes: 0,
        },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async review evidence rejects marker prefixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-review-marker-"));
  const stateDir = join(root, "review-marker");
  try {
    startRun(
      {
        run_id: "review-marker",
        state_dir: stateDir,
        template: {
          accept_output: "review_evidence",
          template: `${JSON.stringify(process.execPath)} -e "console.log('ACTOR_REVIEW_RESULT_BOGUS')"`,
        },
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    const evidence = await waitForJsonStatus(
      join(stateDir, "execution.json"),
      "failed",
    );
    assert.equal(result.code, 65);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.commands[0].effective_exit_code, 65);
    assert.equal(evidence.commands[0].semantic_acceptance, "rejected");
    const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const commandDone = trace.find(
      (event) => event.kind === "command.done" && event.data?.code === 65,
    );
    assert.equal(commandDone.data.code, 65);
    assert.equal(commandDone.attention, undefined);
    assert.equal(commandDone.level, "error");
    assert.match(commandDone.summary, /code 65/);
    const progress = await waitForJsonField(
      join(stateDir, "progress.json"),
      "phase",
      "failed",
    );
    assert.equal(progress.phase, "failed");
    assert.equal(progress.failures[0].code, 65);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async review evidence accepts a large marker from complete capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-large-review-marker-"));
  const stateDir = join(root, "large-review-marker");
  try {
    startRun(
      {
        run_id: "large-review-marker",
        state_dir: stateDir,
        template: {
          accept_output: "review_evidence",
          template: `${JSON.stringify(process.execPath)} -e "process.stdout.write(['ACTOR_REVIEW_RESULT','X'.repeat(1100000)].join(String.fromCharCode(10)))"`,
        },
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    const evidence = await waitForJsonStatus(
      join(stateDir, "execution.json"),
      "done",
    );
    assert.equal(result.code, 0);
    assert.equal(evidence.status, "done");
    assert.equal(evidence.commands[0].semantic_acceptance, "accepted");
    assert.equal(evidence.commands[0].stdout_truncated, true);
    assert.equal(evidence.commands[0].stdout_bytes, 1_100_020);
  } finally {
    try {
      await waitForRunProcessExit(stateDir);
    } catch {
      // Best-effort synchronization before recursive cleanup.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Async review reports fail closed when complete evidence references are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-review-evidence-"));
  const stateDir = join(root, "review-evidence");
  try {
    startRun(
      {
        run_id: "review-evidence",
        state_dir: stateDir,
        template: [
          {
            actorRecipeContext: { alias: "reviewer", name: "reviewer" },
            accept_output: "review_evidence",
            template: `${JSON.stringify(process.execPath)} -e "console.log(['ACTOR_REVIEW_RESULT','review'].join(String.fromCharCode(10)))"`,
          },
          {
            actorRecipeContext: { alias: "normalizer", name: "normalizer" },
            accept_output: "review_evidence",
            template: `${JSON.stringify(process.execPath)} -e "console.log(['ACTOR_REVIEW_RESULT','## Status','complete'].join(String.fromCharCode(10)))"`,
          },
        ],
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    const evidence = JSON.parse(
      await readFile(join(stateDir, "execution.json"), "utf8"),
    );
    assert.equal(result.code, 65, JSON.stringify(evidence));
    assert.equal(result.failure_reason, "incomplete review report evidence");
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.report_evidence.claims_complete, true);
    assert.equal(evidence.report_evidence.complete_allowed, false);
    assert.deepEqual(evidence.report_evidence.missing, [
      "execution.json#command-001",
    ]);
    const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const commandDone = trace.filter((event) => event.kind === "command.done");
    assert.equal(commandDone.length, 2);
    assert.equal(
      commandDone.every((event) => event.attention === undefined),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs persist bounded high-volume command captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-capture-"));
  const stateDir = join(root, "capture");
  try {
    startRun(
      {
        run_id: "capture",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "process.stdout.write('A'.repeat(1100000)); process.stderr.write('B'.repeat(1100000))"`,
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const trace = await readFile(join(stateDir, "trace.jsonl"), "utf8");
    assert.match(trace, /"stdout_bytes":1100000/);
    assert.match(trace, /"stderr_bytes":1100000/);
    assert.match(trace, /"stdout_truncated":true/);
    assert.match(trace, /"stderr_truncated":true/);
    assert.equal(
      (await readFile(join(stateDir, "captures", "command-001", "attempt-001", "stdout.log"), "utf8")).length,
      1100000,
    );
    assert.equal(
      (await readFile(join(stateDir, "captures", "command-001", "attempt-001", "stderr.log"), "utf8")).length,
      1100000,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async lifecycle status files preserve terminal semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-lifecycle-"));
  const exitedDir = join(root, "exited-before-result");
  const cancelledDir = join(root, "cancelled-before-result");
  const killedDir = join(root, "killed-before-result");
  try {
    await mkdir(exitedDir, { recursive: true });
    await writeFile(
      join(exitedDir, "run.json"),
      JSON.stringify({ pid: 0, run: "exited-before-result", state_dir: exitedDir }),
    );
    await writeFile(join(exitedDir, "trace.jsonl"), `${JSON.stringify({ kind: "run.start" })}\n`);
    assert.equal(getRunStatus(exitedDir).status, "exited");
    assert.match(tailRun(exitedDir), /run\.start/);
    await mkdir(cancelledDir, { recursive: true });
    await writeFile(
      join(cancelledDir, "run.json"),
      JSON.stringify({ pid: 0, run: "cancelled-before-result", state_dir: cancelledDir }),
    );
    await writeFile(join(cancelledDir, "trace.jsonl"), `${JSON.stringify({ kind: "run.cancel" })}\n`);
    assert.equal(getRunStatus(cancelledDir).status, "cancelled");
    await mkdir(killedDir, { recursive: true });
    await writeFile(
      join(killedDir, "run.json"),
      JSON.stringify({ pid: 0, run: "killed-before-result", state_dir: killedDir }),
    );
    await writeFile(join(killedDir, "trace.jsonl"), `${JSON.stringify({ kind: "run.kill" })}\n`);
    assert.equal(getRunStatus(killedDir).status, "killed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs emit command completion Trace events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "command-trace");
  const longArg = "x".repeat(220);
  try {
    startRun(
      {
        run_id: "command-trace",
        state_dir: stateDir,
        defaults: { report_path: "{state_dir}/report.md" },
        artifacts: {
          report: "{report_path}",
          summary: "{state_dir}/result.json",
        },
        template: `${JSON.stringify(process.execPath)} -e "console.log('artifact')" ${longArg}`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const commandDone = trace.find(
      (entry) => entry.kind === "command.done" && typeof entry.summary === "string",
    )!;
    const status = getRunStatus(stateDir);
    assert.deepEqual(status.artifacts, {
      report: `${stateDir}/report.md`,
      summary: `${stateDir}/result.json`,
    });
    assert.equal(commandDone.kind, "command.done");
    assert.equal(Object.hasOwn(commandDone, "type"), false);
    assert.equal(Object.hasOwn(commandDone, "to"), false);
    assert.equal(Object.hasOwn(commandDone, "from"), false);
    assert.equal(commandDone.attention, undefined);
    assert.match(String(commandDone.summary), /completed with code 0/);
    assert.equal(String(commandDone.summary).includes(longArg), false);
    assert.match(
      String((commandDone.data as Record<string, unknown>).command),
      new RegExp(longArg),
    );
    const commandData = commandDone.data as Record<string, unknown>;
    const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8"));
    assert.equal(commandData.artifacts, undefined);
    assert.deepEqual(commandData.artifact_inventory, result.artifact_inventory);
    assert.equal((commandData.artifact_inventory as Record<string, unknown>).declarations_total, 2);
    assert.equal(Object.hasOwn(commandDone, "body"), false);
    assert.deepEqual(
      (commandDone.data as Record<string, unknown>).run_files,
      [
        join(stateDir, "stdout.log"),
        join(stateDir, "stderr.log"),
        join(stateDir, "result.json"),
        join(stateDir, "trace.jsonl"),
        join(stateDir, "execution.json"),
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs expose failed terminal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "failed");
  try {
    startRun(
      {
        run_id: "failed",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 7);
    assert.equal(getRunStatus(stateDir).status, "failed");
    assert.equal((listRuns(root)[0] || {}).status, "failed");
    assert.equal(listRuns(root, "running").length, 0);
    assert.equal(listRuns(root, "terminal").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run restart clears all prior bounded evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "restart");
  try {
    startRun(
      {
        run_id: "restart",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('first')"`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    assert.equal(getRunStatus(stateDir).status, "done");
    await waitForRunProcessExit(stateDir);
    for (let index = 0; index < Limits.TRACE_JOURNAL_MAX_EVENTS + 1; index += 1)
      appendRunTraceEvent(stateDir, { kind: "restart.pressure", data: { index } });
    for (let index = 0; index < Limits.RUN_CONTROL_PENDING_LIMIT; index += 1)
      appendRunControlInStateDir(stateDir, {
        action: "pause", input: { index }, run_instance_id: String(getRunStatus(stateDir).run_instance_id),
      });
    await writeFile(join(stateDir, "control-endpoint.json"), "{}\n");
    assert.equal(summarizeRunTraceJournal(readRunTraceJournal(stateDir)).compacted, true);
    startRun(
      {
        run_id: "restart",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    const status = getRunStatus(stateDir);
    assert.equal(status.status, "running");
    assert.equal(status.result, null);
    assert.equal(existsSync(join(stateDir, "controls.jsonl")), false);
    assert.equal(existsSync(join(stateDir, "control-endpoint.json")), false);
    const trace = readRunTraceJournal(stateDir);
    const kinds = trace.events.map(({ event }) => event.kind);
    assert.equal(kinds.includes("run.start"), true);
    assert.equal(kinds.includes("restart.pressure"), false);
    assert.equal(summarizeRunTraceJournal(trace).compacted, false);
  } finally {
    try {
      cancelRun(stateDir);
    } catch {}
    await waitForRunProcessExit(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs persist coordinator owner ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "owned");
  try {
    const meta = startRun(
      {
        run_id: "owned",
        ownerId: "session-a",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('owned')"`,
      },
      process.cwd(),
    );
    assert.equal(meta.ownerId, "session-a");
    await waitForResult(stateDir);
    assert.equal(getRunStatus(stateDir).ownerId, "session-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs can start from recipe files with overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "file-run");
  const file = join(root, "say.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          control: ["continue"],
          retire_when: "children_terminal",
          template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1] + ' ' + process.argv[2])" {greeting} {name}`,
          values: { greeting: "hello", name: "file" },
        },
        null,
        2,
      ),
    );
    const meta = startRun(
      { file: "./say.json", run_id: "override-run", state_dir: stateDir, values: { name: "override" } },
      root,
    );
    assert.equal(meta.run, "override-run");
    assert.equal(meta.recipe, "say");
    assert.equal(meta.values.greeting, "hello");
    assert.deepEqual(meta.control, ["continue"]);
    assert.equal(meta.retire_when, "children_terminal");
    assert.equal(meta.values.name, "override");
    assert.equal(meta.values.run_id, "override-run");
    assert.equal(meta.values.state_dir, stateDir);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(
      await readFile(join(stateDir, "stdout.log"), "utf8"),
      /hello override/,
    );
  } finally {
    // Accepted result data can precede final Trace publication and process exit.
    if (existsSync(join(stateDir, "run.json"))) await waitForRunProcessExit(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async file Recipes expand runtime-owned recipe directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-origin-"));
  const skillDir = join(root, "skill");
  const recipeDir = join(skillDir, "recipes");
  const stateDir = join(root, "run");
  try {
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill\n");
    const file = join(recipeDir, "origin.json");
    await writeFile(
      file,
      JSON.stringify({
        artifacts: { report: "{recipe_dir}/report.md" },
        defaults: { helper: "{skill_dir}/scripts/helper.mjs" },
        template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1] + '|' + process.argv[2] + '|' + process.argv[3])" {recipe_dir} {skill_dir} {helper}`,
      }),
    );
    const meta = startRun(
      {
        file,
        run_id: "origin",
        state_dir: stateDir,
        values: { recipe_dir: "/caller", skill_dir: "/caller-skill" },
      },
      process.cwd(),
    );
    assert.equal(meta.values.recipe_dir, recipeDir);
    assert.equal(meta.values.skill_dir, skillDir);
    assert.deepEqual(meta.artifacts, { report: `${recipeDir}/report.md` });
    await waitForResult(stateDir);
    assert.equal(
      (await readFile(join(stateDir, "stdout.log"), "utf8")).trim(),
      `${recipeDir}|${skillDir}|${skillDir}/scripts/helper.mjs`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async Recipe values follow caller then values then defaults then inline precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-precedence-"));
  const file = join(root, "mode.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        args: ["mode:enum(inline,default,bound,caller)=inline"],
        defaults: { mode: "default" },
        values: { mode: "bound" },
        template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1])" {mode}`,
      }),
    );
    const boundState = join(root, "bound");
    const bound = startRun(
      { file, run_id: "bound", state_dir: boundState },
      process.cwd(),
    );
    assert.equal(bound.values.mode, "bound");
    await waitForResult(boundState);
    const callerState = join(root, "caller");
    const caller = startRun(
      {
        file,
        run_id: "caller",
        state_dir: callerState,
        values: { mode: "caller" },
      },
      process.cwd(),
    );
    assert.equal(caller.values.mode, "caller");
    await waitForResult(callerState);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async Recipes reject invalid typed values and unknown defaults before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-contract-"));
  try {
    const invalidEnum = join(root, "invalid-enum.json");
    await writeFile(
      invalidEnum,
      JSON.stringify({
        args: ["mode:enum(check,fix)=check"],
        values: { mode: "delete" },
        template: "echo {mode}",
      }),
    );
    assert.throws(
      () => startRun({ file: invalidEnum, run_id: "invalid" }, process.cwd()),
      /Argument mode must be one of: check, fix/,
    );
    const unknownDefault = join(root, "unknown-default.json");
    await writeFile(
      unknownDefault,
      JSON.stringify({
        args: ["mode:enum(check,fix)"],
        defaults: { typo: "check" },
        template: "echo {mode}",
      }),
    );
    assert.throws(
      () => startRun({ file: unknownDefault, run_id: "unknown" }, process.cwd()),
      /Unknown Recipe default argument: typo/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs reject disabled recipe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-disabled-"));
  const file = join(root, "disabled.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ disabled: true, template: "echo disabled" }, null, 2),
    );
    assert.throws(
      () => startRun({ file, run_id: "disabled-run" }, process.cwd()),
      /Template recipe is disabled:/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs can start from Markdown recipe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-md-"));
  const stateDir = join(root, "md-run");
  const file = join(root, "say-md.md");
  try {
    await writeFile(
      file,
      [
        "---",
        "defaults:",
        "  greeting: hello",
        "---",
        "",
        "```template",
        `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1])" {greeting}`,
        "```",
        "",
      ].join("\n"),
    );
    const meta = startRun({ file, state_dir: stateDir }, process.cwd());
    assert.equal(meta.recipe, "say-md");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs persist recipe context bundles for file-backed recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-context-"));
  const stateDir = join(root, "context-run");
  const child = join(root, "child.json");
  const parent = join(root, "parent.json");
  try {
    await writeFile(
      child,
      JSON.stringify({ template: `${JSON.stringify(process.execPath)} -e "console.log('child')"` }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: { child_step: "child.json" },
        template: [{ name: "child_step" }],
      }),
    );
    const meta = startRun({ file: parent, state_dir: stateDir }, process.cwd());
    assert.equal(meta.recipe_context_records?.length, 2);
    assert.deepEqual(
      meta.recipe_context_records?.map((record) => ({
        alias: record.alias,
        importPath: record.import_path,
        logicalReference: record.logical_reference,
        name: record.name,
        role: record.role,
        sourceKind: record.source_kind,
      })),
      [
        {
          alias: undefined,
          importPath: [],
          logicalReference: "parent.json",
          name: "parent",
          role: "entry",
          sourceKind: "explicit_file_recipe",
        },
        {
          alias: "child_step",
          importPath: ["child_step"],
          logicalReference: "child.json",
          name: "child",
          role: "import",
          sourceKind: "explicit_file_recipe",
        },
      ],
    );
    assert.match(JSON.stringify(meta.template), /actorRecipeContext/);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async Skill Recipes capture logical provenance and private physical source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-skill-context-"));
  const skillDir = join(root, "sample");
  const recipeDir = join(skillDir, "recipes");
  const stateDir = join(root, "skill-run");
  try {
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Sample\n");
    await writeFile(join(recipeDir, "task.json"), JSON.stringify({ template: "echo ok" }));
    const skillContext = createActiveSkillRecipeContext([
      { name: "sample", baseDir: skillDir },
    ]);
    const meta = startRun(
      { file: "sample/task", state_dir: stateDir },
      process.cwd(),
      { skillContext },
    );
    assert.deepEqual(meta.recipe_context_records?.map((record) => ({
      logicalReference: record.logical_reference,
      role: record.role,
      skill: record.skill,
      sourceFile: record.source_file,
      sourceKind: record.source_kind,
    })), [{
      logicalReference: "sample/task",
      role: "entry",
      skill: "sample",
      sourceFile: join(recipeDir, "task.json"),
      sourceKind: "active_skill_component",
    }]);
    await waitForResult(stateDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async Pi commands persist owned session provenance in review evidence", {
  skip: process.platform === "win32" ? "uses a POSIX shebang fake pi executable" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-session-"));
  const stateDir = join(root, "session-run");
  const fakePi = join(root, "pi");
  let settled = false;
  try {
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        'const { mkdirSync, writeFileSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'const index = process.argv.indexOf("--session-dir");',
        'if (index >= 0) {',
        '  const dir = process.argv[index + 1];',
        '  mkdirSync(dir, { recursive: true });',
        '  writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "test", cwd: process.cwd() }) + "\\n");',
        '}',
        'console.log("done");',
      ].join("\n"),
    );
    await chmod(fakePi, 0o755);
    startRun(
      { state_dir: stateDir, template: `${fakePi} -p inspect turns` },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const evidence = JSON.parse(
      await readFile(join(stateDir, "execution.json"), "utf8"),
    );
    assert.equal(evidence.commands[0].session_dir, "sessions/command-001");
    assert.deepEqual(evidence.commands[0].session_files, [
      "sessions/command-001/session.jsonl",
    ]);
    assert.match(evidence.commands[0].command, /--session-dir/);
    const output = result.output as Readonly<import("../lib/runs-outcomes.ts").RunPrimaryTextOutput>;
    assert.equal(output.text_basis, "actor_response"); assert.equal(output.upstream_truncated, false);
    assert.equal(await readFile(output.source.path, "utf8"), "done\n");
    assert.doesNotMatch(output.preview, /--session-dir|inspect turns/);
    const nontextDir = join(root, "json-session-run");
    startRun({ state_dir: nontextDir, template: `${fakePi} --mode json -p inspect turns` }, process.cwd());
    const nontext = await waitForResult(nontextDir);
    assert.equal(nontext.code, 0); assert.equal(nontext.output, null); assert.equal(nontext.output_unavailable, "selection_not_supported");
    await waitForRunProcessExit(stateDir); await waitForRunProcessExit(nontextDir); settled = true;
  } finally {
    if (settled) await rm(root, { recursive: true, force: true });
  }
});

test("Async runs allow recipes to opt out of actor recipe context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-context-off-"));
  const stateDir = join(root, "context-off-run");
  const file = join(root, "quiet.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        actor_context: false,
        template: `${JSON.stringify(process.execPath)} -e "console.log('quiet')"`,
      }),
    );
    const meta = startRun({ file, state_dir: stateDir }, process.cwd());
    assert.equal(meta.recipe_context_records, undefined);
    assert.doesNotMatch(JSON.stringify(meta.template), /actorRecipeContext/);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe files can put command-template flags at the recipe top level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "top-level-parallel");
  const file = join(root, "parallel.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          parallel: true,
          template: [
            `${JSON.stringify(process.execPath)} -e "console.log('left')"`,
            `${JSON.stringify(process.execPath)} -e "console.log('right')"`,
          ],
        },
        null,
        2,
      ),
    );
    const meta = startRun({ file, state_dir: stateDir }, process.cwd());
    assert.equal(meta.run, "parallel");
    assert.equal(typeof meta.template, "object");
    assert.equal(Array.isArray(meta.template), false);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    assert.match(stdout, /left/);
    assert.match(stdout, /right/);
    const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const commandDone = trace.filter((event) => event.kind === "command.done");
    assert.equal(commandDone.length, 2);
    assert.equal(
      commandDone.every((event) => event.attention === undefined),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Parallel branch failure remains Trace-only when the root Run succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-soft-quorum-"));
  const stateDir = join(root, "soft-quorum");
  try {
    startRun(
      {
        ownerId: "session-a",
        run_id: "soft-quorum",
        state_dir: stateDir,
        template: [
          {
            parallel: true,
            template: [
              `${JSON.stringify(process.execPath)} -e "console.log('usable')"`,
              `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
            ],
          },
          `${JSON.stringify(process.execPath)} -e "process.stdin.pipe(process.stdout)"`,
        ],
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const commandDone = trace.filter((event) => event.kind === "command.done");
    assert.equal(commandDone.length, 3);
    assert.deepEqual(
      commandDone
        .map((event) => Number((event.data as Record<string, unknown>).code))
        .sort(),
      [0, 0, 7],
    );
    assert.equal(
      commandDone.every((event) => event.attention === undefined),
      true,
    );
    const state = createRunUiObservationState();
    const snapshot = readRunUiSnapshot(state, "session-a", {
      includeAttention: true,
      stateRoot: root,
    });
    assert.equal(snapshot.transitions.length, 1);
    assert.equal(snapshot.transitions[0].run, "soft-quorum");
    assert.deepEqual(snapshot.attentionEvents, []);
    pruneRunUiObservationState(state, snapshot);
    assert.equal(
      readRunUiSnapshot(state, "session-a", { includeAttention: true, stateRoot: root })
        .transitions.length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe imports execute under repeated parallel parent nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "import-repeat");
  const child = join(root, "child.json");
  const parent = join(root, "parent.json");
  try {
    await writeFile(
      child,
      JSON.stringify(
        {
          args: ["word:string"],
          template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1])" {word}-{index}-{_index}`,
        },
        null,
        2,
      ),
    );
    await writeFile(
      parent,
      JSON.stringify(
        {
          imports: {
            node: {
              from: "child.json",
              values: { word: "base" },
            },
          },
          repeat: 3,
          parallel: true,
          failure: "branch",
          template: {
            name: "node",
            values: { word: "{index}" },
          },
        },
        null,
        2,
      ),
    );
    const meta = startRun({ file: parent, state_dir: stateDir }, process.cwd());
    assert.equal(meta.run, "parent");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(String(result.command), /0-0-00/);
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    assert.match(stdout, /0-0-00/);
    assert.match(stdout, /1-1-01/);
    assert.match(stdout, /2-2-02/);
    const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const commandDone = trace.filter((event) => event.kind === "command.done");
    assert.equal(commandDone.length, 3);
    assert.equal(
      commandDone.every((event) => event.attention === undefined),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Async run process control maps Windows force kill to taskkill tree", () => {
  assert.deepEqual(getRunProcessSignalPlan(1234, "SIGKILL", "win32"), {
    args: ["/PID", "1234", "/T", "/F"],
    command: "taskkill",
    signalTarget: "processTree",
  });
  assert.deepEqual(getRunProcessSignalPlan(1234, "SIGTERM", "win32"), {
    args: ["/PID", "1234", "/T"],
    command: "taskkill",
    signalTarget: "processTree",
  });
});

test("Async run cancel terminates matching running runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "running");
  try {
    startRun(
      {
        run_id: "running",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (getRunStatus(stateDir).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = cancelRun(stateDir);
    assert.equal(result.cancelled, true);
    const status = await waitForStatus(stateDir, "cancelled");
    assert.equal(status.status, "cancelled");
    const handled = status.terminal_handled as Record<string, unknown>;
    assert.deepEqual(handled, {
      event: "run.cancel",
      signal: "SIGTERM",
      ts: handled.ts,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async cancel and kill finalize in-flight review evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-interrupted-evidence-"));
  try {
    for (const mode of ["cancelled", "killed"] as const) {
      const stateDir = join(root, mode);
      startRun(
        {
          run_id: `review-${mode}`,
          state_dir: stateDir,
          template: {
            accept_output: "review_evidence",
            template: `${JSON.stringify(process.execPath)} -e "process.stdout.write('partial');setInterval(()=>{},1000)"`,
          },
        },
        process.cwd(),
      );
      let runningEvidence: any;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          runningEvidence = JSON.parse(
            await readFile(join(stateDir, "execution.json"), "utf8"),
          );
          if (runningEvidence.commands?.[0]?.status === "running") break;
        } catch {
          // Runner has not initialized evidence yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(runningEvidence?.commands?.[0]?.status, "running");
      const captureFile = join(
        stateDir,
        "captures/command-001/attempt-001/stdout.log",
      );
      await waitForFileContent(captureFile, /partial/, 7);
      if (mode === "cancelled") cancelRun(stateDir);
      else killRun(stateDir);
      await waitForStatus(stateDir, mode);
      const evidence = JSON.parse(
        await readFile(join(stateDir, "execution.json"), "utf8"),
      );
      assert.equal(evidence.status, mode);
      assert.equal(evidence.commands[0].status, mode);
      assert.equal(evidence.commands[0].killed, true);
      assert.equal(
        evidence.commands[0].effective_exit_code,
        mode === "killed" ? 137 : 143,
      );
      assert.equal(evidence.commands[0].semantic_acceptance, "interrupted");
      assert.equal(evidence.commands[0].attempts.length, 1);
      assert.equal(evidence.commands[0].attempts[0].stdout.bytes, 7);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel signals the running command process group", {
  skip: process.platform === "win32" ? "Windows cancellation uses taskkill process-tree semantics" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "running-group");
  const pidFile = join(root, "child.pid");
  const termFile = join(root, "child.term");
  let childPid = 0;
  try {
    startRun(
      {
        run_id: "running-group",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>(fs.writeFileSync(process.argv[2],'term'),process.exit(0)));setTimeout(()=>0,5000)" {pidFile} {termFile}`,
        values: { pidFile, termFile },
      },
      process.cwd(),
    );
    await waitForFile(pidFile);
    childPid = Number(await readFile(pidFile, "utf8"));
    const result = cancelRun(stateDir);
    assert.equal(result.cancelled, true);
    await waitForFile(termFile);
    assert.equal(await readFile(termFile, "utf8"), "term");
  } finally {
    if (childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already stopped by process-group cancellation.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run status keeps killed runs diagnosable with stale progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-killed-stale-progress-"));
  const stateDir = join(root, "stale-progress");
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      `${JSON.stringify({ created_at: new Date().toISOString(), pid: 0, run: "stale-progress", state_dir: stateDir })}\n`,
    );
    await writeFile(
      join(stateDir, "trace.jsonl"),
      `${JSON.stringify({ kind: "run.kill", data: { signal: "SIGKILL" }, ts: new Date().toISOString() })}\n`,
    );
    await writeFile(
      join(stateDir, "progress.json"),
      `${JSON.stringify({ activeSubagents: 2, phase: "running" })}\n`,
    );
    const status = getRunStatus(stateDir);
    assert.equal(status.status, "killed");
    assert.deepEqual(status.progress, { activeSubagents: 2, phase: "running" });
    assert.match(tailRun(stateDir), /run\.kill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run kill terminates matching stuck runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "stuck");
  try {
    startRun(
      {
        run_id: "stuck",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (getRunStatus(stateDir).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = killRun(stateDir);
    assert.equal(result.killed, true, JSON.stringify(result));
    assert.equal(result.signal, "SIGKILL");
    const status = await waitForStatus(stateDir, "killed");
    assert.equal(status.status, "killed");
    const handled = status.terminal_handled as Record<string, unknown>;
    assert.deepEqual(handled, {
      event: "run.kill",
      signal: "SIGKILL",
      ts: handled.ts,
    });
    const progress = status.progress as Record<string, unknown>;
    assert.equal(progress.phase, "killed");
    assert.equal(Object.hasOwn(progress, "activeSubagents"), false);
    assert.match(await readFile(join(stateDir, "trace.jsonl"), "utf8"), /"kind":"run\.kill"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Canonical kill rejects a replacement run generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-generation-fence-"));
  const stateDir = join(root, "replacement");
  try {
    startRun(
      {
        ownerId: "session-a",
        run_id: "replacement",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    const current = getRunStatus(stateDir);
    const result = killRun(stateDir, {
      ownerId: "session-a",
      runInstanceId: "superseded-instance",
    });
    assert.equal(result.killed, false);
    assert.equal(result.reason, "run generation changed");
    assert.equal(getRunStatus(stateDir).status, "running");
    assert.equal(
      getRunStatus(stateDir).run_instance_id,
      current.run_instance_id,
    );
  } finally {
    try {
      killRun(stateDir);
    } catch {
      /* best effort */
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Same-directory restart cannot cross held canonical control", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-restart-race-"));
  const stateDir = join(root, "replacement");
  const readyPath = join(root, "control-ready");
  const releasePath = join(root, "control-release");
  const blockedPath = join(root, "restart-blocked");
  const controlConfig = join(root, "control.json");
  const restartConfig = join(root, "restart.json");
  const workers: Promise<unknown>[] = [];
  try {
    startRun(
      {
        ownerId: "session-a",
        run_id: "replacement",
        state_dir: stateDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 150)"`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    await waitForRunProcessExit(stateDir);
    const initial = getRunStatus(stateDir);
    await writeFile(controlConfig, JSON.stringify({
      mode: "control",
      readyPath,
      releasePath,
      stateDir,
    }));
    await writeFile(restartConfig, JSON.stringify({
      blockedPath,
      mode: "restart",
      stateDir,
    }));
    const runWorker = (config: string) =>
      execFileAsync(process.execPath, [
        "--experimental-strip-types",
        controlRaceWorker,
        config,
      ]);
    const waitForFile = async (path: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (existsSync(path)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${path}`);
    };
    const settle = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ error, ok: false as const }),
      );
    const control = settle(runWorker(controlConfig));
    workers.push(control);
    await waitForFile(readyPath);
    const restart = settle(runWorker(restartConfig));
    workers.push(restart);
    await waitForFile(blockedPath);
    try {
      assert.equal(getRunStatus(stateDir).run_instance_id, initial.run_instance_id);
      assert.notEqual(getRunStatus(stateDir).status, "running");
    } finally {
      await writeFile(releasePath, "release\n");
    }
    const outcomes = await Promise.all([control, restart]);
    assert.equal(outcomes[0]!.ok, true);
    assert.equal(outcomes[1]!.ok, true);
    const replacement = getRunStatus(stateDir);
    assert.equal(replacement.status, "running");
    assert.notEqual(replacement.run_instance_id, initial.run_instance_id);
    assert.equal(replacement.ownerId, "session-b");
  } finally {
    await writeFile(releasePath, "release\n");
    await Promise.all(workers);
    try {
      killRun(stateDir);
    } catch {
      /* best effort */
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Parent teardown kills only exact-session runs through canonical run control", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-parent-teardown-"));
  const ownedDir = join(root, "owned");
  const otherDir = join(root, "other");
  try {
    startRun(
      {
        ownerId: "session-a",
        run_id: "owned",
        state_dir: ownedDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    startRun(
      {
        ownerId: "session-b",
        run_id: "other",
        state_dir: otherDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (
        getRunStatus(ownedDir).status === "running" &&
        getRunStatus(otherDir).status === "running"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = teardownRunsOwnedByParent("session-a", root, {
      trigger: "session_shutdown:quit",
    });
    assert.equal(result.killed, 1);
    assert.equal(result.failed, 0);
    assert.equal(typeof result.summaryPath, "string");
    const teardownSummary = JSON.parse(
      await readFile(result.summaryPath!, "utf8"),
    );
    assert.equal(teardownSummary.ownerId, "session-a");
    assert.equal(teardownSummary.trigger, "session_shutdown:quit");
    assert.equal(teardownSummary.killed, 1);
    assert.equal(
      (await waitForStatus(ownedDir, "killed", process.platform === "win32" ? 200 : 40))
        .status,
      "killed",
    );
    assert.equal(getRunStatus(otherDir).status, "running");
    const trace = await readFile(join(ownedDir, "trace.jsonl"), "utf8");
    assert.match(trace, /"kind":"run\.kill"/);
    assert.match(trace, /"kind":"run\.parent_teardown"/);
    assert.doesNotMatch(trace, /"type":"control\.kill"/);
    assert.match(trace, /"trigger":"session_shutdown:quit"/);
  } finally {
    try {
      killRun(otherDir);
    } catch {
      /* best effort */
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Parent teardown persists corrupt-state discovery failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-parent-teardown-corrupt-"));
  const corruptDir = join(root, "corrupt");
  try {
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "run.json"), "{not-json\n");
    const result = teardownRunsOwnedByParent("session-a", root, {
      trigger: "session_shutdown:reload",
    });
    assert.equal(result.attempted, 0);
    assert.equal(result.discoveryFailed, 1);
    assert.equal(result.failed, 1);
    assert.equal(typeof result.summaryPath, "string");
    const summary = JSON.parse(await readFile(result.summaryPath!, "utf8"));
    assert.equal(summary.discoveryFailed, 1);
    assert.equal(summary.discoveryFailures[0].path, corruptDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run retirement smoke stops supervisor after nested child is terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retire-smoke-"));
  const supervisorDir = join(root, "supervisor");
  const childDir = join(supervisorDir, "child");
  const serviceDir = join(root, "service");
  try {
    startRun(
      {
        run_id: "supervisor",
        state_dir: supervisorDir,
        retire_when: "children_terminal",
        template: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    startRun(
      {
        run_id: "child",
        state_dir: childDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('child done')"`,
      },
      process.cwd(),
    );
    startRun(
      {
        run_id: "service",
        state_dir: serviceDir,
        template: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    await waitForResult(childDir);
    await writeFile(
      join(supervisorDir, "progress.json"),
      JSON.stringify({ activeSubagents: 0, completed: 1, failures: [], updatedAt: new Date().toISOString() }),
    );
    const summary = summarizeRuns(root);
    assert.deepEqual(
      summary.runs.map((run) => run.run).sort(),
      ["child", "service", "supervisor"],
    );
    const results = await executeRunRetirements(summary, {
      cancelRun: (candidate) => cancelRun(candidate.stateDir),
      sendStop: async () => { throw new Error("no actor-local stop action"); },
    });
    assert.deepEqual(results, [
      { action: "cancel", run: "supervisor", stateDir: supervisorDir },
    ]);
    assert.equal((await waitForStatus(supervisorDir, "cancelled", 200)).status, "cancelled");
    assert.equal(getRunStatus(childDir).status, "done");
    assert.equal(getRunStatus(serviceDir).status, "running");
    assert.match(
      await readFile(join(supervisorDir, "trace.jsonl"), "utf8"),
      /"kind":"run\.cancel"/,
    );
  } finally {
    try {
      cancelRun(supervisorDir);
    } catch {
      // Best-effort cleanup for the long-running supervisor process.
    }
    try {
      cancelRun(serviceDir);
    } catch {
      // Best-effort cleanup for the non-retiring service process.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel consistently classifies completed-run races as not running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-completed-cancel-"));
  try {
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const stateDir = join(root, `done-${iteration}`);
      startRun(
        {
          run_id: `done-${iteration}`,
          state_dir: stateDir,
          template: `${JSON.stringify(process.execPath)} -e "console.log('done')"`,
        },
        process.cwd(),
      );
      await waitForResult(stateDir);
      const result = cancelRun(stateDir);
      assert.equal(result.cancelled, false, JSON.stringify(result));
      assert.equal(result.reason, "not running", JSON.stringify(result));
      assert.equal("process_identity_status" in result, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run state index rebuilds and corrupt index falls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-index-"));
  const parentDir = join(root, "parent");
  const childDir = join(parentDir, "child");
  try {
    // Controlled owned metadata/legacy display outcomes, not launched work or native exits.
    for (const [stateDir, run] of [[parentDir, "index-parent"], [childDir, "index-child"]]) {
      claimRunStateDirectory(stateDir, run);
      await writeFile(join(stateDir, "run.json"), JSON.stringify({ run, state_dir: stateDir,
        ownerId: "session-a", run_instance_id: `generation-${run}`, pid: 0,
        createdAt: "2001-01-01T00:00:00.000Z" }));
      await writeFile(join(stateDir, "result.json"), JSON.stringify({ code: 0 }));
    }
    const index = rebuildRunStateIndex(root);
    assert.equal(index.length, 2);
    assert.deepEqual(index.map((entry) => entry.state_dir).sort(), [childDir, parentDir].sort());
    assert.equal(readRunStateIndex(root)?.length, 2);
    assert.equal(listRuns(root, "done").length, 2);
    await writeFile(join(root, "index.json"), "not-json");
    assert.equal(listRuns(root, "done").length, 2);
    assert.equal(readRunStateIndex(root), undefined);
    assert.equal(await readFile(join(root, "index.json"), "utf8"), "not-json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run archive and prune only allow terminal run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retention-"));
  const activeDir = join(root, "active");
  const doneDir = join(root, "done");
  const pruneDir = join(root, "prune");
  const failedPruneDir = join(root, "failed-prune");
  try {
    startRun(
      {
        run_id: `active-${process.pid}-${Date.now()}`,
        state_dir: activeDir,
        template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 3000)"`,
      },
      process.cwd(),
    );
    assert.throws(() => archiveRun(activeDir), /Only terminal runs/);
    assert.throws(() => pruneRun(activeDir), /Only terminal runs/);
    killRun(activeDir);
    startRun(
      {
        run_id: `archive-${process.pid}-${Date.now()}`,
        state_dir: doneDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(doneDir);
    for (let index = 0; index < Limits.TRACE_JOURNAL_MAX_EVENTS + 1; index += 1)
      appendRunTraceEvent(doneDir, { kind: "archive.pressure", data: { index } });
    const archived = archiveRun(doneDir);
    assert.equal(archived.archived, true);
    await readFile(join(doneDir, "archive-tombstone.json"), "utf8");
    const archiveDir = String(archived.archive_dir);
    await readFile(join(archiveDir, "run.json"), "utf8");
    const archivedTrace = readRunTraceJournal(archiveDir);
    assert.equal(summarizeRunTraceJournal(archivedTrace).compacted, true);
    assert.ok(archivedTrace.fileBytes <= Limits.TRACE_JOURNAL_MAX_BYTES);
    startRun(
      {
        artifacts: {
          first: { path: "{state_dir}/one/report.txt", required: true },
          second: { path: "{state_dir}/two/report.txt", required: true },
          optional: { path: "{state_dir}/missing/report.txt", required: false },
        },
        run_id: `prune-${process.pid}-${Date.now()}`,
        state_dir: pruneDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(pruneDir);
    await mkdir(join(pruneDir, "one"), { recursive: true });
    await mkdir(join(pruneDir, "two"), { recursive: true });
    await writeFile(join(pruneDir, "one", "report.txt"), "first");
    await writeFile(join(pruneDir, "two", "report.txt"), "second");
    const pruned = pruneRun(pruneDir, { preserveArtifacts: true });
    assert.equal(pruned.pruned, true);
    const preserved = pruned.preserved_artifacts as Record<string, string>;
    assert.notEqual(preserved.first, preserved.second);
    assert.equal(await readFile(preserved.first, "utf8"), "first");
    assert.equal(await readFile(preserved.second, "utf8"), "second");
    assert.equal(preserved.optional, undefined);
    assert.throws(() => getRunStatus(pruneDir), /Run not found/);
    const retention = (await readFile(join(root, "retention.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      retention.map((record) => [record.action, record.outcome]),
      [
        ["archive", "queued"],
        ["archive", "handled"],
        ["prune", "queued"],
        ["prune", "handled"],
      ],
    );
    assert.equal(retention[0].id, retention[1].id);
    assert.equal(retention[2].id, retention[3].id);
    assert.equal(archived.retention_id, retention[0].id);
    assert.equal(pruned.retention_id, retention[2].id);
    startRun(
      {
        artifacts: { report: { path: "{state_dir}/report.txt", required: true } },
        run_id: `failed-prune-${process.pid}-${Date.now()}`,
        state_dir: failedPruneDir,
        template: `${JSON.stringify(process.execPath)} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(failedPruneDir);
    await writeFile(join(failedPruneDir, "report.txt"), "keep");
    assert.throws(
      () =>
        pruneTerminalRun(
          getRunStatus(failedPruneDir),
          { preserveArtifacts: true },
          { copyArtifact: () => { throw new Error("simulated copy failure"); } },
        ),
      /simulated copy failure/,
    );
    await readFile(join(failedPruneDir, "run.json"), "utf8");
    assert.equal(await readFile(join(failedPruneDir, "report.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Real ordinary primary publication joins full UTF-8 source, classifies export EIO, and never retries a failed result commit", async () => {
  for (const mode of ["success", "export_eio", "artifact_eio", "diagnostics_eio", "diagnostics_failure_eio", "workload_failure", "result_eio", "source_refusal", "diagnostics_refusal"]) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-primary-live-")); const stateDir = join(root, "state");
    const previousAgent = process.env.PI_CODING_AGENT_DIR; const previousOptions = process.env.NODE_OPTIONS;
    let pid: number | undefined; let settled = false;
    try {
      const text = "HEAD🌍\n" + "x".repeat(128 * 1024) + "\nBearer hidden-live-token\nTAIL🌈";
      const script = join(root, "emit.cjs"); await writeFile(script, `process.stdout.write(${JSON.stringify(text)});process.exitCode=${mode === "workload_failure" || mode === "diagnostics_failure_eio" ? 7 : 0};`);
      const preload = join(root, "fault.mjs"); const attemptsPath = join(root, "result-attempts.txt");
      await writeFile(preload, `
        import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; import { createHash } from "node:crypto"; import { join } from "node:path";
        const rename = fs.renameSync; const link = fs.linkSync; const stat = fs.lstatSync; const write = fs.writeFileSync; let attempts = 0; let refused = false;
        fs.writeFileSync = function(path, ...args) {
          if (${JSON.stringify(mode)} === "artifact_eio" && /artifact-inventory-[a-f0-9]{64}\\.json$/.test(String(path))) {
            Reflect.apply(write, fs, [path, "partial", {flag:"wx"}]); throw Object.assign(Error("fixture artifact source EIO"), {code:"EIO"});
          }
          if (${JSON.stringify(mode)}.startsWith("diagnostics_") && ${JSON.stringify(mode)} !== "diagnostics_refusal" && /result-diagnostics-[a-f0-9]{64}\\.json$/.test(String(path))) {
            Reflect.apply(write, fs, [path, "partial", {flag:"wx"}]); throw Object.assign(Error("fixture diagnostic source EIO"), {code:"EIO"});
          }
          return Reflect.apply(write, fs, [path, ...args]);
        };
        fs.lstatSync = function(path, ...args) {
          if (${JSON.stringify(mode)} === "diagnostics_refusal" && /result-diagnostics-[a-f0-9]{64}\\.json$/.test(String(path)) && !refused) {
            refused = true; fs.writeFileSync(path,"foreign diagnostic bytes");
          }
          if (${JSON.stringify(mode)} === "source_refusal" && String(path) === ${JSON.stringify(join(stateDir, "evidence"))} && !refused) {
            refused = true; fs.mkdirSync(path, {recursive:true});
            const meta = JSON.parse(fs.readFileSync(${JSON.stringify(join(stateDir, "run.json"))}, "utf8"));
            const identity = createHash("sha256").update(JSON.stringify([meta.run, meta.run_instance_id, meta.ownerId ?? null])).digest("hex");
            fs.writeFileSync(join(path, "primary-" + identity + ".txt"), "foreign bytes");
          }
          return Reflect.apply(stat, fs, [path, ...args]);
        };
        fs.renameSync = function(from, to, ...args) {
          if (String(to) === ${JSON.stringify(join(stateDir, "result.json"))}) {
            fs.writeFileSync(${JSON.stringify(attemptsPath)}, String(++attempts));
            if (${JSON.stringify(mode)} === "result_eio" && attempts === 1) throw Object.assign(Error("fixture result EIO"), {code:"EIO"});
          }
          return Reflect.apply(rename, fs, [from, to, ...args]);
        };
        fs.linkSync = function(from, to, ...args) {
          if (${JSON.stringify(mode)} === "export_eio" && String(to).includes("primary-")) throw Object.assign(Error("fixture export EIO"), {code:"EIO"});
          return Reflect.apply(link, fs, [from, to, ...args]);
        };
        syncBuiltinESMExports();
      `);
      process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      process.env.NODE_OPTIONS = `${previousOptions ?? ""} --import=${JSON.stringify(pathToFileURL(preload).href)}`;
      const run = startRun({ run_id: "primary-live", state_dir: stateDir, template: "{node} {script}", values: { node: process.execPath, script },
        artifacts: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`declared-${i}`, join(root, `never-created-${i}.bin`)])) }, root);
      pid = run.pid; assert.ok(pid);
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
      for (let i = 0; i < 200 && !settled; i++) { settled = readProcessLiveness(pid) === "dead"; if (!settled) await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.equal(settled, true);
      const metadata = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
      if (mode === "source_refusal" || mode === "diagnostics_refusal") {
        assert.equal(existsSync(join(stateDir, "result.json")), false);
        assert.equal(existsSync(attemptsPath), false, "Admission refusal is not an ordinary failed-command result");
        assert.match(await readFile(join(stateDir, "stderr.log"), "utf8"), /different bytes/);
      } else if (mode === "result_eio") {
        assert.equal(existsSync(join(stateDir, "result.json")), false);
        assert.equal(await readFile(attemptsPath, "utf8"), "1", "No fallback synthetic result after precommit failure");
        assert.equal((await readdir(join(stateDir, "evidence"))).filter(name => /^primary-.*\.txt$/.test(name)).length, 1);
      } else if (mode === "workload_failure" || mode === "diagnostics_failure_eio") {
        const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8"));
        assert.equal(result.code, 7); assert.equal(result.terminal_acceptance, "natural"); assert.equal(await readFile(attemptsPath, "utf8"), "1");
        assert.equal(result.output, null); assert.equal(result.output_unavailable, "primary_not_selected_for_failure");
        assert.equal(result.artifact_inventory_protocol, "run-artifact-inventory-v1"); assert.equal(result.artifact_inventory.declarations_total, 5);
        const { summarizeRuns, detectRunTransitions, collectRunCompletionBatchMembers } = await import("../lib/observability.ts");
        const { admitRunCompletionBatch, formatRunCompletionBatchMessage } = await import("../lib/run-delivery.ts");
        const summary = summarizeRuns(root); const members = collectRunCompletionBatchMembers(detectRunTransitions(new Map([[stateDir, "running"]]), summary), summary.runs);
        assert.equal(members.length, 1); assert.equal(members[0].output, undefined);
        if (mode === "workload_failure") { assert.equal(members[0].diagnostic_excerpt?.field, "error"); assert.deepEqual(members[0].result_diagnostics, result.result_diagnostics); }
        else { assert.equal(members[0].result_diagnostics, null); assert.equal(members[0].result_diagnostics_unavailable, "publication_failed"); }
        const packet = admitRunCompletionBatch({ members, ownerId: metadata.ownerId ?? "primary-fixture", tempDir: root });
        const message = formatRunCompletionBatchMessage(packet); assert.doesNotMatch(message, /hidden-live-token|Legacy diagnostic display/);
        if (mode === "workload_failure") assert.match(message, /Recorded diagnostic metadata only; admission privacy/);
        else {
          const metadata = parseDocument(message, { version: "1.2", schema: "core", uniqueKeys: true });
          assert.deepEqual(metadata.errors, []); assert.deepEqual(metadata.warnings, []);
          assert.equal(metadata.get("diagnostic_metadata_unavailable"), "publication_failed");
        }
      } else {
        const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8")); assert.equal(result.code, 0); assert.equal(result.terminal_acceptance, "natural");
        assert.equal(result.artifact_inventory_protocol, "run-artifact-inventory-v1"); assert.equal(await readFile(attemptsPath, "utf8"), "1");
        if (mode === "artifact_eio") { assert.equal(result.artifact_inventory, null); assert.equal(result.artifact_inventory_unavailable, "publication_failed"); }
        else { assert.equal(result.artifact_inventory.declarations_total, 5); }
        const { summarizeRuns, detectRunTransitions, collectRunCompletionBatchMembers } = await import("../lib/observability.ts");
        const { admitRunCompletionBatch, readRunDeliveryJournal, formatRunCompletionBatchMessage } = await import("../lib/run-delivery.ts");
        const summary = summarizeRuns(root);
        const members = collectRunCompletionBatchMembers(detectRunTransitions(new Map([[stateDir, "running"]]), summary), summary.runs);
        assert.equal(members.length, 1);
        assert.deepEqual(members[0].primary_text, result.output === null
          ? { output: null, output_unavailable: result.output_unavailable } : { output: result.output });
        assert.equal(members[0].output, undefined, "Primary export loss cannot fall back to runner text");
        const packetOwner = metadata.ownerId ?? "primary-fixture";
        const packet = admitRunCompletionBatch({ members, ownerId: packetOwner, tempDir: root });
        const message = formatRunCompletionBatchMessage(packet);
        assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(root, packetOwner).completion_batch!), message);
        assert.doesNotMatch(message, /hidden-live-token/);
        if (result.output) {
          assert.ok(message.includes(result.output.preview), "Fresh completion retains the admitted source prefix without outer indentation");
          assert.ok(message.includes(JSON.stringify(basename(result.output.source.path))));
          assert.ok(!message.includes(result.output.source.sha256));
          assert.deepEqual(packet.members[0].primary_text?.output?.source, result.output.source);
        }
        else {
          const metadata = parseDocument(message, { version: "1.2", schema: "core", uniqueKeys: true });
          assert.deepEqual(metadata.errors, []); assert.deepEqual(metadata.warnings, []);
          assert.equal(metadata.get("primary_unavailable"), "export_failed");
        }
        if (mode === "export_eio") { assert.equal(result.output, null); assert.equal(result.output_unavailable, "export_failed"); }
        else {
          const output = result.output; const body = await readFile(output.source.path, "utf8");
          assert.equal(output.source.run_instance_id, metadata.run_instance_id); assert.ok(body.length > 128 * 1024);
          assert.ok(body.startsWith("HEAD🌍")); assert.ok(body.endsWith("TAIL🌈")); assert.doesNotMatch(body, /hidden-live-token/);
          assert.equal(output.bytes_total, Buffer.byteLength(body)); assert.equal(output.chars_total, [...body].length);
          assert.equal(output.chars_shown + output.chars_omitted, output.chars_total);
          assert.equal(Buffer.from(body).subarray(output.shown_bytes.start, output.shown_bytes.end).toString("utf8"), output.preview);
          assert.equal(output.redacted, true);
          const { readRunPrimaryTextSource } = await import("../lib/runs-context-exports.ts");
          const recovered = readRunPrimaryTextSource(stateDir, metadata); assert.equal(recovered.state, "available");
          if (recovered.state === "available") assert.deepEqual(recovered.output, output);
          const bytes = Buffer.from(body); let rebuilt = ""; let start = 0;
          while (start < bytes.length) {
            let end = Math.min(start + 8192, bytes.length); while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
            const page = readRunPrimaryTextSource(stateDir, metadata, { start, end }); assert.equal(page.state, "available");
            if (page.state !== "available") throw Error("Published source page unavailable after captured producer exit");
            rebuilt += page.output.preview; start = end;
          }
          assert.equal(rebuilt, body);
        }
      }
      if (!["source_refusal", "diagnostics_refusal", "result_eio"].includes(mode)) {
        const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8"));
        assert.equal(result.result_diagnostics_protocol, "run-result-diagnostics-v1");
        if (mode === "diagnostics_eio" || mode === "diagnostics_failure_eio") {
          assert.equal(result.result_diagnostics, null); assert.equal(result.result_diagnostics_unavailable, "publication_failed");
        } else {
          const reference = result.result_diagnostics; const source = await readFile(reference.source.path);
          const { createHash } = await import("node:crypto"); const data = JSON.parse(source.toString("utf8"));
          assert.equal(reference.bytes_total, source.length); assert.equal(reference.source.sha256, createHash("sha256").update(source).digest("hex"));
          assert.deepEqual(reference.fields, Object.keys(data.fields)); assert.equal(data.privacy_scope, "producer_admission");
          assert.equal(data.primary_text, "not_included"); assert.doesNotMatch(source.toString(), /hidden-live-token/);
        }
      }
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
      if (pid && !settled) throw Error("Captured fixture runner exit remains unproven; retaining state");
      await rm(root, { recursive: true, force: true });
    }
  }
});

});

await describe("Control integration", { concurrency: false }, async () => {


async function writeNamedPipeEndpoint(
  stateDir: string,
  runInstanceId: string,
): Promise<void> {
  await writeFile(
    join(stateDir, "control-endpoint.json"),
    `${JSON.stringify({
      path: "named-pipe-test",
      ready_at: new Date().toISOString(),
      run_instance_id: runInstanceId,
      type: "named-pipe",
    })}\n`,
  );
}

test("Runtime kill bypasses actor-local Control saturation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-kill-saturation-"));
  const stateDir = join(root, "saturated");
  const meta = startRun({ ownerId: "session-a", run_id: "saturated", state_dir: stateDir,
    template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"` }, process.cwd());
  try {
    for (let index = 0; index < Limits.RUN_CONTROL_PENDING_LIMIT; index += 1)
      appendRunControlInStateDir(stateDir, {
        action: "pause", input: { index }, run_instance_id: meta.run_instance_id,
      });
    const killed = killRun(stateDir, { ownerId: "session-a", runInstanceId: meta.run_instance_id });
    assert.equal(killed.killed, true);
    assert.equal(readRunControlsFromStateDir(stateDir).length, Limits.RUN_CONTROL_PENDING_LIMIT);
    assert.equal(readRunControlsFromStateDir(stateDir).every(({ status }) => status === "queued"), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Awaited Control facade preserves delivery and lifecycle-release failures without unlocking transport", { skip: process.platform !== "linux" }, async (t) => {
  // Live-host identity is observed, but this controlled port launches/signals no runner/socket and proves no host/native exit.
  for (const phase of ["delivery-error", "delivery-ok", "preflight-error", "preflight-aggregate", "preflight-undefined", "preflight-primitive", "preflight-hostile"] as const)
    for (const releaseFails of [false, true]) {
      const pid = process.pid, run = `control-release-${randomUUID()}`, generation = randomUUID(), owner = "control-release-owner";
      const stateDir = join(getRunStateRoot(), run); const identity = readProcessIdentity(pid);
      claimRunStateDirectory(stateDir, run);
      const meta = { run, state_dir: stateDir, run_instance_id: generation, ownerId: owner, pid, process_identity: identity, control: ["pause"] };
      writeJsonAtomic(join(stateDir, "run.json"), meta);
      writeJsonAtomic(join(stateDir, "fixture-frame.json"), { ...meta, kind: "controlled_live_host_port", host_exit: "not_asserted" });
      t.diagnostic(`Live-host Control fixture retained: ${stateDir}; phase=${phase}; host_exit=not_asserted; release_fault=${releaseFails}`);
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && identity && generation && owner && stateDir);
      writeJsonAtomic(join(stateDir, "control-endpoint.json"), { type: "named-pipe", path: "CONTROLLED_PORT_NO_SOCKET", run_instance_id: generation });
      const underlying = new Error("private delivery cause"); const transport = new AggregateError([underlying, undefined], "controlled transport fault", { cause: underlying });
      let coerced = 0;
      const preflight: unknown = phase === "preflight-undefined" ? undefined : phase === "preflight-primitive" ? 0
        : phase === "preflight-hostile" ? { [Symbol.toPrimitive]() { coerced++; throw new Error("must not coerce facade error"); } }
        : phase === "preflight-aggregate" ? new AggregateError([underlying, undefined], "original admission aggregate", { cause: underlying })
        : Object.assign(new Error("original admission rejection", { cause: underlying }), { details: { private: true } });
      const releaseFault = new Error("controlled lifecycle release fault");
      const lock = mutationLockPath(join(stateDir, ".lifecycle")); const mkdir = fs.mkdirSync;
      let releases = 0, sends = 0, payloadBytes = 0, wire: { id: string } | undefined, transportSettled = false;
      let enter!: () => void, resolveSend!: (bytes: number) => void, rejectSend!: (error: unknown) => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const options = { ownerId: owner, namedPipeSend: (_path: string, payload: string) => {
        sends++; payloadBytes = Buffer.byteLength(payload); wire = JSON.parse(payload);
        return new Promise<number>((resolve, reject) => { resolveSend = resolve; rejectSend = reject; enter(); });
      } };
      if (phase.startsWith("preflight")) Object.defineProperty(options, "ownerId", { get() { throw preflight; } });
      const hook = t.mock.method(fs, "mkdirSync", ((...args: Parameters<typeof fs.mkdirSync>) => {
        if (String(args[0]).startsWith(lock + ".reclaim.") && String(args[0]).endsWith(".pending")) {
          releases++; if (releaseFails) throw releaseFault;
        }
        return Reflect.apply(mkdir, fs, args);
      }) as typeof fs.mkdirSync);
      syncBuiltinESMExports();
      const pending = sendRunControl(stateDir, { action: "pause", run_instance_id: generation }, options);
      const observation = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      try {
        if (!phase.startsWith("preflight")) {
          await Promise.race([entered, observation.then(() => { throw new Error("Control never reached the admitted transport"); })]);
          assert.ok(wire?.id); assert.equal(releases, 0);
          const contention = new Error("lifecycle remains held across awaited transport");
          assert.throws(() => acquireStateStartLock(stateDir, { onContention() { throw contention; } }), error => error === contention);
          assert.equal(updateRunControlStatusInStateDir(stateDir, wire.id, "claimed"), true);
          assert.equal(updateRunControlStatusInStateDir(stateDir, wire.id, "handled"), true);
          transportSettled = true;
          if (phase === "delivery-ok") resolveSend(payloadBytes); else rejectSend(transport);
        }
        const outcome = await observation;
        assert.equal(releases, 1); assert.equal(coerced, 0);
        if (phase === "delivery-ok" && !releaseFails) {
          assert.equal(outcome.ok, true); if (outcome.ok) { assert.equal(outcome.value.delivery, "delivered"); assert.equal(outcome.value.control_id, wire?.id); }
        } else {
          assert.equal(outcome.ok, false); if (outcome.ok) assert.fail("Unexpected successful Control");
          const error: unknown = outcome.error;
          if (phase === "delivery-ok") assert.equal(error, releaseFault, "A release-only failure remains exact");
          else {
            let original: unknown = error;
            if (releaseFails) {
              assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); assert.equal(error.errors[1], releaseFault);
              original = error.errors[0]; assert.equal(error.cause, original);
              assert.equal(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable, false);
              assert.equal(Object.getOwnPropertyDescriptor(error, "errors")?.enumerable, false);
              assert.deepEqual(Object.keys(error), []);
            }
            if (phase.startsWith("preflight")) {
              assert.equal(original, preflight, "Original value/aggregate is not coerced, rebuilt or flattened");
              if (releaseFails && phase === "preflight-undefined") assert.equal(Object.hasOwn(error as object, "cause"), true);
            } else {
              assert.ok(original instanceof Error); assert.equal(original.cause, transport);
              assert.equal((original as Error & { control_id: string }).control_id, wire?.id);
              assert.equal((original as Error & { reason: string }).reason, "delivery_failed");
              assert.deepEqual(transport.errors, [underlying, undefined]); assert.equal(transport.cause, underlying);
            }
          }
        }
        const records = readRunControlsFromStateDir(stateDir);
        assert.equal(sends, phase.startsWith("preflight") ? 0 : 1);
        assert.equal(records.length, phase.startsWith("preflight") ? 0 : 1);
        if (records.length) { assert.equal(records[0].status, "handled"); assert.equal(records[0].id, wire?.id); assert.equal(records[0].run_instance_id, generation); }
      } finally {
        if (!transportSettled && rejectSend) { transportSettled = true; rejectSend(new Error("controlled fixture settlement")); }
        await Promise.allSettled([pending, observation]);
        hook.mock.restore(); syncBuiltinESMExports();
      }
    }
});

test("Canonical Run Control revalidates owner and generation under the lifecycle lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-canonical-control-"));
  const stateDir = join(root, "demo");
  const meta = startRun(
    {
      ownerId: "session-a",
      run_id: "demo",
      state_dir: stateDir,
      template: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`,
    },
    process.cwd(),
  );
  try {
    await writeNamedPipeEndpoint(stateDir, meta.run_instance_id);
    await assert.rejects(
      sendRunControl(
        stateDir,
        { action: "pause", run_instance_id: meta.run_instance_id },
        { ownerId: "session-b" },
      ),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).reason, "owner_mismatch");
        return true;
      },
    );
    await assert.rejects(
      sendRunControl(
        stateDir,
        { action: "pause", run_instance_id: "replacement" },
        { ownerId: "session-a" },
      ),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).reason, "generation_mismatch");
        return true;
      },
    );
    const receipt = await sendRunControl(
      stateDir,
      { action: "pause", run_instance_id: meta.run_instance_id },
      {
        ownerId: "session-a",
        namedPipeSend: async (_path, payload) => Buffer.byteLength(payload),
      },
    );
    assert.equal(receipt.delivery, "delivered");
  } finally {
    const killed = killRun(stateDir, {
      ownerId: "session-a",
      runInstanceId: meta.run_instance_id,
    });
    assert.equal(killed.killed, true);
    assert.equal(Object.hasOwn(killed, "control_id"), false);
    await rm(root, { force: true, recursive: true });
  }
});

});

await describe("Launch usage", { concurrency: false }, async () => {
/**
 * Async run usage telemetry regressions
 * Covers extension-owned launch counter increments for recipe-file runs
 */



test("Async run start increments user recipe launch counter", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-async-usage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { getRunStatus, startRun } = await import(
      `../lib/async-runs.ts?usage=${Date.now()}`
    );
    async function waitForResult(stateDir: string): Promise<void> {
      for (let i = 0; i < 40; i += 1) {
        if (getRunStatus(stateDir).result) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("run did not finish");
    }
    const recipeRoot = join(agentDir, "recipes");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeRoot, { recursive: true }),
    );
    const recipe = join(recipeRoot, "counted.json");
    await writeFile(
      recipe,
      JSON.stringify({
        async: true,
        template: `${JSON.stringify(process.execPath)} -e "console.log('counted')"`,
      }),
    );
    const meta = startRun({ file: recipe, run_id: "counted-run" }, process.cwd());
    await waitForResult(meta.state_dir);
    const usage = readRecipeUsage(recipe)!;
    assert.equal(usage.calls, 1);
    assert.equal(typeof usage.last_called, "string");
    const unchanged = JSON.parse(await readFile(recipe, "utf8"));
    assert.equal(unchanged.usage, undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

});
