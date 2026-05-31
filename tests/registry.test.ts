/**
 * Registry regression tests
 * Covers register/update/delete behavior independently from pi-facing schema assembly
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { executeRegisterTool } from "../lib/registry.ts";

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

test("Registry mutations register template recipe paths through template", async () => {
  const harness = await createHarness();
  try {
    const result = await executeRegisterTool(
      {
        args: "scope:path,model:string=selected-model",
        description: "Start docs review actor",
        name: "docs_review",
        template: "docs-review.json",
      },
      {},
      harness.deps,
    );
    assert.equal(harness.tools.get("docs_review")?.template, "docs-review.json");
    assert.deepEqual(harness.tools.get("docs_review")?.args, ["scope", "model"]);
    assert.deepEqual(harness.runtimeRegistered, ["docs_review"]);
    assert.equal(result.details.template, "docs-review.json");
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
        state_dir: "~/.pi/agent/tmp/pi-actors/runs/review-docs",
        template: "review {scope}",
        values: { prompt: "Review risks." },
      },
      {},
      harness.deps,
    );
    assert.deepEqual(harness.tools.get("review_run")?.recipe, {
      async: true,
      name: "review_run",
      state_dir: "~/.pi/agent/tmp/pi-actors/runs/review-docs",
      template: "review {scope}",
      values: { prompt: "Review risks." },
    });
    assert.deepEqual(harness.tools.get("review_run")?.args, ["scope"]);
    assert.equal(result.details.async, true);
    assert.equal(result.details.recipeName, "review_run");
    assert.equal(
      result.details.state_dir,
      "~/.pi/agent/tmp/pi-actors/runs/review-docs",
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
    assert.deepEqual(harness.tools.get("object_tool")?.template, {
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
