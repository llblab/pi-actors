/** Mirrors lib/runs-supervision.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  syncBuiltinESMExports,
} from "node:module";
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
import type { RunSupervisionDeadlineObservation } from "../lib/run-supervision.ts";
import type { RunNaturalResultTimingAdmission } from "../lib/runs-results.ts";
import childProcess from "node:child_process";
import type { AsyncRunAdmissionClock } from "../lib/async-runs.ts";

const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-admission-clock-agent-")));
const oldAgent = process.env.PI_CODING_AGENT_DIR; const oldReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
// One root must precede value imports and outlive both serial contract groups.
try {

const { createRunSupervisionClock, captureRunSupervisionTimeOrigin } = await import("../lib/run-supervision.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { readRunSupervisionBinding, createRunSupervisionControllerFromState, createRunSupervisionOwner } = await import("../lib/runs-supervision.ts");
const { captureRunAdmissionSnapshotReferences, admitRunSnapshotReferenceReader } = await import("../lib/runs-context-exports.ts");
const { readProcessIdentity, runProcessIdentityDigest } = await import("../lib/runs-process.ts");
const { RUN_STOP_CLAIM_FILE } = await import("../lib/runs-outcomes.ts");
const { admitRunResultProducer, publishRunResult } = await import("../lib/runs-results.ts");
const { readRunSnapshotFacts } = await import("../lib/runs-status.ts");
const { renderRunSnapshot } = await import("../lib/tools-response.ts");

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Canonical supervision bindings", { concurrency: false }, async () => {
/** Canonical state/clock admission for deadline observation, never native actuation or reconstructed origins. */
const START = Date.parse("2026-01-01T00:00:00.000Z");
function fixture(t: TestContext, maximum: number | null = 1000, report: number | null = null) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-bound-supervision-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { run: "bound-clock", run_instance_id: "generation-a", ownerId: "owner-a" };
  const stateDir = claimRunStateDirectory(join(root, "state"), identity.run); let mono = 0; let epoch = {}; let wall = START;
  let wallReads = 0; let monoReads = 0; let failClock = false; let onObserve: (() => void) | undefined;
  const origin = captureRunSupervisionTimeOrigin({ wallNow: () => { wallReads++; return wall; }, monotonicNow: () => {
    monoReads++; onObserve?.(); if (failClock) throw Error("PRIVATE provider failure"); return { milliseconds: mono, epoch };
  } });
  const clock = createRunSupervisionClock({ report_every_ms: report, max_runtime_ms: maximum }, origin.wall_ms);
  const meta = { ...identity, ...clock, createdAt: clock.started_at, state_dir: stateDir, pid: 0, values: { max_runtime: "999h", secret: "PRIVATE_VALUE" } };
  const metaPath = join(stateDir, "run.json"); const marker = join(stateDir, RUN_STATE_OWNERSHIP_FILE); fs.writeFileSync(metaPath, JSON.stringify(meta));
  const timers: { wake: () => void; delay: number; cancelled: boolean }[] = []; const events: Readonly<RunSupervisionDeadlineObservation>[] = [];
  const ports = { schedule: (wake: () => void, delay: number) => { const timer = { wake, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    onDeadlineDue: (event: Readonly<RunSupervisionDeadlineObservation>) => { events.push(event); } };
  const create = (expected: unknown = identity, supplied: unknown = origin) => createRunSupervisionControllerFromState(stateDir, expected, supplied, ports);
  return { root, stateDir, identity, origin, clock, meta, metaPath, marker, timers, events, ports, create, setMono: (value: number) => { mono = value; },
    setWall: (value: number) => { wall = value; }, changeEpoch: () => { epoch = {}; }, failClock: () => { failClock = true; },
    onObserve: (callback: (() => void) | undefined) => { onObserve = callback; }, reads: () => ({ wall: wallReads, mono: monoReads }) };
}

test("Canonical binding exposes only frozen exact identity and stored clock; observation is readonly and never reads result/role bodies", t => {
  const f = fixture(t); const originals = { openSync: fs.openSync, readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const kill = process.kill; const now = Date.now; const before = fs.readFileSync(f.metaPath); const allowed = new Set([f.metaPath, f.marker]);
  fs.openSync = ((path, ...args) => { assert.equal(allowed.has(String(path)), true); return Reflect.apply(originals.openSync, fs, [path, ...args]); }) as typeof fs.openSync;
  const forbidden = () => assert.fail("Binding read mutated, scanned, probed, or invented current time");
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try {
    const reading = readRunSupervisionBinding(f.stateDir, f.identity); assert.equal(reading.state, "available"); if (reading.state !== "available") return;
    assert.deepEqual(reading.identity, f.identity); assert.deepEqual(reading.clock, f.clock); assert.equal(reading.unchanged(), true);
    assert.equal(Object.isFrozen(reading.clock.supervision), true); assert.doesNotMatch(JSON.stringify(reading), /PRIVATE|values|pid|local_path|process_identity|ownership_token/);
  } finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.metaPath), before); assert.equal(fs.existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Wrong owner/generation, unpublished preparation, absent or malformed clocks never gain a new allowance", t => {
  const f = fixture(t);
  for (const expected of [{ ...f.identity, ownerId: "foreign" }, { ...f.identity, run_instance_id: "generation-b" }, {}]) assert.equal(f.create(expected).state, "unavailable");
  for (const clock of [{}, { started_at: f.clock.started_at }, { ...f.clock, supervision: { ...f.clock.supervision, deadline_at: null } }]) {
    fs.writeFileSync(f.metaPath, JSON.stringify({ ...f.identity, state_dir: f.stateDir, pid: 0, ...clock })); assert.equal(f.create().state, "unavailable");
  }
  fs.writeFileSync(f.metaPath, JSON.stringify(f.meta));
  assert.deepEqual(f.create(f.identity, { ...f.origin }), { state: "unavailable", reason: "origin_unavailable" });
  fs.renameSync(f.metaPath, join(f.stateDir, "prepared-run.json")); assert.equal(f.create().state, "unavailable"); assert.equal(f.timers.length, 0);
});

test("Canonical metadata retains its independent exact UTF-8 input bound and never normalizes malformed bytes", t => {
  const f = fixture(t); const base = { ...f.meta, padding: "" }; const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  const exact = JSON.stringify({ ...base, padding: "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) }); assert.equal(Buffer.byteLength(exact), RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  fs.writeFileSync(f.metaPath, exact); assert.equal(readRunSupervisionBinding(f.stateDir, f.identity).state, "available");
  fs.writeFileSync(f.metaPath, exact + "x"); const open = fs.openSync; let metaOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.metaPath) metaOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(readRunSupervisionBinding(f.stateDir, f.identity).state, "unavailable"); assert.equal(metaOpens, 0); } finally { fs.openSync = open; syncBuiltinESMExports(); }
  const source = Buffer.from(JSON.stringify({ ...f.meta, padding: "X" })); source[source.indexOf('"X"') + 1] = 0xff; fs.writeFileSync(f.metaPath, source);
  assert.equal(readRunSupervisionBinding(f.stateDir, f.identity).state, "unavailable");
});

test("Metadata/source changes on either admission read or after return invalidate the observation without repair", t => {
  const f = fixture(t); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync;
  for (const changedOpen of [1, 2]) {
    fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); const fds = new Map<number, number>(); let opens = 0; let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.metaPath) fds.set(fd, ++opens); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { const result = Reflect.apply(read, fs, [fd, ...args]); if (fds.get(fd) === changedOpen && !changed) { changed = true; fs.renameSync(f.metaPath, f.metaPath + ".old"); fs.writeFileSync(f.metaPath, JSON.stringify({ ...f.meta, run_instance_id: "generation-b" })); } return result; }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.equal(readRunSupervisionBinding(f.stateDir, f.identity).state, "unavailable"); assert.equal(changed, true); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(fds.size, 0); fs.rmSync(f.metaPath + ".old");
  }
  fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); const bound = readRunSupervisionBinding(f.stateDir, f.identity); fs.appendFileSync(f.metaPath, " ");
  if (bound.state === "available") assert.equal(bound.unchanged(), false);
});

test("A valid JSON prefix followed by unread invalid bytes in metadata or marker cannot become canonical clock evidence", t => {
  const f = fixture(t); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync;
  for (const target of [f.metaPath, f.marker]) {
    const prefix = fs.readFileSync(target, "utf8"); fs.writeFileSync(target, prefix + "INVALID_TRAILER"); const fds = new Set<number>();
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === target) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, buffer, offset, length, position) => {
      if (!fds.has(fd)) return Reflect.apply(read, fs, [fd, buffer, offset, length, position]);
      const remaining = Buffer.byteLength(prefix) - Number(position); return remaining <= 0 ? 0 : Reflect.apply(read, fs, [fd, buffer, offset, Math.min(length, remaining), position]);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.equal(readRunSupervisionBinding(f.stateDir, f.identity).state, "unavailable"); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); fs.writeFileSync(target, prefix); }
    assert.equal(fds.size, 0);
  }
});

test("Bound controller rereads real canonical clocks, tolerates non-clock metadata updates and emits only a due observation", t => {
  const f = fixture(t); const reading = f.create(); assert.equal(reading.state, "available"); if (reading.state !== "available") return;
  t.after(() => reading.controller.stop()); assert.equal(f.timers.length, 0); reading.controller.start(); assert.equal(f.timers[0].delay, 1000);
  fs.writeFileSync(f.metaPath, JSON.stringify({ ...f.meta, pid: 12345, status: "done", values: { max_runtime: "1ms" } }));
  const resultPath = join(f.stateDir, "result.json"); fs.writeFileSync(resultPath, "opaque root evidence"); const before = fs.readFileSync(resultPath);
  f.setMono(500); f.timers[0].wake(); assert.equal(reading.controller.snapshot().state, "armed"); assert.equal(f.timers[1].delay, 500);
  f.setMono(1000); f.timers[1].wake(); assert.equal(f.events.length, 1); assert.equal(f.events[0].identity.run_instance_id, f.identity.run_instance_id);
  assert.equal(f.events[0].stop_requested, false); assert.equal(f.events[0].scope_closure, "not_asserted"); assert.deepEqual(fs.readFileSync(resultPath), before);
  assert.equal(fs.existsSync(join(f.stateDir, "stop-claim.json")), false);
});

test("Canonical generation/owner/clock changes fence pending callbacks instead of adopting newer metadata", t => {
  const f = fixture(t);
  for (const replacement of [
    { ...f.meta, run_instance_id: "generation-b" }, { ...f.meta, ownerId: "owner-b" },
    { ...f.meta, ...createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 2000 }, START) },
  ]) {
    fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); f.setMono(0); const reading = f.create(); if (reading.state !== "available") throw Error("Fixture bound controller unavailable");
    reading.controller.start(); const timer = f.timers.at(-1)!; fs.writeFileSync(f.metaPath, JSON.stringify(replacement)); f.setMono(1000); timer.wake();
    assert.equal(reading.controller.snapshot().state, "unproven"); assert.equal(f.events.length, 0); reading.controller.stop();
  }
});

test("A copied same-generation marker or replaced state directory cannot retarget an existing bound controller", t => {
  const f = fixture(t);
  for (const target of [f.marker, f.stateDir]) {
    f.setMono(0); const reading = f.create(); if (reading.state !== "available") throw Error("Fixture bound controller unavailable"); reading.controller.start(); const timer = f.timers.at(-1)!;
    fs.renameSync(target, target + ".held"); if (target === f.marker) fs.copyFileSync(target + ".held", target); else fs.cpSync(target + ".held", target, { recursive: true });
    f.setMono(1000); timer.wake(); assert.equal(reading.controller.snapshot().state, "unproven"); assert.equal(f.events.length, 0); reading.controller.stop();
    fs.rmSync(target + ".held", { recursive: true });
  }
});

test("Ambiguous ancestor aliases cannot start or retarget a controller between same-generation state trees", { skip: process.platform === "win32" }, t => {
  const f = fixture(t); const otherParent = join(f.root, "other-parent"); fs.mkdirSync(otherParent);
  const otherState = claimRunStateDirectory(join(otherParent, "state"), f.identity.run); fs.writeFileSync(join(otherState, "run.json"), JSON.stringify({ ...f.meta, state_dir: otherState }));
  const alias = join(f.root, "pointer"); fs.symlinkSync(f.root, alias, "dir");
  const reading = createRunSupervisionControllerFromState(join(alias, "state"), f.identity, f.origin, f.ports);
  assert.equal(reading.state, "unavailable");
  fs.rmSync(alias); fs.symlinkSync(otherParent, alias, "dir");
  assert.equal(createRunSupervisionControllerFromState(join(alias, "state"), f.identity, f.origin, f.ports).state, "unavailable");
  assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
});

