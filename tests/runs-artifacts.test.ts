import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveArtifactManifest } from "../lib/runs-artifacts.ts";

const { describeRunArtifactReferences, observeRunArtifactReference } = await import("../lib/runs-artifacts.ts");

test("Artifact reference descriptions bind relative paths to captured cwd and reject malformed declarations", () => {
  const base = join(tmpdir(), "captured-artifact-base");
  const described = describeRunArtifactReferences({ report: { path: "report.bin", required: true, media_type: "application/octet-stream" } }, base);
  assert.equal(described.state, "available");
  if (described.state !== "available") return;
  assert.deepEqual(described.references, [{ name: "report", path: join(base, "report.bin"), required: true, media_type: "application/octet-stream" }]);
  assert.equal(Object.isFrozen(described.references[0]), true);
  assert.deepEqual(describeRunArtifactReferences(undefined, undefined), { state: "available", references: [] });
  for (const input of [null, [], { bad: { path: "x", sha256: "actor-supplied-hash" } }, { bad: { path: "x", required: "true" } }, { bad: { path: "x\nsecret" } }]) {
    assert.equal(describeRunArtifactReferences(input, base).state, "unavailable");
  }
  assert.equal(describeRunArtifactReferences({ report: "relative.bin" }, undefined).state, "unavailable");
});

test("Artifact metadata observation opens readable regular files without reading/hashing their bodies or limiting content size", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-metadata-"));
  const file = join(root, "large.bin");
  try {
    await writeFile(file, ""); fs.truncateSync(file, 512 * 1024 * 1024);
    const described = describeRunArtifactReferences({ large: file }, root);
    assert.equal(described.state, "available");
    if (described.state !== "available") return;
    const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync };
    const fds = new Set<number>(); let bodyReads = 0;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(originals.openSync, fs, [path, ...args]); if (String(path) === file) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) { bodyReads++; throw new Error("Artifact body read forbidden"); } return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.readFileSync = ((path, ...args) => { if (String(path) === file) { bodyReads++; throw new Error("Artifact body read forbidden"); } return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const observed = observeRunArtifactReference(described.references[0]);
      assert.equal(observed.availability, "available");
      assert.equal(observed.bytes_total, 512 * 1024 * 1024);
      assert.equal(Object.hasOwn(observed, "sha256"), false);
      assert.equal(bodyReads, 0);
      assert.equal(fds.size, 0);
    } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Artifact metadata distinguishes missing, denied, nonregular, symlinked and observed-changing references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-observation-"));
  try {
    const reference = { name: "report", path: join(root, "report.bin") };
    assert.equal(observeRunArtifactReference(reference).availability, "missing");
    fs.mkdirSync(reference.path);
    assert.equal(observeRunArtifactReference(reference).availability, "unavailable");
    fs.rmdirSync(reference.path); await writeFile(reference.path, "original");
    const open = fs.openSync;
    fs.openSync = ((path, ...args) => { if (String(path) === reference.path) throw Object.assign(new Error("private denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.equal(observeRunArtifactReference(reference).availability, "unavailable"); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (!changed && String(path) === reference.path) { changed = true; fs.writeFileSync(reference.path, "changed bytes"); } return fd; }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.equal(observeRunArtifactReference(reference).reason, "artifact_changed"); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    if (process.platform !== "win32") {
      fs.unlinkSync(reference.path); fs.symlinkSync(join(root, "outside"), reference.path);
      assert.equal(observeRunArtifactReference(reference).availability, "unavailable");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Artifact reference observation preserves symlink/parent path semantics instead of lexical retargeting", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-reference-semantics-"));
  try {
    const cwd = join(root, "work"); fs.mkdirSync(cwd);
    const actual = join(root, "actual"); fs.mkdirSync(join(actual, "inner"), { recursive: true });
    fs.symlinkSync(join(actual, "inner"), join(cwd, "link"));
    await writeFile(join(actual, "artifact.txt"), "intended");
    await writeFile(join(cwd, "artifact.txt"), "wrong");
    const described = describeRunArtifactReferences({ output: "link/../artifact.txt" }, cwd);
    assert.equal(described.state, "available");
    if (described.state !== "available") return;
    assert.equal(observeRunArtifactReference(described.references[0]).bytes_total, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact manifests hash adversarial-size files with bounded chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-manifest-"));
  const file = join(root, "large.bin");
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const chunks = 128;
    await writeFile(file, Buffer.concat(Array.from({ length: chunks }, () => chunk)));
    const expected = createHash("sha256");
    for (let index = 0; index < chunks; index += 1) expected.update(chunk);
    const manifest = resolveArtifactManifest({
      report: { path: file, required: true },
    });
    assert.deepEqual(manifest?.report, {
      exists: true,
      path: file,
      required: true,
      sha256: expected.digest("hex"),
      size: chunk.byteLength * chunks,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
