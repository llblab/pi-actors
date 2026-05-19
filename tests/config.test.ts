/**
 * Config registry regression tests
 * Covers stored tool normalization, legacy script rejection, duplicate handling, and atomic save/load
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadToolConfig,
  normalizeStoredTool,
  saveTools,
  serializeTools,
  type RegisteredTool,
} from "../lib/config.ts";

const reserved = new Set(["bash", "register_tool"]);

test("Stored tool normalization accepts template-backed tools", () => {
  const result = normalizeStoredTool(
    "Transcribe",
    {
      template: "~/bin/transcribe {file} {lang}",
      args: ["file", "lang=ru"],
      description: "Transcribe audio",
    },
    reserved,
  );
  assert.equal(result.warning, undefined);
  assert.equal(result.changed, true);
  assert.deepEqual(result.cfg, {
    name: "transcribe",
    description: "Transcribe audio",
    template: "~/bin/transcribe {file} {lang}",
    args: ["file", "lang"],
    defaults: { lang: "ru" },
    storedArgs: ["file", "lang"],
    storedDefaults: { lang: "ru" },
  });
});

test("Stored tool normalization accepts typed arg declarations", () => {
  const result = normalizeStoredTool(
    "check_tool",
    {
      template: "check {file} {timeout} {speed} {dry_run} {mode}",
      args: ["file:path", "timeout:int=60000", "speed:number=1.5", "dry_run:bool=true", "mode:enum(check,fix)=check"],
      description: "Run checker",
    },
    reserved,
  );
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.cfg?.args, ["file", "timeout", "speed", "dry_run", "mode"]);
  assert.deepEqual(result.cfg?.storedArgs, ["file:path", "timeout:int", "speed:number", "dry_run:bool", "mode:enum(check,fix)"]);
  assert.deepEqual(result.cfg?.storedDefaults, {
    dry_run: "true",
    mode: "check",
    speed: "1.5",
    timeout: "60000",
  });
  assert.deepEqual(result.cfg?.argTypes?.speed, { kind: "number" });
  assert.deepEqual(result.cfg?.argTypes?.mode, { kind: "enum", values: ["check", "fix"] });
});

test("Stored tool normalization derives typed args from inline template placeholders", () => {
  const result = normalizeStoredTool(
    "inline_typed",
    {
      description: "Run inline typed checker",
      template: "check {file:path} {timeout:int=60000} {speed:number=1.5} {mode:enum(check,fix)=check}",
    },
    reserved,
  );
  assert.deepEqual(result.cfg?.args, ["file", "timeout", "speed", "mode"]);
  assert.deepEqual(result.cfg?.argTypes?.timeout, { kind: "int" });
  assert.deepEqual(result.cfg?.argTypes?.speed, { kind: "number" });
  assert.deepEqual(result.cfg?.argTypes?.mode, { kind: "enum", values: ["check", "fix"] });
});

test("Stored tool normalization derives args from standard inline placeholders", () => {
  const result = normalizeStoredTool(
    "transcribe_groq",
    {
      description: "Transcribe audio",
      template: "~/bin/transcribe {file} {lang=ru} {model=whisper}",
    },
    reserved,
  );
  assert.equal(result.changed, false);
  assert.deepEqual(result.cfg?.args, ["file", "lang", "model"]);
  assert.deepEqual(result.cfg?.defaults, {});
  assert.equal(result.cfg?.storedArgs, undefined);
});

test("Stored tool normalization accepts template recipe paths in template", () => {
  const result = normalizeStoredTool(
    "shader_launcher",
    {
      args: ["theme", "out_dir=latest"],
      description: "Start shader job",
      template: "shader-ring-8-parallel.json",
    },
    reserved,
  );
  assert.equal(result.warning, undefined);
  assert.equal(result.changed, true);
  assert.deepEqual(result.cfg, {
    name: "shader_launcher",
    description: "Start shader job",
    args: ["theme", "out_dir"],
    defaults: { out_dir: "latest" },
    template: "shader-ring-8-parallel.json",
    storedArgs: ["theme", "out_dir"],
    storedDefaults: { out_dir: "latest" },
  });
});

test("Stored tool normalization accepts co-located template recipes", () => {
  const result = normalizeStoredTool(
    "review_launcher",
    {
      async: true,
      description: "Start review run",
      name: "review-docs",
      state_dir: "~/.pi/agent/tmp/pi-auto-tools/runs/review-docs",
      template: "review {scope}",
      values: { prompt: "Review risks." },
    },
    reserved,
  );
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.cfg, {
    name: "review_launcher",
    description: "Start review run",
    args: ["scope"],
    defaults: {},
    recipe: {
      async: true,
      name: "review-docs",
      state_dir: "~/.pi/agent/tmp/pi-auto-tools/runs/review-docs",
      template: "review {scope}",
      values: { prompt: "Review risks." },
    },
    template: "review {scope}",
  });
});

test("Stored tool normalization rejects co-located template recipes with tool", () => {
  const result = normalizeStoredTool(
    "review_launcher",
    {
      description: "Start review run",
      name: "review-docs",
      template: "review {scope}",
      tool: "review_tool",
    },
    reserved,
  );
  assert.equal(result.cfg, undefined);
  assert.match(result.warning ?? "", /cannot define tool/);
});

test("Stored tool normalization derives args from existing template recipe files", async () => {
  const path = join(homedir(), ".pi", "agent", "recipes", "derive-args-test.json");
  try {
    await mkdir(join(homedir(), ".pi", "agent", "recipes"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ name: "derive-args-test", template: "review {scope} {mode=fast}" }),
    );
    const result = normalizeStoredTool(
      "derive_job",
      {
        description: "Start derived job",
        template: "derive-args-test.json",
      },
      reserved,
    );
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.cfg?.args, ["scope", "mode"]);
  } finally {
    await rm(path, { force: true });
  }
});

test("Stored tool normalization derives args from compact repeated template recipe files", async () => {
  const path = join(homedir(), ".pi", "agent", "recipes", "derive-repeat-args-test.json");
  try {
    await mkdir(join(homedir(), ".pi", "agent", "recipes"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        name: "derive-repeat-args-test",
        mode: "parallel",
        repeat: 3,
        template: "render {scope} page{_(index+1)}.html prev=page{_(prev+1)}.html zero=page{_index}.html",
      }),
    );
    const result = normalizeStoredTool(
      "derive_repeat_job",
      {
        description: "Start derived repeated job",
        template: "derive-repeat-args-test.json",
      },
      reserved,
    );
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.cfg?.args, ["scope"]);
    assert.deepEqual(result.cfg?.defaults, {});
  } finally {
    await rm(path, { force: true });
  }
});

test("Stored tool normalization derives args from template recipe recover fields", async () => {
  const path = join(homedir(), ".pi", "agent", "recipes", "derive-recover-args-test.json");
  try {
    await mkdir(join(homedir(), ".pi", "agent", "recipes"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        failure: "branch",
        name: "derive-recover-args-test",
        recover: "cleanup {work_dir}",
        retry: 2,
        template: "run {scope}",
      }),
    );
    const result = normalizeStoredTool(
      "derive_recover_job",
      {
        description: "Start derived recover job",
        template: "derive-recover-args-test.json",
      },
      reserved,
    );
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.cfg?.args, ["scope", "work_dir"]);
  } finally {
    await rm(path, { force: true });
  }
});

test("Stored tool normalization derives args from recover templates", () => {
  const result = normalizeStoredTool(
    "recovering_tool",
    {
      description: "Run with cleanup",
      template: [
        {
          recover: "cleanup {work_dir}",
          retry: 2,
          template: "run {scope}",
        },
      ],
    },
    reserved,
  );
  assert.deepEqual(result.cfg?.args, ["scope", "work_dir"]);
});

test("Stored tool normalization accepts command-template sequences", () => {
  const result = normalizeStoredTool(
    "voice",
    {
      template: [
        "tts --text {text} --out {mp3}",
        { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
      ],
      args: ["text", "mp3", "ogg"],
      description: "Create voice artifact",
    },
    reserved,
  );
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.cfg?.template, [
    "tts --text {text} --out {mp3}",
    { template: "ffmpeg -i {mp3} {ogg}", timeout: 123 },
  ]);
});

test("Stored tool normalization rejects legacy script entries", () => {
  const result = normalizeStoredTool("old", { script: "~/bin/old" }, reserved);
  assert.equal(result.cfg, undefined);
  assert.equal(result.changed, false);
  assert.match(result.warning ?? "", /legacy script config/);
});

test("Stored tool normalization rejects legacy job or recipe fields", () => {
  const jobResult = normalizeStoredTool("old_job", { job: "review", template: "review {scope}" }, reserved);
  const recipeResult = normalizeStoredTool("old_recipe", { recipe: "review", template: "review {scope}" }, reserved);
  assert.equal(jobResult.cfg, undefined);
  assert.equal(recipeResult.cfg, undefined);
  assert.match(jobResult.warning ?? "", /legacy job\/recipe config/);
  assert.match(recipeResult.warning ?? "", /legacy job\/recipe config/);
});

test("Stored tool normalization rejects recipe entries without templates", () => {
  const result = normalizeStoredTool(
    "mixed",
    { name: "mixed-recipe", description: "Mixed" },
    reserved,
  );
  assert.equal(result.cfg, undefined);
  assert.match(result.warning ?? "", /recipe config without template/);
});

test("Serialized tool entries keep template last", () => {
  const tool: RegisteredTool = {
    name: "voice",
    description: "Create voice artifact",
    template: "tts {text}",
    args: ["text"],
    defaults: {},
    storedArgs: ["text"],
  };
  assert.deepEqual(Object.keys(serializeTools(new Map([[tool.name, tool]])).voice as Record<string, unknown>), [
    "description",
    "args",
    "template",
  ]);
});

test("Serialized co-located template recipe launchers keep recipe metadata before template", () => {
  const tool: RegisteredTool = {
    name: "review",
    description: "Start review",
    recipe: {
      async: true,
      name: "review",
      state_dir: "~/.pi/agent/tmp/pi-auto-tools/runs/review",
      template: "review {scope}",
      values: { prompt: "Review risks." },
    },
    template: "review {scope}",
    args: ["scope"],
    defaults: {},
  };
  assert.deepEqual(Object.keys(serializeTools(new Map([[tool.name, tool]])).review as Record<string, unknown>), [
    "description",
    "name",
    "async",
    "state_dir",
    "values",
    "template",
  ]);
});

test("Serialized template recipe launchers keep template path", () => {
  const tool: RegisteredTool = {
    name: "launcher",
    description: "Start job",
    template: "shader-ring-8-parallel.json",
    args: [],
    defaults: {},
  };
  assert.deepEqual(serializeTools(new Map([[tool.name, tool]])).launcher, {
    description: "Start job",
    template: "shader-ring-8-parallel.json",
  });
});

test("Config save and load round-trip template-backed tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auto-tools-config-"));
  const path = join(dir, "auto-tools.json");
  try {
    const tool: RegisteredTool = {
      name: "transcribe",
      description: "Transcribe audio",
      template: "~/bin/transcribe {file}",
      args: ["file"],
      defaults: {},
    };
    assert.equal(saveTools(path, new Map([[tool.name, tool]])), undefined);
    assert.deepEqual(
      JSON.parse(await readFile(path, "utf8")),
      serializeTools(new Map([[tool.name, tool]])),
    );
    const loaded = loadToolConfig(path, reserved);
    assert.equal(loaded.changed, false);
    assert.deepEqual([...loaded.tools.values()], [tool]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Config load keeps last duplicate and reports warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auto-tools-config-"));
  const path = join(dir, "auto-tools.json");
  try {
    await writeFile(
      path,
      JSON.stringify([
        { name: "dup", template: "first", description: "First" },
        { name: "dup", template: "second", description: "Second" },
      ]),
    );
    const loaded = loadToolConfig(path, reserved);
    assert.equal(loaded.tools.get("dup")?.template, "second");
    assert.match(
      loaded.warnings.join("\n"),
      /Duplicate tool kept from last entry/,
    );
    assert.equal(loaded.changed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
