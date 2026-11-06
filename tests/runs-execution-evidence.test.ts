/** Mirrors lib/runs-execution-evidence.ts; related contracts share this owner while retaining their fixtures and hooks. */
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
import {
  claimRunStateDirectory,
  RUN_STATE_OWNERSHIP_FILE,
} from "../lib/runs-ownership.ts";
import {
  readRunExecutionReference,
  projectRunExecutionManifest,
  readRunStreamSource,
} from "../lib/runs-execution-evidence.ts";
import {
  readRunContextIdentity,
  RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES,
} from "../lib/runs-context-index.ts";
import {
  observeExecutionFileReference,
  readExecutionRunnerStreamText,
  RUN_STREAM_SOURCE_MAX_BYTES,
} from "../lib/execution-files.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Reference admission", { concurrency: false }, async () => {
/** Exact owned-generation admission of one recorded execution reference, without raw-body exposure. */

const stamp = "2026-01-01T00:00:00.000Z";
const captureQuery = { kind: "capture", command_id: "command-001", attempt: 1, stream: "stdout" };
const sessionQuery = { kind: "session", command_id: "command-001", path: "sessions/command-001/session.jsonl" };
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-execution-evidence-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { run: "worker", run_instance_id: "generation-a", ownerId: "owner-a" };
  const stateDir = claimRunStateDirectory(join(root, "state"), identity.run);
  const meta = { ...identity, state_dir: stateDir, pid: 0, private_value: "HIDDEN_METADATA" };
  const metaPath = join(stateDir, "run.json"); fs.writeFileSync(metaPath, JSON.stringify(meta));
  const stdout = "captures/command-001/attempt-001/stdout.log";
  const stderr = "captures/command-001/attempt-001/stderr.log";
  for (const [relative, content] of [[stdout, "hello"], [stderr, ""], [sessionQuery.path, "HIDDEN_RAW_SESSION"]]) {
    fs.mkdirSync(join(stateDir, relative, ".."), { recursive: true }); fs.writeFileSync(join(stateDir, relative), content);
  }
  const manifest = { version: 1, run: identity.run, run_instance_id: identity.run_instance_id, status: "running", active_subagents: 1, updated_at: stamp,
    provider_payload: "HIDDEN_PROVIDER", commands: [{ id: "command-001", status: "running", command: "HIDDEN_COMMAND", session_files: [sessionQuery.path],
      attempts: [{ attempt: 1, code: 7, killed: false,
        stdout: { path: stdout, bytes: 5, bytes_observed: 18, complete: false, error: "capture_write_failed" },
        stderr: { path: stderr, bytes: 0 } }] }] };
  const sourcePath = join(stateDir, "execution.json");
  const record = () => fs.writeFileSync(sourcePath, JSON.stringify(manifest)); record();
  const read = (query: unknown = captureQuery, expected: unknown = identity) => readRunExecutionReference(stateDir, expected, query);
  return { root, stateDir, identity, meta, metaPath, manifest, sourcePath, record, read, file: join(stateDir, stdout) };
}

test("Owned-context identity admission needs published metadata, not an index, producer, process probe or repair", t => {
  const f = fixture(t);
  const owner = readRunContextIdentity(f.stateDir, f.identity);
  assert.equal(owner.state, "available");
  if (owner.state !== "available") return;
  assert.deepEqual(owner.identity, f.identity); assert.equal(owner.local_path, f.stateDir);
  assert.equal(owner.unchanged(), true); assert.equal(Object.isFrozen(owner.identity), true);
  assert.equal(fs.existsSync(join(f.stateDir, "context-index.json")), false);
  fs.writeFileSync(f.metaPath, JSON.stringify({ ...f.meta, run_instance_id: "generation-b" }));
  assert.equal(owner.unchanged(), false);
  assert.deepEqual(readRunContextIdentity(f.stateDir, f.identity), { state: "unavailable", reason: "identity_mismatch" });
  fs.renameSync(f.metaPath, join(f.stateDir, "prepared-run.json"));
  assert.deepEqual(readRunContextIdentity(f.stateDir, f.identity), { state: "unavailable", reason: "identity_unavailable" });
});

