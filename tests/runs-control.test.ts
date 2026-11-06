/** Mirrors lib/runs-control.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type TestContext,
  describe,
} from "node:test";
import {
  signalOwnedRunProcess,
  claimRunStop,
} from "../lib/runs-control.ts";
import {
  type RunProcessIdentity,
  readProcessIdentity,
  runProcessIdentityDigest,
} from "../lib/runs-process.ts";
import {
  spawn,
} from "node:child_process";
import {
  randomUUID,
} from "node:crypto";
import {
  once,
} from "node:events";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
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
import {
  setTimeout as delay,
} from "node:timers/promises";
import {
  mutationLockPath,
  writeJsonAtomic,
} from "../lib/file-state.ts";
import {
  createRunSupervisionClock,
  resolveRunSupervisionPolicy,
} from "../lib/run-supervision.ts";
import {
  readRunNaturalOutcome,
  readRunStopClaim,
  RUN_OUTCOME_PROTOCOL,
  RUN_STOP_CLAIM_FILE,
} from "../lib/runs-outcomes.ts";
import {
  claimRunStateDirectory,
} from "../lib/runs-ownership.ts";
import {
  admitRunResultProducer,
  publishRunResult,
} from "../lib/runs-results.ts";
import {
  acquireStateStartLock,
  prepareStateDirForStart,
  readActiveOwnedRunState,
} from "../lib/runs-start.ts";
import {
  buildRunStatus,
} from "../lib/runs-status.ts";
import {
  readJsonFileResilient,
} from "../lib/state-readers.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Control actuation", { concurrency: false }, async () => {
/**
 * Run process-control boundary regressions.
 * Covers immediate identity revalidation and fail-closed process-group fallback.
 */



const identity: RunProcessIdentity = {
  command: "node async-runner.mjs /runs/demo",
  cwd: "/repo",
  platform: "linux",
  start_time: "100",
};

test("Process control revalidates identity immediately before signaling", () => {
  let signals = 0;
  assert.throws(
    () => signalOwnedRunProcess(123, "SIGKILL", identity, {
      killProcess: (() => {
        signals += 1;
        return true;
      }) as typeof process.kill,
      runtimePlatform: "linux",
      verifyIdentity: () => ({ status: "owner_mismatch", valid: false }),
    }),
    /identity changed before signaling: owner mismatch/,
  );
  assert.equal(signals, 0);
});

