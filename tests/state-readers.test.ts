/**
 * Resilient state reader regression tests
 * Covers JSON/JSONL degradation behavior for file-backed actor state.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatStateReadDiagnostics,
  readJsonFileResilient,
  readJsonlFileResilient,
} from "../lib/state-readers.ts";

test("resilient JSON reader returns fallback and diagnostics for corrupt files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-json-"));
  try {
    const file = join(root, "state.json");
    await writeFile(file, "{bad json\n");
    const result = readJsonFileResilient(file, { ok: false });
    assert.deepEqual(result.value, { ok: false });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].path, file);
    assert.match(formatStateReadDiagnostics(result.diagnostics)[0], /state\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict JSON UTF-8 admission is opt-in and distinguishes malformed bytes from a valid replacement character", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-json-utf8-"));
  try {
    const file = join(root, "state.json");
    for (const maxBytes of [undefined, 100]) {
      await writeFile(file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
      assert.deepEqual(readJsonFileResilient(file, null, { maxBytes }).value, { x: "�" });
      const strict = readJsonFileResilient(file, null, { maxBytes, strictUtf8: true });
      assert.equal(strict.value, null); assert.equal(strict.diagnostics.length, 1);
      await writeFile(file, JSON.stringify({ x: "界�" }));
      assert.deepEqual(readJsonFileResilient(file, null, { maxBytes, strictUtf8: true }).value, { x: "界�" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Strict bounded JSON refuses premature EOF after valid JSON prefix while legacy best-effort degradation remains unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-json-short-")); const file = join(root, "state.json"); const prefix = '{"ok":true}';
  await writeFile(file, prefix + "INVALID_TRAILER"); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const fds = new Set<number>();
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === file) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, buffer, offset, length, position) => {
    if (!fds.has(fd)) return Reflect.apply(read, fs, [fd, buffer, offset, length, position]);
    const remaining = Buffer.byteLength(prefix) - Number(position); return remaining <= 0 ? 0 : Reflect.apply(read, fs, [fd, buffer, offset, Math.min(length, remaining), position]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try {
    assert.deepEqual(readJsonFileResilient(file, null, { maxBytes: 1000 }).value, { ok: true });
    const strict = readJsonFileResilient(file, null, { maxBytes: 1000, strictUtf8: true }); assert.equal(strict.value, null); assert.equal(strict.diagnostics.length, 1);
  } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
  assert.equal(fds.size, 0);
});

test("Strict bounded JSON opens nonblocking/nofollow and refuses nonregular descriptors without reading them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-json-open-")); const file = join(root, "state.json"); await writeFile(file, '{"ok":true}');
  const open = fs.openSync; const stat = fs.fstatSync; const read = fs.readSync; const close = fs.closeSync; const fds = new Set<number>();
  let flags: unknown; let nonregular = false; let reads = 0;
  fs.openSync = ((path, mode, ...args) => { const fd = Reflect.apply(open, fs, [path, mode, ...args]); if (String(path) === file) { fds.add(fd); flags = mode; } return fd; }) as typeof fs.openSync;
  fs.fstatSync = ((fd, ...args) => { const value = Reflect.apply(stat, fs, [fd, ...args]); return fds.has(fd) && nonregular ? Object.assign(value, { isFile: () => false }) : value; }) as typeof fs.fstatSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) reads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try {
    assert.deepEqual(readJsonFileResilient(file, null, { maxBytes: 100, strictUtf8: true }).value, { ok: true });
    assert.equal(typeof flags, "number");
    for (const flag of [fs.constants.O_NONBLOCK, fs.constants.O_NOFOLLOW]) if (flag) assert.equal(Number(flags) & flag, flag);
    nonregular = true; const prior = reads;
    assert.equal(readJsonFileResilient(file, null, { maxBytes: 100, strictUtf8: true }).value, null); assert.equal(reads, prior);
    assert.deepEqual(readJsonFileResilient(file, null, { maxBytes: 100 }).value, { ok: true }); assert.equal(flags, "r");
  } finally { fs.openSync = open; fs.fstatSync = stat; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); await rm(root, { recursive:true, force:true }); }
  assert.equal(fds.size, 0);
});

test("resilient JSONL reader preserves valid records and reports bad lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-jsonl-"));
  try {
    const file = join(root, "events.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ event: "one" })}\n{bad json\n${JSON.stringify({ event: "two" })}\n`,
    );
    const result = readJsonlFileResilient<Record<string, unknown>>(file);
    assert.deepEqual(result.records, [{ event: "one" }, { event: "two" }]);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].line, 2);
    assert.match(formatStateReadDiagnostics(result.diagnostics)[0], /events\.jsonl:2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