test("Symlinked owner/metadata/state paths and failed metadata descriptor cleanup never admit a binding", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  for (const path of [f.metaPath, f.marker]) {
    fs.renameSync(path, path + ".held"); fs.symlinkSync(path + ".held", path); assert.equal(f.create().state, "unavailable"); fs.rmSync(path); fs.renameSync(path + ".held", path);
  }
  const alias = join(f.root, "alias"); fs.symlinkSync(f.stateDir, alias, "dir"); assert.equal(readRunSupervisionBinding(alias, f.identity).state, "unavailable");
  const open = fs.openSync; const close = fs.closeSync; const fds = new Set<number>(); let opens = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.metaPath) { fds.add(fd); opens++; } return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { const tracked = fds.delete(fd); const result = close(fd); if (tracked) throw Error("PRIVATE close failure"); return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { const reading = f.create(); assert.equal(reading.state, "unavailable"); assert.doesNotMatch(JSON.stringify(reading), /PRIVATE/); }
  finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(opens, 1); assert.equal(fds.size, 0);
});

function admissionCapture(f: ReturnType<typeof fixture>) {
  return Object.freeze({ kind: "run_clock_origin_captured", visibility: "kernel_only", publication: "unpublished", work_started: false,
    state_dir: f.stateDir, identity: Object.freeze({ ...f.identity }), clock: f.clock, origin: f.origin });
}

// Controlled trusted-kernel issuer fixture, not a saved metadata/visibility grant or native work admission.
function referenceAdmission(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  fs.unlinkSync(f.metaPath);
  const metadata = { ...f.meta, cwd: f.root + "/launch link/../β`\uFEFF\uFFFD", outcome_protocol: "run-outcome-v1", ...overrides };
  const references = captureRunAdmissionSnapshotReferences(f.stateDir, metadata, f.origin);
  const capture = { ...admissionCapture(f), snapshot_references: references };
  const publish = (data: unknown = metadata) => fs.writeFileSync(f.metaPath, JSON.stringify(data));
  return { metadata, references, capture, publish };
}

const SNAPSHOT_AT = "2026-01-01T00:00:04.000Z";
function composedFixture(t: TestContext, configure: (f: ReturnType<typeof fixture>) => Record<string, unknown> = () => ({})) {
  const processIdentity = readProcessIdentity(process.pid);
  if (!processIdentity) { t.skip("Captured process identity unsupported on this platform"); return undefined; }
  const f = fixture(t, null); const a = referenceAdmission(f, { cwd: process.cwd(), ...configure(f) });
  const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(a.capture);
  const metadata = { ...a.metadata, pid: process.pid, process_identity: processIdentity };
  const publish = (delta: Record<string, unknown> = {}) => a.publish({ ...metadata, ...delta }); publish();
  const observe = () => owner.observeSnapshot(f.identity, SNAPSHOT_AT);
  const claim = { version: 1, claim_id: "11111111-1111-1111-1111-111111111111", ...f.identity, pid: process.pid,
    process_identity_digest: runProcessIdentityDigest(processIdentity), reason: "manual_kill", requested_at: SNAPSHOT_AT };
  const result = { run_instance_id: f.identity.run_instance_id, terminal_acceptance: "natural", code: 0, completedAt: SNAPSHOT_AT, output: "NEVER_PUBLIC_BODY" };
  return { ...f, a, owner, metadata, publish, observe, claim, result, resultPath: join(f.stateDir, "result.json"), indexPath: join(f.stateDir, "context-index.json") };
}
function snapshotIndex() {
  return { schema: "run-context-index-v1", run: "bound-clock", run_instance_id: "generation-a", updated_at: SNAPSHOT_AT,
    entries: Object.fromEntries(["recipe", "result", "trace", "control", "execution", "artifacts", "sessions", "stdout", "stderr"].map(role => [role, { availability: "pending", path: null }])) as Record<string, Record<string, unknown>> };
}

function naturalFixture(t: TestContext, maximum: number | null = null) {
  const f = fixture(t, maximum); const a = referenceAdmission(f, { cwd: process.cwd() });
  const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(a.capture);
  const metadata = { ...a.metadata, pid: process.pid, process_identity: readProcessIdentity(process.pid) };
  const publishMeta = (delta: Record<string, unknown> = {}) => a.publish({ ...metadata, ...delta }); publishMeta();
  const producer = admitRunResultProducer(f.stateDir).producer;
  const capture = (admission: RunNaturalResultTimingAdmission) => owner.captureNaturalTime(f.identity, producer, admission);
  const publish = (code = 0, observer: (admission: RunNaturalResultTimingAdmission) => unknown = capture) =>
    publishRunResult(f.stateDir, producer, { code }, { naturalResultTiming: observer });
  const observe = () => owner.observeSnapshot(f.identity, SNAPSHOT_AT);
  return { ...f, a, metadata, owner, producer, publishMeta, capture, publish, observe, resultPath: join(f.stateDir, "result.json") };
}

test("Genuine first-natural acceptance freezes the original origin once across owners and renders stable done/failed snapshots", t => {
  for (const code of [0, 7]) {
    const f = naturalFixture(t, 1); const peer = createRunSupervisionOwner(f.ports); t.after(() => peer.close()); peer.onSupervisionClockCaptured(f.a.capture);
    f.setMono(250.75); const before = f.reads(); let token: RunNaturalResultTimingAdmission | undefined;
    assert.equal(f.publish(code, admission => {
      token = admission; const first = f.capture(admission); assert.equal(first.state, "available");
      f.setMono(999); const other = peer.captureNaturalTime(f.identity, f.producer, admission); assert.equal(other.state, "available");
      assert.equal(f.capture(admission).state, "available");
      if (first.state === "available" && other.state === "available") { assert.equal(first.elapsed_ms, 250); assert.equal(other.elapsed_ms, 250); }
    }), true);
    assert.ok(token); assert.equal(f.reads().mono, before.mono + 1); assert.equal(f.reads().wall, before.wall);
    f.setMono(900000); f.setWall(START + 9000000000); f.publishMeta({ pid: 999999999, cwd: "/actor-path", values: { api_key: process.cwd() } });
    const reads = f.reads(); const snapshot = f.observe(); assert.equal(snapshot.state, "available");
    if (snapshot.state === "available") {
      assert.equal(snapshot.snapshot.status, code === 0 ? "done" : "failed"); assert.equal(snapshot.snapshot.elapsed_ms, 250); assert.equal(snapshot.snapshot.cwd, process.cwd());
      for (const format of ["text", "json"] as const) assert.equal(renderRunSnapshot(snapshot.snapshot, format).state, "available");
      assert.equal(snapshot.unchanged(), true);
    }
    assert.deepEqual(f.reads(), reads); assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
    assert.throws(() => f.capture(token!), /active runtime-local admission/); assert.deepEqual(f.reads(), reads);
    f.owner.release(f.identity); assert.equal(f.owner.observeFrozenNaturalTime(f.identity).state, "unavailable");
    const handed = createRunSupervisionOwner(f.ports); t.after(() => handed.close()); handed.onSupervisionClockCaptured(f.a.capture);
    const retained = handed.observeFrozenNaturalTime(f.identity); assert.equal(retained.state, "available"); if (retained.state === "available") assert.equal(retained.elapsed_ms, 250);
    assert.deepEqual(f.reads(), reads);
  }
});

test("Frozen timing rejects copied/foreign/late admission before sampling and never backfills a missed natural event", t => {
  const f = naturalFixture(t); let token: RunNaturalResultTimingAdmission | undefined; const before = f.reads();
  f.setMono(321);
  f.publish(0, admission => {
    token = admission;
    for (const fake of [{ ...admission }, JSON.parse(JSON.stringify(admission))]) assert.throws(() => f.capture(fake), /active runtime-local admission/);
    assert.throws(() => f.owner.captureNaturalTime(f.identity, { ...f.producer }, admission), /active runtime-local admission/);
    assert.deepEqual(f.owner.captureNaturalTime(f.identity, f.producer, admission, f.root), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(f.reads(), before); assert.equal(f.capture(admission).state, "available");
  });
  const sampled = f.reads(); assert.ok(token); assert.throws(() => f.capture(token!), /active runtime-local admission/); assert.deepEqual(f.reads(), sampled);
  const missed = naturalFixture(t); let late: RunNaturalResultTimingAdmission | undefined; missed.publish(7, admission => { late = admission; });
  missed.setMono(1000); const liveAge = missed.owner.observeTime(missed.identity); assert.equal(liveAge.state, "available");
  const observed = missed.reads(); assert.throws(() => missed.capture(late!), /active runtime-local admission/);
  assert.deepEqual(missed.owner.observeFrozenNaturalTime(missed.identity), { state: "unavailable", reason: "natural_time_not_captured" });
  assert.deepEqual(missed.observe(), { state: "unavailable", reason: "timing_unproven" }); assert.deepEqual(missed.reads(), observed);
});

test("The first authorized frozen-time failure stays unproven without repair or a replacement sample", t => {
  for (const fault of ["provider", "reversed", "epoch", "clock"] as const) {
    const f = naturalFixture(t); f.setMono(400);
    if (fault === "provider") f.failClock(); else if (fault === "reversed") f.setMono(-1); else if (fault === "epoch") f.changeEpoch();
    f.publish(0, admission => {
      if (fault === "clock") f.publishMeta({ ...createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 2000 }, START) });
      const before = f.reads(); assert.deepEqual(f.capture(admission), { state: "unavailable", reason: "natural_time_unproven" });
      const failed = f.reads(); assert.equal(failed.mono - before.mono, fault === "clock" ? 0 : 1);
      f.publishMeta(); f.setMono(9000); assert.deepEqual(f.capture(admission), { state: "unavailable", reason: "natural_time_unproven" }); assert.deepEqual(f.reads(), failed);
    });
    assert.deepEqual(f.owner.observeFrozenNaturalTime(f.identity), { state: "unavailable", reason: "natural_time_unproven" });
    assert.deepEqual(f.observe(), { state: "unavailable", reason: "timing_unproven" }); assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
  }
});

test("Frozen capture cannot hide reentrant revocation/frame changes or recursively sample the original clock", t => {
  for (const action of ["stop", "release", "close", "marker", "recursive"] as const) {
    const f = naturalFixture(t); f.setMono(500); let nested: unknown;
    const before = f.reads(); f.publish(0, admission => {
      f.onObserve(() => {
        f.onObserve(undefined);
        if (action === "close") f.owner.close();
        else if (action === "marker") { fs.renameSync(f.marker, f.marker + ".held"); fs.copyFileSync(f.marker + ".held", f.marker); }
        else if (action === "recursive") nested = f.capture(admission);
        else f.owner[action](f.identity);
      });
      const reading = f.capture(admission); assert.equal(reading.state, action === "recursive" ? "available" : "unavailable");
      if (action === "recursive") assert.deepEqual(nested, { state: "unavailable", reason: "natural_time_capturing" });
    });
    assert.equal(f.reads().mono, before.mono + 1); if (action !== "recursive") assert.equal(f.observe().state, "unavailable");
    assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
  }
});

test("Frozen natural reads and fences use only canonical clock/frame metadata, never clocks, native probes, role bytes or writes", t => {
  const f = naturalFixture(t); f.setMono(123.99); f.publish(); const reads = f.reads(); const result = fs.readFileSync(f.resultPath);
  const open = fs.openSync, write = fs.writeFileSync, kill = process.kill, now = Date.now;
  const allowed = new Set([f.metaPath, f.marker]); const forbidden = () => assert.fail("Frozen reading sampled/mutated/probed");
  fs.openSync = ((path, ...args) => { assert.equal(allowed.has(String(path)), true, String(path)); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.writeFileSync = forbidden as typeof fs.writeFileSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try {
    const frozen = f.owner.observeFrozenNaturalTime(f.identity); assert.equal(frozen.state, "available");
    if (frozen.state === "available") { assert.equal(frozen.elapsed_ms, 123); assert.equal(frozen.unchanged(), true); assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.natural_acceptance)); }
    f.owner.snapshot(f.identity); assert.deepEqual(f.reads(), reads);
  } finally { fs.openSync = open; fs.writeFileSync = write; process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.resultPath), result); f.failClock(); f.owner.observeTime(f.identity);
  assert.equal(f.owner.observeFrozenNaturalTime(f.identity).state, "available", "A later clock fault cannot rewrite a previously proven frozen sample");
});

