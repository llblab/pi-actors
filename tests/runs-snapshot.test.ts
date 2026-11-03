/**
 * Bounded Run snapshot projection and private canonical-fact admission.
 * Covers identity/timing/lifecycle/reference boundaries and readonly metadata observations.
 */

import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { RUN_DELIVERY_MODEL_MAX_BYTES } from "../lib/limits.ts";
import { projectRunSnapshot } from "../lib/runs-snapshot.ts";
import { renderRunSnapshot } from "../lib/tools-response.ts";
import { claimRunStateDirectory } from "../lib/runs-ownership.ts";
import { RUN_OUTCOME_PROTOCOL, RUN_STOP_CLAIM_FILE } from "../lib/runs-outcomes.ts";
import { readProcessIdentity, runProcessIdentityDigest } from "../lib/runs-process.ts";
import { captureRunSupervisionTimeOrigin, createRunSupervisionClock } from "../lib/run-supervision.ts";
import { createRunSupervisionOwner } from "../lib/runs-supervision.ts";
import { readRunSnapshotFacts } from "../lib/runs-status.ts";
import { RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "../lib/runs-context-index.ts";
import { createRunSnapshotReferenceReader } from "../lib/runs-context-exports.ts";
import { admitRunResultProducer } from "../lib/runs-results.ts";

const identity = { run: "review", run_instance_id: "generation-a", ownerId: "owner-a" };
const capturedAt = "2026-10-22T19:44:08.000Z";

function facts(overrides: Record<string, unknown> = {}) {
  return {
    identity: { ...identity },
    captured_at: capturedAt,
    timing: { basis: "live", elapsed_ms: 250_000 },
    lifecycle: { status: "running" },
    cwd: "~/work/project",
    context_index: {
      identity: { ...identity },
      path: "~/.pi/agent/tmp/pi-actors/runs/review/context-index.json",
    },
    ...overrides,
  };
}

function snapshot(value = facts(), expected: unknown = identity) {
  const reading = projectRunSnapshot(expected, value);
  assert.equal(reading.state, "available");
  if (reading.state !== "available") throw new Error("Expected available snapshot");
  return reading.snapshot;
}

function unavailable(value: unknown, reason: string, expected: unknown = identity) {
  assert.deepEqual(projectRunSnapshot(expected, value), { state: "unavailable", reason });
}

test("Snapshot projects only bounded admitted fields without copying opaque bodies or mutating facts", () => {
  const value = facts({ result: { output: "x".repeat(100_000), secret: "not-public" }, pid: 123, stopped: true });
  const before = JSON.stringify(value);
  const projected = snapshot(value);
  assert.deepEqual(projected, {
    kind: "run_snapshot", run: "review", run_instance_id: "generation-a", captured_at: capturedAt,
    elapsed_ms: 250_000, status: "running", cwd: "~/work/project",
    evidence: "~/.pi/agent/tmp/pi-actors/runs/review/context-index.json",
  });
  assert.equal(JSON.stringify(value), before);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projectRunSnapshot(identity, value)), true);
  value.cwd = "~/changed";
  (value.identity as typeof identity).run_instance_id = "generation-b";
  assert.equal(projected.cwd, "~/work/project");
  assert.equal(projected.run_instance_id, "generation-a");
});

test("Projection never inspects unrelated role bodies, provenance or input serialization", () => {
  const value = facts();
  for (const key of ["result", "trace", "progress", "private_provenance", "toJSON"]) {
    Object.defineProperty(value, key, { enumerable: true, get() { throw new Error("Do not read " + key); } });
  }
  assert.equal(snapshot(value).status, "running");
});

test("Snapshot identity requires own exact run, generation and optional owner", () => {
  for (const delta of [{ run: "other" }, { run_instance_id: "generation-b" }, { ownerId: "owner-b" }]) {
    unavailable(facts({ identity: { ...identity, ...delta } }), "identity_mismatch");
  }
  const { ownerId: _owner, ...ownerless } = identity;
  unavailable(facts({ identity: ownerless }), "identity_mismatch");
  unavailable(facts(), "identity_mismatch", ownerless);
  assert.equal(snapshot(facts({ identity: ownerless, context_index: { identity: ownerless, path: "~/index.json" } }), ownerless).evidence, "~/index.json");
  for (const invalid of [null, [], {}, { ...identity, run: "" }, { ...identity, run: "run:review" },
    { ...identity, run: "review\n" }, { ...identity, run_instance_id: "" }, { ...identity, ownerId: "" },
    { ...identity, ownerId: undefined }, Object.create(identity)]) {
    unavailable(facts({ identity: invalid }), "identity_unavailable");
    unavailable(facts(), "identity_unavailable", invalid);
  }
  unavailable(Object.create(facts()), "identity_unavailable");
});

test("Opaque generation attribution is preserved rather than normalized or reconstructed", () => {
  const opaque = { ...identity, run_instance_id: "generation:β/opaque" };
  const projected = snapshot(facts({ identity: opaque, context_index: { identity: opaque, path: "~/evidence/index.json" } }), opaque);
  assert.equal(projected.run_instance_id, opaque.run_instance_id);
});

test("Admitted natural and active facts project without inferring forced scope closure", () => {
  for (const status of ["done", "failed"]) {
    const value = facts({ lifecycle: { status }, timing: { basis: "terminal", elapsed_ms: 1234 } });
    const first = snapshot(value);
    const later = snapshot({ ...value, captured_at: "2026-10-23T19:44:08.000Z" });
    assert.equal(first.status, status);
    assert.equal(later.elapsed_ms, first.elapsed_ms);
    assert.equal(Object.hasOwn(first, "phase"), false);
    assert.equal(Object.hasOwn(first, "stopped"), false);
  }
  assert.equal(snapshot(facts({ lifecycle: { status: "running", phase: "stopping" } })).phase, "stopping");
  for (const lifecycle of [undefined, null, {}, { status: "unproven" }, { status: "exited" }, { status: "killed" },
    { status: "timed_out" }, { status: "cancelled" }, { status: "running", phase: "healthy" },
    { status: "done", phase: "stopping" }, Object.create({ status: "running" })]) {
    unavailable(facts({ lifecycle }), "lifecycle_unproven");
  }
});

