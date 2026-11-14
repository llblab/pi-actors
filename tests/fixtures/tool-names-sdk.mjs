import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const [packageDir, agentDir, layout] = process.argv.slice(2);
// The mandatory preload first isolates defaults; bind this fixture's explicit temporary root before product imports.
process.env.PI_CODING_AGENT_DIR = agentDir;
const entrypoint = join(packageDir, layout === "source" ? "index.ts" : "dist/pi-actors/index.js");
const skill = join(packageDir, layout === "source" ? "skills" : "dist/skills", "actors/SKILL.md");
const recipe = join(agentDir, "recipes", "legacy.json");
fs.mkdirSync(join(agentDir, "recipes"), { recursive: true });
const saved = { description: "Saved unprefixed identity", template: "echo saved", args: [] };
fs.writeFileSync(recipe, JSON.stringify(saved));
const aliases = { register_tool: "actors_tool_register", spawn: "actors_run_spawn", message: "actors_control_apply", inspect: "actors_inspect" };
const canonical = Object.values(aliases), old = Object.keys(aliases);
const pairs = [
  ["inspect", { target: "runtime", view: "status", verbose: true }, false],
  ["spawn", { as: "invalid", template: "echo must-not-run" }, true],
  ["message", { target: "runtime", action: "chat" }, true],
  ["register_tool", {}, false],
  ["register_tool", { name: "audio_transcribe", template: "echo refused", description: "Refused" }, true],
  ["register_tool", { name: "Audio Transcribe", template: "echo refused", description: "Refused", update: true }, true],
  ["register_tool", { name: "legacy", update: true }, false],
];
const model = { id: "tool-names-fixture", name: "Tool names fixture", api: "tool-names-fixture", provider: "tool-names-fixture", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let step = 0, providerError, declaredRequests = 0;
let lifecycleRequest, lifecycleCalled = false, replaceHost;
const lifecycle = [];
const reply = (content, stopReason) => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content, stopReason, timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const results = [];
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, actors: {} });
const factory = async ({ sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd: agentDir, agentDir, settingsManager: settings,
    resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: [entrypoint], additionalSkillPaths: [skill], noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        replaceHost = () => pi.registerTool({ name: "Legacy", label: "Foreign replacement", description: "Never execute", parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("Foreign replacement executed"); } });
        pi.registerTool({ name: "Audio-Transcribe", label: "Foreign audio", description: "Foreign host tool; never execute", parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("Foreign tool executed"); } });
        pi.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
          streamSimple: (_model, context) => {
            const result = (async () => {
              if (lifecycleRequest) {
                if (!lifecycleCalled) {
                  lifecycleCalled = true;
                  return reply([{ type: "toolCall", id: `lifecycle-${lifecycle.length}`, name: "actors_tool_register", arguments: lifecycleRequest.args }], "toolUse");
                }
                const returned = context.messages.findLast(message => message.role === "toolResult");
                assert.equal(Boolean(returned.isError), lifecycleRequest.error, JSON.stringify(returned));
                if (lifecycleRequest.error) assert.match(JSON.stringify(returned.content), /Host tool name collision/);
                lifecycle.push(lifecycleRequest.label);
                return reply([{ type: "text", text: "Lifecycle admission observed" }], "stop");
              }
              declaredRequests++;
              const declared = new Map();
              for (const message of context.messages) if (message.role === "system") {
                for (const tool of message.toolsAdded ?? []) declared.set(tool.name, tool);
                for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name);
              }
              assert.deepEqual([...declared.keys()].filter(name => canonical.includes(name) || old.includes(name)).sort(), [...canonical].sort(), "Only canonical actor declarations reach requests");
              assert.equal(declared.has("Audio-Transcribe"), false, "Inactive foreign tools still block normalized collisions");
              let calls;
              if (step === 0) calls = [{ name: "read", arguments: { path: skill } }];
              else if (step === 1) {
                const read = context.messages.findLast(message => message.role === "toolResult");
                assert.equal(read.isError, false); assert.match(JSON.stringify(read.content), /Public tool names and migration/);
              } else {
                const pair = pairs[step - 2], returned = context.messages.filter(message => message.role === "toolResult").slice(-2);
                assert.equal(returned.length, 2);
                assert.deepEqual(returned.map(message => message.toolName), [pair[0], aliases[pair[0]]]);
                assert.deepEqual(returned.map(message => Boolean(message.isError)), [pair[2], pair[2]], JSON.stringify({ pair, returned }));
                assert.deepEqual(returned[0].content, returned[1].content, "Legacy and canonical dispatch preserve identical outcomes");
                if (pair[1].name?.toLowerCase().includes("audio")) assert.match(JSON.stringify(returned[0].content), /Host tool name collision/);
                results.push({ legacy: pair[0], canonical: aliases[pair[0]], error: pair[2] });
              }
              if (step > 0 && step <= pairs.length) {
                const [name, args] = pairs[step - 1];
                calls = [name, aliases[name]].map(name => ({ name, arguments: args }));
              }
              step++;
              return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: calls ? calls.map((call, index) => ({ type: "toolCall", id: `names-${step}-${index}`, ...call })) : [{ type: "text", text: "Canonical tool migration observed" }],
                stopReason: calls ? "toolUse" : "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            })().catch(error => { providerError ??= error; throw error; });
            return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: "done", reason: message.stopReason, message }; }, result: () => result };
          } });
      }] } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
  return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.create(agentDir, join(agentDir, "sessions")) });