test("Terminal snapshot facts join exactly one canonical natural result with the original frozen time, not defaults or altered acceptance", async t => {
  const f = naturalFixture(t); f.setMono(777); f.publish();
  const defaults = readRunSnapshotFacts(f.stateDir, f.identity, SNAPSHOT_AT); assert.equal(defaults.state, "available");
  if (defaults.state === "available") assert.deepEqual(defaults.facts.timing, { basis: "unproven" });
  const open = fs.openSync; let resultOpens = 0; fs.openSync = ((path, ...args) => { if (String(path) === f.resultPath) resultOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { const reading = f.observe(); assert.equal(reading.state, "available"); assert.equal(resultOpens, 1); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  const original = fs.readFileSync(f.resultPath, "utf8"); const result = JSON.parse(original);
  for (const changed of [{ ...result, code: 7 }, { ...result, completedAt: "2026-01-01T00:00:02.000Z" }]) {
    fs.writeFileSync(f.resultPath, JSON.stringify(changed)); assert.deepEqual(f.observe(), { state: "unavailable", reason: "observation_unavailable" });
  }
  fs.writeFileSync(f.resultPath, original); assert.equal(f.observe().state, "available");
  const frozen = f.owner.observeFrozenNaturalTime(f.identity); assert.equal(frozen.state, "available"); if (frozen.state !== "available") return;
  for (const fence of [() => ({ then: () => assert.fail("Fence then invoked") }), () => Promise.resolve(true), () => 1]) {
    const reading = readRunSnapshotFacts(f.stateDir, f.identity, SNAPSHOT_AT, undefined, () => ({ ...frozen, unchanged: fence }));
    assert.deepEqual(reading, { state: "unavailable", reason: "observation_changed" });
  }
  const forbidden = () => assert.fail("Terminal timing getter/then hook invoked");
  const deferred = Object.defineProperties(Promise.reject(Error("rejected private terminal port")), { then: { get: forbidden }, catch: { get: forbidden } });
  for (const invalid of [Object.defineProperty({ ...frozen }, "elapsed_ms", { get: forbidden }), Object.create({ then: forbidden }), deferred]) {
    assert.deepEqual(readRunSnapshotFacts(f.stateDir, f.identity, SNAPSHOT_AT, undefined, () => invalid), { state: "unavailable", reason: "observation_unavailable" });
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("Frozen timing preserves separate result/sample/observer/Trace effects and never recaptures a failed publication", t => {
  for (const mode of ["before_commit", "after_replace", "observer", "trace", "authority"] as const) {
    const f = naturalFixture(t); f.setMono(600); const before = f.reads(); const failure = Object.assign(Error(`exact frozen ${mode} failure`), { code: "EIO" });
    let token: RunNaturalResultTimingAdmission | undefined; const rename = fs.renameSync, write = fs.writeFileSync;
    fs.renameSync = ((from, to) => { if (String(to) === f.resultPath && (mode === "before_commit" || mode === "after_replace")) {
      if (mode === "after_replace") rename(from, to); throw failure;
    } return rename(from, to); }) as typeof fs.renameSync;
    fs.writeFileSync = ((path, ...args) => { if (mode === "trace" && String(path) === join(f.stateDir, "trace.jsonl")) throw failure;
      return Reflect.apply(write, fs, [path, ...args]); }) as typeof fs.writeFileSync; syncBuiltinESMExports();
    try {
      assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 7 }, { naturalResultTiming: admission => {
        token = admission; if (mode === "authority") f.onObserve(() => { f.onObserve(undefined); f.publishMeta({ ownerId: "foreign" }); });
        f.capture(admission); if (mode === "observer") throw failure;
      }, trace: { kind: "run.failed", data: { code: 7 } } }), error => mode === "authority" ? /producer owner changed/.test(String(error)) : error === failure);
    } finally { fs.renameSync = rename; fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(fs.existsSync(f.resultPath), mode !== "before_commit");
    if (mode !== "before_commit") assert.equal(JSON.parse(fs.readFileSync(f.resultPath, "utf8")).code, 7);
    if (mode === "authority") f.publishMeta(); // Explicit fixture restoration, never product repair.
    const frozen = f.owner.observeFrozenNaturalTime(f.identity);
    assert.equal(frozen.state, mode === "observer" || mode === "trace" ? "available" : "unavailable");
    if (frozen.state === "available") { assert.equal(frozen.elapsed_ms, 600); assert.equal(f.observe().state, "available"); }
    else assert.equal(frozen.reason, mode === "authority" ? "natural_time_unproven" : "natural_time_not_captured");
    assert.equal(f.reads().mono - before.mono, mode === "before_commit" || mode === "after_replace" ? 0 : 1);
    const reads = f.reads(); if (token) assert.throws(() => f.capture(token!), /active runtime-local admission/);
    if (mode !== "before_commit") assert.equal(f.publish(7, () => assert.fail("Duplicate repaired timing")), false);
    assert.deepEqual(f.reads(), reads);
  }
});

test("Frozen timing refuses changed owner/generation/clock and local lifecycle without adopting live metadata", t => {
  for (const change of ["generation", "owner", "clock", "stop", "release", "close"] as const) {
    const f = naturalFixture(t); f.setMono(80); f.publish(); const reads = f.reads();
    if (change === "close") f.owner.close(); else if (change === "stop" || change === "release") f.owner[change](f.identity);
    else f.publishMeta(change === "generation" ? { run_instance_id: "foreign" } : change === "owner" ? { ownerId: "foreign" }
      : { ...createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 2000 }, START) });
    assert.equal(f.owner.observeFrozenNaturalTime(f.identity).state, "unavailable"); assert.equal(f.observe().state, "unavailable"); assert.deepEqual(f.reads(), reads);
  }
});

test("Owner compositor projects only original admitted active/stopping facts, timing and captured references", t => {
  const f = composedFixture(t); if (!f) return; f.setMono(250.75);
  f.publish({ cwd: "/actor-changed-cwd", status: "timed_out", elapsed_ms: 999999, values: { api_key: process.cwd() }, visibility: "public" });
  for (const phase of ["running", "stopping", "captured"]) {
    if (phase !== "running") fs.writeFileSync(join(f.stateDir, RUN_STOP_CLAIM_FILE), JSON.stringify(f.claim));
    if (phase === "captured") fs.writeFileSync(f.resultPath, JSON.stringify({ ...f.result, terminal_acceptance: "after_stop_claim", stop_claim_id: f.claim.claim_id }));
    const before = f.reads(); const reading = f.observe(); assert.equal(reading.state, "available");
    if (reading.state !== "available") return;
    assert.deepEqual(reading.snapshot, { kind: "run_snapshot", run: f.identity.run, run_instance_id: f.identity.run_instance_id,
      captured_at: SNAPSHOT_AT, elapsed_ms: 250, status: "running", ...(phase === "running" ? {} : { phase: "stopping" }),
      cwd: process.cwd(), evidence: null, evidence_error: "index_unavailable" });
    assert.ok(Object.isFrozen(reading) && Object.isFrozen(reading.snapshot)); const after = f.reads();
    assert.equal(after.mono, before.mono + 1); assert.equal(after.wall, before.wall); assert.equal(reading.unchanged(), true); assert.deepEqual(f.reads(), after);
    assert.doesNotMatch(JSON.stringify(reading), /NEVER_PUBLIC_BODY|actor-changed|timed_out|ownerId|process_identity|visibility/);
  }
  assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0); assert.equal(f.owner.snapshot(f.identity).state, "retained");
});

test("Owner compositor distinguishes admitted index, index loss and withheld references without metadata fallback", t => {
  for (const withheld of [false, true]) {
    const f = composedFixture(t, f => withheld ? { values: { api_key: f.stateDir } } : {}); if (!f) return;
    fs.writeFileSync(f.indexPath, JSON.stringify(snapshotIndex())); f.setMono(1234);
    const reading = f.observe(); assert.equal(reading.state, "available");
    if (reading.state !== "available") return;
    assert.equal(reading.snapshot.evidence, withheld ? null : f.indexPath);
    assert.equal(reading.snapshot.evidence_error, withheld ? "index_unavailable" : undefined);
    if (withheld) assert.equal(JSON.stringify(reading).includes(f.stateDir), false);
    fs.unlinkSync(f.indexPath); assert.equal(reading.unchanged(), false);
    const lost = f.observe(); assert.equal(lost.state, "available"); if (lost.state === "available") assert.equal(lost.snapshot.evidence, null);
  }
  const missing = fixture(t); const owner = createRunSupervisionOwner(missing.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(admissionCapture(missing));
  assert.deepEqual(owner.observeSnapshot(missing.identity, SNAPSHOT_AT), { state: "unavailable", reason: "references_not_retained" });
  const hidden = composedFixture(t, f => ({ cwd: f.root + "/CWD_SECRET", values: { api_key: "CWD_SECRET" } })); if (!hidden) return;
  const before = hidden.reads(); const kill = process.kill;
  try { process.kill = (() => assert.fail("Withheld cwd must not admit process/time observation")) as typeof process.kill;
    assert.deepEqual(hidden.observe(), { state: "unavailable", reason: "references_unavailable" }); }
  finally { process.kill = kill; }
  assert.deepEqual(hidden.reads(), before);
});

test("Owner compositor never promotes unknown active proof, clock faults or natural outcomes into invented snapshots", t => {
  const f = composedFixture(t); if (!f) return; const before = f.reads();
  for (const delta of [{ pid: 0 }, { process_identity: undefined }]) { f.publish(delta); assert.deepEqual(f.observe(), { state: "unavailable", reason: "lifecycle_unproven" }); }
  f.publish(); const kill = process.kill;
  try { process.kill = (() => { throw Object.assign(Error("denied"), { code: "EPERM" }); }) as typeof process.kill;
    assert.deepEqual(f.observe(), { state: "unavailable", reason: "lifecycle_unproven" }); }
  finally { process.kill = kill; }
  assert.deepEqual(f.reads(), before);
  for (const code of [0, 7]) {
    fs.writeFileSync(f.resultPath, JSON.stringify({ ...f.result, code })); const now = Date.now;
    try { process.kill = (() => assert.fail("Natural terminal compositor probed process")) as typeof process.kill; Date.now = () => assert.fail("Natural terminal compositor sampled wall time");
      assert.deepEqual(f.observe(), { state: "unavailable", reason: "timing_unproven" }); }
    finally { process.kill = kill; Date.now = now; }
    assert.deepEqual(f.reads(), before);
  }
  fs.unlinkSync(f.resultPath); f.failClock(); assert.deepEqual(f.observe(), { state: "unavailable", reason: "timing_unproven" });
  const fault = f.reads(); assert.deepEqual(f.observe(), { state: "unavailable", reason: "timing_unproven" }); assert.deepEqual(f.reads(), fault);
  for (const at of [undefined, "2026-01-01", { toString() { assert.fail("Timestamp coercion"); } }]) assert.deepEqual(f.owner.observeSnapshot(f.identity, at), { state: "unavailable", reason: "observation_unavailable" });
  assert.deepEqual(f.owner.observeSnapshot(f.identity, SNAPSHOT_AT, f.root), { state: "unavailable", reason: "identity_mismatch" });
});

test("Owner compositor discards interleaved terminal/stop/index changes, native loss and local lifetime revocation", t => {
  for (const action of ["natural", "stop_claim", "index", "stop", "release", "close"] as const) {
    const f = composedFixture(t); if (!f) return;
    f.onObserve(() => { if (action === "natural") fs.writeFileSync(f.resultPath, JSON.stringify(f.result));
      else if (action === "stop_claim") fs.writeFileSync(join(f.stateDir, RUN_STOP_CLAIM_FILE), JSON.stringify(f.claim));
      else if (action === "index") fs.writeFileSync(f.indexPath, JSON.stringify(snapshotIndex()));
      else if (action === "stop") f.owner.stop(f.identity); else if (action === "release") f.owner.release(f.identity); else f.owner.close(); });
    const reading = f.observe(); assert.equal(reading.state, "unavailable"); assert.equal(Object.hasOwn(reading, "snapshot"), false);
  }
  const f = composedFixture(t); if (!f) return; const first = f.observe(); assert.equal(first.state, "available");
  const before = f.reads(); const kill = process.kill; let dead = false;
  try {
    process.kill = ((pid, signal) => { if (pid === process.pid && signal === 0 && dead) throw Object.assign(Error("injected absence"), { code: "ESRCH" }); return kill(pid, signal); }) as typeof process.kill;
    f.onObserve(() => { dead = true; }); assert.deepEqual(f.observe(), { state: "unavailable", reason: "observation_changed" });
    process.kill = (() => assert.fail("Returned fence must not re-probe native liveness")) as typeof process.kill;
    if (first.state === "available") assert.equal(first.unchanged(), true);
  } finally { process.kill = kill; }
  assert.equal(f.reads().mono, before.mono + 1); f.owner.release(f.identity);
  if (first.state === "available") assert.equal(first.unchanged(), false);
});

test("Owner compositor follows no role bodies, mutates nothing and reuses one canonical natural result snapshot", t => {
  const f = composedFixture(t); if (!f) return; fs.writeFileSync(f.resultPath, JSON.stringify(f.result));
  fs.mkdirSync(join(f.stateDir, "evidence")); const role = join(f.stateDir, "evidence", "trace.jsonl"); const body = "PRIVATE_ROLE_BODY"; fs.writeFileSync(role, body);
  const index = snapshotIndex(); index.entries.trace = { availability: "available", path: "evidence/trace.jsonl", media_type: "application/x-ndjson", bytes_total: Buffer.byteLength(body), mutable: true,
    coverage: { truncated: false, redacted: true, history_complete: true } }; fs.writeFileSync(f.indexPath, JSON.stringify(index));
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync, mkdirSync: fs.mkdirSync, readdirSync: fs.readdirSync };
  const roleFds = new Set<number>(), resultFds = new Set<number>(); let resultReads = 0, roleOpens = 0; const reads = f.reads();
  try {
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(originals.openSync, fs, [path, ...args]); if (String(path) === role) { roleFds.add(fd); roleOpens++; } if (String(path) === f.resultPath) resultFds.add(fd); return fd; }) as typeof fs.openSync;
    fs.closeSync = ((fd) => { roleFds.delete(fd); resultFds.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
    fs.readSync = ((fd, ...args) => { assert.equal(roleFds.has(fd), false); if (resultFds.has(fd)) resultReads++; return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.readFileSync = ((path, ...args) => { assert.notEqual(String(path), role); return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
    const forbidden = () => assert.fail("Compositor attempted mutation or discovery");
    fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync;
    fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.readdirSync = forbidden as typeof fs.readdirSync; syncBuiltinESMExports();
    assert.deepEqual(f.observe(), { state: "unavailable", reason: "timing_unproven" });
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
  assert.equal(resultReads, 1); assert.equal(roleOpens, 2); assert.deepEqual(f.reads(), reads); assert.equal(fs.readFileSync(role, "utf8"), body);
});

test("Fresh launch privacy snapshots full own JSON metadata without executing accessors, hooks or unsafe prototypes", t => {
  const f = fixture(t); const secret = "ADMITTED_LITERAL";
  const a = referenceAdmission(f, { cwd: f.root + "/" + secret, values: { nested: [{ api_key: secret }] }, visibility: "public" });
  assert.deepEqual(a.references.read(), { state: "unavailable", reason: "identity_unavailable" });
  (a.metadata.values as Record<string, unknown>).nested = []; a.publish();
  const reading = a.references.read(); assert.equal(reading.state, "available");
  if (reading.state === "available") { assert.equal(reading.references.cwd, null); assert.equal(reading.references.cwd_unavailable, "cwd_reference_redacted"); }
  assert.equal(JSON.stringify(a.references), "{}"); assert.equal(JSON.stringify(reading).includes(secret), false);
  let calls = 0; const accessor = Object.defineProperty({}, "api_key", { enumerable: true, get() { calls++; throw Error("No getter"); } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const values of [accessor, { toJSON() { calls++; throw Error("No toJSON"); } }, { nested: new Date(0) }, cyclic, { pad: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) }]) {
    const other = fixture(t); const admitted = referenceAdmission(other, { values });
    admitted.publish({ ...other.meta, cwd: other.root + "/later-healthy" });
    assert.deepEqual(admitted.references.read(), { state: "unavailable", reason: "privacy_capture_unavailable" });
  }
  assert.equal(calls, 0);
});

test("Reference handoff admits only original scoped private readers and fixes first retention without DTO repair", async t => {
  const f = fixture(t); const a = referenceAdmission(f); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close());
  let calls = 0; const getter = Object.defineProperty({}, "read", { get() { calls++; throw Error("No getter"); } });
  const deferred = Promise.reject(Error("unsupported reference promise"));
  for (const value of [{}, { ...a.references }, JSON.parse(JSON.stringify(a.references)), Object.create(Object.getPrototypeOf(a.references)), getter,
    { read() { calls++; throw Error("No fake reader"); } }, { then() { calls++; } }, deferred]) {
    assert.throws(() => owner.onSupervisionClockCaptured({ ...a.capture, snapshot_references: value }), /snapshot-reference capture is invalid/);
  }
  const captureGetter = Object.defineProperty({ ...admissionCapture(f) }, "snapshot_references", { get() { calls++; throw Error("No capture getter"); } });
  assert.throws(() => owner.onSupervisionClockCaptured(captureGetter), /snapshot-reference capture is invalid/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
  assert.equal(admitRunSnapshotReferenceReader(f.stateDir, f.identity, a.references), a.references);
  assert.equal(admitRunSnapshotReferenceReader(f.root, f.identity, a.references), undefined);
  assert.equal(admitRunSnapshotReferenceReader(f.stateDir, { ...f.identity, ownerId: "foreign" }, a.references), undefined);
  assert.throws(() => Reflect.construct(Object.getPrototypeOf(a.references).constructor, [Symbol("Run snapshot reference issuer")]), /private issuer/);
  assert.throws(() => captureRunAdmissionSnapshotReferences(f.stateDir, a.metadata, { ...f.origin }), /original clock origin/);
  assert.throws(() => captureRunAdmissionSnapshotReferences(f.stateDir, { ...a.metadata, state_dir: f.root }, f.origin), /root-bound/);
  owner.onSupervisionClockCaptured(a.capture); owner.onSupervisionClockCaptured(a.capture);
  assert.throws(() => owner.onSupervisionClockCaptured(admissionCapture(f)), /conflicts/);
  const replacement = captureRunAdmissionSnapshotReferences(f.stateDir, a.metadata, f.origin);
  assert.throws(() => owner.onSupervisionClockCaptured({ ...a.capture, snapshot_references: replacement }), /conflicts/);
  const legacy = createRunSupervisionOwner(f.ports); t.after(() => legacy.close()); legacy.onSupervisionClockCaptured(admissionCapture(f));
  assert.deepEqual(legacy.observeReferences(f.identity), { state: "unavailable", reason: "references_not_retained" });
  assert.throws(() => legacy.onSupervisionClockCaptured(a.capture), /conflicts/);
  a.publish(); assert.throws(() => captureRunAdmissionSnapshotReferences(f.stateDir, a.metadata, f.origin), /unpublished/);
});

test("Owner reference retention reads no clock or controller, fixes captured cwd and revokes only its own consumption lifetime", t => {
  const f = fixture(t); const a = referenceAdmission(f); const owner = createRunSupervisionOwner(f.ports); const standby = createRunSupervisionOwner(f.ports);
  t.after(() => { owner.close(); standby.close(); }); const reads = f.reads();
  owner.onSupervisionClockCaptured(a.capture); standby.onSupervisionClockCaptured(a.capture);
  assert.equal(owner.observeReferences(f.identity).state, "unavailable"); assert.deepEqual(f.reads(), reads);
  a.publish(); const first = owner.observeReferences(f.identity); assert.equal(first.state, "available");
  if (first.state === "available") { assert.equal(first.references.cwd, a.metadata.cwd); assert.equal(first.references.context_index, null);
    assert.equal(first.references.context_index_unavailable, "index_unavailable"); assert.equal(first.unchanged(), true); }
  assert.deepEqual(f.reads(), reads); assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
  assert.equal(standby.start(f.identity).state, "controlled"); const afterStart = f.reads(); const timers = f.timers.length;
  a.publish({ ...a.metadata, cwd: "/actor-replaced", values: { api_key: a.metadata.cwd }, visibility: "public" });
  const later = owner.observeReferences(f.identity); assert.equal(later.state, "available");
  if (later.state === "available") assert.equal(later.references.cwd, a.metadata.cwd);
  assert.deepEqual(f.reads(), afterStart); assert.equal(f.timers.length, timers);
  assert.deepEqual(owner.observeReferences(f.identity, f.root), { state: "unavailable", reason: "identity_mismatch" });
  owner.stop(f.identity); assert.deepEqual(owner.observeReferences(f.identity), { state: "unavailable", reason: "owner_stopped" });
  if (first.state === "available") assert.equal(first.unchanged(), false);
  owner.release(f.identity); assert.deepEqual(owner.observeReferences(f.identity), { state: "unavailable", reason: "origin_not_retained" });
  // A separately retained original reader is not globally revoked by releasing this owner, like separately held genuine origins.
  assert.equal(a.references.read().state, "available"); owner.close(); assert.deepEqual(owner.observeReferences(f.identity), { state: "unavailable", reason: "owner_closed" });
});

test("Owner reference observations discard reentrant revocation and foreign canonical/frame substitutions", t => {
  for (const action of ["stop", "release", "close", "foreign"] as const) {
    const f = fixture(t); const a = referenceAdmission(f); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(a.capture); a.publish();
    const lstat = fs.lstatSync; let acted = false;
    try {
      fs.lstatSync = ((path, ...args) => { const stat = Reflect.apply(lstat, fs, [path, ...args]);
        if (!acted && String(path) === f.metaPath) { acted = true; if (action === "foreign") a.publish({ ...a.metadata, ownerId: "foreign" });
          else if (action === "stop") owner.stop(f.identity); else if (action === "release") owner.release(f.identity); else owner.close(); }
        return stat;
      }) as typeof fs.lstatSync; syncBuiltinESMExports();
      assert.equal(owner.observeReferences(f.identity).state, "unavailable"); assert.equal(acted, true);
    } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  }
  const f = fixture(t); const a = referenceAdmission(f); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(a.capture); a.publish();
  const first = owner.observeReferences(f.identity); assert.equal(first.state, "available");
  const held = join(f.root, "held"); fs.renameSync(f.stateDir, held); fs.cpSync(held, f.stateDir, { recursive: true });
  assert.deepEqual(owner.observeReferences(f.identity), { state: "unavailable", reason: "observation_changed" });
  if (first.state === "available") assert.equal(first.unchanged(), false);
});

test("Explicit supervision owner retains an unpublished origin, then activates exactly one controller without renewing elapsed time", t => {
  const f = fixture(t); const capture = admissionCapture(f); fs.unlinkSync(f.metaPath);
  const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close());
  owner.onSupervisionClockCaptured(capture); owner.onSupervisionClockCaptured(capture);
  assert.equal(owner.snapshot(f.identity).state, "retained"); assert.equal(f.timers.length, 0);
  assert.equal(owner.start(f.identity).state, "unavailable"); assert.equal(f.timers.length, 0);
  fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); f.setMono(400);
  const first = owner.start(f.identity); assert.equal(first.state, "controlled");
  if (first.state !== "controlled") return;
  assert.equal(first.controller.state, "armed"); assert.equal(f.timers[0].delay, 600);
  owner.start({ ...f.identity }); assert.equal(f.timers.length, 1);
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.identity), true);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|origin|state_dir|local_path|ownership_token/);
  const open = fs.openSync; const now = Date.now;
  fs.openSync = (() => assert.fail("Owner snapshot performed state IO")) as typeof fs.openSync; Date.now = () => assert.fail("Owner snapshot sampled time"); syncBuiltinESMExports();
  try { assert.deepEqual(owner.snapshot(f.identity), first); } finally { fs.openSync = open; Date.now = now; syncBuiltinESMExports(); }
  f.setMono(1000); f.timers[0].wake(); f.timers[0].wake(); owner.start(f.identity);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].stop_requested, false); assert.equal(f.events[0].scope_closure, "not_asserted");
});