test("Recorded capture/session references stay kernel-local, report partial persistence and read no body", t => {
  const f = fixture(t);
  const before = [f.metaPath, f.sourcePath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)].map(path => fs.readFileSync(path));
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const kill = process.kill; const privateFds = new Set<number>(); let privateOpens = 0;
  const privatePath = (path: unknown) => ["captures", "sessions"].some(namespace => String(path).includes(join(f.stateDir, namespace)));
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(originals.openSync, fs, [path, ...args]); if (privatePath(path)) { privateFds.add(fd); privateOpens++; } return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { privateFds.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.equal(privateFds.has(fd), false, "Raw reference bytes must not be read"); return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.equal(privatePath(path) || (typeof path === "number" && privateFds.has(path)), false); return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => assert.fail("Readonly execution admission wrote, scanned, or probed a process");
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync;
  fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill;
  syncBuiltinESMExports();
  try {
    const capture = f.read(); assert.equal(capture.state, "available");
    if (capture.state === "available") {
      assert.equal(capture.reference.kind, "capture"); assert.equal(capture.reference.bytes_total, 5); assert.equal(capture.unchanged(), true);
      if (capture.reference.kind === "capture") assert.deepEqual(capture.reference.capture, { reported_saved_bytes: 5, reported_observed_bytes: 18, persistence: "incomplete", error: "capture_write_failed" });
      assert.equal(Object.isFrozen(capture.reference), true);
      assert.doesNotMatch(JSON.stringify(capture), /HIDDEN_|"stopped"|"scope_closed"|"status"/);
    }
    assert.equal(f.read(sessionQuery).state, "available");
  } finally { Object.assign(fs, originals); process.kill = kill; syncBuiltinESMExports(); }
  assert.equal(privateOpens, 2); assert.equal(privateFds.size, 0);
  assert.deepEqual([f.metaPath, f.sourcePath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)].map(path => fs.readFileSync(path)), before);
  assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false);
});

test("Wrong/unbound owner-generation or invalid requests cannot probe execution files", t => {
  const f = fixture(t); const open = fs.openSync; let sourceOpens = 0; let privateOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.sourcePath) sourceOpens++; if (String(path).includes(join(f.stateDir, "captures"))) privateOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try {
    for (const expected of [{ ...f.identity, ownerId: "foreign" }, { ...f.identity, run_instance_id: "foreign" }, { run: f.identity.run }, Object.create(f.identity)]) assert.equal(f.read(captureQuery, expected).state, "unavailable");
    for (const query of [null, {}, { ...captureQuery, attempt: "1" }, { ...captureQuery, stream: "provider" }, { ...captureQuery, stopped: true }, Object.create(captureQuery)]) assert.deepEqual(f.read(query), { state: "unavailable", reason: "request_invalid" });
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(sourceOpens, 0); assert.equal(privateOpens, 0);
});

test("Only the requested command/attempt/stream or explicitly recorded session is admitted; there is no discovery fallback", t => {
  const f = fixture(t);
  for (const query of [{ ...captureQuery, command_id: "command-002" }, { ...captureQuery, attempt: 2 }, { ...sessionQuery, path: "sessions/command-001/unrecorded.jsonl" }]) assert.deepEqual(f.read(query), { state: "unavailable", reason: "reference_not_recorded" });
  delete (f.manifest.commands[0].attempts[0].stdout as Record<string, unknown>).path; f.record();
  assert.deepEqual(f.read(), { state: "unavailable", reason: "reference_not_recorded" });
  assert.equal(fs.existsSync(f.file), true);
});

test("Missing, malformed, foreign, legacy-unbound and coercible manifests never confer reference authority", t => {
  const f = fixture(t); fs.rmSync(f.sourcePath); assert.deepEqual(f.read(), { state: "unavailable", reason: "manifest_absent" });
  for (const value of [null, {}, { ...f.manifest, version: "1" }, { ...f.manifest, run_instance_id: undefined }, { ...f.manifest, run_instance_id: "foreign" },
    { ...f.manifest, commands: [f.manifest.commands[0], f.manifest.commands[0]] }]) { fs.writeFileSync(f.sourcePath, JSON.stringify(value)); assert.equal(f.read().state, "unavailable"); }
  fs.writeFileSync(f.sourcePath, "{partial"); assert.equal(f.read().state, "unavailable");
  fs.rmSync(f.sourcePath); fs.mkdirSync(f.sourcePath); assert.equal(f.read().state, "unavailable");
});

