/** Pi-facing kernel tool contract tests. */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeFixtureBirth, captureFixtureBirths, bindFixtureBirth, joinFixtureRunners, requireFreshFixtureAbsence, throwFixtureErrors } from "./fixtures/runner-completion.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { createRegisterToolDefinition } from "../lib/tools-register.ts";
import { createCoreActorToolDefinitions, createLegacyActorToolDefinitions, LEGACY_TOOL_NAMES, RESERVED_TOOL_NAMES } from "../lib/tools.ts";
import { createRuntimeToolDefinition } from "../lib/tools-local.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";
import { createActiveSkillRecipeContext } from "../lib/recipes-references.ts";

test("Canonical actor tools have one explicit compatible dispatch map and unchanged contracts", () => {
  const registry = createRegistryDeps();
  const definitions = createCoreActorToolDefinitions({
    ...registry, getRecipeResolutionContext: () => undefined,
    getRuntimeTool: () => undefined, getRuntimeToolStatus: () => undefined,
    registryRuntime: { ...registry, getStatus: () => ({ active_tool_count: 0,
      last_scan_counts: { active: 0, rejected: 0, scanned: 0 }, registry_generation: 0,
      watch_status: "closed", watched_root: "fixture" }) },
  });
  assert.deepEqual(definitions.map(tool => tool.name), Object.values(LEGACY_TOOL_NAMES));
  const legacy = createLegacyActorToolDefinitions(definitions);
  for (const tool of legacy) {
    const canonical = definitions.find(item => item.name === LEGACY_TOOL_NAMES[tool.name as keyof typeof LEGACY_TOOL_NAMES])!;
    assert.equal(tool.parameters, canonical.parameters);
    assert.equal(tool.execute, canonical.execute);
    assert.equal(tool.exposure, "deferred");
    assert.equal(tool.promptSnippet, undefined); assert.equal(tool.promptGuidelines, undefined);
    assert.deepEqual((tool.prepareLoadout as () => unknown)(), { hiddenDeclarations: Object.keys(LEGACY_TOOL_NAMES) });
    assert.ok(RESERVED_TOOL_NAMES.has(tool.name)); assert.ok(RESERVED_TOOL_NAMES.has(canonical.name));
  }
  assert.match(String(definitions[2].description), /Run\/runtime.*not chat/);
  assert.throws(() => createLegacyActorToolDefinitions([]), /Missing canonical/);
});

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

test("Synthetic runner completion gates require original close, canonical zero and fresh dead under one watchdog", async () => {
  for (const outcome of ["success", "missing", "malformed", "nonzero", "bad-close", "signal", "alive", "unknown", "timeout"] as const) {
    const child = Object.assign(new EventEmitter(), { pid: 123 });
    const birth = observeFixtureBirth(child);
    let reads = 0, probes = 0, canceled = 0, expire!: () => void;
    const missing = Object.assign(new Error("missing canonical result"), { code: "ENOENT" });
    const joined = joinFixtureRunners([{ birth, path: "synthetic/result.json" }], {
      async read() {
        reads++;
        if (outcome === "missing") throw missing;
        return outcome === "malformed" ? "{" : JSON.stringify({ code: outcome === "nonzero" ? 7 : 0 });
      },
      liveness() { probes++; return outcome === "alive" ? "alive" : outcome === "unknown" ? "unknown" : "dead"; },
      watchdog(callback, ms) { assert.equal(ms, 10_000); expire = callback; return () => { canceled++; }; },
    });
    // A readable result alone cannot admit; no result read occurs before close.
    await Promise.resolve();
    assert.equal(reads, 0); assert.equal(probes, 0);
    let admitted = false;
    const settled = joined.then(() => { admitted = true; return { ok: true as const }; }, (error: unknown) => ({ ok: false as const, error }));
    if (outcome === "timeout") expire();
    else child.emit("close", outcome === "bad-close" ? 1 : 0, outcome === "signal" ? "SIGTERM" : null);
    const result = await settled;
    assert.equal(admitted, outcome === "success");
    assert.equal(result.ok, outcome === "success");
    assert.equal(canceled, 1);
    if (outcome === "timeout") {
      if (!result.ok) assert.deepEqual(JSON.parse((result.error as Error).message.split("entries_at_join=")[1]),
        [{ path: "synthetic/result.json", pid: 123 }]);
      assert.equal(birth.close, undefined); assert.equal(reads, 0);
      child.emit("close", 0, null); await Promise.resolve();
      assert.equal(reads, 0); // Expiry cannot later admit or read a result.
    } else assert.equal(reads, outcome === "bad-close" || outcome === "signal" ? 0 : 1); // Missing/invalid after close is a prompt failure, not readiness polling.
    if (!result.ok && outcome === "missing") assert.equal(result.error, missing);
    if (outcome === "success") {
      assert.equal(probes, 1);
      assert.throws(() => requireFreshFixtureAbsence(birth, () => "alive"));
      requireFreshFixtureAbsence(birth, () => "dead");
    }
    assert.throws(() => bindFixtureBirth([], 123));
    assert.throws(() => bindFixtureBirth([birth, birth], 123));
    assert.equal(bindFixtureBirth([birth], 123), birth);
  }
  const child = Object.assign(new EventEmitter(), { pid: 456 }), birth = observeFixtureBirth(child);
  let releaseRead!: (text: string) => void, expire!: () => void, probes = 0;
  const joined = joinFixtureRunners([{ birth, path: "synthetic/deferred-result.json" }], {
    read: () => new Promise<string>(resolve => { releaseRead = resolve; }),
    liveness: () => { probes++; return "dead"; },
    watchdog: callback => { expire = callback; return () => undefined; },
  });
  const rejected = assert.rejects(joined, /watchdog expired/);
  child.emit("close", 0, null); await Promise.resolve();
  assert.equal(typeof releaseRead, "function");
  expire(); await rejected;
  releaseRead(JSON.stringify({ code: 0 })); await Promise.resolve();
  assert.equal(probes, 0, "A read resolving after expiry cannot admit or probe liveness");
});