test("Owner admission rejects copied origins, conflicting captures and rebinding an origin to another identity", t => {
  const f = fixture(t); const capture = admissionCapture(f); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close());
  for (const invalid of [{ ...capture, origin: { ...f.origin } }, { ...capture, visibility: "model" }, { ...capture, work_started: true }]) {
    assert.throws(() => owner.onSupervisionClockCaptured(invalid)); assert.equal(owner.snapshot(f.identity).state, "unavailable");
  }
  let getterCalls = 0; const badIdentity = { ...f.identity }; Object.defineProperty(badIdentity, "ownerId", { get() { getterCalls++; return f.identity.ownerId; } });
  assert.throws(() => owner.onSupervisionClockCaptured({ ...capture, identity: badIdentity })); assert.equal(getterCalls, 0);
  const badClock = { ...f.clock }; Object.defineProperty(badClock, "started_at", { get() { getterCalls++; return f.clock.started_at; } });
  assert.throws(() => owner.onSupervisionClockCaptured({ ...capture, clock: badClock })); assert.equal(getterCalls, 0);
  owner.onSupervisionClockCaptured(capture);
  const otherOrigin = captureRunSupervisionTimeOrigin({ wallNow: () => START, monotonicNow: () => ({ milliseconds: 0, epoch: {} }) });
  assert.throws(() => owner.onSupervisionClockCaptured({ ...capture, origin: otherOrigin }), /conflicts/);
  assert.throws(() => owner.onSupervisionClockCaptured({ ...capture, identity: { ...f.identity, run_instance_id: "generation-b" } }), /already/);
  assert.equal(owner.snapshot(f.identity).state, "retained"); assert.equal(f.timers.length, 0);
  assert.deepEqual(owner.start({ ...f.identity, ownerId: "foreign" }), { state: "unavailable", reason: "origin_not_retained" });
});

