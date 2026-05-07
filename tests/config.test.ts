/**
 * Config registry regression tests
 * Covers stored tool normalization, legacy script rejection, duplicate handling, and atomic save/load
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("Stored tool normalization accepts job-backed tools", () => {
  const result = normalizeStoredTool(
    "shader_launcher",
    {
      args: ["theme", "out_dir=latest"],
      description: "Start shader job",
      job: "shader-ring-8-parallel",
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
    job: "shader-ring-8-parallel",
    storedArgs: ["theme", "out_dir"],
    storedDefaults: { out_dir: "latest" },
  });
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

test("Stored tool normalization rejects template plus job", () => {
  const result = normalizeStoredTool(
    "mixed",
    { template: "echo hi", job: "job", description: "Mixed" },
    reserved,
  );
  assert.equal(result.cfg, undefined);
  assert.match(result.warning ?? "", /cannot define both template and job/);
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

test("Serialized job-backed tool entries keep job without template", () => {
  const tool: RegisteredTool = {
    name: "launcher",
    description: "Start job",
    job: "shader-ring-8-parallel",
    args: [],
    defaults: {},
  };
  assert.deepEqual(serializeTools(new Map([[tool.name, tool]])).launcher, {
    description: "Start job",
    job: "shader-ring-8-parallel",
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
