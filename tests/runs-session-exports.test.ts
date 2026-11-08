/** Mirrors runs-session-exports.ts: projection, recorded preview, producer publication and published follow contracts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after, describe, type TestContext } from "node:test";

const { afterMutationLockRelease } = await import(new URL("./test-environment.mjs", import.meta.url).href);

const agentDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-session-exports-agent-")));
const previousAgent = process.env.PI_CODING_AGENT_DIR, previousReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
  if (previousReview === undefined) delete process.env.PI_ACTORS_AUTOMATIC_REVIEW; else process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousReview;
  fs.rmSync(agentDir, { recursive: true, force: true });
});
// Isolate before any product import; all sections share one module/runtime and no native Actor workload.
const { writeRunResultContextIndex } = await import("../lib/runs-context-exports.ts");
const { writeRunSessionContextExport, writeRunSessionContextIndex, readRunSessionContextPreview,
  projectSessionAssistantPreview, readRunSessionPreview, RUN_CONTEXT_SESSIONS_MAX_BYTES, SESSION_ASSISTANT_PREVIEW_MAX_BYTES } =
  await import("../lib/runs-session-exports.ts");
const { admitRunResultProducer, publishRunResult } = await import("../lib/runs-results.ts");
const { claimRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } = await import("../lib/runs-ownership.ts");
const { readProcessIdentity } = await import("../lib/runs-process.ts");
const { RUN_OUTCOME_PROTOCOL } = await import("../lib/runs-outcomes.ts");
const { createRunSupervisionClock } = await import("../lib/run-supervision.ts");
const { writeJsonAtomic, mutationLockPath } = await import("../lib/file-state.ts");
const { readRunContextIndex, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import("../lib/runs-context-index.ts");
const { SESSION_EVIDENCE_MAX_BYTES } = await import("../lib/limits.ts");

describe("Producer-bound publication", { concurrency: false }, () => {
  const body = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));

  function fixture(t: TestContext, prepare?: (meta: Record<string, unknown>) => void) {
    const root = fs.realpathSync(fs.mkdtempSync(join(agentDir, "case-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = claimRunStateDirectory(join(root, "state"), "session-view");
    const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
    const meta = { run: "session-view", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, createdAt: clock.started_at, ...clock,
      pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL, values: { skill_dir: "/private/skill" } };
    const metaPath = join(stateDir, "run.json"); prepare?.(meta); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
    const sessions = ["sessions/command-001/first.jsonl", "sessions/command-001/second.jsonl"];
    for (const [index, relative] of sessions.entries()) { const file = join(stateDir, relative); fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file,
      [JSON.stringify({ type: "session", version: 3, id: "HIDDEN_ID", parentSession: "/private/parent" }),
        JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "HIDDEN_USER" } }),
        JSON.stringify({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: `/private/skill/helper token=HIDDEN_TOKEN visible-${index}` }, { type: "thinking", thinking: "HIDDEN_THINKING" }] } })].join("\n") + "\n"); }
    const executionPath = join(stateDir, "execution.json"); writeJsonAtomic(executionPath, { version: 1, run: meta.run, run_instance_id: meta.run_instance_id, updated_at: clock.started_at,
      status: "running", active_subagents: 1, commands: [{ id: "command-001", status: "running", attempts: [], session_files: sessions }] });
    const query = (index = 0) => ({ kind: "session", command_id: "command-001", path: sessions[index] });
    const manifest = join(stateDir, "evidence", "sessions.json");
    const publish = (index = 0) => writeRunSessionContextExport(stateDir, producer, query(index));
    const publishIndex = (index = 0) => writeRunSessionContextIndex(stateDir, producer, query(index));
    return { root, stateDir, meta, metaPath, producer, executionPath, sessions, query, manifest, publish, publishIndex };
  }

  function peerFixture(t: TestContext, field: "command_id" | "export_id" | "captured_at" | "observed_time" | "path", state: "available" | "missing" | "unavailable", present: boolean) {
    const f = fixture(t); assert.equal(f.publishIndex().status, "published"); const catalog = body(f.manifest), peer = catalog.previews[0];
    const peerPath = join(f.stateDir, peer.path), time = "2001-01-01T00:00:00.000Z";
    if (field === "captured_at" || field === "observed_time") { writeJsonAtomic(peerPath, { ...body(peerPath), captured_at: time });
      if (field === "captured_at") { peer.captured_at = time; writeJsonAtomic(f.manifest, catalog); } }
    const secret = field === "path" ? peer.path : field === "observed_time" ? time : peer[field];
    if (state !== "available") { fs.rmSync(peerPath); if (state === "unavailable") assert.equal(f.publishIndex(1).status, "published"); }
    const relative = "sessions/command-002/current.jsonl", raw = join(f.stateDir, relative); fs.mkdirSync(join(raw, ".."), { recursive: true }); fs.copyFileSync(join(f.stateDir, f.sessions[1]), raw);
    const execution = body(f.executionPath); execution.updated_at = "2000-01-01T00:00:00.000Z";
    execution.commands.push({ id: "command-002", status: "running", attempts: [], session_files: [relative] }); writeJsonAtomic(f.executionPath, execution);
    writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? { api_key: secret } : {} }); const producer = admitRunResultProducer(f.stateDir).producer;
    writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } });
    const query = { kind: "session", command_id: "command-002", path: relative }, id = createHash("sha256").update(JSON.stringify([query.command_id, query.path])).digest("hex");
    return { ...f, producer, query, id, target: join(f.stateDir, "evidence", "sessions", "session-" + id + ".json"), peer, peerPath,
      canonical: [f.metaPath, f.executionPath, ...f.sessions.map(path => join(f.stateDir, path)), raw],
      write: () => writeRunSessionContextExport(f.stateDir, producer, query), index: () => writeRunSessionContextIndex(f.stateDir, producer, query) };
  }

  test("Session context writes actual assistant-only files plus a truthful published-preview catalog and context role", t => {
    const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 7 }); writeRunResultContextIndex(f.stateDir, f.producer);
    const canonical = [f.metaPath, f.executionPath, join(f.stateDir, "result.json"), ...f.sessions.map(path => join(f.stateDir, path))];
    const before = canonical.map(path => fs.readFileSync(path));
    assert.equal(f.publishIndex().status, "published");
    const manifest = body(f.manifest); assert.equal(manifest.schema, "run-context-sessions-v1");
    assert.equal(manifest.inventory_scope, "published_previews"); assert.equal(manifest.inventory_complete, false); assert.equal(manifest.previews.length, 1);
    const entry = manifest.previews[0]; assert.equal(entry.availability, "available"); assert.match(entry.path, /^evidence\/sessions\/session-[a-f0-9]{64}\.json$/);
    const view = body(join(f.stateDir, entry.path)); assert.equal(view.schema, "run-context-session-preview-v1");
    assert.equal(view.run_instance_id, f.meta.run_instance_id); assert.equal(view.command_id, "command-001");
    assert.match(view.preview.messages[0].assistant_text, /visible-0/); assert.equal(view.preview.primary_text, "not_exported");
    assert.equal(entry.bytes_total, fs.statSync(join(f.stateDir, entry.path)).size);
    assert.doesNotMatch(fs.readFileSync(f.manifest, "utf8") + JSON.stringify(view), /HIDDEN_|\/private\/|first\.jsonl|parentSession|thinkingSignature/);
    const index = readRunContextIndex(f.stateDir, f.meta); assert.equal(index.state, "available");
    if (index.state === "available") { assert.equal(index.index.entries.sessions.availability, "available"); assert.equal(index.index.entries.result.availability, "available"); }
    assert.deepEqual(canonical.map(path => fs.readFileSync(path)), before);
  });

  test("Original selected Session metadata stays exact or refuses before bodies/preview commits without renewing per-call privacy", t => {
    const relative = "sessions/command-001/first.jsonl", id = createHash("sha256").update(JSON.stringify(["command-001", relative])).digest("hex");
    for (const field of ["command_id", "source_updated_at", "export_id", "path"] as const) for (const present of [true, false]) {
      const secret = field === "command_id" ? "command-001" : field === "source_updated_at" ? "2001-01-01T00:00:00.000Z" : field === "export_id" ? id : "session-" + id + ".json";
      const f = fixture(t, meta => { meta.values = present ? { api_key: secret } : {}; });
      if (field === "source_updated_at") writeJsonAtomic(f.executionPath, { ...body(f.executionPath), updated_at: secret });
      const canonical = [f.metaPath, f.executionPath, ...f.sessions.map(path => join(f.stateDir, path))];
      for (const phase of ["first", "refresh"]) {
        writeJsonAtomic(f.metaPath, { ...f.meta, values: present ? {} : { api_key: secret } }); const before = canonical.map(path => fs.readFileSync(path));
        const raw = readRunSessionPreview(f.stateDir, f.meta, f.query()); assert.equal(raw.state, "available");
        const extra = Reflect.apply(readRunSessionPreview, undefined, [f.stateDir, f.meta, f.query(), f.meta]); assert.deepEqual(extra.preview, raw.state === "available" ? raw.preview : undefined);
        const guarded = present && ["command_id", "source_updated_at"].includes(field), open = fs.openSync, read = fs.readFileSync, readSync = fs.readSync, close = fs.closeSync;
        const forbidden = [field === "command_id" ? f.executionPath : "", ...f.sessions.map(path => join(f.stateDir, path))]; let probes = 0;
        const descriptors = new Map<number, string>();
        const check = (path: unknown) => { if (guarded && forbidden.includes(String(path))) { probes++; assert.fail("Private selected metadata read a forbidden body"); } };
        fs.openSync = ((path, ...args) => { if (field === "command_id") check(path); const fd = Reflect.apply(open, fs, [path, ...args]); descriptors.set(fd, String(path)); return fd; }) as typeof fs.openSync;
        fs.closeSync = ((fd) => { descriptors.delete(fd); return close(fd); }) as typeof fs.closeSync;
        fs.readSync = ((fd, ...args) => { check(descriptors.get(fd)); return Reflect.apply(readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
        fs.readFileSync = ((path, ...args) => { check(typeof path === "number" ? descriptors.get(path) : path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
        syncBuiltinESMExports(); let published: ReturnType<typeof f.publish>;
        try { published = f.publish(); } finally { fs.openSync = open; fs.readFileSync = read; fs.readSync = readSync; fs.closeSync = close; syncBuiltinESMExports(); }
        assert.equal(probes, 0, field + ":" + phase); assert.equal(descriptors.size, 0); if (present) { assert.deepEqual(published, { status: "unavailable", reason: "session_metadata_redacted" });
          assert.equal(fs.existsSync(f.manifest), false); assert.equal(fs.existsSync(join(f.stateDir, "evidence", "sessions", "session-" + id + ".json")), false); }
        else { assert.equal(published.status, "written"); const entry = body(f.manifest).previews[0], saved = body(join(f.stateDir, entry.path));
          assert.equal(entry.command_id, "command-001"); assert.equal(entry.export_id, id); assert.equal(entry.path, "evidence/sessions/session-" + id + ".json");
          if (field === "source_updated_at") assert.equal(saved.source_updated_at, secret); }
        assert.equal(f.publishIndex().status, "published"); const entry = body(join(f.stateDir, "context-index.json")).entries.sessions;
        assert.equal(entry.availability, present ? "unavailable" : "available"); if (present) assert.equal(entry.reason, "session_metadata_redacted");
        else assert.equal(readRunSessionContextPreview(f.stateDir, f.meta, id).state, "available");
        assert.deepEqual(canonical.map(path => fs.readFileSync(path)), before);
      }
      assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
    }
  });

  test("Session writer fixes original privacy before counts/clipping while raw per-call and saved-byte contracts stay distinct", t => {
    for (const absent of [false, true]) for (const mode of ["caller_only", "before_first", "refresh"] as const) {
      const f = fixture(t, meta => { if (absent) meta.values = {}; }); const original = JSON.parse(JSON.stringify(f.meta));
      let originalId: string | undefined;
      if (mode === "refresh") { f.publishIndex(); originalId = body(f.manifest).previews[0].export_id; }
      f.meta.values.skill_dir = "/caller-mutated";
      if (mode !== "caller_only") writeJsonAtomic(f.metaPath, { ...original, values: { skill_dir: absent ? "/private/skill" : "/actor/replacement" }, visibility: "public" });
      const sourcePath = join(f.stateDir, f.sessions[0]); fs.appendFileSync(sourcePath, JSON.stringify({ type: "message", id: "later", parentId: "a", message: { role: "assistant", content: [
        { type: "text", text: "/private/skill/later token=HIDDEN_LATER " + "🫧".repeat(4300) }, { type: "thinking", thinking: "HIDDEN_LATER_THINKING" }] } }) + "\n");
      const expected = projectSessionAssistantPreview(fs.readFileSync(sourcePath, "utf8"), original); assert.equal(expected.state, "available");
      const raw = readRunSessionPreview(f.stateDir, original, f.query()); assert.equal(raw.state, "available");
      const extra = Reflect.apply(readRunSessionPreview, undefined, [f.stateDir, original, f.query(), original]); assert.equal(extra.state, "available");
      if (raw.state === "available") { assert.deepEqual(extra.preview, raw.preview); if (mode !== "caller_only" && expected.state === "available") assert.notDeepEqual(raw.preview, expected.preview); }
      const canonical = [f.metaPath, f.executionPath, ...f.sessions.map(path => join(f.stateDir, path))]; const before = canonical.map(path => fs.readFileSync(path));
      assert.equal(f.publishIndex().status, "published"); const entry = body(f.manifest).previews[0]; const saved = body(join(f.stateDir, entry.path));
      if (!absent) assert.doesNotMatch(JSON.stringify(saved), /\/private\/skill/);
      assert.doesNotMatch(JSON.stringify(saved), /HIDDEN_|caller-mutated|\/actor\/replacement|first\.jsonl|thinkingSignature/);
      if (expected.state === "available") assert.deepEqual(saved.preview, expected.preview);
      assert.equal(saved.preview.messages_total, 2); assert.equal(saved.preview.messages[1].text_chars_shown, 4000); assert.equal(saved.preview.messages[1].preview_clipped, true);
      const followed = readRunSessionContextPreview(f.stateDir, original, entry.export_id); assert.equal(followed.state, "available");
      if (followed.state === "available") assert.deepEqual(followed.preview, saved.preview);
      if (originalId !== undefined) assert.equal(entry.export_id, originalId);
      assert.deepEqual(canonical.map(path => fs.readFileSync(path)), before);
    }
  });

  test("Original immutable peer command/hash metadata refuses whole catalog before selected preview commit, including missing/unavailable peers", t => {
    for (const field of ["command_id", "export_id"] as const) for (const state of ["available", "missing", "unavailable"] as const) for (const present of [true, false]) {
      const f = peerFixture(t, field, state, present), before = fs.readFileSync(f.manifest), canonical = f.canonical.map(path => fs.readFileSync(path));
      const peerBytes = fs.existsSync(f.peerPath) ? fs.readFileSync(f.peerPath) : undefined;
      const result = f.write();
      if (present) { assert.deepEqual(result, { status: "unavailable", reason: "session_metadata_redacted" }, field + ":" + state);
        assert.deepEqual(fs.readFileSync(f.manifest), before); assert.equal(fs.existsSync(f.target), false); }
      else { assert.equal(result.status, "written"); const entry = body(f.manifest).previews.find((entry: { export_id: string }) => entry.export_id === f.peer.export_id);
        assert.equal(entry[field], f.peer[field]); assert.equal(entry.availability, state === "available" ? "available" : "unavailable"); }
      if (peerBytes) assert.deepEqual(fs.readFileSync(f.peerPath), peerBytes); else assert.equal(fs.existsSync(f.peerPath), false);
      assert.equal(f.index().status, "published"); const index = body(join(f.stateDir, "context-index.json")).entries.sessions;
      assert.equal(index.availability, present ? "unavailable" : "available"); if (present) assert.equal(index.reason, "session_metadata_redacted");
      else assert.equal(readRunSessionContextPreview(f.stateDir, f.meta, f.id).state, "available");
      assert.deepEqual(f.canonical.map(path => fs.readFileSync(path)), canonical); assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
    }
  });

  test("Observed peer time/path privacy is checked on actual emitted metadata after preview commit without repairing saved bodies or masking unavailable refs", t => {
    for (const field of ["captured_at", "observed_time", "path"] as const) for (const state of ["available", "missing", "unavailable"] as const) for (const present of [true, false]) {
      const f = peerFixture(t, field, state, present), before = fs.readFileSync(f.manifest), canonical = f.canonical.map(path => fs.readFileSync(path));
      const peerBytes = fs.existsSync(f.peerPath) ? fs.readFileSync(f.peerPath) : undefined;
      const privateEmission = present && (field === "captured_at" || state === "available"); const result = f.write();
      if (privateEmission) { assert.deepEqual(result, { status: "unavailable", reason: "session_metadata_redacted" }, field + ":" + state);
        assert.deepEqual(fs.readFileSync(f.manifest), before); assert.equal(fs.existsSync(f.target), true);
        assert.equal(body(f.target).command_id, "command-002"); assert.equal(body(f.target).preview.messages[0].assistant_text.includes("visible-1"), true); }
      else { assert.equal(result.status, "written"); const entry = body(f.manifest).previews.find((entry: { export_id: string }) => entry.export_id === f.peer.export_id);
        assert.equal(entry.availability, state === "available" ? "available" : "unavailable"); if (state !== "available") assert.equal(entry.path, null);
        if (field === "observed_time") assert.equal(entry.captured_at, state === "available" ? "2001-01-01T00:00:00.000Z" : f.peer.captured_at); }
      if (peerBytes) assert.deepEqual(fs.readFileSync(f.peerPath), peerBytes); else assert.equal(fs.existsSync(f.peerPath), false);
      assert.equal(f.index().status, "published"); const index = body(join(f.stateDir, "context-index.json")).entries.sessions;
      assert.equal(index.availability, privateEmission ? "unavailable" : "available"); if (privateEmission) assert.equal(index.reason, "session_metadata_redacted");
      else assert.equal(readRunSessionContextPreview(f.stateDir, f.meta, f.id).state, "available");
      assert.deepEqual(f.canonical.map(path => fs.readFileSync(path)), canonical); assert.equal(fs.existsSync(join(f.stateDir, "result.json")), false);
      if (field === "captured_at" && state === "available" && present) {
        // A stale private catalog time is not re-emitted after an explicit healthy peer-metadata observation.
        writeJsonAtomic(f.peerPath, { ...body(f.peerPath), captured_at: "2002-01-01T00:00:00.000Z" }); const healthy = fs.readFileSync(f.peerPath);
        assert.equal(f.index().status, "published"); assert.equal(body(join(f.stateDir, "context-index.json")).entries.sessions.availability, "available");
        assert.equal(body(f.manifest).previews.find((entry: { export_id: string }) => entry.export_id === f.peer.export_id).captured_at, "2002-01-01T00:00:00.000Z");
        assert.deepEqual(fs.readFileSync(f.peerPath), healthy);
      }
    }
  });

  test("Peer privacy cannot normalize an exact earlier preview-write error or roll back its committed bytes", t => {
    const f = peerFixture(t, "observed_time", "available", true), catalog = fs.readFileSync(f.manifest), peer = fs.readFileSync(f.peerPath);
    const rename = fs.renameSync, failure = Object.assign(new Error("session preview EIO before later peer metadata refusal"), { code: "EIO" }); let attempts = 0;
    fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.target) { attempts++; throw failure; } return result; }) as typeof fs.renameSync;
    syncBuiltinESMExports(); try { assert.throws(f.write, error => error === failure); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(attempts, 1); assert.equal(fs.existsSync(f.target), true); assert.deepEqual(fs.readFileSync(f.manifest), catalog); assert.deepEqual(fs.readFileSync(f.peerPath), peer);
    const contradiction = body(f.manifest); contradiction.previews[0].export_id = f.id; contradiction.previews[0].path = "evidence/sessions/session-" + f.id + ".json";
    contradiction.previews[0].command_id = "command-001"; writeJsonAtomic(f.manifest, contradiction); const corrupt = fs.readFileSync(f.manifest), orphan = fs.readFileSync(f.target);
    assert.throws(f.write, { message: "Run session catalog binding contradicts the selected preview." });
    assert.deepEqual(fs.readFileSync(f.manifest), corrupt); assert.deepEqual(fs.readFileSync(f.target), orphan);
  });

  test("Session catalog merges only known published selections, refreshes idempotently and marks unavailable retained files", t => {
    const f = fixture(t); f.publish(0); f.publish(1); assert.equal(body(f.manifest).previews.length, 2);
    f.publish(1); const before = body(f.manifest); assert.equal(before.previews.length, 2);
    const first = before.previews.find((entry: { path: string }) => body(join(f.stateDir, entry.path)).preview.messages[0].assistant_text.includes("visible-0"));
    fs.rmSync(join(f.stateDir, first.path)); f.publish(1);
    const retained = body(f.manifest).previews.find((entry: { export_id: string }) => entry.export_id === first.export_id);
    assert.deepEqual(retained, { export_id: first.export_id, command_id: first.command_id, captured_at: first.captured_at,
      availability: "unavailable", path: null, reason: "preview_export_unavailable" });
  });

  test("Retained catalog export-id/command contradictions are refused before replacing published evidence", t => {
    const f = fixture(t); f.publish(); const catalog = body(f.manifest); catalog.previews[0].command_id = "command-002"; writeJsonAtomic(f.manifest, catalog);
    const previewPath = join(f.stateDir, catalog.previews[0].path); const before = [f.manifest, previewPath].map(path => fs.readFileSync(path));
    assert.throws(() => f.publish(), /session.*binding/i);
    assert.deepEqual([f.manifest, previewPath].map(path => fs.readFileSync(path)), before);
  });

  test("Session writer refuses over-budget original privacy before raw body reads despite a healthy per-call preview", t => {
    let healthy: unknown;
    const over = fixture(t, meta => { healthy = JSON.parse(JSON.stringify(meta)); meta.values = { ...(meta.values as Record<string, unknown>), note: "🫧".repeat(300000) };
      const encoded = JSON.stringify(meta); assert.ok(encoded.length < RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); assert.ok(Buffer.byteLength(encoded) > RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES); });
    writeJsonAtomic(over.metaPath, healthy); assert.equal(readRunSessionPreview(over.stateDir, over.meta, over.query()).state, "available");
    const sourcePaths = over.sessions.map(path => join(over.stateDir, path)); const before = sourcePaths.map(path => fs.readFileSync(path));
    const open = fs.openSync; let sourceOpens = 0;
    fs.openSync = ((path, ...args) => { if (sourcePaths.includes(String(path))) sourceOpens++; return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync; syncBuiltinESMExports();
    try { assert.deepEqual(over.publish(), { status: "unavailable", reason: "session_admission_unavailable" }); }
    finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.equal(sourceOpens, 0); assert.equal(fs.existsSync(over.manifest), false); assert.deepEqual(sourcePaths.map(path => fs.readFileSync(path)), before);
    over.publishIndex(); assert.deepEqual(body(join(over.stateDir, "context-index.json")).entries.sessions,
      { availability: "unavailable", path: null, reason: "session_admission_unavailable" });
    const f = fixture(t); const base = { ...f.meta, padding: "" }; const room = RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
    fs.writeFileSync(f.metaPath, JSON.stringify({ ...base, padding: "x".repeat(room) })); assert.equal(fs.statSync(f.metaPath).size, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    assert.equal(f.publish().status, "written"); const previewPath = join(f.stateDir, body(f.manifest).previews[0].path);
    const retained = [previewPath, f.manifest].map(path => fs.readFileSync(path));
    fs.appendFileSync(f.metaPath, " "); assert.equal(f.publish().status, "unavailable"); assert.deepEqual([previewPath, f.manifest].map(path => fs.readFileSync(path)), retained);
    const corrupt = Buffer.from(JSON.stringify({ ...f.meta, padding: "X" })); corrupt[corrupt.indexOf('"X"') + 1] = 0xff;
    fs.writeFileSync(f.metaPath, corrupt); assert.equal(f.publish().status, "unavailable"); assert.deepEqual([previewPath, f.manifest].map(path => fs.readFileSync(path)), retained);
  });

  test("Session source/manifest/metadata/marker/root changes after original-privacy capture retain preview and catalog without recapture", t => {
    for (const change of ["source", "manifest", "metadata", "marker", "root"] as const) {
      const f = fixture(t); f.publish(); const previewPath = join(f.stateDir, body(f.manifest).previews[0].path);
      const paths = [previewPath, f.manifest]; const before = paths.map(path => fs.readFileSync(path));
      const lock = mutationLockPath(join(f.stateDir, ".lifecycle")); const rename = fs.renameSync; let changed = false;
      const releaseHook = afterMutationLockRelease(lock, () => {
          changed = true;
          if (change === "source") fs.appendFileSync(join(f.stateDir, f.sessions[0]), " ");
          else if (change === "manifest") writeJsonAtomic(f.executionPath, { ...body(f.executionPath), active_subagents: 2 });
          else if (change === "metadata") writeJsonAtomic(f.metaPath, { ...f.meta, values: { skill_dir: "/actor/replacement" } });
          else if (change === "marker") { const path = join(f.stateDir, RUN_STATE_OWNERSHIP_FILE); rename(path, path + ".held"); fs.copyFileSync(path + ".held", path); }
          else { rename(f.stateDir, f.stateDir + ".held"); fs.cpSync(f.stateDir + ".held", f.stateDir, { recursive: true }); }
        });
      try { assert.throws(() => f.publish(), /session.*changed/i); assert.equal(changed, true); }
      finally { releaseHook(); }
      assert.deepEqual(paths.map(path => fs.readFileSync(path)), before);
    }
  });

  test("Missing/unrecorded sources create no pretend empty preview and copied producers cannot publish", t => {
    const f = fixture(t); assert.throws(() => writeRunSessionContextExport(f.stateDir, { ...f.producer }, f.query()), /admitted by this runtime/);
    const query = { ...f.query(), path: "sessions/command-001/unrecorded.jsonl" };
    assert.equal(writeRunSessionContextExport(f.stateDir, f.producer, query).status, "unavailable");
    assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false);
    fs.rmSync(f.executionPath); assert.equal(f.publishIndex().status, "published");
    assert.deepEqual(body(join(f.stateDir, "context-index.json")).entries.sessions, { availability: "pending", path: null });
    assert.equal(fs.existsSync(f.manifest), false);
  });

  test("Session publication re-admits genuine generation and never catches root-outcome refusal", t => {
    const f = fixture(t); const lock = mutationLockPath(join(f.stateDir, ".lifecycle")); let changed = false;
    const releaseHook = afterMutationLockRelease(lock, () => { changed = true; writeJsonAtomic(f.metaPath, { ...f.meta, run_instance_id: "generation-b" }); });
    try { assert.throws(() => f.publish(), /generation changed/); assert.equal(changed, true); }
    finally { releaseHook(); }
    assert.equal(fs.existsSync(f.manifest), false);
    const other = fixture(t); publishRunResult(other.stateDir, other.producer, { code: 0 });
    const resultPath = join(other.stateDir, "result.json"); writeJsonAtomic(resultPath, { ...body(resultPath), code: "0" });
    assert.throws(() => other.publish(), /Run evidence state is unavailable or invalid/);
  });

  test("Observed raw-source changes during preview staging preserve old preview/catalog bytes without internal recapture", t => {
    const f = fixture(t); f.publish(); const entry = body(f.manifest).previews[0]; const path = join(f.stateDir, entry.path);
    const before = [path, f.manifest].map(path => fs.readFileSync(path)); const write = fs.writeFileSync; let changed = false;
    fs.writeFileSync = ((target, ...args) => { const result = Reflect.apply(write, fs, [target, ...args]); if (!changed && String(target).startsWith(path + ".")) { changed = true; fs.appendFileSync(join(f.stateDir, f.sessions[0]), " "); } return result; }) as typeof fs.writeFileSync; syncBuiltinESMExports();
    try { assert.throws(() => f.publish(), /session.*changed/i); assert.equal(changed, true); }
    finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.deepEqual([path, f.manifest].map(path => fs.readFileSync(path)), before);
  });

  test("Session export refuses corrupt catalogs and foreign preview targets instead of repairing or overwriting them", t => {
    const f = fixture(t); f.publish(); const path = join(f.stateDir, body(f.manifest).previews[0].path);
    writeJsonAtomic(path, { ...body(path), run_instance_id: "foreign" }); const foreign = fs.readFileSync(path);
    assert.throws(() => f.publish(), /session.*binding/i); assert.deepEqual(fs.readFileSync(path), foreign);
    fs.writeFileSync(f.manifest, "{broken"); const bad = fs.readFileSync(f.manifest);
    assert.throws(() => f.publish(1), /session.*catalog/i); assert.deepEqual(fs.readFileSync(f.manifest), bad);
  });

  test("Denied cached preview metadata becomes explicitly unavailable without blocking a different admitted preview", t => {
    const f = fixture(t); f.publish(0); f.publish(1);
    const first = body(f.manifest).previews.find((entry: { path: string }) => body(join(f.stateDir, entry.path)).preview.messages[0].assistant_text.includes("visible-0"));
    const path = join(f.stateDir, first.path); const stat = fs.lstatSync;
    fs.lstatSync = ((candidate, ...args) => { if (String(candidate) === path) throw Object.assign(new Error("cached view denied"), { code: "EACCES" }); return Reflect.apply(stat, fs, [candidate, ...args]); }) as typeof fs.lstatSync; syncBuiltinESMExports();
    try { assert.equal(f.publish(1).status, "written"); }
    finally { fs.lstatSync = stat; syncBuiltinESMExports(); }
    const entry = body(f.manifest).previews.find((entry: { export_id: string }) => entry.export_id === first.export_id);
    assert.equal(entry.availability, "unavailable"); assert.equal(entry.path, null); assert.equal(fs.existsSync(path), true);
  });

  test("Symlinked preview directories or catalogs never become publication targets", { skip: process.platform === "win32" }, t => {
    const f = fixture(t); f.publish(); const directory = join(f.stateDir, "evidence", "sessions");
    fs.renameSync(directory, directory + ".held"); fs.symlinkSync(directory + ".held", directory, "dir"); assert.throws(() => f.publish(), /session.*directory/i);
    fs.rmSync(directory); fs.renameSync(directory + ".held", directory);
    fs.renameSync(f.manifest, f.manifest + ".held"); fs.symlinkSync(f.manifest + ".held", f.manifest); assert.throws(() => f.publish(), /session.*catalog/i);
  });

  test("Preview/catalog write failures preserve exact errors and committed effects, with no write retry or rollback", t => {
    const f = fixture(t); const rename = fs.renameSync;
    for (const stage of ["preview", "catalog"]) {
      const failure = Object.assign(new Error("session " + stage + " EIO after commit"), { code: "EIO" }); let attempts = 0;
      fs.renameSync = ((from, to) => { const result = rename(from, to); const target = String(to); if (stage === "preview" ? /^session-[a-f0-9]{64}\.json$/.test(target.split(/[\\/]/).at(-1) ?? "") : target === f.manifest) { attempts++; throw failure; } return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
      try { assert.throws(() => f.publish(), error => error === failure); }
      finally { fs.renameSync = rename; syncBuiltinESMExports(); }
      assert.equal(attempts, 1);
      if (stage === "preview") assert.equal(fs.existsSync(f.manifest), false); else assert.equal(body(f.manifest).previews.length, 1);
    }
    assert.equal(f.publish().status, "written");
  });

  test("Session catalog overflow refuses the whole metadata refresh and retains an already committed preview without partial lists", t => {
    const f = fixture(t); f.publish(); const catalog = body(f.manifest);
    for (let index = 0; ; index++) {
      const entry = { export_id: index.toString(16).padStart(64, "0"), command_id: "command-001", captured_at: catalog.updated_at,
        availability: "unavailable", path: null, reason: "preview_export_unavailable" };
      const candidate = { ...catalog, previews: [...catalog.previews, entry], previews_total: catalog.previews.length + 1 };
      if (Buffer.byteLength(JSON.stringify(candidate, null, 2) + "\n") > RUN_CONTEXT_SESSIONS_MAX_BYTES) break;
      catalog.previews = candidate.previews; catalog.previews_total = candidate.previews_total;
    }
    const content = JSON.stringify(catalog, null, 2) + "\n"; assert.ok(Buffer.byteLength(content) <= RUN_CONTEXT_SESSIONS_MAX_BYTES);
    fs.writeFileSync(f.manifest, content); const before = fs.readFileSync(f.manifest); const directory = join(f.stateDir, "evidence", "sessions");
    const files = fs.readdirSync(directory).length;
    assert.throws(() => f.publish(1), /session catalog exceeds.*bounded/i);
    assert.deepEqual(fs.readFileSync(f.manifest), before); assert.equal(fs.readdirSync(directory).length, files + 1);
  });

  test("Context-index failure is a later independent commit and preserves session files, Result metadata and canonical state", t => {
    const f = fixture(t); publishRunResult(f.stateDir, f.producer, { code: 0 }); writeRunResultContextIndex(f.stateDir, f.producer);
    const before = [f.metaPath, f.executionPath, join(f.stateDir, "result.json")].map(path => fs.readFileSync(path));
    const rename = fs.renameSync; const failure = Object.assign(new Error("session index EIO after commit"), { code: "EIO" }); let attempts = 0;
    fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === join(f.stateDir, "context-index.json")) { attempts++; throw failure; } return result; }) as typeof fs.renameSync; syncBuiltinESMExports();
    try { assert.throws(() => f.publishIndex(), error => error === failure); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(attempts, 1); assert.equal(body(f.manifest).previews.length, 1);
    assert.equal(body(join(f.stateDir, "context-index.json")).entries.sessions.availability, "available");
    assert.deepEqual([f.metaPath, f.executionPath, join(f.stateDir, "result.json")].map(path => fs.readFileSync(path)), before);
  });
});

describe("Recorded-session preview", { concurrency: false }, () => {
  function fixture(t: TestContext) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-actors-session-preview-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = { run: "preview", run_instance_id: "generation-a", ownerId: "owner-a" };
    const stateDir = claimRunStateDirectory(join(root, "state"), identity.run);
    const meta = { ...identity, state_dir: stateDir, pid: 0, values: { skill_dir: "/private/skill" } };
    const metaPath = join(stateDir, "run.json"); fs.writeFileSync(metaPath, JSON.stringify(meta));
    const relative = "sessions/command-001/session.jsonl"; const file = join(stateDir, relative); fs.mkdirSync(join(file, ".."), { recursive: true });
    const records = [{ type: "session", version: 3, id: "HIDDEN_SESSION", parentSession: "/private/parent" },
      { type: "message", id: "user", parentId: null, message: { role: "user", content: "HIDDEN_USER" } },
      { type: "message", id: "answer", parentId: "user", message: { role: "assistant", content: [
        { type: "text", text: "/private/skill/task.mjs token=HIDDEN_TOKEN visible" },
        { type: "thinking", thinking: "HIDDEN_THINKING", thinkingSignature: "HIDDEN_SIGNATURE" }], errorMessage: "HIDDEN_ERROR", provider: "HIDDEN_PROVIDER" } }];
    const source = () => records.map(record => JSON.stringify(record)).join("\n") + "\n";
    fs.writeFileSync(file, source());
    const manifest = { version: 1, run: identity.run, run_instance_id: identity.run_instance_id, status: "running", active_subagents: 1,
      updated_at: "2026-01-01T00:00:00.000Z", commands: [{ id: "command-001", status: "running", attempts: [], session_files: [relative] }] };
    const executionPath = join(stateDir, "execution.json"); fs.writeFileSync(executionPath, JSON.stringify(manifest));
    const query = { kind: "session", command_id: "command-001", path: relative };
    const read = (request: unknown = query, expected: unknown = identity) => readRunSessionPreview(stateDir, expected, request);
    return { root, stateDir, identity, meta, metaPath, file, relative, records, source, manifest, executionPath, query, read };
  }

  test("Recorded session preview returns assistant-only authorized text without source paths or filesystem mutation", t => {
    const f = fixture(t); const paths = [f.metaPath, f.executionPath, f.file]; const before = paths.map(path => fs.readFileSync(path));
    const originals = { readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync }; const kill = process.kill;
    const forbidden = () => assert.fail("Session preview attempted mutation/discovery/process actuation");
    fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; syncBuiltinESMExports();
    try {
      const reading = f.read(); assert.equal(reading.state, "available"); if (reading.state !== "available") return;
      assert.deepEqual(reading.identity, f.identity);
      assert.equal(reading.preview.messages[0].assistant_text, "[PRIVATE_RECIPE_ORIGIN]/task.mjs token=[REDACTED] visible");
      assert.equal(reading.preview.source_scope, "last_recorded_branch"); assert.equal(reading.unchanged(), true);
      assert.doesNotMatch(JSON.stringify(reading), /HIDDEN_|\/private\/|session\.jsonl|local_path|thinking|provider|ownership_token/);
    } finally { Object.assign(fs, originals); process.kill = kill; syncBuiltinESMExports(); }
    assert.deepEqual(paths.map(path => fs.readFileSync(path)), before); assert.equal(fs.existsSync(join(f.stateDir, "evidence")), false);
  });

  test("Wrong owner/generation, capture requests and unrecorded sessions never read private body bytes", t => {
    const f = fixture(t); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const fds = new Set<number>(); let reads = 0;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) reads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
    try {
      assert.equal(f.read(f.query, { ...f.identity, ownerId: "foreign" }).state, "unavailable");
      assert.equal(f.read(f.query, { ...f.identity, run_instance_id: "foreign" }).state, "unavailable");
      assert.equal(f.read({ kind: "capture", command_id: "command-001", attempt: 1, stream: "stdout" }).state, "unavailable");
      assert.equal(f.read({ ...f.query, path: "sessions/command-001/unrecorded.jsonl" }).state, "unavailable");
    } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(reads, 0);
  });

  test("Session preview refuses incomplete JSONL, invalid UTF-8 and unsupported format without returning private diagnostics", t => {
    const f = fixture(t);
    const encoded = Buffer.from(f.source()); const offset = encoded.indexOf("visible");
    const malformedUtf8 = Buffer.concat([encoded.subarray(0, offset), Buffer.from([0xff]), encoded.subarray(offset + 7)]);
    for (const source of ["{incomplete", malformedUtf8, JSON.stringify({ type: "session", version: 2, id: "old" }) + "\n"]) {
      fs.writeFileSync(f.file, source); const reading = f.read(); assert.equal(reading.state, "unavailable");
      assert.doesNotMatch(JSON.stringify(reading), /HIDDEN_|session\.jsonl|owner-a|private/);
    }
  });

  test("Exact 4 MiB session source admission is independent of 64 KiB preview output; oversize reads no body", t => {
    const f = fixture(t); const base = { ...f.records[0], padding: "" };
    const suffix = "\n" + f.records.slice(1).map(record => JSON.stringify(record)).join("\n") + "\n";
    const room = SESSION_EVIDENCE_MAX_BYTES - Buffer.byteLength(JSON.stringify(base) + suffix);
    const exact = JSON.stringify({ ...base, padding: "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) }) + suffix;
    assert.equal(Buffer.byteLength(exact), SESSION_EVIDENCE_MAX_BYTES); fs.writeFileSync(f.file, exact); assert.equal(f.read().state, "available");
    fs.writeFileSync(f.file, exact + " "); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const fds = new Set<number>(); let bodyReads = 0;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) bodyReads++; return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.equal(f.read().state, "unavailable"); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(bodyReads, 0);
  });

  test("Owned-generation, execution-manifest or session-file changes during descriptor read reject the entire preview", t => {
    const f = fixture(t); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync;
    for (const target of [f.metaPath, f.executionPath, f.file]) {
      fs.writeFileSync(f.metaPath, JSON.stringify(f.meta)); fs.writeFileSync(f.executionPath, JSON.stringify(f.manifest)); fs.writeFileSync(f.file, f.source());
      const fds = new Set<number>(); let changed = false;
      fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) fds.add(fd); return fd; }) as typeof fs.openSync;
      fs.readSync = ((fd, ...args) => { const result = Reflect.apply(read, fs, [fd, ...args]); if (fds.has(fd) && !changed) { changed = true; fs.renameSync(target, target + ".old"); fs.writeFileSync(target, target === f.file ? f.source() : JSON.stringify({ ...(target === f.metaPath ? f.meta : f.manifest), run_instance_id: "generation-b" })); } return result; }) as typeof fs.readSync;
      fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync; syncBuiltinESMExports();
      try { assert.equal(f.read().state, "unavailable"); assert.equal(changed, true); }
      finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
      assert.equal(fds.size, 0); fs.rmSync(target + ".old");
    }
  });

  test("Session descriptor cleanup failure after reading preserves unavailability and causes no body-read retry", t => {
    const f = fixture(t); const open = fs.openSync; const read = fs.readSync; const close = fs.closeSync; const fds = new Set<number>(); const readFds = new Set<number>(); let bodyReads = 0;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) { readFds.add(fd); bodyReads++; } return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.closeSync = ((fd) => { fds.delete(fd); const result = close(fd); if (readFds.delete(fd)) throw Object.assign(new Error("body close EIO"), { code: "EIO" }); return result; }) as typeof fs.closeSync; syncBuiltinESMExports();
    try { assert.equal(f.read().state, "unavailable"); }
    finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(bodyReads, 1);
  });
});

describe("Published-preview follow", { concurrency: false }, () => {
  const body = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
  function fixture(t: TestContext) {
    const root = fs.mkdtempSync(join(agentDir, "case-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = claimRunStateDirectory(join(root, "state"), "session-read");
    const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, Date.now());
    const meta = { run: "session-read", run_instance_id: "generation-a", ownerId: "owner-a", state_dir: stateDir, createdAt: clock.started_at, ...clock,
      pid: process.pid, process_identity: readProcessIdentity(process.pid), outcome_protocol: RUN_OUTCOME_PROTOCOL };
    const metaPath = join(stateDir, "run.json"); writeJsonAtomic(metaPath, meta); const producer = admitRunResultProducer(stateDir).producer;
    const sessions = ["sessions/command-001/first.jsonl", "sessions/command-001/second.jsonl"];
    for (const [index, relative] of sessions.entries()) {
      const file = join(stateDir, relative); fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file,
        [JSON.stringify({ type: "session", version: 3, id: "HIDDEN_ID" }), JSON.stringify({ type: "message", id: "a", parentId: null,
          message: { role: "assistant", content: [{ type: "text", text: `VISIBLE_${index}` }, { type: "thinking", thinking: "HIDDEN_THINKING" }] } })].join("\n") + "\n");
    }
    const executionPath = join(stateDir, "execution.json"); writeJsonAtomic(executionPath, { version: 1, run: meta.run, run_instance_id: meta.run_instance_id, status: "running", active_subagents: 1,
      updated_at: clock.started_at, commands: [{ id: "command-001", status: "running", attempts: [], session_files: sessions }] });
    publishRunResult(stateDir, producer, { code: 0 }); writeRunResultContextIndex(stateDir, producer);
    for (const path of sessions) writeRunSessionContextIndex(stateDir, producer, { kind: "session", command_id: "command-001", path });
    const indexPath = join(stateDir, "context-index.json"); const catalogPath = join(stateDir, "evidence", "sessions.json");
    const entries = body(catalogPath).previews; const id = entries[0].export_id as string; const file = join(stateDir, entries[0].path); const otherFile = join(stateDir, entries[1].path);
    const read = (selected: unknown = id, expected: unknown = meta) => readRunSessionContextPreview(stateDir, expected, selected);
    const rewriteCatalog = (value: unknown) => { writeJsonAtomic(catalogPath, value); const index = body(indexPath); index.entries.sessions.bytes_total = fs.statSync(catalogPath).size; writeJsonAtomic(indexPath, index); };
    return { root, stateDir, meta, metaPath, sessions, executionPath, indexPath, catalogPath, entries, id, file, otherFile, read, rewriteCatalog };
  }

  test("Selective session follow returns an independent frozen authorized preview with exact generation and curated export metadata", t => {
    const f = fixture(t); const reading = f.read(); assert.equal(reading.state, "available"); if (reading.state !== "available") return;
    assert.equal(reading.identity.run_instance_id, f.meta.run_instance_id); assert.equal(reading.identity.ownerId, f.meta.ownerId);
    assert.equal(reading.export_id, f.id); assert.equal(reading.command_id, "command-001"); assert.equal(reading.path, f.entries[0].path);
    assert.equal(reading.bytes_total, fs.statSync(f.file).size); assert.equal(reading.preview.messages[0].assistant_text, "VISIBLE_0");
    assert.equal(reading.preview.coverage.history_complete, false); assert.equal(reading.preview.primary_text, "not_exported"); assert.equal(reading.unchanged(), true);
    assert.equal(Object.isFrozen(reading.preview.messages), true); assert.equal(Object.isFrozen(reading.preview.messages[0]), true);
    assert.doesNotMatch(JSON.stringify(reading), /HIDDEN_|first\.jsonl|second\.jsonl|local_path|ownership_token|process_identity/);
  });

  test("Selective follow reads only the catalog and selected preview bodies, never raw sessions, sibling previews or unrelated role bodies", t => {
    const f = fixture(t); const originals = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
    const kill = process.kill; const paths = [f.metaPath, f.executionPath, f.indexPath, f.catalogPath, f.file, f.otherFile, join(f.stateDir, "result.json"), ...f.sessions.map(path => join(f.stateDir, path))];
    const before = paths.map(path => fs.readFileSync(path)); const fdPaths = new Map<number, string>(); let selectedReads = 0;
    const privatePath = (path: string) => path === f.otherFile || path.startsWith(join(f.stateDir, "sessions") + sep) || path === join(f.stateDir, "result.json");
    const permittedBody = (path: string) => [f.metaPath, f.indexPath, f.catalogPath, f.file, join(f.stateDir, RUN_STATE_OWNERSHIP_FILE)].includes(path);
    fs.openSync = ((path, ...args) => { assert.equal(privatePath(String(path)), false, "Unselected/raw sources must stay unopened"); const fd = Reflect.apply(originals.openSync, fs, [path, ...args]); fdPaths.set(fd, String(path)); return fd; }) as typeof fs.openSync;
    fs.closeSync = ((fd) => { fdPaths.delete(fd); return originals.closeSync(fd); }) as typeof fs.closeSync;
    fs.readSync = ((fd, ...args) => { const path = fdPaths.get(fd); assert.equal(!!path && permittedBody(path), true, "Unrelated role body read"); if (path === f.file) selectedReads++; return Reflect.apply(originals.readSync, fs, [fd, ...args]); }) as typeof fs.readSync;
    fs.readFileSync = ((path, ...args) => { const selected = typeof path === "number" ? fdPaths.get(path) : String(path); assert.equal(!!selected && permittedBody(selected), true); return Reflect.apply(originals.readFileSync, fs, [path, ...args]); }) as typeof fs.readFileSync;
    const forbidden = () => assert.fail("Selective read mutated, scanned or probed a process");
    fs.readdirSync = forbidden as typeof fs.readdirSync; fs.mkdirSync = forbidden as typeof fs.mkdirSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync; fs.renameSync = forbidden as typeof fs.renameSync; fs.rmSync = forbidden as typeof fs.rmSync; process.kill = forbidden as typeof process.kill; syncBuiltinESMExports();
    try { assert.equal(f.read().state, "available"); }
    finally { Object.assign(fs, originals); process.kill = kill; syncBuiltinESMExports(); }
    assert.equal(selectedReads, 1); assert.equal(fdPaths.size, 0); assert.deepEqual(paths.map(path => fs.readFileSync(path)), before);
  });

  test("Malformed selection, wrong owner/generation and unlisted hashes refuse without creating or repairing evidence", t => {
    const f = fixture(t);
    for (const id of [undefined, null, {}, "../private", "a".repeat(63), "A".repeat(64)]) assert.deepEqual(readRunSessionContextPreview(f.stateDir, f.meta, id), { state: "unavailable", reason: "selection_invalid" });
    assert.equal(f.read(f.id, { ...f.meta, ownerId: "foreign" }).state, "unavailable"); assert.equal(f.read(f.id, { ...f.meta, run_instance_id: "foreign" }).state, "unavailable");
    assert.deepEqual(f.read("0".repeat(64)), { state: "unavailable", reason: "preview_not_listed" });
    fs.rmSync(f.indexPath); assert.equal(f.read().state, "unavailable"); assert.equal(fs.existsSync(f.indexPath), false);
  });

  test("Session role coverage and mutability cannot contradict the fixed published catalog", t => {
    const f = fixture(t); const original = body(f.indexPath);
    for (const update of [{ mutable: false }, { coverage: { truncated: false, redacted: true, history_complete: false } },
      { coverage: { truncated: true, redacted: false, history_complete: false } }, { coverage: { truncated: true, redacted: true, history_complete: true } }]) {
      const index = JSON.parse(JSON.stringify(original)); Object.assign(index.entries.sessions, update); writeJsonAtomic(f.indexPath, index);
      assert.equal(f.read().state, "unavailable");
    }
  });

  test("Corrupt catalog schemas and escaped paths never turn index metadata into body permission", t => {
    const f = fixture(t); const original = body(f.catalogPath);
    for (const mutate of [
      (value: typeof original) => { value.run_instance_id = "foreign"; },
      (value: typeof original) => { value.previews[0].path = "../private/session.jsonl"; },
      (value: typeof original) => { value.previews[0].coverage.history_complete = true; },
      (value: typeof original) => { value.inventory_complete = true; },
    ]) {
      const value = JSON.parse(JSON.stringify(original)); mutate(value); f.rewriteCatalog(value);
      const before = fs.readFileSync(f.catalogPath); const read = f.read(); assert.equal(read.state, "unavailable"); assert.deepEqual(fs.readFileSync(f.catalogPath), before);
    }
  });

  test("Selected preview headers, byte counts, captured time and private/unexpected fields are independently checked", t => {
    const f = fixture(t); const original = body(f.file); const catalog = body(f.catalogPath);
    for (const mutate of [
      (value: typeof original) => { value.run_instance_id = "foreign"; },
      (value: typeof original) => { value.command_id = "command-002"; },
      (value: typeof original) => { value.captured_at = "2020-01-01T00:00:00.000Z"; },
      (value: typeof original) => { value.preview.messages[0].thinking = "HIDDEN_THINKING"; },
      (value: typeof original) => { value.preview.messages[0].text_chars_observed = "9"; },
    ]) {
      const value = JSON.parse(JSON.stringify(original)); mutate(value); writeJsonAtomic(f.file, value);
      const current = JSON.parse(JSON.stringify(catalog)); current.previews[0].bytes_total = fs.statSync(f.file).size; f.rewriteCatalog(current);
      assert.equal(f.read().state, "unavailable");
    }
    writeJsonAtomic(f.file, original); f.rewriteCatalog(catalog); fs.appendFileSync(f.file, " "); assert.equal(f.read().state, "unavailable");
    fs.rmSync(f.file); assert.equal(f.read().state, "unavailable");
  });

  test("Unavailable catalog entries stay unavailable even if a matching file exists; reads never refresh availability", t => {
    const f = fixture(t); const catalog = body(f.catalogPath); const row = catalog.previews[0];
    catalog.previews[0] = { export_id: row.export_id, command_id: row.command_id, captured_at: row.captured_at, availability: "unavailable", path: null, reason: "preview_export_unavailable" };
    f.rewriteCatalog(catalog); const before = fs.readFileSync(f.catalogPath);
    assert.deepEqual(f.read(), { state: "unavailable", reason: "preview_unavailable" });
    assert.equal(fs.existsSync(f.file), true); assert.deepEqual(fs.readFileSync(f.catalogPath), before);
  });

  test("Observed identity/index/catalog/leaf replacement during selected read returns unavailable without retry or repair", t => {
    const f = fixture(t); const originals = [f.metaPath, f.indexPath, f.catalogPath, f.file].map(path => fs.readFileSync(path));
    const open = fs.openSync; const close = fs.closeSync; const read = fs.readSync;
    for (const target of [f.metaPath, f.indexPath, f.catalogPath, f.file]) {
      [f.metaPath, f.indexPath, f.catalogPath, f.file].forEach((path, index) => fs.writeFileSync(path, originals[index]));
      const selectedFds = new Set<number>(); let changed = false; let selectedReads = 0;
      fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === f.file) selectedFds.add(fd); return fd; }) as typeof fs.openSync;
      fs.closeSync = ((fd) => { selectedFds.delete(fd); return close(fd); }) as typeof fs.closeSync;
      fs.readSync = ((fd, ...args) => { const result = Reflect.apply(read, fs, [fd, ...args]); if (selectedFds.has(fd)) { selectedReads++; if (!changed) { changed = true; fs.renameSync(target, target + ".old"); fs.writeFileSync(target, target === f.metaPath ? JSON.stringify({ ...f.meta, run_instance_id: "generation-b" }) : fs.readFileSync(target + ".old")); } } return result; }) as typeof fs.readSync;
      syncBuiltinESMExports();
      try { assert.equal(f.read().state, "unavailable"); assert.equal(changed, true); }
      finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; syncBuiltinESMExports(); }
      assert.equal(selectedReads, 1); assert.equal(selectedFds.size, 0); fs.rmSync(target + ".old");
    }
  });

  test("Returned selected observations expire when an admitted dependency changes", t => {
    const f = fixture(t);
    for (const target of [f.metaPath, f.indexPath, f.catalogPath, f.file]) {
      const before = fs.readFileSync(target); const reading = f.read(); assert.equal(reading.state, "available");
      fs.appendFileSync(target, " "); if (reading.state === "available") assert.equal(reading.unchanged(), false);
      fs.writeFileSync(target, before);
    }
  });

  test("Symlinked index/catalog/nested namespaces or leaf files never become selected readable content", { skip: process.platform === "win32" }, t => {
    const f = fixture(t);
    for (const path of [f.indexPath, f.catalogPath, f.file, join(f.stateDir, "evidence", "sessions")]) {
      const directory = fs.lstatSync(path).isDirectory(); fs.renameSync(path, path + ".held"); fs.symlinkSync(path + ".held", path, directory ? "dir" : "file");
      assert.equal(f.read().state, "unavailable"); fs.rmSync(path); fs.renameSync(path + ".held", path);
    }
  });
});

describe("Assistant-text projection", { concurrency: false }, () => {
  const header = { type: "session", version: 3, id: "HIDDEN_SESSION_ID", cwd: "/private/cwd", parentSession: "/private/parent" };
  const message = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId,
    message: { role: "assistant", content: [{ type: "text", text }] } });
  const text = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

  test("Assistant preview includes only redacted visible text from the last recorded branch", () => {
    const records = [header, { type: "message", id: "system", parentId: null, message: { role: "system", sections: { tools: "HIDDEN_SYSTEM" } } },
      { type: "message", id: "user", parentId: "system", message: { role: "user", content: "HIDDEN_USER" } },
      message("old", "user", "HIDDEN_DISCARDED_BRANCH"),
      { ...message("answer", "user", "/private/skill/helper.mjs token=HIDDEN_TOKEN visible"), message: {
        role: "assistant", content: [{ type: "text", text: "/private/skill/helper.mjs token=HIDDEN_TOKEN visible", textSignature: "HIDDEN_SIGNATURE" },
          { type: "thinking", thinking: "HIDDEN_THINKING", thinkingSignature: "HIDDEN_ENCRYPTED" },
          { type: "toolCall", id: "tool", arguments: { command: "HIDDEN_ARGUMENTS" }, thoughtSignature: "HIDDEN_THOUGHT_SIG" }],
        provider: "HIDDEN_PROVIDER", diagnostics: [{ text: "HIDDEN_DIAGNOSTICS" }], usage: { text: "HIDDEN_USAGE" }, errorMessage: "HIDDEN_ERROR" } },
      { type: "message", id: "result", parentId: "answer", message: { role: "toolResult", content: "HIDDEN_TOOL_RESULT", details: "HIDDEN_DETAILS" } }];
    const reading = projectSessionAssistantPreview(text(records), { values: { skill_dir: "/private/skill" } });
    assert.equal(reading.state, "available"); if (reading.state !== "available") return;
    assert.equal(reading.preview.source_scope, "last_recorded_branch");
    assert.equal(reading.preview.primary_text, "not_exported");
    assert.equal(reading.preview.messages_total, 1); assert.equal(reading.preview.messages[0].assistant_text, "[PRIVATE_RECIPE_ORIGIN]/helper.mjs token=[REDACTED] visible");
    assert.doesNotMatch(JSON.stringify(reading), /HIDDEN_|\/private\/|toolCall|usage|thinking|parentSession|current_context/);
    assert.equal(reading.preview.coverage.history_complete, false); assert.equal(Object.isFrozen(reading.preview.messages[0]), true);
  });

  test("Assistant preview counts Unicode after privacy projection and clips only its explicitly labeled preview", () => {
    const reading = projectSessionAssistantPreview(text([header, message("answer", null, "🫧".repeat(4002))]));
    assert.equal(reading.state, "available"); if (reading.state !== "available") return;
    const row = reading.preview.messages[0];
    assert.equal(row.text_chars_observed, 4002); assert.equal(row.text_chars_shown, 4000); assert.equal(row.text_chars_omitted, 2);
    assert.equal(row.assistant_text, "🫧".repeat(4000)); assert.equal(row.preview_clipped, true);
  });

  test("Assistant preview rejects unknown format and ambiguous/missing/cyclic branch provenance rather than exposing guessed history", () => {
    const cases = ["{partial", text([null]), text([{ ...header, version: 2 }]), text([header, header]),
      text([header, message("a", null, "one"), message("a", null, "two")]),
      text([header, message("a", "missing", "one")]),
      text([header, message("a", "b", "one"), message("b", "a", "two")])];
    for (const source of cases) assert.deepEqual(projectSessionAssistantPreview(source), { state: "unavailable", reason: "session_invalid" });
    const empty = projectSessionAssistantPreview(text([header])); assert.equal(empty.state, "available");
    if (empty.state === "available") { assert.equal(empty.preview.messages_total, 0); assert.equal(empty.preview.coverage.history_complete, false); }
  });

  test("Assistant preview keeps exact observation omission counts within the independent 64 KiB encoded limit", () => {
    const records: unknown[] = [header];
    for (let index = 1; index <= 45; index++) records.push(message("a" + index, index === 1 ? null : "a" + (index - 1), "界".repeat(4001)));
    const reading = projectSessionAssistantPreview(text(records)); assert.equal(reading.state, "available"); if (reading.state !== "available") return;
    assert.equal(reading.preview.messages_total, 45); assert.ok(reading.preview.messages.length < 40);
    assert.equal(reading.preview.messages_shown + reading.preview.messages_omitted, 45);
    assert.equal(reading.preview.messages.at(-1)?.ordinal, 45);
    assert.ok(Buffer.byteLength(JSON.stringify(reading.preview), "utf8") <= SESSION_ASSISTANT_PREVIEW_MAX_BYTES);
  });

  test("Assistant preview is data-only and does not require filesystem, process, or clock sampling", () => {
    const source = text([header, message("a", null, "visible")]);
    const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync }; const kill = process.kill; const now = Date.now;
    const forbidden = () => assert.fail("Data-only session preview performed IO");
    fs.openSync = forbidden as typeof fs.openSync; fs.readFileSync = forbidden as typeof fs.readFileSync; fs.readdirSync = forbidden as typeof fs.readdirSync; process.kill = forbidden as typeof process.kill; Date.now = forbidden;
    syncBuiltinESMExports();
    try { assert.equal(projectSessionAssistantPreview(source).state, "available"); }
    finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
  });
});