test("Owner stop before publication is final; explicit release drops retention without permitting origin replay", t => {
  const f = fixture(t); const capture = admissionCapture(f); const owner = createRunSupervisionOwner(f.ports);
  owner.onSupervisionClockCaptured(capture); assert.equal(owner.stop(f.identity).state, "stopped");
  assert.equal(owner.start(f.identity).state, "stopped"); assert.equal(f.timers.length, 0);
  assert.equal(owner.release(f.identity).state, "released");
  assert.deepEqual(owner.snapshot(f.identity), { state: "unavailable", reason: "origin_not_retained" });
  assert.throws(() => owner.onSupervisionClockCaptured({ ...capture }), /already/);
  assert.deepEqual(owner.close(), { state: "closed" }); assert.deepEqual(owner.close(), { state: "closed" });
  assert.deepEqual(owner.start(f.identity), { state: "unavailable", reason: "owner_closed" });
  assert.throws(() => owner.onSupervisionClockCaptured(capture), /closed/);
});

test("Owner release revokes callbacks and preserves failed cancellation across later close", t => {
  const f = fixture(t); const wakes: (() => void)[] = [];
  const owner = createRunSupervisionOwner({ ...f.ports, schedule: wake => { wakes.push(wake); return () => { throw Error("cancel failed"); }; } });
  owner.onSupervisionClockCaptured(admissionCapture(f)); assert.equal(owner.start(f.identity).state, "controlled");
  const released = owner.release(f.identity); assert.equal(released.state, "released");
  if (released.state !== "released") return;
  assert.equal(released.controller?.timer_cleanup, "unproven");
  f.setMono(1000); wakes[0](); assert.equal(f.events.length, 0);
  assert.deepEqual(owner.close(), { state: "closed", timer_cleanup: "unproven" });
});

test("A retained admission frame cannot be replaced with copied state or marker before first controller activation", t => {
  for (const selection of ["marker", "stateDir"] as const) {
    const f = fixture(t); const target = f[selection];
    const owner = createRunSupervisionOwner(f.ports); owner.onSupervisionClockCaptured(admissionCapture(f));
    fs.renameSync(target, target + ".held");
    if (target === f.marker) fs.copyFileSync(target + ".held", target); else fs.cpSync(target + ".held", target, { recursive: true });
    assert.deepEqual(owner.start(f.identity), { state: "unavailable", reason: "observation_changed" });
    assert.equal(f.timers.length, 0); owner.close(); fs.rmSync(target + ".held", { recursive: true });
  }
});

test("Reentrant due notification may close its owner without resurrection or a second controller", t => {
  const f = fixture(t);
  const owner = createRunSupervisionOwner({ ...f.ports, onDeadlineDue: event => { f.events.push(event); owner.close(); } });
  owner.onSupervisionClockCaptured(admissionCapture(f)); f.setMono(1000);
  assert.deepEqual(owner.start(f.identity), { state: "unavailable", reason: "owner_closed" });
  assert.equal(f.events.length, 1); assert.equal(f.timers.length, 0);
  assert.deepEqual(owner.start(f.identity), { state: "unavailable", reason: "owner_closed" });
});

test("Reentrant close during canonical assembly cannot allocate a hidden controller", t => {
  const f = fixture(t); const owner = createRunSupervisionOwner(f.ports); owner.onSupervisionClockCaptured(admissionCapture(f));
  const open = fs.openSync; let intercepted = false;
  fs.openSync = ((path, ...args) => { if (String(path) === f.metaPath && !intercepted) { intercepted = true; owner.close(); } return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.deepEqual(owner.start(f.identity), { state: "unavailable", reason: "owner_closed" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(intercepted, true); assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
});

test("Reentrant scheduler close retains cancellation uncertainty discovered after close returns, on initial and later wakes", t => {
  const f = fixture(t);
  for (const closeAt of [1, 2]) {
    f.setMono(0); const wakes: (() => void)[] = []; let scheduled = 0;
    const owner = createRunSupervisionOwner({ ...f.ports, schedule: wake => {
      const index = ++scheduled; wakes.push(wake); if (index === closeAt) owner.close();
      return () => { if (index === closeAt) throw Error("late cancel failure"); };
    } });
    owner.onSupervisionClockCaptured(admissionCapture(f)); owner.start(f.identity);
    if (closeAt === 2) { f.setMono(500); wakes[0](); }
    assert.deepEqual(owner.close(), { state: "closed", timer_cleanup: "unproven" });
    for (const wake of wakes) wake(); assert.equal(f.events.length, 0);
  }
});

test("Owners sharing an origin admit one controller and transfer only after explicit release without renewing allowance", t => {
  const f = fixture(t); const capture = admissionCapture(f); const first = createRunSupervisionOwner(f.ports); const next = createRunSupervisionOwner(f.ports);
  t.after(() => { first.close(); next.close(); });
  first.onSupervisionClockCaptured(capture); next.onSupervisionClockCaptured(capture);
  assert.equal(first.start(f.identity).state, "controlled");
  assert.deepEqual(next.start(f.identity), { state: "unavailable", reason: "controller_claimed" }); assert.equal(f.timers.length, 1);
  first.stop(f.identity); assert.deepEqual(next.start(f.identity), { state: "unavailable", reason: "controller_claimed" });
  first.release(f.identity); f.setMono(400); const activated = next.start(f.identity);
  assert.equal(activated.state, "controlled"); assert.equal(f.timers.length, 2); assert.equal(f.timers[1].delay, 600);
  f.setMono(1000); f.timers[0].wake(); assert.equal(f.events.length, 0); f.timers[1].wake(); assert.equal(f.events.length, 1);
});

test("A provisional origin claim fences reentrant competing activation during canonical assembly", t => {
  const f = fixture(t); const first = createRunSupervisionOwner(f.ports); const other = createRunSupervisionOwner(f.ports);
  t.after(() => { first.close(); other.close(); });
  first.onSupervisionClockCaptured(admissionCapture(f)); other.onSupervisionClockCaptured(admissionCapture(f));
  const open = fs.openSync; let competing = false;
  fs.openSync = ((path, ...args) => {
    if (String(path) === f.metaPath && !competing) { competing = true; assert.deepEqual(other.start(f.identity), { state: "unavailable", reason: "controller_claimed" }); }
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(first.start(f.identity).state, "controlled"); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(competing, true); assert.equal(f.timers.length, 1);
});

test("Failed assembly releases only its provisional claim; a nonholder release cannot erase another owner's claim", t => {
  const f = fixture(t); const first = createRunSupervisionOwner(f.ports); const second = createRunSupervisionOwner(f.ports); const third = createRunSupervisionOwner(f.ports);
  t.after(() => { first.close(); second.close(); third.close(); });
  for (const owner of [first, second, third]) owner.onSupervisionClockCaptured(admissionCapture(f));
  fs.unlinkSync(f.metaPath); assert.equal(first.start(f.identity).state, "unavailable");
  fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); assert.equal(second.start(f.identity).state, "controlled");
  first.release(f.identity);
  assert.deepEqual(third.start(f.identity), { state: "unavailable", reason: "controller_claimed" }); assert.equal(f.timers.length, 1);
  second.close(); assert.equal(third.start(f.identity).state, "controlled"); assert.equal(f.timers.length, 2);
});

test("Explicit handover after failed cancellation revokes the old logical controller without claiming physical timer cleanup", t => {
  const f = fixture(t); let oldWake: (() => void) | undefined;
  const first = createRunSupervisionOwner({ ...f.ports, schedule: wake => { oldWake = wake; return () => { throw Error("cancel unproven"); }; } });
  const next = createRunSupervisionOwner(f.ports); t.after(() => { first.close(); next.close(); });
  first.onSupervisionClockCaptured(admissionCapture(f)); next.onSupervisionClockCaptured(admissionCapture(f)); first.start(f.identity);
  const released = first.release(f.identity); assert.equal(released.state, "released");
  if (released.state === "released") assert.equal(released.controller?.timer_cleanup, "unproven");
  f.setMono(400); assert.equal(next.start(f.identity).state, "controlled"); assert.equal(f.timers[0].delay, 600);
  f.setMono(1000); oldWake!(); assert.equal(f.events.length, 0); f.timers[0].wake(); assert.equal(f.events.length, 1);
  assert.deepEqual(first.close(), { state: "closed", timer_cleanup: "unproven" });
});

test("An origin retains its first state/identity frame across owners and release, rather than adopting copied state", t => {
  const f = fixture(t); const capture = admissionCapture(f); const first = createRunSupervisionOwner(f.ports); const next = createRunSupervisionOwner(f.ports);
  t.after(() => { first.close(); next.close(); }); first.onSupervisionClockCaptured(capture);
  assert.throws(() => next.onSupervisionClockCaptured({ ...capture, identity: { ...f.identity, run_instance_id: "generation-b" } }), /binding/);
  const other = claimRunStateDirectory(join(f.root, "other-state"), f.identity.run);
  assert.throws(() => next.onSupervisionClockCaptured({ ...capture, state_dir: other }), /binding/);
  first.release(f.identity); fs.renameSync(f.marker, f.marker + ".held"); fs.copyFileSync(f.marker + ".held", f.marker);
  assert.throws(() => next.onSupervisionClockCaptured(capture), /frame/);
  assert.equal(f.timers.length, 0);
});

test("Claims for unrelated genuine origins remain independent, not a global timer quota", t => {
  const a = fixture(t); const b = fixture(t); const first = createRunSupervisionOwner(a.ports); const second = createRunSupervisionOwner(b.ports);
  t.after(() => { first.close(); second.close(); });
  first.onSupervisionClockCaptured(admissionCapture(a)); second.onSupervisionClockCaptured(admissionCapture(b));
  assert.equal(first.start(a.identity).state, "controlled"); assert.equal(second.start(b.identity).state, "controlled");
  assert.equal(a.timers.length, 1); assert.equal(b.timers.length, 1);
});

test("Owner time observation samples original elapsed without a timer, notification or controller claim", t => {
  for (const maximum of [null, 1000]) {
    const f = fixture(t, maximum, 60001); const owner = createRunSupervisionOwner(f.ports); const other = createRunSupervisionOwner(f.ports);
    t.after(() => { owner.close(); other.close(); });
    for (const handle of [owner, other]) handle.onSupervisionClockCaptured(admissionCapture(f));
    f.setMono(400.75); f.setWall(START - 900000);
    const first = owner.observeTime(f.identity); assert.equal(first.state, "available"); if (first.state !== "available") return;
    assert.equal(first.basis, "since_admission"); assert.deepEqual(first.identity, f.identity);
    assert.deepEqual(first.timing, { state: "available", elapsed_ms: 400, remaining_ms: maximum === null ? null : 600,
      deadline_state: maximum === null ? "disabled" : "pending", deadline_wake_ms: maximum === null ? null : 600 });
    assert.deepEqual(f.reads(), { wall: 1, mono: 2 }); assert.equal(first.unchanged(), true); owner.snapshot(f.identity);
    assert.deepEqual(f.reads(), { wall: 1, mono: 2 }); assert.equal(owner.snapshot(f.identity).state, "retained");
    assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
    assert.equal(other.start(f.identity).state, "controlled"); const timerCount = f.timers.length;
    assert.deepEqual(owner.start(f.identity), { state: "unavailable", reason: "controller_claimed" });
    f.setMono(1400.25); fs.writeFileSync(join(f.stateDir, "result.json"), "opaque terminal evidence not read by this port");
    const late = owner.observeTime(f.identity); assert.equal(late.state, "available"); if (late.state !== "available") return;
    assert.equal(late.timing.elapsed_ms, 1400); assert.equal(late.timing.deadline_state, maximum === null ? "disabled" : "due");
    assert.equal(f.events.length, 0); assert.equal(f.timers.length, timerCount);
    for (const value of [first, first.identity, first.timing]) assert.equal(Object.isFrozen(value), true);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE|state_dir|local_path|ownership_token|"origin"|"status"|terminal|stopped/);
    owner.stop(f.identity); assert.equal(first.unchanged(), false);
    assert.deepEqual(owner.observeTime(f.identity), { state: "unavailable", reason: "owner_stopped" });
  }
});

test("Owner time admission refuses missing publication, foreign state/clock and copied frames before sampling", t => {
  const f = fixture(t); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(admissionCapture(f));
  const reads = f.reads();
  for (const expected of [{}, { ...f.identity, ownerId: "foreign" }, { ...f.identity, run_instance_id: "foreign" }]) assert.equal(owner.observeTime(expected).state, "unavailable");
  fs.renameSync(f.metaPath, f.metaPath + ".held"); assert.equal(owner.observeTime(f.identity).state, "unavailable"); fs.renameSync(f.metaPath + ".held", f.metaPath);
  for (const replacement of [{ ...f.meta, ownerId: "foreign" }, { ...f.meta, run_instance_id: "foreign" },
    { ...f.meta, ...createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 2000 }, START) }]) {
    fs.writeFileSync(f.metaPath, JSON.stringify(replacement)); assert.equal(owner.observeTime(f.identity).state, "unavailable");
  }
  fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); assert.deepEqual(f.reads(), reads);
  f.setMono(600); const valid = owner.observeTime(f.identity); assert.equal(valid.state, "available"); if (valid.state === "available") assert.equal(valid.timing.elapsed_ms, 600);
  fs.renameSync(f.marker, f.marker + ".held"); fs.copyFileSync(f.marker + ".held", f.marker);
  const before = f.reads(); assert.deepEqual(owner.observeTime(f.identity), { state: "unavailable", reason: "observation_changed" });
  assert.deepEqual(f.reads(), before); if (valid.state === "available") assert.equal(valid.unchanged(), false);
  assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
});

test("Owner time preserves sticky provider uncertainty and prior due facts across observers without renewed sampling", t => {
  for (const fault of ["reversed", "epoch", "provider"]) {
    const f = fixture(t); const owner = createRunSupervisionOwner(f.ports); const other = createRunSupervisionOwner(f.ports);
    t.after(() => { owner.close(); other.close(); }); for (const handle of [owner, other]) handle.onSupervisionClockCaptured(admissionCapture(f));
    f.setMono(1000); const due = owner.observeTime(f.identity); assert.equal(due.state, "available"); if (due.state === "available") assert.equal(due.timing.deadline_state, "due");
    if (fault === "reversed") f.setMono(999); else if (fault === "epoch") f.changeEpoch(); else f.failClock();
    const uncertain = owner.observeTime(f.identity); assert.equal(uncertain.state, "available"); if (uncertain.state !== "available") return;
    assert.equal(uncertain.timing.state, "unproven"); assert.equal(uncertain.timing.elapsed_ms, null); assert.equal(uncertain.timing.deadline_state, "due");
    const reads = f.reads(); f.setMono(5000); const peer = other.observeTime(f.identity); assert.equal(peer.state, "available");
    if (peer.state === "available") assert.deepEqual(peer.timing, uncertain.timing);
    assert.deepEqual(f.reads(), reads); assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0); assert.doesNotMatch(JSON.stringify(uncertain), /PRIVATE/);
  }
});