test("Process-group ESRCH alone permits exact-process fallback", () => {
  const targets: number[] = [];
  const result = signalOwnedRunProcess(123, "SIGTERM", identity, {
    killProcess: ((pid: number) => {
      targets.push(pid);
      if (pid < 0) {
        const error = new Error("group absent") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill,
    runtimePlatform: "linux",
    verifyIdentity: () => ({ status: "valid", valid: true }),
  });
  assert.deepEqual(targets, [-123, 123]);
  assert.deepEqual(result, { signalTarget: "process" });
});

test("Exact-pid fallback revalidates identity after group ESRCH", () => {
  const targets: number[] = [];
  let proofs = 0;
  assert.throws(
    () => signalOwnedRunProcess(123, "SIGKILL", identity, {
      killProcess: ((pid: number) => {
        targets.push(pid);
        const error = new Error("group absent") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }) as typeof process.kill,
      runtimePlatform: "linux",
      verifyIdentity: () => {
        proofs += 1;
        return proofs === 1
          ? { status: "valid", valid: true }
          : { status: "owner_mismatch", valid: false };
      },
    }),
    /identity changed before pid fallback: owner mismatch/,
  );
  assert.deepEqual(targets, [-123]);
  assert.equal(proofs, 2);
});

test("Process-group authorization errors fail closed without pid fallback", () => {
  const targets: number[] = [];
  assert.throws(
    () => signalOwnedRunProcess(123, "SIGKILL", identity, {
      killProcess: ((pid: number) => {
        targets.push(pid);
        const error = new Error("not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }) as typeof process.kill,
      runtimePlatform: "linux",
      verifyIdentity: () => ({ status: "valid", valid: true }),
    }),
    /not permitted/,
  );
  assert.deepEqual(targets, [-123]);
});

test("Windows process-tree signaling tolerates exit after identity validation", () => {
  let proofs = 0;
  const result = signalOwnedRunProcess(123, "SIGTERM", identity, {
    runtimePlatform: "win32",
    spawnProcess: (() => ({
      pid: 0,
      output: [],
      signal: null,
      status: 128,
      stderr: "ERROR: The process \"123\" not found.",
      stdout: "",
    })) as unknown as typeof import("node:child_process").spawnSync,
    verifyIdentity: () => {
      proofs += 1;
      return proofs === 1
        ? { status: "valid", valid: true }
        : { status: "dead_pid", valid: false };
    },
  });
  assert.deepEqual(result, {
    args: ["/PID", "123", "/T"],
    command: "taskkill",
    signalTarget: "processTree",
  });
  assert.equal(proofs, 2);
});

});

await describe("Durable stop claims", { concurrency: false }, async () => {


const valid = { status: "valid", valid: true, alive: true } as const;
const proof = { runtimePlatform: "linux" as const, verifyIdentity: () => valid,
  killProcess: () => assert.fail("A stop claim must not signal"),
  spawnProcess: () => assert.fail("A stop claim must not taskkill") };
const request = { ownerId: "owner-a", runInstanceId: "generation-a", reason: "manual_kill" as const };
const readJson = (path: string) => readJsonFileResilient<Record<string, unknown> | undefined>(path, undefined).value;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stop-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "review");
  const meta = {
    run: "review", run_instance_id: "generation-a", ownerId: "owner-a", pid: process.pid,
    state_dir: stateDir, outcome_protocol: RUN_OUTCOME_PROTOCOL,
    process_identity: readProcessIdentity(process.pid) ?? { platform: process.platform, start_time: "fixture-start", command: "node fixture", cwd: root },
    ...createRunSupervisionClock(resolveRunSupervisionPolicy({ max_runtime: "1ms" }), Date.now() - 1000),
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const status = () => buildRunStatus(stateDir, "review", readJson(join(stateDir, "run.json"))!, readJson, "unused", 0);
  return { root, stateDir, meta, status };
}

function waitSync(path: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Fixture handshake timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Fixture handshake timed out");
    await delay(10);
  }
}

async function worker(t: TestContext, root: string, source: string) {
  const path = join(root, "worker.mjs");
  await writeFile(path, source);
  const child = spawn(process.execPath, ["--experimental-strip-types", path], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += String(data); });
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; });
  return { child, exit, stderr: () => stderr };
}

const controlUrl = new URL("../lib/runs-control.ts", import.meta.url).href;
const resultUrl = new URL("../lib/runs-results.ts", import.meta.url).href;
const prelude = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
function waitFor(path) { const end=Date.now()+10000; while(!existsSync(path)) { if(Date.now()>end) throw Error('handshake timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } }
`;

test("A durable stop request is nonterminal, immutable, and independent of signals and Control capacity", async (t) => {
  const { stateDir, meta, status } = await fixture(t);
  writeFileSync(join(stateDir, "controls.jsonl"), "intentionally unreadable actor-local journal");
  const first = claimRunStop(stateDir, request, { ...proof, verifyIdentity: () => {
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
    return valid;
  } });
  assert.equal(first.status, "stop_requested");
  if (first.status !== "stop_requested") return;
  assert.equal(first.stopped, false);
  assert.equal(first.reused, false);
  const bytes = await readFile(join(stateDir, RUN_STOP_CLAIM_FILE), "utf8");
  const second = claimRunStop(stateDir, { ...request, reason: "max_runtime" }, proof);
  assert.equal(second.status, "stop_requested");
  if (second.status !== "stop_requested") return;
  assert.equal(second.reused, true);
  assert.equal(second.claim.reason, "manual_kill");
  assert.equal(second.claim.claim_id, first.claim.claim_id);
  assert.equal(await readFile(join(stateDir, RUN_STOP_CLAIM_FILE), "utf8"), bytes);
  assert.equal(Object.isFrozen(second.claim), true);
  assert.equal(status().status, "running");
  assert.equal(status().phase, "stopping");
  assert.equal(status().stopped, false);
  for (const file of ["terminal-handled.json", "progress.json", "execution.json", "trace.jsonl", "result.json"]) {
    assert.equal(existsSync(join(stateDir, file)), false, file);
  }
  assert.equal(readRunStopClaim(stateDir, meta).state, "pending");
});

test("An earlier natural acceptance wins without admitting a stop or requiring a live process", async (t) => {
  for (const code of [0, 7]) {
    const { stateDir } = await fixture(t);
    const { producer } = admitRunResultProducer(stateDir);
    publishRunResult(stateDir, producer, { code, stop_claim_id: "forged", terminal_acceptance: "after_stop_claim" }, {
      primaryText: () => ({ output: null, output_unavailable: "fixture_unavailable" }),
    });
    const result = readJson(join(stateDir, "result.json"))!;
    assert.equal(result.terminal_acceptance, "natural"); assert.equal(result.output_unavailable, "fixture_unavailable");
    assert.equal(Object.hasOwn(result, "stop_claim_id"), false);
    const before = readFileSync(join(stateDir, "result.json"), "utf8");
    assert.deepEqual(claimRunStop(stateDir, request, { ...proof, verifyIdentity: () => assert.fail("Natural acceptance already won") }), {
      status: "already_terminal", terminal_status: code === 0 ? "done" : "failed",
    });
    assert.equal(existsSync(join(stateDir, RUN_STOP_CLAIM_FILE)), false);
    assert.equal(readFileSync(join(stateDir, "result.json"), "utf8"), before);
  }
});

test("Accepted natural outcomes decide stop ACKs before later malformed or matching pending stop evidence", async (t) => {
  for (const code of [0, 7]) for (const kind of ["malformed", "pending"]) {
    const { stateDir, meta } = await fixture(t);
    const { producer } = admitRunResultProducer(stateDir);
    publishRunResult(stateDir, producer, { code, output: "accepted before late stop evidence" });
    const path = join(stateDir, RUN_STOP_CLAIM_FILE);
    // Fault injection after kernel acceptance, not a valid control-owner stop admission.
    if (kind === "malformed") writeFileSync(path, "{unproven");
    else writeJsonAtomic(path, { version: 1, claim_id: randomUUID(), run: meta.run, run_instance_id: meta.run_instance_id,
      ownerId: meta.ownerId, pid: meta.pid, process_identity_digest: runProcessIdentityDigest(meta.process_identity),
      reason: "manual_kill", requested_at: new Date().toISOString() });
    assert.equal(readRunStopClaim(stateDir, meta).state, kind === "pending" ? "pending" : "invalid");
    const files = ["run.json", "result.json", RUN_STOP_CLAIM_FILE, "progress.json", "trace.jsonl", "terminal-handled.json", "controls.jsonl"];
    const bytes = () => files.map((name) => existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name), "utf8") : null);
    const before = bytes();
    for (const reason of ["manual_kill", "max_runtime"] as const) {
      assert.deepEqual(claimRunStop(stateDir, { ...request, reason }, {
        ...proof, verifyIdentity: () => assert.fail("Accepted natural ACK must not probe native identity"),
      }), { status: "already_terminal", terminal_status: code === 0 ? "done" : "failed" });
      assert.deepEqual(bytes(), before);
    }
    assert.deepEqual(claimRunStop(stateDir, { ...request, runInstanceId: "replacement" }, proof), { status: "rejected", code: "run_generation_mismatch" });
    assert.deepEqual(claimRunStop(stateDir, { ...request, ownerId: "foreign" }, proof), { status: "rejected", code: "run_owner_mismatch" });
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, outcome_protocol: "unsupported" });
    assert.deepEqual(claimRunStop(stateDir, request, proof), { status: "rejected", code: "run_outcome_protocol_unavailable" });
  }
});

test("Captured, legacy, coercible and stale results cannot outrank a pending stop or become terminal ACKs", async (t) => {
  const { stateDir, meta } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  const first = claimRunStop(stateDir, request, proof);
  assert.equal(first.status, "stop_requested");
  if (first.status !== "stop_requested") return;
  publishRunResult(stateDir, producer, { code: 0 });
  const capture = readJson(join(stateDir, "result.json"))!;
  const claimBytes = readFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), "utf8");
  for (const result of [capture, { code: 0 },
    { code: "0", run_instance_id: meta.run_instance_id, completedAt: new Date().toISOString(), terminal_acceptance: "natural" },
    { code: 0, run_instance_id: "replacement", completedAt: new Date().toISOString(), terminal_acceptance: "natural" },
    { code: 0, run_instance_id: meta.run_instance_id, completedAt: "invalid", terminal_acceptance: "natural" }]) {
    writeJsonAtomic(join(stateDir, "result.json"), result);
    assert.notEqual(readRunNaturalOutcome(stateDir, meta).state, "accepted");
    const before = readFileSync(join(stateDir, "result.json"), "utf8");
    assert.deepEqual(claimRunStop(stateDir, request, { ...proof, verifyIdentity: () => assert.fail("Pending claim already owns the stop") }), {
      status: "stop_requested", stopped: false, reused: true, claim: first.claim,
    });
    assert.equal(readFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), "utf8"), claimBytes);
    assert.equal(readFileSync(join(stateDir, "result.json"), "utf8"), before);
  }
});

test("A later workload result is retained as a stopping capture, never a natural terminal event", async (t) => {
  const { stateDir, meta, status } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  const first = claimRunStop(stateDir, { ...request, reason: "max_runtime" }, proof);
  assert.equal(first.status, "stop_requested");
  if (first.status !== "stop_requested") return;
  let prepared = 0;
  assert.equal(publishRunResult(stateDir, producer, { code: 0, work_text: "retained work", stop_claim_id: "forged" }, {
    primaryText: () => ({ output: null, output_unavailable: "fixture_unavailable" }),
    artifactInventory: () => ({ artifact_inventory: null, artifact_inventory_unavailable: "fixture_unavailable" }),
    resultDiagnostics: () => ({ result_diagnostics: null, result_diagnostics_unavailable: "fixture_unavailable" }),
    prepare: ({ stopping }) => { assert.equal(stopping, true); prepared++; },
    trace: { kind: "run.done" },
  }), true);
  const capture = readJson(join(stateDir, "result.json"))!;
  assert.equal(capture.terminal_acceptance, "after_stop_claim");
  assert.equal(capture.stop_claim_id, first.claim.claim_id);
  assert.equal(capture.work_text, "retained work"); assert.equal(capture.output, null); assert.equal(capture.output_unavailable, "fixture_unavailable");
  assert.equal(capture.artifact_inventory, null); assert.equal(capture.artifact_inventory_unavailable, "fixture_unavailable");
  assert.equal(capture.result_diagnostics, null); assert.equal(capture.result_diagnostics_unavailable, "fixture_unavailable");
  assert.equal(capture.result_diagnostics_protocol, "run-result-diagnostics-v1");
  assert.equal(readRunNaturalOutcome(stateDir, meta).state, "captured");
  assert.equal(status().status, "running");
  assert.equal(status().stop_reason, "max_runtime");
  const trace = readFileSync(join(stateDir, "trace.jsonl"), "utf8");
  assert.equal(trace.includes('"kind":"run.result_captured"'), true);
  assert.equal(trace.includes('"kind":"run.done"'), false);
  assert.equal(publishRunResult(stateDir, producer, { code: 1 }), false);
  assert.equal(prepared, 1);
  assert.throws(() => admitRunResultProducer(stateDir), /work admission is stopping/);
});

test("Claim admission rechecks exact generation, owner, protocol, and native process evidence", async (t) => {
  const { stateDir, meta } = await fixture(t);
  const rejected = (input: typeof request, code: string) => {
    assert.deepEqual(claimRunStop(stateDir, input, { ...proof, verifyIdentity: () => assert.fail("Rejected intent probed a process") }), {
      status: "rejected", code,
    });
  };
  rejected({ ...request, runInstanceId: "" }, "run_generation_required");
  rejected({ ...request, runInstanceId: "other" }, "run_generation_mismatch");
  rejected({ ...request, ownerId: "other" }, "run_owner_mismatch");
  writeJsonAtomic(join(stateDir, "run.json"), { ...meta, outcome_protocol: undefined });
  rejected(request, "run_outcome_protocol_unavailable");
  for (const runtimePlatform of ["linux", "darwin", "win32"] as const) {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, process_identity: { ...meta.process_identity, platform: runtimePlatform } });
    assert.deepEqual(claimRunStop(stateDir, request, { ...proof, runtimePlatform, verifyIdentity: () => ({ valid: false, alive: true, status: "unsupported_proof" }) }), {
      status: "rejected", code: "run_process_unproven",
    });
  }
  assert.equal(existsSync(join(stateDir, RUN_STOP_CLAIM_FILE)), false);
});

test("Missing owners are exact, deadline configuration is required, and cached-host producers bind before work", async (t) => {
  const { stateDir, meta } = await fixture(t);
  const { ownerId: _owner, outcome_protocol: _protocol, ...legacy } = meta;
  writeJsonAtomic(join(stateDir, "run.json"), legacy);
  const { meta: bound } = admitRunResultProducer(stateDir);
  assert.equal(bound.outcome_protocol, RUN_OUTCOME_PROTOCOL);
  assert.deepEqual(claimRunStop(stateDir, request, proof), { status: "rejected", code: "run_owner_mismatch" });
  writeJsonAtomic(join(stateDir, "run.json"), { ...bound, ...createRunSupervisionClock(resolveRunSupervisionPolicy(), Date.now()) });
  assert.deepEqual(claimRunStop(stateDir, { ...request, ownerId: undefined, reason: "max_runtime" }, proof), {
    status: "rejected", code: "run_deadline_unconfigured",
  });
  assert.equal(claimRunStop(stateDir, { ...request, ownerId: undefined }, proof).status, "stop_requested");
});

test("Pending or missing-claim captures cannot authorize same-directory restart", async (t) => {
  const { stateDir, meta, status } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  claimRunStop(stateDir, request, proof);
  publishRunResult(stateDir, producer, { code: 0 });
  const before = readFileSync(join(stateDir, "run.json"), "utf8");
  assert.throws(() => readActiveOwnedRunState(stateDir, readJson, "unused"), /stop is pending/);
  assert.throws(() => prepareStateDirForStart(stateDir, readJson, "unused"), /stop is pending/);
  assert.equal(readFileSync(join(stateDir, "run.json"), "utf8"), before);
  await rm(join(stateDir, RUN_STOP_CLAIM_FILE));
  assert.equal(status().status, "running");
  assert.equal(status().stop_error, "claim_unavailable");
  assert.throws(() => prepareStateDirForStart(stateDir, readJson, "unused"), /capture is not confirmed/);
  assert.equal(readRunStopClaim(stateDir, meta).state, "absent");
});

test("Malformed, oversized, and symlinked stop evidence fails closed before publication or replacement", async (t) => {
  const { root, stateDir, status } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  for (const bytes of ["{private fixture secret", JSON.stringify({ run_instance_id: "generation-a", padding: "x".repeat(20_000) })]) {
    writeFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), bytes);
    assert.equal(status().status, "running");
    assert.equal(status().stop_error, "claim_unavailable");
    assert.deepEqual(claimRunStop(stateDir, request, proof), { status: "rejected", code: "run_stop_state_unavailable" });
    assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { prepare: () => assert.fail("Unproven state prepared evidence") }), /stop state/);
    assert.equal(existsSync(join(stateDir, "result.json")), false);
    assert.equal(readFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), "utf8"), bytes);
  }
  await rm(join(stateDir, RUN_STOP_CLAIM_FILE));
  const foreign = join(root, "foreign.json");
  await writeFile(foreign, "private foreign bytes");
  try { await symlink(foreign, join(stateDir, RUN_STOP_CLAIM_FILE)); }
  catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
  assert.deepEqual(claimRunStop(stateDir, request, proof), { status: "rejected", code: "run_stop_state_unavailable" });
  assert.equal(await readFile(foreign, "utf8"), "private foreign bytes");
});

test("Stale-generation intent never suppresses a replacement generation's natural result", async (t) => {
  const { stateDir, meta, status } = await fixture(t);
  claimRunStop(stateDir, request, proof);
  const replacement = { ...meta, run_instance_id: "generation-b" };
  writeJsonAtomic(join(stateDir, "run.json"), replacement);
  assert.equal(readRunStopClaim(stateDir, replacement).state, "stale");
  const { producer } = admitRunResultProducer(stateDir);
  publishRunResult(stateDir, producer, { code: 0 });
  assert.equal(status().status, "done");
  assert.equal(status().phase, undefined);
  writeJsonAtomic(join(stateDir, "result.json"), { code: 0, run_instance_id: "generation-a" });
  assert.equal(status().result, null);
  assert.equal(status().result_error, "generation_mismatch");
});

test("A stop contender waiting on natural publication sees the accepted result after the lock", async (t) => {
  const { root, stateDir } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  const blocked = join(root, "blocked");
  const go = join(root, "go");
  const output = join(root, "out.json");
  const child = await worker(t, root, `${prelude}
import { claimRunStop } from ${JSON.stringify(controlUrl)};
waitFor(${JSON.stringify(go)});
const result=claimRunStop(${JSON.stringify(stateDir)},${JSON.stringify(request)}, {
 verifyIdentity:()=>(${JSON.stringify(valid)}), onLockContention:()=>writeFileSync(${JSON.stringify(blocked)},'blocked')
});
writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
`);
  publishRunResult(stateDir, producer, { code: 0 }, { prepare: () => { writeFileSync(go, "go"); waitSync(blocked); } });
  assert.deepEqual(await child.exit, [0, null], child.stderr());
  assert.equal(JSON.parse(await readFile(output, "utf8")).status, "already_terminal");
  assert.equal(existsSync(join(stateDir, RUN_STOP_CLAIM_FILE)), false);
});

test("A natural producer waiting on a stop claim preserves the first cause after confirmed runner exit", async (t) => {
  const { root, stateDir, meta, status } = await fixture(t);
  const ready = join(root, "ready");
  const go = join(root, "go");
  const bound = join(root, "bound");
  const announced = join(root, "announced");
  const blocked = join(root, "blocked");
  const child = await worker(t, root, `${prelude}
import { admitRunResultProducer, publishRunResult } from ${JSON.stringify(resultUrl)};
writeFileSync(${JSON.stringify(announced)}, "announced");
waitFor(${JSON.stringify(ready)});
const {producer}=admitRunResultProducer(${JSON.stringify(stateDir)});
writeFileSync(${JSON.stringify(bound)},'bound'); waitFor(${JSON.stringify(go)});
publishRunResult(${JSON.stringify(stateDir)},producer,{code:0, output:'complete fixture capture'},{
 onLockContention:()=>writeFileSync(${JSON.stringify(blocked)},'blocked'), trace:{kind:'run.done'}
});
`);
  await waitFor(announced);
  writeJsonAtomic(join(stateDir, "run.json"), {
    ...meta, pid: child.child.pid, process_identity: readProcessIdentity(child.child.pid!) ?? meta.process_identity,
  });
  writeFileSync(ready, "ready");
  await waitFor(bound);
  const claim = claimRunStop(stateDir, { ...request, reason: "max_runtime" }, { ...proof, verifyIdentity: () => {
    writeFileSync(go, "go"); waitSync(blocked); return valid;
  } });
  assert.equal(claim.status, "stop_requested");
  assert.deepEqual(await child.exit, [0, null], child.stderr());
  assert.equal(status().status, "running");
  assert.equal(status().phase, "stopping");
  assert.equal(status().stop_reason, "max_runtime");
  assert.equal(readJson(join(stateDir, "result.json"))?.terminal_acceptance, "after_stop_claim");
  assert.throws(() => prepareStateDirForStart(stateDir, readJson, "unused"), /stop is pending/);
});

test("A stop contender revalidates replacement generation after lifecycle-lock contention", async (t) => {
  const { root, stateDir, meta } = await fixture(t);
  const blocked = join(root, "blocked");
  const output = join(root, "out.json");
  const release = acquireStateStartLock(stateDir);
  try {
    const child = await worker(t, root, `${prelude}
import { claimRunStop } from ${JSON.stringify(controlUrl)};
const result=claimRunStop(${JSON.stringify(stateDir)},${JSON.stringify(request)}, {
 verifyIdentity:()=>{throw Error('stale contender probed process')}, onLockContention:()=>writeFileSync(${JSON.stringify(blocked)},'blocked')
});
writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
`);
    await waitFor(blocked);
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, run_instance_id: "generation-b" });
    release();
    assert.deepEqual(await child.exit, [0, null], child.stderr());
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { status: "rejected", code: "run_generation_mismatch" });
    assert.equal(existsSync(join(stateDir, RUN_STOP_CLAIM_FILE)), false);
  } finally { release(); }
});

});
