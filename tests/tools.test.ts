/** Pi-facing kernel tool contract tests. */

import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import { createRegisterToolDefinition } from "../lib/tools-register.ts";
import { createRuntimeToolDefinition } from "../lib/tools-local.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";

function createRegistryDeps() {
  return {
    configPath: "/tmp/tool-registry.json",
    getActiveTools: () => [],
    getToolNameBlocker: () => undefined,
    getTools: () => new Map<string, RegisteredTool>(),
    notify: () => undefined,
    registerRuntimeTool: () => undefined,
    reservedToolNames: new Set<string>(),
    setActiveTools: () => undefined,
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`file did not appear: ${path}`);
}

test("Register tool definition exposes an optional exact schema", () => {
  const definition = createRegisterToolDefinition(createRegistryDeps());
  assert.equal(definition.name, "register_tool");
  assert.deepEqual(definition.parameters.required, []);
  const properties = definition.parameters.properties as Record<string, { type?: string }>;
  assert.equal(properties.name.type, "string");
  assert.equal(properties.template.type, undefined);
  assert.equal(properties.update.type, "boolean");
});

test("Spawn tool definition exposes Run creation without communication fields", () => {
  const definition = createSpawnToolDefinition();
  const properties = definition.parameters.properties as Record<string, unknown>;
  assert.equal(definition.name, "spawn");
  assert.ok(properties.recipe);
  assert.ok(properties.template);
  assert.ok(properties.values);
  assert.equal(properties.correlation_id, undefined);
  assert.ok(properties.transport_context);
});

test("Runtime async Recipe tools expose optional run_id", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["scope"],
      defaults: {},
      description: "Start review Run",
      recipe: { async: true, name: "review", template: "review {scope}" },
      name: "review_run",
      template: "review {scope}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, { type?: string }>;
  assert.deepEqual(definition.parameters.required, ["scope"]);
  assert.equal(properties.run_id.type, "string");
  assert.match(definition.promptSnippet, /Start async template recipe: review/);
});

test("Runtime async tools persist inherited policy provenance", async () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["model", "thinking"],
      defaults: { model: "{current_model}", thinking: "{current_thinking}" },
      description: "Start policy Run",
      recipe: {
        async: true,
        args: ["model:string", "thinking:string"],
        defaults: { model: "{current_model}", thinking: "{current_thinking}" },
        name: "policy",
        template: `${process.execPath} -e "console.log(process.argv[1], process.argv[2])" {model} {thinking}`,
      },
      name: "policy_run",
      template: "policy",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const runId = `runtime-policy-${process.pid}-${Date.now()}`;
  const stateDir = join(getRunStateRoot(), runId);
  try {
    const result = await definition.execute(
      "call-runtime-current-policy",
      { run_id: runId },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        getThinkingLevel: () => "medium",
        model: { provider: "test-provider", id: "test-model" },
      },
    );
    const runMeta = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
    assert.deepEqual(runMeta.launch_correlation, {
      tool_call_id: "call-runtime-current-policy",
    });
    assert.equal(result.details.model_policy.model.source, "inherited");
    assert.equal(result.details.model_policy.thinking.source, "inherited");
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
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
      template: "check {file} {request_timeout} {speed} {dry_run} {mode} {prompts}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.request_timeout.type, "integer");
  assert.equal(properties.speed.type, "number");
  assert.equal(properties.dry_run.type, "boolean");
  assert.deepEqual(properties.mode.enum, ["check", "fix"]);
  assert.equal(properties.prompts.type, "array");
  assert.deepEqual(definition.parameters.required, ["file", "request_timeout", "speed", "prompts"]);
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
    definition.execute("call", { file: "README.md", mode: "delete" }, undefined, undefined, { cwd: "/work" }),
    /Argument mode must be one of: check, fix[\s\S]*Expected call shape/,
  );
});

test("Runtime inline defaults remain optional", () => {
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
