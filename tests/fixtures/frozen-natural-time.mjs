/**
 * Zones: source/packed private kernel timing acceptance with finite native work.
 * Owns one same-runtime producer/command fixture; not the ordinary caller/worker bridge, public routes or scope closure.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, fixtureDir, layout, run, generation, codeArgument] = process.argv.slice(2);
const stateDir = join(fixtureDir, "state"); const manifestPath = join(fixtureDir, "fixture-processes.json");
const identity = { run, run_instance_id: generation, ownerId: "private-frozen-fixture" };
const captured = [{ ...identity, pid: process.pid, role: "producer", state_dir: stateDir, exit_observation: "not_asserted" }];
let launching = false, complete = false;
const persist = () => {
  const stage = manifestPath + ".tmp";
  fs.writeFileSync(stage, JSON.stringify({ schema: "frozen-natural-fixture-v1", launching, complete, captured })); fs.renameSync(stage, manifestPath);
};
persist(); // Retain this producer's exact frame before imports, assertions or awaited work.
assert.ok(layout === "source" || layout === "packed"); const code = Number(codeArgument); assert.ok(code === 0 || code === 7);
const modulePath = name => pathToFileURL(join(packageDir, layout === "source" ? "lib" : "dist/lib", `${name}.${layout === "source" ? "ts" : "js"}`)).href;
const { captureRunSupervisionTimeOrigin, createRunSupervisionClock } = await import(modulePath("run-supervision"));
const { createRunSupervisionOwner } = await import(modulePath("runs-supervision"));
const { captureRunAdmissionSnapshotReferences } = await import(modulePath("runs-context-exports"));
const { claimRunStateDirectory } = await import(modulePath("runs-ownership"));
const { acquireStateStartLock } = await import(modulePath("runs-start"));
const { writeJsonAtomic } = await import(modulePath("file-state"));
const { readProcessIdentity } = await import(modulePath("runs-process"));
const { admitRunResultProducer, withRunWorkAdmission, publishRunResult } = await import(modulePath("runs-results"));
const { execCommandTemplate } = await import(modulePath("command-templates"));
const { readRunSnapshotFacts } = await import(modulePath("runs-status"));
const { renderRunSnapshot } = await import(modulePath("tools-response"));
const workDir = process.cwd(); const resultPath = join(stateDir, "result.json");
let wallReads = 0, monoReads = 0, timers = 0, notices = 0, starts = 0, receipts = 0, events = 0;
const epoch = {}; const samples = [];
const owner = createRunSupervisionOwner({ schedule: () => { timers++; assert.fail("Frozen timing armed a controller"); },
  onDeadlineDue: () => { notices++; assert.fail("Frozen timing emitted a deadline notice"); } });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function absent(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Captured fixture PID unavailable; retaining state");
  try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
}
async function settleWorkload() {
  const workload = captured.find(row => row.role === "workload"); if (!workload) throw Error("Captured fixture workload PID unavailable; retaining state");
  const until = performance.now() + 8000;
  while (!absent(workload.pid)) {
    if (performance.now() >= until) throw Error("Captured fixture workload exit remains unproven; retaining state");
    await pause(20);
  }
  workload.exit_observation = "fresh_esrch"; persist();
}
let primaryError, report;
try {
  claimRunStateDirectory(stateDir, run);
  const release = acquireStateStartLock(stateDir);
  try {
    // Privileged isolated launch composition, not saved-data authentication or ordinary startRun.
    const origin = captureRunSupervisionTimeOrigin({ wallNow: () => { wallReads++; return Date.now(); },
      monotonicNow: () => { monoReads++; const milliseconds = performance.now(); samples.push(milliseconds); return { milliseconds, epoch }; } });
    const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, origin.wall_ms);
    const metadata = { ...identity, ...clock, state_dir: stateDir, createdAt: clock.started_at, pid: 0,
      cwd: workDir, outcome_protocol: "run-outcome-v1", values: { secret: "PRIVATE_SECRET_TOKEN" } };
    const references = captureRunAdmissionSnapshotReferences(stateDir, metadata, origin);
    owner.onSupervisionClockCaptured({ kind: "run_clock_origin_captured", visibility: "kernel_only", publication: "unpublished", work_started: false,
      state_dir: stateDir, identity, clock, origin, snapshot_references: references });
    writeJsonAtomic(join(stateDir, "run.json"), { ...metadata, pid: process.pid, process_identity: readProcessIdentity(process.pid) });
  } finally { release(); }
  const producer = admitRunResultProducer(stateDir).producer;
  const script = join(fixtureDir, "workload.cjs");
  fs.writeFileSync(script, `setTimeout(() => { process.stdout.write(JSON.stringify({pid:process.pid,code:${code},body:'PRIVATE_BODY_NOT_AUTHORIZED'})); process.exitCode=${code}; }, 80);`);
  launching = true; persist();
  const workStartedAt = performance.now();
  const result = await execCommandTemplate(process.execPath, [script], {
    cwd: workDir, captureDir: join(stateDir, "captures", "finite-command"),
    admitSpawn: start => { starts++; return withRunWorkAdmission(stateDir, producer, start); },
    onAttemptManaged: context => {
      // Capture immediately inside managed spawn, before assertions or any await.
      captured.push({ ...identity, pid: context.process.pid, role: "workload", state_dir: stateDir, exit_observation: "not_asserted" });
      launching = false; persist(); assert.ok(Number.isSafeInteger(context.process.pid) && context.process.pid > 0);
    },
    onAttemptComplete: receipt => { receipts++; assert.equal(receipt.nativeExitCode, code); assert.equal(receipt.result.code, code); },
  });
  const workEndedAt = performance.now();
  const body = JSON.parse(result.stdout); assert.equal(body.pid, captured[1].pid); assert.equal(body.code, code); assert.equal(result.code, code);
  assert.equal(starts, 1); assert.equal(receipts, 1); await settleWorkload();
  const before = monoReads; let admission;
  assert.equal(publishRunResult(stateDir, producer, { code: result.code }, { naturalResultTiming: token => {
    events++; admission = token;
    assert.throws(() => owner.captureNaturalTime(identity, producer, { ...token }), /active runtime-local admission/);
    assert.equal(monoReads, before);
    const frozen = owner.captureNaturalTime(identity, producer, token); assert.equal(frozen.state, "available");
    assert.equal(owner.captureNaturalTime(identity, producer, token).state, "available"); assert.equal(monoReads, before + 1);
  }, trace: { kind: code === 0 ? "run.done" : "run.failed", data: { code } } }), true);
  assert.equal(events, 1); assert.equal(monoReads, 2); assert.equal(wallReads, 1);
  assert.throws(() => owner.captureNaturalTime(identity, producer, admission), /active runtime-local admission/);
  assert.equal(publishRunResult(stateDir, producer, { code: 99 }, { naturalResultTiming: () => assert.fail("Duplicate repaired frozen time") }), false);
  const bytes = fs.readFileSync(resultPath); const canonical = JSON.parse(bytes);
  assert.equal(canonical.terminal_acceptance, "natural"); assert.equal(canonical.code, code);
  assert.equal(Object.hasOwn(canonical, "elapsed_ms"), false); assert.equal(Object.hasOwn(canonical, "origin"), false);
  const defaults = readRunSnapshotFacts(stateDir, identity, new Date().toISOString()); assert.equal(defaults.state, "available");
  assert.deepEqual(defaults.facts.timing, { basis: "unproven" });
  const first = owner.observeSnapshot(identity, new Date().toISOString()); assert.equal(first.state, "available");
  assert.equal(first.snapshot.status, code === 0 ? "done" : "failed"); assert.equal(first.snapshot.cwd, workDir); assert.equal(first.snapshot.evidence, null);
  assert.ok(Number.isSafeInteger(first.snapshot.elapsed_ms) && first.snapshot.elapsed_ms >= 0); const elapsed = first.snapshot.elapsed_ms;
  assert.equal(elapsed, Math.floor(samples[1] - samples[0])); assert.ok(samples[0] <= workStartedAt && workEndedAt <= samples[1]);
  const metadata = JSON.parse(fs.readFileSync(join(stateDir, "run.json"), "utf8"));
  writeJsonAtomic(join(stateDir, "run.json"), { ...metadata, elapsed_ms: 99999999, cwd: join(fixtureDir, "not-admitted"), values: { secret: workDir } });
  await pause(25); const later = owner.observeSnapshot(identity, new Date().toISOString()); assert.equal(later.state, "available");
  assert.equal(later.snapshot.elapsed_ms, elapsed); assert.equal(later.snapshot.cwd, workDir); assert.equal(later.unchanged(), true);
  const text = renderRunSnapshot(later.snapshot, "text"); const json = renderRunSnapshot(later.snapshot, "json");
  assert.equal(text.state, "available"); assert.equal(json.state, "available");
  assert.deepEqual(JSON.parse(json.text), later.snapshot); assert.ok(text.text.includes(`${elapsed}ms`)); assert.ok(text.text.includes(generation));
  assert.doesNotMatch(text.text + json.text, /PRIVATE_BODY_NOT_AUTHORIZED|PRIVATE_SECRET_TOKEN|not-admitted|99999999/);
  assert.deepEqual(fs.readFileSync(resultPath), bytes); assert.equal(monoReads, 2); assert.equal(wallReads, 1); assert.equal(timers, 0); assert.equal(notices, 0);
  owner.close(); assert.equal(owner.observeFrozenNaturalTime(identity).state, "unavailable");
  report = { layout, composition: "private_same_runtime_producer", naturalCode: code, status: later.snapshot.status, elapsedMs: elapsed,
    workloadPid: captured[1].pid, producerPid: process.pid, events, commandStarts: starts, commandReceipts: receipts, monoReads, wallReads,
    textAndJson: true, stableAfterDelay: true, originSamplesBracketWork: true, defaultTimingUnproven: true, sourceBodyNotPublished: true, timers, notices };
} catch (error) { primaryError = error; }
finally {
  const cleanupErrors = [];
  try { if (captured.length > 1) await settleWorkload(); else throw Error("Captured fixture workload PID unavailable; retaining state"); } catch (error) { cleanupErrors.push(error); }
  owner.close(); complete = !launching && captured.length === 2 && cleanupErrors.length === 0 && captured[1].exit_observation === "fresh_esrch";
  try { persist(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], "Captured fixture runner exit remains unproven; retaining state");
}
if (primaryError) throw primaryError;
console.log(JSON.stringify(report));
