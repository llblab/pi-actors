import "./test-environment.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

import { EXECUTION_CHRONOLOGY, readExecutionTurns } from "../lib/execution-sessions.ts";
import { formatActorInspectorKillFeedback, killOwnedRunFromInspector, readActorInspectorRecipe, readActorInspectorRuns } from "../lib/inspector.ts";

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

test("Recipe projection scrubs known runtime origins embedded in templates, values and keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-embedded-origin-"));
  try {
    const stateDir = await writeRun(root, "owned", "owner");
    await writeFile(join(stateDir, "run.json"), JSON.stringify({ run: "owned", ownerId: "owner",
      recipe_file: "/private/source/recipes/task.json",
      values: { skill_dir: "/private/source", recipe_dir: "/private/source/recipes",
        helper: "/private/source/tools/task.mjs", "/private/source/cache": "visible", api_key: "hidden-key" },
      template: { template: "/private/source/tools/task.mjs", defaults: { nested: {
        actorRecipeContext: { file: "/private/import/recipes/child.json", logical_reference: "suite/child" },
        command: "/private/import/recipes/child.json --safe" } } },
      recipe_context_records: [{ depth: 0, name: "task", logical_reference: "suite/task",
        source_file: "/private/source/recipes/task.json", recipe: { template: "echo {helper}" } }],
    }));
    const view = readActorInspectorRecipe(stateDir);
    const serialized = JSON.stringify(view);
    assert.doesNotMatch(serialized, /\/private\/source|\/private\/import|hidden-key|"source_file"|"recipe_dir"|"skill_dir"/);
    assert.match(serialized, /PRIVATE_RECIPE_ORIGIN/);
    assert.equal(view.identity.logical_reference, "suite/task");
    assert.equal(view.launch.values && (view.launch.values as Record<string, unknown>).helper, "[PRIVATE_RECIPE_ORIGIN]/tools/task.mjs");
    assert.match(serialized, /"logical_reference":"suite\/child"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Recipe origin scrubbing preserves canonical references sharing a directory suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-origin-reference-"));
  try {
    const stateDir = await writeRun(root, "owned", "owner");
    await writeFile(join(stateDir, "run.json"), JSON.stringify({ run: "owned", ownerId: "owner",
      values: { skill_dir: "/task", helper: "/task/tools/helper.mjs" },
      recipe_context_records: [{ depth: 0, name: "task", skill: "suite", source_kind: "active_skill_component",
        logical_reference: "suite/task", recipe: { template: "echo {helper}" } }],
    }));
    const view = readActorInspectorRecipe(stateDir);
    assert.equal(view.identity.logical_reference, "suite/task");
    assert.equal(view.composition[0].logical_reference, "suite/task");
    assert.doesNotMatch(JSON.stringify(view.launch), /\/task/);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("inspector rejects session namespace and leaf aliases before reading their bodies", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-session-alias-"));
  try {
    for (const kind of ["namespace", "leaf"]) {
      const owned = await writeRun(root, "owned-" + kind, "owner");
      const foreign = await writeRun(root, "foreign-" + kind, "other");
      const session = [JSON.stringify({ type: "session", version: 3, id: "private" }),
        JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "PRIVATE_ALIAS_BODY" } })].join("\n");
      const sessions = join(owned, "sessions"); const reference = "sessions/secret/session.jsonl";
      if (kind === "namespace") {
        await mkdir(join(foreign, "sessions", "secret"), { recursive: true });
        await writeFile(join(foreign, reference), session);
        fs.symlinkSync(join(foreign, "sessions"), sessions, "dir");
      } else {
        await mkdir(join(sessions, "secret"), { recursive: true });
        const target = join(sessions, "private.data"); await writeFile(target, session);
        fs.symlinkSync(target, join(owned, reference));
      }
      await writeFile(join(owned, "execution.json"), JSON.stringify({ commands: [{ id: "secret", session_files: [reference] }] }));
      const scan = fs.readdirSync; let namespaceScans = 0;
      fs.readdirSync = ((path, ...args) => { if (String(path) === sessions) namespaceScans++; return Reflect.apply(scan, fs, [path, ...args]); }) as typeof fs.readdirSync;
      syncBuiltinESMExports();
      let turns;
      try { turns = readExecutionTurns(owned); }
      finally { fs.readdirSync = scan; syncBuiltinESMExports(); }
      const frame = turns[EXECUTION_CHRONOLOGY];
      assert.deepEqual(turns, [], kind + " alias must not authorize session bodies");
      assert.equal(frame?.state, "unavailable", "Alias DTOs grant no metadata coverage");
      if (kind === "namespace") assert.equal(namespaceScans, 0, "Known namespace alias must not be scanned");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspector drops a session body when its observed file is replaced after reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-session-replaced-"));
  try {
    const owned = await writeRun(root, "owned", "owner"); const relative = "sessions/command-001/session.jsonl";
    const file = join(owned, relative); await mkdir(join(file, ".."), { recursive: true });
    const content = (text: string) => [JSON.stringify({ type: "session", version: 3, id: "session" }),
      JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: text } })].join("\n");
    await writeFile(file, content("ORIGINAL_BODY"));
    await writeFile(join(owned, "execution.json"), JSON.stringify({ commands: [{ id: "command-001", session_files: [relative] }] }));
    const open = fs.openSync; const close = fs.closeSync; const sourceFds = new Set<number>(); let closes = 0; let changed = false;
    fs.openSync = ((path, ...args) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (String(path) === fs.realpathSync(file)) sourceFds.add(fd); return fd; }) as typeof fs.openSync;
    fs.closeSync = ((fd) => { const source = sourceFds.delete(fd); const result = close(fd); if (source && ++closes === 2) { changed = true; fs.renameSync(file, file + ".old"); fs.writeFileSync(file, content("REPLACED_BODY")); } return result; }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    try {
      const rejected = readExecutionTurns(owned);
      const frame = rejected[EXECUTION_CHRONOLOGY];
      assert.deepEqual(rejected, []); assert.equal(changed, true);
      assert.equal(frame?.state, "unavailable");
      if (frame?.state === "unavailable") assert.equal(frame.reason, "source_changed");
    }
    finally { fs.openSync = open; fs.closeSync = close; syncBuiltinESMExports(); }
    const fresh = readExecutionTurns(owned);
    assert.equal(fresh[0]?.userText, "REPLACED_BODY");
  } finally { await rm(root, { recursive: true, force: true }); }
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

