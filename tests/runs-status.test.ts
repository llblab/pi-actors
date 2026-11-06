/**
 * Async run status derivation regressions.
 * Covers explicit live-but-unverifiable survivor classification.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-status-agent-"));
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

const { buildRunStatus, readRunInventoryStatuses } = await import("../lib/runs-status.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { readRunNaturalOutcome, readRunNaturalOutcomeSnapshot, readRunStopClaim, RUN_OUTCOME_PROTOCOL, RUN_STOP_CLAIM_FILE } = await import("../lib/runs-outcomes.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity, runProcessIdentityDigest } = await import("../lib/runs-process.ts");
const { admitRunResultProducer, publishRunResult } = await import("../lib/runs-results.ts");
const { readJsonFileResilient } = await import("../lib/state-readers.ts");
const readJson = (path: string) => readJsonFileResilient<Record<string, unknown> | undefined>(path, undefined).value;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(agentDir, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "status");
  const meta = { run: "status", run_instance_id: "generation-a", ownerId: "status-owner", state_dir: stateDir,
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const resultPath = join(stateDir, "result.json");
  const stopPath = join(stateDir, RUN_STOP_CLAIM_FILE);
  const status = () => buildRunStatus(stateDir, "status", meta, readJson, "unused", 0);
  return { root, stateDir, meta, producer, resultPath, stopPath, status };
}

test("Windows inventory derivation is scalar-equivalent for native success, uncertainty and one fresh bounded fallback", (t) => {
  const root = mkdtempSync(join(agentDir, "windows-equivalence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "status");
  const expected = { platform: "win32", start_time: "/Date(7)/", command: "node\r\ninventory" };
  const meta = { run: "status", run_instance_id: "generation", ownerId: "owner", state_dir: stateDir, pid: 42, process_identity: expected };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  writeJsonAtomic(join(stateDir, "result.json"), { code: 7, run_instance_id: "generation" });
  let mode = "valid", dead = false, batch = 0, scalar = 0, rebinds = 0, resultReads = 0;
  const hooks = [t.mock.method(os, "platform", () => "win32"), t.mock.method(process, "kill", () => {
    if (dead) throw Object.assign(new Error("absent"), { code: "ESRCH" }); return true;
  })];
  const native = t.mock.method(childProcess, "spawnSync", (_file: string, args: string[]) => {
    const shared = args[3].includes("-InputObject"); if (shared) batch++; else scalar++;
    if (mode === "failed") return { status: 1, stdout: "" };
    if (mode === "malformed") return { status: 0, stdout: "[invalid" };
    if (mode === "oversized") return { status: 0, stdout: " ".repeat(1024 * 1024) + "[]", error: new Error("maxBuffer") };
    if (mode === "missing") return { status: shared ? 0 : 3, stdout: shared ? "[]" : "" };
    const row = { ProcessId: 42, CreationDate: mode === "mismatch" ? "new-birth" : expected.start_time,
      ExecutablePath: null, CommandLine: mode === "optional" ? 17 : expected.command };
    return { status: 0, stdout: JSON.stringify(shared ? [row] : row) };
  });
  syncBuiltinESMExports();
  try {
    const reader = (path: string) => { if (path === join(stateDir, "result.json")) resultReads++; return readJson(path); };
    for (mode of ["valid", "mismatch", "missing", "optional", "malformed", "failed", "oversized"]) {
      batch = scalar = resultReads = 0;
      const observed = readRunInventoryStatuses([stateDir], reader, () => { rebinds++; throw new Error("Unexpected fallback facade"); })[0];
      assert.equal(batch, 1); assert.equal(scalar, ["malformed", "failed", "oversized"].includes(mode) ? 1 : 0);
      assert.equal(resultReads, 1, "The derived result and precedence use one natural-outcome snapshot");
      assert.deepEqual(observed, buildRunStatus(stateDir, stateDir, meta, reader, "unused", 0));
      assert.equal(observed?.process_identity_status, mode === "valid" ? "valid" : ["mismatch", "optional"].includes(mode) ? "owner_mismatch" : "unsupported_proof");
    }
    dead = true; mode = "missing";
    assert.equal(readRunInventoryStatuses([stateDir], reader, () => ({}))[0]?.process_identity_status, "dead_pid");
    assert.equal(rebinds, 0);
    // Legacy metadata remains scalar-supported rather than silently disappearing.
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, process_identity: undefined });
    const legacy = { legacy: true };
    assert.deepEqual(readRunInventoryStatuses([stateDir], reader, () => legacy), [legacy]);
  } finally { native.mock.restore(); for (const hook of hooks) hook.mock.restore(); syncBuiltinESMExports(); }
});

test("Windows shared acquisition skips only fresh absent candidates while assembly and rebound fallback remain independently fresh", (t) => {
  const root = mkdtempSync(join(agentDir, "windows-live-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = [42, 42, 43, 44, 45].map((pid, index) => {
    const run = `row-${index}`, stateDir = claimRunStateDirectory(join(root, run), run);
    const meta = { run, run_instance_id: "original", ownerId: "owner", state_dir: stateDir, pid,
      process_identity: { platform: "win32", start_time: index === 1 ? "other" : "birth", command: "node" } };
    writeJsonAtomic(join(stateDir, "run.json"), meta);
    writeJsonAtomic(join(stateDir, "result.json"), { code: index % 2 ? 7 : 0, run_instance_id: meta.run_instance_id });
    return { stateDir, meta };
  });
  const directories = rows.map(row => row.stateDir);
  let mode = "dead", rebinds = 0, mutateGate = false, mutateFallback = false;
  const probes = new Map<number, number>(), batches: number[][] = [], scalars: number[] = [];
  const absent = Object.assign(Error("absent"), { code: "ESRCH" });
  const platformHook = t.mock.method(os, "platform", () => "win32");
  const aliveHook = t.mock.method(process, "kill", (pid: number, signal: number) => {
    assert.equal(signal, 0); const count = (probes.get(pid) ?? 0) + 1; probes.set(pid, count);
    if (mutateGate && pid === 42 && count === 1) writeJsonAtomic(join(rows[0].stateDir, "run.json"), { ...rows[0].meta, run_instance_id: "replacement" });
    if (mode === "dead" || (pid === 42 && mode === "mixed") || (pid === 42 && mode === "rebound" && count === 1)) throw absent;
    if (pid === 44) throw Object.assign(Error("denied"), { code: "EPERM" });
    if (pid === 45) throw 0; // Unknown cannot authorize absence or suppress acquisition.
    return true;
  });
  const native = t.mock.method(childProcess, "spawnSync", (_file: string, args: string[]) => {
    const shared = args[3].includes("-InputObject"), pids = [...args[3].matchAll(/ProcessId = ([0-9]+)/g)].map(match => Number(match[1]));
    if (shared) batches.push(pids); else scalars.push(pids[0]);
    if (!shared && mutateFallback) writeJsonAtomic(join(rows[0].stateDir, "run.json"), { ...rows[0].meta, ownerId: "replacement" });
    const values = pids.map(ProcessId => ({ ProcessId, CreationDate: "birth", CommandLine: "node" }));
    return { status: 0, stdout: JSON.stringify(shared ? values : values[0]) };
  });
  syncBuiltinESMExports();
  const observe = () => {
    probes.clear(); batches.length = scalars.length = 0;
    return readRunInventoryStatuses(directories, readJson, () => { rebinds++; return { replacement: true }; });
  };
  try {
    let result = observe();
    assert.deepEqual(batches, []); assert.deepEqual(scalars, []);
    assert.deepEqual(result.map(row => row?.process_identity_status), Array(5).fill("dead_pid"));
    assert.deepEqual(result.map(row => row?.status), ["done", "failed", "done", "failed", "done"]);
    for (const [index, row] of rows.entries()) assert.deepEqual(result[index], buildRunStatus(row.stateDir, row.stateDir, row.meta, readJson, "unused", 0));
    mode = "mixed"; result = observe();
    assert.deepEqual(batches, [[43, 44, 45]]); assert.deepEqual(scalars, []);
    assert.equal(probes.get(42), 3, "One unique selection probe, then independent assembly checks per row");
    assert.deepEqual(result.map(row => row?.process_identity_status), ["dead_pid", "dead_pid", "valid", "valid", "valid"]);
    mode = "rebound"; result = observe();
    assert.deepEqual(batches, [[43, 44, 45]]); assert.deepEqual(scalars, [42, 42], "At most one original-frame fallback per affected row, not per unique PID");
    assert.deepEqual(result.slice(0, 2).map(row => row?.process_identity_status), ["valid", "owner_mismatch"]);
    mutateGate = true; mode = "mixed"; result = observe();
    assert.equal(result[0], undefined); assert.equal(result[1]?.process_identity_status, "dead_pid"); assert.deepEqual(scalars, []);
    writeJsonAtomic(join(rows[0].stateDir, "run.json"), rows[0].meta); mutateGate = false; mutateFallback = true; mode = "rebound";
    result = observe(); assert.equal(result[0], undefined); assert.equal(rebinds, 0);
    writeJsonAtomic(join(rows[0].stateDir, "run.json"), rows[0].meta); mutateFallback = false; mode = "live";
    result = observe(); assert.deepEqual(batches, [[42, 43, 44, 45]]); assert.deepEqual(scalars, []);
    assert.deepEqual(result.slice(0, 2).map(row => row?.process_identity_status), ["valid", "owner_mismatch"]);
  } finally { native.mock.restore(); platformHook.mock.restore(); aliveHook.mock.restore(); syncBuiltinESMExports(); }
});

test("Admitted Windows inventory frames refuse metadata, source-byte and physical replacement without rebinding", (t) => {
  const root = mkdtempSync(join(agentDir, "windows-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platformHook = t.mock.method(os, "platform", () => "win32");
  const aliveHook = t.mock.method(process, "kill", () => true);
  let mutate = () => {}; let phase = "query"; let nativeCalls = 0; let scalarCalls = 0;
  const native = t.mock.method(childProcess, "spawnSync", (_file: string, args: string[]) => {
    const shared = args[3].includes("-InputObject"); nativeCalls++; if (!shared) scalarCalls++;
    if ((phase === "query" && shared) || (phase === "fallback" && !shared)) mutate();
    return { status: 0, stdout: shared && ["fallback", "before-fallback"].includes(phase) ? "malformed" :
      JSON.stringify(shared ? [{ ProcessId: 42, CreationDate: "birth", CommandLine: "node" }] : { CreationDate: "birth", CommandLine: "node" }) };
  });
  syncBuiltinESMExports();
  try {
    let number = 0;
    for (phase of ["query", "assembly", "fallback", "before-fallback"]) {
      for (const change of ["owner", "generation", "pid", "expected", "source-bytes", "file", "directory", "marker"]) {
        const run = `case-${number++}`; const stateDir = claimRunStateDirectory(join(root, run), run); const path = join(stateDir, "run.json");
        const meta = { run, run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, pid: 42,
          note: "original", process_identity: { platform: "win32", start_time: "birth", command: "node" } };
        writeJsonAtomic(path, meta);
        writeJsonAtomic(join(stateDir, "result.json"), { code: 0, run_instance_id: meta.run_instance_id });
        nativeCalls = scalarCalls = 0; let rebound = 0, mutated = false;
        const stamp = fs.lstatSync(path, { bigint: true });
        const lstat = fs.lstatSync, fstat = fs.fstatSync;
        // Hold timestamp observations constant for the same-size edit: source bytes must independently fence it.
        const stampHook = change === "source-bytes" ? t.mock.method(fs, "lstatSync", ((p: fs.PathLike, ...args: unknown[]) =>
          String(p) === path ? stamp : Reflect.apply(lstat, fs, [p, ...args])) as typeof fs.lstatSync) : undefined;
        const openedHook = change === "source-bytes" ? t.mock.method(fs, "fstatSync", ((fd: number, ...args: unknown[]) => {
          const current = Reflect.apply(fstat, fs, [fd, ...args]);
          return current.ino === stamp.ino && current.dev === stamp.dev ? stamp : current;
        }) as typeof fs.fstatSync) : undefined;
        syncBuiltinESMExports();
        mutate = () => {
          if (mutated) return; mutated = true;
          if (change === "directory") {
            fs.renameSync(stateDir, stateDir + "-old"); claimRunStateDirectory(stateDir, run); writeJsonAtomic(path, meta);
          } else if (change === "file") {
            fs.renameSync(path, path + ".old"); writeJsonAtomic(path, meta);
          } else if (change === "marker") {
            const marker = join(stateDir, ".pi-actors-run-state.json"); fs.writeFileSync(marker, fs.readFileSync(marker, "utf8") + " ");
          } else if (change === "source-bytes") {
            const bytes = fs.readFileSync(path, "utf8"); fs.writeFileSync(path, bytes.replace('"original"', '"modified"'));
            assert.equal(fs.readFileSync(path).length, Buffer.byteLength(bytes));
          } else {
            const updated = { ...meta, ...(change === "owner" ? { ownerId: "owner-b" } : {}),
              ...(change === "generation" ? { run_instance_id: "generation-b" } : {}), ...(change === "pid" ? { pid: 43 } : {}),
              ...(change === "expected" ? { process_identity: { ...meta.process_identity, start_time: "other" } } : {}) };
            fs.writeFileSync(path, JSON.stringify(updated));
          }
        };
        try {
          const observed = readRunInventoryStatuses([stateDir], p => {
            if ((phase === "assembly" && p === join(stateDir, "progress.json")) ||
              (phase === "before-fallback" && p === join(stateDir, "result.json"))) mutate();
            return readJson(p);
          }, () => { rebound++; return { replacement: true }; });
          assert.deepEqual(observed, [undefined], `${phase}/${change}`); assert.equal(rebound, 0, `${phase}/${change}`);
          assert.equal(mutated, true); assert.equal(nativeCalls, phase === "fallback" ? 2 : 1);
          assert.equal(scalarCalls, phase === "fallback" ? 1 : 0);
        } finally { stampHook?.mock.restore(); openedHook?.mock.restore(); syncBuiltinESMExports(); }
      }
    }
    phase = "assembly"; mutate = () => {};
    const directories = ["earlier", "later"].map(run => {
      const stateDir = claimRunStateDirectory(join(root, run), run);
      writeJsonAtomic(join(stateDir, "run.json"), { run, run_instance_id: "generation", ownerId: "owner", state_dir: stateDir,
        pid: 42, process_identity: { platform: "win32", start_time: "birth", command: "node" } });
      return stateDir;
    });
    const assembled = readRunInventoryStatuses(directories, p => {
      if (p === join(directories[1], "progress.json")) fs.writeFileSync(join(directories[0], "run.json"), "{}");
      return readJson(p);
    }, () => { throw new Error("Must not rebind an admitted row"); });
    assert.equal(assembled[0], undefined, "Later assembly cannot retain an earlier invalidated frame");
    assert.equal(assembled[1]?.process_identity_status, "valid");
  } finally { native.mock.restore(); platformHook.mock.restore(); aliveHook.mock.restore(); syncBuiltinESMExports(); }
});

test("Live runner with unavailable identity proof remains an explicit running survivor", () => {
  const status = buildRunStatus(
    "/runs/ambiguous",
    "ambiguous",
    {
      createdAt: new Date(0).toISOString(),
      pid: process.pid,
      run: "ambiguous",
      state_dir: "/runs/ambiguous",
    },
    () => undefined,
    "/runner.mjs",
    0,
  );
  assert.equal(status.status, "running");
  assert.equal(status.process_identity_status, "unsupported_proof");
});

test("Accepted natural results retain done/failed status after later malformed stop evidence without writes", async (t) => {
  for (const code of [0, 7]) {
    const { stateDir, producer, resultPath, stopPath, status } = await fixture(t);
    publishRunResult(stateDir, producer, { code, output: "accepted before corrupt stop" });
    writeFileSync(stopPath, "{unproven");
    const before = ["run.json", "result.json", RUN_STOP_CLAIM_FILE].map((name) => readFileSync(join(stateDir, name), "utf8"));
    const observed = status();
    assert.equal(observed.status, code === 0 ? "done" : "failed");
    assert.equal(observed.phase, undefined);
    assert.equal(observed.stopped, undefined);
    assert.equal(observed.stop_reason, undefined);
    assert.equal(observed.stop_claim_id, undefined);
    assert.equal(observed.stop_error, "claim_unavailable");
    assert.deepEqual(observed.result, readJson(resultPath));
    assert.deepEqual(["run.json", "result.json", RUN_STOP_CLAIM_FILE].map((name) => readFileSync(join(stateDir, name), "utf8")), before);
    for (const file of ["progress.json", "trace.jsonl", "terminal-handled.json", "terminal-delivery-failure.json"]) assert.equal(existsSync(join(stateDir, file)), false);
  }
});

test("Natural precedence and rendered result use the same single read across a replacement-generation file change", async (t) => {
  const { stateDir, meta, producer, resultPath, stopPath } = await fixture(t);
  publishRunResult(stateDir, producer, { code: 0, output: "captured generation-a" });
  writeFileSync(stopPath, "{unproven");
  const accepted = readJson(resultPath)!;
  let reads = 0;
  const observed = buildRunStatus(stateDir, "status", meta, (path) => {
    if (path !== resultPath) return readJson(path);
    reads++;
    if (reads !== 1) return readJson(path);
    // Inject filesystem reuse after the caller captured generation-a, not a second accepted publication.
    writeJsonAtomic(resultPath, { ...accepted, run_instance_id: "generation-b", code: 7, output: "replacement" });
    return accepted;
  }, "unused", 0);
  assert.equal(reads, 1);
  assert.equal(observed.status, "done");
  assert.deepEqual(observed.result, accepted);
  assert.equal(readJson(resultPath)?.run_instance_id, "generation-b");
});

test("A matching post-acceptance pending claim cannot project a stopping phase, reason, or claim id over natural truth", async (t) => {
  for (const code of [0, 7]) {
    const { stateDir, meta, producer, resultPath, stopPath } = await fixture(t);
    publishRunResult(stateDir, producer, { code });
    // Inject a matching record after acceptance, not a successful control-owner stop admission.
    const pendingMeta = { ...meta, process_identity: meta.process_identity ?? {
      platform: "linux" as const, start_time: "injected-birth", command: "injected-command",
    } };
    writeJsonAtomic(stopPath, { version: 1, claim_id: randomUUID(), run: meta.run, run_instance_id: meta.run_instance_id,
      ownerId: meta.ownerId, pid: meta.pid, process_identity_digest: runProcessIdentityDigest(pendingMeta.process_identity),
      reason: "manual_kill", requested_at: new Date().toISOString() });
    assert.equal(readRunStopClaim(stateDir, pendingMeta).state, "pending");
    const resultBytes = await readFile(resultPath, "utf8");
    const stopBytes = await readFile(stopPath, "utf8");
    const observed = buildRunStatus(stateDir, "status", pendingMeta, readJson, "unused", 0);
    assert.equal(observed.status, code === 0 ? "done" : "failed");
    for (const key of ["phase", "stopped", "stop_reason", "stop_claim_id"]) assert.equal(Object.hasOwn(observed, key), false);
    assert.equal(await readFile(resultPath, "utf8"), resultBytes);
    assert.equal(await readFile(stopPath, "utf8"), stopBytes);
  }
});

test("Invalid, coercible, unbound, stale, and captured results cannot acquire accepted-natural priority", async (t) => {
  const { stateDir, meta, producer, resultPath, stopPath, status } = await fixture(t);
  publishRunResult(stateDir, producer, { code: 0 });
  const accepted = readJson(resultPath)!;
  writeFileSync(stopPath, "{unproven");
  const mutations = [
    { code: "0" }, { code: 0.5 }, { code: null }, { code: Number.MAX_SAFE_INTEGER + 1 },
    { completedAt: "yesterday" }, { completedAt: "2026-10-22" }, { run_instance_id: "replacement" },
    { terminal_acceptance: "legacy" }, { terminal_acceptance: "after_stop_claim", stop_claim_id: "claim" },
    { terminal_acceptance: "natural", stop_claim_id: "claim" },
  ];
  for (const delta of mutations) {
    writeJsonAtomic(resultPath, { ...accepted, ...delta });
    assert.notEqual(readRunNaturalOutcome(stateDir, meta).state, "accepted");
    const observed = status();
    assert.equal(observed.status, "running");
    assert.equal(observed.phase, "stopping");
    assert.equal(observed.stopped, false);
    if (delta.run_instance_id) {
      assert.equal(observed.result, null);
      assert.equal(observed.result_error, "generation_mismatch");
    }
  }
  const { run_instance_id: _generation, ...unbound } = accepted;
  const { run_instance_id: _metaGeneration, ...unboundMeta } = meta;
  writeJsonAtomic(resultPath, unbound);
  assert.equal(readRunNaturalOutcome(stateDir, unboundMeta).state, "invalid");
  assert.equal(buildRunStatus(stateDir, "status", unboundMeta, readJson, "unused", 0).status, "running");
  writeJsonAtomic(resultPath, accepted);
  const inheritedCode = Object.assign(Object.create({ code: 0 }), Object.fromEntries(Object.entries(accepted).filter(([key]) => key !== "code")));
  assert.equal(readRunNaturalOutcomeSnapshot(stateDir, meta, () => inheritedCode).outcome.state, "invalid");
});

test("Supported legacy records remain readable but cannot outrank unproven stopping evidence", async (t) => {
  const { stateDir, meta, resultPath, stopPath } = await fixture(t);
  for (const legacy of [{ code: 0, output: "old success" }, { code: "0" }, { code: 7, output: "old failure" }]) {
    writeJsonAtomic(resultPath, legacy);
    const observed = buildRunStatus(stateDir, "status", meta, readJson, "unused", 0);
    assert.equal(observed.status, Number(legacy.code) === 0 ? "done" : "failed");
    assert.deepEqual(observed.result, legacy);
    assert.equal(readRunNaturalOutcome(stateDir, meta).state, "invalid");
    writeFileSync(stopPath, "{unproven");
    const stopping = buildRunStatus(stateDir, "status", meta, readJson, "unused", 0);
    assert.equal(stopping.status, "running");
    assert.equal(stopping.phase, "stopping");
    rmSync(stopPath);
  }
});

test("A captured snapshot cannot become terminal because a later filesystem read would see natural acceptance", async (t) => {
  const { stateDir, meta, producer, resultPath, stopPath } = await fixture(t);
  publishRunResult(stateDir, producer, { code: 0 });
  const natural = readJson(resultPath)!;
  const capture = { ...natural, terminal_acceptance: "after_stop_claim", stop_claim_id: "capture-id" };
  writeJsonAtomic(resultPath, capture);
  writeFileSync(stopPath, "{unproven");
  let reads = 0;
  const observed = buildRunStatus(stateDir, "status", meta, (path) => {
    if (path !== resultPath) return readJson(path);
    reads++;
    writeJsonAtomic(resultPath, natural);
    return capture;
  }, "unused", 0);
  assert.equal(reads, 1);
  assert.equal(observed.status, "running");
  assert.equal(observed.phase, "stopping");
  assert.deepEqual(observed.result, capture);
  assert.equal(readRunNaturalOutcome(stateDir, meta).state, "accepted");
});

test("Result-path admission rejects nonregular or denied files before invoking the shared snapshot reader", async (t) => {
  for (const kind of ["absent", "directory", "denied", ...(process.platform === "win32" ? [] : ["symlink"])]) {
    const { root, stateDir, meta, producer, resultPath, stopPath } = await fixture(t);
    publishRunResult(stateDir, producer, { code: 0 });
    const accepted = readJson(resultPath)!;
    rmSync(resultPath);
    if (kind === "directory") await mkdir(resultPath);
    else if (kind === "symlink") {
      const target = join(root, "target.json");
      writeJsonAtomic(target, accepted);
      await symlink(target, resultPath);
    } else if (kind === "denied") writeJsonAtomic(resultPath, accepted);
    writeFileSync(stopPath, "{unproven");
    const lstat = fs.lstatSync;
    let reads = 0;
    if (kind === "denied") {
      fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
        if (String(path) === resultPath) throw Object.assign(new Error("result presence denied"), { code: "EACCES" });
        return Reflect.apply(lstat, fs, [path, ...args]);
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
    }
    try {
      const readSnapshot = () => { reads++; return accepted; };
      const snapshot = readRunNaturalOutcomeSnapshot(stateDir, meta, readSnapshot);
      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(snapshot.result, undefined);
      assert.equal(snapshot.outcome.state, kind === "absent" ? "absent" : "invalid");
      const observed = buildRunStatus(stateDir, "status", meta, (path) => path === resultPath ? readSnapshot() : readJson(path), "unused", 0);
      assert.equal(observed.status, "running");
      assert.equal(observed.phase, "stopping");
      assert.equal(observed.result, null);
      assert.equal(reads, 0);
    } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  }
});
