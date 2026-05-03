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
  const result = normalizeStoredTool("Transcribe", {
    template: "~/bin/transcribe {file} {lang}",
    args: ["file", "lang=ru"],
    description: "Transcribe audio",
  }, reserved);
  assert.equal(result.warning, undefined);
  assert.equal(result.changed, true);
  assert.deepEqual(result.cfg, {
    name: "transcribe",
    label: "transcribe",
    description: "Transcribe audio",
    template: "~/bin/transcribe {file} {lang}",
    args: ["file", "lang"],
    defaults: { lang: "ru" },
  });
});

test("Stored tool normalization rejects legacy script entries", () => {
  const result = normalizeStoredTool("old", { script: "~/bin/old" }, reserved);
  assert.equal(result.cfg, undefined);
  assert.equal(result.changed, false);
  assert.match(result.warning ?? "", /legacy script config/);
});

test("Config save and load round-trip template-backed tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auto-tools-config-"));
  const path = join(dir, "auto-tools.json");
  try {
    const tool: RegisteredTool = {
      name: "transcribe",
      label: "Transcribe",
      description: "Transcribe audio",
      template: "~/bin/transcribe {file}",
      args: ["file"],
      defaults: {},
    };
    assert.equal(saveTools(path, new Map([[tool.name, tool]])), undefined);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), serializeTools(new Map([[tool.name, tool]])));
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
    await writeFile(path, JSON.stringify([
      { name: "dup", template: "first", description: "First" },
      { name: "dup", template: "second", description: "Second" },
    ]));
    const loaded = loadToolConfig(path, reserved);
    assert.equal(loaded.tools.get("dup")?.template, "second");
    assert.match(loaded.warnings.join("\n"), /Duplicate tool kept from last entry/);
    assert.equal(loaded.changed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
