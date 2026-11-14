/**
 * Installed package script regression tests.
 * Covers Node native type-stripping restrictions for scripts running under node_modules.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, constants as osConstants } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { parseDocument } from "yaml";

import { deliverRunControl } from "../lib/runs-control-delivery.ts";
import { splitCommandTemplate } from "../lib/command-templates.ts";
import { bindFixtureBirth, captureFixtureBirths, joinFixtureRunners, requireFreshFixtureAbsence, throwFixtureErrors } from "./fixtures/runner-completion.ts";

const execFileAsync = promisify(execFile);

// Read-only actual-code extraction; never import the executable SDK fixture.
async function originalRunnerSandbox(overrides: any = {}) {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const helpers = source.slice(source.indexOf("function originalRunnerFaultLedger()"), source.indexOf("async function settle(run)"));
  const api = runInNewContext(helpers + "\n({ observeOriginalRunner, armOriginalRunner })", { osConstants });
  let callback: any, clockReads = 0;
  const subscriptions = new Set<any>();
  const channel: any = { subscribe(fn: any) { callback = fn; subscriptions.add(fn); }, unsubscribe(fn: any) { return subscriptions.delete(fn); } };
  const options = { channel, executable: "/node", runner: "/package/scripts/async-runner.mjs", directory: "/root/overflow", alias: "overflow",
    now: () => { clockReads++; return 20; }, ...overrides };
  const observer = api.observeOriginalRunner(options);
  const frame: any = { run: "overflow", run_instance_id: "generation", pid: 123, state_dir: "/root/overflow", mode: "overflow", request: 1, index: 0, settled: false };
  const child: any = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const publish = (message: any = { process: child }) => callback(message);
  const spawn = (argv = ["/node", "/package/scripts/async-runner.mjs", "/root/overflow"], pid = 123) => {
    Object.assign(child, { spawnfile: "/node", spawnargs: argv, pid }); child.emit("spawn");
  };
  return { source, helpers, api, observer, frame, child, publish, spawn, subscriptions, channel, clockReads: () => clockReads };
}

test("Original runner V3 group 1: single constructor candidate and exact full public vectors", async () => {
  for (const vector of [["/node", "/package/scripts/async-runner.mjs", "/root/overflow"],
    ["/node", "--experimental-strip-types", "/package/scripts/async-runner.mjs", "/root/overflow"],
    ["/package/scripts/async-runner.mjs", "/root/overflow"], ["/node", "/wrong", "/root/overflow"],
    ["/node", "/package/scripts/async-runner.mjs", "/wrong"], ["/node", "/package/scripts/async-runner.mjs", "/root/overflow", "extra"]]) {
    const h = await originalRunnerSandbox();
    assert.equal(h.child.pid, undefined); h.publish(); assert.equal(h.child.listenerCount("error"), 0);
    h.observer.bind(h.frame); h.spawn(vector);
    h.observer.endAdmission(); const result = h.observer.failure(h.frame);
    assert.equal(result.binding, vector[0] === "/node" && vector.length <= 4 && vector.at(-1) === "/root/overflow" && vector.includes("/package/scripts/async-runner.mjs") ? "matched" : "unavailable");
    assert.deepEqual(h.child.eventNames(), []); assert.equal(h.subscriptions.size, 0);
  }
  for (const message of [{}, { get process() { throw false; } }]) {
    const h = await originalRunnerSandbox(); h.publish(message); h.publish(); h.spawn(); h.observer.bind(h.frame);
    assert.equal(h.observer.failure(h.frame).observation, "unavailable", "Acquisition refusal cannot become a later healthy binding");
    assert.equal(h.child.listenerCount("spawn"), 0);
  }
  for (const pid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const h = await originalRunnerSandbox(); h.publish(); h.spawn(undefined, pid); h.observer.bind(h.frame);
    assert.equal(h.observer.failure(h.frame).binding, "unavailable");
  }
  for (const field of ["pid", "spawnfile", "spawnargs"]) {
    const h = await originalRunnerSandbox();
    Object.defineProperty(h.child, field, { get() { throw false; } });
    h.publish(); assert.equal(h.child.listenerCount("spawn"), 1, "No constructor identity access");
    h.child.emit("spawn"); h.observer.bind(h.frame); assert.equal(h.observer.failure(h.frame).observation, "unavailable");
    assert.deepEqual(h.child.eventNames(), []);
  }
  const wrongFile = await originalRunnerSandbox(); wrongFile.publish();
  Object.assign(wrongFile.child, { spawnfile: "/other", spawnargs: ["/node", "/package/scripts/async-runner.mjs", "/root/overflow"], pid: 123 });
  wrongFile.child.emit("spawn"); wrongFile.observer.bind(wrongFile.frame); assert.equal(wrongFile.observer.failure(wrongFile.frame).binding, "unavailable");
  const h = await originalRunnerSandbox(); h.publish(); h.spawn(["/node", "/wrong", "/root/overflow"]);
  h.publish({ process: new EventEmitter() }); h.spawn(); h.observer.bind(h.frame);
  assert.equal(h.observer.failure(h.frame).binding, "unavailable");
});

test("Original runner V3 group 2: reply and close permutations retain exact immutable frame", async () => {
  for (const order of ["close-before-reply", "reply-before-spawn", "spawn-before-reply"]) {
    const h = await originalRunnerSandbox(); h.publish();
    if (order === "reply-before-spawn") { h.observer.endAdmission(); h.observer.bind(h.frame); h.spawn(); }
    else { h.spawn(); if (order === "close-before-reply") h.child.emit("close"); h.observer.endAdmission(); h.observer.bind(h.frame); }
    const before = h.clockReads();
    assert.equal(h.observer.failure({ ...h.frame }), undefined); assert.equal(h.clockReads(), before);
    h.frame.settled = true;
    assert.equal(h.observer.failure(h.frame).observation, order === "close-before-reply" ? "close_observed" : "close_not_observed");
  }
  const first = await originalRunnerSandbox(); first.publish(); first.spawn(); first.observer.bind({ ...first.frame, run: "wrong" });
  first.observer.bind(first.frame); assert.equal(first.observer.failure(first.frame), undefined); first.observer.dispose();
  for (const closed of [false, true]) {
    const mismatch = await originalRunnerSandbox(); mismatch.publish(); mismatch.spawn(undefined, 124); mismatch.observer.bind(mismatch.frame);
    if (closed) mismatch.child.emit("close");
    const result = mismatch.observer.failure(mismatch.frame);
    assert.equal(result.binding, "unavailable"); assert.equal(result.observation, "unavailable", "Correct receipt selection is separate from native binding");
    assert.equal(Object.hasOwn(result, "close_observed_ms"), false, "An unbound candidate's close time is not an original-runner fact");
    assert.equal(result.boundary, "settlement_catch_entry"); assert.equal(result.clock_valid, true); assert.equal(result.sampled_ms, 20);
  }
  const h = await originalRunnerSandbox(); h.publish(); h.spawn(); h.observer.bind(h.frame);
  h.frame.run_instance_id = "changed"; assert.equal(h.observer.failure(h.frame), undefined);
  h.frame.run_instance_id = "generation"; assert.equal(h.observer.failure(h.frame), undefined);
  assert.equal(h.clockReads(), 0); h.observer.dispose(); assert.equal(h.child.listenerCount("close"), 0);
});

test("Original runner V3 group 3: target settlement alone consumes retained observation", async () => {
  const h = await originalRunnerSandbox(); h.publish(); h.spawn(); h.observer.bind(h.frame);
  const body = h.source.slice(h.source.indexOf("async function settle(run)"), h.source.indexOf("function failureFileStamp"));
  let fail = false, evidence: any, laterClose = false;
  const { settle } = runInNewContext(body + "\n({ settle })", {
    originalObserverSlot: h.observer, settleCapturedRunner: async () => { if (fail) throw 0; }, persistCapture: () => {},
    readSettlementFailureWitness: () => undefined, observeFailureOutcome: async () => { if (laterClose) h.child.emit("close"); return {}; },
    failureContext: (_stage: any, _run: any, _result: any, value: any) => { evidence = value; return "safe"; }, console: { error() {} },
  });
  await settle({ mode: "tools", settled: true }); await settle({ mode: "final", settled: true });
  fail = true; await assert.rejects(settle({ ...h.frame }), value => value === 0);
  assert.equal(h.clockReads(), 0); assert.equal(evidence.original_runner, undefined);
  laterClose = true; await assert.rejects(settle(h.frame), value => value === 0);
  assert.equal(evidence.original_runner.observation, "close_not_observed"); assert.ok(Object.isFrozen(evidence.original_runner));
  const success = await originalRunnerSandbox({ now: () => assert.fail("No success clock") });
  success.publish(); success.spawn(); success.observer.bind(success.frame);
  const successful = runInNewContext(body + "\nsettle", { originalObserverSlot: success.observer,
    settleCapturedRunner: async () => {}, persistCapture: () => {},
    readSettlementFailureWitness: () => assert.fail("No successful witness"),
    observeFailureOutcome: () => assert.fail("No successful outcome diagnostics"), console: { error: () => assert.fail("No successful output") } });
  await successful(success.frame);
  assert.equal(success.child.listenerCount("close"), 0); assert.equal(success.observer.failure(success.frame), undefined);
});

test("Original runner V3 group 4: partial effects revoke callbacks and retain finite exact private faults", async () => {
  const raw = [undefined, null, false, 0, "", new AggregateError([0, false], "private")];
  const h = await originalRunnerSandbox();
  const instrumented = h.helpers.replace("  return {\n    record(stage, value)", "  globalThis.ledgerEntries = entries;\n  return {\n    record(stage, value)");
  const context: any = {};
  const ledger = runInNewContext(instrumented + "\noriginalRunnerFaultLedger()", context);
  const stages = ["subscribe", "unsubscribe", "candidate", "spawn_attach", "spawn_remove", "spawn_snapshot"];
  raw.forEach((value, index) => ledger.record(stages[index], value));
  stages.forEach(stage => ledger.record(stage, "must not replace"));
  const entries = context.ledgerEntries.filter((entry: any) => entry.present).sort((a: any, b: any) => a.ordinal - b.ordinal);
  assert.equal(entries.length, raw.length); entries.forEach((entry: any, index: number) => { assert.equal(entry.value, raw[index]); assert.equal(entry.ordinal, index + 1); });
  for (const after of [false, true]) for (const value of raw) {
    let saved: any, unsubscribe = 0;
    const partial: any = { subscribe(fn: any) { saved = fn; throw value; }, unsubscribe() { unsubscribe++; if (after) throw value; return false; } };
    const test = await originalRunnerSandbox({ channel: partial });
    saved({ get process(): never { return assert.fail("Revoked partial subscription must be inert"); } });
    test.observer.dispose(); assert.equal(unsubscribe, 1);
  }
  for (const event of ["spawn", "close"]) for (const after of [false, true]) {
    const test = await originalRunnerSandbox(); const originalOn = test.child.on;
    test.child.on = function (name: any, fn: any) { if (name === event) { if (after) originalOn.call(this, name, fn); throw false; } return originalOn.call(this, name, fn); };
    test.publish(); test.spawn(); test.observer.bind(test.frame); test.child.emit("close");
    assert.equal(test.clockReads(), 0); assert.equal(test.observer.failure(test.frame).observation, "unavailable");
    assert.deepEqual(test.child.eventNames(), []);
  }
  for (const after of [false, true]) {
    const test = await originalRunnerSandbox(); const order: string[] = [], unrelated = () => {};
    test.child.on("close", unrelated); test.publish();
    const remove = test.child.removeListener;
    test.child.removeListener = function (event: any, callback: any) {
      order.push(event); this.emit("close"); if (after) remove.call(this, event, callback); throw event === "spawn" ? undefined : false;
    };
    test.channel.unsubscribe = () => { order.push("unsubscribe"); throw 0; };
    test.spawn(); test.observer.bind(test.frame);
    const result = test.observer.failure(test.frame);
    assert.deepEqual(order, ["spawn", "close", "unsubscribe"]);
    assert.equal(result.observation, "close_observed");
    assert.equal(result.admission_teardown, "unconfirmed"); assert.equal(result.listener_teardown, "unconfirmed");
    assert.deepEqual(Array.from(result.faults), ["close_remove", "spawn_remove", "unsubscribe"]);
    assert.ok(test.child.listeners("close").includes(unrelated), "Never remove unrelated callbacks");
    const before = test.clockReads(); test.child.emit("close"); test.child.emit("spawn"); test.observer.dispose();
    assert.equal(test.clockReads(), before); assert.equal(order.length, 3, "Each teardown stage is one shot even after partial effect");
  }
});

test("Original runner V3 group 5: catch freeze precedes revocation teardown and postprojection", async () => {
  for (const positive of [false, true]) for (const after of [false, true]) {
    let clock = 10;
    const h = await originalRunnerSandbox({ now: () => clock }); h.publish(); h.spawn(); h.observer.bind(h.frame); h.observer.endAdmission();
    if (positive) h.child.emit("close");
    const remove = h.child.removeListener; let removals = 0;
    h.child.removeListener = function (event: any, callback: any) {
      removals++; this.emit("close"); if (after) remove.call(this, event, callback); throw false;
    };
    clock = 20; const result = h.observer.failure(h.frame);
    assert.equal(result.observation, positive ? "close_observed" : "close_not_observed");
    assert.equal(result.listener_teardown, positive ? "confirmed" : "unconfirmed");
    if (!positive) { assert.ok(result.faults.includes("close_remove")); assert.equal(removals, 1); }
    const frozen = JSON.stringify(result); clock = 30; h.child.emit("close"); h.observer.dispose(); assert.equal(JSON.stringify(result), frozen);
  }
  const uncovered = await originalRunnerSandbox(); const on = uncovered.child.on;
  uncovered.child.on = function (event: any, callback: any) {
    const attached = on.call(this, event, callback);
    if (event === "close") { this.emit("close"); throw false; }
    return attached;
  };
  uncovered.publish(); uncovered.spawn(); uncovered.observer.bind(uncovered.frame);
  const unavailable = uncovered.observer.failure(uncovered.frame);
  assert.equal(unavailable.binding, "matched"); assert.equal(unavailable.observation, "unavailable");
  assert.equal(unavailable.reason, "listener_coverage_unavailable"); assert.ok(unavailable.faults.includes("close_attach"));
  assert.equal(Object.hasOwn(unavailable, "close_observed_ms"), false, "Partial attachment cannot admit close timing without coverage");
  assert.equal(unavailable.clock_valid, true); assert.equal(unavailable.sampled_ms, 20);
  const broken = await originalRunnerSandbox({ now: () => { throw 0; } }); broken.publish(); broken.spawn(); broken.observer.bind(broken.frame); broken.child.emit("close");
  const clockFault = broken.observer.failure(broken.frame); assert.equal(clockFault.observation, "close_observed"); assert.equal(clockFault.clock_valid, false);
  assert.deepEqual(Array.from(clockFault.faults), ["close_clock", "catch_clock"]);
  for (const value of [NaN, Infinity, -1, 5]) {
    let clock = 10;
    const h = await originalRunnerSandbox({ now: () => clock }); h.publish(); h.spawn(); h.observer.bind(h.frame); h.child.emit("close"); clock = value;
    const result = h.observer.failure(h.frame); assert.equal(result.observation, "close_observed"); assert.equal(result.clock_valid, false);
    assert.equal(result.sampled_ms, undefined); assert.equal(result.close_observed_ms, undefined);
  }
});

test("Original runner V3 group 6: actual public call and durable receipt preserve outcomes", async () => {
  const h = await originalRunnerSandbox();
  const source = h.source.slice(h.source.indexOf("const workReadinessFrames ="), h.source.indexOf("function workFileMissing")) +
    '\nconst ownerId = "owner";\n' + h.source.slice(h.source.indexOf('            assert.equal(launching, false,'), h.source.indexOf('            assert.ok(Number.isSafeInteger(run.pid)'));
  for (const rejection of [undefined, null, false, 0, "", new AggregateError([false], "exact")]) {
    let calls = 0, getter = 0; const args = [{}, {}];
    const definition = { get execute() { getter++; return function (this: any, ...actual: any[]) { assert.equal(this, definition); assert.deepEqual(actual, args); calls++; throw rejection; }; } };
    const context: any = { assert, launching: false, persistCapture: async () => {}, mode: "tools", spawnCalls: 0, requests: [1], args, definition,
      eligibleAttemptConsumed: false, captured: [], modeRuns: [], currentRun: undefined, originalObserverSlot: undefined };
    const execute = runInNewContext(`(async () => { ${source} })`, context);
    await assert.rejects(execute(), value => value === rejection); assert.equal(calls, 1); assert.equal(getter, 1);
  }
  for (const [mode, spawnCalls, request, consumed] of [["primary-overflow", 0, 1, false], ["overflow", 1, 1, false],
    ["overflow", 0, 2, false], ["overflow", 0, 1, true], ["final", 0, 1, false]] as const) {
    const slot = {}, reply = { details: {} };
    const context: any = { assert, launching: false, persistCapture: async () => {}, mode, spawnCalls,
      requests: Array.from({ length: request }), args: [], definition: { execute: () => reply }, eligibleAttemptConsumed: consumed,
      captured: [], modeRuns: [], currentRun: undefined, originalObserverSlot: slot,
      armOriginalRunner: () => assert.fail("Ineligible public call armed observation") };
    await runInNewContext(`(async () => { ${source} })`, context)(); assert.equal(context.originalObserverSlot, slot);
  }
  for (const fault of [undefined, null, false, 0, ""]) {
    const context: any = { assert, launching: false, persistCapture: async () => { throw fault; },
      definition: { execute: () => assert.fail("Persistence failed before public work") },
      armOriginalRunner: () => assert.fail("Persistence failed before admission") };
    await assert.rejects(runInNewContext(`(async () => { ${source} })`, context)(), value => value === fault);
    assert.equal(context.launching, true);
  }
  assert.equal(h.api.armOriginalRunner(() => { throw false; }), undefined, "Arming fault is no-throw");
  for (const persistFails of [false, true]) {
    let persists = 0, calls = 0, bound = 0, ended = 0; const captured: any[] = [], modeRuns: any[] = [];
    const reply = { details: { pid: 123, state_dir: "/root/overflow", run: "overflow", run_instance_id: "generation" } };
    const admission = { endAdmission() { ended++; }, bind(run: any) { bound++; assert.equal(captured[0], run); assert.equal(modeRuns[0], run); assert.equal(persists, 2); } };
    const context: any = { assert, launching: false, persistCapture: async () => { persists++; if (persists === 2 && persistFails) throw false; },
      mode: "overflow", spawnCalls: 0, requests: [1], args: [], definition: { execute: () => { calls++; return reply; } },
      eligibleAttemptConsumed: false, captured, modeRuns, currentRun: undefined, originalObserverSlot: undefined, armOriginalRunner: () => admission };
    const execute = runInNewContext(`(async () => { ${source} return reply; })`, context);
    if (persistFails) await assert.rejects(execute(), value => value === false); else assert.equal(await execute(), reply);
    assert.equal(calls, 1); assert.equal(ended, 1); assert.equal(bound, persistFails ? 0 : 1);
    assert.equal(context.currentRun, captured[0]); assert.equal(context.launching, false); assert.equal(modeRuns[0], captured[0]);
    context.mode = "tools"; context.definition.execute = () => reply;
    await execute(); assert.equal(context.originalObserverSlot, admission, "Later ineligible calls cannot erase driver slot");
  }
});

test("Original runner V3 group 7: closed projection excludes secrets and preserves whole omission bounds", async () => {
  const h = await originalRunnerSandbox();
  for (const key of ["env", "argv", "body", "error", "toJSON"]) Object.defineProperty(h.child, key, { get() { assert.fail(`Private ${key} read`); } });
  h.publish(); h.spawn(); h.observer.bind(h.frame);
  const result = h.observer.failure(h.frame); const encoded = JSON.stringify(result);
  const secret = Object.fromEntries(["message", "stack", "cause", "toJSON", "env", "body"].map(key => [key, { get() { assert.fail("Private error projection read"); } }]));
  const privateFault = Object.defineProperties({}, secret);
  const failed = await originalRunnerSandbox(); failed.publish(); failed.spawn(); failed.observer.bind(failed.frame);
  failed.child.removeListener = () => { throw privateFault; };
  assert.ok(JSON.stringify(failed.observer.failure(failed.frame)).includes("close_remove"));
  assert.doesNotMatch(encoded, /generation|\/root|\/node|deadline|compliance|alive/); assert.ok(Object.isFrozen(result.faults));
  const diagnostic = h.source.slice(h.source.indexOf("const gateExpiryMarker ="), h.source.indexOf("function originalRunnerFaultLedger()"));
  const { failureContext } = runInNewContext(diagnostic + "\n({ failureContext })", { Buffer });
  const large = failureContext("settle", h.frame, undefined, { original_runner: result, text: "x".repeat(2049) });
  assert.equal(JSON.parse(large).failure_evidence.text, "[whole field omitted: size limit]");
  const omitted = failureContext("settle", h.frame, undefined, { fields: Array.from({ length: 10 }, () => "界".repeat(2000)) });
  assert.equal(JSON.parse(omitted).stage, "diagnostic_omission"); assert.ok(Buffer.byteLength(omitted) <= 8192);
});

test("Original runner V3 group 8: actual settlement keeps falsy primary and ordered later failures", async () => {
  const h = await originalRunnerSandbox();
  const body = h.source.slice(h.source.indexOf("async function settle(run)"), h.source.indexOf("function failureFileStamp"));
  for (const original of [undefined, null, false, 0, "", new AggregateError([0], "primary")]) for (const laterFault of [false, true]) {
    const order: string[] = [];
    const { settle } = runInNewContext(body + "\n({ settle })", {
      originalObserverSlot: { failure: () => { order.push("freeze"); return {}; } },
      settleCapturedRunner: async () => { throw original; }, persistCapture: () => assert.fail("No persistence replay"),
      readSettlementFailureWitness: () => { order.push("witness"); return undefined; },
      observeFailureOutcome: async () => { order.push("outcome"); if (laterFault) throw 0; return {}; },
      failureContext: () => "safe", console: { error() {} },
    });
    await assert.rejects(settle(h.frame), (value: any) => { if (laterFault) assert.deepEqual(Array.from(value.errors), [original, 0]); else assert.equal(value, original); return true; });
    assert.deepEqual(order, ["freeze", "witness", "outcome"]);
  }
});

test("Original runner V3 group 9: runtime field classification and once-only failure reads", async () => {
  const cases: [any, any, string][] = [
    ...[0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER].map(code => [code, null, "exit_code_set"] as [any, any, string]),
    [null, null, "null_pair"], ...Object.keys(osConstants.signals).map(signal => [null, signal, "signal_code_set"] as [any, any, string]),
    ...[undefined, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, false, "0", {}, Symbol("private")].map(code => [code, null, "unavailable"] as [any, any, string]),
    ...[undefined, "", "SIGFAKE", "sigterm", "toString", 0, false, {}].map(signal => [null, signal, "unavailable"] as [any, any, string]),
    [0, "SIGTERM", "unavailable"],
  ];
  for (const [code, signal, expected] of cases) {
    const h = await originalRunnerSandbox(); let codes = 0, signals = 0;
    Object.defineProperties(h.child, { exitCode: { get() { codes++; return code; } }, signalCode: { get() { signals++; return signal; } } });
    h.publish(); h.spawn(); h.observer.bind(h.frame); assert.equal(codes + signals, 0);
    const result = h.observer.failure(h.frame);
    assert.equal(result.runtime_terminal_fields, expected); assert.equal(codes, 1); assert.equal(signals, 1);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.faults));
    assert.equal(h.observer.failure(h.frame), undefined); h.observer.dispose(); assert.equal(codes, 1); assert.equal(signals, 1);
    assert.doesNotMatch(JSON.stringify(result), /SIGTERM|SIGFAKE|private|exitCode|signalCode/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
    assert.ok(Object.values(result).filter(value => typeof value === "string").every(value => value.length <= 2048));
  }
  const ready = async (overrides: any = {}) => {
    const h = await originalRunnerSandbox(overrides); h.publish(); h.spawn(); h.observer.bind(h.frame); return h;
  };
  for (const field of ["exitCode", "signalCode"]) for (const fault of [undefined, null, false, 0, "", Symbol("private"), new AggregateError([false], "private")]) {
    const h = await ready(); let reads = 0;
    Object.defineProperty(h.child, field, { get() { reads++; throw fault; } });
    const result = h.observer.failure(h.frame); assert.equal(result.runtime_terminal_fields, "unavailable"); assert.equal(reads, 1);
    assert.ok(result.faults.includes("runtime_fields")); assert.doesNotMatch(JSON.stringify(result), /private/);
  }
  for (const value of [Object.defineProperties({}, { valueOf: { get() { assert.fail("No coercion"); } }, toJSON: { get() { assert.fail("No JSON hook"); } } }),
    new Proxy({}, { get() { assert.fail("No raw-object inspection"); } })]) {
    const h = await ready(); h.child.exitCode = value; h.child.signalCode = value;
    assert.equal(h.observer.failure(h.frame).runtime_terminal_fields, "unavailable");
  }
  for (const mode of ["success", "unbound", "closed", "disposed", "uncovered", "missing"]) {
    const h = await originalRunnerSandbox(); let reads = 0;
    if (mode !== "missing") Object.defineProperties(h.child, { exitCode: { get() { reads++; return null; } }, signalCode: { get() { reads++; return null; } } });
    else { delete h.child.exitCode; delete h.child.signalCode; }
    h.publish(); assert.equal(reads, 0);
    if (mode === "uncovered") { const on = h.child.on; h.child.on = function (event: any, fn: any) { on.call(this, event, fn); if (event === "close") throw false; return this; }; }
    h.spawn(undefined, mode === "unbound" ? 124 : 123); h.observer.bind(h.frame); assert.equal(reads, 0);
    if (mode === "success") h.observer.success(h.frame);
    if (mode === "closed") h.child.emit("close");
    if (mode === "disposed") h.observer.dispose();
    const result = h.observer.failure(h.frame); if (result) assert.equal(result.runtime_terminal_fields, "unavailable");
    h.observer.dispose(); assert.equal(reads, 0);
  }
  for (const action of ["close", "dispose", "frame", "clock-close", "clock-dispose", "clock-frame", "repeat"]) {
    let h: any, entered = false;
    const mutate = () => { if (action.endsWith("close")) h.child.emit("close"); else if (action.endsWith("dispose")) h.observer.dispose(); else if (action === "repeat") assert.equal(h.observer.failure(h.frame), undefined); else h.frame.run_instance_id = "changed"; };
    h = await ready({ now: () => { if (action.startsWith("clock-") && !entered) { entered = true; mutate(); } return 20; } });
    let codes = 0, signals = 0;
    Object.defineProperties(h.child, { exitCode: { get() { codes++; if (!action.startsWith("clock-")) mutate(); return 0; } }, signalCode: { get() { signals++; return null; } } });
    const result = h.observer.failure(h.frame);
    assert.equal(result.runtime_terminal_fields, action === "repeat" ? "exit_code_set" : "unavailable");
    assert.equal(result.binding, "matched"); assert.equal(result.observation, "close_not_observed");
    assert.equal(Object.hasOwn(result, "close_observed_ms"), false); assert.ok(codes <= 1); assert.ok(signals <= 1); h.observer.dispose();
  }
  const h = await ready(); let reads = 0; const order: string[] = [], unrelated = () => {};
  h.child.on("close", unrelated);
  Object.defineProperties(h.child, { exitCode: { get() { reads++; order.push("code"); return 0; } }, signalCode: { get() { reads++; order.push("signal"); return null; } } });
  h.channel.unsubscribe = () => { order.push("unsubscribe"); throw undefined; };
  const remove = h.child.removeListener;
  h.child.removeListener = function (event: any, fn: any) { order.push(event); remove.call(this, event, fn); throw false; };
  const result = h.observer.failure(h.frame);
  assert.equal(result.runtime_terminal_fields, "exit_code_set"); assert.deepEqual(order, ["code", "signal", "unsubscribe", "close"]);
  h.observer.dispose(); assert.equal(reads, 2); assert.equal(order.length, 4); assert.ok(h.child.listeners("close").includes(unrelated));
  const instrumented = h.helpers.replace("  return {\n    record(stage, value)", "  globalThis.ledgerEntries = entries;\n  return {\n    record(stage, value)");
  for (const fault of [undefined, null, false, 0, "", Symbol("private"), new AggregateError([false], "private")]) {
    const context: any = { osConstants };
    const ledger = runInNewContext(instrumented + "\noriginalRunnerFaultLedger()", context);
    ledger.record("runtime_fields", fault); ledger.record("runtime_fields", "replacement"); ledger.record("unknown", "private");
    const entry = context.ledgerEntries.find((entry: any) => entry.stage === "runtime_fields"); assert.equal(entry.present, true); assert.equal(entry.value, fault);
    assert.deepEqual(Array.from(ledger.tokens()), ["runtime_fields"]);
  }
  const body = h.source.slice(h.source.indexOf("async function settle(run)"), h.source.indexOf("function failureFileStamp"));
  for (const primary of [undefined, null, false, 0, "", Symbol("primary"), new AggregateError([0], "primary")]) {
    const owner = await ready(); Object.defineProperty(owner.child, "exitCode", { get() { throw false; } }); let evidence: any;
    const settle = runInNewContext(body + "\nsettle", { originalObserverSlot: owner.observer, settleCapturedRunner: async () => { throw primary; }, persistCapture() {},
      readSettlementFailureWitness: () => undefined, observeFailureOutcome: async () => ({}),
      failureContext: (_a: any, _b: any, _c: any, value: any) => { evidence = value; return "safe"; }, console: { error() {} } });
    await assert.rejects(settle(owner.frame), value => value === primary); assert.equal(evidence.original_runner.runtime_terminal_fields, "unavailable");
  }
});

// Excluded native-MI protocol properties: real assertions on every platform, never a fake MI provider.
test("Native MI prototype properties: closed build and native failure partitions", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  for (const [stage, code] of [["compile", "C1083"], ["link", "LNK2019"]]) {
    const record = mi.buildFailure(stage, 1, Buffer.from(`C:\\private\\secret /private/token\u0000\u001b arbitrary ${code} secret`));
    assert.deepEqual(record.codes, [code]);
    assert.equal(record.stage, stage);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < 8192);
    assert.doesNotMatch(JSON.stringify(record), /private|secret|arbitrary/);
  }
  assert.throws(() => mi.buildFailure("untrusted", 1, Buffer.alloc(0)));
  for (const status of ["application", "session", "input", "retrieval", "operation", "representation", "cleanup"]) {
    for (const ending of ["", "\n", "\r\n"]) {
      assert.equal(mi.nativeFailure(Buffer.from(JSON.stringify({ schema: "native-mi-v1", status }) + ending)), status);
    }
    assert.notEqual(mi.failureReport("native", "scalar", status).status, "ok");
  }
  const logRoot = await mkdtemp(join(tmpdir(), "native-mi-build-log-"));
  try {
    const path = join(logRoot, "compile.log");
    const bytes = Buffer.alloc(mi.MAX_BYTES + 32, 32);
    bytes.write("private C1083 secret", 0);
    bytes.write("LNK2019", mi.MAX_BYTES + 1);
    await writeFile(path, bytes);
    const record = await mi.readBuildFailure("compile", 1, path);
    assert.deepEqual(record.codes, ["C1083"]);
    assert.doesNotMatch(JSON.stringify(record), /private|secret|LNK2019/);
    assert.deepEqual((await mi.readBuildFailure("link", 1, join(logRoot, "missing"))).codes, []);
  } finally { await rm(logRoot, { recursive: true, force: true }); }
  for (const text of ['{"schema":"native-mi-v1","status":"foreign"}', '{"schema":"native-mi-v1","status":"operation","identity":"secret"}', '{', '{"schema":"native-mi-v1","status":"operation"} trailing', 'x'.repeat(mi.MAX_BYTES + 1)]) {
    assert.equal(mi.nativeFailure(Buffer.from(text)), "protocol-unavailable");
  }
  assert.equal(mi.nativeFailure(Buffer.from([0xff])), "protocol-unavailable");
  const flags = { date: false, command: true, digest: true, accepted: true, wrong_rejected: true, failure_unavailable: true };
  const mismatch = mi.failureReport("comparison", "shared", mi.comparisonFailure(flags), flags);
  assert.equal(mismatch.category, "date-mismatch");
  assert.deepEqual(mismatch.comparison, flags);
  assert.notDeepEqual(mismatch, mi.failureReport("native", "shared", "operation"));
  assert.notDeepEqual(mismatch, mi.failureReport("native", "shared", "representation"));
  assert.equal(mi.failureReport("cleanup", null, "cleanup-esrch-refused").category, "cleanup-esrch-refused");
  for (const primary of [undefined, null, false, 0, "", new Error("private")]) {
    const later = new Error("cleanup-private");
    try {
      await mi.preservingCleanup(() => { throw primary; }, () => { throw later; });
      assert.fail("Must reject");
    } catch (error) {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, later]);
    }
  }
});

test("Native MI prototype properties: bounded numeric profiles and closed complete responses", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const date = { profile: "mi-timestamp-v1", year: 2024, month: 2, day: 29, hour: 0, minute: 0, second: 0, microseconds: 123456, utc: 0 };
  const row = { date, exe: "C:\\x", cmd: "x" };
  const wire = (rows: unknown[], extra: Record<string, unknown> = {}, profile = "shared") => Buffer.from(JSON.stringify({
    schema: "native-mi-v1", status: "ok", profile, complete: true, rows, ...extra }));
  assert.deepEqual(mi.queryArguments("scalar", [Number.MAX_SAFE_INTEGER]), ["scalar", String(Number.MAX_SAFE_INTEGER)]);
  assert.equal(mi.queryArguments("shared", Array.from({ length: 64 }, (_, n) => Number.MAX_SAFE_INTEGER - n)).length, 65);
  for (const pids of [[], [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [1, 1],
    ["1 OR 1=1"], Array(1), [undefined], Array.from({ length: 65 }, (_, n) => n + 1)]) {
    assert.throws(() => mi.queryArguments("shared", pids));
  }
  assert.throws(() => mi.queryArguments("scalar", [1, 2]));
  assert.throws(() => mi.queryArguments("arbitrary", [1]));
  assert.equal(mi.decodeResponse(wire([row], {}, "scalar"), "scalar", [1]).size, 1);
  assert.equal(mi.decodeResponse(wire([{ ...row, pid: 1 }]), "shared", [1]).size, 1);
  assert.equal(mi.decodeResponse(wire([]), "shared", [1]).get(1), undefined);
  const paired = [{ ...row, pid: 11 }, { ...row, pid: 22, cmd: "long 😀 \\\"quoted\\\"" }];
  for (const rows of [paired, [...paired].reverse()]) {
    const decoded = mi.decodeResponse(wire(rows), "shared", [22, 11]);
    assert.equal(decoded.size, 2);
    assert.equal(decoded.get(11)?.command, "C:\\x\nx");
    assert.equal(decoded.get(22)?.command, "C:\\x\n" + paired[1]!.cmd);
  }
  const missing = mi.decodeResponse(wire([paired[1]]), "shared", [22, 11]);
  assert.equal(missing.get(11), undefined); assert.equal(missing.size, 1);
  assert.throws(() => mi.decodeResponse(wire([paired[0], paired[0]]), "shared", [22, 11]));
  for (const rows of [[{ ...row, pid: 2 }], [{ ...row, pid: 1 }, { ...row, pid: 1 }],
    [{ ...row, pid: 1, extra: true }], [{ ...row }], [{ ...row, pid: "1" }]]) {
    assert.throws(() => mi.decodeResponse(wire(rows), "shared", [1]));
  }
  for (const extra of [{ complete: false }, { status: "operation" }, { schema: "other" }, { extra: true }]) {
    assert.throws(() => mi.decodeResponse(wire([], extra), "shared", [1]));
  }
  assert.throws(() => mi.decodeResponse(Buffer.from('{"schema":"native-mi-v1","status":"retrieval"}'), "shared", [1]));
  assert.throws(() => mi.decodeResponse(Buffer.concat([wire([]), Buffer.from("trailing")]), "shared", [1]));
  assert.throws(() => mi.decodeResponse(Buffer.from([0xff]), "shared", [1]));
  const compact = wire([{ ...row, pid: 1 }]);
  assert.equal(mi.decodeResponse(Buffer.concat([compact, Buffer.alloc(mi.MAX_BYTES - compact.length, 32)]), "shared", [1]).size, 1);
  assert.throws(() => mi.decodeResponse(Buffer.concat([compact, Buffer.alloc(mi.MAX_BYTES - compact.length + 1, 32)]), "shared", [1]));
  const utf8Overflow = wire([{ ...row, cmd: "é".repeat(mi.MAX_BYTES / 2), pid: 1 }]);
  assert.ok(utf8Overflow.toString().length < mi.MAX_BYTES && utf8Overflow.length > mi.MAX_BYTES);
  assert.throws(() => mi.decodeResponse(utf8Overflow, "shared", [1]));
  assert.match(mi.oldReferenceCommand(1), /^\$p = Get-CimInstance Win32_Process -Filter "ProcessId = 1";/);
  assert.ok(!mi.oldReferenceCommand(1).includes("-Property"));
  assert.ok(mi.oldReferenceCommand(1).endsWith("$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress"));
});

test("Native MI prototype properties: UTF8 transport aligns actual producers and independent reference", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const { runProcessIdentityDigest: digest } = await import("../lib/runs-process.ts");
  const source = await readFile(new URL("../lib/runs-process.ts", import.meta.url), "utf8");
  const { stripTypeScriptTypes } = await import("node:module");
  const commands: string[] = [];
  const owner = source.slice(source.indexOf("function readWindowsIdentity("), source.indexOf("export function readProcessIdentity("));
  const api = runInNewContext(stripTypeScriptTypes(owner.replaceAll("export ", "")) + "\n({ readWindowsIdentity, readWindowsProcessIdentities })", {
    Buffer, spawnSync: (_file: string, args: string[]) => { commands.push(args[3]!); return { status: 0, stdout: args[3]!.includes("-InputObject") ? "[]" : "{}" }; },
  });
  api.readWindowsIdentity(1); api.readWindowsProcessIdentities([1]);
  commands.push(mi.oldReferenceCommand(1));
  const encoding = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true);";
  assert.equal(commands[2], '$p = Get-CimInstance Win32_Process -Filter "ProcessId = 1"; if ($null -eq $p) { exit 3 }; ' + encoding + ' $p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress');
  const query = /\$p = Get-CimInstance Win32_Process[^;]*;/;
  const fixture = await readFile(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url), "utf8");
  const parser = fixture.slice(fixture.indexOf("function referenceParts("), fixture.indexOf("async function currentReference("));
  const { referenceParts } = runInNewContext(parser + "\n({ referenceParts })", {
    TextDecoder, MAX_BYTES: mi.MAX_BYTES, fail: () => { throw new Error("invalid"); },
    ownKeys: (row: object, keys: string[]) => Object.keys(row).every(key => keys.includes(key)),
    primitivePart: (value: unknown) => value,
  });
  for (const command of [...commands].reverse()) {
    assert.equal(command.split(encoding).length, 2);
    assert.ok(command.indexOf(encoding) < command.indexOf("ConvertTo-Json"));
    assert.match(command, query);
    for (const text of ['ascii "quoted" \\ segment', ('漢字😀 "quoted" \\ segment ').repeat(256), 'e\u0301É\r\nα']) {
      const row = { ProcessId: 1, CreationDate: "/Date(0)/", ExecutablePath: "C:\\node.exe", CommandLine: text };
      const expected = { platform: "win32" as const, start_time: row.CreationDate, command: `${row.ExecutablePath}\n${text}`.trim() };
      // Portable codec/identity assertions are mandatory; Windows additionally exercises the real stdout encoder without CIM or child workloads.
      const referenceRow = { CreationDate: row.CreationDate, ExecutablePath: row.ExecutablePath, CommandLine: text };
      const decoded = referenceParts(Buffer.from(JSON.stringify(referenceRow), "utf8"));
      assert.equal(decoded.parts.cmd, text); assert.equal(decoded.parts.exe, row.ExecutablePath);
      assert.equal(decoded.identity.start_time, row.CreationDate);
      assert.equal(digest(decoded.identity), digest(expected));
      if (process.platform === "win32") {
        const units = (value: string) => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)).join(",");
        const replacement = `$p = [pscustomobject]@{ProcessId=1;CreationDate='/Date(0)/';ExecutablePath=(-join [char[]](${units(row.ExecutablePath)}));CommandLine=(-join [char[]](${units(text)}))};`;
        const script = command.replace(query, replacement);
        assert.doesNotMatch(script, /[^\x00-\x7f]/);
        const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
        assert.equal(stderr, "");
        const parsed = JSON.parse(stdout); const actual = Array.isArray(parsed) ? parsed[0] : parsed;
        assert.equal(actual.CommandLine, text); assert.equal(actual.ExecutablePath, row.ExecutablePath); assert.equal(actual.CreationDate, row.CreationDate);
        assert.equal(digest({ ...expected, command: `${actual.ExecutablePath}\n${actual.CommandLine}`.trim() }), digest(expected));
      }
    }
  }
  assert.equal(commands.length, 3);
});

test("Native MI prototype properties: independent calendar precision and exact UTF16 normalization", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const date = { profile: "mi-timestamp-v1", year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, microseconds: 0, utc: 0 };
  assert.equal(mi.candidateDate(date), "/Date(0)/");
  assert.equal(mi.candidateDate({ ...date, utc: 60 }), "/Date(-3600000)/");
  assert.equal(mi.candidateDate({ ...date, utc: -60 }), "/Date(3600000)/");
  assert.equal(mi.candidateDate({ ...date, microseconds: 999999 }), "/Date(999)/");
  for (const patch of [{ profile: "unknown" }, { year: 0 }, { year: 2023, month: 2, day: 29 },
    { month: 13 }, { day: 0 }, { hour: 24 }, { minute: 60 }, { second: 60 }, { utc: 841 },
    { microseconds: -1 }, { microseconds: 1000000 }, { microseconds: 0.5 }, { year: null }, { extra: 0 }]) {
    assert.throws(() => mi.candidateDate({ ...date, ...patch }));
  }
  const decode = (exe: unknown, cmd: unknown) => mi.decodeResponse(Buffer.from(JSON.stringify({ schema: "native-mi-v1",
    status: "ok", profile: "scalar", complete: true, rows: [{ date, exe, cmd }] })), "scalar", [1]).get(1)!;
  for (const [exe, cmd] of [[null, null], ["", " x "], [" A\\B ", null], ["  a\r\nb", "c\u0000d"],
    ["\ud800X\udfff", "😀e\u0301É"], ["\u00a0a", "z\ufeff"]]) {
    assert.equal(decode(exe, cmd).command, `${typeof exe === "string" ? exe : ""}\n${typeof cmd === "string" ? cmd : ""}`.trim());
  }
  for (const invalid of [undefined, 0, false, [], {}]) {
    assert.throws(() => decode(invalid, "x"));
    assert.throws(() => decode("x", invalid));
  }
});

test("Native MI prototype properties: digest decisions retain expected frame and failure is not dead", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const { runProcessIdentityDigest: digest, verifyRunProcessIdentity: verify } = await import("../lib/runs-process.ts");
  const expected = Object.freeze({ platform: "win32" as const, start_time: "/Date(0)/", command: "x\ny" });
  const physical = Object.freeze({ dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n });
  const bytes = JSON.stringify({ identity: expected, digest: digest(expected) });
  assert.equal(mi.unchangedFixtureFrame(physical, { ...physical }, bytes, bytes), true);
  for (const field of Object.keys(physical)) {
    assert.equal(mi.unchangedFixtureFrame(physical, { ...physical, [field]: 99n }, bytes, bytes), false);
  }
  assert.equal(mi.unchangedFixtureFrame(physical, physical, bytes, bytes + " "), false);
  const good = mi.compareIdentity(expected, { ...expected }, 1, digest, verify);
  assert.ok(Object.values(good).every(v => v === true));
  for (const candidate of [undefined, { ...expected, start_time: "/Date(1)/" }, { ...expected, command: "other" }]) {
    const result = mi.compareIdentity(expected, candidate, 1, digest, verify);
    assert.equal(result.accepted, false);
    assert.equal(result.failure_unavailable, true);
    const report = mi.failureReport("comparison", "scalar", mi.comparisonFailure(result), result);
    assert.deepEqual(report.comparison, result);
    assert.equal(report.category, candidate?.start_time === expected.start_time ? "command-mismatch" : "date-mismatch");
    assert.doesNotMatch(JSON.stringify(report), /Date\(|other|start_time/);
  }
  assert.equal(verify(1, expected, "win32", () => undefined, () => true).status, "unsupported_proof");
  assert.deepEqual(expected, { platform: "win32", start_time: "/Date(0)/", command: "x\ny" });
});

test("Native MI prototype properties: release orchestration preserves callback encounter order", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const callbacks: Array<(error: unknown) => void> = [];
  const shortFault = new Error("short-controlled-send"), longFault = new Error("long-controlled-send");
  const children = ["short", "long"].map(role => ({
    role,
    receipt: { spawned: true, closed: false, error: true },
    process: { connected: true, send(_message: unknown, callback: (error: unknown) => void) {
      callbacks.push(callback);
      return false;
    } },
    get closePromise(): Promise<void> { throw new Error("Failed delivery cannot authorize a close wait"); },
  }));
  const releasing = mi.releaseChildren(children);
  assert.equal(callbacks.length, 2, "Both releases must start before any settlement wait, even with child errors");
  callbacks[1](longFault);
  callbacks[0](shortFault);
  let rejected = false;
  try { await releasing; } catch (error) {
    rejected = true;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, longFault);
    assert.deepEqual(error.errors, [longFault, shortFault]);
  }
  assert.equal(rejected, true);
  await mi.releaseChildren(children);
  assert.equal(callbacks.length, 2, "Cleanup must neither resend nor reappend reported faults");
  for (const fault of [undefined, null, false, 0, "", new AggregateError([false], "nested")]) {
    const sends: string[] = [];
    const short: any = { receipt: { spawned: true, closed: false, error: true }, process: { connected: true,
      send() { sends.push("short"); throw fault; } }, get closePromise(): never { return assert.fail("Failed send is not close authority"); } };
    const long: any = { receipt: { spawned: true, closed: false, error: false }, process: { connected: true,
      send(_message: unknown, callback: (error: unknown) => void) { sends.push("long"); callback(null); return false; } },
      get closePromise() {
        assert.deepEqual(sends, ["short", "long"]);
        Object.assign(this.receipt, { closed: true, code: 0, signal: null });
        return Promise.resolve();
      } };
    let caught = false;
    try { await mi.releaseChildren([short, long]); } catch (error) { caught = true; assert.equal(error, fault); }
    assert.equal(caught, true); assert.deepEqual(sends, ["short", "long"]);
    await mi.releaseChildren([short, long]);
    assert.equal(sends.length, 2);
  }
  for (const fault of [false, 0, ""]) {
    const child: any = { receipt: { spawned: true, closed: false }, process: { connected: true,
      send(_message: unknown, callback: (error: unknown) => void) { callback(fault); return true; } },
      get closePromise(): never { return assert.fail("Callback fault cannot authorize a close wait"); } };
    let caught = false;
    try { await mi.releaseChildren([child]); } catch (error) { caught = true; assert.equal(error, fault); }
    assert.equal(caught, true);
  }
  const closeSends: number[] = [], closeReads: number[] = [];
  const later = new AggregateError([null, 0], "private-close-chain");
  const closing = [0, 1].map(index => ({ receipt: { spawned: true, closed: false }, process: { connected: true,
    send(_message: unknown, callback: (error: unknown) => void) { closeSends.push(index); callback(undefined); return false; } },
    get closePromise(): Promise<void> {
      assert.deepEqual(closeSends, [0, 1]); closeReads.push(index);
      return Promise.reject(index === 0 ? false : later);
    } }));
  try { await mi.preservingCleanup(() => { throw undefined; }, () => mi.releaseChildren(closing)); assert.fail("Expected ordered failures"); }
  catch (error) {
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, undefined);
    assert.equal(error.errors[0], undefined);
    const cleanup = error.errors[1]; assert.ok(cleanup instanceof AggregateError);
    assert.equal(cleanup.cause, false); assert.deepEqual(cleanup.errors, [false, later]);
    assert.equal(cleanup.errors[1], later);
  }
  assert.deepEqual(closeReads, [0, 1]);
  await mi.releaseChildren(closing); assert.deepEqual(closeReads, [0, 1]);
  const successfulSends: number[] = [], callbacksSeen: number[] = [];
  const successful = [0, 1].map(index => {
    const receipt: any = { spawned: true, closed: false, error: false };
    return { receipt, process: { connected: true, send(_message: unknown, callback: (error: unknown) => void) {
      successfulSends.push(index); callbacksSeen.push(index); callback(null); return false;
    } }, get closePromise() {
      assert.deepEqual(successfulSends, [0, 1]);
      Object.assign(receipt, { closed: true, code: 0, signal: null }); return Promise.resolve();
    } };
  });
  await mi.releaseChildren(successful);
  assert.deepEqual(callbacksSeen, [0, 1]);
  assert.ok(successful.every(child => child.receipt.release_callback && child.receipt.closed));

  const extra = ["long", '漢字😀 "quoted" \\ segment '.repeat(256), "trailing\\"];
  const ack = mi.argvAcknowledgement(extra);
  assert.equal(ack.argv_utf16_units, JSON.stringify(extra).length);
  assert.equal(ack.argv_sha256, createHash("sha256").update(JSON.stringify(extra)).digest("hex"));
  assert.equal(mi.matchesArgvAcknowledgement(ack, extra), true);
  for (const value of [{ ...ack, argv_utf16_units: ack.argv_utf16_units + 1 }, { ...ack, argv_sha256: "bad" },
    { ...ack, extra: true }, { schema: ack.schema }]) assert.equal(mi.matchesArgvAcknowledgement(value, extra), false);
  assert.equal(mi.matchesArgvAcknowledgement(ack, extra.slice(0, 2)), false);
  const flags = Object.fromEntries(["date", "command", "digest", "accepted", "wrong_rejected", "failure_unavailable"].map(key => [key, true]));
  const secret = { pid: 123, command: "PRIVATE_IDENTITY_ARGV_PATH", argv_sha256: "PRIVATE_ARGV_HASH" };
  const compatibility = { live: { scalar: { short: { ...secret, ...flags }, long: flags }, shared: { short: flags, long: flags } },
    post_close: { scalar: { short: { missing: true, unsupported_proof: true, ...secret } },
      shared: { short: { missing: true, unsupported_proof: true }, long: flags } } };
  const lifecycle = { short: { ...secret }, long: { ...secret }, child_actual_closes: 2, native_helper_actual_closes: 5,
    historical_reference_actual_closes: 2, current_reference_sync_native_terminations: 2 };
  for (const role of ["short", "long"] as const) Object.assign(lifecycle[role], Object.fromEntries(
    ["spawned", "ready", "argv_verified", "release_attempted", "release_callback", "closed_natural"].map(key => [key, true])));
  const times = Object.fromEntries(["current_reference_short_ms", "old_reference_short_ms", "current_reference_long_ms",
    "old_reference_long_ms", "scalar_short_ms", "scalar_long_ms", "shared_live_ms", "scalar_short_missing_ms",
    "shared_post_close_ms", "short_spawn_to_close_dispatch_ms", "long_spawn_to_close_dispatch_ms"].map(key => [key, 0]));
  const sources = { reader: "a".repeat(64), harness: "b".repeat(64), native: "c".repeat(64), ...secret };
  const result = mi.twoChildSuccess(compatibility, { ...times, ...secret }, lifecycle, sources, "d".repeat(64));
  assert.equal(result.status, "compatible-tested-two-children-only");
  assert.deepEqual(result.children, { count: 2, long_unicode_argv_verified: true });
  assert.equal(result.lifecycle.native_helper_actual_closes, 5);
  assert.equal(result.compatibility.post_close.scalar.short.unsupported_proof, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|argv_sha256|"pid"|"command"\s*:\s*"/);
  assert.deepEqual(Object.keys(result.sources).sort(), ["harness", "native", "reader"]);
  assert.throws(() => mi.twoChildSuccess(compatibility, times, { ...lifecycle, native_helper_actual_closes: 4 }, sources, "d".repeat(64)));
  assert.throws(() => mi.twoChildSuccess(compatibility, { ...times, scalar_short_ms: NaN }, lifecycle, sources, "d".repeat(64)));
  assert.throws(() => mi.twoChildSuccess({ ...compatibility, live: { ...compatibility.live, scalar: { ...compatibility.live.scalar,
    short: { ...flags, accepted: false } } } }, times, lifecycle, sources, "d".repeat(64)));
});

test("Native MI prototype properties: command diagnostic partitions privacy freeze and failure integration", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const pairs: Array<[unknown, unknown, string]> = [["x", "x", "equal-strings"], ["x", "y", "different-strings"],
    ["", null, "reference-only-string"], [false, "", "native-only-string"], [{}, undefined, "both-nonstrings"]];
  const flags = { date: true, command: false, digest: false, accepted: false, wrong_rejected: true, failure_unavailable: true };
  const report = mi.failureReport("comparison", "scalar", "command-mismatch", flags);
  const keys = ["schema", "stage", "case", "reference", "executable_relation", "command_line_relation"];
  for (const [reference, native, relation] of pairs) assert.equal(mi.commandRelation(reference, native), relation);
  for (const role of ["short", "long"]) for (const a of pairs) for (const b of pairs) {
    const record = { schema: "native-mi-command-diagnostic-v1", stage: "comparison", case: `live-scalar-${role}`,
      reference: "historical-full-instance", executable_relation: mi.commandRelation(a[0], a[1]), command_line_relation: mi.commandRelation(b[0], b[1]) };
    const line = mi.projectCommandDiagnostic(record)!;
    assert.deepEqual(Object.keys(JSON.parse(line)), keys); assert.ok(Buffer.byteLength(line) <= 512); assert.ok(line.endsWith("\n"));
    assert.equal(JSON.parse(line).executable_relation, a[2]); assert.equal(JSON.parse(line).command_line_relation, b[2]);
  }
  for (const [a, b] of [["", " "], ["é", "e\u0301"], ["😀", "😁"], ["\ud800", "\udfff"], ["a\u0000b", "ab"], [" x", "x"], ["\n", "\r"]]) {
    assert.equal(mi.commandRelation(a, b), "different-strings"); assert.equal(mi.commandRelation(a, a), "equal-strings");
  }
  const owner = mi.commandDiagnosticOwner();
  const reference: any = { exe: "PRIVATE_PATH", cmd: "PRIVATE_ARGV_ACK_DIGEST" }, native: any = { exe: "other", cmd: null };
  for (const object of [reference, native]) for (const key of ["toJSON", "pid", "argv", "hash"]) {
    Object.defineProperty(object, key, { get() { assert.fail("Private extra getter read"); } });
  }
  owner.capture("live-scalar-short", report, reference, native);
  const first = owner.project()!; assert.doesNotMatch(first, /PRIVATE|ACK|DIGEST|other|pid|argv/);
  reference.exe = "changed"; native.cmd = "changed";
  owner.capture("live-scalar-long", report, { get exe(): never { return assert.fail("Recomputed"); } }, native);
  assert.equal(owner.project(), first); assert.equal(owner.project(), first);
  const dto = JSON.parse(first);
  for (const patch of [{ schema: "other" }, { stage: "native" }, { case: "shared" }, { reference: "current" },
    { executable_relation: "null" }, { command_line_relation: "x" }, { extra: "PRIVATE" }, { toJSON: () => "PRIVATE" }]) {
    assert.equal(mi.projectCommandDiagnostic({ ...dto, ...patch }), undefined);
  }
  const poisoned = { ...dto };
  Object.defineProperty(poisoned, "toJSON", { get() { assert.fail("toJSON read"); } });
  assert.equal(mi.projectCommandDiagnostic(poisoned), undefined);
  Object.defineProperty(poisoned, "case", { get() { assert.fail("Field getter read"); } });
  assert.equal(mi.projectCommandDiagnostic(poisoned), undefined);
  for (const [caseName, alternate] of [["shared", report], ["live-scalar-short", mi.failureReport("comparison", "shared", "command-mismatch", flags)],
    ["live-scalar-short", mi.failureReport("comparison", "scalar", "date-mismatch", flags)],
    ["live-scalar-short", mi.failureReport("comparison", "scalar", "unproven")]]) {
    const inactive = mi.commandDiagnosticOwner(); inactive.capture(caseName, alternate, reference, native); assert.equal(inactive.project(), undefined);
  }
  for (const [ref, nat] of [[undefined, native], [reference, undefined], [{ exe: "x", cmd: "y" }, { exe: "x", cmd: "y" }],
    [{ exe: " x", cmd: "y " }, { exe: "x", cmd: "y" }], [{ get exe() { throw false; } }, native]]) {
    const unavailable = mi.commandDiagnosticOwner(); unavailable.capture("live-scalar-short", report, ref, nat);
    unavailable.capture("live-scalar-long", report, reference, native); assert.equal(unavailable.project(), undefined);
  }
  for (const primary of [undefined, null, false, 0, "", new AggregateError([false], "private")]) for (const cleanupFails of [false, true]) {
    let original: unknown;
    try {
      await mi.preservingCleanup(() => { throw primary; }, () => { reference.exe = "cleanup"; if (cleanupFails) throw 0; });
    } catch (error) { original = error; }
    if (cleanupFails) { assert.ok(original instanceof AggregateError); assert.equal(original.cause, primary); assert.deepEqual(original.errors, [primary, 0]); }
    else assert.equal(original, primary);
    const outer = mi.experimentFailure(original, report, owner);
    assert.equal(outer.cause, original); assert.deepEqual(outer.errors, [original]);
    const lines: string[] = [], outcome = { exitCode: 0 };
    mi.emitExperimentFailure(outer, (line: string) => lines.push(line), outcome);
    assert.equal(outcome.exitCode, 1); assert.equal(lines.length, 2); assert.equal(lines[0], first);
    assert.deepEqual(JSON.parse(lines[1]), report); assert.deepEqual(JSON.parse(lines[1]).comparison, flags);
    const empty = mi.commandDiagnosticOwner(), omitted: string[] = [];
    mi.emitExperimentFailure(mi.experimentFailure(primary, report, empty), (line: string) => omitted.push(line), outcome);
    assert.deepEqual(omitted, [JSON.stringify(report) + "\n"]);
  }
  const portFaults: unknown[] = [undefined, null, false, 0, "", Symbol("optional-write"), new AggregateError([false, 0], "nested-port")];
  const primary = new AggregateError([false, 0], "original-private-chain");
  for (const portFault of portFaults) {
    const outer = mi.experimentFailure(primary, report, owner), attempts: string[] = [], delivered: string[] = [];
    const outcome = { exitCode: 0 }; let escaped = false;
    try {
      mi.emitExperimentFailure(outer, (line: string) => {
        const schema = JSON.parse(line).schema; attempts.push(schema);
        if (schema === "native-mi-command-diagnostic-v1") throw portFault;
        delivered.push(line); return false;
      }, outcome);
    } catch (error) { escaped = true; assert.equal(error, portFault); }
    assert.equal(escaped, false, "Optional diagnostic write failure must not preempt baseline handling");
    assert.deepEqual(attempts, ["native-mi-command-diagnostic-v1", "native-mi-experiment-v1"]);
    assert.deepEqual(delivered, [JSON.stringify(report) + "\n"]); assert.equal(outcome.exitCode, 1);
    assert.equal(outer.cause, primary); assert.deepEqual(outer.errors, [primary]);
  }
  for (const withDiagnostic of [false, true]) for (const baselineFault of portFaults) {
    const diagnostic = withDiagnostic ? owner : mi.commandDiagnosticOwner();
    const outer = mi.experimentFailure(primary, report, diagnostic), outcome = { exitCode: 0 }, attempts: string[] = [];
    let caught = false;
    try {
      mi.emitExperimentFailure(outer, (line: string) => {
        const schema = JSON.parse(line).schema; attempts.push(schema);
        if (schema === "native-mi-command-diagnostic-v1") throw Symbol("omitted-optional-write");
        throw baselineFault;
      }, outcome);
    } catch (error) { caught = true; assert.equal(error, baselineFault); }
    assert.equal(caught, true); assert.equal(outcome.exitCode, 0, "Baseline-write failure ordering remains unchanged");
    assert.deepEqual(attempts, withDiagnostic ? ["native-mi-command-diagnostic-v1", "native-mi-experiment-v1"] : ["native-mi-experiment-v1"]);
    assert.equal(outer.cause, primary); assert.deepEqual(outer.errors, [primary]);
  }
  const source = await readFile(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url), "utf8");
  // Extract the actual private parser and comparison closure, with no native/process ports.
  const parser = source.slice(source.indexOf("function referenceParts("), source.indexOf("async function currentReference("));
  const nativeParser = source.slice(source.indexOf("function decodeResponseParts("), source.indexOf("export function compareIdentity("));
  const decode = runInNewContext(parser + nativeParser + "\n({ referenceParts, decodeResponseParts })", {
    MAX_BYTES: mi.MAX_BYTES, schema: "native-mi-v1", Buffer, TextDecoder, Map, queryArguments: mi.queryArguments, candidateDate: mi.candidateDate,
    fail: () => { throw false; }, primitivePart: (value: unknown) => typeof value === "string" ? value : undefined,
    ownKeys: (value: object, expected: string[]) => Object.keys(value).sort().join() === [...expected].sort().join(),
  });
  const date = { profile: "mi-timestamp-v1", year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, microseconds: 0, utc: 0 };
  const { runProcessIdentityDigest: digest, verifyRunProcessIdentity: verify } = await import("../lib/runs-process.ts");
  const presentSource = source.slice(source.indexOf("      const present ="), source.indexOf("      const missing ="));
  for (const role of ["short", "long"]) for (const equal of [false, true]) {
    const historical = decode.referenceParts(Buffer.from(JSON.stringify({ CreationDate: "/Date(0)/", ExecutablePath: "PRIVATE_PATH", CommandLine: "PRIVATE_ACK" })));
    const decoded = decode.decodeResponseParts(Buffer.from(JSON.stringify({ schema: "native-mi-v1", status: "ok", profile: "scalar", complete: true,
      rows: [{ date, exe: "PRIVATE_PATH", cmd: equal ? "PRIVATE_ACK" : "different" }] })), "scalar", [1]);
    const diagnostic = mi.commandDiagnosticOwner(), parts = new Map([[role, historical.parts]]);
    const context: any = { compareIdentity: mi.compareIdentity, comparisonFailure: mi.comparisonFailure, failureReport: mi.failureReport,
      flagKeys: Object.keys(flags), digest, verify, diagnostic, prestdoutDiagnostic: mi.firstLongCommandMismatchOwner(),
      prestdoutSnapshot: undefined, historicalParts: parts, nativeParts: decoded.parts.get(1),
      fail: () => { throw 0; }, report: undefined };
    const present = runInNewContext(presentSource + "\npresent", context);
    const sample = { originals: { [role]: { current: historical.identity, historical: historical.identity } }, rows: decoded.identities };
    if (equal) { assert.ok(Object.values(present(sample, { role, receipt: { pid: 1 } }, "scalar")).every(v => v === true)); assert.equal(diagnostic.project(), undefined); }
    else {
      assert.throws(() => present(sample, { role, receipt: { pid: 1 } }, "scalar"), value => value === 0);
      assert.equal(JSON.parse(diagnostic.project()).case, `live-scalar-${role}`);
      assert.equal(JSON.parse(diagnostic.project()).command_line_relation, "different-strings");
      assert.equal(context.report.category, "command-mismatch"); assert.deepEqual(context.report.comparison, flags);
    }
    assert.equal(parts.size, 0); assert.equal(context.nativeParts, undefined);
    assert.deepEqual(Object.keys(historical.identity).sort(), ["command", "platform", "start_time"]);
    assert.deepEqual(Object.keys(decoded.identities.get(1)).sort(), ["command", "platform", "start_time"]);
  }
  for (const optional of [null, false, 0, {}, []]) {
    const decoded = decode.referenceParts(Buffer.from(JSON.stringify({ CreationDate: "/Date(0)/", ExecutablePath: optional, CommandLine: "x" })));
    assert.equal(decoded.parts.exe, undefined); assert.equal(decoded.identity.command, "x");
  }
  const pure = source.slice(source.indexOf("export function commandRelation"), source.indexOf("const flagKeys"));
  assert.doesNotMatch(pure, /spawn\(|process\.kill|queryArguments\(|readFile\(|rm\(/);
  assert.ok(source.indexOf("historicalParts.clear();") < source.indexOf("await Promise.allSettled(children.map(child => child.ready));", source.indexOf("}, async () => {")));
});

test("Native MI prototype properties: prestdout strict private UTF16 capsule partitions", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const nonce = "a".repeat(32);
  const control = "0041D8000000DC00D83DDE00";
  const capsule = (units: string) => Buffer.from(`native-mi-prestdout-witness-v1\n${nonce}\n${control}\n${units}\n`, "ascii");
  for (const value of ["", "\u0000", "\ud800", "\udfff", "😀", "é\u0301", "x".repeat(32767)]) {
    const units = Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")).join("");
    assert.equal(mi.decodePrestdoutCapsule(capsule(units), nonce), value);
  }
  const good = capsule("0041");
  for (const bytes of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]), Buffer.concat([good, Buffer.from("\n")]),
    good.subarray(0, good.length - 1), capsule("004"), capsule("00ff"), capsule("GGGG"), capsule("0041".repeat(32768)),
    Buffer.from(good.toString().replace(control, "0041")), Buffer.from(good.toString().replace(nonce, "b".repeat(32))),
    Buffer.from(good.toString().replace("witness", "reservation")), Buffer.alloc(131201)]) {
    assert.equal(mi.decodePrestdoutCapsule(bytes, nonce), undefined);
  }
  const highBit = Buffer.from(good); highBit[0] |= 128;
  assert.equal(mi.decodePrestdoutCapsule(highBit, nonce), undefined, "ASCII decoding must not launder high bits");
  for (const nonceValue of [undefined, "", "A".repeat(32), "a".repeat(31)]) assert.equal(mi.decodePrestdoutCapsule(good, nonceValue), undefined);
});

test("Native MI prototype properties: retained prestdout descriptor reservation read release partitions", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const nonce = "a".repeat(32), path = "PRIVATE_LEAF";
  const capsule = (units = "0041") => Buffer.from(`native-mi-prestdout-witness-v1\n${nonce}\n0041D8000000DC00D83DDE00\n${units}\n`);
  function ports(options: any = {}) {
    let body: Buffer = Buffer.alloc(0);
    let size = 0n, stats = 0, lookups = 0, closes = 0, reads = 0, opens = 0;
    const positions: number[] = [];
    const metadata: any = { dev: 0n, ino: 1n, mode: 0o100600n, nlink: 1n, birthtimeNs: 1n, mtimeNs: 1n, ctimeNs: 1n,
      isFile: () => true, isSymbolicLink: () => false };
    const fault = (key: string) => { if (options.fault === key) throw options.error; };
    const snapshot = (kind: string, count: number) => {
      fault(kind);
      return { ...metadata, size, ...(options.change?.(kind, count) ?? {}) };
    };
    const handle = {
      async writeFile(seed: Buffer) { fault("write"); body = Buffer.from(seed); size = BigInt(body.length); },
      async stat(arg: any) { assert.deepEqual(arg, { bigint: true }); return snapshot("stat", ++stats); },
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        reads++; positions.push(position); fault("read");
        const n = Math.min(length, options.chunk ?? 17, Math.max(0, body.length - position));
        body.copy(buffer, offset, position, position + n); return { bytesRead: n };
      },
      async close() { closes++; await options.onClose?.(); fault("close"); },
    };
    const io = {
      async open(...args: any[]) { opens++; assert.deepEqual(args, [path, "wx+", 0o600]); fault("open"); return handle; },
      async lstat(actual: string, arg: any) { assert.equal(actual, path); assert.deepEqual(arg, { bigint: true }); return snapshot("lstat", ++lookups); },
    };
    return { io, metadata, positions, counts: () => ({ closes, reads, opens }),
      complete(bytes: Buffer = capsule(), reportedSize = bytes.length) { body = bytes; size = BigInt(reportedSize); metadata.mtimeNs++; metadata.ctimeNs++; } };
  }
  for (const units of ["0041", "", "D8000000DC00"]) {
    let released = false;
    const p = ports({ onClose() { released = true; } });
    const owner = await mi.reservePrestdoutCapsule(path, nonce, p.io);
    assert.equal(owner.ready, true); assert.equal(p.counts().closes, 0);
    p.complete(capsule(units));
    const first = owner.read(); assert.equal(await owner.read(), undefined);
    const result = await first;
    assert.equal(released, true); assert.equal(result, mi.decodePrestdoutCapsule(capsule(units), nonce));
    assert.equal(p.positions[0], 0); assert.equal(p.positions.at(-1), capsule(units).length);
    assert.ok(p.positions.length > 2); assert.deepEqual(await owner.close(), { closed: true });
    assert.deepEqual(p.counts(), { closes: 1, reads: p.positions.length, opens: 1 });
    assert.equal(owner.retentionRequired(), false);
    assert.deepEqual(Object.keys(owner).sort(), ["close", "read", "ready", "retentionRequired"]);
  }
  let release!: () => void, entered!: () => void;
  const closing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = ports({ onClose() { entered(); return gate; } });
  const pendingOwner = await mi.reservePrestdoutCapsule(path, nonce, delayed.io);
  delayed.complete(); let settled = false;
  const pending = pendingOwner.read().then((value: unknown) => { settled = true; return value; });
  await closing; assert.equal(settled, false); assert.equal(await pendingOwner.read(), undefined);
  const sameClose = pendingOwner.close(); assert.strictEqual(pendingOwner.close(), sameClose);
  release(); assert.equal(await pending, "A"); assert.deepEqual(await sameClose, { closed: true });
  assert.equal(delayed.counts().closes, 1);
  const invalidFrames = [ { ino: 0n }, { dev: -1n }, { nlink: 2n }, { birthtimeNs: undefined },
    { mode: 1 }, { size: 0n }, { isFile: () => false }, { isSymbolicLink: () => true } ];
  for (const bad of invalidFrames) {
    const p = ports({ change: () => bad });
    const owner = await mi.reservePrestdoutCapsule(path, nonce, p.io);
    assert.equal(owner.ready, false); assert.equal(await owner.read(), undefined);
    assert.equal(p.counts().closes, 1); assert.equal(owner.retentionRequired(), false);
  }
  for (const change of [
    (kind: string, n: number) => kind === "lstat" && n === 2 ? { ino: 2n } : {},
    (_kind: string, n: number) => n >= 2 ? { birthtimeNs: 2n } : {},
    (_kind: string, n: number) => n >= 2 ? { nlink: 2n } : {},
    (_kind: string, n: number) => n >= 2 ? { ctimeNs: undefined } : {},
    (_kind: string, n: number) => n === 3 ? { mtimeNs: 99n } : {},
  ]) {
    const p = ports({ change }), owner = await mi.reservePrestdoutCapsule(path, nonce, p.io);
    assert.equal(owner.ready, true); p.complete();
    assert.equal(await owner.read(), undefined); assert.equal(p.counts().closes, 1);
  }
  for (const [bytes, size] of [[Buffer.alloc(131201), 131200], [capsule(), 131201],
    [Buffer.concat([capsule(), Buffer.from("extra")]), capsule().length], [capsule().subarray(0, 10), 10],
    [Buffer.from(capsule().toString().replace(nonce, "b".repeat(32))), capsule().length]]) {
    const p = ports({ chunk: 131201 }), owner = await mi.reservePrestdoutCapsule(path, nonce, p.io);
    p.complete(bytes as Buffer, size as number); assert.equal(await owner.read(), undefined); assert.equal(p.counts().closes, 1);
  }
  for (const error of [undefined, null, false, 0, "", Symbol("private")]) {
    for (const fault of ["open", "write", "stat", "lstat", "read", "close"]) {
      const p = ports({ fault, error }), owner = await mi.reservePrestdoutCapsule(path, nonce, p.io);
      p.complete();
      assert.equal(await owner.read(), undefined);
      const result = await owner.close(); assert.strictEqual(await owner.close(), result);
      assert.equal(p.counts().opens, 1); assert.equal(p.counts().closes, fault === "open" ? 0 : 1);
      assert.equal(owner.retentionRequired(), fault === "open" || fault === "close");
      if (fault === "open" || fault === "close") { assert.equal(result.closed, false); assert.strictEqual(result.error, error); }
    }
  }
  const p = ports(), owner = await mi.reservePrestdoutCapsule(path, nonce, p.io);
  await owner.close(); p.complete(); assert.equal(await owner.read(), undefined); assert.equal(p.counts().reads, 0);
  const source = await readFile(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url), "utf8");
  // The temporary no-callsite phase is retired; the owning main-composition VM properties below
  // now falsify LONG-only admission, lifetime and retained-root cleanup at the actual callsite.
  assert.equal(source.match(/reservePrestdoutCapsule\(/g)?.length, 2);
});

test("Native MI prototype properties: actual main LONG gates private lifetime and root retention", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const source = await readFile(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const receipts =", source.indexOf("async function experiment("));
  const state = source.slice(start, source.indexOf("  const createChild =", start));
  const body = source.slice(source.indexOf("  try {\n    return await preservingCleanup", start), source.indexOf("\nconst isMain"));
  const harness = "(async function () {" + state + `
    ports.inspect = () => ({ snapshot: prestdoutSnapshot, parts: historicalParts.size, native: nativeParts });
    const createChild = (role, args) => ports.createChild(role, args, children, receipts);
    const frames = live => ports.frames(live, children);
  ` + body.replaceAll("import.meta.url", '"file:///synthetic/test.mjs"') + ")()";
  const allFlags = { date: true, command: true, digest: true, accepted: true, wrong_rejected: true, failure_unavailable: true };
  const identity = { platform: "win32", start_time: "synthetic-time", command: "synthetic-command" };
  const faults = [undefined, false, 0, Symbol("synthetic-private")];
  const run = async (options: any = {}) => {
    const events: string[] = [], commands: string[] = [], saved: any[] = [];
    let captures = 0, frameCalls = 0, reserved = 0, reads = 0, closes = 0, releases = 0, removed = false, full = false;
    const privateError = options.privateError;
    const owner = { ready: options.ready !== false, retentionRequired: () => options.uncertain === true || options.closeFails === true,
      read: async () => { events.push("read"); reads++; if (options.readThrows) throw privateError; return options.snapshot; },
      close: async () => { events.push("close"); closes++; return options.closeFails ? { closed: false, error: privateError } : { closed: true }; } };
    const ports: any = {
      createChild(role: string, _args: string[], children: any[], receipts: any[]) {
        const receipt = { pid: role === "short" ? 11 : 12, spawned: true, ready: true, argv_verified: true,
          closed: false, error: false, spawn_dispatch_ms: 0, code: 0, signal: null };
        const child = { role, receipt, ready: Promise.resolve() }; children.push(child); receipts.push(receipt); saved.push(child);
      },
      frames: async (_live: any[], children: any[]) => {
        events.push("frames:" + ++frameCalls);
        if (options.frameFails === frameCalls) throw options.primary;
        return Object.fromEntries(children.map(c => [c.role, c.frame ? JSON.parse(c.frame) : { current: identity, historical: identity }]));
      },
    };
    const context: any = { ports, root: "synthetic-root", helper: "synthetic-helper", Buffer, Map, Object, Promise, AggregateError, URL,
      assert: { deepEqual(a: any, b: any) { events.push("equality"); assert.deepEqual(a, b); } },
      commandDiagnosticOwner: mi.commandDiagnosticOwner, firstLongCommandMismatchOwner: mi.firstLongCommandMismatchOwner,
      preservingCleanup: mi.preservingCleanup, experimentFailure: mi.experimentFailure, failureReport: mi.failureReport,
      flagKeys: Object.keys(allFlags), comparisonFailure: mi.comparisonFailure,
      roleLifeKeys: ["spawned", "ready", "argv_verified", "release_attempted", "release_callback", "closed_natural"],
      digest: () => "synthetic-digest", verify: () => ({ status: "unsupported_proof" }),
      join: (...parts: string[]) => parts.join("/"), fileURLToPath: () => "synthetic-source", hash: () => "a".repeat(64),
      randomBytes: (count: number) => { assert.equal(count, 16); events.push("nonce"); if (options.rngFails) throw false; return Buffer.alloc(16, 10); },
      reservePrestdoutCapsule: async () => { events.push("reserve"); reserved++; if (options.openThrows) throw privateError; return owner; },
      oldReferenceCommand: (pid: number) => "old:" + pid,
      prestdoutReferenceCommand: (pid: number) => { events.push("builder"); if (options.builderFails) throw false; return "long:" + pid; },
      currentReference: async (pid: number, receipts: any[]) => { events.push("current:" + pid); receipts.push({ pid: 20 + pid, spawned: true, terminated: true, code: 0, signal: null });
        return { identity, duration_ms: 1, sourceHash: options.hashMismatch && pid === 12 ? "different-reader" : "reader" }; },
      capture: async (program: string, args: string[], receipts: any[]) => {
        const receipt = { pid: 40 + ++captures, spawned: true, closed: true, code: 0, signal: null, duration_ms: 1 };
        receipts.push(receipt);
        if (program === "powershell.exe") { commands.push(args[3]); events.push("historical:" + args[3]);
          if (options.captureThrows && commands.length === 2) throw options.primary;
          return { receipt, ok: !(options.captureFalse && commands.length === 2), bytes: Buffer.from(commands.length === 1 ? "short" : "long") }; }
        return { receipt, ok: true, complete: true, bytes: Buffer.from(args.join(",")) };
      },
      referenceParts: (bytes: Buffer) => { events.push("decode:" + bytes.toString());
        if (options.decodeFails && bytes.toString() === "long") throw options.primary;
        return { identity: options.equalityFails && bytes.toString() === "long" ? { ...identity, command: "different" } : identity,
          parts: { exe: "synthetic-exe", cmd: "synthetic-B" } }; },
      writeFile: async () => { events.push("write-frame"); }, lstat: async () => ({}), readFile: async () => Buffer.from("synthetic"),
      nativeFailure: () => "protocol-unavailable", representationFailures: new WeakSet(),
      queryArguments: (profile: string, selected: number[]) => [profile, ...selected.map(String)],
      decodeResponseParts: (bytes: Buffer) => { const [profile, ...pids] = bytes.toString().split(",");
        const ids = pids.map(Number).filter(pid => !saved.find(c => c.receipt.pid === pid)?.receipt.closed);
        return { identities: new Map(ids.map(pid => [pid, { ...identity, mismatch: options.mismatch && profile === "scalar" && pid === 12 }])),
          parts: new Map(ids.map(pid => [pid, { exe: "synthetic-exe", cmd: "synthetic-N" }])) }; },
      compareIdentity: (_original: any, candidate: any) => candidate.mismatch ?
        { ...allFlags, command: false, digest: false, accepted: false } : allFlags,
      releaseChildren: async (children: any[]) => { events.push("release"); releases++;
        if (options.releaseFails) throw options.releaseError;
        for (const child of children) Object.assign(child.receipt, { closed: true, close_dispatch_ms: 2 }); },
      twoChildSuccess: () => { events.push("full"); full = true; return { synthetic: true }; },
      absent: () => { events.push("esrch"); return options.absent !== false; },
      rm: async () => { events.push("rm"); removed = true; }, fail: () => { throw "synthetic-baseline-failure"; },
    };
    let error: any, failed = false;
    try { await runInNewContext(harness, context); } catch (caught) { failed = true; error = caught; }
    const retained = ports.inspect();
    assert.equal(retained.snapshot, undefined); assert.equal(retained.parts, 0); assert.equal(retained.native, undefined);
    return { events, commands, captures, reserved, reads, closes, releases, removed, full, error, failed };
  };
  const good = await run();
  assert.equal(good.failed, false, String(good.error?.cause?.stack ?? good.error?.stack ?? good.error?.cause) + "\n" + good.events.join(","));
  assert.deepEqual(good.commands, ["old:11", "long:12"]);
  assert.equal(good.reserved, 1); assert.equal(good.reads, 1); assert.equal(good.closes, 1); assert.equal(good.removed, true);
  assert.ok(good.events.indexOf("current:12") < good.events.indexOf("reserve"));
  assert.ok(good.events.indexOf("reserve") < good.events.indexOf("historical:long:12"));
  const readAt = good.events.indexOf("read");
  assert.deepEqual(good.events.slice(readAt - 4, readAt), ["decode:long", "equality", "write-frame", "frames:8"]);
  assert.ok(readAt < good.events.indexOf("close"));
  assert.equal(good.captures, 7); assert.equal(good.releases, 2);
  assert.equal(good.events.filter(event => event === "esrch").length, 11);
  assert.equal(good.events.at(-1), "rm"); assert.ok(good.events.lastIndexOf("esrch") > good.events.indexOf("full"));
  const readFault = await run({ readThrows: true, privateError: false });
  assert.equal(readFault.failed, false); assert.equal(readFault.closes, 1); assert.equal(readFault.removed, true);
  for (const options of [{ ready: false }, { rngFails: true }, { builderFails: true }]) {
    const result = await run(options); assert.equal(result.failed, false); assert.deepEqual(result.commands, ["old:11", "old:12"]);
    assert.equal(result.reserved, "rngFails" in options ? 0 : 1); assert.equal(result.closes, result.reserved);
    assert.equal(result.reads, "builderFails" in options ? 1 : 0);
  }
  for (const options of [{ captureFalse: true }, { captureThrows: true }, { decodeFails: true }, { equalityFails: true }, { hashMismatch: true }, { frameFails: 7 }, { frameFails: 8 }]) {
    const primary = Symbol("synthetic-primary"), result = await run({ ...options, primary });
    assert.equal(result.failed, true); assert.equal(result.reads, 0); assert.equal(result.closes, 1);
    assert.ok(result.releases >= 1); assert.equal(result.removed, false); assert.equal(result.full, false);
    if ("captureThrows" in options || "decodeFails" in options || "frameFails" in options) assert.strictEqual(result.error.cause, primary);
  }
  for (const privateError of faults) for (const mode of ["closeFails", "openThrows"]) {
    const result = await run({ [mode]: true, privateError });
    assert.equal(result.failed, true); assert.strictEqual(result.error.cause, privateError);
    assert.equal(result.removed, false); assert.equal(result.full, false); assert.ok(result.releases >= 1);
    assert.ok(!result.events.includes("esrch")); assert.equal(result.closes, mode === "closeFails" ? 1 : 0);
  }
  const uncertain = await run({ uncertain: true }); assert.equal(uncertain.failed, true); assert.equal(uncertain.removed, false);
  assert.equal(uncertain.full, false); assert.ok(!uncertain.events.includes("esrch"));
  const denied = await run({ absent: false }); assert.equal(denied.failed, true); assert.equal(denied.removed, false);
  for (const primary of faults) {
    const releaseError = Symbol("synthetic-release"), privateError = Symbol("synthetic-close");
    const result = await run({ captureThrows: true, primary, releaseFails: true, releaseError, closeFails: true, privateError });
    const chain = result.error.cause; assert.ok(chain instanceof AggregateError); assert.strictEqual(chain.cause, primary);
    assert.strictEqual(chain.errors[0], primary); assert.deepEqual(chain.errors[1].errors, [releaseError, privateError]);
    assert.strictEqual(chain.errors[1].cause, releaseError); assert.equal(Object.keys(chain).includes("errors"), false);
    assert.equal(result.closes, 1); assert.equal(result.releases, 1); assert.equal(result.removed, false);
    assert.ok(result.events.indexOf("release") < result.events.indexOf("close"));
  }
  const mismatchAndClose = await run({ mismatch: true, snapshot: "synthetic-N", closeFails: true, privateError: false });
  assert.equal(mismatchAndClose.error.cause.cause, "synthetic-baseline-failure");
  assert.deepEqual(mismatchAndClose.error.cause.errors, ["synthetic-baseline-failure", false]);
  assert.equal(mismatchAndClose.closes, 1); assert.equal(mismatchAndClose.removed, false);
  for (const [snapshot, relation] of [["synthetic-N", "native-only-match"], ["synthetic-B", "baseline-only-match"],
    ["synthetic-other", "neither-match"], [undefined, undefined]]) {
    const result = await run({ mismatch: true, snapshot }); assert.equal(result.failed, true);
    const lines: string[] = []; mi.emitExperimentFailure(result.error, (line: string) => lines.push(line), { exitCode: 0 });
    assert.equal(lines.length, relation ? 3 : 2);
    if (relation) assert.equal(JSON.parse(lines[0]).relation, relation);
    assert.equal(JSON.parse(lines.at(-2)!).schema, "native-mi-command-diagnostic-v1");
    assert.equal(JSON.parse(lines.at(-1)!).category, "command-mismatch");
    assert.doesNotMatch(lines.join(""), /synthetic-|prestdout-0a|nonce|pid|argv/);
    assert.equal(result.closes, 1); assert.equal(result.removed, false);
  }
  // Execute the actual present closure with observable lexical raw storage, including failure unwind.
  const presentSource = source.slice(source.indexOf("      const present ="), source.indexOf("      const missing ="));
  for (const role of ["short", "long"]) for (const success of [false, true]) {
    const parts = new Map([[role, { exe: "synthetic-exe", cmd: "synthetic-B" }]]), diagnostic = mi.commandDiagnosticOwner();
    const prestdoutDiagnostic = mi.firstLongCommandMismatchOwner();
    const context: any = { compareIdentity: () => success ? allFlags : { ...allFlags, command: false },
      comparisonFailure: mi.comparisonFailure, failureReport: mi.failureReport, flagKeys: Object.keys(allFlags), digest: () => "", verify: () => {},
      diagnostic, prestdoutDiagnostic, historicalParts: parts, nativeParts: { cmd: "synthetic-N" }, prestdoutSnapshot: "synthetic-N",
      fail: () => { throw false; } };
    const present = runInNewContext(presentSource + "\npresent", context);
    const call = () => present({ originals: { [role]: { current: identity, historical: identity } }, rows: new Map([[1, identity]]) }, { role, receipt: { pid: 1 } }, "scalar");
    if (success) call(); else assert.throws(call, e => e === false);
    assert.equal(parts.size, 0); assert.equal(context.nativeParts, undefined);
    assert.equal(context.prestdoutSnapshot, role === "long" ? undefined : "synthetic-N");
    assert.equal(!!prestdoutDiagnostic.project(), role === "long" && !success);
    if (role === "long" && !success) { parts.set("long", { exe: "mutated", cmd: "mutated" });
      assert.equal(JSON.parse(prestdoutDiagnostic.project()).relation, "native-only-match"); }
  }
});

test("Native MI prototype properties: pure LONG builder erasure and bounded private writer", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const nonce = "a".repeat(32);
  const final = "$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  for (const pid of [1, Number.MAX_SAFE_INTEGER]) for (const path of ["C:\\private\\seed", "C:\\漢字😀\\it's a seed"]) {
    const old = mi.oldReferenceCommand(pid), script = mi.prestdoutReferenceCommand(pid, path, nonce);
    const begin = script.indexOf("& { try {"), end = script.indexOf("} *> $null; ") + "} *> $null; ".length;
    assert.ok(begin > 0 && end > begin);
    assert.equal(script.slice(0, begin) + script.slice(end), old);
    assert.equal(script.slice(end), final); assert.ok(script.endsWith(final));
    assert.equal(script.match(/Get-CimInstance/g)?.length, 1);
    assert.equal(script.match(/\$p\.CommandLine/g)?.length, 1);
    assert.equal(script.match(/exit/g)?.length, 1);
    assert.equal(script.slice(0, begin), old.slice(0, -final.length));
    assert.ok(script.includes("'" + path.replaceAll("'", "''") + "'"));
    assert.match(script, /\$s = \$p\.CommandLine;\s+if \(\$s -isnot \[System.String\] -or \$s.Length -gt 32767\)/);
    assert.match(script, /\[int\]\[char\]\$text\[\$i\]/);
    assert.match(script, /ToString\('X4', \[System.Globalization.CultureInfo\]::InvariantCulture\)/);
    assert.match(script, /0x0041,0xD800,0x0000,0xDC00,0xD83D,0xDE00/);
    assert.match(script, /\$controlHex = & \$transcribe \$control/); assert.match(script, /\$sHex = & \$transcribe \$s/);
    assert.doesNotMatch(script.slice(begin, end), /OutputEncoding|Console|UTF8/);
    assert.equal(script.split("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true);").length, 2);
    assert.doesNotMatch(script, /0041D8000000DC00D83DDE00|LASTEXITCODE|ErrorActionPreference|OpenOrCreate|FileMode\]::Create|FileShare\]::Delete|Unicode.GetBytes/);
    assert.match(script, /FileMode\]::Open, \[System.IO.FileAccess\]::ReadWrite, \[System.IO.FileShare\]::ReadWrite/);
    assert.equal(script.match(/FileStream\]::new/g)?.length, 1);
    assert.match(script, /\$received = New-Object byte\[\] \(\$seed.Length \+ 1\)/);
    assert.match(script, /if \(\$count -eq 0\) \{ \$eof = \$true; break \}/);
    assert.ok(script.indexOf("if (-not $eof -or $length -ne $seed.Length)") < script.indexOf("$stream.SetLength(0)"));
    assert.ok(script.indexOf("$received[$i] -ne $seed[$i]") < script.indexOf("$stream.SetLength(0)"));
    assert.ok(script.indexOf("$stream.Position = 0") < script.indexOf("$stream.Write("));
    assert.ok(script.indexOf("$stream.Flush()") < script.indexOf("$stream.Dispose()"));
    assert.ok(script.indexOf("$stream.Dispose()") < script.indexOf(final));
    assert.match(script, /\$capsule.Length -gt 131200/);
  }
  for (const path of [undefined, null, 0, "", "x\u0000y", "x\ny", "x\ry", "x".repeat(32768)]) {
    assert.throws(() => mi.prestdoutReferenceCommand(1, path, nonce));
  }
  for (const value of [undefined, "", "A".repeat(32), "a".repeat(31), "a'".repeat(16)]) assert.throws(() => mi.prestdoutReferenceCommand(1, "seed", value));
  for (const pid of [0, -1, 1.5, NaN, "1; exit"]) assert.throws(() => mi.prestdoutReferenceCommand(pid, "seed", nonce));
});

test("Native MI prototype properties: closed SBN partitions first LONG attempt primitive freeze", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const report = mi.failureReport("comparison", "scalar", "command-mismatch");
  const record = { schema: "native-mi-prestdout-diagnostic-v1", stage: "comparison", case: "live-scalar-long",
    reference: "historical-full-instance", relation: "native-only-match" };
  for (const [s, b, n, relation] of [["N", "B", "N", "native-only-match"], ["B", "B", "N", "baseline-only-match"],
    ["S", "B", "N", "neither-match"], ["", "", " ", "baseline-only-match"], ["é", "e\u0301", "é", "native-only-match"],
    ["\ud800", "\udfff", "\ud800", "native-only-match"], ["a\u0000b", "ab", "z", "neither-match"]]) {
    const owner = mi.firstLongCommandMismatchOwner(); owner.capture("live-scalar-long", report, s, b, n);
    const line = owner.project()!;
    assert.deepEqual(JSON.parse(line), { ...record, relation }); assert.ok(line.endsWith("\n")); assert.ok(Buffer.byteLength(line) <= 512);
    assert.deepEqual(Object.keys(JSON.parse(line)), ["schema", "stage", "case", "reference", "relation"]);
    owner.capture("live-scalar-long", report, "changed", "changed", "other"); assert.equal(owner.project(), line);
  }
  for (const [caseName, alternate] of [["live-scalar-short", report], ["shared", report],
    ["live-scalar-long", mi.failureReport("native", "scalar", "command-mismatch")],
    ["live-scalar-long", mi.failureReport("comparison", "shared", "command-mismatch")],
    ["live-scalar-long", mi.failureReport("comparison", "scalar", "date-mismatch")]]) {
    const owner = mi.firstLongCommandMismatchOwner(); owner.capture(caseName, alternate, "N", "B", "N"); assert.equal(owner.project(), undefined);
    owner.capture("live-scalar-long", report, "N", "B", "N"); assert.ok(owner.project(), "Ineligible calls do not consume the attempt");
  }
  const poison = { toString() { assert.fail("No coercion"); }, toJSON() { assert.fail("No serialization"); } };
  for (const triple of [["S", "x", "x"], ["x", "x", "x"], [undefined, "B", "N"], ["S", null, "N"], ["S", "B", poison], [poison, "B", "N"]]) {
    const owner = mi.firstLongCommandMismatchOwner(); owner.capture("live-scalar-long", report, ...triple);
    owner.capture("live-scalar-long", report, "N", "B", "N"); assert.equal(owner.project(), undefined);
  }
  for (const patch of [{ extra: "PRIVATE" }, { toJSON() { assert.fail("Hook"); } }, { relation: "PRIVATE" },
    { schema: "other" }, { stage: "native" }, { case: "live-scalar-short" }, { reference: "current" }, { relation: poison }, { relation: "x".repeat(513) }]) {
    assert.equal(mi.projectPrestdoutDiagnostic({ ...record, ...patch }), undefined);
  }
  for (const key of Object.keys(record)) {
    const value = { ...record }; Object.defineProperty(value, key, { get() { assert.fail("Accessor invoked"); } });
    assert.equal(mi.projectPrestdoutDiagnostic(value), undefined);
  }
  const inherited = Object.create({ toJSON() { assert.fail("Inherited hook"); } }); Object.assign(inherited, record);
  assert.deepEqual(JSON.parse(mi.projectPrestdoutDiagnostic(inherited)), record);
  assert.equal(mi.projectPrestdoutDiagnostic({ ...record, [Symbol("private")]: "PRIVATE" }), undefined);
  const source = await readFile(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url), "utf8");
  const ownerSource = source.slice(source.indexOf("export function firstLongCommandMismatchOwner"), source.indexOf("const diagnosticKeys"));
  assert.match(ownerSource, /frozen = Object.freeze\(record\)/);
  assert.doesNotMatch(ownerSource, /frozen\s*=\s*(snapshot|baseline|native)|spawn|readFile|queryArguments/);
  const facts = new WeakMap();
  const api = runInNewContext(ownerSource.replace("export function", "function") + "\nfirstLongCommandMismatchOwner", { projectPrestdoutDiagnostic: mi.projectPrestdoutDiagnostic, prestdoutDiagnostics: facts });
  const owner = api(), error = new Error("private"); owner.capture("live-scalar-long", report, "PRIVATE_N", "PRIVATE_B", "PRIVATE_N");
  owner.associate(error); const frozen = facts.get(error); assert.ok(Object.isFrozen(frozen));
  assert.deepEqual(JSON.parse(JSON.stringify(frozen)), record); assert.doesNotMatch(owner.project(), /PRIVATE/);
});

test("Native MI prototype properties: SBN optional failure writes isolated before adjacent legacy baseline", async () => {
  const mi = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const flags = { date: true, command: false, digest: false, accepted: false, wrong_rejected: true, failure_unavailable: true };
  const report = mi.failureReport("comparison", "scalar", "command-mismatch", flags);
  const old = mi.commandDiagnosticOwner(); old.capture("live-scalar-long", report, { exe: "x", cmd: "B" }, { exe: "x", cmd: "N" });
  const fresh = mi.firstLongCommandMismatchOwner(); fresh.capture("live-scalar-long", report, "N", "B", "N");
  const schemas = ["native-mi-prestdout-diagnostic-v1", "native-mi-command-diagnostic-v1", "native-mi-experiment-v1"];
  const faults = [undefined, null, false, 0, "", Symbol("fault")];
  for (const fault of faults) for (const failNew of [false, true]) for (const failOld of [false, true]) {
    const error = mi.experimentFailure(fault, report, old, fresh), outcome = { exitCode: 0 }, attempts: string[] = [], delivered: string[] = [];
    mi.emitExperimentFailure(error, (line: string) => {
      const schema = JSON.parse(line).schema; attempts.push(schema);
      if ((schema === schemas[0] && failNew) || (schema === schemas[1] && failOld)) throw fault;
      delivered.push(line); return false;
    }, outcome);
    assert.deepEqual(attempts, schemas); assert.equal(outcome.exitCode, 1);
    assert.equal(delivered.at(-1), JSON.stringify(report) + "\n"); assert.deepEqual(JSON.parse(delivered.at(-1)!).comparison, flags);
    assert.equal(error.cause, fault); assert.deepEqual(error.errors, [fault]); assert.deepEqual(Object.keys(error), []);
  }
  for (const fault of faults) for (const withNew of [false, true]) for (const withOld of [false, true]) {
    const error = mi.experimentFailure(fault, report, withOld ? old : mi.commandDiagnosticOwner(), withNew ? fresh : undefined);
    const outcome = { exitCode: 0 }, attempts: string[] = []; let caught = false;
    try { mi.emitExperimentFailure(error, (line: string) => {
      const schema = JSON.parse(line).schema; attempts.push(schema); throw fault;
    }, outcome); } catch (error) { caught = true; assert.equal(error, fault); }
    assert.equal(caught, true); assert.equal(outcome.exitCode, 0);
    assert.deepEqual(attempts, [...(withNew ? [schemas[0]] : []), ...(withOld ? [schemas[1]] : []), schemas[2]]);
  }
  for (const fault of faults) {
    const error = mi.experimentFailure(fault, report, old, { associate() { throw fault; } });
    const lines: string[] = []; mi.emitExperimentFailure(error, (line: string) => lines.push(line), { exitCode: 0 });
    assert.deepEqual(lines, [old.project(), JSON.stringify(report) + "\n"]);
  }
});

type ResearchCapture = { stdout: Buffer; stderr: Buffer; failed: boolean; error: unknown; captureComplete: boolean };
function researchOwnData(value: unknown, key: string): unknown {
  if (value === null || !["object", "function"].includes(typeof value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}
function captureResearchRejection(error: unknown): ResearchCapture {
  try {
    const stdout = researchOwnData(error, "stdout"), stderr = researchOwnData(error, "stderr");
    return { failed: true, error, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.alloc(0),
      captureComplete: Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr) && researchOwnData(error, "code") !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" };
  } catch (later) { throw new AggregateError([error, later], "Research fixture capture failed; retaining state"); }
}
async function retainResearchCapture(value: ResearchCapture, persist: () => Promise<void>, diagnose: () => void): Promise<ResearchCapture> {
  const errors: unknown[] = value.failed ? [value.error] : [];
  try { await persist(); } catch (error) { errors.push(error); }
  if (value.failed) try { diagnose(); } catch (error) { errors.push(error); }
  if (errors.length > (value.failed ? 1 : 0)) throw new AggregateError(errors, "Research fixture evidence failed; retaining state");
  return value;
}
function researchFailureSummary(layout: string, pid: number | undefined,
  close: { code: number | null; signal: NodeJS.Signals | null } | undefined, capture: ResearchCapture): string {
  const signal = (value: unknown) => value === null ? null
    : ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBREAK", "SIGHUP"].includes(value as string) ? value : undefined;
  const code = researchOwnData(capture.error, "code"), killed = researchOwnData(capture.error, "killed");
  const knownCode = Number.isSafeInteger(code) || ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ETIMEDOUT", "ENOENT", "EACCES", "EPERM"].includes(code as string);
  // Captured stderr is untrusted advisory input, never body output or authenticated fault provenance.
  const prefix = capture.stderr.subarray(0, 65536).toString("utf8");
  const classification = /(?:^|\n)(AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|Error)(?: \[ERR_ASSERTION\])?:/u.exec(prefix)?.[1] ?? "unavailable";
  const location = /session-navigation-sdk\.mjs:([1-9][0-9]{0,5})(?::[1-9][0-9]{0,5})?(?:\)|\r?\n|$)/u.exec(prefix);
  const text = JSON.stringify({ schema: "research-fixture-failure-v1", phase: "genuine_research", stage: "child_capture",
    layout: ["source", "packed"].includes(layout) ? layout : "unavailable", pid: Number.isSafeInteger(pid) && Number(pid) > 0 ? pid : undefined,
    actual_close: close ? { code: close.code === null || Number.isSafeInteger(close.code) ? close.code : undefined, signal: signal(close.signal) } : undefined,
    command_error: { code: knownCode ? code : undefined, signal: signal(researchOwnData(capture.error, "signal")), killed: typeof killed === "boolean" ? killed : undefined },
    capture_complete: capture.captureComplete, stderr_advisory: { classification, fixture_line: location ? Number(location[1]) : undefined,
      scan_complete: capture.stderr.length <= 65536 } });
  assert.ok(Buffer.byteLength(text, "utf8") <= 8192, "Research diagnostic exceeds its byte bound");
  return text;
}

test("Research failure diagnostics keep exact falsy causes and emit only bounded advisory metadata", async () => {
  const secret = "SECRET_COMMAND_RESPONSE_BODY";
  const stderr = Buffer.from(`AssertionError [ERR_ASSERTION]: ${secret}\n    at check (file:///private/${secret}/session-navigation-sdk.mjs:426:9)\n`);
  for (const original of [undefined, null, false, 0, "", new Error(secret)]) {
    const capture = captureResearchRejection(original);
    assert.equal(capture.failed, true); assert.equal(capture.error, original);
    for (const faults of [[], [false], [0, undefined]] as unknown[][]) {
      const calls: string[] = [], later = [...faults];
      const pending = retainResearchCapture(capture, async () => { calls.push("persist"); if (faults.length) throw later[0]; }, () => {
        calls.push("diagnostic"); if (faults.length > 1) throw later[1];
      });
      if (faults.length) await assert.rejects(pending, (error: any) => {
        assert.deepEqual(error.errors, [original, ...faults]); return true;
      });
      else assert.equal(await pending, capture);
      assert.deepEqual(calls, ["persist", "diagnostic"]);
    }
  }
  let getters = 0;
  const original = Object.assign(new Error(secret), { code: 1, signal: null, killed: false, stdout: Buffer.from(secret), stderr });
  Object.defineProperty(original, "message", { get() { getters++; throw secret; } });
  const capture = captureResearchRejection(original);
  const text = researchFailureSummary("source", 123, { code: 1, signal: null }, capture);
  const summary = JSON.parse(text);
  assert.equal(summary.schema, "research-fixture-failure-v1"); assert.deepEqual(summary.actual_close, { code: 1, signal: null });
  assert.deepEqual(summary.command_error, { code: 1, signal: null, killed: false });
  assert.deepEqual(summary.stderr_advisory, { classification: "AssertionError", fixture_line: 426, scan_complete: true });
  assert.equal(getters, 0); assert.doesNotMatch(text, /SECRET|private|stdout|base64|message/); assert.ok(Buffer.byteLength(text) <= 8192);
  const oversized = { ...capture, stderr: Buffer.concat([Buffer.alloc(65536, 120), stderr]) };
  const limited = JSON.parse(researchFailureSummary("packed", 123, undefined, oversized));
  assert.deepEqual(limited.stderr_advisory, { classification: "unavailable", scan_complete: false });
  const poisoned = captureResearchRejection({ code: secret, signal: secret, killed: secret, stdout: Buffer.from(secret), stderr: Buffer.from(secret) });
  assert.doesNotMatch(researchFailureSummary(secret, NaN, undefined, poisoned), /SECRET/);
  let reports = 0;
  const success = { failed: false, error: undefined, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), captureComplete: true };
  assert.equal(await retainResearchCapture(success, async () => {}, () => { reports++; }), success); assert.equal(reports, 0);
  await assert.rejects(retainResearchCapture(success, async () => { throw 0; }, () => assert.fail("No failure report on success")),
    (error: any) => error.errors.length === 1 && error.errors[0] === 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.throws(() => captureResearchRejection(revoked.proxy), (error: any) => error.errors[0] === revoked.proxy && error.errors[1] instanceof TypeError);
  assert.equal(captureResearchRejection({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: Buffer.alloc(0), stderr }).captureComplete, false);
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  const start = source.lastIndexOf("    } catch (error) { readerFailures.push(error); }");
  assert.ok(start > 0);
  const closing = source.slice(start, source.indexOf("    assert.ok(Number.isSafeInteger(readerPid)", start));
  for (const original of [undefined, null, false, 0, "", NaN]) for (const observed of [false, true]) {
    const evidence = Promise.reject(original); void evidence.catch(() => {});
    const execute = runInNewContext(`(async () => { try { throw original; ${closing} })()`, {
      original, readerFailures: [], readerEvidence: evidence, readerRejectionObserved: observed, root: "/fixture",
    });
    await assert.rejects(execute, (error: any) => {
      assert.deepEqual(Array.from(error.errors), observed ? [original] : [original, original]); return true;
    });
  }
});

function selectSdkFailureTimingPids(stderr: Buffer): number[] {
  // Stderr supplies an advisory sample-selection hint, never captured identity or liveness proof.
  for (const line of stderr.subarray(0, 65536).toString("utf8").split(/\r?\n/u).slice(0, 256)) {
    if (!line.startsWith('{"schema":"sdk-fixture-failure-v1"')) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row?.stage === "settle" && Number.isSafeInteger(row.pid) && row.pid > 0) return [row.pid];
  }
  return [];
}

test("Settlement failure evidence preserves policy calls and uses only bounded generation observations and existing timing samples", async () => {
  const settlementModule = "./fixtures/sdk-runner-settlement.mjs", timingModule = "./fixtures/windows-native-timing.mjs";
  const { settleCapturedRunner, readSettlementFailureWitness } = await import(settlementModule);
  const { selectTimingSamples } = await import(timingModule);
  const calls: string[] = []; let clock = 0, original: unknown;
  try { await settleCapturedRunner({ pid: 123 }, () => assert.fail("No fabricated absence"), {
    now: () => { calls.push("now"); return clock; }, probe: () => { calls.push("probe"); },
    sleep: async () => { calls.push("sleep"); clock = 8001; },
  }); } catch (error) { original = error; }
  assert.deepEqual(calls, ["now", "now", "probe", "sleep", "now", "probe"]);
  const witness = readSettlementFailureWitness(original);
  assert.equal(witness.started_ms, 0); assert.equal(witness.deadline_ms, 5000);
  assert.equal(witness.last_policy_observation_ms, 8001); assert.equal(witness.largest_policy_gap_ms, 8001);
  assert.equal(witness.probe_count, 2); assert.equal(witness.last_probe, "present"); assert.equal(witness.exit, "unproven");
  assert.equal(witness.original_runner_identity, "not_observed"); assert.ok(Object.isFrozen(witness));
  for (const value of [undefined, null, false, 0, "", { get fixture_settlement() { throw Error("Getter must not run"); } }])
    assert.equal(readSettlementFailureWitness(value), undefined);
  const rows = Array.from({ length: 12 }, (_, index) => ({ pid: index + 1, role: index === 0 ? "sdk_driver" : "runner",
    max_ms: 20 - index, event: { phase: "after" } }));
  const samples = selectTimingSamples(rows, [12]);
  assert.equal(samples.length, 8); assert.equal(samples[0].pid, 1); assert.ok(samples.some((row: any) => row.pid === 12));
  assert.deepEqual(rows.map(row => row.pid), Array.from({ length: 12 }, (_, i) => i + 1));
  const descriptor = JSON.stringify({ schema: "sdk-fixture-failure-v1", stage: "settle", pid: 123, body: "SECRET_BODY" });
  assert.deepEqual(selectSdkFailureTimingPids(Buffer.from(`${descriptor}\r\n`)), [123]);
  assert.deepEqual(selectSdkFailureTimingPids(Buffer.from("x".repeat(65536) + descriptor)), []);
  assert.deepEqual(selectSdkFailureTimingPids(Buffer.from(descriptor.replace('"settle"', '"readOutcome"'))), []);
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const functions = source.slice(source.indexOf("async function settle(run)"), source.indexOf("async function readRetainedText"));
  const fs = await import("node:fs/promises"), { constants } = await import("node:fs");
  const { observeFailureOutcome } = runInNewContext(functions + "\n({ observeFailureOutcome })", { ...fs, constants, Buffer, TextDecoder, join, originalObserverSlot: undefined });
  const root = await mkdtemp(join(tmpdir(), "settlement-outcome-"));
  try {
    const run = { run: "fixture", run_instance_id: "generation", pid: 123, state_dir: root };
    const metadata = { ...run, command: "SECRET_COMMAND" }, result = { run_instance_id: run.run_instance_id, terminal_acceptance: "natural", code: 0, error: "SECRET_BODY" };
    await writeFile(join(root, "run.json"), JSON.stringify(metadata)); await writeFile(join(root, "result.json"), JSON.stringify(result));
    const observed = await observeFailureOutcome(run);
    assert.equal(observed.state, "observed"); assert.equal(observed.code, 0); assert.match(observed.scope, /not ownership, native identity or exit proof/);
    assert.doesNotMatch(JSON.stringify(observed), /SECRET/);
    for (const mutate of [{ pid: 124 }, { run_instance_id: "replacement" }, { state_dir: "/other" }, { run: "other" }]) {
      await writeFile(join(root, "run.json"), JSON.stringify({ ...metadata, ...mutate }));
      assert.equal((await observeFailureOutcome(run)).state, "unavailable");
    }
    await writeFile(join(root, "run.json"), JSON.stringify(metadata));
    for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(65537, 120)]) {
      await writeFile(join(root, "result.json"), bytes); assert.equal((await observeFailureOutcome(run)).state, "unavailable");
    }
    await writeFile(join(root, "result.json"), JSON.stringify(result));
    assert.equal((await observeFailureOutcome(run, async (path: string) => ({ value: path.endsWith("run.json") ? metadata : result }), async () => false)).state, "unavailable");
    await rm(join(root, "result.json")); assert.equal((await observeFailureOutcome(run)).state, "unavailable");
    const target = { ...run, mode: "overflow", index: 0 };
    const execution = { version: 1, run: run.run, run_instance_id: run.run_instance_id, status: "done",
      commands: [{ id: "command-001", status: "done", attempts: [{ command: "SECRET_COMMAND" }], native_exit_code: 0, command: "SECRET_COMMAND" }] };
    const native = { schema: "run-native-launches-v1", run: run.run, run_instance_id: run.run_instance_id, runner_pid: run.pid,
      intents: [{ command_id: "command-001", attempt: 1, birth: { pid: 124, process_identity: { command: "SECRET_COMMAND" } },
        settlement: { native_exit_code: 0, native_signal: null } }] };
    await writeFile(join(root, "execution.json"), JSON.stringify(execution));
    await writeFile(join(root, "native-launches.json"), JSON.stringify(native));
    const pending = await observeFailureOutcome(target);
    assert.equal(pending.reason, "result_source_unavailable");
    assert.equal(pending.stage.execution.state, "observed"); assert.equal(pending.stage.execution.status, "done");
    assert.equal(pending.stage.execution.command_status, "done"); assert.equal(pending.stage.execution.attempts_recorded, 1);
    assert.equal(pending.stage.native_journal.state, "observed"); assert.equal(pending.stage.native_journal.birth_recorded, true);
    assert.equal(pending.stage.native_journal.settlement_recorded, true); assert.equal(pending.stage.native_journal.recorded_exit_code, 0);
    assert.match(pending.stage.scope, /not atomic.*native.*proof/); assert.doesNotMatch(JSON.stringify(pending), /SECRET/);
    const paths: string[] = [];
    await observeFailureOutcome({ ...target, mode: "primary-overflow" }, async (path: string) => {
      paths.push(path); return path.endsWith("run.json") ? { value: metadata } : undefined;
    }, async () => true);
    assert.deepEqual(paths, [join(root, "run.json"), join(root, "result.json")]);
    for (const [name, body] of [["execution.json", { ...execution, run_instance_id: "replacement" }],
      ["native-launches.json", { ...native, runner_pid: 124 }], ["native-launches.json", { ...native, ownerId: "foreign" }]] as const) {
      await writeFile(join(root, name), JSON.stringify(body));
      const refused = await observeFailureOutcome(target);
      assert.equal(refused.stage[name === "execution.json" ? "execution" : "native_journal"].state, "unavailable");
      await writeFile(join(root, name), JSON.stringify(name === "execution.json" ? execution : native));
    }
    const unstable = await observeFailureOutcome(target, async (path: string) => ({ path,
      value: path.endsWith("run.json") ? metadata : path.endsWith("execution.json") ? execution : path.endsWith("native-launches.json") ? native : undefined }),
      async (snapshot: { path: string }) => !snapshot.path.endsWith("native-launches.json"));
    assert.equal(unstable.stage.native_journal.reason, "source_changed");
    const changed = await observeFailureOutcome(target, async (path: string) => path.endsWith("result.json") ? undefined : ({ path,
      value: path.endsWith("run.json") ? metadata : path.endsWith("execution.json") ? execution : native }), async () => false);
    assert.equal(changed.reason, "metadata_changed"); assert.equal(changed.stage, undefined);
    await assert.rejects(observeFailureOutcome(target, async (path: string) => {
      if (path.endsWith("execution.json")) throw 0;
      return path.endsWith("run.json") ? { value: metadata } : undefined;
    }, async () => true), error => error === 0);
  } finally { await rm(root, { recursive: true, force: true }); }
  const stamp = { dev: 1, ino: 2, size: 1, mtimeMs: 3, ctimeMs: 4, isFile: () => true };
  for (const original of [undefined, null, false, 0, ""]) {
    const { readFailureJson } = runInNewContext(functions + "\n({ readFailureJson })", {
      originalObserverSlot: undefined,
      Buffer, constants, TextDecoder, lstat: async () => stamp,
      open: async () => ({ stat: async () => stamp, read: async () => { throw original; }, close: async () => { throw 0; } }),
    });
    await assert.rejects(readFailureJson("/fixture/result.json"), (error: any) => {
      assert.deepEqual(Array.from(error.errors), [original, 0]); return true;
    });
  }
  const mutable = { run: "fixture", run_instance_id: "generation", pid: 123, state_dir: "/fixture" };
  assert.equal((await observeFailureOutcome(mutable, async (path: string) => {
    const value = path.endsWith("run.json") ? { ...mutable } : { run_instance_id: "generation", code: 0 };
    if (path.endsWith("result.json")) mutable.run_instance_id = "replacement";
    return { value };
  }, async () => true)).state, "unavailable");
  const late = { run: "fixture", run_instance_id: "generation", pid: 123, state_dir: "/fixture" };
  const lateRefusal = await observeFailureOutcome(late, async (path: string) => ({ path,
    value: path.endsWith("run.json") ? { ...late } : { run_instance_id: late.run_instance_id, code: 0 } }), async (snapshot: { path: string }) => {
    if (snapshot.path.endsWith("result.json")) late.pid = 124;
    return true;
  });
  assert.equal(lateRefusal.reason, "capture_changed");
  for (const original of [undefined, null, false, 0, ""]) for (const diagnosticFault of [false, true]) {
    let reports = 0;
    const { settle } = runInNewContext(functions.slice(0, functions.indexOf("function failureFileStamp")) + "\n({ settle })", {
      originalObserverSlot: undefined,
      settleCapturedRunner: async () => { throw original; }, persistCapture: () => assert.fail("No persistence replay"),
      readSettlementFailureWitness: () => witness, observeFailureOutcome: async () => ({ state: "unavailable" }),
      failureContext: () => "SAFE_METADATA", console: { error: () => { reports++; if (diagnosticFault) throw 0; } },
    });
    await assert.rejects(settle({ pid: 123 }), (error: any) => {
      if (diagnosticFault) { assert.deepEqual(Array.from(error.errors), [original, 0]); return true; } return error === original;
    });
    assert.equal(reports, 1);
  }
  const { settle } = runInNewContext(functions.slice(0, functions.indexOf("function failureFileStamp")) + "\n({ settle })", {
    originalObserverSlot: undefined,
    settleCapturedRunner: async () => {}, persistCapture: () => {},
    observeFailureOutcome: () => assert.fail("Successful settlement must not collect diagnostics"),
    console: { error: () => assert.fail("Successful settlement must not report") },
  });
  await settle({ pid: 123 });
});

test("SDK fixture work readiness accepts the actual large-artifact metadata within its independent bound", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const functions = source.slice(source.indexOf("function failureFileStamp"), source.indexOf("async function readRetainedText"));
  const { resolveArtifactPaths } = await import("../lib/runs-artifacts.ts");
  const { win32, posix } = await import("node:path");
  for (const [paths, agentDir] of [[posix, "/tmp/界-fixture"], [win32, "C:\\fixture\\界"]] as const) {
    const declarations = runInNewContext(source.slice(source.indexOf("  const artifactDeclarations ="), source.indexOf("  const failureLiteral =")) + "\nartifactDeclarations", {
      artifactCount: 1800, artifactMode: true, artifactRoot: paths.join(agentDir, "artifact-large-artifacts"),
      artifactLiteral: "hidden-artifact-reference-token", agentDir, join: paths.join,
    });
    const artifacts = resolveArtifactPaths(declarations, {});
    const run = { run: "fixture", run_instance_id: "generation", pid: 123, state_dir: paths.join(agentDir, "run"), mode: "artifact-large" };
    // Controlled canonical envelope and file ports, not an actual Run or native process.
    const meta = { ...run, argv: [paths.join(agentDir, "node"), "emit.cjs"], ownerId: "owner", cwd: agentDir,
      createdAt: "2026-01-01T00:00:00.000Z", state_schema: "run-kernel-v1", outcome_protocol: "run-outcome-v1",
      started_at: "2026-01-01T00:00:00.000Z", supervision: { report_every_ms: null, max_runtime_ms: null, deadline_at: null },
      supervision_provenance: { report_every: "unset", max_runtime: "unset" }, status: "running", template: "node emit.cjs", values: {},
      model_policy: { model: { source: "unused" }, thinking: { source: "unused" } }, artifacts };
    const result = { run_instance_id: run.run_instance_id, terminal_acceptance: "natural", code: 0, killed: false,
      completedAt: meta.createdAt, primary_text_protocol: "run-primary-text-v1", artifact_inventory_protocol: "run-artifact-inventory-v1",
      result_diagnostics_protocol: "run-result-diagnostics-v1" };
    const bodies = new Map([[paths.join(run.state_dir, "run.json"), Buffer.from(JSON.stringify(meta))],
      [paths.join(run.state_dir, "result.json"), Buffer.from(JSON.stringify(result))]]);
    const metadataPath = paths.join(run.state_dir, "run.json"), resultPath = paths.join(run.state_dir, "result.json");
    assert.ok(bodies.get(metadataPath)!.length > 65536 && bodies.get(metadataPath)!.length < 1024 * 1024);
    assert.deepEqual(Object.keys(artifacts!), Array.from({ length: 1800 }, (_, i) => `declared-${i}`));
    const stamp = (size: number) => ({ dev: 1, ino: 2, size, mtimeMs: 3, ctimeMs: 4, isFile: () => true });
    let oversized: string | undefined, opens = 0;
    const stat = async (path: string) => {
      if (path === run.state_dir) return { dev: 1, ino: 1, isDirectory: () => true };
      if (!bodies.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return stamp(path === oversized ? (path === metadataPath ? 1024 * 1024 : 65536) + 1 : bodies.get(path)!.length);
    };
    const api = runInNewContext(functions + "\n({waitForWorkReadiness, captureWorkFrame})", {
      assert, Buffer, TextDecoder, join: paths.join, constants: { O_RDONLY: 0 }, lstat: stat,
      open: async (path: string) => { opens++; assert.notEqual(path, oversized, "Reject cap+1 before open/allocation"); return {
        stat: () => stat(path), read: async (buffer: Buffer) => { const bytes = bodies.get(path)!; bytes.copy(buffer); return { bytesRead: bytes.length }; },
        close: async () => {},
      }; },
    });
    api.captureWorkFrame(run, "owner");
    await api.waitForWorkReadiness(run, "owner", 0);
    assert.equal(opens, 2);
    assert.equal(Object.keys(JSON.parse(bodies.get(metadataPath)!.toString()).artifacts).length, 1800);
    for (const path of [metadataPath, resultPath]) {
      oversized = path; const before: number = opens;
      await assert.rejects(api.waitForWorkReadiness(run, "owner", 0), /Unusable work readiness source/);
      assert.equal(opens - before, path === metadataPath ? 0 : 1);
    }
  }
});

test("SDK fixture work readiness admits only stable exact-owner natural canonical work", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const functions = source.slice(source.indexOf("function failureFileStamp"), source.indexOf("async function readRetainedText"));
  const fs = await import("node:fs/promises"), { constants } = await import("node:fs");
  const api = runInNewContext(functions + "\n({ waitForWorkReadiness, readWorkJson, captureWorkFrame })", { ...fs, constants, Buffer, TextDecoder, join, assert });
  const root = await mkdtemp(join(tmpdir(), "work-ready-"));
  const run: any = { run: "fixture", run_instance_id: "generation", pid: 123, state_dir: root, mode: "final" };
  const meta = { ...run, ownerId: "owner", outcome_protocol: "run-outcome-v1", cwd: root, createdAt: "2026-01-01T00:00:00.000Z" };
  const result: any = { run_instance_id: run.run_instance_id, terminal_acceptance: "natural", code: 0,
    completedAt: meta.createdAt, killed: false, primary_text_protocol: "run-primary-text-v1", artifact_inventory_protocol: "run-artifact-inventory-v1",
    result_diagnostics_protocol: "run-result-diagnostics-v1" };
  const put = async (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value));
  try {
    await put("run.json", meta);
    api.captureWorkFrame(run, "owner");
    await assert.rejects(api.waitForWorkReadiness({ ...run }, "owner", 0), /original owner unavailable/);
    await assert.rejects(api.waitForWorkReadiness(run, "replacement", 0), /original owner unavailable/);
    let waits = 0;
    await api.waitForWorkReadiness(run, "owner", 0, { sleep: async (ms: number) => {
      assert.equal(ms, 25); waits++; await put("result.json", result);
    } });
    assert.equal(waits, 1);
    await put("result.json", { ...result, code: 7, error: "intentional failure" });
    await api.waitForWorkReadiness(run, "owner", 7);
    for (const change of [{ ownerId: "other" }, { run: "other" }, { pid: 124 }, { state_dir: "/other" },
      { run_instance_id: "other" }, { outcome_protocol: "future" }, { createdAt: "invalid" }, { cwd: null }]) {
      await put("run.json", { ...meta, ...change });
      await assert.rejects(api.waitForWorkReadiness(run, "owner", 0));
    }
    await put("run.json", meta);
    for (const change of [{ run_instance_id: "other" }, { terminal_acceptance: "stop" }, { terminal_acceptance: "cancelled" },
      { terminal_acceptance: "after_stop_claim" }, { stop_claim_id: "pending" }, { code: 7 }, { code: "0" }, { code: null },
      { error: "unexpected" }, { failure_reason: "unexpected" }, { killed: true }, { killed: undefined }, { signal: "SIGTERM" }, { completedAt: "invalid" }, { primary_text_protocol: "future" },
      { artifact_inventory_protocol: "future" }, { result_diagnostics_protocol: "future" }]) {
      await put("result.json", { ...result, ...change });
      await assert.rejects(api.waitForWorkReadiness(run, "owner", 0));
    }
    await put("result.json", result); await put("stop-claim.json", {});
    await assert.rejects(api.waitForWorkReadiness(run, "owner", 0), /refuses stop claims/);
    await rm(join(root, "stop-claim.json"));
    for (const name of ["run.json", "result.json"]) {
      for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(65537), Buffer.from("[]"), Buffer.from("null")]) {
        await writeFile(join(root, name), bytes); await assert.rejects(api.waitForWorkReadiness(run, "owner", 0));
      }
      await put(name, name === "run.json" ? meta : result);
    }
    for (const key of ["run", "run_instance_id", "pid", "state_dir", "mode"]) {
      const original = run[key]; let reads = 0;
      await assert.rejects(api.waitForWorkReadiness(run, "owner", 0, { read: async (...args: any[]) => {
        const value = await api.readWorkJson(...args); if (++reads === 2) run[key] = "changed"; return value;
      } }), /capture changed/); run[key] = original;
    }
    await assert.rejects(api.waitForWorkReadiness(run, "owner", 0, { read: async (...args: any[]) => {
      const value = await api.readWorkJson(...args);
      if (args[0].endsWith("result.json")) await put("run.json", { ...meta, changed: true });
      return value;
    } }), /source changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SDK fixture work readiness strict reader preserves physical fences and exact ordered read-close faults", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const functions = source.slice(source.indexOf("function failureFileStamp"), source.indexOf("async function readRetainedText"));
  const stamp = { dev: 1, ino: 2, size: 2, mtimeMs: 3, ctimeMs: 4, isFile: () => true };
  for (const fault of [undefined, null, false, 0, "", new Error("read")]) for (const closeFails of [false, true]) {
    const calls: string[] = [], later = Symbol("close");
    const { readWorkJson } = runInNewContext(functions + "\n({ readWorkJson })", {
      Buffer, TextDecoder, assert, constants: { O_RDONLY: 0 },
      lstat: async () => stamp, open: async () => ({ stat: async () => stamp,
        read: async () => { calls.push("read"); throw fault; }, close: async () => { calls.push("close"); if (closeFails) throw later; } }),
    });
    await assert.rejects(readWorkJson("/source"), (error: any) => {
      if (!closeFails) return error === fault;
      assert.deepEqual(Array.from(error.errors), [fault, later]); return true;
    }); assert.deepEqual(calls, ["read", "close"]);
  }
  for (const failure of [undefined, null, false, 0, "", { code: "EPERM" }, { code: "EACCES" }]) {
    const { readWorkJson } = runInNewContext(functions + "\n({ readWorkJson })", {
      lstat: async () => { throw failure; }, assert,
    });
    await assert.rejects(readWorkJson("/source", true), (error: unknown) => error === failure);
  }
  for (const phase of ["path", "descriptor", "short", "after", "path-after", "close"]) {
    let stats = 0, paths = 0, closed = 0;
    const { readWorkJson } = runInNewContext(functions + "\n({ readWorkJson })", {
      Buffer, TextDecoder, assert, constants: { O_RDONLY: 0 },
      lstat: async () => ({ ...stamp, ino: phase === "path" || (++paths === 2 && phase === "path-after") ? 99 : 2 }),
      open: async () => ({ stat: async () => ({ ...stamp, ino: (++stats === 1 && phase === "descriptor") || (stats === 2 && phase === "after") ? 99 : 2 }),
        read: async (buffer: Buffer) => { buffer.write("{}"); return { bytesRead: phase === "short" ? 1 : 2 }; },
        close: async () => { closed++; if (phase === "close") throw 0; } }),
    });
    await assert.rejects(readWorkJson("/source")); assert.equal(closed, 1);
  }
});

test("SDK fixture phase ordering readiness rejection retains exact primary through actual finally settlement", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const closing = source.slice(source.indexOf("  } catch (error) { primaryError = error; primaryFailed = true; throw error; }"),
    source.indexOf("\n}\nconsole.log(JSON.stringify(reports))"));
  for (const primary of [undefined, null, false, 0, "", new Error("readiness")]) for (const cleanupFails of [false, true]) {
    const calls: string[] = [], later = Symbol("settle");
    const execute = runInNewContext(`(async () => { let primaryError; let primaryFailed = false; try { await waitForWorkReadiness(); ${closing} })`, {
      waitForWorkReadiness: async () => { calls.push("ready"); throw primary; },
      gate: "/gate", writeFile: async () => { calls.push("gate"); },
      captured: [{ settled: true }], launching: false, originalObserverSlot: undefined,
      settle: async () => { calls.push("settle"); if (cleanupFails) throw later; },
      shutdown: undefined, startContext: undefined, session: { dispose() { calls.push("dispose"); } },
      unlisten() { calls.push("unlisten"); }, persistCapture: async () => { calls.push("persist"); },
    });
    await assert.rejects(execute(), (error: any) => {
      if (!cleanupFails) return error === primary;
      assert.deepEqual(Array.from(error.errors), [primary, later]); return true;
    });
    assert.deepEqual(calls, ["ready", "gate", "settle", "dispose", "unlisten", "persist"]);
  }
});

test("SDK fixture phase ordering waits for canonical work before starting the five-second absence policy", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const caller = source.match(/for \(const run of modeRuns\) \{[^\n]+\}/u)?.[0];
  assert.ok(caller);
  const calls: string[] = []; let clock = 0;
  const functions = source.slice(source.indexOf("function failureFileStamp"), source.indexOf("async function readRetainedText"));
  const api = runInNewContext(functions + "\n({ waitForWorkReadiness, captureWorkFrame })", { assert, join });
  const run = { pid: 123, run: "fixture", run_instance_id: "generation", state_dir: "/fixture", mode: "final" };
  api.captureWorkFrame(run, "owner");
  const stamp = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, isDirectory: () => true };
  const metadata = { ...run, ownerId: "owner", cwd: "/fixture", outcome_protocol: "run-outcome-v1", createdAt: "2026-01-01T00:00:00.000Z" };
  const outcome = { run_instance_id: "generation", code: 0, killed: false, terminal_acceptance: "natural", completedAt: metadata.createdAt,
    primary_text_protocol: "run-primary-text-v1", artifact_inventory_protocol: "run-artifact-inventory-v1", result_diagnostics_protocol: "run-result-diagnostics-v1" };
  const ports = { stat: async (path: string) => { if (path.endsWith("stop-claim.json")) throw { code: "ENOENT" }; return stamp; },
    read: async (path: string) => path.endsWith("run.json") ? { path, stamp, value: metadata }
      : clock < 9000 ? undefined : { path, stamp, value: outcome }, sleep: async () => { clock = 9000; } };
  const modulePath = "./fixtures/sdk-runner-settlement.mjs";
  const { settleCapturedRunner, readSettlementFailureWitness } = await import(modulePath);
  const execute = runInNewContext(`(async () => { ${caller} })`, {
    modeRuns: [run], ownerId: "owner", failureMode: false,
    waitForWorkReadiness: async (frame: unknown, owner: string, code: number) => {
      assert.equal(owner, "owner"); assert.equal(code, 0); calls.push("ready");
      await api.waitForWorkReadiness(frame, owner, code, ports);
    },
    settle: async (run: any) => {
      calls.push("settle"); let failure;
      try { await settleCapturedRunner(run, () => assert.fail("Present is not absence"), {
        now: () => clock, probe: () => {}, sleep: async () => { clock += 5001; },
      }); } catch (error) { failure = error; }
      const witness = readSettlementFailureWitness(failure);
      assert.equal(witness.started_ms, 9000); assert.equal(witness.deadline_ms, 14000);
    }, readOutcome: async () => { calls.push("outcome"); },
  });
  await execute(); assert.deepEqual(calls, ["ready", "settle", "outcome"]);
  assert.match(source, /if \(mode === "tools"\) \{ await waitForWorkReadiness\(run, ownerId, failureMode \? 7 : 0\); await settle\(run\); await readOutcome\(run\); \}/u);
  const cleanup = source.slice(source.indexOf("  finally {\n    const cleanupErrors = []"));
  assert.doesNotMatch(cleanup, /waitForWorkReadiness/u);
  assert.match(cleanup, /await writeFile\(gate, "release"\)/u);
  assert.match(cleanup, /await settle\(run\)/u);
});

test("SDK fixture settlement accepts only fresh ESRCH, including one final deadline-crossing observation", async () => {
  const modulePath = "./fixtures/sdk-runner-settlement.mjs";
  const { settleCapturedRunner } = await import(modulePath);
  const absent = Object.assign(new Error("absent"), { code: "ESRCH" });
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  const unknown = Object.assign(new Error("unknown"), { code: "EUNKNOWN" });
  for (const final of [absent, "live", denied, unknown, undefined, null, false, 0, ""]) {
    const run = { pid: 123, settled: false, code: 0, elapsed: 999_999 };
    let clock = 0, probes = 0, sleeps = 0, persists = 0;
    const ports = {
      now: () => clock,
      probe: (pid: number, signal: number) => {
        assert.equal(pid, 123); assert.equal(signal, 0); probes++;
        if (probes === 2 && final !== "live") throw final;
      },
      sleep: async (ms: number) => { assert.equal(ms, 25); sleeps++; clock = 5_001; },
    };
    const result = settleCapturedRunner(run, async () => { persists++; }, ports);
    if (final === absent) await result;
    else if (final === "live") await assert.rejects(result, /exit remains unproven; retaining state/);
    else await assert.rejects(result, (error: unknown) => error === final);
    assert.equal(probes, 2); assert.equal(sleeps, 1);
    assert.equal(run.settled, final === absent); assert.equal(persists, final === absent ? 1 : 0);
  }
  for (const cause of [denied, unknown, undefined, null, false, 0, ""]) {
    const run = { pid: 123, settled: false };
    await assert.rejects(settleCapturedRunner(run, () => assert.fail("No fabricated closure"), {
      now: () => 0, probe: () => { throw cause; }, sleep: () => assert.fail("Probe failure must not wait"),
    }), (error: unknown) => error === cause);
    assert.equal(run.settled, false);
  }
  let persists = 0;
  const run = { pid: 123, settled: false };
  await settleCapturedRunner(run, () => { persists++; }, {
    now: () => 0, probe: () => { throw absent; }, sleep: () => assert.fail("Already absent must not wait"),
  });
  assert.equal(run.settled, true); assert.equal(persists, 1);
  await settleCapturedRunner({ settled: true }, () => assert.fail("Already settled must not persist"), {
    now: () => assert.fail("Already settled must not sample"), probe: () => assert.fail("Already settled must not probe"),
  });
  for (const pid of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "123"]) {
    await assert.rejects(settleCapturedRunner({ pid, settled: false }, () => assert.fail("Invalid PID cannot close"), {
      now: () => assert.fail("Invalid PID must fail before the deadline"), probe: () => assert.fail("Invalid PID must not probe"),
    }), /Captured fixture PID is unavailable/);
  }
});

test("SDK fixture gate discriminator is failure-only and context excludes command/output bodies", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const marker = "PI_ACTORS_SDK_FIXTURE_GATE_EXPIRED_V1";
  const expression = source.slice(source.indexOf("await writeFile(script, ") + "await writeFile(script, ".length,
    source.indexOf(");\n  const sessionProvider"));
  for (const mode of ["tools", "final"]) for (const gateOpen of [false, true]) {
    const program = runInNewContext(expression, { mode, failureMode: false, artifactMode: false,
      emitted: "UNCHANGED_STDOUT", gate: "fixture-gate", gateExpiryMarker: marker });
    let clock = 0, interval: (() => void) | undefined, cleared = 0;
    const stdout: string[] = [], stderr: string[] = [], processPort: any = {
      stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) },
    };
    runInNewContext(program, { require: () => ({ existsSync: () => gateOpen }), process: processPort,
      Date: { now: () => clock }, setInterval: (callback: () => void, ms: number) => {
        assert.equal(ms, 10); interval = callback; return 42;
      }, clearInterval: (timer: number) => { assert.equal(timer, 42); cleared++; } });
    if (mode !== "tools") {
      clock = 299_999; interval!();
      if (!gateOpen) { assert.deepEqual(stderr, []); assert.equal(processPort.exitCode, undefined); clock = 300_000; interval!(); }
    }
    const expired = mode !== "tools" && !gateOpen;
    assert.deepEqual(stdout, expired ? [] : ["UNCHANGED_STDOUT"]);
    assert.deepEqual(stderr, expired ? [marker + "\n"] : []);
    assert.equal(processPort.exitCode, expired ? 1 : undefined); assert.equal(cleared, mode === "tools" ? 0 : 1);
  }
  const diagnostics = source.slice(source.indexOf("const gateExpiryMarker ="), source.indexOf("async function settle(run)"));
  const reports: string[] = [];
  const { failureContext, reportFailure } = runInNewContext(diagnostics + "\n({ failureContext, reportFailure })", {
    Buffer, console: { error: (text: string) => reports.push(text) },
  });
  const run = { mode: "overflow", request: 41, index: 3, run: "overflow-3", run_instance_id: "generation",
    pid: 123, state_dir: "/fixture/run" };
  const result = { terminal_acceptance: "natural", code: 1, signal: null, failure_reason: "command_failed",
    command: "SECRET_COMMAND", output: "SECRET_OUTPUT", error: "SECRET_ERROR " + marker };
  reportFailure("readOutcome", run, result);
  const context = JSON.parse(reports[0]);
  assert.deepEqual(context, { schema: "sdk-fixture-failure-v1", stage: "readOutcome", ...run,
    terminal_acceptance: "natural", code: 1, signal: null, failure_reason: "command_failed", gate_expiry_marker_observed: true });
  assert.doesNotMatch(reports[0], /SECRET/);
  assert.equal(JSON.parse(failureContext("settle", run)).gate_expiry_marker_observed, undefined);
  const bounded = failureContext("readOutcome", { ...run, state_dir: "x".repeat(4096) }, result);
  assert.equal(JSON.parse(bounded).state_dir, "[whole field omitted: size limit]");
  assert.ok(Buffer.byteLength(bounded) < 2048);
  const multibyte = "😀".repeat(1024);
  const fitting = failureContext("settle", { ...run, state_dir: multibyte });
  assert.equal(JSON.parse(fitting).state_dir, multibyte); assert.ok(Buffer.byteLength(fitting) < 8192);
  const overflow = failureContext("settle", { ...run, state_dir: multibyte, run: multibyte });
  assert.deepEqual(JSON.parse(overflow), { schema: "sdk-fixture-failure-v1", stage: "diagnostic_omission", details: "whole record omitted: diagnostic byte bound" });
  assert.ok(Buffer.byteLength(overflow) <= 8192);
  const broken = runInNewContext(diagnostics + "\nreportFailure", { Buffer, console: { error: () => { throw 0; } } });
  assert.doesNotThrow(() => broken("settle", run));
});

test("SDK fixture preserves exact provider rejection before ordered cleanup failures", async () => {
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const body = source.slice(source.indexOf("  try {\n    await session.bindExtensions"), source.indexOf("\n}\nconsole.log(JSON.stringify(reports))"));
  for (const original of [new Error("provider"), undefined, null, 0, false, ""]) {
    for (const cleanupFails of [false, true]) {
      const later = [new Error("gate"), undefined, false, 0, null, ""];
      const calls: string[] = [];
      const step = (name: string, index: number) => { calls.push(name); if (cleanupFails) throw later[index]; };
      const execute = runInNewContext(`(async () => { let primaryError; let primaryFailed = false; ${body} })`, {
        originalObserverSlot: undefined,
        providerFailed: true, providerError: original, mode: "final", lossMode: false, gate: "/fixture/gate",
        captured: [{ pid: 123, settled: true }], launching: false, errors: [], markTiming: () => {},
        session: { bindExtensions: async () => {}, setActiveToolsByName: () => {},
          prompt: async () => { throw new Error("SDK normalized failure must not mask provider"); },
          dispose: () => step("dispose", 3) },
        writeFile: async () => step("gate", 0), settle: async () => step("settle", 1),
        shutdown: async () => step("shutdown", 2), startContext: {},
        unlisten: () => step("unlisten", 4), persistCapture: async () => step("persist", 5),
      });
      await assert.rejects(execute(), (error: any) => {
        if (!cleanupFails) return error === original;
        assert.equal(error.name, "AggregateError");
        assert.deepEqual(Array.from(error.errors), [original, ...later]); return true;
      });
      assert.deepEqual(calls, ["gate", "settle", "shutdown", "dispose", "unlisten", "persist"]);
    }
  }
});

test("native timing recognizes actual UTF8 producers while preserving original calls and legacy grammar", async () => {
  const { observeNative } = await import(new URL("./fixtures/windows-native-timing.mjs", import.meta.url).href);
  const { oldReferenceCommand } = await import(new URL("./fixtures/windows-native-mi-prototype.mjs", import.meta.url).href);
  const { stripTypeScriptTypes } = await import("node:module");
  const source = await readFile(new URL("../lib/runs-process.ts", import.meta.url), "utf8");
  const commands: string[] = [];
  const owner = source.slice(source.indexOf("function readWindowsIdentity("), source.indexOf("export function readProcessIdentity("));
  const api = runInNewContext(stripTypeScriptTypes(owner.replaceAll("export ", "")) + "\n({ readWindowsIdentity, readWindowsProcessIdentities })", {
    Buffer, spawnSync: (_file: string, args: string[]) => {
      commands.push(args[3]!); return { status: 0, stdout: args[3]!.includes("-InputObject") ? "[]" : "{}" };
    },
  });
  api.readWindowsIdentity(101); api.readWindowsProcessIdentities([102, 103]);
  commands.push(oldReferenceCommand(104));
  const encoding = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true); ";
  assert.equal(commands.length, 3);
  const expected = [{ kind: "scalar", pid: 101 }, { kind: "shared", pid: 102 }, { kind: "scalar", pid: 104 }];
  const run = (command: string, admitted: boolean, kind: string, pid: number) => {
    let calls = 0, clock = 0;
    const events: any[] = [], receiver = {}, result = Object.freeze({ status: 0 });
    const argv = ["-NoProfile", "-NonInteractive", "-Command", command], options = {};
    const observer = observeNative(function (this: unknown, ...args: any[]) {
      calls++; assert.equal(this, receiver); assert.equal(args[0], "powershell.exe");
      assert.equal(args[1], argv); assert.equal(args[2], options); return result;
    }, (event: unknown) => events.push(event), { origin: 0, now: () => ++clock, classify: () => "unknown" });
    const ticket = observer.beginSettlement();
    assert.equal(observer.call(receiver, "powershell.exe", argv, options), result);
    observer.endSettlement(ticket);
    assert.equal(calls, 1);
    assert.equal(events.length, admitted ? 2 : 0);
    assert.equal(observer.readSettlement(ticket).calls, admitted ? 1 : 0);
    if (admitted) {
      assert.deepEqual(events.map(event => event.phase), ["before", "after"]);
      for (const event of events) { assert.equal(event.query_kind, kind); assert.equal(event.target_pid, pid); }
    }
  };
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!, { kind, pid } = expected[index]!;
    assert.equal(command.split(encoding).length, 2);
    run(command, true, kind, pid);
    run(command.replace(encoding, ""), true, kind, pid);
    for (const changed of [
      command.replace(encoding, encoding + encoding),
      command.replace("$false, $true", "$false, $false"),
      command.replace("$false, $true", "$true, $true"),
      command + "; Write-Output 'not an identity query'",
    ]) run(changed, false, kind, pid);
  }
});

test("native attribution is closed, callsite-aligned and local settlement tickets cannot be overwritten", async () => {
  const modulePath = "./fixtures/windows-native-timing.mjs";
  const { callerSites, classifyNativeCaller, observeNative, projectTimingAttribution } = await import(modulePath);
  for (const [path, line] of [["lib/runs-process.ts", 108], ["dist/lib/runs-process.js", 71]] as const)
    assert.ok((await readFile(join(process.cwd(), path), "utf8")).split("\n")[line - 1].includes("const result = spawnSync("));
  for (const [tag, name, file, sourceLine, packedLine, needle] of callerSites) {
    for (const [extension, line, root] of [["ts", sourceLine, "lib"], ["js", packedLine, "dist/lib"]]) {
      const body = await readFile(join(process.cwd(), root, `${file}.${extension}`), "utf8");
      const lines = body.split("\n");
      assert.ok(lines[line - 1]?.includes(needle), `${tag} ${extension} table drift`);
      // Identical native fences must remain attached to their distinct callback boundaries.
      const anchors: Record<string, string> = {
        produceradmission: "if (meta.pid !== process.pid)", publicationentry: "const meta = readCapturedProducerMeta(",
        postprepare: "options.prepare({", postprimary: "options.primaryText()", postartifact: "options.artifactInventory()",
        diagnosticsbefore: "requireProducerCleanupAvailable(producer)", diagnosticsafter: "record(active.candidate)",
        postdiagnostic: "options.resultDiagnostics(admission)", finalprecommit: "if (options.prepare || options.primaryText ||",
      };
      if (anchors[tag]) assert.ok(lines.slice(line - 3, line).join("\n").includes(anchors[tag]), `${tag} ${extension} boundary drift`);
      const frame = (fn: string, owner: string, n: number) => `    at ${fn ? fn + " (" : ""}file:///PRIVATE_CANARY/${root}/${owner}.${extension}:${n}:7${fn ? ")" : ""}`;
      const kind = tag === "sharedinventory" ? "shared" : "scalar";
      const nativeLine = extension === "ts" ? 108 : 71;
      const prefix = kind === "scalar" ? frame("readWindowsIdentity", "runs-process", nativeLine) + "\n" : "";
      assert.equal(classifyNativeCaller("Error\n" + prefix + frame(name, file, line), kind), tag);
      assert.equal(classifyNativeCaller("Error\n" + prefix + frame(name, file, line + 1), kind), "unknown");
    }
  }
  for (const stack of [undefined, {}, "PRIVATE_CANARY", "x".repeat(32769)])
    assert.equal(classifyNativeCaller(stack, "scalar"), "unknown");
  const query = '$p = Get-CimInstance Win32_Process -Filter "ProcessId = 123"; if ($null -eq $p) { exit 3 }; $p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const args = ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {}];
  for (const fault of [undefined, null, false, 0, ""]) for (const throws of [false, true]) {
    const receiver = {}, value = {}; let calls = 0;
    const wrapped = observeNative(function (this: unknown, ...actual: unknown[]) {
      calls++; assert.equal(this, receiver); assert.deepEqual(actual, args); if (throws) throw fault; return value;
    }, () => { throw fault; }, { classify: () => { throw fault; } });
    if (throws) assert.throws(() => wrapped.apply(receiver, args), error => error === fault);
    else assert.equal(wrapped.apply(receiver, args), value);
    assert.equal(calls, 1);
  }
  const validWindow = { state: "observed", start_ms: 0, end_ms: 20, start_sequence: 0, end_sequence: 1, calls: 1, total_ms: 10, max_ms: 10 };
  for (const patch of [
    { end_sequence: 0, calls: 100 }, { start_sequence: 0.5, calls: 0.5 },
    { calls: 0, end_sequence: 0, total_ms: 1000, max_ms: 2000 }, { end_ms: null },
    { total_ms: Infinity }, { max_ms: NaN }, { end_sequence: 4097 }, { end_ms: 5 },
    { end_ms: 1e308, end_sequence: 2, calls: 2, total_ms: 1e308, max_ms: 1e308, sites: [
      { caller: "directscalarstatus", query_kind: "scalar", calls: 1, total_ms: 1e308, max_ms: 1e308 },
      { caller: "managedchildbirth", query_kind: "scalar", calls: 1, total_ms: 1e308, max_ms: 1e308 },
    ] },
    { sites: [{ caller: "PRIVATE_CANARY", query_kind: "scalar", calls: 1, total_ms: 10, max_ms: 10 }] },
  ]) assert.equal(projectTimingAttribution(undefined, { ...validWindow, ...patch }).settlement.state, "unavailable");
  for (const samples of [[200, 180, 180, 185, 210], [0, 10, 10, 20, 5]]) {
    const observer = observeNative(() => null, () => {}, { origin: samples[0] === 200 ? 100 : 0, now: () => samples.shift() });
    const ticket = observer.beginSettlement(); observer(...args); observer.endSettlement(ticket);
    assert.equal(observer.readSettlement(ticket).state, "unavailable", "Backward clock cannot heal");
  }
  const histories = ["directscalarstatus", "managedchildbirth"].map(tag => {
    let time = 0, caller = tag;
    const observer = observeNative(() => { time += 9000; return null; }, () => {}, { origin: 0, now: () => time, classify: () => caller });
    const ticket = observer.beginSettlement(); observer(...args); observer.endSettlement(ticket);
    const saved = observer.readSettlement(ticket); caller = "runnerbirth"; observer(...args);
    assert.deepEqual(observer.readSettlement(ticket), saved);
    const copy = observer.readSettlement(ticket); if (copy.sites) copy.sites[0].calls = 999;
    assert.deepEqual(observer.readSettlement(ticket), saved, "Copies cannot mutate retained tickets");
    return JSON.stringify(saved);
  });
  assert.notEqual(histories[0], histories[1], "Original window retains its actual caller after later calls");
  let clock = 100; const events: any[] = [];
  const wrapped = observeNative(() => { clock += 5; return null; }, (event: any) => events.push(event),
    { origin: 100, now: () => clock, classify: () => "postprimary" });
  const first = wrapped.beginSettlement();
  assert.equal(wrapped.beginSettlement(), undefined);
  await Promise.resolve().then(() => wrapped(...args));
  wrapped.endSettlement({}); assert.equal(wrapped.readSettlement().end_ms, null);
  wrapped.endSettlement(first);
  assert.deepEqual(wrapped.readSettlement(), { state: "observed", start_ms: 0, end_ms: 5,
    start_sequence: 0, end_sequence: 1, calls: 1, total_ms: 5, max_ms: 5,
    sites: [{ caller: "postprimary", query_kind: "scalar", calls: 1, total_ms: 5, max_ms: 5 }] });
  clock = 120; const second = wrapped.beginSettlement();
  wrapped.endSettlement(first); assert.equal(wrapped.readSettlement().end_ms, null);
  assert.equal(wrapped.readSettlement(first).state, "unavailable");
  assert.equal(wrapped.readSettlement(second).state, "observed");
  const otherProcess = observeNative(() => null, () => {}, { now: () => 999999, origin: 0 });
  otherProcess(...args); wrapped.endSettlement(second);
  assert.equal(wrapped.readSettlement().calls, 0); assert.equal(wrapped.readSettlement().start_ms, 20);
  for (const invalid of [NaN, Infinity, 99]) {
    clock = invalid; const ticket = wrapped.beginSettlement(); wrapped.endSettlement(ticket);
    assert.equal(wrapped.readSettlement().state, "unavailable");
  }
  const projection = projectTimingAttribution({ caller: "PRIVATE_CANARY", query_kind: "SECRET" }, { state: "observed", start_ms: NaN });
  assert.equal(projection.last_native.caller, "unknown"); assert.equal(projection.settlement.state, "unavailable");
  assert.doesNotMatch(JSON.stringify([projection, events]), /PRIVATE_CANARY|Get-CimInstance/);
  assert.equal(projectTimingAttribution(undefined, undefined).settlement.state, "unavailable", "Legacy records need no attribution");
  const source = await readFile(join(process.cwd(), "tests/fixtures/completion-boundary-sdk.mjs"), "utf8");
  const body = source.slice(source.indexOf("async function settle(run)"), source.indexOf("function failureFileStamp"));
  for (const markerFails of [false, true]) for (const fails of [false, true]) {
    clock = Math.max(200, clock); const startClock = clock; let evidence: any; const order: string[] = [];
    const { settle } = runInNewContext(body + "\n({ settle })", {
      originalObserverSlot: undefined,
      beginSettlementTiming: () => { order.push("begin"); if (markerFails) throw false; return wrapped.beginSettlement(); },
      endSettlementTiming: (ticket: unknown) => { order.push("end"); if (markerFails) throw 0; wrapped.endSettlement(ticket); },
      readSettlementTiming: (ticket: unknown) => { order.push("read"); if (markerFails) throw null; return wrapped.readSettlement(ticket); },
      settleCapturedRunner: async () => { order.push("await"); await Promise.resolve(); wrapped(...args); if (fails) throw ""; },
      persistCapture: () => assert.fail("No extra persistence"), readSettlementFailureWitness: () => undefined,
      observeFailureOutcome: async () => { order.push("outcome"); return { state: "unavailable" }; },
      failureContext: (_stage: string, _run: unknown, _result: unknown, value: unknown) => { evidence = value; return "SAFE"; },
      console: { error: () => order.push("report") },
    });
    if (fails) await assert.rejects(settle({ pid: 123 }), error => error === ""); else await settle({ pid: 123 });
    assert.deepEqual(order, fails ? ["begin", "await", "end", "read", "outcome", "report"] : ["begin", "await", "end"]);
    if (fails && !markerFails) {
      assert.equal(evidence.driver_attribution.window.calls, 1);
      assert.equal(evidence.driver_attribution.window.end_ms, startClock - 100 + 5);
      assert.match(evidence.driver_attribution.scope, /no other-process overlap/);
    }
  }
});

test("temporary native timing preserves fake-port identity and bounded private active snapshots", async () => {
  const modulePath = "./fixtures/windows-native-timing.mjs";
  const { observeNative, enrollTiming } = await import(modulePath);
  const query = '$p = Get-CimInstance Win32_Process -Filter "ProcessId = 123"; if ($null -eq $p) { exit 3 }; $p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const args = ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], { private: "do-not-export" }];
  const receiver = {}, result = { status: 3, stdout: "private-native-body", stderr: "private-error" }, rejection = {};
  const events: any[] = [];
  const wrapped = observeNative(function (this: unknown, ...actual: unknown[]) {
    assert.equal(this, receiver); assert.deepEqual(actual, args);
    assert.equal(events.at(-1).phase, "before"); return result;
  }, (event: unknown) => events.push(event));
  assert.equal(wrapped.apply(receiver, args), result);
  const throwing = observeNative(() => { throw rejection; }, (event: unknown) => events.push(event));
  assert.throws(() => throwing(...args), (error: unknown) => error === rejection);
  assert.equal(events.at(-1).phase, "throw");
  assert.doesNotMatch(JSON.stringify(events), /do-not-export|private-native-body|private-error|Get-CimInstance/);
  for (const phase of ["before", "after", "throw"]) {
    let calls = 0;
    const observerError = phase === "before" ? undefined : phase === "after" ? 0 : false;
    const native = observeNative(() => { calls++; if (phase === "throw") throw rejection; return result; },
      (event: { phase: string }) => { if (event.phase === phase) throw observerError; });
    if (phase === "throw") assert.throws(() => native(...args), (error: unknown) => error === rejection);
    else assert.equal(native(...args), result);
    assert.equal(calls, 1);
    assert.ok(native.readObserverFailure());
    assert.equal(native.readObserverFailure().error, observerError);
  }
  for (const cause of [undefined, null, 0, "", false]) {
    const native = observeNative(() => { throw cause; }, () => { throw rejection; });
    assert.throws(() => native(...args), (error: unknown) => error === cause);
  }
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "status", { get() { getterCalls++; throw rejection; } });
  assert.equal(observeNative(() => accessor, () => {})(...args), accessor);
  assert.equal(getterCalls, 0);
  let clockCalls = 0;
  const brokenClock = observeNative(() => { clockCalls++; return result; }, () => {}, { origin: 0, now: () => { throw rejection; } });
  assert.equal(brokenClock(...args), result); assert.equal(clockCalls, 1);
  assert.equal(brokenClock.readObserverFailure().error, rejection);
  const brokenNativeClock = observeNative(() => { throw 0; }, () => {}, { origin: 0, now: () => { throw rejection; } });
  assert.throws(() => brokenNativeClock(...args), (error: unknown) => error === 0);
  let clock = 2;
  const clockEvents: any[] = [];
  const measured = observeNative(() => { clock += 5; return result; }, (event: unknown) => clockEvents.push(event), { origin: 0, now: () => clock });
  measured(...args); clock = 899; measured(...args);
  assert.deepEqual(clockEvents.filter(event => event.phase === "before").map(event => event.before_call_ms), [2, 899]);
  assert.deepEqual(clockEvents.filter(event => event.phase === "after").map(event => [event.native_start_ms, event.completed_ms, event.elapsed_ms]), [[2, 7, 5], [899, 904, 5]]);
  const excluded: unknown[] = [];
  const strict = observeNative(() => result, (event: unknown) => excluded.push(event));
  assert.equal(strict(args[0], ["-NoProfile", "-NonInteractive", "-Command", query + "\n"]), result);
  assert.deepEqual(excluded, []);
  const scalarProperties = ' -Property CreationDate,ExecutablePath,CommandLine';
  const scalarQuery = (projection: string) => query.replace('Win32_Process', 'Win32_Process' + projection);
  for (const projection of ['', scalarProperties]) {
    const scalarArgs = [args[0], [...(args[1] as string[]).slice(0, 3), scalarQuery(projection)], args[2]];
    for (const fault of [undefined, null, false, 0, '', {}]) for (const throws of [false, true]) {
      let calls = 0; const scalarEvents: any[] = [];
      const native = observeNative(function (this: unknown, ...actual: unknown[]) {
        calls++; assert.equal(this, receiver); assert.deepEqual(actual, scalarArgs);
        if (throws) throw fault; return result;
      }, (event: unknown) => scalarEvents.push(event));
      if (throws) assert.throws(() => native.apply(receiver, scalarArgs), error => error === fault);
      else assert.equal(native.apply(receiver, scalarArgs), result);
      assert.equal(calls, 1);
      assert.deepEqual(scalarEvents.map(event => event.phase), ['before', throws ? 'throw' : 'after']);
      assert.ok(scalarEvents.every(event => event.query_kind === 'scalar' && event.target_pid === 123));
      assert.doesNotMatch(JSON.stringify(scalarEvents), /Get-CimInstance|private-native-body|private-error/);
    }
  }
  for (const changed of [
    ...[' -Property CreationDate,ExecutablePath', ' -Property ExecutablePath,CreationDate,CommandLine',
      scalarProperties + ',ProcessId', scalarProperties + ',Handle', ' -KeyOnly', scalarProperties + ' -KeyOnly']
      .map(scalarQuery),
    scalarQuery(scalarProperties).replace('ProcessId = 123', 'ProcessId = 123 OR ProcessId = 124'),
    scalarQuery(scalarProperties) + '; Get-Process', scalarQuery(scalarProperties) + '\n',
  ]) for (const throws of [false, true]) {
    let calls = 0; const ignored: unknown[] = []; const fault = {};
    const changedArgs = [args[0], ['-NoProfile', '-NonInteractive', '-Command', changed], args[2]];
    const native = observeNative(function (this: unknown, ...actual: unknown[]) {
      calls++; assert.equal(this, receiver); assert.deepEqual(actual, changedArgs);
      if (throws) throw fault; return result;
    }, (event: unknown) => ignored.push(event));
    if (throws) assert.throws(() => native.apply(receiver, changedArgs), error => error === fault);
    else assert.equal(native.apply(receiver, changedArgs), result);
    assert.equal(calls, 1); assert.deepEqual(ignored, []);
  }
  const properties = ' -Property ProcessId,CreationDate,ExecutablePath,CommandLine';
  const sharedQuery = (pids: number[], projection = '') => '$ErrorActionPreference = "Stop"; $p = Get-CimInstance Win32_Process' + projection + ' -Filter "' +
    pids.map(pid => `ProcessId = ${pid}`).join(" OR ") + '"; ConvertTo-Json -InputObject @($p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine) -Compress';
  for (const projection of ['', properties]) for (const count of [1, 64]) {
    const sharedEvents: any[] = []; let calls = 0;
    const sharedArgs: [string, string[], unknown] = [args[0] as string,
      [...(args[1] as string[]).slice(0, 3), sharedQuery(Array.from({ length: count }, (_, i) => 123 + i), projection)], args[2]];
    const shared = observeNative(function (this: unknown, ...actual: unknown[]) {
      calls++; assert.equal(this, receiver); assert.deepEqual(actual, sharedArgs); return result;
    }, (event: unknown) => sharedEvents.push(event));
    assert.equal(shared.apply(receiver, sharedArgs), result); assert.equal(calls, 1);
    assert.deepEqual(sharedEvents.map(event => event.phase), ["before", "after"]);
    assert.ok(sharedEvents.every(event => event.target_pid === 123 && Number.isFinite(event.elapsed_ms)));
    assert.doesNotMatch(JSON.stringify(sharedEvents), /Get-CimInstance|private-native-body|private-error/);
    for (const changed of [sharedArgs[1][3] + "\n", sharedQuery([123, 123]), sharedQuery(Array.from({ length: 65 }, (_, i) => i + 1)),
      sharedQuery([Number.MAX_SAFE_INTEGER + 1]), sharedArgs[1][3].replace('"Stop"', '"Continue"'),
      ...[' -Property CreationDate,ProcessId,ExecutablePath,CommandLine', ' -Property ProcessId,CreationDate,ExecutablePath',
        properties + ',Handle'].map(altered => sharedQuery([123], altered))]) {
      let invoked = 0; const ignored: unknown[] = [];
      assert.equal(observeNative(() => { invoked++; return result; }, (event: unknown) => ignored.push(event))(
        args[0], ["-NoProfile", "-NonInteractive", "-Command", changed]), result);
      assert.equal(invoked, 1); assert.deepEqual(ignored, []);
      const rejection = {}; let throws = 0; const thrownEvents: unknown[] = [];
      assert.throws(() => observeNative(() => { throws++; throw rejection; }, (event: unknown) => thrownEvents.push(event))(
        args[0], ["-NoProfile", "-NonInteractive", "-Command", changed]), error => error === rejection);
      assert.equal(throws, 1); assert.deepEqual(thrownEvents, []);
    }
    const cause = {}; let thrownCalls = 0;
    assert.throws(() => observeNative(() => { thrownCalls++; throw cause; }, () => {})(...sharedArgs), error => error === cause);
    assert.equal(thrownCalls, 1);
  }
  const cp = (await import("node:child_process")).default;
  const fs = await import("node:fs");
  const original = cp.spawnSync, saved = process.env.PI_ACTORS_WINDOWS_BOUNDARY_TIMING;
  const root = await mkdtemp(join(tmpdir(), "pi-actors-timing-fake-"));
  let timing: { finish(): void } | undefined;
  try {
    process.env.PI_ACTORS_WINDOWS_BOUNDARY_TIMING = "1";
    cp.spawnSync = (() => {
      const path = join(root, "native-timing", "0.json");
      const snapshot = JSON.parse(fs.readFileSync(path, "utf8"));
      if (!snapshot.saturated) assert.equal(snapshot.event.phase, "before");
      return result;
    }) as unknown as typeof cp.spawnSync;
    timing = enrollTiming(root, "registration", true);
    for (let i = 0; i < 5000; i++) cp.spawnSync(args[0] as string, args[1] as string[]);
    const files = await readdir(join(root, "native-timing")); assert.equal(files.length, 1);
    const body = await readFile(join(root, "native-timing", files[0]), "utf8");
    assert.ok(Buffer.byteLength(body) <= 2048);
    const snapshot = JSON.parse(body); assert.equal(snapshot.writes, 8192); assert.equal(snapshot.saturated, true);
    assert.doesNotMatch(body, /private-native-body|private-error|Get-CimInstance/);
  } finally {
    try { timing?.finish(); } finally {
      cp.spawnSync = original;
      (await import("node:module")).syncBuiltinESMExports();
      if (saved === undefined) delete process.env.PI_ACTORS_WINDOWS_BOUNDARY_TIMING; else process.env.PI_ACTORS_WINDOWS_BOUNDARY_TIMING = saved;
      await rm(root, { recursive: true, force: true });
    }
  }
});

function assertCapturedFixtureLifetimes(rows: any[], expectedBirths: number): void {
  assert.equal(rows.length, expectedBirths, "Every actual runner/command-attempt birth is required");
  const keys = rows.map(row => JSON.stringify([row.run, row.run_instance_id, row.role, row.command ?? null, row.attempt ?? null]));
  assert.equal(new Set(keys).size, expectedBirths, "No duplicate generation/role/command-attempt capture");
  const orders = rows.flatMap(row => [row.captured_order, row.settled_order]);
  assert.ok(orders.every(value => Number.isSafeInteger(value) && value > 0));
  assert.deepEqual([...orders].sort((a, b) => a - b), Array.from({ length: expectedBirths * 2 }, (_, index) => index + 1));
  for (const row of rows) {
    assert.ok(row.captured_order < row.settled_order);
    for (const other of rows) if (row !== other && row.pid === other.pid) {
      assert.ok(row.settled_order < other.captured_order || other.settled_order < row.captured_order,
        "PID reuse requires fresh preceding-process absence before the next capture");
    }
  }
}

test("Fixture birth accounting permits only disjoint PID reuse and preserves exact command-attempt membership", () => {
  const first = { run: "fixture", run_instance_id: "generation", role: "workload", command: 1, attempt: 1,
    pid: 101, captured_order: 1, settled_order: 2 };
  const second = { ...first, command: 2, captured_order: 3, settled_order: 4 };
  assert.doesNotThrow(() => assertCapturedFixtureLifetimes([first, second], 2));
  assert.throws(() => assertCapturedFixtureLifetimes([first, { ...second, command: 1 }], 2), /duplicate/);
  assert.throws(() => assertCapturedFixtureLifetimes([first], 2), /birth/);
  const overlap = [{ ...first, settled_order: 3 }, { ...second, captured_order: 2 }];
  assert.throws(() => assertCapturedFixtureLifetimes(overlap, 2), /PID reuse/);
  assert.doesNotThrow(() => assertCapturedFixtureLifetimes([overlap[0], { ...overlap[1], pid: 102 }], 2));
});

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function waitForText(
  path: string,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readTextIfExists(path);
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}`);
}

async function removeTreeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "") || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function linkPiPeers(root: string): Promise<void> {
  const peersDir = join(root, "node_modules", "@earendil-works");
  await mkdir(peersDir, { recursive: true });
  for (const peer of ["pi-coding-agent", "pi-tui"]) {
    await symlink(join(process.cwd(), "node_modules", "@earendil-works", peer), join(peersDir, peer), "dir");
  }
}

function assertFreshFixtureRunnerAbsence(captured: readonly { pid: number }[], root: string, primaryError?: unknown,
  probe: (pid: number, signal: 0) => void = process.kill): void {
  const absenceErrors: unknown[] = [];
  for (const run of captured) {
    try { probe(run.pid, 0); absenceErrors.push(Error(`Captured fixture PID remains present: ${run.pid}`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") absenceErrors.push(error); }
  }
  if (absenceErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...absenceErrors],
    `Captured fixture runner exit remains unproven; retaining state: ${root}`);
}

async function prepareInstalledPackage(root: string): Promise<string> {
  const packageDir = join(root, "node_modules", "@llblab", "pi-actors");
  await mkdir(packageDir, { recursive: true });
  await linkPiPeers(root);
  await cp(join(process.cwd(), "package.json"), join(packageDir, "package.json"));
  // This copy fixture reuses installed dependencies just as it reuses the Pi peers.
  // The packed fixture independently installs its real tarball and dependencies.
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const target = join(root, "node_modules", dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(process.cwd(), "node_modules", dependency), target, "dir");
  }
  await cp(join(process.cwd(), "dist"), join(packageDir, "dist"), { recursive: true });
  await cp(join(process.cwd(), "lib"), join(packageDir, "lib"), { recursive: true });
  await cp(join(process.cwd(), "scripts"), join(packageDir, "scripts"), { recursive: true });
  await cp(join(process.cwd(), "skills"), join(packageDir, "skills"), { recursive: true });
  return packageDir;
}

async function preparePackedPackage(root: string): Promise<string> {
  const packDir = join(root, "pack");
  await mkdir(packDir, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true })}\n`);
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for packed-package tests");
  await execFileAsync(process.execPath, [
    npmCli,
    "pack",
    process.cwd(),
    "--pack-destination",
    packDir,
    "--silent",
  ], { cwd: root });
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  await execFileAsync(process.execPath, [
    npmCli,
    "install",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-package-lock",
    "--no-save",
    join(packDir, tarballs[0]),
  ], { cwd: root });
  await linkPiPeers(root);
  const packageDir = join(root, "node_modules", "@llblab", "pi-actors");
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.match(manifest.pi.image, /^https:\/\//u);
  assert.ok((await readFile(join(packageDir, "README.md"), "utf8")).includes(manifest.pi.image));
  await assert.rejects(access(join(packageDir, "banner.jpg")), { code: "ENOENT" });
  return packageDir;
}

test("source and packed default SDK advertise canonical tools and preserve explicit legacy dispatch with foreign collision refusal", async () => {
  for (const layout of ["source", "packed"] as const) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-tool-names-sdk-"));
    try {
      const packageDir = layout === "source" ? process.cwd() : await preparePackedPackage(root);
      const agentDir = join(root, "agent"); await mkdir(agentDir);
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        "--import", pathToFileURL(join(process.cwd(), "tests/test-environment.mjs")).href,
        "--experimental-strip-types", join(process.cwd(), "tests/fixtures/tool-names-sdk.mjs"), packageDir, agentDir, layout,
      ], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" }, timeout: 30_000 });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.schema, "tool-names-sdk-v1"); assert.equal(result.layout, layout);
      assert.equal(result.results.length, 7); assert.equal(result.declaredRequests, 9);
      assert.deepEqual(result.lifecycle, ["delete", "recreate", "restore-remove", "restore-disable", "restore-invalidate", "foreign-after-loss"]);
      assert.equal(result.workloads, 0); assert.equal(result.saved_calls, "preserved");
      assert.doesNotMatch(stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
    } finally { await rm(root, { recursive: true, force: true }); } // Data-only SDK; no Actor/native workload starts.
  }
});

test("macOS SPI pilot A authoring contracts (synthetic only, no native execution)", async (t) => {
  const pilot = await import(new URL("./fixtures/macos-spi-pilot.mjs", import.meta.url).href);
  // These DTOs exercise protocol consistency, never provide a native witness.
  const roles = ["D", "A", "B", "A.leaf", "B.leaf"];
  const pids: Record<string, number> = { D: 101, A: 102, B: 103, "A.leaf": 104, "B.leaf": 105 };
  const parent: Record<string, string> = { A: "D", B: "D", "A.leaf": "A", "B.leaf": "B" };
  const unique: Record<string, string> = Object.fromEntries(roles.map((r, i) => [r, String(9007199254740993n + BigInt(i))]));
  const observe = (role: string, phase: string) => ({
    event: "observe", role, phase, pid: pids[role], ppid: role === "D" ? 100 : pids[parent[role]], pgid: 90, sid: 90,
    uid: 501, euid: 501, gid: 20, egid: 20, groups: [9, 2, 9],
    unique_return: 56, unique_errno: 0, coalition_return: 40, coalition_errno: 0,
    uuid: "a".repeat(32), uniqueid: unique[role], parent_uniqueid: role === "D" ? "88" : unique[parent[role]], idversion: 7, original_parent_version: 7,
    unique_reserved: ["0", "0"], coalition_ids: ["9007199254740993", "18446744073709551615"], coalition_reserved: ["0", "0", "0"],
    setsid_attempted: role === "A.leaf" && phase === "after", setsid_result: role === "A.leaf" && phase === "after" ? pids[role] : null, setsid_errno: 0,
    ...(role === "A.leaf" && phase === "after" ? { pgid: pids[role], sid: pids[role] } : {}),
  });
  const birth = (role: string) => ({ event: "birth", role, parent_role: parent[role], parent_pid: pids[parent[role]], pid: pids[role] });
  const wait = (role: string) => ({ ...birth(role), event: "wait", kind: "exit", value: 0, raw_status: 0 });
  const journey = () => [
    { event: "hello", pid: 101, abi: pilot.ABI, unique_size: 56, coalition_size: 40, coalition_types: 2, watchdog_ms: 30000 },
    observe("D", "ready"), birth("A"), birth("B"), observe("A", "ready"), observe("B", "ready"),
    birth("A.leaf"), birth("B.leaf"), observe("A.leaf", "before"), observe("B.leaf", "before"),
    observe("A.leaf", "after"), observe("B.leaf", "after"), wait("A.leaf"), wait("A"), wait("B.leaf"), wait("B"),
    { event: "end", pid: 101, io_ok: true, complete: true },
  ];
  const facts = () => ({ frames: journey(), driver: { pid: 101, parent_pid: 100, credentials: { uid: 501, euid: 501, gid: 20, egid: 20 } }, close: { code: 0, signal: null }, absent: Object.values(pids), rawComplete: true });
  const profile = () => ({
    schema: "pi-actors-spi-a-profile-v2", profile: "macos-15-arm64", platform: "darwin", arch: "arm64", node_major: "24",
    os_version: "15.8.2", os_build: "24H232", darwin_release: "24.6.0", image_version: "synthetic-image-not-native-evidence",
    xcode_version: "16.4", xcode_build: "16F6", sdk_version: "15.5", sdk_build: "synthetic-sdk-build", compiler_version: "synthetic clang fixture",
    developer_dir: "/Applications/Xcode_16.4.app/Contents/Developer", github_repository: "example/research",
    commit: "a".repeat(40), fixture_sha256: "b".repeat(64), transport_sha256: "d".repeat(64), harness_sha256: "c".repeat(64),
  });
  await t.test("closed frames preserve uint64 bits, reserved arrays, native type order and raw wait semantics", () => {
    for (const frame of journey()) assert.deepEqual(pilot.parsePilotAFrame(JSON.stringify(frame)), frame);
    assert.notEqual(String(Number(unique.D)), unique.D);
    for (const value of [9007199254740992, "01", "-1", "18446744073709551616", "1e2", null]) {
      assert.throws(() => pilot.parsePilotAFrame(JSON.stringify({ ...observe("D", "ready"), uniqueid: value })), /identity/);
    }
    assert.throws(() => pilot.parsePilotAFrame(JSON.stringify({ ...observe("D", "ready"), coalition_ids: ["1"] })));
    assert.throws(() => pilot.parsePilotAFrame(JSON.stringify({ ...journey()[0], coalition_types: 3 })), /ABI/);
    assert.throws(() => pilot.parsePilotAFrame(JSON.stringify({ ...wait("A"), raw_status: 9, kind: "exit", value: 137 })), /Wait/);
    assert.equal(pilot.parsePilotAFrame(JSON.stringify({ ...wait("A"), raw_status: 9, kind: "signal", value: 9 })).value, 9);
    assert.throws(() => pilot.parsePilotAFrame(JSON.stringify({ ...birth("A"), pid: -1 })), /PID/);
    assert.throws(() => pilot.parsePilotAFrame(JSON.stringify({ ...birth("A"), unexpected: true })), /shape/);
    assert.throws(() => pilot.parsePilotAFrame(JSON.stringify(birth("A")) + "\n"), /boundary/);
    assert.throws(() => pilot.parsePilotAFrame(" ".repeat(4096)), /boundary/);
  });
  await t.test("profile drift and later matrix rows cannot self-admit; data getters are not evaluated", () => {
    assert.deepEqual(pilot.admitPilotAProfile(profile(), profile()), { admitted: true });
    const { transport_sha256: _omitted, ...legacy } = profile();
    assert.equal(pilot.admitPilotAProfile({ ...legacy, schema: "pi-actors-spi-a-profile-v1" }, profile()).status, "ENVIRONMENT_BLOCKED", "v1 does not bind the shared C header");
    for (const key of Object.keys(profile())) {
      const actual = { ...profile(), [key]: "changed" };
      assert.equal(pilot.admitPilotAProfile(profile(), actual).status, "ENVIRONMENT_BLOCKED", key);
    }
    for (const patch of [{ profile: "macos-26-arm64" }, { arch: "x64" }, { node_major: "26" }, { xcode_version: "16.3" }, { fixture_sha256: "unknown" }, { transport_sha256: "unknown" }]) {
      assert.equal(pilot.admitPilotAProfile({ ...profile(), ...patch }, { ...profile(), ...patch }).admitted, false);
    }
    let reads = 0;
    const getter = profile();
    Object.defineProperty(getter, "compiler_version", { enumerable: true, get() { reads++; throw Error("must not read"); } });
    assert.equal(pilot.admitPilotAProfile(getter, profile()).admitted, false);
    assert.equal(reads, 0);
  });
  await t.test("CU-1 real profile producer feeds v2 admission and preserves measured header binding without native IO", async () => {
    const harness = await readFile(new URL("./fixtures/macos-spi-pilot.mjs", import.meta.url), "utf8");
    assert.match(harness, /\bconst\s+actual\s*=\s*buildPilotAProfile\(\s*\{/, "CLI must use the tested producer, not another profile DTO");
    const approved = profile();
    const { schema: _schema, ...facts } = approved;
    const measured = Object.freeze(facts);
    const actual = pilot.buildPilotAProfile(measured);
    assert.deepEqual(pilot.admitPilotAProfile(approved, actual), { admitted: true });
    assert.equal(actual.schema, approved.schema);
    assert.equal(actual.transport_sha256, measured.transport_sha256);
    assert.equal(Object.hasOwn(measured, "schema"), false, "producer cannot mutate measured facts");
    const changed = { ...measured, transport_sha256: "e".repeat(64) };
    const changedActual = pilot.buildPilotAProfile(changed);
    assert.equal(changedActual.transport_sha256, changed.transport_sha256, "producer cannot repair or replace a measured hash");
    assert.equal(pilot.admitPilotAProfile(approved, changedActual).status, "ENVIRONMENT_BLOCKED");
    const { transport_sha256: _hash, ...missing } = measured;
    const missingActual = pilot.buildPilotAProfile(missing);
    assert.equal(Object.hasOwn(missingActual, "transport_sha256"), false);
    assert.equal(pilot.admitPilotAProfile(approved, missingActual).status, "ENVIRONMENT_BLOCKED");
    const legacy = { ...approved, schema: "pi-actors-spi-a-profile-v1" };
    assert.equal(pilot.admitPilotAProfile(legacy, legacy).status, "ENVIRONMENT_BLOCKED");
    assert.throws(() => pilot.buildPilotAProfile(legacy), /must not supply schema/, "producer must not silently upgrade a versioned DTO");
  });
  await t.test("research workflow is manual, immutable-pinned, read-only and finite without executing Actions", async () => {
    const workflow = await readFile(new URL("../.github/workflows/macos-spi-pilot-a.yml", import.meta.url), "utf8");
    assert.match(workflow, /on:\n  workflow_dispatch:/);
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|workflow_call|schedule|repository_dispatch):/m);
    assert.match(workflow, /execute_pilot_a:[\s\S]*?default: false/);
    assert.match(workflow, /inventory_only:[\s\S]*?default: false/);
    assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && \(inputs\.execute_pilot_a == true \|\| inputs\.inventory_only == true\)/);
    assert.ok(workflow.includes('test "$RESEARCH_EXECUTE:$RESEARCH_INVENTORY_ONLY" = true:false || test "$RESEARCH_EXECUTE:$RESEARCH_INVENTORY_ONLY" = false:true'));
    assert.ok(workflow.includes('test -z "$RESEARCH_PROFILE_JSON"')); assert.ok(workflow.includes('test -z "$RESEARCH_PROFILE_SHA256"'));
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.doesNotMatch(workflow, /(?:contents|actions|id-token|packages): write|secrets:|continue-on-error:|sudo |npm (?:ci|install|publish)|xcode-select/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.ok(workflow.includes('/tmp/pi-actors-validation/workflow/job-owner.txt'));
    for (const guard of ['test "$GITHUB_RUN_ATTEMPT" = 1', 'test "$GITHUB_SHA" = "$APPROVED_COMMIT"', 'test "$GITHUB_WORKFLOW_SHA" = "$APPROVED_COMMIT"', 'test ! -e /tmp/pi-actors-validation', 'test ! -L /tmp/pi-actors-validation']) assert.ok(workflow.includes(guard));
    assert.deepEqual([...workflow.matchAll(/uses: (\S+)/g)].map(m => m[1]), [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    ]);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /package-manager-cache: false/);
    for (const minutes of [15, 5, 3]) assert.ok(workflow.includes(`timeout-minutes: ${minutes}`));
    assert.match(workflow, /if: success\(\) && inputs\.execute_pilot_a == true && inputs\.inventory_only == false && steps\.prepare\.outcome == 'success'/);
    assert.match(workflow, /if: success\(\) && inputs\.inventory_only == true && inputs\.execute_pilot_a == false && steps\.prepare\.outcome == 'success'/);
    assert.match(workflow, /RESEARCH_INVENTORY_OUTCOME: \$\{\{ steps\.inventory\.outcome \}\}/);
    const { INVENTORY_COMMANDS } = await import(new URL("./fixtures/macos-spi-research.mjs", import.meta.url).href);
    assert.deepEqual([...workflow.matchAll(/^          capture_inventory ([a-z-]+) (.+)$/gm)].map(m => [m[1], m[2]]), INVENTORY_COMMANDS.map((c: any) => [c.name, [c.command, ...c.args].join(" ")]));
    const inventoryStep = workflow.split("      - name: Collect metadata only without a pilot or SPI\n")[1]?.split("      - name: Execute the independently admitted first-profile trial")[0];
    assert.ok(inventoryStep); assert.match(inventoryStep, /timeout-minutes: 2/);
    assert.doesNotMatch(inventoryStep, /--execute-readonly-pilot-a|-std=c11|-lproc|proc_pidinfo/);
    assert.match(workflow, /if: always\(\) && steps\.evidence\.outputs\.owned == 'true'/);
    assert.match(workflow, /if-no-files-found: error/);
    assert.match(workflow, /id: collector/); assert.match(workflow, /id: admission/);
    assert.match(workflow, /RESEARCH_COLLECTOR_OUTCOME: \$\{\{ steps\.collector\.outcome \}\}/);
    assert.match(workflow, /run: node tests\/fixtures\/macos-spi-research\.mjs admit/);
    assert.ok(workflow.includes('test "$marker_bytes" -le 1024'));
    const uploadPaths = workflow.split("          path: |\n")[1]?.split("          if-no-files-found:")[0].trim().split(/\n\s*/);
    assert.deepEqual(uploadPaths, ["/tmp/pi-actors-validation/bundle/", "/tmp/pi-actors-validation/workflow/job-owner.txt"]);
    const upload = workflow.slice(workflow.lastIndexOf("uses: actions/upload-artifact@"));
    assert.match(upload, /^\s+include-hidden-files: true$/m, "UB-2: uploader must retain dotfiles already selected by the bounded collector");
    const runs = [...workflow.matchAll(/        run: (?:\|\n((?:          .*\n)+)|([^\n]+))/g)].map(m => m[1] ?? m[2]);
    assert.ok(runs.length >= 5);
    for (const run of runs) assert.doesNotMatch(run, /\$\{\{/, "inputs are env data, never interpolated shell code");
    assert.equal(runs.filter(run => run.includes("--execute-readonly-pilot-a")).length, 1);
    const helper = await readFile(new URL("./fixtures/macos-spi-research.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(helper, /node:child_process|process\.kill|\b(?:spawn|execFile|execSync)\s*\(/, "envelope cannot launch native work");
    assert.match(helper, /save\(join\(WORK, "inventory-request\.json"\), buildResearchInventoryRequest\(ctx, hashes\)\)/, "inventory CLI must use its tested request producer");
  });
  const research = await import(new URL("./fixtures/macos-spi-research.mjs", import.meta.url).href);
  const researchContext = () => ({ ci: "true", event: "workflow_dispatch", attempt: "1", sha: "a".repeat(40), workflow_sha: "a".repeat(40), repository: "example/research", run_id: "123", platform: "darwin", arch: "arm64", node_major: "24", uid: 501, euid: 501 });
  const sourceHashes = () => ({ fixture_sha256: profile().fixture_sha256, transport_sha256: profile().transport_sha256, harness_sha256: profile().harness_sha256 });
  const researchInput = (p = profile()) => { const text = JSON.stringify(p); return { execute: "true", commit: p.commit, profile: text, profile_sha256: createHash("sha256").update(text).digest("hex") }; };
  const inventoryFixture = () => {
    const ctx = researchContext(), p = profile();
    const request = research.buildResearchInventoryRequest(ctx, sourceHashes());
    const host = { schema: "pi-actors-inventory-host-v1", ...ctx, gid: 20, egid: 20, groups: [20, 42], node_version: "v24.0.0", image_version: p.image_version, developer_dir: p.developer_dir };
    const output: Record<string, string> = { "git-status": "", "git-head": p.commit + "\n", "os-version": p.os_version + "\n", "os-build": p.os_build + "\n", "darwin-release": p.darwin_release + "\n", "native-arch": "arm64\n", xcode: `Xcode ${p.xcode_version}\nBuild version ${p.xcode_build}\n`, "sdk-version": p.sdk_version + "\n", "sdk-build": p.sdk_build + "\n", compiler: p.compiler_version + "\n" };
    const records = Object.fromEntries(research.INVENTORY_COMMANDS.map((c: any) => [c.name, { stdout: Buffer.from(output[c.name]), stderr: Buffer.alloc(0), code: Buffer.from("0\n") }]));
    return { ctx, request, host, records };
  };
  await t.test("inventory mode is exclusive and cannot approve or execute a pilot", () => {
    const ctx = researchContext(), input = { execute: "false", inventory_only: "true", commit: ctx.sha, profile: "", profile_sha256: "" };
    assert.equal(research.admitResearchMode(input, ctx), "inventory");
    assert.equal(research.admitResearchMode({ ...researchInput(), inventory_only: "false" }, ctx), "pilot_a");
    for (const patch of [{ execute: "true" }, { inventory_only: "false" }, { execute: false }, { inventory_only: true }, { commit: "b".repeat(40) }, { profile: "{}" }, { profile_sha256: "a".repeat(64) }]) assert.throws(() => research.admitResearchMode({ ...input, ...patch }, ctx));
    assert.throws(() => research.admitResearchRequest({ ...input, execute: "true" }, ctx, sourceHashes()), /profile digest/);
    const f = inventoryFixture(), result = research.assessResearchInventory(f.request, f.host, f.records, "success", "skipped");
    assert.equal(result.status, "INVENTORY_ONLY"); assert.equal(result.inventory_complete, true);
    assert.equal(result.review_candidate, false); assert.equal(result.profile_approved, false); assert.equal(result.pilot_executed, false);
    assert.equal(result.c1_accepted, false); assert.equal(result.phase_b_admitted, false);
    assert.equal(Object.hasOwn(result.measured_tuple, "schema"), false, "measured tuple is not a v2 approved profile");
    assert.equal(Object.hasOwn(result.measured_tuple, "profile"), false, "requested target label is not a measured fact");
    assert.equal(result.node_version, "v24.0.0");
    assert.equal(pilot.admitPilotAProfile(profile(), result.measured_tuple).admitted, false);
    assert.deepEqual(result.credentials.groups, [20, 42]);
    for (const outcome of ["failure", "cancelled", "skipped", ""]) assert.equal(research.assessResearchInventory(f.request, f.host, f.records, outcome, "skipped").inventory_complete, false);
    assert.equal(research.assessResearchInventory(f.request, f.host, f.records, "success", "success").inventory_complete, false);
    const mutations: Array<(f: any) => void> = [
      f => { delete f.records.compiler.stderr; }, f => { f.records.compiler.code = Buffer.from("1\n"); }, f => { f.records.compiler.code = Buffer.from("0"); },
      f => { f.records["os-version"].stdout = Buffer.from([255]); }, f => { f.records["git-status"].stdout = Buffer.from("?? changed\n"); },
      f => { f.records["git-head"].stdout = Buffer.from("b".repeat(40)); }, f => { f.records["native-arch"].stdout = Buffer.from("x86_64"); },
      f => { f.host.run_id = "999"; }, f => { f.host.groups = [20, 20]; }, f => { delete f.host.image_version; }, f => { delete f.host.node_version; }, f => { f.records.xcode.stdout = Buffer.from("unknown"); },
      f => { f.request.profile_approved = true; }, f => { f.request.native_admitted = true; }, f => { f.request.commands = []; },
    ];
    for (const mutate of mutations) { const f = inventoryFixture(); mutate(f); assert.equal(research.assessResearchInventory(f.request, f.host, f.records, "success", "skipped").inventory_complete, false); }
  });
  await t.test("research request refuses replay, forged identity, profile/source drift and implicit admission", () => {
    const request = researchInput(), ctx = researchContext(), hashes = sourceHashes();
    const envelope = research.admitResearchRequest(request, ctx, hashes);
    const marker = [ctx.run_id, ctx.attempt, ctx.sha, ctx.workflow_sha, ctx.repository].join("\n") + "\n";
    research.verifyResearchOwner(ctx, marker);
    for (const patch of [{ run_id: "124" }, { attempt: "2" }, { platform: "linux" }, { repository: "foreign/repo" }]) assert.throws(() => research.verifyResearchOwner({ ...ctx, ...patch }, marker));
    assert.throws(() => research.verifyResearchOwner(ctx, ""));
    const hugeContext = { ...ctx, repository: "r".repeat(1024) };
    assert.throws(() => research.verifyResearchOwner(hugeContext, [ctx.run_id, ctx.attempt, ctx.sha, ctx.workflow_sha, hugeContext.repository].join("\n") + "\n"));
    assert.deepEqual(envelope.profile, profile()); assert.equal(envelope.native_admitted, false);
    for (const patch of [{ execute: "false" }, { execute: true }, { commit: "b".repeat(40) }, { profile_sha256: "f".repeat(64) }, { profile: "x".repeat(65537) }]) assert.throws(() => research.admitResearchRequest({ ...request, ...patch }, ctx, hashes));
    for (const patch of [{ event: "pull_request" }, { attempt: "2" }, { ci: "false" }, { sha: "b".repeat(40) }, { workflow_sha: "b".repeat(40) }, { repository: "foreign/repo" }, { platform: "linux" }, { arch: "x64" }, { node_major: "26" }, { uid: 0 }, { euid: 0 }, { run_id: "../other" }]) assert.throws(() => research.admitResearchRequest(request, { ...ctx, ...patch }, hashes));
    for (const key of Object.keys(hashes)) assert.throws(() => research.admitResearchRequest(request, ctx, { ...hashes, [key]: "f".repeat(64) }));
    assert.throws(() => research.admitResearchRequest(researchInput({ ...profile(), schema: "pi-actors-spi-a-profile-v1" }), ctx, hashes));
    const unknown = { ...profile(), unreviewed: "field" };
    assert.throws(() => research.admitResearchRequest(researchInput(unknown), ctx, hashes));
  });
  await t.test("research result reuses the owner projection; upload, timeout or missing facts cannot mint PASS_A", () => {
    const envelope = research.admitResearchRequest(researchInput(), researchContext(), sourceHashes());
    const f = facts(), report = { ...pilot.evaluatePilotA(f), gate_refusal: null };
    const binary = { abi: pilot.ABI, source_sha256: profile().fixture_sha256, transport_sha256: profile().transport_sha256 };
    const assess = (e = envelope, actual = profile(), r = report, data: any = f, b: any = binary, outcome = "success") => research.assessResearchResult(e, actual, r, data, b, outcome);
    assert.deepEqual(assess(), { review_candidate: true, review_required: true, native_report_status: "PASS_A", c1_accepted: false, phase_b_admitted: false });
    for (const outcome of ["failure", "cancelled", "skipped", ""]) assert.equal(assess(envelope, profile(), report, f, binary, outcome).review_candidate, false);
    assert.equal(assess(envelope, { ...profile(), image_version: "drift" }).review_candidate, false);
    for (const data of [null, {}, { ...f, rawComplete: false }, { ...f, timedOut: true }, { ...f, absent: [] }]) assert.equal(assess(envelope, profile(), report, data).review_candidate, false);
    for (const r of [{ ...report, status: "INCONCLUSIVE" }, { ...report, c1_accepted: true }, { ...report, gate_refusal: "fault" }]) assert.equal(assess(envelope, profile(), r).review_candidate, false);
    assert.equal(assess(envelope, profile(), report, f, { ...binary, transport_sha256: "f".repeat(64) }).review_candidate, false);
  });
  await t.test("RW-1 producer declares inventory before launch, seals it and never repairs a failed write", async () => {
    const writes: Buffer[] = [], opaque = Object.freeze({ inventory: "failed" });
    let fail = false;
    const producer = pilot.createPilotAEvidenceInventory((bytes: Buffer) => { if (fail) throw opaque; writes.push(Buffer.from(bytes)); });
    assert.equal(JSON.parse(writes[0].toString()).complete, false);
    assert.equal(producer.declare("/synthetic/tool", ["metadata"]), "preflight-1");
    const pending = pilot.readPilotAEvidenceInventory(JSON.parse(writes.at(-1)!.toString()));
    assert.equal(pending.complete, false);
    for (const suffix of ["birth.json", "exit.json", "close.json", "stdout", "stderr"]) assert.ok(pending.files.includes(`preflight-1.${suffix}`));
    assert.throws(() => producer.finish(), /Unsettled/);
    producer.record("preflight-1", Buffer.from("observed stdout"), Buffer.alloc(0));
    const digest = producer.finish(), finalBytes = writes.at(-1)!;
    assert.equal(digest, createHash("sha256").update(finalBytes).digest("hex"));
    assert.equal(pilot.readPilotAEvidenceInventory(JSON.parse(finalBytes.toString())).complete, true);
    assert.throws(() => producer.declare("/later", []), /closed/); assert.throws(() => producer.finish(), /closed/);
    const broken = pilot.createPilotAEvidenceInventory((bytes: Buffer) => { if (fail) throw opaque; writes.push(Buffer.from(bytes)); });
    fail = true;
    assert.throws(() => broken.declare("/synthetic/tool", []), (e: unknown) => e === opaque);
    const count = writes.length;
    assert.throws(() => broken.declare("/later", []), /closed/); assert.throws(() => broken.finish(), /closed/);
    assert.equal(writes.length, count);
    assert.throws(() => pilot.readPilotAEvidenceInventory({ ...pending, files: ["../escape"] }));
    assert.throws(() => pilot.buildPilotAEvidenceInventory([], true));
    const source = await readFile(new URL("./fixtures/macos-spi-pilot.mjs", import.meta.url), "utf8");
    const commandStart = source.indexOf("const command = async (exe, argv");
    assert.ok(commandStart >= 0, "CLI command block must exist");
    const command = source.slice(commandStart);
    const declarationIndex = command.indexOf("inventory.declare(exe, argv)"), captureIndex = command.indexOf("await capturePilotA(");
    assert.ok(declarationIndex >= 0, "Inventory declaration must exist");
    assert.ok(captureIndex >= 0, "Preflight capture must exist");
    assert.ok(declarationIndex < captureIndex, "Inventory declaration must precede preflight capture");
    assert.match(source, /projection\.status === "PASS_A" \? inventory\.finish\(\) : null/);
  });
  await t.test("research evidence collector freezes only explicit IO snapshots and refuses partial or foreign evidence", () => {
    const base = join("fake", "evidence"), native = "mac-a-fixture";
    const input = researchInput(), ctx = researchContext();
    const envelope = research.admitResearchRequest(input, ctx, sourceHashes());
    const f = facts(), raw = f.frames.map(frame => JSON.stringify(frame)).join("\n") + "\n";
    let inventoryBytes = Buffer.alloc(0);
    const producer = pilot.createPilotAEvidenceInventory((bytes: Buffer) => { inventoryBytes = Buffer.from(bytes); });
    const preflightStdout = Buffer.from("synthetic metadata\n"), preflightStderr = Buffer.alloc(0);
    const first = producer.declare("/synthetic/metadata", ["--version"]);
    producer.record(first, preflightStdout, preflightStderr);
    const second = producer.declare("/synthetic/compile", ["source", "-o", "binary"]);
    producer.record(second, preflightStdout, preflightStderr);
    const inventoryDigest = producer.finish(), inventory = pilot.readPilotAEvidenceInventory(JSON.parse(inventoryBytes.toString()));
    const report = { ...pilot.evaluatePilotA(f), gate_refusal: null, retained_root: join(base, native), evidence_inventory_sha256: inventoryDigest };
    const binaryBytes = Buffer.from("synthetic binary bytes, never executed");
    const records: Record<string, any> = {
      "workflow/envelope.json": envelope, "workflow/harness.stdout": report,
      [`${native}/requested-profile.json`]: profile(), [`${native}/actual-profile.json`]: profile(),
      [`${native}/report.json`]: report, [`${native}/driver.birth.json`]: f.driver,
      [`${native}/driver.close.json`]: { birth: f.driver, close: f.close, rawComplete: true, timedOut: false, faults: [] },
      [`${native}/driver.exit.json`]: f.close, [`${native}/frames.json`]: f.frames,
      [`${native}/absence.json`]: f.absent.map(pid => ({ pid, state: "absent", cause: { code: "ESRCH" } })),
      [`${native}/binary.json`]: { abi: pilot.ABI, source_sha256: profile().fixture_sha256, transport_sha256: profile().transport_sha256, sha256: createHash("sha256").update(binaryBytes).digest("hex") },
    };
    for (const [index, declaration] of inventory.preflights.entries()) {
      const attempt = { parent_pid: f.driver.parent_pid, credentials: f.driver.credentials, command: declaration.command, args: declaration.args };
      const birth = { pid: 201 + index, ...attempt };
      records[`${native}/${declaration.name}.birth.json`] = birth;
      records[`${native}/${declaration.name}.exit.json`] = { code: 0, signal: null };
      records[`${native}/${declaration.name}.close.json`] = { attempt, birth, close: { code: 0, signal: null }, rawComplete: true, timedOut: false, faults: [] };
    }
    const requiredPaths = ["workflow/job-owner.txt", "workflow/requested-profile.json", "workflow/envelope.json", "workflow/prepare.stdout", "workflow/prepare.stderr", "workflow/harness.stdout", "workflow/harness.stderr", ...inventory.files.map((file: string) => `${native}/${file}`)];
    const run = (change: (nodes: Map<string, any>) => void = () => {}, outcome = "success", faults: { read?: unknown; persist?: unknown; persistBytes?: number; copy?: unknown; copyBytes?: number } = {}, observe: (nodes: Map<string, any>, writes: number) => void = () => {}, options: { mode?: "inventory"; inventory_outcome?: string } = {}) => {
      const nodes = new Map<string, any>();
      const path = (s: string) => join(base, ...s.split("/"));
      for (const p of [base, path("workflow")]) nodes.set(p, { kind: "dir" });
      if (options.mode === "inventory") {
        const f = inventoryFixture();
        for (const [name, value] of [["inventory-request.json", f.request], ["inventory-host.json", f.host]] as const) nodes.set(path("workflow/" + name), { kind: "file", bytes: Buffer.from(JSON.stringify(value)) });
        for (const spec of research.INVENTORY_COMMANDS) for (const stream of ["stdout", "stderr", "code"]) nodes.set(path(`workflow/inventory-${spec.name}.${stream}`), { kind: "file", bytes: f.records[spec.name][stream] });
        for (const name of ["prepare.stdout", "prepare.stderr"]) nodes.set(path("workflow/" + name), { kind: "file", bytes: Buffer.alloc(0) });
        nodes.set(path("inventory-scratch"), { kind: "dir" });
        nodes.set(path("inventory-scratch/.excluded"), { kind: "file", bytes: Buffer.from("not evidence") });
      } else {
        for (const p of [path(native), path(`${native}/home`), path(`${native}/tmp`), path(`${native}/clang-cache`)]) nodes.set(p, { kind: "dir" });
        for (const [name, data] of Object.entries(records)) nodes.set(path(name), { kind: "file", bytes: Buffer.from(JSON.stringify(data)) });
        nodes.set(path(`${native}/driver.stdout`), { kind: "file", bytes: Buffer.from(raw) });
        nodes.set(path(`${native}/driver.stderr`), { kind: "file", bytes: Buffer.alloc(0) });
        nodes.set(path(`${native}/pilot-a`), { kind: "file", bytes: binaryBytes });
        nodes.set(path(`${native}/evidence-inventory.json`), { kind: "file", bytes: inventoryBytes });
        nodes.set(path("workflow/requested-profile.json"), { kind: "file", bytes: Buffer.from(input.profile) });
        for (const name of ["prepare.stdout", "prepare.stderr", "harness.stderr"]) nodes.set(path(`workflow/${name}`), { kind: "file", bytes: Buffer.alloc(0) });
        for (const p of inventory.preflights) for (const name of ["stdout", "stderr"]) nodes.set(path(`${native}/${p.name}.${name}`), { kind: "file", bytes: name === "stdout" ? preflightStdout : preflightStderr });
      }
      nodes.set(path("workflow/job-owner.txt"), { kind: "file", bytes: Buffer.from([ctx.run_id, ctx.attempt, ctx.sha, ctx.workflow_sha, ctx.repository].join("\n") + "\n") });
      change(nodes);
      let manifestWrites = 0;
      const io = {
        mkdirSync: (p: string) => { assert.equal(nodes.has(p), false); nodes.set(p, { kind: "dir" }); },
        readdirSync: (p: string) => [...nodes.keys()].filter(key => key.startsWith(p + sep) && !key.slice(p.length + 1).includes(sep)).map(key => key.slice(p.length + 1)),
        lstatSync: (p: string) => { const n = nodes.get(p); assert.ok(n); return { size: n.size ?? n.bytes?.length ?? 0, isFile: () => n.kind === "file", isDirectory: () => n.kind === "dir", isSymbolicLink: () => n.kind === "link" }; },
        readFileSync: (p: string) => { if (p.endsWith("driver.stdout") && Object.hasOwn(faults, "read")) throw faults.read; const n = nodes.get(p); assert.equal(n?.kind, "file"); return n.bytes; },
        writeFileSync: (p: string, bytes: string | Buffer, options: { flag: string }) => {
          const data = Buffer.from(bytes);
          assert.equal(options.flag, "wx"); assert.equal(nodes.has(p), false);
          if (p.endsWith("collection.json")) {
            assert.equal(++manifestWrites, 1, "failed manifest persistence is never replayed");
            if (Object.hasOwn(faults, "persist")) {
              if (faults.persistBytes !== undefined) nodes.set(p, { kind: "file", bytes: data.subarray(0, faults.persistBytes) });
              throw faults.persist;
            }
          } else if (p.endsWith(".bin") && Object.hasOwn(faults, "copy")) {
            nodes.set(p, { kind: "file", bytes: data.subarray(0, faults.copyBytes ?? 1) });
            throw faults.copy;
          }
          nodes.set(p, { kind: "file", bytes: data });
        },
      };
      try {
        const result = research.collectResearchEvidence(io, base, outcome, options);
        for (const file of result.files) {
          const copied = nodes.get(join(base, "bundle", ...file.path.split("/"))).bytes;
          assert.equal(createHash("sha256").update(copied).digest("hex"), file.sha256);
        }
        assert.equal(nodes.has(path("workflow/collection.json")), false, "manifest must be inside the bounded upload tree");
        assert.ok(result.reserved_bytes <= research.RESEARCH_EXPORT_LIMITS.dataBytes);
        assert.ok(result.copy_slots <= research.RESEARCH_EXPORT_LIMITS.dataSlots);
        return result;
      } finally {
        const metadata = nodes.get(path("bundle/collection.json"))?.bytes;
        const exported = [...nodes].filter(([p, n]) => n.kind === "file" && (p.startsWith(path("bundle") + sep) || p === path("workflow/job-owner.txt")));
        if (metadata) assert.ok(metadata.length <= research.RESEARCH_EXPORT_LIMITS.metadata);
        assert.ok(exported.length <= research.RESEARCH_EXPORT_LIMITS.slots);
        assert.ok(exported.reduce((sum, [, n]) => sum + n.bytes.length, 0) <= research.RESEARCH_EXPORT_LIMITS.bytes);
        observe(nodes, manifestWrites);
      }
    };
    const inventoryRun = (change: (nodes: Map<string, any>) => void = () => {}, faults: { persist?: unknown; persistBytes?: number } = {}, observe: (nodes: Map<string, any>, writes: number) => void = () => {}, inventory_outcome = "success") => run(change, "skipped", faults, observe, { mode: "inventory", inventory_outcome });
    const measured = inventoryRun();
    const measuredObserved = { mode: "inventory", native: "skipped", inventory: "success", collector: "success" };
    assert.equal(measured.evidence_complete, true); assert.equal(measured.inventory_complete, true);
    assert.equal(measured.review_candidate, false); assert.equal(measured.profile_approved, false); assert.equal(measured.pilot_executed, false);
    assert.equal(research.admitResearchExport(measured, ctx, measuredObserved).review_candidate, false);
    assert.ok(measured.files.every((f: any) => f.path.startsWith("workflow/")));
    assert.ok(!measured.files.some((f: any) => /requested-profile|harness\.|driver\.|inventory-scratch/.test(f.path)));
    assert.throws(() => research.admitResearchExport(measured, ctx, { native: "success", collector: "success" }));
    for (const patch of [{ native: "success" }, { inventory: "failure" }, { collector: "failure" }]) assert.throws(() => research.admitResearchExport(measured, ctx, { ...measuredObserved, ...patch }));
    assert.throws(() => research.admitResearchExport({ ...measured, review_candidate: true }, ctx, measuredObserved));
    assert.throws(() => research.admitResearchExport(measured, { ...ctx, run_id: "999" }, measuredObserved));
    for (const file of measured.files) {
      const missing = inventoryRun(nodes => nodes.delete(join(base, ...file.path.split("/"))));
      assert.equal(missing.evidence_complete, false, file.path); assert.equal(missing.review_candidate, false);
    }
    assert.equal(inventoryRun(() => {}, {}, () => {}, "failure").inventory_complete, false);
    assert.equal(inventoryRun(nodes => nodes.set(join(base, "workflow", "harness.stdout"), { kind: "file", bytes: Buffer.alloc(0) })).evidence_complete, false);
    const invError = Object.freeze({ inventory: "persistence failed after full write" });
    let surviving: any;
    assert.throws(() => inventoryRun(() => {}, { persist: invError, persistBytes: Number.MAX_SAFE_INTEGER }, (nodes, writes) => {
      assert.equal(writes, 1); surviving = JSON.parse(nodes.get(join(base, "bundle", "collection.json")).bytes.toString());
    }), (e: unknown) => e === invError);
    assert.equal(surviving.inventory_complete, true);
    assert.throws(() => research.admitResearchExport(surviving, ctx, { ...measuredObserved, collector: "failure" }));
    const full = run();
    assert.equal(full.review_candidate, true);
    assert.equal(full.evidence_complete, true);
    assert.equal(research.admitResearchExport(full, ctx, { native: "success", collector: "success" }).review_candidate, true);
    for (const collector of ["failure", "cancelled", "skipped", "", undefined]) assert.throws(() => research.admitResearchExport(full, ctx, { native: "success", collector }));
    assert.throws(() => research.admitResearchExport(full, ctx, { native: "failure", collector: "success" }));
    assert.throws(() => research.admitResearchExport(full, { ...ctx, run_id: "999" }, { native: "success", collector: "success" }));
    for (const patch of [
      { evidence_complete: false }, { files: [] }, { files: [full.files[0], full.files[0]] },
      { files: full.files.map((f: any, i: number) => i === 0 ? { ...f, sha256: "invalid" } : f) },
      { reserved_bytes: full.files.reduce((sum: number, f: any) => sum + f.bytes, 0) - 1 },
    ]) assert.throws(() => research.admitResearchExport({ ...full, ...patch }, ctx, { native: "success", collector: "success" }));
    for (const name of requiredPaths) assert.ok(full.files.some((file: any) => file.path === name));
    const dotfiles = new Map([
      ["workflow/.diagnostic", Buffer.from("reviewed workflow diagnostic\n")],
      [`${native}/.diagnostic`, Buffer.from("native diagnostic: \u0000\u{1F9EA}\n")],
    ]);
    const hidden = run(nodes => {
      for (const [name, bytes] of dotfiles) nodes.set(join(base, ...name.split("/")), { kind: "file", bytes });
      for (const cache of ["home", "tmp", "clang-cache"]) nodes.set(join(base, native, cache, ".excluded"), { kind: "file", bytes: Buffer.from("excluded cache data") });
    }, "success", {}, nodes => {
      for (const [name, bytes] of dotfiles) assert.deepEqual(nodes.get(join(base, "bundle", ...name.split("/"))).bytes, bytes, "UB-2: dotfile bytes are frozen without clipping");
      for (const cache of ["home", "tmp", "clang-cache"]) assert.equal(nodes.has(join(base, "bundle", native, cache, ".excluded")), false);
    });
    assert.equal(hidden.review_candidate, true); assert.equal(hidden.evidence_complete, true);
    assert.equal(hidden.reserved_bytes, full.reserved_bytes + [...dotfiles.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    assert.equal(hidden.copy_slots, full.copy_slots + dotfiles.size);
    for (const [name, bytes] of dotfiles) {
      const entry = hidden.files.find((file: any) => file.path === name);
      assert.ok(entry); assert.equal(entry.bytes, bytes.length);
      assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
    assert.equal(research.admitResearchExport(hidden, ctx, { native: "success", collector: "success" }).review_candidate, true);
    assert.ok(hidden.files.every((file: any) => !/\/(?:home|tmp|clang-cache)\//.test(file.path)));
    for (const name of requiredPaths) {
      const missing = run(nodes => nodes.delete(join(base, ...name.split("/"))));
      assert.equal(missing.review_candidate, false, name);
      assert.ok(missing.files.length > 0, "available evidence is still frozen");
    }
    const editJSON = (nodes: Map<string, any>, file: string, mutate: (value: any) => void) => { const key = join(base, ...file.split("/")); const value = JSON.parse(nodes.get(key).bytes.toString()); mutate(value); nodes.set(key, { kind: "file", bytes: Buffer.from(JSON.stringify(value)) }); };
    const variants: Array<(nodes: Map<string, any>) => void> = [
      nodes => nodes.set(join(base, "workflow", "requested-profile.json"), { kind: "file", bytes: Buffer.from(" " + input.profile) }),
      nodes => editJSON(nodes, "workflow/envelope.json", e => { e.profile_sha256 = "f".repeat(64); }),
      nodes => editJSON(nodes, `${native}/report.json`, r => { r.evidence_inventory_sha256 = "f".repeat(64); }),
      nodes => editJSON(nodes, `${native}/evidence-inventory.json`, i => { i.complete = false; }),
      nodes => editJSON(nodes, `${native}/preflight-1.birth.json`, b => { b.command = "/different"; }),
      nodes => editJSON(nodes, `${native}/preflight-1.close.json`, c => { c.close.code = 1; }),
      nodes => editJSON(nodes, `${native}/preflight-1.close.json`, c => { c.rawComplete = false; }),
      nodes => editJSON(nodes, `${native}/preflight-1.close.json`, c => { c.timedOut = true; }),
      nodes => editJSON(nodes, `${native}/preflight-1.close.json`, c => { c.faults = [{ code: "EIO" }]; }),
      nodes => editJSON(nodes, `${native}/preflight-1.close.json`, c => { c.attempt.args = ["changed"]; }),
      nodes => editJSON(nodes, `${native}/preflight-1.exit.json`, e => { e.signal = "SIGTERM"; }),
      nodes => { const key = join(base, native, "preflight-1.stdout"); const bytes = Buffer.from(nodes.get(key).bytes); bytes[0] ^= 1; nodes.set(key, { kind: "file", bytes }); },
      nodes => nodes.set(join(base, native, "preflight-1.stdout"), { kind: "file", bytes: Buffer.alloc(0) }),
      nodes => nodes.set(join(base, native, "preflight-99.stdout"), { kind: "file", bytes: Buffer.alloc(0) }),
    ];
    for (const mutate of variants) assert.equal(run(mutate).review_candidate, false);
    const originalCounterexample = run(nodes => {
      nodes.delete(join(base, "workflow", "requested-profile.json"));
      for (const key of [...nodes.keys()]) if (key.includes("preflight-")) nodes.delete(key);
    });
    assert.equal(originalCounterexample.review_candidate, false);
    assert.ok(originalCounterexample.files.some((file: any) => file.path === `${native}/report.json`));
    assert.equal(run(() => {}, "failure").review_candidate, false);
    const ambiguous = run(nodes => {
      nodes.set(join(base, "mac-a-other"), { kind: "dir" });
      nodes.set(join(base, "mac-a-other", "report.json"), { kind: "file", bytes: Buffer.from('{"status":"INCONCLUSIVE"}') });
    });
    assert.equal(ambiguous.review_candidate, false);
    assert.ok(ambiguous.files.some((f: any) => f.path === "mac-a-other/report.json"), "ambiguous roots remain evidence, not a second trial or silent omission");
    const opaque = Object.freeze({ original: true }), persistence = Error("manifest persistence");
    for (const original of [undefined, opaque]) {
      const failed = run(() => {}, "success", { read: original });
      assert.equal(failed.review_candidate, false); assert.equal(failed.causes[0], original);
      assert.ok(failed.files.some((file: any) => file.path === `${native}/report.json`), "read failure must not discard later salvage");
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(failed)), "causes"), false);
      assert.throws(() => run(() => {}, "success", { read: original, persist: persistence }), (e: any) => e instanceof AggregateError && e.errors.length === 2 && e.errors[0] === original && e.errors[1] === persistence);
    }
    // UB-1: the writer may leave valid positive JSON and still report failure.
    for (const persistBytes of [17, Number.MAX_SAFE_INTEGER]) {
      let saved: Buffer | undefined;
      assert.throws(() => run(() => {}, "success", { persist: opaque, persistBytes }, (nodes, writes) => {
        assert.equal(writes, 1);
        saved = nodes.get(join(base, "bundle", "collection.json")).bytes;
        assert.ok(nodes.has(join(base, native, "report.json")), "original evidence is not removed");
      }), (e: unknown) => e === opaque);
      assert.ok(saved);
      if (persistBytes === 17) { assert.equal(saved.length, 17); assert.throws(() => JSON.parse(saved!.toString())); }
      else {
        const packet = JSON.parse(saved.toString());
        assert.equal(packet.review_candidate, true);
        assert.throws(() => research.admitResearchExport(packet, ctx, { native: "success", collector: "failure", upload: "success" }), /External native\/collector/);
      }
    }
    const limits = research.RESEARCH_EXPORT_LIMITS;
    assert.equal(limits.dataBytes + limits.metadata + limits.bootstrap, limits.bytes);
    assert.equal(limits.dataSlots + 2, limits.slots);
    const block = Buffer.alloc(limits.file, 65);
    const extras = (nodes: Map<string, any>, count: number, bytes: Buffer, suffix = "bin") => {
      for (let i = 0; i < count; i++) nodes.set(join(base, native, `optional-${String(i).padStart(3, "0")}.${suffix}`), { kind: "file", bytes });
    };
    const partialCopies = run(nodes => {
      extras(nodes, 10, block);
      nodes.set(join(base, native, "optional-z-tail.txt"), { kind: "file", bytes: Buffer.from("retained after faults") });
    }, "success", { copy: opaque, copyBytes: 1 });
    assert.equal(partialCopies.review_candidate, false);
    assert.equal(partialCopies.failed_copies.length, 7, "partial writes keep full reservations; the eighth 4MiB copy cannot fit");
    assert.ok(partialCopies.causes.includes(opaque));
    assert.ok(partialCopies.files.some((f: any) => f.path.endsWith("optional-z-tail.txt")));
    assert.ok(partialCopies.reserved_bytes >= 7 * limits.file);
    const slots = run(nodes => extras(nodes, 300, Buffer.alloc(0)), "success", { copy: undefined, copyBytes: 0 });
    assert.equal(slots.copy_slots, limits.dataSlots);
    assert.equal(slots.failed_copies.length, limits.dataSlots - full.files.length);
    assert.equal(slots.review_candidate, false);
    assert.ok(slots.causes.some((e: unknown) => e === undefined));
    const metadataFailure = Error("\u0000".repeat(4096));
    const summary = run(nodes => extras(nodes, 220, Buffer.alloc(0)), "success", { copy: metadataFailure, copyBytes: 0 });
    assert.equal(summary.review_candidate, false); assert.equal(summary.evidence_complete, false);
    assert.match(summary.metadata_summary, /Non-pass bounded summary/);
    assert.equal(summary.files.length, 0); assert.ok(summary.files_omitted >= full.files.length);
    assert.ok(summary.faults_omitted > 0); assert.ok(summary.failed_copies_omitted > 0);
    assert.equal(summary.causes[0], metadataFailure);
    assert.throws(() => research.admitResearchExport(summary, ctx, { native: "success", collector: "success" }));
    assert.throws(() => run(nodes => extras(nodes, 220, Buffer.alloc(0)), "success", { copy: metadataFailure, copyBytes: 0, persist: persistence }), (e: any) => e instanceof AggregateError && e.errors[0] === metadataFailure && e.errors.at(-2).message === "Export metadata budget exceeded" && e.errors.at(-1) === persistence);
    const exactFill = (nodes: Map<string, any>) => {
      let remaining = limits.dataBytes - full.reserved_bytes, index = 0;
      while (remaining > 0) {
        const n = Math.min(limits.file, remaining);
        nodes.set(join(base, native, `optional-fill-${index++}.txt`), { kind: "file", size: 0, bytes: block.subarray(0, n) });
        remaining -= n;
      }
    };
    const exact = run(exactFill);
    assert.equal(exact.reserved_bytes, limits.dataBytes); assert.equal(exact.review_candidate, true);
    const excess = run(nodes => { exactFill(nodes); nodes.set(join(base, native, "optional-zz-excess.txt"), { kind: "file", size: 0, bytes: Buffer.from("x") }); });
    assert.equal(excess.reserved_bytes, limits.dataBytes); assert.equal(excess.review_candidate, false);
    for (const file of requiredPaths) assert.ok(excess.files.some((f: any) => f.path === file), "optional files cannot precede mandatory evidence");
    const malformedInventory = run(nodes => {
      nodes.set(join(base, native, "evidence-inventory.json"), { kind: "file", bytes: Buffer.from("{") });
    });
    assert.equal(malformedInventory.review_candidate, false);
    assert.ok(malformedInventory.files.some((f: any) => f.path === `${native}/report.json`));
    const path = (s: string) => join(base, native, s);
    for (const change of [
      (nodes: Map<string, any>) => nodes.delete(path("driver.close.json")),
      (nodes: Map<string, any>) => nodes.set(path("driver.stdout"), { kind: "file", bytes: Buffer.from(raw.slice(0, -1)) }),
      (nodes: Map<string, any>) => nodes.set(path("pilot-a"), { kind: "link" }),
      (nodes: Map<string, any>) => nodes.set(path("driver.stderr"), { kind: "file", size: 4194305, bytes: Buffer.alloc(0) }),
      (nodes: Map<string, any>) => nodes.set(join(base, "mac-a-other"), { kind: "dir" }),
    ]) assert.equal(run(change).review_candidate, false);
  });
  await t.test("synthetic complete journey is observational only, including shared inherited coalitions", () => {
    const r = pilot.evaluatePilotA(facts());
    assert.equal(r.status, "PASS_A");
    assert.equal(r.shared_resource_coalition, true);
    assert.equal(r.setsid_resource_stable, true);
    assert.equal(r.c1_accepted, false);
    assert.equal(r.exclusive_run_scope_proven, false);
    assert.equal(r.phase_b_admitted, false);
    const changed = facts();
    (changed.frames[10] as ReturnType<typeof observe>).coalition_ids = ["3", "4"];
    assert.equal(pilot.evaluatePilotA(changed).setsid_resource_stable, false, "observed counterexample is not erased or repaired");
  });
  await t.test("positive report needs captured births, exact waits, complete IO and fresh absence", () => {
    for (const patch of [{ absent: [101, 102, 103, 104] }, { close: null }, { close: { code: null, signal: "SIGKILL" } }, { close: { code: 137, signal: null } }, { rawComplete: false }, { timedOut: true }, { faults: [{ code: "EPERM" }] }]) {
      assert.equal(pilot.evaluatePilotA({ ...facts(), ...patch }).status, "INCONCLUSIVE");
    }
    for (const mutate of [
      (f: any) => f.frames.splice(12, 1),
      (f: any) => f.frames.push(f.frames[2]),
      (f: any) => { f.frames[8].pid = 999; },
      (f: any) => { f.frames[10].groups = [2, 9, 9]; },
      (f: any) => { f.frames[10].uniqueid = unique.A; },
      (f: any) => { f.frames[4].parent_uniqueid = "1"; },
      (f: any) => { [f.frames[12], f.frames[13]] = [f.frames[13], f.frames[12]]; },
    ]) {
      const f = facts(); mutate(f);
      assert.equal(pilot.evaluatePilotA(f).status, "INCONCLUSIVE");
    }
    const unsupported = facts();
    unsupported.frames = [unsupported.frames[0], { ...observe("D", "ready"), unique_return: 0, unique_errno: 1 }, { event: "end", pid: 101, io_ok: true, complete: false }];
    unsupported.close.code = 2;
    assert.equal(pilot.evaluatePilotA(unsupported).status, "NO_GO_PROFILE");
    assert.equal(pilot.evaluatePilotA({ ...unsupported, absent: [] }).status, "INCONCLUSIVE");
  });
  await t.test("absence uses only positive admitted PIDs, one probe each, preserving unknown/EPERM/reuse", () => {
    const calls: number[] = [];
    const r = pilot.observePilotAAbsence([101, 102, 103, 104, 105], (p: number) => {
      calls.push(p);
      if (p === 101) throw Object.assign(Error("gone"), { code: "ESRCH" });
      if (p === 102) throw Object.assign(Error("denied"), { code: "EPERM" });
      if (p === 103) throw undefined;
      if (p === 104) throw "opaque failure";
    });
    assert.deepEqual(calls, [101, 102, 103, 104, 105]);
    assert.deepEqual(r.map((p: { state: string }) => p.state), ["absent", "unknown", "unknown", "unknown", "present"]);
    assert.equal(r[1].cause.code, "EPERM");
    assert.equal(r[2].cause.type, "undefined");
    assert.equal(r[3].cause.value, "opaque failure");
    for (const invalid of [[0], [-1], [1.5], [101, 101], [], [1, 2, 3, 4, 5, 6]]) {
      assert.throws(() => pilot.observePilotAAbsence(invalid, () => { throw Error("must not probe"); }), /admission/);
    }
    assert.throws(() => pilot.observePilotAAbsence([101]), /admission/, "no implicit native probe port");
  });
  await t.test("release-gate decisions refuse bad identity/ABI before expanding fixture work", () => {
    const f = facts();
    for (const [length, stage, command] of [[2, 0, "S"], [6, 1, "E"], [10, 2, "O"], [12, 3, "R"], [17, 4, null]] as const) {
      assert.equal(pilot.nextPilotACommand(f.frames.slice(0, length), f.driver, stage).command, command);
    }
    for (const mutate of [
      (frames: any[]) => { frames[1].pid = 999; },
      (frames: any[]) => { frames[1].unique_return = 0; },
      (frames: any[]) => { frames[1].unique_reserved[0] = "1"; },
      (frames: any[]) => { frames[1].uid = 0; },
      (frames: any[]) => { frames[4].groups = [2, 9, 9]; },
      (frames: any[]) => { frames[4].parent_uniqueid = "2"; },
      (frames: any[]) => { frames[4].uniqueid = unique.D; },
      (frames: any[]) => { frames[10].uniqueid = "2"; },
    ]) {
      const bad = journey(); mutate(bad);
      const r = pilot.nextPilotACommand(bad, f.driver, 0);
      assert.equal(r.command, null); assert.ok(r.refused);
    }
  });
  const { EventEmitter } = await import("node:events");
  const mockCapture = (patch: Record<string, any> = {}) => {
    const child: any = new EventEmitter();
    child.pid = 101;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    const commands: string[] = [], closed: number[] = [], events: string[] = [];
    const files = new Map<number, Buffer[]>(), snapshots = new Map<string, any>();
    const timers = new Set<() => void>();
    let fd = 10, ends = 0, spawns = 0;
    child.stdin.end = () => { ends++; events.push("EOF"); };
    child.stdin.write = (s: string) => { commands.push(s); events.push(`gate:${s}`); return true; };
    const io = {
      openSync: () => { files.set(fd, []); return fd++; },
      closeSync: (f: number) => { closed.push(f); },
      writeSync: (f: number, b: Buffer, offset: number) => { files.get(f)!.push(Buffer.from(b.subarray(offset))); return b.length - offset; },
      persist: (path: string, value: any) => { events.push(`persist:${path}`); snapshots.set(path, structuredClone(value)); },
      spawn: () => { spawns++; events.push("spawn"); return child; },
      parentFrame: () => ({ parent_pid: 100, credentials: { uid: 501, euid: 501, gid: 20, egid: 20 } }),
      setTimeout: (cb: () => void, ms: number) => { assert.equal(ms, 180000); timers.add(cb); return cb; },
      clearTimeout: (cb: () => void) => { timers.delete(cb); },
      ...patch,
    };
    return { io, child, commands, closed, events, files, snapshots, timers, ends: () => ends, spawns: () => spawns };
  };
  const startCapture = (m: ReturnType<typeof mockCapture>, observer?: any, release?: () => void) =>
    pilot.capturePilotA(m.io, "synthetic-no-executable", [], {}, "memory", "driver", observer, release);
  const sendFrames = (m: ReturnType<typeof mockCapture>, frames: any[]) => m.child.stdout.emit("data", Buffer.from(frames.map(f => JSON.stringify(f)).join("\n") + "\n"));
  const errorWith = (code: string) => Object.assign(Error(`synthetic ${code}`), { code });
  await t.test("capture composition preserves raw bytes and waits for actual close, not exit/deadline", async () => {
    const m = mockCapture(), frames: any[] = [];
    let stage = 0;
    const run = startCapture(m, (frame: any, control: any) => {
      frames.push(frame);
      m.io.persist("memory/frames.json", frames);
      const next = pilot.nextPilotACommand(frames, control.birth, stage);
      assert.equal(next.refused, null);
      if (next.command && control.send(next.command)) stage = next.stage;
    });
    let done = false; void run.settled.then(() => { done = true; });
    sendFrames(m, journey());
    assert.deepEqual(m.commands, ["S", "E", "O", "R"]);
    const birthEvent = m.events.indexOf("persist:" + join("memory", "driver.birth.json"));
    assert.ok(birthEvent >= 0 && birthEvent < m.events.indexOf("gate:S"));
    m.child.emit("exit", 0, null); await Promise.resolve(); assert.equal(done, false);
    m.child.emit("close", 0, null);
    const receipt = await run.settled;
    assert.equal(receipt.rawComplete, true); assert.deepEqual(receipt.causes, []);
    assert.equal(Buffer.concat(m.files.get(10)!).toString(), journey().map(f => JSON.stringify(f)).join("\n") + "\n");
    assert.deepEqual(m.closed, [11, 10]); assert.equal(m.timers.size, 0);
    assert.equal(run.send("S"), false, "close never reopens admission");
    const delayed = mockCapture(), pending = startCapture(delayed, () => {});
    let settled = false; void pending.settled.then(() => { settled = true; });
    [...delayed.timers][0](); await Promise.resolve();
    assert.equal(settled, false); assert.equal(pending.send("S"), false);
    assert.equal(delayed.snapshots.get(join("memory", "driver.deadline.json")).status, "INCONCLUSIVE");
    delayed.child.emit("close", null, "SIGTERM");
    assert.equal((await pending.settled).timedOut, true); assert.equal(delayed.timers.size, 0);
  });
  await t.test("R1 both readable error paths latch admission, retain causes and still require close", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const m = mockCapture(), primary = errorWith("EIO"), secondary = errorWith("EPIPE");
      const run = startCapture(m, (_frame: any, control: any) => control.send("S"));
      let done = false; void run.settled.then(() => { done = true; });
      assert.doesNotThrow(() => m.child[stream].emit("error", primary));
      m.child.stdin.emit("error", secondary);
      sendFrames(m, [journey()[0]]);
      m.child.emit("exit", 0, null); await Promise.resolve();
      assert.equal(done, false); assert.deepEqual(m.commands, []); assert.equal(m.ends(), 1);
      m.child.emit("close", 0, null);
      const r = await run.settled;
      assert.equal(r.rawComplete, false); assert.deepEqual(r.causes, [primary, secondary]);
      assert.deepEqual(r.faults.map((f: { code: string }) => f.code), ["EIO", "EPIPE"]);
      assert.equal(pilot.evaluatePilotA({ ...facts(), ...r }).status, "INCONCLUSIVE");
      assert.equal(m.timers.size, 0);
    }
  });
  await t.test("R2 parent descriptor release failure cannot bypass settlement or open a later gate", async () => {
    for (const failure of [errorWith("EIO"), undefined, "opaque release failure"]) {
      const m = mockCapture(); let releases = 0;
      const run = startCapture(m, (_frame: any, control: any) => control.send("S"), () => { releases++; throw failure; });
      let done = false; void run.settled.then(() => { done = true; });
      sendFrames(m, [journey()[0], journey()[1]]); await Promise.resolve();
      assert.equal(done, false); assert.deepEqual(m.commands, []); assert.equal(releases, 1); assert.equal(m.ends(), 1);
      m.child.emit("close", 2, null);
      const r = await run.settled;
      assert.equal(r.causes.length, 1); assert.equal(r.causes[0], failure);
      assert.equal(pilot.evaluatePilotA({ ...facts(), ...r }).status, "INCONCLUSIVE");
      assert.equal(m.timers.size, 0);
    }
  });
  await t.test("N1 asynchronous EMFILE/ENFILE with nullable stdio retains an attempt, never a process birth/exit", async () => {
    for (const code of ["EMFILE", "ENFILE"]) for (const shape of ["null", "undefined", "mixed", "pipes"]) for (const observe of [false, true]) {
      const m = mockCapture(), primary = errorWith(code); let releases = 0, observations = 0;
      delete m.child.pid;
      const streams = { stdin: m.child.stdin, stdout: m.child.stdout, stderr: m.child.stderr };
      for (const [index, key] of ["stdin", "stdout", "stderr"].entries()) {
        const value = shape === "pipes" || (shape === "mixed" && index === 1) ? streams[key as keyof typeof streams] : shape === "null" ? null : undefined;
        Object.defineProperty(m.child, key, { configurable: true, get() {
          assert.ok(m.child.listenerCount("error") > 0, "own child error before reading optional stdio"); return value;
        } });
      }
      queueMicrotask(() => m.child.emit("error", primary));
      const run = startCapture(m, observe ? () => { observations++; } : undefined, () => { releases++; });
      let settled = false; void run.settled.then(() => { settled = true; });
      assert.equal(run.birth, null); assert.equal(Object.hasOwn(run.attempt, "pid"), false);
      assert.equal(run.send("S"), false); assert.equal(releases, 0);
      await Promise.resolve();
      assert.equal(settled, false); assert.equal(releases, 0);
      assert.equal(m.snapshots.get(join("memory", "driver.attempt.json")).faults[0].code, code);
      // Even a late PID or unbound exit event cannot reconstruct an original birth.
      m.child.pid = 202; m.child.emit("exit", 0, null);
      if (shape === "pipes" || shape === "mixed") streams.stdout.emit("data", Buffer.from(JSON.stringify(journey()[0]) + "\n"));
      assert.equal(observations, 0); assert.equal(m.snapshots.has(join("memory", "driver.exit.json")), false);
      m.child.emit("close", code === "EMFILE" ? -24 : -23, null);
      const receipt = await run.settled;
      assert.equal(receipt.birth, null); assert.equal(receipt.close, null);
      assert.deepEqual(receipt.handle_close, { code: code === "EMFILE" ? -24 : -23, signal: null }, "raw Node handle observation, not an OS exit code");
      assert.deepEqual(receipt.causes, [primary]); assert.equal(receipt.rawComplete, false);
      assert.equal(releases, 1); assert.deepEqual(m.closed, [11, 10]); assert.equal(m.timers.size, 0);
      assert.deepEqual(m.commands, []); assert.equal(run.send("E"), false);
      assert.equal(m.snapshots.has(join("memory", "driver.birth.json")), false);
      assert.equal(m.snapshots.has(join("memory", "driver.close.json")), false);
      assert.equal(m.snapshots.get(join("memory", "driver.attempt-close.json")).close, null);
      assert.equal(pilot.evaluatePilotA({ ...facts(), driver: receipt.birth, ...receipt }).status, "INCONCLUSIVE");
      m.child.emit("close", -24, null); assert.equal(releases, 1); assert.deepEqual(m.closed, [11, 10]);
    }
  });
  await t.test("N1 asynchronous provider error stays first across attempt persistence and every owned cleanup failure", async () => {
    for (const primary of [errorWith("EMFILE"), errorWith("ENFILE"), undefined, Object.freeze({ opaque: true })]) {
      const attemptWrite = errorWith("ENOSPC"), closeErr = errorWith("EIO"), closeOut = errorWith("EBADF"), parentError = undefined;
      const closed: number[] = []; let releases = 0;
      const m = mockCapture({ closeSync: (fd: number) => { closed.push(fd); throw fd === 11 ? closeErr : closeOut; } });
      Object.assign(m.child, { pid: undefined, stdin: null, stdout: null, stderr: null });
      const persist = m.io.persist;
      m.io.persist = (path: string, value: any) => { if (path.endsWith("driver.attempt.json")) throw attemptWrite; persist(path, value); };
      queueMicrotask(() => m.child.emit("error", primary));
      const run = startCapture(m, () => assert.fail("no producer"), () => { releases++; throw parentError; });
      await Promise.resolve();
      assert.deepEqual(closed, []); assert.equal(releases, 0);
      m.child.emit("close", -24, null);
      const receipt = await run.settled;
      assert.deepEqual(receipt.causes, [primary, attemptWrite, closeErr, closeOut, parentError]);
      assert.deepEqual(closed, [11, 10]); assert.equal(releases, 1); assert.equal(m.timers.size, 0);
      assert.equal(receipt.faults[1].code, "ENOSPC");
      assert.deepEqual(receipt.faults.slice(2, 4).map((f: { code: string }) => f.code), ["EIO", "EBADF"]);
      assert.equal(receipt.faults[4].type, "undefined");
      assert.equal(receipt.birth, null); assert.equal(receipt.close, null);
      assert.equal(m.snapshots.has(join("memory", "driver.birth.json")), false); assert.equal(m.snapshots.has(join("memory", "driver.exit.json")), false);
      assert.equal(run.send("R"), false);
    }
  });
  await t.test("R3 every early acquisition failure keeps exact originals and attempts all owned releases", () => {
    for (const primary of [errorWith("ENOSPC"), undefined, null, false, "opaque"] ) {
      const cleanup = [errorWith("EIO"), errorWith("EBADF"), undefined];
      const released: number[] = []; let releaseCalls = 0;
      const m = mockCapture({ spawn: () => { throw primary; }, closeSync: (fd: number) => { released.push(fd); throw cleanup[released.length - 1]; } });
      let observed: any;
      try { startCapture(m, () => {}, () => { releaseCalls++; throw cleanup[2]; }); assert.fail("must reject"); }
      catch (error) { observed = error; }
      assert.ok(observed instanceof AggregateError);
      assert.deepEqual(observed.errors, [primary, ...cleanup]);
      assert.deepEqual(released, [11, 10]); assert.equal(releaseCalls, 1); assert.equal(m.timers.size, 0);
    }
    const first = errorWith("ENOSPC"), second = errorWith("EIO"); let opens = 0;
    const m = mockCapture({ openSync: () => { if (++opens === 2) throw first; return 10; }, closeSync: () => { throw second; } });
    assert.throws(() => startCapture(m), (e: any) => e instanceof AggregateError && e.errors[0] === first && e.errors[1] === second);
    assert.equal(m.spawns(), 0);
    for (const stage of ["stdout", "stderr", "parent", "spawn"]) {
      let calls = 0, releases = 0;
      const error = { stage };
      const patch: Record<string, any> = stage === "parent" ? { parentFrame: () => { throw error; } } : stage === "spawn" ? { spawn: () => { throw error; } } : { openSync: () => { if (++calls === (stage === "stdout" ? 1 : 2)) throw error; return 10; } };
      const f = mockCapture(patch);
      assert.throws(() => startCapture(f, undefined, () => { releases++; }), (e: unknown) => e === error);
      assert.equal(releases, 1); assert.equal(f.timers.size, 0);
    }
  });
  await t.test("capture failure latching covers persistence, partial writes and failed gate requests without replay", async () => {
    for (const boundary of ["birth", "raw", "frames", "exit", "close", "send"]) {
      const primary = errorWith("ENOSPC"), m = mockCapture();
      const originalPersist = m.io.persist;
      m.io.persist = (path: string, value: any) => {
        if ((boundary === "frames" && path.endsWith("frames.json")) || path.endsWith(`driver.${boundary}.json`)) throw primary;
        originalPersist(path, value);
      };
      if (boundary === "raw") m.io.writeSync = () => { throw primary; };
      if (boundary === "send") m.child.stdin.write = (s: string) => { m.commands.push(s); throw primary; };
      const run = startCapture(m, (_frame: any, control: any) => { m.io.persist("memory/frames.json", {}); control.send("S"); });
      sendFrames(m, [journey()[0]]);
      if (boundary === "exit") m.child.emit("exit", 0, null);
      if (boundary !== "close") {
        assert.equal(run.send("E"), false); assert.deepEqual(m.commands, ["send", "exit"].includes(boundary) ? ["S"] : []);
      }
      m.child.emit("close", 0, null);
      const r = await run.settled;
      assert.equal(r.causes[0], primary); assert.equal(run.send("S"), false);
      assert.equal(pilot.evaluatePilotA({ ...facts(), ...r }).status, "INCONCLUSIVE"); assert.equal(m.timers.size, 0);
    }
    for (const stopAfterPrefix of [false, true]) {
      const m = mockCapture(), failure = errorWith("EIO"); let writes = 0;
      m.io.writeSync = (fd: number, b: Buffer, offset: number) => {
        if (stopAfterPrefix && writes++) throw failure;
        const size = Math.min(3, b.length - offset);
        m.files.get(fd)!.push(Buffer.from(b.subarray(offset, offset + size))); return size;
      };
      const raw = Buffer.from(JSON.stringify(journey()[0]) + "\n");
      const run = startCapture(m, (_frame: any, control: any) => control.send("S"));
      m.child.stdout.emit("data", raw); m.child.emit("close", 0, null);
      const r = await run.settled;
      assert.deepEqual(Buffer.concat(m.files.get(10)!), stopAfterPrefix ? raw.subarray(0, 3) : raw);
      assert.equal(r.rawComplete, !stopAfterPrefix);
      assert.deepEqual(m.commands, stopAfterPrefix ? [] : ["S"]);
      assert.deepEqual(r.causes, stopAfterPrefix ? [failure] : []);
    }
    const timerError = errorWith("ETIMER"), timerMock = mockCapture({ setTimeout: () => { throw timerError; } });
    const timerRun = startCapture(timerMock, () => {});
    assert.equal(timerRun.send("S"), false); timerMock.child.emit("close", 2, null);
    assert.deepEqual((await timerRun.settled).causes, [timerError]);
    const primary = errorWith("EIO"), secondary = errorWith("EPIPE"), m = mockCapture();
    m.child.stdin.end = () => { throw secondary; };
    const run = startCapture(m, () => {});
    run.fail(primary); m.child.emit("close", 2, null);
    assert.deepEqual((await run.settled).causes, [primary, secondary]);
    const f = mockCapture(); let didRead = false;
    const opaque = Object.defineProperty({}, "message", { get() { didRead = true; throw Error("getter"); } });
    const p = startCapture(f, () => {}); p.fail(new AggregateError([primary, opaque, undefined], "ordered")); f.child.emit("close", 2, null);
    const receipt = await p.settled;
    assert.deepEqual(receipt.faults[0].causes, [{ code: "EIO", message: primary.message }, {}, { type: "undefined", value: undefined }]);
    assert.equal(didRead, false);
    const summaryError = errorWith("ESUMMARY"), descriptorFailure = new Proxy({}, { getOwnPropertyDescriptor() { throw summaryError; } });
    const s = mockCapture(), summaryRun = startCapture(s, () => {});
    summaryRun.fail(descriptorFailure); assert.equal(summaryRun.send("S"), false);
    s.child.emit("close", 2, null);
    const summaryReceipt = await summaryRun.settled;
    assert.deepEqual(summaryReceipt.causes, [descriptorFailure, summaryError]);
    assert.equal(summaryReceipt.faults[0].type, "fault-summary-unavailable");
  });
  await t.test("R4 stderr transport diagnostics retain first errno and partial progress independently of stdout", async () => {
    // Synthetic wire checks only: this does NOT execute the C emitter or Darwin.
    const first = { event: "transport_fault", role: "D", pid: 101, stage: "write", error: 5, written: 17, requested: 240, first_stage: "write", first_error: 5, first_written: 17, first_requested: 240 };
    const later = { ...first, stage: "unlock", error: 9 };
    for (const record of [first, later]) assert.deepEqual(pilot.parsePilotATransportFault(JSON.stringify(record)), record);
    for (const patch of [{ written: 241 }, { error: -1 }, { first_error: 9 }, { stage: "unknown" }, { first_requested: 16 }]) assert.throws(() => pilot.parsePilotATransportFault(JSON.stringify({ ...first, ...patch })));
    const m = mockCapture(), primary = errorWith("EIO");
    const r = startCapture(m, () => {});
    m.child.stdout.emit("error", primary);
    const raw = Buffer.from([first, later].map(f => JSON.stringify(f)).join("\n") + "\n");
    m.child.stderr.emit("data", raw.subarray(0, 7)); m.child.stderr.emit("data", raw.subarray(7));
    m.child.emit("close", 2, null);
    assert.equal((await r.settled).causes[0], primary);
    assert.deepEqual(Buffer.concat(m.files.get(11)!), raw);
    const c = await readFile(new URL("./fixtures/macos-spi-transport.h", import.meta.url), "utf8");
    assert.match(c, /if \(!first_transport\.stage\) first_transport =/);
    assert.match(c, /int write_error = errno;/);
    assert.match(c, /int lock_error = errno;/);
    assert.match(c, /write\(STDERR_FILENO, data/);
    assert.match(c, /errno = error;/);
    assert.match(c, /if \(!io_ok\) return false;/);
    const driver = await readFile(new URL("./fixtures/macos-spi-pilot.c", import.meta.url), "utf8");
    assert.match(driver, /err_flags \| O_NONBLOCK/);
  });
  await t.test("research fixture remains opt-in, non-packaged, signal-free and isolated from runtime owners", async () => {
    const driver = await readFile(new URL("./fixtures/macos-spi-pilot.c", import.meta.url), "utf8");
    const core = await readFile(new URL("./fixtures/macos-spi-transport.h", import.meta.url), "utf8");
    const unit = await readFile(new URL("./fixtures/macos-spi-transport-unit.c", import.meta.url), "utf8");
    const c = `${driver}\n${core}`;
    const js = await readFile(new URL("./fixtures/macos-spi-pilot.mjs", import.meta.url), "utf8");
    for (const consumer of [driver, unit]) assert.match(consumer, /#include "macos-spi-transport\.h"/);
    assert.doesNotMatch(driver, /static bool emit\(/, "one shared implementation, not a copied transport");
    assert.doesNotMatch(unit, /\b(?:fork|proc_pidinfo)\s*\(|#include.*(?:libproc|macos-spi-pilot\.c)/);
    for (const syscall of ["fcntl", "write", "clock_gettime", "poll", "getpid"]) {
      assert.ok(unit.includes(`#define ${syscall} fake_${syscall}`));
      assert.ok(unit.includes(`#undef ${syscall}`));
    }
    assert.doesNotMatch(c, /\b(?:kill|setuid|seteuid|setgid|setegid|setgroups|coalition_create|coalition_terminate|coalition_reap|execve)\s*\(/);
    assert.doesNotMatch(js, /(?:\.unref|process\.exit)\s*\(/);
    assert.deepEqual(js.match(/process\.kill\([^)]*\)/g), ["process.kill(p, 0)"]);
    assert.doesNotMatch(js, /from ["'].*(?:\/lib\/|pi-coding-agent)/);
    assert.match(js, /GITHUB_EVENT_NAME !== "workflow_dispatch".*return blocked\("Native ordinary-user manual CI execution only"\)/);
    assert.match(js, /--execute-readonly-pilot-a/);
    assert.match(c, /F_SETLK/);
    assert.match(c, /offsetof\(struct pilot_unique, reserved\) == 40/);
    assert.match(c, /PRIu64/);
    assert.match(js, /frames\.json/);
    const workflow = await readFile(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
    assert.doesNotMatch(workflow, /macos-spi-pilot/);
  });
});

test("portable C transport unit (simulated syscalls, never PASS_A)", {
  skip: process.env.PI_ACTORS_C_TRANSPORT_UNIT === undefined ? "Opt-in: PI_ACTORS_C_TRANSPORT_UNIT=1; no compiler required by normal validation" : false,
}, async (t) => {
  assert.equal(process.env.PI_ACTORS_C_TRANSPORT_UNIT, "1", "BLOCKED: explicit portable C-unit admission must be exactly 1");
  assert.equal(process.platform, "linux", "BLOCKED: first C-unit host is Linux; this is not a product OS support policy");
  const pilot = await import(new URL("./fixtures/macos-spi-pilot.mjs", import.meta.url).href);
  const base = "/tmp/pi-actors-validation";
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "ct-")); // retain every root; no cleanup of unproven producers
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: root, TMPDIR: root, XDG_CACHE_HOME: root };
  const io = {
    spawn, openSync, closeSync, writeSync, setTimeout, clearTimeout,
    persist: (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }),
    parentFrame: () => ({ parent_pid: process.pid, credentials: { uid: process.getuid!(), euid: process.geteuid!(), gid: process.getgid!(), egid: process.getegid!() } }),
  };
  const command = async (name: string, executable: string, args: string[]) => {
    const receipt = await pilot.capturePilotA(io, executable, args, { env, cwd: root }, root, name).settled;
    if (receipt.causes.length) {
      const cause = receipt.causes.length === 1 ? receipt.causes[0] : new AggregateError(receipt.causes, "C-unit command and cleanup failed");
      throw new Error(`BLOCKED: C-unit command ${name} unavailable/incomplete; retained ${root}`, { cause });
    }
    assert.ok(receipt.birth && receipt.close && receipt.close.code === 0 && receipt.close.signal === null && receipt.rawComplete && !receipt.timedOut,
      `C-unit command ${name} failed; retained ${root}; stderr: ${await readFile(join(root, `${name}.stderr`), "utf8")}`);
    return readFile(join(root, `${name}.stdout`), "utf8");
  };
  const compiler = process.env.PI_ACTORS_C_TRANSPORT_CC ?? "cc"; // one executable, never shell-split flags/downloads
  const source = fileURLToPath(new URL("./fixtures/macos-spi-transport-unit.c", import.meta.url));
  const core = fileURLToPath(new URL("./fixtures/macos-spi-transport.h", import.meta.url));
  const binary = join(root, "transport-unit");
  const sourceBytes = await readFile(source), coreBytes = await readFile(core);
  const snapshot = join(root, "macos-spi-transport-unit.c"), snapshotCore = join(root, "macos-spi-transport.h");
  await writeFile(snapshot, sourceBytes); await writeFile(snapshotCore, coreBytes);
  await command("compile", compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", snapshot, "-o", binary]);
  assert.deepEqual(await readFile(snapshot), sourceBytes); assert.deepEqual(await readFile(snapshotCore), coreBytes);
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  await writeFile(join(root, "unit-inputs.json"), JSON.stringify({ evidence_mode: "simulated_syscalls", compiler, source_sha256: sha(sourceBytes), core_sha256: sha(coreBytes), binary_sha256: sha(await readFile(binary)), native_witness: false }, null, 2) + "\n");
  const output = await command("unit", binary, []);
  const rows: any[] = output.trim().split("\n").map(line => JSON.parse(line));
  const names = ["full", "short-success", "write-retry", "lock-retry", "lock-hard", "lock-budget", "write-budget", "write-unlock", "zero-write", "clock-initial", "clock-after-write", "clock-after-lock", "unlock-only", "stderr-eagain", "stderr-epipe", "stderr-eintr", "stderr-short", "stderr-unavailable", "format-overflow"];
  assert.deepEqual(rows.map(r => r.case), names);
  const decode = (s: string) => { assert.match(s, /^(?:[a-f0-9]{2})*$/); return Buffer.from(s, "hex"); };
  for (const row of rows) {
    assert.equal(row.evidence_mode, "simulated_syscalls"); assert.equal(row.ok, true, row.case);
    assert.equal(row.result, row.transport_ok);
    for (const [op, field] of [["stdout", "stdout_hex"], ["stderr", "stderr_hex"]]) {
      const calls = row.calls.filter((c: any) => c.op === op);
      assert.deepEqual(Buffer.concat(calls.map((c: any) => decode(c.delivered_hex))), decode(row[field]));
      for (const call of calls) {
        const requested = decode(call.requested_hex), delivered = decode(call.delivered_hex);
        assert.deepEqual(delivered, requested.subarray(0, Math.max(0, call.result)));
        assert.equal(delivered.length, Math.max(0, call.result));
        if (op !== "stderr") continue;
        // Producer formatting is checked from actual C bytes. Only full accepted
        // writes are also decoded as delivered records; attempts are not delivery.
        const intended = pilot.parsePilotATransportFault(requested.toString("utf8").slice(0, -1));
        assert.equal(intended.pid, 424242, "shim PID only; never a process probe target");
        assert.equal(intended.role, "D");
        assert.deepEqual({ stage: intended.first_stage, error: intended.first_error, written: intended.first_written, requested: intended.first_requested }, row.first);
        const ordinal = calls.indexOf(call);
        const stage = row.case.startsWith("clock-after-") ? "clock" : "unlock";
        const origin = row.calls.slice(0, row.calls.indexOf(call)).filter((c: any) => c.op === stage && c.result < 0).at(-1);
        const current = ordinal === 0 ? row.first : { stage, error: origin.errno, written: decode(row.stdout_hex).length, requested: row.first.requested };
        assert.deepEqual({ stage: intended.stage, error: intended.error, written: intended.written, requested: intended.requested }, current, "secondary clock/unlock errno must survive diagnostic side effects too");
        if (call.result === requested.length) assert.deepEqual(pilot.parsePilotATransportFault(delivered.toString("utf8").slice(0, -1)), intended);
      }
    }
    for (const call of row.calls) {
      if (call.op === "lock" || call.op === "unlock") assert.deepEqual([call.fd, call.start, call.length], [3, 0, 1]);
      if (call.op === "poll") assert.deepEqual([call.nfds, call.timeout, call.null_fds], [0, 10, true]);
    }
    if (row.case === "lock-budget" || row.case === "write-budget") assert.deepEqual(row.calls.filter((c: any) => c.op === "clock").map((c: any) => c.clock_ms), [0, 30000]);
    const unlocks = row.calls.filter((c: any) => c.op === "unlock");
    const acquired = row.calls.some((c: any) => c.op === "lock" && c.result === 0);
    assert.equal(unlocks.length, acquired ? 1 : 0, row.case);
    if (row.case.startsWith("stderr-") || row.case === "write-unlock") assert.equal(unlocks[0].entered_errno, row.first.error, "stderr/getpid errno must not replace primary write errno");
  }
  const partial = rows.find(r => r.case === "stderr-short");
  assert.throws(() => JSON.parse(decode(partial.stderr_hex).toString("utf8")), "partial diagnostic prefix is not repaired into complete delivery");
  assert.equal(rows.find(r => r.case === "stderr-unavailable").stderr_hex, "");
  t.diagnostic(`19 executed shared C-core cases with simulated syscalls; no driver/Darwin API; retained ${root}`);
});

test("package metadata exposes only Pi-supported compiled resources", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./dist/pi-actors/index.js"]);
  assert.deepEqual(pkg.pi.skills, ["./dist/skills"]);
  assert.equal("sourceExtensions" in pkg.pi, false);
  assert.equal("sourceSkills" in pkg.pi, false);
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-coding-agent": ">=1.0.0",
    "@earendil-works/pi-tui": ">=1.0.0",
  });
  await access(join(process.cwd(), pkg.pi.extensions[0]));
  await access(join(process.cwd(), "index.ts"));
});

test("build output mirrors JS runtime assets under dist", async () => {
  for (const dir of ["scripts", "fixtures", "skills"] as const) {
    const sourceEntries = await readdir(join(process.cwd(), dir));
    const distEntries = await readdir(join(process.cwd(), "dist", dir));
    assert.deepEqual(distEntries.sort(), sourceEntries.sort(), `dist/${dir} should mirror ${dir}`);
  }
  assert.equal(
    await readFile(join(process.cwd(), "dist", "pi-actors", "index.js"), "utf8"),
    'export { default } from "../index.js";\n',
  );
  await access(join(process.cwd(), "dist", "scripts", "async-runner.mjs"));
  await access(join(process.cwd(), "dist", "scripts", "build-dist.mjs"));
  await access(join(process.cwd(), "dist", "skills", "actors", "recipes", "recipe-validate.json"));
  await access(join(process.cwd(), "dist", "skills", "actors", "scripts", "validate-recipe.mjs"));
  await access(join(process.cwd(), "dist", "fixtures", "protocol", "control-record.json"));
  await access(join(process.cwd(), "dist", "fixtures", "protocol", "trace-event.json"));
  for (const skill of ["actors", "artifacts", "music-player", "project-work", "recipe-memory", "swarm"]) {
    await access(join(process.cwd(), "dist", "skills", skill, "SKILL.md"));
  }
});

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(() => access(path), /ENOENT/);
}

test("dist package contract excludes stale renamed files and source runtime imports", async () => {
  await assertMissing(join(process.cwd(), "dist", "index.ts"));
  for (const staleLib of [
    "actor-inspector-tui",
    "actor-messages",
    "actor-recipe-context",
    "actor-rooms",
    "actor-tools",
    "actor-worker",
    "async-runner",
    "coordinator",
    "locker",
    "mailbox-worker",
    "output",
    "recipe-context",
    "recipe-discovery",
    "recipe-references",
    "recipe-usage",
    "recipe-utils",
    "run-executor",
    "validate-recipe",
  ]) {
    await assertMissing(join(process.cwd(), "dist", "lib", `${staleLib}.js`));
    await assertMissing(join(process.cwd(), "dist", "lib", `${staleLib}.d.ts`));
  }
  for (const script of await readdir(join(process.cwd(), "dist", "scripts"))) {
    if (!script.endsWith(".mjs")) continue;
    const text = await readFile(join(process.cwd(), "dist", "scripts", script), "utf8");
    assert.doesNotMatch(text, /\.\.\/lib\/.*\.ts/);
    assert.doesNotMatch(text, /node_modules.*\.ts/);
  }
});

test("installed dist runtime reports exact package identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-identity-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
       import(pathToFileURL(join(packageDir, "dist", "lib", "tools-inspect.js")).href).then(async (mod) => {
         const tool = mod.createInspectToolDefinition();
         const result = await tool.execute("status", { target: "runtime", view: "status", verbose: true }, undefined, undefined, {});
         if (result.details.version !== pkg.version) process.exitCode = 2;
         if (result.details.state_schema !== "run-kernel-v1") process.exitCode = 3;
         console.log(JSON.stringify({ version: result.details.version, state_schema: result.details.state_schema }));
       }).catch((error) => { console.error(error); process.exitCode = 1; });`,
      packageDir,
    ]);
    assert.equal(stderr, "");
    const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    assert.deepEqual(JSON.parse(stdout), {
      version: pkg.version,
      state_schema: "run-kernel-v1",
    });
  } finally {
    await removeTreeEventually(root);
  }
});

test("installed dist resolves active-Skill and explicit file Recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-skill-recipes-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const skillDir = join(root, "skill");
    const recipeDir = join(skillDir, "recipes");
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill\n");
    await writeFile(
      join(recipeDir, "task.json"),
      JSON.stringify({ template: "echo {skill_dir}" }),
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const skillDir = process.argv[2];
       import(pathToFileURL(join(packageDir, "dist", "lib", "recipes-references.js")).href).then((mod) => {
         const skillContext = mod.createActiveSkillRecipeContext([{ name: "sample", baseDir: skillDir }]);
         const skillPath = mod.resolveRecipeReferencePath("sample/task", process.cwd(), skillContext);
         const skill = mod.readResolvedRecipeConfig(skillPath, [], { skillContext });
         const file = mod.readResolvedRecipeConfig(mod.resolveRecipeReferencePath(join(packageDir, "skills", "project-work", "recipes", "package-summary.json")));
         const context = mod.buildRecipeContextRecords(join(skillDir, "recipes", "task.json"), skillContext);
         console.log(JSON.stringify({
           skill_dir: skill.skill_dir,
           skill_template: skill.template,
           file_ok: JSON.stringify(file.template).includes("project-utils.mjs"),
           logical_reference: context[0].logical_reference,
         source_kind: context[0].source_kind,
         }));
       }).catch((error) => { console.error(error); process.exitCode = 1; });`,
      packageDir,
      skillDir,
    ]);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.skill_dir, skillDir);
    assert.match(JSON.stringify(result.skill_template), /skill/);
    assert.equal(result.file_ok, true);
    assert.equal(result.logical_reference, "sample/task");
    assert.equal(result.source_kind, "active_skill_component");
  } finally {
    await removeTreeEventually(root);
  }
});

test("installed dist resolves every representative capability pack by qualified identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-capabilities-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const identities = [
      "project-work/repo-health",
      "project-work/release-readiness",
      "swarm/quorum-review",
      "artifacts/bundle",
      "music-player/playback",
      "recipe-memory/draft-review",
    ];
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const identities = JSON.parse(process.argv[2]);
       import(pathToFileURL(join(packageDir, "dist", "lib", "recipes-references.js")).href).then((mod) => {
         const skillContext = mod.createActiveSkillRecipeContext(
           ["actors", "artifacts", "music-player", "project-work", "recipe-memory", "swarm"]
             .map((name) => ({ name, baseDir: join(packageDir, "skills", name) })),
         );
         const resolved = identities.map((identity) => {
           const file = mod.resolveRecipeReferencePath(identity, process.cwd(), skillContext);
           const config = mod.readResolvedRecipeConfig(file, [], { skillContext });
           const context = mod.buildRecipeContextRecords(file, skillContext);
           return { identity, ok: Boolean(config?.template), logical: context[0].logical_reference, source: context[0].source_kind };
         });
         console.log(JSON.stringify(resolved));
       }).catch((error) => { console.error(error); process.exitCode = 1; });`,
      packageDir,
      JSON.stringify(identities),
    ]);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), identities.map((identity) => ({
      identity,
      ok: true,
      logical: identity,
      source: "active_skill_component",
    })));
  } finally {
    await removeTreeEventually(root);
  }
});

test("packed artifact first session preserves agent-native Skill and tool parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-packed-artifact-"));
  try {
    const packageDir = await preparePackedPackage(root);
    const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    assert.equal(
      await readFile(join(packageDir, "docs", "capability-memory.md"), "utf8"),
      await readFile("docs/capability-memory.md", "utf8"),
    );
    const agentDir = join(root, "agent");
    const homeDir = join(root, "home");
    const staleSkillDir = join(root, "stale-skill");
    const sourceDir = join(root, "music");
    await mkdir(agentDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    assert.deepEqual(await readdir(agentDir), []);
    const retainedRoot = join(agentDir, "recipes", "library");
    await mkdir(retainedRoot, { recursive: true });
    for (const [name, async] of [["retained_sync", false], ["retained_async", true]] as const) {
      await writeFile(join(retainedRoot, name + ".json"), JSON.stringify({ async, template: "printf retained-pong" }));
    }
    await mkdir(join(staleSkillDir, "recipes"), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "track.wav"), "audio fixture");
    const fakeFfplay = join(sourceDir, process.platform === "win32" ? "ffplay.cmd" : "ffplay");
    await writeFile(
      fakeFfplay,
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    if (process.platform !== "win32") await chmod(fakeFfplay, 0o755);
    await writeFile(join(staleSkillDir, "SKILL.md"), "---\nname: stale\n---\n");
    await writeFile(join(staleSkillDir, "recipes", "broken.json"), JSON.stringify({
      name: "removed-identity",
      template: "echo broken",
    }));
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const staleSkillDir = process.argv[2];
       const sourceDir = process.argv[3];
       import(pathToFileURL(join(packageDir, "dist", "pi-actors", "index.js")).href).then(async (mod) => {
         const tools = [];
         const definitions = new Map();
         let activeTools = [];
         const commands = [];
         const handlers = new Map();
         const pi = {
           getActiveTools: () => [...activeTools],
           getAllTools: () => [...definitions.values()],
           getThinkingLevel: () => "off",
           on: (name, handler) => handlers.set(name, handler),
           registerCommand: (name) => commands.push(name),
           registerMessageRenderer: () => {},
           registerTool: (definition) => {
             definitions.set(definition.name, definition);
             activeTools = [...new Set([...activeTools, definition.name])];
             tools.push({
               name: definition.name,
               properties: Object.keys(definition.parameters.properties).sort(),
               required: definition.parameters.required,
             });
           },
           setActiveTools: (names) => {
             activeTools = names.filter((name) => definitions.has(name));
           },
         };
         mod.default(pi);
         const resourceHandler = handlers.get("resources_discover");
         const resources = resourceHandler ? await resourceHandler() : null;
         const context = {
           cwd: packageDir,
           sessionManager: { getSessionId: () => "packed-owner" },
         };
         const startup = await handlers.get("before_agent_start")({
           systemPrompt: "base",
           systemPromptOptions: {
             skills: [
               {
                 name: "actors",
                 filePath: join(packageDir, "dist", "skills", "actors", "SKILL.md"),
               },
               {
                 name: "music-player",
                 filePath: join(packageDir, "dist", "skills", "music-player", "SKILL.md"),
               },
               { name: "stale", filePath: join(staleSkillDir, "SKILL.md") },
             ],
           },
         }, context);
         const register = definitions.get("actors_tool_register");
         const registration = await register.execute("packed-register", {
           name: "packed_ping",
           description: "Return a packed integration marker.",
           template: "printf packed-pong",
         }, undefined, undefined, context);
         const packedPing = definitions.get("packed_ping");
         const invocation = await packedPing.execute(
           "packed-ping-call",
           {},
           undefined,
           undefined,
           context,
         );
         const retainedReceipts = [];
         for (const [name, async] of [["packed_retained_sync", false], ["packed_retained_async", true]]) {
           const saved = await register.execute("packed-retain", {
             name, async, expose: false, description: "Packed retained capability",
             template: JSON.stringify(process.execPath) + ' -p 42',
           }, undefined, undefined, context);
           if (definitions.has(name)) throw new Error("Retained creation exposed a host tool");
           retainedReceipts.push(saved.details);
         }
         const retainedPath = retainedReceipts[0].recipe;
         const retainedBefore = readFileSync(retainedPath, "utf8");
         const retainedExposure = await register.execute("packed-retained-expose", {
           name: "packed_retained_sync", from: retainedPath,
         }, undefined, undefined, context);
         const retainedCall = await definitions.get("packed_retained_sync").execute("packed-retained-call", {}, undefined, undefined, context);
         await register.execute("packed-retained-withdraw", { name: "packed_retained_sync", template: null }, undefined, undefined, context);
         const retained = { receipts: retainedReceipts, exposure: retainedExposure.details,
           launchKind: retainedCall.details.launch_kind, output: retainedCall.content[0].text,
           sourceIntact: readFileSync(retainedPath, "utf8") === retainedBefore,
           activeAfterWithdrawal: activeTools.includes("packed_retained_sync") };
         const spawn = definitions.get("spawn");
         const inspect = definitions.get("inspect");
         const message = definitions.get("message");
         const musicRegistration = await register.execute("packed-music-register", {
           defaults: { source: sourceDir, loop: false, player: "ffplay" },
           name: "music_player",
           description: "Control local music from the maintained Music Player Recipe.",
           from: "music-player/playback",
         }, undefined, undefined, context);
         const musicPlayer = definitions.get("music_player");
         const wrapperPath = join(process.env.PI_CODING_AGENT_DIR, "recipes", "music_player.json");
         const authoredWrapper = JSON.parse(readFileSync(wrapperPath, "utf8"));
         const waitForMusicTerminal = async () => {
           for (let attempt = 0; attempt < 200; attempt += 1) {
             const current = await inspect.execute("packed-music-terminal", {
               target: "run:music-player",
               view: "control",
               verbose: true,
             }, undefined, undefined, context);
             if (current.details.status !== "running") {
               let pid = 0;
               try {
                 const runState = JSON.parse(readFileSync(join(
                   process.env.PI_CODING_AGENT_DIR,
                   "tmp", "pi-actors", "runs", "music-player", "run.json",
                 ), "utf8"));
                 pid = Number(runState.pid || 0);
               } catch {}
               try {
                 if (pid > 0) process.kill(pid, 0);
                 else return;
               } catch {
                 return;
               }
             }
             await new Promise((resolve) => setTimeout(resolve, 25));
           }
           throw new Error("packed music player did not reach terminal state");
         };
         const mediaSpawn = await spawn.execute("packed-media-spawn", {
           recipe: "music-player/playback",
           values: { source: sourceDir, loop: false, player: "ffplay" },
         }, undefined, undefined, context);
         await waitForMusicTerminal();
         const wrapperSpawn = await spawn.execute("packed-wrapper-spawn", {
           file: wrapperPath,
           values: {},
         }, undefined, undefined, context);
         await waitForMusicTerminal();
         const musicInvocation = await musicPlayer.execute(
           "packed-music-call", {}, undefined, undefined, context,
         );
         const musicStatus = await inspect.execute("packed-music-status", {
           target: "tool:music_player",
           view: "status",
           verbose: true,
         }, undefined, undefined, context);
         const musicControl = await inspect.execute("packed-music-control", {
           target: "run:music-player",
           view: "control",
           verbose: true,
         }, undefined, undefined, context);
         const recipeStatus = await inspect.execute("packed-recipes-status", {
           target: "recipes",
           view: "status",
           verbose: true,
         }, undefined, undefined, context);
         const focusedDoctor = await inspect.execute("packed-recipes-doctor", {
           target: "recipes",
           view: "doctor",
           identity: "music-player/playback",
           verbose: true,
         }, undefined, undefined, context);
         let started;
         let control;
         let trace;
         try {
           started = await spawn.execute("packed-spawn", {
             as: "run:packed-locker",
             recipe: "actors/resource-locker",
             values: { lease_ms: 1000 },
           }, undefined, undefined, context);
           for (let attempt = 0; attempt < 200; attempt += 1) {
             control = await inspect.execute("packed-control", {
               target: "run:packed-locker",
               view: "control",
               verbose: true,
             }, undefined, undefined, context);
             if (control.details.endpoint) break;
             if (control.details.status !== "running") {
               let failure = "stderr unavailable";
               try {
                 failure = readFileSync(join(started.details.state_dir, "stderr.log"), "utf8").trim();
               } catch {}
               throw new Error("packed locker terminated before readiness: " + failure);
             }
             await new Promise((resolve) => setTimeout(resolve, 25));
           }
           if (!control?.details.endpoint) throw new Error("packed locker endpoint unavailable");
           trace = await inspect.execute("packed-trace", {
             target: "run:packed-locker", view: "trace", verbose: true,
           }, undefined, undefined, context);
           await message.execute("packed-stop", {
             target: "run:packed-locker",
             action: "stop",
             verbose: true,
           }, undefined, undefined, context);
           for (let attempt = 0; attempt < 200; attempt += 1) {
             control = await inspect.execute("packed-terminal", {
               target: "run:packed-locker",
               view: "control",
               verbose: true,
             }, undefined, undefined, context);
             if (control.details.status === "done") break;
             if (["failed", "cancelled", "killed"].includes(control.details.status)) {
               throw new Error("packed locker stopped as " + control.details.status);
             }
             await new Promise((resolve) => setTimeout(resolve, 25));
           }
         } finally {
           if (started && control?.details.status === "running") {
             await message.execute("packed-kill", {
               target: "run:packed-locker",
               action: "kill",
             }, undefined, undefined, context).catch(() => undefined);
           }
         }
         console.log(JSON.stringify({
           commands,
           packedRun: {
             controlPending: control.details.pending,
             endpoint: control.details.endpoint?.type,
             skillDir: started.details.values.skill_dir,
             status: control.details.status,
             traceComplete: trace.details.summary.history_complete,
           },
           registration: registration.details,
           invocation: invocation.content[0].text,
           retained,
           music: {
             actorActions: musicControl.details.actor_actions,
             authoredWrapper,
             directLaunchKind: mediaSpawn.details.launch_kind,
             invocationLaunchKind: musicInvocation.details.launch_kind,
             registration: musicRegistration.details,
             schemaProperties: Object.keys(musicPlayer.parameters.properties).sort(),
             status: musicStatus.details,
             wrapperLaunchKind: wrapperSpawn.details.launch_kind,
           },
           recipeCatalog: recipeStatus.details,
           focusedDoctor: focusedDoctor.details,
           lifecycleEvents: [...handlers.keys()].sort(),
           resources,
           systemPrompt: startup.systemPrompt,
           tools,
         }));
       }).catch((error) => { console.error(error); process.exit(1); });`,
      packageDir,
      staleSkillDir,
      sourceDir,
    ], {
      env: {
        ...process.env,
        HOME: homeDir,
        PI_CODING_AGENT_DIR: agentDir,
        PATH: `${sourceDir}${delimiter}${process.env.PATH ?? ""}`,
        USERPROFILE: homeDir,
      },
    });
    assert.equal(stderr, "");
    assert.equal(pkg.version, JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")).version);
    assert.deepEqual(pkg.pi.extensions, ["./dist/pi-actors/index.js"]);
    assert.deepEqual(pkg.pi.skills, ["./dist/skills"]);
    assert.deepEqual(pkg.peerDependencies, {
      "@earendil-works/pi-coding-agent": ">=1.0.0",
      "@earendil-works/pi-tui": ">=1.0.0",
    });
    const loaded = JSON.parse(stdout);
    assert.equal(loaded.lifecycleEvents.includes("agent_settled"), true);
    assert.equal(loaded.lifecycleEvents.includes("agent_end"), false);
    assert.match(loaded.systemPrompt, /^base\n\npi-actors Skill routing:/);
    assert.match(loaded.systemPrompt, /load and read the actors Skill/);
    assert.match(loaded.systemPrompt, /multiple actors or subagents.*swarm Skill/);
    assert.match(loaded.systemPrompt, /Skill Recipe distinct from a registered tool/);
    assert.match(loaded.systemPrompt, /Recipe spawn distinct from registered-tool invocation/);
    assert.match(loaded.systemPrompt, /persistence or registration as distinct from current callability/);
    assert.match(loaded.systemPrompt, /preserve the logical Recipe identity, stop, and follow actors diagnosis/);
    assert.match(loaded.systemPrompt, /never bypass.*copied contracts, helper paths, shell evaluation, or background-process workarounds/);
    assert.doesNotMatch(
      loaded.systemPrompt,
      /min_successful|accept_output|retire_when|trace\.jsonl|controls\.jsonl|run\.json|\b(?:380|512|1,?024|2,?048|4 MiB)\b/,
    );
    assert.deepEqual(loaded.commands, ["actor-inspector"]);
    assert.deepEqual(
      {
        active_tool: loaded.registration.active_tool,
        activation: loaded.registration.activation,
        callable_now: loaded.registration.callable_now,
        host_registered: loaded.registration.host_registered,
        persisted: loaded.registration.persisted,
        registry_active: loaded.registration.registry_active,
        resolved: loaded.registration.resolved,
        validated: loaded.registration.validated,
      },
      {
        active_tool: true,
        activation: "current_session",
        callable_now: true,
        host_registered: true,
        persisted: true,
        registry_active: true,
        resolved: true,
        validated: true,
      },
    );
    assert.match(loaded.invocation, /packed-pong/);
    for (const receipt of loaded.retained.receipts) {
      assert.equal(receipt.kind, "retained_recipe");
      assert.equal(receipt.activation, "not_requested");
      assert.equal(receipt.persisted, true);
      assert.equal(Object.hasOwn(receipt, "callable_now"), false);
    }
    assert.equal(loaded.retained.exposure.callable_now, true);
    assert.equal(loaded.retained.launchKind, "tool");
    assert.match(loaded.retained.output, /42/);
    assert.equal(loaded.retained.sourceIntact, true);
    assert.equal(loaded.retained.activeAfterWithdrawal, false);
    assert.deepEqual(
      {
        active_tool: loaded.music.registration.active_tool,
        activation: loaded.music.registration.activation,
        callable_now: loaded.music.registration.callable_now,
        host_registered: loaded.music.registration.host_registered,
        persisted: loaded.music.registration.persisted,
        registry_active: loaded.music.registration.registry_active,
        resolved: loaded.music.registration.resolved,
        validated: loaded.music.registration.validated,
      },
      {
        active_tool: true,
        activation: "current_session",
        callable_now: true,
        host_registered: true,
        persisted: true,
        registry_active: true,
        resolved: true,
        validated: true,
      },
    );
    assert.equal(loaded.music.registration.async, true);
    assert.equal(loaded.music.registration.source, "music-player/playback");
    assert.equal(loaded.music.registration.activation_boundary, "current_session");
    assert.deepEqual(loaded.music.registration.required_args, []);
    assert.deepEqual(loaded.music.registration.optional_args, [
      "source", "loop", "volume", "player", "transport_context",
    ]);
    assert.deepEqual(loaded.music.registration.next_actions, [
      "call tool music_player",
      "actors_inspect target=tool:music_player view=status",
    ]);
    assert.equal("config" in loaded.music.registration, false);
    assert.equal("template" in loaded.music.registration, false);
    assert.deepEqual(loaded.music.actorActions, [
      "play", "pause", "resume", "toggle", "next", "previous", "seek", "volume", "stop", "status",
    ]);
    assert.deepEqual(loaded.music.authoredWrapper, {
      description: "Control local music from the maintained Music Player Recipe.",
      defaults: { loop: false, player: "ffplay", source: sourceDir },
      template: "music-player/playback",
    });
    assert.deepEqual(loaded.music.schemaProperties, [
      "loop", "player", "source", "transport_context", "volume",
    ]);
    assert.equal(loaded.music.directLaunchKind, "spawn");
    assert.equal(loaded.music.wrapperLaunchKind, "spawn");
    assert.equal(loaded.music.invocationLaunchKind, "tool");
    assert.equal(loaded.music.status.callable_now, true);
    assert.equal(loaded.music.status.activation_boundary, "current_session");
    assert.equal(loaded.music.status.source, "music-player/playback");
    assert.equal(loaded.music.status.persisted, true);
    assert.equal(loaded.music.status.registry_active, true);
    assert.deepEqual(loaded.music.status.required_args, []);
    assert.deepEqual(loaded.music.status.optional_args, [
      "source", "loop", "volume", "player", "transport_context",
    ]);
    assert.deepEqual(loaded.music.status.next_actions, ["call tool music_player"]);
    assert.equal(loaded.music.status.launch_kind, "tool");
    assert.equal(loaded.music.status.spawn_calls, 1);
    assert.equal(loaded.music.status.tool_calls, 1);
    assert.equal(loaded.focusedDoctor.identity, "music-player/playback");
    assert.equal(loaded.focusedDoctor.skill_active, true);
    assert.equal(loaded.focusedDoctor.resolvable, true);
    assert.equal(loaded.focusedDoctor.catalog_partial, true);
    assert.equal(loaded.focusedDoctor.component_status, "available");
    assert.equal(loaded.focusedDoctor.source_location, "<active-skill:music-player>/playback.json");
    assert.equal(typeof loaded.focusedDoctor.resolution_generation, "string");
    assert.deepEqual(loaded.focusedDoctor.next_actions, [
      "actors_run_spawn recipe=music-player/playback",
      "actors_tool_register name=<tool-name> from=music-player/playback",
    ]);
    assert.equal(loaded.recipeCatalog.registry_generation, 1);
    assert.deepEqual(loaded.recipeCatalog.retained.map((row: Record<string, unknown>) => ({
      id: row.id, path: row.path, async: row.async, tool: row.tool, invalid: row.invalid, disabled: row.disabled,
    })), [
      { id: "packed_retained_async", path: join(retainedRoot, "packed_retained_async.json"), async: true, tool: false, invalid: false, disabled: false },
      { id: "packed_retained_sync", path: join(retainedRoot, "packed_retained_sync.json"), async: false, tool: false, invalid: false, disabled: false },
      { id: "retained_async", path: join(retainedRoot, "retained_async.json"), async: true, tool: false, invalid: false, disabled: false },
      { id: "retained_sync", path: join(retainedRoot, "retained_sync.json"), async: false, tool: false, invalid: false, disabled: false },
    ]);
    assert.deepEqual(loaded.recipeCatalog.retained_diagnostics, []);
    assert.equal(loaded.recipeCatalog.skill_recipe_catalog_partial, true);
    assert.equal(
      loaded.recipeCatalog.skill_recipe_components.some(
        (component: any) => component.identity === "music-player/playback",
      ),
      true,
    );
    assert.match(
      loaded.recipeCatalog.skill_recipe_component_diagnostics[0].error,
      /Recipe\.name was removed/,
    );
    assert.doesNotMatch(
      JSON.stringify(loaded.music.authoredWrapper),
      /skill_dir|state_dir|control|artifacts|bash -lc|risk\.shell|risk\.eval/,
    );
    assert.equal(loaded.packedRun.endpoint, process.platform === "win32" ? "named-pipe" : "fifo");
    assert.equal(
      await realpath(loaded.packedRun.skillDir),
      await realpath(join(packageDir, "dist", "skills", "actors")),
    );
    assert.equal(loaded.packedRun.status, "done");
    assert.equal(loaded.packedRun.traceComplete, true);
    assert.equal(loaded.packedRun.controlPending, 0);
    assert.equal(loaded.resources, null);
    assert.equal(loaded.lifecycleEvents.includes("resources_discover"), false);
    assert.deepEqual(loaded.tools.map((tool: any) => tool.name), [
      "actors_tool_register",
      "actors_run_spawn",
      "actors_control_apply",
      "actors_inspect",
      "register_tool",
      "spawn",
      "message",
      "inspect",
      "packed_ping",
      "packed_retained_sync",
      "music_player",
    ]);
    assert.deepEqual(loaded.tools.map((tool: any) => tool.properties), [
      ["args", "async", "defaults", "description", "draft", "expose", "from", "name", "template", "update"],
      ["artifacts", "as", "file", "recipe", "template", "transport_context", "values", "verbose"],
      ["action", "input", "target", "verbose"],
      ["identity", "lines", "source", "status", "target", "verbose", "view"],
      ["args", "async", "defaults", "description", "draft", "expose", "from", "name", "template", "update"],
      ["artifacts", "as", "file", "recipe", "template", "transport_context", "values", "verbose"],
      ["action", "input", "target", "verbose"],
      ["identity", "lines", "source", "status", "target", "verbose", "view"],
      [],
      [],
      ["loop", "player", "source", "transport_context", "volume"],
    ]);
    const expectedDescriptions: Record<string, string> = {
      actors: "Use for any non-trivial pi-actors operation, diagnosis, or development involving Recipes, persistent tools, Runs, spawn, message, inspect, Trace, Control, capability specialization, or activation.",
      artifacts: "Use when an actor workflow must write reusable files, reports, manifests, or bundles with deterministic paths and declared outputs.",
      "music-player": "Use for starting, resuming, inspecting, and controlling one persistent local music playback actor from caller-approved files, directories, URLs, or playlists.",
      "project-work": "Use for repository health inspection, project summaries, documentation maintenance, release-readiness evidence, or bounded run-operation reports.",
      "recipe-memory": "Use only for internal automatic Recipe-memory review, diagnosis, or recovery; do not use for normal Recipe creation, registration, or invocation.",
      swarm: "Use when work needs multiple actors or subagents for independent implementation, artifact generation, review, delegated audit, research, or coordinated decomposition and integration.",
    };
    for (const [skill, description] of Object.entries(expectedDescriptions)) {
      const body = await readFile(join(packageDir, "dist", "skills", skill, "SKILL.md"), "utf8");
      assert.match(body, new RegExp(`^---\\r?\\nname: ${skill}\\r?$`, "m"));
      assert.equal(body.match(/^description:\s*(.+)$/m)?.[1], description);
      assert.equal(body, await readFile(join("skills", skill, "SKILL.md"), "utf8"));
    }
    for (const reference of [
      "actors/references/diagnostics.md",
      "actors/references/persistent-tools.md",
      "actors/references/recipes.md",
      "actors/references/runs.md",
      "swarm/references/development-swarm.md",
      "swarm/references/review-swarms.md",
    ]) {
      assert.equal(
        await readFile(join(packageDir, "dist", "skills", reference), "utf8"),
        await readFile(join("skills", reference), "utf8"),
      );
    }
    await assert.rejects(access(join(packageDir, ".agents")));
    const sourcePlayer = JSON.parse(
      await readFile(join(process.cwd(), "skills", "music-player", "recipes", "playback.json"), "utf8"),
    );
    const expectedSchema = [
      ...sourcePlayer.args
        .map((arg: string) => arg.split(":", 1)[0])
        .filter((arg: string) => arg !== "state_dir"),
      "transport_context",
    ].sort();
    assert.deepEqual(loaded.music.schemaProperties, expectedSchema);
    assert.doesNotMatch(stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  } finally {
    await removeTreeEventually(root);
  }
});

test("installed dist enforces the same bounded Trace, Control, and inspect contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-bounds-"));
  try {
    const packageDir = await preparePackedPackage(root);
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", `
      const { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const { pathToFileURL } = require("node:url");
      const packageDir = process.argv[1];
      Promise.all(["limits", "runs-controls", "runs-trace", "tools-inspect", "observability"].map((name) =>
        import(pathToFileURL(join(packageDir, "dist", "lib", name + ".js")).href))).then(async ([limits, controls, trace, inspect, observability]) => {
        const stateDir = mkdtempSync(join(tmpdir(), "pi-actors-installed-kernel-"));
        const status = { control: ["pause"], ownerId: "owner-a", run: "installed",
          run_instance_id: "generation-a", state_dir: stateDir, status: "running" };
        for (let index = 0; index <= limits.TRACE_JOURNAL_MAX_EVENTS; index++)
          trace.appendRunTraceEvent(stateDir, { kind: "installed.pressure", data: { index } });
        const summary = trace.appendRunTraceEvent(stateDir, { kind: "installed.summary", summary: "a".repeat(999) + "😀tail" });
        const savedSummary = trace.readRunTraceEvents(stateDir).find(event => event.id === summary.id).summary;
        for (let index = 0; index < limits.RUN_CONTROL_PENDING_LIMIT; index++)
          controls.appendRunControlInStateDir(stateDir, { action: "pause", input: { index }, run_instance_id: "generation-a" });
        let reason;
        try { controls.appendRunControlInStateDir(stateDir, { action: "pause", run_instance_id: "generation-a" }); }
        catch (error) { reason = error.reason; }
        const tool = inspect.createInspectToolDefinition({ getRunStatus: () => status });
        const context = { sessionManager: { getSessionId: () => "owner-a" } };
        const traceView = await tool.execute("trace", { target: "run:installed", view: "trace", verbose: true }, undefined, undefined, context);
        const controlView = await tool.execute("control", { target: "run:installed", view: "control", verbose: true }, undefined, undefined, context);
        const sessionDir = join(stateDir, "sessions", "command-001"); mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(stateDir, "execution.json"), JSON.stringify({ commands: [{ id: "command-001", session_files: ["sessions/command-001/session.jsonl"] }] }));
        const sessionContent = [
          { type: "session", version: 3, id: "session" },
          { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Review" } },
          { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "token=HIDDEN_AGENT_SECRET " + "a".repeat(142) + "🌍z" } },
          { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "Review again" } },
          { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "q".repeat(3998) + "🌍tail" } },
        ].map(value => JSON.stringify(value)).join("\\n");
        writeFileSync(join(sessionDir, "session.jsonl"), sessionContent);
        const agentView = await tool.execute("agent-trace", { target: "run:installed", view: "trace", source: "agent", verbose: true }, undefined, undefined, context);
        const referencePaths = Array.from({ length: 16 }, (_, index) => "/tmp/steer-refs/item-" + index + "/" + Array(35).fill("β".repeat(30)).join("/") + "/result.log");
        const steer = observability.formatRunSteerMessage({ attention: "steer", id: "packed-checkpoint", kind: "checkpoint.blocked", level: "warning",
          run: "installed", runInstanceId: "generation-a", stateDir, ts: "2026-01-01T00:00:00.000Z", summary: "Approval required",
          data: { artifacts: Object.fromEntries(referencePaths.slice(0, 8).map((path, index) => [String(index), path])), run_files: referencePaths.slice(8) } });
        const ordinaryPaths = ["/owned/parent/../target", "relative path.log", ...Array.from({ length: 7 }, (_, index) => "/owned/file-" + index + ".log")];
        const attentionDeliveries = { notices: [], followups: [] };
        const attention = { id: "packed-notice", kind: "checkpoint.notice", level: "warning", run: "installed",
          stateDir, summary: "Notice", ts: "2026-01-01T00:00:00.000Z", data: { run_files: [...ordinaryPaths, ordinaryPaths[0], ""] } };
        observability.deliverRunAttentionNotifications([{ ...attention, attention: "notify" }, { ...attention, id: "packed-followup", attention: "followup" }], {
          notify: (text, level) => attentionDeliveries.notices.push({ text, level }), sendFollowUp: message => attentionDeliveries.followups.push(message) });
        const legacyPreviews = [4, 4000].map(length => observability.formatRunAttentionMessage({ ...attention,
          attention: "followup", body: "a".repeat(499) + "🌍" + "H".repeat(length), data: undefined }));
        console.log(JSON.stringify({ reason, summary: summary.summary, savedSummary, trace: traceView.details.summary, steer, referencePaths, ordinaryPaths, attentionDeliveries, legacyPreviews,
          agentRows: agentView.details.items, agentText: agentView.content, sessionUnchanged: readFileSync(join(sessionDir, "session.jsonl"), "utf8") === sessionContent, control: {
          available: controlView.details.available, backpressured: controlView.details.backpressured,
          pending: controlView.details.pending }, traceBytes: statSync(join(stateDir, "trace.jsonl")).size,
          controlBytes: statSync(join(stateDir, "controls.jsonl")).size }));
      }).catch((error) => { console.error(error); process.exit(1); });`, packageDir]);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.reason, "control_backpressure");
    assert.equal(result.summary, "a".repeat(999));
    assert.equal(result.savedSummary, result.summary);
    assert.equal(result.sessionUnchanged, true);
    assert.equal(result.agentRows.length, 2);
    const clipped = result.agentRows.find((item: any) => item.detail.assistantEntryId === "a1");
    assert.equal(clipped.summary, "token=[REDACTED] " + "a".repeat(142) + "… [omitted: 2 chars] from normalized retained turn; upstream [omitted: unknown]");
    assert.equal(Buffer.from(clipped.summary).toString("utf8"), clipped.summary);
    assert.equal(result.agentRows.find((item: any) => item.detail.assistantEntryId === "a2").summary,
      "Agent turn [omitted: unknown] (malformed retained text)");
    assert.match(JSON.stringify(result.agentText), /… \[omitted: 2 chars\] from normalized retained turn; upstream \[omitted: unknown\]/);
    assert.doesNotMatch(JSON.stringify(result), /HIDDEN_AGENT_SECRET/);
    function attentionView(text: string): { metadata: any; body?: string } {
      const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
      assert.ok(!text.startsWith("---\n") || end >= 0);
      const document = parseDocument(end < 0 ? text : text.slice(4, end), { uniqueKeys: true });
      assert.deepEqual(document.errors, []);
      const metadata = document.toJS();
      assert.ok(metadata && !Array.isArray(metadata) && typeof metadata === "object");
      return { metadata, ...(end < 0 ? {} : { body: text.slice(end + 5) }) };
    }
    assert.ok(Buffer.byteLength(result.steer) <= 16 * 1024);
    const steer = attentionView(result.steer);
    assert.equal(steer.body, undefined);
    assert.deepEqual(Object.keys(steer.metadata), ["run", "checkpoint", "artifacts", "run_files"]);
    assert.equal(steer.metadata.run, "installed");
    assert.equal(steer.metadata.checkpoint, "Approval required");
    let shownReferences = 0;
    for (const [label, offset] of [["artifacts", 0], ["run_files", 8]] as const) {
      const section = steer.metadata[label];
      assert.ok(Number.isInteger(section.shown) && section.shown >= 0 && section.shown <= 8);
      const paths = result.referencePaths.slice(offset, offset + section.shown);
      assert.deepEqual(section, { shown: paths.length, omitted: 8 - paths.length, total: 8,
        ...(paths.length ? { paths } : {}) });
      shownReferences += paths.length;
    }
    assert.ok(shownReferences > 0 && shownReferences < 16);
    assert.deepEqual(result.attentionDeliveries.notices.map((item: any) => item.level), ["warning", "warning"]);
    assert.equal(result.attentionDeliveries.followups.length, 1);
    const ordinaryFollowup = result.attentionDeliveries.followups[0];
    assert.equal(ordinaryFollowup.customType, "pi-actors-run-trace");
    assert.equal(ordinaryFollowup.display, false);
    assert.equal(ordinaryFollowup.content, result.attentionDeliveries.notices[1].text);
    assert.equal(result.attentionDeliveries.notices[0].text, ordinaryFollowup.content);
    assert.deepEqual(attentionView(ordinaryFollowup.content), { metadata: { run: "installed", checkpoint: "Notice",
      run_files: { shown: 8, omitted: 1, total: 9, paths: result.ordinaryPaths.slice(0, 8) } } });
    assert.match(ordinaryFollowup.details.stateDir, /pi-actors-installed-kernel-/);
    assert.deepEqual(ordinaryFollowup.details, { id: "packed-followup", kind: "checkpoint.notice", level: "warning",
      run: "installed", stateDir: ordinaryFollowup.details.stateDir, summary: "Notice", ts: "2026-01-01T00:00:00.000Z",
      data: { run_files: [...result.ordinaryPaths, result.ordinaryPaths[0], ""] }, attention: "followup" });
    assert.equal(result.legacyPreviews[0], result.legacyPreviews[1]);
    assert.deepEqual(attentionView(result.legacyPreviews[0]), { metadata: { run: "installed", checkpoint: "Notice",
      body_omission: "[omitted: unknown]", body_basis: "Legacy record; original completeness/privacy unproven.",
      body_upstream: "[omitted: unknown]" }, body: "a".repeat(499) + "…" });
    assert.ok(result.legacyPreviews[0].endsWith("\n---\n" + "a".repeat(499) + "…"));
    assert.equal(Buffer.from(result.legacyPreviews[0]).toString("utf8"), result.legacyPreviews[0]);
    assert.equal(result.trace.history_complete, false);
    assert.equal(result.trace.compacted, true);
    assert.equal(result.control.pending, 64);
    assert.equal(result.control.available, 0);
    assert.equal(result.control.backpressured, true);
    assert.ok(result.traceBytes <= 4 * 1024 * 1024);
    assert.ok(result.controlBytes <= 1024 * 1024);
    const { NODE_TEST_CONTEXT: _testContext, ...probeEnv } = process.env;
    await cp(join(process.cwd(), "tests", "test-environment.mjs"), join(root, "test-environment.mjs"));
    for (const [owner, pattern, passes] of [
      ["run-ui-runtime", ".*", process.platform === "win32" ? 51 : 55],
      ["observability", ".*", 56],
      ["runs-control-delivery", "Control delivery retains exact transport|Admitted Control failures preserve|Unix FIFO path accepts|A handled Control remains", process.platform === "win32" ? 3 : 4],
      ["runs-retention", "Manual retirement preserves exact failures|Retirement chains recording", 2],
      ["async-runs", "Awaited Control facade preserves", process.platform === "linux" ? 1 : 0],
      ["file-state", "Locked file mutation preserves|Atomic replacement preserves", 2],
      ["tools-message", ".*", process.platform === "linux" ? 17 : 16],
      ["tools-spawn", ".*", 2],
      ["tools-local", ".*", 5],
      ["registry", ".*", 66],
      ["runtime", ".*", process.platform === "win32" || process.platform === "darwin" ? 12 : 13],
      ["tools-response", ".*", 28],
      ["tools-inspect", ".*", 24],
      ["run-delivery", ".*", 95],
      ["execution", "^Final response selection", 1],
      ["recipes-context", "^Pi response selection|^Pi Node CLI", 2],
      ["runs-context-exports", "^Final executor responses|^Completion text selects", 2],
      ["pi", ".*", 8],
      ["runs-process-windows-mi", ".*", 13],
      ["runs-controls", "^Run Control journal distinguishes empty regular files from zero-sized nonregular descriptors$", 1],
      ["inspector-overlay", ".*", 49],
      ["trace-projection", ".*", 17],
      ["session-evidence", "Session chronology retains only bounded", 1],
      ["execution-sessions", "Execution chronology joins pre-tail", 1],
      ["inspector", ".*", process.platform === "win32" ? 15 : 16],
    ] as const) {
      const sourceTest = await readFile(join(process.cwd(), "tests", owner + ".test.ts"), "utf8");
      let replacedImports = 0;
      const compiledTest = sourceTest.replace(/(from\s+|import\()"\.\.\/lib\/([a-z0-9-]+)\.ts"/g, (_match, prefix: string, name: string) => {
        replacedImports += 1;
        return prefix + JSON.stringify(pathToFileURL(join(packageDir, "dist", "lib", name + ".js")).href);
      }).replace(/new URL\("\.\.\/lib\/([a-z0-9-]+)\.ts(\?[a-z0-9_]+)?", import\.meta\.url\)/g, (_match, name: string, query: string = "") => {
        // Preserve owner-test module namespaces while redirecting every production import into the installed package.
        replacedImports += 1;
        return `new URL(${JSON.stringify(pathToFileURL(join(packageDir, "dist", "lib", name + ".js")).href + query)}, import.meta.url)`;
      });
      assert.ok(replacedImports > 0);
      assert.doesNotMatch(compiledTest, /(?:from\s+|import\()"\.\.\/lib\//);
      assert.doesNotMatch(compiledTest, /new URL\("\.\.\/lib\//);
      const probePath = join(root, "compiled-" + owner + ".test.ts");
      await writeFile(probePath, compiledTest);
      const probe = await execFileAsync(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap",
        "--test-name-pattern=" + pattern, probePath], { env: probeEnv });
      const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(key => {
        const match = probe.stdout.match(new RegExp("^# " + key + " (\\d+)\\r?$", "m"));
        assert.ok(match, `${owner}: missing ${key} summary\n${probe.stdout.slice(-2000)}`);
        return [key, Number(match[1])];
      }));
      const diagnostic = `${owner}: ${JSON.stringify(counts)}`;
      assert.equal(counts.pass, passes, diagnostic);
      assert.equal(counts.fail, 0, diagnostic); assert.equal(counts.cancelled, 0, diagnostic); assert.equal(counts.todo, 0, diagnostic);
      assert.equal(counts.tests, counts.pass + counts.skipped, diagnostic);
      if (owner === "run-ui-runtime") {
        assert.equal(counts.tests, 55, diagnostic);
        assert.equal(counts.skipped, process.platform === "win32" ? 4 : 0, diagnostic);
      }
    }
  } finally {
    await removeTreeEventually(root);
  }
});

test("packed runtime tools preserve dispatch failures without turning partial effects into argument repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-packed-runtime-errors-"));
  try {
    const packageDir = await preparePackedPackage(root);
    const { createRuntimeToolDefinition } = await import(pathToFileURL(join(packageDir, "dist/lib/tools-local.js")).href);
    const cfg = { args: ["mode"], argTypes: { mode: { kind: "enum", values: ["check", "fix"] } },
      defaults: { mode: "check" }, description: "Controlled packed boundary", name: "boundary", template: "check {mode}" };
    for (const recipe of [undefined, { template: cfg.template }]) {
      let calls = 0;
      const cause = new Error("original cause");
      const failure = Object.assign(new AggregateError([cause], "Argument mode must remain recorded.", { cause }), { details: { partial_effect: true } });
      const tool = createRuntimeToolDefinition({ ...cfg, ...(recipe ? { recipe } : {}) }, async () => { calls++; throw failure; });
      await assert.rejects(tool.execute("invalid", { mode: "delete" }, undefined, undefined, { cwd: root }), /Invalid arguments[\s\S]*Expected call shape/);
      assert.equal(calls, 0);
      await assert.rejects(tool.execute("dispatch", {}, undefined, undefined, { cwd: root }), (error: unknown) => {
        assert.equal(error, failure); assert.equal(failure.cause, cause); assert.deepEqual(failure.errors, [cause]);
        assert.deepEqual(failure.details, { partial_effect: true }); return true;
      });
      assert.equal(calls, 1);
    }
    let effects = 0;
    const partial = createRuntimeToolDefinition({ ...cfg, args: ["mode", "missing"], template: ["check {mode}", "check {missing}"] },
      async () => { effects++; return { stdout: "ok", stderr: "", code: 0, killed: false }; });
    await assert.rejects(partial.execute("partial", {}, undefined, undefined, { cwd: root }), (error: Error) => {
      assert.match(error.message, /Missing command template value: missing/);
      assert.doesNotMatch(error.message, /Invalid arguments|Expected call shape/); return true;
    });
    assert.equal(effects, 1);
    const failure = new Error("Missing launch value: observer", { cause: new Error("launcher fault") });
    let reads = 0;
    const asyncTool = createRuntimeToolDefinition({ ...cfg, recipe: { async: true, template: cfg.template } },
      async () => { throw new Error("No synchronous executor expected"); });
    const ctx = { cwd: root, get onSupervisionClockCaptured(): never { reads++; throw failure; } };
    await assert.rejects(asyncTool.execute("invalid", { mode: "delete" }, undefined, undefined, ctx), /Invalid arguments[\s\S]*Expected call shape/);
    assert.equal(reads, 0);
    await assert.rejects(asyncTool.execute("launch", {}, undefined, undefined, ctx), (error: unknown) => error === failure);
    assert.equal(reads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packed Run retirement shares the compiled owner without treating retained scope as closure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-packed-retirement-"));
  let verified = false;
  try {
    const packageDir = await preparePackedPackage(root);
    const retention = await import(pathToFileURL(join(packageDir, "dist/lib/runs-retention.js")).href);
    const message = await import(pathToFileURL(join(packageDir, "dist/lib/tools-message.js")).href);
    assert.equal(message.compactControlResult({ target: "run:demo", action: "kill" }, { stopped: true, killed: true }),
      '\nrun: "demo"\naction: "kill"\nresult: "kill attempted"\ntermination: "unconfirmed"\nnext:\n  tool: "actors_inspect"\n  target: "run:demo"\n  view: "trace"\n');
    const publicControl = message.createControlToolDefinition({ handleRuntimeControl: () => ({ status: "handled", private_payload: "DETAIL_ONLY" }) });
    const compactControl = await publicControl.execute("packed-control-copy", { target: "runtime", action: "review.retry" }, undefined, undefined, {});
    assert.equal(compactControl.content[0].text, '\ntarget: "runtime"\naction: "review.retry"\nresult: "handled"\n');
    assert.doesNotMatch(compactControl.content[0].text, /DETAIL_ONLY/);
    const ownership = await import(pathToFileURL(join(packageDir, "dist/lib/runs-ownership.js")).href);
    const temp = await import(pathToFileURL(join(packageDir, "dist/lib/temp.js")).href);
    const asyncRuns = await import(pathToFileURL(join(packageDir, "dist/lib/async-runs.js")).href);
    const paths = await import(pathToFileURL(join(packageDir, "dist/lib/paths.js")).href);
    const responses = await import(pathToFileURL(join(packageDir, "dist/lib/tools-response.js")).href);
    const directLocations = { state: "available", run: "demo", run_instance_id: "generation-A", directory: "/controlled/demo", files: [] };
    const directLaunch = responses.compactAsyncRunStatus({ run: "demo", status: "running", launch_kind: "spawn", reused: true, file_navigation: directLocations });
    assert.match(directLaunch, /existing Run reused/);
    const directLaunchDocument = parseDocument(directLaunch, { version: "1.2", schema: "core", uniqueKeys: true });
    assert.deepEqual(directLaunchDocument.errors, []);
    assert.deepEqual(directLaunchDocument.toJS().run_files, directLocations);
    assert.doesNotMatch(directLaunch, /file_investigation:|^next:/m);
    for (const action of ["kill", "archive", "prune"]) for (const change of ["owner", "generation"]) {
      const run = `packed-scope-${randomUUID()}`;
      const stateDir = join(paths.getRunStateRoot(), run);
      ownership.claimRunStateDirectory(stateDir, run);
      await writeFile(join(stateDir, "run.json"), JSON.stringify({ run, state_dir: stateDir, pid: 0,
        ownerId: change === "owner" ? "owner-B" : "owner-A",
        run_instance_id: change === "generation" ? "generation-B" : "generation-A",
        values: { token: "FOREIGN_PACKED_VALUE" } }));
      await writeFile(join(stateDir, "result.json"), JSON.stringify({ code: 0, completedAt: new Date().toISOString() }));
      const before = await readFile(join(stateDir, "run.json"));
      try {
        const tool = message.createControlToolDefinition({ getRunStatus: () => ({ run, state_dir: stateDir, ownerId: "owner-A", run_instance_id: "generation-A" }) });
        const context = { sessionManager: { getSessionId: () => "owner-A" } };
        for (const verbose of [false, true]) {
          const response = await tool.execute("scoped-refusal", { target: `run:${run}`, action, verbose }, undefined, undefined, context);
          assert.equal(Object.hasOwn(response.details.result, "status"), false);
          assert.equal(response.details.result[action === "kill" ? "killed" : action === "archive" ? "archived" : "pruned"], false);
          assert.equal(response.details.result.reason, change === "owner" ? "ownership changed" : "run generation changed");
          assert.doesNotMatch(JSON.stringify(response), /FOREIGN_PACKED_VALUE|owner-B|generation-B/);
        }
        assert.deepEqual(await readFile(join(stateDir, "run.json")), before);
      } finally { await rm(stateDir, { recursive: true, force: true }); }
    }
    const { utimes } = await import("node:fs/promises");
    assert.equal(Object.hasOwn(temp, "cleanupStaleRunEntries"), false);
    const runsDir = join(root, "controlled-runs");
    const fixturePid = 2_000_000_000;
    const originalKill = process.kill.bind(process);
    t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number = 0) => {
      if (pid === fixturePid && signal === 0) throw Object.assign(Error("controlled absence, not native proof"), { code: "ESRCH" });
      return originalKill(pid, signal);
    });
    for (const run of ["eligible", "fenced", "manual"]) {
      const dir = join(runsDir, run);
      ownership.claimRunStateDirectory(dir, run);
      await writeFile(join(dir, "run.json"), JSON.stringify({ run, run_instance_id: "generation-A", ownerId: "owner-A", state_dir: dir, pid: fixturePid }));
      if (run === "fenced") await writeFile(join(dir, "native-launches.json"), "retained\n");
      const old = new Date(Date.now() - 8000);
      await utimes(dir, old, old);
    }
    const fencedBefore = await readFile(join(runsDir, "fenced", "run.json"));
    assert.equal(asyncRuns.pruneRun(join(runsDir, "manual"), {}, { ownerId: "owner-A", runInstanceId: "generation-A" }).pruned, true);
    assert.equal(await retention.cleanupStaleRunEntries(runsDir, 1000), 1);
    await assert.rejects(access(join(runsDir, "eligible")), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(runsDir, "fenced", "run.json")), fencedBefore);
    assert.equal(await readFile(join(runsDir, "fenced", "native-launches.json"), "utf8"), "retained\n");
    verified = true;
  } finally {
    t.mock.restoreAll();
    if (verified) await rm(root, { recursive: true, force: true });
    else console.error(`Packed retirement fixture failed; retaining state: ${root}`);
  }
});

test("installed extension entrypoint imports compiled dist runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-entry-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
       const entry = join(packageDir, pkg.pi.extensions[0]);
       import(pathToFileURL(entry).href).then((mod) => {
         if (typeof mod.default !== "function") throw new Error("extension default export missing");
         console.log("installed extension ok");
       }).catch((error) => {
         console.error(error.code || error.name, error.message);
         process.exit(1);
       });`,
      packageDir,
    ]);
    assert.match(stdout, /installed extension ok/);
    assert.doesNotMatch(stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music-player direct control rejects a terminal Run before journal admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-control-"));
  const stateDir = join(root, "music");
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({ run: "music", run_instance_id: "generation-a" }),
    );
    await writeFile(
      join(stateDir, "result.json"),
      JSON.stringify({ code: 0, completedAt: new Date().toISOString() }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
        "next",
        stateDir,
      ]),
      /Run playback is not active/,
    );
    assert.equal(await readTextIfExists(join(stateDir, "controls.jsonl")), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music-player ships a capability-owned optional Generative App", async () => {
  const adapter = join(
    process.cwd(),
    "skills",
    "music-player",
    "genapps",
    "music-player.mjs",
  );
  await execFileAsync(process.execPath, ["--check", adapter]);
  const source = await readFile(adapter, "utf8");
  assert.doesNotMatch(source, /pi-telegram|pi-actors|run\.json|controls\.jsonl/);
  assert.match(source, /playback\.mjs/);
  assert.match(source, /actor_available/);
  assert.match(source, /export async function play[\s\S]*apply\("resume", context\)/);
  assert.match(source, /\[0, 15, 30, 45, 60, 75, 90\]/);
});

test("music-player standalone service uses only the neutral playback protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-standalone-"));
  const stateDir = join(root, "music");
  const source = join(root, "silence.wav");
  const fakePlayer = join(root, process.platform === "win32" ? "ffplay.exe" : "ffplay");
  await mkdir(stateDir, { recursive: true });
  await writeFile(source, "audio fixture", "utf8");
  if (process.platform === "win32") {
    const sourceFile = join(root, "fake-player.cs");
    await writeFile(
      sourceFile,
      "using System.Threading; public class Program { public static void Main(string[] args) { Thread.Sleep(30000); } }\n",
      "utf8",
    );
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -Path '${sourceFile.replaceAll("'", "''")}' -OutputAssembly '${fakePlayer.replaceAll("'", "''")}' -OutputType ConsoleApplication`,
    ]);
  } else {
    await writeFile(fakePlayer, "#!/bin/sh\nexec sleep 30\n", "utf8");
    await chmod(fakePlayer, 0o755);
  }
  const service = join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs");
  const client = join(root, "playback.mjs");
  await cp(service, client);
  const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` };
  await assert.rejects(
    execFileAsync(process.execPath, [client, "control", stateDir, "start"], { env }),
    /unsupported command: start/,
  );
  const child = spawn(
    process.execPath,
    [client, "serve", source, "false", "70", "ffplay", stateDir],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForText(join(stateDir, "playback-endpoint.json"), /service_instance_id/);
    const endpointPath = join(stateDir, "playback-endpoint.json");
    const endpoint = await readFile(endpointPath, "utf8");
    await writeFile(endpointPath, JSON.stringify({ ...JSON.parse(endpoint), service_instance_id: "stale" }));
    await assert.rejects(
      execFileAsync(process.execPath, [client, "control", stateDir, "pause"], { env }),
      /invalid playback protocol command/,
    );
    await writeFile(endpointPath, endpoint);
    await assert.rejects(
      execFileAsync(process.execPath, [client, "control", stateDir, "volume", "101"], { env }),
      /percent/,
    );
    await execFileAsync(process.execPath, [client, "control", stateDir, "pause"], { env });
    const paused = JSON.parse(
      (await execFileAsync(process.execPath, [client, "status", stateDir], { env })).stdout,
    );
    assert.equal(paused.state, "paused");
    await execFileAsync(process.execPath, [client, "control", stateDir, "play"], { env });
    await execFileAsync(process.execPath, [client, "stop", stateDir], { env });
    const code = await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("standalone playback did not stop")), 5000),
      ),
    ]);
    assert.equal(code, 0);
    assert.equal(await readTextIfExists(join(stateDir, "run.json")), "");
    assert.equal(await readTextIfExists(join(stateDir, "controls.jsonl")), "");
    assert.equal(await readTextIfExists(join(stateDir, "trace.jsonl")), "");
    assert.equal(await readTextIfExists(join(stateDir, "control-endpoint.json")), "");

    const standalone = spawn(
      process.execPath,
      [client, "serve", source, "false", "70", "ffplay", stateDir],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForText(
      join(stateDir, "playback-endpoint.json"),
      /"owner_mode": "standalone"/,
    );
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({ run: "music-player", run_instance_id: "generation-a" }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        service,
        "play",
        source,
        "false",
        "70",
        "ffplay",
        stateDir,
      ], { env }),
      /standalone playback service already owns state/,
    );
    await execFileAsync(process.execPath, [client, "stop", stateDir], { env });
    await new Promise((resolve) => standalone.once("exit", resolve));
    const filesBeforeStatus = (await readdir(stateDir)).sort();
    const stopped = JSON.parse((await execFileAsync(process.execPath,
      [client, "control", stateDir, "status"], { env })).stdout);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.actor_available, false);
    assert.deepEqual((await readdir(stateDir)).sort(), filesBeforeStatus);
    await assert.rejects(
      execFileAsync(process.execPath, [client, "control", stateDir, "resume"], { env }),
      /Run playback is not active/,
    );
    assert.equal(await readTextIfExists(join(stateDir, "controls.jsonl")), "");
    assert.equal(await readTextIfExists(join(stateDir, "trace.jsonl")), "");
  } finally {
    child.kill("SIGKILL");
    await removeTreeEventually(root);
  }
});

test("music-player checkpoints and resumes its resolved playlist index", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-checkpoint-"));
  const stateDir = join(root, "music");
  const sourceDir = join(root, "source");
  const fakePlayer = join(root, process.platform === "win32" ? "ffplay.exe" : "ffplay");
  await mkdir(stateDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(stateDir, "run.json"), JSON.stringify({ run: "music-player", run_instance_id: "generation-a" }));
  await writeFile(join(sourceDir, "one.wav"), "one");
  await writeFile(join(sourceDir, "two.wav"), "two");
  if (process.platform === "win32") {
    const sourceFile = join(root, "fake-player.cs");
    await writeFile(sourceFile, "public class Program { public static void Main(string[] args) {} }\n");
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -Path '${sourceFile.replaceAll("'", "''")}' -OutputAssembly '${fakePlayer.replaceAll("'", "''")}' -OutputType ConsoleApplication`,
    ]);
  } else {
    await writeFile(fakePlayer, "#!/bin/sh\nexit 0\n");
    await chmod(fakePlayer, 0o755);
  }
  const args = [
    join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
    "play", sourceDir, "false", "70", "ffplay", stateDir,
  ];
  const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` };
  try {
    await execFileAsync(process.execPath, args, { env });
    const checkpoint = JSON.parse(await readFile(join(stateDir, "playback.json"), "utf8"));
    assert.equal(checkpoint.source, sourceDir);
    assert.equal(checkpoint.tracks.length, 2);
    assert.equal(checkpoint.index, 1);
    assert.equal(checkpoint.volume, 70);
    const resumed = await execFileAsync(process.execPath, args, { env });
    assert.match(resumed.stderr, /checkpoint=resumed start_index=1/);
    await writeFile(join(stateDir, "playback.json"), "{truncated", "utf8");
    const recovered = await execFileAsync(process.execPath, args, { env });
    assert.match(recovered.stderr, /checkpoint_recovery=invalid-json/);
    assert.match(recovered.stderr, /checkpoint=recovered start_index=0/);
    assert.match(
      await readFile(join(stateDir, "trace.jsonl"), "utf8"),
      /"kind":"player\.checkpoint-recovered"/,
    );
    const invalidIndexCheckpoint = JSON.parse(
      await readFile(join(stateDir, "playback.json"), "utf8"),
    );
    invalidIndexCheckpoint.index = "not-an-index";
    await writeFile(
      join(stateDir, "playback.json"),
      JSON.stringify(invalidIndexCheckpoint),
      "utf8",
    );
    const invalidIndex = await execFileAsync(process.execPath, args, { env });
    assert.match(invalidIndex.stderr, /checkpoint_recovery=invalid-shape/);
    assert.match(invalidIndex.stderr, /checkpoint=recovered start_index=0/);
    const status = JSON.parse((await execFileAsync(process.execPath, [args[0], "status", stateDir])).stdout);
    assert.equal(status.state, "stopped");
    assert.equal(status.volume, 70);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music-player restores a paused checkpoint without resuming intent", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal fixture");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-paused-"));
  const stateDir = join(root, "music");
  const source = join(root, "track.wav");
  const fakePlayer = join(root, "ffplay");
  await mkdir(stateDir, { recursive: true });
  await writeFile(source, "audio fixture");
  await writeFile(fakePlayer, "#!/bin/sh\nexec sleep 30\n");
  await chmod(fakePlayer, 0o755);
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({ run: "music-player", run_instance_id: "generation-a" }),
  );
  const args = [
    join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
    "play", source, "true", "70", "ffplay", stateDir,
  ];
  const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` };
  const first = spawn(process.execPath, args, { env, stdio: "ignore" });
  let second: ReturnType<typeof spawn> | undefined;
  try {
    await waitForText(join(stateDir, "player.json"), /"state":"playing"/);
    await deliverRunControl("music-player", stateDir, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    const paused = JSON.parse(
      await waitForText(join(stateDir, "player.json"), /"state":"paused"/),
    );
    const pausedCheckpoint = JSON.parse(
      await waitForText(join(stateDir, "playback.json"), /"state":\s*"paused"/),
    );
    assert.equal(pausedCheckpoint.state, "paused");
    first.kill("SIGKILL");
    process.kill(Number(paused.pid), "SIGKILL");
    await new Promise((resolve) => first.once("exit", resolve));
    second = spawn(process.execPath, args, { env, stdio: "ignore" });
    const deadline = Date.now() + 5000;
    let restored: { state?: string } | undefined;
    while (Date.now() < deadline) {
      const text = await readTextIfExists(join(stateDir, "player.json"));
      if (text) {
        const candidate = JSON.parse(text);
        if (candidate.state === "paused" && candidate.pid !== paused.pid) {
          restored = candidate;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(restored?.state, "paused");
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGTERM");
    await removeTreeEventually(root);
  }
});

test("music-player consumes publicly delivered Controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-delivery-"));
  const stateDir = join(root, "music");
  const source = join(root, "silence.wav");
  const fakePlayer = join(root, process.platform === "win32" ? "ffplay.exe" : "ffplay");
  const fakeWpctl = join(root, "wpctl");
  const fakeFfprobe = join(root, "ffprobe");
  const playerLog = join(root, "ffplay.log");
  const wpctlLog = join(root, "wpctl.log");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({ run: "music", run_instance_id: "generation-a" }),
  );
  await writeFile(source, "audio fixture", "utf8");
  if (process.platform === "win32") {
    const sourceFile = join(root, "fake-player.cs");
    await writeFile(
      sourceFile,
      "using System; using System.Threading; public class Program { public static void Main(string[] args) { Thread.Sleep(30000); } }\n",
      "utf8",
    );
    const quotedSource = sourceFile.replaceAll("'", "''");
    const quotedPlayer = fakePlayer.replaceAll("'", "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -Path '${quotedSource}' -OutputAssembly '${quotedPlayer}' -OutputType ConsoleApplication`,
    ]);
  } else {
    await writeFile(
      fakePlayer,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FFPLAY_LOG_FILE\"\nexec sleep 30\n",
      "utf8",
    );
    await chmod(fakePlayer, 0o755);
    await writeFile(fakeFfprobe, "#!/bin/sh\nprintf '100\\n'\n", "utf8");
    await chmod(fakeFfprobe, 0o755);
    await writeFile(
      fakeWpctl,
      `#!/bin/sh
case "$1:$2" in
  status:-n) printf 'Audio\\n └─ Streams:\\n        88. ffplay\\n\\nVideo\\n' ;;
  inspect:88) printf '  * client.id = "99"\\n  * media.class = "Stream/Output/Audio"\\n' ;;
  inspect:99) printf '    application.process.id = "%s"\\n' "$(cat "$WPCTL_PID_FILE")" ;;
  set-volume:88)
    # Keep backend completion observably later than the player status update.
    sleep 0.1
    printf '%s %s\\n' "$2" "$3" >> "$WPCTL_LOG_FILE" ;;
  *) exit 1 ;;
esac
`,
      "utf8",
    );
    await chmod(fakeWpctl, 0o755);
  }
  let playbackPid: number | undefined;
  const playbackPids = new Set<number>();
  let childOutput = "";
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"), "play", source, "false", "70", "ffplay", stateDir],
    {
      env: {
        ...process.env,
        FFPLAY_LOG_FILE: playerLog,
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        WPCTL_LOG_FILE: wpctlLog,
        WPCTL_PID_FILE: join(stateDir, "current.pid"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  try {
    await waitForText(join(stateDir, "control-endpoint.json"), /run_instance_id/);
    await waitForText(join(stateDir, "playback-endpoint.json"), /service_instance_id/);
    await waitForText(join(stateDir, "player.json"), /"state":"playing"/);
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
        "serve",
        source,
        "false",
        "70",
        "ffplay",
        stateDir,
      ], { env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` } }),
      /active playback service already owns state/,
    );
    const initialPlayerState = JSON.parse(
      await waitForText(
        join(stateDir, "player.json"),
        /"pid":"\d+","updated_at":"[^"]+"}\s*$/,
      ),
    );
    playbackPid = Number(initialPlayerState.pid);
    playbackPids.add(playbackPid);
    const controlsBeforeClient = await readTextIfExists(join(stateDir, "controls.jsonl"));
    const client = join(
      process.cwd(),
      "skills",
      "music-player",
      "scripts",
      "playback.mjs",
    );
    const app = await import(pathToFileURL(join(process.cwd(), "skills", "music-player", "genapps", "music-player.mjs")).href);
    const run = async ({ command, args, cwd, timeoutMs }: {
      command: string; args: string[]; cwd: string; timeoutMs: number;
    }) => {
      assert.equal(args[0], client);
      assert.equal(args[1], "control");
      assert.equal(args[2], stateDir);
      const result = await execFileAsync(command, args, {
        cwd, timeout: timeoutMs,
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
          WPCTL_LOG_FILE: wpctlLog,
          WPCTL_PID_FILE: join(stateDir, "current.pid"),
        },
      });
      return { code: 0, ...result };
    };
    const initialView = await app.init({ argument: { control: client, stateDir, node: process.execPath }, run });
    assert.equal(initialView.state.playback.actorAvailable, true);
    const volumeView = await app.volume({ argument: 62, state: initialView.state, run });
    assert.equal(volumeView.state.playback.volume, 62);
    const clientVolumeState = JSON.parse(
      await waitForText(join(stateDir, "player.json"), /"volume":62/),
    );
    if (process.platform === "win32") {
      playbackPids.add(Number(clientVolumeState.pid));
    }
    const controlsAfterClient = await readTextIfExists(join(stateDir, "controls.jsonl"));
    assert.notEqual(controlsAfterClient, controlsBeforeClient);
    assert.match(controlsAfterClient, /"action":"volume".*"percent":62.*"status":"handled"/);
    const clientStatus = JSON.parse(
      (await execFileAsync(process.execPath, [client, "status", stateDir])).stdout,
    );
    assert.equal(clientStatus.volume, 62);
    if (process.platform === "win32") {
      assert.equal(clientStatus.progress_percent, null);
    } else {
      assert.equal(Number.isInteger(clientStatus.progress_percent), true);
    }
    const volumeControl = await deliverRunControl("music", stateDir, {
      action: "volume",
      input: { percent: 63 },
      run_instance_id: "generation-a",
    });
    assert.match(String(volumeControl.control_id), /^[0-9a-f-]+$/);
    await waitForText(
      join(stateDir, "controls.jsonl"),
      new RegExp(`"id":"${volumeControl.control_id}".*"status":"handled"`),
    );
    const volumeState = JSON.parse(
      await waitForText(
        join(stateDir, "player.json"),
        /"volume":63.*"updated_at":"[^"]+"}\s*$/,
      ),
    );
    if (process.platform === "linux") {
      assert.equal(Number(volumeState.pid), playbackPid);
      assert.equal(await readFile(wpctlLog, "utf8"), "88 62%\n88 63%\n");
    } else {
      playbackPid = Number(volumeState.pid);
      playbackPids.add(playbackPid);
    }
    await deliverRunControl("music", stateDir, {
      action: "volume",
      input: { percent: 101 },
      run_instance_id: "generation-a",
    });
    await waitForText(
      join(stateDir, "controls.jsonl"),
      /"action":"volume".*"percent":101.*"status":"failed"/,
    );
    if (process.platform !== "win32") {
      await deliverRunControl("music", stateDir, {
        action: "seek",
        input: { percent: 40 },
        run_instance_id: "generation-a",
      });
      await waitForText(
        join(stateDir, "controls.jsonl"),
        /"action":"seek".*"status":"handled"/,
      );
      const seekState = JSON.parse(
        await waitForText(
          join(stateDir, "player.json"),
          /"seek_percent":40.*"pid":"\d+","updated_at":"[^"]+"}\s*$/,
        ),
      );
      assert.notEqual(Number(seekState.pid), playbackPid);
      await waitForText(playerLog, /-ss 40/);
      playbackPid = Number(seekState.pid);
    }
    await execFileAsync(process.execPath, [
      join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
      "pause",
      stateDir,
    ]);
    try {
      await waitForText(join(stateDir, "controls.jsonl"), /"action":"pause".*"status":"handled"/);
    } catch (error) {
      const controls = await readTextIfExists(join(stateDir, "controls.jsonl"));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
        `child_exit=${child.exitCode ?? "running"}; child_signal=${child.signalCode ?? "none"}; ` +
        `controls=${JSON.stringify(controls.slice(-2000))}; output=${JSON.stringify(childOutput.slice(-2000))}`,
      );
    }
    const pausedStatus = JSON.parse((await execFileAsync(process.execPath, [
      join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
      "status",
      stateDir,
    ])).stdout);
    assert.equal(pausedStatus.state, "paused");
    if (process.platform === "win32") {
      assert.equal(pausedStatus.progress_percent, null);
    } else {
      assert.equal(Number.isInteger(pausedStatus.progress_percent), true);
      assert.ok(pausedStatus.progress_percent >= 0 && pausedStatus.progress_percent <= 100);
    }
    await execFileAsync(process.execPath, [
      join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
      "volume",
      stateDir,
      "57",
    ]);
    await waitForText(
      join(stateDir, "controls.jsonl"),
      /"action":"volume".*"percent":57.*"status":"handled"/,
    );
    await waitForText(
      join(stateDir, "player.json"),
      /"state":"paused".*"volume":57.*"updated_at":"[^"]+"}\s*$/,
    );
    const controlsBeforeInvalidVolume = await readFile(
      join(stateDir, "controls.jsonl"),
      "utf8",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(process.cwd(), "skills", "music-player", "scripts", "playback.mjs"),
        "volume",
        stateDir,
        "101",
      ]),
      /volume percent must be an integer 0\.\.100/,
    );
    assert.equal(
      await readFile(join(stateDir, "controls.jsonl"), "utf8"),
      controlsBeforeInvalidVolume,
    );
    const action = process.platform === "win32" ? "status" : "stop";
    const stopStartedAt = Date.now();
    await deliverRunControl("music", stateDir, {
      action,
      run_instance_id: "generation-a",
    });
    try {
      await waitForText(join(stateDir, "controls.jsonl"), new RegExp(`"action":"${action}".*"status":"handled"`));
    } catch (error) {
      const controls = await readTextIfExists(join(stateDir, "controls.jsonl"));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
        `child_exit=${child.exitCode ?? "running"}; child_signal=${child.signalCode ?? "none"}; ` +
        `controls=${JSON.stringify(controls.slice(-2000))}; output=${JSON.stringify(childOutput.slice(-2000))}`,
      );
    }
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      const code = await Promise.race([
        new Promise<number | null>((resolve) => child.once("exit", resolve)),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("music-player did not stop")), 5000),
        ),
      ]);
      assert.equal(code, 0);
      assert.ok(Date.now() - stopStartedAt < 2500, "music-player stop must beat natural fixture exit");
    }
    const controls = (await readFile(join(stateDir, "controls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const pauseControl = controls.find((control) => control.action === "pause");
    assert.equal(pauseControl?.status, "handled");
    assert.equal(Object.hasOwn(pauseControl ?? {}, "delivered_at"), false);
    const seekControl = controls.find((control) => control.action === "seek");
    if (process.platform !== "win32") {
      assert.deepEqual(seekControl?.input, { percent: 40 });
      assert.equal(seekControl?.status, "handled");
    }
    const volumeControls = controls.filter((control) => control.action === "volume");
    assert.deepEqual(volumeControls.map((control) => control.input), [
      { percent: 62 },
      { percent: 63 },
      { percent: 101 },
      { percent: 57 },
    ]);
    assert.deepEqual(volumeControls.map((control) => control.status), [
      "handled",
      "handled",
      "failed",
      "handled",
    ]);
    assert.equal(Object.hasOwn(volumeControls[0] ?? {}, "delivered_at"), false);
    assert.equal(typeof volumeControls[1]?.delivered_at, "string");
    assert.match(volumeControls[2]?.error ?? "", /integer 0\.\.100/);
    assert.equal(Object.hasOwn(volumeControls[3] ?? {}, "delivered_at"), false);
    const volumeTrace = await readFile(join(stateDir, "trace.jsonl"), "utf8");
    assert.match(volumeTrace, /"kind":"player\.volume"/);
    assert.match(volumeTrace, /"percent":57/);
    const delivered = controls.find((control) => control.action === action);
    assert.equal(delivered?.status, "handled");
    assert.equal(typeof delivered?.delivered_at, "string");
  } finally {
    if (process.platform === "win32") {
      const quotedPlayer = fakePlayer.replaceAll("'", "''");
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$target = '${quotedPlayer}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ]).catch(() => {});
      for (const pid of playbackPids) {
        await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
      }
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    await removeTreeEventually(root);
  }
});

test("installed async-runner avoids importing TypeScript from node_modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-runner-"));
  const capture = captureFixtureBirths(t), errors: unknown[] = [];
  let dispatched = false, accepted = false;
  try {
    const packageDir = await prepareInstalledPackage(root);
    const stateDir = join(root, "state");
    const { startRun } = await import(
      pathToFileURL(join(packageDir, "dist", "lib", "async-runs.js")).href
    );
    dispatched = true;
    const meta = startRun({
      run_id: "installed-runner",
      state_dir: stateDir,
      template: `${process.execPath} -e "console.log('installed async ok')"`,
    }, process.cwd());
    assert.equal(capture.births.length, 1);
    await joinFixtureRunners([{ birth: bindFixtureBirth(capture.births, meta.pid), path: join(stateDir, "result.json") }]);
    const text = await readFile(join(stateDir, "result.json"), "utf8");
    assert.match(text, /"completedAt":/);
    const result = JSON.parse(text);
    assert.equal(result.code, 0);
    assert.equal(result.run_instance_id, meta.run_instance_id);
    assert.equal(meta.argv.at(-1), stateDir);
    assert.doesNotMatch(
      await readTextIfExists(join(stateDir, "stderr.log")),
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
    );
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /installed async ok/);
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "async-runner.ts")), "");
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "execution.ts")), "");
    accepted = true;
  } catch (error) { errors.push(error); }
  finally {
    try { capture.restore(); } catch (error) { errors.push(error); }
    if (errors.length === 0) try {
      if (accepted) requireFreshFixtureAbsence(capture.births[0]);
      if (accepted || !dispatched) await rm(root, { recursive: true, force: true });
    } catch (error) { errors.push(error); }
    if (errors.length) try { t.diagnostic(`Installed runner fixture retained: ${root}`); } catch (error) { errors.push(error); }
  }
  throwFixtureErrors(errors);
});

test("installed validate-recipe avoids importing TypeScript from node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-validator-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const recipe = join(root, "recipe.json");
    await writeFile(recipe, `${JSON.stringify({ template: "echo ok" })}\n`);
    const { stdout } = await execFileAsync(process.execPath, [
      join(packageDir, "skills", "actors", "scripts", "validate-recipe.mjs"),
      recipe,
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.passed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed Skill Recipe QA matches the source capability inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-validator-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const args = ["--skills", "--qa", "--summary"];
    const source = await execFileAsync(process.execPath, [
      join(process.cwd(), "skills", "actors", "scripts", "validate-recipe.mjs"),
      join(process.cwd(), "skills"),
      ...args,
    ]);
    const installed = await execFileAsync(process.execPath, [
      join(packageDir, "skills", "actors", "scripts", "validate-recipe.mjs"),
      join(packageDir, "skills"),
      ...args,
    ]);
    assert.deepEqual(JSON.parse(installed.stdout), JSON.parse(source.stdout));
    assert.equal(JSON.parse(installed.stdout).total, 55);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packed extension presents explicit steer before its exact completion epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-packed-delivery-"));
  try {
    const packageDir = await preparePackedPackage(root);
    const agentDir = join(root, "agent");
    const runDir = join(agentDir, "tmp", "pi-actors", "runs", "packed-run");
    await mkdir(runDir, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(join(runDir, "run.json"), JSON.stringify({
      createdAt: timestamp,
      cwd: packageDir,
      notification_policy: "normal",
      ownerId: "packed-owner",
      pid: 999_999,
      run: "packed-run",
      run_instance_id: "11111111-1111-4111-8111-111111111111",
      state_dir: runDir,
    }));
    await writeFile(join(runDir, "result.json"), JSON.stringify({
      code: 0,
      finished_at: timestamp,
    }));
    await writeFile(join(runDir, "trace.jsonl"), `${JSON.stringify({
      attention: "steer",
      id: "packed-steer-event",
      kind: "checkpoint.ready",
      level: "info",
      summary: "Inspect the packed delivery boundary.",
      ts: timestamp,
    })}\n`);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const { parseDocument } = require("node:module").createRequire(join(packageDir, "package.json"))("yaml");
       const yamlOptions = { version: "1.2", schema: "core", uniqueKeys: true };
       import(pathToFileURL(join(packageDir, "dist", "pi-actors", "index.js")).href).then(async (mod) => {
         const handlers = new Map();
         const sent = [];
         const pi = {
           getActiveTools: () => [],
           getAllTools: () => [],
           getThinkingLevel: () => "off",
           on: (name, handler) => handlers.set(name, handler),
           registerCommand: () => {},
           registerMessageRenderer: (type, renderer) => { if (type !== "pi-actors-run-batch") throw Error("unexpected renderer"); pi.batchRenderer = renderer; },
           registerTool: () => {},
           sendMessage: (message, options) => sent.push({ message, options }),
           setActiveTools: () => {},
         };
         mod.default(pi);
         const context = {
           cwd: packageDir,
           hasUI: true,
           isIdle: () => true,
           sessionManager: {
             getEntry: () => undefined,
             getLeafEntry: () => undefined,
             getSessionId: () => "packed-owner",
           },
           ui: {
             notify: () => {},
             setStatus: () => {},
             setWidget: () => {},
             theme: { bold: (value) => value, fg: (_name, value) => value },
           },
         };
         await handlers.get("session_start")({}, context);
         if (sent[0]?.options?.deliverAs !== "steer") throw new Error("packed steer was not first");
         const steer = parseDocument(sent[0].message.content, yamlOptions);
         if (steer.errors.length || steer.warnings.length || steer.get("run") !== "packed-run" || steer.get("checkpoint") !== "Inspect the packed delivery boundary.") throw new Error("packed steer did not select new AX capture text");
         await handlers.get("context")({ messages: [sent[0].message] }, context);
         await handlers.get("agent_settled")({}, context);
         if (sent[1]?.options?.deliverAs !== "followUp") throw new Error("packed completion was not second");
         const completion = sent[1].message;
         if (completion.details.pi_actors_presentation.format !== "completion_yaml_core_v1") throw Error("fresh packed packet did not use canonical YAML core AX");
         const compact = pi.batchRenderer(completion, { expanded: false, outputPad: 0 }, context.ui.theme).render(90);
         const runLine = compact.findIndex(line => line.startsWith("run: "));
         const indexLine = compact.findIndex(line => /^index:/u.test(line.trim()));
         const compactRun = parseDocument(compact[runLine] ?? "", yamlOptions);
         if (compactRun.errors.length || compactRun.warnings.length || compactRun.get("run") !== "packed-run" || runLine < 0 || indexLine !== -1) throw Error("packed singleton is not an unindexed YAML record");
         if (compact.some(line => /^\\s*- (?:members|#0|completions):/u.test(line)) || compact.some(line => line.trim() === "Run Batch")) throw Error("packed singleton retained a Batch wrapper");
         const id = completion.details.pi_actors_delivery.batch_id;
         if (compact.join("\\n").includes(id)) throw Error("compact TUI leaked routine batch metadata");
         for (const [expanded, details] of [[true, completion.details], [false, {}]]) {
           const full = pi.batchRenderer({ ...completion, details }, { expanded, outputPad: 0 }, context.ui.theme).render(140).join("\\n");
           if (!full.includes(id) || !full.includes("_completion:") || !full.includes("completion_yaml_core_v1")) throw Error("packed expanded/fallback view lost full content");
         }
         await handlers.get("context")({ messages: [sent[1].message] }, context);
         await handlers.get("session_shutdown")({}, context);
         const runDir = join(process.env.PI_CODING_AGENT_DIR, "tmp", "pi-actors", "runs", "packed-run");
         const handled = JSON.parse(readFileSync(join(runDir, "terminal-handled.json"), "utf8"));
         const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8");
         console.log(JSON.stringify({
           completionType: sent[1].message.customType,
           handledGeneration: handled.run_instance_id,
           steerMarker: trace.includes("delivery.steer_presented"),
           steerType: sent[0].message.customType,
         }));
       }).catch((error) => { console.error(error); process.exit(1); });`,
      packageDir,
    ], {
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        USERPROFILE: root,
      },
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      completionType: "pi-actors-run-batch",
      handledGeneration: "11111111-1111-4111-8111-111111111111",
      steerMarker: true,
      steerType: "pi-actors-run-steer",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Public SDK fixture cleanup requires fresh ESRCH and preserves uncertainty causes", () => {
  const captured = [{ pid: 123 }]; const primary = Error("fixture failed before cleanup");
  const denied = Object.assign(Error("fixture probe denied"), { code: "EPERM" }); let probes = 0;
  assert.doesNotThrow(() => assertFreshFixtureRunnerAbsence(captured, "fixture-root", primary, (pid, signal) => {
    assert.equal(pid, 123); assert.equal(signal, 0); probes++; throw Object.assign(Error("absent"), { code: "ESRCH" });
  }));
  assert.equal(probes, 1);
  for (const cause of [undefined, denied]) {
    assert.throws(() => assertFreshFixtureRunnerAbsence(captured, "fixture-root", primary, () => { if (cause) throw cause; }), (error: unknown) => {
      assert.ok(error instanceof AggregateError); assert.match(error.message, /exit remains unproven; retaining state/);
      assert.equal(error.errors.length, 2); assert.equal(error.errors[0], primary);
      if (cause) assert.equal(error.errors[1], cause); else assert.match(error.errors[1].message, /PID remains present: 123/);
      return true;
    });
  }
});

test("source and packed private context preserve Recipe correspondence and Control/Trace/Execution publication without authority reconstruction", async () => {
  type SavedSession = { state: string; session_id: string; session_file: string; cwd: string };
  type Publication = { binding_capture_index: number; source_scope: string; export_id: string; command_id: string;
    navigation_root: string; catalog_path: string; preview_path: string; catalog_sha256: string; preview_sha256: string;
    catalog_bytes: number; preview_bytes: number };
  type ResearchFrame = { run: string; run_instance_id: string; ownerId: string; state_dir: string };
  for (const layout of ["source", "packed"] as const) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `pi-actors-${layout}-context-evidence-`))); const agentDir = join(root, "agent");
    const run = "private-context-evidence", generation = randomUUID() + "g".repeat(8000); const fixtureDir = join(agentDir, run), stateDir = join(fixtureDir, "state");
    const manifest = join(fixtureDir, "fixture-processes.json"); let pid: number | undefined, launching = false, primaryError: unknown;
    const metadataFrames = [
      { name: "generation_origin", run_instance_id: "/x/private", ownerId: "private-context-fixture" },
      { name: "generation_secret", run_instance_id: "token=HIDDEN_GENERATION", ownerId: "private-context-fixture" },
      { name: "owner_origin", run_instance_id: generation, ownerId: "/x/private" },
      { name: "owner_secret", run_instance_id: generation, ownerId: "token=HIDDEN_OWNER" },
      { name: "logical_identity", run_instance_id: "generation-/x/private", ownerId: "owner-/x/private" },
      { name: "owner_absent", run_instance_id: "generation-owner-absent", literal_secret: "[REDACTED]" },
      { name: "generation_literal", run_instance_id: "literal-fixture-credential-62", ownerId: "private-context-fixture", literal_secret: "literal-fixture-credential-62" },
      { name: "owner_literal", run_instance_id: generation, ownerId: "literal-fixture-credential-62", literal_secret: "literal-fixture-credential-62" },
      { name: "generation_escaped_literal", run_instance_id: "raw\"\\\r\n\uFEFF\uFFFD🫧```", ownerId: "private-context-fixture", literal_secret: "raw\"\\\r\n\uFEFF\uFFFD🫧```" },
      { name: "owner_escaped_literal", run_instance_id: generation, ownerId: "raw\"\\\r\n\uFEFF\uFFFD🫧```", literal_secret: "raw\"\\\r\n\uFEFF\uFFFD🫧```" },
    ].map(value => ({ ...value, run, state_dir: join(fixtureDir, "identity-frames", value.name), composition: "controlled_metadata_only" }));
    let evidence: Promise<{ stdout: Buffer; stderr: Buffer; error?: unknown }> | undefined;
    let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let packageDir = process.cwd();
    try {
      packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      const workDir = join(fixtureDir, "workspace β`\uFEFF\uFFFD"); await mkdir(workDir, { recursive: true });
      await writeFile(manifest, JSON.stringify({ schema: "context-private-fixture-v1", launching: true, complete: false,
        planned: { run, run_instance_id: generation, state_dir: stateDir, metadata_frames: metadataFrames }, captured: [] }));
      launching = true;
      const pending = execFileAsync(process.execPath, ["--experimental-strip-types", join(process.cwd(), "tests", "fixtures", "context-private-evidence.mjs"),
        packageDir, fixtureDir, layout, run, generation], { cwd: workDir, timeout: process.platform === "win32" ? 180000 : 20000, encoding: "buffer",
        env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" } });
      pid = pending.child.pid; launching = !(Number.isSafeInteger(pid) && Number(pid) > 0); // Exact parent birth/frame before assertions or await.
      pending.child.once("close", (code, signal) => { close = { code, signal }; });
      evidence = pending.then(value => ({ stdout: value.stdout, stderr: value.stderr, error: undefined }), error => ({
        stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
        stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
      })).then(async result => {
        try {
          await writeFile(join(fixtureDir, "producer-stdio.json"), JSON.stringify({ schema: "context-private-stdio-v2", producer_pid: pid, close,
            stdout_base64: result.stdout.toString("base64"), stderr_base64: result.stderr.toString("base64"), capture_complete: (result.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
        } catch (error) { throw new AggregateError([...(result.error ? [result.error] : []), error], "Fixture stdio persistence failed; retaining state"); }
        return result;
      });
      void evidence.catch(() => {});
      writeFileSync(join(fixtureDir, "producer-parent-frame.json"), JSON.stringify({ producer_pid: pid, run, run_instance_id: generation,
        ownerId: "private-context-fixture", state_dir: stateDir, layout, host_exit: "not_asserted" }));
      assert.ok(Number.isSafeInteger(pid) && Number(pid) > 0, "Captured fixture producer PID unavailable; retaining state");
      const { stdout, stderr, error } = await evidence; if (error) throw error;
      assert.deepEqual(close, { code: 0, signal: null }); assert.equal(stderr.length, 0);
      const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
      assert.equal(report.layout, layout); assert.equal(report.composition, "private_context_same_runtime"); assert.equal(report.producerPid, pid);
      assert.equal(report.savedSessionFrame.state, "persisted"); assert.equal(report.savedSessionFrame.session_id, "private-context-fixture");
      assert.equal(report.sessionPublication.binding_capture_index, 0); assert.equal(report.preparedMapShown, 1);
      assert.equal(report.workloads, 0); assert.equal(report.issuerAdmissions, 15); assert.equal(report.controlledIdentityMetadataFrames, 10); assert.equal(report.controlledCanonicalResultRecords, 10); assert.equal(report.controlledPrimarySelections, 9); assert.equal(report.controlledSessionSelections, 12);
      for (const flag of ["originalProjectionAndPolicy", "literalAndFrozenData", "copiedAndCrossModuleRefused", "livePrivacyAndPolicyNotRenewed",
        "sameSizeTamperRefusedWithoutRepair", "sourceLossRefusedWithoutFallback", "explicitRestorationObserved", "sourceByteLimitIndependent",
        "originalCaptureBudgetIndependent", "wholeResponseBudgetIndependent", "controlOriginalPrivacyBeforeClipping",
        "controlLiveMetadataCannotRenewPrivacy", "controlRowIdentifiersExact", "controlOriginalPublicationRead", "controlTamperAndViewLossRefused",
        "controlOriginalAndModuleBindingRequired", "controlHistoricalCountsAndJournalLoss", "traceOriginalAndModuleBindingRequired", "traceSameSizeEditsRefused",
        "traceHistoricalAfterJournalGrowthAndLoss", "traceViewLossHasNoPrivateDataFallback", "traceExplicitPublicationReplacesBinding",
        "traceSourceAndResponseLimitsIndependent", "executionOriginalPublicationAndPrivacy", "executionTamperAndModuleAdmissionRefused",
        "executionHistoricalManifestLossNoBodyFallback", "executionWholeResponseBudgetIndependent", "originalHeaderAndResponseIdentityPrivacy",
        "safeLogicalAndAbsentOwnerPreserved", "identityPrivacyNotRenewedFromLiveMetadata", "resultOriginalPublicationIdentityPrivacy",
        "resultSafeIdentityDiagnosticsRecovered", "resultFirstBindingUnavailabilityImmutable", "originalResultContextMetadataRefused", "originalCompleteTextOpaquePrivacy", "publicSourceScalarSpellingPreserved", "originalCapturedAtPrivacy", "capturedAtRefusalPreservesHistory", "publicRecipeFileTimePreserved", "knownCleanupReportDoesNotMintPublication", "resultWholeViewOriginalPublication", "resultHistoricalReadWithoutRootOrDiagnosticSource", "capturedLiteralIdentityPrivacy",
        "controlLiteralRowsOmittedWithoutCapacityRepair", "originalSourcePublicationIdentityPrivacy", "privateSourceRefusalBeforeBodyProbes",
        "safeSourceRecoveryNoTargetProbes", "inventoryDisplayMaskPathWithheld", "snapshotDisplayMaskCwdWithheld", "originalRecordedBodyPrivacyBeforeLimits",
        "bodyPrivacyNonrenewalAfterLiveEdits", "rawOpaqueScalarPrivacyBeforeNormalization", "originalRoutingMetadataRowsOmitted", "originalSignalPrivacyRefusalPreservesHistory", "recipeDisplayLabelsPreserveOriginalProjection", "originalClockMetadataRefused", "originalExecutionFactRefusalPreservesHistory",
        "originalTraceIdentityFactRowsOmitted", "originalControlTimestampRowsOmitted", "originalControlCapacityPrivacyRefusesView", "originalSessionSelectedMetadataRefused", "originalSessionPeerMetadataRefused", "baselineRootResultAbsent"]) assert.equal(report[flag], true, flag);
    } catch (error) { primaryError = error; throw error; }
    finally {
      const proofErrors: unknown[] = []; let captured: { pid: number }[] = [];
      if (evidence) { try { await evidence; } catch (error) { if (error !== primaryError) proofErrors.push(error); } }
      if (launching) proofErrors.push(Error("Native fixture launch capture remains unproven; retaining state"));
      if (pid !== undefined) {
        let proof; try { proof = JSON.parse(await readFile(manifest, "utf8")); } catch (error) { proofErrors.push(error); }
        const row: { pid: number; role: string; run: string; run_instance_id: string; ownerId: string; state_dir: string; exit_observation: string } | undefined = proof?.captured?.[0];
        if (proof?.schema !== "context-private-fixture-v1" || proof.complete !== true || proof.launching !== false ||
          !Array.isArray(proof.captured) || proof.captured.length !== 1 || !row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || row.pid !== pid ||
          row.role !== "producer" || row.run !== run || row.run_instance_id !== generation || row.ownerId !== "private-context-fixture" ||
          row.state_dir !== stateDir || row.exit_observation !== "not_asserted") proofErrors.push(Error(`Captured private context fixture frame is incomplete: ${manifest}`));
        else {
          captured = proof.captured;
          try {
            assert.deepEqual(JSON.parse(await readFile(join(fixtureDir, "producer-parent-frame.json"), "utf8")), {
              producer_pid: pid, run, run_instance_id: generation, ownerId: "private-context-fixture", state_dir: stateDir, layout, host_exit: "not_asserted" });
            const stdio = JSON.parse(await readFile(join(fixtureDir, "producer-stdio.json"), "utf8"));
            assert.equal(stdio.schema, "context-private-stdio-v2"); assert.equal(stdio.producer_pid, pid);
            assert.deepEqual(stdio.close, close); assert.equal(stdio.capture_complete, true); assert.equal(stdio.stderr_base64, "");
            const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stdio.stdout_base64, "base64")));
            assert.equal(report.producerPid, pid); assert.deepEqual(report.savedSessionFrame, proof.session_frame);
            assert.deepEqual(report.sessionPublication, proof.session_publication);
            const actualRoot = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
            assert.equal(actualRoot.run, row.run); assert.equal(actualRoot.run_instance_id, row.run_instance_id);
            assert.equal(actualRoot.ownerId, row.ownerId); assert.equal(actualRoot.pid, row.pid); assert.equal(actualRoot.state_dir, stateDir);
            const session: SavedSession = proof.session_frame;
            assert.equal(session.state, "persisted"); assert.equal(session.session_id, row.ownerId);
            const sessionRows = (await readFile(session.session_file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
            assert.equal(sessionRows[0].id, session.session_id); assert.equal(sessionRows[0].version, 3); assert.equal(sessionRows[0].cwd, session.cwd);
            assert.equal(sessionRows.filter(entry => entry.type === "message").length, 1);
            assert.equal(sessionRows.find(entry => entry.type === "message")!.message.role, "user");
            assert.equal(session.cwd, join(fixtureDir, "workspace β`\uFEFF\uFFFD"));
            const publication: Publication = proof.session_publication;
            assert.equal(publication.binding_capture_index, 0); assert.match(publication.export_id, /^[a-f0-9]{64}$/u);
            assert.equal(publication.source_scope, "genuine_private_publication_controlled_recorded_session");
            assert.equal(publication.navigation_root, join(agentDir, "tmp", "pi-actors", "runs"));
            const navigation = JSON.parse(await readFile(join(publication.navigation_root, "index.json"), "utf8"));
            assert.deepEqual(navigation.entries, [{ run, run_instance_id: generation, state_dir: stateDir, ownerId: row.ownerId, status: "unknown" }]);
            assert.equal(publication.catalog_path, join(stateDir, "evidence", "sessions.json"));
            assert.equal(publication.preview_path, join(stateDir, "evidence", "sessions", `session-${publication.export_id}.json`));
            const catalogBytes = await readFile(publication.catalog_path), previewBytes = await readFile(publication.preview_path);
            assert.equal(createHash("sha256").update(catalogBytes).digest("hex"), publication.catalog_sha256);
            assert.equal(createHash("sha256").update(previewBytes).digest("hex"), publication.preview_sha256);
            assert.equal(catalogBytes.length, publication.catalog_bytes); assert.equal(previewBytes.length, publication.preview_bytes);
            const catalog = JSON.parse(catalogBytes.toString("utf8")), preview = JSON.parse(previewBytes.toString("utf8"));
            for (const data of [catalog, preview]) { assert.equal(data.run, run); assert.equal(data.run_instance_id, generation); }
            assert.equal(catalog.schema, "run-context-sessions-v1"); assert.equal(preview.schema, "run-context-session-preview-v1");
            assert.equal(catalog.previews[0].export_id, publication.export_id); assert.equal(preview.export_id, publication.export_id);
            assert.equal(preview.command_id, publication.command_id); assert.equal(preview.preview.primary_text, "not_exported");
            assert.deepEqual(preview.preview.coverage, { truncated: true, redacted: true, history_complete: false });
            assert.equal(preview.preview.messages[0].assistant_text, "public-session71");
            assert.deepEqual(proof.metadata_frames, metadataFrames.map(frame => ({ ...frame, pid })));
            for (const frame of metadataFrames) {
              const actual = JSON.parse(await readFile(join(frame.state_dir, "run.json"), "utf8"));
              assert.equal(actual.run, frame.run); assert.equal(actual.run_instance_id, frame.run_instance_id);
              assert.equal(actual.ownerId, frame.ownerId); assert.equal(actual.state_dir, frame.state_dir); assert.equal(actual.pid, pid);
              assert.equal(Object.hasOwn(actual, "ownerId"), Object.hasOwn(frame, "ownerId"));
            }
          } catch (error) { proofErrors.push(error); }
        }
      }
      if (proofErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...proofErrors],
        `Captured fixture runner exit remains unproven; retaining state: ${root}`);
      assertFreshFixtureRunnerAbsence(captured, root, primaryError);
      if (primaryError) throw new AggregateError([primaryError], `Private context fixture failed; retaining state: ${root}`);
      // The original holder is freshly absent before a separate SDK process receives data, never producer keys.
      let readerPid: number | undefined, readerClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let readerEvidence: Promise<{ stdout: Buffer; stderr: Buffer; error: unknown }> | undefined, readerFailure: unknown;
      try {
        const handoff: { session_frame: SavedSession; session_publication: Publication } = JSON.parse(await readFile(manifest, "utf8"));
        const publication = handoff.session_publication;
        const frames: ResearchFrame[] = [{ run, run_instance_id: generation, ownerId: handoff.session_frame.session_id, state_dir: stateDir }];
        const files = [join(publication.navigation_root, "index.json"), publication.catalog_path, publication.preview_path,
          ...["run.json", "context-index.json", "result.json", "execution.json", "trace.jsonl", "controls.jsonl", "progress.json"].map(leaf => join(stateDir, leaf))];
        const before = await Promise.all(files.map(async path => { try { return await readFile(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
        } }));
        assert.equal(before[5], undefined); // No baseline terminal result is invented for the metadata-only publisher.
        const input: { packageDir: string; agentDir: string; layout: "source" | "packed"; phase: "published_research";
          sessionFile: string; sessions: string[]; frames: ResearchFrame[]; publication: Publication; manifest: string } = {
          packageDir, agentDir, layout, phase: "published_research", sessionFile: handoff.session_frame.session_file,
          sessions: [handoff.session_frame.session_id, randomUUID()], frames, publication, manifest: join(fixtureDir, "research-manifest.json") };
        const inputPath = join(fixtureDir, "research-input.json"); await writeFile(inputPath, JSON.stringify(input));
        assertFreshFixtureRunnerAbsence(captured, root);
        const pending: Promise<{ stdout: Buffer; stderr: Buffer }> & { child: ChildProcess } = execFileAsync(process.execPath,
          ["--experimental-strip-types", join(process.cwd(), "tests", "fixtures", "session-navigation-sdk.mjs"), inputPath],
          { cwd: root, timeout: 20000, encoding: "buffer", env: { ...process.env, HOME: root, USERPROFILE: root,
            PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" } });
        readerPid = pending.child.pid;
        pending.child.once("close", (code, signal) => { readerClose = { code, signal }; });
        readerEvidence = pending.then(value => ({ ...value, error: undefined as unknown }), error => ({
          stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
          stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
        })).then(async value => {
          try { await writeFile(join(fixtureDir, "research-stdio.json"), JSON.stringify({ pid: readerPid, close: readerClose,
            stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"),
            capture_complete: (value.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })); }
          catch (error) { throw new AggregateError([...(value.error ? [value.error] : []), error], "Published preview reader stdio persistence failed; retaining state"); }
          return value;
        });
        void readerEvidence.catch(() => {});
        writeFileSync(join(fixtureDir, "research-parent-frame.json"), JSON.stringify({ pid: readerPid, sessions: input.sessions, frames,
          session_file: input.sessionFile, publication, host_exit: "not_asserted" }));
        assert.ok(Number.isSafeInteger(readerPid) && Number(readerPid) > 0);
        const result = await readerEvidence; if (result.error) throw result.error;
        assert.deepEqual(readerClose, { code: 0, signal: null }); assert.equal(result.stderr.length, 0);
        const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
        assert.equal(report.pid, readerPid); assert.equal(report.layout, layout); assert.equal(report.phase, "published_research");
        assert.equal(report.composition, "genuine_private_published_history"); assert.equal(report.previewFixture, "genuine_private_publication_controlled_recorded_source");
        assert.equal(report.workloads, 0); assert.equal(report.originalProducerKeys, 0); assert.equal(report.sdkJourneys, 3); assert.equal(report.ordinaryReads, 0);
        assert.equal(report.publishedSessionCatalogReads, 2); assert.equal(report.selectedSessionPreviewReads, 1);
        assert.equal(report.selectedSessionPreviewReadFailures, 1); assert.equal(report.sourceLossHistoryPreserved, true);
        assert.deepEqual(report.fixtureActions, [{ kind: "selected_preview_hold_restore", path: publication.preview_path,
          held_path: `${publication.preview_path}.fixture-held`, states: ["hold_planned", "held", "restore_planned", "restored"] }]);
        await assert.rejects(access(`${publication.preview_path}.fixture-held`), { code: "ENOENT" });
        assert.equal(report.genuinePublishedPreviewRead, true); assert.equal(report.recordedReadPathsOnly, true);
        assert.deepEqual(report.readLedger.map((entry: { paths: string[] }) => entry.paths.length), [3, 3, 1]);
        const savedRows: Array<{ type: string; message?: { role: string; toolName?: string; isError?: boolean; content?: unknown } }> =
          (await readFile(input.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const failedReads = savedRows.filter(row => row.type === "message" && row.message?.role === "toolResult" && row.message.toolName === "read" && row.message.isError);
        assert.equal(failedReads.length, 1); assert.match(JSON.stringify(failedReads[0].message?.content), /ENOENT|no such file|does not exist/i);
        assert.doesNotMatch(JSON.stringify(failedReads[0].message?.content), /public-session71/);
        assert.equal(report.sessionFile, input.sessionFile);
        assert.deepEqual(JSON.parse(await readFile(input.manifest, "utf8")), { schema: "session-navigation-sdk-v1", phase: input.phase, pid: readerPid,
          host_exit: "not_asserted", workloads: 0, sessions: input.sessions, frames, session_file: input.sessionFile, publication, fixture_actions: report.fixtureActions, complete: true });
        assert.deepEqual(JSON.parse(await readFile(join(fixtureDir, "research-parent-frame.json"), "utf8")), { pid: readerPid, sessions: input.sessions, frames,
          session_file: input.sessionFile, publication, host_exit: "not_asserted" });
        const stdio = JSON.parse(await readFile(join(fixtureDir, "research-stdio.json"), "utf8"));
        assert.equal(stdio.pid, readerPid); assert.deepEqual(stdio.close, readerClose); assert.equal(stdio.capture_complete, true); assert.equal(stdio.stderr_base64, "");
        assert.deepEqual(Buffer.from(stdio.stdout_base64, "base64"), result.stdout);
        for (let index = 0; index < files.length; index++) {
          let after: Buffer | undefined; try { after = await readFile(files[index]); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          assert.deepEqual(after, before[index], `Published preview research changed retained state: ${files[index]}`);
        }
      } catch (error) { readerFailure = error; }
      if (readerEvidence) try { await readerEvidence; } catch (error) {
        readerFailure = readerFailure && readerFailure !== error ? new AggregateError([readerFailure, error], "Published preview reader failed; retaining state") : error;
      }
      if (readerFailure) throw new AggregateError([readerFailure], `Published preview research failed; retaining state: ${root}`);
      assert.ok(Number.isSafeInteger(readerPid) && Number(readerPid) > 0);
      assertFreshFixtureRunnerAbsence([...captured, { pid: readerPid! }], root);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("source and packed private same-runtime producers freeze original natural0/7 timing after finite real work without late sampling", async () => {
  for (const layout of ["source", "packed"]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `pi-actors-${layout}-frozen-`))); const agentDir = join(root, "agent");
    const started: { run: string; generation: string; stateDir: string; manifest: string; pid: number | undefined }[] = []; let primaryError: unknown;
    try {
      const packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      for (const code of [0, 7]) {
        const run = `private-frozen-${code}`; const fixtureDir = join(agentDir, run); const workDir = join(fixtureDir, "workspace β`\uFEFF\uFFFD");
        await mkdir(workDir, { recursive: true }); const generation = randomUUID(); const manifest = join(fixtureDir, "fixture-processes.json");
        await writeFile(manifest, JSON.stringify({ schema: "frozen-natural-fixture-v1", launching: true, complete: false,
          planned: { run, run_instance_id: generation, state_dir: join(fixtureDir, "state") }, captured: [] }));
        const pending = execFileAsync(process.execPath, ["--experimental-strip-types", join(process.cwd(), "tests", "fixtures", "frozen-natural-time.mjs"),
          packageDir, fixtureDir, layout, run, generation, String(code)], {
          cwd: workDir, env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" }, timeout: 20000,
        });
        // Parent birth/frame capture precedes assertions and the first await after spawn.
        const row = { run, generation, stateDir: join(fixtureDir, "state"), manifest, pid: pending.child.pid }; started.push(row);
        void pending.catch(() => {});
        assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 0, "Captured fixture producer PID unavailable; retaining state");
        const { stdout, stderr } = await pending; assert.equal(stderr, ""); const report = JSON.parse(stdout);
        assert.equal(report.layout, layout); assert.equal(report.composition, "private_same_runtime_producer"); assert.equal(report.naturalCode, code);
        assert.equal(report.status, code === 0 ? "done" : "failed"); assert.equal(report.producerPid, row.pid); assert.ok(Number.isSafeInteger(report.workloadPid) && report.workloadPid > 0);
        assert.ok(Number.isSafeInteger(report.elapsedMs) && report.elapsedMs >= 0); assert.equal(report.events, 1);
        assert.equal(report.commandStarts, 1); assert.equal(report.commandReceipts, 1); assert.equal(report.monoReads, 2); assert.equal(report.wallReads, 1);
        for (const flag of ["textAndJson", "stableAfterDelay", "originSamplesBracketWork", "defaultTimingUnproven", "sourceBodyNotPublished"]) assert.equal(report[flag], true, flag);
        assert.equal(report.timers, 0); assert.equal(report.notices, 0);
      }
      assert.equal(started.length, 2);
    } catch (error) { primaryError = error; throw error; }
    finally {
      const captured: { pid: number }[] = []; const proofErrors: unknown[] = [];
      for (const run of started) {
        let proof;
        try { proof = JSON.parse(await readFile(run.manifest, "utf8")); } catch (error) { proofErrors.push(error); }
        const rows = proof?.captured;
        if (proof?.schema !== "frozen-natural-fixture-v1" || proof.complete !== true || proof.launching !== false ||
          !Array.isArray(rows) || rows.length !== 2 || new Set(rows.map((row: { pid: unknown }) => row.pid)).size !== 2 ||
          rows.some((row: { pid?: unknown; role?: string; run?: string; run_instance_id?: string; ownerId?: string; state_dir?: string; exit_observation?: string }) =>
            !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0 || row.run !== run.run || row.run_instance_id !== run.generation ||
            row.ownerId !== "private-frozen-fixture" || row.state_dir !== run.stateDir || !["producer", "workload"].includes(row.role ?? "") ||
            row.exit_observation !== (row.role === "producer" ? "not_asserted" : "fresh_esrch")) ||
          rows.filter((row: { role: string; pid: number }) => row.role === "producer" && row.pid === run.pid).length !== 1 ||
          rows.filter((row: { role: string }) => row.role === "workload").length !== 1) {
          proofErrors.push(Error(`Captured fixture frame/exit evidence is incomplete: ${run.manifest}`));
        } else captured.push(...rows);
      }
      if (proofErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...proofErrors],
        `Captured fixture runner exit remains unproven; retaining state: ${root}`);
      // The child never asserts its own exit. Only this fresh parent ESRCH probe admits deletion.
      assertFreshFixtureRunnerAbsence(captured, root, primaryError);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("source and packed default SDK shutdown stops captured live processes without stopping another logical owner", {
  skip: !["linux", "darwin", "win32"].includes(process.platform) ? "No declared native identity backend for this operating system" : false,
}, async t => {
  for (const layout of ["source", "packed"]) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-" + layout + "-shutdown-")), agentDir = join(root, "agent");
    let primaryError: unknown, pid: number | undefined;
    let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let evidence: { stdout: Buffer; stderr: Buffer; error?: unknown } | undefined;
    let pendingEvidence: Promise<{ stdout: Buffer; stderr: Buffer; error?: unknown }> | undefined;
    try {
      const packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      await mkdir(agentDir, { recursive: true });
      const pending = execFileAsync(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "tests", "test-environment.mjs")).href,
        "--experimental-strip-types", join(process.cwd(), "tests", "fixtures", "coordinator-lifetime-sdk.mjs"),
        packageDir, agentDir, layout, "shutdown"], {
        env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" },
        timeout: 180000, encoding: "buffer",
      });
      pid = pending.child.pid;
      pending.child.once("close", (code, signal) => { close = { code, signal }; });
      pendingEvidence = pending.then(value => ({ ...value, error: undefined as unknown }), error => ({
        stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
        stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
      })).then(async value => {
        try { await writeFile(join(agentDir, "fixture-stdio.json"), JSON.stringify({ pid, close,
          stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"),
          capture_complete: (value.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })); }
        catch (error) { throw new AggregateError([...(value.error ? [value.error] : []), error], "Native shutdown stdio persistence failed; retaining state"); }
        return value;
      });
      void pendingEvidence.catch(() => {});
      assert.ok(Number.isSafeInteger(pid) && Number(pid) > 0, "Captured fixture host PID unavailable; retaining state");
      writeFileSync(join(agentDir, "fixture-parent-host.json"), JSON.stringify({ pid, agent_dir: agentDir, layout, host_exit: "not_asserted" }));
      evidence = await pendingEvidence;
      if (evidence.error) throw evidence.error;
      assert.deepEqual(close, { code: 0, signal: null }); assert.equal(evidence.stderr.length, 0);
      const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence.stdout));
      assert.equal(report.scenario, "shutdown"); assert.equal(report.layout, layout); assert.equal(report.platform, process.platform);
      assert.equal(report.requested_signal, "SIGKILL"); assert.equal(report.fixture_watchdog_ms, 90000);
      assert.equal(report.signal_plan.signalTarget, process.platform === "win32" ? "processTree" : "processGroup");
      if (process.platform === "win32") {
        assert.equal(report.signal_plan.command, "taskkill");
        assert.deepEqual(report.signal_plan.args, ["/PID", String(report.before.owned[0].pid), "/T", "/F"]);
      }
      assert.equal(report.capturedPids, 4); assert.notEqual(report.owned.owner, report.foreign.owner);
      assert.equal(report.whole_scope_closure, "not_asserted"); assert.equal(report.crash_supervision, "not_asserted");
      assert.equal(report.owned.observed_workload_exit, "verified_absence_only");
      if (process.platform === "win32") {
        assert.equal(report.runner_close.signal, null); assert.ok(Number.isSafeInteger(report.runner_close.code));
      } else assert.deepEqual(report.runner_close, { code: null, signal: "SIGKILL" });
      assert.deepEqual(report.foreign_after_owned_shutdown, report.before.foreign);
      assert.deepEqual([report.foreign.terminal_acceptance, report.foreign.code], ["natural", 0]);
      assert.equal(report.shutdown_report.ownerId, report.owned.owner);
      assert.equal(report.shutdown_report.trigger, "session_shutdown:quit");
      assert.deepEqual([report.shutdown_report.attempted, report.shutdown_report.killed, report.shutdown_report.failed], [1, 1, 0]);
      assert.equal(report.shutdown_report.attempts[0].run, report.owned.run);
      assert.equal(report.shutdown_report.attempts[0].runInstanceId, report.owned.generation);
      await assert.rejects(access(report.owned.gate), { code: "ENOENT" });
      const actualReport = JSON.parse(await readFile(join(agentDir, "tmp", "pi-actors", "runs", "teardown", report.shutdown_report.file), "utf8"));
      assert.deepEqual(actualReport, Object.fromEntries(Object.entries(report.shutdown_report).filter(([key]) => key !== "file")));
      for (const [key, outcome] of [["owned", report.owned], ["foreign", report.foreign]] as const) {
        const frames = report.before[key];
        assert.equal(frames.length, 2); assert.deepEqual(frames.map((row: any) => row.role), ["runner", "workload"]);
        const stateDir = join(agentDir, "tmp", "pi-actors", "runs", outcome.run);
        const meta = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
        assert.equal(meta.pid, frames[0].pid); assert.equal(meta.run_instance_id, outcome.generation); assert.equal(meta.ownerId, outcome.owner);
        assert.deepEqual(meta.process_identity, frames[0].identity);
        for (const frame of frames) {
          assert.equal(frame.identity.platform, process.platform);
          if (process.platform === "linux" || frame.identity.cwd !== undefined) assert.equal(frame.identity.cwd, agentDir);
          assert.ok(frame.identity.start_time); assert.ok(frame.identity.command);
        }
        assert.deepEqual(JSON.parse(await readFile(join(agentDir, outcome.run + ".command-1.ready.json.1"), "utf8")),
          { pid: frames[1].pid, command: 1, attempt: 1 });
        const launch = report.launches.find((row: any) => row.run === outcome.run);
        assert.equal(launch.owner, outcome.owner); assert.equal(launch.private_observer, "not_installed");
        assert.equal(launch.loaded_path, join(packageDir, layout === "source" ? "index.ts" : "dist/pi-actors/index.js"));
        assert.equal(launch.resolved_path, launch.loaded_path); assert.equal(launch.skill_read, true);
        assert.equal(launch.runtime_disposed, true); assert.deepEqual(launch.other_spawn_providers, []);
        assert.deepEqual(launch.receipt, { run: outcome.run, ownerId: outcome.owner, state_dir: stateDir,
          pid: frames[0].pid, run_instance_id: outcome.generation, launch_kind: "spawn" });
      }
    } catch (error) { primaryError = error; }
    const proofErrors: unknown[] = []; let captured: { pid: number }[] = [];
    if (pendingEvidence && !evidence) {
      try { evidence = await pendingEvidence; }
      catch (error) { if (error !== primaryError) proofErrors.push(error); }
    }
    try {
      assert.ok(Number.isSafeInteger(pid) && Number(pid) > 0); assert.deepEqual(close, { code: 0, signal: null });
      const host = { pid, agent_dir: agentDir, layout, host_exit: "not_asserted" };
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "fixture-host.json"), "utf8")), host);
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "fixture-parent-host.json"), "utf8")), host);
      const proof = JSON.parse(await readFile(join(agentDir, "fixture-processes.json"), "utf8"));
      assert.equal(proof.scenario, "shutdown"); assert.equal(proof.complete, true); assert.equal(proof.launching, false);
      assert.equal(proof.captured.length, 4); assert.equal(new Set(proof.captured.map((row: any) => row.pid)).size, 4);
      for (const row of proof.captured) {
        assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid !== pid); assert.equal(row.settled, true);
        assert.ok(["sdk-shutdown-owned", "sdk-shutdown-foreign"].includes(row.run));
        if (row.role === "runner") {
          if (row.run === "sdk-shutdown-owned" && process.platform === "win32") {
            assert.equal(row.close?.signal, null); assert.ok(Number.isSafeInteger(row.close?.code));
          } else assert.deepEqual(row.close, row.run === "sdk-shutdown-owned"
            ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null });
        }
      }
      const stdio = JSON.parse(await readFile(join(agentDir, "fixture-stdio.json"), "utf8"));
      assert.equal(stdio.capture_complete, true); assert.equal(stdio.pid, pid); assert.deepEqual(stdio.close, close);
      assert.deepEqual(Buffer.from(stdio.stdout_base64, "base64"), evidence!.stdout);
      assert.deepEqual(Buffer.from(stdio.stderr_base64, "base64"), evidence!.stderr);
      captured = [...proof.captured, { pid: pid! }];
    } catch (error) { proofErrors.push(error); }
    if (primaryError || proofErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...proofErrors],
      "Native shutdown witness incomplete; retaining state: " + root);
    const witness = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence!.stdout));
    t.diagnostic(JSON.stringify({ native_shutdown_witness: { layout, platform: process.platform, host: { pid, close }, before: witness.before,
      owned: witness.owned, foreign: witness.foreign, foreign_after_owned_shutdown: witness.foreign_after_owned_shutdown,
      runner_close: witness.runner_close, requested_signal: witness.requested_signal, signal_plan: witness.signal_plan,
      fixture_watchdog_ms: witness.fixture_watchdog_ms, observation_ms: witness.observation_ms, shutdown_report: witness.shutdown_report,
      loaded_entries: witness.launches.map((launch: any) => launch.loaded_path), deletion_requires_fresh_esrch: true,
      whole_scope_closure: witness.whole_scope_closure, crash_supervision: witness.crash_supervision } }));
    assertFreshFixtureRunnerAbsence(captured, root);
    await removeTreeEventually(root);
  }
});

test("source and packed private coordinator epochs and producer-exit ordinary research keep authority separate", async () => {
  for (const layout of ["source", "packed"]) {
    // A complete-map witness needs a short canonical root; JSON also doubles
    // Windows separators. Long-path omission has a separate bounded-map case.
    // RUNNER_TEMP is CI's owned scratch root, not a substituted filesystem alias.
    const fixtureTemp = process.platform === "darwin" ? "/tmp"
      : process.platform === "win32" ? process.env.RUNNER_TEMP || tmpdir() : tmpdir();
    const prefix = process.platform === "darwin" ? "co" : process.platform === "win32" ? "c" : `co-${layout}-`;
    const root = await realpath(await mkdtemp(join(fixtureTemp, prefix)));
    const agentDir = join(root, "agent");
    const manifest = join(agentDir, "fixture-processes.json"); let primaryError: unknown, pid: number | undefined;
    let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let evidence: Promise<{ stdout: Buffer; stderr: Buffer; error: unknown }> | undefined;
    let packageDir: string | undefined, entrypointPath: string | undefined, sessionFile: string | undefined, ownerSession: string | undefined;
    let actorCoordinator: { owner: string; session_file: string } | undefined;
    try {
      packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      const packageManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")); assert.equal(packageManifest.pi.extensions.length, 1);
      entrypointPath = join(packageDir, layout === "source" ? "index.ts" : packageManifest.pi.extensions[0]);
      await mkdir(agentDir, { recursive: true }); await writeFile(manifest, JSON.stringify({ complete: false }));
      const pending = execFileAsync(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "tests", "test-environment.mjs")).href, "--experimental-strip-types",
        join(process.cwd(), "tests", "fixtures", "coordinator-lifetime-sdk.mjs"), packageDir, agentDir, layout], {
        env: { ...process.env, HOME: root, PI_ACTORS_AUTOMATIC_REVIEW: "off", PI_CODING_AGENT_DIR: agentDir, USERPROFILE: root },
        timeout: process.platform === "win32" ? 180000 : 30000, encoding: "buffer",
      });
      pid = pending.child.pid; // Exact host birth before assertions or await; child captures its own frame before Kernel imports.
      pending.child.once("close", (code, signal) => { close = { code, signal }; });
      evidence = pending.then(value => ({ ...value, error: undefined as unknown }), error => ({
        stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
        stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
      })).then(async value => {
        try { await writeFile(join(agentDir, "fixture-stdio.json"), JSON.stringify({ pid, close,
          stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"),
          capture_complete: (value.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })); }
        catch (error) { throw new AggregateError([...(value.error ? [value.error] : []), error], "Coordinator fixture stdio persistence failed; retaining state"); }
        return value;
      });
      void evidence.catch(() => {});
      writeFileSync(join(agentDir, "fixture-parent-host.json"), JSON.stringify({ pid, agent_dir: agentDir, layout, host_exit: "not_asserted" }));
      assert.ok(Number.isSafeInteger(pid) && Number(pid) > 0, "Captured fixture host PID unavailable; retaining state");
      const result = await evidence; if (result.error) throw result.error;
      assert.deepEqual(close, { code: 0, signal: null }); assert.equal(result.stderr.length, 0);
      const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
      assert.equal(report.layout, layout); assert.equal(report.genuineRuns, 10); assert.equal(report.capturedPids, 25);
      assert.equal(report.catalogRegistered, 9); assert.equal(report.catalogRefusedWithoutLaunchFailure, 1);
      sessionFile = report.sessionFile; ownerSession = report.ownerSession;
      assert.equal(typeof sessionFile, "string"); assert.equal(typeof ownerSession, "string");
      assert.equal(JSON.parse((await readFile(sessionFile!, "utf8")).split("\n")[0]).id, ownerSession);
      actorCoordinator = { owner: report.actorSessionLaunch.owner, session_file: report.actorSessionLaunch.session_file };
      assert.notEqual(actorCoordinator.owner, ownerSession); assert.notEqual(actorCoordinator.session_file, sessionFile);
      assert.equal(JSON.parse((await readFile(actorCoordinator.session_file, "utf8")).split("\n")[0]).id, actorCoordinator.owner);
      for (const launch of [report.entrypointLaunch, report.parallelLaunch, report.degradedLaunch, report.unusableLaunch, report.actorSessionLaunch]) {
        const expectedSession: { owner: string | undefined; session_file: string | undefined } =
          launch === report.actorSessionLaunch ? actorCoordinator : { owner: ownerSession, session_file: sessionFile };
        assert.equal(launch.owner, expectedSession.owner); assert.equal(launch.session_file, expectedSession.session_file);
        assert.equal(launch.loaded_path, entrypointPath); assert.equal(launch.resolved_path, entrypointPath);
        assert.ok(launch.registered_tools.includes("spawn")); assert.deepEqual(launch.other_spawn_providers, []);
        for (const event of ["session_start", "session_shutdown", "before_agent_start", "context", "turn_end", "agent_settled"]) assert.ok(launch.handlers.includes(event));
        assert.equal(launch.skill_read, true); assert.equal(launch.runtime_disposed, true); assert.equal(launch.private_observer, "not_installed");
        assert.deepEqual(launch.events.map((event: { type: string; name: string }) => [event.type, event.name]),
          [["tool_execution_start", "read"], ["tool_execution_end", "read"], ["tool_execution_start", "spawn"], ["tool_execution_end", "spawn"]]);
        assert.equal(launch.events[0].path, join(packageDir!, layout === "source" ? "skills" : "dist/skills", "actors", "SKILL.md"));
        assert.equal(launch.events[0].id, launch.events[1].id); assert.equal(launch.events[2].id, launch.events[3].id);
        assert.equal(launch.events[1].is_error, false); assert.equal(launch.events[3].is_error, false);
      }
      assert.equal(report.entrypointLaunch.run, "sdk-lifetime-entrypoint"); assert.equal(report.parallelLaunch.run, "sdk-lifetime-parallel");
      assert.equal(report.entrypointLaunch.events[2].template, "{node} {script}");
      assert.deepEqual(report.parallelLaunch.events[2].template, { parallel: true, template: ["{node} {script_1}", "{node} {script_2}"] });
      assert.equal(report.naturalParallel.run, "sdk-lifetime-parallel"); assert.equal(report.naturalParallel.root_code, 0);
      assert.deepEqual(report.naturalParallel.codes, [0, 0]); assert.equal(new Set(report.naturalParallel.command_ids).size, 2);
      assert.equal(report.degradedLaunch.run, "sdk-lifetime-degraded");
      assert.deepEqual(report.degradedLaunch.events[2].template, report.parallelLaunch.events[2].template);
      assert.equal(report.naturalDegraded.run, "sdk-lifetime-degraded"); assert.equal(report.naturalDegraded.root_code, 0);
      assert.deepEqual(report.naturalDegraded.codes, [7, 0]); assert.deepEqual(report.naturalDegraded.native_codes, [7, 0]);
      assert.deepEqual(report.naturalDegraded.statuses, ["failed", "done"]); assert.equal(new Set(report.naturalDegraded.command_ids).size, 2);
      assert.equal(report.unusableLaunch.run, "sdk-lifetime-unusable");
      assert.deepEqual(report.unusableLaunch.events[2].template, { ...report.parallelLaunch.events[2].template, failure: "branch" });
      assert.equal(report.naturalUnusable.run, "sdk-lifetime-unusable"); assert.equal(report.naturalUnusable.root_code, 7);
      assert.equal(report.naturalUnusable.failure_reason, "all_branches_unusable");
      assert.deepEqual(report.naturalUnusable.soft_quorum, { coverage: 0, degraded: true, done: 0, expected: 2, failed: 2, usable: false });
      assert.deepEqual(report.naturalUnusable.codes, [7, 7]); assert.deepEqual(report.naturalUnusable.native_codes, [7, 7]);
      assert.deepEqual(report.naturalUnusable.statuses, ["failed", "failed"]); assert.equal(new Set(report.naturalUnusable.command_ids).size, 2);
      for (const [launch, outcome] of [[report.parallelLaunch, report.naturalParallel], [report.degradedLaunch, report.naturalDegraded], [report.unusableLaunch, report.naturalUnusable]]) {
        const overlap = launch.overlap;
        assert.equal(overlap.state, "both_live_before_release"); assert.deepEqual(overlap.members.map((row: { command: number; attempt: number }) => [row.command, row.attempt]), [[1, 1], [2, 1]]);
        assert.deepEqual(overlap.live_probes, overlap.members.map((row: { pid: number }) => row.pid));
        assert.deepEqual(overlap.gates, [1, 2].map(command => ({ path: join(agentDir, `${launch.run}.command-${command}.release.1`), absent: true })));
        assert.deepEqual(outcome.workload_pids, overlap.live_probes);
      }
      assert.equal(report.privateToolContexts, 5); assert.equal(report.privateShutdownContexts, 6);
      assert.equal(report.naturalComposition.run, "sdk-lifetime-composition"); assert.equal(report.naturalComposition.root_code, 0);
      assert.deepEqual(report.naturalComposition.codes, [0, 0]); assert.equal(report.naturalComposition.command_ids.length, 2);
      assert.equal(new Set(report.naturalComposition.command_ids).size, 2);
      assert.equal(report.naturalComposition.workload_pids.length, 2);
      assert.equal(report.naturalRetry.run, "sdk-lifetime-retry"); assert.equal(report.naturalRetry.root_code, 0);
      assert.deepEqual(report.naturalRetry.attempt_codes, [7, 0]); assert.deepEqual(report.naturalRetry.native_codes, [7, 0]);
      assert.equal(report.naturalRetry.workload_pids.length, 2);
      assert.deepEqual(report.naturalFailure, { run: "sdk-lifetime-failure", code: 7, native_exit_code: 7,
        stderr_bytes: Buffer.byteLength("finite SDK failure stderr 😀") });
      assert.equal(report.sameIdForeignManagerRejected, true); assert.equal(report.oldOriginNotReconstructed, true);
      assert.equal(report.controllerTimers, 0); assert.equal(report.deadlineNotices, 0);
      assert.ok(report.busySnapshots >= 5); assert.equal(report.idleSnapshots, 5);
      assert.equal(report.activeProof.length, 5); assert.ok(report.activeProof.every((value: string) => ["supported", "unproven"].includes(value)));
      if (process.platform === "linux") assert.deepEqual(report.activeProof, ["supported", "supported", "supported", "supported", "supported"]);
    } catch (error) { primaryError = error; }
    const proofErrors: unknown[] = []; let captured: { pid: number }[] = [];
    if (evidence) { try { await evidence; } catch (error) { if (error !== primaryError) proofErrors.push(error); } }
    try {
      assert.ok(Number.isSafeInteger(pid) && Number(pid) > 0); assert.deepEqual(close, { code: 0, signal: null });
      const host = { pid, agent_dir: agentDir, layout, host_exit: "not_asserted" };
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "fixture-host.json"), "utf8")), host);
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "fixture-parent-host.json"), "utf8")), host);
      const stdio = JSON.parse(await readFile(join(agentDir, "fixture-stdio.json"), "utf8"));
      assert.equal(stdio.pid, pid); assert.deepEqual(stdio.close, close); assert.equal(stdio.capture_complete, true); assert.equal(stdio.stderr_base64, "");
      const actualHostCapture = await evidence!;
      assert.deepEqual(Buffer.from(stdio.stdout_base64, "base64"), actualHostCapture.stdout);
      assert.deepEqual(Buffer.from(stdio.stderr_base64, "base64"), actualHostCapture.stderr);
      const proof = JSON.parse(await readFile(manifest, "utf8"));
      const runs = new Set(["sdk-lifetime-spawn", "sdk-lifetime-async", "sdk-lifetime-failure", "sdk-lifetime-retry", "sdk-lifetime-composition", "sdk-lifetime-entrypoint", "sdk-lifetime-parallel", "sdk-lifetime-degraded", "sdk-lifetime-unusable", "sdk-lifetime-actor-session"]);
      assert.equal(proof.schema, "coordinator-sdk-fixture-v1"); assert.equal(proof.complete, true); assert.equal(proof.launching, false);
      assertCapturedFixtureLifetimes(proof.captured, 25);
      for (const row of proof.captured) {
        assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid !== pid); assert.equal(row.settled, true);
        assert.ok(runs.has(row.run)); assert.ok(["runner", "workload"].includes(row.role));
        assert.equal(typeof row.run_instance_id, "string"); assert.ok(row.run_instance_id); assert.equal(typeof row.ownerId, "string"); assert.ok(row.ownerId);
        assert.equal(row.state_dir, join(agentDir, "tmp", "pi-actors", "runs", row.run));
        const meta = JSON.parse(await readFile(join(row.state_dir, "run.json"), "utf8"));
        assert.equal(meta.run, row.run); assert.equal(meta.run_instance_id, row.run_instance_id); assert.equal(meta.ownerId, row.ownerId); assert.equal(meta.state_dir, row.state_dir);
        if (row.role === "runner") assert.equal(meta.pid, row.pid);
        else {
          assert.ok(Number.isSafeInteger(row.command) && row.command > 0); assert.ok(Number.isSafeInteger(row.attempt) && row.attempt > 0);
          assert.deepEqual(JSON.parse(await readFile(join(agentDir, `${row.run}.command-${row.command}.ready.json.${row.attempt}`), "utf8")),
            { pid: row.pid, command: row.command, attempt: row.attempt });
        }
      }
      for (const run of runs) {
        const rows = proof.captured.filter((row: { run: string }) => row.run === run);
        assert.equal(new Set(rows.map((row: { run_instance_id: string }) => row.run_instance_id)).size, 1);
        assert.deepEqual(rows.map((row: { role: string }) => row.role).sort(), ["sdk-lifetime-retry", "sdk-lifetime-composition", "sdk-lifetime-parallel", "sdk-lifetime-degraded", "sdk-lifetime-unusable"].includes(run) ? ["runner", "workload", "workload"] : ["runner", "workload"]);
        assert.deepEqual(rows.filter((row: { role: string }) => row.role === "workload").map((row: { command: number; attempt: number }) => [row.command, row.attempt]).sort(),
          ["sdk-lifetime-composition", "sdk-lifetime-parallel", "sdk-lifetime-degraded", "sdk-lifetime-unusable"].includes(run) ? [[1, 1], [2, 1]] : run === "sdk-lifetime-retry" ? [[1, 1], [1, 2]] : [[1, 1]]);
      }
      const summary = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stdio.stdout_base64, "base64")));
      assert.deepEqual(summary.naturalRetry.workload_pids, proof.captured.filter((row: { run: string; role: string }) => row.run === "sdk-lifetime-retry" && row.role === "workload")
        .map((row: { pid: number }) => row.pid));
      assert.deepEqual(summary.naturalComposition.workload_pids, proof.captured.filter((row: { run: string; role: string }) => row.run === "sdk-lifetime-composition" && row.role === "workload")
        .map((row: { pid: number }) => row.pid));
      assert.deepEqual(proof.public_launches, [summary.entrypointLaunch, summary.parallelLaunch, summary.degradedLaunch, summary.unusableLaunch, summary.actorSessionLaunch]);
      for (const launch of proof.public_launches) {
        const runner = proof.captured.find((row: { run: string; role: string }) => row.run === launch.run && row.role === "runner"); assert.ok(runner);
        assert.deepEqual(launch.receipt, { run: runner.run, run_instance_id: runner.run_instance_id, pid: runner.pid,
          ownerId: runner.ownerId, state_dir: runner.state_dir, launch_kind: "spawn" });
      }
      for (const [launch, outcome] of [[summary.parallelLaunch, summary.naturalParallel], [summary.degradedLaunch, summary.naturalDegraded], [summary.unusableLaunch, summary.naturalUnusable]]) {
        assert.deepEqual(launch.overlap.members, proof.captured.filter((row: { run: string; role: string }) => row.run === launch.run && row.role === "workload")
          .map(({ pid, command, attempt }: { pid: number; command: number; attempt: number }) => ({ pid, command, attempt })));
        const execution = JSON.parse(await readFile(join(agentDir, "tmp", "pi-actors", "runs", launch.run, "execution.json"), "utf8"));
        assert.deepEqual(outcome.command_ids, execution.commands.map((command: { id: string }) => command.id));
      }
      const compositionExecution = JSON.parse(await readFile(join(agentDir, "tmp", "pi-actors", "runs", "sdk-lifetime-composition", "execution.json"), "utf8"));
      assert.deepEqual(summary.naturalComposition.command_ids, compositionExecution.commands.map((command: { id: string }) => command.id));
      captured = [...proof.captured, { pid: pid! }];
    } catch (error) { proofErrors.push(error); }
    if (primaryError || proofErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...proofErrors],
      `Captured fixture runner exit remains unproven; retaining state: ${root}`);
    // Research starts only after fresh absence of the actual producer host and its controlled runner/workloads.
    assertFreshFixtureRunnerAbsence(captured, root);
    let readerPid: number | undefined, readerClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let readerEvidence: Promise<ResearchCapture> | undefined, readerRejectionObserved = false;
    const readerFailures: unknown[] = [];
    try {
      const proof = JSON.parse(await readFile(manifest, "utf8"));
      const frames = proof.captured.filter((row: { role: string }) => row.role === "runner").map((row: {
        run: string; run_instance_id: string; ownerId: string; state_dir: string;
      }) => ({ run: row.run, run_instance_id: row.run_instance_id, ownerId: row.ownerId, state_dir: row.state_dir }));
      assert.equal(frames.length, 10); assert.equal(frames.every((row: { run: string; ownerId: string }) => row.ownerId === (row.run === "sdk-lifetime-actor-session" ? actorCoordinator!.owner : ownerSession)), true);
      const catalog = join(agentDir, "tmp", "pi-actors", "runs", "index.json");
      const catalogBefore = await readFile(catalog), rows = JSON.parse(catalogBefore.toString("utf8")).entries;
      assert.deepEqual(rows.map((row: { run: string }) => row.run), ["sdk-lifetime-actor-session", "sdk-lifetime-unusable", "sdk-lifetime-degraded", "sdk-lifetime-parallel", "sdk-lifetime-entrypoint", "sdk-lifetime-composition", "sdk-lifetime-retry", "sdk-lifetime-failure", "sdk-lifetime-spawn"]); // Failed registration is not backfilled.
      const captureLocations = await Promise.all(frames.map(async (row: { run: string; run_instance_id: string; state_dir: string }) => {
        const execution = JSON.parse(await readFile(join(row.state_dir, "execution.json"), "utf8"));
        assert.equal(execution.run, row.run); assert.equal(execution.run_instance_id, row.run_instance_id);
        const outcome = JSON.parse(await readFile(join(row.state_dir, "result.json"), "utf8")), code = ["sdk-lifetime-failure", "sdk-lifetime-unusable"].includes(row.run) ? 7 : 0;
        const commandCodes = row.run === "sdk-lifetime-unusable" ? [[7], [7]] : row.run === "sdk-lifetime-degraded" ? [[7], [0]] : ["sdk-lifetime-composition", "sdk-lifetime-parallel"].includes(row.run) ? [[0], [0]] : [row.run === "sdk-lifetime-retry" ? [7, 0] : [code]];
        assert.equal(outcome.run_instance_id, row.run_instance_id); assert.equal(outcome.terminal_acceptance, "natural"); assert.equal(outcome.code, code);
        if (["sdk-lifetime-actor-session", "sdk-lifetime-retry", "sdk-lifetime-composition", "sdk-lifetime-parallel", "sdk-lifetime-degraded"].includes(row.run)) {
          assert.equal(outcome.output.text_basis, "actor_response");
          const response = await readFile(outcome.output.source.path, "utf8");
          assert.equal(createHash("sha256").update(response).digest("hex"), outcome.output.source.sha256);
          assert.equal([...response].length, outcome.output.chars_total);
          if (row.run === "sdk-lifetime-actor-session") {
            assert.equal(response, "FINITE_GENUINE_ACTOR_SESSION 😀\n");
            await assert.rejects(readFile(join(row.state_dir, "evidence", "sessions.json")), { code: "ENOENT" });
          } else if (["sdk-lifetime-retry", "sdk-lifetime-composition"].includes(row.run)) {
            const last = execution.commands.at(-1), attempt = last.attempts.at(-1);
            assert.equal(response, await readFile(join(row.state_dir, attempt.stdout.path), "utf8"));
          }
        }
        if (row.run === "sdk-lifetime-unusable") {
          assert.equal(outcome.failure_reason, "all_branches_unusable");
          assert.deepEqual(outcome.soft_quorum, { coverage: 0, degraded: true, done: 0, expected: 2, failed: 2, usable: false });
          assert.match(outcome.error, /all parallel branches failed or produced empty output/);
        }
        assert.equal(execution.commands.length, commandCodes.length); assert.equal(new Set(execution.commands.map((command: { id: string }) => command.id)).size, commandCodes.length);
        return execution.commands.flatMap((command: { id: string; attempts: Array<{ attempt: number; code: number; native_exit_code: number; stdout: { path: string }; stderr: { path: string } }> }, ordinal: number) => {
          assert.match(command.id, /^command-[0-9]{3,}$/u);
          assert.deepEqual(command.attempts.map(attempt => attempt.code), commandCodes[ordinal]);
          assert.deepEqual(command.attempts.map(attempt => attempt.native_exit_code), commandCodes[ordinal]);
          return command.attempts.flatMap((attempt, index) => {
            assert.equal(attempt.attempt, index + 1);
            return (["stdout", "stderr"] as const).map(stream => {
              const relative = `captures/${command.id}/attempt-${String(attempt.attempt).padStart(3, "0")}/${stream}.log`;
              assert.equal(attempt[stream].path, relative); return join(row.state_dir, relative);
            });
          });
        });
      }));
      const actorFrame = frames.find((row: { run: string }) => row.run === "sdk-lifetime-actor-session")!;
      const actorCommand = JSON.parse(await readFile(join(actorFrame.state_dir, "execution.json"), "utf8")).commands[0];
      assert.equal(actorCommand.session_dir, "sessions/command-001"); assert.equal(actorCommand.session_files.length, 1);
      const piCli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      // Detail rendering quotes native Windows paths; compare the invocation,
      // not its platform-dependent display quoting, and bind the session operand.
      assert.deepEqual(splitCommandTemplate(actorCommand.command).slice(0, 4),
        [process.execPath, piCli, "--session-dir", join(actorFrame.state_dir, "sessions", "command-001")]);
      const actorPath = join(actorFrame.state_dir, actorCommand.session_files[0]);
      const actorStarted = JSON.parse(await readFile(join(agentDir, "sdk-lifetime-actor-session.command-1.ready.json.1.session"), "utf8"));
      assert.equal(actorStarted.session_file, actorPath); assert.equal(actorStarted.cwd, agentDir); assert.notEqual(actorStarted.session_id, actorCoordinator!.owner);
      assert.equal(actorStarted.pid, proof.captured.find((row: { run: string; role: string }) => row.run === actorFrame.run && row.role === "workload").pid);
      const actorBytes = await readFile(actorPath); assert.ok(actorBytes.length < 4 * 1024 * 1024);
      const actorLines = new TextDecoder("utf-8", { fatal: true }).decode(actorBytes).split("\n"), actorEntries = actorLines.filter(Boolean).map(line => JSON.parse(line));
      assert.equal(actorEntries[0].type, "session"); assert.equal(actorEntries[0].version, 3); assert.equal(actorEntries[0].id, actorStarted.session_id);
      assert.equal(actorEntries[0].cwd, agentDir);
      assert.equal(actorEntries.filter(entry => entry.type === "message" && entry.message.role === "assistant").length, 1);
      assert.ok(actorEntries.some(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Produce the finite Actor session fixture.")));
      const assistantIndex = actorLines.findIndex(line => line && JSON.parse(line).type === "message" && JSON.parse(line).message.role === "assistant");
      const assistant = JSON.parse(actorLines[assistantIndex]);
      assert.deepEqual(assistant.message.content, [{ type: "text", text: "FINITE_GENUINE_ACTOR_SESSION 😀" }]);
      const actorSession = { run: actorFrame.run, command_id: actorCommand.id, path: actorCommand.session_files[0], session_id: actorStarted.session_id,
        owner: actorCoordinator!.owner, coordinator_file: actorCoordinator!.session_file,
        assistant_line: assistantIndex + 1, assistant_entry_id: assistant.id, assistant_sha256: createHash("sha256").update(actorLines[assistantIndex]).digest("hex") };
      const files = [...frames.flatMap((row: { state_dir: string }) => ["run.json", "result.json", "progress.json", "execution.json", "native-launches.json", "trace.jsonl", "context-index.json"].map(leaf => join(row.state_dir, leaf))), ...captureLocations.flat(), actorPath, join(actorFrame.state_dir, "evidence", "sessions.json")];
      assert.equal(files.length + 1, 103); // Catalog plus exact declared Run/source/absence observations.
      const retained = await Promise.all(files.map(async (path: string) => { try { return await readFile(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
      } }));
      assert.equal(typeof entrypointPath, "string");
      const input = { packageDir, agentDir, layout, sessionFile, phase: "genuine_research", entrypointPath, actorSession, sessions: [ownerSession, randomUUID()], frames,
        registeredRun: "sdk-lifetime-spawn", failedRun: "sdk-lifetime-failure", retryRun: "sdk-lifetime-retry", compositionRun: "sdk-lifetime-composition", entrypointRun: "sdk-lifetime-entrypoint", parallelRun: "sdk-lifetime-parallel", degradedRun: "sdk-lifetime-degraded", unusableRun: "sdk-lifetime-unusable", manifest: join(agentDir, "research-manifest.json") };
      const inputPath = join(agentDir, "research-input.json"); await writeFile(inputPath, JSON.stringify(input));
      assertFreshFixtureRunnerAbsence(captured, root);
      const pending = execFileAsync(process.execPath, ["--experimental-strip-types",
        join(process.cwd(), "tests", "fixtures", "session-navigation-sdk.mjs"), inputPath], { cwd: root, timeout: 20000, encoding: "buffer",
        env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" } });
      readerPid = pending.child.pid;
      pending.child.once("close", (code, signal) => { readerClose = { code, signal }; });
      readerEvidence = pending.then(value => ({ ...value, failed: false, error: undefined, captureComplete: true }), captureResearchRejection)
        .then(value => retainResearchCapture(value, async () => {
          await writeFile(join(agentDir, "research-stdio.json"), JSON.stringify({ pid: readerPid, close: readerClose,
            stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"), capture_complete: value.captureComplete }));
        }, () => { console.error(researchFailureSummary(layout, readerPid, readerClose, value)); }));
      void readerEvidence.catch(() => {});
      writeFileSync(join(agentDir, "research-parent-frame.json"), JSON.stringify({ pid: readerPid, sessions: input.sessions, frames,
        session_file: sessionFile, registered_run: input.registeredRun, failed_run: input.failedRun, retry_run: input.retryRun,
        composition_run: input.compositionRun, entrypoint_run: input.entrypointRun, parallel_run: input.parallelRun, degraded_run: input.degradedRun, unusable_run: input.unusableRun, entrypoint_path: input.entrypointPath, host_exit: "not_asserted" }));
      assert.ok(Number.isSafeInteger(readerPid) && Number(readerPid) > 0);
      const result = await readerEvidence.catch(error => { readerRejectionObserved = true; throw error; });
      if (result.failed) throw result.error;
      assert.deepEqual(readerClose, { code: 0, signal: null }); assert.equal(result.stderr.length, 0);
      const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
      assert.equal(report.pid, readerPid); assert.equal(report.phase, "genuine_research"); assert.equal(report.layout, layout);
      assert.equal(report.composition, "genuine_producer_history");
      assert.equal(report.workloads, 0); assert.equal(report.originalProducerKeys, 0); assert.equal(report.sdkJourneys, 21); assert.equal(report.ordinaryReads, 14);
      assert.equal(report.navigationHandoffJourneys, 18); assert.equal(report.copiedNavigationHandoffIsolated, true);
      assert.equal(report.copiedLaunchLocationsIsolated, true); assert.equal(report.selectedLaunchMetadataReads.length, 2);
      for (const [index, selection] of report.selectedLaunchMetadataReads.entries()) {
        const run = index === 0 ? "sdk-lifetime-async" : input.entrypointRun;
        const frame = frames.find((frame: { run: string }) => frame.run === run)!;
        assert.equal(selection.run, run); assert.equal(selection.run_instance_id, frame.run_instance_id);
        assert.equal(selection.directory, frame.state_dir); assert.equal(selection.path, join(frame.state_dir, "run.json"));
        assert.equal(selection.owner, ownerSession); assert.equal(selection.session_file, sessionFile);
        assert.equal(selection.launch_tool, index === 0 ? "sdk_lifetime_async" : "spawn");
        assert.ok(typeof selection.launch_tool_call_id === "string" && selection.launch_tool_call_id.length > 0);
        assert.deepEqual(selection.actual_read, { path: selection.path, offset: 1, limit: 2000 });
        const raw = await readFile(selection.path); assert.ok(raw.length < 50 * 1024);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(raw); assert.ok(text.split("\n").length < 2000);
        assert.equal(selection.parsed_json_sha256, createHash("sha256").update(JSON.stringify(JSON.parse(text))).digest("hex"));
        assert.equal(rows.some((row: { run: string }) => row.run === run), index !== 0, "The async launch location works without backfilling its refused catalog row");
      }
      assert.equal(report.publishedSessionCatalogReads, 0); assert.equal(report.selectedSessionPreviewReads, 0);
      assert.equal(report.unselectedSessionPreviewReads, 0); assert.equal(report.recordedReadPathsOnly, true);
      assert.equal(report.previewFixture, "not_applicable"); assert.equal(report.readLedger.length, 21);
      assert.deepEqual(report.readLedger.map((entry: { paths: string[] }) => entry.paths.length), [4, 4, 4, 4, 1, 1, 1, 4, 5, 5, 1, 1, 1, 4, 4, 1, 4, 4, 4, 4, 4]);
      assert.deepEqual(report.selectedActorSessionReads, [{ path: actorPath, offset: actorSession.assistant_line, limit: 1 }]);
      assert.equal(report.readLedger.at(-1).owner, actorCoordinator!.owner);
      assert.deepEqual(report.readLedger.at(-1).paths, [join(packageDir!, layout === "source" ? "skills" : "dist/skills", "actors", "SKILL.md"),
        join(actorFrame.state_dir, "result.json"), join(actorFrame.state_dir, "execution.json"), actorPath]);
      assert.equal(report.selectedCaptureReads, 13); assert.equal(report.selectedCaptures.length, 13);
      const stdoutPath = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.registeredRun)][0];
      const stderrPath = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.failedRun)][1];
      const retryStderr = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.retryRun)][1];
      const compositionStderr = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.compositionRun)][3];
      const entrypointStdout = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.entrypointRun)][0];
      const parallelStderr = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.parallelRun)][3];
      const degradedCaptures = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.degradedRun)], degradedStderr = degradedCaptures[1];
      assert.equal((await readFile(degradedCaptures[0])).length, 0);
      assert.equal((await readFile(degradedCaptures[2], "utf8")), "PARALLEL_STDOUT_NOT_SELECTED_2");
      const unusableCaptures = captureLocations[frames.findIndex((row: { run: string }) => row.run === input.unusableRun)], unusableStderr = unusableCaptures[3];
      assert.equal((await readFile(unusableCaptures[0])).length, 0); assert.equal((await readFile(unusableCaptures[2])).length, 0);
      assert.deepEqual(report.selectedCaptures.map((capture: { path: string }) => capture.path), [stdoutPath, stderrPath, retryStderr, compositionStderr, stdoutPath, compositionStderr, entrypointStdout, entrypointStdout, entrypointStdout, entrypointStdout, parallelStderr, degradedStderr, unusableStderr]);
      assert.deepEqual(report.selectedCaptures.map((capture: { run: string; stream: string; code: number; root_code: number; command: number; attempt: number }) =>
        [capture.run, capture.stream, capture.command, capture.attempt, capture.code, capture.root_code]),
        [[input.registeredRun, "stdout", 1, 1, 0, 0], [input.failedRun, "stderr", 1, 1, 7, 7], [input.retryRun, "stderr", 1, 1, 7, 0],
          [input.compositionRun, "stderr", 2, 1, 0, 0], [input.registeredRun, "stdout", 1, 1, 0, 0], [input.compositionRun, "stderr", 2, 1, 0, 0],
          [input.entrypointRun, "stdout", 1, 1, 0, 0], [input.entrypointRun, "stdout", 1, 1, 0, 0],
          [input.entrypointRun, "stdout", 1, 1, 0, 0], [input.entrypointRun, "stdout", 1, 1, 0, 0], [input.parallelRun, "stderr", 2, 1, 0, 0], [input.degradedRun, "stderr", 1, 1, 7, 0], [input.unusableRun, "stderr", 2, 1, 7, 7]]);
      assert.equal(report.actualUnusableRead, true); assert.equal(await readFile(unusableStderr, "utf8"), "finite SDK degraded branch stderr 😀");
      assert.equal(report.actualDegradedRead, true); assert.equal(await readFile(degradedStderr, "utf8"), "finite SDK degraded branch stderr 😀");
      assert.equal(report.actualParallelRead, true); assert.equal(await readFile(parallelStderr, "utf8"), "finite SDK parallel second stderr 😀");
      assert.equal(await readFile(entrypointStdout, "utf8"), "finite SDK entrypoint launch fixture"); assert.equal(report.actualEntrypointLaunchRead, true);
      assert.equal(await readFile(compositionStderr, "utf8"), "finite SDK composition second stderr 😀"); assert.equal(report.genuineCompositionRead, true);
      assert.equal(await readFile(retryStderr, "utf8"), "finite SDK retry first stderr 😀");
      assert.equal(report.genuineRetryRead, true);
      for (const capture of report.selectedCaptures) {
        const frame = frames.find((row: { run: string }) => row.run === capture.run); assert.ok(frame);
        assert.equal(capture.path, join(frame.state_dir, "captures", capture.command_id, `attempt-${String(capture.attempt).padStart(3, "0")}`, `${capture.stream}.log`));
        assert.equal(capture.reported_bytes, (await readFile(capture.path)).length);
      }
      assert.equal((await readFile(stderrPath, "utf8")), "finite SDK failure stderr 😀");
      assert.equal(report.genuineFailureRead, true);
      assert.equal(report.sessionCopies.length, 4);
      const entryCopies = report.sessionCopies.filter((copy: { entrypoint: boolean }) => copy.entrypoint);
      assert.equal(entryCopies.length, 2);
      const entryFork = entryCopies.find((copy: { kind: string }) => copy.kind === "fork"), entryClone = entryCopies.find((copy: { kind: string }) => copy.kind === "clone");
      assert.ok(entryFork); assert.ok(entryClone);
      assert.equal(report.entrypointJourneys.length, 15); assert.equal(report.entrypointReadLedger.length, 13);
      assert.deepEqual(report.entrypointReadLedger, report.readLedger.slice(-13));
      assert.deepEqual(report.entrypointReadLedger.map((entry: { owner: string; paths: string[] }) => [entry.owner, entry.paths.length]),
        [[ownerSession, 5], [ownerSession, 5], [input.sessions[1], 1], [entryFork.session_id, 1], [entryClone.session_id, 1], [ownerSession, 4],
          [ownerSession, 4], [input.sessions[1], 1], [ownerSession, 4], [ownerSession, 4], [ownerSession, 4], [ownerSession, 4], [actorCoordinator!.owner, 4]]);
      const expectedOwners = [ownerSession, ownerSession, input.sessions[1], ownerSession, entryFork.session_id, ownerSession, entryClone.session_id, ownerSession,
        ownerSession, input.sessions[1], ownerSession, ownerSession, ownerSession, ownerSession, actorCoordinator!.owner];
      for (let index = 0; index < report.entrypointJourneys.length; index++) {
        const witness = report.entrypointJourneys[index]; assert.equal(witness.owner, expectedOwners[index]);
        assert.equal(witness.loaded_path, entrypointPath); assert.equal(witness.resolved_path, entrypointPath);
        assert.ok(witness.registered_tools.includes("inspect")); assert.deepEqual(witness.other_inspect_providers, []);
        for (const event of ["session_start", "session_shutdown", "before_agent_start", "context", "turn_end", "agent_settled"]) assert.ok(witness.handlers.includes(event));
        assert.equal(JSON.parse((await readFile(witness.session_file, "utf8")).split("\n")[0]).id, witness.owner);
        if (witness.owner === ownerSession) assert.equal(witness.session_file, sessionFile);
        assert.deepEqual(witness.startup, { owner: witness.owner, session_file: witness.session_file, manager_matches: true });
        assert.deepEqual(witness.shutdowns, [{ reason: [3, 5].includes(index) ? "fork" : [8, 9].includes(index) ? "resume" : "quit", owner: witness.owner, manager_matches: true }]);
      }
      assert.equal(report.liveSessionSwitchIsolated, true); assert.equal(report.liveOriginalSessionRestored, true);
      const foreignFile = report.entrypointJourneys[2].session_file;
      assert.deepEqual(report.sessionSwitches, [
        { phase: "A1", owner: ownerSession, session_file: sessionFile, cwd: agentDir, model_had_original_map: true },
        { phase: "B", owner: input.sessions[1], session_file: foreignFile, cwd: agentDir, model_had_original_map: false,
          previous_owner: ownerSession, previous_context_stale: true, previous_shutdown: { reason: "resume", owner: ownerSession, manager_matches: true } },
        { phase: "A2", owner: ownerSession, session_file: sessionFile, cwd: agentDir, model_had_original_map: true, original_context_still_stale: true,
          previous_owner: input.sessions[1], previous_context_stale: true, previous_shutdown: { reason: "resume", owner: input.sessions[1], manager_matches: true } },
      ]);
      for (const frame of report.sessionSwitches) assert.equal(JSON.parse((await readFile(frame.session_file, "utf8")).split("\n")[0]).id, frame.owner);
      assert.equal(report.forkCloneIsolated, true); assert.equal(report.inheritedNavigationPreserved, true);
      assert.equal(report.entrypointForkCloneIsolated, true); assert.equal(report.entrypointOriginalReopened, true);
      assert.deepEqual(report.sessionCopies.map((copy: { kind: string }) => copy.kind).sort(), ["clone", "clone", "fork", "fork"]);
      assert.equal(new Set(report.sessionCopies.map((copy: { session_id: string }) => copy.session_id)).size, 4);
      for (const copy of report.sessionCopies) {
        assert.ok(copy.session_id !== ownerSession && copy.session_id !== input.sessions[1]);
        assert.equal(copy.parent_session, sessionFile); assert.equal(copy.inherited_navigation, true);
        if (copy.entrypoint) {
          assert.equal(copy.previous_context_stale, true);
          assert.deepEqual(copy.previous_shutdown, { reason: "fork", owner: ownerSession, manager_matches: true });
        }
        const sourceEntries = (await readFile(sessionFile!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const copiedEntries = (await readFile(copy.session_file, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line));
        const header = copiedEntries[0];
        assert.equal(header.id, copy.session_id); assert.equal(header.parentSession, sessionFile);
        const inspections = copiedEntries.filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && ["inspect", "actors_inspect"].includes(entry.message.toolName))
          .flatMap((entry: any) => entry.message.content.filter((block: any) => block.type === "text").map((block: any) => ({ entry, view: JSON.parse(block.text) })));
        const inherited = inspections.find((item: any) => item.view.owner_session === ownerSession && item.view.navigation.items.some((row: any) => row.directory === rows.find((entry: { run: string }) => entry.run === input.registeredRun).state_dir));
        assert.ok(inherited, "Accepted source navigation must survive as history, not be erased to obtain isolation");
        assert.deepEqual(inherited.entry.message.content, sourceEntries.find((entry: any) => entry.id === inherited.entry.id)!.message.content);
        for (const [tool, run] of [["spawn", input.entrypointRun], ["sdk_lifetime_async", "sdk-lifetime-async"]]) {
          const frame = frames.find((row: { run: string }) => row.run === run); assert.ok(frame);
          const receipts = copiedEntries.filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === tool &&
            entry.message.content.some((block: any) => {
              if (block.type !== "text") return false;
              const document = parseDocument(block.text, { version: "1.2", schema: "core", uniqueKeys: true });
              if (document.errors.length || document.warnings.length) return false;
              const metadata = document.toJS(), navigation = metadata?.file_navigation ?? metadata?.run_files;
              return navigation?.state === "available" && navigation.run === run &&
                navigation.run_instance_id === frame.run_instance_id && navigation.directory === frame.state_dir;
            }));
          assert.equal(receipts.length, 1, "Copied history must retain exactly one generation-bound launch receipt");
          const receipt = receipts[0];
          assert.ok(receipt, "Copied history must retain the actual launch location content");
          assert.deepEqual(receipt.message.content, sourceEntries.find((entry: any) => entry.id === receipt.id)!.message.content);
        }
        const ownReply = inspections.find((item: any) => item.view.owner_session === copy.session_id);
        assert.ok(ownReply); assert.deepEqual(ownReply.view.runs, []); assert.deepEqual(ownReply.view.navigation.items, []);
      }
      assert.equal(report.genuineResultRead, true); assert.equal(report.foreignBranchExcluded, true); assert.equal(report.activeSkillRead, true);
      assert.deepEqual(JSON.parse(await readFile(input.manifest, "utf8")), { schema: "session-navigation-sdk-v1", phase: input.phase, pid: readerPid,
        host_exit: "not_asserted", workloads: 0, sessions: input.sessions, frames, session_copies: report.sessionCopies,
        session_file: sessionFile, registered_run: input.registeredRun, failed_run: input.failedRun, retry_run: input.retryRun,
        composition_run: input.compositionRun, entrypoint_run: input.entrypointRun, parallel_run: input.parallelRun, degraded_run: input.degradedRun, unusable_run: input.unusableRun, entrypoint_path: entrypointPath, entrypoint_journeys: report.entrypointJourneys, session_switches: report.sessionSwitches, complete: true });
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "research-parent-frame.json"), "utf8")), { pid: readerPid, sessions: input.sessions, frames,
        session_file: sessionFile, registered_run: input.registeredRun, failed_run: input.failedRun, retry_run: input.retryRun,
        composition_run: input.compositionRun, entrypoint_run: input.entrypointRun, parallel_run: input.parallelRun, degraded_run: input.degradedRun, unusable_run: input.unusableRun, entrypoint_path: entrypointPath, host_exit: "not_asserted" });
      const stdio = JSON.parse(await readFile(join(agentDir, "research-stdio.json"), "utf8"));
      assert.equal(stdio.pid, readerPid); assert.deepEqual(stdio.close, readerClose); assert.equal(stdio.capture_complete, true); assert.equal(stdio.stderr_base64, "");
      assert.deepEqual(Buffer.from(stdio.stdout_base64, "base64"), result.stdout);
      assert.deepEqual(await readFile(catalog), catalogBefore);
      for (let i = 0; i < files.length; i++) {
        let after: Buffer | undefined;
        try { after = await readFile(files[i]); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        assert.deepEqual(after, retained[i], `Research changed Run evidence: ${files[i]}`);
      }
    } catch (error) { readerFailures.push(error); }
    if (readerEvidence && !readerRejectionObserved) try { await readerEvidence; } catch (error) { readerFailures.push(error); }
    if (readerFailures.length) throw new AggregateError(readerFailures, `Actual producer research fixture failed; retaining state: ${root}`);
    assert.ok(Number.isSafeInteger(readerPid) && Number(readerPid) > 0);
    assertFreshFixtureRunnerAbsence([...captured, { pid: readerPid! }], root);
    await rm(root, { recursive: true, force: true });
  }
});

test("source and packed privileged YAML candidate crosses actual SDK planes and reopens the original session", async t => {
  for (const layout of ["source", "packed"]) {
    const evidenceHome = join(process.env.HOME ?? process.env.USERPROFILE ?? tmpdir(), ".pi", "agent", "tmp", "pi-actors", "coordinator", "pr137");
    await mkdir(evidenceHome, { recursive: true });
    const root = await mkdtemp(join(evidenceHome, `f16v2-${layout}-candidate-`));
    const agentDir = join(root, "agent"), manifest = join(agentDir, "fixture-processes.json");
    let hostPid: number | undefined, hostClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let primary: unknown, started = false;
    try {
      const packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      await mkdir(agentDir, { recursive: true }); await writeFile(manifest, JSON.stringify({ complete: false }));
      const pending = execFileAsync(process.execPath, ["--experimental-strip-types",
        join(process.cwd(), "tests", "fixtures", "completion-boundary-sdk.mjs"), packageDir, agentDir, layout, "yaml-candidate"], {
        env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" },
        timeout: process.platform === "win32" ? 900_000 : 300_000, encoding: "buffer",
      });
      hostPid = pending.child.pid; started = true;
      pending.child.once("close", (code, signal) => { hostClose = { code, signal }; });
      const evidence = pending.then(value => ({ ...value, error: undefined as unknown }), error => ({
        stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
        stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
      })).then(async value => {
        try { await writeFile(join(agentDir, "candidate-stdio.json"), JSON.stringify({ pid: hostPid, close: hostClose,
          stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"),
          capture_complete: (value.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })); }
        catch (error) { throw new AggregateError([...(value.error ? [value.error] : []), error], "Candidate stdio persistence failed; retaining state"); }
        return value;
      });
      void evidence.catch(() => {});
      writeFileSync(join(agentDir, "candidate-parent-frame.json"), JSON.stringify({ pid: hostPid, layout, package_dir: packageDir,
        agent_dir: agentDir, profile: "yaml-candidate", host_exit: "not_asserted" }));
      assert.ok(Number.isSafeInteger(hostPid) && Number(hostPid) > 0);
      const result = await evidence;
      if (result.error) throw result.error;
      assert.deepEqual(hostClose, { code: 0, signal: null }); assert.equal(result.stderr.length, 0);
      const proof = JSON.parse(await readFile(manifest, "utf8")); assert.equal(proof.captured.length, 1);
      const reports = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)); assert.equal(reports.length, 1);
      const report = reports[0], witness = report.candidate;
      assert.equal(report.publicSpawns, 1); assert.equal(witness.capture_count, 1); assert.equal(witness.native_entries, 1);
      assert.equal(witness.context_count, 2); assert.equal(witness.provider_count, 2); assert.equal(witness.reopened, true);
      assert.ok(witness.renderer_calls > 0); assert.deepEqual(witness.frame, proof.captured[0]);
      t.diagnostic(JSON.stringify({ root, host_pid: hostPid, host_close: hostClose, ...witness }));
      // Preserve concise evidence outside the success root before its fresh-absence cleanup.
      await writeFile(`${root}-witness.json`, JSON.stringify({ report, proof, hostPid, hostClose }));
      await writeFile(`${root}-stdio.json`, await readFile(join(agentDir, "candidate-stdio.json")));
      await writeFile(`${root}-parent-frame.json`, await readFile(join(agentDir, "candidate-parent-frame.json")));
    } catch (error) { primary = error; throw error; }
    finally {
      if (started) {
        let proof;
        try { proof = JSON.parse(await readFile(manifest, "utf8")); } catch { /* Missing captures never authorize deletion. */ }
        if (proof?.schema !== "primary-sdk-fixture-v1" || proof.complete !== true || proof.launching !== false ||
          !Array.isArray(proof.captured) || proof.captured.length !== 1 || proof.captured.some((run: { pid?: unknown; settled?: unknown }) =>
            !Number.isSafeInteger(run.pid) || Number(run.pid) <= 0 || run.settled !== true)) {
          throw new AggregateError([...(primary ? [primary] : []), Error(`Candidate capture/settlement incomplete; retaining ${root}`)], "Candidate cleanup unproven");
        }
        if (!primary) assert.deepEqual(hostClose, { code: 0, signal: null });
        assertFreshFixtureRunnerAbsence([...proof.captured, { pid: hostPid }], root, primary);
      }
      if (!primary) await rm(root, { recursive: true, force: true });
      else t.diagnostic(`Candidate failure: retained ${root}; host=${hostPid}; close=${JSON.stringify(hostClose)}`);
    }
  }
});

test("source and packed public spawn deliver complete primary sources and overflow inventories through the SDK boundary without status polling", async () => {
  for (const layout of ["source", "packed"]) {
    const root = await mkdtemp(join(tmpdir(), `pi-actors-${layout}-boundary-`));
    const agentDir = join(root, "agent"); const manifest = join(agentDir, "fixture-processes.json");
    const timingModule = "./fixtures/windows-native-timing.mjs";
    const { enrollTiming } = await import(timingModule);
    const timing = enrollTiming(root, `sdk-${layout}`);
    let timingPrimaryFailed = false;
    let requestedTimingPids: number[] = [];
    let fixtureStarted = false; let primaryError: unknown;
    let hostPid: number | undefined, hostClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      const packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      await mkdir(agentDir, { recursive: true });
      await writeFile(manifest, JSON.stringify({ complete: false }));
      fixtureStarted = true;
      const pending = execFileAsync(process.execPath, [
        "--experimental-strip-types", join(process.cwd(), "tests", "fixtures", "completion-boundary-sdk.mjs"), packageDir, agentDir, layout,
      ], {
        env: { ...process.env, ...timing.env, HOME: root, PI_ACTORS_AUTOMATIC_REVIEW: "off", PI_CODING_AGENT_DIR: agentDir, USERPROFILE: root },
        // This watchdog covers the entire87-Run/nine-mode driver, not one workload or native-exit proof.
        timeout: process.platform === "win32" ? 900_000 : 300_000, encoding: "buffer",
      });
      hostPid = pending.child.pid;
      pending.child.once("close", (code, signal) => { hostClose = { code, signal }; });
      const evidence = pending.then(value => ({ ...value, error: undefined as unknown }), error => ({
        stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
        stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
      })).then(async value => {
        try { await writeFile(join(agentDir, "boundary-stdio.json"), JSON.stringify({ pid: hostPid, close: hostClose,
          stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"),
          capture_complete: (value.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })); }
        catch (error) { throw new AggregateError([...(value.error ? [value.error] : []), error], "Boundary SDK stdio persistence failed; retaining state"); }
        return value;
      });
      void evidence.catch(() => {});
      writeFileSync(join(agentDir, "boundary-parent-frame.json"), JSON.stringify({ pid: hostPid, layout, package_dir: packageDir, agent_dir: agentDir,
        host_exit: "not_asserted" }));
      assert.ok(Number.isSafeInteger(hostPid) && Number(hostPid) > 0);
      const result = await evidence;
      if (result.error) { requestedTimingPids = selectSdkFailureTimingPids(result.stderr); throw result.error; }
      assert.deepEqual(hostClose, { code: 0, signal: null }); assert.equal(result.stderr.length, 0);
      const proof = JSON.parse(await readFile(manifest, "utf8")); assert.equal(proof.captured.length, 87);
      const reports = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
      const research = reports[0].terminalResearch; assert.ok(research);
      const frame = proof.captured.find((row: { run: string }) => row.run === research.run); assert.ok(frame);
      assert.equal(research.run_instance_id, frame.run_instance_id); assert.equal(research.directory, frame.state_dir);
      assert.equal(research.path, join(frame.state_dir, "result.json")); assert.equal(research.frozen_packet_reused, true);
      assert.deepEqual(research.actual_read, { path: research.path, offset: 1, limit: 2000 });
      assert.deepEqual(proof.terminal_reads, [{ mode: "tools", owner: research.owner, args: research.actual_read }]);
      const metadata = JSON.parse(await readFile(join(frame.state_dir, "run.json"), "utf8"));
      assert.equal(metadata.ownerId, research.owner); assert.equal(metadata.run_instance_id, research.run_instance_id);
      const rawResult = await readFile(research.path); assert.ok(rawResult.length < 50 * 1024);
      const textResult = new TextDecoder("utf-8", { fatal: true }).decode(rawResult); assert.ok(textResult.split("\n").length < 2000);
      const canonical = JSON.parse(textResult); assert.equal(canonical.code, 0); assert.equal(canonical.terminal_acceptance, "natural");
      assert.equal(canonical.run_instance_id, research.run_instance_id);
      assert.equal(research.parsed_json_sha256, createHash("sha256").update(JSON.stringify(canonical)).digest("hex"));
      for (const report of reports) assert.equal(report.launchNavigationShown + report.launchNavigationUnavailable, report.publicSpawns);
      assert.ok(reports.some((report: any) => report.mode !== "final" && report.launchNavigationShown > 0), "Real compact launch receipts must show observed file references");
      assert.equal(reports[3].primarySourcesRecovered, 40);
      assert.ok(reports[3].omittedPrimarySourcesRecovered > 0 && reports[3].omittedPrimarySourcesRecovered < 40);
      assert.equal(reports[4].syntheticCompanions, 64); assert.equal(reports[4].capturedMembers, 65);
      assert.equal(reports[4].shownMembers, 64); assert.equal(reports[4].omittedMembers, 1);
      assert.equal(reports[4].rowBudgetBasis, "outcomes_before_locations");
      assert.ok(reports[4].projectedBytes > reports[4].rowSelectionBytes && reports[4].projectedBytes <= 48 * 1024);
      assert.ok(reports[4].rowSelectionBytes > 0 && reports[4].withOmittedRowBytes > reports[4].rowSelectionBytes && reports[4].withOmittedRowBytes < 48 * 1024);
      assert.equal(reports[5].workloadCode, 7); assert.equal(reports[5].diagnosticField, "error");
      assert.equal(reports[5].diagnosticCharsShown, 1000); assert.ok(reports[5].diagnosticCharsTotal > reports[5].diagnosticCharsShown);
      assert.equal(reports[6].artifactDeclarationsRecovered, 1800); assert.equal(reports[6].artifactReferencesWithheld, 1);
      assert.ok(reports[6].artifactSourceBytes > 64 * 1024 && reports[6].artifactSourceBytes <= 4 * 1024 * 1024);
      assert.equal(reports[6].fixtureBinaryBytes, 8 * 1024 * 1024); assert.equal(reports[6].fixtureTextBytes, 6 * 1024 * 1024);
      assert.equal(reports[7].missingSources, 3); assert.equal(reports[7].restoredSources, 3); assert.equal(reports[7].reusedBatchContexts, 2);
      assert.deepEqual(reports.map(({ missingSources: _missing, restoredSources: _restored, reusedBatchContexts: _reused,
        workloadCode: _code, diagnosticField: _field, diagnosticCharsTotal: _totalChars, diagnosticCharsShown: _shownChars,
        artifactDeclarationsRecovered: _declarations, artifactReferencesWithheld: _withheld, artifactSourceBytes: _inventoryBytes, fixtureBinaryBytes: _binaryBytes, fixtureTextBytes: _textBytes,
        primarySourcesRecovered: _recovered, omittedPrimarySourcesRecovered: _omitted,
        launchNavigationShown: _navigationShown, launchNavigationUnavailable: _navigationUnavailable, terminalResearch: _terminalResearch,
        syntheticCompanions: _synthetic, capturedMembers: _members, shownMembers: _shown, omittedMembers: _omittedMembers,
        projectedBytes: _bytes, rowSelectionBytes: _rowBytes, rowBudgetBasis: _rowBasis, withOmittedRowBytes: _candidateBytes, ...report }: Record<string, unknown>) => report), [
        { mode: "tools", requests: 3, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 2, publicSpawns: 1 },
        { mode: "final", requests: 3, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 1, publicSpawns: 1 },
        { mode: "overflow", requests: 42, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 40, publicSpawns: 40 },
        { mode: "primary-overflow", requests: 42, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 40, publicSpawns: 40 },
        { mode: "row-limit", requests: 3, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 1, publicSpawns: 1 },
        { mode: "failure", requests: 3, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 1, publicSpawns: 1 },
        { mode: "artifact-large", requests: 3, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 1, publicSpawns: 1 },
        { mode: "source-loss", requests: 4, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 2, publicSpawns: 1 },
        { mode: "session-response", requests: 3, starts: 1, settled: 1, batches: 1, nativeSends: 0, toolExecutions: 1, publicSpawns: 1 },
      ]);
    } catch (error) { timingPrimaryFailed = true; primaryError = error; throw error; }
    finally {
      try { timing.finish({ requestedPids: requestedTimingPids }); } catch (error) {
        throw new AggregateError([...(timingPrimaryFailed ? [primaryError] : []), error], "SDK timing unusable; retaining state");
      }
      if (fixtureStarted) {
        let proof;
        try { proof = JSON.parse(await readFile(manifest, "utf8")); } catch { /* Unreadable/missing capture evidence cannot authorize cleanup. */ }
        if (proof?.schema !== "primary-sdk-fixture-v1" || proof.complete !== true || proof.launching !== false ||
          !Array.isArray(proof.captured) ||
          proof.captured.some((run: { pid?: unknown; settled?: unknown }) => !Number.isSafeInteger(run.pid) || Number(run.pid) <= 0 || run.settled !== true)) {
          const captured = Array.isArray(proof?.captured) ? proof.captured : [];
          const progress = { captured: captured.length, reported_settled: captured.filter((run: { settled?: boolean }) => run?.settled === true).length,
            last_run: captured.at(-1)?.run ?? null, launching: proof?.launching ?? null };
          const error = Error(`Captured fixture runner exit remains unproven; retaining state: ${root}; progress=${JSON.stringify(progress)}`);
          if (primaryError) throw new AggregateError([primaryError, error], error.message);
          throw error;
        }
        assertFreshFixtureRunnerAbsence([...proof.captured, { pid: hostPid }], root, primaryError);
      }
      if (!primaryError) await rm(root, { recursive: true, force: true });
    }
  }
});

test("source and packed SDK resume session-owned root-first catalog navigation without producer capabilities", async () => {
  for (const layout of ["source", "packed"] as const) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `pi-actors-${layout}-session-navigation-`)));
    const agentDir = join(root, "agent β`");
    const sessions = [randomUUID(), randomUUID()];
    const catalog = join(agentDir, "tmp", "pi-actors", "runs");
    type LayoutFrame = { run: string; run_instance_id: string; ownerId: string; state_dir: string; parent_run?: string };
    const frames: LayoutFrame[] = ["parent", "child", "foreign"].map((run, i) => ({ run, run_instance_id: randomUUID(),
      ownerId: sessions[i === 2 ? 1 : 0], state_dir: join(catalog, run) }));
    const priorityAgentDir = join(root, "priority-agent β`"), prioritySessions = [randomUUID(), randomUUID(), randomUUID()];
    const priorityFrames: LayoutFrame[] = ["parent", "child", "failed-grandchild", "healthy", "latest", "foreign"].map(run => ({
      run, run_instance_id: randomUUID(), ownerId: prioritySessions[run === "foreign" ? 1 : 0], state_dir: join(priorityAgentDir, "tmp", "pi-actors", "runs", run),
      ...(["child", "healthy"].includes(run) ? { parent_run: "parent" } : run === "failed-grandchild" ? { parent_run: "child" } : {}) }));
    priorityFrames.push(...["budget-parent", "budget-child", "budget-failed-grandchild", "budget-healthy",
      ...Array.from({ length: 16 }, (_, i) => `budget-latest-${String(i + 1).padStart(2, "0")}`)].map(run => ({
      run, run_instance_id: randomUUID(), ownerId: prioritySessions[2], state_dir: join(priorityAgentDir, "tmp", "pi-actors", "runs", run),
      ...(["budget-child", "budget-healthy"].includes(run) ? { parent_run: "budget-parent" } : run === "budget-failed-grandchild" ? { parent_run: "budget-child" } : {}) })));
    const captured: { pid: number | undefined; phase: string; manifest: string; agent_dir: string; sessions: string[]; frames: LayoutFrame[];
      entrypoint_path?: string; stdout?: Buffer; close?: { code: number | null; signal: NodeJS.Signals | null } }[] = [];
    let primary: unknown;
    try {
      await mkdir(agentDir, { recursive: true });
      const packageDir = layout === "packed" ? await preparePackedPackage(root) : process.cwd();
      let sessionFile: string | undefined, sessionCatalogBytes: Buffer | undefined, previewBytes: Buffer[] | undefined;
      const packageManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
      const entrypointPath = join(packageDir, layout === "source" ? "index.ts" : packageManifest.pi.extensions[0]);
      for (const plan of [{ phase: "initial", agentDir, sessions, frames }, { phase: "resumed", agentDir, sessions, frames },
        { phase: "priority", agentDir: priorityAgentDir, sessions: prioritySessions, frames: priorityFrames }]) {
        const { phase, agentDir, sessions, frames } = plan;
        await mkdir(agentDir, { recursive: true });
        const manifest = join(agentDir, `${phase}-manifest.json`), input = join(agentDir, `${phase}-input.json`);
        await writeFile(input, JSON.stringify({ packageDir, agentDir, layout, sessions, frames, phase, manifest,
          sessionFile: phase === "priority" ? undefined : sessionFile, entrypointPath: phase === "priority" ? entrypointPath : undefined }));
        const pending = execFileAsync(process.execPath, ["--experimental-strip-types",
          join(process.cwd(), "tests", "fixtures", "session-navigation-sdk.mjs"), input], {
          cwd: root, timeout: 20000, encoding: "buffer", env: { ...process.env, HOME: root, USERPROFILE: root,
            PI_CODING_AGENT_DIR: agentDir, PI_ACTORS_AUTOMATIC_REVIEW: "off" } });
        const row: typeof captured[number] = { pid: pending.child.pid, phase, manifest, agent_dir: agentDir, sessions, frames,
          entrypoint_path: phase === "priority" ? entrypointPath : undefined };
        captured.push(row); // Exact native birth and full predeclared identity frame before assertions/await.
        pending.child.once("close", (code, signal) => { row.close = { code, signal }; });
        const evidence = pending.then(value => ({ ...value, error: undefined as unknown }), error => ({
          stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(String(error.stdout ?? "")),
          stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(String(error.stderr ?? "")), error,
        })).then(async value => {
          try { await writeFile(join(agentDir, `${phase}-stdio.json`), JSON.stringify({ pid: row.pid, close: row.close,
            stdout_base64: value.stdout.toString("base64"), stderr_base64: value.stderr.toString("base64"),
            capture_complete: (value.error as NodeJS.ErrnoException | undefined)?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })); }
          catch (error) { throw new AggregateError([...(value.error ? [value.error] : []), error], "Navigation fixture stdio persistence failed; retaining state"); }
          return value;
        });
        void evidence.catch(() => {});
        writeFileSync(join(agentDir, `${phase}-parent-frame.json`), JSON.stringify({ ...row, sessions, frames, host_exit: "not_asserted" }));
        assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 0, "Captured navigation host PID unavailable; retaining state");
        const result = await evidence;
        if (result.error) throw result.error;
        assert.deepEqual(row.close, { code: 0, signal: null }); assert.equal(result.stderr.length, 0);
        row.stdout = result.stdout;
        const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
        assert.equal(report.pid, row.pid); assert.equal(report.phase, phase); assert.equal(report.layout, layout);
        assert.equal(report.composition, "controlled_metadata");
        assert.equal(report.originalProducerKeys, 0); assert.equal(report.workloads, 0); assert.equal(report.controlledDirectories, frames.length);
        assert.equal(report.sdkJourneys, phase === "priority" ? 4 : phase === "initial" ? 1 : 3); assert.equal(report.ordinaryReads, phase === "priority" ? 4 : phase === "initial" ? 1 : 2);
        assert.equal(report.publishedSessionCatalogReads, phase === "priority" ? 0 : 1);
        assert.equal(report.selectedSessionPreviewReads, phase === "priority" ? 0 : 1); assert.equal(report.unselectedSessionPreviewReads, 0);
        assert.equal(report.recordedReadPathsOnly, true);
        assert.equal(report.previewFixture, "controlled_layout_not_publication");
        assert.deepEqual(report.readLedger.map((entry: { paths: string[] }) => entry.paths.length), phase === "priority" ? [2, 2, 2, 2] : phase === "initial" ? [4] : [4, 2, 1]);
        if (phase === "priority") {
          assert.equal(report.entrypointJourneys.length, 4); assert.equal(report.priorityJourneys.length, 4);
          assert.deepEqual(report.entrypointReadLedger, report.readLedger);
          const budgetFile = report.entrypointJourneys[2].session_file;
          assert.notEqual(budgetFile, report.sessionFile);
          for (const [index, witness] of report.entrypointJourneys.entries()) {
            const owner = sessions[index < 2 ? 0 : 2], file = index < 2 ? report.sessionFile : budgetFile;
            assert.equal(witness.owner, owner); assert.equal(witness.session_file, file);
            assert.equal(JSON.parse((await readFile(file, "utf8")).split("\n")[0]).id, owner);
            assert.equal(witness.loaded_path, entrypointPath); assert.equal(witness.resolved_path, entrypointPath);
            assert.ok(witness.registered_tools.includes("inspect")); assert.deepEqual(witness.other_inspect_providers, []);
            for (const event of ["session_start", "session_shutdown", "before_agent_start", "context", "turn_end", "agent_settled"]) assert.ok(witness.handlers.includes(event));
            assert.deepEqual(witness.startup, { owner, session_file: file, manager_matches: true });
            assert.deepEqual(witness.shutdowns, [{ reason: "quit", owner, manager_matches: true }]);
          }
          const [normal, failed] = report.priorityJourneys;
          assert.deepEqual(normal.inventory.map((entry: { run: string }) => entry.run).sort(), ["child", "failed-grandchild", "healthy", "latest", "parent"]);
          assert.deepEqual(failed.inventory, [{ run: "failed-grandchild", status: "failed" }]);
          assert.deepEqual(normal.navigation.items.map((item: { run: string; depth: number }) => [item.run, item.depth]),
            [["latest", 0], ["parent", 0], ["child", 1], ["failed-grandchild", 2], ["healthy", 1]]);
          assert.deepEqual(failed.navigation.items.map((item: { run: string; depth: number }) => [item.run, item.depth]),
            [["parent", 0], ["child", 1], ["failed-grandchild", 2], ["healthy", 1], ["latest", 0]]);
          for (const [index, observation] of report.priorityJourneys.slice(0, 2).entries()) {
            assert.equal(observation.owner, sessions[0]); assert.equal(observation.navigation.total, 5); assert.equal(observation.navigation.omitted, 0);
            assert.deepEqual(observation.navigation.priority, { root_order: index === 0 ? "latest_registration" : "failed_subtrees_first", basis: "observed_failed_rows" });
            assert.equal(Buffer.byteLength(JSON.stringify(observation.navigation)) <= 16384, true);
          }
          const skillPath = join(packageDir, layout === "source" ? "skills" : "dist/skills", "actors", "SKILL.md");
          assert.deepEqual(report.readLedger.map((entry: { paths: string[] }) => entry.paths),
            [[skillPath, join(frames.find(frame => frame.run === "latest")!.state_dir, "result.json")],
              [skillPath, join(frames.find(frame => frame.run === "failed-grandchild")!.state_dir, "result.json")],
              [skillPath, join(frames.find(frame => frame.run === "budget-latest-16")!.state_dir, "result.json")],
              [skillPath, join(frames.find(frame => frame.run === "budget-failed-grandchild")!.state_dir, "result.json")]]);
          const budgetRoots = Array.from({ length: 16 }, (_, i) => `budget-latest-${String(16 - i).padStart(2, "0")}`);
          const budgetTree = ["budget-parent", "budget-child", "budget-failed-grandchild", "budget-healthy"];
          for (const [index, observation] of report.priorityJourneys.slice(2).entries()) {
            const navigation = observation.navigation, fullOrder = index === 0 ? [...budgetRoots, ...budgetTree] : [...budgetTree, ...budgetRoots];
            const depths = index === 0 ? [...budgetRoots.map(() => 0), 0, 1, 2, 1] : [0, 1, 2, 1, ...budgetRoots.map(() => 0)];
            assert.equal(observation.owner, sessions[2]); assert.equal(navigation.total, 20); assert.ok(navigation.omitted > 0);
            assert.equal(navigation.shown, navigation.items.length); assert.equal(navigation.shown + navigation.omitted, 20);
            assert.deepEqual(navigation.items.map((item: { run: string }) => item.run), fullOrder.slice(0, navigation.shown));
            assert.deepEqual(navigation.items.map((item: { depth: number }) => item.depth), depths.slice(0, navigation.shown));
            assert.deepEqual(navigation.priority, { root_order: index === 0 ? "latest_registration" : "failed_subtrees_first", basis: "observed_failed_rows" });
            assert.ok(Buffer.byteLength(JSON.stringify(navigation)) <= 16384);
            assert.deepEqual(observation.inventory.map((row: { run: string }) => row.run).sort(),
              index === 0 ? fullOrder.slice().sort() : ["budget-failed-grandchild"]);
            for (const item of navigation.items) {
              const frame = frames.find(frame => frame.run === item.run)!;
              assert.equal(item.directory, frame.state_dir); assert.equal(item.run_instance_id, frame.run_instance_id);
              assert.deepEqual(item.files.map((file: { role: string }) => file.role),
                ["context_index", "result", "metadata", "execution", "published_sessions", "trace", "control", "stdout", "stderr"]);
              for (const file of item.files) {
                if (!["metadata", "result"].includes(file.role)) { assert.equal(file.state, "missing"); assert.equal(file.path, null); continue; }
                const path = join(frame.state_dir, file.role === "metadata" ? "run.json" : "result.json");
                assert.equal(file.path, path); assert.equal(file.state, "present"); assert.equal(file.bytes_total, (await readFile(path)).length);
              }
            }
            // Independent exact next-row reconstruction from declared layout and baseline bytes, not the Kernel reader/budget code.
            const nextFrame = frames.find(frame => frame.run === fullOrder[navigation.shown])!;
            const next = structuredClone(navigation.items[0]);
            Object.assign(next, { run: nextFrame.run, run_instance_id: nextFrame.run_instance_id, directory: nextFrame.state_dir, depth: depths[navigation.shown] });
            for (const file of next.files) if (file.state === "present") {
              assert.ok(["metadata", "result"].includes(file.role));
              file.path = join(nextFrame.state_dir, file.role === "metadata" ? "run.json" : "result.json");
              const snapshot = report.prioritySnapshots.find((entry: { path: string }) => entry.path === file.path);
              assert.equal(typeof snapshot.before_base64, "string"); file.bytes_total = Buffer.from(snapshot.before_base64, "base64").length;
            }
            const extended = { ...navigation, items: [...navigation.items, next], shown: navigation.shown + 1, omitted: navigation.omitted - 1 };
            assert.ok(Buffer.byteLength(JSON.stringify(extended)) > 16384, "The first omitted whole row must actually exceed the byte budget");
          }
          const expectedSnapshots = [join(agentDir, "tmp", "pi-actors", "runs", "index.json"), ...frames.flatMap(frame =>
            ["run.json", "result.json", "progress.json", "trace.jsonl", "controls.jsonl", "context-index.json"].map(leaf => join(frame.state_dir, leaf)))];
          assert.equal(report.prioritySnapshots.length, 157);
          assert.deepEqual(report.prioritySnapshots.map((snapshot: { path: string }) => snapshot.path), expectedSnapshots);
          for (const snapshot of report.prioritySnapshots) {
            let body: Buffer | undefined;
            try { body = await readFile(snapshot.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            assert.equal(body?.toString("base64") ?? null, snapshot.before_base64);
          }
        } else {
          const catalogBytes = await readFile(join(frames[0].state_dir, "evidence", "sessions.json"));
          const sessionCatalog = JSON.parse(catalogBytes.toString("utf8"));
          assert.equal(sessionCatalog.schema, "run-context-sessions-v1"); assert.equal(sessionCatalog.run, frames[0].run);
          assert.equal(sessionCatalog.run_instance_id, frames[0].run_instance_id); assert.equal(sessionCatalog.inventory_scope, "published_previews");
          assert.equal(sessionCatalog.inventory_complete, false); assert.equal(sessionCatalog.previews_total, 2); assert.equal(sessionCatalog.previews.length, 2);
          assert.deepEqual(sessionCatalog.coverage, { truncated: true, redacted: true, history_complete: false });
          const currentPreviews = await Promise.all(sessionCatalog.previews.map(async (entry: any) => {
            assert.match(entry.export_id, /^[a-f0-9]{64}$/u); assert.equal(entry.path, `evidence/sessions/session-${entry.export_id}.json`);
            const body = await readFile(join(frames[0].state_dir, entry.path)); assert.equal(body.length, entry.bytes_total);
            const view = JSON.parse(body.toString("utf8")); assert.equal(view.run, frames[0].run); assert.equal(view.run_instance_id, frames[0].run_instance_id);
            assert.equal(view.export_id, entry.export_id); assert.deepEqual(view.coverage, sessionCatalog.coverage); return body;
          }));
          assert.equal(JSON.parse(currentPreviews[0].toString("utf8")).preview.messages[0].assistant_text, "CONTROLLED_SELECTED_PREVIEW 😀");
          assert.equal(JSON.parse(currentPreviews[1].toString("utf8")).preview.messages[0].assistant_text, "CONTROLLED_UNSELECTED_PREVIEW_BODY");
          if (sessionCatalogBytes) assert.deepEqual(catalogBytes, sessionCatalogBytes); else sessionCatalogBytes = catalogBytes;
          if (previewBytes) assert.deepEqual(currentPreviews, previewBytes); else previewBytes = currentPreviews;
          await assert.rejects(access(join(frames[0].state_dir, "context-index.json")), { code: "ENOENT" });
        }
        for (const flag of ["realSessionContext", "rootFirst", "mapReadOnly", "foreignBranchExcluded", "missingProducerKeyNotRequired", "activeSkillRead", "freshInventoryStatus"]) assert.equal(report[flag], true, flag);
        sessionFile = report.sessionFile;
        assert.equal(typeof sessionFile, "string");
        assert.equal(JSON.parse((await readFile(sessionFile!, "utf8")).split("\n")[0]).id, sessions[0]);
        assertFreshFixtureRunnerAbsence([{ pid: row.pid! }], root);
      }
    } catch (error) { primary = error; }
    const proofErrors: unknown[] = [];
    for (const row of captured) {
      try {
        const { agent_dir: agentDir, frames, sessions } = row;
        assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 0);
        assert.deepEqual(row.close, { code: 0, signal: null });
        const stdio = JSON.parse(await readFile(join(agentDir, `${row.phase}-stdio.json`), "utf8"));
        const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stdio.stdout_base64, "base64")));
        assert.deepEqual(Buffer.from(stdio.stdout_base64, "base64"), row.stdout);
        assert.deepEqual(JSON.parse(await readFile(row.manifest, "utf8")), { schema: "session-navigation-sdk-v1",
          phase: row.phase, pid: row.pid, host_exit: "not_asserted", workloads: 0, sessions, frames,
          ...(row.phase === "priority" ? { entrypoint_path: row.entrypoint_path, entrypoint_journeys: report.entrypointJourneys,
            priority_maps: report.priorityJourneys, priority_snapshots: report.prioritySnapshots } : {}), complete: true });
        assert.deepEqual(JSON.parse(await readFile(join(agentDir, `${row.phase}-parent-frame.json`), "utf8")), {
          pid: row.pid, phase: row.phase, manifest: row.manifest, agent_dir: agentDir, sessions, frames,
          ...(row.entrypoint_path ? { entrypoint_path: row.entrypoint_path } : {}), host_exit: "not_asserted" });
        assert.equal(stdio.pid, row.pid); assert.deepEqual(stdio.close, row.close); assert.equal(stdio.stderr_base64, "");
        assert.equal(stdio.capture_complete, true);
        assert.equal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stdio.stdout_base64, "base64"))).pid, row.pid);
        for (const frame of frames) {
          const metadata = JSON.parse(await readFile(join(frame.state_dir, "run.json"), "utf8"));
          assert.equal(metadata.run, frame.run); assert.equal(metadata.run_instance_id, frame.run_instance_id);
          assert.equal(metadata.ownerId, frame.ownerId); assert.equal(metadata.state_dir, frame.state_dir); assert.equal(metadata.pid, 0);
          assert.equal(metadata.status, "running");
          const result = JSON.parse(await readFile(join(frame.state_dir, "result.json"), "utf8"));
          assert.equal(result.run_instance_id, frame.run_instance_id); assert.equal(result.code, ["foreign", "failed-grandchild", "budget-failed-grandchild"].includes(frame.run) ? 7 : 0);
          assert.equal(Object.hasOwn(result, "terminal_acceptance"), false);
          const parent = frames.find(row => row.run === (frame.parent_run ?? (frame.run === "child" ? "parent" : undefined)));
          assert.deepEqual(metadata.delivery_parent, parent ? { run: parent.run, run_instance_id: parent.run_instance_id, state_dir: parent.state_dir } : undefined);
        }
      } catch (error) { proofErrors.push(error); }
    }
    if (primary || proofErrors.length || captured.length !== 3) throw new AggregateError([...(primary ? [primary] : []), ...proofErrors],
      `Captured fixture runner exit remains unproven; retaining state: ${root}`);
    assertFreshFixtureRunnerAbsence(captured as { pid: number }[], root);
    await rm(root, { recursive: true, force: true });
  }
});

test("installed validate-recipe resolves explicit file imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-imports-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const recipe = join(root, "recipe.json");
    await writeFile(
      recipe,
      `${JSON.stringify({
        imports: { status: join(packageDir, "skills", "project-work", "recipes", "git-status.json") },
        template: [{ name: "status" }],
      })}\n`,
    );
    const { stdout } = await execFileAsync(process.execPath, [
      join(packageDir, "skills", "actors", "scripts", "validate-recipe.mjs"),
      recipe,
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.passed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
