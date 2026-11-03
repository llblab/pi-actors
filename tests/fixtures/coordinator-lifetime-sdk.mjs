/**
 * Zones: real public SDK lifecycle, opt-in private kernel composition, source/packed evidence.
 * Owns finite isolated fixture workloads and durable PID capture; not default/public supervision or native closure.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const [packageDir, agentDir, layout, scenario] = process.argv.slice(2);
assert.ok(scenario === undefined || scenario === "shutdown");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(join(agentDir, "fixture-host.json"), JSON.stringify({ pid: process.pid, agent_dir: agentDir, layout, host_exit: "not_asserted" }));
assert.ok(layout === "source" || layout === "packed");
process.env.PI_CODING_AGENT_DIR = agentDir;
const modulePath = name => pathToFileURL(join(packageDir, layout === "source" ? "lib" : "dist/lib", `${name}.${layout === "source" ? "ts" : "js"}`)).href;
const entrypointPath = join(packageDir, layout === "source" ? "index.ts" : JSON.parse(fs.readFileSync(join(packageDir, "package.json"), "utf8")).pi.extensions[0]);
const actorsSkill = join(packageDir, layout === "source" ? "skills" : "dist/skills", "actors", "SKILL.md");
const { createActorExtensionRuntime } = await import(modulePath("extension-runtime"));
const { getRunStateRoot } = await import(modulePath("paths"));
const { readProcessIdentity } = await import(modulePath("runs-process"));
fs.mkdirSync(agentDir, { recursive: true });
const manifestPath = join(agentDir, "fixture-processes.json");
const captured = [], scopes = [], runtimes = [], specs = [], publicLaunches = [];
let launching = false, complete = false, providerError, publicBirthSpec, observationOrder = 0;
const nativeSpawn = childProcess.spawn;
// A loader may retain this function after builtin restoration; only the current tool-start window can arm it.
const publicBirthObserver = (...args) => {
  const child = nativeSpawn(...args), spec = publicBirthSpec;
  if (!spec) return child;
  publicBirthSpec = undefined;
  try { return captureRunner(spec, child); }
  finally { childProcess.spawn = nativeSpawn; syncBuiltinESMExports(); }
};
const persist = () => {
  const stage = `${manifestPath}.tmp`;
  fs.writeFileSync(stage, JSON.stringify({ schema: "coordinator-sdk-fixture-v1", ...(scenario ? { scenario } : {}), launching, complete, captured, public_launches: publicLaunches }));
  fs.renameSync(stage, manifestPath);
};
persist();
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const expected = spec => ({ run: spec.run, run_instance_id: spec.runner.run_instance_id, ownerId: spec.ownerId });
const absent = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } };
async function settlePid(row) {
  assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0, "Captured fixture PID is unavailable; retaining state");
  const until = performance.now() + 8000;
  // ESRCH does not dispatch Node's close callback. Require both observations
  // for a runner whose actual ChildProcess close is captured by this fixture.
  while (!absent(row.pid) || (scenario === "shutdown" && row.role === "runner" && !row.close)) {
    if (performance.now() >= until) throw Error(`Captured fixture ${row.role} exit remains unproven; retaining state`);
    await pause();
  }
  if (!row.settled) row.settled_order = ++observationOrder;
  row.settled = true; persist();
}
function captureRunner(spec, child) {
  const row = { pid: child.pid, role: "runner", run: spec.run, ownerId: spec.ownerId, state_dir: spec.stateDir, settled: false, captured_order: ++observationOrder };
  captured.push(row); spec.runner = row; persist(); // Positive actual birth before assertions/source reads/await.
  row.run_instance_id = JSON.parse(fs.readFileSync(join(spec.stateDir, "run.json"), "utf8")).run_instance_id; persist();
  if (scenario === "shutdown") child.once("close", (code, signal) => { row.close = { code, signal }; persist(); });
  child.once("error", () => undefined); return child;
}
function captureWork(spec, command, attempt) {
  if (spec.workloads.some(row => row.command === command.ordinal && row.attempt === attempt)) return true;
  let data;
  try { data = JSON.parse(fs.readFileSync(`${command.ready}.${attempt}`, "utf8")); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const row = { pid: data.pid, command: data.command, attempt: data.attempt, role: "workload", run: spec.run, run_instance_id: spec.runner.run_instance_id, ownerId: spec.ownerId, state_dir: spec.stateDir, settled: false, captured_order: ++observationOrder };
  captured.push(row); spec.workloads.push(row); persist();
  assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0, "Captured fixture workload PID unavailable; retaining state");
  assert.equal(row.command, command.ordinal); assert.equal(row.attempt, attempt);
  return true;
}
async function ready(spec, command = spec.commands[0], attempt = 1) {
  const until = performance.now() + 5000;
  while (!captureWork(spec, command, attempt)) {
    if (performance.now() >= until) throw Error("Captured fixture workload PID unavailable; retaining state");
    await pause();
  }
}
async function observeParallelOverlap(spec) {
  for (const command of spec.commands) await ready(spec, command);
  const overlap = { state: "observing", members: spec.workloads.map(({ pid, command, attempt }) => ({ pid, command, attempt })),
    gates: spec.commands.map(command => {
      const path = `${command.gate}.1`; let absent = false;
      try { fs.lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; absent = true; }
      return { path, absent };
    }), live_probes: [] };
  spec.launch.overlap = overlap; persist();
  assert.equal(overlap.members.length, 2); assert.equal(new Set(overlap.members.map(row => row.pid)).size, 2);
  assert.equal(overlap.gates.every(gate => gate.absent), true);
  for (const member of overlap.members) { process.kill(member.pid, 0); overlap.live_probes.push(member.pid); persist(); }
  overlap.state = "both_live_before_release"; persist();
}
async function finish(spec) {
  if (spec.parallel) {
    for (const command of spec.commands) await ready(spec, command);
    for (const command of spec.commands) fs.writeFileSync(`${command.gate}.1`, "release");
  }
  for (const command of spec.commands) for (let attempt = 1; attempt <= command.codes.length; attempt++) {
    await ready(spec, command, attempt); // Capture each actual command/attempt birth before permitting it to finish.
    if (!spec.parallel) fs.writeFileSync(`${command.gate}.${attempt}`, "release");
    await settlePid(spec.workloads.find(row => row.command === command.ordinal && row.attempt === attempt));
  }
  await settlePid(spec.runner);
  const result = JSON.parse(fs.readFileSync(join(spec.stateDir, "result.json"), "utf8"));
  assert.equal(result.terminal_acceptance, "natural"); assert.equal(result.code, spec.codes.at(-1), "Fixture root code differs; retaining state");
  const execution = JSON.parse(fs.readFileSync(join(spec.stateDir, "execution.json"), "utf8"));
  assert.equal(execution.run_instance_id, spec.runner.run_instance_id); assert.equal(execution.commands.length, spec.commands.length);
  for (const [index, command] of execution.commands.entries()) {
    const codes = spec.commands[index].codes;
    assert.deepEqual(command.attempts.map(attempt => attempt.attempt), codes.map((_, index) => index + 1));
    assert.deepEqual(command.attempts.map(attempt => attempt.code), codes);
    assert.deepEqual(command.attempts.map(attempt => attempt.native_exit_code), codes);
  }
}
function active(scope, spec) {
  const reading = scope.kernel.observeRunSnapshot(expected(spec), new Date().toISOString());
  const meta = JSON.parse(fs.readFileSync(join(spec.stateDir, "run.json"), "utf8"));
  if (meta.process_identity?.platform === process.platform) {
    assert.equal(reading.state, "available"); assert.equal(reading.snapshot.status, "running");
    assert.equal(reading.snapshot.cwd, agentDir); assert.ok(reading.snapshot.elapsed_ms >= 0);
    scope.activeProof = "supported";
  } else { assert.deepEqual(reading, { state: "unavailable", reason: "lifecycle_unproven" }); scope.activeProof = "unproven"; }
  return reading;
}
function makeSpec(run, route, codes = [0], commandCount = 1, entrypoint = false, parallel = false, commandCodes, piSession = false) {
  const spec = { run, route, codes, entrypoint, parallel, workloads: [], stateDir: join(getRunStateRoot(), run), commands: [] };
  specs.push(spec);
  for (let ordinal = 1; ordinal <= commandCount; ordinal++) {
    const base = join(agentDir, `${run}.command-${ordinal}`), command = { ordinal, codes: commandCodes?.[ordinal - 1] ?? codes, script: `${base}.${piSession ? "js" : "cjs"}`, gate: `${base}.release`, ready: `${base}.ready.json` };
    spec.commands.push(command);
    const steps = command.codes.map((code, index) => ({ code,
      stdout: parallel ? code === 0 ? `PARALLEL_STDOUT_NOT_SELECTED_${ordinal}` : "" : entrypoint ? "finite SDK entrypoint launch fixture" : commandCount > 1 ? `COMPOSITION_STDOUT_NOT_SELECTED_${ordinal}` : codes.length > 1 ? `RETRY_STDOUT_NOT_SELECTED_${index + 1}` : code === 0 ? "finite SDK lifetime fixture" : "FAILED_STDOUT_NOT_SELECTED",
      stderr: parallel ? code !== 0 ? "finite SDK degraded branch stderr 😀" : ordinal === 1 ? "finite SDK parallel first stderr" : "finite SDK parallel second stderr 😀" : commandCount > 1 ? ordinal === 1 ? "finite SDK composition first stderr" : "finite SDK composition second stderr 😀" : codes.length > 1 ? index === 0 ? "finite SDK retry first stderr 😀" : "finite SDK retry second stderr" : code === 0 ? "" : "finite SDK failure stderr 😀" }));
    if (piSession) fs.writeFileSync(command.script, `import fs from 'node:fs';
      const ready = ${JSON.stringify(command.ready + ".1")}, gate = ${JSON.stringify(command.gate + ".1")};
      fs.writeFileSync(ready + '.tmp', JSON.stringify({pid:process.pid, command:1, attempt:1})); fs.renameSync(ready + '.tmp', ready);
      const model = { id:'finite-actor-source', name:'Finite Actor source', api:'finite-actor-source', provider:'finite-actor-source',
        baseUrl:'https://unused.invalid', reasoning:false, input:['text'], contextWindow:200000, maxTokens:128,
        cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
      export default function(pi) {
        let requests = 0;
        pi.on('session_start', (_event, ctx) => fs.writeFileSync(ready + '.session', JSON.stringify({pid:process.pid,
          session_id:ctx.sessionManager.getSessionId(), session_file:ctx.sessionManager.getSessionFile(), cwd:ctx.sessionManager.getCwd()})));
        pi.registerProvider(model.provider, { api:model.api, apiKey:'synthetic-fixture-only', baseUrl:model.baseUrl, models:[model],
          streamSimple: (_model, _context, options) => {
            const result = (async () => {
              if (++requests !== 1) throw Error('Finite Actor provider requested more than one response');
              const until = performance.now() + 20000;
              while (true) {
                try { fs.readFileSync(gate); break; } catch(error) { if(error.code !== 'ENOENT') throw error; }
                if (options?.signal?.aborted || performance.now() >= until) throw Error('Finite Actor gate unavailable');
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              return {role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',
                content:[{type:'text',text:'FINITE_GENUINE_ACTOR_SESSION 😀'}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
                  cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
            })();
            return {async *[Symbol.asyncIterator]() {
              const message = await result, partial = {...message, content:[]};
              yield {type:'start',partial:structuredClone(partial)};
              partial.content.push({type:'text',text:''}); yield {type:'text_start',contentIndex:0,partial:structuredClone(partial)};
              partial.content[0].text = message.content[0].text;
              yield {type:'text_delta',contentIndex:0,delta:message.content[0].text,partial:structuredClone(partial)};
              yield {type:'text_end',contentIndex:0,content:message.content[0].text,partial:structuredClone(partial)};
              yield {type:'done',reason:'stop',message};
            },result:()=>result};
          }});
      }`);
    else fs.writeFileSync(command.script, `const fs = require('node:fs');
      const base = ${JSON.stringify(command.ready)}; let attempt = 1;
      while (fs.existsSync(base + '.' + attempt)) attempt++;
      const ready = base + '.' + attempt;
      fs.writeFileSync(ready + '.tmp', JSON.stringify({pid:process.pid, command:${ordinal}, attempt})); fs.renameSync(ready + '.tmp', ready);
      const steps = ${JSON.stringify(steps)}, step = steps[attempt - 1];
      if (!step) throw Error('Unexpected fixture attempt; retaining evidence');
      const until = Date.now() + ${scenario === "shutdown" ? 90000 : 120000}; const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(command.gate)} + '.' + attempt)) { clearInterval(timer); process.stdout.write(step.stdout); process.stderr.write(step.stderr); process.exitCode = step.code; }
        else if (Date.now() >= until) { clearInterval(timer); process.exitCode = 1; }
      }, 10);`);
  }
  spec.script = spec.commands[0].script;
  spec.values = commandCount === 1 ? { node: process.execPath, script: spec.script } :
    { node: process.execPath, ...Object.fromEntries(spec.commands.map(command => [`script_${command.ordinal}`, command.script])) };
  spec.template = commandCount > 1 ? spec.commands.map(command => `{node} {script_${command.ordinal}}`) :
    codes.length > 1 ? { template: "{node} {script}", retry: 2 } : "{node} {script}";
  if (parallel) spec.template = { parallel: true, template: spec.template };
  if (piSession) {
    spec.values = { node: process.execPath, pi: fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))), script: spec.script };
    spec.template = "{node} {pi} --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-tools --extension {script} --provider finite-actor-source --model finite-actor-source --thinking off -p 'Produce the finite Actor session fixture.'";
  }
  return spec;
}
const model = { id: "coordinator-lifetime-fixture", name: "Coordinator lifetime fixture", api: "coordinator-lifetime-fixture", provider: "coordinator-lifetime-fixture",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let nextSpec;
const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const spec = nextSpec; nextSpec = undefined;
  if (spec?.entrypoint) spec.ownerId = sessionManager.getSessionId();
  const scope = { spec, requests: 0, busy: 0, idle: 0, errors: [], shutdowns: [], controllerTimers: 0, deadlineNotices: 0 };
  scopes.push(scope);
  const services = await createAgentSessionServices({ cwd, agentDir,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: spec?.entrypoint ? [entrypointPath] : [],
      noSkills: !spec?.entrypoint, additionalSkillPaths: spec?.entrypoint ? [actorsSkill] : [], noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
          streamSimple: (_model, context) => {
            const result = (async () => {
              const failure = context.messages.find(message => message.role === "toolResult" && message.isError);
              assert.equal(failure, undefined, JSON.stringify(failure));
              scope.requests++; assert.ok(scope.requests <= 8, "Synthetic SDK provider must terminate");
              let call;
              if (spec?.entrypoint && scope.requests === 1) call = { name: "read", arguments: { path: actorsSkill } };
              else if (spec && !spec.runner) {
                if (spec.entrypoint) {
                  const latest = [...context.messages].reverse().find(message => message.role === "toolResult");
                  assert.equal(latest.toolName, "read"); assert.match(JSON.stringify(latest.content), /Run workflow/);
                  scope.launch.skill_read = true; persist();
                }
                if (spec.route === "async_tool" && !scope.registered) call = { name: "register_tool", arguments: {
                  name: "sdk_lifetime_async", description: "Isolated finite SDK lifetime fixture.", async: true, template: "{node} {script}",
                  defaults: { node: process.execPath, script: spec.script } } };
                else call = spec.route === "spawn" ? { name: "spawn", arguments: { as: `run:${spec.run}`,
                  template: spec.template, values: spec.values, artifacts: { declared_only: join(agentDir, "not-produced.txt") } } }
                  : { name: "sdk_lifetime_async", arguments: { run_id: spec.run } };
              } else if (spec && !spec.finished) {
                if (spec.entrypoint) {
                  if (spec.parallel && !scope.launch.overlap) await observeParallelOverlap(spec); else await ready(spec);
                  assert.equal(scope.session.isStreaming, true);
                }
                else { assert.equal(scope.toolContext.isIdle(), false); active(scope, spec); }
                scope.busy++;
                if (scope.finishing) { await finish(spec); spec.finished = true; }
              }
              return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: call ? [{ type: "toolCall", id: `lifetime-${scope.requests}`, ...call }] : [{ type: "text", text: "Finite lifetime fixture observed" }],
                stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            })().catch(error => { providerError ??= error; throw error; });
            return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: "done", reason: message.stopReason, message }; }, result: () => result };
          } });
        if (spec?.entrypoint) return; // The real SDK-loaded extension owns tools and lifecycle; provider instrumentation only.
        const adapted = { ...pi, registerTool: definition => pi.registerTool({ ...definition, execute: async (...args) => {
          if (definition.name === "register_tool") {
            const reply = await definition.execute(...args); scope.registered = reply.details?.callable_now;
            assert.equal(scope.registered, true, JSON.stringify(reply)); return reply;
          }
          if (!spec || !["spawn", "sdk_lifetime_async"].includes(definition.name)) return definition.execute(...args);
          scope.toolContext = args[4]; spec.ownerId = args[4].sessionManager.getSessionId();
          assert.notEqual(scope.toolContext, scope.startContext); assert.equal(scope.toolContext.sessionManager, scope.startManager);
          scope.hook = scope.kernel.getRunAdmissionObserver(scope.toolContext);
          const catalog = join(getRunStateRoot(), "index.json");
          const priorCatalog = spec.route === "async_tool" ? fs.readFileSync(catalog) : undefined;
          if (priorCatalog) fs.writeFileSync(catalog, "{controlled-corrupt"); // Explicit fixture edit, never read repair.
          launching = true; persist();
          const spawn = childProcess.spawn;
          childProcess.spawn = (...nativeArgs) => captureRunner(spec, spawn(...nativeArgs));
          syncBuiltinESMExports(); let pending;
          try { pending = definition.execute(...args); } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
          assert.ok(Number.isSafeInteger(spec.runner?.pid) && spec.runner.pid > 0, "Capture runner PID before awaiting the tool");
          const reply = await pending; launching = false; persist();
          assert.equal(reply.details.pid, spec.runner.pid); assert.equal(reply.details.run_instance_id, spec.runner.run_instance_id);
          assert.equal(reply.details.launch_kind, spec.route === "spawn" ? "spawn" : "tool");
          assert.equal(Object.hasOwn(reply.details, "origin"), false); assert.equal(Object.hasOwn(reply.details, "snapshot_references"), false);
          assert.equal(Object.hasOwn(reply.details, "catalog_registration_error"), false, "Kernel failure object must not enter public details");
          if (priorCatalog) {
            try {
              assert.deepEqual(reply.details.catalog_registration, { state: "unavailable", reason: "catalog_registration_failed" });
              assert.equal(fs.readFileSync(catalog, "utf8"), "{controlled-corrupt");
              const text = reply.content.filter(block => block.type === "text");
              assert.equal(text.length, 1);
              const document = parseDocument(text[0].text, { version: "1.2", schema: "core", uniqueKeys: true });
              assert.deepEqual(document.errors, []); assert.deepEqual(document.warnings, []);
              assert.equal(document.toJS()?.catalog, "unavailable");
              scope.catalogRefused = true;
            } finally { fs.writeFileSync(catalog, priorCatalog); } // Explicit controlled restoration, not product retry.
          } else {
            assert.equal(Object.hasOwn(reply.details, "catalog_registration"), false);
            const row = JSON.parse(fs.readFileSync(catalog, "utf8")).entries.find(row => row.state_dir === spec.stateDir);
            assert.equal(row.run, spec.run); assert.equal(row.run_instance_id, spec.runner.run_instance_id); assert.equal(row.ownerId, spec.ownerId);
            scope.catalogRegistered = true;
          }
          await ready(spec); return reply;
        } }) };
        scope.kernel = createActorExtensionRuntime(adapted, { schedule: () => { scope.controllerTimers++; assert.fail("Private retention armed controller"); },
          onDeadlineDue: () => { scope.deadlineNotices++; assert.fail("Private retention notified deadline"); } });
        pi.on("session_start", async (_event, ctx) => { scope.startContext = ctx; scope.startManager = ctx.sessionManager; await scope.kernel.onSessionStart(ctx); });
        pi.on("before_agent_start", (event, ctx) => scope.kernel.beforeAgentStart(event.systemPrompt, event.systemPromptOptions.skills ?? [], ctx));
        pi.on("turn_end", (event, ctx) => scope.kernel.onTurnEnd(event, ctx));
        pi.on("context", (event, ctx) => ({ messages: scope.kernel.onContext(event.messages, ctx) }));
        pi.on("agent_settled", (_event, ctx) => scope.kernel.onAgentSettled(ctx));
        pi.on("session_shutdown", (event, ctx) => {
          assert.notEqual(ctx, scope.startContext); assert.equal(ctx.sessionManager, scope.startManager);
          scope.kernel.onSessionShutdown(event.reason, ctx); scope.shutdowns.push(event.reason);
          if (spec?.runner) assert.deepEqual(scope.kernel.observeRunSnapshot(expected(spec), new Date().toISOString()), { state: "unavailable", reason: "origin_not_retained" });
        });
        scope.kernel.registerCoreTools();
      }] } });
  if (spec?.entrypoint) {
    const loaded = services.resourceLoader.getExtensions(), entry = loaded.extensions.find(extension => extension.path === entrypointPath);
    scope.launch = { run: spec.run, owner: sessionManager.getSessionId(), session_file: sessionManager.getSessionFile(), loaded_path: entry?.path ?? null,
      resolved_path: entry?.resolvedPath ?? null, registered_tools: entry ? [...entry.tools.keys()].sort() : [], handlers: entry ? [...entry.handlers.keys()].sort() : [],
      other_spawn_providers: loaded.extensions.filter(extension => extension !== entry && extension.tools.has("spawn")).map(extension => extension.path),
      events: [], skill_read: false, private_observer: "not_installed", runtime_disposed: false };
    spec.launch = scope.launch; publicLaunches.push(scope.launch); persist();
    assert.deepEqual(loaded.errors, []); assert.ok(entry?.tools.has("spawn")); assert.deepEqual(scope.launch.other_spawn_providers, []);
    assert.ok(services.resourceLoader.getSkills().skills.some(skill => skill.filePath === actorsSkill));
    for (const event of ["session_start", "session_shutdown", "before_agent_start", "context", "turn_end", "agent_settled"]) assert.ok(entry.handlers.has(event));
  }
  const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
  scope.session = result.session;
  return { ...result, services, diagnostics: services.diagnostics };
};
async function bind(runtime) {
  const scope = scopes.at(-1); await runtime.session.bindExtensions({ onError: error => scope.errors.push(error.error) });
  runtime.session.setActiveToolsByName(scope.spec?.entrypoint ? ["read", "spawn"] : ["spawn", "register_tool"]); return scope;
}
async function journey(runtime, scope, spec) {
  await runtime.session.prompt("Launch the finite SDK lifetime fixture."); if (providerError) throw providerError;
  assert.equal(scope.toolContext.isIdle(), true); active(scope, spec); scope.idle++;
  scope.finishing = true;
  await runtime.session.prompt("Finish the finite fixture at a normal model boundary."); if (providerError) throw providerError;
  assert.ok(spec.finished); assert.deepEqual(scope.errors, []); assert.ok(scope.busy > 0);
  assert.deepEqual(scope.kernel.observeRunSnapshot(expected(spec), new Date().toISOString()), { state: "unavailable", reason: "timing_unproven" });
}
async function entrypointJourney(runtime, scope, spec, finishWork = true) {
  let restore = () => {};
  const unlisten = runtime.session.subscribe(event => {
    if (!["tool_execution_start", "tool_execution_end"].includes(event.type)) return;
    const row = { type: event.type, name: event.toolName, id: event.toolCallId,
      ...(event.type === "tool_execution_start" && event.toolName === "read" ? { path: event.args?.path } : {}),
      ...(event.type === "tool_execution_start" && event.toolName === "spawn" ? { template: structuredClone(event.args?.template) } : {}),
      ...(event.type === "tool_execution_end" ? { is_error: event.isError === true } : {}) };
    scope.launch.events.push(row); persist();
    if (event.type === "tool_execution_start" && event.toolName === "spawn") {
      launching = true; persist();
      assert.equal(publicBirthSpec, undefined); publicBirthSpec = spec;
      restore = () => { publicBirthSpec = undefined; childProcess.spawn = nativeSpawn; syncBuiltinESMExports(); };
      childProcess.spawn = publicBirthObserver; syncBuiltinESMExports();
    } else if (event.type === "tool_execution_end" && event.toolName === "spawn") {
      restore(); scope.publicReceipt = event.result?.details;
      const details = scope.publicReceipt;
      scope.launch.receipt = { run: details?.run, run_instance_id: details?.run_instance_id, pid: details?.pid,
        ownerId: details?.ownerId, state_dir: details?.state_dir, launch_kind: details?.launch_kind };
      launching = false; persist();
    }
  });
  try {
    await runtime.session.prompt("Read the active Actors Skill, then launch the finite public entrypoint fixture."); if (providerError) throw providerError;
    const receipt = scope.publicReceipt;
    assert.equal(receipt.pid, spec.runner.pid); assert.equal(receipt.run_instance_id, spec.runner.run_instance_id); assert.equal(receipt.launch_kind, "spawn");
    for (const key of ["origin", "snapshot_references", "catalog_registration_error", "catalog_registration"]) assert.equal(Object.hasOwn(receipt, key), false);
    const row = JSON.parse(fs.readFileSync(join(getRunStateRoot(), "index.json"), "utf8")).entries.find(row => row.state_dir === spec.stateDir);
    assert.equal(row.run, spec.run); assert.equal(row.run_instance_id, spec.runner.run_instance_id); assert.equal(row.ownerId, spec.ownerId); scope.catalogRegistered = true;
    assert.equal(scope.session.isStreaming, false); await ready(spec);
    if (!finishWork) return;
    scope.finishing = true;
    await runtime.session.prompt("Finish the public entrypoint fixture through its normal lifecycle."); if (providerError) throw providerError;
    assert.equal(spec.finished, true); assert.deepEqual(scope.errors, []);
  } finally { restore(); unlisten(); }
}
function shutdownLiveFrame(spec) {
  const meta = JSON.parse(fs.readFileSync(join(spec.stateDir, "run.json"), "utf8"));
  assert.equal(meta.pid, spec.runner.pid); assert.equal(meta.run_instance_id, spec.runner.run_instance_id);
  assert.equal(meta.ownerId, spec.ownerId);
  return [spec.runner, ...spec.workloads].map(row => {
    process.kill(row.pid, 0);
    const identity = readProcessIdentity(row.pid);
    assert.ok(identity); assert.equal(identity.platform, process.platform);
    if (process.platform === "linux" || identity.cwd !== undefined) assert.equal(identity.cwd, agentDir);
    assert.ok(identity.command.includes(row.role === "runner" ? "async-runner" : spec.script));
    if (row.role === "runner") assert.deepEqual(identity, meta.process_identity);
    return { pid: row.pid, role: row.role, identity };
  });
}
async function shutdownJourney() {
  assert.ok(["linux", "darwin", "win32"].includes(process.platform), "Run this witness only on an actual supported CI operating system");
  const owned = makeSpec("sdk-shutdown-owned", "spawn", [0], 1, true); nextSpec = owned;
  const ownerRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir,
    sessionManager: SessionManager.create(agentDir, join(agentDir, "shutdown-owner-sessions")) });
  runtimes.push(ownerRuntime);
  const ownerScope = await bind(ownerRuntime);
  await entrypointJourney(ownerRuntime, ownerScope, owned, false);
  const foreign = makeSpec("sdk-shutdown-foreign", "spawn", [0], 1, true); nextSpec = foreign;
  const foreignRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir,
    sessionManager: SessionManager.create(agentDir, join(agentDir, "shutdown-foreign-sessions")) });
  runtimes.push(foreignRuntime);
  const foreignScope = await bind(foreignRuntime);
  await entrypointJourney(foreignRuntime, foreignScope, foreign, false);
  assert.notEqual(owned.ownerId, foreign.ownerId);
  const before = { owned: shutdownLiveFrame(owned), foreign: shutdownLiveFrame(foreign) };
  assert.equal(owned.workloads.length, 1); assert.equal(foreign.workloads.length, 1);
  const gate = owned.commands[0].gate + ".1";
  assert.equal(fs.existsSync(gate), false);
  const metadata = fs.readFileSync(join(owned.stateDir, "run.json"));
  const reportDir = join(getRunStateRoot(), "teardown"), reportsBefore = new Set(fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : []);
  owned.shutdownAttempted = true; persist();
  // Dispose is one-shot even on partial failure; cleanup may release fixture gates, never retry Kill.
  runtimes.splice(runtimes.indexOf(ownerRuntime), 1);
  await ownerRuntime.dispose();
  owned.launch.runtime_disposed = true; persist();
  assert.deepEqual(ownerScope.errors, []);
  const reports = fs.readdirSync(reportDir).filter(name => !reportsBefore.has(name))
    .map(name => ({ file: name, ...JSON.parse(fs.readFileSync(join(reportDir, name), "utf8")) }));
  assert.equal(reports.length, 1);
  const report = reports[0];
  assert.equal(report.ownerId, owned.ownerId); assert.equal(report.trigger, "session_shutdown:quit");
  assert.equal(report.attempted, 1); assert.equal(report.killed, 1); assert.equal(report.failed, 0);
  assert.equal(report.attempts[0].run, owned.run); assert.equal(report.attempts[0].runInstanceId, owned.runner.run_instance_id);
  const started = performance.now();
  await settlePid(owned.runner);
  await settlePid(owned.workloads[0]);
  const observationMs = performance.now() - started;
  assert.ok(owned.runner.close, "Actual runner close must be observed, not inferred from a status");
  if (process.platform === "win32") {
    assert.equal(owned.runner.close.signal, null);
    assert.ok(Number.isSafeInteger(owned.runner.close.code), "Windows reports its actual exit status, not a POSIX signal");
  } else assert.deepEqual(owned.runner.close, { code: null, signal: "SIGKILL" });
  assert.equal(fs.existsSync(gate), false, "Workload release gate stays closed through native absence observation");
  assert.deepEqual(fs.readFileSync(join(owned.stateDir, "run.json")), metadata);
  const killEvents = fs.readFileSync(join(owned.stateDir, "trace.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(item => item.kind === "run.kill");
  assert.equal(killEvents.length, 1); assert.equal(killEvents[0].data.pid, owned.runner.pid);
  assert.equal(killEvents[0].data.signal, "SIGKILL");
  const signalPlan = killEvents[0].data;
  assert.equal(signalPlan.signalTarget, process.platform === "win32" ? "processTree" : "processGroup");
  if (process.platform === "win32") {
    assert.equal(signalPlan.command, "taskkill");
    assert.deepEqual(signalPlan.args, ["/PID", String(owned.runner.pid), "/T", "/F"]);
  }
  const foreignAfter = shutdownLiveFrame(foreign);
  assert.deepEqual(foreignAfter, before.foreign, "Another logical owner survives the first SDK shutdown unchanged");
  assert.equal(fs.existsSync(foreign.commands[0].gate + ".1"), false);
  owned.shutdownVerified = true; persist();
  foreignScope.finishing = true;
  await foreignRuntime.session.prompt("Finish only the foreign controlled fixture naturally."); if (providerError) throw providerError;
  assert.equal(foreign.finished, true); assert.deepEqual(foreignScope.errors, []);
  runtimes.splice(runtimes.indexOf(foreignRuntime), 1);
  await foreignRuntime.dispose(); foreign.launch.runtime_disposed = true; persist();
  assert.deepEqual(foreignScope.errors, []);
  console.log(JSON.stringify({ layout, scenario, platform: process.platform, before, foreign_after_owned_shutdown: foreignAfter,
    shutdown_report: report, requested_signal: "SIGKILL", signal_plan: signalPlan,
    runner_close: owned.runner.close, observation_ms: observationMs, fixture_watchdog_ms: 90000,
    owned: { run: owned.run, owner: owned.ownerId, generation: owned.runner.run_instance_id, state_dir: owned.stateDir,
      gate, gate_released: false, observed_workload_exit: "verified_absence_only" },
    foreign: { run: foreign.run, owner: foreign.ownerId, generation: foreign.runner.run_instance_id,
      terminal_acceptance: "natural", code: 0 },
    launches: publicLaunches, capturedPids: captured.length, whole_scope_closure: "not_asserted", crash_supervision: "not_asserted" }));
}
let primaryError;
try {
  if (scenario === "shutdown") await shutdownJourney();
  else {
  const first = makeSpec("sdk-lifetime-spawn", "spawn"); nextSpec = first;
  const manager = SessionManager.create(agentDir, join(agentDir, "sessions"));
  const runtime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: manager }); runtimes.push(runtime);
  const alpha = await bind(runtime); await journey(runtime, alpha, first);
  const clock = () => {
    const meta = JSON.parse(fs.readFileSync(join(first.stateDir, "run.json"), "utf8"));
    assert.equal(typeof meta.started_at, "string"); assert.equal(meta.started_at, meta.createdAt);
    assert.ok(meta.supervision && typeof meta.supervision === "object");
    return { createdAt: meta.createdAt, started_at: meta.started_at, supervision: meta.supervision };
  };
  const originalClock = clock(); const sessionFile = runtime.session.sessionFile; assert.ok(sessionFile);
  const foreignManager = SessionManager.open(sessionFile); assert.equal(foreignManager.getSessionId(), manager.getSessionId()); assert.notEqual(foreignManager, manager);
  const probe = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: foreignManager }); runtimes.push(probe);
  const foreign = await bind(probe); assert.notEqual(foreign.startManager, alpha.startManager);
  const forbidden = Object.defineProperty({}, "identity", { get() { assert.fail("Rejected hook inspected capture DTO"); } });
  const foreignHook = alpha.kernel.getRunAdmissionObserver(foreign.startContext);
  assert.throws(() => foreignHook(forbidden), /coordinator admission is unavailable or changed/);
  await probe.dispose(); runtimes.splice(runtimes.indexOf(probe), 1);
  assert.deepEqual(alpha.kernel.observeRunSnapshot(expected(first), new Date().toISOString()), { state: "unavailable", reason: "timing_unproven" });
  const second = makeSpec("sdk-lifetime-async", "async_tool"); nextSpec = second;
  assert.deepEqual(await runtime.switchSession(sessionFile), { cancelled: false });
  const beta = await bind(runtime); assert.equal(beta.startManager.getSessionId(), alpha.startManager.getSessionId());
  assert.notEqual(beta.startManager, alpha.startManager);
  assert.deepEqual(alpha.shutdowns, ["resume"]); assert.throws(() => alpha.startContext.sessionManager, /stale/);
  assert.throws(() => alpha.hook(forbidden), /coordinator admission is unavailable or changed/);
  assert.deepEqual(beta.kernel.observeRunSnapshot(expected(first), new Date().toISOString()), { state: "unavailable", reason: "origin_not_retained" });
  await journey(runtime, beta, second); assert.deepEqual(clock(), originalClock, "Resume must not rewrite the old generation's anchors");
  await runtime.dispose(); runtimes.splice(runtimes.indexOf(runtime), 1);
  assert.deepEqual(beta.shutdowns, ["quit"]); assert.throws(() => beta.startContext.sessionManager, /stale/);
  assert.throws(() => beta.hook(forbidden), /coordinator admission is unavailable or changed/);
  const third = makeSpec("sdk-lifetime-failure", "spawn", [7]); nextSpec = third;
  const failureRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(failureRuntime);
  const gamma = await bind(failureRuntime); await journey(failureRuntime, gamma, third);
  assert.equal(gamma.startManager.getSessionId(), manager.getSessionId()); assert.deepEqual(clock(), originalClock);
  await failureRuntime.dispose(); runtimes.splice(runtimes.indexOf(failureRuntime), 1); assert.deepEqual(gamma.shutdowns, ["quit"]);
  const failedResult = JSON.parse(fs.readFileSync(join(third.stateDir, "result.json"), "utf8"));
  const failedAttempt = JSON.parse(fs.readFileSync(join(third.stateDir, "execution.json"), "utf8")).commands[0].attempts[0];
  const fourth = makeSpec("sdk-lifetime-retry", "spawn", [7, 0]); nextSpec = fourth;
  const retryRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(retryRuntime);
  const delta = await bind(retryRuntime); await journey(retryRuntime, delta, fourth);
  assert.equal(delta.startManager.getSessionId(), manager.getSessionId()); assert.deepEqual(clock(), originalClock);
  await retryRuntime.dispose(); runtimes.splice(runtimes.indexOf(retryRuntime), 1); assert.deepEqual(delta.shutdowns, ["quit"]);
  const retryResult = JSON.parse(fs.readFileSync(join(fourth.stateDir, "result.json"), "utf8"));
  const retryAttempts = JSON.parse(fs.readFileSync(join(fourth.stateDir, "execution.json"), "utf8")).commands[0].attempts;
  const fifth = makeSpec("sdk-lifetime-composition", "spawn", [0], 2); nextSpec = fifth;
  const compositionRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(compositionRuntime);
  const epsilon = await bind(compositionRuntime); await journey(compositionRuntime, epsilon, fifth);
  assert.equal(epsilon.startManager.getSessionId(), manager.getSessionId()); assert.deepEqual(clock(), originalClock);
  await compositionRuntime.dispose(); runtimes.splice(runtimes.indexOf(compositionRuntime), 1); assert.deepEqual(epsilon.shutdowns, ["quit"]);
  const compositionResult = JSON.parse(fs.readFileSync(join(fifth.stateDir, "result.json"), "utf8"));
  const compositionCommands = JSON.parse(fs.readFileSync(join(fifth.stateDir, "execution.json"), "utf8")).commands;
  const sixth = makeSpec("sdk-lifetime-entrypoint", "spawn", [0], 1, true); nextSpec = sixth;
  const entrypointRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(entrypointRuntime);
  const zeta = await bind(entrypointRuntime); await entrypointJourney(entrypointRuntime, zeta, sixth);
  assert.deepEqual(clock(), originalClock);
  await entrypointRuntime.dispose(); runtimes.splice(runtimes.indexOf(entrypointRuntime), 1); assert.deepEqual(zeta.errors, []);
  sixth.launch.runtime_disposed = true; persist();
  const seventh = makeSpec("sdk-lifetime-parallel", "spawn", [0], 2, true, true); nextSpec = seventh;
  const parallelRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(parallelRuntime);
  const eta = await bind(parallelRuntime); await entrypointJourney(parallelRuntime, eta, seventh);
  assert.deepEqual(clock(), originalClock);
  await parallelRuntime.dispose(); runtimes.splice(runtimes.indexOf(parallelRuntime), 1); assert.deepEqual(eta.errors, []);
  seventh.launch.runtime_disposed = true; persist();
  const parallelResult = JSON.parse(fs.readFileSync(join(seventh.stateDir, "result.json"), "utf8"));
  const parallelCommands = JSON.parse(fs.readFileSync(join(seventh.stateDir, "execution.json"), "utf8")).commands;
  const eighth = makeSpec("sdk-lifetime-degraded", "spawn", [0], 2, true, true, [[7], [0]]); nextSpec = eighth;
  const degradedRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(degradedRuntime);
  const theta = await bind(degradedRuntime); await entrypointJourney(degradedRuntime, theta, eighth);
  assert.deepEqual(clock(), originalClock);
  await degradedRuntime.dispose(); runtimes.splice(runtimes.indexOf(degradedRuntime), 1); assert.deepEqual(theta.errors, []);
  eighth.launch.runtime_disposed = true; persist();
  const degradedResult = JSON.parse(fs.readFileSync(join(eighth.stateDir, "result.json"), "utf8"));
  const degradedCommands = JSON.parse(fs.readFileSync(join(eighth.stateDir, "execution.json"), "utf8")).commands;
  const ninth = makeSpec("sdk-lifetime-unusable", "spawn", [7], 2, true, true); ninth.template.failure = "branch"; nextSpec = ninth;
  const unusableRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.open(sessionFile) }); runtimes.push(unusableRuntime);
  const iota = await bind(unusableRuntime); await entrypointJourney(unusableRuntime, iota, ninth);
  assert.deepEqual(clock(), originalClock);
  await unusableRuntime.dispose(); runtimes.splice(runtimes.indexOf(unusableRuntime), 1); assert.deepEqual(iota.errors, []);
  ninth.launch.runtime_disposed = true; persist();
  const unusableResult = JSON.parse(fs.readFileSync(join(ninth.stateDir, "result.json"), "utf8"));
  const unusableCommands = JSON.parse(fs.readFileSync(join(ninth.stateDir, "execution.json"), "utf8")).commands;
  const tenth = makeSpec("sdk-lifetime-actor-session", "spawn", [0], 1, true, false, undefined, true); nextSpec = tenth;
  const actorRuntime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.create(agentDir, join(agentDir, "sessions")) }); runtimes.push(actorRuntime);
  const kappa = await bind(actorRuntime); await entrypointJourney(actorRuntime, kappa, tenth);
  await actorRuntime.dispose(); runtimes.splice(runtimes.indexOf(actorRuntime), 1); assert.deepEqual(kappa.errors, []);
  tenth.launch.runtime_disposed = true; persist();
  const actorCommand = JSON.parse(fs.readFileSync(join(tenth.stateDir, "execution.json"), "utf8")).commands[0];
  assert.equal(actorCommand.session_files.length, 1);
  const actorSession = JSON.parse(fs.readFileSync(tenth.commands[0].ready + ".1.session", "utf8"));
  assert.equal(actorSession.pid, tenth.workloads[0].pid); assert.notEqual(actorSession.session_id, tenth.ownerId);
  assert.notEqual(tenth.ownerId, manager.getSessionId());
  assert.equal(actorSession.session_file, join(tenth.stateDir, actorCommand.session_files[0]));
  assert.deepEqual(scopes.map(scope => scope.errors), [[], [], [], [], [], [], [], [], [], [], []]);
  console.log(JSON.stringify({ layout, sessionFile, ownerSession: manager.getSessionId(), genuineRuns: 10, capturedPids: captured.length,
    actorSessionLaunch: tenth.launch, actorSession: {...actorSession, run:tenth.run, command_id:actorCommand.id, path:actorCommand.session_files[0]},
    entrypointLaunch: sixth.launch, parallelLaunch: seventh.launch, degradedLaunch: eighth.launch, unusableLaunch: ninth.launch,
    naturalUnusable: { run: ninth.run, root_code: unusableResult.code, failure_reason: unusableResult.failure_reason,
      soft_quorum: unusableResult.soft_quorum, command_ids: unusableCommands.map(command => command.id),
      codes: unusableCommands.map(command => command.attempts[0].code), statuses: unusableCommands.map(command => command.status),
      native_codes: unusableCommands.map(command => command.attempts[0].native_exit_code), workload_pids: ninth.workloads.map(row => row.pid) },
    naturalDegraded: { run: eighth.run, root_code: degradedResult.code, command_ids: degradedCommands.map(command => command.id),
      codes: degradedCommands.map(command => command.attempts[0].code), statuses: degradedCommands.map(command => command.status),
      native_codes: degradedCommands.map(command => command.attempts[0].native_exit_code), workload_pids: eighth.workloads.map(row => row.pid) },
    naturalParallel: { run: seventh.run, root_code: parallelResult.code, command_ids: parallelCommands.map(command => command.id),
      codes: parallelCommands.map(command => command.attempts[0].code), workload_pids: seventh.workloads.map(row => row.pid) },
    naturalComposition: { run: fifth.run, root_code: compositionResult.code, command_ids: compositionCommands.map(command => command.id),
      codes: compositionCommands.map(command => command.attempts[0].code), workload_pids: fifth.workloads.map(row => row.pid) },
    naturalRetry: { run: fourth.run, root_code: retryResult.code, attempt_codes: retryAttempts.map(attempt => attempt.code),
      native_codes: retryAttempts.map(attempt => attempt.native_exit_code), workload_pids: fourth.workloads.map(row => row.pid) },
    naturalFailure: { run: third.run, code: failedResult.code, native_exit_code: failedAttempt.native_exit_code, stderr_bytes: failedAttempt.stderr.bytes },
    catalogRegistered: scopes.filter(scope => scope.catalogRegistered).length, catalogRefusedWithoutLaunchFailure: scopes.filter(scope => scope.catalogRefused).length,
    privateToolContexts: 5, privateShutdownContexts: scopes.reduce((n, scope) => n + scope.shutdowns.length, 0),
    sameIdForeignManagerRejected: true, oldOriginNotReconstructed: true, controllerTimers: scopes.reduce((n, scope) => n + scope.controllerTimers, 0),
    deadlineNotices: scopes.reduce((n, scope) => n + scope.deadlineNotices, 0), activeProof: [alpha.activeProof, beta.activeProof, gamma.activeProof, delta.activeProof, epsilon.activeProof],
    busySnapshots: alpha.busy + beta.busy + gamma.busy + delta.busy + epsilon.busy, idleSnapshots: alpha.idle + beta.idle + gamma.idle + delta.idle + epsilon.idle }));
  }
} catch (error) { primaryError = error; }
finally {
  const cleanupErrors = [];
  for (const spec of specs) {
    try {
      if (spec.shutdownAttempted) {
        if (!spec.shutdownVerified) for (const command of spec.commands) fs.writeFileSync(command.gate + ".1", "fixture failure cleanup");
        for (const row of [...spec.workloads, spec.runner]) await settlePid(row);
      } else if (spec.runner) await finish(spec);
    } catch (error) { cleanupErrors.push(error); }
  }
  // No teardown is invoked with fixture process absence still unproven.
  if (!cleanupErrors.length) for (const runtime of runtimes) { try { await runtime.dispose(); } catch (error) { cleanupErrors.push(error); } }
  complete = !launching && cleanupErrors.length === 0 && captured.every(row => row.settled === true); persist();
  if (cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], "Captured fixture runner exit remains unproven; retaining state");
}
if (primaryError) throw primaryError;
