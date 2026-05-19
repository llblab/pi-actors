/**
 * Registry regression tests
 * Covers register/update/delete behavior independently from pi-facing schema assembly
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { executeRegisterTool } from "../lib/registry.ts";

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), "pi-auto-tools-registry-"));
  const tools = new Map<string, RegisteredTool>();
  const notifications: string[] = [];
  const runtimeRegistered: string[] = [];
  let activeTools = ["read", "smoke"];
  return {
    activeTools: () => activeTools,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    deps: {
      configPath: join(dir, "auto-tools.json"),
      getActiveTools: () => activeTools,
      getExternalToolConflict: () => undefined,
      getTools: () => tools,
      notify: (_ctx: unknown, message: string) => notifications.push(message),
      registerRuntimeTool: (cfg: RegisteredTool) =>
        runtimeRegistered.push(cfg.name),
      reservedToolNames: new Set(["bash", "register_tool"]),
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
    },
    notifications,
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
    assert.deepEqual(harness.runtimeRegistered, ["transcribe"]);
    assert.match(result.content[0].text, /Registered tool "transcribe"/);
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register typed command-template args progressively", async () => {
  const harness = await createHarness();
  try {
    await executeRegisterTool(
      {
        args: "file:path,timeout:int=60000,speed:number=1.5,dry_run:bool=true,mode:enum(check,fix)=check",
        description: "Run checker",
        name: "check_tool",
        template: "check {file} {timeout} {speed} {dry_run} {mode}",
      },
      {},
      harness.deps,
    );
    assert.deepEqual(harness.tools.get("check_tool")?.args, [
      "file",
      "timeout",
      "speed",
      "dry_run",
      "mode",
    ]);
    assert.deepEqual(harness.tools.get("check_tool")?.storedArgs, [
      "file:path",
      "timeout:int",
      "speed:number",
      "dry_run:bool",
      "mode:enum(check,fix)",
    ]);
    assert.deepEqual(harness.tools.get("check_tool")?.argTypes?.timeout, {
      kind: "int",
    });
    assert.deepEqual(harness.tools.get("check_tool")?.argTypes?.speed, {
      kind: "number",
    });
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register template recipe paths through template", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        args: "theme,out_dir=latest",
        description: "Start shader ring recipe",
        name: "shader_run",
        template: "shader-ring-8-parallel.json",
      },
      {},
      harness.deps,
    );
    assert.equal(
      harness.tools.get("shader_run")?.template,
      "shader-ring-8-parallel.json",
    );
    assert.deepEqual(harness.tools.get("shader_run")?.args, [
      "theme",
      "out_dir",
    ]);
    assert.deepEqual(harness.runtimeRegistered, ["shader_run"]);
    assert.equal(result.details.template, "shader-ring-8-parallel.json");
  } finally {
    await harness.cleanup();
  }
});

test("Registry mutations register co-located template recipes", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        async: true,
        description: "Start review run",
        name: "review_run",
        state_dir: "~/.pi/agent/tmp/pi-auto-tools/runs/review-docs",
        template: "review {scope}",
        values: { prompt: "Review risks." },
      },
      {},
      harness.deps,
    );
    assert.deepEqual(harness.tools.get("review_run")?.recipe, {
      async: true,
      name: "review_run",
      state_dir: "~/.pi/agent/tmp/pi-auto-tools/runs/review-docs",
      template: "review {scope}",
      values: { prompt: "Review risks." },
    });
    assert.deepEqual(harness.tools.get("review_run")?.args, ["scope"]);
    assert.equal(result.details.async, true);
    assert.equal(result.details.recipeName, "review_run");
    assert.equal(
      result.details.state_dir,
      "~/.pi/agent/tmp/pi-auto-tools/runs/review-docs",
    );
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
    assert.deepEqual(harness.tools.get("voice_tool")?.template, [
      "tts --text {text} --out {mp3}",
      { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
    ]);
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
