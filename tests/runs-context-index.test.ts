/** Readonly admission of generation-bound context-index metadata and export references. */

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { claimRunStateDirectory, readOwnedRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } from "../lib/runs-ownership.ts";
import { readRunContextIndex, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES,
  RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "../lib/runs-context-index.ts";

import * as ContextIndex from "../lib/runs-context-index.ts";

const identity = { run: "review", run_instance_id: "generation-a", ownerId: "owner-a" };
const roles = {
  recipe: ["recipe.json", "application/json"], result: ["result.json", "application/json"],
  trace: ["trace.jsonl", "application/x-ndjson"], control: ["control.json", "application/json"],
  execution: ["execution.json", "application/json"], artifacts: ["artifacts.json", "application/json"],
  sessions: ["sessions.json", "application/json"], stdout: ["stdout.log", "text/plain"], stderr: ["stderr.log", "text/plain"],
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-context-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), identity.run);
  const metaPath = join(stateDir, "run.json");
  const indexPath = join(stateDir, "context-index.json");
  const meta = { ...identity, state_dir: stateDir, pid: 0 };
  writeJson(metaPath, meta);
  mkdirSync(join(stateDir, "evidence"));
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [role, [file, media_type]] of Object.entries(roles)) {
    const body = JSON.stringify({ fixture_private_body: role }) + "\n";
    writeFileSync(join(stateDir, "evidence", file), body);
    entries[role] = { availability: "available", path: "evidence/" + file, media_type,
      bytes_total: Buffer.byteLength(body), mutable: role !== "recipe" && role !== "result",
      coverage: { truncated: false, history_complete: true, redacted: true } };
  }
  const index = { schema: "run-context-index-v1", run: identity.run, run_instance_id: identity.run_instance_id,
    updated_at: "2026-10-22T19:44:08.000Z", entries };
  const publish = () => writeJson(indexPath, index);
  publish();
  const read = (expected: unknown = identity) => readRunContextIndex(stateDir, expected);
  return { root, stateDir, metaPath, indexPath, meta, index, entries, publish, read };
}

function unavailable(reading: ReturnType<typeof readRunContextIndex>, reason?: string) {
  assert.equal(reading.state, "unavailable");
  if (reason) assert.deepEqual(reading, { state: "unavailable", reason });
  assert.doesNotMatch(JSON.stringify(reading), /fixture_private_body|ownership_token|owner-a|context-index-/);
}

function location(stateDir: string, expected: unknown = identity, role: unknown = "sessions"): any {
  const operation = (ContextIndex as unknown as { observeRunContextExportLocation?: (...args: unknown[]) => unknown }).observeRunContextExportLocation;
  assert.equal(typeof operation, "function");
  return operation!(stateDir, expected, role);
}

