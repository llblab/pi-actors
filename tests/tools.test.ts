/**
 * Pi-facing tool definition tests
 * Covers schema generation without relying on external schema-builder resolution
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import {
  createJobToolDefinition,
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
  assert.equal(properties.job.type, "string");
  assert.equal(properties.state_dir.type, "string");
  assert.equal(properties.values.type, "object");
  assert.equal(properties.update.type, "boolean");
  assert.equal(Array.isArray(properties.template.anyOf), true);
});

test("Template job tool definition exposes action schema", () => {
  const definition = createJobToolDefinition({ getTools: () => new Map() });
  assert.equal(definition.name, "template_job");
  assert.deepEqual(definition.parameters.required, ["action"]);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.action.type, "string");
  assert.match(properties.action.description, /kill/);
  assert.equal(Array.isArray(properties.template.anyOf), true);
});

test("Runtime tool definition exposes job id override for job recipe template paths", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["theme"],
      defaults: {},
      description: "Start shader job",
      name: "shader_job",
      storedArgs: ["theme"],
      template: "shader-ring-8-parallel.json",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.deepEqual(definition.parameters.required, ["theme"]);
  assert.equal(properties.theme.type, "string");
  assert.equal(properties.job_id.type, "string");
  assert.match(definition.promptSnippet, /Start template job recipe/);
});

test("Runtime tool definition exposes job id override for co-located job recipes", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["scope"],
      defaults: {},
      description: "Start review job",
      jobRecipe: {
        job: "review",
        template: "review {scope}",
      },
      name: "review_job",
      template: "review {scope}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.deepEqual(definition.parameters.required, ["scope"]);
  assert.equal(properties.scope.type, "string");
  assert.equal(properties.job_id.type, "string");
  assert.match(definition.promptSnippet, /review/);
});

test("Runtime tool definition exposes typed arg schemas", () => {
  const definition = createRuntimeToolDefinition(
    {
      argTypes: {
        dry_run: { kind: "bool" },
        mode: { kind: "enum", values: ["check", "fix"] },
        speed: { kind: "number" },
        timeout: { kind: "int" },
      },
      args: ["file", "timeout", "speed", "dry_run", "mode"],
      defaults: { dry_run: "true", mode: "check" },
      description: "Run checker",
      name: "check_tool",
      storedArgs: ["file:path", "timeout:int", "speed:number", "dry_run:bool", "mode:enum(check,fix)"],
      storedDefaults: { dry_run: "true", mode: "check" },
      template: "check {file} {timeout} {speed} {dry_run} {mode}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.file.type, "string");
  assert.equal(properties.timeout.type, "integer");
  assert.equal(properties.speed.type, "number");
  assert.equal(properties.dry_run.type, "boolean");
  assert.deepEqual(properties.mode.enum, ["check", "fix"]);
  assert.deepEqual(definition.parameters.required, ["file", "timeout", "speed"]);
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