test("Malformed UTF-8 cannot normalize into admitted execution metadata", t => {
  const f = fixture(t);
  const encoded = Buffer.from(JSON.stringify({ ...f.manifest, opaque: "BAD_BYTE" }));
  const offset = encoded.indexOf("BAD_BYTE"); assert.notEqual(offset, -1);
  fs.writeFileSync(f.sourcePath, Buffer.concat([encoded.subarray(0, offset), Buffer.from([0xff]), encoded.subarray(offset + 8)]));
  assert.deepEqual(f.read(), { state: "unavailable", reason: "manifest_invalid" });
});

test("Capture size disagreement is unavailable, while null saved bytes remain unknown rather than backfilled", t => {
  const f = fixture(t); f.manifest.commands[0].attempts[0].stdout.bytes = 4; f.record();
  assert.deepEqual(f.read(), { state: "unavailable", reason: "capture_size_mismatch" });
  Object.assign(f.manifest.commands[0].attempts[0].stdout, { bytes: null }); f.record();
  const reading = f.read(); assert.equal(reading.state, "available");
  if (reading.state === "available" && reading.reference.kind === "capture") {
    assert.equal(reading.reference.capture.reported_saved_bytes, null); assert.equal(reading.reference.bytes_total, 5);
    assert.equal(reading.reference.capture.persistence, "incomplete");
  }
  assert.equal(JSON.parse(fs.readFileSync(f.sourcePath, "utf8")).commands[0].attempts[0].stdout.bytes, null);
});

test("Manifest path escapes and mismatched capture paths are refused, not retargeted", t => {
  const f = fixture(t);
  f.manifest.commands[0].attempts[0].stdout.path = "captures/command-002/attempt-001/stdout.log"; f.record();
  assert.deepEqual(f.read(), { state: "unavailable", reason: "reference_invalid" });
  const path = "sessions/../foreign.jsonl"; f.manifest.commands[0].session_files = [path]; f.record();
  assert.deepEqual(f.read({ ...sessionQuery, path }), { state: "unavailable", reason: "reference_invalid" });
});

test("Known source oversize is refused before open; exact UTF-8 1 MiB and large sparse captures remain independent", t => {
  const f = fixture(t); const base = JSON.stringify({ ...f.manifest, padding: "" });
  const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(base);
  const exact = JSON.stringify({ ...f.manifest, padding: "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) });
  assert.equal(Buffer.byteLength(exact), RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); fs.writeFileSync(f.sourcePath, exact);
  assert.equal(f.read().state, "available"); fs.writeFileSync(f.sourcePath, exact + " ");
  const open = fs.openSync; let sourceOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.sourcePath) sourceOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "manifest_unavailable" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(sourceOpens, 0);
  fs.truncateSync(f.file, 512 * 1024 * 1024); Object.assign(f.manifest.commands[0].attempts[0].stdout, { bytes: null }); f.record();
  const large = f.read(); assert.equal(large.state, "available"); if (large.state === "available") assert.equal(large.reference.bytes_total, 512 * 1024 * 1024);
});

test("Observed Run or manifest replacement during file observation refuses the result without repair", t => {
  const f = fixture(t); const open = fs.openSync;
  for (const target of [f.metaPath, f.sourcePath]) {
    fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); f.record(); let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (!changed && String(path) === f.file) { changed = true; const before = JSON.parse(fs.readFileSync(target, "utf8")); fs.renameSync(target, target + ".old"); fs.writeFileSync(target, JSON.stringify({ ...before, run_instance_id: "generation-b" })); } return fd; }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_changed" }); assert.equal(changed, true); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).run_instance_id, "generation-b");
    fs.rmSync(target + ".old");
  }
});

