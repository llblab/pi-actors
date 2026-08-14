/**
 * Registry regression tests
 * Covers register/update/delete behavior independently from pi-facing schema assembly
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { createActiveSkillRecipeContext } from "../lib/recipes-references.ts";
import { executeRegisterTool } from "../lib/registry.ts";

const execFileAsync = promisify(execFile);

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), "pi-actors-registry-"));
  const tools = new Map<string, RegisteredTool>();
  const notifications: string[] = [];
  const runtimeRegistered: string[] = [];
  let activeTools = ["read", "smoke"];
  return {
    activeTools: () => activeTools,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    deps: {
      configPath: join(dir, "tool-registry.json"),
      getActiveTools: () => activeTools,
      getToolNameBlocker: () => undefined,
      getTools: () => tools,
      notify: (_ctx: unknown, message: string) => notifications.push(message),
      registerRuntimeTool: (cfg: RegisteredTool) => {
        runtimeRegistered.push(cfg.name);
      },
      reservedToolNames: new Set(["bash", "register_tool"]),
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
    },
    notifications,
    root: join(dir, "recipes"),
    runtimeRegistered,
    tools,
  };
}

test("Registry mutations register template-backed tools", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        args: "file,lang=ru",
        description: "Transcribe audio",
        name: "Transcribe",
        template: "~/bin/transcribe {file} {lang}",
      },
      {},
      harness.deps,
    );
    assert.equal(harness.tools.get("transcribe")?.defaults.lang, "ru");
    const stored = JSON.parse(
      await readFile(join(dirname(harness.deps.configPath), "recipes", "transcribe.json"), "utf8"),
    );
    assert.deepEqual(stored, {
      description: "Transcribe audio",
      args: ["file", "lang"],
      defaults: { lang: "ru" },
      template: "~/bin/transcribe {file} {lang}",
    });
    assert.deepEqual(harness.runtimeRegistered, ["transcribe"]);
    assert.match(
      result.content[0].text,
      /Persisted tool "transcribe" from template; callable_now=false; activation_boundary=session_activation_unverified/,
    );
    assert.deepEqual(result.details.required_args, ["file"]);
    assert.deepEqual(result.details.optional_args, ["lang"]);
    assert.equal(result.details.source, "template");
    assert.equal(result.details.activation_boundary, "session_activation_unverified");
    assert.deepEqual(result.details.next_actions, [
      "inspect target=tool:transcribe view=status",
    ]);
    assert.equal("config" in result.details, false);
    assert.equal("template" in result.details, false);
  } finally {
    await harness.cleanup();
  }
});

test("Concurrent same-name registry mutations have one collision winner", async () => {
  const harness = await createHarness();
  try {
    const attempts = await Promise.allSettled([
      executeRegisterTool(
        { description: "First", name: "shared", template: "echo first" },
        {},
        harness.deps,
      ),
      executeRegisterTool(
        { description: "Second", name: "shared", template: "echo second" },
        {},
        harness.deps,
      ),
    ]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      ["fulfilled", "rejected"],
    );
    assert.match(
      String(attempts[1].status === "rejected" ? attempts[1].reason : ""),
      /already registered/,
    );
    const stored = JSON.parse(
      await readFile(join(dirname(harness.deps.configPath), "recipes", "shared.json"), "utf8"),
    );
    assert.equal(stored.template, "echo first");
  } finally {
    await harness.cleanup();
  }
});

test("Sibling processes cannot silently overwrite the same registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-registry-process-"));
  const registryUrl = new URL("../lib/registry.ts", import.meta.url).href;
  const childSource = (description: string, template: string) => `
    import { join } from "node:path";
    const { executeRegisterTool } = await import(${JSON.stringify(registryUrl)});
    const root = ${JSON.stringify(root)};
    const tools = new Map();
    const deps = {
      configPath: join(root, "registry.json"),
      recipeRoot: root,
      getActiveTools: () => [],
      getToolNameBlocker: () => undefined,
      getTools: () => tools,
      notify: () => {},
      registerRuntimeTool: () => {},
      reservedToolNames: new Set(),
      setActiveTools: () => {},
    };
    try {
      await executeRegisterTool(${JSON.stringify({ name: "shared", description, template })}, {}, deps);
      console.log("registered");
    } catch (error) {
      console.log("rejected:" + (error instanceof Error ? error.message : String(error)));
    }
  `;
  try {
    const attempts = await Promise.all([
      execFileAsync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childSource("First", "echo first"),
      ]),
      execFileAsync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childSource("Second", "echo second"),
      ]),
    ]);
    const outputs = attempts.map((attempt) => attempt.stdout.trim()).sort();
    assert.equal(outputs.filter((output) => output === "registered").length, 1);
    assert.equal(
      outputs.filter((output) => /rejected:[\s\S]*already registered/.test(output)).length,
      1,
      JSON.stringify(outputs),
    );
    const stored = JSON.parse(
      await readFile(join(root, "shared.json"), "utf8"),
    );
    assert.equal(["echo first", "echo second"].includes(stored.template), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Registry mutations register typed command-template args progressively", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        args: "file:path,request_timeout:int=60000,speed:number=1.5,dry_run:bool=true,mode:enum(check,fix)=check",
        description: "Run checker",
        name: "check_tool",
        template: "check {file} {request_timeout} {speed} {dry_run} {mode}",
      },
      {},
      harness.deps,
    );
    assert.deepEqual(harness.tools.get("check_tool")?.args, [
      "file",
      "request_timeout",
      "speed",
      "dry_run",
      "mode",
    ]);
    assert.deepEqual(harness.tools.get("check_tool")?.storedArgs, [
      "file:path",
      "request_timeout:int",
      "speed:number",
      "dry_run:bool",
      "mode:enum(check,fix)",
    ]);
    assert.deepEqual(harness.tools.get("check_tool")?.argTypes?.request_timeout, {
      kind: "int",
    });
    assert.deepEqual(harness.tools.get("check_tool")?.argTypes?.speed, {
      kind: "number",
    });
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations specialize active-Skill Recipes through from", async () => {
  const harness = await createHarness();
  try {
    const skillDir = join(dirname(harness.root), "skills", "media");
    await mkdir(join(skillDir, "recipes"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: media\n---\n");
    await writeFile(
      join(skillDir, "recipes", "player.json"),
      JSON.stringify({
        args: ["command:enum(play,status)", "volume:int", "state_dir:path"],
        artifacts: { state: "{state_dir}/state.json" },
        async: true,
        control: ["play", "status"],
        defaults: { command: "play", volume: 70 },
        description: "Control local media.",
        template: "echo {skill_dir} {command} {volume} {state_dir}",
      }),
    );
    const recipeResolutionContext = createRecipeResolutionContext(
      "registry-from",
      dirname(harness.root),
      createActiveSkillRecipeContext([{ name: "media", baseDir: skillDir }]),
    );
    const result = await executeRegisterTool(
      {
        defaults: { volume: 35 },
        from: "media/player",
        name: "music_player",
      },
      { recipeResolutionContext },
      harness.deps,
    );
    const stored = JSON.parse(
      await readFile(join(harness.root, "music_player.json"), "utf8"),
    );
    assert.deepEqual(stored, {
      defaults: { volume: 35 },
      template: "media/player",
    });
    const tool = harness.tools.get("music_player")!;
    assert.equal(tool.description, "Control local media.");
    assert.equal(tool.recipe?.async, true);
    assert.deepEqual(tool.recipe?.control, ["play", "status"]);
    assert.deepEqual(tool.recipe?.artifacts, { state: "{state_dir}/state.json" });
    assert.deepEqual(tool.args, ["command", "volume"]);
    assert.deepEqual(tool.argTypes?.command, {
      kind: "enum",
      values: ["play", "status"],
    });
    assert.deepEqual(tool.argTypes?.volume, { kind: "int" });
    assert.deepEqual(result.details.defaults, { command: "play", volume: "35" });
    assert.equal(result.details.async, true);
    await assert.rejects(
      executeRegisterTool(
        {
          defaults: { volume: "loud" },
          from: "media/player",
          name: "bad_volume",
        },
        { recipeResolutionContext },
        harness.deps,
      ),
      /Recipe source "media\/player" validation failed:.*volume.*integer.*Next: inspect target=recipes view=doctor identity=media\/player/is,
    );
    await assert.rejects(
      executeRegisterTool(
        {
          defaults: { unknown: "value" },
          from: "media/player",
          name: "bad_default",
        },
        { recipeResolutionContext },
        harness.deps,
      ),
      /Recipe source "media\/player" validation failed:.*Unknown delegated Recipe default argument: unknown.*Next: inspect target=recipes view=doctor identity=media\/player/is,
    );
    await assert.rejects(
      executeRegisterTool(
        {
          defaults: { state_dir: "/tmp/copied-state" },
          from: "media/player",
          name: "bad_origin",
        },
        { recipeResolutionContext },
        harness.deps,
      ),
      /runtime-owned.*state_dir.*Next: remove that default and retry register_tool/is,
    );
    await assert.rejects(readFile(join(harness.root, "bad_volume.json"), "utf8"));
    await assert.rejects(readFile(join(harness.root, "bad_default.json"), "utf8"));
    await assert.rejects(readFile(join(harness.root, "bad_origin.json"), "utf8"));
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations reject ambiguous or copied Recipe source modes", async () => {
  const harness = await createHarness();
  try {
    for (const [params, pattern] of [
      [
        { description: "Mixed", from: "media/player", name: "mixed", template: "echo" },
        /exactly one register_tool source mode.*Next: remove the extra source fields and retry register_tool/s,
      ],
      [
        { args: "source:path", from: "media/player", name: "copied_args" },
        /from inherits args and async behavior.*Next: retry register_tool with from and optional defaults only/s,
      ],
      [
        { name: "missing_source" },
        /requires exactly one source mode.*Next: retry register_tool with one source field/s,
      ],
      [
        { from: "", name: "empty_from" },
        /non-empty Recipe reference.*Next: retry register_tool with from=<skill>\/<recipe>/s,
      ],
      [
        { from: "skill:media/player", name: "prefixed_from" },
        /skill: Recipe references were removed.*Next: inspect target=recipes view=doctor identity=media\/player/s,
      ],
      [
        { from: "std:player", name: "std_from" },
        /std: Recipe references were removed.*Next: inspect target=recipes view=doctor/s,
      ],
      [
        { description: "Nested", name: "nested", template: { template: "media/player" } },
        /Nested Recipe-shaped templates.*Next: retry with from=<skill>\/<recipe> and defaults=/is,
      ],
      [
        { description: "Legacy values", name: "legacy_values", template: "echo", values: { x: 1 } },
        /values was removed.*Next: retry register_tool with defaults/is,
      ],
    ] as const) {
      await assert.rejects(executeRegisterTool(params, {}, harness.deps), pattern);
    }
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations specialize explicit Recipe paths through from", async () => {
  const harness = await createHarness();
  try {
    const cwd = dirname(harness.root);
    const sourceDir = join(cwd, "source");
    const sourcePath = join(sourceDir, "docs-review.json");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      sourcePath,
      JSON.stringify({
        args: ["scope:path", "model:string"],
        description: "Start docs review actor",
        template: "review {scope} {model}",
      }),
    );
    const recipeResolutionContext = createRecipeResolutionContext(
      "registry-file-from",
      cwd,
      createActiveSkillRecipeContext([]),
    );
    const result = await executeRegisterTool(
      {
        defaults: { model: "selected-model" },
        from: "./source/docs-review.json",
        name: "docs_review",
      },
      { recipeResolutionContext },
      harness.deps,
    );
    assert.equal(
      (harness.tools.get("docs_review")?.recipe?.template as { template: string })
        .template,
      "review {scope} {model}",
    );
    assert.deepEqual(harness.tools.get("docs_review")?.args, ["scope", "model"]);
    assert.deepEqual(harness.runtimeRegistered, ["docs_review"]);
    assert.equal(result.details.source, "./source/docs-review.json");
    assert.deepEqual(result.details.required_args, ["scope"]);
    assert.deepEqual(result.details.optional_args, ["model"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(harness.root, "docs_review.json"), "utf8")),
      { defaults: { model: "selected-model" }, template: sourcePath },
    );
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations apply defaults to co-located command Recipes", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        async: true,
        description: "Start review run",
        name: "review_run",
        defaults: { prompt: "Review risks." },
        template: "review {scope} {prompt}",
      },
      {},
      harness.deps,
    );
    const registeredRecipe = harness.tools.get("review_run")?.recipe;
    assert.equal(registeredRecipe?.async, true);
    assert.equal(registeredRecipe?.name, "review_run");
    assert.equal(registeredRecipe?.description, "Start review run");
    assert.equal(
      (registeredRecipe?.template as { template: string }).template,
      "review {scope} {prompt}",
    );
    const stored = JSON.parse(
      await readFile(join(harness.root, "review_run.json"), "utf8"),
    );
    assert.equal(stored.values, undefined);
    assert.deepEqual(stored.defaults, { prompt: "Review risks." });
    assert.deepEqual(registeredRecipe?.defaults, { prompt: "Review risks." });
    assert.deepEqual(harness.tools.get("review_run")?.args, ["scope", "prompt"]);
    assert.equal(result.details.async, true);
    assert.deepEqual(result.details.required_args, ["scope"]);
    assert.deepEqual(result.details.optional_args, [
      "prompt",
      "run_id",
      "transport_context",
    ]);
    assert.equal("recipeName" in result.details, false);
    assert.equal("state_dir" in result.details, false);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register command-template sequences", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        args: "text,mp3,ogg",
        description: "Create voice artifact",
        name: "voice_tool",
        template: [
          "tts --text {text} --out {mp3}",
          { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
        ],
      },
      {},
      harness.deps,
    );
    assert.equal(
      harness.tools.get("voice_tool")?.template,
      join(harness.root, "voice_tool.json"),
    );
    assert.deepEqual(harness.tools.get("voice_tool")?.recipe?.template, {
      args: ["text", "mp3", "ogg"],
      template: [
        "tts --text {text} --out {mp3}",
        { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
      ],
    });
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register object command templates", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        description: "Run guarded object template",
        name: "object_tool",
        template: {
          parallel: true,
          recover: "echo recovered",
          retry: 2,
          template: [
            "echo {topic}",
            { template: "echo done", timeout: 123 },
          ],
          timeout: 456,
        },
      },
      {},
      harness.deps,
    );
    assert.equal(
      harness.tools.get("object_tool")?.template,
      join(harness.root, "object_tool.json"),
    );
    assert.deepEqual(harness.tools.get("object_tool")?.recipe?.template, {
      parallel: true,
      recover: "echo recovered",
      retry: 2,
      template: [
        "echo {topic}",
        { template: "echo done", timeout: 123 },
      ],
      timeout: 456,
    });
    assert.deepEqual(harness.tools.get("object_tool")?.args, ["topic"]);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations reject invalid object command templates", async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Bad object template",
          name: "bad_object_tool",
          template: { repeat: 0, template: "echo nope" },
        },
        {},
        harness.deps,
      ),
      /repeat must be a positive integer/,
    );
    await assert.rejects(
      readFile(join(harness.root, "bad_object_tool.json"), "utf8"),
    );
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations reject overwrites without update=true", async () => {
  const harness = await createHarness();
  harness.tools.set("smoke", {
    args: [],
    defaults: {},
    description: "Old",
    name: "smoke",
    template: "old",
  });
  try {
    await assert.rejects(
      executeRegisterTool(
        {
          description: "New",
          name: "smoke",
          template: "new",
        },
        {},
        harness.deps,
      ),
      /already registered/,
    );
  } finally {
    await harness.cleanup();
  }
});

test("Registry activation failure restores prior bytes state and active tools", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        description: "Working tool",
        name: "working_tool",
        template: "echo working",
      },
      {},
      harness.deps,
    );
    const path = join(harness.root, "working_tool.json");
    const priorBytes = await readFile(path, "utf8");
    const priorActive = harness.activeTools();
    const failingDeps = {
      ...harness.deps,
      registerRuntimeTool: (cfg: RegisteredTool) =>
        cfg.description === "Broken replacement"
          ? {
              active_tool: false,
              activation: "unverified" as const,
              callable_now: false,
              host_registered: true,
            }
          : {
              active_tool: true,
              activation: "current_session" as const,
              callable_now: true,
              host_registered: true,
            },
    };
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Broken replacement",
          name: "working_tool",
          template: "echo broken",
          update: true,
        },
        {},
        failingDeps,
      ),
      /Tool "working_tool" activation failed at active_tool_set.*callable_now=false.*Registration was rolled back.*Next: inspect target=runtime view=status; do not use spawn as proof/s,
    );
    assert.equal(await readFile(path, "utf8"), priorBytes);
    assert.equal(harness.tools.get("working_tool")?.description, "Working tool");
    assert.deepEqual(harness.activeTools(), priorActive);
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Broken new tool",
          name: "broken_new",
          template: "echo broken",
        },
        {},
        {
          ...harness.deps,
          registerRuntimeTool: () => ({
            active_tool: false,
            activation: "unverified" as const,
            callable_now: false,
            host_registered: false,
          }),
        },
      ),
      /Tool "broken_new" activation failed at host_registration.*callable_now=false.*Registration was rolled back.*Next: inspect target=runtime view=status; do not use spawn as proof/s,
    );
    await assert.rejects(readFile(join(harness.root, "broken_new.json"), "utf8"));
    assert.equal(harness.tools.has("broken_new"), false);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations delete tools and deactivate them", async () => {
  const harness = await createHarness();
  harness.tools.set("smoke", {
    args: [],
    defaults: {},
    description: "Old",
    name: "smoke",
    template: "old",
  });
  try {
    const result = await executeRegisterTool(
      {
        name: "smoke",
        template: null,
      },
      {},
      harness.deps,
    );
    assert.equal(harness.tools.has("smoke"), false);
    assert.deepEqual(harness.activeTools(), ["read"]);
    assert.match(result.content[0].text, /Deleted tool "smoke"/);
  } finally {
    await harness.cleanup();
  }
});
