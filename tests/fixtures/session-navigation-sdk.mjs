import fs from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const [inputPath] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const manifest = { schema: "session-navigation-sdk-v1", phase: input.phase, pid: process.pid,
  host_exit: "not_asserted", workloads: 0, sessions: input.sessions, frames: input.frames,
  ...(input.phase === "genuine_research" ? { session_copies: [], session_file: input.sessionFile, registered_run: input.registeredRun, failed_run: input.failedRun, retry_run: input.retryRun, composition_run: input.compositionRun, entrypoint_run: input.entrypointRun, parallel_run: input.parallelRun, degraded_run: input.degradedRun, unusable_run: input.unusableRun, entrypoint_path: input.entrypointPath, entrypoint_journeys: [], session_switches: [] } : {}),
  ...(input.phase === "published_research" ? { session_file: input.sessionFile, publication: input.publication, fixture_actions: [] } : {}),
  ...(input.phase === "priority" ? { entrypoint_path: input.entrypointPath, entrypoint_journeys: [], priority_maps: [], priority_snapshots: [] } : {}), complete: false };
const persist = () => fs.writeFileSync(input.manifest, JSON.stringify(manifest));
persist();
const { createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, SessionManager, SettingsManager } =
  await import("@earendil-works/pi-coding-agent");
const modulePath = name => pathToFileURL(join(input.packageDir, input.layout === "source" ? "lib" : "dist/lib",
  `${name}.${input.layout === "source" ? "ts" : "js"}`)).href;
const { createInspectToolDefinition } = await import(modulePath("tools-inspect"));
const { registerRunStateDirectory } = await import(modulePath("runs-index"));
const { claimRunStateDirectory } = await import(modulePath("runs-ownership"));
const { runContextExportPath } = await import(modulePath("runs-context-index"));
const catalog = join(input.agentDir, "tmp", "pi-actors", "runs");
const actorsSkill = join(input.packageDir, input.layout === "source" ? "skills" : "dist/skills", "actors", "SKILL.md");
const selectedPreviewId = "a".repeat(64), unselectedPreviewId = "b".repeat(64);
const selectedPreviewText = "CONTROLLED_SELECTED_PREVIEW 😀";
const partialCoverage = { truncated: true, redacted: true, history_complete: false };
if (input.phase === "initial" || input.phase === "priority") {
  for (const frame of input.frames) {
    claimRunStateDirectory(frame.state_dir, frame.run);
    const { parent_run, ...identity } = frame;
    const parent = input.frames.find(row => row.run === (parent_run ?? (frame.run === "child" ? "parent" : undefined)));
    const metadata = { ...identity, pid: 0, status: "running", ...(parent ? { delivery_parent: {
      run: parent.run, run_instance_id: parent.run_instance_id, state_dir: parent.state_dir } } : {}) };
    fs.writeFileSync(join(frame.state_dir, "run.json"), JSON.stringify(metadata));
    fs.writeFileSync(join(frame.state_dir, "result.json"), JSON.stringify({ code: ["foreign", "failed-grandchild", "budget-failed-grandchild"].includes(frame.run) ? 7 : 0, run_instance_id: frame.run_instance_id,
      report: `CONTROLLED_${frame.run}_REPORT` }));
    if (frame.run === "parent" && input.phase === "initial") {
      fs.mkdirSync(join(frame.state_dir, "evidence", "sessions"), { recursive: true });
      const at = "2026-10-24T00:00:00.000Z"; // Controlled file metadata, not publication/clock authority.
      const previews = [selectedPreviewId, unselectedPreviewId].map((export_id, index) => {
        const text = index === 0 ? selectedPreviewText : "CONTROLLED_UNSELECTED_PREVIEW_BODY";
        const shown = Array.from(text).length, path = `evidence/sessions/session-${export_id}.json`;
        const body = JSON.stringify({ schema: "run-context-session-preview-v1", run: frame.run, run_instance_id: frame.run_instance_id,
          command_id: "command-001", export_id, captured_at: at, source_updated_at: at, coverage: partialCoverage,
          preview: { content_scope: "assistant_visible_text_preview", source_scope: "last_recorded_branch", primary_text: "not_exported",
            order: "oldest_first", coverage: partialCoverage, text_limit_chars: 4000, messages_total: 2, messages_shown: 1, messages_omitted: 1,
            messages: [{ ordinal: 2, assistant_text: text, text_chars_observed: shown + 9, text_chars_shown: shown,
              text_chars_omitted: 9, preview_clipped: true }] } });
        fs.writeFileSync(join(frame.state_dir, path), body);
        return { export_id, command_id: "command-001", captured_at: at, availability: "available", path,
          media_type: "application/json", bytes_total: Buffer.byteLength(body), mutable: true, coverage: partialCoverage };
      });
      fs.writeFileSync(join(frame.state_dir, runContextExportPath("sessions")), JSON.stringify({ schema: "run-context-sessions-v1",
        run: frame.run, run_instance_id: frame.run_instance_id, updated_at: at, inventory_scope: "published_previews",
        inventory_complete: false, coverage: partialCoverage, previews_total: previews.length, previews }));
    }
    registerRunStateDirectory(catalog, frame.state_dir, metadata);
  }
}
if (input.phase === "priority") {
  const paths = [join(catalog, "index.json"), ...input.frames.flatMap(frame =>
    ["run.json", "result.json", "progress.json", "trace.jsonl", "controls.jsonl", "context-index.json"].map(leaf => join(frame.state_dir, leaf)))];
  manifest.priority_snapshots = paths.map(path => {
    try { return { path, before_base64: fs.readFileSync(path).toString("base64") }; }
    catch (error) { if (error.code !== "ENOENT") throw error; return { path, before_base64: null }; }
  }); persist(); // Controlled fixture baseline, including foreign files; not model exposure or a native/terminal assertion.
}
const before = fs.readFileSync(join(catalog, "index.json"));
assert.equal(JSON.parse(before).entries.every(row => row.status === (input.phase === "published_research" ? "unknown" : "running")), true,
  "Catalog must retain its registration-time status, not current inventory truth");