describe("Owned Run actions", { concurrency: false }, () => {
const INSTANCE_A = "instance-a";

function kill(
  deps: Parameters<typeof killOwnedRunFromInspector>[4],
  expectedRunInstanceId = INSTANCE_A,
) {
  return killOwnedRunFromInspector(
    "session-a",
    "demo",
    "/runs",
    expectedRunInstanceId,
    deps,
  );
}

test("Inspector kill routes exact owner and generation through canonical control", () => {
  const calls: string[] = [];
  const result = kill({
    getRunStatus: (stateDir) => {
      calls.push(`status:${stateDir}`);
      return {
        ownerId: "session-a",
        run_instance_id: INSTANCE_A,
        status: "running",
      };
    },
    killRun: (stateDir, expected) => {
      calls.push(`kill:${stateDir}:${expected.ownerId}:${expected.runInstanceId}`);
      return { killed: true };
    },
  });
  assert.deepEqual(result, { ok: true, message: "Killed run:demo." });
  assert.deepEqual(calls, [
    `status:${join("/runs", "demo")}`,
    `kill:${join("/runs", "demo")}:session-a:${INSTANCE_A}`,
  ]);
});

test("Inspector kill rejects ownership changes before control", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-b",
      run_instance_id: "instance-b",
      status: "running",
    }),
    killRun: () => assert.fail("unowned run must not be controlled"),
  });
  assert.deepEqual(result, {
    ok: false,
    message: "- action: kill\n- result: rejected\n- diagnostic: run ownership changed.\n- closure: unconfirmed",
  });
});

test("Inspector kill rejects a race to terminal", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: INSTANCE_A,
      status: "done",
    }),
    killRun: () => assert.fail("terminal run must not be controlled"),
  });
  assert.deepEqual(result, {
    ok: false,
    message: "- action: kill\n- result: unavailable\n- state: done\n- preview_basis: selected legacy preview; upstream completeness/privacy unproven\n- closure: unconfirmed",
  });
});

test("Inspector kill rejects same-owner replacement during confirmation", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: "instance-b",
      status: "running",
    }),
    killRun: () => assert.fail("replacement generation must not be controlled"),
  });
  assert.deepEqual(result, {
    ok: false,
    message: "- action: kill\n- result: rejected\n- diagnostic: run generation changed.\n- closure: unconfirmed",
  });
});

test("Inspector kill passes generation fencing to canonical control", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: INSTANCE_A,
      status: "running",
    }),
    killRun: (_stateDir, expected) => {
      assert.deepEqual(expected, {
        ownerId: "session-a",
        runInstanceId: INSTANCE_A,
      });
      return { killed: false, reason: "run generation changed" };
    },
  });
  assert.deepEqual(result, {
    ok: false,
    message: "- action: kill\n- result: failed\n- diagnostic: run generation changed\n- preview_basis: selected legacy preview; upstream completeness/privacy unproven\n- closure: unconfirmed\n- safety: Do not repeat automatically.",
  });
});