test("Returned observations expire when marker, manifest or target changes and fresh metadata cannot reconstruct native authority", t => {
  const f = fixture(t);
  for (const target of [join(f.stateDir, RUN_STATE_OWNERSHIP_FILE), f.sourcePath, f.file]) {
    const before = fs.readFileSync(target); const reading = f.read(); assert.equal(reading.state, "available");
    fs.appendFileSync(target, " "); if (reading.state === "available") assert.equal(reading.unchanged(), false);
    fs.writeFileSync(target, before);
  }
  const reading = f.read(); assert.equal(reading.state, "available");
  assert.doesNotMatch(JSON.stringify(reading), /HIDDEN_|producer|work_admission|scope_closed|ownership_token/);
});

test("Symlinked source or owned namespaces do not become exact-generation references", { skip: process.platform === "win32" }, t => {
  const f = fixture(t); fs.renameSync(f.sourcePath, f.sourcePath + ".held"); fs.symlinkSync(f.sourcePath + ".held", f.sourcePath);
  assert.equal(f.read().state, "unavailable"); fs.rmSync(f.sourcePath); fs.renameSync(f.sourcePath + ".held", f.sourcePath);
  const directory = join(f.stateDir, "sessions"); fs.renameSync(directory, directory + ".held"); fs.symlinkSync(directory + ".held", directory, "dir");
  assert.equal(f.read(sessionQuery).state, "unavailable");
});

});

await describe("Manifest projection", { concurrency: false }, async () => {
/** Data-only execution manifest normalization, without session/capture body access or scope authority. */

const expected = { run: "worker", run_instance_id: "generation-a" };
const stamp = "2026-01-01T00:00:00.000Z";
function manifest() {
  return { version: 1, ...expected, status: "running", updated_at: stamp, active_subagents: 1,
    commands: [{ id: "command-001", status: "running", stage: "worker", occurrence: 1, started_at: stamp,
      command: "/private/execution/helper.mjs token=HIDDEN_COMMAND", semantic_acceptance: "pending",
      session_files: ["sessions/command-001/private.jsonl"], prompt_file: "prompts/private.txt",
      attempts: [{ attempt: 1, code: 7, native_exit_code: 7, killed: false,
        stdout: { path: "captures/command-001/attempt-001/stdout.log", bytes: 6, bytes_observed: 18, complete: false, error: "capture_write_failed" },
        stderr: { path: "captures/command-001/attempt-001/stderr.log", bytes: 0 } }] }] };
}

test("Execution projection keeps saved/observed/unknown byte facts distinct and does not invent aggregate exits or full scope closure", () => {
  const source = manifest();
  const result = projectRunExecutionManifest(expected, source, { values: { skill_dir: "/private/execution" } });
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  const view = result.view;
  assert.equal(view.reported_status, "running");
  assert.equal(view.reported_active_subagents, 1);
  assert.equal(view.commands_total, 1);
  assert.equal(view.settled_attempts_reported, 1);
  const command = view.commands[0];
  assert.equal(command.reported_status, "running");
  assert.equal(command.effective_exit_code, undefined);
  assert.equal(command.reported_session_file_count, 1);
  assert.deepEqual(command.attempts[0].stdout, { reported_saved_bytes: 6, persistence: "incomplete", reported_observed_bytes: 18, error: "capture_write_failed" });
  assert.deepEqual(command.attempts[0].stderr, { reported_saved_bytes: 0, persistence: "reported_complete" });
  assert.doesNotMatch(JSON.stringify(view), /\/private\/execution|HIDDEN_COMMAND|private\.jsonl|prompts\/|captures\/|"stopped"|"scope_closed"/);
  assert.equal(Object.isFrozen(view.commands), true);
  assert.equal(Object.isFrozen(command.attempts[0].stdout), true);
  source.commands[0].attempts[0].stdout.bytes = 99;
  assert.equal(command.attempts[0].stdout.reported_saved_bytes, 6);
});

test("Execution projection rejects foreign/unbound/coercible/duplicate manifest facts", () => {
  const cases: unknown[] = [null, {}, { ...manifest(), version: 2 }, { ...manifest(), run_instance_id: "foreign" },
    { ...manifest(), status: "timed_out" }, { ...manifest(), active_subagents: "1" },
    { ...manifest(), commands: [manifest().commands[0], manifest().commands[0]] }];
  const badCode = manifest(); (badCode.commands[0].attempts[0] as Record<string, unknown>).code = "7"; cases.push(badCode);
  const badOrder = manifest(); badOrder.commands[0].attempts[0].attempt = 2; cases.push(badOrder);
  const badBytes = manifest(); (badBytes.commands[0].attempts[0].stdout as Record<string, unknown>).bytes = "6"; cases.push(badBytes);
  const badSaved = manifest(); badSaved.commands[0].attempts[0].stdout.bytes = 19; cases.push(badSaved);
  for (const source of cases) assert.equal(projectRunExecutionManifest(expected, source).state, "unavailable");
});

test("Execution projection retains null saved bytes and null native exit with a signal without normalizing them to zero", () => {
  const source = manifest();
  Object.assign(source.commands[0].attempts[0], { native_exit_code: null, native_signal: "SIGTERM", code: 1 });
  Object.assign(source.commands[0].attempts[0].stdout, { bytes: null, bytes_observed: 18 });
  const result = projectRunExecutionManifest(expected, source);
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  const attempt = result.view.commands[0].attempts[0];
  assert.equal(attempt.native_exit_code, null);
  assert.equal(attempt.native_signal, "SIGTERM");
  assert.equal(attempt.stdout.reported_saved_bytes, null);
  assert.equal(attempt.stdout.persistence, "incomplete");
});

test("Execution projection performs no IO, scans, process probes or unknown/private-payload serialization", () => {
  const source = manifest();
  Object.defineProperty(source, "provider_payload", { enumerable: true, get() { throw Error("Private payload accessed"); } });
  Object.defineProperty(source.commands[0], "thinking", { enumerable: true, get() { throw Error("Private thinking accessed"); } });
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const kill = process.kill;
  const forbidden = () => assert.fail("Data-only execution projection performed IO");
  fs.openSync = forbidden as typeof fs.openSync;
  fs.readFileSync = forbidden as typeof fs.readFileSync;
  fs.readdirSync = forbidden as typeof fs.readdirSync;
  process.kill = forbidden as typeof process.kill;
  syncBuiltinESMExports();
  try { assert.equal(projectRunExecutionManifest(expected, source).state, "available"); }
  finally { Object.assign(fs, originals); process.kill = kill; syncBuiltinESMExports(); }
});

});