const model = { id: "session-navigation-fixture", name: "Session navigation fixture", api: "session-navigation-fixture",
  provider: "session-navigation-fixture", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 200000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const scopes = [];
let currentSpec, providerError;
function hasInheritedNavigation(messages) {
  const expected = input.frames.find(frame => frame.run === input.registeredRun);
  return messages.some(message => message?.role === "toolResult" && message.toolName === "inspect" &&
    (Array.isArray(message.content) ? message.content : []).some(block => {
      if (block.type !== "text") return false;
      try { return JSON.parse(block.text).navigation?.items?.some(item => item.directory === expected.state_dir && item.run_instance_id === expected.run_instance_id) === true; }
      catch { return false; }
    }));
}
function launchReference(messages, run) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "toolResult" || !["spawn", "sdk_lifetime_async"].includes(message.toolName)) continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      let value;
      try { value = JSON.parse(block.text).file_navigation; } catch { /* Retain historical full JSON receipts in inherited messages. */ }
      if (!value) {
        const document = parseDocument(block.text, { version: "1.2", schema: "core", uniqueKeys: true });
        if (!document.errors.length) {
          const metadata = document.toJS();
          value = metadata?.file_navigation ?? metadata?.run_files;
        }
      }
      if (!value) {
        // Retain the old saved compact-receipt grammar; never restyle inherited messages.
        const marker = "- run_files:\n  Observed locations; mutable.\n", start = block.text.indexOf(marker);
        if (start < 0) continue;
        const [fence, json, closing] = block.text.slice(start + marker.length).split("\n");
        assert.match(fence, /^  `{3,}text$/u); assert.equal(closing, fence.slice(0, -4));
        assert.ok(json.startsWith("  ")); value = JSON.parse(json.slice(2));
      }
      if (value?.state !== "available" || value.run !== run) continue;
      const frame = input.frames.find(row => row.run === run); assert.ok(frame);
      assert.equal(value.run_instance_id, frame.run_instance_id); assert.equal(value.directory, frame.state_dir);
      const file = value.files.find(file => file.role === "metadata");
      assert.equal(file.state, "present"); assert.equal(typeof file.path, "string");
      return { run, run_instance_id: value.run_instance_id, directory: value.directory, path: file.path,
        launch_tool: message.toolName, launch_tool_call_id: message.toolCallId };
    }
  }
}
function selectPreview(body, scope) {
  const catalog = JSON.parse(body), item = scope.maps[0].items[0], published = scope.spec.published;
  assert.equal(catalog.schema, "run-context-sessions-v1"); assert.equal(catalog.run, item.run); assert.equal(catalog.run_instance_id, item.run_instance_id);
  assert.equal(catalog.inventory_scope, "published_previews"); assert.equal(catalog.inventory_complete, false);
  assert.deepEqual(catalog.coverage, partialCoverage); assert.equal(catalog.previews_total, published ? 1 : 2); assert.equal(catalog.previews.length, catalog.previews_total);
  const id = published ? input.publication.export_id : selectedPreviewId;
  const selected = catalog.previews.find(entry => entry.export_id === id); assert.ok(selected); assert.equal(selected.availability, "available");
  assert.match(id, /^[a-f0-9]{64}$/u); assert.equal(selected.path, `evidence/sessions/session-${id}.json`); assert.equal(selected.media_type, "application/json");
  assert.deepEqual(selected.coverage, partialCoverage); assert.equal(selected.mutable, true);
  assert.ok(Number.isSafeInteger(selected.bytes_total) && selected.bytes_total >= 0 && selected.bytes_total <= 65536);
  let path = item.directory;
  for (const part of selected.path.split("/")) {
    path = join(path, part); const stat = fs.lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false); assert.equal(part.endsWith(".json") ? stat.isFile() : stat.isDirectory(), true);
  }
  if (published) {
    assert.equal(createHash("sha256").update(body).digest("hex"), input.publication.catalog_sha256);
    assert.equal(path, input.publication.preview_path);
  } else assert.equal(fs.existsSync(join(item.directory, "context-index.json")), false);
  scope.sessionCatalogReads++; scope.selectedPreview = selected; scope.previewPath = path;
  if (scope.spec.sourceLoss) {
    assert.equal(published, true);
    const action = { kind: "selected_preview_hold_restore", path, held_path: `${path}.fixture-held`, states: ["hold_planned"] };
    assert.equal(fs.existsSync(action.held_path), false);
    scope.fixtureAction = action; manifest.fixture_actions.push(action); persist();
    fs.renameSync(action.path, action.held_path); // Declared fixture action after catalog selection, never product repair/export.
    action.states.push("held"); persist();
  }
  return { name: "read", arguments: { path } };
}
function verifyPreview(body, scope) {
  const view = JSON.parse(body), item = scope.maps[0].items[0], published = scope.spec.published;
  assert.equal(Buffer.byteLength(body), scope.selectedPreview.bytes_total);
  assert.equal(view.schema, "run-context-session-preview-v1"); assert.equal(view.run, item.run); assert.equal(view.run_instance_id, item.run_instance_id);
  assert.equal(view.export_id, scope.selectedPreview.export_id); assert.equal(view.command_id, scope.selectedPreview.command_id);
  assert.deepEqual(view.coverage, partialCoverage); assert.deepEqual(view.preview.coverage, partialCoverage);
  assert.equal(view.preview.primary_text, "not_exported"); assert.equal(view.preview.content_scope, "assistant_visible_text_preview");
  assert.equal(view.preview.messages_total, published ? 1 : 2); assert.equal(view.preview.messages_shown, 1); assert.equal(view.preview.messages_omitted, published ? 0 : 1);
  assert.equal(view.preview.messages.length, 1);
  const text = published ? "public-session71" : selectedPreviewText, message = view.preview.messages[0];
  assert.equal(message.assistant_text, text); assert.equal(message.ordinal, published ? 1 : 2);
  assert.equal(message.text_chars_shown, Array.from(text).length); assert.equal(message.text_chars_observed, message.text_chars_shown + message.text_chars_omitted);
  assert.equal(message.text_chars_omitted, published ? 0 : 9); assert.equal(message.preview_clipped, !published);
  if (published) assert.equal(createHash("sha256").update(body).digest("hex"), input.publication.preview_sha256);
  scope.previewReads++;
}
const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const spec = { ...currentSpec, owner: currentSpec.owner ?? sessionManager.getSessionId() };
  const switchFrame = spec.switchPhase ? { phase: spec.switchPhase, owner: sessionManager.getSessionId(),
    session_file: sessionManager.getSessionFile(), cwd: sessionManager.getCwd() } : undefined;
  if (switchFrame) { manifest.session_switches.push(switchFrame); persist(); } // Actual replacement input before assertions/services await.
  assert.equal(sessionManager.getSessionId(), spec.owner);
  if (spec.branch && spec.owner !== input.sessions[0]) {
    const copy = { kind: spec.branch, entrypoint: spec.entrypoint === true, session_id: spec.owner, session_file: sessionManager.getSessionFile(),
      parent_session: sessionManager.getHeader()?.parentSession,
      inherited_navigation: hasInheritedNavigation(sessionManager.getBranch().map(entry => entry.type === "message" ? entry.message : undefined)) };
    manifest.session_copies.push(copy); persist(); // Actual SDK-created identity captured before assertions/services await.
    assert.equal(copy.parent_session, input.sessionFile); assert.equal(copy.inherited_navigation, true);
  }
  const mappedRuns = spec.mapRuns ?? spec.allowed;
  const inventoryStatus = spec.inventoryStatus ?? (spec.allowed[0] === "foreign" ? "failed" : "done");
  const scope = { spec, switchFrame, calls: 0, contexts: [], errors: [], maps: [], reads: 0, captureReads: 0, captures: [], sessionCatalogReads: 0, previewReads: 0, previewFailures: 0, toolReads: [], actorReads: [], actorSelection: undefined, launchMetadataEvents: [], launchMetadataReads: 0 };
  scopes.push(scope);
  const services = await createAgentSessionServices({ cwd, agentDir: input.agentDir,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: spec.entrypoint ? [input.entrypointPath] : [],
      additionalSkillPaths: [actorsSkill], noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
          streamSimple: (_model, context) => {
            const result = (async () => {
              scope.calls++;
              assert.ok(scope.calls <= (spec.launchReference ? 7 : 6), "Navigation provider must terminate");
              const step = scope.calls - (spec.launchReference && scope.calls >= 3 ? 1 : 0);
              assert.doesNotMatch(JSON.stringify(context.messages), /CONTROLLED_UNSELECTED_PREVIEW_BODY/);
              const latest = [...context.messages].reverse().find(message => message.role === "toolResult");
              if (!(spec.sourceLoss && scope.calls === 5)) assert.notEqual(latest?.isError, true, JSON.stringify(latest));
              let call;
              if (step === 1) {
                if (spec.switchPhase) {
                  switchFrame.model_had_original_map = hasInheritedNavigation(context.messages); persist();
                  assert.equal(switchFrame.model_had_original_map, spec.switchPhase !== "B", "Live switching must restore each saved session's own model history");
                }
                if (spec.sourceLoss) {
                  scope.priorPreviewInHistory = context.messages.some(message => message.role === "toolResult" && message.toolName === "read" && !message.isError &&
                    message.content.some(block => {
                      if (block.type !== "text") return false;
                      try { const view = JSON.parse(block.text); return view.schema === "run-context-session-preview-v1" && view.export_id === input.publication.export_id &&
                        view.preview.messages[0].assistant_text === "public-session71"; } catch { return false; }
                    }));
                  assert.equal(scope.priorPreviewInHistory, true, "Accepted history remains data, not a fresh successful file read");
                }
                if (spec.branch) {
                  scope.inheritedContext = hasInheritedNavigation(context.messages);
                  assert.equal(scope.inheritedContext, true, "Fork/clone model history must preserve the earlier accepted map as data");
                }
                call = { name: "read", arguments: { path: actorsSkill } };
              } else if (step === 2) {
                assert.equal(latest.toolName, "read");
                if (scope.calls === 2) assert.match(JSON.stringify(latest.content), /inspect target=runtime view=runs verbose=true/);
                if (spec.launchReference && scope.calls === 3) {
                  const body = latest.content.filter(block => block.type === "text").map(block => block.text).join("\n"), meta = JSON.parse(body);
                  assert.equal(meta.run, scope.launchSelection.run); assert.equal(meta.run_instance_id, scope.launchSelection.run_instance_id);
                  assert.equal(meta.ownerId, spec.owner); assert.equal(meta.state_dir, scope.launchSelection.directory);
                  assert.deepEqual(scope.launchMetadataEvents, [{ path: scope.launchSelection.path, offset: 1, limit: 2000 }]);
                  scope.launchSelection.parsed_json_sha256 = createHash("sha256").update(JSON.stringify(meta)).digest("hex");
                  scope.launchSelection.actual_read = scope.launchMetadataEvents[0]; scope.launchMetadataReads++;
                }
                if (input.phase === "genuine_research") {
                  const legacyRequest = context.messages.some(message => message.role === "toolResult" && ["spawn", "sdk_lifetime_async"].includes(message.toolName) &&
                    message.content.some(block => block.type === "text" && /Files \(optional; current session\):\n`inspect target=runtime view=runs verbose=true`/.test(block.text)));
                  const historicalReference = launchReference(context.messages, spec.actorSession ? input.actorSession.run : input.entrypointRun);
                  scope.launchHandoff = legacyRequest || Boolean(historicalReference);
                  assert.equal(scope.launchHandoff, Boolean(spec.genuine || spec.branch), "Saved/copy request or exact direct reference is data; unrelated saved sessions must not borrow it");
                  if (spec.branch) {
                    scope.inheritedLaunchLocations = Boolean(launchReference(context.messages, input.entrypointRun));
                    assert.equal(scope.inheritedLaunchLocations, true, "Copied launch locations remain history, not new-session selection");
                  }
                }
                if (spec.launchReference && scope.calls === 2) {
                  assert.equal(scope.maps.length, 0, "Select the receipt location before this journey obtains any fresh map");
                  scope.launchSelection = launchReference(context.messages, spec.launchReference);
                  assert.ok(scope.launchSelection, "The actual saved launch must contain usable locations; no map/path fallback");
                  assert.equal(input.frames.find(row => row.run === scope.launchSelection.run).ownerId, spec.owner);
                  scope.launchSelection.owner = sessionManager.getSessionId(); scope.launchSelection.session_file = sessionManager.getSessionFile();
                  call = { name: "read", arguments: { path: scope.launchSelection.path, offset: 1, limit: 2000 } };
                } else call = { name: "inspect", arguments: { target: "runtime", view: "runs", verbose: true,
                  status: inventoryStatus } };
              } else if (step === 3) {
                assert.equal(latest.toolName, "inspect");
                const content = latest.content.filter(block => block.type === "text").map(block => block.text).join("\n");
                const reply = JSON.parse(content.trim());
                if (spec.controlledPriority) {
                  manifest.priority_maps.push({ owner: reply.owner_session, inventory: reply.runs.map(run => ({ run: run.run, status: run.status })), navigation: reply.navigation }); persist();
                }
                assert.equal(reply.owner_session, spec.owner);
                assert.deepEqual(reply.runs.map(run => run.run).sort(), [...spec.allowed].sort());
                if (inventoryStatus === "all") {
                  for (const run of reply.runs) assert.equal(run.status, ["foreign", "failed-grandchild", "budget-failed-grandchild"].includes(run.run) ? "failed" : "done");
                } else assert.equal(reply.runs.every(run => run.status === inventoryStatus), true);
                scope.maps.push(reply.navigation);
                if (spec.broken) {
                  assert.deepEqual(reply.navigation, { state: "unavailable", reason: "catalog_unavailable" });
                  assert.equal(fs.readFileSync(join(catalog, "index.json"), "utf8"), "{broken");
                } else {
                  assert.equal(reply.navigation.state, "available");
                  assert.equal(reply.navigation.session_id, spec.owner);
                  assert.equal(reply.navigation.content_scope, "file_locations_only");
                  assert.equal(reply.navigation.file_inventory_scope, "canonical_starting_locations");
                  assert.deepEqual(reply.navigation.priority, { root_order: inventoryStatus === "failed" ? "failed_subtrees_first" : "latest_registration", basis: "observed_failed_rows" });
                  assert.equal(reply.navigation.total, mappedRuns.length); assert.equal(reply.navigation.shown, reply.navigation.items.length);
                  assert.equal(reply.navigation.omitted, mappedRuns.length - reply.navigation.shown);
                  if (spec.boundedMap) {
                    assert.ok(reply.navigation.shown > 0 && reply.navigation.omitted > 0);
                    assert.ok(Buffer.byteLength(JSON.stringify(reply.navigation)) <= 16384);
                  } else assert.equal(reply.navigation.omitted, 0);
                  assert.deepEqual(reply.navigation.items.map(item => item.run), mappedRuns.slice(0, reply.navigation.shown));
                  if (spec.depths) assert.deepEqual(reply.navigation.items.map(item => item.depth), spec.depths.slice(0, reply.navigation.shown));
                  assert.doesNotMatch(JSON.stringify(reply.navigation), /CONTROLLED_.*_REPORT|CONTROLLED_.*PREVIEW|previews_total|finite SDK lifetime fixture|finite SDK entrypoint launch fixture|finite SDK failure stderr|FAILED_STDOUT_NOT_SELECTED|COMPOSITION_STDOUT_NOT_SELECTED|finite SDK composition|public-session71/);
                  for (const row of input.frames.filter(row => row.ownerId !== spec.owner)) assert.ok(!content.includes(row.state_dir), "Foreign directory reached model");
                  for (const item of reply.navigation.items) {
                    const frame = input.frames.find(frame => frame.run === item.run);
                    assert.equal(item.run_instance_id, frame.run_instance_id); assert.equal(item.directory, frame.state_dir);
                    for (const file of item.files) assert.ok(["json", "jsonl", "text"].includes(file.format_hint));
                  }
                  if (mappedRuns.length) {
                    const item = spec.selectRun ? reply.navigation.items.find(item => item.run === spec.selectRun) : reply.navigation.items[0];
                    assert.ok(item); scope.selectedItem = item;
                    if (spec.published) assert.equal(item.files.find(file => file.role === "result").state, "missing");
                    const file = item.files.find(file => file.role === (spec.published ? "published_sessions" : "result"));
                    assert.equal(file.state, "present"); assert.equal(typeof file.path, "string");
                    call = { name: "read", arguments: { path: file.path } };
                  } else {
                    assert.equal(reply.navigation.total, 0); assert.equal(reply.navigation.shown, 0); assert.equal(reply.navigation.omitted, 0);
                  }
                }
              } else if (step === 4 && spec.published) {
                assert.equal(latest.toolName, "read");
                call = selectPreview(latest.content.filter(block => block.type === "text").map(block => block.text).join("\n"), scope);
              } else if (step === 5 && spec.published) {
                assert.equal(latest.toolName, "read");
                const body = latest.content.filter(block => block.type === "text").map(block => block.text).join("\n");
                if (spec.sourceLoss) {
                  assert.equal(latest.isError, true); assert.match(body, /ENOENT|no such file|does not exist/i); assert.doesNotMatch(body, /public-session71/);
                  assert.equal(fs.existsSync(scope.previewPath), false, "The failed ordinary read must not repair/export its source");
                  scope.previewFailures++;
                } else verifyPreview(body, scope);
              } else if (step === 4) {
                assert.equal(latest.toolName, "read");
                if (spec.genuine) {
                  const body = latest.content.filter(block => block.type === "text").map(block => block.text).join("\n");
                  const result = JSON.parse(body);
                  assert.equal(result.code, spec.expectedCode ?? 0); assert.equal(result.terminal_acceptance, "natural"); scope.rootCode = result.code;
                  assert.equal(result.run_instance_id, scope.selectedItem.run_instance_id);
                  if (spec.expectedFailureReason) {
                    assert.equal(result.failure_reason, spec.expectedFailureReason);
                    assert.deepEqual(result.soft_quorum, { coverage: 0, degraded: true, done: 0, expected: 2, failed: 2, usable: false });
                    scope.failureReason = result.failure_reason;
                  }
                  const execution = scope.selectedItem.files.find(file => file.role === "execution");
                  assert.equal(execution.state, "present"); assert.equal(execution.format_hint, "json");
                  call = { name: "read", arguments: { path: execution.path } };
                } else {
                  assert.match(JSON.stringify(latest.content), new RegExp(`CONTROLLED_${scope.selectedItem.run}_REPORT`));
                  if (spec.controlledPriority) {
                    const value = JSON.parse(latest.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
                    assert.equal(value.code, spec.expectedCode ?? 0); assert.equal(value.run_instance_id, scope.selectedItem.run_instance_id);
                    assert.equal(Object.hasOwn(value, "terminal_acceptance"), false, "Controlled legacy layout is not a genuine accepted natural result");
                  }
                }
                scope.reads++;
                if (!spec.genuine) {
                  const sessions = scope.maps[0].items[0].files.find(file => file.role === "published_sessions");
                  assert.ok(sessions); assert.equal(sessions.format_hint, "json");
                  if (sessions.state === "present") call = { name: "read", arguments: { path: sessions.path } };
                }
              } else if (step === 5 && !spec.genuine) {
                assert.equal(latest.toolName, "read");
                const body = latest.content.filter(block => block.type === "text").map(block => block.text).join("\n");
                call = selectPreview(body, scope);
              } else if (step === 5) {
                assert.equal(spec.genuine, true); assert.equal(latest.toolName, "read");
                const execution = JSON.parse(latest.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
                const item = scope.selectedItem;
                assert.equal(execution.version, 1); assert.equal(execution.run, item.run); assert.equal(execution.run_instance_id, item.run_instance_id);
                const commandCodes = spec.commandCodes ?? [spec.attemptCodes ?? [spec.expectedCode ?? 0]], commandOrdinal = spec.captureCommand ?? 1;
                assert.equal(execution.commands.length, commandCodes.length); assert.equal(new Set(execution.commands.map(command => command.id)).size, commandCodes.length);
                execution.commands.forEach((command, index) => {
                  assert.match(command.id, /^command-[0-9]{3,}$/u);
                  assert.deepEqual(command.attempts.map(attempt => attempt.code), commandCodes[index]);
                  assert.deepEqual(command.attempts.map(attempt => attempt.native_exit_code), commandCodes[index]);
                });
                const command = execution.commands[commandOrdinal - 1], ordinal = spec.captureAttempt ?? 1;
                if (spec.actorSession) {
                  const selected = input.actorSession;
                  assert.equal(item.run, selected.run); assert.equal(command.id, selected.command_id);
                  assert.deepEqual(command.session_files, [selected.path]); assert.equal(command.session_dir, `sessions/${command.id}`);
                  assert.equal(selected.path.startsWith(command.session_dir + "/"), true);
                  let path = item.directory;
                  for (const part of selected.path.split("/")) {
                    assert.ok(part && part !== "." && part !== ".."); path = join(path, part);
                    const stat = fs.lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
                    assert.equal(part.endsWith(".jsonl") ? stat.isFile() : stat.isDirectory(), true);
                  }
                  scope.actorSelection = { path, offset: selected.assistant_line, limit: 1 };
                  call = { name: "read", arguments: scope.actorSelection };
                } else {
                  const attempt = command.attempts[ordinal - 1], stream = spec.captureStream ?? "stdout";
                  assert.equal(attempt.attempt, ordinal); assert.equal(attempt.code, commandCodes[commandOrdinal - 1][ordinal - 1]);
                  assert.ok(["stdout", "stderr"].includes(stream));
                  const relative = `captures/${command.id}/attempt-${String(ordinal).padStart(3, "0")}/${stream}.log`;
                  assert.equal(attempt[stream].path, relative); assert.ok(Number.isSafeInteger(attempt[stream].bytes) && attempt[stream].bytes >= 0);
                  let path = item.directory;
                  for (const part of relative.split("/")) {
                    path = join(path, part); const stat = fs.lstatSync(path);
                    assert.equal(stat.isSymbolicLink(), false); assert.equal(part === `${stream}.log` ? stat.isFile() : stat.isDirectory(), true);
                  }
                  scope.captures.push({ path, reported_bytes: attempt[stream].bytes, stream, run: item.run, command: commandOrdinal, command_id: command.id, attempt: ordinal, code: attempt.code, root_code: scope.rootCode });
                  call = { name: "read", arguments: { path } };
                }
              } else {
                assert.equal(step, 6); assert.equal(latest.toolName, "read");
                const body = latest.content.filter(block => block.type === "text").map(block => block.text).join("\n");
                if (spec.actorSession) {
                  const line = body.split("\n")[0], record = JSON.parse(line);
                  assert.equal(createHash("sha256").update(line).digest("hex"), input.actorSession.assistant_sha256);
                  assert.equal(record.type, "message"); assert.equal(record.id, input.actorSession.assistant_entry_id);
                  assert.equal(record.message.role, "assistant"); assert.deepEqual(record.message.content, [{ type: "text", text: "FINITE_GENUINE_ACTOR_SESSION 😀" }]);
                  assert.deepEqual(scope.actorReads, [scope.actorSelection], "Actual bounded SDK read must match the selected recorded session line");
                } else if (spec.genuine) {
                  assert.equal(body, spec.captureText ?? (spec.captureStream === "stderr" ? "finite SDK failure stderr 😀" : "finite SDK lifetime fixture"));
                  assert.equal(Buffer.byteLength(body), scope.captures[0].reported_bytes);
                  scope.captureReads++;
                } else {
                  verifyPreview(body, scope);
                }
              }
              return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: call ? [{ type: "toolCall", id: `navigation-${input.phase}-${scopes.length}-${scope.calls}`, ...call }] : [{ type: "text", text: "Owned navigation observed" }],
                stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            })().catch(error => { providerError ??= error; throw error; });
            return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: "done", reason: message.stopReason, message }; }, result: () => result };
          } });
        if (spec.entrypoint) {
          // Observe SDK lifecycle only; the actual entrypoint owns its original handlers and tool definitions.
          pi.on("session_start", (_event, ctx) => {
            scope.startedContext = ctx; scope.startedManager = ctx.sessionManager;
            scope.entrypointWitness.startup = { owner: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(),
              manager_matches: ctx.sessionManager === sessionManager }; persist();
          });
          pi.on("session_shutdown", (event, ctx) => {
            scope.entrypointWitness.shutdowns.push({ reason: event.reason, owner: ctx.sessionManager.getSessionId(),
              manager_matches: ctx.sessionManager === scope.startedManager }); persist();
          });
        }
        if (!spec.entrypoint) {
          const tool = createInspectToolDefinition();
          pi.registerTool({ ...tool, execute: (...args) => {
            const ctx = args[4]; scope.contexts.push(ctx.sessionManager.getSessionId());
            assert.equal(ctx.sessionManager.getSessionId(), spec.owner);
            return tool.execute(...args);
          } });
        }
      }] } });
  if (spec.entrypoint) {
    const loaded = services.resourceLoader.getExtensions(), entry = loaded.extensions.find(extension => extension.path === input.entrypointPath);
    const witness = { owner: sessionManager.getSessionId(), session_file: sessionManager.getSessionFile(), loaded_path: entry?.path ?? null,
      resolved_path: entry?.resolvedPath ?? null, registered_tools: entry ? [...entry.tools.keys()].sort() : [],
      handlers: entry ? [...entry.handlers.keys()].sort() : [],
      other_inspect_providers: loaded.extensions.filter(extension => extension !== entry && extension.tools.has("inspect")).map(extension => extension.path), shutdowns: [] };
    scope.entrypointWitness = witness;
    manifest.entrypoint_journeys.push(witness); persist(); // SDK-observed loaded metadata, not merely the input path/intent.
    assert.deepEqual(loaded.errors, []); assert.ok(entry); assert.deepEqual(witness.other_inspect_providers, []);
    assert.ok(entry.tools.has("inspect"));
    for (const event of ["session_start", "session_shutdown", "before_agent_start", "context", "turn_end", "agent_settled"]) assert.ok(entry.handlers.has(event));
  }
  assert.ok(services.resourceLoader.getSkills().skills.some(skill => skill.filePath === actorsSkill), "The operating Skill must be active");
  const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
  return { ...created, services, diagnostics: services.diagnostics };
};
async function research(runtime, scope, spec) {
  const unlisten = runtime.session.subscribe(event => {
      if (event.type === "tool_execution_start" && event.toolName === "read") {
        scope.toolReads.push(event.args?.path);
        if (spec.launchReference && event.args?.path === scope.launchSelection?.path) scope.launchMetadataEvents.push(structuredClone(event.args));
        if (spec.actorSession && event.args?.path === scope.actorSelection?.path) scope.actorReads.push(structuredClone(event.args));
      }
    });
  try {
    runtime.session.setActiveToolsByName(["inspect", "read"]);
    await runtime.session.prompt("Inspect the owned Run file map, read its first result, then selectively read a recorded command capture when available.");
    if (providerError) throw providerError;
    assert.deepEqual(scope.errors, []); assert.deepEqual(scope.contexts, spec.entrypoint ? [] : [scope.spec.owner]);
    const hasRows = !spec.broken && (spec.mapRuns ?? spec.allowed).length > 0;
    const hasResult = hasRows && !spec.published;
    const hasSessions = hasRows && !spec.genuine && scope.maps[0].items[0].files.find(file => file.role === "published_sessions").state === "present";
    assert.equal(scope.calls, (hasRows ? spec.published ? 5 : spec.genuine || hasSessions ? 6 : 4 : 3) + (spec.launchReference ? 1 : 0));
    assert.equal(scope.launchMetadataReads, spec.launchReference ? 1 : 0); assert.equal(scope.reads, hasResult ? 1 : 0);
    assert.equal(scope.captureReads, spec.genuine && !spec.actorSession ? 1 : 0); assert.equal(scope.sessionCatalogReads, hasSessions ? 1 : 0);
    assert.equal(scope.previewReads, hasSessions && !spec.sourceLoss ? 1 : 0); assert.equal(scope.previewFailures, spec.sourceLoss ? 1 : 0);
    const files = hasRows ? scope.selectedItem.files : [];
    const expectedReads = [actorsSkill, ...(spec.launchReference ? [scope.launchSelection.path] : []), ...(hasResult ? [files.find(file => file.role === "result").path] : []),
      ...(spec.genuine ? [files.find(file => file.role === "execution").path, spec.actorSession ? scope.actorSelection.path : scope.captures[0].path] : []),
      ...(hasSessions ? [files.find(file => file.role === "published_sessions").path, scope.previewPath] : [])];
    assert.deepEqual(scope.toolReads, expectedReads, "Actual SDK reads must stay selective, without raw/unselected session reads");
    if (spec.sourceLoss) {
      const action = scope.fixtureAction;
      assert.equal(fs.existsSync(action.path), false);
      assert.equal(createHash("sha256").update(fs.readFileSync(action.held_path)).digest("hex"), input.publication.preview_sha256);
      action.states.push("restore_planned"); persist();
      fs.renameSync(action.held_path, action.path); // Explicit fixture restoration only after the expected read failure and exact ledger are verified.
      action.states.push("restored"); persist();
    }
    return runtime.session.sessionFile;
  } finally { unlisten(); }
}
async function journey(spec, manager) {
  if (spec.branch === "fork") manager.appendMessage({ role: "user", content: "Fork after accepted navigation history.", timestamp: Date.now() });
  currentSpec = spec;
  const runtime = await createAgentSessionRuntime(factory, { cwd: input.agentDir, agentDir: input.agentDir, sessionManager: manager });
  let scope = scopes.at(-1);
  let primary;
  try {
    const initial = scope;
    await runtime.session.bindExtensions({ onError: error => initial.errors.push(error.error) });
    if (spec.branch) {
      const entryId = runtime.session.sessionManager.getLeafId(); assert.ok(entryId);
      if (spec.entrypoint) assert.equal(initial.startedManager, runtime.session.sessionManager);
      // These are the SDK operations behind /fork and /clone, not a manually copied DTO/file header.
      const changed = spec.branch === "clone" ? await runtime.fork(entryId, { position: "at" }) : await runtime.fork(entryId);
      assert.equal(changed.cancelled, false);
      scope = scopes.at(-1); assert.notEqual(scope, initial);
      assert.notEqual(scope.spec.owner, input.sessions[0]); assert.notEqual(scope.spec.owner, input.sessions[1]);
      assert.notEqual(runtime.session.sessionFile, input.sessionFile);
      assert.equal(initial.calls, 0); assert.deepEqual(initial.contexts, []); assert.deepEqual(initial.errors, []);
      const selected = scope;
      await runtime.session.bindExtensions({ onError: error => selected.errors.push(error.error) });
      if (spec.entrypoint) {
        assert.throws(() => initial.startedContext.sessionManager, /stale/);
        assert.notEqual(scope.startedManager, initial.startedManager); assert.equal(scope.startedManager.getSessionId(), scope.spec.owner);
        assert.deepEqual(initial.entrypointWitness.shutdowns, [{ reason: "fork", owner: input.sessions[0], manager_matches: true }]);
        const copy = manifest.session_copies.find(copy => copy.session_id === scope.spec.owner);
        copy.previous_context_stale = true; copy.previous_shutdown = initial.entrypointWitness.shutdowns[0]; persist();
      }
    }
    return await research(runtime, scope, spec);
  } catch (error) { primary = providerError ?? error; throw primary; }
  finally {
    try { await runtime.dispose(); assert.deepEqual(scope.errors, [], "SDK teardown must not hide captured extension errors"); }
    catch (error) { throw primary ? new AggregateError([primary, error], "Navigation SDK teardown failed") : error; }
  }
}
async function liveSwitchResearch(aSpec, foreignFile) {
  const phases = [{ spec: { ...aSpec, switchPhase: "A1" }, file: input.sessionFile },
    { spec: { owner: input.sessions[1], allowed: [], mapRuns: [], entrypoint: true, switchPhase: "B" }, file: foreignFile },
    { spec: { ...aSpec, switchPhase: "A2" }, file: input.sessionFile }];
  currentSpec = phases[0].spec;
  const runtime = await createAgentSessionRuntime(factory, { cwd: input.agentDir, agentDir: input.agentDir, sessionManager: SessionManager.open(phases[0].file) });
  let scope = scopes.at(-1), primary, originalManager, originalContext;
  const observed = [];
  try {
    for (let index = 0; index < phases.length; index++) {
      const previous = scope;
      if (index > 0) {
        currentSpec = phases[index].spec;
        const changed = await runtime.switchSession(phases[index].file);
        scope = scopes.at(-1); assert.equal(changed.cancelled, false); assert.notEqual(scope, previous);
      }
      const selected = scope; observed.push(selected);
      await runtime.session.bindExtensions({ onError: error => selected.errors.push(error.error) });
      assert.equal(scope.startedManager, runtime.session.sessionManager); assert.equal(runtime.session.sessionFile, phases[index].file);
      if (index === 0) { originalManager = scope.startedManager; originalContext = scope.startedContext; }
      else {
        assert.throws(() => previous.startedContext.sessionManager, /stale/); assert.notEqual(scope.startedManager, previous.startedManager);
        assert.deepEqual(previous.errors, []);
        assert.deepEqual(previous.entrypointWitness.shutdowns, [{ reason: "resume", owner: previous.spec.owner, manager_matches: true }]);
        scope.switchFrame.previous_owner = previous.spec.owner; scope.switchFrame.previous_context_stale = true;
        scope.switchFrame.previous_shutdown = previous.entrypointWitness.shutdowns[0]; persist();
        if (index === 2) {
          assert.notEqual(scope.startedManager, originalManager); assert.throws(() => originalContext.sessionManager, /stale/);
          scope.switchFrame.original_context_still_stale = true; persist();
        }
      }
      await research(runtime, scope, scope.spec);
      assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
    }
  } catch (error) { primary = providerError ?? error; throw primary; }
  finally {
    try { await runtime.dispose(); for (const selected of observed) assert.deepEqual(selected.errors, [], "Live replacement teardown hid an extension error"); }
    catch (error) { throw primary ? new AggregateError([primary, error], "Live SDK switch teardown failed") : error; }
  }
}
let sessionFile;
if (input.phase === "initial") {
  const manager = SessionManager.create(input.agentDir, join(input.agentDir, "sessions"), { id: input.sessions[0] });
  assert.equal(manager.getSessionId(), input.sessions[0]);
  sessionFile = await journey({ owner: input.sessions[0], allowed: ["parent", "child"] }, manager);
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
} else if (input.phase === "priority") {
  const manager = SessionManager.create(input.agentDir, join(input.agentDir, "sessions"), { id: input.sessions[0] });
  sessionFile = await journey({ owner: input.sessions[0], allowed: ["parent", "child", "failed-grandchild", "healthy", "latest"], inventoryStatus: "all",
    mapRuns: ["latest", "parent", "child", "failed-grandchild", "healthy"], depths: [0, 0, 1, 2, 1], selectRun: "latest", entrypoint: true, controlledPriority: true }, manager);
  await journey({ owner: input.sessions[0], allowed: ["failed-grandchild"], inventoryStatus: "failed",
    mapRuns: ["parent", "child", "failed-grandchild", "healthy", "latest"], depths: [0, 1, 2, 1, 0], selectRun: "failed-grandchild", expectedCode: 7,
    entrypoint: true, controlledPriority: true }, SessionManager.open(sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  const budgetRoots = Array.from({ length: 16 }, (_, i) => `budget-latest-${String(16 - i).padStart(2, "0")}`);
  const budgetTree = ["budget-parent", "budget-child", "budget-failed-grandchild", "budget-healthy"];
  const budgetRuns = [...budgetRoots, ...budgetTree], budgetOwner = input.sessions[2];
  const budgetFile = await journey({ owner: budgetOwner, allowed: budgetRuns, inventoryStatus: "all", mapRuns: budgetRuns,
    depths: [...budgetRoots.map(() => 0), 0, 1, 2, 1], selectRun: budgetRoots[0], entrypoint: true, controlledPriority: true, boundedMap: true },
    SessionManager.create(input.agentDir, join(input.agentDir, "sessions"), { id: budgetOwner }));
  await journey({ owner: budgetOwner, allowed: ["budget-failed-grandchild"], inventoryStatus: "failed", mapRuns: [...budgetTree, ...budgetRoots],
    depths: [0, 1, 2, 1, ...budgetRoots.map(() => 0)], selectRun: "budget-failed-grandchild", expectedCode: 7,
    entrypoint: true, controlledPriority: true, boundedMap: true }, SessionManager.open(budgetFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  for (const snapshot of manifest.priority_snapshots) {
    let after = null;
    try { after = fs.readFileSync(snapshot.path).toString("base64"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.equal(after, snapshot.before_base64, `Controlled priority changed selected bytes/absence: ${snapshot.path}`);
  }
} else if (input.phase === "published_research") {
  const resumed = SessionManager.open(input.sessionFile); assert.equal(resumed.getSessionId(), input.sessions[0]);
  assert.equal(fs.existsSync(join(input.frames[0].state_dir, "result.json")), false);
  sessionFile = await journey({ owner: input.sessions[0], allowed: [input.frames[0].run], published: true, inventoryStatus: "exited" }, resumed);
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: [input.frames[0].run], published: true, inventoryStatus: "exited", sourceLoss: true }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[1], allowed: [], published: true, inventoryStatus: "exited" },
    SessionManager.create(input.agentDir, join(input.agentDir, "sessions"), { id: input.sessions[1] }));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
} else if (input.phase === "genuine_research") {
  const resumed = SessionManager.open(input.sessionFile);
  assert.equal(resumed.getSessionId(), input.sessions[0]);
  const failedRuns = [input.failedRun, input.unusableRun];
  const successfulRuns = input.frames.filter(frame => frame.ownerId === input.sessions[0] && !failedRuns.includes(frame.run)).map(frame => frame.run), mapRuns = [input.unusableRun, input.degradedRun, input.parallelRun, input.entrypointRun, input.compositionRun, input.retryRun, input.failedRun, input.registeredRun];
  const failedMapRuns = [...mapRuns.filter(run => failedRuns.includes(run)), ...mapRuns.filter(run => !failedRuns.includes(run))];
  sessionFile = await journey({ owner: input.sessions[0], allowed: successfulRuns,
    mapRuns, selectRun: input.registeredRun, genuine: true }, resumed);
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: failedRuns, inventoryStatus: "failed", mapRuns: failedMapRuns,
    selectRun: input.failedRun, expectedCode: 7, captureStream: "stderr", genuine: true }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.retryRun, genuine: true,
    attemptCodes: [7, 0], captureAttempt: 1, captureStream: "stderr", captureText: "finite SDK retry first stderr 😀" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.compositionRun, genuine: true,
    commandCodes: [[0], [0]], captureCommand: 2, captureStream: "stderr", captureText: "finite SDK composition second stderr 😀" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  const foreign = SessionManager.create(input.agentDir, join(input.agentDir, "sessions"), { id: input.sessions[1] });
  const foreignFile = await journey({ owner: input.sessions[1], allowed: [], mapRuns: [] }, foreign);
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  for (const branch of ["fork", "clone"]) {
    await journey({ branch, allowed: [], mapRuns: [] }, SessionManager.open(input.sessionFile));
    assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  }
  await journey({ owner: input.sessions[0], allowed: successfulRuns,
    mapRuns, selectRun: input.registeredRun, genuine: true }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.compositionRun, genuine: true, entrypoint: true,
    commandCodes: [[0], [0]], captureCommand: 2, captureStream: "stderr", captureText: "finite SDK composition second stderr 😀", launchReference: "sdk-lifetime-async" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.entrypointRun, genuine: true, entrypoint: true,
    captureText: "finite SDK entrypoint launch fixture", launchReference: input.entrypointRun }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[1], allowed: [], mapRuns: [], entrypoint: true }, SessionManager.open(foreignFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  for (const branch of ["fork", "clone"]) {
    await journey({ branch, allowed: [], mapRuns: [], entrypoint: true }, SessionManager.open(input.sessionFile));
    assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  }
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.entrypointRun, genuine: true, entrypoint: true,
    captureText: "finite SDK entrypoint launch fixture" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await liveSwitchResearch({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.entrypointRun, genuine: true, entrypoint: true,
    captureText: "finite SDK entrypoint launch fixture" }, foreignFile);
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.parallelRun, genuine: true, entrypoint: true,
    commandCodes: [[0], [0]], captureCommand: 2, captureStream: "stderr", captureText: "finite SDK parallel second stderr 😀" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: successfulRuns, mapRuns, selectRun: input.degradedRun, genuine: true, entrypoint: true,
    commandCodes: [[7], [0]], captureCommand: 1, captureStream: "stderr", captureText: "finite SDK degraded branch stderr 😀" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.sessions[0], allowed: failedRuns, inventoryStatus: "failed", mapRuns: failedMapRuns, selectRun: input.unusableRun, genuine: true, entrypoint: true,
    expectedCode: 7, expectedFailureReason: "all_branches_unusable", commandCodes: [[7], [7]], captureCommand: 2, captureStream: "stderr",
    captureText: "finite SDK degraded branch stderr 😀" }, SessionManager.open(input.sessionFile));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  await journey({ owner: input.actorSession.owner, allowed: [input.actorSession.run], mapRuns: [input.actorSession.run], selectRun: input.actorSession.run,
    genuine: true, entrypoint: true, actorSession: true }, SessionManager.open(input.actorSession.coordinator_file));
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
} else {
  const resumed = SessionManager.open(input.sessionFile);
  assert.equal(resumed.getSessionId(), input.sessions[0]);
  sessionFile = await journey({ owner: input.sessions[0], allowed: ["parent", "child"] }, resumed);
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  const foreign = SessionManager.create(input.agentDir, join(input.agentDir, "sessions"), { id: input.sessions[1] });
  await journey({ owner: input.sessions[1], allowed: ["foreign"] }, foreign);
  assert.deepEqual(fs.readFileSync(join(catalog, "index.json")), before);
  fs.writeFileSync(join(catalog, "index.json"), "{broken"); // Explicit fixture edit, not product repair.
  await journey({ owner: input.sessions[0], allowed: ["parent", "child"], broken: true }, SessionManager.open(input.sessionFile));
}
manifest.complete = true;
persist();
console.log(JSON.stringify({ layout: input.layout, phase: input.phase, pid: process.pid, sessionFile,
  composition: input.phase === "genuine_research" ? "genuine_producer_history" : input.phase === "published_research" ? "genuine_private_published_history" : "controlled_metadata",
  workloads: 0, originalProducerKeys: 0, controlledDirectories: input.frames.length, sdkJourneys: scopes.filter(scope => scope.calls > 0).length,
  ordinaryReads: scopes.reduce((total, scope) => total + scope.reads, 0),
  navigationHandoffJourneys: scopes.filter(scope => scope.launchHandoff === true).length,
  copiedNavigationHandoffIsolated: input.phase === "genuine_research" && scopes.filter(scope => scope.spec.branch && scope.calls > 0).every(scope => scope.launchHandoff && scope.maps[0].total === 0),
  selectedLaunchMetadataReads: scopes.filter(scope => scope.launchMetadataReads === 1).map(scope => scope.launchSelection),
  copiedLaunchLocationsIsolated: input.phase === "genuine_research" && scopes.filter(scope => scope.spec.branch && scope.calls > 0)
    .every(scope => scope.inheritedLaunchLocations && scope.launchMetadataReads === 0 && scope.maps[0].total === 0),
  selectedActorSessionReads: scopes.flatMap(scope => scope.actorReads),
  selectedCaptureReads: scopes.reduce((total, scope) => total + scope.captureReads, 0), selectedCaptures: scopes.flatMap(scope => scope.captures),
  publishedSessionCatalogReads: scopes.reduce((total, scope) => total + scope.sessionCatalogReads, 0),
  selectedSessionPreviewReads: scopes.reduce((total, scope) => total + scope.previewReads, 0),
  selectedSessionPreviewReadFailures: scopes.reduce((total, scope) => total + scope.previewFailures, 0),
  sourceLossHistoryPreserved: scopes.some(scope => scope.spec.sourceLoss && scope.priorPreviewInHistory), fixtureActions: manifest.fixture_actions ?? [],
  unselectedSessionPreviewReads: scopes.flatMap(scope => scope.toolReads).filter(path => String(path).includes(`session-${unselectedPreviewId}.json`)).length,
  recordedReadPathsOnly: true, readLedger: scopes.filter(scope => scope.calls > 0).map(scope => ({ owner: scope.spec.owner, paths: scope.toolReads })),
  previewFixture: input.phase === "genuine_research" ? "not_applicable" : input.phase === "published_research" ? "genuine_private_publication_controlled_recorded_source" : "controlled_layout_not_publication",
  genuinePublishedPreviewRead: input.phase === "published_research" && scopes.some(scope => scope.spec.published && scope.previewReads === 1),
  realSessionContext: true, rootFirst: true,
  mapReadOnly: true, foreignBranchExcluded: true, missingProducerKeyNotRequired: true, activeSkillRead: true, freshInventoryStatus: true,
  genuineResultRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.genuine && scope.reads === 1),
  genuineFailureRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.expectedCode === 7 && scope.spec.captureStream === "stderr" && scope.reads === 1 && scope.captureReads === 1),
  genuineRetryRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.selectRun === input.retryRun && scope.rootCode === 0 &&
    scope.captures[0]?.attempt === 1 && scope.captures[0]?.code === 7 && scope.captureReads === 1),
  genuineCompositionRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.selectRun === input.compositionRun && scope.rootCode === 0 &&
    scope.captures[0]?.command === 2 && scope.captureReads === 1),
  actualEntrypointLaunchRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.entrypoint && scope.spec.selectRun === input.entrypointRun && scope.rootCode === 0 && scope.captureReads === 1),
  actualParallelRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.entrypoint && scope.spec.selectRun === input.parallelRun && scope.rootCode === 0 &&
    scope.captures[0]?.command === 2 && scope.captures[0]?.attempt === 1 && scope.captures[0]?.stream === "stderr" && scope.captureReads === 1),
  actualDegradedRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.entrypoint && scope.spec.selectRun === input.degradedRun && scope.rootCode === 0 &&
    scope.captures[0]?.command === 1 && scope.captures[0]?.code === 7 && scope.captures[0]?.attempt === 1 && scope.captures[0]?.stream === "stderr" && scope.captureReads === 1),
  actualUnusableRead: input.phase === "genuine_research" && scopes.some(scope => scope.spec.entrypoint && scope.spec.selectRun === input.unusableRun && scope.rootCode === 7 &&
    scope.failureReason === "all_branches_unusable" && scope.captures[0]?.command === 2 && scope.captures[0]?.code === 7 && scope.captures[0]?.attempt === 1 && scope.captures[0]?.stream === "stderr" && scope.captureReads === 1),
  priorityJourneys: manifest.priority_maps ?? [], prioritySnapshots: manifest.priority_snapshots ?? [],
  sessionSwitches: manifest.session_switches ?? [],
  liveSessionSwitchIsolated: input.phase === "genuine_research" && scopes.some(scope => scope.spec.switchPhase === "B" && scope.maps[0]?.total === 0 && scope.reads === 0 && scope.switchFrame.model_had_original_map === false),
  liveOriginalSessionRestored: input.phase === "genuine_research" && scopes.some(scope => scope.spec.switchPhase === "A2" && scope.rootCode === 0 && scope.captureReads === 1 && scope.switchFrame.model_had_original_map),
  entrypointJourneys: manifest.entrypoint_journeys ?? [],
  entrypointReadLedger: scopes.filter(scope => scope.spec.entrypoint && scope.calls > 0).map(scope => ({ owner: scope.spec.owner, paths: scope.toolReads })),
  sessionCopies: manifest.session_copies ?? [],
  forkCloneIsolated: input.phase === "genuine_research" && manifest.session_copies.length === 4 && scopes.filter(scope => scope.calls > 0 && scope.spec.branch).every(scope => scope.reads === 0 && scope.maps[0].total === 0),
  entrypointForkCloneIsolated: input.phase === "genuine_research" && manifest.session_copies.filter(copy => copy.entrypoint).length === 2 &&
    scopes.filter(scope => scope.spec.entrypoint && scope.spec.branch && scope.calls > 0).every(scope => scope.reads === 0 && scope.maps[0].total === 0 && scope.inheritedContext),
  entrypointOriginalReopened: input.phase === "genuine_research" && scopes.filter(scope => scope.spec.entrypoint && !scope.spec.switchPhase && scope.spec.selectRun === input.entrypointRun && scope.rootCode === 0 && scope.captureReads === 1).length === 2,
  inheritedNavigationPreserved: input.phase === "genuine_research" && manifest.session_copies.every(copy => copy.inherited_navigation) && scopes.filter(scope => scope.calls > 0 && scope.spec.branch).every(scope => scope.inheritedContext) }));