test("Register tool definition exposes an optional exact schema", () => {
  const definition = createRegisterToolDefinition(createRegistryDeps());
  assert.equal(definition.name, "actors_tool_register");
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
  assert.equal(definition.name, "actors_run_spawn");
  assert.deepEqual(definition.parameters.required, []);
  assert.deepEqual(properties.verbose, { type: "boolean", description: "Return full YAML instead of compact text." });
  assert.ok(properties.recipe);
  assert.ok(properties.template);
  assert.ok(properties.values);
  assert.equal(properties.correlation_id, undefined);
  assert.ok(properties.transport_context);
});

test("Spawn launches a qualified active-Skill Recipe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-spawn-skill-"));
  const skillDir = join(root, "skill");
  const recipeDir = join(skillDir, "recipes");
  const runId = `spawn-skill-${process.pid}-${Date.now()}`;
  const stateDir = join(getRunStateRoot(), runId);
  const capture = captureFixtureBirths(t); let dispatched = false, accepted = false;
  const errors: unknown[] = [];
  try {
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill\n");
    await writeFile(
      join(recipeDir, "task.json"),
      JSON.stringify({
        template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1])" {skill_dir}`,
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
    dispatched = true;
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
    assert.equal(capture.births.length, 1); assert.equal(capture.births[0].pid, result.details.pid);
    await joinFixtureRunners([{ path: join(stateDir, "result.json"), birth: bindFixtureBirth(capture.births, result.details.pid) }]);
    assert.equal(JSON.parse(await readFile(join(stateDir, "result.json"), "utf8")).code, 0);
    assert.deepEqual(capture.births[0].close, { code: 0, signal: null }); accepted = true;
  } catch (error) { errors.push(error); }
  finally {
    try { capture.restore(); } catch (error) { errors.push(error); }
    if (errors.length === 0) try {
      if (accepted) {
        requireFreshFixtureAbsence(capture.births[0]);
        await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        requireFreshFixtureAbsence(capture.births[0]);
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } else if (!dispatched) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) { errors.push(error); }
    // Failed/unknown launches retain both state and Skill files.
  }
  throwFixtureErrors(errors);
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

test("Runtime async tools persist inherited policy provenance", async (t) => {
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
        template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv[1], process.argv[2])" {model} {thinking}`,
      },
      name: "policy_run",
      template: "policy",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const runId = `runtime-policy-${process.pid}-${Date.now()}`;
  const stateDir = join(getRunStateRoot(), runId);
  const capture = captureFixtureBirths(t); let accepted = false;
  const errors: unknown[] = [];
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
    assert.equal(capture.births.length, 1); assert.equal(capture.births[0].pid, result.details.pid);
    await joinFixtureRunners([{ path: join(stateDir, "result.json"), birth: bindFixtureBirth(capture.births, result.details.pid) }]);
    assert.equal(JSON.parse(await readFile(join(stateDir, "result.json"), "utf8")).code, 0);
    assert.deepEqual(capture.births[0].close, { code: 0, signal: null }); accepted = true;
  } catch (error) { errors.push(error); }
  finally {
    try { capture.restore(); } catch (error) { errors.push(error); }
    if (errors.length === 0 && accepted) try {
      requireFreshFixtureAbsence(capture.births[0]);
      await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) { errors.push(error); }
  }
  throwFixtureErrors(errors);
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