await describe("Canonical stream admission", { concurrency: false }, async () => {
/** Kernel-only canonical stream source admission; raw input is never a model-facing view. */

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-stream-source-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { run: "stream-source", run_instance_id: "generation-a", ownerId: "owner-a" };
  const stateDir = claimRunStateDirectory(join(root, "state"), identity.run); const metaPath = join(stateDir, "run.json");
  const meta = { ...identity, state_dir: stateDir, pid: 0 }; fs.writeFileSync(metaPath, JSON.stringify(meta));
  const stdout = join(stateDir, "stdout.log"); const stderr = join(stateDir, "stderr.log");
  fs.writeFileSync(stdout, "\uFEFF界😀 stdout\n"); fs.writeFileSync(stderr, "stderr\n");
  const read = (stream: unknown = "stdout", expected: unknown = identity) => readRunStreamSource(stateDir, expected, stream);
  return { root, stateDir, identity, meta, metaPath, stdout, stderr, read };
}
function watchBody(file: string, run: (reads: () => number, fds: Set<number>) => void) {
  const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const fds = new Set<number>(); let count = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === file) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) count++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { run(() => count, fds); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
}

test("Canonical stream source binds exact identity, preserves UTF-8/BOM and stays kernel-only without claiming capture completeness", t => {
  const f = fixture(t);
  for (const stream of ["stdout", "stderr"] as const) {
    const path = f[stream]; const value = f.read(stream); assert.equal(value.state, "available"); if (value.state !== "available") continue;
    assert.deepEqual(value.identity, f.identity); assert.equal(value.stream, stream); assert.equal(value.text, fs.readFileSync(path, "utf8"));
    assert.equal(value.bytes_total, fs.statSync(path).size); assert.equal(value.source_scope, "canonical_runner_stream"); assert.equal(value.visibility, "kernel_only");
    assert.equal(value.capture_completeness, "not_asserted"); assert.equal(value.unchanged(), true); assert.equal(Object.isFrozen(value), true);
    assert.equal("local_path" in value, false); assert.equal("preview" in value, false);
  }
  fs.writeFileSync(f.stdout, ""); const empty = f.read(); assert.equal(empty.state, "available"); if (empty.state === "available") assert.equal(empty.text, "");
  fs.rmSync(f.stdout); assert.deepEqual(f.read(), { state: "unavailable", reason: "stream_missing" });
});