test("AX Inspector Kill feedback preserves compiler refusals and selected 180-unit legacy preview boundaries", () => {
  const status = { ownerId: "session-a", run_instance_id: INSTANCE_A, status: "running" };
  const opaque = "## Already selected\r\n\r\n- list\n  next: content · kept";
  assert.ok(formatActorInspectorKillFeedback("failed", opaque, { clipped: false }).includes("- diagnostic:\n  " + opaque.replaceAll(/\r\n|\r|\n/gu, newline => newline + "  ")));
  const cases = [
    ["## Heading\r\n\r\n- line\nnext: text · kept", "## Heading - line next: text · kept", false],
    ["a".repeat(180), "a".repeat(180), false],
    ["a".repeat(181), "a".repeat(179) + "…", true],
    ["a".repeat(178) + "😀tail", "a".repeat(178) + "…", true],
    ["a".repeat(177) + "😀tail", "a".repeat(177) + "😀…", true],
  ] as const;
  for (const [raw, selected, clipped] of cases) {
    let sent = 0;
    const outcome = kill({ getRunStatus: () => status, killRun: () => { sent += 1; return { killed: false, reason: raw }; } });
    assert.equal(outcome.ok, false); assert.equal(sent, 1);
    assert.ok(outcome.message.startsWith("- action: kill\n- result: failed\n- diagnostic: " + selected + "\n"));
    assert.equal(outcome.message.includes("- diagnostic_omission: [omitted: unknown]"), clipped);
    assert.ok(outcome.message.includes("- preview_basis: selected legacy preview; upstream completeness/privacy unproven"));
    assert.ok(outcome.message.endsWith("- closure: unconfirmed\n- safety: Do not repeat automatically."));
    assert.equal(Buffer.from(outcome.message).toString("utf8"), outcome.message);
    assert.doesNotMatch(outcome.message, /omitted: \d+ chars/);
  }
  const a = kill({ getRunStatus: () => status, killRun: () => ({ killed: false, reason: "x".repeat(181) + "tail".repeat(4) }) });
  const b = kill({ getRunStatus: () => status, killRun: () => ({ killed: false, reason: "x".repeat(181) + "tail".repeat(4000) }) });
  assert.equal(a.message, b.message);
  const malformed = kill({ getRunStatus: () => status, killRun: () => ({ killed: false, reason: "bad\ud800text" }) });
  assert.match(malformed.message, /- diagnostic: unavailable\n- diagnostic_reason: malformed_legacy_preview\n- diagnostic_omission: \[omitted: unknown\]/);
  assert.doesNotMatch(malformed.message, /…|bad/);
  let reads = 0;
  const rejected = killOwnedRunFromInspector("session-a", "../bad", "/runs", INSTANCE_A, {
    getRunStatus: () => { reads += 1; return status; }, killRun: () => assert.fail("invalid run"),
  });
  assert.equal(reads, 0); assert.equal(rejected.ok, false);
  assert.match(rejected.message, /^- action: kill\n- result: rejected\n/);
});

test("Inspector Kill AX formatting preserves ordered observations thrown values and partial callback effects", () => {
  const events: string[] = [];
  let messageReads = 0;
  const cause = new Error("cause retained");
  const original = Object.defineProperty(new Error("primary", { cause }), "message", { get() { messageReads += 1; return "Primary\r\n\n diagnostic"; } });
  const outcome = kill({
    getRunStatus: () => { events.push("status"); return { ownerId: "session-a", run_instance_id: INSTANCE_A, status: "running" }; },
    killRun: () => { events.push("effect"); return {
      get killed() { events.push("killed"); return false; },
      get reason() { events.push("reason"); return { toString() { events.push("coerce"); throw original; } }; },
    }; },
  });
  assert.deepEqual(events, ["status", "effect", "killed", "reason", "coerce"]);
  assert.equal(messageReads, 1); assert.equal(original.cause, cause);
  assert.match(outcome.message, /- result: failed\n- diagnostic: Primary diagnostic/);
  const token = Symbol("exact secondary");
  let observed = 0;
  const unprintable = Object.defineProperty(new Error(), "message", { get() { observed += 1; throw token; } });
  assert.throws(() => kill({ getRunStatus: () => { throw unprintable; }, killRun: () => assert.fail("not called") }), error => error === token);
  assert.equal(observed, 1);
  const value = { toString() { throw token; } };
  const malformed = Object.defineProperty(new Error(), "message", { value });
  assert.throws(() => kill({ getRunStatus: () => { throw malformed; }, killRun: () => assert.fail("not called") }), error => error === token);
  let statusReads = 0;
  const unavailable = kill({
    getRunStatus: () => ({ ownerId: "session-a", get status() { statusReads += 1; return "done"; }, get run_instance_id() { return assert.fail("no generation after terminal"); } }),
    killRun: () => assert.fail("terminal"),
  });
  assert.equal(statusReads, 2); assert.equal(unavailable.ok, false);
  assert.match(unavailable.message, /- result: unavailable\n- state: done/);
});

test("Inspector kill bounds canonical control failures", () => {
  const result = kill({
    getRunStatus: () => ({
      ownerId: "session-a",
      run_instance_id: INSTANCE_A,
      status: "running",
    }),
    killRun: () => ({ killed: false, reason: `owner mismatch ${"x".repeat(400)}` }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /^- action: kill\n- result: failed\n- diagnostic: owner mismatch/);
  const preview = /^- diagnostic: (.*)$/mu.exec(result.message)![1];
  assert.equal(preview.length <= 180, true, "The legacy 195-character envelope bound included only the old prefix; AX overhead does not enlarge its180-unit preview");
  assert.match(preview, /…$/u);
  assert.match(result.message, /- diagnostic_omission: \[omitted: unknown\]/);
});

});