test("Owner time discards samples after reentrant stop/release/close or canonical change", t => {
  for (const action of ["stop", "release", "close", "replace"] as const) {
    const f = fixture(t); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(admissionCapture(f));
    const first = owner.observeTime(f.identity); assert.equal(first.state, "available");
    f.onObserve(() => { f.onObserve(undefined); if (action === "replace") fs.writeFileSync(f.metaPath, JSON.stringify({ ...f.meta, run_instance_id: "foreign" }));
      else if (action === "close") owner.close(); else owner[action](f.identity); });
    const expected = action === "stop" ? "owner_stopped" : action === "release" ? "origin_not_retained" : action === "close" ? "owner_closed" : "observation_changed";
    assert.deepEqual(owner.observeTime(f.identity), { state: "unavailable", reason: expected });
    if (first.state === "available") assert.equal(first.unchanged(), false);
    assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0);
  }
  const f = fixture(t); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(admissionCapture(f));
  const open = fs.openSync; const before = f.reads(); let intercepted = false;
  fs.openSync = ((path, ...args) => { if (String(path) === f.metaPath && !intercepted) { intercepted = true; owner.close(); } return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.deepEqual(owner.observeTime(f.identity), { state: "unavailable", reason: "owner_closed" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(intercepted, true); assert.deepEqual(f.reads(), before);
});

test("Owner time reads only canonical clock/ownership metadata without mutation, wall resampling or process/body probes", t => {
  const f = fixture(t); const owner = createRunSupervisionOwner(f.ports); t.after(() => owner.close()); owner.onSupervisionClockCaptured(admissionCapture(f));
  f.setMono(1000); const before = fs.readFileSync(f.metaPath); const allowed = new Set([f.metaPath, f.marker]);
  const originals = { openSync: fs.openSync, readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const kill = process.kill; const now = Date.now;
  fs.openSync = ((path, ...args) => { assert.equal(allowed.has(String(path)), true); return Reflect.apply(originals.openSync, fs, [path, ...args]); }) as typeof fs.openSync;
  const forbidden = () => assert.fail("Time observation attempted mutation, body/process read or current wall time");
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync;
  fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try { const reading = owner.observeTime(f.identity); assert.equal(reading.state, "available"); if (reading.state === "available") {
    assert.equal(reading.timing.state, "available"); assert.equal(reading.timing.elapsed_ms, 1000); assert.equal(reading.unchanged(), true);
  } } finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.metaPath), before); assert.deepEqual(f.reads(), { wall: 1, mono: 2 });
  assert.equal(f.timers.length, 0); assert.equal(f.events.length, 0); assert.equal(owner.snapshot(f.identity).state, "retained");
});

});