test("Wrong identity/owner, unpublished preparation and malformed stream selectors cannot open a body or fall back to latest", t => {
  const f = fixture(t);
  watchBody(f.stdout, reads => {
    for (const stream of [undefined, null, {}, { stream: "stdout" }, "STDOUT", "../stdout.log", "stdout.log", "captures/command-001/attempt-001/stdout.log"]) {
      assert.deepEqual(readRunStreamSource(f.stateDir, f.identity, stream), { state: "unavailable", reason: "stream_invalid" });
    }
    assert.equal(f.read("stdout", { ...f.identity, ownerId: "foreign" }).state, "unavailable");
    assert.equal(f.read("stdout", { ...f.identity, run_instance_id: "foreign" }).state, "unavailable");
    fs.renameSync(f.metaPath, join(f.stateDir, "prepared-run.json")); assert.equal(f.read().state, "unavailable"); assert.equal(reads(), 0);
  });
});

test("Stream source reads only selected canonical bytes and creates no view/index, discovery, status, ACK or process effects", t => {
  const f = fixture(t); const originals = { openSync: fs.openSync, readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const kill = process.kill; const before = [f.metaPath, f.stdout, f.stderr].map(path => fs.readFileSync(path));
  const allowed = new Set([f.metaPath, f.stdout, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)]);
  fs.openSync = ((path, ...args) => { assert.equal(allowed.has(String(path)), true, `Unexpected source: ${String(path)}`); return Reflect.apply(originals.openSync, fs, [path, ...args]); }) as typeof fs.openSync;
  const forbidden = () => assert.fail("Stream read mutated, scanned or probed a process");
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; syncBuiltinESMExports();
  try { assert.equal(f.read().state, "available"); } finally { Object.assign(fs, originals); process.kill = kill; syncBuiltinESMExports(); }
  assert.deepEqual([f.metaPath, f.stdout, f.stderr].map(path => fs.readFileSync(path)), before); assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false); assert.equal(fs.existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Exact 4 MiB UTF-8 source is admitted; oversize refuses before opening/body reads while metadata observation remains quota-free", t => {
  const f = fixture(t); const text = "界".repeat(Math.floor(RUN_STREAM_SOURCE_MAX_BYTES / 3)) + "x".repeat(RUN_STREAM_SOURCE_MAX_BYTES % 3);
  fs.writeFileSync(f.stdout, text); const exact = f.read(); assert.equal(exact.state, "available"); if (exact.state === "available") assert.equal(exact.text, text);
  fs.appendFileSync(f.stdout, "x"); const open = fs.openSync; let opened = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.stdout) opened++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "stream_too_large" }); assert.equal(opened, 0); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  watchBody(f.stdout, reads => { const metadata = observeExecutionFileReference(f.stateDir, { kind: "runner_stream", path: "stdout.log" }); assert.equal(metadata.availability, "available"); assert.equal(reads(), 0); });
});

test("Strict UTF-8 rejects malformed bytes without replacement normalization; legitimately encoded replacement characters remain text", t => {
  const f = fixture(t); fs.writeFileSync(f.stdout, Buffer.from([0xff])); assert.deepEqual(f.read(), { state: "unavailable", reason: "stream_invalid_text" });
  fs.writeFileSync(f.stdout, "�"); const valid = f.read(); assert.equal(valid.state, "available"); if (valid.state === "available") assert.equal(valid.text, "�");
});