test("Unproven or mismatched timing never becomes invented age or a running terminal clock", () => {
  for (const timing of [undefined, null, {}, { basis: "unproven" }, { basis: "terminal", elapsed_ms: 0 },
    Object.create({ basis: "live", elapsed_ms: 0 })]) {
    unavailable(facts({ timing }), "timing_unproven");
  }
  for (const elapsed_ms of [undefined, null, "1", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    unavailable(facts({ timing: { basis: "live", elapsed_ms } }), "timing_unproven");
  }
  unavailable(facts({ lifecycle: { status: "done" } }), "timing_unproven");
  assert.equal(snapshot(facts({ timing: { basis: "live", elapsed_ms: 0 } })).elapsed_ms, 0);
  assert.equal(snapshot(facts({ timing: { basis: "live", elapsed_ms: Number.MAX_SAFE_INTEGER } })).elapsed_ms, Number.MAX_SAFE_INTEGER);
});

test("Captured time is explicit canonical observation data, not a clock read or coercion", () => {
  for (const captured_at of [undefined, null, 0, "yesterday", "2026-10-22", "2026-10-22T19:44:08Z", "2026-10-22T19:44:08.000Z\n", " ".repeat(RUN_DELIVERY_MODEL_MAX_BYTES + 1)]) {
    unavailable(facts({ captured_at }), "observation_unavailable");
  }
  assert.equal(snapshot().captured_at, capturedAt);
});

test("Unavailable, malformed or foreign index facts never advertise an invented source", () => {
  for (const context_index of [undefined, null, {}, { path: "~/index.json" }, { identity, path: "" },
    { identity, path: "~/index\n.json" }, { identity, path: "x".repeat(RUN_DELIVERY_MODEL_MAX_BYTES + 1) },
    { identity: { ...identity, run: "other" }, path: "~/foreign.json" },
    { identity: { ...identity, run_instance_id: "generation-b" }, path: "~/newer.json" },
    { identity: { ...identity, ownerId: "owner-b" }, path: "~/private.json" },
    Object.create({ identity, path: "~/inherited.json" })]) {
    const projected = snapshot(facts({ context_index }));
    assert.equal(projected.evidence, null);
    assert.equal(projected.evidence_error, "index_unavailable");
  }
});

test("Curated exact references are preserved without truncation, expansion or path discovery", () => {
  const cwd = "/authorized/work with spaces/β";
  const path = "/authorized/evidence with spaces/β/context-index.json";
  const projected = snapshot(facts({ cwd, context_index: { identity, path } }));
  assert.equal(projected.cwd, cwd);
  assert.equal(projected.evidence, path);
  assert.equal(Object.hasOwn(projected, "evidence_error"), false);
  for (const invalid of [undefined, null, "", 42, "~/work\u0000/private", "~/work\n/private"]) {
    unavailable(facts({ cwd: invalid }), "references_unavailable");
  }
});

test("Snapshot bounds use encoded JSON bytes, retain exact sources and never clip metadata", () => {
  const base = snapshot(facts({ cwd: "~/" }));
  const room = RUN_DELIVERY_MODEL_MAX_BYTES - Buffer.byteLength(JSON.stringify(base), "utf8");
  const exact = snapshot(facts({ cwd: "~/" + "x".repeat(room) }));
  assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), RUN_DELIVERY_MODEL_MAX_BYTES);
  unavailable(facts({ cwd: exact.cwd + "x" }), "snapshot_too_large");
  unavailable(facts({ cwd: "~/" + "界".repeat(Math.floor(room / 3) + 1) }), "snapshot_too_large");
  unavailable(facts({ cwd: "~/" + "\"".repeat(Math.floor(room / 2) + 1) }), "snapshot_too_large");
  unavailable(facts({ cwd: "x".repeat(RUN_DELIVERY_MODEL_MAX_BYTES + 1) }), "snapshot_too_large");
});

function referenceFixture(t: TestContext, configure: (f: ReturnType<typeof canonicalFixture>) => Record<string, unknown> = () => ({}), stateName = "state") {
  const f = canonicalFixture(t, stateName); rmSync(f.resultPath);
  const meta = { ...f.meta, ...configure(f) }; writeFileSync(f.metadataPath, JSON.stringify(meta));
  const producer = admitRunResultProducer(f.stateDir).producer;
  return { ...f, meta, producer, reader: createRunSnapshotReferenceReader(f.stateDir, producer) };
}
function references(f: ReturnType<typeof referenceFixture>) {
  const reading = f.reader.read(); if (reading.state !== "available") assert.fail(reading.reason);
  assert.equal(reading.unchanged(), true); return reading;
}

test("Snapshot reference permission fixes literal operational cwd and privacy to genuine admission, never live actor flags", t => {
  const f = referenceFixture(t, f => ({ cwd: f.root + "/launch link/../β`\uFEFF", values: { skill_dir: "/private/not-disclosed-skill", recipe_dir: "/private/not-disclosed-recipe", api_key: "ADMISSION_LITERAL" }, visibility: "private" }));
  const first = references(f); assert.equal(first.references.cwd, f.meta.cwd);
  assert.equal(first.references.context_index?.path, f.indexPath); assert.deepEqual(first.references.context_index?.identity, identity);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.identity) && Object.isFrozen(first.references) && Object.isFrozen(first.references.context_index) && Object.isFrozen(first.references.context_index?.identity));
  writeFileSync(f.metadataPath, JSON.stringify({ ...f.meta, cwd: "/actor/changed", visibility: "public", values: { api_key: f.root }, output: "actor-source-body" }));
  assert.equal(first.unchanged(), false);
  const later = references(f); assert.deepEqual(later.references, first.references);
  const recaptured = createRunSnapshotReferenceReader(f.stateDir, f.producer).read(); assert.equal(recaptured.state, "available");
  if (recaptured.state === "available") assert.deepEqual(recaptured.references, first.references);
  const serialized = JSON.stringify(later); for (const secret of ["ADMISSION_LITERAL", "actor-source-body", "skill_dir", "visibility", "actor/changed"]) assert.equal(serialized.includes(secret), false);
  assert.throws(() => createRunSnapshotReferenceReader(f.stateDir, { ...f.producer }), /identity admitted by this runtime/);
});

