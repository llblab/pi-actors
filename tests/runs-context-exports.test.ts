/** Mirrors lib/runs-context-exports.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import {
  createHash,
} from "node:crypto";
import fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  syncBuiltinESMExports,
} from "node:module";
import {
  tmpdir,
} from "node:os";
import {
  join,
  basename,
  sep,
} from "node:path";
import test from "node:test";
import {
  after,
  type TestContext,
  describe,
} from "node:test";
import {
  spawnSync,
} from "node:child_process";

const { afterMutationLockRelease } = await import(new URL("./test-environment.mjs", import.meta.url).href);

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Control and primary publication", { concurrency: false }, async () => {
/** Producer-bound creation of a real redacted Control view, without public/index wiring. */


const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-control-export-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});

const { createRunPrimaryTextPublisher, readRunCompletionTextSource, readRunPrimaryTextSource, writeRunControlContextExport, writeRunControlContextIndex, RUN_CONTEXT_CONTROL_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { executeRegisteredTool } = await import("../lib/execution.ts");
const { admitRunResultProducer, publishRunResult, withRunProducerEvidence, readRunProducerCapturedMetadata } = await import("../lib/runs-results.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunControlInStateDir, claimRunControlInStateDir, updateRunControlStatusInStateDir } = await import("../lib/runs-controls.ts");
const { readRunContextIndex, runContextExportPath, writeRunContextIndexUnderLock,
  RUN_CONTEXT_INDEX_METADATA_MAX_BYTES, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");
const { createRunRecipeEvidenceRedactor } = await import("../lib/recipe-projection.ts");
const { projectRunControl } = await import("../lib/control-projection.ts");
const { INSPECTOR_BODY_PREVIEW_CHARS } = await import("../lib/limits.ts");

function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = mkdtempSync(join(agentDir, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "control-export");
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
  const meta = { run: "control-export", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir,
    createdAt: clock.started_at, ...clock,
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL };
  const metaPath = join(stateDir, "run.json");
  prepare?.(meta); writeJsonAtomic(metaPath, meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const journal = join(stateDir, "controls.jsonl");
  const view = join(stateDir, runContextExportPath("control"));
  const append = (input: unknown = { note: "visible" }) => appendRunControlInStateDir(stateDir,
    { run_instance_id: meta.run_instance_id, action: "refresh", input });
  const publish = () => writeRunControlContextExport(stateDir, producer);
  const publishIndex = () => writeRunControlContextIndex(stateDir, producer);
  return { root, stateDir, meta, metaPath, producer, journal, view, append, publish, publishIndex };
}

function view(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test("Control writer fixes original input/error privacy before first/refresh clipping while current journal and standalone projection stay separate", t => {
  const origin = "/x/private";
  for (const present of [true, false]) {
    const values: Record<string, unknown> = present ? { skill_dir: origin } : {};
    const f = fixture(t, meta => { meta.values = values; });
    const original = readRunProducerCapturedMetadata(f.producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES)!;
    const redact = createRunRecipeEvidenceRedactor(original, Number.MAX_SAFE_INTEGER);
    const first = f.append({ note: `read ${origin}/payload \uFEFF\uFFFD🫧\r\n`, api_key: "HIDDEN_CONTROL_INPUT" });
    assert.equal(claimRunControlInStateDir(f.stateDir, f.meta.run_instance_id)?.id, first.id);
    assert.equal(updateRunControlStatusInStateDir(f.stateDir, first.id, "failed", { error: `missing ${origin}/item; token=HIDDEN_CONTROL_ERROR` }, ["claimed"]), true);
    const second = f.append({ note: "boundary" });
    assert.equal(claimRunControlInStateDir(f.stateDir, f.meta.run_instance_id)?.id, second.id);
    assert.equal(updateRunControlStatusInStateDir(f.stateDir, second.id, "failed", { error: "x".repeat(INSPECTOR_BODY_PREVIEW_CHARS - 7) + " " + origin + "/item" }, ["claimed"]), true);
    const raw = readFileSync(f.journal), records = raw.toString().trim().split("\n").map(line => JSON.parse(line));
    const expected = records.map(control => projectRunControl({ ...control, input: redact(control.input), error: redact(control.error) as string }));
    const standalone = projectRunControl(records[0]); assert.equal((standalone.input as {note: string}).note.includes(origin), true);
    assert.deepEqual(Reflect.apply(projectRunControl, undefined, [records[0], original]), standalone);
    values.skill_dir = "/caller/changed";
    writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? { skill_dir: "/live/changed" } : { skill_dir: origin } });
    for (const phase of ["first", "refresh"]) {
      if (phase === "refresh") writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/another/live/origin" } });
      assert.equal(f.publishIndex().status, "published"); const projected = view(f.view);
      assert.deepEqual(projected.controls, expected); assert.equal(projected.controls.length, 2); assert.equal(projected.controls_omitted, 0);
      assert.equal(projected.capacity.pending, 0); assert.equal(projected.run_status, "running"); assert.equal(projected.coverage.history_complete, false);
      assert.equal(projected.controls[0].input.note.includes(origin), !present);
      assert.equal(projected.controls[1].error.includes("/x/pr"), !present);
      assert.doesNotMatch(JSON.stringify(projected), /HIDDEN_CONTROL_INPUT|HIDDEN_CONTROL_ERROR/);
      assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available"); assert.deepEqual(readFileSync(f.journal), raw);
    }
    f.append({ note: "new current evidence" }); assert.equal(f.publish().status, "written");
    assert.equal(view(f.view).controls.length, 3); assert.equal(view(f.view).capacity.pending, 1);
    assert.equal(existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Private Control references retain full safe Unicode identities while privacy-changed rows are omitted, not repaired from raw ids", t => {
  const secret = "literal-control-credential-62", escaped = "raw\"\\\r\n\uFEFF\uFFFD🫧```";
  const f = fixture(t, meta => { meta.run_instance_id = "generation-" + "🫧".repeat(500); meta.values = { skill_dir: "/x/private", api_key: secret, nested: { password: escaped } }; });
  const first = f.append({ note: "read /x/private/body", api_key: "HIDDEN_INPUT" });
  const ids = ["safe-control-" + "🫧".repeat(200) + " \uFEFF\uFFFD```\r\n", "safe-" + "x".repeat(4000), "/x/private/secret-id", "token=HIDDEN_REFERENCE", "logical-" + secret + "-suffix", escaped];
  const records = ids.map(id => ({ ...first, id })), foreign = { ...first, id: "foreign-id", run_instance_id: "foreign-generation" };
  writeFileSync(f.journal, [...records, foreign].map(record => JSON.stringify(record)).join("\n") + "\n");
  const before = [f.metaPath, f.journal].map(path => readFileSync(path));
  const preview = projectRunControl(records[0]); assert.notEqual(preview.id, records[0].id); assert.notEqual(preview.run_instance_id, f.meta.run_instance_id);
  assert.equal(f.publishIndex().status, "published"); const body = view(f.view);
  assert.equal(body.run_instance_id, f.meta.run_instance_id); assert.equal(body.controls.length, 2); assert.equal(body.controls_omitted, 4); assert.equal(body.foreign_controls_omitted, 1);
  assert.deepEqual(body.controls.map((row: any) => row.id), ids.slice(0, 2)); assert.ok(body.controls.every((row: any) => row.run_instance_id === f.meta.run_instance_id));
  assert.equal(body.capacity.pending, 6); assert.doesNotMatch(JSON.stringify(body), /HIDDEN_|\/x\/private|foreign-id|literal-control-credential-62/);
  assert.deepEqual([f.metaPath, f.journal].map(path => readFileSync(path)), before);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/replacement" } }); assert.equal(f.publish().status, "written");
  assert.deepEqual(view(f.view).controls.map((row: any) => row.id), ids.slice(0, 2)); assert.equal(view(f.view).controls_omitted, 4);
  assert.deepEqual(projectRunControl(records[0]), preview); assert.equal(existsSync(join(f.stateDir, "result.json")), false);
});

test("Full Control identifiers consume actual UTF8 budget with whole-row omissions and never clipped reference fragments", t => {
  const f = fixture(t, meta => { meta.run_instance_id = "g".repeat(8036); }); const first = f.append();
  const records = Array.from({ length: 20 }, (_, index) => ({ ...first, id: `control-${index}-` + "界".repeat(1800) }));
  writeFileSync(f.journal, records.map(record => JSON.stringify(record)).join("\n") + "\n"); assert.equal(f.publish().status, "written"); const bounded = view(f.view);
  assert.ok(bounded.controls.length > 0 && bounded.controls.length < records.length); assert.equal(bounded.controls.length + bounded.controls_omitted, records.length);
  assert.deepEqual(bounded.controls.map((row: any) => row.id), records.slice(-bounded.controls.length).map(row => row.id));
  assert.ok(bounded.controls.every((row: any) => row.run_instance_id === f.meta.run_instance_id)); assert.equal(bounded.capacity.pending, 20);
  assert.ok(fs.statSync(f.view).size <= RUN_CONTEXT_CONTROL_MAX_BYTES);
  writeFileSync(f.journal, JSON.stringify({ ...first, id: "safe-" + "x".repeat(RUN_CONTEXT_CONTROL_MAX_BYTES + 1) }) + "\n");
  assert.equal(f.publish().status, "written"); assert.deepEqual(view(f.view).controls, []); assert.equal(view(f.view).controls_omitted, 1); assert.equal(view(f.view).capacity.pending, 1);
  const header = fixture(t, meta => { meta.run_instance_id = "g".repeat(RUN_CONTEXT_INDEX_METADATA_MAX_BYTES + 1); }); header.append();
  assert.deepEqual(header.publish(), { status: "unavailable", reason: "control_metadata_changed" }); assert.equal(existsSync(header.view), false);
});

test("Privacy-changed Control header identities refuse before journal opening instead of exposing a raw identity or a masked reference", t => {
  for (const generation of ["generation /x/private", "generation token=HIDDEN_GENERATION"]) {
    const f = fixture(t, meta => { meta.run_instance_id = generation; meta.values = { skill_dir: "/x/private" }; }); f.append();
    const open = fs.openSync; let reads = 0; fs.openSync = ((path, ...args) => { if (String(path) === f.journal) reads++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "control_identity_redacted" }); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.equal(reads, 0); assert.equal(existsSync(f.view), false);
  }
});

test("Control original/current metadata budgets refuse before journal body reads without healthy fallback or workload changes", t => {
  let healthy: unknown;
  const over = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { padding: "🫧".repeat(300000) }; });
  writeJsonAtomic(over.metaPath, healthy); over.append();
  const open = fs.openSync; let sourceOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === over.journal) sourceOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(over.publish(), { status: "unavailable", reason: "control_admission_unavailable" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(sourceOpens, 0); assert.equal(existsSync(over.view), false);
  over.publishIndex(); assert.deepEqual(view(join(over.stateDir, "context-index.json")).entries.control,
    { availability: "unavailable", path: null, reason: "control_admission_unavailable" });
  const f = fixture(t); f.append(); const base = { ...f.meta, padding: "" };
  const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  writeFileSync(f.metaPath, JSON.stringify({ ...base, padding: "x".repeat(room) })); assert.equal(fs.statSync(f.metaPath).size, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  assert.equal(f.publish().status, "written"); const before = readFileSync(f.view), journal = readFileSync(f.journal);
  fs.appendFileSync(f.metaPath, " "); assert.deepEqual(f.publish(), { status: "unavailable", reason: "control_metadata_unavailable" });
  assert.deepEqual(readFileSync(f.view), before); assert.deepEqual(readFileSync(f.journal), journal);
  const corrupt = Buffer.from(JSON.stringify({ ...f.meta, padding: "X" })); corrupt[corrupt.indexOf('"X"') + 1] = 0xff;
  writeFileSync(f.metaPath, corrupt); assert.equal(f.publish().status, "unavailable"); assert.deepEqual(readFileSync(f.view), before);
});

test("Control metadata/marker/root capture fences survive publication without turning recorded journal snapshots into latest-at-commit proof", t => {
  for (const change of ["metadata", "marker", "root"] as const) {
    const f = fixture(t); f.append(); f.publish(); const before = readFileSync(f.view), lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
    const rename = fs.renameSync; let changed = false;
    const releaseHook = afterMutationLockRelease(lock, () => {
        changed = true;
        if (change === "metadata") writeJsonAtomic(f.metaPath, { ...f.meta, note: "same-generation changed observation" });
        else if (change === "marker") { const path = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE); rename(path, path + ".held"); fs.copyFileSync(path + ".held", path); }
        else { rename(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      });
    try { assert.throws(f.publish, /captured source binding changed/); assert.equal(changed, true); }
    finally { releaseHook(); }
    assert.deepEqual(readFileSync(f.view), before);
  }
  const f = fixture(t); const first = f.append(); f.publish(); const write = fs.writeFileSync; let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path).startsWith(f.view + ".")) { changed = true; fs.appendFileSync(f.journal, JSON.stringify({ ...first, id: "late-current-input" }) + "\n"); }
    return result;
  }) as typeof fs.writeFileSync; syncBuiltinESMExports();
  try { assert.equal(f.publish().status, "written"); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(view(f.view).controls.length, 1); assert.equal(view(f.view).capacity.pending, 1);
  assert.equal(f.publish().status, "written"); assert.equal(view(f.view).controls.length, 2); assert.equal(view(f.view).capacity.pending, 2);
});

test("Control export uses actual canonical privacy projection and writes only its generation-bound derived view", (t) => {
  const f = fixture(t);
  const control = f.append({ api_key: "hidden-input-key", nested: { password: "hidden-password" },
    note: "Bearer hidden-bearer" });
  assert.equal(claimRunControlInStateDir(f.stateDir, f.meta.run_instance_id)?.id, control.id);
  assert.equal(updateRunControlStatusInStateDir(f.stateDir, control.id, "failed", { error: "token=hidden-error-token" }, ["claimed"]), true);
  const retained = ["native-launches.json", "descendant-launches.json"].map(name => join(f.stateDir, name));
  retained.forEach(path => writeFileSync(path, "opaque retained scope evidence"));
  const canonical = [f.metaPath, f.journal, ...retained];
  const before = canonical.map(path => readFileSync(path));
  const result = f.publish();
  assert.equal(result.status, "written");
  if (result.status !== "written") return;
  const body = view(f.view);
  assert.equal(body.schema, "run-context-control-v1");
  assert.equal(body.run, f.meta.run);
  assert.equal(body.run_instance_id, f.meta.run_instance_id);
  assert.equal(body.run_status, "running");
  assert.equal(body.controls.length, 1);
  assert.equal(body.controls[0].input.api_key, "[REDACTED]");
  assert.equal(body.controls[0].input.nested.password, "[REDACTED]");
  assert.doesNotMatch(readFileSync(f.view, "utf8"), /hidden-input-key|hidden-password|hidden-bearer|hidden-error-token|ownership_token/);
  assert.equal(result.entry.availability, "available");
  if (result.entry.availability !== "available") return;
  assert.equal(result.entry.path, "evidence/control.json");
  assert.equal(result.entry.bytes_total, fs.statSync(f.view).size);
  assert.deepEqual(result.entry.coverage, { truncated: true, history_complete: false, redacted: true });
  assert.deepEqual(body.coverage, result.entry.coverage);
  assert.deepEqual(canonical.map(path => readFileSync(path)), before);
  for (const file of ["context-index.json", "result.json", "progress.json", "trace.jsonl", "terminal-handled.json"]) {
    assert.equal(existsSync(join(f.stateDir, file)), false);
  }
  const entries = Object.fromEntries(["recipe", "result", "trace", "control", "execution", "artifacts", "sessions", "stdout", "stderr"]
    .map(role => [role, role === "control" ? result.entry : { availability: "pending", path: null }]));
  writeJsonAtomic(join(f.stateDir, "context-index.json"), { schema: "run-context-index-v1", run: f.meta.run,
    run_instance_id: f.meta.run_instance_id, updated_at: result.captured_at, entries });
  assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
});

test("Missing source creates no pretend empty export, while a real empty journal stays explicitly incomplete", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "control_journal_absent" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  writeFileSync(f.journal, "");
  assert.equal(f.publish().status, "written");
  const body = view(f.view);
  assert.deepEqual(body.controls, []);
  assert.equal(body.capacity.pending, 0);
  assert.equal(body.controls_omitted, 0);
});

test("Foreign generations are counted but never copied, and malformed sources never replace an existing view", (t) => {
  const f = fixture(t);
  const current = f.append();
  const foreign = { ...current, id: "foreign-secret-id", run_instance_id: "foreign-generation", status: "handled",
    handled_at: current.queued_at, input: { note: "foreign-private-body" } };
  writeFileSync(f.journal, [foreign, current].map(record => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(f.publish().status, "written");
  const body = view(f.view);
  assert.equal(body.foreign_controls_omitted, 1);
  assert.equal(body.controls.length, 1);
  assert.doesNotMatch(readFileSync(f.view, "utf8"), /foreign-secret-id|foreign-generation|foreign-private-body/);
  const before = readFileSync(f.view);
  for (const bad of ["{partial\n", JSON.stringify({ ...current, input: { text: "x".repeat(1000) } }) + "\n",
    JSON.stringify({ ...current, action: "bad action" }) + "\n",
    JSON.stringify({ ...current, run_instance_id: "" }) + "\n", "null\n"]) {
    writeFileSync(f.journal, bad);
    assert.equal(f.publish().status, "unavailable");
    assert.deepEqual(readFileSync(f.view), before);
  }
});

test("Denied source metadata is a bounded unavailable result, not an exception containing private paths", (t) => {
  const f = fixture(t);
  f.append();
  const lstat = fs.lstatSync;
  fs.lstatSync = ((path, ...args) => {
    if (String(path) === f.journal) throw Object.assign(new Error("private source path"), { code: "EACCES" });
    return Reflect.apply(lstat, fs, [path, ...args]);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "control_journal_unavailable" }); }
  finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
});

test("Bounded Control views disclose omitted rows and apply the real UTF-8 byte ceiling", (t) => {
  const f = fixture(t);
  const first = f.append({ note: "界".repeat(80) });
  const records = Array.from({ length: 65 }, (_, index) => ({ ...first, id: "control-" + index, status: "failed",
    failed_at: first.queued_at, error: "界".repeat(1300) }));
  writeFileSync(f.journal, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(f.publish().status, "written");
  const body = view(f.view);
  assert.equal(body.controls.length + body.controls_omitted, 65);
  assert.ok(body.controls_omitted >= 25);
  assert.equal(body.controls.at(-1).id, "control-64");
  assert.ok(fs.statSync(f.view).size <= RUN_CONTEXT_CONTROL_MAX_BYTES);
});

test("Copied or replaced producer identity never authorizes source reads or export creation", (t) => {
  const f = fixture(t);
  f.append();
  assert.throws(() => writeRunControlContextExport(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
  assert.throws(f.publish, /generation changed/);
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
});

test("A producer replacement between capture and publication is revalidated before any export write", (t) => {
  const f = fixture(t);
  f.append();
  const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
  let replaced = false;
  const releaseHook = afterMutationLockRelease(lock, () => {
      replaced = true;
      writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
    });
  try { assert.throws(f.publish, /generation changed/); assert.equal(replaced, true); }
  finally { releaseHook(); }
  assert.equal(existsSync(f.view), false);
});

test("Observed metadata replacement while the temporary view is prepared refuses the atomic commit", (t) => {
  const f = fixture(t);
  f.append();
  const write = fs.writeFileSync;
  let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path).startsWith(f.view + ".")) {
      changed = true;
      writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
    }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /export binding/); assert.equal(changed, true); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(existsSync(f.view), false);
});

test("Unowned collisions and foreign view bindings are preserved instead of overwritten", (t) => {
  const f = fixture(t);
  f.append();
  fs.mkdirSync(join(f.stateDir, "evidence"));
  for (const body of [{ actor_owned: true }, { schema: "run-context-control-v1", run: f.meta.run, run_instance_id: "generation-b" }]) {
    writeJsonAtomic(f.view, body);
    const before = readFileSync(f.view);
    assert.throws(f.publish, /export binding/);
    assert.deepEqual(readFileSync(f.view), before);
  }
});

test("Symlinked source, export directory or target cannot become an export shortcut", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  f.append();
  fs.renameSync(f.journal, f.journal + ".saved");
  fs.symlinkSync(f.journal + ".saved", f.journal);
  assert.equal(f.publish().status, "unavailable");
  fs.unlinkSync(f.journal);
  fs.renameSync(f.journal + ".saved", f.journal);
  const other = join(f.root, "other");
  fs.mkdirSync(other);
  fs.symlinkSync(other, join(f.stateDir, "evidence"));
  assert.throws(f.publish, /export directory/);
  assert.deepEqual(fs.readdirSync(other), []);
  fs.unlinkSync(join(f.stateDir, "evidence"));
  fs.mkdirSync(join(f.stateDir, "evidence"));
  const target = join(other, "target.json");
  writeFileSync(target, "private");
  fs.symlinkSync(target, f.view);
  assert.throws(f.publish, /export binding/);
  assert.equal(readFileSync(target, "utf8"), "private");
});

test("Atomic-write failure is not retried or rolled back; a later explicit call captures fresh Control evidence", (t) => {
  const f = fixture(t);
  f.append();
  const rename = fs.renameSync;
  const refusal = Object.assign(new Error("fixture export commit failed"), { code: "EIO" });
  let attempts = 0;
  fs.renameSync = ((from, to) => {
    if (String(to) === f.view) { attempts++; rename(from, to); throw refusal; }
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, error => error === refusal); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(attempts, 1);
  assert.equal(view(f.view).controls.length, 1);
  f.append({ note: "new explicit observation" });
  assert.equal(f.publish().status, "written");
  assert.equal(view(f.view).controls.length, 2);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

test("View creation while stopping or naturally terminal preserves root results, clocks and stop evidence", (t) => {
  for (const natural of [undefined, 0, 7]) {
    const f = fixture(t);
    f.append();
    if (natural === undefined) {
      const stop = claimRunStop(f.stateDir, { runInstanceId: f.meta.run_instance_id, ownerId: f.meta.ownerId, reason: "manual_kill" });
      if (stop.status === "rejected" && stop.code === "run_process_unproven") continue;
      assert.equal(stop.status, "stop_requested");
    } else publishRunResult(f.stateDir, f.producer, { code: natural });
    const files = [f.metaPath, f.journal, ...["result.json", "stop-claim.json"].map(name => join(f.stateDir, name)).filter(existsSync)];
    const before = files.map(path => readFileSync(path));
    assert.equal(f.publish().status, "written");
    assert.equal(view(f.view).run_status, natural === undefined ? "stopping" : natural === 0 ? "done" : "failed");
    assert.equal(f.publishIndex().status, "published");
    assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
    assert.deepEqual(files.map(path => readFileSync(path)), before);
    assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false);
  }
});

test("Context index joins the authorized Control view with nine explicit role states", (t) => {
  const f = fixture(t);
  f.append({ token: "private-index-input" });
  const before = [f.metaPath, f.journal].map(path => readFileSync(path));
  const result = f.publishIndex();
  assert.equal(result.status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta);
  assert.equal(reading.state, "available");
  if (reading.state !== "available") return;
  assert.deepEqual(result.index, reading.index);
  assert.equal(result.local_path, join(f.stateDir, "context-index.json"));
  assert.equal(Object.keys(reading.index.entries).length, 9);
  assert.equal(reading.index.entries.control.availability, "available");
  for (const [role, entry] of Object.entries(reading.index.entries)) {
    if (role !== "control") assert.deepEqual(entry, { availability: "unavailable", path: null, reason: "export_not_published" });
  }
  assert.doesNotMatch(readFileSync(f.view, "utf8"), /private-index-input/);
  assert.deepEqual([f.metaPath, f.journal].map(path => readFileSync(path)), before);
  for (const name of ["result.json", "progress.json", "trace.jsonl", "terminal-handled.json"]) {
    assert.equal(existsSync(join(f.stateDir, name)), false);
  }
});

test("Context index can publish pending/unavailable metadata without inventing or deleting a Control view", (t) => {
  const f = fixture(t);
  assert.equal(f.publishIndex().status, "published");
  const indexPath = join(f.stateDir, "context-index.json");
  assert.deepEqual(view(indexPath).entries.control, { availability: "pending", path: null });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  f.append();
  f.publishIndex();
  const before = readFileSync(f.view);
  writeFileSync(f.journal, "{broken\n");
  assert.equal(f.publishIndex().status, "published");
  assert.deepEqual(view(indexPath).entries.control, { availability: "unavailable", path: null, reason: "control_journal_invalid" });
  assert.deepEqual(readFileSync(f.view), before);
  assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
});

test("Context index preserves other admitted roles and makes lost/changed exports explicitly unavailable", (t) => {
  const f = fixture(t);
  f.append();
  f.publishIndex();
  const recipePath = join(f.stateDir, runContextExportPath("recipe"));
  writeFileSync(recipePath, JSON.stringify({ fixture: "authorized recipe view" }));
  const recipe = { availability: "available", path: runContextExportPath("recipe"), media_type: "application/json",
    bytes_total: fs.statSync(recipePath).size, mutable: false, coverage: { truncated: false, redacted: true } };
  withRunProducerEvidence(f.stateDir, f.producer, () => writeRunContextIndexUnderLock(f.stateDir, f.meta, { recipe }));
  f.publishIndex();
  const indexPath = join(f.stateDir, "context-index.json");
  assert.deepEqual(view(indexPath).entries.recipe, recipe);
  assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
  writeFileSync(recipePath, "changed bytes, retained for investigation");
  f.publishIndex();
  assert.deepEqual(view(indexPath).entries.recipe, { availability: "unavailable", path: null, reason: "export_unavailable" });
  assert.equal(readFileSync(recipePath, "utf8"), "changed bytes, retained for investigation");
});

test("Context index refuses corrupt, foreign or nonregular index targets instead of repairing them", (t) => {
  const f = fixture(t);
  f.append();
  f.publishIndex();
  const path = join(f.stateDir, "context-index.json");
  const good = view(path);
  for (const body of ["{unknown", JSON.stringify({ actor_owned: true }), JSON.stringify({ ...good, run_instance_id: "generation-b" })]) {
    writeFileSync(path, body);
    assert.throws(f.publishIndex, /context index/);
    assert.equal(readFileSync(path, "utf8"), body);
  }
  rmSync(path);
  fs.mkdirSync(path);
  assert.throws(f.publishIndex, /context index/);
  assert.equal(fs.statSync(path).isDirectory(), true);
});

test("Context index revalidates genuine producer identity after the view commits", (t) => {
  const f = fixture(t);
  f.append();
  const rename = fs.renameSync;
  let changed = false;
  fs.renameSync = ((from, to) => {
    const result = rename(from, to);
    if (!changed && String(to) === f.view) { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); }
    return result;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publishIndex, /generation changed/); assert.equal(changed, true); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(view(f.view).run_instance_id, "generation-a");
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Context index checks role/root changes before atomic replacement and preserves conflicting evidence", (t) => {
  for (const mutate of ["generation", "index", "role"] as const) {
    const f = fixture(t);
    f.append();
    const path = join(f.stateDir, "context-index.json");
    const write = fs.writeFileSync;
    let changed = false;
    fs.writeFileSync = ((target, ...args) => {
      const result = Reflect.apply(write, fs, [target, ...args]);
      if (!changed && String(target).startsWith(path + ".")) {
        changed = true;
        if (mutate === "generation") writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
        else if (mutate === "index") writeFileSync(path, "competing index evidence");
        else writeFileSync(f.view, "changed role evidence");
      }
      return result;
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try { assert.throws(f.publishIndex, /context index/); assert.equal(changed, true); }
    finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    if (mutate === "index") assert.equal(readFileSync(path, "utf8"), "competing index evidence");
    else assert.equal(existsSync(path), false);
  }
});

test("Context index commit errors retain single-file effects and permit only a fresh explicit observation", (t) => {
  for (const afterCommit of [false, true]) {
    const f = fixture(t);
    f.append();
    const path = join(f.stateDir, "context-index.json");
    const rename = fs.renameSync;
    const refusal = Object.assign(new Error("index publication refused"), { code: "EIO" });
    let attempts = 0;
    fs.renameSync = ((from, to) => {
      if (String(to) === path) { attempts++; if (afterCommit) rename(from, to); throw refusal; }
      return rename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.throws(f.publishIndex, error => error === refusal); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(attempts, 1);
    assert.equal(existsSync(f.view), true);
    assert.equal(existsSync(path), afterCommit);
    f.append({ note: "fresh explicit index observation" });
    assert.equal(f.publishIndex().status, "published");
    assert.equal(view(f.view).controls.length, 2);
    assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
  }
});

test("Context index rejects invalid updates and metadata overflow before replacing its target", (t) => {
  const f = fixture(t);
  f.publishIndex();
  const path = join(f.stateDir, "context-index.json");
  const before = readFileSync(path);
  for (const changes of [null, { private_role: { availability: "pending", path: null } },
    { control: { availability: "available", path: "controls.jsonl" } }]) {
    assert.throws(() => withRunProducerEvidence(f.stateDir, f.producer,
      () => writeRunContextIndexUnderLock(f.stateDir, f.meta, changes)), /context index/);
    assert.deepEqual(readFileSync(path), before);
  }
  const large = fixture(t);
  const base = { run: large.meta.run, run_instance_id: "", ownerId: large.meta.ownerId,
    state_dir: large.stateDir, pid: process.pid, outcome_protocol: RUN_OUTCOME_PROTOCOL };
  const room = RUN_CONTEXT_INDEX_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base, null, 2) + "\n");
  const meta = { ...base, run_instance_id: "g".repeat(room) };
  writeJsonAtomic(large.metaPath, meta);
  assert.equal(fs.statSync(large.metaPath).size, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
  const producer = admitRunResultProducer(large.stateDir).producer;
  fs.mkdirSync(join(large.stateDir, "evidence"));
  const formats = { recipe: ["recipe.json", "application/json"], result: ["result.json", "application/json"],
    trace: ["trace.jsonl", "application/x-ndjson"], control: ["control.json", "application/json"],
    execution: ["execution.json", "application/json"], artifacts: ["artifacts.json", "application/json"],
    sessions: ["sessions.json", "application/json"], stdout: ["stdout.log", "text/plain"], stderr: ["stderr.log", "text/plain"] };
  const changes = Object.fromEntries(Object.entries(formats).map(([role, [file, media_type]]) => {
    writeFileSync(join(large.stateDir, "evidence", file), "{}\n");
    return [role, { availability: "available", path: "evidence/" + file, media_type, bytes_total: 3,
      mutable: true, coverage: { truncated: false, history_complete: false, redacted: true } }];
  }));
  assert.throws(() => withRunProducerEvidence(large.stateDir, producer,
    () => writeRunContextIndexUnderLock(large.stateDir, meta, changes)), /bounded metadata limit/);
  assert.equal(existsSync(join(large.stateDir, "context-index.json")), false);
});

test("Context index rejects copied producer capability before creating a view or index", (t) => {
  const f = fixture(t);
  f.append();
  assert.throws(() => writeRunControlContextIndex(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  assert.equal(existsSync(f.view), false);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});


function primaryFixture(f: ReturnType<typeof fixture>, text: string, tail?: string) {
  const path = join(f.stateDir, "captures", "command-001", "attempt-001", "stdout.log");
  fs.mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text);
  const result = { code: 0, killed: false, stdout: tail ?? text, stderr: "", stdoutFile: path, stdoutBytes: Buffer.byteLength(text), ...(tail === undefined ? {} : { stdoutTruncated: true }) };
  const receipt = Object.freeze({ attempt: 1, result: Object.freeze({ ...result }), ...(tail === undefined ? {} : { stdoutSha256: createHash("sha256").update(text).digest("hex") }) });
  const publisher = createRunPrimaryTextPublisher(f.stateDir, f.producer);
  publisher.observe(result, { commandId: "command-001", attempts: [receipt], session: false });
  return { publisher, result, path, receipt };
}

test("Final executor responses publish actual bounded private text without command fallback or source repair", async t => {
  for (const [upstream, reportedKilled] of [[false, false], [true, false], [false, true]]) {
    const f = fixture(t); const secret = "response-private-token";
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: secret } }); f.producer = admitRunResultProducer(f.stateDir).producer;
    const publisher = createRunPrimaryTextPublisher(f.stateDir, f.producer);
    const response = "ACTOR ANSWER 🌍\r\n" + secret + "\n" + "界".repeat(200);
    await executeRegisteredTool({ name: "response", description: "fixture", template: { template: "launch-metadata-must-not-be-the-answer" }, args: [], defaults: {} }, {},
      async () => ({ code: 0, killed: false, stdout: response, stderr: "", ...(upstream ? { stdoutTruncated: true } : {}) }), f.root, undefined,
      { onFinalResponseSelected: publisher.selectResponse });
    const binding = publisher.snapshot(); assert.ok(binding.output);
    assert.equal(binding.output.text_basis, "actor_response"); assert.equal(binding.output.upstream_truncated, upstream);
    const { decodeRunPrimaryTextBinding } = await import("../lib/runs-outcomes.ts");
    for (const extra of [{ text_basis: "unknown" }, { text_basis: undefined, upstream_truncated: true }, { upstream_truncated: "yes" }]) {
      assert.throws(() => decodeRunPrimaryTextBinding(f.stateDir, f.producer.runInstanceId, { output: { ...binding.output, ...extra } }), /binding is invalid/);
    }
    let reads = 0;
    const accessor = Object.defineProperty({ ...binding.output }, "upstream_truncated", { get() { reads++; return true; } });
    assert.throws(() => decodeRunPrimaryTextBinding(f.stateDir, f.producer.runInstanceId, { output: accessor }), /binding is invalid/); assert.equal(reads, 0);
    const saved = readFileSync(binding.output.source.path, "utf8");
    assert.equal(saved, response.replaceAll(secret, "[REDACTED]")); assert.equal(binding.output.chars_total, [...saved].length);
    assert.equal(binding.output.source.sha256, createHash("sha256").update(saved).digest("hex"));
    assert.equal(saved.includes("launch-metadata"), false);
    assert.throws(() => publisher.selectResponse("replacement", false), /already selected/);
    publishRunResult(f.stateDir, f.producer, { code: 0, killed: reportedKilled }, { primaryText: publisher.snapshot });
    const reading = readRunPrimaryTextSource(f.stateDir, f.meta); assert.equal(reading.state, "available");
    if (reading.state === "available") assert.deepEqual(reading.output, binding.output);
  }
  const complete = fixture(t), a = primaryFixture(complete, "COMPLETE RAW OUTPUT");
  a.publisher.select(a.result); const original = a.publisher.snapshot();
  a.publisher.selectResponse("must not replace complete stdout", true); assert.deepEqual(a.publisher.snapshot(), original);
  const lost = fixture(t), p = primaryFixture(lost, "original", "tail"), damaged = createRunPrimaryTextPublisher(lost.stateDir, lost.producer);
  damaged.observe(p.result, { commandId: "command-001", attempts: [{ ...p.receipt, stdoutSha256: undefined }], session: false });
  damaged.select(p.result); const refused = damaged.snapshot();
  assert.deepEqual(refused, { output: null, output_unavailable: "complete_capture_unavailable" });
  damaged.selectResponse("must not repair refused capture", false); assert.deepEqual(damaged.snapshot(), refused);
  const empty = fixture(t), publisher = createRunPrimaryTextPublisher(empty.stateDir, empty.producer);
  publisher.selectResponse("", false); assert.deepEqual(publisher.snapshot(), { output: null, output_unavailable: "no_primary_text" });
  for (const [text, reason] of [["X".repeat(4 * 1024 * 1024 + 1), "response_too_large"], ["bad\ud800", "projection_unavailable"]] as const) {
    const bounded = fixture(t), selected = createRunPrimaryTextPublisher(bounded.stateDir, bounded.producer);
    selected.selectResponse(text, false); assert.deepEqual(selected.snapshot(), { output: null, output_unavailable: reason });
    assert.equal(existsSync(join(bounded.stateDir, "evidence")), false);
  }
  const io = fixture(t), selected = createRunPrimaryTextPublisher(io.stateDir, io.producer), originalLink = fs.linkSync;
  const fault = Object.assign(Error("response EIO"), { code: "EIO" });
  fs.linkSync = (() => { throw fault; }) as typeof fs.linkSync; syncBuiltinESMExports();
  try { selected.selectResponse("retained response", false); } finally { fs.linkSync = originalLink; syncBuiltinESMExports(); }
  assert.deepEqual(selected.snapshot(), { output: null, output_unavailable: "export_failed" });
  assert.equal((selected.readFailure() as { error: unknown }).error, fault);
  assert.throws(() => selected.selectResponse("retry", false), /already selected/);
  const stale = fixture(t), old = createRunPrimaryTextPublisher(stale.stateDir, stale.producer);
  writeJsonAtomic(stale.metaPath, { ...stale.meta, run_instance_id: "replacement" });
  assert.throws(() => old.selectResponse("stale answer", false), /generation changed/);
});

test("Primary command publication retains complete projected UTF-8 before preview and atomically joins the canonical result", t => {
  const f = fixture(t); const privatePath = join(f.root, "private-recipe.json");
  writeJsonAtomic(f.metaPath, { ...f.meta, recipe_file: privatePath }); f.producer = admitRunResultProducer(f.stateDir).producer;
  const text = "HEAD🌍\n" + "x".repeat(128 * 1024) + "\nBearer hidden-primary-token\n" + privatePath + "\nTAIL🌈";
  const p = primaryFixture(f, text);
  assert.throws(() => p.publisher.select({ ...p.result }), /exact observed/);
  p.publisher.select(p.result); const binding = p.publisher.snapshot(); assert.ok(binding.output);
  const output = binding.output; const body = readFileSync(output.source.path, "utf8");
  assert.ok(body.length > 4000); assert.ok(body.endsWith("TAIL🌈")); assert.doesNotMatch(body, /hidden-primary-token|private-recipe\.json/);
  assert.ok(body.includes("[REDACTED]")); assert.equal(output.redacted, true);
  assert.equal(output.bytes_total, Buffer.byteLength(body)); assert.equal(output.chars_total, [...body].length);
  assert.equal(output.source.sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(output.chars_shown + output.chars_omitted, output.chars_total);
  assert.equal(Buffer.from(body).subarray(output.shown_bytes.start, output.shown_bytes.end).toString("utf8"), output.preview);
  assert.equal(existsSync(join(f.stateDir, "result.json")), false, "Committed source alone is not an outcome");
  const transported = JSON.parse(JSON.stringify(binding));
  assert.equal(publishRunResult(f.stateDir, f.producer, { code: 0, output: { untrusted: "actor" } }, { primaryText: () => transported }), true);
  transported.output.preview = "later mutation";
  const saved = JSON.parse(readFileSync(join(f.stateDir, "result.json"), "utf8"));
  assert.deepEqual(saved.output, output); assert.equal(saved.terminal_acceptance, "natural"); assert.equal(saved.primary_text_protocol, "run-primary-text-v1");
  assert.equal(readFileSync(saved.output.source.path, "utf8"), body); assert.doesNotMatch(JSON.stringify(saved.output), /captures\/|hidden-primary-token|producer/);
});

test("Primary tail selection projects the complete digest-bound capture before counts/preview", t => {
  const f = fixture(t); const secret = "prefix-private.+$";
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: secret } }); f.producer = admitRunResultProducer(f.stateDir).producer;
  const text = "\uFEFFHEAD " + secret + "\n" + "x".repeat(4096) + "TAIL🌍";
  const p = primaryFixture(f, text, "TAIL🌍"); p.publisher.select(p.result); const binding = p.publisher.snapshot(); assert.ok(binding.output);
  const body = readFileSync(binding.output.source.path, "utf8");
  assert.ok(body.startsWith("\uFEFFHEAD [REDACTED]")); assert.ok(body.endsWith(p.result.stdout)); assert.equal(body.includes(secret), false);
  assert.equal(binding.output.bytes_total, Buffer.byteLength(body)); assert.equal(binding.output.chars_total, [...body].length);
  assert.equal(binding.output.source.sha256, createHash("sha256").update(body).digest("hex")); assert.notEqual(binding.output.source.sha256, p.receipt.stdoutSha256);
  publishRunResult(f.stateDir, f.producer, { code: 0 }, { primaryText: p.publisher.snapshot });
  const recovered = readRunPrimaryTextSource(f.stateDir, f.meta); assert.equal(recovered.state, "available");
  if (recovered.state === "available") assert.deepEqual(recovered.output, binding.output);
});

test("Primary tail/length agreement cannot hide prefix substitution against the privately observed stream digest", t => {
  const f = fixture(t); const p = primaryFixture(f, "A-prefix" + "x".repeat(4096) + "TAIL", "TAIL");
  writeFileSync(p.path, "B-prefix" + "x".repeat(4096) + "TAIL");
  assert.throws(() => p.publisher.select(p.result), /selected capture binding changed/);
  assert.equal(existsSync(join(f.stateDir, "result.json")), false); assert.equal(existsSync(join(f.stateDir, "evidence")), false);
});

test("Primary tail recovery refuses missing/actor-result digests, partial persistence, invalid UTF-8 and oversized bounded input", t => {
  for (const mode of ["missing", "malformed", "incomplete", "invalid_utf8", "too_large"]) {
    const f = fixture(t); const text = mode === "too_large" ? "x".repeat(4 * 1024 * 1024) + "TAIL" : "A-prefixTAIL";
    const p = primaryFixture(f, text, "TAIL"); let digest = p.receipt.stdoutSha256;
    if (mode === "invalid_utf8") { const bytes = Buffer.from(text); bytes[0] = 0xff; writeFileSync(p.path, bytes); digest = createHash("sha256").update(bytes).digest("hex"); }
    const publisher = createRunPrimaryTextPublisher(f.stateDir, f.producer);
    Object.assign(p.result, { stdoutSha256: digest }); // Actor/result metadata is not the private callback receipt.
    const receipt = { ...p.receipt, stdoutSha256: mode === "missing" ? undefined : mode === "malformed" ? digest + "\n" : digest,
      result: { ...p.receipt.result, ...(mode === "incomplete" ? { stdoutCaptureIncomplete: true as const } : {}) } };
    publisher.observe(p.result, { commandId: "command-001", attempts: [receipt], session: false }); publisher.select(p.result);
    assert.deepEqual(publisher.snapshot(), { output: null, output_unavailable: ["invalid_utf8", "too_large"].includes(mode) ? "capture_unavailable" : "complete_capture_unavailable" });
    assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  }
});

test("Primary source bytes cannot change within a generation or silently follow a new generation", t => {
  const f = fixture(t); const a = primaryFixture(f, "AA🌍"); a.publisher.select(a.result);
  const first = a.publisher.snapshot(); assert.ok(first.output);
  a.publisher.select(a.result); assert.deepEqual(a.publisher.snapshot(), first);
  const b = primaryFixture(f, "BB🌍");
  assert.throws(() => b.publisher.select(b.result), /different bytes/);
  assert.equal(readFileSync(first.output.source.path, "utf8"), "AA🌍");
  writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
  assert.throws(() => createRunPrimaryTextPublisher(f.stateDir, f.producer), /generation changed/);
  const next = admitRunResultProducer(f.stateDir).producer;
  const publisher = createRunPrimaryTextPublisher(f.stateDir, next);
  publisher.observe(b.result, { commandId: "command-001", attempts: [{ attempt: 1, result: b.result }], session: false });
  publisher.select(b.result); const replacement = publisher.snapshot(); assert.ok(replacement.output);
  assert.notEqual(replacement.output.source.path, first.output.source.path);
  assert.equal(readFileSync(first.output.source.path, "utf8"), "AA🌍");
});

test("Primary export EIO is explicit unavailability without an invented command failure; admission refusal remains exact", async t => {
  const f = fixture(t); const p = primaryFixture(f, "complete");
  const link = fs.linkSync; const unlink = fs.unlinkSync; const injected = Object.assign(new Error("injected export EIO"), { code: "EIO" });
  const cleanup = Object.assign(new Error("injected temp cleanup EIO"), { code: "EIO" });
  fs.unlinkSync = ((path, ...args) => { if (String(path).includes(".primary-")) throw cleanup; return Reflect.apply(unlink, fs, [path, ...args]); }) as typeof fs.unlinkSync;
  fs.linkSync = (() => { throw injected; }) as typeof fs.linkSync; syncBuiltinESMExports();
  try {
    const result = await executeRegisteredTool({ name: "primary", description: "fixture", template: "fixture", args: [], defaults: {} }, {},
      async () => p.result, f.root, undefined, { onPrimaryCommandSelected: p.publisher.select });
    assert.equal(result.details.code, 0);
  } finally { fs.linkSync = link; fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.deepEqual(p.publisher.snapshot(), { output: null, output_unavailable: "export_failed" });
  assert.equal((p.publisher.readFailure() as { error: unknown }).error, injected);
  assert.equal((p.publisher.readFailure() as { cleanup_error: unknown }).cleanup_error, cleanup);
  publishRunResult(f.stateDir, f.producer, { code: 0 }, { primaryText: p.publisher.snapshot });
  assert.equal(view(join(f.stateDir, "result.json")).code, 0);
  writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "replacement" });
  assert.throws(() => p.publisher.select(p.result), /generation changed/);
});

test("Primary publication refuses incomplete/invalid UTF-8 input and a copied producer without exposing a raw source", t => {
  const f = fixture(t);
  assert.throws(() => createRunPrimaryTextPublisher(f.stateDir, { ...f.producer }), /admitted/);
  const empty = primaryFixture(f, ""); empty.publisher.select(empty.result);
  assert.deepEqual(empty.publisher.snapshot(), { output: null, output_unavailable: "no_primary_text" });
  const p = primaryFixture(f, "\uFFFD");
  writeFileSync(p.path, Buffer.from([0xff])); p.publisher.select(p.result);
  assert.deepEqual(p.publisher.snapshot(), { output: null, output_unavailable: "capture_unavailable" });
});


test("Primary privacy stays bound to immutable admission metadata, not mutated caller data or live same-generation metadata", t => {
  const f = fixture(t); const originalPath = join(f.root, "original-private-recipe.json"); const secret = "private.+$[x]";
  writeJsonAtomic(f.metaPath, { ...f.meta, recipe_file: originalPath, values: { api_key: secret } });
  const capture = admitRunResultProducer(f.stateDir); f.producer = capture.producer;
  (capture.meta.values as Record<string, unknown>).api_key = "caller-mutated";
  writeJsonAtomic(f.metaPath, { ...f.meta, recipe_file: join(f.root, "new-recipe.json"), values: { api_key: "live-mutated" } });
  const p = primaryFixture(f, originalPath + "\n" + secret + "\nvisible"); p.publisher.select(p.result);
  const binding = p.publisher.snapshot(); assert.ok(binding.output);
  const body = readFileSync(binding.output.source.path, "utf8");
  assert.equal(body.includes(originalPath), false); assert.equal(body.includes(secret), false);
  assert.ok(body.endsWith("visible")); assert.ok(body.includes("[REDACTED]"));
});


test("Primary export I/O cannot downgrade concurrent generation-binding loss into ordinary unavailability", t => {
  const f = fixture(t); const p = primaryFixture(f, "complete"); const link = fs.linkSync;
  const injected = Object.assign(Error("export raced with generation replacement"), { code: "EIO" });
  fs.linkSync = (() => { writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "replacement" }); throw injected; }) as typeof fs.linkSync; syncBuiltinESMExports();
  try { assert.throws(() => p.publisher.select(p.result), /binding changed during export failure/); }
  finally { fs.linkSync = link; syncBuiltinESMExports(); }
  assert.equal((p.publisher.readFailure() as { error: unknown }).error, injected);
  assert.equal(existsSync(join(f.stateDir, "result.json")), false);
});


test("Primary JSON privacy preserves original key/origin decisions or withholds the whole ambiguous raw quote scalar", t => {
  for (const secret of ["captured-body-secret75", '"']) {
    const f = fixture(t); const originalPath = join(f.root, 'private"source.json');
    writeJsonAtomic(f.metaPath, { ...f.meta, recipe_file: originalPath, values: { api_key: secret } });
    f.producer = admitRunResultProducer(f.stateDir).producer;
    const p = primaryFixture(f, JSON.stringify({ password: "body-only-secret", path: originalPath, note: secret }));
    p.publisher.select(p.result); const binding = p.publisher.snapshot(); assert.ok(binding.output);
    const body = readFileSync(binding.output.source.path, "utf8");
    assert.equal(body.includes("body-only-secret"), false);
    if (secret === '"') { assert.equal(body, "[REDACTED]"); continue; }
    const projected = JSON.parse(body); assert.equal(projected.password, "[REDACTED]");
    assert.equal(projected.path, "[PRIVATE_RECIPE_ORIGIN]"); assert.equal(projected.note, "[REDACTED]");
  }
});


function admittedPrimary(t: TestContext, text = "\uFEFFHEAD🌍\n" + "x".repeat(96 * 1024) + "\nTAIL🌈") {
  const f = fixture(t); const p = primaryFixture(f, text); p.publisher.select(p.result);
  const binding = p.publisher.snapshot(); assert.ok(binding.output);
  publishRunResult(f.stateDir, f.producer, { code: 0 }, { primaryText: p.publisher.snapshot });
  const expected = { run: f.meta.run, run_instance_id: f.meta.run_instance_id, ownerId: f.meta.ownerId };
  const resultPath = join(f.stateDir, "result.json");
  return { ...f, ...p, output: binding.output, expected, resultPath, read: (query?: unknown) => readRunPrimaryTextSource(f.stateDir, expected, query) };
}

test("Completion text selects up to48KiB from the original admitted source observation without changing recorded previews or authority", t => {
  for (const size of [48 * 1024 - 1, 48 * 1024, 48 * 1024 + 1]) {
    const f = admittedPrimary(t, "x".repeat(size)), original = f.read();
    let opens = 0; const open = fs.openSync;
    fs.openSync = ((path, ...args) => { if (path === f.output.source.path) opens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
    syncBuiltinESMExports();
    let selected;
    try { selected = readRunCompletionTextSource(f.stateDir, f.expected); } finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.equal(opens, 1); assert.equal(selected.state, "available");
    if (selected.state !== "available") throw Error("No completion source");
    assert.equal(selected.output.preview.length, Math.min(size, 48 * 1024));
    assert.deepEqual(selected.original_output, f.output); assert.equal(selected.unchanged(), true);
    const recorded = f.read(); assert.equal(recorded.state, original.state);
    assert.equal(recorded.state, "available"); if (recorded.state === "available") assert.deepEqual(recorded.output, f.output);
    assert.equal(readRunCompletionTextSource(f.stateDir, { ...f.expected, run_instance_id: "foreign" }).state, "unavailable");
    const changed = view(f.resultPath); delete changed.output; writeJsonAtomic(f.resultPath, changed);
    assert.equal(readRunCompletionTextSource(f.stateDir, f.expected).state, "unavailable");
  }
  for (const text of ['"'.repeat(32 * 1024), "\n".repeat(48 * 1024 - 1) + "X"]) {
    const f = admittedPrimary(t, text), selected = readRunCompletionTextSource(f.stateDir, f.expected);
    assert.equal(selected.state, "available", "Private completion transport allows escaping overhead without widening the public view");
    if (selected.state === "available") assert.equal(selected.output.preview, text);
    assert.deepEqual(f.read({ start: 0, end: Buffer.byteLength(text) }), { state: "unavailable", reason: "range_too_large" });
  }
  const privateCase = fixture(t, meta => { meta.values = { api_key: "DEEP_COMPLETION_SECRET" }; });
  const p = primaryFixture(privateCase, "safe ".repeat(2000) + "DEEP_COMPLETION_SECRET"); p.publisher.select(p.result);
  publishRunResult(privateCase.stateDir, privateCase.producer, { code: 0 }, { primaryText: p.publisher.snapshot });
  const projected = readRunCompletionTextSource(privateCase.stateDir, privateCase.meta);
  assert.equal(projected.state, "available"); if (projected.state !== "available") throw Error("No projected source");
  assert.match(projected.output.preview, /\[REDACTED\]/); assert.doesNotMatch(projected.output.preview, /DEEP_COMPLETION_SECRET/);
  assert.equal(projected.output.chars_total, [...projected.output.preview].length);
  for (const text of ["x".repeat(48 * 1024 - 1) + "\r\nTAIL", "x".repeat(48 * 1024 - 2) + "🚀TAIL"]) {
    const f = admittedPrimary(t, text), selected = readRunCompletionTextSource(f.stateDir, f.expected);
    assert.equal(selected.state, "available"); if (selected.state !== "available") throw Error("No completion source");
    assert.ok(text.startsWith(selected.output.preview)); assert.equal(selected.output.preview.endsWith("\r"), false);
    assert.equal(Buffer.from(selected.output.preview).toString("utf8"), selected.output.preview);
    assert.deepEqual(selected.original_output, f.output);
  }
});

test("Primary source recovery is readonly, capability-free, bounded and independent of raw captures, indexes and live privacy", t => {
  const f = admittedPrimary(t); const source = readFileSync(f.output.source.path);
  fs.rmSync(join(f.stateDir, "captures"), { recursive: true });
  writeFileSync(join(f.stateDir, "stop-claim.json"), "{late malformed stop");
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { secret: "HEAD" }, recipe_file: "/new/live/private-recipe" });
  const before = [f.metaPath, f.resultPath, f.output.source.path].map(path => readFileSync(path));
  const write = fs.writeFileSync; const mkdir = fs.mkdirSync; const kill = process.kill;
  fs.writeFileSync = (() => assert.fail("Readonly source read wrote evidence")) as typeof fs.writeFileSync;
  fs.mkdirSync = (() => assert.fail("Readonly source read acquired lifecycle/work authority")) as typeof fs.mkdirSync;
  process.kill = (() => assert.fail("Readonly source recovery probed a process")) as typeof process.kill; syncBuiltinESMExports();
  try {
    const read = f.read(); assert.equal(read.state, "available");
    if (read.state !== "available") return;
    assert.equal(read.result_acceptance, "natural"); assert.equal(read.selection, "recorded_preview"); assert.deepEqual(read.output, f.output);
    assert.equal(Object.isFrozen(read.output.source), true); assert.equal(read.unchanged(), true);
    let assembled = ""; let start = 0;
    while (start < source.length) {
      let end = Math.min(start + 8192, source.length); while (end < source.length && (source[end]! & 0xc0) === 0x80) end--;
      const page = f.read({ start, end }); assert.equal(page.state, "available");
      if (page.state !== "available") return;
      assert.equal(page.selection, "byte_range"); assert.equal(page.output.chars_shown + page.output.chars_omitted, page.output.chars_total);
      assembled += page.output.preview; start = end;
    }
    assert.equal(assembled, source.toString("utf8"));
  } finally { fs.writeFileSync = write; fs.mkdirSync = mkdir; process.kill = kill; syncBuiltinESMExports(); }
  assert.deepEqual([f.metaPath, f.resultPath, f.output.source.path].map(path => readFileSync(path)), before);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Primary source admission rejects orphan/legacy/foreign/reference-only facts without opening a body", t => {
  const f = admittedPrimary(t, "authorized");
  const original = view(f.resultPath); const sibling = join(f.stateDir, "evidence", `primary-${"f".repeat(64)}.txt`); writeFileSync(sibling, "authorized");
  const open = fs.openSync; let bodies = 0;
  fs.openSync = ((path, ...args) => { if (String(path).includes("primary-") || String(path).includes("captures")) bodies++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try {
    for (const result of [undefined, { ...original, primary_text_protocol: undefined }, { ...original, terminal_acceptance: "unknown" },
      { ...original, run_instance_id: "foreign" }, { ...original, output: { ...original.output, source: { ...original.output.source, path: f.path } } },
      { ...original, output: { ...original.output, source: { ...original.output.source, path: sibling } } }]) {
      if (result) writeJsonAtomic(f.resultPath, result); else fs.unlinkSync(f.resultPath);
      assert.equal(f.read().state, "unavailable");
    }
    writeJsonAtomic(f.resultPath, original);
    assert.equal(readRunPrimaryTextSource(f.stateDir, { ...f.expected, ownerId: "foreign" }).state, "unavailable");
    assert.equal(readRunPrimaryTextSource(f.stateDir, { ...f.expected, run_instance_id: "foreign" }).state, "unavailable");
    for (const meta of [{ ...f.meta, outcome_protocol: undefined }, { ...f.meta, pid: 0 }]) {
      writeJsonAtomic(f.metaPath, meta); assert.equal(f.read().state, "unavailable");
    }
    writeJsonAtomic(f.metaPath, f.meta);
    let gets = 0; const malformed = Object.defineProperty({}, "run", { get() { gets++; return f.meta.run; } });
    assert.equal(readRunPrimaryTextSource(f.stateDir, malformed).state, "unavailable"); assert.equal(gets, 0);
    writeJsonAtomic(join(f.stateDir, "context-index.json"), { visible: true, path: f.output.source.path });
    publishRunResult(f.stateDir, f.producer, { code: 0, output: original.output }); // Existing winner is not repaired.
    fs.unlinkSync(f.resultPath); assert.equal(f.read().state, "unavailable");
    assert.equal(bodies, 0);
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
});

test("Primary byte ranges preserve BOM/scalars and exact counts, reject split/empty-interior ranges and bound encoded output", t => {
  const f = admittedPrimary(t, "\uFEFF🌍\uFFFDtail");
  const prefix = f.read({ start: 0, end: 7 }); assert.equal(prefix.state, "available");
  if (prefix.state !== "available") return;
  assert.equal(prefix.output.preview, "\uFEFF🌍"); assert.equal(prefix.output.chars_shown, 2);
  const empty = f.read({ start: 7, end: 7 }); assert.equal(empty.state, "available");
  if (empty.state === "available") { assert.equal(empty.output.preview, ""); assert.equal(empty.output.chars_omitted, empty.output.chars_total); }
  for (const query of [{ start: 1, end: 1 }, { start: 0, end: 4 }, { start: 8, end: 9 }, { start: 0, end: 1000 }]) {
    assert.deepEqual(f.read(query), { state: "unavailable", reason: "range_invalid" });
  }
  let gets = 0; const bad = Object.defineProperty({}, "start", { get() { gets++; return 0; } });
  assert.equal(f.read(bad).state, "unavailable"); assert.equal(gets, 0);
  for (const query of [null, { start: -1, end: 0 }, { start: 0.5, end: 1 }, { start: 0, end: 1, path: f.path }]) assert.equal(f.read(query).state, "unavailable");
  const large = admittedPrimary(t, "\u0000".repeat(64 * 1024));
  assert.deepEqual(large.read({ start: 0, end: 64 * 1024 }), { state: "unavailable", reason: "range_too_large" });
});

test("Primary source loss, equal-length replacement, forged counts/preview and foreign generation never substitute bytes", t => {
  const f = admittedPrimary(t, "AA🌍" + "x".repeat(200) + "TAIL"); const body = readFileSync(f.output.source.path); const original = view(f.resultPath);
  writeFileSync(f.output.source.path, Buffer.concat([body.subarray(0, body.length - 1), Buffer.from("X")]));
  assert.deepEqual(f.read(), { state: "unavailable", reason: "source_invalid" });
  writeFileSync(f.output.source.path, body);
  for (const output of [{ ...original.output, chars_total: original.output.chars_total + 1, chars_omitted: original.output.chars_omitted + 1 },
    { ...original.output, preview: "BB" + original.output.preview.slice(2) }]) {
    writeJsonAtomic(f.resultPath, { ...original, output }); assert.equal(f.read().state, "unavailable");
  }
  writeJsonAtomic(f.resultPath, original);
  const read = f.read(); assert.equal(read.state, "available");
  fs.unlinkSync(f.output.source.path); if (read.state === "available") assert.equal(read.unchanged(), false);
  assert.equal(f.read().state, "unavailable"); assert.equal(existsSync(f.output.source.path), false);
  writeFileSync(f.output.source.path, body);
  writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); assert.equal(f.read().state, "unavailable");
});

test("Primary readers preserve explicit unavailable bindings and capture-only classification before/after a stop claim", t => {
  const absent = fixture(t);
  publishRunResult(absent.stateDir, absent.producer, { code: 0 }, { primaryText: () => ({ output: null, output_unavailable: "export_failed" }) });
  assert.deepEqual(readRunPrimaryTextSource(absent.stateDir, absent.meta), { state: "unavailable", reason: "output_unavailable", output_unavailable: "export_failed" });
  for (const when of ["before", "after"]) {
    const f = fixture(t); const p = primaryFixture(f, "captured source");
    if (when === "before") p.publisher.select(p.result);
    const claim = claimRunStop(f.stateDir, { ownerId: f.meta.ownerId, runInstanceId: f.meta.run_instance_id, reason: "manual_kill" }, {
      verifyIdentity: () => ({ status: "valid", valid: true, alive: true }), runtimePlatform: "linux",
      killProcess: () => assert.fail("Read/source admission must never signal"),
    });
    assert.equal(claim.status, "stop_requested");
    if (when === "after") p.publisher.select(p.result);
    publishRunResult(f.stateDir, f.producer, { code: 0 }, { primaryText: p.publisher.snapshot });
    const read = readRunPrimaryTextSource(f.stateDir, f.meta); assert.equal(read.state, "available");
    if (read.state === "available") assert.equal(read.result_acceptance, "capture_only");
  }
});


test("Primary completion observation uses the admitted source, then replays its immutable packet without live-source reads", async t => {
  const sourceText = " \r\n\uFEFF🌍```` exact  \n" + "x".repeat(4096);
  const f = admittedPrimary(t, sourceText);
  writeFileSync(join(f.stateDir, "stdout.log"), "RAW-RUNNER-FALLBACK-MUST-NOT-LEAK");
  const { summarizeRuns, detectRunTransitions, collectRunCompletionBatchMembers, hasRunCompletionBatchMembers } = await import("../lib/observability.ts");
  const { admitRunCompletionBatch, readRunDeliveryJournal, formatRunCompletionBatchMessage } = await import("../lib/run-delivery.ts");
  const open = fs.openSync; let sourceOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === join(f.stateDir, "stdout.log")) assert.fail("Primary observation read formatted runner stdout"); if (String(path) === f.output.source.path) sourceOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  let members;
  try {
    const summary = summarizeRuns(f.root, f.meta.ownerId);
    assert.equal(sourceOpens, 0, "Ambient observation must not read complete primary bodies");
    const transitions = detectRunTransitions(new Map([[f.stateDir, "running"]]), summary);
    assert.equal(hasRunCompletionBatchMembers(transitions, summary.runs), true);
    assert.equal(sourceOpens, 0, "Candidate checks must not read complete primary bodies");
    members = collectRunCompletionBatchMembers(transitions, summary.runs);
    assert.equal(members.length, 1); assert.deepEqual(members[0].primary_text, { output: f.output }); assert.equal(members[0].output, undefined);
    assert.ok(sourceOpens > 0, "Packet admission must actually verify retained source bytes");
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
  const packet = admitRunCompletionBatch({ members, ownerId: f.meta.ownerId, tempDir: f.root });
  const message = formatRunCompletionBatchMessage(packet);
  fs.unlinkSync(f.output.source.path);
  assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(f.root, f.meta.ownerId).completion_batch!), message);
  assert.ok(message.includes(sourceText), "Fresh completion preserves the entire fitting source without outer indentation"); assert.doesNotMatch(message, /RAW-RUNNER-FALLBACK/);
  assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false, "Packet admission is not delivery acceptance");
});

test("Primary completion source loss stays explicit without root-stdout substitution; unsupported displays remain labeled diagnostics", async t => {
  const { summarizeRuns, detectRunTransitions, collectRunCompletionBatchMembers } = await import("../lib/observability.ts");
  const { formatRunCompletionBatchMessage } = await import("../lib/run-delivery.ts");
  for (const mode of ["lost", "unsupported"]) {
    const f = mode === "lost" ? admittedPrimary(t, "authorized") : fixture(t);
    const raw = mode === "lost" ? "FORBIDDEN-RAW-FALLBACK" : "existing session answer";
    writeFileSync(join(f.stateDir, "stdout.log"), raw);
    if (mode === "lost") fs.unlinkSync((f as ReturnType<typeof admittedPrimary>).output.source.path);
    else publishRunResult(f.stateDir, f.producer, { code: 0 }, { primaryText: () => ({ output: null, output_unavailable: "not_selected" }) });
    const canonical = readFileSync(join(f.stateDir, "result.json"));
    const summary = summarizeRuns(f.root, f.meta.ownerId);
    const members = collectRunCompletionBatchMembers(detectRunTransitions(new Map([[f.stateDir, "running"]]), summary), summary.runs);
    assert.equal(members.length, 1); assert.equal(members[0].primary_text?.output, null);
    const message = formatRunCompletionBatchMessage({ members, batch_id: "source-view", created_at: new Date().toISOString(), phase: "pending" });
    if (mode === "lost") { assert.equal(members[0].output, undefined); assert.doesNotMatch(message, /FORBIDDEN-RAW-FALLBACK/); assert.match(message, /source_unavailable/); }
    else { assert.equal(members[0].output, raw); assert.match(message, /Legacy diagnostic display \(not a complete primary source\)/); }
    assert.deepEqual(readFileSync(join(f.stateDir, "result.json")), canonical);
  }
});

test("Primary body reads refuse partial/failed-close/changed canonical observations and retain no descriptors or file writes", t => {
  for (const mode of ["early_eof", "close_error", "canonical_replaced"]) {
    const f = admittedPrimary(t, "complete🌍source"); assert.equal(f.read().state, "available");
    const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const files = new Map<number, string>(); const flags: unknown[] = [];
    let injected = false;
    fs.openSync = ((path, flag, ...args) => { const fd = Reflect.apply(open, fs, [path, flag, ...args]); files.set(fd, String(path)); flags.push(flag); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => {
      const source = files.get(fd) === f.output.source.path;
      if (source && mode === "early_eof") { injected = true; return 0; }
      const count = Reflect.apply(read, fs, [fd, ...args]);
      if (source && mode === "canonical_replaced" && !injected) { injected = true; writeJsonAtomic(f.resultPath, { ...view(f.resultPath), diagnostic: "foreign replacement" }); }
      return count;
    }) as typeof fs.readSync;
    fs.closeSync = ((fd) => {
      const source = files.get(fd) === f.output.source.path; files.delete(fd); close(fd);
      if (source && mode === "close_error") { injected = true; throw Object.assign(Error("close unproven"), {code:"EIO"}); }
    }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.equal(f.read().state, "unavailable"); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(injected, true); assert.equal(files.size, 0);
    assert.ok(flags.every(flag => typeof flag === "number"));
    for (const flag of [fs.constants.O_NONBLOCK, fs.constants.O_NOFOLLOW]) if (flag) assert.ok(flags.every(mode => (Number(mode) & flag) === flag));
  }
});


});

await describe("Artifact declarations", { concurrency: false }, async () => {
/** Declared artifact reference manifest: no body reads, no file-content quota, no production receipt. */

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-artifact-export-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});
const { writeRunArtifactContextExport, writeRunArtifactContextIndex, writeRunResultContextIndex, readRunArtifactInventorySource, prepareRunArtifactInventoryPublication, readRunResultArtifactInventory,
  RUN_CONTEXT_ARTIFACT_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult, withRunWorkAdmission } = await import("../lib/runs-results.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { readRunContextIndex, runContextExportPath } = await import("../lib/runs-context-index.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");

function fixture(t: TestContext) {
  const root = mkdtempSync(join(agentDir, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "work"); fs.mkdirSync(cwd);
  const stateDir = claimRunStateDirectory(join(root, "state"), "artifact-view");
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
  const meta = { run: "artifact-view", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, cwd,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: readProcessIdentity(process.pid),
    outcome_protocol: RUN_OUTCOME_PROTOCOL };
  const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const path = join(stateDir, runContextExportPath("artifacts"));
  const declare = (artifacts: unknown) => writeJsonAtomic(metaPath, { ...meta, artifacts });
  return { root, cwd, stateDir, meta, metaPath, producer, path, declare,
    publish: () => writeRunArtifactContextExport(stateDir, producer),
    publishIndex: () => writeRunArtifactContextIndex(stateDir, producer) };
}
function body(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test("Artifact export retains every declared reference without reading bodies or claiming creation/hash/immutability", t => {
  const f = fixture(t);
  const large = join(f.cwd, "large.bin"); writeFileSync(large, ""); fs.truncateSync(large, 512 * 1024 * 1024);
  f.declare({ large: { path: "large.bin", media_type: "application/octet-stream", required: true }, missing: "missing.txt" });
  const before = readFileSync(f.metaPath);
  const open = fs.openSync; const close = fs.closeSync; const read = fs.readSync; const readFile = fs.readFileSync;
  const fds = new Set<number>(); let bodyReads = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === large) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) { bodyReads++; throw new Error("Artifact body forbidden"); } return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { if (String(path) === large) { bodyReads++; throw new Error("Artifact body forbidden"); } return Reflect.apply(readFile, fs, [path, ...args]); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { assert.equal(f.publish().status, "written"); }
  finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; fs.readFileSync = readFile; syncBuiltinESMExports(); }
  const value = body(f.path);
  assert.equal(value.schema, "run-context-artifacts-v1");
  assert.equal(value.content_scope, "captured_artifact_references");
  assert.equal(value.contents, "not_read");
  assert.equal(value.production_provenance, "not_asserted");
  assert.deepEqual(value.coverage, { truncated: false, redacted: true });
  assert.deepEqual(value.summary, { declared: 2, available: 1, missing: 1, unavailable: 0 });
  assert.equal(value.artifacts[0].path, large);
  assert.equal(value.artifacts[0].bytes_total, 512 * 1024 * 1024);
  assert.equal(value.artifacts[1].availability, "missing");
  assert.equal(Object.hasOwn(value.artifacts[0], "sha256"), false);
  assert.equal(bodyReads, 0); assert.equal(fds.size, 0);
  assert.deepEqual(readFileSync(f.metaPath), before);
});

test("No captured declarations is not-applicable, while malformed declarations are unavailable rather than empty", t => {
  const f = fixture(t);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "artifact_declarations_absent" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  f.publishIndex();
  assert.deepEqual(body(join(f.stateDir, "context-index.json")).entries.artifacts, { availability: "not_applicable", path: null });
  for (const declarations of [null, [], { bad: { path: "x", required: "true" } }, { bad: { path: "x", sha256: "forged" } }]) {
    f.declare(declarations);
    assert.deepEqual(f.publish(), { status: "unavailable", reason: "artifact_declarations_invalid" });
    assert.equal(existsSync(f.path), false);
  }
});

test("Explicit declared output paths remain usable operational references even beneath a captured Recipe directory", t => {
  const f = fixture(t); const path = join(f.cwd, "output.txt"); writeFileSync(path, "declared output");
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: f.cwd, recipe_dir: f.cwd }, artifacts: { report: path } });
  assert.equal(f.publish().status, "written");
  const reference = body(f.path).artifacts[0];
  assert.equal(reference.availability, "available");
  assert.equal(reference.path, path);
  assert.equal(readFileSync(reference.path, "utf8"), "declared output");
});

test("Artifact privacy never advertises a redacted path as a usable reference", t => {
  const f = fixture(t);
  const sensitive = join(f.cwd, "token=HIDDEN_PATH.bin"); writeFileSync(sensitive, "private");
  f.declare({ "token=HIDDEN_NAME": { path: sensitive, kind: "secret=HIDDEN_KIND" } });
  assert.equal(f.publish().status, "written");
  const value = body(f.path);
  assert.equal(value.artifacts[0].availability, "unavailable");
  assert.equal(value.artifacts[0].path, null);
  assert.equal(value.artifacts[0].reason, "artifact_reference_redacted");
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /HIDDEN_PATH|HIDDEN_NAME|HIDDEN_KIND/);
  assert.equal(readFileSync(sensitive, "utf8"), "private");
});

test("Large artifact inventories fail explicitly without partial manifests or filesystem probing after preflight overflow", t => {
  const f = fixture(t); f.declare({ one: "missing.txt" }); f.publish();
  const before = readFileSync(f.path);
  f.declare(Object.fromEntries(Array.from({ length: 1800 }, (_, i) => ["artifact-" + i, "missing-" + i + ".bin"])));
  const lstat = fs.lstatSync; let probes = 0;
  fs.lstatSync = ((path, ...args) => { if (String(path).startsWith(f.cwd + "/")) probes++; return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "artifact_manifest_too_large" }); }
  finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.equal(probes, 0);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(f.publishIndex().status, "published");
  assert.deepEqual(body(join(f.stateDir, "context-index.json")).entries.artifacts,
    { availability: "unavailable", path: null, reason: "artifact_manifest_too_large" });
});

test("Admission-bound artifact overflow retains every declaration behind a bounded indexed reference without artifact probes", t => {
  const f = fixture(t); const declarations = Object.fromEntries(Array.from({ length: 1800 }, (_, i) => [`item-${i}`, `output-${i}.bin`]));
  declarations["item-0"] = "link/../large.bin";
  f.declare(declarations); const producer = admitRunResultProducer(f.stateDir).producer;
  const lstat = fs.lstatSync; const open = fs.openSync; let probes = 0;
  const check = (path: unknown) => { if (String(path).startsWith(f.cwd + sep)) { probes++; throw Error("Artifact probing forbidden"); } };
  fs.lstatSync = ((path, ...args) => { check(path); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
  fs.openSync = ((path, ...args) => { check(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { assert.equal(writeRunArtifactContextIndex(f.stateDir, producer).status, "published"); }
  finally { fs.lstatSync = lstat; fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(probes, 0); const view = body(f.path); const reference = view.inventory;
  assert.equal(view.content_scope, "captured_artifact_inventory_reference"); assert.deepEqual(view.coverage, { truncated: true, redacted: true });
  assert.deepEqual(view.artifacts, []); assert.equal(view.artifacts_shown, 0); assert.equal(view.artifacts_omitted, 1800);
  assert.equal(reference.source.run_instance_id, f.meta.run_instance_id); assert.ok(readFileSync(f.path).length <= RUN_CONTEXT_ARTIFACT_MAX_BYTES);
  const bytes = readFileSync(reference.source.path); assert.ok(bytes.length > RUN_CONTEXT_ARTIFACT_MAX_BYTES); assert.equal(bytes.length, reference.bytes_total);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.source.sha256);
  const inventory = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.equal(inventory.schema, "run-artifact-inventory-v1"); assert.equal(inventory.inventory_complete, true);
  assert.equal(inventory.capture_scope, "producer_admission"); assert.equal(inventory.contents, "not_read");
  assert.equal(inventory.production_provenance, "not_asserted"); assert.equal(inventory.availability, "not_observed");
  assert.equal(inventory.artifacts.length, 1800); assert.equal(inventory.artifacts[0].path, f.cwd + sep + "link/../large.bin");
  assert.deepEqual(inventory.artifacts.map((entry: { name: string }) => entry.name), Object.keys(declarations));
  assert.deepEqual(inventory.summary, { declared: 1800, references_disclosed: 1800, references_withheld: 0 });
  assert.equal(inventory.artifacts.every((item: { availability: string }) => item.availability === "not_observed"), true);
  const index = readRunContextIndex(f.stateDir, f.meta); assert.equal(index.state, "available");
  if (index.state === "available") { const entry = index.index.entries.artifacts; assert.equal(entry.availability, "available"); if (entry.availability === "available") assert.equal(entry.coverage.truncated, true); }
  writeRunArtifactContextIndex(f.stateDir, producer); assert.deepEqual(readFileSync(reference.source.path), bytes);
});

test("Artifact overflow privacy is fixed at admission, preserves operational origin paths, and never widens after metadata refresh", t => {
  const f = fixture(t); const secret = "unlabelled-private.+[x]";
  const declarations = { ...Object.fromEntries(Array.from({ length: 1800 }, (_, i) => [`item-${i}`, `output-${i}.bin`])), private: secret + ".bin", operational: "report.bin" };
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: secret, skill_dir: f.cwd }, artifacts: declarations });
  const producer = admitRunResultProducer(f.stateDir).producer;
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: "new-secret", skill_dir: f.cwd }, artifacts: declarations });
  assert.equal(writeRunArtifactContextExport(f.stateDir, producer).status, "written");
  const view = body(f.path); const source = readFileSync(view.inventory.source.path, "utf8"); const inventory = JSON.parse(source);
  assert.doesNotMatch(source, /unlabelled-private/);
  const privateEntry = inventory.artifacts.find((item: { name: string }) => item.name === "private");
  assert.equal(privateEntry.path, null); assert.equal(privateEntry.reason, "artifact_reference_redacted");
  assert.equal(inventory.artifacts.find((item: { name: string }) => item.name === "operational").path, f.cwd + sep + "report.bin");
  assert.equal(inventory.summary.references_withheld, 1);
  writeRunArtifactContextIndex(f.stateDir, producer);
  const reading = readRunArtifactInventorySource(f.stateDir, f.meta, { start: 1800, end: 1802 }); assert.equal(reading.state, "available");
  if (reading.state === "available") { assert.equal(reading.artifacts[0]!.path, null); assert.equal(reading.summary.references_withheld, 1); assert.doesNotMatch(JSON.stringify(reading), /unlabelled-private/); }
  const before = readFileSync(f.path); f.declare({ ...declarations, extra: "new-output.bin" });
  assert.deepEqual(writeRunArtifactContextExport(f.stateDir, producer), { status: "unavailable", reason: "artifact_manifest_too_large" });
  assert.deepEqual(readFileSync(f.path), before); assert.equal(readFileSync(view.inventory.source.path, "utf8"), source);
  const refreshed = admitRunResultProducer(f.stateDir).producer;
  assert.throws(() => writeRunArtifactContextExport(f.stateDir, refreshed), /identity already fixes different bytes/);
  assert.equal(readFileSync(view.inventory.source.path, "utf8"), source);
});

test("Artifact inventory source and bounded view failures preserve exact errors, partial effects and accepted root outcome", t => {
  for (const effect of ["source", "view"]) {
    const f = fixture(t); f.declare(Object.fromEntries(Array.from({ length: 1800 }, (_, i) => [`item-${i}`, `output-${i}.bin`])));
    const producer = admitRunResultProducer(f.stateDir).producer; publishRunResult(f.stateDir, producer, { code: 0 });
    const outcome = readFileSync(join(f.stateDir, "result.json")); const write = fs.writeFileSync; const rename = fs.renameSync;
    const primary = Object.assign(new Error(`injected artifact ${effect} EIO`), { code: "EIO" }); let path = "";
    fs.writeFileSync = ((target, ...args) => {
      if (typeof target === "string" && /^artifact-inventory-[a-f0-9]{64}\.json$/.test(basename(target))) {
        path = target; if (effect === "source") { write(target, "partial", { flag: "wx" }); throw primary; }
      }
      return Reflect.apply(write, fs, [target, ...args]);
    }) as typeof fs.writeFileSync;
    fs.renameSync = ((from, to) => { const result = rename(from, to); if (effect === "view" && String(to) === f.path) throw primary; return result; }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.throws(() => writeRunArtifactContextIndex(f.stateDir, producer), error => error === primary); }
    finally { fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.ok(path); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
    assert.deepEqual(readFileSync(join(f.stateDir, "result.json")), outcome);
    if (effect === "source") {
      assert.equal(readFileSync(path, "utf8"), "partial"); assert.equal(existsSync(f.path), false);
      assert.throws(() => writeRunArtifactContextExport(f.stateDir, producer), /identity already fixes different bytes/);
      assert.equal(readFileSync(path, "utf8"), "partial");
    } else {
      const view = body(f.path); assert.equal(view.inventory.source.path, path);
      assert.equal(body(path).artifacts.length, 1800); assert.equal(writeRunArtifactContextIndex(f.stateDir, producer).status, "published");
    }
  }
});

test("Artifact inventory source limits refuse the whole observation without becoming a declaration or workload quota", t => {
  const f = fixture(t); const cwd = join(f.cwd, "long-" + "x".repeat(3000));
  writeJsonAtomic(f.metaPath, { ...f.meta, cwd, artifacts: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`item-${i}`, `o-${i}`])) });
  const producer = admitRunResultProducer(f.stateDir).producer; const before = readFileSync(f.metaPath);
  assert.deepEqual(writeRunArtifactContextExport(f.stateDir, producer), { status: "unavailable", reason: "artifact_manifest_too_large" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false); assert.deepEqual(readFileSync(f.metaPath), before);
});

test("Artifact inventory replacement during retention leaves only an unpublished source, never a view or index", t => {
  const f = fixture(t); f.declare(Object.fromEntries(Array.from({ length: 1800 }, (_, i) => [`item-${i}`, `output-${i}.bin`])));
  const producer = admitRunResultProducer(f.stateDir).producer; const write = fs.writeFileSync; let path = "";
  fs.writeFileSync = ((target, ...args) => {
    const result = Reflect.apply(write, fs, [target, ...args]);
    if (typeof target === "string" && /^artifact-inventory-[a-f0-9]{64}\.json$/.test(basename(target))) {
      path = target; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "replacement" });
    }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(() => writeRunArtifactContextIndex(f.stateDir, producer), /publication binding changed/); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.ok(path); assert.equal(body(path).run_instance_id, f.meta.run_instance_id);
  assert.equal(existsSync(f.path), false); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Kernel artifact preparation retains small declaration inventories before first result without target probes", t => {
  const f = fixture(t); f.declare({ one: "one.bin", two: "two.bin", three: "three.bin", four: "four.bin", five: "five.bin" });
  const producer = admitRunResultProducer(f.stateDir).producer; const open = fs.openSync; const stat = fs.lstatSync;
  const check = (path: unknown) => assert.equal(String(path).startsWith(f.cwd + sep), false);
  fs.openSync = ((path, ...args) => { check(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.lstatSync = ((path, ...args) => { check(path); return Reflect.apply(stat, fs, [path, ...args]); }) as typeof fs.lstatSync; syncBuiltinESMExports();
  let prepared;
  try { prepared = prepareRunArtifactInventoryPublication(f.stateDir, producer); }
  finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(prepared.readFailure(), undefined); const binding = prepared.snapshot(); assert.ok(binding.artifact_inventory);
  assert.equal(binding.artifact_inventory.declarations_total, 5); assert.equal(body(binding.artifact_inventory.source.path).availability, "not_observed");
  assert.equal(existsSync(join(f.stateDir, "result.json")), false);
  withRunWorkAdmission(f.stateDir, producer, () => {});
  publishRunResult(f.stateDir, producer, { code: 0 }, { artifactInventory: prepared.snapshot });
  const first = readFileSync(join(f.stateDir, "result.json")); const result = JSON.parse(first.toString());
  assert.deepEqual(result.artifact_inventory, binding.artifact_inventory); assert.equal(result.artifact_inventory_protocol, "run-artifact-inventory-v1");
  fs.unlinkSync(binding.artifact_inventory.source.path);
  assert.deepEqual(prepared.snapshot(), { artifact_inventory: null, artifact_inventory_unavailable: "observation_changed" });
  assert.equal(publishRunResult(f.stateDir, producer, { code: 1 }, { artifactInventory: () => assert.fail("First accepted artifact binding is immutable") }), false);
  assert.deepEqual(readFileSync(join(f.stateDir, "result.json")), first);
});

test("Ordinary artifact source/index I/O records exact preparation failure without blocking work or inventing a workload exit", t => {
  for (const effect of ["source", "index"]) {
    const f = fixture(t); f.declare({ report: "report.bin" }); const producer = admitRunResultProducer(f.stateDir).producer;
    const primary = Object.assign(new Error(`artifact preparation ${effect} EIO`), { code: "EIO" }); const write = fs.writeFileSync; const rename = fs.renameSync;
    fs.writeFileSync = ((path, ...args) => { if (effect === "source" && typeof path === "string" && /^artifact-inventory-[a-f0-9]{64}\.json$/u.test(basename(path))) { write(path, "partial", { flag: "wx" }); throw primary; } return Reflect.apply(write, fs, [path, ...args]); }) as typeof fs.writeFileSync;
    fs.renameSync = ((from, to) => { if (effect === "index" && String(to) === join(f.stateDir, "context-index.json")) throw primary; return rename(from, to); }) as typeof fs.renameSync;
    syncBuiltinESMExports(); let prepared;
    try { prepared = prepareRunArtifactInventoryPublication(f.stateDir, producer); }
    finally { fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(prepared.readFailure(), primary); assert.deepEqual(prepared.snapshot(), { artifact_inventory: null, artifact_inventory_unavailable: "publication_failed" });
    assert.equal(existsSync(join(f.stateDir, "result.json")), false); let work = 0;
    withRunWorkAdmission(f.stateDir, producer, () => { work++; }); assert.equal(work, 1);
    publishRunResult(f.stateDir, producer, { code: 0 }, { artifactInventory: prepared.snapshot });
    assert.equal(body(join(f.stateDir, "result.json")).code, 0); assert.equal(body(join(f.stateDir, "result.json")).artifact_inventory_unavailable, "publication_failed");
  }
});

test("Artifact preparation keeps authority and contradictory retained-source refusals outside ordinary I/O fallback", t => {
  const f = fixture(t); f.declare({ report: "report.bin" }); const producer = admitRunResultProducer(f.stateDir).producer;
  assert.throws(() => prepareRunArtifactInventoryPublication(f.stateDir, { ...producer }), /admitted by this runtime/);
  const first = prepareRunArtifactInventoryPublication(f.stateDir, producer).snapshot(); assert.ok(first.artifact_inventory);
  writeFileSync(first.artifact_inventory.source.path, "contradictory");
  assert.throws(() => prepareRunArtifactInventoryPublication(f.stateDir, producer), /identity already fixes different bytes/);
  assert.equal(existsSync(join(f.stateDir, "result.json")), false);
});

test("Eligible natural outcomes join canonical artifact bindings only after body-free ambient checks, then freeze source availability", async t => {
  const f = fixture(t); f.declare(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`report-${i}`, `never-created-${i}.bin`])));
  const producer = admitRunResultProducer(f.stateDir).producer; const prepared = prepareRunArtifactInventoryPublication(f.stateDir, producer);
  const binding = prepared.snapshot(); assert.ok(binding.artifact_inventory); const path = binding.artifact_inventory.source.path;
  publishRunResult(f.stateDir, producer, { code: 0 }, { artifactInventory: prepared.snapshot });
  const { summarizeRuns, detectRunTransitions, collectRunCompletionBatchMembers, hasRunCompletionBatchMembers } = await import("../lib/observability.ts");
  const { admitRunCompletionBatch, formatRunCompletionBatchMessage, readRunDeliveryJournal } = await import("../lib/run-delivery.ts");
  const open = fs.openSync; let sourceOpens = 0;
  fs.openSync = ((target, ...args) => { if (String(target) === path) sourceOpens++; return Reflect.apply(open, fs, [target, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  let members;
  try {
    const summary = summarizeRuns(f.root); const transitions = detectRunTransitions(new Map([[f.stateDir, "running"]]), summary);
    assert.equal(hasRunCompletionBatchMembers(transitions, summary.runs), true); assert.equal(sourceOpens, 0);
    members = collectRunCompletionBatchMembers(transitions, summary.runs); assert.ok(sourceOpens > 0);
    const mismatched = collectRunCompletionBatchMembers(transitions.map(transition => ({ ...transition, to: "killed" as const })), summary.runs);
    assert.equal(mismatched[0]!.artifact_inventory, null); assert.equal(mismatched[0]!.artifact_inventory_unavailable, "outcome_mismatch");
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(members.length, 1); assert.equal(members[0]!.artifacts, undefined); assert.deepEqual(members[0]!.artifact_inventory, binding.artifact_inventory);
  const batch = admitRunCompletionBatch({ members, ownerId: f.meta.ownerId, tempDir: f.root }); const message = formatRunCompletionBatchMessage(batch);
  const metadata = parseDocument(message, { version: "1.2", schema: "core", uniqueKeys: true });
  assert.deepEqual(metadata.errors, []); assert.deepEqual(metadata.warnings, []);
  assert.equal(metadata.get("artifact_declarations"), 5);
  const sourceEntries = metadata.toJS().files.groups.flatMap((group: any) => group.entries.map((entry: any) => ({ ...entry, root: group.root })));
  assert.ok(sourceEntries.some((entry: any) => entry.role === "artifact_inventory" && join(entry.root, entry.path) === path
    && entry.source === undefined));
  assert.deepEqual(batch.members[0].artifact_inventory, binding.artifact_inventory);
  assert.match(message, /Declarations only; target availability\/production unproven/u);
  assert.doesNotMatch(message, /never-created/); fs.unlinkSync(path);
  assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(f.root, f.meta.ownerId).completion_batch!), message);
  const summary = summarizeRuns(f.root); const changed = collectRunCompletionBatchMembers(detectRunTransitions(new Map([[f.stateDir, "running"]]), summary), summary.runs);
  assert.equal(changed[0]!.artifact_inventory, null); assert.equal(changed[0]!.artifact_inventory_unavailable, "source_unavailable"); assert.equal(changed[0]!.artifacts, undefined);
  assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false);
});

test("Artifact outcome admission honors first unavailable/capture bindings and compares the exact canonical descriptor without source substitution", t => {
  for (const mode of ["unavailable", "capture", "descriptor", "failure"]) {
    const f = fixture(t); f.declare({ report: "never-created.bin" }); const producer = admitRunResultProducer(f.stateDir).producer;
    const prepared = prepareRunArtifactInventoryPublication(f.stateDir, producer); const binding = prepared.snapshot(); assert.ok(binding.artifact_inventory);
    publishRunResult(f.stateDir, producer, { code: mode === "failure" ? 7 : 0 }, { artifactInventory: mode === "unavailable"
      ? () => ({ artifact_inventory: null, artifact_inventory_unavailable: "publication_failed" }) : prepared.snapshot });
    const resultPath = join(f.stateDir, "result.json"); const result = body(resultPath);
    if (mode === "capture") writeJsonAtomic(resultPath, { ...result, terminal_acceptance: "after_stop_claim", stop_claim_id: "fixture" });
    if (mode === "descriptor") writeJsonAtomic(resultPath, { ...result, artifact_inventory: { ...result.artifact_inventory, source: { ...result.artifact_inventory.source, sha256: "f".repeat(64) } } });
    const open = fs.openSync; let reads = 0; fs.openSync = ((target, ...args) => { if (String(target) === binding.artifact_inventory.source.path) reads++; return Reflect.apply(open, fs, [target, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
    let reading;
    try { reading = readRunResultArtifactInventory(f.stateDir, f.meta); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    if (mode === "failure") { assert.equal(reading.state, "available"); if (reading.state === "available") assert.deepEqual(reading.binding, binding); }
    else if (mode === "unavailable") { assert.deepEqual(reading, { state: "unavailable", reason: "inventory_unavailable", artifact_inventory_unavailable: "publication_failed" }); assert.equal(reads, 0); }
    else if (mode === "capture") { assert.deepEqual(reading, { state: "unavailable", reason: "nonterminal_capture" }); assert.equal(reads, 0); }
    else assert.deepEqual(reading, { state: "unavailable", reason: "binding_invalid" });
  }
});

function retainedInventory(t: TestContext) {
  const f = fixture(t); const declarations = Object.fromEntries(Array.from({ length: 1800 }, (_, i) => [`item-${i}`, `output-${i}.bin`]));
  f.declare(declarations); const producer = admitRunResultProducer(f.stateDir).producer;
  writeRunArtifactContextIndex(f.stateDir, producer); const view = body(f.path); const sourcePath = view.inventory.source.path as string;
  const read = (query?: unknown) => readRunArtifactInventorySource(f.stateDir, f.meta, query);
  const replaceView = (value: unknown) => {
    writeJsonAtomic(f.path, value); const indexPath = join(f.stateDir, "context-index.json"); const index = body(indexPath);
    index.entries.artifacts.bytes_total = readFileSync(f.path).length; writeJsonAtomic(indexPath, index);
  };
  return { ...f, declarations, view, sourcePath, read, replaceView };
}

test("Readonly artifact inventory follows bounded declaration ranges without target probes, writes or live privacy refresh", t => {
  const f = retainedInventory(t); const open = fs.openSync; const write = fs.writeFileSync; const lstat = fs.lstatSync;
  fs.openSync = ((path, ...args) => { assert.equal(String(path).startsWith(f.cwd + sep), false); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.lstatSync = ((path, ...args) => { assert.equal(String(path).startsWith(f.cwd + sep), false); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
  fs.writeFileSync = (() => { throw Error("Readonly source must not write"); }) as typeof fs.writeFileSync; syncBuiltinESMExports();
  let reading;
  try { reading = f.read({ start: 1790, end: 1800 }); }
  finally { fs.openSync = open; fs.writeFileSync = write; fs.lstatSync = lstat; syncBuiltinESMExports(); }
  assert.equal(reading.state, "available");
  if (reading.state === "available") {
    assert.deepEqual(reading.selection, { start: 1790, end: 1800 }); assert.equal(reading.artifacts.length, 10); assert.equal(reading.artifacts_omitted, 1790);
    assert.deepEqual(reading.artifacts.map(item => item.name), Object.keys(f.declarations).slice(1790)); assert.deepEqual(reading.inventory, f.view.inventory);
    assert.equal(reading.contents, "not_read"); assert.equal(reading.availability, "not_observed"); assert.equal(reading.production_provenance, "not_asserted");
    assert.equal(Object.isFrozen(reading.artifacts), true); assert.equal(Object.isFrozen(reading.artifacts[0]), true); assert.equal(Object.isFrozen(reading.inventory.source), true);
    assert.ok(Buffer.byteLength(JSON.stringify(reading)) <= RUN_CONTEXT_ARTIFACT_MAX_BYTES); assert.equal(reading.unchanged(), true);
    writeJsonAtomic(f.metaPath, { ...f.meta, artifacts: { live: "unrelated-new-artifact" }, values: { api_key: "output-1799.bin" } });
    assert.equal(reading.unchanged(), false);
    const recovered = f.read({ start: 1790, end: 1800 }); assert.equal(recovered.state, "available");
    if (recovered.state === "available") assert.deepEqual(recovered.artifacts, reading.artifacts);
  }
  const empty = f.read({ start: 1800, end: 1800 }); assert.equal(empty.state, "available");
  if (empty.state === "available") { assert.deepEqual(empty.artifacts, []); assert.equal(empty.artifacts_omitted, 1800); }
  assert.deepEqual(f.read({ start: 1801, end: 1801 }), { state: "unavailable", reason: "range_invalid" });
  assert.deepEqual(f.read({ start: 0, end: 1800 }), { state: "unavailable", reason: "range_too_large" });
  let getters = 0; const query = { get start() { getters++; return 0; }, end: 1 };
  assert.deepEqual(f.read(query), { state: "unavailable", reason: "selection_invalid" }); assert.equal(getters, 0);
});

test("Readonly artifact inventory requires indexed publication and exact owned binding before any retained-source probe", t => {
  const f = retainedInventory(t); const originalIndex = readFileSync(join(f.stateDir, "context-index.json"));
  const lstat = fs.lstatSync; const open = fs.openSync; let probes = 0;
  const check = (path: unknown) => { if (String(path) === f.sourcePath || String(path) === "/private-unrelated.json") { probes++; throw Error("Source probe forbidden"); } };
  fs.lstatSync = ((path, ...args) => { check(path); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
  fs.openSync = ((path, ...args) => { check(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try {
    assert.equal(readRunArtifactInventorySource(f.stateDir, { ...f.meta, ownerId: "foreign" }).state, "unavailable");
    assert.equal(readRunArtifactInventorySource(f.stateDir, { ...f.meta, run_instance_id: "foreign" }).state, "unavailable");
    fs.unlinkSync(join(f.stateDir, "context-index.json")); assert.deepEqual(f.read(), { state: "unavailable", reason: "index_unavailable" });
    writeFileSync(join(f.stateDir, "context-index.json"), originalIndex);
    for (const changed of [
      { inventory: { ...f.view.inventory, source: { ...f.view.inventory.source, path: "/private-unrelated.json" } } },
      { inventory: { ...f.view.inventory, source: { ...f.view.inventory.source, run_instance_id: "foreign" } } },
      { inventory: { ...f.view.inventory, source: { ...f.view.inventory.source, sha256: "forged" } } },
      { artifacts_omitted: 1799 }, { capture_scope: "actor_metadata" }, { contents: "read" },
      { run_instance_id: "foreign" }, { content_scope: "captured_artifact_references" },
    ]) { f.replaceView({ ...f.view, ...changed }); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_invalid" }); }
  } finally { fs.lstatSync = lstat; fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(probes, 0);
});

test("Readonly artifact inventory verifies the entire source and its closed projection schema, not just selected rows or claimed hashes", t => {
  const f = retainedInventory(t); const original = body(f.sourcePath);
  const variants = [
    { ...original, run_instance_id: "foreign" }, { ...original, inventory_complete: false },
    { ...original, artifacts: original.artifacts.map((item: unknown, i: number) => i === 1799 ? { ...(item as object), availability: "available" } : item) },
    { ...original, artifacts: original.artifacts.map((item: unknown, i: number) => i === 1799 ? { ...(item as object), unknown_payload: "private" } : item) },
    { ...original, artifacts: original.artifacts.map((item: unknown, i: number) => i === 1799 ? { ...(item as object), path: null } : item) },
    { ...original, summary: { declared: 1800, references_disclosed: 1799, references_withheld: 1 } },
  ];
  for (const variant of variants) {
    const text = JSON.stringify(variant); writeFileSync(f.sourcePath, text);
    f.replaceView({ ...f.view, inventory: { ...f.view.inventory, bytes_total: Buffer.byteLength(text), source: { ...f.view.inventory.source, sha256: createHash("sha256").update(text).digest("hex") } } });
    assert.deepEqual(f.read({ start: 0, end: 1 }), { state: "unavailable", reason: "source_invalid" });
  }
  writeFileSync(f.sourcePath, JSON.stringify(original)); f.replaceView(f.view);
  assert.equal(f.read().state, "unavailable", "Different exact bytes cannot pass a matching JSON payload alone");
  writeFileSync(f.sourcePath, Buffer.from([0xff])); assert.equal(f.read().state, "unavailable");
  fs.unlinkSync(f.sourcePath); assert.deepEqual(f.read(), { state: "unavailable", reason: "source_unavailable" });
  assert.equal(existsSync(f.sourcePath), false);
});

test("Readonly artifact inventory refuses partial reads, failed close and view/index replacement while closing every opened descriptor", t => {
  for (const mode of ["short", "close", "view", "index"]) {
    const f = retainedInventory(t); const open = fs.openSync; const close = fs.closeSync; const read = fs.readSync; const tracked = new Set<number>(); let fired = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.sourcePath) tracked.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => {
      if (tracked.has(fd) && !fired) {
        fired = true; if (mode === "short") return 0;
        if (mode === "view") { const alternate = f.path + ".replacement"; writeFileSync(alternate, readFileSync(f.path)); fs.renameSync(alternate, f.path); }
        if (mode === "index") { const path = join(f.stateDir, "context-index.json"); const alternate = path + ".replacement"; writeFileSync(alternate, readFileSync(path)); fs.renameSync(alternate, path); }
      }
      return Reflect.apply(read, fs, [fd, ...args]);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = tracked.delete(fd); close(fd); if (selected && mode === "close") throw Object.assign(Error("close EIO"), { code: "EIO" }); }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    let reading;
    try { reading = f.read({ start: 0, end: 1 }); }
    finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; syncBuiltinESMExports(); }
    assert.equal(fired, true); assert.equal(reading.state, "unavailable"); assert.equal(tracked.size, 0);
    if (mode === "view" || mode === "index") assert.deepEqual(reading, { state: "unavailable", reason: "observation_changed" });
  }
});

test("A fresh publisher process can exit before readonly artifact inventory recovery without producer recreation or process probes", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-artifact-publisher-")); const stateDir = join(root, "state");
  const identity = { run: "artifact-publisher", run_instance_id: "publisher-generation", ownerId: "publisher-owner" };
  let proven = false;
  t.after(() => { if (proven) rmSync(root, { recursive: true, force: true }); });
  const source = new URL("../lib/runs-context-exports.ts", import.meta.url).href;
  const code = `const {claimRunStateDirectory}=await import(${JSON.stringify(new URL("../lib/runs-ownership.ts", import.meta.url).href)});
    const {readProcessIdentity}=await import(${JSON.stringify(new URL("../lib/runs-process.ts", import.meta.url).href)});
    const {writeJsonAtomic}=await import(${JSON.stringify(new URL("../lib/file-state.ts", import.meta.url).href)});
    const {admitRunResultProducer}=await import(${JSON.stringify(new URL("../lib/runs-results.ts", import.meta.url).href)});
    const {writeRunArtifactContextIndex}=await import(${JSON.stringify(source)});
    const state=claimRunStateDirectory(${JSON.stringify(stateDir)}, ${JSON.stringify(identity.run)});
    writeJsonAtomic(state+'/run.json',{...${JSON.stringify(identity)},state_dir:state,cwd:${JSON.stringify(root)},pid:process.pid,process_identity:readProcessIdentity(process.pid),
      createdAt:new Date().toISOString(),artifacts:Object.fromEntries(Array.from({length:1800},(_,i)=>['item-'+i,'output-'+i+'.bin']))});
    writeRunArtifactContextIndex(state,admitRunResultProducer(state).producer);`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") } });
  const captured = { pid: result.pid, state_dir: stateDir, run_instance_id: identity.run_instance_id };
  if (Number.isSafeInteger(captured.pid) && captured.pid > 0) {
    try { process.kill(captured.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") proven = true; }
  }
  if (!proven) throw new AggregateError(result.error ? [result.error] : [], `Captured fixture runner exit remains unproven; retaining state: ${root}`);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  const kill = process.kill; process.kill = (() => { throw Error("Readonly inventory must not probe processes"); }) as typeof process.kill;
  try {
    const reading = readRunArtifactInventorySource(stateDir, identity, { start: 1799, end: 1800 }); assert.equal(reading.state, "available");
    if (reading.state === "available") { assert.equal(reading.artifacts[0]!.name, "item-1799"); assert.equal(reading.unchanged(), true); }
  } finally { process.kill = kill; }
});

test("Missing, nonregular and symlinked declared artifacts stay distinct from an available regular file", t => {
  const f = fixture(t); fs.mkdirSync(join(f.cwd, "directory"));
  const declarations: Record<string, string> = { missing: "missing.bin", directory: "directory" };
  if (process.platform !== "win32") { fs.symlinkSync(join(f.cwd, "missing-target"), join(f.cwd, "link")); declarations.link = "link"; }
  f.declare(declarations);
  assert.equal(f.publish().status, "written");
  const value = body(f.path);
  assert.equal(value.artifacts[0].availability, "missing");
  assert.equal(value.artifacts[1].availability, "unavailable");
  if (declarations.link) assert.equal(value.artifacts[2].reason, "artifact_not_regular");
});

test("Artifact export requires genuine producer admission again before publication", t => {
  const f = fixture(t); f.declare({ report: "report.txt" });
  assert.throws(() => writeRunArtifactContextExport(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  const lock = mutationLockPath(join(f.stateDir, ".lifecycle")); let changed = false;
  const releaseHook = afterMutationLockRelease(lock, () => { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); });
  try { assert.throws(f.publish, /generation changed/); assert.equal(changed, true); }
  finally { releaseHook(); }
  assert.equal(existsSync(f.path), false);
});

test("Artifact manifest preserves foreign targets and rejects source metadata changes before commit", t => {
  const f = fixture(t); f.declare({ report: "report.txt" }); fs.mkdirSync(join(f.stateDir, "evidence"));
  writeJsonAtomic(f.path, { schema: "run-context-artifacts-v1", run: f.meta.run, run_instance_id: "foreign" });
  const before = readFileSync(f.path); assert.throws(f.publish, /export binding/); assert.deepEqual(readFileSync(f.path), before); rmSync(f.path);
  const write = fs.writeFileSync; let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path).startsWith(f.path + ".")) { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /export binding/); assert.equal(changed, true); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(existsSync(f.path), false);
});

test("Artifact index joins Result metadata and preserves exact committed effects/errors and root outcome", t => {
  const f = fixture(t); f.declare({ report: "missing.txt" });
  publishRunResult(f.stateDir, f.producer, { code: 0 }); writeRunResultContextIndex(f.stateDir, f.producer);
  const before = [f.metaPath, join(f.stateDir, "result.json")].map(path => readFileSync(path));
  const rename = fs.renameSync; const refusal = Object.assign(new Error("artifact index EIO after commit"), { code: "EIO" }); let attempts = 0;
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === join(f.stateDir, "context-index.json")) { attempts++; throw refusal; } return result; }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publishIndex, error => error === refusal); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(attempts, 1); assert.equal(existsSync(f.path), true);
  assert.ok(readFileSync(f.path).length <= RUN_CONTEXT_ARTIFACT_MAX_BYTES);
  assert.equal(f.publishIndex().status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta); assert.equal(reading.state, "available");
  if (reading.state === "available") { assert.equal(reading.index.entries.artifacts.availability, "available"); assert.equal(reading.index.entries.result.availability, "available"); }
  assert.deepEqual([f.metaPath, join(f.stateDir, "result.json")].map(path => readFileSync(path)), before);
});

});

await describe("Identity privacy", { concurrency: false }, async () => {
/** Original identity privacy is separate from saved projection/publication correspondence; never mask usable references. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-context-identity-agent-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR, priorReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = priorReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const exports = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult, readRunProducerCapturedMetadata } = await import("../lib/runs-results.ts");
const { readRunContextIndex } = await import("../lib/runs-context-index.ts");
const { readRunSessionPreview, projectSessionAssistantPreview } = await import("../lib/runs-session-exports.ts");
const { projectRunRecipe, createRunRecipeBodyRedactor } = await import("../lib/recipe-projection.ts");
const { projectRunControl } = await import("../lib/control-projection.ts");
const { projectRunExecutionManifest } = await import("../lib/runs-execution-evidence.ts");
const { redactSessionEvidenceValue } = await import("../lib/session-evidence.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunTraceEvent, readRunTraceJournal } = await import("../lib/runs-trace.ts");
const { projectRunTraceJournal } = await import("../lib/trace-projection.ts");
const { appendRunControlInStateDir, claimRunControlInStateDir, updateRunControlStatusInStateDir } = await import("../lib/runs-controls.ts");
const ports = {
  recipe: { write: exports.writeRunRecipeContextExport, index: exports.writeRunRecipeContextIndex, read: exports.readRunRecipeContextView },
  trace: { write: exports.writeRunTraceContextExport, index: exports.writeRunTraceContextIndex, read: exports.readRunTraceContextView },
  control: { write: exports.writeRunControlContextExport, index: exports.writeRunControlContextIndex, read: exports.readRunControlContextView },
  execution: { write: exports.writeRunExecutionContextExport, index: exports.writeRunExecutionContextIndex, read: exports.readRunExecutionContextView },
};
function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = typeof overrides.run === "string" ? overrides.run : "identity-view";
  const stateDir = claimRunStateDirectory(join(root, "state"), run);
  const meta: Record<string, unknown> = { run, run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", template: "echo /x/private/helper", values: { skill_dir: "/x/private" }, ...overrides };
  const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
  appendRunTraceEvent(stateDir, { kind: "checkpoint.identity", summary: "recorded /x/private/helper" });
  appendRunControlInStateDir(stateDir, { run_instance_id: meta.run_instance_id as string, action: "refresh" });
  writeJsonAtomic(join(stateDir, "execution.json"), { version: 1, run: meta.run, run_instance_id: meta.run_instance_id, status: "running", updated_at: new Date().toISOString(), active_subagents: 0, commands: [] });
  return { stateDir, meta, metaPath, producer };
}
function selectedSources(t: TestContext, overrides: Record<string, unknown> = {}) {
  const secret = "literal-source-credential-63", artifacts = { operational: "/x/private/declared.txt", withheld: secret + "-output.txt" };
  const f = fixture(t, { cwd: "/work", values: { skill_dir: "/x/private", api_key: secret }, artifacts, ...overrides });
  const capture = join(f.stateDir, "captures", "command-001", "attempt-001", "stdout.log");
  fs.mkdirSync(join(capture, ".."), { recursive: true }); const stdout = " \uFEFF\r\nvisible 🫧 /x/private/helper " + secret + " ```\r\n";
  fs.writeFileSync(capture, stdout);
  const raw = { code: 0, killed: false, stdout, stderr: "", stdoutBytes: Buffer.byteLength(stdout), stdoutFileBytes: Buffer.byteLength(stdout), stdoutFile: capture };
  const primary = exports.createRunPrimaryTextPublisher(f.stateDir, f.producer);
  const observe = (session = false) => primary.observe(raw, { commandId: "command-001", attempts: [{ attempt: 1, result: raw }], session });
  const session = "sessions/command-001/recorded.jsonl", sessionPath = join(f.stateDir, session);
  fs.mkdirSync(join(sessionPath, ".."), { recursive: true }); fs.writeFileSync(sessionPath, [
    { type: "session", version: 3, id: "synthetic-session" },
    { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "/x/private/helper token=HIDDEN_TOKEN visible-session" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const execution = join(f.stateDir, "execution.json"); writeJsonAtomic(execution, { version: 1, run: f.meta.run, run_instance_id: f.meta.run_instance_id,
    updated_at: new Date().toISOString(), status: "running", active_subagents: 0, commands: [{ id: "command-001", status: "running", attempts: [], session_files: [session] }] });
  const key = createHash("sha256").update(JSON.stringify([f.meta.run, f.meta.run_instance_id, f.meta.ownerId ?? null])).digest("hex");
  return { ...f, secret, capture, primary, raw, observe, sessionPath, execution, query: { kind: "session", command_id: "command-001", path: session },
    sourcePaths: [join(f.stateDir, "evidence", `primary-${key}.txt`), join(f.stateDir, "evidence", `artifact-inventory-${key}.json`)],
    targets: [artifacts.operational, "/work/" + artifacts.withheld] };
}
function withoutTargetProbes<T>(paths: readonly string[], callback: () => T): T {
  const open = fs.openSync, stat = fs.statSync, lstat = fs.lstatSync, read = fs.readFileSync, directory = fs.readdirSync; let probes = 0;
  const check = (path: unknown) => { if (paths.includes(String(path))) { probes++; assert.fail("Private identity attempted selected body/source/target observation"); } };
  fs.openSync = ((path, ...args) => { check(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.statSync = ((path, ...args) => { check(path); return Reflect.apply(stat, fs, [path, ...args]); }) as typeof fs.statSync;
  fs.lstatSync = ((path, ...args) => { check(path); return Reflect.apply(lstat, fs, [path, ...args]); }) as typeof fs.lstatSync;
  fs.readFileSync = ((path, ...args) => { check(path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
  fs.readdirSync = ((path, ...args) => { check(path); return Reflect.apply(directory, fs, [path, ...args]); }) as typeof fs.readdirSync;
  syncBuiltinESMExports(); let result: T;
  try { result = callback(); } finally { fs.openSync = open; fs.statSync = stat; fs.lstatSync = lstat; fs.readFileSync = read; fs.readdirSync = directory; syncBuiltinESMExports(); }
  assert.equal(probes, 0); return result;
}
function noProbes<T>(callback: () => T): T {
  const open = fs.openSync, stat = fs.lstatSync, read = fs.readFileSync, write = fs.writeFileSync, rename = fs.renameSync;
  let probes = 0;
  const forbidden = () => { probes++; assert.fail("Original identity refusal attempted a filesystem probe or effect"); };
  fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; fs.readFileSync = forbidden as typeof fs.readFileSync;
  fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; syncBuiltinESMExports();
  let result: T;
  try { result = callback(); } finally { fs.openSync = open; fs.lstatSync = stat; fs.readFileSync = read; fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(probes, 0); return result;
}

// Fixture file-observation driver: explicit-date parsing and Date.now stay unchanged; not clock authority.
function atFileTime<T>(time: string, callback: () => T): T {
  const original = globalThis.Date;
  globalThis.Date = new Proxy(original, { construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [time], newTarget);
  } });
  try { return callback(); } finally { globalThis.Date = original; }
}

function literalInBody(value: unknown, literal: string, depth = 0): boolean {
  if (depth > 32) assert.fail("Fixture body exceeds its structural/decoded depth bound");
  if (typeof value === "string") {
    if (value.includes(literal)) return true;
    let decoded: unknown; try { decoded = JSON.parse(value.startsWith("\uFEFF") ? value.slice(1) : value); } catch { return false; }
    return decoded !== value && (typeof decoded === "string" || (!!decoded && typeof decoded === "object")) && literalInBody(decoded, literal, depth + 1);
  }
  return !!value && typeof value === "object" && Object.entries(value).some(([key, item]) => key.includes(literal) || literalInBody(item, literal, depth + 1));
}

test("Five role captured_at writers use original privacy before publication and preserve absent/prior history and independent index effects", t => {
  const time = "2001-01-01T00:00:00.000Z";
  const timePorts = { ...ports, result: { write: exports.writeRunResultContextExport, index: exports.writeRunResultContextIndex, read: exports.readRunResultContextView } };
  for (const [role, port] of Object.entries(timePorts)) for (const present of [true, false]) for (const previous of [true, false]) {
    const f = fixture(t, { values: { skill_dir: "/x/private", ...(present ? { api_key: time } : {}) } });
    const original = readRunProducerCapturedMetadata(f.producer, 1048576);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: time } });
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 0, error: "public diagnostic" }), true);
    if (previous) port.index(f.stateDir, f.producer);
    const evidence = join(f.stateDir, "evidence"), view = join(evidence, role + (role === "trace" ? ".jsonl" : ".json")), index = join(f.stateDir, "context-index.json");
    const evidenceBytes = () => fs.existsSync(evidence) ? Object.fromEntries(fs.readdirSync(evidence).map(file => [file, fs.readFileSync(join(evidence, file))])) : undefined;
    const before = evidenceBytes(), oldIndex = fs.existsSync(index) ? fs.readFileSync(index) : undefined;
    const canonical = [f.metaPath, join(f.stateDir, "result.json"), join(f.stateDir, "trace.jsonl"), join(f.stateDir, "controls.jsonl"), join(f.stateDir, "execution.json")];
    const inputs = canonical.map(path => fs.readFileSync(path)), historical = previous ? port.read(f.stateDir, f.producer) : undefined;
    const outcome = atFileTime(time, () => port.write(f.stateDir, f.producer));
    if (present) {
      assert.deepEqual(outcome, { status: "unavailable", reason: role + "_metadata_redacted" });
      assert.deepEqual(evidenceBytes(), before); assert.deepEqual(fs.existsSync(index) ? fs.readFileSync(index) : undefined, oldIndex);
      if (previous) { assert.equal(historical!.state, "available"); if (historical!.state === "available") assert.equal(historical!.unchanged(), true);
        assert.equal(port.read(f.stateDir, f.producer).state, "available"); }
      else { assert.equal(fs.existsSync(view), false);
        if (role !== "recipe") noProbes(() => assert.deepEqual(port.read(f.stateDir, f.producer), { state: "unavailable", reason: "publication_unavailable" })); }
    } else { assert.equal(outcome.status, "written"); const text = fs.readFileSync(view, "utf8");
      assert.equal(JSON.parse(role === "trace" ? text.split("\n")[0] : text).captured_at, time); }
    assert.deepEqual(canonical.map(path => fs.readFileSync(path)), inputs); assert.deepEqual(readRunProducerCapturedMetadata(f.producer, 1048576), original);
    assert.equal(atFileTime(time, () => port.index(f.stateDir, f.producer)).status, "published");
    const entry = JSON.parse(fs.readFileSync(index, "utf8")).entries[role]; assert.equal(entry.availability, present ? "unavailable" : "available");
    if (present) { assert.equal(entry.reason, role + "_metadata_redacted"); assert.deepEqual(evidenceBytes(), before);
      assert.equal(port.read(f.stateDir, f.producer).state, "unavailable"); }
    else { const reading = port.read(f.stateDir, f.producer); assert.equal(reading.state, "available");
      if (reading.state === "available") assert.equal("header" in reading.view ? reading.view.header.captured_at : reading.view.captured_at, time); }
    assert.equal(port.index(f.stateDir, f.producer).status, "published"); assert.equal(port.read(f.stateDir, f.producer).state, "available");
    assert.deepEqual(canonical.map(path => fs.readFileSync(path)), inputs);
  }
});

test("Saved captured_at privacy refuses whole Recipe without repair while preserving public semantic file-time edits, fixed namespace and four stronger byte bindings", t => {
  const time = "2001-01-01T00:00:00.000Z", publicTime = "2002-01-01T00:00:00.000Z";
  const timePorts = { ...ports, result: { write: exports.writeRunResultContextExport, index: exports.writeRunResultContextIndex, read: exports.readRunResultContextView } };
  for (const present of [true, false]) {
    const f = fixture(t, { values: { skill_dir: "/x/private", api_key: present ? time : "evidence" } });
    const original = readRunProducerCapturedMetadata(f.producer, 1048576);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: time } });
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 0 }), true);
    for (const port of Object.values(timePorts)) port.index(f.stateDir, f.producer);
    const index = join(f.stateDir, "context-index.json"), canonical = [f.metaPath, index, join(f.stateDir, "result.json"), join(f.stateDir, "trace.jsonl"), join(f.stateDir, "controls.jsonl"), join(f.stateDir, "execution.json")];
    const inputs = canonical.map(path => fs.readFileSync(path));
    for (const [role, port] of Object.entries(timePorts)) {
      const path = join(f.stateDir, "evidence", role + (role === "trace" ? ".jsonl" : ".json")), bytes = fs.readFileSync(path);
      const lines = bytes.toString("utf8").trimEnd().split("\n"), value = JSON.parse(role === "trace" ? lines[0] : bytes.toString("utf8"));
      for (const date of [time, publicTime]) {
        const prior = port.read(f.stateDir, f.producer); assert.equal(prior.state, "available"); value.captured_at = date;
        const content = role === "trace" ? [JSON.stringify(value), ...lines.slice(1)].join("\n") + "\n" : JSON.stringify(value, null, 2) + "\n";
        assert.equal(Buffer.byteLength(content), bytes.length); fs.writeFileSync(path, content);
        assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
        const originals = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, mkdirSync: fs.mkdirSync, rmSync: fs.rmSync, readdirSync: fs.readdirSync };
        const kill = process.kill, now = Date.now; let effects = 0;
        const forbidden = () => { effects++; throw Error("Saved file-time refusal attempted mutation, discovery or sampling"); };
        Object.assign(fs, { writeFileSync: forbidden, renameSync: forbidden, mkdirSync: forbidden, rmSync: forbidden, readdirSync: forbidden });
        process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
        let reading: ReturnType<typeof port.read>;
        try { reading = port.read(f.stateDir, f.producer); }
        finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
        assert.equal(effects, 0);
        if (role !== "recipe") assert.deepEqual(reading, { state: "unavailable", reason: "view_mismatch" });
        else if (present && date === time) assert.deepEqual(reading, { state: "unavailable", reason: "view_metadata_redacted" });
        else { assert.equal(reading.state, "available"); if (reading.state === "available") {
          assert.equal("captured_at" in reading.view && reading.view.captured_at, date); assert.equal(reading.path, "evidence/recipe.json"); assert.equal(reading.unchanged(), true); } }
        assert.equal(prior.state === "available" && prior.unchanged(), false);
        assert.equal(fs.readFileSync(path, "utf8"), content); assert.deepEqual(canonical.map(path => fs.readFileSync(path)), inputs);
        fs.writeFileSync(path, bytes); assert.equal(port.read(f.stateDir, f.producer).state, "available");
      }
    }
    assert.deepEqual(readRunProducerCapturedMetadata(f.producer, 1048576), original);
  }
});

test("Original body data policy handles JSON-looking credentials and BOM/nested sensitive content before text limits without changing inputs", () => {
  let accesses = 0; const unused = Object.defineProperty({}, "values", { get() { accesses++; throw Error("Invalid input must not construct unused per-call privacy"); } });
  assert.deepEqual(projectSessionAssistantPreview("not session JSON", unused), { state: "unavailable", reason: "session_invalid" });
  assert.deepEqual(projectRunExecutionManifest({ run: "safe", run_instance_id: "generation" }, { version: 1 }, unused), { state: "unavailable", reason: "identity_mismatch" });
  assert.equal(accesses, 0);
  for (const secret of ["123", "null", '["credential66"]', "api", '[ "credential68" ]', '\uFEFF[ "credential68" ]', '{ "note": "cred\\u0065ntial68", "n": 1e3 }']) {
    const policy = createRunRecipeBodyRedactor({ values: { api_key: secret } }, Number.MAX_SAFE_INTEGER);
    const input = { plain: secret, [secret]: secret, encoded: "\uFEFF" + JSON.stringify({ note: secret, api_key: "OTHER_PRIVATE_VALUE",
      wrapped: JSON.stringify({ note: secret, authorization: "OTHER_PRIVATE_VALUE" }) }) };
    const before = JSON.stringify(input); const projected = policy(input);
    assert.equal(policy(secret), "[REDACTED]");
    assert.equal(literalInBody(projected, secret), false); assert.equal(literalInBody(projected, "OTHER_PRIVATE_VALUE"), false);
    assert.equal(JSON.stringify(input), before);
    const literal = " \uFEFF\uFFFD🫧```\r\nplain unrelated text\t"; assert.equal(policy(literal), literal);
  }
});

test("Opaque raw JSON spans are withheld without losing structured sensitive-key privacy or public siblings", () => {
  const secret = '[ "credential68" ]', policy = createRunRecipeBodyRedactor({ values: { api_key: secret, password: "SECOND_KNOWN" } });
  const opaque = '{"public":"kept inside private representation","opaque":' + secret + ',"note":"SECOND_KNOWN","password":"OTHER_PRIVATE_VALUE"}';
  assert.deepEqual(policy({ public: "kept outside", opaque }), { public: "kept outside", opaque: "[REDACTED]" });
  const encoded = JSON.stringify({ public: "kept", note: "SECOND_KNOWN", password: "OTHER_PRIVATE_VALUE" });
  assert.deepEqual(JSON.parse(String(policy(encoded))), { public: "kept", note: "[REDACTED]", password: "[REDACTED]" });
  assert.equal(policy("  " + secret + "\r\n"), "[REDACTED]");
  const duplicate = '{"opaque":' + secret + ',"copy":' + JSON.stringify(secret) + '}';
  assert.equal(policy(duplicate), "[REDACTED]");
  const escaped = String.raw`\u0061`, escapePolicy = createRunRecipeBodyRedactor({ values: { api_key: escaped } });
  assert.equal(escapePolicy(String.raw`{"opaque":"\u0061","copy":"\\u0061"}`), "[REDACTED]");
});

test("Original recorded body privacy masks full scalar/key/encoded content before export limits without renewing live privacy or changing per-call defaults", t => {
  for (const secret of ["BODY_LITERAL_66", "raw\"\\\r\n\uFEFF\uFFFD🫧```"]) for (const present of [true, false]) {
    const split = "x".repeat(3994) + secret + " AFTER", short = "literal " + secret + " END";
    const encoded = "\uFEFF" + JSON.stringify({ note: secret, [secret]: JSON.stringify({ deep: secret }) });
    const f = fixture(t, { values: { skill_dir: "/x/private", ...(present ? { api_key: secret } : {}) }, template: split, artifacts: { report: secret + "-output.txt" },
      recipe_context_records: [{ depth: 0, name: "probe", logical_reference: "suite/probe", recipe: { template: short, note: { [secret]: encoded } } }] });
    const record = claimRunControlInStateDir(f.stateDir, f.producer.runInstanceId)!;
    const error = "x".repeat(310) + secret + " AFTER";
    assert.equal(updateRunControlStatusInStateDir(f.stateDir, record.id, "failed", { error }, ["claimed"]), true);
    appendRunControlInStateDir(f.stateDir, { run_instance_id: f.producer.runInstanceId, action: "refresh", input: { note: secret, [secret]: JSON.stringify({ note: secret }) } });
    appendRunTraceEvent(f.stateDir, { kind: "checkpoint.body", summary: short, data: { note: secret, [secret]: encoded, boundary: split } });
    const session = "sessions/command-001/recorded.jsonl", sessionPath = join(f.stateDir, session);
    const source = [{ type: "session", version: 3, id: "synthetic" },
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "text", text: short }] } },
      { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: split }] } },
      { type: "message", id: "c", parentId: "b", message: { role: "assistant", content: [{ type: "text", text: encoded }] } }].map(row => JSON.stringify(row)).join("\n") + "\n";
    fs.mkdirSync(join(sessionPath, ".."), { recursive: true }); fs.writeFileSync(sessionPath, source);
    const execution = join(f.stateDir, "execution.json"); writeJsonAtomic(execution, { version: 1, run: f.meta.run, run_instance_id: f.meta.run_instance_id,
      updated_at: new Date().toISOString(), status: "running", active_subagents: 0, commands: [{ id: "command-001", status: "running", label: short, command: split,
        interruption: { message: encoded }, attempts: [], session_files: [session] }] });
    const canonical = [f.metaPath, execution, join(f.stateDir, "trace.jsonl"), join(f.stateDir, "controls.jsonl"), sessionPath];
    const query = { kind: "session", command_id: "command-001", path: session };
    const mask = (text: string) => present ? text.replaceAll(secret, "[REDACTED]") : text;
    const expectedSplit = redactSessionEvidenceValue(mask(split));
    assert.equal(projectRunRecipe(f.meta).launch.template, redactSessionEvidenceValue(split));
    const standaloneSession = projectSessionAssistantPreview(source, f.meta); assert.equal(standaloneSession.state, "available");
    if (standaloneSession.state === "available") assert.equal(standaloneSession.preview.messages[1].text_chars_observed, Array.from(split).length);
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: phase === "first" ? (present ? {} : { api_key: secret }) : { skill_dir: "/another/live", api_key: "later-unrelated" } });
      const before = canonical.map(path => fs.readFileSync(path));
      for (const [role, port] of Object.entries(ports)) {
        assert.equal(port.index(f.stateDir, f.producer).status, "published"); const reading = port.read(f.stateDir, f.producer); assert.equal(reading.state, "available");
        if (reading.state === "available") assert.equal(literalInBody(reading.view, secret), !present, role + ":" + phase);
      }
      const recipe = JSON.parse(fs.readFileSync(join(f.stateDir, "evidence", "recipe.json"), "utf8")); assert.equal(recipe.recipe.launch.template, expectedSplit);
      const trace = fs.readFileSync(join(f.stateDir, "evidence", "trace.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
      assert.equal(trace.find(row => row.kind === "checkpoint.body").detail.data.boundary, expectedSplit);
      const command = JSON.parse(fs.readFileSync(join(f.stateDir, "evidence", "execution.json"), "utf8")).execution.commands[0]; assert.equal(command.command, expectedSplit);
      const control = JSON.parse(fs.readFileSync(join(f.stateDir, "evidence", "control.json"), "utf8")).controls.find((row: { id: string }) => row.id === record.id);
      assert.equal(control.error, projectRunControl({ ...record, error: mask(error) }).error);
      assert.equal(exports.writeRunSessionContextIndex(f.stateDir, f.producer, query).status, "published");
      const catalog = JSON.parse(fs.readFileSync(join(f.stateDir, "evidence", "sessions.json"), "utf8"));
      const saved = exports.readRunSessionContextPreview(f.stateDir, f.meta, catalog.previews[0].export_id); assert.equal(saved.state, "available");
      if (saved.state === "available") { assert.equal(literalInBody(saved.preview, secret), !present);
        assert.equal(saved.preview.messages[1].assistant_text, Array.from(mask(split)).slice(0, 4000).join(""));
        assert.equal(saved.preview.messages[1].text_chars_observed, Array.from(mask(split)).length); }
      const raw = readRunSessionPreview(f.stateDir, f.meta, query); assert.equal(raw.state, "available");
      if (raw.state === "available") { assert.equal(literalInBody(raw.preview, secret), true);
        assert.deepEqual(Reflect.apply(readRunSessionPreview, undefined, [f.stateDir, f.meta, query, f.meta]).preview, raw.preview); }
      assert.deepEqual(canonical.map(path => fs.readFileSync(path)), before);
    }
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Original opaque JSON scalar privacy precedes representation changes in genuine five-role publications and reads", t => {
  for (const secret of ['[ "credential68" ]', '\uFEFF[ "credential68" ]', '{ "note": "cred\\u0065ntial68", "n": 1e3 }']) for (const present of [true, false]) {
    const f = fixture(t, { template: secret, values: present ? { api_key: secret } : {} });
    appendRunTraceEvent(f.stateDir, { kind: "checkpoint.opaque", summary: secret, data: { note: secret } });
    const control = appendRunControlInStateDir(f.stateDir, { run_instance_id: f.producer.runInstanceId, action: "refresh", input: { note: secret } });
    const session = "sessions/command-001/recorded.jsonl", path = join(f.stateDir, session);
    const source = [{ type: "session", version: 3, id: "synthetic-opaque" },
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "text", text: secret }] } }].map(row => JSON.stringify(row)).join("\n") + "\n";
    fs.mkdirSync(join(path, ".."), { recursive: true }); fs.writeFileSync(path, source);
    const manifest = join(f.stateDir, "execution.json"); writeJsonAtomic(manifest, { version: 1, run: f.meta.run, run_instance_id: f.meta.run_instance_id,
      status: "running", updated_at: new Date().toISOString(), active_subagents: 0,
      commands: [{ id: "command-001", status: "running", command: secret, attempts: [], session_files: [session] }] });
    const query = { kind: "session", command_id: "command-001", path: session };
    const canonical = [f.metaPath, manifest, join(f.stateDir, "trace.jsonl"), join(f.stateDir, "controls.jsonl"), path];
    const generic = redactSessionEvidenceValue(secret, Number.MAX_SAFE_INTEGER);
    const expected = present ? "[REDACTED]" : generic;
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } });
      const before = canonical.map(path => fs.readFileSync(path));
      for (const port of Object.values(ports)) assert.equal(port.index(f.stateDir, f.producer).status, "published");
      const recipe = exports.readRunRecipeContextView(f.stateDir, f.producer); assert.equal(recipe.state, "available");
      if (recipe.state === "available") assert.equal(recipe.view.recipe.launch.template, expected, phase + ":recipe");
      const trace = exports.readRunTraceContextView(f.stateDir, f.producer); assert.equal(trace.state, "available");
      if (trace.state === "available") { const row = trace.view.items.find(row => row.kind === "checkpoint.opaque")!;
        assert.equal(row.summary, expected, phase + ":trace"); assert.deepEqual(row.detail, { data: { note: expected } }); }
      const controls = exports.readRunControlContextView(f.stateDir, f.producer); assert.equal(controls.state, "available");
      if (controls.state === "available") assert.deepEqual(controls.view.controls.find(row => row.id === control.id)!.input, { note: expected });
      const execution = exports.readRunExecutionContextView(f.stateDir, f.producer); assert.equal(execution.state, "available");
      if (execution.state === "available") assert.equal(execution.view.execution.commands[0].command, expected);
      assert.equal(exports.writeRunSessionContextIndex(f.stateDir, f.producer, query).status, "published");
      const catalog = JSON.parse(fs.readFileSync(join(f.stateDir, "evidence", "sessions.json"), "utf8"));
      const saved = exports.readRunSessionContextPreview(f.stateDir, f.meta, catalog.previews[0].export_id); assert.equal(saved.state, "available");
      if (saved.state === "available") { assert.equal(saved.preview.messages[0].assistant_text, expected);
        assert.equal(saved.preview.messages[0].text_chars_observed, Array.from(String(expected)).length); }
      const raw = readRunSessionPreview(f.stateDir, f.meta, query); assert.equal(raw.state, "available");
      if (raw.state === "available") assert.equal(raw.preview.messages[0].assistant_text, generic);
      assert.deepEqual(canonical.map(path => fs.readFileSync(path)), before);
    }
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Original Trace kinds and Control actions stay exact or omit whole rows without renewing policy or altering raw counts and generic defaults", t => {
  const secret = "private_route68", kind = "checkpoint." + secret, safeKind = "checkpoint." + "z".repeat(400), safeAction = "a".repeat(64);
  for (const present of [true, false]) {
    const f = fixture(t, { values: present ? { api_key: secret } : {} });
    appendRunTraceEvent(f.stateDir, { kind: safeKind, summary: "public-long-reference" });
    appendRunTraceEvent(f.stateDir, { kind, summary: "public-only", data: { note: "public-only" } });
    const privateControl = appendRunControlInStateDir(f.stateDir, { run_instance_id: f.producer.runInstanceId, action: secret, input: { note: "public-only" } });
    const safeControl = appendRunControlInStateDir(f.stateDir, { run_instance_id: f.producer.runInstanceId, action: safeAction });
    assert.equal(projectRunControl(privateControl).action, secret);
    assert.equal(projectRunTraceJournal(readRunTraceJournal(f.stateDir), { recipe: f.meta }).some(row => row.kind === kind), true);
    const canonical = [f.metaPath, join(f.stateDir, "trace.jsonl"), join(f.stateDir, "controls.jsonl")];
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } }); const before = canonical.map(path => fs.readFileSync(path));
      assert.equal(exports.writeRunTraceContextIndex(f.stateDir, f.producer).status, "published");
      const trace = exports.readRunTraceContextView(f.stateDir, f.producer); assert.equal(trace.state, "available");
      if (trace.state === "available") { assert.equal(trace.view.items.some(row => row.kind === kind), !present, phase + ":trace");
        assert.equal(trace.view.items.find(row => row.kind === safeKind)!.kind, safeKind);
        assert.equal(trace.view.header.events_total, 3); assert.equal(trace.view.header.events_shown, present ? 2 : 3); assert.equal(trace.view.header.events_omitted, present ? 1 : 0);
        assert.equal(literalInBody(trace.view, secret), !present); }
      assert.equal(exports.writeRunControlContextIndex(f.stateDir, f.producer).status, "published");
      const controls = exports.readRunControlContextView(f.stateDir, f.producer); assert.equal(controls.state, "available");
      if (controls.state === "available") { assert.equal(controls.view.controls.some(row => row.id === privateControl.id), !present, phase + ":control");
        assert.equal(controls.view.controls.find(row => row.id === safeControl.id)!.action, safeAction);
        assert.equal(controls.view.capacity.pending, 3); assert.equal(controls.view.controls.length, present ? 2 : 3);
        assert.equal(controls.view.controls_omitted, present ? 1 : 0); assert.equal(controls.view.foreign_controls_omitted, 0);
        assert.equal(literalInBody(controls.view, secret), !present); }
      assert.deepEqual(canonical.map(path => fs.readFileSync(path)), before);
    }
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Original primary/inventory/session publication identities refuse before selected body/source and declaration-target probes", t => {
  const secret = "literal-source-credential-63", escaped = "raw\"\\\r\n\uFEFF\uFFFD🫧```";
  for (const field of ["run", "run_instance_id", "ownerId"]) for (const value of ["/x/private", "token=HIDDEN_ID", secret, escaped, "[REDACTED]"]) {
    if (field === "run" && value !== secret) continue;
    const f = selectedSources(t, { [field]: value, values: { skill_dir: "/x/private", api_key: secret, nested: { password: escaped, secret: "[REDACTED]" } } });
    writeJsonAtomic(f.metaPath, { ...f.meta, values: {} }); f.observe();
    const before = [f.metaPath, f.capture, f.sessionPath, f.execution].map(path => fs.readFileSync(path));
    const inventory = withoutTargetProbes([f.capture, f.sessionPath, f.execution, ...f.sourcePaths, ...f.targets], () => {
      f.primary.select(f.raw); assert.deepEqual(f.primary.snapshot(), { output: null, output_unavailable: "identity_redacted" });
      const inventory = exports.prepareRunArtifactInventoryPublication(f.stateDir, f.producer);
      assert.deepEqual(inventory.snapshot(), { artifact_inventory: null, artifact_inventory_unavailable: "identity_redacted" });
      assert.equal(inventory.readFailure(), undefined); assert.equal(f.primary.readFailure(), undefined);
      assert.deepEqual(exports.writeRunArtifactContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "artifact_identity_redacted" });
      assert.deepEqual(exports.writeRunSessionContextExport(f.stateDir, f.producer, f.query), { status: "unavailable", reason: "session_identity_redacted" });
      return inventory;
    });
    assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false);
    const firstCode = field === "ownerId" ? 7 : 0;
    for (const code of [firstCode, firstCode === 0 ? 7 : 0]) { // Controlled canonical metadata, not executed workload/exit witnesses.
      const result = join(f.stateDir, "result.json"), prior = fs.existsSync(result) ? fs.readFileSync(result) : undefined;
      let repeated = 0; assert.equal(publishRunResult(f.stateDir, f.producer, { code }, { primaryText: () => { repeated++; return f.primary.snapshot(); }, artifactInventory: inventory.snapshot }), prior === undefined);
      assert.equal(repeated, prior === undefined ? 1 : 0); if (prior) assert.deepEqual(fs.readFileSync(result), prior);
    }
    const result = JSON.parse(fs.readFileSync(join(f.stateDir, "result.json"), "utf8"));
    assert.equal(result.code, firstCode); assert.equal(result.output_unavailable, "identity_redacted"); assert.equal(result.artifact_inventory_unavailable, "identity_redacted");
    exports.writeRunArtifactContextIndex(f.stateDir, f.producer); exports.writeRunSessionContextIndex(f.stateDir, f.producer, f.query);
    const index = JSON.parse(fs.readFileSync(join(f.stateDir, "context-index.json"), "utf8"));
    assert.equal(index.entries.artifacts.reason, "artifact_identity_redacted"); assert.equal(index.entries.sessions.reason, "session_identity_redacted");
    assert.deepEqual([f.metaPath, f.capture, f.sessionPath, f.execution].map(path => fs.readFileSync(path)), before);
    assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false);
  }
});

test("Original source identity guards preserve exact safe logical/absent references without live policy renewal or artifact target probes", t => {
  for (const ownerId of [undefined, "owner-/x/private", "owner-\uFEFF\uFFFD🫧```".repeat(20)]) {
    const f = selectedSources(t, { ownerId, run_instance_id: "generation-/x/private" }); f.observe();
    const expected = { run: f.producer.run, run_instance_id: f.producer.runInstanceId, ...(ownerId === undefined ? {} : { ownerId }) };
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current", api_key: f.meta.run_instance_id } });
    const inventory = withoutTargetProbes(f.targets, () => { f.primary.select(f.raw);
      const inventory = exports.prepareRunArtifactInventoryPublication(f.stateDir, f.producer);
      assert.ok(inventory.snapshot().artifact_inventory); return inventory; });
    assert.ok(f.primary.snapshot().output); assert.equal(f.primary.readFailure(), undefined); assert.equal(inventory.readFailure(), undefined);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 0 }, { primaryText: f.primary.snapshot, artifactInventory: inventory.snapshot }), true);
    const primary = exports.readRunPrimaryTextSource(f.stateDir, expected); assert.equal(primary.state, "available");
    if (primary.state === "available") { assert.equal(primary.identity.ownerId, ownerId); assert.equal(primary.identity.run_instance_id, f.meta.run_instance_id);
      assert.doesNotMatch(primary.output.preview, /literal-source-credential-63|\/x\/private/); assert.equal(primary.unchanged(), true); }
    const artifacts = withoutTargetProbes(f.targets, () => exports.readRunArtifactInventorySource(f.stateDir, expected));
    assert.equal(artifacts.state, "available"); if (artifacts.state === "available") { assert.equal(artifacts.identity.ownerId, ownerId);
      assert.equal(artifacts.artifacts[0].path, f.targets[0]); assert.equal(artifacts.artifacts[1].path, null); }
    assert.equal(exports.writeRunSessionContextIndex(f.stateDir, f.producer, f.query).status, "published");
    const catalog = JSON.parse(fs.readFileSync(join(f.stateDir, "evidence", "sessions.json"), "utf8"));
    const saved = exports.readRunSessionContextPreview(f.stateDir, expected, catalog.previews[0].export_id); assert.equal(saved.state, "available", JSON.stringify(saved));
    if (saved.state === "available") { assert.equal(saved.identity.ownerId, ownerId); assert.equal(saved.identity.run_instance_id, f.meta.run_instance_id);
      assert.doesNotMatch(JSON.stringify(saved.preview), /\/x\/private|HIDDEN_TOKEN/); }
    const raw = readRunSessionPreview(f.stateDir, expected, f.query); assert.equal(raw.state, "available");
    if (raw.state === "available" && saved.state === "available") assert.notDeepEqual(raw.preview, saved.preview);
  }
});

test("Original inventory path privacy detects literal presence even at a display-mask fixed point without dropping the operational-origin exception", t => {
  for (const originallyPrivate of [true, false]) {
    const path = "/work/[REDACTED]-output.txt", operational = "/x/private/declared.txt";
    const f = selectedSources(t, { values: { skill_dir: "/x/private", ...(originallyPrivate ? { api_key: "[REDACTED]" } : {}) },
      artifacts: { operational, report: path } });
    writeJsonAtomic(f.metaPath, { ...f.meta, values: originallyPrivate ? {} : { api_key: "[REDACTED]" } });
    const inventory = withoutTargetProbes([path, operational], () => exports.prepareRunArtifactInventoryPublication(f.stateDir, f.producer));
    assert.equal(inventory.readFailure(), undefined); assert.ok(inventory.snapshot().artifact_inventory);
    const reading = withoutTargetProbes([path, operational], () => exports.readRunArtifactInventorySource(f.stateDir, f.meta));
    assert.equal(reading.state, "available"); if (reading.state !== "available") continue;
    assert.equal(reading.artifacts[0].path, operational); assert.equal(reading.artifacts[0].availability, "not_observed");
    assert.equal(reading.artifacts[1].path, originallyPrivate ? null : path);
    if (originallyPrivate) assert.equal(reading.artifacts[1].reason, "artifact_reference_redacted");
    assert.equal(reading.unchanged(), true);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7 }, { artifactInventory: inventory.snapshot }), true);
    const result = JSON.parse(fs.readFileSync(join(f.stateDir, "result.json"), "utf8"));
    assert.equal(result.code, 7); assert.equal(result.terminal_acceptance, "natural"); assert.ok(result.artifact_inventory);
  }
});

test("Original source identity refusal leaves retained/orphan source, overflow view and session catalog bytes untouched", t => {
  const artifacts = Object.fromEntries(Array.from({ length: 1800 }, (_, index) => ["declaration-" + index + "-" + "x".repeat(90), "/x/private/declared.txt"]));
  const f = selectedSources(t, { run_instance_id: "literal-source-credential-63", artifacts });
  const evidence = join(f.stateDir, "evidence"); fs.mkdirSync(evidence);
  const retained = [...f.sourcePaths, join(evidence, "artifacts.json"), join(evidence, "sessions.json")];
  for (const path of retained) fs.writeFileSync(path, "retained unverified orphan bytes \uFEFF\r\n");
  const before = retained.map(path => fs.readFileSync(path)); f.observe();
  withoutTargetProbes([f.capture, f.sessionPath, f.execution, ...f.targets, ...retained], () => {
    f.primary.select(f.raw); assert.deepEqual(f.primary.snapshot(), { output: null, output_unavailable: "identity_redacted" });
    assert.deepEqual(exports.prepareRunArtifactInventoryPublication(f.stateDir, f.producer).snapshot(), { artifact_inventory: null, artifact_inventory_unavailable: "identity_redacted" });
    assert.deepEqual(exports.writeRunArtifactContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "artifact_identity_redacted" });
    assert.deepEqual(exports.writeRunSessionContextExport(f.stateDir, f.producer, f.query), { status: "unavailable", reason: "session_identity_redacted" });
  });
  assert.deepEqual(retained.map(path => fs.readFileSync(path)), before); assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
});

test("Original source budget/refusal keeps quiet unsupported selections, absent declarations and invalid session queries distinct", t => {
  const f = selectedSources(t, { run_instance_id: "/x/private", artifacts: {} });
  assert.deepEqual(f.primary.snapshot(), { output: null, output_unavailable: "not_selected" }); f.observe(true); f.primary.select(f.raw);
  assert.deepEqual(f.primary.snapshot(), { output: null, output_unavailable: "selection_not_supported" });
  assert.deepEqual(exports.prepareRunArtifactInventoryPublication(f.stateDir, f.producer).snapshot(), { artifact_inventory: null, artifact_inventory_unavailable: "not_declared" });
  assert.deepEqual(exports.writeRunArtifactContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "artifact_declarations_absent" });
  assert.deepEqual(exports.writeRunSessionContextExport(f.stateDir, f.producer, {}), { status: "unavailable", reason: "request_invalid" });
  withoutTargetProbes([f.capture, f.sessionPath, f.execution, ...f.targets], () => {
    const copy = { ...f.producer };
    for (const attempt of [() => exports.createRunPrimaryTextPublisher(f.stateDir, copy), () => exports.prepareRunArtifactInventoryPublication(f.stateDir, copy),
      () => exports.writeRunArtifactContextExport(f.stateDir, copy), () => exports.writeRunSessionContextExport(f.stateDir, copy, f.query)]) assert.throws(attempt, /identity admitted by this runtime/);
  });
  const large = selectedSources(t, { values: { padding: "🫧".repeat(300000) } });
  writeJsonAtomic(large.metaPath, { ...large.meta, values: {} }); large.observe();
  withoutTargetProbes([large.capture, large.sessionPath, large.execution, ...large.targets], () => {
    large.primary.select(large.raw); assert.deepEqual(large.primary.snapshot(), { output: null, output_unavailable: "privacy_capture_unavailable" });
    assert.deepEqual(exports.prepareRunArtifactInventoryPublication(large.stateDir, large.producer).snapshot(), { artifact_inventory: null, artifact_inventory_unavailable: "privacy_capture_unavailable" });
    assert.deepEqual(exports.writeRunArtifactContextExport(large.stateDir, large.producer), { status: "unavailable", reason: "artifact_admission_unavailable" });
    assert.deepEqual(exports.writeRunSessionContextExport(large.stateDir, large.producer, large.query), { status: "unavailable", reason: "session_admission_unavailable" });
  });
});

test("Recipe/Trace full headers refuse original absolute-origin and secret generations before projection/journal body or view publication", t => {
  for (const generation of ["/x/private", "token=HIDDEN_GENERATION"]) for (const role of ["recipe", "trace"] as const) {
    const f = fixture(t, { run_instance_id: generation, ...(role === "recipe" ? { template: undefined } : {}) });
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } }); // Later healthy metadata cannot renew original privacy.
    const journal = join(f.stateDir, "trace.jsonl"), open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(); let reads = 0;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === journal) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) reads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.deepEqual(ports[role].write(f.stateDir, f.producer), { status: "unavailable", reason: `${role}_identity_redacted` }); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(reads, 0); assert.equal(fs.existsSync(join(f.stateDir, "evidence", role + (role === "trace" ? ".jsonl" : ".json"))), false);
    noProbes(() => assert.deepEqual(ports[role].read(f.stateDir, f.producer), { state: "unavailable", reason: "identity_redacted" }));
  }
});

test("Four original-backed whole-view responses refuse private owner/generation before filesystem even when saved correspondence is genuine", t => {
  for (const [key, value] of [["ownerId", "/x/private"], ["ownerId", "token=HIDDEN_OWNER"], ["run_instance_id", "/x/private"], ["run_instance_id", "token=HIDDEN_GENERATION"]]) {
    const f = fixture(t, { [key]: value });
    for (const port of Object.values(ports)) port.index(f.stateDir, f.producer);
    const viewBytes = fs.existsSync(join(f.stateDir, "evidence", "recipe.json")) ? fs.readFileSync(join(f.stateDir, "evidence", "recipe.json")) : undefined;
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } });
    noProbes(() => { for (const port of Object.values(ports)) assert.deepEqual(port.read(f.stateDir, f.producer), { state: "unavailable", reason: "identity_redacted" }); });
    if (viewBytes) assert.deepEqual(fs.readFileSync(join(f.stateDir, "evidence", "recipe.json")), viewBytes); // Refusal does not rewrite already-safe headers.
  }
});

test("Captured sensitive-key literal identities refuse raw scalars including JSON escapes before publication or response probes", t => {
  const secrets = ["captured-credential-62", "raw\"\\\r\n\uFEFF\uFFFD🫧```", "raw\\u0022-not-json-62", "a", "[REDACTED]"];
  for (const secret of secrets) for (const field of ["run", "run_instance_id", "ownerId"]) for (const embedded of [false, true]) {
    if (field === "run" && secret !== secrets[0]) continue; // Run-name format refusal is not a secret-privacy witness.
    const value = embedded ? "logical-" + secret + "-suffix" : secret;
    const f = fixture(t, { [field]: value, values: { skill_dir: "/x/private", nested: { api_key: secret } } });
    for (const [role, port] of Object.entries(ports)) {
      if (field !== "ownerId") assert.deepEqual(port.write(f.stateDir, f.producer), { status: "unavailable", reason: `${role}_identity_redacted` });
      else port.index(f.stateDir, f.producer); // Safe saved headers need not be destroyed when the reply owner is private.
    }
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } });
    noProbes(() => { for (const port of Object.values(ports)) assert.deepEqual(port.read(f.stateDir, f.producer), { state: "unavailable", reason: "identity_redacted" }); });
  }
});

test("Full safe/absent owners and allowed logical suffixes survive exactly, with frozen identity and no blanket path suppression", t => {
  for (const owner of [undefined, "logical-/x/private", "owner-\uFEFF\uFFFD🫧```".repeat(30)]) {
    const f = fixture(t, { ownerId: owner, run_instance_id: "generation-/x/private" });
    for (const port of Object.values(ports)) port.index(f.stateDir, f.producer);
    for (const port of Object.values(ports)) {
      const reading = port.read(f.stateDir, f.producer); assert.equal(reading.state, "available"); if (reading.state !== "available") continue;
      assert.equal(reading.identity.run_instance_id, f.meta.run_instance_id); assert.equal(reading.identity.ownerId, owner); assert.equal(Object.isFrozen(reading.identity), true);
      assert.equal(Object.hasOwn(reading.identity, "ownerId"), owner !== undefined); assert.equal(reading.unchanged(), true);
    }
  }
});

test("New live origin cannot replace originally safe response identity privacy or authorize a copied/missing/over-budget producer", t => {
  const f = fixture(t, { ownerId: "/later/origin" }); for (const port of Object.values(ports)) port.index(f.stateDir, f.producer);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/later/origin", api_key: "/later/origin" } });
  for (const port of Object.values(ports)) assert.equal(port.read(f.stateDir, f.producer).state, "available");
  const large = fixture(t, { ownerId: "/x/private", values: { skill_dir: "/x/private", padding: "🫧".repeat(300000) } });
  writeJsonAtomic(large.metaPath, { ...large.meta, values: {} }); let getters = 0;
  const fake = Object.defineProperty({}, "ownerId", { get() { getters++; throw Error("foreign accessor"); } });
  noProbes(() => { for (const port of Object.values(ports)) {
    for (const key of [undefined, fake, { ...f.producer }, JSON.parse(JSON.stringify(f.producer))]) assert.deepEqual(Reflect.apply(port.read, undefined, [f.stateDir, key]), { state: "unavailable", reason: "admission_invalid" });
    assert.deepEqual(port.read(large.stateDir, large.producer), { state: "unavailable", reason: "admission_unavailable" });
  } }); assert.equal(getters, 0);
});

});

await describe("Historical Control", { concurrency: false }, async () => {
/** Historical Control data requires original successful publication, not current readiness or dispatch permission. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-control-read-agent-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR, priorReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = priorReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const { readRunControlContextView, writeRunControlContextExport, writeRunControlContextIndex, RUN_CONTEXT_CONTROL_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer } = await import("../lib/runs-results.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunControlInStateDir, claimRunControlInStateDir, updateRunControlStatusInStateDir, readRunControlJournalFromStateDir } = await import("../lib/runs-controls.ts");
const { readRunContextIndex } = await import("../lib/runs-context-index.ts");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "control-read");
  const meta = { run: "control-read", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", values: { skill_dir: "/x/private" } };
  prepare?.(meta); const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
  const journal = join(stateDir, "controls.jsonl"), viewPath = join(stateDir, "evidence", "control.json"), indexPath = join(stateDir, "context-index.json");
  const append = (input: unknown = { note: "literal \uFEFF\uFFFD```🫧\r\n" }) => appendRunControlInStateDir(stateDir, { run_instance_id: meta.run_instance_id, action: "refresh", input });
  const read = () => readRunControlContextView(stateDir, producer), publish = () => writeRunControlContextIndex(stateDir, producer), exportOnly = () => writeRunControlContextExport(stateDir, producer);
  const updateSize = () => { const index = json(indexPath); index.entries.control.bytes_total = fs.statSync(viewPath).size; writeJsonAtomic(indexPath, index); };
  return { root, stateDir, meta, metaPath, producer, journal, viewPath, indexPath, append, read, publish, exportOnly, updateSize };
}

test("Genuine recorded Control timestamps stay exact or omit whole rows under original privacy while raw capacity remains independent", t => {
  for (const field of ["queued_at", "delivered_at", "claimed_at", "handled_at", "failed_at"] as const) for (const present of [true, false]) {
    let record: Record<string, unknown> = {};
    const f = fixture(t, meta => {
      const state = String(meta.state_dir), generation = String(meta.run_instance_id);
      writeJsonAtomic(join(state, "run.json"), meta);
      const queued = appendRunControlInStateDir(state, { run_instance_id: generation, action: "refresh", input: { note: "public-only" } });
      if (field === "delivered_at") assert.equal(updateRunControlStatusInStateDir(state, queued.id, "delivered", {}, ["queued"]), true);
      if (field === "claimed_at" || field === "handled_at") assert.equal(claimRunControlInStateDir(state, generation)!.id, queued.id);
      if (field === "handled_at") assert.equal(updateRunControlStatusInStateDir(state, queued.id, "handled", {}, ["claimed"]), true);
      if (field === "failed_at") assert.equal(updateRunControlStatusInStateDir(state, queued.id, "failed", { error: "controlled status only" }, ["queued"]), true);
      record = readRunControlJournalFromStateDir(state).records[0] as Record<string, unknown>;
      assert.equal(typeof record[field], "string"); meta.values = present ? { api_key: record[field] } : {};
    });
    const secret = record[field];
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } });
      const before = [f.metaPath, f.journal].map(path => fs.readFileSync(path)); assert.equal(f.publish().status, "published");
      const reading = f.read(), privateHeader = present && !["handled_at", "failed_at"].includes(field);
      if (privateHeader) {
        assert.equal(json(f.indexPath).entries.control.reason, "control_metadata_redacted", field + ":" + JSON.stringify(reading));
        assert.deepEqual(reading, { state: "unavailable", reason: "publication_unavailable" }); assert.equal(fs.existsSync(f.viewPath), false);
      } else { assert.equal(reading.state, "available"); if (reading.state === "available") {
        assert.equal(reading.view.controls.length, present ? 0 : 1, field + ":" + phase);
        assert.equal(reading.view.controls_omitted, present ? 1 : 0);
        assert.equal(reading.view.capacity.pending, ["handled_at", "failed_at"].includes(field) ? 0 : 1);
        if (!present) for (const key of ["queued_at", "delivered_at", "claimed_at", "handled_at", "failed_at"] as const)
          assert.equal(reading.view.controls[0][key], record[key]);
      } }
      assert.deepEqual([f.metaPath, f.journal].map(path => fs.readFileSync(path)), before);
    }
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Private derived oldest-pending metadata refuses the whole Control view without replacing historical bytes or raw admission facts", t => {
  const secret = "2001-01-01T00:00:00.000Z", f = fixture(t, meta => { meta.values = { api_key: secret }; });
  const queued = f.append(); assert.equal(f.publish().status, "published");
  const old = f.read(); assert.equal(old.state, "available"); const bytes = fs.readFileSync(f.viewPath);
  // Controlled reported-time edit, not an issued timestamp or an executed handler/workload.
  fs.writeFileSync(f.journal, JSON.stringify({ ...queued, queued_at: secret }) + "\n");
  const before = [f.metaPath, f.journal].map(path => fs.readFileSync(path));
  assert.deepEqual(f.exportOnly(), { status: "unavailable", reason: "control_metadata_redacted" });
  assert.deepEqual(fs.readFileSync(f.viewPath), bytes); assert.deepEqual([f.metaPath, f.journal].map(path => fs.readFileSync(path)), before);
  const historical = f.read(); assert.equal(historical.state, "available");
  if (historical.state === "available") { assert.equal(historical.view.capacity.pending, 1); assert.equal(historical.view.capacity.oldest_pending_at, queued.queued_at); }
  if (old.state === "available") assert.equal(old.unchanged(), true);
  assert.equal(f.publish().status, "published"); assert.equal(json(f.indexPath).entries.control.reason, "control_metadata_redacted");
  assert.deepEqual(f.read(), { state: "unavailable", reason: "control_unavailable" }); assert.deepEqual(fs.readFileSync(f.viewPath), bytes);
  if (old.state === "available") assert.equal(old.unchanged(), false);
  fs.writeFileSync(f.journal, JSON.stringify(queued) + "\n"); assert.equal(f.publish().status, "published"); assert.equal(f.read().state, "available");
  const later = f.append(), publicOldest = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(f.journal, [{ ...queued, queued_at: publicOldest }, { ...later, queued_at: secret }].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(f.publish().status, "published"); const partial = f.read(); assert.equal(partial.state, "available");
  if (partial.state === "available") { assert.equal(partial.view.capacity.pending, 2); assert.equal(partial.view.capacity.oldest_pending_at, publicOldest);
    assert.equal(partial.view.controls.length, 1); assert.equal(partial.view.controls[0].id, queued.id); assert.equal(partial.view.controls_omitted, 1); }
  assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
});

test("Historical Control status/capacity/rows remain frozen after real journal transitions/loss and live privacy changes", t => {
  const f = fixture(t); assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" }); const record = f.append(); f.publish();
  const saved = json(f.viewPath), first = f.read(); assert.equal(first.state, "available"); if (first.state !== "available") return;
  assert.equal(first.basis, "original_control_publication_match"); assert.equal(first.path, "evidence/control.json"); assert.deepEqual(first.view, saved);
  assert.equal((first.view.controls[0].input as any).note, "literal \uFEFF\uFFFD```🫧\r\n"); assert.equal(first.view.capacity.pending, 1);
  assert.equal(Object.isFrozen(first.view.capacity), true); assert.equal(Object.isFrozen(first.view.controls[0].input), true);
  assert.equal(claimRunControlInStateDir(f.stateDir, f.meta.run_instance_id)?.id, record.id);
  assert.equal(updateRunControlStatusInStateDir(f.stateDir, record.id, "failed", { error: "/x/private/handler token=HIDDEN" }, ["claimed"]), true);
  assert.equal(first.unchanged(), true); const historical = f.read(); assert.equal(historical.state, "available"); if (historical.state === "available") assert.deepEqual(historical.view, first.view);
  fs.renameSync(f.journal, f.journal + ".held"); assert.equal(f.read().state, "available"); assert.equal(f.exportOnly().status, "unavailable"); assert.equal(f.read().state, "available"); fs.renameSync(f.journal + ".held", f.journal);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } }); assert.equal(first.unchanged(), false); assert.equal(f.read().state, "available");
  f.publish(); const current = f.read(); assert.equal(current.state, "available"); if (current.state === "available") { assert.equal(current.view.capacity.pending, 0); assert.equal(current.view.controls[0].status, "failed"); assert.doesNotMatch(JSON.stringify(current.view), /HIDDEN|\/x\/private/); }
  assert.equal(existsResult(f.stateDir), false);
});
function existsResult(stateDir: string) { return fs.existsSync(join(stateDir, "result.json")); }

test("Control read requires original producer and role publication before probes, not copies, DTOs, fresh keys or reloaded modules", async t => {
  const f = fixture(t); f.append(); f.publish(); const unrecorded = admitRunResultProducer(f.stateDir).producer, foreign = fixture(t); let healthy: unknown;
  const large = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { padding: "🫧".repeat(300000) }; }); writeJsonAtomic(large.metaPath, healthy);
  const lost = await import(new URL("../lib/runs-context-exports.ts?control_read_lost_binding", import.meta.url).href);
  const open = fs.openSync, stat = fs.lstatSync; let getters = 0; const fake = Object.defineProperty({}, "run", { get() { getters++; throw Error("fake getter"); } });
  const forbidden = () => assert.fail("Rejected original Control admission probed filesystem"); fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; syncBuiltinESMExports();
  try {
    for (const key of [null, undefined, fake, { ...f.producer }, JSON.parse(JSON.stringify(f.producer))]) assert.deepEqual(Reflect.apply(readRunControlContextView, undefined, [f.stateDir, key]), { state: "unavailable", reason: "admission_invalid" });
    assert.deepEqual(readRunControlContextView(f.stateDir, foreign.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunControlContextView(f.stateDir + "/../state", f.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunControlContextView(f.stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(lost.readRunControlContextView(f.stateDir, f.producer), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(large.read(), { state: "unavailable", reason: "admission_unavailable" });
  } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(getters, 0);
});

test("Control complete publication comparison rejects same-size input/id/capacity/status forgery and preserves exact long safe reference omissions", t => {
  const f = fixture(t, meta => { meta.run_instance_id = "g".repeat(2000); }); const record = f.append({ note: "a recorded sufficiently long safe note" });
  const safeId = "safe-" + "🫧".repeat(300) + "\uFEFF\uFFFD```\r\n";
  fs.writeFileSync(f.journal, [{ ...record, id: safeId }, { ...record, id: "/x/private/hidden-id" }].map(row => JSON.stringify(row)).join("\n") + "\n"); f.publish();
  const original = fs.readFileSync(f.viewPath), saved = json(f.viewPath), read = f.read(); assert.equal(read.state, "available");
  if (read.state === "available") { assert.equal(read.view.controls[0].id, safeId); assert.equal(read.view.controls[0].run_instance_id, f.meta.run_instance_id); assert.equal(read.view.controls_omitted, 1); assert.equal(read.view.capacity.pending, 2); }
  for (const mode of ["input", "capacity", "status", "id"]) {
    const changed = structuredClone(saved);
    if (mode === "input") changed.controls[0].input.note = "invented /x/private".padEnd(saved.controls[0].input.note.length, " ");
    else if (mode === "capacity") changed.capacity.pending = 9;
    else if (mode === "status") changed.controls[0].status = "failed";
    else changed.controls[0].id = "x" + saved.controls[0].id.slice(1);
    fs.writeFileSync(f.viewPath, JSON.stringify(changed, null, 2) + "\n"); assert.equal(fs.statSync(f.viewPath).size, original.length);
    assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available"); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" });
  }
  fs.writeFileSync(f.viewPath, original); const other = admitRunResultProducer(f.stateDir).producer; f.append({ note: "other producer publication" }); writeRunControlContextIndex(f.stateDir, other);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.equal(readRunControlContextView(f.stateDir, other).state, "available");
});

test("Control failed publication cannot mint/repair binding, while previous view and independent index effects preserve exact errors", t => {
  for (const previous of [false, true]) for (const afterReplace of [false, true]) {
    const f = fixture(t); f.append(); if (previous) { f.publish(); f.append({ note: "new captured candidate" }); }
    const rename = fs.renameSync, failure = Object.assign(Error("Control publication EIO"), { code: "EIO" }); let attempts = 0;
    fs.renameSync = ((from, to) => { if (String(to) === f.viewPath) { attempts++; if (afterReplace) rename(from, to); throw failure; } return rename(from, to); }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { assert.throws(f.exportOnly, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(attempts, 1);
    if (!previous) assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" });
    else if (!afterReplace) assert.equal(f.read().state, "available");
    else { f.updateSize(); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); }
    f.publish(); assert.equal(f.read().state, "available");
  }
  const f = fixture(t); f.append(); f.publish(); f.append(); const rename = fs.renameSync, failure = Error("Control index EIO after commit");
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.indexPath) throw failure; return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
  try { assert.throws(f.publish, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(f.read().state, "available"); assert.equal(existsResult(f.stateDir), false);
});

test("Control read selects only saved body/owned metadata with no live journal/outcome/other-body or lifecycle/native/time effects", t => {
  const f = fixture(t); f.append(); f.publish(); const other = join(f.stateDir, "evidence", "trace.jsonl"); fs.writeFileSync(other, "PRIVATE_OTHER_ROLE");
  const index = json(f.indexPath); index.entries.trace = { availability: "available", path: "evidence/trace.jsonl", media_type: "application/x-ndjson", bytes_total: fs.statSync(other).size, mutable: true, coverage: { truncated: true, redacted: true, history_complete: false } }; writeJsonAtomic(f.indexPath, index);
  fs.writeFileSync(f.journal, "PRIVATE_MALFORMED_CONTROL_JOURNAL"); fs.writeFileSync(join(f.stateDir, "result.json"), "PRIVATE_MALFORMED_OUTCOME");
  const saved = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const fds = new Map<number, string>(), allowed = new Set([f.metaPath, f.indexPath, f.viewPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)]); let selected = 0;
  fs.openSync = ((path, ...args) => { assert.equal(String(path).includes(".lifecycle"), false); const fd = Reflect.apply(saved.openSync, fs, [path, ...args]); fds.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return saved.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.ok(allowed.has(fds.get(fd)!)); if (fds.get(fd) === f.viewPath) selected++; return Reflect.apply(saved.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.ok(allowed.has(typeof path === "number" ? fds.get(path)! : String(path))); return Reflect.apply(saved.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => assert.fail("Historical Control read performed side effect or sampling"); const kill = process.kill, now = Date.now;
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try { const read = f.read(); assert.equal(read.state, "available"); if (read.state === "available") assert.equal(read.unchanged(), true); }
  finally { Object.assign(fs, saved); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(selected, 1); assert.equal(fds.size, 0);
});

test("Control source/root/marker/metadata/index changes after actual body read invalidate admission; corrupt/denied/failed-close sources never repair", t => {
  for (const change of ["root", "marker", "metadata", "index", "view", "close_error"]) {
    const f = fixture(t); f.append(); f.publish(); const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(), readFds = new Set<number>(); let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = fds.delete(fd), body = readFds.delete(fd); const result = close(fd); if (selected && body && !changed) { changed = true;
      if (change === "close_error") throw Object.assign(Error("Control view close EIO"), { code: "EIO" });
      if (change === "root") { fs.renameSync(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      else { const path = change === "marker" ? join(f.stateDir, RUN_STATE_OWNERSHIP_FILE) : change === "metadata" ? f.metaPath : change === "index" ? f.indexPath : f.viewPath;
        const bytes = fs.readFileSync(path); fs.renameSync(path, path + ".held"); fs.writeFileSync(path, bytes); }
    } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: change === "close_error" ? "view_unavailable" : "observation_changed" }); assert.equal(changed, true); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  }
  const f = fixture(t); f.append(); f.publish(); const original = fs.readFileSync(f.viewPath);
  for (const value of ["{bad", Buffer.from([0xff])]) { fs.writeFileSync(f.viewPath, value); f.updateSize(); assert.equal(f.read().state, "unavailable"); }
  fs.writeFileSync(f.viewPath, original); f.updateSize(); const open = fs.openSync;
  fs.openSync = ((path, ...args) => { if (String(path) === f.viewPath) throw Object.assign(Error("private view denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(f.read().state, "unavailable"); } finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.viewPath), original);
  if (process.platform !== "win32") { fs.renameSync(f.viewPath, f.viewPath + ".held"); fs.symlinkSync(f.viewPath + ".held", f.viewPath); assert.equal(f.read().state, "unavailable"); }
});

test("Control source/whole-response bounds are independent and preserve full-reference rows without reader clipping", t => {
  const f = fixture(t, meta => { meta.run_instance_id = "g".repeat(8036); }); for (let index = 0; index < 7; index++) f.append({ note: "x".repeat(200) }); f.publish();
  assert.ok(fs.statSync(f.viewPath).size <= RUN_CONTEXT_CONTROL_MAX_BYTES); assert.deepEqual(f.read(), { state: "unavailable", reason: "response_too_large" });
  fs.appendFileSync(f.viewPath, " ".repeat(RUN_CONTEXT_CONTROL_MAX_BYTES + 1 - fs.statSync(f.viewPath).size)); f.updateSize();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(); let bodyReads = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) bodyReads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(bodyReads, 0);
});

});

await describe("Execution publication", { concurrency: false }, async () => {
/** Producer-bound execution attempt metadata, never a private session/capture body or scope-closure report. */

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-execution-export-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});
const { writeRunExecutionContextExport, writeRunExecutionContextIndex, readRunExecutionContextView, writeRunResultContextIndex,
  RUN_CONTEXT_EXECUTION_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult } = await import("../lib/runs-results.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { readRunContextIndex, runContextExportPath, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");
const { projectRunExecutionManifest } = await import("../lib/runs-execution-evidence.ts");

function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = mkdtempSync(join(agentDir, "case-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "execution-view");
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
  const meta = { run: "execution-view", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: readProcessIdentity(process.pid),
    outcome_protocol: RUN_OUTCOME_PROTOCOL, values: { skill_dir: "/private/execution" } };
  const metaPath = join(stateDir, "run.json"); prepare?.(meta); writeJsonAtomic(metaPath, meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const manifest = { version: 1, run: meta.run, run_instance_id: meta.run_instance_id, status: "running", updated_at: clock.started_at,
    active_subagents: 1, commands: [{ id: "command-001", status: "running", stage: "worker", occurrence: 1, started_at: clock.started_at,
      command: "/private/execution/helper.mjs token=HIDDEN_COMMAND", semantic_acceptance: "pending",
      session_files: ["sessions/command-001/private.jsonl"], prompt_file: "prompts/private.txt", provider_payload: "HIDDEN_PROVIDER",
      attempts: [{ attempt: 1, code: 7, native_exit_code: 7, killed: false,
        stdout: { path: "captures/command-001/attempt-001/stdout.log", bytes: 6, bytes_observed: 18, complete: false, error: "capture_write_failed" },
        stderr: { path: "captures/command-001/attempt-001/stderr.log", bytes: 0 } }] }] };
  const source = join(stateDir, "execution.json");
  const path = join(stateDir, runContextExportPath("execution"));
  return { root, stateDir, meta, metaPath, producer, manifest, source, path,
    record: () => writeJsonAtomic(source, manifest), publish: () => writeRunExecutionContextExport(stateDir, producer),
    publishIndex: () => writeRunExecutionContextIndex(stateDir, producer) };
}
function body(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test("Execution export exposes reported attempt/capture facts but reads no private bodies or inventories", t => {
  const f = fixture(t); f.record();
  for (const folder of ["captures", "sessions", "prompts"]) { fs.mkdirSync(join(f.stateDir, folder)); writeFileSync(join(f.stateDir, folder, "private"), "HIDDEN_BODY"); }
  const before = [f.metaPath, f.source].map(path => readFileSync(path));
  const open = fs.openSync; const read = fs.readFileSync; const scan = fs.readdirSync;
  const allowed = (path: unknown) => assert.equal(["captures", "sessions", "prompts"].some(folder => String(path).includes(join(f.stateDir, folder))), false);
  fs.openSync = ((path, ...args) => { allowed(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.readFileSync = ((path, ...args) => { allowed(path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
  fs.readdirSync = (() => assert.fail("Execution export must not discover private session files")) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try { assert.equal(f.publish().status, "written"); }
  finally { fs.openSync = open; fs.readFileSync = read; fs.readdirSync = scan; syncBuiltinESMExports(); }
  const value = body(f.path);
  assert.equal(value.schema, "run-context-execution-v1");
  assert.equal(value.source_scope, "execution_manifest");
  assert.equal(value.capture_references, "not_exported");
  assert.equal(value.capture_bodies, "not_read");
  assert.equal(value.session_bodies, "not_read");
  assert.equal(value.scope_closure, "not_asserted");
  assert.equal(value.execution.commands_total, 1);
  assert.equal(value.execution.settled_attempts_reported, 1);
  assert.equal(value.execution.commands[0].reported_status, "running");
  assert.equal(value.execution.commands[0].attempts[0].stdout.reported_saved_bytes, 6);
  assert.equal(value.execution.commands[0].attempts[0].stdout.reported_observed_bytes, 18);
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /HIDDEN_|\/private\/execution|private\.jsonl|captures\/|prompts\//);
  assert.deepEqual([f.metaPath, f.source].map(path => readFileSync(path)), before);
});

test("Original sensitive reported signal tokens refuse the whole Execution view without live renewal or generic projection changes", t => {
  for (const signal of ["SIGPRIVATE69", "SIGTERM"]) for (const present of [true, false]) {
    const f = fixture(t, meta => { meta.values = { skill_dir: "/private/execution", ...(present ? { api_key: signal } : {}) }; });
    const attempt = f.manifest.commands[0].attempts[0] as Record<string, unknown>;
    attempt.native_signal = signal; attempt.native_exit_code = null; attempt.killed = true; f.record();
    const generic = projectRunExecutionManifest(f.meta, f.manifest, f.meta); assert.equal(generic.state, "available");
    if (generic.state === "available") assert.equal(generic.view.commands[0].attempts[0].native_signal, signal);
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: signal } });
      const before = [f.metaPath, f.source].map(path => readFileSync(path));
      assert.equal(f.publishIndex().status, "published");
      const reading = readRunExecutionContextView(f.stateDir, f.producer), entry = body(join(f.stateDir, "context-index.json")).entries.execution;
      assert.equal(entry.availability, present ? "unavailable" : "available", phase + ":" + JSON.stringify(reading));
      if (present) { assert.equal(entry.reason, "execution_metadata_redacted");
        assert.deepEqual(reading, { state: "unavailable", reason: "publication_unavailable" }); assert.equal(existsSync(f.path), false); }
      else { assert.equal(reading.state, "available"); if (reading.state === "available") {
        assert.equal(reading.view.execution.commands[0].attempts[0].native_signal, signal);
        assert.equal(reading.view.execution.commands[0].attempts[0].native_exit_code, null);
        assert.equal(reading.view.execution.commands[0].attempts[0].reported_killed, true); } }
      assert.deepEqual([f.metaPath, f.source].map(path => readFileSync(path)), before);
    }
    assert.equal(existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Reported Execution command ids and source times stay exact or refuse the complete view under original privacy", t => {
  for (const field of ["id", "updated_at", "started_at", "completed_at"] as const) for (const present of [true, false]) {
    const secret = field === "id" ? "command-001" : "2001-01-01T00:00:00.000Z";
    const f = fixture(t, meta => { meta.values = present ? { api_key: secret } : {}; });
    f.manifest.updated_at = field === "updated_at" ? secret : "2001-01-01T00:00:10.000Z";
    const command = f.manifest.commands[0] as Record<string, unknown>;
    command.started_at = field === "started_at" ? secret : "2001-01-01T00:00:11.000Z";
    command.completed_at = field === "completed_at" ? secret : "2001-01-01T00:00:12.000Z"; f.record();
    const generic = projectRunExecutionManifest(f.meta, f.manifest, f.meta); assert.equal(generic.state, "available");
    if (generic.state === "available") assert.equal(field === "updated_at" ? generic.view.updated_at : generic.view.commands[0][field], secret);
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } });
      const before = [f.metaPath, f.source].map(path => readFileSync(path)); assert.equal(f.publishIndex().status, "published");
      const entry = body(join(f.stateDir, "context-index.json")).entries.execution;
      assert.equal(entry.availability, present ? "unavailable" : "available", field + ":" + phase);
      const reading = readRunExecutionContextView(f.stateDir, f.producer);
      if (present) { assert.equal(entry.reason, "execution_metadata_redacted"); assert.equal(existsSync(f.path), false);
        assert.deepEqual(reading, { state: "unavailable", reason: "publication_unavailable" }); }
      else { assert.equal(reading.state, "available"); if (reading.state === "available")
        assert.equal(field === "updated_at" ? reading.view.execution.updated_at : reading.view.execution.commands[0][field], secret); }
      assert.deepEqual([f.metaPath, f.source].map(path => readFileSync(path)), before);
    }
    assert.equal(existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Signal privacy refusal preserves an earlier authentic Execution publication until independent index replacement and explicit safe refresh", t => {
  const signal = "SIGPRIVATE69", f = fixture(t, meta => { meta.values = { api_key: signal }; });
  const attempt = f.manifest.commands[0].attempts[0] as Record<string, unknown>;
  attempt.native_signal = "SIGTERM"; f.record(); assert.equal(f.publishIndex().status, "published");
  const old = readRunExecutionContextView(f.stateDir, f.producer); assert.equal(old.state, "available"); const bytes = readFileSync(f.path);
  attempt.native_signal = signal; f.record(); const before = [f.metaPath, f.source].map(path => readFileSync(path));
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "execution_metadata_redacted" }); assert.deepEqual(readFileSync(f.path), bytes);
  assert.deepEqual([f.metaPath, f.source].map(path => readFileSync(path)), before);
  const historical = readRunExecutionContextView(f.stateDir, f.producer); assert.equal(historical.state, "available");
  if (historical.state === "available") assert.equal(historical.view.execution.commands[0].attempts[0].native_signal, "SIGTERM");
  if (old.state === "available") assert.equal(old.unchanged(), true);
  assert.equal(f.publishIndex().status, "published"); assert.deepEqual(readFileSync(f.path), bytes);
  assert.deepEqual(readRunExecutionContextView(f.stateDir, f.producer), { state: "unavailable", reason: "execution_unavailable" });
  if (old.state === "available") assert.equal(old.unchanged(), false);
  attempt.native_signal = "SIGTERM"; f.record(); assert.equal(f.publishIndex().status, "published");
  assert.equal(readRunExecutionContextView(f.stateDir, f.producer).state, "available"); assert.equal(existsSync(join(f.stateDir, "result.json")), false);
});

test("Execution keeps original producer privacy while manifest facts change, without caller or live-policy renewal", t => {
  for (const absent of [false, true]) for (const mode of ["caller_only", "before_first", "refresh"] as const) {
    const f = fixture(t, meta => { if (absent) meta.values = {}; }); const original = JSON.parse(JSON.stringify(f.meta));
    f.record(); if (mode === "refresh") assert.equal(f.publishIndex().status, "published");
    f.meta.values.skill_dir = "/caller-mutated";
    if (mode !== "caller_only") writeJsonAtomic(f.metaPath, { ...original, values: { skill_dir: absent ? "/private/execution" : "/actor/replacement" }, visibility: "public", scope_closure: "confirmed" });
    f.manifest.active_subagents = 3; f.manifest.commands[0].status = "failed"; f.manifest.commands[0].command = "/private/execution/later.mjs token=HIDDEN_LATER";
    f.manifest.commands[0].attempts[0].code = 9; f.manifest.commands[0].attempts[0].killed = true; f.record();
    const current = body(f.source); const expected = projectRunExecutionManifest(original, current, original); assert.equal(expected.state, "available");
    if (mode !== "caller_only") assert.notDeepEqual(projectRunExecutionManifest(original, current, body(f.metaPath)), expected);
    const before = [f.metaPath, f.source].map(path => readFileSync(path)); assert.equal(f.publishIndex().status, "published"); const saved = body(f.path);
    if (!absent) assert.doesNotMatch(readFileSync(f.path, "utf8"), /\/private\/execution/);
    assert.doesNotMatch(readFileSync(f.path, "utf8"), /HIDDEN_|caller-mutated|\/actor\/replacement|private\.jsonl|captures\/|prompts\//);
    if (expected.state === "available") assert.deepEqual(saved.execution, expected.view);
    assert.equal(saved.execution.reported_active_subagents, 3); assert.equal(saved.execution.commands[0].reported_status, "failed");
    assert.equal(saved.execution.commands[0].attempts[0].code, 9); assert.equal(saved.execution.commands[0].attempts[0].reported_killed, true);
    assert.equal(saved.capture_references, "not_exported"); assert.equal(saved.capture_bodies, "not_read"); assert.equal(saved.session_bodies, "not_read"); assert.equal(saved.scope_closure, "not_asserted");
    assert.deepEqual([f.metaPath, f.source].map(path => readFileSync(path)), before); assert.equal(existsSync(join(f.stateDir, "result.json")), false);
    const indexed = readRunContextIndex(f.stateDir, original); assert.equal(indexed.state, "available");
    if (indexed.state === "available") assert.equal(indexed.index.entries.execution.availability, "available");
  }
});

test("Missing execution is pending, real empty manifests remain explicitly incomplete, and foreign/legacy facts are refused", t => {
  const f = fixture(t);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "execution_absent" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  f.publishIndex();
  assert.deepEqual(body(join(f.stateDir, "context-index.json")).entries.execution, { availability: "pending", path: null });
  writeJsonAtomic(f.source, { ...f.manifest, commands: [], active_subagents: 0 });
  assert.equal(f.publish().status, "written");
  const before = readFileSync(f.path);
  assert.equal(body(f.path).execution.commands_total, 0);
  assert.equal(body(f.path).coverage.history_complete, false);
  for (const delta of [{ run_instance_id: "foreign" }, { run_instance_id: undefined }, { version: 2 }, { active_subagents: "1" }]) {
    writeJsonAtomic(f.source, { ...f.manifest, ...delta });
    assert.equal(f.publish().status, "unavailable");
    assert.deepEqual(readFileSync(f.path), before);
  }
});

test("Execution source and output budgets never publish partial command/attempt arrays", t => {
  const f = fixture(t); f.record(); f.publish();
  const before = readFileSync(f.path);
  const commands = Array.from({ length: 300 }, (_, index) => ({ ...f.manifest.commands[0], id: "command-" + String(index + 1).padStart(3, "0") }));
  writeJsonAtomic(f.source, { ...f.manifest, commands });
  assert.ok(readFileSync(f.source).length < RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "execution_view_too_large" });
  assert.deepEqual(readFileSync(f.path), before);
  writeFileSync(f.source, "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES + 1));
  assert.equal(f.publish().status, "unavailable");
  assert.ok(before.length <= RUN_CONTEXT_EXECUTION_MAX_BYTES);
});

test("Execution source admits exactly 1 MiB of UTF-8 metadata and refuses an extra byte before open", t => {
  const f = fixture(t);
  const base = JSON.stringify({ ...f.manifest, padding: "" });
  const remaining = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(base);
  const padding = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const exact = JSON.stringify({ ...f.manifest, padding });
  assert.equal(Buffer.byteLength(exact), RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  writeFileSync(f.source, exact); assert.equal(f.publish().status, "written");
  const before = readFileSync(f.path);
  writeFileSync(f.source, exact + " ");
  const open = fs.openSync; let sourceOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.source) sourceOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "execution_unavailable" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(sourceOpens, 0); assert.deepEqual(readFileSync(f.path), before);
});

test("Observed execution source replacement preserves the view until a later explicit capture", t => {
  const f = fixture(t); f.record(); f.publish(); const before = readFileSync(f.path);
  const open = fs.openSync; const close = fs.closeSync; const sourceFds = new Set<number>(); let changed = false;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.source) sourceFds.add(fd); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { const source = sourceFds.delete(fd); const result = close(fd); if (source && !changed) { changed = true; writeJsonAtomic(f.source, { ...f.manifest, active_subagents: 2 }); } return result; }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "execution_changed" }); assert.equal(changed, true); }
  finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(f.path), before); assert.equal(f.publish().status, "written");
  assert.equal(body(f.path).execution.reported_active_subagents, 2);
});

test("Malformed, incomplete, nonregular and symlinked execution sources preserve prior views", t => {
  const f = fixture(t); f.record(); f.publish(); const before = readFileSync(f.path);
  for (const invalid of ["{broken", "null", Buffer.from([0xff])]) { writeFileSync(f.source, invalid); assert.equal(f.publish().status, "unavailable"); assert.deepEqual(readFileSync(f.path), before); }
  const encoded = Buffer.from(JSON.stringify({ ...f.manifest, opaque: "BAD_BYTE" })); const offset = encoded.indexOf("BAD_BYTE");
  writeFileSync(f.source, Buffer.concat([encoded.subarray(0, offset), Buffer.from([0xff]), encoded.subarray(offset + 8)]));
  assert.equal(f.publish().status, "unavailable"); assert.deepEqual(readFileSync(f.path), before);
  rmSync(f.source); fs.mkdirSync(f.source); assert.equal(f.publish().status, "unavailable"); fs.rmdirSync(f.source);
  if (process.platform !== "win32") { fs.symlinkSync(f.metaPath, f.source); assert.equal(f.publish().status, "unavailable"); }
  assert.deepEqual(readFileSync(f.path), before);
});

test("Execution original privacy/current metadata budgets are independent and refuse before manifest body reads", t => {
  let healthy: unknown;
  const over = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { ...(meta.values as Record<string, unknown>), note: "🫧".repeat(300000) };
    const encoded = JSON.stringify(meta); assert.ok(encoded.length < RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); assert.ok(Buffer.byteLength(encoded) > RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); });
  over.record(); assert.equal(over.publish().status, "unavailable"); writeJsonAtomic(over.metaPath, healthy);
  const original = readFileSync(over.source); const open = fs.openSync; let sourceReads = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === over.source) sourceReads++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(over.publish(), { status: "unavailable", reason: "execution_admission_unavailable" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(sourceReads, 0); assert.equal(existsSync(over.path), false); assert.deepEqual(readFileSync(over.source), original);
  over.publishIndex(); assert.deepEqual(body(join(over.stateDir, "context-index.json")).entries.execution,
    { availability: "unavailable", path: null, reason: "execution_admission_unavailable" });
  const f = fixture(t); f.record(); const base = { ...f.meta, padding: "" };
  const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  writeFileSync(f.metaPath, JSON.stringify({ ...base, padding: "x".repeat(room) })); assert.equal(fs.statSync(f.metaPath).size, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  assert.equal(f.publish().status, "written"); const before = readFileSync(f.path);
  fs.appendFileSync(f.metaPath, " "); assert.deepEqual(f.publish(), { status: "unavailable", reason: "execution_metadata_unavailable" }); assert.deepEqual(readFileSync(f.path), before);
  const corrupt = Buffer.from(JSON.stringify({ ...f.meta, padding: "X" })); corrupt[corrupt.indexOf('"X"') + 1] = 0xff;
  writeFileSync(f.metaPath, corrupt); assert.equal(f.publish().status, "unavailable"); assert.deepEqual(readFileSync(f.path), before);
});

test("Execution manifest/metadata/marker/root changes between capture and publication cannot retarget a prior view", t => {
  for (const change of ["manifest", "metadata", "marker", "root"] as const) {
    const f = fixture(t); f.record(); f.publish(); const before = readFileSync(f.path); const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
    const rename = fs.renameSync; let changed = false;
    const releaseHook = afterMutationLockRelease(lock, () => {
        changed = true;
        if (change === "manifest") writeJsonAtomic(f.source, { ...f.manifest, active_subagents: 2 });
        else if (change === "metadata") writeJsonAtomic(f.metaPath, { ...f.meta, note: "same-generation source change" });
        else if (change === "marker") { const path = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE); rename(path, path + ".held"); fs.copyFileSync(path + ".held", path); }
        else { rename(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      });
    try { assert.throws(f.publish, /captured source binding changed/); assert.equal(changed, true); }
    finally { releaseHook(); }
    assert.deepEqual(readFileSync(f.path), before);
    if (change === "manifest") { assert.equal(f.publish().status, "written"); assert.equal(body(f.path).execution.reported_active_subagents, 2); }
  }
});

test("Execution export rejects copied producers and revalidates generation after capture", t => {
  const f = fixture(t); f.record();
  assert.throws(() => writeRunExecutionContextExport(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  const lock = mutationLockPath(join(f.stateDir, ".lifecycle")); let changed = false;
  const releaseHook = afterMutationLockRelease(lock, () => { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); });
  try { assert.throws(f.publish, /generation changed/); assert.equal(changed, true); }
  finally { releaseHook(); }
  assert.equal(existsSync(f.path), false);
});

test("Execution publication preserves foreign targets and rejects metadata changes during temp preparation", t => {
  const f = fixture(t); f.record(); fs.mkdirSync(join(f.stateDir, "evidence"));
  writeJsonAtomic(f.path, { schema: "run-context-execution-v1", run: f.meta.run, run_instance_id: "foreign" });
  const before = readFileSync(f.path); assert.throws(f.publish, /export binding/); assert.deepEqual(readFileSync(f.path), before); rmSync(f.path);
  const write = fs.writeFileSync; let changed = false;
  fs.writeFileSync = ((path, ...args) => { const result = Reflect.apply(write, fs, [path, ...args]); if (!changed && String(path).startsWith(f.path + ".")) { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); } return result; }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /export binding/); assert.equal(changed, true); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(existsSync(f.path), false);
});

test("Execution metadata unavailability never catches or weakens existing root-outcome admission refusal", t => {
  const f = fixture(t); f.record(); f.publish(); const before = readFileSync(f.path);
  publishRunResult(f.stateDir, f.producer, { code: 0 });
  const resultPath = join(f.stateDir, "result.json"); const result = body(resultPath);
  writeJsonAtomic(resultPath, { ...result, code: "0" });
  assert.throws(f.publish, /Run evidence state is unavailable or invalid/);
  assert.deepEqual(readFileSync(f.path), before);
});

test("Execution index keeps Result metadata, first-error identity and committed effects without rewriting root truth", t => {
  const f = fixture(t); f.record(); publishRunResult(f.stateDir, f.producer, { code: 7 }); writeRunResultContextIndex(f.stateDir, f.producer);
  const before = [f.metaPath, f.source, join(f.stateDir, "result.json")].map(path => readFileSync(path));
  const rename = fs.renameSync; const refusal = Object.assign(new Error("execution index EIO after commit"), { code: "EIO" }); let attempts = 0;
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === join(f.stateDir, "context-index.json")) { attempts++; throw refusal; } return result; }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publishIndex, error => error === refusal); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(attempts, 1); assert.equal(existsSync(f.path), true); assert.equal(f.publishIndex().status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta); assert.equal(reading.state, "available");
  if (reading.state === "available") { assert.equal(reading.index.entries.execution.availability, "available"); assert.equal(reading.index.entries.result.availability, "available"); }
  assert.deepEqual([f.metaPath, f.source, join(f.stateDir, "result.json")].map(path => readFileSync(path)), before);
});

});

await describe("Historical Execution", { concurrency: false }, async () => {
/** Historical Execution projection is admitted data only, never target-body permission or root/native closure. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-execution-read-agent-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR, priorReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = priorReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const { readRunExecutionContextView, writeRunExecutionContextExport, writeRunExecutionContextIndex, readRunTraceContextView, writeRunTraceContextExport, writeRunTraceContextIndex,
  readRunControlContextView, writeRunControlContextExport, writeRunControlContextIndex, RUN_CONTEXT_EXECUTION_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, reportRunProducerCleanupFailure, readRunProducerCleanupFailure } = await import("../lib/runs-results.ts");
const { appendRunTraceEvent } = await import("../lib/runs-trace.ts");
const { appendRunControlInStateDir } = await import("../lib/runs-controls.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { readRunContextIndex } = await import("../lib/runs-context-index.ts");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "execution-read");
  const meta = { run: "execution-read", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", values: { skill_dir: "/x/private" } };
  prepare?.(meta); const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
  const source = join(stateDir, "execution.json"), viewPath = join(stateDir, "evidence", "execution.json"), indexPath = join(stateDir, "context-index.json");
  const at = new Date().toISOString(); const manifest = { version: 1, run: meta.run, run_instance_id: meta.run_instance_id, status: "running", updated_at: at, active_subagents: 1,
    commands: [{ id: "command-001", status: "running", command: "/x/private/helper token=HIDDEN_COMMAND", label: "literal \uFEFF\uFFFD```🫧\r\n", session_files: ["sessions/private.jsonl"], prompt_file: "prompts/private.txt", provider_payload: "HIDDEN_PROVIDER",
      attempts: [{ attempt: 1, code: 7, native_exit_code: 7, killed: false, stdout: { path: "captures/stdout.log", bytes: 6, bytes_observed: 18, complete: false, error: "capture_write_failed" }, stderr: { path: "captures/stderr.log", bytes: 0 } }] }] };
  const record = () => writeJsonAtomic(source, manifest), publish = () => writeRunExecutionContextIndex(stateDir, producer), exportOnly = () => writeRunExecutionContextExport(stateDir, producer);
  const read = () => readRunExecutionContextView(stateDir, producer), updateSize = () => { const index = json(indexPath); index.entries.execution.bytes_total = fs.statSync(viewPath).size; writeJsonAtomic(indexPath, index); };
  return { root, stateDir, meta, metaPath, producer, source, manifest, viewPath, indexPath, record, publish, exportOnly, read, updateSize };
}

test("Known kernel cleanup failure after committed view never mints or renews historical role admission from written alone", t => {
  for (const role of ["trace", "control", "execution"] as const) for (const previous of [false, true]) {
    const f = fixture(t), viewPath = join(f.stateDir, "evidence", role === "trace" ? "trace.jsonl" : role + ".json");
    const record = () => role === "trace" ? appendRunTraceEvent(f.stateDir, { kind: "checkpoint.cleanup", summary: "controlled recorded evidence" })
      : role === "control" ? appendRunControlInStateDir(f.stateDir, { run_instance_id: f.meta.run_instance_id, action: "refresh", input: { note: "controlled recorded evidence" } }) : f.record();
    const publish = () => role === "trace" ? writeRunTraceContextIndex(f.stateDir, f.producer)
      : role === "control" ? writeRunControlContextIndex(f.stateDir, f.producer) : f.publish();
    const exportOnly = () => role === "trace" ? writeRunTraceContextExport(f.stateDir, f.producer)
      : role === "control" ? writeRunControlContextExport(f.stateDir, f.producer) : f.exportOnly();
    const read = () => role === "trace" ? readRunTraceContextView(f.stateDir, f.producer)
      : role === "control" ? readRunControlContextView(f.stateDir, f.producer) : f.read();
    record(); let old: Buffer | undefined;
    if (previous) { publish(); assert.equal(read().state, "available"); old = fs.readFileSync(viewPath); f.manifest.active_subagents = 2; record(); }
    else if (role !== "execution") { f.record(); f.publish(); }
    else { appendRunTraceEvent(f.stateDir, { kind: "checkpoint.other_role" }); writeRunTraceContextIndex(f.stateDir, f.producer); }
    let written: ReturnType<typeof exportOnly> | undefined;
    const rename = fs.renameSync, diagnostic = console.error; let reports = 0, commits = 0; const reportMessages: unknown[][] = [];
    const failure = Object.assign(Error("Controlled kernel cleanup report after view commit"), { code: "EIO" });
    console.error = (...args) => { reports++; reportMessages.push(args); };
    fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === viewPath) {
      commits++; reportRunProducerCleanupFailure(f.producer, failure);
    } return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { written = exportOnly(); assert.equal(written.status, "written", "Cleanup report is independent; preserve actual committed writer outcome"); }
    finally { fs.renameSync = rename; console.error = diagnostic; syncBuiltinESMExports(); }
    assert.equal(commits, 1); assert.equal(reports, 1);
    assert.deepEqual(reportMessages, [["Run producer lifecycle cleanup failed; release remains unproven and further producer operations are fenced."]]);
    assert.deepEqual(readRunProducerCleanupFailure(f.producer), { status: "release_unproven", error_code: "EIO" });
    assert.ok(written && written.status === "written");
    // Controlled index metadata reflects the actual committed entry; available metadata cannot mint body authority.
    const index = json(f.indexPath); index.entries[role] = { ...written.entry }; writeJsonAtomic(f.indexPath, index);
    assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
    if (!previous) assert.deepEqual(read(), { state: "unavailable", reason: "publication_unavailable" });
    else {
      assert.deepEqual(read(), { state: "unavailable", reason: "view_mismatch" });
      // Explicit fixture restoration verifies an older successful historical fact, not active cleanup/work recovery.
      fs.writeFileSync(viewPath, old!); index.entries[role].bytes_total = old!.length; writeJsonAtomic(f.indexPath, index);
      assert.equal(read().state, "available"); assert.deepEqual(readRunProducerCleanupFailure(f.producer), { status: "release_unproven", error_code: "EIO" });
    }
    const bytes = fs.readFileSync(viewPath); assert.throws(exportOnly, /lifecycle cleanup remains unproven/); assert.deepEqual(fs.readFileSync(viewPath), bytes);
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Historical Execution fields remain frozen after manifest changes/loss, without turning reports/references into root/body authority", t => {
  const f = fixture(t); assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" }); f.record(); f.publish();
  const first = f.read(); assert.equal(first.state, "available"); if (first.state !== "available") return;
  assert.equal(first.basis, "original_execution_publication_match"); assert.deepEqual(first.view, json(f.viewPath)); assert.equal(first.path, "evidence/execution.json");
  assert.equal(first.view.scope_closure, "not_asserted"); assert.equal(first.view.capture_references, "not_exported"); assert.equal(first.view.capture_bodies, "not_read"); assert.equal(first.view.session_bodies, "not_read");
  assert.equal(first.view.execution.commands[0].label, f.manifest.commands[0].label); assert.equal(first.view.execution.commands[0].reported_session_file_count, 1);
  assert.equal(first.view.execution.commands[0].attempts[0].stdout.persistence, "incomplete"); assert.equal(first.view.execution.commands[0].attempts[0].native_exit_code, 7);
  assert.equal(Object.isFrozen(first.view.execution.commands[0].attempts[0].stdout), true); assert.doesNotMatch(JSON.stringify(first), /HIDDEN_|\/x\/private|captures\/|sessions\/|prompts\//);
  f.manifest.status = "failed"; f.manifest.active_subagents = 3; f.manifest.commands[0].status = "failed"; f.manifest.commands[0].attempts[0].killed = true; f.record();
  assert.equal(first.unchanged(), true); const old = f.read(); assert.equal(old.state, "available"); if (old.state === "available") assert.deepEqual(old.view, first.view);
  fs.renameSync(f.source, f.source + ".held"); assert.equal(f.read().state, "available"); assert.equal(f.exportOnly().status, "unavailable"); assert.equal(f.read().state, "available"); fs.renameSync(f.source + ".held", f.source);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } }); assert.equal(first.unchanged(), false); assert.equal(f.read().state, "available");
  f.publish(); const current = f.read(); assert.equal(current.state, "available"); if (current.state === "available") { assert.equal(current.view.execution.reported_active_subagents, 3); assert.equal(current.view.execution.commands[0].attempts[0].reported_killed, true); assert.equal(current.view.scope_closure, "not_asserted"); }
  assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
});

test("Execution original producer/publication admission refuses copies/getters/foreign/aliases/reloaded/large keys before filesystem probes", async t => {
  const f = fixture(t); f.record(); f.publish(); const unrecorded = admitRunResultProducer(f.stateDir).producer, foreign = fixture(t); let healthy: unknown;
  const large = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { padding: "🫧".repeat(300000) }; }); writeJsonAtomic(large.metaPath, healthy);
  const lost = await import(new URL("../lib/runs-context-exports.ts?execution_read_lost_binding", import.meta.url).href); const open = fs.openSync, stat = fs.lstatSync; let getters = 0;
  const fake = Object.defineProperty({}, "run", { get() { getters++; throw Error("fake getter"); } }); const forbidden = () => assert.fail("Rejected Execution admission probed filesystem");
  fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; syncBuiltinESMExports();
  try {
    for (const key of [null, undefined, fake, { ...f.producer }, JSON.parse(JSON.stringify(f.producer))]) assert.deepEqual(Reflect.apply(readRunExecutionContextView, undefined, [f.stateDir, key]), { state: "unavailable", reason: "admission_invalid" });
    assert.deepEqual(readRunExecutionContextView(f.stateDir, foreign.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunExecutionContextView(f.stateDir + "/../state", f.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunExecutionContextView(f.stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(lost.readRunExecutionContextView(f.stateDir, f.producer), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(large.read(), { state: "unavailable", reason: "admission_unavailable" });
  } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); } assert.equal(getters, 0);
});

test("Execution complete original publication rejects same-size command/count/native-exit/closure edits despite healthy index", t => {
  const f = fixture(t); f.record(); f.publish(); const original = fs.readFileSync(f.viewPath), saved = json(f.viewPath);
  for (const mode of ["private", "safe", "count", "native", "closure"]) {
    const changed = structuredClone(saved);
    if (mode === "private" || mode === "safe") changed.execution.commands[0].command = (mode === "private" ? "invented /x/private" : "invented safe metadata").padEnd(saved.execution.commands[0].command.length, " ");
    else if (mode === "count") changed.execution.reported_active_subagents = 9;
    else if (mode === "native") changed.execution.commands[0].attempts[0].native_exit_code = 9;
    else changed.scope_closure = "confirmed___";
    fs.writeFileSync(f.viewPath, JSON.stringify(changed, null, 2) + "\n"); assert.equal(fs.statSync(f.viewPath).size, original.length);
    assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available"); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" });
  }
  fs.writeFileSync(f.viewPath, original); const other = admitRunResultProducer(f.stateDir).producer; f.manifest.active_subagents = 2; f.record(); writeRunExecutionContextIndex(f.stateDir, other);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.equal(readRunExecutionContextView(f.stateDir, other).state, "available");
});

test("Execution unavailable/failed/pre-post replacement publications never mint new binding, while committed index effects stay separate", t => {
  for (const previous of [false, true]) for (const afterReplace of [false, true]) {
    const f = fixture(t); f.record(); if (previous) { f.publish(); f.manifest.active_subagents = 2; f.record(); }
    const rename = fs.renameSync, failure = Object.assign(Error("Execution view EIO"), { code: "EIO" }); let attempts = 0;
    fs.renameSync = ((from, to) => { if (String(to) === f.viewPath) { attempts++; if (afterReplace) rename(from, to); throw failure; } return rename(from, to); }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { assert.throws(f.exportOnly, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); } assert.equal(attempts, 1);
    if (!previous) assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" });
    else if (!afterReplace) assert.equal(f.read().state, "available");
    else { f.updateSize(); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); }
    f.publish(); assert.equal(f.read().state, "available");
  }
  const f = fixture(t); f.record(); f.publish(); f.manifest.active_subagents = 2; f.record(); const rename = fs.renameSync, failure = Error("Execution index EIO after commit");
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.indexPath) throw failure; return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
  try { assert.throws(f.publish, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); } assert.equal(f.read().state, "available");
});

test("Execution read opens only selected saved metadata, never manifest/outcome/reference targets/session/capture bodies or native/work/time effects", t => {
  const f = fixture(t); f.record(); f.publish(); const unrelated = join(f.stateDir, "evidence", "trace.jsonl"); fs.writeFileSync(unrelated, "PRIVATE_UNRELATED");
  const index = json(f.indexPath); index.entries.trace = { availability: "available", path: "evidence/trace.jsonl", media_type: "application/x-ndjson", bytes_total: fs.statSync(unrelated).size, mutable: true, coverage: { truncated: true, redacted: true, history_complete: false } }; writeJsonAtomic(f.indexPath, index);
  fs.writeFileSync(f.source, "PRIVATE_MALFORMED_MANIFEST"); fs.writeFileSync(join(f.stateDir, "result.json"), "PRIVATE_MALFORMED_OUTCOME");
  const saved = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync, lstatSync: fs.lstatSync, readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const fds = new Map<number, string>(), allowed = new Set([f.metaPath, f.indexPath, f.viewPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)]); let selected = 0;
  fs.openSync = ((path, ...args) => { assert.equal(String(path).includes(".lifecycle"), false); const fd = Reflect.apply(saved.openSync, fs, [path, ...args]); fds.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return saved.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.ok(allowed.has(fds.get(fd)!)); if (fds.get(fd) === f.viewPath) selected++; return Reflect.apply(saved.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.ok(allowed.has(typeof path === "number" ? fds.get(path)! : String(path))); return Reflect.apply(saved.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  fs.lstatSync = ((path, ...args) => { assert.equal(["captures", "sessions", "prompts"].some(folder => String(path).startsWith(join(f.stateDir, folder))), false); return Reflect.apply(saved.lstatSync, fs, [path, ...args]); }) as typeof fs.lstatSync;
  const forbidden = () => assert.fail("Execution read attempted effect/sampling/discovery"); const kill = process.kill, now = Date.now;
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try { const read = f.read(); assert.equal(read.state, "available"); if (read.state === "available") assert.equal(read.unchanged(), true); }
  finally { Object.assign(fs, saved); process.kill = kill; Date.now = now; syncBuiltinESMExports(); } assert.equal(selected, 1); assert.equal(fds.size, 0);
});

test("Execution post-body source/root/marker/metadata/index substitutions and corrupt/denied/failed-close inputs never gain admission", t => {
  for (const change of ["root", "marker", "metadata", "index", "view", "close_error"]) {
    const f = fixture(t); f.record(); f.publish(); const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(), readFds = new Set<number>(); let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = fds.delete(fd), body = readFds.delete(fd); const result = close(fd); if (selected && body && !changed) { changed = true;
      if (change === "close_error") throw Object.assign(Error("Execution close EIO"), { code: "EIO" });
      if (change === "root") { fs.renameSync(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      else { const path = change === "marker" ? join(f.stateDir, RUN_STATE_OWNERSHIP_FILE) : change === "metadata" ? f.metaPath : change === "index" ? f.indexPath : f.viewPath; const bytes = fs.readFileSync(path); fs.renameSync(path, path + ".held"); fs.writeFileSync(path, bytes); }
    } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: change === "close_error" ? "view_unavailable" : "observation_changed" }); assert.equal(changed, true); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  }
  const f = fixture(t); f.record(); f.publish(); const original = fs.readFileSync(f.viewPath);
  for (const value of ["{bad", Buffer.from([0xff])]) { fs.writeFileSync(f.viewPath, value); f.updateSize(); assert.equal(f.read().state, "unavailable"); }
  fs.writeFileSync(f.viewPath, original); f.updateSize(); const open = fs.openSync;
  fs.openSync = ((path, ...args) => { if (String(path) === f.viewPath) throw Object.assign(Error("Execution view denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(f.read().state, "unavailable"); } finally { fs.openSync = open; syncBuiltinESMExports(); } assert.deepEqual(fs.readFileSync(f.viewPath), original);
  if (process.platform !== "win32") { fs.renameSync(f.viewPath, f.viewPath + ".held"); fs.symlinkSync(f.viewPath + ".held", f.viewPath); assert.equal(f.read().state, "unavailable"); }
});

test("Execution original privacy must preserve full header identity or refuse before manifest body and publication", t => {
  const f = fixture(t, meta => { meta.run_instance_id = "/x/private"; }); f.record();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(); let manifestReads = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.source) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) manifestReads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.exportOnly(), { status: "unavailable", reason: "execution_identity_redacted" }); }
  finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(manifestReads, 0); assert.equal(fs.existsSync(f.viewPath), false); assert.deepEqual(f.read(), { state: "unavailable", reason: "identity_redacted" });
  const logical = fixture(t, meta => { meta.run_instance_id = "generation-/x/private"; }); logical.record();
  assert.equal(logical.publish().status, "published"); assert.equal(logical.read().state, "available"); // A directory suffix inside a logical reference is not an absolute origin token.
});

test("Execution source and complete response bounds are independent, never reader truncation or target exposure", t => {
  const f = fixture(t, meta => { meta.run_instance_id = "g".repeat(8036); });
  f.manifest.commands = Array.from({ length: 12 }, (_, index) => ({ ...f.manifest.commands[0], id: `command-${String(index + 1).padStart(3, "0")}`, label: "界".repeat(1300) })); f.record();
  assert.equal(f.publish().status, "published"); assert.ok(fs.statSync(f.viewPath).size <= RUN_CONTEXT_EXECUTION_MAX_BYTES); assert.deepEqual(f.read(), { state: "unavailable", reason: "response_too_large" });
  fs.appendFileSync(f.viewPath, " ".repeat(RUN_CONTEXT_EXECUTION_MAX_BYTES + 1 - fs.statSync(f.viewPath).size)); f.updateSize();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(); let selected = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) selected++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); } assert.equal(selected, 0);
});

});

await describe("Recipe publication", { concurrency: false }, async () => {
/** Real producer-bound Recipe projection/export/index, isolated from the operator registry. */

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-recipe-view-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});
const { writeRunRecipeContextExport, writeRunRecipeContextIndex, writeRunControlContextIndex,
  RUN_CONTEXT_RECIPE_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult } = await import("../lib/runs-results.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunControlInStateDir } = await import("../lib/runs-controls.ts");
const { readRunContextIndex, runContextExportPath, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES,
  RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");
const { readActorInspectorRecipe } = await import("../lib/inspector.ts");

function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = mkdtempSync(join(agentDir, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "recipe-view");
  const clock = createRunSupervisionClock({ report_every_ms: 60001, max_runtime_ms: 1 }, Date.now());
  const meta = { run: "recipe-view", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: readProcessIdentity(process.pid),
    outcome_protocol: RUN_OUTCOME_PROTOCOL, cwd: root, recipe: "task", recipe_file: "/private/view/recipes/task.json",
    recipe_context_records: [{ depth: 0, import_path: [], name: "task", logical_reference: "suite/task",
      source_kind: "active_skill_component", skill: "suite", source_file: "/private/view/recipes/task.json",
      recipe: { template: "echo {helper}", defaults: { api_key: "hidden-definition-key" } } }],
    template: { template: "/private/view/tools/helper.mjs", defaults: { skill_dir: "/private/view", password: "hidden-default" } },
    values: { skill_dir: "/private/view", recipe_dir: "/private/view/recipes", helper: "/private/view/tools/helper.mjs",
      token: "hidden-value-token", report_every: "1ms", max_runtime: "99h" } };
  const metaPath = join(stateDir, "run.json");
  prepare?.(meta);
  writeJsonAtomic(metaPath, meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const path = join(stateDir, runContextExportPath("recipe"));
  return { root, stateDir, meta, metaPath, producer, path,
    publish: () => writeRunRecipeContextExport(stateDir, producer),
    publishIndex: () => writeRunRecipeContextIndex(stateDir, producer) };
}
function body(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test("Recipe export uses the shared privacy owner, captured metadata and stored policy rather than actor values", t => {
  const f = fixture(t);
  const retained = ["native-launches.json", "descendant-launches.json"].map(name => join(f.stateDir, name));
  retained.forEach(path => writeFileSync(path, "opaque retained scope"));
  const paths = [f.metaPath, ...retained];
  const before = paths.map(path => readFileSync(path));
  const result = f.publish();
  assert.equal(result.status, "written");
  if (result.status !== "written") return;
  const value = body(f.path);
  assert.equal(value.schema, "run-context-recipe-v1");
  assert.equal(value.run_instance_id, f.meta.run_instance_id);
  assert.deepEqual(value.recipe, readActorInspectorRecipe(f.stateDir));
  assert.deepEqual(value.stored_clock, { supervision: f.meta.supervision, started_at: f.meta.started_at });
  assert.deepEqual(value.coverage, { truncated: true, redacted: true });
  assert.equal(value.capture, "definition_and_launch");
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /hidden-definition-key|hidden-default|hidden-value-token|\/private\/view/);
  assert.deepEqual(paths.map(path => readFileSync(path)), before);
  assert.equal(result.entry.availability, "available");
  assert.equal(result.entry.availability === "available" && result.entry.bytes_total, fs.statSync(f.path).size);
  assert.ok(fs.statSync(f.path).size <= RUN_CONTEXT_RECIPE_MAX_BYTES);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
  for (const name of ["progress.json", "trace.jsonl", "result.json", "terminal-handled.json"]) assert.equal(existsSync(join(f.stateDir, name)), false);
});

test("Recipe selection/privacy/policy stay fixed to original producer admission before first export and on refresh", t => {
  for (const mode of ["caller_only", "before_first", "refresh"] as const) {
    const f = fixture(t); const original = JSON.parse(JSON.stringify(f.meta)); const expectedRecipe = readActorInspectorRecipe(f.stateDir);
    const expectedClock = { started_at: original.started_at, supervision: original.supervision };
    if (mode === "refresh") f.publishIndex();
    f.meta.values.skill_dir = "/caller-mutated"; f.meta.template.defaults.skill_dir = "/caller-mutated";
    f.meta.recipe_context_records[0].recipe.template = "caller-mutated-definition";
    if (mode !== "caller_only") writeJsonAtomic(f.metaPath, { ...original, recipe_file: "/actor/new-recipe.json", recipe_context_records: [],
      template: { template: "/private/view/tools/helper.mjs", defaults: { skill_dir: "/actor/new" } },
      values: { skill_dir: "/actor/new", helper: "/private/view/tools/helper.mjs" }, visibility: "public",
      ...createRunSupervisionClock({ report_every_ms: 60002, max_runtime_ms: 2 }, Date.parse(original.started_at)) });
    assert.equal(f.publishIndex().status, "published"); const saved = body(f.path);
    assert.doesNotMatch(readFileSync(f.path, "utf8"), /\/private\/view|caller-mutated|\/actor\/new/);
    assert.deepEqual(saved.recipe, expectedRecipe); assert.deepEqual(saved.stored_clock, expectedClock); assert.equal(saved.capture, "definition_and_launch");
    const indexed = readRunContextIndex(f.stateDir, original); assert.equal(indexed.state, "available");
    if (indexed.state === "available") assert.equal(indexed.index.entries.recipe.availability, "available");
  }
});

test("Recipe index preserves the actual Control role and exposes only readable same-generation views", t => {
  const f = fixture(t);
  appendRunControlInStateDir(f.stateDir, { run_instance_id: f.meta.run_instance_id, action: "refresh", input: { token: "hidden-control" } });
  writeRunControlContextIndex(f.stateDir, f.producer);
  const controlPath = join(f.stateDir, runContextExportPath("control"));
  const before = readFileSync(controlPath);
  assert.equal(f.publishIndex().status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta);
  assert.equal(reading.state, "available");
  if (reading.state !== "available") return;
  assert.equal(reading.index.entries.recipe.availability, "available");
  assert.equal(reading.index.entries.control.availability, "available");
  assert.equal(Object.keys(reading.index.entries).length, 9);
  assert.deepEqual(readFileSync(controlPath), before);
});

test("Recipe views/index accept large captured metadata without enlarging either output budget", t => {
  const f = fixture(t, meta => { meta.values = { ...(meta.values as Record<string, unknown>), prompt: "captured input 🫧 ".repeat(4096) }; });
  const before = readFileSync(f.metaPath);
  assert.ok(before.length > RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
  assert.ok(before.length <= RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  const published = f.publishIndex();
  assert.equal(published.status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta);
  assert.equal(reading.state, "available");
  if (reading.state !== "available") return;
  const entry = reading.index.entries.recipe;
  assert.equal(entry.availability, "available");
  assert.ok(readFileSync(join(f.stateDir, "context-index.json")).length <= RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
  assert.ok(readFileSync(f.path).length <= RUN_CONTEXT_RECIPE_MAX_BYTES);
  assert.deepEqual(body(f.path).coverage, { truncated: true, redacted: true });
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /hidden-value-token|\/private\/view/);
  assert.deepEqual(readFileSync(f.metaPath), before);
});

test("Recipe capture distinguishes original launch-only, legacy clock absence and missing capture without fake definitions", t => {
  let fullLaunch: unknown;
  const f = fixture(t, meta => { fullLaunch = JSON.parse(JSON.stringify(meta)); delete meta.recipe_context_records; delete meta.supervision; delete meta.started_at; });
  assert.equal(f.publish().status, "written");
  assert.equal(body(f.path).capture, "launch_only");
  assert.equal(body(f.path).recipe.definition, undefined);
  assert.equal(Object.hasOwn(body(f.path), "stored_clock"), false);
  writeJsonAtomic(f.metaPath, fullLaunch); assert.equal(f.publish().status, "written");
  assert.equal(body(f.path).capture, "launch_only"); assert.equal(Object.hasOwn(body(f.path), "stored_clock"), false);
  let filled: unknown;
  const empty = fixture(t, meta => { filled = JSON.parse(JSON.stringify(meta)); delete meta.recipe_context_records; delete meta.template; });
  assert.deepEqual(empty.publish(), { status: "unavailable", reason: "recipe_capture_absent" });
  assert.equal(existsSync(empty.path), false);
  writeJsonAtomic(empty.metaPath, filled); assert.deepEqual(empty.publish(), { status: "unavailable", reason: "recipe_capture_absent" });
  empty.publishIndex();
  assert.deepEqual(body(join(empty.stateDir, "context-index.json")).entries.recipe,
    { availability: "unavailable", path: null, reason: "recipe_capture_absent" });
});

test("Invalid or over-budget original Recipe admission cannot borrow a later healthy same-generation source", t => {
  for (const patch of [{ recipe_context_records: "not records" }, { template: 7 },
    { supervision: { report_every_ms: 1, max_runtime_ms: null } },
    { values: { note: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) } }]) {
    let healthy: unknown;
    const f = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); Object.assign(meta, patch); });
    assert.equal(f.publish().status, "unavailable");
    writeJsonAtomic(f.metaPath, healthy);
    const result = f.publish(); assert.equal(result.status, "unavailable"); assert.equal(existsSync(f.path), false);
    if ("values" in patch) assert.deepEqual(result, { status: "unavailable", reason: "recipe_admission_unavailable" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(f.root));
    f.publishIndex(); assert.equal(body(join(f.stateDir, "context-index.json")).entries.recipe.availability, "unavailable");
  }
});

test("Recipe admission has a real UTF-8 export ceiling and refuses the whole view rather than slicing JSON", t => {
  const nested: Record<string, unknown> = { value: "safe" }; let cursor = nested;
  for (let i = 0; i < 170; i++) { const child: Record<string, unknown> = {}; cursor.child = child; cursor = child; }
  const prepare = (meta: Record<string, unknown>) => { meta.recipe_context_records = [{ depth: 0, name: "deep", recipe: nested }]; };
  const f = fixture(t, prepare); assert.equal(f.publish().status, "written");
  const before = readFileSync(f.path); const preview = body(f.path); const room = RUN_CONTEXT_RECIPE_MAX_BYTES - before.length;
  nested.value = "🫧".repeat(Math.floor((room + 4) / 4) + 1);
  const large = fixture(t, prepare); assert.ok(fs.statSync(large.metaPath).size <= RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  preview.recipe = readActorInspectorRecipe(large.stateDir); const encoded = JSON.stringify(preview, null, 2) + "\n";
  assert.ok(encoded.length <= RUN_CONTEXT_RECIPE_MAX_BYTES); assert.ok(Buffer.byteLength(encoded, "utf8") > RUN_CONTEXT_RECIPE_MAX_BYTES);
  assert.deepEqual(large.publish(), { status: "unavailable", reason: "recipe_view_too_large" }); assert.equal(existsSync(large.path), false);
  assert.equal(f.publish().status, "written"); assert.deepEqual(body(f.path).recipe, JSON.parse(before.toString()).recipe);
});

test("Live canonical Recipe validation keeps its independent input bound and never replaces a prior view on corruption", t => {
  const f = fixture(t); f.publish(); const expected = body(f.path).recipe;
  const base = { ...f.meta, padding: "" }; const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  writeFileSync(f.metaPath, JSON.stringify({ ...base, padding: "x".repeat(room) }));
  assert.equal(fs.statSync(f.metaPath).size, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); assert.equal(f.publish().status, "written");
  assert.deepEqual(body(f.path).recipe, expected); const before = readFileSync(f.path);
  fs.appendFileSync(f.metaPath, " "); assert.deepEqual(f.publish(), { status: "unavailable", reason: "recipe_metadata_unavailable" });
  assert.deepEqual(readFileSync(f.path), before);
  const corrupt = Buffer.from(JSON.stringify({ ...f.meta, padding: "X" })); corrupt[corrupt.indexOf('"X"') + 1] = 0xff;
  writeFileSync(f.metaPath, corrupt); assert.equal(f.publish().status, "unavailable"); assert.deepEqual(readFileSync(f.path), before);
});

test("Recipe source/marker/root changes between capture and publication cannot retarget an admitted static projection", t => {
  for (const change of ["metadata", "marker", "root"] as const) {
    const f = fixture(t); f.publish(); const before = readFileSync(f.path); const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
    const rename = fs.renameSync; let changed = false;
    const releaseHook = afterMutationLockRelease(lock, () => {
        changed = true;
        if (change === "metadata") writeJsonAtomic(f.metaPath, { ...f.meta, note: "same-generation source change" });
        else if (change === "marker") { const path = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE); rename(path, path + ".held"); fs.copyFileSync(path + ".held", path); }
        else { rename(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      });
    try { assert.throws(f.publish, /captured source binding changed/); assert.equal(changed, true); }
    finally { releaseHook(); }
    assert.deepEqual(readFileSync(f.path), before);
  }
});

test("Recipe export rejects copied producers and revalidates original identity between capture and publication", t => {
  const f = fixture(t);
  assert.throws(() => writeRunRecipeContextExport(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
  let changed = false;
  const releaseHook = afterMutationLockRelease(lock, () => {
      changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
    });
  try { assert.throws(f.publish, /generation changed/); assert.equal(changed, true); }
  finally { releaseHook(); }
  assert.equal(existsSync(f.path), false);
});

test("Recipe publication refuses foreign/nonregular targets and observed generation changes during temp writes", t => {
  const f = fixture(t);
  fs.mkdirSync(join(f.stateDir, "evidence"));
  writeJsonAtomic(f.path, { schema: "run-context-recipe-v1", run: f.meta.run, run_instance_id: "foreign" });
  const before = readFileSync(f.path);
  assert.throws(f.publish, /export binding/);
  assert.deepEqual(readFileSync(f.path), before);
  rmSync(f.path);
  fs.mkdirSync(f.path);
  assert.throws(f.publish, /export binding/);
  rmSync(f.path, { recursive: true });
  const write = fs.writeFileSync;
  let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path).startsWith(f.path + ".")) {
      changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
    }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /export binding/); assert.equal(changed, true); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(existsSync(f.path), false);
});

test("Recipe export/index preserve accepted natural outcomes and the exact one-shot commit error", t => {
  const f = fixture(t);
  publishRunResult(f.stateDir, f.producer, { code: 7, output: "retained natural failure" });
  const resultPath = join(f.stateDir, "result.json");
  const before = readFileSync(resultPath);
  const rename = fs.renameSync;
  const refusal = Object.assign(new Error("recipe index commit refused after rename"), { code: "EIO" });
  let attempts = 0;
  fs.renameSync = ((from, to) => {
    const result = rename(from, to);
    if (String(to) === join(f.stateDir, "context-index.json")) { attempts++; throw refusal; }
    return result;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publishIndex, error => error === refusal); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(attempts, 1);
  assert.equal(existsSync(f.path), true);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), true);
  assert.equal(f.publishIndex().status, "published");
  assert.deepEqual(readFileSync(resultPath), before);
  assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false);
});

});

await describe("Historical Recipe", { concurrency: false }, async () => {
/** Readonly saved Recipe correspondence requires the original producer, not an index/privacy DTO. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-recipe-read-agent-")));
const previousAgent = process.env.PI_CODING_AGENT_DIR; const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const { readRunRecipeContextView, writeRunRecipeContextIndex, RUN_CONTEXT_RECIPE_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer } = await import("../lib/runs-results.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { buildRecipeContextRecords } = await import("../lib/recipes-references.ts");
const { readRunContextIndex } = await import("../lib/runs-context-index.ts");
const body = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "recipe-read");
  const clock = createRunSupervisionClock({ report_every_ms: 60001, max_runtime_ms: 1 }, Date.now());
  const meta = { run: "recipe-read", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, createdAt: clock.started_at, ...clock,
    pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", cwd: root,
    template: "echo /x/private/payload \r\n", values: { skill_dir: "/x/private", api_key: "HIDDEN_KEY", literal: " \uFEFF\uFFFD` \r\n" },
    recipe_context_records: [{ depth: 0, name: "recipe", logical_reference: "suite/recipe", source_kind: "active_skill_component",
      recipe: { template: "echo /x/private/definition", defaults: { password: "HIDDEN_DEF" } } }] };
  prepare?.(meta); const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
  const viewPath = join(stateDir, "evidence", "recipe.json"), indexPath = join(stateDir, "context-index.json");
  const publish = () => writeRunRecipeContextIndex(stateDir, producer);
  const read = () => readRunRecipeContextView(stateDir, producer);
  const rewrite = (value: unknown) => { writeJsonAtomic(viewPath, value); const index = body(indexPath); index.entries.recipe.bytes_total = fs.statSync(viewPath).size; writeJsonAtomic(indexPath, index); };
  return { root, stateDir, meta, metaPath, producer, viewPath, indexPath, publish, read, rewrite };
}

test("Saved Recipe admission follows exact original-projection data as frozen values, not work/time/public authority", t => {
  const f = fixture(t); f.publish(); const expected = body(f.viewPath); const paths = [f.metaPath, f.indexPath, f.viewPath]; const before = paths.map(path => fs.readFileSync(path));
  const read = f.read(); assert.equal(read.state, "available"); if (read.state !== "available") return;
  assert.equal(read.basis, "original_producer_projection_match"); assert.deepEqual(read.view, expected); assert.equal(read.path, "evidence/recipe.json");
  assert.equal(read.bytes_total, before[2].length); assert.equal(read.mutable, true); assert.equal(read.unchanged(), true);
  assert.equal(read.view.recipe.launch.values && (read.view.recipe.launch.values as Record<string, unknown>).literal, " \uFEFF\uFFFD` \r\n");
  assert.equal(Object.isFrozen(read.view.recipe), true); assert.equal(Object.isFrozen(read.view.recipe.composition), true);
  assert.equal(Object.isFrozen(read.view.recipe.launch.values), true); assert.doesNotMatch(JSON.stringify(read), /HIDDEN_|\/x\/private|ownership_token|process_identity/);
  assert.deepEqual(paths.map(path => fs.readFileSync(path)), before);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/live/new" } });
  assert.equal(read.unchanged(), false); const fresh = f.read(); assert.equal(fresh.state, "available"); if (fresh.state === "available") assert.deepEqual(fresh.view, expected);
  writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); assert.deepEqual(f.read(), { state: "unavailable", reason: "identity_mismatch" });
  const legacy = fixture(t, meta => { delete meta.recipe_context_records; delete meta.supervision; delete meta.started_at; }); legacy.publish();
  const historical = legacy.read(); assert.equal(historical.state, "available");
  if (historical.state === "available") { assert.equal(historical.view.capture, "launch_only"); assert.equal(Object.hasOwn(historical.view, "stored_clock"), false); }
  const reordered = Object.fromEntries(Object.entries(body(legacy.viewPath)).reverse()); legacy.rewrite(reordered);
  const equivalent = legacy.read(); assert.equal(equivalent.state, "available"); if (equivalent.state === "available") assert.deepEqual(equivalent.view, reordered);
});

test("Resolved explicit-file Recipe provenance labels remain original projected display data, not an exact operational locator", t => {
  const secret = "label-credential69";
  for (const present of [true, false]) {
    let file = "";
    const f = fixture(t, meta => {
      file = join(String(meta.state_dir), "recipe-input", secret + ".json"); fs.mkdirSync(join(file, ".."), { recursive: true });
      writeJsonAtomic(file, { template: "echo safe" });
      const records = buildRecipeContextRecords(file); assert.equal(records[0].source_file, file);
      assert.equal(records[0].logical_reference, secret + ".json"); assert.equal(records[0].source_kind, "explicit_file_recipe");
      assert.notEqual(records[0].logical_reference, records[0].source_file);
      meta.recipe_context_records = records; meta.values = { skill_dir: "/x/private", ...(present ? { api_key: secret } : {}) };
    });
    const source = fs.readFileSync(file), expected = (present ? "[REDACTED]" : secret) + ".json";
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } }); const metadata = fs.readFileSync(f.metaPath);
      assert.equal(f.publish().status, "published"); const reading = f.read(); assert.equal(reading.state, "available", phase);
      if (reading.state === "available") { assert.equal(reading.view.recipe.identity.logical_reference, expected);
        assert.equal(reading.view.recipe.composition[0].logical_reference, expected);
        assert.equal(reading.view.recipe.identity.source_kind, "explicit_file_recipe"); assert.equal(reading.path, "evidence/recipe.json");
        assert.equal(JSON.stringify(reading).includes(file), false); assert.equal(Object.hasOwn(reading.view.recipe.composition[0], "source_file"), false); }
      assert.deepEqual(fs.readFileSync(file), source); assert.deepEqual(fs.readFileSync(f.metaPath), metadata);
    }
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Original stored-clock text stays exact or refuses the Recipe role and original reader before source probes", t => {
  for (const present of [true, false]) {
    const f = fixture(t, meta => { meta.values = { ...(present ? { api_key: meta.started_at } : {}) }; });
    const started = f.meta.started_at;
    for (const phase of ["first", "refresh"]) {
      writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: started } }); const before = fs.readFileSync(f.metaPath);
      assert.equal(f.publish().status, "published"); const index = body(f.indexPath).entries.recipe;
      assert.equal(index.availability, present ? "unavailable" : "available", phase);
      if (present) {
        assert.equal(index.reason, "recipe_metadata_redacted"); assert.equal(fs.existsSync(f.viewPath), false);
        const open = fs.openSync, stat = fs.lstatSync, read = fs.readFileSync; let probes = 0;
        const forbidden = () => { probes++; assert.fail("Private original clock reader attempted filesystem observation"); };
        fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; fs.readFileSync = forbidden as typeof fs.readFileSync;
        syncBuiltinESMExports();
        try { assert.deepEqual(f.read(), { state: "unavailable", reason: "admission_unavailable" }); }
        finally { fs.openSync = open; fs.lstatSync = stat; fs.readFileSync = read; syncBuiltinESMExports(); }
        assert.equal(probes, 0);
      } else { const reading = f.read(); assert.equal(reading.state, "available");
        if (reading.state === "available") assert.equal(reading.view.stored_clock!.started_at, started); }
      assert.deepEqual(fs.readFileSync(f.metaPath), before);
    }
    assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
  }
});

test("Copied/missing/foreign/over-budget original admission refuses before filesystem probing or getter access", t => {
  const f = fixture(t); const foreign = fixture(t); const absent = fixture(t, meta => { delete meta.template; delete meta.recipe_context_records; }); let healthy: unknown;
  const large = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { padding: "🫧".repeat(300000) }; }); writeJsonAtomic(large.metaPath, healthy);
  let getters = 0; const fake = Object.defineProperty({}, "run", { get() { getters++; throw Error("fake getter"); } });
  const open = fs.openSync, stat = fs.lstatSync; const forbidden = () => assert.fail("Rejected original admission probed filesystem");
  fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; syncBuiltinESMExports();
  try {
    for (const producer of [null, undefined, { ...f.producer }, fake, JSON.parse(JSON.stringify(f.producer))]) {
      const reading = Reflect.apply(readRunRecipeContextView, undefined, [f.stateDir, producer]); assert.deepEqual(reading, { state: "unavailable", reason: "admission_invalid" });
    }
    assert.deepEqual(readRunRecipeContextView(f.stateDir, foreign.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunRecipeContextView(f.stateDir + "/../state", f.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(large.read(), { state: "unavailable", reason: "admission_unavailable" });
    assert.deepEqual(absent.read(), { state: "unavailable", reason: "admission_unavailable" });
  } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(getters, 0);
});

test("Equal-size private-origin edits and changed stored policy cannot gain admission from fresh available index metadata", t => {
  const f = fixture(t); f.publish(); const original = body(f.viewPath); const before = fs.readFileSync(f.viewPath);
  const edited = JSON.parse(JSON.stringify(original)); const prior = edited.recipe.launch.template as string; const raw = "echo /x/private/payload \r\n";
  edited.recipe.launch.template = raw + " ".repeat(prior.length - raw.length); fs.writeFileSync(f.viewPath, JSON.stringify(edited, null, 2) + "\n");
  assert.equal(fs.statSync(f.viewPath).size, before.length); assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
  assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.equal(fs.readFileSync(f.viewPath).includes("/x/private"), true);
  const changedClock = JSON.parse(JSON.stringify(original)); changedClock.stored_clock.supervision.report_every_ms = 60002; f.rewrite(changedClock);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" });
  for (const patch of [{ schema: "wrong" }, { run_instance_id: "foreign" }, { captured_at: "not-a-time" }, { coverage: { truncated: true, redacted: false } }, { private_body: "HIDDEN" }]) {
    f.rewrite({ ...original, ...patch }); const retained = fs.readFileSync(f.viewPath); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_invalid" }); assert.deepEqual(fs.readFileSync(f.viewPath), retained);
  }
});

test("Readonly Recipe reads only metadata and the selected body, with no discovery, native/time or lifecycle effects", t => {
  const f = fixture(t); f.publish(); const unrelated = join(f.stateDir, "evidence", "trace.jsonl"); fs.writeFileSync(unrelated, "PRIVATE_UNRELATED_BODY\n");
  const index = body(f.indexPath); index.entries.trace = { availability: "available", path: "evidence/trace.jsonl", media_type: "application/x-ndjson",
    bytes_total: fs.statSync(unrelated).size, mutable: true, coverage: { truncated: true, redacted: true, history_complete: false } }; writeJsonAtomic(f.indexPath, index);
  fs.writeFileSync(join(f.stateDir, "result.json"), "PRIVATE_MALFORMED_OUTCOME");
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
    mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const kill = process.kill, now = Date.now; const fds = new Map<number, string>(); let selectedReads = 0;
  const allowed = new Set([f.metaPath, f.indexPath, f.viewPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)]);
  fs.openSync = ((path, ...args) => { assert.equal(String(path).includes(".lifecycle"), false); const fd = Reflect.apply(originals.openSync, fs, [path, ...args]); fds.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.equal(allowed.has(fds.get(fd)!), true, "Unrelated body read"); if (fds.get(fd) === f.viewPath) selectedReads++; return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.equal(allowed.has(typeof path === "number" ? fds.get(path)! : String(path)), true); return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => assert.fail("Readonly Recipe attempted side effect or sampling"); fs.readdirSync = forbidden as typeof fs.readdirSync;
  fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync;
  process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try { const read = f.read(); assert.equal(read.state, "available"); if (read.state === "available") assert.equal(read.unchanged(), true); }
  finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(selectedReads, 1); assert.equal(fds.size, 0);
});

test("Root/marker/metadata/index/view replacement during selected read refuses; returned fences never repair or resample", t => {
  for (const change of ["root", "marker", "metadata", "index", "view"] as const) {
    const f = fixture(t); f.publish(); const open = fs.openSync, close = fs.closeSync, read = fs.readSync; const fds = new Set<number>(), readFds = new Set<number>(); let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = fds.delete(fd); const bodyRead = readFds.delete(fd); const result = close(fd); if (selected && bodyRead && !changed) { changed = true;
      if (change === "root") { fs.renameSync(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      else { const path = change === "marker" ? join(f.stateDir, RUN_STATE_OWNERSHIP_FILE) : change === "metadata" ? f.metaPath : change === "index" ? f.indexPath : f.viewPath;
        const bytes = fs.readFileSync(path); fs.renameSync(path, path + ".held"); fs.writeFileSync(path, bytes); }
    } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_changed" }); assert.equal(changed, true); }
    finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; syncBuiltinESMExports(); }
  }
});

test("Unavailable/corrupt/symlinked/denied sources and descriptor failures never create or repair Recipe evidence", t => {
  const f = fixture(t); assert.equal(f.read().state, "unavailable"); assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false); f.publish();
  const saved = fs.readFileSync(f.viewPath); const encoded = body(f.viewPath);
  for (const invalid of ["{bad", "null", Buffer.from([0xff])]) { fs.writeFileSync(f.viewPath, invalid); const index = body(f.indexPath); index.entries.recipe.bytes_total = fs.statSync(f.viewPath).size; writeJsonAtomic(f.indexPath, index); assert.equal(f.read().state, "unavailable"); }
  f.rewrite(encoded); const open = fs.openSync, close = fs.closeSync, read = fs.readSync; const fds = new Set<number>(), readFds = new Set<number>(); let failedClose = false;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { const selected = fds.delete(fd); const bodyRead = readFds.delete(fd); const result = close(fd); if (selected && bodyRead && !failedClose) { failedClose = true; throw Object.assign(new Error("view close EIO"), { code: "EIO" }); } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); assert.equal(failedClose, true); }
  finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; syncBuiltinESMExports(); }
  fs.openSync = ((path, ...args) => { if (String(path) === f.viewPath) throw Object.assign(new Error("private source denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(f.read().state, "unavailable"); } finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.viewPath), saved);
  if (process.platform !== "win32") { fs.renameSync(f.viewPath, f.viewPath + ".held"); fs.symlinkSync(f.viewPath + ".held", f.viewPath); assert.equal(f.read().state, "unavailable"); }
});

test("Independent source and whole-response UTF-8 limits refuse without clipping original data", t => {
  const f = fixture(t); f.publish(); const original = fs.readFileSync(f.viewPath);
  fs.writeFileSync(f.viewPath, Buffer.concat([original, Buffer.alloc(RUN_CONTEXT_RECIPE_MAX_BYTES - original.length, 32)]));
  const index = body(f.indexPath); index.entries.recipe.bytes_total = RUN_CONTEXT_RECIPE_MAX_BYTES; writeJsonAtomic(f.indexPath, index);
  assert.equal(f.read().state, "available"); fs.appendFileSync(f.viewPath, " "); index.entries.recipe.bytes_total++; writeJsonAtomic(f.indexPath, index);
  const read = fs.readSync; const open = fs.openSync, close = fs.closeSync; const fds = new Set<number>(); let bodyReads = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) bodyReads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); }
  finally { fs.readSync = read; fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(bodyReads, 0);
  const large = fixture(t, meta => { meta.run_instance_id = "g".repeat(8000); meta.values = Object.fromEntries(Array.from({ length: 13 }, (_, i) => ["field" + i, "界".repeat(1300)])); });
  large.publish(); assert.ok(fs.statSync(large.viewPath).size <= RUN_CONTEXT_RECIPE_MAX_BYTES);
  assert.deepEqual(large.read(), { state: "unavailable", reason: "response_too_large" });
});

});

await describe("Result metadata and diagnostics", { concurrency: false }, async () => {
/** Generation-bound canonical outcome metadata, explicitly not complete primary text or stop-scope proof. */

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-result-export-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});
const { writeRunResultContextExport, writeRunResultContextIndex, writeRunTraceContextIndex, createRunPrimaryTextPublisher, readRunPrimaryTextSource,
  RUN_CONTEXT_RESULT_MAX_BYTES, RUN_RESULT_DIAGNOSTICS_MAX_BYTES, readRunResultDiagnosticsSource, createRunResultDiagnosticsPublisher, readRunResultDiagnosticOutcome } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult, withRunResultDiagnosticsAdmission, withRunNaturalResultTimingAdmission, readRunNaturalResultTimingAcceptance } = await import("../lib/runs-results.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { readRunSnapshotFacts } = await import("../lib/runs-status.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunTraceEvent } = await import("../lib/runs-trace.ts");
const { readRunContextIndex, runContextExportPath, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");

function fixture(t: TestContext, generation = "generation-a", overrides: Record<string, unknown> | ((meta: { run: string; run_instance_id: string; ownerId: string; state_dir: string }) => Record<string, unknown>) = {}) {
  const root = mkdtempSync(join(agentDir, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "result-view");
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
  const base = { run: "result-view", run_instance_id: generation, ownerId: "owner-a", state_dir: stateDir,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: readProcessIdentity(process.pid),
    outcome_protocol: RUN_OUTCOME_PROTOCOL, template: "echo visible", values: { skill_dir: "/private/result" } };
  const meta = { ...base, ...(typeof overrides === "function" ? overrides(base) : overrides) };
  const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const resultPath = join(stateDir, "result.json");
  const path = join(stateDir, runContextExportPath("result"));
  return { root, stateDir, meta, metaPath, producer, resultPath, path,
    publish: () => writeRunResultContextExport(stateDir, producer),
    publishIndex: () => writeRunResultContextIndex(stateDir, producer) };
}
function body(path: string) { return JSON.parse(readFileSync(path, "utf8")); }
function diagnosticPath(f: { stateDir: string; meta: { run: string; run_instance_id: string; ownerId?: string } }) {
  const key = createHash("sha256").update(JSON.stringify([f.meta.run, f.meta.run_instance_id, f.meta.ownerId ?? null])).digest("hex");
  return join(f.stateDir, "evidence", `result-diagnostics-${key}.json`);
}

function retainedDiagnostics(t: TestContext, fields: Record<string, string> = { command: "recorded command", error: "recorded error", failure_reason: "recorded reason" }) {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 7, ...fields }); f.publishIndex();
  const sourcePath = diagnosticPath(f); const view = body(f.path); const indexPath = join(f.stateDir, "context-index.json");
  const identity = { run: f.meta.run, run_instance_id: f.meta.run_instance_id, ownerId: f.meta.ownerId };
  const replaceView = (value: typeof view) => {
    writeJsonAtomic(f.path, value); const index = body(indexPath);
    index.entries.result.bytes_total = fs.statSync(f.path).size; writeJsonAtomic(indexPath, index);
  };
  return { ...f, sourcePath, view, identity, indexPath, replaceView,
    read: (query: unknown = { field: "error" }) => readRunResultDiagnosticsSource(f.stateDir, identity, query) };
}

function runtimeDiagnostics(t: TestContext, code = 7) {
  const f = fixture(t); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
  const error = " \uFEFF\r\n``" + "界🧪".repeat(2000) + " Bearer PRIVATE_TAIL_SECRET\n ";
  publishRunResult(f.stateDir, f.producer, { code, command: "recorded command", error, failure_reason: "recorded reason" }, { resultDiagnostics: publisher.publish });
  const identity = { run: f.meta.run, run_instance_id: f.meta.run_instance_id, ownerId: f.meta.ownerId };
  return { ...f, identity, sourcePath: diagnosticPath(f), read: (status: unknown = code === 0 ? "done" : "failed") => readRunResultDiagnosticOutcome(f.stateDir, identity, status) };
}

function prospectiveDiagnosticContent(meta: { run: string; run_instance_id: string }, error: string) {
  return JSON.stringify({ schema: "run-result-diagnostics-v1", run: meta.run, run_instance_id: meta.run_instance_id,
    content_scope: "canonical_outcome_diagnostic_strings", privacy_scope: "producer_admission", primary_text: "not_included",
    coverage: { truncated: false, redacted: true }, fields: { error } }, null, 2) + "\n";
}

function encodedSemanticPresence(value: unknown, needle: unknown, depth = 0): boolean {
  assert.ok(depth < 32, "Semantic observation decoder bound exceeded");
  if (JSON.stringify(value) === JSON.stringify(needle)) return true;
  if (typeof value === "string") { let decoded: unknown;
    try { decoded = JSON.parse(value.startsWith("\uFEFF") ? value.slice(1) : value); } catch { return false; }
    return encodedSemanticPresence(decoded, needle, depth + 1);
  }
  if (Array.isArray(value)) return value.some(item => encodedSemanticPresence(item, needle, depth + 1));
  return !!value && typeof value === "object" && Object.entries(value).some(([key, item]) => encodedSemanticPresence(key, needle, depth + 1) || encodedSemanticPresence(item, needle, depth + 1));
}

test("Complete primary and diagnostic sources apply original raw opaque privacy before normalization and every preview/count", t => {
  const opaque = '[ "opaque75" ]';
  const cases = [
    { secret: opaque, text: opaque, needle: ["opaque75"] },
    { secret: "\uFEFF" + opaque, text: "\uFEFF" + opaque, needle: ["opaque75"] },
    { secret: opaque, text: JSON.stringify({ public: "kept", note: opaque }), needle: ["opaque75"], sibling: true },
    { secret: '[ "quote\\\"75" ]', text: '[ "quote\\\"75" ]', needle: ['quote"75'] },
    { secret: String.raw`\u0061`, text: String.raw`[ "\u0061" ]`, needle: ["a"] },
    { secret: "9347834561234567890123456789", text: "9347834561234567890123456789", needle: JSON.parse("9347834561234567890123456789") },
    { secret: ' "opaque75" ', text: ' "opaque75" ', needle: "opaque75" },
    { secret: "api_key", text: JSON.stringify({ api_key: "FORBIDDEN_VALUE75", public: "kept" }), needle: "api_key", sibling: true, generic: "FORBIDDEN_VALUE75" },
    { secret: '"', text: JSON.stringify({ password: "FORBIDDEN_VALUE75", note: '"' }), needle: '"', generic: "FORBIDDEN_VALUE75" },
    { secret: "complete-credential75", text: "HEAD " + "x".repeat(3996) + "complete-credential75 TAIL", needle: "complete-credential75", plain: true },
    { secret: opaque, text: JSON.stringify({ public: "x".repeat(3996), note: opaque }), needle: ["opaque75"], longSibling: true },
  ];
  for (const value of cases) for (const present of [true, false]) {
    const f = fixture(t, "generation-a", { values: { api_key: present ? value.secret : "UNMATCHED_ORIGINAL_CREDENTIAL75" } });
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: present ? "HEALTHY_LIVE_VALUE75" : value.secret } });
    const primary = createRunPrimaryTextPublisher(f.stateDir, f.producer), diagnostics = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    const path = join(f.stateDir, "captures", "command-001", "attempt-001", "stdout.log"); fs.mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value.text);
    const raw = { code: 0, killed: false, stdout: value.text, stderr: "", stdoutFile: path, stdoutBytes: Buffer.byteLength(value.text), stdoutFileBytes: Buffer.byteLength(value.text) };
    primary.observe(raw, { commandId: "command-001", attempts: [{ attempt: 1, result: raw }], session: false }); primary.select(raw);
    assert.equal(primary.readFailure(), undefined); let attempts = 0;
    const resultDiagnostics = (admission: Parameters<typeof diagnostics.publish>[0]) => { attempts++; return diagnostics.publish(admission); };
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 0, error: value.text }, { primaryText: primary.snapshot, resultDiagnostics }), true);
    const root = body(f.resultPath); assert.ok(root.output); assert.ok(root.result_diagnostics); assert.equal(diagnostics.readFailure(), undefined);
    const primaryText = readFileSync(root.output.source.path, "utf8"), source = readFileSync(root.result_diagnostics.source.path), diagnosticText = JSON.parse(source.toString()).fields.error;
    assert.equal(primaryText, diagnosticText); assert.equal(present && primaryText.includes(value.secret), false);
    assert.equal(value.plain ? primaryText.includes(value.secret) : encodedSemanticPresence(primaryText, value.needle), !present);
    if (value.sibling) assert.equal(JSON.parse(primaryText).public, "kept");
    if (value.longSibling) assert.equal(JSON.parse(primaryText).public, "x".repeat(3996));
    if (value.generic) assert.equal(primaryText.includes(value.generic), false);
    assert.equal(root.output.bytes_total, Buffer.byteLength(primaryText)); assert.equal(root.output.chars_total, [...primaryText].length);
    assert.equal(root.output.preview, [...primaryText].slice(0, 160).join("")); assert.equal(root.output.redacted, primaryText !== value.text);
    assert.equal(root.output.source.sha256, createHash("sha256").update(primaryText).digest("hex"));
    assert.equal(root.result_diagnostics.bytes_total, source.length); assert.equal(root.result_diagnostics.source.sha256, createHash("sha256").update(source).digest("hex"));
    const input = [f.metaPath, f.resultPath, path, root.output.source.path, root.result_diagnostics.source.path]; const before = input.map(path => readFileSync(path));
    assert.equal(f.publishIndex().status, "published"); const first = readFileSync(f.resultPath);
    const a = readRunPrimaryTextSource(f.stateDir, f.meta), b = readRunResultDiagnosticsSource(f.stateDir, f.meta, { field: "error" }), c = readRunResultDiagnosticOutcome(f.stateDir, f.meta, "done");
    assert.equal(a.state, "available"); assert.equal(b.state, "available"); assert.equal(c.state, "available");
    if (b.state === "available" && c.state === "available") {
      assert.equal(b.output.text, [...diagnosticText].slice(0, 4000).join("")); assert.equal(b.output.chars_total, [...diagnosticText].length);
      assert.equal(c.excerpt.text, [...diagnosticText].slice(0, 1000).join("")); assert.equal(b.unchanged(), true); assert.equal(c.unchanged(), true);
    }
    assert.deepEqual(input.map(path => readFileSync(path)), before);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7, error: "replacement" }, { resultDiagnostics }), false); assert.equal(attempts, 1); assert.deepEqual(readFileSync(f.resultPath), first);
  }
});

test("Complete source policy preserves public scalar whitespace/BOM and original key decisions without introducing JSON syntax masking", t => {
  const values = [
    ' \r\n[ "public", 1, false, null ]\t\r\n', '\uFEFF \r\n{ "public" : [ 1, 2 ], "space" : "  x  " }\r\n',
    '\uFEFF \t"public scalar"\r\n', ' 9347834561234567890123456789 ', ' false ', ' null ', ' \uFFFD🫧```\r\n',
  ];
  for (const text of values) {
    const f = fixture(t, "generation-a", { values: { api_key: "UNUSED_CREDENTIAL75" } }); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7, error: text }, { resultDiagnostics: publisher.publish }), true);
    assert.equal(body(diagnosticPath(f)).fields.error, text); assert.equal(f.publishIndex().status, "published");
    assert.equal(body(diagnosticPath(f)).fields.error, text); assert.equal(body(f.resultPath).code, 7);
  }
  for (const text of ['\uFEFF{ "password" : "HIDDEN_VALUE75", "public" : "kept" }', JSON.stringify("token=HIDDEN_VALUE75")]) {
    const f = fixture(t); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    publishRunResult(f.stateDir, f.producer, { code: 7, error: text }, { resultDiagnostics: publisher.publish }); const projected = body(diagnosticPath(f)).fields.error;
    assert.doesNotMatch(projected, /HIDDEN_VALUE75/); assert.equal(projected.startsWith("\uFEFF"), text.startsWith("\uFEFF"));
    assert.doesNotThrow(() => JSON.parse(projected.startsWith("\uFEFF") ? projected.slice(1) : projected));
  }
});

test("New complete-text policy refuses unsafe fixed orphan sources without overwriting or fabricating a first result", t => {
  const opaque = '[ "opaque75" ]';
  for (const role of ["primary", "diagnostic"]) {
    const f = fixture(t, "generation-a", { values: { api_key: opaque } });
    fs.mkdirSync(join(f.stateDir, "evidence"));
    const key = createHash("sha256").update(JSON.stringify([f.meta.run, f.meta.run_instance_id, f.meta.ownerId])).digest("hex");
    const sourcePath = role === "primary" ? join(f.stateDir, "evidence", `primary-${key}.txt`) : diagnosticPath(f);
    const unsafe = role === "primary" ? opaque : prospectiveDiagnosticContent(f.meta, opaque); writeFileSync(sourcePath, unsafe);
    if (role === "primary") {
      const primary = createRunPrimaryTextPublisher(f.stateDir, f.producer), path = join(f.stateDir, "captures", "command-001", "attempt-001", "stdout.log");
      fs.mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, opaque);
      const raw = { code: 0, killed: false, stdout: opaque, stderr: "", stdoutFile: path, stdoutBytes: Buffer.byteLength(opaque) };
      primary.observe(raw, { commandId: "command-001", attempts: [{ attempt: 1, result: raw }], session: false });
      assert.throws(() => primary.select(raw), /source identity already fixes different bytes/);
    } else {
      const diagnostics = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
      assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 0, error: opaque }, { resultDiagnostics: diagnostics.publish }), /identity already fixes different bytes/);
    }
    assert.equal(readFileSync(sourcePath, "utf8"), unsafe); assert.equal(existsSync(f.resultPath), false);
    assert.equal(existsSync(f.path), false); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
  }
});

test("Original Result context fact/reference privacy precedes source retention without altering genuine first-result bindings", t => {
  for (const field of ["recorded_at", "source_path", "source_hash"] as const) for (const present of [true, false])
    for (const code of [0, 7]) for (const capture of [false, true]) {
      const error = "recorded error"; let secret = "";
      const f = fixture(t, "generation-a", meta => {
        // Complete predeclared credential ':' overlaps every genuine ISO timestamp; it is not a guessed lost prefix.
        secret = field === "recorded_at" ? ":" : field === "source_path" ? diagnosticPath({ stateDir: meta.state_dir, meta })
          : createHash("sha256").update(prospectiveDiagnosticContent(meta, error)).digest("hex");
        return { values: { api_key: present ? secret : "UNMATCHED_ORIGINAL_CREDENTIAL" } };
      });
      const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
      if (capture) assert.equal(claimRunStop(f.stateDir, { ownerId: f.meta.ownerId, runInstanceId: f.meta.run_instance_id, reason: "manual_kill" }).status, "stop_requested");
      let timingToken: unknown;
      assert.equal(publishRunResult(f.stateDir, f.producer, { code, error }, { resultDiagnostics: publisher.publish,
        naturalResultTiming: token => { timingToken = token; } }), true);
      const receipt = readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, timingToken);
      assert.equal(receipt.state, capture ? "unavailable" : "available");
      const canonical = body(f.resultPath); const sourcePath = diagnosticPath(f), sourceBytes = () => existsSync(sourcePath) ? readFileSync(sourcePath) : undefined;
      const source = sourceBytes();
      // The first publisher now refuses private refs; do not fabricate an unsafe historical issuance for this context test.
      if (present && field !== "recorded_at") {
        assert.equal(canonical.result_diagnostics, null); assert.equal(canonical.result_diagnostics_unavailable, "source_reference_redacted"); assert.equal(source, undefined);
      } else {
        const target = field === "recorded_at" ? canonical.completedAt : field === "source_path" ? canonical.result_diagnostics.source.path : canonical.result_diagnostics.source.sha256;
        assert.equal(field === "recorded_at" ? target.includes(secret) : target === secret, true, "Data canary must match actual issued fact/reference, not reconstruct authority");
      }
      assert.equal(canonical.code, code); assert.equal(canonical.terminal_acceptance, capture ? "after_stop_claim" : "natural");
      writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: present ? "HEALTHY_LIVE_VALUE" : secret } });
      const paths = [f.metaPath, f.resultPath, ...(source === undefined ? [] : [sourcePath])]; const before = paths.map(path => readFileSync(path));
      const open = fs.openSync, stat = fs.lstatSync; let sourceProbes = 0;
      fs.openSync = ((path, ...args) => { if (String(path) === sourcePath) sourceProbes++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
      fs.lstatSync = ((path, ...args) => { if (String(path) === sourcePath) sourceProbes++; return Reflect.apply(stat, fs, [path, ...args]); }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      try {
        const result = f.publish();
        if (present) { assert.deepEqual(result, { status: "unavailable", reason: "result_metadata_redacted" }); assert.equal(sourceProbes, 0); }
        else assert.equal(result.status, "written");
      } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
      assert.deepEqual(paths.map(path => readFileSync(path)), before); assert.deepEqual(sourceBytes(), source);
      assert.equal(existsSync(f.path), !present); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
      assert.equal(f.publishIndex().status, "published"); const index = readRunContextIndex(f.stateDir, f.meta);
      assert.equal(index.state, "available"); if (index.state === "available") {
        const entry = index.index.entries.result; assert.equal(entry.availability, present ? "unavailable" : "available");
        if (entry.availability === "unavailable") assert.equal(entry.reason, "result_metadata_redacted");
      }
      if (!present) {
        const view = body(f.path); assert.equal(view.outcome.recorded_at, canonical.completedAt);
        assert.equal(view.diagnostics.source.path, canonical.result_diagnostics.source.path); assert.equal(view.diagnostics.source.sha256, canonical.result_diagnostics.source.sha256);
        assert.equal(view.outcome.code, code); assert.equal(view.outcome.acceptance, capture ? "capture_only" : "natural");
      }
      assert.deepEqual(readFileSync(f.resultPath), before[1]); assert.deepEqual(sourceBytes(), source);
      assert.deepEqual(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, timingToken), receipt);
    }
});

test("Result recorded fact privacy remains required without diagnostic fields or a retained diagnostic source", t => {
  for (const present of [true, false]) for (const code of [0, 7]) for (const capture of [false, true]) {
    const f = fixture(t, "generation-a", { values: { api_key: present ? ":" : "UNMATCHED_ORIGINAL_CREDENTIAL" } });
    const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    if (capture) assert.equal(claimRunStop(f.stateDir, { ownerId: f.meta.ownerId, runInstanceId: f.meta.run_instance_id, reason: "manual_kill" }).status, "stop_requested");
    assert.equal(publishRunResult(f.stateDir, f.producer, { code }, { resultDiagnostics: publisher.publish }), true);
    const root = readFileSync(f.resultPath); const canonical = body(f.resultPath); assert.equal(canonical.result_diagnostics, null);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: present ? "HEALTHY_LIVE_VALUE" : ":" } });
    const result = f.publish();
    if (present) assert.deepEqual(result, { status: "unavailable", reason: "result_metadata_redacted" });
    else { assert.equal(result.status, "written"); assert.equal(body(f.path).diagnostics.state, "not_recorded"); assert.equal(body(f.path).outcome.recorded_at, canonical.completedAt); }
    assert.equal(existsSync(diagnosticPath(f)), false); assert.deepEqual(readFileSync(f.resultPath), root);
  }
});

test("Result context metadata refusal preserves prior view/source/index, first binding and explicit safe refresh across source edits", t => {
  for (const field of ["recorded_at", "source_path", "source_hash"] as const) for (const present of [true, false])
    for (const capture of [false, true]) {
      const error = "recorded error", privateTime = "2001-01-01T00:00:00.000Z"; let secret = "";
      const f = fixture(t, "generation-a", meta => {
        secret = field === "recorded_at" ? privateTime : field === "source_path" ? diagnosticPath({ stateDir: meta.state_dir, meta })
          : createHash("sha256").update(prospectiveDiagnosticContent(meta, error)).digest("hex");
        return { values: { api_key: present ? secret : "UNMATCHED_ORIGINAL_CREDENTIAL" } };
      });
      const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer), code = capture ? 0 : 7;
      if (capture) assert.equal(claimRunStop(f.stateDir, { ownerId: f.meta.ownerId, runInstanceId: f.meta.run_instance_id, reason: "manual_kill" }).status, "stop_requested");
      assert.equal(publishRunResult(f.stateDir, f.producer, { code, ...(field === "recorded_at" ? { error } : {}) }, { resultDiagnostics: publisher.publish }), true);
      const originalRoot = readFileSync(f.resultPath); const original = body(f.resultPath); assert.notEqual(original.completedAt, privateTime);
      assert.equal(f.publishIndex().status, "published"); // No diagnostic fields must not refuse an un-emitted path/hash.
      const sourcePath = diagnosticPath(f), indexPath = join(f.stateDir, "context-index.json");
      const priorView = readFileSync(f.path), priorIndex = readFileSync(indexPath), priorSource = existsSync(sourcePath) ? readFileSync(sourcePath) : null;
      // Explicit controlled canonical-report edits, not new genuine first issuance, callback repair or publisher rollback.
      const selected = { ...original, ...(field === "recorded_at" ? { completedAt: privateTime } : { error }) };
      writeJsonAtomic(f.resultPath, selected); writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: present ? "HEALTHY_LIVE_VALUE" : secret } });
      const selectedBytes = readFileSync(f.resultPath); const result = f.publish();
      if (present) {
        assert.deepEqual(result, { status: "unavailable", reason: "result_metadata_redacted" });
        assert.deepEqual(readFileSync(f.path), priorView); assert.deepEqual(readFileSync(indexPath), priorIndex);
        assert.deepEqual(existsSync(sourcePath) ? readFileSync(sourcePath) : null, priorSource);
      } else {
        assert.equal(result.status, "written"); const view = body(f.path);
        assert.equal(view.outcome.recorded_at, selected.completedAt); assert.equal(view.diagnostics.source.path, sourcePath);
        assert.equal(view.diagnostics.source.sha256, createHash("sha256").update(readFileSync(sourcePath)).digest("hex"));
      }
      assert.deepEqual(readFileSync(f.resultPath), selectedBytes);
      for (const key of ["code", "terminal_acceptance", "stop_claim_id", "result_diagnostics_protocol", "result_diagnostics", "result_diagnostics_unavailable"])
        assert.deepEqual(body(f.resultPath)[key], original[key], "Context refresh cannot repair or change the first canonical binding/outcome");
      assert.equal(f.publishIndex().status, "published"); const index = readRunContextIndex(f.stateDir, f.meta);
      assert.equal(index.state, "available"); if (index.state === "available") assert.equal(index.index.entries.result.availability, present ? "unavailable" : "available");
      assert.deepEqual(readRunResultDiagnosticsSource(f.stateDir, f.meta, { field: "error" }).state, present ? "unavailable" : "available");
      const retainedSource = existsSync(sourcePath) ? readFileSync(sourcePath) : null;
      writeFileSync(f.resultPath, originalRoot); // Explicit fixture restoration, never export/read repair.
      assert.equal(f.publishIndex().status, "published"); const refreshed = body(f.path);
      assert.equal(refreshed.outcome.recorded_at, original.completedAt); assert.equal(refreshed.outcome.code, code);
      assert.equal(refreshed.diagnostics.state, field === "recorded_at" ? "available" : "not_recorded");
      assert.deepEqual(existsSync(sourcePath) ? readFileSync(sourcePath) : null, retainedSource, "Healthy refresh must not erase an orphan source");
      assert.deepEqual(readFileSync(f.resultPath), originalRoot);
    }
});

test("Eligible canonical diagnostic outcomes verify source only after body-free ambient checks, then freeze literal metadata without legacy fallback", async t => {
  const { summarizeRuns, detectRunTransitions, collectRunCompletionBatchMembers, hasRunCompletionBatchMembers } = await import("../lib/observability.ts");
  const { admitRunCompletionBatch, formatRunCompletionBatchMessage, readRunDeliveryJournal } = await import("../lib/run-delivery.ts");
  const f = runtimeDiagnostics(t); writeFileSync(join(f.stateDir, "stdout.log"), "PRIVATE_LEGACY_BODY");
  const open = fs.openSync; let opens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.sourcePath) opens++;
    assert.notEqual(String(path), f.path); assert.notEqual(String(path), join(f.stateDir, "context-index.json"));
    return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const summary = summarizeRuns(f.root); const transitions = detectRunTransitions(new Map([[f.stateDir, "running"]]), summary);
    assert.equal(transitions.length, 1); assert.equal(transitions[0]!.semanticResult?.hasResultDiagnostics, true);
    assert.equal(transitions[0]!.semanticResult?.body, undefined); assert.equal(hasRunCompletionBatchMembers(transitions, summary.runs), true); assert.equal(opens, 0);
    const members = collectRunCompletionBatchMembers(transitions, summary.runs); assert.equal(members.length, 1); assert.ok(opens > 0);
    const captured = members[0]!; assert.equal(captured.output, undefined); assert.ok(captured.result_diagnostics); assert.equal(captured.diagnostic_excerpt?.field, "error");
    const raw = body(f.sourcePath).fields.error as string; assert.equal(captured.diagnostic_excerpt?.text, Array.from(raw).slice(0, 1000).join(""));
    assert.equal(captured.diagnostic_excerpt?.chars_total, Array.from(raw).length); assert.doesNotMatch(raw, /PRIVATE_TAIL_SECRET/);
    const packet = admitRunCompletionBatch({ members, ownerId: "owner-a", tempDir: f.root }); const message = formatRunCompletionBatchMessage(packet);
    const header = parseDocument(message.slice(4, message.indexOf("\n---\n", 4))); assert.deepEqual(header.errors, []);
    const sourceEntries = header.toJS().files.groups.flatMap((group: any) => group.entries.map((entry: any) => ({ ...entry, root: group.root })));
    assert.ok(sourceEntries.some((entry: any) => entry.role === "diagnostic_metadata" && join(entry.root, entry.path) === f.sourcePath
      && entry.source === undefined));
    assert.deepEqual(packet.members[0].result_diagnostics, captured.result_diagnostics);
    assert.doesNotMatch(message, /PRIVATE_LEGACY_BODY|PRIVATE_TAIL_SECRET/);
    const sourceOpens = opens; rmSync(f.sourcePath);
    assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(f.root, "owner-a").completion_batch!), message); assert.equal(opens, sourceOpens);
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
  const lost = runtimeDiagnostics(t); rmSync(lost.sourcePath); writeFileSync(join(lost.stateDir, "stdout.log"), "PRIVATE_LOST_BODY");
  const summary = summarizeRuns(lost.root); const members = collectRunCompletionBatchMembers(detectRunTransitions(new Map([[lost.stateDir, "running"]]), summary), summary.runs);
  assert.equal(members[0]?.result_diagnostics, null); assert.equal(members[0]?.result_diagnostics_unavailable, "source_unavailable"); assert.equal(members[0]?.output, undefined);
  assert.equal(existsSync(lost.sourcePath), false); assert.equal(existsSync(lost.path), false); assert.equal(existsSync(join(lost.stateDir, "context-index.json")), false);
});

test("Canonical diagnostics preserve first unavailability and refuse foreign/capture/status bindings before source reads", t => {
  const f = runtimeDiagnostics(t); const original = body(f.resultPath); const open = fs.openSync; let opens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.sourcePath) opens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(f.read("done"), { state: "unavailable", reason: "outcome_mismatch" });
    assert.deepEqual(f.read("killed"), { state: "unavailable", reason: "outcome_mismatch" });
    for (const patch of [
      { result_diagnostics: null, result_diagnostics_unavailable: "first_saved_loss" },
      { result_diagnostics_protocol: "actor permission" },
      { result_diagnostics: { ...original.result_diagnostics, source: { ...original.result_diagnostics.source, path: join(f.stateDir, "evidence", `result-diagnostics-${"a".repeat(64)}.json`) } } },
      { terminal_acceptance: "after_stop_claim", stop_claim_id: "capture-only" },
    ]) {
      writeJsonAtomic(f.resultPath, { ...original, ...patch }); const reading = f.read(); assert.equal(reading.state, "unavailable");
      if (Object.hasOwn(patch, "result_diagnostics_unavailable")) assert.deepEqual(reading, { state: "unavailable", reason: "diagnostics_unavailable", result_diagnostics_unavailable: "first_saved_loss" });
      if (patch.terminal_acceptance) assert.deepEqual(reading, { state: "unavailable", reason: "nonterminal_capture" });
    }
    assert.equal(opens, 0); assert.equal(existsSync(f.sourcePath), true);
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
});

test("Canonical diagnostics validate the complete source field set and source/result fences without view/index repair", t => {
  const f = runtimeDiagnostics(t); const original = body(f.resultPath); const saved = body(f.sourcePath);
  for (const modify of [
    (source: typeof saved) => { source.run_instance_id = "other"; },
    (source: typeof saved) => { source.fields.failure_reason = "lone \uD800"; },
    (source: typeof saved) => { source.fields.output = "PRIVATE_UNAUTHORIZED_BODY"; },
    (source: typeof saved) => { delete source.fields.failure_reason; },
  ]) {
    const source = structuredClone(saved); modify(source); const text = JSON.stringify(source); writeFileSync(f.sourcePath, text);
    writeJsonAtomic(f.resultPath, { ...original, result_diagnostics: { ...original.result_diagnostics, bytes_total: Buffer.byteLength(text),
      source: { ...original.result_diagnostics.source, sha256: createHash("sha256").update(text).digest("hex") } } });
    assert.deepEqual(f.read(), { state: "unavailable", reason: "source_invalid" });
  }
  const text = JSON.stringify(saved); writeFileSync(f.sourcePath, text);
  const canonical = { ...original, result_diagnostics: { ...original.result_diagnostics, bytes_total: Buffer.byteLength(text), source: { ...original.result_diagnostics.source,
    sha256: createHash("sha256").update(text).digest("hex") } } }; writeJsonAtomic(f.resultPath, canonical);
  const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const tracked = new Set<number>(); let changed = false;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.sourcePath) tracked.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (tracked.has(fd) && !changed) { changed = true; writeJsonAtomic(f.resultPath, { ...canonical, code: 0 }); }
    return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { tracked.delete(fd); close(fd); }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_changed" }); }
  finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(tracked.size, 0); assert.equal(existsSync(f.path), false); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

const resultCallbackNames = ["prepare", "primaryText", "artifactInventory", "resultDiagnostics"] as const;
type ResultCallbackName = typeof resultCallbackNames[number];
function resultCallbacks(onCall: (name: ResultCallbackName) => void) {
  return {
    prepare: () => { onCall("prepare"); },
    primaryText: () => { onCall("primaryText"); return { output: null, output_unavailable: "not_selected" } as const; },
    artifactInventory: () => { onCall("artifactInventory"); return { artifact_inventory: null, artifact_inventory_unavailable: "not_declared" } as const; },
    resultDiagnostics: () => { onCall("resultDiagnostics"); return { result_diagnostics: null, result_diagnostics_unavailable: "not_recorded" } as const; },
  };
}

test("First-result callbacks fence changed producer authority before invoking the next evidence callback", t => {
  for (const stage of resultCallbackNames) for (const mutation of ["generation", "owner", "pid", "native"] as const) {
    const f = fixture(t); const calls: ResultCallbackName[] = []; const effect = join(f.stateDir, "retained-callback-effect"); const kill = process.kill;
    const options = resultCallbacks(name => {
      calls.push(name); if (name !== stage) return;
      writeFileSync(effect, `retained ${stage} effect`);
      if (mutation === "native") process.kill = (() => { throw Object.assign(Error("controlled native absence"), { code: "ESRCH" }); }) as typeof process.kill;
      else writeJsonAtomic(f.metaPath, { ...f.meta, ...(mutation === "generation" ? { run_instance_id: "changed-generation" }
        : mutation === "owner" ? { ownerId: "changed-owner" } : { pid: process.pid + 1 }) });
    });
    try {
      assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 7, error: "real failure metadata" }, options),
        /Run result producer (?:generation|owner|process|process identity) changed/);
    } finally { process.kill = kill; }
    assert.deepEqual(calls, resultCallbackNames.slice(0, resultCallbackNames.indexOf(stage) + 1), `${stage}/${mutation}: later source callbacks must not run with stale producer authority`);
    assert.equal(readFileSync(effect, "utf8"), `retained ${stage} effect`); assert.equal(existsSync(f.resultPath), false);
    assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
  }
});

test("First-result callbacks refuse deferred completions without awaiting or invoking then/catch hooks", async t => {
  const messages = { prepare: "Run result preparation must complete synchronously.", primaryText: "Run primary text binding must complete synchronously.",
    artifactInventory: "Run artifact inventory binding must complete synchronously.", resultDiagnostics: "Run result diagnostics binding must complete synchronously." };
  for (const stage of resultCallbackNames) for (const kind of ["resolved", "rejected", "overridden", "own", "inherited", "callable"] as const) {
    const f = fixture(t); const calls: ResultCallbackName[] = []; const effect = join(f.stateDir, "deferred-callback-effect"); let hookReads = 0;
    const forbidden = () => { hookReads++; throw Error("Deferred completion hook must not be invoked"); };
    const options = resultCallbacks(name => { calls.push(name); });
    options[stage] = (() => {
      calls.push(stage); writeFileSync(effect, "retained before deferred refusal");
      if (kind === "resolved") return Promise.resolve({});
      if (kind === "rejected") return Promise.reject(Error("original deferred rejection"));
      if (kind === "overridden") return Object.defineProperties(Promise.reject(Error("original overridden rejection")), { then: { get: forbidden }, catch: { get: forbidden } });
      const protocol = Object.defineProperty({}, "then", { get: forbidden });
      return kind === "own" ? protocol : kind === "inherited" ? Object.create(protocol) : Object.defineProperty(forbidden, "then", { get: forbidden });
    }) as never;
    assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 7 }, options), error => error instanceof Error && error.message === messages[stage]);
    assert.deepEqual(calls, resultCallbackNames.slice(0, resultCallbackNames.indexOf(stage) + 1)); assert.equal(hookReads, 0);
    assert.equal(readFileSync(effect, "utf8"), "retained before deferred refusal"); assert.equal(existsSync(f.resultPath), false);
    assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
  }
  // Rejected native promises must settle after admission, without an unhandled rejection or lock-held wait.
  await new Promise(resolve => setImmediate(resolve));
});

test("First-result callback throws preserve the original cause and partial effects without later callbacks or synthetic results", t => {
  for (const stage of resultCallbackNames) {
    const f = fixture(t); const calls: ResultCallbackName[] = []; const failure = Object.assign(Error(`exact ${stage} failure`), { code: "EIO" });
    const effect = join(f.stateDir, "partial-source-effect");
    const options = resultCallbacks(name => {
      calls.push(name); if (name !== stage) return;
      writeFileSync(effect, "partial source is not rolled back"); writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "changed-before-throw" }); throw failure;
    });
    assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 7 }, options), error => error === failure);
    assert.deepEqual(calls, resultCallbackNames.slice(0, resultCallbackNames.indexOf(stage) + 1));
    assert.equal(readFileSync(effect, "utf8"), "partial source is not rolled back"); assert.equal(existsSync(f.resultPath), false);
    assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
  }
});

test("First-result callbacks retain real codes, ignore ordinary synchronous preparation values and never rerun duplicate evidence", t => {
  for (const code of [0, 7]) for (const returned of [undefined, null, false, 1, "ignored", { ignored: true }, () => undefined]) {
    const f = fixture(t, "generation-a", { process_identity: undefined }); const calls: ResultCallbackName[] = [];
    const options = resultCallbacks(name => { calls.push(name); }); options.prepare = (() => { calls.push("prepare"); return returned; }) as never;
    assert.equal(publishRunResult(f.stateDir, f.producer, { code }, options), true); assert.deepEqual(calls, resultCallbackNames);
    assert.equal(body(f.resultPath).code, code); assert.equal(body(f.resultPath).terminal_acceptance, "natural"); assert.equal(body(f.resultPath).ignored, undefined);
    const bytes = readFileSync(f.resultPath);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: code === 0 ? 7 : 0 }, resultCallbacks(() => assert.fail("Duplicate invoked late evidence"))), false);
    assert.deepEqual(readFileSync(f.resultPath), bytes);
  }
});

type NaturalTimingToken = Parameters<typeof withRunNaturalResultTimingAdmission>[2];

test("Natural timing admission is original, postcommit and callback-scoped; passive acceptance carries no timing or body authority", t => {
  for (const code of [0, 7]) {
    const f = fixture(t); let token: NaturalTimingToken | undefined; let diagnostic: Parameters<typeof withRunResultDiagnosticsAdmission>[2] | undefined;
    assert.equal(publishRunResult(f.stateDir, f.producer, { code, error: "PRIVATE_DIAGNOSTIC", output: "PRIVATE_BODY" }, {
      resultDiagnostics: value => { diagnostic = value; return { result_diagnostics: null, result_diagnostics_unavailable: "not_recorded" }; },
      naturalResultTiming: value => {
        token = value; assert.equal(body(f.resultPath).terminal_acceptance, "natural"); assert.equal(existsSync(join(f.stateDir, "trace.jsonl")), false);
        assert.ok(Object.isFrozen(value)); assert.equal(JSON.stringify(value), '{"kernel_only":true}');
        const accepted = readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, value);
        withRunNaturalResultTimingAdmission(f.stateDir, f.producer, value, receipt => {
          assert.equal(receipt, accepted);
          assert.deepEqual(receipt, { state: "available", identity: { run: f.meta.run, run_instance_id: f.meta.run_instance_id, ownerId: f.meta.ownerId },
            code, recorded_status: code === 0 ? "done" : "failed", completed_at: body(f.resultPath).completedAt, acceptance: "natural", timing: "not_asserted" });
          assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.identity)); assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_|state_dir|cwd|origin|elapsed/);
        });
        for (const fake of [{ ...value }, JSON.parse(JSON.stringify(value)), diagnostic!, Object.create(value), accepted]) {
          assert.throws(() => withRunNaturalResultTimingAdmission(f.stateDir, f.producer, fake, () => assert.fail("Forged admission")), /active runtime-local admission/);
          assert.deepEqual(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, fake), { state: "unavailable", reason: "admission_invalid" });
        }
        assert.throws(() => withRunResultDiagnosticsAdmission(f.stateDir, f.producer, value, () => assert.fail("Timing admitted diagnostics")), /active runtime-local admission/);
        assert.throws(() => withRunNaturalResultTimingAdmission(f.stateDir, { ...f.producer }, value, () => assert.fail()), /active runtime-local admission/);
        assert.throws(() => withRunNaturalResultTimingAdmission(join(f.root, "alias"), f.producer, value, () => assert.fail()), /active runtime-local admission/);
        return { elapsed_ms: 123, timing: "terminal", origin: "a returned DTO is not timing authority" };
      },
      trace: { kind: code === 0 ? "run.done" : "run.failed", data: { code } },
    }), true);
    assert.ok(token); const receipt = readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, token); assert.equal(receipt.state, "available");
    assert.throws(() => withRunNaturalResultTimingAdmission(f.stateDir, f.producer, token!, () => assert.fail("Late action")), /active runtime-local admission/);
    assert.deepEqual(readRunNaturalResultTimingAcceptance(f.stateDir, { ...f.producer }, token), { state: "unavailable", reason: "admission_mismatch" });
    assert.deepEqual(readRunNaturalResultTimingAcceptance(join(f.root, "alias"), f.producer, token), { state: "unavailable", reason: "admission_mismatch" });
    const bytes = readFileSync(f.resultPath);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code }, { naturalResultTiming: () => assert.fail("Duplicate observer") }), false);
    assert.deepEqual(readFileSync(f.resultPath), bytes); assert.doesNotMatch(bytes.toString(), /kernel_only|naturalResultTiming|elapsed_ms|a returned DTO/);
  }
});

test("Post-stop captures and earlier callback failures never create natural timing admission", t => {
  const stopped = fixture(t);
  assert.equal(claimRunStop(stopped.stateDir, { ownerId: stopped.meta.ownerId, runInstanceId: stopped.meta.run_instance_id, reason: "manual_kill" },
    { verifyIdentity: () => ({ status: "valid", valid: true }) }).status, "stop_requested");
  assert.equal(publishRunResult(stopped.stateDir, stopped.producer, { code: 0, naturalResultTiming: true, terminal_timing: { elapsed_ms: 1 } },
    { naturalResultTiming: () => assert.fail("Captured result minted natural timing authority") }), true);
  assert.equal(body(stopped.resultPath).terminal_acceptance, "after_stop_claim");
  const forbidden = Object.defineProperty({}, "kernel_only", { get() { assert.fail("Reader inspected actor permission flag"); } });
  assert.deepEqual(readRunNaturalResultTimingAcceptance(stopped.stateDir, stopped.producer, forbidden), { state: "unavailable", reason: "admission_invalid" });
  for (const stage of resultCallbackNames) {
    const f = fixture(t); const failure = Error(`earlier ${stage} failure`);
    const options = resultCallbacks(name => { if (name === stage) throw failure; });
    assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 0 }, { ...options, naturalResultTiming: () => assert.fail("Early observer") }), error => error === failure);
    assert.equal(existsSync(f.resultPath), false);
  }
});

test("Failed canonical publication never emits timing admission; accepted receipt survives exact later Trace failure", t => {
  for (const mode of ["before_commit", "after_replace", "trace"] as const) {
    const f = fixture(t); const failure = Object.assign(Error(`exact ${mode} EIO`), { code: "EIO" }); let token: NaturalTimingToken | undefined;
    const rename = fs.renameSync, write = fs.writeFileSync;
    fs.renameSync = ((from, to) => {
      if (String(to) === f.resultPath && mode !== "trace") { assert.equal(token, undefined); if (mode === "after_replace") rename(from, to); throw failure; }
      return rename(from, to);
    }) as typeof fs.renameSync;
    fs.writeFileSync = ((path, ...args) => { if (mode === "trace" && String(path) === join(f.stateDir, "trace.jsonl")) throw failure;
      return Reflect.apply(write, fs, [path, ...args]); }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => publishRunResult(f.stateDir, f.producer, { code: 7 }, { naturalResultTiming: value => { token = value; },
        trace: { kind: "run.failed", data: { code: 7 } } }), error => error === failure);
    } finally { fs.renameSync = rename; fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(existsSync(f.resultPath), mode !== "before_commit");
    assert.equal(token !== undefined, mode === "trace");
    if (token) {
      assert.equal(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, token).state, "available");
      assert.throws(() => withRunNaturalResultTimingAdmission(f.stateDir, f.producer, token!, () => assert.fail("Late action")), /active runtime-local admission/);
    } else assert.deepEqual(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, token), { state: "unavailable", reason: "admission_invalid" });
    if (!existsSync(f.resultPath)) assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7 }), true); // Explicit fixture publication, not product retry.
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7 }, { naturalResultTiming: () => assert.fail("Existing file replayed acceptance event") }), false);
    if (!token) assert.deepEqual(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, body(f.resultPath)), { state: "unavailable", reason: "admission_invalid" });
  }
});

test("Natural timing observer/actions revoke on deferred, authority and exact callback errors without undoing accepted results", async t => {
  for (const mode of ["resolved", "rejected", "then_getter", "action_deferred", "changed", "throw"] as const) {
    const f = fixture(t); const failure = Error(`natural observer ${mode}`); let token: NaturalTimingToken | undefined; let hookReads = 0;
    const invoke = () => publishRunResult(f.stateDir, f.producer, { code: 7 }, { naturalResultTiming: admission => {
      token = admission; writeFileSync(join(f.stateDir, "observer-effect"), mode);
      if (mode === "resolved") return Promise.resolve();
      if (mode === "rejected") return Promise.reject(failure);
      if (mode === "then_getter") return Object.defineProperty({}, "then", { get() { hookReads++; throw failure; } });
      withRunNaturalResultTimingAdmission(f.stateDir, f.producer, admission, () => {
        if (mode === "action_deferred") return Promise.reject(failure);
        if (mode === "throw") throw failure;
        writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "changed-observer-generation" });
      });
    }, trace: { kind: "run.failed", data: { code: 7 } } });
    assert.throws(invoke, error => mode === "throw" ? error === failure : error instanceof Error && error.message ===
      (mode === "changed" ? "Run result producer generation changed." : mode === "action_deferred"
        ? "Run natural result timing admission must complete synchronously." : "Run natural result timing observer must complete synchronously."));
    assert.ok(token); assert.equal(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, token).state, "available");
    assert.throws(() => withRunNaturalResultTimingAdmission(f.stateDir, f.producer, token!, () => assert.fail("Expired action")), /active runtime-local admission/);
    assert.equal(body(f.resultPath).code, 7); assert.equal(body(f.resultPath).terminal_acceptance, "natural");
    assert.equal(readFileSync(join(f.stateDir, "observer-effect"), "utf8"), mode); assert.equal(hookReads, 0);
    assert.equal(existsSync(join(f.stateDir, "trace.jsonl")), false); assert.equal(existsSync(mutationLockPath(join(f.stateDir, ".lifecycle"))), false);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("Natural timing receipts are pure historical metadata, never current source availability or frozen elapsed", t => {
  const f = fixture(t, "generation-a", { cwd: process.cwd() }); let token: NaturalTimingToken | undefined;
  publishRunResult(f.stateDir, f.producer, { code: 0 }, { naturalResultTiming: value => { token = value; } }); assert.ok(token);
  const receipt = readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, token);
  const facts = readRunSnapshotFacts(f.stateDir, { run: f.meta.run, run_instance_id: f.meta.run_instance_id, ownerId: f.meta.ownerId }, new Date().toISOString());
  assert.equal(facts.state, "available", JSON.stringify(facts)); if (facts.state === "available") assert.deepEqual(facts.facts.timing, { basis: "unproven" });
  rmSync(f.resultPath); const read = fs.readFileSync, open = fs.openSync, lstat = fs.lstatSync, stat = fs.statSync, kill = process.kill, now = Date.now;
  const forbidden = () => { throw Error("Historical acceptance reader performed IO/process/time observation"); };
  fs.readFileSync = forbidden as typeof fs.readFileSync; fs.openSync = forbidden as typeof fs.openSync;
  fs.lstatSync = forbidden as typeof fs.lstatSync; fs.statSync = forbidden as typeof fs.statSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden;
  syncBuiltinESMExports();
  try { assert.equal(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, token), receipt); }
  finally { fs.readFileSync = read; fs.openSync = open; fs.lstatSync = lstat; fs.statSync = stat; process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(Object.hasOwn(receipt, "elapsed_ms"), false); assert.deepEqual(readRunNaturalResultTimingAcceptance(f.stateDir, f.producer, { ...receipt }), { state: "unavailable", reason: "admission_invalid" });
});

test("Runtime diagnostic source publication requires the active first-result candidate and captures full fixed privacy without premature view/status claims", t => {
  const f = fixture(t, "generation-a", { values: { api_key: "ADMITTED_SECRET", skill_dir: "/admitted/origin" } });
  const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  assert.throws(() => publisher.publish({ kernel_only: true }), /active runtime-local admission/);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: {} });
  const error = "\uFEFF \r\n``" + "界🧪".repeat(5000) + " ADMITTED_SECRET /admitted/origin/tool \uFFFD\n ";
  let admission: Parameters<typeof publisher.publish>[0] | undefined;
  assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7, error, failure_reason: "password=HIDDEN_REASON", output: "HIDDEN_PRIMARY" }, {
    resultDiagnostics: value => { admission = value; return publisher.publish(value); },
  }), true);
  const result = body(f.resultPath); const reference = result.result_diagnostics;
  assert.equal(result.code, 7); assert.equal(result.terminal_acceptance, "natural"); assert.equal(result.result_diagnostics_protocol, "run-result-diagnostics-v1");
  assert.deepEqual(reference.fields, ["error", "failure_reason"]); assert.equal(reference.source.path, diagnosticPath(f));
  const bytes = readFileSync(reference.source.path); const source = JSON.parse(bytes.toString("utf8"));
  assert.equal(reference.source.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(reference.bytes_total, bytes.length);
  assert.equal(source.fields.error, error.replaceAll("ADMITTED_SECRET", "[REDACTED]").replaceAll("/admitted/origin", "[PRIVATE_RECIPE_ORIGIN]"));
  assert.doesNotMatch(bytes.toString(), /HIDDEN_|ADMITTED_SECRET|\/admitted\/origin/); assert.equal(source.primary_text, "not_included");
  assert.equal(publisher.readFailure(), undefined); assert.equal(existsSync(f.path), false); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
  assert.throws(() => publisher.publish(admission!), /active runtime-local admission/);
  assert.throws(() => withRunResultDiagnosticsAdmission(f.stateDir, f.producer, { ...admission! }, () => assert.fail()), /active runtime-local admission/);
  const before = readFileSync(f.resultPath); rmSync(reference.source.path);
  assert.equal(publishRunResult(f.stateDir, f.producer, { code: 0 }, { resultDiagnostics: () => assert.fail("A duplicate cannot publish/repair late diagnostic sources") }), false);
  assert.deepEqual(readFileSync(f.resultPath), before); assert.equal(existsSync(reference.source.path), false);
});

test("Runtime diagnostic EIO preserves real result codes and exact failure while source/authority contradictions fail closed", t => {
  for (const mode of ["io", "authority", "foreign"] as const) {
    const f = fixture(t); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer); const source = diagnosticPath(f);
    const failure = Object.assign(Error("diagnostic source EIO"), { code: "EIO" }); const write = fs.writeFileSync;
    if (mode === "foreign") { fs.mkdirSync(join(f.stateDir, "evidence")); writeFileSync(source, "foreign bytes"); }
    fs.writeFileSync = ((path, ...args) => {
      if (mode !== "foreign" && String(path) === source) {
        write(source, "partial", { flag: "wx", mode: 0o600 });
        if (mode === "authority") writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "changed-generation" });
        throw failure;
      }
      return Reflect.apply(write, fs, [path, ...args]);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      const publish = () => publishRunResult(f.stateDir, f.producer, { code: 7, error: "real workload failure" }, { resultDiagnostics: publisher.publish });
      if (mode === "io") {
        assert.equal(publish(), true); assert.equal(body(f.resultPath).code, 7); assert.equal(body(f.resultPath).terminal_acceptance, "natural");
        assert.equal(body(f.resultPath).result_diagnostics, null); assert.equal(body(f.resultPath).result_diagnostics_unavailable, "publication_failed");
      } else if (mode === "authority") {
        assert.throws(publish, error => error instanceof AggregateError && error.errors[0] === failure && /generation changed/.test(String(error.errors[1])));
        assert.equal(existsSync(f.resultPath), false);
      } else { assert.throws(publish, /identity already fixes different bytes/); assert.equal(existsSync(f.resultPath), false); }
    } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(publisher.readFailure(), mode === "foreign" ? undefined : failure);
    assert.equal(readFileSync(source, "utf8"), mode === "foreign" ? "foreign bytes" : "partial");
    assert.equal(existsSync(f.path), false); assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
  }
  for (const code of [0, 7]) {
    const f = fixture(t); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code }, { resultDiagnostics: publisher.publish }), true);
    assert.equal(body(f.resultPath).result_diagnostics_unavailable, "not_recorded"); assert.equal(existsSync(diagnosticPath(f)), false);
  }
});

test("Runtime diagnostic observation limits and malformed scalar text do not become workload/result quotas", t => {
  const cases = [
    { generation: "generation-a", overrides: {}, error: "lone \uD800", reason: "result_diagnostics_invalid" },
    { generation: "界".repeat(6000), overrides: {}, error: "complete metadata", reason: "descriptor_too_large" },
    { generation: "generation-a", overrides: { values: { api_key: "x" } }, error: "x".repeat(450000), reason: "result_diagnostics_too_large" },
    { generation: "generation-a", overrides: { values: { large: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) } }, error: "complete metadata", reason: "privacy_capture_unavailable" },
  ];
  for (const value of cases) {
    const f = fixture(t, value.generation, value.overrides); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7, error: value.error }, { resultDiagnostics: publisher.publish }), true);
    assert.equal(body(f.resultPath).code, 7); assert.equal(body(f.resultPath).error, value.error);
    assert.equal(body(f.resultPath).result_diagnostics_unavailable, value.reason); assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  }
});

test("Readonly diagnostic fields and UTF-8 ranges retain exact saved text without raw result/body reads, process probes or writes", t => {
  const error = " \uFEFF\r\n``" + "🧪界".repeat(3500) + "\t\r\n" + "x".repeat(10000);
  const f = retainedDiagnostics(t, { error }); const original = body(f.sourcePath).fields.error as string;
  const protectedFiles = [f.metaPath, f.indexPath, f.path, f.sourcePath]; const before = protectedFiles.map(path => readFileSync(path));
  rmSync(f.resultPath);
  const forbidden = [f.resultPath, ...["stdout.log", "stderr.log", "execution.json", "controls.jsonl", "private-session.jsonl"].map(name => join(f.stateDir, name))];
  forbidden.slice(1).forEach(path => writeFileSync(path, "PRIVATE_UNRELATED_BODY"));
  const open = fs.openSync; const read = fs.readFileSync; const write = fs.writeFileSync; const kill = process.kill;
  fs.openSync = ((path, ...args) => { assert.equal(forbidden.includes(String(path)), false); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.readFileSync = ((path, ...args) => { assert.equal(forbidden.includes(String(path)), false); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
  fs.writeFileSync = (() => { throw Error("Readonly diagnostics must not write"); }) as typeof fs.writeFileSync;
  process.kill = (() => { throw Error("Readonly diagnostics must not probe processes"); }) as typeof process.kill;
  syncBuiltinESMExports();
  try {
    const reading = f.read(); assert.equal(reading.state, "available");
    if (reading.state === "available") {
      const preview = Array.from(original).slice(0, 4000).join("");
      assert.equal(reading.output.text, preview); assert.equal(reading.primary_text, "not_included");
      assert.equal(reading.recorded_acceptance, "natural"); assert.equal(reading.content_scope, "canonical_outcome_diagnostic_strings");
      assert.equal(reading.output.chars_total, Array.from(original).length); assert.equal(reading.output.chars_omitted, Array.from(original).length - 4000);
      assert.equal(reading.output.shown_bytes.end, Buffer.byteLength(preview)); assert.equal(reading.unchanged(), true);
      for (const value of [reading, reading.identity, reading.diagnostics, reading.diagnostics.source, reading.output, reading.output.shown_bytes]) assert.equal(Object.isFrozen(value), true);
    }
    for (const range of [{ start: 1, end: 4 }, { start: 0, end: 0 }, { start: Buffer.byteLength(original), end: Buffer.byteLength(original) }, { start: 0, end: Buffer.byteLength(original) }]) {
      const reading = f.read({ field: "error", ...range }); assert.equal(reading.state, "available");
      if (reading.state === "available") {
        const text = Buffer.from(original).subarray(range.start, range.end).toString("utf8");
        assert.equal(reading.output.text, text); assert.deepEqual(reading.output.shown_bytes, range);
        assert.equal(reading.output.chars_shown, Array.from(text).length); assert.equal(reading.selection, "byte_range");
      }
    }
    for (const range of [{ start: 2, end: 2 }, { start: 1, end: 2 }, { start: 0, end: Buffer.byteLength(original) + 1 }]) {
      assert.deepEqual(f.read({ field: "error", ...range }), { state: "unavailable", reason: "range_invalid" });
    }
    assert.deepEqual(f.read({ field: "command" }), { state: "unavailable", reason: "field_unavailable" });
  } finally { fs.openSync = open; fs.readFileSync = read; fs.writeFileSync = write; process.kill = kill; syncBuiltinESMExports(); }
  assert.deepEqual(protectedFiles.map(path => readFileSync(path)), before); assert.equal(existsSync(f.resultPath), false);
});

test("Diagnostic follows require data-only selection and exact indexed publication before retained-source probes", t => {
  const f = retainedDiagnostics(t); const open = fs.openSync; let sourceOpens = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === f.sourcePath) sourceOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    for (const query of [undefined, null, [], {}, { field: "output" }, { field: "error", start: 0 }, { field: "error", start: -1, end: 0 },
      { field: "error", start: 2, end: 1 }, { field: "error", start: 0.5, end: 1 }, { field: "error", path: f.sourcePath },
      Object.create({ field: "error" }), Object.defineProperty({}, "field", { enumerable: true, get() { throw Error("Getter must not run"); } })]) {
      assert.deepEqual(readRunResultDiagnosticsSource(f.stateDir, f.identity, query), { state: "unavailable", reason: "selection_invalid" });
    }
    assert.deepEqual(f.read({ field: "error", start: 0, end: RUN_CONTEXT_RESULT_MAX_BYTES + 1 }), { state: "unavailable", reason: "range_too_large" });
    for (const identity of [{ ...f.identity, run_instance_id: "other" }, { ...f.identity, ownerId: "other" }]) {
      assert.deepEqual(readRunResultDiagnosticsSource(f.stateDir, identity, { field: "error" }), { state: "unavailable", reason: "identity_mismatch" });
    }
    const index = readFileSync(f.indexPath); rmSync(f.indexPath);
    assert.deepEqual(f.read(), { state: "unavailable", reason: "index_unavailable" }); writeFileSync(f.indexPath, index);
    const legacy = { ...f.view }; delete legacy.diagnostics; f.replaceView(legacy);
    assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" });
    f.replaceView({ ...f.view, diagnostics: { ...f.view.diagnostics, source: { ...f.view.diagnostics.source, path: join(f.root, "arbitrary.json") } } });
    assert.deepEqual(f.read(), { state: "unavailable", reason: "view_invalid" });
    f.replaceView({ ...f.view, diagnostics: { state: "not_recorded" }, outcome: { acceptance: "natural", terminal_status: "failed", code: 7, recorded_at: f.view.outcome.recorded_at } });
    assert.deepEqual(f.read(), { state: "unavailable", reason: "diagnostics_unavailable" });
    assert.equal(sourceOpens, 0, "Legacy, wrong-location, absent or not-recorded publication must not follow even a healthy orphan source");
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
});

test("Diagnostic follows verify the full closed source and every field/count/preview even when another field alone is selected", t => {
  const f = retainedDiagnostics(t); const original = body(f.sourcePath); const clone = <T>(value: T): T => structuredClone(value);
  const save = (source: typeof original, view = clone(f.view)) => {
    const text = JSON.stringify(source); writeFileSync(f.sourcePath, text);
    view.diagnostics.bytes_total = Buffer.byteLength(text); view.diagnostics.source.sha256 = createHash("sha256").update(text).digest("hex"); f.replaceView(view);
  };
  for (const modify of [
    (source: typeof original) => { source.run_instance_id = "other"; },
    (source: typeof original) => { source.privacy_scope = "live_metadata"; },
    (source: typeof original) => { source.primary_text = "complete"; },
    (source: typeof original) => { source.coverage.truncated = true; },
    (source: typeof original) => { source.provider = "PRIVATE_BODY"; },
    (source: typeof original) => { source.fields.output = "PRIVATE_BODY"; },
    (source: typeof original) => { source.fields.failure_reason = "changed unselected field"; },
    (source: typeof original) => { source.fields.failure_reason = "lone \uD800"; },
    (source: typeof original) => { delete source.fields.failure_reason; },
  ]) {
    const source = clone(original); modify(source); save(source);
    assert.deepEqual(f.read({ field: "command" }), { state: "unavailable", reason: "source_invalid" });
  }
  for (const modify of [
    (view: typeof f.view) => { view.diagnostics.fields.failure_reason.chars_total++; },
    (view: typeof f.view) => { view.diagnostics.fields.failure_reason.shown_bytes.end--; },
    (view: typeof f.view) => { view.outcome.failure_reason = "wrong preview"; },
    (view: typeof f.view) => { view.diagnostics.fields.failure_reason.extra = true; },
  ]) {
    const view = clone(f.view); modify(view); save(original, view);
    assert.deepEqual(f.read({ field: "command" }), { state: "unavailable", reason: "source_invalid" });
  }
  for (const patch of [{ acceptance: "stopped" }, { terminal_status: "timed_out" }, { code: "7" }, { producer_flags: { stopped: true } }]) {
    save(original, { ...clone(f.view), outcome: { ...f.view.outcome, ...patch } });
    assert.deepEqual(f.read(), { state: "unavailable", reason: "view_invalid" });
  }
  save(original); writeFileSync(f.sourcePath, readFileSync(f.sourcePath).toString().replace("recorded reason", "tampered reason"));
  assert.deepEqual(f.read(), { state: "unavailable", reason: "source_invalid" });
  writeFileSync(f.sourcePath, Buffer.from([0xff])); assert.equal(f.read().state, "unavailable");
  writeFileSync(f.sourcePath, Buffer.alloc(RUN_RESULT_DIAGNOSTICS_MAX_BYTES + 1)); assert.equal(f.read().state, "unavailable");
  rmSync(f.sourcePath); fs.mkdirSync(f.sourcePath); assert.equal(f.read().state, "unavailable"); rmSync(f.sourcePath, { recursive: true });
  if (process.platform !== "win32") { fs.symlinkSync(f.resultPath, f.sourcePath); assert.equal(f.read().state, "unavailable"); rmSync(f.sourcePath); }
  assert.deepEqual(f.read(), { state: "unavailable", reason: "source_unavailable" }); assert.equal(existsSync(f.sourcePath), false);
});

test("Diagnostic readonly observations close partial/failed descriptors and reject index/view/source/owner replacement", t => {
  for (const mode of ["short", "close", "view", "index", "meta", "marker", "source"]) {
    const f = retainedDiagnostics(t); const open = fs.openSync; const close = fs.closeSync; const read = fs.readSync;
    const tracked = new Set<number>(); let fired = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.sourcePath) tracked.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => {
      if (tracked.has(fd) && !fired) {
        fired = true; if (mode === "short") return 0;
        const changed = mode === "view" ? f.path : mode === "index" ? f.indexPath : mode === "meta" ? f.metaPath :
          mode === "marker" ? join(f.stateDir, ".pi-actors-run-state.json") : mode === "source" ? f.sourcePath : undefined;
        if (changed) { writeFileSync(changed + ".replacement", readFileSync(changed)); fs.renameSync(changed + ".replacement", changed); }
      }
      return Reflect.apply(read, fs, [fd, ...args]);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = tracked.delete(fd); close(fd); if (selected && mode === "close") throw Object.assign(Error("close EIO"), { code: "EIO" }); }) as typeof fs.closeSync;
    syncBuiltinESMExports(); let reading;
    try { reading = f.read(); }
    finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; syncBuiltinESMExports(); }
    assert.equal(fired, true); assert.equal(reading.state, "unavailable"); assert.equal(tracked.size, 0);
    if (["view", "index", "meta", "marker"].includes(mode)) assert.deepEqual(reading, { state: "unavailable", reason: "observation_changed" });
  }
});

test("Diagnostic follows do not refresh admission privacy and refuse a whole oversized encoded selection without clipping", t => {
  const f = retainedDiagnostics(t, { error: "literal remains saved " + "🧪".repeat(5000) });
  const first = f.read(); assert.equal(first.state, "available");
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: "literal remains saved" } });
  const later = f.read(); assert.equal(later.state, "available");
  if (first.state === "available" && later.state === "available") {
    assert.equal(first.unchanged(), false); assert.equal(later.unchanged(), true); assert.deepEqual(later.output, first.output);
    assert.deepEqual(later.diagnostics, first.diagnostics);
  }
  const encoded = retainedDiagnostics(t, { error: "\u0001".repeat(11000) });
  assert.deepEqual(encoded.read({ field: "error", start: 0, end: 11000 }), { state: "unavailable", reason: "range_too_large" });
  assert.equal(encoded.read().state, "available"); assert.equal(body(encoded.resultPath).code, 7);
});

test("A fresh diagnostic publisher can exit before readonly recovery without producer recreation or native probes", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-diagnostic-publisher-")); const stateDir = join(root, "state");
  const identity = { run: "diagnostic-publisher", run_instance_id: "publisher-generation", ownerId: "publisher-owner" };
  const error = "complete metadata\r\n" + "Z".repeat(9000); let proven = false;
  t.after(() => { if (proven) rmSync(root, { recursive: true, force: true }); });
  const module = (file: string) => JSON.stringify(new URL(`../lib/${file}.ts`, import.meta.url).href);
  const code = `const {claimRunStateDirectory}=await import(${module("runs-ownership")});
    const {readProcessIdentity}=await import(${module("runs-process")}); const {writeJsonAtomic}=await import(${module("file-state")});
    const {admitRunResultProducer,publishRunResult}=await import(${module("runs-results")});
    const {writeRunResultContextIndex}=await import(${module("runs-context-exports")});
    const state=claimRunStateDirectory(${JSON.stringify(stateDir)},${JSON.stringify(identity.run)});
    writeJsonAtomic(state+'/run.json',{...${JSON.stringify(identity)},state_dir:state,pid:process.pid,process_identity:readProcessIdentity(process.pid),
      createdAt:new Date().toISOString(),outcome_protocol:'run-outcome-v1'});
    const producer=admitRunResultProducer(state).producer;publishRunResult(state,producer,{code:7,error:${JSON.stringify(error)}});
    writeRunResultContextIndex(state,producer);`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") } });
  const captured = { pid: result.pid, state_dir: stateDir, run_instance_id: identity.run_instance_id };
  if (Number.isSafeInteger(captured.pid) && captured.pid > 0) {
    try { process.kill(captured.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") proven = true; }
  }
  if (!proven) throw new AggregateError(result.error ? [result.error] : [], `Captured fixture runner exit remains unproven; retaining state: ${root}`);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  rmSync(join(stateDir, "result.json")); const kill = process.kill;
  process.kill = (() => { throw Error("Readonly diagnostics must not probe processes"); }) as typeof process.kill;
  try {
    const reading = readRunResultDiagnosticsSource(stateDir, identity, { field: "error", start: 0, end: Buffer.byteLength(error) });
    assert.equal(reading.state, "available"); if (reading.state === "available") { assert.equal(reading.output.text, error); assert.equal(reading.unchanged(), true); }
  } finally { process.kill = kill; }
});

test("Result diagnostic sources retain full projected metadata before literal Unicode previews without admitting primary/summary bodies", t => {
  const f = fixture(t);
  const error = " \uFEFF\r\n``" + "界".repeat(3992) + "🧪 tail \uFFFD\t\r\n" + "x".repeat(9000) + "\n ";
  publishRunResult(f.stateDir, f.producer, { code: 7, command: "/private/result/tools/run token=HIDDEN_COMMAND",
    error, failure_reason: JSON.stringify({ password: "HIDDEN_REASON", why: "recorded metadata" }),
    output: "HIDDEN_PRIMARY_BODY", summary: "HIDDEN_SUMMARY_BODY", diagnostics_source: "/HIDDEN_ACTOR_PATH" });
  assert.equal(f.publish().status, "written");
  const view = body(f.path); const descriptor = view.diagnostics; const raw = readFileSync(descriptor.source.path);
  const source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  assert.equal(descriptor.state, "available"); assert.equal(descriptor.source.path, diagnosticPath(f));
  assert.equal(descriptor.source.run_instance_id, f.meta.run_instance_id);
  assert.equal(descriptor.source.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(descriptor.bytes_total, raw.length); assert.ok(raw.length <= RUN_RESULT_DIAGNOSTICS_MAX_BYTES);
  assert.equal(source.schema, "run-result-diagnostics-v1"); assert.equal(source.run_instance_id, f.meta.run_instance_id);
  assert.equal(source.content_scope, "canonical_outcome_diagnostic_strings"); assert.equal(source.privacy_scope, "producer_admission");
  assert.equal(source.primary_text, "not_included"); assert.deepEqual(source.coverage, { truncated: false, redacted: true });
  assert.deepEqual(Object.keys(source.fields), ["command", "error", "failure_reason"]);
  assert.equal(source.fields.error, error); assert.doesNotMatch(raw.toString(), /HIDDEN_|\/private\/result/);
  assert.deepEqual(JSON.parse(source.fields.failure_reason), { password: "[REDACTED]", why: "recorded metadata" });
  for (const [key, text] of Object.entries(source.fields) as [string, string][]) {
    const chars = Array.from(text); const preview = chars.slice(0, 4000).join("");
    assert.equal(view.outcome[key], preview);
    assert.deepEqual(descriptor.fields[key], { bytes_total: Buffer.byteLength(text),
      shown_bytes: { start: 0, end: Buffer.byteLength(preview) }, chars_total: chars.length,
      chars_shown: Math.min(chars.length, 4000), chars_omitted: Math.max(0, chars.length - 4000), truncated: preview !== text });
    assert.equal(Buffer.from(text).subarray(0, descriptor.fields[key].shown_bytes.end).toString("utf8"), preview);
  }
  assert.equal(view.outcome.error.endsWith("…"), false); assert.ok(descriptor.fields.error.chars_omitted > 0);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Diagnostic privacy stays bound to genuine producer admission and fixed source bytes cannot follow later result edits", t => {
  const f = fixture(t, "generation-a", { values: { api_key: "ADMITTED_SECRET", skill_dir: "/admitted/origin" } });
  publishRunResult(f.stateDir, f.producer, { code: 7, error: "ADMITTED_SECRET /admitted/origin/tool LATER_LITERAL" });
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: "LATER_LITERAL", skill_dir: "/other/origin" } });
  assert.equal(f.publish().status, "written");
  const path = diagnosticPath(f); const first = readFileSync(path); const stamp = fs.statSync(path, { bigint: true });
  assert.doesNotMatch(first.toString(), /ADMITTED_SECRET|\/admitted\/origin/);
  assert.match(body(path).fields.error, /\[REDACTED\].*\[PRIVATE_RECIPE_ORIGIN\].*LATER_LITERAL/);
  assert.equal(f.publish().status, "written");
  assert.deepEqual(readFileSync(path), first); assert.equal(fs.statSync(path, { bigint: true }).mtimeNs, stamp.mtimeNs);
  const view = readFileSync(f.path); const original = body(f.resultPath);
  writeJsonAtomic(f.resultPath, { ...original, error: "changed canonical diagnostics" });
  assert.throws(f.publish, /Run result diagnostics identity already fixes different bytes/);
  assert.deepEqual(readFileSync(path), first); assert.deepEqual(readFileSync(f.path), view);
  assert.equal(body(f.resultPath).error, "changed canonical diagnostics");
});

test("Diagnostic source, view and index failures retain exact errors and truthful separate partial effects", t => {
  for (const effect of ["source", "view", "index"] as const) {
    const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 7, error: "recorded failure " + "x".repeat(8000) });
    const resultBefore = readFileSync(f.resultPath); const metaBefore = readFileSync(f.metaPath);
    const failure = Object.assign(new Error(`${effect} evidence EIO`), { code: "EIO" }); const write = fs.writeFileSync;
    const source = diagnosticPath(f); const index = join(f.stateDir, "context-index.json"); let hit = false;
    fs.writeFileSync = ((path, ...args) => {
      if ((effect === "source" && String(path) === source) || (effect === "view" && String(path).startsWith(f.path + ".")) ||
        (effect === "index" && String(path).startsWith(index + "."))) {
        hit = true; if (effect === "source") write(source, "{partial", { flag: "wx", mode: 0o600 }); throw failure;
      }
      return Reflect.apply(write, fs, [path, ...args]);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try { assert.throws(effect === "index" ? f.publishIndex : f.publish, error => error === failure); }
    finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(hit, true); assert.deepEqual(readFileSync(f.resultPath), resultBefore); assert.deepEqual(readFileSync(f.metaPath), metaBefore);
    assert.equal(existsSync(source), true); assert.equal(existsSync(f.path), effect === "index"); assert.equal(existsSync(index), false);
    if (effect === "source") {
      assert.equal(readFileSync(source, "utf8"), "{partial"); assert.throws(f.publish, /identity already fixes different bytes/);
      assert.equal(readFileSync(source, "utf8"), "{partial");
    } else assert.equal(body(source).fields.error.length, 8017);
    assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false);
  }
});

test("Diagnostic observation ceilings and scalar validity refuse whole exports without becoming workload quotas", t => {
  const invalid = fixture(t); publishRunResult(invalid.stateDir, invalid.producer, { code: 7, error: "lone \uD800 surrogate" });
  assert.deepEqual(invalid.publish(), { status: "unavailable", reason: "result_diagnostics_invalid" });
  assert.equal(existsSync(join(invalid.stateDir, "evidence")), false); assert.equal(body(invalid.resultPath).code, 7);
  const large = fixture(t, "generation-a", { values: { api_key: "x" } });
  publishRunResult(large.stateDir, large.producer, { code: 7, error: "x".repeat(450000) });
  assert.ok(readFileSync(large.resultPath).length < RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  assert.deepEqual(large.publish(), { status: "unavailable", reason: "result_diagnostics_too_large" });
  assert.equal(existsSync(join(large.stateDir, "evidence")), false); assert.equal(body(large.resultPath).error.length, 450000);
  const none = fixture(t); publishRunResult(none.stateDir, none.producer, { code: 0 }); none.publish();
  assert.deepEqual(body(none.path).diagnostics, { state: "not_recorded" }); assert.equal(existsSync(diagnosticPath(none)), false);
});

test("Observed diagnostic/result replacement cannot publish a view or silently reuse a competing source", t => {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 7, error: "first complete metadata" });
  const source = diagnosticPath(f); const write = fs.writeFileSync; let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path) === source) { changed = true; writeJsonAtomic(f.resultPath, { ...body(f.resultPath), error: "later metadata" }); }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /Run result diagnostics publication binding changed/); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(body(source).fields.error, "first complete metadata"); assert.equal(existsSync(f.path), false);
  assert.throws(f.publish, /identity already fixes different bytes/); assert.equal(body(f.resultPath).error, "later metadata");
  const late = fixture(t); publishRunResult(late.stateDir, late.producer, { code: 7, error: "metadata before view publication" });
  const lateSource = diagnosticPath(late); let removed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!removed && String(path).startsWith(late.path + ".")) { removed = true; rmSync(lateSource); }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(late.publish, /Run context export binding changed/); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(removed, true); assert.equal(existsSync(late.path), false);
  assert.equal(body(late.resultPath).error, "metadata before view publication");
  const other = fixture(t); publishRunResult(other.stateDir, other.producer, { code: 7, error: "other metadata" });
  fs.mkdirSync(join(other.stateDir, "evidence")); writeFileSync(diagnosticPath(other), "foreign bytes");
  assert.throws(other.publish, /identity already fixes different bytes/); assert.equal(readFileSync(diagnosticPath(other), "utf8"), "foreign bytes");
  assert.equal(existsSync(other.path), false);
});

test("Result view projects genuine accepted natural metadata without copying private bodies or inventing full text/closure", t => {
  for (const code of [0, 7]) {
    const f = fixture(t);
    publishRunResult(f.stateDir, f.producer, { code, command: "/private/result/tools/helper.mjs token=HIDDEN_COMMAND",
      error: "Bearer HIDDEN_ERROR", failure_reason: "password=HIDDEN_REASON", killed: true, truncated: true,
      output: "HIDDEN_PRIMARY_BODY", thinking: "HIDDEN_PROVIDER_REASONING", native_scope_closed: true });
    const files = [f.metaPath, f.resultPath, join(f.stateDir, "trace.jsonl")];
    const before = files.map(path => existsSync(path) ? readFileSync(path) : null);
    const result = f.publish();
    assert.equal(result.status, "written");
    const value = body(f.path);
    assert.equal(value.schema, "run-context-result-v1");
    assert.equal(value.run_instance_id, f.meta.run_instance_id);
    assert.equal(value.content_scope, "canonical_outcome_metadata");
    assert.equal(value.primary_text, "not_included");
    assert.equal(value.outcome.acceptance, "natural");
    assert.equal(value.outcome.terminal_status, code === 0 ? "done" : "failed");
    assert.equal(value.outcome.code, code);
    assert.equal(value.outcome.recorded_at, body(f.resultPath).completedAt);
    assert.deepEqual(value.outcome.producer_flags, { reported_killed: true, reported_truncated: true });
    assert.deepEqual(value.coverage, { truncated: true, redacted: true });
    assert.doesNotMatch(readFileSync(f.path, "utf8"), /HIDDEN_|\/private\/result|native_scope_closed|"stopped"|"timed_out"/);
    assert.ok(readFileSync(f.path).length <= RUN_CONTEXT_RESULT_MAX_BYTES);
    assert.deepEqual(files.map(path => existsSync(path) ? readFileSync(path) : null), before);
    assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
    assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false);
  }
});

test("Capture-only Result evidence never becomes terminal from killed/truncated flags or a serialized claim id", t => {
  const f = fixture(t);
  writeJsonAtomic(f.resultPath, { code: 0, completedAt: "2026-01-01T00:00:01.000Z", run_instance_id: f.meta.run_instance_id,
    terminal_acceptance: "after_stop_claim", stop_claim_id: "serialized-id-is-not-scope-proof", killed: true, truncated: false,
    error: "recorded capture metadata, not terminal or primary output" });
  const before = readFileSync(f.resultPath);
  assert.equal(f.publish().status, "written");
  const value = body(f.path);
  assert.equal(value.outcome.acceptance, "capture_only");
  assert.equal(value.outcome.terminal_status, undefined);
  assert.equal(value.outcome.code, 0);
  assert.deepEqual(value.outcome.producer_flags, { reported_killed: true, reported_truncated: false });
  assert.equal(value.diagnostics.state, "available");
  assert.equal(body(value.diagnostics.source.path).fields.error, "recorded capture metadata, not terminal or primary output");
  assert.equal(body(value.diagnostics.source.path).primary_text, "not_included");
  f.publishIndex();
  const reading = readRunResultDiagnosticsSource(f.stateDir, f.meta, { field: "error" });
  assert.equal(reading.state, "available");
  if (reading.state === "available") { assert.equal(reading.recorded_acceptance, "capture_only"); assert.equal(reading.primary_text, "not_included"); }
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /serialized-id-is-not-scope-proof|"stopping"|"killed"|"stopped"/);
  assert.deepEqual(readFileSync(f.resultPath), before);
});

test("Missing Result stays pending without an empty view; legacy, stale or coercible data never gains natural acceptance", t => {
  const f = fixture(t);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "result_absent" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  f.publishIndex();
  assert.deepEqual(body(join(f.stateDir, "context-index.json")).entries.result, { availability: "pending", path: null });
  const valid = { code: 0, completedAt: "2026-01-01T00:00:01.000Z", run_instance_id: f.meta.run_instance_id, terminal_acceptance: "natural" };
  for (const patch of [{ terminal_acceptance: undefined }, { code: "0" }, { run_instance_id: "generation-b" },
    { completedAt: "yesterday" }, { terminal_acceptance: "killed" }, { stop_claim_id: "late" }]) {
    writeJsonAtomic(f.resultPath, { ...valid, ...patch });
    assert.throws(f.publish, /Run evidence state is unavailable or invalid/);
    assert.equal(existsSync(f.path), false);
  }
});

test("Result view reads only its bound outcome and captured privacy metadata, never streams or execution/session bodies", t => {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 0 });
  const privateFiles = ["stdout.log", "stderr.log", "execution.json", "controls.jsonl"];
  privateFiles.forEach(name => writeFileSync(join(f.stateDir, name), "PRIVATE_UNRELATED_BODY"));
  const open = fs.openSync; const read = fs.readFileSync;
  const allowed = (path: unknown) => assert.equal(privateFiles.some(name => String(path) === join(f.stateDir, name)), false);
  fs.openSync = ((path, ...args) => { allowed(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.readFileSync = ((path, ...args) => { allowed(path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { assert.equal(f.publish().status, "written"); }
  finally { fs.openSync = open; fs.readFileSync = read; syncBuiltinESMExports(); }
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /PRIVATE_UNRELATED_BODY/);
});

test("Malformed, oversized and nonregular Result sources preserve previously exported evidence", t => {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 7 }); f.publish();
  const before = readFileSync(f.path);
  for (const bad of ["{broken", "null", Buffer.from([0xff])]) {
    writeFileSync(f.resultPath, bad);
    assert.throws(f.publish, /Run evidence state is unavailable or invalid/);
    assert.deepEqual(readFileSync(f.path), before);
  }
  writeJsonAtomic(f.resultPath, { code: 7, completedAt: "2026-01-01T00:00:01.000Z", run_instance_id: f.meta.run_instance_id,
    terminal_acceptance: "natural", output: "x".repeat(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES) });
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "result_unavailable" });
  assert.deepEqual(readFileSync(f.path), before);
  rmSync(f.resultPath); fs.mkdirSync(f.resultPath);
  assert.throws(f.publish, /Run evidence state is unavailable or invalid/);
  assert.deepEqual(readFileSync(f.path), before);
});

test("Result JSON uses the real UTF-8 ceiling and never clips an opaque generation to fit", t => {
  const f = fixture(t, "界".repeat(12000));
  const text = "界".repeat(4000);
  publishRunResult(f.stateDir, f.producer, { code: 7, command: text, error: text, failure_reason: text });
  assert.ok(readFileSync(f.resultPath).length < RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "result_view_too_large" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  assert.equal(existsSync(f.path), false);
});

test("Observed Result source replacement preserves the prior view and requires a fresh explicit capture", t => {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 0 }); f.publish();
  const before = readFileSync(f.path);
  const original = body(f.resultPath);
  const open = fs.openSync; const close = fs.closeSync;
  const sourceFds = new Set<number>(); let changed = false;
  fs.openSync = ((path, ...args) => {
    const fd = Reflect.apply(open, fs, [path, ...args]);
    if (String(path) === f.resultPath) sourceFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd) => {
    const source = sourceFds.delete(fd);
    const result = close(fd);
    if (source && !changed) { changed = true; writeJsonAtomic(f.resultPath, { ...original, code: 7 }); }
    return result;
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "result_changed" }); assert.equal(changed, true); }
  finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(body(f.resultPath).code, 7);
  assert.equal(f.publish().status, "written");
  assert.equal(body(f.path).outcome.terminal_status, "failed");
});

test("Result export requires the original producer again after capture, not a copied generation DTO", t => {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 0 });
  assert.throws(() => writeRunResultContextExport(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
  let changed = false;
  const releaseHook = afterMutationLockRelease(lock, () => {
      changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
    });
  try { assert.throws(f.publish, /generation changed/); assert.equal(changed, true); }
  finally { releaseHook(); }
  assert.equal(existsSync(f.path), false);
});

test("Result publication preserves foreign targets and rejects observed generation changes before replacement", t => {
  const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 0 });
  fs.mkdirSync(join(f.stateDir, "evidence"));
  writeJsonAtomic(f.path, { schema: "run-context-result-v1", run: f.meta.run, run_instance_id: "foreign" });
  const before = readFileSync(f.path);
  assert.throws(f.publish, /export binding/);
  assert.deepEqual(readFileSync(f.path), before);
  rmSync(f.path);
  const write = fs.writeFileSync; let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path).startsWith(f.path + ".")) { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /export binding/); assert.equal(changed, true); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(existsSync(f.path), false);
});

test("Result index keeps the real Trace role and exact committed effects/errors without retry or root mutation", t => {
  const f = fixture(t);
  appendRunTraceEvent(f.stateDir, { kind: "checkpoint.ready", summary: "before result" });
  writeRunTraceContextIndex(f.stateDir, f.producer);
  publishRunResult(f.stateDir, f.producer, { code: 7, error: "failure metadata only" });
  const before = [f.metaPath, f.resultPath].map(path => readFileSync(path));
  const rename = fs.renameSync; const refusal = Object.assign(new Error("result index EIO after commit"), { code: "EIO" });
  let attempts = 0;
  fs.renameSync = ((from, to) => {
    const result = rename(from, to);
    if (String(to) === join(f.stateDir, "context-index.json")) { attempts++; throw refusal; }
    return result;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publishIndex, error => error === refusal); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(attempts, 1);
  assert.equal(existsSync(f.path), true);
  assert.equal(f.publishIndex().status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta);
  assert.equal(reading.state, "available");
  if (reading.state === "available") {
    assert.equal(reading.index.entries.result.availability, "available");
    assert.equal(reading.index.entries.trace.availability, "available");
  }
  assert.deepEqual([f.metaPath, f.resultPath].map(path => readFileSync(path)), before);
});

});

await describe("Result identity privacy", { concurrency: false }, async () => {
/** Original Result publication privacy is not a certificate for legacy/DTO-only diagnostic reply identities. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-result-identity-agent-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR, priorReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = priorReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const { createRunResultDiagnosticsPublisher, writeRunResultContextExport, writeRunResultContextIndex, readRunResultDiagnosticOutcome, readRunResultDiagnosticsSource } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult, readRunProducerCapturedMetadata } = await import("../lib/runs-results.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
function fixture(t: TestContext, overrides: Record<string, unknown> = {}, prepare?: (meta: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const meta: Record<string, unknown> = { run: "result-identity", run_instance_id: "generation-a", ownerId: "owner-a", pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", template: "echo /x/private/helper", values: { skill_dir: "/x/private" }, ...overrides };
  const stateDir = claimRunStateDirectory(join(root, "state"), meta.run as string); meta.state_dir = stateDir;
  prepare?.(meta);
  const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
  const expected = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) };
  const key = createHash("sha256").update(JSON.stringify([meta.run, meta.run_instance_id, meta.ownerId ?? null])).digest("hex");
  return { root, stateDir, meta, metaPath, producer, expected, resultPath: join(stateDir, "result.json"), viewPath: join(stateDir, "evidence", "result.json"),
    sourcePath: join(stateDir, "evidence", `result-diagnostics-${key}.json`) };
}

function noRetainedProbes(f: ReturnType<typeof fixture>, action: () => void) {
  const open = fs.openSync, stat = fs.lstatSync; let probes = 0;
  const observe = (path: unknown) => { if (String(path) === f.sourcePath || String(path) === f.viewPath) probes++; };
  fs.openSync = ((path, ...args) => { observe(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.lstatSync = ((path, ...args) => { observe(path); return Reflect.apply(stat, fs, [path, ...args]); }) as typeof fs.lstatSync; syncBuiltinESMExports();
  try { action(); } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(probes, 0); // Delegated probes are counted even if a production catch would otherwise hide a thrown assertion.
}

function diagnosticPlan(meta: Record<string, unknown>, fields: Record<string, string>) {
  const content = JSON.stringify({ schema: "run-result-diagnostics-v1", run: meta.run, run_instance_id: meta.run_instance_id,
    content_scope: "canonical_outcome_diagnostic_strings", privacy_scope: "producer_admission", primary_text: "not_included",
    coverage: { truncated: false, redacted: true }, fields }, null, 2) + "\n";
  const key = createHash("sha256").update(JSON.stringify([meta.run, meta.run_instance_id, meta.ownerId ?? null])).digest("hex");
  return { content, source: { path: join(String(meta.state_dir), "evidence", `result-diagnostics-${key}.json`),
    run_instance_id: meta.run_instance_id, sha256: createHash("sha256").update(content).digest("hex") } };
}

test("First diagnostic generated source references use complete original privacy before retention, preserving natural/capture codes and immutable first binding", t => {
  for (const field of ["path", "sha256"] as const) for (const present of [true, false]) for (const code of [0, 7]) for (const capture of [false, true]) {
    let planned!: ReturnType<typeof diagnosticPlan>; let secret = "";
    const f = fixture(t, {}, meta => { planned = diagnosticPlan(meta, { error: "public diagnostic" }); secret = planned.source[field];
      meta.values = { api_key: present ? secret : "UNMATCHED_REFERENCE82" }; });
    assert.equal(planned.source.path, f.sourcePath);
    const original = readRunProducerCapturedMetadata(f.producer, 1048576);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { api_key: present ? "HEALTHY_LIVE82" : secret } });
    const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer); let callbacks = 0;
    const resultDiagnostics = (admission: Parameters<typeof publisher.publish>[0]) => { callbacks++; return publisher.publish(admission); };
    if (capture) assert.equal(claimRunStop(f.stateDir, { ownerId: f.producer.ownerId, runInstanceId: f.producer.runInstanceId, reason: "manual_kill" },
      { verifyIdentity: () => ({ status: "valid", valid: true }) }).status, "stop_requested");
    const publish = () => assert.equal(publishRunResult(f.stateDir, f.producer, { code, error: "public diagnostic" }, { resultDiagnostics }), true);
    if (present) noRetainedProbes(f, publish); else publish();
    const canonical = json(f.resultPath); assert.equal(canonical.code, code); assert.equal(canonical.terminal_acceptance, capture ? "after_stop_claim" : "natural");
    assert.equal(publisher.readFailure(), undefined); assert.equal(callbacks, 1);
    if (present) { assert.equal(canonical.result_diagnostics, null); assert.equal(canonical.result_diagnostics_unavailable, "source_reference_redacted");
      assert.equal(fs.existsSync(f.sourcePath), false); assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false); }
    else { assert.deepEqual(canonical.result_diagnostics.source, planned.source); assert.equal(fs.readFileSync(f.sourcePath, "utf8"), planned.content);
      assert.equal(canonical.result_diagnostics.bytes_total, Buffer.byteLength(planned.content)); assert.deepEqual(canonical.result_diagnostics.fields, ["error"]); }
    const follow = readRunResultDiagnosticOutcome(f.stateDir, f.expected, code === 0 ? "done" : "failed");
    if (capture) assert.deepEqual(follow, { state: "unavailable", reason: "nonterminal_capture" });
    else if (present) assert.deepEqual(follow, { state: "unavailable", reason: "diagnostics_unavailable", result_diagnostics_unavailable: "source_reference_redacted" });
    else assert.equal(follow.state, "available");
    const first = fs.readFileSync(f.resultPath), bytes = fs.existsSync(f.sourcePath) ? fs.readFileSync(f.sourcePath) : undefined;
    writeJsonAtomic(f.metaPath, { ...f.meta, values: {} });
    assert.equal(publishRunResult(f.stateDir, f.producer, { code: code === 0 ? 7 : 0, error: "replacement diagnostic" }, { resultDiagnostics }), false);
    assert.equal(callbacks, 1); assert.deepEqual(fs.readFileSync(f.resultPath), first);
    assert.deepEqual(fs.existsSync(f.sourcePath) ? fs.readFileSync(f.sourcePath) : undefined, bytes);
    assert.deepEqual(readRunProducerCapturedMetadata(f.producer, 1048576), original); assert.equal(fs.existsSync(f.viewPath), false);
    assert.equal(fs.existsSync(join(f.stateDir, "context-index.json")), false);
  }
});

test("Private diagnostic descriptor refusal preserves retained orphans, while no-field absence never checks an unused prospective reference", t => {
  for (const field of ["path", "sha256"] as const) for (const hasFields of [true, false]) {
    const f = fixture(t, {}, meta => { const planned = diagnosticPlan(meta, hasFields ? { error: "public diagnostic" } : {});
      meta.values = { api_key: planned.source[field] }; });
    fs.mkdirSync(join(f.stateDir, "evidence")); fs.writeFileSync(f.sourcePath, "SOURCE_ORPHAN_UNTOUCHED"); fs.writeFileSync(f.viewPath, "VIEW_ORPHAN_UNTOUCHED");
    const index = join(f.stateDir, "context-index.json"); fs.writeFileSync(index, "INDEX_ORPHAN_UNTOUCHED");
    const old = [f.sourcePath, f.viewPath, index].map(path => fs.readFileSync(path)); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: {} });
    noRetainedProbes(f, () => assert.equal(publishRunResult(f.stateDir, f.producer, { code: 7, ...(hasFields ? { error: "public diagnostic" } : {}) }, { resultDiagnostics: publisher.publish }), true));
    assert.equal(json(f.resultPath).code, 7); assert.equal(json(f.resultPath).terminal_acceptance, "natural");
    assert.equal(json(f.resultPath).result_diagnostics, null); assert.equal(json(f.resultPath).result_diagnostics_unavailable, hasFields ? "source_reference_redacted" : "not_recorded");
    assert.equal(publisher.readFailure(), undefined); assert.deepEqual([f.sourcePath, f.viewPath, index].map(path => fs.readFileSync(path)), old);
  }
});

test("Original private Result run/generation/owner binds explicit diagnostic unavailability without source I/O or changing canonical code0/7", t => {
  for (const field of ["run", "run_instance_id", "ownerId"]) for (const value of ["/x/private", "token=HIDDEN_IDENTITY"]) for (const code of [0, 7]) {
    const f = fixture(t, { [field]: value }); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false); // Initialization captures privacy, never retained source bytes.
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } });
    noRetainedProbes(f, () => { publishRunResult(f.stateDir, f.producer, { code, command: "/x/private/helper", error: "recorded diagnostic" }, { resultDiagnostics: publisher.publish }); });
    const canonical = json(f.resultPath); assert.equal(canonical.code, code); assert.equal(canonical.terminal_acceptance, "natural");
    assert.equal(canonical.result_diagnostics, null); assert.equal(canonical.result_diagnostics_unavailable, "identity_redacted");
    assert.equal(publisher.readFailure(), undefined); assert.equal(fs.existsSync(f.sourcePath), false); assert.equal(fs.existsSync(f.viewPath), false);
    if (field !== "run") assert.deepEqual(readRunResultDiagnosticOutcome(f.stateDir, f.expected, code === 0 ? "done" : "failed"), { state: "unavailable", reason: "diagnostics_unavailable", result_diagnostics_unavailable: "identity_redacted" });
  }
});

test("Captured literal Result identity binds first unavailability from raw scalar data without JSON-escape gaps", t => {
  for (const secret of ["literal-result-credential-62", "raw\"\\\r\n\uFEFF\uFFFD🫧```", "[REDACTED]"]) for (const field of ["run_instance_id", "ownerId"]) for (const code of [0, 7]) {
    const f = fixture(t, { [field]: secret, values: { api_key: secret } });
    const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: {} });
    noRetainedProbes(f, () => { publishRunResult(f.stateDir, f.producer, { code, error: "recorded diagnostic" }, { resultDiagnostics: publisher.publish }); });
    assert.equal(json(f.resultPath).code, code); assert.equal(json(f.resultPath).terminal_acceptance, "natural");
    assert.equal(json(f.resultPath).result_diagnostics_unavailable, "identity_redacted"); assert.equal(publisher.readFailure(), undefined);
    noRetainedProbes(f, () => assert.deepEqual(writeRunResultContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "result_identity_redacted" }));
    assert.equal(fs.existsSync(f.sourcePath), false); assert.equal(fs.existsSync(f.viewPath), false);
  }
});

test("Legacy Result context export checks full original identity before field projection/source retention and preserves independent index effects", t => {
  for (const field of ["run_instance_id", "ownerId"]) for (const value of ["/x/private", "token=HIDDEN_IDENTITY"]) {
    const f = fixture(t, { [field]: value }); publishRunResult(f.stateDir, f.producer, { code: 7, error: "unpaired \uD800" });
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } });
    const before = fs.readFileSync(f.resultPath);
    assert.deepEqual(writeRunResultContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "result_identity_redacted" });
    assert.equal(writeRunResultContextIndex(f.stateDir, f.producer).status, "published");
    assert.equal(json(join(f.stateDir, "context-index.json")).entries.result.reason, "result_identity_redacted");
    assert.deepEqual(fs.readFileSync(f.resultPath), before); assert.equal(fs.existsSync(f.sourcePath), false); assert.equal(fs.existsSync(f.viewPath), false);
    assert.deepEqual(readRunResultDiagnosticsSource(f.stateDir, f.expected, { field: "error" }), { state: "unavailable", reason: "publication_unavailable" });
  }
});

test("Safe/absent/logical Result identities retain complete diagnostic recovery under original privacy, not newly added live origins", t => {
  for (const ownerId of [undefined, "owner-/x/private", "/later/private"]) for (const code of [0, 7]) {
    const f = fixture(t, { ownerId, run_instance_id: "generation-/x/private" }); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/later/private" } });
    publishRunResult(f.stateDir, f.producer, { code, command: "read /x/private/helper", error: "literal \uFEFF\uFFFD🫧```\r\n /x/private/error" }, { resultDiagnostics: publisher.publish });
    assert.equal(writeRunResultContextIndex(f.stateDir, f.producer).status, "published");
    const outcome = readRunResultDiagnosticOutcome(f.stateDir, f.expected, code === 0 ? "done" : "failed"), source = readRunResultDiagnosticsSource(f.stateDir, f.expected, { field: "error" });
    assert.equal(outcome.state, "available"); assert.equal(source.state, "available");
    if (outcome.state === "available" && source.state === "available") {
      assert.equal(outcome.identity.ownerId, ownerId); assert.equal(source.identity.run_instance_id, f.meta.run_instance_id);
      assert.match(source.output.text, /literal \uFEFF\uFFFD🫧```\r\n/); assert.doesNotMatch(source.output.text, /\/x\/private/);
    }
  }
});

test("Private Result identity never retries immutable first unavailability or probes/rewrites existing source/view orphans", t => {
  const f = fixture(t, { ownerId: "/x/private" }); fs.mkdirSync(join(f.stateDir, "evidence"));
  fs.writeFileSync(f.sourcePath, "SOURCE_ORPHAN_UNTOUCHED"); fs.writeFileSync(f.viewPath, "VIEW_ORPHAN_UNTOUCHED");
  const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer); let callbacks = 0;
  const resultDiagnostics = (admission: Parameters<typeof publisher.publish>[0]) => { callbacks++; return publisher.publish(admission); };
  publishRunResult(f.stateDir, f.producer, { code: 0, error: "first diagnostic" }, { resultDiagnostics }); const first = fs.readFileSync(f.resultPath);
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } });
  publishRunResult(f.stateDir, f.producer, { code: 7, error: "replacement diagnostic" }, { resultDiagnostics });
  assert.equal(callbacks, 1); assert.deepEqual(fs.readFileSync(f.resultPath), first);
  noRetainedProbes(f, () => { assert.deepEqual(writeRunResultContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "result_identity_redacted" }); });
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "SOURCE_ORPHAN_UNTOUCHED"); assert.equal(fs.readFileSync(f.viewPath, "utf8"), "VIEW_ORPHAN_UNTOUCHED");
  assert.equal(publisher.readFailure(), undefined);
});

test("Missing/copied/original-over-budget Result privacy cannot borrow a healthy later identity or invoke getters", t => {
  const f = fixture(t); let getters = 0; const fake = Object.defineProperty({}, "ownerId", { get() { getters++; throw Error("foreign getter"); } });
  for (const key of [undefined, fake, { ...f.producer }]) assert.throws(() => Reflect.apply(createRunResultDiagnosticsPublisher, undefined, [f.stateDir, key]), /captured Run and generation|admitted by this runtime/);
  assert.equal(getters, 0);
  const large = fixture(t, { ownerId: "/x/private", values: { skill_dir: "/x/private", padding: "🫧".repeat(300000) } });
  writeJsonAtomic(large.metaPath, { ...large.meta, values: {} }); const publisher = createRunResultDiagnosticsPublisher(large.stateDir, large.producer);
  publishRunResult(large.stateDir, large.producer, { code: 7, error: "metadata" }, { resultDiagnostics: publisher.publish });
  assert.equal(json(large.resultPath).result_diagnostics_unavailable, "privacy_capture_unavailable");
  assert.deepEqual(writeRunResultContextExport(large.stateDir, large.producer), { status: "unavailable", reason: "result_metadata_unavailable" });
  assert.equal(fs.existsSync(large.sourcePath), false);
});

test("Post-stop Result capture keeps code and nonterminal acceptance despite private-identity metadata refusal", t => {
  const f = fixture(t, { ownerId: "/x/private" }); const publisher = createRunResultDiagnosticsPublisher(f.stateDir, f.producer);
  assert.equal(claimRunStop(f.stateDir, { ownerId: f.producer.ownerId, runInstanceId: f.producer.runInstanceId, reason: "manual_kill" },
    { verifyIdentity: () => ({ status: "valid", valid: true }) }).status, "stop_requested");
  publishRunResult(f.stateDir, f.producer, { code: 7, error: "captured diagnostic" }, { resultDiagnostics: publisher.publish });
  const canonical = json(f.resultPath); assert.equal(canonical.code, 7); assert.equal(canonical.terminal_acceptance, "after_stop_claim");
  assert.equal(canonical.result_diagnostics_unavailable, "identity_redacted");
  assert.deepEqual(readRunResultDiagnosticOutcome(f.stateDir, f.expected, "failed"), { state: "unavailable", reason: "nonterminal_capture" });
  assert.deepEqual(writeRunResultContextExport(f.stateDir, f.producer), { status: "unavailable", reason: "result_identity_redacted" });
});

});

await describe("Historical Result", { concurrency: false }, async () => {
/** Original successful Result publication correspondence; historical metadata only, no active terminal/source authority. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-result-read-agent-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR, priorReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = priorReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const exports = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult, reportRunProducerCleanupFailure, readRunProducerCleanupFailure } = await import("../lib/runs-results.ts");
const { claimRunStop } = await import("../lib/runs-control.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { readRunContextIndex } = await import("../lib/runs-context-index.ts");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "result-read");
  const meta = { run: "result-read", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", values: { skill_dir: "/x/private" } };
  prepare?.(meta); const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta);
  // Both keys genuinely admitted before target result/stop; no late constructor or DTO authority renewal.
  const producer = admitRunResultProducer(stateDir).producer, unrecorded = admitRunResultProducer(stateDir).producer;
  const source = join(stateDir, "result.json"), viewPath = join(stateDir, "evidence", "result.json"), indexPath = join(stateDir, "context-index.json");
  const first = (code = 7, capture = false, fields: Record<string, unknown> = { error: "literal \uFEFF\uFFFD🫧```\r\n" }) => {
    const diagnostics = exports.createRunResultDiagnosticsPublisher(stateDir, producer);
    if (capture) assert.equal(claimRunStop(stateDir, { ownerId: meta.ownerId, runInstanceId: meta.run_instance_id, reason: "manual_kill" }).status, "stop_requested");
    assert.equal(publishRunResult(stateDir, producer, { code, killed: true, truncated: false, ...fields }, { resultDiagnostics: diagnostics.publish }), true);
  };
  const publish = () => exports.writeRunResultContextIndex(stateDir, producer), exportOnly = () => exports.writeRunResultContextExport(stateDir, producer);
  const read = () => exports.readRunResultContextView(stateDir, producer), updateSize = () => { const index = json(indexPath); index.entries.result.bytes_total = fs.statSync(viewPath).size; writeJsonAtomic(indexPath, index); };
  return { root, stateDir, meta, metaPath, producer, unrecorded, source, viewPath, indexPath, first, publish, exportOnly, read, updateSize };
}
function shifted(time: string) { return time.slice(0, -2) + String((Number(time.at(-2)) + 1) % 10) + "Z"; }

test("Historical whole Result supports natural0/7, capture-only and no-field views without root/source/first-result authority renewal", t => {
  for (const code of [0, 7]) for (const capture of [false, true]) for (const empty of [false, true]) {
    const f = fixture(t); assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" }); f.first(code, capture, empty ? {} : undefined); f.publish();
    const first = f.read(); assert.equal(first.state, "available"); if (first.state !== "available") continue;
    assert.equal(first.basis, "original_result_publication_match"); assert.equal(first.path, "evidence/result.json"); assert.deepEqual(first.view, json(f.viewPath));
    assert.equal(first.view.outcome.acceptance, capture ? "capture_only" : "natural"); assert.equal(first.view.outcome.code, code);
    assert.equal(first.view.primary_text, "not_included"); assert.equal(first.view.content_scope, "canonical_outcome_metadata");
    assert.equal(first.view.diagnostics.state, empty ? "not_recorded" : "available"); assert.equal(Object.isFrozen(first.view.outcome.producer_flags), true);
    const root = json(f.source); writeJsonAtomic(f.source, { ...root, code: 8, killed: false });
    assert.equal(first.unchanged(), true); const old = f.read(); assert.equal(old.state, "available"); if (old.state === "available") assert.deepEqual(old.view, first.view);
    fs.renameSync(f.source, f.source + ".held"); if (!empty) fs.renameSync(root.result_diagnostics.source.path, root.result_diagnostics.source.path + ".held");
    assert.equal(f.read().state, "available"); assert.deepEqual(f.exportOnly(), { status: "unavailable", reason: "result_absent" }); assert.equal(f.read().state, "available");
    fs.renameSync(f.source + ".held", f.source); if (!empty) fs.renameSync(root.result_diagnostics.source.path + ".held", root.result_diagnostics.source.path);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } }); assert.equal(first.unchanged(), false); assert.equal(f.read().state, "available");
    f.publish(); const current = f.read(); assert.equal(current.state, "available"); if (current.state === "available") { assert.equal(current.view.outcome.code, 8); assert.equal(current.view.outcome.producer_flags?.reported_killed, false); }
  }
});

test("Result original key/privacy/publication/root/module admission refuses before filesystem or getter access", async t => {
  const f = fixture(t), foreign = fixture(t), large = fixture(t, meta => { meta.values = { padding: "🫧".repeat(300000) }; });
  const lost = await import(new URL("../lib/runs-context-exports.ts?result_read_lost_binding", import.meta.url).href);
  f.first(); f.publish(); const open = fs.openSync, stat = fs.lstatSync; let getters = 0, probes = 0;
  const fake = Object.defineProperty({}, "run", { get() { getters++; throw Error("Getter forbidden"); } });
  const forbidden = () => { probes++; throw Error("Rejected Result admission probed filesystem"); };
  fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; syncBuiltinESMExports();
  try {
    for (const key of [null, undefined, fake, { ...f.producer }, JSON.parse(JSON.stringify(f.producer)), Object.create(f.producer)])
      assert.deepEqual(Reflect.apply(exports.readRunResultContextView, undefined, [f.stateDir, key]), { state: "unavailable", reason: "admission_invalid" });
    assert.deepEqual(exports.readRunResultContextView(f.stateDir, foreign.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(exports.readRunResultContextView(f.stateDir + "/../state", f.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(exports.readRunResultContextView(f.stateDir, f.unrecorded), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(lost.readRunResultContextView(f.stateDir, f.producer), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(large.read(), { state: "unavailable", reason: "admission_unavailable" });
  } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(getters, 0); assert.equal(probes, 0);
});

test("Result whole original publication rejects same-size semantic/header/descriptor edits under available index without repairing view", t => {
  const f = fixture(t); f.first(); f.publish(); const original = fs.readFileSync(f.viewPath), saved = json(f.viewPath), initial = f.read(); assert.equal(initial.state, "available");
  for (const field of ["captured_at", "recorded_at", "acceptance", "code", "flags", "hash", "path", "counts", "preview", "coverage"]) {
    const changed = structuredClone(saved);
    if (field === "captured_at") changed.captured_at = shifted(changed.captured_at);
    if (field === "recorded_at") changed.outcome.recorded_at = shifted(changed.outcome.recorded_at);
    if (field === "acceptance") { changed.outcome.acceptance = "capture_only"; delete changed.outcome.terminal_status; }
    if (field === "code") changed.outcome.code = 8;
    if (field === "flags") changed.outcome.producer_flags = { reported_killed: false, reported_truncated: true };
    if (field === "hash") changed.diagnostics.source.sha256 = "a".repeat(64);
    if (field === "path") changed.diagnostics.source.path = changed.diagnostics.source.path.replace("result-diagnostics-", "result-diagnosticX-");
    if (field === "counts") changed.diagnostics.fields.error.chars_total++;
    if (field === "preview") changed.outcome.error = "X" + changed.outcome.error.slice(1);
    if (field === "coverage") changed.coverage.redacted = false;
    assert.notDeepEqual(changed, saved); const compact = JSON.stringify(changed); assert.ok(Buffer.byteLength(compact) < original.length); const bytes = compact + " ".repeat(original.length - Buffer.byteLength(compact) - 1) + "\n";
    fs.writeFileSync(f.viewPath, bytes); assert.equal(fs.statSync(f.viewPath).size, original.length); assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
    assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.equal(fs.readFileSync(f.viewPath, "utf8"), bytes);
  }
  fs.writeFileSync(f.viewPath, original); assert.equal(f.read().state, "available"); if (initial.state === "available") assert.equal(initial.unchanged(), false);
  writeJsonAtomic(f.source, { ...json(f.source), code: 8 }); exports.writeRunResultContextIndex(f.stateDir, f.unrecorded);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.equal(exports.readRunResultContextView(f.stateDir, f.unrecorded).state, "available");
});

test("Unavailable and before/after-replacement Result publications mint no new admission; index and explicit safe refresh remain separate", t => {
  for (const previous of [false, true]) {
    const privacy = fixture(t, meta => { meta.values = { api_key: "2001-01-01T00:00:00.000Z" }; }); privacy.first(); if (previous) privacy.publish();
    const prior = previous ? fs.readFileSync(privacy.viewPath) : undefined;
    writeJsonAtomic(privacy.source, { ...json(privacy.source), completedAt: "2001-01-01T00:00:00.000Z" });
    assert.deepEqual(privacy.exportOnly(), { status: "unavailable", reason: "result_metadata_redacted" });
    if (previous) { assert.equal(privacy.read().state, "available"); assert.deepEqual(fs.readFileSync(privacy.viewPath), prior); }
    else assert.deepEqual(privacy.read(), { state: "unavailable", reason: "publication_unavailable" });
    privacy.publish(); assert.deepEqual(privacy.read(), { state: "unavailable", reason: previous ? "result_unavailable" : "publication_unavailable" });
  }
  const invalid = fixture(t); invalid.first(7, false, { error: "lone \uD800" });
  assert.deepEqual(invalid.exportOnly(), { status: "unavailable", reason: "result_diagnostics_invalid" }); assert.deepEqual(invalid.read(), { state: "unavailable", reason: "publication_unavailable" });
  for (const previous of [false, true]) for (const afterReplace of [false, true]) {
    const f = fixture(t); f.first(); if (previous) { f.publish(); const root = json(f.source); writeJsonAtomic(f.source, { ...root, code: 8 }); }
    const rename = fs.renameSync, failure = Object.assign(Error("Result view EIO"), { code: "EIO" }); let commits = 0;
    fs.renameSync = ((from, to) => { if (String(to) === f.viewPath) { commits++; if (afterReplace) rename(from, to); throw failure; } return rename(from, to); }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { assert.throws(f.exportOnly, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(commits, 1);
    if (!previous) assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" });
    else if (!afterReplace) assert.equal(f.read().state, "available"); else { f.updateSize(); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); }
    f.publish(); assert.equal(f.read().state, "available");
  }
  const f = fixture(t); f.first(); f.publish(); writeJsonAtomic(f.source, { ...json(f.source), code: 8 }); const rename = fs.renameSync, failure = Error("Result index EIO after replacement");
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.indexPath) throw failure; return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
  try { assert.throws(f.publish, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); } assert.equal(f.read().state, "available");
});

test("Known cleanup report after Result commit preserves written effect but never mints or renews Result historical binding", t => {
  for (const previous of [false, true]) {
    const f = fixture(t); f.first(); if (previous) f.publish(); else exports.writeRunTraceContextIndex(f.stateDir, f.producer);
    const old = previous ? fs.readFileSync(f.viewPath) : undefined; writeJsonAtomic(f.source, { ...json(f.source), code: 8 });
    const rename = fs.renameSync, diagnostic = console.error, messages: unknown[][] = []; let written: ReturnType<typeof f.exportOnly> | undefined, commits = 0;
    console.error = (...args) => { messages.push(args); };
    fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.viewPath) { commits++; reportRunProducerCleanupFailure(f.producer, Object.assign(Error("Controlled cleanup report"), { code: "EIO" })); } return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { written = f.exportOnly(); } finally { fs.renameSync = rename; console.error = diagnostic; syncBuiltinESMExports(); }
    assert.ok(written && written.status === "written"); assert.equal(commits, 1);
    assert.deepEqual(messages, [["Run producer lifecycle cleanup failed; release remains unproven and further producer operations are fenced."]]);
    const index = json(f.indexPath); index.entries.result = { ...written.entry }; writeJsonAtomic(f.indexPath, index); assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available");
    assert.deepEqual(f.read(), { state: "unavailable", reason: previous ? "view_mismatch" : "publication_unavailable" });
    if (old) { fs.writeFileSync(f.viewPath, old); index.entries.result.bytes_total = old.length; writeJsonAtomic(f.indexPath, index); assert.equal(f.read().state, "available"); }
    assert.deepEqual(readRunProducerCleanupFailure(f.producer), { status: "release_unproven", error_code: "EIO" }); assert.throws(f.exportOnly, /lifecycle cleanup remains unproven/);
  }
});

test("Result whole-view read touches only owned saved view and metadata, never canonical/diagnostic/primary/sibling bodies or effects", t => {
  const f = fixture(t); f.first(); f.publish(); const root = json(f.source); fs.writeFileSync(f.source, "PRIVATE_MALFORMED_ROOT"); fs.writeFileSync(root.result_diagnostics.source.path, "PRIVATE_MALFORMED_DIAGNOSTIC");
  const saved = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const fds = new Map<number, string>(), allowed = new Set([f.metaPath, f.indexPath, f.viewPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)]); let forbiddenReads = 0, effects = 0, selected = 0;
  fs.openSync = ((path, ...args) => { if (String(path).includes(".lifecycle")) effects++; const fd = Reflect.apply(saved.openSync, fs, [path, ...args]); fds.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return saved.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { if (!allowed.has(fds.get(fd)!)) forbiddenReads++; if (fds.get(fd) === f.viewPath) selected++; return Reflect.apply(saved.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { if (!allowed.has(typeof path === "number" ? fds.get(path)! : String(path))) forbiddenReads++; return Reflect.apply(saved.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => { effects++; throw Error("Result historical read attempted effect/sampling/discovery"); }; const kill = process.kill, now = Date.now;
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try { const value = f.read(); assert.equal(value.state, "available"); if (value.state === "available") assert.equal(value.unchanged(), true); }
  finally { Object.assign(fs, saved); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(forbiddenReads, 0); assert.equal(effects, 0); assert.equal(selected, 1); assert.equal(fds.size, 0);
});

test("Result post-body root/marker/metadata/index/view substitutions, corrupt/denied/symlink/close-error input cannot gain admission", t => {
  for (const change of ["root", "marker", "metadata", "index", "view", "close_error"]) {
    const f = fixture(t); f.first(); f.publish(); const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(), readFds = new Set<number>(); let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = fds.delete(fd), consumed = readFds.delete(fd); const result = close(fd); if (selected && consumed && !changed) { changed = true;
      if (change === "close_error") throw Object.assign(Error("Result view close EIO"), { code: "EIO" });
      if (change === "root") { fs.renameSync(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      else { const path = change === "marker" ? join(f.stateDir, RUN_STATE_OWNERSHIP_FILE) : change === "metadata" ? f.metaPath : change === "index" ? f.indexPath : f.viewPath; const bytes = fs.readFileSync(path); fs.renameSync(path, path + ".held"); fs.writeFileSync(path, bytes); }
    } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: change === "close_error" ? "view_unavailable" : "observation_changed" }); assert.equal(changed, true); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  }
  const f = fixture(t); f.first(); f.publish(); const original = fs.readFileSync(f.viewPath);
  fs.renameSync(f.viewPath, f.viewPath + ".missing"); assert.deepEqual(f.read(), { state: "unavailable", reason: "index_unavailable" }); assert.equal(fs.existsSync(f.viewPath), false); fs.renameSync(f.viewPath + ".missing", f.viewPath);
  const indexBytes = fs.readFileSync(f.indexPath); fs.unlinkSync(f.indexPath); assert.deepEqual(f.read(), { state: "unavailable", reason: "index_unavailable" }); fs.writeFileSync(f.indexPath, indexBytes);
  const unavailableIndex = json(f.indexPath); unavailableIndex.entries.result = { availability: "unavailable", path: null, reason: "fixture_controlled" }; writeJsonAtomic(f.indexPath, unavailableIndex);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "result_unavailable" }); fs.writeFileSync(f.indexPath, indexBytes);
  for (const value of ["{bad", Buffer.from([0xff])]) { fs.writeFileSync(f.viewPath, value); f.updateSize(); assert.equal(f.read().state, "unavailable"); }
  fs.writeFileSync(f.viewPath, original); f.updateSize(); const open = fs.openSync;
  fs.openSync = ((path, ...args) => { if (String(path) === f.viewPath) throw Object.assign(Error("Result denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(f.read().state, "unavailable"); } finally { fs.openSync = open; syncBuiltinESMExports(); }
  if (process.platform !== "win32") { fs.renameSync(f.viewPath, f.viewPath + ".held"); fs.symlinkSync(f.viewPath + ".held", f.viewPath); assert.equal(f.read().state, "unavailable"); }
});

test("Result original reference privacy and independent source/complete-response budgets refuse whole reads without clipping", t => {
  for (const data of [{ run_instance_id: "/x/private" }, { ownerId: "known-private77", values: { api_key: "known-private77" } }]) {
    const f = fixture(t, meta => Object.assign(meta, data)), open = fs.openSync, stat = fs.lstatSync; let probes = 0;
    const forbidden = () => { probes++; throw Error("Private Result header probed source"); }; fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: "identity_redacted" }); } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); } assert.equal(probes, 0);
  }
  const f = fixture(t, meta => { meta.run_instance_id = "g".repeat(8036); });
  f.first(7, false, { command: "🫧".repeat(4000), error: "🫧".repeat(4000), failure_reason: "界".repeat(4000) }); f.publish();
  assert.ok(fs.statSync(f.viewPath).size <= exports.RUN_CONTEXT_RESULT_MAX_BYTES); assert.deepEqual(f.read(), { state: "unavailable", reason: "response_too_large" });
  fs.appendFileSync(f.viewPath, " ".repeat(exports.RUN_CONTEXT_RESULT_MAX_BYTES + 1 - fs.statSync(f.viewPath).size)); f.updateSize();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(); let selected = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) selected++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); } assert.equal(selected, 0);
});

});

await describe("Trace publication", { concurrency: false }, async () => {
/** Real canonical-journal Trace export, privacy, history and generation-fenced publication. */

const agentDir = mkdtempSync(join(tmpdir(), "pi-actors-trace-export-agent-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
const previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  rmSync(agentDir, { recursive: true, force: true });
});
const { writeRunTraceContextExport, writeRunTraceContextIndex, writeRunRecipeContextIndex,
  RUN_CONTEXT_TRACE_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer, publishRunResult } = await import("../lib/runs-results.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { mutationLockPath, writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunTraceEvent, readRunTraceJournal, summarizeRunTraceJournal } = await import("../lib/runs-trace.ts");
const { DEFAULT_INSPECT_LINES, TRACE_JOURNAL_MAX_BYTES, TRACE_JOURNAL_MAX_EVENTS } = await import("../lib/limits.ts");
const { readRunContextIndex, runContextExportPath, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");
const { projectRunTraceJournal } = await import("../lib/trace-projection.ts");

function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = mkdtempSync(join(agentDir, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "trace-view");
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
  const meta = { run: "trace-view", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir,
    createdAt: clock.started_at, ...clock, pid: process.pid, process_identity: readProcessIdentity(process.pid),
    outcome_protocol: RUN_OUTCOME_PROTOCOL, template: "echo visible", values: { skill_dir: "/private/trace" } };
  const metaPath = join(stateDir, "run.json");
  prepare?.(meta);
  writeJsonAtomic(metaPath, meta);
  const producer = admitRunResultProducer(stateDir).producer;
  const journal = join(stateDir, "trace.jsonl");
  const path = join(stateDir, runContextExportPath("trace"));
  const append = (data: unknown = { note: "visible" }) => appendRunTraceEvent(stateDir,
    { kind: "checkpoint.ready", summary: "Run /private/trace/tools/helper.mjs token=HIDDEN_SUMMARY", data });
  return { root, stateDir, meta, metaPath, producer, journal, path, append,
    publish: () => writeRunTraceContextExport(stateDir, producer),
    publishIndex: () => writeRunTraceContextIndex(stateDir, producer) };
}
function lines(path: string): Record<string, any>[] { return readFileSync(path, "utf8").trimEnd().split("\n").map(value => JSON.parse(value)); }

test("Trace export uses only the canonical journal and shared privacy/coverage owners", t => {
  const f = fixture(t);
  f.append({ password: "HIDDEN_DETAIL", command: "/private/trace/tools/helper.mjs" });
  const forbidden = ["controls.jsonl", "execution.json", "stdout.log", "stderr.log"];
  for (const name of forbidden) writeFileSync(join(f.stateDir, name), "PRIVATE_UNRELATED_BODY");
  const canonical = [f.metaPath, f.journal, ...forbidden.map(name => join(f.stateDir, name))];
  const before = canonical.map(path => readFileSync(path));
  const open = fs.openSync;
  const read = fs.readFileSync;
  const assertAllowed = (path: unknown) => assert.equal(forbidden.some(name => String(path) === join(f.stateDir, name)), false);
  fs.openSync = ((path, ...args) => { assertAllowed(path); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  fs.readFileSync = ((path, ...args) => { assertAllowed(path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  let result;
  try { result = f.publish(); }
  finally { fs.openSync = open; fs.readFileSync = read; syncBuiltinESMExports(); }
  assert.equal(result.status, "written");
  const [header, ...items] = lines(f.path);
  assert.equal(header.schema, "run-context-trace-v1");
  assert.equal(header.run_instance_id, "generation-a");
  assert.equal(header.source_scope, "canonical_journal");
  assert.equal(header.order, "newest_first");
  assert.deepEqual(header.coverage, { truncated: true, history_complete: false, redacted: true });
  assert.deepEqual(header.journal, summarizeRunTraceJournal(readRunTraceJournal(f.stateDir)));
  assert.equal(items.length, 1);
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /HIDDEN_SUMMARY|HIDDEN_DETAIL|PRIVATE_UNRELATED_BODY|\/private\/trace/);
  assert.deepEqual(canonical.map(path => readFileSync(path)), before);
  assert.equal(existsSync(join(f.stateDir, "context-index.json")), false);
});

test("Trace refresh keeps original producer privacy while the canonical journal grows, without caller/live-policy renewal", t => {
  for (const absent of [false, true]) for (const mode of ["caller_only", "before_first", "refresh"] as const) {
    const f = fixture(t, meta => { if (absent) meta.values = {}; }); const original = JSON.parse(JSON.stringify(f.meta));
    f.append({ command: "/private/trace/tools/original.mjs", password: "HIDDEN_FIRST" });
    if (mode === "refresh") assert.equal(f.publishIndex().status, "published");
    f.meta.values.skill_dir = "/caller-mutated";
    if (mode !== "caller_only") writeJsonAtomic(f.metaPath, { ...original, values: { skill_dir: absent ? "/private/trace" : "/actor/replacement" }, visibility: "public" });
    f.append({ command: "/private/trace/tools/later.mjs", password: "HIDDEN_LATER", logical_reference: "suite/task" });
    const current = readRunTraceJournal(f.stateDir); const before = [f.metaPath, f.journal].map(path => readFileSync(path));
    const expected = JSON.parse(JSON.stringify(projectRunTraceJournal(current, { recipe: original, limit: DEFAULT_INSPECT_LINES })));
    if (mode !== "caller_only") assert.notDeepEqual(JSON.parse(JSON.stringify(projectRunTraceJournal(current,
      { recipe: JSON.parse(readFileSync(f.metaPath, "utf8")), limit: DEFAULT_INSPECT_LINES }))), expected);
    assert.equal(f.publishIndex().status, "published"); const [header, ...items] = lines(f.path);
    if (!absent) assert.doesNotMatch(readFileSync(f.path, "utf8"), /\/private\/trace/);
    assert.doesNotMatch(readFileSync(f.path, "utf8"), /HIDDEN_FIRST|HIDDEN_LATER|caller-mutated|\/actor\/replacement/);
    assert.deepEqual(items, expected); assert.equal(header.events_total, 2); assert.equal(header.events_shown, 2);
    assert.deepEqual(header.journal, summarizeRunTraceJournal(current)); assert.deepEqual([f.metaPath, f.journal].map(path => readFileSync(path)), before);
    const indexed = readRunContextIndex(f.stateDir, original); assert.equal(indexed.state, "available");
    if (indexed.state === "available") assert.equal(indexed.index.entries.trace.availability, "available");
  }
});

test("Trace absence stays pending without an invented view; an actual empty journal has explicit scope/coverage", t => {
  const f = fixture(t);
  assert.deepEqual(f.publish(), { status: "unavailable", reason: "trace_journal_absent" });
  assert.equal(existsSync(join(f.stateDir, "evidence")), false);
  f.publishIndex();
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateDir, "context-index.json"), "utf8")).entries.trace,
    { availability: "pending", path: null });
  writeFileSync(f.journal, "");
  assert.equal(f.publish().status, "written");
  const [header, ...items] = lines(f.path);
  assert.equal(items.length, 0);
  assert.equal(header.events_omitted, 0);
  assert.equal(header.journal.history_complete, true);
  assert.equal(header.coverage.history_complete, false);
});

test("Trace view reports real journal compaction separately from its own omitted preview rows", t => {
  const f = fixture(t);
  const seed = Array.from({ length: TRACE_JOURNAL_MAX_EVENTS + 25 }, (_, i) => ({
    id: "seed-" + i, ts: new Date(i).toISOString(), kind: "runtime.note", data: { index: i },
  }));
  writeFileSync(f.journal, seed.map(value => JSON.stringify(value)).join("\n") + "\n");
  f.append();
  const summary = summarizeRunTraceJournal(readRunTraceJournal(f.stateDir));
  assert.equal(summary.compacted, true);
  assert.equal(f.publish().status, "written");
  const [header, ...items] = lines(f.path);
  assert.deepEqual(header.journal, summary);
  assert.equal(header.journal.history_complete, false);
  assert.ok(header.journal.dropped_events > 0);
  assert.equal(header.events_total, summary.retained_events);
  assert.equal(header.events_omitted, header.events_total - items.length);
  assert.ok(items.length <= DEFAULT_INSPECT_LINES);
});

test("Trace JSONL obeys the real UTF-8 ceiling and discloses byte-budget omissions without slicing rows", t => {
  const f = fixture(t);
  const payload = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["field" + i, "🫧".repeat(1000)]));
  for (let i = 0; i < 9; i++) f.append({ ...payload, index: i });
  const result = f.publish();
  assert.equal(result.status, "written");
  if (result.status !== "written" || result.entry.availability !== "available") return;
  const [header, ...items] = lines(f.path);
  assert.equal(header.events_total, 9);
  assert.equal(header.events_omitted, 9 - items.length);
  assert.ok(items.length < 9 && items.length > 0);
  assert.ok(readFileSync(f.path).length <= RUN_CONTEXT_TRACE_MAX_BYTES);
  assert.equal(result.entry.bytes_total, readFileSync(f.path).length);
  assert.equal(result.entry.media_type, "application/x-ndjson");
});

test("Invalid, incomplete, oversized, denied and symlinked Trace sources cannot replace an existing view", t => {
  const f = fixture(t);
  f.append(); f.publish();
  const before = readFileSync(f.path);
  const originalJournal = readFileSync(f.journal);
  for (const malformed of ["{broken\n", "{}\n", "{\"id\":\"partial\"}", Buffer.from([0xff, 0x0a]), "x".repeat(TRACE_JOURNAL_MAX_BYTES + 1)]) {
    writeFileSync(f.journal, malformed);
    assert.equal(f.publish().status, "unavailable");
    assert.deepEqual(readFileSync(f.path), before);
  }
  writeFileSync(f.journal, originalJournal);
  const open = fs.openSync;
  fs.openSync = ((path, ...args) => {
    if (String(path) === f.journal) throw Object.assign(new Error("denied private Trace source " + f.root), { code: "EACCES" });
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { const result = f.publish(); assert.equal(result.status, "unavailable"); assert.doesNotMatch(JSON.stringify(result), new RegExp(f.root)); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(f.path), before);
  if (process.platform !== "win32") {
    rmSync(f.journal);
    const outside = join(f.root, "outside.jsonl"); writeFileSync(outside, "PRIVATE_OUTSIDE");
    fs.symlinkSync(outside, f.journal);
    assert.equal(f.publish().status, "unavailable");
    assert.equal(readFileSync(outside, "utf8"), "PRIVATE_OUTSIDE");
  }
});

test("Trace source changes retain evidence and require a later explicit observation rather than an internal retry", t => {
  const f = fixture(t); f.append(); f.publish();
  const before = readFileSync(f.path);
  const open = fs.openSync; const close = fs.closeSync;
  const sourceFds = new Set<number>(); let changed = false;
  fs.openSync = ((path, ...args) => {
    const fd = Reflect.apply(open, fs, [path, ...args]);
    if (String(path) === f.journal) sourceFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd) => {
    const source = sourceFds.delete(fd);
    const result = close(fd);
    if (source && !changed) { changed = true; f.append({ note: "concurrently retained event" }); }
    return result;
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(f.publish(), { status: "unavailable", reason: "trace_journal_changed" }); assert.equal(changed, true); }
  finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(f.publish().status, "written");
  assert.equal(lines(f.path)[0].events_total, 2);
});

test("Trace privacy and current metadata have independent UTF-8 budgets; unhealthy admission reads no journal body", t => {
  let healthy: unknown;
  const over = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { ...(meta.values as Record<string, unknown>), note: "🫧".repeat(300000) };
    const encoded = JSON.stringify(meta); assert.ok(encoded.length < RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); assert.ok(Buffer.byteLength(encoded) > RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); });
  over.append(); assert.equal(over.publish().status, "unavailable"); writeJsonAtomic(over.metaPath, healthy);
  const original = readFileSync(over.journal); const open = fs.openSync; let journalReads = 0;
  fs.openSync = ((path, ...args) => { if (String(path) === over.journal) journalReads++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { assert.deepEqual(over.publish(), { status: "unavailable", reason: "trace_admission_unavailable" }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(journalReads, 0); assert.equal(existsSync(over.path), false); assert.deepEqual(readFileSync(over.journal), original);
  over.publishIndex(); assert.deepEqual(JSON.parse(readFileSync(join(over.stateDir, "context-index.json"), "utf8")).entries.trace,
    { availability: "unavailable", path: null, reason: "trace_admission_unavailable" });
  const f = fixture(t); f.append(); const base = { ...f.meta, padding: "" };
  const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  writeFileSync(f.metaPath, JSON.stringify({ ...base, padding: "x".repeat(room) })); assert.equal(fs.statSync(f.metaPath).size, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  assert.equal(f.publish().status, "written"); const before = readFileSync(f.path);
  fs.appendFileSync(f.metaPath, " "); assert.deepEqual(f.publish(), { status: "unavailable", reason: "trace_metadata_unavailable" }); assert.deepEqual(readFileSync(f.path), before);
  const corrupt = Buffer.from(JSON.stringify({ ...f.meta, padding: "X" })); corrupt[corrupt.indexOf('"X"') + 1] = 0xff;
  writeFileSync(f.metaPath, corrupt); assert.equal(f.publish().status, "unavailable"); assert.deepEqual(readFileSync(f.path), before);
});

test("Trace journal/metadata/marker/root substitution between capture and publication retains the prior view without recapture", t => {
  for (const change of ["journal", "metadata", "marker", "root"] as const) {
    const f = fixture(t); f.append(); f.publish(); const before = readFileSync(f.path); const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
    const rename = fs.renameSync; let changed = false;
    const releaseHook = afterMutationLockRelease(lock, () => {
        changed = true;
        if (change === "journal") f.append({ note: "later admitted journal event" });
        else if (change === "metadata") writeJsonAtomic(f.metaPath, { ...f.meta, note: "same-generation metadata change" });
        else if (change === "marker") { const path = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE); rename(path, path + ".held"); fs.copyFileSync(path + ".held", path); }
        else { rename(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      });
    try { assert.throws(f.publish, /captured source binding changed/); assert.equal(changed, true); }
    finally { releaseHook(); }
    assert.deepEqual(readFileSync(f.path), before);
    if (change === "journal") { assert.equal(f.publish().status, "written"); assert.equal(lines(f.path)[0].events_total, 2); }
  }
});

test("Trace export rejects copies and generation replacement between capture and publication", t => {
  const f = fixture(t); f.append();
  assert.throws(() => writeRunTraceContextExport(f.stateDir, { ...f.producer }), /admitted by this runtime/);
  const lock = mutationLockPath(join(f.stateDir, ".lifecycle"));
  let changed = false;
  const releaseHook = afterMutationLockRelease(lock, () => {
      changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" });
    });
  try { assert.throws(f.publish, /generation changed/); assert.equal(changed, true); }
  finally { releaseHook(); }
  assert.equal(existsSync(f.path), false);
});

test("Trace JSONL target binding refuses foreign/corrupt files and rechecks metadata before commit", t => {
  const f = fixture(t); f.append();
  fs.mkdirSync(join(f.stateDir, "evidence"));
  for (const value of [JSON.stringify({ schema: "run-context-trace-v1", run: f.meta.run, run_instance_id: "foreign" }) + "\n",
    JSON.stringify({ schema: "run-context-trace-v1", run: f.meta.run, run_instance_id: f.meta.run_instance_id }) + "\n{bad\n"]) {
    writeFileSync(f.path, value);
    assert.throws(f.publish, /export binding/);
    assert.equal(readFileSync(f.path, "utf8"), value);
  }
  rmSync(f.path);
  const write = fs.writeFileSync; let changed = false;
  fs.writeFileSync = ((path, ...args) => {
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (!changed && String(path).startsWith(f.path + ".")) { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publish, /export binding/); assert.equal(changed, true); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(existsSync(f.path), false);
});

test("Trace index joins a real Recipe role and preserves natural results across exact commit errors", t => {
  const f = fixture(t); f.append();
  writeRunRecipeContextIndex(f.stateDir, f.producer);
  publishRunResult(f.stateDir, f.producer, { code: 7, output: "natural failure" });
  const retained = [f.metaPath, f.journal, join(f.stateDir, "result.json")];
  const before = retained.map(path => readFileSync(path));
  const rename = fs.renameSync;
  const refusal = Object.assign(new Error("trace index EIO after commit"), { code: "EIO" }); let attempts = 0;
  fs.renameSync = ((from, to) => {
    const result = rename(from, to);
    if (String(to) === join(f.stateDir, "context-index.json")) { attempts++; throw refusal; }
    return result;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(f.publishIndex, error => error === refusal); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(attempts, 1);
  assert.equal(existsSync(f.path), true);
  assert.equal(f.publishIndex().status, "published");
  const reading = readRunContextIndex(f.stateDir, f.meta);
  assert.equal(reading.state, "available");
  if (reading.state === "available") {
    assert.equal(reading.index.entries.trace.availability, "available");
    assert.equal(reading.index.entries.recipe.availability, "available");
  }
  assert.deepEqual(retained.map(path => readFileSync(path)), before);
  assert.equal(existsSync(join(f.stateDir, "terminal-handled.json")), false);
});

});

await describe("Historical Trace", { concurrency: false }, async () => {
/** Private historical Trace admission follows original successful publication, never latest journal or saved DTO claims. */
const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-trace-read-agent-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR, priorReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => { if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = priorReview;
  fs.rmSync(agentDir, { recursive: true, force: true }); });
const { readRunTraceContextView, writeRunTraceContextExport, writeRunTraceContextIndex, RUN_CONTEXT_TRACE_MAX_BYTES } = await import("../lib/runs-context-exports.ts");
const { admitRunResultProducer } = await import("../lib/runs-results.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { writeJsonAtomic } = await import("../lib/file-state.ts");
const { appendRunTraceEvent, readRunTraceJournal } = await import("../lib/runs-trace.ts");
const { readRunContextIndex } = await import("../lib/runs-context-index.ts");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
const rows = (path: string) => fs.readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = claimRunStateDirectory(join(root, "state"), "trace-read");
  const meta = { run: "trace-read", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", values: { skill_dir: "/x/private" } };
  prepare?.(meta); const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
  const journal = join(stateDir, "trace.jsonl"), viewPath = join(stateDir, "evidence", "trace.jsonl"), indexPath = join(stateDir, "context-index.json");
  const append = (data: unknown = { note: "literal \uFEFF\uFFFD```🫧\r\n" }) => appendRunTraceEvent(stateDir, { kind: "checkpoint.ready", summary: "recorded /x/private/helper", data });
  const read = () => readRunTraceContextView(stateDir, producer), publish = () => writeRunTraceContextIndex(stateDir, producer);
  const exportOnly = () => writeRunTraceContextExport(stateDir, producer);
  const updateSize = () => { const index = json(indexPath); index.entries.trace.bytes_total = fs.statSync(viewPath).size; writeJsonAtomic(indexPath, index); };
  return { root, stateDir, meta, metaPath, producer, journal, viewPath, indexPath, append, read, publish, exportOnly, updateSize };
}

test("Authentic issued Trace ids and timestamps stay exact or omit whole items under original privacy without changing raw history", t => {
  // A private event timestamp may equal capture time: distinguish item omission from whole-view refusal.
  const epoch = Date.UTC(2026, 0, 1); let caseIndex = 0;
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  try {
    for (const field of ["id", "ts"] as const) for (const present of [true, false]) for (const collision of field === "ts" ? [false, true] : [false]) {
      const issuedAt = epoch + caseIndex++ * 10_000; t.mock.timers.setTime(issuedAt);
      let issued: ReturnType<typeof appendRunTraceEvent> | undefined;
      const f = fixture(t, meta => {
        issued = appendRunTraceEvent(String(meta.state_dir), { kind: "checkpoint.issued", summary: "public-only" });
        meta.values = present ? { api_key: issued[field] } : {};
      });
      t.mock.timers.setTime(issuedAt + (collision ? 0 : 1));
      const secret = issued![field]; f.append({ note: "public-only" });
      const raw = readRunTraceJournal(f.stateDir).events;
      const expected = raw.filter(({ event }) => !present || event[field] !== secret);
      for (const phase of ["first", "refresh"]) {
        t.mock.timers.setTime(issuedAt + (collision ? 0 : phase === "first" ? 2 : 3));
        writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } });
        const before = [f.metaPath, f.journal].map(path => fs.readFileSync(path));
        assert.equal(f.publish().status, "published"); const reading = f.read();
        if (collision && present) {
          assert.deepEqual(json(f.indexPath).entries.trace, { availability: "unavailable", path: null, reason: "trace_metadata_redacted" });
          assert.deepEqual(reading, { state: "unavailable", reason: "publication_unavailable" });
          assert.equal(fs.existsSync(f.viewPath), false);
        } else {
          assert.equal(json(f.indexPath).entries.trace.availability, "available");
          assert.equal(reading.state, "available", reading.state === "unavailable" ? reading.reason : "");
          if (reading.state === "available") { assert.equal(reading.view.header.events_total, raw.length);
            assert.equal(reading.view.header.events_shown, expected.length); assert.equal(reading.view.header.events_omitted, raw.length - expected.length);
            assert.equal(reading.view.header.journal.retained_events, raw.length);
            assert.deepEqual(reading.view.items.map(row => row.id).sort(), expected.map(({ event }) => event.id).sort());
            for (const row of reading.view.items) { const original = raw.find(({ event }) => event.id === row.id)!.event;
              assert.equal(row.ts, original.ts); assert.equal(row.id, original.id); }
            assert.equal(reading.view.items.some(row => row[field] === secret), !present, phase + ":" + field); }
        }
        assert.deepEqual([f.metaPath, f.journal].map(path => fs.readFileSync(path)), before);
      }
      assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
    }
  } finally { t.mock.timers.reset(); }
});

test("Original Trace publication remains frozen/readable after journal append/loss and live privacy changes, without rereading history", t => {
  const f = fixture(t); assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" }); f.append(); f.publish();
  const [header, ...items] = rows(f.viewPath), first = f.read(); assert.equal(first.state, "available"); if (first.state !== "available") return;
  assert.equal(first.basis, "original_trace_publication_match"); assert.deepEqual(first.view, { header, items }); assert.equal(first.path, "evidence/trace.jsonl");
  assert.equal(first.view.items[0].detail && (first.view.items[0].detail as any).data.note, "literal \uFEFF\uFFFD```🫧\r\n");
  assert.equal(Object.isFrozen(first.view.items[0].detail), true); assert.equal(Object.isFrozen(first.view.header.journal), true);
  f.append({ note: "new genuine fact" }); assert.equal(first.unchanged(), true); const afterAppend = f.read(); assert.equal(afterAppend.state, "available"); if (afterAppend.state === "available") assert.deepEqual(afterAppend.view, first.view);
  fs.unlinkSync(f.journal); assert.equal(f.read().state, "available"); assert.equal(f.exportOnly().status, "unavailable"); assert.equal(f.read().state, "available");
  writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/current" } }); assert.equal(first.unchanged(), false);
  const historical = f.read(); assert.equal(historical.state, "available"); if (historical.state === "available") assert.deepEqual(historical.view, first.view);
  f.append({ note: "explicit new publication" }); f.publish(); const refreshed = f.read(); assert.equal(refreshed.state, "available");
  if (refreshed.state === "available") assert.notDeepEqual(refreshed.view, first.view);
  const unowned = fixture(t, meta => { delete meta.ownerId; }); unowned.append(); unowned.publish(); assert.equal(unowned.read().state, "available");
  writeJsonAtomic(unowned.metaPath, { ...unowned.meta, ownerId: "foreign-current-owner" });
  assert.deepEqual(unowned.read(), { state: "unavailable", reason: "identity_mismatch" });
});

test("Missing/copied/foreign/root-alias/lost-module/original-budget admissions cannot borrow healthy saved Trace data before filesystem probing", async t => {
  const f = fixture(t); f.append(); f.publish(); const unrecorded = admitRunResultProducer(f.stateDir).producer;
  const foreign = fixture(t); let healthy: unknown;
  const large = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { padding: "🫧".repeat(300000) }; }); writeJsonAtomic(large.metaPath, healthy);
  const reloaded = await import(new URL("../lib/runs-context-exports.ts?trace_read_lost_binding", import.meta.url).href);
  const open = fs.openSync, stat = fs.lstatSync; let getters = 0;
  const fake = Object.defineProperty({}, "run", { get() { getters++; throw Error("fake getter"); } });
  const forbidden = () => assert.fail("Rejected original admission probed filesystem"); fs.openSync = forbidden as typeof fs.openSync; fs.lstatSync = forbidden as typeof fs.lstatSync; syncBuiltinESMExports();
  try {
    for (const producer of [null, undefined, fake, { ...f.producer }, JSON.parse(JSON.stringify(f.producer))]) assert.deepEqual(Reflect.apply(readRunTraceContextView, undefined, [f.stateDir, producer]), { state: "unavailable", reason: "admission_invalid" });
    assert.deepEqual(readRunTraceContextView(f.stateDir, foreign.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunTraceContextView(f.stateDir + "/../state", f.producer), { state: "unavailable", reason: "identity_mismatch" });
    assert.deepEqual(readRunTraceContextView(f.stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(reloaded.readRunTraceContextView(f.stateDir, f.producer), { state: "unavailable", reason: "publication_unavailable" });
    assert.deepEqual(large.read(), { state: "unavailable", reason: "admission_unavailable" });
  } finally { fs.openSync = open; fs.lstatSync = stat; syncBuiltinESMExports(); }
  assert.equal(getters, 0);
});

test("Same-size private-origin/safe/header edits and foreign producer publication never inherit original Trace binding", t => {
  const f = fixture(t); f.append(); f.publish(); const original = fs.readFileSync(f.viewPath), originalRows = rows(f.viewPath);
  for (const mode of ["origin", "safe", "header"]) {
    const changed = structuredClone(originalRows);
    if (mode === "header") changed[0].events_total = 9;
    else changed[1].summary = (mode === "origin" ? "invented /x/private" : "invented safe text").padEnd(changed[1].summary.length, " ");
    fs.writeFileSync(f.viewPath, changed.map(row => JSON.stringify(row)).join("\n") + "\n"); assert.equal(fs.statSync(f.viewPath).size, original.length);
    assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available"); const before = fs.readFileSync(f.viewPath);
    assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.deepEqual(fs.readFileSync(f.viewPath), before);
  }
  fs.writeFileSync(f.viewPath, original); assert.equal(f.read().state, "available");
  const other = admitRunResultProducer(f.stateDir).producer; f.append({ note: "foreign key's genuine later publication" }); writeRunTraceContextIndex(f.stateDir, other);
  assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); assert.equal(readRunTraceContextView(f.stateDir, other).state, "available");
});

test("Failed/uncertain Trace writes mint no new binding while prior publication and separate index partial effects remain exact", t => {
  for (const previous of [false, true]) for (const afterReplace of [false, true]) {
    const f = fixture(t); f.append(); if (previous) { f.publish(); f.append({ note: "new candidate" }); }
    const rename = fs.renameSync, failure = Object.assign(Error("Trace publication EIO"), { code: "EIO" }); let attempts = 0;
    fs.renameSync = ((from, to) => { if (String(to) === f.viewPath) { attempts++; if (afterReplace) rename(from, to); throw failure; } return rename(from, to); }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { assert.throws(f.exportOnly, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(attempts, 1);
    if (!previous) assert.deepEqual(f.read(), { state: "unavailable", reason: "publication_unavailable" });
    else if (!afterReplace) assert.equal(f.read().state, "available");
    else { f.updateSize(); assert.equal(readRunContextIndex(f.stateDir, f.meta).state, "available"); assert.deepEqual(f.read(), { state: "unavailable", reason: "view_mismatch" }); }
    f.publish(); assert.equal(f.read().state, "available");
  }
  const f = fixture(t); f.append(); f.publish(); f.append({ note: "index partial effect" }); const rename = fs.renameSync, failure = Error("index EIO after commit");
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.indexPath) throw failure; return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
  try { assert.throws(f.publish, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(f.read().state, "available"); assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
});

test("Trace read touches only selected body/metadata, never journal/outcome/discovery/lifecycle/native/time or mutation", t => {
  const f = fixture(t); f.append(); f.publish(); const unrelated = join(f.stateDir, "evidence", "recipe.json"); fs.writeFileSync(unrelated, "PRIVATE_OTHER_ROLE");
  const index = json(f.indexPath); index.entries.recipe = { availability: "available", path: "evidence/recipe.json", media_type: "application/json", bytes_total: fs.statSync(unrelated).size, mutable: true, coverage: { truncated: true, redacted: true } }; writeJsonAtomic(f.indexPath, index);
  fs.writeFileSync(f.journal, "PRIVATE_MALFORMED_JOURNAL"); fs.writeFileSync(join(f.stateDir, "result.json"), "PRIVATE_MALFORMED_OUTCOME");
  const saved = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
    mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const fds = new Map<number, string>(), allowed = new Set([f.metaPath, f.indexPath, f.viewPath, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)]); let selected = 0;
  fs.openSync = ((path, ...args) => { assert.equal(String(path).includes(".lifecycle"), false); const fd = Reflect.apply(saved.openSync, fs, [path, ...args]); fds.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return saved.closeSync(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd, ...args) => { assert.ok(allowed.has(fds.get(fd)!)); if (fds.get(fd) === f.viewPath) selected++; return Reflect.apply(saved.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.readFileSync = ((path, ...args) => { assert.ok(allowed.has(typeof path === "number" ? fds.get(path)! : String(path))); return Reflect.apply(saved.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
  const forbidden = () => assert.fail("Trace read performed side effect/sampling"); const kill = process.kill, now = Date.now;
  fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
  try { const read = f.read(); assert.equal(read.state, "available"); if (read.state === "available") assert.equal(read.unchanged(), true); }
  finally { Object.assign(fs, saved); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  assert.equal(selected, 1); assert.equal(fds.size, 0);
});

test("Trace root/marker/metadata/index/view substitutions after actual selected-body read invalidate admission", t => {
  for (const change of ["root", "marker", "metadata", "index", "view"]) {
    const f = fixture(t); f.append(); f.publish(); const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(), readFds = new Set<number>(); let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { const selected = fds.delete(fd), body = readFds.delete(fd); const result = close(fd); if (selected && body && !changed) { changed = true;
      if (change === "root") { fs.renameSync(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
      else { const path = change === "marker" ? join(f.stateDir, RUN_STATE_OWNERSHIP_FILE) : change === "metadata" ? f.metaPath : change === "index" ? f.indexPath : f.viewPath;
        const bytes = fs.readFileSync(path); fs.renameSync(path, path + ".held"); fs.writeFileSync(path, bytes); }
    } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.deepEqual(f.read(), { state: "unavailable", reason: "observation_changed" }); assert.equal(changed, true); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  }
});

test("Trace corrupt/denied/symlinked sources and failed-close descriptors never repair publication data", t => {
  const f = fixture(t); f.append(); f.publish(); const original = fs.readFileSync(f.viewPath);
  for (const value of ["{bad\n", Buffer.from([0xff])]) { fs.writeFileSync(f.viewPath, value); f.updateSize(); assert.equal(f.read().state, "unavailable"); }
  fs.writeFileSync(f.viewPath, original); f.updateSize(); const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(), readFds = new Set<number>(); let injected = false;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) readFds.add(fd); return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { const selected = fds.delete(fd), body = readFds.delete(fd); const result = close(fd); if (selected && body && !injected) { injected = true; throw Object.assign(Error("view close EIO"), { code: "EIO" }); } return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  fs.openSync = ((path, ...args) => { if (String(path) === f.viewPath) throw Object.assign(Error("private view denied"), { code: "EACCES" }); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal(f.read().state, "unavailable"); } finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.viewPath), original);
  if (process.platform !== "win32") { fs.renameSync(f.viewPath, f.viewPath + ".held"); fs.symlinkSync(f.viewPath + ".held", f.viewPath); assert.equal(f.read().state, "unavailable"); }
});

test("Trace source and complete encoded response budgets are independent and never clip original rows", t => {
  const f = fixture(t); f.append({ fields: Array.from({ length: 16 }, () => "x".repeat(3900)), pad: "" }); f.publish();
  const gap = RUN_CONTEXT_TRACE_MAX_BYTES - fs.statSync(f.viewPath).size; assert.ok(gap > 0 && gap < 4000);
  const journal = readRunTraceJournal(f.stateDir); (journal.events[0].event.data as any).pad = "x".repeat(gap);
  fs.writeFileSync(f.journal, journal.events.map(row => JSON.stringify(row.event)).join("\n") + "\n"); f.publish();
  assert.equal(fs.statSync(f.viewPath).size, RUN_CONTEXT_TRACE_MAX_BYTES); assert.deepEqual(f.read(), { state: "unavailable", reason: "response_too_large" });
  fs.appendFileSync(f.viewPath, " "); f.updateSize(); const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set<number>(); let reads = 0;
  fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.viewPath) fds.add(fd); return fd; }) as typeof fs.openSync;
  fs.readSync = ((fd, ...args) => { if (fds.has(fd)) reads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
  fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
  try { assert.deepEqual(f.read(), { state: "unavailable", reason: "view_unavailable" }); } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
  assert.equal(reads, 0);
});

});
