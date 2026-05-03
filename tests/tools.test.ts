/**
 * Pi-facing tool definition tests
 * Covers schema generation without relying on external schema-builder resolution
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import {
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

test("Register tool definition exposes a JSON schema with name as the only required field", () => {
  const definition = createRegisterToolDefinition(createRegistryDeps());
  assert.equal(definition.name, "register_tool");
  assert.deepEqual(definition.parameters.required, ["name"]);
  assert.equal(definition.parameters.properties.name.type, "string");
  assert.equal(definition.parameters.properties.update.type, "boolean");
  assert.equal(Array.isArray(definition.parameters.properties.template.anyOf), true);
});

test("Runtime tool definition marks defaulted args optional", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["file", "lang"],
      defaults: { lang: "ru" },
      description: "Transcribe audio",
      label: "Transcribe",
      name: "transcribe",
      template: "transcribe {file} {lang}",
    },
    async () => ({ stdout: "ok" }),
  );
  assert.deepEqual(definition.parameters.required, ["file"]);
  assert.equal(definition.parameters.properties.file.type, "string");
  assert.equal(definition.parameters.properties.lang.type, "string");
});
