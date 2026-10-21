/**
 * Zones: packed extension, public Pi SDK lifecycle evidence.
 * Owns an isolated synthetic provider probe; no network, credentials, or private SDK methods.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const [packageDir, agentDir] = process.argv.slice(2);
const actors = (await import(pathToFileURL(join(packageDir, "dist", "pi-actors", "index.js")).href)).default;
const model = {
  id: "boundary-fixture", name: "Boundary Fixture", api: "boundary-fixture", provider: "boundary-fixture",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const reports = [];
for (const mode of ["tools", "final"]) {
  const manager = SessionManager.inMemory(agentDir);
  const ownerId = manager.getSessionId();
  const stateDirs = ["first", "second"].map(name => join(agentDir, "tmp", "pi-actors", "runs", `${mode}-${name}`));
  const requests = [];
  const errors = [];
  let toolExecutions = 0;
  let starts = 0;
  let settled = 0;
  let sends = 0;
  let shutdown;
  let startContext;
  const complete = async (index) => {
    const stateDir = stateDirs[index];
    const run = `${mode}-${index === 0 ? "first" : "second"}`;
    const timestamp = new Date().toISOString();
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "run.json"), JSON.stringify({
      createdAt: timestamp, cwd: agentDir, notification_policy: "normal", ownerId,
      pid: 999_999_999, run, run_instance_id: `${mode}-generation-${index}`, state_dir: stateDir,
    }));
    await writeFile(join(stateDir, "result.json"), JSON.stringify({ code: 0, finished_at: timestamp }));
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager: settings, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerProvider(model.provider, {
        api: model.api, apiKey: "synthetic-fixture-only", baseUrl: model.baseUrl, models: [model],
        streamSimple: (_model, context) => {
          const request = requests.length + 1;
          assert.ok(request <= 2, "Completion continuation must terminate");
          requests.push(context.messages);
          const result = (async () => {
            if (request === 1 && mode === "final") await Promise.all([complete(0), complete(1)]);
            if (request === 2) {
              assert.equal(settled, 0, "The batch reaches the provider before idle settlement");
              assert.equal(starts, 1, "Overlay must not start another agent run");
              assert.equal(toolExecutions, mode === "tools" ? 2 : 0);
              const text = JSON.stringify(context.messages);
              assert.equal(text.match(/Actor completions: 2/g)?.length, 1);
              assert.match(text, new RegExp(`${mode}-first`));
              assert.match(text, new RegExp(`${mode}-second`));
              for (const [index, stateDir] of stateDirs.entries()) {
                const handled = JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"));
                assert.equal(handled.run_instance_id, `${mode}-generation-${index}`);
              }
            }
            const tools = mode === "tools" && request === 1;
            return {
              role: "assistant", api: model.api, provider: model.provider, model: model.id,
              content: tools
                ? [0, 1].map(index => ({ type: "toolCall", id: `fixture-call-${index}`, name: "finish_fixture", arguments: { index } }))
                : [{ type: "text", text: request === 1 ? "Initial answer" : "Completion results integrated" }],
              stopReason: tools ? "toolUse" : "stop", timestamp: Date.now(),
              usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
          })();
          return {
            async *[Symbol.asyncIterator]() {
              const message = await result;
              yield { type: "done", reason: message.stopReason, message };
            },
            result: () => result,
          };
        },
      });
      pi.registerTool({
        name: "finish_fixture", label: "Finish fixture", description: "Complete an isolated synthetic Run",
        parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
        execute: async (_id, { index }) => {
          await complete(index);
          toolExecutions++;
          return { content: [{ type: "text", text: "Fixture done" }], details: {} };
        },
      });
      pi.on("turn_end", (event) => ({ entries: [...event.entries, { type: "custom", customType: "fixture-before-actors" }] }));
      actors({ ...pi,
        on: (name, handler) => {
          if (name === "session_shutdown") shutdown = handler;
          return pi.on(name, (event, ctx) => {
            if (name === "session_start") startContext = ctx;
            return handler(event, ctx);
          });
        },
        sendMessage: (...args) => { sends++; return pi.sendMessage(...args); },
      });
      pi.on("turn_end", (event) => {
        assert.ok(event.entries.some(entry => entry.customType === "fixture-before-actors"));
      });
      pi.on("agent_start", () => { starts++; });
      pi.on("agent_settled", () => { settled++; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: agentDir, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: manager, model, thinkingLevel: "off",
  });
  try {
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    session.setActiveToolsByName(["finish_fixture"]);
    await session.prompt("Run the synthetic completion-boundary fixture.");
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2);
    assert.equal(starts, 1);
    assert.equal(settled, 1);
    assert.equal(sends, 0, "Active completion delivery must not use native sendMessage queues");
    const batches = manager.getBranch().filter(entry =>
      entry.type === "custom_message" && entry.customType === "pi-actors-run-batch");
    assert.equal(batches.length, 1);
    assert.equal(session.getLastAssistantText(), "Completion results integrated");
    reports.push({ mode, requests: requests.length, starts, settled, batches: batches.length, nativeSends: sends, toolExecutions });
  } finally {
    // The embedding host owns shutdown dispatch before disposing the SDK session.
    if (shutdown && startContext) await shutdown({ type: "session_shutdown", reason: "quit" }, startContext);
    session.dispose();
  }
}
console.log(JSON.stringify(reports));
