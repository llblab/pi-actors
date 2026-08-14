import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readExecutionTurns } from "../lib/execution-sessions.ts";
import { readActorInspectorRecipe, readActorInspectorRuns } from "../lib/inspector.ts";

async function writeRun(
  root: string,
  run: string,
  ownerId: string,
): Promise<string> {
  const stateDir = join(root, run);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({ ownerId, run }),
  );
  await writeFile(
    join(stateDir, "progress.json"),
    JSON.stringify({ phase: "done" }),
  );
  return stateDir;
}

test("inspector rejects stale cross-session run selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-owner-"));
  try {
    await writeRun(root, "foreign", "old-owner");
    await writeRun(root, "owned", "new-owner");
    const runs = readActorInspectorRuns(root, "new-owner");
    assert.deepEqual(runs.map((item) => item.run), ["owned"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspector hides runtime-owned Recipe origins from model-facing launch values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-origin-"));
  try {
    const stateDir = await writeRun(root, "owned", "owner");
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({
        ownerId: "owner",
        launch_source: "spawn",
        recipe_context_records: [{
          depth: 0,
          import_path: [],
          logical_reference: "sample/task",
          name: "task",
          recipe: {
            defaults: { helper: "{skill_dir}/scripts/private.mjs" },
            template: "{skill_dir}/scripts/private.mjs",
          },
          role: "entry",
          skill: "sample",
          source_file: "/private/skill/recipes/task.json",
          source_kind: "active_skill_component",
        }],
        recipe_file: "/private/skill/recipes/task.json",
        run: "owned",
        values: {
          recipe_dir: "/private/skill/recipes",
          skill_dir: "/private/skill",
          visible: "ok",
        },
      }),
    );
    const view = readActorInspectorRecipe(stateDir);
    assert.deepEqual(view.launch.values, { visible: "ok" });
    assert.deepEqual(view.identity, {
      run: "owned",
      recipe_stem: "task",
      logical_reference: "sample/task",
      skill: "sample",
      source_kind: "active_skill_component",
      launch_kind: "spawn",
      launch_source: "spawn",
    });
    assert.equal(view.composition[0].logical_reference, "sample/task");
    assert.equal(view.composition[0].skill, "sample");
    assert.doesNotMatch(JSON.stringify(view), /\/private\/skill|"source_file"|"recipe_dir"|"skill_dir"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspector labels user registry capability provenance without exposing its file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-user-recipe-"));
  try {
    const stateDir = await writeRun(root, "owned", "owner");
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({
        ownerId: "owner",
        launch_source: "tool",
        recipe: "transcribe",
        recipe_context_records: [{
          depth: 0,
          import_path: [],
          logical_reference: "transcribe",
          name: "transcribe",
          recipe: { template: "echo user" },
          role: "entry",
          source_file: "/private/agent/recipes/transcribe.json",
          source_kind: "user_registry_capability",
        }],
        run: "owned",
      }),
    );
    const view = readActorInspectorRecipe(stateDir);
    assert.equal(view.identity.source_kind, "user_registry_capability");
    assert.equal(view.identity.logical_reference, "transcribe");
    assert.equal(view.composition[0].source_kind, "user_registry_capability");
    assert.doesNotMatch(JSON.stringify(view), /\/private\/agent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspector contains manifest session paths beneath owned run sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-path-"));
  try {
    const owned = await writeRun(root, "owned", "owner");
    const foreign = await writeRun(root, "foreign", "other");
    const foreignSession = join(foreign, "sessions", "secret", "session.jsonl");
    await mkdir(join(foreign, "sessions", "secret"), { recursive: true });
    await writeFile(
      foreignSession,
      [
        JSON.stringify({ type: "session", version: 3, id: "secret" }),
        JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "FOREIGN_SECRET" } }),
      ].join("\n"),
    );
    await writeFile(
      join(owned, "execution.json"),
      JSON.stringify({
        commands: [
          {
            id: "escape",
            session_files: ["../foreign/sessions/secret/session.jsonl"],
          },
        ],
      }),
    );
    const output = JSON.stringify(readExecutionTurns(owned));
    assert.equal(output, "[]");
    assert.doesNotMatch(output, /FOREIGN_SECRET/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
