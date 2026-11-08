/** Private context correspondence/privacy and saved-session/publication handoff evidence. No public launch/restart/file-issuer or native-closure proof. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [packageDir, fixtureDir, layout, run, generation] = process.argv.slice(2);
const stateDir = join(fixtureDir, "state"), manifestPath = join(fixtureDir, "fixture-processes.json");
const identity = { run, run_instance_id: generation, ownerId: "private-context-fixture" };
const captured = [{ ...identity, pid: process.pid, role: "producer", state_dir: stateDir, exit_observation: "not_asserted" }];
const metadataFrames = [
  { name: "generation_origin", run_instance_id: "/x/private", ownerId: identity.ownerId },
  { name: "generation_secret", run_instance_id: "token=HIDDEN_GENERATION", ownerId: identity.ownerId },
  { name: "owner_origin", run_instance_id: generation, ownerId: "/x/private" },
  { name: "owner_secret", run_instance_id: generation, ownerId: "token=HIDDEN_OWNER" },
  { name: "logical_identity", run_instance_id: "generation-/x/private", ownerId: "owner-/x/private" },
  { name: "owner_absent", run_instance_id: "generation-owner-absent", literal_secret: "[REDACTED]" },
  { name: "generation_literal", run_instance_id: "literal-fixture-credential-62", ownerId: identity.ownerId, literal_secret: "literal-fixture-credential-62" },
  { name: "owner_literal", run_instance_id: generation, ownerId: "literal-fixture-credential-62", literal_secret: "literal-fixture-credential-62" },
  { name: "generation_escaped_literal", run_instance_id: "raw\"\\\r\n\uFEFF\uFFFD🫧```", ownerId: identity.ownerId, literal_secret: "raw\"\\\r\n\uFEFF\uFFFD🫧```" },
  { name: "owner_escaped_literal", run_instance_id: generation, ownerId: "raw\"\\\r\n\uFEFF\uFFFD🫧```", literal_secret: "raw\"\\\r\n\uFEFF\uFFFD🫧```" },
].map(value => ({ ...value, run, pid: process.pid, state_dir: join(fixtureDir, "identity-frames", value.name), composition: "controlled_metadata_only" }));
let complete = false, sessionFrame, sessionPublication;
const persist = () => { const stage = manifestPath + ".tmp"; fs.writeFileSync(stage, JSON.stringify({ schema: "context-private-fixture-v1", launching: false, complete, captured, metadata_frames: metadataFrames,
  ...(sessionFrame ? { session_frame: sessionFrame } : {}), ...(sessionPublication ? { session_publication: sessionPublication } : {}) })); fs.renameSync(stage, manifestPath); };
persist(); // Retain this producer PID/frame before imports, assertions or awaited work.
assert.ok(layout === "source" || layout === "packed");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const manager = SessionManager.create(process.cwd(), join(fixtureDir, "coordinator-sessions"), { id: identity.ownerId });
sessionFrame = { session_id: manager.getSessionId(), session_file: manager.getSessionFile(), cwd: manager.getCwd(), state: "creating" };
persist(); // Actual manager identity precedes assertions and conversation persistence; no Actor workload.
manager.appendMessage({ role: "user", content: "Controlled saved coordinator identity for private publication research; no Actor work.", timestamp: Date.now() });
sessionFrame = { ...sessionFrame, state: "persisted" }; persist();
assert.equal(sessionFrame.session_id, identity.ownerId);
assert.equal(JSON.parse(fs.readFileSync(sessionFrame.session_file, "utf8").split("\n")[0]).id, sessionFrame.session_id);
const modulePath = name => pathToFileURL(join(packageDir, layout === "source" ? "lib" : "dist/lib", `${name}.${layout === "source" ? "ts" : "js"}`)).href;
const { claimRunStateDirectory } = await import(modulePath("runs-ownership"));
const { registerRunStateDirectory, readRunSessionNavigation } = await import(modulePath("runs-index"));
const { getRunStateRoot } = await import(modulePath("paths"));
const { writeJsonAtomic } = await import(modulePath("file-state"));
const { readProcessIdentity } = await import(modulePath("runs-process"));
const { createRunSupervisionClock } = await import(modulePath("run-supervision"));
const { admitRunResultProducer, publishRunResult, reportRunProducerCleanupFailure, readRunProducerCleanupFailure } = await import(modulePath("runs-results"));
const { readRunRecipeContextView, writeRunRecipeContextIndex, writeRunRecipeContextExport, readRunTraceContextView, writeRunTraceContextIndex, writeRunTraceContextExport, writeRunControlContextIndex, writeRunControlContextExport, readRunControlContextView, readRunExecutionContextView, writeRunExecutionContextIndex, writeRunExecutionContextExport,
  createRunResultDiagnosticsPublisher, writeRunResultContextIndex, writeRunResultContextExport, readRunResultContextView, readRunResultDiagnosticsSource, readRunResultDiagnosticOutcome,
  createRunPrimaryTextPublisher, readRunPrimaryTextSource, prepareRunArtifactInventoryPublication, readRunArtifactInventorySource, createRunSnapshotReferenceReader,
  writeRunSessionContextIndex, writeRunSessionContextExport, readRunSessionContextPreview,
  RUN_CONTEXT_RECIPE_MAX_BYTES, RUN_CONTEXT_TRACE_MAX_BYTES, RUN_CONTEXT_EXECUTION_MAX_BYTES } = await import(modulePath("runs-context-exports"));
const { appendRunTraceEvent } = await import(modulePath("runs-trace"));
const { readRunSessionPreview } = await import(modulePath("runs-session-exports"));
const { appendRunControlInStateDir, claimRunControlInStateDir, updateRunControlStatusInStateDir } = await import(modulePath("runs-controls"));
const { INSPECTOR_BODY_PREVIEW_CHARS } = await import(modulePath("limits"));
const { readRunContextIndex, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } = await import(modulePath("runs-context-index"));
const foreignIssuer = await import(modulePath("runs-results") + "?foreign_recipe_reader_fixture");
const body = path => JSON.parse(fs.readFileSync(path, "utf8"));
function withoutSourceProbes(paths, callback) {
  const names = ["openSync", "statSync", "lstatSync", "readFileSync", "readdirSync"], originals = names.map(name => fs[name]); let probes = 0;
  names.forEach((name, index) => { fs[name] = (...args) => { if (paths.includes(String(args[0]))) { probes++; throw Error("Private source identity attempted selected body/source/target observation"); }
    return Reflect.apply(originals[index], fs, args); }; }); syncBuiltinESMExports(); let result;
  try { result = callback(); } finally { names.forEach((name, index) => { fs[name] = originals[index]; }); syncBuiltinESMExports(); }
  assert.equal(probes, 0); return result;
}
// File-observation fixture driver, not a worker/native clock or historical issuer.
function atFileTime(time, callback) {
  const original = globalThis.Date;
  globalThis.Date = new Proxy(original, { construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [time], newTarget); } });
  try { return callback(); } finally { globalThis.Date = original; }
}
function bodyLiteral(value, secret, depth = 0) {
  assert.ok(depth <= 32);
  if (typeof value === "string") { if (value.includes(secret)) return true; let parsed; try { parsed = JSON.parse(value.startsWith("\uFEFF") ? value.slice(1) : value); } catch { return false; }
    return parsed !== value && (typeof parsed === "string" || (parsed && typeof parsed === "object")) ? bodyLiteral(parsed, secret, depth + 1) : false; }
  return value && typeof value === "object" ? Object.entries(value).some(([key, item]) => key.includes(secret) || bodyLiteral(item, secret, depth + 1)) : false;
}
const report = { layout, composition: "private_context_same_runtime", producerPid: process.pid, workloads: 0, issuerAdmissions: 0 };
let primaryError;
try {
  claimRunStateDirectory(stateDir, run);
  const clock = createRunSupervisionClock({ report_every_ms: 60001, max_runtime_ms: 1 }, Date.now());
  const metadata = { ...identity, ...clock, createdAt: clock.started_at, state_dir: stateDir, pid: process.pid,
    process_identity: readProcessIdentity(process.pid), outcome_protocol: "run-outcome-v1", cwd: process.cwd(),
    template: "echo /x/private/payload \r\n", values: { skill_dir: "/x/private", api_key: "HIDDEN_RECIPE_KEY", signal_credential: "SIGPRIVATE69", report_time_credential: "2001-01-01T00:00:00.000Z", command_credential: "command-999", literal: " \uFEFF\uFFFD```\r\n 🫧 " },
    recipe_context_records: [{ depth: 0, name: "fixture", logical_reference: "suite/fixture", source_kind: "active_skill_component",
      recipe: { template: "echo /x/private/helper", defaults: { password: "HIDDEN_DEFAULT" } } }] };
  const metaPath = join(stateDir, "run.json"), viewPath = join(stateDir, "evidence", "recipe.json"), indexPath = join(stateDir, "context-index.json");
  writeJsonAtomic(metaPath, metadata); const producer = admitRunResultProducer(stateDir).producer; report.issuerAdmissions++;
  assert.equal(writeRunRecipeContextIndex(stateDir, producer).status, "published");
  const viewBytes = fs.readFileSync(viewPath), view = body(viewPath); const positive = readRunRecipeContextView(stateDir, producer);
  assert.equal(positive.state, "available"); assert.equal(positive.basis, "original_producer_projection_match"); assert.deepEqual(positive.view, view);
  assert.equal(positive.view.recipe.launch.values.literal, metadata.values.literal); assert.equal(Object.isFrozen(positive.view.recipe.launch.values), true);
  assert.deepEqual(positive.view.stored_clock, { started_at: clock.started_at, supervision: clock.supervision });
  assert.doesNotMatch(JSON.stringify(positive), /HIDDEN_|\/x\/private|process_identity|ownership_token/);
  report.originalProjectionAndPolicy = true; report.literalAndFrozenData = true;
  const foreign = foreignIssuer.admitRunResultProducer(stateDir).producer; report.issuerAdmissions++;
  for (const key of [{ ...producer }, JSON.parse(JSON.stringify(producer)), foreign]) {
    assert.deepEqual(readRunRecipeContextView(stateDir, key), { state: "unavailable", reason: "admission_invalid" });
    assert.deepEqual(readRunResultContextView(stateDir, key), { state: "unavailable", reason: "admission_invalid" });
  }
  report.copiedAndCrossModuleRefused = true;
  const failedControl = (input, error) => {
    const record = appendRunControlInStateDir(stateDir, { run_instance_id: generation, action: "refresh", input });
    assert.equal(claimRunControlInStateDir(stateDir, generation)?.id, record.id);
    assert.equal(updateRunControlStatusInStateDir(stateDir, record.id, "failed", { error }, ["claimed"]), true); return record;
  };
  const firstControl = failedControl({ note: "read /x/private/payload", api_key: "HIDDEN_CONTROL_INPUT" }, "missing /x/private/item; token=HIDDEN_CONTROL_ERROR");
  const secondControl = failedControl({ note: "boundary" }, "x".repeat(INSPECTOR_BODY_PREVIEW_CHARS - 7) + " /x/private/item");
  const controlPath = join(stateDir, "evidence", "control.json");
  assert.deepEqual(readRunControlContextView(stateDir, producer), { state: "unavailable", reason: "publication_unavailable" });
  assert.equal(writeRunControlContextIndex(stateDir, producer).status, "published"); const controls = body(controlPath);
  const controlBytes = fs.readFileSync(controlPath), originalControl = readRunControlContextView(stateDir, producer);
  assert.equal(originalControl.state, "available"); assert.equal(originalControl.basis, "original_control_publication_match");
  assert.deepEqual(originalControl.view, controls); assert.equal(Object.isFrozen(originalControl.view.capacity), true);
  const editedControl = structuredClone(controls); editedControl.controls[0].input.note = "invented /x/private".padEnd(controls.controls[0].input.note.length, " ");
  fs.writeFileSync(controlPath, JSON.stringify(editedControl, null, 2) + "\n"); assert.equal(fs.statSync(controlPath).size, controlBytes.length);
  assert.equal(readRunContextIndex(stateDir, metadata).state, "available"); assert.deepEqual(readRunControlContextView(stateDir, producer), { state: "unavailable", reason: "view_mismatch" });
  fs.writeFileSync(controlPath, controlBytes); // Explicit fixture restoration, never read-side repair.
  fs.renameSync(controlPath, controlPath + ".held"); assert.equal(readRunControlContextView(stateDir, producer).state, "unavailable"); assert.equal(fs.existsSync(controlPath), false);
  fs.renameSync(controlPath + ".held", controlPath); assert.equal(readRunControlContextView(stateDir, producer).state, "available");
  report.controlOriginalPublicationRead = true; report.controlTamperAndViewLossRefused = true;
  assert.equal(controls.run_instance_id, generation); assert.equal(controls.controls[0].id, firstControl.id);
  assert.equal(controls.controls[1].id, secondControl.id); assert.ok(controls.controls.every(row => row.run_instance_id === generation));
  assert.equal(controls.capacity.pending, 0); assert.equal(controls.controls_omitted, 0);
  assert.doesNotMatch(JSON.stringify(controls), /HIDDEN_|\/x\/pr/);
  assert.ok(controls.controls[1].error.endsWith("[PRIV…"));
  report.controlOriginalPrivacyBeforeClipping = true; report.controlRowIdentifiersExact = true;

  const tracePath = join(stateDir, "evidence", "trace.jsonl"), journalPath = join(stateDir, "trace.jsonl");
  appendRunTraceEvent(stateDir, { kind: "checkpoint.first", summary: "recorded /x/private/helper", data: { note: metadata.values.literal, password: "HIDDEN_TRACE" } });
  appendRunTraceEvent(stateDir, { kind: "checkpoint.second", summary: "recorded second observation" });
  assert.equal(writeRunTraceContextIndex(stateDir, producer).status, "published");
  const traceBytes = fs.readFileSync(tracePath), traceFirst = readRunTraceContextView(stateDir, producer);
  assert.equal(traceFirst.state, "available"); assert.equal(traceFirst.basis, "original_trace_publication_match"); assert.equal(traceFirst.view.items.length, 2);
  assert.equal(traceFirst.view.header.run_instance_id, generation); assert.equal(Object.isFrozen(traceFirst.view.items[0].detail), true);
  assert.doesNotMatch(JSON.stringify(traceFirst), /HIDDEN_|\/x\/private/);
  // Same already-planned issuer key/frame; its original clock privacy is different data, not a new birth.
  writeJsonAtomic(metaPath, { ...metadata, values: { ...metadata.values, clock_credential: clock.started_at } });
  const unrecorded = admitRunResultProducer(stateDir).producer; report.issuerAdmissions++; writeJsonAtomic(metaPath, metadata);
  const heldRecipe = fs.readFileSync(viewPath);
  assert.deepEqual(writeRunRecipeContextExport(stateDir, unrecorded), { status: "unavailable", reason: "recipe_metadata_redacted" });
  assert.deepEqual(readRunRecipeContextView(stateDir, unrecorded), { state: "unavailable", reason: "admission_unavailable" });
  assert.deepEqual(fs.readFileSync(viewPath), heldRecipe); report.originalClockMetadataRefused = true;
  assert.deepEqual(readRunTraceContextView(stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" });
  assert.deepEqual(readRunControlContextView(stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" });
  for (const key of [{ ...producer }, JSON.parse(JSON.stringify(producer)), foreign]) assert.deepEqual(readRunControlContextView(stateDir, key), { state: "unavailable", reason: "admission_invalid" });
  for (const key of [{ ...producer }, JSON.parse(JSON.stringify(producer)), foreign]) assert.deepEqual(readRunTraceContextView(stateDir, key), { state: "unavailable", reason: "admission_invalid" });
  const reloaded = await import(modulePath("runs-context-exports") + "?lost_context_fixture");
  assert.deepEqual(reloaded.readRunTraceContextView(stateDir, producer), { state: "unavailable", reason: "publication_unavailable" });
  assert.deepEqual(reloaded.readRunControlContextView(stateDir, producer), { state: "unavailable", reason: "publication_unavailable" });
  report.controlOriginalAndModuleBindingRequired = true;
  report.traceOriginalAndModuleBindingRequired = true;
  for (const text of ["invented /x/private", "invented safe text"]) {
    const lines = traceBytes.toString().trimEnd().split("\n").map(line => JSON.parse(line)); lines[1].summary = text.padEnd(lines[1].summary.length, " ");
    fs.writeFileSync(tracePath, lines.map(line => JSON.stringify(line)).join("\n") + "\n"); assert.equal(fs.statSync(tracePath).size, traceBytes.length);
    assert.equal(readRunContextIndex(stateDir, metadata).state, "available"); assert.deepEqual(readRunTraceContextView(stateDir, producer), { state: "unavailable", reason: "view_mismatch" });
  }
  report.traceSameSizeEditsRefused = true;
  fs.writeFileSync(tracePath, traceBytes); // Explicit fixture restoration, not reader repair.
  const historical = readRunTraceContextView(stateDir, producer); assert.equal(historical.state, "available");
  appendRunTraceEvent(stateDir, { kind: "checkpoint.later", summary: "genuine later observation" });
  assert.equal(historical.unchanged(), true); assert.deepEqual(readRunTraceContextView(stateDir, producer).view, historical.view);
  fs.renameSync(journalPath, journalPath + ".held"); assert.deepEqual(readRunTraceContextView(stateDir, producer).view, historical.view);
  fs.renameSync(journalPath + ".held", journalPath);
  fs.renameSync(tracePath, tracePath + ".held"); assert.equal(readRunTraceContextView(stateDir, producer).state, "unavailable"); assert.equal(fs.existsSync(tracePath), false);
  fs.renameSync(tracePath + ".held", tracePath); assert.equal(readRunTraceContextView(stateDir, producer).state, "available");
  report.traceHistoricalAfterJournalGrowthAndLoss = true; report.traceViewLossHasNoPrivateDataFallback = true;
  assert.equal(writeRunTraceContextIndex(stateDir, producer).status, "published"); assert.equal(historical.unchanged(), false);
  assert.equal(readRunTraceContextView(stateDir, producer).view.items.length, 3); report.traceExplicitPublicationReplacesBinding = true;
  const executionSource = join(stateDir, "execution.json"), executionPath = join(stateDir, "evidence", "execution.json");
  const execution = { version: 1, run, run_instance_id: generation, status: "running", updated_at: clock.started_at, active_subagents: 1,
    commands: [{ id: "command-001", status: "running", command: "/x/private/helper token=HIDDEN_EXECUTION", label: metadata.values.literal,
      session_files: ["sessions/private.jsonl"], prompt_file: "prompts/private.txt", provider_payload: "HIDDEN_PROVIDER",
      attempts: [{ attempt: 1, code: 7, native_exit_code: 7, killed: false, stdout: { path: "captures/stdout.log", bytes: 6, bytes_observed: 18, complete: false, error: "capture_write_failed" }, stderr: { path: "captures/stderr.log", bytes: 0 } }] }] };
  writeJsonAtomic(executionSource, execution); assert.deepEqual(readRunExecutionContextView(stateDir, producer), { state: "unavailable", reason: "publication_unavailable" });
  assert.equal(writeRunExecutionContextIndex(stateDir, producer).status, "published"); const originalExecution = readRunExecutionContextView(stateDir, producer), executionBytes = fs.readFileSync(executionPath);
  assert.equal(originalExecution.state, "available"); assert.equal(originalExecution.basis, "original_execution_publication_match");
  assert.equal(originalExecution.view.scope_closure, "not_asserted"); assert.equal(originalExecution.view.capture_references, "not_exported");
  assert.equal(originalExecution.view.capture_bodies, "not_read"); assert.equal(originalExecution.view.session_bodies, "not_read");
  assert.equal(originalExecution.view.execution.commands[0].label, metadata.values.literal); assert.equal(Object.isFrozen(originalExecution.view.execution.commands[0].attempts[0].stdout), true);
  assert.doesNotMatch(JSON.stringify(originalExecution), /HIDDEN_|\/x\/private|captures\/|sessions\/|prompts\//);
  assert.deepEqual(readRunExecutionContextView(stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" });
  assert.deepEqual(reloaded.readRunExecutionContextView(stateDir, producer), { state: "unavailable", reason: "publication_unavailable" });
  for (const key of [{ ...producer }, JSON.parse(JSON.stringify(producer)), foreign]) assert.deepEqual(readRunExecutionContextView(stateDir, key), { state: "unavailable", reason: "admission_invalid" });
  const forgedExecution = body(executionPath); forgedExecution.execution.reported_active_subagents = 9;
  fs.writeFileSync(executionPath, JSON.stringify(forgedExecution, null, 2) + "\n"); assert.equal(fs.statSync(executionPath).size, executionBytes.length);
  assert.equal(readRunContextIndex(stateDir, metadata).state, "available"); assert.deepEqual(readRunExecutionContextView(stateDir, producer), { state: "unavailable", reason: "view_mismatch" });
  fs.writeFileSync(executionPath, executionBytes); // Explicit fixture restoration, not reader repair.
  execution.active_subagents = 3; execution.status = "failed"; execution.commands[0].attempts[0].killed = true; writeJsonAtomic(executionSource, execution);
  assert.deepEqual(readRunExecutionContextView(stateDir, producer).view, originalExecution.view);
  fs.renameSync(executionSource, executionSource + ".held"); assert.deepEqual(readRunExecutionContextView(stateDir, producer).view, originalExecution.view); fs.renameSync(executionSource + ".held", executionSource);
  fs.renameSync(executionPath, executionPath + ".held"); assert.equal(readRunExecutionContextView(stateDir, producer).state, "unavailable"); assert.equal(fs.existsSync(executionPath), false);
  fs.renameSync(executionPath + ".held", executionPath); assert.equal(readRunExecutionContextView(stateDir, producer).state, "available");
  assert.equal(writeRunExecutionContextIndex(stateDir, producer).status, "published"); const refreshedExecution = readRunExecutionContextView(stateDir, producer);
  assert.equal(refreshedExecution.state, "available"); assert.equal(refreshedExecution.view.execution.reported_active_subagents, 3);
  assert.equal(refreshedExecution.view.execution.commands[0].attempts[0].reported_killed, true); assert.equal(refreshedExecution.view.scope_closure, "not_asserted");
  assert.equal(originalExecution.unchanged(), false); report.executionOriginalPublicationAndPrivacy = true;
  report.executionTamperAndModuleAdmissionRefused = true; report.executionHistoricalManifestLossNoBodyFallback = true;
  writeJsonAtomic(metaPath, { ...metadata, values: { skill_dir: "/actor/current" }, template: "actor replacement",
    ...createRunSupervisionClock({ report_every_ms: 60002, max_runtime_ms: 2 }, Date.parse(clock.started_at)) });
  const unchangedOriginal = readRunRecipeContextView(stateDir, producer); assert.equal(unchangedOriginal.state, "available"); assert.deepEqual(unchangedOriginal.view, view);
  report.livePrivacyAndPolicyNotRenewed = true;
  // Synthetic reported token, not a delivered OS signal, executed workload or new native frame.
  const priorSignalView = readRunExecutionContextView(stateDir, producer); assert.equal(priorSignalView.state, "available");
  const priorSignalBytes = fs.readFileSync(executionPath); execution.commands[0].attempts[0].native_signal = "SIGPRIVATE69";
  writeJsonAtomic(executionSource, execution); const signalInputs = [metaPath, executionSource].map(path => fs.readFileSync(path));
  assert.deepEqual(writeRunExecutionContextExport(stateDir, producer), { status: "unavailable", reason: "execution_metadata_redacted" });
  assert.deepEqual(fs.readFileSync(executionPath), priorSignalBytes); assert.equal(priorSignalView.unchanged(), true);
  assert.deepEqual(readRunExecutionContextView(stateDir, producer).view, priorSignalView.view);
  assert.equal(writeRunExecutionContextIndex(stateDir, producer).status, "published");
  assert.equal(body(indexPath).entries.execution.reason, "execution_metadata_redacted");
  assert.deepEqual(readRunExecutionContextView(stateDir, producer), { state: "unavailable", reason: "execution_unavailable" });
  assert.deepEqual(fs.readFileSync(executionPath), priorSignalBytes); assert.equal(priorSignalView.unchanged(), false);
  assert.deepEqual([metaPath, executionSource].map(path => fs.readFileSync(path)), signalInputs);
  delete execution.commands[0].attempts[0].native_signal; writeJsonAtomic(executionSource, execution);
  assert.equal(writeRunExecutionContextIndex(stateDir, producer).status, "published"); assert.equal(readRunExecutionContextView(stateDir, producer).state, "available");
  report.originalSignalPrivacyRefusalPreservesHistory = true;
  for (const field of ["id", "updated_at", "started_at", "completed_at"]) {
    const target = field === "updated_at" ? execution : execution.commands[0], had = Object.hasOwn(target, field), previous = target[field];
    const retained = fs.readFileSync(executionPath), historical = readRunExecutionContextView(stateDir, producer); assert.equal(historical.state, "available");
    target[field] = field === "id" ? metadata.values.command_credential : metadata.values.report_time_credential;
    writeJsonAtomic(executionSource, execution); const inputs = [metaPath, executionSource].map(path => fs.readFileSync(path));
    assert.deepEqual(writeRunExecutionContextExport(stateDir, producer), { status: "unavailable", reason: "execution_metadata_redacted" });
    assert.deepEqual(fs.readFileSync(executionPath), retained); assert.equal(historical.unchanged(), true);
    assert.deepEqual(readRunExecutionContextView(stateDir, producer).view, historical.view);
    assert.deepEqual([metaPath, executionSource].map(path => fs.readFileSync(path)), inputs);
    if (had) target[field] = previous; else delete target[field]; writeJsonAtomic(executionSource, execution);
  }
  report.originalExecutionFactRefusalPreservesHistory = true;
  const controlJournal = join(stateDir, "controls.jsonl"), priorControlJournal = fs.readFileSync(controlJournal);
  const priorCapacityView = readRunControlContextView(stateDir, producer), priorCapacityBytes = fs.readFileSync(controlPath); assert.equal(priorCapacityView.state, "available");
  fs.appendFileSync(controlJournal, JSON.stringify({ ...firstControl, id: "recorded-pending-row70", queued_at: metadata.values.report_time_credential, input: { note: "controlled metadata only" } }) + "\n");
  const capacityInputs = [metaPath, controlJournal].map(path => fs.readFileSync(path));
  assert.deepEqual(writeRunControlContextExport(stateDir, producer), { status: "unavailable", reason: "control_metadata_redacted" });
  assert.deepEqual(fs.readFileSync(controlPath), priorCapacityBytes); assert.equal(priorCapacityView.unchanged(), true);
  assert.deepEqual(readRunControlContextView(stateDir, producer).view, priorCapacityView.view);
  assert.deepEqual([metaPath, controlJournal].map(path => fs.readFileSync(path)), capacityInputs);
  fs.writeFileSync(controlJournal, priorControlJournal); // Explicit fixture source restoration, never a publisher rollback.
  report.originalControlCapacityPrivacyRefusesView = true;
  const historicalControl = readRunControlContextView(stateDir, producer); assert.equal(historicalControl.state, "available");
  appendRunControlInStateDir(stateDir, { run_instance_id: generation, action: "refresh", input: { note: "new /x/private/control" } });
  assert.deepEqual(readRunControlContextView(stateDir, producer).view, historicalControl.view); assert.equal(historicalControl.view.capacity.pending, 0);
  fs.renameSync(controlJournal, controlJournal + ".held");
  assert.deepEqual(readRunControlContextView(stateDir, producer).view, historicalControl.view); fs.renameSync(controlJournal + ".held", controlJournal);
  assert.equal(writeRunControlContextIndex(stateDir, producer).status, "published"); const updatedControl = body(controlPath);
  assert.equal(historicalControl.unchanged(), false); assert.equal(readRunControlContextView(stateDir, producer).view.capacity.pending, 1);
  report.controlHistoricalCountsAndJournalLoss = true;
  assert.equal(updatedControl.controls.length, 3); assert.ok(updatedControl.controls.every(row => row.run_instance_id === generation));
  assert.equal(updatedControl.capacity.pending, 1); assert.doesNotMatch(JSON.stringify(updatedControl), /HIDDEN_|\/x\/pr/);
  assert.deepEqual(readRunTraceContextView(stateDir, producer).view.items.length, 3); report.controlLiveMetadataCannotRenewPrivacy = true;
  const edited = JSON.parse(viewBytes.toString()); const raw = "echo /x/private/payload \r\n";
  edited.recipe.launch.template = raw + " ".repeat(edited.recipe.launch.template.length - raw.length);
  fs.writeFileSync(viewPath, JSON.stringify(edited, null, 2) + "\n"); assert.equal(fs.statSync(viewPath).size, viewBytes.length);
  assert.equal(readRunContextIndex(stateDir, metadata).state, "available"); assert.equal(unchangedOriginal.unchanged(), false);
  assert.deepEqual(readRunRecipeContextView(stateDir, producer), { state: "unavailable", reason: "view_mismatch" }); assert.equal(fs.readFileSync(viewPath).includes("/x/private"), true);
  report.sameSizeTamperRefusedWithoutRepair = true;
  fs.writeFileSync(viewPath, viewBytes); // Explicit fixture restoration, not reader repair.
  fs.renameSync(viewPath, viewPath + ".held"); assert.equal(readRunRecipeContextView(stateDir, producer).state, "unavailable"); assert.equal(fs.existsSync(viewPath), false);
  fs.renameSync(viewPath + ".held", viewPath); assert.equal(readRunRecipeContextView(stateDir, producer).state, "available");
  report.sourceLossRefusedWithoutFallback = true; report.explicitRestorationObserved = true;
  const updateSize = size => { const index = body(indexPath); index.entries.recipe.bytes_total = size; writeJsonAtomic(indexPath, index); };
  fs.writeFileSync(viewPath, Buffer.concat([viewBytes, Buffer.alloc(RUN_CONTEXT_RECIPE_MAX_BYTES - viewBytes.length, 32)])); updateSize(RUN_CONTEXT_RECIPE_MAX_BYTES);
  assert.equal(readRunRecipeContextView(stateDir, producer).state, "available");
  fs.appendFileSync(viewPath, " "); updateSize(RUN_CONTEXT_RECIPE_MAX_BYTES + 1);
  assert.deepEqual(readRunRecipeContextView(stateDir, producer), { state: "unavailable", reason: "view_unavailable" });
  fs.writeFileSync(viewPath, viewBytes); updateSize(viewBytes.length); report.sourceByteLimitIndependent = true;
  writeJsonAtomic(metaPath, { ...metadata, values: { padding: "🫧".repeat(300000) } });
  assert.ok(Buffer.byteLength(JSON.stringify(body(metaPath))) > RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
  const oversizedOriginal = admitRunResultProducer(stateDir).producer; report.issuerAdmissions++;
  writeJsonAtomic(metaPath, metadata); assert.deepEqual(readRunRecipeContextView(stateDir, oversizedOriginal), { state: "unavailable", reason: "admission_unavailable" });
  assert.deepEqual(readRunTraceContextView(stateDir, oversizedOriginal), { state: "unavailable", reason: "admission_unavailable" });
  assert.deepEqual(readRunControlContextView(stateDir, oversizedOriginal), { state: "unavailable", reason: "admission_unavailable" });
  assert.deepEqual(readRunExecutionContextView(stateDir, oversizedOriginal), { state: "unavailable", reason: "admission_unavailable" });
  assert.equal(writeRunControlContextIndex(stateDir, oversizedOriginal).status, "published"); assert.equal(body(indexPath).entries.control.reason, "control_admission_unavailable");
  assert.equal(writeRunControlContextIndex(stateDir, producer).status, "published");
  assert.equal(readRunRecipeContextView(stateDir, producer).state, "available"); report.originalCaptureBudgetIndependent = true;
  const largeValues = Object.fromEntries(Array.from({ length: 13 }, (_, i) => ["field" + i, "界".repeat(1300)]));
  writeJsonAtomic(metaPath, { ...metadata, values: largeValues }); const largeResponse = admitRunResultProducer(stateDir).producer; report.issuerAdmissions++;
  assert.equal(writeRunRecipeContextIndex(stateDir, largeResponse).status, "published"); assert.ok(fs.statSync(viewPath).size <= RUN_CONTEXT_RECIPE_MAX_BYTES);
  assert.deepEqual(readRunRecipeContextView(stateDir, largeResponse), { state: "unavailable", reason: "response_too_large" });
  report.wholeResponseBudgetIndependent = true;
  writeJsonAtomic(metaPath, metadata); writeRunRecipeContextIndex(stateDir, producer); assert.equal(readRunRecipeContextView(stateDir, producer).state, "available");
  for (let index = 0; index < 12; index++) appendRunTraceEvent(stateDir, { kind: "checkpoint.large", summary: "bounded large data", data: { note: "界".repeat(1300) } });
  assert.equal(writeRunTraceContextIndex(stateDir, producer).status, "published");
  const largeTraceBytes = fs.readFileSync(tracePath); assert.ok(largeTraceBytes.length <= RUN_CONTEXT_TRACE_MAX_BYTES);
  assert.deepEqual(readRunTraceContextView(stateDir, producer), { state: "unavailable", reason: "response_too_large" });
  fs.writeFileSync(tracePath, Buffer.concat([largeTraceBytes, Buffer.alloc(RUN_CONTEXT_TRACE_MAX_BYTES + 1 - largeTraceBytes.length, 32)]));
  const oversizedIndex = body(indexPath); oversizedIndex.entries.trace.bytes_total = RUN_CONTEXT_TRACE_MAX_BYTES + 1; writeJsonAtomic(indexPath, oversizedIndex);
  assert.deepEqual(readRunTraceContextView(stateDir, producer), { state: "unavailable", reason: "view_unavailable" });
  fs.writeFileSync(tracePath, largeTraceBytes); oversizedIndex.entries.trace.bytes_total = largeTraceBytes.length; writeJsonAtomic(indexPath, oversizedIndex);
  report.traceSourceAndResponseLimitsIndependent = true;
  execution.commands = Array.from({ length: 12 }, (_, index) => ({ ...execution.commands[0], id: `command-${String(index + 1).padStart(3, "0")}`, label: "界".repeat(1300) }));
  writeJsonAtomic(executionSource, execution); assert.equal(writeRunExecutionContextIndex(stateDir, producer).status, "published");
  assert.ok(fs.statSync(executionPath).size <= RUN_CONTEXT_EXECUTION_MAX_BYTES); assert.deepEqual(readRunExecutionContextView(stateDir, producer), { state: "unavailable", reason: "response_too_large" });
  report.executionWholeResponseBudgetIndependent = true;
  // Two explicit baseline selections reuse existing issuer keys; no command/SDK session or native workload is started.
  const heldExecution = fs.readFileSync(executionSource), heldMetadata = fs.readFileSync(metaPath);
  const selectedSession = "sessions/command-001/current71.jsonl", peerSession = "sessions/command-999/peer71.jsonl";
  for (const relative of [selectedSession, peerSession]) { const file = join(stateDir, relative); fs.mkdirSync(join(file, ".."), { recursive: true });
    fs.writeFileSync(file, [{ type: "session", version: 3, id: "synthetic-metadata71" }, { type: "message", id: "a", parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "public-session71" }] } }].map(value => JSON.stringify(value)).join("\n") + "\n"); }
  const sessionExecution = body(executionSource); sessionExecution.commands[0].session_files = [selectedSession];
  sessionExecution.commands.push({ id: "command-999", status: "running", attempts: [], session_files: [peerSession] });
  writeJsonAtomic(executionSource, sessionExecution);
  const selectedQuery = { kind: "session", command_id: "command-001", path: selectedSession }, peerQuery = { kind: "session", command_id: "command-999", path: peerSession };
  assert.equal(writeRunSessionContextIndex(stateDir, largeResponse, peerQuery).status, "published");
  const sessionCatalogPath = join(stateDir, "evidence", "sessions.json"), peerEntry = body(sessionCatalogPath).previews[0], peerSavedPath = join(stateDir, peerEntry.path);
  const priorSessionCatalog = fs.readFileSync(sessionCatalogPath), priorPeerBody = fs.readFileSync(peerSavedPath);
  sessionPublication = { binding_capture_index: 0, source_scope: "genuine_private_publication_controlled_recorded_session",
    export_id: peerEntry.export_id, command_id: peerEntry.command_id, catalog_path: sessionCatalogPath, preview_path: peerSavedPath,
    catalog_bytes: priorSessionCatalog.length, preview_bytes: priorPeerBody.length,
    catalog_sha256: createHash("sha256").update(priorSessionCatalog).digest("hex"), preview_sha256: createHash("sha256").update(priorPeerBody).digest("hex") };
  persist(); // Data-only witness of the actual successful original writer; never a serialized producer capability.
  writeJsonAtomic(metaPath, { ...metadata, values: { skill_dir: "/actor/current" } });
  assert.deepEqual(writeRunSessionContextExport(stateDir, producer, peerQuery), { status: "unavailable", reason: "session_metadata_redacted" });
  sessionExecution.updated_at = metadata.values.report_time_credential; writeJsonAtomic(executionSource, sessionExecution);
  assert.equal(readRunSessionPreview(stateDir, identity, selectedQuery).state, "available");
  assert.deepEqual(writeRunSessionContextExport(stateDir, producer, selectedQuery), { status: "unavailable", reason: "session_metadata_redacted" });
  sessionExecution.updated_at = clock.started_at; writeJsonAtomic(executionSource, sessionExecution);
  const selectedId = createHash("sha256").update(JSON.stringify([selectedQuery.command_id, selectedQuery.path])).digest("hex");
  assert.deepEqual(writeRunSessionContextExport(stateDir, producer, selectedQuery), { status: "unavailable", reason: "session_metadata_redacted" });
  assert.equal(fs.existsSync(join(stateDir, "evidence", "sessions", "session-" + selectedId + ".json")), false);
  assert.deepEqual(fs.readFileSync(sessionCatalogPath), priorSessionCatalog); assert.deepEqual(fs.readFileSync(peerSavedPath), priorPeerBody);
  assert.equal(readRunSessionContextPreview(stateDir, identity, peerEntry.export_id).state, "available");
  assert.equal(writeRunSessionContextIndex(stateDir, producer, selectedQuery).status, "published");
  assert.equal(body(indexPath).entries.sessions.reason, "session_metadata_redacted");
  assert.deepEqual(readRunSessionContextPreview(stateDir, identity, peerEntry.export_id), { state: "unavailable", reason: "sessions_unavailable" });
  assert.deepEqual(fs.readFileSync(sessionCatalogPath), priorSessionCatalog); assert.deepEqual(fs.readFileSync(peerSavedPath), priorPeerBody);
  fs.writeFileSync(executionSource, heldExecution); fs.writeFileSync(metaPath, heldMetadata); // Explicit fixture input restoration, not publication rollback.
  report.originalSessionSelectedMetadataRefused = true; report.originalSessionPeerMetadataRefused = true;
  const identityPorts = [
    { role: "recipe", write: writeRunRecipeContextIndex, read: readRunRecipeContextView },
    { role: "trace", write: writeRunTraceContextIndex, read: readRunTraceContextView },
    { role: "control", write: writeRunControlContextIndex, read: readRunControlContextView },
    { role: "execution", write: writeRunExecutionContextIndex, read: readRunExecutionContextView },
  ];
  for (const frame of metadataFrames) {
    claimRunStateDirectory(frame.state_dir, run);
    const caseMetadata = { ...metadata, run_instance_id: frame.run_instance_id, state_dir: frame.state_dir };
    if (frame.ownerId === undefined) delete caseMetadata.ownerId; else caseMetadata.ownerId = frame.ownerId;
    if (frame.literal_secret !== undefined) caseMetadata.values = { ...caseMetadata.values, api_key: frame.literal_secret };
    const bodySecret = frame.name === "logical_identity" ? "BODY_PACKED_66" : frame.name === "owner_absent" ? "raw\"\\\r\n\uFEFF\uFFFD🫧```" : undefined;
    const bodyBoundary = bodySecret && "x".repeat(3994) + bodySecret + " AFTER";
    const bodyEncoded = bodySecret && "\uFEFF" + JSON.stringify({ note: bodySecret, [bodySecret]: JSON.stringify({ deep: bodySecret }) });
    const opaqueSecret = bodySecret && (frame.name === "logical_identity" ? '[ "credential68" ]' : '\uFEFF[ "credential68" ]'), routeSecret = "private_route68";
    if (bodySecret) { caseMetadata.values = { ...caseMetadata.values, nested: { password: bodySecret, credential: opaqueSecret, token: routeSecret } }; caseMetadata.template = bodyBoundary;
      caseMetadata.recipe_context_records = caseMetadata.recipe_context_records.map(entry => ({ ...entry, ...(frame.name === "logical_identity" ? { logical_reference: "suite/" + bodySecret } : {}), recipe: { ...entry.recipe, template: "literal " + bodySecret, note: { [bodySecret]: bodyEncoded }, opaque: opaqueSecret } })); }
    if (frame.name === "owner_absent") caseMetadata.cwd = process.cwd() + "/[REDACTED]/not-opened";
    caseMetadata.artifacts = { operational: "/x/private/declared-output.txt", ...(frame.name === "owner_absent"
      ? { report: "[REDACTED]-output.txt" } : { api_key: caseMetadata.values.api_key + "-output.txt" }) };
    const issuedTrace = bodySecret && appendRunTraceEvent(frame.state_dir, { kind: "checkpoint.issued", summary: "public-only" });
    if (issuedTrace) caseMetadata.values = { ...caseMetadata.values, trace_credential: issuedTrace.id };
    const path = join(frame.state_dir, "run.json"); writeJsonAtomic(path, caseMetadata);
    const key = admitRunResultProducer(frame.state_dir).producer; report.issuerAdmissions++;
    appendRunTraceEvent(frame.state_dir, { kind: "checkpoint.identity", summary: "recorded /x/private/helper" });
    if (bodySecret) { appendRunTraceEvent(frame.state_dir, { kind: "checkpoint.body", summary: "literal " + bodySecret, data: { [bodySecret]: bodyEncoded, boundary: bodyBoundary } });
      appendRunTraceEvent(frame.state_dir, { kind: "checkpoint.opaque", summary: opaqueSecret, data: { note: opaqueSecret } });
      appendRunTraceEvent(frame.state_dir, { kind: "checkpoint." + routeSecret, summary: "public-only" }); }
    const control = appendRunControlInStateDir(frame.state_dir, { run_instance_id: frame.run_instance_id, action: "refresh",
      ...(bodySecret ? { input: { note: bodySecret, [bodySecret]: bodySecret, opaque: opaqueSecret } } : {}) });
    const privateControl = bodySecret && appendRunControlInStateDir(frame.state_dir, { run_instance_id: frame.run_instance_id, action: routeSecret, input: { note: "public-only" } });
    if (bodySecret) fs.writeFileSync(join(frame.state_dir, "controls.jsonl"),
      [control, ...(frame.name === "logical_identity" ? [{ ...control, id: "prefix-" + caseMetadata.values.api_key + "-suffix" }] : []), privateControl,
        { ...control, id: "recorded-time-row70", status: "failed", failed_at: metadata.values.report_time_credential, error: "controlled metadata only", input: { note: "public-only" } }]
        .map(value => JSON.stringify(value)).join("\n") + "\n");
    const session = "sessions/command-001/recorded.jsonl", sessionPath = join(frame.state_dir, session), executionPath = join(frame.state_dir, "execution.json");
    fs.mkdirSync(join(sessionPath, ".."), { recursive: true }); fs.writeFileSync(sessionPath, [
      { type: "session", version: 3, id: "synthetic-private-session" },
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "/x/private/helper token=HIDDEN_SESSION visible-session" + (bodySecret ? " literal " + bodySecret : "") }] } },
      ...(bodySecret ? [
        { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: bodyBoundary }] } },
        { type: "message", id: "c", parentId: "b", message: { role: "assistant", content: [{ type: "text", text: bodyEncoded }] } },
        { type: "message", id: "d", parentId: "c", message: { role: "assistant", content: [{ type: "text", text: opaqueSecret }] } },
      ] : []),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    writeJsonAtomic(executionPath, { version: 1, run, run_instance_id: frame.run_instance_id, status: "running", updated_at: clock.started_at, active_subagents: 0,
      commands: [{ id: "command-001", status: "running", attempts: [], session_files: [session],
        ...(bodySecret ? { label: opaqueSecret, command: bodyBoundary, interruption: { message: bodyEncoded } } : {}) }] });
    for (const port of identityPorts) assert.equal(port.write(frame.state_dir, key).status, "published");
    const unsafe = !["logical_identity", "owner_absent"].includes(frame.name);
    if (frame.name === "logical_identity") { const control = body(join(frame.state_dir, "evidence", "control.json"));
      assert.equal(control.controls.length, 1); assert.equal(control.controls_omitted, 3); assert.equal(control.capacity.pending, 3); }
    const assertPrivacyClosure = (role, reading) => {
      if (!bodySecret) return;
      assert.equal(bodyLiteral(reading.view, routeSecret), false);
      if (role === "recipe") { assert.equal(reading.view.recipe.definition.opaque, "[REDACTED]");
        if (frame.name === "logical_identity") assert.equal(reading.view.recipe.identity.logical_reference, "suite/[REDACTED]"); }
      if (role === "trace") { const opaque = reading.view.items.find(row => row.kind === "checkpoint.opaque");
        assert.equal(opaque.summary, "[REDACTED]"); assert.deepEqual(opaque.detail, { data: { note: "[REDACTED]" } });
        assert.equal(reading.view.header.events_total, 5); assert.equal(reading.view.header.events_shown, 3); assert.equal(reading.view.header.events_omitted, 2);
        assert.equal(reading.view.items.some(row => row.id === issuedTrace.id), false); }
      if (role === "control") { assert.equal(reading.view.controls.find(row => row.id === control.id).input.opaque, "[REDACTED]");
        assert.equal(reading.view.controls.some(row => row.id === privateControl.id), false);
        assert.equal(reading.view.controls.some(row => row.id === "recorded-time-row70"), false);
        assert.equal(reading.view.controls_omitted, frame.name === "logical_identity" ? 3 : 2);
        assert.equal(reading.view.capacity.pending, frame.name === "logical_identity" ? 3 : 2); }
      if (role === "execution") assert.equal(reading.view.execution.commands[0].label, "[REDACTED]");
    };
    for (const port of identityPorts) {
      const reading = port.read(frame.state_dir, key);
      if (unsafe) assert.deepEqual(reading, { state: "unavailable", reason: "identity_redacted" });
      else { assert.equal(reading.state, "available"); assert.equal(reading.identity.run_instance_id, frame.run_instance_id);
        assert.equal(reading.identity.ownerId, frame.ownerId); assert.equal(Object.hasOwn(reading.identity, "ownerId"), frame.ownerId !== undefined);
        if (bodySecret) assert.equal(bodyLiteral(reading.view, bodySecret), false); assertPrivacyClosure(port.role, reading); }
    }
    if (frame.name.startsWith("generation_")) {
      const index = body(join(frame.state_dir, "context-index.json"));
      for (const role of ["recipe", "trace", "control", "execution"]) {
        assert.equal(index.entries[role].reason, `${role}_identity_redacted`);
        assert.equal(fs.existsSync(join(frame.state_dir, "evidence", role + (role === "trace" ? ".jsonl" : ".json"))), false);
      }
    }
    writeJsonAtomic(path, { ...caseMetadata, values: { skill_dir: "/actor/current" } });
    for (const port of identityPorts) {
      if (bodySecret) port.write(frame.state_dir, key);
      const reading = port.read(frame.state_dir, key);
      if (unsafe) assert.deepEqual(reading, { state: "unavailable", reason: "identity_redacted" }); else { assert.equal(reading.state, "available");
        if (bodySecret) assert.equal(bodyLiteral(reading.view, bodySecret), false); assertPrivacyClosure(port.role, reading); }
    }
    assert.equal(fs.existsSync(join(frame.state_dir, "result.json")), false);
    // Controlled canonical results, not executed command/OS-exit witnesses; no new host or workload.
    const code = ["generation_secret", "owner_secret", "owner_absent", "owner_literal", "owner_escaped_literal"].includes(frame.name) ? 7 : 0;
    const capture = join(frame.state_dir, "captures", "command-001", "attempt-001", "stdout.log");
    fs.mkdirSync(join(capture, ".."), { recursive: true }); const stdout = bodySecret ? opaqueSecret : " \uFEFF\r\nvisible-primary /x/private/helper " + caseMetadata.values.api_key + " 🫧```\r\n"; fs.writeFileSync(capture, stdout);
    const raw = { code: 0, killed: false, stdout, stderr: "", stdoutFile: capture, stdoutBytes: Buffer.byteLength(stdout), stdoutFileBytes: Buffer.byteLength(stdout) };
    const primary = createRunPrimaryTextPublisher(frame.state_dir, key), query = { kind: "session", command_id: "command-001", path: session };
    const sourceKey = createHash("sha256").update(JSON.stringify([run, frame.run_instance_id, frame.ownerId ?? null])).digest("hex");
    const targets = [caseMetadata.artifacts.operational, join(caseMetadata.cwd, caseMetadata.artifacts.report ?? caseMetadata.artifacts.api_key)];
    const inventory = withoutSourceProbes(unsafe ? [capture, sessionPath, executionPath, ...targets,
      join(frame.state_dir, "evidence", `primary-${sourceKey}.txt`), join(frame.state_dir, "evidence", `artifact-inventory-${sourceKey}.json`)] : targets, () => {
      // Privileged synthetic complete UTF-8 selection, not executor work or failed/session primary permission.
      if (unsafe || code === 0) { primary.observe(raw, { commandId: "command-001", attempts: [{ attempt: 1, result: raw }], session: false }); primary.select(raw); }
      writeRunSessionContextIndex(frame.state_dir, key, query);
      // An independent index publication invalidates an earlier inventory observation; capture its binding last.
      const inventory = prepareRunArtifactInventoryPublication(frame.state_dir, key); assert.equal(inventory.readFailure(), undefined); assert.equal(primary.readFailure(), undefined);
      if (unsafe) { assert.equal(primary.snapshot().output_unavailable, "identity_redacted"); assert.equal(inventory.snapshot().artifact_inventory_unavailable, "identity_redacted");
        assert.equal(body(join(frame.state_dir, "context-index.json")).entries.sessions.reason, "session_identity_redacted");
        for (const name of ["artifacts.json", "sessions.json", `primary-${sourceKey}.txt`, `artifact-inventory-${sourceKey}.json`]) assert.equal(fs.existsSync(join(frame.state_dir, "evidence", name)), false);
      } else { assert.ok(inventory.snapshot().artifact_inventory); if (code === 0) assert.ok(primary.snapshot().output); else assert.equal(primary.snapshot().output_unavailable, "not_selected"); }
      return inventory;
    });
    const diagnostics = createRunResultDiagnosticsPublisher(frame.state_dir, key); let attempts = 0;
    const resultDiagnostics = admission => { attempts++; return diagnostics.publish(admission); };
    const publicScalar = " \r\n[ \"public75\", true, null ]\t";
    publishRunResult(frame.state_dir, key, { code, command: "/x/private/helper", error: bodySecret ? opaqueSecret : "recorded /x/private/error token=HIDDEN_DIAGNOSTIC",
      ...(bodySecret ? { failure_reason: publicScalar } : {}) }, { resultDiagnostics, primaryText: primary.snapshot, artifactInventory: inventory.snapshot });
    const resultPath = join(frame.state_dir, "result.json"), firstBytes = fs.readFileSync(resultPath), canonical = body(resultPath);
    assert.equal(canonical.code, code); assert.equal(canonical.terminal_acceptance, "natural"); assert.equal(diagnostics.readFailure(), undefined);
    assert.equal(writeRunResultContextIndex(frame.state_dir, key).status, "published");
    const expected = { run, run_instance_id: frame.run_instance_id, ...(frame.ownerId === undefined ? {} : { ownerId: frame.ownerId }) };
    const outcome = readRunResultDiagnosticOutcome(frame.state_dir, expected, code === 0 ? "done" : "failed");
    const selected = readRunResultDiagnosticsSource(frame.state_dir, expected, { field: "error" });
    const wholeResult = readRunResultContextView(frame.state_dir, key);
    if (unsafe) {
      assert.deepEqual(wholeResult, { state: "unavailable", reason: "identity_redacted" });
      assert.equal(canonical.output_unavailable, "identity_redacted"); assert.equal(canonical.artifact_inventory_unavailable, "identity_redacted");
      assert.equal(canonical.result_diagnostics, null); assert.equal(canonical.result_diagnostics_unavailable, "identity_redacted");
      assert.equal(body(join(frame.state_dir, "context-index.json")).entries.result.reason, "result_identity_redacted");
      assert.equal(fs.existsSync(join(frame.state_dir, "evidence", "result.json")), false);
      assert.deepEqual(outcome, { state: "unavailable", reason: "diagnostics_unavailable", result_diagnostics_unavailable: "identity_redacted" });
      assert.deepEqual(selected, { state: "unavailable", reason: "publication_unavailable" });
    } else {
      assert.equal(outcome.state, "available"); assert.equal(selected.state, "available");
      assert.equal(wholeResult.state, "available"); assert.equal(wholeResult.basis, "original_result_publication_match");
      assert.equal(wholeResult.view.outcome.code, code); assert.equal(wholeResult.view.primary_text, "not_included");
      assert.equal(Object.isFrozen(wholeResult.view.diagnostics), true);
      const wholePath = join(frame.state_dir, "evidence", "result.json"), wholeBytes = fs.readFileSync(wholePath), changedWhole = body(wholePath);
      changedWhole.outcome.recorded_at = metadata.values.report_time_credential; writeJsonAtomic(wholePath, changedWhole);
      assert.equal(fs.statSync(wholePath).size, wholeBytes.length); assert.equal(readRunContextIndex(frame.state_dir, expected).state, "available");
      assert.deepEqual(readRunResultContextView(frame.state_dir, key), { state: "unavailable", reason: "view_mismatch" });
      assert.equal(wholeResult.unchanged(), false); fs.writeFileSync(wholePath, wholeBytes); // Explicit controlled tamper/restoration, not reader repair.
      assert.equal(readRunResultContextView(frame.state_dir, key).state, "available");
      assert.equal(selected.identity.run_instance_id, frame.run_instance_id); assert.equal(selected.identity.ownerId, frame.ownerId);
      assert.doesNotMatch(selected.output.text, /HIDDEN_|\/x\/private/);
      if (bodySecret) {
        assert.equal(selected.output.text, "[REDACTED]"); assert.equal(body(canonical.result_diagnostics.source.path).fields.error, "[REDACTED]");
        const publicRead = readRunResultDiagnosticsSource(frame.state_dir, expected, { field: "failure_reason" });
        assert.equal(publicRead.state, "available"); assert.equal(publicRead.output.text, publicScalar);
      }
      const primaryRead = readRunPrimaryTextSource(frame.state_dir, expected);
      if (code === 0) { assert.equal(primaryRead.state, "available"); assert.equal(primaryRead.identity.ownerId, frame.ownerId);
        assert.doesNotMatch(primaryRead.output.preview, /HIDDEN_|\/x\/private/);
        if (bodySecret) { assert.equal(primaryRead.output.preview, "[REDACTED]"); assert.equal(primaryRead.output.redacted, true); } } else assert.equal(primaryRead.state, "unavailable");
      const declarations = withoutSourceProbes(targets, () => readRunArtifactInventorySource(frame.state_dir, expected));
      assert.equal(declarations.state, "available"); assert.equal(declarations.identity.ownerId, frame.ownerId);
      assert.equal(declarations.artifacts[0].path, targets[0]); assert.equal(declarations.artifacts[1].path, null);
      const snapshotReferences = withoutSourceProbes([...targets, caseMetadata.cwd], () => createRunSnapshotReferenceReader(frame.state_dir, key).read());
      assert.equal(snapshotReferences.state, "available", JSON.stringify(snapshotReferences)); assert.equal(snapshotReferences.references.context_index.path, join(frame.state_dir, "context-index.json"));
      if (frame.name === "owner_absent") { assert.equal(snapshotReferences.references.cwd, null); assert.equal(snapshotReferences.references.cwd_unavailable, "cwd_reference_redacted"); }
      else assert.equal(snapshotReferences.references.cwd, caseMetadata.cwd);
      assert.equal(snapshotReferences.unchanged(), true);
      const catalog = body(join(frame.state_dir, "evidence", "sessions.json")); const sessionRead = readRunSessionContextPreview(frame.state_dir, expected, catalog.previews[0].export_id);
      assert.equal(sessionRead.state, "available"); assert.equal(sessionRead.identity.ownerId, frame.ownerId); assert.doesNotMatch(JSON.stringify(sessionRead.preview), /HIDDEN_|\/x\/private/);
      if (bodySecret) { assert.equal(bodyLiteral(sessionRead.preview, bodySecret), false);
        const projected = bodyBoundary.replaceAll(bodySecret, "[REDACTED]");
        assert.equal(sessionRead.preview.messages[1].assistant_text, Array.from(projected).slice(0, 4000).join(""));
        assert.equal(sessionRead.preview.messages[1].text_chars_observed, Array.from(projected).length);
        assert.equal(sessionRead.preview.messages[3].assistant_text, "[REDACTED]"); assert.equal(sessionRead.preview.messages[3].text_chars_observed, 10); }
    }
    if (!unsafe) {
      const savedViewPath = join(frame.state_dir, "evidence", "result.json"), savedIndexPath = join(frame.state_dir, "context-index.json");
      const savedView = fs.readFileSync(savedViewPath), savedIndex = fs.readFileSync(savedIndexPath), sourcePath = canonical.result_diagnostics.source.path;
      const savedSource = fs.readFileSync(sourcePath);
      const timePorts = [["recipe", writeRunRecipeContextExport, readRunRecipeContextView], ["trace", writeRunTraceContextExport, readRunTraceContextView],
        ["control", writeRunControlContextExport, readRunControlContextView], ["execution", writeRunExecutionContextExport, readRunExecutionContextView],
        ["result", writeRunResultContextExport, readRunResultContextView]];
      const timePaths = [...timePorts.map(([role]) => join(frame.state_dir, "evidence", role + (role === "trace" ? ".jsonl" : ".json"))),
        savedIndexPath, sourcePath, resultPath, path];
      const timeBytes = timePaths.map(target => fs.readFileSync(target));
      for (const [role, write, read] of timePorts) {
        const prior = read(frame.state_dir, key); assert.equal(prior.state, "available");
        assert.deepEqual(atFileTime(metadata.values.report_time_credential, () => write(frame.state_dir, key)), { status: "unavailable", reason: role + "_metadata_redacted" });
        assert.equal(prior.unchanged(), true); assert.equal(read(frame.state_dir, key).state, "available");
        const target = join(frame.state_dir, "evidence", role + (role === "trace" ? ".jsonl" : ".json")), bytes = fs.readFileSync(target);
        const lines = bytes.toString("utf8").trimEnd().split("\n"), changed = role === "trace" ? JSON.parse(lines[0]) : body(target);
        changed.captured_at = metadata.values.report_time_credential;
        const content = role === "trace" ? [JSON.stringify(changed), ...lines.slice(1)].join("\n") + "\n" : JSON.stringify(changed, null, 2) + "\n";
        assert.equal(Buffer.byteLength(content), bytes.length); fs.writeFileSync(target, content);
        assert.equal(readRunContextIndex(frame.state_dir, expected).state, "available");
        assert.deepEqual(read(frame.state_dir, key), { state: "unavailable", reason: role === "recipe" ? "view_metadata_redacted" : "view_mismatch" });
        assert.equal(fs.readFileSync(target, "utf8"), content); fs.writeFileSync(target, bytes); // Explicit fixture restoration, never reader repair.
      }
      const recipeTimePath = timePaths[0], publicTime = body(recipeTimePath); publicTime.captured_at = "2002-01-01T00:00:00.000Z";
      writeJsonAtomic(recipeTimePath, publicTime); assert.equal(readRunRecipeContextView(frame.state_dir, key).view.captured_at, publicTime.captured_at);
      fs.writeFileSync(recipeTimePath, timeBytes[0]); assert.deepEqual(timePaths.map(target => fs.readFileSync(target)), timeBytes);
      // Explicit controlled reported-date edit, not actual new first-result issuance or native terminal time.
      writeJsonAtomic(resultPath, { ...canonical, completedAt: metadata.values.report_time_credential });
      const reportedBytes = fs.readFileSync(resultPath);
      withoutSourceProbes([sourcePath], () => assert.deepEqual(writeRunResultContextExport(frame.state_dir, key), { status: "unavailable", reason: "result_metadata_redacted" }));
      assert.deepEqual(fs.readFileSync(savedViewPath), savedView); assert.deepEqual(fs.readFileSync(savedIndexPath), savedIndex);
      assert.deepEqual(fs.readFileSync(sourcePath), savedSource); assert.deepEqual(fs.readFileSync(resultPath), reportedBytes);
      assert.equal(writeRunResultContextIndex(frame.state_dir, key).status, "published");
      assert.equal(body(savedIndexPath).entries.result.reason, "result_metadata_redacted");
      assert.deepEqual(readRunResultDiagnosticsSource(frame.state_dir, expected, { field: "error" }), { state: "unavailable", reason: "publication_unavailable" });
      fs.writeFileSync(resultPath, firstBytes); // Explicit fixture restoration, not exporter rollback/repair.
      assert.equal(writeRunResultContextIndex(frame.state_dir, key).status, "published");
      assert.equal(readRunResultDiagnosticsSource(frame.state_dir, expected, { field: "error" }).state, "available");
      assert.deepEqual(fs.readFileSync(sourcePath), savedSource); assert.deepEqual(body(resultPath).result_diagnostics, canonical.result_diagnostics);
      fs.renameSync(resultPath, resultPath + ".held"); fs.renameSync(sourcePath, sourcePath + ".held");
      assert.equal(readRunResultContextView(frame.state_dir, key).state, "available");
      assert.deepEqual(writeRunResultContextExport(frame.state_dir, key), { status: "unavailable", reason: "result_absent" });
      assert.equal(readRunResultContextView(frame.state_dir, key).state, "available");
      fs.renameSync(resultPath + ".held", resultPath); fs.renameSync(sourcePath + ".held", sourcePath);
      assert.equal(writeRunResultContextIndex(frame.state_dir, key).status, "published");
      assert.equal(readRunResultContextView(frame.state_dir, key).state, "available");
    }
    publishRunResult(frame.state_dir, key, { code: code === 0 ? 7 : 0, error: "replacement diagnostic" }, { resultDiagnostics });
    assert.equal(attempts, 1); assert.deepEqual(fs.readFileSync(resultPath), firstBytes);
  }
  report.originalRecordedBodyPrivacyBeforeLimits = true; report.bodyPrivacyNonrenewalAfterLiveEdits = true;
  report.rawOpaqueScalarPrivacyBeforeNormalization = true; report.originalRoutingMetadataRowsOmitted = true;
  report.recipeDisplayLabelsPreserveOriginalProjection = true;
  report.originalTraceIdentityFactRowsOmitted = true; report.originalControlTimestampRowsOmitted = true;
  report.inventoryDisplayMaskPathWithheld = true; report.snapshotDisplayMaskCwdWithheld = true;
  report.originalSourcePublicationIdentityPrivacy = true; report.privateSourceRefusalBeforeBodyProbes = true;
  report.safeSourceRecoveryNoTargetProbes = true; report.controlledPrimarySelections = 9; report.controlledSessionSelections = metadataFrames.length + 2;
  report.capturedLiteralIdentityPrivacy = true; report.controlLiteralRowsOmittedWithoutCapacityRepair = true;
  report.resultOriginalPublicationIdentityPrivacy = true; report.resultSafeIdentityDiagnosticsRecovered = true;
  report.resultFirstBindingUnavailabilityImmutable = true; report.originalResultContextMetadataRefused = true;
  report.resultWholeViewOriginalPublication = true; report.resultHistoricalReadWithoutRootOrDiagnosticSource = true;
  report.originalCompleteTextOpaquePrivacy = true; report.publicSourceScalarSpellingPreserved = true;
  report.originalCapturedAtPrivacy = true; report.capturedAtRefusalPreservesHistory = true; report.publicRecipeFileTimePreserved = true;
  report.controlledCanonicalResultRecords = metadataFrames.length;
  report.originalHeaderAndResponseIdentityPrivacy = true; report.safeLogicalAndAbsentOwnerPreserved = true;
  report.identityPrivacyNotRenewedFromLiveMetadata = true; report.controlledIdentityMetadataFrames = metadataFrames.length;
  // A controlled trusted-kernel report, not physical lock-release failure or new native work/closure evidence.
  const cleanupTrace = join(stateDir, "evidence", "trace.jsonl"), rename = fs.renameSync, diagnostic = console.error;
  let cleanupReports = 0, cleanupCommits = 0; const cleanupMessages = [];
  console.error = (...args) => { cleanupReports++; cleanupMessages.push(args); };
  fs.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === cleanupTrace) {
    cleanupCommits++; reportRunProducerCleanupFailure(unrecorded, Object.assign(Error("Controlled kernel cleanup report"), { code: "EIO" }));
  } return result; }); syncBuiltinESMExports();
  try { assert.equal(writeRunTraceContextExport(stateDir, unrecorded).status, "written"); }
  finally { fs.renameSync = rename; console.error = diagnostic; syncBuiltinESMExports(); }
  assert.equal(cleanupReports, 1); assert.equal(cleanupCommits, 1);
  assert.deepEqual(cleanupMessages, [["Run producer lifecycle cleanup failed; release remains unproven and further producer operations are fenced."]]);
  assert.deepEqual(readRunProducerCleanupFailure(unrecorded), { status: "release_unproven", error_code: "EIO" });
  withoutSourceProbes([metaPath, cleanupTrace, indexPath], () => assert.deepEqual(readRunTraceContextView(stateDir, unrecorded), { state: "unavailable", reason: "publication_unavailable" }));
  assert.throws(() => writeRunTraceContextExport(stateDir, unrecorded), /lifecycle cleanup remains unproven/);
  report.knownCleanupReportDoesNotMintPublication = true;
  report.baselineRootResultAbsent = !fs.existsSync(join(stateDir, "result.json"));
  assert.equal(report.baselineRootResultAbsent, true);
  assert.equal(createHash("sha256").update(fs.readFileSync(sessionPublication.catalog_path)).digest("hex"), sessionPublication.catalog_sha256);
  assert.equal(createHash("sha256").update(fs.readFileSync(sessionPublication.preview_path)).digest("hex"), sessionPublication.preview_sha256);
  const navigationRoot = getRunStateRoot();
  registerRunStateDirectory(navigationRoot, stateDir, { ...identity, state_dir: stateDir, status: "unknown" });
  sessionPublication = { ...sessionPublication, navigation_root: navigationRoot };
  const prepared = readRunSessionNavigation(navigationRoot, manager.getSessionId());
  assert.equal(prepared.state, "available"); assert.equal(prepared.shown, 1); assert.equal(prepared.omitted, 0);
  assert.equal(prepared.items[0].files.find(file => file.role === "published_sessions").path, sessionPublication.catalog_path);
  report.preparedMapShown = prepared.shown;
  report.savedSessionFrame = sessionFrame; report.sessionPublication = sessionPublication;
  complete = true;
} catch (error) { primaryError = error; }
finally {
  try { persist(); } catch (error) { throw new AggregateError([...(primaryError ? [primaryError] : []), error], "Private context fixture capture failed; retaining state"); }
}
if (primaryError) throw primaryError;
console.log(JSON.stringify(report));