test("Snapshot paths changed by full secret masking are withheld before bounds, never fabricated usable references", t => {
  for (const cwd of ["/not-opened/token=INLINE_SECRET", "/not-opened/unlabelled.+[literal]", "/not-opened/" + "秘密".repeat(9000)]) {
    const f = referenceFixture(t, () => ({ cwd, values: { api_key: cwd.includes("token=") ? "irrelevant" : cwd.slice("/not-opened/".length) } }));
    const reading = references(f); assert.equal(reading.references.cwd, null); assert.equal(reading.references.cwd_unavailable, "cwd_reference_redacted");
    assert.equal(reading.references.context_index?.path, f.indexPath); assert.equal(JSON.stringify(reading).includes("[REDACTED]"), false);
    assert.equal(JSON.stringify(reading).includes(cwd), false);
  }
  for (const configure of [
    (f: ReturnType<typeof canonicalFixture>) => ({ cwd: f.root + "/private-install/work", values: { skill_dir: f.root + "/private-install" } }),
    (f: ReturnType<typeof canonicalFixture>) => ({ cwd: f.root + "/private-source", recipe_file: f.root + "/private-source" }),
    (f: ReturnType<typeof canonicalFixture>) => ({ cwd: f.root + "/private-context", template: { actorRecipeContext: { file: f.root + "/private-context" } } }),
  ]) {
    const f = referenceFixture(t, configure); const reading = references(f);
    assert.equal(reading.references.cwd, null); assert.equal(reading.references.cwd_unavailable, "cwd_reference_redacted");
    assert.equal(JSON.stringify(reading).includes("[PRIVATE_RECIPE_ORIGIN]"), false); assert.equal(reading.references.context_index?.path, f.indexPath);
  }
  const f = referenceFixture(t, f => ({ cwd: "/not-opened/public-work", values: { api_key: f.stateDir, recipe_dir: f.stateDir } }));
  const lstat = fs.lstatSync; let indexProbes = 0;
  try {
    fs.lstatSync = ((path, ...args) => { if (String(path) === f.indexPath) { indexProbes++; throw new Error("Withheld index must not be probed"); } return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    const reading = references(f); assert.equal(reading.references.cwd, "/not-opened/public-work");
    assert.equal(reading.references.context_index, null); assert.equal(reading.references.context_index_unavailable, "index_reference_redacted");
    assert.equal(JSON.stringify(reading).includes(f.stateDir), false); assert.equal(indexProbes, 0);
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
});

test("Original snapshot cwd/index references reject display-mask literal collisions without probing withheld paths or renewing live policy", t => {
  for (const originallyPrivate of [true, false]) for (const indexPrivate of [false, true]) {
    const cwd = "/not-opened/[REDACTED]/β\"\\\uFEFF\uFFFD🫧";
    const f = referenceFixture(t, () => ({ cwd, values: originallyPrivate ? { api_key: "[REDACTED]" } : {} }), indexPrivate ? "state-[REDACTED]" : "state");
    writeFileSync(f.metadataPath, JSON.stringify({ ...f.meta, cwd: "/actor/current", values: originallyPrivate ? {} : { api_key: "[REDACTED]" } }));
    const lstat = fs.lstatSync, open = fs.openSync, read = fs.readFileSync; let forbiddenProbes = 0;
    const check = (path: unknown) => { if (String(path) === cwd || (originallyPrivate && indexPrivate && String(path) === f.indexPath)) { forbiddenProbes++; assert.fail("Withheld reference must not be probed"); } };
    fs.lstatSync = ((path, ...args) => { check(path); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
    fs.openSync = ((path, ...args) => { check(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
    fs.readFileSync = ((path, ...args) => { check(path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync; syncBuiltinESMExports();
    try {
      for (const reader of [f.reader, createRunSnapshotReferenceReader(f.stateDir, f.producer)]) {
        const reading = reader.read(); assert.equal(reading.state, "available"); if (reading.state !== "available") continue;
        assert.equal(reading.references.cwd, originallyPrivate ? null : cwd);
        assert.equal(reading.references.cwd_unavailable, originallyPrivate ? "cwd_reference_redacted" : undefined);
        assert.equal(reading.references.context_index?.path, originallyPrivate && indexPrivate ? undefined : f.indexPath);
        assert.equal(reading.references.context_index_unavailable, originallyPrivate && indexPrivate ? "index_reference_redacted" : undefined);
        assert.equal(reading.unchanged(), true);
      }
    } finally { fs.lstatSync = lstat; fs.openSync = open; fs.readFileSync = read; syncBuiltinESMExports(); }
    assert.equal(forbiddenProbes, 0);
  }
});

test("Snapshot reference admission rejects invalid scalar paths and encoded overflow without path clipping or workload quota", t => {
  for (const cwd of ["relative", "/line\nprivate", "/bad\ud800/path"]) {
    const f = referenceFixture(t, () => ({ cwd })); const reading = references(f);
    assert.equal(reading.references.cwd, null); assert.equal(reading.references.cwd_unavailable, "cwd_reference_invalid");
  }
  const large = referenceFixture(t, () => ({ cwd: "/" + "\"".repeat(RUN_DELIVERY_MODEL_MAX_BYTES / 2) }));
  assert.deepEqual(large.reader.read(), { state: "unavailable", reason: "references_too_large" });
  const privateBudget = referenceFixture(t, () => ({ values: { pad: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) } }));
  assert.deepEqual(privateBudget.reader.read(), { state: "unavailable", reason: "privacy_capture_unavailable" });
  assert.equal(fs.existsSync(privateBudget.metadataPath), true); assert.equal(fs.existsSync(privateBudget.resultPath), false);
});

test("Snapshot reference fences cover exact admission frame, generation, owner/index observations and explicit index loss", t => {
  const f = referenceFixture(t); const original = references(f);
  rmSync(f.indexPath); assert.equal(original.unchanged(), false);
  const missing = references(f); assert.equal(missing.references.context_index, null); assert.equal(missing.references.context_index_unavailable, "index_unavailable");
  writeFileSync(f.indexPath, JSON.stringify(f.index)); assert.equal(missing.unchanged(), false); assert.equal(references(f).references.context_index?.path, f.indexPath);
  writeFileSync(f.metadataPath, JSON.stringify({ ...f.meta, run_instance_id: "foreign" }));
  assert.deepEqual(f.reader.read(), { state: "unavailable", reason: "identity_mismatch" });
  writeFileSync(f.metadataPath, JSON.stringify(f.meta));
  const clone = claimRunStateDirectory(join(f.root, "other-state"), identity.run);
  writeFileSync(join(clone, "run.json"), JSON.stringify({ ...f.meta, state_dir: clone }));
  assert.throws(() => createRunSnapshotReferenceReader(clone, f.producer), /snapshot reference capture binding changed/);
  const held = join(f.root, "held-original-state"); fs.renameSync(f.stateDir, held); fs.cpSync(held, f.stateDir, { recursive: true });
  assert.deepEqual(f.reader.read(), { state: "unavailable", reason: "observation_changed" });
  assert.throws(() => createRunSnapshotReferenceReader(held, f.producer), /ownership marker does not match|state identity changed|capture binding changed/);
});

test("Snapshot reference read refuses changed canonical joins and distinguishes unavailable observations", t => {
  const f = referenceFixture(t); const open = fs.openSync, lstat = fs.lstatSync; let changed = false;
  try {
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]);
      if (String(path) === f.indexPath && !changed) { changed = true; writeFileSync(f.metadataPath, JSON.stringify({ ...f.meta, ownerId: "foreign" })); }
      return fd;
    }) as typeof fs.openSync; syncBuiltinESMExports();
    assert.deepEqual(f.reader.read(), { state: "unavailable", reason: "observation_changed" }); assert.equal(changed, true);
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
  writeFileSync(f.metadataPath, JSON.stringify(f.meta));
  try {
    fs.lstatSync = ((path, ...args) => { if (String(path) === f.indexPath) throw Object.assign(new Error("exact fixture index EIO"), { code: "EIO" }); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
    syncBuiltinESMExports(); assert.deepEqual(f.reader.read(), { state: "unavailable", reason: "observation_unavailable" });
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
});

test("Snapshot reference reads are metadata-only and sample no process/clock, take no lifecycle lock and follow no bodies/targets", t => {
  const f = referenceFixture(t); writeFileSync(f.resultPath, "DO_NOT_READ_CANONICAL_BODY");
  const allowed = new Set([f.metadataPath, f.indexPath, join(f.stateDir, ".pi-actors-run-state.json")]);
  const open = fs.openSync, readFile = fs.readFileSync, read = fs.readSync, lstat = fs.lstatSync, kill = process.kill, now = Date.now;
  const before = fs.readdirSync(f.stateDir); let fileReads = 0; const descriptors = new Set<number>();
  try {
    fs.openSync = ((path, flags, ...args) => {
      assert.ok(allowed.has(String(path)), `Unexpected open: ${String(path)}`);
      assert.equal(Number(flags) & (fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
      const fd = Reflect.apply(open, fs, [path, flags, ...args]); descriptors.add(fd); return fd;
    }) as typeof fs.openSync;
    fs.readFileSync = ((path, ...args) => { if (typeof path !== "number") assert.ok(allowed.has(String(path)), `Unexpected read: ${String(path)}`); fileReads++; return Reflect.apply(readFile, fs, [path, ...args]); }) as typeof fs.readFileSync;
    fs.readSync = ((fd, ...args) => { assert.ok(descriptors.has(fd), "Only selected metadata descriptors may be read"); fileReads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.lstatSync = ((path, ...args) => { assert.notEqual(String(path), f.meta.cwd); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
    process.kill = (() => { throw new Error("No process probe/signal"); }) as typeof process.kill; Date.now = () => { throw new Error("No clock sample"); }; syncBuiltinESMExports();
    const reading = references(f); assert.equal(reading.references.cwd, f.meta.cwd); assert.equal(reading.references.context_index?.path, f.indexPath);
  } finally { fs.openSync = open; fs.readFileSync = readFile; fs.readSync = read; fs.lstatSync = lstat; process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.ok(fileReads > 0); assert.deepEqual(fs.readdirSync(f.stateDir), before); assert.equal(readFileSync(f.resultPath, "utf8"), "DO_NOT_READ_CANONICAL_BODY");
});

function rendered(value: unknown = snapshot(), format: "text" | "json" = "text"): string {
  const reading = renderRunSnapshot(value, format); if (reading.state !== "available") assert.fail(reading.reason);
  assert.equal(Object.isFrozen(reading), true); return reading.text;
}

test("Snapshot renderer is one pure status-first layout with exact generation, elapsed, cwd and evidence in text/JSON", () => {
  const value = snapshot(); const text = rendered(value);
  assert.equal(text, `run:review · running · elapsed=250000ms\ngeneration:\n\`\`\`text\ngeneration-a\n\`\`\`\ncaptured_at: ${capturedAt}\ncwd:\n\`\`\`text\n~/work/project\n\`\`\`\nevidence:\n\`\`\`text\n~/.pi/agent/tmp/pi-actors/runs/review/context-index.json\n\`\`\``);
  assert.deepEqual(JSON.parse(rendered(value, "json")), value); assert.equal(rendered(value, "json"), JSON.stringify(value));
  for (const status of ["done", "failed"] as const) {
    // Data-only formatting fixtures, NOT proof of frozen terminal duration or public terminal snapshot support.
    const terminal = snapshot(facts({ lifecycle: { status }, timing: { basis: "terminal", elapsed_ms: 0 } }));
    assert.ok(rendered(terminal).startsWith(`run:review · ${status} · elapsed=0ms`)); assert.deepEqual(JSON.parse(rendered(terminal, "json")), terminal);
  }
  const stopping = snapshot(facts({ lifecycle: { status: "running", phase: "stopping" } }));
  assert.ok(rendered(stopping).startsWith("run:review · running (stopping) · elapsed=250000ms"));
  assert.doesNotMatch(text, /inspect|complete|healthy|scope_closure|result|next=/);
});

test("Snapshot literal fields preserve full whitespace, CRLF, BOM, U+FFFD, Unicode and backticks without Markdown injection", () => {
  const generation = "  \uFEFFopaque\r\n```text\nfake-label: PRIVATE_MARKUP\n```\r\n终\uFFFD  ";
  const cwd = "/work/ a````` β\uFEFF\uFFFD  "; const evidence = "~/路径/[name] & #`";
  const value = snapshot(facts({ identity: { ...identity, run_instance_id: generation }, cwd,
    context_index: { identity: { ...identity, run_instance_id: generation }, path: evidence } }), { ...identity, run_instance_id: generation });
  const text = rendered(value);
  assert.ok(text.includes(`generation:\n\`\`\`\`text\n${generation}\n\`\`\`\``));
  assert.ok(text.includes(`cwd:\n\`\`\`\`\`\`text\n${cwd}\n\`\`\`\`\`\``));
  assert.ok(text.endsWith(`evidence:\n\`\`\`text\n${evidence}\n\`\`\``));
  const decoded = JSON.parse(rendered(value, "json")); assert.equal(decoded.run_instance_id, generation); assert.equal(decoded.cwd, cwd); assert.equal(decoded.evidence, evidence);
  assert.equal(Object.hasOwn(decoded, "PRIVATE_MARKUP"), false);
});

test("Snapshot unavailable index stays explicit and renderer never repairs, authorizes or follows a source", () => {
  const missing = snapshot(facts({ context_index: undefined })); const text = rendered(missing);
  assert.ok(text.endsWith("evidence: unavailable (index_unavailable)")); assert.deepEqual(JSON.parse(rendered(missing, "json")), missing);
  for (const delta of [{ evidence: null, evidence_error: undefined }, { evidence: "/present", evidence_error: "index_unavailable" },
    { kind: "run" }, { status: "timed_out" }, { status: "done", phase: "stopping" }, { elapsed_ms: -1 }, { elapsed_ms: 0.5 },
    { cwd: "/bad\npath" }, { run_instance_id: "bad\ud800" }, { run_instance_id: "bad\u001b[31m" }, { captured_at: "2026-01-01" }]) {
    assert.deepEqual(renderRunSnapshot({ ...missing, ...delta }), { state: "unavailable", reason: "snapshot_invalid" });
  }
  assert.deepEqual(renderRunSnapshot(Object.create(missing)), { state: "unavailable", reason: "snapshot_invalid" });
  assert.deepEqual(renderRunSnapshot(missing, "other" as "text"), { state: "unavailable", reason: "format_invalid" });
});

test("Snapshot rendering reads only own allowlisted data, invokes no getters/serialization/clock/IO and leaves input untouched", () => {
  const value = { ...snapshot() }; let calls = 0;
  for (const field of ["result", "values", "visibility", "toJSON", "unchanged"]) Object.defineProperty(value, field, { enumerable: true, get() { calls++; throw Error("No unrelated read"); } });
  const descriptors = Object.getOwnPropertyDescriptors(value); const expected = snapshot();
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, readdirSync: fs.readdirSync }; const kill = process.kill, now = Date.now;
  const forbidden = () => assert.fail("Formatting attempted IO/process/clock observation");
  try {
    fs.openSync = forbidden as typeof fs.openSync; fs.readFileSync = forbidden as typeof fs.readFileSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync;
    fs.readdirSync = forbidden as typeof fs.readdirSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
    assert.equal(rendered(value), rendered(expected)); assert.deepEqual(JSON.parse(rendered(value, "json")), expected);
    const getter = Object.defineProperty({ ...expected }, "cwd", { get() { calls++; throw Error("No required getter"); } });
    assert.deepEqual(renderRunSnapshot(getter), { state: "unavailable", reason: "snapshot_invalid" });
  } finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(calls, 0); assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
});

test("Snapshot render limits count complete UTF-8 bytes and refuse whole JSON/fence-amplified output without clipping or fallback", () => {
  const base = snapshot(); const room = RUN_DELIVERY_MODEL_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  const exactSnapshot = { ...base, cwd: base.cwd + "x".repeat(room) };
  assert.equal(Buffer.byteLength(JSON.stringify(exactSnapshot)), RUN_DELIVERY_MODEL_MAX_BYTES);
  const exactJson = rendered(exactSnapshot, "json"); assert.equal(Buffer.byteLength(exactJson), RUN_DELIVERY_MODEL_MAX_BYTES); assert.deepEqual(JSON.parse(exactJson), exactSnapshot);
  for (const value of [{ ...exactSnapshot, cwd: exactSnapshot.cwd + "x" }, { ...base, cwd: "/" + "界".repeat(RUN_DELIVERY_MODEL_MAX_BYTES / 3) }]) {
    for (const format of ["text", "json"] as const) assert.deepEqual(renderRunSnapshot(value, format), { state: "unavailable", reason: "snapshot_too_large" });
  }
  const withTicks = (count: number, suffix = "") => ({ ...base, run_instance_id: "`".repeat(count), cwd: base.cwd + suffix });
  const three = rendered(withTicks(3)); const extra = RUN_DELIVERY_MODEL_MAX_BYTES - Buffer.byteLength(three);
  const ticks = 3 + Math.floor(extra / 3); const suffix = "z".repeat(extra % 3);
  const exactText = withTicks(ticks, suffix); const text = rendered(exactText);
  assert.equal(Buffer.byteLength(text), RUN_DELIVERY_MODEL_MAX_BYTES); assert.ok(Buffer.byteLength(JSON.stringify(exactText)) < RUN_DELIVERY_MODEL_MAX_BYTES);
  const amplified = { ...exactText, cwd: exactText.cwd + "z" };
  assert.deepEqual(renderRunSnapshot(amplified), { state: "unavailable", reason: "render_too_large" });
  assert.deepEqual(JSON.parse(rendered(amplified, "json")), amplified, "Explicit JSON selection remains recoverable, never an implicit fallback");
  assert.ok(text.includes("`".repeat(ticks))); assert.equal(text.includes("…"), false);
});

function canonicalFixture(t: TestContext, stateName = "state") {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-snapshot-facts-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, stateName), identity.run);
  const metadataPath = join(stateDir, "run.json"); const resultPath = join(stateDir, "result.json"); const indexPath = join(stateDir, "context-index.json");
  const meta = { ...identity, state_dir: stateDir, cwd: root + "/launch link/../β", pid: process.pid, outcome_protocol: RUN_OUTCOME_PROTOCOL as string,
    stopped: true, status: "timed_out", elapsed_ms: 12345, started_at: capturedAt, values: { secret: "private-metadata-value" } };
  const result = { run_instance_id: identity.run_instance_id, terminal_acceptance: "natural", completedAt: capturedAt,
    code: 0, output: "body-not-public", elapsed_ms: 99999, stopped: true };
  const index = { schema: "run-context-index-v1", run: identity.run, run_instance_id: identity.run_instance_id, updated_at: capturedAt,
    entries: Object.fromEntries(["recipe", "result", "trace", "control", "execution", "artifacts", "sessions", "stdout", "stderr"]
      .map(role => [role, { availability: "pending", path: null }])) as Record<string, Record<string, unknown>> };
  const publish = () => { writeFileSync(metadataPath, JSON.stringify(meta)); writeFileSync(resultPath, JSON.stringify(result)); writeFileSync(indexPath, JSON.stringify(index)); };
  publish();
  const read = (expected: unknown = identity, at: unknown = capturedAt) => readRunSnapshotFacts(stateDir, expected, at);
  return { root, stateDir, metadataPath, resultPath, indexPath, meta, result, index, publish, read };
}

// Canonical-data fixtures exercise readonly classification, not producer/native admission capabilities.
test("Canonical facts share natural classification, retain exact references and never fabricate terminal timing", t => {
  const f = canonicalFixture(t);
  for (const code of [0, 7]) {
    f.result.code = code; f.publish(); writeFileSync(join(f.stateDir, "stop-claim.json"), "malformed later stop");
    const observed = f.read(); assert.equal(observed.state, "available"); if (observed.state !== "available") return;
    assert.deepEqual(observed.facts, { identity, captured_at: capturedAt, lifecycle: { status: code === 0 ? "done" : "failed" },
      timing: { basis: "unproven" }, cwd: f.meta.cwd, context_index: { identity, path: f.indexPath } });
    for (const value of [observed, observed.facts, observed.facts.identity, observed.facts.lifecycle, observed.facts.timing, observed.facts.context_index]) assert.equal(Object.isFrozen(value), true);
    assert.doesNotMatch(JSON.stringify(observed), /body-not-public|private-metadata-value|ownership_token|elapsed_ms|stopped|pid/);
    assert.deepEqual(projectRunSnapshot(identity, observed.facts), { state: "unavailable", reason: "timing_unproven" });
    assert.equal(observed.unchanged(), true);
    writeFileSync(f.resultPath, JSON.stringify({ ...f.result, code: code === 0 ? 7 : 0 }));
    assert.equal(observed.unchanged(), false); assert.equal(observed.facts.lifecycle.status, code === 0 ? "done" : "failed");
  }
});

test("Legacy, active, captured, malformed or foreign outcomes remain lifecycle-unproven despite PID and actor flags", t => {
  const f = canonicalFixture(t);
  for (const value of [undefined, { code: 0 }, { ...f.result, run_instance_id: "new-generation" },
    { ...f.result, terminal_acceptance: "after_stop_claim", stop_claim_id: "captured-stop" }, { ...f.result, completedAt: "invalid" }]) {
    if (value === undefined) rmSync(f.resultPath); else writeFileSync(f.resultPath, JSON.stringify(value));
    const observed = f.read(); assert.equal(observed.state, "available"); if (observed.state !== "available") return;
    assert.deepEqual(observed.facts.lifecycle, { status: "unproven" });
    assert.deepEqual(projectRunSnapshot(identity, observed.facts), { state: "unavailable", reason: "lifecycle_unproven" });
  }
  f.meta.outcome_protocol = "foreign"; f.publish();
  const foreign = f.read(); assert.equal(foreign.state, "available"); if (foreign.state === "available") assert.equal(foreign.facts.lifecycle.status, "unproven");
  f.meta.outcome_protocol = RUN_OUTCOME_PROTOCOL; f.publish();
  const bytes = Buffer.from(JSON.stringify(f.result)); bytes[bytes.indexOf("body-not-public")] = 0xff; writeFileSync(f.resultPath, bytes);
  const invalid = f.read(); assert.equal(invalid.state, "available"); if (invalid.state === "available") assert.equal(invalid.facts.lifecycle.status, "unproven");
  writeFileSync(f.resultPath, JSON.stringify({ ...f.result, output: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) }));
  const oversized = f.read(); assert.equal(oversized.state, "available"); if (oversized.state === "available") assert.equal(oversized.facts.lifecycle.status, "unproven");
});

test("Canonical fact admission rejects foreign identity, invalid observation/reference and encoded-output overflow", t => {
  const f = canonicalFixture(t);
  for (const delta of [{ run: "foreign" }, { run_instance_id: "foreign" }, { ownerId: "foreign" }]) assert.deepEqual(f.read({ ...identity, ...delta }), { state: "unavailable", reason: "identity_mismatch" });
  for (const at of [undefined, null, "yesterday", "2026-10-22T19:44:08Z", "x".repeat(33)]) assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, at), { state: "unavailable", reason: "observation_unavailable" });
  for (const cwd of ["relative", "/control\npath"]) { f.meta.cwd = cwd; f.publish(); assert.deepEqual(f.read(), { state: "unavailable", reason: "references_unavailable" }); }
  f.meta.cwd = "/" + "\"".repeat(9000); f.publish(); assert.deepEqual(f.read(), { state: "unavailable", reason: "snapshot_too_large" });
  f.meta.cwd = f.root; f.publish(); rmSync(f.resultPath); mkdirSync(f.resultPath);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_unavailable" });
});

test("Index loss stays local to its reference and captured owner/result/index observations invalidate on change", t => {
  const f = canonicalFixture(t); rmSync(f.indexPath);
  const missing = f.read(); assert.equal(missing.state, "available"); if (missing.state !== "available") return;
  assert.equal(missing.facts.context_index, undefined); assert.equal(missing.facts.lifecycle.status, "done"); assert.equal(missing.unchanged(), true);
  writeFileSync(f.indexPath, "malformed"); assert.equal(missing.unchanged(), false);
  const malformed = f.read(); assert.equal(malformed.state, "available"); if (malformed.state === "available") assert.equal(malformed.facts.context_index, undefined);
  f.publish();
  const lstat = fs.lstatSync, stamp = lstat(f.metadataPath, { bigint: true });
  // Model a same-tick filesystem: metadata replacement must not depend on timestamp precision.
  fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const value = Reflect.apply(lstat, fs, [path, ...args]) as fs.Stats | fs.BigIntStats;
    if (String(path) === f.metadataPath && "mtimeNs" in value) Object.assign(value, { mtimeNs: stamp.mtimeNs, ctimeNs: stamp.ctimeNs });
    return value;
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    const valid = f.read(); assert.equal(valid.state, "available"); if (valid.state !== "available") return;
    const replacement = join(f.root, "replacement-run.json");
    writeFileSync(replacement, JSON.stringify({ ...f.meta, run_instance_id: "generation-b" }));
    assert.notEqual(lstat(replacement, { bigint: true }).ino, stamp.ino, "Simultaneously existing metadata files have distinct native identities");
    fs.renameSync(replacement, f.metadataPath);
    assert.equal(valid.unchanged(), false);
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
});

test("Canonical facts never read role bodies or probe processes/clocks, mutate, scan or export", t => {
  const f = canonicalFixture(t); mkdirSync(join(f.stateDir, "evidence"));
  const rolePath = join(f.stateDir, "evidence", "trace.jsonl"); const roleBody = "private role body"; writeFileSync(rolePath, roleBody);
  f.index.entries.trace = { availability: "available", path: "evidence/trace.jsonl", media_type: "application/x-ndjson",
    bytes_total: Buffer.byteLength(roleBody), mutable: true, coverage: { truncated: false, redacted: true, history_complete: true } }; f.publish();
  const before = [f.metadataPath, f.resultPath, f.indexPath, rolePath].map(path => readFileSync(path));
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync, mkdirSync: fs.mkdirSync, readdirSync: fs.readdirSync };
  const kill = process.kill; const now = Date.now; const roleFds = new Set<number>(); let roleOpens = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(originals.openSync, fs, [path, ...args]); if (String(path) === rolePath) { roleFds.add(fd); roleOpens++; } return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { roleFds.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.equal(roleFds.has(fd), false); return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.notEqual(String(path), rolePath); return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => assert.fail("Observation attempted mutation, discovery, process/clock probe");
  fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync;
  fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.readdirSync = forbidden as typeof fs.readdirSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden;
  syncBuiltinESMExports();
  try { const observed = f.read(); assert.equal(observed.state, "available"); if (observed.state === "available") { assert.equal(observed.unchanged(), true); assert.equal(observed.facts.context_index?.path, f.indexPath); } }
  finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(roleOpens, 1); assert.deepEqual([f.metadataPath, f.resultPath, f.indexPath, rolePath].map(path => readFileSync(path)), before);
});

test("Canonical result is read once and observed replacement during that read refuses facts", t => {
  const f = canonicalFixture(t); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync;
  const resultFds = new Set<number>(); let reads = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.resultPath) resultFds.add(fd); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { resultFds.delete(fd); return close(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { const count = Reflect.apply(read, fs, [fd, ...args]); if (resultFds.has(fd)) { reads++; writeFileSync(f.resultPath, JSON.stringify({ ...f.result, code: 7 })); } return count; }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_changed" }); }
  finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(reads, 1);
});

function activeFixture(t: TestContext) {
  const f = canonicalFixture(t); const processIdentity = readProcessIdentity(process.pid);
  if (!processIdentity) { t.skip("Captured process identity unsupported on this platform"); return undefined; }
  let mono = 0; let samples = 0; let hook: (() => void) | undefined; const epoch = {};
  const origin = captureRunSupervisionTimeOrigin({ wallNow: () => Date.parse(capturedAt), monotonicNow: () => { samples++; hook?.(); return { milliseconds: mono, epoch }; } });
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 1000 }, origin.wall_ms);
  const meta = { ...f.meta, ...clock, createdAt: clock.started_at, cwd: process.cwd(), process_identity: processIdentity };
  const publish = () => writeFileSync(f.metadataPath, JSON.stringify(meta)); publish(); rmSync(f.resultPath);
  const owner = createRunSupervisionOwner({ onDeadlineDue: () => assert.fail("Active observation notified deadline"), schedule: () => assert.fail("Active observation armed timer") });
  t.after(() => owner.close()); owner.onSupervisionClockCaptured({ kind: "run_clock_origin_captured", visibility: "kernel_only", publication: "unpublished", work_started: false,
    state_dir: f.stateDir, identity, clock, origin });
  const read = () => readRunSnapshotFacts(f.stateDir, identity, capturedAt, owner.observeTime);
  const claim = { version: 1, claim_id: "11111111-1111-1111-1111-111111111111", ...identity, pid: meta.pid,
    process_identity_digest: runProcessIdentityDigest(processIdentity), reason: "manual_kill", requested_at: capturedAt };
  return { ...f, meta, owner, claim, publish, read, samples: () => samples, setMono: (value: number) => { mono = value; }, onSample: (callback: (() => void) | undefined) => { hook = callback; } };
}

test("Explicit active join uses captured PID proof and original retained-origin time for running/stopping only", t => {
  const f = activeFixture(t); if (!f) return; f.setMono(250.75);
  for (const phase of ["running", "stopping", "captured"]) {
    if (phase !== "running") writeFileSync(join(f.stateDir, RUN_STOP_CLAIM_FILE), JSON.stringify(f.claim));
    if (phase === "captured") writeFileSync(f.resultPath, JSON.stringify({ ...f.result, terminal_acceptance: "after_stop_claim", stop_claim_id: f.claim.claim_id }));
    const observed = f.read(); assert.equal(observed.state, "available"); if (observed.state !== "available") return;
    assert.deepEqual(observed.facts.lifecycle, { status: "running", ...(phase === "running" ? {} : { phase: "stopping" }) });
    assert.deepEqual(observed.facts.timing, { basis: "live", elapsed_ms: 250 }); assert.equal(observed.unchanged(), true);
    assert.equal(projectRunSnapshot(identity, observed.facts).state, "available", "Kernel-only shape witness, not public-reference visibility");
    assert.equal(f.owner.snapshot(identity).state, "retained"); assert.doesNotMatch(JSON.stringify(observed), /stopped|timed_out|scope_closure|process_identity|ownership_token/);
  }
});

test("Default active metadata remains probe-free and unsupported/corrupt proof never samples time", t => {
  const f = activeFixture(t); if (!f) return; const kill = process.kill; const before = f.samples();
  process.kill = (() => assert.fail("Default read probed process")) as typeof process.kill;
  try { const value = readRunSnapshotFacts(f.stateDir, identity, capturedAt); assert.equal(value.state, "available"); if (value.state === "available") assert.equal(value.facts.lifecycle.status, "unproven"); }
  finally { process.kill = kill; }
  for (const delta of [{ pid: 0 }, { pid: -1 }, { process_identity: undefined }, { process_identity: { ...f.meta.process_identity, start_time: "foreign" } }]) {
    writeFileSync(f.metadataPath, JSON.stringify({ ...f.meta, ...delta }));
    const value = f.read(); assert.equal(value.state, "available"); if (value.state === "available") assert.deepEqual(value.facts.lifecycle, { status: "unproven" });
  }
  f.publish(); process.kill = (() => { throw Object.assign(Error("probe denied"), { code: "EPERM" }); }) as typeof process.kill;
  try { const value = f.read(); assert.equal(value.state, "available"); if (value.state === "available") assert.equal(value.facts.lifecycle.status, "unproven"); }
  finally { process.kill = kill; }
  writeFileSync(join(f.stateDir, RUN_STOP_CLAIM_FILE), "invalid stop"); const badStop = f.read();
  assert.equal(badStop.state, "available"); if (badStop.state === "available") assert.equal(badStop.facts.lifecycle.status, "unproven");
  assert.equal(f.samples(), before);
});

test("Natural priority never samples live time as terminal duration; missing or foreign retained roots cannot lend elapsed", t => {
  const f = activeFixture(t); if (!f) return; const before = f.samples(); writeFileSync(f.resultPath, JSON.stringify(f.result));
  const terminal = readRunSnapshotFacts(f.stateDir, identity, capturedAt, () => assert.fail("Terminal path sampled live time"));
  assert.equal(terminal.state, "available"); if (terminal.state === "available") { assert.equal(terminal.facts.lifecycle.status, "done"); assert.deepEqual(terminal.facts.timing, { basis: "unproven" }); }
  rmSync(f.resultPath);
  const copy = claimRunStateDirectory(join(f.root, "copy"), identity.run); writeFileSync(join(copy, "run.json"), JSON.stringify({ ...f.meta, state_dir: copy }));
  assert.deepEqual(f.owner.observeTime(identity, copy), { state: "unavailable", reason: "identity_mismatch" });
  const foreign = readRunSnapshotFacts(copy, identity, capturedAt, f.owner.observeTime); assert.equal(foreign.state, "available");
  if (foreign.state === "available") { assert.deepEqual(foreign.facts.lifecycle, { status: "unproven" }); assert.deepEqual(foreign.facts.timing, { basis: "unproven" }); }
  f.owner.release(identity); const missing = f.read(); assert.equal(missing.state, "available");
  if (missing.state === "available") assert.deepEqual(missing.facts.lifecycle, { status: "unproven" }); assert.equal(f.samples(), before);
});

test("Active join fences result/stop publication and retained-owner revocation during time sampling", t => {
  for (const action of ["natural", "stop", "close", "clock_fault"] as const) {
    const f = activeFixture(t); if (!f) return; f.setMono(400);
    f.onSample(() => { f.onSample(undefined); if (action === "natural") writeFileSync(f.resultPath, JSON.stringify(f.result));
      else if (action === "stop") writeFileSync(join(f.stateDir, RUN_STOP_CLAIM_FILE), JSON.stringify(f.claim));
      else if (action === "close") f.owner.close(); else f.setMono(-1); });
    const observed = f.read();
    if (action === "natural" || action === "stop") assert.deepEqual(observed, { state: "unavailable", reason: "observation_changed" });
    else { assert.equal(observed.state, "available"); if (observed.state === "available") {
      assert.equal(observed.facts.lifecycle.status, action === "close" ? "unproven" : "running"); assert.deepEqual(observed.facts.timing, { basis: "unproven" });
    } }
  }
  const f = activeFixture(t); if (!f) return;
  const observed = readRunSnapshotFacts(f.stateDir, identity, capturedAt, (expected, root) => {
    const time = f.owner.observeTime(expected, root); if (time.state !== "available") return time;
    return { ...time, unchanged: () => { writeFileSync(f.resultPath, JSON.stringify(f.result)); return true; } };
  });
  assert.deepEqual(observed, { state: "unavailable", reason: "observation_changed" });
  const kill = process.kill; let probes = 0;
  process.kill = ((pid, signal) => { if (pid === process.pid && signal === 0 && ++probes === 2) throw Object.assign(Error("observed exit"), { code: "ESRCH" }); return kill(pid, signal); }) as typeof process.kill;
  rmSync(f.resultPath);
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_changed" }); }
  finally { process.kill = kill; }
  assert.equal(probes, 2);
});

test("Active timing port refuses serialized DTOs, foreign identities, accessors and deferred completions without invoking thenables", async t => {
  const f = activeFixture(t); if (!f) return;
  type Observer = NonNullable<Parameters<typeof readRunSnapshotFacts>[3]>;
  assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, capturedAt, {} as Observer), { state: "unavailable", reason: "observation_unavailable" });
  let getters = 0; const deferred = { get then() { getters++; throw Error("Then getter invoked"); } };
  for (const value of [deferred, { get state() { getters++; return "available"; } }]) {
    assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, capturedAt, (() => value) as unknown as Observer), { state: "unavailable", reason: "observation_unavailable" });
  }
  const time = f.owner.observeTime(identity); assert.equal(time.state, "available"); if (time.state !== "available") return;
  const copied = JSON.parse(JSON.stringify(time));
  assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, capturedAt, (() => copied) as Observer), { state: "unavailable", reason: "observation_unavailable" });
  assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, capturedAt, () => ({ ...time, identity: { ...identity, ownerId: "foreign" } })), { state: "unavailable", reason: "identity_mismatch" });
  assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, capturedAt, (() => Promise.reject(Error("deferred time"))) as unknown as Observer), { state: "unavailable", reason: "observation_unavailable" });
  for (const stable of [1, deferred, Promise.reject(Error("deferred fence"))]) {
    const observer = () => ({ ...time, unchanged: (() => stable) as unknown as () => boolean });
    assert.deepEqual(readRunSnapshotFacts(f.stateDir, identity, capturedAt, observer), { state: "unavailable", reason: "observation_changed" });
  }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(getters, 0);
});
