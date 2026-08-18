/** Pi-facing kernel tool contract tests. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { createRegisterToolDefinition } from "../lib/tools-register.ts";
import { createRuntimeToolDefinition } from "../lib/tools-local.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";
import { createActiveSkillRecipeContext } from "../lib/recipes-references.ts";

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
  assert.equal(properties.from.type, "string");
  assert.equal(properties.defaults.type, "object");
  assert.equal(properties.template.type, undefined);
  assert.equal(properties.update.type, "boolean");
  assert.equal(properties.values, undefined);
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

test("Spawn launches a qualified active-Skill Recipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-spawn-skill-"));
  const skillDir = join(root, "skill");
  const recipeDir = join(skillDir, "recipes");
  const runId = `spawn-skill-${process.pid}-${Date.now()}`;
  const stateDir = join(getRunStateRoot(), runId);
  try {
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill\n");
    await writeFile(
      join(recipeDir, "task.json"),
      JSON.stringify({
        template: `${process.execPath} -e "console.log(process.argv[1])" {skill_dir}`,
      }),
    );
    const activeSkillRecipeContext = createActiveSkillRecipeContext([
      { name: "sample", baseDir: skillDir },
    ]);
    const recipeResolutionContext = createRecipeResolutionContext(
      "spawn-tool-session",
      process.cwd(),
      activeSkillRecipeContext,
    );
    const spawn = createSpawnToolDefinition();
    const result = await spawn.execute(
      "call-skill-spawn",
      { as: `run:${runId}`, recipe: "sample/task" },
      undefined,
      undefined,
      { recipeResolutionContext, cwd: process.cwd() },
    );
    assert.equal(result.details.launch_kind, "spawn");
    assert.equal(result.details.recipe_file, join(recipeDir, "task.json"));
    assert.equal(result.details.values.skill_dir, skillDir);
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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

test("Runtime sync delegated Recipe tools use the resolved contract without ambient Skill lookup", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["path"],
      defaults: { path: "." },
      description: "Validate context",
      recipe: {
        args: ["path:path=."],
        defaults: { path: "." },
        name: "validate_context",
        template: "validate {path}",
      },
      name: "validate_context",
      template: "abcd-context/validate-context",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  assert.deepEqual(definition.parameters.required, []);
  assert.equal(definition.parameters.properties.run_id, undefined);
  assert.match(definition.promptSnippet, /Execute template recipe: validate_context/);
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
    assert.equal(result.details.launch_kind, "tool");
    assert.equal(result.details.model_policy.model.source, "inherited");
    assert.equal(result.details.model_policy.thinking.source, "inherited");
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
        state_dir: { kind: "path" },
      },
      args: [
        "file",
        "request_timeout",
        "speed",
        "dry_run",
        "mode",
        "prompts",
        "state_dir",
      ],
      defaults: { dry_run: "true", mode: "check" },
      description: "Run checker",
      name: "check_tool",
      template: "check {file} {request_timeout} {speed} {dry_run} {mode} {prompts} {state_dir}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.request_timeout.type, "integer");
  assert.equal(properties.speed.type, "number");
  assert.equal(properties.dry_run.type, "boolean");
  assert.deepEqual(properties.mode.enum, ["check", "fix"]);
  assert.equal(properties.prompts.type, "array");
  assert.equal(properties.state_dir, undefined);
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

test("Runtime Recipe arg declaration defaults remain optional", () => {
  for (const async of [false, true]) {
    const definition = createRuntimeToolDefinition(
      {
        args: ["text", "lang"],
        defaults: {},
        description: "Speak text",
        name: async ? "speak_run" : "speak",
        recipe: {
          async,
          args: ["text", "lang=ru"],
          template: "speak --text {text} --lang {lang}",
        },
        storedArgs: ["text", "lang"],
        template: "speak.json",
      },
      async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
    );
    assert.deepEqual(definition.parameters.required, ["text"]);
  }
});

test("Runtime Recipe values follow caller then values then defaults then inline precedence", async () => {
  const seen: string[][] = [];
  const definition = createRuntimeToolDefinition(
    {
      argTypes: { mode: { kind: "enum", values: ["inline", "default", "bound", "caller"] } },
      args: ["mode"],
      defaults: { mode: "default" },
      description: "Resolve mode",
      name: "resolve_mode",
      recipe: {
        args: ["mode:enum(inline,default,bound,caller)=inline"],
        defaults: { mode: "default" },
        values: { mode: "bound" },
        template: "resolve {mode}",
      },
      storedArgs: ["mode:enum(inline,default,bound,caller)"],
      template: "resolve.json",
    },
    async (command, args) => {
      seen.push([command, ...args]);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
  );
  await definition.execute("bound", {}, undefined, undefined, { cwd: "/work" });
  await definition.execute("caller", { mode: "caller" }, undefined, undefined, { cwd: "/work" });
  assert.deepEqual(seen.map((command) => command.at(-1)), ["bound", "caller"]);
});

test("Runtime async Recipe validates the selected bound enum value", async () => {
  const definition = createRuntimeToolDefinition(
    {
      argTypes: { mode: { kind: "enum", values: ["check", "fix"] } },
      args: ["mode"],
      defaults: { mode: "check" },
      description: "Resolve mode",
      name: "resolve_mode_run",
      recipe: {
        async: true,
        args: ["mode:enum(check,fix)=check"],
        values: { mode: "delete" },
        template: "resolve {mode}",
      },
      storedArgs: ["mode:enum(check,fix)"],
      template: "resolve.json",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  await mkdir(getRunStateRoot(), { recursive: true });
  await assert.rejects(
    definition.execute("invalid", {}, undefined, undefined, { cwd: "/work" }),
    /Argument mode must be one of: check, fix/,
  );
});
