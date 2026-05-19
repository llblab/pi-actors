/**
 * Pi-facing tool definition tests
 * Covers schema generation without relying on external schema-builder resolution
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { startRun } from "../lib/async-runs.ts";
import {
  createActorMessageToolDefinition,
  createInspectToolDefinition,
  createRegisterToolDefinition,
  createRuntimeToolDefinition,
  createSpawnToolDefinition,
} from "../lib/tools.ts";

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`file did not appear: ${path}`);
}

function createRegistryDeps() {
  return {
    configPath: "/tmp/actors-tools.json",
    getActiveTools: () => [],
    getExternalToolConflict: () => undefined,
    getTools: () => new Map<string, RegisteredTool>(),
    notify: () => undefined,
    registerRuntimeTool: () => undefined,
    reservedToolNames: new Set<string>(),
    setActiveTools: () => undefined,
  };
}

test("Register tool definition exposes a JSON schema with no required fields", () => {
  const definition = createRegisterToolDefinition(createRegistryDeps());
  assert.equal(definition.name, "register_tool");
  assert.deepEqual(definition.parameters.required, []);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.name.type, "string");
  assert.equal(properties.async.type, "boolean");
  assert.equal(properties.state_dir.type, "string");
  assert.equal(properties.values.type, "object");
  assert.equal(properties.update.type, "boolean");
  assert.equal(Array.isArray(properties.template.anyOf), true);
});

test("Spawn tool definition exposes actor creation schema", () => {
  const definition = createSpawnToolDefinition();
  assert.equal(definition.name, "spawn");
  assert.deepEqual(definition.parameters.required, []);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.artifacts.type, "object");
  assert.equal(properties.as.type, "string");
  assert.equal(properties.recipe.type, "string");
  assert.equal(properties.file.type, "string");
  assert.equal(properties.state_dir.type, "string");
  assert.equal(Array.isArray(properties.template.anyOf), true);
  assert.equal(properties.values.type, "object");
});

test("Inspect tool definition exposes intentional observation schema", () => {
  const definition = createInspectToolDefinition();
  assert.equal(definition.name, "inspect");
  assert.deepEqual(definition.parameters.required, ["target", "view"]);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.target.type, "string");
  assert.equal(properties.view.type, "string");
  assert.equal(properties.lines.type, "string");
  assert.equal(properties.status.type, "string");
});

test("Actor message tool definition exposes concentrated message schema", () => {
  const definition = createActorMessageToolDefinition();
  assert.equal(definition.name, "message");
  assert.deepEqual(definition.parameters.required, ["to", "type"]);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.to.type, "string");
  assert.equal(properties.type.type, "string");
  assert.equal(Array.isArray(properties.body.anyOf), true);
  assert.equal(properties.reply_to.type, "string");
  assert.equal(properties.correlation_id.type, "string");
});

test(
  "Actor message tool routes branch envelopes through parent run mailboxes",
  { skip: process.platform === "win32" },
  async () => {
    const definition = createActorMessageToolDefinition();
    const root = await mkdtemp(join(tmpdir(), "pi-actors-message-"));
    let stateDir = "";
    const readyFile = join(root, "ready");
    const messageFile = join(root, "message");
    const script =
      'mkfifo "$1/control.fifo"; printf ready >"$2"; IFS= read -r message <"$1/control.fifo"; printf %s "$message" >"$3"';
    try {
      const meta = startRun(
        {
          run_id: "parent",
          template: "bash -lc {script} -- {state_dir} {readyFile} {messageFile}",
          values: { messageFile, readyFile, script },
        },
        process.cwd(),
      );
      stateDir = meta.state_dir;
      await waitForFile(readyFile);
      const result = await definition.execute(
        "call-branch-message",
        {
          body: { decision: "approve" },
          to: "branch:parent/reviewer-a",
          type: "control.approve",
        },
        undefined,
        undefined,
        undefined,
      );
      assert.match(result.content[0].text, /to=branch:parent\/reviewer-a/);
      assert.match(result.content[0].text, /message=sent/);
      await waitForFile(messageFile);
      const envelope = JSON.parse(await readFile(messageFile, "utf8"));
      assert.equal(envelope.to, "branch:parent/reviewer-a");
      assert.equal(envelope.type, "control.approve");
      assert.deepEqual(envelope.body, { decision: "approve" });
      await waitForFile(join(stateDir, "result.json"));
    } finally {
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Actor message tool routes tool actors to executable tools", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const definition = createActorMessageToolDefinition({
    getTool: (name) =>
      name === "echo"
        ? {
            execute: async (
              toolCallId: string,
              params: unknown,
              _signal: AbortSignal | undefined,
              _onUpdate: unknown,
              ctx: unknown,
            ) => {
              calls.push({ ctx, params, toolCallId });
              return { content: [{ type: "text" as const, text: "\nok" }], details: params };
            },
          }
        : undefined,
  });
  const ctx = { cwd: process.cwd() };
  const result = await definition.execute(
    "call-tool-message",
    {
      body: { text: "hello" },
      to: "tool:echo",
      type: "tool.call",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /to=tool:echo/);
  assert.match(result.content[0].text, /tool=echo/);
  assert.match(result.content[0].text, /invoked=true/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolCallId, "message:tool.call");
  assert.deepEqual(calls[0].params, { text: "hello" });
  assert.equal(calls[0].ctx, ctx);
  assert.equal(result.details.result.tool, "echo");
});

test("Actor message tool routes coordinator messages through run outboxes", async () => {
  const definition = createActorMessageToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-message-"));
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: "sender",
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-coordinator-message",
      {
        body: { ready: true },
        from: "run:sender",
        metadata: { checkpoint: "ready" },
        summary: "Ready",
        to: "coordinator",
        type: "checkpoint.ready",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /to=coordinator/);
    assert.match(result.content[0].text, /outbox=outbox\.jsonl/);
    const event = JSON.parse(await readFile(join(stateDir, "outbox.jsonl"), "utf8"));
    assert.equal(event.to, "coordinator");
    assert.equal(event.from, "run:sender");
    assert.equal(event.type, "checkpoint.ready");
    assert.equal(event.delivery, "followup");
    assert.deepEqual(event.body, { ready: true });
    assert.deepEqual(event.metadata, { checkpoint: "ready" });
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Spawn tool starts run actors with artifact metadata", async () => {
  const definition = createSpawnToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-spawn-"));
  const stateDir = join(root, "spawned");
  try {
    const result = await definition.execute(
      "call-spawn",
      {
        artifacts: { report: "{state_dir}/report.md" },
        as: "run:spawned",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('spawned')"`,
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.match(result.content[0].text, /run=spawned/);
    assert.deepEqual(result.details.artifacts, { report: `${stateDir}/report.md` });
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Inspect tool reads session runs", async () => {
  const definition = createInspectToolDefinition();
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: `session-inspect-${process.pid}-${Date.now()}`,
        ownerId: "session-demo",
        template: `${process.execPath} -e "console.log('ok')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-inspect-session",
      { target: "session:session-demo", view: "status", status: "running" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /session=session-demo/);
    assert.equal(result.details.runs.length, 1);
    assert.equal(result.details.runs[0].run, meta.run);

    const all = await definition.execute(
      "call-inspect-all",
      { target: "session:all", view: "runs", status: "running" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(all.details.runs.some((run: { run: string }) => run.run === meta.run), true);
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Inspect tool reads run mailbox metadata", async () => {
  const definition = createInspectToolDefinition();
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: "mailbox",
        mailbox: { accepts: ["control.continue"], emits: ["run.done"] },
        template: `${process.execPath} -e "console.log('ok')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-inspect-mailbox",
      { target: "run:mailbox", view: "mailbox" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /accepts=control\.continue/);
    assert.match(result.content[0].text, /emits=run\.done/);
    assert.deepEqual(result.details.mailbox, {
      accepts: ["control.continue"],
      emits: ["run.done"],
    });
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor tools start, inspect, and stop run actors", async () => {
  const spawn = createSpawnToolDefinition();
  const inspect = createInspectToolDefinition();
  const message = createActorMessageToolDefinition();
  const runId = `compact-${process.pid}-${Date.now()}`;
  let stateDir = "";
  const ctx = { cwd: process.cwd() };
  try {
    const started = await spawn.execute(
      "call-1",
      {
        as: `run:${runId}`,
        template: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      },
      undefined,
      undefined,
      ctx,
    );
    stateDir = String(started.details.state_dir);
    assert.match(started.content[0].text, new RegExp(`run=${runId} status=running pid=\\d+`));
    assert.doesNotMatch(started.content[0].text, /argv|template|values/);

    const verbose = await inspect.execute(
      "call-2",
      { target: `run:${runId}`, view: "status", verbose: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(verbose.content[0].text, /"argv"/);
    assert.match(verbose.content[0].text, /"template"/);

    const cancelled = await message.execute(
      "call-3",
      { to: `run:${runId}`, type: "runtime.cancel" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(cancelled.content[0].text, /type=runtime\.cancel/);
    assert.match(cancelled.content[0].text, /stopped=true/);
    assert.doesNotMatch(cancelled.content[0].text, /state_dir|argv/);
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Runtime tool definition exposes run id override for async co-located recipes", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["scope"],
      defaults: {},
      description: "Start review run",
      recipe: {
        async: true,
        name: "review",
        template: "review {scope}",
      },
      name: "review_run",
      template: "review {scope}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.deepEqual(definition.parameters.required, ["scope"]);
  assert.equal(properties.scope.type, "string");
  assert.equal(properties.run_id.type, "string");
  assert.match(definition.promptSnippet, /Start async template recipe: review/);
});

test("Runtime tool definition exposes typed arg schemas", () => {
  const definition = createRuntimeToolDefinition(
    {
      argTypes: {
        dry_run: { kind: "bool" },
        mode: { kind: "enum", values: ["check", "fix"] },
        prompts: { kind: "array" },
        speed: { kind: "number" },
        request_timeout: { kind: "int" },
      },
      args: ["file", "request_timeout", "speed", "dry_run", "mode", "prompts"],
      defaults: { dry_run: "true", mode: "check" },
      description: "Run checker",
      name: "check_tool",
      storedArgs: [
        "file:path",
        "request_timeout:int",
        "speed:number",
        "dry_run:bool",
        "mode:enum(check,fix)",
        "prompts:array",
      ],
      storedDefaults: { dry_run: "true", mode: "check" },
      template: "check {file} {request_timeout} {speed} {dry_run} {mode} {prompts}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.file.type, "string");
  assert.equal(properties.request_timeout.type, "integer");
  assert.equal(properties.speed.type, "number");
  assert.equal(properties.dry_run.type, "boolean");
  assert.deepEqual(properties.mode.enum, ["check", "fix"]);
  assert.equal(properties.prompts.type, "array");
  assert.deepEqual(definition.parameters.required, [
    "file",
    "request_timeout",
    "speed",
    "prompts",
  ]);
});

test("Runtime tool argument errors include compact usage hints", async () => {
  const definition = createRuntimeToolDefinition(
    {
      argTypes: { mode: { kind: "enum", values: ["check", "fix"] } },
      args: ["file", "mode"],
      defaults: { mode: "check" },
      description: "Run checker",
      name: "check_tool",
      template: "check {file} {mode}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  await assert.rejects(
    () =>
      definition.execute(
        "call-1",
        { file: "README.md", mode: "delete" },
        undefined,
        undefined,
        { cwd: "/work" },
      ),
    /Invalid arguments for tool "check_tool": Argument mode must be one of: check, fix\.\n\nExpected call shape for check_tool:\ncheck_tool\(\{\n  "file": "<file>",\n  "mode": "check"\n\}\)\nRequired: file\nOptional: mode/,
  );
});

test("Runtime tool missing value errors include compact usage hints", async () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["file", "out"],
      defaults: {},
      description: "Copy file",
      name: "copy_file",
      template: "cp {file} {out}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  await assert.rejects(
    () =>
      definition.execute(
        "call-1",
        { file: "README.md" },
        undefined,
        undefined,
        { cwd: "/work" },
      ),
    /Invalid arguments for tool "copy_file": Missing command template value: out\n\nExpected call shape for copy_file:\ncopy_file\(\{\n  "file": "<file>",\n  "out": "<out>"\n\}\)\nRequired: file, out/,
  );
});

test("Runtime tool definition marks defaulted args optional", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["file", "lang"],
      defaults: { lang: "ru" },
      description: "Transcribe audio",
      name: "transcribe",
      template: "transcribe {file} {lang}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.deepEqual(definition.parameters.required, ["file"]);
  assert.equal(properties.file.type, "string");
  assert.equal(properties.lang.type, "string");
});

test("Runtime tool definition treats inline-default args as optional", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["text", "lang"],
      defaults: {},
      description: "Speak text",
      name: "speak",
      template: "speak --text {text} --lang {lang=ru}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  assert.deepEqual(definition.parameters.required, ["text"]);
});