await describe("Launch admission integration", { concurrency: false }, async () => {
/** Real launch clock handoff: runtime-local evidence, not a launched receipt or independent deadline enforcement. */
const { startRun } = await import("../lib/async-runs.ts");
const { readProcessLiveness } = await import("../lib/runs-process.ts");
const { readRunSupervisionBinding, createRunSupervisionOwner } = await import("../lib/runs-supervision.ts");
const { createRunSupervisionTimebase } = await import("../lib/run-supervision.ts");
const { mutationLockPath } = await import("../lib/file-state.ts");
const { readRunSnapshotFacts } = await import("../lib/runs-status.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { renderRunSnapshot } = await import("../lib/tools-response.ts");
const { createActorExtensionRuntime } = await import("../lib/extension-runtime.ts");
const { getRunStateRoot } = await import("../lib/paths.ts");
function fixture(t: TestContext, ownedStateDir?: string, runId = "admission-clock") {
  const root = fs.mkdtempSync(join(agentDir, "case-")); const stateDir = ownedStateDir ?? join(root, "state"); const gate = join(root, "release"); const ready = join(root, "ready"); const pids = new Set<number>();
  const captureWork = () => {
    if (!fs.existsSync(ready)) return false;
    const work = JSON.parse(fs.readFileSync(ready, "utf8"));
    if (!Number.isSafeInteger(work.pid) || work.pid <= 0) throw Error("Captured fixture workload PID unavailable; retaining state");
    pids.add(work.pid); return true;
  };
  const settle = async () => {
    for (const pid of pids) {
      let exited = false; for (let attempt = 0; attempt < 400; attempt++) { captureWork(); if (readProcessLiveness(pid) === "dead") { exited = true; break; } await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.equal(exited, true, "Captured fixture runner exit remains unproven; retaining state");
    }
    if (pids.size > 0) {
      assert.equal(captureWork(), true, "Captured fixture workload exit remains unproven; retaining state");
      const result = JSON.parse(fs.readFileSync(join(stateDir, "result.json"), "utf8"));
      assert.equal(result.code, 0, "Fixture workload failed; retaining state"); assert.equal(result.terminal_acceptance, "natural");
    }
    for (const pid of pids) assert.equal(readProcessLiveness(pid), "dead", "Captured fixture runner exit remains unproven; retaining state");
  };
  t.after(async () => { fs.writeFileSync(gate, "release"); await settle(); if (ownedStateDir) fs.rmSync(ownedStateDir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const script = join(root, "gated.cjs");
  fs.writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(process.argv[3]+'.tmp',JSON.stringify({pid:process.pid}));fs.renameSync(process.argv[3]+'.tmp',process.argv[3]);
    const deadline=Date.now()+15000;const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);console.log('released')}
    else if(Date.now()>deadline){clearInterval(t);process.exitCode=1}},20);`);
  const params = { run_id: runId, ownerId: "owner-a", state_dir: stateDir,
    template: `${process.execPath} ${JSON.stringify(script)} ${JSON.stringify(gate)} ${JSON.stringify(ready)}` };
  const captureNative = <T>(start: () => T): T => {
    const spawn = childProcess.spawn;
    childProcess.spawn = ((...values) => { const child = Reflect.apply(spawn, childProcess, values); if (typeof child.pid === "number" && child.pid > 0) pids.add(child.pid); return child; }) as typeof childProcess.spawn;
    syncBuiltinESMExports(); try { return start(); } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  };
  const start = (...args: Parameters<typeof startRun>) => captureNative(() => startRun(...args));
  return { root, stateDir, gate, ready, params, start, settle, captureWork, captureNative, capturedPids: () => [...pids] };
}

function coordinatorHarness(enabled = true) {
  const definitions = new Map<string, any>(); let idle = true, uiFailed = false, uiFailures = 0;
  const pi = { getActiveTools: () => [...definitions.keys()], getAllTools: () => [...definitions.values()], getThinkingLevel: () => "off",
    registerTool: (definition: any) => definitions.set(definition.name, definition), registerMessageRenderer: () => undefined, setActiveTools: () => undefined, sendMessage: () => undefined };
  const runtime = createActorExtensionRuntime(pi as never, enabled ? { onDeadlineDue: () => assert.fail("Retention-only runtime notified deadline"),
    schedule: () => assert.fail("Retention-only runtime armed controller") } : undefined);
  runtime.registerCoreTools();
  const context = (ownerId: string, mode: "json" | "tui" = "json") => {
    let stale = false; const sessionManager = { getSessionId: () => ownerId };
    const ctx = { cwd: process.cwd(), mode, isIdle: () => idle,
      get sessionManager() { if (stale) throw Error("Invalidated context read"); return sessionManager; },
      get ui() { if (stale) throw Error("Invalidated UI read"); return { setWidget: () => undefined, notify: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
        setStatus: () => { if (uiFailed) { uiFailures++; throw Error("controlled UI failure"); } } }; } } as never;
    return { ctx, stale: () => { stale = true; } };
  };
  return { runtime, definitions, context, uiFailures: () => uiFailures, busy: (value: boolean) => { idle = !value; }, failUi: () => { uiFailed = true; } };
}

test("Opt-in real coordinator retains original wrapped spawn/async-tool admissions across busy, idle and UI failure without timers", async t => {
  for (const route of ["spawn", "async_tool"] as const) {
    const runId = `coordinator-${route}`; const f = fixture(t, join(getRunStateRoot(), runId), runId); const h = coordinatorHarness();
    // The cosmetic callback failure is a terminal-UI witness, not a headless animation requirement.
    const active = h.context(`owner-${route}`, route === "spawn" ? "tui" : "json");
    await h.runtime.onSessionStart(active.ctx); let primaryFailure: unknown; let failed = false;
    try {
      let definition = h.definitions.get("spawn"); let args: Record<string, unknown> = { as: `run:${runId}`, template: f.params.template, max_runtime: "1ms",
        artifacts: { declared_only: join(f.root, "not-produced.txt") }, values: { onSupervisionClockCaptured: "ACTOR_DATA_NOT_A_HOOK" } };
      if (route === "async_tool") {
        await h.definitions.get("actors_tool_register").execute("register-private-async", { name: "coordinator_async", description: "Isolated finite gated coordinator fixture.", template: f.params.template, async: true }, undefined, undefined, active.ctx);
        definition = h.definitions.get("coordinator_async"); assert.ok(definition);
        args = { run_id: runId, onSupervisionClockCaptured: "ACTOR_DATA_NOT_A_HOOK" };
      }
      const pending = f.captureNative(() => definition.execute("coordinator-launch", args, undefined, undefined, active.ctx));
      assert.equal(f.capturedPids().length, 1, "Capture the positive runner PID before awaiting the tool");
      const response = await pending; const meta = response.details; const expected = { run: meta.run, run_instance_id: meta.run_instance_id, ownerId: meta.ownerId };
      assert.equal(meta.ownerId, `owner-${route}`); assert.equal(Object.hasOwn(meta, "snapshot_references"), false); assert.equal(Object.hasOwn(meta, "origin"), false);
      assert.equal(Object.hasOwn(meta, "onSupervisionClockCaptured"), false);
      const readyUntil = performance.now() + 5000;
      while (!f.captureWork() && performance.now() < readyUntil) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(f.captureWork(), true, "Coordinator fixture workload readiness remains unproven");
      for (const busy of [true, false]) {
        h.busy(busy); h.runtime.onAgentSettled(active.ctx);
        const reading = h.runtime.observeRunSnapshot(expected, new Date().toISOString());
        const captured = JSON.parse(fs.readFileSync(join(f.stateDir, "run.json"), "utf8")).process_identity;
        if (captured?.platform === process.platform) { assert.equal(reading.state, "available"); if (reading.state === "available") assert.equal(reading.snapshot.status, "running"); }
        else assert.equal(reading.state, "unavailable");
      }
      if (route === "spawn") {
        h.failUi(); await new Promise(resolve => setTimeout(resolve, 1100)); assert.ok(h.uiFailures() > 0, "Must witness actual UI callback failure");
        const retained = h.runtime.observeRunSnapshot(expected, new Date().toISOString());
        const captured = JSON.parse(fs.readFileSync(join(f.stateDir, "run.json"), "utf8")).process_identity;
        if (captured?.platform === process.platform) assert.equal(retained.state, "available");
      }
      fs.writeFileSync(f.gate, "release"); await f.settle();
      assert.deepEqual(h.runtime.observeRunSnapshot(expected, new Date().toISOString()), { state: "unavailable", reason: "timing_unproven" });
      h.runtime.onSessionShutdown("quit", active.ctx);
      assert.deepEqual(h.runtime.observeRunSnapshot(expected, new Date().toISOString()), { state: "unavailable", reason: "origin_not_retained" });
    } catch (error) { failed = true; primaryFailure = error; }
    finally {
      try { fs.writeFileSync(f.gate, "release"); await f.settle(); h.runtime.onSessionShutdown("quit", active.ctx); }
      catch (cleanup) { if (failed) throw new AggregateError([primaryFailure, cleanup], "Coordinator fixture failed and cleanup remains unproven; retaining state"); throw cleanup; }
    }
    if (failed) throw primaryFailure;
  }
});

test("Coordinator epoch replacement revokes pinned hooks without rebinding same-owner runtime or reading invalidated contexts", async t => {
  const f = fixture(t); const h = coordinatorHarness(); const alpha = h.context("same-owner"), beta = h.context("same-owner");
  await h.runtime.onSessionStart(alpha.ctx); const oldHook = h.runtime.getRunAdmissionObserver(alpha.ctx); assert.ok(oldHook);
  await h.runtime.onSessionStart(beta.ctx); const freshWrapper = { ...beta.ctx as object } as never;
  const currentHook = h.runtime.getRunAdmissionObserver(freshWrapper); assert.ok(currentHook);
  const foreign = h.context("same-owner"); const foreignHook = h.runtime.getRunAdmissionObserver(foreign.ctx); assert.ok(foreignHook);
  alpha.stale(); h.runtime.onSessionShutdown("reload", alpha.ctx);
  const forbidden = Object.defineProperty({}, "identity", { get() { assert.fail("Stale hook inspected capture data"); } });
  assert.throws(() => oldHook(forbidden as Readonly<AsyncRunAdmissionClock>), /coordinator admission is unavailable or changed/);
  let captured: Readonly<AsyncRunAdmissionClock> | undefined; const failure = Error("accepted epoch observer refusal");
  try {
    assert.throws(() => f.start({ ...f.params, ownerId: "same-owner" }, process.cwd(), { onSupervisionClockCaptured: foreignHook }), /coordinator admission is unavailable or changed/);
    assert.throws(() => f.start({ ...f.params, ownerId: "same-owner" }, process.cwd(), { onSupervisionClockCaptured(event) { currentHook(event); captured = event; throw failure; } }), error => error === failure);
    assert.ok(captured); assert.deepEqual(h.runtime.observeRunSnapshot(captured.identity, new Date().toISOString()), { state: "unavailable", reason: "identity_unavailable" });
    assert.equal(f.capturedPids().length, 0); assert.equal(fs.existsSync(join(f.stateDir, "run.json")), false);
    h.runtime.onSessionShutdown("reload", freshWrapper); beta.stale();
    assert.throws(() => currentHook(forbidden as Readonly<AsyncRunAdmissionClock>), /coordinator admission is unavailable or changed/);
    assert.deepEqual(h.runtime.observeRunSnapshot(captured.identity, new Date().toISOString()), { state: "unavailable", reason: "origin_not_retained" });
  } finally { h.runtime.onSessionShutdown("quit", beta.ctx); }
});

test("Overlapping same-context starts retain only the winning epoch and close their owned watchers", async t => {
  const f = fixture(t); const h = coordinatorHarness(); const active = h.context("owner-a");
  const watch = fs.watch; const live = new Set<ReturnType<typeof fs.watch>>();
  fs.watch = ((...args) => {
    const handle = Reflect.apply(watch, fs, args); live.add(handle);
    handle.once("close", () => live.delete(handle)); return handle;
  }) as typeof fs.watch;
  syncBuiltinESMExports();
  try {
    const first = h.runtime.onSessionStart(active.ctx); const superseded = h.runtime.getRunAdmissionObserver(active.ctx); assert.ok(superseded);
    assert.throws(() => f.start(f.params, process.cwd(), { onSupervisionClockCaptured: superseded }), /coordinator admission is unavailable or changed/);
    const second = h.runtime.onSessionStart(active.ctx); const winner = h.runtime.getRunAdmissionObserver(active.ctx); assert.ok(winner);
    await Promise.all([first, second]); const failure = Error("winning ready epoch refusal"); let captured: Readonly<AsyncRunAdmissionClock> | undefined;
    assert.throws(() => f.start(f.params, process.cwd(), { onSupervisionClockCaptured: superseded }), /coordinator admission is unavailable or changed/);
    assert.throws(() => f.start(f.params, process.cwd(), { onSupervisionClockCaptured(event) { winner(event); captured = event; throw failure; } }), error => error === failure);
    assert.ok(captured); assert.deepEqual(h.runtime.observeRunSnapshot(captured.identity, new Date().toISOString()), { state: "unavailable", reason: "identity_unavailable" });
    assert.equal(f.capturedPids().length, 0);
  } finally {
    try {
      // Reused controlled managers test startup fencing, not fresh shutdown authority.
      const cleanup = h.context("overlap-cleanup");
      await h.runtime.onSessionStart(cleanup.ctx);
      h.runtime.onSessionShutdown("quit", cleanup.ctx);
    } finally { fs.watch = watch; syncBuiltinESMExports(); }
  }
  await new Promise(resolve => setImmediate(resolve));
  const leaked = live.size;
  // Settle exact test-owned handles on failure without hiding the observed leak or forcing process exit.
  for (const handle of live) handle.close();
  assert.equal(leaked, 0, "Fresh cleanup must close every watcher born in this controlled lifecycle");
});

test("Coordinator admission is private opt-in and rejects absent epoch or foreign owner before native work", async t => {
  const plain = coordinatorHarness(false); const invalidContext = Object.defineProperty({}, "sessionManager", { get() { assert.fail("Default queried session for supervision"); } });
  assert.equal(plain.runtime.getRunAdmissionObserver(invalidContext as never), undefined);
  assert.equal(plain.definitions.get("spawn").parameters.properties.onSupervisionClockCaptured, undefined);
  const f = fixture(t); const h = coordinatorHarness(); const active = h.context("expected-owner");
  const beforeStart = h.runtime.getRunAdmissionObserver(active.ctx); assert.ok(beforeStart);
  assert.throws(() => f.start({ ...f.params, ownerId: "expected-owner" }, process.cwd(), { onSupervisionClockCaptured: beforeStart }), /coordinator admission is unavailable or changed/);
  await h.runtime.onSessionStart(active.ctx); const hook = h.runtime.getRunAdmissionObserver(active.ctx); assert.ok(hook);
  try {
    assert.throws(() => f.start(f.params, process.cwd(), { onSupervisionClockCaptured: hook }), /coordinator admission is unavailable or changed/);
    assert.equal(f.capturedPids().length, 0); assert.equal(fs.existsSync(join(f.stateDir, "stdout.log")), false);
  } finally { h.runtime.onSessionShutdown("quit", active.ctx); }
});

test("Real start hands off a frozen original clock under lifecycle admission before canonical publication or native work", async t => {
  const f = fixture(t); const events: Readonly<AsyncRunAdmissionClock>[] = []; let nativeCalls = 0; const spawn = childProcess.spawn;
  const owner = createRunSupervisionOwner({ onDeadlineDue: () => assert.fail("Disabled deadline notified") }); t.after(() => owner.close());
  const standby = createRunSupervisionOwner({ onDeadlineDue: () => assert.fail("Disabled standby deadline notified") }); t.after(() => standby.close());
  childProcess.spawn = ((...args) => { nativeCalls++; assert.equal(events.length, 1, "Native spawn preceded clock handoff"); return Reflect.apply(spawn, childProcess, args); }) as typeof childProcess.spawn; syncBuiltinESMExports();
  let run: ReturnType<typeof startRun>;
  try {
    run = f.start({ ...f.params, artifacts: { declared_only: join(f.root, "not-produced.txt") },
      values: { max_runtime: "1ms", report_every: "1ms", private_value: "PRIVATE_VALUE", run_instance_id: "actor-generation", origin: { wall_ms: 0 } } }, process.cwd(), {
      onSupervisionClockCaptured(event) {
        events.push(event); owner.onSupervisionClockCaptured(event); standby.onSupervisionClockCaptured(event);
        assert.equal(owner.snapshot(event.identity).state, "retained"); assert.equal(owner.start(event.identity).state, "unavailable");
        assert.equal(owner.observeTime(event.identity).state, "unavailable");
        assert.ok(event.snapshot_references && Object.isFrozen(event.snapshot_references));
        assert.equal(owner.observeReferences(event.identity).state, "unavailable");
        assert.equal(fs.existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), true);
        assert.equal(fs.existsSync(join(f.stateDir, "run.json")), false); assert.equal(fs.existsSync(join(f.stateDir, "progress.json")), false);
        assert.equal(readRunSupervisionBinding(f.stateDir, event.identity).state, "unavailable");
        assert.equal(Object.isFrozen(event.clock.supervision), true); assert.equal(Object.isFrozen(event.identity), true); assert.equal(Object.isFrozen(event), true);
        return events.length; // A normal synchronous callback return is ignored, not interpreted as policy or permission.
      },
    });
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.equal(nativeCalls, 1); const event = events[0]; assert.ok(event);
  assert.equal(event.publication, "unpublished"); assert.equal(event.work_started, false); assert.equal(event.visibility, "kernel_only");
  assert.equal(event.identity.run_instance_id, run.run_instance_id); assert.notEqual(event.identity.run_instance_id, "actor-generation"); assert.equal(event.origin.wall_ms, Date.parse(run.started_at!));
  assert.deepEqual(event.clock.supervision, { report_every_ms: null, max_runtime_ms: null, deadline_at: null });
  assert.equal(createRunSupervisionTimebase(event.clock, event.origin).state, "available");
  assert.deepEqual(createRunSupervisionTimebase(event.clock, JSON.parse(JSON.stringify(event.origin))), { state: "unavailable", reason: "origin_unavailable" });
  const observedTime = owner.observeTime(event.identity); assert.equal(observedTime.state, "available");
  if (observedTime.state === "available") { assert.equal(observedTime.basis, "since_admission"); assert.equal(observedTime.timing.state, "available");
    assert.ok(observedTime.timing.elapsed_ms !== null && observedTime.timing.elapsed_ms >= 0); assert.equal(observedTime.unchanged(), true); }
  assert.equal(owner.snapshot(event.identity).state, "retained");
  // The workload marker only synchronizes this test; lifecycle/timing still require their independent owners.
  const readyDeadline = performance.now() + 5000;
  while (!f.captureWork() && performance.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.captureWork(), true, "Gated fixture workload did not become ready: " +
    ["result.json", "stderr.log"].map(name => { const path = join(f.stateDir, name); return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : `${name}:absent`; }).join("\n"));
  const active = readRunSnapshotFacts(f.stateDir, event.identity, new Date().toISOString(), owner.observeTime);
  assert.equal(active.state, "available");
  if (active.state === "available") {
    const captured = JSON.parse(fs.readFileSync(join(f.stateDir, "run.json"), "utf8")).process_identity;
    if (captured?.platform === process.platform) { assert.equal(active.facts.lifecycle.status, "running"); assert.equal(active.facts.timing.basis, "live"); }
    else { assert.equal(active.facts.lifecycle.status, "unproven"); assert.equal(active.facts.timing.basis, "unproven"); }
    assert.equal(active.unchanged(), true);
  }
  const composed = owner.observeSnapshot(event.identity, new Date().toISOString());
  if (active.state === "available" && active.facts.lifecycle.status === "running") {
    assert.equal(composed.state, "available"); if (composed.state === "available") { assert.equal(composed.snapshot.status, "running");
      assert.equal(composed.snapshot.cwd, process.cwd()); assert.equal(composed.snapshot.evidence, join(f.stateDir, "context-index.json"));
      assert.equal(composed.unchanged(), true);
      const text = renderRunSnapshot(composed.snapshot); const json = renderRunSnapshot(composed.snapshot, "json");
      assert.equal(text.state, "available"); assert.equal(json.state, "available");
      if (text.state === "available") { assert.ok(text.text.startsWith(`run:${run.run} · running · elapsed=${composed.snapshot.elapsed_ms}ms`));
        assert.ok(text.text.includes(composed.snapshot.run_instance_id)); assert.ok(text.text.includes(composed.snapshot.evidence!)); }
      if (json.state === "available") assert.deepEqual(JSON.parse(json.text), composed.snapshot);
    }
  } else { assert.equal(composed.state, "unavailable"); }
  assert.equal(owner.snapshot(event.identity).state, "retained");
  const beforeExitReferences = owner.observeReferences(event.identity); assert.equal(beforeExitReferences.state, "available");
  if (beforeExitReferences.state === "available") assert.equal(beforeExitReferences.references.cwd, process.cwd());
  fs.writeFileSync(f.gate, "release"); await f.settle(); // Fresh runner/workload ESRCH, not a serialized producer-exit claim.
  const terminalMeta = JSON.parse(fs.readFileSync(join(f.stateDir, "run.json"), "utf8"));
  fs.writeFileSync(join(f.stateDir, "run.json"), JSON.stringify({ ...terminalMeta, cwd: "/actor-changed-after-exit", values: { api_key: process.cwd() }, visibility: "public" }));
  const afterExitReferences = owner.observeReferences(event.identity); assert.equal(afterExitReferences.state, "available");
  if (afterExitReferences.state === "available") { assert.equal(afterExitReferences.references.cwd, process.cwd());
    assert.equal(afterExitReferences.references.context_index?.path, join(f.stateDir, "context-index.json"));
    assert.deepEqual(afterExitReferences.references.context_index?.identity, event.identity); assert.equal(afterExitReferences.unchanged(), true); }
  assert.deepEqual(owner.observeSnapshot(event.identity, new Date().toISOString()), { state: "unavailable", reason: "timing_unproven" });
  const controlled = owner.start(event.identity); assert.equal(controlled.state, "controlled");
  if (controlled.state === "controlled") assert.equal(controlled.controller.state, "disabled");
  assert.deepEqual(owner.start(event.identity), controlled);
  assert.deepEqual(standby.start(event.identity), { state: "unavailable", reason: "controller_claimed" });
  assert.equal(owner.release(event.identity).state, "released"); assert.equal(standby.start(event.identity).state, "controlled");
  const stored = JSON.parse(fs.readFileSync(join(f.stateDir, "run.json"), "utf8")); assert.equal(stored.started_at, event.clock.started_at);
  assert.deepEqual(stored.supervision, event.clock.supervision); assert.doesNotMatch(JSON.stringify(event), /PRIVATE_VALUE|private_value|template|process_identity|"pid"/);
  assert.equal("origin" in stored, false); assert.equal("onSupervisionClockCaptured" in stored, false); assert.equal("monotonic" in stored, false);
});

test("Singleton/legacy reuse preserves one origin; refused replacement retains old files and a fresh generation gets a fresh origin", async t => {
  const f = fixture(t); const skill = join(f.root, "singleton-clock"); fs.mkdirSync(join(skill, "recipes"), { recursive: true });
  fs.writeFileSync(join(skill, "SKILL.md"), "---\nname: singleton-clock\ndescription: Fixture.\n---\n");
  const file = join(skill, "recipes", "service.json"); fs.writeFileSync(file, JSON.stringify({ async: true, singleton: true, template: f.params.template }));
  const captures: Readonly<AsyncRunAdmissionClock>[] = []; const owner = createRunSupervisionOwner({ onDeadlineDue: () => assert.fail("Disabled deadline notified") }); t.after(() => owner.close());
  const options = { onSupervisionClockCaptured: (event: Readonly<AsyncRunAdmissionClock>) => { captures.push(event); owner.onSupervisionClockCaptured(event); } };
  const first = f.start({ file, state_dir: f.stateDir, ownerId: "owner-a" }, process.cwd(), options);
  const before = fs.readFileSync(join(f.stateDir, "run.json")); const reused = f.start({ file, state_dir: f.stateDir, ownerId: "owner-a" }, process.cwd(), options);
  assert.equal(reused.reused, true); assert.equal(reused.run_instance_id, first.run_instance_id); assert.equal(reused.started_at, first.started_at); assert.equal(captures.length, 1);
  assert.deepEqual(fs.readFileSync(join(f.stateDir, "run.json")), before);
  assert.equal(owner.snapshot(captures[0].identity).state, "retained");
  const legacy = JSON.parse(before.toString()); delete legacy.started_at; delete legacy.supervision; delete legacy.supervision_provenance;
  const bytes = JSON.stringify(legacy); fs.writeFileSync(join(f.stateDir, "run.json"), bytes);
  const old = f.start({ file, state_dir: f.stateDir, ownerId: "owner-a" }, process.cwd(), options);
  assert.equal(old.reused, true); assert.equal(old.started_at, undefined); assert.equal(captures.length, 1); assert.equal(fs.readFileSync(join(f.stateDir, "run.json"), "utf8"), bytes);
  assert.deepEqual(owner.start(captures[0].identity), { state: "unavailable", reason: "clock_unconfigured" });
  fs.writeFileSync(join(f.stateDir, "run.json"), before); fs.writeFileSync(f.gate, "release"); await f.settle();
  const saved = ["run.json", "result.json", "stdout.log", "trace.jsonl"].map(name => fs.readFileSync(join(f.stateDir, name)));
  const failure = Error("refused replacement observer");
  assert.throws(() => f.start({ file, state_dir: f.stateDir, ownerId: "owner-a" }, process.cwd(), { onSupervisionClockCaptured: () => { throw failure; } }), error => error === failure);
  assert.deepEqual(["run.json", "result.json", "stdout.log", "trace.jsonl"].map(name => fs.readFileSync(join(f.stateDir, name))), saved);
  const next = f.start({ file, state_dir: f.stateDir, ownerId: "owner-a" }, process.cwd(), options);
  assert.equal(captures.length, 2); assert.notEqual(next.run_instance_id, first.run_instance_id); assert.notEqual(captures[0].origin, captures[1].origin);
  assert.equal(captures[1].identity.run_instance_id, next.run_instance_id); assert.equal(captures[1].clock.started_at, next.started_at);
  assert.equal(owner.start(captures[1].identity).state, "controlled");
  assert.equal(owner.start(captures[0].identity).state, "unavailable"); assert.equal(owner.release(captures[0].identity).state, "released");
});

test("Observer rejection preserves the exact failure before native spawn, captures or canonical metadata", t => {
  const f = fixture(t); const spawn = childProcess.spawn; let nativeCalls = 0;
  childProcess.spawn = (() => { nativeCalls++; throw Error("Native work must not start"); }) as typeof childProcess.spawn; syncBuiltinESMExports();
  const failure = Object.assign(new Error("exact clock observer failure"), { code: "EIO" }); let captured: Readonly<AsyncRunAdmissionClock> | undefined;
  const owner = createRunSupervisionOwner({ onDeadlineDue: () => assert.fail("Unpublished admission notified") }); t.after(() => owner.close());
  try { assert.throws(() => startRun(f.params, process.cwd(), { onSupervisionClockCaptured: event => { captured = event; owner.onSupervisionClockCaptured(event); throw failure; } }), error => error === failure); }
  finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.ok(captured); assert.equal(nativeCalls, 0); assert.equal(captured.work_started, false);
  assert.equal(owner.snapshot(captured.identity).state, "retained"); assert.equal(owner.start(captured.identity).state, "unavailable");
  assert.equal(owner.release(captured.identity).state, "released");
  for (const name of ["run.json", "progress.json", "stdout.log", "stderr.log", "result.json", "trace.jsonl"]) assert.equal(fs.existsSync(join(f.stateDir, name)), false);
  assert.equal(fs.existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
});

test("Fallible metadata preparation precedes clock handoff, retained-state cleanup and capture acquisition", t => {
  for (const previous of [true, false]) for (const failureKind of ["artifact", "transport"] as const) for (const observe of [false, true]) {
    const f = fixture(t); claimRunStateDirectory(f.stateDir, f.params.run_id);
    const oldMeta = { run: f.params.run_id, run_instance_id: "synthetic-previous", ownerId: "owner-a", pid: 0,
      state_dir: f.stateDir, cwd: process.cwd(), outcome_protocol: "run-outcome-v1" };
    const saved = new Map<string, Buffer>();
    if (previous) {
      const contents: Record<string, string> = { "run.json": JSON.stringify(oldMeta),
        "result.json": JSON.stringify({ run_instance_id: oldMeta.run_instance_id, terminal_acceptance: "natural", code: 0, completedAt: "2026-10-22T00:00:00.000Z" }),
        "progress.json": "prior-progress", "execution.json": "prior-execution", "stdout.log": "prior-stdout\r\nβ", "stderr.log": "prior-stderr", "trace.jsonl": "prior-trace\n" };
      for (const [name, content] of Object.entries(contents)) { const bytes = Buffer.from(content); saved.set(name, bytes); fs.writeFileSync(join(f.stateDir, name), bytes); }
    }
    const open = fs.openSync, close = fs.closeSync, spawn = childProcess.spawn; const owned = new Set<number>(); let captures = 0, observers = 0, native = 0;
    const failure = Object.assign(new Error("exact metadata preparation failure"), { code: "EIO" });
    try {
      fs.openSync = ((path, flags, ...args) => { const fd = Reflect.apply(open, fs, [path, flags, ...args]);
        if ([join(f.stateDir, "stdout.log"), join(f.stateDir, "stderr.log")].includes(String(path)) && flags === "a") { owned.add(fd); captures++; } return fd;
      }) as typeof fs.openSync;
      fs.closeSync = ((fd) => { Reflect.apply(close, fs, [fd]); owned.delete(fd); }) as typeof fs.closeSync;
      childProcess.spawn = (() => { native++; throw Error("Invalid metadata must not start native work"); }) as typeof childProcess.spawn; syncBuiltinESMExports();
      const params = { ...f.params, ...(failureKind === "artifact" ? { artifacts: { report: "{absent_launch_value}" } }
        : { transport_context: Object.defineProperty({}, "chat", { enumerable: true, get() { throw failure; } }) }) };
      assert.throws(() => startRun(params, process.cwd(), observe ? { onSupervisionClockCaptured() { observers++; } } : {}),
        failureKind === "artifact" ? /absent_launch_value/ : (error: unknown) => error === failure);
      const changed = [...saved].filter(([name, bytes]) => !fs.existsSync(join(f.stateDir, name)) || !fs.readFileSync(join(f.stateDir, name)).equals(bytes)).map(([name]) => name);
      assert.deepEqual({ observers, native, captures, open_captures: owned.size, changed }, { observers: 0, native: 0, captures: 0, open_captures: 0, changed: [] });
      if (!previous) for (const name of ["run.json", "result.json", "progress.json", "execution.json", "stdout.log", "stderr.log", "trace.jsonl"]) assert.equal(fs.existsSync(join(f.stateDir, name)), false);
      assert.equal(fs.existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
    } finally {
      fs.openSync = open; fs.closeSync = close; childProcess.spawn = spawn; syncBuiltinESMExports();
      // The pre-fix witness opens captures before throwing. Settle these exact test-owned descriptors, never hide the product leak.
      for (const fd of owned) close(fd);
    }
  }
});

test("Clock observer sees completed artifact preparation but still rejects before captures or publication", t => {
  const f = fixture(t); const failure = new Error("prepared observer rejection"); let expanded = false, observed = false;
  const declaration = { path: "{report_path}", get kind() { expanded = true; return "text"; } };
  assert.throws(() => startRun({ ...f.params, values: { report_path: join(f.root, "report.txt") }, artifacts: { report: declaration } }, process.cwd(), {
    onSupervisionClockCaptured(event) {
      observed = true; assert.equal(expanded, true); assert.equal(event.publication, "unpublished"); assert.equal(event.work_started, false);
      for (const name of ["run.json", "progress.json", "stdout.log", "stderr.log"]) assert.equal(fs.existsSync(join(f.stateDir, name)), false);
      throw failure;
    },
  }), error => error === failure);
  assert.equal(observed, true); assert.equal(fs.existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
});

test("Deferred observers are refused before work; rejected promises are settled and custom thenables are never awaited", async t => {
  const f = fixture(t); const spawn = childProcess.spawn; let nativeCalls = 0;
  childProcess.spawn = (() => { nativeCalls++; throw Error("Native work must not start"); }) as typeof childProcess.spawn; syncBuiltinESMExports();
  try {
    for (const observer of [() => Promise.resolve(), () => Promise.reject(Error("async observer rejected")), () => ({ then: () => assert.fail("Custom thenable was awaited") })]) {
      assert.throws(() => startRun(f.params, process.cwd(), { onSupervisionClockCaptured: observer as unknown as (event: Readonly<AsyncRunAdmissionClock>) => void }), /must complete synchronously/);
    }
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(nativeCalls, 0); assert.equal(fs.existsSync(join(f.stateDir, "run.json")), false);
});

});
} finally {
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
  if (oldReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = oldReview;
  if (fs.readdirSync(agentDir).length === 0) fs.rmdirSync(agentDir);
}
