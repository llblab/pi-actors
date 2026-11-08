/** Mirrors lib/runs-results.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import {
  execFile,
  spawn,
} from "node:child_process";
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
  readdir,
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
  fileURLToPath,
} from "node:url";
import {
  promisify,
} from "node:util";
import {
  mutationLockPath,
  writeJsonAtomic,
} from "../lib/file-state.ts";
import {
  RUN_OUTCOME_PROTOCOL,
  RUN_ARTIFACT_INVENTORY_PROTOCOL,
  decodeRunArtifactInventoryBinding,
  RUN_RESULT_DIAGNOSTICS_PROTOCOL,
  decodeRunResultDiagnosticsBinding,
  RUN_STOP_CLAIM_FILE,
} from "../lib/runs-outcomes.ts";
import {
  readProcessIdentity,
  readProcessLiveness,
} from "../lib/runs-process.ts";
import {
  claimRunStateDirectory,
  readOwnedRunStateDirectory,
  RUN_STATE_OWNERSHIP_FILE,
} from "../lib/runs-ownership.ts";
import {
  admitRunResultProducer,
  publishRunResult,
  withRunResultDiagnosticsAdmission,
  type RunResultDiagnosticsAdmission,
  withRunProducerEvidence,
  withRunWorkAdmission,
} from "../lib/runs-results.ts";
import {
  acquireStateStartLock,
} from "../lib/runs-start.ts";
import {
  setTimeout as delay,
} from "node:timers/promises";
import {
  startRun,
  getRunStatus,
} from "../lib/async-runs.ts";
import {
  execCommandTemplate,
} from "../lib/command-templates.ts";
import {
  claimRunStop,
} from "../lib/runs-control.ts";
import {
  RUN_NATIVE_LAUNCH_FILE,
} from "../lib/runs-native-launches.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("First-result publication", { concurrency: false }, async () => {

const execFileAsync = promisify(execFile);


async function fixture(t: TestContext, ownerId: string | null = "owner-a") {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "review");
  const meta = {
    run: "review", run_instance_id: "generation-a", pid: process.pid,
    outcome_protocol: RUN_OUTCOME_PROTOCOL,
    state_dir: stateDir, ...(ownerId ? { ownerId } : {}),
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const identity = { run: meta.run, runInstanceId: meta.run_instance_id };
  return { root, stateDir, meta, identity };
}

test("Diagnostic first-result admission is genuine, snapshot-bound, synchronous and revoked before any later publication", async t => {
  const { stateDir } = await fixture(t); const { producer } = admitRunResultProducer(stateDir);
  let prepared = 0; let callbacks = 0; let retained: RunResultDiagnosticsAdmission | undefined;
  const input = { code: 7, command: "first command", error: "first error", failure_reason: "first reason", output: "actor body",
    result_diagnostics: { source: { path: "/actor/path" } }, result_diagnostics_protocol: "actor permission", result_diagnostics_unavailable: "actor reason" };
  assert.throws(() => publishRunResult(stateDir, { ...producer }, input, { prepare: () => prepared++ }), /admitted by this runtime/);
  assert.equal(prepared, 0); assert.equal(existsSync(join(stateDir, "result.json")), false);
  const resultDiagnostics = (admission: RunResultDiagnosticsAdmission) => {
    callbacks++; retained = admission;
    assert.equal(Object.isFrozen(admission), true);
    assert.throws(() => withRunResultDiagnosticsAdmission(stateDir, producer, { ...admission }, () => assert.fail()), /active runtime-local admission/);
    return withRunResultDiagnosticsAdmission(stateDir, producer, admission, candidate => {
      assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
      assert.deepEqual(candidate, { command: "first command", error: "first error", failure_reason: "first reason" });
      assert.equal(Object.isFrozen(candidate), true); input.code = 0; input.error = "late error";
      return { result_diagnostics: null, result_diagnostics_unavailable: "fixture_unavailable" } as const;
    });
  };
  assert.equal(publishRunResult(stateDir, producer, input, { prepare: () => { prepared++; input.command = "late command"; }, resultDiagnostics }), true);
  const first = readFileSync(join(stateDir, "result.json"), "utf8"); const result = JSON.parse(first);
  assert.equal(result.code, 7); assert.equal(result.command, "first command"); assert.equal(result.error, "first error");
  assert.equal(result.output, undefined); assert.equal(result.result_diagnostics, null);
  assert.equal(result.result_diagnostics_unavailable, "fixture_unavailable"); assert.equal(result.result_diagnostics_protocol, RUN_RESULT_DIAGNOSTICS_PROTOCOL);
  assert.throws(() => withRunResultDiagnosticsAdmission(stateDir, producer, retained!, () => assert.fail()), /active runtime-local admission/);
  assert.equal(publishRunResult(stateDir, producer, { code: 0 }, { resultDiagnostics: () => assert.fail("A duplicate must not open a new diagnostics window") }), false);
  assert.equal(callbacks, 1); assert.equal(prepared, 1); assert.equal(readFileSync(join(stateDir, "result.json"), "utf8"), first);
});

test("Diagnostic bindings curate data without invoking accessor/thenable completions or manufacturing source authority", async t => {
  const { stateDir } = await fixture(t); const { producer } = admitRunResultProducer(stateDir);
  const reference = { source: { path: join(stateDir, "evidence", `result-diagnostics-${"a".repeat(64)}.json`), run_instance_id: producer.runInstanceId, sha256: "b".repeat(64) }, bytes_total: 400, fields: ["error"] };
  const binding = decodeRunResultDiagnosticsBinding(stateDir, producer.runInstanceId, { result_diagnostics: { ...reference, body: "not admitted" } });
  assert.equal(Object.isFrozen(binding), true); if (binding.result_diagnostics) { assert.deepEqual(binding.result_diagnostics, reference); assert.equal(Object.isFrozen(binding.result_diagnostics.fields), true); }
  let invoked = 0;
  for (const value of [Object.assign({ result_diagnostics: reference }, { then: () => invoked++ }), Object.create({ then: () => invoked++ }),
    Object.defineProperty({}, "result_diagnostics", { enumerable: true, get() { invoked++; return reference; } })]) {
    assert.throws(() => publishRunResult(stateDir, producer, { code: 7 }, { resultDiagnostics: () => value as never }), /synchronously|invalid/);
  }
  const fields = Object.defineProperty(["error"], "0", { get() { invoked++; return "error"; } });
  assert.throws(() => decodeRunResultDiagnosticsBinding(stateDir, producer.runInstanceId, { result_diagnostics: { ...reference, fields } }), /invalid/);
  for (const fields of [[], ["output"], ["error", "error"], ["error", "command"]]) {
    assert.throws(() => decodeRunResultDiagnosticsBinding(stateDir, producer.runInstanceId, { result_diagnostics: { ...reference, fields } }), /invalid/);
  }
  assert.throws(() => publishRunResult(stateDir, producer, { code: 7 }, { resultDiagnostics: () => Promise.reject(Error("deferred fixture failure")) as never }), /synchronously/);
  assert.throws(() => publishRunResult(stateDir, producer, Object.defineProperty({ code: 7 }, "error", { enumerable: true, get() { invoked++; return "untracked"; } })), /data properties/);
  assert.throws(() => publishRunResult(stateDir, producer, { code: 7, toJSON: () => { invoked++; return { code: 0 }; } }), /serialization/);
  assert.equal(invoked, 0); assert.equal(existsSync(join(stateDir, "result.json")), false);
  assert.equal(publishRunResult(stateDir, producer, { code: 7, result_diagnostics: reference, result_diagnostics_protocol: RUN_RESULT_DIAGNOSTICS_PROTOCOL }), true);
  const result = JSON.parse(readFileSync(join(stateDir, "result.json"), "utf8")); assert.equal(result.result_diagnostics, undefined); assert.equal(result.result_diagnostics_protocol, undefined);
});

test("Result evidence callbacks revalidate owner/generation/native contradictions before a canonical result", async t => {
  for (const phase of ["prepare", "diagnostics"] as const) for (const field of ["ownerId", "run_instance_id", "process_identity"] as const) {
    const { stateDir, meta } = await fixture(t); const native = readProcessIdentity(process.pid);
    if (field === "process_identity" && !native) continue;
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, process_identity: native });
    const { producer } = admitRunResultProducer(stateDir);
    const change = () => {
      writeJsonAtomic(join(stateDir, "run.json"), { ...meta, process_identity: native, [field]: field === "process_identity" ? { ...native, command: "contradiction" } : "changed" });
      return { result_diagnostics: null, result_diagnostics_unavailable: "fixture_unavailable" } as const;
    };
    assert.throws(() => publishRunResult(stateDir, producer, { code: 7 }, phase === "prepare" ? { prepare: change } : { resultDiagnostics: change }), /owner changed|generation changed|identity changed/);
    assert.equal(existsSync(join(stateDir, "result.json")), false);
  }
});

test("Available native contradictions fence admission before protocol upgrade and publication before preparation", async (t) => {
  const native = readProcessIdentity(process.pid);
  if (!native) { t.skip("Native self identity is unavailable on this platform"); return; }
  for (const field of ["start_time", "command", "cwd"] as const) {
    for (const phase of ["admission", "publication"] as const) {
      const { stateDir, meta } = await fixture(t);
      writeJsonAtomic(join(stateDir, "run.json"), { ...meta, process_identity: native });
      const producer = phase === "publication" ? admitRunResultProducer(stateDir).producer : undefined;
      writeJsonAtomic(join(stateDir, "run.json"), {
        ...meta, ...(phase === "admission" ? { outcome_protocol: undefined } : {}),
        process_identity: { ...native, [field]: `${native[field] ?? ""}-contradiction` },
      });
      const before = readFileSync(join(stateDir, "run.json"), "utf8");
      assert.throws(() => phase === "admission"
        ? admitRunResultProducer(stateDir)
        : publishRunResult(stateDir, producer!, { code: 0 }, {
          prepare: () => assert.fail("Contradictory native identity prepared evidence"),
        }), /process identity changed/);
      assert.equal(readFileSync(join(stateDir, "run.json"), "utf8"), before);
      assert.equal(existsSync(join(stateDir, "result.json")), false);
    }
  }
});

test("Unavailable native proof preserves the exact-PID legacy producer binding without authorizing stop proof", async (t) => {
  const { stateDir, meta } = await fixture(t);
  writeJsonAtomic(join(stateDir, "run.json"), { ...meta, outcome_protocol: undefined });
  const { producer, meta: bound } = admitRunResultProducer(stateDir);
  assert.equal(bound.process_identity, undefined);
  assert.equal(bound.outcome_protocol, RUN_OUTCOME_PROTOCOL);
  assert.equal(publishRunResult(stateDir, producer, { code: 0 }), true);
});

test("Natural result admission binds the current producer and accepts only the first result", async (t) => {
  const { stateDir, identity } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  assert.deepEqual(readOwnedRunStateDirectory(stateDir), { run: identity.run, stateDir });
  assert.equal(Object.isFrozen(producer), true);
  assert.equal(producer.pid, process.pid);
  let prepared = 0; let bindings = 0; let inventories = 0;
  const primary = { output: null, output_unavailable: "fixture_unavailable" } as const;
  const prepare = () => {
    prepared++;
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
    writeJsonAtomic(join(stateDir, "progress.json"), { phase: "done" });
  };
  assert.equal(publishRunResult(stateDir, producer, {
    code: 0, run_instance_id: "untrusted-payload-generation", completedAt: "not-an-acceptance-time",
  }, { prepare, primaryText: () => { bindings++; return primary; }, artifactInventory: () => { inventories++; return { artifact_inventory: null, artifact_inventory_unavailable: "fixture_unavailable" }; }, trace: { kind: "run.done", data: { code: 0 } } }), true);
  const original = await readFile(join(stateDir, "result.json"), "utf8");
  const result = JSON.parse(original);
  assert.equal(result.code, 0); assert.equal(result.output, null); assert.equal(result.output_unavailable, primary.output_unavailable);
  assert.equal(result.artifact_inventory, null); assert.equal(result.artifact_inventory_unavailable, "fixture_unavailable");
  assert.equal(result.artifact_inventory_protocol, RUN_ARTIFACT_INVENTORY_PROTOCOL);
  assert.equal(result.run_instance_id, identity.runInstanceId);
  assert.equal(new Date(result.completedAt).toISOString(), result.completedAt);
  assert.equal(publishRunResult(stateDir, producer, { code: 1 }, {
    prepare, primaryText: () => assert.fail("A later source cannot attach to an unavailable winner"), artifactInventory: () => assert.fail("A later inventory cannot replace the first binding"), trace: { kind: "run.failed", data: { code: 1 } },
  }), false);
  assert.equal(readFileSync(join(stateDir, "trace.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.equal(prepared, 1); assert.equal(bindings, 1); assert.equal(inventories, 1);
  assert.equal(await readFile(join(stateDir, "result.json"), "utf8"), original);
});

test("Ancillary Trace failure cannot overwrite an already accepted natural result", async (t) => {
  const { stateDir } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, {
    primaryText: () => ({ output: null, output_unavailable: "fixture_unavailable" }),
    artifactInventory: () => ({ artifact_inventory: null, artifact_inventory_unavailable: "fixture_unavailable" }),
    resultDiagnostics: () => ({ result_diagnostics: null, result_diagnostics_unavailable: "fixture_unavailable" }),
    trace: { kind: "invalid kind" },
  }), /kind/);
  const accepted = await readFile(join(stateDir, "result.json"), "utf8");
  assert.equal(JSON.parse(accepted).code, 0); assert.equal(JSON.parse(accepted).output_unavailable, "fixture_unavailable");
  assert.equal(JSON.parse(accepted).artifact_inventory_unavailable, "fixture_unavailable");
  assert.equal(JSON.parse(accepted).result_diagnostics_unavailable, "fixture_unavailable");
  assert.equal(publishRunResult(stateDir, producer, { code: 1 }), false);
  assert.equal(await readFile(join(stateDir, "result.json"), "utf8"), accepted);
});

test("Natural publication rejects stale owner, generation, and process before evidence writes", async (t) => {
  const { stateDir, meta } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  for (const [delta, error] of [
    [{ run_instance_id: "generation-b" }, /generation changed/],
    [{ ownerId: "owner-b" }, /owner changed/],
    [{ pid: process.pid + 1 }, /process changed/],
  ] as const) {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, ...delta });
    assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, {
      prepare: () => assert.fail("Rejected producer prepared terminal evidence"),
    }), error);
    assert.equal(existsSync(join(stateDir, "result.json")), false);
  }
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  assert.throws(() => publishRunResult(stateDir, { ...producer, runInstanceId: "" }, { code: 0 }), /captured Run/);
  writeJsonAtomic(join(stateDir, "run.json"), { ...meta, pid: process.pid + 1 });
  assert.throws(() => admitRunResultProducer(stateDir), /process changed/);
  assert.throws(() => publishRunResult(stateDir, { ...producer, pid: process.pid + 1 }, { code: 0 }), /admitted by this runtime/);
});

test("Missing owners are exact identities rather than ownership wildcards", async (t) => {
  const { stateDir, meta: ownerless } = await fixture(t, null);
  const { producer } = admitRunResultProducer(stateDir);
  assert.equal(producer.ownerId, undefined);
  writeJsonAtomic(join(stateDir, "run.json"), { ...ownerless, ownerId: "owner-b" });
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }), /owner changed/);
  writeJsonAtomic(join(stateDir, "run.json"), ownerless);
  assert.equal(publishRunResult(stateDir, producer, { code: -1 }), true);
});

test("Malformed metadata, invalid results, and failed preparation never publish terminal acceptance", async (t) => {
  const { stateDir } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  for (const code of [undefined, "0", 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => publishRunResult(stateDir, producer, { code }), /safe integer/);
  }
  assert.throws(() => publishRunResult(stateDir, producer, Object.create({ code: 0 })), /safe integer/);
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, {
    prepare: () => { throw new Error("evidence preparation failed"); },
  }), /evidence preparation failed/);
  assert.equal(existsSync(join(stateDir, "result.json")), false);
  for (const metadata of ["{secret", "null", "[]"]) {
    writeFileSync(join(stateDir, "run.json"), metadata);
    assert.throws(() => admitRunResultProducer(stateDir), /metadata is unavailable or invalid/);
  }
});

test("Result publication rejects symlinked metadata and terminal destinations", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, stateDir, meta } = await fixture(t);
  const { producer } = admitRunResultProducer(stateDir);
  const marker = join(stateDir, RUN_STATE_OWNERSHIP_FILE);
  const markerBytes = readFileSync(marker, "utf8");
  const markerCopy = join(root, "marker-copy.json");
  writeFileSync(markerCopy, markerBytes);
  await rm(marker);
  await symlink(markerCopy, marker);
  assert.throws(() => admitRunResultProducer(stateDir), /ownership marker is missing or invalid/);
  await rm(marker);
  writeFileSync(marker, markerBytes);
  const foreign = join(root, "foreign.json");
  writeJsonAtomic(foreign, meta);
  const original = readFileSync(foreign, "utf8");
  await rm(join(stateDir, "run.json"));
  await symlink(foreign, join(stateDir, "run.json"));
  assert.throws(() => admitRunResultProducer(stateDir), /metadata is unavailable or invalid/);
  await rm(join(stateDir, "run.json"));
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  await symlink(foreign, join(stateDir, "result.json"));
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }), /not a regular file/);
  assert.equal(readFileSync(foreign, "utf8"), original);
});

test("A delayed or unbound runner cannot execute work or publish into another generation", async (t) => {
  const { root, stateDir, meta } = await fixture(t);
  const marker = join(root, "unexpected-work");
  const before = (await readdir(stateDir)).sort();
  const runner = fileURLToPath(new URL("../scripts/async-runner.mjs", import.meta.url));
  for (const [delta, reason] of [
    [{ run_instance_id: "replacement-generation" }, /process changed/],
    [{ pid: 0 }, /identity is unavailable or invalid/],
    [{ run_instance_id: "" }, /identity is unavailable or invalid/],
  ] as const) {
    writeJsonAtomic(join(stateDir, "run.json"), {
      ...meta,
      ...delta,
      cwd: process.cwd(),
      template: `${process.execPath} -e "require('node:fs').writeFileSync(process.argv[1],'bad')" {marker}`,
      values: { marker },
      secret: "fixture-value-not-for-diagnostics",
    });
    await assert.rejects(execFileAsync(process.execPath, [runner, stateDir]), (error: any) => {
      assert.match(error.stderr, reason);
      assert.doesNotMatch(error.stderr, /fixture-value-not-for-diagnostics/);
      return true;
    });
    assert.equal(existsSync(marker), false);
    assert.deepEqual((await readdir(stateDir)).sort(), before);
  }
});

test("A producer blocked on the lifecycle lock revalidates the replaced generation", {
  timeout: 10_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-result-contention-"));
  const stateDir = claimRunStateDirectory(join(root, "state"), "review");
  const meta = { run: "review", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, outcome_protocol: RUN_OUTCOME_PROTOCOL };
  const contended = join(root, "contended"); const prepared = join(root, "prepared");
  const admitted = join(root, "admitted"); const gate = join(root, "publish-gate"); let proven = false;
  t.after(async () => { if (proven) await rm(root, { recursive: true, force: true }); });
  const script = `
    import { writeFileSync, existsSync } from "node:fs";
    import { writeJsonAtomic } from ${JSON.stringify(new URL("../lib/file-state.ts", import.meta.url).href)};
    import { admitRunResultProducer, publishRunResult } from ${JSON.stringify(new URL("../lib/runs-results.ts", import.meta.url).href)};
    try {
      writeJsonAtomic(${JSON.stringify(join(stateDir, "run.json"))},{...${JSON.stringify(meta)},pid:process.pid});
      const {producer}=admitRunResultProducer(${JSON.stringify(stateDir)});
      writeFileSync(${JSON.stringify(admitted)},"genuine producer captured");
      const until=Date.now()+4000;
      while(!existsSync(${JSON.stringify(gate)})){if(Date.now()>until)throw Error("Fixture admission gate expired");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
      publishRunResult(${JSON.stringify(stateDir)},producer,{code:0},{
        onLockContention:()=>writeFileSync(${JSON.stringify(contended)},"blocked"),
        prepare:()=>writeFileSync(${JSON.stringify(prepared)},"wrong generation"),
      });
    } catch(error){process.stderr.write(error.message);process.exitCode=7;}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  const captured = { pid: child.pid, state_dir: stateDir, run_instance_id: meta.run_instance_id };
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit").then(([code]) => ({ code, error: undefined }), error => ({ code: undefined, error }));
  let release: (() => void) | undefined; let failure: unknown;
  try {
    for (let attempt = 0; !existsSync(admitted) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(admitted), true, errors || "Producer admission was not captured");
    release = acquireStateStartLock(stateDir); writeFileSync(gate, "publish");
    for (let attempt = 0; !existsSync(contended) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(contended), true, errors || "Producer did not contend for the lifecycle lock");
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, pid: captured.pid, run_instance_id: "generation-b" });
  } catch (error) { failure = error; }
  finally { release?.(); }
  const exit = await exited;
  if (Number.isSafeInteger(captured.pid) && captured.pid! > 0) {
    try { process.kill(captured.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") proven = true; }
  }
  if (!proven) throw new AggregateError([failure, exit.error].filter(value => value !== undefined), `Captured fixture runner exit remains unproven; retaining state: ${root}`);
  if (failure) throw failure;
  assert.equal(exit.error, undefined); assert.equal(exit.code, 7, errors); assert.match(errors, /generation changed/);
  assert.equal(existsSync(prepared), false); assert.equal(existsSync(join(stateDir, "result.json")), false);
});


test("Artifact inventory result bindings are curated data, synchronous, generation-revalidated and never body authority", async t => {
  const { stateDir, meta } = await fixture(t); const { producer } = admitRunResultProducer(stateDir);
  const reference = { source: { path: join(stateDir, "evidence", `artifact-inventory-${"a".repeat(64)}.json`), run_instance_id: meta.run_instance_id, sha256: "b".repeat(64) }, bytes_total: 500, declarations_total: 5 };
  const binding = decodeRunArtifactInventoryBinding(stateDir, meta.run_instance_id, { artifact_inventory: reference });
  assert.equal(Object.isFrozen(binding), true); assert.ok(binding.artifact_inventory); assert.equal(Object.isFrozen(binding.artifact_inventory.source), true);
  reference.source.sha256 = "c".repeat(64); assert.equal(binding.artifact_inventory.source.sha256, "b".repeat(64));
  for (const changed of [
    { ...reference, source: { ...reference.source, path: "/private/capture.json" } },
    { ...reference, source: { ...reference.source, run_instance_id: "foreign" } },
    { ...reference, declarations_total: 0 }, { ...reference, bytes_total: 1 },
  ]) assert.throws(() => decodeRunArtifactInventoryBinding(stateDir, meta.run_instance_id, { artifact_inventory: changed }), /binding is invalid/);
  let invoked = 0; const accessor = { get artifact_inventory() { invoked++; return reference; } };
  assert.throws(() => decodeRunArtifactInventoryBinding(stateDir, meta.run_instance_id, accessor), /binding is invalid/); assert.equal(invoked, 0);
  const deferred = Promise.reject(Error("deferred artifact snapshot"));
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { artifactInventory: () => deferred as never }), /synchronously/);
  await Promise.resolve();
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { artifactInventory: () => ({ artifact_inventory: reference, then: () => { invoked++; } }) }), /synchronously/);
  const inherited = Object.assign(Object.create({ then: () => { invoked++; } }), { artifact_inventory: reference });
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { artifactInventory: () => inherited }), /synchronously/);
  assert.equal(invoked, 0); assert.equal(existsSync(join(stateDir, "result.json")), false);
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { artifactInventory: () => {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, run_instance_id: "replacement" }); return binding;
  } }), /generation changed/);
  assert.equal(existsSync(join(stateDir, "result.json")), false);
});

test("Result payload metadata cannot manufacture primary publication, and a kernel binding is generation-revalidated", async t => {
  const { stateDir, meta } = await fixture(t); const { producer } = admitRunResultProducer(stateDir);
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { primaryText: () => {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, run_instance_id: "replacement" });
    return { output: null, output_unavailable: "fixture_unavailable" };
  } }), /generation changed/);
  assert.equal(existsSync(join(stateDir, "result.json")), false);
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  const deferred = Promise.reject(Error("deferred binding must be settled, never awaited under the lock"));
  assert.throws(() => publishRunResult(stateDir, producer, { code: 0 }, { primaryText: () => deferred as never }), /synchronously/);
  await Promise.resolve(); assert.equal(existsSync(join(stateDir, "result.json")), false);
  publishRunResult(stateDir, producer, { code: 0, output: { source: "private capture", visible: true }, output_unavailable: "forged", primary_text_protocol: "run-primary-text-v1",
    artifact_inventory: { source: "/private/forged.json" }, artifact_inventory_unavailable: "forged", artifact_inventory_protocol: RUN_ARTIFACT_INVENTORY_PROTOCOL });
  const saved = JSON.parse(readFileSync(join(stateDir, "result.json"), "utf8"));
  assert.equal(Object.hasOwn(saved, "output"), false); assert.equal(Object.hasOwn(saved, "output_unavailable"), false); assert.equal(Object.hasOwn(saved, "primary_text_protocol"), false);
  assert.equal(Object.hasOwn(saved, "artifact_inventory"), false); assert.equal(Object.hasOwn(saved, "artifact_inventory_unavailable"), false); assert.equal(Object.hasOwn(saved, "artifact_inventory_protocol"), false);
});

});

await describe("Producer work admission", { concurrency: false }, async () => {


const request = { ownerId: "owner-a", runInstanceId: "generation-a", reason: "manual_kill" as const };
const valid = { status: "valid", valid: true } as const;
const proof = { verifyIdentity: () => valid };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-work-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "work");
  const meta = {
    run: "work", state_dir: stateDir, pid: process.pid, ownerId: request.ownerId,
    run_instance_id: request.runInstanceId, outcome_protocol: RUN_OUTCOME_PROTOCOL,
    process_identity: readProcessIdentity(process.pid),
  };
  writeJsonAtomic(join(stateDir, "run.json"), meta);
  return { root, stateDir, meta, producer: admitRunResultProducer(stateDir).producer };
}

async function waitFor(path: string) {
  const end = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= end) throw Error("Fixture handshake timed out");
    await delay(10);
  }
}

function waitSync(path: string) {
  const end = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= end) throw Error("Fixture handshake timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

async function waitExit(pid: number) {
  const end = Date.now() + 10_000;
  while (readProcessLiveness(pid) !== "dead") {
    if (Date.now() >= end) throw Error("Captured fixture runner exit remains unproven");
    await delay(10);
  }
}

const producerUrl = new URL("../lib/runs-results.ts", import.meta.url).href;
const controlUrl = new URL("../lib/runs-control.ts", import.meta.url).href;
const prelude = `import {existsSync,writeFileSync} from 'node:fs';
function waitFor(p){const end=Date.now()+10000;while(!existsSync(p)){if(Date.now()>end)throw Error('handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}
`;

async function worker(t: TestContext, root: string, source: string) {
  const path = join(root, "worker.mjs");
  await writeFile(path, source);
  const child = spawn(process.execPath, ["--experimental-strip-types", path], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += String(data); });
  const exit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  });
  return { child, exit, stderr: () => stderr };
}

test("Work preparation is generation-bound and the lifecycle lock does not span child execution", async (t) => {
  const { root, stateDir, producer } = await fixture(t);
  assert.throws(() => withRunWorkAdmission(stateDir, { ...producer }, () => assert.fail("Forged producer data admitted work")), /admitted by this runtime/);
  assert.throws(() => withRunProducerEvidence(stateDir, { ...producer }, () => assert.fail("Forged producer data wrote evidence")), /admitted by this runtime/);
  assert.equal(withRunWorkAdmission(stateDir, producer, () => {
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
    return "prepared";
  }), "prepared");
  const go = join(root, "go");
  const child = withRunWorkAdmission(stateDir, producer, () => spawn(process.execPath, ["-e", `
    const fs=require('node:fs'); const end=Date.now()+5000;
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(timer);process.exit(0)}},10);
  `], { stdio: "ignore" }));
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; });
  assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
  assert.equal(claimRunStop(stateDir, request, proof).status, "stop_requested");
  writeFileSync(go, "go");
  assert.deepEqual(await exit, [0, null]);
  assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Stopped work was prepared")), /stopping or unproven/);
});

test("Work and evidence reject changed producer fields and native fingerprints before callbacks", async (t) => {
  const { stateDir, producer, meta } = await fixture(t);
  for (const [delta, error] of [
    [{ run_instance_id: "replacement" }, /generation changed/],
    [{ ownerId: "replacement" }, /owner changed/],
    [{ pid: process.pid + 1 }, /process changed/],
    [{ outcome_protocol: "unsupported" }, /protocol changed/],
    [{ process_identity: { platform: "linux", command: "different", start_time: "different" } }, /process identity changed/],
  ] as const) {
    writeJsonAtomic(join(stateDir, "run.json"), { ...meta, ...delta });
    assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Stale work callback executed")), error);
    assert.throws(() => withRunProducerEvidence(stateDir, producer, () => assert.fail("Stale evidence callback executed")), error);
  }
});

test("Pending, malformed, and terminal evidence close work admission without rewriting result truth", async (t) => {
  const { stateDir, producer } = await fixture(t);
  writeFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), "{unproven");
  assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Malformed stop allowed work")), /stopping or unproven/);
  await rm(join(stateDir, RUN_STOP_CLAIM_FILE));
  publishRunResult(stateDir, producer, { code: 0 });
  const accepted = readFileSync(join(stateDir, "result.json"), "utf8");
  assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Terminal generation allowed work")), /terminal or unproven/);
  assert.throws(() => admitRunResultProducer(stateDir), /terminal or unproven/);
  assert.equal(readFileSync(join(stateDir, "result.json"), "utf8"), accepted);
});

test("Scoped evidence persists while stopping without reopening work or claiming termination", async (t) => {
  const { stateDir, producer } = await fixture(t);
  const path = join(stateDir, "execution.json");
  withRunProducerEvidence(stateDir, producer, (context) => {
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.status, "running");
    assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), true);
  });
  assert.equal(claimRunStop(stateDir, request, proof).status, "stop_requested");
  withRunProducerEvidence(stateDir, producer, ({ status }) => writeJsonAtomic(path, { status, receipt: "settled" }));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { status: "stopping", receipt: "settled" });
  assert.equal(existsSync(join(stateDir, "result.json")), false);
  assert.equal(existsSync(join(stateDir, "handled.json")), false);
  assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Evidence reopened work")), /stopping or unproven/);
  publishRunResult(stateDir, producer, { code: 7 });
  const result = await readFile(join(stateDir, "result.json"), "utf8");
  await rm(join(stateDir, RUN_STOP_CLAIM_FILE));
  withRunProducerEvidence(stateDir, producer, ({ status }) => assert.equal(status, "stopping"));
  assert.equal(await readFile(join(stateDir, "result.json"), "utf8"), result);
  assert.equal(existsSync(mutationLockPath(join(stateDir, ".lifecycle"))), false);
});

test("Evidence preserves accepted natural status and rejects invalid result authority", async (t) => {
  for (const code of [0, 7]) {
    const { stateDir, producer } = await fixture(t);
    publishRunResult(stateDir, producer, { code });
    const result = await readFile(join(stateDir, "result.json"), "utf8");
    withRunProducerEvidence(stateDir, producer, ({ status }) => {
      assert.equal(status, code === 0 ? "done" : "failed");
      writeJsonAtomic(join(stateDir, "execution.json"), { status });
    });
    assert.equal(await readFile(join(stateDir, "result.json"), "utf8"), result);
    writeFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), "{unproven");
    withRunProducerEvidence(stateDir, producer, ({ status }) => assert.equal(status, code === 0 ? "done" : "failed"));
    assert.equal(await readFile(join(stateDir, "result.json"), "utf8"), result);
    assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Natural result reopened work")), /stopping or unproven|terminal or unproven/);
    writeFileSync(join(stateDir, "result.json"), "{unproven");
    assert.throws(() => withRunProducerEvidence(stateDir, producer, () => assert.fail("Invalid result authorized evidence")), /evidence state is unavailable or invalid/);
  }
});

test("Malformed stop evidence permits only stopping-phase factual updates", async (t) => {
  const { stateDir, producer } = await fixture(t);
  writeFileSync(join(stateDir, RUN_STOP_CLAIM_FILE), "{unproven");
  withRunProducerEvidence(stateDir, producer, ({ status }) => assert.equal(status, "stopping"));
  assert.throws(() => withRunWorkAdmission(stateDir, producer, () => assert.fail("Malformed stop reopened work")), /stopping or unproven/);
  assert.equal(existsSync(join(stateDir, "result.json")), false);
});

test("Native retry admission is checked again and rejection is not converted into another retry", async (t) => {
  const { root, stateDir, producer } = await fixture(t);
  const marker = join(root, "attempts");
  const captureDir = join(root, "captures");
  let admissions = 0;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", `
    require('node:fs').appendFileSync(${JSON.stringify(marker)},'attempt\\n');
    console.log('retained first attempt'); process.exit(7);
  `], {
    retry: 4, captureDir,
    admitSpawn: (start) => {
      if (++admissions === 2) assert.equal(claimRunStop(stateDir, request, proof).status, "stop_requested");
      return withRunWorkAdmission(stateDir, producer, start);
    },
  }), /stopping or unproven/);
  assert.equal(admissions, 2);
  assert.equal(await readFile(marker, "utf8"), "attempt\n");
  assert.match(await readFile(join(captureDir, "attempt-001", "stdout.log"), "utf8"), /retained first attempt/);
  assert.equal(existsSync(join(captureDir, "attempt-002")), false);
});

test("Settled-attempt observers receive immutable native facts and preserve their original failure", async (t) => {
  const { root } = await fixture(t);
  const marker = join(root, "observer-attempts");
  const original = Object.freeze(new Error("observer rejected"));
  let observations = 0;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", `
    require('node:fs').appendFileSync(${JSON.stringify(marker)},'attempt');
    console.log('settled output');process.exit(7);
  `], {
    retry: 3, captureDir: join(root, "observer-captures"),
    onAttemptComplete: (receipt) => {
      observations++;
      assert.equal(Object.isFrozen(receipt), true);
      assert.equal(Object.isFrozen(receipt.result), true);
      assert.equal(receipt.attempt, 1);
      assert.equal(receipt.result.code, 7);
      assert.equal(receipt.nativeExitCode, 7);
      throw original;
    },
  }), (error) => error === original);
  assert.equal(observations, 1);
  assert.equal(await readFile(marker, "utf8"), "attempt");
});

test("A failed native spawn reports no invented native exit code", async (t) => {
  const { root } = await fixture(t);
  let observations = 0;
  const result = await execCommandTemplate(join(root, "missing-executable"), [], {
    onAttemptComplete: (receipt) => {
      observations++;
      assert.equal(Object.hasOwn(receipt, "nativeExitCode"), false);
      assert.equal(receipt.result.code, 1);
    },
  });
  assert.equal(result.code, 1);
  assert.equal(observations, 1);
});

test("An async runner retains completed work but admits no next command after a stop claim", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-work-runner-"));
  const stateDir = join(root, "state");
  const ready = join(root, "ready");
  const go = join(root, "go");
  const forbidden = join(root, "forbidden");
  const first = join(root, "first.cjs");
  const second = join(root, "second.cjs");
  await writeFile(first, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');
    const end=Date.now()+10000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(timer);console.log('retained first command');}},10);`);
  await writeFile(second, `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'unexpected work');`);
  const meta = startRun({ ownerId: "work-owner", run_id: "fenced", state_dir: stateDir, template: [
    `${process.execPath} ${first}`, `${process.execPath} ${second}`,
  ] }, root);
  t.after(async () => {
    writeFileSync(go, "go");
    await waitExit(meta.pid);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(ready);
  assert.equal(claimRunStop(stateDir, {
    ownerId: meta.ownerId, runInstanceId: meta.run_instance_id, reason: "manual_kill",
  }).status, "stop_requested");
  writeFileSync(go, "go");
  await waitExit(meta.pid);
  assert.equal(existsSync(forbidden), false);
  const current = getRunStatus(stateDir);
  assert.equal(current.status, "running");
  assert.equal(current.phase, "stopping");
  assert.equal(current.stopped, false);
  assert.equal((current.result as Record<string, unknown>).terminal_acceptance, "after_stop_claim");
  const execution = JSON.parse(await readFile(join(stateDir, "execution.json"), "utf8"));
  assert.equal(execution.status, "stopping");
  assert.equal(execution.commands.length, 1);
  assert.equal(execution.commands[0].attempts[0].stdout.bytes > 0, true);
  const trace = await readFile(join(stateDir, "trace.jsonl"), "utf8");
  assert.equal(trace.includes('"kind":"run.done"'), false);
});

test("Settled native receipts survive runner death before command or Run publication", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-work-durable-"));
  const stateDir = claimRunStateDirectory(join(root, "state"), "durable");
  const announced = join(root, "announced");
  const ready = join(root, "ready");
  const retryReady = join(root, "retry-ready");
  const nativePidFile = join(root, "native-pid");
  const go = join(root, "go");
  const counter = join(root, "count");
  const script = join(root, "attempt.cjs");
  await writeFile(script, `const fs=require('node:fs');
    if(!fs.existsSync(${JSON.stringify(counter)})){fs.writeFileSync(${JSON.stringify(counter)},'1');console.log('durable first capture');process.exit(7)}
    fs.writeFileSync(${JSON.stringify(nativePidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(retryReady)},'ready');
    const end=Date.now()+15000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(timer);process.exit(0)}},10);`);
  const runnerUrl = new URL("../scripts/async-runner.mjs", import.meta.url).href;
  const child = await worker(t, root, `${prelude}
writeFileSync(${JSON.stringify(announced)},'announced');waitFor(${JSON.stringify(ready)});
process.argv[2]=${JSON.stringify(stateDir)};await import(${JSON.stringify(runnerUrl)});
`);
  try {
    await waitFor(announced);
    writeJsonAtomic(join(stateDir, "run.json"), {
      run: "durable", state_dir: stateDir, ownerId: "durable-owner", run_instance_id: "durable-generation",
      pid: child.child.pid, process_identity: readProcessIdentity(child.child.pid!), outcome_protocol: RUN_OUTCOME_PROTOCOL,
      cwd: process.cwd(), template: { template: `${process.execPath} ${script}`, retry: 3 },
    });
    writeFileSync(ready, "ready");
    await waitFor(retryReady);
    const execution = JSON.parse(await readFile(join(stateDir, "execution.json"), "utf8"));
    assert.equal(execution.commands[0].attempts.length, 1);
    assert.equal(execution.run_instance_id, "durable-generation");
    assert.equal(execution.commands[0].status, "running");
    assert.equal(execution.commands[0].attempts[0].native_exit_code, 7);
    assert.equal(existsSync(join(stateDir, "result.json")), false);
    const before = await readFile(join(stateDir, "execution.json"), "utf8");
    assert.equal(child.child.kill("SIGKILL"), true);
    assert.deepEqual(await child.exit, [null, "SIGKILL"], child.stderr());
    assert.equal(await readFile(join(stateDir, "execution.json"), "utf8"), before);
    assert.match(await readFile(join(stateDir, execution.commands[0].attempts[0].stdout.path), "utf8"), /durable first capture/);
    assert.equal(existsSync(join(stateDir, "result.json")), false);
  } finally {
    writeFileSync(go, "go");
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
    await child.exit;
    if (existsSync(nativePidFile)) await waitExit(Number(await readFile(nativePidFile, "utf8")));
    await rm(root, { recursive: true, force: true });
  }
});

test("An interrupted async retry finalizes real attempt evidence without inventing an unspawned exit", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-work-retry-evidence-"));
  const stateDir = join(root, "state");
  const ready = join(root, "ready");
  const go = join(root, "go");
  const attempted = join(root, "attempted");
  const script = join(root, "retry.cjs");
  await writeFile(script, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(attempted)},'attempt\\n');
    fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+10000;
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})||Date.now()>end){clearInterval(timer);console.log('retained retry output');process.exit(7)}},10);`);
  const meta = startRun({ ownerId: "retry-owner", run_id: "retry-fenced", state_dir: stateDir,
    template: { template: `${process.execPath} ${script}`, retry: 3 },
  }, root);
  t.after(async () => { writeFileSync(go, "go"); await waitExit(meta.pid); await rm(root, { recursive: true, force: true }); });
  await waitFor(ready);
  assert.equal(claimRunStop(stateDir, { ownerId: meta.ownerId, runInstanceId: meta.run_instance_id, reason: "manual_kill" }).status, "stop_requested");
  writeFileSync(go, "go");
  await waitExit(meta.pid);
  const execution = JSON.parse(await readFile(join(stateDir, "execution.json"), "utf8"));
  const command = execution.commands[0];
  assert.equal(command.status, "interrupted");
  assert.equal(command.semantic_acceptance, "unavailable");
  assert.equal(command.attempts.length, 1);
  assert.equal(command.attempts[0].attempt, 1);
  assert.equal(command.attempts[0].code, 7);
  assert.equal(command.attempts[0].native_exit_code, 7);
  assert.equal(Object.hasOwn(command, "exit_code"), false);
  assert.equal(Object.hasOwn(command, "effective_exit_code"), false);
  assert.equal(existsSync(join(stateDir, "captures", command.id, "attempt-002")), false);
  assert.equal(await readFile(attempted, "utf8"), "attempt\n");
  assert.match(await readFile(join(stateDir, command.attempts[0].stdout.path), "utf8"), /retained retry output/);
  const trace = (await readFile(join(stateDir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(execution.active_subagents, 0);
  assert.equal(trace.some((event) => event.kind === "command.done" && event.data?.command_id === command.id), false);
  const current = getRunStatus(stateDir);
  assert.equal(current.status, "running");
  assert.equal(current.phase, "stopping");
  assert.match(String((current.result as Record<string, unknown>).error), /work admission is stopping or unproven/);
});

test("An async native signal persists actual signal facts and is not accepted as successful work", { timeout: 20_000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-work-native-signal-"));
  const stateDir = join(root, "state");
  const script = join(root, "signal.cjs");
  await writeFile(script, "console.log('native signal output');process.kill(process.pid,'SIGTERM')");
  const meta = startRun({ ownerId: "signal-owner", run_id: "signal", state_dir: stateDir, template: `${process.execPath} ${script}` }, root);
  t.after(async () => { await waitExit(meta.pid); await rm(root, { recursive: true, force: true }); });
  await waitExit(meta.pid);
  const status = getRunStatus(stateDir);
  assert.equal(status.status, "failed");
  assert.equal((status.result as Record<string, unknown>).killed, false);
  const execution = JSON.parse(await readFile(join(stateDir, "execution.json"), "utf8"));
  const command = execution.commands[0];
  assert.equal(command.attempts.length, 1);
  assert.equal(command.attempts[0].native_exit_code, null);
  assert.equal(command.attempts[0].native_signal, "SIGTERM");
  assert.notEqual(command.attempts[0].code, 0);
  assert.equal(existsSync(join(stateDir, RUN_NATIVE_LAUNCH_FILE)), false);
});

test("An async capture-write failure persists incomplete physical-byte evidence without native-exit invention", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-work-capture-failure-"));
  const stateDir = claimRunStateDirectory(join(root, "state"), "capture-failure");
  const announced = join(root, "announced");
  const ready = join(root, "ready");
  const script = join(root, "attempt.cjs");
  await writeFile(script, "console.log('observed but not persisted');process.exit(7)");
  const runnerUrl = new URL("../scripts/async-runner.mjs", import.meta.url).href;
  const capture = join(stateDir, "captures", "command-001", "attempt-001", "stdout.log");
  const child = await worker(t, root, `${prelude}
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.appendFileSync;
fs.appendFileSync=(path,...args)=>{if(String(path)===${JSON.stringify(capture)})throw Object.assign(new Error('injected capture failure'),{code:'EIO'});return original(path,...args)};
syncBuiltinESMExports();writeFileSync(${JSON.stringify(announced)},'announced');waitFor(${JSON.stringify(ready)});
process.argv[2]=${JSON.stringify(stateDir)};await import(${JSON.stringify(runnerUrl)});
`);
  try {
    await waitFor(announced);
    writeJsonAtomic(join(stateDir, "run.json"), {
      run: "capture-failure", state_dir: stateDir, ownerId: "capture-owner", run_instance_id: "capture-generation",
      pid: child.child.pid, process_identity: readProcessIdentity(child.child.pid!), outcome_protocol: RUN_OUTCOME_PROTOCOL,
      cwd: process.cwd(), template: { template: `${process.execPath} ${script}`, retry: 3 },
    });
    writeFileSync(ready, "ready");
    assert.deepEqual(await child.exit, [1, null], child.stderr());
    await waitExit(child.child.pid!);
    const execution = JSON.parse(await readFile(join(stateDir, "execution.json"), "utf8"));
    const command = execution.commands[0];
    assert.equal(command.status, "interrupted");
    assert.equal(command.semantic_acceptance, "unavailable");
    assert.equal(command.attempts.length, 1);
    assert.equal(command.attempts[0].native_exit_code, 7);
    assert.equal(command.attempts[0].stdout.complete, false);
    assert.equal(command.attempts[0].stdout.error, "capture_write_failed");
    assert.equal(command.attempts[0].stdout.bytes, 0);
    assert.equal(command.attempts[0].stdout.bytes_observed, Buffer.byteLength("observed but not persisted\n"));
    assert.equal(await readFile(capture, "utf8"), "");
    assert.equal(Object.hasOwn(command, "exit_code"), false);
    assert.equal(existsSync(join(stateDir, "captures", "command-001", "attempt-002")), false);
    assert.equal(execution.active_subagents, 0);
    assert.equal(execution.status, "failed");
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
    await child.exit;
    await rm(root, { recursive: true, force: true });
  }
});

test("A waiting work producer sees the accepted stop before running its callback", async (t) => {
  const { root, stateDir, meta } = await fixture(t);
  const ready = join(root, "ready");
  const announced = join(root, "announced");
  const bound = join(root, "bound");
  const go = join(root, "go");
  const blocked = join(root, "blocked");
  const forbidden = join(root, "forbidden");
  const output = join(root, "out.json");
  const child = await worker(t, root, `${prelude}
import {admitRunResultProducer,withRunWorkAdmission} from ${JSON.stringify(producerUrl)};
writeFileSync(${JSON.stringify(announced)},'announced'); waitFor(${JSON.stringify(ready)});
const {producer}=admitRunResultProducer(${JSON.stringify(stateDir)});
writeFileSync(${JSON.stringify(bound)},'bound'); waitFor(${JSON.stringify(go)});
try {withRunWorkAdmission(${JSON.stringify(stateDir)},producer,()=>writeFileSync(${JSON.stringify(forbidden)},'forbidden'),{
 onLockContention:()=>writeFileSync(${JSON.stringify(blocked)},'blocked')
});throw Error('unexpected admission')} catch(error){writeFileSync(${JSON.stringify(output)},JSON.stringify({error:error.message}))}
`);
  await waitFor(announced);
  writeJsonAtomic(join(stateDir, "run.json"), { ...meta, pid: child.child.pid, process_identity: readProcessIdentity(child.child.pid!) });
  writeFileSync(ready, "ready");
  await waitFor(bound);
  const result = claimRunStop(stateDir, request, { verifyIdentity: () => {
    writeFileSync(go, "go"); waitSync(blocked); return valid;
  } });
  assert.equal(result.status, "stop_requested");
  assert.deepEqual(await child.exit, [0, null], child.stderr());
  assert.match(JSON.parse(await readFile(output, "utf8")).error, /stopping or unproven/);
  assert.equal(existsSync(forbidden), false);
});

test("A stop contender cannot enter the lifecycle while an admitted native spawn is committing", async (t) => {
  const { root, stateDir, producer } = await fixture(t);
  const go = join(root, "go");
  const blocked = join(root, "blocked");
  const output = join(root, "out.json");
  const contender = await worker(t, root, `${prelude}
import {claimRunStop} from ${JSON.stringify(controlUrl)};
waitFor(${JSON.stringify(go)});
const result=claimRunStop(${JSON.stringify(stateDir)},${JSON.stringify(request)},{verifyIdentity:()=>(${JSON.stringify(valid)}),
 onLockContention:()=>writeFileSync(${JSON.stringify(blocked)},'blocked')});
writeFileSync(${JSON.stringify(output)},JSON.stringify(result));
`);
  const child = withRunWorkAdmission(stateDir, producer, () => {
    const spawned = spawn(process.execPath, ["-e", "setTimeout(()=>{},100)"], { stdio: "ignore" });
    writeFileSync(go, "go"); waitSync(blocked);
    assert.equal(existsSync(join(stateDir, RUN_STOP_CLAIM_FILE)), false);
    return spawned;
  });
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; });
  assert.deepEqual(await contender.exit, [0, null], contender.stderr());
  assert.deepEqual(await exit, [0, null]);
  assert.equal(JSON.parse(await readFile(output, "utf8")).status, "stop_requested");
});

for (const operation of ["withRunWorkAdmission", "withRunProducerEvidence"] as const) {
test(`A blocked ${operation} producer revalidates generation after lifecycle-lock contention`, async (t) => {
  const { root, stateDir, meta } = await fixture(t);
  const announced = join(root, "announced");
  const ready = join(root, "ready");
  const bound = join(root, "bound");
  const go = join(root, "go");
  const blocked = join(root, "blocked");
  const forbidden = join(root, "forbidden");
  const output = join(root, "out.json");
  const child = await worker(t, root, `${prelude}
import {admitRunResultProducer,${operation}} from ${JSON.stringify(producerUrl)};
writeFileSync(${JSON.stringify(announced)},'announced');waitFor(${JSON.stringify(ready)});
const {producer}=admitRunResultProducer(${JSON.stringify(stateDir)});writeFileSync(${JSON.stringify(bound)},'bound');waitFor(${JSON.stringify(go)});
try{${operation}(${JSON.stringify(stateDir)},producer,()=>writeFileSync(${JSON.stringify(forbidden)},'forbidden'),{
 onLockContention:()=>writeFileSync(${JSON.stringify(blocked)},'blocked')});throw Error('unexpected admission')}
catch(error){writeFileSync(${JSON.stringify(output)},JSON.stringify({error:error.message}))}
`);
  await waitFor(announced);
  const boundMeta = { ...meta, pid: child.child.pid, process_identity: readProcessIdentity(child.child.pid!) };
  writeJsonAtomic(join(stateDir, "run.json"), boundMeta);
  writeFileSync(ready, "ready");
  await waitFor(bound);
  const release = acquireStateStartLock(stateDir);
  try {
    writeFileSync(go, "go"); await waitFor(blocked);
    writeJsonAtomic(join(stateDir, "run.json"), { ...boundMeta, run_instance_id: "generation-b" });
  } finally { release(); }
  assert.deepEqual(await child.exit, [0, null], child.stderr());
  assert.match(JSON.parse(await readFile(output, "utf8")).error, /generation changed/);
  assert.equal(existsSync(forbidden), false);
});

}

});