test("Root/marker/metadata/file replacement during descriptor read invalidates the source and never reconstructs a later generation", t => {
  const f = fixture(t); const marker = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE); const sources = [f.metaPath, marker, f.stdout]; const originals = sources.map(path => fs.readFileSync(path));
  const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync;
  for (const target of [...sources, f.stateDir]) {
    sources.forEach((path, i) => fs.writeFileSync(path, originals[i]));
    const fds = new Set<number>(); let attempted = false, changed = false, mutationError: unknown;
    const replace = () => {
      attempted = true;
      try {
        fs.renameSync(target, target + ".old");
        if (target === f.stateDir) fs.cpSync(target + ".old", target, { recursive: true });
        else fs.writeFileSync(target, target === f.metaPath ? JSON.stringify({ ...f.meta, run_instance_id: "generation-b" }) : fs.readFileSync(target + ".old"));
        changed = true;
      } catch (error) { mutationError = error; throw error; }
    };
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.stdout) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => {
      const result = Reflect.apply(read, fs, [fd, ...args]);
      if (fds.has(fd) && !attempted && target !== f.stateDir) replace();
      return result;
    }) as typeof fs.readSync;
    fs.closeSync = ((fd) => {
      const tracked = fds.delete(fd); const result = close(fd);
      // Windows may deny moving a directory containing an open descriptor.
      // Replace the root after actual close but before the upper owner/reference
      // rechecks; leaf/metadata/marker swaps still happen during the body read.
      if (tracked && !attempted && target === f.stateDir) replace();
      return result;
    }) as typeof fs.closeSync; syncBuiltinESMExports();
    let reading: ReturnType<typeof f.read>;
    try { reading = f.read(); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.ifError(mutationError); assert.equal(attempted, true, target); assert.equal(changed, true, target);
    assert.equal(reading.state, "unavailable", target);
    assert.equal(fds.size, 0); fs.rmSync(target + ".old", { recursive: true });
  }
});

test("Source dependency callbacks expire; denied or nonregular sources and descriptor-close failures never advertise readable text", t => {
  const f = fixture(t); const first = f.read(); fs.appendFileSync(f.stdout, "more"); if (first.state === "available") assert.equal(first.unchanged(), false);
  const open = fs.openSync; const close = fs.closeSync; const read = fs.readSync; const fds = new Set<number>(); let opens = 0; let reads = 0; let closes = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.stdout) throw Object.assign(new Error("PRIVATE denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "stream_unavailable" }); } finally { fs.openSync = open; syncBuiltinESMExports(); }
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.stdout) { fds.add(fd); opens++; } return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) reads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { const tracked = fds.delete(fd); const result = close(fd); if (tracked) { closes++; throw Object.assign(new Error("PRIVATE close"), { code: "EIO" }); } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "stream_unavailable" }); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(opens, 1); assert.equal(reads, 1); assert.equal(closes, 1); assert.equal(fds.size, 0);
  fs.rmSync(f.stdout); fs.mkdirSync(f.stdout); assert.equal(f.read().state, "unavailable");
});

test("Lower stream text port admits only fixed root stream names; metadata ports never confer model-body visibility", t => {
  const f = fixture(t);
  for (const stream of [undefined, null, {}, "../stdout", "stdout.log", "STDOUT", "session"]) assert.equal(readExecutionRunnerStreamText(f.stateDir, stream).availability, "unavailable");
  const source = readExecutionRunnerStreamText(f.stateDir, "stdout"); assert.equal(source.availability, "available");
  for (const path of ["captures/command-001/attempt-001/stdout.log", "sessions/private.jsonl", "evidence/stdout.log", "../stdout.log", "/stdout.log"]) {
    assert.equal(observeExecutionFileReference(f.stateDir, { kind: "runner_stream", path }).availability, "unavailable");
  }
});

test("Symlinked state roots or stream leaves never admit text, including aliases back into state", { skip: process.platform === "win32" }, t => {
  const f = fixture(t); fs.renameSync(f.stdout, f.stdout + ".held"); fs.symlinkSync(f.stdout + ".held", f.stdout);
  assert.equal(f.read().state, "unavailable"); fs.rmSync(f.stdout); fs.renameSync(f.stdout + ".held", f.stdout);
  const alias = join(f.root, "alias"); fs.symlinkSync(f.stateDir, alias, "dir"); assert.equal(readRunStreamSource(alias, f.identity, "stdout").state, "unavailable");
});

});
