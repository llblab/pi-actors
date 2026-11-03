/** Owned-layout metadata checks are kernel-local observations, never body exposure or Run/native authority. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { observeExecutionFileReference } from "../lib/execution-files.ts";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-execution-files-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"); fs.mkdirSync(state);
  const relative = "captures/command-001/attempt-001/stdout.log";
  const file = join(state, relative); fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file, "hello");
  return { root, state, relative, file, request: { kind: "capture", path: relative } };
}

test("Execution file observation reads no body or directory inventory and does not impose file-size quotas", t => {
  const f = fixture(t); fs.truncateSync(f.file, 512 * 1024 * 1024);
  const read = fs.readFileSync; const chunk = fs.readSync; const scan = fs.readdirSync;
  const forbidden = () => assert.fail("Metadata observation read a body/inventory");
  fs.readFileSync = forbidden as typeof fs.readFileSync; fs.readSync = forbidden as typeof fs.readSync; fs.readdirSync = forbidden as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const observed = observeExecutionFileReference(f.state, f.request);
    assert.equal(observed.availability, "available");
    if (observed.availability !== "available") return;
    assert.equal(observed.bytes_total, 512 * 1024 * 1024);
    assert.equal(observed.path, f.relative);
    assert.equal(observed.local_path, join(fs.realpathSync(f.state), f.relative));
    assert.equal(observed.mutable, true); assert.equal(observed.unchanged(), true);
    assert.equal(Object.isFrozen(observed), true);
  } finally { fs.readFileSync = read; fs.readSync = chunk; fs.readdirSync = scan; syncBuiltinESMExports(); }
});

test("Execution reference grammar rejects escapes, aliases, inherited fields and namespace confusion before filesystem IO", t => {
  const f = fixture(t);
  const requests = [null, {}, { kind: "session", path: f.relative }, { kind: "capture", path: "sessions/a.jsonl" },
    { kind: "session", path: "/sessions/a.jsonl" }, { kind: "session", path: "C:\\sessions\\a.jsonl" },
    { kind: "session", path: "sessions/../a.jsonl" }, { kind: "session", path: "sessions//a.jsonl" },
    { kind: "session", path: "sessions/./a.jsonl" }, { kind: "session", path: "sessions/a.jsonl\n" },
    { kind: "capture", path: "captures/command-001/attempt-000/stdout.log" },
    { kind: "capture", path: "captures/command-001/attempt-001/private.jsonl" },
    Object.create({ kind: "session", path: "sessions/private.jsonl" })];
  const stat = fs.lstatSync; let calls = 0;
  fs.lstatSync = (() => { calls++; throw Error("Unexpected filesystem access"); }) as typeof fs.lstatSync; syncBuiltinESMExports();
  try { for (const request of requests) assert.deepEqual(observeExecutionFileReference(f.state, request), { availability: "unavailable", reason: "invalid_reference" }); }
  finally { fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(calls, 0);
});

test("Session reference spelling supports legacy owned files and nested Unicode names without retargeting parents", t => {
  const f = fixture(t);
  for (const relative of ["sessions/legacy.jsonl", "sessions/command-1/сессия №1.jsonl"]) {
    const file = join(f.state, relative); fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file, "private");
    const value = observeExecutionFileReference(f.state, { kind: "session", path: relative });
    assert.equal(value.availability, "available");
    if (value.availability === "available") { assert.equal(value.path, relative); fs.appendFileSync(file, "more"); assert.equal(value.unchanged(), false); }
  }
});

test("Missing, nonregular, denied and unrepresentable-size references remain unavailable", t => {
  const f = fixture(t);
  assert.deepEqual(observeExecutionFileReference(f.state, { kind: "session", path: "sessions/absent.jsonl" }), { availability: "unavailable", reason: "reference_missing" });
  fs.rmSync(f.file); fs.mkdirSync(f.file); assert.equal(observeExecutionFileReference(f.state, f.request).availability, "unavailable"); fs.rmdirSync(f.file); fs.writeFileSync(f.file, "hello");
  const open = fs.openSync; fs.openSync = ((path, ...args) => { if (String(path) === f.file) throw Object.assign(new Error("denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(observeExecutionFileReference(f.state, f.request).availability, "unavailable"); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  const stat = fs.lstatSync; let opens = 0;
  fs.lstatSync = ((path, ...args) => { const value = Reflect.apply(stat, fs, [path, ...args]); if (String(path) === f.file) Object.defineProperty(value, "size", { value: BigInt(Number.MAX_SAFE_INTEGER) + 1n }); return value; }) as typeof fs.lstatSync;
  fs.openSync = ((...args) => { opens++; return Reflect.apply(open, fs, args); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.deepEqual(observeExecutionFileReference(f.state, f.request), { availability: "unavailable", reason: "reference_size_unrepresentable" }); }
  finally { fs.lstatSync = stat; fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(opens, 0);
});

test("Root, namespace, intermediate and leaf symlinks never admit a reference, including links back inside state", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const original = observeExecutionFileReference(f.state, f.request); assert.equal(original.availability, "available");
  const leaf = f.file + ".original"; fs.renameSync(f.file, leaf); fs.symlinkSync(leaf, f.file);
  assert.equal(observeExecutionFileReference(f.state, f.request).availability, "unavailable"); fs.rmSync(f.file); fs.renameSync(leaf, f.file);
  for (const directory of [join(f.state, "captures", "command-001", "attempt-001"), join(f.state, "captures"), f.state]) {
    const held = directory + ".original"; fs.renameSync(directory, held); fs.symlinkSync(held, directory, "dir");
    assert.equal(observeExecutionFileReference(f.state, f.request).availability, "unavailable");
    fs.rmSync(directory); fs.renameSync(held, directory);
  }
  assert.equal(observeExecutionFileReference(f.state, f.request).availability, "available");
});

test("Opened-file substitution is rejected and the retained descriptor is closed", t => {
  const f = fixture(t); const open = fs.openSync; const close = fs.closeSync; let captured: number | undefined; let closed = false;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) { captured = fd; fs.renameSync(f.file, f.file + ".old"); fs.writeFileSync(f.file, "alien"); } return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { if (fd === captured) closed = true; return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.equal(observeExecutionFileReference(f.state, f.request).availability, "unavailable"); }
  finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(closed, true);
});

test("Close failure cannot advertise a successful observation and causes no implicit open retry", t => {
  const f = fixture(t); const open = fs.openSync; const close = fs.closeSync; let fd: number | undefined; let opens = 0;
  fs.openSync = ((path, ...args) => { const result = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) { fd = result; opens++; } return result; }) as typeof fs.openSync;
  fs.closeSync = ((candidate) => { const result = close(candidate); if (candidate === fd) throw Object.assign(new Error("close EIO"), { code: "EIO" }); return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.equal(observeExecutionFileReference(resolve(f.state), f.request).availability, "unavailable"); }
  finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(opens, 1);
});
