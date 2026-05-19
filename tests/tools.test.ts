/**
 * Pi-facing tool definition tests
 * Covers schema generation without relying on external schema-builder resolution
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import {
  createAsyncRunToolDefinition,
  createRegisterToolDefinition,
  createRuntimeToolDefinition,
} from "../lib/tools.ts";

function createRegistryDeps() {
  return {
    configPath: "/tmp/auto-tools.json",
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

test("Async run tool definition exposes action schema", () => {
  const definition = createAsyncRunToolDefinition();
  assert.equal(definition.name, "async_run");
  assert.deepEqual(definition.parameters.required, ["action"]);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.action.type, "string");
  assert.match(properties.action.description, /events/);
  assert.match(properties.action.description, /send/);
  assert.match(properties.action.description, /kill/);
  assert.equal(properties.message.type, "string");
  assert.equal(Array.isArray(properties.template.anyOf), true);
  assert.equal(properties.verbose.type, "boolean");
});

test("Async run tool returns compact text by default and verbose JSON on request", async () => {
  const definition = createAsyncRunToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-tool-"));
  const stateDir = join(root, "compact");
  const ctx = { cwd: process.cwd() };
  try {
    const started = await definition.execute(
      "call-1",
      {
        action: "start",
        run_id: "compact",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(started.content[0].text, /run=compact status=running pid=\d+/);
    assert.doesNotMatch(started.content[0].text, /argv|template|values/);

    const list = await definition.execute(
      "call-2",
      { action: "list", state_root: root, status: "running" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(list.content[0].text, /run=compact status=running/);
    assert.doesNotMatch(list.content[0].text, /state_dir|argv/);

    const verbose = await definition.execute(
      "call-3",
      { action: "status", run_id: stateDir, verbose: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(verbose.content[0].text, /"argv"/);
    assert.match(verbose.content[0].text, /"template"/);

    const cancelled = await definition.execute(
      "call-4",
      { action: "cancel", run_id: stateDir },
      undefined,
      undefined,
      ctx,
    );
    assert.match(cancelled.content[0].text, /run=.*compact cancel=sent/);
    assert.doesNotMatch(cancelled.content[0].text, /state_dir|argv/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
        timeout: { kind: "int" },
      },
      args: ["file", "timeout", "speed", "dry_run", "mode", "prompts"],
      defaults: { dry_run: "true", mode: "check" },
      description: "Run checker",
      name: "check_tool",
      storedArgs: ["file:path", "timeout:int", "speed:number", "dry_run:bool", "mode:enum(check,fix)", "prompts:array"],
      storedDefaults: { dry_run: "true", mode: "check" },
      template: "check {file} {timeout} {speed} {dry_run} {mode} {prompts}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.file.type, "string");
  assert.equal(properties.timeout.type, "integer");
  assert.equal(properties.speed.type, "number");
  assert.equal(properties.dry_run.type, "boolean");
  assert.deepEqual(properties.mode.enum, ["check", "fix"]);
  assert.equal(properties.prompts.type, "array");
  assert.deepEqual(definition.parameters.required, ["file", "timeout", "speed", "prompts"]);
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