test("Export locations need exact roots but no index, body bytes, original producer or publication flags", (t) => {
  const f = fixture(t);
  rmSync(f.indexPath); writeFileSync(join(f.stateDir, "evidence", "sessions.json"), Buffer.from([0xff, 0x00]));
  let forbidden = 0;
  const open = fs.openSync;
  const opened = t.mock.method(fs, "openSync", (path: fs.PathLike, ...args: any[]) => {
    if (String(path).includes(join("evidence", "")) || String(path) === f.indexPath) { forbidden++; throw Error("Forbidden index/body open"); }
    return Reflect.apply(open, fs, [path, ...args]);
  });
  const scanned = t.mock.method(fs, "readdirSync", () => { forbidden++; throw Error("Forbidden scan"); });
  const probed = t.mock.method(process, "kill", () => { forbidden++; throw Error("Forbidden native probe"); });
  syncBuiltinESMExports();
  let readings: any[];
  try { readings = Object.keys(roles).map(role => location(f.stateDir, identity, role)); }
  finally { opened.mock.restore(); scanned.mock.restore(); probed.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(forbidden, 0);
  for (const [index, reading] of readings.entries()) {
    const role = Object.keys(roles)[index] as keyof typeof roles;
    assert.equal(reading.state, "available"); assert.equal(reading.path, `evidence/${roles[role][0]}`);
    assert.equal(reading.local_path, join(f.stateDir, reading.path)); assert.deepEqual(reading.identity, identity);
    assert.equal(reading.mutable, true); assert.equal(reading.unchanged(), true);
    assert.equal(Object.isFrozen(reading) && Object.isFrozen(reading.identity), true);
    assert.doesNotMatch(JSON.stringify(reading), /fixture_private_body|ownership_token/);
  }
  assert.equal(readings[Object.keys(roles).indexOf("sessions")].bytes_total, 2);
  writeFileSync(f.indexPath, "{broken"); assert.equal(location(f.stateDir).state, "available");
  assert.equal(readFileSync(f.indexPath, "utf8"), "{broken");
  for (const availability of ["pending", "not_applicable", "unavailable"]) {
    f.entries.sessions = { availability, path: null, ...(availability === "unavailable" ? { reason: "publication_unavailable" } : {}) };
    f.publish(); const before = readFileSync(f.indexPath);
    assert.equal(location(f.stateDir).state, "available"); assert.deepEqual(readFileSync(f.indexPath), before);
  }
  f.index.run_instance_id = "foreign-index-generation"; f.publish();
  assert.equal(location(f.stateDir).state, "available");
});

test("Export locations reject foreign ownership and arbitrary role paths before target observations", (t) => {
  const f = fixture(t); let targets = 0;
  const stat = fs.lstatSync;
  const observed = t.mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
    if (String(path).startsWith(join(f.stateDir, "evidence"))) targets++;
    return Reflect.apply(stat, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  let rejected: any[];
  try {
    rejected = ["../sessions.json", "__proto__", "evidence/sessions.json", { toString() { assert.fail("Role coercion"); } }].map(role => location(f.stateDir, identity, role));
    rejected.push(location(f.stateDir, { ...identity, ownerId: "other" }));
    rejected.push(location(f.stateDir, { ...identity, run_instance_id: "other" }));
  } finally { observed.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(targets, 0);
  for (const reading of rejected) { assert.equal(reading.state, "unavailable"); assert.equal(Object.hasOwn(reading, "local_path"), false); }
  assert.equal(location(f.stateDir).state, "available");
});

test("Export locations refuse missing/nonregular/aliased files and retain parent/leaf/owner change fences", (t) => {
  const f = fixture(t), path = join(f.stateDir, "evidence", "sessions.json");
  const stat = fs.lstatSync;
  const observed = t.mock.method(fs, "lstatSync", (target: fs.PathLike, ...args: any[]) => {
    const value = Reflect.apply(stat, fs, [target, ...args]);
    if (String(target) !== path) return value;
    return Object.defineProperty(Object.create(value), "size", { value: BigInt(Number.MAX_SAFE_INTEGER) + 1n });
  });
  syncBuiltinESMExports(); let oversized: any;
  try { oversized = location(f.stateDir); }
  finally { observed.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(oversized, { state: "unavailable", reason: "export_size_unrepresentable" });
  const retained = location(f.stateDir);
  const changedType = t.mock.method(fs, "lstatSync", (target: fs.PathLike, ...args: any[]) => {
    const value = Reflect.apply(stat, fs, [target, ...args]);
    if (String(target) !== join(f.stateDir, "evidence")) return value;
    // Model a reused object id with changed type; dev/ino agreement alone cannot preserve directory containment.
    return Object.defineProperties(Object.create(value), { isDirectory: { value: () => false }, isSymbolicLink: { value: () => true } });
  });
  syncBuiltinESMExports(); let typeUnchanged: boolean;
  try { typeUnchanged = retained.unchanged(); }
  finally { changedType.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(typeUnchanged, false);
  const initial = location(f.stateDir); writeFileSync(path, "replacement"); assert.equal(initial.unchanged(), false);
  rmSync(path); assert.deepEqual(location(f.stateDir), { state: "unavailable", reason: "export_missing" });
  mkdirSync(path); assert.deepEqual(location(f.stateDir), { state: "unavailable", reason: "export_unavailable" });
  rmSync(path, { recursive: true }); writeFileSync(path, "current");
  const owner = location(f.stateDir); writeJson(f.metaPath, { ...f.meta, ownerId: "other" }); assert.equal(owner.unchanged(), false); writeJson(f.metaPath, f.meta);
  if (process.platform !== "win32") {
    rmSync(path); symlinkSync(f.metaPath, path); assert.equal(location(f.stateDir).state, "unavailable"); rmSync(path); writeFileSync(path, "current");
    const parent = location(f.stateDir); const retained = join(f.stateDir, "retained-evidence"); renameSync(join(f.stateDir, "evidence"), retained);
    symlinkSync(retained, join(f.stateDir, "evidence"), "dir");
    assert.equal(parent.unchanged(), false); assert.deepEqual(location(f.stateDir), { state: "unavailable", reason: "export_unavailable" });
  }
});

test("Index admission preserves all declared roles and freezes metadata without including role bodies or tokens", (t) => {
  const f = fixture(t);
  f.entries.recipe = { availability: "not_applicable", path: null };
  f.entries.result = { availability: "pending", path: null };
  f.entries.stderr = { availability: "unavailable", path: null, reason: "capture_unavailable" };
  f.publish();
  const reading = f.read();
  assert.equal(reading.state, "available");
  if (reading.state !== "available") return;
  assert.deepEqual(reading.index, f.index);
  assert.equal(reading.local_path, f.indexPath);
  assert.deepEqual(reading.identity, identity);
  assert.equal(Object.isFrozen(reading), true);
  assert.equal(Object.isFrozen(reading.identity), true);
  assert.equal(Object.isFrozen(reading.index.entries), true);
  assert.equal(Object.isFrozen(reading.index.entries.trace), true);
  const trace = reading.index.entries.trace;
  if (trace.availability === "available") assert.equal(Object.isFrozen(trace.coverage), true);
  assert.doesNotMatch(JSON.stringify(reading), /fixture_private_body|ownership_token/);
});

test("Pending roles need no export directory and do not materialize pretend empty views", (t) => {
  const f = fixture(t);
  for (const role of Object.keys(f.entries)) f.entries[role] = { availability: "pending", path: null };
  f.publish();
  rmSync(join(f.stateDir, "evidence"), { recursive: true });
  assert.equal(f.read().state, "available");
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
});

test("Index reads perform no writes, directory scans, process probes or role-body reads", (t) => {
  const f = fixture(t);
  writeJson(f.metaPath, { ...f.meta, values: { prompt: "private metadata, not a role body: ".repeat(1024) } });
  assert.ok(fs.statSync(f.metaPath).size > RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
  const files = [f.metaPath, f.indexPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE),
    ...Object.values(roles).map(([file]) => join(f.stateDir, "evidence", file))];
  const before = files.map(path => readFileSync(path));
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const kill = process.kill;
  const roleFds = new Set<number>();
  let roleOpens = 0;
  fs.openSync = ((path, ...args) => {
    const fd = Reflect.apply(originals.openSync, fs, [path, ...args]);
    if (String(path).includes(join("evidence", ""))) { roleFds.add(fd); roleOpens++; }
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { roleFds.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.equal(roleFds.has(fd), false, "Role bodies must stay unopened for reading bytes");
    return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.equal(String(path).includes(join("evidence", "")), false);
    return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => assert.fail("Readonly admission attempted mutation, scan or process probe");
  fs.readdirSync = forbidden as typeof fs.readdirSync;
  fs.mkdirSync = forbidden as typeof fs.mkdirSync;
  fs.writeFileSync = forbidden as typeof fs.writeFileSync;
  fs.renameSync = forbidden as typeof fs.renameSync;
  fs.rmSync = forbidden as typeof fs.rmSync;
  process.kill = forbidden as typeof process.kill;
  syncBuiltinESMExports();
  try { assert.equal(f.read().state, "available"); }
  finally { Object.assign(fs, originals); process.kill = kill; syncBuiltinESMExports(); }
  assert.equal(roleOpens, 9);
  assert.equal(roleFds.size, 0);
  assert.deepEqual(files.map(path => readFileSync(path)), before);
});

test("Run metadata has its own exact UTF-8 byte ceiling independent of the compact index", (t) => {
  const f = fixture(t);
  const sourceBudget = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES;
  assert.equal(sourceBudget, 1024 * 1024);
  const base = { ...f.meta, values: { prompt: "" } };
  const room = sourceBudget - Buffer.byteLength(JSON.stringify(base), "utf8");
  base.values.prompt = "🫧".repeat(Math.floor(room / 4)) + "x".repeat(room % 4);
  const encoded = JSON.stringify(base);
  assert.equal(Buffer.byteLength(encoded, "utf8"), sourceBudget);
  assert.ok(encoded.length < sourceBudget);
  writeFileSync(f.metaPath, encoded);
  const before = readFileSync(f.metaPath);
  const reading = f.read();
  assert.equal(reading.state, "available");
  assert.ok(Buffer.byteLength(JSON.stringify(reading), "utf8") <= RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
  assert.doesNotMatch(JSON.stringify(reading), /🫧|prompt/);
  assert.deepEqual(readFileSync(f.metaPath), before);
  writeFileSync(f.metaPath, encoded + " ");
  const open = fs.openSync;
  let metadataOpens = 0;
  fs.openSync = ((path, ...args) => {
    if (String(path) === f.metaPath) metadataOpens++;
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { unavailable(f.read(), "identity_unavailable"); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(metadataOpens, 0, "Known over-budget metadata must be refused before opening/allocating it");
  assert.equal(readFileSync(f.metaPath, "utf8"), encoded + " ");
});

test("Index admission requires exact owned run/generation/owner and published metadata, not preparation", (t) => {
  const f = fixture(t);
  for (const delta of [{ run: "foreign" }, { run_instance_id: "generation-b" }, { ownerId: "owner-b" }]) {
    unavailable(f.read({ ...identity, ...delta }), "identity_mismatch");
    writeJson(f.metaPath, { ...f.meta, ...delta });
    unavailable(f.read(), "identity_mismatch");
    writeJson(f.metaPath, f.meta);
  }
  const { ownerId: _owner, ...ownerless } = f.meta;
  writeJson(f.metaPath, ownerless);
  unavailable(f.read(), "identity_mismatch");
  const { ownerId: _requestOwner, ...expected } = identity;
  assert.equal(f.read(expected).state, "available");
  renameSync(f.metaPath, join(f.stateDir, "prepared-run.json"));
  unavailable(f.read(expected), "identity_unavailable");
  assert.equal(existsSync(f.metaPath), false);
});

test("Malformed identity and bounded ownership/metadata failures never create or repair state", (t) => {
  const f = fixture(t);
  for (const expected of [null, [], {}, { ...identity, run: "run:review" }, { ...identity, run_instance_id: "" },
    { ...identity, ownerId: undefined }, Object.create(identity)]) unavailable(f.read(expected), "identity_unavailable");
  for (const maxBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => readOwnedRunStateDirectory(f.stateDir, { maxBytes }), /read budget/);
  }
  assert.throws(() => readOwnedRunStateDirectory(f.stateDir, { maxBytes: 4 }));
  assert.equal(readOwnedRunStateDirectory(f.stateDir).run, identity.run);
  const markerPath = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE);
  const marker = readFileSync(markerPath);
  writeFileSync(markerPath, " ".repeat(RUN_CONTEXT_INDEX_METADATA_MAX_BYTES + 1));
  unavailable(f.read(), "identity_unavailable");
  writeFileSync(markerPath, marker);
  writeJson(f.metaPath, { ...f.meta, opaque: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) });
  unavailable(f.read(), "identity_unavailable");
  writeJson(f.metaPath, { ...f.meta, state_dir: f.root });
  unavailable(f.read(), "identity_mismatch");
  const absent = join(f.root, "missing");
  unavailable(readRunContextIndex(absent, identity));
  assert.equal(existsSync(absent), false);
});

test("Index metadata has an exact byte ceiling and is never repaired from malformed or absent files", (t) => {
  const f = fixture(t);
  const body = JSON.stringify(f.index);
  writeFileSync(f.indexPath, body + " ".repeat(RUN_CONTEXT_INDEX_METADATA_MAX_BYTES - Buffer.byteLength(body)));
  assert.equal(f.read().state, "available");
  writeFileSync(f.indexPath, body + " ".repeat(RUN_CONTEXT_INDEX_METADATA_MAX_BYTES - Buffer.byteLength(body) + 1));
  unavailable(f.read(), "index_unavailable");
  for (const bad of ["{incomplete", "null", "[]"]) {
    writeFileSync(f.indexPath, bad);
    unavailable(f.read(), "index_invalid");
    assert.equal(readFileSync(f.indexPath, "utf8"), bad);
  }
  writeFileSync(f.indexPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  unavailable(f.read(), "index_invalid");
  rmSync(f.indexPath);
  unavailable(f.read(), "index_unavailable");
  assert.equal(existsSync(f.indexPath), false);
});

test("Index schema, role completeness, paths, formats, sizes and coverage reject coercion or unknown claims", (t) => {
  const f = fixture(t);
  const good = copy(f.index);
  const mutations: ((value: typeof good) => void)[] = [
    value => { value.schema = "foreign-v1"; }, value => { value.run_instance_id = "generation-b"; },
    value => { value.updated_at = "yesterday"; }, value => { delete value.entries.trace; },
    value => { value.entries.private = { availability: "pending", path: null }; },
    value => { value.entries.trace = { availability: "pending", path: "evidence/trace.jsonl" }; },
    value => { value.entries.trace = { availability: "unavailable", path: null }; },
    value => { value.entries.trace = { availability: "unavailable", path: null, reason: "private\npath" }; },
    value => { value.entries.trace = { availability: "unavailable", path: null, reason: "capture_unavailable\u2028" }; },
    value => { value.entries.trace.path = "../outside.jsonl"; },
    value => { value.entries.control.path = "controls.jsonl"; },
    value => { value.entries.trace.path = "evidence/recipe.json"; },
    value => { value.entries.trace.media_type = "application/json"; },
    value => { value.entries.trace.bytes_total = "1"; }, value => { value.entries.trace.bytes_total = -1; },
    value => { value.entries.trace.mutable = "true"; }, value => { value.entries.trace.native_scope_closed = true; },
    value => { value.entries.trace.coverage = { truncated: false, redacted: true }; },
    value => { value.entries.trace.coverage = { truncated: false, redacted: "true", history_complete: true }; },
  ];
  for (const mutate of mutations) {
    const candidate = copy(good);
    mutate(candidate);
    writeJson(f.indexPath, candidate);
    unavailable(f.read(), "index_invalid");
  }
  const candidate = copy(good);
  candidate.entries.recipe.coverage = { truncated: false, redacted: true };
  writeJson(f.indexPath, candidate);
  assert.equal(f.read().state, "available");
});

test("Available roles require readable regular exports with matching current sizes; mutable drift stays unavailable", (t) => {
  const f = fixture(t);
  const path = join(f.stateDir, "evidence", "trace.jsonl");
  const body = readFileSync(path);
  rmSync(path);
  unavailable(f.read(), "role_unavailable");
  mkdirSync(path);
  unavailable(f.read(), "role_unavailable");
  rmSync(path, { recursive: true });
  writeFileSync(path, Buffer.concat([body, Buffer.from("new live bytes\n")]));
  unavailable(f.read(), "role_unavailable");
  f.entries.trace.bytes_total = fs.statSync(path).size;
  f.publish();
  assert.equal(f.read().state, "available");
  const open = fs.openSync;
  fs.openSync = ((target, ...args) => {
    if (String(target) === path) throw Object.assign(new Error("private path detail"), { code: "EACCES" });
    return Reflect.apply(open, fs, [target, ...args]);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { unavailable(f.read(), "role_unavailable"); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
});

test("Symlinked state, identity/index files, export directories and role files never become readable references", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const cases = [f.indexPath, f.metaPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE),
    join(f.stateDir, "evidence", "trace.jsonl"), join(f.stateDir, "evidence")];
  for (const path of cases) {
    const saved = path + ".saved";
    renameSync(path, saved);
    symlinkSync(saved, path);
    unavailable(f.read());
    rmSync(path);
    renameSync(saved, path);
  }
  const alias = join(f.root, "alias");
  symlinkSync(f.stateDir, alias);
  unavailable(readRunContextIndex(alias, identity));
});

test("Observed metadata/index/ownership changes during role admission cannot substitute a newer view", (t) => {
  const f = fixture(t);
  const markerPath = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE);
  const marker = readFileSync(markerPath);
  const indexBytes = readFileSync(f.indexPath);
  for (const [target, change] of [
    [f.metaPath, () => writeJson(f.metaPath, { ...f.meta, run_instance_id: "generation-b" })],
    [f.indexPath, () => writeJson(f.indexPath, { ...f.index, updated_at: "2026-10-23T19:44:08.000Z" })],
    [markerPath, () => writeFileSync(markerPath, Buffer.concat([marker, Buffer.from(" \n")]))],
  ] as const) {
    const open = fs.openSync;
    let changed = false, mutationError: unknown;
    fs.openSync = ((path, ...args) => {
      const fd = Reflect.apply(open, fs, [path, ...args]);
      if (!changed && String(path).includes(join("evidence", ""))) {
        try {
          const before = fs.statSync(target, { bigint: true });
          change();
          // Same-size rewrites need a definitely observable stamp, not an
          // assumption about the host filesystem's timestamp resolution.
          fs.utimesSync(target, before.atime, new Date(Number(before.mtimeMs) + 1000));
          assert.notEqual(fs.statSync(target, { bigint: true }).mtimeNs, before.mtimeNs);
          changed = true;
        } catch (error) { mutationError = error; fs.closeSync(fd); throw error; }
      }
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    let reading: ReturnType<typeof f.read>;
    try { reading = f.read(); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.ifError(mutationError); assert.equal(changed, true, target);
    unavailable(reading, "observation_changed");
    writeJson(f.metaPath, f.meta);
    writeFileSync(f.indexPath, indexBytes);
    writeFileSync(markerPath, marker);
  }
});

test("A role path swapped after lstat cannot be accepted as the original readable export", (t) => {
  const f = fixture(t);
  const path = join(f.stateDir, "evidence", "trace.jsonl");
  const body = readFileSync(path);
  const open = fs.openSync;
  let swapped = false;
  fs.openSync = ((target, ...args) => {
    if (!swapped && String(target) === path) { swapped = true; renameSync(path, path + ".old"); writeFileSync(path, body); }
    return Reflect.apply(open, fs, [target, ...args]);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { unavailable(f.read(), "role_unavailable"); assert.equal(swapped, true); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
});