const errors = [];
try {
  await runtime.session.bindExtensions({ onError: error => errors.push(error.error) });
  const active = runtime.session.getActiveToolNames();
  assert.ok(old.every(name => active.includes(name)), "Saved native calls have active compatibility dispatch");
  runtime.session.setActiveToolsByName(active.filter(name => name !== "Audio-Transcribe"));
  await runtime.session.prompt("Read the active actors Skill, then verify canonical tool dispatch and saved-call compatibility without starting work.");
  if (providerError) throw providerError;
  assert.deepEqual(errors, []); assert.equal(results.length, pairs.length); assert.equal(declaredRequests, pairs.length + 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(recipe, "utf8")), saved, "Updating the saved name preserves its definition and identity");
  assert.equal(fs.existsSync(join(agentDir, "recipes/audio_transcribe.json")), false);
  assert.equal(fs.existsSync(join(agentDir, "tmp/pi-actors/runs")) && fs.readdirSync(join(agentDir, "tmp/pi-actors/runs")).some(name => name !== "index.json"), false, "Guards must not start Runs");
  const register = async (label, args, error = false) => {
    lifecycleRequest = { label, args, error }; lifecycleCalled = false;
    await runtime.session.prompt(`Verify ${label} without executing a Recipe.`);
    if (providerError) throw providerError;
  };
  const awaitActive = async (expected, name = "legacy") => {
    const deadline = Date.now() + 5000;
    while (runtime.session.getActiveToolNames().includes(name) !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(runtime.session.getActiveToolNames().includes(name), expected, "Watcher must observe actual declaration activation");
  };
  await register("delete", { name: "legacy", template: null });
  await awaitActive(false);
  // A new Recipe file forces a scan after deletion, not just a synchronous active-set update.
  const marker = join(agentDir, "recipes", "scan_marker.json");
  fs.writeFileSync(marker, JSON.stringify(saved));
  await awaitActive(true, "scan_marker");
  await register("recreate", { name: "legacy", ...saved, args: "" });
  await awaitActive(true);
  for (const loss of ["remove", "disable", "invalidate"]) {
    if (loss === "remove") fs.unlinkSync(recipe);
    else fs.writeFileSync(recipe, loss === "disable" ? JSON.stringify({ ...saved, disabled: true }) : "{");
    await awaitActive(false);
    fs.writeFileSync(recipe, JSON.stringify(saved));
    await awaitActive(true);
    await register(`restore-${loss}`, { name: "legacy", update: true });
  }
  fs.unlinkSync(recipe); await awaitActive(false);
  replaceHost();
  runtime.session.setActiveToolsByName(runtime.session.getActiveToolNames().filter(name => name !== "legacy" && name !== "Legacy"));
  fs.writeFileSync(recipe, JSON.stringify(saved));
  await register("foreign-after-loss", { name: "legacy", update: true }, true);
  assert.equal(runtime.session.getActiveToolNames().includes("legacy"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(recipe, "utf8")), saved);
  assert.deepEqual(errors, []);
  const transcript = fs.readFileSync(runtime.session.sessionManager.getSessionFile(), "utf8");
  assert.match(transcript, /"name":"register_tool"/); assert.match(transcript, /"name":"actors_tool_register"/);
  console.log(JSON.stringify({ schema: "tool-names-sdk-v1", layout, results, declaredRequests, lifecycle, workloads: 0, saved_calls: "preserved" }));
} finally { await runtime.dispose(); }
